# Changelog — 2026-03-21

## Pipeline Extension System

Major architectural refactor to make pipelines fully self-contained. Pipeline-specific views, routes, and server-side API endpoints now live in the pipeline's own repository rather than in Woodbury core.

### Added

- **Pipeline Route SDK** (`src/dashboard/pipeline-route-sdk.ts`) — Interface definition for `PipelineRouteSdk`, `PipelineRouteHandler`, and `PipelineRouteSetup`. Provides pipelines a clean API surface for accessing project state, image generation, extension tools, file system, bindings/rules, and logging without importing Woodbury internals.

- **Pipeline Route Factory** (`src/dashboard/pipeline-route-factory.ts`) — SDK factory function (`createPipelineRouteSdk()`) and dynamic route loader (`loadPipelineRoutes()`). Discovers `routes/index.js` in pipeline directories, dynamically imports them via ESM `import()`, creates the SDK, and caches handlers per-pipeline. Also exports `scanForEntities()` for rule auto-matching.

- **Dynamic Route Delegation** — `pipeline-app.ts` now delegates unmatched sub-paths to the pipeline's own route handler. Core handles generic endpoints (schema, state, views, saves, bindings, rules); pipeline-specific logic is loaded from the pipeline directory at runtime.

- **Pipeline Extensions Documentation** (`docs/pipeline-extensions.md`) — Comprehensive 1,580-line guide covering pipeline structure, discovery, app mode, schema derivation, the view system (React + vanilla), the route system, state management, bindings & rules, API reference, and a full from-scratch tutorial.

### Changed

- **`pipeline-app.ts`** — Reduced from ~2,900 lines to ~1,325 lines. All screenplay-specific endpoints (generate-previs, render-dialogue, generate-dialogue-audio, render-video, generate-assets, etc.) moved to the pipeline's own `routes/index.ts`.

- **`index.tsx`** — Removed dead `mountScreenplay()` and `mountDataView()` functions and their imports. These were legacy mount points from before the dynamic view system.

- **Build chain** — Removed `build:views` and `build:routes` from `package.json` scripts. Pipeline views and routes are now built by the pipeline's own `npm run build`. Woodbury core build is just `react build + tsc`.

### Removed (moved to comp-screenplay-generator repo)

- `extensions/script-generator/views/` — All 5 React view bundles (overview, data, screenplay, editor, voices) with build script
- `extensions/script-generator/routes/` — Server-side route handler with build script
- `src/config-dashboard/react/components/ScreenplayView.tsx` — 1,860 lines
- `src/config-dashboard/react/components/DataView.tsx` — 195 lines
- `src/config-dashboard/react/components/EditorView.tsx`
- `src/config-dashboard/react/components/OverviewView.tsx` — 160 lines
- `src/config-dashboard/react/components/VoicesView.tsx` — 210 lines
- `src/config-dashboard/react/components/DialogueEditModal.tsx` — 184 lines (dead code)
- `src/config-dashboard/react/components/GenerateLogoModal.tsx` — 142 lines (dead code)
- `src/config-dashboard/react/components/RulesModal.tsx` — 275 lines (dead code)
- `src/config-dashboard/react/stores/pipeline-store.ts` — 393 lines (replaced by PipelineProvider)

### Net effect

- Woodbury core: **-4,600 lines** of pipeline-specific code
- Pipeline extension system: generic, reusable for any future pipeline
- Pipeline repos are fully self-contained: own views, routes, build scripts
- No Woodbury rebuild needed when changing pipeline UI or API
