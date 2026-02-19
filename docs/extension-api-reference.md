# Extension API Reference

Complete reference for the Woodbury extension API. For a guided introduction, see [extensions.md](extensions.md).

## Module Exports

Every extension entry point must export an object matching `WoodburyExtension`:

```typescript
interface WoodburyExtension {
  activate(context: ExtensionContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
```

### activate(context)

Called when the extension is loaded during Woodbury startup. Register all capabilities here.

- **Parameter:** `context` — an `ExtensionContext` object (see below)
- **Returns:** `void` or `Promise<void>`
- **Timing:** Called during startup, after discovery and validation
- **Error behavior:** If `activate()` throws, the extension is skipped and an error is logged. Other extensions and core Woodbury continue normally.

### deactivate()

Optional. Called when Woodbury shuts down or the extension is explicitly unloaded.

- **Returns:** `void` or `Promise<void>`
- **Timing:** Called during REPL exit (`/exit`, Ctrl+C double-press)
- **Error behavior:** Errors are silently caught. Always clean up resources even if errors occur.

---

## ExtensionContext

The context object passed to `activate()`. This is the extension's sole interface to Woodbury.

### registerTool(definition, handler)

Register a tool the AI agent can call.

```typescript
registerTool(definition: ToolDefinition, handler: ToolHandler): void
```

**Parameters:**

#### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
  dangerous?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier. Use underscores, prefix with extension name (e.g. `social_post`). Must not collide with built-in tools or other extensions. |
| `description` | string | Yes | What the tool does. The agent reads this to decide when to use it. Be specific and action-oriented. |
| `parameters` | object | Yes | JSON Schema for the tool's input. Must have `type: 'object'` at the top level. |
| `parameters.properties` | Record | Yes | Each property defines one parameter with `type`, `description`, and optional `enum`. |
| `parameters.required` | string[] | No | Which parameters the agent must provide. |
| `dangerous` | boolean | No | If `true`, Woodbury may require user confirmation when `--safe` mode is enabled. Default: `false`. |

**Supported JSON Schema property types:**
- `"string"` — text values. Add `enum` for a fixed set of choices.
- `"number"` — numeric values. Add `minimum`/`maximum` for constraints.
- `"integer"` — whole numbers.
- `"boolean"` — true/false.
- `"array"` — lists. Use `items` to define element type.
- `"object"` — nested objects. Keep nesting shallow for best agent comprehension.

#### ToolHandler

```typescript
type ToolHandler = (params: Record<string, any>) => Promise<string> | string;
```

| Aspect | Detail |
|--------|--------|
| **Input** | Object matching the parameters schema. Properties are already parsed and typed. |
| **Return** | A string the agent sees as the tool result. For structured data, use `JSON.stringify(data, null, 2)`. |
| **Errors** | Throw an `Error` with a descriptive message. The agent sees the error message and can retry or adapt. |
| **Side effects** | Allowed. Use `dangerous: true` in the definition for destructive operations. |
| **Async** | Both sync and async handlers are supported. |

**Name collision behavior:** If a tool name collides with a built-in tool or another extension's tool, registration fails with a warning logged to the console. The extension continues loading but without that tool.

---

### registerCommand(command)

Register a slash command for the REPL.

```typescript
registerCommand(command: ExtensionSlashCommand): void
```

#### ExtensionSlashCommand

```typescript
interface ExtensionSlashCommand {
  name: string;
  description: string;
  handler: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Command name without the `/` prefix. Users type `/<name>`. |
| `description` | string | Yes | Shown in `/help` and `/extensions` output. Automatically prefixed with `[ext-name]`. |
| `handler` | function | Yes | Called when the user types `/<name> [args...]`. |

#### ExtensionCommandContext

```typescript
interface ExtensionCommandContext {
  workingDirectory: string;
  print: (message: string) => void;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDirectory` | string | Current working directory |
| `print` | (msg: string) => void | Output text to the REPL. Each call produces one line. Supports ANSI escape codes. |

**Handler arguments:** The `args` array contains space-split tokens after the command name. For `/social post "hello world"`, args is `['post', '"hello', 'world"']` (no shell-style quote parsing).

---

### addSystemPrompt(section)

Add text to the agent's system prompt.

```typescript
addSystemPrompt(section: string): void
```

| Aspect | Detail |
|--------|--------|
| **Input** | A markdown string injected after built-in prompt sections, before project context. |
| **Multiple calls** | Each call adds a separate section. They're joined with `\n\n` in the final prompt. |
| **When injected** | Every agent interaction for the entire session. |
| **Token cost** | Every token is sent on every interaction. Keep additions under ~200 tokens. |

**Injection point in the system prompt:**

```
[Built-in sections: identity, environment, behavior, tools, etc.]

## Extension Instructions

[Your addSystemPrompt text appears here]
[Other extension prompt text appears here]

## Project Context (from .woodbury.md)
[Project context if present]
```

---

### serveWebUI(options)

Start a local HTTP server for a web UI.

```typescript
serveWebUI(options: WebUIOptions): Promise<WebUIHandle>
```

#### WebUIOptions

```typescript
interface WebUIOptions {
  staticDir: string;
  port?: number;
  label?: string;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `staticDir` | string | required | Absolute path to the directory containing static files. Must contain at least `index.html`. |
| `port` | number | 0 | Port to listen on. `0` means auto-assign a free port (recommended). |
| `label` | string | - | Display label shown in the `/extensions` command output. |

#### WebUIHandle

```typescript
interface WebUIHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full URL, e.g. `http://127.0.0.1:43210` |
| `port` | number | The assigned port number |
| `close()` | () => Promise | Shut down the server. Called automatically on deactivation. |

**Server behavior:**
- Binds to `127.0.0.1` only (not `0.0.0.0`). Not network-accessible.
- Serves static files from `staticDir` with correct MIME types.
- `GET /` serves `index.html`.
- CORS headers allow `*` origin for local development.
- Unknown file extensions served as `application/octet-stream`.
- Missing files return 404.

**Supported MIME types:** `.html`, `.js`, `.mjs`, `.css`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`

---

### workingDirectory

```typescript
workingDirectory: string
```

The directory Woodbury was launched in (or the `--working-directory` override). Read-only.

---

### log

```typescript
log: ExtensionLogger
```

#### ExtensionLogger

```typescript
interface ExtensionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
```

| Method | Visibility | Description |
|--------|-----------|-------------|
| `info` | Verbose only (`-v`) | General information |
| `warn` | Always | Warnings |
| `error` | Always | Errors |
| `debug` | Verbose only (`-v`) | Debug details |

All messages are automatically prefixed with `[ext:<name>]`.

---

### bridgeServer

```typescript
bridgeServer: {
  send(action: string, params?: Record<string, any>): Promise<any>;
  readonly isConnected: boolean;
}
```

Access to the Chrome extension bridge for browser automation.

| Field | Type | Description |
|-------|------|-------------|
| `isConnected` | boolean | Whether the Chrome extension bridge is currently connected |
| `send(action, params)` | function | Send an action to the Chrome extension. Returns the response. Throws if not connected. |

**Common actions:** `"ping"`, `"get_page_info"`, `"find_element_by_text"`, `"click_element"`, `"set_value"`, `"get_form_fields"`, `"get_clickable_elements"`

---

## ExtensionManifest

Internal type used by the loader. Included here for reference when working on the extension system.

```typescript
interface ExtensionManifest {
  packageName: string;     // npm package name (e.g. "woodbury-ext-social")
  name: string;            // Short name from woodbury field (e.g. "social")
  displayName: string;     // Human-readable name
  description: string;     // What the extension does
  version: string;         // Semantic version
  provides: string[];      // Capability list: "tools", "commands", "prompts", "webui"
  entryPoint: string;      // Absolute path to the JS entry point
  source: 'local' | 'npm'; // Where the extension was discovered
  directory: string;       // Absolute path to the extension root
}
```

---

## Discovery Rules

### Local extensions

Scanned from `~/.woodbury/extensions/<name>/` directories.

Requirements:
1. Must be a directory (not a file)
2. Must not be named `node_modules`
3. Must contain `package.json` with `woodbury.name` field
4. Entry point file must exist (`main` field or `index.js`)

### npm extensions

Scanned from `~/.woodbury/extensions/node_modules/`:

- **Unscoped:** `woodbury-ext-*` directories
- **Scoped:** `@scope/woodbury-ext-*` directories

Same package.json and entry point requirements as local extensions.

### Discovery order

1. Local directories first (alphabetical)
2. npm packages second (alphabetical)

If a local extension and npm extension have the same `woodbury.name`, the local one is activated first and the npm one will fail with a name collision.

---

## TypeScript Types

All types are exported from the `woodbury` package:

```typescript
import type {
  WoodburyExtension,
  ExtensionContext,
  ExtensionSlashCommand,
  ExtensionCommandContext,
  WebUIOptions,
  WebUIHandle,
  ExtensionLogger,
  ToolDefinition,
  ToolHandler,
} from 'woodbury';
```

These are type-only exports (no runtime code). Use them in TypeScript extensions for full type safety.

---

## Error Handling Summary

| Situation | Behavior |
|-----------|----------|
| Extension missing `package.json` | Silently skipped during discovery |
| Missing `woodbury.name` in package.json | Silently skipped |
| Entry point file doesn't exist | Silently skipped |
| `activate()` throws | Error logged, extension skipped, others continue |
| Tool name collision | Warning logged, tool skipped, extension continues |
| `deactivate()` throws | Error silently caught |
| Web server fails to start | Error propagated to `activate()` |
| `--no-extensions` flag | Discovery and loading skipped entirely |
