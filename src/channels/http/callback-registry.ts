export interface CallbackEntry {
  callbackUrl: string;
  runId: string;
  bot: string;
}

export class CallbackRegistry {
  private entries = new Map<string, CallbackEntry>();

  register(channelId: string, entry: CallbackEntry): void {
    this.entries.set(channelId, entry);
  }

  get(channelId: string): CallbackEntry | undefined {
    return this.entries.get(channelId);
  }

  unregister(channelId: string): boolean {
    return this.entries.delete(channelId);
  }
}
