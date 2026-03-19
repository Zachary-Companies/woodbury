# Pipeline Views

How to create custom views for pipelines. Views live in the **pipeline's own directory** and are loaded dynamically.

## Overview

When a pipeline is opened in **App mode**, the sidebar shows toggle buttons for available views:

- **Data** — always available, generic table/card view of all node outputs
- **Screenplay** — built-in, auto-detected when node outputs contain screenplay data (sections, elements, previsualizations)
- **Custom views** — pipeline-local, loaded from `{pipelineDir}/views/{view-name}/`

Custom views are **pipeline-owned code**. They live in the pipeline's own repository, not in Woodbury's source code. This means:
- Different pipelines can have different views
- The chat agent can create/modify views by editing files in the pipeline directory
- Views are version-controlled alongside the pipeline

## File Structure

```
{pipelineDir}/
  views/
    my-view/
      manifest.json    ← metadata (label, icon, description)
      view.js          ← required: detection, stitching, rendering, events
      view.css         ← optional: custom styles
```

## Quick Start: Create a Custom View

### 1. Create the directory

```bash
mkdir -p views/my-view
```

### 2. Create `manifest.json`

```json
{
  "name": "my-view",
  "label": "My View",
  "icon": "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" width=\"14\" height=\"14\"><circle cx=\"8\" cy=\"8\" r=\"6\"/></svg>",
  "description": "A custom view for this pipeline"
}
```

### 3. Create `view.js`

```javascript
window.registerPipelineView({
  name: 'my-view',       // Must match directory name
  label: 'My View',      // Toggle button text
  icon: '<svg .../>',    // Optional SVG for toggle button

  // Called to determine if this view should appear
  detect: function(state) {
    if (!state || !state.nodeData) return false;
    // Return true if the pipeline data matches what this view can display
    for (var nodeId in state.nodeData) {
      var outputs = state.nodeData[nodeId].outputs;
      if (outputs && outputs.myDataField) return true;
    }
    return false;
  },

  // Walk all node outputs and assemble into one data structure
  stitch: function(state) {
    var items = [];
    for (var nodeId in state.nodeData) {
      var outputs = state.nodeData[nodeId].outputs;
      if (outputs && outputs.myDataField) {
        items = items.concat(outputs.myDataField);
      }
    }
    return { items: items };
  },

  // Return HTML string for the view content
  render: function(data, state) {
    var html = '<div class="my-view">';
    html += '<h2>My Custom View (' + data.items.length + ' items)</h2>';
    for (var i = 0; i < data.items.length; i++) {
      html += '<div class="my-view-item">' + data.items[i].name + '</div>';
    }
    html += '</div>';
    return html;
  },

  // Attach event listeners after the HTML is injected into the DOM
  wireEvents: function(root, state) {
    root.querySelectorAll('.my-view-item').forEach(function(el) {
      el.addEventListener('click', function() {
        console.log('Clicked:', el.textContent);
      });
    });
  },
});
```

### 4. Optional: Create `view.css`

```css
.my-view { padding: 24px; }
.my-view h2 { color: #f1f5f9; margin-bottom: 16px; }
.my-view-item {
  padding: 8px 12px;
  background: rgba(255,255,255,0.04);
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
}
.my-view-item:hover { background: rgba(99,102,241,0.12); }
```

That's it. The view toggle will appear automatically in the sidebar when the `detect()` function returns `true` for the pipeline's data.

## How It Works

### Loading Sequence

```
renderCompositionAppPage()
  │
  ├─ fetch /api/app/{id}/schema        pipeline structure
  ├─ fetch /api/app/{id}/state          all node outputs
  ├─ fetch /api/app/{id}/bindings       entity relationships
  │
  ├─ fetch /api/app/{id}/views          discover pipeline-local views
  │   └─ scans {pipelineDir}/views/*/
  │       returns [{ name, label, icon, hasCSS }]
  │
  ├─ For each discovered view:
  │   ├─ inject <link> for view.css (if hasCSS)
  │   └─ inject <script> for view.js
  │       └─ view.js calls window.registerPipelineView({...})
  │           └─ fills in detect, stitch, render, wireEvents
  │
  ├─ For each registered view: call detect(state)
  │   └─ if true → show toggle button in sidebar
  │
  ▼
  User clicks a custom view toggle
  │
  ├─ appViewMode = 'custom:{view-name}'
  ├─ call view.stitch(state) → get stitched data
  ├─ call view.render(data, state) → get HTML string
  ├─ inject HTML into DOM
  └─ call view.wireEvents(root, state) → attach listeners
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/app/{id}/views` | List available custom views from `{pipelineDir}/views/` |
| GET | `/api/app/{id}/view-file/{viewName}/{fileName}` | Serve `view.js` or `view.css` from a view directory |

### Registration API

```javascript
window.registerPipelineView({
  name: string,                              // Must match directory name
  label: string,                             // Display name for toggle button
  icon?: string,                             // SVG HTML for toggle button icon
  detect: function(state) → boolean,         // Should this view appear?
  stitch: function(state) → any,             // Transform raw data into view data
  render: function(data, state) → string,    // Return HTML
  wireEvents?: function(root, state) → void, // Attach event listeners
});
```

### The `state` Object

Every function receives the app state, which contains all node outputs:

```javascript
{
  pipelineId: "comp-my-pipeline",
  pipelineName: "My Pipeline",
  sourceRunId: "run-abc123",
  nodeData: {
    "node-1": {
      outputs: { ... },        // This node's output data
      stale: false,
    },
    "node-2": {
      outputs: {
        characters: [...],
        elements: [...],
        // Whatever the node produces
      },
    },
  },
  staleNodes: [],
  lastRunAt: "2026-03-18T...",
}
```

### Available Utilities

Custom views run in the same page context as the app, so these global functions are available:

| Function | Description |
|----------|-------------|
| `compEscHtml(str)` | HTML-escape a string |
| `compEscAttr(str)` | Attribute-escape a string |
| `toast(message, type)` | Show a toast notification (`'success'`, `'error'`, `'info'`) |
| `compData` | Current pipeline metadata (`{ id, name, description, ... }`) |
| `appState` | Current app state (same as what's passed to your functions) |
| `appBindings` | Current bindings document |
| `renderCompositionAppPage()` | Re-render the entire app page (call after data changes) |

### Making API Calls

Views can call any dashboard API endpoint using `fetch()`:

```javascript
// Fetch data
var res = await fetch('/api/app/' + compData.id + '/state');
var state = await res.json();

// Serve files from the pipeline directory
var imgUrl = '/api/file?path=' + encodeURIComponent(absoluteFilePath);

// Custom pipeline endpoints (if you add them via pipeline scripts)
var res = await fetch('/api/app/' + compData.id + '/my-custom-endpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ... }),
});
```

## Examples

### Storyboard View

A visual grid of all generated images with captions:

```javascript
window.registerPipelineView({
  name: 'storyboard',
  label: 'Storyboard',
  icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',

  detect: function(state) {
    // Show if we have previsualizations
    for (var nodeId in state.nodeData) {
      var o = state.nodeData[nodeId].outputs;
      if (o && o.previsualizations && o.previsualizations.shots) return true;
    }
    return false;
  },

  stitch: function(state) {
    var shots = [];
    for (var nodeId in state.nodeData) {
      var o = state.nodeData[nodeId].outputs;
      if (o && o.previsualizations && o.previsualizations.shots) {
        shots = shots.concat(o.previsualizations.shots);
      }
    }
    return { shots: shots };
  },

  render: function(data) {
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;padding:24px;">';
    for (var i = 0; i < data.shots.length; i++) {
      var shot = data.shots[i];
      var imgSrc = shot.filePath ? '/api/file?path=' + encodeURIComponent(shot.filePath) : '';
      html += '<div style="background:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden;">';
      if (imgSrc) html += '<img src="' + imgSrc + '" style="width:100%;aspect-ratio:16/9;object-fit:cover;" />';
      html += '<div style="padding:8px;font-size:0.7rem;color:#94a3b8;">' + compEscHtml(shot.description || 'Shot ' + (i+1)) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  },
});
```

### Character Gallery View

Display all characters with their reference images:

```javascript
window.registerPipelineView({
  name: 'characters',
  label: 'Characters',

  detect: function(state) {
    for (var nodeId in state.nodeData) {
      var o = state.nodeData[nodeId].outputs;
      if (o && Array.isArray(o.characters) && o.characters.length > 0) return true;
    }
    return false;
  },

  stitch: function(state) {
    var characters = [], assets = {};
    for (var nodeId in state.nodeData) {
      var o = state.nodeData[nodeId].outputs;
      if (o && o.characters) characters = characters.concat(o.characters);
      if (o && o.assets) {
        o.assets.forEach(function(a) {
          if (a.metadata && a.metadata.characterId) assets[a.metadata.characterId] = a;
        });
      }
    }
    return { characters: characters, assets: assets };
  },

  render: function(data) {
    var html = '<div style="padding:24px;">';
    html += '<h2 style="color:#f1f5f9;margin-bottom:16px;">Characters (' + data.characters.length + ')</h2>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;">';
    for (var i = 0; i < data.characters.length; i++) {
      var c = data.characters[i];
      var asset = data.assets[c.id];
      html += '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:16px;text-align:center;">';
      if (asset && asset.filePath) {
        html += '<img src="/api/file?path=' + encodeURIComponent(asset.filePath) + '" style="width:120px;height:120px;border-radius:50%;object-fit:cover;margin-bottom:12px;" />';
      }
      html += '<div style="font-weight:600;color:#f1f5f9;">' + compEscHtml(c.displayName || c.name) + '</div>';
      if (c.description) html += '<div style="font-size:0.65rem;color:#64748b;margin-top:4px;">' + compEscHtml(c.description.slice(0, 100)) + '</div>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  },
});
```

## Key Principles

1. **Views live in the pipeline directory** — they are pipeline-owned code, not Woodbury source
2. **Detection is automatic** — views appear when their `detect()` returns true for the data
3. **Stitching is cross-node** — data comes from multiple pipeline nodes; walk all of `state.nodeData`
4. **DOM updates should be surgical** — for interactive views, update specific elements rather than re-rendering everything
5. **The chat agent can create views** — since views are just files in the pipeline directory, the in-app chat agent can create and modify them based on natural language requests
6. **CSS is scoped by convention** — use a unique prefix for your view's CSS classes (e.g., `my-view-*`)
