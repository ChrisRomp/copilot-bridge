import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import { FusionEventTracker, FusionSelectionError, fusionModelLabel, fusionPendingLabel, isFusionModel, parseFusionTransition, resolveFusionTier, type FusionMetadata } from './fusion.js';

const metadata: FusionMetadata = {
  defaultTier: 'route-h',
  tiers: [
    { id: 'route-s', fusionTier: 'standard', displayName: 'Standard', description: '', type: 'auto', status: { enabled: true } },
    { id: 'route-h', fusionTier: 'high', displayName: 'High', description: '', type: 'fusion', status: { enabled: true } },
    { id: 'route-m', fusionTier: 'max', displayName: 'Max', description: '', type: 'fusion', status: { enabled: false, message: 'Disabled by organization policy' } },
    { id: 'fast', displayName: 'Fast', description: '', type: 'auto', status: { enabled: true, pickerVisible: false } },
  ],
};

describe('Fusion routing preferences', () => {
  it('rejects invalid prior overrides rather than silently losing rollback intent', () => {
    expect(() => parseFusionTransition(JSON.stringify({
      id: 'transition-1', sessionId: 'session-1', requested: 'high', previous: 'standard',
      previousOverride: 'not-a-tier', attempted: false,
    }))).toThrow('Invalid stored Fusion transition');
  });

  it('resolves public tiers from live mappings rather than legacy routing IDs', () => {
    expect(resolveFusionTier(metadata, 'high')).toBe('route-h');
    expect(resolveFusionTier(metadata, 'standard')).toBe('route-s');
    expect(resolveFusionTier(metadata, 'default')).toBeNull();
    expect(() => resolveFusionTier(metadata, 'max')).toThrow('Disabled by organization policy');
    expect(() => resolveFusionTier(undefined, 'high')).toThrow(FusionSelectionError);
  });

  it('does not assume Standard is the provider default or usable when metadata is missing', () => {
    const disabledDefault = structuredClone(metadata);
    disabledDefault.tiers[1].status.enabled = false;
    expect(() => resolveFusionTier(disabledDefault, 'default')).toThrow('unavailable');
    expect(() => resolveFusionTier({ defaultTier: 'absent', tiers: [] }, 'default')).toThrow('unavailable');
  });

  it('keeps canonical Copilot Auto aliases distinct from BYOK model names', () => {
    expect(isFusionModel('FUSION')).toBe(true);
    expect(isFusionModel('auto')).toBe(true);
    expect(isFusionModel('auto', 'byok')).toBe(false);
    expect(isFusionModel('byok:fusion')).toBe(false);
  });

  it('shows effective and pending tiers independently, including unresolved defaults', () => {
    const view = { metadata, state: { modelId: 'auto', autoTier: 'route-s', pendingAutoTier: 'route-h' } };
    expect(fusionModelLabel(view)).toBe('Copilot Fusion (Standard)');
    expect(fusionPendingLabel(view)).toBe('High');
    expect(fusionModelLabel({ metadata, state: { modelId: 'auto' } })).toBe('Copilot Fusion (High; provider default)');
    expect(fusionModelLabel({ state: { modelId: 'auto' } })).toContain('not yet resolved');
    expect(fusionPendingLabel({ state: { pendingAutoTier: null } })).toBe('Provider default');
  });
});

// Sanitized shapes from the live 1.0.109 trace: phase messages repeat under the
// same messageId, but only the authoritative copy contains a commitId.
const base = { timestamp: '2026-01-01T00:00:00Z', parentId: null };
const phase = {
  ...base, id: 'phase', type: 'assistant.fusion_phase_started', ephemeral: true,
  data: { fusionId: 'f1', phaseId: 'p1', phaseKind: 'primary', role: 'solver', conversationScope: 'root', pattern: 'cascade', model: 'model-a' },
} satisfies SessionEvent;
const message = {
  ...base, id: 'draft', type: 'assistant.message',
  data: {
    messageId: 'm1', content: 'Sanitized answer', fusion: {
      fusionId: 'f1', syntheticModel: 'opaque-route', policy: 'standard', pattern: 'cascade',
      phaseId: 'p1', phaseKind: 'primary', role: 'solver', conversationScope: 'root', sourceModel: 'model-a',
    },
  },
} satisfies SessionEvent;

describe('Fusion events', () => {
  it('announces actual models and review switches, not planned candidate models', () => {
    const tracker = new FusionEventTracker();
    expect(tracker.process(phase).notice).toEqual({ model: 'model-a', role: 'solver' });
    expect(tracker.process({ ...phase, id: 'phase-duplicate' }).notice).toBeUndefined();
    expect(tracker.process({ ...phase, id: 'review', data: { ...phase.data, model: 'model-b', role: 'judge', phaseKind: 'judge', conversationScope: 'review' } }).notice)
      .toEqual({ model: 'model-b', role: 'judge' });
    expect(tracker.actualModel).toBe('model-b');
    expect(tracker.process({ ...phase, id: 'subagent', agentId: 'child' }).notice).toBeUndefined();
    expect(tracker.actualModel).toBe('model-b');
    expect(tracker.process({ ...phase, id: 'checkpoint', checkpoint: true }).notice).toBeUndefined();
  });

  it('drops draft/review content and unattributed Fusion deltas, emits one committed answer', () => {
    const tracker = new FusionEventTracker();
    tracker.process(phase);
    expect(tracker.process(message).suppress).toBe(true);
    expect(tracker.process({ ...base, id: 'delta', type: 'assistant.message_delta', ephemeral: true, data: { messageId: 'm1', deltaContent: 'Draft' } }).suppress).toBe(true);
    expect(tracker.process({ ...message, id: 'review-msg', data: { ...message.data, fusion: { ...message.data.fusion, conversationScope: 'review', commitId: 'c1' } } }).suppress).toBe(true);
    const committed = { ...message, id: 'commit', data: { ...message.data, fusion: { ...message.data.fusion, commitId: 'c1' } } };
    expect(tracker.process(committed).suppress).toBe(false);
    expect(tracker.process({ ...committed, id: 'commit-again' }).suppress).toBe(true);
  });

  it('does not let a review subagent idle event release the parent or expose a draft', () => {
    const tracker = new FusionEventTracker();
    tracker.process(phase);
    expect(tracker.process({ ...base, id: 'child-idle', agentId: 'reviewer', type: 'session.idle', ephemeral: true, data: {} }).suppress).toBe(true);
    expect(tracker.process({ ...base, id: 'draft-delta', type: 'assistant.message_delta', ephemeral: true, data: { messageId: 'm1', deltaContent: 'Draft' } }).suppress).toBe(true);
  });

  it('withholds child assistant messages during Fusion turns', () => {
    const tracker = new FusionEventTracker();
    tracker.process(phase);
    const childMessage = { ...message, id: 'child-message', agentId: 'reviewer' };
    expect(tracker.process(childMessage).suppress).toBe(true);
    const childDelta = { ...base, id: 'child-delta', agentId: 'reviewer', type: 'assistant.message_delta', ephemeral: true, data: { messageId: 'm1', deltaContent: 'Draft' } } satisfies SessionEvent;
    expect(tracker.process(childDelta).suppress).toBe(true);
  });

  it('preserves ordinary Standard streaming and scopes deduplication to selection', () => {
    const tracker = new FusionEventTracker();
    expect(tracker.process({ ...base, id: 'delta', type: 'assistant.message_delta', ephemeral: true, data: { messageId: 'm1', deltaContent: 'Answer' } }).suppress).toBe(false);
    const selected = { ...base, id: 'selected', type: 'session.auto_mode_resolved', data: { chosenModel: 'model-a' } } satisfies SessionEvent;
    expect(tracker.process(selected).notice?.model).toBe('model-a');
    expect(tracker.process({ ...selected, id: 'unchanged' }).notice).toBeUndefined();
    tracker.resetSelection();
    expect(tracker.process({ ...selected, id: 'new-selection' }).notice?.model).toBe('model-a');
  });

  it('announces runtime-initiated concrete fallback without inventing a user selection', () => {
    const tracker = new FusionEventTracker();
    expect(tracker.process({ ...base, id: 'fallback', type: 'session.model_change',
      data: { previousModel: 'auto', newModel: 'model-b', cause: 'refusal_fallback' } }).notice)
      .toEqual({ model: 'model-b', fallback: true });
    expect(tracker.process({ ...base, id: 'manual-change', type: 'session.model_change',
      data: { previousModel: 'auto', newModel: 'model-c', source: 'sdk' } }).notice).toBeUndefined();
  });
});
