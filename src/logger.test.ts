import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initLogFile, closeLogFile, getLogFileState, waitForRotation } from './logger.js';

describe('self-managed log file', () => {
  let tmpDir: string;
  let logPath: string;

  // Save and restore process.stdout.write / process.stderr.write since
  // initLogFile replaces them.
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    logPath = path.join(tmpDir, 'test.log');
  });

  afterEach(() => {
    closeLogFile();
    // Restore original writers so later tests (and vitest output) work
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeViaStdout(msg: string): void {
    // Write directly through process.stdout.write (which initLogFile overrides).
    // Can't use console.log because vitest intercepts it before it hits process.stdout.
    process.stdout.write(msg + '\n');
  }

  it('creates log file and writes to it', () => {
    initLogFile(logPath);
    writeViaStdout('hello from test');
    closeLogFile();

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('hello from test');
  });

  it('captures stderr output', () => {
    initLogFile(logPath);
    process.stderr.write('error message\n');
    closeLogFile();

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('error message');
  });

  it('tracks current file size', () => {
    initLogFile(logPath);
    writeViaStdout('size tracking test');
    const state = getLogFileState();
    expect(state.currentSize).toBeGreaterThan(0);
    expect(state.filePath).toBe(logPath);
  });

  it('creates directory if missing', () => {
    const nestedPath = path.join(tmpDir, 'deep', 'nested', 'test.log');
    initLogFile(nestedPath);
    writeViaStdout('nested dir test');
    closeLogFile();

    expect(fs.existsSync(nestedPath)).toBe(true);
    const content = fs.readFileSync(nestedPath, 'utf-8');
    expect(content).toContain('nested dir test');
  });

  it('rotates when maxSize is exceeded', async () => {
    initLogFile(logPath, { maxSize: 200, maxFiles: 2, compress: false });

    // Write enough to trigger rotation
    for (let i = 0; i < 20; i++) {
      writeViaStdout(`line ${i}: ${'x'.repeat(50)}`);
    }

    await waitForRotation();
    closeLogFile();

    // Should have the current log and at least one rotated file
    const files = fs.readdirSync(tmpDir);
    const logFiles = files.filter(f => f.startsWith('test.log'));
    expect(logFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('respects maxFiles limit with compression disabled', async () => {
    initLogFile(logPath, { maxSize: 100, maxFiles: 2, compress: false });

    // Write many lines to trigger multiple rotations
    for (let i = 0; i < 50; i++) {
      writeViaStdout(`line ${i}: ${'y'.repeat(80)}`);
      // Let rotation complete between bursts so the next write triggers a fresh rotation
      if (i % 10 === 0) await waitForRotation();
    }

    await waitForRotation();
    closeLogFile();

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('test.log'));
    // current + up to maxFiles rotated = 3 total max
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('compresses rotated files by default', async () => {
    initLogFile(logPath, { maxSize: 200, maxFiles: 2, compress: true });

    for (let i = 0; i < 30; i++) {
      writeViaStdout(`line ${i}: ${'z'.repeat(60)}`);
    }

    await waitForRotation();
    closeLogFile();

    const files = fs.readdirSync(tmpDir);
    const gzFiles = files.filter(f => f.endsWith('.gz'));
    expect(gzFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('appends to existing log file', () => {
    fs.writeFileSync(logPath, 'existing content\n');
    initLogFile(logPath);
    writeViaStdout('new content');
    closeLogFile();

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('existing content');
    expect(content).toContain('new content');
  });
});
