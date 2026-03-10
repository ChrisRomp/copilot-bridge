import { loadConfig, getConfig, isConfiguredChannel, registerDynamicChannel, markChannelAsDM, getChannelConfig, getPlatformBots, getChannelBotName, isBotAdmin, getHardcodedRules, getConfigRules, reloadConfig, ConfigWatcher } from './config.js';
import { CopilotBridge } from './core/bridge.js';
import { SessionManager, BRIDGE_CUSTOM_TOOLS } from './core/session-manager.js';
import { handleCommand, parseCommand } from './core/command-handler.js';
import { formatEvent, formatPermissionRequest, formatUserInputRequest } from './core/stream-formatter.js';
import { WorkspaceWatcher, initWorkspace, getWorkspacePath } from './core/workspace-manager.js';
import { MattermostAdapter } from './channels/mattermost/adapter.js';
import { StreamingHandler } from './channels/mattermost/streaming.js';
import { getChannelPrefs, getAllChannelSessions, closeDb, listPermissionRulesForScope, removePermissionRule, clearPermissionRules } from './state/store.js';
import { extractThreadRequest, resolveThreadRoot } from './core/thread-utils.js';
import { initScheduler, stopAll as stopScheduler, listJobs, removeJob, pauseJob, resumeJob, formatInTimezone, describeCron } from './core/scheduler.js';
import { markBusy, markIdle, markIdleImmediate, isBusy, waitForChannelIdle, cancelIdleDebounce } from './core/channel-idle.js';
import { LoopDetector } from './core/loop-detector.js';
import { getTaskHistory } from './state/store.js';
import { createLogger } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelAdapter, AdapterFactory, InboundMessage, InboundReaction, MessageAttachment } from './types.js';

const log = createLogger('bridge');

// Active streaming responses, keyed by channelId
const activeStreams = new Map<string, string>(); // channelId → streamKey

// Track channels where the initial "Working..." has been posted (reset on new user message)
const initialStreamPosted = new Set<string>();

// Activity feed: a single edit-in-place message accumulating tool call lines per channel
const activityFeeds = new Map<string, {
  messageId: string;
  lines: string[];
  updateTimer: ReturnType<typeof setTimeout> | null;
}>();
const ACTIVITY_THROTTLE_MS = 600;

// Per-channel promise chain to serialize message handling
const channelLocks = new Map<string, Promise<void>>();

// Per-channel promise chain to serialize SESSION EVENT handling (prevents race on auto-start)
const eventLocks = new Map<string, Promise<void>>();

// Channels with an active startup nudge in flight (NO_REPLY filter only applies here)
const nudgePending = new Set<string>();

// Bot adapters keyed by "platform:botName" for channel→adapter lookup
const botAdapters = new Map<string, ChannelAdapter>();
const botStreamers = new Map<string, StreamingHandler>();

// Per-channel tool call loop detection
const loopDetector = new LoopDetector();
/** Format a date as a relative age string (e.g., "2h ago", "3d ago"). */
function formatAge(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Sanitize a filename to prevent path traversal — strips directory separators and .. sequences. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
}

/** Download message attachments to .temp/<channelId>/ in the bot's workspace, returning SDK-compatible attachment objects. */
async function downloadAttachments(
  attachments: MessageAttachment[] | undefined,
  channelId: string,
  adapter: ChannelAdapter,
): Promise<Array<{ type: 'file'; path: string; displayName?: string }>> {
  if (!attachments || attachments.length === 0) return [];

  const botName = getChannelBotName(channelId);
  const workspace = getWorkspacePath(botName);
  const tempDir = path.join(workspace, '.temp', channelId);

  const results: Array<{ type: 'file'; path: string; displayName?: string }> = [];
  for (const att of attachments) {
    try {
      const safeName = sanitizeFilename(att.name);
      const destPath = path.join(tempDir, `${att.id}-${safeName}`);
      // Verify resolved path is still within tempDir
      if (!path.resolve(destPath).startsWith(path.resolve(tempDir) + path.sep)) {
        log.warn(`Attachment "${att.name}" resolved outside temp dir, skipping`);
        continue;
      }
      await adapter.downloadFile(att.id, destPath);
      results.push({ type: 'file', path: destPath, displayName: att.name });
      log.info(`Downloaded attachment "${att.name}" (${att.type}) for channel ${channelId.slice(0, 8)}...`);
    } catch (err) {
      log.warn(`Failed to download attachment "${att.name}":`, err);
    }
  }
  return results;
}

/** Remove temp files for a specific channel's temp directory. */
function cleanupTempFiles(channelId: string): void {
  try {
    const botName = getChannelBotName(channelId);
    const tempDir = path.join(getWorkspacePath(botName), '.temp', channelId);
    if (!fs.existsSync(tempDir)) return;

    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch { /* best effort */ }
    }
    // Remove the now-empty channel temp directory
    try { fs.rmdirSync(tempDir); } catch { /* best effort */ }
    if (files.length > 0) {
      log.info(`Cleaned up ${files.length} temp file(s) for ${channelId.slice(0, 8)}...`);
    }
  } catch { /* best effort */ }
}

function getAdapterForChannel(channelId: string): { adapter: ChannelAdapter; streaming: StreamingHandler } | null {
  const channelConfig = getChannelConfig(channelId);
  const botName = getChannelBotName(channelId);
  const key = `${channelConfig.platform}:${botName}`;
  const adapter = botAdapters.get(key);
  const streaming = botStreamers.get(key);
  if (!adapter || !streaming) return null;
  return { adapter, streaming };
}

async function main(): Promise<void> {
  log.info('copilot-bridge starting...');

  // Load configuration
  const config = loadConfig();
  log.info(`Loaded ${config.channels.length} channel mapping(s)`);

  // Start config file watcher for hot-reload
  const configWatcher = new ConfigWatcher();
  configWatcher.onReload((result) => {
    if (!result.success) return;
    if (result.restartNeeded.length > 0) {
      // Notify admin channels about restart-needed changes
      for (const [key, adapter] of botAdapters) {
        const botName = key.slice(key.indexOf(':') + 1);
        if (isBotAdmin(key.slice(0, key.indexOf(':')), botName)) {
          for (const ch of getConfig().channels) {
            if (ch.bot === botName && !ch.isDM) {
              const warnings = result.restartNeeded.map(r => `  ⚠️ ${r}`).join('\n');
              adapter.sendMessage(ch.id, `**Config reloaded** with changes that need a restart:\n${warnings}`).catch(() => {});
              break; // one admin channel is enough
            }
          }
        }
      }
    }
  });
  configWatcher.start();

  // Initialize Copilot SDK bridge
  const bridge = new CopilotBridge();
  await bridge.start();
  log.info('Copilot SDK connected');

  // Initialize session manager
  const sessionManager = new SessionManager(bridge);

  // Initialize workspaces for all configured bots (idempotent)
  for (const [platformName] of Object.entries(config.platforms)) {
    const bots = getPlatformBots(platformName);
    for (const [botName] of bots) {
      initWorkspace(botName);
    }
  }

  // Watch for new workspace directories
  const workspaceWatcher = new WorkspaceWatcher();
  workspaceWatcher.onEvent((event) => {
    if (event.type === 'created') {
      initWorkspace(event.botName);
      log.info(`Workspace ready for "${event.botName}" — channel registration will occur on first message`);
    } else if (event.type === 'removed') {
      log.warn(`Workspace removed for "${event.botName}" — existing sessions will continue but workspace files are gone`);
    }
  });
  workspaceWatcher.start();

  // Adapter factories — register built-in adapters here
  const adapterFactories: Record<string, AdapterFactory> = {
    mattermost: (name, url, token) => new MattermostAdapter(name, url, token),
  };

  // Initialize channel adapters — one per bot identity
  for (const [platformName, platformConfig] of Object.entries(config.platforms)) {
    const factory = adapterFactories[platformName];
    if (!factory) {
      log.warn(`No adapter for platform "${platformName}" — skipping`);
      continue;
    }
    const bots = getPlatformBots(platformName);
    for (const [botName, botInfo] of bots) {
      const key = `${platformName}:${botName}`;
      const adapter = factory(platformName, platformConfig.url, botInfo.token);
      botAdapters.set(key, adapter);
      botStreamers.set(key, new StreamingHandler(adapter));
      log.info(`Registered bot "${botName}" for ${platformName}`);
    }
  }

  // Wire up session events → streaming output (serialized per channel)
  sessionManager.onSessionEvent((sessionId, channelId, event) => {
    const prev = eventLocks.get(channelId) ?? Promise.resolve();
    const next = prev.then(() =>
      handleSessionEvent(channelId, event, sessionManager)
        .catch(err => log.error(`Unhandled error in event handler:`, err))
    );
    eventLocks.set(channelId, next);
  });

  // Wire up send_file tool → adapter.sendFile (with thread context)
  sessionManager.onSendFile(async (channelId, filePath, message) => {
    const resolved = getAdapterForChannel(channelId);
    if (!resolved) throw new Error('No adapter for channel');
    // Preserve thread context if threaded replies are active
    const streamKey = activeStreams.get(channelId);
    const threadRootId = streamKey ? resolved.streaming.getStreamThreadRootId(streamKey) : undefined;
    return resolved.adapter.sendFile(channelId, filePath, message, { threadRootId });
  });

  // Provide adapter resolver for onboarding tools
  sessionManager.onGetAdapter((channelId) => {
    const resolved = getAdapterForChannel(channelId);
    return resolved?.adapter ?? null;
  });

  // Connect all bot adapters and wire up handlers
  for (const [key, adapter] of botAdapters) {
    const streaming = botStreamers.get(key)!;
    const colonIdx = key.indexOf(':');
    const platformName = key.slice(0, colonIdx);
    const botName = key.slice(colonIdx + 1);

    adapter.onMessage((msg) => {
      // If the channel is mid-turn, try steering (immediate mode) instead of serializing
      if (isBusy(msg.channelId)) {
        handleMidTurnMessage(msg, sessionManager, platformName, botName)
          .catch(err => {
            // Expected fallbacks — debug level
            const expected = err?.message === 'slash-command-while-busy' || err?.message === 'file-only-while-busy';
            if (expected) {
              log.debug(`Mid-turn fallback (${err.message}), routing to normal handler`);
            } else {
              log.warn(`Mid-turn send failed, falling back to queued handler:`, err);
            }
            // Fall back to normal serialized path
            const prev = channelLocks.get(msg.channelId) ?? Promise.resolve();
            const next = prev.then(() =>
              handleInboundMessage(msg, sessionManager, platformName, botName)
                .catch(e => log.error(`Unhandled error in message handler:`, e))
            );
            channelLocks.set(msg.channelId, next);
          });
        return;
      }
      const prev = channelLocks.get(msg.channelId) ?? Promise.resolve();
      const next = prev.then(() =>
        handleInboundMessage(msg, sessionManager, platformName, botName)
          .catch(err => log.error(`Unhandled error in message handler:`, err))
      );
      channelLocks.set(msg.channelId, next);
    });
    adapter.onReaction((reaction) => handleReaction(reaction, sessionManager));

    await adapter.connect();
    log.info(`${key} connected`);

    // Discover existing DM channels and auto-register any that aren't configured
    if (typeof adapter.discoverDMChannels === 'function') {
      const dmChannels = await adapter.discoverDMChannels();
      let registered = 0;
      for (const dm of dmChannels) {
        if (!isConfiguredChannel(dm.channelId)) {
          const workspacePath = getWorkspacePath(botName);
          initWorkspace(botName);
          registerDynamicChannel({
            id: dm.channelId,
            platform: platformName,
            bot: botName,
            name: `DM (auto-discovered @${botName})`,
            workingDirectory: workspacePath,
            triggerMode: 'all',
            threadedReplies: false,
            verbose: false,
            isDM: true,
          });
          registered++;
          log.info(`Auto-registered DM channel ${dm.channelId.slice(0, 8)}... for bot "${botName}"`);
        } else {
          // Mark pre-configured DM channels so nudge logic can identify them
          markChannelAsDM(dm.channelId);
        }
      }
      log.info(`${botName}: discovered ${dmChannels.length} DM(s), ${registered} newly registered`);
    }
  }

  log.info('copilot-bridge ready!');

  // Initialize scheduler — rehydrate persisted jobs
  initScheduler({
    sendMessage: async (channelId, prompt) => {
      // Route through channelLocks to serialize with user messages
      const prev = channelLocks.get(channelId) ?? Promise.resolve();
      const task = prev.then(async () => {
        const resolved = getAdapterForChannel(channelId);
        if (resolved) {
          const { streaming } = resolved;
          // Atomically swap streams via eventLocks to prevent event interleaving
          const evPrev = eventLocks.get(channelId) ?? Promise.resolve();
          const evTask = evPrev.then(async () => {
            const existingStream = activeStreams.get(channelId);
            if (existingStream) {
              await streaming.finalizeStream(existingStream);
              activeStreams.delete(channelId);
            }
            const streamKey = await streaming.startStream(channelId);
            activeStreams.set(channelId, streamKey);
          });
          eventLocks.set(channelId, evTask.catch(() => {}));
          await evTask;
          markBusy(channelId);
        }
        try {
          await sessionManager.sendMessage(channelId, prompt);
          // Hold the lock until the response is fully streamed
          await waitForChannelIdle(channelId);
        } catch (err: any) {
          log.error(`Scheduled job sendMessage failed for ${channelId.slice(0, 8)}...:`, err);
          markIdleImmediate(channelId);
          const failedStream = activeStreams.get(channelId);
          if (failedStream) {
            const r = getAdapterForChannel(channelId);
            if (r) await r.streaming.cancelStream(failedStream, err?.message ?? 'Scheduled job failed').catch(() => {});
            activeStreams.delete(channelId);
          }
          throw err;
        }
      });
      channelLocks.set(channelId, task.catch(() => {}));
      await task;
      return '';
    },
    postMessage: async (channelId, text) => {
      const resolved = getAdapterForChannel(channelId);
      if (resolved) {
        await resolved.adapter.sendMessage(channelId, text);
      }
    },
  });

  // Nudge admin bot sessions that may have been mid-task before restart
  nudgeAdminSessions(sessionManager).catch(err =>
    log.error('Admin nudge failed:', err)
  );

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    stopScheduler();
    configWatcher.stop();
    workspaceWatcher.stop();
    await sessionManager.shutdown();
    for (const [, adapter] of botAdapters) {
      await adapter.disconnect();
    }
    for (const [, streaming] of botStreamers) {
      await streaming.cleanup();
    }
    await bridge.stop();
    closeDb();
    log.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// --- Message Handling ---

/** Strip the bot's own @mention from message text, keeping other mentions intact. */
function stripBotMention(text: string, botName: string | undefined): string {
  if (!botName) return text;
  return text.replace(new RegExp(`@\\S+`, 'g'), (match) => {
    if (match === `@${botName}`) return '';
    return match;
  }).trim();
}

/** Handle a message that arrives while the session is mid-turn (steering via immediate mode). */
async function handleMidTurnMessage(
  msg: InboundMessage,
  sessionManager: SessionManager,
  platformName: string,
  botName: string,
): Promise<void> {
  // Ignore messages from any bot we manage on this platform
  for (const [key, a] of botAdapters) {
    if (key.startsWith(`${platformName}:`) && msg.userId === a.getBotUserId()) return;
  }

  if (!isConfiguredChannel(msg.channelId)) return;

  const assignedBot = getChannelBotName(msg.channelId);
  if (assignedBot && assignedBot !== botName) return;

  const resolved = getAdapterForChannel(msg.channelId);
  if (!resolved) return;
  const { adapter } = resolved;

  const channelConfig = getChannelConfig(msg.channelId);

  // Respect trigger mode — don't steer on unmentioned messages in mention-only channels
  if (channelConfig.triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) return;

  const text = stripBotMention(msg.text, channelConfig.bot);
  if (!text && !msg.attachments?.length) return;

  // Pending user input — resolve directly (bypasses channelLock to avoid deadlock
  // since the lock is held by waitForChannelIdle which needs this to resolve first)
  if (sessionManager.hasPendingUserInput(msg.channelId)) {
    sessionManager.resolveUserInput(msg.channelId, text);
    return;
  }

  // Pending permission — resolve directly for the same reason.
  // Must be checked BEFORE the general slash-command throw so /approve, /deny,
  // /remember can resolve the permission instead of deadlocking on channelLocks.
  if (sessionManager.hasPendingPermission(msg.channelId)) {
    const lower = text.toLowerCase();
    if (lower === '/approve' || lower === 'yes' || lower === 'y' || lower === 'approve') {
      sessionManager.resolvePermission(msg.channelId, true);
      return;
    }
    if (lower === '/deny' || lower === 'no' || lower === 'n' || lower === 'deny') {
      sessionManager.resolvePermission(msg.channelId, false);
      return;
    }
    if (lower === '/remember') {
      sessionManager.resolvePermission(msg.channelId, true, true);
      return;
    }
    // Other slash commands and unrecognized text while permission pending — ignore.
    // They can't be queued on channelLocks (deadlock) and the permission must be resolved first.
    return;
  }

  // Slash commands while busy: handle safe ones immediately, defer the rest
  // Extract thread request first so 🧵 doesn't pollute command parsing
  const threadExtract = extractThreadRequest(text);
  const commandText = threadExtract.text;

  if (commandText.startsWith('/')) {
    const parsed = parseCommand(commandText);
    if (!parsed) {
      throw new Error('slash-command-while-busy');
    }

    const channelConfig = getChannelConfig(msg.channelId);
    const threadRoot = resolveThreadRoot(msg, threadExtract.threadRequested, channelConfig);

    // Commands that MUST run immediately (abort/cancel current work)
    // markIdleImmediate is called AFTER cleanup to prevent queued messages from
    // starting a new stream while cancel/abort is still in flight.
    if (parsed.command === 'stop' || parsed.command === 'cancel') {
      const stopStreamKey = activeStreams.get(msg.channelId);
      if (stopStreamKey) {
        await resolved.streaming.cancelStream(stopStreamKey);
        activeStreams.delete(msg.channelId);
      }
      await finalizeActivityFeed(msg.channelId, adapter);
      await sessionManager.abortSession(msg.channelId);
      markIdleImmediate(msg.channelId);
      await adapter.sendMessage(msg.channelId, '🛑 Task stopped.', { threadRootId: threadRoot });
      return;
    }
    if (parsed.command === 'new') {
      const oldStreamKey = activeStreams.get(msg.channelId);
      if (oldStreamKey) {
        await resolved.streaming.cancelStream(oldStreamKey);
        activeStreams.delete(msg.channelId);
      }
      await finalizeActivityFeed(msg.channelId, adapter);
      loopDetector.reset(msg.channelId);
      await sessionManager.newSession(msg.channelId);
      markIdleImmediate(msg.channelId);
      await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
      return;
    }

    // Read-only / toggle commands — safe to handle mid-turn
    // Only commands where handleCommand returns a complete response (no separate action rendering).
    // Commands with complex action handlers (skills, schedule, rules) defer to serialized path.
    const SAFE_MID_TURN = new Set([
      'context', 'status', 'help', 'verbose', 'autopilot', 'yolo',
      'mcp', 'model', 'models', 'reasoning',
      'streamer-mode', 'on-air',
    ]);

    if (SAFE_MID_TURN.has(parsed.command)) {
      // Build the same inputs that handleInboundMessage would
      const sessionInfo = sessionManager.getSessionInfo(msg.channelId);
      const effPrefs = sessionManager.getEffectivePrefs(msg.channelId);
      let models: any[] | undefined;
      if (['model', 'models', 'status', 'reasoning'].includes(parsed.command)) {
        try { models = await sessionManager.listModels(); } catch { models = undefined; }
      }
      const mcpInfo = parsed.command === 'mcp' ? sessionManager.getMcpServerInfo(msg.channelId) : undefined;
      const contextUsage = sessionManager.getContextUsage(msg.channelId);

      const cmdResult = handleCommand(
        msg.channelId, commandText, sessionInfo ?? undefined,
        { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode, reasoningEffort: effPrefs.reasoningEffort },
        { workingDirectory: channelConfig.workingDirectory, bot: channelConfig.bot },
        models, mcpInfo, contextUsage,
      );

      if (cmdResult.handled) {
        // Model/agent switch while busy — defer to serialized path
        if (cmdResult.action === 'switch_model' || cmdResult.action === 'switch_agent') {
          throw new Error('slash-command-while-busy');
        }
        if (cmdResult.response) {
          await adapter.sendMessage(msg.channelId, cmdResult.response, { threadRootId: threadRoot });
        }
        // handleCommand already persists prefs (verbose, autopilot, reasoning) via setChannelPrefs
        return;
      }
    }

    // All other slash commands — defer to serialized path
    throw new Error('slash-command-while-busy');
  }

  // File-only messages can't steer — queue them for normal processing
  if (!text && msg.attachments?.length) {
    throw new Error('file-only-while-busy');
  }

  log.info(`Mid-turn steering for ${msg.channelId.slice(0, 8)}...: "${text.slice(0, 100)}"`);

  // Atomically swap streams via eventLocks so no residual events from the
  // previous response can sneak in between finalization and the new stream.
  const evPrev = eventLocks.get(msg.channelId) ?? Promise.resolve();
  const evTask = evPrev.then(async () => {
    const existingStream = activeStreams.get(msg.channelId);
    if (existingStream) {
      await resolved.streaming.finalizeStream(existingStream);
      activeStreams.delete(msg.channelId);
    }
    const newKey = await resolved.streaming.startStream(msg.channelId);
    activeStreams.set(msg.channelId, newKey);
  });
  eventLocks.set(msg.channelId, evTask.catch(() => {}));
  await evTask;

  await sessionManager.sendMidTurn(msg.channelId, text, msg.userId);

  // Acknowledge with ⚡ reaction (best-effort)
  try { adapter.addReaction?.(msg.postId, 'zap')?.catch(() => {}); } catch { /* best-effort */ }
}

async function handleInboundMessage(
  msg: InboundMessage,
  sessionManager: SessionManager,
  platformName: string,
  botName: string,
): Promise<void> {
  // Ignore messages from any bot we manage on this platform (prevents cross-bot loops)
  for (const [key, a] of botAdapters) {
    if (key.startsWith(`${platformName}:`) && msg.userId === a.getBotUserId()) return;
  }

  // Auto-register DM channels for known bots
  if (!isConfiguredChannel(msg.channelId) && msg.isDM) {
    const workspacePath = getWorkspacePath(botName);
    initWorkspace(botName);
    registerDynamicChannel({
      id: msg.channelId,
      platform: platformName,
      bot: botName,
      name: `DM (auto-discovered @${botName})`,
      workingDirectory: workspacePath,
      triggerMode: 'all',
      threadedReplies: false,
      verbose: false,
      isDM: true,
    });
    log.info(`Auto-registered DM channel ${msg.channelId.slice(0, 8)}... for bot "${botName}"`);
  }

  // Only handle configured channels
  if (!isConfiguredChannel(msg.channelId)) {
    log.debug(`Ignoring unconfigured channel ${msg.channelId}`);
    return;
  }

  // Only the assigned bot processes messages for this channel (prevents duplicate handling)
  const assignedBot = getChannelBotName(msg.channelId);
  if (assignedBot && assignedBot !== botName) return;

  const resolved = getAdapterForChannel(msg.channelId);
  if (!resolved) {
    log.warn(`No adapter for channel ${msg.channelId}`);
    return;
  }
  const { adapter, streaming } = resolved;

  const channelConfig = getChannelConfig(msg.channelId);

  // Check trigger mode
  const triggerMode = channelConfig.triggerMode;
  if (triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) return;

  // Strip bot mention from message text
  let text = stripBotMention(msg.text, channelConfig.bot);

  if (!text && !msg.attachments?.length) return;

  // Detect dynamic thread request (🧵 or "reply in thread") and strip from text
  const threadExtract = extractThreadRequest(text);
  text = threadExtract.text;
  const threadRequested = threadExtract.threadRequested;

  if (!text && !msg.attachments?.length) return;

  // Check for slash commands
  const sessionInfo = sessionManager.getSessionInfo(msg.channelId);
  const effPrefs = sessionManager.getEffectivePrefs(msg.channelId);

  // Fetch models list for commands that need it (model, models, status, reasoning)
  const parsed = parseCommand(text);
  let models: any[] | undefined;
  if (parsed && ['model', 'models', 'status', 'reasoning'].includes(parsed.command)) {
    try {
      models = await sessionManager.listModels();
    } catch {
      // Check if the failure is an auth issue
      const auth = await sessionManager.getAuthStatus();
      if (!auth.isAuthenticated) {
        const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);
        await adapter.sendMessage(msg.channelId,
          '🔒 **Not authenticated.** Run `copilot login` on the bridge host to sign in.',
          { threadRootId: threadRoot });
        return;
      }
      models = undefined;
    }
  }

  // Fetch MCP info for /mcp command
  const mcpInfo = parsed?.command === 'mcp' ? sessionManager.getMcpServerInfo(msg.channelId) : undefined;

  // Get cached context usage for /context and /status
  const contextUsage = sessionManager.getContextUsage(msg.channelId);

  const cmdResult = handleCommand(
    msg.channelId, text, sessionInfo ?? undefined,
    { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode, reasoningEffort: effPrefs.reasoningEffort },
    { workingDirectory: channelConfig.workingDirectory, bot: channelConfig.bot },
    models,
    mcpInfo,
    contextUsage,
  );

  if (cmdResult.handled) {
    const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);

    // Send response before action, except for actions that send their own ack after completing
    const deferResponse = cmdResult.action === 'switch_model' || cmdResult.action === 'switch_agent';
    if (cmdResult.response && !deferResponse) {
      await adapter.sendMessage(msg.channelId, cmdResult.response, { threadRootId: threadRoot });
    }

    switch (cmdResult.action) {
      case 'new_session': {
        markIdleImmediate(msg.channelId);
        const oldStreamKey = activeStreams.get(msg.channelId);
        if (oldStreamKey) {
          await streaming.cancelStream(oldStreamKey);
          activeStreams.delete(msg.channelId);
        }
        await finalizeActivityFeed(msg.channelId, adapter);
        loopDetector.reset(msg.channelId);
        await sessionManager.newSession(msg.channelId);
        await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
        break;
      }
      case 'stop_session': {
        markIdleImmediate(msg.channelId);
        const stopStreamKey = activeStreams.get(msg.channelId);
        if (stopStreamKey) {
          await streaming.cancelStream(stopStreamKey);
          activeStreams.delete(msg.channelId);
        }
        await finalizeActivityFeed(msg.channelId, adapter);
        await sessionManager.abortSession(msg.channelId);
        await adapter.sendMessage(msg.channelId, '🛑 Task stopped.', { threadRootId: threadRoot });
        break;
      }
      case 'reload_config': {
        const result = reloadConfig();
        let response: string;
        if (!result.success) {
          response = `❌ Config reload failed: ${result.error}\nExisting config is unchanged.`;
        } else if (result.changes.length === 0 && result.restartNeeded.length === 0) {
          response = '✅ Config reloaded — no changes detected.';
        } else {
          const parts: string[] = ['✅ Config reloaded.'];
          if (result.changes.length > 0) {
            parts.push('**Applied:**');
            for (const c of result.changes) parts.push(`  ✓ ${c}`);
          }
          if (result.restartNeeded.length > 0) {
            parts.push('**Restart needed:**');
            for (const r of result.restartNeeded) parts.push(`  ⚠️ ${r}`);
          }
          response = parts.join('\n');
        }
        await adapter.sendMessage(msg.channelId, response, { threadRootId: threadRoot });
        break;
      }
      case 'reload_session': {
        const oldReloadStream = activeStreams.get(msg.channelId);
        if (oldReloadStream) {
          await streaming.cancelStream(oldReloadStream);
          activeStreams.delete(msg.channelId);
        }
        await finalizeActivityFeed(msg.channelId, adapter);
        const prevSessionId = sessionManager.getSessionId(msg.channelId);
        const ackId = await adapter.sendMessage(msg.channelId, '⏳ Reloading session...', { threadRootId: threadRoot });
        const sessionId = await sessionManager.reloadSession(msg.channelId);
        const wasNew = !prevSessionId || sessionId !== prevSessionId;
        const reloadMsg = wasNew
          ? `⚠️ Previous session not found — created new session (\`${sessionId.slice(0, 8)}…\`).`
          : `✅ Session reloaded (\`${sessionId.slice(0, 8)}…\`). Config and AGENTS.md re-read.`;
        await adapter.updateMessage(msg.channelId, ackId, reloadMsg);
        break;
      }
      case 'resume_session': {
        const oldResumeStream = activeStreams.get(msg.channelId);
        if (oldResumeStream) {
          await streaming.cancelStream(oldResumeStream);
          activeStreams.delete(msg.channelId);
        }
        await finalizeActivityFeed(msg.channelId, adapter);
        const resumeAck = await adapter.sendMessage(msg.channelId, '⏳ Resuming session...', { threadRootId: threadRoot });
        try {
          const resumedId = await sessionManager.resumeToSession(msg.channelId, cmdResult.payload);
          await adapter.updateMessage(msg.channelId, resumeAck, `✅ Resumed session \`${resumedId.slice(0, 8)}…\``);
        } catch (err: any) {
          await adapter.updateMessage(msg.channelId, resumeAck, `❌ Failed to resume session: ${err?.message ?? 'unknown error'}`);
        }
        break;
      }
      case 'list_sessions': {
        try {
          const sessions = await sessionManager.listChannelSessions(msg.channelId);
          if (sessions.length === 0) {
            await adapter.sendMessage(msg.channelId, '📋 No past sessions found for this workspace.', { threadRootId: threadRoot });
          } else {
            const lines = ['**Past Sessions** (use `/resume <id>` to reconnect)', ''];
            for (const s of sessions.slice(0, 10)) {
              const current = s.isCurrent ? ' ← current' : '';
              const age = formatAge(s.modifiedTime);
              const summary = s.summary ? ` — ${s.summary.slice(0, 60)}` : '';
              lines.push(`• \`${s.sessionId.slice(0, 12)}\` ${age}${summary}${current}`);
            }
            if (sessions.length > 10) {
              lines.push(`\n_…and ${sessions.length - 10} more_`);
            }
            await adapter.sendMessage(msg.channelId, lines.join('\n'), { threadRootId: threadRoot });
          }
        } catch (err: any) {
          await adapter.sendMessage(msg.channelId, `❌ Failed to list sessions: ${err?.message ?? 'unknown error'}`, { threadRootId: threadRoot });
        }
        break;
      }
      case 'switch_model': {
        const ackId = await adapter.sendMessage(msg.channelId, '⏳ Switching model...', { threadRootId: threadRoot });
        try {
          await sessionManager.switchModel(msg.channelId, cmdResult.payload);
          await adapter.updateMessage(msg.channelId, ackId, cmdResult.response ?? '✅ Model switched.');
        } catch (err: any) {
          log.error(`Failed to switch model on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.updateMessage(msg.channelId, ackId, '❌ Failed to switch model. Check logs for details.');
        }
        break;
      }
      case 'switch_agent': {
        const ackId = await adapter.sendMessage(msg.channelId, '⏳ Switching agent...', { threadRootId: threadRoot });
        try {
          await sessionManager.switchAgent(msg.channelId, cmdResult.payload);
          await adapter.updateMessage(msg.channelId, ackId, cmdResult.response ?? '✅ Agent switched.');
        } catch (err: any) {
          log.error(`Failed to switch agent on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.updateMessage(msg.channelId, ackId, '❌ Failed to switch agent. Check logs for details.');
        }
        break;
      }
      case 'approve':
        if (!sessionManager.resolvePermission(msg.channelId, true)) {
          await adapter.sendMessage(msg.channelId, '⚠️ No pending permission request.', { threadRootId: threadRoot });
        }
        break;
      case 'deny':
        if (!sessionManager.resolvePermission(msg.channelId, false)) {
          await adapter.sendMessage(msg.channelId, '⚠️ No pending permission request.', { threadRootId: threadRoot });
        }
        break;
      case 'remember':
        if (!sessionManager.resolvePermission(msg.channelId, true, true)) {
          await adapter.sendMessage(msg.channelId, '⚠️ No pending permission request.', { threadRootId: threadRoot });
        }
        break;
      case 'remember_list': {
        try {
          const sections: string[] = [];

          // Hardcoded safety denies
          const hardcoded = getHardcodedRules();
          sections.push('**🔒 Hardcoded denies (enforced in all modes including autopilot):**');
          sections.push(...hardcoded.map(r => `- **${r.action}** \`${r.spec}\``));
          sections.push('- **allow** `read/write in workspace + allowPaths`');

          // Config-level rules
          const configRules = getConfigRules();
          if (configRules.length > 0) {
            sections.push('\n**⚙️ Config — config.json (skipped in autopilot):**');
            sections.push(...configRules.map(r => `- **${r.action}** \`${r.spec}\``));
          } else {
            sections.push('\n**⚙️ Config — config.json (skipped in autopilot):** _(none)_');
          }

          // Stored rules (per-channel)
          const stored = listPermissionRulesForScope(msg.channelId);
          if (stored.length > 0) {
            sections.push('\n**💾 Stored — this channel (skipped in autopilot):**');
            sections.push(...stored.map(r => {
              const spec = r.commandPattern === '*' ? r.tool : `${r.tool}(${r.commandPattern})`;
              return `- **${r.action}** \`${spec}\``;
            }));
          } else {
            sections.push('\n**💾 Stored — this channel (skipped in autopilot):** _(none)_');
          }

          await adapter.sendMessage(msg.channelId, `📋 **Permission rules:**\n${sections.join('\n')}`, { threadRootId: threadRoot });
        } catch (err: any) {
          log.error('Failed to list permission rules:', err);
          await adapter.sendMessage(msg.channelId, '❌ Failed to list permission rules.', { threadRootId: threadRoot });
        }
        break;
      }
      case 'remember_clear': {
        try {
          const spec = cmdResult.payload as string | undefined;
          if (!spec) {
            clearPermissionRules(msg.channelId);
            await adapter.sendMessage(msg.channelId, '🗑️ All permission rules cleared for this channel.', { threadRootId: threadRoot });
          } else {
            const match = spec.match(/^([^(]+?)(?:\((.+)\))?$/);
            const tool = match?.[1]?.trim() ?? spec;
            const pattern = match?.[2]?.trim() ?? '*';
            const removed = removePermissionRule(msg.channelId, tool, pattern);
            if (removed) {
              await adapter.sendMessage(msg.channelId, `🗑️ Removed rule: \`${spec}\``, { threadRootId: threadRoot });
            } else {
              await adapter.sendMessage(msg.channelId, `⚠️ No matching rule found for \`${spec}\``, { threadRootId: threadRoot });
            }
          }
        } catch (err: any) {
          log.error('Failed to clear permission rules:', err);
          await adapter.sendMessage(msg.channelId, '❌ Failed to clear permission rules.', { threadRootId: threadRoot });
        }
        break;
      }
      case 'schedule': {
        const args = cmdResult.payload as string | undefined;
        const sub = args?.split(/\s+/)?.[0]?.toLowerCase();
        const subArg = args?.slice((sub?.length ?? 0)).trim();

        if (!sub || sub === 'list') {
          const tasks = listJobs(msg.channelId);
          if (tasks.length === 0) {
            await adapter.sendMessage(msg.channelId, '📋 No scheduled tasks for this channel.', { threadRootId: threadRoot });
          } else {
            const lines = tasks.map(t => {
              const tz = t.timezone ?? 'UTC';
              const type = t.cronExpr ? describeCron(t.cronExpr) : 'one-off';
              const status = t.enabled ? '✅' : '⏸️';
              const desc = t.description ?? t.prompt.slice(0, 50);
              const next = t.nextRun ? formatInTimezone(t.nextRun, tz) : undefined;
              const lastRan = t.lastRun ? formatInTimezone(t.lastRun, tz) : undefined;
              let detail = `${status} **${desc}** — ${type}\n   ID: \`${t.id}\``;
              if (next) detail += ` | Next: ${next}`;
              if (lastRan) detail += ` | Last: ${lastRan}`;
              return detail;
            });
            await adapter.sendMessage(msg.channelId, `📋 **Scheduled Tasks**\n\n${lines.join('\n\n')}`, { threadRootId: threadRoot });
          }
        } else if (sub === 'cancel' || sub === 'remove' || sub === 'delete') {
          if (!subArg) {
            await adapter.sendMessage(msg.channelId, '⚠️ Usage: `/schedule cancel <id>`', { threadRootId: threadRoot });
          } else {
            const removed = removeJob(subArg, msg.channelId);
            await adapter.sendMessage(msg.channelId, removed ? `🗑️ Task \`${subArg}\` cancelled.` : `⚠️ Task \`${subArg}\` not found.`, { threadRootId: threadRoot });
          }
        } else if (sub === 'pause') {
          if (!subArg) {
            await adapter.sendMessage(msg.channelId, '⚠️ Usage: `/schedule pause <id>`', { threadRootId: threadRoot });
          } else {
            const paused = pauseJob(subArg, msg.channelId);
            await adapter.sendMessage(msg.channelId, paused ? `⏸️ Task \`${subArg}\` paused.` : `⚠️ Task \`${subArg}\` not found.`, { threadRootId: threadRoot });
          }
        } else if (sub === 'resume') {
          if (!subArg) {
            await adapter.sendMessage(msg.channelId, '⚠️ Usage: `/schedule resume <id>`', { threadRootId: threadRoot });
          } else {
            const resumed = resumeJob(subArg, msg.channelId);
            await adapter.sendMessage(msg.channelId, resumed ? `▶️ Task \`${subArg}\` resumed.` : `⚠️ Task \`${subArg}\` not found.`, { threadRootId: threadRoot });
          }
        } else if (sub === 'history' || sub === 'log') {
          const limit = subArg ? parseInt(subArg, 10) || 10 : 10;
          const entries = getTaskHistory(msg.channelId, limit);
          if (entries.length === 0) {
            await adapter.sendMessage(msg.channelId, '📋 No task history for this channel.', { threadRootId: threadRoot });
          } else {
            const lines = entries.map(e => {
              const icon = e.status === 'success' ? '✅' : '❌';
              const desc = e.description ?? e.prompt.slice(0, 40);
              const time = formatInTimezone(e.firedAt, e.timezone);
              return `${icon} ${desc} — ${time}${e.error ? ` ⚠️ ${e.error}` : ''}`;
            });
            await adapter.sendMessage(msg.channelId, `📋 **Task History** (last ${entries.length})\n${lines.join('\n')}`, { threadRootId: threadRoot });
          }
        } else {
          await adapter.sendMessage(msg.channelId, '⚠️ Usage: `/schedule [list|cancel|pause|resume|history] [id]`', { threadRootId: threadRoot });
        }
        break;
      }

      case 'skills': {
        const skills = sessionManager.getSkillInfo(msg.channelId);
        const mcpInfo = sessionManager.getMcpServerInfo(msg.channelId);
        const lines: string[] = ['🧰 **Skills & Tools**', ''];

        if (skills.length > 0) {
          lines.push('**Skills**');
          for (const s of skills) {
            const desc = s.description ? ` — ${s.description}` : '';
            lines.push(`• \`${s.name}\`${desc} _(${s.source})_`);
          }
          lines.push('');
        }

        if (mcpInfo.length > 0) {
          lines.push('**MCP Servers**');
          for (const s of mcpInfo) {
            lines.push(`• \`${s.name}\` _(${s.source})_`);
          }
          lines.push('');
        }

        lines.push('**Copilot Bridge Tools**');
        for (const t of BRIDGE_CUSTOM_TOOLS) lines.push(`• \`${t}\``);

        if (skills.length === 0 && mcpInfo.length === 0) {
          lines.push('', '_No skills or MCP servers configured. Add skills to `~/.copilot/skills/` or MCP servers to `~/.copilot/mcp-config.json`._');
        }

        await adapter.sendMessage(msg.channelId, lines.join('\n'), { threadRootId: threadRoot });
        break;
      }
    }
    return;
  }

  // Pending user input
  // TODO: file-only messages (empty text + attachments) resolve input with empty string and drop files
  if (sessionManager.hasPendingUserInput(msg.channelId)) {
    sessionManager.resolveUserInput(msg.channelId, text);
    return;
  }

  // Pending permission — natural language responses
  if (sessionManager.hasPendingPermission(msg.channelId)) {
    const lower = text.toLowerCase();
    if (lower === 'yes' || lower === 'y' || lower === 'approve') {
      sessionManager.resolvePermission(msg.channelId, true);
      return;
    }
    if (lower === 'no' || lower === 'n' || lower === 'deny') {
      sessionManager.resolvePermission(msg.channelId, false);
      return;
    }
  }

  // Regular message — forward to Copilot session
  try {
    // Check auth before starting a session (prevents hanging on "Working...")
    const hasSession = sessionManager.getSessionInfo(msg.channelId);
    if (!hasSession) {
      const auth = await sessionManager.getAuthStatus();
      if (!auth.isAuthenticated) {
        const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);
        await adapter.sendMessage(msg.channelId,
          '🔒 **Not authenticated.** Run `copilot login` on the bridge host to sign in.',
          { threadRootId: threadRoot });
        return;
      }
    }

    console.log(`[bridge] Forwarding to Copilot: "${text}"`);
    log.info(`Forwarding to Copilot: "${text.slice(0, 100)}"`);
    adapter.setTyping(msg.channelId).catch(() => {});

    // Atomically swap streams via eventLocks to prevent event interleaving
    const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);
    const evPrev = eventLocks.get(msg.channelId) ?? Promise.resolve();
    const evTask = evPrev.then(async () => {
      const existingStreamKey = activeStreams.get(msg.channelId);
      if (existingStreamKey) {
        await streaming.finalizeStream(existingStreamKey);
        activeStreams.delete(msg.channelId);
      }
      initialStreamPosted.add(msg.channelId);
      const streamKey = await streaming.startStream(msg.channelId, threadRoot);
      activeStreams.set(msg.channelId, streamKey);
    });
    eventLocks.set(msg.channelId, evTask.catch(() => {}));
    await evTask;

    // Mark busy before send so mid-turn messages arriving during the await are steered
    markBusy(msg.channelId);

    // Download any file attachments to .temp/ in the bot's workspace
    const sdkAttachments = await downloadAttachments(msg.attachments, msg.channelId, adapter);

    // If no text but attachments, provide a minimal prompt so the model knows to look at them
    const prompt = text || (sdkAttachments.length > 0 ? 'See attached file(s).' : '');

    // Guard: if both prompt and attachments are empty (all downloads failed), bail out
    if (!prompt && sdkAttachments.length === 0) {
      log.warn(`No text and no attachments for channel ${msg.channelId.slice(0, 8)}... — nothing to send`);
      markIdleImmediate(msg.channelId);
      const sk = activeStreams.get(msg.channelId);
      if (sk) { await streaming.cancelStream(sk, 'Failed to download attachment(s).'); activeStreams.delete(msg.channelId); }
      return;
    }

    await sessionManager.sendMessage(msg.channelId, prompt, sdkAttachments.length > 0 ? sdkAttachments : undefined, msg.userId);
    // Hold the channelLock until session.idle so queued work (scheduler, etc.)
    // doesn't start a new stream while this response is still being streamed.
    await waitForChannelIdle(msg.channelId);
  } catch (err) {
    markIdleImmediate(msg.channelId);
    log.error(`Error sending message for channel ${msg.channelId}:`, err);
    const streamKey = activeStreams.get(msg.channelId);
    if (streamKey) {
      await streaming.cancelStream(streamKey, err instanceof Error ? err.message : 'Unknown error');
      activeStreams.delete(msg.channelId);
    } else {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      await adapter.sendMessage(msg.channelId, `❌ Error: ${errorMsg}`);
    }
  }
}

// --- Reaction Handling ---

async function handleReaction(
  reaction: InboundReaction,
  sessionManager: SessionManager,
): Promise<void> {
  if (!isConfiguredChannel(reaction.channelId)) return;
  if (reaction.action !== 'added') return;

  const resolved = getAdapterForChannel(reaction.channelId);
  if (!resolved) return;
  const { adapter } = resolved;

  if (reaction.emoji === 'thumbsup' || reaction.emoji === '+1') {
    if (sessionManager.resolvePermission(reaction.channelId, true)) {
      await adapter.sendMessage(reaction.channelId, '✅ Approved via reaction.');
    }
  } else if (reaction.emoji === 'thumbsdown' || reaction.emoji === '-1') {
    if (sessionManager.resolvePermission(reaction.channelId, false)) {
      await adapter.sendMessage(reaction.channelId, '❌ Denied via reaction.');
    }
  } else if (reaction.emoji === 'floppy_disk') {
    if (sessionManager.resolvePermission(reaction.channelId, true, true)) {
      await adapter.sendMessage(reaction.channelId, '💾 Approved + remembered via reaction.');
    }
  }
}

// --- Session Event Handling ---

async function handleSessionEvent(
  channelId: string,
  event: any,
  sessionManager: SessionManager,
): Promise<void> {
  if (event.type === 'session.error' || event.type?.includes('error')) {
    log.error(`SDK error event: ${JSON.stringify(event).slice(0, 1000)}`);
  }

  // Verbose SDK event logging
  if (event.type === 'assistant.message_delta' || event.type === 'assistant.streaming_delta') {
    log.debug(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`);
  } else if (event.type === 'assistant.message') {
    log.debug(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 400)}`);
  } else if (event.type?.startsWith('tool.')) {
    log.info(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 400)}`);
  } else {
    log.debug(`SDK event: ${event.type}`);
  }

  const resolved = getAdapterForChannel(channelId);
  if (!resolved) return;
  const { adapter, streaming } = resolved;

  const channelConfig = getChannelConfig(channelId);
  const prefs = getChannelPrefs(channelId);
  const verbose = prefs?.verbose ?? channelConfig.verbose;

  // Handle custom bridge events (permissions, user input)
  if (event.type === 'bridge.permission_request') {
    const streamKey = activeStreams.get(channelId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    await finalizeActivityFeed(channelId, adapter);
    const { toolName, serverName, input, commands } = event.data;
    const formatted = formatPermissionRequest(toolName, input, commands, serverName);
    await adapter.sendMessage(channelId, formatted);
    return;
  }

  if (event.type === 'bridge.user_input_request') {
    const streamKey = activeStreams.get(channelId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    await finalizeActivityFeed(channelId, adapter);
    const { question, choices } = event.data;
    const formatted = formatUserInputRequest(question, choices);
    await adapter.sendMessage(channelId, formatted);
    return;
  }

  // Format and route SDK events
  const formatted = formatEvent(event);
  if (!formatted) return;

  // Filter out NO_REPLY responses from startup nudges only
  if (nudgePending.has(channelId) && formatted.type === 'content' && event.type === 'assistant.message') {
    const content = formatted.content?.trim();
    nudgePending.delete(channelId);
    if (content === 'NO_REPLY' || content === '`NO_REPLY`') {
      log.info(`Filtered NO_REPLY from nudge on channel ${channelId.slice(0, 8)}...`);
      // Clean up any active stream without posting
      const sk = activeStreams.get(channelId);
      if (sk) {
        await streaming.deleteStream(sk);
        activeStreams.delete(channelId);
      }
      return;
    }
  }

  if (formatted.verbose && !verbose) return;

  const streamKey = activeStreams.get(channelId);

  switch (formatted.type) {
    case 'content': {
      // Content arriving means session is still active — cancel any idle debounce
      cancelIdleDebounce(channelId);
      if (!isBusy(channelId)) markBusy(channelId);
      // When response content starts, finalize the activity feed
      if (activityFeeds.has(channelId)) {
        await finalizeActivityFeed(channelId, adapter);
      }
      // In verbose mode with an active "Working..." stream that hasn't received
      // content yet, delete it and start a new stream so the response posts
      // below the activity feed (no scroll-back).
      if (verbose && streamKey) {
        const streamContent = streaming.getStreamContent(streamKey);
        if (streamContent !== undefined && streamContent === '') {
          const threadRootId = streaming.getStreamThreadRootId(streamKey);
          await streaming.deleteStream(streamKey);
          activeStreams.delete(channelId);
          const initialContent = event.type === 'assistant.message'
            ? formatted.content
            : (formatted.content || undefined);
          const newKey = await streaming.startStream(channelId, threadRootId, initialContent);
          activeStreams.set(channelId, newKey);
          adapter.setTyping(channelId).catch(() => {});
          break;
        }
      }
      if (!streamKey) {
        // Suppress stream auto-start during startup nudge — avoid visible "Working..." flash
        if (nudgePending.has(channelId)) break;
        // Auto-start stream — use actual content, never a "Working..." placeholder.
        // This happens on subsequent turns after turn_end finalized the previous stream.
        log.info(`Auto-starting stream for channel ${channelId.slice(0, 8)}...`);
        const initialContent = event.type === 'assistant.message'
          ? formatted.content
          : (formatted.content || undefined);
        const newKey = await streaming.startStream(channelId, undefined, initialContent);
        activeStreams.set(channelId, newKey);
      } else {
        if (event.type === 'assistant.message') {
          streaming.replaceContent(streamKey, formatted.content);
        } else if (formatted.content) {
          streaming.appendDelta(streamKey, formatted.content);
        }
      }
      adapter.setTyping(channelId).catch(() => {});
      break;
    }
    case 'tool_start':
      cancelIdleDebounce(channelId);
      if (!isBusy(channelId)) markBusy(channelId);

      // --- Loop detection ---
      if (event.type === 'tool.execution_start') {
        const toolName = event.data?.toolName ?? event.data?.name ?? 'unknown';
        const args = event.data?.arguments ?? {};
        const loop = loopDetector.recordToolCall(channelId, toolName, args);

        if (loop.isCritical) {
          // Critical loop — warn and force a new session
          await adapter.sendMessage(
            channelId,
            `🛑 **Loop detected**: \`${toolName}\` called ${loop.count} times with the same arguments. Resetting session.`,
          );
          const oldStreamKey = activeStreams.get(channelId);
          if (oldStreamKey) {
            await streaming.cancelStream(oldStreamKey);
            activeStreams.delete(channelId);
          }
          await finalizeActivityFeed(channelId, adapter);
          loopDetector.reset(channelId);
          markIdleImmediate(channelId);
          await sessionManager.newSession(channelId);
          break;
        } else if (loop.isLoop) {
          // First warning — notify the user but let the session continue
          await adapter.sendMessage(
            channelId,
            `⚠️ **Possible loop**: \`${toolName}\` called ${loop.count} times with the same arguments. ` +
            `Will reset session if it continues.`,
          );
        }
      }

      if (verbose && formatted.content && !nudgePending.has(channelId)) {
        await appendActivityFeed(channelId, formatted.content, adapter);
      }
      break;

    case 'tool_complete':
      // tool_complete events are folded into the activity feed via tool_start
      break;

    case 'error':
      markIdleImmediate(channelId);
      nudgePending.delete(channelId);
      if (streamKey) {
        await streaming.cancelStream(streamKey, formatted.content);
        activeStreams.delete(channelId);
      } else {
        await adapter.sendMessage(channelId, formatted.content);
      }
      break;

    case 'status':
      // Send subagent status messages to chat
      if (formatted.content) {
        if (streamKey) {
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
        await adapter.sendMessage(channelId, formatted.content);
      }
      // Finalize stream when the session goes idle (all turns complete).
      // turn_end fires between tool cycles — DON'T finalize there or we get
      // duplicate "Working..." messages from auto-starting new streams.
      if (event.type === 'session.idle') {
        markIdle(channelId);
        nudgePending.delete(channelId);
        await finalizeActivityFeed(channelId, adapter);
        initialStreamPosted.delete(channelId);
        if (streamKey) {
          log.info(`Session idle, finalizing stream for ${channelId.slice(0, 8)}...`);
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
        // Clean up temp files from downloaded attachments
        cleanupTempFiles(channelId);
      }
      break;
  }
}

// --- Activity Feed ---

/** Append a tool call line to the activity feed message for a channel. */
async function appendActivityFeed(channelId: string, line: string, adapter: ChannelAdapter): Promise<void> {
  let feed = activityFeeds.get(channelId);

  if (!feed) {
    // Create the activity feed message
    const messageId = await adapter.sendMessage(channelId, line);
    feed = { messageId, lines: [line], updateTimer: null };
    activityFeeds.set(channelId, feed);
    return;
  }

  feed.lines.push(line);

  // Throttle updates
  if (!feed.updateTimer) {
    feed.updateTimer = setTimeout(async () => {
      const f = activityFeeds.get(channelId);
      if (!f) return;
      f.updateTimer = null;
      try {
        await adapter.updateMessage(channelId, f.messageId, f.lines.join('\n'));
      } catch (err) {
        log.error(`Failed to update activity feed:`, err);
      }
    }, ACTIVITY_THROTTLE_MS);
  }
}

/** Finalize the activity feed — flush any pending update and remove tracking. */
async function finalizeActivityFeed(channelId: string, adapter: ChannelAdapter): Promise<void> {
  const feed = activityFeeds.get(channelId);
  if (!feed) return;

  if (feed.updateTimer) {
    clearTimeout(feed.updateTimer);
    feed.updateTimer = null;
  }

  // Final update with all lines
  try {
    await adapter.updateMessage(channelId, feed.messageId, feed.lines.join('\n'));
  } catch (err) {
    log.error(`Failed to finalize activity feed:`, err);
  }

  activityFeeds.delete(channelId);
}

// --- Admin Session Nudge ---

const NUDGE_PROMPT = `The bridge service was just restarted. If you were in the middle of a task, review your conversation history and continue where you left off. If you were not mid-task, respond with exactly: NO_REPLY`;

async function nudgeAdminSessions(sessionManager: SessionManager): Promise<void> {
  const allSessions = getAllChannelSessions();
  if (allSessions.length === 0) return;

  for (const { channelId } of allSessions) {
    // Only nudge channels belonging to admin bots
    if (!isConfiguredChannel(channelId)) continue;
    const channelConfig = getChannelConfig(channelId);
    const botName = getChannelBotName(channelId);
    if (!isBotAdmin(channelConfig.platform, botName)) continue;

    try {
      log.info(`Nudging admin session for bot "${botName}" on channel ${channelId.slice(0, 8)}...`);
      // Only post the visible restart notice in DM channels
      if (channelConfig.isDM) {
        const resolved = getAdapterForChannel(channelId);
        if (resolved) {
          resolved.adapter.sendMessage(channelId, '🔄 Bridge restarted.').catch(e =>
            log.warn(`Failed to post restart notice on ${channelId.slice(0, 8)}...:`, e)
          );
        }
      }
      nudgePending.add(channelId);
      await sessionManager.sendMessage(channelId, NUDGE_PROMPT);
    } catch (err) {
      nudgePending.delete(channelId);
      log.warn(`Failed to nudge admin session on channel ${channelId.slice(0, 8)}...:`, err);
    }
  }
}

// Start the bridge
main().catch((err) => {
  log.error('Fatal error:', err);
  closeDb();
  process.exit(1);
});
