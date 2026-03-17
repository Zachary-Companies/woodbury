# Woodbury Change Log

Date: 2026-03-16

Scope: 3 commits on `main` — 19 files changed, ~4,379 lines added, ~166 removed.

## Executive Summary

March 16 delivered the **Pipeline App Mode** — a complete interactive application view that transforms pipeline results into a polished, non-technical UI. Instead of viewing raw JSON output in the pipeline editor, users now navigate to `#compositions/{id}/app` and get a sidebar-driven application with auto-detected sections, tabbed panels for nested data, card grids with smart field detection, image viewing with local file support, and a detail modal for both full-size images and formatted JSON inspection.

Key areas:

1. **Pipeline App Mode UI** (`compositions-app.js`) — Full client-side application with sidebar navigation, section rendering, editable outputs, and smart data presentation.
2. **Pipeline App API** (`pipeline-app.ts`) — Server-side routes for schema derivation, state persistence, node data fetching, and run-to-app-state migration.
3. **Smart nested object decomposition** — Automatic detection of "complex" children (arrays with 3+ items, objects with 5+ keys) to render as tabbed panels instead of flat key-value grids.
4. **Card grids with field heuristics** — `findBestField()` auto-detects title, description, image, type, and ID fields using three-tier matching (exact → case-insensitive → substring).
5. **General-purpose detail modal** — Single modal supporting both image zoom and JSON inspection modes, replacing the inline `<details>` "Raw Item" expand pattern.
6. **Image serving for local files** — `resolveImageSrc()` converts local filesystem paths to `/api/file?path=...` URLs so pipeline-generated images display in the browser.
7. **Graph utility extraction** (`graph-utils.ts`) — Shared algorithms (topoSort, gatherInputVariables, getDownstreamNodes, getUpstreamNodes) extracted from composition-run.ts.
8. **Gradient and visual polish** — Extensive CSS overhaul with layered radial gradients, purple accent lines, glass-morphism cards, and smooth hover transitions.
9. **Code generation robustness** — Anti-pattern detection, robustness rules injection, and standardized LLM token limits.
10. **Chat streaming improvements** — Tool use pills now interleave correctly with streamed text instead of being prepended.

---

## 1. Pipeline App Mode — Client UI

**File created:** `src/config-dashboard/compositions-app.js` (1,215 lines)

**Architecture:**
- Accessed via hash route `#compositions/{id}/app`
- State managed by three globals: `appSchema` (section definitions), `appState` (persisted node outputs), `appActiveSection` (current nav selection)
- API calls: `fetchAppSchema()`, `fetchAppState()`, `fetchAppNodeData()`
- Main render function: `renderCompositionAppPage()` builds the full shell, sidebar, and content area

**Sidebar navigation:**
- Pipeline title and description from `compData`
- Settings link (when variable inputs exist)
- Section links generated from `appSchema.sections[]` with item counts
- SVG icons per node type (script, junction, forEach, variable)
- "Run Pipeline", "Open Editor", "Open Form" action buttons
- Command bar input (placeholder — future feature)

**Section rendering (`renderAppSection`):**
- Each section corresponds to a pipeline node
- Regenerate button per section
- Output blocks iterate over the node's output ports
- Edit and Copy buttons per output block
- Routes to specialized renderers based on data type

**Smart output rendering (`renderAppOutputsEditable`):**
- Strings: markdown detection → rendered HTML, or plain text display
- Images: `isImageUrl()` detects image URLs/paths → `<img>` with zoom capability
- Arrays: delegates to `renderAppArrayOutput()` → card grid via rich renderer or chip list for simple arrays
- Objects: delegates to `renderAppObjectOutput()` → smart decomposition (see below)
- Primitives: inline display

**Smart object decomposition (`renderAppObjectOutput`):**
- Scans all object keys, classifying each child as "complex" (array ≥3 items or object ≥5 keys) or "scalar"
- If ≥1 complex child found: renders as tabbed panel via `renderAppTabbedPanel()`
- Otherwise: falls through to rich renderer or KV grid

**Tabbed panels (`renderAppTabbedPanel`):**
- Summary tab shows scalar fields as KV grid
- One tab per complex child, showing count
- Tab switching wired via click handlers, toggling `.active` and `.app-panel-pane--active`

**Panel array rendering (`renderAppPanelArray`):**
- Card grid with `findBestField()` auto-detection for title, description, type, image, and ID
- Image cards show thumbnail via `resolveImageSrc()`
- Type field rendered as colored pill badge
- Description truncated with CSS line clamping
- Metadata rows for remaining scalar fields
- "▸ Raw Item" button per card opens JSON detail modal
- Filter bar appears for arrays with 10+ items — filters by title/description/ID substring match
- Simple arrays (strings/numbers) render as chip lists instead of cards

**Panel object rendering (`renderAppPanelObject`):**
- KV grid for scalar fields
- Subsections for nested complex children (recursive rendering)

**Image utilities:**
- `isImageUrl(str)` — detects `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.avif`, `.ico`, `.tiff` extensions and `data:image` URIs
- `resolveImageSrc(src)` — passes through `data:`, `http://`, `https://`, `blob:` URLs; converts local filesystem paths to `/api/file?path=` endpoint URLs

**Detail modal:**
- Single general-purpose modal with backdrop blur
- Image mode (`app-detail-modal--image`): full-size `<img>` with `max-height: 85vh`, `max-width: 90vw`, `object-fit: contain`
- JSON mode (`app-detail-modal--json`): title header, "Copy JSON" button, scrollable `<pre>` block with monospace font
- Opens via `openDetailModal(contentHtml, mode)`, closes via X button, backdrop click, or Escape key

**Event wiring (`wireAppActions`):**
- Sidebar navigation click → re-render with new section
- Open Editor / Open Form / Run Pipeline buttons
- Tab switching for tabbed panels
- Filter input for card grids
- Zoomable image click → image modal
- Rich renderer image click → image modal
- Panel card "Raw Item" button → JSON modal via `findPanelItemData()` lookup
- Rich renderer `<details>` "Raw Item" interception → JSON modal via `findRawItemFromDetails()` lookup
- Copy JSON button in modal → clipboard API
- Regenerate button → toast placeholder
- Edit/Copy output block buttons → inline editing or clipboard
- Command bar → toast placeholder

**Data lookup functions:**
- `findPanelItemData(cardKey, index)` — traverses `appState.nodeData[section.nodeId].outputs` recursively to find an array matching `cardKey`, returns item at `index`
- `findRawItemFromDetails(detailsEl)` — finds the card's sibling index, then searches outputs for the first array with an item at that index

---

## 2. Pipeline App Mode — Server API

**File created:** `src/dashboard/routes/pipeline-app.ts` (674 lines)

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/app/:id/schema` | Derive app schema from pipeline graph |
| GET | `/api/app/:id/state` | Load persisted app state |
| PUT | `/api/app/:id/state/:nodeId` | Update a single node's output |
| GET | `/api/app/:id/node/:nodeId` | Fetch one node's data (fast single-file read) |
| POST | `/api/app/:id/invoke/:nodeId` | Re-execute a single node (placeholder) |
| POST | `/api/app/:id/refresh-stale` | Re-execute all stale nodes (placeholder) |
| POST | `/api/app/:id/refresh-from-run` | Populate app state from latest pipeline run |

**Schema derivation (`buildAppSchema`):**
- Topologically sorts all nodes
- Filters out hidden control-flow nodes (junctions, forEach wrappers)
- Groups variable/input nodes into a "Settings" pseudo-section
- Each remaining node becomes a section with: `id`, `label`, `description`, `nodeId`, `icon`, `portDefs[]`
- Port definitions extracted from node output annotations

**State persistence:**
- App state stored at `~/.woodbury/data/app-state/<pipeline-id>.json`
- Structure: `{ pipelineId, lastRunId, nodeData: { [nodeId]: { outputs, updatedAt, stale } } }`
- `persistAppStateFromRun(pipelineId, runResult, ctx)` — called after pipeline execution, migrates run outputs to app state file
- Individual node updates via PUT preserve other nodes' data

**Stale tracking:**
- When a node's output is edited, all downstream nodes are marked `stale: true`
- Uses `getDownstreamNodes()` from `graph-utils.ts` for transitive closure

**Integration:**
- Route handler registered in `src/dashboard/routes/index.ts`
- `persistAppStateFromRun()` called from `composition-run.ts` after successful pipeline runs

---

## 3. Graph Utility Extraction

**File created:** `src/dashboard/graph-utils.ts` (129 lines)

Extracted shared graph algorithms previously duplicated or inline:

- `topoSort(nodes, edges)` — Kahn's algorithm, returns ordered node IDs
- `gatherInputVariables(nodeId, nodes, edges)` — follows incoming edges to collect variable node values as inputs
- `getDownstreamNodes(nodeId, edges)` — BFS transitive closure of all nodes reachable from `nodeId`
- `getUpstreamNodes(nodeId, edges)` — reverse BFS closure
- `getDirectUpstream(nodeId, edges)` — immediate predecessors
- `getDirectDownstream(nodeId, edges)` — immediate successors

Both `composition-run.ts` and `pipeline-app.ts` now import from this shared module.

---

## 4. Code Generation Robustness

**File modified:** `src/dashboard/routes/generation.ts` (+304 lines)

**Anti-pattern validation (`validateGeneratedScriptCode`):**
- `JSON.stringify` on return values → objects should stay native between nodes
- `JSON.parse` on inputs → inputs are already objects in the sandbox
- Unguarded `for...of` iteration without `Array.isArray` check
- `console.log` usage → should use `context.log()`
- `require()` / `import` in sandbox code → not available in VM

**Robustness rules injection:**
- `SCRIPT_ROBUSTNESS_RULES` constant added to every script generation prompt
- Includes examples of bad vs. good patterns
- Covers: native object passing, input validation, array guards, error handling, context.log usage

**Token limit standardization:**
- All LLM generation calls standardized to `maxTokens: 32768`
- Previously ranged from 4096 to 16000, causing truncation and silent failures

---

## 5. Chat Streaming Improvements

**File modified:** `src/config-dashboard/chat.js` (+71 lines)

**Problem:** Tool use pills were prepended before all streamed text, causing the text to appear to "restart" after each tool invocation.

**Fix:** Implemented a linked-list text segment pattern:
- `textRef` object tracks the current active DOM element for text streaming
- When a tool pill arrives, the current text segment is "frozen" and a new one created after the pill
- `_nextSegment` links segments together
- Full accumulated text reconstructed from all segments for chat history
- Conversations now appear in the sidebar list immediately when started

---

## 6. Composition Run Engine Updates

**File modified:** `src/dashboard/routes/composition-run.ts` (+184 lines, -151 lines)

- Added `__script_file__` to `SPECIAL_NODE_IDS` set
- Added `initNodeStates` handling for `__script_file__` nodes
- Full ForEach body execution support for v2 file-backed script nodes:
  - Default missing array/object inputs from port declarations
  - Script context building with progress tracking
  - `executeScriptFile()` integration within iteration loops
- Imported shared graph utilities from `graph-utils.ts`
- Calls `persistAppStateFromRun()` after successful pipeline execution

---

## 7. Pipeline Sync Fixes

**File modified:** `src/dashboard/pipeline-sync.ts` (+70 lines)

- Removed auto-detection of new `.ts` files in `syncAllFilesToManifest()` — was creating phantom nodes for unrelated TypeScript files
- Changed to removal-only sync: nodes whose `.ts` files no longer exist on disk are removed from manifest
- Added stale `.ts` file cleanup during `scaffoldPipeline()` — deletes existing `.ts` files before re-scaffolding to prevent ghost nodes on overwrite

---

## 8. CSS and Visual Polish

**File modified:** `src/config-dashboard/styles.css` (+1,191 lines)

**Gradient overhaul:**
- `.app-shell` — layered radial gradients (deep purple at top-left, blue at bottom-right, dark base)
- `.app-sidebar` — purple wash background + `::before` pseudo-element with 2px vertical accent gradient (violet → blue → transparent)
- `.app-sidebar-header` — radial glow behind title
- `.app-sidebar-title` — gradient text (white → violet) via `background-clip: text`
- `.app-nav-item.active` — horizontal gradient highlight (violet-alpha left → transparent right)
- `.app-content` — radial gradients at top-right and bottom-left corners
- `.app-section-title` — gradient text (white → violet → blue)
- `.app-output-block` — diagonal gradient background + hover glow effect
- `.app-kv-row`, `.app-array-card` — glass-morphism gradients with hover transitions
- `.app-output-text`, `.app-output-markdown` — diagonal gradient backgrounds
- Buttons — 135deg gradients with glow-on-hover effects
- Border colors shifted from white-alpha to purple-alpha throughout

**Tabbed panel styles (~200 lines):**
- `.app-tabbed-panel` — container with subtle border
- `.app-panel-tabs` — horizontal tab bar with gap
- `.app-panel-tab` — inactive/active states with bottom border indicator
- `.app-panel-content` — content area
- `.app-panel-pane` — hidden by default, `.app-panel-pane--active` shows

**Card grid styles:**
- `.app-panel-card-grid` — CSS Grid with `auto-fill`, `minmax(260px, 1fr)`
- `.app-panel-card` — gradient background, rounded corners, hover lift effect
- `.app-panel-card-image` — 140px height, object-fit cover
- `.app-panel-card-body` — padding with field layout
- `.app-panel-card-title` — bold, truncated
- `.app-panel-card-id` — monospace, muted color
- `.app-panel-card-desc` — 3-line clamp with fade
- `.app-panel-card-type` — colored pill badge
- `.app-panel-card-meta` — small key-value rows

**Filter bar:** `.app-panel-filter-bar`, `.app-panel-filter-input`, `.app-panel-filter-count`

**Chip list:** `.app-panel-chip-list`, `.app-panel-chip` — for simple string/number arrays

**Detail modal:**
- `.app-detail-modal` — fixed overlay with z-index 10000
- `.app-detail-modal-backdrop` — `backdrop-filter: blur(8px)`
- `.app-detail-modal-container` — centered, max 90vw/90vh
- `.app-detail-modal--image` — image fits within viewport with object-fit contain
- `.app-detail-modal--json` — max-width 720px, styled header with title and copy button, monospace `<pre>` with scrollable content, syntax-highlighted appearance

**Raw item button:** `.app-panel-card-raw-btn` — subtle link-style button at bottom of cards

**Image output:** `.app-output-image img` — max-width 100%, rounded, cursor zoom-in

---

## 9. Tests

**File modified:** `src/__tests__/v2-pipeline.test.ts` (+49 lines)

- Additional test cases for v2 pipeline port parsing edge cases
- Tests for `syncAllFilesToManifest()` removal-only behavior
- Tests confirming phantom node prevention

All 52 tests passing.

---

## 10. New Files Summary

| File | Lines | Purpose |
|------|-------|---------|
| `src/config-dashboard/compositions-app.js` | 1,215 | Pipeline App Mode client UI |
| `src/dashboard/routes/pipeline-app.ts` | 674 | Pipeline App Mode server API |
| `src/dashboard/graph-utils.ts` | 129 | Shared graph algorithms |

---

## 11. Bugs Found and Fixed

1. **Images not loading in app mode** — Pipeline-generated images used local filesystem paths (`/tmp/character_marcus-chen_headshot.png`) which browsers can't access directly. Fixed by creating `resolveImageSrc()` that converts local paths to the existing `/api/file?path=...` endpoint.

2. **Raw Item JSON showing flattened text** — The rich renderer's structured JSON viewer uses styled HTML divs, so extracting via `textContent` produced concatenated text like `Object3 fieldsid"element_2"type"action"content"Marcus..."`. Fixed by implementing `findRawItemFromDetails()` that looks up the actual data object from `appState` by card index, then formats with `JSON.stringify(item, null, 2)`.

3. **Chat text overwriting on tool use** — Streamed text was replaced when tool pills arrived because all text shared a single DOM element. Fixed by creating linked text segments that freeze when tools interleave.

4. **Phantom nodes from file sync** — `syncAllFilesToManifest()` was auto-adding nodes for `.ts` files found in the pipeline directory, creating duplicates. Changed to removal-only sync.

5. **Stale TypeScript files on pipeline overwrite** — Re-generating a pipeline left old `.ts` files from the previous version. Added cleanup in `scaffoldPipeline()`.

6. **LLM token truncation** — Various generation calls had limits as low as 4096, silently producing incomplete output. Standardized to 32768.

---

## 12. Pending / Placeholder Features

- **Single node re-execution** (`POST /api/app/:id/invoke/:nodeId`) — endpoint exists, returns 501
- **Refresh stale** (`POST /api/app/:id/refresh-stale`) — endpoint exists, returns 501
- **Command bar** — input renders but returns placeholder toast
- **Fix & Re-run button** — plan exists at `.claude/plans/logical-humming-karp.md` but not implemented
- **Regenerate button** — wired but triggers toast placeholder, not actual re-generation
