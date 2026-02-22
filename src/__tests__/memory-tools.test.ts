/**
 * Tests for memory-save.ts and memory-recall.ts tool handlers.
 *
 * Verifies file-persistent memory storage in ~/.woodbury/memory/:
 * - memory_save: writes entries to category JSON files
 * - memory_recall: searches across category files with term scoring
 */

import * as path from 'node:path';

// Create mock functions
const mockMkdir = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockReaddir = jest.fn();
const mockHomedir = jest.fn().mockReturnValue('/mock-home');
const mockRandomUUID = jest.fn().mockReturnValue('test-uuid-1234');

// Mock modules before imports
jest.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
}));

jest.mock('node:os', () => ({
  homedir: mockHomedir,
}));

jest.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// Import after mocks are set up
import { handler as saveHandler, definition as saveDef } from '../loop/tools/memory-save';
import { handler as recallHandler, definition as recallDef } from '../loop/tools/memory-recall';

const MEMORY_DIR = '/mock-home/.woodbury/memory';
const ctx = { workingDirectory: '/test/project' };
const ctxEmpty = { workingDirectory: '' };

describe('memory_save', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHomedir.mockReturnValue('/mock-home');
    mockRandomUUID.mockReturnValue('test-uuid-1234');
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('should have correct tool definition', () => {
    expect(saveDef.name).toBe('memory_save');
    expect(saveDef.parameters.required).toContain('content');
    expect(saveDef.parameters.required).toContain('category');
    expect(saveDef.dangerous).toBe(false);
  });

  it('should create directory and write to category file', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = JSON.parse(await saveHandler({
      content: 'Test memory',
      category: 'discovery',
      tags: ['test']
    }, ctx));

    expect(result.success).toBe(true);
    expect(result.id).toBe('test-uuid-1234');
    expect(mockMkdir).toHaveBeenCalledWith(MEMORY_DIR, { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(MEMORY_DIR, 'discovery.json'),
      expect.any(String)
    );

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written).toHaveLength(1);
    expect(written[0].content).toBe('Test memory');
    expect(written[0].category).toBe('discovery');
    expect(written[0].tags).toEqual(['test']);
    expect(written[0].timestamp).toBeDefined();
  });

  it('should append to existing entries', async () => {
    const existing = [
      { id: 'old-1', content: 'Old memory', category: 'discovery', tags: [], timestamp: '2026-01-01T00:00:00.000Z' }
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(existing));

    await saveHandler({ content: 'New memory', category: 'discovery', tags: ['new'] }, ctx);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written).toHaveLength(2);
    expect(written[0].id).toBe('old-1');
    expect(written[1].content).toBe('New memory');
  });

  it('should reject invalid categories', async () => {
    const result = JSON.parse(await saveHandler({
      content: 'Test',
      category: 'invalid_category'
    }, ctx));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid category');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should accept all valid categories including web_procedure and web_task_notes', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const categories = [
      'convention', 'discovery', 'decision', 'gotcha',
      'file_location', 'endpoint', 'web_procedure', 'web_task_notes'
    ];

    for (const category of categories) {
      const result = JSON.parse(await saveHandler({ content: 'Test', category }, ctx));
      expect(result.success).toBe(true);
    }
  });

  it('should include site field when provided', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await saveHandler({
      content: 'Login procedure',
      category: 'web_procedure',
      tags: ['github'],
      site: 'github.com'
    }, ctx);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written[0].site).toBe('github.com');
  });

  it('should include project field from context', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await saveHandler(
      { content: 'Test', category: 'convention' },
      { workingDirectory: '/my/project' }
    );

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written[0].project).toBe('/my/project');
  });

  it('should not include site when not provided', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await saveHandler({ content: 'Test', category: 'convention' }, ctxEmpty);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written[0].site).toBeUndefined();
  });

  it('should handle corrupted existing file gracefully', async () => {
    mockReadFile.mockResolvedValue('not valid json');

    const result = JSON.parse(await saveHandler({
      content: 'Test',
      category: 'discovery'
    }, ctx));

    expect(result.success).toBe(true);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written).toHaveLength(1);
  });

  it('should default tags to empty array', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await saveHandler({ content: 'Test', category: 'discovery' }, ctx);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written[0].tags).toEqual([]);
  });
});

describe('memory_recall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHomedir.mockReturnValue('/mock-home');
  });

  it('should have correct tool definition', () => {
    expect(recallDef.name).toBe('memory_recall');
    expect(recallDef.parameters.required).toContain('query');
    expect(recallDef.dangerous).toBe(false);
  });

  it('should return empty array when no memories exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = JSON.parse(await recallHandler({ query: 'test' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toEqual([]);
  });

  it('should return empty array for empty query', async () => {
    const result = JSON.parse(await recallHandler({ query: '  ' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toEqual([]);
  });

  it('should search across all category files when no category filter', async () => {
    mockReaddir.mockResolvedValue(['discovery.json', 'convention.json']);
    mockReadFile.mockImplementation(async (filePath: any) => {
      if (filePath.includes('discovery.json')) {
        return JSON.stringify([
          { id: '1', content: 'Found a login bug', category: 'discovery', tags: ['login'], timestamp: '2026-01-01T00:00:00.000Z' }
        ]);
      }
      if (filePath.includes('convention.json')) {
        return JSON.stringify([
          { id: '2', content: 'Use TypeScript', category: 'convention', tags: ['typescript'], timestamp: '2026-01-02T00:00:00.000Z' }
        ]);
      }
      throw new Error('ENOENT');
    });

    const result = JSON.parse(await recallHandler({ query: 'login' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].id).toBe('1');
    expect(result.totalSearched).toBe(2);
  });

  it('should filter by category when specified', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'Login convention', category: 'convention', tags: ['login'], timestamp: '2026-01-01T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'login', category: 'convention' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toHaveLength(1);
    expect(mockReadFile).toHaveBeenCalledWith(
      path.join(MEMORY_DIR, 'convention.json'),
      'utf-8'
    );
  });

  it('should filter by site when specified', async () => {
    mockReaddir.mockResolvedValue(['web_procedure.json']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'Login to GitHub', category: 'web_procedure', tags: ['login'], site: 'github.com', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: '2', content: 'Login to GitLab', category: 'web_procedure', tags: ['login'], site: 'gitlab.com', timestamp: '2026-01-02T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'login', site: 'github' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].site).toBe('github.com');
  });

  it('should score tag matches higher than content matches', async () => {
    mockReaddir.mockResolvedValue(['discovery.json']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'Something about auth', category: 'discovery', tags: ['database'], timestamp: '2026-01-01T00:00:00.000Z' },
      { id: '2', content: 'Something unrelated', category: 'discovery', tags: ['auth'], timestamp: '2026-01-02T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'auth' }, ctx));

    expect(result.memories).toHaveLength(2);
    // Tag match (id:2, score=3) should come before content match (id:1, score=2)
    expect(result.memories[0].id).toBe('2');
    expect(result.memories[1].id).toBe('1');
  });

  it('should respect limit parameter', async () => {
    mockReaddir.mockResolvedValue(['discovery.json']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'Test entry 1', category: 'discovery', tags: ['test'], timestamp: '2026-01-01T00:00:00.000Z' },
      { id: '2', content: 'Test entry 2', category: 'discovery', tags: ['test'], timestamp: '2026-01-02T00:00:00.000Z' },
      { id: '3', content: 'Test entry 3', category: 'discovery', tags: ['test'], timestamp: '2026-01-03T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'test', limit: 2 }, ctx));

    expect(result.memories).toHaveLength(2);
    expect(result.returned).toBe(2);
  });

  it('should handle corrupted JSON files gracefully', async () => {
    mockReaddir.mockResolvedValue(['discovery.json', 'bad.json']);
    mockReadFile.mockImplementation(async (filePath: any) => {
      if (filePath.includes('discovery.json')) {
        return JSON.stringify([
          { id: '1', content: 'Valid entry', category: 'discovery', tags: ['test'], timestamp: '2026-01-01T00:00:00.000Z' }
        ]);
      }
      return 'not valid json{{{';
    });

    const result = JSON.parse(await recallHandler({ query: 'test' }, ctx));

    expect(result.success).toBe(true);
    expect(result.memories).toHaveLength(1);
  });

  it('should skip non-JSON files in memory directory', async () => {
    mockReaddir.mockResolvedValue(['discovery.json', 'readme.txt', '.DS_Store']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'Test', category: 'discovery', tags: ['test'], timestamp: '2026-01-01T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'test' }, ctx));

    expect(result.success).toBe(true);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('should be case insensitive for queries', async () => {
    mockReaddir.mockResolvedValue(['discovery.json']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'TypeScript configuration', category: 'discovery', tags: ['TypeScript'], timestamp: '2026-01-01T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'typescript' }, ctx));

    expect(result.memories).toHaveLength(1);
  });

  it('should match multiple query terms', async () => {
    mockReaddir.mockResolvedValue(['discovery.json']);
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: '1', content: 'GitHub login procedure with OAuth', category: 'discovery', tags: ['github', 'login'], timestamp: '2026-01-01T00:00:00.000Z' },
      { id: '2', content: 'GitLab CI setup', category: 'discovery', tags: ['gitlab', 'ci'], timestamp: '2026-01-02T00:00:00.000Z' }
    ]));

    const result = JSON.parse(await recallHandler({ query: 'github login' }, ctx));

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].id).toBe('1');
  });
});
