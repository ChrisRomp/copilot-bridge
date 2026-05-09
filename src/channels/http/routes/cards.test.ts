import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import { SseManager } from '../sse.js';
import { registerCardRoutes, type CardRouteDeps } from './cards.js';
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
const createOnlyHeader = { authorization: 'Bearer create-only-token' };
const noDeleteHeader = { authorization: 'Bearer no-delete-token' };
const readOnlyHeader = { authorization: 'Bearer read-only-token' };
const bobOnlyHeader = { authorization: 'Bearer bob-only-token' };

function createCardRecord(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    channel_id: null,
    type: 'work',
    agent_bot: null,
    title: 'Card title',
    description: null,
    status: 'idea',
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
    session_id: 'session-1',
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
    content: 'Looks good',
    created_at: timestamp,
    ...overrides,
  };
}

function createStore() {
  const cards = new Map<string, Card>();
  const runs = new Map<string, Run>();
  const comments = new Map<string, CardComment[]>();
  const labels = new Map<string, Set<string>>();
  let nextCard = 1;
  let nextRun = 1;
  let nextComment = 1;

  const createCard = vi.fn(async (card: NewCard): Promise<Card> => {
    const created = createCardRecord({
      id: `card-${nextCard++}`,
      title: card.title,
      description: card.description ?? null,
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

  const listCards = vi.fn(async (filter: CardFilter): Promise<Card[]> => {
    return [...cards.values()].filter((card) => {
      if (filter.agent_bot !== undefined && card.agent_bot !== filter.agent_bot) {
        return false;
      }
      if (filter.status !== undefined && card.status !== filter.status) {
        return false;
      }
      if (filter.type !== undefined && card.type !== filter.type) {
        return false;
      }
      if (filter.label !== undefined && !labels.get(card.id)?.has(filter.label)) {
        return false;
      }
      return true;
    });
  });

  const updateCard = vi.fn(async (id: string, patch: Partial<Card>): Promise<Card> => {
    const current = cards.get(id);
    if (!current) {
      throw new Error(`Unknown card: ${id}`);
    }
    const updated = { ...current, ...patch };
    cards.set(id, updated);
    return updated;
  });

  const deleteCard = vi.fn(async (id: string): Promise<void> => {
    cards.delete(id);
  });

  const addLabels = vi.fn(async (cardId: string, cardLabels: string[]): Promise<void> => {
    const nextLabels = new Set(labels.get(cardId) ?? []);
    for (const label of cardLabels) {
      nextLabels.add(label);
    }
    labels.set(cardId, nextLabels);
  });

  const removeLabel = vi.fn(async (cardId: string, label: string): Promise<void> => {
    const nextLabels = new Set(labels.get(cardId) ?? []);
    nextLabels.delete(label);
    labels.set(cardId, nextLabels);
  });

  const getLabels = vi.fn(async (cardId: string): Promise<string[]> => {
    return [...(labels.get(cardId) ?? new Set<string>())].sort();
  });

  const updateRun = vi.fn(async (id: string, patch: Partial<Run>): Promise<Run> => {
    const current = runs.get(id);
    if (!current) {
      throw new Error(`Unknown run: ${id}`);
    }
    const updated = { ...current, ...patch };
    runs.set(id, updated);
    return updated;
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
    listCards,
    updateCard,
    deleteCard,
    createRun,
    getRun: async (id: string) => runs.get(id) ?? null,
    updateRun,
    listRunsForCard: async (cardId: string) => [...runs.values()].filter((run) => run.card_id === cardId),
    addLabels,
    removeLabel,
    getLabels,
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
    runs,
    comments,
    createCard,
    listCards,
    updateCard,
    deleteCard,
    addLabels,
    removeLabel,
    getLabels,
    createRun,
    updateRun,
    addComment,
  };
}

function createAdapter() {
  return {
    dispatchInboundMessage: vi.fn(),
  } as unknown as HttpChannelAdapter;
}

function createSseManager() {
  return {
    subscribeCard: vi.fn(() => () => {}),
  } as Pick<SseManager, 'subscribeCard'>;
}

function createSessionManager(): CardRouteDeps['sessionManager'] {
  return {
    abortSession: vi.fn(async () => {}),
  };
}

function createRouteDeps(
  store: ICardStore,
  overrides: Partial<Omit<CardRouteDeps, 'store'>> = {},
): CardRouteDeps {
  return {
    store,
    adapter: overrides.adapter ?? createAdapter(),
    sseManager: overrides.sseManager ?? createSseManager(),
    sessionManager: overrides.sessionManager ?? createSessionManager(),
  };
}

async function openSseStream(
  url: string,
  headers: Record<string, string>,
): Promise<{ response: Response; readChunk: () => Promise<string>; close: () => Promise<void> }> {
  const response = await fetch(url, { headers });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Expected SSE response body');
  }

  return {
    response,
    readChunk: async () => {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      return new TextDecoder().decode(value);
    },
    close: async () => {
      await reader.cancel();
    },
  };
}

describe('registerCardRoutes', () => {
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
        ['create-only', {
          secret: 'create-only-token',
          allowedAgents: ['*'],
          allowedOps: ['card:create'],
        }],
        ['no-delete', {
          secret: 'no-delete-token',
          allowedAgents: ['*'],
          allowedOps: ['card:read', 'card:create', 'card:update'],
        }],
        ['read-only', {
          secret: 'read-only-token',
          allowedAgents: ['*'],
          allowedOps: ['card:read'],
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

  it('creates an idea card without an agent', async () => {
    const { store, createCard, addLabels } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: authHeader,
      payload: {
        title: 'Investigate backlog',
        description: 'Triage it',
        metadata: { priority: 'high' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      card: {
        title: 'Investigate backlog',
        description: 'Triage it',
        status: 'idea',
        agent_bot: null,
        workspace_subdir: null,
        metadata: { priority: 'high' },
      },
    });
    expect(createCard).toHaveBeenCalledWith({
      title: 'Investigate backlog',
      description: 'Triage it',
      created_by: 'ui-desktop-rk',
      metadata: { priority: 'high' },
    });
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('creates an in-progress agent card and adds labels', async () => {
    const { store, createCard, addLabels } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: authHeader,
      payload: {
        title: 'Implement routes',
        agent: 'bob',
        labels: ['backend', 'http'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      card: {
        title: 'Implement routes',
        status: 'in_progress',
        agent_bot: 'bob',
      },
    });
    expect(createCard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Implement routes',
      created_by: 'ui-desktop-rk',
      agent_bot: 'bob',
      status: 'in_progress',
      workspace_subdir: expect.stringMatching(/^card-/),
    }));
    expect(addLabels).toHaveBeenCalledWith('card-1', ['backend', 'http']);
  });

  it('validates title, permissions, and agent access when creating cards', async () => {
    const { store } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const missingTitle = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: authHeader,
      payload: { description: 'Missing title' },
    });
    expect(missingTitle.statusCode).toBe(400);
    expect(missingTitle.json()).toEqual({ error: 'title is required' });

    const forbiddenOp = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: readOnlyHeader,
      payload: { title: 'Should fail' },
    });
    expect(forbiddenOp.statusCode).toBe(403);
    expect(forbiddenOp.json()).toEqual({ error: 'Forbidden' });

    const allowedCreate = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: createOnlyHeader,
      payload: { title: 'Allowed create' },
    });
    expect(allowedCreate.statusCode).toBe(201);

    const forbiddenAgent = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: bobOnlyHeader,
      payload: { title: 'Use lal', agent: 'lal' },
    });
    expect(forbiddenAgent.statusCode).toBe(403);
    expect(forbiddenAgent.json()).toEqual({ error: 'Forbidden' });
  });

  it('lists cards with supported filters and maps agent=none to null', async () => {
    const { store, cards, listCards } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: null, status: 'idea', type: 'work' }));
    cards.set('card-2', createCardRecord({ id: 'card-2', agent_bot: 'bob', status: 'in_progress', type: 'work' }));
    await store.addLabels('card-2', ['backend']);
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const noneResponse = await app.inject({
      method: 'GET',
      url: '/v1/cards?agent=none',
      headers: authHeader,
    });
    expect(noneResponse.statusCode).toBe(200);
    expect(noneResponse.json()).toEqual({ cards: [cards.get('card-1')] });
    expect(listCards).toHaveBeenLastCalledWith({ agent_bot: null });

    const filteredResponse = await app.inject({
      method: 'GET',
      url: '/v1/cards?agent=bob&status=in_progress&label=backend&type=work',
      headers: authHeader,
    });
    expect(filteredResponse.statusCode).toBe(200);
    expect(filteredResponse.json()).toEqual({ cards: [cards.get('card-2')] });
    expect(listCards).toHaveBeenLastCalledWith({
      agent_bot: 'bob',
      status: 'in_progress',
      label: 'backend',
      type: 'work',
    });
  });

  it('returns card details with runs and comments and handles missing cards', async () => {
    const { store, cards, runs, comments } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', title: 'Inspect details' }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'in-progress' }));
    comments.set('card-1', [createCommentRecord({ id: 'comment-9', card_id: 'card-1' })]);
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/cards/card-1',
      headers: authHeader,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      card: cards.get('card-1'),
      runs: [runs.get('run-1')],
      comments: comments.get('card-1'),
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/cards/missing',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Card not found' });
  });

  it('returns 404 for unknown card event streams', async () => {
    const { store } = createStore();
    const sseManager = createSseManager();
    registerCardRoutes(app, createRouteDeps(store, { sseManager }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards/missing/events',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(sseManager.subscribeCard).not.toHaveBeenCalled();
  });

  it('streams card events and replays from Last-Event-ID', async () => {
    const { store, cards } = createStore();
    const sseManager = new SseManager();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'bob' }));
    sseManager.emit('card-1', 'run-1', { event: 'run.in-progress', data: { step: 1 } });
    sseManager.emit('card-1', 'run-2', { event: 'run.completed', data: { step: 2 } });
    registerCardRoutes(app, createRouteDeps(store, { sseManager }));
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }

    const stream = await openSseStream(`http://127.0.0.1:${address.port}/v1/cards/card-1/events`, {
      ...authHeader,
      'last-event-id': '1',
    });

    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('cache-control')).toBe('no-cache');
    expect(stream.response.headers.get('connection')).toBe('keep-alive');
    await expect(stream.readChunk()).resolves.toBe(
      'id: 2\nevent: run.completed\ndata: {"step":2}\n\n',
    );

    await stream.close();
  });

  it('patches card fields and assigns an agent with a workspace subdir', async () => {
    const { store, cards, updateCard } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: null, status: 'idea' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/cards/card-1',
      headers: authHeader,
      payload: {
        title: 'Assigned card',
        description: 'Now owned',
        metadata: { estimate: 3 },
        agent: 'bob',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      card: {
        id: 'card-1',
        title: 'Assigned card',
        description: 'Now owned',
        metadata: { estimate: 3 },
        agent_bot: 'bob',
        status: 'in_progress',
      },
    });
    expect(updateCard).toHaveBeenCalledWith('card-1', {
      title: 'Assigned card',
      description: 'Now owned',
      metadata: { estimate: 3 },
      agent_bot: 'bob',
      status: 'in_progress',
      workspace_subdir: expect.stringMatching(/^card-/),
    });
  });

  it('rejects assigning an agent outside the API key scope', async () => {
    const { store, cards, updateCard } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: null, status: 'idea' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/cards/card-1',
      headers: bobOnlyHeader,
      payload: { agent: 'lal' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('unassigns an agent and cancels active runs', async () => {
    const { store, cards, runs, updateCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'bob', status: 'in_progress' }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'in-progress' }));
    runs.set('run-2', createRunRecord({ id: 'run-2', card_id: 'card-1', status: 'awaiting' }));
    runs.set('run-3', createRunRecord({ id: 'run-3', card_id: 'card-1', status: 'completed' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/cards/card-1',
      headers: authHeader,
      payload: { agent: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ card: { agent_bot: null, status: 'in_progress' } });
    expect(updateRun).toHaveBeenCalledTimes(2);
    expect(updateRun).toHaveBeenCalledWith('run-1', { status: 'cancelled' });
    expect(updateRun).toHaveBeenCalledWith('run-2', { status: 'cancelled' });
    expect(updateCard).toHaveBeenCalledWith('card-1', { agent_bot: null });
  });

  it('rejects unassigning an agent outside the API key scope', async () => {
    const { store, cards, runs, updateCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'lal', status: 'in_progress' }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'in-progress' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/cards/card-1',
      headers: bobOnlyHeader,
      payload: { agent: null },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(updateRun).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('archives cards by cancelling active runs', async () => {
    const { store, cards, runs, updateCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', status: 'in_progress' }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'in-progress' }));
    runs.set('run-2', createRunRecord({ id: 'run-2', card_id: 'card-1', status: 'failed' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/archive',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ card: { status: 'archived' } });
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith('run-1', { status: 'cancelled' });
    expect(updateCard).toHaveBeenCalledWith('card-1', { status: 'archived' });
  });

  it('adds labels to a card and returns the full sorted label list', async () => {
    const { store, cards, addLabels, getLabels } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    await store.addLabels('card-1', ['ops']);
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/labels',
      headers: authHeader,
      payload: { labels: ['backend', 'api'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ labels: ['api', 'backend', 'ops'] });
    expect(addLabels).toHaveBeenCalledWith('card-1', ['backend', 'api']);
    expect(getLabels).toHaveBeenCalledWith('card-1');
  });

  it('returns 404 when adding labels to a missing card', async () => {
    const { store, addLabels, getLabels } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/missing/labels',
      headers: authHeader,
      payload: { labels: ['backend'] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(addLabels).not.toHaveBeenCalled();
    expect(getLabels).not.toHaveBeenCalled();
  });

  it('rejects adding labels without update permission', async () => {
    const { store, cards, addLabels, getLabels } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/labels',
      headers: readOnlyHeader,
      payload: { labels: ['backend'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(addLabels).not.toHaveBeenCalled();
    expect(getLabels).not.toHaveBeenCalled();
  });

  it('rejects adding labels without a labels payload', async () => {
    const { store, cards, addLabels, getLabels } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/labels',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'labels is required' });
    expect(addLabels).not.toHaveBeenCalled();
    expect(getLabels).not.toHaveBeenCalled();
  });

  it('removes labels from a card', async () => {
    const { store, cards, removeLabel } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    await store.addLabels('card-1', ['backend', 'ops']);
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/card-1/labels/backend',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(removeLabel).toHaveBeenCalledWith('card-1', 'backend');
    await expect(store.getLabels('card-1')).resolves.toEqual(['ops']);
  });

  it('returns 404 when removing a label from a missing card', async () => {
    const { store, removeLabel } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/missing/labels/backend',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('rejects removing a label without update permission', async () => {
    const { store, cards, removeLabel } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/card-1/labels/backend',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('aborts a card session, cancels the active run, and keeps the card status unchanged', async () => {
    const { store, cards, runs, updateRun } = createStore();
    cards.set('card-1', createCardRecord({
      id: 'card-1',
      channel_id: 'channel-123',
      status: 'in_progress',
      agent_bot: 'bob',
    }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'in-progress' }));
    runs.set('run-2', createRunRecord({ id: 'run-2', card_id: 'card-1', status: 'completed' }));
    const sessionManager = createSessionManager();
    registerCardRoutes(app, createRouteDeps(store, { sessionManager }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/abort',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      card: expect.objectContaining({
        id: 'card-1',
        channel_id: 'channel-123',
        status: 'in_progress',
        agent_bot: 'bob',
      }),
    });
    expect(sessionManager.abortSession).toHaveBeenCalledWith('channel-123');
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith('run-1', { status: 'cancelled' });
    expect(runs.get('run-1')?.status).toBe('cancelled');
    expect(cards.get('card-1')?.status).toBe('in_progress');
  });

  it('returns 404 when aborting a missing card', async () => {
    const { store, updateRun } = createStore();
    const sessionManager = createSessionManager();
    registerCardRoutes(app, createRouteDeps(store, { sessionManager }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/missing/abort',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('rejects aborting without update permission', async () => {
    const { store, cards, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', channel_id: 'channel-123' }));
    const sessionManager = createSessionManager();
    registerCardRoutes(app, createRouteDeps(store, { sessionManager }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/abort',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('returns 400 when aborting a card without an active session', async () => {
    const { store, cards, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', channel_id: null }));
    const sessionManager = createSessionManager();
    registerCardRoutes(app, createRouteDeps(store, { sessionManager }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/abort',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Card has no active session' });
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('aborts a card session without changing runs when none are active', async () => {
    const { store, cards, runs, updateRun } = createStore();
    cards.set('card-1', createCardRecord({
      id: 'card-1',
      channel_id: 'channel-123',
      status: 'in_progress',
      agent_bot: 'bob',
    }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'completed' }));
    const sessionManager = createSessionManager();
    registerCardRoutes(app, createRouteDeps(store, { sessionManager }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/abort',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      card: expect.objectContaining({
        id: 'card-1',
        status: 'in_progress',
      }),
    });
    expect(sessionManager.abortSession).toHaveBeenCalledWith('channel-123');
    expect(updateRun).not.toHaveBeenCalled();
    expect(runs.get('run-1')?.status).toBe('completed');
  });

  it('rejects archiving without update permission', async () => {
    const { store, cards, updateCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', status: 'in_progress' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/archive',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(updateRun).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('returns 404 when archiving a missing card', async () => {
    const { store, updateCard, updateRun } = createStore();
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/missing/archive',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(updateRun).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('deletes cards after cancelling active runs and enforces delete permission', async () => {
    const { store, cards, runs, deleteCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    runs.set('run-1', createRunRecord({ id: 'run-1', card_id: 'card-1', status: 'created' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const forbidden = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/card-1',
      headers: noDeleteHeader,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'Forbidden' });

    const missing = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/missing',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Card not found' });

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/cards/card-1',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(updateRun).toHaveBeenCalledWith('run-1', { status: 'cancelled' });
    expect(deleteCard).toHaveBeenCalledWith('card-1');
  });

  it('enforces read and update permissions', async () => {
    const { store, cards } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1' }));
    registerCardRoutes(app, createRouteDeps(store));
    await app.ready();

    const readForbidden = await app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: createOnlyHeader,
    });
    expect(readForbidden.statusCode).toBe(403);
    expect(readForbidden.json()).toEqual({ error: 'Forbidden' });

    const updateForbidden = await app.inject({
      method: 'PATCH',
      url: '/v1/cards/card-1',
      headers: createOnlyHeader,
      payload: { title: 'Nope' },
    });
    expect(updateForbidden.statusCode).toBe(403);
    expect(updateForbidden.json()).toEqual({ error: 'Forbidden' });
  });

  it('posts card comments, creates a run, and dispatches the inbound message', async () => {
    const { store, cards, addComment, createRun } = createStore();
    cards.set('card-1', createCardRecord({
      id: 'card-1',
      agent_bot: 'bob',
      channel_id: 'channel-123',
      status: 'in_progress',
    }));
    const adapter = createAdapter();
    registerCardRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/comments',
      headers: authHeader,
      payload: { content: 'Please take another pass' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      comment: expect.objectContaining({
        id: 'comment-1',
        card_id: 'card-1',
        author_kind: 'human',
        author_id: 'ui-desktop-rk',
        content: JSON.stringify({
          role: 'user',
          parts: [{ type: 'text', text: 'Please take another pass' }],
        }),
      }),
      run_id: 'run-1',
    });
    expect(addComment).toHaveBeenCalledWith({
      card_id: 'card-1',
      author_kind: 'human',
      author_id: 'ui-desktop-rk',
      content: JSON.stringify({
        role: 'user',
        parts: [{ type: 'text', text: 'Please take another pass' }],
      }),
    });
    expect(createRun).toHaveBeenCalledWith({
      card_id: 'card-1',
      session_id: 'card-1',
      agent_name: 'bob',
      input: [{
        role: 'user',
        parts: [{ type: 'text', text: 'Please take another pass' }],
      }],
    });
    expect(adapter.dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: 'channel-123',
      userId: 'ui-desktop-rk',
      username: 'ui-desktop-rk',
      text: 'Please take another pass',
      postId: 'comment-1',
      mentionsBot: true,
      isDM: false,
    });
  });

  it('returns 404 when posting a comment to a missing card', async () => {
    const { store, addComment, createRun } = createStore();
    const adapter = createAdapter();
    registerCardRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/missing/comments',
      headers: authHeader,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Card not found' });
    expect(addComment).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(adapter.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects comments on cards without assigned agents', async () => {
    const { store, cards, addComment, createRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: null }));
    const adapter = createAdapter();
    registerCardRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/comments',
      headers: authHeader,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Card has no assigned agent' });
    expect(addComment).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(adapter.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('enforces comment permissions and agent access for card comments', async () => {
    const { store, cards, addComment, createRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'bob' }));
    cards.set('card-2', createCardRecord({ id: 'card-2', agent_bot: 'lal' }));
    const adapter = createAdapter();
    registerCardRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const forbiddenOp = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/comments',
      headers: createOnlyHeader,
      payload: { content: 'hello' },
    });
    expect(forbiddenOp.statusCode).toBe(403);
    expect(forbiddenOp.json()).toEqual({ error: 'Forbidden' });

    const forbiddenAgent = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-2/comments',
      headers: bobOnlyHeader,
      payload: { content: 'hello' },
    });
    expect(forbiddenAgent.statusCode).toBe(403);
    expect(forbiddenAgent.json()).toEqual({ error: 'Forbidden' });

    expect(addComment).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(adapter.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('validates comment content before creating a run', async () => {
    const { store, cards, addComment, createRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: 'bob' }));
    const adapter = createAdapter();
    registerCardRoutes(app, createRouteDeps(store, { adapter }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cards/card-1/comments',
      headers: authHeader,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'content is required' });
    expect(addComment).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(adapter.dispatchInboundMessage).not.toHaveBeenCalled();
  });
});
