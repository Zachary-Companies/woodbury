import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { GENERAL_MEMORY_CATEGORIES, getSQLiteMemoryStore } from '../../sqlite-memory-store.js';

const MEMORY_DB_PATH = process.env.WOODBURY_MEMORY_DB_PATH || '~/.woodbury/data/memory/memory.db';

export const definition: ToolDefinition = {
  name: 'memory_save',
  description: `Save information to long-term memory for later retrieval. Persists to a SQLite database at ${MEMORY_DB_PATH}.

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
        enum: [...GENERAL_MEMORY_CATEGORIES]
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
  if (!GENERAL_MEMORY_CATEGORIES.includes(category)) {
    return JSON.stringify({
      success: false,
      error: `Invalid category "${category}". Valid: ${GENERAL_MEMORY_CATEGORIES.join(', ')}`
    });
  }

  const store = getSQLiteMemoryStore();
  const entry = store.saveGeneralMemory({
    content,
    category,
    tags,
    site,
    project: context?.workingDirectory || undefined,
    source: 'tool:memory_save',
    importance: category === 'web_procedure' || category === 'web_task_notes' ? 0.9 : 0.7,
  });

  return JSON.stringify({
    success: true,
    message: `Memory saved to ${category} (${store.countGeneralMemories(category)} entries total)`,
    id: entry.id
  });
};
