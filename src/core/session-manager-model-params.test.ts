import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { CopilotBridge } from './bridge.js';

vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath: vi.fn().mockReturnValue('/tmp/test-workspace'),
  getWorkspaceAllowPaths: vi.fn().mockResolvedValue([]),
  ensureWorkspacesDir: vi.fn(),
}));

describe('SessionManager model parameter handling', () => {
  const basePrefs = {
    model: 'gpt-5.5',
    provider: null,
    agent: null,
    verbose: false,
    triggerMode: 'all' as const,
    threadedReplies: false,
    permissionMode: 'interactive',
    reasoningEffort: null,
    contextTier: 'default' as const,
  };

  it('does not forward contextTier when setting reasoning effort on BYOK sessions', async () => {
    const switchSessionModel = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager({ switchSessionModel } as unknown as CopilotBridge);
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({
      model: 'gpt-5',
      provider: 'azure',
      agent: null,
      verbose: false,
      triggerMode: 'all',
      threadedReplies: false,
      permissionMode: 'interactive',
      reasoningEffort: 'medium',
      contextTier: 'long_context',
    });
    vi.spyOn(manager as any, 'withSessionRetry').mockImplementation(async (_channelId: string, action: (sid: string) => Promise<void>) => {
      await action('session-1');
    });

    await manager.setReasoningEffort('channel-1', 'high');

    expect(switchSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5', {
      reasoningEffort: 'high',
      contextTier: null,
    });
  });

  it('caches default tier contextMax instead of absolute max context window', async () => {
    const manager = new SessionManager({} as CopilotBridge);
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue(basePrefs);
    (manager as any).contextUsage.set('channel-1', { currentTokens: 1000, tokenLimit: 1050000 });

    await (manager as any).cacheContextWindowTokens('channel-1', 'gpt-5.5', [{
      id: 'gpt-5.5',
      billing: {
        tokenPrices: {
          contextMax: 272000,
          longContext: { contextMax: 922000 },
        },
      },
      capabilities: {
        limits: { max_context_window_tokens: 1050000 },
      },
    }]);

    expect(manager.getContextUsage('channel-1')).toEqual({
      currentTokens: 1000,
      tokenLimit: 1050000,
      contextWindowTokens: 272000,
    });
  });

  it('caches long context tier contextMax when selected', async () => {
    const manager = new SessionManager({} as CopilotBridge);
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({
      ...basePrefs,
      contextTier: 'long_context',
    });
    (manager as any).contextUsage.set('channel-1', { currentTokens: 1000, tokenLimit: 1050000 });

    await (manager as any).cacheContextWindowTokens('channel-1', 'gpt-5.5', [{
      id: 'gpt-5.5',
      billing: {
        tokenPrices: {
          contextMax: 272000,
          longContext: { contextMax: 922000 },
        },
      },
      capabilities: {
        limits: { max_context_window_tokens: 1050000 },
      },
    }]);

    expect(manager.getContextUsage('channel-1')?.contextWindowTokens).toBe(922000);
  });
});
