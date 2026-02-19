import { SubagentRequest } from './types';

/**
 * Build a prompt for a subagent based on the request type and context
 */
export function buildSubagentPrompt(request: SubagentRequest): string {
  const basePrompt = `You are a specialized subagent with ${request.type} capabilities.\n\nTask: ${request.task}\n\n`;
  
  let roleSpecificPrompt = '';
  
  switch (request.type) {
    case 'explore':
      roleSpecificPrompt = 'You have read-only access to explore and understand the codebase. Focus on analysis and discovery.\n\n';
      break;
    case 'plan':
      roleSpecificPrompt = 'You have read-only access to create implementation plans. Focus on strategy and design.\n\n';
      break;
    case 'execute':
      roleSpecificPrompt = 'You have full tool access to implement changes. Focus on execution and testing.\n\n';
      break;
  }
  
  const contextPrompt = request.context ? `Context:\n${request.context}\n\n` : '';
  
  return basePrompt + roleSpecificPrompt + contextPrompt + 'Begin your work now.';
}

/**
 * Format a tool call result for display
 */
export function formatToolResult(result: any): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Validate that required environment variables are present
 */
export function validateEnvironment(required: string[]): void {
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
