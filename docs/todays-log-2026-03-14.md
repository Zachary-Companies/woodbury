# Woodbury Change Log

Date: 2026-03-14

Scope: commit `5ac3c1d` — 25 files changed, ~8,350 lines added, ~800 removed.

## Executive Summary

March 14 delivered seven areas of improvement in a single large commit:

1. **Contract-driven pipeline decomposition** — pipeline generation now decomposes tasks into sub-contracts at interface boundaries before generating nodes, producing more focused pipelines with precisely typed ports.
2. **Per-node script pre-planning** — a structured planning step runs before code generation for each script node, producing a `ScriptPrePlan` with intent, ports, tools, algorithm, and edge cases.
3. **Generation progress indicators** — all generation modals now show a progress bar with phased status text instead of a static spinner.
4. **Pipeline sidebar timestamps** — each pipeline item in the sidebar displays a relative timestamp (e.g. "2h ago", "Mar 5") from composition metadata.
5. **Pipeline documentation system** — auto-generated Markdown documentation for pipelines, stored on the composition and viewable in a new overview panel.
6. **Composition interface contracts** — new module that extracts typed input/output interface contracts from compositions for form inputs and batch execution.
7. **Rich port presentation metadata** — new `PortPresentationConfig` type system for controlling how pipeline outputs render in the results UI.

---

## 1. Contract-Driven Pipeline Decomposition

**Files:**
- `src/dashboard/routes/generation.ts` — `PipelineSubContract`, `PipelineDecompositionPlan` interfaces; `validateDecompositionPlan()`, `formatDecompositionPlanForPipelinePrompt()`, `generatePipelineDecompositionPlan()` functions.
- `src/__tests__/generation-route.test.ts` — 8 new tests for decomposition validation, circular dependency detection, source reference checking, formatting, and fallthrough.

**What changed:**
- Added a Phase 1 decomposition step before pipeline structure generation. A new LLM call analyzes the user's task description and identifies the target output structure, then breaks it into sub-contracts at interface boundaries — each sub-contract becomes a pipeline node with precisely typed ports.
- `validateDecompositionPlan()` checks for valid source references, detects circular dependencies via topological sort, and normalizes the plan structure.
- `formatDecompositionPlanForPipelinePrompt()` serializes the plan into a constraint section that's injected into the pipeline generation system prompt.
- The decomposition plan is included in the API response as an optional `decompositionPlan` field for downstream use (e.g., documentation generation).
- Falls through gracefully if the decomposition call fails — existing behavior is preserved.

**Why:**
- The pipeline generator previously decomposed tasks by procedural steps ("Step 1: parse, Step 2: call API, Step 3: save"), which produced nodes that were either too coarse or too procedural. Interface-first decomposition ensures each node owns a specific sub-structure of the output, with precisely typed port contracts rather than vague "output: object" declarations.
- Simple tasks get 1-2 sub-contracts; complex tasks (like a screenwriting document with 30+ interfaces) get many — same strategy, different granularity.

---

## 2. Per-Node Script Pre-Planning

**Files:**
- `src/dashboard/routes/generation.ts` — `ScriptPrePlan` interface, `generateScriptPrePlan()`, `formatPrePlanForPrompt()` functions; wired into `runScriptGenerationWithClosureEngine()`.
- `src/config-dashboard/compositions-properties.js` — amber color for plan stage in transcript UI; updated transcript description text.
- `src/__tests__/generation-route.test.ts` — 7 tests for pre-plan generation, validation, formatting, and injection.

**What changed:**
- Before generating code for a script node, a structured `ScriptPrePlan` is produced via a dedicated LLM call. The plan captures: intent restatement, proposed input/output ports with types, tools to use, step-by-step algorithm, and edge cases.
- The plan is formatted and injected into the code generation system prompt so the generator follows a precise recipe.
- The plan stage is recorded in the generation transcript with amber color coding in the UI.
- Falls through gracefully if planning fails.

**Why:**
- Code generation without planning often produced code that misunderstood the task scope or invented incorrect port names. The pre-plan gives the generator a clear, structured brief.
- Combined with pipeline decomposition, each node's plan operates on a well-scoped sub-problem rather than the entire task.

---

## 3. Generation Progress Indicators

**Files:**
- `src/config-dashboard/compositions-canvas.js` — replaced static spinner HTML and added phased timer logic in pipeline generation, script generation, and data transform script modals.
- `src/config-dashboard/compositions-properties.js` — progress bar and phase timers for the properties panel script chat; `startScriptChatPhaseTimers()` and cleanup in `clearCompScriptGenerationState()`.

**What changed:**
- All three generation modals (pipeline, script, data transform script) now show a 4px progress bar with a purple gradient and rotating phase text instead of a tiny 14×14px spinner with static text.
- Pipeline generation phases: "Analyzing task structure..." → "Decomposing into sub-contracts..." → "Generating pipeline nodes..." → "Generating code..." → "Validating and repairing..." → "Almost done..."
- Script generation phases: "Planning approach..." → "Generating script code..." → "Validating code..." → "Running tests and repairs..." → "Finalizing..."
- Progress bar fills to 100% on success and resets on error. All timers are cleaned up properly.
- The properties panel chat also uses the progress bar pattern, with timers managed via a per-node timer store.

**Why:**
- Pipeline generation can take 30-60+ seconds for complex tasks (decomposition + structure + per-node code generation). A static spinner gave no sense of progress. The phased progress bar shows which stage the backend is working through.

---

## 4. Pipeline Sidebar Timestamps

**Files:**
- `src/config-dashboard/compositions-core.js` — new `formatRelativeTime()` helper; updated `renderTreeItem()` to show timestamps.

**What changed:**
- Each pipeline item in the sidebar now shows a relative timestamp below the name: "just now", "5m ago", "2h ago", "3d ago", or "Mar 5" for older items.
- Uses `metadata.updatedAt` (falls back to `metadata.createdAt`), which are already stored in every composition file and sent to the frontend.
- Hovering the timestamp shows the full date/time as a tooltip.
- The tree item layout wraps the name and timestamp in a flex-column div with the icon aligned to the top.

**Why:**
- The sidebar previously showed only pipeline names with no temporal context. Users couldn't tell which pipelines were recently worked on versus old experiments.

---

## 5. Pipeline Documentation System

**Files:**
- `src/dashboard/pipeline-documentation.ts` (322 lines) — new module for generating Markdown documentation from pipeline structure, decomposition plans, and interface contracts.
- `src/config-dashboard/compositions-overview.js` (186 lines) — new frontend module for rendering generated documentation with Markdown viewer, metadata badges, and management controls.
- `src/workflow/types.ts` — `CompositionGeneratedPipelineDoc` interface added to `CompositionDocument.metadata`.

**What changed:**
- Pipelines can now have auto-generated Markdown documentation stored on the composition's metadata as `generatedPipelineDocs`.
- The documentation module produces structured docs covering: pipeline summary, node descriptions, port contracts, connections, and the decomposition plan that produced the pipeline.
- The overview UI renders these docs with a Markdown viewer, showing creation timestamps and source request context.

**Why:**
- Complex pipelines with many nodes were hard to understand at a glance. Auto-generated documentation captures the pipeline's intent, structure, and contracts in a readable format that persists with the composition.

---

## 6. Composition Interface Contracts

**Files:**
- `src/dashboard/composition-interface.ts` (332 lines) — new module that extracts typed input/output interface contracts from compositions.
- `src/dashboard/routes/compositions.ts` — refactored to use the interface module; ~200 lines of inline logic moved to the new module.

**What changed:**
- New `CompositionInterfaceInput` and `CompositionInterfaceOutput` types define the external contract of a composition (what inputs it needs, what outputs it produces).
- The module infers input ports from all node types: script nodes, junction nodes, branch nodes, delay nodes, gate nodes, form inputs, and text nodes.
- It identifies output ports from terminal script nodes (nodes with no downstream consumers).
- The compositions route handler was refactored to delegate interface extraction to this module.

**Why:**
- Form inputs, batch execution, and pipeline-as-skill features all need to understand a composition's external interface. Extracting this into a dedicated module avoids duplicating inference logic across multiple call sites.

---

## 7. Rich Port Presentation Metadata

**Files:**
- `src/workflow/types.ts` — new `PortPresentationConfig` interface with 15+ fields; `presentation` field added to `PortDeclaration`.
- `src/config-dashboard/compositions-execution.js` — ~830 lines added including `clientValidateRunGraph()`, enhanced run results rendering, and deep inspector support.
- `src/config-dashboard/index.html` — dashboard layout and navigation updates.
- `src/config-dashboard/styles.css` — ~810 lines of new CSS for rich result rendering, cards, galleries, media viewers, and deep inspectors.

**What changed:**
- `PortPresentationConfig` allows script nodes to declare how their outputs should render: `view` (document, gallery, media, cards, json, markdown), `mediaType`, `titleField`, `subtitleField`, `mediaField`, `fields`, `sectionOrder`, `filterFields`, and section-specific overrides.
- The execution UI gained client-side graph validation (`clientValidateRunGraph()`) that checks for dangling edges, cycles, and missing connections before running.
- Run results rendering was significantly enhanced with support for rich cards, media viewers, deep object inspectors, and gallery layouts.

**Why:**
- Pipeline outputs were previously rendered as raw JSON. For pipelines that produce structured documents, media assets, or card-like data, the presentation config lets node authors control the output experience without modifying the execution engine.

---

## Additional Changes

- **`src/dashboard/script-generation-tests.ts`** — ~198 lines of new test infrastructure for script generation validation.
- **`src/__tests__/composition-run-topology.test.ts`** (28 lines) — tests for client-side topology validation.
- **`src/__tests__/script-generation-benchmark.test.ts`** (87 lines) — benchmark test scaffolding.
- **`src/__tests__/script-generation-tests.test.ts`** — 115 lines of new tests.
- **`src/config-dashboard/compositions-generation.js`** (232 lines) — refactored pipeline generation modal into its own module.
- **`docs/pipeline-generation-runbook.md`** — updated runbook reflecting the new decomposition flow.

---

## Validation

- `npm run build` — TypeScript compilation passed.
- `npx jest src/__tests__/generation-route.test.ts` — all 25 tests passed (10 existing + 7 pre-plan + 8 decomposition).
- No regressions in other test suites.

---

## Net Effect

By end of day March 14, Woodbury's pipeline generation evolved from a single-pass "describe → generate nodes" flow to a multi-phase architecture:

```
User describes task
    → Phase 1: decompose into sub-contracts at interface boundaries
    → Phase 2: generate pipeline nodes aligned with sub-contracts
    → Per-node: plan each small sub-problem
    → Per-node: generate code
    → Per-node: validate + repair + test
```

The UI now provides visible progress through these phases, sidebar items show temporal context, and generated pipelines can carry auto-generated documentation and rich output presentation metadata.
