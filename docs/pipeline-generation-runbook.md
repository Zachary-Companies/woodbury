# Pipeline Generation Runbook

Last updated: 2026-03-11

This runbook is for diagnosing cases where Woodbury chat says a reusable pipeline exists, but the real artifact is missing, malformed, undiscoverable, or not actually verified.

Use this after any suspicious pipeline-generation outcome.

## 1. Symptoms

Common user-visible symptoms:

- chat claims a pipeline was created but it does not appear in the dashboard
- the composition file exists on disk but `GET /api/compositions` does not list it
- the composition appears, but a script node fails immediately
- generation returned plausible JSON, but the artifact is not executable
- the assistant answer describes a pipeline confidently with no corresponding saved artifact

## 2. Triage Questions

Start with these questions in order:

1. Was there a real generation tool result or only prose?
2. Did the result contain a real composition id or saved artifact?
3. Was the artifact written to a discoverable `.composition.json` location?
4. Was composition cache invalidated after save?
5. Does the composition pass structural validation?
6. Is there any concrete discoverability or execution evidence?

If the answer to any of those is no, the pipeline is not complete.

## 3. Fast Path Diagnosis

### 3.1 No Real Artifact

Indicators:

- no `composition_updated` event
- no composition id in tool output
- only descriptive assistant prose

Interpretation:

- generation did not produce a real saved composition

Action:

- treat as generation failure, not success
- retry generation with tighter constraints or report the exact failure

### 3.2 File Exists But Dashboard Cannot See It

Indicators:

- `.composition.json` exists on disk
- `GET /api/compositions` does not show it

Interpretation:

- composition discovery cache is stale

Action:

- confirm the save path is discoverable
- confirm `invalidateCompositionCache()` ran after mutation

### 3.3 Discoverable But Structurally Broken

Indicators:

- composition loads and appears in the dashboard
- validation reports malformed script code, bad workflow references, or edge/port issues

Interpretation:

- generation succeeded only partially

Action:

- do not declare success
- regenerate or repair until validation is clean

### 3.4 Structurally Valid But Runtime Fails

Indicators:

- static validation passes
- composition run fails at execution time

Interpretation:

- runtime logic, external dependencies, or prompt assumptions are still wrong

Action:

- inspect the failing node class
- separate code bugs from environment or provider failures
- report verification status precisely

## 4. Failure Classes

### 4.1 False Success By Prose

Cause:

- assistant narrative outran the real tool result

Required guardrail:

- no success claim without artifact and evidence

### 4.2 Stale Discoverability

Cause:

- composition registry cache not invalidated after write

Required guardrail:

- invalidate composition cache after auto-save and composition mutations

### 4.3 Malformed Script Nodes

Cause:

- generation emitted markdown, JSON-wrapped code, or syntactically invalid JavaScript

Required guardrail:

- validate `__script__` node code before success is reported

### 4.4 Incomplete Verification

Cause:

- artifact was generated and maybe validated, but not smoke-tested or read back through live discovery

Required guardrail:

- make verification a distinct lifecycle stage, not an implicit assumption

## 5. Minimal Recovery Procedure

When a generated pipeline is suspect, use this sequence:

1. Confirm whether a real composition artifact exists.
2. Confirm whether discovery can see it.
3. Run structural validation.
4. Repair or regenerate malformed nodes.
5. Re-check discovery after any save.
6. Attempt the lightest viable smoke execution.
7. Report exactly what is verified and what is still blocked.

## 6. Evidence To Capture

When writing a bug report or diagnosing a trust failure, capture:

- user request
- selected lifecycle stage or skill
- intelligence tool called
- raw generation result summary
- composition id
- save location
- discovery result from `/api/compositions`
- validation issues
- smoke-test result
- final assistant claim

This makes it possible to distinguish between generation, save, discovery, validation, and execution failures.

## 7. Concrete Checks

Useful checks include:

- inspect the generation tool result for a real `id`
- inspect `GET /api/compositions`
- inspect `GET /api/compositions/:id/interface`
- inspect structural validation output
- run `POST /api/compositions/:id/run` with the lightest viable sample inputs

## 8. What To Tell The User

Preferred language when the system is not fully verified:

- "The composition was generated and saved, but validation found issues in node X."
- "The file exists, but the dashboard registry is stale, so it is not yet discoverable."
- "The composition is discoverable and structurally valid, but runtime verification has not been completed yet."

Avoid language like:

- "It's done" when only generation happened
- "It was created" when no discoverable artifact exists
- "It works" when no execution evidence exists

## 9. Related Docs

- [pipeline-lifecycle-contract.md](pipeline-lifecycle-contract.md)
- [composition-schema-and-validation.md](composition-schema-and-validation.md)
- [chat-api-and-sse-contract.md](chat-api-and-sse-contract.md)