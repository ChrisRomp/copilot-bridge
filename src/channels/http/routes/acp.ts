import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentManifest, CreateRunRequest, ResumeRunRequest, AcpMessage, AcpSession } from '../acp.js';
import { canAccessAgent, canPerformOp, type ResolvedApiKey } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { ICardStore, Run } from '../store.js';
import type { BotConfig, InboundMessage } from '../../../types.js';

interface AcpBotConfig extends Pick<BotConfig, 'agent' | 'token'> {
  model?: string;
}

export interface AcpRouteDeps {
  store: ICardStore;
  adapter: HttpChannelAdapter;
  bots: Record<string, AcpBotConfig>;
}

type TextLikePart = Extract<AcpMessage['parts'][number], { type: 'text' }>;

type AgentParams = { name: string };
type RunParams = { id: string };
type SessionParams = { sessionId: string };

const INPUT_CONTENT_TYPES = ['text/plain'];
const OUTPUT_CONTENT_TYPES = ['text/plain'];

export function registerAcpRoutes(app: FastifyInstance, deps: AcpRouteDeps): void {
  const sessionCardIndex = new Map<string, string>();

  app.get('/v1/agents', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['agent:read', 'card:read'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const agents = Object.entries(deps.bots)
      .filter(([name]) => canAccessAgent(request.apiKey!, name))
      .map(([name, bot]) => buildManifest(name, bot));

    return { agents };
  });

  app.get<{ Params: AgentParams }>('/v1/agents/:name', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['agent:read', 'card:read'])) {
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

  app.post<{ Body: CreateRunRequest }>('/v1/runs', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['run:create', 'card:create'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = request.body;
    if (!body?.agent_name || !Array.isArray(body.input) || body.input.length === 0) {
      return reply.status(400).send({ error: 'agent_name and input are required' });
    }
    if (body.mode && body.mode !== 'async') {
      return reply.status(400).send({ error: 'Only async mode is supported' });
    }

    const bot = deps.bots[body.agent_name];
    if (!bot) {
      return reply.status(404).send({ error: `Agent "${body.agent_name}" not found` });
    }
    if (!canAccessAgent(request.apiKey!, body.agent_name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const sessionId = body.session_id ?? randomUUID();
    let cardId = sessionCardIndex.get(sessionId);

    if (!cardId) {
      const title = extractText(body.input).slice(0, 100).trim() || 'ACP Run';
      const card = await deps.store.createCard({
        title,
        type: 'work',
        agent_bot: body.agent_name,
        status: 'in_progress',
        created_by: request.apiKey!.keyId,
      });
      cardId = card.id;
      sessionCardIndex.set(sessionId, cardId);
    }

    const createdRun = await deps.store.createRun({
      card_id: cardId,
      session_id: sessionId,
      agent_name: body.agent_name,
      input: body.input,
    });
    const run = await deps.store.updateRun(createdRun.id, { status: 'in-progress' });
    sessionCardIndex.set(run.session_id, run.card_id);

    dispatchMessages(deps.adapter, {
      channelId: run.card_id,
      userId: request.apiKey!.keyId,
      username: request.apiKey!.keyId,
      text: extractText(body.input),
      postId: run.id,
    });

    return reply.status(201).send({ run });
  });

  app.get<{ Params: RunParams }>('/v1/runs/:id', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['run:read', 'card:read'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const run = await deps.store.getRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (!canAccessAgent(request.apiKey!, run.agent_name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    sessionCardIndex.set(run.session_id, run.card_id);
    return { run };
  });

  app.post<{ Params: RunParams; Body: ResumeRunRequest }>('/v1/runs/:id', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['run:resume', 'run:update', 'card:update', 'card:create'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const run = await deps.store.getRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (!canAccessAgent(request.apiKey!, run.agent_name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = request.body;
    if (body?.mode && body.mode !== 'async') {
      return reply.status(400).send({ error: 'Only async mode is supported' });
    }
    if (!Array.isArray(body?.await_resume)) {
      return reply.status(400).send({ error: 'await_resume is required' });
    }
    if (run.status !== 'awaiting') {
      return reply.status(409).send({ error: `Run is ${run.status}, not awaiting` });
    }

    const updatedRun = await deps.store.updateRun(run.id, { status: 'in-progress' });
    sessionCardIndex.set(updatedRun.session_id, updatedRun.card_id);

    dispatchMessages(deps.adapter, {
      channelId: updatedRun.card_id,
      userId: request.apiKey!.keyId,
      username: request.apiKey!.keyId,
      text: extractText(body.await_resume),
      postId: updatedRun.id,
    });

    return { run: updatedRun };
  });

  app.post<{ Params: RunParams }>('/v1/runs/:id/cancel', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['run:cancel', 'run:update', 'card:update'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const run = await deps.store.getRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (!canAccessAgent(request.apiKey!, run.agent_name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const cancelling = await deps.store.updateRun(run.id, { status: 'cancelling' });
    const cancelled = await deps.store.updateRun(cancelling.id, { status: 'cancelled', finished_at: new Date().toISOString() });
    sessionCardIndex.set(cancelled.session_id, cancelled.card_id);

    return reply.status(202).send({ run: cancelled });
  });

  app.get<{ Params: SessionParams }>('/v1/sessions/:sessionId', async (request, reply) => {
    if (!hasOpAccess(request.apiKey, ['session:read', 'run:read', 'card:read'])) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const session = await buildSession(deps.store, request.apiKey!, request.params.sessionId, sessionCardIndex);
    return reply.send({ session });
  });
}

function buildManifest(name: string, bot: AcpBotConfig): AgentManifest {
  return {
    name,
    description: `Agent: ${bot.agent ?? name}`,
    input_content_types: INPUT_CONTENT_TYPES,
    output_content_types: OUTPUT_CONTENT_TYPES,
  };
}

function hasOpAccess(
  apiKey: ResolvedApiKey | undefined,
  ops: string[],
): boolean {
  return Boolean(apiKey && ops.some((op) => canPerformOp(apiKey, op)));
}

function extractText(messages: AcpMessage[]): string {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is TextLikePart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function dispatchMessages(
  adapter: HttpChannelAdapter,
  message: Pick<InboundMessage, 'channelId' | 'userId' | 'username' | 'text' | 'postId'>,
): void {
  if (!message.text) {
    return;
  }

  adapter.dispatchInboundMessage({
    platform: 'http',
    channelId: message.channelId,
    userId: message.userId,
    username: message.username,
    text: message.text,
    postId: message.postId,
    mentionsBot: true,
    isDM: false,
  });
}

async function buildSession(
  store: ICardStore,
  apiKey: ResolvedApiKey,
  sessionId: string,
  sessionCardIndex: Map<string, string>,
): Promise<AcpSession> {
  const cardId = sessionCardIndex.get(sessionId);
  if (!cardId) {
    return { id: sessionId, history: [] };
  }

  const runs = await store.listRunsForCard(cardId);
  const history = runs
    .filter((run) => run.session_id === sessionId)
    .filter((run) => canAccessAgent(apiKey, run.agent_name))
    .map((run) => ({ run_id: run.id, status: normalizeRunStatus(run) }));

  return { id: sessionId, history };
}

function normalizeRunStatus(run: Run): AcpSession['history'][number]['status'] {
  return run.status as AcpSession['history'][number]['status'];
}
