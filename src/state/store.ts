import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DB_PATH = path.join(os.homedir(), '.copilot-bridge', 'state.db');

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
  provider?: string | null;
  agent?: string | null;
  verbose?: boolean;

  threadedReplies?: boolean;
  permissionMode?: string;
  reasoningEffort?: string | null;
  sessionMode?: string;
  disabledSkills?: string[];
}

export function getChannelPrefs(channelId: string): ChannelPrefs | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM channel_prefs WHERE channel_id = ?').get(channelId) as any;
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
}

export function setChannelPrefs(channelId: string, prefs: Partial<ChannelPrefs>): void {
  const db = getDb();
  const existing = getChannelPrefs(channelId);

  if (existing) {
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
  } else {
    db.prepare(
      `INSERT INTO channel_prefs (channel_id, model, provider, agent, verbose, threaded_replies, permission_mode, reasoning_effort, session_mode, disabled_skills)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      channelId,
      prefs.model ?? null,
      prefs.provider ?? null,
      prefs.agent ?? null,
      prefs.verbose != null ? (prefs.verbose ? 1 : 0) : null,
      prefs.threadedReplies != null ? (prefs.threadedReplies ? 1 : 0) : null,
      prefs.permissionMode ?? null,
      prefs.reasoningEffort ?? null,
      prefs.sessionMode ?? null,
      prefs.disabledSkills?.length ? JSON.stringify(prefs.disabledSkills) : null,
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

/** Remove a specific permission rule by scope + tool + command_pattern. */
export function removePermissionRule(scope: string, tool: string, commandPattern: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM permission_rules WHERE scope = ? AND tool = ? AND command_pattern = ?'
  ).run(scope, tool, commandPattern);
  return result.changes > 0;
}

/** List all permission rules for a scope. */
export function listPermissionRulesForScope(scope: string): StoredPermissionRule[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM permission_rules WHERE scope = ? ORDER BY tool, command_pattern'
  ).all(scope) as any[];
  return rows.map(r => ({
    id: r.id,
    scope: r.scope,
    tool: r.tool,
    commandPattern: r.command_pattern,
    action: r.action,
    createdAt: r.created_at,
  }));
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

// --- Global Settings ---

export function getGlobalSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setGlobalSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
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

export function addDynamicChannel(channel: Omit<DynamicChannel, 'createdAt' | 'updatedAt'>): void {
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
}

export function removeDynamicChannel(channelId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM dynamic_channels WHERE channel_id = ?').run(channelId);
}

export function getDynamicChannel(channelId: string): DynamicChannel | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM dynamic_channels WHERE channel_id = ?').get(channelId) as any;
  if (!row) return null;
  return mapDynamicChannelRow(row);
}

export function getDynamicChannels(): DynamicChannel[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM dynamic_channels ORDER BY created_at').all() as any[];
  return rows.map(mapDynamicChannelRow);
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

export function recordAgentCall(record: AgentCallRecord): void {
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
}

export function getRecentAgentCalls(limit: number = 20): Array<AgentCallRecord & { id: number; createdAt: string }> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM agent_calls ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[];
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

export function insertScheduledTask(task: Omit<ScheduledTask, 'createdAt' | 'lastRun' | 'nextRun'> & { nextRun?: string }): void {
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
}

export function getScheduledTask(id: string): ScheduledTask | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any;
  return row ? mapTaskRow(row) : null;
}

export function getScheduledTasksForChannel(channelId: string): ScheduledTask[] {
  const db = getDb();
  // Show enabled tasks + paused recurring tasks (exclude disabled one-offs — they're finished)
  const rows = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE channel_id = ? AND (enabled = 1 OR cron_expr IS NOT NULL) ORDER BY created_at DESC'
  ).all(channelId) as any[];
  return rows.map(mapTaskRow);
}

export function getEnabledScheduledTasks(): ScheduledTask[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all() as any[];
  return rows.map(mapTaskRow);
}

export function updateScheduledTaskEnabled(id: string, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function updateScheduledTaskLastRun(id: string, lastRun: string, nextRun?: string): void {
  const db = getDb();
  db.prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ? WHERE id = ?').run(lastRun, nextRun ?? null, id);
}

export function deleteScheduledTask(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
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

export function insertTaskHistory(entry: Omit<TaskHistoryEntry, 'id' | 'firedAt'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO scheduled_task_history (task_id, channel_id, prompt, description, timezone, status, fired_at, error)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(entry.taskId, entry.channelId, entry.prompt, entry.description ?? null, entry.timezone, entry.status, entry.error ?? null);
}

export function getTaskHistory(channelId: string, limit = 20): TaskHistoryEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM scheduled_task_history WHERE channel_id = ? ORDER BY fired_at DESC LIMIT ?'
  ).all(channelId, limit) as any[];
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
}

// --- Cleanup ---

export function closeDb(): void {
  _db?.close();
  _db = null;
}
