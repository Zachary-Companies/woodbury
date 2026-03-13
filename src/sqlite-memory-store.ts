import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { MemoryRecord, MemoryType } from './loop/v3/types.js';

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
  markdownPath?: string;
  metadataPath?: string;
  directoryPath?: string;
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
  markdownPath?: string;
  metadataPath?: string;
  directoryPath?: string;
}

export interface MemoryArtifactPaths {
  directoryPath: string;
  markdownPath: string;
  metadataPath: string;
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

interface StoredGeneralMemory extends GeneralMemoryRecord {
  contentHash: string;
}

interface StoredClosureMemory extends MemoryRecord {
  source: string;
  contentHash: string;
}

interface StoredEmbeddingRecord {
  scope: 'general' | 'closure';
  memoryId: string;
  model: string;
  dimensions: number;
  embedding: number[];
  sourceText: string;
  textHash: string;
  updatedAt: string;
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

const DEFAULT_STORE_PATH = join(homedir(), '.woodbury', 'data', 'memory', 'memory-store');
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

function resolveConfiguredStorePath(): string {
  return process.env.WOODBURY_MEMORY_DB_PATH || DEFAULT_STORE_PATH;
}

function resolveStoreBasePath(configuredPath: string): string {
  const extension = extname(configuredPath);
  return extension ? configuredPath.slice(0, -extension.length) : configuredPath;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, filePath);
}

function writeJson(filePath: string, value: unknown): void {
  atomicWriteText(filePath, JSON.stringify(value, null, 2));
}

function ensureDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function sanitizePathSegment(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'uncategorized';
}

function listFilesRecursive(dirPath: string, extension: string): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(entryPath, extension));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(entryPath);
    }
  }
  return results;
}

function readStructuredJsonRecords<T>(dirPath: string): T[] {
  const items: T[] = [];
  for (const filePath of listFilesRecursive(dirPath, '.json')) {
    try {
      items.push(JSON.parse(readFileSync(filePath, 'utf-8')) as T);
    } catch {
      // Ignore malformed record files.
    }
  }
  return items;
}

function readLegacyJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) {
    return [];
  }

  const items: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed legacy lines.
    }
  }
  return items;
}

function resetDirectory(dirPath: string): void {
  rmSync(dirPath, { recursive: true, force: true });
  ensureDirectory(dirPath);
}

function renderMarkdownRecord(title: string, sections: Array<{ label: string; value?: string | number | string[] }>, content: string): string {
  const lines = [`# ${title}`, ''];

  for (const section of sections) {
    if (section.value === undefined) {
      continue;
    }

    if (Array.isArray(section.value)) {
      if (section.value.length === 0) {
        continue;
      }
      lines.push(`- ${section.label}: ${section.value.join(', ')}`);
      continue;
    }

    lines.push(`- ${section.label}: ${String(section.value)}`);
  }

  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }

  lines.push(content.trim());
  lines.push('');
  return lines.join('\n');
}

function writeRecordFiles(basePath: string, markdown: string, metadata: unknown): void {
  atomicWriteText(`${basePath}.md`, markdown);
  writeJson(`${basePath}.json`, metadata);
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

function cloneGeneralRecord(record: StoredGeneralMemory): GeneralMemoryRecord {
  return {
    id: record.id,
    content: record.content,
    category: record.category,
    tags: [...record.tags],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    site: record.site,
    project: record.project,
    source: record.source,
    importance: record.importance,
    lastRecalledAt: record.lastRecalledAt,
    recallCount: record.recallCount,
  };
}

function cloneClosureRecord(record: StoredClosureMemory): MemoryRecord {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    content: record.content,
    tags: [...record.tags],
    confidence: record.confidence,
    triggerPattern: record.triggerPattern,
    avoidPattern: record.avoidPattern,
    applicabilityConditions: [...(record.applicabilityConditions || [])],
    accessCount: record.accessCount,
    lastAccessed: record.lastAccessed,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class SQLiteMemoryStore {
  private readonly storeRootDir: string;
  private readonly generalRootDir: string;
  private readonly closureRootDir: string;
  private readonly embeddingsRootDir: string;
  private readonly metaPath: string;
  private readonly legacyGeneralPath: string;
  private readonly legacyClosurePath: string;
  private readonly legacyEmbeddingsPath: string;
  private readonly legacyMetaPath: string;
  private readonly generalMemories = new Map<string, StoredGeneralMemory>();
  private readonly closureMemories = new Map<string, StoredClosureMemory>();
  private readonly embeddings = new Map<string, StoredEmbeddingRecord>();
  private meta: Record<string, string> = {};

  constructor(private readonly dbPath: string = resolveConfiguredStorePath()) {
    const basePath = resolveStoreBasePath(this.dbPath);
    this.storeRootDir = basePath;
    this.generalRootDir = join(this.storeRootDir, 'general');
    this.closureRootDir = join(this.storeRootDir, 'closure');
    this.embeddingsRootDir = join(this.storeRootDir, 'embeddings');
    this.metaPath = join(this.storeRootDir, 'meta.json');
    this.legacyGeneralPath = `${basePath}.general.jsonl`;
    this.legacyClosurePath = `${basePath}.closure.jsonl`;
    this.legacyEmbeddingsPath = `${basePath}.embeddings.jsonl`;
    this.legacyMetaPath = `${basePath}.meta.json`;
    ensureDirectory(this.storeRootDir);
    this.initialize();
  }

  saveGeneralMemory(input: SaveGeneralMemoryInput): GeneralMemoryRecord {
    const now = new Date().toISOString();
    const tags = normalizeTags(input.tags);
    const contentHash = buildHash(input.content);
    const siteKey = input.site || '';
    const projectKey = input.project || '';

    const existing = Array.from(this.generalMemories.values()).find(record => (
      record.category === input.category
      && record.contentHash === contentHash
      && (record.site || '') === siteKey
      && (record.project || '') === projectKey
    ));

    if (existing) {
      existing.content = input.content;
      existing.tags = normalizeTags([...existing.tags, ...tags]);
      existing.updatedAt = now;
      existing.site = input.site;
      existing.project = input.project;
      existing.source = input.source || existing.source || 'manual';
      existing.importance = Math.max(existing.importance, input.importance ?? existing.importance ?? 0.5);
      this.generalMemories.set(existing.id, existing);
      this.upsertEmbedding('general', existing.id, buildGeneralEmbeddingText({
        category: input.category,
        content: input.content,
        tags: existing.tags,
        site: input.site,
        project: input.project,
        source: existing.source,
      }));
      this.persistGeneralMemories();
      return cloneGeneralRecord(existing);
    }

    const createdAt = input.createdAt || now;
    const record: StoredGeneralMemory = {
      id: input.id || randomUUID(),
      content: input.content,
      category: input.category,
      tags,
      createdAt,
      updatedAt: now,
      site: input.site,
      project: input.project,
      source: input.source || 'manual',
      importance: clamp(input.importance ?? 0.5, 0, 1),
      lastRecalledAt: undefined,
      recallCount: 0,
      contentHash,
    };
    this.generalMemories.set(record.id, record);
    this.upsertEmbedding('general', record.id, buildGeneralEmbeddingText({
      category: record.category,
      content: record.content,
      tags: record.tags,
      site: record.site,
      project: record.project,
      source: record.source,
    }));
    this.persistGeneralMemories();
    return cloneGeneralRecord(record);
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
      for (const result of results) {
        const stored = this.generalMemories.get(result.id);
        if (!stored) continue;
        stored.recallCount += 1;
        stored.lastRecalledAt = now;
        stored.updatedAt = now;
      }
      this.persistGeneralMemories();
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

    const rows = Array.from(this.generalMemories.values()).filter(record => {
      if (options.category && record.category !== options.category) return false;
      if (options.site && !(record.site || '').toLowerCase().includes(options.site.toLowerCase())) return false;
      if (options.project && record.project !== options.project) return false;
      return true;
    });
    const ranked = this.rankGeneralRows(rows, options.query || '');
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 50);
    return {
      total: ranked.length,
      items: ranked.slice(offset, offset + limit),
    };
  }

  countGeneralMemories(category?: GeneralMemoryCategory): number {
    return Array.from(this.generalMemories.values()).filter(record => !category || record.category === category).length;
  }

  deleteGeneralMemory(id: string): boolean {
    const deleted = this.generalMemories.delete(id);
    if (!deleted) {
      return false;
    }
    this.embeddings.delete(this.embeddingKey('general', id));
    this.persistGeneralMemories();
    this.persistEmbeddings();
    return true;
  }

  upsertClosureMemory(input: UpsertClosureMemoryInput): MemoryRecord {
    const now = new Date().toISOString();
    const tags = normalizeTags(input.tags);
    const contentHash = buildHash(input.content);
    const existing = Array.from(this.closureMemories.values()).find(record => record.type === input.type && record.contentHash === contentHash);

    if (existing) {
      existing.title = input.title || existing.title;
      existing.content = input.content;
      existing.tags = normalizeTags([...existing.tags, ...tags]);
      existing.confidence = Math.max(existing.confidence, clamp(input.confidence, 0.1, 1));
      existing.triggerPattern = input.triggerPattern || existing.triggerPattern;
      existing.avoidPattern = input.avoidPattern || existing.avoidPattern;
      existing.applicabilityConditions = normalizeTags([...(existing.applicabilityConditions || []), ...(input.applicabilityConditions || [])]);
      existing.source = input.source || existing.source || 'manual';
      existing.updatedAt = now;
      this.closureMemories.set(existing.id, existing);
      this.upsertEmbedding('closure', existing.id, buildClosureEmbeddingText({
        type: existing.type,
        title: existing.title,
        content: existing.content,
        tags: existing.tags,
        applicabilityConditions: existing.applicabilityConditions,
        triggerPattern: existing.triggerPattern,
        avoidPattern: existing.avoidPattern,
      }));
      this.persistClosureMemories();
      return cloneClosureRecord(existing);
    }

    const createdAt = input.createdAt || now;
    const record: StoredClosureMemory = {
      id: input.id || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: input.type,
      title: input.title,
      content: input.content,
      tags,
      confidence: clamp(input.confidence, 0.1, 1),
      triggerPattern: input.triggerPattern,
      avoidPattern: input.avoidPattern,
      applicabilityConditions: normalizeTags(input.applicabilityConditions || []),
      accessCount: input.accessCount ?? 0,
      lastAccessed: input.lastAccessed,
      createdAt,
      updatedAt: now,
      source: input.source || 'manual',
      contentHash,
    };
    this.closureMemories.set(record.id, record);
    this.upsertEmbedding('closure', record.id, buildClosureEmbeddingText({
      type: record.type,
      title: record.title,
      content: record.content,
      tags: record.tags,
      applicabilityConditions: record.applicabilityConditions,
      triggerPattern: record.triggerPattern,
      avoidPattern: record.avoidPattern,
    }));
    this.persistClosureMemories();
    return cloneClosureRecord(record);
  }

  queryClosureMemories(text: string, limit: number = 10): MemoryRecord[] {
    const words = text.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    if (words.length === 0) {
      return [];
    }

    const matches = this.browseClosureMemories({ query: text, limit }).items;
    if (matches.length > 0) {
      const now = new Date().toISOString();
      for (const match of matches) {
        const stored = this.closureMemories.get(match.id);
        if (!stored) continue;
        stored.accessCount += 1;
        stored.lastAccessed = now;
        stored.updatedAt = now;
      }
      this.persistClosureMemories();
    }

    return matches.map(({ score, semanticScore, lexicalScore, ...record }) => record);
  }

  browseClosureMemories(options: { query?: string; type?: MemoryType; limit?: number; offset?: number } = {}): ClosureMemoryBrowseResult {
    const rows = Array.from(this.closureMemories.values()).filter(record => !options.type || record.type === options.type);
    const ranked = this.rankClosureRows(rows, options.query || '');
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 50);
    return {
      total: ranked.length,
      items: ranked.slice(offset, offset + limit),
    };
  }

  listClosureMemories(): MemoryRecord[] {
    return Array.from(this.closureMemories.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .map(record => cloneClosureRecord(record));
  }

  updateClosureMemory(id: string, updates: Partial<Pick<MemoryRecord, 'confidence' | 'lastAccessed' | 'accessCount'>>): MemoryRecord | null {
    const existing = this.closureMemories.get(id);
    if (!existing) {
      return null;
    }

    existing.confidence = updates.confidence ?? existing.confidence;
    existing.accessCount = updates.accessCount ?? existing.accessCount;
    existing.lastAccessed = updates.lastAccessed ?? existing.lastAccessed;
    existing.updatedAt = new Date().toISOString();
    this.persistClosureMemories();
    return cloneClosureRecord(existing);
  }

  deleteClosureMemory(id: string): boolean {
    const deleted = this.closureMemories.delete(id);
    if (!deleted) {
      return false;
    }
    this.embeddings.delete(this.embeddingKey('closure', id));
    this.persistClosureMemories();
    this.persistEmbeddings();
    return true;
  }

  getMemoryStats(): MemoryStats {
    const generalCounts: Record<string, number> = {};
    const closureCounts: Record<string, number> = {};

    for (const record of this.generalMemories.values()) {
      generalCounts[record.category] = (generalCounts[record.category] || 0) + 1;
    }
    for (const record of this.closureMemories.values()) {
      closureCounts[record.type] = (closureCounts[record.type] || 0) + 1;
    }

    let indexedGeneral = 0;
    let indexedClosure = 0;
    for (const embedding of this.embeddings.values()) {
      if (embedding.scope === 'general') indexedGeneral += 1;
      if (embedding.scope === 'closure') indexedClosure += 1;
    }

    return {
      general: {
        total: this.generalMemories.size,
        byCategory: generalCounts,
      },
      closure: {
        total: this.closureMemories.size,
        byType: closureCounts,
      },
      indexing: {
        provider: MEMORY_EMBEDDING_MODEL,
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        indexedGeneral,
        indexedClosure,
      },
    };
  }

  reindexAllMemories(): { general: number; closure: number } {
    const nextEmbeddings = new Map<string, StoredEmbeddingRecord>();

    for (const record of this.generalMemories.values()) {
      const sourceText = buildGeneralEmbeddingText({
        category: record.category,
        content: record.content,
        tags: record.tags,
        site: record.site,
        project: record.project,
        source: record.source,
      });
      nextEmbeddings.set(this.embeddingKey('general', record.id), this.buildEmbeddingRecord('general', record.id, sourceText));
    }

    for (const record of this.closureMemories.values()) {
      const sourceText = buildClosureEmbeddingText({
        type: record.type,
        title: record.title,
        content: record.content,
        tags: record.tags,
        applicabilityConditions: record.applicabilityConditions,
        triggerPattern: record.triggerPattern,
        avoidPattern: record.avoidPattern,
      });
      nextEmbeddings.set(this.embeddingKey('closure', record.id), this.buildEmbeddingRecord('closure', record.id, sourceText));
    }

    this.embeddings.clear();
    for (const [key, value] of nextEmbeddings.entries()) {
      this.embeddings.set(key, value);
    }
    this.persistEmbeddings();
    return { general: this.generalMemories.size, closure: this.closureMemories.size };
  }

  clearForTesting(): void {
    this.generalMemories.clear();
    this.closureMemories.clear();
    this.embeddings.clear();
    this.meta = {};
    resetDirectory(this.generalRootDir);
    resetDirectory(this.closureRootDir);
    resetDirectory(this.embeddingsRootDir);
    this.persistGeneralMemories();
    this.persistClosureMemories();
    this.persistEmbeddings();
    writeJson(this.metaPath, this.meta);
    rmSync(this.legacyGeneralPath, { force: true });
    rmSync(this.legacyClosurePath, { force: true });
    rmSync(this.legacyEmbeddingsPath, { force: true });
    rmSync(this.legacyMetaPath, { force: true });
  }

  close(): void {
    // No runtime handle to close for file-backed storage.
  }

  getMemoryArtifactPaths(scope: 'general' | 'closure', id: string): MemoryArtifactPaths | null {
    if (scope === 'general') {
      const record = this.generalMemories.get(id);
      return record ? this.getGeneralRecordPaths(record) : null;
    }

    const record = this.closureMemories.get(id);
    return record ? this.getClosureRecordPaths(record) : null;
  }

  private initialize(): void {
    this.loadState();
    this.importLegacyGlobalMemories();
    this.importLegacyClosureMemories();
  }

  private loadState(): void {
    this.generalMemories.clear();
    for (const record of [
      ...readLegacyJsonl<StoredGeneralMemory>(this.legacyGeneralPath),
      ...readStructuredJsonRecords<StoredGeneralMemory>(this.generalRootDir),
    ]) {
      if (!record || typeof record.id !== 'string' || typeof record.content !== 'string' || typeof record.category !== 'string') {
        continue;
      }
      this.generalMemories.set(record.id, {
        ...record,
        tags: normalizeTags(record.tags),
        importance: clamp(record.importance ?? 0.5, 0, 1),
        recallCount: record.recallCount ?? 0,
        source: record.source || 'manual',
        contentHash: record.contentHash || buildHash(record.content),
      });
    }

    this.closureMemories.clear();
    for (const record of [
      ...readLegacyJsonl<StoredClosureMemory>(this.legacyClosurePath),
      ...readStructuredJsonRecords<StoredClosureMemory>(this.closureRootDir),
    ]) {
      if (!record || typeof record.id !== 'string' || typeof record.content !== 'string' || typeof record.type !== 'string') {
        continue;
      }
      this.closureMemories.set(record.id, {
        ...record,
        tags: normalizeTags(record.tags),
        applicabilityConditions: normalizeTags(record.applicabilityConditions || []),
        confidence: clamp(record.confidence ?? 0.7, 0.1, 1),
        accessCount: record.accessCount ?? 0,
        source: record.source || 'manual',
        contentHash: record.contentHash || buildHash(record.content),
      });
    }

    this.embeddings.clear();
    for (const record of [
      ...readLegacyJsonl<StoredEmbeddingRecord>(this.legacyEmbeddingsPath),
      ...readStructuredJsonRecords<StoredEmbeddingRecord>(this.embeddingsRootDir),
    ]) {
      if (!record || typeof record.memoryId !== 'string' || !Array.isArray(record.embedding) || typeof record.scope !== 'string') {
        continue;
      }
      this.embeddings.set(this.embeddingKey(record.scope, record.memoryId), {
        ...record,
        model: record.model || MEMORY_EMBEDDING_MODEL,
        dimensions: record.dimensions || MEMORY_EMBEDDING_DIMENSIONS,
        embedding: record.embedding.filter((value): value is number => typeof value === 'number'),
      });
    }

    this.meta = {
      ...readJson<Record<string, string>>(this.legacyMetaPath, {}),
      ...readJson<Record<string, string>>(this.metaPath, {}),
    };
  }

  private getMeta(key: string): string | null {
    return this.meta[key] || null;
  }

  private setMeta(key: string, value: string): void {
    this.meta[key] = value;
    writeJson(this.metaPath, this.meta);
  }

  private persistGeneralMemories(): void {
    const records = Array.from(this.generalMemories.values())
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    resetDirectory(this.generalRootDir);
    for (const record of records) {
      const paths = this.getGeneralRecordPaths(record);
      const fileBase = paths.markdownPath.replace(/\.md$/, '');
      writeRecordFiles(
        fileBase,
        renderMarkdownRecord(
          `${record.category.replace(/_/g, ' ')} memory`,
          [
            { label: 'ID', value: record.id },
            { label: 'Category', value: record.category },
            { label: 'Tags', value: record.tags },
            { label: 'Site', value: record.site },
            { label: 'Project', value: record.project },
            { label: 'Source', value: record.source },
            { label: 'Importance', value: record.importance },
            { label: 'Created', value: record.createdAt },
            { label: 'Updated', value: record.updatedAt },
            { label: 'Recall count', value: record.recallCount },
            { label: 'Last recalled', value: record.lastRecalledAt },
          ],
          record.content,
        ),
        record,
      );
    }
  }

  private persistClosureMemories(): void {
    const records = Array.from(this.closureMemories.values())
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    resetDirectory(this.closureRootDir);
    for (const record of records) {
      const paths = this.getClosureRecordPaths(record);
      const fileBase = paths.markdownPath.replace(/\.md$/, '');
      writeRecordFiles(
        fileBase,
        renderMarkdownRecord(
          record.title || `${record.type} memory`,
          [
            { label: 'ID', value: record.id },
            { label: 'Type', value: record.type },
            { label: 'Tags', value: record.tags },
            { label: 'Confidence', value: record.confidence },
            { label: 'Trigger pattern', value: record.triggerPattern },
            { label: 'Avoid pattern', value: record.avoidPattern },
            { label: 'Applicability conditions', value: record.applicabilityConditions },
            { label: 'Source', value: record.source },
            { label: 'Created', value: record.createdAt },
            { label: 'Updated', value: record.updatedAt },
            { label: 'Access count', value: record.accessCount },
            { label: 'Last accessed', value: record.lastAccessed },
          ],
          record.content,
        ),
        record,
      );
    }
  }

  private persistEmbeddings(): void {
    const records = Array.from(this.embeddings.values())
      .sort((left, right) => left.scope.localeCompare(right.scope) || left.memoryId.localeCompare(right.memoryId));
    resetDirectory(this.embeddingsRootDir);
    for (const record of records) {
      const scopeDir = join(this.embeddingsRootDir, sanitizePathSegment(record.scope));
      const fileBase = join(scopeDir, sanitizePathSegment(record.memoryId));
      writeJson(`${fileBase}.json`, record);
    }
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

  private rankGeneralRows(rows: StoredGeneralMemory[], query: string): GeneralMemoryMatch[] {
    const queryText = query.trim();
    if (!queryText) {
      return rows
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .map(record => ({ ...cloneGeneralRecord(record), ...this.getGeneralRecordPaths(record), score: 0, semanticScore: 0, lexicalScore: 0 }));
    }

    const queryEmbedding = computeSemanticEmbedding(queryText);
    const queryTerms = tokenizeSemanticText(queryText);

    return rows
      .map(record => {
        const lexicalScore = this.computeGeneralLexicalScore(record, queryTerms);
        const embedding = this.embeddings.get(this.embeddingKey('general', record.id))?.embedding || queryEmbedding.map(() => 0);
        const semanticScore = cosineSimilarity(queryEmbedding, embedding);
        const score = ((semanticScore * 0.82) + (lexicalScore * 0.18)) * Math.max(0.25, record.importance || 0.5);
        return { ...cloneGeneralRecord(record), ...this.getGeneralRecordPaths(record), score, semanticScore, lexicalScore };
      })
      .filter(match => this.shouldIncludeGeneralMatch(match))
      .sort((left, right) => right.score - left.score || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  private rankClosureRows(rows: StoredClosureMemory[], query: string): ClosureMemoryMatch[] {
    const queryText = query.trim();
    if (!queryText) {
      return rows
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .map(record => ({ ...cloneClosureRecord(record), ...this.getClosureRecordPaths(record), score: 0, semanticScore: 0, lexicalScore: 0 }));
    }

    const queryEmbedding = computeSemanticEmbedding(queryText);
    const queryTerms = tokenizeSemanticText(queryText);

    return rows
      .map(record => {
        const lexicalScore = this.computeClosureLexicalScore(record, queryTerms, queryText);
        const embedding = this.embeddings.get(this.embeddingKey('closure', record.id))?.embedding || queryEmbedding.map(() => 0);
        const semanticScore = cosineSimilarity(queryEmbedding, embedding);
        let score = ((semanticScore * 0.8) + (lexicalScore * 0.2)) * record.confidence;
        if (record.type === 'failure') score *= 1.15;
        if (record.type === 'procedural') score *= 1.1;
        return { ...cloneClosureRecord(record), ...this.getClosureRecordPaths(record), score, semanticScore, lexicalScore };
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

  private computeGeneralLexicalScore(record: StoredGeneralMemory, queryTerms: string[]): number {
    if (queryTerms.length === 0) {
      return 0;
    }

    const contentLower = record.content.toLowerCase();
    const tagsLower = record.tags.map(tag => tag.toLowerCase());
    const categoryLower = record.category.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (tagsLower.some(tag => tag.includes(term))) score += 3;
      if (contentLower.includes(term)) score += 2;
      if (categoryLower.includes(term)) score += 1;
    }

    return score / Math.max(1, queryTerms.length * 3);
  }

  private computeClosureLexicalScore(record: StoredClosureMemory, queryTerms: string[], queryText: string): number {
    if (queryTerms.length === 0) {
      return 0;
    }

    const contentLower = record.content.toLowerCase();
    const tagsLower = record.tags.map(tag => tag.toLowerCase());
    let score = 0;

    for (const term of queryTerms) {
      if (contentLower.includes(term)) score += 1;
      if (tagsLower.some(tag => tag.includes(term))) score += 2;
    }

    if (record.triggerPattern) {
      try {
        if (new RegExp(record.triggerPattern, 'i').test(queryText)) score += 4;
      } catch {
        // Ignore invalid regex patterns.
      }
    }

    return score / Math.max(1, queryTerms.length * 2);
  }

  private embeddingKey(scope: 'general' | 'closure', memoryId: string): string {
    return `${scope}:${memoryId}`;
  }

  private buildEmbeddingRecord(scope: 'general' | 'closure', memoryId: string, sourceText: string): StoredEmbeddingRecord {
    return {
      scope,
      memoryId,
      model: MEMORY_EMBEDDING_MODEL,
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      embedding: computeSemanticEmbedding(sourceText, MEMORY_EMBEDDING_DIMENSIONS),
      sourceText,
      textHash: buildHash(sourceText),
      updatedAt: new Date().toISOString(),
    };
  }

  private upsertEmbedding(scope: 'general' | 'closure', memoryId: string, sourceText: string): void {
    const key = this.embeddingKey(scope, memoryId);
    const textHash = buildHash(sourceText);
    const existing = this.embeddings.get(key);
    if (existing && existing.textHash === textHash) {
      return;
    }
    this.embeddings.set(key, this.buildEmbeddingRecord(scope, memoryId, sourceText));
    this.persistEmbeddings();
  }

  private getGeneralRecordPaths(record: StoredGeneralMemory): MemoryArtifactPaths {
    const directoryPath = join(this.generalRootDir, sanitizePathSegment(record.category));
    const basePath = join(directoryPath, sanitizePathSegment(record.id));
    return {
      directoryPath,
      markdownPath: `${basePath}.md`,
      metadataPath: `${basePath}.json`,
    };
  }

  private getClosureRecordPaths(record: StoredClosureMemory): MemoryArtifactPaths {
    const directoryPath = join(this.closureRootDir, sanitizePathSegment(record.type));
    const basePath = join(directoryPath, sanitizePathSegment(record.id));
    return {
      directoryPath,
      markdownPath: `${basePath}.md`,
      metadataPath: `${basePath}.json`,
    };
  }
}

export function getSQLiteMemoryStore(dbPath?: string): SQLiteMemoryStore {
  const configuredPath = dbPath || resolveConfiguredStorePath();
  const resolvedPath = resolveStoreBasePath(configuredPath);
  const existing = storeCache.get(resolvedPath);
  if (existing) {
    return existing;
  }

  const store = new SQLiteMemoryStore(configuredPath);
  storeCache.set(resolvedPath, store);
  return store;
}

export function resetSQLiteMemoryStoreCache(): void {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}