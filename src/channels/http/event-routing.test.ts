import { describe, expect, it, vi } from 'vitest';
import type { Card, ICardStore, Run } from './store.js';
import { resolveActiveRunId, routeHttpSessionEvent, selectActiveRunId } from './event-routing.js';

function createCard(id: string): Card {
  return {
    id,
    channel_id: null,
    type: 'work',
    agent_bot: 'bob',
    title: 'Card',
    description: null,
    status: 'in_progress',
    created_by: 'user-1',
    workspace_subdir: null,
    metadata: {},
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    archived_at: null,
  };
}

function createRun(id: string, status: string): Run {
  return {
    id,
    card_id: 'card-1',
    session_id: 'session-1',
    agent_name: 'bob',
    status,
    input: [],
    output: [],
    error: null,
    created_at: '2026-05-09T00:00:00Z',
    finished_at: null,
  };
}

function createStore(overrides: {
  getCard?: (id: string) => Promise<Card | null>;
  listRunsForCard?: (cardId: string) => Promise<Run[]>;
} = {}): Pick<ICardStore, 'getCard' | 'listRunsForCard'> {
  return {
    getCard: overrides.getCard ?? (async () => null),
    listRunsForCard: overrides.listRunsForCard ?? (async () => []),
  };
}

describe('http event routing', () => {
  it('routes sdk events through the harness and SSE manager', async () => {
    const store = createStore({
      getCard: async (id) => id === 'card-1' ? createCard(id) : null,
      listRunsForCard: async () => [createRun('run-old', 'completed'), createRun('run-active', 'in-progress')],
    });
    const harness = { handleSdkEvent: vi.fn(async () => ({ event: 'message.part', data: { delta: 'hi' } })) };
    const sseManager = { emit: vi.fn() };

    await expect(routeHttpSessionEvent('card-1', { type: 'assistant.message_delta', data: { delta: 'hi' } }, {
      store,
      harness,
      sseManager,
    })).resolves.toBe(true);

    expect(harness.handleSdkEvent).toHaveBeenCalledWith('card-1', 'run-active', {
      type: 'assistant.message_delta',
      data: { delta: 'hi' },
    });
    expect(sseManager.emit).toHaveBeenCalledWith('card-1', 'run-active', {
      event: 'message.part',
      data: { delta: 'hi' },
    });
  });

  it('skips routing when the card cannot be resolved', async () => {
    const store = createStore();
    const harness = { handleSdkEvent: vi.fn(async () => ({ event: 'message.part', data: {} })) };
    const sseManager = { emit: vi.fn() };

    await expect(routeHttpSessionEvent('missing-card', { type: 'assistant.message' }, {
      store,
      harness,
      sseManager,
    })).resolves.toBe(false);

    expect(harness.handleSdkEvent).not.toHaveBeenCalled();
    expect(sseManager.emit).not.toHaveBeenCalled();
  });

  it('skips routing when there is no active run', async () => {
    const store = createStore({
      getCard: async () => createCard('card-1'),
      listRunsForCard: async () => [createRun('run-1', 'completed'), createRun('run-2', 'failed')],
    });
    const harness = { handleSdkEvent: vi.fn(async () => null) };
    const sseManager = { emit: vi.fn() };

    await expect(routeHttpSessionEvent('card-1', { type: 'assistant.message' }, {
      store,
      harness,
      sseManager,
    })).resolves.toBe(false);

    expect(harness.handleSdkEvent).not.toHaveBeenCalled();
    expect(sseManager.emit).not.toHaveBeenCalled();
  });

  it('selects the most recent non-terminal run', async () => {
    const store = createStore({
      listRunsForCard: async () => [
        createRun('run-1', 'completed'),
        createRun('run-2', 'awaiting'),
        createRun('run-3', 'in-progress'),
      ],
    });

    await expect(resolveActiveRunId('card-1', store)).resolves.toBe('run-3');
    expect(selectActiveRunId([
      createRun('run-1', 'completed'),
      createRun('run-2', 'awaiting'),
      createRun('run-3', 'cancelled'),
    ])).toBe('run-2');
  });
});
