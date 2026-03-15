# Woodbury Today's Log

Date: 2026-03-13

Scope: all commits and working-tree changes on March 13, 2026 (commits `7fd50b2`, `09300c7`, plus uncommitted `.woodbury-work/` updates).

## Executive Summary

March 13 delivered five areas of change across two commits and 40+ files (~6,500 lines added):

1. **Memory storage** moved from SQLite to a file-backed store with inspectable Markdown/JSON artifacts.
2. **Skill builder** — a new subsystem for drafting, reviewing, benchmarking, and publishing reusable skills.
3. **Script generation** became mode-aware with persisted transcripts, published-skill biasing, and stricter validation.
4. **Pipeline repair context** was tightened so repair passes receive neighbor-node graph context and over-specific test expectations are filtered out.
5. **Electron startup and native deps** became safer for both source builds and packaged apps.

---

## Commit 1: `7fd50b2` — Add skill builder workflows and file-backed memory storage

This was the large foundational commit (40 files, ~6,000 net lines). It introduced three major features simultaneously.

### 1. File-backed memory artifacts

**What changed:**
- `src/sqlite-memory-store.ts` was rewritten to persist memories as structured files under `~/.woodbury/data/memory/memory-store` instead of requiring `node:sqlite`.
- `src/loop/tools/memory-save.ts` and `src/loop/tools/memory-recall.ts` were updated so agent-facing descriptions match the new storage model.
- `src/loop/v3/memory-store.ts` and `src/system-prompt.ts` were aligned.
- The dashboard memory browser (`src/config-dashboard/memories.js`, `src/config-dashboard/styles.css`) gained file-location display and reveal actions.
- New API endpoints in `src/dashboard/routes/memories.ts` allow opening the underlying Markdown file from the UI.
- Tests updated: `src/__tests__/memory.test.ts`, `src/__tests__/memory-tools.test.ts`.

**Why:**
- `node:sqlite` caused startup failures in some environments (especially packaged Electron builds). File-backed storage avoids the native dependency entirely.
- Users can now inspect and edit their memory store with any text editor — memories are no longer opaque database rows.
- The dashboard can point users to the exact file on disk where a memory lives.

### 2. Skill builder and optimizer subsystem

**What changed:**
- New core modules: `src/skill-builder/optimizer.ts` (975 lines), `src/skill-builder/storage.ts` (263 lines), `src/skill-builder/types.ts` (297 lines).
- Dashboard API surface: `src/dashboard/routes/skill-optimizer.ts` (507 lines), registered in `src/dashboard/routes/index.ts`.
- Full browser-side Skills tab: `src/config-dashboard/skills.js` (1,143 lines), with navigation wiring in `index.html` and `app.js`, plus new CSS in `styles.css`.
- Agent tool: `src/loop/tools/skill-optimize.ts` (80 lines), registered in `src/loop/tools/index.ts`.
- Tests: `src/__tests__/skill-optimizer.test.ts` (629 lines).

**Why:**
- Skill authoring was previously a manual prompt-writing exercise with no persistence, versioning, or feedback loop.
- The optimizer enables draft → review → evaluate → compare → publish workflows, so skills improve over time.
- Published skills can now bias both chat behavior (via `src/loop/v3/system-prompt-v3.ts`) and pipeline script generation, reducing redundant pattern invention.

### 3. Script generation transcripts, edit modes, and published-skill biasing

**What changed:**
- `src/dashboard/routes/generation.ts` gained ~450 lines: mode-aware generation (`generate`, `edit`, `repair`, `verify`), lifecycle transcript recording, published-skill prompt injection, and stricter validation.
- `src/dashboard/script-generation-tests.ts` added progress-reporting simulation and runtime contract checks.
- `src/workflow/types.ts` extended `ScriptNodeConfig` with a persisted `generationTranscript` field.
- Compositions UI (`compositions-canvas.js`, `compositions-execution.js`, `compositions-properties.js`) now captures transcripts, shows transcript history, and lets users select published skills for generation.
- `src/loop/v3/closure-engine.ts` and `src/loop/v3/types.ts` exposed full assistant-turn callbacks for trace reconstruction.
- `src/loop/v3/system-prompt-v3.ts` now injects published chat skills into the v3 system prompt, tested in `src/__tests__/v3-bridge.test.ts`.

**Why:**
- Without transcripts, debugging why a script node was generated a certain way required re-running generation. Now the full request, repairs, tests, and verification summary are stored on the node.
- Mode conflation (treating an edit as a fresh generate) caused unnecessary rework. Explicit modes prevent this.
- Published-skill biasing means the generator reuses proven patterns instead of starting from scratch.

### 4. Chat, Electron startup, and native dependency safety

**What changed:**
- `src/dashboard/routes/chat.ts` raised the chat agent timeout to 30 minutes.
- `src/config-dashboard/chat.js` preserves chat view state across tab switches.
- `electron/main.js` resolves a stable workDir for packaged apps and formats native-module startup failures into actionable error dialogs.
- `package.json` added `electron-builder install-app-deps` to `postinstall`, introduced `electron:prepare-native`, and wired it into `electron:dev`.

**Why:**
- Long-running chat sessions were timing out at the old limit.
- Tab-switching was destroying and rebuilding the chat view unnecessarily.
- Packaged app startup failures from missing native modules were silent or cryptic — now they produce a dialog with the actual error.

---

## Commit 2: `09300c7` — Tighten pipeline script generation and repair context

This follow-up commit (4 files, 274 lines added, 63 removed) refined the generation and repair pipeline based on issues observed after the first commit.

### 5. Pipeline repair context and test expectation sanitization

**What changed:**
- `src/dashboard/routes/generation.ts`:
  - Added `PipelinePortContract` type and `normalizePipelinePortContracts()` to validate port definitions before they reach the generator.
  - Added `sanitizeExpectedOutputSubset()` which filters out over-specific string expectations (>120 chars, multiline, or JSON-shaped strings) from test cases — these were causing brittle test failures.
  - Added `isOverSpecificStringExpectation()` heuristic.
  - Introduced `shouldUseDirectScriptGeneration(mode)` helper — repair and verify modes now also use the direct prompt fallback instead of the full closure-engine pass, matching the behavior already used for generate and edit. This makes repair passes faster and more predictable.
  - Repair passes (both validation-repair and unit-test-repair) now use the direct generation path when appropriate, receiving the current broken code and specific error messages rather than going through the full scoped generation pipeline.
  - The verification transcript entry was renamed from stage `'verification'` to `'checks'` with a clearer title, and the summary now explicitly states that checks cover structure and sandbox behavior only, not full pipeline runtime execution.
  - Added a new `'checks'` stage type to `ScriptGenerationTranscriptEntry`.

- `src/config-dashboard/compositions-execution.js`:
  - `repairScriptNode()` now collects neighbor node IDs from both the node's `contextNodeIds` and the pipeline's edge graph, deduplicates them, and passes the resulting `graphContext` to the generation endpoint. Previously, repair passes had no awareness of neighboring nodes' contracts.

- `src/config-dashboard/compositions-properties.js`:
  - Transcript description text updated from "verification passes" to "code-check passes" to match the backend rename.

- `src/__tests__/generation-route.test.ts`:
  - Added 92 lines of new test cases covering the tightened sanitization and mode routing.

**Why:**
- Repair passes were failing because they lacked context about what the neighboring nodes produce/consume. By injecting neighbor graph context, repairs can reference the actual port contracts of connected nodes.
- Over-specific string expectations in generated test cases (e.g., expecting an exact 200-character JSON string) caused false negatives. The sanitizer now strips these, keeping only expectations the generator can reliably satisfy.
- Using the direct generation path for repairs avoids the overhead and nondeterminism of a full closure-engine session, making repairs faster and more focused.
- Renaming "verification" to "checks" sets the right expectation — these are structural and sandbox checks, not guarantees of runtime correctness.

---

## Uncommitted Changes

Two repo-local task files under `.woodbury-work/` were updated:
- `goal.json` — reflects the current scene-generator repair objective.
- `plan.json` — updated plan state for the active workspace flow.

These are working-tree artifacts and were not part of either commit.

---

## Validation

- Commit 1 was validated with `npm run build` and targeted test suites (`memory.test.ts`, `memory-tools.test.ts`, `v3-bridge.test.ts`, `skill-optimizer.test.ts`).
- Commit 2 was validated with `npm run build` and `generation-route.test.ts`.
- All tests passed. TypeScript compilation succeeded for both commits.

---

## Net Effect

By end of day March 13, Woodbury gained:

- **Inspectable memory** — memories are Markdown files on disk, not opaque database rows.
- **Skill lifecycle** — skills can be drafted, reviewed, benchmarked, versioned, published, and reused across chat and pipelines.
- **Auditable generation** — every script node stores its full generation transcript (request, repairs, tests, checks).
- **Context-aware repair** — pipeline repair passes now see neighbor-node port contracts instead of operating in isolation.
- **Robust startup** — Electron handles native dependency failures gracefully and the chat surface survives tab switches and long sessions.
