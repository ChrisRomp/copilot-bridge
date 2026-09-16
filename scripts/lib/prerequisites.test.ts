import { describe, it, expect } from 'vitest';
import { checkNodeVersion, checkCopilotCLI, checkGitHubAuth } from './prerequisites.js';

describe('prerequisites', () => {
  describe('checkNodeVersion', () => {
    it('passes for the current supported Node version', () => {
      const result = checkNodeVersion();
      expect(result.status).toBe('pass');
      expect(result.label).toMatch(/Node\.js v\d+/);
    });

    it.each(['v22.12.0', 'v22.20.0', 'v24.0.0', 'v26.0.0'])('accepts %s', (version) => {
      expect(checkNodeVersion(version)).toEqual({
        status: 'pass',
        label: `Node.js ${version}`,
      });
    });

    it.each(['v18.20.0', 'v20.19.0', 'v22.0.0', 'v22.11.99'])('rejects %s', (version) => {
      expect(checkNodeVersion(version)).toEqual({
        status: 'fail',
        label: `Node.js ${version}`,
        detail: 'requires v22.12.0 or higher',
      });
    });
  });

  describe('checkCopilotCLI', () => {
    it('returns a check result', { timeout: 15_000 }, () => {
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
