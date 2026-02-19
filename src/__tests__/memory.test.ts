import { Memory } from '../memory';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock the file system
jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock path module
jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn((...args) => args.join('/'))
}));

describe('Memory', () => {
  let memory: Memory;
  const testWorkDir = '/test/work';
  const memoryFile = '/test/work/.woodbury-work/memory.json';

  beforeEach(() => {
    memory = new Memory(testWorkDir);
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create a Memory instance with working directory', () => {
      expect(memory).toBeInstanceOf(Memory);
    });
  });

  describe('save', () => {
    beforeEach(() => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();
      mockFs.readFile.mockResolvedValue(JSON.stringify([]));
    });

    it('should save a memory entry', async () => {
      const entry = {
        content: 'Test memory content',
        category: 'discovery' as const,
        tags: ['test', 'memory']
      };

      await memory.save(entry.content, entry.category, entry.tags);

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        '/test/work/.woodbury-work',
        { recursive: true }
      );
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should append to existing memories', async () => {
      const existingMemories = [
        {
          id: 'existing-1',
          content: 'Existing memory',
          category: 'convention',
          tags: ['existing'],
          timestamp: Date.now() - 1000
        }
      ];

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingMemories));

      await memory.save('New memory', 'discovery', ['new']);

      expect(mockFs.writeFile).toHaveBeenCalled();
      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData).toHaveLength(2);
      expect(savedData[1].content).toBe('New memory');
    });

    it('should handle file creation errors', async () => {
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(memory.save('test', 'discovery')).rejects.toThrow('Permission denied');
    });
  });

  describe('recall', () => {
    const testMemories = [
      {
        id: 'memory-1',
        content: 'Authentication uses JWT tokens',
        category: 'convention',
        tags: ['auth', 'jwt'],
        timestamp: Date.now() - 2000
      },
      {
        id: 'memory-2', 
        content: 'Database connection string is in env vars',
        category: 'discovery',
        tags: ['database', 'config'],
        timestamp: Date.now() - 1000
      }
    ];

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(testMemories));
    });

    it('should recall memories by query', async () => {
      const results = await memory.recall('auth');

      expect(mockFs.readFile).toHaveBeenCalledWith(memoryFile, 'utf-8');
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

    it('should handle missing memory file', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const results = await memory.recall('test');
      expect(results).toEqual([]);
    });

    it('should handle corrupted memory file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json');

      const results = await memory.recall('test');
      expect(results).toEqual([]);
    });
  });

  describe('search functionality', () => {
    const testMemories = [
      {
        id: 'search-1',
        content: 'React components should use TypeScript interfaces',
        category: 'convention',
        tags: ['react', 'typescript', 'components'],
        timestamp: Date.now()
      },
      {
        id: 'search-2',
        content: 'API endpoints return JSON with camelCase properties',
        category: 'convention', 
        tags: ['api', 'json', 'naming'],
        timestamp: Date.now()
      }
    ];

    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(testMemories));
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
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue();
      mockFs.readFile.mockResolvedValue(JSON.stringify([]));

      const validCategories = [
        'convention',
        'discovery', 
        'decision',
        'gotcha',
        'file_location',
        'endpoint'
      ] as const;

      for (const category of validCategories) {
        await expect(memory.save('test', category)).resolves.not.toThrow();
      }
    });
  });
});
