import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { Card, CardFilter, ICardStore, NewCard } from '../store.js';

export interface CardRouteDeps {
  store: ICardStore;
  adapter: HttpChannelAdapter;
}

type CardParams = { id: string };

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

    const card = await deps.store.getCard(request.params.id);
    if (!card) {
      return reply.status(404).send({ error: 'Card not found' });
    }

    const [runs, comments] = await Promise.all([
      deps.store.listRunsForCard(card.id),
      deps.store.listComments(card.id),
    ]);

    return { card, runs, comments };
  });

  app.patch<{ Params: CardParams; Body: PatchCardBody }>('/v1/cards/:id', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await deps.store.getCard(request.params.id);
    if (!card) {
      return reply.status(404).send({ error: 'Card not found' });
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

  app.post<{ Params: CardParams }>('/v1/cards/:id/archive', async (request, reply) => {
    const apiKey = request.apiKey!;
    if (!canPerformOp(apiKey, 'card:update')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const card = await deps.store.getCard(request.params.id);
    if (!card) {
      return reply.status(404).send({ error: 'Card not found' });
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

    const card = await deps.store.getCard(request.params.id);
    if (!card) {
      return reply.status(404).send({ error: 'Card not found' });
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
