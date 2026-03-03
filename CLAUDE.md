# CLAUDE.md

Instructions for Claude Code when working in the woodbury repository.

## Overview

Woodbury is a desktop automation platform that records browser and desktop interactions and replays them as intelligent workflows. It combines a visual pipeline builder, an AI coding assistant (40+ tools), a Chrome extension, and a native Node.js visual AI inference engine into an Electron app.

**Repo**: `~/Documents/GitHub/woodbury/` (TypeScript/Node.js/Electron)
**Sister repo**: `~/Documents/GitHub/woobury-models/` (Python/PyTorch — training only)

## Cross-Repo Architecture

The Woodbury platform spans two repositories. The **ONNX model file** (`encoder.onnx`) is the only artifact that crosses the boundary:

```
┌─────────────────────────────────────────────────────────────┐
│  woodbury repo (this repo) — TypeScript/Node.js/Electron    │
│                                                             │
│  Record workflows ──→ Capture snapshots ──→ Store in        │
│  (recorder.ts)        (Chrome ext)          ~/.woodbury/    │
│                                                             │
│  ┌─ src/inference/ ─────────────────────────────────────┐   │
│  │  Node.js ONNX inference (onnxruntime-node + sharp)   │   │
│  │  HTTP server on :8679, same API as Python serve.py   │   │
│  │  Loads encoder.onnx ← trained in woobury-models      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Replay workflows ──→ Visual verification ──→ Element match │
│  (executor.ts)        (visual-verifier.ts)   via inference  │
│                                                             │
│  Dashboard triggers training via Python subprocess:         │
│    spawn('python', ['-m', 'woobury_models.prepare', ...])   │
│    spawn('python', ['-m', 'woobury_models.train', ...])     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    ↕ encoder.onnx ↕                         │
├─────────────────────────────────────────────────────────────┤
│  woobury-models repo — Python/PyTorch                       │
│                                                             │
│  prepare.py ──→ dataset.py ──→ train.py ──→ export.py       │
│  (crop elements)  (augment)    (Siamese)   (ONNX export)   │
│                                                             │
│  Output: ~/.woodbury/data/models/<run-id>/encoder.onnx      │
└─────────────────────────────────────────────────────────────┘
```

### What lives where

| Concern | Repo | Key files |
|---------|------|-----------|
| Workflow recording | woodbury | `src/workflow/recorder.ts` |
| Workflow execution | woodbury | `src/workflow/executor.ts` |
| Visual verification (runtime) | woodbury | `src/workflow/visual-verifier.ts` |
| ONNX inference (Node.js) | woodbury | `src/inference/*.ts` |
| Snapshot capture during replay | woodbury | `src/workflow/execution-snapshots.ts` |
| Dashboard + training UI | woodbury | `src/config-dashboard.ts` |
| Chrome extension | woodbury | Chrome extension (content/background scripts) |
| Electron app shell | woodbury | `electron/main.js` |
| Data preparation (crops) | woobury-models | `prepare.py` |
| Model training (PyTorch) | woobury-models | `train.py`, `model.py`, `losses.py`, `dataset.py` |
| ONNX export | woobury-models | `export.py` |
| Python inference (for training eval) | woobury-models | `inference.py`, `serve.py` |
| Distributed training worker | woobury-models | `worker.py` |

### Preprocessing Sync Contract

The Node.js inference (`src/inference/image-utils.ts`) must match the Python preprocessing (`woobury_models.model.letterbox` + `config.py`). These constants must be identical:

| Constant | Python (`config.py`) | Node.js (`image-utils.ts`) |
|----------|---------------------|---------------------------|
| `MAX_SIDE` | 224 | 224 |
| `IMAGENET_MEAN` | (0.485, 0.456, 0.406) | [0.485, 0.456, 0.406] |
| `IMAGENET_STD` | (0.229, 0.224, 0.225) | [0.229, 0.224, 0.225] |
| Canvas size | 224×224 | 224×224 |
| Letterbox | Resize long side to 224, black padding, center paste | Same |
| Normalization | float32 /255, subtract mean, divide std | Same |
| Transpose | HWC → CHW → (1, 3, 224, 224) | Same |

**Resize algorithm**: Python uses PIL `BILINEAR`; Node.js uses Sharp `lanczos3`. This causes ~0.32% embedding divergence (cross-pipeline cosine similarity = 0.9968). This is acceptable — both pipelines are internally consistent.

**If you change preprocessing in woobury-models, you MUST update `src/inference/image-utils.ts` to match.**

### Data Lifecycle

1. **Record**: User records a workflow → Chrome extension captures interactions → `recorder.ts` saves `snapshot_*.json` + screenshots to `~/.woodbury/data/training-crops/snapshots/`
2. **Prepare**: Dashboard triggers `python -m woobury_models.prepare` → crops individual elements → `metadata.jsonl` + crop images
3. **Train**: Dashboard triggers `python -m woobury_models.train --json-progress` → Siamese encoder → `encoder.onnx` saved to `~/.woodbury/data/models/<run-id>/`
4. **Inference**: Node.js inference server (`src/inference/serve.ts`) loads `encoder.onnx` → serves HTTP API on port 8679
5. **Verify**: During workflow replay, `visual-verifier.ts` asks the inference server to verify elements match their recorded appearance
6. **More data**: `execution-snapshots.ts` captures snapshots during successful replays → feeds back into step 2

## Architecture

### ESM Project
- `"type": "module"` in package.json
- TypeScript compiles with `"module": "Node16"`, `"moduleResolution": "Node16"`
- All relative imports use `.js` extensions
- The agentic loop is embedded locally in `src/loop/`

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Main application source (CLI, agent, tools, dashboard) |
| `src/loop/` | Embedded agentic loop engine (40+ tools) |
| `src/loop/tools/` | Tool implementations |
| `src/workflow/` | Workflow recording, execution, visual verification |
| `src/inference/` | Node.js ONNX inference (replaces Python serve.py) |
| `src/config-dashboard/` | Dashboard web UI (Config, Workflows, Pipelines, Runs) |
| `electron/` | Electron shell (main.js, preload.js, icons) |
| `apps/woodbury-web/` | Marketing landing page (Next.js, Firebase) |
| `docs/` | Extension authoring docs, API reference |

### Key Files — Core

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point (`#!/usr/bin/env node`), routes to REPL or one-shot |
| `src/cli.ts` | Commander-based CLI argument parsing |
| `src/types.ts` | Shared interfaces |
| `src/repl.ts` | Interactive REPL loop with readline, Ctrl+C handling, slash commands |
| `src/one-shot.ts` | Single-task execution mode |
| `src/agent-factory.ts` | Creates `Agent` + `ToolRegistry`, wires tools |
| `src/system-prompt.ts` | Dynamic system prompt builder |
| `src/context-loader.ts` | Walks up directories to find `.woodbury.md` |
| `src/conversation.ts` | Multi-turn history manager |
| `src/config-dashboard.ts` | Dashboard HTTP server, training orchestration, worker management |
| `src/debug-log.ts` | File-based debug logging to `~/.woodbury/logs/` |

### Key Files — Inference Module

The `src/inference/` module is a Node.js port of Python's `woobury_models.serve`. It provides visual AI element matching without requiring Python.

| File | Purpose |
|------|---------|
| `src/inference/image-utils.ts` | `decodeBase64Image()`, `cropRegion()`, `preprocessImage()` (letterbox + ImageNet normalize) |
| `src/inference/element-matcher.ts` | `ElementMatcher` class: ONNX session via `onnxruntime-node`, `embed()`, `compare()`, embedding cache |
| `src/inference/model-cache.ts` | `ModelCache`: LRU cache (max 5 models), lazy loading, `embed()`, `embedBatch()`, `compare()` |
| `src/inference/serve.ts` | `startInferenceServer(port, defaultModel?)` / `stopInferenceServer()`: HTTP server on port 8679 |
| `src/inference/index.ts` | Barrel export |

**Dependencies**: `onnxruntime-node` (ONNX inference via N-API), `sharp` (image processing via libvips)

**HTTP API** (on `127.0.0.1:8679`):

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/health` | — | `{status: "ready", default_model, loaded_models}` |
| POST | `/embed` | `{image, model?}` | `{embedding: float[]}` |
| POST | `/compare` | `{image_a, image_b, model?}` | `{similarity: float}` |
| POST | `/compare-region` | `{screenshot, bounds, reference, model?}` | `{similarity: float}` |
| POST | `/search-region` | `{screenshot, candidates[], reference, model?}` | `{results[], best_index, best_similarity}` |
| POST | `/search-region-weighted` | `{..., expected_pct, viewport, position_decay?}` | `{results[], best_index, best_similarity, best_composite}` |
| POST | `/load-model` | `{model}` | `{loaded: true, embed_dim}` |

All images are base64-encoded data URLs. The `model` field is optional — defaults to the pre-loaded model.

**Startup**: `config-dashboard.ts` calls `startInferenceServer(8679, bestModel)` on app launch. Scans `~/.woodbury/data/models/` for the latest `encoder.onnx` to pre-load.

### Key Files — Workflow Engine

| File | Purpose |
|------|---------|
| `src/workflow/types.ts` | `WorkflowDocument`, `WorkflowStep`, step types (navigate, click, type, keyboard, desktop), `RecordingEvent` |
| `src/workflow/recorder.ts` | `WorkflowRecorder`: captures Chrome extension events → `.workflow.json`. Captures element crops when `captureElementCrops: true` |
| `src/workflow/executor.ts` | `WorkflowExecutor`: runs steps sequentially via bridge server. Uses `VisualVerifier` for element matching |
| `src/workflow/visual-verifier.ts` | `VisualVerifier`: HTTP client for inference server. `verifyElement()` (threshold 0.75), `searchNearby()` (threshold 0.65, 200px radius) |
| `src/workflow/execution-snapshots.ts` | `ExecutionSnapshotCapture`: captures snapshots during replay. Successful runs keep data; failed runs delete snapshots |
| `src/workflow/resolver.ts` | `ElementResolver`: CSS selector resolution with fallback strategies |
| `src/workflow/validator.ts` | `ConditionValidator`: precondition/postcondition checking |
| `src/workflow/variable-sub.ts` | `substituteObject()`: `{{variable}}` substitution in workflow steps |
| `src/workflow/loader.ts` | `discoverWorkflows()`, `loadWorkflow()`: find and parse `.workflow.json` files |

### Extension System

Extensions live in `~/.woodbury/extensions/`. Each exports `activate(ctx)` with `registerTool()`, `registerCommand()`, `addSystemPrompt()`, `serveWebUI()`. See [docs/extensions.md](docs/extensions.md).

| File | Purpose |
|------|---------|
| `src/extension-api.ts` | Public types for extension authors |
| `src/extension-loader.ts` | Discovery, manifest validation, env file utilities |
| `src/extension-manager.ts` | Lifecycle: load, activate, aggregate, deactivate |
| `src/extension-scaffold.ts` | `woodbury ext create` scaffolding |

## Build & Run

```bash
npm run build          # TypeScript compilation
npm run clean          # Remove dist/
npm run setup          # install + build + npm link
npm run electron:dev   # Build + launch Electron app
npm run electron:build # Build .dmg for macOS
npm test               # Run Jest tests
```

## Debug Logging

**Activate:** `woodbury --debug` or `WOODBURY_DEBUG=1 woodbury`
**Log location:** `~/.woodbury/logs/woodbury-<YYYY-MM-DD>-<HHmmss>.log`
**View in REPL:** `/log` (shows path + last 20 lines), `/log 50`

## Dependencies

- `onnxruntime-node` — ONNX model inference (native N-API, no electron-rebuild needed)
- `sharp` — Image processing (letterbox, crop, resize via libvips)
- `chalk` v5 — Terminal colors
- `ora` v8 — Spinner
- `marked` + `marked-terminal` — Markdown rendering
- `commander` — CLI parsing
- `ws` — WebSocket for Chrome extension bridge
- `uiohook-napi` — Desktop input events
- `electron` + `electron-builder` — Desktop app packaging

## Testing

- **Framework:** Jest (`src/__tests__/`)
- **Config:** `jest.config.js` (ts-jest preset, node env, `.js` extension mapping)
- **Run:** `npm test` (all), `npx jest <file>` (single), `npm run test:coverage`

## Conventions

- All relative imports use `.js` extensions (ESM)
- The `ToolRegistry` is constructed manually in `agent-factory.ts`
- `allowDangerousTools` defaults to `true`; `--safe` flag disables it
- Ctrl+C during execution aborts via `AbortController`; double Ctrl+C at idle exits
- Extension tool names are prefixed: `social_post`, `social_draft`
- Training commands still shell out to Python (`python -m woobury_models.prepare/train`) — this is intentional, training stays in the Python repo
- The inference server is pure Node.js — no Python required for end-user element matching
- Workflow snapshots go to `~/.woodbury/data/training-crops/snapshots/<site_id>/`
- Trained models live at `~/.woodbury/data/models/<run-id>/encoder.onnx`
