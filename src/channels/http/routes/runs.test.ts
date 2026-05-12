import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { PermissionStore } from '../permission-store.js';
import type { RunRegistry } from '../run-registry.js';
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

describe('registerRunRoutes', () => {
  let app: FastifyInstance;
  let deps: RunRouteDeps;
  let dispatchInboundMessage: ReturnType<typeof vi.fn>;
  let registerRun: ReturnType<typeof vi.fn>;
  let ensureSession: ReturnType<typeof vi.fn>;
  let registerChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchInboundMessage = vi.fn();
    registerRun = vi.fn().mockReturnValue({
      runId: 'mock-session-id',
      bot: 'bot-a',
      channelId: 'mock-channel-id',
      status: 'created',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    ensureSession = vi.fn().mockResolvedValue({ sessionId: 'mock-session-id', isNew: true });
    registerChannel = vi.fn().mockResolvedValue(undefined);
    deps = {
      adapter: { dispatchInboundMessage } as Partial<RunRouteDeps['adapter']> as RunRouteDeps['adapter'],
      runRegistry: { register: registerRun } as Partial<RunRegistry> as RunRegistry,
      permissionStore: {} as PermissionStore,
      registerChannel,
      ensureSession,
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

  it('returns 202 with run_id equal to the ensured sessionId on valid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ run_id: 'mock-session-id', status: 'created' });
  });

  it('dispatches inbound message with the request content', async () => {
    await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: expect.any(String),
      userId: 'full-access',
      username: 'full-access',
      text: 'hello from ACP',
      postId: 'mock-session-id',
      mentionsBot: true,
      isDM: false,
    });
  });

  it('registers the run with runId equal to the ensured sessionId', async () => {
    await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(ensureSession).toHaveBeenCalledWith('client-session-id');
    expect(registerRun).toHaveBeenCalledWith('mock-session-id', {
      bot: 'bot-a',
      channelId: 'client-session-id',
      status: 'created',
    });
  });

  it('registers the HTTP channel before dispatching the message', async () => {
    await app.inject({
      method: 'POST',
      url: '/runs',
      headers: fullAccessHeader,
      payload: { ...validPayload, session_id: 'client-session-id' },
    });

    expect(registerChannel).toHaveBeenCalledWith('client-session-id', 'bot-a');
    expect(dispatchInboundMessage).toHaveBeenCalled();
  });
});
