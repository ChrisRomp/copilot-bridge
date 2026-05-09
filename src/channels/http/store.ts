/**
 * Shared card persistence types and contract for the HTTP channel adapter.
 *
 * This module intentionally exports types only so route handlers can depend on
 * the persistence interface without coupling to a concrete database backend.
 */

// ---------------------------------------------------------------------------
// Card types
// ---------------------------------------------------------------------------

export interface NewCard {
  title: string;
  description?: string;
  type?: 'work' | 'chat';
  agent_bot?: string | null;
  status?: string;
  created_by: string;
  workspace_subdir?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Card {
  id: string;
  channel_id: string | null;
  type: 'work' | 'chat';
  agent_bot: string | null;
  title: string;
  description: string | null;
  status: string;
  created_by: string;
  workspace_subdir: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CardFilter {
  agent_bot?: string | null;
  status?: string;
  label?: string;
  type?: 'work' | 'chat';
}

// ---------------------------------------------------------------------------
// ACP run types
// ---------------------------------------------------------------------------

export interface NewRun {
  card_id: string;
  session_id: string;
  agent_name: string;
  input: unknown[];
}

export interface Run {
  id: string;
  card_id: string;
  session_id: string;
  agent_name: string;
  status: string;
  input: unknown[];
  output: unknown[];
  error: unknown | null;
  created_at: string;
  finished_at: string | null;
}

// ---------------------------------------------------------------------------
// Comment types
// ---------------------------------------------------------------------------

export interface NewCardComment {
  card_id: string;
  author_kind: 'human' | 'agent' | 'system';
  author_id: string;
  content: string;
}

export interface CardComment {
  id: string;
  card_id: string;
  author_kind: string;
  author_id: string;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Session turn types
// ---------------------------------------------------------------------------

export interface NewSessionTurn {
  card_id: string;
  run_id?: string;
  turn_index: number;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  git_ref?: string;
}

export interface SessionTurn {
  id: string;
  card_id: string;
  run_id: string | null;
  turn_index: number;
  role: string;
  content: string;
  git_ref: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

export interface NewCheckpoint {
  card_id: string;
  name?: string;
  turn_index: number;
  git_ref?: string;
  created_by: string;
}

export interface Checkpoint {
  id: string;
  card_id: string;
  name: string | null;
  turn_index: number;
  git_ref: string | null;
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// ICardStore interface
// ---------------------------------------------------------------------------

export interface ICardStore {
  initialize(): Promise<void>;

  // Cards
  createCard(card: NewCard): Promise<Card>;
  getCard(id: string): Promise<Card | null>;
  listCards(filter: CardFilter): Promise<Card[]>;
  updateCard(id: string, patch: Partial<Card>): Promise<Card>;
  deleteCard(id: string): Promise<void>;

  // Runs (ACP)
  createRun(run: NewRun): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Run>): Promise<Run>;
  listRunsForCard(cardId: string): Promise<Run[]>;

  // Labels
  addLabels(cardId: string, labels: string[]): Promise<void>;
  removeLabel(cardId: string, label: string): Promise<void>;
  getLabels(cardId: string): Promise<string[]>;

  // Comments
  addComment(comment: NewCardComment): Promise<CardComment>;
  listComments(cardId: string): Promise<CardComment[]>;

  // Session turns
  appendTurn(turn: NewSessionTurn): Promise<SessionTurn>;
  listTurns(cardId: string, upToIndex?: number): Promise<SessionTurn[]>;

  // Checkpoints
  createCheckpoint(checkpoint: NewCheckpoint): Promise<Checkpoint>;
  listCheckpoints(cardId: string): Promise<Checkpoint[]>;
  deleteCheckpoint(id: string): Promise<void>;
}
