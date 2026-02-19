import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryTools, loadMemories } from '../src/memory.js';

describe('memory: saveMemoryDirect', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-mem-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves a memory directly to disk', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'Test fact', 'discovery', ['auto-capture']);

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe('Test fact');
    expect(memories[0].category).toBe('discovery');
    expect(memories[0].tags).toEqual(['auto-capture']);
    expect(memories[0].id).toBe(1);
  });

  it('assigns incrementing IDs', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'First fact', 'discovery', []);
    await tools.saveMemoryDirect(tmpDir, 'Second fact', 'convention', []);

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(2);
    expect(memories[0].id).toBe(1);
    expect(memories[1].id).toBe(2);
  });

  it('deduplicates on exact content', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'Same content', 'discovery', ['a']);
    await tools.saveMemoryDirect(tmpDir, 'Same content', 'discovery', ['b']);

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(1);
  });

  it('allows different content with same tags', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'Content A', 'discovery', ['tag']);
    await tools.saveMemoryDirect(tmpDir, 'Content B', 'discovery', ['tag']);

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(2);
  });

  it('persists to the memory.json file', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'Persisted', 'decision', ['test']);

    const filePath = join(tmpDir, '.woodbury-work', 'memory.json');
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toHaveLength(1);
    expect(data[0].content).toBe('Persisted');
  });

  it('includes sessionId and timestamp', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'Timestamped', 'gotcha', []);

    const memories = await loadMemories(tmpDir);
    expect(memories[0].timestamp).toBeGreaterThan(0);
    expect(memories[0].sessionId).toBeTruthy();
  });
});

describe('memory: saveHandler via tool interface', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-mem-tool-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves via tool handler', async () => {
    const tools = createMemoryTools();
    const result = await tools.saveHandler(
      { content: 'JWT tokens expire after 24h', category: 'convention', tags: ['auth', 'jwt'] },
      context(),
    );
    expect(result).toContain('Memory #1 saved');
    expect(result).toContain('convention');

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(1);
  });

  it('rejects empty content', async () => {
    const tools = createMemoryTools();
    const result = await tools.saveHandler({ content: '', category: 'discovery' }, context());
    expect(result).toContain('Error');
  });

  it('rejects invalid category', async () => {
    const tools = createMemoryTools();
    const result = await tools.saveHandler({ content: 'Test', category: 'invalid' }, context());
    expect(result).toContain('Error');
    expect(result).toContain('Invalid category');
  });

  it('detects duplicates', async () => {
    const tools = createMemoryTools();
    await tools.saveHandler({ content: 'Duplicate', category: 'discovery' }, context());
    const result = await tools.saveHandler({ content: 'Duplicate', category: 'discovery' }, context());
    expect(result).toContain('already exists');
  });
});

describe('memory: recallHandler', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-mem-recall-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds memories by keyword', async () => {
    const tools = createMemoryTools();
    await tools.saveHandler({ content: 'Use JWT for authentication', category: 'convention', tags: ['auth'] }, context());
    await tools.saveHandler({ content: 'Database is PostgreSQL', category: 'discovery' }, context());

    const result = await tools.recallHandler({ query: 'auth' }, context());
    expect(result).toContain('JWT');
    expect(result).toContain('matching');
  });

  it('filters by category', async () => {
    const tools = createMemoryTools();
    await tools.saveHandler({ content: 'Convention item', category: 'convention' }, context());
    await tools.saveHandler({ content: 'Discovery item', category: 'discovery' }, context());

    const result = await tools.recallHandler({ query: 'item', category: 'convention' }, context());
    expect(result).toContain('Convention item');
    expect(result).toContain('1 matching');
  });

  it('returns no-match message', async () => {
    const tools = createMemoryTools();
    await tools.saveHandler({ content: 'Something', category: 'discovery' }, context());
    const result = await tools.recallHandler({ query: 'xyzqwert' }, context());
    expect(result).toContain('No memories match');
  });

  it('returns empty message for no memories', async () => {
    const tools = createMemoryTools();
    const result = await tools.recallHandler({ query: 'anything' }, context());
    expect(result).toContain('No memories saved');
  });
});

describe('memory: getMemoryCount', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-mem-count-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 when no memories', async () => {
    const tools = createMemoryTools();
    expect(await tools.getMemoryCount(tmpDir)).toBe(0);
  });

  it('returns correct count', async () => {
    const tools = createMemoryTools();
    await tools.saveMemoryDirect(tmpDir, 'A', 'discovery', []);
    await tools.saveMemoryDirect(tmpDir, 'B', 'discovery', []);
    expect(await tools.getMemoryCount(tmpDir)).toBe(2);
  });
});
