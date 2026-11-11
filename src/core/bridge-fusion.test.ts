import { describe, expect, it, vi } from 'vitest';
import { CopilotBridge } from './bridge.js';

describe('CopilotBridge stable Fusion adapter', () => {
  it('uses the full catalog RPC and session refresh option rather than dropping Auto metadata', async () => {
    const auto = { defaultTier: 'dynamic', tiers: [] };
    const serverList = vi.fn().mockResolvedValue({ models: [], auto });
    const sessionList = vi.fn().mockResolvedValue({ list: [], auto });
    const bridge = new CopilotBridge();
    vi.spyOn(bridge, 'start').mockResolvedValue(undefined);
    Object.assign(bridge, { client: { rpc: { models: { list: serverList } } } });
    const sessions = new Map([['session', { rpc: { model: { list: sessionList } } }]]);
    Object.assign(bridge, { sessions });
    expect(await bridge.getFusionMetadata()).toBe(auto);
    expect(serverList).toHaveBeenCalledWith({});
    expect(await bridge.getFusionMetadata('session', true)).toBe(auto);
    expect(sessionList).toHaveBeenCalledWith({ skipCache: true });
  });

  it('preserves explicit reset and opaque mapping values across stable SDK calls', async () => {
    const setModel = vi.fn().mockResolvedValue(undefined);
    const setAutoTier = vi.fn().mockResolvedValue({ status: 'pending', pendingAutoTier: null });
    const bridge = new CopilotBridge();
    Object.assign(bridge, { sessions: new Map([['session', { setModel, setAutoTier }]]) });
    await bridge.switchSessionModel('session', 'auto', { autoTier: 'dynamic-high' });
    expect(setModel).toHaveBeenLastCalledWith('auto', { autoTier: 'dynamic-high' });
    await bridge.switchSessionModel('session', 'auto', { autoTier: null });
    expect(setModel).toHaveBeenLastCalledWith('auto', { autoTier: null });
    expect(await bridge.setAutoTier('session', null)).toEqual({ status: 'pending', pendingAutoTier: null });
    expect(setAutoTier).toHaveBeenCalledWith(null);
  });
});
