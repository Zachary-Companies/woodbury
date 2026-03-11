# Composition Schema And Validation

Last updated: 2026-03-11

This document describes what a Woodbury composition artifact is, where it lives, how it is discovered, and what validation rules matter before it can be treated as usable.

This is not a full generated TypeScript API dump. It is the operational contract that matters for saved `.composition.json` artifacts and the systems that load, validate, discover, and execute them.

## 1. Artifact Identity

A composition is a reusable pipeline artifact represented as a directed acyclic graph.

Minimum required top-level fields:

- `version`
- `id`
- `name`
- `nodes`
- `edges`

Current document type:

```ts
interface CompositionDocument {
  version: '1.0';
  id: string;
  name: string;
  description?: string;
  folder?: string;
  nodes: CompositionNode[];
  edges: CompositionEdge[];
  metadata?: {
    createdAt: string;
    updatedAt: string;
    viewport?: { panX: number; panY: number; zoom: number };
  };
}
```

Source of truth in code:

- `src/workflow/types.ts`
- `src/workflow/loader.ts`
- `src/dashboard/routes/composition-run.ts`
- `src/loop/v3/closure-engine.ts`

## 2. Storage And Discovery

Compositions are discovered from:

- project-local: `.woodbury-work/workflows/*.composition.json`
- global user: `~/.woodbury/workflows/*.composition.json`

Discovery behavior:

- discovery is cached in memory
- the cache is reused until explicitly invalidated
- writing a file alone is not enough if the cache is still stale

Operational implication:

- after a composition mutation, `invalidateCompositionCache()` must be called
- otherwise the dashboard may fail to list a real composition that exists on disk

## 3. Node Model

Each composition node has:

- a stable `id`
- a `workflowId`
- a `position`
- optional node-type-specific config

Common node categories:

- real workflow references
- built-in nodes such as `__script__`, `__output__`, `__branch__`, `__delay__`, `__for_each__`
- tool-backed nodes
- sub-pipeline references

Minimal structural shape:

```ts
interface CompositionNode {
  id: string;
  workflowId: string;
  position: { x: number; y: number };
  label?: string;
  inputOverrides?: Record<string, unknown>;
  expectations?: Expectation[];
  onFailure?: NodeFailurePolicy;
  script?: ScriptNodeConfig;
  outputNode?: OutputNodeConfig;
  toolNode?: ToolNodeConfig;
  compositionRef?: { compositionId: string };
}
```

## 4. Edge Model

Edges connect source node outputs to target node inputs.

The practical requirements are:

- `sourceNodeId` must exist
- `targetNodeId` must exist
- if `sourcePort` is specified and the source node declares output ports, that port must exist
- if `targetPort` is specified and the target node declares input ports, that port must exist

An edge that references a non-existent node or port is structurally invalid.

## 5. `__script__` Nodes

`__script__` nodes are the most common generated node type in AI-created pipelines.

Required shape:

```ts
interface ScriptNodeConfig {
  description: string;
  code: string;
  inputs: PortDeclaration[];
  outputs: PortDeclaration[];
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

Required operational rules:

- `code` must not be empty
- `code` must be raw executable JavaScript
- `code` must not be wrapped in markdown fences
- `code` must not be a serialized JSON blob masquerading as code
- `code` must define `execute(...)`
- `code` must compile successfully
- `inputs` and `outputs` must be arrays when present

Common bad payloads that must be rejected:

- fenced code blocks
- JSON objects masquerading as code payloads
- partial function bodies with no `execute` wrapper
- malformed escaped strings that do not compile

## 6. Validation Layers

There are multiple validation layers in the system.

### 6.1 Loader Validation

`src/workflow/loader.ts` enforces basic document shape:

- required top-level fields exist
- `nodes` is an array
- `edges` is an array

This prevents obviously malformed artifacts from loading, but it is not enough to prove executability.

### 6.2 Closure Engine Validation

`src/loop/v3/closure-engine.ts` performs higher-level validation on generated compositions.

Current checks include:

- non-existent workflow references
- empty script code
- fenced markdown in script code
- serialized JSON blobs in script code
- missing `execute(...)` definition
- JavaScript compilation failures
- malformed `inputs` or `outputs`
- non-existent source or target nodes
- source/target port mismatches
- completely disconnected nodes

This validation exists to stop false success claims after generation.

### 6.3 Runtime Validation

`src/dashboard/routes/composition-run.ts` is the final truth for executability.

Even a structurally valid composition may still fail at runtime because of:

- bad prompts
- missing environment variables
- external API failures
- bad assumptions in script node logic
- incompatible upstream/downstream data

Passing static validation is necessary but not sufficient.

## 7. What Counts As A Valid Generated Composition

A generated composition should be treated as acceptable only when all of these are true:

- loader can parse it
- discovery can surface it
- validation finds no blocking structural issues
- script nodes compile
- declared ports are internally consistent
- referenced workflows actually exist or use supported built-in node types

If any of those fail, the correct state is "generated but not complete," not success.

## 8. Discoverability Contract

The system must distinguish between these states:

- planned only
- generated but not saved
- saved on disk but not discoverable due to stale registry state
- discoverable but structurally invalid
- discoverable and structurally valid
- discoverable, valid, and executable

The user should only hear "created" or "done" for the last two, and ideally only after executable verification.

## 9. Recommended Review Checklist

When reviewing a generated composition, check:

1. Does the artifact have `version`, `id`, `name`, `nodes`, and `edges`?
2. Is it saved as a `.composition.json` file in a discoverable location?
3. Was composition cache invalidated after save?
4. Are all nodes and edges internally consistent?
5. Do all `__script__` nodes contain real executable code?
6. Do all referenced workflows actually exist?
7. Has runtime execution been attempted or explicitly deferred with a reason?

## 10. Related Docs

- [pipeline-lifecycle-contract.md](pipeline-lifecycle-contract.md)
- [pipeline-generation-runbook.md](pipeline-generation-runbook.md)
- [dashboard-api.md](dashboard-api.md)
- [architecture.md](architecture.md)