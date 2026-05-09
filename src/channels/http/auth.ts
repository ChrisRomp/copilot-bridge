import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ResolvedApiKey {
  keyId: string;
  allowedAgents: string[];
  allowedOps: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ResolvedApiKey;
  }
}

export interface AuthConfig {
  keys: Map<string, { secret: string; allowedAgents: string[]; allowedOps: string[] }>;
}

export function registerAuthHook(app: FastifyInstance, authConfig: AuthConfig): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/healthz') {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(token);
    let matched: ResolvedApiKey | null = null;

    for (const [keyId, keyConfig] of authConfig.keys) {
      const secretBuf = Buffer.from(keyConfig.secret);

      if (tokenBuf.length === secretBuf.length && timingSafeEqual(tokenBuf, secretBuf)) {
        matched = {
          keyId,
          allowedAgents: keyConfig.allowedAgents,
          allowedOps: keyConfig.allowedOps,
        };
        break;
      }
    }

    if (!matched) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }

    request.apiKey = matched;
  });
}

export function canAccessAgent(apiKey: ResolvedApiKey, agentName: string): boolean {
  return apiKey.allowedAgents.includes('*') || apiKey.allowedAgents.includes(agentName);
}

export function canPerformOp(apiKey: ResolvedApiKey, op: string): boolean {
  return apiKey.allowedOps.includes('*') || apiKey.allowedOps.includes(op);
}
