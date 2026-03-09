# Setup Guide

This guide walks you through installing and configuring copilot-bridge from scratch. If you prefer an interactive experience, run `npm run init` after cloning — it automates most of these steps.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org/) |
| **GitHub Copilot CLI** | latest | `gh extension install github/gh-copilot` or [standalone install](https://github.com/github/copilot-cli) |
| **Mattermost** | 7+ | Self-hosted or cloud instance with admin access to create bots |

### Authentication

The Copilot CLI needs a valid GitHub token. Any of these methods work (checked in priority order):

| Method | How | Best for |
|--------|-----|----------|
| **Environment variable** | `export COPILOT_GITHUB_TOKEN=ghp_...` | Automation, CI, server deployments |
| **GitHub CLI** | `gh auth login` | Development machines with `gh` installed |
| **Copilot CLI** | `copilot auth login` | Standalone CLI installs |

Environment variables: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` (first one found wins).

> [!TIP]
> **BYOK (Bring Your Own Key)**: The SDK also supports using your own API keys from OpenAI, Anthropic, Azure AI Foundry, etc. — no Copilot subscription needed. See [issue #48](https://github.com/ChrisRomp/copilot-bridge/issues/48) for status.

## Installation

```bash
git clone https://github.com/ChrisRomp/copilot-bridge.git
cd copilot-bridge
npm install
```

## Configuration

### Interactive Setup (Recommended)

```bash
npm run init
```

The wizard walks you through:
1. Prerequisite validation
2. Mattermost URL and bot token setup (validates via API)
3. Channel configuration
4. Default settings (model, trigger mode, threading)
5. Config file generation
6. Optional service installation

### Manual Setup

#### 1. Create the config directory

```bash
mkdir -p ~/.copilot-bridge
```

#### 2. Create `config.json`

Copy the sample and edit it:

```bash
cp config.sample.json ~/.copilot-bridge/config.json
```

**Minimal config (single bot, DMs only):**

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "botToken": "YOUR_BOT_TOKEN"
    }
  },
  "channels": []
}
```

With an empty `channels` array, the bridge still works — it auto-discovers DM conversations.

**Multi-bot with group channels:**

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "bots": {
        "copilot": { "token": "TOKEN_1", "admin": true },
        "alice": { "token": "TOKEN_2", "agent": "alice-agent" }
      }
    }
  },
  "channels": [
    {
      "id": "CHANNEL_ID",
      "name": "my-project",
      "platform": "mattermost",
      "bot": "copilot",
      "workingDirectory": "/path/to/project"
    }
  ],
  "defaults": {
    "model": "claude-sonnet-4.6",
    "triggerMode": "mention",
    "threadedReplies": true,
    "verbose": false
  }
}
```

See [Configuration](docs/configuration.md) for the full reference.

#### 3. Create Mattermost bot accounts

In Mattermost as an admin:

1. Go to **System Console** → **Integrations** → **Bot Accounts**
2. Click **Add Bot Account**
3. Set username (e.g., `copilot`), display name, and description
4. Save and copy the **bot token**
5. Paste the token into your `config.json`

For group channels, add the bot to each channel:
- Open the channel → **Channel Settings** → **Members** → **Add Members** → search for the bot

> [!NOTE]
> DMs don't require any channel setup — just message the bot directly.

#### 4. Find channel IDs

For group channels, you need the Mattermost channel ID:
- In Mattermost, open the channel
- Click the channel name → **View Info**
- Copy the **ID** field

## Validate Your Setup

```bash
npm run check
```

This verifies everything end-to-end:

```
🔍 copilot-bridge check

Prerequisites
✅ Node.js v22.0.0
✅ GitHub Copilot CLI (v1.0.2)
✅ GitHub authenticated (via gh CLI)

Configuration
✅ Config: ~/.copilot-bridge/config.json
✅ Config structure (platforms.mattermost present)

Mattermost
✅ Mattermost: https://chat.example.com (reachable)
✅ Bot "copilot" (token valid, admin)

Channels (from config)
✅ Channel "my-project" (accessible)
...

All checks passed!
```

## Running the Bridge

### From source (development)

```bash
npm run dev
```

This starts in watch mode — restarts automatically when source files change. You'll see logs in the terminal.

### From source (production)

```bash
npm run build
npm start
```

> [!NOTE]
> `npm run dev` and `npm run build` are for running from a cloned repo. If you installed via a package, use the package's entry point directly (e.g., `npx copilot-bridge`).

## Running as a Service

The bridge should run persistently so it's always available in chat. Use the appropriate method for your OS.

### macOS (launchd)

The `npm run init` wizard can install this automatically. To do it manually:

```bash
cp scripts/com.copilot-bridge.plist ~/Library/LaunchAgents/
```

Edit the plist to update paths:
- `WorkingDirectory` → your copilot-bridge clone path
- `HOME` → your home directory
- `PATH` → ensure it includes your Node.js install location

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.copilot-bridge.plist
```

To check status:

```bash
launchctl list com.copilot-bridge
```

To restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.copilot-bridge
```

> [!WARNING]
> **Never use `launchctl unload` to restart** — if the bridge is running your session, `unload` kills it and the subsequent `load` never executes.

### Linux (systemd)

The `npm run init` wizard can install the service automatically. To do it manually:

```bash
# Build first — systemd runs the compiled output
npm run build

# Install the service
sudo cp scripts/copilot-bridge.service /etc/systemd/system/
```

Edit `/etc/systemd/system/copilot-bridge.service`:
- `ExecStart` → path to `node` and your `dist/index.js`
- `WorkingDirectory` → your copilot-bridge clone path
- Add `User=youruser` under `[Service]`
- `HOME` → that user's home directory

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now copilot-bridge
```

> [!TIP]
> **Let Copilot help with service setup.** The paths in service files are environment-specific. If you have the Copilot CLI installed, ask it:
> ```
> Help me configure the copilot-bridge systemd service file at /etc/systemd/system/copilot-bridge.service.
> My copilot-bridge is cloned at /path/to/copilot-bridge, Node.js is at $(which node),
> and it should run as my user.
> ```

Management commands:

```bash
sudo systemctl status copilot-bridge        # status
sudo journalctl -u copilot-bridge -f        # logs
sudo systemctl restart copilot-bridge       # restart
```

## What Happens on First Run

When the bridge starts for the first time:

1. **Config loaded** from `~/.copilot-bridge/config.json`
2. **SQLite database** created at `~/.copilot-bridge/state.db`
3. **Workspaces** initialized at `~/.copilot-bridge/workspaces/<botname>/` with files generated from templates:
   - `AGENTS.md` — system prompt defining the bot's role, tools, and constraints. Admin bots get an admin-specific template with bridge management capabilities; regular bots get a sandboxed template. **Customize this file** to shape your bot's behavior.
   - `MEMORY.md` — persistent memory file the bot can read/write across sessions
   - These files are only created if they don't already exist — your customizations are safe across restarts
4. **WebSocket connected** to Mattermost
5. **Listening** for messages

The bridge is ready when you see the "listening for messages" log.

### File layout

After first run, your `~/.copilot-bridge/` directory looks like this:

```
~/.copilot-bridge/
├── config.json                 # Bridge configuration
├── state.db                    # SQLite database (sessions, prefs, permissions)
└── workspaces/
    ├── copilot/                # One directory per bot
    │   ├── AGENTS.md           # System prompt (from templates/admin/ or templates/agents/)
    │   └── MEMORY.md           # Persistent memory file
    ├── alice/
    │   ├── AGENTS.md
    │   └── MEMORY.md
    └── ...
```

The `AGENTS.md` and `MEMORY.md` files are generated from the templates in the repo's `templates/` directory — admin bots use `templates/admin/`, regular bots use `templates/agents/`. Once created, they're yours to customize; the bridge won't overwrite them.

## Next Steps

- **Customize your bot**: Edit `~/.copilot-bridge/workspaces/<botname>/AGENTS.md` to define the bot's personality and capabilities
- **Add MCP servers**: Configure external tools in `~/.copilot/mcp-config.json` (user-level, shared with Copilot CLI)
- **Set up permissions**: Use the `/autopilot` command in chat, or configure `permissions` in `config.json`
- **Explore commands**: Type `/help` in chat to see all available slash commands

See the [full configuration reference](configuration.md) and [architecture overview](architecture.md) for deeper details.

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|-----|
| "Config file not found" | Missing config | Run `npm run init` or copy `config.sample.json` to `~/.copilot-bridge/config.json` |
| Bot doesn't respond | Token invalid or bot not in channel | Run `npm run check` to diagnose |
| "WebSocket closed" | Bad Mattermost URL or token | Verify URL and token in config |
| Copilot errors on first message | CLI not authenticated | Set `COPILOT_GITHUB_TOKEN` or run `gh auth login` |
| Service won't start | Wrong paths in service file | Check `WorkingDirectory` and `ExecStart` paths |
| Permission denied on files | Agent working outside workspace | Grant access via `allowPaths` in config or admin `grant_path_access` tool |

Run `npm run check` at any time to validate your entire setup.
