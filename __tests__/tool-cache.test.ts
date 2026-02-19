import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCache, wrapWithCache, isCacheable, isMutation } from '../src/tool-cache.js';
import type { ToolHandler } from '../src/loop/index.js';

describe('ToolCache', () => {
  let cache: ToolCache;

  beforeEach(() => {
    cache = new ToolCache(5);
  });

  it('get/set round-trip', () => {
    cache.set('file_read', { path: 'a.ts' }, 'content-a');
    expect(cache.get('file_read', { path: 'a.ts' })).toBe('content-a');
  });

  it('returns undefined for cache miss', () => {
    expect(cache.get('file_read', { path: 'missing.ts' })).toBeUndefined();
  });

  it('LRU eviction at max capacity', () => {
    cache.set('file_read', { path: '1' }, 'r1');
    cache.set('file_read', { path: '2' }, 'r2');
    cache.set('file_read', { path: '3' }, 'r3');
    cache.set('file_read', { path: '4' }, 'r4');
    cache.set('file_read', { path: '5' }, 'r5');
    // At capacity (5). Adding one more should evict '1'
    cache.set('file_read', { path: '6' }, 'r6');

    expect(cache.get('file_read', { path: '1' })).toBeUndefined();
    expect(cache.get('file_read', { path: '2' })).toBe('r2');
    expect(cache.get('file_read', { path: '6' })).toBe('r6');
    expect(cache.size).toBe(5);
  });

  it('LRU access refreshes entry', () => {
    cache.set('file_read', { path: '1' }, 'r1');
    cache.set('file_read', { path: '2' }, 'r2');
    cache.set('file_read', { path: '3' }, 'r3');
    cache.set('file_read', { path: '4' }, 'r4');
    cache.set('file_read', { path: '5' }, 'r5');

    // Access '1' to refresh it
    cache.get('file_read', { path: '1' });

    // Now '2' should be the oldest
    cache.set('file_read', { path: '6' }, 'r6');
    expect(cache.get('file_read', { path: '1' })).toBe('r1');
    expect(cache.get('file_read', { path: '2' })).toBeUndefined();
  });

  it('invalidateFor file_write removes entries containing that path', () => {
    cache.set('file_read', { path: 'src/a.ts' }, 'content-a');
    cache.set('grep', { pattern: 'TODO', path: 'src/' }, 'matches');
    cache.set('file_read', { path: 'src/b.ts' }, 'content-b');

    cache.invalidateFor('file_write', { path: 'src/a.ts' });

    expect(cache.get('file_read', { path: 'src/a.ts' })).toBeUndefined();
    expect(cache.get('file_read', { path: 'src/b.ts' })).toBe('content-b');
  });

  it('invalidateFor shell_execute clears everything', () => {
    cache.set('file_read', { path: 'a.ts' }, 'a');
    cache.set('grep', { pattern: 'x' }, 'y');
    expect(cache.size).toBe(2);

    cache.invalidateFor('shell_execute', { command: 'npm test' });
    expect(cache.size).toBe(0);
  });

  it('stableStringify is deterministic regardless of key order', () => {
    cache.set('file_read', { path: 'a.ts', encoding: 'utf-8' }, 'result');
    // Same params but different key order
    expect(cache.get('file_read', { encoding: 'utf-8', path: 'a.ts' })).toBe('result');
  });

  it('clear empties the cache', () => {
    cache.set('file_read', { path: 'a.ts' }, 'a');
    cache.set('file_read', { path: 'b.ts' }, 'b');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('wrapWithCache', () => {
  it('returns cached result on cache hit', async () => {
    const cache = new ToolCache(10);
    const handler: ToolHandler = vi.fn(async () => 'fresh-result');
    const wrapped = wrapWithCache(cache, handler, 'file_read');

    // First call — cache miss, calls handler
    const r1 = await wrapped({ path: 'a.ts' }, { workingDirectory: '.' });
    expect(r1).toBe('fresh-result');
    expect(handler).toHaveBeenCalledTimes(1);

    // Second call — cache hit, does NOT call handler again
    const r2 = await wrapped({ path: 'a.ts' }, { workingDirectory: '.' });
    expect(r2).toBe('fresh-result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('calls real handler on cache miss', async () => {
    const cache = new ToolCache(10);
    const handler: ToolHandler = vi.fn(async () => 'result-1');
    const wrapped = wrapWithCache(cache, handler, 'file_read');

    await wrapped({ path: 'x.ts' }, { workingDirectory: '.' });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('isCacheable / isMutation', () => {
  it('isCacheable returns true for read-only tools', () => {
    expect(isCacheable('file_read')).toBe(true);
    expect(isCacheable('grep')).toBe(true);
    expect(isCacheable('file_search')).toBe(true);
    expect(isCacheable('list_directory')).toBe(true);
  });

  it('isCacheable returns false for mutation tools', () => {
    expect(isCacheable('file_write')).toBe(false);
    expect(isCacheable('shell_execute')).toBe(false);
    expect(isCacheable('git')).toBe(false);
  });

  it('isMutation returns true for mutation tools', () => {
    expect(isMutation('file_write')).toBe(true);
    expect(isMutation('shell_execute')).toBe(true);
    expect(isMutation('code_execute')).toBe(true);
    expect(isMutation('git')).toBe(true);
    expect(isMutation('database_query')).toBe(true);
    expect(isMutation('test_runner')).toBe(true);
  });

  it('isMutation returns false for read-only tools', () => {
    expect(isMutation('file_read')).toBe(false);
    expect(isMutation('grep')).toBe(false);
    expect(isMutation('file_search')).toBe(false);
  });
});
