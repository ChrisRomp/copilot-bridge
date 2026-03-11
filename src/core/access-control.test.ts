import { describe, it, expect } from 'vitest';
import { checkUserAccess } from './access-control.js';
import type { AccessConfig } from '../types.js';

describe('checkUserAccess', () => {
  // --- Open mode ---
  it('allows all users when access is undefined', () => {
    expect(checkUserAccess('U123', 'alice', undefined)).toBe(true);
  });

  it('allows all users in open mode', () => {
    const access: AccessConfig = { mode: 'open' };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
  });

  // --- Allowlist ---
  it('allows listed user by username', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['alice', 'bob'] };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
  });

  it('allows listed user by userId', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['U123'] };
    expect(checkUserAccess('U123', 'unknown', access)).toBe(true);
  });

  it('denies unlisted user in allowlist mode', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U999', 'eve', access)).toBe(false);
  });

  it('is case-insensitive for allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['Alice'] };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
    expect(checkUserAccess('U123', 'ALICE', access)).toBe(true);
  });

  it('denies all users when allowlist has no users', () => {
    const access: AccessConfig = { mode: 'allowlist', users: [] };
    expect(checkUserAccess('U123', 'alice', access)).toBe(false);
  });

  it('denies all users when allowlist users is undefined', () => {
    const access: AccessConfig = { mode: 'allowlist' };
    expect(checkUserAccess('U123', 'alice', access)).toBe(false);
  });

  // --- Blocklist ---
  it('blocks listed user in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['spambot'] };
    expect(checkUserAccess('U999', 'spambot', access)).toBe(false);
  });

  it('allows unlisted user in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['spambot'] };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
  });

  it('blocks by userId in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['U999'] };
    expect(checkUserAccess('U999', 'unknown', access)).toBe(false);
  });

  it('is case-insensitive for blocklist', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['SpamBot'] };
    expect(checkUserAccess('U999', 'spambot', access)).toBe(false);
  });

  it('allows all users when blocklist has no users', () => {
    const access: AccessConfig = { mode: 'blocklist', users: [] };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
  });

  it('allows all users when blocklist users is undefined', () => {
    const access: AccessConfig = { mode: 'blocklist' };
    expect(checkUserAccess('U123', 'alice', access)).toBe(true);
  });

  // --- Edge cases ---
  it('matches Slack UID in allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['U12345ABC'] };
    // Slack: userId=U12345ABC, username=U12345ABC (same)
    expect(checkUserAccess('U12345ABC', 'U12345ABC', access)).toBe(true);
  });

  it('matches Mattermost username in allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['chris'] };
    // Mattermost: userId=abc123, username=chris
    expect(checkUserAccess('abc123', 'chris', access)).toBe(true);
  });

  it('does not match partial username', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['chris'] };
    expect(checkUserAccess('U123', 'christopher', access)).toBe(false);
  });
});
