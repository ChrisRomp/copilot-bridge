import { createLogger } from '../../logger.js';
import type { SessionEvent } from '@github/copilot-sdk';

const log = createLogger('run-registry');

export type RunStatus = 'created' | 'in_progress' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type StoredRunSessionEvent = SessionEvent | ({ type: 'bridge.permission_request'; data?: Record<string, unknown> } & Record<string, unknown>);

export interface RunEntry {
  runId: string;
  bot: string;
  channelId: string;
  sdkSessionId?: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  sessionEvents?: StoredRunSessionEvent[];
  emitter?: (event: any) => void;
}

export class RunRegistry {
  private entries = new Map<string, RunEntry>();
  private activeRunByChannel = new Map<string, string>();

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

  updateSdkSessionId(runId: string, sdkSessionId: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry) return false;

    entry.sdkSessionId = sdkSessionId;
    log.debug('Updated run SDK session ID', { runId });
    return true;
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

  updateActiveRunFromSessionEvent(channelId: string, event: StoredRunSessionEvent): boolean {
    const entry = this.getActiveRun(channelId);
    if (!entry) return false;
    (entry.sessionEvents ??= []).push(event);

    if (event.type === 'session.idle') {
      return this.updateStatus(entry.runId, 'completed', { finishedAt: new Date().toISOString() });
    }
    if (event.type === 'session.error') {
      const data = event.data as unknown as Record<string, unknown> | undefined;
      const error = typeof data?.message === 'string'
        ? data.message
        : String(data?.error ?? 'session error');
      return this.updateStatus(entry.runId, 'failed', { error, finishedAt: new Date().toISOString() });
    }
    if (event.type === 'bridge.permission_request') {
      return this.updateStatus(entry.runId, 'awaiting');
    }
    if (entry.status === 'created') {
      return this.updateStatus(entry.runId, 'in_progress');
    }
    return false;
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
