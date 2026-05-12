import type { PermissionHandler, PermissionRequestResult } from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';
import type { PendingPermissionStore, AcpPermissionDecision } from './pending-permission-store.js';
import type { PermissionStore } from './permission-store.js';

const log = createLogger('acp-permission-handler');
const PERMISSION_TIMEOUT_MS = 300000;
const APPROVED = { kind: 'approved' } as unknown as PermissionRequestResult;
const DENIED = { kind: 'denied-by-rules', rules: [] } as unknown as PermissionRequestResult;

export function createAcpPermissionHandler(
  runIdRef: { current: string },
  permissionStore: PermissionStore,
  pendingPermissionStore: PendingPermissionStore,
  getEmitter: (runId: string) => ((event: any) => void) | undefined,
): PermissionHandler {
  return async (request, invocation) => {
    if (permissionStore.shouldApprove(invocation.sessionId, request.kind)) {
      return APPROVED;
    }

    const runId = runIdRef.current;
    const detail = JSON.stringify(request);
    getEmitter(runId)?.({
      type: 'run.awaiting',
      data: {
        run_id: runId,
        tool: request.kind,
        detail,
      },
    });

    const decision = await waitForDecision(
      pendingPermissionStore,
      runId,
      request.kind,
      detail,
    );

    if (decision === 'timeout') {
      log.warn('Permission request timed out', { runId, tool: request.kind });
      pendingPermissionStore.clear(runId);
      return DENIED;
    }

    return isApprovedDecision(decision) ? APPROVED : DENIED;
  };
}

async function waitForDecision(
  pendingPermissionStore: PendingPermissionStore,
  runId: string,
  toolKind: string,
  detail: string,
): Promise<AcpPermissionDecision | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pendingPermissionStore.park(runId, { toolKind, detail }),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), PERMISSION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isApprovedDecision(decision: AcpPermissionDecision): boolean {
  return decision === 'allow-once'
    || decision === 'allow-session'
    || decision === 'allow-all-session'
    || decision === 'allow-all';
}
