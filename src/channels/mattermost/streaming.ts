import { createLogger } from '../../logger.js';
import type { ChannelAdapter } from '../../types.js';

const log = createLogger('streaming');

export class StreamingHandler {
  private adapter: ChannelAdapter;
  private activeStreams = new Map<string, {
    channelId: string;
    messageId: string;
    content: string;
    pendingUpdate: string | null;
    updateTimer: ReturnType<typeof setTimeout> | null;
    threadRootId?: string;
  }>();

  private throttleMs: number;

  constructor(adapter: ChannelAdapter, throttleMs = 500) {
    this.adapter = adapter;
    this.throttleMs = throttleMs;
  }

  /** Start a new streaming response. Posts initial placeholder and returns stream key. */
  async startStream(channelId: string, threadRootId?: string): Promise<string> {
    const messageId = await (threadRootId
      ? this.adapter.replyInThread(channelId, threadRootId, '⏳ Working...')
      : this.adapter.sendMessage(channelId, '⏳ Working...'));

    const key = `${channelId}:${messageId}`;
    this.activeStreams.set(key, {
      channelId,
      messageId,
      content: '',
      pendingUpdate: null,
      updateTimer: null,
      threadRootId,
    });
    return key;
  }

  /** Append delta content to a stream. Updates are throttled. */
  appendDelta(streamKey: string, delta: string): void {
    const stream = this.activeStreams.get(streamKey);
    if (!stream || !delta) {
      if (!stream) log.warn(`appendDelta: stream not found for key ${streamKey}`);
      return;
    }

    stream.content += delta;
    stream.pendingUpdate = stream.content;

    if (!stream.updateTimer) {
      log.debug(`Scheduled flush for ${streamKey.split(':')[1]?.slice(0, 8)}... (${stream.content.length} chars)`);
      stream.updateTimer = setTimeout(() => {
        this.flushUpdate(streamKey);
      }, this.throttleMs);
    }
  }

  /** Replace the entire stream content (for non-delta updates). */
  replaceContent(streamKey: string, content: string): void {
    const stream = this.activeStreams.get(streamKey);
    if (!stream) return;

    stream.content = content;
    stream.pendingUpdate = content;

    if (!stream.updateTimer) {
      stream.updateTimer = setTimeout(() => {
        this.flushUpdate(streamKey);
      }, this.throttleMs);
    }
  }

  /** Finalize the stream with the complete content. */
  async finalizeStream(streamKey: string, finalContent?: string): Promise<void> {
    const stream = this.activeStreams.get(streamKey);
    if (!stream) {
      log.warn(`finalizeStream: stream not found for key ${streamKey}`);
      return;
    }

    // Remove from map FIRST to prevent flushUpdate from racing
    this.activeStreams.delete(streamKey);

    if (stream.updateTimer) {
      clearTimeout(stream.updateTimer);
      stream.updateTimer = null;
    }

    const content = finalContent ?? stream.content;
    log.info(`Finalizing ${stream.messageId.slice(0, 8)}...: ${content.length} chars`);
    if (content) {
      try {
        await this.adapter.updateMessage(stream.channelId, stream.messageId, content);
      } catch (err) {
        log.error(`Failed to finalize message:`, err);
      }
    }
  }

  /** Cancel and clean up a stream. */
  async cancelStream(streamKey: string, errorMessage?: string): Promise<void> {
    const stream = this.activeStreams.get(streamKey);
    if (!stream) return;

    // Remove from map FIRST to prevent flushUpdate from racing
    this.activeStreams.delete(streamKey);

    if (stream.updateTimer) {
      clearTimeout(stream.updateTimer);
    }

    if (errorMessage) {
      try {
        await this.adapter.updateMessage(stream.channelId, stream.messageId, `❌ ${errorMessage}`);
      } catch { /* best-effort */ }
    }
  }

  /** Get the message ID for a stream (useful for threading). */
  getStreamMessageId(streamKey: string): string | undefined {
    return this.activeStreams.get(streamKey)?.messageId;
  }

  private async flushUpdate(streamKey: string): Promise<void> {
    const stream = this.activeStreams.get(streamKey);
    if (!stream || !stream.pendingUpdate) return;

    const content = stream.pendingUpdate;
    stream.pendingUpdate = null;
    stream.updateTimer = null;

    try {
      log.debug(`Flushing ${content.length} chars to ${stream.messageId.slice(0, 8)}...`);
      await this.adapter.updateMessage(stream.channelId, stream.messageId, content);
    } catch (err) {
      log.error(`Failed to update message ${stream.messageId}:`, err);
    }
  }

  /** Clean up all active streams. */
  async cleanup(): Promise<void> {
    for (const [, stream] of Array.from(this.activeStreams)) {
      if (stream.updateTimer) clearTimeout(stream.updateTimer);
    }
    this.activeStreams.clear();
  }
}
