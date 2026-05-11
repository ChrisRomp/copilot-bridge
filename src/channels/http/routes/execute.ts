import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { CallbackRegistry } from '../callback-registry.js';

export interface ExecuteRouteDeps {
  adapter: HttpChannelAdapter;
  callbackRegistry: CallbackRegistry;
  registerChannel: (channelId: string, bot: string) => Promise<void>;
}

type ExecuteBody = {
  bot: string;
  prompt: string;
  channel_id: string;
  callback_url: string;
  session_id?: string;
};

export function registerExecuteRoutes(
  app: FastifyInstance,
  deps: ExecuteRouteDeps,
): void {
  app.post<{ Body: ExecuteBody }>('/v1/agent/execute', async (request, reply) => {
    const apiKey = request.apiKey!;
    const { bot, prompt, channel_id, callback_url, session_id } = request.body ?? {} as Partial<ExecuteBody>;

    if (!bot || !prompt || !channel_id || !callback_url) {
      return reply.status(400).send({ error: 'Missing required fields: bot, prompt, channel_id, callback_url' });
    }

    if (!canAccessAgent(apiKey, bot)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }
    if (!canPerformOp(apiKey, 'agent:execute')) {
      return reply.status(403).send({ error: 'agent:execute permission required' });
    }

    const runId = randomUUID();
    const channelId = session_id || channel_id;

    deps.callbackRegistry.register(channelId, {
      callbackUrl: callback_url,
      runId,
      bot,
    });

    await deps.registerChannel(channelId, bot);

    deps.adapter.dispatchInboundMessage({
      platform: 'http',
      channelId,
      userId: apiKey.keyId,
      username: apiKey.keyId,
      text: prompt,
      postId: runId,
      mentionsBot: true,
      isDM: false,
    });

    return reply.status(202).send({ run_id: runId, session_id: channelId });
  });
}
