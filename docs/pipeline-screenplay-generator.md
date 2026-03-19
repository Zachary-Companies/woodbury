# Comprehensive Screenplay Generator Pipeline

**Pipeline ID:** `comp-screenplay-generator`
**Location:** `~/.woodbury/workflows/comp-screenplay-generator/`
**Type:** Woodbury v2 file-backed pipeline
**Created:** 2026-03-15
**Last modified:** 2026-03-18

---

## Purpose

Generates complete screenplay packages from a story idea. Takes user inputs (project type, story idea, genre, mood, etc.) and produces a full screenplay with characters, locations, scene structure, dialogue, production metadata, concept art (previs), and dialogue audio — all assembled into a single output package.

---

## Pipeline Inputs (17 variables)

| Input | Required | Control | Description |
|-------|----------|---------|-------------|
| `projectType` | Yes | select | Short Film, Feature Film, TV Pilot, TV Episode, Commercial, etc. (12 options) |
| `storyIdea` | Yes | textarea | Free-text story description |
| `title` | No | text | Working title (auto-generated if blank) |
| `genre` | No | combobox | Drama, Comedy, Horror, Thriller, Sci-Fi, etc. (12 options) |
| `mood` | No | select | Dark and suspenseful, Light and fun, etc. (12 options) |
| `targetAudience` | No | select | General Audiences, Adults, Teens, Families, etc. (10 options) |
| `visualStyle` | No | select | Cinematic, Documentary, Animated, etc. (12 options) |
| `length` | No | select | 30 seconds through 3 hours |
| `authorName` | No | text | Screenplay credits name |
| `additionalNotes` | No | textarea | Extra creative direction |
| `seriesName` | No | text | TV projects only |
| `seasonNumber` | No | text | TV projects only |
| `episodeNumber` | No | text | TV projects only |
| `brandName` | No | text | Commercial projects only |
| `productName` | No | text | Commercial projects only |
| `spotLength` | No | select | Commercial projects only (6s, 15s, 30s, 60s) |
| `callToAction` | No | text | Commercial projects only |

Conditional inputs (TV-specific, commercial-specific) are defined in `pipeline-inputs.json`.

---

## Execution Flow (32 nodes, 66 edges)

```
                    ┌──────────────────────┐
                    │  17 Input Variables   │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ node-3: Input        │
                    │ Validation           │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ node-4: Metadata     │
                    │ Generation           │
                    └──────┬───┬───────────┘
                      ┌────┘   └────┐
                      ▼             ▼
           ┌─────────────┐  ┌─────────────┐
           │ node-5:     │  │ node-6:     │
           │ Character   │  │ Location    │
           │ Generation  │  │ Generation  │
           └──────┬──────┘  └──────┬──────┘
                  └────┬───────────┘
                       ▼
            ┌──────────────────────┐
            │ node-7: Section      │
            │ Structure            │
            └──────────┬───────────┘
                       ▼
            ┌──────────────────────┐
            │ node-8: FOREACH      │
            │ (iterates sections,  │
            │  max 100)            │
            └──────────┬───────────┘
                       ▼
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐ ┌───────────┐ ┌───────────┐
  │ node-9:   │ │ node-10:  │ │ node-13:  │
  │ Scene     │ │ Element   │ │ Previs    │
  │ Content   │ │ Generation│ │ Generation│
  └───────────┘ └───────────┘ └───────────┘

        Also in parallel:
        node-11: Production Metadata
        node-12: Asset Collection
        node-14: Rule Enforcement
        node-17: Dialogue Audio Generation

                       │
                       ▼
            ┌──────────────────────┐
            │ node-15: Final       │
            │ Assembly (12 inputs) │
            └──────────┬───────────┘
                       ▼
            ┌──────────────────────┐
            │ node-16: Output      │
            │ (scriptPackage)      │
            └──────────────────────┘
```

### Phase Breakdown

| Phase | Nodes | What happens |
|-------|-------|-------------|
| 1. Normalize | node-3 | All 17 inputs validated, defaults applied |
| 2. Foundation | node-4 | Title, logline, synopsis, genre, themes generated via LLM |
| 3. World-build | node-5, node-6 | Characters and locations generated in parallel |
| 4. Structure | node-7 | Act/scene hierarchy built from metadata + characters + locations |
| 5. Iterate | node-8 | FOREACH loop over each section (max 100) |
| 6. Flesh out | node-9 through node-14, node-17 | Scene content, dialogue, shots, production notes, assets, previs images, audio |
| 7. Converge | node-15 | 12 inputs merged into final scriptPackage |
| 8. Output | node-16 | Exposes scriptPackage for views and downstream use |

---

## Script Nodes (src/)

| File | Node | Purpose |
|------|------|---------|
| `input-validation.ts` | node-3 | Validates/normalizes all inputs, applies defaults for optional fields |
| `metadata-generation.ts` | node-4 | LLM generates title, logline, synopsis, genre list, themes |
| `character-generation.ts` | node-5 | LLM generates character profiles (name, displayName, description, arc) |
| `location-generation.ts` | node-6 | LLM generates location profiles (name, description, atmosphere) |
| `section-structure.ts` | node-7 | LLM generates act/scene hierarchy with nested children |
| `scene-content-generation.ts` | node-9 | LLM generates detailed scene content (beats, action, description) |
| `element-generation.ts` | node-10 | LLM generates screenplay elements: shots, dialogue, action lines |
| `production-metadata.ts` | node-11 | LLM generates production notes (schedule, budget, crew, equipment) |
| `asset-collection.ts` | node-12 | Saves generated assets to Woodbury asset library |
| `previs-generation.ts` | node-13 | Generates concept art / previsualization images for shots |
| `rule-enforcement.ts` | node-14 | Validates screenplay against formatting/industry rules |
| `dialogue-audio-generation.ts` | node-17 | Generates TTS audio for dialogue using ElevenLabs voices |
| `final-assembly.ts` | node-15 | Merges all outputs into unified scriptPackage |

Supporting files:
- `_test-helpers.ts` — Mock `ScriptContext` for unit tests
- `_test-fixtures.ts` — Shared test data

---

## Output Data Shape

The final `scriptPackage` contains:

```
metadata        — { title, logline, genre, synopsis, themes, ... }
sections[]      — Act/scene hierarchy with nested children
elements[]      — Shots, dialogue, action lines: { id, type, content, character }
characters[]    — { id, name, displayName, description }
locations[]     — { id, name, description }
previsualizations.shots[] — { shotElementId, filePath, characterIds, locationId, description }
assets[]        — { filePath, metadata: { characterId?, locationId? } }
```

---

## Bindings System

The `bindings/` directory stores semantic relationships between entities.

| File | Purpose |
|------|---------|
| `bindings.json` | Entity-to-entity connections (depicts, set-in, voice) |
| `rules.json` | Auto-binding rules (match character displayName in shot text, match location name in shot text) |
| `views.json` | Maps semantic roles to pipeline node outputs |

**Binding types:**
- `depicts` — character appears in a shot (used for previs image generation)
- `set-in` — shot/scene is set in a location
- `voice` — dialogue spoken by a character (used for TTS)

Auto-binding rules match `displayName` (uppercase form like "MARCUS"), not `name` (like "Marcus Chen").

---

## Actions (UI Buttons)

`actions/generate-image.json` controls the **Regen / Generate Image** buttons on shot cards:
- Uses `binding-match` strategy to include only characters bound to a specific shot
- Auto-creates bindings via rules if none exist
- Builds prompts from shot metadata + camera info + style
- Calls nanobanana (Gemini image gen) with matched reference images

---

## Custom Views

| View | Location | Purpose |
|------|----------|---------|
| `views/editor/` | Screenplay NLE editor | Full screenplay viewer with timeline, shot cards, dialogue clips, render panel, dialog inspector |
| `views/voices/` | Voice assignment | Assign ElevenLabs voices to characters, preview audio |

Views register via `window.registerPipelineView()` and are loaded dynamically into the app UI.

---

## Development History

| Date | Milestone |
|------|-----------|
| Mar 15 | Pipeline scaffolded, all 13 nodes implemented, tests written and fixed |
| Mar 15 | Inputs simplified from JSON blob to 17 user-friendly fields |
| Mar 15 | Orphaned nodes cleaned up (12 moved to `_orphaned_nodes/`) |
| Mar 15 | ForEach loop fixed for v2 file-backed script nodes |
| Mar 15 | Final assembly fixed to populate section children with elements |
| Mar 16 | Asset collection fixed (correct `file_path` param, collection slug not ID) |
| Mar 16 | Nested sections bug fixed — recursive processing for acts containing scenes |
| Mar 18 | Voices view added (ElevenLabs voice assignment/preview) |
| Mar 18 | Dialogue audio generation node added (TTS via ElevenLabs) |
| Mar 18 | "Render All Dialogue" batch button added to screenplay view toolbar |
| Mar 18 | NLE editor: render panel, dialog clip inspector, app sidebar collapse |

**Remaining:** End-to-end test of full pipeline (status: pending).

---

## File Tree

```
comp-screenplay-generator/
├── pipeline.json            # 40KB graph manifest (32 nodes, 66 edges)
├── pipeline-inputs.json     # Friendly input form config with conditionals
├── package.json             # ESM, vitest for testing
├── tsconfig.json
├── woodbury.d.ts            # ScriptContext type definitions
├── CLAUDE.md                # AI assistant instructions
├── TODO.json                # Task tracker
├── README.md
├── .env.example
├── .gitignore
├── src/
│   ├── input-validation.ts (+test)
│   ├── metadata-generation.ts (+test)
│   ├── character-generation.ts (+test)
│   ├── location-generation.ts (+test)
│   ├── section-structure.ts (+test)
│   ├── scene-content-generation.ts (+test)
│   ├── element-generation.ts (+test)
│   ├── production-metadata.ts (+test)
│   ├── asset-collection.ts (+test)
│   ├── previs-generation.ts (+test)
│   ├── rule-enforcement.ts (+test)
│   ├── dialogue-audio-generation.ts (+test)
│   ├── final-assembly.ts (+test)
│   ├── _test-helpers.ts
│   └── _test-fixtures.ts
├── actions/
│   └── generate-image.json     # Previs button behavior config
├── bindings/
│   ├── bindings.json           # 218KB entity relationships
│   ├── rules.json              # Auto-binding rules
│   └── views.json              # View-to-node mappings
├── views/
│   ├── editor/                 # Screenplay NLE view
│   └── voices/                 # Voice assignment view
├── assets/                     # Generated concept art
├── audio/                      # Generated dialogue audio
└── _orphaned_nodes/            # 12 unused node files (archived)
```

---

## Dependencies

- **Runtime:** Woodbury pipeline engine (`context.llm`, `context.progress`, `context.log`)
- **Image gen:** nanobanana extension (Gemini Flash/Pro via `generate-image` action)
- **TTS:** ElevenLabs API (via `dialogue-audio-generation` node)
- **Asset storage:** Woodbury asset library (via `asset-collection` node)
- **Testing:** vitest

---

## Key Technical Notes

1. **node-4 is the hub** — Metadata Generation feeds 7 downstream nodes
2. **node-15 is the convergence bottleneck** — Final Assembly takes 12 inputs from all branches
3. **FOREACH (node-8)** iterates over sections; scene-content, element, and previs generation all process nested section structures recursively
4. **Character matching** uses `displayName` (e.g., "MARCUS") not `name` (e.g., "Marcus Chen") — this affects binding rules
5. **Asset collection** uses `file_path` (not `path`) and collection slug (not ID) for the Woodbury asset library API
6. **Element generation** explicitly generates both dialogue and shot elements — an early version missed dialogue
7. **Previs generation** falls back to generating shots from scene beats when no shot elements exist
