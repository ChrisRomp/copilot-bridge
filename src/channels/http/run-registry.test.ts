import { describe, expect, it } from 'vitest';
import { RunRegistry, type RunEntry } from './run-registry.js';

const entry: Omit<RunEntry, 'runId' | 'createdAt'> = {
  bot: 'bob',
  channelId: 'channel-1',
  status: 'created',
};

describe('RunRegistry', () => {
  it('register returns entry with runId and createdAt populated', () => {
    const registry = new RunRegistry();

    const registered = registry.register('run-1', entry);

    expect(registered).toMatchObject({
      ...entry,
      runId: 'run-1',
    });
    expect(registered.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(registered.createdAt))).toBe(false);
  });

  it('get returns undefined for unknown runId', () => {
    const registry = new RunRegistry();

    expect(registry.get('missing-run')).toBeUndefined();
  });

  it('get returns entry after register', () => {
    const registry = new RunRegistry();

    const registered = registry.register('run-1', entry);

    expect(registry.get('run-1')).toEqual(registered);
  });

  it('updateSdkSessionId stores the SDK session ID', () => {
    const registry = new RunRegistry();

    registry.register('run-1', entry);

    expect(registry.updateSdkSessionId('run-1', 'sdk-session-1')).toBe(true);
    expect(registry.get('run-1')?.sdkSessionId).toBe('sdk-session-1');
  });

  it('updateSdkSessionId returns false for unknown runId', () => {
    const registry = new RunRegistry();

    expect(registry.updateSdkSessionId('missing-run', 'sdk-session-1')).toBe(false);
  });

  it('updateStatus returns false for unknown runId', () => {
    const registry = new RunRegistry();

    expect(registry.updateStatus('missing-run', 'in_progress')).toBe(false);
  });

  it('updateStatus updates status field', () => {
    const registry = new RunRegistry();

    registry.register('run-1', entry);

    expect(registry.updateStatus('run-1', 'in_progress')).toBe(true);
    expect(registry.get('run-1')?.status).toBe('in_progress');
  });

  it('updateStatus with extra sets error and finishedAt', () => {
    const registry = new RunRegistry();
    const finishedAt = '2026-05-12T00:00:00.000Z';

    registry.register('run-1', entry);

    expect(registry.updateStatus('run-1', 'failed', { error: 'boom', finishedAt })).toBe(true);
    expect(registry.get('run-1')).toMatchObject({
      status: 'failed',
      error: 'boom',
      finishedAt,
    });
  });

  it('unregister removes entry and subsequent get returns undefined', () => {
    const registry = new RunRegistry();

    registry.register('run-1', entry);

    expect(registry.unregister('run-1')).toBe(true);
    expect(registry.get('run-1')).toBeUndefined();
  });

  it('setEmitter stores an emitter retrievable by getEmitter', () => {
    const registry = new RunRegistry();
    const emitter = () => undefined;

    registry.register('run-1', entry);
    registry.setEmitter('run-1', emitter);

    expect(registry.getEmitter('run-1')).toBe(emitter);
  });

  it('getEmitter returns undefined for an unknown runId', () => {
    const registry = new RunRegistry();

    registry.setEmitter('missing-run', () => undefined);

    expect(registry.getEmitter('missing-run')).toBeUndefined();
  });

  it('all returns all registered entries', () => {
    const registry = new RunRegistry();

    const first = registry.register('run-1', entry);
    const second = registry.register('run-2', {
      bot: 'alice',
      channelId: 'channel-2',
      status: 'awaiting',
    });

    expect(registry.all()).toEqual([first, second]);
  });

  it('register marks only the newest run for a reused channel as active', () => {
    const registry = new RunRegistry();

    const first = registry.register('run-1', { ...entry, sdkSessionId: 'sdk-session-1', status: 'completed' });
    const second = registry.register('run-2', { ...entry, sdkSessionId: 'sdk-session-1', status: 'created' });

    expect(first.channelId).toBe(second.channelId);
    expect(first.sdkSessionId).toBe(second.sdkSessionId);
    expect(registry.getActiveRun('channel-1')).toBe(second);
    expect(registry.isActiveRun('run-1')).toBe(false);
    expect(registry.isActiveRun('run-2')).toBe(true);
  });

  it('getNonTerminalActiveRun returns only active runs with nonterminal status', () => {
    const registry = new RunRegistry();

    registry.register('run-1', entry);
    expect(registry.getNonTerminalActiveRun('channel-1')?.runId).toBe('run-1');

    registry.updateStatus('run-1', 'completed', { finishedAt: '2026-05-12T00:00:00.000Z' });
    expect(registry.getNonTerminalActiveRun('channel-1')).toBeUndefined();
  });

  it('terminal status clears only the matching active run', () => {
    const registry = new RunRegistry();

    registry.register('run-1', { ...entry, sdkSessionId: 'sdk-session-1', status: 'completed' });
    const second = registry.register('run-2', { ...entry, sdkSessionId: 'sdk-session-1', status: 'created' });

    registry.updateStatus('run-1', 'failed', { error: 'late error' });
    expect(registry.getActiveRun('channel-1')).toBe(second);

    registry.updateStatus('run-2', 'completed', { finishedAt: '2026-05-12T00:00:00.000Z' });
    expect(registry.getActiveRun('channel-1')).toBeUndefined();
  });

  it('session events update only the active run for a reused channel and SDK session', () => {
    const registry = new RunRegistry();
    const originalFinishedAt = '2026-05-12T00:00:00.000Z';

    registry.register('run-1', {
      ...entry,
      sdkSessionId: 'sdk-session-1',
      status: 'completed',
      finishedAt: originalFinishedAt,
    });
    registry.register('run-2', { ...entry, sdkSessionId: 'sdk-session-1', status: 'created' });

    expect(registry.updateActiveRunFromSessionEvent('channel-1', { type: 'session.idle' } as import('@github/copilot-sdk').SessionEvent)).toBe(true);

    expect(registry.get('run-1')).toMatchObject({
      status: 'completed',
      finishedAt: originalFinishedAt,
    });
    expect(registry.get('run-2')).toMatchObject({
      status: 'completed',
      finishedAt: expect.any(String),
    });
    expect(registry.get('run-2')?.finishedAt).not.toBe(originalFinishedAt);
  });
});
