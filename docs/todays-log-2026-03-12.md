# Woodbury Today's Log

Date: 2026-03-12

Scope: changes made on March 12, 2026, plus the working-tree follow-up that had not yet been committed when this log was written.

Source commits covered in this log:

- `5ec74b6` - Add composition form inputs and graph-aware script auto-fix
- `8ed358b` - Add retrospective change log for March 5-12
- `b30cec5` - Add dashboard image to README
- `f70c9e6` - Add README dashboard image asset
- `1978192` - Improve pipeline generation and Monaco script editing

This document is intentionally narrower than the broader retrospective. Its only goal is to isolate what changed today.

## Executive Summary

March 12 focused on making Woodbury pipelines easier to use, easier to repair, and easier to trust.

- Compositions became more shareable by exposing variable nodes as form inputs.
- Script-node failures gained graph-aware repair paths instead of relying on local code fixes alone.
- Pipeline generation got a stronger authoring surface with Monaco and stricter validation before claiming success.
- Asset collection behavior became more explicit, especially around true moves versus append-only membership updates.
- Documentation and agent guidance were tightened so the product contracts now better match the runtime behavior.

## Commit Log

### Commit `5ec74b6`
### Add composition form inputs and graph-aware script auto-fix

#### What changed

- Composition variable nodes gained form-facing metadata in [src/workflow/types.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/workflow/types.ts): exposed input name, description, required flag, and generation prompt.
- The compositions UI added support for exposed pipeline inputs and a shareable form view in [src/config-dashboard/compositions-canvas.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-canvas.js), [src/config-dashboard/compositions-core.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-core.js), [src/config-dashboard/compositions-execution.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-execution.js), [src/config-dashboard/compositions-properties.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-properties.js), [src/config-dashboard/app.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/app.js), and [src/config-dashboard/styles.css](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/styles.css).
- Composition interface inference expanded in [src/dashboard/routes/compositions.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/compositions.ts) so nested composition inputs and junction ports are surfaced more accurately.
- Composition execution gained graph-aware script auto-fix behavior in [src/dashboard/routes/composition-run.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/composition-run.ts), backed by [src/dashboard/script-autofix-context.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/script-autofix-context.ts) and [src/dashboard/script-edge-repair.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/script-edge-repair.ts).
- Validation tightened in [src/loop/v3/closure-engine.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/closure-engine.ts), with related guidance updates in [src/loop/v3/skill-registry.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/skill-registry.ts), [src/loop/v3/system-prompt-v3.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/system-prompt-v3.ts), and [src/loop/v3/task-graph.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/task-graph.ts).
- Regression coverage was added in [src/__tests__/compositions-interface.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/compositions-interface.test.ts), [src/__tests__/script-autofix-context.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/script-autofix-context.test.ts), and [src/__tests__/script-edge-repair.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/script-edge-repair.test.ts).
- [package.json](/Users/andrewporter/Documents/GitHub/woodbury/package.json) gained `electron:restart-dev` and [README.md](/Users/andrewporter/Documents/GitHub/woodbury/README.md) was rewritten to match the repo’s current architecture.

#### Why this decision makes sense

- Exposed variable nodes make compositions runnable by people who did not build the graph.
- Graph-aware repair is a better fit than local code-only repair because many failures are really port and wiring mismatches.
- Tightening closure and validation reduces false success during generation and execution.

### Commit `8ed358b`
### Add retrospective change log for March 5-12

#### What changed

- Added the broader retrospective at [docs/change-log-2026-03-05-to-2026-03-12.md](/Users/andrewporter/Documents/GitHub/woodbury/docs/change-log-2026-03-05-to-2026-03-12.md).
- Updated [docs/README.md](/Users/andrewporter/Documents/GitHub/woodbury/docs/README.md) so the retrospective is discoverable.

#### Why this decision makes sense

- The repo had accumulated enough architectural motion that a retrospective became useful working documentation, not just release notes.

### Commit `b30cec5`
### Add dashboard image to README

#### What changed

- [README.md](/Users/andrewporter/Documents/GitHub/woodbury/README.md) now embeds a dashboard screenshot.

#### Why this decision makes sense

- The product is now heavily dashboard-centric, so a visual improves onboarding and makes the current product surface easier to understand quickly.

### Commit `f70c9e6`
### Add README dashboard image asset

#### What changed

- Added the screenshot asset at [images/unnamed.png](/Users/andrewporter/Documents/GitHub/woodbury/images/unnamed.png).

#### Why this decision makes sense

- This is the supporting asset for the README update and keeps the visual documentation self-contained in the repo.

### Commit `1978192`
### Improve pipeline generation and Monaco script editing

#### What changed

- Monaco editor support was added in [src/config-dashboard/monaco-editor.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/monaco-editor.js), [src/config-dashboard/index.html](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/index.html), [src/config-dashboard/compositions-properties.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-properties.js), [src/config-dashboard/styles.css](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/styles.css), [src/dashboard/middleware.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/middleware.ts), [src/dashboard/utils.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/utils.ts), and [package.json](/Users/andrewporter/Documents/GitHub/woodbury/package.json).
- Pipeline generation got stricter route-level validation and deterministic script testing in [src/dashboard/routes/generation.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/generation.ts), [src/dashboard/script-generation-tests.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/script-generation-tests.ts), [src/__tests__/generation-route.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/generation-route.test.ts), and [src/__tests__/script-generation-tests.test.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/__tests__/script-generation-tests.test.ts).
- Composition authoring UX continued to improve in [src/config-dashboard/compositions-core.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-core.js), [src/config-dashboard/compositions-canvas.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-canvas.js), [src/config-dashboard/compositions-execution.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/compositions-execution.js), and [src/config-dashboard/assets.js](/Users/andrewporter/Documents/GitHub/woodbury/src/config-dashboard/assets.js).
- The dashboard asset route in [src/dashboard/routes/assets.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/dashboard/routes/assets.ts) made full `collections` replacement behavior explicit.
- Planner and skill-routing behavior was extended in [src/loop/v3/skill-registry.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/skill-registry.ts) and [src/loop/v3/strategic-planner.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/strategic-planner.ts).

#### Why this decision makes sense

- Monaco is the right editing surface once script nodes become a primary composition tool.
- Deterministic validation is necessary if pipeline generation is going to be trusted instead of merely accepted.
- Asset collection semantics needed to be made explicit because collection-root paths depend on primary collection order.

## Working Tree Follow-Up

These changes were present in the working tree when this log was written and may not yet be reflected in git history.

- [docs/dashboard-api.md](/Users/andrewporter/Documents/GitHub/woodbury/docs/dashboard-api.md) now documents that dashboard asset updates replace the full `collections` array and explains the related runtime `asset_update` semantics.
- [src/loop/v3/skill-registry.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/skill-registry.ts) now teaches the `woodbury_builtin_concepts` skill to distinguish dashboard API behavior from creator-assets runtime behavior and to account for `collection_root` primary-path resolution.
- [src/loop/v3/system-prompt-v3.ts](/Users/andrewporter/Documents/GitHub/woodbury/src/loop/v3/system-prompt-v3.ts) now includes a `Woodbury Contracts` section so the compact v3 prompt carries these distinctions by default.
- Outside the repo, the installed creator-assets runtime extension at `/Users/andrewporter/.woodbury/extensions/creator-assets/index.js` was updated so `asset_update` supports `collections`, `move_to_collection`, and `remove_collection` in addition to append-style `collection` updates.

## Net Effect

By the end of March 12, Woodbury was stronger in three specific ways:

- Pipelines were easier to expose and run as products instead of editor-only artifacts.
- Script and generation failures were being handled with more structure and less guesswork.
- Asset collection behavior was described more precisely across the dashboard, agent guidance, and runtime tooling.