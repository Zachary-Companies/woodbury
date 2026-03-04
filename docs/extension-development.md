# Woodbury Extension Development Guide

> This document is the complete reference for building Woodbury extensions.
> It is written for both human developers and LLM agents that assist with extension development.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Extension Structure](#extension-structure)
4. [package.json Manifest](#packagejson-manifest)
5. [activate(ctx) API Reference](#activatectx-api-reference)
6. [Environment Variables](#environment-variables)
7. [Complete Examples](#complete-examples)
8. [Publishing to the Marketplace](#publishing-to-the-marketplace)
9. [Conventions & Best Practices](#conventions--best-practices)

---

## Overview

Woodbury extensions are JavaScript modules that add capabilities to the Woodbury AI agent. Each extension can provide:

- **Tools** — Functions the agent can call (e.g., generate an image, send a message)
- **Commands** — Slash commands for the REPL (e.g., `/social status`)
- **System Prompts** — Instructions injected into the agent's system prompt
- **Web UIs** — Local HTTP servers for dashboards and configuration
- **Background Tasks** — Periodic tasks that run on a timer

### Where extensions live

Extensions are installed in `~/.woodbury/extensions/`. Each extension is a directory containing a `package.json` and a JavaScript entry point.

```
~/.woodbury/extensions/
  nanobanana/
    package.json
    index.js
    .env           (optional, holds API keys)
  elevenlabs/
    package.json
    index.js
    .env
```

### How extensions are discovered

Woodbury scans two locations at startup:

1. **Local directories**: `~/.woodbury/extensions/<name>/` — any subdirectory with a valid `package.json`
2. **npm packages**: `~/.woodbury/extensions/node_modules/woodbury-ext-*` — npm packages with the `woodbury-ext-` prefix

An extension is valid if its `package.json` contains a `woodbury` field with at least a `name` property, and its entry point file exists.

### How extensions are activated

1. Woodbury reads `package.json` and extracts the `woodbury` manifest
2. Woodbury loads the `.env` file from the extension's directory (if present)
3. Woodbury calls the extension's `activate(ctx)` function, passing an `ExtensionContext`
4. The extension uses `ctx` to register tools, commands, prompts, etc.

---

## Quick Start

Create a minimal extension in 3 files:

### 1. Create the directory

```bash
mkdir -p ~/.woodbury/extensions/my-extension
cd ~/.woodbury/extensions/my-extension
```

### 2. Create `package.json`

```json
{
  "name": "woodbury-ext-my-extension",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "woodbury": {
    "name": "my-extension",
    "displayName": "My Extension",
    "description": "A simple example extension",
    "provides": ["tools"],
    "env": {
      "MY_API_KEY": {
        "required": true,
        "description": "API key for the external service"
      }
    }
  }
}
```

### 3. Create `index.js`

```javascript
export async function activate(ctx) {
  const apiKey = ctx.env.MY_API_KEY;

  ctx.registerTool(
    {
      name: 'my_extension_hello',
      description: 'Says hello with a personalized greeting.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name to greet',
          },
        },
        required: ['name'],
      },
    },
    async (params) => {
      return { greeting: `Hello, ${params.name}!`, apiKeySet: !!apiKey };
    }
  );
}
```

### 4. Create `.env` (optional)

```
MY_API_KEY=your-key-here
```

### 5. Restart Woodbury

The extension will be discovered and activated on the next startup. The agent can now call the `my_extension_hello` tool.

---

## Extension Structure

A complete extension directory looks like this:

```
my-extension/
  package.json       # REQUIRED — contains woodbury manifest
  index.js           # REQUIRED — exports activate() function
  .env               # OPTIONAL — API keys and configuration
  web/               # OPTIONAL — static files for web UI
    index.html
    app.js
    styles.css
  node_modules/      # OPTIONAL — npm dependencies (if any)
```

### Entry point

The entry point file (usually `index.js`, configurable via `package.json` `main` field) must export an `activate` function. It can optionally export a `deactivate` function.

```javascript
// Named export (preferred)
export async function activate(ctx) {
  // Register tools, commands, prompts, etc.
}

// Optional cleanup
export async function deactivate() {
  // Clean up resources when extension is unloaded
}
```

Both default export and named export patterns are supported:

```javascript
// Default export (also works)
export default {
  async activate(ctx) { /* ... */ },
  async deactivate() { /* ... */ },
};
```

---

## package.json Manifest

The `package.json` file must include a `woodbury` field. Here is the complete reference:

```json
{
  "name": "woodbury-ext-example",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "woodbury": {
    "name": "example",
    "displayName": "Example Extension",
    "description": "What this extension does",
    "version": "1.0.0",
    "provides": ["tools", "commands", "prompts", "webui"],
    "env": {
      "API_KEY": {
        "required": true,
        "description": "API key for the service. Get one at https://example.com/keys"
      },
      "OUTPUT_DIR": {
        "required": false,
        "description": "Directory to save output files",
        "type": "path"
      }
    }
  }
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `woodbury.name` | `string` | **Yes** | Unique identifier for the extension (lowercase, no spaces). Used in CLI commands and as the directory name. |
| `woodbury.displayName` | `string` | No | Human-readable name shown in the dashboard. Falls back to `name` if not set. |
| `woodbury.description` | `string` | No | What the extension does. Shown in the marketplace and dashboard. |
| `woodbury.version` | `string` | No | Semantic version. Falls back to `package.json` `version`. |
| `woodbury.provides` | `string[]` | No | What the extension provides. Valid values: `"tools"`, `"commands"`, `"prompts"`, `"webui"`. Used for display badges in the marketplace. |
| `woodbury.env` | `object` | No | Declares environment variables the extension needs. Each key is the variable name. |
| `woodbury.env.<KEY>.required` | `boolean` | No | If `true`, Woodbury warns on startup if this variable is missing from `.env`. |
| `woodbury.env.<KEY>.description` | `string` | No | Describes what this variable is for. Shown in the dashboard configuration UI. |
| `woodbury.env.<KEY>.type` | `string` | No | Type hint for the dashboard UI. `"path"` shows a folder picker. `"string"` (default) shows a text input. |

### Important notes

- `"type": "module"` is **recommended** for ESM support (use `import`/`export`). Without it, use CommonJS (`require`/`module.exports`).
- The `main` field defaults to `"index.js"` if not specified.
- The `name` field in `package.json` (top-level) should use the `woodbury-ext-` prefix by convention, but the `woodbury.name` field is the one that matters for Woodbury.

---

## activate(ctx) API Reference

The `activate` function receives an `ExtensionContext` object with these methods and properties:

### ctx.registerTool(definition, handler)

Registers a tool that the AI agent can call. This is the most common extension capability.

**Parameters:**

- `definition` — Tool definition object:
  - `name` (`string`) — Unique tool name. Convention: `extensionname_toolname` (e.g., `nanobanana_generate`).
  - `description` (`string`) — What the tool does. The agent uses this to decide when to call it. Be specific and include usage guidance.
  - `parameters` (`object`) — JSON Schema describing the tool's input parameters. Use standard JSON Schema format with `type`, `properties`, `required`, `enum`, `description`, etc.
  - `dangerous` (`boolean`, optional) — If `true`, the tool requires user confirmation before execution.
- `handler` — Async function `(params, context) => Promise<any>`:
  - `params` — The parameters object matching the JSON Schema.
  - `context` — Tool context with `workingDirectory`, `signal` (AbortSignal), etc.
  - Return value is serialized as JSON and shown to the agent.

**Example:**

```javascript
ctx.registerTool(
  {
    name: 'weather_get',
    description: 'Get current weather for a city. Returns temperature, conditions, and humidity.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name (e.g., "San Francisco")',
        },
        units: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Temperature units. Default: celsius.',
        },
      },
      required: ['city'],
    },
  },
  async (params) => {
    const response = await fetch(`https://api.weather.com/v1?city=${params.city}&units=${params.units || 'celsius'}`);
    const data = await response.json();
    return { temperature: data.temp, conditions: data.conditions, humidity: data.humidity };
  }
);
```

### ctx.registerCommand(command)

Registers a slash command for the REPL interface.

**Parameters:**

- `command` — Command object:
  - `name` (`string`) — Command name without the leading slash (e.g., `"social"` for `/social`).
  - `description` (`string`) — What the command does. Shown in help.
  - `handler` (`async (args, ctx) => void`) — Handler function:
    - `args` (`string[]`) — Command arguments split by whitespace.
    - `ctx.workingDirectory` (`string`) — Current working directory.
    - `ctx.print` (`(message: string) => void`) — Print output to the REPL.

**Example:**

```javascript
ctx.registerCommand({
  name: 'myext',
  description: 'Show extension status and configuration',
  handler: async (args, ctx) => {
    if (args[0] === 'status') {
      ctx.print('Extension is active and connected.');
    } else if (args[0] === 'help') {
      ctx.print('Usage: /myext status | help');
    } else {
      ctx.print('Unknown subcommand. Try /myext help');
    }
  },
});
```

### ctx.addSystemPrompt(section)

Adds text to the agent's system prompt. This is injected after Woodbury's built-in system prompt sections. Use this to give the agent context about your extension's capabilities, conventions, and best practices.

**Parameters:**

- `section` (`string`) — Text to add to the system prompt. Can be multi-line. Markdown formatting is supported.

**Example:**

```javascript
ctx.addSystemPrompt(`
## Weather Extension

You have access to the weather_get tool for checking current weather conditions.

**Usage tips:**
- Always specify the city name clearly
- Default units are Celsius; ask the user if they prefer Fahrenheit
- The tool returns temperature, conditions, and humidity
`);
```

### ctx.serveWebUI(options)

Starts a local HTTP server that serves static files from a directory. Use this for dashboards, configuration UIs, or any web-based interface.

**Parameters:**

- `options` — WebUI options:
  - `staticDir` (`string`) — Absolute path to the directory containing static files (must include `index.html`).
  - `port` (`number`, optional) — Port to serve on. Default: `0` (auto-assign a free port).
  - `label` (`string`, optional) — Human-readable label shown in the extensions list.

**Returns:** `Promise<WebUIHandle>` with:
- `url` (`string`) — The URL where the web UI is accessible (e.g., `http://127.0.0.1:43210`).
- `port` (`number`) — The assigned port number.
- `close()` — Async function to stop the server.

**Example:**

```javascript
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function activate(ctx) {
  const webUI = await ctx.serveWebUI({
    staticDir: join(__dirname, 'web'),
    label: 'My Dashboard',
  });

  ctx.log.info(`Dashboard running at ${webUI.url}`);
}
```

### ctx.registerBackgroundTask(handler, options)

Registers a periodic task that runs on a timer. Background tasks run while the REPL is active. If the handler returns a non-empty string, it is injected into the agent loop as if the user typed it.

**Parameters:**

- `handler` — Async function `() => Promise<string | null | undefined>`:
  - Return a string to inject it as an agent message.
  - Return `null` or `undefined` to do nothing.
- `options` — Background task options:
  - `intervalMs` (`number`) — Interval in milliseconds between invocations. Minimum: `10000` (10 seconds).
  - `label` (`string`, optional) — Human-readable label for logs and the tasks list.
  - `runImmediately` (`boolean`, optional) — If `true`, run the handler immediately on registration in addition to the interval. Default: `false`.

**Example:**

```javascript
ctx.registerBackgroundTask(
  async () => {
    const duePosts = await checkForDuePosts();
    if (duePosts.length > 0) {
      return `There are ${duePosts.length} social media posts scheduled for now. Use social_post_due to post them.`;
    }
    return null; // Nothing to do
  },
  {
    intervalMs: 60000, // Check every minute
    label: 'Due Post Checker',
    runImmediately: false,
  }
);
```

### ctx.env

A frozen (read-only) object containing the extension's environment variables, loaded from the `.env` file in the extension's directory. Extensions only see their own variables.

```javascript
const apiKey = ctx.env.MY_API_KEY;  // string or undefined
const outputDir = ctx.env.OUTPUT_DIR || ctx.workingDirectory;
```

### ctx.workingDirectory

The current working directory (string). Use this as the default location for file operations.

### ctx.log

Logger object for output. Messages are routed through Woodbury's logging system.

```javascript
ctx.log.info('Extension loaded successfully');
ctx.log.warn('API key not set — some features disabled');
ctx.log.error('Failed to connect to service');
ctx.log.debug('Processing request with params: ...');
```

Note: `info` and `debug` messages are only shown in verbose mode. `warn` and `error` are always shown.

### ctx.bridgeServer

Access to the Chrome extension bridge for browser automation.

```javascript
// Check if Chrome extension is connected
if (ctx.bridgeServer.isConnected) {
  // Send a command to the browser
  const result = await ctx.bridgeServer.send('navigate', { url: 'https://example.com' });
}
```

**Available bridge actions:**

- `navigate` — Navigate to a URL: `{ url: string }`
- `screenshot` — Take a screenshot: `{}` (returns base64 image)
- `click` — Click an element: `{ selector: string }` or `{ x: number, y: number }`
- `type` — Type text: `{ selector: string, text: string }`
- `evaluate` — Run JavaScript: `{ code: string }`
- `waitForSelector` — Wait for an element: `{ selector: string, timeout?: number }`

---

## Environment Variables

Extensions store their configuration in a `.env` file in their directory. The dashboard provides a UI for users to edit these values.

### .env file format

```bash
# Lines starting with # are comments
API_KEY=sk-abc123
OUTPUT_DIR=/Users/me/output

# Values with spaces or special characters can be quoted
GREETING="Hello, World!"
PATH_WITH_SPACES='/Users/me/My Documents'
```

### Declaring variables in package.json

Declare expected environment variables in the `woodbury.env` field of `package.json`. This enables:
- Dashboard UI for configuring the extension
- Startup warnings for missing required variables
- Type hints for the UI (e.g., `"path"` type shows a folder picker)

```json
{
  "woodbury": {
    "env": {
      "API_KEY": {
        "required": true,
        "description": "API key for the service"
      },
      "OUTPUT_DIR": {
        "required": false,
        "description": "Where to save output files",
        "type": "path"
      },
      "MODEL": {
        "required": false,
        "description": "Model to use (default: gpt-4)"
      }
    }
  }
}
```

### Accessing variables in code

```javascript
export async function activate(ctx) {
  // ctx.env contains all key-value pairs from .env
  const apiKey = ctx.env.API_KEY;
  const outputDir = ctx.env.OUTPUT_DIR || ctx.workingDirectory;

  if (!apiKey) {
    ctx.log.warn('API_KEY not set. Extension will have limited functionality.');
    return;
  }

  // Register tools that use the API key...
}
```

---

## Complete Examples

### Example 1: Minimal API Tool

A simple extension that calls an external API. Pattern used by **ElevenLabs TTS**.

```javascript
// package.json
// {
//   "name": "woodbury-ext-translate",
//   "version": "1.0.0",
//   "main": "index.js",
//   "type": "module",
//   "woodbury": {
//     "name": "translate",
//     "displayName": "Translator",
//     "description": "Translate text between languages using DeepL API",
//     "provides": ["tools", "prompts"],
//     "env": {
//       "DEEPL_API_KEY": {
//         "required": true,
//         "description": "DeepL API key. Get one at https://deepl.com/pro-api"
//       }
//     }
//   }
// }

export async function activate(ctx) {
  const apiKey = ctx.env.DEEPL_API_KEY;

  // Register the translation tool
  ctx.registerTool(
    {
      name: 'translate_text',
      description: 'Translate text from one language to another using DeepL. Supports 30+ languages.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to translate',
          },
          target_lang: {
            type: 'string',
            description: 'Target language code (e.g., "EN", "DE", "FR", "ES", "JA")',
          },
          source_lang: {
            type: 'string',
            description: 'Source language code. Optional — auto-detected if omitted.',
          },
        },
        required: ['text', 'target_lang'],
      },
    },
    async (params) => {
      if (!apiKey) {
        return { error: 'DEEPL_API_KEY not configured. Set it in the Woodbury dashboard under Config > Translator.' };
      }

      const body = new URLSearchParams({
        text: params.text,
        target_lang: params.target_lang.toUpperCase(),
      });
      if (params.source_lang) {
        body.append('source_lang', params.source_lang.toUpperCase());
      }

      const res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return { error: `DeepL API error: ${res.status} ${errorText}` };
      }

      const data = await res.json();
      const translation = data.translations[0];

      return {
        translated_text: translation.text,
        detected_source_language: translation.detected_source_language,
        target_language: params.target_lang.toUpperCase(),
      };
    }
  );

  // Add system prompt so the agent knows about translation
  ctx.addSystemPrompt(`
## Translator Extension

You have access to the translate_text tool for translating text between languages.
Supported languages include: English (EN), German (DE), French (FR), Spanish (ES),
Italian (IT), Japanese (JA), Chinese (ZH), Korean (KO), Portuguese (PT), and more.
Use ISO language codes.
  `);
}
```

### Example 2: Browser Automation Extension

An extension that controls the browser via the bridge. Pattern used by **Instagram Poster**.

```javascript
// package.json
// {
//   "name": "woodbury-ext-web-poster",
//   "version": "1.0.0",
//   "main": "index.js",
//   "type": "module",
//   "woodbury": {
//     "name": "web-poster",
//     "displayName": "Web Poster",
//     "description": "Post content to websites via browser automation",
//     "provides": ["tools", "prompts"],
//     "env": {}
//   }
// }

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function activate(ctx) {
  ctx.registerTool(
    {
      name: 'web_poster_post',
      description: 'Post content to a website by automating the browser. Requires the Chrome extension to be connected.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL of the page to post on',
          },
          content: {
            type: 'string',
            description: 'Text content to post',
          },
          selector: {
            type: 'string',
            description: 'CSS selector of the text input field',
          },
          submit_selector: {
            type: 'string',
            description: 'CSS selector of the submit/post button',
          },
        },
        required: ['url', 'content', 'selector', 'submit_selector'],
      },
    },
    async (params) => {
      // Check bridge connection
      if (!ctx.bridgeServer.isConnected) {
        return {
          error: 'Chrome extension is not connected. Please install and enable the Woodbury Chrome extension.',
        };
      }

      try {
        // Navigate to the page
        await ctx.bridgeServer.send('navigate', { url: params.url });

        // Wait for the input field
        await ctx.bridgeServer.send('waitForSelector', {
          selector: params.selector,
          timeout: 10000,
        });

        // Type the content
        await ctx.bridgeServer.send('type', {
          selector: params.selector,
          text: params.content,
        });

        // Click submit
        await ctx.bridgeServer.send('click', {
          selector: params.submit_selector,
        });

        return { success: true, message: 'Content posted successfully' };
      } catch (err) {
        return { error: `Failed to post: ${err.message}` };
      }
    }
  );

  // System prompt
  ctx.addSystemPrompt(`
## Web Poster Extension

You can post content to websites using the web_poster_post tool.
This requires the Chrome extension to be connected to Woodbury.
The user must be logged into the target website in Chrome.
  `);

  // Status command
  ctx.registerCommand({
    name: 'web-poster',
    description: 'Check Web Poster status',
    handler: async (args, cmdCtx) => {
      cmdCtx.print(
        ctx.bridgeServer.isConnected
          ? 'Chrome extension connected. Ready to post.'
          : 'Chrome extension not connected.'
      );
    },
  });
}
```

### Example 3: Extension with Web UI

An extension that serves a dashboard. Pattern used by **Social Scheduler**.

```javascript
// package.json
// {
//   "name": "woodbury-ext-dashboard",
//   "version": "1.0.0",
//   "main": "index.js",
//   "type": "module",
//   "woodbury": {
//     "name": "dashboard",
//     "displayName": "My Dashboard",
//     "description": "Custom dashboard with web UI",
//     "provides": ["tools", "webui"],
//     "env": {
//       "DASHBOARD_PORT": {
//         "required": false,
//         "description": "Port for the dashboard (default: auto)"
//       }
//     }
//   }
// }

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function activate(ctx) {
  // Data directory
  const dataDir = join(homedir(), '.woodbury', 'my-dashboard');
  await mkdir(dataDir, { recursive: true });
  const dataFile = join(dataDir, 'data.json');

  // Load existing data
  let data = [];
  try {
    data = JSON.parse(await readFile(dataFile, 'utf-8'));
  } catch {
    // No existing data
  }

  // Start the web UI
  const port = ctx.env.DASHBOARD_PORT ? parseInt(ctx.env.DASHBOARD_PORT) : 0;
  const webUI = await ctx.serveWebUI({
    staticDir: join(__dirname, 'web'),
    port,
    label: 'My Dashboard',
  });

  ctx.log.info(`Dashboard running at ${webUI.url}`);

  // Tool to add data
  ctx.registerTool(
    {
      name: 'dashboard_add_item',
      description: 'Add an item to the dashboard',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Item title' },
          content: { type: 'string', description: 'Item content' },
        },
        required: ['title', 'content'],
      },
    },
    async (params) => {
      const item = {
        id: Date.now().toString(),
        title: params.title,
        content: params.content,
        createdAt: new Date().toISOString(),
      };
      data.push(item);
      await writeFile(dataFile, JSON.stringify(data, null, 2));
      return { success: true, item, dashboardUrl: webUI.url };
    }
  );

  // System prompt
  ctx.addSystemPrompt(`
## Dashboard Extension

You have a custom dashboard at ${webUI.url}.
Use dashboard_add_item to add items to the dashboard.
  `);
}
```

### Example 4: Background Task Extension

An extension with a periodic background task. Pattern used by **Social Scheduler** for checking due posts.

```javascript
// package.json
// {
//   "name": "woodbury-ext-monitor",
//   "version": "1.0.0",
//   "main": "index.js",
//   "type": "module",
//   "woodbury": {
//     "name": "monitor",
//     "displayName": "Site Monitor",
//     "description": "Monitor websites and alert when they go down",
//     "provides": ["tools", "prompts"],
//     "env": {
//       "MONITOR_URLS": {
//         "required": false,
//         "description": "Comma-separated list of URLs to monitor"
//       },
//       "CHECK_INTERVAL_MS": {
//         "required": false,
//         "description": "Check interval in milliseconds (default: 60000)"
//       }
//     }
//   }
// }

export async function activate(ctx) {
  const urls = (ctx.env.MONITOR_URLS || '').split(',').map(u => u.trim()).filter(Boolean);
  const intervalMs = parseInt(ctx.env.CHECK_INTERVAL_MS) || 60000;

  // Track status per URL
  const status = {};

  // Tool to add a URL to monitor
  ctx.registerTool(
    {
      name: 'monitor_add_url',
      description: 'Add a URL to the monitoring list',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to monitor' },
        },
        required: ['url'],
      },
    },
    async (params) => {
      if (!urls.includes(params.url)) {
        urls.push(params.url);
      }
      return { monitoring: urls };
    }
  );

  // Tool to check status
  ctx.registerTool(
    {
      name: 'monitor_status',
      description: 'Get the current status of all monitored URLs',
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      return { urls, status };
    }
  );

  // Background task to check URLs
  if (urls.length > 0) {
    ctx.registerBackgroundTask(
      async () => {
        const alerts = [];

        for (const url of urls) {
          try {
            const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
            const wasDown = status[url] === 'down';
            status[url] = res.ok ? 'up' : 'down';

            if (!res.ok) {
              alerts.push(`${url} is DOWN (HTTP ${res.status})`);
            } else if (wasDown) {
              alerts.push(`${url} is back UP`);
            }
          } catch (err) {
            const wasDown = status[url] === 'down';
            status[url] = 'down';
            if (!wasDown) {
              alerts.push(`${url} is DOWN (${err.message})`);
            }
          }
        }

        if (alerts.length > 0) {
          return `Site Monitor Alert: ${alerts.join('; ')}`;
        }
        return null; // All good, nothing to report
      },
      {
        intervalMs,
        label: 'Site Monitor Check',
        runImmediately: true,
      }
    );
  }

  ctx.addSystemPrompt(`
## Site Monitor Extension

Monitors website availability. Use monitor_add_url to add URLs.
Use monitor_status to check current status.
Background checks run every ${intervalMs / 1000} seconds.
  `);
}
```

---

## Publishing to the Marketplace

To make your extension available in the Woodbury Marketplace:

### 1. Create a GitHub repository

Name it `woodbury-ext-<name>` (e.g., `woodbury-ext-translate`). Push your extension code.

### 2. Add to the registry

Submit a PR to the [Woodbury repository](https://github.com/Zachary-Companies/woodbury) to add your extension to `apps/woodbury-web/public/registry.json`:

```json
{
  "name": "translate",
  "displayName": "Translator",
  "description": "Translate text between languages using DeepL API.",
  "version": "1.0.0",
  "author": "Your Name",
  "category": "automation",
  "provides": ["tools", "prompts"],
  "gitUrl": "https://github.com/YourOrg/woodbury-ext-translate.git",
  "repoUrl": "https://github.com/YourOrg/woodbury-ext-translate",
  "icon": "share",
  "tags": ["translate", "language", "deepl"],
  "platforms": ["darwin", "win32"],
  "featured": false
}
```

### 3. Registry fields

| Field | Description |
|-------|-------------|
| `name` | Must match `woodbury.name` in your package.json |
| `displayName` | Human-readable name |
| `description` | Short description (one sentence) |
| `version` | Current version |
| `author` | Author or organization name |
| `category` | One of: `"media"`, `"social"`, `"automation"` |
| `provides` | Array: `"tools"`, `"commands"`, `"prompts"`, `"webui"` |
| `gitUrl` | HTTPS git clone URL (ends in `.git`) |
| `repoUrl` | GitHub repository URL (for "View Source" link) |
| `icon` | Icon key: `"image"`, `"audio"`, `"share"`, `"video"`, `"calendar"`, `"music"` |
| `tags` | Array of search keywords |
| `platforms` | Array: `"darwin"` (macOS), `"win32"` (Windows), `"linux"` |
| `featured` | If `true`, highlighted in the marketplace |

### Installation methods

Once in the registry, users can install your extension via:

1. **Marketplace UI** — Browse at woodbury.bot/extensions or the in-app Marketplace tab, click "Install"
2. **Protocol link** — Click `woodbury://install/<name>?git=<gitUrl>` (opens the app and installs)
3. **CLI** — Run `woodbury ext install-git <gitUrl>`

---

## Conventions & Best Practices

### Tool naming

Use the pattern `extensionname_toolname` to avoid collisions:

```
nanobanana_generate    (not just "generate")
elevenlabs_speak       (not just "speak")
social_create_post     (not just "create_post")
```

### Error handling

Always return error objects instead of throwing. The agent can read the error and retry or inform the user:

```javascript
async (params) => {
  try {
    const result = await doSomething(params);
    return { success: true, data: result };
  } catch (err) {
    return { error: `Operation failed: ${err.message}` };
  }
}
```

### API key validation

Check for required API keys early and return helpful messages:

```javascript
if (!apiKey) {
  return {
    error: 'API_KEY not configured. Set it in the Woodbury dashboard: Config tab > Extension Name > API_KEY',
  };
}
```

### Keep dependencies minimal

Extensions should minimize npm dependencies. For many use cases, Node.js built-in modules (`fetch`, `fs`, `path`, `crypto`, `url`) and direct HTTP API calls are sufficient. This keeps extensions lightweight and reduces installation time.

### File output

When writing files, use `ctx.workingDirectory` as the default output location, but respect user-configured output directories from env vars:

```javascript
const outputDir = ctx.env.OUTPUT_DIR || ctx.workingDirectory;
const filePath = join(outputDir, filename);
```

### System prompts

Keep system prompt sections concise but informative. Include:
- What tools are available and what they do
- Usage tips and common patterns
- Important limitations or requirements

### Module format

Use ES modules (`"type": "module"` in package.json, `import`/`export` syntax). This is the recommended pattern for Woodbury extensions.

### No global state leaks

Keep all state within the `activate` function's closure. Don't pollute global scope:

```javascript
// Good — state in closure
export async function activate(ctx) {
  let connectionState = null;
  ctx.registerTool({ /* ... */ }, async (params) => {
    // Uses connectionState from closure
  });
}

// Bad — global state
let globalState = null;  // Don't do this
export async function activate(ctx) { /* ... */ }
```
