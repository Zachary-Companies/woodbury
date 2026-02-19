import { ToolDefinition } from './types.js';

// Legacy parameter format used in tool files
interface LegacyParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
}

// Legacy tool definition format
interface LegacyToolDefinition {
  name: string;
  description: string;
  parameters: LegacyParameter[];
  dangerous?: boolean;
}

/**
 * Convert legacy array-based parameter format to OpenAPI-style object format
 */
export function convertParametersToOpenAPI(legacyParams: LegacyParameter[]): ToolDefinition['parameters'] {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const param of legacyParams) {
    properties[param.name] = {
      type: param.type,
      description: param.description
    };
    
    if (param.default !== undefined) {
      properties[param.name].default = param.default;
    }
    
    if (param.enum) {
      properties[param.name].enum = param.enum;
    }
    
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined
  };
}

/**
 * Convert legacy tool definition to standard format
 */
export function convertLegacyToolDefinition(legacy: LegacyToolDefinition): ToolDefinition {
  return {
    name: legacy.name,
    description: legacy.description,
    parameters: convertParametersToOpenAPI(legacy.parameters),
    dangerous: legacy.dangerous
  };
}

/**
 * Check if a tool definition uses legacy format
 */
export function isLegacyToolDefinition(definition: any): definition is LegacyToolDefinition {
  return Array.isArray(definition.parameters);
}
