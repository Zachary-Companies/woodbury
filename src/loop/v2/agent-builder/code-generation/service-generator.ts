/**
 * Service Code Generator
 * Uses AgentV2 to generate actual service implementations based on context
 */

import { AgentV2 } from '../../core/agent'
import { ToolRegistryV2 } from '../../tools/registry-v2'
import { NativeToolDefinition, AgentV2Config } from '../../types'
import { RAGKnowledgeBase } from '../../rag/knowledge-base-v2'

/**
 * Logger interface for code generation (pino-compatible)
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

export interface ServiceGenerationContext {
  agentName: string
  agentDescription: string
  agentId: string

  serviceName: string
  serviceDescription: string
  usesLLM: boolean

  // What the agent processes
  inputType: 'pdf' | 'email' | 'multiple-pdfs'
  inputDescription: string

  // What the agent outputs
  outputType: 'pdf' | 'excel' | 'powerpoint' | 'word' | 'email-only'
  outputDescription: string

  // Processing steps this service should help with
  processingSteps: string[]

  // Additional context from decomposition
  additionalContext?: string
}

export interface GeneratedServiceCode {
  code: string
  imports: string[]
  dependencies: string[]
  explanation: string
}

/**
 * Generate service implementation code using AgentV2
 */
export async function generateServiceCode(
  context: ServiceGenerationContext,
  knowledgeBase?: RAGKnowledgeBase,
  options: {
    model?: string
    maxIterations?: number
    logger?: Logger
  } = {}
): Promise<GeneratedServiceCode> {
  const logger = options.logger || createConsoleLogger()
  const model = options.model || 'claude-sonnet-4-20250514'

  // Create tool registry with code generation tool
  const registry = new ToolRegistryV2(logger)

  let generatedCode: GeneratedServiceCode | null = null

  // Register the submit_code tool
  const submitCodeDefinition: NativeToolDefinition = {
    name: 'submit_code',
    description: 'Submit the generated TypeScript service code. Call this once you have written the complete implementation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'The complete TypeScript service class code'
        },
        imports: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of import statements needed'
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of npm packages needed (e.g., "pdf-parse", "exceljs")'
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of the implementation approach'
        }
      },
      required: ['code', 'imports', 'explanation']
    }
  }

  const submitCodeHandler = async (params: Record<string, unknown>) => {
    generatedCode = {
      code: params.code as string,
      imports: (params.imports as string[]) || [],
      dependencies: (params.dependencies as string[]) || [],
      explanation: params.explanation as string
    }
    return 'Code submitted successfully'
  }

  registry.register(submitCodeDefinition, submitCodeHandler)

  // Build the system prompt
  const systemPrompt = buildCodeGenerationSystemPrompt(context)

  // Build the user message with context
  let userMessage = buildCodeGenerationUserMessage(context)

  // Add RAG context if available
  if (knowledgeBase) {
    const ragQuery = `${context.serviceName} implementation for ${context.agentName} that ${context.serviceDescription}`
    const ragContext = await knowledgeBase.retrieve(ragQuery, { topK: 5 })

    if (ragContext.chunks.length > 0) {
      userMessage += '\n\n## Reference Code Examples\n\n'
      userMessage += 'Here are relevant examples from similar agents:\n\n'

      for (const chunk of ragContext.chunks) {
        userMessage += `### From ${chunk.source}\n\`\`\`typescript\n${chunk.text}\n\`\`\`\n\n`
      }
    }
  }

  // Create agent config
  const agentConfig: AgentV2Config = {
    model,
    systemPrompt,
    maxIterations: options.maxIterations || 10,
    timeoutMs: 120000,
    humanInTheLoop: false
  }

  // Create and run the agent
  const agent = new AgentV2(agentConfig, registry, logger)

  logger.info({ serviceName: context.serviceName }, 'Starting service code generation')

  const result = await agent.run(userMessage)

  if (result.status !== 'success' || !generatedCode) {
    throw new Error(`Code generation failed: ${result.error || 'No code was submitted'}`)
  }

  // TypeScript narrowing doesn't work across closure boundaries, so we cast
  const finalCode = generatedCode as GeneratedServiceCode

  logger.info({
    serviceName: context.serviceName,
    codeLength: finalCode.code.length,
    dependencies: finalCode.dependencies
  }, 'Service code generation complete')

  return finalCode
}

/**
 * Build the system prompt for code generation
 */
function buildCodeGenerationSystemPrompt(context: ServiceGenerationContext): string {
  return `You are an expert TypeScript developer specializing in building email processing agents.

Your task is to implement a service class that will be used by an agent processor. The service should be production-ready, well-structured, and follow best practices.

## Critical API Information

### @zachary/llm-service
The LLM service uses a simple function-based API. **DO NOT use a class-based approach.**

\`\`\`typescript
import { runPrompt } from '@zachary/llm-service';

// Correct usage - runPrompt takes (messages, model) arguments
const messages = [{ role: 'user' as const, content: 'Your prompt here' }];
const response = await runPrompt(messages, 'claude-sonnet-4-20250514');
// response is a string containing the LLM's response
\`\`\`

### PDF Parsing
Use pdf-parse with default import:

\`\`\`typescript
import pdfParse from 'pdf-parse';

const pdfData = await pdfParse(pdfBuffer);
// pdfData.text contains the extracted text
// pdfData.numpages contains page count
\`\`\`

### PDF Generation
Use pdfkit for generating PDFs:

\`\`\`typescript
import PDFDocument from 'pdfkit';

const doc = new PDFDocument();
const chunks: Buffer[] = [];
doc.on('data', chunk => chunks.push(chunk));
doc.on('end', () => {
  const pdfBuffer = Buffer.concat(chunks);
});
doc.fontSize(12).text('Hello World');
doc.end();
\`\`\`

### Excel Generation
Use exceljs for Excel files:

\`\`\`typescript
import ExcelJS from 'exceljs';

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Sheet1');
sheet.addRow(['Header1', 'Header2']);
const buffer = await workbook.xlsx.writeBuffer();
\`\`\`

### Pino Logger
Services receive a pino logger in the constructor:

\`\`\`typescript
import pino from 'pino';

export class MyService {
  private readonly logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ service: 'MyService' });
  }

  async process(input: unknown): Promise<unknown> {
    // Log with context object first, then message
    this.logger.info({ inputSize: 100 }, 'Starting processing');

    try {
      // ... implementation
      this.logger.info('Processing complete');
      return result;
    } catch (error) {
      this.logger.error({ err: error }, 'Processing failed');
      throw error;
    }
  }
}
\`\`\`

## Guidelines

1. **Use TypeScript** with proper types and interfaces
2. **Handle errors gracefully** with try-catch blocks and meaningful error messages
3. **Log important operations** using the pino logger pattern shown above
4. **Services should be stateless** - don't store request-specific data as instance properties
5. **Use async/await** for all async operations

## Code Structure

Your service class MUST follow this exact pattern:

\`\`\`typescript
import pino from 'pino';
// Add other imports as needed (see API Information above)

export interface ServiceInput {
  // Define your input type with specific fields
}

export interface ServiceOutput {
  // Define your output type with specific fields
}

export class ServiceName {
  private readonly logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ service: 'ServiceName' });
  }

  async process(input: ServiceInput): Promise<ServiceOutput> {
    this.logger.info({ /* relevant context */ }, 'Starting processing');

    try {
      // Your implementation here

      this.logger.info('Processing complete');
      return result;
    } catch (error) {
      this.logger.error({ err: error }, 'Processing failed');
      throw error;
    }
  }
}
\`\`\`

## Important Notes

- DO NOT import from '@zachary/email-processor-types' - this package doesn't exist
- DO NOT use \`import * as pdfParse from 'pdf-parse'\` - use default import instead
- DO NOT create an LLMService class instance - use the runPrompt function directly
- DO NOT use deprecated or non-existent APIs

When you have written the complete implementation, use the submit_code tool to submit it.`
}

/**
 * Build the user message for code generation
 */
function buildCodeGenerationUserMessage(context: ServiceGenerationContext): string {
  return `## Task

Generate the implementation for **${context.serviceName}** service.

## Agent Context

- **Agent Name:** ${context.agentName}
- **Agent ID:** ${context.agentId}
- **Agent Description:** ${context.agentDescription}

## Service Requirements

- **Service Name:** ${context.serviceName}
- **Description:** ${context.serviceDescription}
- **Uses LLM:** ${context.usesLLM ? 'Yes - use @zachary/llm-service' : 'No'}

## Input/Output

- **Input Type:** ${context.inputType}
- **Input Description:** ${context.inputDescription}
- **Output Type:** ${context.outputType}
- **Output Description:** ${context.outputDescription}

## Processing Steps This Service Supports

${context.processingSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

${context.additionalContext ? `## Additional Context\n\n${context.additionalContext}` : ''}

## Instructions

1. Analyze the requirements above
2. Design appropriate TypeScript interfaces for input/output
3. Implement the service class with all necessary methods
4. Include proper error handling and logging
5. Use the submit_code tool to submit your implementation

Focus on making the implementation practical and production-ready. The service will be called from the agent's processor class.`
}

/**
 * Generate multiple services for an agent
 */
export async function generateAllServices(
  agentContext: {
    name: string
    description: string
    agentId: string
    inputType: 'pdf' | 'email' | 'multiple-pdfs'
    inputDescription: string
    outputType: 'pdf' | 'excel' | 'powerpoint' | 'word' | 'email-only'
    outputDescription: string
    processingSteps: string[]
  },
  services: Array<{
    name: string
    description: string
    usesLLM: boolean
  }>,
  knowledgeBase?: RAGKnowledgeBase,
  options: {
    model?: string
    logger?: Logger
  } = {}
): Promise<Map<string, GeneratedServiceCode>> {
  const results = new Map<string, GeneratedServiceCode>()
  const logger = options.logger || createConsoleLogger()

  for (const service of services) {
    logger.info({ serviceName: service.name }, 'Generating service code')

    const context: ServiceGenerationContext = {
      agentName: agentContext.name,
      agentDescription: agentContext.description,
      agentId: agentContext.agentId,
      serviceName: service.name,
      serviceDescription: service.description,
      usesLLM: service.usesLLM,
      inputType: agentContext.inputType,
      inputDescription: agentContext.inputDescription,
      outputType: agentContext.outputType,
      outputDescription: agentContext.outputDescription,
      processingSteps: agentContext.processingSteps
    }

    try {
      const generated = await generateServiceCode(context, knowledgeBase, {
        model: options.model,
        logger
      })
      results.set(service.name, generated)
    } catch (error) {
      logger.error({ err: error, serviceName: service.name }, 'Failed to generate service')
      throw error
    }
  }

  return results
}
