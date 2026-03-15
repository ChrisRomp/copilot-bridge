import { describe, it, expect } from 'vitest';
import { formatEvent, formatPermissionRequest } from './stream-formatter.js';

describe('formatEvent', () => {
  describe('thinking/reasoning suppression', () => {
    it('returns null for assistant.reasoning events', () => {
      const event = {
        type: 'assistant.reasoning',
        data: { reasoningId: 'r1', content: 'Let me think about this...' },
      };
      expect(formatEvent(event)).toBeNull();
    });

    it('returns null for assistant.reasoning_delta events', () => {
      const event = {
        type: 'assistant.reasoning_delta',
        data: { reasoningId: 'r1', deltaContent: 'chunk of thinking' },
      };
      expect(formatEvent(event)).toBeNull();
    });
  });

  describe('content events pass through', () => {
    it('formats assistant.message_delta', () => {
      const event = {
        type: 'assistant.message_delta',
        data: { deltaContent: 'Hello' },
      };
      const result = formatEvent(event);
      expect(result).toEqual({ type: 'content', content: 'Hello', verbose: false });
    });

    it('formats assistant.message', () => {
      const event = {
        type: 'assistant.message',
        data: { content: 'Full response' },
      };
      const result = formatEvent(event);
      expect(result).toEqual({ type: 'content', content: 'Full response', verbose: false });
    });
  });

  describe('streaming_delta is suppressed', () => {
    it('returns null for assistant.streaming_delta', () => {
      const event = { type: 'assistant.streaming_delta', data: { deltaContent: 'x' } };
      expect(formatEvent(event)).toBeNull();
    });
  });

  describe('tool events', () => {
    it('formats tool.execution_start', () => {
      const event = {
        type: 'tool.execution_start',
        data: { toolName: 'read_file', arguments: { path: '/tmp/test.ts' } },
      };
      const result = formatEvent(event);
      expect(result?.type).toBe('tool_start');
      expect(result?.verbose).toBe(true);
      expect(result?.content).toContain('read_file');
    });

    it('formats tool.execution_complete', () => {
      const event = {
        type: 'tool.execution_complete',
        data: { toolName: 'read_file', success: true },
      };
      const result = formatEvent(event);
      expect(result?.type).toBe('tool_complete');
      expect(result?.content).toContain('✅');
    });
  });

  describe('unknown events', () => {
    it('returns null for unrecognized event types', () => {
      expect(formatEvent({ type: 'unknown.event' })).toBeNull();
    });
  });
});

describe('formatPermissionRequest', () => {
  it('includes /always approve and /always deny in prompt', () => {
    const result = formatPermissionRequest('bash', { command: 'ls' }, ['ls']);
    expect(result).toContain('`/always approve`');
    expect(result).toContain('`/always deny`');
    expect(result).not.toContain('add `/remember`');
  });

  it('includes reaction instructions with all four options', () => {
    const result = formatPermissionRequest('bash', { command: 'ls' }, ['ls']);
    expect(result).toContain('💾 always approve');
    expect(result).toContain('🚫 always deny');
  });

  it('mentions server name for MCP permissions', () => {
    const result = formatPermissionRequest('mcp-tool', {}, [], 'my-server');
    expect(result).toContain('`/always approve`');
    expect(result).toContain('**my-server** tools');
  });
});
