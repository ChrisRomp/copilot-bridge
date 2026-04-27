import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingPermission } from '../types.js';

// Mock workspace-manager to avoid filesystem side effects in SessionManager constructor
vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath: vi.fn().mockReturnValue('/tmp/test-workspace'),
  getWorkspaceAllowPaths: vi.fn().mockResolvedValue([]),
  ensureWorkspacesDir: vi.fn(),
}));

// Block filesystem scanning in loadMcpServers (internal to session-manager.ts)
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs') as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Let the test tempdir work, block plugin/MCP scanning
      if (typeof p === 'string' && (p.includes('installed-plugins') || p.includes('mcp-config.json'))) {
        return false;
      }
      return (actual as any).existsSync(p);
    }),
  };
});

import { SessionManager } from './session-manager.js';
import { CopilotBridge } from './bridge.js';

describe('permission vocabulary (hook → SDK resolution)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    // Stub CopilotBridge minimally — we don't need real SDK calls
    const stubBridge = {} as CopilotBridge;
    manager = new SessionManager(stubBridge);
  });

  it('approve-once from resolvePermission maps to hook allow', async () => {
    const channelId = 'test-chan';
    const hooks = {
      onPreToolUse: vi.fn().mockResolvedValue({
        permissionDecision: 'ask',
        permissionDecisionReason: 'Hook wants confirmation',
      }),
    };

    // Wrap hooks through the production path
    const wrapped = (manager as any).wrapHooksWithAsk(hooks, channelId);
    expect(wrapped?.onPreToolUse).toBeDefined();

    // Invoke the wrapped hook — it should create a pending permission and block
    const hookPromise = wrapped!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{"command":"ls"}', timestamp: Date.now(), cwd: '/tmp' },
      { sessionId: 'sess-1' },
    );

    // Yield so the async hook reaches the pending-permission setup
    await new Promise(r => setTimeout(r, 0));

    // Verify a pending permission was queued
    const queue = (manager as any).pendingPermissions.get(channelId);
    expect(queue).toHaveLength(1);
    expect(queue[0].fromHook).toBe(true);
    expect(queue[0].toolName).toBe('hook:bash');

    // Resolve via the production resolvePermission path (allow=true)
    const resolved = await manager.resolvePermission(channelId, true);
    expect(resolved).toBe(true);

    // The hook promise should resolve with the mapped vocabulary
    const result = await hookPromise;
    expect(result.permissionDecision).toBe('allow');
  });

  it('reject from resolvePermission maps to hook deny', async () => {
    const channelId = 'test-chan-deny';
    const hooks = {
      onPreToolUse: vi.fn().mockResolvedValue({
        permissionDecision: 'ask',
        permissionDecisionReason: 'Needs review',
      }),
    };

    const wrapped = (manager as any).wrapHooksWithAsk(hooks, channelId);

    const hookPromise = wrapped!.onPreToolUse!(
      { toolName: 'edit', toolArgs: '{}', timestamp: Date.now(), cwd: '/tmp' },
      { sessionId: 'sess-2' },
    );

    // Yield so the async hook reaches the pending-permission setup
    await new Promise(r => setTimeout(r, 0));

    // Resolve via production path (allow=false → reject)
    await manager.resolvePermission(channelId, false);

    const result = await hookPromise;
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toBe('Needs review');
  });

  it('non-ask hook decisions pass through without queuing', async () => {
    const channelId = 'test-chan-passthrough';
    const hooks = {
      onPreToolUse: vi.fn().mockResolvedValue({
        permissionDecision: 'allow',
        additionalContext: 'auto-approved',
      }),
    };

    const wrapped = (manager as any).wrapHooksWithAsk(hooks, channelId);

    const result = await wrapped!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{}', timestamp: Date.now(), cwd: '/tmp' },
      { sessionId: 'sess-3' },
    );

    // Should pass through directly — no pending permission created
    expect(result.permissionDecision).toBe('allow');
    expect(result.additionalContext).toBe('auto-approved');
    expect((manager as any).pendingPermissions.get(channelId)).toBeUndefined();
  });

  it('undefined hook result passes through without queuing', async () => {
    const channelId = 'test-chan-null';
    const hooks = {
      onPreToolUse: vi.fn().mockResolvedValue(undefined),
    };

    const wrapped = (manager as any).wrapHooksWithAsk(hooks, channelId);

    const result = await wrapped!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{}', timestamp: Date.now(), cwd: '/tmp' },
      { sessionId: 'sess-4' },
    );

    expect(result).toBeUndefined();
    expect((manager as any).pendingPermissions.get(channelId)).toBeUndefined();
  });

  it('hooks without onPreToolUse are returned unchanged', () => {
    const hooks = { onSessionStart: vi.fn() };
    const wrapped = (manager as any).wrapHooksWithAsk(hooks, 'chan');
    expect(wrapped).toBe(hooks);
  });

  it('undefined hooks return undefined', () => {
    const wrapped = (manager as any).wrapHooksWithAsk(undefined, 'chan');
    expect(wrapped).toBeUndefined();
  });

  it('resolvePermission returns false when no pending permissions', async () => {
    const result = await manager.resolvePermission('nonexistent', true);
    expect(result).toBe(false);
  });
});

describe('PendingPermission resolve type contract', () => {
  it('resolve callback accepts SDK 0.3.0 vocabulary', () => {
    // Documents the expected vocabulary as a runtime assertion.
    // Note: tsconfig excludes test files, so this isn't a tsc-level guard.
    const results: Parameters<PendingPermission['resolve']>[0][] = [
      { kind: 'approve-once' },
      { kind: 'reject' },
      { kind: 'reject', feedback: 'not allowed' },
      { kind: 'user-not-available' },
    ];
    expect(results).toHaveLength(4);
  });
});
