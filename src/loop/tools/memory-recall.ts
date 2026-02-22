import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_DIR = join(homedir(), '.woodbury', 'memory');

const VALID_CATEGORIES = [
  'convention', 'discovery', 'decision', 'gotcha',
  'file_location', 'endpoint', 'web_procedure', 'web_task_notes'
] as const;

export const definition: ToolDefinition = {
  name: 'memory_recall',
  description: `Recall information from long-term memory. Searches across saved memories by keywords, category, and optionally site domain.

Searches ~/.woodbury/memory/ JSON files. Results are ranked by relevance (tag matches score highest, then content matches). Use before starting complex tasks to leverage past discoveries.`,
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for in content and tags'
      },
      category: {
        type: 'string',
        description: 'Optional category filter. If omitted, searches all categories.',
        enum: [...VALID_CATEGORIES]
      },
      site: {
        type: 'string',
        description: 'Optional site/domain filter for web memories (e.g. "github.com")'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 10)'
      }
    },
    required: ['query']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  const { query, category, site, limit = 10 } = params;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (queryTerms.length === 0) {
    return JSON.stringify({ success: true, memories: [], message: 'Empty query' });
  }

  let allEntries: any[] = [];

  try {
    if (category) {
      // Search single category file
      const filePath = join(MEMORY_DIR, `${category}.json`);
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) allEntries = parsed;
      } catch {
        // File doesn't exist or invalid
      }
    } else {
      // Search all category files
      let files: string[] = [];
      try {
        files = await readdir(MEMORY_DIR);
      } catch {
        // Directory doesn't exist
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(MEMORY_DIR, file), 'utf-8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) allEntries.push(...parsed);
        } catch {
          // Skip invalid files
        }
      }
    }
  } catch {
    return JSON.stringify({ success: true, memories: [], message: 'No memories found' });
  }

  // Filter by site if specified
  if (site) {
    const siteLower = site.toLowerCase();
    allEntries = allEntries.filter(
      (e: any) => e.site && e.site.toLowerCase().includes(siteLower)
    );
  }

  // Score and rank results
  const scored = allEntries.map((entry: any) => {
    let score = 0;
    const contentLower = (entry.content || '').toLowerCase();
    const tagsLower = (entry.tags || []).map((t: string) => t.toLowerCase());
    const catLower = (entry.category || '').toLowerCase();

    for (const term of queryTerms) {
      if (tagsLower.some((t: string) => t.includes(term))) score += 3;
      if (contentLower.includes(term)) score += 2;
      if (catLower.includes(term)) score += 1;
    }

    return { ...entry, _score: score };
  });

  // Filter to matches, sort by score desc then timestamp desc
  const results = scored
    .filter((e: any) => e._score > 0)
    .sort((a: any, b: any) =>
      b._score - a._score ||
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, limit)
    .map(({ _score, ...entry }: any) => entry);

  return JSON.stringify({
    success: true,
    memories: results,
    totalSearched: allEntries.length,
    returned: results.length
  });
};
