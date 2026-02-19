import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'queue_done',
  description: 'Mark the current queue item as done.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'completed or skipped'
      },
      notes: {
        type: 'string',
        description: 'Optional notes about what was done'
      }
    },
    required: ['status']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Item marked as done' });
};
