import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import { registerChatRoutes, type ChatRouteDeps } from './chat.js';
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
} from '../store.js';

const timestamp = '2026-05-09T00:00:00Z';
const authHeader = { authorization: 'Bearer secret-token' };
const bobOnlyHeader = { authorization: 'Bearer bob-only-token' };

function createCardRecord(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    channel_id: null,
    type: 'chat',
    agent_bot: 'bob',
    title: 'Chat session',
    description: null,
    status: 'in_progress',
    created_by: 'ui-desktop-rk',
    workspace_subdir: null,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    ...overrides,
  };
}

function createRunRecord(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    card_id: 'card-1',
    session_id: 'card-1',
    agent_name: 'bob',
    status: 'created',
    input: [],
    output: [],
    error: null,
    created_at: timestamp,
    finished_at: null,
    ...overrides,
  };
}

function createCommentRecord(overrides: Partial<CardComment> = {}): CardComment {
  return {
    id: 'comment-1',
    card_id: 'card-1',
    author_kind: 'human',
    author_id: 'ui-desktop-rk',
    content: '{"role":"user","parts":[{"type":"text","text":"hello"}]}',
    created_at: timestamp,
    ...overrides,
  };
}

function createStore() {
  const cards = new Map<string, Card>();
  const runs = new Map<string, Run>();
  const comments = new Map<string, CardComment[]>();
  let nextCard = 1;
  let nextRun = 1;
  let nextComment = 1;

  const createCard = vi.fn(async (card: NewCard): Promise<Card> => {
    const created = createCardRecord({
      id: `card-${nextCard++}`,
      title: card.title,
      type: card.type ?? 'work',
      agent_bot: card.agent_bot ?? null,
      status: card.status ?? 'idea',
      created_by: card.created_by,
      workspace_subdir: card.workspace_subdir ?? null,
      metadata: card.metadata ?? {},
    });
    cards.set(created.id, created);
    return created;
  });

  const createRun = vi.fn(async (run: NewRun): Promise<Run> => {
    const created = createRunRecord({
      id: `run-${nextRun++}`,
      card_id: run.card_id,
      session_id: run.session_id,
      agent_name: run.agent_name,
      input: run.input,
    });
    runs.set(created.id, created);
    return created;
  });

  const addComment = vi.fn(async (comment: NewCardComment): Promise<CardComment> => {
    const created = createCommentRecord({
      id: `comment-${nextComment++}`,
      card_id: comment.card_id,
      author_kind: comment.author_kind,
      author_id: comment.author_id,
      content: comment.content,
    });
    comments.set(comment.card_id, [...(comments.get(comment.card_id) ?? []), created]);
    return created;
  });

  const store: ICardStore = {
    initialize: async () => {},
    createCard,
    getCard: async (id: string) => cards.get(id) ?? null,
    listCards: async (_filter: CardFilter) => [...cards.values()],
    updateCard: async (id: string, patch: Partial<Card>) => {
      const current = cards.get(id);
      if (!current) {
        throw new Error(`Unknown card: ${id}`);
      }
      const updated = { ...current, ...patch };
      cards.set(id, updated);
      return updated;
    },
    deleteCard: async (id: string) => {
      cards.delete(id);
    },
    createRun,
    getRun: async (id: string) => runs.get(id) ?? null,
    updateRun: async (id: string, patch: Partial<Run>) => {
      const current = runs.get(id);
      if (!current) {
        throw new Error(`Unknown run: ${id}`);
      }
      const updated = { ...current, ...patch };
      runs.set(id, updated);
      return updated;
    },
    listRunsForCard: async (cardId: string) => [...runs.values()].filter((run) => run.card_id === cardId),
    addLabels: async (_cardId: string, _labels: string[]) => {},
    removeLabel: async (_cardId: string, _label: string) => {},
    getLabels: async (_cardId: string) => [],
    addComment,
    listComments: async (cardId: string) => comments.get(cardId) ?? [],
    appendTurn: async (turn: NewSessionTurn): Promise<SessionTurn> => ({
      id: 'turn-1',
      card_id: turn.card_id,
      run_id: turn.run_id ?? null,
      turn_index: turn.turn_index,
      role: turn.role,
      content: turn.content,
      git_ref: turn.git_ref ?? null,
      created_at: timestamp,
    }),
    listTurns: async (_cardId: string, _upToIndex?: number) => [],
    createCheckpoint: async (checkpoint: NewCheckpoint): Promise<Checkpoint> => ({
      id: 'checkpoint-1',
      card_id: checkpoint.card_id,
      name: checkpoint.name ?? null,
      turn_index: checkpoint.turn_index,
      git_ref: checkpoint.git_ref ?? null,
      created_by: checkpoint.created_by,
      created_at: timestamp,
    }),
    listCheckpoints: async (_cardId: string) => [],
    deleteCheckpoint: async (_id: string) => {},
  };

  return {
    store,
    cards,
    comments,
    createCard,
    createRun,
    addComment,
  };
}

function createAdapter() {
  return {
    dispatchInboundMessage: vi.fn(),
  } as Pick<HttpChannelAdapter, 'dispatchInboundMessage'>;
}

function createRouteDeps(
  store: ICardStore,
  overrides: Partial<Omit<ChatRouteDeps, 'store'>> = {},
): ChatRouteDeps {
  return {
    store,
    adapter: overrides.adapter ?? createAdapter(),
  };
}

describe('registerChatRoutes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, {
      keys: new Map([
        ['ui-desktop-rk', {
          secret: 'secret-token',
          allowedAgents: ['*'],
          allowedOps: ['*'],
        }],
        ['bob-only', {
          secret: 'bob-only-token',
          allowedAgents: ['bob'],
          allowedOps: ['*'],
        }],
      ]),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('starts a new chat session and creates a run', async () => {
    const { store, cards, createCard, createRun, addComment } = createStore();
    const adapter = createAdapter();
    registerChatRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/bob/chat',
      headers: authHeader,
      payload: { message: 'Hello Bob' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ session_id: 'card-1', run_id: 'run-1' });
    expect(createCard).toHaveBeenCalledWith({
      title: 'Hello Bob',
      type: 'chat',
      agent_bot: 'bob',
      status: 'in_progress',
      created_by: 'ui-desktop-rk',
      workspace_subdir: null,
    });
    expect(cards.get('card-1')).toMatchObject({ type: 'chat', workspace_subdir: null, agent_bot: 'bob' });
    expect(addComment).toHaveBeenCalledWith({
      card_id: 'card-1',
      author_kind: 'human',
      author_id: 'ui-desktop-rk',
      content: JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'Hello Bob' }] }),
    });
    expect(createRun).toHaveBeenCalledWith({
      card_id: 'card-1',
      session_id: 'card-1',
      agent_name: 'bob',
      input: [{ role: 'user', parts: [{ type: 'text', text: 'Hello Bob' }] }],
    });
    expect(adapter.dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: 'card-1',
      userId: 'ui-desktop-rk',
      username: 'ui-desktop-rk',
      text: 'Hello Bob',
      postId: 'comment-1',
      mentionsBot: true,
      isDM: true,
    });
  });

  it('continues an existing chat session and reuses the card', async () => {
    const { store, cards, createCard, createRun } = createStore();
    cards.set('card-9', createCardRecord({ id: 'card-9', agent_bot: 'bob', type: 'chat' }));
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/bob/chat',
      headers: authHeader,
      payload: { session_id: 'card-9', message: 'Follow up' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ session_id: 'card-9', run_id: 'run-1' });
    expect(createCard).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith({
      card_id: 'card-9',
      session_id: 'card-9',
      agent_name: 'bob',
      input: [{ role: 'user', parts: [{ type: 'text', text: 'Follow up' }] }],
    });
  });

  it('rejects chat creation when agent access is denied', async () => {
    const { store, createCard } = createStore();
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/lal/chat',
      headers: bobOnlyHeader,
      payload: { message: 'Hello' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(createCard).not.toHaveBeenCalled();
  });

  it('requires a message when posting chat input', async () => {
    const { store, createCard, createRun } = createStore();
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/bob/chat',
      headers: authHeader,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'message is required' });
    expect(createCard).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('returns 404 for an invalid chat session id', async () => {
    const { store, createRun } = createStore();
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/bob/chat',
      headers: authHeader,
      payload: { session_id: 'missing', message: 'Hello again' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Chat session not found' });
    expect(createRun).not.toHaveBeenCalled();
  });

  it('returns chat history for a session', async () => {
    const { store, cards, comments } = createStore();
    const history = [
      createCommentRecord({ id: 'comment-1', card_id: 'card-1' }),
      createCommentRecord({ id: 'comment-2', card_id: 'card-1', author_kind: 'agent', author_id: 'http-adapter' }),
    ];
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'bob', type: 'chat' }));
    comments.set('card-1', history);
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/bob/chat/card-1',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ history });
  });

  it('returns 404 when chat history session is missing', async () => {
    const { store } = createStore();
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/bob/chat/missing',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Chat session not found' });
  });

  it('rejects chat history when agent access is denied', async () => {
    const { store, cards } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'lal', type: 'chat' }));
    registerChatRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/lal/chat/card-1',
      headers: bobOnlyHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });
});
