import { describe, expect, it } from 'vitest';
import { CallbackRegistry, type CallbackEntry } from './callback-registry.js';

describe('CallbackRegistry', () => {
  const entry: CallbackEntry = {
    callbackUrl: 'https://example.com/callback',
    runId: 'run-1',
    bot: 'bob',
  };

  it('register and get returns the entry', () => {
    const registry = new CallbackRegistry();

    registry.register('channel-1', entry);

    expect(registry.get('channel-1')).toEqual(entry);
  });

  it('get returns undefined for unknown channel', () => {
    const registry = new CallbackRegistry();

    expect(registry.get('missing-channel')).toBeUndefined();
  });

  it('re-register overwrites previous entry', () => {
    const registry = new CallbackRegistry();
    const replacement: CallbackEntry = {
      callbackUrl: 'https://example.com/other-callback',
      runId: 'run-2',
      bot: 'alice',
    };

    registry.register('channel-1', entry);
    registry.register('channel-1', replacement);

    expect(registry.get('channel-1')).toEqual(replacement);
  });

  it('unregister removes the entry', () => {
    const registry = new CallbackRegistry();

    registry.register('channel-1', entry);

    expect(registry.unregister('channel-1')).toBe(true);
    expect(registry.get('channel-1')).toBeUndefined();
  });

  it('unregister returns false for unknown channel', () => {
    const registry = new CallbackRegistry();

    expect(registry.unregister('missing-channel')).toBe(false);
  });
});
