import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger } from '../../logger.js';

const log = createLogger('http-server');

export interface HttpServerOptions {
  bind: string;
  port: number;
}

export async function createHttpServer(opts: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.listen({ host: opts.bind, port: opts.port });
  log.info(`HTTP server listening on ${opts.bind}:${opts.port}`);

  return app;
}
