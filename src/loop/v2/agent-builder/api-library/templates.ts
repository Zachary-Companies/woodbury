/**
 * API Library Templates
 * Templates for generating TypeScript API client libraries following hawksoft-api patterns
 */

/**
 * Package.json template
 */
export function generatePackageJson(
  apiName: string,
  serviceName: string,
  description: string
): string {
  const pkg = {
    name: `@zachary/${apiName}-api`,
    version: '1.0.0',
    description: `${serviceName} API client library`,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js'
      }
    },
    scripts: {
      build: 'tsc',
      clean: 'rimraf dist',
      test: 'jest',
      'test:watch': 'jest --watch',
      'test:coverage': 'jest --coverage',
      prepare: 'npm run build',
      ppp: 'npm run clean && npm run build && npm test && npm version patch && npm publish'
    },
    keywords: [apiName, 'api', 'client'],
    author: 'Zachary',
    license: 'MIT',
    devDependencies: {
      '@types/jest': '^29.5.0',
      '@types/node': '^22.0.0',
      jest: '^29.7.0',
      rimraf: '^6.0.1',
      'ts-jest': '^29.2.0',
      'ts-node': '^10.9.0',
      typescript: '^5.6.0'
    },
    files: ['dist/**/*'],
    engines: { node: '>=18.0.0' },
    publishConfig: { access: 'public' }
  }

  return JSON.stringify(pkg, null, 2)
}

/**
 * TypeScript configuration template
 */
export function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      declaration: true,
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      noImplicitReturns: true,
      inlineSourceMap: true,
      inlineSources: true,
      outDir: './dist',
      rootDir: './src',
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist', '**/*.test.ts']
  }

  return JSON.stringify(config, null, 2)
}

/**
 * Jest configuration template
 */
export function generateJestConfig(): string {
  return `module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**'
  ]
};
`
}

/**
 * .gitignore template
 */
export function generateGitignore(): string {
  return `# Dependencies
node_modules/

# Build output
dist/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test coverage
coverage/
`
}

/**
 * Authentication types
 */
export type AuthType = 'basic' | 'bearer' | 'oauth2' | 'api_key'

export interface AuthConfig {
  type: AuthType
  headerName?: string // For api_key: custom header name
  tokenUrl?: string // For oauth2: token endpoint
}

/**
 * Endpoint definition
 */
export interface EndpointDef {
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  description: string
  requestType?: string // TypeScript interface name for request body
  responseType: string // TypeScript interface name for response
  pathParams?: string[] // Parameters in the path (e.g., id)
  queryParams?: QueryParamDef[]
  requiresAuth?: boolean
}

export interface QueryParamDef {
  name: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
}

/**
 * Type definition for interfaces
 */
export interface TypeDef {
  name: string
  description?: string
  fields: TypeFieldDef[]
}

export interface TypeFieldDef {
  name: string
  type: string
  required?: boolean
  description?: string
}

/**
 * Generate client class code
 */
export function generateClientClass(
  serviceName: string,
  baseUrl: string,
  auth: AuthConfig,
  types: TypeDef[],
  endpoints: EndpointDef[]
): string {
  const className = `${serviceName}Client`
  const configName = `${serviceName}Config`

  const code = `/**
 * ${serviceName} API Client
 * Auto-generated TypeScript client library
 */

import * as https from 'https';

// ============================================
// CONFIGURATION
// ============================================

export interface ${configName} {
${generateConfigFields(auth)}
  baseUrl?: string;
}

// ============================================
// TYPE DEFINITIONS
// ============================================

${types.map(t => generateTypeInterface(t)).join('\n\n')}

// ============================================
// CLIENT CLASS
// ============================================

export class ${className} {
  private readonly baseUrl: string;
${generateAuthFields(auth)}

  constructor(config: ${configName}) {
    this.baseUrl = config.baseUrl || '${baseUrl}';
${generateAuthInit(auth)}
  }

  // ============================================
  // PRIVATE HTTP METHODS
  // ============================================

${generateRequestMethod(auth)}

${generateBinaryRequestMethod(auth)}

  // ============================================
  // PUBLIC API METHODS
  // ============================================

${endpoints.map(e => generateEndpointMethod(e)).join('\n\n')}
}

// ============================================
// EXPORTS
// ============================================

export default ${className};
`

  return code
}

function generateConfigFields(auth: AuthConfig): string {
  switch (auth.type) {
    case 'basic':
      return `  clientId: string;
  clientSecret: string;`
    case 'bearer':
      return `  apiKey: string;`
    case 'oauth2':
      return `  clientId: string;
  clientSecret: string;`
    case 'api_key':
      return `  apiKey: string;`
    default:
      return `  apiKey: string;`
  }
}

function generateAuthFields(auth: AuthConfig): string {
  switch (auth.type) {
    case 'basic':
      return `  private readonly auth: string;`
    case 'bearer':
      return `  private readonly token: string;`
    case 'oauth2':
      return `  private readonly clientId: string;
  private readonly clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;`
    case 'api_key':
      return `  private readonly apiKey: string;`
    default:
      return `  private readonly apiKey: string;`
  }
}

function generateAuthInit(auth: AuthConfig): string {
  switch (auth.type) {
    case 'basic':
      return `    this.auth = Buffer.from(\`\${config.clientId}:\${config.clientSecret}\`).toString('base64');`
    case 'bearer':
      return `    this.token = config.apiKey;`
    case 'oauth2':
      return `    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;`
    case 'api_key':
      return `    this.apiKey = config.apiKey;`
    default:
      return `    this.apiKey = config.apiKey;`
  }
}

function getAuthHeader(auth: AuthConfig): string {
  switch (auth.type) {
    case 'basic':
      return `'Authorization': \`Basic \${this.auth}\``
    case 'bearer':
      return `'Authorization': \`Bearer \${this.token}\``
    case 'oauth2':
      return `'Authorization': \`Bearer \${await this.ensureToken()}\``
    case 'api_key':
      return `'${auth.headerName || 'X-API-Key'}': this.apiKey`
    default:
      return `'Authorization': \`Bearer \${this.apiKey}\``
  }
}

function generateRequestMethod(auth: AuthConfig): string {
  const isOAuth = auth.type === 'oauth2'
  const asyncPrefix = isOAuth ? 'async ' : ''
  const awaitToken = isOAuth ? 'await this.ensureToken()' : ''

  let oauthEnsureMethod = ''
  if (isOAuth) {
    oauthEnsureMethod = `
  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await this.requestWithoutAuth<{ access_token: string; expires_in: number }>(
      'POST',
      '${auth.tokenUrl || '/oauth/token'}',
      {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }
    );

    this.accessToken = response.access_token;
    this.tokenExpiry = Date.now() + (response.expires_in * 1000) - 60000;
    return this.accessToken;
  }

  private requestWithoutAuth<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: this.baseUrl,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(\`HTTP \${res.statusCode}: \${data}\`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(\`Failed to parse response: \${data}\`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

`
  }

  return `${oauthEnsureMethod}  private ${asyncPrefix}request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    return new Promise(${isOAuth ? 'async ' : ''}(resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: this.baseUrl,
        path,
        method,
        headers: {
          ${getAuthHeader(auth)},
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new Error('Unauthorized: Invalid credentials'));
            return;
          }
          if (res.statusCode === 403) {
            reject(new Error('Forbidden: Insufficient permissions'));
            return;
          }
          if (res.statusCode === 404) {
            reject(new Error(\`Not found: \${path}\`));
            return;
          }
          if (res.statusCode === 429) {
            reject(new Error('Rate limited: Too many requests'));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(\`HTTP \${res.statusCode}: \${data}\`));
            return;
          }

          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(\`Failed to parse response: \${data}\`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }`
}

function generateBinaryRequestMethod(auth: AuthConfig): string {
  return `
  private requestBinary<T>(
    method: string,
    path: string,
    body: Buffer,
    extraHeaders: Record<string, string>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: this.baseUrl,
        path,
        method,
        headers: {
          ${getAuthHeader(auth)},
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          ...extraHeaders,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(\`HTTP \${res.statusCode}: \${data}\`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(undefined as T);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }`
}

function generateTypeInterface(typeDef: TypeDef): string {
  const lines = [
    typeDef.description ? `/** ${typeDef.description} */` : null,
    `export interface ${typeDef.name} {`
  ].filter(Boolean)

  for (const field of typeDef.fields) {
    const optional = field.required === false ? '?' : ''
    const desc = field.description ? `  /** ${field.description} */\n` : ''
    lines.push(`${desc}  ${field.name}${optional}: ${field.type};`)
  }

  lines.push('}')
  return lines.join('\n')
}

function generateEndpointMethod(endpoint: EndpointDef): string {
  const methodName = endpoint.name
  const params: string[] = []
  const pathParamReplacements: string[] = []

  // Add path parameters
  if (endpoint.pathParams) {
    for (const param of endpoint.pathParams) {
      params.push(`${param}: string`)
      pathParamReplacements.push(`\${${param}}`)
    }
  }

  // Add request body
  if (endpoint.requestType) {
    params.push(`data: ${endpoint.requestType}`)
  }

  // Add query params as options object
  if (endpoint.queryParams && endpoint.queryParams.length > 0) {
    const optionsType = endpoint.queryParams
      .map(q => `${q.name}${q.required ? '' : '?'}: ${q.type}`)
      .join('; ')
    params.push(`options?: { ${optionsType} }`)
  }

  // Build the path
  let pathExpr = endpoint.path
  if (endpoint.pathParams) {
    for (const param of endpoint.pathParams) {
      pathExpr = pathExpr.replace(`{${param}}`, `\${${param}}`)
    }
  }

  // Build query string handling
  let queryHandling = ''
  if (endpoint.queryParams && endpoint.queryParams.length > 0) {
    queryHandling = `
    const params = new URLSearchParams();
${endpoint.queryParams.map(q => `    if (options?.${q.name} !== undefined) params.set('${q.name}', String(options.${q.name}));`).join('\n')}
    const query = params.toString();
    const fullPath = query ? \`${pathExpr}?\${query}\` : \`${pathExpr}\`;`
  }

  const pathVar = queryHandling ? 'fullPath' : `\`${pathExpr}\``
  const bodyArg = endpoint.requestType ? ', data' : ''

  return `  /**
   * ${endpoint.description}
   */
  async ${methodName}(${params.join(', ')}): Promise<${endpoint.responseType}> {${queryHandling}
    return this.request<${endpoint.responseType}>('${endpoint.method}', ${pathVar}${bodyArg});
  }`
}

/**
 * Generate test file
 */
export function generateTestFile(
  serviceName: string,
  endpoints: EndpointDef[]
): string {
  const className = `${serviceName}Client`

  return `import { EventEmitter } from 'events';
import * as https from 'https';
import { ${className} } from '../index';

jest.mock('https');
const mockedHttps = jest.mocked(https);

function createMockRequest(statusCode: number, body: unknown) {
  const mockResponse = new EventEmitter() as any;
  mockResponse.statusCode = statusCode;

  const mockReq = new EventEmitter() as any;
  mockReq.write = jest.fn();
  mockReq.end = jest.fn(() => {
    process.nextTick(() => {
      mockResponse.emit('data', JSON.stringify(body));
      mockResponse.emit('end');
    });
  });

  (mockedHttps.request as jest.Mock).mockImplementation((_options, callback) => {
    process.nextTick(() => callback(mockResponse));
    return mockReq;
  });

  return mockReq;
}

describe('${className}', () => {
  let client: ${className};

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ${className}({
      clientId: 'test-id',
      clientSecret: 'test-secret',
    });
  });

${endpoints.slice(0, 3).map(e => generateEndpointTest(e)).join('\n\n')}

  describe('error handling', () => {
    it('should handle 401 errors', async () => {
      createMockRequest(401, { error: 'Unauthorized' });
      await expect(client.${endpoints[0]?.name || 'getResource'}(${getTestArgs(endpoints[0])}))
        .rejects.toThrow('Unauthorized');
    });

    it('should handle 404 errors', async () => {
      createMockRequest(404, { error: 'Not found' });
      await expect(client.${endpoints[0]?.name || 'getResource'}(${getTestArgs(endpoints[0])}))
        .rejects.toThrow('Not found');
    });

    it('should handle 429 rate limit errors', async () => {
      createMockRequest(429, { error: 'Too many requests' });
      await expect(client.${endpoints[0]?.name || 'getResource'}(${getTestArgs(endpoints[0])}))
        .rejects.toThrow('Rate limited');
    });
  });
});
`
}

/**
 * Helper to generate test arguments for an endpoint
 */
function getTestArgs(endpoint?: EndpointDef): string {
  if (!endpoint) return `'123'`

  const argParts: string[] = []
  if (endpoint.pathParams && endpoint.pathParams.length > 0) {
    argParts.push(`'123'`)
  }
  if (endpoint.requestType) {
    argParts.push(`{ name: 'Test' }`)
  }
  return argParts.join(', ') || ''
}

function generateEndpointTest(endpoint: EndpointDef): string {
  const mockData = endpoint.method === 'GET' ? '{ id: "123", name: "Test" }' : '{ success: true }'
  const statusCode = endpoint.method === 'POST' ? 201 : 200

  const args = getTestArgs(endpoint)

  return `  describe('${endpoint.name}', () => {
    it('should ${endpoint.description.toLowerCase()}', async () => {
      const mockData = ${mockData};
      createMockRequest(${statusCode}, mockData);

      const result = await client.${endpoint.name}(${args});

      expect(result).toEqual(mockData);
      expect(mockedHttps.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: '${endpoint.method}',
        }),
        expect.any(Function)
      );
    });

    it('should include authorization header', async () => {
      createMockRequest(200, {});
      await client.${endpoint.name}(${args});

      expect(mockedHttps.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.any(String),
          }),
        }),
        expect.any(Function)
      );
    });
  });`
}

/**
 * Generate README
 */
export function generateReadme(
  apiName: string,
  serviceName: string,
  description: string,
  auth: AuthConfig,
  endpoints: EndpointDef[]
): string {
  const className = `${serviceName}Client`
  const configFields = getReadmeConfigFields(auth)

  return `# @zachary/${apiName}-api

${description}

## Installation

\`\`\`bash
npm install @zachary/${apiName}-api
\`\`\`

## Quick Start

\`\`\`typescript
import { ${className} } from '@zachary/${apiName}-api';

const client = new ${className}({
${configFields.map(f => `  ${f.name}: process.env.${f.env}!,`).join('\n')}
});

${generateQuickStartExamples(endpoints)}
\`\`\`

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
${configFields.map(f => `| \`${f.name}\` | Yes | ${f.description} |`).join('\n')}
| \`baseUrl\` | No | Override API base URL |

## API Reference

${endpoints.map(e => generateEndpointDoc(e)).join('\n\n')}

## Environment Variables

| Variable | Description |
|----------|-------------|
${configFields.map(f => `| \`${f.env}\` | ${f.description} |`).join('\n')}

## Development

\`\`\`bash
npm install
npm test
npm run build
\`\`\`

## License

MIT
`
}

interface ConfigField {
  name: string
  env: string
  description: string
}

function getReadmeConfigFields(auth: AuthConfig): ConfigField[] {
  switch (auth.type) {
    case 'basic':
      return [
        { name: 'clientId', env: 'SERVICE_CLIENT_ID', description: 'API client ID' },
        { name: 'clientSecret', env: 'SERVICE_CLIENT_SECRET', description: 'API client secret' }
      ]
    case 'bearer':
    case 'api_key':
      return [
        { name: 'apiKey', env: 'SERVICE_API_KEY', description: 'API key' }
      ]
    case 'oauth2':
      return [
        { name: 'clientId', env: 'SERVICE_CLIENT_ID', description: 'OAuth client ID' },
        { name: 'clientSecret', env: 'SERVICE_CLIENT_SECRET', description: 'OAuth client secret' }
      ]
    default:
      return [
        { name: 'apiKey', env: 'SERVICE_API_KEY', description: 'API key' }
      ]
  }
}

function generateQuickStartExamples(endpoints: EndpointDef[]): string {
  const examples: string[] = []

  const getEndpoint = endpoints.find(e => e.method === 'GET' && e.pathParams?.length)
  if (getEndpoint) {
    examples.push(`// ${getEndpoint.description}
const item = await client.${getEndpoint.name}('123');`)
  }

  const listEndpoint = endpoints.find(e => e.method === 'GET' && !e.pathParams?.length)
  if (listEndpoint) {
    examples.push(`// ${listEndpoint.description}
const items = await client.${listEndpoint.name}();`)
  }

  const createEndpoint = endpoints.find(e => e.method === 'POST')
  if (createEndpoint) {
    examples.push(`// ${createEndpoint.description}
const newItem = await client.${createEndpoint.name}({ name: 'New Item' });`)
  }

  return examples.join('\n\n')
}

function generateEndpointDoc(endpoint: EndpointDef): string {
  const params = [
    ...(endpoint.pathParams || []).map(p => `- \`${p}\` - Resource ID`),
    ...(endpoint.queryParams || []).map(q => `- \`${q.name}\` - ${q.description || 'Query parameter'}`)
  ]

  const paramsSection = params.length > 0 ? `\nParameters:\n${params.join('\n')}\n` : ''

  return `### ${endpoint.name}(${(endpoint.pathParams || []).join(', ')})

${endpoint.description}
${paramsSection}`
}
