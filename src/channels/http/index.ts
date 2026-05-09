import type { FastifyInstance } from 'fastify';
import type {
  ChannelAdapter,
  InboundMessage,
  InboundReaction,
  SendOpts,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import type { AgentHarnessAdapter } from './harness.js';
import type { ICardStore } from './store.js';

const log = createLogger('http-adapter');

export class HttpChannelAdapter implements ChannelAdapter {
  readonly platform = 'http';

  private readonly messageHandlers: Array<(msg: InboundMessage) => void> = [];
  private readonly reactionHandlers: Array<(reaction: InboundReaction) => void> = [];

  constructor(
    private readonly server: FastifyInstance,
    private readonly store: ICardStore,
    private readonly harness: AgentHarnessAdapter,
  ) {
    // harness reserved for route event wiring in t8+
    void this.harness;
  }

  async connect(): Promise<void> {
    log.info('HttpChannelAdapter connected');
  }

  async disconnect(): Promise<void> {
    await this.server.close();
    log.info('HttpChannelAdapter disconnected');
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, _opts?: SendOpts): Promise<string> {
    const comment = await this.store.addComment({
      card_id: channelId,
      author_kind: 'agent',
      author_id: 'http-adapter',
      content,
    });
    return comment.id;
  }

  async updateMessage(_channelId: string, _messageId: string, _content: string): Promise<void> {
    log.debug('updateMessage is a no-op for HTTP adapter');
  }

  async deleteMessage(_channelId: string, _messageId: string): Promise<void> {
    log.debug('deleteMessage is a no-op for HTTP adapter');
  }

  async setTyping(_channelId: string): Promise<void> {
    log.debug('setTyping is a no-op for HTTP adapter');
  }

  async replyInThread(channelId: string, _rootId: string, content: string): Promise<string> {
    return this.sendMessage(channelId, content);
  }

  getBotUserId(): string {
    return 'http-adapter';
  }

  async downloadFile(_fileId: string, _destPath: string): Promise<string> {
    throw new Error('downloadFile not implemented for HTTP adapter');
  }

  async sendFile(_channelId: string, _filePath: string, _message?: string, _opts?: SendOpts): Promise<string> {
    throw new Error('sendFile not implemented for HTTP adapter');
  }

  dispatchInboundMessage(msg: InboundMessage): void {
    for (const handler of this.messageHandlers) {
      this.invokeHandler(handler, msg, 'message');
    }
  }

  dispatchInboundReaction(reaction: InboundReaction): void {
    for (const handler of this.reactionHandlers) {
      this.invokeHandler(handler, reaction, 'reaction');
    }
  }

  private invokeHandler<T>(handler: (payload: T) => void, payload: T, type: 'message' | 'reaction'): void {
    try {
      const result = handler(payload) as void | Promise<void>;
      if (result && typeof result.catch === 'function') {
        result.catch((err: unknown) => log.error(`Error in ${type} handler:`, err));
      }
    } catch (err) {
      log.error(`Error in ${type} handler:`, err);
    }
  }
}
