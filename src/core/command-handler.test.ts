import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCommand, parseCommand } from './command-handler.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// --- parseCommand ---

describe('parseCommand', () => {
  it('parses command with no args', () => {
    expect(parseCommand('/help')).toEqual({ command: 'help', args: '' });
  });

  it('parses command with args', () => {
    expect(parseCommand('/agent network')).toEqual({ command: 'agent', args: 'network' });
  });

  it('lowercases command', () => {
    expect(parseCommand('/HELP')).toEqual({ command: 'help', args: '' });
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hello')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseCommand('  /help  ')).toEqual({ command: 'help', args: '' });
  });
});

// --- /agent validation ---

describe('/agent command', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'network.agent.md'), '# Network Agent\nHandles network queries.');
    fs.writeFileSync(path.join(agentsDir, 'hvac.agent.md'), '# HVAC Agent\nHandles HVAC queries.');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deselects agent when no args', () => {
    const result = handleCommand('ch-1', '/agent');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('switch_agent');
    expect(result.payload).toBeNull();
    expect(result.response).toContain('deselected');
  });

  it('switches to valid agent', () => {
    const result = handleCommand('ch-1', '/agent network', undefined, undefined, { workingDirectory: tmpDir });
    expect(result.handled).toBe(true);
    expect(result.action).toBe('switch_agent');
    expect(result.payload).toBe('network');
    expect(result.response).toContain('network');
  });

  it('rejects invalid agent with suggestions', () => {
    const result = handleCommand('ch-1', '/agent nonexistent', undefined, undefined, { workingDirectory: tmpDir });
    expect(result.handled).toBe(true);
    expect(result.action).toBeUndefined();
    expect(result.response).toContain('not found');
    expect(result.response).toContain('network');
    expect(result.response).toContain('hvac');
  });

  it('rejects invalid agent when no agents exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-empty-'));
    try {
      const result = handleCommand('ch-1', '/agent nonexistent', undefined, undefined, { workingDirectory: emptyDir });
      expect(result.handled).toBe(true);
      expect(result.response).toContain('not found');
      expect(result.response).toContain('No agent definitions found');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('falls through without validation when no workingDirectory', () => {
    const result = handleCommand('ch-1', '/agent anything', undefined, undefined, {});
    expect(result.handled).toBe(true);
    expect(result.action).toBe('switch_agent');
    expect(result.payload).toBe('anything');
  });
});

// --- /agents listing ---

describe('/agents command', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'network.agent.md'), '# Network Agent\nHandles network queries.');
    fs.writeFileSync(path.join(agentsDir, 'hvac.agent.md'), '# HVAC Agent\nHandles HVAC queries.');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists available agents', () => {
    const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: tmpDir });
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Available Agents');
    expect(result.response).toContain('network');
    expect(result.response).toContain('hvac');
  });

  it('shows current agent indicator', () => {
    const result = handleCommand('ch-1', '/agents', { sessionId: 's1', model: 'm1', agent: 'network' }, undefined, { workingDirectory: tmpDir });
    expect(result.response).toContain('← current');
    expect(result.response).toContain('network');
  });

  it('warns when current agent has no definition', () => {
    const result = handleCommand('ch-1', '/agents', { sessionId: 's1', model: 'm1', agent: 'deleted' }, undefined, { workingDirectory: tmpDir });
    expect(result.response).toContain('deleted');
    expect(result.response).toContain('no definition file');
  });

  it('shows empty state when no agents exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-empty-'));
    try {
      const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: emptyDir });
      expect(result.response).toContain('No agent definitions found');
      expect(result.response).toContain('.agent.md');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('reports no workspace when workingDirectory missing', () => {
    const result = handleCommand('ch-1', '/agents', undefined, undefined, {});
    expect(result.response).toContain('No workspace configured');
  });

  it('extracts description from agent content', () => {
    const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: tmpDir });
    expect(result.response).toContain('Handles network queries');
  });

  it('skips indented headings when extracting description', () => {
    const indentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-indent-'));
    try {
      const agentsDir = path.join(indentDir, 'agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'test.agent.md'), '  # Indented Heading\nActual description line.');
      const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: indentDir });
      expect(result.response).toContain('Actual description line');
      expect(result.response).not.toContain('Indented Heading');
    } finally {
      fs.rmSync(indentDir, { recursive: true, force: true });
    }
  });
});
