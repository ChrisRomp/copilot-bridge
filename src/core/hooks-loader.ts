/**
 * hooks-loader.ts — Discover and load session hooks from plugins, user config, and workspace.
 *
 * Uses the official CLI hooks.json format:
 * {
 *   "version": 1,
 *   "hooks": {
 *     "preToolUse": [
 *       { "type": "command", "bash": "./scripts/guard.sh", "cwd": ".", "timeoutSec": 10 }
 *     ]
 *   }
 * }
 *
 * Hooks are shell commands. Input is piped as JSON to stdin, output read from stdout.
 * Multiple hooks per type run in sequence; for preToolUse, first "deny" wins.
 *
 * Discovery order (lowest → highest priority, later entries append):
 *   1. Plugin hooks:    ~/.copilot/installed-plugins/.../hooks.json
 *   2. User hooks:      ~/.copilot/hooks.json
 *   3. Workspace hooks: <workspace>/.github/hooks/hooks.json, <workspace>/hooks.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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

/** CLI hook type names → SDK SessionHooks keys */
const HOOK_TYPE_MAP: Record<string, keyof SessionHooks> = {
  preToolUse: 'onPreToolUse',
  postToolUse: 'onPostToolUse',
  userPromptSubmitted: 'onUserPromptSubmitted',
  sessionStart: 'onSessionStart',
  sessionEnd: 'onSessionEnd',
  errorOccurred: 'onErrorOccurred',
};

const VALID_HOOK_TYPES = new Set(Object.keys(HOOK_TYPE_MAP));

/** A single hook command entry from hooks.json */
export interface HookCommand {
  type: 'command';
  bash?: string;
  powershell?: string;
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}

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
    const wsGithubHooks = path.join(workingDirectory, '.github', 'hooks', 'hooks.json');
    if (fs.existsSync(wsGithubHooks)) {
      results.push({ file: wsGithubHooks, baseDir: path.join(workingDirectory, '.github', 'hooks') });
    }
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
 * Parse a hooks.json file and return validated hook commands per type.
 */
function parseHooksConfig(filePath: string): Map<string, HookCommand[]> {
  const result = new Map<string, HookCommand[]>();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hooks = raw.hooks;
    if (typeof hooks !== 'object' || hooks === null) {
      log.warn(`Invalid hooks.json format (missing "hooks" key): ${filePath}`);
      return result;
    }

    for (const [hookType, commands] of Object.entries(hooks)) {
      if (!VALID_HOOK_TYPES.has(hookType)) {
        log.warn(`Unknown hook type "${hookType}" in ${filePath}, skipping`);
        continue;
      }
      if (!Array.isArray(commands)) {
        log.warn(`Hook type "${hookType}" must be an array in ${filePath}, skipping`);
        continue;
      }
      const valid: HookCommand[] = [];
      for (const cmd of commands) {
        if (cmd.type !== 'command' || (!cmd.bash && !cmd.powershell)) {
          log.warn(`Invalid hook command for "${hookType}" in ${filePath}, skipping`);
          continue;
        }
        valid.push(cmd);
      }
      if (valid.length > 0) {
        result.set(hookType, valid);
      }
    }
  } catch (err) {
    log.warn(`Failed to parse ${filePath}: ${err}`);
  }
  return result;
}

/**
 * Execute a hook command by spawning a shell process.
 * Input is piped as JSON to stdin, output parsed from stdout.
 */
function executeHookCommand(cmd: HookCommand, input: any, baseDir: string): any | undefined {
  const shell = cmd.bash ? 'bash' : 'powershell';
  const script = cmd.bash ?? cmd.powershell!;
  const cwd = cmd.cwd ? path.resolve(baseDir, cmd.cwd) : baseDir;
  const timeoutMs = (cmd.timeoutSec ?? 30) * 1000;

  try {
    const stdout = execFileSync(shell, ['-c', script], {
      input: JSON.stringify(input),
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, ...cmd.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const trimmed = stdout.trim();
    if (!trimmed) return undefined;

    return JSON.parse(trimmed);
  } catch (err: any) {
    if (err.killed) {
      log.warn(`Hook command timed out after ${cmd.timeoutSec ?? 30}s: ${script}`);
    } else {
      log.warn(`Hook command failed: ${script} — ${err.message ?? err}`);
    }
    return undefined;
  }
}

/**
 * Build a SessionHooks callback that runs all commands for a given hook type.
 * For preToolUse, first "deny" decision short-circuits.
 */
function buildHookCallback(
  hookType: string,
  allCommands: { cmd: HookCommand; baseDir: string }[],
): (input: any, invocation: { sessionId: string }) => any {
  return (input: any, _invocation: { sessionId: string }) => {
    log.debug(`Hook callback invoked: ${hookType} (${allCommands.length} command(s)), tool=${input.toolName ?? 'n/a'}`);
    let mergedResult: any = undefined;

    for (const { cmd, baseDir } of allCommands) {
      const result = executeHookCommand(cmd, input, baseDir);
      if (!result) continue;

      if (!mergedResult) {
        mergedResult = result;
      } else {
        Object.assign(mergedResult, result);
      }

      // For preToolUse, a deny short-circuits
      if (hookType === 'preToolUse' && result.permissionDecision === 'deny') {
        return mergedResult;
      }
    }

    return mergedResult;
  };
}

/**
 * Discover and load all hooks for a given workspace.
 * Returns a SessionHooks object ready to pass to the SDK, or undefined if no hooks found.
 */
export async function loadHooks(workingDirectory: string, options?: LoadHooksOptions): Promise<SessionHooks | undefined> {
  const files = discoverHooksFiles(workingDirectory, options);
  if (files.length === 0) return undefined;

  // Collect all commands per hook type across all files (all sources append)
  const commandsByType = new Map<string, { cmd: HookCommand; baseDir: string }[]>();

  for (const { file, baseDir } of files) {
    const config = parseHooksConfig(file);
    for (const [hookType, commands] of config) {
      const existing = commandsByType.get(hookType) ?? [];
      for (const cmd of commands) {
        existing.push({ cmd, baseDir });
      }
      commandsByType.set(hookType, existing);
    }
    log.debug(`Loaded hooks config from ${file} (${config.size} hook type(s))`);
  }

  if (commandsByType.size === 0) return undefined;

  const hooks: SessionHooks = {};
  for (const [hookType, commands] of commandsByType) {
    const sdkKey = HOOK_TYPE_MAP[hookType];
    if (!sdkKey) continue;
    (hooks as any)[sdkKey] = buildHookCallback(hookType, commands);
    log.info(`Registered ${hookType} hook (${commands.length} command(s))`);
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

export interface HookInfo {
  hookType: string;
  source: 'plugin' | 'user' | 'workspace';
  commandCount: number;
}

/**
 * Return metadata about configured hooks without executing them.
 * Used by /tools to show which hooks are active.
 */
export function getHooksInfo(workingDirectory: string, options?: LoadHooksOptions): HookInfo[] {
  const files = discoverHooksFiles(workingDirectory, options);
  if (files.length === 0) return [];

  const home = process.env.HOME ?? '';
  // Accumulate command counts per hook type per source
  const info = new Map<string, { source: 'plugin' | 'user' | 'workspace'; commandCount: number }>();

  for (const { file } of files) {
    const config = parseHooksConfig(file);
    const normalized = file.split(path.sep).join('/');
    let source: 'plugin' | 'user' | 'workspace' = 'user';
    if (normalized.includes('installed-plugins')) source = 'plugin';
    else if (home && normalized.includes(home.split(path.sep).join('/') + '/.copilot/')) source = 'user';
    else source = 'workspace';

    for (const [hookType, commands] of config) {
      const existing = info.get(hookType);
      if (existing) {
        existing.commandCount += commands.length;
        // Higher-priority source wins for display
        existing.source = source;
      } else {
        info.set(hookType, { source, commandCount: commands.length });
      }
    }
  }

  return [...info.entries()]
    .map(([hookType, { source, commandCount }]) => ({ hookType, source, commandCount }))
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
