import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'task_list',
  description: 'List all tasks with their status. Use after completing a task to check progress and find the next task to work on.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, tasks: [] });
};
