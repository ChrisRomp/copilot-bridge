/**
 * Per-workspace async mutex for MEMORY.md writes.
 *
 * Prevents concurrent writes from consolidation, compaction merge, and other
 * background operations. Agent file tool writes are NOT locked (the SDK
 * serializes tool calls per session).
 *
 * On contention, callers can choose to yield (skip this cycle) rather than
 * block, using tryAcquire().
 */

import { createLogger } from '../logger.js';
const log = createLogger('workspace-lock');

interface LockEntry {
  release: () => void;
  promise: Promise<void>;
}

const locks = new Map<string, Promise<void>>();

/**
 * Acquire exclusive write access for a workspace path.
 * Blocks until the lock is available.
 * Returns a release function — call it when done writing.
 */
export async function acquireWorkspaceLock(workspacePath: string): Promise<() => void> {
  while (locks.has(workspacePath)) {
    await locks.get(workspacePath);
  }

  let released = false;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      locks.delete(workspacePath);
      log.debug(`Lock released: ${workspacePath}`);
      resolve();
    };
  });

  locks.set(workspacePath, promise);
  log.debug(`Lock acquired: ${workspacePath}`);
  return release;
}

/**
 * Try to acquire the lock without waiting.
 * Returns the release function if acquired, or null if the lock is held.
 * Use this for background operations that should yield on contention.
 */
export function tryAcquireWorkspaceLock(workspacePath: string): (() => void) | null {
  if (locks.has(workspacePath)) {
    log.debug(`Lock contention (skipping): ${workspacePath}`);
    return null;
  }

  let released = false;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      locks.delete(workspacePath);
      log.debug(`Lock released: ${workspacePath}`);
      resolve();
    };
  });

  locks.set(workspacePath, promise);
  log.debug(`Lock acquired (try): ${workspacePath}`);
  return release;
}

/** Check if a workspace lock is currently held. */
export function isWorkspaceLocked(workspacePath: string): boolean {
  return locks.has(workspacePath);
}

/** Reset all locks (for testing). */
export function _resetLocksForTest(): void {
  locks.clear();
}
