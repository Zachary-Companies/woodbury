# React Migration Plan — Full Dashboard Conversion

## Status (as of 2026-03-19)

### Done
- React 19 + ReactDOM 19 bundled via esbuild
- PipelineProvider context with centralized state management
- Pre-built Tailwind CSS (no CDN dependency)
- 8 React components: PipelineApp, ScreenplayView, DataView, VoicesView, ImportModal, CharacterCard, LocationCard, CharacterEditor
- All components use usePipeline() from PipelineProvider
- esbuild IIFE bundle fixed (no globalName shadow)
- Electron cache clearing on startup

### Not Done — Full Conversion Needed
The vanilla `compositions-app.js` (6000+ lines) still renders the pipeline app shell. React components exist but the vanilla JS gets priority because `compositions-app.js` renders first and React mounts inside its output.

## Architecture Target

```
src/config-dashboard/react/
├── index.tsx                    ← entry point, mounts <App />
├── stores/
│   └── PipelineProvider.tsx     ← centralized state (DONE)
├── components/
│   ├── App.tsx                  ← NEW: full app shell (replaces compositions-app.js for pipelines)
│   ├── Sidebar.tsx              ← NEW: left sidebar with node list, view tabs, actions
│   ├── TopBar.tsx               ← NEW: title, project folder, save/load
│   ├── ScreenplayView.tsx       ← DONE (needs Provider integration verified)
│   ├── DataView.tsx             ← DONE
│   ├── VoicesView.tsx           ← DONE
│   ├── EditorView.tsx           ← NEW: React wrapper for vanilla NLE editor
│   ├── ScriptView.tsx           ← NEW: React wrapper for Monaco Fountain editor
│   ├── ImportModal.tsx          ← DONE
│   ├── SaveLoadPanel.tsx        ← NEW: save snapshots, load, save to folder
│   ├── GitStatus.tsx            ← NEW: git status, commit & push
│   ├── CharacterCard.tsx        ← DONE
│   ├── CharacterEditor.tsx      ← DONE
│   ├── LocationCard.tsx         ← DONE
│   ├── OverviewView.tsx         ← NEW: pipeline overview with stats
│   ├── SettingsView.tsx         ← NEW: pipeline settings
│   └── NodeSection.tsx          ← NEW: generic node data display
```

## Implementation Order

### Phase 1: App Shell (replaces renderCompositionAppPage)
1. `App.tsx` — the outer shell that replaces compositions-app.js for pipeline app mode
   - Sidebar with node tree, view tabs, action buttons
   - Content area that renders the active view
   - Top bar with title, project folder, save indicator
2. `Sidebar.tsx` — left sidebar
   - Pipeline logo + name
   - Overview link
   - NODE section with expandable node list
   - View tabs (Data, Screenplay, Editor, Script, Voices)
   - Connections link
   - Action buttons (New Project, Import Script, Refresh, Run Pipeline, Open Editor, Open Form)
   - Save/Load section
   - Git status
3. Update `compositions-app.js` to fully delegate to React when WoodburyReact is available
   - Instead of building HTML and mounting React inside, render ONLY the React mount point
   - Pass pipelineId to React and let it handle everything

### Phase 2: Remaining Views
4. `OverviewView.tsx` — shows pipeline overview stats (acts, scenes, elements, previs shots)
5. `NodeSection.tsx` — generic view for any pipeline node's data
   - Renders key-value pairs, arrays as card grids, nested objects
   - Edit/Copy buttons
6. `SettingsView.tsx` — pipeline input variables editor

### Phase 3: Save/Load & Git
7. `SaveLoadPanel.tsx` — save snapshots, load previous saves, save to folder
8. `GitStatus.tsx` — shows uncommitted changes, commit & push button, open in GitHub Desktop

### Phase 4: Clean Up
9. Remove vanilla JS pipeline app rendering from `compositions-app.js`
10. Keep vanilla JS for non-pipeline pages (home, settings, training, etc.)
11. Remove debug console.log statements

## Key Principle
Each pipeline is independent. The Provider loads data for ONE pipeline at a time. Switching pipelines unmounts and remounts with a new pipelineId.

## File to Modify
- `src/config-dashboard/compositions-app.js` — reduce to a thin wrapper that mounts React
- `src/config-dashboard/react/index.tsx` — mount full App component
- `src/config-dashboard/react/components/*.tsx` — all new components

## Testing
1. Import a screenplay → verify all data flows through Provider
2. Switch between all 5 view tabs
3. Enrich characters → verify live update without reload
4. Generate headshots → verify images appear in Screenplay view
5. Save/Load → verify snapshots work
6. New Project → verify clean slate
7. Git status → verify shows correctly
