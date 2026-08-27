import { promises as fs } from 'fs';
import { resolve, dirname, join, parse as parsePath, relative } from 'path';
import * as crypto from 'crypto';

const DEFAULT_CONTEXT_FILENAMES = [
  'AGENT.md',
  '.agent-context.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.agentic-loop/instructions.md',
];

/** Maximum characters per individual instruction file */
export const MAX_FILE_CHARS = 4000;
/** Maximum total characters across all instruction files */
export const MAX_TOTAL_CHARS = 12000;

export interface ProjectContextResult {
  /** Combined content from all discovered files (outermost-first, closest-to-cwd last) */
  content: string;
  /** Absolute paths of discovered files */
  files: string[];
  /** Total characters of content included */
  totalChars: number;
  /** Number of files that were truncated */
  truncatedCount: number;
}

export interface ProjectContextOptions {
  /** File names to search for (default: AGENT.md, CLAUDE.md, etc.) */
  filenames?: string[];
  /** Max chars per file (default: 4000) */
  maxFileChars?: number;
  /** Max total chars across all files (default: 12000) */
  maxTotalChars?: number;
}

/**
 * Discover project context files by walking up from workingDirectory to the filesystem root.
 * Files closer to workingDirectory appear last so their instructions take precedence.
 *
 * Features:
 * - Content deduplication by hash (prevents same file content from different directories)
 * - Per-file and total character budgets
 * - Truncation with notification when limits are hit
 */
export async function discoverProjectContext(
  workingDirectory: string,
  optionsOrFilenames?: ProjectContextOptions | string[]
): Promise<ProjectContextResult> {
  // Support legacy signature: discoverProjectContext(cwd, filenames?)
  const options: ProjectContextOptions = Array.isArray(optionsOrFilenames)
    ? { filenames: optionsOrFilenames }
    : (optionsOrFilenames || {});

  const searchNames = options.filenames ?? DEFAULT_CONTEXT_FILENAMES;
  const maxFileChars = options.maxFileChars ?? MAX_FILE_CHARS;
  const maxTotalChars = options.maxTotalChars ?? MAX_TOTAL_CHARS;

  const found: { path: string; content: string }[] = [];
  const visited = new Set<string>();
  const contentHashes = new Set<string>();

  let dir = resolve(workingDirectory);

  while (true) {
    const normalized = dir.toLowerCase();
    if (visited.has(normalized)) break;
    visited.add(normalized);

    for (const name of searchNames) {
      const candidate = join(dir, name);
      try {
        await fs.access(candidate);
        const content = await fs.readFile(candidate, 'utf-8');
        if (content.trim()) {
          // Deduplicate by content hash
          const hash = crypto.createHash('sha256').update(content.trim()).digest('hex').substring(0, 16);
          if (!contentHashes.has(hash)) {
            contentHashes.add(hash);
            found.push({ path: candidate, content: content.trim() });
          }
        }
      } catch {
        // File doesn't exist at this level, continue
      }
    }

    const parent = dirname(dir);
    // At filesystem root, dirname returns the same path
    if (parent === dir) break;
    dir = parent;
  }

  if (found.length === 0) {
    return { content: '', files: [], totalChars: 0, truncatedCount: 0 };
  }

  // Reverse so outermost (root-level) files come first, closest-to-cwd last (takes precedence)
  found.reverse();

  // Apply char budgets
  let remainingChars = maxTotalChars;
  let truncatedCount = 0;
  const sections: string[] = [];

  for (const f of found) {
    if (remainingChars <= 0) {
      truncatedCount++;
      continue;
    }

    let content = f.content;

    // Per-file limit
    if (content.length > maxFileChars) {
      content = content.substring(0, maxFileChars) + '\n\n<!-- [Truncated: file exceeded ' + maxFileChars + ' char limit] -->';
      truncatedCount++;
    }

    // Total budget limit
    if (content.length > remainingChars) {
      content = content.substring(0, remainingChars) + '\n\n<!-- [Truncated: total instruction budget exceeded] -->';
      truncatedCount++;
    }

    remainingChars -= content.length;

    const scope = relative(workingDirectory, dirname(f.path)) || '.';
    sections.push(`<!-- Project context from: ${f.path} (scope: ${scope}) -->\n${content}`);
  }

  const combinedContent = sections.join('\n\n');

  return {
    content: combinedContent,
    files: found.map(f => f.path),
    totalChars: combinedContent.length,
    truncatedCount,
  };
}
