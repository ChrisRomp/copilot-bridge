import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PermissionHandler } from '@github/copilot-sdk';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { RunRegistry } from '../run-registry.js';
import type { PermissionStore } from '../permission-store.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import { createAcpPermissionHandler } from '../acp-permission-handler.js';

type RunCreateBody = {
  agent_name: string;
  input: Array<{
    role: 'user';
    parts: Array<{ content: string }>;
  }>;
  session_id?: string;
};

type RunCreateResponse = {
  run_id: string;
  status: 'created';
};

export interface RunRouteDeps {
  adapter: HttpChannelAdapter;
  runRegistry: RunRegistry;
  permissionStore: PermissionStore;
  pendingPermissionStore: PendingPermissionStore;
  checkPermission: (channelId: string, toolName: string, command: string) => Promise<'allow' | 'deny' | null>;
  createSessionWithPermissions: (
    channelId: string,
    bot: string,
    onPermissionRequest: PermissionHandler,
  ) => Promise<{ sessionId: string }>;
  getSession: (sessionId: string) => { getMessages(): Promise<import('@github/copilot-sdk').SessionEvent[]> } | undefined;
  abortSession: (sessionId: string) => Promise<void>;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post<{ Body: RunCreateBody; Reply: RunCreateResponse | { error: string } }>('/runs', async (request, reply) => {
    const body = request.body ?? {} as Partial<RunCreateBody>;
    const { agent_name, input, session_id } = body;

    if (!agent_name) {
      return reply.status(400).send({ error: 'Missing required field: agent_name' });
    }
    if (!Array.isArray(input) || input.length < 1) {
      return reply.status(400).send({ error: 'Missing required field: input' });
    }

    const content = input[0]?.parts?.[0]?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return reply.status(400).send({ error: 'Missing required field: input[0].parts[0].content' });
    }

    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:execute')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!canAccessAgent(request.apiKey, agent_name)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }

    const apiKey = request.apiKey;
    const channelId = session_id ?? randomUUID();
    const existingRun = deps.runRegistry.getNonTerminalActiveRun(channelId);
    if (existingRun) {
      return reply.status(409).send({ error: 'Run already in progress for this session_id' });
    }

    const runId = randomUUID();
    const runIdRef = { current: runId };
    const onPermissionRequest = createAcpPermissionHandler(
      runIdRef,
      channelId,
      deps.permissionStore,
      deps.pendingPermissionStore,
      (runId) => deps.runRegistry.getEmitter(runId),
      deps.checkPermission,
      (runId) => {
        deps.runRegistry.updateStatus(runId, 'awaiting');
      },
    );
    deps.runRegistry.register(runId, { bot: agent_name, channelId, status: 'created' });

    let sessionId: string;
    try {
      ({ sessionId } = await deps.createSessionWithPermissions(channelId, agent_name, onPermissionRequest));
      deps.runRegistry.updateSdkSessionId(runId, sessionId);
    } catch (error) {
      deps.runRegistry.updateStatus(runId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }

    deps.adapter.dispatchInboundMessage({
      platform: 'http',
      channelId,
      userId: apiKey.keyId,
      username: apiKey.keyId,
      text: content,
      postId: runId,
      mentionsBot: true,
      isDM: false,
    });

    return reply.status(202).send({ run_id: runId, status: 'created' });
  });

  app.get<{ Params: { run_id: string } }>('/runs/:run_id', async (request, reply) => {
    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const entry = deps.runRegistry.get(request.params.run_id);
    if (!entry) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (!canAccessAgent(request.apiKey, entry.bot)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }

    if (entry.status === 'created' || entry.status === 'in_progress') {
      return reply.status(200).send({ run_id: entry.runId, status: 'in_progress' });
    }
    if (entry.status === 'awaiting') {
      return reply.status(200).send({ run_id: entry.runId, status: 'awaiting' });
    }
    if (entry.status === 'completed') {
      const events = entry.sessionEvents ?? await deps.getSession(entry.sdkSessionId ?? entry.runId)?.getMessages() ?? [];
      const output = events
        .filter((event) => event.type === 'assistant.message')
        .map((event) => ({
          role: 'agent',
          parts: [{ content: event.data?.content ?? '' }],
        }));

      return reply.status(200).send({ run_id: entry.runId, status: 'completed', output });
    }
    if (entry.status === 'failed') {
      return reply.status(200).send({ run_id: entry.runId, status: 'failed', error: entry.error ?? '' });
    }

    return reply.status(200).send({ run_id: entry.runId, status: 'cancelled' });
  });

  app.delete<{ Params: { run_id: string } }>('/runs/:run_id', async (request, reply) => {
    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:execute')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const entry = deps.runRegistry.get(request.params.run_id);
    if (!entry) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (!canAccessAgent(request.apiKey, entry.bot)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }

    deps.runRegistry.updateStatus(request.params.run_id, 'cancelled', { finishedAt: new Date().toISOString() });
    deps.runRegistry.getEmitter(request.params.run_id)?.({
      type: 'run.failed',
      data: { run_id: request.params.run_id, error: 'cancelled' },
    });
    await deps.abortSession(entry.sdkSessionId ?? entry.runId).catch(() => {});

    return reply.status(204).send();
  });
}
