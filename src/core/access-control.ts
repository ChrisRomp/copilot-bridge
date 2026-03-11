/**
 * User-level access control for bot interactions.
 * Determines whether a user is allowed to interact with a bot based on its access config.
 */

import type { AccessConfig } from '../types.js';

/**
 * Check whether a user is allowed to interact with a bot.
 * Returns true if the user is permitted, false if denied.
 *
 * Matching is case-insensitive and checks both userId and username against the config entries.
 * When access is undefined or mode is "open", all users are permitted.
 */
export function checkUserAccess(userId: string, username: string, access: AccessConfig | undefined): boolean {
  if (!access || access.mode === 'open') return true;
  if (!access.users || access.users.length === 0) {
    // allowlist with no users = nobody allowed; blocklist with no users = everyone allowed
    return access.mode === 'blocklist';
  }
  const normalized = access.users.map(u => u.toLowerCase());
  const matched = normalized.includes(userId.toLowerCase()) || normalized.includes(username.toLowerCase());
  return access.mode === 'allowlist' ? matched : !matched;
}
