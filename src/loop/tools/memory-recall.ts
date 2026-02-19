import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'memory_recall',
  description: 'Recall information from long-term memory.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for'
      },
      category: {
        type: 'string',
        description: 'Optional category filter'
      }
    },
    required: ['query']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, memories: [] });
};
