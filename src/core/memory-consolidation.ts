/**
 * Memory consolidation — manages compaction saves and idle consolidation.
 *
 * Compaction save: When the SDK compacts context, merges the summary into MEMORY.md.
 * Idle consolidation: After a configurable idle period, runs an ephemeral session
 * to prune/organize MEMORY.md.
 *
 * Both operations acquire the per-workspace write lock and run silently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { acquireWorkspaceLock, tryAcquireWorkspaceLock } from './workspace-lock.js';
import type { MemoryConfig } from '../types.js';

const log = createLogger('memory');

const MEMORY_FILENAME = 'MEMORY.md';
const BACKUP_DIR = '.memory';
const BACKUP_FILENAME = 'MEMORY.md.bak';

// Per-workspace idle timers
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Default idle consolidation delay (minutes)
const DEFAULT_IDLE_MINUTES = 5;

/**
 * Merge compaction summary content into MEMORY.md.
 * Called after `session.compaction_complete` with summaryContent.
 * Acquires workspace lock; yields (no-op) if contended.
 */
export async function mergeCompactionSummary(
  workspacePath: string,
  summaryContent: string,
): Promise<boolean> {
  if (!summaryContent?.trim()) {
    log.debug(`No summary content to merge for ${workspacePath}`);
    return false;
  }

  // Block until lock is available -- compaction data is irreplaceable, never skip
  const release = await acquireWorkspaceLock(workspacePath);

  try {
    const memoryPath = path.join(workspacePath, MEMORY_FILENAME);

    // Read existing content
    let existing = '';
    try {
      existing = fs.readFileSync(memoryPath, 'utf-8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    // Create backup before modifying
    if (existing) {
      await createBackup(workspacePath, existing);
    }

    // Append compaction summary as a dated section
    const timestamp = new Date().toISOString().slice(0, 19) + 'Z';
    const separator = existing ? '\n\n' : '';
    const header = existing ? '' : `# Memory\n\n`;
    const section = `## Compaction Summary [${timestamp}]\n\n${summaryContent.trim()}\n`;

    fs.writeFileSync(memoryPath, `${header}${existing}${separator}${section}`);
    log.info(`Merged compaction summary into MEMORY.md for ${workspacePath} (${summaryContent.length} chars)`);
    return true;
  } catch (err: any) {
    log.warn(`Failed to merge compaction summary for ${workspacePath}:`, err);
    return false;
  } finally {
    release();
  }
}

/**
 * Schedule idle consolidation for a workspace.
 * Resets the timer if called again (activity resumed).
 */
export function scheduleIdleConsolidation(
  workspacePath: string,
  memoryConfig: MemoryConfig | undefined,
  runConsolidation: (workspacePath: string) => Promise<void>,
): void {
  // Cancel any existing timer
  cancelIdleConsolidation(workspacePath);

  const idleMinutes = memoryConfig?.consolidation?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  if (idleMinutes <= 0) {
    log.debug(`Idle consolidation disabled for ${workspacePath} (idleMinutes=0)`);
    return;
  }

  const timer = setTimeout(async () => {
    idleTimers.delete(workspacePath);
    log.info(`Idle consolidation triggered for ${workspacePath} (after ${idleMinutes}m idle)`);
    try {
      await runConsolidation(workspacePath);
    } catch (err: any) {
      log.warn(`Idle consolidation failed for ${workspacePath}:`, err);
    }
  }, idleMinutes * 60 * 1000);

  // Don't keep the process alive just for consolidation
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();

  idleTimers.set(workspacePath, timer);
  log.debug(`Scheduled idle consolidation for ${workspacePath} in ${idleMinutes}m`);
}

/**
 * Cancel a pending idle consolidation timer.
 * Call when new activity arrives for the workspace.
 */
export function cancelIdleConsolidation(workspacePath: string): void {
  const timer = idleTimers.get(workspacePath);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(workspacePath);
    log.debug(`Cancelled idle consolidation for ${workspacePath}`);
  }
}

/**
 * Run the consolidation logic: read MEMORY.md, send to ephemeral session for
 * pruning/organizing, write back. Acquires workspace lock.
 *
 * This function handles the lock + backup + write. The caller provides
 * the ephemeral session runner that takes the current content and returns
 * the consolidated content.
 */
export async function runConsolidation(
  workspacePath: string,
  consolidate: (currentContent: string) => Promise<string>,
): Promise<boolean> {
  const memoryPath = path.join(workspacePath, MEMORY_FILENAME);

  // Check if MEMORY.md exists and has enough content to consolidate
  let currentContent: string;
  try {
    currentContent = fs.readFileSync(memoryPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      log.debug(`No MEMORY.md to consolidate for ${workspacePath}`);
      return false;
    }
    throw err;
  }

  if (currentContent.trim().length < 100) {
    log.debug(`MEMORY.md too short to consolidate for ${workspacePath} (${currentContent.length} chars)`);
    return false;
  }

  const release = tryAcquireWorkspaceLock(workspacePath);
  if (!release) {
    log.info(`Workspace locked, skipping consolidation for ${workspacePath}`);
    return false;
  }

  try {
    // Re-read after acquiring lock (may have changed)
    currentContent = fs.readFileSync(memoryPath, 'utf-8');

    // Snapshot mtime before consolidation to detect concurrent agent writes
    const mtimeBefore = fs.statSync(memoryPath).mtimeMs;

    // Create backup
    await createBackup(workspacePath, currentContent);

    // Run consolidation via ephemeral session
    const consolidated = await consolidate(currentContent);

    if (!consolidated?.trim()) {
      log.warn(`Consolidation returned empty content for ${workspacePath}, keeping original`);
      return false;
    }

    // Check if file was modified during consolidation (agent wrote while LLM was running)
    try {
      const mtimeAfter = fs.statSync(memoryPath).mtimeMs;
      if (mtimeAfter !== mtimeBefore) {
        log.info(`MEMORY.md modified during consolidation for ${workspacePath}, skipping write to avoid data loss`);
        return false;
      }
    } catch {
      // File deleted during consolidation — skip write
      return false;
    }

    // Write consolidated content
    fs.writeFileSync(memoryPath, consolidated);
    log.info(`Consolidated MEMORY.md for ${workspacePath}: ${currentContent.length} -> ${consolidated.length} chars`);
    return true;
  } catch (err: any) {
    log.warn(`Consolidation failed for ${workspacePath}:`, err);
    return false;
  } finally {
    release();
  }
}

/** Create a backup of MEMORY.md before modifying it. */
async function createBackup(workspacePath: string, content: string): Promise<void> {
  const backupDir = path.join(workspacePath, BACKUP_DIR);
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(path.join(backupDir, BACKUP_FILENAME), content);
    log.debug(`Created MEMORY.md backup in ${backupDir}`);
  } catch (err: any) {
    log.warn(`Failed to create MEMORY.md backup:`, err);
    // Non-fatal — continue with the operation
  }
}

/** Build the consolidation prompt for the ephemeral session. */
export function buildConsolidationPrompt(currentContent: string): string {
  return [
    'You are updating a persistent memory file (MEMORY.md). Your task:',
    '',
    '1. Read the current content below',
    '2. Remove duplicate or redundant entries',
    '3. Remove entries that are clearly stale or no longer relevant',
    '4. Merge entries in "Compaction Summary" sections into the appropriate permanent sections (Preferences, Facts, Decisions, etc.)',
    '5. Keep the file well-organized with ## section headings',
    '6. Preserve date annotations [YYYY-MM-DD] on entries',
    '7. Keep the file concise -- under 200 lines is ideal',
    '8. Respond with ONLY the updated MEMORY.md content, no explanations',
    '',
    'Current MEMORY.md:',
    '```markdown',
    currentContent,
    '```',
  ].join('\n');
}

/** Reset all idle timers (for testing). */
export function _resetForTest(): void {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
}
