import type { FastifyInstance } from 'fastify';
import { canAccessAgent, canPerformOp, type ResolvedApiKey } from '../auth.js';
import type { BotConfig } from '../../../types.js';

interface AgentBotConfig extends Pick<BotConfig, 'agent' | 'token'> {
  model?: string;
}

interface AgentManifest {
  name: string;
  description: string;
  input_content_types: string[];
  output_content_types: string[];
}

export interface AgentRouteDeps {
  bots: Record<string, AgentBotConfig>;
}

const INPUT_CONTENT_TYPES = ['text/plain'];
const OUTPUT_CONTENT_TYPES = ['text/plain'];

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get('/v1/agents', async (request, reply) => {
    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const agents = Object.entries(deps.bots)
      .filter(([name]) => canAccessAgent(request.apiKey!, name))
      .map(([name, bot]) => buildManifest(name, bot));

    return { agents };
  });

  app.get<{ Params: { name: string } }>('/v1/agents/:name', async (request, reply) => {
    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { name } = request.params;
    const bot = deps.bots[name];

    if (!bot) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    if (!canAccessAgent(request.apiKey!, name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return buildManifest(name, bot);
  });
}

function buildManifest(name: string, bot: AgentBotConfig): AgentManifest {
  return {
    name,
    description: `Agent: ${bot.agent ?? name}`,
    input_content_types: INPUT_CONTENT_TYPES,
    output_content_types: OUTPUT_CONTENT_TYPES,
  };
}
