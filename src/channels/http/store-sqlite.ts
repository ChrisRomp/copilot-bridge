import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

const DEFAULT_DB_PATH = './data/bridge.db';
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type CardRow = {
  id: string;
  channel_id: string | null;
  type: 'work' | 'chat';
  agent_bot: string | null;
  title: string;
  description: string | null;
  status: string;
  created_by: string;
  workspace_subdir: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type RunRow = {
  id: string;
  card_id: string;
  session_id: string;
  agent_name: string;
  status: string;
  input: string;
  output: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

type CardCommentRow = {
  id: string;
  card_id: string;
  author_kind: string;
  author_id: string;
  content: string;
  created_at: string;
};

type SessionTurnRow = {
  id: string;
  card_id: string;
  run_id: string | null;
  turn_index: number;
  role: string;
  content: string;
  git_ref: string | null;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  card_id: string;
  name: string | null;
  turn_index: number;
  git_ref: string | null;
  created_by: string;
  created_at: string;
};

function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function mapCardRow(row: CardRow): Card {
  return {
    id: row.id,
    channel_id: row.channel_id,
    type: row.type,
    agent_bot: row.agent_bot,
    title: row.title,
    description: row.description,
    status: row.status,
    created_by: row.created_by,
    workspace_subdir: row.workspace_subdir,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function mapRunRow(row: RunRow): Run {
  return {
    id: row.id,
    card_id: row.card_id,
    session_id: row.session_id,
    agent_name: row.agent_name,
    status: row.status,
    input: parseJson<unknown[]>(row.input),
    output: parseJson<unknown[]>(row.output),
    error: row.error === null ? null : parseJson<unknown>(row.error),
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

function mapCommentRow(row: CardCommentRow): CardComment {
  return {
    id: row.id,
    card_id: row.card_id,
    author_kind: row.author_kind,
    author_id: row.author_id,
    content: row.content,
    created_at: row.created_at,
  };
}

function mapTurnRow(row: SessionTurnRow): SessionTurn {
  return {
    id: row.id,
    card_id: row.card_id,
    run_id: row.run_id,
    turn_index: row.turn_index,
    role: row.role,
    content: row.content,
    git_ref: row.git_ref,
    created_at: row.created_at,
  };
}

function mapCheckpointRow(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    card_id: row.card_id,
    name: row.name,
    turn_index: row.turn_index,
    git_ref: row.git_ref,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export class SqliteCardStore implements ICardStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? process.env.BRIDGE_DB_PATH ?? DEFAULT_DB_PATH;
    ensureDbDirectory(resolvedPath);
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        channel_id TEXT,
        type TEXT NOT NULL DEFAULT 'work',
        agent_bot TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'idea',
        created_by TEXT NOT NULL,
        workspace_subdir TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cards_agent_status ON cards(agent_bot, status);
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        input TEXT NOT NULL DEFAULT '[]',
        output TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (card_id) REFERENCES cards(id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_card ON runs(card_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS card_labels (
        card_id TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (card_id, label),
        FOREIGN KEY (card_id) REFERENCES cards(id)
      );

      CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels(label);

      CREATE TABLE IF NOT EXISTS card_comments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (card_id) REFERENCES cards(id)
      );

      CREATE INDEX IF NOT EXISTS idx_card_comments_card_created ON card_comments(card_id, created_at);

      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        run_id TEXT,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        git_ref TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (card_id) REFERENCES cards(id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_turns_card_turn ON session_turns(card_id, turn_index);

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        name TEXT,
        turn_index INTEGER NOT NULL,
        git_ref TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (card_id) REFERENCES cards(id)
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_card ON session_checkpoints(card_id);
    `);
  }

  async createCard(input: NewCard): Promise<Card> {
    const id = randomUUID();
    const timestamp = nowIso();
    const card: Card = {
      id,
      channel_id: null,
      type: input.type ?? 'work',
      agent_bot: input.agent_bot ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.agent_bot ? 'in_progress' : (input.status ?? 'idea'),
      created_by: input.created_by,
      workspace_subdir: input.workspace_subdir ?? null,
      metadata: input.metadata ?? {},
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    };

    this.db.prepare(`
      INSERT INTO cards (
        id, channel_id, type, agent_bot, title, description, status, created_by,
        workspace_subdir, metadata, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.id,
      card.channel_id,
      card.type,
      card.agent_bot,
      card.title,
      card.description,
      card.status,
      card.created_by,
      card.workspace_subdir,
      JSON.stringify(card.metadata),
      card.created_at,
      card.updated_at,
      card.archived_at,
    );

    return card;
  }

  async getCard(id: string): Promise<Card | null> {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    return row ? mapCardRow(row) : null;
  }

  async listCards(filter: CardFilter): Promise<Card[]> {
    const joins: string[] = [];
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.label !== undefined) {
      joins.push('INNER JOIN card_labels ON card_labels.card_id = cards.id');
      where.push('card_labels.label = ?');
      params.push(filter.label);
    }

    if (Object.prototype.hasOwnProperty.call(filter, 'agent_bot')) {
      if (filter.agent_bot === null) {
        where.push('cards.agent_bot IS NULL');
      } else if (filter.agent_bot !== undefined) {
        where.push('cards.agent_bot = ?');
        params.push(filter.agent_bot);
      }
    }

    if (filter.status !== undefined) {
      where.push('cards.status = ?');
      params.push(filter.status);
    }

    if (filter.type !== undefined) {
      where.push('cards.type = ?');
      params.push(filter.type);
    }

    const sql = [
      'SELECT DISTINCT cards.* FROM cards',
      joins.join(' '),
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY cards.created_at DESC',
    ].filter(Boolean).join(' ');

    const rows = this.db.prepare(sql).all(...params) as CardRow[];
    return rows.map(mapCardRow);
  }

  async updateCard(id: string, patch: Partial<Card>): Promise<Card> {
    const updates: string[] = [];
    const values: unknown[] = [];
    const timestamp = nowIso();

    if (patch.channel_id !== undefined) { updates.push('channel_id = ?'); values.push(patch.channel_id); }
    if (patch.type !== undefined) { updates.push('type = ?'); values.push(patch.type); }
    if (patch.agent_bot !== undefined) { updates.push('agent_bot = ?'); values.push(patch.agent_bot); }
    if (patch.title !== undefined) { updates.push('title = ?'); values.push(patch.title); }
    if (patch.description !== undefined) { updates.push('description = ?'); values.push(patch.description); }
    if (patch.status !== undefined) { updates.push('status = ?'); values.push(patch.status); }
    if (patch.created_by !== undefined) { updates.push('created_by = ?'); values.push(patch.created_by); }
    if (patch.workspace_subdir !== undefined) { updates.push('workspace_subdir = ?'); values.push(patch.workspace_subdir); }
    if (patch.metadata !== undefined) { updates.push('metadata = ?'); values.push(JSON.stringify(patch.metadata)); }
    if (patch.archived_at !== undefined) { updates.push('archived_at = ?'); values.push(patch.archived_at); }
    if (patch.status === 'archived' && patch.archived_at === undefined) { updates.push('archived_at = ?'); values.push(timestamp); }

    updates.push('updated_at = ?');
    values.push(timestamp, id);

    this.db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const card = await this.getCard(id);
    if (!card) throw new Error(`Card not found: ${id}`);
    return card;
  }

  async deleteCard(id: string): Promise<void> {
    const txn = this.db.transaction((cardId: string) => {
      this.db.prepare('DELETE FROM session_checkpoints WHERE card_id = ?').run(cardId);
      this.db.prepare('DELETE FROM session_turns WHERE card_id = ?').run(cardId);
      this.db.prepare('DELETE FROM card_comments WHERE card_id = ?').run(cardId);
      this.db.prepare('DELETE FROM card_labels WHERE card_id = ?').run(cardId);
      this.db.prepare('DELETE FROM runs WHERE card_id = ?').run(cardId);
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
    });
    txn(id);
  }

  async createRun(input: NewRun): Promise<Run> {
    const run: Run = {
      id: randomUUID(),
      card_id: input.card_id,
      session_id: input.session_id,
      agent_name: input.agent_name,
      status: 'created',
      input: input.input,
      output: [],
      error: null,
      created_at: nowIso(),
      finished_at: null,
    };

    this.db.prepare(`
      INSERT INTO runs (
        id, card_id, session_id, agent_name, status, input, output, error, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.card_id,
      run.session_id,
      run.agent_name,
      run.status,
      JSON.stringify(run.input),
      JSON.stringify(run.output),
      run.error === null ? null : JSON.stringify(run.error),
      run.created_at,
      run.finished_at,
    );

    return run;
  }

  async getRun(id: string): Promise<Run | null> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  async updateRun(id: string, patch: Partial<Run>): Promise<Run> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined) { updates.push('status = ?'); values.push(patch.status); }
    if (patch.output !== undefined) { updates.push('output = ?'); values.push(JSON.stringify(patch.output)); }
    if (patch.error !== undefined) {
      updates.push('error = ?');
      values.push(patch.error === null ? null : JSON.stringify(patch.error));
    }
    if (patch.finished_at !== undefined) { updates.push('finished_at = ?'); values.push(patch.finished_at); }
    if (patch.status !== undefined && TERMINAL_RUN_STATUSES.has(patch.status) && patch.finished_at === undefined) {
      updates.push('finished_at = ?');
      values.push(nowIso());
    }

    if (updates.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE runs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const run = await this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  async listRunsForCard(cardId: string): Promise<Run[]> {
    const rows = this.db.prepare('SELECT * FROM runs WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as RunRow[];
    return rows.map(mapRunRow);
  }

  async addLabels(cardId: string, labels: string[]): Promise<void> {
    const insert = this.db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label) VALUES (?, ?)');
    const txn = this.db.transaction((currentCardId: string, currentLabels: string[]) => {
      for (const label of currentLabels) {
        insert.run(currentCardId, label);
      }
    });
    txn(cardId, labels);
  }

  async removeLabel(cardId: string, label: string): Promise<void> {
    this.db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label = ?').run(cardId, label);
  }

  async getLabels(cardId: string): Promise<string[]> {
    const rows = this.db.prepare('SELECT label FROM card_labels WHERE card_id = ? ORDER BY label ASC').all(cardId) as Array<{ label: string }>;
    return rows.map((row) => row.label);
  }

  async addComment(input: NewCardComment): Promise<CardComment> {
    const comment: CardComment = {
      id: randomUUID(),
      card_id: input.card_id,
      author_kind: input.author_kind,
      author_id: input.author_id,
      content: input.content,
      created_at: nowIso(),
    };

    this.db.prepare(`
      INSERT INTO card_comments (id, card_id, author_kind, author_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      comment.id,
      comment.card_id,
      comment.author_kind,
      comment.author_id,
      comment.content,
      comment.created_at,
    );

    return comment;
  }

  async listComments(cardId: string): Promise<CardComment[]> {
    const rows = this.db.prepare('SELECT * FROM card_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as CardCommentRow[];
    return rows.map(mapCommentRow);
  }

  async appendTurn(input: NewSessionTurn): Promise<SessionTurn> {
    const turn: SessionTurn = {
      id: randomUUID(),
      card_id: input.card_id,
      run_id: input.run_id ?? null,
      turn_index: input.turn_index,
      role: input.role,
      content: input.content,
      git_ref: input.git_ref ?? null,
      created_at: nowIso(),
    };

    this.db.prepare(`
      INSERT INTO session_turns (id, card_id, run_id, turn_index, role, content, git_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.id,
      turn.card_id,
      turn.run_id,
      turn.turn_index,
      turn.role,
      turn.content,
      turn.git_ref,
      turn.created_at,
    );

    return turn;
  }

  async listTurns(cardId: string, upToIndex?: number): Promise<SessionTurn[]> {
    const rows = upToIndex === undefined
      ? this.db.prepare('SELECT * FROM session_turns WHERE card_id = ? ORDER BY turn_index ASC').all(cardId) as SessionTurnRow[]
      : this.db.prepare('SELECT * FROM session_turns WHERE card_id = ? AND turn_index <= ? ORDER BY turn_index ASC').all(cardId, upToIndex) as SessionTurnRow[];
    return rows.map(mapTurnRow);
  }

  async createCheckpoint(input: NewCheckpoint): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      card_id: input.card_id,
      name: input.name ?? null,
      turn_index: input.turn_index,
      git_ref: input.git_ref ?? null,
      created_by: input.created_by,
      created_at: nowIso(),
    };

    this.db.prepare(`
      INSERT INTO session_checkpoints (id, card_id, name, turn_index, git_ref, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.card_id,
      checkpoint.name,
      checkpoint.turn_index,
      checkpoint.git_ref,
      checkpoint.created_by,
      checkpoint.created_at,
    );

    return checkpoint;
  }

  async listCheckpoints(cardId: string): Promise<Checkpoint[]> {
    const rows = this.db.prepare('SELECT * FROM session_checkpoints WHERE card_id = ? ORDER BY turn_index ASC').all(cardId) as CheckpointRow[];
    return rows.map(mapCheckpointRow);
  }

  async deleteCheckpoint(id: string): Promise<void> {
    this.db.prepare('DELETE FROM session_checkpoints WHERE id = ?').run(id);
  }
}
