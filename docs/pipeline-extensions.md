# Pipeline Extensions — Architecture & Authoring Guide

Woodbury pipelines are visual node graphs that process data through connected steps. The **pipeline extension system** lets each pipeline ship its own server-side API routes and custom UI views, keeping domain-specific logic out of Woodbury core.

This document covers the full architecture: how pipelines are structured, discovered, and rendered; how to build custom views; how to add server-side routes; and how all the pieces connect.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Pipeline Structure](#2-pipeline-structure)
3. [Pipeline Discovery](#3-pipeline-discovery)
4. [App Mode — How Pipelines Become Applications](#4-app-mode)
5. [Schema Derivation — Turning Graphs into Navigation](#5-schema-derivation)
6. [The View System — Building Custom UIs](#6-the-view-system)
7. [The Route System — Adding Server-Side APIs](#7-the-route-system)
8. [State Management — Project Data Flow](#8-state-management)
9. [Bindings & Rules](#9-bindings--rules)
10. [Core API Endpoints Reference](#10-core-api-endpoints-reference)
11. [Creating a New Pipeline from Scratch](#11-creating-a-new-pipeline-from-scratch)
12. [Reference: Script Generator Pipeline](#12-reference-script-generator-pipeline)

---

## 1. System Overview

A Woodbury pipeline extension has three layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Pipeline Composition                                       │
│  (.composition.json or pipeline.json)                       │
│  Defines nodes, edges, variables, and metadata              │
├─────────────────────────────────────────────────────────────┤
│  Custom Views (optional)                                    │
│  views/{name}/manifest.json + view.bundle.js                │
│  React or vanilla JS UIs rendered in the app sidebar        │
├─────────────────────────────────────────────────────────────┤
│  Custom Routes (optional)                                   │
│  routes/index.ts → compiled to routes/index.js              │
│  Server-side API endpoints accessed by the views            │
└─────────────────────────────────────────────────────────────┘
```

**Data flow at runtime:**

```
User clicks pipeline "app" mode
  → Woodbury core derives schema from the node graph
  → React shell mounts <PipelineApp> with sidebar + content area
  → Views discovered from views/ directory, loaded as bundles
  → Views call core APIs (/api/app/:id/state, /api/project/:id)
  → Views call pipeline-specific APIs (/api/app/:id/generate-previs)
  → Pipeline route handler (routes/index.js) processes the request
  → Route handler uses PipelineRouteSdk to access project data, tools, etc.
  → Results flow back to the view
```

### Key source files

| File | Purpose |
|------|---------|
| `src/dashboard/routes/pipeline-app.ts` | Core app-mode endpoints (schema, state, views, saves) |
| `src/dashboard/pipeline-route-sdk.ts` | `PipelineRouteSdk` interface definition |
| `src/dashboard/pipeline-route-factory.ts` | SDK factory, dynamic route loader, cache |
| `src/config-dashboard/react/components/PipelineApp.tsx` | React app shell (sidebar + view bridges) |
| `src/config-dashboard/react/components/Sidebar.tsx` | Sidebar component |
| `src/config-dashboard/react/stores/PipelineProvider.tsx` | React state management (3 contexts) |
| `src/config-dashboard/react/index.tsx` | Bootstrap: mounts React, exposes View SDK |
| `src/config-dashboard/react/api/appApi.ts` | Client-side API helpers |
| `src/dashboard/routes/project.ts` | Project data CRUD endpoints |
| `src/dashboard/project-state.ts` | ProjectStateManager (in-memory + disk) |
| `src/workflow/loader.ts` | Pipeline/composition discovery |

---

## 2. Pipeline Structure

### Directory layout

A pipeline extension lives in a single directory:

```
my-pipeline/
├── my-pipeline.composition.json   # v1: single-file composition
│   OR
├── pipeline.json                  # v2: file-backed pipeline manifest
├── src/                           # v2: TypeScript node scripts
│   ├── generate-content.ts
│   └── process-data.ts
│
├── views/                         # Custom UI views (optional)
│   ├── build.mjs                  # esbuild script for React bundles
│   ├── overview/
│   │   ├── manifest.json
│   │   ├── entry.tsx
│   │   ├── OverviewView.tsx
│   │   └── view.bundle.js        # Built output
│   ├── editor/
│   │   ├── manifest.json
│   │   ├── entry.tsx
│   │   ├── EditorView.tsx
│   │   ├── view.bundle.js
│   │   └── view.css              # Optional stylesheet
│   └── ...
│
├── routes/                        # Custom server-side routes (optional)
│   ├── index.ts                   # Route handler source
│   ├── build.mjs                  # esbuild script
│   └── index.js                  # Built output (ESM)
│
├── actions/                       # Action config files (optional)
│   └── my-action.json
│
└── bindings/                      # Auto-created by bindings system
    ├── bindings.json
    └── rules.json
```

### v1 Composition format (`.composition.json`)

A single JSON file containing the full pipeline definition:

```json
{
  "version": "1.0",
  "id": "my-unique-pipeline-id",
  "name": "My Pipeline",
  "description": "What this pipeline does",
  "folder": "optional-folder-name",
  "metadata": {
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z",
    "projectFolder": "/path/to/default/project/folder",
    "logo": "data:image/png;base64,..."
  },
  "nodes": [...],
  "edges": [...]
}
```

### v2 Pipeline format (`pipeline.json`)

A manifest file with TypeScript source code in separate files:

```json
{
  "version": "2.0",
  "id": "my-pipeline-id",
  "name": "My Pipeline",
  "nodes": [
    {
      "id": "node-1",
      "workflowId": "__script_file__",
      "label": "Generate Content",
      "scriptFile": {
        "file": "src/generate-content.ts",
        "outputs": [
          { "name": "result", "type": "object", "description": "Generated content" }
        ]
      }
    }
  ],
  "edges": [...]
}
```

### Node types

| `workflowId` | Purpose | Visible in App UI? |
|---------------|---------|---------------------|
| `__variable__` | Input variable (settings field) | Only if `exposeAsInput: true` → Settings section |
| `__output__` | Pipeline final output | Yes → "Overview" section |
| `__script__` | Inline JavaScript execution | Yes → node section |
| `__script_file__` | File-backed TypeScript (v2) | Yes → node section |
| `__text__` | Static text | Yes |
| `__tool__` | Extension tool invocation | Yes |
| `__asset__` | Asset reference | Yes |
| `__media__` / `__image_viewer__` | Media display | Yes |
| `__file_read__` / `__file_write__` / `__file_op__` | File operations | Yes |
| `__branch__` | Conditional branch | Hidden |
| `__delay__` | Execution delay | Hidden |
| `__gate__` / `__switch__` / `__junction__` | Flow control | Hidden |
| `__for_each__` | Loop iteration | Hidden |
| `__approval_gate__` | Human approval step | Hidden |
| `__get_variable__` | Variable reader | Hidden |

### Edge format

```json
{
  "id": "edge-1",
  "sourceNodeId": "node-1",
  "sourcePort": "result",
  "targetNodeId": "node-2",
  "targetPort": "input"
}
```

### Variable node (settings input)

```json
{
  "id": "node-1",
  "workflowId": "__variable__",
  "label": "Project Type",
  "variableNode": {
    "inputName": "projectType",
    "type": "string",
    "description": "What kind of project?",
    "exposeAsInput": true,
    "required": false,
    "initialValue": "",
    "options": ["Short Film", "Feature Film", "TV Episode"],
    "inputControl": "select"
  }
}
```

**Variable types**: `string`, `number`, `boolean`, `object`, `array`
**Input controls**: `text` (default), `textarea`, `select`, `checkbox`, `number`

---

## 3. Pipeline Discovery

Woodbury scans four locations for pipelines, in this order:

| Priority | Location | Source label | Contents |
|----------|----------|--------------|----------|
| 1 | `./extensions/*/` | `extension` | Bundled extensions (shipped with Woodbury) |
| 2 | `~/.woodbury/extensions/*/` | `extension` | User-installed extensions |
| 3 | `{workDir}/.woodbury-work/workflows/` | `project` | Project-local pipelines |
| 4 | `~/.woodbury/workflows/` | `global` | Global user pipelines |

**Discovery logic** (`src/workflow/loader.ts`):

1. Each directory is scanned for:
   - **v1**: Files ending in `.composition.json`
   - **v2**: Subdirectories containing `pipeline.json`
2. Extension directories also scan a `workflows/` subdirectory
3. Results are deduplicated by composition ID (first one wins)
4. Results are cached in memory until `invalidateCompositionCache()` is called

**DiscoveredComposition** record:

```typescript
interface DiscoveredComposition {
  path: string;                    // File path to .composition.json or pipeline.json
  composition: CompositionDocument;
  source: 'project' | 'global' | 'extension';
  extensionName?: string;          // Name of the parent extension
  isV2Pipeline?: boolean;          // True if loaded from pipeline.json
  pipelineDir?: string;            // Absolute path to pipeline directory (v2 only)
}
```

### Where to place your pipeline

- **Bundled with Woodbury**: `extensions/my-pipeline/my-pipeline.composition.json`
- **User extension**: `~/.woodbury/extensions/my-pipeline/my-pipeline.composition.json`
- **Global standalone**: `~/.woodbury/workflows/my-pipeline.composition.json`
- **Project-local**: `.woodbury-work/workflows/my-pipeline.composition.json`

---

## 4. App Mode

When a user selects a pipeline and switches to "app" view, the pipeline transforms from a node graph editor into a purpose-built application.

### Activation flow

```
1. User clicks pipeline in sidebar → selectComposition(id)
2. URL hash set to #compositions/{id}/app
3. compositions-core.js calls renderCompositionAppPage()
4. React's index.tsx overrides this function:
   a. Fetch /api/app/:id/schema  (navigation structure)
   b. Fetch /api/app/:id/state   (current data)
   c. Fetch /api/app/:id/bindings (entity relationships)
   d. Load pipeline custom views (JS/CSS bundles)
   e. Mount <PipelineApp> React component
5. PipelineApp renders:
   - <Sidebar> with view tabs + node sections
   - <DynamicViewBridge> for the active view
```

### PipelineApp component tree

```
<PipelineProvider pipelineId={id}>        ← State management
  <PipelineAppInner>
    <Sidebar                              ← Left panel
      availableViews={[...]}              ← From /views endpoint + registry
      schema={schema}                     ← From /schema endpoint
      appState={appState}                 ← From /state endpoint
    />
    <DynamicViewBridge                    ← Right panel
      viewName={currentView}
      pipelineId={id}
    />
    <ImportScriptModal />                 ← Overlay (when triggered)
  </PipelineAppInner>
</PipelineProvider>
```

### Sidebar structure

The sidebar displays (top to bottom):

1. **Header**: Pipeline logo, name, description, project folder link
2. **View tabs**: Custom views sorted by `order` (from manifest)
3. **Node sections**: Collapsible panel showing pipeline processing nodes
4. **Action buttons**: Run Pipeline, New Project, Import Script, etc.
5. **Save/Load**: Save and load project snapshots
6. **Git status**: Uncommitted changes, commit & push

---

## 5. Schema Derivation

The schema endpoint (`GET /api/app/:id/schema`) analyzes the pipeline's node graph and produces a navigation structure.

### How nodes become sections

```
Pipeline Graph                          App Schema Sections
┌──────────────┐
│ __variable__  │ ──── exposeAsInput ──→ { type: 'settings' }
│ (settings)    │                        One section for all variables
└──────────────┘

┌──────────────┐
│ __output__   │ ──────────────────────→ { type: 'overview' }
│ (final)      │                        Always present
└──────────────┘

┌──────────────┐
│ __script__   │ ──────────────────────→ { type: 'node-output' }
│ (processing) │                        One section per visible node
└──────────────┘

┌──────────────┐
│ __branch__   │ ──────────────────────→ (hidden, not in schema)
│ (control)    │
└──────────────┘
```

### AppSchema response shape

```typescript
interface AppSchema {
  pipelineId: string;
  name: string;
  description: string;
  logo?: string;
  sections: AppSection[];
  edges: Array<{
    sourceNodeId: string;
    sourcePort: string;
    targetNodeId: string;
    targetPort: string;
  }>;
  executionOrder: string[];  // Topologically sorted node IDs
}

interface AppSection {
  id: string;                  // Node ID or '_settings'/'_overview'
  type: 'settings' | 'overview' | 'node-output';
  nodeId?: string;             // Pipeline node this maps to
  label: string;               // Display name
  icon: string;                // Icon name ('output', 'code', 'text', etc.)
  description: string;
  outputPorts: Array<{
    name: string;
    type: string;
    description: string;
  }>;
  canRegenerate: boolean;      // Can this node be re-executed?
  downstreamNodeIds: string[]; // Nodes that depend on this one
  upstreamNodeIds: string[];   // Nodes this one depends on
}
```

### Node-to-Project mapping

For the script-generator pipeline, a hardcoded `NODE_KEY_MAP` maps node IDs to project data keys:

```typescript
const NODE_KEY_MAP = {
  'node-4':  'metadata',
  'node-5':  'characters',
  'node-6':  'locations',
  'node-7':  'sections',
  'node-10': 'elements',
  'node-12': 'assets',
  'node-13': 'previsualizations',
  'node-15': '_assembly',    // Special: reads/writes entire project
  'node-16': '_output',      // Special: reads/writes entire project
  'node-17': 'dialogueAudio',
};
```

> **Note**: This mapping is currently hardcoded in core for the script-generator pipeline. Future work should make this configurable per-pipeline.

---

## 6. The View System

Views are the custom UI panels that display in the main content area when selected in the sidebar. Each pipeline ships its own views.

### View types

| Type | Format | Registration | Best for |
|------|--------|--------------|----------|
| **React** | `view.bundle.js` (IIFE) | `registerReactView()` | Rich interactive UIs, access to React state |
| **Vanilla** | `view.js` | `registerPipelineView()` | Simple displays, no React dependency |

### Creating a React view

#### Step 1: Create the directory structure

```
my-pipeline/views/my-view/
├── manifest.json        # Required: metadata
├── entry.tsx            # Required: registers the view
├── MyView.tsx           # Your React component
├── sdk.ts               # SDK shim for imports
├── view.css             # Optional: stylesheet
└── view.bundle.js       # Built output (generated)
```

#### Step 2: Write the manifest

```json
{
  "name": "my-view",
  "label": "My View",
  "icon": "📊",
  "type": "react",
  "bundle": "view.bundle.js",
  "order": 20,
  "description": "Optional description"
}
```

**Manifest fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | directory name | Unique view identifier |
| `label` | No | `name` | Display name in sidebar |
| `icon` | No | (none) | Emoji string or SVG string |
| `type` | No | `"vanilla"` | `"react"` or `"vanilla"` |
| `bundle` | No | `"view.js"` | JS file to load |
| `order` | No | `50` | Sort order (lower = higher in sidebar) |
| `description` | No | (none) | Tooltip text |

#### Step 3: Create the SDK shim (`sdk.ts`)

The SDK shim re-exports hooks and components from the host app's runtime globals. This lets your view code import from `./sdk` with proper types, while the actual implementations are resolved at runtime from `window.__WoodburyViewSDK`.

```typescript
/**
 * SDK shim — resolves imports at runtime from the host app.
 * React imports are handled by the esbuild externals plugin.
 */
const SDK = (window as any).__WoodburyViewSDK as any;

export const usePipeline = SDK.usePipeline;
export const usePipelineIdentity = SDK.usePipelineIdentity;
export const useProjectData = SDK.useProjectData;
export const useAIOperations = SDK.useAIOperations;
export const ImageZoom = SDK.ImageZoom;
export const PipelineProvider = SDK.PipelineProvider;

// Type aliases (use `any` until @woodbury/view-sdk package exists)
export type Character = any;
export type Location = any;
export type ProjectData = any;
```

**What `__WoodburyViewSDK` exposes:**

| Export | Type | Description |
|--------|------|-------------|
| `React` | module | Full React library |
| `ReactDOM` | module | React DOM |
| `jsxRuntime` | module | `react/jsx-runtime` for JSX transform |
| `PipelineProvider` | component | State provider (wraps your view) |
| `usePipeline` | hook | All pipeline state + methods (composite) |
| `usePipelineIdentity` | hook | Pipeline ID, name, loading, saving, etc. |
| `useProjectData` | hook | Project data + update methods |
| `useAIOperations` | hook | AI enrichment + image generation |
| `ImageZoom` | component | Zoomable image viewer |
| `registerReactView` | function | Register a view component |

#### Step 4: Create the entry point (`entry.tsx`)

The entry point imports your component and registers it:

```typescript
import { MyView } from './MyView';
const sdk = (window as any).__WoodburyViewSDK;
sdk.registerReactView({ name: 'my-view', component: MyView });
```

The `name` must match the `name` in `manifest.json`.

#### Step 5: Write your view component (`MyView.tsx`)

```tsx
import React, { useState, useEffect } from 'react';
import { usePipeline, useProjectData, usePipelineIdentity, ImageZoom } from './sdk';

export function MyView() {
  const { pipelineId, loading } = usePipelineIdentity();
  const { project, updateProject } = useProjectData();

  if (loading) return <div>Loading...</div>;
  if (!project) return <div>No project loaded. Import a script or run the pipeline.</div>;

  return (
    <div style={{ padding: 20, height: '100%', overflow: 'auto' }}>
      <h2>{project.metadata?.title || 'Untitled'}</h2>
      <p>{project.characters?.length || 0} characters</p>
      <p>{project.locations?.length || 0} locations</p>

      {/* Fetch custom data from your pipeline routes */}
      <button onClick={async () => {
        const res = await fetch(`/api/app/${encodeURIComponent(pipelineId)}/my-endpoint`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ someParam: 'value' }),
        });
        const data = await res.json();
        console.log('Result:', data);
      }}>
        Call Custom Endpoint
      </button>
    </div>
  );
}
```

#### Step 6: Create the build script (`views/build.mjs`)

```javascript
#!/usr/bin/env node
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plugin: redirect React imports to host app globals
const woodburyExternalsPlugin = {
  name: 'woodbury-externals',
  setup(build) {
    build.onResolve(
      { filter: /^react$|^react-dom$|^react\/jsx-runtime$|^react-dom\/client$/ },
      (args) => ({ path: args.path, namespace: 'woodbury-sdk' })
    );
    build.onLoad({ filter: /.*/, namespace: 'woodbury-sdk' }, (args) => {
      const mapping = {
        'react': 'window.__WoodburyViewSDK.React',
        'react-dom': 'window.__WoodburyViewSDK.ReactDOM',
        'react-dom/client': 'window.__WoodburyViewSDK.ReactDOM',
        'react/jsx-runtime': 'window.__WoodburyViewSDK.jsxRuntime',
      };
      return {
        contents: `module.exports = ${mapping[args.path] || 'window.__WoodburyViewSDK.React'};`,
        loader: 'js',
      };
    });
  },
};

// Find all views with entry.tsx
const viewsDir = __dirname;
const dirs = readdirSync(viewsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .filter(d => existsSync(join(viewsDir, d.name, 'entry.tsx')));

console.log(`build:views — building ${dirs.length} view bundle(s)...`);

for (const dir of dirs) {
  await build({
    entryPoints: [join(viewsDir, dir.name, 'entry.tsx')],
    bundle: true,
    outfile: join(viewsDir, dir.name, 'view.bundle.js'),
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'react',
    plugins: [woodburyExternalsPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: false,
    sourcemap: 'inline',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });
  console.log(`  ✓ ${dir.name}/view.bundle.js`);
}
```

#### Step 7: Build

```bash
node my-pipeline/views/build.mjs
```

### How view loading works at runtime

```
1. PipelineApp fetches GET /api/app/:id/views
   → Server scans views/ directory, reads manifests
   → Returns [{name, label, icon, type, order, hasCSS, bundle}, ...]

2. PipelineApp also checks __woodburyReactViewRegistry
   → Merges server-discovered views with already-registered ones
   → Deduplicates by name (server-discovered takes priority for metadata)

3. Views sorted by order, rendered as sidebar buttons

4. When a view is selected:
   → DynamicViewBridge checks if type is 'react' or in registry
   → If React: ReactViewBridge loads /view-file/:name/view.bundle.js
     → Bundle executes, calls registerReactView()
     → Component is rendered inside PipelineProvider
   → If vanilla: VanillaViewBridge loads view.js, calls render()

5. CSS loading:
   → React views: loadPipelineCustomViews() pre-loads view.css with scoping
   → Views can also load CSS themselves via <link> element
   → CSS is automatically scoped: .pipeline-view-scope[data-pipeline-view="name"] ...
```

### Available React hooks in views

#### `usePipelineIdentity()` — Pipeline metadata (rarely re-renders)

```typescript
const {
  pipelineId,       // string — Pipeline composition ID
  pipelineName,     // string — Display name
  projectFolder,    // string | null — External project folder path
  loading,          // boolean — Initial load in progress
  saving,           // boolean — Save in progress
  dirty,            // boolean — Unsaved changes exist
  error,            // string | null — Last error message
  reload,           // () => Promise<void> — Reload from server
  saveProject,      // () => Promise<void> — Save to disk
  clearProject,     // () => Promise<void> — Clear all data
  setProjectFolder, // (path: string) => Promise<void>
} = usePipelineIdentity();
```

#### `useProjectData()` — Project data (re-renders on edits)

```typescript
const {
  project,           // ProjectData | null — Full project data
  updateProject,     // (partial: Partial<ProjectData>) => void
  updateCharacter,   // (id: string, updates: Partial<Character>) => void
  updateLocation,    // (id: string, updates: Partial<Location>) => void
  updateElement,     // (id: string, updates: Partial<Element>) => void
} = useProjectData();
```

#### `useAIOperations()` — AI enrichment (never causes re-renders)

```typescript
const {
  enrichCharacter,          // (id: string) => Promise<void>
  enrichLocation,           // (id: string) => Promise<void>
  enrichAllCharacters,      // () => Promise<void>
  enrichAllLocations,       // () => Promise<void>
  generateCharacterImages,  // (ids?: string[]) => Promise<void>
  generateLocationImages,   // (ids?: string[]) => Promise<void>
} = useAIOperations();
```

#### `usePipeline()` — Composite hook (all of the above merged)

```typescript
const pipeline = usePipeline();
// pipeline.pipelineId, pipeline.project, pipeline.enrichCharacter, etc.
```

Use the individual hooks (`usePipelineIdentity`, `useProjectData`, `useAIOperations`) for better performance — they only re-render when their specific slice of state changes.

### Creating a vanilla view

For simpler views that don't need React:

```javascript
// views/my-view/view.js
(function() {
  'use strict';

  window.registerPipelineView({
    name: 'my-view',
    label: 'My View',
    icon: '📊',
    detect: function() { return true; },  // Return false to hide this view
    stitch: function(state) { return state; },  // Transform state before render
    render: function(data, appState) {
      return '<div class="my-view"><h2>My View</h2><p>Content here</p></div>';
    },
    wireEvents: function(scope, appState) {
      // scope is the DOM container. Attach event handlers here.
      scope.querySelector('.my-button')?.addEventListener('click', function() {
        console.log('clicked');
      });
    },
  });
})();
```

---

## 7. The Route System

Pipeline-specific server endpoints live in the pipeline's `routes/` directory. They're loaded dynamically when a request matches `/api/app/:id/*` and no core endpoint handles it.

### How route loading works

```
1. Request arrives: POST /api/app/my-pipeline/generate-previs
2. Core pipeline-app.ts checks all built-in endpoints
3. None match → falls through to dynamic route loading:
   a. discoverCompositions() → find entry for "my-pipeline"
   b. Resolve baseDir (pipelineDir for v2, dirname(path) for v1)
   c. loadPipelineRoutes(pipelineId, baseDir, ctx):
      - Check cache (Map<pipelineDir, handler>)
      - If not cached: look for routes/index.js
      - Dynamic import: import('file:///path/to/routes/index.js')
      - Call setup function: handler = setup(sdk)
      - Cache the handler
   d. Call handler(req, res, '/generate-previs')
   e. Handler returns true (handled) or false (pass)
```

### Creating pipeline routes

#### Step 1: Write the route handler (`routes/index.ts`)

```typescript
// Define SDK type inline (no dependency on Woodbury core)
interface PipelineRouteSdk {
  pipelineId: string;
  pipelineDir: string | null;
  sendJson: (res: any, status: number, data: any) => void;
  readBody: (req: any) => Promise<any>;
  getProject: () => any | null;
  ensureProject: () => Promise<any | null>;
  updateProject: (partial: Record<string, any>) => void;
  markDirty: (slices: string[]) => void;
  flushProject: () => Promise<void>;
  getProjectFolder: () => Promise<string>;
  isProjectLoaded: () => boolean;
  loadActionConfig: (actionId: string) => Promise<Record<string, any>>;
  generateImage: (params: {
    prompt: string;
    model?: 'flash' | 'pro';
    aspectRatio?: string;
    outputPath: string;
    referenceImages?: string[];
  }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  callTool: (toolName: string, params: Record<string, any>, workDir?: string) => Promise<any | null>;
  getTools: () => Promise<Array<{ name: string; handler: Function }>>;
  loadBindings: () => Promise<any>;
  saveBindings: (doc: any) => Promise<void>;
  loadRules: () => Promise<any>;
  saveRules: (doc: any) => Promise<void>;
  autoRunRules: () => Promise<{ added: number; replaced: number; totalBindings: number }>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  fileExists: (path: string) => boolean;
  copyFile: (src: string, dest: string) => Promise<void>;
  stat: (path: string) => Promise<{ size: number; mtime: Date }>;
  exec: (command: string, options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  spawn: (command: string, args: string[], options?: any) => any;
  log: (level: 'info' | 'error' | 'warn', tag: string, message: string, meta?: any) => void;
  discoverCompositions: () => Promise<any[]>;
  join: (...segments: string[]) => string;
  basename: (path: string) => string;
  dirname: (path: string) => string;
}

// Default export: setup function called once when routes are first loaded
export default function setupRoutes(sdk: PipelineRouteSdk) {
  // This function runs once. Initialize any state here.
  const { pipelineId, sendJson, readBody, join } = sdk;

  // Return the route handler function
  return async (req: any, res: any, subPath: string): Promise<boolean> => {

    // POST /api/app/:id/my-action
    if (req.method === 'POST' && subPath === '/my-action') {
      const body = await readBody(req);
      const project = await sdk.ensureProject();
      if (!project) {
        sendJson(res, 404, { error: 'No project loaded' });
        return true;
      }

      // Do something with the project data...
      const result = processData(project, body);

      // Update project and flush to disk
      sdk.updateProject({ myField: result });
      sdk.markDirty(['myField']);
      await sdk.flushProject();

      sendJson(res, 200, { success: true, result });
      return true;
    }

    // GET /api/app/:id/my-data
    if (req.method === 'GET' && subPath === '/my-data') {
      const project = sdk.getProject();
      sendJson(res, 200, { data: project?.myField || null });
      return true;
    }

    return false;  // Not handled — pass to next handler
  };
}

function processData(project: any, params: any) {
  // Your domain logic here
  return { processed: true };
}
```

#### Step 2: Create the build script (`routes/build.mjs`)

```javascript
#!/usr/bin/env node
import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, 'index.ts')],
  bundle: true,
  outfile: join(__dirname, 'index.js'),
  format: 'esm',           // Must be ESM for dynamic import()
  platform: 'node',
  target: ['node18'],
  external: [],             // Add any runtime-only dependencies here
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  minify: false,
  sourcemap: 'inline',
  loader: { '.ts': 'ts' },
});

console.log('✓ Pipeline routes built → routes/index.js');
```

#### Step 3: Build

```bash
node my-pipeline/routes/build.mjs
```

### PipelineRouteSdk reference

The SDK is the pipeline's gateway to Woodbury platform capabilities:

#### Project data

| Method | Description |
|--------|-------------|
| `getProject()` | Get in-memory project data (null if not loaded). Fast, no I/O. |
| `ensureProject()` | Load project into memory if not already loaded. Returns project or null. |
| `updateProject(partial)` | Merge partial data into the project. Does not flush to disk. |
| `markDirty(slices)` | Mark domain slices as changed. Triggers debounced flush (500ms). |
| `flushProject()` | Immediately write all dirty slices to disk. |
| `getProjectFolder()` | Resolve the project's external folder path. Creates if needed. |
| `isProjectLoaded()` | Check if project is currently in memory. |

**Domain slices** for `markDirty()`: `'metadata'`, `'characters'`, `'locations'`, `'sections'`, `'elements'`, `'scenes'`, `'previsualizations'`, `'assets'`, `'dialogueAudio'`, `'fountain'`

#### Image generation

```typescript
const result = await sdk.generateImage({
  prompt: 'A wide shot of a city street at night',
  model: 'flash',        // 'flash' (fast) or 'pro' (high quality)
  aspectRatio: '16:9',   // '1:1', '4:3', '16:9', '9:16'
  outputPath: '/path/to/output.png',
  referenceImages: ['/path/to/ref1.png', '/path/to/ref2.png'],
});
// result: { success: boolean, filePath?: string, error?: string }
```

#### Extension tools

```typescript
// Call any registered extension tool by name
const result = await sdk.callTool('elevenlabs_tts', {
  text: 'Hello world',
  voice_id: 'abc123',
  output_path: '/path/to/output.mp3',
});

// List all available tools
const tools = await sdk.getTools();
// [{ name: 'elevenlabs_tts', handler: Function }, ...]
```

#### File system

```typescript
const content = await sdk.readFile('/path/to/file.txt');
await sdk.writeFile('/path/to/file.txt', 'content');
await sdk.mkdir('/path/to/directory');
const exists = sdk.fileExists('/path/to/file.txt');
await sdk.copyFile('/src/path', '/dest/path');
const stats = await sdk.stat('/path/to/file');
// stats: { size: number, mtime: Date }
```

#### Process execution

```typescript
// Synchronous execution (for quick commands like ffprobe)
const { stdout, stderr } = await sdk.exec('ffprobe -v quiet -print_format json -show_format file.mp4', {
  timeout: 10000,
  cwd: '/working/dir',
});

// Long-running process (for ffmpeg renders, etc.)
const child = sdk.spawn('ffmpeg', ['-i', 'input.mp4', 'output.mp4'], {
  cwd: '/working/dir',
});
child.on('exit', (code) => console.log('Done:', code));
```

---

## 8. State Management

### ProjectStateManager

The `ProjectStateManager` (`src/dashboard/project-state.ts`) is the single source of truth for all project data. It maintains an in-memory cache with domain-sliced disk persistence.

#### In-memory → Disk mapping

```
ProjectData (in memory)          Files on disk
───────────────────────          ──────────────────────────────
metadata                    →    project.json
characters                  →    characters/_index.json
locations                   →    locations/_index.json
sections                    →    structure/sections.json
elements                    →    structure/elements.json
scenes                      →    scenes/_index.json
previsualizations           →    previs/_index.json
assets                      →    assets/_index.json
dialogueAudio               →    audio/_index.json
_fountainSource             →    screenplay.fountain
```

#### Update flow

```
View calls: PATCH /api/project/:id { characters: [...] }
  → ProjectStateManager.update(id, { characters: [...] })
  → In-memory data merged
  → markDirty(['characters'])
  → 500ms debounce timer starts
  → Timer fires → flush('characters')
  → Writes characters/_index.json atomically
```

#### Project data shape

```typescript
interface ProjectData {
  version: string;          // "1.0"
  pipelineId: string;
  createdAt?: string;
  updatedAt?: string;

  metadata: {
    title: string;
    author?: string;
    genre?: string;
    mood?: string;
    visualStyle?: string;
    length?: string;
    targetAudience?: string;
    projectType?: string;
    storyIdea?: string;
    seriesName?: string;
    seasonNumber?: string;
    episodeNumber?: string;
  };

  characters: Array<{
    id: string;
    name: string;
    description?: string;
    traits?: string[];
    backstory?: string;
    imagePath?: string;
    voiceId?: string;
  }>;

  locations: Array<{
    id: string;
    name: string;
    description?: string;
    imagePath?: string;
  }>;

  sections: Array<{
    type: string;
    title: string;
    elementStart: number;
    elementCount: number;
  }>;

  elements: Array<{
    id: string;
    type: string;        // 'scene_heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'shot'
    text: string;
    characterId?: string;
    duration?: number;
    audioPath?: string;
  }>;

  scenes?: Array<{
    id: string;
    title: string;
    location: string;
    locationId?: string;
    timeOfDay?: string;
    characterIds: string[];
    dialogue: Array<{ elementId: string; characterId: string; characterName: string; lines: string[] }>;
    actions: string[];
    shots: Array<{
      id: string;
      shotType: string;
      description: string;
      characterIds: string[];
      previsPath?: string;
      generatedAt?: string;
    }>;
    elementRange: [number, number];
  }>;

  previsualizations?: {
    shots: Array<{
      elementId: string;
      description: string;
      characterIds?: string[];
      generations?: Array<{
        id: string;
        prompt: string;
        imagePath: string;
        selected: boolean;
        generatedAt: string;
      }>;
    }>;
  };

  assets?: Array<{
    id: string;
    type: string;
    name: string;
    description?: string;
    imagePath?: string;
  }>;

  dialogueAudio?: {
    [elementId: string]: {
      path: string;
      duration: number;
      voiceId?: string;
      generatedAt: string;
    };
  };

  _fountainSource?: string;  // Raw .fountain screenplay text
}
```

### React state architecture

PipelineProvider uses three separate React contexts for fine-grained re-rendering:

```
┌─────────────────────────────────────────────┐
│ PipelineProvider                            │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ IdentityContext (rarely changes)    │    │
│  │ pipelineId, pipelineName, loading,  │    │
│  │ saving, dirty, projectFolder        │    │
│  │ Methods: reload, save, clear        │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ ProjectContext (changes on edits)   │    │
│  │ project: ProjectData | null         │    │
│  │ Methods: updateProject,             │    │
│  │   updateCharacter, updateLocation   │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ AIOperationsContext (stable refs)   │    │
│  │ Methods: enrichCharacter,           │    │
│  │   generateCharacterImages, etc.     │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Children (views, sidebar, etc.)            │
└─────────────────────────────────────────────┘
```

**Why three contexts?** A view that only shows the pipeline name (`usePipelineIdentity`) won't re-render when project data changes. A view that displays characters (`useProjectData`) won't re-render when saving state changes.

---

## 9. Bindings & Rules

The bindings system connects entities across domains (e.g., linking a character to a voice, or a location to a reference image).

### Bindings document

```json
{
  "version": "1.0",
  "pipelineId": "my-pipeline",
  "bindings": [
    {
      "source": { "entityType": "character", "entityId": "char-001" },
      "target": { "entityType": "voice", "entityId": "voice-abc" },
      "type": "voice",
      "origin": "manual"
    },
    {
      "source": { "entityType": "character", "entityId": "char-001" },
      "target": { "entityType": "asset", "entityId": "asset-xyz" },
      "type": "depicts",
      "origin": "auto:text-match"
    }
  ]
}
```

### Rules document

Rules automatically create bindings when entities match:

```json
{
  "version": "1.0",
  "pipelineId": "my-pipeline",
  "rules": [
    {
      "source": { "entityType": "character" },
      "target": { "entityType": "asset" },
      "type": "depicts",
      "matchField": "name",
      "matchMode": "text-contains"
    }
  ]
}
```

### API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/app/:id/bindings` | Get bindings document |
| `PUT` | `/api/app/:id/bindings` | Save bindings document |
| `GET` | `/api/app/:id/rules` | Get rules document |
| `PUT` | `/api/app/:id/rules` | Save rules document |
| `POST` | `/api/app/:id/rules/run` | Execute rules against current project data |

### Using bindings in route handlers

```typescript
// In your route handler:
const bindings = await sdk.loadBindings();

// Find all voice bindings for a character
const voiceBinding = bindings.bindings.find(
  b => b.type === 'voice' && b.source.entityId === characterId
);

// Auto-generate bindings from rules
const result = await sdk.autoRunRules();
// result: { added: 5, replaced: 2, totalBindings: 12 }
```

---

## 10. Core API Endpoints Reference

All endpoints are prefixed with the pipeline ID: `/api/app/{pipelineId}/...`

### Schema & State

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `GET` | `/schema` | — | `AppSchema` (sections, edges, executionOrder) |
| `GET` | `/state` | — | `{ pipelineId, nodeData, staleNodes }` |
| `PUT` | `/state/:nodeId` | `{ outputs: {...} }` | `{ ok: true }` — saves node data, marks downstream stale |
| `DELETE` | `/state` | — | `{ ok: true }` — clears all project data |
| `PUT` | `/project` | Full project data | `{ ok: true }` |

### Saves

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `GET` | `/saves` | — | `{ saves: [{ id, name, createdAt, size }] }` |
| `POST` | `/saves` | `{ name: "v1" }` | `{ ok: true, save: {...} }` |
| `POST` | `/saves/:saveId` | — | `{ ok: true }` — loads save into project |
| `DELETE` | `/saves/:saveId` | — | `{ ok: true }` |
| `POST` | `/saves/load-from-path` | `{ path: "..." }` | `{ ok: true }` |

### Views

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/views` | `{ views: [{ name, label, icon, type, order, hasCSS, bundle }] }` |
| `GET` | `/view-file/:viewName/:fileName` | Raw `.js` or `.css` file content |

### Project Data (unified)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `GET` | `/api/project/:id` | — | Full `ProjectData` |
| `PATCH` | `/api/project/:id` | Partial `ProjectData` | `{ ok: true }` |
| `DELETE` | `/api/project/:id` | — | `{ ok: true }` |
| `POST` | `/api/project/:id/reload` | — | `{ ok: true }` |
| `POST` | `/api/project/:id/flush` | — | `{ ok: true }` |

### Node Operations

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST` | `/invoke/:nodeId` | — | `{ ok: true }` — re-execute a single node |
| `POST` | `/refresh-stale` | — | Re-run only stale downstream nodes |
| `POST` | `/refresh-from-run` | — | Reload project after pipeline run |
| `GET` | `/node/:nodeId` | — | `{ outputs: {...} }` |

### Utility

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST` | `/open-path` | `{ path: "..." }` | Opens in system file manager |

---

## 11. Creating a New Pipeline from Scratch

### Minimal example: Data Dashboard pipeline

This example creates a pipeline that accepts a CSV URL, fetches and analyzes data, and displays it in a custom view.

#### 1. Create the directory

```bash
mkdir -p ~/.woodbury/extensions/data-dashboard
```

#### 2. Write the composition

```bash
cat > ~/.woodbury/extensions/data-dashboard/data-dashboard.composition.json << 'EOF'
{
  "version": "1.0",
  "id": "data-dashboard-pipeline",
  "name": "Data Dashboard",
  "description": "Fetch and visualize CSV data",
  "metadata": {
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "nodes": [
    {
      "id": "var-url",
      "workflowId": "__variable__",
      "label": "CSV URL",
      "position": { "x": 100, "y": 100 },
      "variableNode": {
        "inputName": "csvUrl",
        "type": "string",
        "description": "URL to a CSV file",
        "exposeAsInput": true,
        "required": true,
        "initialValue": ""
      }
    },
    {
      "id": "script-fetch",
      "workflowId": "__script__",
      "label": "Fetch & Analyze",
      "position": { "x": 400, "y": 100 },
      "script": {
        "code": "const res = await fetch(inputs.csvUrl); const text = await res.text(); const rows = text.split('\\n').map(r => r.split(',')); return { headers: rows[0], rowCount: rows.length - 1, data: rows };",
        "outputs": [
          { "name": "headers", "type": "array", "description": "Column headers" },
          { "name": "rowCount", "type": "number", "description": "Number of data rows" },
          { "name": "data", "type": "array", "description": "All rows" }
        ]
      }
    },
    {
      "id": "output",
      "workflowId": "__output__",
      "label": "Output",
      "position": { "x": 700, "y": 100 },
      "outputConfig": {
        "ports": [
          { "name": "analysis", "type": "object", "description": "Analysis results" }
        ]
      }
    }
  ],
  "edges": [
    { "sourceNodeId": "var-url", "sourcePort": "value", "targetNodeId": "script-fetch", "targetPort": "csvUrl" },
    { "sourceNodeId": "script-fetch", "sourcePort": "headers", "targetNodeId": "output", "targetPort": "analysis" }
  ]
}
EOF
```

#### 3. Create a view

```bash
mkdir -p ~/.woodbury/extensions/data-dashboard/views/dashboard
```

**Manifest:**
```bash
cat > ~/.woodbury/extensions/data-dashboard/views/dashboard/manifest.json << 'EOF'
{
  "name": "dashboard",
  "label": "Dashboard",
  "icon": "📊",
  "type": "react",
  "bundle": "view.bundle.js",
  "order": 10
}
EOF
```

**SDK shim:**
```bash
cat > ~/.woodbury/extensions/data-dashboard/views/dashboard/sdk.ts << 'EOF'
const SDK = (window as any).__WoodburyViewSDK as any;
export const usePipeline = SDK.usePipeline;
export const usePipelineIdentity = SDK.usePipelineIdentity;
export const useProjectData = SDK.useProjectData;
export const registerReactView = SDK.registerReactView;
EOF
```

**View component:**
```bash
cat > ~/.woodbury/extensions/data-dashboard/views/dashboard/DashboardView.tsx << 'EOF'
import React from 'react';
import { usePipelineIdentity } from './sdk';

export function DashboardView() {
  const { pipelineId, loading } = usePipelineIdentity();

  if (loading) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading...</div>;

  return (
    <div style={{ padding: 20, color: '#e2e8f0' }}>
      <h2>Data Dashboard</h2>
      <p>Pipeline: {pipelineId}</p>
      <p>Run the pipeline with a CSV URL to see data here.</p>
    </div>
  );
}
EOF
```

**Entry point:**
```bash
cat > ~/.woodbury/extensions/data-dashboard/views/dashboard/entry.tsx << 'EOF'
import { DashboardView } from './DashboardView';
const sdk = (window as any).__WoodburyViewSDK;
sdk.registerReactView({ name: 'dashboard', component: DashboardView });
EOF
```

**Build script:**
```bash
cat > ~/.woodbury/extensions/data-dashboard/views/build.mjs << 'BUILDEOF'
#!/usr/bin/env node
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const woodburyExternalsPlugin = {
  name: 'woodbury-externals',
  setup(build) {
    build.onResolve(
      { filter: /^react$|^react-dom$|^react\/jsx-runtime$|^react-dom\/client$/ },
      (args) => ({ path: args.path, namespace: 'woodbury-sdk' })
    );
    build.onLoad({ filter: /.*/, namespace: 'woodbury-sdk' }, (args) => {
      const mapping = {
        'react': 'window.__WoodburyViewSDK.React',
        'react-dom': 'window.__WoodburyViewSDK.ReactDOM',
        'react-dom/client': 'window.__WoodburyViewSDK.ReactDOM',
        'react/jsx-runtime': 'window.__WoodburyViewSDK.jsxRuntime',
      };
      return { contents: `module.exports = ${mapping[args.path] || 'window.__WoodburyViewSDK.React'};`, loader: 'js' };
    });
  },
};

const dirs = readdirSync(__dirname, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(__dirname, d.name, 'entry.tsx')));

for (const dir of dirs) {
  await build({
    entryPoints: [join(__dirname, dir.name, 'entry.tsx')],
    bundle: true,
    outfile: join(__dirname, dir.name, 'view.bundle.js'),
    format: 'iife', platform: 'browser', target: ['es2020'],
    jsx: 'automatic', jsxImportSource: 'react',
    plugins: [woodburyExternalsPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });
  console.log(`✓ ${dir.name}/view.bundle.js`);
}
BUILDEOF
```

#### 4. Build the views

```bash
node ~/.woodbury/extensions/data-dashboard/views/build.mjs
```

#### 5. Add to Woodbury's build (if bundled)

If the pipeline is in `extensions/` (bundled with Woodbury), add build steps to `package.json`:

```json
{
  "scripts": {
    "build:views": "node extensions/script-generator/views/build.mjs && node extensions/data-dashboard/views/build.mjs",
    "build:routes": "node extensions/script-generator/routes/build.mjs"
  }
}
```

#### 6. Use it

1. Restart Woodbury
2. Find "Data Dashboard" in the pipeline list
3. Click it → switch to App mode
4. The sidebar shows 📊 Dashboard + ⚙️ Settings
5. Fill in the CSV URL in Settings
6. Click Run Pipeline

---

## 12. Reference: Script Generator Pipeline

The `script-generator` pipeline is the most complete example. It demonstrates all extension capabilities.

### Composition

**File**: `extensions/script-generator/script-generator.composition.json`
**ID**: `script-generator-pipeline`

**Variable nodes** (9 settings):
- `projectType`, `storyIdea`, `title`, `genre`, `mood`, `targetAudience`, `visualStyle`, `length`, `authorName`, `seriesName`, `seasonNumber`, `episodeNumber`

**Processing nodes** (7 scripts):
- Generate screenplay metadata, characters, locations, scene structure, elements, assets, previsualizations

### Views (5)

| View | Order | Type | Description |
|------|-------|------|-------------|
| Overview (📋) | 10 | React | Project summary with metadata and stats |
| Data (📊) | 20 | React | Character and location cards with AI enrichment |
| Screenplay (📜) | 30 | React | Full screenplay display with previs integration |
| Editor (🎬) | 40 | React | Nonlinear timeline editor (StoryCut) with audio/video |
| Voices (🎙) | 60 | React | ElevenLabs voice assignment per character |

### Custom routes (13 endpoints)

| Endpoint | Description |
|----------|-------------|
| `POST /generate-previs` | Generate shot previs image with character/location references |
| `POST /select-previs-generation` | Select active previs for a shot |
| `POST /backfill-audio-durations` | Detect audio file durations via ffprobe |
| `POST /render-dialogue` | Batch TTS render for all unrendered dialogue |
| `POST /generate-dialogue-audio` | Single element TTS generation |
| `POST /import-audio` | Import external audio file for an element |
| `POST /render-video` | Compose timeline to video via ffmpeg |
| `POST /render-cancel` | Cancel active video render |
| `POST /generate-logo` | Generate 1:1 project logo image |
| `PUT /element/:elementId` | Update a screenplay element field |
| `POST /extract-pdf-text` | Extract screenplay text from PDF |
| `POST /generate-assets` | Batch generate/update character and location images |

### Repository

The script-generator pipeline lives in its own git repo at `~/.woodbury/workflows/comp-screenplay-generator/`. Views, routes, and source code are all self-contained — nothing lives in the Woodbury core repo.

### Build commands

```bash
cd ~/.woodbury/workflows/comp-screenplay-generator

# Build everything (views + routes)
npm run build

# Build only views
npm run build:views

# Build only routes
npm run build:routes
```

Views and routes are discovered at runtime from the pipeline's own directory — Woodbury core does not need to be rebuilt when pipeline UI or API changes.

---

## Appendix: Troubleshooting

### View shows blank / "failed to render"

1. Check browser console for errors
2. Verify `view.bundle.js` exists in the view directory
3. Verify `manifest.json` has `"type": "react"` and `"bundle": "view.bundle.js"`
4. Check that `entry.tsx` calls `registerReactView()` with the correct name
5. If the view loads CSS, verify the `view.css` file exists

### Custom API endpoint returns 404

1. Verify `routes/index.js` exists in the pipeline directory
2. Check that the file exports a default function (or `setupRoutes`)
3. Verify the sub-path matches (it starts with `/`, e.g., `/my-endpoint`)
4. Check Woodbury logs for route loading errors: `~/.woodbury/logs/`
5. Clear the route cache by restarting Woodbury

### Pipeline not appearing in the list

1. Check composition JSON is valid: `node -e "JSON.parse(require('fs').readFileSync('my.composition.json','utf-8'))"`
2. Verify required fields: `version`, `id`, `name`, `nodes`, `edges`
3. Check the pipeline is in a scanned directory (see [Pipeline Discovery](#3-pipeline-discovery))
4. Check for ID conflicts with existing pipelines (first discovered wins)

### SVG icons in sidebar

Icons can be emoji strings (`"📊"`) or SVG strings (`"<svg viewBox=...>...</svg>"`). Both are supported. SVG icons are rendered via `dangerouslySetInnerHTML` and constrained to 16×16px by CSS.

### View SDK not available

If `window.__WoodburyViewSDK` is undefined, the React app hasn't loaded yet. Make sure your view's `type` is `"react"` in the manifest and the bundle is loaded after the main React app.
