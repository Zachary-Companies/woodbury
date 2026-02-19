/**
 * Native tool type definitions for V2 - matches Anthropic SDK format
 */

/**
 * JSON Schema type for tool parameters
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  description?: string;
  items?: JSONSchemaProperty;
  enum?: (string | number | boolean)[];
  additionalProperties?: boolean | JSONSchemaProperty;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | ('string' | 'number' | 'boolean' | 'array' | 'object' | 'null')[];
  description?: string;
  enum?: (string | number | boolean)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Native tool definition - matches Anthropic SDK format
 */
export interface NativeToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

/**
 * Tool call from provider response
 */
export interface NativeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to send back
 */
export interface NativeToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Tool execution result with metadata
 */
export interface ToolExecutionResult {
  toolCall: NativeToolCall;
  status: 'success' | 'error';
  output: string;
  executionTimeMs: number;
}

/**
 * Context for tool execution
 */
export interface ToolExecutionContext {
  workingDirectory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  projectContext?: ProjectContextRef;
}

/**
 * Reference to project context for multi-file tracking
 */
export interface ProjectContextRef {
  trackFileRead(path: string, content: string): void;
  trackFileWrite(path: string, content: string): void;
  getFileState(path: string): FileState | undefined;
}

export interface FileState {
  path: string;
  originalContent?: string;
  currentContent: string;
  isModified: boolean;
}

/**
 * Native tool handler function
 */
export type NativeToolHandler = (
  input: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<string>;

/**
 * Registered native tool
 */
export interface RegisteredNativeTool {
  definition: NativeToolDefinition;
  handler: NativeToolHandler;
  dangerous?: boolean;
}
