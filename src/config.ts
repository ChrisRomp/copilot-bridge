import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, ChannelConfig, BotConfig, PermissionsConfig } from './types.js';
import { getDynamicChannel } from './state/store.js';

let _config: AppConfig | null = null;

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
  
  // Validate platforms
  if (!raw.platforms || typeof raw.platforms !== 'object') {
    throw new Error('Config must have a "platforms" object');
  }
  for (const [name, platform] of Object.entries(raw.platforms)) {
    const p = platform as any;
    if (!p.url) throw new Error(`Platform "${name}" missing "url"`);
    if (!p.botToken && !p.bots) throw new Error(`Platform "${name}" needs either "botToken" or "bots"`);
    if (p.bots) {
      for (const [botName, bot] of Object.entries(p.bots)) {
        if (!(bot as any).token) throw new Error(`Platform "${name}" bot "${botName}" missing "token"`);
      }
    }
  }
  
  // Validate channels
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error('Config must have at least one channel');
  }
  for (const ch of raw.channels) {
    if (!ch.id) throw new Error('Each channel must have an "id"');
    if (!ch.platform) throw new Error(`Channel "${ch.id}" missing "platform"`);
    if (!ch.workingDirectory) throw new Error(`Channel "${ch.id}" missing "workingDirectory"`);
    if (!raw.platforms[ch.platform]) {
      throw new Error(`Channel "${ch.id}" references unknown platform "${ch.platform}"`);
    }
    // Validate bot reference if multi-bot
    const plat = raw.platforms[ch.platform];
    if (ch.bot && plat.bots && !plat.bots[ch.bot]) {
      throw new Error(`Channel "${ch.id}" references unknown bot "${ch.bot}" (available: ${Object.keys(plat.bots).join(', ')})`);
    }
    if (!fs.existsSync(ch.workingDirectory)) {
      console.warn(`Warning: workingDirectory "${ch.workingDirectory}" for channel "${ch.id}" does not exist`);
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
  
  _config = {
    platforms: raw.platforms,
    channels: raw.channels,
    defaults,
    permissions: raw.permissions,
  };
  
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
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
 */
export function registerDynamicChannel(channel: ChannelConfig): void {
  const config = getConfig();
  if (config.channels.some(c => c.id === channel.id)) return; // already registered
  config.channels.push(channel);
}

/** Mark an existing channel as a DM (mutates the source config object). */
export function markChannelAsDM(channelId: string): void {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (channel) channel.isDM = true;
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
export function getPlatformBots(platformName: string): Map<string, { token: string; agent?: string | null }> {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (!platform) throw new Error(`Unknown platform "${platformName}"`);

  const bots = new Map<string, { token: string; agent?: string | null }>();
  if (platform.bots) {
    for (const [name, bot] of Object.entries(platform.bots)) {
      bots.set(name, { token: bot.token, agent: bot.agent });
    }
  } else if (platform.botToken) {
    bots.set('default', { token: platform.botToken });
  }
  return bots;
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
  if (!perms) return null;

  const kind = request.kind; // "shell", "read", "write", "mcp", "url", "custom-tool"
  const command = typeof request.fullCommandText === 'string' ? request.fullCommandText
    : typeof request.command === 'string' ? request.command : undefined;
  const requestPath = typeof request.path === 'string' ? request.path
    : typeof request.fileName === 'string' ? request.fileName : undefined;
  const serverName = typeof request.serverName === 'string' ? request.serverName : undefined;
  const toolName = typeof request.toolName === 'string' ? request.toolName : undefined;
  const url = typeof request.url === 'string' ? request.url : undefined;

  // Extract the first command word from shell commands (e.g., "ls -la /tmp" → "ls")
  const shellCmd = command ? command.trim().split(/\s+/)[0] : undefined;
  // For git/gh, include subcommand: "git push origin main" → "git push"
  const shellCmdFull = command ? (() => {
    const parts = command.trim().split(/\s+/);
    if ((parts[0] === 'git' || parts[0] === 'gh') && parts.length > 1) {
      return `${parts[0]} ${parts[1]}`;
    }
    return parts[0];
  })() : undefined;

  // Check deny rules first (deny takes precedence, matching CLI behavior)
  if (perms.deny) {
    for (const spec of perms.deny) {
      const parsed = parsePermissionSpec(spec);
      if (matchesRule(parsed, kind, shellCmd, shellCmdFull, serverName, toolName)) {
        return 'deny';
      }
    }
  }

  // Hard deny: 'launchctl unload' kills the bridge process before load can run.
  // This must be before allow rules so it can't be overridden by config.
  if (kind === 'shell' && shellCmd === 'launchctl' && command && /\bunload\b/.test(command)) {
    return 'deny';
  }

  // Check allow rules
  if (perms.allow) {
    for (const spec of perms.allow) {
      const parsed = parsePermissionSpec(spec);
      if (matchesRule(parsed, kind, shellCmd, shellCmdFull, serverName, toolName)) {
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
    if (perms.allowPaths) {
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
  if (kind === 'url' && url && perms.allowUrls) {
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
  serverName: string | undefined,
  toolName: string | undefined,
): boolean {
  // Direct kind match: "shell", "read", "write"
  if (parsed.kind === requestKind) {
    if (!parsed.tool) return true; // bare kind matches all of that kind
    // For shell: match command
    if (requestKind === 'shell') {
      return parsed.tool === shellCmd || parsed.tool === shellCmdFull;
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
