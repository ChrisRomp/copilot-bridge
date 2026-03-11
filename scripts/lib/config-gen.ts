/**
 * Config file generator. Collects structured input and writes
 * ~/.copilot-bridge/config.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface BotEntry {
  name: string;
  token: string;
  admin: boolean;
  agent?: string;
  appToken?: string; // Slack Socket Mode app-level token
}

export interface ChannelEntry {
  id: string;
  name?: string;
  platform: string;
  bot: string;
  workingDirectory: string;
  triggerMode?: 'all' | 'mention';
  threadedReplies?: boolean;
}

export interface ConfigDefaults {
  model?: string;
  triggerMode?: string;
  threadedReplies?: boolean;
  verbose?: boolean;
}

export interface GeneratedConfig {
  platforms: {
    mattermost?: {
      url: string;
      bots?: Record<string, { token: string; admin?: boolean; agent?: string }>;
    };
    slack?: {
      bots?: Record<string, { token: string; appToken: string; admin?: boolean; agent?: string }>;
    };
  };
  channels: Array<{
    id: string;
    name?: string;
    platform: string;
    bot?: string;
    workingDirectory: string;
    triggerMode?: string;
    threadedReplies?: boolean;
  }>;
  defaults?: ConfigDefaults;
}

export function buildConfig(opts: {
  mmUrl?: string;
  bots: BotEntry[];
  channels: ChannelEntry[];
  defaults?: ConfigDefaults;
  slackBots?: BotEntry[];
}): GeneratedConfig {
  const config: GeneratedConfig = {
    platforms: {},
    channels: [],
  };

  // Mattermost platform
  if (opts.mmUrl && opts.bots.length > 0) {
    config.platforms.mattermost = { url: opts.mmUrl };
    config.platforms.mattermost.bots = {};
    for (const bot of opts.bots) {
      config.platforms.mattermost.bots[bot.name] = {
        token: bot.token,
        ...(bot.admin ? { admin: true } : {}),
        ...(bot.agent ? { agent: bot.agent } : {}),
      };
    }
  }

  // Slack platform
  if (opts.slackBots && opts.slackBots.length > 0) {
    config.platforms.slack = { bots: {} };
    for (const bot of opts.slackBots) {
      if (!bot.appToken) {
        throw new Error(`Slack bot "${bot.name}" is missing required appToken`);
      }
      config.platforms.slack!.bots![bot.name] = {
        token: bot.token,
        appToken: bot.appToken,
        ...(bot.admin ? { admin: true } : {}),
        ...(bot.agent ? { agent: bot.agent } : {}),
      };
    }
  }

  for (const ch of opts.channels) {
    config.channels.push({
      id: ch.id,
      ...(ch.name ? { name: ch.name } : {}),
      platform: ch.platform,
      bot: ch.bot,
      workingDirectory: ch.workingDirectory,
      ...(ch.triggerMode ? { triggerMode: ch.triggerMode } : {}),
      ...(ch.threadedReplies !== undefined ? { threadedReplies: ch.threadedReplies } : {}),
    });
  }

  if (opts.defaults) {
    config.defaults = {};
    if (opts.defaults.model) config.defaults.model = opts.defaults.model;
    if (opts.defaults.triggerMode) config.defaults.triggerMode = opts.defaults.triggerMode;
    if (opts.defaults.threadedReplies !== undefined) config.defaults.threadedReplies = opts.defaults.threadedReplies;
    if (opts.defaults.verbose !== undefined) config.defaults.verbose = opts.defaults.verbose;
  }

  return config;
}

export function getConfigDir(): string {
  return path.join(os.homedir(), '.copilot-bridge');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

export function writeConfig(config: GeneratedConfig): string {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const configPath = getConfigPath();

  // Back up existing config before overwriting
  if (fs.existsSync(configPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = `${configPath}.${timestamp}.bak`;
    fs.copyFileSync(configPath, backupPath);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return configPath;
}

export function readExistingConfig(): GeneratedConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Merge a new platform's config into an existing config.
 * Preserves all existing platforms, channels, and defaults.
 */
export function mergeConfig(existing: GeneratedConfig, addition: GeneratedConfig): GeneratedConfig {
  const merged: GeneratedConfig = {
    platforms: { ...existing.platforms },
    channels: [...(existing.channels ?? [])],
    defaults: existing.defaults ?? addition.defaults,
  };

  // Merge new platforms (don't overwrite existing ones)
  for (const [name, config] of Object.entries(addition.platforms)) {
    if (!merged.platforms[name as keyof typeof merged.platforms]) {
      (merged.platforms as any)[name] = config;
    }
  }

  // Append new channels (skip duplicates by id)
  const existingIds = new Set(merged.channels.map(c => c.id));
  for (const ch of addition.channels ?? []) {
    if (!existingIds.has(ch.id)) {
      merged.channels.push(ch);
    }
  }

  return merged;
}
