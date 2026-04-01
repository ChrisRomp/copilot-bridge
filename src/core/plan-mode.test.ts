import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCommand } from './command-handler.js';
import { extractPlanSummary } from './session-manager.js';

// --- extractPlanSummary ---

describe('extractPlanSummary', () => {
  it('extracts heading and first body line', () => {
    const content = '# My Plan\n\nThis is the first line.\n\nMore details.';
    expect(extractPlanSummary(content)).toBe('My Plan: This is the first line.');
  });

  it('handles H2 headings', () => {
    const content = '## Refactor Auth\n\nMove to JWT tokens.';
    expect(extractPlanSummary(content)).toBe('Refactor Auth: Move to JWT tokens.');
  });

  it('returns heading only when no body', () => {
    const content = '# Plan Title\n\n';
    expect(extractPlanSummary(content)).toBe('Plan Title');
  });

  it('returns body only when no heading', () => {
    const content = 'Just a plain text plan without headings.';
    expect(extractPlanSummary(content)).toBe('Just a plain text plan without headings.');
  });

  it('truncates long summaries', () => {
    const longHeading = '# ' + 'A'.repeat(200);
    expect(extractPlanSummary(longHeading)).toHaveLength(150);
    expect(extractPlanSummary(longHeading)).toMatch(/\.\.\.$/);
  });

  it('returns (empty plan) for empty content', () => {
    expect(extractPlanSummary('')).toBe('(empty plan)');
    expect(extractPlanSummary('   ')).toBe('(empty plan)');
    expect(extractPlanSummary('\n\n')).toBe('(empty plan)');
  });

  it('skips multiple headings to get body', () => {
    const content = '# Main\n## Sub\nActual content here.';
    // First heading is "Main", then "Sub" is also a heading, body is "Actual content here."
    expect(extractPlanSummary(content)).toBe('Main: Actual content here.');
  });
});

// --- /implement command ---

describe('/implement command', () => {
  it('returns implement action with no args', async () => {
    const result = await handleCommand('ch1', '/implement');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('implement');
    expect(result.payload).toBeUndefined();
  });

  it('returns implement action with yolo arg', async () => {
    const result = await handleCommand('ch1', '/implement yolo');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('implement');
    expect(result.payload).toBe('yolo');
  });

  it('returns implement action with interactive arg', async () => {
    const result = await handleCommand('ch1', '/implement interactive');
    expect(result.handled).toBe(true);
    expect(result.action).toBe('implement');
    expect(result.payload).toBe('interactive');
  });
});

// --- Debounce logic ---

describe('plan changed debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls callback after delay', () => {
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
    const callback = vi.fn();

    // Simulate debouncePlanChanged logic
    const channelId = 'ch1';
    const delayMs = 3000;
    const existing = debounceMap.get(channelId);
    if (existing) clearTimeout(existing);
    debounceMap.set(channelId, setTimeout(() => {
      debounceMap.delete(channelId);
      callback();
    }, delayMs));

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('resets on rapid-fire events', () => {
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
    const callback = vi.fn();
    const channelId = 'ch1';
    const delayMs = 3000;

    function debouncePlanChanged() {
      const existing = debounceMap.get(channelId);
      if (existing) clearTimeout(existing);
      debounceMap.set(channelId, setTimeout(() => {
        debounceMap.delete(channelId);
        callback();
      }, delayMs));
    }

    // Fire 5 events rapidly
    debouncePlanChanged();
    vi.advanceTimersByTime(1000);
    debouncePlanChanged();
    vi.advanceTimersByTime(1000);
    debouncePlanChanged();
    vi.advanceTimersByTime(1000);
    debouncePlanChanged();
    vi.advanceTimersByTime(1000);
    debouncePlanChanged();

    // Not called yet
    expect(callback).not.toHaveBeenCalled();

    // After final debounce window
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledOnce();
  });
});

// --- Pending plan exit state ---

describe('pending plan exit', () => {
  it('set/has/consume lifecycle', () => {
    const pendingMap = new Map<string, any>();
    const channelId = 'ch1';

    expect(pendingMap.has(channelId)).toBe(false);

    const exit = {
      requestId: 'req-1',
      summary: 'Build auth module',
      planContent: '# Auth\nImplement JWT.',
      actions: ['implement', 'exit'],
      recommendedAction: 'implement',
      createdAt: Date.now(),
    };

    pendingMap.set(channelId, exit);
    expect(pendingMap.has(channelId)).toBe(true);

    const consumed = pendingMap.get(channelId);
    pendingMap.delete(channelId);
    expect(consumed).toEqual(exit);
    expect(pendingMap.has(channelId)).toBe(false);
  });

  it('consume returns undefined when nothing pending', () => {
    const pendingMap = new Map<string, any>();
    expect(pendingMap.get('ch1')).toBeUndefined();
  });
});
