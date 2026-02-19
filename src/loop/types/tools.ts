/**
 * Tool definitions for the agentic loop
 */

// Base tool interface
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// Tool execution result
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// Tool executor function type
export type ToolExecutor = (parameters: Record<string, any>) => Promise<ToolResult>;

// Tool registry
export interface ToolRegistry {
  register(name: string, tool: Tool, executor: ToolExecutor): void;
  execute(name: string, parameters: Record<string, any>): Promise<ToolResult>;
  list(): Tool[];
}

// Built-in tool types
export type BuiltInToolType = 
  | "file_read"
  | "file_write" 
  | "shell_execute"
  | "web_fetch"
  | "database_query"
  | "code_execute"
  | "test_run"
  | "list_directory"
  | "file_search"
  | "grep"
  | "git"
  | "web_crawl"
  | "google_search"
  | "api_search";

// Tool configuration
export interface ToolConfig {
  enabled: boolean;
  timeout?: number;
  maxRetries?: number;
}
