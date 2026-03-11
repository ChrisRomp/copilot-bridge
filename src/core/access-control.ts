/**
 * User-level access control for bot interactions.
 * Determines whether a user is allowed to interact with a bot based on access config.
 *
 * Two levels are supported:
 *   1. Platform-level — inherited by all bots on a platform
 *   2. Bot-level — can grant additional users beyond platform
 *
 * Access is additive (union): a user is allowed if they pass EITHER level's allowlist.
 * Platform blocklist always wins — blocked users are denied regardless of bot config.
 *
 * SECURITY: When neither level is configured, access defaults to DENY.
 * Use mode: "open" to explicitly allow all users at a given level.
 */

import type { AccessConfig } from '../types.js';

/** Evaluate a single AccessConfig against a userId/username pair. */
function evaluateAccess(userId: string, username: string, access: AccessConfig): boolean {
  if (access.mode === 'open') return true;
  if (!access.users || access.users.length === 0) {
    return access.mode === 'blocklist';
  }
  const normalized = access.users.map(u => u.toLowerCase());
  const matched = normalized.includes(userId.toLowerCase()) || normalized.includes(username.toLowerCase());
  return access.mode === 'allowlist' ? matched : !matched;
}

/**
 * Check whether a user is allowed to interact with a bot.
 * Returns true if the user is permitted, false if denied.
 *
 * Matching is case-insensitive and checks both userId and username against the config entries.
 *
 * Resolution logic:
 *   - Neither configured → deny (secure by default)
 *   - Blocklist at either level → blocked users always denied
 *   - Allowlist is additive: user passes if listed at platform OR bot level
 *   - Only one level configured → that level decides alone
 *
 * @param botAccess - Bot-level access config (can grant additional users)
 * @param platformAccess - Platform-level access config (inherited by all bots)
 */
export function checkUserAccess(
  userId: string,
  username: string,
  botAccess: AccessConfig | undefined,
  platformAccess?: AccessConfig,
): boolean {
  const hasPlatform = !!platformAccess;
  const hasBot = !!botAccess;

  // Neither configured → deny (secure by default)
  if (!hasPlatform && !hasBot) return false;

  // Blocklists always deny — check both levels
  if (hasPlatform && platformAccess.mode === 'blocklist' && !evaluateAccess(userId, username, platformAccess)) return false;
  if (hasBot && botAccess.mode === 'blocklist' && !evaluateAccess(userId, username, botAccess)) return false;

  // Allowlists are additive — pass if either level allows
  if (hasPlatform && evaluateAccess(userId, username, platformAccess)) return true;
  if (hasBot && evaluateAccess(userId, username, botAccess)) return true;

  return false;
}
