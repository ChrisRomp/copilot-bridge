import { loadConfig, getConfig, isConfiguredChannel, registerDynamicChannel, markChannelAsDM, getChannelConfig, getPlatformBots, getChannelBotName, isBotAdmin } from './config.js';
import { CopilotBridge } from './core/bridge.js';
import { SessionManager } from './core/session-manager.js';
import { handleCommand, parseCommand } from './core/command-handler.js';
import { formatEvent, formatPermissionRequest, formatUserInputRequest } from './core/stream-formatter.js';
import { WorkspaceWatcher, initWorkspace, getWorkspacePath } from './core/workspace-manager.js';
import { MattermostAdapter } from './channels/mattermost/adapter.js';
import { StreamingHandler } from './channels/mattermost/streaming.js';
import { getChannelPrefs, getAllChannelSessions, closeDb } from './state/store.js';
import { extractThreadRequest, resolveThreadRoot } from './core/thread-utils.js';
import { createLogger } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelAdapter, InboundMessage, InboundReaction, MessageAttachment } from './types.js';

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

  // Initialize channel adapters — one per bot identity
  for (const [platformName, platformConfig] of Object.entries(config.platforms)) {
    if (platformName === 'mattermost') {
      const bots = getPlatformBots(platformName);
      for (const [botName, botInfo] of bots) {
        const key = `${platformName}:${botName}`;
        const adapter = new MattermostAdapter(platformName, platformConfig.url, botInfo.token);
        botAdapters.set(key, adapter);
        botStreamers.set(key, new StreamingHandler(adapter));
        log.info(`Registered bot "${botName}" for ${platformName}`);
      }
    }
  }

  // Wire up session events → streaming output (serialized per channel)
  sessionManager.onSessionEvent((sessionId, channelId, event) => {
    const prev = eventLocks.get(channelId) ?? Promise.resolve();
    const next = prev.then(() =>
      handleSessionEvent(channelId, event)
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
    if (adapter instanceof MattermostAdapter) {
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

  // Nudge admin bot sessions that may have been mid-task before restart
  nudgeAdminSessions(sessionManager).catch(err =>
    log.error('Admin nudge failed:', err)
  );

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
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

async function handleInboundMessage(
  msg: InboundMessage,
  sessionManager: SessionManager,
  platformName: string,
  botName: string,
): Promise<void> {
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
  let text = msg.text;
  text = text.replace(new RegExp(`@\\S+`, 'g'), (match) => {
    // Only remove the bot's mention, keep others
    if (channelConfig.bot && match === `@${channelConfig.bot}`) return '';
    return match;
  }).trim();

  if (!text) return;

  // Detect dynamic thread request (🧵 or "reply in thread") and strip from text
  const threadExtract = extractThreadRequest(text);
  text = threadExtract.text;
  const threadRequested = threadExtract.threadRequested;

  if (!text) return;

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
        const oldStreamKey = activeStreams.get(msg.channelId);
        if (oldStreamKey) {
          await streaming.cancelStream(oldStreamKey);
          activeStreams.delete(msg.channelId);
        }
        await finalizeActivityFeed(msg.channelId, adapter);
        await sessionManager.newSession(msg.channelId);
        await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
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
        sessionManager.resolvePermission(msg.channelId, true, true);
        break;
    }
    return;
  }

  // Pending user input
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
    console.log(`[bridge] Forwarding to Copilot: "${text}"`);
    log.info(`Forwarding to Copilot: "${text.slice(0, 100)}"`);
    adapter.setTyping(msg.channelId).catch(() => {});

    const existingStreamKey = activeStreams.get(msg.channelId);
    if (existingStreamKey) {
      await streaming.finalizeStream(existingStreamKey);
      activeStreams.delete(msg.channelId);
    }

    const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);
    initialStreamPosted.add(msg.channelId);
    const streamKey = await streaming.startStream(msg.channelId, threadRoot);
    activeStreams.set(msg.channelId, streamKey);

    // Download any file attachments to .temp/ in the bot's workspace
    const sdkAttachments = await downloadAttachments(msg.attachments, msg.channelId, adapter);

    await sessionManager.sendMessage(msg.channelId, text, sdkAttachments.length > 0 ? sdkAttachments : undefined);
  } catch (err) {
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
  }
}

// --- Session Event Handling ---

async function handleSessionEvent(
  channelId: string,
  event: any,
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
      if (verbose && formatted.content && !nudgePending.has(channelId)) {
        await appendActivityFeed(channelId, formatted.content, adapter);
      }
      break;

    case 'tool_complete':
      // tool_complete events are folded into the activity feed via tool_start
      break;

    case 'error':
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
