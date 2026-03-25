# Changelog — 2026-03-25

## LLM Proxy, Dynamic Pipeline Config, and View Scaffolding

Added an LLM proxy service for request routing and cost tracking, made pipeline UI configuration fully data-driven via `appConfig`, introduced automatic React view scaffolding for new pipelines, and fixed duplicate pipeline generation.

### Added

- **LLM Proxy** (`tools/llm-proxy/`) — Go-based reverse proxy that sits between the dashboard and LLM providers (Anthropic, OpenAI, Groq). Routes requests based on model name, logs all calls, and tracks per-model token usage and estimated cost. Includes health, stats, and config endpoints. Binary: `woodbury-llm-proxy`.

- **LLM Proxy dashboard integration** — The dashboard server (`src/dashboard/server.ts`) now manages the proxy lifecycle: auto-starts on dashboard launch, sets `LLM_BASE_URL` to point clients through it, and gracefully shuts down on exit. New route module `src/dashboard/routes/llm-proxy.ts` exposes `/api/llm-proxy/status`, `/api/llm-proxy/toggle`, and `/api/llm-proxy/model` endpoints. The `DashboardContext` gains an `llmProxy` field for process state.

- **LLM Settings UI** (`src/config-dashboard/llm-settings.js`) — New "Settings" tab in the config dashboard. Shows proxy status with live toggle, available backends (auto-detected from API key env vars), model selector grid (Claude Sonnet 4, Claude Opus 4, Claude Haiku 3.5, GPT-4o, GPT-4o Mini, Llama 3.1 70B), and per-model usage statistics. Polls proxy status every 15 seconds.

- **`baseURL` support for LLM clients** — `getAnthropicClient()` and `getGroqClient()` in `src/loop/llm-service.ts` now accept an optional `baseURL` parameter, forwarded from `RunPromptOptions.baseURL`. This allows routing calls through the LLM proxy or any compatible endpoint.

- **View scaffolding system** (`src/dashboard/view-scaffolding.ts`) — Automatic React view generation for new pipelines. When a v2 pipeline is created:
  1. Creates `views/build.mjs` — shared esbuild bundler that compiles `entry.tsx` files into IIFE bundles with React externalized via `window.__WoodburyViewSDK`
  2. Scaffolds a generic Overview view with pipeline stats, node status, and output summaries
  3. Optionally generates additional views via LLM based on the pipeline's output schema
  4. Compiles all bundles automatically

- **View scaffolding on pipeline creation** — `scaffoldPipeline()` in `src/dashboard/pipeline-sync.ts` now calls `scaffoldViewsDirectory()` + `scaffoldGenericOverview()`. The `/api/generate-pipeline` endpoint in `src/dashboard/routes/generation.ts` calls `generatePipelineViews()` after pipeline creation and returns the result.

- **System prompt: React view documentation** — `src/loop/v3/system-prompt-v3.ts` now includes documentation for the view file structure, SDK hooks (`usePipeline`, `usePipelineIdentity`, `useProjectData`, `useAIOperations`, `ImageZoom`), entry pattern, and build instructions. This enables the chat agent to create and modify pipeline views.

- **Expanded `docs/pipeline-views.md`** — Comprehensive documentation covering the React view architecture: file structure, quick-start guide, manifest format, SDK hooks reference, how the build/bundle/registration system works, and the legacy vanilla JS fallback.

### Changed

- **Dynamic `appConfig` for pipeline UI** — The hardcoded `NODE_KEY_MAP` in `src/dashboard/routes/pipeline-app.ts` is replaced by `pipeline.appConfig.nodeKeyMap`, a per-pipeline mapping from node IDs to project.json keys. The `deriveAppSchema()` function now passes `appConfig` through to the frontend. Functions `projectToNodeData()` and all node-to-key lookups now read from the pipeline's own config instead of a static table.

- **Data-driven node renderers** — `NodeSection.tsx` no longer uses hardcoded `isCharacterArray()`, `isLocationArray()`, `isElementArray()`, `isSectionArray()` detection functions. Instead, it reads `appConfig.nodeRenderers` — an array of `{ matchFields, excludeFields, renderer }` configs — and uses `matchRenderer()` to select the appropriate builtin renderer (`builtin:character-grid`, `builtin:location-grid`, `builtin:element-list`, `builtin:section-tree`).

- **Configurable sidebar actions** — `Sidebar.tsx` no longer hardcodes "New Project" and "Import Script" buttons. Instead, it reads `schema.appConfig.sidebarActions` and renders buttons dynamically, dispatching custom window events on click.

- **Conditional import modal** — `PipelineApp.tsx` no longer auto-shows the import modal for every pipeline without a project folder. It now checks `schema.appConfig.importModal.autoShow` and `schema.appConfig.importModal.type === 'fountain'` before rendering `ImportScriptModal`. Pipelines that don't declare an import modal (i.e., non-screenplay pipelines) skip it entirely.

- **React key on pipeline switch** — `PipelineApp` and `PipelineAppInner` now use `key={pipelineId}` to force a full remount when switching pipelines. The React view registry (`window.__woodburyReactViewRegistry`) is cleared on pipeline change to prevent stale view registrations from other pipelines.

- **Pipeline app routes pass `appConfig`** — The `AppSchema` interface now includes `appConfig`. `NodeSection` receives `appConfig` as a prop and forwards it to `OutputBlock` for renderer matching.

### Fixed

- **Duplicate pipeline auto-save guard** — `src/loop/v3/closure-engine.ts` now tracks the composition ID saved during a pipeline generation lifecycle via `savedCompositionId`. If the model calls a generation tool multiple times (producing different IDs), only the first is saved. The guard resets at the start of each new user message via `resetAutoSaveGuard()`.

- **Validation feedback no longer triggers re-generation** — When composition validation finds issues, the feedback message now says "Do NOT call generate_pipeline again — that would create a duplicate pipeline" instead of encouraging a retry. This prevents the model from entering a generate-validate-regenerate loop.

- **Skill registry no longer suggests cycling back** — `src/loop/v3/skill-registry.ts` removes the `pipeline_generate` suggestion from `pipeline_validate_and_repair`, and removes the `pipeline_validate_and_repair` suggestion from `pipeline_verify`. This prevents circular skill suggestions that could cause duplicate generation.
