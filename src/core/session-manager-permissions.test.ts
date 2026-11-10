import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotSession, type PermissionRequest } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';
import { SessionManager } from './session-manager.js';
import { evaluateConfigPermissions } from '../config.js';
import { addPermissionRule, checkPermission, setChannelPrefs, listPermissionRulesForScope, getPermissionRules } from '../state/store.js';
import { enterQuietMode } from './quiet-mode.js';
import { buildRuntimePermissionPolicy } from './permission-policy.js';

vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath: vi.fn().mockResolvedValue('/tmp/permission-test'),
  getWorkspaceAllowPaths: vi.fn().mockResolvedValue([]),
  ensureWorkspacesDir: vi.fn(),
}));
vi.mock('../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config.js')>(),
  getConfig: vi.fn().mockReturnValue({ defaults: {}, permissions: {}, platforms: {}, channels: [] }),
  getChannelConfig: vi.fn().mockResolvedValue({ platform: 'test', permissionMode: 'interactive' }),
  getChannelBotName: vi.fn().mockResolvedValue('test-bot'),
  isBotAdmin: vi.fn().mockReturnValue(false),
  evaluateConfigPermissions: vi.fn().mockReturnValue(null),
}));
vi.mock('../state/store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../state/store.js')>(),
  getChannelPrefs: vi.fn().mockResolvedValue(null),
  getWorkspaceOverride: vi.fn().mockResolvedValue(null),
  checkPermission: vi.fn().mockResolvedValue(null),
  addPermissionRule: vi.fn().mockResolvedValue(undefined),
  setChannelPrefs: vi.fn().mockResolvedValue(undefined),
  listPermissionRulesForScope: vi.fn().mockResolvedValue([]),
  getPermissionRules: vi.fn().mockResolvedValue([]),
}));
vi.mock('./permission-policy.js', () => ({
  buildRuntimePermissionPolicy: vi.fn().mockReturnValue({
    config: { rules: { approved: [{ kind: 'shell', argument: 'printf' }], denied: [] }, hostPolicyPermissionHandler: true },
    warnings: [],
  }),
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: Parameters<typeof actual.existsSync>[0]) =>
      String(p).includes('installed-plugins') || String(p).includes('mcp-config.json')
        ? false : actual.existsSync(p)),
  };
});

const shellRequest: PermissionRequest = {
  kind: 'shell',
  fullCommandText: 'printf permission-probe',
  intention: 'Print a harmless marker',
  commands: [],
  possiblePaths: [],
  possibleUrls: [],
  canOfferSessionApproval: true,
  hasWriteFileRedirection: false,
};
const approveInvocation = {
  sessionId: 'session-1',
  assistedApprovalAssessment: { status: 'completed', recommendation: 'approve', rationale: 'Safe probe' },
} as const;
const prefs = {
  model: 'gpt-5.5', provider: null, agent: null, verbose: false,
  triggerMode: 'all' as const, threadedReplies: false,
  permissionMode: 'assisted', reasoningEffort: null, contextTier: 'default' as const,
};

describe('SessionManager assisted permissions', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkPermission).mockResolvedValue(null);
    vi.mocked(evaluateConfigPermissions).mockReturnValue(null);
    vi.mocked(addPermissionRule).mockResolvedValue(undefined);
    manager = new SessionManager(new CopilotBridge());
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({ ...prefs });
    vi.spyOn(manager, 'getSessionMode').mockResolvedValue('interactive');
  });

  describe('SessionManager runtime policy lifecycle', () => {
    let bridge: CopilotBridge;
    let manager: SessionManager;
    let mode: 'interactive' | 'assisted' | 'autopilot';
    let nativeMode: 'manual' | 'assisted' | 'allow-all';
    const projection = {
      config: { rules: { approved: [{ kind: 'shell', argument: 'printf' }], denied: [] }, hostPolicyPermissionHandler: true },
      warnings: [],
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mode = 'interactive';
      nativeMode = 'manual';
      vi.mocked(buildRuntimePermissionPolicy).mockReturnValue(structuredClone(projection));
      vi.mocked(listPermissionRulesForScope).mockResolvedValue([]);
      vi.mocked(getPermissionRules).mockResolvedValue([]);
      vi.mocked(setChannelPrefs).mockImplementation(async (_channel, update) => {
        if (update.permissionMode === 'interactive' || update.permissionMode === 'assisted' || update.permissionMode === 'autopilot') {
          mode = update.permissionMode;
        }
      });
      bridge = new CopilotBridge();
      const session: CopilotSession = Object.create(CopilotSession.prototype, { sessionId: { value: 'session-1' } });
      vi.spyOn(bridge, 'getSession').mockReturnValue(session);
      vi.spyOn(bridge, 'getPermissionMode').mockImplementation(async () => nativeMode);
      vi.spyOn(bridge, 'setPermissionMode').mockImplementation(async (_id, next) => { nativeMode = next; });
      vi.spyOn(bridge, 'getPermissionCapabilities').mockResolvedValue({ assistedApproval: true, bypassPermissions: true });
      vi.spyOn(bridge, 'configurePermissions').mockResolvedValue({ success: true });
      vi.spyOn(bridge, 'abortSession').mockResolvedValue(undefined);
      vi.spyOn(bridge, 'destroySession').mockResolvedValue(undefined);
      manager = new SessionManager(bridge);
      manager['channelSessions'].set('channel-1', 'session-1');
      manager['runtimePermissionStates'].set('session-1', { signature: '', projected: false, warnings: [] });
      vi.spyOn(manager, 'getEffectivePrefs').mockImplementation(async () => ({ ...prefs, permissionMode: mode }));
      vi.spyOn(manager, 'getSessionMode').mockResolvedValue('interactive');
    });

    it('configures rules before enabling assisted mode and persisting the preference', async () => {
      await manager.setPermissionMode('channel-1', 'assisted');
      expect(bridge.configurePermissions).toHaveBeenCalledWith('session-1', projection.config);
      expect(bridge.setPermissionMode).toHaveBeenCalledWith('session-1', 'assisted');
      expect(setChannelPrefs).toHaveBeenCalledWith('channel-1', { permissionMode: 'assisted' });
      expect(vi.mocked(bridge.configurePermissions).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(bridge.setPermissionMode).mock.invocationCallOrder[0]);
      expect(vi.mocked(bridge.setPermissionMode).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(setChannelPrefs).mock.invocationCallOrder[0]);
    });

    it('does not persist an unavailable assisted mode', async () => {
      vi.mocked(bridge.getPermissionCapabilities).mockResolvedValue({ assistedApproval: false, bypassPermissions: true });
      await expect(manager.setPermissionMode('channel-1', 'assisted')).rejects.toThrow('unavailable');
      expect(setChannelPrefs).not.toHaveBeenCalled();
      expect(bridge.configurePermissions).not.toHaveBeenCalled();
      expect(nativeMode).toBe('manual');
    });

    it('restores native mode and the owned baseline if persistence fails', async () => {
      vi.mocked(setChannelPrefs).mockRejectedValueOnce(new Error('database offline'));
      await expect(manager.setPermissionMode('channel-1', 'assisted')).rejects.toThrow('database offline');
      expect(nativeMode).toBe('manual');
      expect(mode).toBe('interactive');
      expect(bridge.configurePermissions).toHaveBeenLastCalledWith('session-1', {
        rules: { approved: [], denied: [] }, hostPolicyPermissionHandler: false,
      });
    });

    it('does not treat configure.success=false as synchronized policy', async () => {
      vi.mocked(bridge.configurePermissions).mockResolvedValueOnce({ success: false });
      await expect(manager.setPermissionMode('channel-1', 'assisted')).rejects.toThrow('did not apply');
      expect(setChannelPrefs).not.toHaveBeenCalled();
      expect(nativeMode).toBe('manual');
    });

    it('refreshes removals, but avoids repeatedly configuring unchanged rules', async () => {
      await manager.setPermissionMode('channel-1', 'assisted');
      await manager.refreshPermissions('channel-1');
      expect(bridge.configurePermissions).toHaveBeenCalledTimes(1);
      const cleared = { config: { rules: { approved: [], denied: [] }, hostPolicyPermissionHandler: true }, warnings: [] };
      vi.mocked(buildRuntimePermissionPolicy).mockReturnValue(cleared);
      await manager.refreshPermissions('channel-1');
      expect(bridge.configurePermissions).toHaveBeenLastCalledWith('session-1', cleared.config);
    });

    it('restores manual runtime mode and clears only bridge rules when enabling yolo', async () => {
      await manager.setPermissionMode('channel-1', 'assisted');
      await manager.setPermissionMode('channel-1', 'autopilot');
      expect(nativeMode).toBe('manual');
      expect(mode).toBe('autopilot');
      expect(bridge.setPermissionMode).not.toHaveBeenCalledWith(expect.anything(), 'allow-all');
      expect(bridge.configurePermissions).toHaveBeenLastCalledWith('session-1', {
        rules: { approved: [], denied: [] }, hostPolicyPermissionHandler: false,
      });
    });

    it('reapplies policy to a newly created or cold-resumed session', async () => {
      manager['runtimePermissionStates'].clear();
      await manager['initializeRuntimePermissions']('channel-1', 'session-1', 'assisted');
      expect(bridge.configurePermissions).toHaveBeenCalledWith('session-1', projection.config);
      expect(nativeMode).toBe('assisted');
    });

    it('refuses to overwrite a resident session without policy ownership', async () => {
      manager['runtimePermissionStates'].clear();
      await expect(manager['synchronizeSessionPermissions']('channel-1', 'session-1', 'assisted'))
        .rejects.toThrow('unowned session');
      expect(bridge.configurePermissions).not.toHaveBeenCalled();
    });

    it('disconnects rather than continuing with stale policy after a refresh failure', async () => {
      mode = 'assisted';
      vi.mocked(bridge.configurePermissions).mockRejectedValue(new Error('runtime unavailable'));
      await expect(manager.refreshPermissions('channel-1')).rejects.toThrow('runtime unavailable');
      expect(bridge.abortSession).toHaveBeenCalledWith('session-1');
      expect(bridge.destroySession).toHaveBeenCalledWith('session-1');
      expect(manager['runtimePermissionStates'].has('session-1')).toBe(false);
    });

    it('uses the store-defined rule order, including global rules, for this channel', async () => {
      const rules = [
        { id: 2, scope: 'global', tool: 'shell', commandPattern: '*', action: 'deny' as const, createdAt: '' },
        { id: 1, scope: 'channel-1', tool: 'shell', commandPattern: 'printf', action: 'allow' as const, createdAt: '' },
      ];
      vi.mocked(listPermissionRulesForScope).mockImplementation(async scope => rules.filter(rule => rule.scope === scope));
      vi.mocked(getPermissionRules).mockResolvedValue(rules);
      await manager.setPermissionMode('channel-1', 'assisted');
      expect(getPermissionRules).toHaveBeenCalledWith('channel-1', 'shell');
      expect(buildRuntimePermissionPolicy).toHaveBeenCalledWith(expect.objectContaining({ storedRules: rules }));
    });

    it('restores assisted mode after temporary implementation yolo', async () => {
      mode = 'assisted';
      manager['yoloPreviousState'].set('channel-1', 'assisted');
      await manager.setPermissionMode('channel-1', 'autopilot');
      expect(await manager.revertYoloIfNeeded('channel-1')).toBe(true);
      expect(mode).toBe('assisted');
      expect(nativeMode).toBe('assisted');
      expect(await manager.revertYoloIfNeeded('channel-1')).toBe(false);
    });

    it('denies already-pending manual prompts when enabling assisted autopilot', async () => {
      vi.mocked(manager.getSessionMode).mockResolvedValue('autopilot');
      const resolve = vi.fn();
      manager['pendingPermissions'].set('channel-1', [{
        channelId: 'channel-1', sessionId: 'session-1', toolName: 'shell',
        toolInput: {}, commands: [], resolve, createdAt: Date.now(),
      }]);
      await manager.setPermissionMode('channel-1', 'assisted');
      expect(resolve).toHaveBeenCalledWith({ kind: 'user-not-available' });
      expect(manager.hasPendingPermission('channel-1')).toBe(false);
    });

    it('does not silently keep running in yolo when restoration is refused', async () => {
      mode = 'autopilot';
      manager['yoloPreviousState'].set('channel-1', 'assisted');
      vi.mocked(bridge.getPermissionCapabilities).mockResolvedValue({ assistedApproval: false, bypassPermissions: true });
      expect(await manager.revertYoloIfNeeded('channel-1')).toBe(false);
      expect(bridge.abortSession).toHaveBeenCalledWith('session-1');
      await expect(manager.ensureSession('channel-1')).rejects.toThrow('Temporary yolo restoration failed');
      await manager.setPermissionMode('channel-1', 'interactive');
      expect(manager['permissionRecoveryRequired'].has('channel-1')).toBe(false);
      expect(mode).toBe('interactive');
    });
  });

  it('approves judge-approved requests with assisted attribution and no chat prompt', async () => {
    const result = await manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
    expect(result).toMatchObject({ kind: 'attributed', result: { kind: 'approve-once' } });
    expect(manager.hasPendingPermission('channel-1')).toBe(false);
  });

  it('preserves hardcoded, config, and stored denies ahead of the judge', async () => {
    const hard = await manager['handlePermissionRequest']('channel-1',
      { ...shellRequest, fullCommandText: 'launchctl unload fake-service' }, approveInvocation);
    expect(hard).toMatchObject({ kind: 'attributed', result: { kind: 'reject' } });
    expect(evaluateConfigPermissions).not.toHaveBeenCalled();

    vi.mocked(evaluateConfigPermissions).mockReturnValue('deny');
    const configured = await manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
    expect(configured).toMatchObject({ kind: 'attributed', result: { kind: 'reject' } });
    expect(checkPermission).not.toHaveBeenCalled();

    vi.mocked(evaluateConfigPermissions).mockReturnValue(null);
    vi.mocked(checkPermission).mockResolvedValue('deny');
    const stored = await manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
    expect(stored).toMatchObject({ kind: 'attributed', result: { kind: 'reject' } });
  });

  it('does not use a judge approval when the stored rules cannot be read', async () => {
    vi.mocked(checkPermission).mockRejectedValue(new Error('database unavailable'));
    const result = await manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
    expect(result).toMatchObject({ kind: 'reject', feedback: expect.stringContaining('remembered permission') });
    expect(manager.hasPendingPermission('channel-1')).toBe(false);
  });

  it('prompts interactively with the reason and attributes the human answer', async () => {
    const events = vi.fn();
    manager.onSessionEvent(events);
    const request = manager['handlePermissionRequest']('channel-1', shellRequest, {
      sessionId: 'session-1',
      assistedApprovalAssessment: { status: 'completed', recommendation: 'requireApproval', rationale: 'Needs confirmation' },
    });
    await vi.waitFor(() => expect(manager.hasPendingPermission('channel-1')).toBe(true));
    expect(events).toHaveBeenCalledWith('session-1', 'channel-1', expect.objectContaining({
      type: 'bridge.permission_request',
      data: expect.objectContaining({ assistedReason: 'Needs confirmation' }),
    }));
    await manager.resolvePermission('channel-1', true);
    expect(await request).toMatchObject({ kind: 'attributed', result: { kind: 'approve-once' } });
  });

  it('denies a nonapproved request in autopilot without queuing a prompt', async () => {
    vi.mocked(manager.getSessionMode).mockResolvedValue('autopilot');
    const result = await manager['handlePermissionRequest']('channel-1', shellRequest, {
      sessionId: 'session-1',
      assistedApprovalAssessment: { status: 'completed', recommendation: 'requireApproval', rationale: 'Needs confirmation' },
    });
    expect(result).toMatchObject({ kind: 'attributed', result: { kind: 'reject', feedback: 'Needs confirmation' } });
    expect(manager.hasPendingPermission('channel-1')).toBe(false);
  });

  it('uses the same unattended behavior for quiet scheduled turns', async () => {
    const exitQuiet = enterQuietMode('channel-1');
    try {
      const approval = await manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
      expect(approval).toMatchObject({ kind: 'attributed', result: { kind: 'approve-once' } });
      const denial = await manager['handlePermissionRequest']('channel-1', shellRequest, { sessionId: 'session-1' });
      expect(denial).toMatchObject({ kind: 'attributed', result: { kind: 'reject' } });
      expect(manager.hasPendingPermission('channel-1')).toBe(false);
    } finally {
      exitQuiet();
    }
  });

  it('does not change manual+autopilot into assisted permissions', async () => {
    vi.mocked(manager.getEffectivePrefs).mockResolvedValue({ ...prefs, permissionMode: 'interactive' });
    vi.mocked(manager.getSessionMode).mockResolvedValue('autopilot');
    const request = manager['handlePermissionRequest']('channel-1', shellRequest, approveInvocation);
    await vi.waitFor(() => expect(manager.hasPendingPermission('channel-1')).toBe(true));
    await manager.resolvePermission('channel-1', false);
    expect(await request).toEqual({ kind: 'reject' });
  });

  it('publishes remembered rules before unblocking the permission callback', async () => {
    const steps: string[] = [];
    vi.mocked(addPermissionRule).mockImplementation(async () => { steps.push('persist'); });
    vi.spyOn(manager, 'refreshPermissions').mockImplementation(async () => { steps.push('synchronize'); });
    const request = manager['handlePermissionRequest']('channel-1', shellRequest, { sessionId: 'session-1' })
      .then(result => { steps.push('resolve'); return result; });
    await vi.waitFor(() => expect(manager.hasPendingPermission('channel-1')).toBe(true));
    await manager.resolvePermission('channel-1', true, true);
    expect(await request).toMatchObject({ result: { kind: 'approve-once' } });
    expect(steps).toEqual(['persist', 'synchronize', 'resolve']);
  });

  it('surfaces failed persistence and does not approve the request', async () => {
    const events = vi.fn();
    manager.onSessionEvent(events);
    vi.mocked(addPermissionRule).mockRejectedValue(new Error('storage offline'));
    const request = manager['handlePermissionRequest']('channel-1', shellRequest, { sessionId: 'session-1' });
    await vi.waitFor(() => expect(manager.hasPendingPermission('channel-1')).toBe(true));
    await manager.resolvePermission('channel-1', true, true);
    expect(await request).toMatchObject({ result: { kind: 'reject', feedback: expect.stringContaining('storage offline') } });
    expect(events).toHaveBeenCalledWith('session-1', 'channel-1', {
      type: 'assistant.message', data: { content: expect.stringContaining('could not save and synchronize') },
    });
  });

  it('denies hook asks during assisted autopilot rather than displaying a prompt', async () => {
    vi.mocked(manager.getSessionMode).mockResolvedValue('autopilot');
    const wrapped = manager['wrapHooksWithAsk']({
      onPreToolUse: async () => ({ permissionDecision: 'ask', permissionDecisionReason: 'Explicit hook approval' }),
    }, 'channel-1');
    const result = await wrapped!.onPreToolUse!(
      { toolName: 'bash', toolArgs: {}, timestamp: Date.now(), cwd: '/tmp/permission-test' },
      { sessionId: 'session-1' },
    );
    expect(result).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Explicit hook approval' });
    expect(manager.hasPendingPermission('channel-1')).toBe(false);
  });

  it('enforces hard denies before invoking workspace hooks for built-in shell tools', async () => {
    const hook = vi.fn().mockResolvedValue({ permissionDecision: 'allow' });
    const wrapped = manager['wrapHooksWithAsk']({ onPreToolUse: hook }, 'channel-1', true)!;
    for (const toolArgs of [{ command: 'launchctl unload fake-service' }, '{"command":"launchctl unload fake-service"}']) {
      const result = await wrapped.onPreToolUse!(
        { toolName: 'bash', toolArgs }, { sessionId: 'session-1' },
      );
      expect(result.permissionDecision).toBe('deny');
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('checks command rewrites returned by a workspace hook', async () => {
    const wrapped = manager['wrapHooksWithAsk']({
      onPreToolUse: async () => ({
        permissionDecision: 'allow',
        modifiedArgs: { command: 'launchctl unload fake-service' },
      }),
    }, 'channel-1', true)!;
    const result = await wrapped.onPreToolUse!(
      { toolName: 'bash', toolArgs: { command: 'printf safe' } }, { sessionId: 'session-1' },
    );
    expect(result.permissionDecision).toBe('deny');
  });

  it('preserves ordinary hook output and denies uninspectable shell arguments', async () => {
    const hook = vi.fn().mockResolvedValue({ permissionDecision: 'allow', additionalContext: 'existing hook' });
    const wrapped = manager['wrapHooksWithAsk']({ onPreToolUse: hook }, 'channel-1', true)!;
    const allowed = await wrapped.onPreToolUse!(
      { toolName: 'bash', toolArgs: { command: 'printf safe' } }, { sessionId: 'session-1' },
    );
    expect(allowed).toEqual({ permissionDecision: 'allow', additionalContext: 'existing hook' });
    const denied = await wrapped.onPreToolUse!(
      { toolName: 'bash', toolArgs: 'invalid-json' }, { sessionId: 'session-1' },
    );
    expect(denied.permissionDecision).toBe('deny');
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
