import type { AcpMessage, SseEvent, TrajectoryMetadata } from './acp.js';
import type { ICardStore, NewSessionTurn } from './store.js';

export interface AgentHarnessAdapter {
  handleSdkEvent(
    cardId: string,
    runId: string,
    event: SdkEvent,
  ): Promise<SseEvent | null>;

  finalizeRun(cardId: string, runId: string): Promise<AcpMessage[]>;
}

export interface SdkEvent {
  type: string;
  data?: unknown;
}

interface PendingToolCall {
  cardId: string;
  runId: string;
  tool_name: string;
  tool_input: unknown;
  startedAt: string;
}

interface MessagePayload {
  content?: unknown;
}

interface DeltaPayload {
  delta?: unknown;
  deltaContent?: unknown;
}

interface ToolStartPayload {
  toolCallId?: unknown;
  toolName?: unknown;
  name?: unknown;
  arguments?: unknown;
}

interface ToolCompletePayload {
  toolCallId?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CopilotHarnessAdapter implements AgentHarnessAdapter {
  private readonly turnCounters = new Map<string, number>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly runMessages = new Map<string, AcpMessage[]>();
  private readonly eventCounters = new Map<string, number>();

  constructor(private readonly store: ICardStore) {}

  async handleSdkEvent(
    cardId: string,
    runId: string,
    event: SdkEvent,
  ): Promise<SseEvent | null> {
    switch (event.type) {
      case 'user.message':
        return this.handleUserMessage(cardId, runId, event.data);
      case 'assistant.message':
        return this.handleAssistantMessage(cardId, runId, event.data);
      case 'assistant.message_delta':
        return this.handleAssistantDelta(runId, event.data);
      case 'tool.execution_start':
        return this.handleToolStart(cardId, runId, event.data);
      case 'tool.execution_complete':
        return this.handleToolComplete(cardId, runId, event.data);
      case 'session.idle':
        return null;
      default:
        return null;
    }
  }

  async finalizeRun(cardId: string, runId: string): Promise<AcpMessage[]> {
    const messages = this.runMessages.get(runId) ?? [];
    this.runMessages.delete(runId);
    this.eventCounters.delete(runId);

    for (const [toolCallId, pending] of this.pendingToolCalls.entries()) {
      if (pending.cardId === cardId && pending.runId === runId) {
        this.pendingToolCalls.delete(toolCallId);
      }
    }

    return messages;
  }

  private async handleUserMessage(cardId: string, runId: string, data: unknown): Promise<SseEvent> {
    const message = this.createTextMessage('user', this.readContent(data));
    await this.persistTurn(cardId, runId, 'user', message);
    return this.createSseEvent(runId, 'message.created', message);
  }

  private async handleAssistantMessage(cardId: string, runId: string, data: unknown): Promise<SseEvent> {
    const message = this.createTextMessage('assistant', this.readContent(data));
    await this.persistTurn(cardId, runId, 'assistant', message);
    this.appendRunMessage(runId, message);
    return this.createSseEvent(runId, 'message.completed', message);
  }

  private async handleAssistantDelta(runId: string, data: unknown): Promise<SseEvent> {
    const payload = data as DeltaPayload | undefined;
    const delta = this.readString(payload?.delta ?? payload?.deltaContent);
    return this.createSseEvent(runId, 'message.part', { delta });
  }

  private async handleToolStart(cardId: string, runId: string, data: unknown): Promise<SseEvent | null> {
    const payload = data as ToolStartPayload | undefined;
    const toolCallId = this.readString(payload?.toolCallId);
    if (!toolCallId) {
      return null;
    }

    const metadata: TrajectoryMetadata = {
      tool_name: this.readString(payload?.toolName ?? payload?.name) || 'unknown',
      tool_input: payload?.arguments,
      tool_call_id: toolCallId,
      status: 'in_progress',
    };

    this.pendingToolCalls.set(toolCallId, {
      cardId,
      runId,
      tool_name: metadata.tool_name,
      tool_input: metadata.tool_input,
      startedAt: new Date().toISOString(),
    });

    const part = { type: 'trajectory' as const, metadata };
    await this.persistTurn(cardId, runId, 'tool_call', metadata);
    return this.createSseEvent(runId, 'message.part', part);
  }

  private async handleToolComplete(cardId: string, runId: string, data: unknown): Promise<SseEvent | null> {
    const payload = data as ToolCompletePayload | undefined;
    const toolCallId = this.readString(payload?.toolCallId);
    if (!toolCallId) {
      return null;
    }

    const pending = this.pendingToolCalls.get(toolCallId);
    if (!pending) {
      return null;
    }
    this.pendingToolCalls.delete(toolCallId);

    const toolOutput = payload?.error ?? payload?.result ?? null;
    const metadata: TrajectoryMetadata = {
      tool_name: pending.tool_name,
      tool_input: pending.tool_input,
      tool_output: toolOutput,
      tool_call_id: toolCallId,
      status: payload?.error === undefined ? 'completed' : 'error',
    };

    const part = { type: 'trajectory' as const, metadata };
    const message: AcpMessage = {
      role: 'assistant',
      parts: [part],
    };

    await this.persistTurn(cardId, runId, 'tool_result', metadata);
    this.appendRunMessage(runId, message);
    return this.createSseEvent(runId, 'message.part', part);
  }

  private appendRunMessage(runId: string, message: AcpMessage): void {
    const messages = this.runMessages.get(runId) ?? [];
    messages.push(message);
    this.runMessages.set(runId, messages);
  }

  private async persistTurn(
    cardId: string,
    runId: string,
    role: NewSessionTurn['role'],
    content: unknown,
  ): Promise<void> {
    await this.store.appendTurn({
      card_id: cardId,
      run_id: runId,
      turn_index: this.nextTurnIndex(cardId),
      role,
      content: JSON.stringify(content),
    });
  }

  private createTextMessage(role: 'user' | 'assistant', text: string): AcpMessage {
    return {
      role,
      parts: [{ type: 'text', text }],
    };
  }

  private createSseEvent(runId: string, event: SseEvent['event'], data: unknown): SseEvent {
    return {
      id: this.nextEventId(runId),
      event,
      data,
    };
  }

  private nextEventId(runId: string): string {
    const current = this.eventCounters.get(runId) ?? 0;
    this.eventCounters.set(runId, current + 1);
    return `${runId}:${current}`;
  }

  private nextTurnIndex(cardId: string): number {
    const current = this.turnCounters.get(cardId) ?? 0;
    this.turnCounters.set(cardId, current + 1);
    return current;
  }

  private readContent(data: unknown): string {
    return this.readString((data as MessagePayload | undefined)?.content);
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
