import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { GENERAL_MEMORY_CATEGORIES, getSQLiteMemoryStore } from '../../sqlite-memory-store.js';

const MEMORY_DB_PATH = process.env.WOODBURY_MEMORY_DB_PATH || '~/.woodbury/data/memory/memory.db';

export const definition: ToolDefinition = {
  name: 'memory_recall',
  description: `Recall information from long-term memory. Searches across saved memories by keywords, category, and optionally site domain.

Searches the SQLite memory database at ${MEMORY_DB_PATH}. Results are ranked by relevance (tag matches score highest, then content matches). Use before starting complex tasks to leverage past discoveries.`,
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
        enum: [...GENERAL_MEMORY_CATEGORIES]
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

  const store = getSQLiteMemoryStore();
  const results = store.recallGeneralMemories(query, {
    category,
    site,
    project: context?.workingDirectory || undefined,
    limit,
  });

  return JSON.stringify({
    success: true,
    memories: results.map(entry => ({
      id: entry.id,
      content: entry.content,
      category: entry.category,
      tags: entry.tags,
      timestamp: entry.createdAt,
      site: entry.site,
      project: entry.project,
      source: entry.source,
    })),
    totalSearched: store.countGeneralMemories(category),
    returned: results.length
  });
};
