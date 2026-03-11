# Chat And Skills Status

Last updated: 2026-03-11

This document summarizes the current state of Woodbury's dashboard chat harness and the v3 skills-first closure engine.

## Current State

- Dashboard chat uses per-session v3 closure-engine agents, not a single shared singleton agent.
- Chat sessions persist under `~/.woodbury/data/chat-sessions/` and chat logs persist under `~/.woodbury/data/chat-logs/`.
- Dashboard chat runs the closure engine in `continuationMode: 'resume'`, so unresolved work can be resumed across turns.
- Older chat history is compressed into a rolling summary plus a recent-turn window instead of replaying the entire transcript on every request.
- The chat workspace receives structured loop events over SSE, including phase changes, task start/end, verification, belief updates, reflections, skill selection, recovery, composition updates, tokens, and completion/error events.
- Skill selection is now first-class. The model is expected to operate through a selected skill with a scoped tool subset rather than planning directly against the full tool list.
- Planner-assisted handoffs are supported through `preferredSkill` and `preferredSkillReason` on task nodes.
- Alternate-skill recovery is supported, and recovery transitions are streamed back to the dashboard chat workspace.
- Suggested skill-policy updates are persisted in `~/.woodbury/data/closure-engine/skill-policies.json` and can be reviewed through the dashboard API.

## Current Counts

- Built-in default tools exposed by the core registry: 34
- First-class v3 skills in the default skill registry: 9
- Dashboard route modules currently registered: 24

Notes:

- Extension tools and MCP tools are added dynamically at runtime, so the live tool count can exceed 34.
- The 34 count refers to the default built-in registry assembled from `src/loop/tools/index.ts`.
- The 9 skills refer to the default v3 `SkillRegistry` definitions.

## Default Skills

- `workflow_or_pipeline_build`
- `browser_automation`
- `web_research`
- `dashboard_or_ui_change`
- `code_change`
- `test_and_verify`
- `extension_or_mcp_integration`
- `repo_explore`
- `general_execution`

## Chat API Behavior

The dashboard chat endpoint is `POST /api/chat` and returns an SSE stream. The request supports:

```json
{
  "message": "user message",
  "history": [{ "role": "user", "content": "..." }],
  "activeCompositionId": "optional-composition-id",
  "sessionId": "optional-session-id"
}
```

The stream can emit these event types:

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

## Session Persistence

Saved chat sessions include more than message history. Each session record can also persist:

- `engineSessionId`
- `rollingSummary`
- `summaryTurnCount`
- `activeCompositionId`
- `taskPanelState`

The task panel state is used by the dashboard workspace to restore loop state such as tasks, verification results, selected skill, skill transitions, recovery events, reflections, and policy review items.

## Known Gaps

- The root README still needs to be kept aligned when tool counts or chat behavior change.
- The dashboard API reference previously documented only the older token/tool SSE surface and should be treated as stale unless updated alongside route changes.
- There is not yet a dedicated standalone dashboard page for skill-policy review; the current review surface is embedded in the chat workspace.
