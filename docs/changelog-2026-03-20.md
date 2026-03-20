# Changelog — 2026-03-20

## Complete React Migration & Scene-Grouped Data Model

### Summary

Replaced the vanilla JS `compositions-app.js` (~6,200 lines) with a full React component tree (30 files, ~7,800 lines). Restructured the screenplay data from a flat `elements[]` + `sections[]` model to a **scene-grouped model** where each `SceneData` owns its dialogue, actions, camera shots, and character list — matching how real production breakdowns work.

---

### New Data Model

**Before:** Flat arrays required fragile index arithmetic to map elements to scenes. Shot descriptions were mixed with action text (distinguished only by regex). Previs shots were stored at the project level requiring elementId lookups. Non-standard scripts (scenes without INT/EXT prefixes) broke scene detection entirely.

**After:** Each scene is a self-contained object:

```
SceneData {
  id, title, location, locationId, timeOfDay, actTitle,
  characterIds[],     // all characters who speak or appear
  dialogue[],         // ordered SceneDialogue entries
  actions[],          // action/description text
  shots[],            // SceneShot objects with previs paths
  elementRange        // [start, end) into legacy elements[]
}
```

### New Types

- `SceneData` — scene-level container with all grouped data
- `SceneShot` — camera shot with `shotType`, `description`, `characterIds`, `previsPath`
- `SceneDialogue` — dialogue entry with `characterId`, `characterName`, `lines`, `modifiers`

### Files Changed

| File | Change |
|------|--------|
| `pipeline-store.ts` | Added `SceneData`, `SceneShot`, `SceneDialogue` types; `scenes?: SceneData[]` on `ProjectData` |
| `fountainParser.ts` | **New.** `buildScenes()` converts flat sections+elements → `SceneData[]`. Handles standard INT/EXT headings AND contextual detection for non-standard scripts (ALL-CAPS lines matching known locations) |
| `PipelineProvider.tsx` | Split into `IdentityContext`, `ProjectContext`, `AIOperationsContext` for render performance. Auto-computes `scenes[]` on load if missing (migration path) |
| `ScreenplayView.tsx` | Complete rewrite. Renders from `scene.shots/dialogue/actions` directly. Per-scene "Generate Shots" and "Render Previs" buttons with concurrent progress tracking via `Set<string>` |
| `pipeline-app.ts` (server) | Updated `generate-previs` to accept `sceneId`/`sceneLocationId`. Added "Strategy 0" character resolution from `shot.characterIds`. Updated `collectScreenplayData()` to include scenes. Writes `previsPath`/`generatedAt` back to scene shots |

### New React Components (16)

| Component | Purpose |
|-----------|---------|
| `Sidebar.tsx` | Navigation sidebar with view tabs and act/scene tree |
| `ImportScriptModal.tsx` | Fountain script import with drag-and-drop |
| `NewProjectDialog.tsx` | New project creation with folder picker |
| `CommandBar.tsx` | AI chat command bar |
| `ConnectionModal.tsx` | Pipeline connection editor |
| `FolderPicker.tsx` | Project folder browser/selector |
| `OverviewView.tsx` | Project overview dashboard |
| `SettingsView.tsx` | Project settings panel |
| `SaveLoadPanel.tsx` | Save/load project controls |
| `NodeSection.tsx` | Pipeline node display |
| `DialogueEditModal.tsx` | Inline dialogue editing |
| `GenerateLogoModal.tsx` | AI logo generation |
| `GitStatus.tsx` | Git status indicator |
| `ImageZoom.tsx` | Image preview with zoom |
| `RulesModal.tsx` | Pipeline rules editor |
| `appApi.ts` | Centralized API client |

### Deleted

- `compositions-app.js` — 6,224 lines of vanilla JS rendering code

### Migration Strategy

- `buildScenes()` runs on any project with `sections[]` + `elements[]` → produces `scenes[]`
- On load, if `project.scenes` is missing or empty, auto-computes from existing data
- Existing projects keep working — flat `elements[]` stays as canonical source
- `scenes[]` is a denormalized view, not a replacement

### Bug Fixes

- **Off-by-1 scene targeting**: Clicking "Generate Shots" on one scene generated shots for the wrong scene. Fixed by saving shots as `SceneShot` objects in `scene.shots[]` instead of inserting elements by index.
- **Previs 400 "No screenplay data found"**: `collectScreenplayData` didn't read from `project.json`. Added project.json fallback.
- **Screen flickering on button clicks**: `pipeline.reload()` replaced entire state causing full unmount/remount. Fixed with `REFRESH` dispatch + `React.memo` on `SceneCard`.
- **`saveAppNodeState is not defined`**: Reference to deleted vanilla JS function. Exposed as global.
- **Single-item generating state**: Changed from `string | null` to `Set<string>` for concurrent previs tracking.
- **3 sections instead of scenes**: Non-standard scripts with ALL-CAPS location headings (no INT/EXT) were not detected as scenes. Added contextual detection matching known locations and `LOCATION_WORDS` regex.

### Performance

- Split `PipelineProvider` into 3 contexts (`Identity`, `Project`, `AIOperations`) so UI updates from AI operations don't re-render the entire tree
- `React.memo` on `SceneCard` prevents unnecessary re-renders when sibling scenes update
- Progressive image loading during previs generation (images appear as they're created)
