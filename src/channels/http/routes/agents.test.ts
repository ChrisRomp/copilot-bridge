import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { registerAgentRoutes, type AgentRouteDeps } from './agents.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const noAgentReadHeader = { authorization: 'Bearer test-secret-noperm' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['read-only', {
      secret: 'test-secret-readonly',
      allowedAgents: ['bot-a', 'bot-b'],
      allowedOps: ['agent:read'],
    }],
    ['no-agent-read', {
      secret: 'test-secret-noperm',
      allowedAgents: ['*'],
      allowedOps: ['card:read'],
    }],
  ]),
};

const testBots: AgentRouteDeps['bots'] = {
  'bot-a': { agent: 'agent-alpha', token: 'tok-a', model: 'gpt-4' },
  'bot-b': { agent: 'agent-beta', token: 'tok-b' },
  'bot-c': { token: 'tok-c' },
};

describe('registerAgentRoutes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerAgentRoutes(app, { bots: testBots });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/agents', () => {
    it('returns 403 when no API key is present', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/agents' });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when API key lacks agent:read permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: noAgentReadHeader,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('lists all agents with wildcard access', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: fullAccessHeader,
      });
      expect(response.statusCode).toBe(200);
      const { agents } = response.json<{ agents: unknown[] }>();
      expect(agents).toHaveLength(3);
      const names = agents.map((a: any) => a.name);
      expect(names).toEqual(expect.arrayContaining(['bot-a', 'bot-b', 'bot-c']));
    });

    it('filters agents based on allowedAgents', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: readOnlyHeader,
      });
      expect(response.statusCode).toBe(200);
      const { agents } = response.json<{ agents: unknown[] }>();
      expect(agents).toHaveLength(2);
      const names = agents.map((a: any) => a.name);
      expect(names).toEqual(expect.arrayContaining(['bot-a', 'bot-b']));
      expect(names).not.toContain('bot-c');
    });

    it('returns correct AgentManifest shape', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: fullAccessHeader,
      });
      const { agents } = response.json<{ agents: any[] }>();
      const botA = agents.find((a) => a.name === 'bot-a');
      expect(botA).toEqual({
        name: 'bot-a',
        description: 'Agent: agent-alpha',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
      });

      // bot with no agent field falls back to name
      const botC = agents.find((a) => a.name === 'bot-c');
      expect(botC).toEqual({
        name: 'bot-c',
        description: 'Agent: bot-c',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
      });
    });
  });

  describe('GET /v1/agents/:name', () => {
    it('returns 403 when no API key is present', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/agents/bot-a' });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when API key lacks agent:read permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/bot-a',
        headers: noAgentReadHeader,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns the manifest for an accessible agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/bot-a',
        headers: fullAccessHeader,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        name: 'bot-a',
        description: 'Agent: agent-alpha',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
      });
    });

    it('returns 404 for unknown agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/nonexistent',
        headers: fullAccessHeader,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Agent not found' });
    });

    it('returns 403 for agent not in allowedAgents', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/bot-c',
        headers: readOnlyHeader,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });
  });
});
