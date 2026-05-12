import { describe, expect, it } from 'vitest';
import { PendingPermissionStore, type AcpPermissionDecision } from './pending-permission-store.js';

const decisions: AcpPermissionDecision[] = [
  'allow-once',
  'allow-session',
  'allow-all-session',
  'allow-all',
  'deny',
];

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
};

describe('PendingPermissionStore', () => {
  it('park returns a promise that resolves when resolve is called', async () => {
    const store = new PendingPermissionStore();
    const promise = store.park('run-1', { runId: 'run-1', toolKind: 'read' });

    expect(store.resolve('run-1', 'allow-once')).toBe(true);

    await expect(promise).resolves.toBe('allow-once');
  });

  it('resolve returns false for unknown runId', () => {
    const store = new PendingPermissionStore();

    expect(store.resolve('missing-run', 'deny')).toBe(false);
  });

  it('has returns true after park and false after resolve', () => {
    const store = new PendingPermissionStore();

    store.park('run-1', { runId: 'run-1', toolKind: 'read' });
    expect(store.has('run-1')).toBe(true);

    expect(store.resolve('run-1', 'allow-session')).toBe(true);
    expect(store.has('run-1')).toBe(false);
  });

  it('get returns metadata without the resolve function', () => {
    const store = new PendingPermissionStore();
    const before = Date.now();

    store.park('run-1', { runId: 'request-run-id', toolKind: 'read', detail: 'Read file' });
    const metadata = store.get('run-1');

    expect(metadata).toMatchObject({
      runId: 'run-1',
      toolKind: 'read',
      detail: 'Read file',
    });
    expect(metadata?.createdAt).toBeGreaterThanOrEqual(before);
    expect(metadata).not.toHaveProperty('resolve');
  });

  it('clear removes the entry without resolving the promise', async () => {
    const store = new PendingPermissionStore();
    let resolved = false;
    const promise = store.park('run-1', { runId: 'run-1', toolKind: 'read' });
    promise.then(() => {
      resolved = true;
    });

    store.clear('run-1');
    await flushMicrotasks();

    expect(store.has('run-1')).toBe(false);
    expect(resolved).toBe(false);
  });

  it.each(decisions)('resolve resolves the promise with %s', async (decision) => {
    const store = new PendingPermissionStore();
    const promise = store.park(`run-${decision}`, { runId: `run-${decision}`, toolKind: 'read' });

    expect(store.resolve(`run-${decision}`, decision)).toBe(true);

    await expect(promise).resolves.toBe(decision);
  });
});
