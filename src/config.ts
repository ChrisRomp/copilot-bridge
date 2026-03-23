import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, ChannelConfig, BotConfig, PermissionsConfig, InterAgentConfig, AccessConfig, BridgeProviderConfig } from './types.js';
import type { SDKProviderConfig } from './core/bridge.js';
import { getDynamicChannel } from './state/store.js';
import { createLogger } from './logger.js';

const log = createLogger('config');

const VALID_ACCESS_MODES = ['allowlist', 'blocklist', 'open'];

/** Validate an access config block. Throws on invalid input. Normalizes entries in-place. */
function validateAccessConfig(platformName: string, label: string, access: any): void {
  if (access === undefined) return;
  if (access === null || typeof access !== 'object') throw new Error(`${platformName}:${label} access must be an object`);
  if (!VALID_ACCESS_MODES.includes(access.mode)) {
    throw new Error(`${platformName}:${label} access.mode must be one of: ${VALID_ACCESS_MODES.join(', ')}`);
  }
  if (access.users !== undefined) {
    if (!Array.isArray(access.users)) throw new Error(`${platformName}:${label} access.users must be an array`);
    for (let i = 0; i < access.users.length; i++) {
      const u = access.users[i];
      if (typeof u !== 'string' || u.trim().length === 0) {
        throw new Error(`${platformName}:${label} access.users entries must be non-empty strings`);
      }
      // Normalize: strip leading @ and whitespace
      access.users[i] = u.trim().replace(/^@/, '');
    }
  }
}

let _config: AppConfig | null = null;
let _configPath: string | null = null;

// Dynamic channels registered at runtime (DMs, onboarded projects).
// Kept separate from _config so they survive reloads.
const _dynamicChannels = new Map<string, ChannelConfig>();

/** Validate raw config JSON and normalize into an AppConfig. Throws on invalid input. */
function validateAndNormalize(raw: any): AppConfig {
  // Validate platforms
  if (!raw.platforms || typeof raw.platforms !== 'object') {
    throw new Error('Config must have a "platforms" object');
  }
  for (const [name, platform] of Object.entries(raw.platforms)) {
    const p = platform as any;
    if (name === 'slack') {
      // Slack uses Socket Mode — no URL needed
      if (!p.bots) throw new Error('Platform "slack" requires "bots" with bot tokens');
      validateAccessConfig(name, '(platform)', p.access);
      for (const [botName, bot] of Object.entries(p.bots)) {
        if (!(bot as any).token) throw new Error(`Platform "slack" bot "${botName}" missing "token"`);
        if (!(bot as any).appToken) throw new Error(`Platform "slack" bot "${botName}" missing "appToken" (required for Socket Mode)`);
        validateAccessConfig(name, botName, (bot as any).access);
      }
    } else {
      if (!p.url) throw new Error(`Platform "${name}" missing "url"`);
      if (!p.botToken && !p.bots) throw new Error(`Platform "${name}" needs either "botToken" or "bots"`);
      validateAccessConfig(name, '(platform)', p.access);
      if (p.bots) {
        for (const [botName, bot] of Object.entries(p.bots)) {
          if (!(bot as any).token) throw new Error(`Platform "${name}" bot "${botName}" missing "token"`);
          validateAccessConfig(name, botName, (bot as any).access);
        }
      }
    }
  }

  // Validate channels (empty is allowed — DMs are auto-discovered)
  if (!Array.isArray(raw.channels)) {
    raw.channels = [];
  }
  for (const ch of raw.channels) {
    if (!ch.id) throw new Error('Each channel must have an "id"');
    if (!ch.platform) throw new Error(`Channel "${ch.id}" missing "platform"`);
    if (!ch.workingDirectory) throw new Error(`Channel "${ch.id}" missing "workingDirectory"`);
    if (!raw.platforms[ch.platform]) {
      throw new Error(`Channel "${ch.id}" references unknown platform "${ch.platform}"`);
    }
    const plat = raw.platforms[ch.platform];
    if (ch.bot && plat.bots && !plat.bots[ch.bot]) {
      throw new Error(`Channel "${ch.id}" references unknown bot "${ch.bot}" (available: ${Object.keys(plat.bots).join(', ')})`);
    }
    if (!fs.existsSync(ch.workingDirectory)) {
      console.warn(`Warning: workingDirectory "${ch.workingDirectory}" for channel "${ch.id}" does not exist`);
    }
  }

  // Validate interAgent config (optional)
  if (raw.interAgent) {
    const ia = raw.interAgent;
    if (typeof ia.enabled !== 'boolean') {
      throw new Error('interAgent.enabled must be a boolean');
    }
    if (ia.defaultTimeout !== undefined && (typeof ia.defaultTimeout !== 'number' || ia.defaultTimeout <= 0)) {
      throw new Error('interAgent.defaultTimeout must be a positive number');
    }
    if (ia.maxTimeout !== undefined && (typeof ia.maxTimeout !== 'number' || ia.maxTimeout <= 0)) {
      throw new Error('interAgent.maxTimeout must be a positive number');
    }
    if (ia.maxDepth !== undefined && (typeof ia.maxDepth !== 'number' || ia.maxDepth < 1 || !Number.isInteger(ia.maxDepth))) {
      throw new Error('interAgent.maxDepth must be a positive integer');
    }
    if (ia.allow) {
      if (typeof ia.allow !== 'object' || Array.isArray(ia.allow)) {
        throw new Error('interAgent.allow must be an object mapping bot names to permissions');
      }
      for (const [botName, perms] of Object.entries(ia.allow)) {
        const p = perms as any;
        if (p.canCall && !Array.isArray(p.canCall)) {
          throw new Error(`interAgent.allow.${botName}.canCall must be an array`);
        }
        if (p.canBeCalledBy && !Array.isArray(p.canBeCalledBy)) {
          throw new Error(`interAgent.allow.${botName}.canBeCalledBy must be an array`);
        }
      }
    }
  }

  // Validate providers (optional BYOK config)
  const validProviderTypes = ['openai', 'azure', 'anthropic'];
  if (raw.providers !== undefined) {
    if (raw.providers === null || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
      throw new Error('"providers" must be an object mapping provider names to configs');
    }
    for (const [provName, provRaw] of Object.entries(raw.providers)) {
      if (!provName || /[:\s]/.test(provName)) {
        throw new Error(`Provider name "${provName}" is invalid — must be non-empty and cannot contain ':' or whitespace`);
      }
      const p = provRaw as any;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error(`Provider "${provName}" must be an object`);
      }
      if (p.type !== undefined && !validProviderTypes.includes(p.type)) {
        throw new Error(`Provider "${provName}" type must be one of: ${validProviderTypes.join(', ')}`);
      }
      if (!p.baseUrl || typeof p.baseUrl !== 'string') {
        throw new Error(`Provider "${provName}" requires a "baseUrl" string`);
      }
      if (!Array.isArray(p.models) || p.models.length === 0) {
        throw new Error(`Provider "${provName}" requires a non-empty "models" array`);
      }
      for (const m of p.models) {
        if (!m || typeof m !== 'object' || !m.id || typeof m.id !== 'string') {
          throw new Error(`Provider "${provName}" models entries must have a string "id"`);
        }
        if (m.contextWindow !== undefined && (typeof m.contextWindow !== 'number' || m.contextWindow <= 0 || !Number.isInteger(m.contextWindow))) {
          throw new Error(`Provider "${provName}" model "${m.id}" contextWindow must be a positive integer`);
        }
      }
      // Validate optional string fields
      for (const field of ['apiKey', 'apiKeyEnv', 'bearerToken', 'bearerTokenEnv'] as const) {
        if (p[field] !== undefined && typeof p[field] !== 'string') {
          throw new Error(`Provider "${provName}" ${field} must be a string`);
        }
      }
      if (p.azure !== undefined) {
        if (typeof p.azure !== 'object' || Array.isArray(p.azure)) {
          throw new Error(`Provider "${provName}" azure must be an object`);
        }
        if (p.azure.apiVersion !== undefined && typeof p.azure.apiVersion !== 'string') {
          throw new Error(`Provider "${provName}" azure.apiVersion must be a string`);
        }
      }
      if (p.apiKey && typeof p.apiKey === 'string') {
        log.warn(`Provider "${provName}": inline apiKey is discouraged — use apiKeyEnv instead`);
      }
      if (p.bearerToken && typeof p.bearerToken === 'string') {
        log.warn(`Provider "${provName}": inline bearerToken is discouraged — use bearerTokenEnv instead`);
      }
      if (p.wireApi !== undefined && !['completions', 'responses'].includes(p.wireApi)) {
        throw new Error(`Provider "${provName}" wireApi must be "completions" or "responses"`);
      }
    }
  }

  // Validate logLevel (optional)
  if (raw.logLevel !== undefined) {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLevels.includes(raw.logLevel)) {
      throw new Error(`logLevel must be one of: ${validLevels.join(', ')}`);
    }
  }

  // Apply defaults
  const defaults = {
    model: 'claude-sonnet-4.6',
    agent: null,
    triggerMode: 'mention' as const,
    threadedReplies: true,
    verbose: false,
    permissionMode: 'interactive' as const,
    ...raw.defaults,
  };

  return {
    platforms: raw.platforms,
    channels: raw.channels,
    defaults,
    logLevel: raw.logLevel,
    infiniteSessions: raw.infiniteSessions === true,
    permissions: raw.permissions,
    interAgent: raw.interAgent,
    providers: raw.providers,
  };
}

/**
 * Resolve a BridgeProviderConfig into the SDK's ProviderConfig format.
 * Resolves apiKeyEnv/bearerTokenEnv from process.env.
 * Returns null if the provider name is not found in config.
 */
export function resolveProviderConfig(
  providerName: string,
  providers?: Record<string, BridgeProviderConfig>,
): SDKProviderConfig | null {
  if (!providers) return null;
  const entry = providers[providerName];
  if (!entry) return null;

  // Resolve API key
  let apiKey = entry.apiKey;
  if (!apiKey && entry.apiKeyEnv) {
    apiKey = process.env[entry.apiKeyEnv];
    if (!apiKey) {
      log.warn(`Provider "${providerName}": env var ${entry.apiKeyEnv} is not set`);
    }
  }

  // Resolve bearer token
  let bearerToken = entry.bearerToken;
  if (!bearerToken && entry.bearerTokenEnv) {
    bearerToken = process.env[entry.bearerTokenEnv];
    if (!bearerToken) {
      log.warn(`Provider "${providerName}": env var ${entry.bearerTokenEnv} is not set`);
    }
  }

  const sdkConfig: SDKProviderConfig = {
    baseUrl: entry.baseUrl,
    ...(entry.type ? { type: entry.type } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    ...(entry.wireApi ? { wireApi: entry.wireApi } : {}),
    ...(entry.azure ? { azure: entry.azure } : {}),
  };

  return sdkConfig;
}

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath
    ?? process.env.COPILOT_BRIDGE_CONFIG
    ?? (fs.existsSync(path.join(os.homedir(), '.copilot-bridge', 'config.json'))
        ? path.join(os.homedir(), '.copilot-bridge', 'config.json')
        : path.join(process.cwd(), 'config.json'));

  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}. Copy config.sample.json to config.json and edit it.`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  _config = validateAndNormalize(raw);
  _configPath = filePath;
  return _config;
}

/** The resolved config file path (available after loadConfig). */
export function getConfigPath(): string | null {
  return _configPath;
}

/** Result of a config reload attempt. */
export interface ReloadResult {
  success: boolean;
  error?: string;
  changes: string[];
  restartNeeded: string[];
}

/**
 * Diff two config objects and return human-readable change descriptions.
 * Also flags fields that require a restart to take effect.
 */
function diffConfigs(oldCfg: AppConfig, newCfg: AppConfig): { changes: string[]; restartNeeded: string[] } {
  const changes: string[] = [];
  const restartNeeded: string[] = [];

  // --- Defaults ---
  for (const key of Object.keys({ ...oldCfg.defaults, ...newCfg.defaults }) as Array<keyof AppConfig['defaults']>) {
    const ov = (oldCfg.defaults as any)[key];
    const nv = (newCfg.defaults as any)[key];
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      changes.push(`defaults.${key}: ${JSON.stringify(ov)} → ${JSON.stringify(nv)}`);
    }
  }

  // --- Permissions ---
  if (JSON.stringify(oldCfg.permissions ?? {}) !== JSON.stringify(newCfg.permissions ?? {})) {
    changes.push('permissions updated');
  }

  // --- Inter-Agent ---
  if (JSON.stringify(oldCfg.interAgent ?? {}) !== JSON.stringify(newCfg.interAgent ?? {})) {
    changes.push('interAgent config updated');
  }

  // --- Providers (BYOK) ---
  const oldProviders = oldCfg.providers ?? {};
  const newProviders = newCfg.providers ?? {};
  for (const name of new Set([...Object.keys(oldProviders), ...Object.keys(newProviders)])) {
    const op = oldProviders[name];
    const np = newProviders[name];
    if (!op && np) {
      changes.push(`provider "${name}": added`);
    } else if (op && !np) {
      changes.push(`provider "${name}": removed`);
    } else if (JSON.stringify(op) !== JSON.stringify(np)) {
      changes.push(`provider "${name}": config updated`);
    }
  }

  // --- Channels ---
  const oldChannelMap = new Map(oldCfg.channels.filter(c => !_dynamicChannels.has(c.id)).map(c => [c.id, c]));
  const newChannelMap = new Map(newCfg.channels.map(c => [c.id, c]));

  for (const [id, newCh] of newChannelMap) {
    const oldCh = oldChannelMap.get(id);
    if (!oldCh) {
      changes.push(`channel "${id}": added`);
    } else if (JSON.stringify(oldCh) !== JSON.stringify(newCh)) {
      // Identify which fields changed
      const changedFields: string[] = [];
      for (const key of new Set([...Object.keys(oldCh), ...Object.keys(newCh)])) {
        if (JSON.stringify((oldCh as any)[key]) !== JSON.stringify((newCh as any)[key])) {
          changedFields.push(key);
        }
      }
      changes.push(`channel "${id}": ${changedFields.join(', ')} changed`);
    }
  }
  for (const id of oldChannelMap.keys()) {
    if (!newChannelMap.has(id)) {
      changes.push(`channel "${id}": removed from config (still active in-memory)`);
    }
  }

  // --- Platforms (check for restart-needed changes) ---
  for (const [name, newPlat] of Object.entries(newCfg.platforms)) {
    const oldPlat = oldCfg.platforms[name];
    if (!oldPlat) {
      restartNeeded.push(`platform "${name}": added (new adapter + WebSocket needed)`);
      continue;
    }
    if (oldPlat.url !== newPlat.url) {
      restartNeeded.push(`platform "${name}": URL changed (adapter caches URL at startup)`);
    }
    if (oldPlat.botToken !== newPlat.botToken) {
      restartNeeded.push(`platform "${name}": botToken changed`);
    }
    // Check individual bots
    const oldBots = oldPlat.bots ?? {};
    const newBots = newPlat.bots ?? {};
    for (const [bName, newBot] of Object.entries(newBots)) {
      const oldBot = oldBots[bName];
      if (!oldBot) {
        restartNeeded.push(`bot "${name}:${bName}": added (new adapter needed)`);
      } else if ((oldBot as BotConfig).token !== (newBot as BotConfig).token) {
        restartNeeded.push(`bot "${name}:${bName}": token changed`);
      } else if ((oldBot as BotConfig).appToken !== (newBot as BotConfig).appToken) {
        restartNeeded.push(`bot "${name}:${bName}": appToken changed`);
      } else {
        // Non-token bot fields are hot-reloadable (agent, admin)
        if (JSON.stringify(oldBot) !== JSON.stringify(newBot)) {
          changes.push(`bot "${name}:${bName}": config updated`);
        }
      }
    }
    for (const bName of Object.keys(oldBots)) {
      if (!newBots[bName]) {
        restartNeeded.push(`bot "${name}:${bName}": removed (adapter still running)`);
      }
    }
  }
  for (const name of Object.keys(oldCfg.platforms)) {
    if (!newCfg.platforms[name]) {
      restartNeeded.push(`platform "${name}": removed (adapter still running)`);
    }
  }

  return { changes, restartNeeded };
}

/**
 * Re-read config from disk, validate, diff, and apply.
 * On failure, keeps existing config and returns the error.
 * Dynamic channels are preserved across reloads.
 */
export function reloadConfig(): ReloadResult {
  if (!_configPath) {
    return { success: false, error: 'No config path — loadConfig() not called', changes: [], restartNeeded: [] };
  }
  if (!_config) {
    return { success: false, error: 'No existing config to reload', changes: [], restartNeeded: [] };
  }

  let raw: any;
  try {
    const text = fs.readFileSync(_configPath, 'utf-8');
    raw = JSON.parse(text);
  } catch (err: any) {
    return { success: false, error: `Failed to read config: ${err.message}`, changes: [], restartNeeded: [] };
  }

  let newConfig: AppConfig;
  try {
    newConfig = validateAndNormalize(raw);
  } catch (err: any) {
    return { success: false, error: `Validation failed: ${err.message}`, changes: [], restartNeeded: [] };
  }

  const { changes, restartNeeded } = diffConfigs(_config, newConfig);

  // Preserve channels that were removed from config but have no replacement
  // (grace period: they stay in-memory until sessions end)
  const removedStaticIds: string[] = [];
  for (const oldCh of _config.channels) {
    if (_dynamicChannels.has(oldCh.id)) continue; // dynamic, handled separately
    if (!newConfig.channels.some(c => c.id === oldCh.id)) {
      removedStaticIds.push(oldCh.id);
      newConfig.channels.push(oldCh); // keep in-memory
    }
  }

  // Merge dynamic channels back in (prune any now covered by static config)
  for (const [id, ch] of _dynamicChannels) {
    if (newConfig.channels.some(c => c.id === id)) {
      _dynamicChannels.delete(id); // static config now covers this channel
    } else {
      newConfig.channels.push(ch);
    }
  }

  _config = newConfig;

  return { success: true, changes, restartNeeded };
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function getInterAgentConfig(): InterAgentConfig {
  const config = getConfig();
  return config.interAgent ?? { enabled: false };
}

export function getChannelConfig(channelId: string): ChannelConfig & { permissionMode: string } {
  const config = getConfig();
  let channel = config.channels.find(c => c.id === channelId);

  // Fall back to dynamic channels from SQLite
  if (!channel) {
    const dyn = getDynamicChannel(channelId);
    if (dyn) {
      channel = {
        id: dyn.channelId,
        platform: dyn.platform,
        name: dyn.name,
        workingDirectory: dyn.workingDirectory,
        bot: dyn.bot,
        agent: dyn.agent,
        model: dyn.model,
        triggerMode: dyn.triggerMode ?? config.defaults.triggerMode,
        threadedReplies: dyn.threadedReplies ?? config.defaults.threadedReplies,
        verbose: dyn.verbose ?? config.defaults.verbose,
        isDM: dyn.isDM,
      };
    }
  }

  if (!channel) throw new Error(`No config found for channel "${channelId}"`);
  
  // Resolve agent: channel-level overrides bot-level default
  const botConfig = getChannelBotConfig(channelId);
  const resolvedAgent = channel.agent !== undefined ? channel.agent
    : botConfig?.agent !== undefined ? botConfig.agent
    : config.defaults.agent;

  return {
    ...channel,
    model: channel.model ?? config.defaults.model,
    agent: resolvedAgent,
    triggerMode: channel.triggerMode ?? config.defaults.triggerMode,
    threadedReplies: channel.threadedReplies ?? config.defaults.threadedReplies,
    verbose: channel.verbose ?? config.defaults.verbose,
    permissionMode: config.defaults.permissionMode,
  };
}

/** Check if a channel ID is in our configured channels list (static or dynamic) */
export function isConfiguredChannel(channelId: string): boolean {
  const config = getConfig();
  if (config.channels.some(c => c.id === channelId)) return true;
  return getDynamicChannel(channelId) !== null;
}

/**
 * Dynamically register a channel at runtime (not persisted to config.json).
 * Used for auto-discovered DM channels with bots.
 * Stored separately from static config so they survive reloads.
 */
export function registerDynamicChannel(channel: ChannelConfig): void {
  const config = getConfig();
  if (config.channels.some(c => c.id === channel.id)) return; // already in static config
  _dynamicChannels.set(channel.id, channel);
  config.channels.push(channel);
}

/** Mark an existing channel as a DM (mutates the source config object and dynamic store). */
export function markChannelAsDM(channelId: string): void {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (channel) channel.isDM = true;
  const dyn = _dynamicChannels.get(channelId);
  if (dyn) dyn.isDM = true;
}

/**
 * Get the resolved bot token for a channel.
 * Supports both single-bot (botToken) and multi-bot (bots map) configs.
 */
export function getChannelBotToken(channelId: string): string {
  const config = getConfig();
  let channel: { platform: string; bot?: string } | undefined = config.channels.find(c => c.id === channelId);

  // Fall back to dynamic channels
  if (!channel) {
    const dyn = getDynamicChannel(channelId);
    if (dyn) channel = { platform: dyn.platform, bot: dyn.bot };
  }

  if (!channel) throw new Error(`No config found for channel "${channelId}"`);

  const platform = config.platforms[channel.platform];
  if (!platform) throw new Error(`Channel "${channelId}" references unknown platform "${channel.platform}"`);
  if (channel.bot && platform.bots?.[channel.bot]) {
    return platform.bots[channel.bot].token;
  }
  if (platform.botToken) return platform.botToken;
  if (platform.bots) {
    const first = Object.values(platform.bots)[0];
    if (first) return first.token;
  }
  throw new Error(`No bot token resolved for channel "${channelId}"`);
}

/** Get the BotConfig for a channel (if multi-bot). */
export function getChannelBotConfig(channelId: string): BotConfig | null {
  const config = getConfig();
  let channel: { platform: string; bot?: string } | undefined = config.channels.find(c => c.id === channelId);

  if (!channel) {
    const dyn = getDynamicChannel(channelId);
    if (dyn) channel = { platform: dyn.platform, bot: dyn.bot };
  }

  if (!channel) return null;
  const platform = config.platforms[channel.platform];
  if (!platform) return null;
  if (channel.bot && platform.bots?.[channel.bot]) {
    return platform.bots[channel.bot];
  }
  return null;
}

/**
 * Get all unique bot tokens for a platform, keyed by bot name.
 * For single-bot configs, returns { "default": token }.
 */
export function getPlatformBots(platformName: string): Map<string, { token: string; appToken?: string; agent?: string | null; access?: AccessConfig }> {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (!platform) throw new Error(`Unknown platform "${platformName}"`);

  const bots = new Map<string, { token: string; appToken?: string; agent?: string | null; access?: AccessConfig }>();
  if (platform.bots) {
    for (const [name, bot] of Object.entries(platform.bots)) {
      bots.set(name, { token: bot.token, appToken: bot.appToken, agent: bot.agent, access: bot.access });
    }
  } else if (platform.botToken) {
    bots.set('default', { token: platform.botToken });
  }
  return bots;
}

/** Get platform-level access config (if any). */
export function getPlatformAccess(platformName: string): AccessConfig | undefined {
  const config = getConfig();
  return config.platforms[platformName]?.access;
}

/** Check if a bot is an admin. */
export function isBotAdmin(platformName: string, botName: string): boolean {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (!platform?.bots) return false;
  return !!(platform.bots[botName] as BotConfig)?.admin;
}

/** Check if a bot name is admin on any platform. */
export function isBotAdminAny(botName: string): boolean {
  const config = getConfig();
  for (const platform of Object.values(config.platforms)) {
    if (platform.bots && (platform.bots[botName] as BotConfig)?.admin) return true;
  }
  return false;
}

/** Get the admin bot name for a platform, if any. */
export function getAdminBotName(platformName: string): string | null {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (!platform?.bots) return null;
  for (const [name, bot] of Object.entries(platform.bots)) {
    if ((bot as BotConfig).admin) return name;
  }
  return null;
}

/** Get the bot name a channel uses. */
export function getChannelBotName(channelId: string): string {
  const config = getConfig();
  let channel: { platform: string; bot?: string } | undefined = config.channels.find(c => c.id === channelId);

  if (!channel) {
    const dyn = getDynamicChannel(channelId);
    if (dyn) channel = { platform: dyn.platform, bot: dyn.bot };
  }

  if (!channel) return 'default';
  if (channel.bot) return channel.bot;
  const platform = config.platforms[channel.platform];
  if (platform?.bots) return Object.keys(platform.bots)[0] ?? 'default';
  return 'default';
}

/**
 * Parse a CLI-compatible permission spec.
 * Examples: "shell(ls)", "shell(git status)", "shell", "write", "read",
 *           "workiq(calendar_list)", "workiq", "url(github.com)"
 * Returns { kind, tool? } where tool is the parenthesized part.
 */
function parsePermissionSpec(spec: string): { kind: string; tool?: string } {
  const match = spec.match(/^([^(]+?)(?:\((.+)\))?$/);
  if (!match) return { kind: spec };
  return { kind: match[1].trim(), tool: match[2]?.trim() };
}

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'env', 'sudo', 'nohup', 'xargs', 'exec', 'eval']);

/** Strip shell wrappers, absolute paths, and subshell flags to find the real command. */
function unwrapShellCommand(cmd: string): string {
  // Handle bash/sh -c "..." — extract the quoted payload (with optional sudo/env prefix)
  const dashCMatch = cmd.match(/(?:^|\s)(?:(?:sudo|env)\s+)*(?:bash|sh|zsh|dash)\s+-c\s+["'](.+?)["']\s*$/);
  if (dashCMatch) {
    return unwrapShellCommand(dashCMatch[1]);
  }

  let parts = cmd.trim().split(/\s+/);
  // Strip wrappers from front (sudo rm -rf / → rm -rf /)
  while (parts.length > 0) {
    let word = parts[0];
    // Strip absolute path prefix: /usr/bin/rm → rm
    const base = word.includes('/') ? word.split('/').pop()! : word;
    if (SHELL_WRAPPERS.has(base)) {
      parts.shift();
      if (base === 'env') {
        // Skip env assignments (FOO=bar) and flags
        while (parts.length > 0 && (parts[0].startsWith('-') || /^[A-Z_]+=/.test(parts[0]))) parts.shift();
      } else if (base === 'sudo') {
        // Skip sudo flags and their arguments (-u root, -g group, -C fd, etc.)
        const sudoFlagsWithArg = new Set(['-u', '-g', '-C', '-D', '-R', '-T', '--user', '--group']);
        while (parts.length > 0 && parts[0].startsWith('-')) {
          const flag = parts.shift()!;
          if (sudoFlagsWithArg.has(flag) && parts.length > 0) parts.shift(); // skip arg
        }
      } else {
        // Generic wrapper: skip flags
        while (parts.length > 0 && parts[0].startsWith('-')) parts.shift();
      }
      continue;
    }
    // Rewrite absolute path to basename for the first real command
    if (word.includes('/')) {
      parts[0] = base;
    }
    break;
  }
  return parts.join(' ');
}

/**
 * Hardcoded safety rules — defined as data so both enforcement (isHardDeny)
 * and display (getHardcodedRules) derive from a single source of truth.
 */
interface HardcodedRule {
  /** Human-readable spec for /rules display */
  spec: string;
  /** Test function: returns true if the command matches this rule */
  test: (effectiveCmd: string, effectiveShellCmd: string, originalCmd: string) => boolean;
}

const HARDCODED_DENY_RULES: HardcodedRule[] = [
  {
    spec: 'shell(launchctl unload)',
    test: (eff, shellCmd, orig) => (shellCmd === 'launchctl' || orig.trim().split(/\s+/)[0] === 'launchctl') && /\bunload\b/.test(orig),
  },
  {
    spec: 'shell(rm -rf /)',
    test: (eff, shellCmd) => {
      if (shellCmd !== 'rm') return false;
      const hasRecursive = /\s-[^\s]*r|\s--recursive/.test(eff);
      const hasForce = /\s-[^\s]*f|\s--force/.test(eff);
      return hasRecursive && hasForce && (/\s+\/(\s|$)/.test(eff) || /\s+\/\*(\s|$)/.test(eff));
    },
  },
  {
    spec: 'shell(rm -rf ~)',
    test: (eff, shellCmd) => {
      if (shellCmd !== 'rm') return false;
      const hasRecursive = /\s-[^\s]*r|\s--recursive/.test(eff);
      const hasForce = /\s-[^\s]*f|\s--force/.test(eff);
      return hasRecursive && hasForce && (/\s+~(\s|$)/.test(eff) || /\$HOME(\s|$)/.test(eff));
    },
  },
  {
    spec: 'shell(mkfs)',
    test: (_eff, shellCmd) => shellCmd === 'mkfs' || /^mkfs\./.test(shellCmd),
  },
  {
    spec: 'shell(dd … of=/dev/*)',
    test: (eff, shellCmd) => shellCmd === 'dd' && /of=\/dev\//.test(eff),
  },
  {
    spec: 'shell(:(){ :|:& };:)',
    test: (_eff, _shellCmd, orig) => /:\(\)\s*\{.*:\|:.*&.*\}\s*;?\s*:/.test(orig),
  },
  {
    spec: 'shell(chmod -R / /etc /usr /var ~)',
    test: (eff, shellCmd) => shellCmd === 'chmod' && /\s-[^\s]*R/.test(eff) &&
      (/\s+\/(\s|$)/.test(eff) || /\s+\/etc(\s|\/|$)/.test(eff) ||
       /\s+\/usr(\s|\/|$)/.test(eff) || /\s+\/var(\s|\/|$)/.test(eff) ||
       /\s+~(\s|$)/.test(eff) || /\$HOME(\s|$)/.test(eff)),
  },
  {
    spec: 'shell(chown -R / /etc /usr /var ~)',
    test: (eff, shellCmd) => shellCmd === 'chown' && /\s-[^\s]*R/.test(eff) &&
      (/\s+\/(\s|$)/.test(eff) || /\s+\/etc(\s|\/|$)/.test(eff) ||
       /\s+\/usr(\s|\/|$)/.test(eff) || /\s+\/var(\s|\/|$)/.test(eff) ||
       /\s+~(\s|$)/.test(eff) || /\$HOME(\s|$)/.test(eff)),
  },
];

/**
 * Hardcoded safety denies — cannot be overridden by config or stored rules.
 * These prevent destructive commands that should never run in any context.
 */
export function isHardDeny(kind: string, command: string | undefined): boolean {
  if (kind !== 'shell' || !command) return false;
  const cmd = command.trim();
  const unwrapped = unwrapShellCommand(cmd);
  const realCmd = unwrapped.split(/\s+/)[0];

  return HARDCODED_DENY_RULES.some(rule => rule.test(unwrapped, realCmd, cmd));
}

/** Built-in safety rules surfaced by /remember list — derived from HARDCODED_DENY_RULES. */
export function getHardcodedRules(): Array<{ spec: string; action: 'allow' | 'deny'; source: 'hardcoded' }> {
  return HARDCODED_DENY_RULES.map(rule => ({ spec: rule.spec, action: 'deny' as const, source: 'hardcoded' as const }));
}

/** Config-level rules surfaced by /remember list. */
export function getConfigRules(): Array<{ spec: string; action: 'allow' | 'deny'; source: 'config' }> {
  const config = getConfig();
  const perms = config.permissions;
  const rules: Array<{ spec: string; action: 'allow' | 'deny'; source: 'config' }> = [];
  if (perms?.deny) {
    for (const spec of perms.deny) rules.push({ spec, action: 'deny', source: 'config' });
  }
  if (perms?.allow) {
    for (const spec of perms.allow) rules.push({ spec, action: 'allow', source: 'config' });
  }
  if (perms?.allowPaths) {
    for (const p of perms.allowPaths) rules.push({ spec: `path: ${p}`, action: 'allow', source: 'config' });
  }
  if (perms?.allowUrls) {
    for (const u of perms.allowUrls) rules.push({ spec: `url: ${u}`, action: 'allow', source: 'config' });
  }
  return rules;
}
/**
 * Evaluate config-level permission rules against a permission request.
 * Uses CLI-compatible syntax: shell(cmd), write, read, MCP_SERVER(tool), etc.
 * 
 * @returns 'allow' | 'deny' | null (null = no rule matched, ask user)
 */
export function evaluateConfigPermissions(
  request: { kind: string; [key: string]: unknown },
  channelWorkingDirectory: string,
  workspaceAllowPaths?: string[],
  isAdmin?: boolean,
): 'allow' | 'deny' | null {
  const config = getConfig();
  const perms = config.permissions;

  const kind = request.kind;
  const command = typeof request.fullCommandText === 'string' ? request.fullCommandText
    : typeof request.command === 'string' ? request.command : undefined;
  const requestPath = typeof request.path === 'string' ? request.path
    : typeof request.fileName === 'string' ? request.fileName : undefined;
  const serverName = typeof request.serverName === 'string' ? request.serverName : undefined;
  const toolName = typeof request.toolName === 'string' ? request.toolName : undefined;
  const url = typeof request.url === 'string' ? request.url : undefined;

  const shellCmd = command ? command.trim().split(/\s+/)[0] : undefined;
  const shellCmdFull = command ? (() => {
    const parts = command.trim().split(/\s+/);
    if ((parts[0] === 'git' || parts[0] === 'gh') && parts.length > 1) {
      return `${parts[0]} ${parts[1]}`;
    }
    return parts[0];
  })() : undefined;

  // Hardcoded safety denies — cannot be overridden
  if (isHardDeny(kind, command)) {
    return 'deny';
  }

  // Check config deny rules (deny takes precedence over allow)
  if (perms?.deny) {
    for (const spec of perms.deny) {
      const parsed = parsePermissionSpec(spec);
      if (matchesRule(parsed, kind, shellCmd, shellCmdFull, command, serverName, toolName)) {
        return 'deny';
      }
    }
  }

  // Check config allow rules
  if (perms?.allow) {
    for (const spec of perms.allow) {
      const parsed = parsePermissionSpec(spec);
      if (matchesRule(parsed, kind, shellCmd, shellCmdFull, command, serverName, toolName)) {
        return 'allow';
      }
    }
  }

  // Admin bots get additional shell commands for workspace/config management
  if (isAdmin && kind === 'shell' && shellCmd) {
    const adminShellAllow = ['cp', 'mkdir', 'curl', 'launchctl', 'mv', 'touch', 'chmod'];
    if (adminShellAllow.includes(shellCmd)) {
      return 'allow';
    }
  }

  // Auto-allow reads and writes within the workspace directory
  if ((kind === 'read' || kind === 'write') && requestPath) {
    const resolved = path.resolve(requestPath);
    const workspace = path.resolve(channelWorkingDirectory);
    if (resolved.startsWith(workspace + path.sep) || resolved === workspace) {
      return 'allow';
    }
    // Check workspace-level allowPaths (from SQLite override)
    if (workspaceAllowPaths) {
      for (const p of workspaceAllowPaths) {
        const allowed = path.resolve(p);
        if (resolved.startsWith(allowed + path.sep) || resolved === allowed) {
          return 'allow';
        }
      }
    }
    // Check config-level allowPaths
    if (perms?.allowPaths) {
      for (const p of perms.allowPaths) {
        const allowed = path.resolve(p);
        if (resolved.startsWith(allowed + path.sep) || resolved === allowed) {
          return 'allow';
        }
      }
    }
  }

  // If a read/write has a path that wasn't auto-allowed above, it's outside
  // the workspace boundaries — defer to the interactive approval flow so the
  // user can still approve one-off access via the messaging channel.
  if ((kind === 'read' || kind === 'write') && requestPath) {
    return null;
  }

  // Check URL permissions
  if (kind === 'url' && url && perms?.allowUrls) {
    try {
      const hostname = new URL(url).hostname;
      if (perms.allowUrls.some(d => hostname === d || hostname.endsWith('.' + d))) {
        return 'allow';
      }
    } catch { /* invalid URL, don't auto-allow */ }
  }

  return null;
}

function matchesRule(
  parsed: { kind: string; tool?: string },
  requestKind: string,
  shellCmd: string | undefined,
  shellCmdFull: string | undefined,
  commandText: string | undefined,
  serverName: string | undefined,
  toolName: string | undefined,
): boolean {
  // Direct kind match: "shell", "read", "write"
  if (parsed.kind === requestKind) {
    if (!parsed.tool) return true; // bare kind matches all of that kind
    // For shell: match command name, subcommand, or command prefix
    if (requestKind === 'shell') {
      if (parsed.tool === shellCmd || parsed.tool === shellCmdFull) return true;
      // Prefix match: "open -a Obsidian" matches command "open -a Obsidian --vault foo"
      if (commandText) {
        const trimmed = commandText.trim();
        if (trimmed === parsed.tool || trimmed.startsWith(parsed.tool + ' ')) return true;
      }
      return false;
    }
    return false;
  }

  // MCP server match: spec like "workiq" or "workiq(calendar_list)"
  if (requestKind === 'mcp' && serverName) {
    if (parsed.kind === serverName) {
      if (!parsed.tool) return true; // bare server name matches all tools
      return parsed.tool === toolName;
    }
  }

  return false;
}

// --- Config Watcher ---

export type ConfigReloadHandler = (result: ReloadResult) => void;

/**
 * Watches config.json for changes and triggers hot-reload.
 * Follows the same pattern as WorkspaceWatcher: fs.watch + debounce.
 */
export class ConfigWatcher {
  private watcher: fs.FSWatcher | null = null;
  private handlers: ConfigReloadHandler[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs;
  }

  /** Start watching the config file. */
  start(): void {
    const configPath = getConfigPath();
    if (!configPath) {
      log.warn('Cannot start ConfigWatcher: no config path (loadConfig not called)');
      return;
    }
    if (this.watcher) return;

    // Watch the parent directory (not the file) because editors do atomic saves
    // (write temp + rename), which replaces the inode and kills file-level watchers.
    const dir = path.dirname(configPath);
    const filename = path.basename(configPath);

    log.info(`Watching ${dir} for changes to ${filename}`);
    this.watcher = fs.watch(dir, { persistent: false }, (_event, changedFile) => {
      if (!changedFile || String(changedFile) !== filename) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.handleChange(), this.debounceMs);
    });

    this.watcher.on('error', (err) => {
      log.error('ConfigWatcher error:', err);
    });
  }

  /** Stop watching. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Register a reload event handler. */
  onReload(handler: ConfigReloadHandler): void {
    this.handlers.push(handler);
  }

  private handleChange(): void {
    const result = reloadConfig();
    if (result.success) {
      if (result.changes.length || result.restartNeeded.length) {
        log.info(`Config reloaded: ${result.changes.length} change(s), ${result.restartNeeded.length} restart-needed`);
        for (const c of result.changes) log.info(`  ✓ ${c}`);
        for (const r of result.restartNeeded) log.warn(`  ⚠ ${r}`);
      } else {
        log.debug('Config file changed but no effective differences');
      }
    } else {
      log.error(`Config reload failed: ${result.error} — keeping existing config`);
    }
    for (const handler of this.handlers) {
      try { handler(result); } catch (err) { log.error('Reload handler error:', err); }
    }
  }
}

/**
 * Reset config state — for testing only.
 * @internal
 */
export function _resetConfigForTest(): void {
  _config = null;
  _configPath = null;
  _dynamicChannels.clear();
}
