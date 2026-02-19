/**
 * Knowledge Builder
 * Builds RAG knowledge bases from API documentation
 */

import { ParsedApiSpec, ApiEndpoint, ApiSchema } from './doc-parser'

/**
 * Knowledge chunk for RAG
 */
export interface KnowledgeChunk {
  /** Unique ID for this chunk */
  id: string

  /** Content of the chunk */
  content: string

  /** Type of knowledge */
  type: KnowledgeType

  /** Metadata for filtering and context */
  metadata: ChunkMetadata

  /** Related chunks */
  relatedChunks: string[]
}

export type KnowledgeType =
  | 'api_overview'
  | 'endpoint'
  | 'schema'
  | 'authentication'
  | 'example'
  | 'error_handling'
  | 'rate_limiting'
  | 'best_practice'

export interface ChunkMetadata {
  source: string
  apiName: string
  apiVersion: string
  endpointPath?: string
  endpointMethod?: string
  schemaName?: string
  tags?: string[]
  importance: 'high' | 'medium' | 'low'
}

/**
 * Knowledge base configuration
 */
export interface KnowledgeBaseConfig {
  /** Maximum chunk size in characters */
  maxChunkSize?: number

  /** Overlap between chunks */
  chunkOverlap?: number

  /** Include examples in chunks */
  includeExamples?: boolean

  /** Include schemas as separate chunks */
  includeSeparateSchemas?: boolean
}

/**
 * Built knowledge base result
 */
export interface BuiltKnowledge {
  /** All chunks */
  chunks: KnowledgeChunk[]

  /** Summary of the API */
  summary: ApiSummary

  /** Chunk index by type */
  chunksByType: Map<KnowledgeType, KnowledgeChunk[]>

  /** Chunk index by endpoint */
  chunksByEndpoint: Map<string, KnowledgeChunk[]>
}

export interface ApiSummary {
  name: string
  description: string
  version: string
  baseUrls: string[]
  totalEndpoints: number
  endpointsByMethod: Record<string, number>
  authTypes: string[]
  tags: string[]
}

/**
 * Build a knowledge base from a parsed API spec
 */
export function buildKnowledgeBase(
  spec: ParsedApiSpec,
  config: KnowledgeBaseConfig = {}
): BuiltKnowledge {
  const {
    maxChunkSize = 2000,
    includeExamples = true,
    includeSeparateSchemas = true
  } = config

  const chunks: KnowledgeChunk[] = []
  const chunksByType = new Map<KnowledgeType, KnowledgeChunk[]>()
  const chunksByEndpoint = new Map<string, KnowledgeChunk[]>()

  // Generate API overview chunk
  const overviewChunk = generateOverviewChunk(spec)
  chunks.push(overviewChunk)
  addToTypeIndex(chunksByType, 'api_overview', overviewChunk)

  // Generate authentication chunk if auth schemes exist
  if (spec.securitySchemes.length > 0) {
    const authChunk = generateAuthChunk(spec)
    chunks.push(authChunk)
    addToTypeIndex(chunksByType, 'authentication', authChunk)
  }

  // Generate endpoint chunks
  for (const endpoint of spec.endpoints) {
    const endpointChunks = generateEndpointChunks(endpoint, spec, {
      maxChunkSize,
      includeExamples
    })

    for (const chunk of endpointChunks) {
      chunks.push(chunk)
      addToTypeIndex(chunksByType, chunk.type, chunk)
      addToEndpointIndex(chunksByEndpoint, endpoint.id, chunk)
    }
  }

  // Generate schema chunks
  if (includeSeparateSchemas) {
    for (const schema of spec.schemas) {
      const schemaChunk = generateSchemaChunk(schema, spec)
      chunks.push(schemaChunk)
      addToTypeIndex(chunksByType, 'schema', schemaChunk)
    }
  }

  // Link related chunks
  linkRelatedChunks(chunks)

  // Generate summary
  const summary = generateApiSummary(spec)

  return {
    chunks,
    summary,
    chunksByType,
    chunksByEndpoint
  }
}

/**
 * Generate overview chunk for the API
 */
function generateOverviewChunk(spec: ParsedApiSpec): KnowledgeChunk {
  const content = `# ${spec.title}

${spec.description}

## Version
${spec.version}

## Base URLs
${spec.servers.map(s => `- ${s.url}${s.description ? ` (${s.description})` : ''}`).join('\n')}

## Available Operations
${spec.tags.map(t => `- **${t.name}**: ${t.description}`).join('\n') || 'No tags defined'}

## Authentication
${spec.securitySchemes.map(s => `- **${s.name}**: ${s.type}${s.description ? ` - ${s.description}` : ''}`).join('\n') || 'No authentication required'}

## Endpoints Summary
Total: ${spec.endpoints.length} endpoints
- GET: ${spec.endpoints.filter(e => e.method === 'GET').length}
- POST: ${spec.endpoints.filter(e => e.method === 'POST').length}
- PUT: ${spec.endpoints.filter(e => e.method === 'PUT').length}
- PATCH: ${spec.endpoints.filter(e => e.method === 'PATCH').length}
- DELETE: ${spec.endpoints.filter(e => e.method === 'DELETE').length}
`

  return {
    id: `overview_${spec.title.toLowerCase().replace(/\s+/g, '_')}`,
    content,
    type: 'api_overview',
    metadata: {
      source: spec.source,
      apiName: spec.title,
      apiVersion: spec.version,
      importance: 'high'
    },
    relatedChunks: []
  }
}

/**
 * Generate authentication chunk
 */
function generateAuthChunk(spec: ParsedApiSpec): KnowledgeChunk {
  let content = `# Authentication for ${spec.title}\n\n`

  for (const scheme of spec.securitySchemes) {
    content += `## ${scheme.name}\n`
    content += `Type: ${scheme.type}\n`

    if (scheme.description) {
      content += `${scheme.description}\n`
    }

    if (scheme.type === 'apiKey') {
      content += `\n### API Key Configuration\n`
      content += `- Location: ${scheme.in || 'header'}\n`
      content += `- Key name: ${scheme.apiKeyName || 'X-API-Key'}\n`
      content += `\n### Usage Example\n`
      content += '```\n'
      if (scheme.in === 'header') {
        content += `${scheme.apiKeyName || 'X-API-Key'}: your-api-key\n`
      } else if (scheme.in === 'query') {
        content += `?${scheme.apiKeyName || 'api_key'}=your-api-key\n`
      }
      content += '```\n'
    }

    if (scheme.type === 'http') {
      content += `\n### HTTP Authentication\n`
      content += `- Scheme: ${scheme.scheme}\n`
      if (scheme.bearerFormat) {
        content += `- Bearer format: ${scheme.bearerFormat}\n`
      }
      content += `\n### Usage Example\n`
      content += '```\n'
      content += `Authorization: ${scheme.scheme === 'bearer' ? 'Bearer your-token' : 'Basic base64-encoded-credentials'}\n`
      content += '```\n'
    }

    if (scheme.type === 'oauth2' && scheme.flows) {
      content += `\n### OAuth 2.0 Flows\n`
      if (scheme.flows.authorizationCode) {
        content += `\n#### Authorization Code Flow\n`
        content += `- Authorization URL: ${scheme.flows.authorizationCode.authorizationUrl}\n`
        content += `- Token URL: ${scheme.flows.authorizationCode.tokenUrl}\n`
        content += `- Scopes:\n`
        for (const [scope, desc] of Object.entries(scheme.flows.authorizationCode.scopes)) {
          content += `  - \`${scope}\`: ${desc}\n`
        }
      }
      if (scheme.flows.clientCredentials) {
        content += `\n#### Client Credentials Flow\n`
        content += `- Token URL: ${scheme.flows.clientCredentials.tokenUrl}\n`
      }
    }

    content += '\n'
  }

  return {
    id: `auth_${spec.title.toLowerCase().replace(/\s+/g, '_')}`,
    content,
    type: 'authentication',
    metadata: {
      source: spec.source,
      apiName: spec.title,
      apiVersion: spec.version,
      importance: 'high'
    },
    relatedChunks: []
  }
}

/**
 * Generate chunks for an endpoint
 */
function generateEndpointChunks(
  endpoint: ApiEndpoint,
  spec: ParsedApiSpec,
  config: { maxChunkSize: number; includeExamples: boolean }
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []

  // Main endpoint chunk
  let content = `# ${endpoint.method} ${endpoint.path}\n\n`

  if (endpoint.summary) {
    content += `**${endpoint.summary}**\n\n`
  }

  if (endpoint.description) {
    content += `${endpoint.description}\n\n`
  }

  if (endpoint.deprecated) {
    content += `⚠️ **DEPRECATED**: This endpoint is deprecated and may be removed in future versions.\n\n`
  }

  // Parameters
  if (endpoint.parameters.length > 0) {
    content += `## Parameters\n\n`

    const pathParams = endpoint.parameters.filter(p => p.in === 'path')
    const queryParams = endpoint.parameters.filter(p => p.in === 'query')
    const headerParams = endpoint.parameters.filter(p => p.in === 'header')

    if (pathParams.length > 0) {
      content += `### Path Parameters\n`
      for (const param of pathParams) {
        content += `- **${param.name}** (required): ${param.description || 'No description'}\n`
      }
      content += '\n'
    }

    if (queryParams.length > 0) {
      content += `### Query Parameters\n`
      for (const param of queryParams) {
        const required = param.required ? '(required)' : '(optional)'
        content += `- **${param.name}** ${required}: ${param.description || 'No description'}\n`
      }
      content += '\n'
    }

    if (headerParams.length > 0) {
      content += `### Header Parameters\n`
      for (const param of headerParams) {
        const required = param.required ? '(required)' : '(optional)'
        content += `- **${param.name}** ${required}: ${param.description || 'No description'}\n`
      }
      content += '\n'
    }
  }

  // Request body
  if (endpoint.requestBody) {
    content += `## Request Body\n\n`
    content += `${endpoint.requestBody.description || 'Request body required'}\n`
    content += `Required: ${endpoint.requestBody.required ? 'Yes' : 'No'}\n\n`

    for (const [contentType, details] of Object.entries(endpoint.requestBody.content)) {
      content += `Content-Type: \`${contentType}\`\n`
      if (details.example) {
        content += `\n### Example\n\`\`\`json\n${JSON.stringify(details.example, null, 2)}\n\`\`\`\n`
      }
    }
    content += '\n'
  }

  // Responses
  content += `## Responses\n\n`
  for (const response of endpoint.responses) {
    content += `### ${response.statusCode}\n`
    content += `${response.description}\n\n`
  }

  // Security
  if (endpoint.security.length > 0) {
    content += `## Security\n`
    content += `Required authentication: ${endpoint.security.flat().join(', ')}\n\n`
  }

  // Tags
  if (endpoint.tags.length > 0) {
    content += `## Tags\n`
    content += endpoint.tags.map(t => `- ${t}`).join('\n') + '\n'
  }

  const mainChunk: KnowledgeChunk = {
    id: `endpoint_${endpoint.id}`,
    content,
    type: 'endpoint',
    metadata: {
      source: spec.source,
      apiName: spec.title,
      apiVersion: spec.version,
      endpointPath: endpoint.path,
      endpointMethod: endpoint.method,
      tags: endpoint.tags,
      importance: 'high'
    },
    relatedChunks: []
  }

  chunks.push(mainChunk)

  // Generate example chunks if needed
  if (config.includeExamples) {
    const exampleChunk = generateEndpointExampleChunk(endpoint, spec)
    if (exampleChunk) {
      chunks.push(exampleChunk)
    }
  }

  return chunks
}

/**
 * Generate example chunk for an endpoint
 */
function generateEndpointExampleChunk(
  endpoint: ApiEndpoint,
  spec: ParsedApiSpec
): KnowledgeChunk | null {
  const baseUrl = spec.servers[0]?.url || 'https://api.example.com'

  let content = `# Example: ${endpoint.method} ${endpoint.path}\n\n`
  content += `## cURL Example\n\n`
  content += '```bash\n'
  content += `curl -X ${endpoint.method} "${baseUrl}${endpoint.path}"`

  // Add headers
  content += ` \\\n  -H "Content-Type: application/json"`

  if (endpoint.security.length > 0) {
    content += ` \\\n  -H "Authorization: Bearer YOUR_TOKEN"`
  }

  // Add body for POST/PUT/PATCH
  if (endpoint.requestBody && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    const jsonContent = endpoint.requestBody.content['application/json']
    if (jsonContent?.example) {
      content += ` \\\n  -d '${JSON.stringify(jsonContent.example)}'`
    } else {
      content += ` \\\n  -d '{ "example": "data" }'`
    }
  }

  content += '\n```\n\n'

  // JavaScript/fetch example
  content += `## JavaScript Example\n\n`
  content += '```javascript\n'
  content += `const response = await fetch('${baseUrl}${endpoint.path}', {\n`
  content += `  method: '${endpoint.method}',\n`
  content += `  headers: {\n`
  content += `    'Content-Type': 'application/json',\n`
  if (endpoint.security.length > 0) {
    content += `    'Authorization': 'Bearer YOUR_TOKEN'\n`
  }
  content += `  }`

  if (endpoint.requestBody && ['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
    content += `,\n  body: JSON.stringify({\n    // your data here\n  })`
  }

  content += `\n});\n\n`
  content += `const data = await response.json();\n`
  content += '```\n'

  return {
    id: `example_${endpoint.id}`,
    content,
    type: 'example',
    metadata: {
      source: spec.source,
      apiName: spec.title,
      apiVersion: spec.version,
      endpointPath: endpoint.path,
      endpointMethod: endpoint.method,
      importance: 'medium'
    },
    relatedChunks: [`endpoint_${endpoint.id}`]
  }
}

/**
 * Generate chunk for a schema
 */
function generateSchemaChunk(schema: ApiSchema, spec: ParsedApiSpec): KnowledgeChunk {
  let content = `# Schema: ${schema.name}\n\n`

  if (schema.description) {
    content += `${schema.description}\n\n`
  }

  content += `Type: \`${schema.type}\`\n\n`

  if (schema.properties) {
    content += `## Properties\n\n`
    for (const [propName, prop] of Object.entries(schema.properties)) {
      const required = schema.required?.includes(propName) ? '(required)' : '(optional)'
      content += `### ${propName} ${required}\n`
      content += `- Type: \`${prop.type}\`\n`
      if (prop.description) {
        content += `- Description: ${prop.description}\n`
      }
      if (prop.format) {
        content += `- Format: \`${prop.format}\`\n`
      }
      if (prop.enum) {
        content += `- Allowed values: ${prop.enum.map(e => `\`${e}\``).join(', ')}\n`
      }
      content += '\n'
    }
  }

  if (schema.enum) {
    content += `## Allowed Values\n`
    content += schema.enum.map(e => `- \`${e}\``).join('\n') + '\n\n'
  }

  if (schema.example) {
    content += `## Example\n\`\`\`json\n${JSON.stringify(schema.example, null, 2)}\n\`\`\`\n`
  }

  return {
    id: `schema_${schema.name.toLowerCase().replace(/\s+/g, '_')}`,
    content,
    type: 'schema',
    metadata: {
      source: spec.source,
      apiName: spec.title,
      apiVersion: spec.version,
      schemaName: schema.name,
      importance: 'medium'
    },
    relatedChunks: []
  }
}

/**
 * Link related chunks together
 */
function linkRelatedChunks(chunks: KnowledgeChunk[]): void {
  // Link endpoints to their schemas
  const schemaChunks = chunks.filter(c => c.type === 'schema')
  const endpointChunks = chunks.filter(c => c.type === 'endpoint')

  for (const endpoint of endpointChunks) {
    // Find schemas mentioned in endpoint content
    for (const schema of schemaChunks) {
      if (endpoint.content.includes(schema.metadata.schemaName || '')) {
        endpoint.relatedChunks.push(schema.id)
        schema.relatedChunks.push(endpoint.id)
      }
    }
  }

  // Link examples to their endpoints
  const exampleChunks = chunks.filter(c => c.type === 'example')
  for (const example of exampleChunks) {
    // Already linked in generation, but ensure bidirectional
    for (const relatedId of example.relatedChunks) {
      const related = chunks.find(c => c.id === relatedId)
      if (related && !related.relatedChunks.includes(example.id)) {
        related.relatedChunks.push(example.id)
      }
    }
  }

  // Link auth to all endpoints that require it
  const authChunk = chunks.find(c => c.type === 'authentication')
  if (authChunk) {
    for (const endpoint of endpointChunks) {
      if (endpoint.content.includes('Security') || endpoint.content.includes('authentication')) {
        authChunk.relatedChunks.push(endpoint.id)
      }
    }
  }
}

/**
 * Generate API summary
 */
function generateApiSummary(spec: ParsedApiSpec): ApiSummary {
  const endpointsByMethod: Record<string, number> = {}

  for (const endpoint of spec.endpoints) {
    endpointsByMethod[endpoint.method] = (endpointsByMethod[endpoint.method] || 0) + 1
  }

  return {
    name: spec.title,
    description: spec.description,
    version: spec.version,
    baseUrls: spec.servers.map(s => s.url),
    totalEndpoints: spec.endpoints.length,
    endpointsByMethod,
    authTypes: spec.securitySchemes.map(s => s.type),
    tags: spec.tags.map(t => t.name)
  }
}

/**
 * Add chunk to type index
 */
function addToTypeIndex(
  index: Map<KnowledgeType, KnowledgeChunk[]>,
  type: KnowledgeType,
  chunk: KnowledgeChunk
): void {
  const existing = index.get(type) || []
  existing.push(chunk)
  index.set(type, existing)
}

/**
 * Add chunk to endpoint index
 */
function addToEndpointIndex(
  index: Map<string, KnowledgeChunk[]>,
  endpointId: string,
  chunk: KnowledgeChunk
): void {
  const existing = index.get(endpointId) || []
  existing.push(chunk)
  index.set(endpointId, existing)
}

/**
 * Export knowledge to a format suitable for RAG indexing
 */
export function exportForRAG(knowledge: BuiltKnowledge): {
  documents: Array<{ id: string; content: string; metadata: Record<string, unknown> }>
  summary: ApiSummary
} {
  return {
    documents: knowledge.chunks.map(chunk => ({
      id: chunk.id,
      content: chunk.content,
      metadata: {
        ...chunk.metadata,
        type: chunk.type,
        relatedChunks: chunk.relatedChunks
      }
    })),
    summary: knowledge.summary
  }
}

/**
 * Search knowledge chunks by content
 */
export function searchKnowledge(
  knowledge: BuiltKnowledge,
  query: string,
  options: {
    types?: KnowledgeType[]
    limit?: number
  } = {}
): KnowledgeChunk[] {
  const { types, limit = 10 } = options
  const queryLower = query.toLowerCase()

  let chunks = knowledge.chunks

  // Filter by type if specified
  if (types && types.length > 0) {
    chunks = chunks.filter(c => types.includes(c.type))
  }

  // Simple keyword matching (in production, use embeddings)
  const scored = chunks.map(chunk => {
    const contentLower = chunk.content.toLowerCase()
    const words = queryLower.split(/\s+/)
    const matchCount = words.filter(w => contentLower.includes(w)).length
    const score = matchCount / words.length

    // Boost by importance
    const importanceBoost = chunk.metadata.importance === 'high' ? 1.2 :
                            chunk.metadata.importance === 'medium' ? 1.0 : 0.8

    return { chunk, score: score * importanceBoost }
  })

  // Sort by score and return top results
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.chunk)
}
