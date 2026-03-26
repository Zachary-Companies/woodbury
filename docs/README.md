# Woodbury Docs Map

Last updated: 2026-03-26

This directory contains the working documentation set for Woodbury.

The goal is not to document every file. The goal is to document the contracts, boundaries, APIs, invariants, and operational runbooks that keep the system understandable for both humans and LLMs.

## Core References

- [architecture.md](architecture.md)
  High-level system layout, major subsystems, data flow, and storage model.

- [conventions.md](conventions.md)
  Codebase conventions, dashboard route patterns, file organization, and naming rules.

- [dashboard-api.md](dashboard-api.md)
  Dashboard HTTP endpoints and request/response shapes (265+ endpoints across 30 route modules).

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

- [pipeline-views.md](pipeline-views.md)
  React view architecture for pipelines: file structure, SDK hooks, manifest format, build system, and view registration.

- [pipeline-extensions.md](pipeline-extensions.md)
  Pipeline extension system for adding custom node types and behaviors.

- [pipeline-screenplay-generator.md](pipeline-screenplay-generator.md)
  Screenplay-specific pipeline type: Fountain import, character/location extraction, and scene generation.

- [react-frontend-integration.md](react-frontend-integration.md)
  Data flow from pipeline outputs to domain JSON files and the React frontend.

- [provider-data-management.md](provider-data-management.md)
  Provider data patterns for pipeline domain data management.

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

## Workflows

- [workflow-authoring-guide.md](workflow-authoring-guide.md)
  End-to-end guide for learning, building, testing, and shipping workflows.

- [aria-targeting-reference.md](aria-targeting-reference.md)
  ARIA-based element targeting for resilient workflow selectors.

## Platform-Specific Or Operational Docs

- [electron-entry-point.md](electron-entry-point.md)
  Electron main-process behavior and startup model.

- [BROWSER_INTERACTION_NOTES.md](BROWSER_INTERACTION_NOTES.md)
  Browser bridge, interaction caveats, and troubleshooting.

- [search-capabilities.md](search-capabilities.md)
  Search tool behavior and supported search surfaces.

- [releasing.md](releasing.md)
  Release and packaging workflow.

- [react-migration-plan.md](react-migration-plan.md)
  Status and plan for migrating dashboard UI components to React.

## Changelogs

- [change-log-2026-03-05-to-2026-03-12.md](change-log-2026-03-05-to-2026-03-12.md)
  Retrospective covering March 5 through March 12, 2026.

- Daily changelogs: [03-19](changelog-2026-03-19.md), [03-20](changelog-2026-03-20.md), [03-21](changelog-2026-03-21.md), [03-22](changelog-2026-03-22.md), [03-24](changelog-2026-03-24.md), [03-25](changelog-2026-03-25.md), [03-26](changelog-2026-03-26.md)

- Daily logs: [03-12](todays-log-2026-03-12.md), [03-13](todays-log-2026-03-13.md), [03-14](todays-log-2026-03-14.md), [03-15](todays-log-2026-03-15.md), [03-16](todays-log-2026-03-16.md), [03-17](todays-log-2026-03-17.md), [03-18/19](todays-log-2026-03-18-19.md)

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