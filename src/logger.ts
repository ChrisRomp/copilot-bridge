import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

let minLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function fmt(level: LogLevel, tag: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  return `${ts} [${LEVEL_LABELS[level]}] [${tag}] ${msg}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

export function createLogger(tag: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog('debug')) console.log(fmt('debug', tag, msg), ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog('info')) console.log(fmt('info', tag, msg), ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog('warn')) console.warn(fmt('warn', tag, msg), ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog('error')) console.error(fmt('error', tag, msg), ...args);
    },
  };
}

// --- Self-managed log file with rotation ---

import type { LogRotationConfig } from './types.js';
export type { LogRotationConfig as LogFileConfig };

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 3;
const DEFAULT_COMPRESS = true;

let logFilePath: string | null = null;
let logFd: number | null = null;
let logConfig: Required<LogRotationConfig> = {
  maxSize: DEFAULT_MAX_SIZE,
  maxFiles: DEFAULT_MAX_FILES,
  compress: DEFAULT_COMPRESS,
};
let currentSize = 0;
let rotating = false;
let _rotationPromise: Promise<void> = Promise.resolve();

// Captured once at module load — never reassigned, so it always points at the
// real stderr even after redirectConsole() overrides process.stderr.write.
const _origStderrWrite: typeof process.stderr.write = process.stderr.write.bind(process.stderr);

/**
 * Initialize self-managed file logging. Redirects console.log/warn/error
 * to write to the specified log file with automatic size-based rotation.
 *
 * Call once at startup. After this, all console output (including createLogger
 * callers) goes to the file.
 */
export function initLogFile(filePath: string, config?: LogRotationConfig): void {
  logFilePath = filePath;
  logConfig = {
    maxSize: config?.maxSize ?? DEFAULT_MAX_SIZE,
    maxFiles: config?.maxFiles ?? DEFAULT_MAX_FILES,
    compress: config?.compress ?? DEFAULT_COMPRESS,
  };

  // Ensure the directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  openLogFd();
  redirectConsole();
}

function openLogFd(): void {
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }
  logFd = fs.openSync(logFilePath!, 'a', 0o600);
  try {
    currentSize = fs.fstatSync(logFd).size;
  } catch {
    currentSize = 0;
  }
}

function writeToLog(data: string): void {
  if (logFd === null) return;
  const buf = Buffer.from(data);
  try {
    fs.writeSync(logFd, buf);
  } catch (err: any) {
    _origStderrWrite(`[logger] Write error: ${err.message}\n`);
    return;
  }
  currentSize += buf.byteLength;

  if (!rotating && currentSize >= logConfig.maxSize) {
    rotating = true;
    _rotationPromise = rotateNow().catch((err) => {
      _origStderrWrite(`[logger] Rotation error: ${err.message}\n`);
    }).finally(() => {
      rotating = false;
    });
  }
}

function redirectConsole(): void {
  // Override process.stdout.write — captures console.log output
  process.stdout.write = function (chunk: any, encoding?: any, callback?: any): boolean {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    writeToLog(str);
    if (typeof cb === 'function') cb();
    return true;
  } as any;

  // Override process.stderr.write — captures console.error/warn output
  process.stderr.write = function (chunk: any, encoding?: any, callback?: any): boolean {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    writeToLog(str);
    if (typeof cb === 'function') cb();
    return true;
  } as any;
}

async function rotateNow(): Promise<void> {
  if (!logFilePath) return;

  // Close current fd
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    logFd = null;
  }

  const dir = path.dirname(logFilePath);
  const base = path.basename(logFilePath);

  // Delete the oldest file if at limit (check both .gz and uncompressed)
  if (logConfig.maxFiles > 0) {
    for (const ext of ['.gz', '']) {
      const oldestPath = path.join(dir, `${base}.${logConfig.maxFiles}${ext}`);
      try { fs.unlinkSync(oldestPath); } catch { /* doesn't exist */ }
    }
  }

  // Shift existing rotated files: .3 -> .4, .2 -> .3, .1 -> .2
  for (let i = logConfig.maxFiles - 1; i >= 1; i--) {
    for (const ext of ['.gz', '']) {
      const from = path.join(dir, `${base}.${i}${ext}`);
      const to = path.join(dir, `${base}.${i + 1}${ext}`);
      try { fs.renameSync(from, to); } catch { /* doesn't exist */ }
    }
  }

  // Rename current log to .1
  const rotatedPath = path.join(dir, `${base}.1`);
  try {
    fs.renameSync(logFilePath, rotatedPath);
  } catch {
    // If rename fails, just reopen
    tryOpenLogFd();
    return;
  }

  // Open a fresh log file
  tryOpenLogFd();

  if (logConfig.maxFiles === 0) {
    // No archives kept — delete the rotated file immediately
    try { fs.unlinkSync(rotatedPath); } catch { /* best effort */ }
    return;
  }

  // Compress the rotated file (awaited to prevent race with next rotation)
  if (logConfig.compress) {
    try {
      await compressFile(rotatedPath);
    } catch {
      // Compression failed — keep the uncompressed file
    }
  }
}

/** Open the log fd with retry on failure so logging isn't permanently lost. */
function tryOpenLogFd(): void {
  try {
    openLogFd();
  } catch (err: any) {
    _origStderrWrite(`[logger] Failed to open log file: ${err.message}, retrying in 1s\n`);
    setTimeout(() => {
      try {
        openLogFd();
      } catch (retryErr: any) {
        _origStderrWrite(`[logger] Retry failed: ${retryErr.message}, logging to stderr\n`);
      }
    }, 1000);
  }
}

async function compressFile(filePath: string): Promise<void> {
  const gzPath = `${filePath}.gz`;
  const source = fs.createReadStream(filePath);
  const dest = fs.createWriteStream(gzPath);
  const gzip = createGzip();
  await pipeline(source, gzip, dest);
  fs.unlinkSync(filePath);
}

/** Close the log file. For clean shutdown. */
export function closeLogFile(): void {
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    logFd = null;
  }
}

/** Expose for testing. */
export function getLogFileState(): { filePath: string | null; currentSize: number; rotating: boolean } {
  return { filePath: logFilePath, currentSize, rotating };
}

/** Wait for any in-progress rotation to complete. For testing only. */
export function waitForRotation(): Promise<void> {
  return _rotationPromise;
}
