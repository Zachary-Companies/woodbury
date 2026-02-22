// Re-export types from agentic-loop
export type { ToolDefinition, ToolHandler, AgentConfig } from './loop/index.js';

// ParsedToolCall interface (from agentic-loop but may not be exported)
export interface ParsedToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
}

// AgentResult interface (from agentic-loop but not exported)
export interface AgentResult {
  success: boolean;
  content: string;
  error?: string;
  toolCalls: ParsedToolCall[];
  metadata: {
    executionTime: number;
    iterations: number;
  };
}

// Local Agent configuration for compatibility
export interface LocalAgentConfig {
  name: string;
  provider: 'openai' | 'anthropic' | 'groq';
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

// Woodbury-specific configuration
export interface WoodburyConfig {
  // Core properties
  model?: string;
  provider?: 'openai' | 'anthropic' | 'groq';
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  workingDirectory?: string;
  contextDir?: string;
  
  // API Configuration
  apiKeys?: {
    openai?: string;
    anthropic?: string;
    groq?: string;
  };
  
  // Runtime options
  verbose?: boolean;
  safe?: boolean;
  maxIterations?: number;
  timeout?: number;
  
  // Feature flags
  orchestrate?: boolean;
  jobsFile?: string;
  stream?: boolean;

  /** Disable all extensions */
  noExtensions?: boolean;

  /** Enable debug logging to ~/.woodbury/logs/ */
  debug?: boolean;

  /** URL of the running config dashboard (set at runtime) */
  dashboardUrl?: string;
}

// Job orchestration types
export interface Job {
  id: string;
  description: string;
  prompt: string;
  dependsOn?: string[];
}

export interface JobResult {
  id: string;
  success: boolean;
  result?: string;
  error?: string;
  executionTime: number;
}

export interface OrchestrationResult {
  completed: JobResult[];
  failed: JobResult[];
  totalTime: number;
}

// Tool-related types
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ToolExecuteFunction<T = any> {
  (params: T): Promise<ToolResult>;
}

export interface WoodburyToolDefinition<T = any> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: ToolExecuteFunction<T>;
}

// Chat and conversation types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ConversationTurn {
  id: string;
  timestamp: Date;
  role: 'user' | 'assistant';
  content: string;
  userMessage?: string;  // For backward compatibility
  assistantMessage?: string;  // For backward compatibility
  toolCalls?: any[];
  error?: string;
}

export interface ConversationManager {
  addTurn(turn: ConversationTurn): void;
  getTurns(): ConversationTurn[];
  clear(): void;
  save(): Promise<void>;
  load(): Promise<void>;
}

// Command line interface types
export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string[], context: SlashCommandContext) => Promise<void>;
}

export interface SlashCommandContext {
  config: WoodburyConfig;
  workingDirectory: string;
  print: (message: string) => void;
  agent?: any;
  extensionManager?: any;
}

// Renderer types
export interface RunStats {
  totalTimeMs: number;
  iterations: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Renderer {
  renderMessage(content: string, type?: 'user' | 'assistant' | 'system'): void;
  renderError(error: string | Error): void;
  renderStats(stats: RunStats): void;
  renderToolCall(toolName: string, params: any): void;
  renderToolResult(result: any): void;
}

export interface TerminalRenderer extends Renderer {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

// Utility functions
export function classifyError(error: any): 'network' | 'auth' | 'rate_limit' | 'validation' | 'unknown' {
  if (!error) return 'unknown';
  
  const message = error.message || error.toString();
  const lowerMessage = message.toLowerCase();
  
  if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
    return 'network';
  }
  if (lowerMessage.includes('unauthorized') || lowerMessage.includes('auth')) {
    return 'auth';
  }
  if (lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    return 'rate_limit';
  }
  if (lowerMessage.includes('validation') || lowerMessage.includes('invalid')) {
    return 'validation';
  }
  
  return 'unknown';
}

// Extension system types (re-exported for convenience)
export type {
  ExtensionContext,
  ExtensionSlashCommand,
  ExtensionCommandContext,
  WebUIOptions,
  WebUIHandle,
  ExtensionLogger,
  WoodburyExtension,
} from './extension-api.js';
