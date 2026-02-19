import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'task_create',
  description: 'Create a new task to track work. Every task requires at least one validator. For any task involving code, you MUST include a "test_file" validator — write the test first, then implement.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Brief imperative title, e.g. "Fix authentication bug in login flow"'
      },
      description: {
        type: 'string',
        description: 'Detailed description of what needs to be done, including context and acceptance criteria'
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous label shown while task is in_progress, e.g. "Fixing authentication bug"'
      },
      validators: {
        type: 'array',
        description: 'Required. At least one acceptance criterion. Each is an object with "type" and type-specific fields:\n- { "type": "test_file", "path": "src/__tests__/utils.test.ts" } — PREFERRED for code tasks. The test file must exist and all tests in it must pass. Optionally add "command" to override the test runner (default: npx jest).\n- { "type": "file_exists", "path": "src/foo.ts" } — file must exist\n- { "type": "file_contains", "path": "src/foo.ts", "pattern": "export function bar" } — file must match regex\n- { "type": "command_succeeds", "command": "npm run build" } — command must exit 0\n- { "type": "command_output_matches", "command": "npm test", "pattern": "passed" } — output must match regex'
      },
      maxRetries: {
        type: 'number',
        description: 'Maximum validation retries before auto-blocking (default: 3)'
      },
      toolCallBudget: {
        type: 'number',
        description: 'Maximum tool calls allowed for this task (default: 50). Increase for complex tasks, decrease for simple ones.'
      }
    },
    required: ['subject', 'description', 'validators']
  }
};

export const handler: ToolHandler = async (params: any, context?: ToolContext): Promise<string> => {
  // This is a placeholder implementation
  // The actual implementation would be provided by the framework
  return JSON.stringify({ success: true, message: 'Task created' });
};
