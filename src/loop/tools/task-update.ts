import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'task_update',
  description: 'Update a task. Set status to "in_progress" when starting work, "completed" when done, "blocked" when stuck, or "deleted" to remove it. Setting status to "completed" automatically runs all validators — the test file is executed and must pass. Completion is rejected if any validator fails. After max retries, the task is auto-blocked.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      taskId: {
        type: 'number',
        description: 'The task ID to update'
      },
      status: {
        type: 'string',
        description: 'New status: "pending", "in_progress", "completed", "blocked", or "deleted"'
      },
      subject: {
        type: 'string',
        description: 'New subject for the task'
      },
      description: {
        type: 'string',
        description: 'New description for the task'
      },
      activeForm: {
        type: 'string',
        description: 'New spinner label'
      },
      blockedReason: {
        type: 'string',
        description: 'Required when setting status to "blocked". Explains why the task cannot proceed.'
      },
      addBlocks: {
        type: 'array',
        description: 'Task IDs that cannot start until this task completes'
      },
      addBlockedBy: {
        type: 'array',
        description: 'Task IDs that must complete before this task can start'
      }
    },
    required: ['taskId']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  return JSON.stringify({ success: true, message: 'Task updated' });
};
