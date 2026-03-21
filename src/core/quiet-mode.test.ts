import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enterQuietMode, exitQuietMode, getQuietState, isQuiet, _resetForTest } from './quiet-mode.js';

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
  vi.useRealTimers();
});

describe('enterQuietMode / exitQuietMode', () => {
  it('sets quiet state', () => {
    enterQuietMode('ch1');
    expect(isQuiet('ch1')).toBe(true);
    expect(getQuietState('ch1')).toBeDefined();
  });

  it('channels are independent', () => {
    enterQuietMode('ch1');
    expect(isQuiet('ch1')).toBe(true);
    expect(isQuiet('ch2')).toBe(false);
  });

  it('exitQuietMode clears state', () => {
    enterQuietMode('ch1');
    exitQuietMode('ch1');
    expect(isQuiet('ch1')).toBe(false);
    expect(getQuietState('ch1')).toBeUndefined();
  });

  it('exitQuietMode is safe when not in quiet mode', () => {
    exitQuietMode('ch1'); // should not throw
    expect(isQuiet('ch1')).toBe(false);
  });

  it('re-entering clears previous timeout', () => {
    enterQuietMode('ch1');
    const first = getQuietState('ch1');
    enterQuietMode('ch1');
    const second = getQuietState('ch1');
    // Different state objects
    expect(second).not.toBe(first);
    expect(isQuiet('ch1')).toBe(true);
  });
});

describe('cleanup function', () => {
  it('returns a cleanup function that clears state', () => {
    const cleanup = enterQuietMode('ch1');
    expect(isQuiet('ch1')).toBe(true);
    cleanup();
    expect(isQuiet('ch1')).toBe(false);
  });

  it('cleanup is idempotent', () => {
    const cleanup = enterQuietMode('ch1');
    cleanup();
    cleanup(); // should not throw
    expect(isQuiet('ch1')).toBe(false);
  });

  it('cleanup does not affect other channels', () => {
    const cleanup1 = enterQuietMode('ch1');
    enterQuietMode('ch2');
    cleanup1();
    expect(isQuiet('ch1')).toBe(false);
    expect(isQuiet('ch2')).toBe(true);
  });
});

describe('timeout safety net', () => {
  it('auto-clears after 60s', () => {
    enterQuietMode('ch1');
    expect(isQuiet('ch1')).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(isQuiet('ch1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isQuiet('ch1')).toBe(false);
  });

  it('exitQuietMode prevents timeout from firing', () => {
    enterQuietMode('ch1');
    exitQuietMode('ch1');
    vi.advanceTimersByTime(60_000);
    // No error from stale timeout
    expect(isQuiet('ch1')).toBe(false);
  });

  it('cleanup function prevents timeout from firing', () => {
    const cleanup = enterQuietMode('ch1');
    cleanup();
    vi.advanceTimersByTime(60_000);
    expect(isQuiet('ch1')).toBe(false);
  });
});

describe('getQuietState', () => {
  it('returns state when quiet, undefined otherwise', () => {
    expect(getQuietState('ch1')).toBeUndefined();
    enterQuietMode('ch1');
    expect(getQuietState('ch1')).toBeDefined();
    exitQuietMode('ch1');
    expect(getQuietState('ch1')).toBeUndefined();
  });
});
