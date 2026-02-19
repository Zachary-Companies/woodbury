/**
 * Tests for extension-scaffold.ts
 *
 * Verifies:
 * - Name validation (rejects invalid names)
 * - Directory creation
 * - package.json generation with correct woodbury field
 * - index.js generation with tool, command, prompt, and webui scaffolding
 * - web/index.html generation
 * - Display name derivation from kebab-case name
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock EXTENSIONS_DIR before importing scaffoldExtension
let testDir: string;

jest.mock('../extension-loader.js', () => ({
  get EXTENSIONS_DIR() {
    return testDir;
  },
}));

import { scaffoldExtension } from '../extension-scaffold';

describe('scaffoldExtension', () => {
  beforeEach(async () => {
    // Create a unique temporary directory for each test
    testDir = await fs.mkdtemp(join(tmpdir(), 'woodbury-scaffold-test-'));
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('name validation', () => {
    it('should reject names starting with uppercase', async () => {
      await expect(scaffoldExtension('MyExtension')).rejects.toThrow(
        /lowercase alphanumeric/
      );
    });

    it('should reject names starting with a number', async () => {
      await expect(scaffoldExtension('1ext')).rejects.toThrow(
        /lowercase alphanumeric/
      );
    });

    it('should reject names with special characters', async () => {
      await expect(scaffoldExtension('my_ext')).rejects.toThrow(
        /lowercase alphanumeric/
      );
    });

    it('should reject names with spaces', async () => {
      await expect(scaffoldExtension('my ext')).rejects.toThrow(
        /lowercase alphanumeric/
      );
    });

    it('should accept valid lowercase kebab-case names', async () => {
      await expect(scaffoldExtension('my-ext')).resolves.toBeDefined();
    });

    it('should accept single-word lowercase names', async () => {
      await expect(scaffoldExtension('social')).resolves.toBeDefined();
    });

    it('should accept names with numbers after first char', async () => {
      await expect(scaffoldExtension('ext2')).resolves.toBeDefined();
    });
  });

  describe('directory structure', () => {
    it('should create the extension directory', async () => {
      const dir = await scaffoldExtension('test-ext');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create a web/ subdirectory', async () => {
      const dir = await scaffoldExtension('test-ext');
      const stat = await fs.stat(join(dir, 'web'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should return the extension directory path', async () => {
      const dir = await scaffoldExtension('test-ext');
      expect(dir).toBe(join(testDir, 'test-ext'));
    });
  });

  describe('package.json', () => {
    it('should create a valid package.json', async () => {
      const dir = await scaffoldExtension('test-ext');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg).toBeDefined();
    });

    it('should set the correct package name', async () => {
      const dir = await scaffoldExtension('social');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.name).toBe('woodbury-ext-social');
    });

    it('should set version to 0.1.0', async () => {
      const dir = await scaffoldExtension('test-ext');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.version).toBe('0.1.0');
    });

    it('should set main to index.js', async () => {
      const dir = await scaffoldExtension('test-ext');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.main).toBe('index.js');
    });

    it('should include woodbury.name matching the input name', async () => {
      const dir = await scaffoldExtension('my-ext');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.woodbury.name).toBe('my-ext');
    });

    it('should derive displayName from kebab-case name', async () => {
      const dir = await scaffoldExtension('social-media');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.woodbury.displayName).toBe('Social Media');
    });

    it('should capitalize single-word display names', async () => {
      const dir = await scaffoldExtension('social');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.woodbury.displayName).toBe('Social');
    });

    it('should list all four capability types', async () => {
      const dir = await scaffoldExtension('test-ext');
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.woodbury.provides).toEqual(
        expect.arrayContaining(['tools', 'commands', 'prompts', 'webui'])
      );
      expect(pkg.woodbury.provides).toHaveLength(4);
    });
  });

  describe('index.js', () => {
    it('should create index.js', async () => {
      const dir = await scaffoldExtension('test-ext');
      const stat = await fs.stat(join(dir, 'index.js'));
      expect(stat.isFile()).toBe(true);
    });

    it('should export activate and deactivate', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('async activate(ctx)');
      expect(content).toContain('async deactivate()');
    });

    it('should register a tool with the extension name', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('ctx.registerTool');
      expect(content).toContain('test_ext_hello');
    });

    it('should register a slash command', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('ctx.registerCommand');
      expect(content).toContain("name: 'test-ext'");
    });

    it('should add a system prompt', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('ctx.addSystemPrompt');
    });

    it('should include commented-out serveWebUI', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('ctx.serveWebUI');
      // Should be commented out
      expect(content).toContain('// const handle = await ctx.serveWebUI');
    });

    it('should use hyphen-to-underscore naming for tool names', async () => {
      const dir = await scaffoldExtension('social-media');
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('social_media_hello');
    });
  });

  describe('site-knowledge (--web flag)', () => {
    it('should not create site-knowledge/ without --web flag', async () => {
      const dir = await scaffoldExtension('test-ext');
      await expect(
        fs.stat(join(dir, 'site-knowledge'))
      ).rejects.toThrow();
    });

    it('should create site-knowledge/ directory with --web flag', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const stat = await fs.stat(join(dir, 'site-knowledge'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create all six template files', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const expectedFiles = [
        'api-endpoints.md',
        'auth-flow.md',
        'forms.md',
        'quirks.md',
        'selectors.md',
        'site-map.md',
      ];
      const files = await fs.readdir(join(dir, 'site-knowledge'));
      expect(files.sort()).toEqual(expectedFiles);
    });

    it('should create non-empty template files with markdown headers', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const knowledgeDir = join(dir, 'site-knowledge');
      const files = await fs.readdir(knowledgeDir);
      for (const file of files) {
        const content = await fs.readFile(join(knowledgeDir, file), 'utf-8');
        expect(content.length).toBeGreaterThan(0);
        expect(content).toMatch(/^# /); // starts with a markdown header
      }
    });

    it('should generate index.js that loads site-knowledge files', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('loadSiteKnowledge');
      expect(content).toContain('site-knowledge');
      expect(content).toContain("readdirSync");
      expect(content).toContain("readFileSync");
    });

    it('should generate index.js with navigation tool example', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('test_ext_navigate');
      expect(content).not.toContain('test_ext_hello');
    });

    it('should generate index.js with /knowledge subcommand', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain("'knowledge'");
      expect(content).toContain('Site knowledge files:');
    });

    it('should generate index.js with addSystemPrompt for site knowledge', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const content = await fs.readFile(join(dir, 'index.js'), 'utf-8');
      expect(content).toContain('ctx.addSystemPrompt');
      expect(content).toContain('Site Knowledge');
    });

    it('should still create web/index.html with --web flag', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const stat = await fs.stat(join(dir, 'web', 'index.html'));
      expect(stat.isFile()).toBe(true);
    });

    it('should still create package.json with --web flag', async () => {
      const dir = await scaffoldExtension('test-ext', { webNavigation: true });
      const raw = await fs.readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      expect(pkg.woodbury.name).toBe('test-ext');
    });
  });

  describe('web/index.html', () => {
    it('should create a web/index.html file', async () => {
      const dir = await scaffoldExtension('test-ext');
      const stat = await fs.stat(join(dir, 'web', 'index.html'));
      expect(stat.isFile()).toBe(true);
    });

    it('should include the extension display name in the title', async () => {
      const dir = await scaffoldExtension('social-media');
      const content = await fs.readFile(
        join(dir, 'web', 'index.html'),
        'utf-8'
      );
      expect(content).toContain('<title>Social Media');
    });

    it('should be a complete HTML document', async () => {
      const dir = await scaffoldExtension('test-ext');
      const content = await fs.readFile(
        join(dir, 'web', 'index.html'),
        'utf-8'
      );
      expect(content).toContain('<!DOCTYPE html>');
      expect(content).toContain('</html>');
    });
  });
});
