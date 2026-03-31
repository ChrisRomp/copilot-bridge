import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../logger.js';

const log = createLogger('store');
const DB_PATH = path.join(os.homedir(), '.copilot-bridge', 'state.db');
const SLOW_QUERY_MS = 50;

/** Classify SQLite error codes into severity buckets for logging. */
function classifyDbError(err: unknown): 'busy' | 'corrupt' | 'full' | 'readonly' | 'other' {
  const code = (err as any)?.code as string | undefined;
  if (!code) return 'other';
  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')) return 'busy';
  if (code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_')) return 'corrupt';
  if (code === 'SQLITE_FULL') return 'full';
  if (code === 'SQLITE_READONLY' || code.startsWith('SQLITE_READONLY_')) return 'readonly';
  return 'other';
}

function safeParseStringArray(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((v: unknown) => typeof v === 'string');
  } catch { return undefined; }
}

let _db: Database.Database | null = null;

/** Migrate channel_prefs: drop NOT NULL on columns that should be nullable. */
function migrateChannelPrefsNullable(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('channel_prefs')").all() as any[];
  const nullableTargets = new Set(['verbose', 'trigger_mode', 'threaded_replies', 'permission_mode']);
  const needsMigration = cols.some(
    (c: any) => nullableTargets.has(c.name) && c.notnull === 1
  );
  if (!needsMigration) return;

  // Build dynamic column definitions preserving all existing columns
  const columnDefs: string[] = [];
  const selectExprs: string[] = [];

  for (const c of cols) {
    const name = c.name as string;
    const parts: string[] = [`"${name}"`];
    if (c.type) parts.push(c.type);
    if (c.pk === 1) parts.push('PRIMARY KEY');
    // Drop NOT NULL only for targeted columns; preserve for others
    if (c.notnull === 1 && !nullableTargets.has(name)) parts.push('NOT NULL');
    if (c.dflt_value !== null && c.dflt_value !== undefined) parts.push(`DEFAULT ${c.dflt_value}`);
    columnDefs.push(parts.join(' '));

    // Ensure updated_at is non-NULL during copy
    if (name === 'updated_at') {
      selectExprs.push("COALESCE(updated_at, datetime('now'))");
    } else {
      selectExprs.push(`"${name}"`);
    }
  }

  // Capture existing indexes/triggers to recreate after rebuild
  const schemaObjects = db.prepare(
    "SELECT sql FROM sqlite_master WHERE tbl_name = 'channel_prefs' AND type IN ('index','trigger') AND sql IS NOT NULL"
  ).all() as any[];

  const migrate = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS channel_prefs_new`);
    db.exec(`CREATE TABLE channel_prefs_new (${columnDefs.join(', ')})`);
    db.exec(`
      INSERT INTO channel_prefs_new SELECT ${selectExprs.join(', ')} FROM channel_prefs;
      DROP TABLE channel_prefs;
      ALTER TABLE channel_prefs_new RENAME TO channel_prefs;
    `);
    for (const obj of schemaObjects) {
      if (obj.sql) db.exec(obj.sql);
    }
  });
  migrate();
}

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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dynamic_channels (
      channel_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      bot TEXT,
      working_directory TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      trigger_mode TEXT,
      threaded_replies INTEGER,
      verbose INTEGER,
      is_dm INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_bot TEXT NOT NULL,
      target_bot TEXT NOT NULL,
      target_agent TEXT,
      message_summary TEXT,
      response_summary TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      chain_id TEXT,
      depth INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_calls_created ON agent_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_calls_chain ON agent_calls(chain_id);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      bot_name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expr TEXT,
      run_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_by TEXT,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sched_channel ON scheduled_tasks(channel_id);
    CREATE INDEX IF NOT EXISTS idx_sched_enabled ON scheduled_tasks(enabled);

    CREATE TABLE IF NOT EXISTS scheduled_task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      description TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'success',
      fired_at TEXT NOT NULL DEFAULT (datetime('now')),
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sched_hist_task ON scheduled_task_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_sched_hist_channel ON scheduled_task_history(channel_id);
  `);

  // Migration: ensure channel_prefs columns are nullable (fixes NOT NULL constraints from older schema)
  migrateChannelPrefsNullable(_db);

  // Schema migrations for existing DBs
  try {
    _db.exec(`ALTER TABLE channel_prefs ADD COLUMN reasoning_effort TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.exec(`ALTER TABLE scheduled_task_history ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
  } catch {
    // Column already exists
  }
  try {
    _db.exec(`ALTER TABLE channel_prefs ADD COLUMN session_mode TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.exec(`ALTER TABLE channel_prefs ADD COLUMN disabled_skills TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.exec(`ALTER TABLE channel_prefs ADD COLUMN provider TEXT`);
  } catch {
    // Column already exists
  }

  return _db;
}

// --- Channel Sessions ---

export async function getChannelSession(channelId: string): Promise<string | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT session_id FROM channel_sessions WHERE channel_id = ?').get(channelId) as { session_id: string } | undefined;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getChannelSession took ${elapsed.toFixed(0)}ms`);
    return row?.session_id ?? null;
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getChannelSession CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getChannelSession CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getChannelSession - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getChannelSession - database is read-only:', err);
    else log.error('getChannelSession failed:', err);
    throw err;
  }
}

export async function setChannelSession(channelId: string, sessionId: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO channel_sessions (channel_id, session_id, created_at) VALUES (?, ?, datetime(\'now\'))'
    ).run(channelId, sessionId);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`setChannelSession took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('setChannelSession CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('setChannelSession CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('setChannelSession - database busy (contention):', err);
    else if (kind === 'readonly') log.error('setChannelSession - database is read-only:', err);
    else log.error('setChannelSession failed:', err);
    throw err;
  }
}

export async function clearChannelSession(channelId: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('DELETE FROM channel_sessions WHERE channel_id = ?').run(channelId);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`clearChannelSession took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('clearChannelSession CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('clearChannelSession CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('clearChannelSession - database busy (contention):', err);
    else if (kind === 'readonly') log.error('clearChannelSession - database is read-only:', err);
    else log.error('clearChannelSession failed:', err);
    throw err;
  }
}

export async function getAllChannelSessions(): Promise<Array<{ channelId: string; sessionId: string }>> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare('SELECT channel_id, session_id FROM channel_sessions').all() as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getAllChannelSessions took ${elapsed.toFixed(0)}ms`);
    return rows.map(r => ({ channelId: r.channel_id, sessionId: r.session_id }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getAllChannelSessions CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getAllChannelSessions CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getAllChannelSessions - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getAllChannelSessions - database is read-only:', err);
    else log.error('getAllChannelSessions failed:', err);
    throw err;
  }
}

// --- Channel Preferences ---

export interface ChannelPrefs {
  model?: string;
  provider?: string | null;
  agent?: string | null;
  verbose?: boolean;

  threadedReplies?: boolean;
  permissionMode?: string;
  reasoningEffort?: string | null;
  sessionMode?: string;
  disabledSkills?: string[];
}

export async function getChannelPrefs(channelId: string): Promise<ChannelPrefs | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT * FROM channel_prefs WHERE channel_id = ?').get(channelId) as any;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getChannelPrefs took ${elapsed.toFixed(0)}ms`);
    if (!row) return null;
    return {
      model: row.model ?? undefined,
      provider: row.provider ?? null,
      agent: row.agent,
      verbose: row.verbose != null ? !!row.verbose : undefined,

      threadedReplies: row.threaded_replies != null ? !!row.threaded_replies : undefined,
      permissionMode: row.permission_mode ?? undefined,
      reasoningEffort: row.reasoning_effort ?? null,
      sessionMode: row.session_mode ?? undefined,
      disabledSkills: row.disabled_skills ? safeParseStringArray(row.disabled_skills) : undefined,
    };
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getChannelPrefs CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getChannelPrefs CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getChannelPrefs - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getChannelPrefs - database is read-only:', err);
    else log.error('getChannelPrefs failed:', err);
    throw err;
  }
}

export async function setChannelPrefs(channelId: string, prefs: Partial<ChannelPrefs>): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();

    const txn = db.transaction(() => {
      // Ensure a row exists (upsert-safe — avoids TOCTOU race with async callers)
      db.prepare(
        `INSERT OR IGNORE INTO channel_prefs (channel_id) VALUES (?)`
      ).run(channelId);

      const updates: string[] = [];
      const values: any[] = [];

      if (prefs.model !== undefined) { updates.push('model = ?'); values.push(prefs.model); }
      if (prefs.provider !== undefined) { updates.push('provider = ?'); values.push(prefs.provider); }
      if (prefs.agent !== undefined) { updates.push('agent = ?'); values.push(prefs.agent); }
      if (prefs.verbose !== undefined) { updates.push('verbose = ?'); values.push(prefs.verbose ? 1 : 0); }

      if (prefs.threadedReplies !== undefined) { updates.push('threaded_replies = ?'); values.push(prefs.threadedReplies ? 1 : 0); }
      if (prefs.permissionMode !== undefined) { updates.push('permission_mode = ?'); values.push(prefs.permissionMode); }
      if (prefs.reasoningEffort !== undefined) { updates.push('reasoning_effort = ?'); values.push(prefs.reasoningEffort); }
      if (prefs.sessionMode !== undefined) { updates.push('session_mode = ?'); values.push(prefs.sessionMode); }
      if (prefs.disabledSkills !== undefined) { updates.push('disabled_skills = ?'); values.push(JSON.stringify(prefs.disabledSkills)); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(channelId);
        db.prepare(`UPDATE channel_prefs SET ${updates.join(', ')} WHERE channel_id = ?`).run(...values);
      }
    });
    txn();

    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`setChannelPrefs took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('setChannelPrefs CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('setChannelPrefs CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('setChannelPrefs - database busy (contention):', err);
    else if (kind === 'readonly') log.error('setChannelPrefs - database is read-only:', err);
    else log.error('setChannelPrefs failed:', err);
    throw err;
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

export async function getPermissionRules(scope: string, tool: string): Promise<StoredPermissionRule[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM permission_rules WHERE (scope = ? OR scope = \'global\') AND tool = ? ORDER BY scope DESC, id DESC'
    ).all(scope, tool) as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getPermissionRules took ${elapsed.toFixed(0)}ms`);
    return rows.map(r => ({
      id: r.id,
      scope: r.scope,
      tool: r.tool,
      commandPattern: r.command_pattern,
      action: r.action,
      createdAt: r.created_at,
    }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getPermissionRules CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getPermissionRules CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getPermissionRules - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getPermissionRules - database is read-only:', err);
    else log.error('getPermissionRules failed:', err);
    throw err;
  }
}

export async function addPermissionRule(scope: string, tool: string, commandPattern: string, action: 'allow' | 'deny'): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();

    const txn = db.transaction(() => {
      // Remove existing rule for same scope+tool+pattern before inserting
      db.prepare(
        'DELETE FROM permission_rules WHERE scope = ? AND tool = ? AND command_pattern = ?'
      ).run(scope, tool, commandPattern);

      db.prepare(
        'INSERT INTO permission_rules (scope, tool, command_pattern, action) VALUES (?, ?, ?, ?)'
      ).run(scope, tool, commandPattern, action);
    });
    txn();

    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`addPermissionRule took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('addPermissionRule CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('addPermissionRule CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('addPermissionRule - database busy (contention):', err);
    else if (kind === 'readonly') log.error('addPermissionRule - database is read-only:', err);
    else log.error('addPermissionRule failed:', err);
    throw err;
  }
}

export async function clearPermissionRules(scope: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('DELETE FROM permission_rules WHERE scope = ?').run(scope);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`clearPermissionRules took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('clearPermissionRules CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('clearPermissionRules CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('clearPermissionRules - database busy (contention):', err);
    else if (kind === 'readonly') log.error('clearPermissionRules - database is read-only:', err);
    else log.error('clearPermissionRules failed:', err);
    throw err;
  }
}

/** Remove a specific permission rule by scope + tool + command_pattern. */
export async function removePermissionRule(scope: string, tool: string, commandPattern: string): Promise<boolean> {
  try {
    const start = performance.now();
    const db = getDb();
    const result = db.prepare(
      'DELETE FROM permission_rules WHERE scope = ? AND tool = ? AND command_pattern = ?'
    ).run(scope, tool, commandPattern);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`removePermissionRule took ${elapsed.toFixed(0)}ms`);
    return result.changes > 0;
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('removePermissionRule CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('removePermissionRule CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('removePermissionRule - database busy (contention):', err);
    else if (kind === 'readonly') log.error('removePermissionRule - database is read-only:', err);
    else log.error('removePermissionRule failed:', err);
    throw err;
  }
}

/** List all permission rules for a scope. */
export async function listPermissionRulesForScope(scope: string): Promise<StoredPermissionRule[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM permission_rules WHERE scope = ? ORDER BY tool, command_pattern'
    ).all(scope) as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`listPermissionRulesForScope took ${elapsed.toFixed(0)}ms`);
    return rows.map(r => ({
      id: r.id,
      scope: r.scope,
      tool: r.tool,
      commandPattern: r.command_pattern,
      action: r.action,
      createdAt: r.created_at,
    }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('listPermissionRulesForScope CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('listPermissionRulesForScope CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('listPermissionRulesForScope - database busy (contention):', err);
    else if (kind === 'readonly') log.error('listPermissionRulesForScope - database is read-only:', err);
    else log.error('listPermissionRulesForScope failed:', err);
    throw err;
  }
}

/**
 * Check if a tool+command is allowed by existing rules.
 * Returns 'allow', 'deny', or null (no matching rule — need to ask).
 */
export async function checkPermission(scope: string, tool: string, command: string): Promise<'allow' | 'deny' | null> {
  const rules = await getPermissionRules(scope, tool);

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

export async function getWorkspaceOverride(botName: string): Promise<WorkspaceOverride | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT * FROM workspace_overrides WHERE bot_name = ?').get(botName) as any;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getWorkspaceOverride took ${elapsed.toFixed(0)}ms`);
    if (!row) return null;
    return {
      botName: row.bot_name,
      workingDirectory: row.working_directory,
      allowPaths: safeParseAllowPaths(row.allow_paths),
      createdAt: row.created_at,
    };
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getWorkspaceOverride CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getWorkspaceOverride CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getWorkspaceOverride - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getWorkspaceOverride - database is read-only:', err);
    else log.error('getWorkspaceOverride failed:', err);
    throw err;
  }
}

export async function setWorkspaceOverride(botName: string, workingDirectory: string, allowPaths?: string[]): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO workspace_overrides (bot_name, working_directory, allow_paths, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(bot_name) DO UPDATE SET
         working_directory = excluded.working_directory,
         allow_paths = excluded.allow_paths`
    ).run(botName, workingDirectory, JSON.stringify(allowPaths ?? []));
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`setWorkspaceOverride took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('setWorkspaceOverride CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('setWorkspaceOverride CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('setWorkspaceOverride - database busy (contention):', err);
    else if (kind === 'readonly') log.error('setWorkspaceOverride - database is read-only:', err);
    else log.error('setWorkspaceOverride failed:', err);
    throw err;
  }
}

export async function removeWorkspaceOverride(botName: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('DELETE FROM workspace_overrides WHERE bot_name = ?').run(botName);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`removeWorkspaceOverride took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('removeWorkspaceOverride CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('removeWorkspaceOverride CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('removeWorkspaceOverride - database busy (contention):', err);
    else if (kind === 'readonly') log.error('removeWorkspaceOverride - database is read-only:', err);
    else log.error('removeWorkspaceOverride failed:', err);
    throw err;
  }
}

export async function listWorkspaceOverrides(): Promise<WorkspaceOverride[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM workspace_overrides').all() as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`listWorkspaceOverrides took ${elapsed.toFixed(0)}ms`);
    return rows.map(row => ({
      botName: row.bot_name,
      workingDirectory: row.working_directory,
      allowPaths: safeParseAllowPaths(row.allow_paths),
      createdAt: row.created_at,
    }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('listWorkspaceOverrides CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('listWorkspaceOverrides CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('listWorkspaceOverrides - database busy (contention):', err);
    else if (kind === 'readonly') log.error('listWorkspaceOverrides - database is read-only:', err);
    else log.error('listWorkspaceOverrides failed:', err);
    throw err;
  }
}

// --- Global Settings ---

export async function getGlobalSetting(key: string): Promise<string | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getGlobalSetting took ${elapsed.toFixed(0)}ms`);
    return row?.value ?? null;
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getGlobalSetting CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getGlobalSetting CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getGlobalSetting - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getGlobalSetting - database is read-only:', err);
    else log.error('getGlobalSetting failed:', err);
    throw err;
  }
}

export async function setGlobalSetting(key: string, value: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`setGlobalSetting took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('setGlobalSetting CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('setGlobalSetting CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('setGlobalSetting - database busy (contention):', err);
    else if (kind === 'readonly') log.error('setGlobalSetting - database is read-only:', err);
    else log.error('setGlobalSetting failed:', err);
    throw err;
  }
}

// --- Dynamic Channels ---

export interface DynamicChannel {
  channelId: string;
  platform: string;
  name: string;
  bot?: string;
  workingDirectory: string;
  agent?: string | null;
  model?: string;
  triggerMode?: 'mention' | 'all';
  threadedReplies?: boolean;
  verbose?: boolean;
  isDM: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function addDynamicChannel(channel: Omit<DynamicChannel, 'createdAt' | 'updatedAt'>): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO dynamic_channels (channel_id, platform, name, bot, working_directory, agent, model, trigger_mode, threaded_replies, verbose, is_dm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         platform = excluded.platform, name = excluded.name, bot = excluded.bot,
         working_directory = excluded.working_directory, agent = excluded.agent,
         model = excluded.model, trigger_mode = excluded.trigger_mode,
         threaded_replies = excluded.threaded_replies, verbose = excluded.verbose,
         is_dm = excluded.is_dm, updated_at = datetime('now')`
    ).run(
      channel.channelId,
      channel.platform,
      channel.name ?? '',
      channel.bot ?? null,
      channel.workingDirectory,
      channel.agent ?? null,
      channel.model ?? null,
      channel.triggerMode ?? null,
      channel.threadedReplies != null ? (channel.threadedReplies ? 1 : 0) : null,
      channel.verbose != null ? (channel.verbose ? 1 : 0) : null,
      channel.isDM ? 1 : 0,
    );
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`addDynamicChannel took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('addDynamicChannel CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('addDynamicChannel CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('addDynamicChannel - database busy (contention):', err);
    else if (kind === 'readonly') log.error('addDynamicChannel - database is read-only:', err);
    else log.error('addDynamicChannel failed:', err);
    throw err;
  }
}

export async function removeDynamicChannel(channelId: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('DELETE FROM dynamic_channels WHERE channel_id = ?').run(channelId);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`removeDynamicChannel took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('removeDynamicChannel CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('removeDynamicChannel CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('removeDynamicChannel - database busy (contention):', err);
    else if (kind === 'readonly') log.error('removeDynamicChannel - database is read-only:', err);
    else log.error('removeDynamicChannel failed:', err);
    throw err;
  }
}

export async function getDynamicChannel(channelId: string): Promise<DynamicChannel | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT * FROM dynamic_channels WHERE channel_id = ?').get(channelId) as any;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getDynamicChannel took ${elapsed.toFixed(0)}ms`);
    if (!row) return null;
    return mapDynamicChannelRow(row);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getDynamicChannel CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getDynamicChannel CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getDynamicChannel - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getDynamicChannel - database is read-only:', err);
    else log.error('getDynamicChannel failed:', err);
    throw err;
  }
}

export async function getDynamicChannels(): Promise<DynamicChannel[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM dynamic_channels ORDER BY created_at').all() as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getDynamicChannels took ${elapsed.toFixed(0)}ms`);
    return rows.map(mapDynamicChannelRow);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getDynamicChannels CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getDynamicChannels CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getDynamicChannels - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getDynamicChannels - database is read-only:', err);
    else log.error('getDynamicChannels failed:', err);
    throw err;
  }
}

function mapDynamicChannelRow(row: any): DynamicChannel {
  return {
    channelId: row.channel_id,
    platform: row.platform,
    name: row.name,
    bot: row.bot ?? undefined,
    workingDirectory: row.working_directory,
    agent: row.agent,
    model: row.model ?? undefined,
    triggerMode: row.trigger_mode as 'mention' | 'all' | undefined,
    threadedReplies: row.threaded_replies != null ? !!row.threaded_replies : undefined,
    verbose: row.verbose != null ? !!row.verbose : undefined,
    isDM: !!row.is_dm,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Agent Calls (inter-agent audit trail) ---

export interface AgentCallRecord {
  callerBot: string;
  targetBot: string;
  targetAgent?: string;
  messageSummary?: string;
  responseSummary?: string;
  durationMs?: number;
  success: boolean;
  error?: string;
  chainId?: string;
  depth?: number;
}

export async function recordAgentCall(record: AgentCallRecord): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_calls (caller_bot, target_bot, target_agent, message_summary, response_summary, duration_ms, success, error, chain_id, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.callerBot,
      record.targetBot,
      record.targetAgent ?? null,
      record.messageSummary ?? null,
      record.responseSummary ?? null,
      record.durationMs ?? null,
      record.success ? 1 : 0,
      record.error ?? null,
      record.chainId ?? null,
      record.depth ?? 0,
    );
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`recordAgentCall took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('recordAgentCall CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('recordAgentCall CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('recordAgentCall - database busy (contention):', err);
    else if (kind === 'readonly') log.error('recordAgentCall - database is read-only:', err);
    else log.error('recordAgentCall failed:', err);
    throw err;
  }
}

export async function getRecentAgentCalls(limit: number = 20): Promise<Array<AgentCallRecord & { id: number; createdAt: string }>> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM agent_calls ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getRecentAgentCalls took ${elapsed.toFixed(0)}ms`);
    return rows.map(r => ({
      id: r.id,
      callerBot: r.caller_bot,
      targetBot: r.target_bot,
      targetAgent: r.target_agent ?? undefined,
      messageSummary: r.message_summary ?? undefined,
      responseSummary: r.response_summary ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      success: !!r.success,
      error: r.error ?? undefined,
      chainId: r.chain_id ?? undefined,
      depth: r.depth ?? 0,
      createdAt: r.created_at,
    }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getRecentAgentCalls CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getRecentAgentCalls CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getRecentAgentCalls - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getRecentAgentCalls - database is read-only:', err);
    else log.error('getRecentAgentCalls failed:', err);
    throw err;
  }
}

// --- Scheduled Tasks ---

export interface ScheduledTask {
  id: string;
  channelId: string;
  botName: string;
  prompt: string;
  cronExpr?: string;
  runAt?: string;
  timezone: string;
  createdBy?: string;
  description?: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

export async function insertScheduledTask(task: Omit<ScheduledTask, 'createdAt' | 'lastRun' | 'nextRun'> & { nextRun?: string }): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(`
      INSERT INTO scheduled_tasks (id, channel_id, bot_name, prompt, cron_expr, run_at, timezone, created_by, description, enabled, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.channelId, task.botName, task.prompt,
      task.cronExpr ?? null, task.runAt ?? null, task.timezone,
      task.createdBy ?? null, task.description ?? null,
      task.enabled ? 1 : 0, task.nextRun ?? null,
    );
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`insertScheduledTask took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('insertScheduledTask CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('insertScheduledTask CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('insertScheduledTask - database busy (contention):', err);
    else if (kind === 'readonly') log.error('insertScheduledTask - database is read-only:', err);
    else log.error('insertScheduledTask failed:', err);
    throw err;
  }
}

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  try {
    const start = performance.now();
    const db = getDb();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any;
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getScheduledTask took ${elapsed.toFixed(0)}ms`);
    return row ? mapTaskRow(row) : null;
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getScheduledTask CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getScheduledTask CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getScheduledTask - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getScheduledTask - database is read-only:', err);
    else log.error('getScheduledTask failed:', err);
    throw err;
  }
}

export async function getScheduledTasksForChannel(channelId: string): Promise<ScheduledTask[]> {
  try {
    const start = performance.now();
    const db = getDb();
    // Show enabled tasks + paused recurring tasks (exclude disabled one-offs — they're finished)
    const rows = db.prepare(
      'SELECT * FROM scheduled_tasks WHERE channel_id = ? AND (enabled = 1 OR cron_expr IS NOT NULL) ORDER BY created_at DESC'
    ).all(channelId) as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getScheduledTasksForChannel took ${elapsed.toFixed(0)}ms`);
    return rows.map(mapTaskRow);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getScheduledTasksForChannel CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getScheduledTasksForChannel CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getScheduledTasksForChannel - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getScheduledTasksForChannel - database is read-only:', err);
    else log.error('getScheduledTasksForChannel failed:', err);
    throw err;
  }
}

export async function getEnabledScheduledTasks(): Promise<ScheduledTask[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all() as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getEnabledScheduledTasks took ${elapsed.toFixed(0)}ms`);
    return rows.map(mapTaskRow);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getEnabledScheduledTasks CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getEnabledScheduledTasks CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getEnabledScheduledTasks - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getEnabledScheduledTasks - database is read-only:', err);
    else log.error('getEnabledScheduledTasks failed:', err);
    throw err;
  }
}

export async function updateScheduledTaskEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`updateScheduledTaskEnabled took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('updateScheduledTaskEnabled CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('updateScheduledTaskEnabled CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('updateScheduledTaskEnabled - database busy (contention):', err);
    else if (kind === 'readonly') log.error('updateScheduledTaskEnabled - database is read-only:', err);
    else log.error('updateScheduledTaskEnabled failed:', err);
    throw err;
  }
}

export async function updateScheduledTaskLastRun(id: string, lastRun: string, nextRun?: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?').run(lastRun, nextRun ?? null, id);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`updateScheduledTaskLastRun took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('updateScheduledTaskLastRun CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('updateScheduledTaskLastRun CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('updateScheduledTaskLastRun - database busy (contention):', err);
    else if (kind === 'readonly') log.error('updateScheduledTaskLastRun - database is read-only:', err);
    else log.error('updateScheduledTaskLastRun failed:', err);
    throw err;
  }
}

export async function deleteScheduledTask(id: string): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`deleteScheduledTask took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('deleteScheduledTask CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('deleteScheduledTask CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('deleteScheduledTask - database busy (contention):', err);
    else if (kind === 'readonly') log.error('deleteScheduledTask - database is read-only:', err);
    else log.error('deleteScheduledTask failed:', err);
    throw err;
  }
}

function mapTaskRow(r: any): ScheduledTask {
  return {
    id: r.id,
    channelId: r.channel_id,
    botName: r.bot_name,
    prompt: r.prompt,
    cronExpr: r.cron_expr ?? undefined,
    runAt: r.run_at ?? undefined,
    timezone: r.timezone,
    createdBy: r.created_by ?? undefined,
    description: r.description ?? undefined,
    enabled: !!r.enabled,
    lastRun: r.last_run ?? undefined,
    nextRun: r.next_run ?? undefined,
    createdAt: r.created_at,
  };
}

// --- Scheduled Task History ---

export interface TaskHistoryEntry {
  id: number;
  taskId: string;
  channelId: string;
  prompt: string;
  description?: string;
  timezone: string;
  status: 'success' | 'error';
  firedAt: string;
  error?: string;
}

export async function insertTaskHistory(entry: Omit<TaskHistoryEntry, 'id' | 'firedAt'>): Promise<void> {
  try {
    const start = performance.now();
    const db = getDb();
    db.prepare(`
      INSERT INTO scheduled_task_history (task_id, channel_id, prompt, description, timezone, status, fired_at, error)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(entry.taskId, entry.channelId, entry.prompt, entry.description ?? null, entry.timezone, entry.status, entry.error ?? null);
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`insertTaskHistory took ${elapsed.toFixed(0)}ms`);
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('insertTaskHistory CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('insertTaskHistory CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('insertTaskHistory - database busy (contention):', err);
    else if (kind === 'readonly') log.error('insertTaskHistory - database is read-only:', err);
    else log.error('insertTaskHistory failed:', err);
    throw err;
  }
}

export async function getTaskHistory(channelId: string, limit = 20): Promise<TaskHistoryEntry[]> {
  try {
    const start = performance.now();
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM scheduled_task_history WHERE channel_id = ? ORDER BY fired_at DESC LIMIT ?'
    ).all(channelId, limit) as any[];
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) log.warn(`getTaskHistory took ${elapsed.toFixed(0)}ms`);
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      channelId: r.channel_id,
      prompt: r.prompt,
      description: r.description ?? undefined,
      timezone: r.timezone ?? 'UTC',
      status: r.status,
      firedAt: r.fired_at,
      error: r.error ?? undefined,
    }));
  } catch (err) {
    const kind = classifyDbError(err);
    if (kind === 'corrupt') log.error('getTaskHistory CRITICAL - database may be corrupt:', err);
    else if (kind === 'full') log.error('getTaskHistory CRITICAL - disk full:', err);
    else if (kind === 'busy') log.warn('getTaskHistory - database busy (contention):', err);
    else if (kind === 'readonly') log.error('getTaskHistory - database is read-only:', err);
    else log.error('getTaskHistory failed:', err);
    throw err;
  }
}

// --- Cleanup ---

export async function closeDb(): Promise<void> {
  _db?.close();
  _db = null;
}
