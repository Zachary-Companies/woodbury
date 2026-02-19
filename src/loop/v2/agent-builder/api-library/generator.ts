/**
 * API Library Generator
 * Generates TypeScript API client libraries following hawksoft-api patterns
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { AgentV2 } from '../../core/agent'
import { ToolRegistryV2 } from '../../tools/registry-v2'
import { NativeToolDefinition, AgentV2Config } from '../../types'
import { ParsedApiSpec, ApiEndpoint, ApiSchema, parseApiDoc } from '../api-discovery/doc-parser'
import { fetchDoc, FetchedDoc } from '../api-discovery/doc-fetcher'
import {
  generatePackageJson,
  generateTsConfig,
  generateJestConfig,
  generateGitignore,
  generateClientClass,
  generateTestFile,
  generateReadme,
  AuthConfig,
  AuthType,
  TypeDef,
  TypeFieldDef,
  EndpointDef,
  QueryParamDef
} from './templates'

/**
 * Logger interface (pino-compatible)
 */
interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void
  debug(msg: string): void
  info(obj: Record<string, unknown>, msg?: string): void
  info(msg: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  warn(msg: string): void
  error(obj: Record<string, unknown>, msg?: string): void
  error(msg: string): void
}

/**
 * Console logger fallback
 */
function createConsoleLogger(): Logger {
  return {
    debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') console.debug(objOrMsg)
      else console.debug(msg || '', objOrMsg)
    },
    info: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') console.info(objOrMsg)
      else console.info(msg || '', objOrMsg)
    },
    warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') console.warn(objOrMsg)
      else console.warn(msg || '', objOrMsg)
    },
    error: (objOrMsg: Record<string, unknown> | string, msg?: string) => {
      if (typeof objOrMsg === 'string') console.error(objOrMsg)
      else console.error(msg || '', objOrMsg)
    }
  }
}

/**
 * Secret definition for tenant config
 */
export interface SecretDefinition {
  /** Key name (e.g., 'clientId', 'apiKey') */
  key: string

  /** Display label (e.g., 'Client ID', 'API Key') */
  label: string

  /** Placeholder text for UI */
  placeholder?: string

  /** Description of the secret */
  description?: string

  /** Category for grouping in UI */
  category: 'llm' | 'email' | 'communication' | 'payment' | 'insurance' | 'other'
}

/**
 * API Library specification
 */
export interface ApiLibrarySpec {
  /** Short name for the API (e.g., 'hawksoft', 'stripe') */
  apiName: string

  /** Human-readable service name (e.g., 'HawkSoft', 'Stripe') */
  serviceName: string

  /** Description of the API */
  description: string

  /** Base URL hostname (without protocol) */
  baseUrl: string

  /** Authentication configuration */
  auth: AuthConfig

  /** API documentation URL or inline content */
  apiDoc?: {
    url?: string
    content?: string
  }

  /** Custom type definitions to include */
  customTypes?: TypeDef[]

  /** Custom endpoints (in addition to auto-discovered) */
  customEndpoints?: EndpointDef[]

  /** Secret definitions for tenant config (auto-generated from auth if not provided) */
  secrets?: SecretDefinition[]

  /** Category for secrets (default: 'other') */
  secretCategory?: SecretDefinition['category']
}

/**
 * Tenant config updates to apply
 */
export interface TenantConfigUpdates {
  /** Code to add to @zachary/secrets SecretKeys */
  secretKeysCode: string

  /** Code to add to @zachary/secrets SecretKeyMetadata */
  secretMetadataCode: string

  /** Code to add to tenant-config-manager IntegrationsSchema */
  integrationsSchemaCode: string

  /** Code to add to tenant-config-manager TenantSecretsSchema */
  tenantSecretsSchemaCode: string

  /** Code to add to tenant-config-manager DEFAULT_INTEGRATIONS */
  defaultIntegrationsCode: string

  /** Secret keys that need to be configured */
  secretKeys: string[]
}

/**
 * Generated API library result
 */
export interface GeneratedApiLibrary {
  /** Full path to generated library */
  path: string

  /** Library name */
  name: string

  /** Files created */
  files: string[]

  /** Types generated */
  types: string[]

  /** Endpoints generated */
  endpoints: string[]

  /** Warnings during generation */
  warnings: string[]

  /** Tenant config updates (code snippets to add) */
  tenantConfigUpdates?: TenantConfigUpdates
}

/**
 * Generation options
 */
export interface ApiLibraryGenerationOptions {
  /** Base directory for creating the library */
  baseDirectory: string

  /** Initialize git repository */
  initGit?: boolean

  /** Create initial commit */
  createInitialCommit?: boolean

  /** Use LLM to analyze API docs and generate types/endpoints */
  useLlmAnalysis?: boolean

  /** LLM model for analysis */
  model?: string

  /** Logger */
  logger?: Logger
}

/**
 * Generate an API client library
 */
export async function generateApiLibrary(
  spec: ApiLibrarySpec,
  options: ApiLibraryGenerationOptions
): Promise<GeneratedApiLibrary> {
  const {
    baseDirectory,
    initGit = true,
    createInitialCommit = true,
    useLlmAnalysis = true,
    model = 'claude-sonnet-4-20250514',
    logger = createConsoleLogger()
  } = options

  const warnings: string[] = []
  const createdFiles: string[] = []

  // Determine library directory name
  const libName = `${spec.apiName}-api`
  const libPath = path.join(baseDirectory, libName)

  logger.info({ libPath }, 'Creating API library')

  // Check if directory already exists
  if (fs.existsSync(libPath)) {
    throw new Error(`Library directory already exists: ${libPath}`)
  }

  // Create directory structure
  fs.mkdirSync(libPath, { recursive: true })
  fs.mkdirSync(path.join(libPath, 'src'), { recursive: true })
  fs.mkdirSync(path.join(libPath, 'src', '__tests__'), { recursive: true })

  // Initialize types and endpoints
  let types: TypeDef[] = spec.customTypes || []
  let endpoints: EndpointDef[] = spec.customEndpoints || []

  // Parse API documentation if provided
  if (spec.apiDoc) {
    try {
      let apiSpec: ParsedApiSpec | null = null

      if (spec.apiDoc.url) {
        logger.info({ url: spec.apiDoc.url }, 'Fetching API documentation')
        const doc = await fetchDoc(spec.apiDoc.url)
        apiSpec = await parseApiDoc(doc)
      } else if (spec.apiDoc.content) {
        // Create a mock FetchedDoc for inline content
        const mockDoc: FetchedDoc = {
          url: 'inline',
          content: spec.apiDoc.content,
          contentType: 'openapi-json',
          statusCode: 200,
          headers: {},
          fetchedAt: Date.now(),
          contentHash: ''
        }
        apiSpec = await parseApiDoc(mockDoc)
      }

      if (apiSpec) {
        // Convert parsed spec to our types and endpoints
        const converted = convertApiSpec(apiSpec)
        types = [...types, ...converted.types]
        endpoints = [...endpoints, ...converted.endpoints]
        logger.info(
          { types: converted.types.length, endpoints: converted.endpoints.length },
          'Parsed API documentation'
        )
      }
    } catch (error) {
      warnings.push(`Failed to parse API documentation: ${error}`)
      logger.warn({ error }, 'Failed to parse API documentation')
    }
  }

  // Use LLM analysis if enabled and we have API docs
  if (useLlmAnalysis && spec.apiDoc && (types.length === 0 || endpoints.length === 0)) {
    try {
      logger.info('Using LLM to analyze API documentation')
      const analyzed = await analyzeApiWithLlm(spec, model, logger)
      if (analyzed.types.length > 0) {
        types = [...types, ...analyzed.types]
      }
      if (analyzed.endpoints.length > 0) {
        endpoints = [...endpoints, ...analyzed.endpoints]
      }
    } catch (error) {
      warnings.push(`LLM analysis failed: ${error}`)
      logger.warn({ error }, 'LLM analysis failed')
    }
  }

  // If still no types/endpoints, create basic defaults
  if (types.length === 0) {
    types = [createDefaultType(spec.serviceName)]
    warnings.push('No types discovered, using default Resource type')
  }

  if (endpoints.length === 0) {
    endpoints = createDefaultEndpoints()
    warnings.push('No endpoints discovered, using default CRUD endpoints')
  }

  // Generate package.json
  const packageJson = generatePackageJson(spec.apiName, spec.serviceName, spec.description)
  fs.writeFileSync(path.join(libPath, 'package.json'), packageJson)
  createdFiles.push('package.json')

  // Generate tsconfig.json
  const tsconfig = generateTsConfig()
  fs.writeFileSync(path.join(libPath, 'tsconfig.json'), tsconfig)
  createdFiles.push('tsconfig.json')

  // Generate jest.config.js
  const jestConfig = generateJestConfig()
  fs.writeFileSync(path.join(libPath, 'jest.config.js'), jestConfig)
  createdFiles.push('jest.config.js')

  // Generate .gitignore
  const gitignore = generateGitignore()
  fs.writeFileSync(path.join(libPath, '.gitignore'), gitignore)
  createdFiles.push('.gitignore')

  // Generate client class
  const clientCode = generateClientClass(
    spec.serviceName,
    spec.baseUrl,
    spec.auth,
    types,
    endpoints
  )
  fs.writeFileSync(path.join(libPath, 'src', 'index.ts'), clientCode)
  createdFiles.push('src/index.ts')

  // Generate test file
  const testCode = generateTestFile(spec.serviceName, endpoints)
  fs.writeFileSync(path.join(libPath, 'src', '__tests__', 'client.test.ts'), testCode)
  createdFiles.push('src/__tests__/client.test.ts')

  // Generate README
  const readme = generateReadme(
    spec.apiName,
    spec.serviceName,
    spec.description,
    spec.auth,
    endpoints
  )
  fs.writeFileSync(path.join(libPath, 'README.md'), readme)
  createdFiles.push('README.md')

  // Initialize git repository
  let gitInitialized = false
  if (initGit) {
    try {
      execSync('git init', { cwd: libPath, stdio: 'pipe' })
      gitInitialized = true

      if (createInitialCommit) {
        execSync('git add -A', { cwd: libPath, stdio: 'pipe' })
        execSync(
          `git commit -m "Initial commit: @zachary/${spec.apiName}-api"`,
          { cwd: libPath, stdio: 'pipe' }
        )
      }
    } catch (error) {
      warnings.push(`Git initialization failed: ${error}`)
    }
  }

  // Generate tenant config updates
  const tenantConfigUpdates = generateTenantConfigUpdates(spec)

  logger.info(
    {
      path: libPath,
      files: createdFiles.length,
      types: types.length,
      endpoints: endpoints.length,
      gitInitialized,
      secretKeys: tenantConfigUpdates.secretKeys
    },
    'API library generated successfully'
  )

  return {
    path: libPath,
    name: `@zachary/${spec.apiName}-api`,
    files: createdFiles,
    types: types.map(t => t.name),
    endpoints: endpoints.map(e => e.name),
    warnings,
    tenantConfigUpdates
  }
}

/**
 * Convert ParsedApiSpec to our types and endpoints
 */
function convertApiSpec(spec: ParsedApiSpec): { types: TypeDef[]; endpoints: EndpointDef[] } {
  const types: TypeDef[] = []
  const endpoints: EndpointDef[] = []

  // Convert schemas to types
  if (spec.schemas) {
    for (const schema of spec.schemas) {
      if (schema.name && schema.properties) {
        // Convert Record<string, ApiSchemaProperty> to array of fields
        const fields: TypeFieldDef[] = Object.entries(schema.properties).map(([name, prop]) => ({
          name,
          type: mapSchemaType(prop.type, prop.format),
          required: schema.required?.includes(name) ?? false,
          description: prop.description
        }))

        types.push({
          name: schema.name,
          description: schema.description,
          fields
        })
      }
    }
  }

  // Convert endpoints
  for (const ep of spec.endpoints) {
    const endpointDef = convertEndpoint(ep, spec.schemas)
    if (endpointDef) {
      endpoints.push(endpointDef)
    }
  }

  return { types, endpoints }
}

/**
 * Convert a single API endpoint
 */
function convertEndpoint(ep: ApiEndpoint, schemas?: ApiSchema[]): EndpointDef | null {
  // Determine method name from operationId or path
  const name = ep.operationId || pathToMethodName(ep.method, ep.path)

  // Extract path parameters
  const pathParams = ep.parameters
    ?.filter(p => p.in === 'path')
    .map(p => p.name)

  // Extract query parameters
  const queryParams: QueryParamDef[] | undefined = ep.parameters
    ?.filter(p => p.in === 'query')
    .map(p => ({
      name: p.name,
      type: mapSchemaType(p.schema?.type || 'string') as 'string' | 'number' | 'boolean',
      required: p.required,
      description: p.description
    }))

  // Determine request type from requestBody
  let requestType: string | undefined
  if (ep.requestBody?.content) {
    const jsonContent = ep.requestBody.content['application/json']
    if (jsonContent?.schema?.$ref) {
      // Extract type name from $ref like "#/components/schemas/CreateUser"
      requestType = jsonContent.schema.$ref.split('/').pop()
    }
  }

  // Determine response type from responses
  let responseType = 'unknown'
  const successResponse = ep.responses.find(r => r.statusCode === '200' || r.statusCode === '201')
  if (successResponse?.content) {
    const jsonContent = successResponse.content['application/json']
    if (jsonContent?.schema?.$ref) {
      responseType = jsonContent.schema.$ref.split('/').pop() || 'unknown'
    } else if (jsonContent?.schema?.type === 'array' && jsonContent.schema.items?.$ref) {
      const itemType = jsonContent.schema.items.$ref.split('/').pop()
      responseType = `${itemType}[]`
    }
  }

  return {
    name,
    method: ep.method.toUpperCase() as EndpointDef['method'],
    path: ep.path,
    description: ep.summary || ep.description || `${ep.method.toUpperCase()} ${ep.path}`,
    requestType,
    responseType,
    pathParams: pathParams?.length ? pathParams : undefined,
    queryParams: queryParams?.length ? queryParams : undefined
  }
}

/**
 * Map OpenAPI schema type to TypeScript type
 */
function mapSchemaType(type?: string, format?: string): string {
  if (!type) return 'unknown'

  switch (type) {
    case 'string':
      if (format === 'date' || format === 'date-time') return 'string'
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'unknown[]'
    case 'object':
      return 'Record<string, unknown>'
    default:
      return 'unknown'
  }
}

/**
 * Generate method name from HTTP method and path
 */
function pathToMethodName(method: string, pathStr: string): string {
  // Remove path parameters and split
  const parts = pathStr
    .replace(/\{[^}]+\}/g, '')
    .split('/')
    .filter(Boolean)

  const resource = parts[parts.length - 1] || 'resource'
  const singular = resource.replace(/s$/, '')

  switch (method.toLowerCase()) {
    case 'get':
      return pathStr.includes('{') ? `get${capitalize(singular)}` : `list${capitalize(resource)}`
    case 'post':
      return `create${capitalize(singular)}`
    case 'put':
    case 'patch':
      return `update${capitalize(singular)}`
    case 'delete':
      return `delete${capitalize(singular)}`
    default:
      return `${method.toLowerCase()}${capitalize(singular)}`
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Create default type when no types discovered
 */
function createDefaultType(serviceName: string): TypeDef {
  return {
    name: 'Resource',
    description: `${serviceName} resource`,
    fields: [
      { name: 'id', type: 'string', required: true, description: 'Unique identifier' },
      { name: 'name', type: 'string', required: true, description: 'Resource name' },
      { name: 'createdAt', type: 'string', required: false, description: 'Creation timestamp' },
      { name: 'updatedAt', type: 'string', required: false, description: 'Last update timestamp' }
    ]
  }
}

/**
 * Create default CRUD endpoints
 */
function createDefaultEndpoints(): EndpointDef[] {
  return [
    {
      name: 'getResource',
      method: 'GET',
      path: '/api/v1/resources/{id}',
      description: 'Get a single resource by ID',
      responseType: 'Resource',
      pathParams: ['id']
    },
    {
      name: 'listResources',
      method: 'GET',
      path: '/api/v1/resources',
      description: 'List all resources',
      responseType: 'Resource[]',
      queryParams: [
        { name: 'limit', type: 'number', required: false, description: 'Maximum results' },
        { name: 'offset', type: 'number', required: false, description: 'Pagination offset' }
      ]
    },
    {
      name: 'createResource',
      method: 'POST',
      path: '/api/v1/resources',
      description: 'Create a new resource',
      requestType: 'Partial<Resource>',
      responseType: 'Resource'
    },
    {
      name: 'updateResource',
      method: 'PUT',
      path: '/api/v1/resources/{id}',
      description: 'Update an existing resource',
      requestType: 'Partial<Resource>',
      responseType: 'Resource',
      pathParams: ['id']
    },
    {
      name: 'deleteResource',
      method: 'DELETE',
      path: '/api/v1/resources/{id}',
      description: 'Delete a resource',
      responseType: 'void',
      pathParams: ['id']
    }
  ]
}

/**
 * Use LLM to analyze API documentation and generate types/endpoints
 */
async function analyzeApiWithLlm(
  spec: ApiLibrarySpec,
  model: string,
  logger: Logger
): Promise<{ types: TypeDef[]; endpoints: EndpointDef[] }> {
  const registry = new ToolRegistryV2(logger)

  let result: { types: TypeDef[]; endpoints: EndpointDef[] } | null = null

  // Register tool for submitting analysis
  const submitAnalysisDefinition: NativeToolDefinition = {
    name: 'submit_api_analysis',
    description: 'Submit the analyzed API types and endpoints',
    input_schema: {
      type: 'object' as const,
      properties: {
        types: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'TypeScript interface name' },
              description: { type: 'string', description: 'Interface description' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', description: 'TypeScript type' },
                    required: { type: 'boolean' },
                    description: { type: 'string' }
                  },
                  required: ['name', 'type']
                }
              }
            },
            required: ['name', 'fields']
          },
          description: 'TypeScript interface definitions'
        },
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Method name (camelCase)' },
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
              path: { type: 'string', description: 'API path with {param} placeholders' },
              description: { type: 'string' },
              requestType: { type: 'string', description: 'TypeScript type for request body' },
              responseType: { type: 'string', description: 'TypeScript type for response' },
              pathParams: { type: 'array', items: { type: 'string' } },
              queryParams: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['string', 'number', 'boolean'] },
                    required: { type: 'boolean' },
                    description: { type: 'string' }
                  },
                  required: ['name', 'type']
                }
              }
            },
            required: ['name', 'method', 'path', 'responseType']
          },
          description: 'API endpoint definitions'
        }
      },
      required: ['types', 'endpoints']
    }
  }

  const submitHandler = async (params: Record<string, unknown>) => {
    result = {
      types: (params.types as TypeDef[]) || [],
      endpoints: (params.endpoints as EndpointDef[]) || []
    }
    return 'Analysis submitted successfully'
  }

  registry.register(submitAnalysisDefinition, submitHandler)

  const systemPrompt = `You are an expert at analyzing API documentation and generating TypeScript type definitions.

Your task is to analyze API documentation and extract:
1. TypeScript interface definitions for all data types
2. API endpoint definitions with correct HTTP methods, paths, and types

Guidelines:
- Use clear, descriptive TypeScript interface names (PascalCase)
- Use appropriate TypeScript types (string, number, boolean, arrays, etc.)
- Mark optional fields appropriately
- Generate descriptive method names (camelCase) for endpoints
- Use path parameters in format: /api/v1/resources/{id}
- Include query parameters where appropriate

When you have analyzed the documentation, use submit_api_analysis to submit your results.`

  const userMessage = `Analyze this API documentation for ${spec.serviceName} and extract types and endpoints:

Service: ${spec.serviceName}
Description: ${spec.description}
Base URL: ${spec.baseUrl}

${spec.apiDoc?.content ? `API Documentation:\n${spec.apiDoc.content.slice(0, 15000)}` : 'No detailed documentation available. Generate reasonable CRUD endpoints.'}

Extract all data types and endpoints, then submit using submit_api_analysis.`

  const agentConfig: AgentV2Config = {
    model,
    systemPrompt,
    maxIterations: 10,
    timeoutMs: 120000,
    humanInTheLoop: false
  }

  const agent = new AgentV2(agentConfig, registry, logger)
  await agent.run(userMessage)

  return result || { types: [], endpoints: [] }
}

/**
 * Generate API library from OpenAPI spec URL
 */
export async function generateApiLibraryFromOpenApi(
  specUrl: string,
  apiName: string,
  serviceName: string,
  auth: AuthConfig,
  options: ApiLibraryGenerationOptions
): Promise<GeneratedApiLibrary> {
  const logger = options.logger || createConsoleLogger()

  logger.info({ specUrl, apiName }, 'Fetching OpenAPI specification')

  const doc = await fetchDoc(specUrl)
  const apiSpec = await parseApiDoc(doc)

  const spec: ApiLibrarySpec = {
    apiName,
    serviceName,
    description: apiSpec.description || `${serviceName} API client library`,
    baseUrl: apiSpec.servers?.[0]?.url?.replace(/^https?:\/\//, '') || 'api.example.com',
    auth,
    apiDoc: { content: doc.content }
  }

  return generateApiLibrary(spec, options)
}

/**
 * Quick start: Generate API library with minimal config
 */
export async function quickGenerateApiLibrary(
  apiName: string,
  serviceName: string,
  baseUrl: string,
  authType: AuthType,
  baseDirectory: string,
  options?: {
    openApiUrl?: string
    model?: string
    logger?: Logger
  }
): Promise<GeneratedApiLibrary> {
  const auth: AuthConfig = { type: authType }

  if (options?.openApiUrl) {
    return generateApiLibraryFromOpenApi(
      options.openApiUrl,
      apiName,
      serviceName,
      auth,
      { baseDirectory, model: options.model, logger: options.logger }
    )
  }

  const spec: ApiLibrarySpec = {
    apiName,
    serviceName,
    description: `${serviceName} API client library`,
    baseUrl,
    auth
  }

  return generateApiLibrary(spec, {
    baseDirectory,
    useLlmAnalysis: false,
    model: options?.model,
    logger: options?.logger
  })
}

/**
 * NPM wrapper library specification
 */
export interface NpmWrapperSpec {
  /** Short name for the API (e.g., 'twilio', 'stripe') */
  apiName: string

  /** Human-readable service name */
  serviceName: string

  /** Description of the API */
  description: string

  /** NPM package to wrap */
  npmPackage: string

  /** Documentation URL */
  docUrl?: string

  /** Authentication configuration */
  auth: AuthConfig

  /** Secret definitions for tenant config */
  secrets?: SecretDefinition[]

  /** Category for secrets */
  secretCategory?: SecretDefinition['category']
}

/**
 * Generate an API library that wraps an existing NPM package
 */
export async function generateNpmWrapperLibrary(
  spec: NpmWrapperSpec,
  options: ApiLibraryGenerationOptions
): Promise<GeneratedApiLibrary> {
  const {
    baseDirectory,
    initGit = true,
    createInitialCommit = true,
    model = 'claude-sonnet-4-20250514',
    logger = createConsoleLogger()
  } = options

  const warnings: string[] = []
  const createdFiles: string[] = []

  // Determine library directory name
  const libName = `${spec.apiName}-api`
  const libPath = path.join(baseDirectory, libName)

  logger.info({ libPath, npmPackage: spec.npmPackage }, 'Creating NPM wrapper library')

  // Check if directory already exists
  if (fs.existsSync(libPath)) {
    throw new Error(`Library directory already exists: ${libPath}`)
  }

  // Create directory structure
  fs.mkdirSync(libPath, { recursive: true })
  fs.mkdirSync(path.join(libPath, 'src'), { recursive: true })
  fs.mkdirSync(path.join(libPath, 'src', '__tests__'), { recursive: true })

  const pascalName = toPascalCase(spec.apiName)

  // Generate package.json with the npm package as a dependency
  const packageJson = generateNpmWrapperPackageJson(spec)
  fs.writeFileSync(path.join(libPath, 'package.json'), packageJson)
  createdFiles.push('package.json')

  // Generate tsconfig.json
  const tsconfig = generateTsConfig()
  fs.writeFileSync(path.join(libPath, 'tsconfig.json'), tsconfig)
  createdFiles.push('tsconfig.json')

  // Generate jest.config.js
  const jestConfig = generateJestConfig()
  fs.writeFileSync(path.join(libPath, 'jest.config.js'), jestConfig)
  createdFiles.push('jest.config.js')

  // Generate .gitignore
  const gitignore = generateGitignore()
  fs.writeFileSync(path.join(libPath, '.gitignore'), gitignore)
  createdFiles.push('.gitignore')

  // Generate wrapper client class
  const clientCode = generateNpmWrapperClient(spec)
  fs.writeFileSync(path.join(libPath, 'src', 'index.ts'), clientCode)
  createdFiles.push('src/index.ts')

  // Generate test file
  const testCode = generateNpmWrapperTest(spec)
  fs.writeFileSync(path.join(libPath, 'src', '__tests__', 'client.test.ts'), testCode)
  createdFiles.push('src/__tests__/client.test.ts')

  // Generate README
  const readme = generateNpmWrapperReadme(spec)
  fs.writeFileSync(path.join(libPath, 'README.md'), readme)
  createdFiles.push('README.md')

  // Initialize git repository
  if (initGit) {
    try {
      execSync('git init', { cwd: libPath, stdio: 'pipe' })

      if (createInitialCommit) {
        execSync('git add -A', { cwd: libPath, stdio: 'pipe' })
        execSync(
          `git commit -m "Initial commit: @zachary/${spec.apiName}-api (wraps ${spec.npmPackage})"`,
          { cwd: libPath, stdio: 'pipe' }
        )
      }
    } catch (error) {
      warnings.push(`Git initialization failed: ${error}`)
    }
  }

  // Generate tenant config updates using the same auth config
  const configSpec: ApiLibrarySpec = {
    apiName: spec.apiName,
    serviceName: spec.serviceName,
    description: spec.description,
    baseUrl: 'n/a',
    auth: spec.auth,
    secrets: spec.secrets,
    secretCategory: spec.secretCategory
  }
  const tenantConfigUpdates = generateTenantConfigUpdates(configSpec)

  logger.info(
    {
      path: libPath,
      files: createdFiles.length,
      npmPackage: spec.npmPackage,
      secretKeys: tenantConfigUpdates.secretKeys
    },
    'NPM wrapper library generated successfully'
  )

  return {
    path: libPath,
    name: `@zachary/${spec.apiName}-api`,
    files: createdFiles,
    types: [pascalName + 'Client', pascalName + 'Config'],
    endpoints: ['Wraps ' + spec.npmPackage],
    warnings,
    tenantConfigUpdates
  }
}

/**
 * Generate package.json for NPM wrapper
 */
function generateNpmWrapperPackageJson(spec: NpmWrapperSpec): string {
  const pkg = {
    name: `@zachary/${spec.apiName}-api`,
    version: '1.0.0',
    description: spec.description,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
      test: 'jest',
      prepublishOnly: 'npm run build'
    },
    dependencies: {
      [spec.npmPackage]: '*'
    },
    devDependencies: {
      '@types/jest': '^29.5.0',
      '@types/node': '^20.0.0',
      jest: '^29.5.0',
      'ts-jest': '^29.1.0',
      typescript: '^5.0.0'
    },
    files: ['dist'],
    publishConfig: {
      access: 'public'
    }
  }
  return JSON.stringify(pkg, null, 2)
}

/**
 * Generate wrapper client class for NPM package
 */
function generateNpmWrapperClient(spec: NpmWrapperSpec): string {
  const pascalName = toPascalCase(spec.apiName)
  const camelName = toCamelCase(spec.apiName)

  // Generate config interface based on auth type
  let configFields = ''
  let configInit = ''

  switch (spec.auth.type) {
    case 'api_key':
      configFields = `  /** API Key */
  apiKey: string`
      configInit = `this.apiKey = config.apiKey`
      break
    case 'oauth2':
      configFields = `  /** OAuth Client ID */
  clientId: string
  /** OAuth Client Secret */
  clientSecret: string`
      configInit = `this.clientId = config.clientId
    this.clientSecret = config.clientSecret`
      break
    case 'bearer':
      configFields = `  /** Bearer Token */
  token: string`
      configInit = `this.token = config.token`
      break
    case 'basic':
      configFields = `  /** Username */
  username: string
  /** Password */
  password: string`
      configInit = `this.username = config.username
    this.password = config.password`
      break
    default:
      configFields = `  /** API Key */
  apiKey: string`
      configInit = `this.apiKey = config.apiKey`
  }

  return `/**
 * ${spec.serviceName} API Client
 * Wraps the ${spec.npmPackage} package
 *
 * @packageDocumentation
 */

// Import the underlying package
// Note: You may need to adjust this import based on the package's export structure
import * as ${camelName}Sdk from '${spec.npmPackage}'

/**
 * Configuration for ${pascalName}Client
 */
export interface ${pascalName}Config {
${configFields}
}

/**
 * ${spec.serviceName} API Client
 *
 * This client wraps the ${spec.npmPackage} package and provides
 * a consistent interface for use in our agent system.
 *
 * @example
 * \`\`\`typescript
 * const client = new ${pascalName}Client({
 *   ${spec.auth.type === 'api_key' ? "apiKey: 'your-api-key'" : spec.auth.type === 'oauth2' ? "clientId: 'id', clientSecret: 'secret'" : spec.auth.type === 'bearer' ? "token: 'your-token'" : "username: 'user', password: 'pass'"}
 * })
 * \`\`\`
 */
export class ${pascalName}Client {
  private config: ${pascalName}Config
  private sdk: typeof ${camelName}Sdk

  constructor(config: ${pascalName}Config) {
    this.config = config
    this.sdk = ${camelName}Sdk
    ${configInit}
  }

  /**
   * Get the underlying SDK instance
   * Use this for direct access to all SDK functionality
   */
  getSdk(): typeof ${camelName}Sdk {
    return this.sdk
  }

  /**
   * Get the current configuration
   */
  getConfig(): ${pascalName}Config {
    return { ...this.config }
  }

  // TODO: Add wrapper methods for common operations
  // The methods below are examples - customize based on the actual SDK

  /**
   * Example method - replace with actual SDK operations
   */
  async healthCheck(): Promise<{ ok: boolean; sdk: string }> {
    return {
      ok: true,
      sdk: '${spec.npmPackage}'
    }
  }
}

// Re-export types from the underlying package for convenience
export { ${camelName}Sdk }
`
}

/**
 * Generate test file for NPM wrapper
 */
function generateNpmWrapperTest(spec: NpmWrapperSpec): string {
  const pascalName = toPascalCase(spec.apiName)

  let configExample = ''
  switch (spec.auth.type) {
    case 'api_key':
      configExample = `{ apiKey: 'test-key' }`
      break
    case 'oauth2':
      configExample = `{ clientId: 'test-id', clientSecret: 'test-secret' }`
      break
    case 'bearer':
      configExample = `{ token: 'test-token' }`
      break
    case 'basic':
      configExample = `{ username: 'test-user', password: 'test-pass' }`
      break
    default:
      configExample = `{ apiKey: 'test-key' }`
  }

  return `import { ${pascalName}Client } from '../index'

describe('${pascalName}Client', () => {
  let client: ${pascalName}Client

  beforeEach(() => {
    client = new ${pascalName}Client(${configExample})
  })

  describe('constructor', () => {
    it('should create a client instance', () => {
      expect(client).toBeInstanceOf(${pascalName}Client)
    })

    it('should store configuration', () => {
      const config = client.getConfig()
      expect(config).toBeDefined()
    })
  })

  describe('getSdk', () => {
    it('should return the underlying SDK', () => {
      const sdk = client.getSdk()
      expect(sdk).toBeDefined()
    })
  })

  describe('healthCheck', () => {
    it('should return ok status', async () => {
      const result = await client.healthCheck()
      expect(result.ok).toBe(true)
      expect(result.sdk).toBe('${spec.npmPackage}')
    })
  })
})
`
}

/**
 * Generate README for NPM wrapper
 */
function generateNpmWrapperReadme(spec: NpmWrapperSpec): string {
  const pascalName = toPascalCase(spec.apiName)

  let configExample = ''
  switch (spec.auth.type) {
    case 'api_key':
      configExample = `{
  apiKey: process.env.${spec.apiName.toUpperCase()}_API_KEY || ''
}`
      break
    case 'oauth2':
      configExample = `{
  clientId: process.env.${spec.apiName.toUpperCase()}_CLIENT_ID || '',
  clientSecret: process.env.${spec.apiName.toUpperCase()}_CLIENT_SECRET || ''
}`
      break
    case 'bearer':
      configExample = `{
  token: process.env.${spec.apiName.toUpperCase()}_TOKEN || ''
}`
      break
    case 'basic':
      configExample = `{
  username: process.env.${spec.apiName.toUpperCase()}_USERNAME || '',
  password: process.env.${spec.apiName.toUpperCase()}_PASSWORD || ''
}`
      break
    default:
      configExample = `{
  apiKey: process.env.${spec.apiName.toUpperCase()}_API_KEY || ''
}`
  }

  return `# @zachary/${spec.apiName}-api

${spec.description}

This package wraps the \`${spec.npmPackage}\` npm package and provides a consistent interface for use in our agent system.

## Installation

\`\`\`bash
npm install @zachary/${spec.apiName}-api
\`\`\`

## Usage

\`\`\`typescript
import { ${pascalName}Client } from '@zachary/${spec.apiName}-api'

const client = new ${pascalName}Client(${configExample})

// Use wrapper methods
const health = await client.healthCheck()

// Or access the underlying SDK directly
const sdk = client.getSdk()
// sdk.someMethod(...)
\`\`\`

## Configuration

| Option | Type | Description |
|--------|------|-------------|
${spec.auth.type === 'api_key' ? '| `apiKey` | `string` | API key for authentication |' : ''}
${spec.auth.type === 'oauth2' ? '| `clientId` | `string` | OAuth 2.0 client ID |\n| `clientSecret` | `string` | OAuth 2.0 client secret |' : ''}
${spec.auth.type === 'bearer' ? '| `token` | `string` | Bearer token for authentication |' : ''}
${spec.auth.type === 'basic' ? '| `username` | `string` | Username for basic auth |\n| `password` | `string` | Password for basic auth |' : ''}

## Underlying Package

This library wraps [\`${spec.npmPackage}\`](https://www.npmjs.com/package/${spec.npmPackage}).
${spec.docUrl ? `\nDocumentation: ${spec.docUrl}` : ''}

## Development

\`\`\`bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
\`\`\`

## License

MIT
`
}

/**
 * Generate tenant config updates for a new API integration
 *
 * This generates code snippets that can be added to:
 * - @zachary/secrets (SecretKeys and SecretKeyMetadata)
 * - tenant-config-manager/packages/shared (IntegrationsSchema, TenantSecretsSchema, DEFAULT_INTEGRATIONS)
 */
function generateTenantConfigUpdates(spec: ApiLibrarySpec): TenantConfigUpdates {
  const secrets = spec.secrets || deriveSecretsFromAuth(spec)
  const upperName = spec.apiName.toUpperCase()
  const pascalName = toPascalCase(spec.apiName)
  const camelName = toCamelCase(spec.apiName)

  // Generate SecretKeys entries
  // e.g., HAWKSOFT_CLIENT_ID: 'Hawksoft_ClientId',
  const secretKeysEntries = secrets.map(s => {
    const keyName = `${upperName}_${toScreamingSnake(s.key)}`
    const keyValue = `${pascalName}_${toPascalCase(s.key)}`
    return `  ${keyName}: '${keyValue}',`
  })
  const secretKeysCode = secretKeysEntries.join('\n')

  // Generate SecretKeyMetadata entries
  // e.g., { key: SecretKeys.HAWKSOFT_CLIENT_ID, label: 'HawkSoft Client ID', ... },
  const secretMetadataEntries = secrets.map(s => {
    const keyName = `${upperName}_${toScreamingSnake(s.key)}`
    const lines = [
      `  {`,
      `    key: SecretKeys.${keyName},`,
      `    label: '${spec.serviceName} ${s.label}',`,
    ]
    if (s.placeholder) {
      lines.push(`    placeholder: '${s.placeholder}',`)
    }
    if (s.description) {
      lines.push(`    description: '${s.description}',`)
    }
    lines.push(`    category: '${s.category}',`)
    lines.push(`  },`)
    return lines.join('\n')
  })
  const secretMetadataCode = secretMetadataEntries.join('\n')

  // Generate IntegrationsSchema entry
  // e.g., hawksoft: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  const integrationsSchemaCode = `  ${camelName}: z.object({ enabled: z.boolean() }).default({ enabled: false }),`

  // Generate TenantSecretsSchema entries
  // e.g., Hawksoft_ClientId: z.string().optional(),
  const tenantSecretsEntries = secrets.map(s => {
    const keyValue = `${pascalName}_${toPascalCase(s.key)}`
    return `  ${keyValue}: z.string().optional(),`
  })
  const tenantSecretsSchemaCode = tenantSecretsEntries.join('\n')

  // Generate DEFAULT_INTEGRATIONS entry
  // e.g., hawksoft: { enabled: false },
  const defaultIntegrationsCode = `  ${camelName}: { enabled: false },`

  // Collect all secret keys
  const secretKeys = secrets.map(s => `${upperName}_${toScreamingSnake(s.key)}`)

  return {
    secretKeysCode,
    secretMetadataCode,
    integrationsSchemaCode,
    tenantSecretsSchemaCode,
    defaultIntegrationsCode,
    secretKeys
  }
}

/**
 * Derive secret definitions from auth configuration
 */
function deriveSecretsFromAuth(spec: ApiLibrarySpec): SecretDefinition[] {
  const category = spec.secretCategory || 'other'
  const secrets: SecretDefinition[] = []

  switch (spec.auth.type) {
    case 'basic':
      secrets.push({
        key: 'username',
        label: 'Username',
        placeholder: 'Enter username',
        description: `${spec.serviceName} API username`,
        category
      })
      secrets.push({
        key: 'password',
        label: 'Password',
        placeholder: 'Enter password',
        description: `${spec.serviceName} API password`,
        category
      })
      break

    case 'bearer':
      secrets.push({
        key: 'apiToken',
        label: 'API Token',
        placeholder: 'Enter API token',
        description: `${spec.serviceName} API bearer token`,
        category
      })
      break

    case 'api_key':
      secrets.push({
        key: 'apiKey',
        label: 'API Key',
        placeholder: 'Enter API key',
        description: `${spec.serviceName} API key`,
        category
      })
      break

    case 'oauth2':
      secrets.push({
        key: 'clientId',
        label: 'Client ID',
        placeholder: 'Enter OAuth client ID',
        description: `${spec.serviceName} OAuth 2.0 client ID`,
        category
      })
      secrets.push({
        key: 'clientSecret',
        label: 'Client Secret',
        placeholder: 'Enter OAuth client secret',
        description: `${spec.serviceName} OAuth 2.0 client secret`,
        category
      })
      break

    default:
      // No secrets for unknown auth types
      break
  }

  return secrets
}

/**
 * Convert string to PascalCase
 */
function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase())
}

/**
 * Convert string to camelCase
 */
function toCamelCase(str: string): string {
  const pascal = toPascalCase(str)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Convert string to SCREAMING_SNAKE_CASE
 */
function toScreamingSnake(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]/g, '_')
    .toUpperCase()
}
