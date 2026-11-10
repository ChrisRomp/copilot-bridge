import type { PermissionHandler, PermissionRequest, SessionEvent } from '@github/copilot-sdk';

type Invocation = Parameters<PermissionHandler>[1];
type LegacyAssessment = NonNullable<Extract<PermissionRequest, { kind: 'memory' }>['assistedApproval']>;
type RequestedEvent = Extract<SessionEvent, { type: 'permission.requested' }>;
type CompletedEvent = Extract<SessionEvent, { type: 'permission.completed' }>;

export const ASSISTED_AUTOPILOT_NOTICE =
  'Assisted autopilot runs unattended. Copilot applies its runtime permission policy and safety review; requests requiring human approval are denied without prompting.';

/** Call only after bridge policy checks, when the channel preference is assisted. */
export function evaluateAssistedDecision(
  request: PermissionRequest,
  invocation: Invocation,
  unattended: boolean,
): { kind: 'approve' | 'prompt' | 'deny'; reason: string } {
  const fallback = (reason: string): { kind: 'prompt' | 'deny'; reason: string } => ({
    kind: unattended ? 'deny' : 'prompt',
    reason,
  });
  if (request.managedApprovalRequired ||
      (invocation.promptRequest && 'managedApprovalRequired' in invocation.promptRequest &&
       invocation.promptRequest.managedApprovalRequired)) {
    return fallback('Managed policy requires human approval.');
  }
  if (('requestSandboxBypass' in request && request.requestSandboxBypass) ||
      (invocation.promptRequest && 'requestSandboxBypass' in invocation.promptRequest &&
       invocation.promptRequest.requestSandboxBypass)) {
    return fallback('Sandbox escalation requires human approval.');
  }
  if (unattended && request.kind === 'hook') {
    return fallback('Hook confirmation requires human approval, which is unavailable in unattended mode.');
  }

  const assessment = invocation.assistedApprovalAssessment;
  if (assessment !== undefined) {
    // A canonical non-verdict must never resurrect an older legacy approval.
    const detail = 'reason' in assessment && assessment.reason.trim() ? `: ${assessment.reason.trim()}` : '';
    switch (assessment.status) {
      case 'completed':
        return assessment.recommendation === 'approve'
          ? { kind: 'approve', reason: assessment.rationale?.trim() || 'Safety review approved this request.' }
          : fallback(assessment.rationale?.trim() || 'Safety review requires human approval.');
      case 'failed':
        return fallback(`Safety review failed${detail}. Human approval is required.`);
      case 'excluded':
        return fallback(`Safety review excluded this request${detail}. Human approval is required.`);
      case 'not-run':
        return fallback(`Safety review did not run${detail}. Human approval is required.`);
      case 'unavailable':
        return fallback('Safety review is unavailable. Human approval is required.');
      default:
        return fallback('Safety review returned no usable assessment. Human approval is required.');
    }
  }

  // Older runtimes attached this optional property directly to other request
  // kinds too. Retain its exact SDK shape without casting the request broadly.
  const legacyRequest: PermissionRequest & { assistedApproval?: LegacyAssessment } = request;
  const legacy = legacyRequest.assistedApproval;
  switch (legacy?.recommendation) {
    case 'approve':
      return { kind: 'approve', reason: legacy.reason?.trim() || 'Safety review approved this request.' };
    case 'requireApproval':
      return fallback(legacy.reason?.trim() || 'Safety review requires human approval.');
    case 'excluded':
      return fallback(legacy.reason?.trim() || 'This request is excluded from automatic safety approval.');
    case 'error':
      return fallback(legacy.reason?.trim() ||
        `Safety review failed${legacy.failureReason ? `: ${legacy.failureReason}` : ''}. Human approval is required.`);
    default:
      return fallback('No safety review assessment is available. Human approval is required.');
  }
}

interface PendingDecision {
  summary: string;
  assisted: boolean;
  unattended: boolean;
  reason?: string;
}

const MAX_TRACKED_REQUESTS = 256;

/** One tracker per session subscription; callbacks must not emit parallel notices. */
export class AssistedPermissionTracker {
  private readonly pending = new Map<string, PendingDecision>();
  private readonly completed = new Map<string, true>();

  process(event: SessionEvent): { approved: boolean; summary: string; reason?: string } | undefined {
    if (event.checkpoint) return;
    if (event.type === 'session.idle') {
      this.pending.clear();
      return;
    }
    if (event.type === 'session.shutdown') {
      this.clear();
      return;
    }
    if (event.type === 'permission.requested') {
      this.trackRequest(event);
      return;
    }
    if (event.type !== 'permission.completed') return;

    const { requestId, result, decisionSource } = event.data;
    if (this.completed.has(requestId)) return;
    this.completed.set(requestId, true);
    trimOldest(this.completed);
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    // Missing request context is not evidence of an assisted automatic decision.
    if (!pending) return;

    const approved = result.kind === 'approved' || result.kind === 'approved-for-session' ||
      result.kind === 'approved-for-location' || result.kind === 'approved-read-only-for-session';
    if (approved) {
      if (decisionSource === 'assisted_approval') return { approved: true, summary: pending.summary };
      return;
    }
    if (!result.kind.startsWith('denied-') || !pending.assisted) return;
    // Host rejections identify unavailable interaction via unattended_fallback.
    // Native judge-driven rejections can instead retain assisted attribution;
    // in that case require the owning turn to explicitly be autopilot.
    const unattended = decisionSource === 'unattended_fallback' ||
      (decisionSource === 'assisted_approval' && pending.unattended);
    if (!unattended) return;
    return {
      approved: false,
      summary: pending.summary,
      reason: bounded(denialReason(event, pending.reason), 600),
    };
  }

  /** Clear all session-local state when the subscription disconnects or is replaced. */
  clear(): void {
    this.pending.clear();
    this.completed.clear();
  }

  private trackRequest({ data }: RequestedEvent): void {
    if (this.completed.has(data.requestId) || this.pending.has(data.requestId)) return;
    const decision = evaluateAssistedDecision(data.permissionRequest, {
      sessionId: data.ownerSessionId ?? '',
      assistedApprovalAssessment: data.assistedApprovalAssessment,
      promptRequest: data.promptRequest,
    }, true);
    this.pending.set(data.requestId, {
      summary: bounded(requestSummary(data.permissionRequest), 240),
      assisted: data.permissionMode === 'assisted',
      unattended: data.agentMode === 'autopilot',
      reason: decision.kind === 'approve' ? undefined : bounded(decision.reason, 600),
    });
    trimOldest(this.pending);
  }
}

function denialReason({ data: { result } }: CompletedEvent, reviewReason?: string): string {
  // Final rejection feedback outranks the earlier advisory assessment.
  switch (result.kind) {
    case 'denied-interactively-by-user':
      if (result.feedback?.trim()) return result.feedback;
      break;
    case 'denied-by-content-exclusion-policy':
      return result.message;
    case 'denied-by-permission-request-hook':
      if (result.message?.trim()) return result.message;
      break;
    case 'denied-by-rules':
      return 'Copilot runtime permission rules denied this request.';
  }
  return reviewReason || 'Copilot denied this unattended request; interactive approval is unavailable.';
}

function requestSummary(request: PermissionRequest): string {
  switch (request.kind) {
    case 'shell': return `shell: ${request.fullCommandText}`;
    case 'read': return `read: ${request.path}`;
    case 'write': return `write: ${request.fileName}`;
    case 'url': return `url: ${request.url}`;
    case 'mcp': return `mcp: ${request.serverName}/${request.toolName}`;
    case 'custom-tool': return `tool: ${request.toolName}`;
    case 'hook': return `hook: ${request.toolName}`;
    case 'workflow': return `workflow: ${request.name}`;
    case 'extension-management': return `extension: ${request.operation}`;
    default: return request.kind;
  }
}

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function trimOldest<T>(entries: Map<string, T>): void {
  if (entries.size > MAX_TRACKED_REQUESTS) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}
