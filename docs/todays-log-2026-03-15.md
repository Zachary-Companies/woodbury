# Woodbury Change Log

Date: 2026-03-15 → 2026-03-16

Scope: Uncommitted — 37 files changed, ~5,241 lines added, ~343 removed. Plus changes in `woodbury-intelligence` repo.

## Executive Summary

March 15–16 delivered the **v2 file-backed pipeline architecture** — a fundamental change to how pipelines work. Instead of inline JavaScript in a single `.composition.json` file, each pipeline is now a real TypeScript codebase: a directory with individual `.ts` files, typed ports via JSDoc annotations, bidirectional graph↔code sync, TypeScript transpilation at runtime, and full repo scaffolding (git, README, CLAUDE.md, package.json, .gitignore, tests).

Key areas:

1. **v2 PipelineDocument type system** — new `PipelineDocument`, `PipelineEdge`, `ScriptFileNodeConfig`, `PipelineNode` types with `__script_file__` node kind and `data`/`import`/`trigger` edge kinds.
2. **Bidirectional sync engine** — `pipeline-sync.ts`: parses `@input`/`@output` JSDoc annotations, generates import statements from edges, syncs files↔manifest, scaffolds full pipeline directories.
3. **TypeScript execution** — runtime `ts.transpileModule()` strips type annotations before `AsyncFunction` eval; `__script_file__` dispatch in the execution engine.
4. **Pipeline CRUD + Git API** — 11 new API endpoints for v2 operations (create, read/write script files, sync, migrate) plus 5 git endpoints (init, status, commit, remote, push) and clone-from-GitHub.
5. **Canvas + properties UI** — `__script_file__` node rendering with 📄 icon and filename, dashed/dotted edge styles for import/trigger, Monaco editor for .ts files, git panel in overview, migrate-to-v2 action.
6. **Agent integration** — chat context includes v2 file contents, system prompt teaches v2 lifecycle (TODO.json, testing, conflict detection).
7. **Intelligence server v2** — `generate_pipeline` defaults to v2 format, creates directories with .ts files, conflict detection for existing folders.
8. **Test generation** — `pipeline-test-gen.ts`: auto-generates `.test.ts` files for every node, runs them after pipeline creation.
9. **Conflict detection** — both the intelligence MCP tool and dashboard route detect existing pipeline directories, return conflict options (overwrite/new-folder/edit).

---

## 1. v2 Type System

**Files:**
- `src/workflow/types.ts` — `PipelineEdgeKind`, `PipelineEdge`, `ScriptFileNodeConfig`, `PipelineDocument`, `PipelineNode`, `AnyCompositionDocument`, `isPipelineDocument()`.

**What changed:**
- `PipelineEdgeKind = 'data' | 'import' | 'trigger'` — edges now carry semantic meaning beyond control flow.
- `PipelineEdge extends CompositionEdge` with optional `kind` field.
- `ScriptFileNodeConfig` — `file`, `description`, `inputs[]`, `outputs[]`, `chatHistory`, `generationTranscript`, `generationMetrics`.
- `PipelineDocument` — `version: '2.0'`, `pipelineDir` (runtime-only), typed `nodes: PipelineNode[]`, `edges: PipelineEdge[]`.
- `PipelineNode extends CompositionNode` with optional `scriptFile?: ScriptFileNodeConfig`.
- `isPipelineDocument()` type guard checks `doc.version === '2.0'`.

**Why:**
- v1 compositions stored everything (code, config, graph) in one JSON file. This made pipelines opaque to standard tools (editors, git, linters, LLMs). v2 treats each node as a real TypeScript file, requiring new types to track the file→node mapping and edge semantics.

---

## 2. Bidirectional Sync Engine

**Files:**
- `src/dashboard/pipeline-sync.ts` (~700+ lines, new file)

**Key functions:**
- `parsePortAnnotations(code)` — extracts `@input` and `@output` JSDoc tags from .ts files.
- `parseImports(code)` — identifies inter-node imports to create `import` edges.
- `generateImportStatement()` / `addImportEdgeToCode()` / `removeImportEdgeFromCode()` — manage import edges in code.
- `syncFileToManifest(pipelineDir, fileName, manifest)` — reads a .ts file, parses ports, updates the manifest node.
- `syncAllFilesToManifest(pipelineDir, manifest)` — scans directory, detects new files (excluding `_`-prefixed, `.d.ts`, `.test.ts`), removes nodes for deleted files, syncs all.
- `scaffoldPipeline(parentDir, id, name, description)` — creates full directory with: `pipeline.json`, `tsconfig.json`, `woodbury.d.ts`, `package.json`, `.env.example`, `.gitignore`, `README.md`, `CLAUDE.md`, `TODO.json`.
- `addScriptFileNode()` — generates typed `execute()` stub with `/// <reference path="./woodbury.d.ts" />` and `context: ScriptContext`.
- `savePipelineManifest()` — atomic write of `pipeline.json`.

**Why:**
- The graph and code must stay in sync. Editing a .ts file's `@input`/`@output` annotations updates the graph ports. Adding/removing graph edges updates import statements in code. Auto-sync runs on pipeline load.

---

## 3. TypeScript Execution

**Files:**
- `src/dashboard/routes/composition-run.ts` — `transpileTypeScript()`, `executeScriptFile()`, `__script_file__` dispatch block.
- `package.json` — moved `typescript` from devDependencies to dependencies for runtime transpilation.

**What changed:**
- `transpileTypeScript(tsCode)` uses `ts.transpileModule()` with ESNext target to strip type annotations, preserving comments.
- `executeScriptFile(pipelineDir, fileName, inputs, context)` reads the .ts file, transpiles, strips `export` keywords, delegates to `executeScriptCode()`.
- New `__script_file__` dispatch block in the execution engine (before `__script__`) reads the file from `pipelineDir`, transpiles, and executes.
- `makeScriptExecutionContext` called with correct args — separate `scriptLogs` array and proper `progressHooks` object.

**Why:**
- v2 nodes are TypeScript files with type annotations (`context: ScriptContext`, typed inputs/outputs). These can't be passed directly to `new AsyncFunction()`. Transpilation strips types while preserving runtime behavior.

---

## 4. Pipeline CRUD + Git API

**Files:**
- `src/dashboard/routes/compositions.ts` — 11 new v2 endpoints + 5 git endpoints + clone endpoint.
- `src/workflow/loader.ts` — `loadPipeline()`, `readScriptFileCode()`, `writeScriptFileCode()`, `DiscoveredComposition.isV2Pipeline`, `DiscoveredComposition.pipelineDir`.

**New endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/compositions/v2` | Create new v2 pipeline directory |
| POST | `/api/compositions/:id/script-file` | Create a new .ts file in a pipeline |
| GET | `/api/compositions/:id/script-file/:file` | Read a .ts file's contents |
| PUT | `/api/compositions/:id/script-file/:file` | Write updated code to a .ts file |
| POST | `/api/compositions/:id/sync` | Trigger file→manifest sync |
| POST | `/api/compositions/:id/migrate-to-v2` | Convert v1 composition to v2 pipeline |
| POST | `/api/compositions/:id/git-init` | Initialize git repo in pipeline dir |
| GET | `/api/compositions/:id/git-status` | Get git status |
| POST | `/api/compositions/:id/git-commit` | Commit with message |
| POST | `/api/compositions/:id/git-remote` | Add remote URL |
| POST | `/api/compositions/:id/git-push` | Push to remote |
| POST | `/api/compositions/v2/clone` | Clone pipeline from GitHub URL |

**Auto-sync on load:** `GET /api/compositions/:id` detects v2 pipelines and runs `syncAllFilesToManifest()` before returning data.

**Discovery:** `discoverCompositionsFromDir()` now scans for directories containing `pipeline.json` alongside `.composition.json` files.

---

## 5. Canvas + Properties UI

**Files:**
- `src/config-dashboard/compositions-canvas.js` — `__script_file__` node rendering, edge kind styling, "Script File (v2)" add-node option, auto-sync on connect, migrate-to-v2 menu item.
- `src/config-dashboard/compositions-properties.js` — `renderScriptFileProperties()` with Monaco editor, port summary, sync button.
- `src/config-dashboard/compositions-overview.js` — Git section (init, commit, remote, push) for v2 pipelines.
- `src/config-dashboard/compositions-core.js` — "Clone from Git" toolbar button and modal.
- `src/config-dashboard/styles.css` — styles for edge kinds, file node footer, git panel.

**What changed:**
- `__script_file__` nodes render with 📄 icon and filename footer beneath the label.
- Edge rendering: `data` → solid (default), `import` → dashed purple `#a78bfa`, `trigger` → dotted gray `#6b7280`.
- Properties panel for `__script_file__` nodes: editable label, description, file path display, Monaco code editor (loads via API, saves via PUT), port summary, sync button, delete.
- Overview tab shows git controls when `compData.version === '2.0'`: init, status display, commit with message field, add remote URL, push.
- "Migrate to v2 (File-backed)" option in the canvas More dropdown.

---

## 6. Agent Integration

**Files:**
- `src/dashboard/routes/chat.ts` — `buildCompositionContext()` enhanced for v2.
- `src/loop/v3/system-prompt-v3.ts` — v2 lifecycle instructions, TODO.json protocol, testing requirements, conflict detection.
- `src/loop/v3/closure-engine.ts` — v2 awareness in closure generation.
- `src/loop/v3/skill-registry.ts` — v2 pipeline skills.

**What changed:**
- `buildCompositionContext()` detects v2 pipelines, includes: pipeline directory path, actual file contents (up to 1500 chars per file, max 10 files), v2-specific instructions for the agent.
- System prompt teaches the agent:
  - TODO.json lifecycle (read → update → add items → never declare success until done).
  - Testing protocol (write .test.ts, run `npx vitest run`, fix until passing).
  - Conflict detection (handle `conflict: true` responses by asking the user).
  - Single-call rule: "Call `generate_pipeline` EXACTLY ONCE per user request."
  - v2 format default with `format: 'v1'` fallback option.

---

## 7. Intelligence Server v2

**Files:**
- `woodbury-intelligence/src/tools/generate-pipeline.ts` — v2 scaffolding, file writing, conflict detection, `conflictResolution` parameter.

**What changed:**
- `generate_pipeline` defaults to `format: 'v2'`.
- Phase 3 (v2 only): creates pipeline directory, converts `__script__` skeleton nodes to `__script_file__` nodes, writes individual .ts files with `convertToV2TypeScript()`.
- `scaffoldV2Pipeline()` creates full directory structure with pipeline.json, tsconfig.json, woodbury.d.ts, package.json, .gitignore, README.md, CLAUDE.md, TODO.json.
- `conflictResolution` parameter: `'overwrite'` | `'new-folder'` | `'edit'`.
- Conflict detection: if target directory has existing .ts files and no `conflictResolution`, returns conflict info with three options.
- `'edit'` mode: loads existing manifest, adds only new nodes/edges that don't exist, preserves everything already there.
- `'new-folder'` mode: appends timestamp suffix to pipeline ID.

---

## 8. Test Generation

**Files:**
- `src/dashboard/pipeline-test-gen.ts` (new file) — `generateNodeTestFile()`, `generateAllNodeTests()`, `ensureTestHelpers()`, `runPipelineTests()`.
- `src/__tests__/v2-pipeline.test.ts` (new file, 52 tests).

**What changed:**
- `generateNodeTestFile(pipelineDir, node)` — creates a `.test.ts` file for a `__script_file__` node that imports the execute function, creates mock context, and runs basic assertions.
- `generateAllNodeTests(pipelineDir, nodes)` — generates test files for every `__script_file__` node.
- `ensureTestHelpers(pipelineDir)` — writes `_test-helpers.ts` with `createMockContext()` factory.
- `runPipelineTests(pipelineDir, opts)` — runs `npx vitest run` in the pipeline directory, parses results.
- `v2-pipeline.test.ts` — 52 tests covering: type system (9), pipeline sync (24), loader (8), execution (4), TypeScript transpilation.

---

## 9. Conflict Detection

**Files:**
- `woodbury-intelligence/src/tools/generate-pipeline.ts` — conflict detection in Phase 3.
- `src/dashboard/routes/generation.ts` — conflict detection in `POST /api/compositions/generate-pipeline` with `format: 'v2'`.

**What changed:**
- Both code paths (MCP intelligence tool + dashboard HTTP route) check if the target pipeline directory already contains `.ts` script files before creating.
- If conflict detected and no `conflictResolution` provided:
  - Intelligence tool returns `{ conflict: true, existingFiles, options, ... }` as tool result.
  - Dashboard route returns HTTP 409 with same structure.
- Three resolution options: overwrite (replace all), new-folder (suffix ID), edit (merge new nodes into existing).
- System prompt instructs the agent to ask the user when it receives a conflict response.

---

## Additional Changes

- `src/config-dashboard/compositions-execution.js` — ~493 lines of enhanced execution UI.
- `src/config-dashboard/chat.js` — ~369 lines of chat improvements for v2 context display.
- `src/config-dashboard/resize-panels.js` (new) — resizable panel support.
- `src/config-dashboard/app.js` — 26 lines of new app initialization.
- `src/config-dashboard/index.html` — 14 lines of new HTML structure.
- `src/loop/llm-service.ts` — 18 lines of LLM service updates.
- `src/dashboard/routes/mcp.ts` — 32 lines of MCP route updates.

---

## Validation

- `npm run build` — TypeScript compilation passed (both repos).
- `npx jest src/__tests__/v2-pipeline.test.ts` — all 52 tests passed.
- No regressions in other test suites.

---

## Net Effect

By end of day March 16, Woodbury pipelines evolved from opaque JSON blobs to real TypeScript codebases:

```
Before (v1):
  my-pipeline.composition.json
    └── nodes[].script.code = "inline JavaScript string"

After (v2):
  my-pipeline/
    ├── pipeline.json          (manifest: graph structure, metadata)
    ├── fetch-data.ts          (node: typed execute() with @input/@output)
    ├── transform-results.ts   (node: imports from fetch-data)
    ├── generate-summary.ts    (node: uses context.llm)
    ├── fetch-data.test.ts     (test: mock context, assertions)
    ├── _test-helpers.ts       (shared: createMockContext())
    ├── woodbury.d.ts          (types: ScriptContext, PortDeclaration)
    ├── tsconfig.json
    ├── package.json
    ├── .gitignore
    ├── .env.example
    ├── README.md
    ├── CLAUDE.md              (LLM instructions for editing)
    └── TODO.json              (agent task tracker)
```

Each file is editable by humans, IDEs, LLMs, and the Woodbury agentic loop. The graph is a visual representation of the code, not the source of truth — both stay in sync via the bidirectional sync engine.
