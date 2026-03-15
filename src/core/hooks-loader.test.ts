import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadHooks, mergeHooks } from './hooks-loader.js';

let testDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  originalHome = process.env.HOME;
  // Isolate from real user hooks/plugins
  process.env.HOME = testDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('loadHooks', () => {
  it('returns undefined when no hooks.json files exist', async () => {
    const result = await loadHooks(testDir);
    expect(result).toBeUndefined();
  });

  it('loads hooks from workspace hooks.json when allowed', async () => {
    // Create a handler module
    const hooksDir = path.join(testDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'start.mjs'),
      'export default function(input, invocation) { return { additionalContext: "test" }; }');

    // Create hooks.json
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onSessionStart: './hooks/start.mjs',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeDefined();
    expect(result!.onSessionStart).toBeTypeOf('function');
  });

  it('skips workspace hooks.json by default', async () => {
    const hooksDir = path.join(testDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'start.mjs'),
      'export default function(input, invocation) { return { additionalContext: "test" }; }');

    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onSessionStart: './hooks/start.mjs',
      },
    }));

    const result = await loadHooks(testDir);
    expect(result).toBeUndefined();
  });

  it('skips unknown hook types with warning', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onBogusHook: './nope.js',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('skips non-string module paths', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onSessionStart: 42,
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('skips missing module files gracefully', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onSessionStart: './nonexistent.js',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('rejects absolute path traversal', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onPreToolUse: '/tmp/evil-payload.js',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('rejects relative path traversal', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onPreToolUse: '../../../../tmp/evil.js',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('loads from .github/hooks.json when allowed', async () => {
    const githubDir = path.join(testDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const hooksDir = path.join(githubDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'end.mjs'),
      'export default function(input, inv) { return null; }');

    fs.writeFileSync(path.join(githubDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onSessionEnd: './hooks/end.mjs',
      },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeDefined();
    expect(result!.onSessionEnd).toBeTypeOf('function');
  });
});

describe('mergeHooks', () => {
  it('returns undefined when both are undefined', () => {
    expect(mergeHooks(undefined, undefined)).toBeUndefined();
  });

  it('returns base when override is undefined', () => {
    const base = { onSessionStart: vi.fn() };
    expect(mergeHooks(base, undefined)).toBe(base);
  });

  it('returns override when base is undefined', () => {
    const override = { onSessionEnd: vi.fn() };
    expect(mergeHooks(undefined, override)).toBe(override);
  });

  it('override takes precedence', () => {
    const baseFn = vi.fn();
    const overrideFn = vi.fn();
    const result = mergeHooks(
      { onSessionStart: baseFn, onSessionEnd: baseFn },
      { onSessionStart: overrideFn },
    );
    expect(result!.onSessionStart).toBe(overrideFn);
    expect(result!.onSessionEnd).toBe(baseFn);
  });
});

describe('getHooksInfo', () => {
  let getHooksInfo: typeof import('./hooks-loader.js').getHooksInfo;

  beforeEach(async () => {
    const mod = await import('./hooks-loader.js');
    getHooksInfo = mod.getHooksInfo;
  });

  it('returns empty array when no hooks.json files exist', () => {
    const result = getHooksInfo(testDir);
    expect(result).toEqual([]);
  });

  it('returns hook info from user hooks.json', () => {
    const copilotDir = path.join(testDir, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });
    fs.writeFileSync(path.join(copilotDir, 'hooks.json'), JSON.stringify({
      hooks: {
        onPreToolUse: './audit.js',
        onSessionStart: './init.js',
      },
    }));
    fs.writeFileSync(path.join(copilotDir, 'audit.js'), '');
    fs.writeFileSync(path.join(copilotDir, 'init.js'), '');

    const result = getHooksInfo(testDir);
    expect(result).toHaveLength(2);
    expect(result[0].hookType).toBe('onPreToolUse');
    expect(result[0].source).toBe('user');
    expect(result[1].hookType).toBe('onSessionStart');
    expect(result[1].source).toBe('user');
  });

  it('returns workspace source for workspace hooks', () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: { onPostToolUse: './redact.js' },
    }));
    fs.writeFileSync(path.join(testDir, 'redact.js'), '');

    const result = getHooksInfo(testDir, { allowWorkspaceHooks: true });
    expect(result).toHaveLength(1);
    expect(result[0].hookType).toBe('onPostToolUse');
    expect(result[0].source).toBe('workspace');
  });

  it('excludes workspace hooks when not allowed', () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      hooks: { onPostToolUse: './redact.js' },
    }));
    fs.writeFileSync(path.join(testDir, 'redact.js'), '');

    const result = getHooksInfo(testDir, { allowWorkspaceHooks: false });
    expect(result).toEqual([]);
  });

  it('returns plugin source for plugin hooks', () => {
    const pluginDir = path.join(testDir, '.copilot', 'installed-plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({
      hooks: { onErrorOccurred: './handler.js' },
    }));
    fs.writeFileSync(path.join(pluginDir, 'handler.js'), '');

    const result = getHooksInfo(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].hookType).toBe('onErrorOccurred');
    expect(result[0].source).toBe('plugin');
  });
});
