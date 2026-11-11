import type { CopilotClient, CopilotSession, SessionEvent } from '@github/copilot-sdk';
import type { FusionPreference, FusionTier, FusionTransition } from '../types.js';

export type FusionMetadata = NonNullable<Awaited<ReturnType<CopilotClient['rpc']['models']['list']>>['auto']>;
export type FusionRuntimeState = Awaited<ReturnType<CopilotSession['rpc']['model']['getCurrent']>>;
export type FusionTierResult = Awaited<ReturnType<CopilotSession['setAutoTier']>>;

export class FusionSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FusionSelectionError';
  }
}

export function isFusionPolicyFailure(error: unknown): boolean {
  if (error instanceof FusionSelectionError) return true;
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return /(?:auto|fusion)[-_ ]tier|tier.{0,80}(?:disabled|unavailable|unsupported|not available|not supported)|(?:auto|fusion).{0,80}(?:disabled by|policy rejected|not permitted)/i.test(message);
}

export function isFusionModel(model: string | null | undefined, provider?: string | null): boolean {
  return !provider && (model?.toLowerCase() === 'auto' || model?.toLowerCase() === 'fusion');
}

export function isFusionTier(value: unknown): value is FusionTier {
  return value === 'standard' || value === 'high' || value === 'max';
}

export function isFusionPreference(value: unknown): value is FusionPreference {
  return value === 'default' || isFusionTier(value);
}

export function parseFusionTransition(raw: string | null | undefined): FusionTransition | null {
  if (raw == null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object'
      || !('id' in value) || typeof value.id !== 'string'
      || !('sessionId' in value) || typeof value.sessionId !== 'string'
      || !('requested' in value) || !isFusionPreference(value.requested)
      || !('previous' in value) || !isFusionPreference(value.previous)
      || !('attempted' in value) || typeof value.attempted !== 'boolean') {
    throw new Error('Invalid stored Fusion transition');
  }
  return { id: value.id, sessionId: value.sessionId, requested: value.requested, previous: value.previous, attempted: value.attempted };
}

export function fusionTierLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function resolveFusionTier(metadata: FusionMetadata | undefined, preference: FusionPreference): string | null {
  if (!metadata) throw new FusionSelectionError('Fusion tier availability is unavailable. Try /model again; no tier was changed.');
  const descriptor = preference === 'default'
    ? metadata.tiers.find(tier => tier.id === metadata.defaultTier)
    : metadata.tiers.find(tier => tier.fusionTier === preference);
  if (!descriptor || !descriptor.status.enabled || !['auto', 'fusion'].includes(descriptor.type)) {
    const reason = descriptor?.status.message ?? descriptor?.status.reason ?? 'not available for this account/session';
    const alternatives = metadata.tiers.filter(tier => tier.status.enabled && tier.status.pickerVisible !== false && isFusionTier(tier.fusionTier))
      .map(tier => tier.fusionTier).join(', ');
    throw new FusionSelectionError(`Fusion ${preference} is unavailable: ${reason}.${alternatives ? ` Available tiers: ${alternatives}.` : ''}`);
  }
  return preference === 'default' ? null : descriptor.id;
}

export function fusionPreferenceForId(metadata: FusionMetadata | undefined, id: string | null | undefined): FusionPreference | undefined {
  if (id == null) return 'default';
  const tier = metadata?.tiers.find(tier => tier.id === id)?.fusionTier;
  return isFusionTier(tier) ? tier : undefined;
}

export function fusionStateMatches(state: FusionRuntimeState, id: string | null): boolean {
  return (state.autoTier ?? null) === id
    && !Object.hasOwn(state, 'pendingAutoTier') && !Object.hasOwn(state, 'activatingAutoTier');
}

export interface FusionView {
  metadata?: FusionMetadata;
  state?: FusionRuntimeState;
  intent?: FusionPreference;
  actualModel?: string;
  role?: string;
  unavailable?: string;
}

export interface FusionSelectionResult {
  status: 'applied' | 'pending' | 'unchanged';
  preference: FusionPreference;
  fallbackFrom?: FusionPreference;
}

export function fusionModelLabel(view?: FusionView): string {
  if (!view?.state) return 'Copilot Fusion (tier not yet resolved)';
  const committed = view.state.autoTier;
  const tier = view.state.fusionTier ?? view.metadata?.tiers.find(t => t.id === (committed ?? view.metadata?.defaultTier))?.fusionTier;
  return `Copilot Fusion (${isFusionTier(tier) ? fusionTierLabel(tier) : 'not yet resolved'}${committed == null ? '; provider default' : ''})`;
}

export function fusionPendingLabel(view: FusionView): string | undefined {
  if (!view.state) return;
  const field = Object.hasOwn(view.state, 'pendingAutoTier') ? 'pendingAutoTier'
    : Object.hasOwn(view.state, 'activatingAutoTier') ? 'activatingAutoTier' : undefined;
  if (!field) return;
  const value = view.state[field];
  if (value == null) return 'Provider default';
  const name = view.metadata?.tiers.find(tier => tier.id === value)?.fusionTier;
  return isFusionTier(name) ? fusionTierLabel(name) : 'Runtime-selected tier';
}

export interface FusionModelNotice {
  model: string;
  role?: string;
  fallback?: boolean;
}

/** Tracks actual root execution and hides uncommitted/review output. */
export class FusionEventTracker {
  actualModel?: string;
  role?: string;
  private lastNotice?: string;
  private inFusionTurn = false;
  private withheldContent = false;
  private committedContent = false;
  private readonly seen = new Set<string>();
  private readonly committed = new Set<string>();

  resetSelection(): void {
    this.lastNotice = undefined;
    this.actualModel = undefined;
    this.role = undefined;
  }

  process(event: SessionEvent, suppressFallbackNotice = false): { notice?: FusionModelNotice; error?: string; suppress: boolean } {
    if (event.checkpoint) return { suppress: true };
    if (event.type === 'assistant.message' && event.data.fusion?.conversationScope === 'review') return { suppress: true };
    if (event.agentId) {
      if (this.inFusionTurn && (event.type === 'assistant.message' || event.type === 'assistant.message_delta'
          || event.type === 'assistant.message_start')) {
        if (event.type === 'assistant.message' && event.data.content) this.withheldContent = true;
        return { suppress: true };
      }
      return { suppress: event.type === 'session.idle' || event.type === 'session.error'
        || event.type === 'assistant.turn_start' || event.type === 'assistant.turn_end' };
    }
    if (event.id) {
      if (this.seen.has(event.id)) return { suppress: true };
      this.seen.add(event.id);
      trimSet(this.seen);
    }
    let notice: FusionModelNotice | undefined;
    if (event.type === 'session.auto_mode_resolved') {
      notice = { model: event.data.chosenModel };
    } else if (event.type === 'session.model_change' && !suppressFallbackNotice && event.data.cause
        && (event.data.previousModel === 'auto' || this.inFusionTurn) && !isFusionModel(event.data.newModel)) {
      notice = { model: event.data.newModel, fallback: true };
    } else if (event.type === 'session.fusion_route_started' || event.type === 'session.fusion_resolved') {
      this.inFusionTurn = true;
      if (event.type === 'session.fusion_route_started') {
        this.withheldContent = false;
        this.committedContent = false;
      }
    } else if (event.type === 'assistant.fusion_phase_started') {
      this.inFusionTurn = true;
      notice = { model: event.data.model, role: event.data.role };
    } else if (event.type === 'session.fusion_route_failed') {
      this.inFusionTurn = false;
      notice = { model: event.data.fallbackModel, fallback: true };
    } else if (event.type === 'session.fusion_completed' || event.type === 'session.idle' || event.type === 'session.error') {
      this.inFusionTurn = false;
      if (event.type === 'session.fusion_completed' && this.withheldContent && !this.committedContent) {
        return { suppress: false, error: 'Fusion finished without an identifiable committed answer. Internal phase output was withheld; check the runtime logs.' };
      }
    }
    if (notice) {
      this.actualModel = notice.model;
      this.role = notice.role;
      const signature = JSON.stringify(notice);
      if (signature === this.lastNotice) notice = undefined;
      else this.lastNotice = signature;
    }
    if (event.type === 'assistant.message' && event.data.fusion) {
      const attribution = event.data.fusion;
      if (attribution.conversationScope === 'review' || !attribution.commitId) {
        if (event.data.content) this.withheldContent = true;
        return { notice, suppress: true };
      }
      if (event.data.content) this.committedContent = true;
      const key = `${attribution.commitId}:${event.data.messageId}`;
      if (this.committed.has(key)) return { notice, suppress: true };
      this.committed.add(key);
      trimSet(this.committed);
    }
    if (this.inFusionTurn && event.type === 'assistant.message' && !event.data.fusion) {
      if (event.data.content) this.withheldContent = true;
      return { notice, suppress: true };
    }
    if (this.inFusionTurn && (event.type === 'assistant.message_delta' || event.type === 'assistant.message_start')) {
      // SDK 1.0.31 deltas have no Fusion attribution. The authoritative full
      // message carries a commitId, so don't leak an unclassified phase draft.
      return { notice, suppress: true };
    }
    return { notice, suppress: false };
  }
}

function trimSet(entries: Set<string>): void {
  if (entries.size > 512) entries.delete(entries.values().next().value!);
}
