import { getSQLiteMemoryStore, type GeneralMemoryCategory } from './sqlite-memory-store.js';

export type MemoryCategory = GeneralMemoryCategory;

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  timestamp: number;
}

export class Memory {
  private readonly store = getSQLiteMemoryStore();

  constructor(private workingDirectory: string) {
  }

  async save(content: string, category: MemoryCategory, tags: string[] = []): Promise<void> {
    this.store.saveGeneralMemory({
      content,
      category,
      tags,
      project: this.workingDirectory,
      source: 'workspace-memory',
      importance: 0.6,
    });
  }

  async recall(query: string, category?: MemoryCategory): Promise<MemoryEntry[]> {
    return this.store.recallGeneralMemories(query, {
      category,
      project: this.workingDirectory,
    }).map(entry => ({
      id: entry.id,
      content: entry.content,
      category: entry.category,
      tags: entry.tags,
      timestamp: Date.parse(entry.createdAt),
    }));
  }
}
