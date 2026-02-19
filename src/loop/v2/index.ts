/**
 * V2 - Next generation agentic-loop
 *
 * Features:
 * - Native tool calling (Anthropic/OpenAI/Groq)
 * - RAG knowledge base with embeddings
 * - Human-in-the-loop (ask_user tool)
 * - Better test analysis
 * - Multi-file project context
 * - Event-based streaming
 */

// Core
export { AgentV2 } from './core/agent';
export {
  ProviderAdapter,
  createProviderAdapter,
} from './core/provider-adapter';

// Types
export * from './types';

// Tools
export { ToolRegistryV2 } from './tools/registry-v2';
export {
  convertToolDefinition,
  convertToolHandler,
  convertRegisteredTool,
  convertAllTools,
  createNativeToolDefinition,
} from './tools/native-converter';
export {
  askUserDefinition,
  createAskUserHandler,
  createAskUserTool,
  submitAnswer,
  cancelQuestion,
  cancelAllQuestions,
  hasPendingQuestions,
  getPendingQuestionCount,
} from './tools/ask-user';

// RAG
export {
  EmbeddingProvider,
  OpenAIEmbeddingProvider,
  LocalTFIDFProvider,
  HashEmbeddingProvider,
  createEmbeddingProvider,
} from './rag/embeddings';
export {
  VectorStore,
  StoredChunk,
  ChunkMetadata,
  SearchResult,
  createVectorStore,
} from './rag/vector-store';
export {
  TextChunker,
  Chunk,
  ChunkingOptions,
  createChunker,
} from './rag/chunker';
export {
  RAGKnowledgeBase,
  RAGKnowledgeBaseConfig,
  RetrievedContext,
  RetrievedChunk,
  createRAGKnowledgeBase,
} from './rag/knowledge-base-v2';

// Analysis
export {
  TestParser,
  TestFailure,
  TestRunResult,
  createTestParser,
} from './analysis/test-parser';

// Multi-file
export {
  ProjectContext,
  FileState,
  ImportRelation,
  ChangeSummary,
  createProjectContext,
} from './multi-file/project-context';

// Re-export V1 types for compatibility
export type {
  Logger,
  ToolDefinition,
  ToolParameter,
  ToolHandler,
  RegisteredTool,
} from '../types';

import { Agent } from '../agent';
import { ToolRegistry } from '../tool-registry';
import { AgentConfig, Logger } from '../types';
import { AgentV2 } from './core/agent';
import { ToolRegistryV2 } from './tools/registry-v2';
import { AgentV2Config } from './types';
import { convertAllTools } from './tools/native-converter';

/**
 * Factory function to create either V1 or V2 agent
 */
export function createAgent(
  config: AgentConfig | AgentV2Config,
  registry: ToolRegistry | ToolRegistryV2,
  logger: Logger,
  useV2: boolean = false
): Agent | AgentV2 {
  if (useV2) {
    // Convert V1 registry to V2 if needed
    if (registry instanceof ToolRegistry) {
      const v2Registry = new ToolRegistryV2(logger);
      const nativeTools = convertAllTools(registry.getAll(), logger);
      v2Registry.registerAll(nativeTools);
      return new AgentV2(config as AgentV2Config, v2Registry, logger);
    }
    return new AgentV2(config as AgentV2Config, registry, logger);
  }

  // V1 agent
  if (registry instanceof ToolRegistryV2) {
    throw new Error('Cannot use V2 registry with V1 agent');
  }
  return new Agent(config as AgentConfig, registry);
}

/**
 * V1 compatibility wrapper for AgentV2
 */
export class AgentV1Compat {
  private v2Agent: AgentV2;

  constructor(
    config: AgentConfig,
    registry: ToolRegistry,
    logger: Logger
  ) {
    const v2Registry = new ToolRegistryV2(logger);
    const nativeTools = convertAllTools(registry.getAll(), logger);
    v2Registry.registerAll(nativeTools);

    const v2Config: AgentV2Config = {
      model: config.model || 'gpt-4',
      systemPrompt: config.systemPrompt || '',
      maxIterations: config.maxIterations,
      timeoutMs: config.timeoutMs,
      toolTimeoutMs: config.toolTimeout,
      workingDirectory: config.workingDirectory,
      allowDangerousTools: config.allowDangerousTools,
    };

    this.v2Agent = new AgentV2(v2Config, v2Registry, logger);
  }

  async run(userMessage: string, abortSignal?: AbortSignal) {
    const result = await this.v2Agent.run(userMessage, abortSignal);

    // Convert to V1 format
    return {
      status: result.status,
      finalAnswer: result.finalAnswer,
      iterations: [], // V2 doesn't track individual iterations in the same way
      totalTokensEstimate: result.tokenEstimate,
      totalTimeMs: result.totalTimeMs,
      error: result.error,
    };
  }

  getSessionId() {
    return this.v2Agent.getSessionId();
  }

  getEventEmitter() {
    return this.v2Agent.getEventEmitter();
  }
}

// Agent Builder
export * as AgentBuilder from './agent-builder';
