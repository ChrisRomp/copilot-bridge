/**
 * Thread-aware reply utilities.
 *
 * Detects dynamic thread-request triggers (🧵 or "reply in thread") in message text,
 * strips them before forwarding, and resolves the thread root for a message.
 */

// Emoji/shortcode triggers — allow punctuation or string boundaries adjacent
const THREAD_TRIGGER_RE = /\s*(?:🧵|:thread:)\s*/gi;
// Phrase trigger — only at start or end to avoid mangling natural language
const THREAD_PHRASE_RE = /^\s*reply in thread\b\s*|\s*\breply in thread\s*$/gi;

/** Detect and strip dynamic thread-request triggers from message text. */
export function extractThreadRequest(text: string): { text: string; threadRequested: boolean } {
  const hasEmoji = THREAD_TRIGGER_RE.test(text);
  THREAD_TRIGGER_RE.lastIndex = 0;
  const hasPhrase = THREAD_PHRASE_RE.test(text);
  THREAD_PHRASE_RE.lastIndex = 0;

  const threadRequested = hasEmoji || hasPhrase;
  if (!threadRequested) return { text, threadRequested: false };

  // Strip emoji/shortcode triggers first, then re-check phrase on stripped text
  let stripped = text;
  if (hasEmoji) stripped = stripped.replace(THREAD_TRIGGER_RE, ' ');
  THREAD_TRIGGER_RE.lastIndex = 0;

  // Re-check phrase against stripped text (emoji removal may expose phrase at start/end)
  const hasPhraseAfterStrip = THREAD_PHRASE_RE.test(stripped);
  THREAD_PHRASE_RE.lastIndex = 0;
  if (hasPhrase || hasPhraseAfterStrip) stripped = stripped.replace(THREAD_PHRASE_RE, ' ');
  THREAD_PHRASE_RE.lastIndex = 0;

  return { text: stripped.trim(), threadRequested: true };
}

/**
 * Resolve the thread root for a message.
 * Priority: user is already in a thread > dynamic trigger > channel config threadedReplies.
 */
export function resolveThreadRoot(
  msg: { threadRootId?: string; postId: string },
  threadRequested: boolean,
  channelConfig: { threadedReplies: boolean },
): string | undefined {
  if (msg.threadRootId) return msg.threadRootId;
  if (threadRequested || channelConfig.threadedReplies) return msg.postId;
  return undefined;
}
