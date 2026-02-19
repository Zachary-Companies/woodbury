import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { existsSync } from 'node:fs';

const CONTEXT_FILENAME = '.woodbury.md';

/**
 * Walk up from the given directory looking for .woodbury.md
 * Returns its contents if found, or null.
 */
export async function loadProjectContext(startDir: string): Promise<string | null> {
  let dir = startDir;

  while (true) {
    const candidate = join(dir, CONTEXT_FILENAME);
    if (existsSync(candidate)) {
      try {
        return await readFile(candidate, 'utf-8');
      } catch {
        return null;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  return null;
}

const CONTEXT_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Load all .md and .txt files from a directory and concatenate their contents.
 * Returns null if the directory doesn't exist or contains no matching files.
 */
export async function loadContextDirectory(dirPath: string): Promise<string | null> {
  if (!existsSync(dirPath)) return null;

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return null;
  }

  const contextFiles = entries
    .filter((f) => CONTEXT_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort();

  if (contextFiles.length === 0) return null;

  const sections: string[] = [];
  for (const file of contextFiles) {
    try {
      const content = await readFile(join(dirPath, file), 'utf-8');
      sections.push(`### ${file}\n${content.trim()}`);
    } catch {
      // skip unreadable files
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}
