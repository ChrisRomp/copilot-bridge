import { FusionSelectionError } from './fusion.js';

export class PermissionSynchronizationError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`Could not synchronize permissions for session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'PermissionSynchronizationError';
  }
}

/** Detect native missing-session errors without treating policy failures as lost history. */
export function isSessionNotFoundError(error: unknown): boolean {
  if (error instanceof PermissionSynchronizationError || error instanceof FusionSelectionError) return false;
  const message = String(error && typeof error === 'object' && 'message' in error ? error.message : error).toLowerCase();
  return message.includes('session not found') || message.includes('session_not_found');
}
