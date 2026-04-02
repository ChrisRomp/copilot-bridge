/**
 * Bridge documentation content for the fetch_copilot_bridge_documentation tool.
 * Each topic returns focused markdown content with source pointers.
 */

import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('bridge-docs');

const TOPICS = [
  'overview', 'commands', 'config', 'mcp', 'permissions', 'workspaces',
  'hooks', 'skills', 'inter-agent', 'scheduling', 'providers', 'telemetry', 'troubleshooting', 'status',
] as const;

export type DocTopic = typeof TOPICS[number];

export function isValidTopic(topic: string): topic is DocTopic {
  return TOPICS.includes(topic as DocTopic);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _cachedVersion: string | null = null;

function getVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    let version = pkg.version ?? 'unknown';
    const gitDir = path.join(__dirname, '../../.git');
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
    _cachedVersion = version;
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

copilot-bridge connects GitHub Copilot CLI sessions to messaging platforms (Mattermost, Slack). It runs as a background service, managing one Copilot session per chat channel.

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
- **BYOK providers** — bring your own API keys for external model providers (Ollama, Azure, OpenAI-compatible)
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

Commands are intercepted by the bridge before reaching the Copilot session. The agent does not see these commands. Use \`/help all\` for the complete list — below are the most commonly used commands.

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
| \`/model <provider>:<model>\` | Switch to a BYOK provider model |
| \`/provider\` | List configured BYOK providers |
| \`/provider test <name>\` | Test provider connectivity |
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
| \`/plan [on|off|show|summary|clear]\` | Toggle plan mode. On entry, surfaces existing plan if found |
| \`/implement [yolo|interactive]\` | Start implementing the current plan. Default: autopilot. \`yolo\`: autopilot + auto-approve. \`interactive\`: step-by-step |
| \`/always approve|deny <pattern>\` | Persist a permission rule |
| \`/rules\` | List all stored permission rules |

## Information
| Command | Description |
|---------|-------------|
| \`/status\` | Show session info, model, mode, context usage |
| \`/config\` | Show effective channel config with source attribution |
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
| \`platforms\` | object | Platform configs keyed by name (e.g., \`"mattermost": { url, bots }\`) |
| \`channels\` | array | Per-channel config entries (each has \`id\`, \`platform\`, \`bot\`, etc.) |
| \`defaults\` | object | Default values for channel settings |
| \`logLevel\` | string | \`"debug"\`, \`"info"\`, \`"warn"\`, \`"error"\` |
| \`infiniteSessions\` | boolean | Enable SDK context compaction (default: false) |
| \`permissions\` | object | Permission rules (allow/deny patterns) |
| \`interAgent\` | object | Inter-agent communication settings |
| \`providers\` | object | BYOK provider configs (use \`fetch_copilot_bridge_documentation({ topic: "providers" })\` for details) |
| \`telemetry\` | object | OpenTelemetry trace export config (use \`fetch_copilot_bridge_documentation({ topic: "telemetry" })\` for details) |

## Defaults Section (per-channel overridable)

| Field | Default | Description |
|-------|---------|-------------|
| \`model\` | \`"claude-sonnet-4.6"\` | Default model |
| \`verbose\` | \`false\` | Show tool call details |
| \`permissionMode\` | \`"interactive"\` | Permission handling mode |
| \`fallbackModels\` | \`[]\` | Model fallback chain |

## Channel Entries

Each entry in the \`channels\` array configures one channel:
\`\`\`json
{
  "channels": [
    {
      "id": "channel-id-from-platform",
      "platform": "mattermost",
      "bot": "copilot",
      "name": "My Project",
      "workingDirectory": "/path/to/workspace",
      "model": "claude-opus-4.6"
    }
  ]
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

Hooks are defined in \`hooks.json\` files, discovered in order (lowest → highest priority):
1. Plugin hooks (\`~/.copilot/installed-plugins/**/hooks.json\`)
2. User hooks (\`~/.copilot/hooks.json\`)
3. Workspace hooks (\`<workspace>/.github/hooks/hooks.json\`, \`<workspace>/.github/hooks.json\`, or \`<workspace>/hooks.json\`) — requires \`allowWorkspaceHooks: true\` in config

## Format

\`\`\`json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "./scripts/guard.sh",
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
// Topic: providers
// ---------------------------------------------------------------------------

function topicProviders(isAdmin: boolean): string {
  const adminNote = isAdmin
    ? `\n\n## Managing Providers (Admin)

As the admin agent, you can add/remove/edit providers in \`config.json\`:

1. **Always back up first**: \`cp ~/.copilot-bridge/config.json ~/.copilot-bridge/config.json.bak.$(date +%s)\`
2. Edit the \`"providers"\` key in config.json
3. Run \`/reload config\` in the target channel to apply (no restart needed)

### Adding a Provider
Add an entry under \`"providers"\` with: \`type\`, \`baseUrl\`, optional \`apiKeyEnv\`, and \`models\` array.

### Removing a Provider
Delete the provider key from \`"providers"\`. Channels using that provider will fall back to Copilot on next session create.

### Validating
After editing, the user can run \`/provider test <name>\` to verify connectivity.`
    : '\n\nTo add or remove providers, ask the admin bot or edit `config.json` directly, then `/reload config`.';

  return `# BYOK Providers

Bring Your Own Key (BYOK) lets you use external model providers alongside GitHub Copilot models. Supported backends: OpenAI-compatible APIs, Azure OpenAI, Ollama, vLLM, and any OpenAI-compatible endpoint.

## Config Schema

Providers are configured under the \`"providers"\` key in \`config.json\`:

\`\`\`json
{
  "providers": {
    "ollama": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1",
      "models": [
        { "id": "qwen3:8b", "name": "Qwen 3 8B" }
      ]
    },
    "work-azure": {
      "type": "azure",
      "baseUrl": "https://myco.openai.azure.com",
      "apiKeyEnv": "AZURE_OPENAI_KEY",
      "azure": { "apiVersion": "2024-10-21" },
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o" },
        { "id": "gpt-5.2-codex", "name": "GPT-5.2 Codex", "wireApi": "responses" }
      ]
    }
  }
}
\`\`\`

### Provider Fields

| Field | Required | Description |
|-------|----------|-------------|
| \`type\` | no | \`"openai"\` (default, OpenAI-compatible), \`"azure"\`, or \`"anthropic"\` |
| \`baseUrl\` | yes | API endpoint URL |
| \`apiKeyEnv\` | no | Environment variable holding the API key (omit for keyless, e.g., local Ollama) |
| \`wireApi\` | no | Default wire protocol for all models: \`"completions"\` (default) or \`"responses"\`. Can be overridden per model. |
| \`azure\` | azure only | \`{ "apiVersion": "..." }\` |
| \`models\` | yes | Array of model entries. Each has \`id\` (required), \`name\`, and optional \`wireApi\` override. |

### Wire API & Model Compatibility

\`wireApi\` can be set at provider level (applies to all models) or per model (overrides provider default).

- \`"completions"\` (Chat Completions API) — works with most models: GPT-4o, GPT-4.1, Llama, Phi, Qwen, etc.
- \`"responses"\` (Responses API) — **required** for Codex models (\`gpt-5.x-codex-*\`)
- Models must support **structured function calling** (OpenAI-compatible \`tool_calls\`). Models that emit tool calls as raw text (e.g., DeepSeek, some smaller models) will not work correctly.

## Commands

| Command | Description |
|---------|-------------|
| \`/provider\` | List all configured providers |
| \`/provider test <name>\` | Test connectivity and validate models |
| \`/model\` | Lists all models grouped by provider |
| \`/model <provider>\` | Filter to one provider's models |
| \`/model <provider>:<model>\` | Switch to a specific provider model |

## Model Resolution

- \`/model qwen3:8b\` — bare ID resolves Copilot first, then BYOK providers
- \`/model ollama:qwen3:8b\` — provider-prefixed ID targets that provider directly
- Provider names are case-insensitive; model IDs split on the first colon only

## Session Behavior

- Switching between Copilot and BYOK (or between BYOK providers) creates a fresh session
- Switching models within the same provider reuses the existing session
- BYOK models are excluded from automatic fallback chains (only Copilot models auto-fallback)
- Provider config changes apply on \`/reload config\` — no bridge restart needed
${adminNote}

## Troubleshooting

### Azure 404 Not Found

The SDK constructs Azure URLs as: \`{baseUrl}/openai/deployments/{model.id}/{endpoint}?api-version={apiVersion}\`

- If \`baseUrl\` contains \`/openai/\`, it's used as-is; otherwise the SDK strips to origin and appends \`/openai\`
- \`model.id\` becomes the deployment name in the URL — must match your Azure deployment exactly
- \`apiVersion\` defaults to \`"2024-10-21"\` if omitted; check Azure portal for supported versions

Common fixes:
1. Use just the host for \`baseUrl\`: \`https://myco.openai.azure.com\` (no \`/v1\` or \`/openai/deployments/...\`)
2. Ensure \`model.id\` matches the Azure deployment name exactly
3. Set \`azure.apiVersion\` explicitly if the default doesn't work

### Auth Header Mismatch

Azure uses \`api-key\` header, OpenAI uses \`Authorization: Bearer\`. Set \`type: "azure"\` for Azure endpoints — default \`"openai"\` sends the wrong header.

### Tools Not Executing

If the agent outputs raw XML/JSON instead of running tools, the model doesn't support structured function calling. Use GPT-4o, GPT-4.1, Llama 3.3, Phi-4, or Qwen 3 instead of DeepSeek or small fine-tuned models.

## Source
- Provider config/validation: \`src/config.ts\`
- Model resolution: \`src/core/command-handler.ts\` (resolveModel, parseProviderModel)
- Provider routing: \`src/core/session-manager.ts\` (createNewSession, switchModel)
- Docs: \`docs/byok.md\``;
}

// ---------------------------------------------------------------------------
// Topic: telemetry
// ---------------------------------------------------------------------------

function topicTelemetry(isAdmin: boolean): string {
  const editNote = isAdmin
    ? 'Add the `telemetry` section to `~/.copilot-bridge/config.json`.'
    : 'Telemetry configuration requires editing `config.json`. Ask your administrator.';

  return `# OpenTelemetry Telemetry

The bridge can export OpenTelemetry traces from the Copilot CLI subprocess. The CLI auto-instruments model calls, tool execution, and session lifecycle following the OTel GenAI semantic conventions. Token usage (input/output tokens) is included in span attributes.

${editNote}

## Configuration

Add a \`telemetry\` section to \`config.json\`:

\`\`\`json
{
  "telemetry": {
    "otlpEndpoint": "http://localhost:4318",
    "sourceName": "copilot-bridge",
    "captureContent": false,
    "authEnv": "OTEL_AUTH"
  }
}
\`\`\`

## Config Fields

| Field | Type | Description |
|-------|------|-------------|
| \`otlpEndpoint\` | string | OTLP HTTP endpoint URL for trace export |
| \`exporterType\` | string | \`"otlp-http"\` (default) or \`"file"\` |
| \`filePath\` | string | JSON-lines trace output path (for file exporter) |
| \`sourceName\` | string | Instrumentation scope name (default: \`"copilot-bridge"\`) |
| \`captureContent\` | boolean | Include message content (prompts/responses) in traces |
| \`authEnv\` | string | Env var name holding the Authorization header value |

## Authentication

For endpoints requiring auth (e.g., OpenObserve, Grafana Cloud), set the \`authEnv\` field to the name of an env var containing the full Authorization header value:

1. Add the credential to a workspace \`.env\` file: \`OTEL_AUTH=Basic <base64-encoded-credentials>\`
2. Set \`"authEnv": "OTEL_AUTH"\` in the telemetry config
3. The bridge resolves the value from \`process.env\` or workspace \`.env\` files and passes it as the \`OTEL_EXPORTER_OTLP_HEADERS\` header, scoped to the CLI subprocess only

## What Gets Traced

The CLI emits spans for:
- **Model calls** — including token counts (\`gen_ai.usage.input_tokens\`, \`gen_ai.usage.output_tokens\`)
- **Tool execution** — each tool call with timing
- **Session lifecycle** — create, resume, idle

## Notes

- Telemetry config changes require a bridge restart (\`/reload config\` will report this)
- The bridge itself does not emit spans — only the CLI subprocess is instrumented
- Compatible with any OTLP HTTP collector: OpenObserve, Jaeger, Grafana Tempo, etc.

## Source

- Config: \`src/types.ts\` (BridgeTelemetryConfig), \`src/config.ts\` (validation)
- Resolution: \`src/index.ts\` (resolveTelemetryConfig)
- SDK integration: \`src/core/bridge.ts\` (CopilotClient constructor)`;
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
    case 'providers': return topicProviders(req.isAdmin);
    case 'telemetry': return topicTelemetry(req.isAdmin);
    case 'troubleshooting': return topicTroubleshooting(req.isAdmin);
    case 'status': return topicStatus({ channelId: req.channelId, model: req.model, sessionId: req.sessionId });
  }
}
