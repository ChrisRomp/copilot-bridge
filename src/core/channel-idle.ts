/**
 * Channel idle waiter — holds callers until a channel's session goes idle.
 *
 * Used to keep channelLocks held during the full response cycle so queued
 * work (scheduler, next user message) doesn't start a new stream while
 * events from the current turn are still being delivered.
 *
 * session.idle fires prematurely between subagent dispatches, so markIdle
 * is debounced: we wait IDLE_DEBOUNCE_MS after the last session.idle before
 * truly releasing. If new events arrive (cancelIdleDebounce), the timer
 * resets and the channel stays busy.
 */

import { createLogger } from '../logger.js';
const log = createLogger('channel-idle');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_DEBOUNCE_MS = 2_000; // 2 seconds after last session.idle

// Channels currently processing a response
const busyChannels = new Set<string>();

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

// Per-channel waiters with their timeout handles
const idleWaiters = new Map<string, Waiter[]>();

// Per-channel debounce timers for session.idle
const idleDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mark a channel as busy (processing a response). */
export function markBusy(channelId: string): void {
  cancelIdleDebounce(channelId);
  busyChannels.add(channelId);
}

/** Check if a channel is busy. */
export function isBusy(channelId: string): boolean {
  return busyChannels.has(channelId);
}

/**
 * Cancel any pending idle debounce for a channel.
 * Call when new events arrive that indicate the session is still active.
 */
export function cancelIdleDebounce(channelId: string): void {
  const existing = idleDebounceTimers.get(channelId);
  if (existing) {
    clearTimeout(existing);
    idleDebounceTimers.delete(channelId);
  }
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
      log.warn(`Channel ${channelId.slice(0, 8)}... idle waiter timed out after ${timeoutMs}ms`);
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

/** Internal: truly release the channel and resolve all waiters. */
function releaseChannel(channelId: string): void {
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

/**
 * Schedule a debounced idle release. If no new events arrive within
 * IDLE_DEBOUNCE_MS, the channel is truly marked idle and waiters resolve.
 * Call this on session.idle events.
 */
export function markIdle(channelId: string): void {
  if (!busyChannels.has(channelId)) return;
  cancelIdleDebounce(channelId);
  const timer = setTimeout(() => {
    idleDebounceTimers.delete(channelId);
    log.debug(`Channel ${channelId.slice(0, 8)}... debounce expired, releasing`);
    releaseChannel(channelId);
  }, IDLE_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  idleDebounceTimers.set(channelId, timer);
}

/**
 * Immediately release the channel without debounce.
 * Use for error events and explicit session teardown (/new, /stop).
 */
export function markIdleImmediate(channelId: string): void {
  cancelIdleDebounce(channelId);
  releaseChannel(channelId);
}

/** Reset all state (for testing). */
export function _resetForTest(): void {
  for (const waiters of idleWaiters.values()) {
    for (const { timer } of waiters) clearTimeout(timer);
  }
  for (const timer of idleDebounceTimers.values()) clearTimeout(timer);
  busyChannels.clear();
  idleWaiters.clear();
  idleDebounceTimers.clear();
}
