/**
 * Extension Scaffold
 *
 * Generates a starter extension in ~/.woodbury/extensions/<name>/
 * with a package.json and index.js that demonstrates all four
 * extension capabilities: tools, slash commands, system prompts, and web UI.
 *
 * When the --web flag is used, also generates a site-knowledge/ directory
 * with research templates for web-navigation extensions.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSIONS_DIR } from './extension-loader.js';

/**
 * Options for scaffold generation.
 */
export interface ScaffoldOptions {
  /** Include site-knowledge templates for web-navigation extensions */
  webNavigation?: boolean;
}

// ────────────────────────────────────────────────────────────────
//  Site-knowledge template files
// ────────────────────────────────────────────────────────────────

const SITE_MAP_TEMPLATE = `# Site Map

> Document the key pages and navigation structure of the target site.
> Fill this in during the research phase before writing automation code.

## Primary Pages

| Page | URL Pattern | Purpose | Notes |
|------|-------------|---------|-------|
| Home | / | Landing page | |
| Login | /login | Authentication | |
| Dashboard | /dashboard | Main workspace | |
| | | | |

## Navigation Flow

\`\`\`
Home → Login → Dashboard → ...
\`\`\`

## URL Patterns

- Static pages: \`/about\`, \`/help\`
- Dynamic pages: \`/users/:id\`, \`/posts/:slug\`
- API-backed pages: \`/search?q=...\`

## Research Commands Used

\`\`\`
# Crawl the site to discover pages
web_crawl { "url": "https://example.com", "extract": "links" }

# Render JavaScript-heavy pages
web_crawl_rendered { "url": "https://example.com/app" }
\`\`\`
`;

const SELECTORS_TEMPLATE = `# Selectors

> Document CSS selectors and DOM structure for elements the extension interacts with.
> Prefer stable selectors: data-testid, aria-label, id > class > tag hierarchy.

## Key Elements

| Element | Selector | Page | Stability |
|---------|----------|------|-----------|
| Login button | \`[data-testid="login-btn"]\` | /login | High |
| Username input | \`#username\` | /login | High |
| Password input | \`#password\` | /login | High |
| | | | |

## Selector Strategy

1. **Best:** \`data-testid\`, \`data-cy\`, or \`aria-label\` attributes
2. **Good:** \`id\` attributes (usually stable)
3. **Okay:** Specific class names (may change with CSS frameworks)
4. **Avoid:** Tag-only selectors, deeply nested paths, positional selectors

## Dynamic Content

| Element | Appears When | Wait Strategy |
|---------|-------------|---------------|
| Loading spinner | Page load | Wait for removal |
| Modal | Button click | Wait for visible |
| | | |

## Research Commands Used

\`\`\`
# Find elements by text content
bridge_server.send("find_element_by_text", { text: "Sign In" })

# Get all clickable elements on a page
bridge_server.send("get_clickable_elements")

# Get form fields
bridge_server.send("get_form_fields")
\`\`\`
`;

const AUTH_FLOW_TEMPLATE = `# Auth Flow

> Document the authentication process: login, session management, token handling.

## Login Steps

1. Navigate to \`/login\`
2. Enter username in \`#username\`
3. Enter password in \`#password\`
4. Click \`[data-testid="login-btn"]\`
5. Wait for redirect to \`/dashboard\`

## Session Management

| Aspect | Detail |
|--------|--------|
| Auth type | Cookie / JWT / OAuth |
| Session storage | Cookie / localStorage / sessionStorage |
| Session duration | |
| Refresh mechanism | |

## OAuth / SSO (if applicable)

| Step | URL | Action |
|------|-----|--------|
| 1 | /auth/provider | Redirect |
| 2 | provider.com/authorize | User consent |
| 3 | /auth/callback | Token exchange |

## Logout

- URL: \`/logout\`
- Method: Click / API call
- Clears: Cookies, tokens, etc.

## Research Commands Used

\`\`\`
# Inspect the login page structure
web_crawl_rendered { "url": "https://example.com/login" }

# Check for OAuth endpoints
web_fetch { "url": "https://example.com/.well-known/openid-configuration" }
\`\`\`
`;

const API_ENDPOINTS_TEMPLATE = `# API Endpoints

> Document API endpoints the site uses, discovered via network inspection.

## REST Endpoints

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| POST | /api/login | Authenticate | No |
| GET | /api/user/me | Current user | Yes |
| GET | /api/posts | List posts | Yes |
| POST | /api/posts | Create post | Yes |
| | | | |

## Request / Response Patterns

### Example: Create Post

\`\`\`
POST /api/posts
Content-Type: application/json
Authorization: Bearer <token>

{
  "title": "...",
  "body": "...",
  "tags": ["..."]
}

→ 201 { "id": "...", "created_at": "..." }
\`\`\`

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| /api/* | 100 req | 1 min |
| /api/upload | 10 req | 1 min |

## Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| 401 | Unauthorized | Re-authenticate |
| 429 | Rate limited | Wait + retry |
| 500 | Server error | Retry with backoff |

## Research Commands Used

\`\`\`
# Fetch an API endpoint directly
web_fetch { "url": "https://example.com/api/posts", "method": "GET" }

# Inspect page to discover XHR/fetch calls
web_crawl_rendered { "url": "https://example.com/dashboard" }
\`\`\`
`;

const FORMS_TEMPLATE = `# Forms

> Document form structures, field validation, and submission behavior.

## Forms Inventory

| Form | Page | Purpose | Submit Method |
|------|------|---------|---------------|
| Login form | /login | Authentication | POST /api/login |
| Create post | /new | New content | POST /api/posts |
| | | | |

## Field Details

### Login Form

| Field | Selector | Type | Required | Validation |
|-------|----------|------|----------|------------|
| Username | \`#username\` | text | Yes | Min 3 chars |
| Password | \`#password\` | password | Yes | Min 8 chars |
| Remember | \`#remember\` | checkbox | No | |

### Create Post Form

| Field | Selector | Type | Required | Validation |
|-------|----------|------|----------|------------|
| Title | \`#title\` | text | Yes | Max 100 chars |
| Body | \`#body\` | textarea | Yes | Max 5000 chars |
| Tags | \`#tags\` | select | No | Multi-select |

## Submit Behavior

| Form | Success | Error | Redirect |
|------|---------|-------|----------|
| Login | 200 + cookie | 401 message | /dashboard |
| Create post | 201 + toast | Inline errors | /posts/:id |

## Research Commands Used

\`\`\`
# Get all form fields on a page
bridge_server.send("get_form_fields")

# Inspect a specific form
web_crawl_rendered { "url": "https://example.com/new" }
\`\`\`
`;

const QUIRKS_TEMPLATE = `# Quirks & Gotchas

> Document timing issues, unexpected behaviors, workarounds, and browser-specific notes.

## Timing Issues

| Issue | Where | Workaround |
|-------|-------|------------|
| Slow SPA transitions | /dashboard | Wait 2s after nav |
| Lazy-loaded content | /feed | Scroll to trigger |
| Debounced search | /search | Wait 500ms after typing |

## Browser-Specific

| Issue | Browser | Notes |
|-------|---------|-------|
| | | |

## Known Workarounds

### Issue: [Description]
- **Symptom:** What happens
- **Cause:** Why it happens
- **Workaround:** How to handle it

## Anti-Bot / Rate Limiting

| Protection | Details | Handling |
|-----------|---------|----------|
| CAPTCHA | On login after 3 failures | Cannot bypass — alert user |
| Cloudflare | Bot detection on /api | Use realistic request headers |
| Rate limits | 100 req/min | Add delays between requests |

## Content Loading

| Page | Loading Strategy | Wait For |
|------|-----------------|----------|
| /dashboard | SPA client render | \`[data-loaded="true"]\` |
| /feed | Infinite scroll | Scroll + wait for new items |

## Research Commands Used

\`\`\`
# Test page timing
web_crawl_rendered { "url": "https://example.com/dashboard" }

# Check response headers for rate-limit info
web_fetch { "url": "https://example.com/api/posts", "method": "HEAD" }
\`\`\`
`;

// ────────────────────────────────────────────────────────────────
//  Scaffold generator
// ────────────────────────────────────────────────────────────────

export async function scaffoldExtension(
  name: string,
  options?: ScaffoldOptions
): Promise<string> {
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

  // Generate appropriate index.js
  if (options?.webNavigation) {
    await generateWebNavigationIndexJs(dir, name, displayName);
    await generateSiteKnowledge(dir);
  } else {
    await generateStandardIndexJs(dir, name, displayName);
  }

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

// ────────────────────────────────────────────────────────────────
//  Standard index.js (default scaffold — no --web)
// ────────────────────────────────────────────────────────────────

async function generateStandardIndexJs(
  dir: string,
  name: string,
  displayName: string
): Promise<void> {
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
}

// ────────────────────────────────────────────────────────────────
//  Web-navigation index.js (--web scaffold)
// ────────────────────────────────────────────────────────────────

async function generateWebNavigationIndexJs(
  dir: string,
  name: string,
  displayName: string
): Promise<void> {
  await writeFile(
    join(dir, 'index.js'),
    `const fs = require('fs');
const path = require('path');

/**
 * ${displayName} — Woodbury Web-Navigation Extension
 *
 * This extension is designed for navigating and automating a website.
 * Site knowledge files in the site-knowledge/ directory are loaded
 * into the system prompt at activation so the agent understands
 * the target site's structure, selectors, auth flow, and quirks.
 *
 * Research workflow:
 *   1. Fill in site-knowledge/*.md files using Woodbury's tools
 *   2. Restart Woodbury to reload the knowledge
 *   3. Build tools that reference the documented selectors & flows
 */

/** Load all non-empty .md files from site-knowledge/ */
function loadSiteKnowledge(extDir) {
  const knowledgeDir = path.join(extDir, 'site-knowledge');
  const sections = [];

  try {
    const files = fs.readdirSync(knowledgeDir)
      .filter(f => f.endsWith('.md'))
      .sort();

    for (const file of files) {
      const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    }
  } catch (err) {
    // site-knowledge/ directory missing or unreadable — that's okay
  }

  return sections;
}

/** @type {{ activate: Function, deactivate?: Function }} */
module.exports = {
  async activate(ctx) {
    // ─── SITE KNOWLEDGE ──────────────────────────────────────
    // Load research docs into the system prompt so the agent
    // knows about the site's structure, selectors, and quirks.

    const knowledgeSections = loadSiteKnowledge(__dirname);

    if (knowledgeSections.length > 0) {
      ctx.addSystemPrompt(
        \`## ${displayName} — Site Knowledge\\n\\n\` +
        knowledgeSections.join('\\n\\n---\\n\\n')
      );
      ctx.log.info(\`Loaded \${knowledgeSections.length} site-knowledge file(s)\`);
    } else {
      ctx.log.warn('No site-knowledge files found. Run research to populate site-knowledge/*.md');
    }

    // ─── TOOLS ───────────────────────────────────────────────
    // Example: a navigation tool. Replace with your own.

    ctx.registerTool(
      {
        name: '${name.replace(/-/g, '_')}_navigate',
        description: 'Navigate to a page on the target site and return page info.',
        parameters: {
          type: 'object',
          properties: {
            page: {
              type: 'string',
              description: 'Page key from site-map (e.g. "dashboard", "login")',
            },
          },
          required: ['page'],
        },
        dangerous: false,
      },
      async (params) => {
        // TODO: Replace with real navigation logic using bridgeServer
        return \`[placeholder] Would navigate to: \${params.page}. ` +
        `Implement using ctx.bridgeServer or web_crawl_rendered.\`;
      }
    );

    // ─── SLASH COMMANDS ──────────────────────────────────────

    ctx.registerCommand({
      name: '${name}',
      description: '${displayName} commands',
      async handler(args, cmdCtx) {
        if (args[0] === 'knowledge') {
          // List loaded site-knowledge files
          const knowledgeDir = path.join(__dirname, 'site-knowledge');
          try {
            const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
            if (files.length === 0) {
              cmdCtx.print('No site-knowledge files found.');
            } else {
              cmdCtx.print('Site knowledge files:');
              for (const f of files) {
                const content = fs.readFileSync(path.join(knowledgeDir, f), 'utf-8').trim();
                const status = content ? '\\u2713' : '(empty)';
                cmdCtx.print(\`  \${status} \${f}\`);
              }
            }
          } catch {
            cmdCtx.print('site-knowledge/ directory not found.');
          }
        } else if (args[0] === 'status') {
          cmdCtx.print('${displayName} extension is active!');
          cmdCtx.print(\`Site knowledge sections loaded: \${knowledgeSections.length}\`);
        } else {
          cmdCtx.print('Usage:');
          cmdCtx.print('  /${name} knowledge  - List site-knowledge files');
          cmdCtx.print('  /${name} status     - Show extension status');
        }
      },
    });

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
}

// ────────────────────────────────────────────────────────────────
//  Site-knowledge template files
// ────────────────────────────────────────────────────────────────

async function generateSiteKnowledge(dir: string): Promise<void> {
  const knowledgeDir = join(dir, 'site-knowledge');
  await mkdir(knowledgeDir, { recursive: true });

  const templates: Record<string, string> = {
    'site-map.md': SITE_MAP_TEMPLATE,
    'selectors.md': SELECTORS_TEMPLATE,
    'auth-flow.md': AUTH_FLOW_TEMPLATE,
    'api-endpoints.md': API_ENDPOINTS_TEMPLATE,
    'forms.md': FORMS_TEMPLATE,
    'quirks.md': QUIRKS_TEMPLATE,
  };

  for (const [filename, content] of Object.entries(templates)) {
    await writeFile(join(knowledgeDir, filename), content);
  }
}
