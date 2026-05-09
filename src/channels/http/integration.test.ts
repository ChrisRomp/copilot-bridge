import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook } from './auth.js';
import { registerCardRoutes, type CardRouteDeps } from './routes/cards.js';
import { SseManager } from './sse.js';
import { CopilotHarnessAdapter } from './harness.js';
import { routeHttpSessionEvent } from './event-routing.js';
import type { HttpChannelAdapter } from './index.js';
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

const timestamp = '2026-05-09T00:00:00Z';
const authHeader = { authorization: 'Bearer secret-token' };

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

function createIntegrationStore() {
  const cards = new Map<string, Card>();
  const runs = new Map<string, Run>();
  const comments = new Map<string, CardComment[]>();
  const turns = new Map<string, SessionTurn[]>();
  const checkpoints = new Map<string, Checkpoint[]>();
  const labels = new Map<string, Set<string>>();
  let nextCard = 1;
  let nextRun = 1;
  let nextComment = 1;
  let nextTurn = 1;
  let nextCheckpoint = 1;

  const store: ICardStore = {
    initialize: async () => {},
    createCard: async (card: NewCard): Promise<Card> => {
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
    },
    getCard: async (id: string) => cards.get(id) ?? null,
    listCards: async (filter: CardFilter): Promise<Card[]> => {
      return [...cards.values()].filter((card) => {
        if (filter.agent_bot !== undefined && card.agent_bot !== filter.agent_bot) return false;
        if (filter.status !== undefined && card.status !== filter.status) return false;
        if (filter.type !== undefined && card.type !== filter.type) return false;
        if (filter.label !== undefined && !labels.get(card.id)?.has(filter.label)) return false;
        return true;
      });
    },
    updateCard: async (id: string, patch: Partial<Card>): Promise<Card> => {
      const current = cards.get(id);
      if (!current) throw new Error(`Unknown card: ${id}`);
      const updated = { ...current, ...patch };
      cards.set(id, updated);
      return updated;
    },
    deleteCard: async (id: string) => { cards.delete(id); },
    createRun: async (run: NewRun): Promise<Run> => {
      const created = createRunRecord({
        id: `run-${nextRun++}`,
        card_id: run.card_id,
        session_id: run.session_id,
        agent_name: run.agent_name,
        input: run.input,
      });
      runs.set(created.id, created);
      return created;
    },
    getRun: async (id: string) => runs.get(id) ?? null,
    updateRun: async (id: string, patch: Partial<Run>): Promise<Run> => {
      const current = runs.get(id);
      if (!current) throw new Error(`Unknown run: ${id}`);
      const updated = { ...current, ...patch };
      runs.set(id, updated);
      return updated;
    },
    listRunsForCard: async (cardId: string) =>
      [...runs.values()].filter((r) => r.card_id === cardId),
    addLabels: async (cardId: string, cardLabels: string[]) => {
      const existing = labels.get(cardId) ?? new Set<string>();
      for (const label of cardLabels) existing.add(label);
      labels.set(cardId, existing);
    },
    removeLabel: async (cardId: string, label: string) => {
      const existing = labels.get(cardId) ?? new Set<string>();
      existing.delete(label);
      labels.set(cardId, existing);
    },
    getLabels: async (cardId: string) =>
      [...(labels.get(cardId) ?? new Set<string>())].sort(),
    addComment: async (comment: NewCardComment): Promise<CardComment> => {
      const created: CardComment = {
        id: `comment-${nextComment++}`,
        card_id: comment.card_id,
        author_kind: comment.author_kind,
        author_id: comment.author_id,
        content: comment.content,
        created_at: timestamp,
      };
      comments.set(comment.card_id, [
        ...(comments.get(comment.card_id) ?? []),
        created,
      ]);
      return created;
    },
    listComments: async (cardId: string) => comments.get(cardId) ?? [],
    appendTurn: async (turn: NewSessionTurn): Promise<SessionTurn> => {
      const created: SessionTurn = {
        id: `turn-${nextTurn++}`,
        card_id: turn.card_id,
        run_id: turn.run_id ?? null,
        turn_index: turn.turn_index,
        role: turn.role,
        content: turn.content,
        git_ref: turn.git_ref ?? null,
        created_at: timestamp,
      };
      turns.set(turn.card_id, [
        ...(turns.get(turn.card_id) ?? []),
        created,
      ]);
      return created;
    },
    listTurns: async (cardId: string, upToIndex?: number) => {
      const cardTurns = turns.get(cardId) ?? [];
      if (upToIndex === undefined) return cardTurns;
      return cardTurns.filter((t) => t.turn_index <= upToIndex);
    },
    createCheckpoint: async (checkpoint: NewCheckpoint): Promise<Checkpoint> => {
      const created: Checkpoint = {
        id: `checkpoint-${nextCheckpoint++}`,
        card_id: checkpoint.card_id,
        name: checkpoint.name ?? null,
        turn_index: checkpoint.turn_index,
        git_ref: checkpoint.git_ref ?? null,
        created_by: checkpoint.created_by,
        created_at: timestamp,
      };
      checkpoints.set(checkpoint.card_id, [
        ...(checkpoints.get(checkpoint.card_id) ?? []),
        created,
      ]);
      return created;
    },
    listCheckpoints: async (cardId: string) =>
      checkpoints.get(cardId) ?? [],
    deleteCheckpoint: async (id: string) => {
      for (const [cardId, list] of checkpoints.entries()) {
        const filtered = list.filter((c) => c.id !== id);
        if (filtered.length !== list.length) checkpoints.set(cardId, filtered);
      }
    },
  };

  return { store, cards, runs, comments, turns, labels };
}

function createAdapter() {
  return {
    dispatchInboundMessage: vi.fn(),
  } as unknown as HttpChannelAdapter;
}

function createSessionManager(): CardRouteDeps['sessionManager'] {
  return { abortSession: vi.fn(async () => {}) };
}

async function openSseStream(
  url: string,
  headers: Record<string, string>,
): Promise<{
  response: Response;
  readChunk: () => Promise<string>;
  close: () => Promise<void>;
}> {
  const response = await fetch(url, { headers });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected SSE response body');
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

describe('HTTP channel integration', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, {
      keys: new Map([
        [
          'ui-desktop-rk',
          {
            secret: 'secret-token',
            allowedAgents: ['*'],
            allowedOps: ['*'],
          },
        ],
      ]),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('card lifecycle: create, SSE, comment, turns, labels, checkpoint, abort, archive', async () => {
    const { store } = createIntegrationStore();
    const sseManager = new SseManager();
    const harness = new CopilotHarnessAdapter(store);
    const adapter = createAdapter();
    const sessionManager = createSessionManager();
    registerCardRoutes(app, { store, adapter, sseManager, sessionManager });
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Step 1: Create card with agent assigned
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: authHeader,
      payload: { title: 'Integration test card', agent: 'bob' },
    });
    expect(createRes.statusCode).toBe(201);
    const cardId = (createRes.json() as { card: Card }).card.id;
    expect(createRes.json()).toMatchObject({
      card: {
        title: 'Integration test card',
        agent_bot: 'bob',
        status: 'in_progress',
      },
    });

    // Step 2: Open SSE stream
    const stream = await openSseStream(
      `${baseUrl}/v1/cards/${cardId}/events`,
      authHeader,
    );
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );

    // Step 3: Post a comment (creates run and dispatches inbound message)
    const commentRes = await app.inject({
      method: 'POST',
      url: `/v1/cards/${cardId}/comments`,
      headers: authHeader,
      payload: { content: 'Run the diagnostics' },
    });
    expect(commentRes.statusCode).toBe(201);
    const { run_id: runId } = commentRes.json() as {
      comment: CardComment;
      run_id: string;
    };
    expect(adapter.dispatchInboundMessage).toHaveBeenCalledOnce();

    // Step 4+5: Simulate SDK events and verify SSE stream receives message.created
    const routeDeps = { store, harness, sseManager };
    const routed = await routeHttpSessionEvent(
      cardId,
      { type: 'user.message', data: { content: 'Run the diagnostics' } },
      routeDeps,
    );
    expect(routed).toBe(true);

    const chunk1 = await stream.readChunk();
    expect(chunk1).toContain('event: message.created');
    expect(chunk1).toContain('Run the diagnostics');

    // Emit assistant response for richer turn data
    await routeHttpSessionEvent(
      cardId,
      {
        type: 'assistant.message',
        data: { content: 'Diagnostics complete.' },
      },
      routeDeps,
    );
    const chunk2 = await stream.readChunk();
    expect(chunk2).toContain('event: message.completed');

    // Step 6: Verify session_turns populated with correct roles and turn_index
    const storedTurns = await store.listTurns(cardId);
    expect(storedTurns).toHaveLength(2);
    expect(storedTurns[0]).toMatchObject({
      card_id: cardId,
      role: 'user',
      turn_index: 0,
    });
    expect(storedTurns[1]).toMatchObject({
      card_id: cardId,
      role: 'assistant',
      turn_index: 1,
    });

    // Step 7: GET card shows comment in comments[]
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/cards/${cardId}`,
      headers: authHeader,
    });
    expect(getRes.statusCode).toBe(200);
    const cardDetail = getRes.json() as {
      card: Card;
      comments: CardComment[];
    };
    expect(cardDetail.comments).toHaveLength(1);
    expect(cardDetail.comments[0]).toMatchObject({
      card_id: cardId,
      author_kind: 'human',
    });

    // Step 8: Add label, verify GET /v1/cards?label=... filter works
    const labelRes = await app.inject({
      method: 'POST',
      url: `/v1/cards/${cardId}/labels`,
      headers: authHeader,
      payload: { labels: ['integration'] },
    });
    expect(labelRes.statusCode).toBe(200);

    const filterRes = await app.inject({
      method: 'GET',
      url: '/v1/cards?label=integration',
      headers: authHeader,
    });
    expect(filterRes.statusCode).toBe(200);
    const filteredCards = (filterRes.json() as { cards: Card[] }).cards;
    expect(filteredCards).toHaveLength(1);
    expect(filteredCards[0].id).toBe(cardId);

    // Step 9: Create checkpoint, verify turn_index captured
    const cpRes = await app.inject({
      method: 'POST',
      url: `/v1/cards/${cardId}/checkpoints`,
      headers: authHeader,
      payload: { name: 'Before abort' },
    });
    expect(cpRes.statusCode).toBe(201);
    const { checkpoint } = cpRes.json() as { checkpoint: Checkpoint };
    expect(checkpoint.turn_index).toBe(1);
    expect(checkpoint.name).toBe('Before abort');

    // Step 10: Abort card - set channel_id first (normally set by session wiring)
    await store.updateCard(cardId, { channel_id: cardId });
    const abortRes = await app.inject({
      method: 'POST',
      url: `/v1/cards/${cardId}/abort`,
      headers: authHeader,
    });
    expect(abortRes.statusCode).toBe(200);
    expect(
      (abortRes.json() as { card: Card }).card.status,
    ).toBe('in_progress');
    expect(sessionManager.abortSession).toHaveBeenCalledWith(cardId);
    const cancelledRun = await store.getRun(runId);
    expect(cancelledRun?.status).toBe('cancelled');

    // Step 11: Post another comment, verify new run created
    const comment2Res = await app.inject({
      method: 'POST',
      url: `/v1/cards/${cardId}/comments`,
      headers: authHeader,
      payload: { content: 'Try again please' },
    });
    expect(comment2Res.statusCode).toBe(201);
    const newRunId = (comment2Res.json() as { run_id: string }).run_id;
    expect(newRunId).not.toBe(runId);
    const newRun = await store.getRun(newRunId);
    expect(newRun?.status).toBe('created');

    // Step 12: Archive card via PATCH with status=archived
    const archiveRes = await app.inject({
      method: 'PATCH',
      url: `/v1/cards/${cardId}`,
      headers: authHeader,
      payload: { status: 'archived' },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(
      (archiveRes.json() as { card: Card }).card.status,
    ).toBe('archived');

    await stream.close();
  });
});
