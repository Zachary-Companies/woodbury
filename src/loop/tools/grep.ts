import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { globToRegex } from './utils/glob-match.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const BINARY_CHECK_SIZE = 8192; // 8 KB

export const grepDefinition: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents for a regex pattern. Recursively searches directories, skipping binary files, files over 1 MB, and node_modules/.git/dist directories.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for in file contents'
      },
      path: {
        type: 'string',
        description: 'File or directory to search (relative to working directory or absolute). Default: "."',
        default: '.'
      },
      include: {
        type: 'string',
        description: 'Glob pattern to filter which files to search (e.g. "*.ts", "*.{js,jsx}")'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matching lines to return (default: 50)',
        default: 50
      },
      contextLines: {
        type: 'number',
        description: 'Number of context lines to show before and after each match (default: 0)',
        default: 0
      }
    },
    required: ['pattern']
  }
};

function isBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function searchFile(
  filePath: string,
  baseDir: string,
  regex: RegExp,
  contextLines: number,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return;
  }
  if (stat.size > MAX_FILE_SIZE) return;

  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return;
  }
  if (isBinary(buffer)) return;

  const content = buffer.toString('utf-8');
  const lines = content.split('\n');
  const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');

  // Track which lines have been output to avoid duplicates from overlapping context
  const outputLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxResults) return;

    // Reset lastIndex for global regex
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);

      for (let j = start; j <= end; j++) {
        if (results.length >= maxResults) break;
        if (!outputLines.has(j)) {
          outputLines.add(j);
          const prefix = j === i ? ':' : '-';
          results.push(`${relativePath}:${j + 1}${prefix} ${lines[j]}`);
        }
      }
    }
  }
}

async function walkAndSearch(
  dir: string,
  baseDir: string,
  regex: RegExp,
  includeRegex: RegExp | null,
  contextLines: number,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkAndSearch(entryPath, baseDir, regex, includeRegex, contextLines, results, maxResults);
    } else {
      if (includeRegex) {
        if (!includeRegex.test(entry.name)) continue;
      }
      await searchFile(entryPath, baseDir, regex, contextLines, results, maxResults);
    }
  }
}

export const grepHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const pattern = params.pattern as string;
  const searchPath = (params.path as string) || '.';
  const include = params.include as string | undefined;
  const maxResults = (params.maxResults as number) || 50;
  const contextLines = (params.contextLines as number) || 0;

  if (!pattern) {
    throw new Error('pattern parameter is required');
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${pattern}`);
  }

  const includeRegex = include ? globToRegex(include) : null;

  const resolvedPath = path.isAbsolute(searchPath)
    ? searchPath
    : path.resolve(context?.workingDirectory || process.cwd(), searchPath);

  const results: string[] = [];

  // Check if path is a file or directory
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }

  if (stat.isFile()) {
    await searchFile(resolvedPath, path.dirname(resolvedPath), regex, contextLines, results, maxResults);
  } else {
    await walkAndSearch(resolvedPath, resolvedPath, regex, includeRegex, contextLines, results, maxResults);
  }

  if (results.length === 0) {
    return `No matches found for pattern: ${pattern}`;
  }

  let output = results.join('\n');
  if (results.length >= maxResults) {
    output += `\n\n(Results limited to ${maxResults} matches)`;
  }
  return output;
};
