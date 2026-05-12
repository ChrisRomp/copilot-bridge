import type { FastifyInstance } from 'fastify';
import type { SessionEvent } from '@github/copilot-sdk';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { RunRegistry } from '../run-registry.js';

export type AcpEvent = { type: string; data?: Record<string, unknown>; id?: string; timestamp?: string };

export interface RunEventsRouteDeps {
  runRegistry: RunRegistry;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
}

export function mapSdkEventToAcp(event: SessionEvent, runId: string): AcpEvent | undefined {
  const type = getEventType(event);
  const data = getEventData(event);
  let mapped: AcpEvent | undefined;

  switch (type) {
    case 'assistant.message':
      mapped = {
        type: 'message.completed',
        data: { role: 'agent', content: readString(data, 'content') },
      };
      break;
    case 'assistant.message_delta':
      mapped = {
        type: 'message.part',
        data: { role: 'agent', content: readString(data, 'deltaContent') },
      };
      break;
    case 'session.idle':
      mapped = {
        type: 'run.completed',
        data: { run_id: runId },
      };
      break;
    case 'session.error':
      mapped = {
        type: 'run.failed',
        data: { run_id: runId, error: readString(data, 'message', 'error') },
      };
      break;
    case 'bridge.permission_request':
      mapped = {
        type: 'run.awaiting',
        data: { run_id: runId, tool: readString(data, 'toolName', 'tool', 'name') },
      };
      break;
    default:
      return undefined;
  }

  const id = readEventString(event, 'id');
  const timestamp = readEventString(event, 'timestamp');
  if (id) mapped.id = id;
  if (timestamp) mapped.timestamp = timestamp;
  return mapped;
}

export function registerRunEventsRoutes(app: FastifyInstance, deps: RunEventsRouteDeps): void {
  app.get<{ Params: { run_id: string } }>('/runs/:run_id/events', async (request, reply) => {
    if (!request.apiKey) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }
    if (!canPerformOp(request.apiKey, 'agent:execute')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const entry = deps.runRegistry.get(request.params.run_id);
    if (!entry) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (!canAccessAgent(request.apiKey, entry.bot)) {
      return reply.status(403).send({ error: 'Not authorized for this agent' });
    }

    const session = deps.getSession(entry.runId);
    if (!session) {
      return reply.status(200).send({ events: [] });
    }

    const sdkEvents = await session.getMessages();
    const events = sdkEvents.flatMap((event) => {
      const acpEvent = mapSdkEventToAcp(event, entry.runId);
      return acpEvent ? [acpEvent] : [];
    });

    return reply.status(200).send({ events });
  });
}

function getEventType(event: SessionEvent): string {
  return readEventString(event, 'type');
}

function getEventData(event: SessionEvent): Record<string, unknown> {
  const data = (event as { data?: unknown }).data;
  return isRecord(data) ? data : {};
}

function readEventString(event: SessionEvent, key: string): string {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function readString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
