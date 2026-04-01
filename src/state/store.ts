/**
 * State store facade — delegates every call to the active {@link StateStore}
 * instance. Callers import from this module unchanged; the backing
 * implementation is swapped via {@link initStore}.
 *
 * Default backend: {@link SqliteStateStore} (built-in, uses better-sqlite3).
 * Custom backends are loaded at startup via the `database.module` config key.
 */

import { createLogger } from '../logger.js';
import { SqliteStateStore } from './sqlite-store.js';
import type { StateStore } from './types.js';

// Re-export shared data types so existing callers keep working
export type {
  StateStore,
  ChannelPrefs,
  StoredPermissionRule,
  WorkspaceOverride,
  DynamicChannel,
  AgentCallRecord,
  ScheduledTask,
  TaskHistoryEntry,
} from './types.js';

const log = createLogger('store');

// ---------------------------------------------------------------------------
// Active store instance
// ---------------------------------------------------------------------------

let _store: StateStore | null = null;

function store(): StateStore {
  if (!_store) {
    // Auto-initialize with default SQLite backend for backward compatibility
    // (tests and code that call store functions before explicit initStore)
    log.warn('Store accessed before initStore() — auto-initializing with defaults');
    const sqlite = new SqliteStateStore();
    _store = sqlite;
    // better-sqlite3 is synchronous so this resolves immediately, but catch
    // any failure so it's never silently swallowed
    sqlite.initialize().catch((err) => {
      log.error('Auto-initialization of default SQLite store failed:', err);
      _store = null;
    });
  }
  return _store;
}

/**
 * Initialize the state store. Call once at startup before any other store
 * function.
 *
 * @param customStore  An already-constructed {@link StateStore} to use instead
 *                     of the built-in SQLite backend. Useful for tests and
 *                     custom database plugins.
 * @param dbPath       Path for the default SQLite backend (ignored when
 *                     `customStore` is provided).
 */
export async function initStore(customStore?: StateStore, dbPath?: string): Promise<void> {
  if (_store) {
    log.warn('initStore called when store already initialized — closing previous instance');
    try {
      await _store.close();
    } catch (err) {
      log.warn('Failed to close previous store during re-init:', err);
    }
    _store = null;
  }
  _store = customStore ?? new SqliteStateStore(dbPath);
  await _store.initialize();
  log.info('State store initialized');
}

/** Return the active store instance (for advanced use / testing). */
export function getStore(): StateStore {
  return store();
}

// ---------------------------------------------------------------------------
// Delegating facade — every function forwards to the active store
// ---------------------------------------------------------------------------

// -- Sessions ---------------------------------------------------------------
export async function getChannelSession(channelId: string) {
  return store().getChannelSession(channelId);
}
export async function setChannelSession(channelId: string, sessionId: string) {
  return store().setChannelSession(channelId, sessionId);
}
export async function clearChannelSession(channelId: string) {
  return store().clearChannelSession(channelId);
}
export async function getAllChannelSessions() {
  return store().getAllChannelSessions();
}

// -- Preferences ------------------------------------------------------------
export async function getChannelPrefs(channelId: string) {
  return store().getChannelPrefs(channelId);
}
export async function setChannelPrefs(channelId: string, prefs: Parameters<StateStore['setChannelPrefs']>[1]) {
  return store().setChannelPrefs(channelId, prefs);
}

// -- Permissions ------------------------------------------------------------
export async function getPermissionRules(scope: string, tool: string) {
  return store().getPermissionRules(scope, tool);
}
export async function addPermissionRule(scope: string, tool: string, commandPattern: string, action: 'allow' | 'deny') {
  return store().addPermissionRule(scope, tool, commandPattern, action);
}
export async function clearPermissionRules(scope: string) {
  return store().clearPermissionRules(scope);
}
export async function removePermissionRule(scope: string, tool: string, commandPattern: string) {
  return store().removePermissionRule(scope, tool, commandPattern);
}
export async function listPermissionRulesForScope(scope: string) {
  return store().listPermissionRulesForScope(scope);
}
export async function checkPermission(scope: string, tool: string, command: string) {
  return store().checkPermission(scope, tool, command);
}

// -- Workspaces -------------------------------------------------------------
export async function getWorkspaceOverride(botName: string) {
  return store().getWorkspaceOverride(botName);
}
export async function setWorkspaceOverride(botName: string, workingDirectory: string, allowPaths?: string[]) {
  return store().setWorkspaceOverride(botName, workingDirectory, allowPaths);
}
export async function removeWorkspaceOverride(botName: string) {
  return store().removeWorkspaceOverride(botName);
}
export async function listWorkspaceOverrides() {
  return store().listWorkspaceOverrides();
}

// -- Settings ---------------------------------------------------------------
export async function getGlobalSetting(key: string) {
  return store().getGlobalSetting(key);
}
export async function setGlobalSetting(key: string, value: string) {
  return store().setGlobalSetting(key, value);
}

// -- Dynamic Channels -------------------------------------------------------
export async function addDynamicChannel(channel: Parameters<StateStore['addDynamicChannel']>[0]) {
  return store().addDynamicChannel(channel);
}
export async function removeDynamicChannel(channelId: string) {
  return store().removeDynamicChannel(channelId);
}
export async function getDynamicChannel(channelId: string) {
  return store().getDynamicChannel(channelId);
}
export async function getDynamicChannels() {
  return store().getDynamicChannels();
}

// -- Agent Calls ------------------------------------------------------------
export async function recordAgentCall(record: Parameters<StateStore['recordAgentCall']>[0]) {
  return store().recordAgentCall(record);
}
export async function getRecentAgentCalls(limit?: number) {
  return store().getRecentAgentCalls(limit);
}

// -- Scheduling -------------------------------------------------------------
export async function insertScheduledTask(task: Parameters<StateStore['insertScheduledTask']>[0]) {
  return store().insertScheduledTask(task);
}
export async function getScheduledTask(id: string) {
  return store().getScheduledTask(id);
}
export async function getScheduledTasksForChannel(channelId: string) {
  return store().getScheduledTasksForChannel(channelId);
}
export async function getEnabledScheduledTasks() {
  return store().getEnabledScheduledTasks();
}
export async function updateScheduledTaskEnabled(id: string, enabled: boolean) {
  return store().updateScheduledTaskEnabled(id, enabled);
}
export async function updateScheduledTaskLastRun(id: string, lastRun: string, nextRun?: string) {
  return store().updateScheduledTaskLastRun(id, lastRun, nextRun);
}
export async function deleteScheduledTask(id: string) {
  return store().deleteScheduledTask(id);
}
export async function insertTaskHistory(entry: Parameters<StateStore['insertTaskHistory']>[0]) {
  return store().insertTaskHistory(entry);
}
export async function getTaskHistory(channelId: string, limit?: number) {
  return store().getTaskHistory(channelId, limit);
}

// -- Lifecycle --------------------------------------------------------------
export async function closeDb(): Promise<void> {
  if (!_store) {
    log.debug('closeDb called but store is already null — no-op');
    return;
  }
  try {
    await _store.close();
    log.info('State store closed');
  } catch (err) {
    log.warn('Failed to close database cleanly:', err);
  } finally {
    _store = null;
  }
}
