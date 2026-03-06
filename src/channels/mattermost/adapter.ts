import { Client4, WebSocketClient } from '@mattermost/client';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger.js';
import type { ChannelAdapter, InboundMessage, InboundReaction, SendOpts, MessageAttachment, CreateChannelOpts, TeamInfo, ChannelInfo } from '../../types.js';

const log = createLogger('mattermost');

// Node.js polyfills for @mattermost/client (expects browser globals)
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = WebSocket;
}
if (typeof window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: { userAgent: 'copilot-bridge/0.1.0 (Node.js)' },
  };
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

    this.wsClient.addMissedMessageListener(() => {
      log.warn(`WebSocket reconnected — missed events, resetting state`);
    });

    await this.wsClient.initialize(wsUrl, this.token);

    this.wsClient.addMessageListener((msg: any) => {
      log.debug(`WS event: ${msg.event}`);
      if (msg.event === 'posted') {
        this.handlePosted(msg);
      } else if (msg.event === 'reaction_added' || msg.event === 'reaction_removed') {
        this.handleReaction(msg);
      }
    });

    log.info(`Connected as @${this.botUsername} (${this.botId})`);
  }

  async disconnect(): Promise<void> {
    this.wsClient.close();
  }

  /**
   * Discover existing DM channels for this bot via the Mattermost API.
   * Returns channel IDs for direct message conversations the bot is already part of.
   */
  async discoverDMChannels(): Promise<{ channelId: string; otherUserId: string }[]> {
    try {
      const baseUrl = this.client.getBaseRoute();
      const resp = await fetch(`${baseUrl}/users/${this.botId}/channels`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (!resp.ok) {
        log.warn(`Failed to discover DM channels: ${resp.status} ${resp.statusText}`);
        return [];
      }
      const channels = await resp.json() as Array<{ id: string; type: string; name: string }>;
      return channels
        .filter(ch => ch.type === 'D')
        .map(ch => {
          // DM channel names are "{userId1}__{userId2}"
          const parts = ch.name.split('__');
          const otherUserId = parts.find(p => p !== this.botId) ?? parts[0];
          return { channelId: ch.id, otherUserId };
        });
    } catch (err) {
      log.warn(`Error discovering DM channels:`, err);
      return [];
    }
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

  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    await this.client.deletePost(messageId);
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
        attachments: this.extractAttachments(post),
      };

      log.info(`Received: "${inbound.text.slice(0, 80)}" from ${inbound.username} in ${inbound.channelId} (isDM=${isDM})`);

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
      log.error('Failed to parse posted event:', err);
    }
  }

  private extractAttachments(post: any): MessageAttachment[] | undefined {
    const fileIds: string[] = post.file_ids ?? [];
    const metadata = post.metadata?.files as any[] | undefined;
    if (fileIds.length === 0) return undefined;

    return fileIds.map((id, i) => {
      const info = metadata?.[i];
      const name = info?.name ?? `file-${id}`;
      const mimeType = info?.mime_type ?? '';
      const ext = info?.extension ?? '';
      const size = info?.size;

      let type: MessageAttachment['type'] = 'file';
      if (mimeType.startsWith('image/')) type = 'image';
      else if (mimeType.startsWith('video/')) type = 'video';
      else if (mimeType.startsWith('audio/')) type = 'audio';

      const baseUrl = this.client.getBaseRoute();
      const url = `${baseUrl}/files/${id}`;

      return { id, type, url, name: name + (ext && !name.endsWith(`.${ext}`) ? `.${ext}` : ''), mimeType, size };
    });
  }

  async downloadFile(fileId: string, destPath: string): Promise<string> {
    const baseUrl = this.client.getBaseRoute();
    const resp = await fetch(`${baseUrl}/files/${fileId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
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
    const baseUrl = this.client.getBaseRoute();
    const fileName = path.basename(filePath);

    // Async read to avoid blocking the event loop
    const fileBuffer = await fs.promises.readFile(filePath);

    // Upload the file
    const form = new FormData();
    form.append('files', new Blob([fileBuffer]), fileName);
    form.append('channel_id', channelId);

    const uploadResp = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form,
    });
    if (!uploadResp.ok) throw new Error(`Failed to upload file: ${uploadResp.status}`);
    const uploadResult = await uploadResp.json() as { file_infos: Array<{ id: string }> };
    const fileIds = uploadResult.file_infos.map(f => f.id);

    // Create post with the file
    const post = await this.client.createPost({
      channel_id: channelId,
      message: message ?? '',
      root_id: opts?.threadRootId ?? '',
      file_ids: fileIds,
    } as any);

    log.info(`Sent file "${fileName}" to channel ${channelId.slice(0, 8)}...`);
    return post.id;
  }

  // --- Admin operations ---

  async createChannel(opts: CreateChannelOpts): Promise<string> {
    const channel = await this.client.createChannel({
      team_id: opts.teamId,
      name: opts.name,
      display_name: opts.displayName,
      type: opts.private ? 'P' : 'O',
    } as any);
    log.info(`Created ${opts.private ? 'private' : 'public'} channel "${opts.name}" (${channel.id})`);
    return channel.id;
  }

  async addUserToChannel(channelId: string, userId: string): Promise<void> {
    try {
      await this.client.addToChannel(userId, channelId);
    } catch (err: any) {
      // If user isn't on the team, add them to the team first
      if (err?.server_error_id === 'app.team.get_member.missing.app_error') {
        const baseUrl = this.client.getBaseRoute();
        // Get the channel's team ID
        const chResp = await fetch(`${baseUrl}/channels/${channelId}`, {
          headers: { 'Authorization': `Bearer ${this.token}` },
        });
        if (!chResp.ok) throw new Error(`Failed to get channel info: ${chResp.status}`);
        const chData = await chResp.json() as { team_id: string };
        // Add user to team
        await this.client.addToTeam(chData.team_id, userId);
        log.info(`Added user ${userId} to team ${chData.team_id}`);
        // Retry adding to channel
        await this.client.addToChannel(userId, channelId);
      } else {
        throw err;
      }
    }
    log.info(`Added user ${userId} to channel ${channelId.slice(0, 8)}...`);
  }

  async getTeams(): Promise<TeamInfo[]> {
    const teams = await this.client.getMyTeams();
    return teams.map((t: any) => ({
      id: t.id,
      name: t.name,
      displayName: t.display_name,
    }));
  }

  async getChannelByName(teamId: string, name: string): Promise<ChannelInfo | null> {
    try {
      const channel = await this.client.getChannelByName(teamId, name);
      return {
        id: channel.id,
        name: channel.name,
        displayName: channel.display_name,
        type: channel.type,
        teamId: channel.team_id,
      };
    } catch (err: any) {
      if (err?.status_code === 404) return null;
      throw err;
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
            result.catch((err: unknown) => log.error('Reaction handler error:', err));
          }
        } catch (err) {
          log.error('Reaction handler error:', err);
        }
      }
    } catch (err) {
      log.error('Failed to parse reaction event:', err);
    }
  }
}
