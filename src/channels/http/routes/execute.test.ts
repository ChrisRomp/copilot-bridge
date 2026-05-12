import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { CallbackRegistry } from '../callback-registry.js';
import type { HttpChannelAdapter } from '../index.js';
import { registerExecuteRoutes, type ExecuteRouteDeps } from './execute.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const restrictedHeader = { authorization: 'Bearer test-secret-restricted' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['restricted', {
      secret: 'test-secret-restricted',
      allowedAgents: ['allowed-bot'],
      allowedOps: ['card:read'],
    }],
  ]),
};

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    bot: 'test-bot',
    prompt: 'Hello agent',
    channel_id: 'chan-123',
    callback_url: 'http://localhost:9999/callback',
    ...overrides,
  };
}

describe('registerExecuteRoutes', () => {
  let app: FastifyInstance;
  let callbackRegistry: CallbackRegistry;
  let mockDispatch: ReturnType<typeof vi.fn>;
  let registerChannel: ReturnType<typeof vi.fn<ExecuteRouteDeps['registerChannel']>>;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);

    callbackRegistry = new CallbackRegistry();
    mockDispatch = vi.fn();
    registerChannel = vi.fn<ExecuteRouteDeps['registerChannel']>(async () => {});

    const adapter = {
      dispatchInboundMessage: mockDispatch,
    } as Pick<HttpChannelAdapter, 'dispatchInboundMessage'>;

    registerExecuteRoutes(app, {
      adapter: adapter as HttpChannelAdapter,
      callbackRegistry,
      registerChannel,
      bots: { bob: { callback_token: 'test-cb-token' } },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 for missing auth header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('returns 401 for invalid API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: { authorization: 'Bearer invalid-secret' },
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key' });
  });

  it('returns 400 for missing required fields', async () => {
    const invalidPayloads = [
      {},
      createPayload({ bot: undefined }),
      createPayload({ prompt: undefined }),
      createPayload({ channel_id: undefined }),
      createPayload({ callback_url: undefined }),
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agent/execute',
        headers: fullAccessHeader,
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Missing required fields: bot, prompt, channel_id, callback_url',
      });
    }
  });

  it('returns 403 when API key cannot access the requested bot agent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: restrictedHeader,
      payload: createPayload({ bot: 'blocked-bot' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 403 when API key lacks agent:execute permission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: restrictedHeader,
      payload: createPayload({ bot: 'allowed-bot' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'agent:execute permission required' });
  });

  it('returns 202 with run_id and session_id on valid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      run_id: expect.any(String),
      session_id: 'chan-123',
    });
  });

  it('dispatches inbound message with the requested prompt', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload(),
    });
    const { run_id: runId } = response.json<{ run_id: string }>();

    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'chan-123',
      text: 'Hello agent',
      userId: 'full-access',
      mentionsBot: true,
      postId: runId,
    }));
  });

  it('registers callback for the channel', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload(),
    });
    const { run_id: runId } = response.json<{ run_id: string }>();

    expect(callbackRegistry.get('chan-123')).toEqual({
      callbackUrl: 'http://localhost:9999/callback',
      runId,
      bot: 'test-bot',
      callbackToken: undefined,
    });
  });

  it('stores callback_token from bot config in registry', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload({ bot: 'bob' }),
    });

    expect(response.statusCode).toBe(202);
    expect(callbackRegistry.get('chan-123')?.callbackToken).toBe('test-cb-token');
  });

  it('stores undefined callbackToken when bot has no callback_token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload({ bot: 'missing-bot' }),
    });

    expect(response.statusCode).toBe(202);
    expect(callbackRegistry.get('chan-123')?.callbackToken).toBeUndefined();
  });

  it('calls registerChannel with channelId and bot', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload(),
    });

    expect(registerChannel).toHaveBeenCalledWith('chan-123', 'test-bot');
  });

  it('uses session_id as channelId when provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload({ session_id: 'session-456' }),
    });
    const { run_id: runId } = response.json<{ run_id: string }>();

    expect(response.json()).toMatchObject({ session_id: 'session-456' });
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'session-456',
      postId: runId,
    }));
    expect(callbackRegistry.get('session-456')).toEqual({
      callbackUrl: 'http://localhost:9999/callback',
      runId,
      bot: 'test-bot',
      callbackToken: undefined,
    });
  });

  it('uses channel_id as channelId when session_id is not provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/execute',
      headers: fullAccessHeader,
      payload: createPayload({ channel_id: 'fallback-channel' }),
    });
    const { run_id: runId } = response.json<{ run_id: string }>();

    expect(response.json()).toMatchObject({ session_id: 'fallback-channel' });
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'fallback-channel',
      postId: runId,
    }));
    expect(callbackRegistry.get('fallback-channel')).toEqual({
      callbackUrl: 'http://localhost:9999/callback',
      runId,
      bot: 'test-bot',
      callbackToken: undefined,
    });
  });
});
