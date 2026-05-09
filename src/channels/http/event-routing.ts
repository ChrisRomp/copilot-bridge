import type { AgentHarnessAdapter, SdkEvent } from './harness.js';
import type { SseManager } from './sse.js';
import type { ICardStore, Run } from './store.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface HttpEventRouteDeps {
  store: Pick<ICardStore, 'getCard' | 'listRunsForCard'>;
  harness: Pick<AgentHarnessAdapter, 'handleSdkEvent'>;
  sseManager: Pick<SseManager, 'emit'>;
}

export async function routeHttpSessionEvent(
  channelId: string,
  event: SdkEvent,
  deps: HttpEventRouteDeps,
): Promise<boolean> {
  const cardId = await resolveHttpCardId(channelId, deps.store);
  if (!cardId) {
    return false;
  }

  const runId = await resolveActiveRunId(cardId, deps.store);
  if (!runId) {
    return false;
  }

  const sseEvent = await deps.harness.handleSdkEvent(cardId, runId, event);
  if (sseEvent) {
    deps.sseManager.emit(cardId, runId, sseEvent);
  }

  return true;
}

export async function resolveHttpCardId(
  channelId: string,
  store: Pick<ICardStore, 'getCard'>,
): Promise<string | null> {
  const card = await store.getCard(channelId);
  return card?.id ?? null;
}

export async function resolveActiveRunId(
  cardId: string,
  store: Pick<ICardStore, 'listRunsForCard'>,
): Promise<string | null> {
  return selectActiveRunId(await store.listRunsForCard(cardId));
}

export function selectActiveRunId(
  runs: Array<Pick<Run, 'id' | 'status'>>,
): string | null {
  return [...runs]
    .reverse()
    .find((run) => !TERMINAL_RUN_STATUSES.has(run.status))?.id ?? null;
}
