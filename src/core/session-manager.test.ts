import { beforeEach, describe, expect, it, vi } from 'vitest';

const getChannelConfig = vi.fn(async (channelId: string) => ({
  platform: channelId === 'http-channel' ? 'http' : 'mattermost',
  workingDirectory: '/workspace',
}));
const getChannelBotName = vi.fn(async () => 'bob');
const getWorkspaceOverride = vi.fn(async () => null);
const getWorkspacePath = vi.fn(async () => '/workspace');
const ensureWorkspacesDir = vi.fn();

vi.mock('../config.js', () => ({
  getChannelConfig,
  getChannelBotName,
  getChannelBotConfig: vi.fn(),
  evaluateConfigPermissions: vi.fn(),
  isBotAdmin: vi.fn(() => false),
  getConfig: vi.fn(() => ({
    defaults: {},
    platforms: {
      http: { bots: {} },
      mattermost: { bots: {} },
    },
  })),
  getInterAgentConfig: vi.fn(() => ({ enabled: false })),
  isHardDeny: vi.fn(() => false),
  resolveProviderConfig: vi.fn(() => null),
}));

vi.mock('../state/store.js', () => ({
  getChannelSession: vi.fn(),
  setChannelSession: vi.fn(),
  clearChannelSession: vi.fn(),
  getChannelPrefs: vi.fn(async () => null),
  setChannelPrefs: vi.fn(),
  checkPermission: vi.fn(),
  addPermissionRule: vi.fn(),
  getWorkspaceOverride,
  setWorkspaceOverride: vi.fn(),
  listWorkspaceOverrides: vi.fn(async () => []),
  recordAgentCall: vi.fn(),
}));

vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath,
  getWorkspaceAllowPaths: vi.fn(async () => []),
  ensureWorkspacesDir,
}));

describe('SessionManager custom tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers and invokes update_card_status for HTTP sessions', async () => {
    const { SessionManager } = await import('./session-manager.js');
    const manager = new SessionManager({} as any);
    const handler = vi.fn(async (_channelId: string, args: Record<string, unknown>) => ({
      success: true,
      status: args.status,
    }));

    manager.registerCustomToolHandler('update_card_status', handler);

    await expect(manager.listBridgeToolNames('http-channel')).resolves.toContain('update_card_status');

    const tools = await (manager as any).buildCustomTools('http-channel');
    const tool = tools.find((entry: { name: string }) => entry.name === 'update_card_status');
    expect(tool).toBeDefined();

    await expect(tool.handler({ status: 'blocked' })).resolves.toEqual({
      content: JSON.stringify({ success: true, status: 'blocked' }),
    });
    expect(handler).toHaveBeenCalledWith('http-channel', { status: 'blocked' });
  });

  it('omits update_card_status for non-HTTP sessions', async () => {
    const { SessionManager } = await import('./session-manager.js');
    const manager = new SessionManager({} as any);

    manager.registerCustomToolHandler('update_card_status', vi.fn(async () => ({ success: true })));

    await expect(manager.listBridgeToolNames('mattermost-channel')).resolves.not.toContain('update_card_status');
  });
});
