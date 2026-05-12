import { createLogger } from '../../logger.js';
import type { CallbackRegistry } from './callback-registry.js';

const log = createLogger('callback-delivery');

export class CallbackDelivery {
  private pending = new Map<string, string[]>();

  constructor(private readonly registry: CallbackRegistry) {}

  async handleEvent(channelId: string, event: { type: string; data?: any }): Promise<boolean> {
    const entry = this.registry.get(channelId);
    if (!entry) {
      return false;
    }

    if (event.type === 'assistant.message') {
      const content = extractContent(event.data);
      if (content) {
        const messages = this.pending.get(channelId) ?? [];
        messages.push(content);
        this.pending.set(channelId, messages);
      }
      return true;
    }

    if (event.type === 'assistant.message_delta') {
      return true;
    }

    if (event.type === 'session.idle') {
      const content = (this.pending.get(channelId) ?? []).join('\n\n');
      this.pending.delete(channelId);
      if (content) {
        await this.postCallback(entry.callbackUrl, {
          run_id: entry.runId,
          content,
          session_id: channelId,
          status: 'completed',
        }, entry.callbackToken);
      }
      this.registry.unregister(channelId);
      return true;
    }

    if (event.type === 'session.error') {
      this.pending.delete(channelId);
      const errorMsg = event.data?.message ?? event.data?.error ?? 'Agent session error';
      await this.postCallback(entry.callbackUrl, {
        run_id: entry.runId,
        content: '',
        session_id: channelId,
        status: 'failed',
        error: String(errorMsg),
      }, entry.callbackToken);
      this.registry.unregister(channelId);
      return true;
    }

    return true;
  }

  private async postCallback(url: string, body: Record<string, unknown>, callbackToken?: string): Promise<void> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (callbackToken) {
        headers.authorization = `Bearer ${callbackToken}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        log.error('Callback POST failed', {
          url,
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (err) {
      log.error('Callback POST threw', err);
    }
  }
}

export function extractContent(data: any): string | null {
  if (!data) {
    return null;
  }

  if (typeof data.content === 'string') {
    return data.content || null;
  }

  if (Array.isArray(data.content)) {
    const joined = data.content
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('');
    return joined || null;
  }

  if (typeof data.text === 'string') {
    return data.text || null;
  }

  return null;
}
