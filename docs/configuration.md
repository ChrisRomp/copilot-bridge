# Configuration

copilot-bridge is configured via a JSON file. The bridge checks these locations in order:

1. `$COPILOT_BRIDGE_CONFIG` environment variable
2. `~/.copilot-bridge/config.json`
3. `./config.json` (current working directory)

See [`config.sample.json`](../config.sample.json) for the full format.

## Hot Reload

The bridge watches `config.json` for changes and hot-applies safe settings automatically — no restart needed for most edits.

**Hot-reloadable (applied immediately):**
- Channel settings: `triggerMode`, `threadedReplies`, `verbose`, `model`, `agent`
- Defaults: `model`, `agent`, `triggerMode`, `threadedReplies`, `verbose`, `permissionMode`
- Permissions: `allow`, `deny`, `allowPaths`, `allowUrls`
- Bot config: `agent`, `admin` flag, `access` (user allowlist/blocklist)
- Platform-level `access` (user allowlist/blocklist)
- New channel entries

**Restart required (config updates but adapters keep old values):**
- Platform `url` changes (adapter caches URL at construction)
- Bot `token` changes (adapter caches token at construction)
- Adding/removing platforms or bots (needs new adapter + WebSocket connection)

On reload failure (invalid JSON, validation errors), the existing config is preserved. The bridge logs what changed and warns about restart-needed fields.

**Manual reload:** Use `/reload config` to trigger a reload without waiting for the file watcher. This shows exactly what changed.

## Platforms

Only platforms defined in this section are loaded — if a platform isn't listed here, the bridge won't attempt to connect to it, even if the corresponding adapter package is installed.

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

Each bot needs a platform bot account and token. Set `"admin": true` on the bot that should manage the bridge — admin bots get extra tools (`grant_path_access`, workspace management, config editing) and use the admin AGENTS.md template. This is a bridge-level setting, not a platform permission. If you only have one bot, make it admin.

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

## User Access Control

Control which users can interact with bots using the `access` block. Access can be set at **platform level** (inherited by all bots) and/or **bot level** (grants additional users for that bot).

**Allowlists are additive** — a user is allowed if they appear in the platform allowlist OR the bot allowlist. Platform users inherit access to all bots; bot-level users only get access to that specific bot. **Blocklists always win** — a blocked user is denied regardless of allowlists at either level.

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "access": {
        "mode": "allowlist",
        "users": ["chris"]
      },
      "bots": {
        "copilot": {
          "token": "BOT_TOKEN"
        },
        "alice": {
          "token": "BOT_TOKEN_2",
          "access": {
            "mode": "allowlist",
            "users": ["alex"]
          }
        },
        "bob": {
          "token": "BOT_TOKEN_3"
        }
      }
    }
  }
}
```

In this example:
- **chris** can talk to all bots (platform allowlist inherited everywhere)
- **alex** can only talk to **alice** (bot-level allowlist on alice)
- **bob bot**: no bot-level access, so only platform users (chris) can use it

### Access modes

| Mode | Behavior | Default? |
|------|----------|----------|
| `"allowlist"` | Only listed users can use the bot | — |
| `"blocklist"` | Everyone **except** listed users | — |
| `"open"` | All users can use the bot | — |

### Resolution logic

Access is **additive** across levels:

- **Neither level configured** → deny all (secure by default)
- **Only platform configured** → platform decides alone
- **Only bot configured** → bot decides alone
- **Both configured (allowlists)** → user passes if listed at **either** level (union)
- **Blocklist at any level** → always denies matched users, regardless of allowlists

This means platform allowlist users inherit access to every bot, while bot-level allowlists can grant additional users for specific bots.

> ⚠️ **Breaking change (v0.8.0):** Previously, missing `access` defaulted to open. Now, if no `access` block exists at either level, all users are denied. Add `"access": { "mode": "open" }` at the platform or bot level to restore the previous behavior, or run `copilot-bridge init` to configure access during setup.

### User identification

- **Mattermost**: Use the Mattermost username (handle). Case-insensitive. Leading `@` is stripped automatically.
- **Slack**: Use the Slack user ID (e.g., `U12345ABC`). During `init`, you can enter a Slack handle and it will be resolved to a UID via the Slack API. Handles manually added to the config are resolved to UIDs on startup.

The access check matches each entry against both the user's platform ID and username, so either format works.

> **Note:** Bot-level access control requires the `bots` config format (not the `botToken` shorthand). Platform-level access works with both formats.

### Denied user behavior

Messages from unauthorized users are **silently dropped** — no response is sent. Drops are logged at `DEBUG` level for troubleshooting.

### Hot-reload

Access config changes are hot-reloadable — edits take effect after `/reload config` or automatic file watcher pickup, with no restart needed.

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
| `fusionTier` | No | `standard`, `high`, `max`, or `default`; used with Copilot `auto`/`fusion`, subject to live model policy |
| `fallbackModels` | No | Ordered list of fallback models if the primary is unavailable |
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
    "fallbackModels": ["claude-sonnet-4.5"],
    "agent": null,
    "triggerMode": "mention",
    "threadedReplies": true,
    "verbose": false,
    "permissionMode": "interactive"
  }
}
```

## Copilot Fusion

Use `/fusion [standard|high|max|default]`, `/model fusion [tier]`, or `/model auto [tier]`. All select the same Copilot routing mode; bare commands reuse the saved tier. `/auto` remains the alias for `/autopilot`, not model selection. Provider-qualified BYOK model names are unaffected. Fusion routes only among Copilot models. Selecting it from a BYOK model starts a new Copilot session, as with any provider switch, and the BYOK model stays selected if Fusion selection fails.

Set `"model": "auto"` (or `"fusion"`) and optionally `"fusionTier": "high"` in `defaults` or a channel entry. A saved channel choice overrides configuration. Fusion commands save the model selection even when already inherited from configuration; automatic pre-send preparation does not. An absent/null saved tier inherits configuration; explicit `"default"` uses the provider's default, which is not necessarily Standard.

`/model` lists advertised tiers and their availability, including policy-blocked tiers and their reasons. Picker-hidden/integrator tiers are not advertised. The bridge discovers mappings from runtime metadata rather than hardcoding routing IDs or assuming every account permits all tiers. Explicit unavailable selections fail without changing the model. If a previously saved tier becomes unavailable, the bridge requests provider-default routing and notifies the user; if discovery or the default is unavailable, it reports an error instead of inventing a substitute. An unavailable inherited tier also uses provider-default routing without saving a channel override, so later configuration changes or restored availability still take effect.

Tier changes may be **pending** until a successful turn. `/status` shows, for example, **Model: Copilot Fusion (Standard)** with **Pending tier: High**, separately from the concrete model executing work. `/config` shows saved intent and its source. Accepted intent survives `/new` and restart. A failed new activation restores the prior tier preference and reports the failure; it is not retried automatically. If a restart loses the outcome of an already-attempted change, the bridge restores the previous preference conservatively and notifies the user.

Model-use notices appear even with verbose off: for example, Fusion using one model for work and another for review. They do not replace the answer stream. Quiet scheduled tasks log them instead; streamer mode redacts hidden and unknown model identities. High/Max internal drafts and review messages are withheld until the SDK marks an authoritative committed answer. Standard retains normal streaming.

`/reasoning` remains model effort, not Fusion tier. Fusion manages effort and context; select a fixed model to change those controls. Existing fixed-model effort/context preferences are preserved. Aggregate Fusion context percentages are not shown because they are not a reliable single-model measurement.

Configured `fallbackModels` still apply to eligible inference failures, but not tier-policy/discovery failures. Fusion support does not enable the separate native fixed-model-to-Auto recovery feature or alter assisted-permission policy.

### SDK compatibility and live checks

The bridge stays on stable SDK 1.0.31 and CLI 1.0.109, using the existing Auto-tier APIs behind public Fusion names. `src/core/fusion.ts` and the typed bridge wrapper isolate routing mappings so a future native Fusion API upgrade does not require changing commands or preferences.

Normal `npm test` uses deterministic mocks/fixtures and skips the native integration suite. To check the actual pinned CLI host with isolated configuration and a real extension:

```bash
COPILOT_BRIDGE_FUSION_LIVE=1 npx vitest run src/core/fusion.integration.test.ts
```

Add `COPILOT_BRIDGE_FUSION_INFERENCE=1` to exercise real Standard/High/Max turns and committed output/model notices. These checks require the operator's existing Copilot authentication, consume inference quota when enabled, and only exercise tiers the account currently permits. They do not change production channel models, CLI settings, or permissions. The suite cleans up its own temporary workspaces, database, and processes. Ordinary CI does not prove live account policy or provider behavior.

Custom state backends must round-trip the optional `fusionTier` and `fusionTransition` fields in `ChannelPrefs`, including `fusionTransition.previousOverride` (null restores inheritance). The bridge verifies persistence rather than silently dropping accepted intent. Older transitions without `previousOverride` retain their recorded previous preference.

## Permissions

`defaults.permissionMode` accepts `"interactive"` (manual, the default), `"assisted"`, or `"autopilot"` (the legacy configuration name for **yolo**, not the autonomous session mode). `/permissions` shows the current mode and describes all three available modes with commands to select them. `/permissions manual|assisted|yolo` overrides it per channel. `/assisted [on|off]` switches between assisted and manual; `/yolo` switches between yolo and manual.

`/permissions ask` is an alias for `manual`; `/permissions assist` and `/permissions ai` are aliases for `assisted`; `/permissions allow-all` is an alias for `yolo`. Aliases retain the same bridge safety checks and do not change the SDK's autonomous session mode.

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
| `"shell"` | All shell commands |
| `"shell(ls)"` | The `ls` command |
| `"shell(git push)"` | `git push` (any args) |
| `"shell(open -a Obsidian)"` | Commands starting with `open -a Obsidian` |
| `"vault-search"` | All tools from that MCP server |
| `"vault-search(search)"` | Only the `search` tool from that server |

### Permission resolution order

For requests delivered to the bridge's permission handler:

1. **Hardcoded safety denies** — blocks destructive commands, including in yolo.
2. **Bridge custom tools** — trusted bridge tools enforce their own access boundaries.
3. **Yolo mode** — approves remaining requests, skipping config and stored rules.
4. **Config rules** — denies before allows, followed by workspace/path grants.
5. **Stored rules** — from `/always approve` or `/always deny` in chat (MCP rules save at server level).
6. **Assisted review** — when enabled, an eligible AI judge approval permits the action.
7. **Unresolved request** — prompts interactively, or denies without prompting in assisted autopilot and quiet scheduled turns.

Use `/yolo` in chat to auto-approve all permissions (hardcoded safety denies still apply). Use `/autopilot` to enable the SDK's autonomous agentic loop — the agent works continuously until the task is done. Use `/plan` to toggle plan mode for structured planning before implementation. These are independent: `/yolo` controls permissions, `/autopilot` and `/plan` control agent behavior.

Use `/always approve` or `/always deny` during a permission prompt to persist the rule. Use `/rules` to see all permission rules (hardcoded, config, and stored).

### Assisted permissions and unattended work

Assisted mode uses the SDK's default safety-review model and instructions. Judge failures, exclusions, sandbox-bypass requests, and requests requiring human approval are not treated as approvals. Interactive permission prompts include the review reason. Assisted autopilot returns a denial instead of stopping for approval, allowing the agent to try alternatives. Manual permissions combined with `/autopilot` retain their existing prompt behavior; autopilot does not implicitly enable yolo.

Copilot can settle unattended permissions without calling the bridge. The bridge keeps remembered rules in its state store and synchronizes supported rules into the individual SDK session. It does **not** export them to the operator's `permissions-config.json`: that file stores project-scoped approvals, not denies, and could share grants between channels using the same workspace. Rule translation limitations are reported rather than silently broadening approvals. Bridge-only predicates are not guaranteed to run on runtime-settled requests.

Supported projections include simple shell identifiers, validated config command prefixes, and MCP server/tool rules. Remembered blanket shell allows, wrapper approvals, overlapping rules whose precedence cannot be preserved, and unsupported patterns are withheld with a concise chat notice. Individual limitations and affected rules remain in the bridge logs for diagnosis; `/rules` lists saved rules but does not mark translation gaps. Native path/URL managers are left unchanged: path eligibility is not the same as the bridge's path-scoped write approval. Built-in shell tools also reuse the bridge hard-deny predicates through a pre-tool hook, including command arguments rewritten by existing hooks.

Judge approvals and unattended denials produce short chat notices only in verbose mode, based on final permission decisions and without interrupting the response stream. Decisions are always logged; quiet scheduled tasks never post these notices, even with verbose enabled. Policy limitation notices and permission prompts do not require verbose mode. Scheduled prompts are tagged as automation and inter-agent messages as agent-originated input, not human authorization. Inter-agent sessions retain their existing noninteractive rule handling; they do not enable assisted mode.

Native rule-settled actions do not emit the permission events used for judge notices; this is not a complete audit feed of every policy decision. Provenance tags identify the sender type, not an independent authorization boundary.

Mode and policy are reapplied on session creation/resume and relevant changes. Permission synchronization failures are surfaced, not silently treated as a successful mode change. `/implement yolo` temporarily switches permissions in memory while keeping the previous mode persisted, so a restart never retains the temporary elevation. Scheduled execution stays unattended until completion or confirmed abort, independently of quiet output's timeout.

## Inter-Agent Communication

The `ask_agent` tool allows bots to communicate with each other. When enabled, any agent can ask another agent a question by creating a fresh ephemeral session for the target bot.

**Disabled by default.** Add `interAgent` to your config to enable:

```json
{
  "interAgent": {
    "enabled": true,
    "defaultTimeout": 60,
    "maxTimeout": 300,
    "maxDepth": 3,
    "allow": {
      "max": { "canCall": ["alice"], "canBeCalledBy": ["alice"] },
      "alice": { "canCall": ["max"], "canBeCalledBy": ["max"] },
      "summarizer": { "canCall": [], "canBeCalledBy": ["*"] }
    }
  }
}
```

### Config Options

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for inter-agent communication |
| `defaultTimeout` | `60` | Default timeout in seconds for ephemeral calls |
| `maxTimeout` | `300` | Maximum timeout the calling agent can request |
| `maxDepth` | `3` | Maximum call chain depth (A→B→C = depth 2) |
| `allow` | — | Per-bot allowlist: `canCall` and `canBeCalledBy` arrays. Use `"*"` for any bot. |

### How It Works

1. Agent Max calls `ask_agent({ target: "alice", message: "What's the thermostat set to?" })`
2. The bridge validates the allowlist (Max can call Alice, Alice accepts calls from Max)
3. A fresh ephemeral session is created using Alice's workspace, AGENTS.md, MCP servers, and skills
4. The target session receives a system prompt listing all of Alice's project workspaces (workspace awareness)
5. Alice's session processes the message and returns the response as tool output to Max
6. The ephemeral session is torn down

### Tool Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `target` | ✅ | Bot name to ask (e.g., `"alice"`) |
| `message` | ✅ | The question or request |
| `agent` | | Specific `*.agent.md` persona in the target's `agents/` directory |
| `timeout` | | Timeout in seconds (capped at `maxTimeout`) |
| `autopilot` | | Auto-approve permissions in the ephemeral session (default: `false`) |
| `denyTools` | | Tools to deny in the ephemeral session (e.g., `["bash"]`) |
| `grantTools` | | Tools to pre-approve (only if the caller also has them approved) |

### Custom Agent Definitions

Place `*.agent.md` files in a bot's workspace `agents/` directory:
```
~/.copilot-bridge/workspaces/alice/agents/network.agent.md
~/.copilot-bridge/workspaces/alice/agents/hvac.agent.md
```

Call with `ask_agent({ target: "alice", agent: "network", message: "..." })` to activate a specific persona.

### Workspace Awareness

When a bot serves multiple channels with different working directories, the ephemeral session automatically receives a workspace map listing all of the target bot's projects. The target bot can reason about which project is relevant to the question — no channel parameter needed.

### Loop Prevention

Three layers prevent infinite loops:
1. **Visited set** — A bot cannot appear twice in the same call chain (catches A→B→A immediately)
2. **Depth cap** — Hard limit on call chain length (default: 3)
3. **Config allowlist** — Only explicitly permitted call paths are allowed

### Permission Model

Ephemeral sessions use merged permissions: the target bot's own rules plus the caller's approved permissions as supplementary grants. Hardcoded safety denies always apply. If `autopilot: false` (default) and a permission can't be resolved, the call returns an error to the caller with detail about what was blocked.

### Audit

All inter-agent calls are logged to SQLite (`agent_calls` table) with caller, target, duration, success/failure, and call chain metadata.

## Hooks

Session hooks let you run shell commands at key lifecycle points — before/after tool calls, on user prompts, session start/end, and errors. Hooks use the [official GitHub Copilot CLI hooks format](https://docs.github.com/en/copilot/reference/hooks-configuration).

### hooks.json Format

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "./scripts/guard.sh",
        "cwd": ".",
        "timeoutSec": 10
      }
    ]
  }
}
```

Each hook is an array of command objects. Multiple commands per hook type run in sequence.

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"command"` |
| `bash` | Yes* | Shell command to run (use `powershell` on Windows) |
| `cwd` | No | Working directory, relative to the hooks.json location |
| `timeoutSec` | No | Max execution time (default: 30s) |
| `env` | No | Extra environment variables |

### Hook Input/Output

Hooks receive JSON on **stdin** describing the event (tool name, arguments, etc.) and return JSON on **stdout**. For `preToolUse`, the output controls whether the tool runs:

```json
{ "permissionDecision": "allow" }
```

```json
{ "permissionDecision": "deny", "permissionDecisionReason": "Blocked by policy" }
```

```json
{ "permissionDecision": "ask", "permissionDecisionReason": "Confirm before running" }
```

- **`allow`** — tool proceeds normally (this is also the default if the hook returns nothing)
- **`deny`** — tool is blocked; the reason is shown to the agent
- **`ask`** — the bridge prompts the user for approval in chat (approve/deny only; "always" and "remember" are not offered for hook-triggered prompts)

For `preToolUse`, if multiple commands are registered, the first `"deny"` or `"ask"` short-circuits (precedence: deny > ask > allow).

### Example Hook Script

```bash
#!/bin/bash
# guard-main-push.sh — Block git push to main branch
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.toolName // empty')
COMMAND=$(echo "$INPUT" | jq -r '.toolArgs.command // empty')

if [ "$TOOL" = "bash" ] && echo "$COMMAND" | grep -q "git push.*main"; then
  echo '{"permissionDecision":"deny","permissionDecisionReason":"Push to main blocked by hook"}'
else
  echo '{"permissionDecision":"allow"}'
fi
```

### Available Hook Types

| Hook Type | When it Fires |
|-----------|--------------|
| `preToolUse` | Before tool execution (can allow/deny/ask) |
| `postToolUse` | After tool execution |
| `userPromptSubmitted` | When user sends a message |
| `sessionStart` | Session created or resumed |
| `sessionEnd` | Session ends |
| `errorOccurred` | Error occurs |

### Discovery Order

Hooks are loaded from multiple locations (lowest to highest priority). Commands from all sources are appended, not overridden:

1. **Plugin hooks** — `~/.copilot/installed-plugins/.../hooks.json`
2. **User hooks** — `~/.copilot/hooks.json`
3. **Workspace hooks** — `<workspace>/.github/hooks/hooks.json`, `<workspace>/.github/hooks.json`, or `<workspace>/hooks.json` (**disabled by default**)

> **Security note:** Workspace hooks execute arbitrary code. They are disabled by default to prevent untrusted repositories from running code automatically. To enable, set `"allowWorkspaceHooks": true` in the `defaults` section of your bridge config.

### Viewing Loaded Hooks

Use `/tools` in chat to see which hooks are currently loaded and how many commands are registered per hook type.

## Database

By default, the bridge uses SQLite at `~/.copilot-bridge/state.db`. The state layer is pluggable — you can swap in a custom backend (Postgres, Redis, etc.) by pointing `database.module` at a module that exports a class implementing the `StateStore` interface.

```json
{
  "database": {
    "module": "./path/to/custom-store.js",
    "options": { "connectionString": "postgresql://..." }
  }
}
```

- **`module`** — Path to a JS module. Must export a class (default export, named `StateStore` export, or the module itself) that implements the `StateStore` interface. See [StateStore interface](../src/state/types.ts) for the contract.
- **`options`** — Arbitrary object passed to the custom store's constructor.

When `database` is omitted (the default), the built-in `SqliteStateStore` is used with no additional configuration.
