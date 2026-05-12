import type { SessionEvent } from '@github/copilot-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { RunEntry, RunRegistry } from '../run-registry.js';
import { mapSdkEventToAcp, registerRunEventsRoutes, type RunEventsRouteDeps } from './runs-events.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const limitedAgentHeader = { authorization: 'Bearer test-secret-limited' };
const noExecuteHeader = { authorization: 'Bearer test-secret-no-execute' };

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
    ['no-execute', {
      secret: 'test-secret-no-execute',
      allowedAgents: ['*'],
      allowedOps: [],
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

describe('registerRunEventsRoutes', () => {
  let app: FastifyInstance;
  let getRun: ReturnType<typeof vi.fn>;
  let getMessages: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let deps: RunEventsRouteDeps;

  beforeEach(() => {
    getRun = vi.fn().mockReturnValue(makeRunEntry());
    getMessages = vi.fn().mockResolvedValue([]);
    getSession = vi.fn().mockReturnValue({ getMessages });
    deps = {
      runRegistry: { get: getRun } as Partial<RunRegistry> as RunRegistry,
      getSession,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerRunEventsRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const response = await app.inject({ method: 'GET', url: '/runs/run-123/events' });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for unknown run_id', async () => {
    getRun.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/unknown-run/events',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found' });
  });

  it('returns 403 before run lookup when API key lacks agent:execute', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/runs/unknown-run/events',
      headers: noExecuteHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(getRun).not.toHaveBeenCalled();
  });

  it('returns 403 when agent is not in allowedAgents', async () => {
    getRun.mockReturnValue(makeRunEntry({ bot: 'bot-a' }));

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/events',
      headers: limitedAgentHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 200 with mapped events array and excludes unknown SDK event types', async () => {
    getMessages.mockResolvedValue([
      sdkEvent('assistant.message', { content: 'done' }),
      sdkEvent('session.idle'),
      sdkEvent('assistant.reasoning', { content: 'hidden' }),
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/events',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        {
          type: 'message.completed',
          data: { role: 'agent', content: 'done' },
          id: 'assistant.message-id',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'run.completed',
          data: { run_id: 'run-123' },
          id: 'session.idle-id',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(getSession).toHaveBeenCalledWith('run-123');
    expect(getMessages).toHaveBeenCalledOnce();
  });

  it('returns an empty array when session has no relevant events', async () => {
    getMessages.mockResolvedValue([
      sdkEvent('assistant.reasoning', { content: 'hidden' }),
      sdkEvent('tool.execution_start', { toolName: 'bash' }),
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/events',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [] });
  });

  it('returns an empty array when the session is missing', async () => {
    getSession.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/runs/run-123/events',
      headers: fullAccessHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [] });
    expect(getMessages).not.toHaveBeenCalled();
  });
});

describe('mapSdkEventToAcp', () => {
  it('maps assistant.message to message.completed with content', () => {
    expect(mapSdkEventToAcp(sdkEvent('assistant.message', { content: 'hello' }), 'run-123')).toEqual({
      type: 'message.completed',
      data: { role: 'agent', content: 'hello' },
      id: 'assistant.message-id',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('maps assistant.message_delta to message.part with deltaContent', () => {
    expect(mapSdkEventToAcp(sdkEvent('assistant.message_delta', { deltaContent: 'hel' }), 'run-123')).toEqual({
      type: 'message.part',
      data: { role: 'agent', content: 'hel' },
      id: 'assistant.message_delta-id',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('maps session.idle to run.completed', () => {
    expect(mapSdkEventToAcp(sdkEvent('session.idle'), 'run-123')).toEqual({
      type: 'run.completed',
      data: { run_id: 'run-123' },
      id: 'session.idle-id',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('maps session.error to run.failed', () => {
    expect(mapSdkEventToAcp(sdkEvent('session.error', { message: 'boom' }), 'run-123')).toEqual({
      type: 'run.failed',
      data: { run_id: 'run-123', error: 'boom' },
      id: 'session.error-id',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('maps bridge.permission_request to run.awaiting', () => {
    expect(mapSdkEventToAcp(sdkEvent('bridge.permission_request', { toolName: 'bash' }), 'run-123')).toEqual({
      type: 'run.awaiting',
      data: { run_id: 'run-123', tool: 'bash' },
      id: 'bridge.permission_request-id',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns undefined for unknown SDK event types', () => {
    expect(mapSdkEventToAcp(sdkEvent('assistant.reasoning', { content: 'hidden' }), 'run-123')).toBeUndefined();
  });
});
