# Woodbury Docs Map

Last updated: 2026-03-12

This directory contains the working documentation set for Woodbury.

The goal is not to document every file. The goal is to document the contracts, boundaries, APIs, invariants, and operational runbooks that keep the system understandable for both humans and LLMs.

## Core References

- [architecture.md](architecture.md)
  High-level system layout, major subsystems, data flow, and storage model.

- [conventions.md](conventions.md)
  Codebase conventions, dashboard route patterns, file organization, and naming rules.

- [dashboard-api.md](dashboard-api.md)
  Dashboard HTTP endpoints and request/response shapes.

## Chat And Agent Loop

- [chat-skills-status.md](chat-skills-status.md)
  Current implementation status of dashboard chat, skill routing, and loop event surface.

- [chat-api-and-sse-contract.md](chat-api-and-sse-contract.md)
  Contract for `POST /api/chat`, session persistence, streamed SSE event types, and client expectations.

## Pipelines And Compositions

- [pipeline-lifecycle-contract.md](pipeline-lifecycle-contract.md)
  Contract for the design -> generate -> validate/repair -> verify lifecycle for reusable pipelines.

- [composition-schema-and-validation.md](composition-schema-and-validation.md)
  Composition artifact shape, discovery model, built-in node rules, and validation requirements.

- [pipeline-generation-runbook.md](pipeline-generation-runbook.md)
  Operational runbook for diagnosing false-success pipeline claims, stale discoverability, malformed script nodes, and incomplete verification.

## Extensions And MCP

- [extensions.md](extensions.md)
  Extension system overview and authoring guidance.

- [extension-api-reference.md](extension-api-reference.md)
  Public extension API surface.

- [extension-development.md](extension-development.md)
  Extension authoring workflow.

- [extension-testing.md](extension-testing.md)
  End-to-end extension validation guidance.

- [mcp-integration-guide.md](mcp-integration-guide.md)
  MCP server integration and discovery behavior.

## Platform-Specific Or Operational Docs

- [electron-entry-point.md](electron-entry-point.md)
  Electron main-process behavior and startup model.

- [BROWSER_INTERACTION_NOTES.md](BROWSER_INTERACTION_NOTES.md)
  Browser bridge, interaction caveats, and troubleshooting.

- [search-capabilities.md](search-capabilities.md)
  Search tool behavior and supported search surfaces.

- [releasing.md](releasing.md)
  Release and packaging workflow.

## Retrospectives

- [change-log-2026-03-05-to-2026-03-12.md](change-log-2026-03-05-to-2026-03-12.md)
  Commit-grounded retrospective covering all changes landed from March 5 through March 12, 2026, with rationale and architectural analysis.

- [todays-log-2026-03-12.md](todays-log-2026-03-12.md)
  Isolated log covering only the March 12, 2026 work, including same-day follow-up contract and runtime-tool updates.

- [todays-log-2026-03-13.md](todays-log-2026-03-13.md)
  Isolated log covering the March 13, 2026 working-tree changes: file-backed memory artifacts, the new skill optimizer surface, script-generation transcripts, and Electron startup hardening.

## What Deserves Documentation In This Repo

If a subsystem has one or more of these properties, it should usually have a dedicated doc:

- It exposes an external API or protocol.
- It persists artifacts or state with a required schema.
- It has cross-file invariants that are easy to break.
- It can fail in ways that create false success signals.
- It acts as a contract boundary between humans, tools, extensions, or models.

## Preferred Doc Types

Use the smallest doc that closes an actual ambiguity:

- Reference: what exists and where.
- Contract: what must be true.
- Runbook: what to do when it fails.
- Status doc: what is true right now but may evolve.

Avoid narrative duplication. If a doc only repeats code comments or another doc, it is probably noise.