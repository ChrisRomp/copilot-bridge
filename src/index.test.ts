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
});
