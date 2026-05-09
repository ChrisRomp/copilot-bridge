import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger } from '../../logger.js';

const log = createLogger('http-server');

export interface HttpServerOptions {
  bind: string;
  port: number;
}

export type ConfigureHttpServer = (app: FastifyInstance) => void | Promise<void>;

export async function createHttpServer(
  opts: HttpServerOptions,
  configure?: ConfigureHttpServer,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await configure?.(app);
  await app.listen({ host: opts.bind, port: opts.port });
  log.info(`HTTP server listening on ${opts.bind}:${opts.port}`);

  return app;
}
