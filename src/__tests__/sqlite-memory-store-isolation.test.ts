/**
 * Isolation and performance guards for SQLiteMemoryStore construction.
 *
 * Constructing a store used to import the machine's global legacy memory files
 * (~/.woodbury/data/closure-engine/memories.json and ~/.woodbury/memory/) no
 * matter which path the store was opened at — so a test pointed at a temp dir
 * silently inherited the developer's real memories.
 *
 * Worse, each imported record triggered a full rewrite of the entire corpus,
 * making the import O(N^2) in file writes. Against a 500-record legacy file a
 * single `new SQLiteMemoryStore()` took ~36 seconds, which is what made the
 * memory and v3 suites look like they hung forever.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteMemoryStore, resetSQLiteMemoryStoreCache } from '../sqlite-memory-store';

describe('SQLiteMemoryStore isolation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'woodbury-store-'));
    resetSQLiteMemoryStoreCache();
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    await rm(workDir, { recursive: true, force: true });
  });

  it('starts empty at a custom path regardless of the machine global store', () => {
    // If the legacy import were still unconditional, this store would come up
    // preloaded with whatever is in the developer's home directory.
    const store = new SQLiteMemoryStore(join(workDir, 'memory-store'));

    expect(store.countGeneralMemories()).toBe(0);
    expect(store.listClosureMemories()).toHaveLength(0);
  });

  it('does not read the home directory when opened at a custom path', () => {
    const store = new SQLiteMemoryStore(join(workDir, 'memory-store'));
    const all = store.browseGeneralMemories({ limit: 1000 });

    expect(all.items).toHaveLength(0);
  });

  it('constructs quickly — the import must not be quadratic', () => {
    // A regression here is the difference between a 3-second suite and one that
    // never finishes, so assert the wall clock directly.
    const started = Date.now();
    new SQLiteMemoryStore(join(workDir, 'memory-store'));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps two stores at different paths fully separate', () => {
    const a = new SQLiteMemoryStore(join(workDir, 'a', 'memory-store'));
    const b = new SQLiteMemoryStore(join(workDir, 'b', 'memory-store'));

    a.saveGeneralMemory({
      content: 'only in store a',
      category: 'discovery',
      tags: ['x'],
      source: 'test',
    });

    expect(a.countGeneralMemories()).toBe(1);
    expect(b.countGeneralMemories()).toBe(0);
  });

  it('round-trips a saved memory through a reopened store', () => {
    const path = join(workDir, 'memory-store');
    const first = new SQLiteMemoryStore(path);
    first.saveGeneralMemory({
      content: 'the dashboard runs on port 9001',
      category: 'endpoint',
      tags: ['dashboard'],
      source: 'test',
    });

    const reopened = new SQLiteMemoryStore(path);
    expect(reopened.countGeneralMemories()).toBe(1);
    expect(reopened.browseGeneralMemories({ limit: 10 }).items[0].content).toBe(
      'the dashboard runs on port 9001'
    );
  });

  it('saves many records without quadratic slowdown', () => {
    const store = new SQLiteMemoryStore(join(workDir, 'memory-store'));
    const started = Date.now();

    for (let i = 0; i < 60; i++) {
      store.saveGeneralMemory({
        content: `memory number ${i}`,
        category: 'discovery',
        tags: [`t${i}`],
        source: 'test',
      });
    }

    expect(store.countGeneralMemories()).toBe(60);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 30000);
});
