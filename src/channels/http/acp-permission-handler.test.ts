import type { PermissionRequest } from '@github/copilot-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpPermissionHandler } from './acp-permission-handler.js';
import { PendingPermissionStore } from './pending-permission-store.js';
import type { PermissionStore } from './permission-store.js';

const request: PermissionRequest = { kind: 'shell', toolCallId: 'tool-call-1' };
const invocation = { sessionId: 'session-1' };

describe('createAcpPermissionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns approved immediately when permissionStore.shouldApprove returns true', async () => {
    const permissionStore = { shouldApprove: vi.fn().mockReturnValue(true) } as unknown as PermissionStore;
    const pendingPermissionStore = new PendingPermissionStore();
    const getEmitter = vi.fn();
    const handler = createAcpPermissionHandler({ current: 'run-1' }, permissionStore, pendingPermissionStore, getEmitter);

    await expect(handler(request, invocation)).resolves.toEqual({ kind: 'approved' });
    expect(permissionStore.shouldApprove).toHaveBeenCalledWith('session-1', 'shell');
    expect(getEmitter).not.toHaveBeenCalled();
    expect(pendingPermissionStore.has('run-1')).toBe(false);
  });

  it('calls getEmitter and fires run.awaiting event when not auto-approved', async () => {
    const permissionStore = { shouldApprove: vi.fn().mockReturnValue(false) } as unknown as PermissionStore;
    const pendingPermissionStore = new PendingPermissionStore();
    const emitter = vi.fn();
    const getEmitter = vi.fn().mockReturnValue(emitter);
    const handler = createAcpPermissionHandler({ current: 'run-1' }, permissionStore, pendingPermissionStore, getEmitter);

    const result = handler(request, invocation);

    expect(getEmitter).toHaveBeenCalledWith('run-1');
    expect(emitter).toHaveBeenCalledWith({
      type: 'run.awaiting',
      data: { run_id: 'run-1', tool: 'shell', detail: JSON.stringify(request) },
    });
    expect(pendingPermissionStore.has('run-1')).toBe(true);

    pendingPermissionStore.resolve('run-1', 'allow-once');
    await expect(result).resolves.toEqual({ kind: 'approved' });
  });

  it('resolving pending with allow-once returns approved', async () => {
    const { handler, pendingPermissionStore } = createPendingHandler();
    const result = handler(request, invocation);

    pendingPermissionStore.resolve('run-1', 'allow-once');

    await expect(result).resolves.toEqual({ kind: 'approved' });
  });

  it('resolving pending with deny returns denied-by-rules rules []', async () => {
    const { handler, pendingPermissionStore } = createPendingHandler();
    const result = handler(request, invocation);

    pendingPermissionStore.resolve('run-1', 'deny');

    await expect(result).resolves.toEqual({ kind: 'denied-by-rules', rules: [] });
  });

  it('resolving pending with allow-all-session returns approved', async () => {
    const { handler, pendingPermissionStore } = createPendingHandler();
    const result = handler(request, invocation);

    pendingPermissionStore.resolve('run-1', 'allow-all-session');

    await expect(result).resolves.toEqual({ kind: 'approved' });
  });

  it('timeout with fake timers advancing 300001ms returns denied-by-rules rules []', async () => {
    vi.useFakeTimers();
    const { handler, pendingPermissionStore } = createPendingHandler();
    const result = handler(request, invocation);

    expect(pendingPermissionStore.has('run-1')).toBe(true);
    await vi.advanceTimersByTimeAsync(300001);

    await expect(result).resolves.toEqual({ kind: 'denied-by-rules', rules: [] });
    expect(pendingPermissionStore.has('run-1')).toBe(false);
  });
});

function createPendingHandler() {
  const permissionStore = { shouldApprove: vi.fn().mockReturnValue(false) } as unknown as PermissionStore;
  const pendingPermissionStore = new PendingPermissionStore();
  const handler = createAcpPermissionHandler(
    { current: 'run-1' },
    permissionStore,
    pendingPermissionStore,
    vi.fn().mockReturnValue(undefined),
  );

  return { handler, pendingPermissionStore };
}
