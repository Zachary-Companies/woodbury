# Woodbury Extensions

Extensions add new capabilities to Woodbury without modifying core code. An extension can provide any combination of:

- **Tools** the AI agent can call during conversations
- **Slash commands** for the interactive REPL
- **System prompt additions** that guide the agent's behavior
- **Web UIs** served on localhost for dashboards and management interfaces

## Quick Start

### Create your first extension

```bash
woodbury ext create my-first
```

This scaffolds a starter extension at `~/.woodbury/extensions/my-first/` with examples of all four capabilities. Restart Woodbury to activate it.

### Verify it loaded

```bash
woodbury
# In the REPL:
/extensions
```

You should see your extension listed with its tools, commands, and web UI status.

### Try it out

```
# Use the scaffolded slash command
/my-first status

# The agent can call the scaffolded tool
Ask me to use the my_first_hello tool
```

## Extension Structure

An extension is a directory with a `package.json` and a JavaScript entry point:

```
~/.woodbury/extensions/my-ext/
  package.json        # Metadata + woodbury field
  index.js            # Entry point (activate/deactivate)
  web/                # Optional: static files for web UI
    index.html
  lib/                # Optional: additional modules
```

### package.json

The `package.json` must include a `woodbury` field:

```json
{
  "name": "woodbury-ext-my-ext",
  "version": "0.1.0",
  "main": "index.js",
  "woodbury": {
    "name": "my-ext",
    "displayName": "My Extension",
    "description": "What the extension does",
    "provides": ["tools", "commands", "prompts", "webui"]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `woodbury.name` | Yes | Short unique identifier (lowercase, hyphens ok) |
| `woodbury.displayName` | No | Human-readable name (defaults to `name`) |
| `woodbury.description` | No | Brief description |
| `woodbury.provides` | No | Capability list for `ext list` display |
| `main` | No | Entry point path (defaults to `index.js`) |

### Entry Point

The entry point must export an `activate` function and optionally a `deactivate` function:

```javascript
// index.js
module.exports = {
  async activate(ctx) {
    // Register tools, commands, prompts, and web UIs here
    ctx.log.info('Extension activated');
  },

  async deactivate() {
    // Clean up resources (connections, timers, etc.)
  }
};
```

Both `activate` and `deactivate` can be sync or async. Woodbury awaits them either way.

## Extension Context API

The `ctx` object passed to `activate()` provides access to all Woodbury capabilities:

### ctx.registerTool(definition, handler)

Register a tool the AI agent can call. The agent sees the tool in its system prompt and can invoke it during conversations.

```javascript
ctx.registerTool(
  {
    name: 'social_post',
    description: 'Post a message to a social media platform',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['twitter', 'bluesky', 'mastodon'],
          description: 'Target platform'
        },
        message: {
          type: 'string',
          description: 'The message to post'
        },
        schedule: {
          type: 'string',
          description: 'ISO 8601 datetime to schedule the post (optional)'
        }
      },
      required: ['platform', 'message']
    },
    dangerous: false  // Set true if the tool has side effects the user should confirm
  },
  async (params) => {
    // params is a typed object matching the parameters schema above
    const { platform, message, schedule } = params;

    // Do the actual work
    const result = await postToSocialMedia(platform, message, schedule);

    // Return a string the agent will see as the tool result
    return `Posted to ${platform}: "${message.slice(0, 50)}..." (ID: ${result.id})`;
  }
);
```

**Tool definition fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique tool name (use underscores, prefix with extension name) |
| `description` | string | What the tool does (the agent reads this to decide when to use it) |
| `parameters` | object | JSON Schema for parameters (type: "object" with properties) |
| `parameters.required` | string[] | Which parameters are mandatory |
| `dangerous` | boolean | If true, Woodbury may require user confirmation in safe mode |

**Handler return value:** Return a string. The agent sees this as the tool's output. For structured data, return JSON stringified with nice formatting.

**Error handling:** Throw an error to report failure. The agent sees the error message and can retry or try a different approach.

```javascript
async (params) => {
  if (!process.env.TWITTER_API_KEY) {
    throw new Error('TWITTER_API_KEY environment variable is not set');
  }
  // ...
}
```

### ctx.registerCommand(command)

Register a slash command available in the REPL:

```javascript
ctx.registerCommand({
  name: 'social',
  description: 'Social media management commands',
  async handler(args, cmdCtx) {
    const subcommand = args[0];

    if (subcommand === 'status') {
      cmdCtx.print('Connected platforms:');
      cmdCtx.print('  Twitter: @myhandle (authenticated)');
      cmdCtx.print('  Bluesky: @me.bsky.social (authenticated)');
    } else if (subcommand === 'queue') {
      cmdCtx.print('Scheduled posts: 3');
      cmdCtx.print('  1. [Twitter] Tomorrow 9am: "New blog post..."');
      cmdCtx.print('  2. [Bluesky] Tomorrow 10am: "Check out..."');
    } else {
      cmdCtx.print('Usage:');
      cmdCtx.print('  /social status   - Show connected platforms');
      cmdCtx.print('  /social queue    - Show scheduled posts');
      cmdCtx.print('  /social post     - Draft and schedule a post');
    }
  }
});
```

**Command context (`cmdCtx`):**

| Field | Type | Description |
|-------|------|-------------|
| `print` | (msg: string) => void | Print output to the REPL |
| `workingDirectory` | string | Current working directory |

Users invoke the command with `/social status`, `/social queue`, etc.

### ctx.addSystemPrompt(section)

Inject text into the agent's system prompt. This guides the agent's behavior when your extension is loaded:

```javascript
ctx.addSystemPrompt(`## Social Media Manager

You have access to social media management tools:
- \`social_post\` - Post to Twitter, Bluesky, or Mastodon
- \`social_draft\` - Save a draft post for review
- \`social_analytics\` - Get engagement metrics

When the user asks about social media:
1. Check their connected platforms with /social status
2. Suggest appropriate content for each platform
3. Respect character limits (Twitter: 280, Bluesky: 300)
4. Always offer to schedule posts rather than posting immediately
5. Use the web dashboard for managing queued posts`);
```

Keep prompt additions concise and focused. They're injected into every agent interaction, so verbose prompts waste tokens.

### ctx.serveWebUI(options)

Start a local HTTP server to serve static files:

```javascript
const path = require('path');

const handle = await ctx.serveWebUI({
  staticDir: path.join(__dirname, 'web'),
  port: 0,        // 0 = auto-assign a free port
  label: 'Social Media Dashboard'
});

ctx.log.info(`Dashboard at ${handle.url}`);
```

**Options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `staticDir` | string | required | Absolute path to directory with static files |
| `port` | number | 0 | Port to listen on (0 = auto-assign) |
| `label` | string | - | Display label in `/extensions` output |

**Handle:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full URL (e.g. `http://127.0.0.1:43210`) |
| `port` | number | Assigned port number |
| `close()` | () => Promise | Shut down the server |

The server binds to `127.0.0.1` only (localhost, not network-accessible). It serves static files with proper MIME types and CORS headers.

**Communicating between web UI and the agent:** The web UI is a standard web page. For real-time communication, your extension can use the bridge server (see `ctx.bridgeServer`) or set up its own WebSocket/SSE endpoint.

### ctx.workingDirectory

The current working directory Woodbury was launched in:

```javascript
const projectRoot = ctx.workingDirectory;
```

### ctx.log

Logger that routes through Woodbury's output system:

```javascript
ctx.log.info('Extension activated');      // Shown when --verbose
ctx.log.warn('API rate limit approaching');  // Always shown
ctx.log.error('Failed to connect');          // Always shown
ctx.log.debug('Request payload: ...');       // Shown when --verbose
```

Messages are prefixed with `[ext:<name>]` automatically.

### ctx.bridgeServer

Access to the Chrome extension bridge for browser communication:

```javascript
if (ctx.bridgeServer.isConnected) {
  const result = await ctx.bridgeServer.send('get_page_info', {});
  ctx.log.info(`Current page: ${result.title}`);
}
```

## Installation Sources

Extensions are discovered from two locations:

### Local Extensions

Place extension directories directly in `~/.woodbury/extensions/`:

```
~/.woodbury/extensions/
  social/
    package.json
    index.js
  analytics/
    package.json
    index.js
```

Use `woodbury ext create <name>` to scaffold a new local extension.

### npm Extensions

Install extensions from npm:

```bash
woodbury ext install woodbury-ext-social
woodbury ext install @myorg/woodbury-ext-analytics
```

npm extensions are installed into `~/.woodbury/extensions/node_modules/` and discovered automatically. Package names must start with `woodbury-ext-` (or `@scope/woodbury-ext-`).

To uninstall:

```bash
woodbury ext uninstall woodbury-ext-social
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `woodbury ext list` | List all installed extensions |
| `woodbury ext create <name>` | Scaffold a new extension |
| `woodbury ext create <name> --web` | Scaffold with site-knowledge templates for web navigation |
| `woodbury ext install <package>` | Install from npm |
| `woodbury ext uninstall <package>` | Uninstall an npm extension |
| `woodbury --no-extensions` | Start without loading any extensions |

In the REPL:

| Command | Description |
|---------|-------------|
| `/extensions` | Show loaded extensions with tools, commands, and web UIs |

## Extension Lifecycle

1. **Discovery** - On startup, Woodbury scans `~/.woodbury/extensions/` for local directories and npm packages with a `woodbury` field in `package.json`.

2. **Loading** - Each extension's entry point is dynamically imported. Woodbury validates that it exports an `activate` function.

3. **Activation** - `activate(ctx)` is called with a sandboxed `ExtensionContext`. The extension registers its capabilities.

4. **Runtime** - Registered tools are available to the agent. Commands are available in the REPL. Prompt sections are injected into every system prompt. Web servers are running.

5. **Deactivation** - When Woodbury exits, `deactivate()` is called (if provided). Web servers are shut down. Resources are cleaned up.

**Error handling:** If an extension fails to load or activate, Woodbury logs a warning and continues. Other extensions and core functionality are not affected.

## Best Practices

### Naming

- Use a descriptive, lowercase, hyphenated name: `social-media`, `code-review`, `deploy-helper`
- Prefix tool names with your extension name: `social_post`, `social_analytics`, `social_draft`
- This prevents name collisions with built-in tools and other extensions

### Tool Design

- Write clear descriptions. The agent reads them to decide when to use a tool.
- Mark destructive tools as `dangerous: true`.
- Return human-readable strings. The agent needs to understand the result.
- Throw descriptive errors. The agent uses error messages to diagnose problems.
- Keep parameters simple. Complex nested objects confuse the agent.

### System Prompts

- Keep them short. Every token is sent on every interaction.
- Focus on when and how to use your tools. The agent already knows general coding.
- Include examples of good tool usage patterns.
- Don't duplicate information already in tool descriptions.

### Web UIs

- Keep the initial page lightweight. It loads when the extension activates.
- Use `port: 0` for auto-assignment to avoid port conflicts.
- The server only binds to `127.0.0.1` for security.

### Error Handling

- Handle missing API keys gracefully. Check `process.env` and throw clear errors.
- Don't crash on network failures. Return error messages the agent can act on.
- Clean up in `deactivate()`. Close connections, stop timers, release ports.

## Site Research Phase (Web-Navigation Extensions)

When building an extension that navigates and automates a website (e.g., posting to Twitter, managing a Shopify store, scraping data from a dashboard), **research the site first** before writing any automation code. Woodbury provides a `--web` scaffold variant that creates a structured research directory alongside the standard extension files.

### Getting Started

```bash
woodbury ext create my-site --web
```

This creates the standard extension files **plus** a `site-knowledge/` directory:

```
~/.woodbury/extensions/my-site/
  package.json
  index.js              # Loads site-knowledge into system prompt
  web/
    index.html
  site-knowledge/       # ← Research templates
    site-map.md         # Pages, navigation, URL patterns
    selectors.md        # CSS selectors, DOM structure
    auth-flow.md        # Login, sessions, tokens
    api-endpoints.md    # REST/GraphQL endpoints, rate limits
    forms.md            # Form fields, validation, submission
    quirks.md           # Timing issues, workarounds, gotchas
```

The generated `index.js` automatically reads all `.md` files from `site-knowledge/` and injects them into the agent's system prompt at activation time. This means once you fill in the research, Woodbury knows the site inside and out.

### Research Workflow

Work through the knowledge files in order. Each template includes tables to fill in and example Woodbury commands to use for research.

#### Step 1: Site Map (`site-map.md`)

Map out the pages and navigation structure:

```
# In the Woodbury REPL, crawl the site:
> Crawl https://example.com and list all the links you find
> Now render https://example.com/app with JavaScript and map the SPA routes
```

Fill in the Primary Pages table with URLs, purposes, and navigation flows.

#### Step 2: Selectors (`selectors.md`)

Document the CSS selectors for elements you need to interact with:

```
> Render https://example.com/login and find all interactive elements
> What data-testid attributes are used on the dashboard page?
```

Prefer stable selectors: `data-testid`, `aria-label`, `id` over class names or tag hierarchies.

#### Step 3: Auth Flow (`auth-flow.md`)

Document the authentication process:

```
> Render the login page and describe all form fields
> Fetch https://example.com/.well-known/openid-configuration
```

Record session management details: cookie vs JWT, session duration, refresh mechanism.

#### Step 4: API Endpoints (`api-endpoints.md`)

Discover and document API endpoints the site uses:

```
> Fetch https://example.com/api/posts with a GET request
> What API endpoints does the dashboard page call?
```

Record request/response patterns, auth requirements, and rate limits.

#### Step 5: Forms (`forms.md`)

Document form structures and validation rules:

```
> Render the create-post page and list all form fields
> What validation rules does the registration form have?
```

Record field types, required flags, character limits, and submission behavior.

#### Step 6: Quirks (`quirks.md`)

Document timing issues, workarounds, and browser-specific gotchas:

```
> How long does the dashboard take to fully render?
> Does the site use any anti-bot protection?
```

This is the "lessons learned" file — update it as you discover issues during development.

### How Site Knowledge Gets Loaded

The `--web` scaffold generates an `index.js` that:

1. Reads all `.md` files from `site-knowledge/` using `fs.readdirSync` + `fs.readFileSync`
2. Filters out empty files
3. Concatenates non-empty files with `---` separators
4. Passes the combined knowledge to `ctx.addSystemPrompt()`

This means the agent has full access to your research on every interaction. When you update a knowledge file, restart Woodbury to reload it.

### Managing Site Knowledge

The `--web` scaffold includes a `/knowledge` slash command:

```
# In the REPL:
/my-site knowledge
```

This lists all site-knowledge files with a checkmark (✓) for non-empty files and `(empty)` for files that haven't been filled in yet.

### Tips for Effective Research

- **Iterate:** Research is not a one-time activity. Update knowledge files as the site changes.
- **Keep it concise:** The system prompt has a token budget. Focus on actionable information.
- **Use stable selectors:** Prefer `data-testid` and `id` over class names that change with CSS updates.
- **Document dates:** Note when research was last verified, especially for API endpoints and selectors.
- **Test incrementally:** Fill in one knowledge file at a time, restart Woodbury, and verify the agent uses the information correctly.

## Example: Social Media Extension

Here's a more complete example showing all four capabilities:

```javascript
// ~/.woodbury/extensions/social/index.js
const path = require('path');
const fs = require('fs');

const DRAFTS_FILE = path.join(require('os').homedir(), '.woodbury', 'social-drafts.json');

function loadDrafts() {
  try {
    return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveDrafts(drafts) {
  fs.mkdirSync(path.dirname(DRAFTS_FILE), { recursive: true });
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2));
}

module.exports = {
  async activate(ctx) {
    // --- TOOL: Draft a post ---
    ctx.registerTool(
      {
        name: 'social_draft',
        description: 'Save a social media post draft for later review and publishing',
        parameters: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              enum: ['twitter', 'bluesky', 'mastodon'],
              description: 'Target platform'
            },
            content: {
              type: 'string',
              description: 'Post content'
            },
            tags: {
              type: 'string',
              description: 'Comma-separated hashtags (optional)'
            }
          },
          required: ['platform', 'content']
        },
        dangerous: false
      },
      async (params) => {
        const drafts = loadDrafts();
        const draft = {
          id: Date.now().toString(36),
          platform: params.platform,
          content: params.content,
          tags: params.tags ? params.tags.split(',').map(t => t.trim()) : [],
          created: new Date().toISOString(),
          status: 'draft'
        };
        drafts.push(draft);
        saveDrafts(drafts);
        return `Draft saved (ID: ${draft.id}). Use /social drafts to view all drafts, or open the web dashboard.`;
      }
    );

    // --- TOOL: List drafts ---
    ctx.registerTool(
      {
        name: 'social_list_drafts',
        description: 'List all saved social media post drafts',
        parameters: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              description: 'Filter by platform (optional)'
            }
          }
        },
        dangerous: false
      },
      async (params) => {
        let drafts = loadDrafts();
        if (params.platform) {
          drafts = drafts.filter(d => d.platform === params.platform);
        }
        if (drafts.length === 0) {
          return 'No drafts found.';
        }
        return drafts.map(d =>
          `[${d.id}] ${d.platform} (${d.status}) - "${d.content.slice(0, 60)}..." (${d.created})`
        ).join('\n');
      }
    );

    // --- SLASH COMMAND ---
    ctx.registerCommand({
      name: 'social',
      description: 'Social media management',
      async handler(args, cmdCtx) {
        const sub = args[0];
        if (sub === 'drafts') {
          const drafts = loadDrafts();
          if (drafts.length === 0) {
            cmdCtx.print('No drafts. Ask Woodbury to create one!');
            return;
          }
          cmdCtx.print(`Drafts (${drafts.length}):`);
          for (const d of drafts) {
            cmdCtx.print(`  [${d.id}] ${d.platform}: "${d.content.slice(0, 50)}..."`);
          }
        } else if (sub === 'clear') {
          saveDrafts([]);
          cmdCtx.print('All drafts cleared.');
        } else {
          cmdCtx.print('Usage: /social drafts | /social clear');
        }
      }
    });

    // --- SYSTEM PROMPT ---
    ctx.addSystemPrompt(`## Social Media Extension
You can draft and manage social media posts using these tools:
- \`social_draft\` - Save a draft post (supports twitter, bluesky, mastodon)
- \`social_list_drafts\` - List saved drafts

Workflow:
1. Help the user craft the message for each platform
2. Save drafts with social_draft
3. Let the user review drafts with /social drafts or the web dashboard
4. Respect platform limits: Twitter 280 chars, Bluesky 300 chars`);

    // --- WEB UI ---
    const handle = await ctx.serveWebUI({
      staticDir: path.join(__dirname, 'web'),
      label: 'Social Dashboard'
    });
    ctx.log.info(`Social dashboard at ${handle.url}`);
  },

  async deactivate() {
    // Nothing to clean up in this example
  }
};
```

## TypeScript Extensions

Extensions can be written in TypeScript. Compile to JavaScript before loading:

```
my-ext/
  src/
    index.ts         # TypeScript source
  dist/
    index.js         # Compiled output
  package.json       # main: "dist/index.js"
  tsconfig.json
```

**package.json:**
```json
{
  "name": "woodbury-ext-my-ext",
  "version": "0.1.0",
  "main": "dist/index.js",
  "woodbury": {
    "name": "my-ext",
    "displayName": "My Extension",
    "provides": ["tools"]
  },
  "scripts": {
    "build": "tsc"
  }
}
```

**src/index.ts:**
```typescript
import type { ExtensionContext, WoodburyExtension } from 'woodbury';

const extension: WoodburyExtension = {
  async activate(ctx: ExtensionContext) {
    ctx.registerTool(
      {
        name: 'my_tool',
        description: 'Does something useful',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input value' }
          },
          required: ['input']
        }
      },
      async (params: { input: string }) => {
        return `Processed: ${params.input}`;
      }
    );
  }
};

module.exports = extension;
```

Import types from `'woodbury'` for full type safety. Available types:

- `WoodburyExtension` - The extension module shape (`activate`/`deactivate`)
- `ExtensionContext` - The `ctx` object passed to `activate()`
- `ExtensionSlashCommand` - Slash command registration shape
- `ExtensionCommandContext` - Context passed to command handlers
- `WebUIOptions` - Options for `ctx.serveWebUI()`
- `WebUIHandle` - Return value from `ctx.serveWebUI()`
- `ExtensionLogger` - The `ctx.log` interface
- `ToolDefinition` - Tool definition shape
- `ToolHandler` - Tool handler function type

## Publishing to npm

To share an extension:

1. Name your package `woodbury-ext-<name>` (or `@scope/woodbury-ext-<name>`)
2. Include the `woodbury` field in `package.json`
3. Compile TypeScript to JavaScript before publishing
4. Publish: `npm publish`

Users install with:
```bash
woodbury ext install woodbury-ext-<name>
```

## Troubleshooting

### Extension not loading

- Check `woodbury ext list` to see if it was discovered
- Verify `package.json` has a `woodbury.name` field
- Verify the entry point file exists (check `main` field)
- Run `woodbury -v` for verbose logs showing load errors

### Tool not appearing

- Verify the tool was registered in `activate()`
- Check for name collisions with built-in tools (Woodbury warns on startup with `-v`)
- Make sure the tool name uses underscores, not hyphens

### Slash command not working

- Commands are prefixed with `/`. Type `/my-ext` not `my-ext`
- Check `/extensions` to see if the command was registered
- Commands from extensions show `[ext-name]` in their description

### Web UI not accessible

- Check the URL in `/extensions` output
- Verify the `staticDir` path is absolute and the directory exists
- Check that `web/index.html` exists in the static directory
- The server only binds to `127.0.0.1` - it's not accessible from other machines

### Disable all extensions

```bash
woodbury --no-extensions
```

This starts Woodbury with core functionality only, useful for debugging extension issues.
