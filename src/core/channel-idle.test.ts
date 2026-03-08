import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markBusy, markIdle, isBusy, waitForChannelIdle, _resetForTest } from './channel-idle.js';

beforeEach(() => {
  _resetForTest();
});

describe('isBusy / markBusy / markIdle', () => {
  it('starts not busy', () => {
    expect(isBusy('ch1')).toBe(false);
  });

  it('marks busy and idle', () => {
    markBusy('ch1');
    expect(isBusy('ch1')).toBe(true);
    markIdle('ch1');
    expect(isBusy('ch1')).toBe(false);
  });

  it('channels are independent', () => {
    markBusy('ch1');
    expect(isBusy('ch2')).toBe(false);
  });
});

describe('waitForChannelIdle', () => {
  it('resolves immediately when not busy', async () => {
    await waitForChannelIdle('ch1');
    // No assertion needed — would hang if broken
  });

  it('waits until markIdle is called', async () => {
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1').then(() => { resolved = true; });

    // Should not be resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    markIdle('ch1');
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves multiple waiters on same channel', async () => {
    markBusy('ch1');
    let count = 0;
    const p1 = waitForChannelIdle('ch1').then(() => { count++; });
    const p2 = waitForChannelIdle('ch1').then(() => { count++; });
    const p3 = waitForChannelIdle('ch1').then(() => { count++; });

    await Promise.resolve();
    expect(count).toBe(0);

    markIdle('ch1');
    await Promise.all([p1, p2, p3]);
    expect(count).toBe(3);
  });

  it('resolves on timeout if markIdle never called', async () => {
    vi.useFakeTimers();
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1', 100).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(resolved).toBe(true);

    // Channel is still marked busy (timeout doesn't clear it)
    expect(isBusy('ch1')).toBe(true);
    vi.useRealTimers();
  });

  it('markIdle before timeout cleans up', async () => {
    vi.useFakeTimers();
    markBusy('ch1');
    let resolveCount = 0;
    const p = waitForChannelIdle('ch1', 1000).then(() => { resolveCount++; });

    markIdle('ch1');
    await p;
    expect(resolveCount).toBe(1);

    // Advance past timeout — should not double-resolve
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolveCount).toBe(1);
    vi.useRealTimers();
  });

  it('markIdle with no waiters is a no-op', () => {
    markIdle('ch1'); // Should not throw
    expect(isBusy('ch1')).toBe(false);
  });

  it('second wait after idle resolves immediately', async () => {
    markBusy('ch1');
    markIdle('ch1');
    // Should resolve immediately since channel is no longer busy
    await waitForChannelIdle('ch1');
  });
});
