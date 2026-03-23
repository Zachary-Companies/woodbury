# ARIA Targeting Reference

Element targeting guide for Woodbury workflows. Use this when building or generating `.workflow.json` files to create resilient, stable element selectors.

## Element Targeting Overview

Every workflow step that interacts with a DOM element uses an `ElementTarget` object. The workflow executor resolves targets using a **fallback chain** — it tries each strategy in order until one finds a match.

### Standard Resolution Chain (`ElementResolver`)

1. **Placeholder** — `[placeholder]` attribute (form fields)
2. **Primary CSS selector** — with multi-match disambiguation via `expectedBounds`
3. **Fallback selectors** — array of backup CSS selectors
4. **ARIA label** — `[aria-label]` attribute
5. **Text content** — visible text match
6. **Natural language description** — bridge `find_interactive` (AI-powered)
7. **Percentage-based position** — recorded viewport percentages (last resort)

### Accessibility Resolution Chain (`AccessibilityResolver`)

Used when `metadata.recordingMode` is `'accessibility'`. Inverts priority — semantic first, CSS last:

1. **Accessibility query** — `role:button[name:Submit]` via `find_by_accessibility`
2. **ARIA label** — with shadow DOM piercing
3. **Text content**
4. **SVG fingerprint** — perceptual hash for icon buttons
5. **Label association** — form label + role
6. **Contextual** — nearest heading + role
7. **CSS selector** — fallback
8. **Fallback selectors**
9. **Percentage-based position**

## Why ARIA > CSS for Generated Flows

CSS selectors break when:
- Class names are generated/minified (`class="css-1a2b3c"`)
- DOM structure is reorganized (parent/child changes)
- Components are re-rendered with different wrappers
- Third-party sites update their markup

ARIA labels are stable because they are tied to **user-facing meaning**:
- A "Submit" button stays `aria-label="Submit"` across redesigns
- A "Search" input keeps `role="searchbox"` regardless of CSS
- Navigation landmarks persist through layout changes

**Rule: Generated workflows should always prefer ARIA-based targeting.**

## The `ElementTarget` Interface

```typescript
interface ElementTarget {
  // CSS-based (fragile — use as fallback)
  selector: string;                    // Primary CSS selector
  fallbackSelectors?: string[];        // Backup CSS selectors

  // ARIA-based (preferred for generated flows)
  ariaLabel?: string;                  // aria-label attribute value
  role?: string;                       // ARIA role (button, textbox, link, etc.)
  accessibilityQuery?: string;         // Compact: "role:button[name:Submit]"

  // Text-based
  textContent?: string;                // Visible text content
  placeholder?: string;                // Input placeholder text
  title?: string;                      // Title attribute (tooltips)
  alt?: string;                        // Alt text (images)

  // Stable developer IDs
  name?: string;                       // HTML name attribute
  dataTestId?: string;                 // data-testid attribute

  // Natural language (AI-powered fallback)
  description?: string;                // For find_interactive

  // Position (disambiguation + last resort)
  expectedBounds?: ElementBounds;      // Percentage-based viewport position

  // Advanced
  shadowPath?: ShadowHostDescriptor[]; // Shadow DOM traversal path
  svgFingerprint?: SvgFingerprint;     // SVG perceptual hash
  context?: ElementContext;            // Parent chain, landmarks, headings
  referenceImage?: string;             // Visual verification image
  searchBounds?: { pctX, pctY, pctW, pctH };  // Constrain visual search area
}
```

## The `accessibilityQuery` Format

Compact string that encodes role and accessible name:

```
role:<role>[name:<accessible-name>]
```

**Examples:**
- `role:button[name:Submit]` — a button labeled "Submit"
- `role:textbox[name:Email address]` — an email input
- `role:link[name:Sign in]` — a "Sign in" link
- `role:checkbox[name:Remember me]` — a checkbox
- `role:combobox[name:Country]` — a dropdown
- `role:tab[name:Settings]` — a tab
- `role:menuitem[name:Delete]` — a menu item
- `role:dialog[name:Confirm deletion]` — a modal dialog

The parser (`resolver.ts:544`) extracts `role` from `role:xxx` and `name` from `[name:xxx]`. The bridge's `find_by_accessibility` command searches the accessibility tree.

## Shadow DOM Piercing

For elements inside shadow DOMs, provide a `shadowPath` — an array of host descriptors from document root to the target:

```json
{
  "shadowPath": [
    { "selector": "my-app", "ariaLabel": null, "role": null },
    { "selector": "my-dialog", "ariaLabel": "Settings", "role": "dialog" }
  ],
  "ariaLabel": "Save",
  "role": "button"
}
```

The resolver walks each shadow host in order, entering each shadow root, until it reaches the final target.

## SVG Fingerprinting

Icon buttons often lack text labels. The `svgFingerprint` field provides a perceptual hash of the SVG for layout-independent matching:

```json
{
  "svgFingerprint": {
    "hash": "a1b2c3d4e5f6...",
    "dimensions": { "width": 24, "height": 24 },
    "label": "Close",
    "inline": true
  }
}
```

The bridge's `find_by_svg_fingerprint` command compares hashes to find the matching icon.

## Best Practices for Generated Flows

### Targeting Priority

When building `ElementTarget` objects for generated workflows:

1. **`accessibilityQuery`** — Most resilient. Use `role:button[name:Submit]` format.
2. **`ariaLabel` + `role`** — Separate fields, same data. Good when accessibility query isn't available.
3. **`textContent`** — Visible text. Works well for buttons and links with unique text.
4. **`placeholder`** — For form inputs. Very stable.
5. **`dataTestId`** — If the site has them, they're intentionally stable.
6. **`selector`** — CSS selector as last resort. Use simple, semantic selectors: `button[type="submit"]` not `div.css-1a2b3c > span:nth-child(2)`.
7. **`description`** — Natural language for complex cases: "the blue download button in the toolbar".

### Always Include `expectedBounds`

Percentage-based bounds disambiguate when multiple elements match:

```json
{
  "expectedBounds": {
    "pctX": 50.5,
    "pctY": 12.3,
    "pctW": 8.2,
    "pctH": 3.1,
    "viewportW": 1920,
    "viewportH": 1080,
    "tolerance": 50
  }
}
```

- `pctX/pctY` — center of the element as viewport percentage
- `pctW/pctH` — element dimensions as viewport percentage
- `viewportW/viewportH` — viewport at recording time (for scaling)
- `tolerance` — pixel tolerance for bounds validation

### Use Variables for User-Specific Values

```json
{
  "type": "type",
  "target": { "accessibilityQuery": "role:textbox[name:Username]" },
  "text": "{{username}}"
}
```

Declare variables in the workflow's `variables` array so they're prompted at runtime.

## Discovering ARIA Properties

When building a workflow interactively (via the `workflow_build` tool), use these approaches to discover what targeting data is available:

### Using `read_page` (accessibility tree)
```
read_page(tabId, filter: "interactive")
```
Returns all interactive elements with roles, names, and positions.

### Using `find` (natural language)
```
find(tabId, query: "login button")
```
Returns matching elements with ref IDs for further inspection.

### Using `get_element_info` (detailed inspection)
```
browser_query(action: "get_element_info", selector: "#submit-btn")
```
Returns full element details including ARIA attributes, text, bounds.

### Using `workflow_build` inspect_element
```
workflow_build(action: "inspect_element", selector: "#submit-btn")
```
Returns data pre-formatted as an `ElementTarget` ready to use in a step.

## Workflow Step Type Reference

### Browser Interaction Steps

#### `navigate`
```json
{ "type": "navigate", "url": "https://example.com/{{path}}", "waitForSelector": ".loaded" }
```

#### `click`
```json
{
  "type": "click",
  "target": {
    "accessibilityQuery": "role:button[name:Submit]",
    "selector": "button[type=submit]",
    "expectedBounds": { "pctX": 50, "pctY": 90, "pctW": 10, "pctH": 4 }
  }
}
```

#### `type`
```json
{
  "type": "type",
  "target": { "accessibilityQuery": "role:textbox[name:Email]", "placeholder": "Enter email" },
  "text": "{{email}}",
  "clearFirst": true
}
```

#### `keyboard`
```json
{ "type": "keyboard", "key": "Enter" }
{ "type": "keyboard", "key": "a", "modifiers": ["ctrl"] }
```

#### `scroll`
```json
{ "type": "scroll", "direction": "down", "amount": 500 }
```

#### `wait`
```json
{ "type": "wait", "condition": "element_visible", "selector": ".results" }
{ "type": "wait", "condition": "delay", "ms": 2000 }
{ "type": "wait", "condition": "url_contains", "value": "/dashboard" }
{ "type": "wait", "condition": "network_idle" }
```

### Data Steps

#### `set_variable`
```json
{ "type": "set_variable", "variable": "title", "source": { "type": "element_text", "target": { "selector": "h1" } } }
{ "type": "set_variable", "variable": "data", "source": { "type": "json_parse", "input": "rawJson" } }
{ "type": "set_variable", "variable": "count", "source": { "type": "expression", "expression": "variables.items.length" } }
```

#### `http_request`
```json
{
  "type": "http_request",
  "method": "POST",
  "url": "https://api.example.com/data",
  "headers": { "Authorization": "Bearer {{token}}" },
  "body": { "query": "{{searchTerm}}" },
  "outputVariable": "apiResponse",
  "statusVariable": "httpStatus",
  "expectedStatus": 200
}
```

#### `eval`
```json
{
  "type": "eval",
  "expression": "variables.items.filter(i => i.active).map(i => i.name)",
  "outputVariable": "activeNames"
}
```

#### `extract_structured`
```json
{ "type": "extract_structured", "source": "json_parse", "inputVariable": "rawText", "outputVariable": "parsed" }
{ "type": "extract_structured", "source": "split", "inputVariable": "csvLine", "pattern": ",", "outputVariable": "fields" }
{ "type": "extract_structured", "source": "regex_groups", "inputVariable": "text", "pattern": "(\\w+)@(\\w+)", "outputVariable": "groups" }
```

### Control Flow Steps

#### `conditional`
```json
{
  "type": "conditional",
  "condition": { "type": "variable_equals", "variable": "loggedIn", "value": true },
  "thenSteps": [{ "type": "navigate", "url": "/dashboard" }],
  "elseSteps": [{ "type": "navigate", "url": "/login" }]
}
```

#### `loop`
```json
{
  "type": "loop",
  "variable": "items",
  "itemVariable": "item",
  "steps": [
    { "type": "type", "target": { "selector": "input" }, "text": "{{item}}" },
    { "type": "click", "target": { "accessibilityQuery": "role:button[name:Add]" } }
  ]
}
```

#### `try_catch`
```json
{
  "type": "try_catch",
  "trySteps": [{ "type": "click", "target": { "selector": ".optional-button" } }],
  "catchSteps": [{ "type": "wait", "condition": "delay", "ms": 1000 }],
  "errorVariable": "lastError"
}
```

#### `parallel`
```json
{
  "type": "parallel",
  "branches": [
    [{ "type": "http_request", "method": "GET", "url": "https://api.a.com", "outputVariable": "dataA" }],
    [{ "type": "http_request", "method": "GET", "url": "https://api.b.com", "outputVariable": "dataB" }]
  ],
  "failFast": true
}
```

#### `sub_workflow`
```json
{ "type": "sub_workflow", "workflowId": "login-github", "variables": { "username": "{{user}}" } }
```
