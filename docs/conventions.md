# Woodbury Coding Conventions

This document captures the patterns and conventions used throughout the Woodbury codebase. Follow these when making changes to keep the code consistent.

## Import Conventions

- All relative imports use `.js` extensions (ESM-style, compiled to CommonJS):
  ```ts
  import { runWorkflow } from './workflow-runner.js';
  ```
- Barrel exports via `index.ts` in `src/loop/`, `src/workflow/`, `src/inference/`.
- Type-only imports use the `type` keyword:
  ```ts
  import type { WorkflowNode, RunContext } from './types.js';
  ```
- Dynamic imports for heavy or optional modules:
  ```ts
  const mod = await import('./heavy-module.js');
  ```

## Dashboard HTTP Server Pattern

- Raw `http.createServer` (no Express/Koa).
- Route handler signature:
  ```ts
  (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL, ctx: DashboardContext) => Promise<boolean>
  ```
  Return `true` if the request was handled.
- All JSON responses go through `sendJson(res, status, data)`.
- CORS headers added to every JSON response.
- Request body parsed via the `readBody(req)` helper.
- Error responses follow the shape `sendJson(res, 400, { error: 'message' })`.
- Mutable state shared via a single `DashboardContext` object passed to all route handlers.

## Config Dashboard JS (Browser-Side)

- No module system -- plain `<script>` tags loaded in order.
- Global functions prefixed by concern:
  - `compRenderSidebar`, `compRenderCanvas` (compositions)
  - `wfRenderSteps`, `wfAddNode` (workflows)
- Shared globals live in `app.js`: `showNotification()`, `escHtml()`, `API_BASE`, `switchTab()`.
- DOM manipulation via `innerHTML` string concatenation.
- API calls via `fetch()` with `API_BASE` prefix.
- State stored as module-level `var` declarations.
- CSS in a separate `styles.css` file (extracted from `index.html`).

## File Organization

- TypeScript source in `src/`, compiled to `dist/`.
- Browser-side files in `src/config-dashboard/` (copied verbatim to `dist/`).
- Each tool in `src/loop/tools/` exports `definition` and `handler`.
- Tests in `src/__tests__/` and `__tests__/` (Jest with ts-jest).

## Extension Conventions

- Extensions live in `~/.woodbury/extensions/<name>/`.
- Must have a `package.json` with a `woodbury` field containing:
  - `name`, `displayName`, `version`, `provides`, `entryPoint`, `envVars`
- Entry point exports `activate(ctx: ExtensionContext)`.
- Tool names prefixed with extension scope: `social_post`, `instagram_post`.
- Env vars declared in the manifest, stored in a `.env` file per extension.
- Registry at `~/.woodbury/extensions/registry.json`.

## Error Handling

- Dashboard: wrap each route handler in try/catch, respond with `sendJson` on error.
- Extensions: activation errors are logged but never crash the host (10s timeout per extension).
- `whenReady()` has a 30s max safeguard so it never hangs.
- Workflow files are backed up before overwrite (`.backups/` directory, last 10 versions kept).
- Atomic writes use a `.tmp` file followed by `rename`.

## Storage Patterns

- JSON files in `~/.woodbury/data/` for persistent state.
- Load/save function pairs: `loadRuns()` / `saveRuns()`, `loadSchedules()` / `saveSchedules()`, etc.
- Idempotency cache: SHA-256 hash of node config + inputs maps to cached outputs.
- Debug logs written to `~/.woodbury/logs/woodbury-<date>.log`.
- Workflow files stored at `~/.woodbury/workflows/*.workflow.json`.

## Naming Conventions

| Context                  | Style        | Example                          |
|--------------------------|--------------|----------------------------------|
| Functions / variables    | camelCase    | `runWorkflow`, `nodeOutput`      |
| Classes / interfaces     | PascalCase   | `ExtensionManager`, `RunContext` |
| TypeScript files         | kebab-case   | `extension-manager.ts`           |
| Dashboard JS files       | lowercase    | `compositions.js`                |
| API endpoints            | RESTful      | `/api/workflows/list`            |
| Tool names               | snake_case   | `file_read`, `web_fetch`         |

## Quick Reference: Adding a New Tool

1. Create `src/loop/tools/<tool-name>.ts`.
2. Export a `definition` (JSON schema) and a `handler` function.
3. Register the tool in the barrel export at `src/loop/tools/index.ts`.
4. Add tests in `src/__tests__/tools/<tool-name>.test.ts`.

## Quick Reference: Adding a Dashboard Route

1. Create or edit a route handler file under the dashboard server source.
2. Follow the handler signature: `(req, res, pathname, url, ctx) => Promise<boolean>`.
3. Use `sendJson` for responses and `readBody` for request parsing.
4. Register the handler in the route table.

## Quick Reference: Creating an Extension

1. Create `~/.woodbury/extensions/<name>/package.json` with the `woodbury` manifest.
2. Implement the entry point exporting `activate(ctx: ExtensionContext)`.
3. Declare any required env vars in the manifest `envVars` array.
4. The extension registry at `~/.woodbury/extensions/registry.json` is updated on load.
