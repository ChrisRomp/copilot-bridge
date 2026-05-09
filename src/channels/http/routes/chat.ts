import type { FastifyInstance, FastifyReply } from 'fastify';
import { canAccessAgent } from '../auth.js';
import type { AcpMessage } from '../acp.js';
import type { HttpChannelAdapter } from '../index.js';
import type { Card, ICardStore } from '../store.js';
import type { InboundMessage } from '../../../types.js';

export interface ChatRouteDeps {
  store: ICardStore;
  adapter: Pick<HttpChannelAdapter, 'dispatchInboundMessage'>;
}

type AgentParams = { name: string };
type ChatParams = { name: string; sessionId: string };

type ChatBody = {
  message?: string;
  session_id?: string;
};

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.post<{ Params: AgentParams; Body: ChatBody }>('/v1/agents/:name/chat', async (request, reply) => {
    const apiKey = request.apiKey!;
    const { name } = request.params;
    if (!canAccessAgent(apiKey, name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { message, session_id: sessionId } = request.body ?? {};
    if (!message) {
      return reply.status(400).send({ error: 'message is required' });
    }

    let card: Card | null;
    if (sessionId) {
      card = await getChatCardForAgent(deps.store, sessionId, name, reply);
      if (!card) {
        return;
      }
    } else {
      card = await deps.store.createCard({
        title: message.slice(0, 100) || 'Chat session',
        type: 'chat',
        agent_bot: name,
        status: 'in_progress',
        created_by: apiKey.keyId,
        workspace_subdir: null,
      });
    }

    const input = createUserMessage(message);
    const comment = await deps.store.addComment({
      card_id: card.id,
      author_kind: 'human',
      author_id: apiKey.keyId,
      content: JSON.stringify(input[0]),
    });
    const run = await deps.store.createRun({
      card_id: card.id,
      session_id: card.id,
      agent_name: name,
      input,
    });

    dispatchChatMessage(deps.adapter, {
      channelId: card.id,
      userId: apiKey.keyId,
      username: apiKey.keyId,
      text: message,
      postId: comment.id,
    });

    return reply.status(201).send({ session_id: card.id, run_id: run.id });
  });

  app.get<{ Params: ChatParams }>('/v1/agents/:name/chat/:sessionId', async (request, reply) => {
    const apiKey = request.apiKey!;
    const { name, sessionId } = request.params;
    if (!canAccessAgent(apiKey, name)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getChatCardForAgent(deps.store, sessionId, name, reply);
    if (!card) {
      return;
    }

    const history = await deps.store.listComments(card.id);
    return { history };
  });
}

async function getChatCardForAgent(
  store: ICardStore,
  sessionId: string,
  agentName: string,
  reply: FastifyReply,
): Promise<Card | null> {
  const card = await store.getCard(sessionId);
  if (!card || card.type !== 'chat' || card.agent_bot !== agentName) {
    reply.status(404).send({ error: 'Chat session not found' });
    return null;
  }
  return card;
}

function createUserMessage(content: string): AcpMessage[] {
  return [{ role: 'user', parts: [{ type: 'text', text: content }] }];
}

function dispatchChatMessage(
  adapter: Pick<HttpChannelAdapter, 'dispatchInboundMessage'>,
  message: Pick<InboundMessage, 'channelId' | 'userId' | 'username' | 'text' | 'postId'>,
): void {
  adapter.dispatchInboundMessage({
    platform: 'http',
    channelId: message.channelId,
    userId: message.userId,
    username: message.username,
    text: message.text,
    postId: message.postId,
    mentionsBot: true,
    isDM: true,
  });
}
