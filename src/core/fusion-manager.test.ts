import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotSession, type SessionEvent } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';
import { FusionManager } from './fusion-manager.js';
import type { FusionMetadata, FusionRuntimeState } from './fusion.js';
import { getChannelPrefs, setChannelPrefs, type ChannelPrefs } from '../state/store.js';

vi.mock('../state/store.js', () => ({ getChannelPrefs: vi.fn(), setChannelPrefs: vi.fn() }));

describe('FusionManager', () => {
  let bridge: CopilotBridge;
  let session: CopilotSession;
  let controller: FusionManager;
  let prefs: ChannelPrefs;
  let state: FusionRuntimeState;
  let catalog: FusionMetadata;
  const notify = vi.fn();
  const base = { timestamp: '2026-01-01T00:00:00Z', parentId: null };

  beforeEach(() => {
    vi.clearAllMocks();
    prefs = { model: 'auto', provider: null, fusionTier: 'standard' };
    state = { modelId: 'auto', autoTier: 'route-s' };
    catalog = { defaultTier: 'route-s', tiers: [
      { id: 'route-s', fusionTier: 'standard', displayName: 'Standard', description: '', type: 'auto', status: { enabled: true } },
      { id: 'route-h', fusionTier: 'high', displayName: 'High', description: '', type: 'fusion', status: { enabled: true } },
      { id: 'route-m', fusionTier: 'max', displayName: 'Max', description: '', type: 'fusion', status: { enabled: false, message: 'Policy forbids Max' } },
    ] };
    vi.mocked(getChannelPrefs).mockImplementation(async () => structuredClone(prefs));
    vi.mocked(setChannelPrefs).mockImplementation(async (_channel, change) => { prefs = { ...prefs, ...structuredClone(change) }; });
    bridge = new CopilotBridge();
    session = Object.create(CopilotSession.prototype, { sessionId: { value: 'session-1' } });
    vi.spyOn(bridge, 'getSession').mockReturnValue(session);
    vi.spyOn(bridge, 'getFusionMetadata').mockImplementation(async () => structuredClone(catalog));
    vi.spyOn(bridge, 'getSessionModel').mockImplementation(async () => structuredClone(state));
    vi.spyOn(bridge, 'setAutoTier').mockImplementation(async (_id, tier) => {
      state = { ...state, pendingAutoTier: tier };
      return { status: 'pending', pendingAutoTier: tier };
    });
    vi.spyOn(bridge, 'switchSessionModel').mockImplementation(async (_id, model, options) => {
      state = { modelId: model, pendingAutoTier: options?.autoTier ?? null };
    });
    controller = makeController();
  });

  function makeController() {
    const manager = new FusionManager(bridge, async () => structuredClone(prefs), notify);
    manager.attach('ch', session);
    return manager;
  }

  it('persists accepted intent as pending without claiming activation', async () => {
    expect(await controller.select('ch', 'high')).toMatchObject({ status: 'pending', preference: 'high' });
    expect(prefs.fusionTier).toBe('high');
    expect(prefs.fusionTransition).toMatchObject({ requested: 'high', previous: 'standard', attempted: false });
    expect((await controller.view('ch')).state?.autoTier).toBe('route-s');
  });

  it('replaces a newer pending reset even when the requested tier is already activating', async () => {
    state = { modelId: 'auto', autoTier: 'route-s', activatingAutoTier: 'route-h', pendingAutoTier: null };
    await controller.select('ch', 'high');
    expect(bridge.setAutoTier).toHaveBeenCalledWith('session-1', 'route-h');
    expect(state.pendingAutoTier).toBe('route-h');
  });

  it.each(['active', 'failed'])('preserves originating suppression when %s reconciliation runs after a quiet turn ends', async outcome => {
    let suppressed = true;
    controller = new FusionManager(bridge, async () => structuredClone(prefs), notify,
      () => ({ attachmentGeneration: 7, suppressOutput: suppressed }));
    controller.attach('ch', session);
    await controller.select('ch', 'high');
    state = { modelId: 'auto', autoTier: outcome === 'active' ? 'route-h' : 'route-s' };
    const event: SessionEvent = outcome === 'active'
      ? { ...base, id: 'quiet-idle', type: 'session.idle', ephemeral: true, data: {} }
      : { ...base, id: 'quiet-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
        data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'request_failed' } };
    controller.process('ch', session, event);
    suppressed = false;
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining(outcome === 'active' ? 'now active' : 'Keeping the previous tier'),
      { attachmentGeneration: 7, suppressOutput: true });
  });

  it('rejects stale persistence readback before announcing fallback', async () => {
    prefs.fusionTier = 'max';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let written = false;
    let readingBack = false;
    vi.mocked(setChannelPrefs).mockImplementation(async (_channel, change) => {
      prefs = { ...prefs, ...change };
      written = true;
    });
    vi.mocked(getChannelPrefs).mockImplementation(async () => {
      if (written) {
        readingBack = true;
        await gate;
      }
      return structuredClone(prefs);
    });
    const pending = controller.prepare('ch');
    const rejected = expect(pending).rejects.toThrow('session changed');
    await vi.waitFor(() => expect(readingBack).toBe(true));
    controller.detach('session-1');
    release();
    await rejected;
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not turn inherited tier configuration into a permanent channel override', async () => {
    prefs.fusionTier = null;
    let configured: 'high' | 'standard' = 'high';
    controller = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? configured }), notify);
    controller.attach('ch', session);
    await controller.prepare('ch');
    expect(prefs.fusionTier).toBeNull();
    expect(state.pendingAutoTier).toBe('route-h');
    configured = 'standard';
    await controller.prepare('ch');
    expect(prefs.fusionTier).toBeNull();
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', 'route-s');
  });

  it('rejects explicit unavailable tiers without changing selection or durable intent', async () => {
    await expect(controller.select('ch', 'max')).rejects.toThrow('Policy forbids Max');
    expect(setChannelPrefs).not.toHaveBeenCalled();
    expect(bridge.setAutoTier).not.toHaveBeenCalled();
    expect(prefs.fusionTier).toBe('standard');
  });

  it('announces provider-default fallback when a saved tier becomes disallowed', async () => {
    prefs.fusionTier = 'max';
    await controller.prepare('ch');
    expect(bridge.setAutoTier).toHaveBeenCalledWith('session-1', null);
    expect(prefs.fusionTier).toBe('default');
    expect(notify).toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining('no longer available'), expect.any(Object));
  });

  it('keeps unavailable inherited tiers inherited and deduplicates fallback notices until recovery', async () => {
    prefs.fusionTier = null;
    let configured: 'max' | 'high' = 'max';
    controller = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? configured }), notify);
    controller.attach('ch', session);

    await controller.prepare('ch');
    await controller.prepare('ch', true);
    expect(prefs.fusionTier).toBeNull();
    expect(bridge.setAutoTier).toHaveBeenCalledExactlyOnceWith('session-1', null);
    expect(notify).toHaveBeenCalledTimes(1);

    catalog.tiers[2].status.enabled = true;
    await controller.prepare('ch');
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', 'route-m');
    configured = 'high';
    await controller.prepare('ch');
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', 'route-h');
    catalog.tiers[1].status.enabled = false;
    await controller.prepare('ch');
    expect(prefs.fusionTier).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('keeps an inherited preference after provider-default fallback activation fails', async () => {
    prefs.fusionTier = null;
    controller = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? 'max' }), notify);
    controller.attach('ch', session);
    await controller.prepare('ch');
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller.process('ch', session, { ...base, id: 'fallback-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
      data: { requestedAutoTier: null, effectiveAutoTier: 'route-s', reason: 'request_failed' } });
    await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    expect(prefs.fusionTier).toBeNull();
  });

  it('never fabricates availability or falls back to a fixed model when discovery fails', async () => {
    vi.mocked(bridge.getFusionMetadata).mockResolvedValue(undefined);
    await expect(controller.select('ch', 'high')).rejects.toThrow('availability is unavailable');
    expect(bridge.switchSessionModel).not.toHaveBeenCalled();
    expect(setChannelPrefs).not.toHaveBeenCalled();
  });

  it('restages accepted but unattempted intent after a cold resume loses native pending state', async () => {
    await controller.select('ch', 'high');
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller = makeController();
    await controller.prepare('ch');
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', 'route-h');
    expect(prefs.fusionTier).toBe('high');
  });

  it('does not endlessly retry an attempted transition with a lost final outcome', async () => {
    await controller.select('ch', 'high');
    await controller.prepare('ch', true);
    expect(prefs.fusionTransition?.attempted).toBe(true);
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller = makeController();
    await controller.prepare('ch');
    expect(prefs.fusionTier).toBe('standard');
    expect(prefs.fusionTransition).toBeNull();
    expect(notify).toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining('did not have a confirmed outcome'), expect.any(Object));
  });

  it.each(['standard', null] as const)('preserves previous override %s when a pending request moves to a new session', async previousOverride => {
    prefs.fusionTier = previousOverride;
    controller = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? 'standard' }), notify);
    controller.attach('ch', session);
    await controller.select('ch', 'high');
    const requestId = prefs.fusionTransition?.id;
    controller.detach('session-1');
    session = Object.create(CopilotSession.prototype, { sessionId: { value: 'session-2' } });
    vi.mocked(bridge.getSession).mockReturnValue(session);
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller.attach('ch', session);

    await controller.prepare('ch', true);
    expect(prefs.fusionTransition).toMatchObject({
      id: requestId, sessionId: 'session-2', previous: 'standard', previousOverride,
    });
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller.process('ch', session, { ...base, id: 'replacement-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
      data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'request_failed' } });
    await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    expect(prefs.fusionTier).toBe(previousOverride);
    vi.mocked(bridge.setAutoTier).mockClear();
    await controller.prepare('ch');
    expect(bridge.setAutoTier).not.toHaveBeenCalled();
  });

  it.each(['high', null] as const)('recovers a lost outcome when the previous tier is now revoked, preserving override %s', async previousOverride => {
    catalog.tiers[2].status.enabled = true;
    prefs.fusionTier = previousOverride;
    controller = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? 'high' }), notify);
    controller.attach('ch', session);
    state = { modelId: 'auto', autoTier: 'route-h' };
    await controller.select('ch', 'max');
    await controller.prepare('ch', true);
    const failedRequestId = prefs.fusionTransition?.id;
    catalog.tiers[1].status.enabled = false;
    state = { modelId: 'auto', autoTier: 'route-s' };

    await expect(controller.prepare('ch')).resolves.toBeUndefined();
    expect(prefs.fusionTier).toBe(previousOverride === null ? null : 'default');
    expect(prefs.fusionTransition?.id).not.toBe(failedRequestId);
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', null);
    await expect(controller.prepare('ch', true)).resolves.toBeUndefined();
  });

  it('recovers a lost policy-fallback activation without trying to restore the revoked tier', async () => {
    prefs.fusionTier = 'max';
    await controller.prepare('ch', true);
    const failedRequestId = prefs.fusionTransition?.id;
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller = makeController();

    await expect(controller.prepare('ch')).resolves.toBeUndefined();
    expect(prefs.fusionTier).toBe('default');
    expect(prefs.fusionTransition?.id).not.toBe(failedRequestId);
    expect(bridge.setAutoTier).toHaveBeenLastCalledWith('session-1', null);
  });

  it('reports an error instead of inventing routing when neither the restored tier nor default is permitted', async () => {
    catalog.tiers[2].status.enabled = true;
    prefs.fusionTier = 'high';
    await controller.select('ch', 'max');
    await controller.prepare('ch', true);
    const transition = structuredClone(prefs.fusionTransition);
    catalog.tiers[0].status.enabled = false;
    catalog.tiers[1].status.enabled = false;
    state = { modelId: 'auto', autoTier: 'route-s' };
    vi.mocked(bridge.setAutoTier).mockClear();

    await expect(controller.prepare('ch')).rejects.toThrow('Fusion default is unavailable');
    expect(prefs.fusionTransition).toEqual(transition);
    expect(bridge.setAutoTier).not.toHaveBeenCalled();
  });

  it('clears the pending transition only after actual SDK commit', async () => {
    await controller.select('ch', 'high');
    state = { modelId: 'auto', autoTier: 'route-h', fusionTier: 'high' };
    controller.process('ch', session, { ...base, id: 'commit', type: 'session.model_change', data: { newModel: 'auto', autoTier: 'route-h' } });
    await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    expect(prefs.fusionTier).toBe('high');
    expect(notify).toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining('now active'), expect.any(Object));
  });

  it('rolls back a newly requested tier after transient activation failure', async () => {
    await controller.select('ch', 'high');
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller.process('ch', session, { ...base, id: 'failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
      data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'request_failed' } });
    await vi.waitFor(() => expect(prefs.fusionTier).toBe('standard'));
    expect(prefs.fusionTransition).toBeNull();
    expect(notify).toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining('Keeping the previous tier'), expect.any(Object));
  });

  it.each(['activation failure', 'lost outcome'])('restores accepted pending intent instead of the effective tier after %s', async outcome => {
    catalog.tiers[2].status.enabled = true;
    await controller.select('ch', 'high');
    await controller.select('ch', 'max');
    expect(prefs.fusionTransition?.previous).toBe('high');
    if (outcome === 'activation failure') {
      state = { modelId: 'auto', autoTier: 'route-s' };
      controller.process('ch', session, { ...base, id: 'max-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
        data: { requestedAutoTier: 'route-m', effectiveAutoTier: 'route-s', reason: 'request_failed' } });
      await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    } else {
      await controller.prepare('ch', true);
      state = { modelId: 'auto', autoTier: 'route-s' };
      controller = makeController();
      await controller.prepare('ch');
    }
    expect(prefs.fusionTier).toBe('high');
  });

  it.each(['activation failure', 'lost outcome'])('restores inheritance after an explicit tier request ends in %s', async outcome => {
    prefs.fusionTier = null;
    const makeInheritedController = () => {
      const manager = new FusionManager(bridge, async () => ({ ...prefs, fusionTier: prefs.fusionTier ?? 'default' }), notify);
      manager.attach('ch', session);
      return manager;
    };
    controller = makeInheritedController();
    await controller.select('ch', 'high');
    if (outcome === 'activation failure') {
      state = { modelId: 'auto', autoTier: 'route-s' };
      controller.process('ch', session, { ...base, id: 'high-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
        data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'request_failed' } });
      await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    } else {
      await controller.prepare('ch', true);
      state = { modelId: 'auto', autoTier: 'route-s' };
      controller = makeInheritedController();
      await controller.prepare('ch');
    }
    expect(prefs.fusionTier).toBeNull();
    expect((await controller.view('ch')).intent).toBe('default');
  });

  it('restores previous intent from transitions saved without override provenance by older builds', async () => {
    await controller.select('ch', 'high');
    delete prefs.fusionTransition!.previousOverride;
    state = { modelId: 'auto', autoTier: 'route-s' };
    controller.process('ch', session, { ...base, id: 'legacy-failed', type: 'session.auto_tier_switch_failed', ephemeral: true,
      data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'request_failed' } });
    await vi.waitFor(() => expect(prefs.fusionTransition).toBeNull());
    expect(prefs.fusionTier).toBe('standard');
  });

  it('treats default as an explicit reset on an existing named tier', async () => {
    state = { modelId: 'auto', autoTier: 'route-h' };
    await controller.select('ch', 'default');
    expect(bridge.setAutoTier).toHaveBeenCalledWith('session-1', null);
    expect(prefs.fusionTier).toBe('default');
  });

  it('does not let a stale same-tier failure undo a newer pending request', async () => {
    await controller.select('ch', 'high');
    controller.process('ch', session, { ...base, id: 'old-failure', type: 'session.auto_tier_switch_failed', ephemeral: true,
      data: { requestedAutoTier: 'route-h', effectiveAutoTier: 'route-s', reason: 'setup_failed' } });
    await controller.prepare('ch');
    expect(prefs.fusionTier).toBe('high');
    expect(prefs.fusionTransition?.requested).toBe('high');
    expect(notify).not.toHaveBeenCalledWith('session-1', 'ch', expect.stringContaining('Keeping the previous'), expect.any(Object));
  });

  it('restores runtime and durable state if persisting a selected tier fails', async () => {
    vi.mocked(setChannelPrefs).mockRejectedValueOnce(new Error('database offline'));
    await expect(controller.select('ch', 'high')).rejects.toThrow('database offline');
    expect(prefs.fusionTier).toBe('standard');
    expect(bridge.switchSessionModel).toHaveBeenLastCalledWith('session-1', 'auto', { autoTier: 'route-s' });
  });

  it.each([
    { activatingAutoTier: 'route-h', restore: 'route-h' },
    { activatingAutoTier: null, restore: null },
    { activatingAutoTier: 'route-h', pendingAutoTier: null, restore: null },
  ])('restores activating/pending routing on failed selection: %j', async ({ restore, ...routing }) => {
    catalog.tiers[2].status.enabled = true;
    prefs.fusionTier = routing.activatingAutoTier == null ? 'default' : 'high';
    state = { modelId: 'auto', autoTier: 'route-s', ...routing };
    vi.mocked(bridge.setAutoTier).mockRejectedValueOnce(new Error('transient switch failure'));
    await expect(controller.select('ch', 'max')).rejects.toThrow('transient switch failure');
    expect(bridge.switchSessionModel).toHaveBeenLastCalledWith('session-1', 'auto', { autoTier: restore });
  });

  it.each(['prepare', 'select'] as const)('restores the absence of a model override when %s persistence fails after a write', async operation => {
    prefs = {};
    let configuredModel = operation === 'prepare' ? 'auto' : 'fixed-model';
    const effectivePrefs = async () => ({ ...prefs, model: prefs.model ?? configuredModel, fusionTier: prefs.fusionTier ?? 'high' as const });
    controller = new FusionManager(bridge, effectivePrefs, notify);
    controller.attach('ch', session);
    state = { modelId: configuredModel, autoTier: 'route-s' };
    vi.mocked(setChannelPrefs).mockImplementationOnce(async (_channel, change) => {
      prefs = { ...prefs, ...change };
      throw new Error('write outcome unknown');
    });

    await expect(controller[operation]('ch')).rejects.toThrow('write outcome unknown');
    expect(prefs.model ?? null).toBeNull();
    expect(prefs.provider ?? null).toBeNull();
    configuredModel = 'new-config-model';
    expect((await effectivePrefs()).model).toBe('new-config-model');
  });

  it.each(['getFusionMetadata', 'getSessionModel'] as const)('preserves native missing-session errors from %s for reattachment', async method => {
    const missing = new Error('Session not found for sessionId: session-1');
    vi.mocked(bridge[method]).mockRejectedValueOnce(missing);
    await expect(controller.prepare('ch')).rejects.toBe(missing);
    expect(setChannelPrefs).not.toHaveBeenCalled();
    expect(bridge.setAutoTier).not.toHaveBeenCalled();
  });

  it('reports rollback failure when a custom backend silently ignores model override clearing', async () => {
    prefs = {};
    controller = new FusionManager(bridge, async () => ({ ...prefs, model: prefs.model ?? 'fixed', fusionTier: prefs.fusionTier ?? 'standard' }), notify);
    controller.attach('ch', session);
    state = { modelId: 'fixed' };
    vi.mocked(setChannelPrefs)
      .mockImplementationOnce(async (_channel, change) => {
        prefs = { ...prefs, ...change };
        throw new Error('write outcome unknown');
      })
      .mockImplementationOnce(async (_channel, change) => {
        const { model: _ignored, ...rest } = change;
        prefs = { ...prefs, ...rest };
      });
    const abort = vi.spyOn(bridge, 'abortSession').mockResolvedValue(undefined);
    const destroy = vi.spyOn(bridge, 'destroySession').mockResolvedValue(undefined);

    await expect(controller.select('ch', 'high')).rejects.toThrow('rollback failed');
    expect(abort).toHaveBeenCalledWith('session-1');
    expect(destroy).toHaveBeenCalledWith('session-1');
  });

  it('rejects a state backend that silently drops the new preference fields', async () => {
    vi.mocked(setChannelPrefs).mockResolvedValue(undefined);
    await expect(controller.select('ch', 'high')).rejects.toThrow('state backend did not persist');
    expect(prefs.fusionTier).toBe('standard');
  });

  it('accepts a custom backend that returns transition fields in a different order', async () => {
    vi.mocked(getChannelPrefs).mockImplementation(async () => ({
      ...prefs,
      fusionTransition: prefs.fusionTransition ? {
        attempted: prefs.fusionTransition.attempted, previous: prefs.fusionTransition.previous,
        previousOverride: prefs.fusionTransition.previousOverride,
        requested: prefs.fusionTransition.requested, sessionId: prefs.fusionTransition.sessionId,
        id: prefs.fusionTransition.id,
      } : null,
    }));
    await expect(controller.select('ch', 'high')).resolves.toMatchObject({ status: 'pending', preference: 'high' });
  });

  it('preserves fixed-model effort/context preferences when switching into Fusion', async () => {
    prefs = { model: 'fixed', fusionTier: 'standard', reasoningEffort: 'high', contextTier: 'long_context' };
    state = { modelId: 'fixed', reasoningEffort: 'high', contextTier: 'long_context' };
    await controller.select('ch', 'high');
    expect(bridge.switchSessionModel).toHaveBeenCalledWith('session-1', 'auto', { autoTier: 'route-h' });
    expect(prefs).toMatchObject({ model: 'auto', fusionTier: 'high', reasoningEffort: 'high', contextTier: 'long_context' });
  });

  it('restores a fixed model directly when entering Fusion fails', async () => {
    prefs = { model: 'fixed', fusionTier: 'standard' };
    state = { modelId: 'fixed' };
    vi.mocked(bridge.setAutoTier).mockRejectedValue(new Error('Auto tier requires the auto model'));
    vi.mocked(bridge.switchSessionModel).mockImplementation(async (_id, model) => {
      if (model === 'auto') throw new Error('transient switch failure');
      state = { modelId: model };
    });
    const destroy = vi.spyOn(bridge, 'destroySession').mockResolvedValue(undefined);
    await expect(controller.select('ch', 'high')).rejects.toThrow('not applied: transient switch failure');
    expect(bridge.switchSessionModel).toHaveBeenLastCalledWith('session-1', 'fixed');
    expect(destroy).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ model: 'fixed', fusionTier: 'standard' });
  });

  it('does not rewrite unchanged state or persist an inherited Fusion model before each send', async () => {
    prefs = { fusionTier: null };
    controller = new FusionManager(bridge, async () => ({ ...prefs, model: 'auto', fusionTier: 'standard' }), notify);
    controller.attach('ch', session);
    await controller.prepare('ch', true);
    expect(setChannelPrefs).not.toHaveBeenCalled();
    expect(prefs.model).toBeUndefined();
  });

  it.each([undefined, 'high'] as const)('persists an explicit Fusion model selection with tier %s even when already inherited', async tier => {
    prefs = { fusionTier: null };
    let configuredModel = 'auto';
    const effectivePrefs = async () => ({ ...prefs, model: prefs.model ?? configuredModel, fusionTier: prefs.fusionTier ?? 'standard' as const });
    controller = new FusionManager(bridge, effectivePrefs, notify);
    controller.attach('ch', session);
    await controller.select('ch', tier);
    expect(prefs).toMatchObject({ model: 'auto', provider: null });
    expect(prefs.fusionTier).toBe(tier ?? null);
    configuredModel = 'fixed-model';
    controller = new FusionManager(bridge, effectivePrefs, notify);
    controller.attach('ch', session);
    await controller.prepare('ch');
    expect((await effectivePrefs()).model).toBe('auto');
  });

  it('lists Copilot tier availability independently of the current BYOK provider', async () => {
    prefs.provider = 'external';
    await controller.view('ch');
    expect(bridge.getFusionMetadata).toHaveBeenCalledWith(undefined, true);
  });

  it('ignores child/replayed model changes for root preference reconciliation', async () => {
    await controller.select('ch', 'high');
    const event = { ...base, id: 'child', type: 'session.model_change', data: { newModel: 'auto', autoTier: 'route-h' } } satisfies SessionEvent;
    controller.process('ch', session, { ...event, agentId: 'child' });
    controller.process('ch', session, { ...event, id: 'replay', checkpoint: true });
    await Promise.resolve();
    expect(prefs.fusionTransition).not.toBeNull();
  });

  it('does not report an explicit fixed-model switch as a Fusion fallback', async () => {
    let result: ReturnType<typeof controller.process> | undefined;
    await controller.fixedSelection('ch', async () => {
      result = controller.process('ch', session, {
        ...base,
        id: 'fixed-switch',
        type: 'session.model_change',
        data: { previousModel: 'auto', newModel: 'fixed-model', cause: 'user_request' },
      });
    });
    expect(result?.notice).toBeUndefined();
  });

  it('never applies stale async work to a replacement attachment', async () => {
    let resolveCatalog!: (value: FusionMetadata) => void;
    vi.mocked(bridge.getFusionMetadata).mockImplementationOnce(() => new Promise(resolve => { resolveCatalog = resolve; }));
    const change = controller.select('ch', 'high');
    const rejected = expect(change).rejects.toThrow('session changed');
    await vi.waitFor(() => expect(bridge.getFusionMetadata).toHaveBeenCalled());
    controller.detach('session-1');
    resolveCatalog(catalog);
    await rejected;
    expect(setChannelPrefs).not.toHaveBeenCalled();
    expect(bridge.setAutoTier).not.toHaveBeenCalled();
  });
});
