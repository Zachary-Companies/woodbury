/**
 * File-based memory store.
 *
 * Memories are stored as individual JSON files in ~/.woodbury/data/memories/.
 * Each memory is a single file: {id}.json
 *
 * This is simple, portable, git-friendly, and works across environments
 * without SQLite dependency issues.
 */

import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { debugLog } from './debug-log.js';

// ── Types ────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  source: string;           // 'chat', 'agent', 'pipeline', 'user'
  project?: string;         // pipeline id or project name
  importance: number;       // 0-1, higher = more important
  createdAt: string;        // ISO date
  updatedAt: string;        // ISO date
  recallCount: number;      // how many times this memory was recalled
  lastRecalledAt?: string;  // ISO date
}

export type MemoryCategory =
  | 'convention'       // coding style, project conventions
  | 'discovery'        // learned facts about the project
  | 'decision'         // architectural decisions
  | 'gotcha'           // tricky things to remember
  | 'procedure'        // how to do something (step by step)
  | 'preference'       // user preferences
  | 'endpoint'         // API endpoints, URLs
  | 'error_pattern'    // recurring errors and their fixes
  | 'general';         // anything else

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  'convention', 'discovery', 'decision', 'gotcha',
  'procedure', 'preference', 'endpoint', 'error_pattern', 'general',
];

// ── Memory Store ─────────────────────────────────────────────

const MEMORIES_DIR = join(homedir(), '.woodbury', 'data', 'memories');

let _memories: Map<string, Memory> | null = null;

async function ensureDir(): Promise<void> {
  await mkdir(MEMORIES_DIR, { recursive: true });
}

async function loadAll(): Promise<Map<string, Memory>> {
  if (_memories) return _memories;

  _memories = new Map();
  await ensureDir();

  try {
    const files = await readdir(MEMORIES_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(MEMORIES_DIR, file), 'utf-8');
        const mem: Memory = JSON.parse(raw);
        if (mem.id) _memories.set(mem.id, mem);
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Empty store
  }

  debugLog.info('memory', `Loaded ${_memories.size} memories from disk`);
  return _memories;
}

async function persist(mem: Memory): Promise<void> {
  await ensureDir();
  await writeFile(
    join(MEMORIES_DIR, `${mem.id}.json`),
    JSON.stringify(mem, null, 2),
    'utf-8',
  );
}

// ── Public API ───────────────────────────────────────────────

export async function saveMemory(
  content: string,
  category: MemoryCategory,
  options: {
    tags?: string[];
    source?: string;
    project?: string;
    importance?: number;
  } = {},
): Promise<Memory> {
  const memories = await loadAll();

  // Check for near-duplicate (same category, very similar content)
  for (const existing of memories.values()) {
    if (existing.category === category && contentSimilarity(existing.content, content) > 0.85) {
      // Update the existing memory instead of creating a duplicate
      existing.content = content;
      existing.updatedAt = new Date().toISOString();
      existing.importance = Math.max(existing.importance, options.importance ?? 0.5);
      if (options.tags) {
        existing.tags = [...new Set([...existing.tags, ...options.tags])];
      }
      await persist(existing);
      debugLog.info('memory', `Updated existing memory: ${existing.id}`);
      return existing;
    }
  }

  const mem: Memory = {
    id: randomUUID().slice(0, 12),
    content,
    category,
    tags: options.tags ?? [],
    source: options.source ?? 'chat',
    project: options.project,
    importance: options.importance ?? 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recallCount: 0,
  };

  memories.set(mem.id, mem);
  await persist(mem);
  debugLog.info('memory', `Saved new memory: ${mem.id} [${category}]`);
  return mem;
}

export async function recallMemories(
  query: string,
  options: {
    category?: MemoryCategory;
    project?: string;
    limit?: number;
  } = {},
): Promise<Memory[]> {
  const memories = await loadAll();
  const limit = options.limit ?? 8;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  if (queryTerms.length === 0) return [];

  // Score each memory by relevance
  const scored: Array<{ mem: Memory; score: number }> = [];

  for (const mem of memories.values()) {
    // Filter by category/project if specified
    if (options.category && mem.category !== options.category) continue;
    if (options.project && mem.project && mem.project !== options.project) continue;

    let score = 0;
    const contentLower = mem.content.toLowerCase();
    const tagsLower = mem.tags.map(t => t.toLowerCase());

    // Term matching in content
    for (const term of queryTerms) {
      if (contentLower.includes(term)) score += 2;
    }

    // Tag matching
    for (const term of queryTerms) {
      if (tagsLower.some(t => t.includes(term))) score += 3;
    }

    // Category boost for certain query patterns
    if (mem.category === 'gotcha' || mem.category === 'error_pattern') score += 1;
    if (mem.category === 'procedure' && query.toLowerCase().includes('how')) score += 2;

    // Importance boost
    score += mem.importance * 2;

    // Recency boost (memories updated recently are more relevant)
    const daysSinceUpdate = (Date.now() - new Date(mem.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate < 1) score += 2;
    else if (daysSinceUpdate < 7) score += 1;

    if (score > 0) {
      scored.push({ mem, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Update recall counts
  const results = scored.slice(0, limit).map(s => s.mem);
  const now = new Date().toISOString();
  for (const mem of results) {
    mem.recallCount += 1;
    mem.lastRecalledAt = now;
    mem.updatedAt = now;
    // Don't await — fire and forget
    persist(mem).catch(() => {});
  }

  return results;
}

export async function listMemories(options: {
  category?: MemoryCategory;
  project?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ memories: Memory[]; total: number }> {
  const memories = await loadAll();
  let all = Array.from(memories.values());

  if (options.category) all = all.filter(m => m.category === options.category);
  if (options.project) all = all.filter(m => m.project === options.project);

  // Sort by most recently updated
  all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const total = all.length;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;

  return {
    memories: all.slice(offset, offset + limit),
    total,
  };
}

export async function deleteMemory(id: string): Promise<boolean> {
  const memories = await loadAll();
  if (!memories.has(id)) return false;

  memories.delete(id);
  try {
    await unlink(join(MEMORIES_DIR, `${id}.json`));
  } catch {
    // File may not exist
  }
  return true;
}

export async function getMemoryStats(): Promise<Record<string, number>> {
  const memories = await loadAll();
  const stats: Record<string, number> = { total: memories.size };
  for (const cat of MEMORY_CATEGORIES) {
    stats[cat] = 0;
  }
  for (const mem of memories.values()) {
    stats[mem.category] = (stats[mem.category] || 0) + 1;
  }
  return stats;
}

// ── Helpers ──────────────────────────────────────────────────

/** Simple word-overlap similarity (0-1) */
function contentSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ── Consolidation & Decay ────────────────────────────────────
// Inspired by:
// - PMC4246028: Memory consolidation (fragile→stable transitions)
// - arxiv 2512.23343: Active consolidation > passive logging
// - Ebbinghaus curves: Adaptive forgetting of low-value info

/**
 * Decay: Reduce importance of memories not recalled recently.
 * Called periodically (e.g., daily or on app startup).
 * Memories that haven't been recalled decay toward 0.
 * Memories with 0 importance after decay are pruned.
 */
export async function decayMemories(): Promise<{ decayed: number; pruned: number }> {
  const memories = await loadAll();
  let decayed = 0;
  let pruned = 0;
  const now = Date.now();

  for (const [id, mem] of memories) {
    const daysSinceUpdate = (now - new Date(mem.updatedAt).getTime()) / (1000 * 60 * 60 * 24);

    // High-importance memories (user preferences, decisions) decay slower
    const isStable = mem.category === 'preference' || mem.category === 'decision' || mem.category === 'convention';
    const decayRate = isStable ? 0.005 : 0.02; // per day
    const minImportance = isStable ? 0.1 : 0.05;

    // Don't decay memories recalled in the last 7 days
    if (mem.lastRecalledAt) {
      const daysSinceRecall = (now - new Date(mem.lastRecalledAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceRecall < 7) continue;
    }

    // Only decay if not recently updated
    if (daysSinceUpdate > 3) {
      const newImportance = Math.max(minImportance, mem.importance - (decayRate * daysSinceUpdate));
      if (newImportance !== mem.importance) {
        mem.importance = Math.round(newImportance * 100) / 100;
        mem.updatedAt = new Date().toISOString();
        decayed++;
        await persist(mem);
      }
    }

    // Prune very old, low-importance, never-recalled memories
    if (mem.importance <= 0.05 && mem.recallCount === 0 && daysSinceUpdate > 30) {
      memories.delete(id);
      try { await unlink(join(MEMORIES_DIR, `${id}.json`)); } catch {}
      pruned++;
    }
  }

  if (decayed > 0 || pruned > 0) {
    debugLog.info('memory', `Decay: ${decayed} decayed, ${pruned} pruned`);
  }
  return { decayed, pruned };
}

/**
 * Consolidation: Merge similar memories within the same category.
 * This converts multiple episodic memories into stronger semantic knowledge.
 * E.g., 3 separate "fixed CSS in pipeline app" memories → 1 consolidated
 * "Pipeline app CSS issues are common; key files: styles.css, compositions-app.js"
 */
export async function consolidateMemories(): Promise<{ consolidated: number }> {
  const memories = await loadAll();
  const byCategory = new Map<string, Memory[]>();

  for (const mem of memories.values()) {
    const key = `${mem.category}:${mem.project || '_global'}`;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(mem);
  }

  let consolidated = 0;

  for (const [, group] of byCategory) {
    if (group.length < 3) continue; // Need 3+ to consolidate

    // Find pairs with high content similarity
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!memories.has(a.id) || !memories.has(b.id)) continue;

        const sim = contentSimilarity(a.content, b.content);
        if (sim > 0.6) {
          // Merge b into a: keep the more important one, combine tags
          const keeper = a.importance >= b.importance ? a : b;
          const absorbed = keeper === a ? b : a;

          keeper.content = keeper.content.length >= absorbed.content.length
            ? keeper.content
            : absorbed.content;
          keeper.tags = [...new Set([...keeper.tags, ...absorbed.tags])];
          keeper.importance = Math.min(1, Math.max(keeper.importance, absorbed.importance) + 0.1);
          keeper.recallCount += absorbed.recallCount;
          keeper.updatedAt = new Date().toISOString();

          // Remove absorbed
          memories.delete(absorbed.id);
          try { await unlink(join(MEMORIES_DIR, `${absorbed.id}.json`)); } catch {}
          await persist(keeper);
          consolidated++;
        }
      }
    }
  }

  if (consolidated > 0) {
    debugLog.info('memory', `Consolidation: merged ${consolidated} memory pairs`);
  }
  return { consolidated };
}

// ── Prompt Formatting ────────────────────────────────────────

/** Format memories as a context block for injection into prompts */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '';

  // Sort: highest importance first, then most recently recalled
  const sorted = [...memories].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    const aRecall = a.lastRecalledAt ? new Date(a.lastRecalledAt).getTime() : 0;
    const bRecall = b.lastRecalledAt ? new Date(b.lastRecalledAt).getTime() : 0;
    return bRecall - aRecall;
  });

  const lines = sorted.map(m => {
    const prefix = m.category === 'gotcha' ? '⚠️' :
      m.category === 'error_pattern' ? '🔴' :
      m.category === 'procedure' ? '📋' :
      m.category === 'preference' ? '👤' :
      m.category === 'decision' ? '🏗️' :
      '💡';
    return `${prefix} [${m.category}] ${m.content}${m.tags.length > 0 ? ` (tags: ${m.tags.join(', ')})` : ''}`;
  });

  return `<relevant_memories count="${memories.length}">
These are memories from previous interactions. Use them to inform your response — they represent learned patterns, user preferences, and past discoveries. If a memory contradicts the current request, the current request takes priority.
${lines.join('\n')}
</relevant_memories>`;
}
