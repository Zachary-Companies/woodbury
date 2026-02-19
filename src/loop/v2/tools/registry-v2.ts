/**
 * Tool Registry V2 - Native tool management
 */

import {
  NativeToolDefinition,
  NativeToolHandler,
  RegisteredNativeTool,
} from '../types';

/**
 * Logger interface
 */
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Registry for native tools in V2
 */
export class ToolRegistryV2 {
  private tools: Map<string, RegisteredNativeTool> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a native tool
   */
  register(
    definition: NativeToolDefinition,
    handler: NativeToolHandler,
    options?: { dangerous?: boolean }
  ): void {
    if (this.tools.has(definition.name)) {
      this.logger.warn(`Tool "${definition.name}" is being overwritten`);
    }

    this.tools.set(definition.name, {
      definition,
      handler,
      dangerous: options?.dangerous,
    });

    this.logger.debug(`Registered native tool: ${definition.name}`);
  }

  /**
   * Register multiple tools at once
   */
  registerAll(tools: RegisteredNativeTool[]): void {
    for (const tool of tools) {
      this.register(tool.definition, tool.handler, { dangerous: tool.dangerous });
    }
  }

  /**
   * Get a registered tool by name
   */
  get(name: string): RegisteredNativeTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): RegisteredNativeTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool definitions (for API calls)
   */
  getAllDefinitions(): NativeToolDefinition[] {
    return this.getAll().map(t => t.definition);
  }

  /**
   * Get tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    const existed = this.tools.has(name);
    this.tools.delete(name);
    if (existed) {
      this.logger.debug(`Unregistered tool: ${name}`);
    }
    return existed;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
    this.logger.debug('Cleared all tools');
  }

  /**
   * Check if a tool is dangerous
   */
  isDangerous(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.dangerous ?? false;
  }

  /**
   * Get only safe tools
   */
  getSafeTools(): RegisteredNativeTool[] {
    return this.getAll().filter(t => !t.dangerous);
  }

  /**
   * Get only dangerous tools
   */
  getDangerousTools(): RegisteredNativeTool[] {
    return this.getAll().filter(t => t.dangerous);
  }
}
