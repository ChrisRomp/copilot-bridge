import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotSession, MessageOptions, SessionEvent } from '@github/copilot-sdk';
import { CopilotBridge } from './bridge.js';
import { SessionManager } from './session-manager.js';
import { setChannelPrefs } from '../state/store.js';

vi.mock('./bridge.js', () => ({
  CopilotBridge: class {
    getSession = vi.fn<CopilotBridge['getSession']>();
    listModels = vi.fn<CopilotBridge['listModels']>().mockResolvedValue([]);
    destroySession = vi.fn<CopilotBridge['destroySession']>().mockResolvedValue(undefined);
  },
}));
vi.mock('./workspace-manager.js', () => ({
  getWorkspacePath: vi.fn().mockResolvedValue('/virtual/workspace'),
  getWorkspaceAllowPaths: vi.fn().mockResolvedValue([]),
  ensureWorkspacesDir: vi.fn(),
}));
vi.mock('../config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    defaults: { fallbackModels: ['gpt-5.2', 'gpt-5.1'] }, providers: {},
  }),
  getChannelConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('../state/store.js', () => ({
  setChannelPrefs: vi.fn<typeof setChannelPrefs>().mockResolvedValue(undefined),
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  // Prevent the SessionManager constructor from scanning user MCP/plugin files.
  existsSync: vi.fn().mockReturnValue(false),
}));

function fakeSession(sessionId: string) {
  let listener: Parameters<CopilotSession['on']>[0] | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const send = vi.fn<(options: MessageOptions | string) => ReturnType<CopilotSession['send']>>()
    .mockResolvedValue(`message-${sessionId}`);
  const on = vi.fn<CopilotSession['on']>().mockImplementation(handler => {
    listener = handler;
    return unsubscribe;
  });
  const surface: Pick<CopilotSession, 'sessionId' | 'send' | 'on'> = { sessionId, send, on };
  return {
    // Only the SDK boundary is narrowed; no real client/session is constructed.
    session: surface as CopilotSession,
    send, on, unsubscribe,
    emit: (event: SessionEvent) => listener?.(event),
  };
}

const attachments: NonNullable<Parameters<SessionManager['sendMessage']>[2]> = [
  { type: 'file', path: '/virtual/input.txt', displayName: 'input.txt' },
];
const scheduledOptions = { source: 'automation-sched-task-123' } satisfies Pick<MessageOptions, 'source'>;
const eventMetadata = { id: 'event', timestamp: '2026-11-10T00:00:00.000Z', parentId: null };
const idle: Extract<SessionEvent, { type: 'session.idle' }> = {
  ...eventMetadata, type: 'session.idle', ephemeral: true, data: {},
};

describe('SessionManager message provenance', () => {
  let bridge: CopilotBridge;
  let manager: SessionManager;
  let original: ReturnType<typeof fakeSession>;
  let refreshPermissions: ReturnType<typeof vi.fn<SessionManager['refreshPermissions']>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    bridge = new CopilotBridge();
    manager = new SessionManager(bridge);
    original = fakeSession('original');
    vi.mocked(bridge.getSession).mockReturnValue(original.session);
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({ sessionId: 'original', isNew: false });
    vi.spyOn(manager, 'cancelMemoryConsolidation').mockResolvedValue(undefined);
    vi.spyOn(manager, 'getEffectivePrefs').mockResolvedValue({
      model: 'gpt-5.4', provider: null, agent: null, verbose: false,
      threadedReplies: false, permissionMode: 'assisted', triggerMode: 'all', contextTier: 'default',
    });
    // Isolate provenance from policy I/O while requiring the real controller seam.
    refreshPermissions = vi.fn<SessionManager['refreshPermissions']>().mockResolvedValue(undefined);
    vi.spyOn(manager, 'refreshPermissions').mockImplementation(refreshPermissions);
    manager['attachSession'] = vi.fn<typeof manager['attachSession']>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes the fifth source option through the actual scheduled send path', async () => {
    await expect(manager.sendMessage('channel', 'Check build', attachments, undefined, scheduledOptions))
      .resolves.toBe('message-original');
    expect(refreshPermissions).toHaveBeenCalledExactlyOnceWith('channel');
    expect(original.send).toHaveBeenCalledExactlyOnceWith({
      prompt: 'Check build', attachments, source: 'automation-sched-task-123',
    });
  });

  it('leaves human-message source unset, including after a scheduled turn', async () => {
    await manager.sendMessage('channel', 'Scheduled task', undefined, undefined, scheduledOptions);
    await manager.sendMessage('channel', 'Human follow-up', attachments, 'human-user');
    const humanOptions = original.send.mock.calls[1][0];
    expect(humanOptions).toEqual({ prompt: 'Human follow-up', attachments });
    expect(humanOptions).not.toHaveProperty('source');
    expect(manager['lastMessageUserIds'].get('channel')).toBe('human-user');
  });

  it('preserves source and attachments through every model-fallback send attempt', async () => {
    const firstFallback = fakeSession('fallback-one');
    const secondFallback = fakeSession('fallback-two');
    original.send.mockRejectedValue(new Error('Model is at capacity'));
    firstFallback.send.mockRejectedValue(new Error('Model is unavailable'));
    vi.mocked(bridge.getSession)
      .mockReturnValueOnce(original.session)
      .mockReturnValueOnce(firstFallback.session)
      .mockReturnValueOnce(secondFallback.session);
    vi.spyOn(manager, 'newSession')
      .mockResolvedValueOnce('fallback-one')
      .mockResolvedValueOnce('fallback-two');

    await expect(manager.sendMessage('channel', 'Check build', attachments, undefined, scheduledOptions))
      .resolves.toBe('message-fallback-two');
    for (const attempt of [original, firstFallback, secondFallback]) {
      expect(attempt.send).toHaveBeenCalledExactlyOnceWith({
        prompt: 'Check build', attachments, source: 'automation-sched-task-123',
      });
    }
    expect(setChannelPrefs).toHaveBeenNthCalledWith(1, 'channel', { model: 'gpt-5.2' });
    expect(setChannelPrefs).toHaveBeenNthCalledWith(2, 'channel', { model: 'gpt-5.1' });
    expect(manager['attachSession']).not.toHaveBeenCalled();
  });

  it('preserves source when reconnecting the same session after a transport error', async () => {
    const reconnected = fakeSession('original');
    original.send.mockRejectedValue(new Error('Connection closed'));
    vi.mocked(bridge.getSession)
      .mockReturnValueOnce(original.session)
      .mockReturnValueOnce(reconnected.session);
    const newSession = vi.spyOn(manager, 'newSession');

    await expect(manager.sendMessage('channel', 'Check build', attachments, undefined, scheduledOptions))
      .resolves.toBe('message-original');
    expect(bridge.destroySession).toHaveBeenCalledExactlyOnceWith('original');
    expect(manager['attachSession']).toHaveBeenCalledExactlyOnceWith('channel', 'original');
    expect(reconnected.send).toHaveBeenCalledExactlyOnceWith({
      prompt: 'Check build', attachments, source: 'automation-sched-task-123',
    });
    expect(newSession).not.toHaveBeenCalled();
  });

  it('preserves source when failed reconnect requires a fresh session', async () => {
    const replacement = fakeSession('replacement');
    original.send.mockRejectedValue(new Error('Connection closed'));
    vi.mocked(manager['attachSession']).mockRejectedValue(new Error('Session not found'));
    vi.mocked(bridge.getSession)
      .mockReturnValueOnce(original.session)
      .mockReturnValueOnce(replacement.session);
    vi.spyOn(manager, 'newSession').mockResolvedValue('replacement');

    await expect(manager.sendMessage('channel', 'Check build', attachments, undefined, scheduledOptions))
      .resolves.toBe('message-replacement');
    expect(manager.newSession).toHaveBeenCalledExactlyOnceWith('channel');
    expect(replacement.send).toHaveBeenCalledExactlyOnceWith({
      prompt: 'Check build', attachments, source: 'automation-sched-task-123',
    });
  });

  it('does not replace the conversation when reattachment fails to synchronize permissions', async () => {
    original.send.mockRejectedValue(new Error('Connection closed'));
    vi.mocked(manager['attachSession']).mockRejectedValue(new Error('Could not synchronize permissions: policy unavailable'));
    const newSession = vi.spyOn(manager, 'newSession');

    await expect(manager.sendMessage('channel', 'Check build', attachments, undefined, scheduledOptions))
      .rejects.toThrow('Could not synchronize permissions');
    expect(newSession).not.toHaveBeenCalled();
    expect(original.send).toHaveBeenCalledTimes(1);
  });

  it.each(['agent-alice', 'automation-memory'] as const)(
    'forwards %s through the production sendAndWaitForIdle helper', async source => {
      const session = fakeSession('ephemeral');
      const response = manager['sendAndWaitForIdle'](session.session, 'Background question', 1000, source);
      expect(session.send).toHaveBeenCalledExactlyOnceWith({ prompt: 'Background question', source });
      session.emit({
        ...eventMetadata, type: 'assistant.message_delta', ephemeral: true,
        data: { messageId: 'reply', deltaContent: 'Background response' },
      });
      session.emit(idle);
      await expect(response).resolves.toBe('Background response');
      expect(session.unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not invent provenance when sendAndWaitForIdle receives no source', async () => {
    const session = fakeSession('ephemeral');
    const response = manager['sendAndWaitForIdle'](session.session, 'Question', 1000);
    expect(session.send).toHaveBeenCalledExactlyOnceWith({ prompt: 'Question', source: undefined });
    session.emit(idle);
    await expect(response).resolves.toBe('');
    expect(session.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
