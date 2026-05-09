import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mergeCompactionSummary,
  scheduleIdleConsolidation,
  cancelIdleConsolidation,
  runConsolidation,
  buildConsolidationPrompt,
  _resetForTest,
} from './memory-consolidation.js';
import { _resetLocksForTest } from './workspace-lock.js';

describe('memory-consolidation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consolidation-'));
    _resetForTest();
    _resetLocksForTest();
  });

  afterEach(() => {
    _resetForTest();
    _resetLocksForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('mergeCompactionSummary', () => {
    it('creates MEMORY.md with header and compaction section when file does not exist', async () => {
      const result = await mergeCompactionSummary(tmpDir, 'User prefers TypeScript.');
      expect(result).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('# Memory');
      expect(content).toContain('## Compaction Summary');
      expect(content).toContain('User prefers TypeScript.');
    });

    it('appends to existing MEMORY.md', async () => {
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# Memory\n\n## Facts\n- Build with npm\n');
      const result = await mergeCompactionSummary(tmpDir, 'New fact discovered.');
      expect(result).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('## Facts');
      expect(content).toContain('## Compaction Summary');
      expect(content).toContain('New fact discovered.');
    });

    it('creates backup before modifying', async () => {
      const original = '# Memory\n\n## Facts\n- Original content\n';
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), original);

      await mergeCompactionSummary(tmpDir, 'New summary');

      const backup = fs.readFileSync(path.join(tmpDir, '.memory', 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });

    it('returns false for empty summary', async () => {
      expect(await mergeCompactionSummary(tmpDir, '')).toBe(false);
      expect(await mergeCompactionSummary(tmpDir, '  ')).toBe(false);
    });

    it('waits for lock instead of dropping data', async () => {
      const { acquireWorkspaceLock } = await import('./workspace-lock.js');
      const release = await acquireWorkspaceLock(tmpDir);

      // Start merge — it should block, not return false
      let mergeResolved = false;
      const mergePromise = mergeCompactionSummary(tmpDir, 'Important data').then((result) => {
        mergeResolved = true;
        return result;
      });

      // Give it time to hit the lock
      await new Promise(r => setTimeout(r, 20));
      expect(mergeResolved).toBe(false); // still waiting

      release(); // unlock
      const result = await mergePromise;
      expect(result).toBe(true);
      expect(mergeResolved).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(content).toContain('Important data');
    });
  });

  describe('runConsolidation', () => {
    it('consolidates MEMORY.md content', async () => {
      const original = '# Memory\n\n## Facts\n- Fact 1\n- Fact 2\n\n## Compaction Summary\n- Redundant fact\n\nExtra padding to reach 100 chars minimum for consolidation to trigger properly.';
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), original);

      const result = await runConsolidation(tmpDir, async (content) => {
        expect(content).toBe(original);
        return '# Memory\n\n## Facts\n- Fact 1\n- Fact 2\n';
      });

      expect(result).toBe(true);
      const updated = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(updated).toBe('# Memory\n\n## Facts\n- Fact 1\n- Fact 2\n');
    });

    it('skips when MEMORY.md does not exist', async () => {
      const result = await runConsolidation(tmpDir, async () => 'should not be called');
      expect(result).toBe(false);
    });

    it('skips when MEMORY.md is too short', async () => {
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# Memory\n');
      const result = await runConsolidation(tmpDir, async () => 'should not be called');
      expect(result).toBe(false);
    });

    it('keeps original when consolidation returns empty', async () => {
      const original = '# Memory\n\n## Facts\n- Lots of facts here to ensure the file is long enough for consolidation to proceed properly with padding.';
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), original);

      const result = await runConsolidation(tmpDir, async () => '');
      expect(result).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8')).toBe(original);
    });

    it('creates backup before rewriting', async () => {
      const original = '# Memory\n\n## Facts\n- Original data here with enough content to pass the minimum length threshold for consolidation.';
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), original);

      await runConsolidation(tmpDir, async () => '# Memory\n\n## Facts\n- Consolidated\n');

      const backup = fs.readFileSync(path.join(tmpDir, '.memory', 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });

    it('skips write when MEMORY.md was modified during consolidation', async () => {
      const original = '# Memory\n\n## Facts\n- Original data here with enough content to pass the minimum length threshold for consolidation.';
      const memoryPath = path.join(tmpDir, 'MEMORY.md');
      fs.writeFileSync(memoryPath, original);

      const result = await runConsolidation(tmpDir, async () => {
        // Simulate agent modifying MEMORY.md while consolidation is running
        fs.writeFileSync(memoryPath, original + '\n- Agent added this during consolidation\n');
        return '# Memory\n\n## Facts\n- Stale consolidated content\n';
      });

      expect(result).toBe(false);
      // File should retain the agent's modification, not the stale consolidation
      const content = fs.readFileSync(memoryPath, 'utf-8');
      expect(content).toContain('Agent added this during consolidation');
    });
  });

  describe('scheduleIdleConsolidation', () => {
    it('schedules and fires after idle period', async () => {
      vi.useFakeTimers();
      const runner = vi.fn().mockResolvedValue(undefined);

      scheduleIdleConsolidation(tmpDir, { consolidation: { idleMinutes: 1 } }, runner);

      // Not fired yet
      expect(runner).not.toHaveBeenCalled();

      // Advance past idle period
      await vi.advanceTimersByTimeAsync(61_000);
      expect(runner).toHaveBeenCalledWith(tmpDir);

      vi.useRealTimers();
    });

    it('cancels timer on cancel call', async () => {
      vi.useFakeTimers();
      const runner = vi.fn().mockResolvedValue(undefined);

      scheduleIdleConsolidation(tmpDir, { consolidation: { idleMinutes: 1 } }, runner);
      cancelIdleConsolidation(tmpDir);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(runner).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('resets timer on repeated schedule calls', async () => {
      vi.useFakeTimers();
      const runner = vi.fn().mockResolvedValue(undefined);

      scheduleIdleConsolidation(tmpDir, { consolidation: { idleMinutes: 1 } }, runner);
      await vi.advanceTimersByTimeAsync(30_000);

      // Re-schedule resets the timer
      scheduleIdleConsolidation(tmpDir, { consolidation: { idleMinutes: 1 } }, runner);
      await vi.advanceTimersByTimeAsync(30_000);

      // 60s total but only 30s since last schedule -- should not fire yet
      expect(runner).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(31_000);
      expect(runner).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('does not schedule when idleMinutes is 0', () => {
      vi.useFakeTimers();
      const runner = vi.fn().mockResolvedValue(undefined);

      scheduleIdleConsolidation(tmpDir, { consolidation: { idleMinutes: 0 } }, runner);

      vi.advanceTimersByTime(600_000);
      expect(runner).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('buildConsolidationPrompt', () => {
    it('includes current content in the prompt', () => {
      const prompt = buildConsolidationPrompt('# Memory\n\n## Facts\n- stuff\n');
      expect(prompt).toContain('# Memory');
      expect(prompt).toContain('## Facts');
      expect(prompt).toContain('- stuff');
      expect(prompt).toContain('Remove duplicate or redundant entries');
      expect(prompt).toContain('Respond with ONLY the updated MEMORY.md content');
    });
  });
});
