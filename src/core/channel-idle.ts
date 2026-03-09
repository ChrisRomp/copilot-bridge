/**
 * Channel idle waiter — holds callers until a channel's session goes idle.
 *
 * Used to keep channelLocks held during the full response cycle so queued
 * work (scheduler, next user message) doesn't start a new stream while
 * events from the current turn are still being delivered.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Channels currently processing a response
const busyChannels = new Set<string>();

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

// Per-channel waiters with their timeout handles
const idleWaiters = new Map<string, Waiter[]>();

/** Mark a channel as busy (processing a response). */
export function markBusy(channelId: string): void {
  busyChannels.add(channelId);
}

/** Check if a channel is busy. */
export function isBusy(channelId: string): boolean {
  return busyChannels.has(channelId);
}

/**
 * Returns a promise that resolves when the channel becomes idle.
 * Resolves immediately if the channel is not currently busy.
 */
export function waitForChannelIdle(channelId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (!busyChannels.has(channelId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiters = idleWaiters.get(channelId) ?? [];
    const timer = setTimeout(() => {
      resolve();
      const remaining = idleWaiters.get(channelId);
      if (remaining) {
        const idx = remaining.findIndex(w => w.resolve === resolve);
        if (idx >= 0) remaining.splice(idx, 1);
        if (remaining.length === 0) idleWaiters.delete(channelId);
      }
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    waiters.push({ resolve, timer });
    idleWaiters.set(channelId, waiters);
  });
}

/**
 * Mark a channel as idle and resolve all waiters.
 * Called when session.idle or an error event fires.
 */
export function markIdle(channelId: string): void {
  busyChannels.delete(channelId);
  const waiters = idleWaiters.get(channelId);
  if (waiters) {
    for (const { resolve, timer } of waiters) {
      clearTimeout(timer);
      resolve();
    }
    idleWaiters.delete(channelId);
  }
}

/** Reset all state (for testing). */
export function _resetForTest(): void {
  for (const waiters of idleWaiters.values()) {
    for (const { timer } of waiters) clearTimeout(timer);
  }
  busyChannels.clear();
  idleWaiters.clear();
}
