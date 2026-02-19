/**
 * Project Context - Track changes across multiple files
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * File state tracking
 */
export interface FileState {
  path: string;
  originalContent?: string;
  currentContent: string;
  isModified: boolean;
  readAt?: number;
  writtenAt?: number;
}

/**
 * Import relationship
 */
export interface ImportRelation {
  from: string;
  to: string;
  type: 'import' | 'require' | 'from';
}

/**
 * Change summary for agent context
 */
export interface ChangeSummary {
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];
  imports: ImportRelation[];
}

/**
 * Project context for multi-file tracking
 */
export class ProjectContext {
  private files: Map<string, FileState> = new Map();
  private imports: ImportRelation[] = [];
  private baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  /**
   * Track a file read
   */
  trackFileRead(filePath: string, content: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const existing = this.files.get(normalizedPath);

    if (!existing) {
      this.files.set(normalizedPath, {
        path: normalizedPath,
        originalContent: content,
        currentContent: content,
        isModified: false,
        readAt: Date.now(),
      });
    }

    // Parse imports from the file
    this.parseImports(normalizedPath, content);
  }

  /**
   * Track a file write
   */
  trackFileWrite(filePath: string, content: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const existing = this.files.get(normalizedPath);

    if (existing) {
      existing.currentContent = content;
      existing.isModified = existing.originalContent !== content;
      existing.writtenAt = Date.now();
    } else {
      // New file created
      this.files.set(normalizedPath, {
        path: normalizedPath,
        originalContent: undefined, // File didn't exist before
        currentContent: content,
        isModified: true,
        writtenAt: Date.now(),
      });
    }

    // Re-parse imports
    this.parseImports(normalizedPath, content);
  }

  /**
   * Get file state
   */
  getFileState(filePath: string): FileState | undefined {
    return this.files.get(this.normalizePath(filePath));
  }

  /**
   * Get all file states
   */
  getAllFileStates(): FileState[] {
    return Array.from(this.files.values());
  }

  /**
   * Get modified files
   */
  getModifiedFiles(): FileState[] {
    return this.getAllFileStates().filter(f => f.isModified);
  }

  /**
   * Get created files (no original content)
   */
  getCreatedFiles(): FileState[] {
    return this.getAllFileStates().filter(f => f.originalContent === undefined);
  }

  /**
   * Get files that import the given file
   */
  getDependents(filePath: string): string[] {
    const normalizedPath = this.normalizePath(filePath);
    return this.imports
      .filter(imp => imp.to === normalizedPath)
      .map(imp => imp.from);
  }

  /**
   * Get files that the given file imports
   */
  getDependencies(filePath: string): string[] {
    const normalizedPath = this.normalizePath(filePath);
    return this.imports
      .filter(imp => imp.from === normalizedPath)
      .map(imp => imp.to);
  }

  /**
   * Get related files (imports and dependents)
   */
  getRelatedFiles(filePath: string): string[] {
    const deps = this.getDependencies(filePath);
    const dependents = this.getDependents(filePath);
    return [...new Set([...deps, ...dependents])];
  }

  /**
   * Get change summary
   */
  getChangeSummary(): ChangeSummary {
    const filesRead = this.getAllFileStates()
      .filter(f => f.readAt)
      .map(f => f.path);

    const filesModified = this.getModifiedFiles()
      .filter(f => f.originalContent !== undefined)
      .map(f => f.path);

    const filesCreated = this.getCreatedFiles().map(f => f.path);

    return {
      filesRead,
      filesModified,
      filesCreated,
      imports: this.imports,
    };
  }

  /**
   * Format context for agent
   */
  formatForAgent(): string {
    const summary = this.getChangeSummary();
    const lines: string[] = [];

    lines.push('## Project Context\n');

    if (summary.filesModified.length > 0) {
      lines.push('### Modified Files:');
      for (const file of summary.filesModified) {
        const state = this.getFileState(file);
        if (state) {
          const diffSize = state.currentContent.length - (state.originalContent?.length || 0);
          const diffStr = diffSize >= 0 ? `+${diffSize}` : `${diffSize}`;
          lines.push(`- ${file} (${diffStr} chars)`);
        }
      }
      lines.push('');
    }

    if (summary.filesCreated.length > 0) {
      lines.push('### Created Files:');
      for (const file of summary.filesCreated) {
        const state = this.getFileState(file);
        lines.push(`- ${file} (${state?.currentContent.length || 0} chars)`);
      }
      lines.push('');
    }

    if (summary.filesRead.length > 0) {
      lines.push('### Files Read:');
      lines.push(`- ${summary.filesRead.length} files`);
      lines.push('');
    }

    // Show import graph for modified files
    const modifiedWithDeps = summary.filesModified.filter(f =>
      this.getDependents(f).length > 0
    );

    if (modifiedWithDeps.length > 0) {
      lines.push('### Affected Dependencies:');
      for (const file of modifiedWithDeps) {
        const dependents = this.getDependents(file);
        if (dependents.length > 0) {
          lines.push(`- ${file} is imported by:`);
          for (const dep of dependents.slice(0, 5)) {
            lines.push(`  - ${dep}`);
          }
          if (dependents.length > 5) {
            lines.push(`  - ... and ${dependents.length - 5} more`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a diff summary for a file
   */
  getDiff(filePath: string): string | null {
    const state = this.getFileState(filePath);
    if (!state || !state.isModified) return null;

    const original = state.originalContent || '';
    const current = state.currentContent;

    // Simple line-by-line diff
    const originalLines = original.split('\n');
    const currentLines = current.split('\n');

    const diff: string[] = [];
    diff.push(`--- ${filePath} (original)`);
    diff.push(`+++ ${filePath} (modified)`);

    // Very simple diff - just show added/removed
    const added = currentLines.filter(l => !originalLines.includes(l));
    const removed = originalLines.filter(l => !currentLines.includes(l));

    if (removed.length > 0) {
      diff.push('\nRemoved:');
      for (const line of removed.slice(0, 10)) {
        diff.push(`- ${line}`);
      }
      if (removed.length > 10) {
        diff.push(`... and ${removed.length - 10} more lines`);
      }
    }

    if (added.length > 0) {
      diff.push('\nAdded:');
      for (const line of added.slice(0, 10)) {
        diff.push(`+ ${line}`);
      }
      if (added.length > 10) {
        diff.push(`... and ${added.length - 10} more lines`);
      }
    }

    return diff.join('\n');
  }

  /**
   * Reset tracking
   */
  reset(): void {
    this.files.clear();
    this.imports.length = 0;
  }

  /**
   * Normalize file path
   */
  private normalizePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath.replace(/\\/g, '/');
    }
    return path.resolve(this.baseDir, filePath).replace(/\\/g, '/');
  }

  /**
   * Parse imports from file content
   */
  private parseImports(filePath: string, content: string): void {
    // Remove existing imports from this file
    this.imports = this.imports.filter(imp => imp.from !== filePath);

    const ext = path.extname(filePath);

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      this.parseJsImports(filePath, content);
    } else if (ext === '.py') {
      this.parsePythonImports(filePath, content);
    }
  }

  /**
   * Parse JavaScript/TypeScript imports
   */
  private parseJsImports(filePath: string, content: string): void {
    const patterns = [
      // import ... from '...'
      /import\s+(?:[\w\s{},*]+)\s+from\s+['"]([^'"]+)['"]/g,
      // import('...')
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      // require('...')
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1];

        // Skip node_modules imports
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
          continue;
        }

        const resolvedPath = this.resolveImportPath(filePath, importPath);
        if (resolvedPath) {
          this.imports.push({
            from: filePath,
            to: resolvedPath,
            type: pattern.source.includes('require') ? 'require' : 'import',
          });
        }
      }
    }
  }

  /**
   * Parse Python imports
   */
  private parsePythonImports(filePath: string, content: string): void {
    const patterns = [
      // from ... import ...
      /from\s+(\S+)\s+import/g,
      // import ...
      /^import\s+(\S+)/gm,
    ];

    const dir = path.dirname(filePath);

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const modulePath = match[1].replace(/\./g, '/');

        // Try relative path
        const relativePath = path.join(dir, modulePath + '.py');
        if (this.files.has(this.normalizePath(relativePath))) {
          this.imports.push({
            from: filePath,
            to: this.normalizePath(relativePath),
            type: 'from',
          });
        }
      }
    }
  }

  /**
   * Resolve import path to absolute path
   */
  private resolveImportPath(fromPath: string, importPath: string): string | null {
    const dir = path.dirname(fromPath);
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

    for (const ext of extensions) {
      const fullPath = this.normalizePath(path.join(dir, importPath + ext));

      // Check if we've seen this file
      if (this.files.has(fullPath)) {
        return fullPath;
      }

      // Check if file exists on disk
      try {
        if (fs.existsSync(fullPath.replace(/\//g, path.sep))) {
          return fullPath;
        }
      } catch {
        // Ignore errors
      }
    }

    return null;
  }
}

/**
 * Create a project context
 */
export function createProjectContext(baseDir?: string): ProjectContext {
  return new ProjectContext(baseDir);
}
