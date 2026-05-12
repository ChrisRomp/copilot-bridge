import type { SessionEvent } from '@github/copilot-sdk';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../../../logger.js';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { RunRegistry, RunStatus } from '../run-registry.js';
import { mapSdkEventToAcp, type AcpEvent } from './runs-events.js';

const log = createLogger('runs-stream');

export interface RunStreamRouteDeps {
  runRegistry: RunRegistry;
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: any) => void
  ) => () => void;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
}

export function registerRunStreamRoutes(app: FastifyInstance, deps: RunStreamRouteDeps): void {
  app.get<{ Params: { run_id: string } }>('/runs/:run_id/stream', async (request, reply) => {
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

    writeStreamHeaders(reply);
    reply.hijack();

    if (isTerminalStatus(entry.status)) {
      try {
        if (entry.sessionEvents) {
          for (const event of entry.sessionEvents) {
            if (!isTerminalSdkEvent(event)) {
              writeAcpEvent(reply.raw, mapSdkEventToAcp(event as SessionEvent, entry.runId));
            }
          }
        } else {
          const session = deps.getSession(entry.sdkSessionId ?? entry.runId);
          try {
            const sdkEvents = await session?.getMessages() ?? [];
            for (const event of sdkEvents) {
              if (!isTerminalSdkEvent(event)) {
                writeAcpEvent(reply.raw, mapSdkEventToAcp(event, entry.runId));
              }
            }
          } catch (error) {
            log.warn('Failed to replay terminal run events', { runId: entry.runId, error });
          }
        }
        writeAcpEvent(reply.raw, terminalEvent(entry.status, entry.runId, entry.error));
      } catch (error) {
        log.warn('Failed to write terminal run stream', { runId: entry.runId, error });
      } finally {
        reply.raw.end();
      }
      return;
    }

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    deps.runRegistry.setEmitter(entry.runId, (event) => {
      if (closed) return;
      const acpEvent = event as AcpEvent;
      writeAcpEvent(reply.raw, acpEvent);
      if (isTerminalAcpEvent(acpEvent)) {
        close();
      }
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      deps.runRegistry.setEmitter(entry.runId, () => undefined);
      reply.raw.end();
    };

    unsubscribe = deps.subscribeToSessionEvents(entry.channelId, (_sessionId, channelId, event) => {
      if (closed || channelId !== entry.channelId || !deps.runRegistry.isActiveRun(entry.runId)) {
        return;
      }

      writeAcpEvent(reply.raw, mapSdkEventToAcp(event as SessionEvent, entry.runId));

      if (event?.type === 'session.idle' || event?.type === 'session.error') {
        close();
      }
    });

    request.raw.on('close', () => {
      log.debug('Run stream client disconnected', { runId: entry.runId });
      close();
    });
  });
}

function writeStreamHeaders(reply: { raw: { writeHead: (statusCode: number, headers: Record<string, string>) => void } }): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeAcpEvent(raw: { write: (chunk: string) => void }, acpEvent: AcpEvent | undefined): void {
  if (!acpEvent) return;
  raw.write(`event: ${acpEvent.type}\ndata: ${JSON.stringify(acpEvent.data ?? {})}\n\n`);
}

function isTerminalStatus(status: RunStatus): status is Extract<RunStatus, 'completed' | 'failed' | 'cancelled'> {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalSdkEvent(event: { type?: string }): boolean {
  return event.type === 'session.idle' || event.type === 'session.error';
}

function isTerminalAcpEvent(event: { type?: string }): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed';
}

function terminalEvent(status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>, runId: string, error?: string): AcpEvent {
  if (status === 'completed') {
    return { type: 'run.completed', data: { run_id: runId } };
  }
  if (status === 'cancelled') {
    return { type: 'run.failed', data: { run_id: runId, error: error ?? 'cancelled' } };
  }
  return { type: 'run.failed', data: { run_id: runId, error: error ?? '' } };
}
