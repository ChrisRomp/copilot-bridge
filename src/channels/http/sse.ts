import type { FastifyReply } from 'fastify';
import { createLogger } from '../../logger.js';
import type { SseEvent } from './acp.js';

const log = createLogger('http-sse');

type SseListener = (event: SseEvent) => void;
type BufferedSseEvent = SseEvent & { id: string };

/**
 * In-memory ring buffer per card. Stores events for Last-Event-ID replay.
 */
export class EventBuffer {
  private readonly maxEvents: number;
  private readonly events: BufferedSseEvent[] = [];
  private nextId = 1;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  push(event: Omit<SseEvent, 'id'>): BufferedSseEvent {
    const full: BufferedSseEvent = { ...event, id: String(this.nextId++) };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    return full;
  }

  since(lastEventId: string): BufferedSseEvent[] {
    const id = Number.parseInt(lastEventId, 10);
    if (Number.isNaN(id)) {
      return [];
    }
    return this.events.filter((event) => Number.parseInt(event.id, 10) > id);
  }
}

/**
 * Manages SSE connections and event distribution for cards and runs.
 */
export class SseManager {
  private readonly cardBuffers = new Map<string, EventBuffer>();
  private readonly cardListeners = new Map<string, Set<SseListener>>();
  private readonly runListeners = new Map<string, Set<SseListener>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly maxEventsPerCard: number;

  constructor(maxEventsPerCard = 1000) {
    this.maxEventsPerCard = maxEventsPerCard;
  }

  start(): void {
    if (this.heartbeatInterval) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      const event: SseEvent = { event: 'heartbeat', data: {} };
      this.broadcast(this.cardListeners, event);
      this.broadcast(this.runListeners, event);
    }, 15_000);
    this.heartbeatInterval.unref?.();
    log.debug('Started SSE heartbeat interval');
  }

  stop(): void {
    if (!this.heartbeatInterval) {
      return;
    }

    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    log.debug('Stopped SSE heartbeat interval');
  }

  emit(cardId: string, runId: string, event: Omit<SseEvent, 'id'>): void {
    const buffer = this.getOrCreateBuffer(cardId);
    const full = buffer.push(event);

    this.broadcast(this.cardListeners, full, cardId);
    this.broadcast(this.runListeners, full, runId);
  }

  subscribeCard(cardId: string, listener: SseListener, lastEventId?: string): () => void {
    if (lastEventId) {
      const buffer = this.cardBuffers.get(cardId);
      if (buffer) {
        for (const event of buffer.since(lastEventId)) {
          listener(event);
        }
      }
    }

    this.addListener(this.cardListeners, cardId, listener);
    return () => this.removeListener(this.cardListeners, cardId, listener);
  }

  subscribeRun(runId: string, listener: SseListener): () => void {
    this.addListener(this.runListeners, runId, listener);
    return () => this.removeListener(this.runListeners, runId, listener);
  }

  private getOrCreateBuffer(cardId: string): EventBuffer {
    const existing = this.cardBuffers.get(cardId);
    if (existing) {
      return existing;
    }

    const created = new EventBuffer(this.maxEventsPerCard);
    this.cardBuffers.set(cardId, created);
    return created;
  }

  private addListener(
    listeners: Map<string, Set<SseListener>>,
    id: string,
    listener: SseListener,
  ): void {
    const existing = listeners.get(id) ?? new Set<SseListener>();
    existing.add(listener);
    listeners.set(id, existing);
  }

  private removeListener(
    listeners: Map<string, Set<SseListener>>,
    id: string,
    listener: SseListener,
  ): void {
    const existing = listeners.get(id);
    if (!existing) {
      return;
    }

    existing.delete(listener);
    if (existing.size === 0) {
      listeners.delete(id);
    }
  }

  private broadcast(
    listeners: Map<string, Set<SseListener>>,
    event: SseEvent,
    id?: string,
  ): void {
    if (id) {
      for (const listener of listeners.get(id) ?? []) {
        listener(event);
      }
      return;
    }

    for (const scopedListeners of listeners.values()) {
      for (const listener of scopedListeners) {
        listener(event);
      }
    }
  }
}

export function serializeSseEvent(event: SseEvent): string {
  const idLine = event.id ? `id: ${event.id}\n` : '';
  return `${idLine}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function openSseStream(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.flushHeaders?.();
}
