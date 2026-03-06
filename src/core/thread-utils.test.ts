import { describe, it, expect } from 'vitest';
import { extractThreadRequest, resolveThreadRoot } from './thread-utils.js';

describe('extractThreadRequest', () => {
  it('returns false when no trigger present', () => {
    const result = extractThreadRequest('hello world');
    expect(result.threadRequested).toBe(false);
    expect(result.text).toBe('hello world');
  });

  it('detects 🧵 emoji and strips it', () => {
    const result = extractThreadRequest('summarize this 🧵');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('summarize this');
  });

  it('detects "reply in thread" phrase and strips it', () => {
    const result = extractThreadRequest('reply in thread what do you think?');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('what do you think?');
  });

  it('is case-insensitive for phrase', () => {
    const result = extractThreadRequest('Reply In Thread hello');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('hello');
  });

  it('handles 🧵 at the start', () => {
    const result = extractThreadRequest('🧵 check this out');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('check this out');
  });

  it('handles 🧵 alone', () => {
    const result = extractThreadRequest('🧵');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('');
  });

  it('strips emoji and phrase when both present', () => {
    const result = extractThreadRequest('🧵 reply in thread do this');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('do this');
  });

  it('detects 🧵 adjacent to punctuation', () => {
    const result = extractThreadRequest('check this🧵.');
    expect(result.threadRequested).toBe(true);
  });

  it('detects :thread: adjacent to punctuation', () => {
    const result = extractThreadRequest('hello :thread:, thanks');
    expect(result.threadRequested).toBe(true);
  });

  it('detects :thread: shortcode and strips it', () => {
    const result = extractThreadRequest('check this out :thread:');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('check this out');
  });

  it('handles :thread: at the start', () => {
    const result = extractThreadRequest(':thread: what do you think?');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('what do you think?');
  });

  it('does not trigger on "reply in thread" mid-sentence', () => {
    const result = extractThreadRequest('Can you explain how to reply in thread in Mattermost?');
    expect(result.threadRequested).toBe(false);
    expect(result.text).toBe('Can you explain how to reply in thread in Mattermost?');
  });

  it('detects "reply in thread" as suffix', () => {
    const result = extractThreadRequest('what do you think? reply in thread');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('what do you think?');
  });

  it('works correctly on consecutive calls (regex state reset)', () => {
    extractThreadRequest('🧵 first');
    const result = extractThreadRequest('🧵 second');
    expect(result.threadRequested).toBe(true);
    expect(result.text).toBe('second');
  });
});

describe('resolveThreadRoot', () => {
  const makeMsg = (postId: string, threadRootId?: string) => ({ postId, threadRootId });

  it('returns threadRootId when user is already in a thread', () => {
    const result = resolveThreadRoot(makeMsg('post1', 'root1'), false, { threadedReplies: false });
    expect(result).toBe('root1');
  });

  it('returns threadRootId even when threadedReplies is off and no trigger', () => {
    const result = resolveThreadRoot(makeMsg('post1', 'root1'), false, { threadedReplies: false });
    expect(result).toBe('root1');
  });

  it('returns postId when thread requested via trigger', () => {
    const result = resolveThreadRoot(makeMsg('post1'), true, { threadedReplies: false });
    expect(result).toBe('post1');
  });

  it('returns postId when threadedReplies is true', () => {
    const result = resolveThreadRoot(makeMsg('post1'), false, { threadedReplies: true });
    expect(result).toBe('post1');
  });

  it('returns undefined when no thread context at all', () => {
    const result = resolveThreadRoot(makeMsg('post1'), false, { threadedReplies: false });
    expect(result).toBeUndefined();
  });

  it('prefers existing threadRootId over trigger', () => {
    // User is in a thread AND sent 🧵 — use the existing thread root
    const result = resolveThreadRoot(makeMsg('post1', 'root1'), true, { threadedReplies: false });
    expect(result).toBe('root1');
  });
});
