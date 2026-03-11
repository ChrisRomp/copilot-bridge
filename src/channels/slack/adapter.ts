/**
 * Slack channel adapter using @slack/bolt (Socket Mode).
 *
 * This adapter connects to Slack via Socket Mode (WebSocket) — no public URL required.
 * It implements the full ChannelAdapter interface for bidirectional message flow.
 *
 * Required config:
 *   platforms.slack.bots.<name>.token    — Bot User OAuth Token (xoxb-...)
 *   platforms.slack.bots.<name>.appToken — App-Level Token (xapp-...) for Socket Mode
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLogger } from '../../logger.js';
import { markdownToMrkdwn } from './mrkdwn.js';
import type {
  ChannelAdapter,
  InboundMessage,
  InboundReaction,
  SendOpts,
  MessageAttachment,
} from '../../types.js';

const log = createLogger('slack');

// Slack message character limit — responses longer than this must be chunked
const SLACK_MAX_MESSAGE_LENGTH = 3_900; // leave room for formatting overhead under 4000 limit

/** Options for constructing a SlackAdapter. */
export interface SlackAdapterOptions {
  platformName: string;
  botToken: string;    // xoxb-...
  appToken: string;    // xapp-... (Socket Mode)
}

export class SlackAdapter implements ChannelAdapter {
  readonly platform: string;

  private app: any;         // Bolt App instance (typed as any to support optional dep)
  private botUserId = '';
  private botToken: string;
  private appToken: string;
  private messageHandlers: Array<(msg: InboundMessage) => void> = [];
  private reactionHandlers: Array<(reaction: InboundReaction) => void> = [];

  // Reconnect dedup state
  private recentMessageTs = new Set<string>();
  private static readonly MAX_RECENT_MESSAGES = 500;

  constructor(opts: SlackAdapterOptions) {
    this.platform = opts.platformName;
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
  }

  async connect(): Promise<void> {
    // Dynamic import — @slack/bolt is an optional peer dependency
    let App: any;
    try {
      const bolt = await import('@slack/bolt');
      App = bolt.App;
    } catch {
      throw new Error(
        'Slack adapter requires @slack/bolt. Install it with: npm install @slack/bolt'
      );
    }

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      // Disable built-in acknowledgment logging
      logLevel: 'WARN',
    });

    // Fetch bot identity
    const authResult = await this.app.client.auth.test({ token: this.botToken });
    this.botUserId = authResult.user_id;
    log.info(`Authenticated as <@${this.botUserId}> (${authResult.user})`);

    // Wire up message events
    this.app.message(async ({ message, context }: any) => {
      this.handleMessage(message, context);
    });

    // Wire up reaction events
    this.app.event('reaction_added', async ({ event }: any) => {
      this.handleReaction(event, 'added');
    });
    this.app.event('reaction_removed', async ({ event }: any) => {
      this.handleReaction(event, 'removed');
    });

    await this.app.start();
    log.info('Slack adapter connected via Socket Mode');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      log.info('Slack adapter disconnected');
    }
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, opts?: SendOpts): Promise<string> {
    const formatted = markdownToMrkdwn(content);
    const chunks = chunkMessage(formatted);
    let firstTs = '';

    for (const chunk of chunks) {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        text: chunk,
        thread_ts: opts?.threadRootId,
      });
      if (!firstTs) firstTs = result.ts;
    }

    return firstTs;
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const formatted = markdownToMrkdwn(content);
    // Truncate to Slack's limit — streaming updates can't be chunked across messages
    const truncated = formatted.length > SLACK_MAX_MESSAGE_LENGTH
      ? formatted.slice(0, SLACK_MAX_MESSAGE_LENGTH - 20) + '\n\n_(truncated)_'
      : formatted;
    try {
      await this.app.client.chat.update({
        token: this.botToken,
        channel: channelId,
        ts: messageId,
        text: truncated,
      });
    } catch (err: any) {
      if (err?.data?.error === 'msg_too_old' || err?.data?.error === 'cant_update_message') {
        log.warn(`Cannot update message ${messageId} (too old or restricted)`);
      } else {
        throw err;
      }
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.app.client.chat.delete({
        token: this.botToken,
        channel: channelId,
        ts: messageId,
      });
    } catch (err: any) {
      if (err?.data?.error === 'message_not_found') {
        log.warn(`Message ${messageId} not found for deletion`);
      } else {
        throw err;
      }
    }
  }

  async setTyping(_channelId: string): Promise<void> {
    // Slack doesn't have a reliable programmatic typing indicator API.
    // The SDK-based typing indicator requires a user token, not a bot token.
    // Best-effort no-op.
  }

  async replyInThread(channelId: string, rootId: string, content: string): Promise<string> {
    return this.sendMessage(channelId, content, { threadRootId: rootId });
  }

  getBotUserId(): string {
    return this.botUserId;
  }

  async addReaction(postId: string, emoji: string): Promise<void> {
    try {
      // postId is "channelId:ts" — we need both to add a reaction
      const [channel, timestamp] = this.parseMessageRef(postId);
      await this.app.client.reactions.add({
        token: this.botToken,
        channel,
        timestamp,
        name: emoji.replace(/:/g, ''), // Slack emoji names don't use colons
      });
    } catch {
      // Reactions are best-effort
    }
  }

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    // Slack file URLs require auth — use files.info to get the download URL
    const fileInfo = await this.app.client.files.info({
      token: this.botToken,
      file: fileId,
    });

    const downloadUrl = fileInfo.file?.url_private_download ?? fileInfo.file?.url_private;
    if (!downloadUrl) throw new Error(`No download URL for file ${fileId}`);

    const resp = await fetch(downloadUrl, {
      headers: { 'Authorization': `Bearer ${this.botToken}` },
    });
    if (!resp.ok) throw new Error(`Failed to download file ${fileId}: ${resp.status}`);

    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    log.info(`Downloaded file ${fileId} to ${destPath} (${buffer.length} bytes)`);
    return destPath;
  }

  async sendFile(channelId: string, filePath: string, message?: string, opts?: SendOpts): Promise<string> {
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.promises.readFile(filePath);

    const result = await this.app.client.files.uploadV2({
      token: this.botToken,
      channel_id: channelId,
      file: Readable.from(fileBuffer),
      filename: fileName,
      initial_comment: message ? markdownToMrkdwn(message) : '',
      thread_ts: opts?.threadRootId,
    });

    // uploadV2 returns the file object; the associated message ts is in file.shares
    const ts = result.file?.shares?.public?.[channelId]?.[0]?.ts
      ?? result.file?.shares?.private?.[channelId]?.[0]?.ts
      ?? '';

    log.info(`Sent file "${fileName}" to channel ${channelId}`);
    return ts;
  }

  async discoverDMChannels(): Promise<{ channelId: string; otherUserId: string }[]> {
    try {
      const dms: { channelId: string; otherUserId: string }[] = [];
      let cursor: string | undefined;

      do {
        const result = await this.app.client.conversations.list({
          token: this.botToken,
          types: 'im',
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });

        for (const ch of result.channels ?? []) {
          dms.push({ channelId: ch.id, otherUserId: ch.user });
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      return dms;
    } catch (err) {
      log.warn('Failed to discover DM channels:', err);
      return [];
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private handleMessage(message: any, _context: any): void {
    try {
      // Ignore bot messages (including our own)
      if (message.bot_id || message.subtype === 'bot_message') return;
      // Ignore message edits, deletes, and other subtypes
      if (message.subtype && message.subtype !== 'file_share') return;

      const channelId = message.channel;
      const ts = message.ts;

      // Dedup using composite key (ts is only unique within a channel)
      const messageKey = `${channelId}:${ts}`;
      if (this.recentMessageTs.has(messageKey)) return;
      this.trackMessage(messageKey);

      // Detect DM vs channel
      // Slack channel IDs: C = public, G = group/private, D = DM
      const isDM = channelId.startsWith('D');
      const mentionsBot = isDM || (message.text ?? '').includes(`<@${this.botUserId}>`);

      // Extract attachments from file_share messages
      const attachments = this.extractAttachments(message);

      // Strip bot mention from text for cleaner processing
      let text = message.text ?? '';
      text = text.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();

      const inbound: InboundMessage = {
        platform: this.platform,
        channelId,
        userId: message.user,
        username: message.user, // Slack events don't include username; resolved later if needed
        text,
        postId: `${channelId}:${ts}`,
        threadRootId: message.thread_ts !== ts ? message.thread_ts : undefined,
        mentionsBot,
        isDM,
        attachments,
      };

      log.info(`Received: "${inbound.text.slice(0, 80)}" from ${inbound.userId} in ${channelId} (isDM=${isDM})`);

      for (const handler of this.messageHandlers) {
        try {
          const result: any = handler(inbound);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => log.error('Handler error:', err));
          }
        } catch (err) {
          log.error('Handler error:', err);
        }
      }
    } catch (err) {
      log.error('Failed to handle Slack message:', err);
    }
  }

  private handleReaction(event: any, action: 'added' | 'removed'): void {
    try {
      const inbound: InboundReaction = {
        platform: this.platform,
        channelId: event.item?.channel ?? '',
        userId: event.user,
        postId: `${event.item?.channel ?? ''}:${event.item?.ts ?? ''}`,
        emoji: event.reaction,
        action,
      };

      for (const handler of this.reactionHandlers) {
        try {
          const result: any = handler(inbound);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => log.error('Reaction handler error:', err));
          }
        } catch (err) {
          log.error('Reaction handler error:', err);
        }
      }
    } catch (err) {
      log.error('Failed to handle Slack reaction:', err);
    }
  }

  private extractAttachments(message: any): MessageAttachment[] | undefined {
    const files: any[] = message.files;
    if (!files || files.length === 0) return undefined;

    return files.map((f: any) => {
      let type: MessageAttachment['type'] = 'file';
      if (f.mimetype?.startsWith('image/')) type = 'image';
      else if (f.mimetype?.startsWith('video/')) type = 'video';
      else if (f.mimetype?.startsWith('audio/')) type = 'audio';

      return {
        id: f.id,
        type,
        url: f.url_private ?? '',
        name: f.name ?? `file-${f.id}`,
        mimeType: f.mimetype,
        size: f.size,
      };
    });
  }

  private trackMessage(key: string): void {
    this.recentMessageTs.add(key);

    if (this.recentMessageTs.size > SlackAdapter.MAX_RECENT_MESSAGES) {
      const iter = this.recentMessageTs.values();
      for (let i = 0; i < 100; i++) {
        const val = iter.next().value;
        if (val != null) this.recentMessageTs.delete(val);
      }
    }
  }

  /**
   * Parse a message reference into [channelId, ts].
   * Inbound postIds are stored as "channelId:ts"; sendMessage returns bare "ts".
   * Returns ['', ref] when no channel prefix is present.
   */
  private parseMessageRef(ref: string): [string, string] {
    const idx = ref.indexOf(':');
    if (idx > 0) return [ref.slice(0, idx), ref.slice(idx + 1)];
    return ['', ref];
  }
}

// ── Message chunking ──────────────────────────────────────────

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Tries to split on newlines first, then falls back to hard splits.
 */
export function chunkMessage(content: string, maxLength = SLACK_MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (newline, then space)
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= maxLength * 0.3) {
      // Newline too early — try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= maxLength * 0.3) {
      // No good split point — hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ''); // trim leading newline from next chunk
  }

  return chunks;
}
