import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'queue_init',
  description: 'Initialize a new task queue.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      sharedContext: {
        type: 'string',
        description: 'Template/pattern that applies to every item'
      },
      items: {
        type: 'array',
        description: 'Array of items to process'
      }
    },
    required: ['sharedContext', 'items']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Queue initialized' });
};
