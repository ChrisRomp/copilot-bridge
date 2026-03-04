import { CopilotSession, approveAll } from '@github/copilot-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CopilotBridge } from './bridge.js';
import {
  getChannelSession, setChannelSession, clearChannelSession,
  getChannelPrefs, setChannelPrefs, checkPermission, addPermissionRule,
  getWorkspaceOverride,
  type ChannelPrefs,
} from '../state/store.js';
import { getChannelConfig, getChannelBotName, evaluateConfigPermissions, isBotAdmin } from '../config.js';
import { getWorkspacePath, getWorkspaceAllowPaths, ensureWorkspacesDir } from './workspace-manager.js';
import { createLogger } from '../logger.js';
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
  if (Object.keys(vars).length === 0) return fn();

  // Serialize access to process.env
  const prev = envLock;
  let release: () => void;
  envLock = new Promise(resolve => { release = resolve; });

  await prev;

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

  // Ensure all servers have a tools field (SDK requires it)
  for (const [name, config] of Object.entries(servers)) {
    if (!(config as any).tools) {
      (config as any).tools = ['*'];
    }
  }

  const count = Object.keys(servers).length;
  if (count > 0) {
    log.info(`Loaded ${count} MCP server(s): ${Object.keys(servers).join(', ')}`);
  }

  return servers;
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
  private mcpServers: Record<string, any>;

  // Pending permission requests (queue per channel to avoid overwrites)
  private pendingPermissions = new Map<string, PendingPermission[]>();
  // Pending user input requests (queue per channel to avoid overwrites)
  private pendingUserInput = new Map<string, PendingUserInput[]>();

  constructor(bridge: CopilotBridge) {
    this.bridge = bridge;
    this.mcpServers = loadMcpServers();
    ensureWorkspacesDir();
  }

  /** Register a handler for session events (streaming, tool calls, etc.) */
  onSessionEvent(handler: SessionEventHandler): void {
    this.eventHandler = handler;
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
    try {
      await this.attachSession(channelId, existingId);
      log.info(`Reloaded session ${existingId} for channel ${channelId}`);
      return existingId;
    } catch (err: any) {
      // Session no longer exists server-side (e.g., workspace was deleted and re-created)
      log.warn(`Stale session ${existingId} for channel ${channelId}: ${err?.message ?? err}. Creating new session.`);
      this.channelSessions.delete(channelId);
      this.sessionChannels.delete(existingId);
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
    }

    // If target session is active on another channel, release it first
    const otherChannel = this.sessionChannels.get(targetSessionId);
    if (otherChannel) {
      const unsub = this.sessionUnsubscribes.get(targetSessionId);
      if (unsub) { unsub(); this.sessionUnsubscribes.delete(targetSessionId); }
      this.bridge.releaseSession(targetSessionId);
      this.channelSessions.delete(otherChannel);
      this.sessionChannels.delete(targetSessionId);
      clearChannelSession(otherChannel);
    }

    // Attach to the target session
    try {
      await this.attachSession(channelId, targetSessionId);
    } catch (err: any) {
      log.warn(`Session ${targetSessionId} not found: ${err?.message ?? err}. Creating new session.`);
      return this.createNewSession(channelId);
    }
    setChannelSession(channelId, targetSessionId);
    log.info(`Resumed session ${targetSessionId} for channel ${channelId}`);
    return targetSessionId;
  }

  /** Send a message to a channel's session. Returns immediately; responses come via events. */
  async sendMessage(channelId: string, text: string): Promise<string> {
    // Auto-deny any pending permissions so the session unblocks
    this.clearPendingPermissions(channelId);

    const { sessionId } = await this.ensureSession(channelId);
    const session = this.bridge.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found after ensure`);

    try {
      const messageId = await session.send({ prompt: text });
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
          return reconnected.send({ prompt: text });
        }
      } catch (retryErr: any) {
        log.warn(`Re-attach failed:`, retryErr?.message ?? retryErr);
      }

      // Last resort: create a new session
      log.info(`Creating new session for channel ${channelId}...`);
      const newSessionId = await this.newSession(channelId);
      const newSession = this.bridge.getSession(newSessionId);
      if (!newSession) throw new Error(`New session ${newSessionId} not found`);
      return newSession.send({ prompt: text });
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
  getEffectivePrefs(channelId: string): ChannelPrefs & { model: string } {
    const configChannel = getChannelConfig(channelId);
    const storedPrefs = getChannelPrefs(channelId);
    return {
      model: storedPrefs?.model ?? configChannel.model ?? 'claude-sonnet-4.6',
      agent: storedPrefs?.agent !== undefined ? storedPrefs.agent : configChannel.agent,
      verbose: storedPrefs?.verbose ?? configChannel.verbose,
      triggerMode: storedPrefs?.triggerMode ?? configChannel.triggerMode,
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

    const session = await withWorkspaceEnv(workingDirectory, () =>
      this.bridge.createSession({
        model: prefs.model,
        workingDirectory,
        configDir: defaultConfigDir,
        reasoningEffort: reasoningEffort ?? undefined,
        mcpServers: this.mcpServers,
        skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
        onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
        onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
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

    const session = await withWorkspaceEnv(workingDirectory, () =>
      this.bridge.resumeSession(sessionId, {
        onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
        onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
        configDir: defaultConfigDir,
        workingDirectory,
        reasoningEffort: reasoningEffort ?? undefined,
        mcpServers: this.mcpServers,
        skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
      })
    );

    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    this.attachSessionEvents(session, channelId);
  }

  private attachSessionEvents(session: CopilotSession, channelId: string): void {
    const unsub = session.on((event: any) => {
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
