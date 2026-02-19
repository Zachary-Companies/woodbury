/**
 * Repository Creator
 * Creates new repositories for generated agents with proper structure
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { AssembledAgent, exportAgentAsFiles } from '../components/assembler'
import { AgentDefinition } from '../config/schema'

/**
 * Repository creation options
 */
export interface RepositoryOptions {
  /** Base directory for creating repositories */
  baseDirectory: string

  /** Repository name (defaults to agent name) */
  repoName?: string

  /** Include knowledge base integration */
  includeKnowledgeBase?: boolean

  /** Knowledge base entries to include */
  knowledgeEntries?: string[]

  /** Initialize git repository */
  initGit?: boolean

  /** Create initial commit */
  createInitialCommit?: boolean

  /** Module type */
  moduleType?: 'esm' | 'commonjs'
}

/**
 * Created repository result
 */
export interface CreatedRepository {
  /** Full path to the repository */
  path: string

  /** Repository name */
  name: string

  /** Files created */
  files: string[]

  /** Whether git was initialized */
  gitInitialized: boolean

  /** Any warnings during creation */
  warnings: string[]
}

/**
 * Create a new repository for an agent
 */
export async function createAgentRepository(
  assembled: AssembledAgent,
  options: RepositoryOptions
): Promise<CreatedRepository> {
  const {
    baseDirectory,
    repoName,
    includeKnowledgeBase = true,
    knowledgeEntries = [],
    initGit = true,
    createInitialCommit = true,
    moduleType = 'esm'
  } = options

  const warnings: string[] = []
  const definition = assembled.definition

  // Determine repository name
  const name = repoName || toKebabCase(definition.name)
  const repoPath = path.join(baseDirectory, name)

  // Check if directory already exists
  if (fs.existsSync(repoPath)) {
    throw new Error(`Repository already exists: ${repoPath}`)
  }

  // Create directory structure
  fs.mkdirSync(repoPath, { recursive: true })
  fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  fs.mkdirSync(path.join(repoPath, 'src', 'components'), { recursive: true })

  const createdFiles: string[] = []

  // Generate enhanced package.json with knowledge-base
  const packageJson = generateEnhancedPackageJson(definition, {
    includeKnowledgeBase,
    moduleType
  })
  fs.writeFileSync(path.join(repoPath, 'package.json'), packageJson)
  createdFiles.push('package.json')

  // Generate tsconfig.json
  const tsconfig = generateTsConfig(moduleType)
  fs.writeFileSync(path.join(repoPath, 'tsconfig.json'), tsconfig)
  createdFiles.push('tsconfig.json')

  // Generate .env.example
  const envExample = generateEnvExample(definition)
  fs.writeFileSync(path.join(repoPath, '.env.example'), envExample)
  createdFiles.push('.env.example')

  // Generate .gitignore
  const gitignore = generateGitignore()
  fs.writeFileSync(path.join(repoPath, '.gitignore'), gitignore)
  createdFiles.push('.gitignore')

  // Generate main entry with knowledge-base integration
  const mainEntry = generateMainEntry(definition, {
    includeKnowledgeBase,
    knowledgeEntries,
    moduleType
  })
  fs.writeFileSync(path.join(repoPath, 'src', 'index.ts'), mainEntry)
  createdFiles.push('src/index.ts')

  // Generate agent module
  const agentModule = generateAgentModule(assembled, {
    includeKnowledgeBase,
    knowledgeEntries
  })
  fs.writeFileSync(path.join(repoPath, 'src', 'agent.ts'), agentModule)
  createdFiles.push('src/agent.ts')

  // Export component files
  const componentFiles = exportAgentAsFiles(assembled)
  for (const [filePath, content] of componentFiles) {
    if (filePath.startsWith('components/')) {
      const fullPath = path.join(repoPath, 'src', filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
      createdFiles.push(`src/${filePath}`)
    }
  }

  // Generate types
  fs.writeFileSync(
    path.join(repoPath, 'src', 'types.ts'),
    assembled.typeDefinitions
  )
  createdFiles.push('src/types.ts')

  // Generate runtime types (required by components)
  fs.writeFileSync(
    path.join(repoPath, 'src', 'runtime-types.ts'),
    generateRuntimeTypes()
  )
  createdFiles.push('src/runtime-types.ts')

  // Generate README
  const readme = generateReadme(definition, {
    includeKnowledgeBase,
    knowledgeEntries
  })
  fs.writeFileSync(path.join(repoPath, 'README.md'), readme)
  createdFiles.push('README.md')

  // Initialize git repository
  let gitInitialized = false
  if (initGit) {
    try {
      execSync('git init', { cwd: repoPath, stdio: 'pipe' })
      gitInitialized = true

      if (createInitialCommit) {
        execSync('git add -A', { cwd: repoPath, stdio: 'pipe' })
        execSync(
          `git commit -m "Initial commit: ${definition.name} agent"`,
          { cwd: repoPath, stdio: 'pipe' }
        )
      }
    } catch (error) {
      warnings.push(`Git initialization failed: ${error}`)
    }
  }

  return {
    path: repoPath,
    name,
    files: createdFiles,
    gitInitialized,
    warnings
  }
}

/**
 * Generate enhanced package.json with knowledge-base dependency
 */
function generateEnhancedPackageJson(
  definition: AgentDefinition,
  options: { includeKnowledgeBase: boolean; moduleType: string }
): string {
  const { includeKnowledgeBase, moduleType } = options

  const dependencies: Record<string, string> = {
    'dotenv': '^16.0.0',
    'node-fetch': '^3.3.0'
  }

  if (includeKnowledgeBase) {
    dependencies['@zachary/knowledge-base'] = '^1.0.0'
    dependencies['@zachary/woodbury'] = '^1.0.0'
  }

  const pkg = {
    name: toKebabCase(definition.name),
    version: definition.version || '1.0.0',
    description: definition.description,
    type: moduleType === 'esm' ? 'module' : 'commonjs',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
      start: 'node dist/index.js',
      dev: 'npx tsx src/index.ts',
      'dev:watch': 'npx tsx watch src/index.ts'
    },
    dependencies,
    devDependencies: {
      'typescript': '^5.0.0',
      'tsx': '^4.0.0',
      '@types/node': '^20.0.0'
    },
    engines: {
      node: '>=18.0.0'
    },
    author: '',
    license: 'MIT'
  }

  return JSON.stringify(pkg, null, 2)
}

/**
 * Generate tsconfig.json
 */
function generateTsConfig(moduleType: string): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: moduleType === 'esm' ? 'ESNext' : 'CommonJS',
      moduleResolution: 'bundler',
      lib: ['ES2022'],
      outDir: './dist',
      rootDir: './src',
      strict: false,
      noImplicitAny: false,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist']
  }

  return JSON.stringify(config, null, 2)
}

/**
 * Generate .env.example
 */
function generateEnvExample(definition: AgentDefinition): string {
  const lines = [
    '# Environment configuration for ' + definition.name,
    '',
    '# API Keys'
  ]

  for (const connector of definition.components.connectors) {
    const envPrefix = toScreamingSnakeCase(connector.id)
    switch (connector.auth.type) {
      case 'api_key':
        lines.push(`${envPrefix}_API_KEY=your_api_key_here`)
        break
      case 'oauth2':
        lines.push(`${envPrefix}_CLIENT_ID=your_client_id`)
        lines.push(`${envPrefix}_CLIENT_SECRET=your_client_secret`)
        break
      case 'basic':
        lines.push(`${envPrefix}_USERNAME=your_username`)
        lines.push(`${envPrefix}_PASSWORD=your_password`)
        break
    }
  }

  lines.push('')
  lines.push('# LLM Provider (for knowledge-base)')
  lines.push('ANTHROPIC_API_KEY=your_anthropic_key')
  lines.push('# Or use OpenAI:')
  lines.push('# OPENAI_API_KEY=your_openai_key')

  return lines.join('\n')
}

/**
 * Generate .gitignore
 */
function generateGitignore(): string {
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
 * Generate main entry point with knowledge-base integration
 */
function generateMainEntry(
  definition: AgentDefinition,
  options: {
    includeKnowledgeBase: boolean
    knowledgeEntries: string[]
    moduleType: string
  }
): string {
  const { includeKnowledgeBase, knowledgeEntries } = options
  const agentClassName = toPascalCase(definition.name) + 'Agent'

  let code = `/**
 * ${definition.name}
 * ${definition.description}
 *
 * Generated by Agent Builder
 */

import 'dotenv/config'
import { ${agentClassName} } from './agent'
`

  if (includeKnowledgeBase) {
    code += `import * as knowledgeBase from '@zachary/knowledge-base'
import { KnowledgeBase } from '@zachary/woodbury'
`
  }

  code += `
async function main() {
  console.log('Starting ${definition.name}...')

`

  if (includeKnowledgeBase) {
    code += `  // Initialize knowledge base
  const kb = new KnowledgeBase()
  kb.loadFromPackage(knowledgeBase)
  console.log('Knowledge base loaded:', kb.getNames())

`
    if (knowledgeEntries.length > 0) {
      code += `  // Get specific knowledge entries
  const relevantKnowledge = [
${knowledgeEntries.map(e => `    kb.get('${e}'),`).join('\n')}
  ].filter(Boolean)
  console.log('Using knowledge entries:', relevantKnowledge.map(k => k?.name))

`
    }
  }

  code += `  // Create and initialize agent
  const agent = new ${agentClassName}({
    workingDirectory: process.cwd(),
    logger: {
      debug: (msg, data) => console.log('[DEBUG]', msg, data || ''),
      info: (msg, data) => console.log('[INFO]', msg, data || ''),
      warn: (msg, data) => console.warn('[WARN]', msg, data || ''),
      error: (msg, err) => console.error('[ERROR]', msg, err || '')
    }
  })

  await agent.initialize()

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\\nShutting down...')
    await agent.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await agent.stop()
    process.exit(0)
  })

  // Start the agent
  await agent.start()
  console.log('${definition.name} is running. Press Ctrl+C to stop.')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
`

  return code
}

/**
 * Generate agent module with knowledge-base context
 */
function generateAgentModule(
  assembled: AssembledAgent,
  options: {
    includeKnowledgeBase: boolean
    knowledgeEntries: string[]
  }
): string {
  const { includeKnowledgeBase } = options

  // Start with the assembled main module but modify imports
  let code = assembled.mainModule

  if (includeKnowledgeBase) {
    // Add knowledge-base types to the context
    const kbContextAddition = `
  /** Knowledge base for agent context */
  knowledgeBase?: {
    get(name: string): { name: string; content: string } | undefined
    getNames(): string[]
  }
`
    // Insert into ComponentExecutionContext interface
    code = code.replace(
      'interface ComponentExecutionContext {',
      `interface ComponentExecutionContext {${kbContextAddition}`
    )
  }

  return code
}

/**
 * Generate README
 */
function generateReadme(
  definition: AgentDefinition,
  options: {
    includeKnowledgeBase: boolean
    knowledgeEntries: string[]
  }
): string {
  const { includeKnowledgeBase, knowledgeEntries } = options

  let readme = `# ${definition.name}

${definition.description}

## Overview

This agent was generated by Agent Builder.

### Components

**Connectors:**
${definition.components.connectors.map(c => `- ${c.name}: ${c.type}`).join('\n') || '- None'}

**Processors:**
${definition.components.processors.map(p => `- ${p.name}: ${p.type}`).join('\n') || '- None'}

**Actions:**
${definition.components.actions.map(a => `- ${a.name}: ${a.type}`).join('\n') || '- None'}

**Triggers:**
${definition.components.triggers.map(t => `- ${t.name}: ${t.type}`).join('\n') || '- None'}

## Setup

1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

2. Copy \`.env.example\` to \`.env\` and configure your credentials:
   \`\`\`bash
   cp .env.example .env
   \`\`\`

3. Build the project:
   \`\`\`bash
   npm run build
   \`\`\`

4. Run the agent:
   \`\`\`bash
   npm start
   \`\`\`

For development with auto-reload:
\`\`\`bash
npm run dev:watch
\`\`\`

`

  if (includeKnowledgeBase) {
    readme += `## Knowledge Base

This agent uses the \`@zachary/knowledge-base\` package for context.

`
    if (knowledgeEntries.length > 0) {
      readme += `### Configured Knowledge Entries

${knowledgeEntries.map(e => `- ${e}`).join('\n')}

`
    }
  }

  readme += `## Configuration

### Environment Variables

See \`.env.example\` for all required environment variables.

### Oversight Level

Current oversight level: **${definition.oversight.level}**

${definition.oversight.level === 'autonomous' ? 'The agent runs without requiring approval for actions.' : ''}
${definition.oversight.level === 'monitored' ? 'The agent logs all actions but does not require approval.' : ''}
${definition.oversight.level === 'approval_required' ? 'Certain actions require human approval before execution.' : ''}
${definition.oversight.level === 'manual' ? 'All actions require human approval before execution.' : ''}

## Generated

- **Version:** ${definition.version || '1.0.0'}
- **Generated at:** ${new Date().toISOString()}
- **Status:** ${definition.status}
`

  return readme
}

// Utility functions

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')
}

function toScreamingSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toUpperCase()
}

/**
 * Generate runtime types file content
 */
function generateRuntimeTypes(): string {
  return `/**
 * Runtime type definitions for agent components
 */

export interface ComponentExecutionContext {
  agentId: string
  executionId: string
  workingDirectory: string
  signal?: AbortSignal
  credentials: CredentialsStore
  state: StateStore
  logger: ComponentLogger
  knowledgeBase?: {
    get(name: string): { name: string; content: string } | undefined
    getNames(): string[]
  }
}

export interface CredentialsStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  has(key: string): boolean
}

export interface StateStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): boolean
  clear(): void
}

export interface ComponentLogger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, error?: Error): void
}

export interface RuntimeConnector {
  id: string
  initialize(): Promise<void>
  execute(operationId: string, params: Record<string, unknown>): Promise<unknown>
  isConnected(): boolean
  disconnect(): Promise<void>
  setContext?(context: ComponentExecutionContext): void
}

export interface RuntimeProcessor {
  id: string
  process(input: unknown): Promise<unknown>
  setContext?(context: ComponentExecutionContext): void
}

export interface RuntimeAction {
  id: string
  execute(data: unknown): Promise<ActionResult>
  canExecute(data: unknown): boolean
  getConnector(): RuntimeConnector
  setContext?(context: ComponentExecutionContext): void
}

export interface RuntimeTrigger {
  id: string
  start(callback: TriggerCallback): void
  stop(): void
  isActive(): boolean
  invoke(): void
  setContext?(context: ComponentExecutionContext): void
}

export interface ActionResult {
  success: boolean
  data?: unknown
  error?: string
}

export type TriggerCallback = (context: TriggerContext) => Promise<void>

export interface TriggerContext {
  triggerId: string
  triggerType: string
  triggeredAt: number
  payload?: unknown
}

export interface ExecutionResult {
  success: boolean
  startedAt: number
  completedAt: number
  duration: number
  fetchedData: Map<string, unknown>
  processedData: Map<string, unknown>
  actionsExecuted: Array<{ actionId: string; result: ActionResult }>
  errors: Array<{ phase: string; componentId: string; message: string }>
}

export interface ValidationResult {
  valid: boolean
  errors?: string[]
}
`
}
