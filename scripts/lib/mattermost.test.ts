import { describe, it, expect } from 'vitest';
import { pingServer, validateBotToken, checkChannelAccess } from './mattermost.js';

describe('mattermost validation', () => {
  describe('pingServer', () => {
    it('fails for unreachable server', async () => {
      const result = await pingServer('http://localhost:19999');
      expect(result.status).toBe('fail');
      expect(result.label).toContain('localhost:19999');
    });

    it('fails for invalid URL', async () => {
      const result = await pingServer('not-a-url');
      expect(result.status).toBe('fail');
    });
  });

  describe('validateBotToken', () => {
    it('fails for unreachable server', async () => {
      const { result } = await validateBotToken('http://localhost:19999', 'fake-token');
      expect(result.status).toBe('fail');
    });
  });

  describe('checkChannelAccess', () => {
    it('fails for unreachable server', async () => {
      const result = await checkChannelAccess('http://localhost:19999', 'fake-token', 'channel-id');
      expect(result.status).toBe('fail');
    });
  });
});
