/**
 * hooks-loader.ts — Discover and load session hooks from plugins, user config, and workspace.
 *
 * Hooks are declared in hooks.json files that map hook types to JS/TS handler modules.
 * Multiple hooks.json files are merged: later sources can override earlier ones.
 *
 * Discovery order (lowest → highest priority):
 *   1. Plugin hooks:    ~/.copilot/installed-plugins/.../hooks.json
 *   2. User hooks:      ~/.copilot/hooks.json
 *   3. Workspace hooks: <workspace>/.github/hooks.json, <workspace>/hooks.json
 *
 * hooks.json format:
 * {
 *   "hooks": {
 *     "onPreToolUse": "./hooks/audit.js",
 *     "onPostToolUse": "./hooks/redact.js",
 *     "onSessionStart": "./hooks/init.js"
 *   }
 * }
 *
 * Each handler module must export a default function matching the SDK hook signature.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('hooks');

// SDK types not re-exported from package root
export interface SessionHooks {
  onPreToolUse?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
  onPostToolUse?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
  onUserPromptSubmitted?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
  onSessionStart?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
  onSessionEnd?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
  onErrorOccurred?: (input: any, invocation: { sessionId: string }) => Promise<any> | any;
}

const VALID_HOOK_TYPES = new Set<keyof SessionHooks>([
  'onPreToolUse',
  'onPostToolUse',
  'onUserPromptSubmitted',
  'onSessionStart',
  'onSessionEnd',
  'onErrorOccurred',
]);

export interface LoadHooksOptions {
  /** Include hooks from workspace hooks.json files (default: false for security) */
  allowWorkspaceHooks?: boolean;
}

/**
 * Discover all hooks.json files in priority order (lowest first).
 */
function discoverHooksFiles(workingDirectory: string, options?: LoadHooksOptions): { file: string; baseDir: string }[] {
  const home = process.env.HOME;
  const results: { file: string; baseDir: string }[] = [];

  // 1. Plugin hooks (lowest priority)
  if (home) {
    const pluginsDir = path.join(home, '.copilot', 'installed-plugins');
    if (fs.existsSync(pluginsDir)) {
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === 'hooks.json') {
              results.push({ file: full, baseDir: dir });
            } else if (entry.isDirectory()) {
              walk(full, depth + 1);
            }
          }
        } catch { /* permission errors */ }
      };
      walk(pluginsDir, 0);
    }
  }

  // 2. User hooks
  if (home) {
    const userHooks = path.join(home, '.copilot', 'hooks.json');
    if (fs.existsSync(userHooks)) {
      results.push({ file: userHooks, baseDir: path.join(home, '.copilot') });
    }
  }

  // 3. Workspace hooks (only if explicitly allowed — executes arbitrary code)
  if (options?.allowWorkspaceHooks) {
    const wsGithub = path.join(workingDirectory, '.github', 'hooks.json');
    if (fs.existsSync(wsGithub)) {
      results.push({ file: wsGithub, baseDir: path.join(workingDirectory, '.github') });
    }
    const wsRoot = path.join(workingDirectory, 'hooks.json');
    if (fs.existsSync(wsRoot)) {
      results.push({ file: wsRoot, baseDir: workingDirectory });
    }
  }

  return results;
}

/**
 * Parse a hooks.json file and return validated hook type → module path mappings.
 */
function parseHooksConfig(filePath: string, baseDir: string): Map<keyof SessionHooks, string> {
  const mappings = new Map<keyof SessionHooks, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hooks = raw.hooks ?? raw;
    if (typeof hooks !== 'object' || hooks === null) {
      log.warn(`Invalid hooks.json format: ${filePath}`);
      return mappings;
    }

    for (const [hookType, modulePath] of Object.entries(hooks)) {
      if (!VALID_HOOK_TYPES.has(hookType as keyof SessionHooks)) {
        log.warn(`Unknown hook type "${hookType}" in ${filePath}, skipping`);
        continue;
      }
      if (typeof modulePath !== 'string') {
        log.warn(`Invalid module path for "${hookType}" in ${filePath}, skipping`);
        continue;
      }
      const resolved = path.resolve(baseDir, modulePath);
      if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        log.warn(`Hook module path "${modulePath}" escapes base directory in ${filePath}, skipping`);
        continue;
      }
      mappings.set(hookType as keyof SessionHooks, resolved);
    }
  } catch (err) {
    log.warn(`Failed to parse ${filePath}: ${err}`);
  }
  return mappings;
}

/**
 * Dynamically import a hook handler module.
 * Expects the module to export a default function.
 */
async function loadHookHandler(modulePath: string, hookType: string): Promise<((...args: any[]) => any) | null> {
  try {
    if (!fs.existsSync(modulePath)) {
      log.warn(`Hook module not found: ${modulePath} (${hookType})`);
      return null;
    }
    const mod = await import(pathToFileURL(modulePath).href);
    const handler = mod.default ?? mod[hookType];
    if (typeof handler !== 'function') {
      log.warn(`Hook module ${modulePath} does not export a function for ${hookType}`);
      return null;
    }
    return handler;
  } catch (err) {
    log.warn(`Failed to load hook module ${modulePath}: ${err}`);
    return null;
  }
}

/**
 * Discover and load all hooks for a given workspace.
 * Returns a merged SessionHooks object ready to pass to the SDK, or undefined if no hooks found.
 */
export async function loadHooks(workingDirectory: string, options?: LoadHooksOptions): Promise<SessionHooks | undefined> {
  const files = discoverHooksFiles(workingDirectory, options);
  if (files.length === 0) return undefined;

  // Merge configs: later files override earlier (higher priority wins)
  const merged = new Map<keyof SessionHooks, string>();
  for (const { file, baseDir } of files) {
    const config = parseHooksConfig(file, baseDir);
    for (const [hookType, modulePath] of config) {
      merged.set(hookType, modulePath);
    }
    log.debug(`Loaded hooks config from ${file} (${config.size} hook(s))`);
  }

  if (merged.size === 0) return undefined;

  // Load all handler modules in parallel
  const hooks: SessionHooks = {};
  const loadPromises = [...merged.entries()].map(async ([hookType, modulePath]) => {
    const handler = await loadHookHandler(modulePath, hookType);
    if (handler) {
      (hooks as any)[hookType] = handler;
      log.info(`Registered ${hookType} hook from ${modulePath}`);
    }
  });
  await Promise.all(loadPromises);

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

export interface HookInfo {
  hookType: string;
  source: 'plugin' | 'user' | 'workspace';
  modulePath: string;
}

/**
 * Return metadata about configured hooks without loading handler modules.
 * Used by /tools to show which hooks are active.
 */
export function getHooksInfo(workingDirectory: string, options?: LoadHooksOptions): HookInfo[] {
  const files = discoverHooksFiles(workingDirectory, options);
  if (files.length === 0) return [];

  const home = process.env.HOME ?? '';
  const merged = new Map<string, { modulePath: string; source: 'plugin' | 'user' | 'workspace' }>();

  for (const { file, baseDir } of files) {
    const config = parseHooksConfig(file, baseDir);
    const normalized = file.split(path.sep).join('/');
    let source: 'plugin' | 'user' | 'workspace' = 'user';
    if (normalized.includes('installed-plugins')) source = 'plugin';
    else if (home && normalized.startsWith(home.split(path.sep).join('/') + '/.copilot/hooks.json')) source = 'user';
    else source = 'workspace';

    for (const [hookType, modulePath] of config) {
      merged.set(hookType, { modulePath, source });
    }
  }

  return [...merged.entries()]
    .map(([hookType, { source, modulePath }]) => ({ hookType, source, modulePath }))
    .sort((a, b) => a.hookType.localeCompare(b.hookType));
}

/**
 * Merge two SessionHooks objects. The override hooks take precedence.
 */
export function mergeHooks(base: SessionHooks | undefined, override: SessionHooks | undefined): SessionHooks | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}
