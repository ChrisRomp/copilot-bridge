import { describe, expect, it } from 'vitest';
import type { StoredPermissionRule } from '../state/types.js';
import { buildRuntimePermissionPolicy, type RuntimePermissionPolicyInput } from './permission-policy.js';

const stored = (
  tool: string, commandPattern: string, action: 'allow' | 'deny', id = 1, scope = 'channel',
): StoredPermissionRule => ({ id, scope, tool, commandPattern, action, createdAt: '2026-11-10' });
function project(overrides: Partial<RuntimePermissionPolicyInput> = {}) {
  return buildRuntimePermissionPolicy({
    config: undefined, storedRules: [], workingDirectory: '/workspace',
    allowPaths: [], isAdmin: false, ...overrides,
  });
}
const shell = (argument: string | null) => ({ kind: 'shell', argument });
const hasWarning = (result: ReturnType<typeof project>, text: string) =>
  expect(result.warnings.some(warning => warning.includes(text))).toBe(true);

describe('runtime permission policy boundaries', () => {
  it('declares owner-tool host policy without inventing a baseline or escalating permissions', () => {
    const result = project();
    expect(result.config).toEqual({
      rules: { approved: [], denied: [] }, hostPolicyPermissionHandler: true,
    });
    hasWarning(result, 'Hardcoded shell safety predicates');
    hasWarning(result, 'path-scoped write grant');
  });

  it('leaves path and URL managers untouched rather than broadening their scopes', () => {
    const result = project({
      config: { allowPaths: ['/shared'], allowUrls: ['github.com'] },
      workingDirectory: '/workspace', allowPaths: ['/extra'], isAdmin: true,
    });
    expect(result.config.paths).toBeUndefined();
    expect(result.config.urls).toBeUndefined();
    expect(result.config.rules?.approved).toEqual([]);
    hasWarning(result, 'allowUrls');
    hasWarning(result, 'Admin-only');
  });

  it('does not export hardcoded display specs as approximate executable denies', () => {
    expect(project().config.rules?.denied).toEqual([]);
  });

  it('is pure and deterministic, and preserves caller-provided rule ordering', () => {
    const rules = Object.freeze([
      Object.freeze(stored('shell', 'echo', 'deny', 1, 'global')),
      Object.freeze(stored('shell', 'echo', 'allow', 99, 'channel')),
    ]);
    const input = { storedRules: rules };
    const result = project(input);
    expect(project(input)).toEqual(result);
    expect(result.config.rules).toEqual({ approved: [], denied: [shell('echo')] });
  });
});

describe('config native mapping', () => {
  it('uses lowercase native kinds and null for bare-kind rules', () => {
    expect(project({ config: { allow: ['shell', 'read', 'write'], deny: ['shell(echo)'] } }).config.rules).toEqual({
      approved: [shell(null), { kind: 'read', argument: null }, { kind: 'write', argument: null }],
      denied: [shell('echo')],
    });
  });

  it('uses :* only for validated multiword config prefixes', () => {
    const result = project({ config: { allow: ['shell(git status)', 'shell(echo)'], deny: ['shell(git push)'] } });
    expect(result.config.rules).toEqual({
      approved: [shell('git status:*'), shell('echo')],
      denied: [shell('git push:*')],
    });
    hasWarning(result, 'native parsed command segments');
  });

  it.each(['shell(echo *)', 'shell(git:*)', 'shell(echo; touch x)', 'shell(/bin/echo)', 'shell(echo "x")'])(
    'does not reinterpret config syntax %s as a broader native approval', spec => {
      const result = project({ config: { allow: [spec] } });
      expect(result.config.rules?.approved).toEqual([]);
      hasWarning(result, 'was not projected');
    },
  );

  it('withholds approvals that could bypass an unsupported config deny', () => {
    const result = project({
      config: { deny: ['shell(echo *)'], allow: ['shell', 'read'] },
      storedRules: [stored('shell', 'echo', 'allow'), stored('mcp:workiq', '*', 'allow')],
    });
    expect(result.config.rules?.approved).toEqual([
      { kind: 'read', argument: null }, { kind: 'workiq', argument: null },
    ]);
    hasWarning(result, 'overlapping config deny');
  });

  it('withholds all approvals when malformed deny syntax has unknown scope', () => {
    expect(project({
      config: { deny: ['shell('], allow: ['read'] },
      storedRules: [stored('mcp:workiq', '*', 'allow')],
    }).config.rules?.approved).toEqual([]);
  });

  it('does not turn unsupported url(host) or read(path) into broader grants', () => {
    const result = project({ config: { allow: ['url(github.com)', 'read(/workspace)', 'memory'] } });
    expect(result.config.rules?.approved).toEqual([]);
  });

  it('maps server and exact MCP tool config rules without inventing a namespace', () => {
    expect(project({ config: { allow: ['workiq', 'github(get_issue)'], deny: ['workiq(delete_event)'] } }).config.rules).toEqual({
      approved: [{ kind: 'workiq', argument: null }, { kind: 'github', argument: 'get_issue' }],
      denied: [{ kind: 'workiq', argument: 'delete_event' }],
    });
  });

  it.each(['Shell(echo)', 'MCP', 'custom-tool', 'server(*)', 'mcp:server'])(
    'rejects ambiguous or reserved config mapping %s', spec => {
      expect(project({ config: { allow: [spec] } }).config.rules?.approved).toEqual([]);
    },
  );

  it('deduplicates equivalent emitted rules', () => {
    expect(project({
      config: { allow: ['shell(echo)', 'shell( echo )'] },
      storedRules: [stored('shell', 'echo', 'allow')],
    }).config.rules?.approved).toEqual([shell('echo')]);
  });
});

describe('remembered shell rules', () => {
  it('maps exact command tokens, not command strings or arbitrary globs', () => {
    const result = project({
      storedRules: [
        stored('shell', 'echo', 'allow'), stored('shell', 'touch', 'deny'),
        stored('shell', 'git status', 'allow'), stored('shell', 'git:*', 'allow'),
        stored('shell', '/bin/echo', 'allow'), stored('shell', '', 'allow'),
      ],
    });
    expect(result.config.rules).toEqual({ approved: [shell('echo')], denied: [shell('touch')] });
    hasWarning(result, 'exact bridge tokens');
  });

  it.each(['bash', 'sh', 'zsh', 'dash', 'fish', 'env', 'sudo', 'nohup', 'xargs', 'exec', 'eval'])(
    'does not broaden remembered wrapper allow for %s', wrapper => {
      const result = project({ storedRules: [stored('shell', wrapper, 'allow')] });
      expect(result.config.rules?.approved).toEqual([]);
      hasWarning(result, 'wrapper');
    },
  );

  it('allows wrapper denials but not blanket stored shell approval', () => {
    const result = project({ storedRules: [stored('shell', 'bash', 'deny'), stored('shell', '*', 'allow')] });
    expect(result.config.rules).toEqual({ approved: [], denied: [shell('bash')] });
    hasWarning(result, 'wildcard');
  });

  it('does not export a homogeneous blanket shell allow', () => {
    const result = project({ storedRules: [stored('shell', '*', 'allow')] });
    expect(result.config.rules?.approved).toEqual([]);
    hasWarning(result, 'also approve wrappers');
  });

  it('uses null rather than star for a homogeneous stored blanket deny', () => {
    expect(project({ storedRules: [stored('shell', '*', 'deny')] }).config.rules?.denied).toEqual([shell(null)]);
  });

  it('honors earlier wildcard ordering rather than resurrecting shadowed exact grants', () => {
    expect(project({
      storedRules: [stored('shell', '*', 'deny'), stored('shell', 'echo', 'allow')],
    }).config.rules).toEqual({ approved: [], denied: [shell(null)] });
  });

  it('withholds blanket deny when an earlier exact grant is an exception', () => {
    const result = project({
      storedRules: [stored('shell', 'echo', 'allow'), stored('shell', '*', 'deny')],
    });
    expect(result.config.rules).toEqual({ approved: [shell('echo')], denied: [] });
    hasWarning(result, 'ordered exact-rule exceptions');
  });

  it('does not revive a lower-priority exact deny beneath an earlier wildcard allow', () => {
    expect(project({
      storedRules: [stored('shell', '*', 'allow'), stored('shell', 'echo', 'deny')],
    }).config.rules).toEqual({ approved: [shell('echo')], denied: [] });
  });

  it('does not invert config-allow-before-stored-deny precedence', () => {
    const result = project({
      config: { allow: ['shell(git status)'] },
      storedRules: [stored('shell', 'git', 'deny'), stored('shell', 'touch', 'deny')],
    });

    expect(result.config.rules).toEqual({
      approved: [shell('git status:*')], denied: [shell('touch')],
    });
    hasWarning(result, 'config approval has priority');
  });

  it('does not export a blanket stored deny over an untranslatable earlier allow', () => {
    const result = project({
      config: { allow: ['shell(/usr/bin/printf)'] },
      storedRules: [stored('shell', '*', 'deny')],
    });
    expect(result.config.rules).toEqual({ approved: [], denied: [] });
    hasWarning(result, 'config approval has priority');
  });

  it('withholds stored denies overlapping admin grants without granting anything new', () => {
    const result = project({
      isAdmin: true,
      storedRules: [stored('shell', 'touch', 'deny'), stored('shell', 'echo', 'deny')],
    });
    expect(result.config.rules).toEqual({ approved: [], denied: [shell('echo')] });
    expect(project({ isAdmin: true, storedRules: [stored('shell', '*', 'deny')] }).config.rules?.denied).toEqual([]);
    hasWarning(result, 'earlier admin grant');
  });

  it('keeps projected config denies authoritative over stored approvals', () => {
    expect(project({
      config: { deny: ['shell(touch)'] }, storedRules: [stored('shell', 'touch', 'allow')],
    }).config.rules).toEqual({ approved: [shell('touch')], denied: [shell('touch')] });
  });

  it('never treats a stored bash tool name as shell permissions', () => {
    expect(project({ storedRules: [stored('bash', 'echo', 'allow')] }).config.rules?.approved).toEqual([]);
  });
});

describe('remembered MCP and file rules', () => {
  it('projects only the effective server-wide wildcard, not stored per-tool entries', () => {
    const result = project({ storedRules: [
      stored('mcp:workiq', 'alpha', 'allow'),
      stored('mcp:workiq', '*', 'deny'),
      stored('mcp:workiq', '*', 'allow'),
      stored('mcp:other', '*', 'allow'),
    ] });
    expect(result.config.rules).toEqual({
      approved: [{ kind: 'other', argument: null }], denied: [{ kind: 'workiq', argument: null }],
    });
    hasWarning(result, 'only queries "*"');
  });

  it.each(['shell', 'read', 'write', 'Shell', 'mcp', 'custom-tool', 'hook', 'workflow', 'extension-env-access', '*', ''])(
    'does not broaden an MCP grant through native kind collision or syntax: %s', server => {
      const result = project({ storedRules: [stored(`mcp:${server}`, '*', 'allow')] });
      expect(result.config.rules?.approved).toEqual([]);
      hasWarning(result, 'server name');
    },
  );

  it('does not turn remembered MCP tools into exact native tool grants', () => {
    expect(project({ storedRules: [stored('mcp:workiq', 'alpha', 'allow')] }).config.rules?.approved).toEqual([]);
  });

  it('withholds server-wide stored deny overridden in part by config', () => {
    const result = project({
      config: { allow: ['workiq(alpha)'] }, storedRules: [stored('mcp:workiq', '*', 'deny')],
    });
    expect(result.config.rules).toEqual({
      approved: [{ kind: 'workiq', argument: 'alpha' }], denied: [],
    });
    hasWarning(result, 'config approval has priority');
  });

  it('withholds MCP approval behind an unsupported all-MCP config deny', () => {
    expect(project({
      config: { deny: ['mcp'] }, storedRules: [stored('mcp:workiq', '*', 'allow')],
    }).config.rules?.approved).toEqual([]);
  });

  it('allows homogeneous remembered file-kind grants, but not exact paths', () => {
    const result = project({ storedRules: [
      stored('read', '*', 'allow'), stored('write', '*', 'allow'),
    ] });
    expect(result.config.rules?.approved).toEqual([
      { kind: 'read', argument: null }, { kind: 'write', argument: null },
    ]);
    expect(project({ storedRules: [stored('read', '/file', 'allow')] }).config.rules?.approved).toEqual([]);
  });

  it('does not broaden read wildcard approval past earlier exact-path denial', () => {
    const result = project({
      storedRules: [stored('read', '/private/file', 'deny'), stored('read', '*', 'allow')],
    });
    expect(result.config.rules).toEqual({ approved: [], denied: [] });
    hasWarning(result, 'ordered exact-rule exceptions');
  });

  it('does not let stored file denials override earlier workspace autoapproval', () => {
    const result = project({
      storedRules: [stored('read', '*', 'deny'), stored('write', '*', 'deny')],
    });
    expect(result.config.rules).toEqual({ approved: [], denied: [] });
    hasWarning(result, 'workspace/allowPaths approval');
  });
});
