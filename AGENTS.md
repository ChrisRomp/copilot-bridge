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
- `/resume` accepts partial session ID prefixes (case-insensitive); reports ambiguity if multiple match
- MCP servers and skill directories are loaded once at startup and passed to every session

### Stream Lifecycle

- `StreamingHandler` manages edit-in-place messages with throttled updates (500ms)
- One "Working..." stream is created per user message; it persists across tool cycles
- Streams finalize only on `session.idle` (not `turn_end`, which fires between every tool cycle)
- Thinking/reasoning events (`assistant.reasoning`, `assistant.reasoning_delta`) are suppressed from the stream to prevent message churn
- In verbose mode, tool calls accumulate in a separate "activity feed" message that updates in place
- Verbose mode preserves "Working..." messages by updating in place instead of deleting and recreating

## Bot Identity & Pronouns

All bots default to **it/its** pronouns. Bots are software, not people. When writing templates, documentation, or referring to a bot in third person, use "it" — e.g., "the bot and its workspace," not "she and her workspace." Users may override this in per-agent AGENTS.md if they prefer.

## Key Conventions

### Local Instructions

The bridge loads `AGENTS.local.md` from each bot's working directory if present. This file is gitignored and injected into sessions via `custom_instructions`. Use it for per-operator conventions (e.g., push policies, workflow preferences) that don't belong in the repo.

### Channel Adapter Pattern

New platforms implement `ChannelAdapter` (in `src/types.ts`). The Mattermost adapter (`src/channels/mattermost/adapter.ts`) is the reference implementation.

### Permission Handling

Permission flow: config rules → SQLite stored rules (from `/remember`) → interactive prompt. MCP permissions are stored at server level (`mcp:serverName` → `*`), not per individual tool. The `PendingPermission` type carries a `serverName` field for MCP tools.

If the user sends unrecognized text during a permission prompt (not `/approve`, `/deny`, etc.), the permission is **auto-denied** and the text is processed as a normal message. This prevents lost messages when users ignore a permission prompt.

### Model Fallback

When a model returns a capacity, rate limit, or availability error, `model-fallback.ts` automatically tries alternative models:

1. `parseModelId()` extracts provider/family/version from model IDs
2. `STATIC_FALLBACK_MAP` defines explicit chains for known models (e.g., opus 4.6 → opus 4.5 → sonnet 4.6)
3. `buildFallbackChain()` merges config overrides (`fallbackModels`) with auto-detected chains, filtered against available models (when `listModels()` fails and the available list is empty, config fallbacks are included unfiltered so the user's explicit preferences still apply)
4. `tryWithFallback()` wraps session creation; on model error, tries each fallback in order
5. `sendMessage()` in session-manager.ts has its own fallback loop for send-time failures

The working model is saved to channel prefs and a ⚠️ notification is emitted as a synthetic `assistant.message` event with `data.content`.

### Loop Detection

`LoopDetector` (`src/core/loop-detector.ts`) tracks tool calls per channel. When the same tool is called with identical arguments 5+ times within 60 seconds, it warns the user. At 10+ repetitions, it forces a new session. History is reset on `/new` and session changes.

### Slash Commands

All slash commands are parsed in `command-handler.ts`. Commands starting with `/` are intercepted by the bridge before reaching the Copilot session. `parseCommand()` splits command and args; `handleCommand()` returns a `CommandResult` with an optional `action` for the orchestrator to execute.

### Fuzzy Model Matching

`resolveModel()` does exact → substring → token matching against model IDs and names, with provider awareness. If the input contains a known provider prefix (e.g., `ollama-local:qwen3:8b`), resolution is scoped to that provider's models. Bare model IDs resolve Copilot first, then BYOK providers in config order. `pickBestMatch()` prefers shorter IDs (base model over specialized variants like `-1m`). Always validate models against the live `listModels()` response before passing to the SDK.

### BYOK Providers

External model providers are configured under `providers` in `config.json`. Each provider has a name (used as prefix in model IDs), `baseUrl`, optional auth (`apiKeyEnv`/`bearerTokenEnv`), and a `models` array. Provider names cannot contain `:` or whitespace.

- `resolveProviderConfig()` in `config.ts` resolves env vars to build SDK `ProviderConfig` at session creation time
- `/model` listing groups models by provider (Copilot section first, then BYOK providers)
- `/provider test <name>` calls the provider's models endpoint (`${baseUrl}/models`) to verify connectivity
- `switchModel()` in session-manager detects provider changes and creates a fresh session (different endpoint/auth)
- BYOK models are excluded from auto-fallback chains unless explicitly in `configFallbacks`
- Provider config changes are hot-reloadable via `/reload config`

### TypeScript

- ESM modules (`"type": "module"` in package.json, `NodeNext` module resolution)
- All imports use `.js` extensions (required for ESM)
- Strict mode enabled
- SDK types that aren't exported from the package root are defined locally in `bridge.ts`

### Logging

Use `createLogger(tag)` from `src/logger.ts`. Tags identify the subsystem (e.g., `bridge`, `session`, `mattermost`, `streaming`).

### State Persistence

Pluggable state store via the `StateStore` interface (`src/state/types.ts`). The built-in default is `SqliteStateStore` (`src/state/sqlite-store.ts`), which uses SQLite at `~/.copilot-bridge/state.db` in WAL mode. `src/state/store.ts` is a thin facade that delegates to the active backend — all callers import from `store.ts` unchanged. Custom backends (Postgres, etc.) can be loaded via the `database.module` config option.

### Filing Issues

Use the repo's YAML issue templates (`.github/ISSUE_TEMPLATE/`) when creating issues via `gh issue create`. Two templates exist:

- **`bug_report.yml`** — for bugs. Required fields: Summary, Steps to Reproduce, Expected Behavior, Actual Behavior. Include component, version (`git rev-parse --short HEAD`), platform, and logs when available.
- **`feature_request.yml`** — for enhancements. Required fields: Summary, Motivation. Include Proposed Solution and Alternatives Considered when known.

Always set `Reported By: Agent (automated)` when filing programmatically. Reference related issues with `#N`. Keep issue bodies factual — describe observed behavior, not speculative fixes.

## Review-Implement Loop (REQUIRED)

Every code change MUST go through the review-implement loop before being considered done. This is non-negotiable.

### The Loop

```
Write -> Test -> Review -> Fix (if needed) -> Re-review -> Open PR
```

1. **Write**: Implement the change, run tests, commit and push
2. **Review**: Launch a `Review` agent against the diff (e.g., `git diff HEAD~1 HEAD` or the PR diff)
3. **Triage**: Read findings. If 0 Critical/High/Medium issues, skip to step 6
4. **Fix**: Address the findings, commit, push, verify tests pass
5. **Re-review**: Launch Review agent again scoped to fix commits
6. **Repeat** steps 3-5 until review is clean (max 3 cycles, then escalate to user)
7. **Open PR**: Only after review is clean, tests pass, and spot-check succeeds. PRs are the deliverable.

### Merge Gate

A change may only be considered complete when:
- Latest code review finds no Critical or High issues
- All tests pass
- Any Medium issues are either fixed or explicitly accepted by the user

### Test Quality Gate (Anti-False-Positive)

When reviewing tests, the Review agent MUST check for false positives by asking:

> "Would this test still pass if the feature under test were completely removed or disabled?"

If yes, the test is a false positive. Tests must create **state divergence** where the feature's absence produces a different observable outcome. See the parent AGENTS.md for patterns (cache divergence, side-effect assertions, config-flag tests).

### When to Run

- After **every** commit that changes source code (not docs-only changes)
- Even for "simple" or "obvious" changes; the review catches what you miss
- The loop runs automatically; never ask the user whether to review

