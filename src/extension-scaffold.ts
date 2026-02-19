/**
 * Extension Scaffold
 *
 * Generates a starter extension in ~/.woodbury/extensions/<name>/
 * with a package.json and index.js that demonstrates all four
 * extension capabilities: tools, slash commands, system prompts, and web UI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSIONS_DIR } from './extension-loader.js';

export async function scaffoldExtension(name: string): Promise<string> {
  // Validate name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Extension name must be lowercase alphanumeric with hyphens (e.g. "social-media"). Got: "${name}"`
    );
  }

  const dir = join(EXTENSIONS_DIR, name);
  const webDir = join(dir, 'web');

  // Create directories
  await mkdir(dir, { recursive: true });
  await mkdir(webDir, { recursive: true });

  // package.json
  const displayName = name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `woodbury-ext-${name}`,
        version: '0.1.0',
        main: 'index.js',
        woodbury: {
          name,
          displayName,
          description: `Woodbury extension: ${displayName}`,
          provides: ['tools', 'commands', 'prompts', 'webui'],
        },
      },
      null,
      2
    ) + '\n'
  );

  // index.js — the extension entry point
  await writeFile(
    join(dir, 'index.js'),
    `const path = require('path');

/**
 * ${displayName} — Woodbury Extension
 *
 * This is a starter extension. Edit this file to add your own
 * tools, slash commands, system prompt additions, and web UI.
 */

/** @type {{ activate: Function, deactivate?: Function }} */
module.exports = {
  async activate(ctx) {
    // ─── TOOLS ───────────────────────────────────────────────
    // Tools are capabilities the AI agent can call during conversations.

    ctx.registerTool(
      {
        name: '${name.replace(/-/g, '_')}_hello',
        description: 'A sample tool from the ${name} extension. Returns a greeting.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'A message to include in the greeting',
            },
          },
          required: ['message'],
        },
        dangerous: false,
      },
      async (params) => {
        return \`Hello from ${displayName}! You said: \${params.message}\`;
      }
    );

    // ─── SLASH COMMANDS ──────────────────────────────────────
    // Slash commands are user-facing REPL commands (e.g. /${name}).

    ctx.registerCommand({
      name: '${name}',
      description: '${displayName} commands',
      async handler(args, cmdCtx) {
        if (args[0] === 'status') {
          cmdCtx.print('${displayName} extension is active!');
        } else if (args[0] === 'dashboard') {
          cmdCtx.print('Web dashboard: (start the web UI to get a URL)');
        } else {
          cmdCtx.print('Usage:');
          cmdCtx.print('  /${name} status     - Show extension status');
          cmdCtx.print('  /${name} dashboard  - Open web dashboard');
        }
      },
    });

    // ─── SYSTEM PROMPT ───────────────────────────────────────
    // Extra instructions injected into the agent's system prompt.

    ctx.addSystemPrompt(\`## ${displayName} Extension
You have access to the ${displayName} extension tools:
- \\\`${name.replace(/-/g, '_')}_hello\\\` — Send a greeting (sample tool).

When the user asks about ${name.replace(/-/g, ' ')}, use the extension tools.\`);

    // ─── WEB UI (optional) ───────────────────────────────────
    // Uncomment to serve a local web dashboard:
    //
    // const handle = await ctx.serveWebUI({
    //   staticDir: path.join(__dirname, 'web'),
    //   label: '${displayName} Dashboard',
    // });
    // ctx.log.info(\`Dashboard at \${handle.url}\`);

    ctx.log.info('${displayName} extension activated');
  },

  async deactivate() {
    // Clean up any resources (connections, timers, etc.)
  },
};
`
  );

  // web/index.html — starter web UI
  await writeFile(
    join(webDir, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayName} — Woodbury Extension</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
    }
    h1 { color: #7c3aed; margin-bottom: 0.5rem; }
    p { color: #94a3b8; margin-bottom: 2rem; }
    .card {
      background: #1e293b;
      border-radius: 8px;
      padding: 1.5rem;
      max-width: 600px;
      width: 100%;
    }
    .card h2 { color: #06b6d4; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .card pre {
      background: #0f172a;
      border-radius: 4px;
      padding: 1rem;
      overflow-x: auto;
      font-size: 0.875rem;
      color: #a5d6ff;
    }
  </style>
</head>
<body>
  <h1>${displayName}</h1>
  <p>Woodbury Extension Dashboard</p>
  <div class="card">
    <h2>Getting Started</h2>
    <pre>
1. Edit ~/.woodbury/extensions/${name}/index.js
2. Uncomment the serveWebUI section
3. Restart Woodbury
4. This dashboard will be served at the URL shown
    </pre>
  </div>
</body>
</html>
`
  );

  return dir;
}
