import { describe, expect, it, vi } from 'vitest';
import { SseManager } from './channels/http/sse.js';
import { registerHttpSessionToolHandlers } from './index.js';

describe('registerHttpSessionToolHandlers', () => {
  it('updates the card and emits a card.status SSE event', async () => {
    const updateCard = vi.fn(async () => ({
      id: 'card-1',
      status: 'blocked',
    }));
    const sessionManager = {
      registerCustomToolHandler: vi.fn((toolName: string, handler: (channelId: string, args: Record<string, unknown>) => Promise<unknown>) => {
        registered.set(toolName, handler);
      }),
    };
    const registered = new Map<string, (channelId: string, args: Record<string, unknown>) => Promise<unknown>>();
    const sseManager = new SseManager();
    const received: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = sseManager.subscribeCard('card-1', (event) => {
      received.push({ event: event.event, data: event.data });
    });

    registerHttpSessionToolHandlers(sessionManager, { updateCard }, sseManager);

    const handler = registered.get('update_card_status');
    expect(handler).toBeDefined();

    await expect(handler?.('card-1', { status: 'blocked' })).resolves.toEqual({
      success: true,
      status: 'blocked',
    });
    expect(updateCard).toHaveBeenCalledWith('card-1', { status: 'blocked' });
    expect(received).toEqual([
      {
        event: 'card.status',
        data: { card_id: 'card-1', status: 'blocked' },
      },
    ]);

    unsubscribe();
  });

  it('creates a card and returns its id and status', async () => {
    const createCard = vi.fn(async () => ({
      id: 'card-2',
      status: 'open',
    }));
    const addLabels = vi.fn(async () => undefined);
    const sessionManager = {
      registerCustomToolHandler: vi.fn((toolName: string, handler: (channelId: string, args: Record<string, unknown>) => Promise<unknown>) => {
        registered.set(toolName, handler);
      }),
    };
    const registered = new Map<string, (channelId: string, args: Record<string, unknown>) => Promise<unknown>>();

    registerHttpSessionToolHandlers(sessionManager, { createCard, addLabels, updateCard: vi.fn() }, new SseManager());

    const handler = registered.get('create_card');
    expect(handler).toBeDefined();

    await expect(handler?.('card-1', {
      title: 'Follow up',
      description: 'Capture the task from chat',
      agent: 'bob',
      metadata: { source: 'chat' },
    })).resolves.toEqual({
      card_id: 'card-2',
      status: 'open',
    });

    expect(createCard).toHaveBeenCalledWith({
      title: 'Follow up',
      description: 'Capture the task from chat',
      agent_bot: 'bob',
      status: 'open',
      created_by: 'agent',
      metadata: { source: 'chat' },
    });
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('creates a card and adds labels when provided', async () => {
    const createCard = vi.fn(async () => ({
      id: 'card-3',
      status: 'open',
    }));
    const addLabels = vi.fn(async () => undefined);
    const sessionManager = {
      registerCustomToolHandler: vi.fn((toolName: string, handler: (channelId: string, args: Record<string, unknown>) => Promise<unknown>) => {
        registered.set(toolName, handler);
      }),
    };
    const registered = new Map<string, (channelId: string, args: Record<string, unknown>) => Promise<unknown>>();

    registerHttpSessionToolHandlers(sessionManager, { createCard, addLabels, updateCard: vi.fn() }, new SseManager());

    const handler = registered.get('create_card');
    await expect(handler?.('card-1', {
      title: 'Follow up',
      labels: ['bug', 'triage'],
    })).resolves.toEqual({
      card_id: 'card-3',
      status: 'open',
    });

    expect(addLabels).toHaveBeenCalledWith('card-3', ['bug', 'triage']);
  });

  it('rejects create_card when title is missing', async () => {
    const createCard = vi.fn(async () => ({
      id: 'card-4',
      status: 'open',
    }));
    const addLabels = vi.fn(async () => undefined);
    const sessionManager = {
      registerCustomToolHandler: vi.fn((toolName: string, handler: (channelId: string, args: Record<string, unknown>) => Promise<unknown>) => {
        registered.set(toolName, handler);
      }),
    };
    const registered = new Map<string, (channelId: string, args: Record<string, unknown>) => Promise<unknown>>();

    registerHttpSessionToolHandlers(sessionManager, { createCard, addLabels, updateCard: vi.fn() }, new SseManager());

    const handler = registered.get('create_card');
    await expect(handler?.('card-1', {})).rejects.toThrow('title is required');
    expect(createCard).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });
});
