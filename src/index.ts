import { loadConfig, getConfig, isConfiguredChannel, getChannelConfig, getPlatformBots, getChannelBotName } from './config.js';
import { CopilotBridge } from './core/bridge.js';
import { SessionManager } from './core/session-manager.js';
import { handleCommand, parseCommand } from './core/command-handler.js';
import { formatEvent, formatPermissionRequest, formatUserInputRequest } from './core/stream-formatter.js';
import { MattermostAdapter } from './channels/mattermost/adapter.js';
import { StreamingHandler } from './channels/mattermost/streaming.js';
import { getChannelPrefs, closeDb } from './state/store.js';
import type { ChannelAdapter, InboundMessage, InboundReaction } from './types.js';

// Active streaming responses, keyed by channelId
const activeStreams = new Map<string, string>(); // channelId → streamKey

// Per-channel promise chain to serialize message handling
const channelLocks = new Map<string, Promise<void>>();

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
  console.log('🌉 copilot-bridge starting...');

  // Load configuration
  const config = loadConfig();
  console.log(`  Loaded ${config.channels.length} channel mapping(s)`);

  // Initialize Copilot SDK bridge
  const bridge = new CopilotBridge();
  await bridge.start();
  console.log('  ✅ Copilot SDK connected');

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
        console.log(`  Registered bot "${botName}" for ${platformName}`);
      }
    }
  }

  // Wire up session events → streaming output
  sessionManager.onSessionEvent((sessionId, channelId, event) => {
    handleSessionEvent(channelId, event);
  });

  // Connect all bot adapters and wire up handlers
  for (const [key, adapter] of botAdapters) {
    const streaming = botStreamers.get(key)!;

    adapter.onMessage((msg) => {
      const prev = channelLocks.get(msg.channelId) ?? Promise.resolve();
      const next = prev.then(() =>
        handleInboundMessage(msg, sessionManager)
          .catch(err => console.error(`[bridge] Unhandled error in message handler:`, err))
      );
      channelLocks.set(msg.channelId, next);
    });
    adapter.onReaction((reaction) => handleReaction(reaction, sessionManager));

    await adapter.connect();
    console.log(`  ✅ ${key} connected`);
  }

  console.log('🌉 copilot-bridge ready!\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🌉 Shutting down...');
    await sessionManager.shutdown();
    for (const [, adapter] of botAdapters) {
      await adapter.disconnect();
    }
    for (const [, streaming] of botStreamers) {
      await streaming.cleanup();
    }
    await bridge.stop();
    closeDb();
    console.log('🌉 Goodbye.');
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
    console.log(`[bridge] Ignoring unconfigured channel ${msg.channelId}`);
    return;
  }

  const resolved = getAdapterForChannel(msg.channelId);
  if (!resolved) {
    console.log(`[bridge] No adapter for channel ${msg.channelId}`);
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
  const cmdResult = handleCommand(msg.channelId, text, sessionInfo ?? undefined, { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode }, { workingDirectory: channelConfig.workingDirectory, bot: channelConfig.bot });

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
    console.error(`[bridge] Error sending message for channel ${msg.channelId}:`, err);
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

function handleSessionEvent(
  channelId: string,
  event: any,
): void {
  console.log(`[bridge] Session event: ${event.type} for channel ${channelId}`);
  const resolved = getAdapterForChannel(channelId);
  if (!resolved) return;
  const { adapter, streaming } = resolved;

  const channelConfig = getChannelConfig(channelId);
  const prefs = getChannelPrefs(channelId);
  const verbose = prefs?.verbose ?? channelConfig.verbose;

  // Handle custom bridge events (permissions, user input)
  if (event.type === 'bridge.permission_request') {
    const { toolName, input, commands } = event.data;
    const formatted = formatPermissionRequest(toolName, input, commands);
    adapter.sendMessage(channelId, formatted).catch(console.error);
    return;
  }

  if (event.type === 'bridge.user_input_request') {
    const { question, choices } = event.data;
    const formatted = formatUserInputRequest(question, choices);
    adapter.sendMessage(channelId, formatted).catch(console.error);
    return;
  }

  // Format and route SDK events
  const formatted = formatEvent(event);
  if (!formatted) return;

  if (formatted.verbose && !verbose) return;

  const streamKey = activeStreams.get(channelId);

  switch (formatted.type) {
    case 'content':
      if (streamKey) {
        if (event.type === 'assistant.message_delta') {
          streaming.appendDelta(streamKey, formatted.content);
        } else if (event.type === 'assistant.message') {
          streaming.replaceContent(streamKey, formatted.content);
        }
        adapter.setTyping(channelId).catch(() => {});
      }
      break;

    case 'tool_start':
    case 'tool_complete':
      if (verbose && formatted.content) {
        if (streamKey) {
          streaming.appendDelta(streamKey, `\n\n${formatted.content}\n\n`);
        } else {
          adapter.sendMessage(channelId, formatted.content).catch(console.error);
        }
      }
      break;

    case 'error':
      if (streamKey) {
        streaming.cancelStream(streamKey, formatted.content).catch(console.error);
        activeStreams.delete(channelId);
      } else {
        adapter.sendMessage(channelId, formatted.content).catch(console.error);
      }
      break;

    case 'status':
      if (event.type === 'assistant.turn_end' || event.type === 'session.idle') {
        if (streamKey) {
          streaming.finalizeStream(streamKey).catch(console.error);
          activeStreams.delete(channelId);
        }
      }
      break;
  }
}

// Start the bridge
main().catch((err) => {
  console.error('Fatal error:', err);
  closeDb();
  process.exit(1);
});
