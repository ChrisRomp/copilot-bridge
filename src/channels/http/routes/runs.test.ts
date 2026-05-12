import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import type { PermissionStore } from '../permission-store.js';
import { RunRegistry, type RunEntry } from '../run-registry.js';
import { registerRunRoutes, type RunRouteDeps } from './runs.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const limitedAgentHeader = { authorization: 'Bearer test-secret-limited' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['read-only', {
      secret: 'test-secret-readonly',
      allowedAgents: ['bot-a'],
      allowedOps: ['agent:read'],
    }],
    ['limited-agent', {
      secret: 'test-secret-limited',
      allowedAgents: ['bot-b'],
      allowedOps: ['agent:execute'],
    }],
  ]),
};

const validPayload = {
  agent_name: 'bot-a',
  input: [{
    role: 'user',
    parts: [{ content: 'hello from ACP' }],
  }],
};

const makeRunEntry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  runId: 'mock-session-id',
  bot: 'bot-a',
  channelId: 'mock-channel-id',
  status: 'created',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('registerRunRoutes', () => {
  let app: FastifyInstance;
  let deps: RunRouteDeps;
  let dispatchInboundMessage: ReturnType<typeof vi.fn>;
  let registerRun: ReturnType<typeof vi.fn>;
  let getRun: ReturnType<typeof vi.fn>;
  let updateStatus: ReturnType<typeof vi.fn>;
  let unregisterRun: ReturnType<typeof vi.fn>;
  let getNonTerminalActiveRun: ReturnType<typeof vi.fn>;
  let getEmitter: ReturnType<typeof vi.fn>;
  let createSessionWithPermissions: ReturnType<typeof vi.fn>;
  let subscribeToSessionEvents: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let capturedHandler: ((sessionId: string, channelId: string, event: unknown) => void) | undefined;
  let checkPermission: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let abortSession: ReturnType<typeof vi.fn>;
  let recordCancellationSuppression: ReturnType<typeof vi.fn>;
  let shouldSuppressCancellationTerminal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchInboundMessage = vi.fn();
    registerRun = vi.fn().mockReturnValue(makeRunEntry());
    getRun = vi.fn();
    updateStatus = vi.fn().mockReturnValue(true);
    unregisterRun = vi.fn().mockReturnValue(true);
    getNonTerminalActiveRun = vi.fn().mockReturnValue(undefined);
    getEmitter = vi.fn();
    createSessionWithPermissions = vi.fn(async (channelId: string) => ({ sessionId: channelId }));
    unsubscribe = vi.fn();
    capturedHandler = undefined;
    subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    checkPermission = vi.fn().mockResolvedValue(null);
    getSession = vi.fn();
    abortSession = vi.fn().mockResolvedValue(undefined);
    recordCancellationSuppression = vi.fn();
    shouldSuppressCancellationTerminal = vi.fn().mockReturnValue(false);
    deps = {
      adapter: { dispatchInboundMessage } as Partial<RunRouteDeps['adapter']> as RunRouteDeps['adapter'],
      runRegistry: {
        register: registerRun,
        get: getRun,
        updateStatus,
        unregister: unregisterRun,
        getNonTerminalActiveRun,
        getEmitter,
        recordCancellationSuppression,
        shouldSuppressCancellationTerminal,
      } as Partial<RunRegistry> as RunRegistry,
      permissionStore: { shouldApprove: vi.fn() } as unknown as PermissionStore,
      pendingPermissionStore: { park: vi.fn() } as unknown as PendingPermissionStore,
      checkPermission,
      createSessionWithPermissions,
      subscribeToSessionEvents,
      getSession,
      abortSession,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerRunRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when API key lacks agent:execute permission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: readOnlyHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 when agent_name is not in allowedAgents', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: limitedAgentHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 400 when agent_name is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { input: validPayload.input },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when input is missing or empty', async () => {
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { agent_name: 'bot-a' },
    });
    const emptyResponse = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { agent_name: 'bot-a', input: [] },
    });

    expect(missingResponse.statusCode).toBe(400);
    expect(emptyResponse.statusCode).toBe(400);
  });

  it('returns 400 when input[0].parts[0].content is missing or empty', async () => {
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { agent_name: 'bot-a', input: [{ role: 'user', parts: [{}] }] },
    });
    const emptyResponse = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { agent_name: 'bot-a', input: [{ role: 'user', parts: [{ content: '' }] }] },
    });

    expect(missingResponse.statusCode).toBe(400);
    expect(emptyResponse.statusCode).toBe(400);
  });

  it('returns 202 with the requested session_id as the run_id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ run_id: 'client-session-id', status: 'created' });
  });

  it('dispatches inbound message with the request content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: validPayload,
    });
    const runId = response.json().run_id;

    expect(dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: expect.any(String),
      userId: 'full-access',
      username: 'full-access',
      text: 'hello from ACP',
      postId: runId,
      mentionsBot: true,
      isDM: false,
    });
  });

  it('returns 409 when a nonterminal run already exists for the ACP session_id', async () => {
    getNonTerminalActiveRun.mockReturnValue(makeRunEntry({
      runId: 'existing-run-id',
      channelId: 'client-session-id',
      status: 'in_progress',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Run already in progress for this session_id' });
    expect(createSessionWithPermissions).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('marks a run completed on session idle and permits a later run on the same session_id', async () => {
    const registry = new RunRegistry();
    deps.runRegistry = registry;
    createSessionWithPermissions.mockResolvedValue({ sessionId: 'client-session-id' });

    const first = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });
    const firstRunId = first.json().run_id;

    const conflict = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    capturedHandler?.('client-session-id', 'client-session-id', { type: 'session.idle' });
    expect(registry.get(firstRunId)?.status).toBe('completed');
    expect(registry.get(firstRunId)?.finishedAt).toEqual(expect.any(String));
    const afterTerminal = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(first.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(afterTerminal.statusCode).toBe(202);
    expect(afterTerminal.json().run_id).toBe(firstRunId);
    expect(createSessionWithPermissions).toHaveBeenCalledTimes(2);
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('marks a run failed on session error and permits a later run on the same session_id', async () => {
    const registry = new RunRegistry();
    deps.runRegistry = registry;
    createSessionWithPermissions.mockResolvedValue({ sessionId: 'client-session-id' });

    const first = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });
    const firstRunId = first.json().run_id;

    const conflict = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    capturedHandler?.('client-session-id', 'client-session-id', {
      type: 'session.error',
      data: { message: 'boom' },
    });
    expect(registry.get(firstRunId)?.status).toBe('failed');
    expect(registry.get(firstRunId)?.error).toBe('boom');
    expect(registry.get(firstRunId)?.finishedAt).toEqual(expect.any(String));
    const afterTerminal = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(first.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(afterTerminal.statusCode).toBe(202);
    expect(createSessionWithPermissions).toHaveBeenCalledTimes(2);
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when session creation fails', async () => {
    createSessionWithPermissions.mockRejectedValue(new Error('create failed'));

    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(response.statusCode).toBe(500);
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('returns 404 for GET when run_id is unknown', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: validPayload,
    });
    const runId = response.json().run_id;
    const onPermissionRequest = createSessionWithPermissions.mock.calls[0]?.[2];

    await expect(onPermissionRequest(
      { kind: 'shell', toolCallId: 'tool-call-1' },
      { sessionId: 'mock-session-id' },
    )).resolves.toEqual({ kind: 'denied-by-rules', rules: [] });

    expect(updateStatus).toHaveBeenCalledWith(runId, 'awaiting');
  });

  it('keeps the ACP session_id as the run_id after the previous run is terminal', async () => {
    createSessionWithPermissions.mockResolvedValue({ sessionId: 'client-session-id' });
    const first = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });
    getNonTerminalActiveRun.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    const second = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    const firstRunId = first.json().run_id;
    const secondRunId = second.json().run_id;
    expect(firstRunId).toBe('client-session-id');
    expect(secondRunId).toBe('client-session-id');
    expect(registerRun).toHaveBeenNthCalledWith(1, 'client-session-id', {
      bot: 'bot-a',
      channelId: 'client-session-id',
      status: 'created',
    });
    expect(registerRun).toHaveBeenNthCalledWith(2, 'client-session-id', {
      bot: 'bot-a',
      channelId: 'client-session-id',
      status: 'created',
    });
  });

  it('returns 500 when session creation fails', async () => {
    createSessionWithPermissions.mockRejectedValue(new Error('create failed'));

    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(response.statusCode).toBe(500);
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it('returns 404 for GET when run_id is unknown', async () => {
    getRun.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/unknown-run',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found' });
  });

  it('returns 403 for GET when agent is not in allowedAgents', async () => {
    getRun.mockReturnValue(makeRunEntry({ bot: 'bot-b' }));

    const response = await app.inject({
      method: 'GET',
      url: '/runs/mock-session-id',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns in_progress for GET of an active run', async () => {
    getRun.mockReturnValue(makeRunEntry({ status: 'created' }));

    const response = await app.inject({
      method: 'GET',
      url: '/runs/mock-session-id',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run_id: 'mock-session-id', status: 'in_progress' });
  });

  it('returns assistant message output for GET of a completed run', async () => {
    getRun.mockReturnValue(makeRunEntry({ status: 'completed' }));
    getSession.mockReturnValue({
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 'event-1',
          parentId: null,
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'assistant.message',
          data: {
            content: 'done',
            messageId: 'message-1',
          },
        } satisfies import('@github/copilot-sdk').SessionEvent,
      ]),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/runs/mock-session-id',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      run_id: 'mock-session-id',
      status: 'completed',
      output: [{ role: 'agent', parts: [{ content: 'done' }] }],
    });
  });

  it('returns empty output for GET of a completed run when session is unavailable', async () => {
    getRun.mockReturnValue(makeRunEntry({ status: 'completed' }));
    getSession.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/mock-session-id',
      headers: readOnlyHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      run_id: 'mock-session-id',
      status: 'completed',
      output: [],
    });
  });

  it('returns 404 for DELETE when run_id is unknown', async () => {
    getRun.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/unknown-run',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found' });
  });

  it('returns 403 for DELETE when agent is not in allowedAgents', async () => {
    getRun.mockReturnValue(makeRunEntry({ bot: 'bot-a' }));

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/mock-session-id',
      headers: limitedAgentHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 204 for DELETE and aborts the session for a valid run', async () => {
    getRun.mockReturnValue(makeRunEntry());

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/mock-session-id',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(abortSession).toHaveBeenCalledWith('mock-session-id');
  });

  it('updates run status to cancelled for DELETE of a valid run', async () => {
    getRun.mockReturnValue(makeRunEntry());

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/mock-session-id',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(204);
    expect(updateStatus).toHaveBeenCalledWith('mock-session-id', 'cancelled', {
      finishedAt: expect.any(String),
    });
  });

  it('emits terminal cancellation event to connected run stream after DELETE', async () => {
    const emit = vi.fn();
    getRun.mockReturnValue(makeRunEntry());
    getEmitter.mockReturnValue(emit);

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/mock-session-id',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(204);
    expect(emit).toHaveBeenCalledWith({
      type: 'run.failed',
      data: { run_id: 'mock-session-id', error: 'cancelled' },
    });
  });

  it('keeps DELETE cancellation terminal when abort later emits session error', async () => {
    const registry = new RunRegistry();
    deps.runRegistry = registry;
    createSessionWithPermissions.mockResolvedValue({ sessionId: 'client-session-id' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/runs/client-session-id',
      headers: fullAccessHeader,
    });

    capturedHandler?.('client-session-id', 'client-session-id', {
      type: 'session.error',
      data: { message: 'abort failed' },
    });

    expect(createResponse.statusCode).toBe(202);
    expect(deleteResponse.statusCode).toBe(204);
    expect(registry.get('client-session-id')?.status).toBe('cancelled');
    expect(registry.get('client-session-id')?.error).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledWith('client-session-id');
  });

  it('prevents a current watcher from treating a stale abort error as the later run terminal', async () => {
    const registry = new RunRegistry();
    const subscribers = new Set<(sessionId: string, channelId: string, event: unknown) => void>();
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    deps.runRegistry = registry;
    deps.subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      subscribers.add(handler);
      const stop = vi.fn(() => subscribers.delete(handler));
      unsubscribes.push(stop);
      return stop;
    });
    createSessionWithPermissions.mockResolvedValue({ sessionId: 'client-session-id' });

    const firstCreate = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/runs/client-session-id',
      headers: fullAccessHeader,
    });
    const secondCreate = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    for (const handler of Array.from(subscribers)) {
      handler('client-session-id', 'client-session-id', {
        type: 'session.error',
        data: { message: 'stale abort error' },
      });
    }
    const afterStaleError = registry.get('client-session-id');
    const afterStaleStatus = afterStaleError?.status;
    const afterStaleMessage = afterStaleError?.error;
    for (const handler of Array.from(subscribers)) {
      handler('client-session-id', 'client-session-id', { type: 'session.idle' });
    }

    expect(firstCreate.statusCode).toBe(202);
    expect(deleteResponse.statusCode).toBe(204);
    expect(secondCreate.statusCode).toBe(202);
    expect(afterStaleStatus).toBe('created');
    expect(afterStaleMessage).toBeUndefined();
    expect(registry.get('client-session-id')?.status).toBe('completed');
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
  });
});
