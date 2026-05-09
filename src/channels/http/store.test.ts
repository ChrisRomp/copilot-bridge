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

describe('http card store contract', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(cardStoreModule)).toEqual([]);
  });

  it('types compile and are structurally valid', () => {
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

    const card: Card = {
      id: 'card-1',
      channel_id: null,
      type: 'work',
      agent_bot: null,
      title: newCard.title,
      description: null,
      status: 'idea',
      created_by: newCard.created_by,
      workspace_subdir: null,
      metadata: newCard.metadata ?? {},
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    };
    const run: Run = {
      id: 'run-1',
      card_id: newRun.card_id,
      session_id: newRun.session_id,
      agent_name: newRun.agent_name,
      status: 'completed',
      input: newRun.input,
      output: [],
      error: null,
      created_at: timestamp,
      finished_at: timestamp,
    };
    const comment: CardComment = {
      id: 'comment-1',
      card_id: newComment.card_id,
      author_kind: newComment.author_kind,
      author_id: newComment.author_id,
      content: newComment.content,
      created_at: timestamp,
    };
    const turn: SessionTurn = {
      id: 'turn-1',
      card_id: newTurn.card_id,
      run_id: newTurn.run_id ?? null,
      turn_index: newTurn.turn_index,
      role: newTurn.role,
      content: newTurn.content,
      git_ref: newTurn.git_ref ?? null,
      created_at: timestamp,
    };
    const checkpoint: Checkpoint = {
      id: 'checkpoint-1',
      card_id: newCheckpoint.card_id,
      name: newCheckpoint.name ?? null,
      turn_index: newCheckpoint.turn_index,
      git_ref: newCheckpoint.git_ref ?? null,
      created_by: newCheckpoint.created_by,
      created_at: timestamp,
    };
    const store: ICardStore = {
      initialize: async () => {},
      createCard: async () => card,
      getCard: async () => card,
      listCards: async () => [card],
      updateCard: async () => card,
      deleteCard: async () => {},
      createRun: async () => run,
      getRun: async () => run,
      updateRun: async () => run,
      listRunsForCard: async () => [run],
      addLabels: async () => {},
      removeLabel: async () => {},
      getLabels: async () => ['bug'],
      addComment: async () => comment,
      listComments: async () => [comment],
      appendTurn: async () => turn,
      listTurns: async () => [turn],
      createCheckpoint: async () => checkpoint,
      listCheckpoints: async () => [checkpoint],
      deleteCheckpoint: async () => {},
    };

    // This module intentionally exports types only. These values are compile-time
    // sentinels that fail if the store contracts drift, so no runtime assertions
    // are needed here.
    void cardFilter;
    void store;
  });
});
