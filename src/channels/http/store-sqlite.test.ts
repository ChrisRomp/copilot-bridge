import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCardStore } from './store-sqlite.js';

describe('SqliteCardStore', () => {
  let store: SqliteCardStore;
  let db: { close: () => void; prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } };

  beforeEach(async () => {
    store = new SqliteCardStore(':memory:');
    await store.initialize();
    db = (store as any).db;
  });

  afterEach(() => {
    db.close();
  });

  it('creates the full SQLite schema on initialize', () => {
    const rows = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all() as Array<{ type: string; name: string }>;

    expect(rows).toEqual(expect.arrayContaining([
      { type: 'table', name: 'cards' },
      { type: 'table', name: 'runs' },
      { type: 'table', name: 'card_labels' },
      { type: 'table', name: 'card_comments' },
      { type: 'table', name: 'session_turns' },
      { type: 'table', name: 'session_checkpoints' },
      { type: 'index', name: 'idx_cards_agent_status' },
      { type: 'index', name: 'idx_cards_status' },
      { type: 'index', name: 'idx_cards_type' },
      { type: 'index', name: 'idx_runs_card' },
      { type: 'index', name: 'idx_runs_status' },
      { type: 'index', name: 'idx_card_labels_label' },
      { type: 'index', name: 'idx_card_comments_card_created' },
      { type: 'index', name: 'idx_session_turns_card_turn' },
      { type: 'index', name: 'idx_checkpoints_card' },
    ]));
  });

  it('creates and updates cards with defaults, filters, and archival timestamps', async () => {
    const unassigned = await store.createCard({
      title: 'Unassigned work',
      created_by: 'api-key-1',
      status: 'idea',
      metadata: { priority: 'high' },
    });
    const assigned = await store.createCard({
      title: 'Assigned work',
      created_by: 'api-key-2',
      agent_bot: 'bob',
      type: 'chat',
    });
    const other = await store.createCard({
      title: 'Other work',
      created_by: 'api-key-3',
      status: 'blocked',
    });

    await store.addLabels(unassigned.id, ['bug', 'todo', 'bug']);
    await store.addLabels(assigned.id, ['todo']);

    expect(unassigned.status).toBe('idea');
    expect(assigned.status).toBe('in_progress');
    expect(await store.getCard('missing')).toBeNull();
    expect(await store.getLabels(unassigned.id)).toEqual(['bug', 'todo']);
    expect((await store.listCards({ agent_bot: null })).map((card) => card.id)).toEqual(expect.arrayContaining([unassigned.id, other.id]));
    expect((await store.listCards({ agent_bot: 'bob' })).map((card) => card.id)).toEqual([assigned.id]);
    expect((await store.listCards({ status: 'in_progress' })).map((card) => card.id)).toEqual(expect.arrayContaining([assigned.id]));
    expect((await store.listCards({ type: 'chat' })).map((card) => card.id)).toEqual([assigned.id]);
    expect((await store.listCards({ label: 'bug' })).map((card) => card.id)).toEqual([unassigned.id]);

    await store.removeLabel(unassigned.id, 'todo');
    expect(await store.getLabels(unassigned.id)).toEqual(['bug']);

    const archived = await store.updateCard(unassigned.id, {
      status: 'archived',
      description: 'Done',
      metadata: { priority: 'low', archived: true },
    });

    expect(archived.description).toBe('Done');
    expect(archived.metadata).toEqual({ priority: 'low', archived: true });
    expect(archived.archived_at).toMatch(/Z$/);
    expect(archived.updated_at).toMatch(/Z$/);
    expect((await store.listCards({ status: 'blocked' })).map((card) => card.id)).toEqual([other.id]);
    expect(other.status).toBe('blocked');
  });

  it('creates, updates, and lists runs with JSON payloads', async () => {
    const card = await store.createCard({ title: 'Run card', created_by: 'api-key-1' });
    const run = await store.createRun({
      card_id: card.id,
      session_id: 'session-1',
      agent_name: 'bob',
      input: [{ type: 'text', text: 'hello' }],
    });

    expect(run.status).toBe('created');
    expect(run.output).toEqual([]);
    expect(run.error).toBeNull();
    expect(await store.getRun('missing')).toBeNull();

    const updated = await store.updateRun(run.id, {
      status: 'completed',
      output: [{ type: 'text', text: 'done' }],
      error: { code: 'none' },
    });

    expect(updated.output).toEqual([{ type: 'text', text: 'done' }]);
    expect(updated.error).toEqual({ code: 'none' });
    expect(updated.finished_at).toMatch(/Z$/);
    expect(await store.listRunsForCard(card.id)).toHaveLength(1);
  });

  it('stores comments, turns, and checkpoints in order', async () => {
    const card = await store.createCard({ title: 'Conversation card', created_by: 'api-key-1' });
    const run = await store.createRun({
      card_id: card.id,
      session_id: 'session-2',
      agent_name: 'bob',
      input: [],
    });

    const comment = await store.addComment({
      card_id: card.id,
      author_kind: 'agent',
      author_id: 'bob',
      content: 'Started work',
    });
    const turn0 = await store.appendTurn({
      card_id: card.id,
      run_id: run.id,
      turn_index: 0,
      role: 'user',
      content: 'Plan it',
      git_ref: 'refs/heads/main',
    });
    const turn1 = await store.appendTurn({
      card_id: card.id,
      run_id: run.id,
      turn_index: 1,
      role: 'assistant',
      content: 'Done',
    });
    const checkpoint = await store.createCheckpoint({
      card_id: card.id,
      name: 'after-plan',
      turn_index: 1,
      git_ref: 'refs/heads/main',
      created_by: 'api-key-1',
    });

    expect((await store.listComments(card.id)).map((item) => item.id)).toEqual([comment.id]);
    expect((await store.listTurns(card.id)).map((item) => item.id)).toEqual([turn0.id, turn1.id]);
    expect((await store.listTurns(card.id, 0)).map((item) => item.id)).toEqual([turn0.id]);
    expect((await store.listCheckpoints(card.id)).map((item) => item.id)).toEqual([checkpoint.id]);

    await store.deleteCheckpoint(checkpoint.id);
    expect(await store.listCheckpoints(card.id)).toEqual([]);
  });

  it('deletes a card and all dependent rows', async () => {
    const card = await store.createCard({ title: 'Cascade card', created_by: 'api-key-1' });
    const run = await store.createRun({
      card_id: card.id,
      session_id: 'session-3',
      agent_name: 'bob',
      input: [],
    });

    await store.addLabels(card.id, ['cleanup']);
    await store.addComment({
      card_id: card.id,
      author_kind: 'human',
      author_id: 'user-1',
      content: 'please clean up',
    });
    await store.appendTurn({
      card_id: card.id,
      run_id: run.id,
      turn_index: 0,
      role: 'user',
      content: 'hello',
    });
    await store.createCheckpoint({
      card_id: card.id,
      turn_index: 0,
      created_by: 'api-key-1',
    });

    await store.deleteCard(card.id);

    expect(await store.getCard(card.id)).toBeNull();
    expect(await store.getLabels(card.id)).toEqual([]);
    expect(await store.listRunsForCard(card.id)).toEqual([]);
    expect(await store.listComments(card.id)).toEqual([]);
    expect(await store.listTurns(card.id)).toEqual([]);
    expect(await store.listCheckpoints(card.id)).toEqual([]);

    expect(db.prepare('SELECT COUNT(*) AS count FROM cards').get() as { count: number }).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM card_labels').get() as { count: number }).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM card_comments').get() as { count: number }).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_turns').get() as { count: number }).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_checkpoints').get() as { count: number }).toEqual({ count: 0 });
  });
});
