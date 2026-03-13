import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  canCall, createContext, extendContext,
  buildWorkspacePrompt, buildCallerPrompt,
  discoverAgentDefinitions, discoverAgentNames, resolveAgentDefinition,
  type InterAgentContext, type BotWorkspaceEntry,
} from './inter-agent.js';
import type { InterAgentConfig } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// --- canCall tests ---

describe('canCall', () => {
  const baseConfig: InterAgentConfig = {
    enabled: true,
    maxDepth: 3,
    allow: {
      max: { canCall: ['alice'], canBeCalledBy: ['alice'] },
      alice: { canCall: ['max'], canBeCalledBy: ['max'] },
      summarizer: { canCall: [], canBeCalledBy: ['*'] },
      orchestrator: { canCall: ['*'], canBeCalledBy: [] },
    },
  };

  it('allows a permitted call', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'alice', ctx, baseConfig)).toBeNull();
  });

  it('blocks when inter-agent is disabled', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'alice', ctx, { enabled: false })).toBe('Inter-agent communication is disabled');
  });

  it('blocks when caller is not in target canBeCalledBy', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'summarizer', ctx, {
      enabled: true,
      allow: {
        max: { canCall: ['summarizer'], canBeCalledBy: [] },
        summarizer: { canCall: [], canBeCalledBy: ['alice'] }, // max not listed
      },
    })).toContain('does not allow calls from max');
  });

  it('blocks when caller has no canCall for target', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'bob', ctx, baseConfig)).toContain('not allowed to call bob');
  });

  it('blocks when target not in allowlist at all', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'unknown', ctx, baseConfig)).toContain('not allowed to call unknown');
  });

  it('supports wildcard in canBeCalledBy', () => {
    const ctx = createContext('max', 'ch-1');
    // max needs canCall for summarizer
    const config: InterAgentConfig = {
      enabled: true,
      allow: {
        max: { canCall: ['summarizer'], canBeCalledBy: [] },
        summarizer: { canCall: [], canBeCalledBy: ['*'] },
      },
    };
    expect(canCall('max', 'summarizer', ctx, config)).toBeNull();
  });

  it('supports wildcard in canCall', () => {
    const ctx = createContext('orchestrator', 'ch-1');
    const config: InterAgentConfig = {
      enabled: true,
      allow: {
        orchestrator: { canCall: ['*'], canBeCalledBy: [] },
        alice: { canCall: [], canBeCalledBy: ['*'] },
      },
    };
    expect(canCall('orchestrator', 'alice', ctx, config)).toBeNull();
  });

  it('blocks when no allowlist is configured', () => {
    const ctx = createContext('max', 'ch-1');
    expect(canCall('max', 'alice', ctx, { enabled: true })).toBe('No inter-agent allowlist configured');
  });

  // --- Loop prevention ---

  it('detects cycle via visited set (A→B→A)', () => {
    const ctx = createContext('max', 'ch-1');
    const extended = extendContext(ctx, 'alice');
    // Now alice tries to call max — max is in visited
    expect(canCall('alice', 'max', extended, baseConfig)).toContain('Cycle detected');
    expect(canCall('alice', 'max', extended, baseConfig)).toContain('max');
  });

  it('blocks at depth limit', () => {
    const config: InterAgentConfig = {
      enabled: true,
      maxDepth: 2,
      allow: {
        a: { canCall: ['*'], canBeCalledBy: ['*'] },
        b: { canCall: ['*'], canBeCalledBy: ['*'] },
        c: { canCall: ['*'], canBeCalledBy: ['*'] },
      },
    };
    let ctx = createContext('a', 'ch-1');
    // depth 0, extend to b → depth 1
    ctx = extendContext(ctx, 'b');
    // depth 1, extend to c → depth 2 (at limit)
    ctx = extendContext(ctx, 'c');
    // c tries to call d — depth 2 == maxDepth → blocked
    expect(canCall('c', 'a', ctx, config)).toContain('depth limit reached');
  });

  it('allows calls within depth limit', () => {
    const config: InterAgentConfig = {
      enabled: true,
      maxDepth: 3,
      allow: {
        a: { canCall: ['*'], canBeCalledBy: ['*'] },
        b: { canCall: ['*'], canBeCalledBy: ['*'] },
        c: { canCall: ['*'], canBeCalledBy: ['*'] },
      },
    };
    let ctx = createContext('a', 'ch-1');
    ctx = extendContext(ctx, 'b');
    // depth 1, b tries to call c — should be allowed (depth 1 < maxDepth 3)
    // But c is NOT in visited (only a and b are)
    expect(canCall('b', 'c', ctx, config)).toBeNull();
  });

  it('uses default maxDepth of 3', () => {
    const config: InterAgentConfig = {
      enabled: true,
      allow: {
        a: { canCall: ['*'], canBeCalledBy: ['*'] },
        b: { canCall: ['*'], canBeCalledBy: ['*'] },
        c: { canCall: ['*'], canBeCalledBy: ['*'] },
        d: { canCall: ['*'], canBeCalledBy: ['*'] },
      },
    };
    let ctx = createContext('a', 'ch-1');
    ctx = extendContext(ctx, 'b');
    ctx = extendContext(ctx, 'c');
    ctx = extendContext(ctx, 'd');
    // depth 3 == default maxDepth 3 → blocked
    expect(canCall('d', 'a', ctx, config)).toContain('depth limit reached');
  });
});

// --- Context tests ---

describe('createContext / extendContext', () => {
  it('creates initial context with correct values', () => {
    const ctx = createContext('max', 'ch-abc');
    expect(ctx.callerBot).toBe('max');
    expect(ctx.callerChannel).toBe('ch-abc');
    expect(ctx.depth).toBe(0);
    expect(ctx.visited).toEqual(['max']);
    expect(ctx.chainId).toBeTruthy();
  });

  it('extends context with next bot', () => {
    const ctx = createContext('max', 'ch-abc');
    const ext = extendContext(ctx, 'alice');
    expect(ext.chainId).toBe(ctx.chainId); // same chain
    expect(ext.visited).toEqual(['max', 'alice']);
    expect(ext.depth).toBe(1);
    expect(ext.callerBot).toBe('max'); // caller is last in previous visited
    expect(ext.callerChannel).toBe('ch-abc');
  });

  it('extends multiple hops', () => {
    let ctx = createContext('a', 'ch');
    ctx = extendContext(ctx, 'b');
    ctx = extendContext(ctx, 'c');
    expect(ctx.visited).toEqual(['a', 'b', 'c']);
    expect(ctx.depth).toBe(2);
    expect(ctx.callerBot).toBe('b'); // last hop's caller
  });

  it('does not mutate original context', () => {
    const ctx = createContext('max', 'ch');
    const ext = extendContext(ctx, 'alice');
    expect(ctx.visited).toEqual(['max']);
    expect(ctx.depth).toBe(0);
    expect(ext.visited).toEqual(['max', 'alice']);
  });
});

// --- Workspace prompt tests ---

describe('buildWorkspacePrompt', () => {
  it('returns empty string for no workspaces', () => {
    expect(buildWorkspacePrompt([])).toBe('');
  });

  it('builds prompt with workspace entries', () => {
    const entries: BotWorkspaceEntry[] = [
      { channelName: 'playa-plan', channelId: 'ch-1', workingDirectory: '/home/user/dev/playa-plan' },
      { channelName: 'widget-api', channelId: 'ch-2', workingDirectory: '/home/user/dev/widget-api' },
    ];
    const prompt = buildWorkspacePrompt(entries);
    expect(prompt).toContain('project workspaces');
    expect(prompt).toContain('playa-plan: /home/user/dev/playa-plan');
    expect(prompt).toContain('widget-api: /home/user/dev/widget-api');
  });
});

describe('buildCallerPrompt', () => {
  it('includes caller info', () => {
    const ctx = createContext('max', 'ch-dev');
    const prompt = buildCallerPrompt(ctx);
    expect(prompt).toContain('agent "max"');
    expect(prompt).toContain('inter-agent query');
    expect(prompt).toContain('ch-dev');
  });

  it('includes chain info for deep calls', () => {
    let ctx = createContext('max', 'ch-dev');
    ctx = extendContext(ctx, 'alice');
    const prompt = buildCallerPrompt(ctx);
    expect(prompt).toContain('max → alice');
    expect(prompt).toContain('depth: 1');
  });
});

// --- Agent discovery tests ---

describe('discoverAgentDefinitions', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir; // isolate from real user profile/plugins
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when agents/ directory does not exist', () => {
    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.size).toBe(0);
  });

  it('discovers *.agent.md files', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'network.agent.md'), '# Network Agent\nHandles network queries.');
    fs.writeFileSync(path.join(agentsDir, 'hvac.agent.md'), '# HVAC Agent\nHandles HVAC queries.');
    fs.writeFileSync(path.join(agentsDir, 'readme.md'), 'Not an agent file');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.size).toBe(2);
    expect(defs.has('network')).toBe(true);
    expect(defs.has('hvac')).toBe(true);
    expect(defs.get('network')!.content).toContain('Network Agent');
    expect(defs.get('hvac')!.content).toContain('HVAC Agent');
  });

  it('ignores directories in agents/', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.mkdirSync(path.join(agentsDir, 'subdir.agent.md'));

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.size).toBe(0);
  });

  it('discovers agents from plugins', () => {
    const pluginDir = path.join(tmpDir, '.copilot', 'installed-plugins', '_direct', 'test-plugin', 'agents');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'pluggy.agent.md'), '# Pluggy\nA plugin agent.');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.has('pluggy')).toBe(true);
    expect(defs.get('pluggy')!.content).toContain('plugin agent');
  });

  it('discovers agents from user profile', () => {
    const userAgents = path.join(tmpDir, '.copilot', 'agents');
    fs.mkdirSync(userAgents, { recursive: true });
    fs.writeFileSync(path.join(userAgents, 'custom.agent.md'), '# Custom\nUser custom agent.');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.has('custom')).toBe(true);
  });

  it('workspace agents override plugin agents of same name', () => {
    const pluginDir = path.join(tmpDir, '.copilot', 'installed-plugins', '_direct', 'test-plugin', 'agents');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'shared.agent.md'), '# Plugin version');

    const wsAgents = path.join(tmpDir, 'agents');
    fs.mkdirSync(wsAgents);
    fs.writeFileSync(path.join(wsAgents, 'shared.agent.md'), '# Workspace version');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.get('shared')!.content).toContain('Workspace version');
  });

  it('discovers agents from .github/agents/', () => {
    const ghAgents = path.join(tmpDir, '.github', 'agents');
    fs.mkdirSync(ghAgents, { recursive: true });
    fs.writeFileSync(path.join(ghAgents, 'bob.agent.md'), '# Bob\nA GitHub convention agent.');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.has('bob')).toBe(true);
    expect(defs.get('bob')!.content).toContain('GitHub convention agent');
  });

  it('workspace agents/ overrides .github/agents/ of same name', () => {
    const ghAgents = path.join(tmpDir, '.github', 'agents');
    fs.mkdirSync(ghAgents, { recursive: true });
    fs.writeFileSync(path.join(ghAgents, 'shared.agent.md'), '# .github version');

    const wsAgents = path.join(tmpDir, 'agents');
    fs.mkdirSync(wsAgents);
    fs.writeFileSync(path.join(wsAgents, 'shared.agent.md'), '# agents/ version');

    const defs = discoverAgentDefinitions(tmpDir);
    expect(defs.get('shared')!.content).toContain('agents/ version');
  });
});

describe('discoverAgentNames', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty set when agents/ directory does not exist', () => {
    const names = discoverAgentNames(tmpDir);
    expect(names.size).toBe(0);
  });

  it('discovers agent names without reading content', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'network.agent.md'), '# Network Agent\nHandles network queries.');
    fs.writeFileSync(path.join(agentsDir, 'hvac.agent.md'), '# HVAC Agent\nHandles HVAC queries.');
    fs.writeFileSync(path.join(agentsDir, 'readme.md'), 'Not an agent file');

    const names = discoverAgentNames(tmpDir);
    expect(names.size).toBe(2);
    expect(names.has('network')).toBe(true);
    expect(names.has('hvac')).toBe(true);
  });
});

describe('resolveAgentDefinition', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'network.agent.md'), '# Network Agent');
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves explicit agent param', () => {
    const def = resolveAgentDefinition(tmpDir, 'network');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('network');
  });

  it('falls back to bot default agent', () => {
    const def = resolveAgentDefinition(tmpDir, undefined, 'network');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('network');
  });

  it('returns null when no agent specified', () => {
    const def = resolveAgentDefinition(tmpDir, undefined, null);
    expect(def).toBeNull();
  });

  it('returns null when agent not found', () => {
    const def = resolveAgentDefinition(tmpDir, 'nonexistent');
    expect(def).toBeNull();
  });

  it('explicit param overrides bot default', () => {
    fs.writeFileSync(path.join(tmpDir, 'agents', 'hvac.agent.md'), '# HVAC Agent');
    const def = resolveAgentDefinition(tmpDir, 'hvac', 'network');
    expect(def!.name).toBe('hvac');
  });
});
