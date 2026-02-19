/**
 * Tests for extension-manager.ts
 *
 * Verifies:
 * - loadAll() activates discovered extensions and returns loaded/errors
 * - activate() builds an ExtensionContext and calls module.activate()
 * - registerTool() adds tools to the aggregated getAllTools()
 * - registerCommand() adds commands to getAllCommands()
 * - addSystemPrompt() adds sections to getAllPromptSections()
 * - serveWebUI() starts a local HTTP server
 * - deactivate() calls module.deactivate() and closes web servers
 * - deactivateAll() shuts down everything
 * - getExtensionSummaries() returns structured info
 * - hasExtensions() reflects loaded state
 */

import { join } from 'node:path';

jest.mock('../bridge-server.js', () => ({
  bridgeServer: {
    send: jest.fn().mockResolvedValue({}),
    get isConnected() {
      return false;
    },
  },
}));

// Mock the loader so we control what gets discovered
const mockDiscoverExtensions = jest.fn().mockResolvedValue([]);
const mockLoadExtension = jest.fn();

jest.mock('../extension-loader.js', () => ({
  discoverExtensions: (...args: any[]) => mockDiscoverExtensions(...args),
  loadExtension: (...args: any[]) => mockLoadExtension(...args),
  parseEnvFile: jest.requireActual('../extension-loader.js').parseEnvFile ?? ((content: string) => {
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!value) continue;
      env[key] = value;
    }
    return env;
  }),
  EXTENSIONS_DIR: '/tmp/woodbury-test-ext',
}));

import { ExtensionManager, ExtensionRecord, ExtensionSummary } from '../extension-manager';
import type { ExtensionManifest } from '../extension-loader';
import type { ExtensionContext } from '../extension-api';

function makeManifest(name: string, overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return {
    packageName: `woodbury-ext-${name}`,
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `Test ext: ${name}`,
    version: '1.0.0',
    provides: ['tools'],
    entryPoint: `/fake/path/${name}/index.js`,
    source: 'local',
    directory: `/fake/path/${name}`,
    envDeclarations: {},
    ...overrides,
  };
}

describe('ExtensionManager', () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ExtensionManager('/tmp/test-project', false);
  });

  afterEach(async () => {
    await manager.deactivateAll();
  });

  describe('constructor', () => {
    it('should create an instance with no loaded extensions', () => {
      expect(manager.hasExtensions()).toBe(false);
      expect(manager.getAllTools()).toEqual([]);
      expect(manager.getAllCommands()).toEqual([]);
      expect(manager.getAllPromptSections()).toEqual([]);
      expect(manager.getExtensionSummaries()).toEqual([]);
    });
  });

  describe('loadAll', () => {
    it('should return empty arrays when no extensions found', async () => {
      mockDiscoverExtensions.mockResolvedValue([]);

      const result = await manager.loadAll();
      expect(result.loaded).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should activate discovered extensions', async () => {
      const manifest = makeManifest('alpha');
      const activateFn = jest.fn();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: { activate: activateFn },
      });

      const result = await manager.loadAll();
      expect(result.loaded).toEqual(['alpha']);
      expect(result.errors).toEqual([]);
      expect(activateFn).toHaveBeenCalledTimes(1);
    });

    it('should collect errors for failed extensions', async () => {
      const manifest = makeManifest('broken');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockRejectedValue(new Error('import failed'));

      const result = await manager.loadAll();
      expect(result.loaded).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe('broken');
      expect(result.errors[0].error).toContain('import failed');
    });

    it('should load multiple extensions and report mixed results', async () => {
      const good = makeManifest('good');
      const bad = makeManifest('bad');

      mockDiscoverExtensions.mockResolvedValue([good, bad]);
      mockLoadExtension
        .mockResolvedValueOnce({ manifest: good, module: { activate: jest.fn() } })
        .mockRejectedValueOnce(new Error('bad module'));

      const result = await manager.loadAll();
      expect(result.loaded).toEqual(['good']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe('bad');
    });
  });

  describe('ExtensionContext — registerTool', () => {
    it('should aggregate tools from extensions via getAllTools()', async () => {
      const manifest = makeManifest('toolext');
      const toolDef = {
        name: 'my_tool',
        description: 'A test tool',
        parameters: { type: 'object' as const, properties: {} },
      };
      const toolHandler = jest.fn();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.registerTool(toolDef, toolHandler);
          },
        },
      });

      await manager.loadAll();
      const tools = manager.getAllTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('my_tool');
      expect(tools[0].handler).toBe(toolHandler);
    });

    it('should aggregate tools from multiple extensions', async () => {
      const m1 = makeManifest('ext1');
      const m2 = makeManifest('ext2');

      mockDiscoverExtensions.mockResolvedValue([m1, m2]);
      mockLoadExtension
        .mockResolvedValueOnce({
          manifest: m1,
          module: {
            activate: (ctx: ExtensionContext) => {
              ctx.registerTool(
                { name: 'tool_a', description: 'A', parameters: { type: 'object' as const, properties: {} } },
                jest.fn()
              );
            },
          },
        })
        .mockResolvedValueOnce({
          manifest: m2,
          module: {
            activate: (ctx: ExtensionContext) => {
              ctx.registerTool(
                { name: 'tool_b', description: 'B', parameters: { type: 'object' as const, properties: {} } },
                jest.fn()
              );
            },
          },
        });

      await manager.loadAll();
      const tools = manager.getAllTools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.definition.name).sort();
      expect(names).toEqual(['tool_a', 'tool_b']);
    });
  });

  describe('ExtensionContext — registerCommand', () => {
    it('should aggregate commands via getAllCommands()', async () => {
      const manifest = makeManifest('cmdext');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.registerCommand({
              name: 'mycommand',
              description: 'Does something',
              handler: async (_args, cmdCtx) => {
                cmdCtx.print('hello');
              },
            });
          },
        },
      });

      await manager.loadAll();
      const commands = manager.getAllCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('mycommand');
      expect(commands[0].description).toContain('cmdext');
    });

    it('should wrap extension command handlers with correct context', async () => {
      const manifest = makeManifest('cmdext2');
      const innerHandler = jest.fn();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.registerCommand({
              name: 'wrapped',
              description: 'Test wrapped handler',
              handler: innerHandler,
            });
          },
        },
      });

      await manager.loadAll();
      const commands = manager.getAllCommands();

      // Call the wrapped handler
      const mockPrint = jest.fn();
      await commands[0].handler(
        ['arg1'],
        {
          config: {} as any,
          workingDirectory: '/test',
          print: mockPrint,
        }
      );

      // The inner handler should have been called with adapted context
      expect(innerHandler).toHaveBeenCalledWith(
        ['arg1'],
        expect.objectContaining({
          workingDirectory: '/test',
          print: mockPrint,
        })
      );
    });
  });

  describe('ExtensionContext — addSystemPrompt', () => {
    it('should aggregate prompt sections via getAllPromptSections()', async () => {
      const manifest = makeManifest('promptext');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.addSystemPrompt('You are a social media assistant.');
            ctx.addSystemPrompt('Always use friendly language.');
          },
        },
      });

      await manager.loadAll();
      const sections = manager.getAllPromptSections();
      expect(sections).toHaveLength(2);
      expect(sections[0]).toBe('You are a social media assistant.');
      expect(sections[1]).toBe('Always use friendly language.');
    });
  });

  describe('ExtensionContext — workingDirectory', () => {
    it('should pass the working directory to the context', async () => {
      const manifest = makeManifest('wdext');
      let capturedWd = '';

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            capturedWd = ctx.workingDirectory;
          },
        },
      });

      await manager.loadAll();
      expect(capturedWd).toBe('/tmp/test-project');
    });
  });

  describe('ExtensionContext — log', () => {
    it('should provide log methods', async () => {
      const manifest = makeManifest('logext');
      let hasLog = false;

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            hasLog =
              typeof ctx.log.info === 'function' &&
              typeof ctx.log.warn === 'function' &&
              typeof ctx.log.error === 'function' &&
              typeof ctx.log.debug === 'function';
          },
        },
      });

      await manager.loadAll();
      expect(hasLog).toBe(true);
    });
  });

  describe('ExtensionContext — bridgeServer', () => {
    it('should provide bridgeServer with send and isConnected', async () => {
      const manifest = makeManifest('bridgeext');
      let hasBridge = false;

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            hasBridge =
              typeof ctx.bridgeServer.send === 'function' &&
              typeof ctx.bridgeServer.isConnected === 'boolean';
          },
        },
      });

      await manager.loadAll();
      expect(hasBridge).toBe(true);
    });
  });

  describe('deactivate', () => {
    it('should call deactivate() on the module if provided', async () => {
      const manifest = makeManifest('deactext');
      const deactivateFn = jest.fn();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: jest.fn(),
          deactivate: deactivateFn,
        },
      });

      await manager.loadAll();
      expect(manager.hasExtensions()).toBe(true);

      await manager.deactivate('deactext');
      expect(deactivateFn).toHaveBeenCalledTimes(1);
      expect(manager.hasExtensions()).toBe(false);
    });

    it('should not throw when deactivating a non-existent extension', async () => {
      await expect(manager.deactivate('nonexistent')).resolves.not.toThrow();
    });

    it('should remove the extension from all aggregation methods', async () => {
      const manifest = makeManifest('removeext');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.registerTool(
              { name: 'removable_tool', description: 'T', parameters: { type: 'object' as const, properties: {} } },
              jest.fn()
            );
            ctx.registerCommand({
              name: 'removable',
              description: 'C',
              handler: jest.fn(),
            });
            ctx.addSystemPrompt('Remove me');
          },
        },
      });

      await manager.loadAll();
      expect(manager.getAllTools()).toHaveLength(1);
      expect(manager.getAllCommands()).toHaveLength(1);
      expect(manager.getAllPromptSections()).toHaveLength(1);

      await manager.deactivate('removeext');
      expect(manager.getAllTools()).toHaveLength(0);
      expect(manager.getAllCommands()).toHaveLength(0);
      expect(manager.getAllPromptSections()).toHaveLength(0);
    });
  });

  describe('deactivateAll', () => {
    it('should deactivate all loaded extensions', async () => {
      const m1 = makeManifest('a');
      const m2 = makeManifest('b');
      const deact1 = jest.fn();
      const deact2 = jest.fn();

      mockDiscoverExtensions.mockResolvedValue([m1, m2]);
      mockLoadExtension
        .mockResolvedValueOnce({
          manifest: m1,
          module: { activate: jest.fn(), deactivate: deact1 },
        })
        .mockResolvedValueOnce({
          manifest: m2,
          module: { activate: jest.fn(), deactivate: deact2 },
        });

      await manager.loadAll();
      expect(manager.hasExtensions()).toBe(true);

      await manager.deactivateAll();
      expect(deact1).toHaveBeenCalled();
      expect(deact2).toHaveBeenCalled();
      expect(manager.hasExtensions()).toBe(false);
    });
  });

  describe('getExtensionSummaries', () => {
    it('should return correct summaries', async () => {
      const manifest = makeManifest('summary', {
        displayName: 'Summary Ext',
        version: '3.0.0',
        source: 'npm',
      });

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            ctx.registerTool(
              { name: 't1', description: '', parameters: { type: 'object' as const, properties: {} } },
              jest.fn()
            );
            ctx.registerTool(
              { name: 't2', description: '', parameters: { type: 'object' as const, properties: {} } },
              jest.fn()
            );
            ctx.registerCommand({
              name: 'cmd1',
              description: '',
              handler: jest.fn(),
            });
            ctx.addSystemPrompt('Prompt section');
          },
        },
      });

      await manager.loadAll();
      const summaries = manager.getExtensionSummaries();

      expect(summaries).toHaveLength(1);
      const s = summaries[0];
      expect(s.name).toBe('summary');
      expect(s.displayName).toBe('Summary Ext');
      expect(s.version).toBe('3.0.0');
      expect(s.source).toBe('npm');
      expect(s.tools).toBe(2);
      expect(s.commands).toBe(1);
      expect(s.hasPrompt).toBe(true);
      expect(s.webUIs).toEqual([]);
    });
  });

  describe('hasExtensions', () => {
    it('should return false initially', () => {
      expect(manager.hasExtensions()).toBe(false);
    });

    it('should return true after loading an extension', async () => {
      const manifest = makeManifest('hasext');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: { activate: jest.fn() },
      });

      await manager.loadAll();
      expect(manager.hasExtensions()).toBe(true);
    });

    it('should return false after deactivating all', async () => {
      const manifest = makeManifest('hasext2');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: { activate: jest.fn() },
      });

      await manager.loadAll();
      await manager.deactivateAll();
      expect(manager.hasExtensions()).toBe(false);
    });
  });

  describe('ExtensionContext — env', () => {
    it('should provide an empty frozen env when no .env file exists', async () => {
      const manifest = makeManifest('noenv');
      let capturedEnv: any;

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            capturedEnv = ctx.env;
          },
        },
      });

      await manager.loadAll();
      expect(capturedEnv).toBeDefined();
      expect(Object.keys(capturedEnv)).toHaveLength(0);
      expect(Object.isFrozen(capturedEnv)).toBe(true);
    });

    it('should load env vars from .env file in extension directory', async () => {
      // Create a real temp dir with a .env file
      const { promises: fsPromises } = require('node:fs');
      const tmpDir = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-env-'));
      await fsPromises.writeFile(join(tmpDir, '.env'), 'MY_KEY=secret123\nOTHER_KEY=value456\n');

      const manifest = makeManifest('envext', { directory: tmpDir });
      let capturedEnv: any;

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: (ctx: ExtensionContext) => {
            capturedEnv = ctx.env;
          },
        },
      });

      try {
        await manager.loadAll();
        expect(capturedEnv.MY_KEY).toBe('secret123');
        expect(capturedEnv.OTHER_KEY).toBe('value456');
        expect(Object.isFrozen(capturedEnv)).toBe(true);
      } finally {
        await manager.deactivateAll();
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should not expose env vars from one extension to another', async () => {
      const { promises: fsPromises } = require('node:fs');
      const tmpA = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-envA-'));
      const tmpB = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-envB-'));
      await fsPromises.writeFile(join(tmpA, '.env'), 'SECRET_A=alpha\n');
      await fsPromises.writeFile(join(tmpB, '.env'), 'SECRET_B=beta\n');

      const mA = makeManifest('ext-a', { directory: tmpA });
      const mB = makeManifest('ext-b', { directory: tmpB });

      let envA: any, envB: any;

      mockDiscoverExtensions.mockResolvedValue([mA, mB]);
      mockLoadExtension
        .mockResolvedValueOnce({
          manifest: mA,
          module: {
            activate: (ctx: ExtensionContext) => { envA = ctx.env; },
          },
        })
        .mockResolvedValueOnce({
          manifest: mB,
          module: {
            activate: (ctx: ExtensionContext) => { envB = ctx.env; },
          },
        });

      try {
        await manager.loadAll();

        // Extension A should only see its own key
        expect(envA.SECRET_A).toBe('alpha');
        expect(envA.SECRET_B).toBeUndefined();

        // Extension B should only see its own key
        expect(envB.SECRET_B).toBe('beta');
        expect(envB.SECRET_A).toBeUndefined();
      } finally {
        await manager.deactivateAll();
        await fsPromises.rm(tmpA, { recursive: true, force: true });
        await fsPromises.rm(tmpB, { recursive: true, force: true });
      }
    });

    it('should warn on missing required env vars but still activate', async () => {
      const manifest = makeManifest('reqenv', {
        envDeclarations: {
          REQUIRED_KEY: { required: true, description: 'A required key' },
        },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: { activate: jest.fn() },
      });

      const result = await manager.loadAll();
      expect(result.loaded).toEqual(['reqenv']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('REQUIRED_KEY')
      );
      warnSpy.mockRestore();
    });

    it('should not warn when all required env vars are present', async () => {
      const { promises: fsPromises } = require('node:fs');
      const tmpDir = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-envreq-'));
      await fsPromises.writeFile(join(tmpDir, '.env'), 'REQUIRED_KEY=present\n');

      const manifest = makeManifest('reqok', {
        directory: tmpDir,
        envDeclarations: {
          REQUIRED_KEY: { required: true, description: 'A required key' },
        },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: { activate: jest.fn() },
      });

      try {
        await manager.loadAll();
        // Should NOT have warned about missing keys for this extension
        const calls = warnSpy.mock.calls.filter(
          (c) => String(c[0]).includes('REQUIRED_KEY')
        );
        expect(calls).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
        await manager.deactivateAll();
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('serveWebUI (integration)', () => {
    it('should start an HTTP server and return a handle', async () => {
      const { promises: fsPromises } = require('node:fs');
      const manifest = makeManifest('webext');
      let webHandle: any;

      // Create a temp dir with an index.html
      const tmpDir = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-webui-'));
      await fsPromises.writeFile(join(tmpDir, 'index.html'), '<h1>Test</h1>');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: async (ctx: ExtensionContext) => {
            webHandle = await ctx.serveWebUI({
              staticDir: tmpDir,
              label: 'Test Dashboard',
            });
          },
        },
      });

      await manager.loadAll();

      try {
        expect(webHandle).toBeDefined();
        expect(webHandle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(webHandle.port).toBeGreaterThan(0);
        expect(typeof webHandle.close).toBe('function');

        // Verify we can fetch the served content
        const response = await fetch(webHandle.url);
        expect(response.ok).toBe(true);
        const text = await response.text();
        expect(text).toContain('<h1>Test</h1>');
      } finally {
        await manager.deactivateAll();
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should include web UI URLs in extension summaries', async () => {
      const { promises: fsPromises } = require('node:fs');
      const manifest = makeManifest('webext2');

      const tmpDir = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-webui2-'));
      await fsPromises.writeFile(join(tmpDir, 'index.html'), '<h1>Test2</h1>');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: async (ctx: ExtensionContext) => {
            await ctx.serveWebUI({ staticDir: tmpDir });
          },
        },
      });

      await manager.loadAll();

      try {
        const summaries = manager.getExtensionSummaries();
        expect(summaries[0].webUIs).toHaveLength(1);
        expect(summaries[0].webUIs[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      } finally {
        await manager.deactivateAll();
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should close web servers on deactivate', async () => {
      const { promises: fsPromises } = require('node:fs');
      const manifest = makeManifest('webext3');
      let webHandle: any;

      const tmpDir = await fsPromises.mkdtemp(join(require('node:os').tmpdir(), 'wb-webui3-'));
      await fsPromises.writeFile(join(tmpDir, 'index.html'), '<h1>Test3</h1>');

      mockDiscoverExtensions.mockResolvedValue([manifest]);
      mockLoadExtension.mockResolvedValue({
        manifest,
        module: {
          activate: async (ctx: ExtensionContext) => {
            webHandle = await ctx.serveWebUI({ staticDir: tmpDir });
          },
        },
      });

      await manager.loadAll();

      // Server should be reachable
      const beforeResponse = await fetch(webHandle.url);
      expect(beforeResponse.ok).toBe(true);

      await manager.deactivateAll();

      // Server should be closed — fetch should fail
      try {
        await fetch(webHandle.url);
        // If fetch somehow succeeds, fail the test
        expect(true).toBe(false);
      } catch (err: any) {
        // Expected: connection refused or fetch error
        expect(err).toBeDefined();
      }

      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
