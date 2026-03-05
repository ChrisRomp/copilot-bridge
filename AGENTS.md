# AGENTS.md — copilot-bridge

**Repo**: https://github.com/ChrisRomp/copilot-bridge

> **Keep this file up to date** as the architecture evolves or new conventions emerge.
> If you make structural changes, add a new platform adapter, or change key patterns, update the relevant section here.

For project overview, configuration, chat commands, and deployment, see [README.md](README.md).

## Build & Check

```bash
npm install                                   # install dependencies
npx tsc --noEmit                              # type-check (always run before deploying)
npm run dev                                   # run with watch mode (tsx watch)
npm test                                      # vitest suite
npx vitest run src/path/to/file.test.ts       # single test file
```

Restart the running service after changes:
```bash
scripts/restart-gateway.sh
# Or: launchctl kickstart -k gui/$(id -u)/com.copilot-bridge
```

> **⚠️ NEVER use `launchctl unload && launchctl load`** — `unload` kills the bridge process (including your session), so the `load` half never executes and the service stays down.

## Internal Architecture

### Message Flow

1. `MattermostAdapter` receives a WebSocket event, normalizes it to `InboundMessage`
2. `index.ts` serializes handling per channel via promise chains (`channelLocks`), checks for slash commands, then forwards to `SessionManager.sendMessage()`
3. `SessionManager` creates/resumes a `CopilotSession` via `CopilotBridge` (SDK wrapper), wiring up permission and user-input handlers
4. SDK session events flow back through `sessionManager.onSessionEvent()` → `handleSessionEvent()` in index.ts
5. `StreamFormatter` converts SDK events to `FormattedEvent`, which are routed to `StreamingHandler` for edit-in-place message updates

### Event Serialization

Both inbound messages and session events are serialized per-channel via separate promise chains (`channelLocks` and `eventLocks`). This prevents race conditions on stream auto-start and permission resolution.

### Session Lifecycle

- Sessions are created on first message per channel, persisted in SQLite (`channel_sessions` table)
- On restart, sessions resume via `CopilotBridge.resumeSession()` using the stored session ID
- `/new` destroys the current session and creates a fresh one
- MCP servers and skill directories are loaded once at startup and passed to every session

### Stream Lifecycle

- `StreamingHandler` manages edit-in-place messages with throttled updates (500ms)
- One "Working..." stream is created per user message; it persists across tool cycles
- Streams finalize only on `session.idle` (not `turn_end`, which fires between every tool cycle)
- In verbose mode, tool calls accumulate in a separate "activity feed" message that updates in place

## Bot Identity & Pronouns

All bots default to **it/its** pronouns. Bots are software, not people. When writing templates, documentation, or referring to a bot in third person, use "it" — e.g., "the bot and its workspace," not "she and her workspace." Users may override this in per-agent AGENTS.md if they prefer.

## Key Conventions

### Channel Adapter Pattern

New platforms implement `ChannelAdapter` (in `src/types.ts`). The Mattermost adapter (`src/channels/mattermost/adapter.ts`) is the reference implementation.

### Permission Handling

Permission flow: config rules → SQLite stored rules (from `/remember`) → interactive prompt. MCP permissions are stored at server level (`mcp:serverName` → `*`), not per individual tool. The `PendingPermission` type carries a `serverName` field for MCP tools.

### Slash Commands

All slash commands are parsed in `command-handler.ts`. Commands starting with `/` are intercepted by the bridge before reaching the Copilot session. `parseCommand()` splits command and args; `handleCommand()` returns a `CommandResult` with an optional `action` for the orchestrator to execute.

### Fuzzy Model Matching

`resolveModel()` does exact → substring → token matching against model IDs and names. `pickBestMatch()` prefers shorter IDs (base model over specialized variants like `-1m`). Always validate models against the live `listModels()` response before passing to the SDK.

### TypeScript

- ESM modules (`"type": "module"` in package.json, `NodeNext` module resolution)
- All imports use `.js` extensions (required for ESM)
- Strict mode enabled
- SDK types that aren't exported from the package root are defined locally in `bridge.ts`

### Logging

Use `createLogger(tag)` from `src/logger.ts`. Tags identify the subsystem (e.g., `bridge`, `session`, `mattermost`, `streaming`).

### State Persistence

SQLite database at `~/.copilot-bridge/state.db` via `src/state/store.ts`. Uses WAL mode. Stores channel sessions, preferences, and permission rules.

