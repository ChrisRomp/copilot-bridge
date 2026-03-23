import { CopilotSession, approveAll } from '@github/copilot-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotBridge } from './bridge.js';
import {
  getChannelSession, setChannelSession, clearChannelSession,
  getChannelPrefs, setChannelPrefs, checkPermission, addPermissionRule,
  getWorkspaceOverride, setWorkspaceOverride, listWorkspaceOverrides,
  recordAgentCall,
  type ChannelPrefs,
} from '../state/store.js';
import { getChannelConfig, getChannelBotName, getChannelBotConfig, evaluateConfigPermissions, isBotAdmin, getConfig, getInterAgentConfig, isHardDeny, resolveProviderConfig } from '../config.js';
import { getWorkspacePath, getWorkspaceAllowPaths, ensureWorkspacesDir } from './workspace-manager.js';
import { onboardProject } from './onboarding.js';
import { addJob, removeJob, pauseJob, resumeJob, listJobs, formatInTimezone } from './scheduler.js';
import {
  canCall, createContext, extendContext,
  getBotWorkspaceMap, buildWorkspacePrompt, buildCallerPrompt,
  discoverAgentDefinitions, resolveAgentDefinition,
  type InterAgentContext,
} from './inter-agent.js';
import { createLogger } from '../logger.js';
import { tryWithFallback, isModelError, buildFallbackChain } from './model-fallback.js';
import type { McpServerInfo } from './command-handler.js';
import { loadHooks, getHooksInfo, type SessionHooks, type HookInfo } from './hooks-loader.js';
import { getBridgeDocs } from './bridge-docs.js';
import type {
  ChannelAdapter, InboundMessage, PendingPermission, PendingUserInput, PendingPlanExit,
} from '../types.js';

const log = createLogger('session');

/** Custom tools auto-approved without interactive prompt (read-only or enforce workspace boundaries internally). */
export const BRIDGE_CUSTOM_TOOLS = ['send_file', 'show_file_in_chat', 'ask_agent', 'schedule', 'fetch_copilot_bridge_documentation'];

type SessionEventHandler = (sessionId: string, channelId: string, event: any) => void;

/** Simple mutex for serializing env-sensitive session creation. */
let envLock: Promise<void> = Promise.resolve();

/**
 * Parse a .env file into a key-value map.
 * Handles KEY=VALUE, KEY="VALUE", KEY='VALUE', comments, and blank lines.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip matching quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

/**
 * Run an async function with workspace env vars temporarily injected into process.env.
 * Uses a mutex to prevent concurrent sessions from seeing each other's env vars.
 */
async function withWorkspaceEnv<T>(workingDirectory: string, fn: () => Promise<T>): Promise<T> {
  const envPath = path.join(workingDirectory, '.env');
  const vars = parseEnvFile(envPath);

  // Always hold the lock for the full duration of fn() so we never run
  // while another workspace's secrets are injected into process.env.
  const prev = envLock;
  let release: () => void;
  envLock = new Promise(resolve => { release = resolve; });

  await prev;

  if (Object.keys(vars).length === 0) {
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  // Save originals, inject workspace vars
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    // Restore originals
    for (const [key] of Object.entries(vars)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    release!();
  }
}

/**
 * Load MCP server configs from ~/.copilot/mcp-config.json and installed plugins.
 * Merges them into a single Record, with user config taking precedence over plugins.
 */
function loadMcpServers(): Record<string, any> {
  const home = process.env.HOME;
  if (!home) return {};

  const servers: Record<string, any> = {};

  // 1. Load from installed plugins (.mcp.json files)
  const pluginsDir = path.join(home, '.copilot', 'installed-plugins');
  if (fs.existsSync(pluginsDir)) {
    const walk = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Check for .mcp.json in this directory
            const mcpFile = path.join(full, '.mcp.json');
            if (fs.existsSync(mcpFile)) {
              try {
                const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
                if (cfg.mcpServers) {
                  for (const [name, config] of Object.entries(cfg.mcpServers)) {
                    if (!servers[name]) {
                      servers[name] = config;
                      log.debug(`Loaded MCP "${name}" from plugin ${path.relative(pluginsDir, full)}`);
                    }
                  }
                }
              } catch (err) {
                log.warn(`Failed to parse ${mcpFile}: ${err}`);
              }
            }
            walk(full);
          }
        }
      } catch { /* permission errors etc */ }
    };
    walk(pluginsDir);
  }

  // 2. Load from user mcp-config.json (overrides plugins)
  const userConfig = path.join(home, '.copilot', 'mcp-config.json');
  if (fs.existsSync(userConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(userConfig, 'utf8'));
      if (cfg.mcpServers) {
        for (const [name, config] of Object.entries(cfg.mcpServers)) {
          servers[name] = config;
          log.debug(`Loaded MCP "${name}" from mcp-config.json`);
        }
      }
    } catch (err) {
      log.warn(`Failed to parse ${userConfig}: ${err}`);
    }
  }

  normalizeMcpServers(servers);

  const count = Object.keys(servers).length;
  if (count > 0) {
    log.info(`Loaded ${count} MCP server(s): ${Object.keys(servers).join(', ')}`);
  }

  return servers;
}

/** Ensure all MCP server entries have a tools field (SDK requires it). */
function normalizeMcpServers(servers: Record<string, any>): void {
  for (const config of Object.values(servers)) {
    if (!config.tools) {
      config.tools = ['*'];
    }
  }
}

/**
 * Load workspace-specific MCP servers from <workspacePath>/mcp-config.json.
 * Injects workspace .env vars into each local server's env field so the CLI
 * subprocess passes them through to MCP server processes (the CLI subprocess
 * is long-lived and does not inherit bridge process.env changes).
 * Also expands ${VAR} references in env values from .env or process.env.
 */
function loadWorkspaceMcpServers(workspacePath: string): { servers: Record<string, any>; env: Record<string, string> } {
  const workspaceEnv = parseEnvFile(path.join(workspacePath, '.env'));
  const configFile = path.join(workspacePath, 'mcp-config.json');
  if (!fs.existsSync(configFile)) return { servers: {}, env: workspaceEnv };

  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') return { servers: {}, env: workspaceEnv };

    const servers: Record<string, any> = {};
    for (const [name, config] of Object.entries(cfg.mcpServers)) {
      const serverConfig = config as any;

      // Expand ${VAR} references in config-defined env values BEFORE merging .env
      // (only config-authored keys get expansion; .env values are always literal)
      const configEnv = serverConfig.env ? { ...serverConfig.env } : {};
      for (const [key, value] of Object.entries(configEnv)) {
        if (typeof value === 'string' && value.includes('${')) {
          configEnv[key] = (value as string).replace(/\$\{(\w+)\}/g, (_, varName) =>
            workspaceEnv[varName] ?? process.env[varName] ?? '',
          );
        }
      }

      // Inject workspace .env vars into local MCP servers
      const isLocal = !serverConfig.type || serverConfig.type === 'local' || serverConfig.type === 'stdio';
      if (isLocal && Object.keys(workspaceEnv).length > 0) {
        // Workspace .env as base, expanded config env overrides
        serverConfig.env = { ...workspaceEnv, ...configEnv };
      } else {
        serverConfig.env = configEnv;
      }

      servers[name] = serverConfig;
      log.debug(`Loaded workspace MCP "${name}" from ${configFile}`);
    }
    normalizeMcpServers(servers);
    return { servers, env: workspaceEnv };
  } catch (err) {
    log.warn(`Failed to parse workspace MCP config ${configFile}: ${err}`);
    return { servers: {}, env: workspaceEnv };
  }
}

/**
 * Merge global and workspace MCP server configs, injecting cwd and env into local servers.
 * Exported for testing — used internally by SessionManager.resolveMcpServers().
 */
export function mergeMcpServers(
  globalServers: Record<string, any>,
  workspaceServers: Record<string, any>,
  workspaceEnv: Record<string, string>,
  workingDirectory: string,
): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const [name, config] of Object.entries(globalServers)) {
    const serverConfig = { ...(config as any) };
    const isLocal = !serverConfig.type || serverConfig.type === 'local' || serverConfig.type === 'stdio';
    if (isLocal) {
      if (!serverConfig.cwd) {
        serverConfig.cwd = workingDirectory;
      }
      if (Object.keys(workspaceEnv).length > 0) {
        serverConfig.env = { ...workspaceEnv, ...(serverConfig.env || {}) };
      }
    }
    merged[name] = serverConfig;
  }

  for (const [name, config] of Object.entries(workspaceServers)) {
    const serverConfig = { ...(config as any) };
    const isLocal = !serverConfig.type || serverConfig.type === 'local' || serverConfig.type === 'stdio';
    if (isLocal && !serverConfig.cwd) {
      serverConfig.cwd = workingDirectory;
    }
    merged[name] = serverConfig;
  }

  return merged;
}

/**
 * Extract individual command names from a shell command string.
 * Handles chained commands: "ls -la && grep -r foo . | head" → ["ls", "grep", "head"]
 */
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'env', 'sudo', 'nohup', 'xargs', 'exec', 'eval']);

export function extractCommandPatterns(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const cmd = obj.fullCommandText || obj.command || obj.description || obj.path;
  if (typeof cmd !== 'string') return [];
  const segments = cmd.split(/\s*(?:&&|\|\||[|;])\s*/);
  const names = segments
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Discover skill directories following Copilot CLI conventions:
 * - ~/.copilot/skills/ (user-level)
 * - ~/.agents/skills/ (user-level)
 * - <workspace>/.github/skills/ (project-level)
 * - <workspace>/.agents/skills/ (project-level)
 * - Plugin skills from ~/.copilot/installed-plugins/ (lowest priority)
 *
 * Per CLI spec, skills use first-found-wins dedup by name.
 * Plugin skills are appended last so user/workspace skills take precedence.
 */
function discoverSkillDirectories(workingDirectory: string): string[] {
  const home = process.env.HOME;
  const roots: string[] = [];

  // User-level skills
  if (home) {
    roots.push(path.join(home, '.copilot', 'skills'));
    roots.push(path.join(home, '.agents', 'skills'));
  }
  // Project-level skills (standard)
  roots.push(path.join(workingDirectory, '.github', 'skills'));
  // Project-level skills (legacy)
  roots.push(path.join(workingDirectory, '.agents', 'skills'));

  // Plugin skills (lowest priority — appended last so earlier sources win)
  if (home) {
    const pluginsDir = path.join(home, '.copilot', 'installed-plugins');
    if (fs.existsSync(pluginsDir)) {
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === 'skills') {
              roots.push(full);
            } else {
              walk(full, depth + 1);
            }
          }
        } catch { /* permission errors etc */ }
      };
      walk(pluginsDir, 0);
    }
  }

  const dirs: string[] = [];
  for (const skillsRoot of roots) {
    if (!fs.existsSync(skillsRoot)) continue;
    try {
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(path.join(skillsRoot, entry.name));
        }
      }
    } catch { /* permission errors etc */ }
  }

  if (dirs.length > 0) {
    log.info(`Discovered ${dirs.length} skill(s): ${dirs.map(d => path.basename(d)).join(', ')}`);
  }
  return dirs;
}

/** Extract a succinct summary from plan content (first heading + first body line, ~150 chars max). */
export function extractPlanSummary(content: string): string {
  if (!content?.trim()) return '(empty plan)';

  const lines = content.split('\n');
  let heading = '';
  let body = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!heading && trimmed.startsWith('#')) {
      heading = trimmed.replace(/^#+\s*/, '');
      continue;
    }

    if (!trimmed.startsWith('#') && !body) {
      body = trimmed;
      break;
    }
  }

  if (heading && body) {
    const full = `${heading}: ${body}`;
    return full.length > 150 ? full.slice(0, 147) + '...' : full;
  }
  if (heading) return heading.length > 150 ? heading.slice(0, 147) + '...' : heading;
  if (body) return body.length > 150 ? body.slice(0, 147) + '...' : body;
  return '(empty plan)';
}

export class SessionManager {
  private bridge: CopilotBridge;
  private channelSessions = new Map<string, string>(); // channelId → sessionId
  private sessionChannels = new Map<string, string>(); // sessionId → channelId (reverse)
  private sessionUnsubscribes = new Map<string, () => void>(); // sessionId → unsubscribe fn
  private eventHandler: SessionEventHandler | null = null;
  private mcpServers: Record<string, any>; // global (plugin + user) MCP servers

  // Pending permission requests (queue per channel to avoid overwrites)
  private pendingPermissions = new Map<string, PendingPermission[]>();
  // Pending user input requests (queue per channel to avoid overwrites)
  private pendingUserInput = new Map<string, PendingUserInput[]>();
  // Cached context usage from session.usage_info events
  private contextUsage = new Map<string, { currentTokens: number; tokenLimit: number }>();
  // Cached max_context_window_tokens from listModels() (separate from usage_info to avoid ordering issues)
  private contextWindowTokens = new Map<string, number>();
  private lastMessageUserIds = new Map<string, string>(); // channelId → userId of last message sender
  // MCP server names that were passed to the session at creation/resume time
  private sessionMcpServers = new Map<string, Set<string>>(); // channelId → server names
  // Skill directories that were passed to the session at creation/resume time
  private sessionSkillDirs = new Map<string, Set<string>>(); // channelId → skill dir paths
  // Loaded session hooks per workspace (cached after first load)
  private workspaceHooks = new Map<string, SessionHooks | undefined>();
  // Pending plan exit requests (one per channel)
  private pendingPlanExit = new Map<string, PendingPlanExit>();
  // Debounce timers for plan_changed events
  private planChangedDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  // Previous permissionMode before yolo was auto-enabled by plan exit
  private yoloPreviousState = new Map<string, string>();
  // Handler for send_file tool (set by index.ts, calls adapter.sendFile)
  private sendFileHandler: ((channelId: string, filePath: string, message?: string) => Promise<string>) | null = null;
  private getAdapterForChannel: ((channelId: string) => ChannelAdapter | null) | null = null;

  constructor(bridge: CopilotBridge) {
    this.bridge = bridge;
    this.mcpServers = loadMcpServers();
    ensureWorkspacesDir();
  }

  /** Resolve hooks for a workspace, caching the result. */
  private async resolveHooks(workingDirectory: string): Promise<SessionHooks | undefined> {
    const cached = this.workspaceHooks.get(workingDirectory);
    if (cached !== undefined || this.workspaceHooks.has(workingDirectory)) return cached;
    const allowWorkspaceHooks = getConfig().defaults.allowWorkspaceHooks ?? false;
    const hooks = await loadHooks(workingDirectory, { allowWorkspaceHooks });
    this.workspaceHooks.set(workingDirectory, hooks);
    return hooks;
  }

  /**
   * Wrap loaded hooks so that preToolUse "ask" decisions trigger the bridge's
   * interactive permission prompt instead of being ignored by the CLI.
   */
  private wrapHooksWithAsk(hooks: SessionHooks | undefined, channelId: string): SessionHooks | undefined {
    if (!hooks?.onPreToolUse) return hooks;
    const originalPreToolUse = hooks.onPreToolUse;

    const wrappedPreToolUse = async (input: any, invocation: { sessionId: string }) => {
      const result = await originalPreToolUse(input, invocation);
      if (!result || result.permissionDecision !== 'ask') return result;

      // Convert "ask" into an interactive permission prompt
      const reason = result.permissionDecisionReason ?? 'Hook requires confirmation';
      const toolName = input.toolName ?? 'unknown';

      return new Promise<any>((resolve) => {
        const entry: PendingPermission = {
          sessionId: invocation.sessionId,
          channelId,
          toolName: `hook:${toolName}`,
          serverName: undefined,
          fromHook: true,
          hookReason: reason,
          toolInput: input.toolArgs,
          commands: [],
          resolve: (decision: any) => {
            if (decision.kind === 'approved') {
              resolve({ ...result, permissionDecision: 'allow' });
            } else {
              resolve({ ...result, permissionDecision: 'deny', permissionDecisionReason: reason });
            }
          },
          createdAt: Date.now(),
        };

        let queue = this.pendingPermissions.get(channelId);
        if (!queue) {
          queue = [];
          this.pendingPermissions.set(channelId, queue);
        }
        queue.push(entry);

        if (queue.length === 1) {
          this.eventHandler?.(invocation.sessionId, channelId, {
            type: 'bridge.permission_request',
            data: {
              toolName: `hook:${toolName}`,
              serverName: undefined,
              input: input.toolArgs,
              commands: [],
              hookReason: reason,
              fromHook: true,
            },
          });
        }
      });
    };

    return { ...hooks, onPreToolUse: wrappedPreToolUse };
  }

  /** Register a handler for session events (streaming, tool calls, etc.) */
  onSessionEvent(handler: SessionEventHandler): void {
    this.eventHandler = handler;
  }

  /** Register handler for the send_file custom tool. */
  onSendFile(handler: (channelId: string, filePath: string, message?: string) => Promise<string>): void {
    this.sendFileHandler = handler;
  }

  /** Register adapter resolver for onboarding tools. */
  onGetAdapter(resolver: (channelId: string) => ChannelAdapter | null): void {
    this.getAdapterForChannel = resolver;
  }

  /**
   * Resolve MCP servers for a workspace: workspace config (highest priority)
   * merged on top of global servers (plugin + user config).
   */
  private resolveMcpServers(workingDirectory: string): Record<string, any> {
    const { servers: workspaceServers, env: workspaceEnv } = loadWorkspaceMcpServers(workingDirectory);
    return mergeMcpServers(this.mcpServers, workspaceServers, workspaceEnv, workingDirectory);
  }

  /** Get annotated MCP server info for a channel, showing which layer each server came from. */
  getMcpServerInfo(channelId: string): McpServerInfo[] {
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const { servers: workspaceServers } = loadWorkspaceMcpServers(workingDirectory);
    const globalNames = new Set(Object.keys(this.mcpServers));
    const sessionServers = this.sessionMcpServers.get(channelId);

    const result: McpServerInfo[] = [];

    // All user-level servers — mark project overrides accordingly
    for (const name of globalNames) {
      if (name in workspaceServers) {
        result.push({ name, source: 'workspace (override)', pending: sessionServers ? !sessionServers.has(name) : undefined });
      } else {
        result.push({ name, source: 'user', pending: sessionServers ? !sessionServers.has(name) : undefined });
      }
    }

    // Project-only servers (not in user-level)
    for (const name of Object.keys(workspaceServers)) {
      if (!globalNames.has(name)) {
        result.push({ name, source: 'workspace', pending: sessionServers ? !sessionServers.has(name) : undefined });
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get skill info for a channel — discovers skills and reads their descriptions from SKILL.md frontmatter. */
  getSkillInfo(channelId: string): { name: string; description: string; source: string; pending?: boolean; disabled?: boolean }[] {
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const dirs = discoverSkillDirectories(workingDirectory);
    const sessionDirs = this.sessionSkillDirs.get(channelId);
    const prefs = getChannelPrefs(channelId);
    const disabledSet = new Set(prefs?.disabledSkills ?? []);
    const skills: { name: string; description: string; source: string; pending?: boolean; disabled?: boolean }[] = [];
    const home = process.env.HOME;

    for (const dir of dirs) {
      const name = path.basename(dir);
      const skillFile = path.join(dir, 'SKILL.md');
      let description = '';
      let source = 'user';

      // Determine source from path (normalize separators for cross-platform)
      const normalized = dir.split(path.sep).join('/');
      if (normalized.includes('installed-plugins') && normalized.includes('/skills')) source = 'plugin';
      else if (normalized.includes('.copilot/skills')) source = 'user';
      else if (home && normalized.startsWith(home.split(path.sep).join('/') + '/.agents/skills')) source = 'user';
      else if (normalized.includes('.github/skills')) source = 'workspace';
      else if (normalized.includes('.agents/skills')) source = 'workspace';

      // Try to read description from SKILL.md (matches first description: line)
      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
          if (descMatch) description = descMatch[1];
        } catch { /* skip */ }
      }

      skills.push({ name, description, source, pending: sessionDirs ? !sessionDirs.has(dir) : undefined, disabled: disabledSet.has(name) });
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get info about configured hooks for a channel's workspace. */
  getHooksInfo(channelId: string): HookInfo[] {
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const allowWorkspaceHooks = getConfig().defaults.allowWorkspaceHooks ?? false;
    return getHooksInfo(workingDirectory, { allowWorkspaceHooks });
  }

  /** List tools the SDK CLI process has available (via server RPC). */
  async listSessionTools(channelId: string): Promise<{ name: string; namespacedName?: string; description: string }[]> {
    // Ensure there's an active session so the CLI process is running
    const sessionId = this.channelSessions.get(channelId);
    if (!sessionId) return [];
    try {
      return await this.bridge.listTools();
    } catch (err) {
      log.warn(`Failed to list tools for channel ${channelId}:`, err);
      return [];
    }
  }

  /** Get or create a session for a channel. */
  async ensureSession(channelId: string): Promise<{ sessionId: string; isNew: boolean }> {
    // Check in-memory cache first
    const cachedSessionId = this.channelSessions.get(channelId);
    if (cachedSessionId && this.bridge.getSession(cachedSessionId)) {
      return { sessionId: cachedSessionId, isNew: false };
    }

    // Check SQLite for persisted session
    const storedSessionId = getChannelSession(channelId);
    if (storedSessionId) {
      try {
        await this.attachSession(channelId, storedSessionId);
        return { sessionId: storedSessionId, isNew: false };
      } catch (err) {
      log.warn(`Failed to resume session ${storedSessionId} for channel ${channelId}, creating new:`, err);
        clearChannelSession(channelId);
      }
    }

    // Create new session
    const sessionId = await this.createNewSession(channelId);
    return { sessionId, isNew: true };
  }

  /** Create a brand new session for a channel (used by /new command). */
  async newSession(channelId: string): Promise<string> {
    // Clean up existing session
    const existingId = this.channelSessions.get(channelId);
    if (existingId) {
      const unsub = this.sessionUnsubscribes.get(existingId);
      if (unsub) { unsub(); this.sessionUnsubscribes.delete(existingId); }
      try {
        await this.bridge.destroySession(existingId);
      } catch { /* best-effort */ }
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
      this.contextUsage.delete(channelId);
      this.contextWindowTokens.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
      this.sessionMcpServers.delete(channelId);
      this.sessionSkillDirs.delete(channelId);
      this.pendingPlanExit.delete(channelId);
      this.revertYoloIfNeeded(channelId);
      const debounceTimer = this.planChangedDebounce.get(channelId);
      if (debounceTimer) { clearTimeout(debounceTimer); this.planChangedDebounce.delete(channelId); }
    }
    clearChannelSession(channelId);
    return this.createNewSession(channelId);
  }

  /** Reload the current session — detach and re-attach to pick up AGENTS.md / config changes. */
  async reloadSession(channelId: string): Promise<string> {
    const existingId = this.channelSessions.get(channelId) ?? getChannelSession(channelId) ?? undefined;
    if (!existingId) {
      // No session to reload — just create one
      return this.createNewSession(channelId);
    }

    // Detach event listeners and disconnect so the CLI subprocess tears down
    // in-memory state (including MCP connections), allowing a clean re-init.
    const unsub = this.sessionUnsubscribes.get(existingId);
    if (unsub) { unsub(); this.sessionUnsubscribes.delete(existingId); }
    try { await this.bridge.destroySession(existingId); } catch { /* best-effort */ }

    // Re-read global MCP servers so /reload picks up user-level config changes
    this.mcpServers = loadMcpServers();

    // Re-attach the same session (re-reads workspace config, AGENTS.md, MCP, etc.)
    this.contextUsage.delete(channelId);
      this.contextWindowTokens.delete(channelId);
    this.lastMessageUserIds.delete(channelId);
    this.sessionMcpServers.delete(channelId);
    this.sessionSkillDirs.delete(channelId);
    this.pendingPlanExit.delete(channelId);
    this.revertYoloIfNeeded(channelId);
    { const dt = this.planChangedDebounce.get(channelId); if (dt) { clearTimeout(dt); this.planChangedDebounce.delete(channelId); } }
    try {
      await this.attachSession(channelId, existingId);
      log.info(`Reloaded session ${existingId} for channel ${channelId}`);
      return existingId;
    } catch (err: any) {
      // Session no longer exists server-side (e.g., workspace was deleted and re-created)
      log.warn(`Stale session ${existingId} for channel ${channelId}: ${err?.message ?? err}. Creating new session.`);
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
      this.contextUsage.delete(channelId);
      this.contextWindowTokens.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
      this.sessionMcpServers.delete(channelId);
      this.sessionSkillDirs.delete(channelId);
      this.pendingPlanExit.delete(channelId);
      // yoloPreviousState already reverted above
      clearChannelSession(channelId);
      return this.createNewSession(channelId);
    }
  }

  /** Resume a specific past session by ID. */
  async resumeToSession(channelId: string, targetSessionId: string): Promise<string> {
    // If already attached to this session, just reload it
    const existingId = this.channelSessions.get(channelId);
    if (existingId === targetSessionId) {
      return this.reloadSession(channelId);
    }

    // Clean up current session for this channel
    if (existingId) {
      const unsub = this.sessionUnsubscribes.get(existingId);
      if (unsub) { unsub(); this.sessionUnsubscribes.delete(existingId); }
      try { await this.bridge.destroySession(existingId); } catch { /* best-effort */ }
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
      this.contextUsage.delete(channelId);
      this.contextWindowTokens.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
      this.sessionMcpServers.delete(channelId);
      this.sessionSkillDirs.delete(channelId);
      this.pendingPlanExit.delete(channelId);
      this.revertYoloIfNeeded(channelId);
      { const dt = this.planChangedDebounce.get(channelId); if (dt) { clearTimeout(dt); this.planChangedDebounce.delete(channelId); } }
    }

    // If target session is active on another channel, disconnect it first
    const otherChannel = this.sessionChannels.get(targetSessionId);
    if (otherChannel) {
      const unsub = this.sessionUnsubscribes.get(targetSessionId);
      if (unsub) { unsub(); this.sessionUnsubscribes.delete(targetSessionId); }
      try { await this.bridge.destroySession(targetSessionId); } catch { /* best-effort */ }
      this.channelSessions.delete(otherChannel);
      this.sessionChannels.delete(targetSessionId);
      this.contextUsage.delete(otherChannel);
      this.contextWindowTokens.delete(otherChannel);
      this.lastMessageUserIds.delete(otherChannel);
      this.sessionMcpServers.delete(otherChannel);
      this.sessionSkillDirs.delete(otherChannel);
      this.pendingPlanExit.delete(otherChannel);
      this.revertYoloIfNeeded(otherChannel);
      { const dt = this.planChangedDebounce.get(otherChannel); if (dt) { clearTimeout(dt); this.planChangedDebounce.delete(otherChannel); } }
      clearChannelSession(otherChannel);
    }

    // Attach to the target session — fail hard if it doesn't exist
    // (user explicitly asked for this session, don't silently replace it)
    await this.attachSession(channelId, targetSessionId);
    setChannelSession(channelId, targetSessionId);
    log.info(`Resumed session ${targetSessionId} for channel ${channelId}`);
    return targetSessionId;
  }

  /** Send a message to a channel's session. Returns immediately; responses come via events. */
  async sendMessage(channelId: string, text: string, attachments?: Array<{ type: 'file'; path: string; displayName?: string }>, userId?: string): Promise<string> {
    if (userId) this.lastMessageUserIds.set(channelId, userId);

    // Auto-deny any pending permissions so the session unblocks
    this.clearPendingPermissions(channelId);

    const { sessionId } = await this.ensureSession(channelId);
    const session = this.bridge.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found after ensure`);

    const sendOpts = { prompt: text, attachments };

    try {
      const messageId = await session.send(sendOpts);
      return messageId;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      log.error(`Send failed for session ${sessionId}:`, msg);

      // If this is a model-specific error, switch the model before creating
      // a new session so the fallback model is used for both creation and send
      if (isModelError(err)) {
        log.info(`Model error detected — switching to fallback model for channel ${channelId}...`);
        const prefs = this.getEffectivePrefs(channelId);
        const configChannel = getChannelConfig(channelId);
        const configFallbacks = configChannel.fallbackModels ?? getConfig().defaults.fallbackModels;

        let availableModels: string[] = [];
        try {
          const models = await this.bridge.listModels(getConfig().providers);
          availableModels = models.map(m => m.id);
        } catch { /* best-effort */ }

        const chain = buildFallbackChain(prefs.model, availableModels, configFallbacks);

        // Try each fallback: create session + send
        let lastError: any = err;
        for (const fallbackModel of chain) {
          try {
            log.info(`Trying send with fallback model "${fallbackModel}"...`);
            setChannelPrefs(channelId, { model: fallbackModel });
            const newSessionId = await this.newSession(channelId);
            const newSession = this.bridge.getSession(newSessionId);
            if (!newSession) continue;
            const messageId = await newSession.send(sendOpts);

            log.info(`Model fallback on send: "${prefs.model}" → "${fallbackModel}" for channel ${channelId}`);
            this.eventHandler?.(newSession.sessionId, channelId, {
              type: 'assistant.message',
              data: {
                message: `⚠️ Model \`${prefs.model}\` is unavailable. Switched to \`${fallbackModel}\`.`,
              },
            });
            return messageId;
          } catch (fallbackErr: any) {
            log.warn(`Fallback model "${fallbackModel}" also failed on send: ${fallbackErr?.message ?? fallbackErr}`);
            lastError = fallbackErr;
          }
        }

        // If no fallback worked, restore original model pref and throw
        setChannelPrefs(channelId, { model: prefs.model });
        throw lastError;
      }

      // Try to reconnect to the same session (CLI subprocess may have restarted)
      try {
        log.info(`Attempting to re-attach session ${sessionId}...`);
        const unsub = this.sessionUnsubscribes.get(sessionId);
        if (unsub) { unsub(); this.sessionUnsubscribes.delete(sessionId); }
        try { await this.bridge.destroySession(sessionId); } catch { /* best-effort */ }
        await this.attachSession(channelId, sessionId);
        const reconnected = this.bridge.getSession(sessionId);
        if (reconnected) {
          log.info(`Re-attached session ${sessionId} successfully`);
          return reconnected.send(sendOpts);
        }
      } catch (retryErr: any) {
        log.warn(`Re-attach failed:`, retryErr?.message ?? retryErr);
      }

      // Last resort: create a new session (handles fallback via createNewSession)
      log.info(`Creating new session for channel ${channelId}...`);
      const newSessionId = await this.newSession(channelId);
      const newSession = this.bridge.getSession(newSessionId);
      if (!newSession) throw new Error(`New session ${newSessionId} not found`);
      return newSession.send(sendOpts);
    }
  }

  /** Send a mid-turn message to an active session using immediate mode (steering).
   *  Throws if no active session exists or if send fails. */
  async sendMidTurn(channelId: string, text: string, userId?: string): Promise<string> {
    if (userId) this.lastMessageUserIds.set(channelId, userId);

    const sessionId = this.channelSessions.get(channelId);
    if (!sessionId) throw new Error(`No active session for channel ${channelId}`);

    const session = this.bridge.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    log.info(`Mid-turn send (immediate) for channel ${channelId.slice(0, 8)}...: "${text.slice(0, 100)}"`);
    return session.send({ prompt: text, mode: 'immediate' });
  }

  /** Deny all pending permissions for a channel (e.g., when user sends a new message instead). */
  private clearPendingPermissions(channelId: string): void {
    const queue = this.pendingPermissions.get(channelId);
    if (queue && queue.length > 0) {
      log.info(`Auto-denying ${queue.length} pending permission(s) for channel ${channelId}`);
      for (const entry of queue) {
        entry.resolve({ kind: 'denied-interactively-by-user' });
      }
      this.pendingPermissions.delete(channelId);
    }

    const inputQueue = this.pendingUserInput.get(channelId);
    if (inputQueue && inputQueue.length > 0) {
      log.info(`Cancelling ${inputQueue.length} pending input request(s) for channel ${channelId}`);
      for (const entry of inputQueue) {
        entry.resolve({ answer: '', wasFreeform: true });
      }
      this.pendingUserInput.delete(channelId);
    }
  }

  /** Switch the model for a channel's session. */
  async switchModel(channelId: string, model: string): Promise<void> {
    const sessionId = this.channelSessions.get(channelId);
    if (sessionId) {
      try {
        await this.bridge.switchSessionModel(sessionId, model);
      } catch (err) {
        log.warn(`RPC model switch failed:`, err);
      }
    }
    setChannelPrefs(channelId, { model });

    // Clear stale context window tokens so /context falls back to tokenLimit during transition
    this.contextWindowTokens.delete(channelId);

    // Update cached context window tokens for the new model (best-effort)
    this.bridge.listModels(getConfig().providers).then(models => {
      // Guard against rapid switches: only cache if the channel is still on this model
      const currentPrefs = this.getEffectivePrefs(channelId);
      if (currentPrefs.model === model) {
        this.cacheContextWindowTokens(channelId, model, models);
      }
    }).catch(() => { /* best-effort */ });
  }

  /** Switch the agent for a channel's session. */
  async switchAgent(channelId: string, agent: string | null): Promise<void> {
    const { sessionId } = await this.ensureSession(channelId);
    try {
      if (agent) {
        await this.bridge.selectAgent(sessionId, agent);
      } else {
        await this.bridge.deselectAgent(sessionId);
      }
    } catch (err) {
      log.warn(`RPC agent switch failed:`, err);
    }
    setChannelPrefs(channelId, { agent });
  }

  /** Get effective preferences for a channel (config merged with runtime overrides). */
  getEffectivePrefs(channelId: string): ChannelPrefs & { model: string; verbose: boolean; threadedReplies: boolean; permissionMode: string; triggerMode: 'mention' | 'all' } {
    const configChannel = getChannelConfig(channelId);
    const storedPrefs = getChannelPrefs(channelId);
    return {
      model: storedPrefs?.model ?? configChannel.model ?? 'claude-sonnet-4.6',
      provider: storedPrefs?.provider ?? null,
      agent: storedPrefs?.agent !== undefined ? storedPrefs.agent : configChannel.agent,
      verbose: storedPrefs?.verbose ?? configChannel.verbose,
      triggerMode: configChannel.triggerMode,
      threadedReplies: storedPrefs?.threadedReplies ?? configChannel.threadedReplies,
      permissionMode: storedPrefs?.permissionMode ?? configChannel.permissionMode,
      reasoningEffort: storedPrefs?.reasoningEffort ?? (configChannel as any).reasoningEffort ?? null,
      disabledSkills: storedPrefs?.disabledSkills,
    };
  }

  /** Get model info (for checking capabilities like reasoning effort). */
  async getModelInfo(modelId: string): Promise<any | null> {
    try {
      const models = await this.bridge.listModels(getConfig().providers);
      return models.find(m => m.id === modelId) ?? null;
    } catch {
      return null;
    }
  }

  /** List all available models. */
  async listModels(): Promise<any[]> {
    return this.bridge.listModels(getConfig().providers);
  }

  /** Get the current session mode (interactive, plan, autopilot). Falls back to persisted prefs after restart. */
  async getSessionMode(channelId: string): Promise<string> {
    const sessionId = this.channelSessions.get(channelId);
    if (sessionId) {
      try {
        const result = await this.bridge.getSessionMode(sessionId);
        return result.mode;
      } catch { /* fall through to prefs */ }
    }
    const prefs = getChannelPrefs(channelId);
    return prefs?.sessionMode ?? 'interactive';
  }

  /** Set the session mode (interactive, plan, autopilot). Persists to channel prefs. Does not change yolo/permission state. */
  async setSessionMode(channelId: string, mode: 'interactive' | 'plan' | 'autopilot'): Promise<string> {
    const { sessionId } = await this.ensureSession(channelId);
    const result = await this.bridge.setSessionMode(sessionId, mode);
    setChannelPrefs(channelId, { sessionMode: result.mode });
    return result.mode;
  }

  /** Read the plan.md file from the session workspace. */
  async readPlan(channelId: string): Promise<{ exists: boolean; content: string | null }> {
    const sessionId = this.channelSessions.get(channelId);
    if (!sessionId) return { exists: false, content: null };
    try {
      const result = await this.bridge.readPlan(sessionId);
      return { exists: result.exists, content: result.content };
    } catch {
      return { exists: false, content: null };
    }
  }

  /** Clear the plan.md file from the session workspace. */
  async deletePlan(channelId: string): Promise<boolean> {
    const sessionId = this.channelSessions.get(channelId);
    if (!sessionId) return false;
    try {
      await this.bridge.deletePlan(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract a succinct summary from plan content.
   * Returns the first heading + first 1-2 sentences, ~100-150 chars.
   */
  extractPlanSummary(content: string): string {
    return extractPlanSummary(content);
  }

  // Preferred models for plan summarization — balanced for quality and cost.
  // Summarization needs accurate extraction without hallucination, so we
  // prefer capable mid-tier models over the cheapest options.
  // Matched against available models via exact-then-prefix so partial matches
  // work even if the catalog adds suffixes or version bumps.
  private static readonly SUMMARIZER_MODELS = [
    'claude-sonnet-4.6',    // strong comprehension, likely to stay available
    'claude-sonnet-4.5',    // strong comprehension
    'gpt-4.1',              // fast, capable
    'gpt-5-mini',           // smaller but still capable
    'claude-haiku-4.5',     // fastest Claude, adequate for short summaries
    'gpt-5.1',              // full-size fallback
    'gpt-5.2',              // full-size fallback
  ];

  /**
   * Summarize a plan using a lightweight ephemeral session.
   * Creates a throwaway session with a cheap model, sends the plan for summarization,
   * collects the streamed response, and destroys the session.
   */
  async summarizePlan(channelId: string): Promise<string | null> {
    const plan = await this.readPlan(channelId);
    if (!plan.exists || !plan.content) return null;

    // Pick the best available cheap model
    let availableIds: string[] = [];
    try {
      const models = await this.bridge.listModels(getConfig().providers);
      availableIds = models.map(m => m.id);
    } catch { /* best-effort */ }

    let model: string | undefined;
    for (const candidate of SessionManager.SUMMARIZER_MODELS) {
      const match = availableIds.find(id => id === candidate || id.startsWith(candidate));
      if (match) { model = match; break; }
    }
    // If none matched, leave model undefined — SDK picks its default

    log.info(`Summarizing plan for ${channelId.slice(0, 8)}... using model ${model ?? '(sdk default)'}`);

    let session: CopilotSession | undefined;
    try {
      session = await this.bridge.createSession({
        ...(model ? { model } : {}),
        onPermissionRequest: async () => ({ kind: 'denied-interactively-by-user' as const }),
        systemMessage: { content: 'You are a concise summarizer. Respond with only the summary, no preamble.' },
      });

      const prompt = `Condense this plan into a short summary that preserves the main section headings (## level). Under each heading, write one sentence capturing the key point. Include any unresolved questions or TBDs. Omit code blocks, type definitions, and resolved questions. Keep the total under 500 characters.\n\n${plan.content}`;
      const response = await this.sendAndWaitForIdle(session, prompt, 30_000);
      return response.trim() || null;
    } catch (err: any) {
      log.warn(`Plan summarization failed: ${err?.message ?? err}`);
      return null;
    } finally {
      if (session) {
        try { await this.bridge.destroySession(session.sessionId); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Check for an existing plan and return summary if found.
   * Called after session resume to notify the user.
   */
  async surfacePlanIfExists(channelId: string): Promise<{ exists: boolean; summary: string; inPlanMode: boolean } | null> {
    const plan = await this.readPlan(channelId);
    if (!plan.exists || !plan.content) return null;

    const summary = this.extractPlanSummary(plan.content);
    let inPlanMode = false;
    try {
      const mode = await this.getSessionMode(channelId);
      inPlanMode = mode === 'plan';
    } catch { /* best-effort */ }

    return { exists: true, summary, inPlanMode };
  }

  /** Check if the Copilot CLI is authenticated. */
  async getAuthStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string; login?: string }> {
    try {
      return await this.bridge.getAuthStatus();
    } catch {
      return { isAuthenticated: false, statusMessage: 'Unable to check auth status' };
    }
  }

  /** Resolve a pending permission request (first in queue). */
  resolvePermission(channelId: string, allow: boolean, remember?: boolean): boolean {
    const queue = this.pendingPermissions.get(channelId);
    if (!queue || queue.length === 0) return false;

    const pending = queue.shift()!;

    if (remember && !pending.fromHook) {
      const action = allow ? 'allow' : 'deny';
      if (pending.serverName) {
        // MCP tool: save at server level so all tools on this server are covered
        addPermissionRule(channelId, `mcp:${pending.serverName}`, '*', action as 'allow' | 'deny');
        log.info(`Saved ${action} rule for MCP server "${pending.serverName}" in channel ${channelId}`);
      } else if (pending.commands.length > 0) {
        for (const cmd of pending.commands) {
          addPermissionRule(channelId, pending.toolName, cmd, action as 'allow' | 'deny');
        }
      } else {
        addPermissionRule(channelId, pending.toolName, '*', action as 'allow' | 'deny');
      }
    }

    pending.resolve(allow
      ? { kind: 'approved' }
      : { kind: 'denied-interactively-by-user' });

    if (queue.length === 0) {
      this.pendingPermissions.delete(channelId);
    } else {
      // Surface the next queued permission request
      const next = queue[0];
      this.eventHandler?.(next.sessionId, channelId, {
        type: 'bridge.permission_request',
        data: {
          toolName: next.toolName,
          serverName: next.serverName,
          input: next.toolInput,
          commands: next.commands,
          fromHook: next.fromHook,
          hookReason: next.hookReason,
        },
      });
    }

    return true;
  }

  /** Resolve a pending user input request (first in queue). */
  resolveUserInput(channelId: string, answer: string): boolean {
    const queue = this.pendingUserInput.get(channelId);
    if (!queue || queue.length === 0) return false;

    const pending = queue.shift()!;
    pending.resolve({ answer, wasFreeform: true });

    if (queue.length === 0) {
      this.pendingUserInput.delete(channelId);
    } else {
      // Surface the next queued user input request
      const next = queue[0];
      this.eventHandler?.(next.sessionId, channelId, {
        type: 'bridge.user_input_request',
        data: {
          question: next.question,
          choices: next.choices,
          allowFreeform: next.allowFreeform,
        },
      });
    }

    return true;
  }

  /** Check if channel has a pending permission request. */
  hasPendingPermission(channelId: string): boolean {
    const queue = this.pendingPermissions.get(channelId);
    return !!queue && queue.length > 0;
  }

  /** Check if the current pending permission is from a hook (no remember allowed). */
  isHookPermission(channelId: string): boolean {
    const queue = this.pendingPermissions.get(channelId);
    return !!queue && queue.length > 0 && !!queue[0].fromHook;
  }

  /** Store a pending plan exit request. */
  setPendingPlanExit(channelId: string, pending: PendingPlanExit): void {
    this.pendingPlanExit.set(channelId, pending);
  }

  /** Check if channel has a pending plan exit request. */
  hasPendingPlanExit(channelId: string): boolean {
    return this.pendingPlanExit.has(channelId);
  }

  /** Get and clear the pending plan exit request. */
  consumePendingPlanExit(channelId: string): PendingPlanExit | undefined {
    const pending = this.pendingPlanExit.get(channelId);
    if (pending) this.pendingPlanExit.delete(channelId);
    return pending;
  }

  /** Save previous permission mode before auto-enabling yolo. */
  saveYoloPreviousState(channelId: string): void {
    const prefs = getChannelPrefs(channelId);
    const channelConfig = getChannelConfig(channelId);
    const current = prefs?.permissionMode ?? channelConfig.permissionMode;
    this.yoloPreviousState.set(channelId, current);
  }

  /** Revert yolo to previous state (called on session.idle after plan implementation). */
  revertYoloIfNeeded(channelId: string): boolean {
    const previous = this.yoloPreviousState.get(channelId);
    if (previous === undefined) return false;
    this.yoloPreviousState.delete(channelId);
    setChannelPrefs(channelId, { permissionMode: previous });
    return true;
  }

  /** Debounced plan change handler — calls callback after debounce window. */
  debouncePlanChanged(channelId: string, callback: () => void | Promise<void>, delayMs = 3000): void {
    const existing = this.planChangedDebounce.get(channelId);
    if (existing) clearTimeout(existing);
    this.planChangedDebounce.set(channelId, setTimeout(() => {
      this.planChangedDebounce.delete(channelId);
      void Promise.resolve(callback()).catch((err) => {
        log.warn(`Debounced plan callback failed for ${channelId.slice(0, 8)}...: ${err}`);
      });
    }, delayMs));
  }

  /** Get the current session ID for a channel (if any). */
  getSessionId(channelId: string): string | undefined {
    return this.channelSessions.get(channelId) ?? getChannelSession(channelId) ?? undefined;
  }

  /** Abort the current turn for a channel's session. */
  async abortSession(channelId: string): Promise<void> {
    const sessionId = this.channelSessions.get(channelId);
    if (sessionId) {
      await this.bridge.abortSession(sessionId);
    }
  }

  /** Check if channel has a pending user input request. */
  hasPendingUserInput(channelId: string): boolean {
    const queue = this.pendingUserInput.get(channelId);
    return !!queue && queue.length > 0;
  }

  /** Get info about the current session for a channel. */
  getSessionInfo(channelId: string): { sessionId: string; model: string; agent: string | null } | null {
    const sessionId = this.channelSessions.get(channelId);
    if (!sessionId) return null;
    const prefs = this.getEffectivePrefs(channelId);
    return { sessionId, model: prefs.model, agent: prefs.agent ?? null };
  }

  /** Get cached context window usage for a channel. */
  getContextUsage(channelId: string): { currentTokens: number; tokenLimit: number; contextWindowTokens?: number } | null {
    const usage = this.contextUsage.get(channelId);
    if (!usage) return null;
    const ctxWindow = this.contextWindowTokens.get(channelId);
    return ctxWindow ? { ...usage, contextWindowTokens: ctxWindow } : usage;
  }

  /** Cache the model's max_context_window_tokens for accurate /context display. */
  private cacheContextWindowTokens(channelId: string, modelId: string, modelList: any[]): void {
    let model = modelList.find((m: any) => m.id === modelId);
    // For BYOK models, the merged list has provider-prefixed IDs (e.g., "ollama-local:qwen3:8b")
    if (!model) {
      const prefs = getChannelPrefs(channelId);
      if (prefs?.provider) {
        model = modelList.find((m: any) => m.id === `${prefs.provider}:${modelId}`);
      }
    }
    const ctxTokens = model?.capabilities?.limits?.max_context_window_tokens;
    if (typeof ctxTokens === 'number' && ctxTokens > 0) {
      this.contextWindowTokens.set(channelId, ctxTokens);
    }
  }

  /**
   * Resolve a session ID prefix to matching full session IDs.
   * Returns all session IDs (for the channel's workspace) whose ID starts with the given prefix.
   */
  async resolveSessionPrefix(channelId: string, prefix: string): Promise<string[]> {
    const sessions = await this.listChannelSessions(channelId);
    const lower = prefix.toLowerCase();
    return sessions
      .filter(s => s.sessionId.toLowerCase().startsWith(lower))
      .map(s => s.sessionId);
  }

  /** List past sessions for this channel's working directory. */
  async listChannelSessions(channelId: string): Promise<Array<{ sessionId: string; startTime: Date; modifiedTime: Date; summary?: string; isCurrent: boolean }>> {
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const sessions = await this.bridge.listSessions({ cwd: workingDirectory });
    const currentId = this.channelSessions.get(channelId);
    return sessions.map(s => ({
      sessionId: s.sessionId,
      startTime: s.startTime,
      modifiedTime: s.modifiedTime,
      summary: s.summary,
      isCurrent: s.sessionId === currentId,
    }));
  }

  // --- Private helpers ---

  /** Resolve working directory: SQLite workspace override → channel config → default workspace path. */
  private resolveWorkingDirectory(channelId: string): string {
    const botName = getChannelBotName(channelId);
    const override = getWorkspaceOverride(botName);
    if (override) return override.workingDirectory;

    const config = getChannelConfig(channelId);
    if (config.workingDirectory) return config.workingDirectory;

    return getWorkspacePath(botName);
  }

  private async createNewSession(channelId: string): Promise<string> {
    const prefs = this.getEffectivePrefs(channelId);
    const workingDirectory = this.resolveWorkingDirectory(channelId);

    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;

    const reasoningEffort = prefs.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    const skillDirectories = discoverSkillDirectories(workingDirectory);
    const customTools = this.buildCustomTools(channelId);
    const disabledSkills = prefs.disabledSkills?.length ? prefs.disabledSkills : undefined;

    // Resolve fallback configuration
    const configChannel = getChannelConfig(channelId);
    const configFallbacks = configChannel.fallbackModels ?? getConfig().defaults.fallbackModels;

    // Resolve BYOK provider if set in prefs
    const providerName = prefs.provider ?? null;
    const sdkProvider = providerName
      ? resolveProviderConfig(providerName, getConfig().providers)
      : undefined;
    if (providerName && !sdkProvider) {
      log.warn(`Provider "${providerName}" set for channel ${channelId} but not found in config — using Copilot`);
    }

    // Fetch available models for fallback chain (best-effort — don't block on failure)
    let availableModels: string[] = [];
    let modelList: any[] = [];
    try {
      modelList = await this.bridge.listModels(getConfig().providers);
      availableModels = modelList.map(m => m.id);
    } catch {
      log.warn('Failed to fetch model list for fallback resolution');
    }

    const resolvedMcpServers = this.resolveMcpServers(workingDirectory);
    const rawHooks = await this.resolveHooks(workingDirectory);
    const hooks = this.wrapHooksWithAsk(rawHooks, channelId);
    if (hooks) {
      log.debug(`Hooks resolved for session create: ${Object.keys(hooks).join(', ')}`);
    }

    const createWithModel = async (model: string) => {
      return withWorkspaceEnv(workingDirectory, () =>
        this.bridge.createSession({
          model,
          provider: sdkProvider || undefined,
          workingDirectory,
          configDir: defaultConfigDir,
          reasoningEffort: reasoningEffort ?? undefined,
          mcpServers: resolvedMcpServers,
          skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
          disabledSkills,
          onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
          onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
          tools: customTools.length > 0 ? customTools : undefined,
          hooks,
          infiniteSessions: getConfig().infiniteSessions,
        })
      );
    };

    const { result: session, usedModel, didFallback } = await tryWithFallback(
      prefs.model,
      availableModels,
      configFallbacks,
      createWithModel,
    );

    this.sessionMcpServers.set(channelId, new Set(Object.keys(resolvedMcpServers)));
    this.sessionSkillDirs.set(channelId, new Set(skillDirectories));
    this.cacheContextWindowTokens(channelId, usedModel, modelList);

    if (didFallback) {
      log.info(`Model fallback: "${prefs.model}" → "${usedModel}" for channel ${channelId}`);
      setChannelPrefs(channelId, { model: usedModel });

      // Emit a user-visible warning via session event
      this.eventHandler?.(session.sessionId, channelId, {
        type: 'assistant.message',
        data: {
          content: `⚠️ Model \`${prefs.model}\` is unavailable. Switched to \`${usedModel}\`.`,
        },
      });
    }

    const sessionId = session.sessionId;
    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    setChannelSession(channelId, sessionId);

    this.attachSessionEvents(session, channelId);

    log.info(`Created session ${sessionId} for channel ${channelId} (model: ${usedModel})`);
    return sessionId;
  }

  private async attachSession(channelId: string, sessionId: string): Promise<void> {
    const prefs = this.getEffectivePrefs(channelId);
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;
    const reasoningEffort = prefs.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    const skillDirectories = discoverSkillDirectories(workingDirectory);
    const customTools = this.buildCustomTools(channelId);
    const disabledSkills = prefs.disabledSkills?.length ? prefs.disabledSkills : undefined;

    const mcpServers = this.resolveMcpServers(workingDirectory);
    const rawHooks = await this.resolveHooks(workingDirectory);
    const hooks = this.wrapHooksWithAsk(rawHooks, channelId);
    if (hooks) {
      log.debug(`Hooks resolved for session resume: ${Object.keys(hooks).join(', ')}`);
    }

    // Resolve BYOK provider for resume
    const providerName = prefs.provider ?? null;
    const sdkProvider = providerName
      ? resolveProviderConfig(providerName, getConfig().providers)
      : undefined;

    const session = await withWorkspaceEnv(workingDirectory, () =>
      this.bridge.resumeSession(sessionId, {
        onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
        onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
        configDir: defaultConfigDir,
        workingDirectory,
        provider: sdkProvider || undefined,
        reasoningEffort: reasoningEffort ?? undefined,
        mcpServers,
        skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
        disabledSkills,
        tools: customTools.length > 0 ? customTools : undefined,
        hooks,
        infiniteSessions: getConfig().infiniteSessions,
      })
    );

    this.sessionMcpServers.set(channelId, new Set(Object.keys(mcpServers)));
    this.sessionSkillDirs.set(channelId, new Set(skillDirectories));
    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    this.attachSessionEvents(session, channelId);

    // Cache context window tokens for /context display (best-effort, non-blocking)
    const resumeModel = prefs.model;
    this.bridge.listModels(getConfig().providers).then(models => {
      // Guard against model changes before this resolves
      const currentPrefs = this.getEffectivePrefs(channelId);
      if (currentPrefs.model === resumeModel) {
        this.cacheContextWindowTokens(channelId, resumeModel, models);
      }
    }).catch(() => { /* best-effort */ });
  }

  /**
   * Execute an ephemeral inter-agent call: create a fresh session for the target bot,
   * send the message, collect the response, and tear down.
   */
  async executeEphemeralCall(opts: {
    callerBot: string;
    targetBot: string;
    message: string;
    context: InterAgentContext;
    agent?: string;
    timeout?: number;
    autopilot?: boolean;
    denyTools?: string[];
    grantTools?: string[];
    callerChannelId: string;
  }): Promise<{ success: true; response: string } | { success: false; error: string; detail: string }> {
    const iaConfig = getInterAgentConfig();
    const timeout = Math.min(
      opts.timeout ?? iaConfig.defaultTimeout ?? 60,
      iaConfig.maxTimeout ?? 300,
    ) * 1000; // convert to ms

    const startTime = Date.now();
    const nextContext = extendContext(opts.context, opts.targetBot);

    // Resolve target bot's workspace
    const targetWorkspace = getWorkspacePath(opts.targetBot);
    const targetBotConfig = this.getTargetBotConfig(opts.targetBot);

    // Resolve agent definition
    const agentDef = resolveAgentDefinition(
      targetWorkspace,
      opts.agent,
      targetBotConfig?.agent,
    );

    // Build workspace awareness
    const workspaceMap = getBotWorkspaceMap(opts.targetBot);
    const workspacePrompt = buildWorkspacePrompt(workspaceMap);
    const callerPrompt = buildCallerPrompt(opts.context);

    // Build system message with inter-agent context
    const systemParts = [callerPrompt, workspacePrompt];
    if (agentDef) {
      systemParts.push(`\n--- Agent Definition: ${agentDef.name} ---\n${agentDef.content}`);
    }
    // If the target has an ask_agent tool available, inject the chain context
    if (nextContext.depth < (iaConfig.maxDepth ?? 3)) {
      systemParts.push(
        `\nYou have the ask_agent tool available for calling other agents. Current call chain: ${nextContext.visited.join(' → ')}. Remaining depth: ${(iaConfig.maxDepth ?? 3) - nextContext.depth}.`
      );
    }

    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;
    const skillDirectories = discoverSkillDirectories(targetWorkspace);
    const hooks = await this.resolveHooks(targetWorkspace);

    // Build ephemeral permission handler
    const ephemeralPermissionHandler = this.buildEphemeralPermissionHandler(opts);

    // Build custom tools for ephemeral session (ask_agent with propagated context)
    // Pass target bot name so chained calls use B's identity (not A's channel)
    const ephemeralTools = this.buildEphemeralTools(opts.targetBot, nextContext);

    let session: CopilotSession | undefined;
    try {
      session = await withWorkspaceEnv(targetWorkspace, () =>
        this.bridge.createSession({
          workingDirectory: targetWorkspace,
          configDir: defaultConfigDir,
          mcpServers: this.resolveMcpServers(targetWorkspace),
          skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
          onPermissionRequest: ephemeralPermissionHandler,
          systemMessage: { content: systemParts.filter(Boolean).join('\n\n') },
          tools: ephemeralTools.length > 0 ? ephemeralTools : undefined,
          hooks,
        })
      );

      // Send message and wait for idle
      const response = await this.sendAndWaitForIdle(session, opts.message, timeout);

      const durationMs = Date.now() - startTime;
      recordAgentCall({
        callerBot: opts.callerBot,
        targetBot: opts.targetBot,
        targetAgent: opts.agent,
        messageSummary: opts.message.slice(0, 500),
        responseSummary: response.slice(0, 500),
        durationMs,
        success: true,
        chainId: opts.context.chainId,
        depth: nextContext.depth,
      });

      log.info(`Ephemeral call ${opts.callerBot}→${opts.targetBot}: ${durationMs}ms, ${response.length} chars`);
      return { success: true, response };

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err?.message ?? 'unknown error';
      recordAgentCall({
        callerBot: opts.callerBot,
        targetBot: opts.targetBot,
        targetAgent: opts.agent,
        messageSummary: opts.message.slice(0, 500),
        durationMs,
        success: false,
        error: errorMsg,
        chainId: opts.context.chainId,
        depth: nextContext.depth,
      });

      log.error(`Ephemeral call ${opts.callerBot}→${opts.targetBot} failed: ${errorMsg}`);
      return { success: false, error: 'ephemeral_session_error', detail: errorMsg };

    } finally {
      if (session) {
        try { await this.bridge.destroySession(session.sessionId); } catch { /* best-effort */ }
      }
    }
  }

  /** Send a message to a session and wait for session.idle, collecting streamed response text. */
  private sendAndWaitForIdle(session: CopilotSession, message: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          unsub();
          reject(new Error(`Ephemeral session timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);

      const unsub = session.on((event: any) => {
        if (settled) return;
        if (event.type === 'assistant.message_delta') {
          const text = event.data?.deltaContent ?? event.data?.text ?? event.deltaContent ?? '';
          if (text) chunks.push(text);
        }
        if (event.type === 'assistant.message' && event.data?.content && chunks.length === 0) {
          // Full message event — only use as fallback when no deltas were received
          chunks.push(event.data.content);
        }
        if (event.type === 'session.idle') {
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(chunks.join(''));
        }
        if (event.type === 'session.error') {
          settled = true;
          clearTimeout(timer);
          unsub();
          reject(new Error(event.data?.message ?? 'Session error'));
        }
      });

      session.send({ prompt: message }).catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          unsub();
          reject(err);
        }
      });
    });
  }

  /** Build a permission handler for ephemeral sessions with merged caller+target rules. */
  private buildEphemeralPermissionHandler(opts: {
    autopilot?: boolean;
    denyTools?: string[];
    grantTools?: string[];
    callerChannelId: string;
    targetBot: string;
  }): (request: any, invocation: { sessionId: string }) => Promise<any> {
    return async (request: any, _invocation: { sessionId: string }) => {
      const reqKind = (request as any).kind;
      const reqCommand = typeof (request as any).fullCommandText === 'string'
        ? (request as any).fullCommandText
        : typeof (request as any).command === 'string' ? (request as any).command : undefined;

      // 1. Hardcoded safety denies — always enforced
      if (isHardDeny(reqKind, reqCommand)) {
        return { kind: 'denied-by-rules' };
      }

      // 2. Caller's explicit denies — checked before auto-approve
      if (opts.denyTools && opts.denyTools.length > 0) {
        const toolName = (request as any).toolName ?? (request as any).tool_name ?? (request as any).name ?? reqKind;
        if (opts.denyTools.includes(toolName)) {
          return { kind: 'denied-by-rules' };
        }
      }

      // 3. Auto-approve bridge custom tools
      if (reqKind === 'custom-tool') {
        const reqToolName = (request as any).toolName;
        if (BRIDGE_CUSTOM_TOOLS.includes(reqToolName)) {
          return { kind: 'approved' };
        }
      }

      // 4. Caller's explicit grants (only if caller has them)
      if (opts.grantTools && opts.grantTools.length > 0) {
        const toolName = (request as any).toolName ?? (request as any).tool_name ?? (request as any).name ?? reqKind;
        if (opts.grantTools.includes(toolName)) {
          // Verify caller has this permission
          const callerResult = checkPermission(opts.callerChannelId, toolName, '*');
          if (callerResult === 'allow') {
            return { kind: 'approved' };
          }
        }
      }

      // 5. Target bot's own stored permission rules
      // Use a synthetic scope for the target bot
      const targetScope = `bot:${opts.targetBot}`;
      const toolName = (request as any).toolName ?? (request as any).tool_name ?? (request as any).name ?? reqKind;
      const storedResult = checkPermission(targetScope, toolName, '*');
      if (storedResult === 'allow') return { kind: 'approved' };
      if (storedResult === 'deny') return { kind: 'denied-by-rules' };

      // 6. Caller channel's stored rules (merged — supplement target)
      const callerResult = checkPermission(opts.callerChannelId, toolName, '*');
      if (callerResult === 'allow') return { kind: 'approved' };

      // 7. Autopilot: approve remaining if enabled
      if (opts.autopilot) {
        return { kind: 'approved' };
      }

      // 8. No rule matched — deny with detail (no human to ask in ephemeral sessions)
      log.warn(`Ephemeral permission denied (no rule): ${toolName} for ${opts.targetBot}`);
      return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
    };
  }

  /** Build custom tools for an ephemeral inter-agent session. */
  private buildEphemeralTools(currentBotName: string, context: InterAgentContext): any[] {
    const tools: any[] = [];
    const iaConfig = getInterAgentConfig();

    // Only register ask_agent if there's remaining depth
    if (iaConfig.enabled && context.depth < (iaConfig.maxDepth ?? 3)) {
      tools.push(this.buildAskAgentToolDef(currentBotName, context, true));
    }

    return tools;
  }

  /** Get target bot config across all platforms. */
  private getTargetBotConfig(botName: string): { agent?: string | null; admin?: boolean } | null {
    const config = getConfig();
    for (const platform of Object.values(config.platforms)) {
      if (platform.bots?.[botName]) {
        return platform.bots[botName];
      }
    }
    return null;
  }

  /** Build the ask_agent tool definition (shared by normal and ephemeral sessions).
   *  When callerBotDirect is true, channelIdOrBot is the bot name directly (for ephemeral sessions). */
  private buildAskAgentToolDef(channelIdOrBot: string, parentContext?: InterAgentContext, callerBotDirect = false): any {
    const callerBot = callerBotDirect ? channelIdOrBot : getChannelBotName(channelIdOrBot);
    const channelId = callerBotDirect ? undefined : channelIdOrBot;

    return {
      name: 'ask_agent',
      description: 'Ask another agent a question. Creates a fresh session for the target agent with its own workspace, tools, and knowledge. Use this when you need information or capabilities from a different bot identity (e.g., asking Alice about home automation, asking a specialist about their domain). IMPORTANT: The user cannot see the inter-agent exchange. After receiving the response, communicate the relevant information back to the user.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'The bot name to ask (e.g., "alice", "copilot"). Must be configured in the inter-agent allowlist.',
          },
          message: {
            type: 'string',
            description: 'The question or request to send to the target agent.',
          },
          agent: {
            type: 'string',
            description: 'Optional: specific agent persona to use (matches *.agent.md file in the target\'s workspace/agents/ directory).',
          },
          timeout: {
            type: 'number',
            description: 'Optional: timeout in seconds (default from config, capped at maxTimeout).',
          },
          autopilot: {
            type: 'boolean',
            description: 'Optional: auto-approve tool permissions in the target session (default: false). Enable for trusted queries that may require tool use.',
          },
          denyTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: tool names to deny in the target session (e.g., ["bash"] for read-only queries).',
          },
          grantTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: tool names to pre-approve in the target session. Only effective if you (the caller) also have those tools approved.',
          },
        },
        required: ['target', 'message'],
      },
      handler: async (args: {
        target: string;
        message: string;
        agent?: string;
        timeout?: number;
        autopilot?: boolean;
        denyTools?: string[];
        grantTools?: string[];
      }) => {
        try {
          // Build or extend context
          const context = parentContext
            ? parentContext
            : createContext(callerBot, channelId!);

          // Pre-flight: check if the call is allowed
          const blocked = canCall(callerBot, args.target, context);
          if (blocked) {
            return { content: JSON.stringify({ success: false, error: 'not_allowed', detail: blocked }) };
          }

          const result = await this.executeEphemeralCall({
            callerBot,
            targetBot: args.target,
            message: args.message,
            context,
            agent: args.agent,
            timeout: args.timeout,
            autopilot: args.autopilot,
            denyTools: args.denyTools,
            grantTools: args.grantTools,
            callerChannelId: channelId ?? `bot:${callerBot}`,
          });

          return { content: JSON.stringify(result) };
        } catch (err: any) {
          return { content: JSON.stringify({ success: false, error: 'tool_error', detail: err?.message ?? 'unknown error' }) };
        }
      },
    };
  }

  /** Build custom tool definitions to pass to SDK session creation. */
  private buildCustomTools(channelId: string): any[] {
    const tools: any[] = [];

    if (this.sendFileHandler) {
      const handler = this.sendFileHandler;
      const config = getChannelConfig(channelId);
      const botName = getChannelBotName(channelId);
      const workDir = this.resolveWorkingDirectory(channelId);
      const allowPaths = getWorkspaceAllowPaths(botName, config.platform);

      tools.push({
        name: 'send_file',
        description: 'Send a file or image from the workspace to the user in their chat channel. The file will appear as an inline image (for image types) or a downloadable attachment.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file to send (absolute or relative to workspace)' },
            message: { type: 'string', description: 'Optional message to accompany the file' },
          },
          required: ['path'],
        },
        handler: async (args: { path: string; message?: string }) => {
          try {
            // Resolve relative paths against workspace
            const resolved = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(workDir, args.path);
            // Resolve symlinks to prevent traversal via symlink targets
            let realPath: string;
            try {
              realPath = fs.realpathSync(resolved);
            } catch {
              return { content: 'File not found.' };
            }
            // Validate the real file path is within workspace or allowed paths
            const allowed = [workDir, ...allowPaths];
            const isAllowed = allowed.some(dir => realPath.startsWith(path.resolve(dir) + path.sep) || realPath === path.resolve(dir));
            if (!isAllowed) {
              log.warn(`send_file blocked: "${realPath}" is outside workspace for channel ${channelId.slice(0, 8)}...`);
              return { content: 'File path is outside the allowed workspace. Only files within your workspace can be sent.' };
            }
            await handler(channelId, realPath, args.message);
            return { content: `File sent: ${path.basename(realPath)}` };
          } catch (err: any) {
            log.error(`send_file failed for channel ${channelId.slice(0, 8)}...:`, err);
            return { content: `Failed to send file: ${err?.message ?? 'unknown error'}` };
          }
        },
      });
    }

    // Show file contents in chat (renamed from show_file — CLI doesn't support overridesBuiltInTool yet)
    if (this.getAdapterForChannel) {
      const adapterResolver = this.getAdapterForChannel;
      const showWorkDir = this.resolveWorkingDirectory(channelId);
      const showBotName = getChannelBotName(channelId);
      const showConfig = getChannelConfig(channelId);
      const showAllowPaths = getWorkspaceAllowPaths(showBotName, showConfig.platform);

      tools.push({
        name: 'show_file_in_chat',
        description: 'Show file contents to the user in their chat channel as a formatted code block. Prefer this over the built-in show_file which only works in terminal. Use when the user asks to see a file, code snippet, or diff. Supports optional line range. For diffs, set diff: true to show pending git changes.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Full absolute path to the file to show.' },
            view_range: {
              type: 'array', items: { type: 'integer' },
              description: 'Optional [start, end] line range. [start, -1] shows from start to end of file.',
            },
            diff: { type: 'boolean', description: 'When true, show pending git diff instead of file contents.' },
          },
          required: ['path'],
        },
        handler: async (args: { path: string; view_range?: number[]; diff?: boolean }) => {
          try {
            const resolved = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(showWorkDir, args.path);
            let realPath: string;
            try {
              realPath = fs.realpathSync(resolved);
            } catch {
              return { content: 'File not found.' };
            }
            const allowed = [showWorkDir, ...showAllowPaths];
            const isAllowed = allowed.some(dir => realPath.startsWith(path.resolve(dir) + path.sep) || realPath === path.resolve(dir));
            if (!isAllowed) {
              log.warn(`show_file blocked: "${realPath}" is outside workspace for channel ${channelId.slice(0, 8)}...`);
              return { content: 'File path is outside the allowed workspace.' };
            }

            const adapter = adapterResolver(channelId);
            if (!adapter) return { content: 'No adapter available for this channel.' };

            const ext = path.extname(realPath).slice(1) || 'txt';
            const fileName = path.basename(realPath);
            let content: string;

            if (args.diff) {
              const { execFileSync } = await import('node:child_process');
              const dir = path.dirname(realPath);
              try {
                content = execFileSync('git', ['diff', '--', realPath], { cwd: dir, encoding: 'utf-8', timeout: 5000 });
                if (!content.trim()) content = '(no pending changes)';
              } catch {
                content = '(not a git repository or git diff failed)';
              }
              await adapter.sendMessage(channelId, `**${fileName}** (diff)\n\`\`\`\`diff\n${content}\n\`\`\`\``);
            } else {
              const fullContent = fs.readFileSync(realPath, 'utf-8');
              let lines = fullContent.split('\n');

              if (args.view_range && args.view_range.length === 2) {
                const [start, end] = args.view_range;
                const startIdx = Math.max(0, start - 1);
                const endIdx = end === -1 ? lines.length : Math.min(end, lines.length);
                lines = lines.slice(startIdx, endIdx);
              }

              content = lines.join('\n');
              const MAX_CHARS = 8000;
              let truncated = false;
              if (content.length > MAX_CHARS) {
                content = content.slice(0, MAX_CHARS);
                truncated = true;
              }

              // Use 4-backtick fence to avoid breaking if content contains ```
              const rangeLabel = args.view_range ? ` (lines ${args.view_range[0]}–${args.view_range[1] === -1 ? 'end' : args.view_range[1]})` : '';
              let msg = `**${fileName}**${rangeLabel}\n\`\`\`\`${ext}\n${content}\n\`\`\`\``;
              if (truncated) msg += '\n*(truncated — file too large for chat)*';
              await adapter.sendMessage(channelId, msg);
            }

            return { content: `Showed ${fileName} to user in chat.` };
          } catch (err: any) {
            log.error(`show_file failed for channel ${channelId.slice(0, 8)}...:`, err);
            return { content: `Failed to show file: ${err?.message ?? 'unknown error'}` };
          }
        },
      });
    }

    // Admin-only onboarding tools
    const config = getChannelConfig(channelId);
    const botName = getChannelBotName(channelId);
    const isAdmin = isBotAdmin(config.platform, botName);

    if (isAdmin && this.getAdapterForChannel) {
      const adapterResolver = this.getAdapterForChannel;

      // Tool: get_platform_info — returns available teams, bots, and defaults
      tools.push({
        name: 'get_platform_info',
        description: 'Get information about the bridge platform: available teams, bot names, and defaults. Use this when onboarding a new project to present options to the user.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          try {
            const adapter = adapterResolver(channelId);
            if (!adapter?.getTeams) return { content: 'Platform does not support team listing.' };

            const teams = await adapter.getTeams();
            const appConfig = getConfig();
            const platformConfig = appConfig.platforms[config.platform];
            const botNames = platformConfig.bots ? Object.keys(platformConfig.bots) : ['default'];

            return {
              content: JSON.stringify({
                teams: teams.map(t => ({ id: t.id, name: t.name, displayName: t.displayName })),
                bots: botNames,
                defaults: {
                  model: appConfig.defaults.model,
                  triggerMode: appConfig.defaults.triggerMode,
                  threadedReplies: appConfig.defaults.threadedReplies,
                },
              }, null, 2),
            };
          } catch (err: any) {
            return { content: `Error: ${err?.message ?? 'unknown'}` };
          }
        },
      });

      // Tool: create_project — full onboarding orchestration
      tools.push({
        name: 'create_project',
        description: 'Create a new project: set up a Mattermost channel, assign a bot, initialize the workspace, and optionally clone a git repo. The channel is immediately active after creation. Use get_platform_info first to get team IDs and available bots.',
        parameters: {
          type: 'object',
          properties: {
            project_name: { type: 'string', description: 'Human-readable project name (e.g., "Widget API"). Will be slugified for the channel name.' },
            bot_name: { type: 'string', description: 'Bot to assign (e.g., "copilot", "bob"). Must be a configured bot name.' },
            team_id: { type: 'string', description: 'Mattermost team ID (from get_platform_info).' },
            private: { type: 'boolean', description: 'Create a private channel. Ask the user: private or public?' },
            workspace_path: { type: 'string', description: 'Workspace directory path. Ask the user — default is ~/.copilot-bridge/workspaces/<project-slug>/.' },
            repo_url: { type: 'string', description: 'Git repository URL to clone into the workspace. Optional — skip for new projects.' },
            user_id: { type: 'string', description: 'Mattermost user ID of the requesting user, to add them to the channel.' },
            trigger_mode: { type: 'string', enum: ['all', 'mention'], description: 'How the bot responds. Ask the user: "all" (every message) or "mention" (only when @mentioned).' },
            threaded_replies: { type: 'boolean', description: 'Whether the bot replies in threads. Ask the user: yes or no.' },
          },
          required: ['project_name', 'bot_name', 'team_id', 'private', 'workspace_path', 'trigger_mode', 'threaded_replies'],
        },
        handler: async (args: {
          project_name: string;
          bot_name: string;
          team_id: string;
          private: boolean;
          workspace_path: string;
          repo_url?: string;
          user_id?: string;
          trigger_mode: 'all' | 'mention';
          threaded_replies: boolean;
        }) => {
          try {
            const adapter = adapterResolver(channelId);
            if (!adapter) return { content: 'Error: No adapter available for this channel.' };

            const result = await onboardProject(adapter, {
              projectName: args.project_name,
              botName: args.bot_name,
              platform: config.platform,
              teamId: args.team_id,
              private: args.private,
              workspacePath: args.workspace_path,
              repoUrl: args.repo_url,
              userId: args.user_id ?? this.lastMessageUserIds.get(channelId),
              triggerMode: args.trigger_mode,
              threadedReplies: args.threaded_replies,
            });

            return {
              content: [
                `✅ Project "${args.project_name}" created:`,
                ...result.steps.map(s => `  - ${s}`),
                '',
                `Channel: #${result.channelName}`,
                `Workspace: ${result.workspacePath}`,
                result.cloned ? `Repo cloned: ${args.repo_url}` : '',
              ].filter(Boolean).join('\n'),
            };
          } catch (err: any) {
            log.error(`create_project failed:`, err);
            return { content: `Failed to create project: ${err?.message ?? 'unknown error'}` };
          }
        },
      });

      // Tool: grant_path_access — add an extra allowed path for an agent
      tools.push({
        name: 'grant_path_access',
        description: 'Grant an agent read/write access to an additional folder beyond its workspace. Updates the workspace_overrides table in SQLite.',
        parameters: {
          type: 'object',
          properties: {
            bot_name: { type: 'string', description: 'The bot/agent name (e.g., "inbox", "bob").' },
            path: { type: 'string', description: 'Absolute path to the folder to grant access to.' },
          },
          required: ['bot_name', 'path'],
        },
        handler: async (args: { bot_name: string; path: string }) => {
          try {
            const existing = getWorkspaceOverride(args.bot_name);
            const workDir = existing?.workingDirectory ?? getWorkspacePath(args.bot_name);
            const currentPaths = existing?.allowPaths ?? [];
            const resolvedPath = path.resolve(args.path);

            // Block sensitive paths (bidirectional: parent-of or child-of blocked)
            const home = os.homedir();
            const blocked = [home, path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.gnupg'),
              path.join(home, '.copilot-bridge'), '/etc', '/var', '/usr', '/System', '/private'];
            if (resolvedPath === '/') {
              return { content: '❌ Refused: cannot grant access to filesystem root.' };
            }
            for (const b of blocked) {
              if (resolvedPath === b || b.startsWith(resolvedPath + path.sep) || resolvedPath.startsWith(b + path.sep)) {
                return { content: `❌ Refused: "${resolvedPath}" overlaps with sensitive directory "${b}". Grant a more specific, non-sensitive subdirectory instead.` };
              }
            }

            if (currentPaths.includes(resolvedPath)) {
              return { content: `"${args.bot_name}" already has access to ${resolvedPath}.` };
            }
            const newPaths = [...currentPaths, resolvedPath];
            setWorkspaceOverride(args.bot_name, workDir, newPaths);
            return {
              content: `✅ Granted "${args.bot_name}" access to ${resolvedPath}.\nCurrent allowed paths: ${JSON.stringify(newPaths)}\n\nTo apply: delete the agent's AGENTS.md and run /new in its channel (or restart the bridge).`,
            };
          } catch (err: any) {
            return { content: `Failed: ${err?.message ?? 'unknown error'}` };
          }
        },
      });

      // Tool: revoke_path_access — remove an allowed path from an agent
      tools.push({
        name: 'revoke_path_access',
        description: 'Remove an extra allowed folder from an agent. Does not affect its workspace directory.',
        parameters: {
          type: 'object',
          properties: {
            bot_name: { type: 'string', description: 'The bot/agent name.' },
            path: { type: 'string', description: 'Absolute path to revoke access from.' },
          },
          required: ['bot_name', 'path'],
        },
        handler: async (args: { bot_name: string; path: string }) => {
          try {
            const existing = getWorkspaceOverride(args.bot_name);
            if (!existing) return { content: `No workspace override found for "${args.bot_name}".` };
            const resolvedPath = path.resolve(args.path);
            const newPaths = existing.allowPaths.filter(p => path.resolve(p) !== resolvedPath);
            setWorkspaceOverride(args.bot_name, existing.workingDirectory, newPaths);
            return {
              content: `✅ Revoked "${args.bot_name}" access to ${resolvedPath}.\nRemaining allowed paths: ${JSON.stringify(newPaths)}\n\nTo apply: delete the agent's AGENTS.md and run /new in its channel (or restart the bridge).`,
            };
          } catch (err: any) {
            return { content: `Failed: ${err?.message ?? 'unknown error'}` };
          }
        },
      });

      // Tool: list_agent_access — show workspace info for all agents
      tools.push({
        name: 'list_agent_access',
        description: 'List all agents and their workspace paths and extra allowed folders.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          try {
            const overrides = listWorkspaceOverrides();
            const overrideMap = new Map(overrides.map(o => [o.botName, o]));

            // Enumerate all configured bots across platforms
            const config = getConfig();
            const botNames = new Set<string>();
            for (const platform of Object.values(config.platforms)) {
              if (platform.bots) {
                for (const name of Object.keys(platform.bots)) botNames.add(name);
              }
            }
            // Include any bots that have overrides but aren't in config
            for (const o of overrides) botNames.add(o.botName);

            if (botNames.size === 0) return { content: 'No agents configured.' };

            const lines = [...botNames].sort().map(name => {
              const override = overrideMap.get(name);
              const workspace = override?.workingDirectory ?? getWorkspacePath(name);
              const extra = override?.allowPaths ?? [];
              return `**${name}**\n  Workspace: ${workspace}\n  Extra paths: ${extra.length > 0 ? extra.join(', ') : '(none)'}`;
            });
            return { content: lines.join('\n\n') };
          } catch (err: any) {
            return { content: `Failed: ${err?.message ?? 'unknown error'}` };
          }
        },
      });
    }

    // Inter-agent tool: ask_agent (only when enabled in config)
    const iaConfig = getInterAgentConfig();
    if (iaConfig.enabled) {
      tools.push(this.buildAskAgentToolDef(channelId));
    }

    // Scheduler tool: create/list/cancel/pause/resume scheduled tasks
    tools.push(this.buildScheduleToolDef(channelId));

    // Bridge documentation tool
    tools.push(this.buildBridgeDocsTool(channelId));

    if (tools.length > 0) {
      log.info(`Built ${tools.length} custom tool(s) for channel ${channelId.slice(0, 8)}...`);
    }
    return tools;
  }

  /** Build the schedule tool definition for creating/managing scheduled tasks. */
  private buildScheduleToolDef(channelId: string): any {
    const botName = getChannelBotName(channelId);

    return {
      name: 'schedule',
      description: 'Create, list, cancel, pause, or resume scheduled tasks. Tasks fire at the specified time and send a prompt to the LLM for processing. Supports cron expressions for recurring tasks and ISO datetimes for one-off tasks.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel', 'pause', 'resume'],
            description: 'The action to perform.',
          },
          prompt: {
            type: 'string',
            description: 'The prompt to send when the job fires. Required for "create".',
          },
          cron: {
            type: 'string',
            description: 'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" for weekdays at 9am). Use standard 5-field cron syntax.',
          },
          run_at: {
            type: 'string',
            description: 'ISO 8601 datetime for one-off tasks. IMPORTANT: current_datetime is UTC — use a Z suffix (e.g., "2026-03-09T22:31:00Z") or properly convert to local time before adding an offset. Do NOT take the UTC hour and attach a non-UTC offset. Mutually exclusive with cron.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone for display and cron scheduling (e.g., "America/Los_Angeles"). Defaults to UTC.',
          },
          description: {
            type: 'string',
            description: 'Human-readable label for the task.',
          },
          id: {
            type: 'string',
            description: 'Task ID. Required for cancel/pause/resume.',
          },
        },
        required: ['action'],
      },
      handler: async (args: {
        action: string;
        prompt?: string;
        cron?: string;
        run_at?: string;
        timezone?: string;
        description?: string;
        id?: string;
      }) => {
        try {
          switch (args.action) {
            case 'create': {
              if (!args.prompt) return { content: 'Error: prompt is required for create.' };
              if (!args.cron && !args.run_at) return { content: 'Error: either cron or run_at is required.' };
              const task = addJob({
                channelId,
                botName,
                prompt: args.prompt,
                cronExpr: args.cron,
                runAt: args.run_at,
                timezone: args.timezone,
                description: args.description,
                createdBy: this.lastMessageUserIds.get(channelId),
              });
              const type = task.cronExpr ? `recurring (${task.cronExpr})` : `one-off (${task.runAt})`;
              const tz = task.timezone ?? 'UTC';
              const nextRunLocal = task.nextRun ? formatInTimezone(task.nextRun, tz) : undefined;
              return { content: JSON.stringify({ success: true, id: task.id, type, nextRun: nextRunLocal, timezone: tz, description: task.description }) };
            }
            case 'list': {
              const tasks = listJobs(channelId);
              if (tasks.length === 0) return { content: 'No scheduled tasks for this channel.' };
              const summary = tasks.map(t => {
                const tz = t.timezone ?? 'UTC';
                return {
                  id: t.id,
                  description: t.description ?? t.prompt.slice(0, 60),
                  type: t.cronExpr ? 'recurring' : 'one-off',
                  schedule: t.cronExpr ?? t.runAt,
                  timezone: tz,
                  enabled: t.enabled,
                  lastRun: t.lastRun ? formatInTimezone(t.lastRun, tz) : undefined,
                  nextRun: t.nextRun ? formatInTimezone(t.nextRun, tz) : undefined,
                };
              });
              return { content: JSON.stringify(summary) };
            }
            case 'cancel': {
              if (!args.id) return { content: 'Error: id is required for cancel.' };
              const removed = removeJob(args.id, channelId);
              return { content: removed ? `Task ${args.id} cancelled and removed.` : `Task ${args.id} not found.` };
            }
            case 'pause': {
              if (!args.id) return { content: 'Error: id is required for pause.' };
              const paused = pauseJob(args.id, channelId);
              return { content: paused ? `Task ${args.id} paused.` : `Task ${args.id} not found.` };
            }
            case 'resume': {
              if (!args.id) return { content: 'Error: id is required for resume.' };
              const resumed = resumeJob(args.id, channelId);
              return { content: resumed ? `Task ${args.id} resumed.` : `Task ${args.id} not found or failed to resume.` };
            }
            default:
              return { content: `Unknown action: ${args.action}. Use create, list, cancel, pause, or resume.` };
          }
        } catch (err: any) {
          return { content: `Schedule error: ${err?.message ?? 'unknown error'}` };
        }
      },
    };
  }

  private buildBridgeDocsTool(channelId: string): any {
    const channelConfig = getChannelConfig(channelId);
    const botName = getChannelBotName(channelId);
    const isAdmin = isBotAdmin(channelConfig.platform, botName);

    return {
      name: 'fetch_copilot_bridge_documentation',
      description: 'Fetch documentation about copilot-bridge capabilities, commands, configuration, and system status. Use this when you need to understand bridge features, help users with commands, troubleshoot issues, or check system status. Call with a specific topic to get focused information. If the documentation doesn\'t fully answer your question, each topic includes source code pointers for deeper investigation.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['overview', 'commands', 'config', 'mcp', 'permissions', 'workspaces', 'hooks', 'skills', 'inter-agent', 'scheduling', 'troubleshooting', 'status'],
            description: "Topic to query. 'overview' = what the bridge is and key features. 'commands' = common slash commands. 'config' = configuration options. 'mcp' = MCP server setup. 'permissions' = permission system. 'workspaces' = workspace structure. 'hooks' = tool hooks. 'skills' = skill discovery. 'inter-agent' = bot-to-bot communication. 'scheduling' = task scheduling. 'troubleshooting' = common issues. 'status' = live system state.",
          },
        },
        required: [],
      },
      handler: async (args: { topic?: string }) => {
        const sessionInfo = this.getSessionInfo(channelId);
        return {
          content: getBridgeDocs({
            topic: args.topic,
            isAdmin,
            channelId,
            model: sessionInfo?.model,
            sessionId: sessionInfo?.sessionId,
          }),
        };
      },
    };
  }

  private attachSessionEvents(session: CopilotSession, channelId: string): void {
    const unsub = session.on((event: any) => {
      if (event.type === 'session.usage_info' && event.data) {
        this.contextUsage.set(channelId, {
          currentTokens: event.data.currentTokens,
          tokenLimit: event.data.tokenLimit,
        });
      }
      this.eventHandler?.(session.sessionId, channelId, event);
    });
    this.sessionUnsubscribes.set(session.sessionId, unsub);
  }

  private handlePermissionRequest(
    channelId: string,
    request: any,
    invocation: { sessionId: string },
  ): Promise<any> {
    const prefs = this.getEffectivePrefs(channelId);

    // Hardcoded safety denies — checked before autopilot, cannot be overridden
    const reqKind = (request as any).kind;
    const reqCommand = typeof (request as any).fullCommandText === 'string' ? (request as any).fullCommandText
      : typeof (request as any).command === 'string' ? (request as any).command : undefined;
    if (isHardDeny(reqKind, reqCommand)) {
      return Promise.resolve({ kind: 'denied-by-rules' });
    }

    // Auto-approve bridge custom tools (they enforce their own workspace boundaries)
    if (reqKind === 'custom-tool') {
      const reqToolName = (request as any).toolName;
      if (BRIDGE_CUSTOM_TOOLS.includes(reqToolName)) {
        return Promise.resolve({ kind: 'approved' });
      }
    }

    // Autopilot mode: allow everything (after safety checks)
    if (prefs.permissionMode === 'autopilot') {
      return Promise.resolve({ kind: 'approved' });
    }

    // Check config-level permission rules first (CLI-compatible syntax)
    const config = getChannelConfig(channelId);
    const botName = getChannelBotName(channelId);
    const resolvedDir = this.resolveWorkingDirectory(channelId);
    const workspaceAllowPaths = getWorkspaceAllowPaths(botName, config.platform);
    const configResult = evaluateConfigPermissions(request as any, resolvedDir, workspaceAllowPaths, isBotAdmin(config.platform, botName));
    if (configResult === 'allow') {
      return Promise.resolve({ kind: 'approved' });
    }
    if (configResult === 'deny') {
      return Promise.resolve({ kind: 'denied-by-rules' });
    }

    // Check stored permission rules (SQLite, from /remember)
    log.debug(`Permission request:`, JSON.stringify(request).slice(0, 500));
    const kind = (request as any).kind ?? 'unknown';
    const serverName = (request as any).serverName as string | undefined;
    // Build a descriptive tool name from kind + available fields
    const toolName = (request as any).toolName ?? (request as any).tool_name ?? (request as any).name ?? kind;
    const toolInput = request.input ?? (request as any).arguments ?? (request as any).parameters ?? request;
    const commands = extractCommandPatterns(toolInput);

    // For MCP tools, check server-level rules first (covers all tools on that server)
    if (kind === 'mcp' && serverName) {
      const serverResult = checkPermission(channelId, `mcp:${serverName}`, '*');
      if (serverResult === 'allow') {
        log.debug(`MCP "${serverName}" auto-approved by stored rule`);
        return Promise.resolve({ kind: 'approved' });
      }
      if (serverResult === 'deny') {
        log.debug(`MCP "${serverName}" denied by stored rule`);
        return Promise.resolve({ kind: 'denied-by-rules' });
      }
    }

    if (commands.length > 0) {
      const results = commands.map(cmd => checkPermission(channelId, toolName, cmd));
      if (results.every(r => r === 'allow')) {
        const hasWrapper = commands.some(cmd => SHELL_WRAPPERS.has(cmd));
        if (!hasWrapper) {
          return Promise.resolve({ kind: 'approved' });
        }
      }
      if (results.some(r => r === 'deny')) {
        return Promise.resolve({ kind: 'denied-by-rules' });
      }
    } else {
      const result = checkPermission(channelId, toolName, '*');
      if (result === 'allow') return Promise.resolve({ kind: 'approved' });
      if (result === 'deny') return Promise.resolve({ kind: 'denied-by-rules' });
    }

    // No rule matched — need to ask the user via chat
    return new Promise((resolve) => {
      const entry: PendingPermission = {
        sessionId: invocation.sessionId,
        channelId,
        toolName,
        serverName,
        toolInput: toolInput,
        commands,
        resolve,
        createdAt: Date.now(),
      };

      let queue = this.pendingPermissions.get(channelId);
      if (!queue) {
        queue = [];
        this.pendingPermissions.set(channelId, queue);
      }
      queue.push(entry);

      // Only emit the event if this is the first (active) item in the queue
      if (queue.length === 1) {
        this.eventHandler?.(invocation.sessionId, channelId, {
          type: 'bridge.permission_request',
          data: {
            toolName,
            serverName,
            input: toolInput,
            commands,
          },
        });
      }
    });
  }

  private handleUserInputRequest(
    channelId: string,
    request: { question: string; choices?: string[]; allowFreeform?: boolean },
    invocation: { sessionId: string },
  ): Promise<{ answer: string; wasFreeform: boolean }> {
    return new Promise((resolve) => {
      const entry: PendingUserInput = {
        sessionId: invocation.sessionId,
        channelId,
        question: request.question,
        choices: request.choices,
        allowFreeform: request.allowFreeform,
        resolve,
        createdAt: Date.now(),
      };

      let queue = this.pendingUserInput.get(channelId);
      if (!queue) {
        queue = [];
        this.pendingUserInput.set(channelId, queue);
      }
      queue.push(entry);

      // Only emit the event if this is the first (active) item in the queue
      if (queue.length === 1) {
        this.eventHandler?.(invocation.sessionId, channelId, {
          type: 'bridge.user_input_request',
          data: {
            question: request.question,
            choices: request.choices,
            allowFreeform: request.allowFreeform,
          },
        });
      }
    });
  }

  async shutdown(): Promise<void> {
    // Resolve all pending permissions (deny them on shutdown)
    for (const [, queue] of this.pendingPermissions) {
      for (const pending of queue) {
        pending.resolve({ kind: 'denied-interactively-by-user' });
      }
    }
    this.pendingPermissions.clear();

    // Resolve all pending user inputs (empty answer on shutdown)
    for (const [, queue] of this.pendingUserInput) {
      for (const pending of queue) {
        pending.resolve({ answer: '', wasFreeform: false });
      }
    }
    this.pendingUserInput.clear();

    // Unsubscribe all session event listeners
    for (const [, unsub] of this.sessionUnsubscribes) {
      unsub();
    }
    this.sessionUnsubscribes.clear();

    // Release all sessions (don't destroy — they persist in CLI)
    for (const [channelId, sessionId] of this.channelSessions) {
      this.bridge.releaseSession(sessionId);
    }
    this.channelSessions.clear();
    this.sessionChannels.clear();
  }
}
