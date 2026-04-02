import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Capture the logger mock so we can assert on calls
const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../logger.js', () => ({
  createLogger: () => mockLog,
  setLogLevel: vi.fn(),
  initLogFile: vi.fn(),
}));

// Must import after mocking
const { parseEnvFile } = await import('./session-manager.js');

describe('error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseEnvFile', () => {
    it('does not log on ENOENT (missing file is expected)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
      const missingPath = path.join(tmpDir, 'nonexistent.env');
      const result = parseEnvFile(missingPath);
      expect(result).toEqual({});
      expect(mockLog.warn).not.toHaveBeenCalled();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('logs warn on non-ENOENT errors', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
      const dirPath = path.join(tmpDir, 'a-directory');
      fs.mkdirSync(dirPath);

      // Reading a directory as a file throws EISDIR, not ENOENT
      const result = parseEnvFile(dirPath);
      expect(result).toEqual({});
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse .env file'),
        expect.anything(),
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('parses valid .env file without warnings', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
      const envPath = path.join(tmpDir, '.env');
      fs.writeFileSync(envPath, 'FOO=bar\nBAZ="quoted"\n# comment\n');

      const result = parseEnvFile(envPath);
      expect(result).toEqual({ FOO: 'bar', BAZ: 'quoted' });
      expect(mockLog.warn).not.toHaveBeenCalled();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
