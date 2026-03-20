import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBridgeDocs, isValidTopic, type DocRequest } from './bridge-docs.js';

// Mock config to avoid needing real config loaded
vi.mock('../config.js', () => ({
  getConfig: () => ({
    platforms: { mattermost: { url: 'https://mm.example.com', bots: { copilot: {}, alice: {} } } },
    channels: [],
    defaults: { model: 'claude-sonnet-4.6', agent: null, triggerMode: 'all' as const, threadedReplies: true, verbose: false, permissionMode: 'interactive' as const },
    logLevel: 'info',
    infiniteSessions: false,
  }),
  getChannelConfig: () => ({ platform: 'mattermost', bot: 'copilot' }),
  getChannelBotName: () => 'copilot',
  isBotAdmin: (_platform: string, botName: string) => botName === 'admin',
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeReq(overrides: Partial<DocRequest> = {}): DocRequest {
  return {
    isAdmin: false,
    channelId: 'test-channel',
    model: 'claude-sonnet-4.6',
    sessionId: 'test-session-123',
    ...overrides,
  };
}

describe('isValidTopic', () => {
  it('accepts all known topics', () => {
    const topics = ['overview', 'commands', 'config', 'mcp', 'permissions', 'workspaces',
      'hooks', 'skills', 'inter-agent', 'scheduling', 'troubleshooting', 'status'];
    for (const t of topics) {
      expect(isValidTopic(t)).toBe(true);
    }
  });

  it('rejects unknown topics', () => {
    expect(isValidTopic('banana')).toBe(false);
    expect(isValidTopic('')).toBe(false);
  });
});

describe('getBridgeDocs', () => {
  describe('no topic (default)', () => {
    it('returns topic list when no topic given', () => {
      const result = getBridgeDocs(makeReq());
      expect(result).toContain('Available topics');
      expect(result).toContain('`overview`');
      expect(result).toContain('`status`');
    });
  });

  describe('invalid topic', () => {
    it('returns error with topic list', () => {
      const result = getBridgeDocs(makeReq({ topic: 'banana' }));
      expect(result).toContain('Unknown topic');
      expect(result).toContain('banana');
      expect(result).toContain('Available topics');
    });
  });

  describe('overview topic', () => {
    it('returns overview content with source pointers', () => {
      const result = getBridgeDocs(makeReq({ topic: 'overview' }));
      expect(result).toContain('copilot-bridge');
      expect(result).toContain('Key Features');
      expect(result).toContain('Source');
    });
  });

  describe('commands topic', () => {
    it('lists slash commands', () => {
      const result = getBridgeDocs(makeReq({ topic: 'commands' }));
      expect(result).toContain('/new');
      expect(result).toContain('/model');
      expect(result).toContain('/status');
      expect(result).toContain('Source');
    });
  });

  describe('config topic', () => {
    it('shows admin edit instructions for admin', () => {
      const result = getBridgeDocs(makeReq({ topic: 'config', isAdmin: true }));
      expect(result).toContain('config.json');
      expect(result).toContain('Config file:');
    });

    it('shows non-admin guidance for non-admin', () => {
      const result = getBridgeDocs(makeReq({ topic: 'config', isAdmin: false }));
      expect(result).toContain('Ask your administrator');
    });
  });

  describe('mcp topic', () => {
    it('returns MCP content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'mcp' }));
      expect(result).toContain('MCP');
      expect(result).toContain('Source');
    });
  });

  describe('permissions topic', () => {
    it('returns permissions content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'permissions' }));
      expect(result).toContain('Permission');
      expect(result).toContain('Source');
    });
  });

  describe('workspaces topic', () => {
    it('returns workspace content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'workspaces' }));
      expect(result).toContain('Workspace');
      expect(result).toContain('Source');
    });
  });

  describe('hooks topic', () => {
    it('returns hooks content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'hooks' }));
      expect(result).toContain('hook');
      expect(result).toContain('Source');
    });
  });

  describe('skills topic', () => {
    it('returns skills content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'skills' }));
      expect(result).toContain('skill');
      expect(result).toContain('Source');
    });
  });

  describe('inter-agent topic', () => {
    it('returns inter-agent content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'inter-agent' }));
      expect(result).toContain('ask_agent');
      expect(result).toContain('Source');
    });
  });

  describe('scheduling topic', () => {
    it('returns scheduling content', () => {
      const result = getBridgeDocs(makeReq({ topic: 'scheduling' }));
      expect(result).toContain('schedule');
      expect(result).toContain('Source');
    });
  });

  describe('troubleshooting topic', () => {
    it('includes filing issues guidance', () => {
      const result = getBridgeDocs(makeReq({ topic: 'troubleshooting' }));
      expect(result).toContain('issue');
      expect(result).toContain('Source');
    });

    it('shows log guidance for admin', () => {
      const result = getBridgeDocs(makeReq({ topic: 'troubleshooting', isAdmin: true }));
      expect(result).toContain('log');
    });

    it('defers log access for non-admin', () => {
      const result = getBridgeDocs(makeReq({ topic: 'troubleshooting', isAdmin: false }));
      expect(result).toContain('Ask the user or admin');
    });
  });

  describe('status topic', () => {
    it('includes version info', () => {
      const result = getBridgeDocs(makeReq({ topic: 'status' }));
      expect(result).toContain('Version');
    });

    it('includes model and session when provided', () => {
      const result = getBridgeDocs(makeReq({ topic: 'status', model: 'test-model', sessionId: 'abc-123' }));
      expect(result).toContain('test-model');
      expect(result).toContain('abc-123');
    });

    it('shows configured bots', () => {
      const result = getBridgeDocs(makeReq({ topic: 'status' }));
      expect(result).toContain('copilot');
      expect(result).toContain('alice');
    });
  });

  describe('source pointers', () => {
    it('all static topics include source pointers', () => {
      const topics = ['overview', 'commands', 'config', 'mcp', 'permissions', 'workspaces',
        'hooks', 'skills', 'inter-agent', 'scheduling', 'troubleshooting', 'status'];
      for (const topic of topics) {
        const result = getBridgeDocs(makeReq({ topic }));
        expect(result, `topic "${topic}" should include Source section`).toContain('Source');
      }
    });
  });
});
