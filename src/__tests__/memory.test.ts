import { Memory } from '../memory';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetSQLiteMemoryStoreCache } from '../sqlite-memory-store.js';

describe('Memory', () => {
  let memory: Memory;
  let testWorkDir: string;

  beforeEach(async () => {
    testWorkDir = await mkdtemp(join(tmpdir(), 'woodbury-memory-'));
    process.env.WOODBURY_MEMORY_DB_PATH = join(testWorkDir, 'memory.db');
    resetSQLiteMemoryStoreCache();
    memory = new Memory(testWorkDir);
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    delete process.env.WOODBURY_MEMORY_DB_PATH;
    await rm(testWorkDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should create a Memory instance with working directory', () => {
      expect(memory).toBeInstanceOf(Memory);
    });
  });

  describe('save', () => {
    it('should save a memory entry', async () => {
      await memory.save('Test memory content', 'discovery', ['test', 'memory']);

      const recalled = await memory.recall('Test memory');
      expect(recalled).toHaveLength(1);
      expect(recalled[0].content).toBe('Test memory content');
    });

    it('should append distinct memories', async () => {
      await memory.save('Existing memory', 'convention', ['existing']);
      await memory.save('New memory', 'discovery', ['new']);

      const results = await memory.recall('memory');
      expect(results).toHaveLength(2);
      expect(results.some(entry => entry.content === 'Existing memory')).toBe(true);
      expect(results.some(entry => entry.content === 'New memory')).toBe(true);
    });

    it('should import legacy workspace memory files on recall', async () => {
      const legacyDir = join(testWorkDir, '.woodbury-work');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, 'memory.json'), JSON.stringify([
        {
          id: 'legacy-1',
          content: 'Authentication uses JWT tokens',
          category: 'convention',
          tags: ['auth', 'jwt'],
          timestamp: Date.now() - 5000,
        },
      ], null, 2));

      const results = await memory.recall('jwt');
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('JWT');
    });
  });

  describe('recall', () => {
    beforeEach(async () => {
      await memory.save('Authentication uses JWT tokens', 'convention', ['auth', 'jwt']);
      await memory.save('Database connection string is in env vars', 'discovery', ['database', 'config']);
    });

    it('should recall memories by query', async () => {
      const results = await memory.recall('auth');

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('JWT tokens');
    });

    it('should filter by category', async () => {
      const results = await memory.recall('database', 'discovery');

      expect(results).toHaveLength(1);
      expect(results[0].category).toBe('discovery');
    });

    it('should return empty array for no matches', async () => {
      const results = await memory.recall('nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('search functionality', () => {
    beforeEach(async () => {
      await memory.save('React components should use TypeScript interfaces', 'convention', ['react', 'typescript', 'components']);
      await memory.save('API endpoints return JSON with camelCase properties', 'convention', ['api', 'json', 'naming']);
    });

    it('should match content keywords', async () => {
      const results = await memory.recall('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should match tags', async () => {
      const results = await memory.recall('react');
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain('react');
    });

    it('should be case insensitive', async () => {
      const results = await memory.recall('TYPESCRIPT');
      expect(results).toHaveLength(1);
    });
  });

  describe('memory categories', () => {
    it('should accept valid categories', async () => {
      const validCategories = [
        'convention',
        'discovery',
        'decision',
        'gotcha',
        'file_location',
        'endpoint',
      ] as const;

      for (const category of validCategories) {
        await expect(memory.save('test', category)).resolves.not.toThrow();
      }
    });
  });
});
