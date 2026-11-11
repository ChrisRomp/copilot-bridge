import { describe, expect, it, vi } from 'vitest';
import type { CopilotSession } from '@github/copilot-sdk';
import { CopilotBridge, type SDKPermissionConfig, type SDKPermissionMode } from './bridge.js';

function setup(mode: SDKPermissionMode = 'manual') {
  const permissions = {
    getMode: vi.fn().mockResolvedValue({ mode }),
    setMode: vi.fn().mockResolvedValue({ success: true, mode }),
    getCapabilities: vi.fn().mockResolvedValue({ assistedApproval: true, bypassPermissions: false }),
    configure: vi.fn().mockResolvedValue({ success: true }),
  };
  const session = {
    sessionId: 'session-permissions',
    permissionModeResult: { success: true, mode } as CopilotSession['permissionModeResult'],
    rpc: { permissions },
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    createSession: vi.fn().mockResolvedValue(session),
    resumeSession: vi.fn().mockResolvedValue(session),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
  const bridge = new CopilotBridge();
  vi.spyOn(bridge, 'start').mockResolvedValue(undefined);
  (bridge as any).client = client;
  const onPermissionRequest = vi.fn().mockResolvedValue({ kind: 'reject' });
  return { bridge, session, permissions, client, onPermissionRequest };
}

describe('CopilotBridge permission mode initialization', () => {
  it.each(['create', 'resume'] as const)('%s enables extensions together with configuration discovery', async operation => {
    const { bridge, client, session, onPermissionRequest } = setup();
    const options = { onPermissionRequest, enableConfigDiscovery: true };
    if (operation === 'create') {
      await bridge.createSession(options);
    } else {
      await bridge.resumeSession(session.sessionId, options);
    }
    const opts = operation === 'create' ? client.createSession.mock.calls[0][0] : client.resumeSession.mock.calls[0][1];
    expect(opts.enableConfigDiscovery).toBe(true);
    expect(opts.requestExtensions).toBe(true);
  });

  it.each(['create', 'resume'] as const)('%s explicitly defaults to manual', async operation => {
    const { bridge, client, session, onPermissionRequest } = setup();
    const result = operation === 'create'
      ? await bridge.createSession({ onPermissionRequest })
      : await bridge.resumeSession(session.sessionId, { onPermissionRequest });
    const opts = operation === 'create' ? client.createSession.mock.calls[0][0] : client.resumeSession.mock.calls[0][1];
    expect(opts.permissionMode).toBe('manual');
    expect(opts.requestExtensions).toBe(false);
    expect(opts.onPermissionRequest).toBe(onPermissionRequest);
    expect(result).toBe(session);
    expect(bridge.getSession(session.sessionId)).toBe(session);
  });

  it.each(['create', 'resume'] as const)('%s passes assisted mode through', async operation => {
    const { bridge, client, session, onPermissionRequest } = setup('assisted');
    if (operation === 'create') {
      await bridge.createSession({ onPermissionRequest, permissionMode: 'assisted' });
      expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'assisted' }));
    } else {
      await bridge.resumeSession(session.sessionId, { onPermissionRequest, permissionMode: 'assisted' });
      expect(client.resumeSession).toHaveBeenCalledWith(session.sessionId, expect.objectContaining({ permissionMode: 'assisted' }));
    }
    expect(session.disconnect).not.toHaveBeenCalled();
  });

  it.each(['create', 'resume'] as const)('%s forwards an opaque Auto tier without hardcoding Fusion mappings', async operation => {
    const { bridge, client, session, onPermissionRequest } = setup();
    if (operation === 'create') {
      await bridge.createSession({ model: 'auto', autoTier: 'provider-route', onPermissionRequest });
      expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ capi: { autoTier: 'provider-route' } }));
    } else {
      await bridge.resumeSession(session.sessionId, { autoTier: 'provider-route', onPermissionRequest });
      expect(client.resumeSession).toHaveBeenCalledWith(session.sessionId, expect.objectContaining({ capi: { autoTier: 'provider-route' } }));
    }
  });

  it('resume without options still explicitly selects manual', async () => {
    const { bridge, client, session } = setup();
    await bridge.resumeSession(session.sessionId);
    expect(client.resumeSession).toHaveBeenCalledWith(session.sessionId, expect.objectContaining({ permissionMode: 'manual' }));
  });

  for (const operation of ['create', 'resume'] as const) {
    it.each([
      { success: false, mode: 'manual' },
      { success: false, mode: 'assisted' },
      { success: true, mode: 'manual' },
      undefined,
    ] as CopilotSession['permissionModeResult'][])(`${operation} rejects an unconfirmed mode result %j and cleans up`, async result => {
      const { bridge, client, session, onPermissionRequest } = setup('assisted');
      session.permissionModeResult = result;
      const promise = operation === 'create'
        ? bridge.createSession({ onPermissionRequest, permissionMode: 'assisted' })
        : bridge.resumeSession(session.sessionId, { onPermissionRequest, permissionMode: 'assisted' });
      await expect(promise).rejects.toThrow('could not apply permission mode "assisted"');
      expect(bridge.getSession(session.sessionId)).toBeUndefined();
      expect(session.disconnect).toHaveBeenCalledOnce();
      if (operation === 'create') {
        expect(client.deleteSession).toHaveBeenCalledWith(session.sessionId);
      } else {
        expect(client.deleteSession).not.toHaveBeenCalled();
      }
    });
  }

  it('cleans up a new session even when disconnect fails, preserving the mode error', async () => {
    const { bridge, client, session, onPermissionRequest } = setup('assisted');
    session.permissionModeResult = { success: false, mode: 'manual' };
    session.disconnect.mockRejectedValue(new Error('disconnect failed'));
    client.deleteSession.mockRejectedValue(new Error('delete failed'));
    await expect(bridge.createSession({ onPermissionRequest, permissionMode: 'assisted' }))
      .rejects.toThrow('could not apply permission mode "assisted"');
    expect(client.deleteSession).toHaveBeenCalledWith(session.sessionId);
    expect(bridge.getSession(session.sessionId)).toBeUndefined();
  });

  it('applies explicit manual when resuming an already-active assisted session', async () => {
    const { bridge, session, client, permissions, onPermissionRequest } = setup('assisted');
    await bridge.createSession({ onPermissionRequest, permissionMode: 'assisted' });
    permissions.setMode.mockResolvedValue({ success: true, mode: 'manual' });
    expect(await bridge.resumeSession(session.sessionId)).toBe(session);
    expect(permissions.setMode).toHaveBeenCalledWith({ mode: 'manual' });
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('stages an explicit Auto preference when resuming an already-active session', async () => {
    const { bridge, session, onPermissionRequest } = setup();
    const setAutoTier = vi.fn().mockResolvedValue({ status: 'pending' });
    Object.assign(session, { setAutoTier });
    await bridge.createSession({ onPermissionRequest });
    await bridge.resumeSession(session.sessionId, { onPermissionRequest, autoTier: 'dynamic-high' });
    expect(setAutoTier).toHaveBeenCalledWith('dynamic-high');
  });

  it('does not silently reuse an active session when changing its mode fails', async () => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    permissions.setMode.mockResolvedValue({ success: false, mode: 'manual' });
    await expect(bridge.resumeSession(session.sessionId, { onPermissionRequest, permissionMode: 'assisted' }))
      .rejects.toThrow('could not apply permission mode "assisted"');
    expect(bridge.getSession(session.sessionId)).toBe(session);
    expect(session.disconnect).not.toHaveBeenCalled();
  });
});

describe('CopilotBridge permission RPC wrappers', () => {
  it('unwraps the native permission mode without translating it to bridge preferences', async () => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    for (const mode of ['manual', 'assisted', 'allow-all']) {
      permissions.getMode.mockResolvedValue({ mode });
      expect(await bridge.getPermissionMode(session.sessionId)).toBe(mode);
    }
  });

  it('returns void only after the requested mode succeeds and matches', async () => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    permissions.setMode.mockResolvedValue({ success: true, mode: 'assisted' });
    await expect(bridge.setPermissionMode(session.sessionId, 'assisted')).resolves.toBeUndefined();
    expect(permissions.setMode).toHaveBeenCalledWith({ mode: 'assisted' });
  });

  it.each([
    { success: false, mode: 'manual' },
    { success: false, mode: 'assisted' },
    { success: true, mode: 'manual' },
    undefined,
  ])('rejects failed or mismatched mode mutation %j', async result => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    permissions.setMode.mockResolvedValue(result);
    await expect(bridge.setPermissionMode(session.sessionId, 'assisted')).rejects.toThrow('could not apply permission mode');
  });

  it('passes capabilities and typed policy configuration through unchanged', async () => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    await expect(bridge.getPermissionCapabilities(session.sessionId)).resolves.toEqual({
      assistedApproval: true, bypassPermissions: false,
    });
    const config: SDKPermissionConfig = { hostPolicyPermissionHandler: true, rules: { approved: [], denied: [] } };
    await expect(bridge.configurePermissions(session.sessionId, config)).resolves.toEqual({ success: true });
    expect(permissions.configure).toHaveBeenCalledWith(config);
    // Preserve native failure results so the caller can refuse policy activation.
    permissions.configure.mockResolvedValue({ success: false });
    await expect(bridge.configurePermissions(session.sessionId, config)).resolves.toEqual({ success: false });
  });

  it('propagates RPC errors rather than reporting mode or policy success', async () => {
    const { bridge, session, permissions, onPermissionRequest } = setup();
    await bridge.createSession({ onPermissionRequest });
    for (const rpc of Object.values(permissions)) rpc.mockRejectedValue(new Error('RPC failed'));
    await expect(bridge.getPermissionMode(session.sessionId)).rejects.toThrow('RPC failed');
    await expect(bridge.setPermissionMode(session.sessionId, 'assisted')).rejects.toThrow('RPC failed');
    await expect(bridge.getPermissionCapabilities(session.sessionId)).rejects.toThrow('RPC failed');
    await expect(bridge.configurePermissions(session.sessionId, {})).rejects.toThrow('RPC failed');
  });

  it('rejects wrappers for inactive sessions', async () => {
    const { bridge } = setup();
    await expect(bridge.getPermissionMode('missing')).rejects.toThrow('Session missing not active');
    await expect(bridge.setPermissionMode('missing', 'manual')).rejects.toThrow('Session missing not active');
    await expect(bridge.getPermissionCapabilities('missing')).rejects.toThrow('Session missing not active');
    await expect(bridge.configurePermissions('missing', {})).rejects.toThrow('Session missing not active');
  });
});
