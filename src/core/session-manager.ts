import { CopilotSession, approveAll } from '@github/copilot-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotBridge } from './bridge.js';
import {
  getChannelSession, setChannelSession, clearChannelSession,
  getChannelPrefs, setChannelPrefs, checkPermission, addPermissionRule,
  getWorkspaceOverride, setWorkspaceOverride, listWorkspaceOverrides,
  type ChannelPrefs,
} from '../state/store.js';
import { getChannelConfig, getChannelBotName, evaluateConfigPermissions, isBotAdmin, getConfig } from '../config.js';
import { getWorkspacePath, getWorkspaceAllowPaths, ensureWorkspacesDir } from './workspace-manager.js';
import { onboardProject } from './onboarding.js';
import { createLogger } from '../logger.js';
import type { McpServerInfo } from './command-handler.js';
import type {
  ChannelAdapter, InboundMessage, PendingPermission, PendingUserInput,
} from '../types.js';

const log = createLogger('session');

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
 * - <workspace>/.github/skills/ (project-level)
 * - <workspace>/.agents/skills/ (project-level, legacy)
 */
function discoverSkillDirectories(workingDirectory: string): string[] {
  const home = process.env.HOME;
  const roots: string[] = [];

  // User-level skills
  if (home) roots.push(path.join(home, '.copilot', 'skills'));
  // Project-level skills (standard)
  roots.push(path.join(workingDirectory, '.github', 'skills'));
  // Project-level skills (legacy)
  roots.push(path.join(workingDirectory, '.agents', 'skills'));

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
  private lastMessageUserIds = new Map<string, string>(); // channelId → userId of last message sender
  // Handler for send_file tool (set by index.ts, calls adapter.sendFile)
  private sendFileHandler: ((channelId: string, filePath: string, message?: string) => Promise<string>) | null = null;
  private getAdapterForChannel: ((channelId: string) => ChannelAdapter | null) | null = null;

  constructor(bridge: CopilotBridge) {
    this.bridge = bridge;
    this.mcpServers = loadMcpServers();
    ensureWorkspacesDir();
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

    // Clone global servers and inject workspace .env into local ones
    const merged: Record<string, any> = {};
    for (const [name, config] of Object.entries(this.mcpServers)) {
      const serverConfig = { ...(config as any) };
      const isLocal = !serverConfig.type || serverConfig.type === 'local' || serverConfig.type === 'stdio';
      if (isLocal && Object.keys(workspaceEnv).length > 0) {
        serverConfig.env = { ...workspaceEnv, ...(serverConfig.env || {}) };
      }
      merged[name] = serverConfig;
    }

    if (Object.keys(workspaceServers).length === 0) return merged;
    return { ...merged, ...workspaceServers };
  }

  /** Get annotated MCP server info for a channel, showing which layer each server came from. */
  getMcpServerInfo(channelId: string): McpServerInfo[] {
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const { servers: workspaceServers } = loadWorkspaceMcpServers(workingDirectory);
    const globalNames = new Set(Object.keys(this.mcpServers));

    const result: McpServerInfo[] = [];

    // All global servers — mark workspace overrides accordingly
    for (const name of globalNames) {
      if (name in workspaceServers) {
        result.push({ name, source: 'workspace (override)' });
      } else {
        result.push({ name, source: 'global' });
      }
    }

    // Workspace-only servers (not in global)
    for (const name of Object.keys(workspaceServers)) {
      if (!globalNames.has(name)) {
        result.push({ name, source: 'workspace' });
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
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
        this.bridge.destroySession(existingId);
      } catch { /* best-effort */ }
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
      this.contextUsage.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
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

    // Detach event listeners and release the bridge handle
    const unsub = this.sessionUnsubscribes.get(existingId);
    if (unsub) { unsub(); this.sessionUnsubscribes.delete(existingId); }
    this.bridge.releaseSession(existingId);

    // Re-attach the same session (re-reads workspace config, AGENTS.md, MCP, etc.)
    this.contextUsage.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
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
      this.lastMessageUserIds.delete(channelId);
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
      this.bridge.releaseSession(existingId);
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
      this.contextUsage.delete(channelId);
      this.lastMessageUserIds.delete(channelId);
    }

    // If target session is active on another channel, release it first
    const otherChannel = this.sessionChannels.get(targetSessionId);
    if (otherChannel) {
      const unsub = this.sessionUnsubscribes.get(targetSessionId);
      if (unsub) { unsub(); this.sessionUnsubscribes.delete(targetSessionId); }
      this.bridge.releaseSession(targetSessionId);
      this.channelSessions.delete(otherChannel);
      this.sessionChannels.delete(targetSessionId);
      this.contextUsage.delete(otherChannel);
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

      // Try to reconnect to the same session (CLI subprocess may have restarted)
      try {
        log.info(`Attempting to re-attach session ${sessionId}...`);
        this.bridge.releaseSession(sessionId);
        const unsub = this.sessionUnsubscribes.get(sessionId);
        if (unsub) { unsub(); this.sessionUnsubscribes.delete(sessionId); }
        await this.attachSession(channelId, sessionId);
        const reconnected = this.bridge.getSession(sessionId);
        if (reconnected) {
          log.info(`Re-attached session ${sessionId} successfully`);
          return reconnected.send(sendOpts);
        }
      } catch (retryErr: any) {
        log.warn(`Re-attach failed:`, retryErr?.message ?? retryErr);
      }

      // Last resort: create a new session
      log.info(`Creating new session for channel ${channelId}...`);
      const newSessionId = await this.newSession(channelId);
      const newSession = this.bridge.getSession(newSessionId);
      if (!newSession) throw new Error(`New session ${newSessionId} not found`);
      return newSession.send(sendOpts);
    }
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
  }

  /** Switch the agent for a channel's session. */
  async switchAgent(channelId: string, agent: string | null): Promise<void> {
    const sessionId = this.channelSessions.get(channelId);
    if (sessionId) {
      try {
        if (agent) {
          await this.bridge.selectAgent(sessionId, agent);
        } else {
          await this.bridge.deselectAgent(sessionId);
        }
      } catch (err) {
        log.warn(`RPC agent switch failed:`, err);
      }
    }
    setChannelPrefs(channelId, { agent });
  }

  /** Get effective preferences for a channel (config merged with runtime overrides). */
  getEffectivePrefs(channelId: string): ChannelPrefs & { model: string; verbose: boolean; threadedReplies: boolean; permissionMode: string; triggerMode: 'mention' | 'all' } {
    const configChannel = getChannelConfig(channelId);
    const storedPrefs = getChannelPrefs(channelId);
    return {
      model: storedPrefs?.model ?? configChannel.model ?? 'claude-sonnet-4.6',
      agent: storedPrefs?.agent !== undefined ? storedPrefs.agent : configChannel.agent,
      verbose: storedPrefs?.verbose ?? configChannel.verbose,
      triggerMode: configChannel.triggerMode,
      threadedReplies: storedPrefs?.threadedReplies ?? configChannel.threadedReplies,
      permissionMode: storedPrefs?.permissionMode ?? configChannel.permissionMode,
      reasoningEffort: storedPrefs?.reasoningEffort ?? (configChannel as any).reasoningEffort ?? null,
    };
  }

  /** Get model info (for checking capabilities like reasoning effort). */
  async getModelInfo(modelId: string): Promise<any | null> {
    try {
      const models = await this.bridge.listModels();
      return models.find(m => m.id === modelId) ?? null;
    } catch {
      return null;
    }
  }

  /** List all available models. */
  async listModels(): Promise<any[]> {
    return this.bridge.listModels();
  }

  /** Resolve a pending permission request (first in queue). */
  resolvePermission(channelId: string, allow: boolean, remember?: boolean): boolean {
    const queue = this.pendingPermissions.get(channelId);
    if (!queue || queue.length === 0) return false;

    const pending = queue.shift()!;

    if (remember) {
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
  getContextUsage(channelId: string): { currentTokens: number; tokenLimit: number } | null {
    return this.contextUsage.get(channelId) ?? null;
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

    const session = await withWorkspaceEnv(workingDirectory, () =>
      this.bridge.createSession({
        model: prefs.model,
        workingDirectory,
        configDir: defaultConfigDir,
        reasoningEffort: reasoningEffort ?? undefined,
        mcpServers: this.resolveMcpServers(workingDirectory),
        skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
        onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
        onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
        tools: customTools.length > 0 ? customTools : undefined,
      })
    );

    const sessionId = session.sessionId;
    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    setChannelSession(channelId, sessionId);

    this.attachSessionEvents(session, channelId);

    log.info(`Created session ${sessionId} for channel ${channelId}`);
    return sessionId;
  }

  private async attachSession(channelId: string, sessionId: string): Promise<void> {
    const prefs = this.getEffectivePrefs(channelId);
    const workingDirectory = this.resolveWorkingDirectory(channelId);
    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;
    const reasoningEffort = prefs.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    const skillDirectories = discoverSkillDirectories(workingDirectory);
    const customTools = this.buildCustomTools(channelId);

    const session = await withWorkspaceEnv(workingDirectory, () =>
      this.bridge.resumeSession(sessionId, {
        onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
        onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
        configDir: defaultConfigDir,
        workingDirectory,
        reasoningEffort: reasoningEffort ?? undefined,
        mcpServers: this.resolveMcpServers(workingDirectory),
        skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
        tools: customTools.length > 0 ? customTools : undefined,
      })
    );

    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    this.attachSessionEvents(session, channelId);
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

    if (tools.length > 0) {
      log.info(`Built ${tools.length} custom tool(s) for channel ${channelId.slice(0, 8)}...`);
    }
    return tools;
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

    // Autopilot mode: allow everything
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
