import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkNodeVersion, checkCopilotCLI, checkGitHubAuth } from './prerequisites.js';

describe('prerequisites', () => {
  describe('checkNodeVersion', () => {
    it('passes for current Node version (20+)', () => {
      const result = checkNodeVersion();
      // Test is running on Node 20+, so this should pass
      expect(result.status).toBe('pass');
      expect(result.label).toMatch(/Node\.js v\d+/);
    });
  });

  describe('checkCopilotCLI', () => {
    it('returns a check result', () => {
      const result = checkCopilotCLI();
      // Either pass (if CLI installed) or fail — both are valid CheckResults
      expect(result.status).toMatch(/^(pass|fail)$/);
      expect(result.label).toMatch(/Copilot/i);
    });
  });

  describe('checkGitHubAuth', () => {
    it('returns a check result', () => {
      const result = checkGitHubAuth();
      expect(result.status).toMatch(/^(pass|warn)$/);
      expect(result.label).toMatch(/GitHub/i);
    });
  });
});
