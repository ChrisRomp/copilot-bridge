# Architecture

## Source layout

```
src/
├── index.ts                    # Main orchestrator, event routing, admin nudge
├── config.ts                   # Config loading and validation
├── config.test.ts              # Config validation tests
├── logger.ts                   # Structured logging (timestamp + level + tag)
├── types.ts                    # Shared type definitions
├── core/
│   ├── bridge.ts               # CopilotClient wrapper (SDK interface)
│   ├── channel-idle.ts         # Debounced idle detection & waiter queue
│   ├── channel-idle.test.ts    # Idle detection tests
│   ├── command-handler.ts      # Slash command parsing with fuzzy model matching
│   ├── inter-agent.ts          # Bot-to-bot communication
│   ├── inter-agent.test.ts     # Inter-agent tests
│   ├── onboarding.ts           # Project creation & channel setup tools
│   ├── scheduler.ts            # Cron + one-off task scheduling
│   ├── session-manager.ts      # Session lifecycle, permissions, MCP/skill loading, .env
│   ├── steering.test.ts        # Steering logic tests
│   ├── stream-formatter.ts     # SDK event → chat message formatting
│   ├── thread-utils.ts         # Thread-aware reply resolution
│   ├── thread-utils.test.ts    # Thread utils tests
│   └── workspace-manager.ts    # Workspace creation, template rendering, directory sync
├── channels/
│   └── mattermost/
│       ├── adapter.ts          # Mattermost WebSocket + REST adapter
│       └── streaming.ts        # Edit-in-place streaming with throttle
└── state/
    └── store.ts                # SQLite persistence (sessions, prefs, permissions)
```

## Message flow

1. `MattermostAdapter` receives a WebSocket event and normalizes it to `InboundMessage`
2. `index.ts` serializes handling per channel via promise chains (`channelLocks`), checks for slash commands, then forwards to `SessionManager.sendMessage()`
3. `SessionManager` creates or resumes a `CopilotSession` via `CopilotBridge` (SDK wrapper), wiring up permission and user-input handlers
4. SDK session events flow back through `sessionManager.onSessionEvent()` → `handleSessionEvent()` in index.ts
5. `StreamFormatter` converts SDK events to `FormattedEvent`, which are routed to `StreamingHandler` for edit-in-place message updates

## Event serialization

Both inbound messages and session events are serialized per-channel via separate promise chains (`channelLocks` and `eventLocks`). This prevents race conditions on stream auto-start and permission resolution.

## Streaming

`StreamingHandler` manages edit-in-place messages with throttled updates (500ms):

- One stream is created per user message; it persists across tool cycles
- Streams finalize only on `session.idle` (not `turn_end`, which fires between tool cycles)
- In verbose mode, tool calls accumulate in a separate "activity feed" message that updates in place

## Channel adapter pattern

New platforms implement the `ChannelAdapter` interface (defined in `src/types.ts`). The Mattermost adapter is the reference implementation.

Required methods:

- `connect()` / `disconnect()` — WebSocket lifecycle
- `sendMessage()` / `updateMessage()` / `deleteMessage()` — Message operations
- `replyInThread()` — Thread-aware replies
- `setTyping()` — Typing indicator
- `onMessage()` / `onReaction()` — Callbacks for inbound events
- `downloadFile()` / `sendFile()` — File transfer
- `getBotUserId()` — Bot identity for mention detection

Optional methods:

- `addReaction()` — Emoji reactions (best-effort, should not throw)
- `createChannel()` / `addUserToChannel()` — Channel management
- `getTeams()` / `getChannelByName()` — Team/channel discovery
- `discoverDMChannels()` — DM channel enumeration

## Persistence

SQLite database at `~/.copilot-bridge/state.db` (WAL mode) via `src/state/store.ts`:

- **channel_sessions** — Maps channels to active Copilot session IDs
- **channel_prefs** — Per-channel preferences (model, agent, verbose, trigger mode, reasoning effort, etc.)
- **permission_rules** — Stored allow/deny rules from `/remember` (scoped per channel or global)
- **workspace_overrides** — Per-bot working directory and allowed path overrides
- **settings** — Global key-value settings store
- **dynamic_channels** — Channels created at runtime via onboarding/admin tools
- **agent_calls** — Inter-agent call log (caller, target, duration, chain tracking)
- **scheduled_tasks** — Cron and one-off scheduled task definitions
- **scheduled_task_history** — Execution history for scheduled tasks (status, errors)

## Logging

Logs are written to stdout/stderr via `console.log`/`console.error`:

```
HH:mm:ss.SSS [LEVEL] [tag] message
```

Use `createLogger(tag)` from `src/logger.ts`. Tags identify the subsystem (e.g., `bridge`, `session`, `mattermost`, `streaming`).

The log *destination* depends on how you launch the bridge:
- **launchd**: Configured via `StandardOutPath`/`StandardErrorPath` in the plist (default: `~/.copilot-bridge/bridge.log`)
- **Direct**: Logs go to your terminal
- **Redirect**: `umask 077 && npx tsx src/index.ts >> ~/.copilot-bridge/bridge.log 2>&1`

## Running as a macOS service

> **Note**: The launchd service setup below is macOS-specific. On Linux, use systemd; see the plist as a reference for the equivalent unit file.

A reference launchd plist is at `scripts/com.copilot-bridge.plist`. To install:

```bash
# Edit the plist — replace USERNAME with your macOS username
cp scripts/com.copilot-bridge.plist ~/Library/LaunchAgents/
# Adjust WorkingDirectory, HOME, StandardOutPath as needed

# Load and start
launchctl load ~/Library/LaunchAgents/com.copilot-bridge.plist

# Restart (preferred — doesn't unload the service)
./scripts/restart-gateway.sh

# Or manually:
launchctl kickstart -k gui/$(id -u)/com.copilot-bridge

# Stop and unload (⚠️ if the admin bot runs this, the gateway won't restart —
# the bot's own session dies with it. Only run manually from a terminal.)
launchctl unload ~/Library/LaunchAgents/com.copilot-bridge.plist
```

Key plist settings:
- **KeepAlive**: `true` — launchd restarts the process if it crashes
- **ThrottleInterval**: `10` — wait 10s between restart attempts to avoid tight crash loops
- **RunAtLoad**: `true` — starts automatically on login
