import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import type { PermissionStore } from '../permission-store.js';
import type { RunEntry, RunRegistry } from '../run-registry.js';
import { registerRunResumeRoutes, type RunResumeRouteDeps } from './runs-resume.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const limitedAgentHeader = { authorization: 'Bearer test-secret-limited' };
const noExecuteHeader = { authorization: 'Bearer test-secret-no-execute' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['limited-agent', {
      secret: 'test-secret-limited',
      allowedAgents: ['bot-b'],
      allowedOps: ['agent:execute'],
    }],
    ['no-execute', {
      secret: 'test-secret-no-execute',
      allowedAgents: ['bot-a'],
      allowedOps: ['agent:read'],
    }],
  ]),
};

const makeRunEntry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  runId: 'run-123',
  bot: 'bot-a',
  channelId: 'channel-123',
  status: 'awaiting',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('registerRunResumeRoutes', () => {
  let app: FastifyInstance;
  let getRun: ReturnType<typeof vi.fn>;
  let setApproveTool: ReturnType<typeof vi.fn>;
  let setApproveAll: ReturnType<typeof vi.fn>;
  let hasPending: ReturnType<typeof vi.fn>;
  let getPending: ReturnType<typeof vi.fn>;
  let resolvePending: ReturnType<typeof vi.fn>;
  let addPermissionRule: ReturnType<typeof vi.fn>;
  let deps: RunResumeRouteDeps;

  beforeEach(() => {
    getRun = vi.fn().mockReturnValue(makeRunEntry());
    setApproveTool = vi.fn();
    setApproveAll = vi.fn();
    hasPending = vi.fn().mockReturnValue(true);
    getPending = vi.fn().mockReturnValue({
      runId: 'run-123',
      toolKind: 'bash',
      createdAt: 1770000000000,
    });
    resolvePending = vi.fn().mockReturnValue(true);
    addPermissionRule = vi.fn().mockResolvedValue(undefined);
    deps = {
      runRegistry: { get: getRun } as Partial<RunRegistry> as RunRegistry,
      permissionStore: {
        setApproveTool,
        setApproveAll,
      } as Partial<PermissionStore> as PermissionStore,
      pendingPermissionStore: {
        has: hasPending,
        get: getPending,
        resolve: resolvePending,
      } as Partial<PendingPermissionStore> as PendingPermissionStore,
      addPermissionRule,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerRunResumeRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no auth header is present', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 when run_id is unknown', async () => {
    getRun.mockReturnValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/unknown-run/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found' });
  });

  it('returns 403 when API key lacks agent:execute permission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: noExecuteHeader,
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 when agent is not in allowedAgents', async () => {
    getRun.mockReturnValue(makeRunEntry({ bot: 'bot-a' }));

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: limitedAgentHeader,
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 409 when no pending permission request exists for the run', async () => {
    hasPending.mockReturnValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'No pending permission request' });
  });

  it('returns 400 when decision value is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'maybe' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid decision' });
  });

  it('returns 200 and resolves pending permission for allow-once', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-once' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run_id: 'run-123', status: 'in_progress' });
    expect(resolvePending).toHaveBeenCalledWith('run-123', 'allow-once');
  });

  it('calls permissionStore.setApproveTool with the pending toolKind for allow-session', async () => {
    await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-session' },
    });

    expect(setApproveTool).toHaveBeenCalledWith('run-123', 'bash');
    expect(resolvePending).toHaveBeenCalledWith('run-123', 'allow-session');
  });

  it('calls permissionStore.setApproveAll for allow-all-session', async () => {
    await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-all-session' },
    });

    expect(setApproveAll).toHaveBeenCalledWith('run-123');
    expect(resolvePending).toHaveBeenCalledWith('run-123', 'allow-all-session');
  });

  it("calls addPermissionRule with channelId, toolKind, '*', and allow for allow-all", async () => {
    await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'allow-all' },
    });

    expect(addPermissionRule).toHaveBeenCalledWith('channel-123', 'bash', '*', 'allow');
    expect(resolvePending).toHaveBeenCalledWith('run-123', 'allow-all');
  });

  it('resolves deny without modifying permission stores or persistent rules', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-123/resume',
      headers: fullAccessHeader,
      payload: { decision: 'deny' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolvePending).toHaveBeenCalledWith('run-123', 'deny');
    expect(setApproveTool).not.toHaveBeenCalled();
    expect(setApproveAll).not.toHaveBeenCalled();
    expect(addPermissionRule).not.toHaveBeenCalled();
  });
});
