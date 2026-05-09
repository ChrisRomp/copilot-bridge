import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer, SseManager } from './sse.js';

describe('EventBuffer', () => {
  it('push assigns ids and since returns newer events', () => {
    const buffer = new EventBuffer();

    const first = buffer.push({ event: 'run.in-progress', data: { step: 1 } });
    const second = buffer.push({ event: 'run.completed', data: { step: 2 } });

    expect(first).toEqual({ id: '1', event: 'run.in-progress', data: { step: 1 } });
    expect(second).toEqual({ id: '2', event: 'run.completed', data: { step: 2 } });
    expect(buffer.since('1')).toEqual([second]);
    expect(buffer.since('not-a-number')).toEqual([]);
  });

  it('evicts the oldest events when the ring buffer is full', () => {
    const buffer = new EventBuffer(2);

    buffer.push({ event: 'run.in-progress', data: { step: 1 } });
    const second = buffer.push({ event: 'run.awaiting', data: { step: 2 } });
    const third = buffer.push({ event: 'run.completed', data: { step: 3 } });

    expect(buffer.since('0')).toEqual([second, third]);
    expect(buffer.since('1')).toEqual([second, third]);
  });
});

describe('SseManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits events to card listeners', () => {
    const manager = new SseManager();
    const listener = vi.fn();

    const unsubscribe = manager.subscribeCard('card-1', listener);
    manager.emit('card-1', 'run-1', { event: 'run.in-progress', data: { step: 1 } });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      id: '1',
      event: 'run.in-progress',
      data: { step: 1 },
    });

    unsubscribe();
  });

  it('emits events to run listeners', () => {
    const manager = new SseManager();
    const listener = vi.fn();

    const unsubscribe = manager.subscribeRun('run-1', listener);
    manager.emit('card-1', 'run-1', { event: 'message.completed', data: { text: 'done' } });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      id: '1',
      event: 'message.completed',
      data: { text: 'done' },
    });

    unsubscribe();
  });

  it('replays buffered card events after the provided Last-Event-ID', () => {
    const manager = new SseManager();

    manager.emit('card-1', 'run-1', { event: 'run.in-progress', data: { step: 1 } });
    const replayed = { id: '2', event: 'run.completed', data: { step: 2 } };
    manager.emit('card-1', 'run-2', { event: 'run.completed', data: { step: 2 } });
    const listener = vi.fn();

    const unsubscribe = manager.subscribeCard('card-1', listener, '1');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(replayed);

    unsubscribe();
  });

  it('stops delivering events after unsubscribe', () => {
    const manager = new SseManager();
    const listener = vi.fn();

    const unsubscribe = manager.subscribeCard('card-1', listener);
    manager.emit('card-1', 'run-1', { event: 'run.in-progress', data: { step: 1 } });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    manager.emit('card-1', 'run-1', { event: 'run.completed', data: { step: 2 } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('sends heartbeat events to active listeners', async () => {
    vi.useFakeTimers();
    const manager = new SseManager();
    const cardListener = vi.fn();
    const runListener = vi.fn();

    const unsubscribeCard = manager.subscribeCard('card-1', cardListener);
    const unsubscribeRun = manager.subscribeRun('run-1', runListener);
    manager.start();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(cardListener).toHaveBeenCalledWith({ event: 'heartbeat', data: {} });
    expect(runListener).toHaveBeenCalledWith({ event: 'heartbeat', data: {} });

    unsubscribeCard();
    unsubscribeRun();
    manager.stop();
  });
});
