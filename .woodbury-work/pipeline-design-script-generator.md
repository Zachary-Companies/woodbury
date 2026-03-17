# Script Generator Pipeline — Graph Design & Interface Contract

## Verification Result

**✅ ALL input variable nodes ARE correctly connected to the Generate Script Document node via edges.**

| Variable Node | Edge ID | Target Port |
|---------------|---------|-------------|
| node-1 (Script Kind) | edge-1 | scriptKind |
| node-2 (Title) | edge-2 | title |
| node-3 (Subtitle) | edge-3 | subtitle |
| node-4 (Genre) | edge-4 | genre |
| node-5 (Visualization Style) | edge-5 | visualizationStyle |

---

## Pipeline Graph Structure

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SCRIPT GENERATOR PIPELINE                                 │
│                        (comp-script-generator-compact)                           │
└─────────────────────────────────────────────────────────────────────────────────┘

STAGE 1: EXPOSED INPUTS (5 __variable__ nodes)
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   node-1         │  │   node-2         │  │   node-3         │
│   Script Kind    │  │   Title          │  │   Subtitle       │
│   (string)       │  │   (string)       │  │   (string)       │
│   exposeAsInput  │  │   exposeAsInput  │  │   exposeAsInput  │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │ edge-1              │ edge-2              │ edge-3
         ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐
│   node-4         │  │   node-5         │
│   Genre          │  │   Visualization  │
│   (string)       │  │   Style (string) │
│   exposeAsInput  │  │   exposeAsInput  │
└────────┬─────────┘  └────────┬─────────┘
         │ edge-4              │ edge-5
         ▼                     ▼

STAGE 2: SCRIPT GENERATION (__script__ node)
┌─────────────────────────────────────────────────────────────────────────────────┐
│   node-6: Generate Script & Collection                                           │
│                                                                                  │
│   INPUTS:                              OUTPUTS:                                  │
│   • scriptKind (string)                • scriptDocument (string/JSON)            │
│   • title (string)                     • assetCollection (string)                │
│   • subtitle (string)                                                            │
│   • genre (string)                                                               │
│   • visualizationStyle (string)                                                  │
│                                                                                  │
│   RESPONSIBILITY: Generate ScriptDocument JSON with metadata, characters,        │
│                   scenes, shots. Create asset collection for the project.        │
└────────────────────────────────┬────────────────────────────────────────────────┘
                                 │ edge-6 (scriptDocument)
                                 │ edge-7 (assetCollection)
                                 ▼

STAGE 3: ASSET GENERATION (__script__ node)
┌─────────────────────────────────────────────────────────────────────────────────┐
│   node-7: Generate All Assets                                                    │
│                                                                                  │
│   INPUTS:                              OUTPUTS:                                  │
│   • scriptDocument (string/JSON)       • enrichedScriptDocument (string/JSON)   │
│   • assetCollection (string)                                                     │
│                                                                                  │
│   RESPONSIBILITY: Parse script, generate images via nanobanana for each asset,  │
│                   save to collection via asset_save, track progress.            │
└────────────────────────────────┬────────────────────────────────────────────────┘
                                 │ edge-8 (enrichedScriptDocument)
                                 ▼

STAGE 4: FINAL ASSEMBLY (__script__ node)
┌─────────────────────────────────────────────────────────────────────────────────┐
│   node-8: Final Assembly                                                         │
│                                                                                  │
│   INPUTS:                              OUTPUTS:                                  │
│   • enrichedScriptDocument (string)    • finalScriptDocument (string/JSON)      │
│                                                                                  │
│   RESPONSIBILITY: Validate and finalize the enriched script document.           │
└────────────────────────────────┬────────────────────────────────────────────────┘
                                 │ edge-9 (finalScriptDocument)
                                 ▼

STAGE 5: OUTPUT (__output__ node)
┌─────────────────────────────────────────────────────────────────────────────────┐
│   node-9: Output                                                                 │
│                                                                                  │
│   PORTS:                                                                         │
│   • finalScriptDocument (string) — The complete ScriptDocument JSON              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Interface Contract

### Exposed Inputs (User-Provided Values)

| Input Name | Type | Required | Description |
|------------|------|----------|-------------|
| `scriptKind` | string | ✓ | Type of script (e.g., "short film", "commercial", "music video") |
| `title` | string | ✓ | Title of the script |
| `subtitle` | string | ✓ | Subtitle or tagline |
| `genre` | string | ✓ | Genre (e.g., "drama", "comedy", "sci-fi") |
| `visualizationStyle` | string | ✓ | Visual style for assets (e.g., "photorealistic", "anime", "watercolor") |

### Pipeline Output

| Output Name | Type | Description |
|-------------|------|-------------|
| `finalScriptDocument` | string (JSON) | Complete ScriptDocument with metadata, characters, scenes, shots, and asset IDs |

---

## Data Flow Summary

```
User Input → 5 Variable Nodes → Generate Script (node-6) → Generate Assets (node-7) → Final Assembly (node-8) → Output (node-9)
```

### Edge Count: 9 total
- **5 edges** from variable nodes to node-6 (input fan-in)
- **2 edges** from node-6 to node-7 (scriptDocument + assetCollection)
- **1 edge** from node-7 to node-8 (enrichedScriptDocument)
- **1 edge** from node-8 to node-9 (finalScriptDocument)

---

## Node Responsibilities

| Node | Type | Responsibility |
|------|------|----------------|
| node-1 to node-5 | `__variable__` | Expose user inputs with stable `inputName` identifiers |
| node-6 | `__script__` | LLM-powered script generation + asset collection creation |
| node-7 | `__script__` | Image generation loop with progress tracking |
| node-8 | `__script__` | Validation and final JSON assembly |
| node-9 | `__output__` | Expose final result to pipeline caller |

---

## Design Compliance

✅ **Single exposed variable per input** — Each user-provided value has exactly one `__variable__` node with `exposeAsInput: true`  
✅ **No duplicate inputs** — Values fan out via edges, not repeated variable nodes  
✅ **All edges verified** — Every variable node connects to node-6 via a dedicated edge  
✅ **Clear stage boundaries** — Generation → Asset Creation → Assembly → Output  
✅ **Typed ports** — All inputs/outputs have explicit type declarations  

---

## File Location

Pipeline stored at: `/Users/andrewporter/.woodbury/workflows/comp-script-generator-compact.composition.json`
