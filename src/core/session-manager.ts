import { CopilotSession, approveAll } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';
import {
  getChannelSession, setChannelSession, clearChannelSession,
  getChannelPrefs, setChannelPrefs, checkPermission, addPermissionRule,
  type ChannelPrefs,
} from '../state/store.js';
import { getChannelConfig, evaluateConfigPermissions } from '../config.js';
import { createLogger } from '../logger.js';
import type {
  ChannelAdapter, InboundMessage, PendingPermission, PendingUserInput,
} from '../types.js';

const log = createLogger('session');

type SessionEventHandler = (sessionId: string, channelId: string, event: any) => void;

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

export class SessionManager {
  private bridge: CopilotBridge;
  private channelSessions = new Map<string, string>(); // channelId → sessionId
  private sessionChannels = new Map<string, string>(); // sessionId → channelId (reverse)
  private sessionUnsubscribes = new Map<string, () => void>(); // sessionId → unsubscribe fn
  private eventHandler: SessionEventHandler | null = null;

  // Pending permission requests (queue per channel to avoid overwrites)
  private pendingPermissions = new Map<string, PendingPermission[]>();
  // Pending user input requests (queue per channel to avoid overwrites)
  private pendingUserInput = new Map<string, PendingUserInput[]>();

  constructor(bridge: CopilotBridge) {
    this.bridge = bridge;
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

  /** Resolve a pending permission request (first in queue). */
  resolvePermission(channelId: string, allow: boolean, remember?: boolean): boolean {
    const queue = this.pendingPermissions.get(channelId);
    if (!queue || queue.length === 0) return false;

    const pending = queue.shift()!;

    if (remember && pending.commands.length > 0) {
      const action = allow ? 'allow' : 'deny';
      for (const cmd of pending.commands) {
        addPermissionRule(channelId, pending.toolName, cmd, action as 'allow' | 'deny');
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

  // --- Private helpers ---

  private async createNewSession(channelId: string): Promise<string> {
    const config = getChannelConfig(channelId);
    const prefs = this.getEffectivePrefs(channelId);

    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;

    const reasoningEffort = prefs.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;

    const session = await this.bridge.createSession({
      model: prefs.model,
      workingDirectory: config.workingDirectory,
      configDir: defaultConfigDir,
      reasoningEffort: reasoningEffort ?? undefined,
      onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
      onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
    });

    const sessionId = session.sessionId;
    this.channelSessions.set(channelId, sessionId);
    this.sessionChannels.set(sessionId, channelId);
    setChannelSession(channelId, sessionId);

    this.attachSessionEvents(session, channelId);

    log.info(`Created session ${sessionId} for channel ${channelId}`);
    return sessionId;
  }

  private async attachSession(channelId: string, sessionId: string): Promise<void> {
    const config = getChannelConfig(channelId);
    const prefs = this.getEffectivePrefs(channelId);
    const defaultConfigDir = process.env.HOME ? `${process.env.HOME}/.copilot` : undefined;
    const reasoningEffort = prefs.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;

    const session = await this.bridge.resumeSession(sessionId, {
      onPermissionRequest: (request, invocation) => this.handlePermissionRequest(channelId, request, invocation),
      onUserInputRequest: (request, invocation) => this.handleUserInputRequest(channelId, request, invocation),
      configDir: defaultConfigDir,
      workingDirectory: config.workingDirectory,
      reasoningEffort: reasoningEffort ?? undefined,
    });

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
    const configResult = evaluateConfigPermissions(request as any, config.workingDirectory);
    if (configResult === 'allow') {
      return Promise.resolve({ kind: 'approved' });
    }
    if (configResult === 'deny') {
      return Promise.resolve({ kind: 'denied-by-rules' });
    }

    // Check stored permission rules (SQLite, from /remember)
    log.debug(`Permission request:`, JSON.stringify(request).slice(0, 500));
    const kind = (request as any).kind ?? 'unknown';
    // Build a descriptive tool name from kind + available fields
    const toolName = (request as any).toolName ?? (request as any).tool_name ?? (request as any).name ?? kind;
    const toolInput = request.input ?? (request as any).arguments ?? (request as any).parameters ?? request;
    const commands = extractCommandPatterns(toolInput);

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
