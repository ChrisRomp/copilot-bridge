import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, ChannelConfig, BotConfig, PermissionsConfig } from './types.js';

let _config: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? process.env.COPILOT_BRIDGE_CONFIG ?? path.join(process.cwd(), 'config.json');
  
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
  const channel = config.channels.find(c => c.id === channelId);
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

/** Check if a channel ID is in our configured channels list */
export function isConfiguredChannel(channelId: string): boolean {
  const config = getConfig();
  return config.channels.some(c => c.id === channelId);
}

/**
 * Get the resolved bot token for a channel.
 * Supports both single-bot (botToken) and multi-bot (bots map) configs.
 */
export function getChannelBotToken(channelId: string): string {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) throw new Error(`No config found for channel "${channelId}"`);

  const platform = config.platforms[channel.platform];
  if (channel.bot && platform.bots?.[channel.bot]) {
    return platform.bots[channel.bot].token;
  }
  if (platform.botToken) return platform.botToken;
  // Multi-bot without channel.bot specified: use first bot
  if (platform.bots) {
    const first = Object.values(platform.bots)[0];
    if (first) return first.token;
  }
  throw new Error(`No bot token resolved for channel "${channelId}"`);
}

/** Get the BotConfig for a channel (if multi-bot). */
export function getChannelBotConfig(channelId: string): BotConfig | null {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) return null;
  const platform = config.platforms[channel.platform];
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

/** Get the bot name a channel uses. */
export function getChannelBotName(channelId: string): string {
  const config = getConfig();
  const channel = config.channels.find(c => c.id === channelId);
  if (!channel) return 'default';
  if (channel.bot) return channel.bot;
  const platform = config.platforms[channel.platform];
  if (platform.bots) return Object.keys(platform.bots)[0] ?? 'default';
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
): 'allow' | 'deny' | null {
  const config = getConfig();
  const perms = config.permissions;
  if (!perms) return null;

  const kind = request.kind; // "shell", "read", "write", "mcp", "url", "custom-tool"
  const command = typeof request.command === 'string' ? request.command : undefined;
  const requestPath = typeof request.path === 'string' ? request.path : undefined;
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

  // Check allow rules
  if (perms.allow) {
    for (const spec of perms.allow) {
      const parsed = parsePermissionSpec(spec);
      if (matchesRule(parsed, kind, shellCmd, shellCmdFull, serverName, toolName)) {
        return 'allow';
      }
    }
  }

  // Auto-allow reads within the channel's workspace directory
  if (kind === 'read' && requestPath) {
    const resolved = path.resolve(requestPath);
    const workspace = path.resolve(channelWorkingDirectory);
    if (resolved.startsWith(workspace + path.sep) || resolved === workspace) {
      return 'allow';
    }
    // Check extra allowPaths
    if (perms.allowPaths) {
      for (const p of perms.allowPaths) {
        const allowed = path.resolve(p);
        if (resolved.startsWith(allowed + path.sep) || resolved === allowed) {
          return 'allow';
        }
      }
    }
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
