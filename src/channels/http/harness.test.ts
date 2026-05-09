import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICardStore, NewCard, NewCardComment, NewCheckpoint, NewRun, NewSessionTurn, SessionTurn } from './store.js';
import { CopilotHarnessAdapter } from './harness.js';

function createMockStore() {
  const appendTurn = vi.fn(async (turn: NewSessionTurn): Promise<SessionTurn> => ({
    id: `turn-${turn.turn_index}`,
    card_id: turn.card_id,
    run_id: turn.run_id ?? null,
    turn_index: turn.turn_index,
    role: turn.role,
    content: turn.content,
    git_ref: turn.git_ref ?? null,
    created_at: '2026-05-09T00:00:00Z',
  }));

  const store: ICardStore = {
    initialize: async () => {},
    createCard: async (_card: NewCard) => { throw new Error('not implemented'); },
    getCard: async () => null,
    listCards: async () => [],
    updateCard: async () => { throw new Error('not implemented'); },
    deleteCard: async () => {},
    createRun: async (_run: NewRun) => { throw new Error('not implemented'); },
    getRun: async () => null,
    updateRun: async () => { throw new Error('not implemented'); },
    listRunsForCard: async () => [],
    addLabels: async () => {},
    removeLabel: async () => {},
    getLabels: async () => [],
    addComment: async (_comment: NewCardComment) => { throw new Error('not implemented'); },
    listComments: async () => [],
    appendTurn,
    listTurns: async () => [],
    createCheckpoint: async (_checkpoint: NewCheckpoint) => { throw new Error('not implemented'); },
    listCheckpoints: async () => [],
    deleteCheckpoint: async () => {},
  };

  return { store, appendTurn };
}

describe('CopilotHarnessAdapter', () => {
  const cardId = 'card-1';
  const runId = 'run-1';

  let appendTurn: ReturnType<typeof createMockStore>['appendTurn'];
  let adapter: CopilotHarnessAdapter;

  beforeEach(() => {
    const mockStore = createMockStore();
    appendTurn = mockStore.appendTurn;
    adapter = new CopilotHarnessAdapter(mockStore.store);
  });

  it('translates and persists user, tool, and assistant events', async () => {
    const userEvent = await adapter.handleSdkEvent(cardId, runId, {
      type: 'user.message',
      data: { content: 'Run diagnostics' },
    });
    const toolStartEvent = await adapter.handleSdkEvent(cardId, runId, {
      type: 'tool.execution_start',
      data: { toolCallId: 'tool-1', toolName: 'bash', arguments: { command: 'echo ok' } },
    });
    const toolCompleteEvent = await adapter.handleSdkEvent(cardId, runId, {
      type: 'tool.execution_complete',
      data: { toolCallId: 'tool-1', result: { stdout: 'ok' } },
    });
    const assistantEvent = await adapter.handleSdkEvent(cardId, runId, {
      type: 'assistant.message',
      data: { content: 'Done.' },
    });

    expect(appendTurn).toHaveBeenCalledTimes(4);
    expect(appendTurn.mock.calls.map(([turn]) => turn.role)).toEqual([
      'user',
      'tool_call',
      'tool_result',
      'assistant',
    ]);

    expect(userEvent).toMatchObject({
      id: 'run-1:0',
      event: 'message.created',
      data: {
        role: 'user',
        parts: [{ type: 'text', text: 'Run diagnostics' }],
      },
    });

    expect(toolStartEvent).toMatchObject({
      id: 'run-1:1',
      event: 'message.part',
      data: {
        type: 'trajectory',
        metadata: {
          tool_name: 'bash',
          tool_input: { command: 'echo ok' },
          tool_call_id: 'tool-1',
          status: 'in_progress',
        },
      },
    });

    expect(toolCompleteEvent).toMatchObject({
      id: 'run-1:2',
      event: 'message.part',
      data: {
        type: 'trajectory',
        metadata: {
          tool_name: 'bash',
          tool_input: { command: 'echo ok' },
          tool_output: { stdout: 'ok' },
          tool_call_id: 'tool-1',
          status: 'completed',
        },
      },
    });

    expect(assistantEvent).toMatchObject({
      id: 'run-1:3',
      event: 'message.completed',
      data: {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done.' }],
      },
    });

    expect(JSON.parse(appendTurn.mock.calls[1]?.[0].content ?? '{}')).toMatchObject({
      tool_call_id: 'tool-1',
      status: 'in_progress',
    });
    expect(JSON.parse(appendTurn.mock.calls[2]?.[0].content ?? '{}')).toMatchObject({
      tool_call_id: 'tool-1',
      tool_output: { stdout: 'ok' },
      status: 'completed',
    });

    await expect(adapter.finalizeRun(cardId, runId)).resolves.toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'trajectory',
          metadata: {
            tool_name: 'bash',
            tool_input: { command: 'echo ok' },
            tool_output: { stdout: 'ok' },
            tool_call_id: 'tool-1',
            status: 'completed',
          },
        }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done.' }],
      },
    ]);
    await expect(adapter.finalizeRun(cardId, runId)).resolves.toEqual([]);
  });

  it('emits assistant deltas without persisting turns', async () => {
    const deltaEvent = await adapter.handleSdkEvent(cardId, runId, {
      type: 'assistant.message_delta',
      data: { delta: 'partial' },
    });

    expect(deltaEvent).toEqual({
      id: 'run-1:0',
      event: 'message.part',
      data: { delta: 'partial' },
    });
    expect(appendTurn).not.toHaveBeenCalled();
  });

  it('returns null for session idle and unknown events', async () => {
    await expect(adapter.handleSdkEvent(cardId, runId, { type: 'session.idle' })).resolves.toBeNull();
    await expect(adapter.handleSdkEvent(cardId, runId, { type: 'session.error' })).resolves.toBeNull();
  });

  it('cleans up pending tool calls on finalize', async () => {
    await adapter.handleSdkEvent(cardId, runId, {
      type: 'tool.execution_start',
      data: { toolCallId: 'tool-stale', toolName: 'bash', arguments: { command: 'sleep 1' } },
    });

    await adapter.finalizeRun(cardId, runId);

    await expect(adapter.handleSdkEvent(cardId, runId, {
      type: 'tool.execution_complete',
      data: { toolCallId: 'tool-stale', result: { stdout: 'late' } },
    })).resolves.toBeNull();
  });
});
