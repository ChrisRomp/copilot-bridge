import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallbackRegistry } from './callback-registry.js';
import { CallbackDelivery, extractContent } from './callback-delivery.js';

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockLog,
}));

const callbackUrl = 'https://example.com/callback';
const channelId = 'channel-1';

function registerCallback(registry: CallbackRegistry, callbackToken?: string): void {
  registry.register(channelId, {
    callbackUrl,
    runId: 'run-1',
    bot: 'bob',
    callbackToken,
  });
}

function createDelivery(): { registry: CallbackRegistry; delivery: CallbackDelivery } {
  const registry = new CallbackRegistry();
  registerCallback(registry);
  return { registry, delivery: new CallbackDelivery(registry) };
}

function stubFetch(response: Partial<Response> = { ok: true, status: 200, statusText: 'OK' }) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectJsonPost(
  fetchMock: ReturnType<typeof vi.fn>,
  body: Record<string, unknown>,
  expectedHeaders?: Record<string, string>,
): void {
  const headers = { 'content-type': 'application/json', ...expectedHeaders };
  expect(fetchMock).toHaveBeenCalledWith(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('CallbackDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns false when no callback is registered for the channel', async () => {
    const delivery = new CallbackDelivery(new CallbackRegistry());

    await expect(delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'hello' } }))
      .resolves.toBe(false);
  });

  it('accumulates content from assistant.message events and returns true', async () => {
    const fetchMock = stubFetch();
    const { delivery } = createDelivery();

    await expect(delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'hello' } }))
      .resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('absorbs assistant.message_delta events, returns true, and does not accumulate', async () => {
    const fetchMock = stubFetch();
    const { registry, delivery } = createDelivery();

    await expect(delivery.handleEvent(channelId, { type: 'assistant.message_delta', data: { text: 'partial' } }))
      .resolves.toBe(true);
    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registry.get(channelId)).toBeUndefined();
  });

  it('POSTs accumulated content to callback URL and unregisters on session.idle', async () => {
    const fetchMock = stubFetch();
    const { registry, delivery } = createDelivery();

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'done' } });
    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expectJsonPost(fetchMock, {
      run_id: 'run-1',
      content: 'done',
      session_id: channelId,
      status: 'completed',
    });
    expect(registry.get(channelId)).toBeUndefined();
  });

  it('includes Authorization header when callbackToken is set', async () => {
    const fetchMock = stubFetch();
    const registry = new CallbackRegistry();
    registerCallback(registry, 'secret-token');
    const delivery = new CallbackDelivery(registry);

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'done' } });
    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expectJsonPost(fetchMock, {
      run_id: 'run-1',
      content: 'done',
      session_id: channelId,
      status: 'completed',
    }, { authorization: 'Bearer secret-token' });
  });

  it('omits Authorization header when callbackToken is not set', async () => {
    const fetchMock = stubFetch();
    const { delivery } = createDelivery();

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'done' } });
    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expectJsonPost(fetchMock, {
      run_id: 'run-1',
      content: 'done',
      session_id: channelId,
      status: 'completed',
    });
  });

  it('POSTs error to callback URL and unregisters on session.error', async () => {
    const fetchMock = stubFetch();
    const { registry, delivery } = createDelivery();

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'discard me' } });
    await expect(delivery.handleEvent(channelId, { type: 'session.error', data: { error: 'boom' } }))
      .resolves.toBe(true);

    expectJsonPost(fetchMock, {
      run_id: 'run-1',
      content: '',
      session_id: channelId,
      status: 'failed',
      error: 'boom',
    });
    expect(registry.get(channelId)).toBeUndefined();
  });

  it('accumulates multiple assistant.message events joined with double newline', async () => {
    const fetchMock = stubFetch();
    const { delivery } = createDelivery();

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'first' } });
    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { text: 'second' } });
    await delivery.handleEvent(channelId, { type: 'session.idle' });

    expectJsonPost(fetchMock, {
      run_id: 'run-1',
      content: 'first\n\nsecond',
      session_id: channelId,
      status: 'completed',
    });
  });

  it('does not post but still unregisters on session.idle with no accumulated content', async () => {
    const fetchMock = stubFetch();
    const { registry, delivery } = createDelivery();

    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registry.get(channelId)).toBeUndefined();
  });

  it('absorbs other event types silently', async () => {
    const fetchMock = stubFetch();
    const { delivery } = createDelivery();

    await expect(delivery.handleEvent(channelId, { type: 'session.started', data: { id: 'session-1' } }))
      .resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs fetch failures and does not throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { registry, delivery } = createDelivery();

    await delivery.handleEvent(channelId, { type: 'assistant.message', data: { content: 'done' } });
    await expect(delivery.handleEvent(channelId, { type: 'session.idle' })).resolves.toBe(true);

    expect(mockLog.error).toHaveBeenCalledWith('Callback POST threw', expect.any(Error));
    expect(registry.get(channelId)).toBeUndefined();
  });

  it('extractContent handles string content, array content with text parts, and data.text', () => {
    expect(extractContent({ content: 'hello' })).toBe('hello');
    expect(extractContent({ content: '' })).toBeNull();
    expect(extractContent({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'image', text: 'ignored' },
        { type: 'text', text: 'world' },
      ],
    })).toBe('hello world');
    expect(extractContent({ text: 'fallback' })).toBe('fallback');
    expect(extractContent(undefined)).toBeNull();
  });
});
