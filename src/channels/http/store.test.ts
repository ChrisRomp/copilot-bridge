import { describe, expect, it } from 'vitest';
import * as cardStoreModule from './store.js';
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

const timestamp = '2026-05-08T00:00:00Z';

function createMockCardStore(): ICardStore {
  const baseCard: Card = {
    id: 'card-1',
    channel_id: null,
    type: 'work',
    agent_bot: null,
    title: 'Example card',
    description: null,
    status: 'idea',
    created_by: 'api-key-1',
    workspace_subdir: null,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
  };

  const baseRun: Run = {
    id: 'run-1',
    card_id: baseCard.id,
    session_id: 'session-1',
    agent_name: 'bob',
    status: 'completed',
    input: [],
    output: [],
    error: null,
    created_at: timestamp,
    finished_at: timestamp,
  };

  const baseComment: CardComment = {
    id: 'comment-1',
    card_id: baseCard.id,
    author_kind: 'human',
    author_id: 'user-1',
    content: '{"type":"text","text":"hello"}',
    created_at: timestamp,
  };

  const baseTurn: SessionTurn = {
    id: 'turn-1',
    card_id: baseCard.id,
    run_id: baseRun.id,
    turn_index: 0,
    role: 'user',
    content: '{"type":"text","text":"hello"}',
    git_ref: 'refs/heads/main',
    created_at: timestamp,
  };

  const baseCheckpoint: Checkpoint = {
    id: 'checkpoint-1',
    card_id: baseCard.id,
    name: 'initial',
    turn_index: 0,
    git_ref: 'refs/heads/main',
    created_by: 'api-key-1',
    created_at: timestamp,
  };

  return {
    initialize: async () => {},
    createCard: async (newCard) => ({
      ...baseCard,
      title: newCard.title,
      description: newCard.description ?? null,
      type: newCard.type ?? 'work',
      agent_bot: newCard.agent_bot ?? null,
      status: newCard.status ?? (newCard.agent_bot ? 'in_progress' : 'idea'),
      created_by: newCard.created_by,
      workspace_subdir: newCard.workspace_subdir ?? null,
      metadata: newCard.metadata ?? {},
    }),
    getCard: async () => baseCard,
    listCards: async () => [baseCard],
    updateCard: async () => baseCard,
    deleteCard: async () => {},
    createRun: async (newRun) => ({
      ...baseRun,
      card_id: newRun.card_id,
      session_id: newRun.session_id,
      agent_name: newRun.agent_name,
      input: newRun.input,
    }),
    getRun: async () => baseRun,
    updateRun: async () => baseRun,
    listRunsForCard: async () => [baseRun],
    addLabels: async () => {},
    removeLabel: async () => {},
    getLabels: async () => ['bug'],
    addComment: async (newComment) => ({
      ...baseComment,
      card_id: newComment.card_id,
      author_kind: newComment.author_kind,
      author_id: newComment.author_id,
      content: newComment.content,
    }),
    listComments: async () => [baseComment],
    appendTurn: async (newTurn) => ({
      ...baseTurn,
      card_id: newTurn.card_id,
      run_id: newTurn.run_id ?? null,
      turn_index: newTurn.turn_index,
      role: newTurn.role,
      content: newTurn.content,
      git_ref: newTurn.git_ref ?? null,
    }),
    listTurns: async () => [baseTurn],
    createCheckpoint: async (newCheckpoint) => ({
      ...baseCheckpoint,
      card_id: newCheckpoint.card_id,
      name: newCheckpoint.name ?? null,
      turn_index: newCheckpoint.turn_index,
      git_ref: newCheckpoint.git_ref ?? null,
      created_by: newCheckpoint.created_by,
    }),
    listCheckpoints: async () => [baseCheckpoint],
    deleteCheckpoint: async () => {},
  };
}

describe('http card store contract', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(cardStoreModule)).toEqual([]);
  });

  it('exports importable, structurally correct types', async () => {
    const newCard: NewCard = {
      title: 'Example card',
      created_by: 'api-key-1',
      agent_bot: null,
      metadata: { priority: 'high' },
    };
    const cardFilter: CardFilter = {
      agent_bot: null,
      status: 'idea',
      label: 'todo',
      type: 'work',
    };
    const newRun: NewRun = {
      card_id: 'card-1',
      session_id: 'session-1',
      agent_name: 'bob',
      input: [],
    };
    const newComment: NewCardComment = {
      card_id: 'card-1',
      author_kind: 'agent',
      author_id: 'bob',
      content: '{"type":"text","text":"hello"}',
    };
    const newTurn: NewSessionTurn = {
      card_id: 'card-1',
      run_id: 'run-1',
      turn_index: 1,
      role: 'assistant',
      content: '{"type":"text","text":"hi"}',
      git_ref: 'refs/heads/main',
    };
    const newCheckpoint: NewCheckpoint = {
      card_id: 'card-1',
      name: 'after-plan',
      turn_index: 1,
      git_ref: 'refs/heads/main',
      created_by: 'api-key-1',
    };

    const store = createMockCardStore();

    expect(Object.keys(store)).toHaveLength(20);
    await expect(store.createCard(newCard)).resolves.toMatchObject({ title: newCard.title, metadata: newCard.metadata });
    await expect(store.listCards(cardFilter)).resolves.toHaveLength(1);
    await expect(store.createRun(newRun)).resolves.toMatchObject({ card_id: newRun.card_id, agent_name: newRun.agent_name });
    await expect(store.addComment(newComment)).resolves.toMatchObject({ author_id: newComment.author_id, author_kind: newComment.author_kind });
    await expect(store.appendTurn(newTurn)).resolves.toMatchObject({ turn_index: newTurn.turn_index, role: newTurn.role });
    await expect(store.createCheckpoint(newCheckpoint)).resolves.toMatchObject({ name: newCheckpoint.name, turn_index: newCheckpoint.turn_index });
  });
});
