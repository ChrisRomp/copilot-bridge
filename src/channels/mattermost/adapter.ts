import { Client4, WebSocketClient } from '@mattermost/client';
import * as WebSocket from 'ws';
import type { ChannelAdapter, InboundMessage, InboundReaction, SendOpts } from '../../types.js';

// Node.js needs this for @mattermost/client WebSocket support
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = WebSocket;
}

export class MattermostAdapter implements ChannelAdapter {
  readonly platform: string;

  private client: Client4;
  private wsClient: WebSocketClient;
  private botId = '';
  private botUsername = '';
  private url: string;
  private token: string;
  private messageHandlers: Array<(msg: InboundMessage) => void> = [];
  private reactionHandlers: Array<(reaction: InboundReaction) => void> = [];

  constructor(platformName: string, url: string, token: string) {
    this.platform = platformName;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.client = new Client4();
    this.wsClient = new WebSocketClient();
  }

  async connect(): Promise<void> {
    this.client.setUrl(this.url);
    this.client.setToken(this.token);

    // Fetch bot identity
    const me = await this.client.getMe();
    this.botId = me.id;
    this.botUsername = me.username;

    // Build WebSocket URL
    const wsScheme = this.url.startsWith('https') ? 'wss' : 'ws';
    const host = this.url.replace(/^https?:\/\//, '');
    const wsUrl = `${wsScheme}://${host}/api/v4/websocket`;

    await this.wsClient.initialize(wsUrl, this.token);

    this.wsClient.addMessageListener((msg: any) => {
      if (msg.event === 'posted') {
        this.handlePosted(msg);
      } else if (msg.event === 'reaction_added' || msg.event === 'reaction_removed') {
        this.handleReaction(msg);
      }
    });

    console.log(`[mattermost] Connected as @${this.botUsername} (${this.botId})`);
  }

  async disconnect(): Promise<void> {
    this.wsClient.close();
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, opts?: SendOpts): Promise<string> {
    const post = await this.client.createPost({
      channel_id: channelId,
      message: content,
      root_id: opts?.threadRootId ?? '',
    } as any);
    return post.id;
  }

  async updateMessage(_channelId: string, messageId: string, content: string): Promise<void> {
    await this.client.patchPost({ id: messageId, message: content } as any);
  }

  async setTyping(channelId: string): Promise<void> {
    try {
      const baseUrl = this.client.getBaseRoute();
      await fetch(`${baseUrl}/users/me/typing`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel_id: channelId }),
      });
    } catch {
      // Typing indicator is best-effort
    }
  }

  async replyInThread(channelId: string, rootId: string, content: string): Promise<string> {
    return this.sendMessage(channelId, content, { threadRootId: rootId });
  }

  getBotUserId(): string {
    return this.botId;
  }

  private handlePosted(msg: any): void {
    try {
      const post = JSON.parse(msg.data.post);

      // Ignore own messages
      if (post.user_id === this.botId) return;

      const channelType: string = msg.data.channel_type ?? '';
      const isDM = channelType === 'D' || channelType === 'G';
      const mentionsBot =
        isDM || post.message?.includes(`@${this.botUsername}`);

      const inbound: InboundMessage = {
        platform: this.platform,
        channelId: post.channel_id,
        userId: post.user_id,
        username: (msg.data.sender_name ?? '').replace(/^@/, ''),
        text: post.message ?? '',
        postId: post.id,
        threadRootId: post.root_id || undefined,
        mentionsBot,
        isDM,
      };

      for (const handler of this.messageHandlers) {
        try {
          const result: any = handler(inbound);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => console.error('[mattermost] Handler error:', err));
          }
        } catch (err) {
          console.error('[mattermost] Handler error:', err);
        }
      }
    } catch (err) {
      console.error('[mattermost] Failed to parse posted event:', err);
    }
  }

  private handleReaction(msg: any): void {
    try {
      const reaction = JSON.parse(msg.data.reaction);

      const inbound: InboundReaction = {
        platform: this.platform,
        channelId: msg.broadcast?.channel_id ?? '',
        userId: reaction.user_id,
        postId: reaction.post_id,
        emoji: reaction.emoji_name,
        action: msg.event === 'reaction_added' ? 'added' : 'removed',
      };

      for (const handler of this.reactionHandlers) {
        try {
          const result: any = handler(inbound);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => console.error('[mattermost] Handler error:', err));
          }
        } catch (err) {
          console.error('[mattermost] Handler error:', err);
        }
      }
    } catch (err) {
      console.error('[mattermost] Failed to parse reaction event:', err);
    }
  }
}
