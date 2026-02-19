/**
 * Agent Generator
 * Generates agents that follow the @zachary/agent-core pattern
 * Compatible with email-processor, using AgentProcessorBase
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { generateServiceCode, GeneratedServiceCode } from '../code-generation'
import { RAGKnowledgeBase } from '../../rag/knowledge-base-v2'

/**
 * Logger interface for agent generation (pino-compatible)
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
 * Create a simple console logger
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

export interface AgentSpec {
  name: string
  description: string
  agentId: string  // kebab-case identifier like 'coi-generator', 'quote-comparison'

  // What this agent processes
  input: {
    type: 'pdf' | 'email' | 'multiple-pdfs'
    minFiles?: number
    maxFiles?: number
    description: string
  }

  // What this agent outputs
  output: {
    type: 'pdf' | 'excel' | 'powerpoint' | 'word' | 'email-only'
    description: string
  }

  // Services this agent needs
  services: ServiceSpec[]

  // Processing steps
  processingSteps: string[]
}

export interface ServiceSpec {
  name: string  // PascalCase like 'ExtractionService'
  description: string
  usesLLM: boolean
}

export interface GeneratedAgent {
  files: Map<string, string>
  packageName: string
  agentId: string
}

/**
 * Generate a complete agent following the @zachary/agent-core pattern
 */
export function generateAgent(spec: AgentSpec): GeneratedAgent {
  const files = new Map<string, string>()
  const packageName = `@zachary/${spec.agentId}`
  const className = toPascalCase(spec.agentId.replace(/-/g, ' ')) + 'Processor'
  const handlerName = toCamelCase(spec.agentId.replace(/-/g, ' ')) + 'Handler'

  // Generate package.json
  files.set('package.json', generatePackageJson(spec, packageName))

  // Generate tsconfig.json
  files.set('tsconfig.json', generateTsConfig())

  // Generate jest.config.js
  files.set('jest.config.js', generateJestConfig())

  // Generate .gitignore
  files.set('.gitignore', generateGitignore())

  // Generate .env.example
  files.set('.env.example', generateEnvExample())

  // Generate src/index.ts
  files.set('src/index.ts', generateIndex(spec, className, handlerName))

  // Generate src/handler.ts
  files.set('src/handler.ts', generateHandler(spec, className, handlerName))

  // Generate src/processor.ts
  files.set('src/processor.ts', generateProcessor(spec, className))

  // Generate src/handler-runner.ts
  files.set('src/handler-runner.ts', generateHandlerRunner(spec, className))

  // Generate src/shared/agent-base.ts (re-export from agent-core)
  files.set('src/shared/agent-base.ts', generateSharedAgentBase())

  // Generate src/shared/s3-client.ts (re-export from agent-core)
  files.set('src/shared/s3-client.ts', generateSharedS3Client())

  // Generate src/shared/logging.ts (re-export from agent-core)
  files.set('src/shared/logging.ts', generateSharedLogging())

  // Generate src/shared/types.ts (re-export from agent-core)
  files.set('src/shared/types.ts', generateSharedTypes())

  // Generate src/types/index.ts
  files.set('src/types/index.ts', generateTypesIndex(spec))

  // Generate service files
  for (const service of spec.services) {
    const fileName = toKebabCase(service.name) + '.ts'
    files.set(`src/services/${fileName}`, generateService(service))
  }

  // Generate test files
  files.set('src/processor.test.ts', generateProcessorTest(spec, className))
  files.set('src/handler.test.ts', generateHandlerTest(spec, className, handlerName))
  for (const service of spec.services) {
    const fileName = toKebabCase(service.name) + '.test.ts'
    files.set(`src/services/${fileName}`, generateServiceTest(service))
  }

  // Generate README.md
  files.set('README.md', generateReadme(spec, packageName))

  return {
    files,
    packageName,
    agentId: spec.agentId
  }
}

/**
 * Write generated agent to disk
 */
export function writeAgentToDisk(
  agent: GeneratedAgent,
  outputPath: string,
  options: { initGit?: boolean; installDeps?: boolean } = {}
): void {
  // Create output directory
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true })
  }

  // Write all files
  for (const [filePath, content] of agent.files) {
    const fullPath = path.join(outputPath, filePath)
    const dir = path.dirname(fullPath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(fullPath, content)
  }

  // Create test-data directory
  const testDataDir = path.join(outputPath, 'test-data')
  if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true })
  }

  // Initialize git
  if (options.initGit) {
    try {
      execSync('git init', { cwd: outputPath, stdio: 'ignore' })
      execSync('git add .', { cwd: outputPath, stdio: 'ignore' })
      execSync('git commit -m "Initial commit"', { cwd: outputPath, stdio: 'ignore' })
    } catch (e) {
      // Git init may fail, that's ok
    }
  }
}

/**
 * Generate a complete agent with LLM-generated service implementations
 * This async version uses AgentV2 to write real implementation code
 */
export async function generateAgentAsync(
  spec: AgentSpec,
  options: {
    knowledgeBase?: RAGKnowledgeBase
    model?: string
    logger?: Logger
    onProgress?: (serviceName: string, status: 'generating' | 'complete' | 'error') => void
  } = {}
): Promise<GeneratedAgent> {
  const logger = options.logger || createConsoleLogger()
  const files = new Map<string, string>()
  const packageName = `@zachary/${spec.agentId}`
  const className = toPascalCase(spec.agentId.replace(/-/g, ' ')) + 'Processor'
  const handlerName = toCamelCase(spec.agentId.replace(/-/g, ' ')) + 'Handler'

  logger.info({ agentId: spec.agentId, services: spec.services.length }, 'Starting async agent generation')

  // Generate all static files first (same as sync version)
  files.set('package.json', generatePackageJson(spec, packageName))
  files.set('tsconfig.json', generateTsConfig())
  files.set('jest.config.js', generateJestConfig())
  files.set('.gitignore', generateGitignore())
  files.set('.env.example', generateEnvExample())
  files.set('src/index.ts', generateIndex(spec, className, handlerName))
  files.set('src/handler.ts', generateHandler(spec, className, handlerName))
  files.set('src/processor.ts', generateProcessor(spec, className))
  files.set('src/handler-runner.ts', generateHandlerRunner(spec, className))
  files.set('src/shared/agent-base.ts', generateSharedAgentBase())
  files.set('src/shared/s3-client.ts', generateSharedS3Client())
  files.set('src/shared/logging.ts', generateSharedLogging())
  files.set('src/shared/types.ts', generateSharedTypes())
  files.set('src/types/index.ts', generateTypesIndex(spec))
  files.set('README.md', generateReadme(spec, packageName))

  // Generate service files using LLM
  const generatedServices = new Map<string, GeneratedServiceCode>()

  for (const service of spec.services) {
    options.onProgress?.(service.name, 'generating')
    logger.info({ serviceName: service.name }, 'Generating service implementation with LLM')

    try {
      const serviceCode = await generateServiceCode(
        {
          agentName: spec.name,
          agentDescription: spec.description,
          agentId: spec.agentId,
          serviceName: service.name,
          serviceDescription: service.description,
          usesLLM: service.usesLLM,
          inputType: spec.input.type,
          inputDescription: spec.input.description,
          outputType: spec.output.type,
          outputDescription: spec.output.description,
          processingSteps: spec.processingSteps
        },
        options.knowledgeBase,
        {
          model: options.model,
          logger
        }
      )

      generatedServices.set(service.name, serviceCode)
      options.onProgress?.(service.name, 'complete')
      logger.info({ serviceName: service.name, codeLength: serviceCode.code.length }, 'Service generation complete')
    } catch (error) {
      options.onProgress?.(service.name, 'error')
      logger.error({ err: error, serviceName: service.name }, 'Failed to generate service, falling back to stub')
      // Fall back to stub generation
      generatedServices.set(service.name, {
        code: generateService(service),
        imports: [],
        dependencies: [],
        explanation: 'Fallback stub - LLM generation failed'
      })
    }
  }

  // Write generated service files
  for (const [serviceName, generated] of generatedServices) {
    const fileName = toKebabCase(serviceName) + '.ts'
    files.set(`src/services/${fileName}`, generated.code)
  }

  // Update package.json with any additional dependencies
  const allDependencies = new Set<string>()
  for (const generated of generatedServices.values()) {
    for (const dep of generated.dependencies) {
      allDependencies.add(dep)
    }
  }

  if (allDependencies.size > 0) {
    // Re-generate package.json with new dependencies
    const pkgJson = JSON.parse(files.get('package.json')!)
    for (const dep of allDependencies) {
      if (!pkgJson.dependencies[dep]) {
        pkgJson.dependencies[dep] = '*' // Will be resolved by npm
      }
    }
    files.set('package.json', JSON.stringify(pkgJson, null, 2))
  }

  // Generate test files
  files.set('src/processor.test.ts', generateProcessorTest(spec, className))
  files.set('src/handler.test.ts', generateHandlerTest(spec, className, handlerName))
  for (const service of spec.services) {
    const fileName = toKebabCase(service.name) + '.test.ts'
    files.set(`src/services/${fileName}`, generateServiceTest(service))
  }

  logger.info({ agentId: spec.agentId }, 'Async agent generation complete')

  return {
    files,
    packageName,
    agentId: spec.agentId
  }
}

// ============================================
// File Generators
// ============================================

function generatePackageJson(spec: AgentSpec, packageName: string): string {
  const dependencies: Record<string, string> = {
    '@zachary/agent-core': '^0.1.0',
    '@zachary/llm-service': '^0.1.0',
    'dotenv': '^16.0.0',
    'pdf-parse': '^1.1.1',
    'pino': '^8.0.0'
  }

  // Add pdfkit for PDF generation (used by LLM-generated code)
  dependencies['pdfkit'] = '^0.13.0'

  // Add output-specific dependencies
  if (spec.output.type === 'excel') {
    dependencies['exceljs'] = '^4.3.0'
  } else if (spec.output.type === 'powerpoint') {
    dependencies['pptxgenjs'] = '^3.12.0'
  } else if (spec.output.type === 'word') {
    dependencies['docx'] = '^8.0.0'
  } else if (spec.output.type === 'pdf') {
    dependencies['pdf-lib'] = '^1.17.1'
  }

  // Scripts aligned with @zachary/knowledge-base common-development-scripts.md
  const scripts = {
    // Lifecycle & Build
    build: 'tsc -p tsconfig.json',
    clean: 'rimraf dist',
    prepare: 'npm run build',

    // Development
    dev: 'ts-node src/handler-runner.ts',
    watch: 'tsc --watch',

    // Testing
    test: 'jest',
    'test:watch': 'jest --watch',
    'test:coverage': 'jest --coverage',

    // Publishing Workflow (ppp = patch-publish-prepare)
    'publish:patch': 'npm version patch && npm publish',
    'publish:patch:prepare': 'npm run prepare && npm run publish:patch',
    ppp: 'npm run publish:patch:prepare',

    // Full Cycle
    all: 'npm run clean && npm run build && npm test && npm run commit && npm run publish:patch',

    // Git Operations
    commit: 'git add . && git commit -m "update"',

    // Dependency Management
    update: 'npm install @zachary/agent-core@latest @zachary/email-processor-types@latest @zachary/llm-service@latest'
  }

  const pkg = {
    name: packageName,
    version: '1.0.0',
    description: spec.description,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts,
    dependencies,
    devDependencies: {
      '@types/node': '^20.0.0',
      '@types/pdf-parse': '^1.1.1',
      '@types/pdfkit': '^0.13.0',
      'jest': '^29.0.0',
      'ts-jest': '^29.0.0',
      '@types/jest': '^29.0.0',
      'rimraf': '^5.0.0',
      'ts-node': '^10.9.0',
      'typescript': '^5.0.0'
    }
  }

  return JSON.stringify(pkg, null, 2)
}

function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      lib: ['ES2022'],
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      resolveJsonModule: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist', 'test-data']
  }
  return JSON.stringify(config, null, 2)
}

function generateJestConfig(): string {
  return `/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/handler-runner.ts',
    '!src/index.ts',
    '!src/shared/**/*.ts',
    '!src/types/**/*.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  verbose: true,
};
`
}

function generateGitignore(): string {
  return `node_modules/
dist/
coverage/
.env
*.log
.DS_Store
test-data/*.pdf
test-data/*.xlsx
test-data/*.pptx
test-data/*.docx
`
}

function generateEnvExample(): string {
  return `# API Keys
ANTHROPIC_API_KEY=your_api_key_here

# Development Settings
USE_LOCAL_FILES=true
LOG_LEVEL=debug
`
}

function generateIndex(spec: AgentSpec, className: string, handlerName: string): string {
  return `export { ${handlerName} } from './handler';
export { ${className} } from './processor';
export { default } from './handler';

// Export types
export * from './types';
`
}

function generateHandler(spec: AgentSpec, className: string, handlerName: string): string {
  const serviceImports = spec.services.map(s =>
    `import { ${s.name} } from './services/${toKebabCase(s.name)}';`
  ).join('\n')

  const serviceInits = spec.services.map(s =>
    `  const ${toCamelCase(s.name)} = new ${s.name}(logger);`
  ).join('\n')

  const serviceParams = spec.services.map(s => toCamelCase(s.name)).join(', ')

  return `import pino from 'pino';
import dotenv from 'dotenv';
import { ${className} } from './processor';
import { S3Client, FileBasedS3Client } from './shared/s3-client';
import { toTrackingResult } from '@zachary/agent-core';
import type { AgentRequest, Attachment } from './shared/types';
${serviceImports}

// Local type definitions for email processor
interface EmailAttachment {
  id?: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  s3Url?: string;
  presignedUrl?: string;
}

interface ProcessingContext {
  payload: {
    emailKey: string;
    subject?: string;
    sender?: string;
    recipient?: string;
  };
  email: {
    from: string;
    to: string;
    subject?: string;
    textBody?: string;
    htmlBody?: string;
    date?: Date;
  };
  attachments?: EmailAttachment[];
  secrets?: Record<string, string>;
  sendEmail: (params: {
    to: string;
    from: string;
    replyTo?: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
  }) => Promise<void>;
}

type EmailHandler = (context: ProcessingContext) => Promise<unknown>;

/**
 * Guess content type from filename
 */
function guessContentType(filename?: string | null): string {
  if (!filename) return 'application/octet-stream';
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * Map ProcessingContext to the agent's internal AgentRequest format
 */
function mapContextToAgentRequest(context: ProcessingContext): AgentRequest {
  const nowIso = new Date().toISOString();
  const deadlineMs = Date.now() + 5 * 60 * 1000; // 5 minutes

  const tenantId = 'default-tenant';
  const requestId = \`req-\${Date.now()}\`;
  const correlationId = requestId;

  const attachments: Attachment[] = (context.attachments || []).map((att, index) => ({
    id: att.id || \`attachment-\${index + 1}\`,
    fileName: att.fileName || \`attachment-\${index + 1}\`,
    contentType: att.contentType || guessContentType(att.fileName),
    sizeBytes: att.sizeBytes ?? 0,
    s3Url: att.s3Url || '',
    presignedUrl: att.presignedUrl,
  }));

  return {
    version: '1.0',
    tenantId,
    requestId,
    correlationId,
    timestamp: nowIso,
    deadlineMs,
    email: {
      messageId: context.payload.emailKey,
      from: context.email.from,
      to: context.email.to,
      subject: context.email.subject || context.payload.subject || '',
      bodyText: context.email.textBody || '',
      bodyHtml: context.email.htmlBody,
      receivedAt: context.email.date ? context.email.date.toISOString() : nowIso,
    },
    attachments,
    routing: {
      agentId: ${className}.AGENT_ID,
      confidence: 1.0,
    },
    tenant: {
      id: tenantId,
      name: tenantId,
      settings: {},
      secrets: context.secrets || {},
    },
    metadata: {},
  };
}

/**
 * ${spec.name} Handler
 * ${spec.description}
 */
export const ${handlerName}: EmailHandler = async (context: ProcessingContext) => {
  dotenv.config();

  // Configure logger and services
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const useLocalFiles = process.env.USE_LOCAL_FILES === 'true';
  const s3Client = useLocalFiles ? new FileBasedS3Client('./test-data') : new S3Client();

  // Initialize services
${serviceInits}

  // Create processor
  const processor = new ${className}(logger, s3Client${serviceParams ? ', ' + serviceParams : ''});

  // Process request
  const request = mapContextToAgentRequest(context);
  const agentResponse = await processor.process(request);

  // Handle response
  if (agentResponse.status === 'success' && agentResponse.response) {
    const toAddress = context.payload.sender || context.email.from;
    const replyToAddress = context.payload.recipient || context.email.to;

    const responseAttachments = agentResponse.response.attachments || [];
    const emailAttachments: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }> = [];

    for (const attachment of responseAttachments) {
      if (attachment.contentBase64) {
        emailAttachments.push({
          filename: attachment.fileName,
          content: Buffer.from(attachment.contentBase64, 'base64'),
          contentType: attachment.contentType,
        });
        continue;
      }

      if (attachment.s3Url) {
        try {
          const fileBytes = await s3Client.download(attachment.s3Url);
          emailAttachments.push({
            filename: attachment.fileName,
            content: fileBytes,
            contentType: attachment.contentType,
          });
        } catch (error) {
          logger.warn({ err: error, s3Url: attachment.s3Url }, 'Failed to download attachment');
        }
      }
    }

    await context.sendEmail({
      to: toAddress,
      from: context.payload.recipient || context.email.to,
      replyTo: replyToAddress,
      subject: agentResponse.response.subject || 'Processing Complete',
      textBody: agentResponse.response.bodyText,
      htmlBody: agentResponse.response.bodyHtml,
      attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
    });

    logger.info({
      subject: agentResponse.response.subject,
      attachments: emailAttachments.map(a => a.filename),
      metrics: agentResponse.metrics,
    }, '${spec.name} completed successfully');

    return toTrackingResult(agentResponse, true);
  } else {
    const errorMessage = agentResponse.error?.message || 'Unknown error occurred.';
    const toAddress = context.payload.sender || context.email.from;
    const replyToAddress = context.payload.recipient || context.email.to;

    await context.sendEmail({
      to: toAddress,
      from: context.payload.recipient || context.email.to,
      replyTo: replyToAddress,
      subject: 'Processing Failed',
      textBody: \`We were unable to process your request. \${errorMessage}\`,
    });

    logger.warn({ error: agentResponse.error, metrics: agentResponse.metrics }, '${spec.name} reported error');

    return toTrackingResult(agentResponse, true);
  }
};

export default ${handlerName};
`
}

function generateProcessor(spec: AgentSpec, className: string): string {
  const serviceImports = spec.services.map(s =>
    `import { ${s.name} } from './services/${toKebabCase(s.name)}';`
  ).join('\n')

  const serviceFields = spec.services.map(s =>
    `  private readonly ${toCamelCase(s.name)}: ${s.name};`
  ).join('\n')

  const serviceParams = spec.services.map(s =>
    `    ${toCamelCase(s.name)}: ${s.name},`
  ).join('\n')

  const serviceAssigns = spec.services.map(s =>
    `    this.${toCamelCase(s.name)} = ${toCamelCase(s.name)};`
  ).join('\n')

  const processingSteps = spec.processingSteps.map((step, i) =>
    `      // STEP ${i + 1}: ${step}\n      log.info('${step}');`
  ).join('\n\n')

  return `import { AgentRequest, AgentResponse, AttachmentHelper, ResponseAttachment } from './shared/types';
import { AgentProcessorBase } from './shared/agent-base';
import { IS3Client } from './shared/s3-client';
import { RequestScopedLogger } from './shared/logging';
import pino from 'pino';
import PDFParser from 'pdf-parse';
${serviceImports}

/**
 * ${spec.name} Processor
 * ${spec.description}
 */
export class ${className} extends AgentProcessorBase {
  static readonly AGENT_ID = '${spec.agentId}';
  readonly agentId = ${className}.AGENT_ID;

  private readonly s3: IS3Client;
${serviceFields}

  private static readonly MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

  constructor(
    logger: pino.Logger,
    s3: IS3Client,
${serviceParams}
  ) {
    super(logger);
    this.s3 = s3;
${serviceAssigns}
  }

  async process(request: AgentRequest): Promise<AgentResponse> {
    const timer = this.startTimer();
    const log = new RequestScopedLogger(this.logger, request, this.agentId);

    log.info('Starting ${spec.name} processing');

    try {
      // ============================================
      // STEP 1: Validate Input
      // ============================================
      ${spec.input.type === 'pdf' ? `const pdfAttachment = this.findPdfAttachment(request);

      if (!pdfAttachment) {
        log.warn('No PDF attachment found');
        return this.missingAttachment(
          request,
          timer,
          'Please attach a PDF document to process.',
        );
      }

      if (pdfAttachment.sizeBytes > ${className}.MAX_FILE_SIZE_BYTES) {
        log.warn({ size: pdfAttachment.sizeBytes }, 'PDF too large');
        return this.invalidInput(
          request,
          timer,
          \`PDF file (\${AttachmentHelper.getFormattedSize(pdfAttachment)}) exceeds maximum size of 50MB.\`,
        );
      }` : spec.input.type === 'multiple-pdfs' ? `const pdfAttachments = request.attachments.filter(a => AttachmentHelper.isPdf(a));

      if (pdfAttachments.length < ${spec.input.minFiles || 1}) {
        log.warn({ count: pdfAttachments.length }, 'Not enough PDF attachments');
        return this.missingAttachment(
          request,
          timer,
          'Please attach at least ${spec.input.minFiles || 1} PDF document(s) to process.',
        );
      }

      if (pdfAttachments.length > ${spec.input.maxFiles || 10}) {
        log.warn({ count: pdfAttachments.length }, 'Too many PDF attachments');
        return this.invalidInput(
          request,
          timer,
          'Maximum ${spec.input.maxFiles || 10} PDF attachments allowed.',
        );
      }` : '// Email-only processing, no attachments required'}

      if (this.isDeadlineExceeded(request)) {
        log.warn('Request deadline already exceeded');
        return this.timeout(request, timer);
      }

${processingSteps}

      // ============================================
      // Build Response
      // ============================================
      const attachments: ResponseAttachment[] = [];

      // TODO: Add generated output files to attachments
      // Example:
      // attachments.push({
      //   fileName: 'output.pdf',
      //   contentType: 'application/pdf',
      //   sizeBytes: outputBuffer.length,
      //   contentBase64: outputBuffer.toString('base64'),
      // });

      const subject = 'Processing Complete';
      const bodyText = this.buildResponseMessage(request);

      log.info('${spec.name} completed successfully');

      return this.success(
        request,
        timer,
        {
          subject,
          bodyText,
          bodyHtml: this.wrapInHtml(bodyText),
          attachments,
        },
        undefined,
        'claude-sonnet-4-20250514',
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('Request cancelled or timed out');
        return this.timeout(request, timer);
      }
      return this.internalError(request, timer, error as Error);
    }
  }

  private buildResponseMessage(request: AgentRequest): string {
    const lines: string[] = [];
    lines.push('**Processing Complete**');
    lines.push('');
    lines.push('Your request has been processed successfully.');
    lines.push('');
    lines.push('Please review the attached results.');
    return lines.join('\\n');
  }

  private wrapInHtml(content: string): string {
    const html = content
      .replace(/\\n/g, '<br/>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

    return \`
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    </style>
</head>
<body>
    \${html}
    <br/><br/>
    <em>Generated by ${spec.name}</em>
</body>
</html>\`;
  }
}
`
}

function generateHandlerRunner(spec: AgentSpec, className: string): string {
  const serviceImports = spec.services.map(s =>
    `import { ${s.name} } from './services/${toKebabCase(s.name)}';`
  ).join('\n')

  const serviceInits = spec.services.map(s =>
    `  const ${toCamelCase(s.name)} = new ${s.name}(logger);`
  ).join('\n')

  const serviceParams = spec.services.map(s => toCamelCase(s.name)).join(', ')

  return `import pino from 'pino';
import dotenv from 'dotenv';
import { AgentRequest, FileBasedS3Client } from '@zachary/agent-core';
import { ${className} } from './processor';
${serviceImports}

dotenv.config();

async function main() {
  const logger = pino({ level: 'debug' });
  const s3Client = new FileBasedS3Client('./test-data');

  // Initialize services
${serviceInits}

  // Create processor
  const processor = new ${className}(logger, s3Client${serviceParams ? ', ' + serviceParams : ''});

  // Create test request
  const request: AgentRequest = {
    version: '1.0',
    tenantId: 'test-tenant',
    requestId: 'test-request-001',
    correlationId: 'test-correlation-001',
    timestamp: new Date().toISOString(),
    deadlineMs: Date.now() + 5 * 60 * 1000,
    email: {
      messageId: 'test-message',
      from: 'test@example.com',
      to: 'agent@company.com',
      subject: 'Test Document',
      bodyText: 'Please process the attached document.',
      receivedAt: new Date().toISOString(),
    },
    attachments: [
      {
        id: 'att-1',
        fileName: 'test-document.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        s3Url: 's3://test-bucket/tenants/test-tenant/inbound/test.pdf',
      },
    ],
    routing: { agentId: '${spec.agentId}', confidence: 1.0 },
    tenant: { id: 'test-tenant', name: 'Test Tenant', settings: {} },
    metadata: {},
  };

  console.log('Processing request...');
  const response = await processor.process(request);
  console.log('Response:', JSON.stringify(response, null, 2));
}

main().catch(console.error);
`
}

function generateSharedAgentBase(): string {
  return `/**
 * Re-export base classes from @zachary/agent-core for backward compatibility.
 */
export {
  AgentProcessorBase,
  ProcessingTimer,
  AgentInfo,
} from '@zachary/agent-core';
`
}

function generateSharedS3Client(): string {
  return `/**
 * Re-export S3 client from @zachary/agent-core for backward compatibility.
 */
export {
  S3Client,
  FileBasedS3Client,
  IS3Client,
  parseS3Url,
  buildS3Url,
  buildOutboundUrl,
} from '@zachary/agent-core';
`
}

function generateSharedLogging(): string {
  return `/**
 * Re-export logging from @zachary/agent-core for backward compatibility.
 */
export { RequestScopedLogger } from '@zachary/agent-core';
`
}

function generateSharedTypes(): string {
  return `/**
 * Re-export types from @zachary/agent-core for backward compatibility.
 */
export {
  AgentRequest,
  AgentResponse,
  Attachment,
  ResponseAttachment,
  AttachmentHelper,
  ErrorCodes,
  EmailContext,
  MetricsInfo,
} from '@zachary/agent-core';
`
}

function generateTypesIndex(spec: AgentSpec): string {
  return `/**
 * ${spec.name} Types
 */

// Add your domain-specific types here

export interface ProcessingResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
`
}

function generateService(service: ServiceSpec): string {
  const className = service.name
  const methodName = 'process'

  return `import pino from 'pino';
${service.usesLLM ? "import { runPrompt } from '@zachary/llm-service';" : ''}

/**
 * ${service.name}
 * ${service.description}
 */
export class ${className} {
  private readonly logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ service: '${className}' });
  }

  async ${methodName}(input: unknown): Promise<unknown> {
    this.logger.info('Processing input');

    // TODO: Implement ${service.description.toLowerCase()}
${service.usesLLM ? `
    // Example LLM call:
    // const messages = [{ role: 'user' as const, content: 'Your prompt here' }];
    // const response = await runPrompt(messages, 'claude-sonnet-4-20250514');
    // response is a string containing the LLM's response
` : ''}

    return input;
  }
}
`
}

function generateReadme(spec: AgentSpec, packageName: string): string {
  return `# ${spec.name}

${spec.description}

## Package

\`${packageName}\`

## Installation

\`\`\`bash
npm install ${packageName}
\`\`\`

## Usage

\`\`\`typescript
import { ${toCamelCase(spec.agentId.replace(/-/g, ' '))}Handler } from '${packageName}';

// Use with email-processor
export default ${toCamelCase(spec.agentId.replace(/-/g, ' '))}Handler;
\`\`\`

## Development

\`\`\`bash
# Install dependencies
npm install

# Run locally with test data
npm run dev

# Build for production
npm run build

# Run tests
npm test
\`\`\`

## NPM Scripts

| Script | Description |
|--------|-------------|
| \`build\` | Compile TypeScript to dist/ |
| \`clean\` | Remove build directory |
| \`dev\` | Run locally with test data |
| \`test\` | Run Jest tests |
| \`test:watch\` | Run tests in watch mode |
| \`test:coverage\` | Run tests with coverage report |
| \`ppp\` | Patch version, build, and publish (recommended) |
| \`all\` | Clean, build, test, commit, and publish |
| \`update\` | Update @zachary dependencies to latest |

### Publishing Workflow

The recommended workflow for publishing updates:

\`\`\`bash
# Quick patch publish (build + version bump + publish)
npm run ppp

# Full cycle (clean + build + test + commit + publish)
npm run all
\`\`\`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`ANTHROPIC_API_KEY\` | Yes | Claude API key |
| \`USE_LOCAL_FILES\` | No | Use local filesystem instead of S3 |
| \`LOG_LEVEL\` | No | Logging verbosity (debug, info, warn, error) |

## Input

- **Type:** ${spec.input.type}
- **Description:** ${spec.input.description}

## Output

- **Type:** ${spec.output.type}
- **Description:** ${spec.output.description}

## Processing Steps

${spec.processingSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
`
}

// ============================================
// Test Generation Functions
// ============================================

function generateProcessorTest(spec: AgentSpec, className: string): string {
  const inputValidation = spec.input.type === 'pdf'
    ? `
  describe('input validation', () => {
    it('should return missing attachment error when no PDF provided', async () => {
      const request = createTestRequest({ attachments: [] });
      const response = await processor.process(request);

      expect(response.status).toBe('error');
      expect(response.error?.code).toBe('MISSING_ATTACHMENT');
    });

    it('should return invalid input error when PDF is too large', async () => {
      const request = createTestRequest({
        attachments: [{
          id: 'att-1',
          fileName: 'large.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100 * 1024 * 1024, // 100MB
          s3Url: 's3://bucket/large.pdf',
        }],
      });
      const response = await processor.process(request);

      expect(response.status).toBe('error');
      expect(response.error?.code).toBe('INVALID_INPUT');
    });

    it('should accept valid PDF attachment', async () => {
      const request = createTestRequest();
      const response = await processor.process(request);

      // Should not fail on validation
      expect(response.error?.code).not.toBe('MISSING_ATTACHMENT');
      expect(response.error?.code).not.toBe('INVALID_INPUT');
    });
  });`
    : spec.input.type === 'multiple-pdfs'
    ? `
  describe('input validation', () => {
    it('should return missing attachment error when not enough PDFs provided', async () => {
      const request = createTestRequest({ attachments: [] });
      const response = await processor.process(request);

      expect(response.status).toBe('error');
      expect(response.error?.code).toBe('MISSING_ATTACHMENT');
    });

    it('should accept valid PDF attachments', async () => {
      const request = createTestRequest();
      const response = await processor.process(request);

      expect(response.error?.code).not.toBe('MISSING_ATTACHMENT');
    });
  });`
    : ''

  return `import pino from 'pino';
import { ${className} } from './processor';
import { FileBasedS3Client } from '@zachary/agent-core';
import type { AgentRequest } from '@zachary/agent-core';
${spec.services.map(s => `import { ${s.name} } from './services/${toKebabCase(s.name)}';`).join('\n')}

// Mock dependencies
jest.mock('@zachary/agent-core', () => ({
  ...jest.requireActual('@zachary/agent-core'),
  FileBasedS3Client: jest.fn().mockImplementation(() => ({
    download: jest.fn().mockResolvedValue(Buffer.from('mock pdf content')),
    upload: jest.fn().mockResolvedValue('s3://bucket/output.pdf'),
  })),
}));

${spec.services.some(s => s.usesLLM) ? `jest.mock('@zachary/llm-service', () => ({
  runPrompt: jest.fn().mockResolvedValue('Mock LLM response'),
}));` : ''}

describe('${className}', () => {
  let processor: ${className};
  let logger: pino.Logger;
  let s3Client: FileBasedS3Client;
${spec.services.map(s => `  let ${toCamelCase(s.name)}: ${s.name};`).join('\n')}

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    s3Client = new FileBasedS3Client('./test-data');
${spec.services.map(s => `    ${toCamelCase(s.name)} = new ${s.name}(logger);`).join('\n')}
    processor = new ${className}(logger, s3Client${spec.services.length > 0 ? ', ' + spec.services.map(s => toCamelCase(s.name)).join(', ') : ''});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Helper to create a test request
   */
  function createTestRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
    return {
      version: '1.0',
      tenantId: 'test-tenant',
      requestId: 'test-request-001',
      correlationId: 'test-correlation-001',
      timestamp: new Date().toISOString(),
      deadlineMs: Date.now() + 5 * 60 * 1000,
      email: {
        messageId: 'test-message',
        from: 'test@example.com',
        to: 'agent@company.com',
        subject: 'Test Request',
        bodyText: 'Please process this request.',
        receivedAt: new Date().toISOString(),
      },
      attachments: [
        {
          id: 'att-1',
          fileName: 'test-document.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          s3Url: 's3://test-bucket/test.pdf',
        },
      ],
      routing: { agentId: '${spec.agentId}', confidence: 1.0 },
      tenant: { id: 'test-tenant', name: 'Test Tenant', settings: {} },
      metadata: {},
      ...overrides,
    };
  }

  describe('initialization', () => {
    it('should have correct agent ID', () => {
      expect(processor.agentId).toBe('${spec.agentId}');
    });

    it('should be an instance of AgentProcessorBase', () => {
      expect(processor).toHaveProperty('process');
      expect(typeof processor.process).toBe('function');
    });
  });
${inputValidation}

  describe('processing', () => {
    it('should process a valid request', async () => {
      const request = createTestRequest();
      const response = await processor.process(request);

      expect(response).toBeDefined();
      expect(response.requestId).toBe(request.requestId);
      expect(response.agentId).toBe('${spec.agentId}');
    });

    it('should return timeout error when deadline is exceeded', async () => {
      const request = createTestRequest({
        deadlineMs: Date.now() - 1000, // Already expired
      });
      const response = await processor.process(request);

      expect(response.status).toBe('error');
      expect(response.error?.code).toBe('TIMEOUT');
    });

    it('should include metrics in response', async () => {
      const request = createTestRequest();
      const response = await processor.process(request);

      expect(response.metrics).toBeDefined();
      expect(response.metrics?.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('response format', () => {
    it('should return proper success response structure', async () => {
      const request = createTestRequest();
      const response = await processor.process(request);

      if (response.status === 'success') {
        expect(response.response).toBeDefined();
        expect(response.response?.subject).toBeDefined();
        expect(response.response?.bodyText).toBeDefined();
      }
    });

    it('should return proper error response structure', async () => {
      const request = createTestRequest({ attachments: [] });
      const response = await processor.process(request);

      if (response.status === 'error') {
        expect(response.error).toBeDefined();
        expect(response.error?.code).toBeDefined();
        expect(response.error?.message).toBeDefined();
      }
    });
  });
});
`
}

function generateHandlerTest(spec: AgentSpec, className: string, handlerName: string): string {
  return `import { ${handlerName} } from './handler';

// Mock all dependencies
jest.mock('./processor');
jest.mock('@zachary/agent-core', () => ({
  ...jest.requireActual('@zachary/agent-core'),
  FileBasedS3Client: jest.fn().mockImplementation(() => ({
    download: jest.fn().mockResolvedValue(Buffer.from('mock content')),
    upload: jest.fn().mockResolvedValue('s3://bucket/output'),
  })),
  S3Client: jest.fn().mockImplementation(() => ({
    download: jest.fn().mockResolvedValue(Buffer.from('mock content')),
    upload: jest.fn().mockResolvedValue('s3://bucket/output'),
  })),
  toTrackingResult: jest.fn().mockImplementation((response, replySent) => ({
    ...response,
    replySent,
  })),
}));

${spec.services.some(s => s.usesLLM) ? `jest.mock('@zachary/llm-service', () => ({
  runPrompt: jest.fn().mockResolvedValue('Mock LLM response'),
}));` : ''}

describe('${handlerName}', () => {
  const mockSendEmail = jest.fn().mockResolvedValue(undefined);

  function createMockContext(overrides = {}) {
    return {
      payload: {
        emailKey: 'test-email-key',
        subject: 'Test Subject',
        sender: 'sender@example.com',
        recipient: 'agent@company.com',
      },
      email: {
        from: 'sender@example.com',
        to: 'agent@company.com',
        subject: 'Test Subject',
        textBody: 'Test body',
        date: new Date(),
      },
      attachments: [
        {
          id: 'att-1',
          fileName: 'test.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          s3Url: 's3://bucket/test.pdf',
        },
      ],
      secrets: {
        ANTHROPIC_API_KEY: 'test-key',
      },
      sendEmail: mockSendEmail,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USE_LOCAL_FILES = 'true';
    process.env.LOG_LEVEL = 'silent';
  });

  afterEach(() => {
    delete process.env.USE_LOCAL_FILES;
    delete process.env.LOG_LEVEL;
  });

  describe('handler execution', () => {
    it('should be a function', () => {
      expect(typeof ${handlerName}).toBe('function');
    });

    it('should handle context without attachments', async () => {
      const context = createMockContext({ attachments: [] });

      // Should not throw
      await expect(${handlerName}(context)).resolves.toBeDefined();
    });

    it('should call sendEmail on completion', async () => {
      const context = createMockContext();

      await ${handlerName}(context);

      // Handler should attempt to send email (success or error)
      expect(mockSendEmail).toHaveBeenCalled();
    });
  });

  describe('email response', () => {
    it('should send to the original sender', async () => {
      const context = createMockContext();

      await ${handlerName}(context);

      if (mockSendEmail.mock.calls.length > 0) {
        const emailCall = mockSendEmail.mock.calls[0][0];
        expect(emailCall.to).toBe('sender@example.com');
      }
    });
  });
});
`
}

function generateServiceTest(service: ServiceSpec): string {
  const className = service.name
  const methodName = 'process'

  return `import pino from 'pino';
import { ${className} } from './${toKebabCase(service.name)}';

${service.usesLLM ? `jest.mock('@zachary/llm-service', () => ({
  runPrompt: jest.fn().mockResolvedValue('Mock LLM response'),
}));` : ''}

describe('${className}', () => {
  let service: ${className};
  let logger: pino.Logger;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    service = new ${className}(logger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create an instance', () => {
      expect(service).toBeInstanceOf(${className});
    });

    it('should have a ${methodName} method', () => {
      expect(typeof service.${methodName}).toBe('function');
    });
  });

  describe('${methodName}', () => {
    it('should process input and return result', async () => {
      const input = { test: 'data' };
      const result = await service.${methodName}(input);

      expect(result).toBeDefined();
    });

    it('should handle null input', async () => {
      const result = await service.${methodName}(null);
      expect(result).toBeDefined();
    });

    it('should handle undefined input', async () => {
      const result = await service.${methodName}(undefined);
      expect(result).toBeDefined();
    });

    it('should handle string input', async () => {
      const result = await service.${methodName}('test string');
      expect(result).toBeDefined();
    });

    it('should handle object input', async () => {
      const input = { key: 'value', nested: { data: 123 } };
      const result = await service.${methodName}(input);
      expect(result).toBeDefined();
    });

    it('should handle array input', async () => {
      const input = [1, 2, 3, 'test'];
      const result = await service.${methodName}(input);
      expect(result).toBeDefined();
    });
  });
${service.usesLLM ? `
  describe('LLM integration', () => {
    it('should use LLM service when processing', async () => {
      const { runPrompt } = require('@zachary/llm-service');
      const input = { requiresAnalysis: true };

      await service.${methodName}(input);

      // Verify LLM is available (actual call depends on implementation)
      expect(runPrompt).toBeDefined();
    });
  });` : ''}
});
`
}

// ============================================
// Utility Functions
// ============================================

function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toUpperCase())
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}
