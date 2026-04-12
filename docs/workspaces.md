# Workspaces & Agents

## Workspaces

Each bot gets a workspace directory at `~/.copilot-bridge/workspaces/<botname>/`. This is the default working directory for DM conversations with that bot.

Workspaces are auto-created when the bridge starts and detects a bot without one. They contain:

```
~/.copilot-bridge/workspaces/agent-name/
├── AGENTS.md        # Agent instructions (auto-generated from template, customizable)
├── AGENTS.local.md  # Local operator conventions (gitignored, optional)
├── MEMORY.md        # Persistent memory across sessions (managed by the agent)
├── mcp-config.json  # Workspace-specific MCP servers (optional, overrides global)
└── .env             # Environment variables loaded at session start
```

### Custom working directories

For group channels or project-specific DMs, override the workspace via `workingDirectory` in [config.json](configuration.md#channels). The same bot can serve multiple channels, each pointed at a different directory.

## AGENTS.local.md

An optional, gitignored file for per-operator conventions (push policies, branching rules, workflow preferences). The bridge loads it from the working directory at session creation and injects its content into `custom_instructions` alongside bridge instructions.

This file is **not** discovered by the Copilot SDK/CLI — the bridge handles it in `buildSystemMessage()`. It's intended for conventions that are personal to the operator rather than the project (which belong in `AGENTS.md`).

To use it, create `AGENTS.local.md` in the working directory and add it to `.gitignore`.

## Agent templates

Templates in the repo define the baseline instructions for agents:

```
templates/
├── admin/
│   └── AGENTS.md    # Template for admin bots
└── agents/
    └── AGENTS.md    # Template for non-admin bots
```

On startup, the bridge copies these to `~/.copilot-bridge/templates/` (mtime-based sync — newer source overwrites destination). When a new workspace is created, its `AGENTS.md` is rendered from the appropriate template with variables like `{{botName}}`, `{{workspacePath}}`, and `{{adminBotName}}` filled in.

You can customize the deployed templates at `~/.copilot-bridge/templates/` without modifying the repo. Your edits won't be overwritten unless the repo template is newer.

### Admin vs non-admin agents

- **Admin bots** (`"admin": true` in config) get the admin template, which includes instructions for managing the bridge: creating agents, editing config, restarting the service.
- **Non-admin bots** get the agents template, which includes an "Out of Scope — Defer to Admin" section listing tasks they should redirect to the admin bot.

## Environment variables (.env)

Each workspace can have a `.env` file that's loaded into the agent's shell environment at session start:

```bash
# ~/.copilot-bridge/workspaces/alice/.env
APP_TOKEN=secret-value-here
APP_URL=https://my-app.local
```

### How it works

- Variables are **injected into each MCP server's `env` field** so the SDK passes them through to MCP server subprocesses
- The bridge also sets them in `process.env` during session creation (mutex-protected), but this is secondary — the CLI subprocess is long-lived and doesn't re-read `process.env` changes
- A mutex serializes session creation so concurrent agent startups don't leak env vars across agents

### Security guidance

The agent template instructs bots to treat `.env` as **write-only**:

- **Never read or display `.env` contents** — this keeps secret values out of the LLM context
- **Append-only pattern** for adding new keys:
  ```bash
  grep -q '^APP_TOKEN=' .env 2>/dev/null || echo "APP_TOKEN=" >> .env
  ```
- The user then fills in the actual secret value directly (not through chat)

## MCP server configuration

MCP (Model Context Protocol) servers are loaded in three layers, with later layers taking priority for servers with the same name:

1. **Plugins** (`~/.copilot/installed-plugins/**/.mcp.json`) — lowest priority
2. **User config** (`~/.copilot/mcp-config.json`) — overrides plugins
3. **Workspace config** (`<workspace>/mcp-config.json`) — highest priority, per-bot

The format matches the standard Copilot MCP config:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```

### Environment variable injection

Workspace `.env` vars are automatically injected into every local MCP server's `env` field. You don't need to duplicate them in `mcp-config.json`:

```
# .env
HOMEASSISTANT_URL=http://homeassistant.local:8123
HOMEASSISTANT_TOKEN=eyJ0eXAi...
```

The MCP server process receives these vars without any `env` block in the config. If you need to **remap** a variable name, use `${VAR}` expansion:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "uv",
      "args": ["run", "--project", "/path/to/ha-mcp", "ha-mcp"],
      "env": { "HASS_URL": "${HOMEASSISTANT_URL}" }
    }
  }
}
```

Priority: explicit `env` values in config override `.env` values for the same key. `${VAR}` expands from `.env` first, then `process.env`.

Non-conflicting server names from all layers are merged — a bot gets its workspace servers plus all global servers. If a workspace defines a server with the same name as a global one, the workspace version wins.

### Working directory

Local MCP server processes (type `stdio` or `local`) automatically run with `cwd` set to the bot's workspace directory. This ensures file-writing MCP tools create files in the workspace, not the bridge repo.

To override, set an explicit `cwd` in the server config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "cwd": "/custom/path"
    }
  }
}
```

Use cases:
- Give an admin bot access to GitHub MCP while keeping coding bots sandboxed
- Override global server settings (different args, env) per workspace
- Add project-specific tools only where they're needed

## DM auto-discovery

On startup, each bot queries the Mattermost API for its existing DM channels. New DMs are registered automatically — no config entry needed. The bot uses its default workspace, `triggerMode: "all"`, and `threadedReplies: false`.

When a user messages a bot for the first time (creating a new DM), the bridge discovers it via the WebSocket event and registers it on the fly.

## Session lifecycle

| Command | Behavior |
|---------|----------|
| `/new` | Destroys the current session and creates a fresh one |
| `/reload` | Detaches and re-attaches the same session (re-reads AGENTS.md, workspace config, MCP servers) |
| `/resume` | Lists past sessions for this workspace |
| `/resume <id>` | Switches to a specific past session |

Sessions persist in SQLite and resume across bridge restarts. The admin bot receives a "🔄 Gateway restarted." notice and is nudged to continue any interrupted work.

## Adding a new agent

The recommended flow is to ask the admin bot in chat. It will:

1. Collect the agent name, purpose, and bot token
2. Add the bot to `config.json` (with a backup)
3. Create the workspace directory
4. Write a customized `AGENTS.md`
5. Restart the bridge

You can also do this manually — see the admin template (`templates/admin/AGENTS.md`) for the detailed steps.

## Troubleshooting MCP servers

### Where are the logs?

MCP server output goes through the Copilot CLI subprocess stderr, which is written to `~/.copilot-bridge/copilot-bridge.log` (configured in the launchd plist):

```bash
# CLI subprocess stderr (includes MCP startup errors)
grep 'CLI subprocess' ~/.copilot-bridge/copilot-bridge.log | tail -20

# MCP loading messages from the bridge
grep 'MCP' ~/.copilot-bridge/copilot-bridge.log | tail -20

# General errors
grep -i 'error\|fail' ~/.copilot-bridge/copilot-bridge.log | tail -20
```

Bots can access this log file since it's in a readable path. Ask the bot to run these grep commands for self-diagnosis.

### MCP server loads but tools aren't visible

Common causes:

1. **Missing env vars** — The MCP server starts but can't connect to its backend, so it reports zero tools. Check that the workspace `.env` has the required vars. After fixing, tell the bot `/reload`.

2. **Server crash on startup** — Look for errors in the log: `grep 'CLI subprocess' ~/.copilot-bridge/copilot-bridge.log | grep -i error`. Test the server manually:
   ```bash
   cd ~/.copilot-bridge/workspaces/<bot>/
   source .env
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | <mcp-command> <mcp-args>
   ```

3. **`/reload` not run** — MCP config is read at session creation time. After changing `mcp-config.json` or `.env`, the bot needs `/reload` or `/new`.

### Verifying MCP server status

Use `/mcp` to see which servers are loaded and their source (global vs workspace). This confirms the bridge read the config correctly.
