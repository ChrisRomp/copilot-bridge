import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from './server.js';

describe('createHttpServer', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('returns a Fastify instance', async () => {
    app = await createHttpServer({ bind: '127.0.0.1', port: 0 });

    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
    expect(app.server.listening).toBe(true);
  });

  it('serves a health check endpoint', async () => {
    app = await createHttpServer({ bind: '127.0.0.1', port: 0 });

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
