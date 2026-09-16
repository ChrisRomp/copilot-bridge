import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { App } from '@slack/bolt';
import { SlackAdapter, chunkMessage } from './adapter.js';

describe('SlackAdapter with the installed Bolt SDK', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let adapter: SlackAdapter;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({
      ok: true,
      user_id: 'U_TEST',
      user: 'test-bot',
      bot_id: 'B_TEST',
      team_id: 'T_TEST',
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(App.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(App.prototype, 'stop').mockResolvedValue(undefined);
    adapter = new SlackAdapter({
      platformName: 'slack',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
    });
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('constructs a Socket Mode app and authenticates through the SDK transport', async () => {
    await adapter.connect();

    expect(adapter.getBotUserId()).toBe('U_TEST');
    expect(App.prototype.start).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/auth.test',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends threaded messages through the SDK transport', async () => {
    await adapter.connect();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, ts: '123.456' }));

    await expect(adapter.sendMessage('C_TEST', 'Hello', {
      threadRootId: '123.000',
    })).resolves.toBe('123.456');

    const [url, options] = fetchMock.mock.lastCall!;
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const body = new URLSearchParams(String(options?.body));
    expect(body.get('channel')).toBe('C_TEST');
    expect(body.get('text')).toBe('Hello');
    expect(body.get('thread_ts')).toBe('123.000');
  });

  it('preserves handling of SDK platform errors', async () => {
    await adapter.connect();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: 'msg_too_old' }));
    await expect(adapter.updateMessage('C_TEST', '123.456', 'Updated')).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: 'message_not_found' }));
    await expect(adapter.deleteMessage('C_TEST', '123.456')).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: 'channel_not_found' }));
    await expect(adapter.updateMessage('C_TEST', '123.456', 'Updated')).rejects.toMatchObject({
      data: { error: 'channel_not_found' },
    });
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = chunkMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('returns single chunk for exactly max length', () => {
    const msg = 'x'.repeat(100);
    const result = chunkMessage(msg, 100);
    expect(result).toEqual([msg]);
  });

  it('splits on newline when possible', () => {
    const line1 = 'a'.repeat(50);
    const line2 = 'b'.repeat(50);
    const msg = `${line1}\n${line2}`;
    const result = chunkMessage(msg, 60);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it('splits on space when no newline available', () => {
    const msg = 'word '.repeat(20).trim(); // 99 chars
    const result = chunkMessage(msg, 50);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be within limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Joined content should match (accounting for split whitespace)
    expect(result.join(' ').replace(/\s+/g, ' ')).toBe(msg.replace(/\s+/g, ' '));
  });

  it('hard splits when no good break point', () => {
    const msg = 'x'.repeat(200);
    const result = chunkMessage(msg, 80);
    expect(result.length).toBe(3); // 80 + 80 + 40
    expect(result[0].length).toBe(80);
    expect(result[1].length).toBe(80);
    expect(result[2].length).toBe(40);
  });

  it('handles empty string', () => {
    const result = chunkMessage('');
    expect(result).toEqual(['']);
  });

  it('preserves content across chunks', () => {
    const msg = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n');
    const result = chunkMessage(msg, 100);
    const rejoined = result.join('\n');
    // All original lines should be present
    for (let i = 0; i < 50; i++) {
      expect(rejoined).toContain(`Line ${i}`);
    }
  });

  it('uses default max length when not specified', () => {
    const msg = 'x'.repeat(3900);
    const result = chunkMessage(msg);
    expect(result).toHaveLength(1);

    const longMsg = 'x'.repeat(3901);
    const longResult = chunkMessage(longMsg);
    expect(longResult.length).toBeGreaterThan(1);
  });
});
