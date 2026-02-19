import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'queue_add_items',
  description: 'Add items to a task queue.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Array of items to add to the queue'
      }
    },
    required: ['items']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Items added to queue' });
};
