/**
 * Project onboarding orchestration.
 *
 * Provides the logic for creating a project: Mattermost channel creation,
 * bot assignment, workspace setup, optional repo clone, and dynamic channel registration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { initWorkspace } from './workspace-manager.js';
import { addDynamicChannel } from '../state/store.js';
import { getConfig, registerDynamicChannel } from '../config.js';
import type { ChannelAdapter, ChannelConfig, CreateChannelOpts, TeamInfo, ChannelInfo } from '../types.js';

const log = createLogger('onboarding');

export interface OnboardProjectOpts {
  /** Project name (used for channel name slug and display) */
  projectName: string;
  /** Bot name to assign (key into platform.bots) */
  botName: string;
  /** Platform name */
  platform: string;
  /** Mattermost team ID */
  teamId: string;
  /** Private channel (default true) */
  private?: boolean;
  /** Custom workspace path (default: ~/.copilot-bridge/workspaces/<projectName>/) */
  workspacePath?: string;
  /** Git repo URL to clone into workspace */
  repoUrl?: string;
  /** User ID to add to the channel */
  userId?: string;
  /** Trigger mode (default: from config defaults) */
  triggerMode?: 'mention' | 'all';
  /** Threaded replies (default: from config defaults) */
  threadedReplies?: boolean;
}

export interface OnboardResult {
  channelId: string;
  channelName: string;
  workspacePath: string;
  cloned: boolean;
  steps: string[];
}

/** Slugify a project name for use as a Mattermost channel name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/**
 * Run the full project onboarding flow.
 * Returns a result describing what was created.
 */
export async function onboardProject(
  adapter: ChannelAdapter,
  opts: OnboardProjectOpts,
): Promise<OnboardResult> {
  const steps: string[] = [];
  const slug = slugify(opts.projectName);
  if (!slug) throw new Error('Project name must contain at least one alphanumeric character');
  const isPrivate = opts.private !== false;
  const config = getConfig();

  // Validate platform and bot exist
  const platform = config.platforms[opts.platform];
  if (!platform) throw new Error(`Unknown platform "${opts.platform}"`);
  if (opts.botName && platform.bots && !platform.bots[opts.botName]) {
    throw new Error(`Unknown bot "${opts.botName}" on platform "${opts.platform}"`);
  }

  // 1. Check if channel exists, create if not
  let channelId: string;
  let channelName = slug;

  if (!adapter.getChannelByName || !adapter.createChannel || !adapter.addUserToChannel) {
    throw new Error('Platform adapter does not support channel management');
  }

  const existing = await adapter.getChannelByName(opts.teamId, slug);
  if (existing) {
    channelId = existing.id;
    channelName = existing.name;
    steps.push(`Joined existing channel #${channelName}`);
    log.info(`Channel #${channelName} already exists (${channelId}), joining`);
  } else {
    channelId = await adapter.createChannel({
      name: slug,
      displayName: opts.projectName,
      private: isPrivate,
      teamId: opts.teamId,
    });
    steps.push(`Created ${isPrivate ? 'private' : 'public'} channel #${slug}`);
    log.info(`Created channel #${slug} (${channelId})`);
  }

  // 2. Add bot to channel
  const botConfig = opts.botName && platform.bots?.[opts.botName];
  if (botConfig) {
    // We need the bot's user ID — create a temporary connection to get it
    // For now, we pass it through the adapter since admin bot is making the calls
    // The adapter.addUserToChannel handles team membership automatically
    try {
      // Get bot user ID by looking up the username via MM API
      const botUserId = await lookupBotUserId(adapter, opts.botName);
      if (botUserId) {
        await adapter.addUserToChannel(channelId, botUserId);
        steps.push(`Added @${opts.botName} to channel`);
      } else {
        steps.push(`⚠️ Could not find bot user @${opts.botName} — add manually`);
      }
    } catch (err: any) {
      steps.push(`⚠️ Could not add bot: ${err?.message ?? 'unknown error'}`);
      log.warn(`Failed to add bot ${opts.botName} to channel:`, err);
    }
  }

  // 3. Add requesting user to channel
  if (opts.userId) {
    try {
      await adapter.addUserToChannel(channelId, opts.userId);
      steps.push(`Added you to channel`);
    } catch (err: any) {
      // User might already be in the channel
      log.debug(`Could not add user ${opts.userId}: ${err?.message}`);
    }
  }

  // 4. Set up workspace
  const defaultWorkspace = path.join(
    process.env.HOME ?? '/tmp',
    '.copilot-bridge', 'workspaces', slug,
  );
  let workspacePath = opts.workspacePath ?? defaultWorkspace;
  // Expand ~ to home directory (Node fs APIs don't expand tilde)
  if (workspacePath.startsWith('~/')) {
    workspacePath = path.join(process.env.HOME ?? '/tmp', workspacePath.slice(2));
  }

  // 5. Clone repo if provided (before template overlay)
  let cloned = false;
  if (opts.repoUrl) {
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
    try {
      // Check if directory is empty or doesn't have .git
      const hasGit = fs.existsSync(path.join(workspacePath, '.git'));
      if (hasGit) {
        steps.push(`Workspace already has a git repo — skipping clone`);
      } else {
        const isEmpty = fs.readdirSync(workspacePath).length === 0;
        if (isEmpty) {
          execFileSync('git', ['clone', opts.repoUrl, '.'], { cwd: workspacePath, stdio: 'pipe' });
        } else {
          // Non-empty, non-git dir: init, add remote, fetch, and checkout default branch
          execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'pipe' });
          execFileSync('git', ['remote', 'add', 'origin', opts.repoUrl], { cwd: workspacePath, stdio: 'pipe' });
          execFileSync('git', ['fetch', 'origin'], { cwd: workspacePath, stdio: 'pipe' });
          try {
            execFileSync('git', ['checkout', '-t', 'origin/main'], { cwd: workspacePath, stdio: 'pipe' });
          } catch {
            execFileSync('git', ['checkout', '-t', 'origin/master'], { cwd: workspacePath, stdio: 'pipe' });
          }
        }
        cloned = true;
        steps.push(`Cloned ${opts.repoUrl}`);
        log.info(`Cloned ${opts.repoUrl} into ${workspacePath}`);
      }
    } catch (err: any) {
      steps.push(`⚠️ Clone failed: ${err?.message ?? 'unknown error'}`);
      log.error(`Failed to clone ${opts.repoUrl}:`, err);
    }
  }

  // 6. Initialize workspace with templates (conflict-aware)
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // initWorkspace handles AGENTS.md and MEMORY.md creation (skips if exists)
  try {
    await initWorkspace(opts.botName ?? 'copilot', workspacePath, false);
    steps.push(`Workspace initialized at ${workspacePath}`);
  } catch (err: any) {
    steps.push(`⚠️ Workspace init warning: ${err?.message}`);
    log.warn(`Workspace init issue:`, err);
  }

  // 7. Register dynamic channel
  const triggerMode = opts.triggerMode ?? config.defaults.triggerMode;
  const threadedReplies = opts.threadedReplies ?? config.defaults.threadedReplies;

  await addDynamicChannel({
    channelId,
    platform: opts.platform,
    name: channelName,
    bot: opts.botName,
    workingDirectory: workspacePath,
    isDM: false,
    triggerMode,
    threadedReplies,
  });

  // Also register in-memory so it's immediately available
  registerDynamicChannel({
    id: channelId,
    platform: opts.platform,
    name: channelName,
    bot: opts.botName,
    workingDirectory: workspacePath,
    triggerMode,
    threadedReplies,
    verbose: config.defaults.verbose,
  } as ChannelConfig);

  steps.push(`Channel registered — bot is live`);
  log.info(`Onboarding complete: #${channelName} → ${opts.botName} → ${workspacePath}`);

  return { channelId, channelName, workspacePath, cloned, steps };
}

/** Look up a bot's Mattermost user ID by username. */
async function lookupBotUserId(adapter: ChannelAdapter, botName: string): Promise<string | null> {
  try {
    // Use the adapter's underlying client to search for the user
    const baseUrl = (adapter as any).client?.getBaseRoute?.();
    const token = (adapter as any).token;
    if (!baseUrl || !token) return null;

    const resp = await fetch(`${baseUrl}/users/username/${botName}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const user = await resp.json() as { id: string };
    return user.id;
  } catch {
    return null;
  }
}
