/**
 * Native Converter - Convert V1 tool definitions to native format
 */

import {
  ToolDefinition,
  ToolParameter,
  ToolHandler,
  RegisteredTool,
} from '../../types';
import {
  NativeToolDefinition,
  NativeToolHandler,
  RegisteredNativeTool,
  JSONSchema,
  JSONSchemaProperty,
  ToolExecutionContext,
} from '../types';

/**
 * Convert V1 tool parameter type to JSON Schema type
 */
function convertParameterType(type: ToolParameter['type']): JSONSchemaProperty['type'] {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'array':
      return 'array';
    default:
      return 'string';
  }
}

/**
 * Convert V1 tool definition to native format
 */
export function convertToolDefinition(tool: ToolDefinition): NativeToolDefinition {
  // Handle JSON Schema parameters (already in correct format)
  if (!Array.isArray(tool.parameters)) {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    };
  }

  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];

  for (const param of tool.parameters) {
    properties[param.name] = {
      type: convertParameterType(param.type),
      description: param.description,
    };

    if (param.default !== undefined) {
      properties[param.name].default = param.default;
    }

    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

/**
 * Logger interface for tool conversion
 */
interface MinimalLogger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

const noopLogger: MinimalLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Convert V1 tool handler to native format
 */
export function convertToolHandler(
  handler: ToolHandler,
  logger?: MinimalLogger
): NativeToolHandler {
  return async (input: Record<string, unknown>, context: ToolExecutionContext): Promise<string> => {
    // Convert context to V1 format
    const v1Context = {
      workingDirectory: context.workingDirectory,
      timeoutMs: context.timeoutMs,
      logger: logger || noopLogger,
      signal: context.signal,
    };

    return handler(input, v1Context as any);
  };
}

/**
 * Convert V1 registered tool to native format
 */
export function convertRegisteredTool(
  tool: RegisteredTool,
  logger?: MinimalLogger
): RegisteredNativeTool {
  return {
    definition: convertToolDefinition(tool.definition),
    handler: convertToolHandler(tool.handler, logger),
    dangerous: tool.definition.dangerous,
  };
}

/**
 * Batch convert multiple V1 tools
 */
export function convertAllTools(
  tools: RegisteredTool[],
  logger?: MinimalLogger
): RegisteredNativeTool[] {
  return tools.map(tool => convertRegisteredTool(tool, logger));
}

/**
 * Create a native tool definition from scratch
 */
export function createNativeToolDefinition(
  name: string,
  description: string,
  parameters: Record<string, {
    type: JSONSchemaProperty['type'];
    description: string;
    required?: boolean;
    default?: unknown;
    enum?: (string | number | boolean)[];
  }>
): NativeToolDefinition {
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];

  for (const [paramName, param] of Object.entries(parameters)) {
    properties[paramName] = {
      type: param.type,
      description: param.description,
      default: param.default,
      enum: param.enum,
    };

    if (param.required) {
      required.push(paramName);
    }
  }

  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}
