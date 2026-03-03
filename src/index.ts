import { loadConfig, getConfig, isConfiguredChannel, getChannelConfig } from './config.js';
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

  // Initialize channel adapters
  const adapters = new Map<string, ChannelAdapter>();
  const streamingHandlers = new Map<string, StreamingHandler>();

  for (const [platformName, platformConfig] of Object.entries(config.platforms)) {
    if (platformName === 'mattermost') {
      const adapter = new MattermostAdapter(platformName, platformConfig.url, platformConfig.botToken);
      adapters.set(platformName, adapter);

      const streaming = new StreamingHandler(adapter);
      streamingHandlers.set(platformName, streaming);
    }
    // Future: else if (platformName === 'slack') { ... }
  }

  // Wire up session events → streaming output
  sessionManager.onSessionEvent((sessionId, channelId, event) => {
    handleSessionEvent(channelId, event, adapters, streamingHandlers);
  });

  // Connect adapters and wire up message handlers
  for (const [platformName, adapter] of adapters) {
    adapter.onMessage((msg) => {
      const prev = channelLocks.get(msg.channelId) ?? Promise.resolve();
      const next = prev.then(() =>
        handleInboundMessage(msg, sessionManager, adapter, streamingHandlers.get(platformName)!)
          .catch(err => console.error(`[bridge] Unhandled error in message handler:`, err))
      );
      channelLocks.set(msg.channelId, next);
    });
    adapter.onReaction((reaction) => handleReaction(reaction, sessionManager, adapter));

    await adapter.connect();
    console.log(`  ✅ ${platformName} connected`);
  }

  console.log('🌉 copilot-bridge ready!\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🌉 Shutting down...');
    await sessionManager.shutdown();
    for (const [, adapter] of adapters) {
      await adapter.disconnect();
    }
    for (const [, streaming] of streamingHandlers) {
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
  adapter: ChannelAdapter,
  streaming: StreamingHandler,
): Promise<void> {
  // Only handle configured channels
  if (!isConfiguredChannel(msg.channelId)) return;

  const channelConfig = getChannelConfig(msg.channelId);
  const prefs = getChannelPrefs(msg.channelId);

  // Check trigger mode
  const triggerMode = prefs?.triggerMode ?? channelConfig.triggerMode;
  if (triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) return;

  // Strip bot mention from message text
  const botUserId = adapter.getBotUserId();
  let text = msg.text;
  // Remove @mention patterns
  text = text.replace(new RegExp(`@\\S+`, 'g'), (match) => {
    // Only remove the bot's mention, keep others
    if (channelConfig.botIdentity && match === channelConfig.botIdentity) return '';
    return match;
  }).trim();

  if (!text) return;

  // Check for slash commands
  const sessionInfo = sessionManager.getSessionInfo(msg.channelId);
  const effPrefs = sessionManager.getEffectivePrefs(msg.channelId);
  const cmdResult = handleCommand(msg.channelId, text, sessionInfo ?? undefined, { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode });

  if (cmdResult.handled) {
    // Determine thread root for reply
    const threadRoot = channelConfig.threadedReplies ? (msg.threadRootId ?? msg.postId) : undefined;

    // Send command response
    if (cmdResult.response) {
      await adapter.sendMessage(msg.channelId, cmdResult.response, { threadRootId: threadRoot });
    }

    // Execute command actions
    switch (cmdResult.action) {
      case 'new_session':
        // Clean up any active stream first
        const oldStreamKey = activeStreams.get(msg.channelId);
        if (oldStreamKey) {
          await streaming.cancelStream(oldStreamKey);
          activeStreams.delete(msg.channelId);
        }
        await sessionManager.newSession(msg.channelId);
        await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
        break;
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
        // Remember the last permission decision
        sessionManager.resolvePermission(msg.channelId, true, true);
        break;
    }
    return;
  }

  // Check for pending user input — if there's one, treat this message as the answer
  if (sessionManager.hasPendingUserInput(msg.channelId)) {
    sessionManager.resolveUserInput(msg.channelId, text);
    return;
  }

  // Check for pending permission — user might reply with "yes"/"no" naturally
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
    // Set typing indicator
    adapter.setTyping(msg.channelId).catch(() => {});

    // Finalize any in-flight stream before starting a new one
    const existingStreamKey = activeStreams.get(msg.channelId);
    if (existingStreamKey) {
      await streaming.finalizeStream(existingStreamKey);
      activeStreams.delete(msg.channelId);
    }

    // Start streaming response
    const threadRoot = channelConfig.threadedReplies ? (msg.threadRootId ?? msg.postId) : undefined;
    const streamKey = await streaming.startStream(msg.channelId, threadRoot);
    activeStreams.set(msg.channelId, streamKey);

    // Send to Copilot (this returns immediately; responses come via events)
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
  adapter: ChannelAdapter,
): Promise<void> {
  if (!isConfiguredChannel(reaction.channelId)) return;
  if (reaction.action !== 'added') return;

  // 👍 = approve, 👎 = deny
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
  adapters: Map<string, ChannelAdapter>,
  streamingHandlers: Map<string, StreamingHandler>,
): void {
  const channelConfig = getChannelConfig(channelId);
  const adapter = adapters.get(channelConfig.platform);
  const streaming = streamingHandlers.get(channelConfig.platform);
  if (!adapter || !streaming) return;

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

  // Skip verbose-only events if not in verbose mode
  if (formatted.verbose && !verbose) return;

  const streamKey = activeStreams.get(channelId);

  switch (formatted.type) {
    case 'content':
      if (streamKey) {
        if (event.type === 'assistant.message_delta') {
          streaming.appendDelta(streamKey, formatted.content);
        } else if (event.type === 'assistant.message') {
          // Full message replaces the stream content
          streaming.replaceContent(streamKey, formatted.content);
        }
        adapter.setTyping(channelId).catch(() => {});
      }
      break;

    case 'tool_start':
    case 'tool_complete':
      if (verbose && formatted.content) {
        // In verbose mode, append tool info to the stream
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
      // Handle turn end — finalize streaming
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
