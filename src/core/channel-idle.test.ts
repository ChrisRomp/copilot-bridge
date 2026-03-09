import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { markBusy, markIdle, markIdleImmediate, isBusy, waitForChannelIdle, cancelIdleDebounce, _resetForTest } from './channel-idle.js';

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isBusy / markBusy / markIdleImmediate', () => {
  it('starts not busy', () => {
    expect(isBusy('ch1')).toBe(false);
  });

  it('marks busy and idle immediately', () => {
    markBusy('ch1');
    expect(isBusy('ch1')).toBe(true);
    markIdleImmediate('ch1');
    expect(isBusy('ch1')).toBe(false);
  });

  it('channels are independent', () => {
    markBusy('ch1');
    expect(isBusy('ch2')).toBe(false);
  });
});

describe('markIdle (debounced)', () => {
  it('does not release immediately', async () => {
    markBusy('ch1');
    markIdle('ch1');
    // Still busy during debounce window
    expect(isBusy('ch1')).toBe(true);
  });

  it('releases after debounce period', async () => {
    markBusy('ch1');
    markIdle('ch1');
    await vi.advanceTimersByTimeAsync(2500);
    expect(isBusy('ch1')).toBe(false);
  });

  it('cancelIdleDebounce prevents release', async () => {
    markBusy('ch1');
    markIdle('ch1');
    await vi.advanceTimersByTimeAsync(1000);
    cancelIdleDebounce('ch1');
    await vi.advanceTimersByTimeAsync(3000);
    // Still busy because debounce was cancelled
    expect(isBusy('ch1')).toBe(true);
  });

  it('new markBusy cancels pending debounce', async () => {
    markBusy('ch1');
    markIdle('ch1');
    await vi.advanceTimersByTimeAsync(1000);
    // Re-mark busy (simulates new event arriving)
    markBusy('ch1');
    await vi.advanceTimersByTimeAsync(3000);
    // Still busy because markBusy cancelled the debounce
    expect(isBusy('ch1')).toBe(true);
  });
});

describe('waitForChannelIdle', () => {
  it('resolves immediately when not busy', async () => {
    await waitForChannelIdle('ch1');
  });

  it('waits until markIdleImmediate is called', async () => {
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1').then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    markIdleImmediate('ch1');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it('waits until debounced markIdle completes', async () => {
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1').then(() => { resolved = true; });

    markIdle('ch1'); // Start debounce
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false); // Still in debounce window

    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(resolved).toBe(true);
  });

  it('debounce reset delays waiter resolution', async () => {
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1').then(() => { resolved = true; });

    markIdle('ch1');
    await vi.advanceTimersByTimeAsync(1500);
    cancelIdleDebounce('ch1'); // Cancel debounce (new event arrived)
    markIdle('ch1'); // New idle event
    await vi.advanceTimersByTimeAsync(1500);
    expect(resolved).toBe(false); // Still in second debounce

    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves multiple waiters on same channel', async () => {
    markBusy('ch1');
    let count = 0;
    const p1 = waitForChannelIdle('ch1').then(() => { count++; });
    const p2 = waitForChannelIdle('ch1').then(() => { count++; });
    const p3 = waitForChannelIdle('ch1').then(() => { count++; });

    markIdleImmediate('ch1');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([p1, p2, p3]);
    expect(count).toBe(3);
  });

  it('resolves on timeout if markIdle never called', async () => {
    markBusy('ch1');
    let resolved = false;
    const p = waitForChannelIdle('ch1', 100).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(resolved).toBe(true);
    expect(isBusy('ch1')).toBe(true); // timeout doesn't clear busy
  });

  it('markIdle with no waiters is a no-op', () => {
    markIdle('ch1');
    expect(isBusy('ch1')).toBe(false);
  });
});
