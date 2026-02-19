import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'task_get',
  description: 'Get full details of a specific task including description, dependencies, and validators.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'number',
        description: 'The task ID to retrieve'
      }
    },
    required: ['taskId']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, task: null });
};
