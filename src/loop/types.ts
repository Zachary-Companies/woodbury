// Core agent types
export interface AgentConfig {
  name: string;
  description?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: string[];
  workingDirectory?: string;
  timeout?: number;
  maxRetries?: number;
  enabledTools?: string[];
  // Additional properties found in usage
  provider?: 'openai' | 'anthropic' | 'groq' | 'claude-code';
  model?: string;
  apiKey?: string;
  baseURL?: string;
  logger?: Logger;
  timeoutMs?: number;  // alias for timeout
  maxIterations?: number;
  toolTimeout?: number;
  allowDangerousTools?: boolean;
  // Streaming support
  onToken?: (token: string) => void;
  streaming?: boolean;
  // Callbacks for tool execution events (allows outer renderer to display tool activity)
  onToolStart?: (toolName: string, params?: any) => void;
  onToolEnd?: (toolName: string, success: boolean, result?: string, duration?: number) => void;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ParsedToolCall[];
  finishReason: 'stop' | 'length' | 'function_call' | 'error';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
}

// Tool system types
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
  dangerous?: boolean;
}

export interface ToolHandler {
  (params: any, context: ToolContext): Promise<any>;
}

export interface ToolContext {
  workingDirectory: string;
  agent?: any;
  logger?: Logger;
  timeout?: number;
  timeoutMs?: number; // alias for timeout
  toolTimeout?: number; // allow access using toolTimeout name
  dangerous?: boolean;
  signal?: AbortSignal;
}

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// Legacy types that are still referenced
export interface ToolCall {
  name: string;
  parameters: Record<string, unknown>;
  id?: string;
}

export interface ToolCallValidationResult {
  isValid: boolean;
  error?: string;
  toolCall?: ParsedToolCall;
}

export type ToolResult = string | {
  success: boolean;
  data?: any;
  error?: string;
  [key: string]: any;
};

// Logger interface
export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

// Configuration types
export interface ConfigFile {
  workingDirectory?: string;
  timeout?: number;
  maxIterations?: number;
  toolTimeout?: number;
  allowDangerousTools?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
}

// Task management types
export interface Task {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'deleted';
  activeForm?: string;
  validators: Validator[];
  maxRetries?: number;
  toolCallBudget?: number;
  retryCount?: number;
  blockedReason?: string;
  blocks?: number[];
  blockedBy?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface Validator {
  type: 'test_file' | 'file_exists' | 'file_contains' | 'command_succeeds' | 'command_output_matches';
  path?: string;
  pattern?: string;
  command?: string;
}

// Queue management types
export interface QueueItem {
  name: string;
  details: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  notes?: string;
}

export interface WorkQueue {
  sharedContext: string;
  items: QueueItem[];
  currentIndex: number;
  totalItems: number;
  completedItems: number;
  skippedItems: number;
}

// Subagent types
export type SubagentType = 'explore' | 'plan' | 'execute';

export interface SubagentConfig {
  type: SubagentType;
  task: string;
  context: string;
  provider?: 'openai' | 'anthropic' | 'groq' | 'claude-code';
  model?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface SubagentRequest {
  type: SubagentType;
  task: string;
  context: string;
}

export interface SubagentResponse {
  success: boolean;
  result?: string;
  error?: string;
}

export interface SubagentResult {
  success: boolean;
  result: string;
  error?: string;
  metadata?: {
    type: string;
    toolCalls: number;
    executionTime: number;
  };
}

// Memory types
export type MemoryCategory = 'convention' | 'discovery' | 'decision' | 'gotcha' | 'file_location' | 'endpoint';

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  timestamp: string;
}

// Goal contract types
export interface GoalContract {
  objective: string;
  successCriteria: string[];
  constraints?: string[];
  assumptions?: string[];
  createdAt: string;
}

// Risk assessment types
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskAssessment {
  action: string;
  riskLevel: RiskLevel;
  justification: string;
  timestamp: string;
  approved?: boolean;
}

// Code generator types
export interface CodeGeneratorConfig {
  outputPath?: string;
  templatePath?: string;
  variables?: Record<string, any>;
  overwrite?: boolean;
}

export interface CodeGenerationRequest {
  prompt: string;
  language?: string;
  framework?: string;
  functionName?: string;
  examples?: CodeExample[];
  constraints?: string[];
}

export interface CodeGenerationResult {
  code: string;
  explanation?: string;
  examples?: CodeExample[];
  dependencies?: string[];
}

export interface CodeExample {
  input: string;
  output: string;
  description?: string;
}

export interface GeneratorTemplate {
  name: string;
  description: string;
  files: TemplateFile[];
  variables: TemplateVariable[];
}

export interface TemplateFile {
  path: string;
  content: string;
  encoding?: string;
}

export interface TemplateVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  default?: any;
}

// Tool parameter types
export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// Search and API types
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface ApiDocumentation {
  name: string;
  baseUrl: string;
  authMethods: string[];
  endpoints: ApiEndpoint[];
  sdks?: ApiSdk[];
}

export interface ApiEndpoint {
  method: string;
  path: string;
  description: string;
  parameters?: ApiParameter[];
}

export interface ApiParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiSdk {
  language: string;
  packageName: string;
  installCommand: string;
}

// Database types
export type DatabaseEngine = 'sqlite' | 'postgres' | 'dynamodb';

export interface DatabaseConfig {
  engine: DatabaseEngine;
  connectionString?: string;
  tableName?: string;
  region?: string;
}

// HTTP types
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

// Web crawling types
export interface CrawlOptions {
  selector?: string;
  waitForSelector?: string;
  includeLinks?: boolean;
  maxContentLength?: number;
}

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  links: string[];
  metadata?: Record<string, any>;
}

// File system types
export interface FileSystemEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

// Git types
export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  staged: string[];
  untracked: string[];
}

// Conversation types
export interface Conversation {
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

export interface ConversationStorage {
  save(id: string, conversation: Conversation): Promise<void>;
  load(id: string): Promise<Conversation | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<boolean>;
}

export interface MemoryStorage {
  save(category: string, content: string, tags?: string[]): Promise<void>;
  recall(query: string, category?: string): Promise<Array<{
    content: string;
    category: string;
    tags: string[];
    timestamp: Date;
  }>>;
}

export interface AgentMetrics {
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  totalTokensUsed: number;
  averageResponseTime: number;
}
