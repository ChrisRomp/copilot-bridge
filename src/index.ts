import { loadConfig, getConfig, isConfiguredChannel, registerDynamicChannel, markChannelAsDM, getChannelConfig, getPlatformBots, getPlatformAccess, getChannelBotName, isBotAdmin, getHardcodedRules, getConfigRules, reloadConfig, ConfigWatcher } from './config.js';
import { CopilotBridge } from './core/bridge.js';
import { SessionManager, BRIDGE_CUSTOM_TOOLS } from './core/session-manager.js';
import { handleCommand, parseCommand } from './core/command-handler.js';
import { formatEvent, formatPermissionRequest, formatUserInputRequest } from './core/stream-formatter.js';
import { WorkspaceWatcher, initWorkspace, getWorkspacePath } from './core/workspace-manager.js';
import { MattermostAdapter } from './channels/mattermost/adapter.js';
import { StreamingHandler } from './channels/mattermost/streaming.js';
import { getChannelPrefs, setChannelPrefs, getAllChannelSessions, closeDb, listPermissionRulesForScope, removePermissionRule, clearPermissionRules, getTaskHistory } from './state/store.js';
import { extractThreadRequest, resolveThreadRoot } from './core/thread-utils.js';
import { initScheduler, stopAll as stopScheduler, listJobs, removeJob, pauseJob, resumeJob, formatInTimezone, describeCron } from './core/scheduler.js';
import { markBusy, markIdle, markIdleImmediate, isBusy, waitForChannelIdle, cancelIdleDebounce } from './core/channel-idle.js';
import { LoopDetector, MAX_IDENTICAL_CALLS } from './core/loop-detector.js';
import { checkUserAccess } from './core/access-control.js';
import { createLogger, setLogLevel } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelAdapter, AdapterFactory, InboundMessage, InboundReaction, MessageAttachment, AppConfig } from './types.js';

const log = createLogger('bridge');

// Active streaming responses, keyed by channelId
const activeStreams = new Map<string, string>(); // channelId → streamKey

// Preserve thread context across turn_end stream finalization so auto-started
// streams stay in the same thread.
const channelThreadRoots = new Map<string, string>(); // channelId → threadRootId

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

// Track last known sessionId per channel for implicit session change detection
const lastSessionIds = new Map<string, string>();

// Channels that have had their plan surfaced after session resume (one-time)
const planSurfacedOnResume = new Set<string>();

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

/** Max message size per platform. Conservative defaults — Slack blocks are 3000 but we allow some overhead. */
function getMaxMessageLength(platform: string): number {
  switch (platform) {
    case 'slack': return 3500;
    case 'mattermost': return 16000;
    default: return 4000;
  }
}

/**
 * Split content into chunks that fit within a platform's message size limit.
 * Splits at heading boundaries (## ) when possible, otherwise at line boundaries.
 */
function chunkContent(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) return [content];

  const lines = content.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for newline
    // Start new chunk at ## heading if adding this line would exceed limit
    if (line.startsWith('## ') && current.length > 0 && currentLen + lineLen > maxLen) {
      chunks.push(current.join('\n'));
      current = [line];
      currentLen = lineLen;
    } else if (currentLen + lineLen > maxLen && current.length > 0) {
      // Mid-section split at line boundary
      chunks.push(current.join('\n'));
      current = [line];
      currentLen = lineLen;
    } else {
      current.push(line);
      currentLen += lineLen;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  // Safety: hard-truncate any chunk that still exceeds maxLen (e.g. single very long line)
  return chunks.map(c => c.length > maxLen ? c.slice(0, maxLen - 3) + '...' : c);
}

/** Send content that may exceed platform message limits, chunking with part labels as needed. */
async function sendChunked(
  adapter: ChannelAdapter,
  channelId: string,
  content: string,
  platform: string,
  opts?: { threadRootId?: string; header?: string },
): Promise<void> {
  const maxLen = getMaxMessageLength(platform);
  const header = opts?.header ? opts.header + '\n\n' : '';
  const headerLen = header.length;

  // Try to fit in one message
  if (headerLen + content.length <= maxLen) {
    await adapter.sendMessage(channelId, header + content, { threadRootId: opts?.threadRootId });
    return;
  }

  // Chunk the content (reserve space for part label + header in first chunk)
  const labelReserve = 30; // "_(Part XX of XX)_\n"
  const effectiveMax = maxLen - labelReserve - headerLen;
  const chunks = chunkContent(content, effectiveMax);
  const total = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const label = total > 1 ? `_(Part ${i + 1} of ${total})_\n` : '';
    const prefix = i === 0 ? header : '';
    await adapter.sendMessage(channelId, prefix + label + chunks[i].trim(), { threadRootId: opts?.threadRootId });
  }
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

const SLACK_UID_PATTERN = /^U[A-Z0-9]{6,}$/;

/**
 * Resolve non-UID entries in Slack bot access configs.
 * Handles added manually as usernames are looked up via Slack API (with pagination) and replaced with UIDs.
 */
async function resolveSlackAccessUsers(config: AppConfig): Promise<void> {
  const slackPlatform = config.platforms.slack;
  if (!slackPlatform?.bots) return;

  // Collect all access configs that need resolution: platform-level + per-bot
  const accessTargets: { label: string; access: NonNullable<typeof slackPlatform.access>; tokenSource: string }[] = [];
  const firstBotToken = Object.values(slackPlatform.bots)[0]?.token;

  if (slackPlatform.access?.users?.length && firstBotToken) {
    accessTargets.push({ label: 'platform "slack"', access: slackPlatform.access, tokenSource: firstBotToken });
  }
  for (const [botName, bot] of Object.entries(slackPlatform.bots)) {
    if (bot.access?.users?.length) {
      accessTargets.push({ label: `bot "${botName}"`, access: bot.access, tokenSource: bot.token });
    }
  }
  if (accessTargets.length === 0) return;

  // Deduplicate API calls — group by token
  const membersByToken = new Map<string, any[]>();
  for (const target of accessTargets) {
    if (membersByToken.has(target.tokenSource)) continue;

    const unresolved = target.access.users!.filter(u => !SLACK_UID_PATTERN.test(u));
    if (unresolved.length === 0) continue;

    const allMembers: any[] = [];
    try {
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: '200' });
        if (cursor) params.set('cursor', cursor);
        const resp = await fetch(`https://slack.com/api/users.list?${params}`, {
          headers: { 'Authorization': `Bearer ${target.tokenSource}` },
        });
        if (!resp.ok) { log.warn(`  Slack users.list failed: HTTP ${resp.status}`); break; }
        const data = await resp.json() as any;
        if (!data.ok) { log.warn(`  Slack users.list failed: ${data.error}`); break; }
        for (const m of data.members ?? []) allMembers.push(m);
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err: any) {
      log.warn(`  Failed to fetch Slack users: ${err.message}`);
    }
    membersByToken.set(target.tokenSource, allMembers);
  }

  // Resolve each access config
  for (const target of accessTargets) {
    const unresolved = target.access.users!.filter(u => !SLACK_UID_PATTERN.test(u));
    if (unresolved.length === 0) continue;

    log.info(`Resolving ${unresolved.length} Slack handle(s) for ${target.label} access list...`);
    const allMembers = membersByToken.get(target.tokenSource) ?? [];

    // Build lookup map for O(1) resolution
    const nameMap = new Map<string, string>();
    const displayMap = new Map<string, string>();
    for (const m of allMembers) {
      if (m.deleted || m.is_bot) continue;
      const name = (m.name ?? '').toLowerCase();
      if (name) nameMap.set(name, m.id);
      const displayName = m.profile?.display_name_normalized?.toLowerCase() ?? '';
      if (displayName) displayMap.set(displayName, m.id);
      const realName = m.profile?.real_name_normalized?.toLowerCase() ?? '';
      if (realName) displayMap.set(realName, m.id);
    }

    const resolved: string[] = [];
    for (const handle of unresolved) {
      const normalized = handle.replace(/^@/, '').toLowerCase();
      const byName = nameMap.get(normalized);
      if (byName) {
        log.info(`  Resolved "${handle}" → ${byName} (by handle)`);
        resolved.push(byName);
      } else {
        const byDisplay = displayMap.get(normalized);
        if (byDisplay) {
          log.warn(`  Resolved "${handle}" → ${byDisplay} (by display/real name — consider using the exact Slack handle for reliability)`);
          resolved.push(byDisplay);
        } else {
          log.warn(`  Could not resolve Slack handle "${handle}" — keeping as-is`);
          resolved.push(handle);
        }
      }
    }

    const uidEntries = target.access.users!.filter(u => SLACK_UID_PATTERN.test(u));
    target.access.users = [...uidEntries, ...resolved];
  }
}

async function main(): Promise<void> {
  log.info('copilot-bridge starting...');

  // Load configuration
  const config = loadConfig();
  setLogLevel(config.logLevel ?? 'info');
  log.info(`Loaded ${config.channels.length} channel mapping(s)`);

  // Start config file watcher for hot-reload
  const configWatcher = new ConfigWatcher();
  configWatcher.onReload((result) => {
    if (!result.success) return;
    // Re-apply logLevel in case config changed it
    setLogLevel(getConfig().logLevel ?? 'info');
    // Re-resolve Slack access handles after reload (config was re-read from disk).
    // Fires asynchronously — messages during resolution use the old resolved values.
    void (async () => {
      try { await resolveSlackAccessUsers(getConfig()); }
      catch (err: any) { log.warn(`Slack access resolution after reload failed: ${err.message}`); }
    })();
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
    const bots = getPlatformBots(platformName);
    for (const [botName, botInfo] of bots) {
      const key = `${platformName}:${botName}`;
      let adapter: ChannelAdapter;

      if (platformName === 'slack') {
        // Slack needs appToken for Socket Mode — construct directly
        if (!botInfo.appToken) {
          log.error(`Slack bot "${botName}" missing appToken — skipping`);
          continue;
        }
        try {
          const { SlackAdapter } = await import('./channels/slack/adapter.js');
          adapter = new SlackAdapter({
            platformName,
            botToken: botInfo.token,
            appToken: botInfo.appToken,
          });
        } catch (err: any) {
          log.error(`Failed to load Slack adapter: ${err.message}`);
          continue;
        }
      } else {
        const factory = adapterFactories[platformName];
        if (!factory) {
          log.warn(`No adapter for platform "${platformName}" — skipping`);
          break; // skip all bots for this platform
        }
        adapter = factory(platformName, platformConfig.url ?? '', botInfo.token);
      }

      botAdapters.set(key, adapter);
      botStreamers.set(key, new StreamingHandler(adapter));
      log.info(`Registered bot "${botName}" for ${platformName}`);
    }
  }

  // Resolve non-UID Slack access entries at startup
  await resolveSlackAccessUsers(config);

  // Wire up session events → streaming output (serialized per channel)
  sessionManager.onSessionEvent((sessionId, channelId, event) => {
    const prev = eventLocks.get(channelId) ?? Promise.resolve();
    const next = prev.then(() =>
      handleSessionEvent(sessionId, channelId, event, sessionManager)
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
    adapter.onReaction((reaction) => handleReaction(reaction, sessionManager, platformName, botName));

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

  // Check user-level access control
  const botInfo = getPlatformBots(platformName).get(botName);
  if (!checkUserAccess(msg.userId, msg.username, botInfo?.access, getPlatformAccess(platformName))) {
    log.debug(`User ${msg.username} (${msg.userId}) denied mid-turn access to bot "${botName}"`);
    return;
  }

  if (!isConfiguredChannel(msg.channelId)) return;

  const assignedBot = getChannelBotName(msg.channelId);
  if (assignedBot && assignedBot !== botName) return;

  const resolved = getAdapterForChannel(msg.channelId);
  if (!resolved) return;
  const { adapter } = resolved;

  const channelConfig = getChannelConfig(msg.channelId);

  // Respect trigger mode — don't steer on unmentioned messages in mention-only channels
  if (channelConfig.triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) {
    log.debug(`Ignoring mid-turn message (trigger=mention, no mention) in ${msg.channelId.slice(0, 8)}...`);
    return;
  }

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
    if (lower === '/remember' || lower === '/always approve') {
      if (sessionManager.isHookPermission(msg.channelId)) {
        sessionManager.resolvePermission(msg.channelId, true);
      } else {
        sessionManager.resolvePermission(msg.channelId, true, true);
      }
      return;
    }
    if (lower === '/always deny') {
      if (sessionManager.isHookPermission(msg.channelId)) {
        sessionManager.resolvePermission(msg.channelId, false);
      } else {
        sessionManager.resolvePermission(msg.channelId, false, true);
      }
      return;
    }
    // Unrecognized text or slash commands — auto-deny the permission and
    // fall through to process the message normally (mid-turn steering or command).
    sessionManager.resolvePermission(msg.channelId, false);
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
      channelThreadRoots.delete(msg.channelId);
      await finalizeActivityFeed(msg.channelId, adapter);
      await sessionManager.abortSession(msg.channelId);
      // Revert yolo if temporarily enabled for plan implementation
      sessionManager.revertYoloIfNeeded(msg.channelId);
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
      channelThreadRoots.delete(msg.channelId);
      await finalizeActivityFeed(msg.channelId, adapter);
      loopDetector.reset(msg.channelId);
      planSurfacedOnResume.delete(msg.channelId);
      await sessionManager.newSession(msg.channelId);
      markIdleImmediate(msg.channelId);
      await adapter.sendMessage(msg.channelId, '✅ New session created.', { threadRootId: threadRoot });
      return;
    }

    // Read-only / toggle commands — safe to handle mid-turn
    // Only commands where handleCommand returns a complete response (no separate action rendering).
    // Commands with complex action handlers (skills, schedule, rules) defer to serialized path.
    const SAFE_MID_TURN = new Set([
      'context', 'status', 'help', 'verbose', 'yolo',
      'model', 'models', 'agents',
      'streamer-mode', 'on-air',
    ]);

    if (SAFE_MID_TURN.has(parsed.command)) {
      // Build the same inputs that handleInboundMessage would
      const sessionInfo = sessionManager.getSessionInfo(msg.channelId);
      const effPrefs = sessionManager.getEffectivePrefs(msg.channelId);
      let models: any[] | undefined;
      if (['model', 'models', 'status'].includes(parsed.command)) {
        try { models = await sessionManager.listModels(); } catch { models = undefined; }
      }
      const mcpInfo = undefined;
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
        // handleCommand already persists some prefs (verbose, yolo, reasoning) via setChannelPrefs
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

  // Check user-level access control (reads live config — hot-reloadable)
  const botInfo = getPlatformBots(platformName).get(botName);
  if (!checkUserAccess(msg.userId, msg.username, botInfo?.access, getPlatformAccess(platformName))) {
    log.debug(`User ${msg.username} (${msg.userId}) denied access to bot "${botName}"`);
    return; // silent drop
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
  if (triggerMode === 'mention' && !msg.mentionsBot && !msg.isDM) {
    log.debug(`Ignoring message (trigger=mention, no mention) in ${msg.channelId.slice(0, 8)}...`);
    return;
  }

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

  // Get cached context usage for /context and /status
  const contextUsage = sessionManager.getContextUsage(msg.channelId);

  const cmdResult = handleCommand(
    msg.channelId, text, sessionInfo ?? undefined,
    { verbose: effPrefs.verbose, permissionMode: effPrefs.permissionMode, reasoningEffort: effPrefs.reasoningEffort },
    { workingDirectory: channelConfig.workingDirectory, bot: channelConfig.bot },
    models,
    undefined,
    contextUsage,
  );

  if (cmdResult.handled) {
    const threadRoot = resolveThreadRoot(msg, threadRequested, channelConfig);

    // Send response before action, except for actions that send their own ack after completing
    const deferResponse = cmdResult.action === 'switch_model' || cmdResult.action === 'switch_agent' || cmdResult.action === 'set_reasoning';
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
        channelThreadRoots.delete(msg.channelId);
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
        channelThreadRoots.delete(msg.channelId);
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
        } else {
          // Re-apply logLevel after manual reload
          setLogLevel(getConfig().logLevel ?? 'info');
          if (result.changes.length === 0 && result.restartNeeded.length === 0) {
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
          const prefix = cmdResult.payload as string;
          const matches = await sessionManager.resolveSessionPrefix(msg.channelId, prefix);
          if (matches.length === 0) {
            await adapter.updateMessage(msg.channelId, resumeAck, `❌ No session found matching prefix \`${prefix}\``);
            break;
          }
          if (matches.length > 1) {
            const list = matches.map((id: string) => `• \`${id.slice(0, 12)}\``).join('\n');
            await adapter.updateMessage(msg.channelId, resumeAck, `⚠️ Ambiguous prefix \`${prefix}\` — matches multiple sessions:\n${list}\nPlease provide a longer prefix.`);
            break;
          }
          const resumedId = await sessionManager.resumeToSession(msg.channelId, matches[0]);
          await adapter.updateMessage(msg.channelId, resumeAck, `✅ Resumed session \`${resumedId.slice(0, 8)}…\``);
          // Surface existing plan after resume — only when in plan mode
          try {
            const mode = await sessionManager.getSessionMode(msg.channelId);
            if (mode === 'plan') {
              const plan = await sessionManager.readPlan(msg.channelId);
              if (plan.exists && plan.content) {
                planSurfacedOnResume.add(msg.channelId);
                const summary = sessionManager.extractPlanSummary(plan.content);
                await adapter.sendMessage(msg.channelId,
                  `📋 **Existing plan found** — ${summary}. \`/plan show\` to review, \`/plan clear\` to discard.`,
                  { threadRootId: threadRoot });
              }
            }
          } catch { /* plan surfacing is best-effort */ }
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
      case 'set_reasoning': {
        const reasoningSessionId = sessionManager.getSessionId(msg.channelId);
        if (!reasoningSessionId) {
          // No active session — pref is saved, will apply on next session creation
          await adapter.sendMessage(msg.channelId, `🧠 Reasoning effort set to **${cmdResult.payload}**. Will apply when a session starts.`, { threadRootId: threadRoot });
          break;
        }
        const ackId = await adapter.sendMessage(msg.channelId, `🧠 Setting reasoning effort to **${cmdResult.payload}**...`, { threadRootId: threadRoot });
        try {
          const newId = await sessionManager.reloadSession(msg.channelId);
          const wasNew = newId !== reasoningSessionId;
          const suffix = wasNew ? ' (previous session expired — new session created)' : '';
          await adapter.updateMessage(msg.channelId, ackId, `🧠 Reasoning effort set to **${cmdResult.payload}**.${suffix}`);
        } catch (err: any) {
          log.error(`Failed to reload session for reasoning on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.updateMessage(msg.channelId, ackId, `🧠 Reasoning effort saved as **${cmdResult.payload}** but session reload failed. Use \`/reload\` to apply.`);
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
      case 'remember_deny':
        if (!sessionManager.resolvePermission(msg.channelId, false, true)) {
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
        const hooksInfo = sessionManager.getHooksInfo(msg.channelId);
        const lines: string[] = ['🧰 **Skills & Tools**', ''];

        if (skills.length > 0) {
          const active = skills.filter(s => !s.disabled);
          const disabled = skills.filter(s => s.disabled);

          if (active.length > 0) {
            lines.push('🟢 **Active Skills**');
            for (const s of active) {
              const desc = s.description ? ` — ${s.description}` : '';
              const flag = s.pending ? ' ⏳ _reload to activate_' : '';
              lines.push(`• \`${s.name}\`${desc} _(${s.source})_${flag}`);
            }
            lines.push('');
          }

          if (disabled.length > 0) {
            lines.push('🔴 **Disabled Skills**');
            for (const s of disabled) {
              const desc = s.description ? ` — ${s.description}` : '';
              lines.push(`• \`${s.name}\`${desc} _(${s.source})_`);
            }
            lines.push('');
          }
        }

        if (mcpInfo.length > 0) {
          lines.push('**MCP Servers**');
          for (const s of mcpInfo) {
            const flag = s.pending ? ' ⏳ _reload to activate_' : '';
            lines.push(`• \`${s.name}\` _(${s.source})_${flag}`);
          }
          lines.push('');
        }

        if (hooksInfo.length > 0) {
          lines.push('**Hooks**');
          for (const h of hooksInfo) {
            const count = h.commandCount > 1 ? ` (${h.commandCount} commands)` : '';
            lines.push(`• \`${h.hookType}\`${count} _(${h.source})_`);
          }
          lines.push('');
        }

        // Fetch built-in tools from SDK
        const sdkTools = await sessionManager.listSessionTools(msg.channelId);
        if (sdkTools.length > 0) {
          lines.push(`**Built-in Tools** (${sdkTools.length})`);
          lines.push(sdkTools.map(t => `\`${t.name}\``).sort().join(', '));
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

      case 'skill_toggle': {
        const { action: toggleAction, targets } = cmdResult.payload as { action: 'enable' | 'disable'; targets: string[] };
        const skills = sessionManager.getSkillInfo(msg.channelId);
        const prefs = getChannelPrefs(msg.channelId);
        const currentDisabled = new Set(prefs?.disabledSkills ?? []);

        // Handle "all" keyword (only valid as sole target)
        if (targets.some(t => t.toLowerCase() === 'all')) {
          if (targets.length > 1) {
            await adapter.sendMessage(msg.channelId, '⚠️ `all` cannot be combined with other skill names.', { threadRootId: threadRoot });
            break;
          }
          if (toggleAction === 'disable') {
            const allNames = [...new Set(skills.map(s => s.name))];
            setChannelPrefs(msg.channelId, { disabledSkills: allNames });
            await adapter.sendMessage(msg.channelId, `🔴 Disabled all ${allNames.length} skills. Use \`/reload\` to apply.`, { threadRootId: threadRoot });
          } else {
            setChannelPrefs(msg.channelId, { disabledSkills: [] });
            await adapter.sendMessage(msg.channelId, `🟢 Enabled all skills. Use \`/reload\` to apply.`, { threadRootId: threadRoot });
          }
          break;
        }

        const matched: string[] = [];
        const notFound: string[] = [];
        const ambiguous: string[] = [];

        for (const target of targets) {
          const lower = target.toLowerCase();
          const exact = skills.find(s => s.name.toLowerCase() === lower);
          if (exact) {
            if (toggleAction === 'disable') currentDisabled.add(exact.name);
            else currentDisabled.delete(exact.name);
            matched.push(exact.name);
            continue;
          }
          const substringMatches = skills.filter(s => s.name.toLowerCase().includes(lower));
          if (substringMatches.length === 1) {
            const skill = substringMatches[0];
            if (toggleAction === 'disable') currentDisabled.add(skill.name);
            else currentDisabled.delete(skill.name);
            matched.push(skill.name);
          } else if (substringMatches.length > 1) {
            ambiguous.push(`"${target}" matches: ${substringMatches.map(s => `\`${s.name}\``).join(', ')}`);
          } else {
            notFound.push(target);
          }
        }

        if (matched.length > 0) {
          setChannelPrefs(msg.channelId, { disabledSkills: [...currentDisabled] });
        }

        const lines: string[] = [];
        if (matched.length > 0) {
          const verb = toggleAction === 'disable' ? '🔴 Disabled' : '🟢 Enabled';
          const names = matched.map(n => `\`${n}\``).join(', ');
          lines.push(`${verb} ${names}.`);
        }
        if (ambiguous.length > 0) {
          lines.push(`⚠️ Ambiguous: ${ambiguous.join('; ')}`);
        }
        if (notFound.length > 0) {
          lines.push(`❌ No match: ${notFound.map(n => `"${n}"`).join(', ')}`);
        }
        if (matched.length > 0) {
          lines.push('Use `/reload` to apply.');
        }
        await adapter.sendMessage(msg.channelId, lines.join(' '), { threadRootId: threadRoot });
        break;
      }

      case 'mcp': {
        const mcpInfo = sessionManager.getMcpServerInfo(msg.channelId);
        if (mcpInfo.length === 0) {
          await adapter.sendMessage(msg.channelId, '🔌 No MCP servers configured.', { threadRootId: threadRoot });
          break;
        }
        const userServers = mcpInfo.filter(s => s.source === 'user');
        const workspaceServers = mcpInfo.filter(s => s.source === 'workspace');
        const overrideServers = mcpInfo.filter(s => s.source === 'workspace (override)');
        const lines = ['🔌 **MCP Servers**', ''];
        if (userServers.length > 0) {
          lines.push('**User** (plugin + user config)');
          for (const s of userServers) {
            const flag = s.pending ? ' ⏳ _reload to activate_' : '';
            lines.push(`• \`${s.name}\`${flag}`);
          }
          lines.push('');
        }
        if (workspaceServers.length > 0) {
          lines.push('**Workspace**');
          for (const s of workspaceServers) {
            const flag = s.pending ? ' ⏳ _reload to activate_' : '';
            lines.push(`• \`${s.name}\`${flag}`);
          }
          lines.push('');
        }
        if (overrideServers.length > 0) {
          lines.push('**Workspace (overriding user)**');
          for (const s of overrideServers) {
            const flag = s.pending ? ' ⏳ _reload to activate_' : '';
            lines.push(`• \`${s.name}\`${flag}`);
          }
          lines.push('');
        }
        lines.push(`Total: ${mcpInfo.length} server(s)`);

        await adapter.sendMessage(msg.channelId, lines.join('\n'), { threadRootId: threadRoot });
        break;
      }

      case 'plan': {
        const subcommand = cmdResult.payload?.toLowerCase();
        try {
          if (subcommand === 'show' || subcommand === 'view') {
            const plan = await sessionManager.readPlan(msg.channelId);
            if (!plan.exists || !plan.content) {
              await adapter.sendMessage(msg.channelId, '📋 No plan exists for this session.', { threadRootId: threadRoot });
            } else {
              await sendChunked(adapter, msg.channelId, plan.content, channelConfig.platform, {
                threadRootId: threadRoot,
                header: '📋 **Current Plan**',
              });
            }
          } else if (subcommand === 'clear' || subcommand === 'delete') {
            const deleted = await sessionManager.deletePlan(msg.channelId);
            await adapter.sendMessage(msg.channelId,
              deleted ? '📋 Plan cleared.' : '📋 No plan to clear.',
              { threadRootId: threadRoot });
          } else if (subcommand === 'summary') {
            // Ensure session is attached (handles post-restart state)
            const currentMode = await sessionManager.getSessionMode(msg.channelId) as 'interactive' | 'plan' | 'autopilot';
            await sessionManager.setSessionMode(msg.channelId, currentMode ?? 'interactive');

            const plan = await sessionManager.readPlan(msg.channelId);
            if (!plan.exists || !plan.content) {
              await adapter.sendMessage(msg.channelId, '📋 No plan exists for this session.', { threadRootId: threadRoot });
            } else {
              // Ephemeral session summarization — doesn't pollute main conversation
              await adapter.sendMessage(msg.channelId, '📋 Summarizing plan...', { threadRootId: threadRoot });
              const summary = await sessionManager.summarizePlan(msg.channelId);
              if (summary) {
                await adapter.sendMessage(msg.channelId, `📋 **Plan summary:**\n\n${summary}\n\n\`/plan show\` to view the full plan.`, { threadRootId: threadRoot });
              } else {
                // Fallback to structural extraction if ephemeral session fails
                const fallback = sessionManager.extractPlanSummary(plan.content);
                await adapter.sendMessage(msg.channelId, `📋 ${fallback}\n\n\`/plan show\` to view the full plan.`, { threadRootId: threadRoot });
              }
            }
          } else if (subcommand === 'off') {
            await sessionManager.setSessionMode(msg.channelId, 'interactive');
            await adapter.sendMessage(msg.channelId, '📋 **Plan mode off** — back to interactive mode.', { threadRootId: threadRoot });
          } else if (subcommand === 'on') {
            // Set mode first (ensures session is attached after restart), then check for existing plan
            await sessionManager.setSessionMode(msg.channelId, 'plan');
            const existingPlan = await sessionManager.readPlan(msg.channelId);
            planSurfacedOnResume.add(msg.channelId);
            if (existingPlan.exists && existingPlan.content) {
              const summary = sessionManager.extractPlanSummary(existingPlan.content);
              await adapter.sendMessage(msg.channelId,
                `📋 **Existing plan found** — ${summary}\n\n\`/plan show\` to review the full plan.\n\`/plan clear\` to discard and start fresh.\n\nEntering plan mode with existing plan.`,
                { threadRootId: threadRoot });
            } else {
              await adapter.sendMessage(msg.channelId,
                '📋 **Plan mode on** — messages will be handled as planning requests. The agent will create and update a plan before implementing.\n\nUse `/plan show` to view the plan, `/plan` to toggle off.',
                { threadRootId: threadRoot });
            }
          } else if (!subcommand) {
            // Toggle: check current mode and flip
            const current = await sessionManager.getSessionMode(msg.channelId);
            if (current === 'plan') {
              await sessionManager.setSessionMode(msg.channelId, 'interactive');
              await adapter.sendMessage(msg.channelId, '📋 **Plan mode off** — back to interactive mode.', { threadRootId: threadRoot });
            } else {
              // Set mode first (ensures session is attached after restart), then check for existing plan
              await sessionManager.setSessionMode(msg.channelId, 'plan');
              const existingPlan = await sessionManager.readPlan(msg.channelId);
              planSurfacedOnResume.add(msg.channelId);
              if (existingPlan.exists && existingPlan.content) {
                const summary = sessionManager.extractPlanSummary(existingPlan.content);
                await adapter.sendMessage(msg.channelId,
                  `📋 **Existing plan found** — ${summary}\n\n\`/plan show\` to review the full plan.\n\`/plan clear\` to discard and start fresh.\n\nEntering plan mode with existing plan.`,
                  { threadRootId: threadRoot });
              } else {
                await adapter.sendMessage(msg.channelId,
                  '📋 **Plan mode on** — messages will be handled as planning requests. The agent will create and update a plan before implementing.\n\nUse `/plan show` to view the plan, `/plan` to toggle off.',
                  { threadRootId: threadRoot });
              }
            }
          } else {
            await adapter.sendMessage(msg.channelId, '⚠️ Usage: `/plan` (toggle), `/plan show`, `/plan summary`, `/plan clear`, `/plan on`, `/plan off`', { threadRootId: threadRoot });
          }
        } catch (err: any) {
          log.error(`Failed to handle /plan ${subcommand ?? '(toggle)'} on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.sendMessage(msg.channelId, `❌ Failed: ${err?.message ?? 'unknown error'}`, { threadRootId: threadRoot });
        }
        break;
      }

      case 'implement': {
        try {
          const arg = cmdResult.payload?.toLowerCase();
          const enableYolo = arg === 'yolo';
          const interactive = arg === 'interactive';

          // Set mode first (ensures session is attached after restart).
          // For interactive, this is a no-op on mode; for autopilot, we revert below if no plan.
          const targetMode = interactive ? 'interactive' : 'autopilot';
          await sessionManager.setSessionMode(msg.channelId, targetMode);

          // Now read plan (session is guaranteed to be attached)
          const plan = await sessionManager.readPlan(msg.channelId);
          if (!plan.exists || !plan.content) {
            // Revert mode back to interactive if we set autopilot
            if (!interactive) await sessionManager.setSessionMode(msg.channelId, 'interactive');
            await adapter.sendMessage(msg.channelId, '📋 No plan exists. Create one first with `/plan on`.', { threadRootId: threadRoot });
            break;
          }

          // Save yolo state before changing it
          if (enableYolo) {
            sessionManager.saveYoloPreviousState(msg.channelId);
            setChannelPrefs(msg.channelId, { permissionMode: 'autopilot' });
          }

          const modeLabel = interactive ? 'interactive' : enableYolo ? 'autopilot + yolo' : 'autopilot';
          await adapter.sendMessage(msg.channelId,
            `🚀 **Implementing plan** (${modeLabel})`,
            { threadRootId: threadRoot });

          // Clear pending plan exit if one was waiting
          sessionManager.consumePendingPlanExit(msg.channelId);

          // Set up stream and hold channel lock (matches regular message flow)
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

          markBusy(msg.channelId);

          // Send plan content as a synthetic message to kick off implementation
          const kickoff = `Implement the following plan:\n\n${plan.content}`;
          await sessionManager.sendMessage(msg.channelId, kickoff);
          await waitForChannelIdle(msg.channelId);
        } catch (err: any) {
          sessionManager.revertYoloIfNeeded(msg.channelId);
          markIdleImmediate(msg.channelId);
          const sk = activeStreams.get(msg.channelId);
          if (sk) { await streaming.cancelStream(sk); activeStreams.delete(msg.channelId); }
          log.error(`Failed to handle /implement on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.sendMessage(msg.channelId, `❌ Failed: ${err?.message ?? 'unknown error'}`, { threadRootId: threadRoot });
        }
        break;
      }

      case 'toggle_autopilot': {
        try {
          const current = await sessionManager.getSessionMode(msg.channelId);
          if (current === 'autopilot') {
            await sessionManager.setSessionMode(msg.channelId, 'interactive');
            await adapter.sendMessage(msg.channelId,
              '🛡️ **Autopilot off** — back to interactive mode.',
              { threadRootId: threadRoot });
          } else {
            await sessionManager.setSessionMode(msg.channelId, 'autopilot');
            const prefs = sessionManager.getEffectivePrefs(msg.channelId);
            const yoloWarning = prefs.permissionMode !== 'autopilot'
              ? '\n\n⚠️ Yolo is off — you\'ll still be prompted for tool permissions. Use `/yolo` to auto-approve.'
              : '';
            await adapter.sendMessage(msg.channelId,
              `🤖 **Autopilot enabled** — autonomous agentic loop. Use \`/autopilot\` to toggle off.${yoloWarning}`,
              { threadRootId: threadRoot });
          }
        } catch (err: any) {
          log.error(`Failed to toggle autopilot on ${msg.channelId.slice(0, 8)}...:`, err);
          await adapter.sendMessage(msg.channelId, `❌ Failed: ${err?.message ?? 'unknown error'}`, { threadRootId: threadRoot });
        }
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
    // Unrecognized text — auto-deny and fall through to process as a normal message
    sessionManager.resolvePermission(msg.channelId, false);
  }

  // Pending plan exit — auto-dismiss on unrecognized text, process message normally
  if (sessionManager.hasPendingPlanExit(msg.channelId)) {
    sessionManager.consumePendingPlanExit(msg.channelId);
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

    // One-time plan surfacing after session resume — only when in plan mode (best-effort, non-blocking)
    if (!planSurfacedOnResume.has(msg.channelId)) {
      planSurfacedOnResume.add(msg.channelId);
      sessionManager.surfacePlanIfExists(msg.channelId).then(async (result) => {
        if (result?.exists && result.inPlanMode) {
          const threadRootForPlan = channelThreadRoots.get(msg.channelId);
          await adapter.sendMessage(msg.channelId,
            `📋 **Existing plan found** — ${result.summary}. \`/plan show\` to review.`,
            { threadRootId: threadRootForPlan });
        }
      }).catch(() => { /* best-effort */ });
    }

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
  platformName: string,
  botName: string,
): Promise<void> {
  if (!isConfiguredChannel(reaction.channelId)) return;
  if (reaction.action !== 'added') return;

  // Check user-level access control
  const botInfo = getPlatformBots(platformName).get(botName);
  if (!checkUserAccess(reaction.userId, reaction.username ?? reaction.userId, botInfo?.access, getPlatformAccess(platformName))) {
    log.debug(`User ${reaction.username ?? reaction.userId} denied reaction access to bot "${botName}"`);
    return;
  }

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
    const isHook = sessionManager.isHookPermission(reaction.channelId);
    if (sessionManager.resolvePermission(reaction.channelId, true, !isHook)) {
      await adapter.sendMessage(reaction.channelId, isHook ? '✅ Approved via reaction.' : '💾 Approved + remembered via reaction.');
    }
  } else if (reaction.emoji === 'no_entry_sign') {
    const isHook = sessionManager.isHookPermission(reaction.channelId);
    if (sessionManager.resolvePermission(reaction.channelId, false, !isHook)) {
      await adapter.sendMessage(reaction.channelId, isHook ? '❌ Denied via reaction.' : '🚫 Denied + remembered via reaction.');
    }
  }
}

// --- Session Event Handling ---

async function handleSessionEvent(
  sessionId: string,
  channelId: string,
  event: any,
  sessionManager: SessionManager,
): Promise<void> {
  // Reset loop detector when the session changes (e.g., model fallback creates new session)
  const prevSession = lastSessionIds.get(channelId);
  if (prevSession && prevSession !== sessionId) {
    loopDetector.reset(channelId);
  }
  lastSessionIds.set(channelId, sessionId);

  if (event.type === 'session.error' || event.type?.includes('error')) {
    log.error(`SDK error event: ${JSON.stringify(event).slice(0, 1000)}`);
  }

  // Log compaction events
  if (event.type === 'session.compaction_start') {
    log.info(`[${channelId}] Context compaction started`);
  } else if (event.type === 'session.compaction_complete') {
    const d = event.data ?? {};
    log.info(`[${channelId}] Context compaction complete: success=${d.success}, tokens removed=${d.tokensRemoved ?? '?'}, messages removed=${d.messagesRemoved ?? '?'}, checkpoint=#${d.checkpointNumber ?? '?'}`);
    if (d.preCompactionTokens != null || d.postCompactionTokens != null) {
      log.debug(`[${channelId}] Compaction detail: ${d.preCompactionTokens} → ${d.postCompactionTokens} tokens`);
    }
  }

  // Verbose SDK event logging
  if (event.type === 'assistant.message_delta' || event.type === 'assistant.streaming_delta') {
    log.debug(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`);
  } else if (event.type === 'assistant.message') {
    log.debug(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 400)}`);
  } else if (event.type?.startsWith('tool.')) {
    log.info(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 400)}`);
  } else if (event.type === 'session.usage_info') {
    log.debug(`SDK ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`);
  } else if (event.type === 'session.compaction_start' || event.type === 'session.compaction_complete') {
    // Already logged above; skip duplicate debug line
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
    const threadRootId = streamKey ? streaming.getStreamThreadRootId(streamKey) : undefined;
    if (threadRootId) channelThreadRoots.set(channelId, threadRootId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    await finalizeActivityFeed(channelId, adapter);
    const { toolName, serverName, input, commands, hookReason, fromHook } = event.data;
    const formatted = formatPermissionRequest(toolName, input, commands, serverName, hookReason, fromHook);
    await adapter.sendMessage(channelId, formatted, { threadRootId });
    return;
  }

  if (event.type === 'bridge.user_input_request') {
    const streamKey = activeStreams.get(channelId);
    const threadRootId = streamKey ? streaming.getStreamThreadRootId(streamKey) : undefined;
    if (threadRootId) channelThreadRoots.set(channelId, threadRootId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    await finalizeActivityFeed(channelId, adapter);
    const { question, choices } = event.data;
    const formatted = formatUserInputRequest(question, choices);
    await adapter.sendMessage(channelId, formatted, { threadRootId });
    return;
  }

  // Handle plan_changed events — debounced summary surfacing
  if (event.type === 'session.plan_changed') {
    const operation = event.data?.operation;
    if (operation === 'create' || operation === 'update') {
      sessionManager.debouncePlanChanged(channelId, async () => {
        try {
          const plan = await sessionManager.readPlan(channelId);
          if (!plan.exists || !plan.content) return;
          const summary = sessionManager.extractPlanSummary(plan.content);
          const threadRootId = channelThreadRoots.get(channelId);
          await adapter.sendMessage(channelId, `📋 **Plan updated** — ${summary}. \`/plan show\` for details.`, { threadRootId });
        } catch (err) {
          log.warn(`Failed to surface plan summary: ${err}`);
        }
      });
    }
    return;
  }

  // Handle exit_plan_mode.requested — present implementation options
  if (event.type === 'exit_plan_mode.requested') {
    const { requestId, summary, planContent, actions, recommendedAction } = event.data;
    const streamKey = activeStreams.get(channelId);
    const threadRootId = streamKey ? streaming.getStreamThreadRootId(streamKey) : undefined;
    if (threadRootId) channelThreadRoots.set(channelId, threadRootId);
    if (streamKey) {
      await streaming.finalizeStream(streamKey);
      activeStreams.delete(channelId);
    }
    await finalizeActivityFeed(channelId, adapter);

    sessionManager.setPendingPlanExit(channelId, {
      requestId,
      summary: summary ?? '',
      planContent: planContent ?? '',
      actions: actions ?? [],
      recommendedAction: recommendedAction ?? '',
      createdAt: Date.now(),
    });

    const msg = [
      '📋 **Plan ready**',
      '',
      summary || '(no summary provided)',
      '',
      'How would you like to proceed?',
      '1. ▶️ `/implement yolo` — autopilot + yolo (fully autonomous)',
      '2. 🚀 `/implement` — autopilot (with permission prompts)',
      '3. 🔧 `/implement interactive` — interactive mode',
      '4. ❌ `/plan off` — exit plan mode without implementing',
      '',
      'Or just keep chatting to continue refining the plan.',
    ].join('\n');

    await adapter.sendMessage(channelId, msg, { threadRootId });
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
      // content yet, update it in place instead of deleting and recreating.
      // This avoids visible message deletion/churn in the chat.
      if (verbose && streamKey) {
        const streamContent = streaming.getStreamContent(streamKey);
        if (streamContent !== undefined && streamContent === '') {
          if (event.type === 'assistant.message') {
            streaming.replaceContent(streamKey, formatted.content);
          } else if (formatted.content) {
            streaming.appendDelta(streamKey, formatted.content);
          }
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
        const savedThreadRoot = channelThreadRoots.get(channelId);
        const newKey = await streaming.startStream(channelId, savedThreadRoot, initialContent);
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
        } else if (loop.isLoop && loop.count === MAX_IDENTICAL_CALLS) {
          // Warn once at the threshold, not on every subsequent call
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
      channelThreadRoots.delete(channelId);
      if (streamKey) {
        await streaming.cancelStream(streamKey, formatted.content);
        activeStreams.delete(channelId);
      } else {
        await adapter.sendMessage(channelId, formatted.content);
      }
      break;

    case 'status':
      // Finalize active stream on turn_start if it has content from a previous
      // turn or between-turn events (e.g., subagent results arriving after
      // turn_end). This complements turn_end finalization by catching content
      // that arrives outside turn boundaries.
      if (event.type === 'assistant.turn_start' && streamKey && streaming.hasContent(streamKey)) {
        const threadRootId = streaming.getStreamThreadRootId(streamKey);
        if (threadRootId) {
          channelThreadRoots.set(channelId, threadRootId);
        } else {
          channelThreadRoots.delete(channelId);
        }
        await streaming.finalizeStream(streamKey);
        activeStreams.delete(channelId);
      }
      // Send subagent status messages to chat
      if (formatted.content) {
        if (streamKey) {
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
        await adapter.sendMessage(channelId, formatted.content);
      }
      // Finalize stream on turn_end if it has content — preserves multi-turn
      // messages so each turn's text gets its own chat message instead of being
      // overwritten by the next turn's replaceContent().
      // Only finalize when the stream has real content to avoid "Working..." churn.
      if (event.type === 'assistant.turn_end') {
        if (streamKey && streaming.hasContent(streamKey)) {
          // Preserve thread context for the next auto-started stream
          const threadRootId = streaming.getStreamThreadRootId(streamKey);
          if (threadRootId) {
            channelThreadRoots.set(channelId, threadRootId);
          } else {
            channelThreadRoots.delete(channelId);
          }
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
      }
      // Finalize stream when the session goes idle (all turns complete).
       if (event.type === 'session.idle') {
        markIdle(channelId);
        nudgePending.delete(channelId);
        await finalizeActivityFeed(channelId, adapter);
        initialStreamPosted.delete(channelId);
        channelThreadRoots.delete(channelId);
        if (streamKey) {
          log.info(`Session idle, finalizing stream for ${channelId.slice(0, 8)}...`);
          await streaming.finalizeStream(streamKey);
          activeStreams.delete(channelId);
        }
        // Revert yolo if it was temporarily enabled for plan implementation
        if (sessionManager.revertYoloIfNeeded(channelId)) {
          log.info(`Reverted yolo state on idle for ${channelId.slice(0, 8)}...`);
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
