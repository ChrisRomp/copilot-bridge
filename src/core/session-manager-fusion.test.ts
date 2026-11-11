import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { CopilotBridge } from './bridge.js';
import { CopilotSession } from '@github/copilot-sdk';
import { FusionSelectionError } from './fusion.js';
import { clearChannelSession, getChannelPrefs, setChannelPrefs } from '../state/store.js';

vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath: vi.fn().mockReturnValue('/tmp/fusion-session-test'),
  getWorkspaceAllowPaths: vi.fn().mockResolvedValue([]),
  ensureWorkspacesDir: vi.fn(),
}));
vi.mock('../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config.js')>(),
  getConfig: vi.fn().mockReturnValue({ defaults: {}, permissions: {}, platforms: {}, channels: [] }),
}));
vi.mock('../state/store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../state/store.js')>(),
  getChannelPrefs: vi.fn().mockResolvedValue(null),
  setChannelPrefs: vi.fn().mockResolvedValue(undefined),
  clearChannelSession: vi.fn().mockResolvedValue(undefined),
  getChannelSession: vi.fn().mockResolvedValue('session-1'),
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(() => { throw Object.assign(new Error('missing test file'), { code: 'ENOENT' }); }),
}));

const basePrefs = {
  model: 'auto', provider: null, agent: null, verbose: false,
  triggerMode: 'all' as const, threadedReplies: false,
  permissionMode: 'interactive', reasoningEffort: null, contextTier: 'default' as const,
};

async function settleWithin<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not settle')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('SessionManager Fusion model switching', () => {
  let bridge: { switchSessionModel: ReturnType<typeof vi.fn>; listModels: ReturnType<typeof vi.fn>; destroySession: ReturnType<typeof vi.fn>; getSession: ReturnType<typeof vi.fn>; getFusionMetadata: ReturnType<typeof vi.fn> };
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getChannelPrefs).mockResolvedValue(null);
    bridge = {
      switchSessionModel: vi.fn().mockResolvedValue(undefined),
      listModels: vi.fn().mockResolvedValue([]),
      destroySession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(undefined),
      getFusionMetadata: vi.fn().mockResolvedValue({ defaultTier: 'route-h', tiers: [
        { id: 'route-h', fusionTier: 'high', type: 'fusion', status: { enabled: true } },
      ] }),
    };
    manager = new SessionManager(bridge as unknown as CopilotBridge);
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({ sessionId: 'session-1', isNew: false });
  });

  it('switches a stale Fusion session to a fixed model without deadlocking on the Fusion lock', async () => {
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs });
    vi.spyOn(manager as any, 'safeDestroySession').mockResolvedValue(undefined);
    // Mirrors attachSession: a non-deferred attach prepares the saved Fusion tier.
    vi.spyOn(manager as any, 'attachSession').mockImplementation(async (...args: unknown[]) => {
      const [channelId, , deferFusion] = args as [string, string, boolean | undefined];
      if (!deferFusion) await (manager as any).fusion.prepare(channelId);
    });
    bridge.switchSessionModel.mockRejectedValueOnce(new Error('Session not found for sessionId: session-1'));

    await expect(settleWithin(manager.switchModel('ch', 'fixed-model'))).resolves.toBeUndefined();
    expect(bridge.switchSessionModel).toHaveBeenCalledTimes(2);
    expect(setChannelPrefs).toHaveBeenCalledWith('ch', expect.objectContaining({ model: 'fixed-model', provider: null }));
  });

  it('clears a stale Fusion transition when leaving Fusion for a fixed model', async () => {
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs });
    vi.mocked(getChannelPrefs).mockResolvedValue({
      model: 'auto',
      fusionTransition: { id: 't1', sessionId: 'session-1', requested: 'high', previous: 'standard', attempted: true },
    });

    await manager.switchModel('ch', 'fixed-model');

    expect(setChannelPrefs).toHaveBeenCalledWith('ch', { fusionTransition: null });
  });

  it('does not deadlock when a provider switch falls back to auto during session creation', async () => {
    const effective = vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({
      ...basePrefs, model: 'local-model', provider: 'local',
    });
    vi.spyOn(manager, 'newSession').mockImplementation(async (channelId, deferFusion = false) => {
      // A configured creation fallback can replace the requested fixed model with auto.
      effective.mockResolvedValue({ ...basePrefs });
      if (!deferFusion) await manager['fusion'].prepare(channelId);
      return 'copilot-1';
    });

    await expect(settleWithin(manager.switchModel('ch', 'fixed-model'))).resolves.toBeUndefined();
    expect(manager.newSession).toHaveBeenCalledWith('ch', true);
  });

  it('does not leave a Copilot session attached to a BYOK channel when Fusion selection fails', async () => {
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs, model: 'local-model', provider: 'local' });
    vi.spyOn(manager as any, 'createNewSession').mockImplementation(async (...args: unknown[]) => {
      const channelId = args[0] as string;
      (manager as any).channelSessions.set(channelId, 'copilot-1');
      (manager as any).sessionChannels.set('copilot-1', channelId);
      return 'copilot-1';
    });
    vi.spyOn((manager as any).fusion, 'select').mockRejectedValue(new FusionSelectionError('catalog offline'));

    await expect(manager.selectFusion('ch')).rejects.toThrow('catalog offline');

    expect(bridge.destroySession).toHaveBeenCalledWith('copilot-1');
    expect((manager as any).channelSessions.has('ch')).toBe(false);
    expect(clearChannelSession).toHaveBeenLastCalledWith('ch');
    expect(setChannelPrefs).toHaveBeenLastCalledWith('ch', { model: 'local-model', provider: 'local' });
  });

  it.each(['prevalidation', 'selection'] as const)('reattaches a stale Fusion command session during %s', async stage => {
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs });
    manager['channelSessions'].set('ch', 'session-1');
    bridge.getSession.mockReturnValue({ sessionId: 'session-1' });
    manager['attachSession'] = vi.fn<typeof manager['attachSession']>().mockResolvedValue(undefined);
    const select = vi.spyOn(manager['fusion'], 'select').mockResolvedValue({ status: 'applied', preference: 'high' });
    const missing = new Error('Session not found for sessionId: session-1');
    if (stage === 'prevalidation') bridge.getFusionMetadata.mockRejectedValueOnce(missing);
    else select.mockRejectedValueOnce(missing);

    await expect(manager.selectFusion('ch', 'high')).resolves.toMatchObject({ preference: 'high' });
    expect(manager['attachSession']).toHaveBeenCalledWith('ch', 'session-1', true);
    expect(bridge.destroySession).toHaveBeenCalledWith('session-1');
  });

  it('does not retry a Fusion command with a policy or uncertain rollback failure', async () => {
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs });
    manager['attachSession'] = vi.fn<typeof manager['attachSession']>().mockResolvedValue(undefined);
    const failure = new FusionSelectionError('Rollback failed: Session not found');
    const select = vi.spyOn(manager['fusion'], 'select').mockRejectedValue(failure);
    await expect(manager.selectFusion('ch', 'high')).rejects.toBe(failure);
    expect(select).toHaveBeenCalledTimes(1);
    expect(manager['attachSession']).not.toHaveBeenCalled();
    expect(bridge.destroySession).not.toHaveBeenCalled();
  });
});

describe('Fusion post-resume probe recovery', () => {
  let manager: SessionManager;
  let bridge: CopilotBridge;
  let session: CopilotSession;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new CopilotBridge();
    manager = new SessionManager(bridge);
    session = Object.create(CopilotSession.prototype, { sessionId: { value: 'session-1' } });
    vi.spyOn(bridge, 'getSession').mockReturnValue(undefined);
    vi.spyOn(bridge, 'resumeSession').mockResolvedValue(session);
    vi.spyOn(bridge, 'destroySession').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'listModels').mockResolvedValue([]);
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...basePrefs });
    manager['resolveWorkingDirectory'] = vi.fn().mockResolvedValue('/virtual/fusion-resume-test');
    manager['buildCustomTools'] = vi.fn().mockResolvedValue([]);
    manager['resolveMcpServers'] = vi.fn().mockReturnValue({});
    manager['resolveHooks'] = vi.fn().mockResolvedValue(undefined);
    manager['buildSystemMessage'] = vi.fn().mockReturnValue({ mode: 'customize' });
    manager['initializeRuntimePermissions'] = vi.fn().mockResolvedValue(undefined);
    manager['attachSessionEvents'] = vi.fn();
    manager['createNewSession'] = vi.fn().mockResolvedValue('replacement');
  });

  it.each(['ensure', 'reload'] as const)('%s does not replace history when repeated probes fail after successful resumes', async operation => {
    vi.spyOn(manager['fusion'], 'prepare').mockRejectedValue(new Error('Session not found during model probe'));
    const attempt = operation === 'ensure' ? manager.ensureSession('ch') : manager.reloadSession('ch');
    await expect(attempt).rejects.toThrow('probe');
    expect(bridge.resumeSession).toHaveBeenCalledTimes(2);
    expect(clearChannelSession).not.toHaveBeenCalled();
    expect(manager['createNewSession']).not.toHaveBeenCalled();
  });

  it('recovers a transient post-resume missing-session probe by resuming the same history again', async () => {
    vi.spyOn(manager['fusion'], 'prepare')
      .mockRejectedValueOnce(new Error('Session not found during model probe'))
      .mockResolvedValue(undefined);
    await expect(manager.ensureSession('ch')).resolves.toEqual({ sessionId: 'session-1', isNew: false });
    expect(bridge.resumeSession).toHaveBeenCalledTimes(2);
    expect(clearChannelSession).not.toHaveBeenCalled();
  });

  it('allows replacement only when the retried resume itself confirms missing history', async () => {
    vi.spyOn(manager['fusion'], 'prepare').mockRejectedValue(new Error('Session not found during model probe'));
    vi.mocked(bridge.resumeSession).mockResolvedValueOnce(session).mockRejectedValueOnce(new Error('Session not found'));
    await expect(manager.ensureSession('ch')).resolves.toEqual({ sessionId: 'replacement', isNew: true });
    expect(clearChannelSession).toHaveBeenCalledWith('ch');
    expect(bridge.resumeSession).toHaveBeenCalledTimes(2);
  });
});
