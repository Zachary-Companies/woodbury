/**
 * V2 Types - Re-exports all type definitions
 */

export * from './tool-types';
export * from './events';

import { NativeToolDefinition } from './tool-types';
import { AgentEventEmitter, AgentPhase } from './events';
import { RetryConfig } from '../../utils/retry';

/**
 * V2 Agent configuration
 */
export interface AgentV2Config {
  /** LLM model to use */
  model: string;

  /** Provider: 'anthropic' | 'openai' | 'groq' */
  provider?: 'anthropic' | 'openai' | 'groq';

  /** System prompt for the agent */
  systemPrompt: string;

  /** Maximum iterations before stopping (default: 50) */
  maxIterations?: number;

  /** Timeout for entire agent run in ms (default: 300000 = 5 min) */
  timeoutMs?: number;

  /** Timeout per tool execution in ms (default: 30000 = 30 sec) */
  toolTimeoutMs?: number;

  /** Working directory for file operations */
  workingDirectory?: string;

  /** Whether to allow dangerous tools (default: false) */
  allowDangerousTools?: boolean;

  /** Whether to use streaming responses (default: true) */
  streaming?: boolean;

  /** Enable human-in-the-loop (default: false) */
  humanInTheLoop?: boolean;

  /** Event emitter for streaming updates */
  eventEmitter?: AgentEventEmitter;

  /** RAG configuration */
  rag?: RAGConfig;

  /** Retry configuration for LLM calls (default: 3 retries with exponential backoff) */
  retryConfig?: RetryConfig;
}

/**
 * RAG (Retrieval-Augmented Generation) configuration
 */
export interface RAGConfig {
  /** Enable RAG (default: true if knowledge base provided) */
  enabled?: boolean;

  /** Number of chunks to retrieve (default: 5) */
  topK?: number;

  /** Minimum similarity threshold (default: 0.3) */
  minSimilarity?: number;

  /** Maximum context length in tokens (default: 4000) */
  maxContextTokens?: number;

  /** Embedding provider: 'openai' | 'local' */
  embeddingProvider?: 'openai' | 'local';
}

/**
 * V2 Agent run result
 */
export interface AgentV2RunResult {
  status: 'success' | 'error' | 'max_iterations' | 'timeout' | 'cancelled';
  finalAnswer?: string;
  iterations: number;
  totalTimeMs: number;
  tokenEstimate: number;
  error?: Error;
  toolCalls: number;
  questionsAsked: number;
}

/**
 * Message format for V2 - supports native tool use
 */
export interface MessageV2 {
  role: 'user' | 'assistant' | 'system';
  content: MessageContentV2[];
}

export type MessageContentV2 =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Provider response format
 */
export interface ProviderResponse {
  id: string;
  model: string;
  content: MessageContentV2[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Stream event from provider
 */
export interface ProviderStreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop';
  index?: number;
  content_block?: MessageContentV2;
  delta?: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
  message?: {
    id: string;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { output_tokens: number };
}
