import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'goal_contract',
  description: 'Create or update a goal contract that defines what success looks like for the current session.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'Clear statement of what needs to be accomplished'
      },
      successCriteria: {
        type: 'array',
        description: 'List of concrete, verifiable conditions'
      },
      constraints: {
        type: 'array',
        description: 'Boundaries or limitations'
      },
      assumptions: {
        type: 'array',
        description: 'Things assumed to be true'
      }
    },
    required: ['objective', 'successCriteria']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Goal contract created' });
};
