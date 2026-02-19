import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type MemoryCategory = 'convention' | 'discovery' | 'decision' | 'gotcha' | 'file_location' | 'endpoint';

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  timestamp: number;
}

export class Memory {
  private memoryFile: string;

  constructor(private workingDirectory: string) {
    this.memoryFile = path.join(workingDirectory, '.woodbury-work', 'memory.json');
  }

  async save(content: string, category: MemoryCategory, tags: string[] = []): Promise<void> {
    const entries = await this.loadMemories();
    
    const entry: MemoryEntry = {
      id: randomUUID(),
      content,
      category,
      tags,
      timestamp: Date.now()
    };

    entries.push(entry);
    await this.saveMemories(entries);
  }

  async recall(query: string, category?: MemoryCategory): Promise<MemoryEntry[]> {
    const entries = await this.loadMemories();
    const queryLower = query.toLowerCase();

    return entries.filter(entry => {
      // Filter by category if specified
      if (category && entry.category !== category) {
        return false;
      }

      // Search in content and tags
      const contentMatch = entry.content.toLowerCase().includes(queryLower);
      const tagMatch = entry.tags.some(tag => tag.toLowerCase().includes(queryLower));
      
      return contentMatch || tagMatch;
    }).sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  }

  private async loadMemories(): Promise<MemoryEntry[]> {
    try {
      const content = await fs.readFile(this.memoryFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      // Return empty array on parse errors
      return [];
    }
  }

  private async saveMemories(entries: MemoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryFile), { recursive: true });
    await fs.writeFile(this.memoryFile, JSON.stringify(entries, null, 2));
  }
}
