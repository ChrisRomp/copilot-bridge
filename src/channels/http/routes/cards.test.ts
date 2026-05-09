import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import { registerCardRoutes } from './cards.js';
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
  let nextCard = 1;

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

  const addLabels = vi.fn(async (_cardId: string, _labels: string[]): Promise<void> => {});

  const updateRun = vi.fn(async (id: string, patch: Partial<Run>): Promise<Run> => {
    const current = runs.get(id);
    if (!current) {
      throw new Error(`Unknown run: ${id}`);
    }
    const updated = { ...current, ...patch };
    runs.set(id, updated);
    return updated;
  });

  const store: ICardStore = {
    initialize: async () => {},
    createCard,
    getCard: async (id: string) => cards.get(id) ?? null,
    listCards,
    updateCard,
    deleteCard,
    createRun: async (run: NewRun): Promise<Run> => createRunRecord({
      card_id: run.card_id,
      session_id: run.session_id,
      agent_name: run.agent_name,
      input: run.input,
    }),
    getRun: async (id: string) => runs.get(id) ?? null,
    updateRun,
    listRunsForCard: async (cardId: string) => [...runs.values()].filter((run) => run.card_id === cardId),
    addLabels,
    removeLabel: async (_cardId: string, _label: string) => {},
    getLabels: async (_cardId: string) => [],
    addComment: async (comment: NewCardComment): Promise<CardComment> => createCommentRecord({
      card_id: comment.card_id,
      author_kind: comment.author_kind,
      author_id: comment.author_id,
      content: comment.content,
    }),
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

  return { store, cards, runs, comments, createCard, listCards, updateCard, deleteCard, addLabels, updateRun };
}

function createAdapter(): HttpChannelAdapter {
  return {} as HttpChannelAdapter;
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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

  it('patches card fields and assigns an agent with a workspace subdir', async () => {
    const { store, cards, updateCard } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', agent_bot: null, status: 'idea' }));
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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

  it('rejects archiving without update permission', async () => {
    const { store, cards, updateCard, updateRun } = createStore();
    cards.set('card-1', createCardRecord({ id: 'card-1', status: 'in_progress' }));
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
    registerCardRoutes(app, { store, adapter: createAdapter() });
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
});
