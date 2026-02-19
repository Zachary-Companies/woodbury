import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'queue_status',
  description: 'Check the status of the queue.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, queue: [] });
};
