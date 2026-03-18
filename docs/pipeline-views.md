# Pipeline Views

How the App View system works and how to create custom views for pipelines.

## Overview

When a pipeline is opened in **App mode**, the sidebar shows toggle buttons for available views. Currently there are two built-in views:

- **Data** — generic table/card view of all node outputs
- **Screenplay** — a domain-specific NLE (non-linear editor) view for screenplay pipelines

Views are **auto-detected** from pipeline output data. If a pipeline's node outputs contain screenplay-shaped data (sections, elements, previsualizations), the Screenplay toggle appears. Otherwise only the Data view is shown.

This document explains the full architecture so you can create additional domain-specific views (e.g., a Music view, a Storyboard view, a Product Catalog view).

## Architecture

```
User opens pipeline in App mode
  │
  ▼
renderCompositionAppPage()                    [compositions-app.js]
  │
  ├─ fetch /api/app/{id}/schema               pipeline schema
  ├─ fetch /api/app/{id}/state                 all node outputs
  └─ fetch /api/app/{id}/bindings              entity relationships
  │
  ▼
For each registered view: call detect(state)
  │
  ├─ detectScreenplayData(state) → true?       show "Screenplay" toggle
  ├─ detectYourCustomView(state) → true?       show your toggle
  └─ ... more views
  │
  ▼
User clicks a view toggle
  │
  ▼
Call the selected view's render(state) function
  │
  ▼
HTML string returned → injected into DOM
  │
  ▼
wireAppActions(root) called → attaches event handlers
```

## The Three Things Every View Needs

### 1. A Detection Function

Determines whether this view is relevant for the current pipeline's data. Receives the full app state (all node outputs) and returns `true`/`false`.

```javascript
function detectMyView(state) {
  if (!state || !state.nodeData) return false;
  for (var nodeId in state.nodeData) {
    var outputs = state.nodeData[nodeId].outputs;
    if (!outputs) continue;
    // Check if the outputs contain data your view can display
    if (outputs.products && Array.isArray(outputs.products)) return true;
    if (outputs.tracks && Array.isArray(outputs.tracks)) return true;
  }
  return false;
}
```

**How it's called:** In `renderCompositionAppPage()`, after fetching state, each detector runs to determine which view toggles to show in the sidebar.

### 2. A Stitch/Transform Function

Walks all node outputs and assembles them into a single unified data structure your view can render. This is necessary because pipeline data is spread across multiple nodes.

```javascript
function stitchMyViewData(state) {
  var products = [], categories = [], assets = {};

  for (var nodeId in state.nodeData) {
    var outputs = state.nodeData[nodeId].outputs;
    if (!outputs) continue;
    if (outputs.products) products = products.concat(outputs.products);
    if (outputs.categories) categories = categories.concat(outputs.categories);
    // ... collect from all nodes
  }

  return {
    products: products,
    categories: categories,
    assets: assets,
  };
}
```

### 3. A Render Function

Takes the stitched data and returns an HTML string.

```javascript
function renderMyView(data, state) {
  var html = '<div class="my-view-container">';

  // Header
  html += '<h1>' + escapeHtml(data.title || 'Untitled') + '</h1>';

  // Content
  for (var i = 0; i < data.products.length; i++) {
    var p = data.products[i];
    html += '<div class="product-card">';
    html += '<h3>' + escapeHtml(p.name) + '</h3>';
    if (p.image) {
      html += '<img src="/api/app/' + compData.id + '/file?path=' + encodeURIComponent(p.image) + '" />';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}
```

## How the Screenplay View Works (Reference Implementation)

### File Layout

Everything lives in one file: `src/config-dashboard/compositions-app.js`

| Function | Lines | Purpose |
|----------|-------|---------|
| `detectScreenplayData(state)` | ~777 | Checks if node outputs contain `sections[]`, `elements[]`, `previsualizations` |
| `stitchScreenplayTimeline(state)` | ~824 | Walks all nodes, builds unified timeline with acts → scenes → beats |
| `renderAppScreenplayView(timeline, state)` | ~1053 | Returns full HTML: header, scene strip, timeline body |
| `renderNLEScene(scene, timeline)` | ~1123 | Renders one scene with its beats |
| `renderNLEBeat(beat, index, scene, timeline)` | ~1149 | Renders one beat: image + refs + text + buttons |
| `generatePrevisImage(elementId, overrides, btn, root)` | ~1534 | Handles Regen button: calls server API, updates DOM |
| `saveInlineEdit(el, root)` | ~1666 | Handles inline text editing of screenplay elements |

### Data Shape Expected

The detection function looks for these patterns in node outputs:

```javascript
// sections — the structural hierarchy (acts/scenes)
{
  sections: [
    {
      title: "ACT I - THE EDGE",
      type: "act",
      children: [
        { title: "Marcus's Breaking Point", type: "scene", elementRange: [0, 15] }
      ]
    }
  ]
}

// elements — the content (shots, dialogue, action lines)
{
  elements: [
    { id: "element_1", type: "shot", content: "WIDE SHOT - THE CITY BRIDGE" },
    { id: "element_2", type: "dialogue", character: "MARCUS", content: "I didn't expect company tonight." },
    { id: "element_3", type: "action", content: "The Ferryman steps closer." }
  ]
}

// previsualizations — generated images for shots
{
  previsualizations: {
    shots: [
      { shotElementId: "element_1", filePath: "/path/to/image.png", characterIds: ["marcus"], locationId: "bridge" }
    ]
  }
}

// characters, locations — entity data
{
  characters: [{ id: "marcus", name: "Marcus Chen", displayName: "MARCUS" }],
  locations: [{ id: "bridge", name: "City Bridge" }]
}
```

### The Stitching Process

`stitchScreenplayTimeline(state)` does:

1. **Collect** — walks all node outputs, extracts `sections`, `elements`, `previsualizations`, `characters`, `locations`, `assets`, `metadata`
2. **Index** — builds lookup maps: `charMap[id]`, `locMap[id]`, `charAssetMap[id]`, `locAssetMap[id]`, `previsMap[elementId]`
3. **Flatten** — converts the section hierarchy into a flat list of scenes, each with an element range
4. **Distribute** — assigns elements to scenes based on their index ranges
5. **Group into beats** — within each scene, groups elements into beats. A "beat" starts at each `shot` element and includes all following `dialogue`/`action` elements until the next shot
6. **Attach references** — for each beat, looks up the previs image, character assets, and location assets

Returns:
```javascript
{
  title: "The Last Jump",
  logline: "A desperate soul's leap...",
  metadata: { ... },
  characters: { marcus: { ... } },
  locations: { bridge: { ... } },
  characterAssets: { marcus: { filePath: "..." } },
  locationAssets: { bridge: { filePath: "..." } },
  bindings: { version: "1.0", bindings: [...] },
  acts: [
    {
      title: "ACT I - THE EDGE",
      scenes: [
        {
          title: "Marcus's Breaking Point",
          beats: [
            {
              elements: [ { type: "shot", ... }, { type: "dialogue", ... } ],
              previs: { filePath: "...", characterIds: [...] },
              asset: { filePath: "..." }
            }
          ]
        }
      ]
    }
  ]
}
```

### The Rendering Process

Each beat renders as a two-column layout:

```
┌──────────────────────┬─────────────────────────────────┐
│  [Generated Image]   │  SHOT  WIDE - CITY BRIDGE       │
│                      │                                  │
│  [Regen] [Prompt]    │  Marcus stands at the center...  │
│                      │                                  │
│  REFS (10)           │  MARCUS                          │
│  [img][img][img]     │  I didn't expect company tonight.│
│  MARCUS MARCUS ...   │                                  │
│                      │  THE FERRYMAN                    │
│                      │  Most don't. Yet here we both... │
└──────────────────────┴─────────────────────────────────┘
```

### Reference Resolution (REFS)

The REFS section shows which character/location images are used for generation. Resolution order:

1. **Bindings** (if pipeline has them) — looks for `depicts` bindings where `source = this shot`
2. **Previs metadata** (fallback) — uses `characterIds`/`locationId` from the previs data
3. **Asset lookup** — finds the actual image file for each character/location ID

### Action Buttons (Regen, Prompt)

Buttons trigger `generatePrevisImage()` which:

1. POSTs to `/api/app/{pipelineId}/generate-previs`
2. Server loads the pipeline's `actions/generate-image.json` config
3. Resolves references based on that config (bindings vs. fallback)
4. Builds a prompt from the shot description + config template
5. Calls nanobanana (Gemini image generation) with the reference images
6. Saves the result, returns the file path
7. Client updates the `<img>` src in-place (no full re-render)

The **behavior is pipeline-owned** — the `actions/generate-image.json` file in the pipeline's directory controls how references are resolved, what prompt structure is used, and what generation settings apply.

## Adding a New View: Step by Step

### Step 1: Define Your Data Shape

Decide what your pipeline's node outputs look like. For example, a **Music Production** view might expect:

```javascript
{
  tracks: [{ id: "track_1", title: "Intro", bpm: 120, key: "Am", duration: 180 }],
  stems: [{ trackId: "track_1", type: "drums", filePath: "..." }],
  mix: { masterVolume: 0.8, effects: [...] }
}
```

### Step 2: Write Detection

In `compositions-app.js`, add your detection function:

```javascript
function detectMusicData(state) {
  if (!state || !state.nodeData) return false;
  for (var nodeId in state.nodeData) {
    var outputs = state.nodeData[nodeId].outputs;
    if (!outputs) continue;
    if (Array.isArray(outputs.tracks) && outputs.tracks.length > 0) return true;
  }
  return false;
}
```

### Step 3: Register the View Toggle

In `renderCompositionAppPage()`, where the toggle buttons are built (~line 170), add your view:

```javascript
var hasScreenplayData = detectScreenplayData(state);
var hasMusicData = detectMusicData(state);  // ADD

if (hasScreenplayData || hasMusicData) {  // MODIFY condition
  html += '<div class="app-view-toggle">';
  html += '<button class="app-view-toggle-btn' + (appViewMode === 'data' ? ' active' : '') + '" data-app-view-mode="data">Data</button>';
  if (hasScreenplayData) {
    html += '<button class="app-view-toggle-btn' + (appViewMode === 'screenplay' ? ' active' : '') + '" data-app-view-mode="screenplay">Screenplay</button>';
  }
  if (hasMusicData) {
    html += '<button class="app-view-toggle-btn' + (appViewMode === 'music' ? ' active' : '') + '" data-app-view-mode="music">Music</button>';
  }
  html += '</div>';
}
```

### Step 4: Write Stitch + Render

```javascript
function stitchMusicData(state) {
  var tracks = [], stems = [], mix = null;
  for (var nodeId in state.nodeData) {
    var o = state.nodeData[nodeId].outputs;
    if (!o) continue;
    if (o.tracks) tracks = tracks.concat(o.tracks);
    if (o.stems) stems = stems.concat(o.stems);
    if (o.mix) mix = o.mix;
  }
  return { tracks, stems, mix };
}

function renderMusicView(data, state) {
  var html = '<div class="music-container">';
  // ... your HTML
  html += '</div>';
  return html;
}
```

### Step 5: Wire It Into the Render Switch

In `renderCompositionAppPage()`, where the view mode determines what to render:

```javascript
if (appViewMode === 'screenplay') {
  var timeline = stitchScreenplayTimeline(state);
  contentHtml = renderAppScreenplayView(timeline, state);
} else if (appViewMode === 'music') {             // ADD
  var musicData = stitchMusicData(state);          // ADD
  contentHtml = renderMusicView(musicData, state); // ADD
} else {
  contentHtml = renderDataView(state);
}
```

### Step 6: Wire Event Handlers

In `wireAppActions(root)` (~line 1721), add handlers for your view's interactive elements:

```javascript
// Music view: play button
root.querySelectorAll('.music-play-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var trackId = btn.getAttribute('data-track-id');
    playTrack(trackId);
  });
});
```

### Step 7: Add Server Endpoints (if needed)

If your view has interactive features (like Regen for Screenplay), add API endpoints in `src/dashboard/routes/pipeline-app.ts`:

```typescript
if (req.method === 'POST' && subPath === '/generate-stem') {
  // Your custom generation logic
  // Load pipeline's actions/generate-stem.json for behavior config
  // Call your generation service
  // Return result
}
```

### Step 8: Add Action Configs (if needed)

If your view's buttons have configurable behavior, create action config files in the pipeline's `actions/` directory:

```json
// actions/generate-stem.json
{
  "type": "generate-stem",
  "generation": {
    "model": "musicgen-large",
    "duration": 30,
    "sampleRate": 44100
  },
  "referenceResolution": {
    "instruments": {
      "strategy": "binding-match",
      "bindingType": "uses-instrument"
    }
  }
}
```

## Available Data Sources

Every view has access to:

| Source | API | Description |
|--------|-----|-------------|
| Schema | `GET /api/app/{id}/schema` | Pipeline's node types, field definitions |
| State | `GET /api/app/{id}/state` | All node outputs (the actual data) |
| Bindings | `GET /api/app/{id}/bindings` | Entity-to-entity relationships |
| Files | `GET /api/app/{id}/file?path=...` | Serve any file from the pipeline directory |
| Actions | loaded server-side | Pipeline's `actions/*.json` behavior configs |
| Rules | loaded server-side | Pipeline's `bindings/rules.json` auto-binding rules |

## CSS Conventions

Views use the `nle-` prefix for the Screenplay view. Use a unique prefix for your view:

```css
.music-container { ... }
.music-track-row { ... }
.music-waveform { ... }
```

Add styles to `src/config-dashboard/styles.css` under a clearly commented section:

```css
/* ── Music View ────────────────────────────────────────── */
.music-container { ... }
```

## Key Principles

1. **Detection is automatic** — views appear when the data supports them
2. **Stitching is cross-node** — data comes from multiple pipeline nodes; your stitch function must walk all of them
3. **Behavior is pipeline-owned** — action configs in the pipeline's `actions/` directory control what buttons do
4. **DOM updates are surgical** — after actions (like Regen), update the specific element rather than re-rendering the whole view
5. **Inline editing uses contenteditable** — click to edit, blur to save, Escape to cancel
6. **Bindings are the connection layer** — entity relationships (character ↔ shot, instrument ↔ track) are stored in `bindings/bindings.json` and drive reference resolution
