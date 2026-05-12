import type { SessionEvent } from '@github/copilot-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { RunRegistry, type RunEntry } from '../run-registry.js';
import { registerRunStreamRoutes, type RunStreamRouteDeps } from './runs-stream.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const limitedAgentHeader = { authorization: 'Bearer test-secret-limited' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['limited-agent', {
      secret: 'test-secret-limited',
      allowedAgents: ['bot-b'],
      allowedOps: ['agent:execute'],
    }],
  ]),
};

const makeRunEntry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  runId: 'run-123',
  bot: 'bot-a',
  channelId: 'channel-123',
  status: 'in_progress',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const sdkEvent = (type: string, data: Record<string, unknown> = {}, extras: Record<string, unknown> = {}): SessionEvent => ({
  type,
  data,
  id: `${type}-id`,
  timestamp: '2026-01-01T00:00:00.000Z',
  parentId: null,
  ...extras,
} as unknown as SessionEvent);

describe('registerRunStreamRoutes', () => {
  let app: FastifyInstance;
  let getRun: ReturnType<typeof vi.fn>;
  let getMessages: ReturnType<typeof vi.fn>;
  let setEmitter: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let isActiveRun: ReturnType<typeof vi.fn>;
  let subscribeToSessionEvents: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let capturedHandler: ((sessionId: string, channelId: string, event: any) => void) | undefined;
  let capturedRequestRaw: IncomingMessage | undefined;
  let shouldSuppressCancellationTerminal: ReturnType<typeof vi.fn>;
  let deps: RunStreamRouteDeps;

  beforeEach(() => {
    getRun = vi.fn().mockReturnValue(makeRunEntry());
    getMessages = vi.fn().mockResolvedValue([]);
    setEmitter = vi.fn();
    getSession = vi.fn().mockReturnValue({ getMessages });
    isActiveRun = vi.fn().mockReturnValue(true);
    shouldSuppressCancellationTerminal = vi.fn().mockReturnValue(false);
    unsubscribe = vi.fn();
    capturedHandler = undefined;
    capturedRequestRaw = undefined;
    subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    deps = {
      runRegistry: { get: getRun, setEmitter, isActiveRun, shouldSuppressCancellationTerminal } as Partial<RunRegistry> as RunRegistry,
      subscribeToSessionEvents,
      getSession,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    app.addHook('onRequest', async (request) => {
      if (request.url === '/runs/run-123/stream') {
        capturedRequestRaw = request.raw;
      }
    });
    registerRunStreamRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 for unknown run_id', async () => {
    getRun.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/unknown-run/stream',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found' });
  });

  it('returns 403 when agent is not in allowedAgents', async () => {
    getRun.mockReturnValue(makeRunEntry({ bot: 'bot-a' }));

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: limitedAgentHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns text/event-stream content-type for live run', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('run-123', 'channel-123', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(setEmitter).toHaveBeenCalledWith('run-123', expect.any(Function));
  });

  it('replays completed run events from getMessages and closes', async () => {
    getRun.mockReturnValue(makeRunEntry({ status: 'completed' }));
    getMessages.mockResolvedValue([
      sdkEvent('assistant.message', { content: 'done' }),
      sdkEvent('assistant.reasoning', { content: 'hidden' }),
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: message.completed\ndata: {"role":"agent","content":"done"}\n\n' +
      'event: run.completed\ndata: {"run_id":"run-123"}\n\n'
    );
    expect(getSession).toHaveBeenCalledWith('run-123');
    expect(getMessages).toHaveBeenCalledOnce();
  });

  it('replays terminal run events from the run session', async () => {
    getRun.mockReturnValue(makeRunEntry({
      status: 'completed',
    }));
    getMessages.mockResolvedValue([
      sdkEvent('assistant.message', { content: 'later run' }),
      sdkEvent('session.idle'),
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: message.completed\ndata: {"role":"agent","content":"later run"}\n\n' +
      'event: run.completed\ndata: {"run_id":"run-123"}\n\n'
    );
    expect(getSession).toHaveBeenCalledWith('run-123');
  });

  it('closes terminal stream and writes terminal event when getMessages rejects', async () => {
    getRun.mockReturnValue(makeRunEntry({ status: 'completed' }));
    getMessages.mockRejectedValue(new Error('replay failed'));

    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('stream did not close')), 500);
        }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('event: run.completed\ndata: {"run_id":"run-123"}\n\n');
      expect(getMessages).toHaveBeenCalledOnce();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  });

  it('writes terminal SSE events after production run-state updates clear terminal runs', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('run-123', 'different-channel', sdkEvent('session.idle'));
    isActiveRun.mockReturnValue(false);
    capturedHandler?.('run-123', 'channel-123', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.body).toBe('event: run.completed\ndata: {"run_id":"run-123"}\n\n');
    expect(response.body.match(/event: run\.completed/g)).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores and stays open for events when the streamed run is no longer active', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    isActiveRun.mockReturnValue(false);
    capturedHandler?.('reused-sdk-session', 'channel-123', sdkEvent('assistant.message_delta', { deltaContent: 'wrong run' }));

    isActiveRun.mockReturnValue(true);
    capturedHandler?.('reused-sdk-session', 'channel-123', sdkEvent('assistant.message_delta', { deltaContent: 'right run' }));
    capturedHandler?.('reused-sdk-session', 'channel-123', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.body).toBe(
      'event: message.part\ndata: {"role":"agent","content":"right run"}\n\n' +
      'event: run.completed\ndata: {"run_id":"run-123"}\n\n'
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes when session.idle event arrives', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('run-123', 'channel-123', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.body.match(/event: run\.completed/g)).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('writes one terminal event when session.error arrives', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('run-123', 'channel-123', sdkEvent('session.error', { message: 'boom' }));
    const response = await responsePromise;

    expect(response.body).toBe('event: run.failed\ndata: {"run_id":"run-123","error":"boom"}\n\n');
    expect(response.body.match(/event: run\.failed/g)).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps the later stream open when a stale abort error reaches current subscribers', async () => {
    const registry = new RunRegistry();
    const subscribers = new Set<(sessionId: string, channelId: string, event: any) => void>();
    const streamUnsubscribe = vi.fn(() => subscribers.delete(Array.from(subscribers)[0]));
    registry.register('run-123', { bot: 'bot-a', channelId: 'channel-123', status: 'created' });
    registry.recordCancellationSuppression('run-123', 'channel-123');
    registry.updateStatus('run-123', 'cancelled', { finishedAt: new Date().toISOString() });
    registry.register('run-123', { bot: 'bot-a', channelId: 'channel-123', status: 'created' });
    deps.runRegistry = registry;
    deps.subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      subscribers.add(handler);
      return streamUnsubscribe;
    });

    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(subscribers.size).toBe(1));
    for (const handler of Array.from(subscribers)) {
      handler('run-123', 'channel-123', sdkEvent('session.error', { message: 'stale abort error' }));
    }
    expect(streamUnsubscribe).not.toHaveBeenCalled();
    for (const handler of Array.from(subscribers)) {
      handler('run-123', 'channel-123', sdkEvent('session.idle'));
    }
    const response = await responsePromise;

    expect(response.body).toBe('event: run.completed\ndata: {"run_id":"run-123"}\n\n');
    expect(streamUnsubscribe).toHaveBeenCalledOnce();
  });

  it('closes the exact run stream when DELETE emits terminal cancellation through the run emitter', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    const emit = setEmitter.mock.calls[0]?.[1] as ((event: unknown) => void) | undefined;
    emit?.({ type: 'run.failed', data: { run_id: 'run-123', error: 'cancelled' } });
    const response = await responsePromise;

    expect(response.body).toBe('event: run.failed\ndata: {"run_id":"run-123","error":"cancelled"}\n\n');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes on client disconnect', async () => {
    const responsePromise = app.inject({
      method: 'GET',
      url: '/runs/run-123/stream',
      headers: fullAccessHeader,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedRequestRaw?.emit('close');
    await responsePromise;

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
