/**
 * Bridge documentation content for the fetch_copilot_bridge_documentation tool.
 * Each topic returns focused markdown content with source pointers.
 */

import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('bridge-docs');

const TOPICS = [
  'overview', 'commands', 'config', 'mcp', 'permissions', 'workspaces',
  'hooks', 'skills', 'inter-agent', 'scheduling', 'troubleshooting', 'status',
] as const;

export type DocTopic = typeof TOPICS[number];

export function isValidTopic(topic: string): topic is DocTopic {
  return TOPICS.includes(topic as DocTopic);
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'));
    let version = pkg.version ?? 'unknown';
    // Include git hash if running from source
    const gitDir = path.join(import.meta.dirname, '../../.git');
    if (fs.existsSync(gitDir)) {
      try {
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (head.startsWith('ref: ')) {
          const refPath = path.join(gitDir, head.slice(5));
          if (fs.existsSync(refPath)) {
            const hash = fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
            version += ` (${hash})`;
          }
        } else {
          version += ` (${head.slice(0, 7)})`;
        }
      } catch { /* best-effort */ }
    }
    return version;
  } catch {
    return 'unknown';
  }
}

function topicList(): string {
  return `Available topics: ${TOPICS.map(t => `\`${t}\``).join(', ')}

Call with a specific topic for focused information, e.g. \`fetch_copilot_bridge_documentation({ topic: "commands" })\``;
}

// ---------------------------------------------------------------------------
// Topic: overview
// ---------------------------------------------------------------------------

function topicOverview(): string {
  return `# copilot-bridge Overview

copilot-bridge connects GitHub Copilot CLI sessions to messaging platforms (Mattermost, with Slack planned). It runs as a background service, managing one Copilot session per chat channel.

## Key Features

- **Multi-bot support** — multiple bot identities, each with its own workspace, AGENTS.md, and MCP servers
- **Streaming responses** — edit-in-place messages with throttled updates
- **Slash commands** — \`/model\`, \`/new\`, \`/status\`, \`/context\`, etc. (use \`fetch_copilot_bridge_documentation({ topic: "commands" })\` for full list)
- **Permission system** — interactive prompts, autopilot mode, persistent rules
- **MCP servers** — auto-loads from plugins, user config, and workspace config
- **Skills** — skill directories discovered from standard Copilot locations
- **Hooks** — preToolUse/postToolUse shell hooks for custom logic
- **Inter-agent communication** — bots can query each other via \`ask_agent\` tool
- **Task scheduling** — cron and one-off scheduled prompts
- **Model fallback** — automatic failover on model capacity/availability errors
- **Infinite sessions** — SDK-managed context compaction for long conversations

## Architecture

1. Channel adapter receives platform message, normalizes to \`InboundMessage\`
2. Messages serialized per-channel via promise chains
3. \`SessionManager\` creates/resumes Copilot sessions via \`CopilotBridge\` (SDK wrapper)
4. SDK events flow back through formatters → streaming handler → platform

## Source

- Repository: https://github.com/ChrisRomp/copilot-bridge
- Docs: \`docs/\` directory in the repository
- Key files: \`src/index.ts\` (orchestrator), \`src/core/session-manager.ts\` (session lifecycle), \`src/core/bridge.ts\` (SDK wrapper)`;
}

// ---------------------------------------------------------------------------
// Topic: commands
// ---------------------------------------------------------------------------

function topicCommands(): string {
  return `# Slash Commands

Commands are intercepted by the bridge before reaching the Copilot session. The agent does not see these commands.

## Session Management
| Command | Description |
|---------|-------------|
| \`/new\` | Create a new session (destroys current) |
| \`/stop\`, \`/cancel\` | Stop the current task |
| \`/reload\` | Re-attach session (re-reads AGENTS.md, config, MCP) |
| \`/reload config\` | Hot-reload bridge config file |
| \`/resume [id]\` | Resume a past session (no args = list recent) |

## Model & Agent
| Command | Description |
|---------|-------------|
| \`/model [name]\` | Show available models or switch model |
| \`/agent <name>\` | Switch to a named agent persona |
| \`/agents\` | List available agent definitions |
| \`/reasoning [level]\` | Set reasoning effort (low/medium/high/xhigh) |

## Permissions & Mode
| Command | Description |
|---------|-------------|
| \`/approve\` | Approve pending permission request |
| \`/deny\` | Deny pending permission request |
| \`/yolo\` | Toggle auto-approve all permissions |
| \`/autopilot\`, \`/auto\` | Toggle autonomous mode |
| \`/plan [on|off|show|clear]\` | Toggle plan mode |
| \`/always approve|deny <pattern>\` | Persist a permission rule |
| \`/rules\` | List all stored permission rules |

## Information
| Command | Description |
|---------|-------------|
| \`/status\` | Show session info, model, mode, context usage |
| \`/context\` | Show context window usage |
| \`/verbose\` | Toggle verbose tool output |
| \`/mcp\` | Show loaded MCP servers and their source |
| \`/skills\`, \`/tools\` | Show available skills, enable/disable |
| \`/schedule\`, \`/tasks\` | List scheduled tasks |
| \`/help [all]\` | Show common commands (or all) |

## Display
| Command | Description |
|---------|-------------|
| \`/streamer-mode\`, \`/on-air\` | Toggle sensitive data redaction |

## Source
- Command parsing: \`src/core/command-handler.ts\`
- Command dispatch: \`src/index.ts\` (handleInboundMessage)`;
}

// ---------------------------------------------------------------------------
// Topic: config
// ---------------------------------------------------------------------------

function topicConfig(isAdmin: boolean): string {
  const editNote = isAdmin
    ? 'Config file: `~/.copilot-bridge/config.json` (or `COPILOT_BRIDGE_CONFIG` env var)'
    : 'Config changes require editing `~/.copilot-bridge/config.json`. Ask your administrator or the user to make config modifications.';

  return `# Configuration

${editNote}

## Key Top-Level Settings

| Field | Type | Description |
|-------|------|-------------|
| \`platform\` | string | \`"mattermost"\` (required) |
| \`mattermost\` | object | Platform connection settings (url, token, etc.) |
| \`logLevel\` | string | \`"debug"\`, \`"info"\`, \`"warn"\`, \`"error"\` |
| \`infiniteSessions\` | boolean | Enable SDK context compaction (default: false) |
| \`defaults\` | object | Per-channel defaults (can be overridden per channel) |
| \`channels\` | object | Per-channel config overrides |
| \`permissions\` | object | Permission rules (allow/deny patterns) |
| \`interAgent\` | object | Inter-agent communication settings |

## Defaults Section (per-channel overridable)

| Field | Default | Description |
|-------|---------|-------------|
| \`model\` | \`"claude-sonnet-4.6"\` | Default model |
| \`verbose\` | \`false\` | Show tool call details |
| \`permissionMode\` | \`"interactive"\` | Permission handling mode |
| \`fallbackModels\` | \`[]\` | Model fallback chain |
| \`workingDirectory\` | (auto) | Bot workspace path |
| \`bot\` | (auto) | Bot identity name |

## Channel Overrides

Per-channel settings in \`channels\` override \`defaults\`:
\`\`\`json
{
  "channels": {
    "channel-id-here": {
      "model": "claude-opus-4.6",
      "bot": "admin-bot",
      "workingDirectory": "/path/to/workspace"
    }
  }
}
\`\`\`

## Hot-Reloadable Settings

These apply immediately on \`/reload config\`: \`defaults\`, \`permissions\`, \`interAgent\`, \`channels\`.
Top-level settings like \`infiniteSessions\` take effect at next session create/resume.

## Source
- Config loading/validation: \`src/config.ts\`
- Sample: \`config.sample.json\`
- Docs: \`docs/configuration.md\``;
}

// ---------------------------------------------------------------------------
// Topic: mcp
// ---------------------------------------------------------------------------

function topicMcp(): string {
  return `# MCP Server Configuration

MCP (Model Context Protocol) servers provide external tools to agents. Loaded in three layers:

1. **Plugins** (\`~/.copilot/installed-plugins/**/.mcp.json\`) — lowest priority
2. **User config** (\`~/.copilot/mcp-config.json\`) — overrides plugins
3. **Workspace config** (\`<workspace>/mcp-config.json\`) — highest priority, per-bot

## Format

\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
\`\`\`

## Working Directory

Local MCP servers automatically run with \`cwd\` set to the bot's workspace. Override with explicit \`cwd\` in config.

## Environment Variables

Workspace \`.env\` vars are injected into every local MCP server's \`env\` field. Use \`\${VAR}\` in config to remap variable names.

Priority: explicit \`env\` in config > \`.env\` values.

## Troubleshooting

- **Server not loading**: Check \`~/.copilot-bridge/copilot-bridge.log\` for MCP startup errors
- **Tools not visible**: Server may start but fail to connect to backend (missing env vars). Run \`/reload\` after fixing.
- **Wrong server version**: \`npx\` caches — use \`npx --yes package@latest\` to force update
- **\`/mcp\` command**: Shows all loaded servers and which layer they came from

## Source
- Server resolution: \`src/core/session-manager.ts\` (resolveMcpServers, loadWorkspaceMcpServers, mergeMcpServers)
- Docs: \`docs/workspaces.md\` (MCP section)`;
}

// ---------------------------------------------------------------------------
// Topic: permissions
// ---------------------------------------------------------------------------

function topicPermissions(): string {
  return `# Permission System

The bridge controls which tools agents can use. Permissions are resolved in order:

1. **Hardcoded safety denies** (cannot override)
2. **Autopilot/yolo mode** (auto-approve if enabled)
3. **Config deny rules** (from \`permissions.deny\`)
4. **Config allow rules** (from \`permissions.allow\`)
5. **SQLite stored rules** (from \`/always approve\` or \`/always deny\`)
6. **Interactive prompt** (asks user in chat)

## Config Rules

\`\`\`json
{
  "permissions": {
    "allow": ["read", "shell(ls)", "shell(cat)", "vault-search"],
    "deny": ["shell(rm)", "shell(git push)"],
    "allowPaths": [],
    "allowUrls": ["docs.github.com"]
  }
}
\`\`\`

## Pattern Syntax

| Pattern | Matches |
|---------|---------|
| \`"read"\` | All file reads |
| \`"write"\` | All file writes |
| \`"shell"\` | All shell commands |
| \`"shell(ls)"\` | The \`ls\` command specifically |
| \`"shell(git push)"\` | \`git push\` with any args |
| \`"mcp-server-name"\` | All tools from that MCP server |
| \`"mcp-server(tool)"\` | Specific MCP tool |

## User Commands

| Command | Effect |
|---------|--------|
| \`/approve\` | Approve current pending request |
| \`/deny\` | Deny current pending request |
| \`/yolo\` | Toggle auto-approve all |
| \`/autopilot\` | Toggle autonomous mode (auto-approve + continues without user input) |
| \`/always approve <pattern>\` | Persist an allow rule |
| \`/always deny <pattern>\` | Persist a deny rule |
| \`/rules\` | View all stored rules |
| \`/rules clear\` | Clear all stored rules |

## Source
- Permission resolution: \`src/core/session-manager.ts\` (handlePermissionRequest)
- Access control: \`src/core/access-control.ts\`
- Docs: \`docs/configuration.md\` (Permissions section)`;
}

// ---------------------------------------------------------------------------
// Topic: workspaces
// ---------------------------------------------------------------------------

function topicWorkspaces(): string {
  return `# Workspaces

Each bot has a dedicated workspace directory (default: \`~/.copilot-bridge/workspaces/<bot-name>/\`).

## Structure

\`\`\`
<workspace>/
├── AGENTS.md            # Agent instructions (read by Copilot CLI)
├── .env                 # Environment variables (secrets, API tokens)
├── mcp-config.json      # Workspace-specific MCP servers (optional)
├── agents/              # Named agent personas (*.agent.md)
├── .github/skills/      # Project-level skills
└── .agents/skills/      # Legacy skill location
\`\`\`

## .env Files

- Loaded into shell environment at session start
- Injected into MCP server \`env\` fields automatically
- **Never read or display .env contents** — secrets must stay out of chat context

## Agent Personas

Files in \`<workspace>/agents/*.agent.md\` define named personas. Users switch with \`/agent <name>\`.

## Workspace Resolution

1. Channel-specific \`workingDirectory\` in config
2. Bot-specific workspace: \`~/.copilot-bridge/workspaces/<bot-name>/\`
3. Fallback to bridge cwd

## Additional Paths

Admins can grant bots access to folders outside their workspace via the \`grant_path_access\` API.

## Source
- Workspace resolution: \`src/core/session-manager.ts\` (resolveWorkingDirectory)
- Docs: \`docs/workspaces.md\``;
}

// ---------------------------------------------------------------------------
// Topic: hooks
// ---------------------------------------------------------------------------

function topicHooks(): string {
  return `# Hooks

Hooks run shell commands at session lifecycle points. They can allow, deny, or prompt for tool usage.

## Configuration

Hooks are defined in \`hooks.json\` files, discovered in order:
1. Plugin hooks (\`~/.copilot/installed-plugins/**/hooks.json\`)
2. User hooks (\`~/.copilot/hooks/hooks.json\`)
3. Workspace hooks (\`<workspace>/.copilot/hooks.json\`) — requires \`allowWorkspaceHooks: true\` in config

## Format

\`\`\`json
{
  "version": "1.0.0",
  "hooks": {
    "preToolUse": [
      {
        "type": "bash",
        "bash": "/path/to/script.sh",
        "timeoutSec": 5
      }
    ]
  }
}
\`\`\`

## Hook Types

| Type | When | Can Control? |
|------|------|-------------|
| \`preToolUse\` | Before tool execution | Yes — allow/deny/ask |
| \`postToolUse\` | After tool execution | No |

## Hook Script I/O

- **Input**: JSON on stdin with \`toolName\`, \`toolArgs\`, \`sessionId\`
- **Output**: JSON on stdout with \`permissionDecision\` (\`"allow"\`, \`"deny"\`, \`"ask"\`)
- **Important**: \`toolArgs\` may be a JSON string (not object) — parse with \`jq '(.toolArgs | if type == "string" then fromjson else . end)'\`

## Performance

Hooks fire on **every tool call** — keep scripts fast. Use low \`timeoutSec\` (5s) and early-exit for non-matching tools.

## Source
- Hook loading: \`src/core/hooks-loader.ts\`
- Hook integration: \`src/core/session-manager.ts\` (resolveHooks, wrapHooksWithAsk)
- Docs: \`docs/configuration.md\` (Hooks section)`;
}

// ---------------------------------------------------------------------------
// Topic: skills
// ---------------------------------------------------------------------------

function topicSkills(): string {
  return `# Skills

Skills are prompt-based capabilities discovered from standard Copilot directory conventions.

## Discovery Paths (checked in order)

1. \`~/.copilot/skills/\` — user-level
2. \`~/.agents/skills/\` — user-level (alternate)
3. \`<workspace>/.github/skills/\` — project-level (standard)
4. \`<workspace>/.agents/skills/\` — project-level (legacy)
5. \`~/.copilot/installed-plugins/**/skills/\` — plugin skills

Each subdirectory in these locations is a skill. Skills contain a \`SKILL.md\` file with instructions.

## Managing Skills

| Command | Effect |
|---------|--------|
| \`/skills\` | List all discovered skills and their status |
| \`/skills enable <name>\` | Enable a disabled skill |
| \`/skills disable <name>\` | Disable a skill for this channel |

Disabled skills are persisted per-channel in SQLite and passed to the SDK as \`disabledSkills\`.

## Source
- Skill discovery: \`src/core/session-manager.ts\` (discoverSkillDirectories)
- Skill toggle: \`src/core/command-handler.ts\` (/skills command)
- State: \`src/state/store.ts\` (channel_prefs.disabled_skills)`;
}

// ---------------------------------------------------------------------------
// Topic: inter-agent
// ---------------------------------------------------------------------------

function topicInterAgent(): string {
  return `# Inter-Agent Communication

Bots can query each other via the \`ask_agent\` tool, creating ephemeral sessions.

## Configuration

\`\`\`json
{
  "interAgent": {
    "enabled": true,
    "defaultTimeout": 60,
    "maxTimeout": 300,
    "maxDepth": 3,
    "allow": {
      "bot-a": { "canCall": ["bot-b"], "canBeCalledBy": ["bot-b"] },
      "bot-b": { "canCall": ["bot-a"], "canBeCalledBy": ["bot-a"] },
      "helper": { "canCall": [], "canBeCalledBy": ["*"] }
    }
  }
}
\`\`\`

## How It Works

1. Agent calls \`ask_agent({ target: "other-bot", message: "question" })\`
2. Bridge validates allowlist and depth limits
3. Creates ephemeral session for target bot with its own workspace/AGENTS.md
4. Sends message, collects response, tears down session
5. Returns response to calling agent

## Tool Parameters

| Param | Required | Description |
|-------|----------|-------------|
| \`target\` | Yes | Bot name to ask |
| \`message\` | Yes | Question or request |
| \`agent\` | No | Specific agent persona |
| \`timeout\` | No | Timeout in seconds |
| \`autopilot\` | No | Auto-approve tools in target session |
| \`denyTools\` | No | Tools to deny in target session |
| \`grantTools\` | No | Tools to pre-approve |

## Safety

- **Allowlist**: Both caller and target must be configured
- **Depth limit**: Prevents infinite chains (default: 3)
- **Visited set**: Same bot can't be called twice in a chain
- **Audit**: All calls logged to SQLite \`agent_calls\` table

## Source
- Inter-agent logic: \`src/core/inter-agent.ts\`
- Ephemeral sessions: \`src/core/session-manager.ts\` (executeEphemeralCall)
- Docs: \`docs/configuration.md\` (Inter-agent section)`;
}

// ---------------------------------------------------------------------------
// Topic: scheduling
// ---------------------------------------------------------------------------

function topicScheduling(): string {
  return `# Task Scheduling

The \`schedule\` tool allows creating recurring (cron) or one-off scheduled tasks.

## How It Works

Tasks are stored in SQLite and checked by a timer. When a task fires, it sends the configured prompt to the bot's channel as if a user sent it.

## Creating Tasks

Via the \`schedule\` tool:
- **Recurring**: \`schedule({ action: "create", prompt: "Check for updates", cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" })\`
- **One-off**: \`schedule({ action: "create", prompt: "Remind me about the meeting", run_at: "2026-03-20T15:00:00Z" })\`

## Managing Tasks

| Action | Description |
|--------|-------------|
| \`create\` | Create a new task (requires \`prompt\` + \`cron\` or \`run_at\`) |
| \`list\` | List all tasks for this channel |
| \`cancel\` | Cancel a task by ID |
| \`pause\` | Pause a recurring task |
| \`resume\` | Resume a paused task |

User command: \`/schedule\` or \`/tasks\` lists all scheduled tasks.

## Timezone

- \`cron\` expressions are evaluated in the specified \`timezone\` (default: UTC)
- \`run_at\` is always ISO 8601 (include \`Z\` suffix for UTC)
- Display uses the task's timezone

## Source
- Schedule tool: \`src/core/session-manager.ts\` (buildScheduleToolDef)
- Job storage/execution: \`src/core/scheduler.ts\``;
}

// ---------------------------------------------------------------------------
// Topic: troubleshooting
// ---------------------------------------------------------------------------

function topicTroubleshooting(isAdmin: boolean): string {
  const logNote = isAdmin
    ? 'Logs are at `~/.copilot-bridge/copilot-bridge.log`. Use `grep` to search for relevant errors.'
    : 'Ask the user or admin to check `~/.copilot-bridge/copilot-bridge.log` for error details.';

  return `# Troubleshooting

${logNote}

## Common Issues

### MCP server not loading
- Check logs for MCP startup errors
- Verify env vars in workspace \`.env\`
- Run \`/reload\` after config changes
- Use \`/mcp\` to see loaded servers and their source

### Permission prompt not appearing
- Check if \`/yolo\` or \`/autopilot\` is enabled (\`/status\` shows this)
- Check \`permissions\` config for matching allow rules
- Stored rules from \`/always approve\` may be auto-allowing

### Model errors / fallback
- The bridge auto-falls back on capacity/availability errors
- "Failed to get response" with "Unknown error" = transient API issue (not model-specific, no fallback)
- Use \`/model\` to check current model and available alternatives

### Stale session
- \`/new\` creates a fresh session
- \`/reload\` re-attaches the same session with updated config
- After bridge restart, sessions auto-resume

### Context window full
- \`/context\` shows current usage
- Enable \`infiniteSessions\` in config for automatic compaction
- \`/new\` starts fresh

### Hooks not firing
- Check hook script permissions (\`chmod +x\`)
- Workspace hooks need \`allowWorkspaceHooks: true\` in config
- Hook timeout may be too short (check \`timeoutSec\`)

## Filing Issues

Report bugs at: https://github.com/ChrisRomp/copilot-bridge/issues

Use the repository's issue templates:
- **Bug report**: Summary, Steps to Reproduce, Expected/Actual Behavior
- **Feature request**: Summary, Motivation, Proposed Solution

Always include:
- Bridge version (\`/status\` or \`fetch_copilot_bridge_documentation({ topic: "status" })\`)
- Relevant log excerpts (redact any unique identifiers, tokens, or URLs)
- Platform (macOS/Linux) and Node.js version

## Source
- Issue templates: \`.github/ISSUE_TEMPLATE/\`
- Model fallback: \`src/core/model-fallback.ts\`
- Loop detection: \`src/core/loop-detector.ts\``;
}

// ---------------------------------------------------------------------------
// Topic: status (dynamic)
// ---------------------------------------------------------------------------

interface StatusContext {
  channelId: string;
  model?: string;
  sessionId?: string;
}

function topicStatus(ctx: StatusContext): string {
  const version = getVersion();
  const config = getConfig();
  const lines: string[] = ['# Bridge Status (Live)', ''];
  lines.push(`- **Version**: ${version}`);
  lines.push(`- **Platforms**: ${Object.keys(config.platforms).join(', ') || 'none'}`);
  lines.push(`- **Log level**: ${config.logLevel ?? 'info'}`);
  lines.push(`- **Infinite sessions**: ${config.infiniteSessions ? 'enabled' : 'disabled'}`);

  if (ctx.model) lines.push(`- **Current model**: ${ctx.model}`);
  if (ctx.sessionId) lines.push(`- **Session ID**: \`${ctx.sessionId}\``);

  // Configured bots (from platforms)
  const bots = new Set<string>();
  for (const platform of Object.values(config.platforms)) {
    if (platform.bots) {
      for (const name of Object.keys(platform.bots)) bots.add(name);
    }
  }
  if (bots.size > 0) {
    lines.push(`- **Configured bots**: ${[...bots].join(', ')}`);
  }

  lines.push('');
  lines.push('## Source');
  lines.push('- Config: `src/config.ts`');
  lines.push('- Session manager: `src/core/session-manager.ts`');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DocRequest {
  topic?: string;
  isAdmin: boolean;
  channelId: string;
  model?: string;
  sessionId?: string;
}

export function getBridgeDocs(req: DocRequest): string {
  if (!req.topic) {
    return `# copilot-bridge Documentation

Use this tool with a \`topic\` parameter to get focused information.

${topicList()}`;
  }

  if (!isValidTopic(req.topic)) {
    return `Unknown topic: "${req.topic}"\n\n${topicList()}`;
  }

  switch (req.topic) {
    case 'overview': return topicOverview();
    case 'commands': return topicCommands();
    case 'config': return topicConfig(req.isAdmin);
    case 'mcp': return topicMcp();
    case 'permissions': return topicPermissions();
    case 'workspaces': return topicWorkspaces();
    case 'hooks': return topicHooks();
    case 'skills': return topicSkills();
    case 'inter-agent': return topicInterAgent();
    case 'scheduling': return topicScheduling();
    case 'troubleshooting': return topicTroubleshooting(req.isAdmin);
    case 'status': return topicStatus({ channelId: req.channelId, model: req.model, sessionId: req.sessionId });
  }
}
