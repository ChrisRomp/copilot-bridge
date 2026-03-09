# Contributing to copilot-bridge

First off, thank you for considering contributing! This project bridges GitHub Copilot CLI to messaging platforms, and community contributions help it reach more people and platforms.

## Submitting Changes

Please send a [Pull Request](https://github.com/ChrisRomp/copilot-bridge/pull/new/main) with a clear description of what you've done. Before submitting:

1. **Type-check**: `npx tsc --noEmit`
2. **Run tests**: `npm test`
3. **Keep PRs focused** — one feature or fix per PR

Use branch prefixes: `feat/`, `fix/`, `refactor/`, `docs/`.

Always write a clear commit message. Please include `Co-authored-by` attribution when AI tools have been used for development. For example, with GitHub Copilot:

```
Add streaming retry logic for dropped connections

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Reporting Bugs

Open an [issue](https://github.com/ChrisRomp/copilot-bridge/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce (bridge logs are helpful — set `LOG_LEVEL=debug`)

## Adding a Platform Adapter

New platforms implement `ChannelAdapter` from `src/types.ts`. The Mattermost adapter (`src/channels/mattermost/`) is the reference implementation. Place new adapters in `src/channels/<platform>/adapter.ts`. See [architecture.md](docs/architecture.md) for required vs optional methods.

## Coding Conventions

Start reading the code and you'll get the hang of it:

- **TypeScript with ESM** — all imports use `.js` extensions (required even for `.ts` source)
- **Strict mode** enabled project-wide, `NodeNext` module resolution
- **Vitest** for tests, colocated as `*.test.ts` next to the source they test
- **Minimal comments** — only where behavior isn't obvious from the code
- **Logging** via `createLogger(tag)` from `src/logger.ts`
- **Bots use it/its pronouns** in documentation and templates

Update `AGENTS.md` if you change architecture, conventions, or key patterns.
