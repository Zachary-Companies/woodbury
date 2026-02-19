import { allTools } from '../loop/index.js';
import { delegate } from './delegate';

// Get all built-in tools from agentic-loop
const builtInTools = allTools;

// Add our custom tools
const customTools = {
  delegate
};

// Combine all tools
export function getAllTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  
  // Add built-in tools from agentic-loop
  Object.assign(tools, builtInTools);
  
  // Add custom tools
  Object.assign(tools, customTools);
  
  return tools;
}

// Export individual tools for direct access
export { delegate };

// Default export
export default getAllTools();
