# Chat API And SSE Contract

Last updated: 2026-03-11

This document defines the operational contract for Woodbury dashboard chat.

It covers:

- `POST /api/chat`
- session persistence endpoints
- SSE event semantics
- client expectations for streamed state

This doc exists because the chat surface is no longer just token streaming. The dashboard depends on structured loop events to render tasks, skills, recovery transitions, and active composition updates.

## 1. Endpoint Overview

Primary endpoint:

- `POST /api/chat`

Supporting endpoints:

- `GET /api/chat/sessions`
- `GET /api/chat/sessions/:id`
- `PUT /api/chat/sessions/:id`
- `DELETE /api/chat/sessions/:id`
- `GET /api/chat/logs`
- `GET /api/chat/logs/:date`

## 2. Request Contract

`POST /api/chat` accepts JSON:

```json
{
  "message": "user message",
  "history": [{ "role": "user", "content": "..." }],
  "activeCompositionId": "optional-composition-id",
  "sessionId": "optional-session-id"
}
```

Field behavior:

- `message` is required
- `history` is optional and may be superseded by persisted session history
- `activeCompositionId` tells chat which composition the user is looking at
- `sessionId` scopes agent reuse and session persistence

If `message` is missing, the server returns `400` with `{ error }`.

If another chat request is already in progress, the server returns `409` with `{ error: 'A chat request is already in progress' }`.

## 3. Session Model

Chat is session-aware.

Persisted session records may include:

- `id`
- `title`
- `history`
- `activeCompositionId`
- `engineSessionId`
- `rollingSummary`
- `summaryTurnCount`
- `taskPanelState`
- timestamps

Operational behavior:

- dashboard chat uses per-session cached closure-engine agents
- unresolved work can continue across turns via `continuationMode: 'resume'`
- old history is compressed into a rolling summary plus recent turns
- the latest user message remains authoritative over omitted prior context

## 4. Streaming Contract

`POST /api/chat` returns `text/event-stream`.

Clients must treat the response as an SSE stream, not as a single JSON payload.

The server may emit these event types:

- `session_context`
- `token`
- `tool_start`
- `tool_end`
- `phase`
- `task_start`
- `task_end`
- `verification`
- `belief_update`
- `reflection`
- `skill_selection`
- `recovery`
- `composition_updated`
- `done`
- `error`

## 5. Event Semantics

### `session_context`

Emitted once near the start of a request.

Expected payload:

- `summary`
- `summaryTurnCount`
- `recentTurnCount`

### `token`

Incremental assistant text.

Payload:

- `token`

### `tool_start`

Payload:

- `name`
- `params`

### `tool_end`

Payload:

- `name`
- `success`
- `duration`
- `params`
- `result` truncated for UI safety

### `phase`

Payload:

- `from`
- `to`

### `task_start`

Payload contains summarized task metadata:

- `id`
- `title`
- `description`
- `status`
- `retryCount`
- `maxRetries`
- `riskLevel`

### `task_end`

Payload contains:

- `task`
- `result.success`
- `result.error`
- `result.durationMs`
- `result.toolCallCount`
- truncated `result.output`

### `verification`

Payload contains:

- summarized `task`
- `status` (`passed` or `failed`)
- `detail`

### `belief_update`

Payload contains:

- `id`
- `claim`
- `confidence`
- `status`

### `reflection`

Payload contains:

- `trigger`
- `summary`
- `confidence`

### `skill_selection`

Payload contains:

- current skill metadata
- `reason`
- `matchedKeywords`
- `allowedTools`
- `previousSkillName`
- `previousSkillReason`
- `handoffRationale`
- `taskId`
- `taskTitle`

### `recovery`

Payload contains:

- `taskId`
- `taskTitle`
- `strategyType`
- `attempt`
- `currentSkill`
- `targetSkill`
- `reason`

### `composition_updated`

Payload contains:

- `compositionId`

### `done`

Payload contains:

- final `content`
- summarized `toolCalls`
- `metadata`

### `error`

Payload contains:

- `error`

## 6. Client Expectations

Dashboard clients should assume:

- events may arrive in interleaved order with tokens
- `done` or `error` is the terminal signal for the logical request
- client disconnect aborts the server-side run
- streamed task state is authoritative for the workspace panel
- `composition_updated` should update the active composition context when present

Clients should not assume that a large final prose answer implies task success. The structured events are the stronger signal.

## 7. Logging Contract

Each chat request also produces a structured log entry with:

- request id
- session id
- timestamp
- truncated message and response
- tool call summaries
- duration
- iterations
- error or abort status

Logs are stored under `~/.woodbury/data/chat-logs/`.

## 8. Known Failure Modes

Watch for these cases:

- the final prose sounds successful but no `composition_updated` event was emitted
- a task ends successfully but verification failed
- the stream ends without `done` because the client disconnected
- session history is stale relative to the latest user instruction

When those occur, the client should rely on structured event state and not optimistic prose alone.

## 9. Related Docs

- [chat-skills-status.md](chat-skills-status.md)
- [dashboard-api.md](dashboard-api.md)
- [pipeline-lifecycle-contract.md](pipeline-lifecycle-contract.md)
- [pipeline-generation-runbook.md](pipeline-generation-runbook.md)