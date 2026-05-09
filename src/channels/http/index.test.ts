import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage, InboundReaction } from '../../types.js';
import type { AgentHarnessAdapter } from './harness.js';
import { HttpChannelAdapter } from './index.js';
import type {
  Card,
  CardComment,
  CardFilter,
  Checkpoint,
  ICardStore,
  NewCard,
  NewCardComment,
  NewCheckpoint,
  NewRun,
  NewSessionTurn,
  Run,
  SessionTurn,
} from './store.js';

function createMockStore() {
  const addComment = vi.fn(async (comment: NewCardComment): Promise<CardComment> => ({
    id: 'comment-123',
    card_id: comment.card_id,
    author_kind: comment.author_kind,
    author_id: comment.author_id,
    content: comment.content,
    created_at: '2026-05-09T00:00:00Z',
  }));

  const store: ICardStore = {
    initialize: async () => {},
    createCard: async (_card: NewCard): Promise<Card> => { throw new Error('not implemented'); },
    getCard: async () => null,
    listCards: async (_filter: CardFilter) => [],
    updateCard: async (_id: string, _patch: Partial<Card>): Promise<Card> => { throw new Error('not implemented'); },
    deleteCard: async (_id: string) => {},
    createRun: async (_run: NewRun): Promise<Run> => { throw new Error('not implemented'); },
    getRun: async () => null,
    updateRun: async (_id: string, _patch: Partial<Run>): Promise<Run> => { throw new Error('not implemented'); },
    listRunsForCard: async (_cardId: string) => [],
    addLabels: async (_cardId: string, _labels: string[]) => {},
    removeLabel: async (_cardId: string, _label: string) => {},
    getLabels: async (_cardId: string) => [],
    addComment,
    listComments: async (_cardId: string) => [],
    appendTurn: async (_turn: NewSessionTurn): Promise<SessionTurn> => { throw new Error('not implemented'); },
    listTurns: async (_cardId: string, _upToIndex?: number) => [],
    createCheckpoint: async (_checkpoint: NewCheckpoint): Promise<Checkpoint> => { throw new Error('not implemented'); },
    listCheckpoints: async (_cardId: string) => [],
    deleteCheckpoint: async (_id: string) => {},
  };

  return { store, addComment };
}

function createMockHarness(): AgentHarnessAdapter {
  return {
    handleSdkEvent: vi.fn(async () => null),
    finalizeRun: vi.fn(async () => []),
  };
}

function createMockServer() {
  const close = vi.fn(async () => undefined);
  const server = { close } as unknown as FastifyInstance;
  return { server, close };
}

const inboundMessage: InboundMessage = {
  platform: 'http',
  channelId: 'card-1',
  userId: 'user-1',
  username: 'ray',
  text: 'hello',
  postId: 'comment-1',
  mentionsBot: true,
  isDM: false,
};

const inboundReaction: InboundReaction = {
  platform: 'http',
  channelId: 'card-1',
  userId: 'user-1',
  username: 'ray',
  postId: 'comment-1',
  emoji: 'thumbsup',
  action: 'added',
};

describe('HttpChannelAdapter', () => {
  it('registers message and reaction handlers correctly', () => {
    const { server } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());
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
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());
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
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());
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

  it('sendMessage persists an agent comment and returns its id', async () => {
    const { server } = createMockServer();
    const { store, addComment } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());

    await expect(adapter.sendMessage('card-1', 'Hello from Bob')).resolves.toBe('comment-123');
    expect(addComment).toHaveBeenCalledWith({
      card_id: 'card-1',
      author_kind: 'agent',
      author_id: 'http-adapter',
      content: 'Hello from Bob',
    });
  });

  it('replyInThread delegates to sendMessage', async () => {
    const { server } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());
    const sendMessageSpy = vi.spyOn(adapter, 'sendMessage').mockResolvedValue('comment-456');

    await expect(adapter.replyInThread('card-1', 'root-1', 'thread reply')).resolves.toBe('comment-456');
    expect(sendMessageSpy).toHaveBeenCalledWith('card-1', 'thread reply');
  });

  it('returns the sentinel bot user id', () => {
    const { server } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());

    expect(adapter.getBotUserId()).toBe('http-adapter');
  });

  it('connects and disconnects cleanly', async () => {
    const { server, close } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());

    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('treats updateMessage, deleteMessage, and setTyping as no-ops', async () => {
    const { server } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());

    await expect(adapter.updateMessage('card-1', 'comment-1', 'updated')).resolves.toBeUndefined();
    await expect(adapter.deleteMessage('card-1', 'comment-1')).resolves.toBeUndefined();
    await expect(adapter.setTyping('card-1')).resolves.toBeUndefined();
  });

  it('throws for unimplemented file operations', async () => {
    const { server } = createMockServer();
    const { store } = createMockStore();
    const adapter = new HttpChannelAdapter(server, store, createMockHarness());

    await expect(adapter.downloadFile('file-1', 'dest.txt')).rejects.toThrow(
      'downloadFile not implemented for HTTP adapter',
    );
    await expect(adapter.sendFile('card-1', 'artifact.txt')).rejects.toThrow(
      'sendFile not yet implemented for HTTP adapter',
    );
  });
});
