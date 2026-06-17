import { describe, expect, it, vi } from 'vitest';
import { CopilotBridge } from './bridge.js';

describe('CopilotBridge model parameter handling', () => {
  it('maps null reasoning effort to SDK none when switching models', async () => {
    const bridge = new CopilotBridge();
    const setModel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).sessions.set('session-1', { setModel });

    await bridge.switchSessionModel('session-1', 'gpt-5-mini', {
      reasoningEffort: null,
      contextTier: null,
    });

    expect(setModel).toHaveBeenCalledWith('gpt-5-mini', { reasoningEffort: 'none' });
  });
});
