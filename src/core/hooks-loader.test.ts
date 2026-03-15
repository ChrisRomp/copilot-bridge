import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadHooks, mergeHooks, getHooksInfo } from './hooks-loader.js';

let testDir: string;
let originalHome: string | undefined;

/** Helper to write a hooks.json in the official CLI format */
function writeHooksJson(dir: string, hooks: Record<string, any[]>) {
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ version: 1, hooks }));
}

/** Helper to create an executable shell script */
function writeScript(filePath: string, body: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/bash\n${body}`);
  fs.chmodSync(filePath, 0o755);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  originalHome = process.env.HOME;
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
    writeScript(path.join(testDir, 'hooks', 'start.sh'), 'cat > /dev/null');
    writeHooksJson(testDir, {
      sessionStart: [{ type: 'command', bash: './hooks/start.sh' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeDefined();
    expect(result!.onSessionStart).toBeTypeOf('function');
  });

  it('skips workspace hooks.json by default', async () => {
    writeScript(path.join(testDir, 'hooks', 'start.sh'), 'cat > /dev/null');
    writeHooksJson(testDir, {
      sessionStart: [{ type: 'command', bash: './hooks/start.sh' }],
    });

    const result = await loadHooks(testDir);
    expect(result).toBeUndefined();
  });

  it('skips unknown hook types with warning', async () => {
    writeHooksJson(testDir, {
      bogusHook: [{ type: 'command', bash: 'echo hi' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('skips entries without bash or powershell', async () => {
    writeHooksJson(testDir, {
      preToolUse: [{ type: 'command' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('skips entries that are not arrays', async () => {
    fs.writeFileSync(path.join(testDir, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: { preToolUse: { type: 'command', bash: 'echo hi' } },
    }));

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeUndefined();
  });

  it('executes hook commands and returns output', async () => {
    writeScript(path.join(testDir, 'hooks', 'guard.sh'),
      'INPUT=$(cat)\necho \'{"additionalContext":"hook fired"}\'');
    writeHooksJson(testDir, {
      preToolUse: [{ type: 'command', bash: './hooks/guard.sh' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeDefined();

    const output = result!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{"command":"ls"}', timestamp: Date.now(), cwd: testDir },
      { sessionId: 'test' },
    );
    expect(output).toEqual({ additionalContext: 'hook fired' });
  });

  it('deny from preToolUse short-circuits remaining commands', async () => {
    writeScript(path.join(testDir, 'hooks', 'deny.sh'),
      'cat > /dev/null\necho \'{"permissionDecision":"deny","permissionDecisionReason":"blocked"}\'');
    writeScript(path.join(testDir, 'hooks', 'second.sh'),
      'cat > /dev/null\necho \'{"additionalContext":"should not appear"}\'');
    writeHooksJson(testDir, {
      preToolUse: [
        { type: 'command', bash: './hooks/deny.sh' },
        { type: 'command', bash: './hooks/second.sh' },
      ],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    const output = result!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{}', timestamp: Date.now(), cwd: testDir },
      { sessionId: 'test' },
    );
    expect(output.permissionDecision).toBe('deny');
    expect(output.additionalContext).toBeUndefined();
  });

  it('handles hook command timeout gracefully', async () => {
    writeScript(path.join(testDir, 'hooks', 'slow.sh'), 'sleep 60');
    writeHooksJson(testDir, {
      preToolUse: [{ type: 'command', bash: './hooks/slow.sh', timeoutSec: 1 }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    const output = result!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{}', timestamp: Date.now(), cwd: testDir },
      { sessionId: 'test' },
    );
    expect(output).toBeUndefined();
  });

  it('loads from .github/hooks/hooks.json when allowed', async () => {
    const hooksDir = path.join(testDir, '.github', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    writeScript(path.join(hooksDir, 'end.sh'), 'cat > /dev/null');
    writeHooksJson(hooksDir, {
      sessionEnd: [{ type: 'command', bash: './end.sh' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    expect(result).toBeDefined();
    expect(result!.onSessionEnd).toBeTypeOf('function');
  });

  it('loads from user-level ~/.copilot/hooks.json', async () => {
    const copilotDir = path.join(testDir, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });
    writeScript(path.join(copilotDir, 'hooks', 'audit.sh'), 'cat > /dev/null');
    writeHooksJson(copilotDir, {
      preToolUse: [{ type: 'command', bash: './hooks/audit.sh' }],
    });

    const result = await loadHooks(testDir);
    expect(result).toBeDefined();
    expect(result!.onPreToolUse).toBeTypeOf('function');
  });

  it('multiple sources append commands for same hook type', async () => {
    // User-level hook
    const copilotDir = path.join(testDir, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });
    writeScript(path.join(copilotDir, 'hooks', 'first.sh'),
      'cat > /dev/null\necho \'{"additionalContext":"from-user"}\'');
    writeHooksJson(copilotDir, {
      preToolUse: [{ type: 'command', bash: './hooks/first.sh' }],
    });

    // Workspace hook
    writeScript(path.join(testDir, 'hooks', 'second.sh'),
      'cat > /dev/null\necho \'{"permissionDecision":"allow"}\'');
    writeHooksJson(testDir, {
      preToolUse: [{ type: 'command', bash: './hooks/second.sh' }],
    });

    const result = await loadHooks(testDir, { allowWorkspaceHooks: true });
    const output = result!.onPreToolUse!(
      { toolName: 'bash', toolArgs: '{}', timestamp: Date.now(), cwd: testDir },
      { sessionId: 'test' },
    );
    // Both results merged
    expect(output.additionalContext).toBe('from-user');
    expect(output.permissionDecision).toBe('allow');
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
  it('returns empty array when no hooks.json files exist', () => {
    const result = getHooksInfo(testDir);
    expect(result).toEqual([]);
  });

  it('returns hook info from user hooks.json', () => {
    const copilotDir = path.join(testDir, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });
    writeHooksJson(copilotDir, {
      preToolUse: [{ type: 'command', bash: 'echo hi' }],
      sessionStart: [{ type: 'command', bash: 'echo hi' }],
    });

    const result = getHooksInfo(testDir);
    expect(result).toHaveLength(2);
    expect(result[0].hookType).toBe('preToolUse');
    expect(result[0].source).toBe('user');
    expect(result[0].commandCount).toBe(1);
    expect(result[1].hookType).toBe('sessionStart');
    expect(result[1].source).toBe('user');
  });

  it('returns workspace source for workspace hooks', () => {
    writeHooksJson(testDir, {
      postToolUse: [{ type: 'command', bash: 'echo hi' }],
    });

    const result = getHooksInfo(testDir, { allowWorkspaceHooks: true });
    expect(result).toHaveLength(1);
    expect(result[0].hookType).toBe('postToolUse');
    expect(result[0].source).toBe('workspace');
  });

  it('excludes workspace hooks when not allowed', () => {
    writeHooksJson(testDir, {
      postToolUse: [{ type: 'command', bash: 'echo hi' }],
    });

    const result = getHooksInfo(testDir, { allowWorkspaceHooks: false });
    expect(result).toEqual([]);
  });

  it('returns plugin source for plugin hooks', () => {
    const pluginDir = path.join(testDir, '.copilot', 'installed-plugins', 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    writeHooksJson(pluginDir, {
      errorOccurred: [{ type: 'command', bash: 'echo hi' }],
    });

    const result = getHooksInfo(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].hookType).toBe('errorOccurred');
    expect(result[0].source).toBe('plugin');
  });

  it('aggregates command counts across sources', () => {
    const copilotDir = path.join(testDir, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });
    writeHooksJson(copilotDir, {
      preToolUse: [
        { type: 'command', bash: 'echo one' },
        { type: 'command', bash: 'echo two' },
      ],
    });

    writeHooksJson(testDir, {
      preToolUse: [{ type: 'command', bash: 'echo three' }],
    });

    const result = getHooksInfo(testDir, { allowWorkspaceHooks: true });
    expect(result).toHaveLength(1);
    expect(result[0].commandCount).toBe(3);
  });
});
