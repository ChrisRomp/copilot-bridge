import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AcpMessage } from '../acp.js';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { SseManager } from '../sse.js';
import { openSseStream, serializeSseEvent } from '../sse.js';
import type { Card, CardFilter, ICardStore, NewCard } from '../store.js';
import type { InboundMessage } from '../../../types.js';

export interface CardRouteDeps {
  store: ICardStore;
  adapter: HttpChannelAdapter;
  sseManager: Pick<SseManager, 'subscribeCard'>;
}

type CardParams = { id: string };
type CardLabelParams = { id: string; label: string };

type CreateCardBody = {
  title: string;
  description?: string;
  agent?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
};

type ListCardsQuery = {
  agent?: string;
  status?: string;
  label?: string;
  type?: string;
};

type PatchCardBody = {
  status?: string;
  agent?: string | null;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

type CreateCommentBody = {
  content?: string;
};

type AddLabelsBody = {
  labels: string[];
};

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerCardRoutes(app: FastifyInstance, deps: CardRouteDeps): void {
  void deps.adapter;

  app.post<{ Body: CreateCardBody }>('/v1/cards', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:create')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = request.body;
    if (!body?.title) {
      return reply.status(400).send({ error: 'title is required' });
    }

    const newCard: NewCard = {
      title: body.title,
      description: body.description,
      created_by: apiKey.keyId,
      metadata: body.metadata,
    };

    if (body.agent) {
      if (!canAccessAgent(apiKey, body.agent)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      newCard.agent_bot = body.agent;
      newCard.status = 'in_progress';
      newCard.workspace_subdir = `card-${randomUUID()}`;
    }

    const card = await deps.store.createCard(newCard);

    if (body.labels?.length) {
      await deps.store.addLabels(card.id, body.labels);
    }

    return reply.status(201).send({ card });
  });

  app.get<{ Querystring: ListCardsQuery }>('/v1/cards', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const filter: CardFilter = {};
    const { agent, status, label, type } = request.query;

    if (agent === 'none') {
      filter.agent_bot = null;
    } else if (agent) {
      filter.agent_bot = agent;
    }
    if (status) {
      filter.status = status;
    }
    if (label) {
      filter.label = label;
    }
    if (type === 'work' || type === 'chat') {
      filter.type = type;
    }

    const cards = await deps.store.listCards(filter);
    return { cards };
  });

  app.get<{ Params: CardParams }>('/v1/cards/:id', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    const [runs, comments] = await Promise.all([
      deps.store.listRunsForCard(card.id),
      deps.store.listComments(card.id),
    ]);

    return { card, runs, comments };
  });

  app.get<{ Params: CardParams }>('/v1/cards/:id/events', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { id } = request.params;
    const card = await getCardOrReply(deps.store, id, reply);
    if (!card) {
      return;
    }
    if (card.agent_bot && !canAccessAgent(apiKey, card.agent_bot)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const lastEventId = request.headers['last-event-id'];
    openSseStream(reply);

    const unsubscribe = deps.sseManager.subscribeCard(
      id,
      (event) => {
        reply.raw.write(serializeSseEvent(event));
      },
      typeof lastEventId === 'string' ? lastEventId : undefined,
    );

    request.raw.once('close', () => {
      unsubscribe();
    });
  });

  app.patch<{ Params: CardParams; Body: PatchCardBody }>('/v1/cards/:id', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    const body = request.body ?? {};
    const patch: Partial<Card> = {};

    if (body.title !== undefined) {
      patch.title = body.title;
    }
    if (body.description !== undefined) {
      patch.description = body.description;
    }
    if (body.status !== undefined) {
      patch.status = body.status;
    }
    if (body.metadata !== undefined) {
      patch.metadata = body.metadata;
    }

    if (body.agent !== undefined && body.agent !== card.agent_bot) {
      if (body.agent === null) {
        if (card.agent_bot && !canAccessAgent(apiKey, card.agent_bot)) {
          return reply.status(403).send({ error: 'Forbidden' });
        }
        await cancelActiveRuns(deps.store, card.id);
        patch.agent_bot = null;
      } else {
        if (!canAccessAgent(apiKey, body.agent)) {
          return reply.status(403).send({ error: 'Forbidden' });
        }
        patch.agent_bot = body.agent;
        patch.status = 'in_progress';
        patch.workspace_subdir = `card-${randomUUID()}`;
      }
    }

    const updated = await deps.store.updateCard(card.id, patch);
    return { card: updated };
  });

  app.post<{ Params: CardParams; Body: CreateCommentBody }>('/v1/cards/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body ?? {};
    const apiKey = request.apiKey!;

    const card = await getCardOrReply(deps.store, id, reply);
    if (!card) {
      return;
    }
    if (!card.agent_bot) {
      return reply.status(400).send({ error: 'Card has no assigned agent' });
    }

    if (!canPerformOp(apiKey, 'card:comment')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!canAccessAgent(apiKey, card.agent_bot)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!content) {
      return reply.status(400).send({ error: 'content is required' });
    }

    const input = createUserMessage(content);
    const comment = await deps.store.addComment({
      card_id: id,
      author_kind: 'human',
      author_id: apiKey.keyId,
      content: JSON.stringify(input[0]),
    });

    const run = await deps.store.createRun({
      card_id: id,
      session_id: id,
      agent_name: card.agent_bot,
      input,
    });

    dispatchCardComment(deps.adapter, {
      channelId: card.channel_id ?? id,
      userId: apiKey.keyId,
      username: apiKey.keyId,
      text: content,
      postId: comment.id,
    });

    return reply.status(201).send({ comment, run_id: run.id });
  });

  app.post<{ Params: CardParams; Body: AddLabelsBody }>('/v1/cards/:id/labels', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    const { labels } = (request.body ?? {}) as { labels?: string[] };
    if (!labels?.length) {
      return reply.status(400).send({ error: 'labels is required' });
    }

    await deps.store.addLabels(card.id, labels);
    const cardLabels = await deps.store.getLabels(card.id);
    return { labels: cardLabels };
  });

  app.delete<{ Params: CardLabelParams }>('/v1/cards/:id/labels/:label', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    await deps.store.removeLabel(card.id, request.params.label);
    return reply.status(204).send();
  });

  app.post<{ Params: CardParams }>('/v1/cards/:id/archive', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    await cancelActiveRuns(deps.store, card.id);
    const updated = await deps.store.updateCard(card.id, { status: 'archived' });

    return { card: updated };
  });

  app.delete<{ Params: CardParams }>('/v1/cards/:id', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:delete')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await getCardOrReply(deps.store, request.params.id, reply);
    if (!card) {
      return;
    }

    await cancelActiveRuns(deps.store, card.id);
    await deps.store.deleteCard(card.id);

    return reply.status(204).send();
  });
}

async function cancelActiveRuns(store: ICardStore, cardId: string): Promise<void> {
  const runs = await store.listRunsForCard(cardId);

  await Promise.all(
    runs
      .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
      .map((run) => store.updateRun(run.id, { status: 'cancelled' })),
  );
}

async function getCardOrReply(
  store: ICardStore,
  cardId: string,
  reply: FastifyReply,
): Promise<Card | null> {
  const card = await store.getCard(cardId);
  if (!card) {
    reply.status(404).send({ error: 'Card not found' });
    return null;
  }
  return card;
}

function createUserMessage(content: string): AcpMessage[] {
  return [{ role: 'user', parts: [{ type: 'text', text: content }] }];
}

function dispatchCardComment(
  adapter: HttpChannelAdapter,
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
    isDM: false,
  });
}
