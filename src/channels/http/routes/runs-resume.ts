import type { FastifyInstance } from 'fastify';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import type { PermissionStore } from '../permission-store.js';
import type { RunRegistry } from '../run-registry.js';

type ResumeBody = {
  decision: 'allow-once' | 'allow-session' | 'allow-all-session' | 'allow-all' | 'deny';
};

type ResumeDecision = ResumeBody['decision'];

const VALID_DECISIONS = new Set<ResumeDecision>([
  'allow-once',
  'allow-session',
  'allow-all-session',
  'allow-all',
  'deny',
]);

export interface RunResumeRouteDeps {
  runRegistry: RunRegistry;
  permissionStore: PermissionStore;
  pendingPermissionStore: PendingPermissionStore;
  addPermissionRule: (channelId: string, toolName: string, cmd: string, action: 'allow' | 'deny') => Promise<void>;
}

export function registerRunResumeRoutes(app: FastifyInstance, deps: RunResumeRouteDeps): void {
  app.post<{ Params: { run_id: string }; Body: Partial<ResumeBody> }>('/runs/:run_id/resume', async (request, reply) => {
    if (!request.apiKey) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    if (!canPerformOp(request.apiKey, 'agent:execute')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { run_id: runId } = request.params;
    const entry = deps.runRegistry.get(runId);
    if (!entry) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (!canAccessAgent(request.apiKey, entry.bot)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }

    const decision = request.body?.decision;
    if (!isResumeDecision(decision)) {
      return reply.status(400).send({ error: 'Invalid decision' });
    }

    if (!deps.pendingPermissionStore.has(runId)) {
      return reply.status(409).send({ error: 'No pending permission request' });
    }

    const pending = deps.pendingPermissionStore.get(runId);
    if (!pending) {
      return reply.status(409).send({ error: 'No pending permission request' });
    }

    switch (decision) {
      case 'allow-once':
        break;
      case 'allow-session':
        deps.permissionStore.setApproveTool(entry.runId, pending.toolKind);
        break;
      case 'allow-all-session':
        deps.permissionStore.setApproveAll(entry.runId);
        break;
      case 'allow-all':
        await deps.addPermissionRule(entry.channelId, pending.toolKind, '*', 'allow');
        break;
      case 'deny':
        break;
    }

    deps.pendingPermissionStore.resolve(runId, decision);

    return reply.status(200).send({ run_id: runId, status: 'in_progress' });
  });
}

function isResumeDecision(value: unknown): value is ResumeDecision {
  return typeof value === 'string' && VALID_DECISIONS.has(value as ResumeDecision);
}
