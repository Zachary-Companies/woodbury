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
| `src/debug-log.ts` | File-based debug logging to `~/.woodbury/logs/` (activated by `--debug` or `WOODBURY_DEBUG=1`) |
| `src/slash-commands.ts` | Slash command registry and handlers (`/help`, `/exit`, `/clear`, `/log`, etc.) |
| `src/marked-terminal.d.ts` | Type declaration for `marked-terminal` package |

### Extension System
- Extensions live in `~/.woodbury/extensions/` (local dirs) and `~/.woodbury/extensions/node_modules/woodbury-ext-*` (npm)
- Each extension has `package.json` with a `"woodbury"` field containing `name`, `displayName`, `description`, `provides`
- Extensions export `activate(ctx)` and optionally `deactivate()`
- The `ExtensionContext` provides: `registerTool()`, `registerCommand()`, `addSystemPrompt()`, `serveWebUI()`, `workingDirectory`, `log`, `bridgeServer`

| File | Purpose |
|------|---------|
| `src/extension-api.ts` | Public types for extension authors (`WoodburyExtension`, `ExtensionContext`, etc.) |
| `src/extension-loader.ts` | Discovers extensions, validates manifests, `parseEnvFile()` / `writeEnvFile()` utilities, `EnvVarDeclaration` (with `type?: 'string' \| 'path'`) + `envDeclarations` on manifest |
| `src/extension-manager.ts` | Lifecycle coordinator: load, activate (incl. `.env` loading → frozen `ctx.env`), aggregate tools/commands/prompts, serve web UIs, deactivate |
| `src/extension-scaffold.ts` | `woodbury ext create` generates starter extension with all four capabilities; `initGitRepo()`, `ensureGhInstalled()`, `isToolInstalled()` helpers for git + GitHub integration |
| `src/config-dashboard.ts` | Built-in web dashboard for managing extension env vars; `startDashboard()`, `maskValue()`, `DashboardHandle`; API routes: GET/PUT extensions env, POST browse dirs |
| `src/config-dashboard/` | Static HTML/JS for the dashboard SPA (dark theme, folder picker modal); copied to `dist/` by `postbuild` script |

**Extension data flow:**
1. `cli.ts` creates `ExtensionManager` → calls `loadAll()` → discovers + activates all extensions (during activation, reads `<ext-dir>/.env`, validates against `woodbury.env` declarations, provides frozen `ctx.env`)
2. `cli.ts` starts config dashboard (`startDashboard()`) → passes `DashboardHandle` to `startRepl()`
3. `ExtensionManager` is passed to `startRepl()` → merges extension commands with built-in slash commands
4. `createAgent()` in `agent-factory.ts` receives `ExtensionManager` → registers extension tools in `ToolRegistry` → passes extension prompt sections to `buildSystemPrompt()`
5. `system-prompt.ts` appends `## Extension Configuration` (dashboard awareness) + `## Extension Instructions` sections
6. On exit, `repl.ts` closes dashboard handle, then calls `extensionManager.deactivateAll()`

**Config dashboard flow:**
1. `startDashboard()` creates HTTP server on `127.0.0.1:0` (auto-port)
2. API routes call `discoverExtensions()` per-request for fresh data
3. `GET /api/extensions` → list all extensions with env var status (masked values)
4. `GET /api/extensions/:name/env` → single extension's env status
5. `PUT /api/extensions/:name/env` → merge new values into `.env` file (empty = delete)
6. `POST /api/browse` → list subdirectories for the folder picker
7. Static files served from `dist/config-dashboard/` (copied by `postbuild`)
8. `EnvVarDeclaration.type` controls dashboard UI: `'string'` → password input, `'path'` → text input + Browse button

**Extension CLI subcommands** (in `cli.ts`):
- `woodbury ext list` — discover and list extensions
- `woodbury ext create <name>` — scaffold via `extension-scaffold.ts` (auto-inits git repo, generates `.gitignore`)
- `woodbury ext create <name> --web` — scaffold with `site-knowledge/` templates for web-navigation extensions
- `woodbury ext create <name> --github` — scaffold + init git + create GitHub repo + push (uses `gh` CLI; installs via brew if missing)
- `woodbury ext create <name> --github --public` — same as above with public repo
- `woodbury ext create <name> --no-git` — scaffold without git initialization
- `woodbury ext install <pkg>` — `npm install` in `~/.woodbury/extensions/`
- `woodbury ext install-git <url>` — git clone into `~/.woodbury/extensions/<name>/`, runs npm install + build if needed
- `woodbury ext link <path>` — symlink local extension directory into `~/.woodbury/extensions/`
- `woodbury ext uninstall <pkg>` — `npm uninstall` in `~/.woodbury/extensions/`
- `woodbury ext configure <name>` — show/check env var status for an extension
- `--no-extensions` flag disables all extension loading

**Site Knowledge Pattern (Web-Navigation Extensions):**
- `scaffoldExtension(name, { webNavigation: true })` creates a `site-knowledge/` directory with 6 template files: `site-map.md`, `selectors.md`, `auth-flow.md`, `api-endpoints.md`, `forms.md`, `quirks.md`
- The `--web` variant generates an alternate `index.js` that reads `site-knowledge/*.md` files at activation and injects them via `addSystemPrompt()`
- The alternate index.js also scaffolds a `_navigate` tool (instead of `_hello`) and a `/knowledge` subcommand
- `ScaffoldOptions` interface in `extension-scaffold.ts` has `webNavigation?: boolean`
- Template files are structured markdown with tables and "Research Commands Used" sections

## Build & Run

```bash
npm run build          # TypeScript compilation
npm run clean          # Remove dist/
npm run all            # clean + build
npm run setup          # install + build + npm link
npm run start          # Run dist/index.js directly
npm run dev            # tsc --watch
```

## Debug Logging

Woodbury has file-based debug logging that writes timestamped entries to `~/.woodbury/logs/`.

**Activate:** `woodbury --debug` or `WOODBURY_DEBUG=1 woodbury`

**Log location:** `~/.woodbury/logs/woodbury-<YYYY-MM-DD>-<HHmmss>.log`

**View in REPL:** `/log` (shows path + last 20 lines), `/log 50` (last 50 lines)

**What's logged:**
- Startup: config, provider, model, API key status
- Extensions: discovery, loading, activation, env var status
- Agent: tool registry, system prompt, each run (timing, iterations, tool calls)
- REPL: user input, slash commands, errors, abort, shutdown
- Dashboard: API requests, env var updates

**Implementation:** `src/debug-log.ts` exports a `debugLog` singleton. Auto-rotates (keeps 10 files, max 10 MB each). All logging is no-op when disabled — zero overhead in normal use.

## Dependencies

- `src/loop/` — Agent core with all 14 tools (embedded locally)
- `chalk` v5 — Terminal colors (ESM-only)
- `ora` v8 — Spinner (ESM-only)
- `marked` + `marked-terminal` — Markdown rendering in terminal
- `commander` — CLI argument parsing

## Testing

- **Framework:** Jest (primary, `src/__tests__/`) + Vitest (root `__tests__/` integration tests)
- **Config:** `jest.config.js` (ts-jest preset, node env, `.js` extension mapping)
- **Mocks:** `src/__tests__/setup-mocks.js` (pre-framework, mocks chalk/marked-terminal/ora) + `src/__tests__/setup.ts` (post-framework, same mocks + process.exit)
- **Run:** `npm test` (all), `npx jest <file>` (single), `npm run test:coverage` (with coverage)

Extension-specific test files:
| File | Tests |
|------|-------|
| `src/__tests__/extension-scaffold.test.ts` | Name validation, directory creation, package.json generation, index.js scaffolding, `--web` site-knowledge templates, `.gitignore` generation, `isToolInstalled()`, `initGitRepo()` git init + commit + `.gitignore` respect |
| `src/__tests__/extension-loader.test.ts` | Discovery from local/npm/scoped dirs, manifest parsing, skipping invalid extensions |
| `src/__tests__/extension-manager.test.ts` | Lifecycle (loadAll, activate, deactivate), context API (tools, commands, prompts, web UIs), aggregation |
| `src/__tests__/extension-agent-factory.test.ts` | Tool registration in ToolRegistry, prompt section passthrough, error handling |
| `src/__tests__/config-dashboard.test.ts` | `writeEnvFile()` serialization/round-trip, `maskValue()`, dashboard server start/stop, all API routes (GET/PUT extensions, browse dirs), env var merge/delete |

## Conventions

- The `ToolRegistry` is constructed manually in `agent-factory.ts` (not via `createAgentWithDefaultTools`) so we keep a reference to it for the `/tools` slash command
- `allowDangerousTools` defaults to `true` (developer power tool); `--safe` flag disables it
- The renderer pauses the ora spinner before printing tool call output, then resumes it
- Ctrl+C during agent execution aborts via `AbortController`; at idle prompt, double Ctrl+C exits
- Extensions use CJS `module.exports` for compatibility (entry points are dynamically imported via `file://` URL)
- Extension tool names should be prefixed with the extension name (underscored): `social_post`, `social_draft`
- The chalk mock in test setup includes `visible` in the chainable colors list (needed for theme-aware text colors)
- The Agent mock in `agent-factory.test.ts` must include `progressLogger: { disabled: false }` since `setOnToken()` toggles it
