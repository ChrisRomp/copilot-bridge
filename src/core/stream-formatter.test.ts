import { describe, it, expect } from 'vitest';
import { formatEvent, formatPermissionRequest, formatPermissionNotice, formatPermissionAutoDecision, formatPermissionPolicyWarnings } from './stream-formatter.js';

describe('permission notice visibility', () => {
  it.each([true, false])('only shows automatic decisions in verbose mode (approved=%s)', approved => {
    const event = {
      type: 'bridge.permission_auto_decision' as const,
      data: { approved, summary: 'shell: echo hello', reason: 'Human confirmation required' },
    };
    expect(formatPermissionNotice(event, false, false)).toBeNull();
    expect(formatPermissionNotice(event, true, false)).toContain(approved ? 'Auto-approved:' : 'Denied:');
    expect(formatPermissionNotice(event, true, true)).toBeNull();
  });

  it.each([false, true])('keeps policy warnings visible regardless of verbose=%s, except in quiet tasks', verbose => {
    const event = { type: 'bridge.permission_policy_notice' as const, data: { content: 'Some rules remain bridge-only.' } };
    expect(formatPermissionNotice(event, verbose, false)).toBe(event.data.content);
    expect(formatPermissionNotice(event, verbose, true)).toBeNull();
  });
});

describe('formatPermissionPolicyWarnings', () => {
  it('omits notices when there are no policy limitations', () => {
    expect(formatPermissionPolicyWarnings([])).toBe('');
  });

  it.each([1, 6, 8])('summarizes %i limitations without enumerating or truncating them', count => {
    const warnings = Array.from({ length: count }, (_, index) => `Private rule ${index + 1}: <@U123> @channel\n- details`);
    const result = formatPermissionPolicyWarnings(warnings);
    expect(result).toBe('Some bridge permission rules could not be translated for assisted mode. This may cause extra prompts, or leave those rules unenforced during unattended autopilot.');
    expect(warnings).toHaveLength(count);
  });
});

describe('formatEvent', () => {
  it('surfaces a subagent failure without marking the parent turn as failed', () => {
    const result = formatEvent({ type: 'subagent.failed', data: { agentName: 'worker', error: 'Request failed' } });
    expect(result).toMatchObject({ type: 'status', verbose: false });
    expect(result?.content).toContain('Request failed');
  });

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
  it('includes safety review without changing ordinary prompt choices', () => {
    const result = formatPermissionRequest('bash', {}, [], undefined, undefined, false, 'Requires human review');
    expect(result).toContain('🛡️ Safety review: Requires human review');
    expect(result).toContain('`/always approve`');
    expect(result).toContain('💾 always approve');
  });

  it('bounds and escapes safety review text', () => {
    const result = formatPermissionRequest('bash', {}, [], undefined, undefined, false, '@channel `run` **bold**\n' + 'x'.repeat(1000));
    const reason = result.split('🛡️ Safety review: ')[1].split('\n')[0];
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toContain('@channel');
    expect(reason).toContain('\\`run\\`');
    expect(reason).toContain('\\*\\*bold\\*\\*');
    expect(reason).toContain('…');
  });

  it('leaves hook UI unchanged even if an assisted reason is supplied', () => {
    const args: [string, unknown, string[], undefined, string, boolean] =
      ['hook:bash', {}, [], undefined, 'Hook requires confirmation', true];
    expect(formatPermissionRequest(...args, 'Do not show')).toBe(formatPermissionRequest(...args));
  });

  it('omits a safety review line when sanitation leaves no visible reason', () => {
    expect(formatPermissionRequest('bash', {}, [], undefined, undefined, false, '\u001b\u202e'))
      .not.toContain('Safety review:');
  });

  it('includes /always approve and /always deny in prompt', () => {
    const result = formatPermissionRequest('bash', { command: 'ls' }, ['ls']);
    expect(result).toContain('`/always approve`');
    expect(result).toContain('`/always deny`');
    expect(result).not.toContain('add `/remember`');
  });

  describe('formatPermissionAutoDecision', () => {
    it('formats a short auto-approval without creating another prompt', () => {
      expect(formatPermissionAutoDecision(true, 'read: notes')).toBe('🛡️ Auto-approved: read: notes');
      expect(formatPermissionAutoDecision(true, 'read', 'unused')).not.toContain('unused');
    });

    it('includes denial rationale and a useful fallback', () => {
      expect(formatPermissionAutoDecision(false, 'shell', 'Requires confirmation'))
        .toBe('🛡️ Denied: shell — Requires confirmation');
      expect(formatPermissionAutoDecision(false, 'shell')).toContain('Human approval is unavailable');
      expect(formatPermissionAutoDecision(false, 'shell', '\u001b\u202e')).toContain('Human approval is unavailable');
    });

    it('neutralizes mentions, markup, backticks and newlines in both fields', () => {
      const result = formatPermissionAutoDecision(false, '<@U123> @channel `rm`', '<!here> **approve**\n@all');
      expect(result).not.toContain('<@');
      expect(result).not.toContain('<!');
      expect(result).not.toMatch(/@(channel|all)/);
      expect(result).not.toContain('\n');
      expect(result).toContain('\\`rm\\`');
      expect(result).toContain('\\*\\*approve\\*\\*');
    });

    it('bounds heavily escaped text without emitting partial escapes or entities', () => {
      const result = formatPermissionAutoDecision(false, '*'.repeat(2000), '<'.repeat(2000));
      expect(result.length).toBeLessThanOrEqual(560);
      expect(result).not.toMatch(/\\…|&(?:l|lt)…/);
      expect(result).toContain('…');
    });
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

  it('includes hookReason and omits always/remember for hook permissions', () => {
    const result = formatPermissionRequest('hook:bash', { command: 'ls' }, [], undefined, 'Hook requires confirmation', true);
    expect(result).toContain('Hook requires confirmation');
    expect(result).not.toContain('`/always approve`');
    expect(result).not.toContain('`/always deny`');
    expect(result).not.toContain('💾');
    expect(result).not.toContain('🚫');
    expect(result).toContain('`/approve`');
    expect(result).toContain('`/deny`');
  });
});
