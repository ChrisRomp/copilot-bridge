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
});
