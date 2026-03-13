/**
 * Memory Store — Persistent cross-session learning for the Closure Engine.
 *
 * Stores typed memories in the shared SQLite memory database.
 */

import type { MemoryRecord, MemoryType } from './types.js';
import { getSQLiteMemoryStore } from '../../sqlite-memory-store.js';

const MAX_MEMORIES = 500;

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryStore {
  private readonly store;

  constructor(options: { dbPath?: string } = {}) {
    this.store = getSQLiteMemoryStore(options.dbPath);
  }

  /**
   * Add a memory record.
   */
  add(record: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const memory = this.store.upsertClosureMemory({
      ...record,
      id: generateId('mem'),
      accessCount: 0,
      source: 'closure-engine',
    });

    const allMemories = this.store.listClosureMemories();
    if (allMemories.length > MAX_MEMORIES) {
      const removals = allMemories
        .sort((left, right) => right.confidence - left.confidence)
        .slice(MAX_MEMORIES);
      for (const candidate of removals) {
        this.store.deleteClosureMemory(candidate.id);
      }
    }

    return memory;
  }

  /**
   * Query memories by keyword matching.
   */
  query(text: string, limit: number = 10): MemoryRecord[] {
    return this.store.queryClosureMemories(text, limit);
  }

  /**
   * Get memories by type.
   */
  getByType(type: MemoryType): MemoryRecord[] {
    return this.store.listClosureMemories().filter(memory => memory.type === type);
  }

  /**
   * Get all memories.
   */
  getAll(): MemoryRecord[] {
    return this.store.listClosureMemories();
  }

  getByTag(tag: string): MemoryRecord[] {
    const normalized = tag.toLowerCase();
    return this.store.listClosureMemories().filter(memory => memory.tags.some(entry => entry.toLowerCase() === normalized));
  }

  getSkillMemories(skillName: string): MemoryRecord[] {
    const normalized = skillName.toLowerCase();
    return this.store.listClosureMemories().filter(memory =>
      memory.tags.some(tag => tag.toLowerCase() === 'skill-update') &&
      memory.tags.some(tag => tag.toLowerCase() === normalized),
    );
  }

  /**
   * Remove a memory by ID.
   */
  remove(id: string): boolean {
    return this.store.deleteClosureMemory(id);
  }

  /**
   * Apply confidence decay — reduce confidence of old, unused memories.
   */
  decayConfidence(factor: number = 0.98): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const m of this.store.listClosureMemories()) {
      const lastUsed = m.lastAccessed ? new Date(m.lastAccessed).getTime() : new Date(m.createdAt).getTime();
      if (lastUsed < cutoff) {
        const nextConfidence = Math.max(0.1, m.confidence * factor);
        this.store.updateClosureMemory(m.id, { confidence: nextConfidence });
      }
    }

    for (const m of this.store.listClosureMemories()) {
      if (m.confidence < 0.1) {
        this.store.deleteClosureMemory(m.id);
      }
    }
  }
}
