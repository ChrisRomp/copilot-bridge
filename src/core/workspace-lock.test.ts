import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireWorkspaceLock,
  tryAcquireWorkspaceLock,
  isWorkspaceLocked,
  _resetLocksForTest,
} from './workspace-lock.js';

describe('workspace-lock', () => {
  beforeEach(() => {
    _resetLocksForTest();
  });

  it('acquires and releases a lock', async () => {
    const release = await acquireWorkspaceLock('/tmp/ws1');
    expect(isWorkspaceLocked('/tmp/ws1')).toBe(true);
    release();
    expect(isWorkspaceLocked('/tmp/ws1')).toBe(false);
  });

  it('tryAcquire returns release function when unlocked', () => {
    const release = tryAcquireWorkspaceLock('/tmp/ws2');
    expect(release).not.toBeNull();
    expect(isWorkspaceLocked('/tmp/ws2')).toBe(true);
    release!();
    expect(isWorkspaceLocked('/tmp/ws2')).toBe(false);
  });

  it('tryAcquire returns null when locked', async () => {
    const release = await acquireWorkspaceLock('/tmp/ws3');
    expect(tryAcquireWorkspaceLock('/tmp/ws3')).toBeNull();
    release();
  });

  it('serializes concurrent acquires', async () => {
    const order: number[] = [];

    const release1 = await acquireWorkspaceLock('/tmp/ws4');
    order.push(1);

    // Second acquire should block until first releases
    const p2 = acquireWorkspaceLock('/tmp/ws4').then((release) => {
      order.push(2);
      release();
    });

    // Give p2 a microtask to start waiting
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual([1]); // p2 should still be waiting

    release1();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('different workspaces do not contend', async () => {
    const releaseA = await acquireWorkspaceLock('/tmp/wsA');
    const releaseB = await acquireWorkspaceLock('/tmp/wsB');
    expect(isWorkspaceLocked('/tmp/wsA')).toBe(true);
    expect(isWorkspaceLocked('/tmp/wsB')).toBe(true);
    releaseA();
    releaseB();
  });

  it('isWorkspaceLocked returns false for unknown workspace', () => {
    expect(isWorkspaceLocked('/tmp/unknown')).toBe(false);
  });
});
