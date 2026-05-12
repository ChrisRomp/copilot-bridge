import { describe, expect, it } from 'vitest';
import { PermissionStore } from './permission-store.js';

describe('PermissionStore', () => {
  it('shouldApprove returns false for unknown session', () => {
    const store = new PermissionStore();

    expect(store.shouldApprove('missing-session', 'read')).toBe(false);
  });

  it('setApproveTool causes shouldApprove true for that specific tool kind', () => {
    const store = new PermissionStore();

    store.setApproveTool('session-1', 'read');

    expect(store.shouldApprove('session-1', 'read')).toBe(true);
  });

  it('setApproveTool does not cause shouldApprove true for a different tool kind', () => {
    const store = new PermissionStore();

    store.setApproveTool('session-1', 'read');

    expect(store.shouldApprove('session-1', 'write')).toBe(false);
  });

  it('setApproveAll causes shouldApprove true for any tool kind', () => {
    const store = new PermissionStore();

    store.setApproveAll('session-1');

    expect(store.shouldApprove('session-1', 'read')).toBe(true);
    expect(store.shouldApprove('session-1', 'write')).toBe(true);
  });

  it('clearSession removes all state for that session', () => {
    const store = new PermissionStore();

    store.setApproveAll('session-1');
    store.setApproveTool('session-1', 'read');
    store.clearSession('session-1');

    expect(store.shouldApprove('session-1', 'read')).toBe(false);
    expect(store.shouldApprove('session-1', 'write')).toBe(false);
  });

  it('clearSession does not affect other sessions', () => {
    const store = new PermissionStore();

    store.setApproveTool('session-1', 'read');
    store.setApproveAll('session-2');
    store.clearSession('session-1');

    expect(store.shouldApprove('session-1', 'read')).toBe(false);
    expect(store.shouldApprove('session-2', 'read')).toBe(true);
    expect(store.shouldApprove('session-2', 'write')).toBe(true);
  });

  it('multiple sessions are independent', () => {
    const store = new PermissionStore();

    store.setApproveTool('session-1', 'read');
    store.setApproveTool('session-2', 'write');

    expect(store.shouldApprove('session-1', 'read')).toBe(true);
    expect(store.shouldApprove('session-1', 'write')).toBe(false);
    expect(store.shouldApprove('session-2', 'write')).toBe(true);
    expect(store.shouldApprove('session-2', 'read')).toBe(false);
  });
});
