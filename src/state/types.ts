/**
 * Pluggable state store interface and shared types for copilot-bridge.
 *
 * All persistence backends (SQLite, Postgres, etc.) implement the
 * {@link StateStore} interface. The data types below are shared across
 * every implementation and the rest of the codebase.
 */

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

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

export interface StoredPermissionRule {
  id: number;
  scope: string;
  tool: string;
  commandPattern: string;
  action: 'allow' | 'deny';
  createdAt: string;
}

export interface WorkspaceOverride {
  botName: string;
  workingDirectory: string;
  allowPaths: string[];
  createdAt: string;
}

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

// ---------------------------------------------------------------------------
// StateStore interface
// ---------------------------------------------------------------------------

/**
 * Contract for pluggable persistence backends.
 *
 * Every method is async so implementations can use network-backed stores
 * (Postgres, Redis, etc.) without blocking the event loop.
 */
export interface StateStore {
  // -- Lifecycle -------------------------------------------------------------

  /** Create tables / run migrations. Called once at startup. */
  initialize(): Promise<void>;

  /** Release connections and clean up resources. */
  close(): Promise<void>;

  /** Return `true` if the backing store is reachable. */
  ping(): Promise<boolean>;

  /** Run a set of operations atomically. Implementations handle isolation internally. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  // -- Sessions --------------------------------------------------------------

  /** Get the active Copilot session ID for a channel, or `null`. */
  getChannelSession(channelId: string): Promise<string | null>;

  /** Persist the active session ID for a channel. */
  setChannelSession(channelId: string, sessionId: string): Promise<void>;

  /** Remove the stored session for a channel. */
  clearChannelSession(channelId: string): Promise<void>;

  /** List every channel → session mapping. */
  getAllChannelSessions(): Promise<Array<{ channelId: string; sessionId: string }>>;

  // -- Preferences -----------------------------------------------------------

  /** Read per-channel preferences, or `null` if none are stored. */
  getChannelPrefs(channelId: string): Promise<ChannelPrefs | null>;

  /** Merge partial preferences into the stored record for a channel. */
  setChannelPrefs(channelId: string, prefs: Partial<ChannelPrefs>): Promise<void>;

  // -- Permissions -----------------------------------------------------------

  /** Fetch permission rules matching a scope and tool. */
  getPermissionRules(scope: string, tool: string): Promise<StoredPermissionRule[]>;

  /** Add a permission rule for a scope/tool/pattern combination. */
  addPermissionRule(scope: string, tool: string, commandPattern: string, action: 'allow' | 'deny'): Promise<void>;

  /** Remove all permission rules for a scope. */
  clearPermissionRules(scope: string): Promise<void>;

  /** Remove a single permission rule. Returns `true` if a row was deleted. */
  removePermissionRule(scope: string, tool: string, commandPattern: string): Promise<boolean>;

  /** List every permission rule for a scope. */
  listPermissionRulesForScope(scope: string): Promise<StoredPermissionRule[]>;

  /** Evaluate rules and return the action, or `null` if no rule matches. */
  checkPermission(scope: string, tool: string, command: string): Promise<'allow' | 'deny' | null>;

  // -- Workspaces ------------------------------------------------------------

  /** Get the workspace override for a bot, or `null`. */
  getWorkspaceOverride(botName: string): Promise<WorkspaceOverride | null>;

  /** Set (upsert) the workspace override for a bot. */
  setWorkspaceOverride(botName: string, workingDirectory: string, allowPaths?: string[]): Promise<void>;

  /** Remove the workspace override for a bot. */
  removeWorkspaceOverride(botName: string): Promise<void>;

  /** List all workspace overrides. */
  listWorkspaceOverrides(): Promise<WorkspaceOverride[]>;

  // -- Settings --------------------------------------------------------------

  /** Read a global key-value setting, or `null`. */
  getGlobalSetting(key: string): Promise<string | null>;

  /** Write a global key-value setting. */
  setGlobalSetting(key: string, value: string): Promise<void>;

  // -- Dynamic Channels ------------------------------------------------------

  /** Register a dynamic channel. */
  addDynamicChannel(channel: Omit<DynamicChannel, 'createdAt' | 'updatedAt'>): Promise<void>;

  /** Unregister a dynamic channel. */
  removeDynamicChannel(channelId: string): Promise<void>;

  /** Get a single dynamic channel by ID, or `null`. */
  getDynamicChannel(channelId: string): Promise<DynamicChannel | null>;

  /** List all dynamic channels. */
  getDynamicChannels(): Promise<DynamicChannel[]>;

  // -- Agent Calls -----------------------------------------------------------

  /** Record an inter-agent call for audit/debugging. */
  recordAgentCall(record: AgentCallRecord): Promise<void>;

  /** Fetch the most recent agent call records. */
  getRecentAgentCalls(limit?: number): Promise<Array<AgentCallRecord & { id: number; createdAt: string }>>;

  // -- Scheduling ------------------------------------------------------------

  /** Insert a new scheduled task. */
  insertScheduledTask(task: Omit<ScheduledTask, 'createdAt' | 'lastRun' | 'nextRun'> & { nextRun?: string }): Promise<void>;

  /** Get a scheduled task by ID, or `null`. */
  getScheduledTask(id: string): Promise<ScheduledTask | null>;

  /** List scheduled tasks for a channel. */
  getScheduledTasksForChannel(channelId: string): Promise<ScheduledTask[]>;

  /** List all enabled scheduled tasks. */
  getEnabledScheduledTasks(): Promise<ScheduledTask[]>;

  /** Enable or disable a scheduled task. */
  updateScheduledTaskEnabled(id: string, enabled: boolean): Promise<void>;

  /** Update the last-run timestamp (and optionally next-run) for a task. */
  updateScheduledTaskLastRun(id: string, lastRun: string, nextRun?: string): Promise<void>;

  /** Delete a scheduled task. */
  deleteScheduledTask(id: string): Promise<void>;

  /** Record a task execution in history. */
  insertTaskHistory(entry: Omit<TaskHistoryEntry, 'id' | 'firedAt'>): Promise<void>;

  /** Fetch task execution history for a channel. */
  getTaskHistory(channelId: string, limit?: number): Promise<TaskHistoryEntry[]>;
}
