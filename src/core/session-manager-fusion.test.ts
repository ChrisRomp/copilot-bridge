import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { CopilotBridge } from './bridge.js';
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
  let bridge: { switchSessionModel: ReturnType<typeof vi.fn>; listModels: ReturnType<typeof vi.fn>; destroySession: ReturnType<typeof vi.fn>; getSession: ReturnType<typeof vi.fn> };
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getChannelPrefs).mockResolvedValue(null);
    bridge = {
      switchSessionModel: vi.fn().mockResolvedValue(undefined),
      listModels: vi.fn().mockResolvedValue([]),
      destroySession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(undefined),
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
});
