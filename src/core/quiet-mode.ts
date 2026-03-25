/**
 * Quiet mode — suppresses all streaming output until we determine whether
 * a response is NO_REPLY. Used for scheduled tasks and silent cron jobs.
 */
import { createLogger } from '../logger.js';

const log = createLogger('quiet');

export interface QuietState {
  timeout: ReturnType<typeof setTimeout>;  // 60s safety net
}

const TIMEOUT_MS = 60_000;

const state = new Map<string, QuietState>();

/** Enter quiet mode for a channel. Returns cleanup function for catch paths. */
export function enterQuietMode(channelId: string): () => void {
  const prev = state.get(channelId);
  if (prev) clearTimeout(prev.timeout);

  const timeout = setTimeout(() => {
    log.warn(`Quiet mode timeout (60s) for channel ${channelId.slice(0, 8)}... — force-clearing`);
    state.delete(channelId);
  }, TIMEOUT_MS);

  state.set(channelId, { timeout });
  return () => {
    const qs = state.get(channelId);
    if (qs) { clearTimeout(qs.timeout); state.delete(channelId); }
  };
}

/** Exit quiet mode, cleaning up timer. */
export function exitQuietMode(channelId: string): void {
  const qs = state.get(channelId);
  if (qs) { clearTimeout(qs.timeout); state.delete(channelId); }
}

/** Get the quiet state for a channel (undefined if not in quiet mode). */
export function getQuietState(channelId: string): QuietState | undefined {
  return state.get(channelId);
}

/** Check if a channel is in quiet mode. */
export function isQuiet(channelId: string): boolean {
  return state.has(channelId);
}

/** Reset all quiet state — for tests only. */
export function _resetForTest(): void {
  for (const qs of state.values()) clearTimeout(qs.timeout);
  state.clear();
}
