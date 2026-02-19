import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'queue_next',
  description: 'Get the next item from the queue.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, item: null });
};
