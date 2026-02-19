/**
 * Tool Generator
 * Generates NativeToolDefinition from parsed API specifications
 */

import { NativeToolDefinition, JSONSchema } from '../../types/tool-types'
import {
  ParsedApiSpec,
  ApiEndpoint,
  ApiParameter,
  ApiSchemaRef,
  ApiSchema
} from './doc-parser'

/**
 * Generated tool with handler template
 */
export interface GeneratedTool {
  /** Tool definition for LLM */
  definition: NativeToolDefinition

  /** Template code for the handler */
  handlerTemplate: string

  /** Original endpoint info */
  endpoint: ApiEndpoint

  /** Whether this tool mutates data */
  isMutating: boolean

  /** Dependencies (other tools this might call) */
  dependencies: string[]
}

/**
 * Tool generation options
 */
export interface ToolGenerationOptions {
  /** Prefix for tool names */
  namePrefix?: string

  /** Include deprecated endpoints */
  includeDeprecated?: boolean

  /** Maximum description length */
  maxDescriptionLength?: number

  /** Generate handlers with authentication */
  includeAuth?: boolean

  /** Base URL to use (overrides spec) */
  baseUrl?: string

  /** Only generate tools for specific tags */
  filterTags?: string[]

  /** Only generate tools for specific operations */
  filterOperations?: string[]
}

/**
 * Generate tools from a parsed API spec
 */
export function generateToolsFromSpec(
  spec: ParsedApiSpec,
  options: ToolGenerationOptions = {}
): GeneratedTool[] {
  const {
    namePrefix = '',
    includeDeprecated = false,
    maxDescriptionLength = 500,
    filterTags,
    filterOperations
  } = options

  const tools: GeneratedTool[] = []
  const schemaMap = new Map(spec.schemas.map(s => [s.name, s]))

  for (const endpoint of spec.endpoints) {
    // Skip deprecated if not wanted
    if (endpoint.deprecated && !includeDeprecated) {
      continue
    }

    // Filter by tags
    if (filterTags && filterTags.length > 0) {
      if (!endpoint.tags.some(t => filterTags.includes(t))) {
        continue
      }
    }

    // Filter by operations
    if (filterOperations && filterOperations.length > 0) {
      if (endpoint.operationId && !filterOperations.includes(endpoint.operationId)) {
        continue
      }
    }

    const tool = generateToolFromEndpoint(endpoint, spec, schemaMap, {
      ...options,
      namePrefix,
      maxDescriptionLength
    })

    tools.push(tool)
  }

  return tools
}

/**
 * Generate a single tool from an endpoint
 */
function generateToolFromEndpoint(
  endpoint: ApiEndpoint,
  spec: ParsedApiSpec,
  schemaMap: Map<string, ApiSchema>,
  options: ToolGenerationOptions
): GeneratedTool {
  const { namePrefix = '', maxDescriptionLength = 500, includeAuth = true, baseUrl } = options

  // Generate tool name
  const toolName = generateToolName(endpoint, namePrefix)

  // Generate description
  let description = endpoint.summary || endpoint.description || `${endpoint.method} ${endpoint.path}`
  if (description.length > maxDescriptionLength) {
    description = description.substring(0, maxDescriptionLength - 3) + '...'
  }

  // Generate input schema
  const inputSchema = generateInputSchema(endpoint, schemaMap)

  // Create tool definition
  const definition: NativeToolDefinition = {
    name: toolName,
    description,
    input_schema: inputSchema
  }

  // Determine if mutating
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method)

  // Generate handler template
  const handlerTemplate = generateHandlerTemplate(
    endpoint,
    spec,
    toolName,
    includeAuth,
    baseUrl
  )

  return {
    definition,
    handlerTemplate,
    endpoint,
    isMutating,
    dependencies: []
  }
}

/**
 * Generate a valid tool name from an endpoint
 */
function generateToolName(endpoint: ApiEndpoint, prefix: string): string {
  // Use operationId if available
  if (endpoint.operationId) {
    const cleaned = endpoint.operationId
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase()
    return prefix ? `${prefix}_${cleaned}` : cleaned
  }

  // Generate from method and path
  const pathParts = endpoint.path
    .split('/')
    .filter(p => p && !p.startsWith('{'))
    .map(p => p.toLowerCase())

  const name = `${endpoint.method.toLowerCase()}_${pathParts.join('_')}`
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')

  return prefix ? `${prefix}_${name}` : name
}

/**
 * Generate input schema from endpoint parameters and request body
 */
function generateInputSchema(
  endpoint: ApiEndpoint,
  schemaMap: Map<string, ApiSchema>
): JSONSchema {
  const properties: Record<string, JSONSchema> = {}
  const required: string[] = []

  // Add path parameters
  for (const param of endpoint.parameters.filter(p => p.in === 'path')) {
    properties[param.name] = resolveSchemaRef(param.schema, schemaMap)
    properties[param.name].description = param.description
    required.push(param.name)
  }

  // Add query parameters
  for (const param of endpoint.parameters.filter(p => p.in === 'query')) {
    properties[param.name] = resolveSchemaRef(param.schema, schemaMap)
    properties[param.name].description = param.description
    if (param.required) {
      required.push(param.name)
    }
  }

  // Add header parameters (excluding common ones)
  for (const param of endpoint.parameters.filter(p => p.in === 'header')) {
    const lowerName = param.name.toLowerCase()
    if (!['authorization', 'content-type', 'accept'].includes(lowerName)) {
      properties[param.name] = resolveSchemaRef(param.schema, schemaMap)
      properties[param.name].description = param.description
      if (param.required) {
        required.push(param.name)
      }
    }
  }

  // Add request body
  if (endpoint.requestBody) {
    const jsonContent = endpoint.requestBody.content['application/json']
    if (jsonContent?.schema) {
      const bodySchema = resolveSchemaRef(jsonContent.schema, schemaMap)

      // If body is an object, merge its properties
      if (bodySchema.type === 'object' && bodySchema.properties) {
        for (const [key, prop] of Object.entries(bodySchema.properties)) {
          properties[key] = prop as JSONSchema
        }
        if (bodySchema.required) {
          required.push(...(bodySchema.required as string[]))
        }
      } else {
        // Otherwise add as a 'body' parameter
        properties['body'] = bodySchema
        properties['body'].description = endpoint.requestBody.description || 'Request body'
        if (endpoint.requestBody.required) {
          required.push('body')
        }
      }
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined
  }
}

/**
 * Resolve a schema reference to a full schema
 */
function resolveSchemaRef(ref: ApiSchemaRef, schemaMap: Map<string, ApiSchema>): JSONSchema {
  if (ref.$ref) {
    // Extract schema name from $ref
    const refName = ref.$ref.split('/').pop() || ''
    const resolved = schemaMap.get(refName)

    if (resolved) {
      return {
        type: resolved.type as JSONSchema['type'],
        description: resolved.description,
        properties: resolved.properties as unknown as Record<string, JSONSchema>,
        required: resolved.required,
        items: resolved.items ? resolveSchemaRef(resolved.items, schemaMap) : undefined,
        enum: resolved.enum as (string | number | boolean)[] | undefined
      }
    }
  }

  // Return as-is if not a reference
  const schema: JSONSchema = {
    type: (ref.type as JSONSchema['type']) || 'string'
  }

  if (ref.items) {
    schema.items = resolveSchemaRef(ref.items, schemaMap)
  }

  if (ref.properties) {
    schema.properties = {}
    for (const [key, prop] of Object.entries(ref.properties)) {
      schema.properties[key] = resolveSchemaRef(prop as ApiSchemaRef, schemaMap)
    }
  }

  if (ref.enum) {
    schema.enum = ref.enum as (string | number | boolean)[]
  }

  // Note: format is not included as it's not part of our JSONSchema type
  // but is preserved in the original schema for reference

  return schema
}

/**
 * Generate handler template code
 */
function generateHandlerTemplate(
  endpoint: ApiEndpoint,
  spec: ParsedApiSpec,
  toolName: string,
  includeAuth: boolean,
  baseUrlOverride?: string
): string {
  const baseUrl = baseUrlOverride || spec.servers[0]?.url || 'https://api.example.com'

  const pathParams = endpoint.parameters.filter(p => p.in === 'path')
  const queryParams = endpoint.parameters.filter(p => p.in === 'query')
  const headerParams = endpoint.parameters.filter(p => p.in === 'header')
  const hasBody = !!endpoint.requestBody

  let code = `/**
 * Handler for ${toolName}
 * ${endpoint.method} ${endpoint.path}
 * ${endpoint.summary || ''}
 */
export async function ${toCamelCase(toolName)}Handler(
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<string> {
  const baseUrl = '${baseUrl}'
`

  // Build path with parameters
  if (pathParams.length > 0) {
    code += `
  // Build path with parameters
  let path = '${endpoint.path}'
${pathParams.map(p => `  path = path.replace('{${p.name}}', encodeURIComponent(String(input.${p.name})))`).join('\n')}
`
  } else {
    code += `
  const path = '${endpoint.path}'
`
  }

  // Build query string
  if (queryParams.length > 0) {
    code += `
  // Build query string
  const queryParams = new URLSearchParams()
${queryParams.map(p => `  if (input.${p.name} !== undefined) queryParams.set('${p.name}', String(input.${p.name}))`).join('\n')}
  const queryString = queryParams.toString()
  const url = queryString ? \`\${baseUrl}\${path}?\${queryString}\` : \`\${baseUrl}\${path}\`
`
  } else {
    code += `
  const url = \`\${baseUrl}\${path}\`
`
  }

  // Build headers
  code += `
  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
`

  if (includeAuth && spec.securitySchemes.length > 0) {
    const authScheme = spec.securitySchemes[0]
    if (authScheme.type === 'apiKey') {
      code += `
  // Add API key authentication
  const apiKey = process.env.API_KEY || context.credentials?.apiKey
  if (apiKey) {
    headers['${authScheme.apiKeyName || 'X-API-Key'}'] = apiKey
  }
`
    } else if (authScheme.type === 'http' && authScheme.scheme === 'bearer') {
      code += `
  // Add bearer token authentication
  const token = process.env.API_TOKEN || context.credentials?.token
  if (token) {
    headers['Authorization'] = \`Bearer \${token}\`
  }
`
    }
  }

  if (headerParams.length > 0) {
    code += `
  // Add custom headers
${headerParams.map(p => `  if (input.${p.name} !== undefined) headers['${p.name}'] = String(input.${p.name})`).join('\n')}
`
  }

  // Build request body
  if (hasBody) {
    code += `
  // Build request body
  const body = JSON.stringify(input.body || extractBodyFromInput(input))
`
  }

  // Make the request
  code += `
  try {
    const response = await fetch(url, {
      method: '${endpoint.method}',
      headers,${hasBody ? '\n      body,' : ''}
      signal: context.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      return \`Error: HTTP \${response.status} - \${errorText}\`
    }

    const data = await response.json()
    return JSON.stringify(data, null, 2)
  } catch (error) {
    return \`Error: \${error instanceof Error ? error.message : String(error)}\`
  }
}
`

  if (hasBody) {
    code += `
/**
 * Extract body properties from input (excluding path/query params)
 */
function extractBodyFromInput(input: Record<string, unknown>): Record<string, unknown> {
  const excludeKeys = [${[...pathParams, ...queryParams, ...headerParams].map(p => `'${p.name}'`).join(', ')}]
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!excludeKeys.includes(key)) {
      body[key] = value
    }
  }
  return body
}
`
  }

  return code
}

/**
 * Convert snake_case or kebab-case to camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/[-_](.)/g, (_, c) => c.toUpperCase())
}

/**
 * Generate a complete module with all tools
 */
export function generateToolModule(
  spec: ParsedApiSpec,
  options: ToolGenerationOptions = {}
): string {
  const tools = generateToolsFromSpec(spec, options)

  const code = `/**
 * Auto-generated API tools for ${spec.title}
 * Version: ${spec.version}
 * Generated at: ${new Date().toISOString()}
 *
 * DO NOT EDIT - This file is generated from API documentation
 */

import { NativeToolDefinition } from '../../../types/tool-types'
import { ToolRegistryV2 } from '../../../tools/registry-v2'

interface ToolExecutionContext {
  workingDirectory: string
  timeoutMs: number
  signal?: AbortSignal
  credentials?: {
    apiKey?: string
    token?: string
    username?: string
    password?: string
  }
}

/**
 * All tool definitions
 */
export const toolDefinitions: NativeToolDefinition[] = [
${tools.map(t => `  ${JSON.stringify(t.definition, null, 2).replace(/\n/g, '\n  ')}`).join(',\n')}
]

/**
 * Register all tools with a registry
 */
export function registerTools(
  registry: ToolRegistryV2,
  credentials?: ToolExecutionContext['credentials']
): void {
  const context: Partial<ToolExecutionContext> = { credentials }

${tools.map(t => `  registry.register(
    ${JSON.stringify(t.definition)},
    (input, ctx) => ${toCamelCase(t.definition.name)}Handler(input, { ...ctx, ...context }),
    { dangerous: ${t.isMutating} }
  )`).join('\n\n')}
}

// Handler implementations

${tools.map(t => t.handlerTemplate).join('\n\n')}
`

  return code
}

/**
 * Generate tool definitions only (no handlers)
 */
export function generateToolDefinitionsOnly(
  spec: ParsedApiSpec,
  options: ToolGenerationOptions = {}
): NativeToolDefinition[] {
  const tools = generateToolsFromSpec(spec, options)
  return tools.map(t => t.definition)
}

/**
 * Get summary of generated tools
 */
export function getToolSummary(tools: GeneratedTool[]): {
  total: number
  byMethod: Record<string, number>
  byTag: Record<string, number>
  mutating: number
  readOnly: number
} {
  const byMethod: Record<string, number> = {}
  const byTag: Record<string, number> = {}
  let mutating = 0
  let readOnly = 0

  for (const tool of tools) {
    // Count by method
    byMethod[tool.endpoint.method] = (byMethod[tool.endpoint.method] || 0) + 1

    // Count by tag
    for (const tag of tool.endpoint.tags) {
      byTag[tag] = (byTag[tag] || 0) + 1
    }

    // Count mutating vs read-only
    if (tool.isMutating) {
      mutating++
    } else {
      readOnly++
    }
  }

  return {
    total: tools.length,
    byMethod,
    byTag,
    mutating,
    readOnly
  }
}
