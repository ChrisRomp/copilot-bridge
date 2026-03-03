import { loadConfig, getConfig, isConfiguredChannel, getChannelConfig, getPlatformBots, getChannelBotName } from './config.js';
import { CopilotBridge } from './core/bridge.js';
import { SessionManager } from './core/session-manager.js';
import { handleCommand, parseCommand } from './core/command-handler.js';
import { formatEvent, formatPermissionRequest, formatUserInputRequest } from './core/stream-formatter.js';
import { MattermostAdapter } from './channels/mattermost/adapter.js';
import { StreamingHandler } from './channels/mattermost/streaming.js';
import { getChannelPrefs, closeDb } from './state/store.js';
import { createLogger } from './logger.js';
import type { ChannelAdapter, InboundMessage, InboundReaction } from './types.js';

const log = createLogger('bridge');

// Active streaming responses, keyed by channelId
const activeStreams = new Map<string, string>(); // channelId → streamKey

// Per-channel promise chain to serialize message handling
const channelLocks = new Map<string, Promise<void>>();

// Per-channel promise chain to serialize SESSION EVENT handling (prevents race on auto-start)
const eventLocks = new Map<string, Promise<void>>();

// Bot adapters keyed by "platform:botName" for channel→adapter lookup
const botAdapters = new Map<string, ChannelAdapter>();
const botStreamers = new Map<string, StreamingHandler>();

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

  // Connect all bot adapters and wire up handlers
  for (const [key, adapter] of botAdapters) {
    const streaming = botStreamers.get(key)!;

    adapter.onMessage((msg) => {
      const prev = channelLocks.get(msg.channelId) ?? Promise.resolve();
      const next = prev.then(() =>
        handleInboundMessage(msg, sessionManager)
          .catch(err => log.error(`Unhandled error in message handler:`, err))
      );
      channelLocks.set(msg.channelId, next);
    });
    adapter.onReaction((reaction) => handleReaction(reaction, sessionManager));

    await adapter.connect();
    log.info(`${key} connected`);
  }

  log.info('copilot-bridge ready!');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
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
): Promise<void> {
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
  const prefs = getChannelPrefs(msg.channelId);

  // Check trigger mode
  const triggerMode = prefs?.triggerMode ?? channelConfig.triggerMode;
  if (triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) return;

  // Strip bot mention from message text
  let text = msg.text;
  text = text.replace(new RegExp(`@\\S+`, 'g'), (match) => {
    // Only remove the bot's mention, keep others
    if (channelConfig.bot && match === `@${channelConfig.bot}`) return '';
    return match;
  }).trim();

  if (!text) return;

  // Check for slash commands
  const sessionInfo = sessionManager.getSessionInfo(msg.channelId);
  const effPrefs = sessionManager.getEffectivePrefs(msg.channelId);

  // Fetch model info for commands that need it (status, reasoning)
  const parsed = parseCommand(text);
  let modelInfo: any = null;
  if (parsed && (parsed.command === 'status' || parsed.command === 'reasoning') && sessionInfo) {
    modelInfo = await sessionManager.getModelInfo(sessionInfo.model);
  }

  const cmdResult = handleCommand(
    msg.channelId, text, sessionInfo ?? undefined,
    { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode, reasoningEffort: effPrefs.reasoningEffort },
    { workingDirectory: channelConfig.workingDirectory, bot: channelConfig.bot },
    modelInfo,
  );

  if (cmdResult.handled) {
    const threadRoot = channelConfig.threadedReplies ? (msg.threadRootId ?? msg.postId) : undefined;

    if (cmdResult.response) {
      await adapter.sendMessage(msg.channelId, cmdResult.response, { threadRootId: threadRoot });
    }

    switch (cmdResult.action) {
      case 'new_session': {
        const oldStreamKey = activeStreams.get(msg.channelId);
        if (oldStreamKey) {
          await streaming.cancelStream(oldStreamKey);
          activeStreams.delete(msg.channelId);
        }
        await sessionManager.newSession(msg.channelId);
        await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
        break;
      }
      case 'switch_model':
        await sessionManager.switchModel(msg.channelId, cmdResult.payload);
        break;
      case 'switch_agent':
        await sessionManager.switchAgent(msg.channelId, cmdResult.payload);
        break;
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

    const threadRoot = channelConfig.threadedReplies ? (msg.threadRootId ?? msg.postId) : undefined;
    const streamKey = await streaming.startStream(msg.channelId, threadRoot);
    activeStreams.set(msg.channelId, streamKey);

    await sessionManager.sendMessage(msg.channelId, text);
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
    const { toolName, input, commands } = event.data;
    const formatted = formatPermissionRequest(toolName, input, commands);
    await adapter.sendMessage(channelId, formatted);
    return;
  }

  if (event.type === 'bridge.user_input_request') {
    const streamKey = activeStreams.get(channelId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    const { question, choices } = event.data;
    const formatted = formatUserInputRequest(question, choices);
    await adapter.sendMessage(channelId, formatted);
    return;
  }

  // Format and route SDK events
  const formatted = formatEvent(event);
  if (!formatted) return;

  if (formatted.verbose && !verbose) return;

  const streamKey = activeStreams.get(channelId);

  switch (formatted.type) {
    case 'content': {
      if (!streamKey) {
        // Auto-start a new stream (e.g., after permission resolution or bridge restart)
        log.info(`Auto-starting stream for channel ${channelId.slice(0, 8)}...`);
        const newKey = await streaming.startStream(channelId);
        activeStreams.set(channelId, newKey);
        if (event.type === 'assistant.message') {
          streaming.replaceContent(newKey, formatted.content);
        } else if (formatted.content) {
          streaming.appendDelta(newKey, formatted.content);
        }
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
      if (verbose && formatted.content) {
        await adapter.sendMessage(channelId, formatted.content);
      }
      break;

    case 'tool_complete':
      break;

    case 'error':
      if (streamKey) {
        await streaming.cancelStream(streamKey, formatted.content);
        activeStreams.delete(channelId);
      } else {
        await adapter.sendMessage(channelId, formatted.content);
      }
      break;

    case 'status':
      if (event.type === 'assistant.turn_end' || event.type === 'session.idle') {
        if (streamKey) {
          log.info(`Turn ended, finalizing stream for ${channelId.slice(0, 8)}...`);
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
      }
      break;
  }
}

// Start the bridge
main().catch((err) => {
  log.error('Fatal error:', err);
  closeDb();
  process.exit(1);
});
