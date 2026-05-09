import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { canAccessAgent, canPerformOp, registerAuthHook, type ResolvedApiKey } from './auth.js';

describe('registerAuthHook', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function createTestApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });

    registerAuthHook(instance, {
      keys: new Map([
        ['ui-desktop-rk', {
          secret: 'secret-token',
          allowedAgents: ['bob'],
          allowedOps: ['card:read'],
        }],
      ]),
    });

    instance.get('/healthz', async () => ({ status: 'ok' }));
    instance.get('/protected', async (request) => ({ apiKey: request.apiKey ?? null }));

    await instance.ready();
    return instance;
  }

  it('returns resolved api key info for a valid bearer token', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiKey: {
        keyId: 'ui-desktop-rk',
        allowedAgents: ['bob'],
        allowedOps: ['card:read'],
      },
    });
  });

  it('rejects requests without an authorization header', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('rejects requests with an invalid bearer token', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key' });
  });

  it('allows unauthenticated health checks', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('canAccessAgent', () => {
  it('returns true for wildcard agent access', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'wildcard',
      allowedAgents: ['*'],
      allowedOps: ['card:read'],
    };

    expect(canAccessAgent(apiKey, 'bob')).toBe(true);
  });

  it('returns true for explicitly allowed agents', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'bob-only',
      allowedAgents: ['bob'],
      allowedOps: ['card:read'],
    };

    expect(canAccessAgent(apiKey, 'bob')).toBe(true);
  });

  it('returns false for disallowed agents', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'bob-only',
      allowedAgents: ['bob'],
      allowedOps: ['card:read'],
    };

    expect(canAccessAgent(apiKey, 'lal')).toBe(false);
  });
});

describe('canPerformOp', () => {
  it('returns true for wildcard op access', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'wildcard',
      allowedAgents: ['bob'],
      allowedOps: ['*'],
    };

    expect(canPerformOp(apiKey, 'card:create')).toBe(true);
  });

  it('returns true for explicitly allowed ops', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'read-only',
      allowedAgents: ['bob'],
      allowedOps: ['card:read'],
    };

    expect(canPerformOp(apiKey, 'card:read')).toBe(true);
  });

  it('returns false for disallowed ops', () => {
    const apiKey: ResolvedApiKey = {
      keyId: 'read-only',
      allowedAgents: ['bob'],
      allowedOps: ['card:read'],
    };

    expect(canPerformOp(apiKey, 'card:create')).toBe(false);
  });
});
