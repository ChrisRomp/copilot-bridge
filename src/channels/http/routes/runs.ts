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
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: unknown) => void,
  ) => () => void;
  getSession: (sessionId: string) => { getMessages(): Promise<import('@github/copilot-sdk').SessionEvent[]> } | undefined;
  abortSession: (sessionId: string) => Promise<void>;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const runWatchers = new Map<string, () => void>();

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

    // Empty ref - filled in after session creation with the CLI-assigned sessionId
    const runIdRef = { current: '' };
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

    // Create session first - CLI assigns the sessionId, which becomes the run_id
    let sessionId: string;
    try {
      ({ sessionId } = await deps.createSessionWithPermissions(channelId, agent_name, onPermissionRequest));
    } catch (error) {
      throw error;
    }

    // runId IS the CLI sessionId - one ID, no mapping needed
    const runId = sessionId;
    runIdRef.current = runId;

    deps.runRegistry.register(runId, { bot: agent_name, channelId, status: 'created' });
    watchRunUntilTerminal(runId, channelId, deps, runWatchers);

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
      const events = await deps.getSession(entry.runId)?.getMessages() ?? [];
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

    const runId = request.params.run_id;
    runWatchers.get(runId)?.();
    deps.runRegistry.recordCancellationSuppression(runId, entry.channelId);
    deps.runRegistry.updateStatus(runId, 'cancelled', { finishedAt: new Date().toISOString() });
    deps.runRegistry.getEmitter(runId)?.({
      type: 'run.failed',
      data: { run_id: runId, error: 'cancelled' },
    });
    await deps.abortSession(entry.runId).catch(() => {});

    return reply.status(204).send();
  });
}

function watchRunUntilTerminal(
  runId: string,
  channelId: string,
  deps: RunRouteDeps,
  runWatchers: Map<string, () => void>,
): () => void {
  let active = true;
  let unsubscribe = (): void => undefined;
  const stopWatchingRun = (): void => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
    if (runWatchers.get(runId) === stopWatchingRun) {
      runWatchers.delete(runId);
    }
  };
  runWatchers.set(runId, stopWatchingRun);
  unsubscribe = deps.subscribeToSessionEvents(channelId, (eventSessionId, eventChannelId, event) => {
    if (!active || eventSessionId !== runId || eventChannelId !== channelId || !isRecord(event)) {
      return;
    }

    if (event.type === 'session.idle') {
      deps.runRegistry.updateStatus(runId, 'completed', { finishedAt: new Date().toISOString() });
      stopWatchingRun();
    } else if (event.type === 'session.error') {
      if (deps.runRegistry.shouldSuppressCancellationTerminal(runId, channelId, event)) {
        return;
      }
      deps.runRegistry.updateStatus(runId, 'failed', {
        finishedAt: new Date().toISOString(),
        error: readErrorMessage(event),
      });
      stopWatchingRun();
    }
  });
  if (!active) {
    unsubscribe();
  }
  return stopWatchingRun;
}

function readErrorMessage(event: Record<string, unknown>): string {
  const data = event.data;
  if (isRecord(data)) {
    const message = data.message ?? data.error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
