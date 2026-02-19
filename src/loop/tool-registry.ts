import { ToolDefinition, ToolHandler, Logger } from './types.js';
import { convertLegacyToolDefinition, isLegacyToolDefinition } from './tool-parameter-converter.js';
import { createLogger } from './logger.js';

export class ToolRegistry {
  private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || createLogger('ToolRegistry');
  }

  register(definition: ToolDefinition | any, handler: ToolHandler): void {
    // Convert legacy format if needed
    let normalizedDefinition: ToolDefinition;
    if (isLegacyToolDefinition(definition)) {
      normalizedDefinition = convertLegacyToolDefinition(definition);
      this.logger.debug(`Converted legacy tool definition: ${definition.name}`);
    } else {
      normalizedDefinition = definition;
    }

    if (this.tools.has(normalizedDefinition.name)) {
      throw new Error(`Tool '${normalizedDefinition.name}' is already registered`);
    }

    this.tools.set(normalizedDefinition.name, {
      definition: normalizedDefinition,
      handler
    });

    this.logger.info(`Registered tool: ${normalizedDefinition.name}`);
  }

  unregister(name: string): boolean {
    const success = this.tools.delete(name);
    if (success) {
      this.logger.info(`Unregistered tool: ${name}`);
    }
    return success;
  }

  get(name: string): { definition: ToolDefinition; handler: ToolHandler } | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  // Method expected by tests
  getToolNames(): string[] {
    return this.list();
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  getHandlers(): Map<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    for (const [name, tool] of this.tools) {
      handlers.set(name, tool.handler);
    }
    return handlers;
  }

  clear(): void {
    this.tools.clear();
    this.logger.info('Cleared all tools');
  }

  getDangerousTools(): string[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.definition.dangerous)
      .map(tool => tool.definition.name);
  }

  getSafeTools(): string[] {
    return Array.from(this.tools.values())
      .filter(tool => !tool.definition.dangerous)
      .map(tool => tool.definition.name);
  }

  generateToolDocumentation(): string {
    let docs = '# Available Tools\n\n';
    
    for (const tool of this.tools.values()) {
      docs += `## ${tool.definition.name}\n`;
      docs += `${tool.definition.description}\n\n`;
      
      if (tool.definition.dangerous) {
        docs += '**⚠️ This tool is marked as dangerous**\n\n';
      }
      
      docs += '**Parameters:**\n';
      const props = tool.definition.parameters?.properties;
      const required = tool.definition.parameters?.required || [];

      if (props && typeof props === 'object') {
        for (const [name, prop] of Object.entries(props)) {
          const isRequired = required.includes(name);
          const propDef = prop as any;
          docs += `- \`${name}\` (${propDef.type})${isRequired ? ' **required**' : ' *optional*'}: ${propDef.description}\n`;
          if (propDef.default !== undefined) {
            docs += `  - Default: \`${JSON.stringify(propDef.default)}\`\n`;
          }
        }
      } else {
        docs += '*(schema-defined parameters)*\n';
      }
      
      docs += '\n';
    }
    
    return docs;
  }

  getAll(): { definition: ToolDefinition; handler: ToolHandler }[] {
    return Array.from(this.tools.values());
  }

  count(): number {
    return this.tools.size;
  }

  validateToolCall(name: string, parameters: Record<string, any>): { valid: boolean; error?: string } {
    const tool = this.tools.get(name);
    if (!tool) {
      return { valid: false, error: `Tool '${name}' not found` };
    }

    const { definition } = tool;
    const required = definition.parameters?.required || [];
    const properties = definition.parameters?.properties;

    // Skip validation for non-standard parameter schemas (e.g. Zod)
    if (!properties || typeof properties !== 'object') {
      return { valid: true };
    }

    // Check required parameters
    for (const requiredParam of required) {
      if (!(requiredParam in parameters)) {
        return { valid: false, error: `Missing required parameter: ${requiredParam}` };
      }
    }

    // Check parameter types
    for (const [paramName, paramValue] of Object.entries(parameters)) {
      if (!(paramName in properties)) {
        return { valid: false, error: `Unknown parameter: ${paramName}` };
      }

      const propDef = properties[paramName] as any;
      const expectedType = propDef.type;
      const actualType = typeof paramValue;

      // Basic type checking
      if (expectedType === 'string' && actualType !== 'string') {
        return { valid: false, error: `Parameter '${paramName}' should be string, got ${actualType}` };
      }
      if (expectedType === 'number' && actualType !== 'number') {
        return { valid: false, error: `Parameter '${paramName}' should be number, got ${actualType}` };
      }
      if (expectedType === 'boolean' && actualType !== 'boolean') {
        return { valid: false, error: `Parameter '${paramName}' should be boolean, got ${actualType}` };
      }
    }

    return { valid: true };
  }
  
  // Legacy compatibility aliases
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.register(definition, handler);
  }

  getTool(name: string) {
    return this.get(name);
  }

  getAllTools() {
    return this.getAll();
  }
}

// Default registry instance
export const defaultToolRegistry = new ToolRegistry();
