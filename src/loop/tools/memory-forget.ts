import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { MemoryStore } from '../memory-store.js';

export const definition: ToolDefinition = {
  name: 'memory_forget',
  description: 'Delete a specific memory by ID, or search and delete memories matching criteria. Use this to remove outdated, incorrect, or no longer relevant memories.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The specific memory ID to delete'
      },
      query: {
        type: 'string',
        description: 'Search query to find memories to delete (use with confirm: true)'
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true when using query-based deletion to prevent accidents'
      }
    },
    required: []
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  const store = new MemoryStore(
    { workingDirectory: context?.workingDirectory || process.cwd() },
    context?.logger
  );

  // Delete by specific ID
  if (params.id) {
    const deleted = store.forget(params.id);
    return JSON.stringify({
      success: deleted,
      message: deleted
        ? `Memory ${params.id} deleted.`
        : `Memory ${params.id} not found.`,
    });
  }

  // Search-and-delete mode
  if (params.query) {
    if (!params.confirm) {
      // Preview mode — show what would be deleted
      const results = store.search({ query: params.query, maxResults: 20 });
      return JSON.stringify({
        success: true,
        mode: 'preview',
        message: `Found ${results.length} matching memories. Set confirm: true to delete them.`,
        memories: results.map(r => ({
          id: r.memory.id,
          content: r.memory.content.substring(0, 100),
          relevance: Math.round(r.relevanceScore * 100) / 100,
        })),
      });
    }

    // Confirmed deletion
    const results = store.search({ query: params.query, maxResults: 20 });
    let deleted = 0;
    for (const result of results) {
      if (store.forget(result.memory.id)) deleted++;
    }

    return JSON.stringify({
      success: true,
      deletedCount: deleted,
      message: `Deleted ${deleted} memories matching "${params.query}".`,
    });
  }

  return JSON.stringify({
    success: false,
    message: 'Provide either an id or a query to delete memories.',
  });
};
