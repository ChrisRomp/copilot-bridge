import { describe, it, expect } from 'vitest';

/**
 * Tests for resolveSessionPrefix matching logic.
 * We test the pure filtering contract without instantiating SessionManager.
 */

function resolvePrefix(sessions: string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return sessions.filter(id => id.toLowerCase().startsWith(lower));
}

const SESSIONS = [
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'a1b2c3d4-ffff-0000-1111-222233334444',
  'deadbeef-1234-5678-9abc-def012345678',
  'DEADBEEF-aaaa-bbbb-cccc-dddddddddddd',
];

describe('resolveSessionPrefix', () => {
  it('matches an exact full session ID', () => {
    const result = resolvePrefix(SESSIONS, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result).toEqual(['a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
  });

  it('matches a short 8-char prefix (/status length)', () => {
    const result = resolvePrefix(SESSIONS, 'deadbeef');
    expect(result).toEqual([
      'deadbeef-1234-5678-9abc-def012345678',
      'DEADBEEF-aaaa-bbbb-cccc-dddddddddddd',
    ]);
  });

  it('matches a 12-char prefix (/sessions length)', () => {
    const result = resolvePrefix(SESSIONS, 'a1b2c3d4-fff');
    expect(result).toEqual(['a1b2c3d4-ffff-0000-1111-222233334444']);
  });

  it('returns empty array when no sessions match', () => {
    const result = resolvePrefix(SESSIONS, 'ffffffff');
    expect(result).toEqual([]);
  });

  it('returns multiple matches for ambiguous prefix', () => {
    const result = resolvePrefix(SESSIONS, 'a1b2c3d4');
    expect(result).toEqual([
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'a1b2c3d4-ffff-0000-1111-222233334444',
    ]);
  });

  it('matches case-insensitively', () => {
    const result = resolvePrefix(SESSIONS, 'DEADBEEF-1234');
    expect(result).toEqual(['deadbeef-1234-5678-9abc-def012345678']);
  });
});
