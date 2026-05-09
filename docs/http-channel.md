# HTTP Channel Adapter

The HTTP channel adapter exposes copilot-bridge agents over a REST API conforming to the [Agent Communication Protocol (ACP) v0.2.0](https://agentcommunicationprotocol.dev). It adds a card-based work tracking layer on top of ACP for organizing agent tasks, and an SSE streaming interface for real-time updates.

Use the HTTP adapter when you want to drive agents from scripts, CI pipelines, web UIs, or any HTTP client rather than a chat platform.

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [ACP Endpoints](#acp-endpoints)
- [Card Endpoints](#card-endpoints)
- [Chat API](#chat-api)
- [SSE Streaming](#sse-streaming)
- [Board Views](#board-views)
- [Checkpoints](#checkpoints)
- [Architecture](#architecture)
- [ACP Conformance](#acp-conformance)
- [Limitations](#limitations)

## Quick Start

### 1. Configure

Add an `http` platform to your `config.json`:

```json
{
  "platforms": {
    "http": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 7878,
      "bots": {
        "copilot": { "token": "bot-internal-token", "agent": "copilot" }
      },
      "apiKeys": {
        "dev-key": {
          "secret": "env:HTTP_API_KEY",
          "allowedAgents": ["*"],
          "allowedOps": ["*"]
        }
      }
    }
  }
}
```

Set the secret in your environment or `.env` file:

```bash
export HTTP_API_KEY="my-secret-key-here"
```

### 2. Start the bridge

```bash
copilot-bridge start
# or: npm run dev (from source)
```

The HTTP server starts alongside any other configured platforms. Verify with:

```bash
curl http://localhost:7878/healthz
# {"status":"ok"}
```

### 3. List agents

```bash
curl -H "Authorization: Bearer my-secret-key-here" \
  http://localhost:7878/v1/agents
```

### 4. Create a card and start work

```bash
# Create a card assigned to an agent
curl -X POST http://localhost:7878/v1/cards \
  -H "Authorization: Bearer my-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix login bug", "agent": "copilot"}'

# Post a comment to trigger agent work
curl -X POST http://localhost:7878/v1/cards/CARD_ID/comments \
  -H "Authorization: Bearer my-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"content": "The login form crashes when email contains a plus sign"}'
```

### 5. Stream updates

```bash
curl -N -H "Authorization: Bearer my-secret-key-here" \
  http://localhost:7878/v1/cards/CARD_ID/events
```

## Configuration

The HTTP platform is configured under `platforms.http` in `config.json`.

### Full Reference

```json
{
  "platforms": {
    "http": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 7878,
      "bots": {
        "copilot": {
          "token": "internal-bot-token",
          "agent": "copilot",
          "model": "claude-sonnet-4.6"
        },
        "alice": {
          "token": "internal-bot-token-2",
          "agent": "alice"
        }
      },
      "apiKeys": {
        "admin-key": {
          "secret": "env:HTTP_ADMIN_KEY",
          "allowedAgents": ["*"],
          "allowedOps": ["*"]
        },
        "readonly-key": {
          "secret": "env:HTTP_READONLY_KEY",
          "allowedAgents": ["*"],
          "allowedOps": ["agent:read", "card:read", "run:read", "session:read"]
        },
        "bob-only": {
          "secret": "env:HTTP_BOB_KEY",
          "allowedAgents": ["copilot"],
          "allowedOps": ["card:create", "card:read", "card:comment", "run:create", "run:read"]
        }
      },
      "eventBuffer": {
        "maxEventsPerCard": 1000
      }
    }
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | - | Must be `true` to activate the HTTP adapter |
| `bind` | string | `"127.0.0.1"` | Address to bind the HTTP server |
| `port` | number | `7878` | Port for the HTTP server |
| `bots` | object | - | Bot identities available over HTTP (same format as other platforms) |
| `apiKeys` | object | - | Named API keys for authentication (see below) |
| `eventBuffer.maxEventsPerCard` | number | `1000` | Max SSE events buffered per card for replay |

### API Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `secret` | string | The key value. Use `"env:VAR_NAME"` to read from an environment variable at startup |
| `allowedAgents` | string[] | Agent names this key can access. `["*"]` for all agents |
| `allowedOps` | string[] | Operations this key can perform. `["*"]` for all operations |

### Operations

Operations control what each API key can do:

| Operation | Description |
|-----------|-------------|
| `agent:read` | List and view agents |
| `card:create` | Create cards |
| `card:read` | View cards, list cards, view card events |
| `card:update` | Modify card status, labels, checkpoints, abort, archive |
| `card:delete` | Delete cards |
| `card:comment` | Post comments on cards |
| `run:create` | Create ACP runs |
| `run:read` | View runs and run events |
| `run:update` | Modify runs |
| `run:cancel` | Cancel runs |
| `run:resume` | Resume awaiting runs |
| `session:read` | View session details |

## Authentication

All endpoints except `/healthz` require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <api-key-secret>
```

The key is matched against the resolved secrets in `apiKeys`. Matching uses timing-safe comparison to prevent timing attacks. If the key is not found or lacks the required operation permission, the server returns `401` (invalid key) or `403` (insufficient permissions).

### Scoped Access

Each API key has independent agent and operation scopes. A request is authorized only if:

1. The key's `allowedOps` includes the required operation (or `"*"`)
2. The key's `allowedAgents` includes the target agent (or `"*"`)

Example: a key with `allowedAgents: ["copilot"]` and `allowedOps: ["card:read"]` can view cards assigned to `copilot` but cannot create cards or view cards assigned to other agents.

## ACP Endpoints

These endpoints implement the Agent Communication Protocol v0.2.0.

### List Agents

```
GET /v1/agents
```

Returns all agents configured in the HTTP platform's `bots` section.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/agents
```

```json
{
  "agents": [
    {
      "name": "copilot",
      "description": "copilot",
      "input_content_types": ["text/plain"],
      "output_content_types": ["text/plain"]
    }
  ]
}
```

### Get Agent

```
GET /v1/agents/:name
```

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/agents/copilot
```

Returns `404` if the agent is not configured.

### Create Run

```
POST /v1/runs
```

Starts an asynchronous agent run. Returns immediately with the run object.

```bash
curl -X POST http://localhost:7878/v1/runs \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "copilot",
    "input": [{"parts": [{"type": "text", "text": "Explain this codebase"}]}],
    "mode": "async"
  }'
```

```json
{
  "run": {
    "id": "run-uuid",
    "agent_name": "copilot",
    "session_id": "session-uuid",
    "status": "created",
    "created_at": "2026-05-09T12:00:00.000Z"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_name` | string | yes | Agent to run |
| `input` | AcpMessage[] | yes | Messages to send (at least one with text) |
| `session_id` | string | no | Reuse an existing session; auto-generated if omitted |
| `mode` | string | no | Only `"async"` is supported (default) |

### Get Run

```
GET /v1/runs/:id
```

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/runs/RUN_ID
```

### Stream Run Events

```
GET /v1/runs/:id/events
```

Opens an SSE stream for a specific run. See [SSE Streaming](#sse-streaming) for event types.

```bash
curl -N -H "Authorization: Bearer $KEY" http://localhost:7878/v1/runs/RUN_ID/events
```

### Resume Run

```
POST /v1/runs/:id
```

Resumes a run that is in `awaiting` status (waiting for user input).

```bash
curl -X POST http://localhost:7878/v1/runs/RUN_ID \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "await_resume": [{"parts": [{"type": "text", "text": "Yes, proceed"}]}],
    "mode": "async"
  }'
```

Returns `409` if the run is not in `awaiting` status.

### Cancel Run

```
POST /v1/runs/:id/cancel
```

```bash
curl -X POST -H "Authorization: Bearer $KEY" http://localhost:7878/v1/runs/RUN_ID/cancel
```

Returns `202 Accepted` with the updated run object.

### Get Session

```
GET /v1/sessions/:sessionId
```

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/sessions/SESSION_ID
```

## Card Endpoints

Cards are the HTTP adapter's work tracking layer. Each card represents a unit of work with a lifecycle, comments, labels, and optional agent assignment.

### Create Card

```
POST /v1/cards
```

```bash
# Card with agent assignment
curl -X POST http://localhost:7878/v1/cards \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Implement user search", "agent": "copilot", "description": "Add fuzzy search to the users API"}'

# Card without agent (pre-work / triage)
curl -X POST http://localhost:7878/v1/cards \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Investigate memory leak"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Card title |
| `description` | string | no | Detailed description |
| `agent` | string | no | Agent to assign |
| `labels` | string[] | no | Initial labels |
| `metadata` | object | no | Arbitrary key-value metadata |

### List Cards

```
GET /v1/cards
```

Filter cards using query parameters:

```bash
# All cards
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards

# Cards assigned to a specific agent
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?agent=copilot"

# Unassigned cards (pre-work board)
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?agent=none"

# Filter by status
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?status=in_progress"

# Filter by label
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?label=backend"

# Filter by card type
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?type=work"
```

| Query Param | Values | Description |
|-------------|--------|-------------|
| `agent` | agent name or `none` | Filter by assigned agent; `none` returns unassigned cards |
| `status` | `idea`, `in_progress`, `completed`, `archived` | Filter by card status |
| `label` | string | Filter by label |
| `type` | `work`, `chat` | Filter by card type |

### Get Card

```
GET /v1/cards/:id
```

Returns the card with its runs and comments.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID
```

```json
{
  "card": {
    "id": "card-uuid",
    "type": "work",
    "title": "Implement user search",
    "status": "in_progress",
    "agent_bot": "copilot",
    "created_by": "dev-key",
    "created_at": "2026-05-09T12:00:00.000Z",
    "updated_at": "2026-05-09T12:05:00.000Z"
  },
  "runs": [...],
  "comments": [...]
}
```

### Update Card

```
PATCH /v1/cards/:id
```

```bash
curl -X PATCH http://localhost:7878/v1/cards/CARD_ID \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | New status (`idea`, `in_progress`, `completed`, `archived`) |
| `agent` | string or null | Reassign agent; `null` to unassign |
| `title` | string | Update title |
| `description` | string | Update description |
| `metadata` | object | Replace metadata |

### Post Comment

```
POST /v1/cards/:id/comments
```

Posts a comment to a card and triggers a new agent run. The card must have an assigned agent.

```bash
curl -X POST http://localhost:7878/v1/cards/CARD_ID/comments \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Now add pagination to the search results"}'
```

```json
{
  "comment": {
    "id": "comment-uuid",
    "card_id": "card-uuid",
    "author_kind": "human",
    "author_id": "dev-key",
    "content": "...",
    "created_at": "2026-05-09T12:10:00.000Z"
  },
  "run_id": "run-uuid"
}
```

### Manage Labels

```bash
# Add labels
curl -X POST http://localhost:7878/v1/cards/CARD_ID/labels \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"labels": ["backend", "priority-high"]}'

# Remove a label
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:7878/v1/cards/CARD_ID/labels/backend
```

### Abort Card

```
POST /v1/cards/:id/abort
```

Cancels the active run on a card. The card must have an active session.

```bash
curl -X POST -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID/abort
```

### Archive Card

```
POST /v1/cards/:id/archive
```

```bash
curl -X POST -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID/archive
```

### Delete Card

```
DELETE /v1/cards/:id
```

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID
```

## Chat API

The chat API provides a lightweight conversational interface without the full card lifecycle. Chat sessions are created automatically and support multi-turn conversation.

### Send Message

```
POST /v1/agents/:name/chat
```

```bash
# Start a new chat
curl -X POST http://localhost:7878/v1/agents/copilot/chat \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "What does the auth middleware do?"}'

# Continue an existing chat
curl -X POST http://localhost:7878/v1/agents/copilot/chat \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "How does it handle expired tokens?", "session_id": "SESSION_ID"}'
```

```json
{
  "session_id": "session-uuid",
  "run_id": "run-uuid"
}
```

### Get Chat History

```
GET /v1/agents/:name/chat/:sessionId
```

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/agents/copilot/chat/SESSION_ID
```

```json
{
  "history": [
    {
      "author_kind": "human",
      "content": "...",
      "created_at": "2026-05-09T12:00:00.000Z"
    },
    {
      "author_kind": "agent",
      "content": "...",
      "created_at": "2026-05-09T12:00:05.000Z"
    }
  ]
}
```

## SSE Streaming

Real-time updates are delivered via Server-Sent Events (SSE). Connect to a card or run events endpoint to receive updates as they happen.

### Connecting

```bash
# Stream all events for a card
curl -N -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID/events

# Stream events for a specific run
curl -N -H "Authorization: Bearer $KEY" http://localhost:7878/v1/runs/RUN_ID/events
```

### Event Types

**ACP run events:**

| Event | Description |
|-------|-------------|
| `message.created` | A new message was created |
| `message.part` | A message part (text delta or tool trajectory) |
| `message.completed` | A message finished |
| `run.in-progress` | The run started processing |
| `run.awaiting` | The run is waiting for user input |
| `run.completed` | The run finished successfully |
| `run.failed` | The run failed |
| `run.cancelled` | The run was cancelled |

**Card events (HTTP adapter extension):**

| Event | Description |
|-------|-------------|
| `card.status` | The card's status changed |
| `heartbeat` | Keepalive signal (every 15 seconds) |

### Event Format

```
id: 42
event: message.part
data: {"type":"text","text":"Here is the fix..."}

id: 43
event: run.completed
data: {"run_id":"run-uuid","status":"completed"}
```

### Replay

If a client disconnects, it can resume from where it left off using the `Last-Event-ID` header:

```bash
curl -N -H "Authorization: Bearer $KEY" \
  -H "Last-Event-ID: 42" \
  http://localhost:7878/v1/cards/CARD_ID/events
```

The server replays all buffered events with ID greater than the provided value. Events are buffered in memory (up to `eventBuffer.maxEventsPerCard`, default 1000).

## Board Views

The card list endpoint supports query parameters that map to common board projections:

### Pre-work Board (Unassigned Cards)

Cards that have not been assigned to any agent yet:

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?agent=none"
```

### Agent Board

Cards assigned to a specific agent:

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?agent=copilot"
```

### By Label

Cards with a specific label:

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:7878/v1/cards?label=backend"
```

### Combined Filters

```bash
# Active backend cards for copilot
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:7878/v1/cards?agent=copilot&label=backend&status=in_progress"
```

## Checkpoints

Checkpoints snapshot a card's progress at a specific turn. They can be used to mark milestones or save points during long-running work.

> **Note:** Checkpoint forking (restoring to a prior checkpoint and branching) is deferred to v1.5.

### List Checkpoints

```
GET /v1/cards/:id/checkpoints
```

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:7878/v1/cards/CARD_ID/checkpoints
```

### Create Checkpoint

```
POST /v1/cards/:id/checkpoints
```

```bash
curl -X POST http://localhost:7878/v1/cards/CARD_ID/checkpoints \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "before-refactor"}'
```

### Delete Checkpoint

```
DELETE /v1/cards/:id/checkpoints/:checkpointId
```

Only the user who created a checkpoint can delete it.

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" \
  http://localhost:7878/v1/cards/CARD_ID/checkpoints/CHECKPOINT_ID
```

## Architecture

The HTTP channel adapter is composed of several cooperating modules:

```
                                +-----------+
HTTP Client  -->  Fastify  -->  |   Auth    |  --> 403/401
                                +-----------+
                                     |
                     +---------------+---------------+
                     |               |               |
               +-----+-----+  +-----+-----+  +------+------+
               | ACP Routes |  |Card Routes|  | Chat Routes |
               +-----+------+ +-----+------+ +------+------+
                     |               |               |
                     +-------+-------+-------+-------+
                             |               |
                    +--------+------+  +-----+-----+
                    | HttpChannel   |  | SQLite     |
                    | Adapter       |  | CardStore  |
                    +--------+------+  +-----------+
                             |
                    +--------+------+
                    | Copilot SDK   |
                    | Harness       |
                    +---------------+
                             |
                    +--------+------+
                    | SSE Event     |
                    | Streams       |
                    +---------------+
```

**Components:**

| Component | File | Purpose |
|-----------|------|---------|
| Server | `server.ts` | Fastify HTTP server setup and lifecycle |
| Auth | `auth.ts` | Bearer token validation and scope checks |
| ACP Routes | `routes/acp.ts` | Agent, run, and session endpoints |
| Card Routes | `routes/cards.ts` | Card CRUD, comments, labels, checkpoints |
| Chat Routes | `routes/chat.ts` | Lightweight chat sessions |
| Adapter | `index.ts` | `HttpChannelAdapter` -- bridges HTTP to copilot-bridge internals |
| Startup | `startup.ts` | Config parsing, secret resolution, server initialization |
| Store | `store-sqlite.ts` | SQLite-backed persistence for cards, runs, comments, checkpoints |
| SSE | `sse.ts` | Server-Sent Events with in-memory replay buffer |
| Harness | `harness.ts` | Converts Copilot SDK events to ACP/SSE format |
| Event Routing | `event-routing.ts` | Routes session events to the correct card/run streams |

## ACP Conformance

The HTTP adapter implements ACP v0.2.0 with the following profile:

| Feature | Status |
|---------|--------|
| Agent discovery (`/v1/agents`) | Supported |
| Async runs | Supported |
| Sync runs | Not supported (returns 400) |
| Stream runs | Not supported (returns 400) |
| Run events (SSE) | Supported |
| Run resume (await) | Supported |
| Run cancellation | Supported |
| Sessions | Supported |
| Input content types | `text/plain` only |
| Output content types | `text/plain` only |
| Message parts: text | Supported |
| Message parts: trajectory | Supported (tool call tracking) |
| Message parts: citation | Supported |
| Multi-turn sessions | Supported |

## Limitations

These are known v1 constraints:

| Limitation | Detail |
|------------|--------|
| Single-process only | No clustering or multi-instance support. One bridge process serves all HTTP clients. |
| In-memory SSE buffer | Event replay buffer lives in memory. Events are lost on restart. |
| In-memory session index | Session-to-card mapping is not persisted; lost on restart. |
| No checkpoint fork | Checkpoints can be created and deleted, but forking (restoring to a prior state) is deferred to v1.5. |
| text/plain only | No binary, image, or structured content types in ACP messages. |
| Async mode only | Synchronous and streaming ACP run modes are not supported. |
| No file transfer | `downloadFile` and `sendFile` adapter methods are not implemented. |
| No typing indicators | `setTyping` is a no-op over HTTP. |
| No message editing | `updateMessage` and `deleteMessage` are no-ops (SSE is append-only). |

### Health Check

The `/healthz` endpoint is always available without authentication:

```bash
curl http://localhost:7878/healthz
# {"status":"ok"}
```
