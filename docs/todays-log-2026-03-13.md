# Woodbury Today's Log

Date: 2026-03-13

Scope: current working-tree changes prepared for commit on March 13, 2026.

This document captures the uncommitted change set as it exists in the repository before the commit is created. It is narrower than the broader architecture docs and is meant to answer one question: what changed today, and why does it matter?

## Executive Summary

March 13 focused on four concrete improvements:

- Memory storage moved from a SQLite-only implementation to a file-backed store that exposes durable Markdown and JSON artifacts.
- Woodbury gained a new skill-builder and optimizer surface for drafting, reviewing, benchmarking, publishing, and reusing structured skills.
- Script generation became more auditable through persisted transcripts, stricter mode-aware generation flows, and published-skill biasing for both chat and pipelines.
- Electron startup and native dependency handling became safer for both source builds and packaged app launches.

## Major Changes

### 1. File-backed memory artifacts and browser actions

The memory subsystem was refactored so persisted memories now live in an organized file-and-folder store instead of depending on the prior SQLite runtime path.

- [src/sqlite-memory-store.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/sqlite-memory-store.ts) now manages general memories, closure memories, and embeddings as structured files under `~/.woodbury/data/memory/memory-store`.
- [src/loop/tools/memory-save.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/tools/memory-save.ts), [src/loop/tools/memory-recall.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/tools/memory-recall.ts), [src/system-prompt.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/system-prompt.ts), and [src/loop/v3/memory-store.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/memory-store.ts) were updated so agent guidance and tool descriptions match the new storage model.
- The dashboard memory browser now exposes file locations and file actions in [src/config-dashboard/memories.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/memories.js) and [src/config-dashboard/styles.css](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/styles.css).
- New dashboard endpoints in [src/dashboard/routes/memories.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/memories.ts) allow opening or revealing the underlying Markdown artifact from the UI.
- Regression coverage was added in [src/__tests__/memory.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/memory.test.ts) and [src/__tests__/memory-tools.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/memory-tools.test.ts).

Why this matters:

- Memory is now inspectable and portable without relying on SQLite tooling.
- The UI can show users exactly where durable knowledge is stored.
- The runtime avoids `node:sqlite` startup failures in environments where native support is brittle or unavailable.

### 2. New skill optimizer subsystem and dashboard tab

Woodbury now has a dedicated skill-builder workflow that supports drafting skills, reviewer approval, optimization runs, version diffs, and publishing reusable skills for chat and pipelines.

- New core logic was added in [src/skill-builder/optimizer.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/skill-builder/optimizer.ts), [src/skill-builder/storage.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/skill-builder/storage.ts), and [src/skill-builder/types.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/skill-builder/types.ts).
- A new dashboard route surface was added in [src/dashboard/routes/skill-optimizer.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/skill-optimizer.ts) and registered in [src/dashboard/routes/index.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/index.ts).
- A full browser-side skills tab was added through [src/config-dashboard/skills.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/skills.js), plus navigation wiring in [src/config-dashboard/index.html](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/index.html), [src/config-dashboard/app.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/app.js), and styling in [src/config-dashboard/styles.css](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/styles.css).
- A callable optimizer tool was added in [src/loop/tools/skill-optimize.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/tools/skill-optimize.ts) and registered in [src/loop/tools/index.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/tools/index.ts).
- End-to-end behavioral tests were added in [src/__tests__/skill-optimizer.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/skill-optimizer.test.ts).

Why this matters:

- Skill authoring is no longer just a prompt exercise; it is now a persisted optimization workflow with draft review, evaluation, and publish steps.
- Reusable skills can now bias both chat behavior and pipeline generation from a shared published library.
- The new UI gives a concrete operational surface for comparing skill versions and reviewing optimization runs.

### 3. Script generation transcripts, edit modes, and published-skill biasing

The generation stack now stores more of its own reasoning trail and supports mode-aware generation behavior instead of treating every request as a fresh one-shot.

- [src/dashboard/routes/generation.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/generation.ts) now distinguishes generate, edit, repair, and verify modes; records lifecycle transcripts; supports published-skill prompt sections; and returns transcript data to the dashboard.
- [src/dashboard/script-generation-tests.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/script-generation-tests.ts) now simulates progress reporting and validates more of the generated-script runtime contract.
- [src/workflow/types.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/workflow/types.ts) extends `ScriptNodeConfig` with persisted generation transcripts.
- The compositions UI was updated in [src/config-dashboard/compositions-canvas.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-canvas.js), [src/config-dashboard/compositions-execution.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-execution.js), and [src/config-dashboard/compositions-properties.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-properties.js) to capture transcript data, show transcript history, and bias pipeline generation with selected published skills.
- [src/loop/v3/closure-engine.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/closure-engine.ts) and [src/loop/v3/types.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/types.ts) now surface full assistant-turn callbacks so generation traces can be reconstructed.
- [src/loop/v3/system-prompt-v3.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/system-prompt-v3.ts) now injects published chat skills into the v3 system prompt, with regression coverage in [src/__tests__/v3-bridge.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/v3-bridge.test.ts).

Why this matters:

- Script-node generation is easier to audit because the request, repairs, validation, tests, and verification summary are stored on the node.
- Generation can be biased toward already-published skills instead of inventing a new pattern every time.
- The system is less likely to conflate a first-pass generation request with an edit or repair request.

### 4. Chat, Electron startup, and native dependency safety

The runtime now handles longer chat work and startup failures more deliberately.

- [src/dashboard/routes/chat.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/chat.ts) increases the chat agent timeout to 30 minutes for long-running dashboard sessions.
- [src/config-dashboard/chat.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/chat.js) preserves and restores the chat view when switching tabs so the UI does not get rebuilt unnecessarily.
- [electron/main.js](/Users/andrewporter/Documents/GitHub/woodbury/electron/main.js) now resolves a stable dashboard work directory for packaged apps and formats native-module or memory-store startup failures into more actionable error dialogs.
- [package.json](/Users/andrewporter/Documents/GitHub/woodbury/package.json) now runs `electron-builder install-app-deps` during `postinstall`, introduces `electron:prepare-native`, and makes `electron:dev` depend on native dependency preparation.

Why this matters:

- Packaged app startup is less likely to fail silently or with low-signal native module errors.
- Source builds get a clearer native-preparation path before launching Electron.
- The dashboard chat surface is more resilient during long sessions and tab changes.

## Supporting Artifacts In The Working Tree

Two repo-local task files were also added under [.woodbury-work/goal.json](/Users/andrewporter/Documents/GitHub/woodbury/.woodbury-work/goal.json) and [.woodbury-work/plan.json](/Users/andrewporter/Documents/GitHub/woodbury/.woodbury-work/plan.json). These capture a scene-generator repair objective and the associated plan state from the active workspace flow.

## Validation

The current working tree was validated before commit with:

- `npm run build`
- `npm test -- --runInBand src/__tests__/memory.test.ts src/__tests__/memory-tools.test.ts src/__tests__/v3-bridge.test.ts src/__tests__/skill-optimizer.test.ts`

All four targeted test suites passed, and the TypeScript build completed successfully.

## Net Effect

By the end of this March 13 change set, Woodbury had moved closer to three goals:

- durable and inspectable memory storage,
- a first-class workflow for building and publishing reusable skills,
- and a more traceable, mode-aware generation stack that can reuse published knowledge across chat and pipelines.