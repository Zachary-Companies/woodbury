import type { ToolHandler } from './loop/index.js';

// ── Stable JSON stringify (deterministic key ordering) ────

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

// ── Cacheable / Mutation classification ──────────────────

const CACHEABLE_TOOLS = new Set([
  'file_read',
  'grep',
  'file_search',
  'list_directory',
]);

const MUTATION_TOOLS = new Set([
  'file_write',
  'shell_execute',
  'code_execute',
  'git',
  'database_query',
  'test_runner',
]);

export function isCacheable(toolName: string): boolean {
  return CACHEABLE_TOOLS.has(toolName);
}

export function isMutation(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName);
}

// ── LRU Cache ────────────────────────────────────────────

export class ToolCache {
  private cache = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  private makeKey(toolName: string, params: Record<string, unknown>): string {
    return `${toolName}::${stableStringify(params)}`;
  }

  get(toolName: string, params: Record<string, unknown>): string | undefined {
    const key = this.makeKey(toolName, params);
    const value = this.cache.get(key);
    if (value === undefined) return undefined;

    // LRU: delete and re-insert to move to end
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(toolName: string, params: Record<string, unknown>, result: string): void {
    const key = this.makeKey(toolName, params);

    // If already exists, delete first (for LRU ordering)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, result);
  }

  /**
   * Invalidate cache entries based on a mutation tool call.
   * - file_write to path X → remove all entries whose key contains that path
   * - shell_execute, code_execute, git, database_query, test_runner → clear entire cache
   */
  invalidateFor(toolName: string, params: Record<string, unknown>): void {
    if (toolName === 'file_write') {
      const path = params.path as string | undefined;
      if (path) {
        for (const key of [...this.cache.keys()]) {
          if (key.includes(path)) {
            this.cache.delete(key);
          }
        }
      } else {
        // No path → conservative clear
        this.cache.clear();
      }
    } else {
      // shell_execute, code_execute, git, database_query, test_runner → full clear
      this.cache.clear();
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ── Cache wrapper ────────────────────────────────────────

export function wrapWithCache(
  cache: ToolCache,
  handler: ToolHandler,
  toolName: string,
): ToolHandler {
  return async (params, context) => {
    const cached = cache.get(toolName, params);
    if (cached !== undefined) {
      return cached;
    }

    const result = await handler(params, context);
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    cache.set(toolName, params, resultStr);
    return result;
  };
}
