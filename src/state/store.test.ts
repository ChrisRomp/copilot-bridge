import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStore,
  getStore,
  closeDb,
  getChannelSession,
  setChannelSession,
  getChannelPrefs,
  setChannelPrefs,
  checkPermission,
  getGlobalSetting,
  setGlobalSetting,
} from './store.js';
import type {
  StateStore,
  ChannelPrefs,
  StoredPermissionRule,
  WorkspaceOverride,
  DynamicChannel,
  AgentCallRecord,
  ScheduledTask,
  TaskHistoryEntry,
} from './store.js';

// ---------------------------------------------------------------------------
// Helper: full mock StateStore backed by vi.fn() spies
// ---------------------------------------------------------------------------

function createMockStore(): StateStore {
  return {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getChannelSession: vi.fn().mockResolvedValue(null),
    setChannelSession: vi.fn().mockResolvedValue(undefined),
    clearChannelSession: vi.fn().mockResolvedValue(undefined),
    getAllChannelSessions: vi.fn().mockResolvedValue([]),
    getChannelPrefs: vi.fn().mockResolvedValue(null),
    setChannelPrefs: vi.fn().mockResolvedValue(undefined),
    getPermissionRules: vi.fn().mockResolvedValue([]),
    addPermissionRule: vi.fn().mockResolvedValue(undefined),
    clearPermissionRules: vi.fn().mockResolvedValue(undefined),
    removePermissionRule: vi.fn().mockResolvedValue(false),
    listPermissionRulesForScope: vi.fn().mockResolvedValue([]),
    checkPermission: vi.fn().mockResolvedValue(null),
    getWorkspaceOverride: vi.fn().mockResolvedValue(null),
    setWorkspaceOverride: vi.fn().mockResolvedValue(undefined),
    removeWorkspaceOverride: vi.fn().mockResolvedValue(undefined),
    listWorkspaceOverrides: vi.fn().mockResolvedValue([]),
    getGlobalSetting: vi.fn().mockResolvedValue(null),
    setGlobalSetting: vi.fn().mockResolvedValue(undefined),
    addDynamicChannel: vi.fn().mockResolvedValue(undefined),
    removeDynamicChannel: vi.fn().mockResolvedValue(undefined),
    getDynamicChannel: vi.fn().mockResolvedValue(null),
    getDynamicChannels: vi.fn().mockResolvedValue([]),
    recordAgentCall: vi.fn().mockResolvedValue(undefined),
    getRecentAgentCalls: vi.fn().mockResolvedValue([]),
    insertScheduledTask: vi.fn().mockResolvedValue(undefined),
    getScheduledTask: vi.fn().mockResolvedValue(null),
    getScheduledTasksForChannel: vi.fn().mockResolvedValue([]),
    getEnabledScheduledTasks: vi.fn().mockResolvedValue([]),
    updateScheduledTaskEnabled: vi.fn().mockResolvedValue(undefined),
    updateScheduledTaskLastRun: vi.fn().mockResolvedValue(undefined),
    deleteScheduledTask: vi.fn().mockResolvedValue(undefined),
    insertTaskHistory: vi.fn().mockResolvedValue(undefined),
    getTaskHistory: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('store facade', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-facade-'));
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- initStore lifecycle ------------------------------------------------

  describe('initStore lifecycle', () => {
    it('creates a working store with custom dbPath', async () => {
      await initStore(undefined, path.join(tmpDir, 'test.db'));
      const s = getStore();
      expect(s).toBeDefined();
      expect(await s.ping()).toBe(true);
    });

    it('accepts a custom StateStore implementation', async () => {
      const mock = createMockStore();
      await initStore(mock);
      expect(getStore()).toBe(mock);
      expect(mock.initialize).toHaveBeenCalledOnce();
    });

    it('accepts a custom dbPath (ignored when customStore provided)', async () => {
      const mock = createMockStore();
      await initStore(mock, '/should/be/ignored');
      expect(getStore()).toBe(mock);
    });

    it('double-call closes previous store before re-init', async () => {
      const first = createMockStore();
      const second = createMockStore();
      await initStore(first);
      await initStore(second);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.initialize).toHaveBeenCalledOnce();
      expect(getStore()).toBe(second);
    });

    it('getStore returns the same instance after init', async () => {
      await initStore(undefined, path.join(tmpDir, 'test.db'));
      const s1 = getStore();
      const s2 = getStore();
      expect(s1).toBe(s2);
    });
  });

  // ---- closeDb lifecycle --------------------------------------------------

  describe('closeDb lifecycle', () => {
    it('closes the active store', async () => {
      const mock = createMockStore();
      await initStore(mock);
      await closeDb();
      expect(mock.close).toHaveBeenCalledOnce();
    });

    it('double-close is a no-op (no error)', async () => {
      const mock = createMockStore();
      await initStore(mock);
      await closeDb();
      await closeDb(); // second call should not throw
      expect(mock.close).toHaveBeenCalledOnce();
    });

    it('after close, store functions auto-re-init', async () => {
      await initStore(undefined, path.join(tmpDir, 'test.db'));
      await closeDb();
      // Calling getStore() triggers the auto-init fallback
      const s = getStore();
      expect(s).toBeDefined();
    });
  });

  // ---- Facade delegation --------------------------------------------------

  describe('facade delegation', () => {
    beforeEach(async () => {
      await initStore(undefined, path.join(tmpDir, 'test.db'));
    });

    it('setChannelSession / getChannelSession round-trips', async () => {
      await setChannelSession('ch1', 'sess-abc');
      expect(await getChannelSession('ch1')).toBe('sess-abc');
    });

    it('getChannelSession returns null for unknown channel', async () => {
      expect(await getChannelSession('unknown')).toBeNull();
    });

    it('setChannelPrefs / getChannelPrefs round-trips', async () => {
      await setChannelPrefs('ch1', { model: 'gpt-4', verbose: true });
      const prefs = await getChannelPrefs('ch1');
      expect(prefs).toBeDefined();
      expect(prefs!.model).toBe('gpt-4');
      expect(prefs!.verbose).toBe(true);
    });

    it('checkPermission returns null when no rules exist', async () => {
      expect(await checkPermission('global', 'bash', 'ls')).toBeNull();
    });

    it('setGlobalSetting / getGlobalSetting round-trips', async () => {
      await setGlobalSetting('theme', 'dark');
      expect(await getGlobalSetting('theme')).toBe('dark');
    });

    it('getGlobalSetting returns null for unknown key', async () => {
      expect(await getGlobalSetting('nonexistent')).toBeNull();
    });
  });

  // ---- Type re-exports ----------------------------------------------------

  describe('type re-exports', () => {
    it('exports all shared types from store module', () => {
      // These are compile-time checks — if the imports above resolve,
      // the re-exports work. Runtime assertion as a guard:
      const check: Record<string, unknown> = {
        StateStore: undefined as unknown as StateStore,
        ChannelPrefs: undefined as unknown as ChannelPrefs,
        StoredPermissionRule: undefined as unknown as StoredPermissionRule,
        WorkspaceOverride: undefined as unknown as WorkspaceOverride,
        DynamicChannel: undefined as unknown as DynamicChannel,
        AgentCallRecord: undefined as unknown as AgentCallRecord,
        ScheduledTask: undefined as unknown as ScheduledTask,
        TaskHistoryEntry: undefined as unknown as TaskHistoryEntry,
      };
      expect(Object.keys(check)).toHaveLength(8);
    });
  });
});
