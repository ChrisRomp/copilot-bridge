import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { getConfig, getInterAgentConfig } from '../config.js';
import { getDynamicChannels } from '../state/store.js';
import type { InterAgentConfig } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('inter-agent');

// --- Types ---

export interface InterAgentContext {
  chainId: string;
  visited: string[];   // bot names already in the call chain
  depth: number;
  callerBot: string;
  callerChannel: string;
}

export interface BotWorkspaceEntry {
  channelName: string;
  channelId: string;
  workingDirectory: string;
}

export type AgentSource = 'plugin' | 'user' | 'workspace';

export interface AgentDefinition {
  name: string;
  content: string;
  filePath: string;
  source: AgentSource;
}

// --- Loop Prevention ---

/**
 * Check whether callerBot is allowed to call targetBot given the current context.
 * Returns null if allowed, or an error message if blocked.
 */
export function canCall(
  callerBot: string,
  targetBot: string,
  context: InterAgentContext,
  config?: InterAgentConfig,
): string | null {
  const iaConfig = config ?? getInterAgentConfig();

  // Gate: feature must be enabled
  if (!iaConfig.enabled) {
    return 'Inter-agent communication is disabled';
  }

  // Depth check
  const maxDepth = iaConfig.maxDepth ?? 3;
  if (context.depth >= maxDepth) {
    return `Call chain depth limit reached (max ${maxDepth})`;
  }

  // Visited set: prevent cycles (A→B→A)
  if (context.visited.includes(targetBot)) {
    return `Cycle detected: ${targetBot} is already in the call chain [${context.visited.join(' → ')}]`;
  }

  // Allowlist: caller must have canCall permission for target
  if (iaConfig.allow) {
    const callerPerms = iaConfig.allow[callerBot];
    if (!callerPerms?.canCall || !matchesAllowList(targetBot, callerPerms.canCall)) {
      return `${callerBot} is not allowed to call ${targetBot}`;
    }

    const targetPerms = iaConfig.allow[targetBot];
    if (!targetPerms?.canBeCalledBy || !matchesAllowList(callerBot, targetPerms.canBeCalledBy)) {
      return `${targetBot} does not allow calls from ${callerBot}`;
    }
  } else {
    // No allowlist configured — block all cross-agent calls
    return 'No inter-agent allowlist configured';
  }

  return null; // allowed
}

/** Check if a bot name matches an allowlist (supports "*" wildcard). */
function matchesAllowList(botName: string, allowList: string[]): boolean {
  return allowList.some(pattern => pattern === '*' || pattern === botName);
}

/** Create a fresh InterAgentContext for a new call chain. */
export function createContext(callerBot: string, callerChannel: string): InterAgentContext {
  return {
    chainId: crypto.randomUUID(),
    visited: [callerBot],
    depth: 0,
    callerBot,
    callerChannel,
  };
}

/** Extend an existing context for the next hop in the chain. */
export function extendContext(context: InterAgentContext, nextBot: string): InterAgentContext {
  return {
    chainId: context.chainId,
    visited: [...context.visited, nextBot],
    depth: context.depth + 1,
    callerBot: context.visited[context.visited.length - 1],
    callerChannel: context.callerChannel,
  };
}

// --- Workspace Awareness ---

/**
 * Get all working directories for channels served by a given bot.
 * Queries both static config and dynamic channels.
 */
export function getBotWorkspaceMap(botName: string): BotWorkspaceEntry[] {
  const config = getConfig();
  const entries: BotWorkspaceEntry[] = [];
  const seen = new Set<string>(); // dedupe by channelId

  // Static config channels
  for (const ch of config.channels) {
    const channelBot = ch.bot ?? getDefaultBotForPlatform(ch.platform);
    if (channelBot === botName && !seen.has(ch.id)) {
      seen.add(ch.id);
      entries.push({
        channelName: ch.name || ch.id,
        channelId: ch.id,
        workingDirectory: ch.workingDirectory,
      });
    }
  }

  // Dynamic channels from SQLite
  for (const dyn of getDynamicChannels()) {
    const channelBot = dyn.bot ?? getDefaultBotForPlatform(dyn.platform);
    if (channelBot === botName && !seen.has(dyn.channelId)) {
      seen.add(dyn.channelId);
      entries.push({
        channelName: dyn.name || dyn.channelId,
        channelId: dyn.channelId,
        workingDirectory: dyn.workingDirectory,
      });
    }
  }

  return entries;
}

/** Get the default bot name for a platform (first bot in the bots map, or 'default'). */
function getDefaultBotForPlatform(platformName: string): string {
  const config = getConfig();
  const platform = config.platforms[platformName];
  if (platform?.bots) return Object.keys(platform.bots)[0] ?? 'default';
  return 'default';
}

/**
 * Build the system prompt context for workspace awareness.
 * Lists all project workspaces the target bot has access to.
 */
export function buildWorkspacePrompt(workspaceMap: BotWorkspaceEntry[]): string {
  if (workspaceMap.length === 0) return '';

  const lines = workspaceMap.map(
    e => `- ${e.channelName}: ${e.workingDirectory}`
  );
  return `You have access to the following project workspaces:\n${lines.join('\n')}`;
}

/**
 * Build the caller attribution section of the system prompt.
 */
export function buildCallerPrompt(context: InterAgentContext): string {
  return [
    `This request is from agent "${context.callerBot}". You are responding to an inter-agent query, not a direct user message.`,
    `The originating channel is "${context.callerChannel}".`,
    context.depth > 0 ? `Call chain depth: ${context.depth}. Chain: ${context.visited.join(' → ')}.` : '',
  ].filter(Boolean).join('\n');
}

// --- Agent Definition Discovery ---

/**
 * Collect all directories that may contain *.agent.md files.
 * Sources (later entries win on name conflicts):
 *   1. Installed plugins: ~/.copilot/installed-plugins/<vendor>/<plugin>/agents/
 *   2. User profile:      ~/.copilot/agents/
 *   3. Workspace .github:  <workspacePath>/.github/agents/
 *   4. Workspace:          <workspacePath>/agents/
 */
function getAgentRoots(workspacePath: string): { dir: string; source: AgentSource }[] {
  const roots: { dir: string; source: AgentSource }[] = [];
  const home = os.homedir();

  // 1. Plugin agents — walk at most 3 levels deep (e.g. _direct/vendor/plugin/agents/)
  if (home) {
    const pluginsDir = path.join(home, '.copilot', 'installed-plugins');
    if (fs.existsSync(pluginsDir)) {
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === 'agents') {
              roots.push({ dir: full, source: 'plugin' });
            } else {
              walk(full, depth + 1);
            }
          }
        } catch { /* permission errors */ }
      };
      walk(pluginsDir, 0);
    }

    // 2. User-level agents
    const userAgents = path.join(home, '.copilot', 'agents');
    if (fs.existsSync(userAgents)) roots.push({ dir: userAgents, source: 'user' });
  }

  // 3. Workspace .github/agents/ (GitHub Copilot convention)
  const ghAgents = path.join(workspacePath, '.github', 'agents');
  if (fs.existsSync(ghAgents)) roots.push({ dir: ghAgents, source: 'workspace' });

  // 4. Workspace agents/ (highest priority — overrides earlier sources)
  const wsAgents = path.join(workspacePath, 'agents');
  if (fs.existsSync(wsAgents)) roots.push({ dir: wsAgents, source: 'workspace' });

  return roots;
}

/**
 * Discover *.agent.md files from all agent sources (plugins, user profile, workspace).
 * Returns a map of agent name → definition. Later sources override earlier ones.
 */
export function discoverAgentDefinitions(workspacePath: string): Map<string, AgentDefinition> {
  const definitions = new Map<string, AgentDefinition>();

  for (const { dir: agentsDir, source } of getAgentRoots(workspacePath)) {
    try {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.agent.md')) continue;
        const name = entry.name.replace(/\.agent\.md$/, '');
        const filePath = path.join(agentsDir, entry.name);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          definitions.set(name, { name, content, filePath, source });
          log.debug(`Discovered agent definition: ${name} at ${filePath}`);
        } catch (err: any) {
          log.warn(`Failed to read agent definition ${filePath}: ${err?.message}`);
        }
      }
    } catch (err: any) {
      log.warn(`Failed to scan agents directory ${agentsDir}: ${err?.message}`);
    }
  }

  return definitions;
}

/**
 * Lightweight agent name discovery — reads only filenames, not file contents.
 * Scans all agent sources (plugins, user profile, workspace).
 */
export function discoverAgentNames(workspacePath: string): Set<string> {
  const names = new Set<string>();

  for (const { dir: agentsDir } of getAgentRoots(workspacePath)) {
    try {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.agent.md')) continue;
        names.add(entry.name.replace(/\.agent\.md$/, ''));
      }
    } catch (err: any) {
      log.warn(`Failed to scan agents directory ${agentsDir}: ${err?.message}`);
    }
  }

  return names;
}

/**
 * Resolve which agent definition to use for an ephemeral session.
 * Priority: explicit agent param → bot's default agent → none.
 */
export function resolveAgentDefinition(
  workspacePath: string,
  agentParam?: string,
  botDefaultAgent?: string | null,
): AgentDefinition | null {
  const agentName = agentParam ?? botDefaultAgent;
  if (!agentName) return null;

  const definitions = discoverAgentDefinitions(workspacePath);
  const def = definitions.get(agentName);
  if (!def) {
    log.warn(`Agent definition "${agentName}" not found (scanned plugins, user profile, and ${workspacePath}/agents/)`);
    return null;
  }
  return def;
}
