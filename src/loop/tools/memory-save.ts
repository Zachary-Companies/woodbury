import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'memory_save',
  description: 'Save information to long-term memory for later retrieval.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The knowledge to save'
      },
      category: {
        type: 'string',
        description: 'Category: convention, discovery, decision, gotcha, file_location, endpoint'
      },
      tags: {
        type: 'array',
        description: 'Keywords for retrieval'
      }
    },
    required: ['content', 'category']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Memory saved' });
};
