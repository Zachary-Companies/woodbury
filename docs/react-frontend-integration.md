# React Frontend Integration

The Woodbury React frontend does not read pipeline `nodeData` directly. Instead, the platform converts node outputs into domain-specific JSON files that the frontend loads at runtime. Understanding this mapping is essential when modifying pipeline nodes.

## Project Data Flow

Pipeline execution produces `nodeData[nodeId].outputs` for each node. The platform then splits this into domain files stored in the project folder:

| Domain file | Contents |
|-------------|----------|
| `project.json` | Metadata only (title, logline, genre, etc.) |
| `characters/_index.json` | Character array |
| `locations/_index.json` | Location array |
| `structure/elements.json` | Flat elements array (shots, dialogue, action lines) |
| `structure/sections.json` | Sections hierarchy (acts and scenes) |
| `scenes/_index.json` | Scenes with `elementRange` |
| `previs/_index.json` | Previsualization shots |
| `assets/_index.json` | Asset collection |
| `audio/_index.json` | Dialogue audio assets |

The React frontend loads from these domain files. When debugging display issues, check the domain file contents first — the problem may be in the platform conversion layer, not in the pipeline node itself.

## Critical Fields for the Frontend

### Scene element ranges — `scenes[].elementRange: [start, end]`

Every scene must declare a non-overlapping `elementRange` that maps into the flat `elements[]` array. Ranges must cover all elements with no gaps or overlaps. If element ranges are missing or overlap, the Editor view will crash by creating duplicate clips (one per scene × all elements).

**Example — correct:**
```json
[
  { "id": "scene-0", "elementRange": [0, 48] },
  { "id": "scene-1", "elementRange": [48, 96] },
  { "id": "scene-2", "elementRange": [96, 144] }
]
```

**Example — WRONG (causes crash):**
```json
[
  { "id": "scene-0", "elementRange": [0, 902] },
  { "id": "scene-1", "elementRange": [0, 902] }
]
```

### Character and location images — `imagePath`

```
characters[].imagePath  → headshot image path
locations[].imagePath   → landscape image path
```

The frontend displays these via `/api/file?path=<encodedPath>`. If missing, the UI shows a placeholder icon. The `final-assembly` node links asset file paths to character/location objects.

### Asset collection shape

`project.assets` can be either an `AssetCollection` object or a plain array. **Always normalize before iterating:**

```javascript
const list = Array.isArray(assets) ? assets : assets?.assets || [];
```

The `AssetCollection` object shape:
```json
{
  "id": "collection-1",
  "name": "My Assets",
  "slug": "my-assets",
  "savedAssetIds": ["id1", "id2"],
  "assets": [
    { "id": "id1", "type": "character-headshot", "filePath": "/path/to/file.png", "metadata": {} }
  ]
}
```

### Dialogue identifiers — `id` vs `elementId`

Audio linking matches dialogue elements to their audio files via `metadata.dialogueElementId`. Pipeline nodes output elements with `id` (e.g., `"element_5"`), but some code paths expect `elementId`. Always check both:

```javascript
const elemId = d.elementId || d.id;
```

### Voice assignments — `characters[].voiceId`

Persisted voice assignments are stored directly on the character object:

```json
{
  "id": "david-chen",
  "name": "David Chen",
  "voiceId": "CwhRBWXzGAHq8TQ4Fs17",
  "voiceName": "Roger - Laid-Back, Casual"
}
```

Voice bindings (the relationship between character and voice) are also stored in `metadata.voiceBindings`:

```json
{
  "type": "voice",
  "source": { "entityType": "character", "entityId": "david-chen" },
  "target": { "entityType": "voice", "entityId": "CwhRBWXzGAHq8TQ4Fs17" },
  "metadata": { "voiceName": "Roger" }
}
```

The render-dialogue route checks character `voiceId` first, then falls back to `metadata.voiceBindings`, then to pipeline-level bindings.

## Common Pitfalls

### 1. `project.assets` is NOT an array

It is an `AssetCollection` object with an `assets` property. Code that does `for (const a of project.assets)` will throw `TypeError: not iterable`. Always unwrap first.

### 2. Every scene must have a unique `elementRange`

Do not set all scenes to `[0, totalElements]`. Each scene must cover its own slice of the elements array. The `final-assembly` node's `buildScenesWithElementRange()` function computes correct ranges based on beat-proportional distribution.

### 3. Dialogue audio lives in `audio/_index.json`

Not in `project.json`. If audio files are missing from the Editor, check this domain file. The render-dialogue route also scans the `audio/` directory on disk as a fallback.

### 4. Voice bindings are in `metadata.voiceBindings`

Not a separate file. They are persisted to `project.json` via the metadata field and also available through the `/voice-bindings` API endpoint.

### 5. Route handlers are cached in memory

If you modify server-side route logic (`routes/index.ts`), rebuild with `node routes/build.mjs` and then restart the app. The Node.js import cache prevents hot-reloading of ESM routes.

### 6. Domain file fallback behavior

The platform loads project data from domain files first (`characters/_index.json`, `scenes/_index.json`, etc.), then falls back to `project.json` for any missing fields. This means stale data in domain files can shadow updated data in `project.json`.

## Pipeline Output → Frontend Mapping

Each pipeline node feeds specific views in the React frontend:

| Pipeline node | Domain file(s) written | Frontend view(s) |
|---------------|----------------------|-------------------|
| `metadata-generation` | `project.json` | Overview panel, Screenplay header |
| `character-generation` | `characters/_index.json` | Data > Characters, Voices panel |
| `location-generation` | `locations/_index.json` | Data > Locations |
| `section-structure` | `structure/sections.json` | Data > Sections |
| `element-generation` | `structure/elements.json` | Screenplay (dialogue, shots, action lines) |
| `final-assembly` | `scenes/_index.json` | Editor timeline, scene navigation |
| `asset-collection` | `assets/_index.json` | Character/location images throughout UI |
| `previs-generation` | `previs/_index.json` | Shot descriptions (image gen is via actions) |
| `voice-assignment` | `characters/_index.json` | Voices panel, dialogue rendering |
| `dialogue-audio-generation` | `audio/_index.json` | Editor audio playback |

## Debugging Workflow

When a frontend view shows incorrect or missing data:

1. **Identify the view** — which tab/section is broken?
2. **Find the domain file** — use the table above to find which file feeds that view
3. **Inspect the file** — check the JSON content on disk in the project folder
4. **Trace to the node** — if the domain file is wrong, check the pipeline node's output
5. **Check the state API** — `curl http://127.0.0.1:9001/api/app/{pipelineId}/state` shows in-memory nodeData
6. **Compare** — the domain file and state API may differ if a flush didn't complete

## React State vs Window Globals

The frontend uses React state (`usePipeline().project`) as the primary data source. Avoid using `window.*` globals for data that should be in React state. Voice bindings, for example, should be read from `project.metadata.voiceBindings` rather than `window.appBindings`.

When adding new data to the pipeline:
1. Make the pipeline node output the data in its return value
2. Ensure `final-assembly` includes it in `scriptPackage`
3. The platform will persist it to the appropriate domain file
4. The React frontend reads it via `usePipeline().project`
