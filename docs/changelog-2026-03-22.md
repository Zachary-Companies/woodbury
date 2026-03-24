# Changelog — 2026-03-22

## Workflow Engine Extensions

Major expansion of the workflow step type system, a new agent tool for building workflows, and a refreshed chat UI.

### Added

- **New workflow step types** — `http_request` (fetch URLs and store responses in variables), `eval` (run JavaScript expressions with access to workflow variables), `extract_structured` (parse JSON, regex groups, or split strings from variables), and `parallel` (run multiple step branches concurrently with optional fail-fast).

- **New variable sources** — `json_parse` (parse a JSON string variable into an object) and `expression` (evaluate a JS expression against the variables bag) added to `set_variable` steps.

- **`element_focused` assert condition** — Workflows can now assert that a specific element has focus, checking the active element's tag, role, and ARIA label against the target.

- **`forceNativeTyping` option on type steps** — Bypasses the bridge `set_value` approach and types via robotjs native keyboard events. Activates the browser window first (macOS/Windows/Linux). Includes character-by-character fallback if `typeString` fails.

- **`workflow_build` agent tool** (`src/loop/tools/workflow-build.ts`) — Lets Claude construct `.workflow.json` files from live browser interactions. Actions: `create`, `inspect_element`, `add_steps`, `finalize`, `test`. Talks to the dashboard API to persist and validate workflows.

- **System prompt: workflow compilation guidance** — New section in `system-prompt.ts` teaching the agent how to compile browser automation into reusable workflows with ARIA-based targeting.

- **Documentation** — `docs/workflow-authoring-guide.md` (Learn → Build → Ship playbook) and `docs/aria-targeting-reference.md` (complete ElementTarget interface and step type reference).

- **Tests** — `src/__tests__/workflow-step-extensions.test.ts` covering the new step types.

- **`folder-select` input control** — New `inputControl` option for pipeline variable nodes that renders a text input with a browse button for OS folder selection.

### Changed

- **Chrome extension: `click_element`** — Now prefers visible elements when multiple match a selector (skips `visibility:hidden`, `display:none`, `opacity:0`). Simplified to use `.click()` with `focus()` instead of dispatching raw mouse events. Same visibility logic applied to `set_value`.

- **Chrome extension: new actions** — `hover_element` (dispatches mouseenter/mouseover/mousemove for submenu triggering) and `evaluate` (run arbitrary JS expressions in page context).

- **`nativeType` fallback** — If robotjs `typeString` throws, falls back to character-by-character `keyTap` with shift handling for uppercase.

- **`activateBrowser()` helper** — Cross-platform (macOS osascript, Windows PowerShell, Linux wmctrl/xdotool) method to bring Chrome to the foreground before native keyboard input.

- **Chat UI: tool call display** — Replaced pill-style tool call cards with compact inline tool lines showing a status icon, humanized tool name, parameter summary (file path, selector, URL, etc.), and duration. Collapsed by default; click to expand and see full params/result.

- **Chat UI: role labels** — Lowercased from "You"/"Woodbury" to "you"/"woodbury".

- **Chat UI: send button** — Now shows ↑ (idle) / ⏳ (sending) instead of "Send"/"Working...".

## Dashboard Fixes

### Fixed

- **Default view selection** (`b5978f9`, `e0a5dc9`) — Default view now waits for `discoveredViews` to load before selecting, preventing Settings from being chosen as default during initial render. Uses a ref flag to set the default exactly once.

- **Sidebar headers overlapping macOS traffic lights** (`dccbbd9`) — Added 2.75rem top padding to `.sidebar-header` and `.app-sidebar-header` so titles clear the close/minimize/maximize buttons. Works in both Electron and browser contexts.

- **Agent Workspace hidden by default** (`40735b9`) — Chat view now shows only the conversation panel at full width. Agent Workspace (phase, tasks, checks, session context) is toggled via a button in the chat header.
