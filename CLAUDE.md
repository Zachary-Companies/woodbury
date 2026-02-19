# CLAUDE.md

Instructions for Claude Code when working in the woodbury repository.

## Overview

Woodbury is an interactive AI coding assistant CLI built on the agentic loop embedded locally in `src/loop/`. It provides a terminal-based REPL and one-shot mode for AI-assisted software engineering with 14 built-in tools.

## Architecture

### ESM Project
- `"type": "module"` in package.json
- TypeScript compiles with `"module": "Node16"`, `"moduleResolution": "Node16"`
- All relative imports use `.js` extensions
- The agentic loop is embedded locally in `src/loop/` — no external CJS interop needed

### V1 Agent (XML Tool Calling)
- Uses `Agent` class from the local agentic loop (`src/loop/`) with XML-based `<tool_call>` / `<final_answer>` format
- Each `Agent.run()` call starts fresh — no built-in message history
- Multi-turn conversation is achieved by packing prior turns into `<conversation_history>` XML tags in the user message
- `ConversationManager` in `conversation.ts` handles history packing and token-budget trimming (~80k tokens)

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point (`#!/usr/bin/env node`), routes to REPL or one-shot |
| `src/cli.ts` | Commander-based CLI argument parsing |
| `src/types.ts` | Shared interfaces (`WoodburyConfig`, `Renderer`, `ConversationManager`, etc.) |
| `src/repl.ts` | Interactive REPL loop with readline, Ctrl+C handling, slash command dispatch |
| `src/one-shot.ts` | Single-task execution mode |
| `src/agent-factory.ts` | Creates `Agent` + `ToolRegistry` with all 14 tools, wires `onToolCall` to renderer |
| `src/system-prompt.ts` | Builds dynamic system prompt (identity, environment, project context) |
| `src/context-loader.ts` | Walks up directories to find `.woodbury.md` project context |
| `src/conversation.ts` | Multi-turn history manager with `<conversation_history>` packing |
| `src/renderer.ts` | Terminal output (chalk, ora spinner, marked-terminal markdown rendering) |
| `src/logger.ts` | Logger implementation that routes to renderer (verbose-aware) |
| `src/slash-commands.ts` | Slash command registry and handlers (`/help`, `/exit`, `/clear`, etc.) |
| `src/marked-terminal.d.ts` | Type declaration for `marked-terminal` package |

## Build & Run

```bash
npm run build          # TypeScript compilation
npm run clean          # Remove dist/
npm run all            # clean + build
npm run setup          # install + build + npm link
npm run start          # Run dist/index.js directly
npm run dev            # tsc --watch
```

## Dependencies

- `src/loop/` — Agent core with all 14 tools (embedded locally)
- `chalk` v5 — Terminal colors (ESM-only)
- `ora` v8 — Spinner (ESM-only)
- `marked` + `marked-terminal` — Markdown rendering in terminal
- `commander` — CLI argument parsing

## Conventions

- The `ToolRegistry` is constructed manually in `agent-factory.ts` (not via `createAgentWithDefaultTools`) so we keep a reference to it for the `/tools` slash command
- `allowDangerousTools` defaults to `true` (developer power tool); `--safe` flag disables it
- The renderer pauses the ora spinner before printing tool call output, then resumes it
- Ctrl+C during agent execution aborts via `AbortController`; at idle prompt, double Ctrl+C exits
