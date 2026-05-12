import { createLogger } from '../../logger.js';

const log = createLogger('permission-store');

export class PermissionStore {
  private approveAllSessions = new Map<string, boolean>();
  private toolApprovals = new Map<string, Set<string>>();

  shouldApprove(sessionId: string, toolKind: string): boolean {
    if (this.approveAllSessions.has(sessionId)) return true;
    return this.toolApprovals.get(sessionId)?.has(toolKind) ?? false;
  }

  setApproveAll(sessionId: string): void {
    this.approveAllSessions.set(sessionId, true);
    log.debug('Approved all tools for session', { sessionId });
  }

  setApproveTool(sessionId: string, toolKind: string): void {
    let approvals = this.toolApprovals.get(sessionId);
    if (!approvals) {
      approvals = new Set<string>();
      this.toolApprovals.set(sessionId, approvals);
    }
    approvals.add(toolKind);
    log.debug('Approved tool for session', { sessionId, toolKind });
  }

  clearSession(sessionId: string): void {
    const removedApproveAll = this.approveAllSessions.delete(sessionId);
    const removedToolApprovals = this.toolApprovals.delete(sessionId);
    if (removedApproveAll || removedToolApprovals) {
      log.debug('Cleared permission approvals for session', { sessionId });
    }
  }
}
