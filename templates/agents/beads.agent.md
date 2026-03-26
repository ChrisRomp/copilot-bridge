---
name: Beads Task Memory
description: Persistent task tracking for this workspace using bd (Beads). Use this skill to create, track, and close tasks across sessions.
---

# Beads Task Memory Skill

This workspace uses [Beads](https://github.com/steveyegge/beads) (`bd`) for persistent, structured task memory backed by [Dolt](https://github.com/dolthub/dolt). Tasks survive session restarts and can be shared across multiple bots via Dolt sync.

## Prerequisites

- `bd` CLI installed: `npm install -g @beads/bd` or `brew install beads`
- `bd init --quiet --stealth` run in the workspace directory
- `BEADS_DIR` and `BEADS_ACTOR` set in workspace `.env` (auto-injected by copilot-bridge)

## Session Start Workflow

Run at the beginning of every session to recover context:

```bash
bd prime              # Print workflow context and pending work
bd ready --json       # List tasks with no open blockers (what to work on next)
```

## Task Operations

### Creating tasks

```bash
bd create --title="Short descriptive title" --description="Why this exists and what done looks like" --type=task --priority=2
```

- Types: `task`, `feature`, `bug`, `epic`, `chore`, `decision`
- Priority: `0` (critical) → `4` (backlog). Use numbers, not words.
- For descriptions with special chars, pipe via stdin: `echo "description" | bd create --title="Title" --stdin`
- **NEVER** use `bd edit` — it opens `$EDITOR` and blocks the agent.

### Claiming and progressing work

```bash
bd update <id> --claim          # Atomically claim a task (sets assignee + in_progress)
bd update <id> --status=done    # Update status without closing
bd update <id> --notes="..."    # Add notes inline
```

### Closing tasks

```bash
bd close <id> --reason="What was done"
bd close <id1> <id2> <id3>     # Close multiple at once
```

### Viewing and searching

```bash
bd show <id>                    # Full task details + audit trail
bd list                         # All open issues
bd list --status=in_progress    # Active work
bd search "keyword"             # Full-text search
bd stats                        # Project health summary
```

### Dependencies

```bash
bd dep add <child-id> <parent-id>   # child depends on parent (parent blocks child)
bd blocked                          # Show all blocked issues
```

### Persistent knowledge

```bash
bd remember "key insight or decision"   # Store cross-session knowledge
bd memories "keyword"                   # Search stored knowledge
```

## Session End Workflow

Close completed tasks and back up before ending a session:

```bash
bd close <id1> <id2> ...    # Close all completed work
bd backup export-git         # Snapshot to git branch (zero-infrastructure backup)
```

## When to Use Beads

- Any task that spans multiple tool calls or may be interrupted mid-session
- Multi-step work with subtasks (use epics + child tasks)
- Decisions that should be recorded for future sessions
- Anything you'd otherwise write to `MEMORY.md`

When Beads is available, prefer `bd remember` over `MEMORY.md` for persistent knowledge — Beads is queryable, versioned, and concurrency-safe.

## Troubleshooting

```bash
bd doctor          # Check Dolt server health
bd dolt start      # Manually start Dolt server if needed
bd dolt status     # Check server status
```
