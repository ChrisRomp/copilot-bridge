import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LoopDetector, MAX_IDENTICAL_CALLS, WINDOW_MS, CRITICAL_MULTIPLIER, MAX_HISTORY } from './loop-detector.js';

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flag below the threshold', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      const result = detector.recordToolCall('ch1', 'bash', { command: 'ls' });
      expect(result.isLoop).toBe(false);
      expect(result.isCritical).toBe(false);
    }
  });

  it('flags a loop at the threshold', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    }
    const result = detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    expect(result.isLoop).toBe(true);
    expect(result.count).toBe(MAX_IDENTICAL_CALLS);
    expect(result.isCritical).toBe(false);
  });

  it('flags a critical loop at 2x the threshold', () => {
    const criticalCount = MAX_IDENTICAL_CALLS * CRITICAL_MULTIPLIER;
    for (let i = 0; i < criticalCount - 1; i++) {
      detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    }
    const result = detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    expect(result.isLoop).toBe(true);
    expect(result.isCritical).toBe(true);
    expect(result.count).toBe(criticalCount);
  });

  it('does not conflate different arguments for the same tool', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS; i++) {
      detector.recordToolCall('ch1', 'bash', { command: `cmd-${i}` });
    }
    const result = detector.recordToolCall('ch1', 'bash', { command: 'cmd-new' });
    expect(result.isLoop).toBe(false);
  });

  it('does not conflate different tools with the same arguments', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS; i++) {
      detector.recordToolCall('ch1', `tool-${i}`, { path: '/tmp' });
    }
    const result = detector.recordToolCall('ch1', 'tool-new', { path: '/tmp' });
    expect(result.isLoop).toBe(false);
  });

  it('does not count calls outside the time window', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    }
    vi.advanceTimersByTime(WINDOW_MS + 1);
    const result = detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    expect(result.isLoop).toBe(false);
    expect(result.count).toBe(1);
  });

  it('resets history for a channel', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    }
    detector.reset('ch1');
    const result = detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    expect(result.isLoop).toBe(false);
    expect(result.count).toBe(1);
  });

  it('isolates channels from each other', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      detector.recordToolCall('ch1', 'bash', { command: 'ls' });
    }
    const result = detector.recordToolCall('ch2', 'bash', { command: 'ls' });
    expect(result.isLoop).toBe(false);
    expect(result.count).toBe(1);
  });

  it('handles many varied calls without false positives', () => {
    for (let i = 0; i < 100; i++) {
      const result = detector.recordToolCall('ch1', 'bash', { command: `unique-${i}` });
      expect(result.isLoop).toBe(false);
    }
  });

  it('hashes objects with different key order identically', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS - 1; i++) {
      detector.recordToolCall('ch1', 'edit', { path: '/a', content: 'x' });
    }
    const result = detector.recordToolCall('ch1', 'edit', { content: 'x', path: '/a' });
    expect(result.isLoop).toBe(true);
    expect(result.count).toBe(MAX_IDENTICAL_CALLS);
  });

  it('caps history at MAX_HISTORY entries', () => {
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      detector.recordToolCall('ch1', 'bash', { command: `cmd-${i}` });
    }
    const result = detector.recordToolCall('ch1', 'bash', { command: 'cmd-new' });
    expect(result.isLoop).toBe(false);
  });

  it('handles null/undefined args gracefully', () => {
    for (let i = 0; i < MAX_IDENTICAL_CALLS; i++) {
      detector.recordToolCall('ch1', 'view', null);
    }
    const result = detector.recordToolCall('ch1', 'view', null);
    expect(result.isLoop).toBe(true);
  });
});
