// Core exports
export { Agent } from './agent.js';
export { AgentFactory } from './agent-factory.js';
export { ToolRegistry } from './tool-registry.js';
export { ToolParser, parseToolCall, validateToolCall } from './tool-parser.js';
export { loadConfig } from './config.js';
export { createLogger, ProgressLogger } from './logger.js';
export { createRenderer } from './renderer.js';

// --- Woodbury extensions ------------------------------------------------
// Streaming LLM entry point + callback type used by the dashboard chat UI
// and agent-factory. Upstream doesn't export these (streaming lives in
// llm-service only locally).
export { runPromptStream } from './llm-service.js';
export type { StreamCallbacks } from './llm-service.js';
// --- end Woodbury extensions --------------------------------------------

// Session persistence
export {
  SessionStore,
  SessionManager,
} from './session.js';
export type {
  StoredSession,
  SessionMessage,
  SessionContentBlock,
  SessionUsage,
  TokenUsage,
  PermissionDecision,
} from './session.js';

// Permission system
export {
  PermissionPolicy,
  PermissionMode,
} from './permissions.js';
export type {
  PermissionOutcome,
  PermissionPrompter,
} from './permissions.js';

// Hook system
export { HookRunner } from './hooks.js';
export type {
  HookConfig,
  HookPayload,
  HookResult,
  HookEvent,
} from './hooks.js';

// Memory store
export { MemoryStore } from './memory-store.js';
export type {
  StoredMemory,
  MemoryScope,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStoreConfig,
} from './memory-store.js';

// Compaction
export {
  compactMessages,
  shouldCompact,
  estimateTokens,
  buildStructuredSummary,
  formatSummary,
  formatContinuationMessage,
  extractExistingCompactionSummary,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction.js';
export type {
  CompactionConfig,
  CompactionResult,
  CompactionSummary,
  ChatMessageCompat,
} from './compaction.js';

// Type exports
export * from './types.js';

// Tool exports - only existing ones
export {
  fileReadDefinition,
  fileReadHandler,
  fileEditDefinition,
  fileEditHandler,
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
  memorySaveDefinition,
  memorySaveHandler,
  memoryRecallDefinition,
  memoryRecallHandler,
  memoryForgetDefinition,
  memoryForgetHandler,
  allTools,
} from './tools/index.js';

// Project context discovery
export { discoverProjectContext } from './project-context.js';
export type { ProjectContextResult } from './project-context.js';

// Software engineering prompt and preset
export { SOFTWARE_ENGINEERING_PROMPT } from './prompts/software-engineering.js';
export { createSoftwareAgent, createSoftwareToolRegistry } from './presets/software-engineering.js';
export type { SoftwareAgentOptions } from './presets/software-engineering.js';

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
