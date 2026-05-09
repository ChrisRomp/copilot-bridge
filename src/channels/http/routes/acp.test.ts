import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import { registerAcpRoutes } from './acp.js';
import type { HttpChannelAdapter } from '../index.js';
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
import type { AcpMessage } from '../acp.js';

const timestamp = '2026-05-09T00:00:00Z';
const authHeader = { authorization: 'Bearer secret-token' };
const limitedAuthHeader = { authorization: 'Bearer bob-only-token' };

function createMessage(text: string): AcpMessage[] {
  return [{ role: 'user', parts: [{ type: 'text', text }] }];
}

function createRunRecord(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    card_id: 'card-1',
    session_id: 'session-1',
    agent_name: 'bob',
    status: 'created',
    input: createMessage('hello'),
    output: [],
    error: null,
    created_at: timestamp,
    finished_at: null,
    ...overrides,
  };
}

function createCardRecord(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    channel_id: null,
    type: 'work',
    agent_bot: 'bob',
    title: 'hello',
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

function createStore() {
  const cards = new Map<string, Card>();
  const runs = new Map<string, Run>();
  let nextCard = 1;
  let nextRun = 1;

  const createCard = vi.fn(async (card: NewCard): Promise<Card> => {
    const created = createCardRecord({
      id: `card-${nextCard++}`,
      title: card.title,
      type: card.type ?? 'work',
      agent_bot: card.agent_bot ?? null,
      status: card.status ?? 'in_progress',
      created_by: card.created_by,
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
      status: 'created',
    });
    runs.set(created.id, created);
    return created;
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

  const store: ICardStore = {
    initialize: async () => {},
    createCard,
    getCard: async (id: string) => cards.get(id) ?? null,
    listCards: async (_filter: CardFilter) => [...cards.values()],
    updateCard: async (id: string, patch: Partial<Card>) => {
      const current = cards.get(id);
      if (!current) throw new Error(`Unknown card: ${id}`);
      const updated = { ...current, ...patch };
      cards.set(id, updated);
      return updated;
    },
    deleteCard: async (id: string) => {
      cards.delete(id);
    },
    createRun,
    getRun: async (id: string) => runs.get(id) ?? null,
    updateRun,
    listRunsForCard: async (cardId: string) => [...runs.values()].filter((run) => run.card_id === cardId),
    addLabels: async (_cardId: string, _labels: string[]) => {},
    removeLabel: async (_cardId: string, _label: string) => {},
    getLabels: async (_cardId: string) => [],
    addComment: async (comment: NewCardComment): Promise<CardComment> => ({
      id: 'comment-1',
      card_id: comment.card_id,
      author_kind: comment.author_kind,
      author_id: comment.author_id,
      content: comment.content,
      created_at: timestamp,
    }),
    listComments: async (_cardId: string) => [],
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

  return { store, createCard, createRun, updateRun, runs, cards };
}

function createAdapter() {
  return {
    dispatchInboundMessage: vi.fn(),
  } as unknown as HttpChannelAdapter;
}

describe('registerAcpRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
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

  it('lists only agents the api key can access', async () => {
    const { store } = createStore();
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: {
        bob: { token: 'x', agent: 'bob-agent' },
        lal: { token: 'y', agent: 'lal-agent' },
      },
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: limitedAuthHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [{
        name: 'bob',
        description: 'Agent: bob-agent',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
      }],
    });
  });

  it('gets a single agent manifest and enforces access', async () => {
    const { store } = createStore();
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: {
        bob: { token: 'x', agent: 'bob-agent' },
        lal: { token: 'y', agent: 'lal-agent' },
      },
    });
    await app.ready();

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/agents/bob',
      headers: limitedAuthHeader,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'bob', description: 'Agent: bob-agent' });

    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/agents/lal',
      headers: limitedAuthHeader,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'Forbidden' });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/agents/missing',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Agent not found' });
  });

  it('creates a run, creates a card, and dispatches an inbound message', async () => {
    const { store, createCard, createRun, runs } = createStore();
    const adapter = createAdapter();
    registerAcpRoutes(app, {
      store,
      adapter,
      bots: { bob: { token: 'x', agent: 'bob-agent' } },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader,
      payload: {
        agent_name: 'bob',
        mode: 'async',
        input: createMessage('Plan the migration'),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { run: Run };
    expect(body.run).toMatchObject({ agent_name: 'bob', status: 'in-progress' });
    expect(createCard).toHaveBeenCalledOnce();
    expect(createRun).toHaveBeenCalledOnce();
    expect(adapter.dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: body.run.card_id,
      userId: 'ui-desktop-rk',
      username: 'ui-desktop-rk',
      text: 'Plan the migration',
      postId: body.run.id,
      mentionsBot: true,
      isDM: false,
    });
    expect(runs.get(body.run.id)?.status).toBe('in-progress');
  });

  it('reuses the same card for subsequent runs in the same session', async () => {
    const { store, createCard } = createStore();
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader,
      payload: {
        agent_name: 'bob',
        session_id: 'session-42',
        mode: 'async',
        input: createMessage('First message'),
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader,
      payload: {
        agent_name: 'bob',
        session_id: 'session-42',
        mode: 'async',
        input: createMessage('Second message'),
      },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createCard).toHaveBeenCalledOnce();
    expect((first.json() as { run: Run }).run.card_id).toBe((second.json() as { run: Run }).run.card_id);
  });

  it('returns runs by id and 404s for unknown ids', async () => {
    const { store, runs } = createStore();
    runs.set('run-99', createRunRecord({ id: 'run-99', status: 'completed' }));
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/runs/run-99',
      headers: authHeader,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ run: runs.get('run-99') });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/runs/run-missing',
      headers: authHeader,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Run not found' });
  });

  it('resumes awaiting runs and rejects non-awaiting runs', async () => {
    const { store, runs } = createStore();
    const adapter = createAdapter();
    runs.set('run-awaiting', createRunRecord({ id: 'run-awaiting', status: 'awaiting' }));
    runs.set('run-complete', createRunRecord({ id: 'run-complete', status: 'completed' }));
    registerAcpRoutes(app, {
      store,
      adapter,
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/runs/run-awaiting',
      headers: authHeader,
      payload: {
        await_resume: createMessage('continue'),
        mode: 'async',
      },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ run: { id: 'run-awaiting', status: 'in-progress' } });
    expect(adapter.dispatchInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'card-1',
      postId: 'run-awaiting',
      text: 'continue',
    }));

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/runs/run-complete',
      headers: authHeader,
      payload: {
        await_resume: createMessage('continue'),
        mode: 'async',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'Run is completed, not awaiting' });
  });

  it('cancels a run and returns 202', async () => {
    const { store, runs, updateRun } = createStore();
    runs.set('run-cancel', createRunRecord({ id: 'run-cancel', status: 'in-progress' }));
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run-cancel/cancel',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ run: { id: 'run-cancel', status: 'cancelled' } });
    expect(updateRun).toHaveBeenNthCalledWith(1, 'run-cancel', { status: 'cancelling' });
    expect(updateRun).toHaveBeenNthCalledWith(2, 'run-cancel', expect.objectContaining({ status: 'cancelled' }));
  });

  it('returns session history for runs created in a session', async () => {
    const { store } = createStore();
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader,
      payload: {
        agent_name: 'bob',
        session_id: 'session-abc',
        mode: 'async',
        input: createMessage('hello session'),
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session-abc',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: {
        id: 'session-abc',
        history: [{ run_id: (created.json() as { run: Run }).run.id, status: 'in-progress' }],
      },
    });
  });

  it('rejects unsupported run modes', async () => {
    const { store } = createStore();
    registerAcpRoutes(app, {
      store,
      adapter: createAdapter(),
      bots: { bob: { token: 'x' } },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader,
      payload: {
        agent_name: 'bob',
        mode: 'sync',
        input: createMessage('not yet'),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Only async mode is supported' });
  });
});
