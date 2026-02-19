import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'delegate',
  description: 'Spawn a child agent with its own context window to perform a focused subtask. The child has NO conversation history — provide everything it needs via the context parameter. Types: "explore" (read-only, for understanding code), "plan" (read-only, for creating implementation plans), "execute" (full tools, for implementing changes).',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Subagent type: "explore", "plan", or "execute"'
      },
      task: {
        type: 'string',
        description: 'What the subagent should accomplish — one clear objective'
      },
      context: {
        type: 'string',
        description: 'Everything the subagent needs: file contents, plan excerpts, constraints, conventions, file paths. The subagent starts BLANK and cannot see conversation history.'
      }
    },
    required: ['type', 'task', 'context']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, result: 'Delegated task completed' });
};
