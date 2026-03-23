# Workflow Authoring Guide — Learn → Build → Ship

How Claude converts a browser automation task into a reusable workflow that runs at zero token cost.

## The Core Idea

When a user asks Claude to automate something in the browser, Claude typically does it live using browser tools (click, type, navigate, read_page, etc.). This works, but **every replay costs tokens**.

Workflows (`.workflow.json`) are deterministic automation scripts that Woodbury executes natively — no AI tokens needed. If Claude can learn the most efficient way to perform a task, then **build a workflow from that knowledge**, future runs are free.

**The pattern:**

```
1. LEARN   — Claude does the task interactively, observing ARIA structure
2. BUILD   — Claude uses workflow_build to create a .workflow.json
3. TEST    — workflow_build action:"test" verifies it works
4. SHIP    — The workflow runs via dashboard or schedule, zero tokens
```

## When to Build a Workflow

Build a workflow when ALL of these are true:

- The task is **repeatable** (same site, same flow, different inputs)
- The task is **deterministic** (no AI judgment needed mid-flow)
- The site has **stable ARIA/accessibility markup** (most modern sites do)
- The user will want to run it **more than once**

Do NOT build a workflow when:

- The task requires AI reasoning at each step (use a composition/pipeline instead)
- The site changes layout unpredictably between runs
- It's a one-off task the user won't repeat

## Phase 1: Learn — Interactive Discovery

Before building a workflow, Claude should do the task interactively to learn:

1. **What pages to visit** — exact URLs, navigation sequence
2. **What elements to interact with** — buttons, inputs, links
3. **What ARIA properties those elements have** — roles, labels, accessible names
4. **What data to extract or input** — variable values, dynamic content
5. **What waits are needed** — page loads, element visibility, network idle

### Discovering ARIA Properties

Use these tools during the learning phase:

**`read_page` with interactive filter** — best for surveying a page:
```
read_page(tabId, filter: "interactive")
```
Returns all interactive elements with their ARIA roles, accessible names, and ref IDs.

**`find` with natural language** — when you know what you're looking for:
```
find(tabId, query: "submit button")
find(tabId, query: "email input field")
```

**`workflow_build` action: `inspect_element`** — returns a ready-to-use ElementTarget:
```json
{
  "action": "inspect_element",
  "selector": "#submit-btn"
}
// or
{
  "action": "inspect_element",
  "query": "the blue submit button"
}
```
This returns the element's ARIA label, role, CSS selector, bounds, and text — pre-formatted as an `ElementTarget` object you can paste directly into workflow steps.

### What to Record During Learning

As you interact with the page, note:

| What | Example | Used for |
|------|---------|----------|
| URL pattern | `https://app.example.com/dashboard` | `navigate` step |
| Element role + name | `role:button[name:Create New]` | `accessibilityQuery` |
| Input placeholder | `"Search projects..."` | `placeholder` targeting |
| Element position | center at 50% x, 12% y | `expectedBounds` |
| Wait conditions | `.results-table` becomes visible | `wait` step |
| Dynamic values | username, search term, date | `{{variables}}` |

## Phase 2: Build — Constructing the Workflow

Use the `workflow_build` tool with this sequence:

### Step 1: Create the workflow

```json
{
  "action": "create",
  "name": "Create GitHub Issue",
  "description": "Opens GitHub, navigates to a repo, and creates a new issue",
  "site": "github.com",
  "variables": [
    { "name": "repo", "description": "Repository (owner/name)", "type": "string", "required": true },
    { "name": "title", "description": "Issue title", "type": "string", "required": true },
    { "name": "body", "description": "Issue body text", "type": "string", "required": false, "default": "" }
  ]
}
```

### Step 2: Inspect elements and add steps

For each interaction learned in Phase 1, inspect the element then add the step:

```json
{
  "action": "inspect_element",
  "query": "New issue button"
}
```

Then use the returned ElementTarget in a step:

```json
{
  "action": "add_steps",
  "steps": [
    {
      "id": "nav-repo",
      "label": "Navigate to repository",
      "type": "navigate",
      "url": "https://github.com/{{repo}}",
      "waitForSelector": "[data-testid='repository-container']"
    },
    {
      "id": "click-new-issue",
      "label": "Click New Issue button",
      "type": "click",
      "target": {
        "accessibilityQuery": "role:link[name:New issue]",
        "selector": "a[href$='/issues/new/choose']",
        "expectedBounds": { "pctX": 88, "pctY": 15, "pctW": 8, "pctH": 3, "viewportW": 1920, "viewportH": 1080, "tolerance": 50 }
      }
    },
    {
      "id": "wait-form",
      "label": "Wait for issue form",
      "type": "wait",
      "condition": "element_visible",
      "selector": "#issue_title"
    },
    {
      "id": "type-title",
      "label": "Enter issue title",
      "type": "type",
      "target": {
        "accessibilityQuery": "role:textbox[name:Add a title]",
        "placeholder": "Title",
        "selector": "#issue_title"
      },
      "text": "{{title}}",
      "clearFirst": true
    },
    {
      "id": "type-body",
      "label": "Enter issue body",
      "type": "type",
      "target": {
        "accessibilityQuery": "role:textbox[name:Add a description]",
        "selector": "#issue_body"
      },
      "text": "{{body}}"
    },
    {
      "id": "submit",
      "label": "Submit the issue",
      "type": "click",
      "target": {
        "accessibilityQuery": "role:button[name:Submit new issue]",
        "textContent": "Submit new issue",
        "selector": "button[type='submit']"
      }
    },
    {
      "id": "wait-created",
      "label": "Wait for issue to be created",
      "type": "wait",
      "condition": "url_contains",
      "value": "/issues/"
    }
  ]
}
```

### Step 3: Finalize

```json
{ "action": "finalize" }
```

Validates: no duplicate IDs, all `{{variable}}` references are declared, steps are non-empty.

### Step 4: Test

```json
{
  "action": "test",
  "testVariables": {
    "repo": "myorg/myrepo",
    "title": "Test issue from workflow",
    "body": "This is an automated test."
  }
}
```

Runs the workflow through the executor and reports step-by-step results.

## Element Targeting Rules

### Priority Order (most → least resilient)

| Priority | Field | Example | Why |
|----------|-------|---------|-----|
| 1 | `accessibilityQuery` | `role:button[name:Submit]` | Semantic, survives redesigns |
| 2 | `ariaLabel` + `role` | `ariaLabel: "Submit", role: "button"` | Same data, separate fields |
| 3 | `textContent` | `"Submit new issue"` | Visible text is usually stable |
| 4 | `placeholder` | `"Search..."` | Input hints rarely change |
| 5 | `dataTestId` | `"submit-btn"` | Developer-set, intentionally stable |
| 6 | `selector` | `button[type=submit]` | CSS — use simple semantic selectors only |
| 7 | `description` | `"blue download button in toolbar"` | Natural language fallback (uses AI) |

### Rules

1. **Always include `accessibilityQuery` when the element has a role and name.** Format: `role:<role>[name:<accessible-name>]`
2. **Always include `expectedBounds`** — percentage-based position disambiguates when multiple elements match the same query.
3. **Always include at least one CSS `selector` as fallback** — but prefer simple semantic selectors (`button[type=submit]`) over generated class names (`div.css-1a2b3c`).
4. **Use `{{variables}}` for any user-specific value** — declare them in the workflow's `variables` array.
5. **Never use fragile selectors** — no `:nth-child()`, no minified class names, no deep nesting chains.

### The `accessibilityQuery` Format

```
role:<role>[name:<accessible-name>]
```

Common roles:
- `button` — clickable buttons
- `link` — anchor links
- `textbox` — text inputs
- `searchbox` — search inputs
- `combobox` — dropdowns/selects
- `checkbox` — checkboxes
- `radio` — radio buttons
- `tab` — tab controls
- `menuitem` — menu items
- `dialog` — modal dialogs
- `navigation` — nav landmarks
- `heading` — headings (h1-h6)

Examples:
```
role:button[name:Submit]
role:textbox[name:Email address]
role:link[name:Sign in]
role:checkbox[name:Remember me]
role:combobox[name:Country]
role:tab[name:Settings]
role:menuitem[name:Delete]
role:dialog[name:Confirm deletion]
```

## Step Type Quick Reference

### Browser Interaction

| Type | Required Fields | Notes |
|------|----------------|-------|
| `navigate` | `url` | Optional: `waitForSelector` |
| `click` | `target` | Target is an ElementTarget object |
| `type` | `target`, `text` | Optional: `clearFirst: true` |
| `keyboard` | `key` | Optional: `modifiers: ["ctrl"]` |
| `scroll` | `direction`, `amount` | direction: "up"/"down"/"left"/"right" |
| `wait` | `condition` | See wait conditions below |

### Wait Conditions

| Condition | Extra fields | Example |
|-----------|-------------|---------|
| `element_visible` | `selector` | Wait for `.results` to appear |
| `delay` | `ms` | Wait 2000ms |
| `url_contains` | `value` | Wait for URL to contain `/dashboard` |
| `network_idle` | — | Wait for no pending requests |

### Data & Variables

| Type | Required Fields | Notes |
|------|----------------|-------|
| `set_variable` | `variable`, `source` | Extract text, attributes, JSON, expressions |
| `http_request` | `method`, `url` | Optional: `headers`, `body`, `outputVariable` |
| `eval` | `expression`, `outputVariable` | JavaScript expression on variables |
| `extract_structured` | `source`, `inputVariable`, `outputVariable` | JSON parse, regex, split |

### Control Flow

| Type | Required Fields | Notes |
|------|----------------|-------|
| `conditional` | `condition`, `thenSteps` | Optional: `elseSteps` |
| `loop` | `variable`, `itemVariable`, `steps` | Iterates over array variable |
| `try_catch` | `trySteps` | Optional: `catchSteps`, `errorVariable` |
| `parallel` | `branches` | Array of step arrays, optional: `failFast` |
| `sub_workflow` | `workflowId` | Optional: `variables` bindings |

## Advanced: From Workflow to Composition

When a task needs **AI reasoning at some nodes** but **deterministic automation at others**, build a **composition** (pipeline):

```
[Workflow: Login] → [Script: Analyze data] → [Workflow: Export results]
```

- Workflow nodes run at zero token cost (deterministic browser steps)
- Script nodes run JavaScript (zero token cost)
- Only nodes that genuinely need AI reasoning should use LLM calls

This hybrid approach minimizes token usage while keeping the flexibility of AI where needed.

## Complete Example: Automated Report Download

Here's a full learn → build → ship cycle:

### Learning Phase

Claude navigates to the reporting dashboard, discovers:
- Login form has `role:textbox[name:Email]` and `role:textbox[name:Password]`
- Reports page has `role:link[name:Weekly Report]`
- Download button is `role:button[name:Download CSV]`
- File downloads to `~/Downloads/report-*.csv`

### Build Phase

```json
{
  "action": "create",
  "name": "Download Weekly Report",
  "site": "reports.example.com",
  "variables": [
    { "name": "email", "type": "string", "required": true },
    { "name": "password", "type": "string", "required": true }
  ]
}
```

Steps:
1. `navigate` → `https://reports.example.com/login`
2. `type` → email field with `{{email}}`
3. `type` → password field with `{{password}}`
4. `click` → submit button
5. `wait` → `url_contains: "/dashboard"`
6. `click` → "Weekly Report" link
7. `wait` → `element_visible: ".report-content"`
8. `click` → "Download CSV" button
9. `wait` → `delay: 3000` (download time)

### Ship Phase

Finalize → test → workflow is now available in the dashboard. Can be:
- Run manually from the Woodbury dashboard
- Triggered on a schedule
- Called from a composition as a node
- Invoked via `workflow_play` tool

All at zero token cost.

## Troubleshooting

### Element not found during test

1. Re-inspect the element with `workflow_build action:"inspect_element"`
2. Check if the page state has changed (new modal, redirect)
3. Add a `wait` step before the failing step
4. Include `description` (natural language) as an extra fallback in the target

### Variable not substituted

- Ensure the variable is declared in the workflow's `variables` array
- Check spelling: `{{myVar}}` must match `{ "name": "myVar" }` exactly
- Variable names are case-sensitive

### Workflow passes test but fails on different screen sizes

- Always include `expectedBounds` with `tolerance: 50` or higher
- Prefer `accessibilityQuery` over position-based targeting
- Add `context` to the ElementTarget for landmark-based disambiguation

### Site uses Shadow DOM

Add `shadowPath` to the ElementTarget:
```json
{
  "shadowPath": [
    { "selector": "my-app", "ariaLabel": null, "role": null },
    { "selector": "my-dialog", "ariaLabel": "Settings", "role": "dialog" }
  ],
  "accessibilityQuery": "role:button[name:Save]"
}
```

## Related Docs

- [aria-targeting-reference.md](aria-targeting-reference.md) — full ElementTarget interface and resolution chain
- [composition-schema-and-validation.md](composition-schema-and-validation.md) — composition/pipeline schema
- [pipeline-lifecycle-contract.md](pipeline-lifecycle-contract.md) — lifecycle stages for pipeline generation
- [pipeline-generation-runbook.md](pipeline-generation-runbook.md) — diagnosing generation failures
- [dashboard-api.md](dashboard-api.md) — full API endpoint reference
