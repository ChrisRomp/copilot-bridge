import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DB_PATH = path.join(os.homedir(), '.copilot-bridge', 'state.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS channel_sessions (
      channel_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_prefs (
      channel_id TEXT PRIMARY KEY,
      model TEXT,
      agent TEXT,
      verbose INTEGER,
      trigger_mode TEXT,
      threaded_replies INTEGER,
      permission_mode TEXT,
      reasoning_effort TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global',
      tool TEXT NOT NULL,
      command_pattern TEXT NOT NULL DEFAULT '*',
      action TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_perm_scope ON permission_rules(scope);
    CREATE INDEX IF NOT EXISTS idx_perm_tool ON permission_rules(tool);

    CREATE TABLE IF NOT EXISTS workspace_overrides (
      bot_name TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      allow_paths TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Schema migrations for existing DBs
  try {
    _db.exec(`ALTER TABLE channel_prefs ADD COLUMN reasoning_effort TEXT`);
  } catch {
    // Column already exists
  }

  return _db;
}

// --- Channel Sessions ---

export function getChannelSession(channelId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT session_id FROM channel_sessions WHERE channel_id = ?').get(channelId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setChannelSession(channelId: string, sessionId: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO channel_sessions (channel_id, session_id, created_at) VALUES (?, ?, datetime(\'now\'))'
  ).run(channelId, sessionId);
}

export function clearChannelSession(channelId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM channel_sessions WHERE channel_id = ?').run(channelId);
}

export function getAllChannelSessions(): Array<{ channelId: string; sessionId: string }> {
  const db = getDb();
  const rows = db.prepare('SELECT channel_id, session_id FROM channel_sessions').all() as any[];
  return rows.map(r => ({ channelId: r.channel_id, sessionId: r.session_id }));
}

// --- Channel Preferences ---

export interface ChannelPrefs {
  model?: string;
  agent?: string | null;
  verbose?: boolean;

  threadedReplies?: boolean;
  permissionMode?: string;
  reasoningEffort?: string | null;
}

export function getChannelPrefs(channelId: string): ChannelPrefs | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM channel_prefs WHERE channel_id = ?').get(channelId) as any;
  if (!row) return null;
  return {
    model: row.model ?? undefined,
    agent: row.agent,
    verbose: row.verbose != null ? !!row.verbose : undefined,

    threadedReplies: row.threaded_replies != null ? !!row.threaded_replies : undefined,
    permissionMode: row.permission_mode ?? undefined,
    reasoningEffort: row.reasoning_effort ?? null,
  };
}

export function setChannelPrefs(channelId: string, prefs: Partial<ChannelPrefs>): void {
  const db = getDb();
  const existing = getChannelPrefs(channelId);

  if (existing) {
    const updates: string[] = [];
    const values: any[] = [];

    if (prefs.model !== undefined) { updates.push('model = ?'); values.push(prefs.model); }
    if (prefs.agent !== undefined) { updates.push('agent = ?'); values.push(prefs.agent); }
    if (prefs.verbose !== undefined) { updates.push('verbose = ?'); values.push(prefs.verbose ? 1 : 0); }

    if (prefs.threadedReplies !== undefined) { updates.push('threaded_replies = ?'); values.push(prefs.threadedReplies ? 1 : 0); }
    if (prefs.permissionMode !== undefined) { updates.push('permission_mode = ?'); values.push(prefs.permissionMode); }
    if (prefs.reasoningEffort !== undefined) { updates.push('reasoning_effort = ?'); values.push(prefs.reasoningEffort); }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(channelId);
      db.prepare(`UPDATE channel_prefs SET ${updates.join(', ')} WHERE channel_id = ?`).run(...values);
    }
  } else {
    db.prepare(
      `INSERT INTO channel_prefs (channel_id, model, agent, verbose, threaded_replies, permission_mode, reasoning_effort)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      channelId,
      prefs.model ?? null,
      prefs.agent ?? null,
      prefs.verbose != null ? (prefs.verbose ? 1 : 0) : null,
      prefs.threadedReplies != null ? (prefs.threadedReplies ? 1 : 0) : null,
      prefs.permissionMode ?? null,
      prefs.reasoningEffort ?? null,
    );
  }
}

// --- Permission Rules ---

export interface StoredPermissionRule {
  id: number;
  scope: string;
  tool: string;
  commandPattern: string;
  action: 'allow' | 'deny';
  createdAt: string;
}

export function getPermissionRules(scope: string, tool: string): StoredPermissionRule[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM permission_rules WHERE (scope = ? OR scope = \'global\') AND tool = ? ORDER BY scope DESC, id DESC'
  ).all(scope, tool) as any[];
  return rows.map(r => ({
    id: r.id,
    scope: r.scope,
    tool: r.tool,
    commandPattern: r.command_pattern,
    action: r.action,
    createdAt: r.created_at,
  }));
}

export function addPermissionRule(scope: string, tool: string, commandPattern: string, action: 'allow' | 'deny'): void {
  const db = getDb();
  // Remove existing rule for same scope+tool+pattern before inserting
  db.prepare(
    'DELETE FROM permission_rules WHERE scope = ? AND tool = ? AND command_pattern = ?'
  ).run(scope, tool, commandPattern);

  db.prepare(
    'INSERT INTO permission_rules (scope, tool, command_pattern, action) VALUES (?, ?, ?, ?)'
  ).run(scope, tool, commandPattern, action);
}

export function clearPermissionRules(scope: string): void {
  const db = getDb();
  db.prepare('DELETE FROM permission_rules WHERE scope = ?').run(scope);
}

/**
 * Check if a tool+command is allowed by existing rules.
 * Returns 'allow', 'deny', or null (no matching rule — need to ask).
 */
export function checkPermission(scope: string, tool: string, command: string): 'allow' | 'deny' | null {
  const rules = getPermissionRules(scope, tool);

  for (const rule of rules) {
    // Exact match or wildcard
    if (rule.commandPattern === '*' || rule.commandPattern === command) {
      return rule.action;
    }
  }

  return null;
}

// --- Workspace Overrides ---

export interface WorkspaceOverride {
  botName: string;
  workingDirectory: string;
  allowPaths: string[];
  createdAt: string;
}

function safeParseAllowPaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getWorkspaceOverride(botName: string): WorkspaceOverride | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workspace_overrides WHERE bot_name = ?').get(botName) as any;
  if (!row) return null;
  return {
    botName: row.bot_name,
    workingDirectory: row.working_directory,
    allowPaths: safeParseAllowPaths(row.allow_paths),
    createdAt: row.created_at,
  };
}

export function setWorkspaceOverride(botName: string, workingDirectory: string, allowPaths?: string[]): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspace_overrides (bot_name, working_directory, allow_paths, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(bot_name) DO UPDATE SET
       working_directory = excluded.working_directory,
       allow_paths = excluded.allow_paths`
  ).run(botName, workingDirectory, JSON.stringify(allowPaths ?? []));
}

export function removeWorkspaceOverride(botName: string): void {
  const db = getDb();
  db.prepare('DELETE FROM workspace_overrides WHERE bot_name = ?').run(botName);
}

export function listWorkspaceOverrides(): WorkspaceOverride[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workspace_overrides').all() as any[];
  return rows.map(row => ({
    botName: row.bot_name,
    workingDirectory: row.working_directory,
    allowPaths: safeParseAllowPaths(row.allow_paths),
    createdAt: row.created_at,
  }));
}

// --- Cleanup ---

export function closeDb(): void {
  _db?.close();
  _db = null;
}
