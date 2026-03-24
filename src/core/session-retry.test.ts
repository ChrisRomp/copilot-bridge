import { describe, it, expect } from 'vitest';
import { isSessionNotFoundError } from './session-manager.js';

describe('isSessionNotFoundError', () => {
  it('matches SDK "Session not found" messages', () => {
    expect(isSessionNotFoundError(new Error('Session not found for sessionId: abc-123'))).toBe(true);
    expect(isSessionNotFoundError(new Error('Request session.mode.set failed with message: Session not found for sessionId: abc'))).toBe(true);
  });

  it('matches snake_case variant', () => {
    expect(isSessionNotFoundError(new Error('session_not_found'))).toBe(true);
    expect(isSessionNotFoundError(new Error('Error: SESSION_NOT_FOUND'))).toBe(true);
  });

  it('matches plain string errors', () => {
    expect(isSessionNotFoundError('Session not found')).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isSessionNotFoundError(new Error('Network timeout'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Permission denied'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Model is at capacity'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Authentication failed'))).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isSessionNotFoundError(null)).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
    expect(isSessionNotFoundError({})).toBe(false);
  });
});
