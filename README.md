# copilot-bridge

<div align="center">
<img src="docs/images/copilot-bridge.png" alt="Copilot Bridge" width="200" height="200">
</div>

Bridge GitHub Copilot CLI to messaging platforms. Send messages from Mattermost (or other platforms) and get responses from Copilot sessions running on your machine.

> [!WARNING]
> This is all experimental.

```
Mattermost Channel → copilot-bridge → @github/copilot-sdk → Copilot CLI
     ↑                                                          ↓
     └──────────── streaming response (edit-in-place) ←─────────┘
```

## Features

- **Multi-bot support** — Run multiple bot identities on the same platform (e.g., `@copilot` for admin, `@alice` for tasks)
- **Workspaces** — Each bot gets an isolated workspace with its own `AGENTS.md`, `.env` secrets, and `MEMORY.md`
- **DM auto-discovery** — Just message a bot; no channel config needed for direct messages
- **Streaming responses** — Edit-in-place message updates with throttling
- **MCP & skills** — Auto-loads MCP servers and skill directories from Copilot config
- **Fuzzy model matching** — `/model opus` resolves to `claude-opus-4.6` (mobile-friendly)
- **Interactive permissions** — Approve/deny tool use via chat, or `/autopilot` to auto-approve
- **Session management** — `/reload` to refresh config, `/resume` to switch between sessions
- **Persistent preferences** — Model, agent, verbose mode, permissions saved per-channel

## Quick Start

1. **Prerequisites**: Node.js 20+, GitHub Copilot CLI installed and authenticated
2. **Install**: `npm install`
3. **Configure**: Copy `config.sample.json` to `~/.copilot-bridge/config.json` and add your Mattermost URL + bot token(s)
4. **Run**: `npx tsx src/index.ts`

For DMs, that's it — the bridge auto-discovers DM channels for each bot. For group channels, add a `channels` entry mapping the channel ID to a working directory. See [Configuration](docs/configuration.md) for details.

### Running as a service (macOS)

```bash
cp scripts/com.copilot-bridge.plist ~/Library/LaunchAgents/
# Edit paths in the plist if needed
launchctl load ~/Library/LaunchAgents/com.copilot-bridge.plist
```

Update and restart: `./scripts/deploy.sh`

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session |
| `/reload` | Reload session (re-reads AGENTS.md, config, MCP servers) |
| `/resume [id]` | List past sessions, or resume one by ID |
| `/model <name>` | Switch AI model (fuzzy match supported) |
| `/models` | List available models |
| `/agent <name>` | Switch custom agent (empty to deselect) |
| `/reasoning <level>` | Set reasoning effort (`low`/`medium`/`high`/`xhigh`) |
| `/verbose` | Toggle tool call visibility |
| `/status` | Show session info |
| `/approve` / `/deny` | Handle permission requests |
| `/remember` | Approve + persist the permission rule |
| `/autopilot` | Toggle auto-approve mode |
| `/help` | Show all commands |

## Documentation

- **[Configuration](docs/configuration.md)** — Platforms, channels, permissions, defaults
- **[Workspaces & Agents](docs/workspaces.md)** — Workspace system, .env secrets, templates, agent onboarding
- **[Architecture](docs/architecture.md)** — Source layout, message flow, adapter pattern, persistence

## License

MIT
