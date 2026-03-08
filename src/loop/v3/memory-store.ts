/**
 * Memory Store — Persistent cross-session learning for the Closure Engine.
 *
 * Stores typed memories (episodic, procedural, failure, semantic) at
 * ~/.woodbury/data/closure-engine/memories.json
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MemoryRecord, MemoryType } from './types.js';

const DATA_DIR = join(homedir(), '.woodbury', 'data', 'closure-engine');
const MEMORIES_FILE = join(DATA_DIR, 'memories.json');
const MAX_MEMORIES = 500;

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryStore {
  private memories: MemoryRecord[] = [];

  constructor() {
    this.load();
  }

  /**
   * Add a memory record.
   */
  add(record: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const now = new Date().toISOString();
    const memory: MemoryRecord = {
      ...record,
      id: generateId('mem'),
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.memories.push(memory);

    // Trim old memories if over limit — remove lowest confidence first
    if (this.memories.length > MAX_MEMORIES) {
      this.memories.sort((a, b) => b.confidence - a.confidence);
      this.memories = this.memories.slice(0, MAX_MEMORIES);
    }

    this.save();
    return memory;
  }

  /**
   * Query memories by keyword matching.
   */
  query(text: string, limit: number = 10): MemoryRecord[] {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return [];

    const scored = this.memories.map(m => {
      const content = m.content.toLowerCase();
      const tags = m.tags.map(t => t.toLowerCase());
      let score = 0;

      for (const word of words) {
        if (content.includes(word)) score += 1;
        if (tags.some(t => t.includes(word))) score += 2;
        if (m.triggerPattern && new RegExp(m.triggerPattern, 'i').test(text)) score += 5;
      }

      // Boost by confidence
      score *= m.confidence;

      // Boost by type relevance
      if (m.type === 'failure') score *= 1.5; // failures are especially useful
      if (m.type === 'procedural') score *= 1.3;

      return { memory: m, score };
    });

    // Filter and sort by score
    const results = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.memory);

    // Update access counts
    for (const m of results) {
      m.accessCount++;
      m.lastAccessed = new Date().toISOString();
    }
    if (results.length > 0) this.save();

    return results;
  }

  /**
   * Get memories by type.
   */
  getByType(type: MemoryType): MemoryRecord[] {
    return this.memories.filter(m => m.type === type);
  }

  /**
   * Get all memories.
   */
  getAll(): MemoryRecord[] {
    return [...this.memories];
  }

  /**
   * Remove a memory by ID.
   */
  remove(id: string): boolean {
    const before = this.memories.length;
    this.memories = this.memories.filter(m => m.id !== id);
    if (this.memories.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Apply confidence decay — reduce confidence of old, unused memories.
   */
  decayConfidence(factor: number = 0.98): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const m of this.memories) {
      const lastUsed = m.lastAccessed ? new Date(m.lastAccessed).getTime() : new Date(m.createdAt).getTime();
      if (lastUsed < cutoff) {
        m.confidence = Math.max(0.1, m.confidence * factor);
      }
    }

    // Remove very low confidence memories
    this.memories = this.memories.filter(m => m.confidence >= 0.1);
    this.save();
  }

  // ── Persistence ─────────────────────────────────────────

  private load(): void {
    try {
      if (existsSync(MEMORIES_FILE)) {
        const raw = readFileSync(MEMORIES_FILE, 'utf-8');
        this.memories = JSON.parse(raw);
      }
    } catch {
      this.memories = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(MEMORIES_FILE, JSON.stringify(this.memories, null, 2));
    } catch {
      // Silently fail
    }
  }
}
