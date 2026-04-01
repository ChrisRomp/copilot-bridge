import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from './sqlite-store.js';

describe('SqliteStateStore', () => {
  let tmpDir: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-store-'));
    store = new SqliteStateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
  });

  afterEach(async () => {
    await store.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Lifecycle ----------------------------------------------------------

  describe('lifecycle', () => {
    it('constructor accepts custom dbPath', () => {
      const s = new SqliteStateStore(path.join(tmpDir, 'custom.db'));
      expect(s).toBeDefined();
    });

    it('initialize creates the DB file and tables', () => {
      const dbFile = path.join(tmpDir, 'test.db');
      expect(fs.existsSync(dbFile)).toBe(true);
    });

    it('ping returns true when open', async () => {
      expect(await store.ping()).toBe(true);
    });

    it('ping returns false after close', async () => {
      await store.close();
      expect(await store.ping()).toBe(false);
    });

    it('close makes subsequent operations throw', async () => {
      await store.close();
      await expect(store.getChannelSession('ch1')).rejects.toThrow();
    });
  });

  // ---- Sessions CRUD ------------------------------------------------------

  describe('sessions', () => {
    it('set and get a channel session', async () => {
      await store.setChannelSession('ch1', 'sess-1');
      expect(await store.getChannelSession('ch1')).toBe('sess-1');
    });

    it('get returns null for unknown channel', async () => {
      expect(await store.getChannelSession('nope')).toBeNull();
    });

    it('set overwrites existing session', async () => {
      await store.setChannelSession('ch1', 'sess-1');
      await store.setChannelSession('ch1', 'sess-2');
      expect(await store.getChannelSession('ch1')).toBe('sess-2');
    });

    it('clear removes the session', async () => {
      await store.setChannelSession('ch1', 'sess-1');
      await store.clearChannelSession('ch1');
      expect(await store.getChannelSession('ch1')).toBeNull();
    });

    it('getAllChannelSessions returns all mappings', async () => {
      await store.setChannelSession('ch1', 's1');
      await store.setChannelSession('ch2', 's2');
      const all = await store.getAllChannelSessions();
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          { channelId: 'ch1', sessionId: 's1' },
          { channelId: 'ch2', sessionId: 's2' },
        ]),
      );
    });
  });

  // ---- Preferences CRUD ---------------------------------------------------

  describe('preferences', () => {
    it('get returns null when no prefs set', async () => {
      expect(await store.getChannelPrefs('ch1')).toBeNull();
    });

    it('set and get prefs round-trip', async () => {
      await store.setChannelPrefs('ch1', { model: 'gpt-4' });
      const prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.model).toBe('gpt-4');
    });

    it('partial updates merge correctly', async () => {
      await store.setChannelPrefs('ch1', { model: 'gpt-4' });
      await store.setChannelPrefs('ch1', { verbose: true });
      const prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.model).toBe('gpt-4');
      expect(prefs?.verbose).toBe(true);
    });

    it('boolean fields round-trip correctly', async () => {
      await store.setChannelPrefs('ch1', { verbose: false, threadedReplies: true });
      const prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.verbose).toBe(false);
      expect(prefs?.threadedReplies).toBe(true);
    });

    it('disabledSkills array serialization/deserialization', async () => {
      await store.setChannelPrefs('ch1', { disabledSkills: ['skill-a', 'skill-b'] });
      const prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.disabledSkills).toEqual(['skill-a', 'skill-b']);
    });

    it('provider field stores and retrieves null correctly', async () => {
      await store.setChannelPrefs('ch1', { provider: 'openai' });
      let prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.provider).toBe('openai');

      await store.setChannelPrefs('ch1', { provider: null });
      prefs = await store.getChannelPrefs('ch1');
      expect(prefs?.provider).toBeNull();
    });
  });

  // ---- Permissions --------------------------------------------------------

  describe('permissions', () => {
    it('add and get rules', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      const rules = await store.getPermissionRules('global', 'bash');
      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('allow');
      expect(rules[0].commandPattern).toBe('*');
    });

    it('checkPermission wildcard matching', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      expect(await store.checkPermission('global', 'bash', 'ls -la')).toBe('allow');
    });

    it('checkPermission exact match', async () => {
      await store.addPermissionRule('global', 'bash', 'rm -rf /', 'deny');
      expect(await store.checkPermission('global', 'bash', 'rm -rf /')).toBe('deny');
    });

    it('checkPermission returns null when no match', async () => {
      await store.addPermissionRule('global', 'bash', 'specific-cmd', 'allow');
      expect(await store.checkPermission('global', 'bash', 'other-cmd')).toBeNull();
    });

    it('addPermissionRule replaces existing rule for same scope+tool+pattern', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      await store.addPermissionRule('global', 'bash', '*', 'deny');
      const rules = await store.getPermissionRules('global', 'bash');
      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('deny');
    });

    it('clearPermissionRules removes all rules for a scope', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      await store.addPermissionRule('global', 'edit', '*', 'allow');
      await store.clearPermissionRules('global');
      expect(await store.listPermissionRulesForScope('global')).toHaveLength(0);
    });

    it('removePermissionRule removes a single rule', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      const removed = await store.removePermissionRule('global', 'bash', '*');
      expect(removed).toBe(true);
      expect(await store.getPermissionRules('global', 'bash')).toHaveLength(0);
    });

    it('removePermissionRule returns false when no match', async () => {
      const removed = await store.removePermissionRule('global', 'bash', 'nope');
      expect(removed).toBe(false);
    });

    it('listPermissionRulesForScope returns only that scope', async () => {
      await store.addPermissionRule('global', 'bash', '*', 'allow');
      await store.addPermissionRule('channel:ch1', 'bash', '*', 'deny');
      const globalRules = await store.listPermissionRulesForScope('global');
      expect(globalRules).toHaveLength(1);
      expect(globalRules[0].scope).toBe('global');
    });
  });

  // ---- Workspaces ---------------------------------------------------------

  describe('workspaces', () => {
    it('set and get workspace override', async () => {
      await store.setWorkspaceOverride('bot1', '/home/bot1');
      const ws = await store.getWorkspaceOverride('bot1');
      expect(ws).not.toBeNull();
      expect(ws!.botName).toBe('bot1');
      expect(ws!.workingDirectory).toBe('/home/bot1');
    });

    it('get returns null for unknown bot', async () => {
      expect(await store.getWorkspaceOverride('nope')).toBeNull();
    });

    it('allowPaths JSON serialization', async () => {
      await store.setWorkspaceOverride('bot1', '/home/bot1', ['/data', '/logs']);
      const ws = await store.getWorkspaceOverride('bot1');
      expect(ws!.allowPaths).toEqual(['/data', '/logs']);
    });

    it('allowPaths defaults to empty array', async () => {
      await store.setWorkspaceOverride('bot1', '/home/bot1');
      const ws = await store.getWorkspaceOverride('bot1');
      expect(ws!.allowPaths).toEqual([]);
    });

    it('remove workspace override', async () => {
      await store.setWorkspaceOverride('bot1', '/home/bot1');
      await store.removeWorkspaceOverride('bot1');
      expect(await store.getWorkspaceOverride('bot1')).toBeNull();
    });

    it('list workspace overrides', async () => {
      await store.setWorkspaceOverride('bot1', '/home/bot1');
      await store.setWorkspaceOverride('bot2', '/home/bot2');
      const all = await store.listWorkspaceOverrides();
      expect(all).toHaveLength(2);
    });

    it('set upserts on conflict', async () => {
      await store.setWorkspaceOverride('bot1', '/old');
      await store.setWorkspaceOverride('bot1', '/new', ['/extra']);
      const ws = await store.getWorkspaceOverride('bot1');
      expect(ws!.workingDirectory).toBe('/new');
      expect(ws!.allowPaths).toEqual(['/extra']);
    });
  });

  // ---- Settings -----------------------------------------------------------

  describe('settings', () => {
    it('set and get global setting', async () => {
      await store.setGlobalSetting('key1', 'value1');
      expect(await store.getGlobalSetting('key1')).toBe('value1');
    });

    it('get returns null for unknown key', async () => {
      expect(await store.getGlobalSetting('missing')).toBeNull();
    });

    it('upsert overwrites existing value', async () => {
      await store.setGlobalSetting('key1', 'old');
      await store.setGlobalSetting('key1', 'new');
      expect(await store.getGlobalSetting('key1')).toBe('new');
    });
  });

  // ---- Dynamic Channels ---------------------------------------------------

  describe('dynamic channels', () => {
    const baseChannel = {
      channelId: 'dc1',
      platform: 'mattermost',
      name: 'test-channel',
      workingDirectory: '/work',
      isDM: false,
    };

    it('add and get dynamic channel', async () => {
      await store.addDynamicChannel(baseChannel);
      const ch = await store.getDynamicChannel('dc1');
      expect(ch).not.toBeNull();
      expect(ch!.channelId).toBe('dc1');
      expect(ch!.platform).toBe('mattermost');
      expect(ch!.name).toBe('test-channel');
      expect(ch!.workingDirectory).toBe('/work');
    });

    it('get returns null for unknown channel', async () => {
      expect(await store.getDynamicChannel('nope')).toBeNull();
    });

    it('remove dynamic channel', async () => {
      await store.addDynamicChannel(baseChannel);
      await store.removeDynamicChannel('dc1');
      expect(await store.getDynamicChannel('dc1')).toBeNull();
    });

    it('list dynamic channels', async () => {
      await store.addDynamicChannel(baseChannel);
      await store.addDynamicChannel({ ...baseChannel, channelId: 'dc2', name: 'second' });
      const all = await store.getDynamicChannels();
      expect(all).toHaveLength(2);
    });

    it('boolean fields map correctly', async () => {
      await store.addDynamicChannel({
        ...baseChannel,
        isDM: true,
        verbose: true,
        threadedReplies: false,
      });
      const ch = await store.getDynamicChannel('dc1');
      expect(ch!.isDM).toBe(true);
      expect(ch!.verbose).toBe(true);
      expect(ch!.threadedReplies).toBe(false);
    });

    it('optional fields default correctly', async () => {
      await store.addDynamicChannel(baseChannel);
      const ch = await store.getDynamicChannel('dc1');
      expect(ch!.bot).toBeUndefined();
      expect(ch!.agent).toBeNull();
      expect(ch!.model).toBeUndefined();
      expect(ch!.verbose).toBeUndefined();
      expect(ch!.threadedReplies).toBeUndefined();
    });
  });

  // ---- Scheduled Tasks ----------------------------------------------------

  describe('scheduled tasks', () => {
    const baseTask = {
      id: 'task-1',
      channelId: 'ch1',
      botName: 'bot1',
      prompt: 'do something',
      timezone: 'UTC',
      enabled: true,
    };

    it('insert and get task', async () => {
      await store.insertScheduledTask(baseTask);
      const task = await store.getScheduledTask('task-1');
      expect(task).not.toBeNull();
      expect(task!.id).toBe('task-1');
      expect(task!.prompt).toBe('do something');
      expect(task!.enabled).toBe(true);
    });

    it('get returns null for unknown task', async () => {
      expect(await store.getScheduledTask('nope')).toBeNull();
    });

    it('list tasks for channel', async () => {
      await store.insertScheduledTask(baseTask);
      await store.insertScheduledTask({ ...baseTask, id: 'task-2', channelId: 'ch2' });
      const tasks = await store.getScheduledTasksForChannel('ch1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-1');
    });

    it('getEnabledScheduledTasks filters disabled tasks', async () => {
      await store.insertScheduledTask(baseTask);
      await store.insertScheduledTask({ ...baseTask, id: 'task-2', enabled: false });
      const enabled = await store.getEnabledScheduledTasks();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe('task-1');
    });

    it('updateScheduledTaskEnabled toggles enabled flag', async () => {
      await store.insertScheduledTask(baseTask);
      await store.updateScheduledTaskEnabled('task-1', false);
      const task = await store.getScheduledTask('task-1');
      expect(task!.enabled).toBe(false);
    });

    it('updateScheduledTaskLastRun sets timestamps', async () => {
      await store.insertScheduledTask(baseTask);
      const now = new Date().toISOString();
      const next = new Date(Date.now() + 3600_000).toISOString();
      await store.updateScheduledTaskLastRun('task-1', now, next);
      const task = await store.getScheduledTask('task-1');
      expect(task!.lastRun).toBe(now);
      expect(task!.nextRun).toBe(next);
    });

    it('deleteScheduledTask removes the task', async () => {
      await store.insertScheduledTask(baseTask);
      await store.deleteScheduledTask('task-1');
      expect(await store.getScheduledTask('task-1')).toBeNull();
    });

    it('task with cronExpr and nextRun round-trips', async () => {
      const cronTask = { ...baseTask, cronExpr: '0 * * * *', nextRun: '2025-01-01T01:00:00Z' };
      await store.insertScheduledTask(cronTask);
      const task = await store.getScheduledTask('task-1');
      expect(task!.cronExpr).toBe('0 * * * *');
      expect(task!.nextRun).toBe('2025-01-01T01:00:00Z');
    });
  });

  // ---- Task History -------------------------------------------------------

  describe('task history', () => {
    it('insert and get history entry', async () => {
      await store.insertTaskHistory({
        taskId: 'task-1',
        channelId: 'ch1',
        prompt: 'do something',
        timezone: 'UTC',
        status: 'success',
      });
      const history = await store.getTaskHistory('ch1');
      expect(history).toHaveLength(1);
      expect(history[0].taskId).toBe('task-1');
      expect(history[0].status).toBe('success');
      expect(history[0].firedAt).toBeDefined();
    });

    it('error entry stores error message', async () => {
      await store.insertTaskHistory({
        taskId: 'task-1',
        channelId: 'ch1',
        prompt: 'fail',
        timezone: 'UTC',
        status: 'error',
        error: 'something broke',
      });
      const history = await store.getTaskHistory('ch1');
      expect(history[0].status).toBe('error');
      expect(history[0].error).toBe('something broke');
    });

    it('getTaskHistory respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.insertTaskHistory({
          taskId: `task-${i}`,
          channelId: 'ch1',
          prompt: `prompt-${i}`,
          timezone: 'UTC',
          status: 'success',
        });
      }
      const history = await store.getTaskHistory('ch1', 3);
      expect(history).toHaveLength(3);
    });
  });

  // ---- Error handling -----------------------------------------------------

  describe('error handling', () => {
    it('operations on uninitialized store throw', async () => {
      const uninit = new SqliteStateStore(path.join(tmpDir, 'never-init.db'));
      await expect(uninit.getChannelSession('ch1')).rejects.toThrow(/not initialized/i);
      await expect(uninit.setChannelPrefs('ch1', {})).rejects.toThrow(/not initialized/i);
      await expect(uninit.getGlobalSetting('k')).rejects.toThrow(/not initialized/i);
    });
  });
});
