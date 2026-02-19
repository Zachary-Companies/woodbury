# Testing Woodbury Extensions

This guide covers how to test extensions at every level: unit testing individual tools, integration testing with the extension manager, and end-to-end verification in the REPL.

## Quick Smoke Test

After creating or modifying an extension, verify it works end-to-end:

```bash
# 1. Check discovery
woodbury ext list

# 2. Start the REPL and verify activation
woodbury -v
# Look for: ✓ Extensions: my-ext

# 3. In the REPL, check it loaded
/extensions

# 4. Test slash commands
/my-ext status

# 5. Test tools by asking the agent
> Use the my_ext_hello tool with the message "test"
```

## Unit Testing Tools

Test tool handlers as standalone functions. No need to involve the extension system:

```javascript
// tests/social-draft.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('social_draft tool', () => {
  let draftsFile;
  let draftTool;

  beforeEach(() => {
    // Create a temp file for drafts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-test-'));
    draftsFile = path.join(tmpDir, 'drafts.json');
    fs.writeFileSync(draftsFile, '[]');

    // Import the tool handler, passing the temp drafts file path
    // (your extension should accept a config or use dependency injection)
    draftTool = require('../lib/tools/draft');
    draftTool.setDraftsFile(draftsFile);
  });

  afterEach(() => {
    // Clean up temp files
    fs.rmSync(path.dirname(draftsFile), { recursive: true, force: true });
  });

  it('should save a draft and return a success message', async () => {
    const result = await draftTool.handler({
      platform: 'twitter',
      content: 'Hello world!',
    });

    expect(result).toContain('Draft saved');
    expect(result).toContain('ID:');

    // Verify it was persisted
    const drafts = JSON.parse(fs.readFileSync(draftsFile, 'utf-8'));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].platform).toBe('twitter');
    expect(drafts[0].content).toBe('Hello world!');
  });

  it('should respect platform character limits', async () => {
    const longContent = 'x'.repeat(300);
    await expect(draftTool.handler({
      platform: 'twitter',
      content: longContent,
    })).rejects.toThrow(/280 character/);
  });

  it('should throw on missing required parameters', async () => {
    await expect(draftTool.handler({
      content: 'No platform specified',
    })).rejects.toThrow(/platform/);
  });
});
```

**Key patterns:**
- Test the handler function directly, not through the extension context
- Use temporary files/directories for state
- Test success cases, error cases, and edge cases
- Test that errors throw with descriptive messages (the agent reads them)

## Integration Testing with ExtensionManager

Test that your extension integrates correctly with Woodbury's extension lifecycle:

```javascript
// tests/integration.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('social extension integration', () => {
  let extensionDir;

  beforeAll(async () => {
    // Point to your extension directory
    extensionDir = path.resolve(__dirname, '..');
  });

  it('should activate without errors', async () => {
    // Simulate the ExtensionContext
    const tools = [];
    const commands = [];
    const prompts = [];

    const ctx = {
      workingDirectory: os.tmpdir(),
      registerTool: (def, handler) => tools.push({ definition: def, handler }),
      registerCommand: (cmd) => commands.push(cmd),
      addSystemPrompt: (section) => prompts.push(section),
      serveWebUI: async (opts) => ({
        url: 'http://127.0.0.1:0',
        port: 0,
        close: async () => {},
      }),
      log: {
        info: () => {},
        warn: console.warn,
        error: console.error,
        debug: () => {},
      },
      bridgeServer: {
        send: async () => ({}),
        get isConnected() { return false; },
      },
    };

    // Load and activate the extension
    const ext = require(path.join(extensionDir, 'index.js'));
    await ext.activate(ctx);

    // Verify registrations
    expect(tools.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('should register tools with correct schema', async () => {
    const tools = [];
    const ctx = createMockContext({ tools });

    const ext = require(path.join(extensionDir, 'index.js'));
    await ext.activate(ctx);

    for (const { definition } of tools) {
      // Every tool must have a name, description, and parameters
      expect(definition.name).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(definition.parameters).toBeDefined();
      expect(definition.parameters.type).toBe('object');

      // Name should be underscore-prefixed with extension name
      expect(definition.name).toMatch(/^social_/);
    }
  });

  it('should handle deactivation gracefully', async () => {
    const ext = require(path.join(extensionDir, 'index.js'));
    const ctx = createMockContext();

    await ext.activate(ctx);

    // Deactivate should not throw
    if (ext.deactivate) {
      await expect(ext.deactivate()).resolves.not.toThrow();
    }
  });
});

function createMockContext(storage = {}) {
  return {
    workingDirectory: os.tmpdir(),
    registerTool: (def, handler) => (storage.tools || []).push({ definition: def, handler }),
    registerCommand: (cmd) => (storage.commands || []).push(cmd),
    addSystemPrompt: (section) => (storage.prompts || []).push(section),
    serveWebUI: async () => ({ url: 'http://127.0.0.1:0', port: 0, close: async () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    bridgeServer: { send: async () => ({}), get isConnected() { return false; } },
  };
}
```

## Testing with Woodbury's Test Infrastructure

If you want to test your extension using the same patterns as Woodbury's core tests, here's how the test infrastructure works:

### Test Framework

Woodbury uses **Jest** with `ts-jest` for `src/__tests__/` tests. Configuration is in `jest.config.js`:

```javascript
// Key settings:
{
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: { '^(\\.\\.?/.*)\\.js$': '$1' },  // Maps .js imports to .ts
  setupFiles: ['<rootDir>/src/__tests__/setup-mocks.js'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
}
```

### Mock Setup

Woodbury mocks ESM-only dependencies (chalk, ora, marked-terminal) for Jest compatibility:

- `setup-mocks.js` runs before the test framework — intercepts `require('chalk')` with a chainable mock
- `setup.ts` runs after framework init — mocks chalk via `jest.mock()`, plus ora and marked-terminal

The chalk mock supports all color methods, modifiers, `.hex()`, `.bgHex()`, `.rgb()`, `.bgRgb()`, and `visible`.

### Writing Extension Tests in Woodbury's Style

```typescript
// src/__tests__/extension-my-ext.test.ts

// Mock dependencies your extension uses
jest.mock('../bridge-server.js', () => ({
  bridgeServer: {
    send: jest.fn().mockResolvedValue({}),
    get isConnected() { return false; },
  },
}));

// Mock the loader to control what gets discovered
const mockDiscoverExtensions = jest.fn().mockResolvedValue([]);
const mockLoadExtension = jest.fn();

jest.mock('../extension-loader.js', () => ({
  discoverExtensions: (...args: any[]) => mockDiscoverExtensions(...args),
  loadExtension: (...args: any[]) => mockLoadExtension(...args),
  EXTENSIONS_DIR: '/tmp/test-ext',
}));

import { ExtensionManager } from '../extension-manager';
import type { ExtensionContext } from '../extension-api';

describe('MyExtension via ExtensionManager', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ExtensionManager('/tmp/test-project', false);
  });

  afterEach(async () => {
    await manager.deactivateAll();
  });

  it('should register expected tools', async () => {
    const manifest = {
      packageName: 'woodbury-ext-my-ext',
      name: 'my-ext',
      displayName: 'My Extension',
      description: 'Test',
      version: '1.0.0',
      provides: ['tools'],
      entryPoint: '/fake/path/index.js',
      source: 'local' as const,
      directory: '/fake/path',
    };

    mockDiscoverExtensions.mockResolvedValue([manifest]);
    mockLoadExtension.mockResolvedValue({
      manifest,
      module: {
        activate: (ctx: ExtensionContext) => {
          ctx.registerTool(
            {
              name: 'my_ext_tool',
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
            async () => 'result'
          );
        },
      },
    });

    await manager.loadAll();

    const tools = manager.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.name).toBe('my_ext_tool');
  });
});
```

## Testing Web UIs

### Manual Testing

1. Enable the web UI in your extension (uncomment `ctx.serveWebUI()`)
2. Start Woodbury: `woodbury -v`
3. Note the URL in the verbose output: `[ext:my-ext] Web UI at http://127.0.0.1:43210`
4. Open the URL in a browser

### Automated Testing

Test that the web server starts and serves files correctly:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

describe('web UI server', () => {
  let webDir;
  let handle;

  beforeEach(async () => {
    // Create a temp dir with test HTML
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-test-'));
    fs.writeFileSync(
      path.join(webDir, 'index.html'),
      '<html><body><h1>Dashboard</h1></body></html>'
    );
    fs.writeFileSync(
      path.join(webDir, 'style.css'),
      'body { color: white; }'
    );
  });

  afterEach(async () => {
    if (handle) await handle.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  it('should serve index.html at root', async () => {
    // Activate extension with web UI pointing to temp dir
    const ctx = createMockContext();
    ctx.serveWebUI = async (opts) => {
      // Use the real ExtensionManager's startWebServer for integration testing
      // Or test with a simple http.createServer
      return startTestServer(opts.staticDir);
    };

    // ... activate extension ...

    const response = await fetch(handle.url);
    expect(response.ok).toBe(true);
    const html = await response.text();
    expect(html).toContain('<h1>Dashboard</h1>');
  });

  it('should serve CSS with correct content type', async () => {
    // ...
    const response = await fetch(`${handle.url}/style.css`);
    expect(response.headers.get('content-type')).toBe('text/css');
  });

  it('should return 404 for missing files', async () => {
    // ...
    const response = await fetch(`${handle.url}/nonexistent.html`);
    expect(response.status).toBe(404);
  });
});
```

## Testing Slash Commands

Test command handlers with a mock print function:

```javascript
describe('/social command', () => {
  it('should show drafts when called with "drafts" arg', async () => {
    const output = [];
    const cmdCtx = {
      workingDirectory: '/tmp',
      print: (msg) => output.push(msg),
    };

    // Get the command handler from your extension
    const commands = [];
    const ctx = createMockContext({ commands });
    await ext.activate(ctx);

    const socialCmd = commands.find(c => c.name === 'social');
    await socialCmd.handler(['drafts'], cmdCtx);

    expect(output.some(line => line.includes('Drafts'))).toBe(true);
  });

  it('should show usage with no args', async () => {
    const output = [];
    const cmdCtx = {
      workingDirectory: '/tmp',
      print: (msg) => output.push(msg),
    };

    const commands = [];
    const ctx = createMockContext({ commands });
    await ext.activate(ctx);

    const socialCmd = commands.find(c => c.name === 'social');
    await socialCmd.handler([], cmdCtx);

    expect(output.some(line => line.includes('Usage'))).toBe(true);
  });
});
```

## Testing System Prompt Additions

Verify that prompt additions are well-formed and contain expected content:

```javascript
describe('system prompt', () => {
  it('should add a prompt section mentioning all tools', async () => {
    const prompts = [];
    const tools = [];
    const ctx = createMockContext({ prompts, tools });
    await ext.activate(ctx);

    // Every registered tool should be mentioned in the prompt
    const fullPrompt = prompts.join('\n');
    for (const { definition } of tools) {
      expect(fullPrompt).toContain(definition.name);
    }
  });

  it('should keep prompt under 200 tokens (~800 characters)', async () => {
    const prompts = [];
    const ctx = createMockContext({ prompts });
    await ext.activate(ctx);

    const totalLength = prompts.reduce((sum, p) => sum + p.length, 0);
    expect(totalLength).toBeLessThan(800);
  });
});
```

## Testing Environment Variables

### Mocking ctx.env

Test tool handlers with mock environment variables:

```javascript
describe('tool with API key', () => {
  it('should use the API key from ctx.env', async () => {
    const tools = [];
    const ctx = createMockContext({ tools });
    ctx.env = Object.freeze({ MY_API_KEY: 'test-key-123' });

    await ext.activate(ctx);

    const tool = tools.find(t => t.definition.name === 'my_ext_fetch');
    const result = await tool.handler({ query: 'test' });
    expect(result).toContain('success');
  });

  it('should return error when API key is missing', async () => {
    const tools = [];
    const ctx = createMockContext({ tools });
    ctx.env = Object.freeze({});

    await ext.activate(ctx);

    const tool = tools.find(t => t.definition.name === 'my_ext_fetch');
    const result = await tool.handler({ query: 'test' });
    expect(result).toContain('API key not configured');
  });
});
```

### Testing env Isolation

Verify extensions only see their own keys:

```javascript
it('should not have access to other extension keys', async () => {
  const ctx = createMockContext();
  ctx.env = Object.freeze({ MY_EXT_KEY: 'value' });

  await ext.activate(ctx);

  expect(ctx.env.OTHER_EXT_SECRET).toBeUndefined();
  expect(Object.isFrozen(ctx.env)).toBe(true);
});
```

## Testing Site Knowledge (--web Extensions)

Extensions created with `--web` need additional testing to verify site-knowledge loading works correctly.

### Selector Verification

Test that documented selectors still match the live site:

```javascript
describe('selector verification', () => {
  it('should find login button on the login page', async () => {
    // Use web_crawl_rendered or bridgeServer to check selectors
    const ctx = createMockContext();
    ctx.bridgeServer = {
      send: jest.fn().mockResolvedValue({
        found: true,
        element: { tag: 'button', text: 'Sign In' }
      }),
      get isConnected() { return true; },
    };

    // Test that selectors from selectors.md actually match
    const result = await ctx.bridgeServer.send('find_element_by_text', {
      text: 'Sign In'
    });
    expect(result.found).toBe(true);
  });
});
```

### Site Knowledge Loading

Test that knowledge files are properly read and injected into the system prompt:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('site-knowledge loading', () => {
  let extDir;

  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ext-test-'));
    const knowledgeDir = path.join(extDir, 'site-knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  it('should load non-empty .md files into system prompt', async () => {
    const knowledgeDir = path.join(extDir, 'site-knowledge');
    fs.writeFileSync(path.join(knowledgeDir, 'site-map.md'), '# Site Map\n\n## Pages\n...');
    fs.writeFileSync(path.join(knowledgeDir, 'selectors.md'), '# Selectors\n\n## Key Elements\n...');
    fs.writeFileSync(path.join(knowledgeDir, 'empty.md'), '');  // empty — should be skipped

    const prompts = [];
    const ctx = createMockContext({ prompts });

    // Copy the generated index.js to the temp dir and load it
    // (or test loadSiteKnowledge directly if extracted as a module)

    // Verify non-empty files are loaded
    // Verify empty files are skipped
    expect(prompts.length).toBeGreaterThan(0);
    const fullPrompt = prompts.join('\n');
    expect(fullPrompt).toContain('Site Map');
    expect(fullPrompt).toContain('Selectors');
  });

  it('should handle missing site-knowledge/ directory gracefully', async () => {
    // Remove the knowledge directory
    fs.rmSync(path.join(extDir, 'site-knowledge'), { recursive: true, force: true });

    const prompts = [];
    const ctx = createMockContext({ prompts });

    // Activate should not throw — it should just log a warning
    // and proceed without adding site knowledge to the prompt
  });
});
```

### /knowledge Command

Test that the `/knowledge` subcommand correctly lists files:

```javascript
describe('/my-site knowledge command', () => {
  it('should list knowledge files with status', async () => {
    const output = [];
    const cmdCtx = {
      workingDirectory: '/tmp',
      print: (msg) => output.push(msg),
    };

    const commands = [];
    const ctx = createMockContext({ commands });
    await ext.activate(ctx);

    const cmd = commands.find(c => c.name === 'my-site');
    await cmd.handler(['knowledge'], cmdCtx);

    expect(output.some(line => line.includes('site-map.md'))).toBe(true);
    expect(output.some(line => line.includes('✓'))).toBe(true);
  });
});
```

## Testing Checklist

Before publishing or sharing an extension, verify:

- [ ] `woodbury ext list` shows the extension with correct metadata
- [ ] `woodbury -v` shows no errors during extension loading
- [ ] `/extensions` in the REPL lists the extension with tools, commands, and web UIs
- [ ] All registered tools work when called by the agent
- [ ] All slash commands work with expected arguments
- [ ] Web UI (if any) is accessible at the displayed URL
- [ ] Extension handles missing environment variables gracefully
- [ ] Extension handles network failures gracefully
- [ ] `deactivate()` cleans up all resources
- [ ] `woodbury --no-extensions` starts without loading the extension
- [ ] Tool names don't collide with built-in tools (`file_read`, `file_write`, `shell_execute`, etc.)
- [ ] Unit tests pass for all tool handlers
- [ ] Integration test passes with mock ExtensionContext

### Additional Checklist for `--web` Extensions

- [ ] All six site-knowledge template files exist and are non-empty
- [ ] `index.js` loads site-knowledge files into the system prompt
- [ ] The `/knowledge` subcommand lists files with correct status
- [ ] Missing `site-knowledge/` directory doesn't crash the extension
- [ ] Empty `.md` files are gracefully skipped
- [ ] Selectors in `selectors.md` match the current live site
- [ ] Auth flow in `auth-flow.md` reflects the current login process

## Existing Test Files

Woodbury's own extension system has comprehensive tests you can reference:

| File | What it tests |
|------|---------------|
| `src/__tests__/extension-scaffold.test.ts` | `woodbury ext create` scaffolding — name validation, directory structure, generated files |
| `src/__tests__/extension-loader.test.ts` | Discovery from local/npm/scoped dirs, manifest parsing, validation |
| `src/__tests__/extension-manager.test.ts` | Full lifecycle — loadAll, activate, deactivate, tool/command/prompt aggregation, web server |
| `src/__tests__/extension-agent-factory.test.ts` | Tool registration in ToolRegistry, prompt passthrough, error handling |

These files demonstrate patterns for mocking the bridge server, extension loader, and agent factory that you can adapt for your own tests.
