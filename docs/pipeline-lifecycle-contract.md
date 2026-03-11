# Pipeline Lifecycle Contract

Last updated: 2026-03-11

This document defines the contract for reusable pipeline generation in Woodbury's v3 closure engine.

It exists to prevent a recurring failure mode: the model calls a generation tool once, gets something that looks plausible, and then claims success before the saved artifact is structurally valid, discoverable in the dashboard, or runnable.

The contract is simple:

1. Design the graph contract.
2. Generate a real saved composition.
3. Validate and repair the generated artifact.
4. Verify discoverability and executable behavior.

Generation alone is never completion.

---

## 1. Scope

This contract applies when the user asks for a reusable multi-step automation, including requests phrased as:

- build a pipeline
- create a workflow
- automate this process
- make a reusable composition
- fix or update an existing saved pipeline

This contract does not apply to one-off execution requests where the user only wants a result now and does not need a saved reusable artifact.

---

## 2. Core Invariants

For a pipeline request to count as complete, all of the following must be true:

- A real composition artifact exists, not just a verbal description.
- The artifact is saved in a location the dashboard can discover.
- The composition passes structural validation.
- Any `__script__` nodes contain executable JavaScript, not markdown or serialized JSON blobs.
- The agent has concrete evidence of discoverability and some level of executable verification.
- If verification could not be completed, the agent must say exactly what remains unverified.

The agent must never claim a pipeline was created if it only has a plan, partial JSON, or an unverified generation response.

---

## 3. Lifecycle Stages

### 3.1 `pipeline_design`

Purpose:
Turn user intent into an explicit graph plan before any generation call.

Required output:

- major stages or nodes
- responsibility of each node
- expected inputs and outputs
- interface contract for the overall composition
- any real workflow dependencies that must exist already

Completion standard:

- the design is specific enough that a generator can produce the composition without inventing core architecture
- the model is not yet claiming that a pipeline exists

Failure mode to avoid:

- jumping straight into generation with an underspecified request and then accepting whatever comes back

### 3.2 `pipeline_generate`

Purpose:
Call the intelligence generation tools with tight constraints and produce the initial saved composition.

Preferred tools:

- `mcp__intelligence__generate_pipeline`
- `mcp__intelligence__generate_workflow`
- `mcp__intelligence__compose_tools`

Required output:

- a real composition result with an id or saved artifact
- enough detail to identify the created composition in the dashboard

Completion standard:

- generation returned a concrete saved artifact or an explicit tool failure

Failure mode to avoid:

- falling back to `workflow_execute`, `workflow_play`, ad-hoc file mutation, or shell-driven manual pipeline creation when the user asked for a reusable pipeline

### 3.3 `pipeline_validate_and_repair`

Purpose:
Reject malformed generated artifacts before the model can present them as done.

Minimum checks:

- composition JSON parses
- required composition fields exist
- every edge references real nodes
- edge ports match declared script inputs and outputs when available
- `__script__` nodes have non-empty code
- script code is raw executable JavaScript
- script code is not wrapped in markdown fences
- script code is not a serialized JSON blob
- script code defines `execute(...)`
- script code compiles successfully
- referenced workflow ids exist unless the node is a built-in node type

Repair rule:

- if validation fails, the artifact is not complete
- repair should prefer regeneration or tool-assisted correction paths over silent acceptance
- the final user-facing answer must carry validation findings if the artifact is still broken

Failure mode to avoid:

- accepting a generated composition that only fails later at runtime

### 3.4 `pipeline_verify`

Purpose:
Confirm the artifact is visible and usable, not merely valid JSON.

Verification targets:

- discoverability: the composition appears through composition discovery or dashboard APIs
- executability: the lightest viable smoke test succeeds, or a precise blocker is reported

Acceptable verification evidence:

- composition is returned by `GET /api/compositions`
- composition interface can be read back from `GET /api/compositions/:id/interface`
- smoke execution succeeds through `POST /api/compositions/:id/run`
- a focused executable check confirms the graph can run with sample inputs

Completion standard:

- the agent has concrete evidence that the artifact exists and is usable
- if smoke execution is not possible, the answer must say what was verified and what remains unverified

Failure mode to avoid:

- treating dashboard visibility alone as proof that the pipeline works

---

## 4. Artifact Requirements

Saved compositions are expected to be discoverable by Woodbury through the standard composition locations and APIs.

Practical requirements:

- the composition must have a stable `id`
- it must be saved as a `.composition.json` artifact
- cache invalidation must occur after auto-save so the dashboard can discover the new artifact immediately

The existence of a file on disk is not enough if the live composition registry still does not surface it.

---

## 5. Required Evidence Before Claiming Success

The final answer for a pipeline request should be backed by evidence from each layer:

- Design evidence: what the graph is supposed to do
- Generation evidence: what artifact was actually created
- Validation evidence: why the artifact is structurally acceptable
- Verification evidence: why the artifact is discoverable and runnable

At minimum, the model should be able to answer these questions truthfully:

- What is the composition id?
- Where does the dashboard discover it?
- What validation checks passed?
- What execution or smoke-test evidence exists?
- What is still uncertain, if anything?

---

## 6. Anti-Patterns

These behaviors violate the contract:

- claiming success immediately after `generate_pipeline`
- describing a pipeline as if it exists when only a plan exists
- using execution tools as a substitute for creation tools
- manually browsing files to pretend a composition was created
- accepting fenced markdown or JSON-wrapped blobs as script code
- skipping verification because the generated structure "looks right"
- reporting a pipeline as complete when discoverability is stale due to cache state

---

## 7. Relationship To The V3 Closure Engine

The current v3 behavior is expected to map pipeline requests into these four skills:

- `pipeline_design`
- `pipeline_generate`
- `pipeline_validate_and_repair`
- `pipeline_verify`

Planner handoffs should move sequentially through those stages.

Downstream stages must receive enough upstream context to act on prior outputs. In practice, this means validation and verification stages need access to recent completed-task outputs, not just the original user request.

---

## 8. Operational Checklist

Use this checklist when reviewing pipeline-generation behavior:

1. Did the planner choose the four-stage lifecycle instead of a single generic task?
2. Did generation return a real saved composition artifact?
3. Did validation catch malformed script code, missing ports, missing nodes, or bad workflow references?
4. Was composition discoverability confirmed through the live registry or dashboard API?
5. Was at least one smoke execution step attempted or explicitly ruled out with a concrete reason?
6. Did the final answer clearly separate verified facts from remaining uncertainty?

If any answer is no, the pipeline should not be considered complete.

---

## 9. Recommended Future Extensions

The contract above is the minimum useful standard. Future improvements can harden it further:

- formal composition schema documentation
- stricter static validation for built-in node types beyond `__script__`
- automated end-to-end tests for chat-driven pipeline creation
- richer verification policies based on composition class and risk

Until then, this lifecycle contract is the source of truth for what counts as a successful reusable pipeline outcome.