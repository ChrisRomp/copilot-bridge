import { randomUUID } from 'node:crypto';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import type { FusionPreference, FusionTransition } from '../types.js';
import { getChannelPrefs, setChannelPrefs, type ChannelPrefs } from '../state/store.js';
import type { CopilotBridge } from './bridge.js';
import {
  FusionEventTracker, FusionSelectionError, fusionStateMatches, fusionPreferenceForId,
  resolveFusionTier, isFusionModel, type FusionView, type FusionSelectionResult,
} from './fusion.js';
import { createLogger } from '../logger.js';

const log = createLogger('fusion');
type Binding = { session: CopilotSession; tracker: FusionEventTracker; state?: FusionView['state']; metadata?: FusionView['metadata']; suspended?: boolean };

export class FusionManager {
  private readonly bindings = new Map<string, Binding>();
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(
    private readonly bridge: CopilotBridge,
    private readonly preferences: (channelId: string) => Promise<ChannelPrefs>,
    private readonly notify: (sessionId: string, channelId: string, content: string) => void,
  ) {}

  attach(channelId: string, session: CopilotSession): void {
    this.bindings.set(channelId, { session, tracker: new FusionEventTracker() });
  }

  detach(sessionId: string): void {
    for (const [channelId, binding] of this.bindings) {
      if (binding.session.sessionId === sessionId) this.bindings.delete(channelId);
    }
  }

  private assertCurrent(channelId: string, binding: Binding): void {
    if (this.bindings.get(channelId) !== binding || this.bridge.getSession(binding.session.sessionId) !== binding.session) {
      throw new FusionSelectionError('The session changed while updating Fusion. Retry the command.');
    }
  }

  private async serialized<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.updates.get(channelId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.updates.set(channelId, next);
    try { return await next; }
    finally { if (this.updates.get(channelId) === next) this.updates.delete(channelId); }
  }

  private async persist(channelId: string, binding: Binding, change: Partial<ChannelPrefs>): Promise<void> {
    this.assertCurrent(channelId, binding);
    await setChannelPrefs(channelId, change);
    this.assertCurrent(channelId, binding);
    const saved = await getChannelPrefs(channelId);
    const expected = change.fusionTransition;
    const actual = saved?.fusionTransition;
    const transitionMatches = expected == null || actual == null ? (expected ?? null) === (actual ?? null)
      : (['id', 'sessionId', 'requested', 'previous', 'attempted'] as const).every(key => expected[key] === actual[key]);
    if ((Object.hasOwn(change, 'fusionTier') && (saved?.fusionTier ?? null) !== (change.fusionTier ?? null))
        || (Object.hasOwn(change, 'fusionTransition') && !transitionMatches)) {
      throw new FusionSelectionError('The state backend did not persist the Fusion preference. Update its ChannelPrefs support.');
    }
  }

  async view(channelId: string): Promise<FusionView> {
    const binding = this.bindings.get(channelId);
    const prefs = await this.preferences(channelId);
    try {
      const metadata = await this.bridge.getFusionMetadata(prefs.provider ? undefined : binding?.session.sessionId, true);
      if (!binding) return { metadata, intent: prefs.fusionTier ?? 'default' };
      const state = await this.bridge.getSessionModel(binding.session.sessionId);
      this.assertCurrent(channelId, binding);
      return { metadata, state, intent: prefs.fusionTier ?? 'default', actualModel: binding.tracker.actualModel, role: binding.tracker.role };
    } catch (error) {
      log.warn(`Fusion status unavailable for ${channelId}:`, error);
      return { intent: prefs.fusionTier ?? 'default', unavailable: error instanceof Error ? error.message : String(error) };
    }
  }

  async select(channelId: string, preference?: FusionPreference): Promise<FusionSelectionResult> {
    return this.serialized(channelId, () => this.apply(channelId, preference, preference !== undefined));
  }

  async prepare(channelId: string, markAttempt = false): Promise<void> {
    const initialPrefs = await this.preferences(channelId);
    if (!isFusionModel(initialPrefs.model, initialPrefs.provider)) return;
    await this.serialized(channelId, async () => {
      const prefs = await this.preferences(channelId);
      if (!isFusionModel(prefs.model, prefs.provider)) return;
      await this.apply(channelId, undefined, false);
      if (markAttempt) {
        const transition = (await getChannelPrefs(channelId))?.fusionTransition;
        const binding = this.bindings.get(channelId);
        if (binding && transition && !transition.attempted) {
          await this.persist(channelId, binding, { fusionTransition: { ...transition, attempted: true } });
        }
      }
    });
  }

  async fixedSelection<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    return this.serialized(channelId, async () => {
      const binding = this.bindings.get(channelId);
      if (binding) binding.suspended = true;
      try {
        const result = await operation();
        this.bindings.get(channelId)?.tracker.resetSelection();
        return result;
      } finally {
        if (binding) binding.suspended = false;
      }
    });
  }

  private async apply(channelId: string, requested: FusionPreference | undefined, explicit: boolean): Promise<FusionSelectionResult> {
    const binding = this.bindings.get(channelId);
    if (!binding) throw new FusionSelectionError('No attached session is available for Fusion.');
    const id = binding.session.sessionId;
    const prefs = await this.preferences(channelId);
    const previousIntent = prefs.fusionTier ?? 'default';
    const originalPrefs = await getChannelPrefs(channelId);
    let storedTier = originalPrefs?.fusionTier ?? null;
    let preference = requested ?? previousIntent;
    let fallbackFrom: FusionPreference | undefined;
    let updateIntent = explicit;
    let originalState: FusionView['state'];
    let mutationStarted = false;
    let persistenceStarted = false;
    try {
      binding.metadata = await this.bridge.getFusionMetadata(id, true);
      binding.state = await this.bridge.getSessionModel(id);
      originalState = binding.state;
      this.assertCurrent(channelId, binding);
      let nativeTier: string | null;
      try {
        nativeTier = resolveFusionTier(binding.metadata, preference);
      } catch (error) {
        if (explicit || preference === 'default' || !binding.metadata) throw error;
        fallbackFrom = preference;
        updateIntent = true;
        preference = 'default';
        nativeTier = resolveFusionTier(binding.metadata, preference);
      }

      let transition = (await getChannelPrefs(channelId))?.fusionTransition;
      if (!explicit && transition?.requested === preference && transition.sessionId === id && transition.attempted
          && !Object.hasOwn(binding.state, 'pendingAutoTier') && !Object.hasOwn(binding.state, 'activatingAutoTier')
          && !fusionStateMatches(binding.state, nativeTier) && !fallbackFrom) {
        // A restarted attempted activation with no surviving outcome is
        // ambiguous. Restore its previous intent rather than retrying it.
        preference = transition.previous;
        updateIntent = true;
        nativeTier = resolveFusionTier(binding.metadata, preference);
        await this.persist(channelId, binding, { fusionTier: preference, fusionTransition: null });
        storedTier = preference;
        this.notify(id, channelId, 'The previous Fusion tier change did not have a confirmed outcome. Restoring the previous preference.');
        transition = null;
      }

      const current = binding.state;
      const sameSelection = current.modelId === 'auto';
      const alreadyPending = (Object.hasOwn(current, 'pendingAutoTier') && current.pendingAutoTier === nativeTier)
        || (Object.hasOwn(current, 'activatingAutoTier') && current.activatingAutoTier === nativeTier);
      const unchanged = sameSelection && fusionStateMatches(current, nativeTier);
      const previousTier = fusionPreferenceForId(binding.metadata, current.autoTier) ?? previousIntent;
      if (!unchanged && !(sameSelection && alreadyPending)) {
        mutationStarted = true;
        if (sameSelection) await this.bridge.setAutoTier(id, nativeTier);
        else await this.bridge.switchSessionModel(id, 'auto', { autoTier: nativeTier });
        this.assertCurrent(channelId, binding);
        binding.state = await this.bridge.getSessionModel(id);
        this.assertCurrent(channelId, binding);
        binding.tracker.resetSelection();
      }
      const applied = fusionStateMatches(binding.state, nativeTier);
      const nextTransition: FusionTransition | null = applied ? null
        : transition?.requested === preference && transition.sessionId === id ? transition
          : { id: randomUUID(), sessionId: id, requested: preference, previous: previousTier, attempted: false };
      const change: Partial<ChannelPrefs> = {};
      // Only write what changed: per-send preparation must not churn state or
      // turn an inherited Fusion model/tier into a channel override.
      const selected = originalPrefs?.model != null ? isFusionModel(originalPrefs.model, originalPrefs.provider)
        : isFusionModel(prefs.model, prefs.provider);
      if (!selected) Object.assign(change, { model: 'auto', provider: null });
      if ((transition ?? null) !== nextTransition) change.fusionTransition = nextTransition;
      if ((updateIntent || storedTier != null) && storedTier !== preference) change.fusionTier = preference;
      if (Object.keys(change).length > 0) {
        persistenceStarted = true;
        await this.persist(channelId, binding, change);
      }
      if (fallbackFrom) {
        this.notify(id, channelId, `Fusion ${fallbackFrom} is no longer available. ${applied ? 'Using' : 'Requested'} provider-default routing${applied ? '.' : '; activation is pending.'}`);
      }
      return { status: applied ? unchanged ? 'unchanged' : 'applied' : 'pending', preference, fallbackFrom };
    } catch (error) {
      if ((mutationStarted || persistenceStarted) && this.bindings.get(channelId) === binding && originalState) {
        try {
          if (mutationStarted) {
            if (originalState.modelId === 'auto') {
              const restoreTier = Object.hasOwn(originalState, 'pendingAutoTier')
                ? originalState.pendingAutoTier ?? null : originalState.autoTier ?? null;
              await this.bridge.switchSessionModel(id, 'auto', { autoTier: restoreTier });
            } else {
              // Restore the fixed model directly. Re-entering Fusion always
              // passes an explicit tier, so restaging one here is unnecessary
              // and could fail if the forward switch never left the fixed model.
              await this.bridge.switchSessionModel(id, originalState.modelId ?? prefs.model ?? 'auto');
            }
          }
          this.assertCurrent(channelId, binding);
          if (persistenceStarted) await setChannelPrefs(channelId, {
            model: originalPrefs?.model ?? prefs.model,
            provider: originalPrefs?.provider ?? prefs.provider,
            fusionTier: originalPrefs?.fusionTier ?? null,
            fusionTransition: originalPrefs?.fusionTransition ?? null,
          });
        } catch (rollbackError) {
          log.error('Could not restore Fusion state after a failed change:', rollbackError);
          try { await this.bridge.abortSession(id); }
          catch (abortError) { log.error('Could not abort the failed Fusion session:', abortError); }
          try { await this.bridge.destroySession(id); }
          catch (disconnectError) { log.error('Could not confirm the failed Fusion session disconnected:', disconnectError); }
          this.detach(id);
          throw new FusionSelectionError('Fusion change and rollback failed; the attachment was released. Retry after resolving the error.', {
            cause: new AggregateError([error, rollbackError]),
          });
        }
      }
      if (error instanceof FusionSelectionError) throw error;
      throw new FusionSelectionError(`Fusion selection was not applied: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  process(channelId: string, session: CopilotSession, event: SessionEvent) {
    const binding = this.bindings.get(channelId);
    if (!binding || binding.session !== session) return { suppress: true };
    const result = binding.tracker.process(event);
    if (!binding.suspended && !event.checkpoint && !event.agentId && (event.type === 'session.model_change'
        || event.type === 'session.auto_tier_switch_failed' || event.type === 'session.idle')) {
      void this.serialized(channelId, async () => {
        this.assertCurrent(channelId, binding);
        const prefs = await this.preferences(channelId);
        if (!isFusionModel(prefs.model, prefs.provider) || binding.suspended) return;
        const transition = (await getChannelPrefs(channelId))?.fusionTransition;
        binding.state = await this.bridge.getSessionModel(session.sessionId);
        this.assertCurrent(channelId, binding);
        if (!transition || transition.sessionId !== session.sessionId) return;
        const nativeTier = transition.requested === 'default' ? null
          : binding.metadata?.tiers.find(tier => tier.fusionTier === transition.requested)?.id;
        if (nativeTier === undefined) throw new FusionSelectionError('The pending Fusion tier mapping is no longer available.');
        if (fusionStateMatches(binding.state, nativeTier)) {
          await this.persist(channelId, binding, { fusionTransition: null });
          this.notify(session.sessionId, channelId, `Fusion ${transition.requested === 'default' ? 'provider-default routing' : transition.requested + ' tier'} is now active.`);
        } else if (event.type === 'session.auto_tier_switch_failed' && event.data.requestedAutoTier === nativeTier
            && !Object.hasOwn(binding.state, 'pendingAutoTier') && !Object.hasOwn(binding.state, 'activatingAutoTier')) {
          const previousTier = fusionPreferenceForId(binding.metadata, event.data.effectiveAutoTier) ?? transition.previous;
          await this.persist(channelId, binding, { fusionTier: previousTier, fusionTransition: null });
          this.notify(session.sessionId, channelId, `Fusion tier change failed (${event.data.reason}). Keeping the previous tier.`);
        }
      }).catch(error => {
        log.error(`Failed to reconcile Fusion state for ${channelId}:`, error);
        if (this.bindings.get(channelId) === binding) this.notify(session.sessionId, channelId, 'Could not reconcile Fusion tier state. Check /status before requesting another change.');
      });
    }
    return result;
  }
}
