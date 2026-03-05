# Configuration

copilot-bridge is configured via a JSON file. The bridge checks these locations in order:

1. `$COPILOT_BRIDGE_CONFIG` environment variable
2. `~/.copilot-bridge/config.json`
3. `./config.json` (current working directory)

See [`config.sample.json`](../config.sample.json) for the full format.

## Platforms

Define your messaging platform connections and bot identities:

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "bots": {
        "copilot": { "token": "BOT_TOKEN_1", "admin": true },
        "alice": { "token": "BOT_TOKEN_2", "agent": "alice-agent" }
      }
    }
  }
}
```

Each bot needs a Mattermost bot account and token. Set `"admin": true` on the bot that should manage the bridge (create agents, edit config, restart).

### Single-bot shorthand

If you only need one bot, use `botToken` instead of `bots`:

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "botToken": "SINGLE_BOT_TOKEN"
    }
  }
}
```

## Channels

Channel entries map a specific Mattermost channel to a bot, working directory, and preferences:

```json
{
  "channels": [
    {
      "id": "channel-id-from-mattermost",
      "platform": "mattermost",
      "bot": "copilot",
      "name": "My Project",
      "workingDirectory": "/path/to/project",
      "model": "claude-sonnet-4.6",
      "triggerMode": "mention",
      "threadedReplies": true,
      "verbose": false
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Mattermost channel ID |
| `platform` | Yes | Platform name (e.g., `mattermost`) |
| `bot` | Yes | Bot identity to use |
| `name` | No | Human-readable label (for logs) |
| `workingDirectory` | Yes | Local path for the Copilot session |
| `model` | No | AI model override |
| `agent` | No | Custom agent name |
| `triggerMode` | No | `"mention"` (default) or `"all"` |
| `threadedReplies` | No | Use threaded replies (default: `true`) |
| `verbose` | No | Show tool calls (default: `false`) |

### When do you need a channel entry?

**You don't need one for DMs.** The bridge auto-discovers DM channels for each bot at startup. DMs default to `triggerMode: "all"`, `threadedReplies: false`, and the bot's default workspace (`~/.copilot-bridge/workspaces/<botname>/`).

**You need a channel entry when:**
- You want to point a DM at a custom `workingDirectory` (overriding the default workspace)
- You're using a group/team channel (non-DM)
- You want `triggerMode: "mention"` so the bot only responds when @-mentioned

## Defaults

Fallback values for any setting not specified per-channel:

```json
{
  "defaults": {
    "model": "claude-sonnet-4.6",
    "agent": null,
    "triggerMode": "mention",
    "threadedReplies": true,
    "verbose": false,
    "permissionMode": "interactive"
  }
}
```

## Permissions

Config-level permission rules use Copilot CLI-compatible syntax:

```json
{
  "permissions": {
    "allow": [
      "read",
      "shell(ls)",
      "shell(cat)",
      "vault-search",
      "context7"
    ],
    "deny": [
      "shell(rm)",
      "shell(git push)"
    ],
    "allowPaths": [],
    "allowUrls": [
      "docs.github.com",
      "stackoverflow.com"
    ]
  }
}
```

### Permission syntax

| Pattern | Matches |
|---------|---------|
| `"read"` | All file reads |
| `"write"` | All file writes |
| `"shell(ls)"` | The `ls` command |
| `"shell(git *)"` | Any git command |
| `"vault-search"` | All tools from that MCP server |
| `"vault-search(search)"` | Only the `search` tool from that server |

### Permission resolution order

1. **Config deny rules** — checked first, always wins
2. **Config allow rules** — if matched, auto-approved
3. **SQLite stored rules** — from `/remember` in chat (MCP rules save at server level)
4. **Interactive prompt** — asks the user in chat with approve/deny reactions

Use `/autopilot` in chat to auto-approve everything for a channel (useful during active development).
