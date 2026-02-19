/**
 * API Documentation Parser
 * Parses OpenAPI, Swagger, and other API documentation formats
 */

import { FetchedDoc, DocContentType } from './doc-fetcher'

/**
 * Parsed API specification
 */
export interface ParsedApiSpec {
  /** Original source URL or identifier */
  source: string

  /** API title */
  title: string

  /** API description */
  description: string

  /** API version */
  version: string

  /** Base URL(s) for the API */
  servers: ApiServer[]

  /** Security schemes available */
  securitySchemes: SecurityScheme[]

  /** Parsed endpoints */
  endpoints: ApiEndpoint[]

  /** Data schemas/models */
  schemas: ApiSchema[]

  /** Tags for organizing endpoints */
  tags: ApiTag[]

  /** Original format */
  format: DocContentType

  /** Parse warnings */
  warnings: string[]
}

export interface ApiServer {
  url: string
  description?: string
  variables?: Record<string, { default: string; enum?: string[]; description?: string }>
}

export interface SecurityScheme {
  name: string
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect'
  description?: string

  // API Key specific
  in?: 'header' | 'query' | 'cookie'
  apiKeyName?: string

  // HTTP specific
  scheme?: string
  bearerFormat?: string

  // OAuth2 specific
  flows?: OAuthFlows
}

export interface OAuthFlows {
  authorizationCode?: {
    authorizationUrl: string
    tokenUrl: string
    scopes: Record<string, string>
  }
  clientCredentials?: {
    tokenUrl: string
    scopes: Record<string, string>
  }
  implicit?: {
    authorizationUrl: string
    scopes: Record<string, string>
  }
}

export interface ApiEndpoint {
  /** Unique identifier for this endpoint */
  id: string

  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'

  /** Path pattern (e.g., /users/{id}) */
  path: string

  /** Operation ID from the spec */
  operationId?: string

  /** Summary/title */
  summary: string

  /** Detailed description */
  description: string

  /** Tags for categorization */
  tags: string[]

  /** Parameters (path, query, header, cookie) */
  parameters: ApiParameter[]

  /** Request body schema */
  requestBody?: ApiRequestBody

  /** Possible responses */
  responses: ApiResponse[]

  /** Security requirements */
  security: string[][]

  /** Whether this endpoint is deprecated */
  deprecated: boolean
}

export interface ApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description: string
  schema: ApiSchemaRef
  example?: unknown
}

export interface ApiRequestBody {
  description: string
  required: boolean
  content: Record<string, { schema: ApiSchemaRef; example?: unknown }>
}

export interface ApiResponse {
  statusCode: string
  description: string
  content?: Record<string, { schema: ApiSchemaRef }>
}

export interface ApiSchema {
  name: string
  description: string
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, ApiSchemaProperty>
  required?: string[]
  items?: ApiSchemaRef
  enum?: unknown[]
  format?: string
  example?: unknown
}

export interface ApiSchemaProperty {
  type: string
  description?: string
  format?: string
  enum?: unknown[]
  items?: ApiSchemaRef
  $ref?: string
  required?: boolean
  example?: unknown
}

export interface ApiSchemaRef {
  type?: string
  $ref?: string
  items?: ApiSchemaRef
  properties?: Record<string, ApiSchemaProperty>
  format?: string
  enum?: unknown[]
}

export interface ApiTag {
  name: string
  description: string
}

/**
 * Parse API documentation
 */
export async function parseApiDoc(doc: FetchedDoc): Promise<ParsedApiSpec> {
  switch (doc.contentType) {
    case 'openapi-json':
      return parseOpenApiJson(doc)
    case 'openapi-yaml':
      return parseOpenApiYaml(doc)
    case 'swagger-json':
      return parseSwaggerJson(doc)
    case 'swagger-yaml':
      return parseSwaggerYaml(doc)
    case 'html':
    case 'markdown':
    case 'text':
      return parseUnstructuredDoc(doc)
    default:
      return parseUnstructuredDoc(doc)
  }
}

/**
 * Parse OpenAPI 3.x JSON
 */
function parseOpenApiJson(doc: FetchedDoc): ParsedApiSpec {
  const warnings: string[] = []

  let spec: OpenApiSpec
  try {
    spec = JSON.parse(doc.content)
  } catch (error) {
    throw new Error(`Failed to parse OpenAPI JSON: ${error}`)
  }

  return parseOpenApiSpec(spec, doc.url, doc.contentType, warnings)
}

/**
 * Parse OpenAPI 3.x YAML
 */
function parseOpenApiYaml(doc: FetchedDoc): ParsedApiSpec {
  const warnings: string[] = []

  // Simple YAML parser for common cases
  const spec = parseSimpleYaml(doc.content) as unknown as OpenApiSpec

  return parseOpenApiSpec(spec, doc.url, doc.contentType, warnings)
}

/**
 * Parse Swagger 2.0 JSON
 */
function parseSwaggerJson(doc: FetchedDoc): ParsedApiSpec {
  const warnings: string[] = []

  let spec: SwaggerSpec
  try {
    spec = JSON.parse(doc.content)
  } catch (error) {
    throw new Error(`Failed to parse Swagger JSON: ${error}`)
  }

  return parseSwaggerSpec(spec, doc.url, doc.contentType, warnings)
}

/**
 * Parse Swagger 2.0 YAML
 */
function parseSwaggerYaml(doc: FetchedDoc): ParsedApiSpec {
  const warnings: string[] = []

  const spec = parseSimpleYaml(doc.content) as unknown as SwaggerSpec

  return parseSwaggerSpec(spec, doc.url, doc.contentType, warnings)
}

/**
 * Parse unstructured documentation (HTML, Markdown, etc.)
 * Uses heuristics to extract API information
 */
function parseUnstructuredDoc(doc: FetchedDoc): ParsedApiSpec {
  const warnings: string[] = ['Unstructured documentation - extracted information may be incomplete']

  const endpoints = extractEndpointsFromText(doc.content)
  const schemas = extractSchemasFromText(doc.content)

  return {
    source: doc.url,
    title: extractTitle(doc.content) || 'Unknown API',
    description: extractDescription(doc.content) || '',
    version: extractVersion(doc.content) || '1.0.0',
    servers: extractServers(doc.content),
    securitySchemes: extractSecurityFromText(doc.content),
    endpoints,
    schemas,
    tags: [],
    format: doc.contentType,
    warnings
  }
}

// OpenAPI 3.x types
interface OpenApiSpec {
  openapi: string
  info: { title: string; description?: string; version: string }
  servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string }> }>
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: {
    schemas?: Record<string, unknown>
    securitySchemes?: Record<string, unknown>
  }
  tags?: Array<{ name: string; description?: string }>
  security?: Array<Record<string, string[]>>
}

interface OpenApiOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: OpenApiParameter[]
  requestBody?: {
    description?: string
    required?: boolean
    content?: Record<string, { schema: unknown; example?: unknown }>
  }
  responses?: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>
  security?: Array<Record<string, string[]>>
  deprecated?: boolean
}

interface OpenApiParameter {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: unknown
  example?: unknown
}

// Swagger 2.0 types
interface SwaggerSpec {
  swagger: string
  info: { title: string; description?: string; version: string }
  host?: string
  basePath?: string
  schemes?: string[]
  paths?: Record<string, Record<string, SwaggerOperation>>
  definitions?: Record<string, unknown>
  securityDefinitions?: Record<string, unknown>
  tags?: Array<{ name: string; description?: string }>
}

interface SwaggerOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: SwaggerParameter[]
  responses?: Record<string, { description: string; schema?: unknown }>
  security?: Array<Record<string, string[]>>
  deprecated?: boolean
}

interface SwaggerParameter {
  name: string
  in: string
  required?: boolean
  description?: string
  type?: string
  schema?: unknown
}

/**
 * Parse OpenAPI 3.x spec
 */
function parseOpenApiSpec(
  spec: OpenApiSpec,
  source: string,
  format: DocContentType,
  warnings: string[]
): ParsedApiSpec {
  const endpoints: ApiEndpoint[] = []
  const schemas: ApiSchema[] = []
  const securitySchemes: SecurityScheme[] = []

  // Parse servers
  const servers: ApiServer[] = (spec.servers || []).map(s => ({
    url: s.url,
    description: s.description,
    variables: s.variables as ApiServer['variables']
  }))

  // Parse security schemes
  if (spec.components?.securitySchemes) {
    for (const [name, scheme] of Object.entries(spec.components.securitySchemes)) {
      const s = scheme as Record<string, unknown>
      securitySchemes.push({
        name,
        type: s.type as SecurityScheme['type'],
        description: s.description as string | undefined,
        in: s.in as 'header' | 'query' | 'cookie' | undefined,
        apiKeyName: s.name as string | undefined,
        scheme: s.scheme as string | undefined,
        bearerFormat: s.bearerFormat as string | undefined,
        flows: s.flows as OAuthFlows | undefined
      })
    }
  }

  // Parse paths/endpoints
  if (spec.paths) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method)) {
          const op = operation as OpenApiOperation
          const endpoint = parseOpenApiEndpoint(path, method, op)
          endpoints.push(endpoint)
        }
      }
    }
  }

  // Parse schemas
  if (spec.components?.schemas) {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      const s = schema as Record<string, unknown>
      schemas.push({
        name,
        description: (s.description as string) || '',
        type: (s.type as ApiSchema['type']) || 'object',
        properties: s.properties as Record<string, ApiSchemaProperty> | undefined,
        required: s.required as string[] | undefined,
        items: s.items as ApiSchemaRef | undefined,
        enum: s.enum as unknown[] | undefined,
        format: s.format as string | undefined,
        example: s.example
      })
    }
  }

  // Parse tags
  const tags: ApiTag[] = (spec.tags || []).map(t => ({
    name: t.name,
    description: t.description || ''
  }))

  return {
    source,
    title: spec.info.title,
    description: spec.info.description || '',
    version: spec.info.version,
    servers,
    securitySchemes,
    endpoints,
    schemas,
    tags,
    format,
    warnings
  }
}

/**
 * Parse a single OpenAPI endpoint
 */
function parseOpenApiEndpoint(path: string, method: string, op: OpenApiOperation): ApiEndpoint {
  const parameters: ApiParameter[] = (op.parameters || []).map(p => ({
    name: p.name,
    in: p.in as 'path' | 'query' | 'header' | 'cookie',
    required: p.required || false,
    description: p.description || '',
    schema: p.schema as ApiSchemaRef || { type: 'string' },
    example: p.example
  }))

  const responses: ApiResponse[] = Object.entries(op.responses || {}).map(([code, res]) => ({
    statusCode: code,
    description: res.description,
    content: res.content as Record<string, { schema: ApiSchemaRef }> | undefined
  }))

  let requestBody: ApiRequestBody | undefined
  if (op.requestBody) {
    requestBody = {
      description: op.requestBody.description || '',
      required: op.requestBody.required || false,
      content: op.requestBody.content as Record<string, { schema: ApiSchemaRef }> || {}
    }
  }

  const security = (op.security || []).map(s => Object.keys(s))

  return {
    id: `${method.toUpperCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    method: method.toUpperCase() as ApiEndpoint['method'],
    path,
    operationId: op.operationId,
    summary: op.summary || '',
    description: op.description || '',
    tags: op.tags || [],
    parameters,
    requestBody,
    responses,
    security,
    deprecated: op.deprecated || false
  }
}

/**
 * Parse Swagger 2.0 spec
 */
function parseSwaggerSpec(
  spec: SwaggerSpec,
  source: string,
  format: DocContentType,
  warnings: string[]
): ParsedApiSpec {
  const endpoints: ApiEndpoint[] = []
  const schemas: ApiSchema[] = []
  const securitySchemes: SecurityScheme[] = []

  // Build server URL from host/basePath/schemes
  const servers: ApiServer[] = []
  if (spec.host) {
    const scheme = (spec.schemes || ['https'])[0]
    servers.push({
      url: `${scheme}://${spec.host}${spec.basePath || ''}`
    })
  }

  // Parse security definitions
  if (spec.securityDefinitions) {
    for (const [name, def] of Object.entries(spec.securityDefinitions)) {
      const d = def as Record<string, unknown>
      securitySchemes.push({
        name,
        type: d.type === 'apiKey' ? 'apiKey' :
              d.type === 'basic' ? 'http' :
              d.type === 'oauth2' ? 'oauth2' : 'apiKey',
        description: d.description as string | undefined,
        in: d.in as 'header' | 'query' | undefined,
        apiKeyName: d.name as string | undefined,
        scheme: d.type === 'basic' ? 'basic' : undefined
      })
    }
  }

  // Parse paths
  if (spec.paths) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          const op = operation as SwaggerOperation
          const endpoint = parseSwaggerEndpoint(path, method, op)
          endpoints.push(endpoint)
        }
      }
    }
  }

  // Parse definitions (schemas)
  if (spec.definitions) {
    for (const [name, schema] of Object.entries(spec.definitions)) {
      const s = schema as Record<string, unknown>
      schemas.push({
        name,
        description: (s.description as string) || '',
        type: (s.type as ApiSchema['type']) || 'object',
        properties: s.properties as Record<string, ApiSchemaProperty> | undefined,
        required: s.required as string[] | undefined,
        items: s.items as ApiSchemaRef | undefined,
        enum: s.enum as unknown[] | undefined,
        format: s.format as string | undefined,
        example: s.example
      })
    }
  }

  const tags: ApiTag[] = (spec.tags || []).map(t => ({
    name: t.name,
    description: t.description || ''
  }))

  return {
    source,
    title: spec.info.title,
    description: spec.info.description || '',
    version: spec.info.version,
    servers,
    securitySchemes,
    endpoints,
    schemas,
    tags,
    format,
    warnings
  }
}

/**
 * Parse a single Swagger endpoint
 */
function parseSwaggerEndpoint(path: string, method: string, op: SwaggerOperation): ApiEndpoint {
  const parameters: ApiParameter[] = []
  let requestBody: ApiRequestBody | undefined

  for (const p of op.parameters || []) {
    if (p.in === 'body') {
      requestBody = {
        description: p.description || '',
        required: p.required || false,
        content: {
          'application/json': {
            schema: p.schema as ApiSchemaRef || { type: 'object' }
          }
        }
      }
    } else {
      parameters.push({
        name: p.name,
        in: p.in as 'path' | 'query' | 'header' | 'cookie',
        required: p.required || false,
        description: p.description || '',
        schema: p.schema as ApiSchemaRef || { type: p.type || 'string' }
      })
    }
  }

  const responses: ApiResponse[] = Object.entries(op.responses || {}).map(([code, res]) => {
    const r = res as { description: string; schema?: unknown }
    return {
      statusCode: code,
      description: r.description,
      content: r.schema ? {
        'application/json': { schema: r.schema as ApiSchemaRef }
      } : undefined
    }
  })

  const security = (op.security || []).map(s => Object.keys(s))

  return {
    id: `${method.toUpperCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    method: method.toUpperCase() as ApiEndpoint['method'],
    path,
    operationId: op.operationId,
    summary: op.summary || '',
    description: op.description || '',
    tags: op.tags || [],
    parameters,
    requestBody,
    responses,
    security,
    deprecated: op.deprecated || false
  }
}

/**
 * Simple YAML parser for common API spec patterns
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  // This is a simplified parser - in production, use a proper YAML library
  const lines = content.split('\n')
  const result: Record<string, unknown> = {}
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }]

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue

    const match = line.match(/^(\s*)([^:]+):\s*(.*)$/)
    if (!match) continue

    const indent = match[1].length
    const key = match[2].trim()
    let value: unknown = match[3].trim()

    // Remove quotes from value
    if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
      value = (value as string).slice(1, -1)
    } else if ((value as string).startsWith("'") && (value as string).endsWith("'")) {
      value = (value as string).slice(1, -1)
    }

    // Pop stack until we find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1].obj

    if (value === '' || value === undefined) {
      // This is a parent object
      const newObj: Record<string, unknown> = {}
      parent[key] = newObj
      stack.push({ indent, obj: newObj })
    } else if (value === 'true') {
      parent[key] = true
    } else if (value === 'false') {
      parent[key] = false
    } else if (!isNaN(Number(value))) {
      parent[key] = Number(value)
    } else {
      parent[key] = value
    }
  }

  return result
}

// Heuristic extraction functions for unstructured docs

function extractTitle(content: string): string | null {
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i) ||
                     content.match(/^#\s+(.+)$/m) ||
                     content.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  return titleMatch ? titleMatch[1].trim() : null
}

function extractDescription(content: string): string | null {
  const descMatch = content.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                    content.match(/^##?\s*(?:Description|About|Overview)\s*\n+([^\n#]+)/im)
  return descMatch ? descMatch[1].trim() : null
}

function extractVersion(content: string): string | null {
  const versionMatch = content.match(/version[:\s]+["']?(\d+\.\d+(?:\.\d+)?)/i) ||
                       content.match(/v(\d+\.\d+(?:\.\d+)?)/i)
  return versionMatch ? versionMatch[1] : null
}

function extractServers(content: string): ApiServer[] {
  const servers: ApiServer[] = []
  const urlMatches = content.matchAll(/(?:base\s*url|api\s*url|endpoint)[:\s]+["']?(https?:\/\/[^\s"'<>]+)/gi)

  for (const match of urlMatches) {
    servers.push({ url: match[1] })
  }

  return servers
}

function extractEndpointsFromText(content: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = []
  const methodPattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+([\/\w\{\}]+)/g

  let match
  let id = 0
  while ((match = methodPattern.exec(content)) !== null) {
    id++
    endpoints.push({
      id: `endpoint_${id}`,
      method: match[1] as ApiEndpoint['method'],
      path: match[2],
      summary: '',
      description: '',
      tags: [],
      parameters: [],
      responses: [],
      security: [],
      deprecated: false
    })
  }

  return endpoints
}

function extractSchemasFromText(_content: string): ApiSchema[] {
  // For unstructured docs, we can't reliably extract schemas
  return []
}

function extractSecurityFromText(content: string): SecurityScheme[] {
  const schemes: SecurityScheme[] = []

  if (/api[_\s]?key/i.test(content)) {
    schemes.push({
      name: 'apiKey',
      type: 'apiKey',
      description: 'API Key authentication',
      in: 'header',
      apiKeyName: 'X-API-Key'
    })
  }

  if (/oauth/i.test(content)) {
    schemes.push({
      name: 'oauth2',
      type: 'oauth2',
      description: 'OAuth 2.0 authentication'
    })
  }

  if (/bearer/i.test(content)) {
    schemes.push({
      name: 'bearer',
      type: 'http',
      scheme: 'bearer',
      description: 'Bearer token authentication'
    })
  }

  if (/basic\s+auth/i.test(content)) {
    schemes.push({
      name: 'basic',
      type: 'http',
      scheme: 'basic',
      description: 'Basic authentication'
    })
  }

  return schemes
}

/**
 * Merge multiple parsed specs into one
 */
export function mergeApiSpecs(specs: ParsedApiSpec[]): ParsedApiSpec {
  if (specs.length === 0) {
    throw new Error('No specs to merge')
  }

  if (specs.length === 1) {
    return specs[0]
  }

  const merged: ParsedApiSpec = {
    source: specs.map(s => s.source).join(', '),
    title: specs[0].title,
    description: specs.map(s => s.description).filter(Boolean).join('\n\n'),
    version: specs[0].version,
    servers: [...new Map(specs.flatMap(s => s.servers).map(s => [s.url, s])).values()],
    securitySchemes: [...new Map(specs.flatMap(s => s.securitySchemes).map(s => [s.name, s])).values()],
    endpoints: specs.flatMap(s => s.endpoints),
    schemas: [...new Map(specs.flatMap(s => s.schemas).map(s => [s.name, s])).values()],
    tags: [...new Map(specs.flatMap(s => s.tags).map(t => [t.name, t])).values()],
    format: specs[0].format,
    warnings: specs.flatMap(s => s.warnings)
  }

  return merged
}
