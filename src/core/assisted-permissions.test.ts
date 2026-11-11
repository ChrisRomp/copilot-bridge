import { describe, expect, it } from 'vitest';
import type { PermissionHandler, PermissionRequest, SessionEvent } from '@github/copilot-sdk';
import { ASSISTED_AUTOPILOT_NOTICE, AssistedPermissionTracker, evaluateAssistedDecision } from './assisted-permissions.js';

type Invocation = Parameters<PermissionHandler>[1];
type Assessment = NonNullable<Invocation['assistedApprovalAssessment']>;
type Requested = Extract<SessionEvent, { type: 'permission.requested' }>;
type Completed = Extract<SessionEvent, { type: 'permission.completed' }>;

const shell: Extract<PermissionRequest, { kind: 'shell' }> = {
  kind: 'shell', fullCommandText: 'ls -la', intention: 'List files',
  canOfferSessionApproval: true, commands: [], hasWriteFileRedirection: false,
  possiblePaths: [], possibleUrls: [],
};
const approvedAssessment: Assessment = { status: 'completed', recommendation: 'approve', rationale: 'Read-only command.' };
const invocation: Invocation = { sessionId: 'session', assistedApprovalAssessment: approvedAssessment };

function requested(requestId = 'request', overrides: Partial<Requested['data']> = {}): Requested {
  return {
    type: 'permission.requested', id: `requested-${requestId}`, parentId: null,
    timestamp: '2026-11-10T00:00:00.000Z',
    data: {
      requestId, permissionRequest: shell, permissionMode: 'assisted',
      agentMode: 'autopilot', assistedApprovalAssessment: approvedAssessment, ...overrides,
    },
  };
}

function completed(requestId = 'request', overrides: Partial<Completed['data']> = {}): Completed {
  return {
    type: 'permission.completed', id: `completed-${requestId}`, parentId: null,
    timestamp: '2026-11-10T00:00:01.000Z',
    data: { requestId, result: { kind: 'approved' }, decisionSource: 'assisted_approval', ...overrides },
  };
}

const idle: Extract<SessionEvent, { type: 'session.idle' }> = {
  type: 'session.idle', id: 'idle', parentId: null, timestamp: '2026-11-10T00:00:02.000Z',
  ephemeral: true, data: {},
};

describe('evaluateAssistedDecision', () => {
  it.each([false, true])('approves a completed approval (unattended=%s)', unattended => {
    expect(evaluateAssistedDecision(shell, invocation, unattended)).toEqual({
      kind: 'approve', reason: 'Read-only command.',
    });
  });

  const nonApprovals: Array<[Assessment, string]> = [
    [{ status: 'completed', recommendation: 'requireApproval', rationale: 'Deletes user data.' }, 'Deletes user data.'],
    [{ status: 'completed', recommendation: 'requireApproval' }, 'requires human approval'],
    [{ status: 'failed', reason: 'timeout' }, 'timeout'],
    [{ status: 'failed', reason: 'future-failure-reason' }, 'future-failure-reason'],
    [{ status: 'excluded', reason: 'content-excluded' }, 'content-excluded'],
    [{ status: 'not-run', reason: 'not-reached' }, 'not-reached'],
    [{ status: 'unavailable' }, 'unavailable'],
  ];
  it.each(nonApprovals)('prompts or denies for %j', (assessment, reason) => {
    for (const unattended of [false, true]) {
      const decision = evaluateAssistedDecision(shell, {
        sessionId: 'session', assistedApprovalAssessment: assessment,
      }, unattended);
      expect(decision.kind).toBe(unattended ? 'deny' : 'prompt');
      expect(decision.reason).toContain(reason);
    }
  });

  it('does not interpret missing assessment as an approval', () => {
    expect(evaluateAssistedDecision(shell, { sessionId: 'session' }, false).kind).toBe('prompt');
    expect(evaluateAssistedDecision(shell, { sessionId: 'session' }, true)).toEqual({
      kind: 'deny', reason: expect.stringContaining('No safety review'),
    });
  });

  it.each(['managedApprovalRequired', 'requestSandboxBypass'] as const)('gates %s even with judge approval', gate => {
    for (const unattended of [false, true]) {
      const decision = evaluateAssistedDecision({ ...shell, [gate]: true }, invocation, unattended);
      expect(decision.kind).toBe(unattended ? 'deny' : 'prompt');
      expect(decision.reason).toContain('human approval');
    }
  });

  it('honors managed approval in the derived prompt, without allowing it to clear a raw restriction', () => {
    const promptRequest: Invocation['promptRequest'] = {
      kind: 'read', path: '/workspace', intention: 'Inspect files', managedApprovalRequired: true,
    };
    for (const unattended of [false, true]) {
      expect(evaluateAssistedDecision(shell, { ...invocation, promptRequest }, unattended).kind)
        .toBe(unattended ? 'deny' : 'prompt');
      expect(evaluateAssistedDecision({ ...shell, managedApprovalRequired: true }, {
        ...invocation, promptRequest: { ...promptRequest, managedApprovalRequired: false },
      }, unattended).kind).toBe(unattended ? 'deny' : 'prompt');
    }
  });

  it('honors sandbox escalation in the derived prompt, without allowing it to clear a raw restriction', () => {
    const promptRequest: Invocation['promptRequest'] = {
      kind: 'commands', fullCommandText: shell.fullCommandText, intention: shell.intention,
      canOfferSessionApproval: true, commandIdentifiers: [], requestSandboxBypass: true,
    };
    for (const unattended of [false, true]) {
      expect(evaluateAssistedDecision(shell, { ...invocation, promptRequest }, unattended)).toEqual({
        kind: unattended ? 'deny' : 'prompt', reason: 'Sandbox escalation requires human approval.',
      });
      expect(evaluateAssistedDecision({ ...shell, requestSandboxBypass: true }, {
        ...invocation, promptRequest: { ...promptRequest, requestSandboxBypass: false },
      }, unattended).kind).toBe(unattended ? 'deny' : 'prompt');
    }
  });

  it('excludes hooks from unattended approval without changing interactive eligibility', () => {
    const hook: PermissionRequest = { kind: 'hook', toolName: 'bash' };
    expect(evaluateAssistedDecision(hook, invocation, true)).toEqual({
      kind: 'deny', reason: expect.stringContaining('Hook confirmation'),
    });
    expect(evaluateAssistedDecision(hook, invocation, false).kind).toBe('approve');
  });

  it.each(nonApprovals)('canonical %j overrides a legacy approval', assessment => {
    const legacy = { ...shell, assistedApproval: { recommendation: 'approve' as const } };
    expect(evaluateAssistedDecision(legacy, {
      sessionId: 'session', assistedApprovalAssessment: assessment,
    }, true).kind).toBe('deny');
  });

  it('canonical approval overrides a legacy rejection', () => {
    const legacy = { ...shell, assistedApproval: { recommendation: 'requireApproval' as const } };
    expect(evaluateAssistedDecision(legacy, invocation, false).kind).toBe('approve');
  });

  it.each(['approve', 'requireApproval', 'excluded', 'error'] as const)('supports legacy %s only without canonical assessment', recommendation => {
    const legacy = { ...shell, assistedApproval: { recommendation, reason: 'Legacy rationale' } };
    for (const unattended of [false, true]) {
      expect(evaluateAssistedDecision(legacy, { sessionId: 'session' }, unattended)).toEqual({
        kind: recommendation === 'approve' ? 'approve' : unattended ? 'deny' : 'prompt',
        reason: 'Legacy rationale',
      });
    }
  });

  it('supplies meaningful defaults for blank or absent rationale', () => {
    expect(evaluateAssistedDecision(shell, {
      sessionId: 'session',
      assistedApprovalAssessment: { status: 'completed', recommendation: 'requireApproval', rationale: '  ' },
    }, true).reason).toContain('requires human approval');
    const legacy = { ...shell, assistedApproval: { recommendation: 'error' as const, failureReason: 'timeout' as const } };
    expect(evaluateAssistedDecision(legacy, { sessionId: 'session' }, true).reason).toContain('timeout');
  });

  it.each(['failed', 'excluded', 'not-run'] as const)('keeps canonical %s explanations readable with blank reason', status => {
    const decision = evaluateAssistedDecision(shell, {
      sessionId: 'session', assistedApprovalAssessment: { status, reason: '  ' },
    }, true);
    expect(decision.reason).toContain('Human approval is required.');
    expect(decision.reason).not.toContain(':');
  });

  it('does not mutate the request or invocation', () => {
    expect(() => evaluateAssistedDecision(Object.freeze(shell), Object.freeze(invocation), true)).not.toThrow();
  });
});

describe('AssistedPermissionTracker', () => {
  it('waits for native completion and handles runtime-settled approval without a callback', () => {
    const tracker = new AssistedPermissionTracker();
    expect(tracker.process(requested())).toBeUndefined();
    expect(tracker.process(completed())).toEqual({ approved: true, summary: 'shell: ls -la' });
  });

  it('accepts authoritative approval even when the earlier assessment was unavailable', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested('request', { assistedApprovalAssessment: { status: 'unavailable' } }));
    expect(tracker.process(completed())?.approved).toBe(true);
  });

  const approvals: Completed['data']['result'][] = [
    { kind: 'approved' },
    { kind: 'approved-for-session', approval: { kind: 'read' } },
    { kind: 'approved-for-location', approval: { kind: 'read' }, locationKey: '/workspace' },
    { kind: 'approved-read-only-for-session', directories: ['/workspace'] },
  ];
  it.each(approvals)('recognizes native final approval variant $kind', result => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    expect(tracker.process(completed('request', { result }))?.approved).toBe(true);
  });

  it.each(['human_response', 'host_policy', 'unattended_fallback', 'authorization_carry_forward', undefined] as const)(
    'does not label %s approvals as safety-review approvals', decisionSource => {
      const tracker = new AssistedPermissionTracker();
      tracker.process(requested());
      expect(tracker.process(completed('request', { decisionSource }))).toBeUndefined();
    },
  );

  it('does not infer approval from the recommendation when the final result is denied', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    expect(tracker.process(completed('request', {
      result: { kind: 'denied-by-rules', rules: [] },
    }))).toEqual({
      approved: false, summary: 'shell: ls -la', reason: 'Copilot runtime permission rules denied this request.',
    });
  });

  it('emits host-attributed unattended rejection feedback, even for an interactive scheduled turn', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested('request', { agentMode: 'interactive' }));
    expect(tracker.process(completed('request', {
      decisionSource: 'unattended_fallback',
      result: { kind: 'denied-interactively-by-user', feedback: 'Safety review failed: timeout.' },
    }))).toEqual({
      approved: false, summary: 'shell: ls -la', reason: 'Safety review failed: timeout.',
    });
  });

  it('uses the requested review rationale when native rejection has no feedback', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested('request', {
      assistedApprovalAssessment: { status: 'completed', recommendation: 'requireApproval', rationale: 'Untrusted destination.' },
    }));
    expect(tracker.process(completed('request', {
      decisionSource: 'unattended_fallback',
      result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    }))?.reason).toBe('Untrusted destination.');
  });

  it('does not repeat an approval rationale for an eventual unattended denial', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    const notice = tracker.process(completed('request', {
      decisionSource: 'unattended_fallback',
      result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    }));
    expect(notice?.reason).toContain('interactive approval is unavailable');
    expect(notice?.reason).not.toContain('Read-only command');
  });

  it('requires an explicitly unattended turn for assisted-source native denials', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested('request', { agentMode: 'interactive' }));
    expect(tracker.process(completed('request', {
      result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    }))).toBeUndefined();
  });

  it.each(['human_response', 'host_policy', undefined] as const)('ignores %s denials', decisionSource => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    expect(tracker.process(completed('request', {
      decisionSource, result: { kind: 'denied-interactively-by-user', feedback: 'No' },
    }))).toBeUndefined();
  });

  it.each(['manual', undefined] as const)('requires assisted mode evidence for unattended denials (%s)', permissionMode => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested('request', { permissionMode }));
    expect(tracker.process(completed('request', {
      decisionSource: 'unattended_fallback', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    }))).toBeUndefined();
  });

  it('ignores cancellation and completions without requested context', () => {
    const tracker = new AssistedPermissionTracker();
    expect(tracker.process(completed('unknown'))).toBeUndefined();
    tracker.process(requested());
    expect(tracker.process(completed('request', { result: { kind: 'cancelled' } }))).toBeUndefined();
  });

  it('deduplicates request IDs across duplicate completion events and idle', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    tracker.process(requested());
    expect(tracker.process(completed())?.approved).toBe(true);
    tracker.process(idle);
    tracker.process(requested());
    expect(tracker.process({ ...completed(), id: 'different-event-id' })).toBeUndefined();
  });

  it('ignores replay checkpoints without consuming the live request', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process({ ...requested('historical'), checkpoint: true });
    expect(tracker.process(completed('historical'))).toBeUndefined();
    tracker.process(requested());
    expect(tracker.process({ ...completed(), checkpoint: true })).toBeUndefined();
    tracker.process({ ...idle, checkpoint: true });
    expect(tracker.process(completed())?.approved).toBe(true);
  });

  it.each(['idle', 'disconnect'] as const)('clears pending requests on %s', cleanup => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    if (cleanup === 'idle') tracker.process(idle);
    else tracker.clear();
    expect(tracker.process(completed())).toBeUndefined();
    tracker.process(requested('new'));
    expect(tracker.process(completed('new'))?.approved).toBe(true);
  });

  it('clears pending requests on native session shutdown', () => {
    const tracker = new AssistedPermissionTracker();
    tracker.process(requested());
    tracker.process({
      type: 'session.shutdown', id: 'shutdown', parentId: null, timestamp: idle.timestamp,
      data: {
        codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
        modelMetrics: {}, sessionStartTime: 0, shutdownType: 'routine', totalApiDurationMs: 0,
      },
    });
    expect(tracker.process(completed())).toBeUndefined();
  });

  it('isolates session-local request IDs', () => {
    const one = new AssistedPermissionTracker();
    const two = new AssistedPermissionTracker();
    one.process(requested());
    two.process(requested());
    expect(one.process(completed())?.approved).toBe(true);
    expect(two.process(completed())?.approved).toBe(true);
  });

  it('bounds pending requests, deduplication history, summaries and reasons', () => {
    const tracker = new AssistedPermissionTracker();
    for (let i = 0; i < 300; i++) tracker.process(requested(`${i}`));
    expect(tracker.process(completed('0'))).toBeUndefined();
    expect(tracker.process(completed('299'))?.approved).toBe(true);
    for (let i = 300; i < 600; i++) {
      tracker.process(requested(`${i}`));
      tracker.process(completed(`${i}`));
    }
    tracker.process(requested('0', {
      permissionRequest: { ...shell, fullCommandText: 'x'.repeat(10_000) },
      assistedApprovalAssessment: { status: 'failed', reason: 'x'.repeat(10_000) },
    }));
    const notice = tracker.process(completed('0', {
      decisionSource: 'unattended_fallback',
      result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' },
    }));
    expect(notice?.summary.length).toBeLessThanOrEqual(240);
    expect(notice?.reason?.length).toBeLessThanOrEqual(600);
  });
});

it('explains unattended runtime policy without promising bridge-rule coverage', () => {
  expect(ASSISTED_AUTOPILOT_NOTICE).toContain('runtime permission policy');
  expect(ASSISTED_AUTOPILOT_NOTICE).toContain('denied without prompting');
  expect(ASSISTED_AUTOPILOT_NOTICE).not.toContain('all bridge');
});
