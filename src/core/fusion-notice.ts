import type { ChannelAdapter } from '../types.js';
import { createLogger } from '../logger.js';
import { formatRoutedModel, type ModelInfo } from './command-handler.js';
import type { FusionModelNotice, FusionNoticeContext } from './fusion.js';
import { isQuiet } from './quiet-mode.js';
import type { SessionManager } from './session-manager.js';

const log = createLogger('bridge');
type FusionNoticeEvent =
  | { type: 'bridge.fusion_notice'; data: { content: string } & FusionNoticeContext }
  | { type: 'bridge.fusion_model'; data: FusionModelNotice & FusionNoticeContext };

export async function sendFusionNotice(
  channelId: string,
  event: FusionNoticeEvent,
  manager: Pick<SessionManager, 'listModels' | 'isCurrentPermissionAttachment' | 'isUnattendedExecution'>,
  adapter: Pick<ChannelAdapter, 'sendMessage'>,
  getThreadRootId: () => string | undefined,
): Promise<void> {
  const canSend = () => !event.data.suppressOutput && manager.isCurrentPermissionAttachment(channelId, event.data.attachmentGeneration)
    && !isQuiet(channelId) && !manager.isUnattendedExecution(channelId);
  if (!canSend()) return;

  let content: string;
  if (event.type === 'bridge.fusion_model') {
    let models: ModelInfo[] = [];
    try { models = await manager.listModels(); }
    catch (error) { log.warn('Cannot resolve routed model display metadata:', error); }
    const model = await formatRoutedModel(event.data.model, models);
    const role = ['judge', 'critic', 'reviewer'].includes(event.data.role ?? '') ? ' for review'
      : ['repair', 'revision'].includes(event.data.role ?? '') ? ' for revision' : '';
    content = event.data.fallback ? `Fusion routing fell back to **${model}**.`
      : `Fusion is using **${model}**${role}.`;
  } else {
    content = event.data.content;
  }

  // Metadata and streamer-mode lookup can outlive the session or its foreground turn.
  if (!canSend()) return;
  await adapter.sendMessage(channelId, content, { threadRootId: getThreadRootId() });
}
