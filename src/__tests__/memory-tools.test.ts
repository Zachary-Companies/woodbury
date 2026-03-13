/**
 * Tests for memory-save.ts and memory-recall.ts tool handlers.
 *
 * Verifies file-backed memory storage and ranked recall.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handler as saveHandler, definition as saveDef } from '../loop/tools/memory-save';
import { handler as recallHandler, definition as recallDef } from '../loop/tools/memory-recall';
import { resetSQLiteMemoryStoreCache } from '../sqlite-memory-store.js';

describe('memory tools', () => {
  let tempDir: string;
  let ctx: { workingDirectory: string };
  let otherCtx: { workingDirectory: string };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'woodbury-memory-tools-'));
    process.env.WOODBURY_MEMORY_DB_PATH = join(tempDir, 'memory.db');
    resetSQLiteMemoryStoreCache();
    ctx = { workingDirectory: join(tempDir, 'project-a') };
    otherCtx = { workingDirectory: join(tempDir, 'project-b') };
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    delete process.env.WOODBURY_MEMORY_DB_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('memory_save', () => {
    it('should have correct tool definition', () => {
      expect(saveDef.name).toBe('memory_save');
      expect(saveDef.parameters.required).toContain('content');
      expect(saveDef.parameters.required).toContain('category');
      expect(saveDef.dangerous).toBe(false);
    });

    it('should create a memory row that recall can read back', async () => {
      const saveResult = JSON.parse(await saveHandler({
        content: 'Test memory',
        category: 'discovery',
        tags: ['test'],
      }, ctx));

      expect(saveResult.success).toBe(true);
      expect(saveResult.id).toBeTruthy();

      const recallResult = JSON.parse(await recallHandler({ query: 'test' }, ctx));
      expect(recallResult.success).toBe(true);
      expect(recallResult.memories).toHaveLength(1);
      expect(recallResult.memories[0].content).toBe('Test memory');
      expect(recallResult.memories[0].project).toBe(ctx.workingDirectory);
    });

    it('should reject invalid categories', async () => {
      const result = JSON.parse(await saveHandler({
        content: 'Test',
        category: 'invalid_category',
      }, ctx));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid category');
    });

    it('should accept all valid categories including web categories', async () => {
      const categories = [
        'convention', 'discovery', 'decision', 'gotcha',
        'file_location', 'endpoint', 'web_procedure', 'web_task_notes',
      ];

      for (const category of categories) {
        const result = JSON.parse(await saveHandler({ content: `Test ${category}`, category }, ctx));
        expect(result.success).toBe(true);
      }
    });
  });

  describe('memory_recall', () => {
    it('should have correct tool definition', () => {
      expect(recallDef.name).toBe('memory_recall');
      expect(recallDef.parameters.required).toContain('query');
      expect(recallDef.dangerous).toBe(false);
    });

    it('should return empty array when no memories exist', async () => {
      const result = JSON.parse(await recallHandler({ query: 'test' }, ctx));
      expect(result.success).toBe(true);
      expect(result.memories).toEqual([]);
    });

    it('should search across memories for the current project', async () => {
      await saveHandler({ content: 'Found a login bug', category: 'discovery', tags: ['login'] }, ctx);
      await saveHandler({ content: 'Use TypeScript', category: 'convention', tags: ['typescript'] }, ctx);

      const result = JSON.parse(await recallHandler({ query: 'login' }, ctx));

      expect(result.success).toBe(true);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toContain('login bug');
    });

    it('should filter by category when specified', async () => {
      await saveHandler({ content: 'Login convention', category: 'convention', tags: ['login'] }, ctx);
      await saveHandler({ content: 'Login bug', category: 'discovery', tags: ['login'] }, ctx);

      const result = JSON.parse(await recallHandler({ query: 'login', category: 'convention' }, ctx));

      expect(result.success).toBe(true);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].category).toBe('convention');
    });

    it('should filter by site when specified', async () => {
      await saveHandler({ content: 'Login to GitHub', category: 'web_procedure', tags: ['login'], site: 'github.com' }, ctx);
      await saveHandler({ content: 'Login to GitLab', category: 'web_procedure', tags: ['login'], site: 'gitlab.com' }, ctx);

      const result = JSON.parse(await recallHandler({ query: 'login', site: 'github' }, ctx));

      expect(result.success).toBe(true);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].site).toBe('github.com');
    });

    it('should score tag matches higher than content matches', async () => {
      await saveHandler({ content: 'Something about auth', category: 'discovery', tags: ['database'] }, ctx);
      await saveHandler({ content: 'Something unrelated', category: 'discovery', tags: ['auth'] }, ctx);

      const result = JSON.parse(await recallHandler({ query: 'auth' }, ctx));

      expect(result.memories).toHaveLength(2);
      expect(result.memories[0].tags).toContain('auth');
    });

    it('should respect limit parameter', async () => {
      await saveHandler({ content: 'Test entry 1', category: 'discovery', tags: ['test'] }, ctx);
      await saveHandler({ content: 'Test entry 2', category: 'discovery', tags: ['test'] }, ctx);
      await saveHandler({ content: 'Test entry 3', category: 'discovery', tags: ['test'] }, ctx);

      const result = JSON.parse(await recallHandler({ query: 'test', limit: 2 }, ctx));

      expect(result.memories).toHaveLength(2);
      expect(result.returned).toBe(2);
    });

    it('should keep memories isolated by working directory', async () => {
      await saveHandler({ content: 'Project A auth notes', category: 'discovery', tags: ['auth'] }, ctx);
      await saveHandler({ content: 'Project B auth notes', category: 'discovery', tags: ['auth'] }, otherCtx);

      const result = JSON.parse(await recallHandler({ query: 'auth' }, ctx));

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toBe('Project A auth notes');
    });

    it('should return empty array for empty query', async () => {
      const result = JSON.parse(await recallHandler({ query: '  ' }, ctx));
      expect(result.success).toBe(true);
      expect(result.memories).toEqual([]);
    });
  });
});
