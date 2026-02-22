import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const MEMORY_DIR = join(homedir(), '.woodbury', 'memory');

const VALID_CATEGORIES = [
  'convention', 'discovery', 'decision', 'gotcha',
  'file_location', 'endpoint', 'web_procedure', 'web_task_notes'
] as const;

export const definition: ToolDefinition = {
  name: 'memory_save',
  description: `Save information to long-term memory for later retrieval. Persists to ~/.woodbury/memory/ as JSON files organized by category.

Categories:
- convention — Project conventions and patterns
- discovery — Surprising findings
- decision — Architectural decisions
- gotcha — Common pitfalls
- file_location — Important file locations
- endpoint — API endpoints
- web_procedure — Step-by-step web navigation procedures (include site domain)
- web_task_notes — Lessons learned from web tasks (what worked/didn't, timing, selectors)`,
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The knowledge to save. Be specific and self-contained — future sessions only see what you save.'
      },
      category: {
        type: 'string',
        description: 'Category for the memory.',
        enum: [...VALID_CATEGORIES]
      },
      tags: {
        type: 'array',
        description: 'Keywords for retrieval (e.g. ["stripe", "auth", "webhook"])',
        items: { type: 'string' }
      },
      site: {
        type: 'string',
        description: 'For web_procedure/web_task_notes: the domain (e.g. "github.com"). Optional for other categories.'
      }
    },
    required: ['content', 'category']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  const { content, category, tags = [], site } = params;

  // Validate category
  if (!VALID_CATEGORIES.includes(category)) {
    return JSON.stringify({
      success: false,
      error: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(', ')}`
    });
  }

  // Ensure directory exists
  await mkdir(MEMORY_DIR, { recursive: true });

  const filePath = join(MEMORY_DIR, `${category}.json`);

  // Load existing entries
  let entries: any[] = [];
  try {
    const existing = await readFile(filePath, 'utf-8');
    entries = JSON.parse(existing);
    if (!Array.isArray(entries)) entries = [];
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Create new entry
  const entry: Record<string, any> = {
    id: randomUUID(),
    content,
    category,
    tags,
    timestamp: new Date().toISOString(),
  };

  if (site) entry.site = site;
  if (context?.workingDirectory) entry.project = context.workingDirectory;

  entries.push(entry);

  // Write back
  await writeFile(filePath, JSON.stringify(entries, null, 2));

  return JSON.stringify({
    success: true,
    message: `Memory saved to ${category} (${entries.length} entries total)`,
    id: entry.id
  });
};
