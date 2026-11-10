import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../state/store.js';
import { getEnabledScheduledTasks, getScheduledTask, insertTaskHistory, updateScheduledTaskLastRun, deleteScheduledTask } from '../state/store.js';
import { initScheduler, stopAll } from './scheduler.js';

vi.mock('../state/store.js', () => ({
  getEnabledScheduledTasks: vi.fn(),
  getScheduledTask: vi.fn(),
  insertTaskHistory: vi.fn(),
  updateScheduledTaskLastRun: vi.fn(),
  deleteScheduledTask: vi.fn(),
}));

const task: ScheduledTask = {
  id: 'task-123', channelId: 'channel-456', botName: 'helper', prompt: 'Check the build',
  timezone: 'UTC', enabled: true, createdAt: '2026-11-10T12:00:00.000Z',
  cronExpr: '* * * * * *',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
  vi.clearAllMocks();
  vi.mocked(getEnabledScheduledTasks).mockResolvedValue([task]);
  vi.mocked(getScheduledTask).mockResolvedValue(task);
  vi.mocked(insertTaskHistory).mockResolvedValue(undefined);
  vi.mocked(updateScheduledTaskLastRun).mockResolvedValue(undefined);
  vi.mocked(deleteScheduledTask).mockResolvedValue(undefined);
});

afterEach(() => {
  stopAll();
  vi.useRealTimers();
});

describe('scheduler automation provenance', () => {
  it('passes the persisted task ID through the real CronJob execution path', async () => {
    const sendMessage = vi.fn().mockResolvedValue('done');
    await initScheduler({ sendMessage, postMessage: vi.fn().mockResolvedValue(undefined) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('channel-456', 'Check the build', 'task-123');
    expect(insertTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-123', status: 'success' }));
    expect(updateScheduledTaskLastRun).toHaveBeenCalledWith('task-123', expect.any(String), expect.any(String));
  });

  it('preserves one-off provenance and cleanup', async () => {
    const oneOff: ScheduledTask = { ...task, id: 'one-off', cronExpr: undefined, runAt: '2026-11-10T12:00:01.000Z' };
    vi.mocked(getEnabledScheduledTasks).mockResolvedValue([oneOff]);
    vi.mocked(getScheduledTask).mockResolvedValue(oneOff);
    const sendMessage = vi.fn().mockResolvedValue('done');
    await initScheduler({ sendMessage, postMessage: vi.fn().mockResolvedValue(undefined) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('channel-456', 'Check the build', 'one-off');
    expect(deleteScheduledTask).toHaveBeenCalledWith('one-off');
  });

  it('does not send disabled jobs or accidentally create human-authority turns', async () => {
    vi.mocked(getScheduledTask).mockResolvedValue({ ...task, enabled: false });
    const sendMessage = vi.fn();
    await initScheduler({ sendMessage, postMessage: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(insertTaskHistory).not.toHaveBeenCalled();
  });
});
