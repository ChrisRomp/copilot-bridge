import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMemoryPointer } from './session-manager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('buildMemoryPointer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pointer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a pointer block when MEMORY.md does not exist', () => {
    const result = buildMemoryPointer(tmpDir);
    expect(result).toContain('<memory>');
    expect(result).toContain('</memory>');
    expect(result).toContain('does not exist yet');
    expect(result).toContain('Create it when you learn something');
  });

  it('includes section headlines when MEMORY.md exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      '# Memory\n\n## Preferences\n- things\n\n## Facts\n- stuff\n\n## Decisions\n- choices\n',
    );
    const result = buildMemoryPointer(tmpDir);
    expect(result).toContain('Sections: Preferences, Facts, Decisions');
    expect(result).toContain('Read MEMORY.md at session start');
    expect(result).not.toContain('does not exist yet');
  });

  it('excludes top-level headings (only ## level)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      '# Memory\n\n## Preferences\n- things\n\n### Details\nmore stuff\n',
    );
    const result = buildMemoryPointer(tmpDir);
    expect(result).toContain('Sections: Preferences');
    expect(result).not.toContain('Details');
    expect(result).not.toContain('Memory');
  });

  it('handles MEMORY.md with no ## headings', () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# Memory\nSome notes.\n');
    const result = buildMemoryPointer(tmpDir);
    expect(result).not.toContain('Sections:');
    expect(result).toContain('Read MEMORY.md');
  });

  it('includes cloud memory instructions when cloudMemory is true', () => {
    const result = buildMemoryPointer(tmpDir, { cloudMemory: true });
    expect(result).toContain('Cloud memory (store_memory/vote_memory) is also enabled');
    expect(result).toContain('Use store_memory for facts');
    expect(result).toContain('Use MEMORY.md for detailed workspace context');
  });

  it('does not include cloud memory instructions by default', () => {
    const result = buildMemoryPointer(tmpDir);
    expect(result).not.toContain('store_memory');
    expect(result).not.toContain('cloud memory');
  });

  it('does not include cloud memory when cloudMemory is explicitly false', () => {
    const result = buildMemoryPointer(tmpDir, { cloudMemory: false });
    expect(result).not.toContain('store_memory');
  });
});
