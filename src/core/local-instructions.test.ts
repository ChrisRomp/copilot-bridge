import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadLocalInstructions } from './session-manager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('loadLocalInstructions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-instructions-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when workingDirectory is undefined', () => {
    expect(loadLocalInstructions(undefined)).toBeUndefined();
  });

  it('returns undefined when workingDirectory is empty string', () => {
    expect(loadLocalInstructions('')).toBeUndefined();
  });

  it('returns undefined when AGENTS.local.md does not exist', () => {
    expect(loadLocalInstructions(tmpDir)).toBeUndefined();
  });

  it('returns undefined when AGENTS.local.md is empty', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.local.md'), '');
    expect(loadLocalInstructions(tmpDir)).toBeUndefined();
  });

  it('returns undefined when AGENTS.local.md is whitespace-only', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.local.md'), '  \n\n  ');
    expect(loadLocalInstructions(tmpDir)).toBeUndefined();
  });

  it('wraps content in <local_instructions> tags', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.local.md'), '# My Rules\nDo the thing.');
    const result = loadLocalInstructions(tmpDir);
    expect(result).toBe(
      '<local_instructions>\n# My Rules\nDo the thing.\n</local_instructions>',
    );
  });

  it('trims leading/trailing whitespace from content', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.local.md'), '\n  Hello  \n\n');
    const result = loadLocalInstructions(tmpDir);
    expect(result).toBe('<local_instructions>\nHello\n</local_instructions>');
  });

  it('returns undefined for a nonexistent directory', () => {
    expect(loadLocalInstructions('/tmp/nonexistent-dir-' + Date.now())).toBeUndefined();
  });
});
