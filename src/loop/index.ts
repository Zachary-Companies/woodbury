// Core exports
export { Agent } from './agent.js';
export { AgentFactory } from './agent-factory.js';
export { ToolRegistry } from './tool-registry.js';
export { ToolParser, parseToolCall, validateToolCall } from './tool-parser.js';
export { loadConfig } from './config.js';
export { createLogger, ProgressLogger } from './logger.js';
export { createRenderer } from './renderer.js';
export { runPromptStream } from './llm-service.js';
export type { StreamCallbacks } from './llm-service.js';

// Type exports
export * from './types.js';

// Tool exports - only existing ones
export {
  fileReadDefinition,
  fileReadHandler,
  fileWriteDefinition,
  fileWriteHandler,
  listDirectoryDefinition,
  listDirectoryHandler,
  fileSearchDefinition,
  fileSearchHandler,
  grepDefinition,
  grepHandler,
  codeExecuteDefinition,
  codeExecuteHandler,
  shellExecuteDefinition,
  shellExecuteHandler,
  gitDefinition,
  gitHandler,
  testRunnerDefinition,
  testRunnerHandler,
  testRunDefinition,
  testRunHandler,
  webFetchDefinition,
  webFetchHandler,
  webCrawlDefinition,
  webCrawlHandler,
  webCrawlRenderedDefinition,
  webCrawlRenderedHandler,
  googleSearchDefinition,
  googleSearchHandler,
  duckduckgoSearchDefinition,
  duckduckgoSearchHandler,
  searxngSearchDefinition,
  searxngSearchHandler,
  apiSearchDefinition,
  apiSearchHandler,
  databaseQueryDefinition,
  databaseQueryHandler,
  allTools,
} from './tools/index.js';

// Knowledge base
export { KnowledgeBase } from './knowledge-base.js';

// Code generator
export { CodeGenerator } from './code-generator.js';

// Import ToolRegistry for the factory function
import { ToolRegistry } from './tool-registry.js';
import { allTools } from './tools/index.js';

// Default tool registry with all tools
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  
  // Register all available tools
  allTools.forEach(({ definition, handler }) => {
    registry.register(definition, handler);
  });
  
  return registry;
}
