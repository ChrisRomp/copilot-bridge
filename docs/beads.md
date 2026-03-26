# Beads Integration Guide

[Beads](https://github.com/steveyegge/beads) (`bd`) is a distributed, Dolt-backed graph issue tracker designed for AI agent memory. This guide covers integrating Beads into a copilot-bridge workspace so agents can persist task context across session restarts.

## Why Beads Instead of MEMORY.md

`MEMORY.md` is a flat markdown file — simple, but limited:

| | `MEMORY.md` | Beads |
|---|---|---|
| Queryable | ❌ | ✅ `bd search`, `bd ready`, `bd blocked` |
| Dependency tracking | ❌ | ✅ `bd dep add` |
| Concurrency-safe | ❌ | ✅ Dolt atomic commits |
| Versioned / auditable | ❌ | ✅ Full Dolt history |
| Cross-session recovery | Manual | ✅ `bd prime` |
| Multi-bot coordination | ❌ | ✅ Shared Dolt server or remote sync |

## Prerequisites

- **`bd` CLI**: `npm install -g @beads/bd` or `brew install beads`
- **Dolt**: installed automatically when `bd` first runs — no manual setup needed
- Node.js 18+ (for `bd` CLI)

## Workspace Setup

### 1. Initialize Beads

Run from inside the workspace directory:

```bash
bd init --quiet --stealth
```

`--stealth` disables git hooks and git operations from Beads — required for copilot-bridge workspaces where the bot should not push git changes autonomously.

### 2. Configure the workspace `.env`

Add to `<workspace>/.env`:

```bash
BEADS_DIR=<workspace>/.beads
BEADS_ACTOR={{botName}}
PATH=/home/<user>/.local/bin:$PATH   # if dolt is not on system PATH
```

copilot-bridge auto-injects `.env` variables into all MCP server environments. The `BEADS_ACTOR` variable sets the actor name in the Beads audit trail — use the bot name for clear attribution.

### 3. Add the skill file

Copy `templates/agents/beads.agent.md` to the workspace's skill directory (typically `.github/agents/`):

```bash
cp templates/agents/beads.agent.md <workspace>/.github/agents/beads.agent.md
```

copilot-bridge automatically discovers and surfaces skill files in `.github/agents/` to the agent. The agent will use this to learn the `bd` workflow without any system prompt changes.

### 4. Update AGENTS.md (optional)

Add a brief Beads section to the workspace `AGENTS.md` so the agent knows to use it. The skill file (`beads.agent.md`) contains the full command reference — `AGENTS.md` just needs a pointer:

```markdown
## Task Memory (Beads)

This workspace uses Beads (`bd`) for persistent task tracking. See the `Beads Task Memory` skill for the full workflow. Use `bd prime` at session start and `bd backup export-git` at session end.
```

### 5. Add `bd` to workspace permissions (optional)

If using `permissionMode: "auto"`, add `bd` to the workspace allow list in `config.json`:

```json
"permissions": {
  "allow": ["shell(bd)"]
}
```

Or use the blanket `"shell"` allow if the workspace is fully trusted.

## Session Hook Automation (Recommended)

Rather than relying on the agent to remember to run `bd prime` and `bd backup export-git`, use copilot-bridge session hooks to automate them.

> **Note:** Session hooks require `allowWorkspaceHooks: true` in `~/.copilot-bridge/config.json`.

### hooks.json

Create `<workspace>/.github/hooks/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "./session-start.sh",
        "cwd": ".",
        "timeoutSec": 15
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "./session-end.sh",
        "cwd": ".",
        "timeoutSec": 30
      }
    ]
  }
}
```

### session-start.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

# Inject bd prime output as context at session start
input=$(cat)  # JSON from copilot-bridge: { "sessionId": "...", "channelId": "..." }

if command -v bd &>/dev/null; then
  bd prime 2>/dev/null || true
fi
```

### session-end.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)  # JSON from copilot-bridge: { "sessionId": "...", "channelId": "..." }

if command -v bd &>/dev/null; then
  bd backup export-git 2>/dev/null || true
fi
```

Make both scripts executable: `chmod +x session-start.sh session-end.sh`

## Sync Strategy

Beads provides three tiers of persistence:

| Tier | Command | Use case |
|------|---------|----------|
| **Local (automatic)** | *(none)* | Every write auto-commits to local Dolt history — always on |
| **Git branch backup** | `bd backup export-git` | JSONL snapshot to a git branch in the workspace repo — zero new infrastructure |
| **Full Dolt sync** | `bd dolt push` | Push to DoltHub, S3, GCS, or `git+ssh://` remote — multi-machine access |

**Recommended per scenario:**

- **Single bot, single machine**: `bd backup export-git` in `sessionEnd` hook — JSONL snapshots stored in the existing workspace git repo
- **Multi-machine / disaster recovery**: `bd dolt remote add origin git+ssh://git@github.com/org/repo.git` + `bd dolt push` in hook. Dolt stores its data under `refs/dolt/data` — invisible to normal git, compatible with any existing GitHub repo
- **Multiple bots on the same host**: set `BEADS_DOLT_SHARED_SERVER=1` in workspace `.env` — single shared Dolt server, each bot isolated in its own database

## MCP Alternative

For environments where the agent does not have shell access, `beads-mcp` provides the same functionality as a stdio MCP server:

```bash
uv tool install beads-mcp
```

Add to `<workspace>/mcp-config.json`:

```json
{
  "mcpServers": {
    "beads": {
      "command": "beads-mcp",
      "env": {
        "BEADS_WORKING_DIR": "{{workspacePath}}",
        "BEADS_ACTOR": "{{botName}}"
      }
    }
  }
}
```

> **Token cost**: `beads-mcp` exposes tool schemas that consume 10–50k tokens per session. The CLI approach via skill file is preferred for shell-capable agents.

## Troubleshooting

**`bd` can't find `dolt`**
Dolt installs to `~/.local/bin/` by default. Ensure this is on `PATH` in the workspace `.env`:
```bash
PATH=/home/<user>/.local/bin:$PATH
```

**Dolt server not starting**
```bash
bd doctor       # Check server health
bd dolt start   # Start manually
```

**`.beads/` not tracked by git**
`bd init --stealth` adds `.beads/` to `.git/info/exclude`. To commit Beads config files (e.g., `.beads/config.yaml`), remove that line:
```bash
grep -v "^\.beads" .git/info/exclude > /tmp/exclude && mv /tmp/exclude .git/info/exclude
```

Add Dolt binary data to `.gitignore` to avoid committing large files:
```
.beads/dolt/
.beads/*.db
```

## References

- [Beads GitHub](https://github.com/steveyegge/beads)
- [Beads ARCHITECTURE.md](https://github.com/steveyegge/beads/blob/main/docs/ARCHITECTURE.md)
- [Beads DOLT-BACKEND.md](https://github.com/steveyegge/beads/blob/main/docs/DOLT-BACKEND.md)
- [beads-mcp on PyPI](https://pypi.org/project/beads-mcp/)
- copilot-bridge issue [#157](https://github.com/ChrisRomp/copilot-bridge/issues/157) — integration tracking
