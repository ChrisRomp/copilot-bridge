import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage, InboundReaction } from '../../types.js';
import { HttpChannelAdapter } from './index.js';

function createMockServer() {
  const close = vi.fn(async () => undefined);
  const server = { close } as unknown as FastifyInstance;
  return { server, close };
}

const inboundMessage: InboundMessage = {
  platform: 'http',
  channelId: 'chan-1',
  userId: 'user-1',
  username: 'ray',
  text: 'hello',
  postId: 'msg-1',
  mentionsBot: true,
  isDM: false,
};

const inboundReaction: InboundReaction = {
  platform: 'http',
  channelId: 'chan-1',
  userId: 'user-1',
  username: 'ray',
  postId: 'msg-1',
  emoji: 'thumbsup',
  action: 'added',
};

describe('HttpChannelAdapter', () => {
  it('registers message and reaction handlers correctly', () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    adapter.onMessage(onMessage);
    adapter.onReaction(onReaction);

    adapter.dispatchInboundMessage(inboundMessage);
    adapter.dispatchInboundReaction(inboundReaction);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(inboundMessage);
    expect(onReaction).toHaveBeenCalledOnce();
    expect(onReaction).toHaveBeenCalledWith(inboundReaction);
  });

  it('dispatchInboundMessage calls all registered handlers', () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    const first = vi.fn();
    const second = vi.fn();

    adapter.onMessage(first);
    adapter.onMessage(second);

    adapter.dispatchInboundMessage(inboundMessage);

    expect(first).toHaveBeenCalledWith(inboundMessage);
    expect(second).toHaveBeenCalledWith(inboundMessage);
  });

  it('dispatchInboundMessage catches handler errors without throwing', () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    const first = vi.fn(() => {
      throw new Error('boom');
    });
    const second = vi.fn();

    adapter.onMessage(first);
    adapter.onMessage(second);

    expect(() => adapter.dispatchInboundMessage(inboundMessage)).not.toThrow();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('dispatchInboundReaction catches handler errors without throwing', () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    const first = vi.fn(() => {
      throw new Error('boom');
    });
    const second = vi.fn();

    adapter.onReaction(first);
    adapter.onReaction(second);

    expect(() => adapter.dispatchInboundReaction(inboundReaction)).not.toThrow();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('sendMessage is a no-op returning empty string', async () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    await expect(adapter.sendMessage('chan-1', 'Hello')).resolves.toBe('');
  });

  it('replyInThread is a no-op returning empty string', async () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    await expect(adapter.replyInThread('chan-1', 'root-1', 'reply')).resolves.toBe('');
  });

  it('returns the sentinel bot user id', () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);
    expect(adapter.getBotUserId()).toBe('http-adapter');
  });

  it('connects and disconnects cleanly', async () => {
    const { server, close } = createMockServer();
    const adapter = new HttpChannelAdapter(server);

    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('treats updateMessage, deleteMessage, and setTyping as no-ops', async () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);

    await expect(adapter.updateMessage('chan-1', 'msg-1', 'updated')).resolves.toBeUndefined();
    await expect(adapter.deleteMessage('chan-1', 'msg-1')).resolves.toBeUndefined();
    await expect(adapter.setTyping('chan-1')).resolves.toBeUndefined();
  });

  it('throws for unimplemented file operations', async () => {
    const { server } = createMockServer();
    const adapter = new HttpChannelAdapter(server);

    await expect(adapter.downloadFile('file-1', 'dest.txt')).rejects.toThrow(
      'downloadFile not implemented for HTTP adapter',
    );
    await expect(adapter.sendFile('chan-1', 'artifact.txt')).rejects.toThrow(
      'sendFile not implemented for HTTP adapter',
    );
  });
});
