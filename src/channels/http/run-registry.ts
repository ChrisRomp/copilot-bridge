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
  emitter?: (event: any) => void;
}

type CancellationSuppression = {
  expiresAt: number;
  cleanupQueued?: boolean;
};

const CANCELLATION_SUPPRESSION_TTL_MS = 30_000;

export class RunRegistry {
  private entries = new Map<string, RunEntry>();
  private activeRunByChannel = new Map<string, string>();
  private cancellationSuppressions = new Map<string, CancellationSuppression>();

  register(runId: string, entry: Omit<RunEntry, 'runId' | 'createdAt'>): RunEntry {
    const runEntry: RunEntry = {
      ...entry,
      runId,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(runId, runEntry);
    this.activeRunByChannel.set(runEntry.channelId, runId);
    log.debug('Registered run', { runId, bot: runEntry.bot, channelId: runEntry.channelId });
    return runEntry;
  }

  get(runId: string): RunEntry | undefined {
    return this.entries.get(runId);
  }

  setEmitter(runId: string, emit: (event: any) => void): void {
    const entry = this.entries.get(runId);
    if (entry) entry.emitter = emit;
  }

  getEmitter(runId: string): ((event: any) => void) | undefined {
    return this.entries.get(runId)?.emitter;
  }

  updateStatus(runId: string, status: RunStatus, extra?: { error?: string; finishedAt?: string }): boolean {
    const entry = this.entries.get(runId);
    if (!entry) return false;

    entry.status = status;
    if (extra?.error !== undefined) entry.error = extra.error;
    if (extra?.finishedAt !== undefined) entry.finishedAt = extra.finishedAt;
    if (isTerminalStatus(status) && this.activeRunByChannel.get(entry.channelId) === runId) {
      this.activeRunByChannel.delete(entry.channelId);
    }
    log.debug('Updated run status', { runId, status });
    return true;
  }

  unregister(runId: string): boolean {
    const entry = this.entries.get(runId);
    const removed = this.entries.delete(runId);
    if (removed && entry && this.activeRunByChannel.get(entry.channelId) === runId) {
      this.activeRunByChannel.delete(entry.channelId);
    }
    if (removed) log.debug('Unregistered run', { runId });
    return removed;
  }

  all(): RunEntry[] {
    return Array.from(this.entries.values());
  }

  getActiveRun(channelId: string): RunEntry | undefined {
    const runId = this.activeRunByChannel.get(channelId);
    return runId ? this.entries.get(runId) : undefined;
  }

  getNonTerminalActiveRun(channelId: string): RunEntry | undefined {
    const entry = this.getActiveRun(channelId);
    return entry && !isTerminalStatus(entry.status) ? entry : undefined;
  }

  isActiveRun(runId: string): boolean {
    const entry = this.entries.get(runId);
    return entry ? this.activeRunByChannel.get(entry.channelId) === runId : false;
  }

  recordCancellationSuppression(runId: string, channelId: string): void {
    this.pruneCancellationSuppressions();
    this.cancellationSuppressions.set(this.suppressionKey(runId, channelId), {
      expiresAt: Date.now() + CANCELLATION_SUPPRESSION_TTL_MS,
    });
  }

  shouldSuppressCancellationTerminal(runId: string, channelId: string, event: { type?: string }): boolean {
    if (event.type !== 'session.error') {
      return false;
    }

    this.pruneCancellationSuppressions();
    const key = this.suppressionKey(runId, channelId);
    const suppression = this.cancellationSuppressions.get(key);
    if (!suppression) {
      return false;
    }

    if (!suppression.cleanupQueued) {
      suppression.cleanupQueued = true;
      queueMicrotask(() => {
        this.cancellationSuppressions.delete(key);
      });
    }
    return true;
  }

  private suppressionKey(runId: string, channelId: string): string {
    return `${channelId}\0${runId}`;
  }

  private pruneCancellationSuppressions(): void {
    const now = Date.now();
    for (const [key, suppression] of this.cancellationSuppressions) {
      if (suppression.expiresAt <= now) {
        this.cancellationSuppressions.delete(key);
      }
    }
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
