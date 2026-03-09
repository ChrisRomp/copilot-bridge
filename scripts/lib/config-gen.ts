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
}

export interface ChannelEntry {
  id: string;
  name?: string;
  platform: string;
  bot: string;
  workingDirectory: string;
  triggerMode?: string;
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
    mattermost: {
      url: string;
      botToken?: string;
      bots?: Record<string, { token: string; admin?: boolean; agent?: string }>;
    };
  };
  channels: Array<{
    id: string;
    name?: string;
    platform: string;
    bot?: string;
    workingDirectory: string;
  }>;
  defaults?: ConfigDefaults;
}

export function buildConfig(opts: {
  mmUrl: string;
  bots: BotEntry[];
  channels: ChannelEntry[];
  defaults?: ConfigDefaults;
}): GeneratedConfig {
  const config: GeneratedConfig = {
    platforms: {
      mattermost: {
        url: opts.mmUrl,
      },
    },
    channels: [],
  };

  // Single bot → botToken; multiple → bots object
  if (opts.bots.length === 1) {
    config.platforms.mattermost.botToken = opts.bots[0].token;
  } else {
    config.platforms.mattermost.bots = {};
    for (const bot of opts.bots) {
      config.platforms.mattermost.bots[bot.name] = {
        token: bot.token,
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
      ...(opts.bots.length > 1 ? { bot: ch.bot } : {}),
      workingDirectory: ch.workingDirectory,
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
