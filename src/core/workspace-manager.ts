import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import {
  getWorkspaceOverride,
  listWorkspaceOverrides,
} from '../state/store.js';
import { isBotAdmin, isBotAdminAny } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const log = createLogger('workspace');

export const WORKSPACES_DIR = path.join(os.homedir(), '.copilot-bridge', 'workspaces');
export const CONFIG_HOME = path.join(os.homedir(), '.copilot-bridge');
const USER_TEMPLATES_DIR = path.join(os.homedir(), '.copilot-bridge', 'templates');

export function ensureWorkspacesDir(): void {
  if (!fs.existsSync(WORKSPACES_DIR)) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  }
  // Copy distributable templates to ~/.copilot-bridge/templates/ for admin reference
  if (fs.existsSync(TEMPLATES_DIR)) {
    if (!fs.existsSync(USER_TEMPLATES_DIR)) {
      fs.mkdirSync(USER_TEMPLATES_DIR, { recursive: true });
    }
    for (const file of fs.readdirSync(TEMPLATES_DIR)) {
      const src = path.join(TEMPLATES_DIR, file);
      const dest = path.join(USER_TEMPLATES_DIR, file);
      if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

/** Validate bot name to prevent path traversal. */
function validateBotName(name: string): void {
  if (!name || name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Invalid bot name: ${name}`);
  }
}

export function getWorkspacePath(botName: string): string {
  validateBotName(botName);
  const override = getWorkspaceOverride(botName);
  if (override) {
    return override.workingDirectory;
  }
  return path.join(WORKSPACES_DIR, botName);
}

export function getWorkspaceAllowPaths(botName: string, platformName?: string): string[] {
  const override = getWorkspaceOverride(botName);
  let paths = override?.allowPaths ?? [];

  // Admin bots automatically get access to the workspaces directory and config home
  const isAdmin = platformName ? isBotAdmin(platformName, botName) : isBotAdminAny(botName);
  if (isAdmin) {
    if (!paths.includes(WORKSPACES_DIR)) paths = [...paths, WORKSPACES_DIR];
    if (!paths.includes(CONFIG_HOME)) paths = [...paths, CONFIG_HOME];
    return paths;
  }

  return paths;
}

export function initWorkspace(botName: string): string {
  const workspacePath = getWorkspacePath(botName);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  const agentsFile = path.join(workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentsFile)) {
    const allowPaths = getWorkspaceAllowPaths(botName);
    const admin = isBotAdminAny(botName);
    fs.writeFileSync(agentsFile, generateAgentsTemplate(botName, workspacePath, allowPaths, admin), 'utf-8');
  }

  log.info(`Initialized workspace for "${botName}" at ${workspacePath}`);
  return workspacePath;
}

export function listWorkspaces(): Array<{ botName: string; path: string; isOverride: boolean; allowPaths: string[] }> {
  const results = new Map<string, { botName: string; path: string; isOverride: boolean; allowPaths: string[] }>();

  // Scan filesystem
  if (fs.existsSync(WORKSPACES_DIR)) {
    for (const entry of fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        results.set(entry.name, {
          botName: entry.name,
          path: path.join(WORKSPACES_DIR, entry.name),
          isOverride: false,
          allowPaths: [],
        });
      }
    }
  }

  // Merge SQLite overrides
  for (const override of listWorkspaceOverrides()) {
    results.set(override.botName, {
      botName: override.botName,
      path: override.workingDirectory,
      isOverride: true,
      allowPaths: override.allowPaths,
    });
  }

  return Array.from(results.values());
}

export type WorkspaceEvent = { type: 'created' | 'removed'; botName: string; path: string };
type WorkspaceEventHandler = (event: WorkspaceEvent) => void;

export class WorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private handlers: WorkspaceEventHandler[] = [];
  private knownDirs: Set<string>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private log = createLogger('workspace-watcher');

  constructor() {
    this.knownDirs = this.scanDirs();
  }

  /** Start watching the workspaces directory. */
  start(): void {
    ensureWorkspacesDir();
    if (this.watcher) return;

    this.log.info(`Watching ${WORKSPACES_DIR} for workspace changes`);
    this.watcher = fs.watch(WORKSPACES_DIR, { persistent: false }, () => {
      // Debounce — filesystem events fire multiple times
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.checkForChanges(), 500);
    });

    this.watcher.on('error', (err) => {
      this.log.error('Watcher error:', err);
    });
  }

  /** Stop watching. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Register an event handler. */
  onEvent(handler: WorkspaceEventHandler): void {
    this.handlers.push(handler);
  }

  private scanDirs(): Set<string> {
    const dirs = new Set<string>();
    if (!fs.existsSync(WORKSPACES_DIR)) return dirs;
    try {
      for (const entry of fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.add(entry.name);
        }
      }
    } catch { /* permission errors */ }
    return dirs;
  }

  private checkForChanges(): void {
    const currentDirs = this.scanDirs();

    // Detect new directories
    for (const dir of currentDirs) {
      if (!this.knownDirs.has(dir)) {
        this.log.info(`New workspace detected: ${dir}`);
        const wsPath = path.join(WORKSPACES_DIR, dir);
        this.emit({ type: 'created', botName: dir, path: wsPath });
      }
    }

    // Detect removed directories
    for (const dir of this.knownDirs) {
      if (!currentDirs.has(dir)) {
        this.log.info(`Workspace removed: ${dir}`);
        const wsPath = path.join(WORKSPACES_DIR, dir);
        this.emit({ type: 'removed', botName: dir, path: wsPath });
      }
    }

    this.knownDirs = currentDirs;
  }

  private emit(event: WorkspaceEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.log.error('Event handler error:', err);
      }
    }
  }
}

export function generateAgentsTemplate(
  botName: string,
  workspacePath: string,
  allowPaths: string[],
  isAdmin = false,
  agentPurpose = '',
  adminBotName: string | null = null,
): string {
  const templateFile = isAdmin ? 'AGENTS.admin.md' : 'AGENTS.md';
  const templatePath = path.join(TEMPLATES_DIR, templateFile);

  if (!fs.existsSync(templatePath)) {
    log.warn(`Template not found: ${templatePath}, using inline fallback`);
    return `# ${botName} — Agent Workspace\n\nWorking directory: \`${workspacePath}\`\n`;
  }

  let content = fs.readFileSync(templatePath, 'utf-8');

  // Interpolate variables
  content = content.replaceAll('{{workspacePath}}', workspacePath);
  content = content.replaceAll('{{workspacesDir}}', WORKSPACES_DIR);
  content = content.replaceAll('{{botName}}', botName);
  content = content.replaceAll('{{adminBotName}}', adminBotName ?? 'the admin bot');

  // Conditional sections
  const conditionals: Record<string, string> = {
    allowPaths: allowPaths.length > 0 ? allowPaths.map(p => `- \`${p}\``).join('\n') : '',
    agentPurpose,
  };

  for (const [key, value] of Object.entries(conditionals)) {
    const sectionRe = new RegExp(`\\{\\{#${key}\\}\\}[\\s\\S]*?\\{\\{/${key}\\}\\}`, 'g');
    if (value) {
      content = content.replaceAll(`{{${key}}}`, value);
      content = content.replace(new RegExp(`\\{\\{#${key}\\}\\}`, 'g'), '');
      content = content.replace(new RegExp(`\\{\\{/${key}\\}\\}`, 'g'), '');
    } else {
      content = content.replace(sectionRe, '');
    }
  }

  return content;
}
