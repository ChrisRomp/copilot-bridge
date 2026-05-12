import { createLogger } from '../../logger.js';

const log = createLogger('run-registry');

export type RunStatus = 'created' | 'in_progress' | 'awaiting' | 'completed' | 'failed' | 'cancelled';

export interface RunEntry {
  runId: string;
  bot: string;
  channelId: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

export class RunRegistry {
  private entries = new Map<string, RunEntry>();

  register(runId: string, entry: Omit<RunEntry, 'runId' | 'createdAt'>): RunEntry {
    const runEntry: RunEntry = {
      ...entry,
      runId,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(runId, runEntry);
    log.debug('Registered run', { runId, bot: runEntry.bot, channelId: runEntry.channelId });
    return runEntry;
  }

  get(runId: string): RunEntry | undefined {
    return this.entries.get(runId);
  }

  updateStatus(runId: string, status: RunStatus, extra?: { error?: string; finishedAt?: string }): boolean {
    const entry = this.entries.get(runId);
    if (!entry) return false;

    entry.status = status;
    if (extra?.error !== undefined) entry.error = extra.error;
    if (extra?.finishedAt !== undefined) entry.finishedAt = extra.finishedAt;
    log.debug('Updated run status', { runId, status });
    return true;
  }

  unregister(runId: string): boolean {
    const removed = this.entries.delete(runId);
    if (removed) log.debug('Unregistered run', { runId });
    return removed;
  }

  all(): RunEntry[] {
    return Array.from(this.entries.values());
  }
}
