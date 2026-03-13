import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MemoryRecord, MemoryType } from './loop/v3/types.js';

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (location: string) => any };

export const GENERAL_MEMORY_CATEGORIES = [
  'convention',
  'discovery',
  'decision',
  'gotcha',
  'file_location',
  'endpoint',
  'web_procedure',
  'web_task_notes',
] as const;

export type GeneralMemoryCategory = (typeof GENERAL_MEMORY_CATEGORIES)[number];

export interface GeneralMemoryRecord {
  id: string;
  content: string;
  category: GeneralMemoryCategory;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  site?: string;
  project?: string;
  source: string;
  importance: number;
  lastRecalledAt?: string;
  recallCount: number;
}

export interface GeneralMemoryMatch extends GeneralMemoryRecord {
  score: number;
  semanticScore: number;
  lexicalScore: number;
}

export interface ClosureMemoryMatch extends MemoryRecord {
  score: number;
  semanticScore: number;
  lexicalScore: number;
}

export interface GeneralMemoryBrowseResult {
  items: GeneralMemoryMatch[];
  total: number;
}

export interface ClosureMemoryBrowseResult {
  items: ClosureMemoryMatch[];
  total: number;
}

export interface MemoryStats {
  general: {
    total: number;
    byCategory: Record<string, number>;
  };
  closure: {
    total: number;
    byType: Record<string, number>;
  };
  indexing: {
    provider: string;
    dimensions: number;
    indexedGeneral: number;
    indexedClosure: number;
  };
}

interface DbGeneralRow {
  id: string;
  content: string;
  category: GeneralMemoryCategory;
  tags_json: string;
  created_at: string;
  updated_at: string;
  site: string | null;
  project: string | null;
  source: string;
  importance: number;
  last_recalled_at: string | null;
  recall_count: number;
}

interface DbClosureRow {
  id: string;
  type: MemoryType;
  title: string | null;
  content: string;
  tags_json: string;
  confidence: number;
  trigger_pattern: string | null;
  avoid_pattern: string | null;
  applicability_json: string;
  source: string;
  access_count: number;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
}

interface DbEmbeddingRow {
  scope: 'general' | 'closure';
  memory_id: string;
  model: string;
  dimensions: number;
  embedding_json: string;
  source_text: string;
  text_hash: string;
  updated_at: string;
}

interface SaveGeneralMemoryInput {
  id?: string;
  content: string;
  category: GeneralMemoryCategory;
  tags?: string[];
  site?: string;
  project?: string;
  source?: string;
  importance?: number;
  createdAt?: string;
}

interface UpsertClosureMemoryInput {
  id?: string;
  type: MemoryType;
  title?: string;
  content: string;
  tags?: string[];
  confidence: number;
  triggerPattern?: string;
  avoidPattern?: string;
  applicabilityConditions?: string[];
  source?: string;
  createdAt?: string;
  lastAccessed?: string;
  accessCount?: number;
}

const DEFAULT_DB_PATH = join(homedir(), '.woodbury', 'data', 'memory', 'memory.db');
const LEGACY_GLOBAL_MEMORY_DIR = join(homedir(), '.woodbury', 'memory');
const LEGACY_CLOSURE_MEMORIES_FILE = join(homedir(), '.woodbury', 'data', 'closure-engine', 'memories.json');
const MEMORY_EMBEDDING_MODEL = 'hash-semantic-v1';
const MEMORY_EMBEDDING_DIMENSIONS = 384;

const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'login', 'signin', 'credential', 'credentials', 'password', 'token', 'session'],
  bug: ['issue', 'error', 'failure', 'regression', 'problem'],
  workflow: ['automation', 'procedure', 'steps', 'sequence', 'playbook'],
  pipeline: ['composition', 'graph', 'orchestration', 'flow'],
  endpoint: ['api', 'route', 'url', 'path'],
  file: ['filepath', 'location', 'directory', 'module'],
  preference: ['prefer', 'preferred', 'likes', 'wants'],
  ui: ['interface', 'button', 'modal', 'screen', 'page'],
  delete: ['remove', 'drop', 'erase'],
  create: ['generate', 'build', 'make'],
  verify: ['check', 'validate', 'confirm', 'inspect'],
};

const storeCache = new Map<string, SQLiteMemoryStore>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTags(tags: string[] = []): string[] {
  return Array.from(new Set(tags.map(tag => tag.trim()).filter(Boolean)));
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry: unknown): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string | null | undefined): number[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry: unknown): entry is number => typeof entry === 'number') : [];
  } catch {
    return [];
  }
}

function buildHash(input: string): string {
  return createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

function tokenizeSemanticText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 1);
}

function expandSemanticTokens(tokens: string[]): string[] {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const singular = token.replace(/s$/, '');
    expanded.add(singular);

    for (const [canonical, synonyms] of Object.entries(SEMANTIC_SYNONYMS)) {
      if (canonical === token || canonical === singular || synonyms.includes(token) || synonyms.includes(singular)) {
        expanded.add(canonical);
        for (const synonym of synonyms) {
          expanded.add(synonym);
        }
      }
    }
  }
  return Array.from(expanded);
}

function hashString(str: string): number {
  let hash = 0;
  for (let index = 0; index < str.length; index++) {
    const char = str.charCodeAt(index);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

function computeSemanticEmbedding(text: string, dimensions: number = MEMORY_EMBEDDING_DIMENSIONS): number[] {
  const tokens = expandSemanticTokens(tokenizeSemanticText(text));
  const vector = new Array<number>(dimensions).fill(0);

  for (const token of tokens) {
    const hash = Math.abs(hashString(token));
    const index = hash % dimensions;
    const sign = hashString(`${token}:sign`) >= 0 ? 1 : -1;
    vector[index] += sign;
  }

  for (let index = 0; index < tokens.length - 1; index++) {
    const bigram = `${tokens[index]}_${tokens[index + 1]}`;
    const hash = Math.abs(hashString(bigram));
    const vectorIndex = hash % dimensions;
    const sign = hashString(`${bigram}:sign`) >= 0 ? 0.5 : -0.5;
    vector[vectorIndex] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index++) {
      vector[index] /= magnitude;
    }
  }

  return vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dot = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
  }
  return dot;
}

function resolveMemoryDbPath(): string {
  return process.env.WOODBURY_MEMORY_DB_PATH || DEFAULT_DB_PATH;
}

function toGeneralRecord(row: DbGeneralRow): GeneralMemoryRecord {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    site: row.site || undefined,
    project: row.project || undefined,
    source: row.source,
    importance: row.importance,
    lastRecalledAt: row.last_recalled_at || undefined,
    recallCount: row.recall_count,
  };
}

function toClosureRecord(row: DbClosureRow): MemoryRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title || undefined,
    content: row.content,
    tags: parseJsonArray(row.tags_json),
    confidence: row.confidence,
    triggerPattern: row.trigger_pattern || undefined,
    avoidPattern: row.avoid_pattern || undefined,
    applicabilityConditions: parseJsonArray(row.applicability_json),
    accessCount: row.access_count,
    lastAccessed: row.last_accessed || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildGeneralEmbeddingText(input: {
  category: GeneralMemoryCategory;
  content: string;
  tags?: string[];
  site?: string;
  project?: string;
  source?: string;
}): string {
  return [
    `category ${input.category}`,
    input.content,
    input.tags?.length ? `tags ${input.tags.join(' ')}` : '',
    input.site ? `site ${input.site}` : '',
    input.project ? `project ${input.project}` : '',
    input.source ? `source ${input.source}` : '',
  ].filter(Boolean).join(' ');
}

function buildClosureEmbeddingText(input: {
  type: MemoryType;
  title?: string;
  content: string;
  tags?: string[];
  applicabilityConditions?: string[];
  triggerPattern?: string;
  avoidPattern?: string;
}): string {
  return [
    `type ${input.type}`,
    input.title || '',
    input.content,
    input.tags?.length ? `tags ${input.tags.join(' ')}` : '',
    input.applicabilityConditions?.length ? `conditions ${input.applicabilityConditions.join(' ')}` : '',
    input.triggerPattern ? `trigger ${input.triggerPattern}` : '',
    input.avoidPattern ? `avoid ${input.avoidPattern}` : '',
  ].filter(Boolean).join(' ');
}

export class SQLiteMemoryStore {
  private readonly db: any;

  constructor(private readonly dbPath: string = resolveMemoryDbPath()) {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initialize();
  }

  saveGeneralMemory(input: SaveGeneralMemoryInput): GeneralMemoryRecord {
    const now = new Date().toISOString();
    const createdAt = input.createdAt || now;
    const tags = normalizeTags(input.tags);
    const contentHash = buildHash(input.content);
    const siteKey = input.site || '';
    const projectKey = input.project || '';
    const existing = this.db.prepare(`
      SELECT *
      FROM general_memories
      WHERE category = @category
        AND content_hash = @contentHash
        AND ifnull(site, '') = @siteKey
        AND ifnull(project, '') = @projectKey
      LIMIT 1
    `).get({
      category: input.category,
      contentHash,
      siteKey,
      projectKey,
    }) as DbGeneralRow | undefined;

    if (existing) {
      const mergedTags = normalizeTags([...parseJsonArray(existing.tags_json), ...tags]);
      const importance = Math.max(existing.importance, input.importance ?? existing.importance ?? 0.5);
      this.db.prepare(`
        UPDATE general_memories
        SET content = @content,
            tags_json = @tagsJson,
            updated_at = @updatedAt,
            site = @site,
            project = @project,
            source = @source,
            importance = @importance
        WHERE id = @id
      `).run({
        id: existing.id,
        content: input.content,
        tagsJson: JSON.stringify(mergedTags),
        updatedAt: now,
        site: input.site || null,
        project: input.project || null,
        source: input.source || existing.source || 'manual',
        importance,
      });
      this.upsertEmbedding('general', existing.id, buildGeneralEmbeddingText({
        category: input.category,
        content: input.content,
        tags: mergedTags,
        site: input.site,
        project: input.project,
        source: input.source || existing.source || 'manual',
      }));
      return this.getGeneralMemoryById(existing.id)!;
    }

    const id = input.id || randomUUID();
    this.db.prepare(`
      INSERT INTO general_memories (
        id, content, category, tags_json, site, project, source, importance,
        content_hash, created_at, updated_at, last_recalled_at, recall_count
      ) VALUES (
        @id, @content, @category, @tagsJson, @site, @project, @source, @importance,
        @contentHash, @createdAt, @updatedAt, NULL, 0
      )
    `).run({
      id,
      content: input.content,
      category: input.category,
      tagsJson: JSON.stringify(tags),
      site: input.site || null,
      project: input.project || null,
      source: input.source || 'manual',
      importance: clamp(input.importance ?? 0.5, 0, 1),
      contentHash,
      createdAt,
      updatedAt: now,
    });

    this.upsertEmbedding('general', id, buildGeneralEmbeddingText({
      category: input.category,
      content: input.content,
      tags,
      site: input.site,
      project: input.project,
      source: input.source || 'manual',
    }));

    return this.getGeneralMemoryById(id)!;
  }

  recallGeneralMemories(
    query: string,
    options: { category?: GeneralMemoryCategory; site?: string; project?: string; limit?: number } = {},
  ): GeneralMemoryRecord[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) {
      return [];
    }

    const results = this.browseGeneralMemories({
      query,
      category: options.category,
      site: options.site,
      project: options.project,
      limit: options.limit ?? 10,
    }).items;

    if (results.length > 0) {
      const now = new Date().toISOString();
      const updateStmt = this.db.prepare(`
        UPDATE general_memories
        SET recall_count = recall_count + 1,
            last_recalled_at = @lastRecalledAt,
            updated_at = @updatedAt
        WHERE id = @id
      `);
      for (const row of results) {
        updateStmt.run({ id: row.id, lastRecalledAt: now, updatedAt: now });
      }
    }

    return results.map(({ score, semanticScore, lexicalScore, ...record }) => record);
  }

  browseGeneralMemories(options: {
    query?: string;
    category?: GeneralMemoryCategory;
    site?: string;
    project?: string;
    limit?: number;
    offset?: number;
  } = {}): GeneralMemoryBrowseResult {
    if (options.project) {
      this.importLegacyWorkspaceMemories(options.project);
    }

    const rows = this.getGeneralMemoryRows(options);
    const ranked = this.rankGeneralRows(rows, options.query || '');
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 50);
    return {
      total: ranked.length,
      items: ranked.slice(offset, offset + limit),
    };
  }

  countGeneralMemories(category?: GeneralMemoryCategory): number {
    if (category) {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM general_memories WHERE category = @category').get({ category }) as { count: number };
      return row.count;
    }

    const row = this.db.prepare('SELECT COUNT(*) as count FROM general_memories').get() as { count: number };
    return row.count;
  }

  deleteGeneralMemory(id: string): boolean {
    this.db.prepare('DELETE FROM memory_embeddings WHERE scope = @scope AND memory_id = @memoryId').run({
      scope: 'general',
      memoryId: id,
    });
    const result = this.db.prepare('DELETE FROM general_memories WHERE id = @id').run({ id }) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  upsertClosureMemory(input: UpsertClosureMemoryInput): MemoryRecord {
    const now = new Date().toISOString();
    const createdAt = input.createdAt || now;
    const tags = normalizeTags(input.tags);
    const contentHash = buildHash(input.content);
    const existing = this.db.prepare(`
      SELECT *
      FROM closure_memories
      WHERE type = @type AND content_hash = @contentHash
      LIMIT 1
    `).get({ type: input.type, contentHash }) as DbClosureRow | undefined;

    if (existing) {
      const mergedTags = normalizeTags([...parseJsonArray(existing.tags_json), ...tags]);
      const mergedApplicability = normalizeTags([
        ...parseJsonArray(existing.applicability_json),
        ...(input.applicabilityConditions || []),
      ]);
      this.db.prepare(`
        UPDATE closure_memories
        SET title = @title,
            content = @content,
            tags_json = @tagsJson,
            confidence = @confidence,
            trigger_pattern = @triggerPattern,
            avoid_pattern = @avoidPattern,
            applicability_json = @applicabilityJson,
            source = @source,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        title: input.title || existing.title,
        content: input.content,
        tagsJson: JSON.stringify(mergedTags),
        confidence: Math.max(existing.confidence, clamp(input.confidence, 0.1, 1)),
        triggerPattern: input.triggerPattern || existing.trigger_pattern,
        avoidPattern: input.avoidPattern || existing.avoid_pattern,
        applicabilityJson: JSON.stringify(mergedApplicability),
        source: input.source || existing.source || 'manual',
        updatedAt: now,
      });
      this.upsertEmbedding('closure', existing.id, buildClosureEmbeddingText({
        type: input.type,
        title: input.title || existing.title || undefined,
        content: input.content,
        tags: mergedTags,
        applicabilityConditions: mergedApplicability,
        triggerPattern: input.triggerPattern || existing.trigger_pattern || undefined,
        avoidPattern: input.avoidPattern || existing.avoid_pattern || undefined,
      }));
      return this.getClosureMemoryById(existing.id)!;
    }

    const id = input.id || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO closure_memories (
        id, type, title, content, tags_json, confidence, trigger_pattern, avoid_pattern,
        applicability_json, source, content_hash, access_count, last_accessed, created_at, updated_at
      ) VALUES (
        @id, @type, @title, @content, @tagsJson, @confidence, @triggerPattern, @avoidPattern,
        @applicabilityJson, @source, @contentHash, @accessCount, @lastAccessed, @createdAt, @updatedAt
      )
    `).run({
      id,
      type: input.type,
      title: input.title || null,
      content: input.content,
      tagsJson: JSON.stringify(tags),
      confidence: clamp(input.confidence, 0.1, 1),
      triggerPattern: input.triggerPattern || null,
      avoidPattern: input.avoidPattern || null,
      applicabilityJson: JSON.stringify(normalizeTags(input.applicabilityConditions || [])),
      source: input.source || 'manual',
      contentHash,
      accessCount: input.accessCount ?? 0,
      lastAccessed: input.lastAccessed || null,
      createdAt,
      updatedAt: now,
    });

    this.upsertEmbedding('closure', id, buildClosureEmbeddingText({
      type: input.type,
      title: input.title,
      content: input.content,
      tags,
      applicabilityConditions: input.applicabilityConditions,
      triggerPattern: input.triggerPattern,
      avoidPattern: input.avoidPattern,
    }));

    return this.getClosureMemoryById(id)!;
  }

  queryClosureMemories(text: string, limit: number = 10): MemoryRecord[] {
    const words = text.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    if (words.length === 0) {
      return [];
    }

    const matches = this.browseClosureMemories({ query: text, limit }).items;

    if (matches.length > 0) {
      const now = new Date().toISOString();
      const updateStmt = this.db.prepare(`
        UPDATE closure_memories
        SET access_count = access_count + 1,
            last_accessed = @lastAccessed,
            updated_at = @updatedAt
        WHERE id = @id
      `);
      for (const row of matches) {
        updateStmt.run({ id: row.id, lastAccessed: now, updatedAt: now });
      }
    }

    return matches.map(({ score, semanticScore, lexicalScore, ...record }) => record);
  }

  browseClosureMemories(options: { query?: string; type?: MemoryType; limit?: number; offset?: number } = {}): ClosureMemoryBrowseResult {
    const rows = this.listClosureMemoryRows().filter(row => !options.type || row.type === options.type);
    const ranked = this.rankClosureRows(rows, options.query || '');
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 50);
    return {
      total: ranked.length,
      items: ranked.slice(offset, offset + limit),
    };
  }

  listClosureMemories(): MemoryRecord[] {
    return this.listClosureMemoryRows().map(toClosureRecord);
  }

  updateClosureMemory(id: string, updates: Partial<Pick<MemoryRecord, 'confidence' | 'lastAccessed' | 'accessCount'>>): MemoryRecord | null {
    const existing = this.getClosureMemoryRowById(id);
    if (!existing) {
      return null;
    }

    this.db.prepare(`
      UPDATE closure_memories
      SET confidence = @confidence,
          access_count = @accessCount,
          last_accessed = @lastAccessed,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      confidence: updates.confidence ?? existing.confidence,
      accessCount: updates.accessCount ?? existing.access_count,
      lastAccessed: updates.lastAccessed ?? existing.last_accessed,
      updatedAt: new Date().toISOString(),
    });

    return this.getClosureMemoryById(id);
  }

  deleteClosureMemory(id: string): boolean {
    this.db.prepare('DELETE FROM memory_embeddings WHERE scope = @scope AND memory_id = @memoryId').run({
      scope: 'closure',
      memoryId: id,
    });
    const result = this.db.prepare('DELETE FROM closure_memories WHERE id = @id').run({ id }) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  getMemoryStats(): MemoryStats {
    const generalRows = this.getGeneralMemoryRows();
    const closureRows = this.listClosureMemoryRows();
    const generalCounts: Record<string, number> = {};
    const closureCounts: Record<string, number> = {};

    for (const row of generalRows) {
      generalCounts[row.category] = (generalCounts[row.category] || 0) + 1;
    }
    for (const row of closureRows) {
      closureCounts[row.type] = (closureCounts[row.type] || 0) + 1;
    }

    const indexedGeneral = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings WHERE scope = @scope').get({ scope: 'general' }) as { count: number };
    const indexedClosure = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings WHERE scope = @scope').get({ scope: 'closure' }) as { count: number };

    return {
      general: {
        total: generalRows.length,
        byCategory: generalCounts,
      },
      closure: {
        total: closureRows.length,
        byType: closureCounts,
      },
      indexing: {
        provider: MEMORY_EMBEDDING_MODEL,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        indexedGeneral: indexedGeneral.count,
        indexedClosure: indexedClosure.count,
      },
    };
  }

  reindexAllMemories(): { general: number; closure: number } {
    const generalRows = this.getGeneralMemoryRows();
    const closureRows = this.listClosureMemoryRows();

    for (const row of generalRows) {
      this.upsertEmbedding('general', row.id, buildGeneralEmbeddingText({
        category: row.category,
        content: row.content,
        tags: parseJsonArray(row.tags_json),
        site: row.site || undefined,
        project: row.project || undefined,
        source: row.source,
      }));
    }
    for (const row of closureRows) {
      this.upsertEmbedding('closure', row.id, buildClosureEmbeddingText({
        type: row.type,
        title: row.title || undefined,
        content: row.content,
        tags: parseJsonArray(row.tags_json),
        applicabilityConditions: parseJsonArray(row.applicability_json),
        triggerPattern: row.trigger_pattern || undefined,
        avoidPattern: row.avoid_pattern || undefined,
      }));
    }

    return { general: generalRows.length, closure: closureRows.length };
  }

  clearForTesting(): void {
    this.db.exec('DELETE FROM memory_embeddings; DELETE FROM general_memories; DELETE FROM closure_memories; DELETE FROM memory_meta;');
  }

  close(): void {
    if (typeof this.db.close === 'function') {
      this.db.close();
    }
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS general_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        site TEXT,
        project TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        importance REAL NOT NULL DEFAULT 0.5,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_general_memories_dedupe
      ON general_memories(category, content_hash, ifnull(site, ''), ifnull(project, ''));

      CREATE INDEX IF NOT EXISTS idx_general_memories_category ON general_memories(category);

      CREATE TABLE IF NOT EXISTS closure_memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        trigger_pattern TEXT,
        avoid_pattern TEXT,
        applicability_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual',
        content_hash TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_closure_memories_dedupe
      ON closure_memories(type, content_hash);

      CREATE INDEX IF NOT EXISTS idx_closure_memories_type ON closure_memories(type);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        scope TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        source_text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_scope ON memory_embeddings(scope);
    `);

    this.importLegacyGlobalMemories();
    this.importLegacyClosureMemories();
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM memory_meta WHERE key = @key').get({ key }) as { value: string } | undefined;
    return row?.value || null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO memory_meta (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ key, value });
  }

  private importLegacyGlobalMemories(): void {
    if (this.getMeta('legacy_global_memories_imported') === '1') {
      return;
    }

    if (existsSync(LEGACY_GLOBAL_MEMORY_DIR)) {
      for (const fileName of readdirSync(LEGACY_GLOBAL_MEMORY_DIR)) {
        if (!fileName.endsWith('.json')) {
          continue;
        }

        const category = fileName.replace(/\.json$/i, '') as GeneralMemoryCategory;
        if (!GENERAL_MEMORY_CATEGORIES.includes(category)) {
          continue;
        }

        try {
          const raw = readFileSync(join(LEGACY_GLOBAL_MEMORY_DIR, fileName), 'utf-8');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            continue;
          }
          for (const entry of parsed) {
            if (!entry || typeof entry.content !== 'string') {
              continue;
            }
            this.saveGeneralMemory({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              content: entry.content,
              category,
              tags: Array.isArray(entry.tags) ? entry.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [],
              site: typeof entry.site === 'string' ? entry.site : undefined,
              project: typeof entry.project === 'string' ? entry.project : undefined,
              source: 'legacy-json-migration',
              importance: 0.7,
              createdAt: typeof entry.timestamp === 'string'
                ? entry.timestamp
                : typeof entry.timestamp === 'number'
                  ? new Date(entry.timestamp).toISOString()
                  : undefined,
            });
          }
        } catch {
          // Ignore invalid legacy files.
        }
      }
    }

    this.setMeta('legacy_global_memories_imported', '1');
  }

  private importLegacyClosureMemories(): void {
    if (this.getMeta('legacy_closure_memories_imported') === '1') {
      return;
    }

    if (existsSync(LEGACY_CLOSURE_MEMORIES_FILE)) {
      try {
        const raw = readFileSync(LEGACY_CLOSURE_MEMORIES_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (!entry || typeof entry.content !== 'string' || typeof entry.type !== 'string') {
              continue;
            }

            this.upsertClosureMemory({
              id: typeof entry.id === 'string' ? entry.id : undefined,
              type: entry.type as MemoryType,
              title: typeof entry.title === 'string' ? entry.title : undefined,
              content: entry.content,
              tags: Array.isArray(entry.tags) ? entry.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [],
              confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.7,
              triggerPattern: typeof entry.triggerPattern === 'string' ? entry.triggerPattern : undefined,
              avoidPattern: typeof entry.avoidPattern === 'string' ? entry.avoidPattern : undefined,
              applicabilityConditions: Array.isArray(entry.applicabilityConditions)
                ? entry.applicabilityConditions.filter((value: unknown): value is string => typeof value === 'string')
                : [],
              source: 'legacy-json-migration',
              createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
              lastAccessed: typeof entry.lastAccessed === 'string' ? entry.lastAccessed : undefined,
              accessCount: typeof entry.accessCount === 'number' ? entry.accessCount : 0,
            });
          }
        }
      } catch {
        // Ignore invalid legacy files.
      }
    }

    this.setMeta('legacy_closure_memories_imported', '1');
  }

  private importLegacyWorkspaceMemories(project: string): void {
    const filePath = join(project, '.woodbury-work', 'memory.json');
    const metaKey = `legacy_workspace_imported:${filePath}`;
    if (this.getMeta(metaKey) === '1') {
      return;
    }

    if (!existsSync(filePath)) {
      this.setMeta(metaKey, '1');
      return;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry.content !== 'string' || typeof entry.category !== 'string') {
            continue;
          }

          if (!GENERAL_MEMORY_CATEGORIES.includes(entry.category as GeneralMemoryCategory)) {
            continue;
          }

          this.saveGeneralMemory({
            id: typeof entry.id === 'string' ? entry.id : undefined,
            content: entry.content,
            category: entry.category as GeneralMemoryCategory,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [],
            project,
            source: 'legacy-workspace-migration',
            importance: 0.6,
            createdAt: typeof entry.timestamp === 'number'
              ? new Date(entry.timestamp).toISOString()
              : typeof entry.timestamp === 'string'
                ? entry.timestamp
                : undefined,
          });
        }
      }
    } catch {
      // Ignore invalid legacy workspace files.
    }

    this.setMeta(metaKey, '1');
  }

  private getGeneralMemoryRows(options: { category?: GeneralMemoryCategory; site?: string; project?: string } = {}): DbGeneralRow[] {
    const clauses = ['1 = 1'];
    const params: Record<string, unknown> = {};

    if (options.category) {
      clauses.push('category = @category');
      params.category = options.category;
    }
    if (options.site) {
      clauses.push("lower(ifnull(site, '')) LIKE @site");
      params.site = `%${options.site.toLowerCase()}%`;
    }
    if (options.project) {
      clauses.push('project = @project');
      params.project = options.project;
    }

    const sql = `
      SELECT *
      FROM general_memories
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
    `;
    return this.db.prepare(sql).all(params) as DbGeneralRow[];
  }

  private getGeneralMemoryById(id: string): GeneralMemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM general_memories WHERE id = @id').get({ id }) as DbGeneralRow | undefined;
    return row ? toGeneralRecord(row) : null;
  }

  private listClosureMemoryRows(): DbClosureRow[] {
    return this.db.prepare('SELECT * FROM closure_memories ORDER BY updated_at DESC, created_at DESC').all() as DbClosureRow[];
  }

  private getClosureMemoryRowById(id: string): DbClosureRow | null {
    const row = this.db.prepare('SELECT * FROM closure_memories WHERE id = @id').get({ id }) as DbClosureRow | undefined;
    return row || null;
  }

  private getClosureMemoryById(id: string): MemoryRecord | null {
    const row = this.getClosureMemoryRowById(id);
    return row ? toClosureRecord(row) : null;
  }

  private rankGeneralRows(rows: DbGeneralRow[], query: string): GeneralMemoryMatch[] {
    const queryText = query.trim();
    if (!queryText) {
      return rows
        .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
        .map(row => ({ ...toGeneralRecord(row), score: 0, semanticScore: 0, lexicalScore: 0 }));
    }

    const queryEmbedding = computeSemanticEmbedding(queryText);
    const queryTerms = tokenizeSemanticText(queryText);
    const embeddings = this.getEmbeddings('general', rows.map(row => row.id));

    return rows
      .map(row => {
        const lexicalScore = this.computeGeneralLexicalScore(row, queryTerms);
        const embedding = embeddings.get(row.id) || queryEmbedding.map(() => 0);
        const semanticScore = cosineSimilarity(queryEmbedding, embedding);
        const score = ((semanticScore * 0.82) + (lexicalScore * 0.18)) * Math.max(0.25, row.importance || 0.5);
        return { ...toGeneralRecord(row), score, semanticScore, lexicalScore };
      })
      .filter(match => this.shouldIncludeGeneralMatch(match))
      .sort((left, right) => right.score - left.score || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  private rankClosureRows(rows: DbClosureRow[], query: string): ClosureMemoryMatch[] {
    const queryText = query.trim();
    if (!queryText) {
      return rows
        .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
        .map(row => ({ ...toClosureRecord(row), score: 0, semanticScore: 0, lexicalScore: 0 }));
    }

    const queryEmbedding = computeSemanticEmbedding(queryText);
    const queryTerms = tokenizeSemanticText(queryText);
    const embeddings = this.getEmbeddings('closure', rows.map(row => row.id));

    return rows
      .map(row => {
        const lexicalScore = this.computeClosureLexicalScore(row, queryTerms, queryText);
        const embedding = embeddings.get(row.id) || queryEmbedding.map(() => 0);
        const semanticScore = cosineSimilarity(queryEmbedding, embedding);
        let score = ((semanticScore * 0.8) + (lexicalScore * 0.2)) * row.confidence;
        if (row.type === 'failure') score *= 1.15;
        if (row.type === 'procedural') score *= 1.1;
        return { ...toClosureRecord(row), score, semanticScore, lexicalScore };
      })
      .filter(match => this.shouldIncludeClosureMatch(match))
      .sort((left, right) => right.score - left.score || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  private shouldIncludeGeneralMatch(match: GeneralMemoryMatch): boolean {
    if (match.lexicalScore > 0) {
      return true;
    }

    return match.semanticScore >= 0.45 && match.score >= 0.12;
  }

  private shouldIncludeClosureMatch(match: ClosureMemoryMatch): boolean {
    if (match.lexicalScore > 0) {
      return true;
    }

    return match.semanticScore >= 0.45 && match.score >= 0.12;
  }

  private computeGeneralLexicalScore(row: DbGeneralRow, queryTerms: string[]): number {
    if (queryTerms.length === 0) {
      return 0;
    }

    const contentLower = row.content.toLowerCase();
    const tagsLower = parseJsonArray(row.tags_json).map(tag => tag.toLowerCase());
    const categoryLower = row.category.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (tagsLower.some(tag => tag.includes(term))) score += 3;
      if (contentLower.includes(term)) score += 2;
      if (categoryLower.includes(term)) score += 1;
    }

    return score / Math.max(1, queryTerms.length * 3);
  }

  private computeClosureLexicalScore(row: DbClosureRow, queryTerms: string[], queryText: string): number {
    if (queryTerms.length === 0) {
      return 0;
    }

    const contentLower = row.content.toLowerCase();
    const tagsLower = parseJsonArray(row.tags_json).map(tag => tag.toLowerCase());
    let score = 0;

    for (const term of queryTerms) {
      if (contentLower.includes(term)) score += 1;
      if (tagsLower.some(tag => tag.includes(term))) score += 2;
    }
    if (row.trigger_pattern) {
      try {
        if (new RegExp(row.trigger_pattern, 'i').test(queryText)) score += 4;
      } catch {
        // Ignore invalid regex patterns.
      }
    }

    return score / Math.max(1, queryTerms.length * 2);
  }

  private upsertEmbedding(scope: 'general' | 'closure', memoryId: string, sourceText: string): void {
    const updatedAt = new Date().toISOString();
    const textHash = buildHash(sourceText);
    const existing = this.db.prepare(`
      SELECT *
      FROM memory_embeddings
      WHERE scope = @scope AND memory_id = @memoryId
      LIMIT 1
    `).get({ scope, memoryId }) as DbEmbeddingRow | undefined;

    if (existing && existing.text_hash === textHash) {
      return;
    }

    const embedding = computeSemanticEmbedding(sourceText, MEMORY_EMBEDDING_DIMENSIONS);
    this.db.prepare(`
      INSERT INTO memory_embeddings (scope, memory_id, model, dimensions, embedding_json, source_text, text_hash, updated_at)
      VALUES (@scope, @memoryId, @model, @dimensions, @embeddingJson, @sourceText, @textHash, @updatedAt)
      ON CONFLICT(scope, memory_id) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        embedding_json = excluded.embedding_json,
        source_text = excluded.source_text,
        text_hash = excluded.text_hash,
        updated_at = excluded.updated_at
    `).run({
      scope,
      memoryId,
      model: MEMORY_EMBEDDING_MODEL,
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      embeddingJson: JSON.stringify(embedding),
      sourceText,
      textHash,
      updatedAt,
    });
  }

  private getEmbeddings(scope: 'general' | 'closure', ids: string[]): Map<string, number[]> {
    const embeddings = new Map<string, number[]>();
    if (ids.length === 0) {
      return embeddings;
    }

    const rows = this.db.prepare('SELECT * FROM memory_embeddings WHERE scope = @scope').all({ scope }) as DbEmbeddingRow[];
    const idSet = new Set(ids);
    for (const row of rows) {
      if (!idSet.has(row.memory_id)) {
        continue;
      }
      const vector = parseNumberArray(row.embedding_json);
      if (vector.length > 0) {
        embeddings.set(row.memory_id, vector);
      }
    }
    return embeddings;
  }
}

export function getSQLiteMemoryStore(dbPath?: string): SQLiteMemoryStore {
  const resolvedPath = dbPath || resolveMemoryDbPath();
  const existing = storeCache.get(resolvedPath);
  if (existing) {
    return existing;
  }

  const store = new SQLiteMemoryStore(resolvedPath);
  storeCache.set(resolvedPath, store);
  return store;
}

export function resetSQLiteMemoryStoreCache(): void {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}
