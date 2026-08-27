/**
 * Persistent Memory Store
 *
 * File-based long-term memory system with search, aging, and relevance scoring.
 * Memories persist across agent sessions in ~/.agentic-loop/memories/ (global)
 * or .agentic-loop/memories/ (project-scoped).
 *
 * Inspired by claw-code-main's memdir subsystem design.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger, MemoryCategory } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryScope = 'project' | 'global';

export interface StoredMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  scope: MemoryScope;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last access via recall */
  lastAccessedAt: string;
  /** Number of times this memory has been recalled */
  accessCount: number;
  /** Project identifier (git remote or cwd basename) for project-scoped memories */
  projectId?: string;
}

export interface MemorySearchOptions {
  query?: string;
  category?: MemoryCategory;
  tags?: string[];
  scope?: MemoryScope;
  maxResults?: number;
  /** Minimum relevance score (0-1) to include in results */
  minRelevance?: number;
}

export interface MemorySearchResult {
  memory: StoredMemory;
  relevanceScore: number;
}

export interface MemoryStoreConfig {
  /** Directory for global memories (default: ~/.agentic-loop/memories) */
  globalDir?: string;
  /** Directory for project memories (default: .agentic-loop/memories relative to workingDirectory) */
  projectDir?: string;
  /** Working directory used to derive projectId */
  workingDirectory?: string;
  /** Max age in days before memories are pruned (default: 90) */
  maxAgeDays?: number;
  /** Max memories per scope (default: 500) */
  maxMemories?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_GLOBAL_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.agentic-loop',
  'memories'
);
const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_MEMORIES = 500;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_RELEVANCE = 0.1;

// ── MemoryStore ──────────────────────────────────────────────────────────────

export class MemoryStore {
  private globalDir: string;
  private projectDir: string;
  private workingDirectory: string;
  private projectId: string;
  private maxAgeDays: number;
  private maxMemories: number;
  private logger?: Logger;

  constructor(config?: MemoryStoreConfig, logger?: Logger) {
    this.workingDirectory = config?.workingDirectory || process.cwd();
    this.globalDir = config?.globalDir || DEFAULT_GLOBAL_DIR;
    this.projectDir = config?.projectDir || path.join(this.workingDirectory, '.agentic-loop', 'memories');
    this.projectId = deriveProjectId(this.workingDirectory);
    this.maxAgeDays = config?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.maxMemories = config?.maxMemories ?? DEFAULT_MAX_MEMORIES;
    this.logger = logger;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Save a memory to the store.
   * Deduplicates by content hash — if identical content exists, updates tags/category.
   */
  save(memory: {
    content: string;
    category: MemoryCategory;
    tags?: string[];
    scope?: MemoryScope;
  }): StoredMemory {
    const scope = memory.scope || 'project';
    const dir = this.dirForScope(scope);
    this.ensureDir(dir);

    // Check for duplicate content
    const contentHash = hashContent(memory.content);
    const existing = this.findByHash(dir, contentHash);
    if (existing) {
      // Merge tags and update
      const mergedTags = [...new Set([...existing.tags, ...(memory.tags || [])])];
      existing.tags = mergedTags;
      existing.category = memory.category;
      this.writeMemory(dir, existing);
      this.logger?.debug?.(`Memory updated (dedup): ${existing.id}`);
      return existing;
    }

    const now = new Date().toISOString();
    const stored: StoredMemory = {
      id: generateId(),
      content: memory.content,
      category: memory.category,
      tags: memory.tags || [],
      scope,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      projectId: scope === 'project' ? this.projectId : undefined,
    };

    this.writeMemory(dir, stored);
    this.logger?.debug?.(`Memory saved: ${stored.id}`);

    // Enforce max memories
    this.enforceLimit(dir);

    return stored;
  }

  /**
   * Search memories by query, category, and/or tags.
   * Returns results sorted by relevance score (descending).
   */
  search(options: MemorySearchOptions = {}): MemorySearchResult[] {
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const minRelevance = options.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    const memories = this.loadAll(options.scope);

    const scored: MemorySearchResult[] = [];
    for (const memory of memories) {
      const score = this.scoreMemory(memory, options);
      if (score >= minRelevance) {
        scored.push({ memory, relevanceScore: score });
      }
    }

    // Sort by relevance descending
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Take top N and update access counts
    const results = scored.slice(0, maxResults);
    for (const result of results) {
      result.memory.lastAccessedAt = new Date().toISOString();
      result.memory.accessCount++;
      const dir = this.dirForScope(result.memory.scope);
      this.writeMemory(dir, result.memory);
    }

    return results;
  }

  /**
   * Delete a memory by ID. Returns true if found and deleted.
   */
  forget(id: string): boolean {
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const dir = this.dirForScope(scope);
      const filePath = path.join(dir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger?.debug?.(`Memory forgotten: ${id}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Get a single memory by ID.
   */
  get(id: string): StoredMemory | null {
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const dir = this.dirForScope(scope);
      const filePath = path.join(dir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * List all memories, optionally filtered by scope.
   */
  list(scope?: MemoryScope): StoredMemory[] {
    return this.loadAll(scope);
  }

  // ── Aging ────────────────────────────────────────────────────────────────

  /**
   * Prune memories that exceed maxAgeDays and have low access counts.
   * Keeps frequently-accessed memories even if old.
   */
  prune(): { pruned: number; kept: number } {
    let pruned = 0;
    let kept = 0;
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;

    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const dir = this.dirForScope(scope);
      const memories = this.loadFromDir(dir);

      for (const memory of memories) {
        const lastAccess = new Date(memory.lastAccessedAt).getTime();
        // Keep if accessed recently OR accessed frequently (> 5 times)
        if (lastAccess < cutoff && memory.accessCount <= 5) {
          const filePath = path.join(dir, `${memory.id}.json`);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            pruned++;
          }
        } else {
          kept++;
        }
      }
    }

    this.logger?.info?.(`Memory pruning: ${pruned} pruned, ${kept} kept`);
    return { pruned, kept };
  }

  // ── Relevance Scoring ────────────────────────────────────────────────────

  /**
   * Score a memory's relevance to a search query.
   * Combines text match, category match, tag match, recency, and access frequency.
   */
  private scoreMemory(memory: StoredMemory, options: MemorySearchOptions): number {
    let score = 0;
    const weights = {
      textMatch: 0.4,
      categoryMatch: 0.15,
      tagMatch: 0.2,
      recency: 0.15,
      frequency: 0.1,
    };

    // Text match (keyword overlap)
    let hasTextMatch = false;
    if (options.query) {
      const queryTerms = tokenize(options.query);
      const contentTerms = tokenize(memory.content);
      const tagTerms = memory.tags.map(t => t.toLowerCase());
      const allMemoryTerms = new Set([...contentTerms, ...tagTerms]);

      let matches = 0;
      for (const term of queryTerms) {
        for (const memTerm of allMemoryTerms) {
          if (memTerm.includes(term) || term.includes(memTerm)) {
            matches++;
            break;
          }
        }
      }
      const textScore = queryTerms.length > 0 ? matches / queryTerms.length : 0;
      score += weights.textMatch * textScore;
      hasTextMatch = textScore > 0;
    } else {
      // No query = all memories are equally text-relevant
      score += weights.textMatch;
      hasTextMatch = true;
    }

    // Category match
    if (options.category) {
      score += memory.category === options.category ? weights.categoryMatch : 0;
    } else {
      score += weights.categoryMatch * 0.5; // Partial credit when no filter
    }

    // Tag match
    if (options.tags && options.tags.length > 0) {
      const queryTags = new Set(options.tags.map(t => t.toLowerCase()));
      const memoryTags = memory.tags.map(t => t.toLowerCase());
      const tagMatches = memoryTags.filter(t => queryTags.has(t)).length;
      score += weights.tagMatch * (tagMatches / options.tags.length);
    } else {
      score += weights.tagMatch * 0.3;
    }

    // Recency boost (exponential decay over 30 days)
    const daysSinceAccess = (Date.now() - new Date(memory.lastAccessedAt).getTime()) / (24 * 60 * 60 * 1000);
    score += weights.recency * Math.exp(-daysSinceAccess / 30);

    // Frequency boost (logarithmic)
    score += weights.frequency * Math.min(1, Math.log2(memory.accessCount + 1) / 5);

    // Gate: if a query was provided but there were zero text/tag matches,
    // the memory is not relevant — suppress it
    if (options.query && !hasTextMatch) {
      score *= 0.05;
    }

    return Math.min(1, score);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private dirForScope(scope: MemoryScope): string {
    return scope === 'global' ? this.globalDir : this.projectDir;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private writeMemory(dir: string, memory: StoredMemory): void {
    this.ensureDir(dir);
    const filePath = path.join(dir, `${memory.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf-8');
  }

  private loadFromDir(dir: string): StoredMemory[] {
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const memories: StoredMemory[] = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
          memories.push(JSON.parse(raw));
        } catch {
          // Skip corrupted files
        }
      }
      return memories;
    } catch {
      return [];
    }
  }

  private loadAll(scope?: MemoryScope): StoredMemory[] {
    if (scope === 'project') return this.loadFromDir(this.projectDir);
    if (scope === 'global') return this.loadFromDir(this.globalDir);
    return [...this.loadFromDir(this.projectDir), ...this.loadFromDir(this.globalDir)];
  }

  private findByHash(dir: string, contentHash: string): StoredMemory | null {
    const memories = this.loadFromDir(dir);
    return memories.find(m => hashContent(m.content) === contentHash) || null;
  }

  private enforceLimit(dir: string): void {
    const memories = this.loadFromDir(dir);
    if (memories.length <= this.maxMemories) return;

    // Sort by relevance: least recently accessed + lowest access count first
    memories.sort((a, b) => {
      const aScore = new Date(a.lastAccessedAt).getTime() + a.accessCount * 86400000;
      const bScore = new Date(b.lastAccessedAt).getTime() + b.accessCount * 86400000;
      return aScore - bScore;
    });

    // Remove oldest/least-used until under limit
    const toRemove = memories.slice(0, memories.length - this.maxMemories);
    for (const memory of toRemove) {
      const filePath = path.join(dir, `${memory.id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  /** Exposed for testing */
  getProjectId(): string {
    return this.projectId;
  }

  getGlobalDir(): string {
    return this.globalDir;
  }

  getProjectDir(): string {
    return this.projectDir;
  }
}

// ── Utility functions ──────────────────────────────────────────────────────

function generateId(): string {
  return `mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function deriveProjectId(workingDirectory: string): string {
  // Use the directory basename as a simple project identifier
  return path.basename(workingDirectory);
}

export { hashContent, tokenize, deriveProjectId, generateId };
