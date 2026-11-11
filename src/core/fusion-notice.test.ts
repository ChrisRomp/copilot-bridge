import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalSetting } from '../state/store.js';
import type { ModelInfo } from './command-handler.js';
import { sendFusionNotice } from './fusion-notice.js';
import { enterQuietMode, _resetForTest } from './quiet-mode.js';

vi.mock('../state/store.js', () => ({ getGlobalSetting: vi.fn() }));

describe('Fusion notice delivery', () => {
  const models: ModelInfo[] = [{ id: 'model-a', name: 'Model A' }];
  const manager = {
    listModels: vi.fn<() => Promise<ModelInfo[]>>(),
    isCurrentPermissionAttachment: vi.fn(),
    isUnattendedExecution: vi.fn(),
  };
  const adapter = { sendMessage: vi.fn().mockResolvedValue('post-1') };
  const threadRoot = vi.fn().mockReturnValue('thread-1');
  const event = {
    type: 'bridge.fusion_model' as const,
    data: { model: 'model-a', role: 'judge', attachmentGeneration: 1 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager.listModels.mockResolvedValue(models);
    manager.isCurrentPermissionAttachment.mockReturnValue(true);
    manager.isUnattendedExecution.mockReturnValue(false);
    vi.mocked(getGlobalSetting).mockResolvedValue(null);
  });
  afterEach(_resetForTest);

  it.each(['model catalog', 'streamer setting'])('drops an old attachment notice after waiting for the %s', async lookup => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (lookup === 'model catalog') {
      manager.listModels.mockImplementationOnce(async () => { await gate; return models; });
    } else {
      vi.mocked(getGlobalSetting).mockImplementationOnce(async () => { await gate; return null; });
    }

    const sending = sendFusionNotice('ch', event, manager, adapter, threadRoot);
    await vi.waitFor(() => expect(lookup === 'model catalog' ? manager.listModels : getGlobalSetting).toHaveBeenCalled());
    manager.isCurrentPermissionAttachment.mockReturnValue(false);
    release();
    await sending;

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(threadRoot).not.toHaveBeenCalled();
  });

  it.each(['quiet', 'unattended'])('suppresses notices if the channel becomes %s during lookup', async mode => {
    manager.listModels.mockImplementationOnce(async () => {
      if (mode === 'quiet') enterQuietMode('ch');
      else manager.isUnattendedExecution.mockReturnValue(true);
      return models;
    });
    await sendFusionNotice('ch', event, manager, adapter, threadRoot);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a current notice with redaction and role intact', async () => {
    vi.mocked(getGlobalSetting).mockResolvedValue('1');
    manager.listModels.mockResolvedValue([]);
    await sendFusionNotice('ch', event, manager, adapter, threadRoot);
    expect(adapter.sendMessage).toHaveBeenCalledWith('ch', 'Fusion is using **Hidden Model** for review.', { threadRootId: 'thread-1' });
  });
});
