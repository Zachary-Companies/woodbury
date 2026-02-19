import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Default knowledge base directory: ~/.agentic-loop/knowledge-base/
 * or can be specified explicitly
 */
export function getDefaultKnowledgeBaseDir(): string {
  return path.join(os.homedir(), '.agentic-loop', 'knowledge-base');
}

/**
 * Knowledge base entry
 */
export interface KnowledgeEntry {
  name: string;
  path?: string;
  content: string;
}

/**
 * Knowledge base loader - loads markdown files from a directory or npm package
 */
export class KnowledgeBase {
  private entries: Map<string, KnowledgeEntry> = new Map();
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || getDefaultKnowledgeBaseDir();
  }

  /**
   * Load from an npm package like @zachary/knowledge-base
   *
   * Usage:
   * ```typescript
   * import * as kb from '@zachary/knowledge-base';
   * const knowledgeBase = new KnowledgeBase();
   * knowledgeBase.loadFromPackage(kb);
   * ```
   */
  loadFromPackage(pkg: {
    entries?: Record<string, { name: string; content: string }>;
    getAllEntries?: () => Array<{ name: string; content: string }>;
  }): void {
    // Support both direct entries object and getAllEntries() function
    if (pkg.getAllEntries) {
      const entries = pkg.getAllEntries();
      for (const entry of entries) {
        this.entries.set(entry.name, {
          name: entry.name,
          content: entry.content,
        });
      }
    } else if (pkg.entries) {
      for (const [name, entry] of Object.entries(pkg.entries)) {
        this.entries.set(name, {
          name: entry.name,
          content: entry.content,
        });
      }
    }
  }

  /**
   * Add an entry directly
   */
  addEntry(name: string, content: string): void {
    this.entries.set(name, { name, content });
  }

  /**
   * Load all markdown files from the knowledge base directory
   */
  load(): void {
    if (!fs.existsSync(this.baseDir)) {
      return;
    }

    const files = fs.readdirSync(this.baseDir);

    for (const file of files) {
      if (file.endsWith('.md') || file.endsWith('.txt')) {
        const filePath = path.join(this.baseDir, file);
        const stat = fs.statSync(filePath);

        if (stat.isFile()) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const name = path.basename(file, path.extname(file));

          this.entries.set(name, {
            name,
            path: filePath,
            content,
          });
        }
      }
    }
  }

  /**
   * Load a specific file into the knowledge base
   */
  loadFile(filePath: string, name?: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const entryName = name || path.basename(filePath, path.extname(filePath));

    this.entries.set(entryName, {
      name: entryName,
      path: filePath,
      content,
    });
  }

  /**
   * Load all files from a directory
   */
  loadDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);

      if (stat.isFile() && (file.endsWith('.md') || file.endsWith('.txt'))) {
        this.loadFile(filePath);
      }
    }
  }

  /**
   * Get a specific entry by name
   */
  get(name: string): KnowledgeEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Get all entries
   */
  getAll(): KnowledgeEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get entry names
   */
  getNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Check if an entry exists
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Get entries matching a search term (searches name and content)
   */
  search(term: string): KnowledgeEntry[] {
    const lowerTerm = term.toLowerCase();
    return this.getAll().filter(entry =>
      entry.name.toLowerCase().includes(lowerTerm) ||
      entry.content.toLowerCase().includes(lowerTerm)
    );
  }

  /**
   * Format all entries as context for LLM
   */
  formatAsContext(maxLength?: number): string {
    const entries = this.getAll();
    if (entries.length === 0) {
      return '';
    }

    const sections: string[] = [];
    let totalLength = 0;

    for (const entry of entries) {
      const section = `## ${entry.name}\n\n${entry.content}`;

      if (maxLength && totalLength + section.length > maxLength) {
        // Truncate if exceeding max length
        const remaining = maxLength - totalLength;
        if (remaining > 100) {
          sections.push(section.substring(0, remaining) + '\n...(truncated)');
        }
        break;
      }

      sections.push(section);
      totalLength += section.length;
    }

    return `# Knowledge Base Context\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Format specific entries as context
   */
  formatEntriesAsContext(names: string[]): string {
    const sections: string[] = [];

    for (const name of names) {
      const entry = this.get(name);
      if (entry) {
        sections.push(`## ${entry.name}\n\n${entry.content}`);
      }
    }

    if (sections.length === 0) {
      return '';
    }

    return `# Knowledge Base Context\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Get total size of all entries
   */
  getTotalSize(): number {
    return this.getAll().reduce((sum, entry) => sum + entry.content.length, 0);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries.clear();
  }
}
