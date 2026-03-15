import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCommand, parseCommand, type ModelInfo } from './command-handler.js';
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
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
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
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
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
    const savedHome = process.env.HOME;
    process.env.HOME = indentDir;
    try {
      const agentsDir = path.join(indentDir, 'agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'test.agent.md'), '  # Indented Heading\nActual description line.');
      const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: indentDir });
      expect(result.response).toContain('Actual description line');
      expect(result.response).not.toContain('Indented Heading');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      fs.rmSync(indentDir, { recursive: true, force: true });
    }
  });

  it('extracts description from YAML frontmatter', () => {
    const fmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-fm-'));
    const savedHome = process.env.HOME;
    process.env.HOME = fmDir;
    try {
      const agentsDir = path.join(fmDir, 'agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'fancy.agent.md'), '---\nname: fancy\ndescription: A very fancy agent.\n---\n# Fancy Agent');
      const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: fmDir });
      expect(result.response).toContain('A very fancy agent');
      expect(result.response).not.toContain('---');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      fs.rmSync(fmDir, { recursive: true, force: true });
    }
  });

  it('parses YAML block scalar descriptions', () => {
    const fmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-block-'));
    const savedHome = process.env.HOME;
    process.env.HOME = fmDir;
    try {
      const agentsDir = path.join(fmDir, 'agents');
      fs.mkdirSync(agentsDir);
      fs.writeFileSync(path.join(agentsDir, 'bob.agent.md'),
        '---\nname: Bob\ndescription: >-\n  Use this agent for work prioritization\n  and meeting prep.\n---\n# Bob');
      const result = handleCommand('ch-1', '/agents', undefined, undefined, { workingDirectory: fmDir });
      expect(result.response).toContain('Use this agent for work prioritization and meeting prep.');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      fs.rmSync(fmDir, { recursive: true, force: true });
    }
  });
});

// --- Mode commands ---

describe('mode commands', () => {
  it('/plan returns action plan with no payload when bare', () => {
    const result = handleCommand('ch-mode-1', '/plan');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('plan');
    expect(result.payload).toBeUndefined();
  });

  it('/plan show returns action plan with show payload', () => {
    const result = handleCommand('ch-mode-1', '/plan show');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('plan');
    expect(result.payload).toBe('show');
  });

  it('/plan clear returns action plan with clear payload', () => {
    const result = handleCommand('ch-mode-1', '/plan clear');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('plan');
    expect(result.payload).toBe('clear');
  });

  it('/plan on returns action plan with on payload', () => {
    const result = handleCommand('ch-mode-1', '/plan on');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('plan');
    expect(result.payload).toBe('on');
  });

  it('/plan off returns action plan with off payload', () => {
    const result = handleCommand('ch-mode-1', '/plan off');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('plan');
    expect(result.payload).toBe('off');
  });

  it('/autopilot returns action toggle_autopilot', () => {
    const result = handleCommand('ch-mode-1', '/autopilot');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('toggle_autopilot');
  });

  it('/yolo toggles permissionMode to autopilot', () => {
    const result = handleCommand('ch-mode-yolo', '/yolo', undefined, { verbose: false, permissionMode: 'interactive', reasoningEffort: null });
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Yolo enabled');
  });

  it('/yolo toggles permissionMode back to interactive', () => {
    const result = handleCommand('ch-mode-yolo', '/yolo', undefined, { verbose: false, permissionMode: 'autopilot', reasoningEffort: null });
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Yolo disabled');
  });
});

// --- /status mode display ---

describe('/status command', () => {
  it('shows interactive mode by default', () => {
    const result = handleCommand('ch-status-1', '/status',
      { sessionId: 'abc-123', model: 'claude-sonnet-4.5', agent: null },
      { verbose: false, permissionMode: 'interactive', reasoningEffort: null },
    );
    expect(result.response).toContain('Mode: 🛡️ Interactive');
    expect(result.response).toContain('Yolo: 🛡️ Off');
  });

  it('shows plan mode when sessionMode is plan', async () => {
    const { setChannelPrefs } = await import('../state/store.js');
    setChannelPrefs('ch-status-plan', { sessionMode: 'plan', permissionMode: 'autopilot' });

    const result = handleCommand('ch-status-plan', '/status',
      { sessionId: 'abc-123', model: 'claude-sonnet-4.5', agent: null },
      { verbose: false, permissionMode: 'autopilot', reasoningEffort: null },
    );
    expect(result.response).toContain('Mode: 📋 Plan');
    expect(result.response).toContain('Yolo: 🤠 On');
  });

  it('shows autopilot mode when sessionMode is autopilot', async () => {
    const { setChannelPrefs } = await import('../state/store.js');
    setChannelPrefs('ch-status-auto', { sessionMode: 'autopilot' });

    const result = handleCommand('ch-status-auto', '/status',
      { sessionId: 'abc-123', model: 'claude-sonnet-4.5', agent: null },
      { verbose: false, permissionMode: 'interactive', reasoningEffort: null },
    );
    expect(result.response).toContain('Mode: 🤖 Autopilot');
    expect(result.response).toContain('Yolo: 🛡️ Off');
  });

  it('shows no active session when no sessionInfo', () => {
    const result = handleCommand('ch-status-none', '/status');
    expect(result.response).toContain('No active session');
  });
});

describe('/reasoning command', () => {
  const SESSION_INFO = { sessionId: 'sess-123', model: 'claude-opus-4.6', agent: null };
  const REASONING_MODEL: ModelInfo = {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  };

  it('returns set_reasoning action with valid level', () => {
    const result = handleCommand('ch-reason-1', '/reasoning high', SESSION_INFO,
      { verbose: false, permissionMode: 'interactive', reasoningEffort: null },
      undefined, [REASONING_MODEL]);
    expect(result.handled).toBe(true);
    expect(result.action).toBe('set_reasoning');
    expect(result.payload).toBe('high');
  });

  it('rejects invalid reasoning level', () => {
    const result = handleCommand('ch-reason-2', '/reasoning banana', SESSION_INFO,
      { verbose: false, permissionMode: 'interactive', reasoningEffort: null },
      undefined, [REASONING_MODEL]);
    expect(result.handled).toBe(true);
    expect(result.action).toBeUndefined();
    expect(result.response).toContain('Invalid reasoning effort');
  });

  it('shows current level when no args', () => {
    const result = handleCommand('ch-reason-3', '/reasoning', SESSION_INFO,
      { verbose: false, permissionMode: 'interactive', reasoningEffort: 'high' });
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Current reasoning effort: **high**');
  });
});

describe('/always command', () => {
  it('/always approve returns remember action', () => {
    const result = handleCommand('ch-always-1', '/always approve');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('remember');
  });

  it('/always deny returns remember_deny action', () => {
    const result = handleCommand('ch-always-2', '/always deny');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('remember_deny');
  });

  it('/always with no args shows usage', () => {
    const result = handleCommand('ch-always-3', '/always');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });

  it('/always with invalid arg shows usage', () => {
    const result = handleCommand('ch-always-4', '/always banana');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });

  it('/remember still works as alias for approve+persist', () => {
    const result = handleCommand('ch-always-5', '/remember');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('remember');
  });
});
