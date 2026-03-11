# Woodbury Architecture Reference

This document is a reference for an AI assistant (Claude) to maintain context about the
Woodbury codebase. It describes the system's components, data flow, key interfaces, and
storage layout.

For the current implementation status of dashboard chat and the v3 skills-first loop, see [docs/chat-skills-status.md](chat-skills-status.md).

---

## 1. System Overview

Woodbury is a desktop automation platform. It combines browser interaction recording,
visual AI-based element matching, workflow replay, an agentic AI loop, a pipeline
composition engine, and social media management into a single Electron-based desktop
application.

The major subsystems are:

| Subsystem | Entry Point | Description |
|---|---|---|
| Electron App | `electron/main.js` | Desktop shell: tray, menus, auto-updater, dashboard webview |
| Dashboard Server | `src/dashboard/` (24 route modules) | HTTP server on port 9001 with modular route handlers for dashboard APIs |
| Dashboard UI | `src/config-dashboard/` | Browser-side HTML/CSS/JS served by the dashboard server |
| Chrome Extension | (separate extension package) | Records browser interactions, communicates via WebSocket bridge |
| Workflow Engine | `src/workflow/` | Records and replays browser/desktop action sequences |
| Visual AI Inference | `src/inference/` | Node.js ONNX runtime for Siamese network element matching |
| Extension System | `src/extension-loader.ts`, `src/extension-manager.ts` | JSON registry, hot install/uninstall, tool/command registration |
| Agentic Loop | `src/loop/` | AI agent runtime with 34 built-in tools, plus dynamic extension and MCP tools, and a 9-skill v3 routing layer |
| Pipeline Builder | (within dashboard and loop) | DAG-based composition of workflow steps, scripts, and tools |
| Social Media | `src/social/` | Scheduling, posting, content generation |
| Training Pipeline | shells out to Python `woobury_models` | Siamese network training for visual element matching |

---

## 2. Directory Structure

```
src/                         Main TypeScript source
|
|-- loop/                    Embedded agentic loop engine
|   |-- tools/               34 built-in tools exposed by the default registry
|   |                        (file_read, web_fetch, code_execute, etc.)
|   |-- v2/                  Agent builder (API discovery, code gen, decomposition)
|   |-- v3/                  Closure engine (state machine, safety, recovery)
|   +-- types/               Tool schemas and types
|
|-- workflow/                Workflow recording and execution
|   |-- recorder.ts          WorkflowRecorder: Chrome extension events -> .workflow.json
|   |-- executor.ts          WorkflowExecutor: runs steps via bridge server
|   |-- visual-verifier.ts   VisualVerifier: HTTP client for inference server
|   |-- execution-snapshots.ts  Snapshot capture during replay
|   |-- resolver.ts          ElementResolver: CSS selector resolution
|   |-- loader.ts            Discover and load .workflow.json files
|   +-- types.ts             WorkflowDocument, WorkflowStep, step types
|
|-- inference/               Node.js ONNX inference (no Python at runtime)
|   |-- element-matcher.ts   ElementMatcher: ONNX session, embed(), compare()
|   |-- model-cache.ts       LRU cache for loaded models
|   |-- serve.ts             HTTP server on port 8679
|   +-- image-utils.ts       Letterbox, crop, ImageNet normalization
|
|-- social/                  Social media storage and scripts
|
|-- config-dashboard/        Dashboard web UI (browser-side assets)
|   |-- index.html           HTML structure (~170 lines after CSS extraction)
|   |-- styles.css           All dashboard styles (6,287 lines)
|   |-- app.js               Core app logic, navigation, notifications
|   |-- compositions.js      Pipeline/composition UI (10,493 lines -- to be split)
|   |-- workflows.js         Workflow UI (5,465 lines -- to be split)
|   |-- social.js            Social media UI
|   +-- [other view files]
|
|-- dashboard/               Dashboard HTTP server (modular)
|   |-- server.ts            startDashboard(), scheduler, inference lifecycle
|   |-- types.ts             DashboardContext, RouteHandler, state interfaces
|   |-- context.ts           createDashboardContext() factory
|   |-- utils.ts             sendJson, readBody, maskValue, MIME_TYPES
|   |-- middleware.ts         CORS, static file serving, API logging
|   +-- routes/              24 route handler modules (see docs/dashboard-api.md)
|
|-- config-dashboard.ts      Backward-compatibility facade (re-exports from dashboard/)
|-- cli.ts                   Commander-based CLI argument parsing
|-- repl.ts                  Interactive REPL loop
|-- extension-loader.ts      Extension discovery, registry, manifest validation
|-- extension-manager.ts     Extension lifecycle (activation, tools, commands)
|-- agent-factory.ts         Creates Agent + ToolRegistry, wires tools
|-- system-prompt.ts         Dynamic system prompt builder
|-- bridge-server.ts         WebSocket bridge to Chrome extension
+-- debug-log.ts             File-based debug logging

electron/
|-- main.js                  Electron main process: tray, menus, auto-updater
+-- preload.js               IPC bridge between renderer and main process

docs/                        Markdown documentation
extensions/                  Bundled extensions (copied to dist/extensions/ at build)
```

---

## 3. Component Architecture

```
+----------------------------------------------------------+
|                    Electron Shell                         |
|  electron/main.js                                        |
|  - BrowserWindow (dashboard webview)                     |
|  - Tray icon, menus                                      |
|  - Auto-updater                                          |
|  - IPC via preload.js                                    |
+---------------------------+------------------------------+
                            |
                            | loads http://localhost:9001
                            v
+----------------------------------------------------------+
|              Dashboard HTTP Server (:9001)                |
|  src/config-dashboard.ts  (modular dashboard API surface) |
|  Being refactored into src/dashboard/                    |
|                                                          |
|  Serves:                                                 |
|  - Static UI from src/config-dashboard/                  |
|  - REST APIs for workflows, extensions, pipelines,       |
|    social media, agent control, training, inference       |
+----+-----------+-----------+-----------+-----------------+
     |           |           |           |
     v           v           v           v
+---------+ +---------+ +---------+ +----------+
| Workflow| |Extension| | Agentic | | Social   |
| Engine  | | System  | | Loop    | | Media    |
+---------+ +---------+ +---------+ +----------+
     |                       |
     v                       v
+---------+           +------------+
| Bridge  |           | 34 Built-in |
| Server  |           | (loop/     |
| (WS)    |           |  tools/)   |
+---------+           +------------+
     |
     v
+---------+           +-------------------+
| Chrome  |           | Visual AI         |
| Ext.    |           | Inference (:8679) |
+---------+           | src/inference/    |
                      +-------------------+
                             |
                             | loads
                             v
                      +-------------------+
                      | ONNX Models       |
                      | (~/.woodbury/     |
                      |  data/models/)    |
                      +-------------------+
```

---

## 4. Data Flow

### 4.1 Recording

```
Chrome Browser
    |
    |  user actions (click, type, navigate, etc.)
    v
Chrome Extension
    |
    |  WebSocket messages
    v
bridge-server.ts (WebSocket bridge)
    |
    v
WorkflowRecorder (src/workflow/recorder.ts)
    |
    |  writes
    v
.workflow.json + screenshots  -->  ~/.woodbury/data/
```

The Chrome extension captures DOM events and serializes them as workflow steps. The
WebSocket bridge relays these to the `WorkflowRecorder`, which persists them as
`.workflow.json` files with associated screenshot images.

### 4.2 Training

```
Dashboard API trigger
    |
    v
python -m woobury_models.prepare
    |  crops elements from screenshots
    v
~/.woodbury/data/training-crops/
    |
    v
python -m woobury_models.train
    |  trains Siamese network
    v
encoder.onnx  -->  ~/.woodbury/data/models/
```

Training is performed by shelling out to the Python `woobury_models` package. The
prepare step crops UI elements from recorded screenshots. The train step produces an
ONNX-format Siamese network encoder used for visual element matching at runtime.

### 4.3 Inference

```
Node.js ONNX Server (src/inference/serve.ts, port 8679)
    |
    |  loads encoder.onnx at startup
    |
    |  serves HTTP endpoints:
    |    POST /embed    -- compute embedding vector for an image
    |    POST /compare  -- cosine similarity between two embeddings
    |    POST /search   -- find best match among candidates
    v
ElementMatcher (src/inference/element-matcher.ts)
    |  ONNX session via onnxruntime-node
    |  LRU model cache (model-cache.ts)
    +-- image-utils.ts: letterbox, crop, ImageNet normalization
```

The inference server runs entirely in Node.js using `onnxruntime-node`. No Python is
required at runtime. The `ElementMatcher` loads ONNX models, computes embedding vectors
for UI element screenshots, and compares them to find visual matches.

### 4.4 Replay (Workflow Execution)

```
WorkflowExecutor (src/workflow/executor.ts)
    |
    |  for each WorkflowStep:
    |
    |-- ElementResolver (resolver.ts)
    |       resolves CSS selectors in the target page
    |
    |-- VisualVerifier (visual-verifier.ts)
    |       HTTP client to inference server (:8679)
    |       confirms element identity via visual matching
    |
    |-- execution-snapshots.ts
    |       captures screenshots at each step for debugging
    |
    +-- bridge-server.ts
            sends action commands to Chrome extension
            (click, type, navigate, scroll, etc.)
```

During replay, the executor iterates through workflow steps. For each step it resolves
the target element (CSS selector + optional visual verification), sends the action to the
Chrome extension via the WebSocket bridge, and captures a snapshot of the result.

### 4.5 Pipelines (Composition Engine)

```
Pipeline Definition (DAG of nodes)
    |
    |  topological sort
    v
Execute nodes in dependency order:
    |
    |-- workflow node   -->  WorkflowExecutor
    |-- script node     -->  child_process (JS/Python/Shell)
    |-- tool node       -->  Agentic loop tool
    |-- file node       -->  file read/write
    |-- branch node     -->  conditional routing
    |
    +-- outputs passed between nodes via pipeline context
```

Pipelines are directed acyclic graphs (DAGs) of heterogeneous nodes. The engine performs
a topological sort, then executes each node, passing outputs from upstream nodes to
downstream inputs. Idempotency caching is stored in `~/.woodbury/cache/`.

---

## 5. Key Subsystem Details

### 5.1 Dashboard Server

- **File**: `src/config-dashboard.ts` (14,640 lines -- actively being refactored into
  `src/dashboard/` as smaller modules)
- **Port**: 9001
- **Endpoints**: 155+ REST API routes covering workflows, extensions, pipelines, social
  media, agent control, training, inference, configuration
- **Static Assets**: served from `src/config-dashboard/` (HTML, CSS, JS)

### 5.2 Dashboard UI

The browser-side UI is plain HTML/CSS/JS (no framework). Key files:

- `compositions.js` (10,493 lines) -- pipeline/composition builder UI, to be split
- `workflows.js` (5,465 lines) -- workflow management UI, to be split
- `styles.css` (6,287 lines) -- all dashboard styles
- `app.js` -- core application logic, navigation, notifications

### 5.3 Agentic Loop

Located in `src/loop/`. Provides an AI runtime with 34 built-in default tools, plus extension and MCP tools that can be added at runtime. The v3 closure engine also routes requests through a first-class skill layer before exposing a scoped tool subset.

- File operations (read, write, search, glob)
- Code execution and analysis
- Web fetching and scraping
- Task and project management
- Workflow and pipeline control
- Extension management

Sub-versions within the loop:

- `v2/` -- Agent builder: API discovery, code generation, task decomposition
- `v3/` -- Closure engine: state machine execution, continuation/resume, skills-first routing, safety constraints, and error recovery

Entry point: `src/agent-factory.ts` creates an `Agent` instance with a `ToolRegistry`
and wires all tool implementations.

### 5.4 Extension System

- **Discovery**: `src/extension-loader.ts` -- validates manifests, loads from registry
- **Lifecycle**: `src/extension-manager.ts` -- `loadAll()`, `whenReady()`, `hotInstall()`,
  `hotUninstall()`, `getAllTools()`
- **Registry**: JSON-backed (`~/.woodbury/extensions/registry.json`), not filesystem
  scanning
- **Extension API**: each extension exports `activate(ctx)` receiving a context with:
  - `registerTool(name, handler)` -- add a tool to the tool registry
  - `registerCommand(name, handler)` -- add a command
  - `addSystemPrompt(text)` -- inject text into the system prompt
  - `serveWebUI(path)` -- serve a web UI panel in the dashboard
- **Extension storage**: `~/.woodbury/extensions/<ext-name>/` with `package.json`
  manifest and optional `.env` for extension-specific environment variables
- **Hot reload**: install and uninstall without restarting the application

### 5.5 WebSocket Bridge

`src/bridge-server.ts` manages bidirectional WebSocket communication between the Node.js
backend and the Chrome extension. It relays:

- Recording events (Chrome extension --> backend)
- Replay commands (backend --> Chrome extension)
- Element queries and responses
- Page state updates

---

## 6. Extension System Architecture

```
~/.woodbury/extensions/
|
|-- registry.json              Metadata for all registered extensions
|
|-- <extension-name>/
|   |-- package.json           Manifest: name, version, main, tools, commands
|   |-- .env                   Extension-specific environment variables
|   |-- index.js               Entry point, exports activate(ctx)
|   +-- ...                    Extension implementation files
|
+-- <another-extension>/
    +-- ...
```

Lifecycle:

```
ExtensionManager.loadAll()
    |
    |  reads registry.json
    |  for each enabled extension:
    |
    v
ExtensionLoader.load(manifest)
    |  validates package.json
    |  requires main entry point
    |  calls activate(ctx)
    |
    v
Extension registers tools, commands, prompts, web UI
    |
    v
ExtensionManager.whenReady()  -->  all extensions loaded
```

---

## 7. Storage Layout

```
~/.woodbury/
|
|-- .env                       Global API keys
|                              (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
|
|-- extensions/
|   |-- registry.json          Extension metadata registry
|   +-- <ext-name>/
|       |-- .env               Extension-specific env vars
|       +-- package.json       Extension manifest
|
|-- data/
|   |-- models/                Trained ONNX models (encoder.onnx, etc.)
|   |-- training-crops/        Cropped element images for training
|   |-- runs/                  Workflow and pipeline execution records
|   |-- schedules.json         Pipeline schedule definitions
|   +-- script-tool-docs.json  Tool documentation overrides
|
|-- logs/                      Debug log files
|-- cache/                     Idempotency cache for pipeline nodes
+-- workflows/                 User workflow .workflow.json files
```

---

## 8. Key Interfaces

### DashboardHandle

Returned by `startDashboard()`. Provides:

- `url: string` -- the dashboard URL (e.g., `http://localhost:9001`)
- `port: number` -- the bound port
- `close(): Promise<void>` -- shuts down the HTTP server

### ExtensionManager

Lifecycle coordinator for all extensions:

- `loadAll()` -- load and activate all enabled extensions from the registry
- `whenReady()` -- returns a promise that resolves when all extensions are loaded
- `hotInstall(path)` -- install an extension at runtime without restart
- `hotUninstall(name)` -- remove an extension at runtime
- `getAllTools()` -- collect tools registered by all active extensions

### ExtensionRegistry

JSON-backed persistent registry (`registry.json`):

- `load()` -- read registry from disk
- `save()` -- write registry to disk
- `getEnabled()` -- list enabled extensions
- `register(metadata)` -- add or update an extension entry

### WorkflowRecorder

Captures browser events from the Chrome extension bridge:

- Receives WebSocket messages from `bridge-server.ts`
- Converts events into `WorkflowStep` objects
- Persists `WorkflowDocument` as `.workflow.json`
- Saves associated screenshots

### WorkflowExecutor

Replays recorded workflow steps:

- Iterates through `WorkflowStep` list
- Uses `ElementResolver` for CSS selector resolution
- Uses `VisualVerifier` for visual element confirmation
- Sends commands to Chrome extension via bridge
- Records execution snapshots

### VisualVerifier

HTTP client for the inference server:

- `verify(element, screenshot)` -- check if an element matches visually
- Communicates with the ONNX inference server on port 8679

### Agent (from src/loop/)

Agentic loop controller:

- Manages conversation turns with the AI model
- Routes tool calls to the `ToolRegistry`
- Handles v2 (agent builder) and v3 (closure engine) execution modes

### ToolRegistry

Central registry of all available tools:

- Registers tools from the core system and extensions
- Provides tool schemas for the AI model
- Dispatches tool calls to implementations

---

## 9. Workflow Document Format

Workflow files (`.workflow.json`) follow this structure:

```
WorkflowDocument
|-- id: string
|-- name: string
|-- created: ISO timestamp
|-- steps: WorkflowStep[]
    |
    +-- Each step:
        |-- type: click | type | navigate | scroll | wait | ...
        |-- selector: CSS selector string
        |-- value: (for type steps) text to enter
        |-- url: (for navigate steps) target URL
        |-- screenshot: path to captured screenshot
        +-- metadata: timing, coordinates, etc.
```

---

## 10. Build System

| Concern | Tool | Notes |
|---|---|---|
| TypeScript compilation | `tsc` | Target ES2022, CommonJS output |
| Import style | `.js` extensions | All TypeScript imports use `.js` suffix |
| Postbuild | custom script | Copies `src/config-dashboard/` and `extensions/` to `dist/` |
| Testing | Jest + ts-jest | Unit and integration tests |
| Desktop packaging | `electron-builder` | macOS builds |

Build output goes to `dist/`. The postbuild step ensures browser-side assets and bundled
extensions are available in the distribution.

---

## 11. Port Assignments

| Port | Service | Source |
|---|---|---|
| 9001 | Dashboard HTTP server | `src/config-dashboard.ts` |
| 8679 | ONNX inference server | `src/inference/serve.ts` |
| (dynamic) | WebSocket bridge | `src/bridge-server.ts` |

---

## 12. Active Refactoring Notes

- `src/config-dashboard.ts` (14,640 lines) is being refactored into smaller modules
  under `src/dashboard/`. When working on dashboard API endpoints, check both locations.
- `src/config-dashboard/compositions.js` (10,493 lines) is slated to be split into
  smaller view modules.
- `src/config-dashboard/workflows.js` (5,465 lines) is slated to be split into smaller
  view modules.
