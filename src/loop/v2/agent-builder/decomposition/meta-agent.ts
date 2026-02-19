/**
 * Meta-Agent for Idea Decomposition
 * Uses AgentV2 to analyze ideas and decompose them into agent components
 */

import { AgentV2 } from '../../core/agent'
import { ToolRegistryV2 } from '../../tools/registry-v2'
import { NativeToolDefinition } from '../../types/tool-types'
import { AgentEventEmitter, SimpleEventEmitter, ProgressEvent } from '../../types/events'
import { AgentV2Config } from '../../types'
import {
  DecompositionResult,
  IdentifiedConnector,
  IdentifiedProcessor,
  IdentifiedAction,
  IdentifiedTrigger,
  RequiredAPI,
  PendingClarification,
  ClarificationAnswer,
  createEmptyDecomposition,
  calculateConfidence,
  DecompositionStatus,
  DataFlowGraph,
  DataFlowNode,
  DataFlowEdge,
  InputRequirements,
  AttachmentType,
  InputSource,
  InputFormat
} from './component-types'
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  getDecompositionToolDescriptions
} from './prompts'

/**
 * Configuration for the decomposition meta-agent
 */
export interface DecompositionConfig {
  /** LLM model to use */
  model: string

  /** Provider (anthropic, openai, groq) */
  provider?: 'anthropic' | 'openai' | 'groq'

  /** Maximum iterations for decomposition */
  maxIterations?: number

  /** Timeout in milliseconds */
  timeoutMs?: number

  /** Whether to enable streaming */
  streaming?: boolean

  /** Event emitter for progress updates */
  eventEmitter?: AgentEventEmitter
}

/**
 * Decomposition session state
 */
interface DecompositionSession {
  id: string
  result: DecompositionResult
  pendingQuestionResolver?: (answer: string) => void
  pendingQuestionRejecter?: (error: Error) => void
}

/**
 * Meta-agent for decomposing ideas into agent components
 */
/**
 * Simple logger for decomposition agent
 */
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg)
}

/**
 * Meta-agent for decomposing ideas into agent components
 */
export class DecompositionMetaAgent {
  private config: DecompositionConfig
  private session: DecompositionSession | null = null
  private eventEmitter: AgentEventEmitter
  private logger: Logger

  constructor(config: DecompositionConfig) {
    this.config = config
    this.eventEmitter = config.eventEmitter || new SimpleEventEmitter()
    this.logger = defaultLogger
  }

  /**
   * Start decomposing an idea
   */
  async decompose(idea: string, signal?: AbortSignal): Promise<DecompositionResult> {
    const sessionId = this.generateSessionId()
    this.session = {
      id: sessionId,
      result: createEmptyDecomposition(sessionId)
    }

    this.emitUpdate('status_changed', { status: 'analyzing' })

    // Create the tool registry with decomposition tools
    const registry = this.createToolRegistry()

    // Create the agent
    const agentConfig: AgentV2Config = {
      model: this.config.model,
      provider: this.config.provider,
      systemPrompt: this.buildSystemPrompt(),
      maxIterations: this.config.maxIterations || 30,
      timeoutMs: this.config.timeoutMs || 180000,
      streaming: this.config.streaming ?? true,
      humanInTheLoop: true,
      eventEmitter: this.eventEmitter
    }

    const agent = new AgentV2(agentConfig, registry, this.logger)

    // Run the agent
    const prompt = `Please analyze and decompose this idea into agent components:\n\n${idea}\n\nStart by understanding the idea, then identify all necessary components.`

    try {
      const result = await agent.run(prompt, signal)

      // Update final status based on result
      if (result.status === 'success') {
        this.session.result.status = 'complete'
        this.session.result.confidence = calculateConfidence(this.session.result)
        this.emitUpdate('complete', this.session.result)
      } else if (result.status === 'cancelled') {
        this.session.result.status = 'error'
        this.session.result.warnings.push('Decomposition was cancelled')
      } else {
        this.session.result.status = 'error'
        this.session.result.warnings.push(`Decomposition ended with status: ${result.status}`)
      }

      return this.session.result
    } catch (error) {
      this.session.result.status = 'error'
      this.session.result.warnings.push(`Error: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * Submit an answer to a clarification question
   */
  submitAnswer(answer: ClarificationAnswer): void {
    if (this.session?.pendingQuestionResolver) {
      this.session.pendingQuestionResolver(answer.answer)
      this.session.pendingQuestionResolver = undefined
      this.session.pendingQuestionRejecter = undefined
    }
  }

  /**
   * Cancel a pending question
   */
  cancelQuestion(reason: string = 'User cancelled'): void {
    if (this.session?.pendingQuestionRejecter) {
      this.session.pendingQuestionRejecter(new Error(reason))
      this.session.pendingQuestionResolver = undefined
      this.session.pendingQuestionRejecter = undefined
    }
  }

  /**
   * Get the current decomposition result
   */
  getCurrentResult(): DecompositionResult | null {
    return this.session?.result || null
  }

  /**
   * Build the system prompt with tool descriptions
   */
  private buildSystemPrompt(): string {
    return DECOMPOSITION_SYSTEM_PROMPT + '\n\n' + getDecompositionToolDescriptions()
  }

  /**
   * Create the tool registry with decomposition tools
   */
  private createToolRegistry(): ToolRegistryV2 {
    const registry = new ToolRegistryV2(this.logger)

    // analyze_idea tool
    registry.register(
      this.createToolDefinition('analyze_idea', 'Analyze the user\'s idea to extract key information', {
        type: 'object',
        properties: {
          idea: {
            type: 'string',
            description: 'The idea to analyze'
          }
        },
        required: ['idea']
      }),
      async (input) => this.handleAnalyzeIdea(input as { idea: string })
    )

    // ask_clarification tool
    registry.register(
      this.createToolDefinition('ask_clarification', 'Ask the user a clarifying question', {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          context: { type: 'string', description: 'Context explaining why this is needed' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional choices for the user'
          },
          importance: {
            type: 'string',
            enum: ['required', 'recommended', 'optional'],
            description: 'How important is this clarification'
          },
          defaultValue: { type: 'string', description: 'Optional default value' }
        },
        required: ['question', 'context', 'importance']
      }),
      async (input) => this.handleAskClarification(input as {
        question: string
        context: string
        options?: string[]
        importance: 'required' | 'recommended' | 'optional'
        defaultValue?: string
      })
    )

    // identify_connector tool
    registry.register(
      this.createToolDefinition('identify_connector', 'Register an identified connector component', {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the connector' },
          description: { type: 'string', description: 'What the connector does' },
          type: {
            type: 'string',
            enum: ['rest_api', 'graphql', 'email', 'database', 'file_system', 'custom'],
            description: 'Type of connector'
          },
          externalSystem: { type: 'string', description: 'External system this connects to' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                isMutating: { type: 'boolean' }
              },
              required: ['name', 'description', 'isMutating']
            },
            description: 'Operations this connector supports'
          },
          authType: {
            type: 'string',
            enum: ['oauth2', 'api_key', 'basic', 'bearer', 'none', 'unknown'],
            description: 'Authentication type required'
          },
          needsApiDoc: { type: 'boolean', description: 'Whether API documentation is needed' }
        },
        required: ['name', 'description', 'type', 'externalSystem', 'operations', 'authType', 'needsApiDoc']
      }),
      async (input) => this.handleIdentifyConnector(input as {
        name: string
        description: string
        type: 'rest_api' | 'graphql' | 'email' | 'database' | 'file_system' | 'custom'
        externalSystem: string
        operations: { name: string; description: string; httpMethod?: string; isMutating: boolean }[]
        authType: string
        needsApiDoc: boolean
      })
    )

    // identify_processor tool
    registry.register(
      this.createToolDefinition('identify_processor', 'Register an identified processor component', {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the processor' },
          description: { type: 'string', description: 'What the processor does' },
          type: {
            type: 'string',
            enum: ['filter', 'transform', 'aggregate', 'classify', 'enrich', 'validate', 'custom'],
            description: 'Type of processor'
          },
          inputDescription: { type: 'string', description: 'Description of input data' },
          outputDescription: { type: 'string', description: 'Description of output data' },
          logicDescription: { type: 'string', description: 'Description of processing logic' },
          filterCriteria: { type: 'string', description: 'For filter type: the criteria' },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'For classify type: the categories'
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of components this depends on'
          }
        },
        required: ['name', 'description', 'type', 'inputDescription', 'outputDescription', 'logicDescription']
      }),
      async (input) => this.handleIdentifyProcessor(input as {
        name: string
        description: string
        type: 'filter' | 'transform' | 'aggregate' | 'classify' | 'enrich' | 'validate' | 'custom'
        inputDescription: string
        outputDescription: string
        logicDescription: string
        filterCriteria?: string
        categories?: string[]
        dependsOn?: string[]
      })
    )

    // identify_action tool
    registry.register(
      this.createToolDefinition('identify_action', 'Register an identified action component', {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the action' },
          description: { type: 'string', description: 'What the action does' },
          type: {
            type: 'string',
            enum: ['notify', 'create', 'update', 'delete', 'send', 'custom'],
            description: 'Type of action'
          },
          usesConnector: { type: 'string', description: 'ID of the connector this action uses' },
          operation: { type: 'string', description: 'Which operation on the connector' },
          requiresApproval: { type: 'boolean', description: 'Whether this action requires human approval' },
          approvalReason: { type: 'string', description: 'Why approval is required' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of components this depends on'
          }
        },
        required: ['name', 'description', 'type', 'usesConnector', 'operation', 'requiresApproval']
      }),
      async (input) => this.handleIdentifyAction(input as {
        name: string
        description: string
        type: 'notify' | 'create' | 'update' | 'delete' | 'send' | 'custom'
        usesConnector: string
        operation: string
        requiresApproval: boolean
        approvalReason?: string
        dependsOn?: string[]
      })
    )

    // identify_trigger tool
    registry.register(
      this.createToolDefinition('identify_trigger', 'Register an identified trigger', {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the trigger' },
          type: {
            type: 'string',
            enum: ['schedule', 'webhook', 'event', 'manual'],
            description: 'Type of trigger'
          },
          scheduleDescription: { type: 'string', description: 'For schedule: human-readable description' },
          suggestedCron: { type: 'string', description: 'For schedule: cron expression' },
          webhookPayload: { type: 'string', description: 'For webhook: expected payload' },
          eventSource: { type: 'string', description: 'For event: the source system' },
          eventType: { type: 'string', description: 'For event: the event type' }
        },
        required: ['name', 'type']
      }),
      async (input) => this.handleIdentifyTrigger(input as {
        name: string
        type: 'schedule' | 'webhook' | 'event' | 'manual'
        scheduleDescription?: string
        suggestedCron?: string
        webhookPayload?: string
        eventSource?: string
        eventType?: string
      })
    )

    // add_required_api tool
    registry.register(
      this.createToolDefinition('add_required_api', 'Note an API that needs documentation', {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the API' },
          purpose: { type: 'string', description: 'Purpose in this agent' },
          suggestedSources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Suggested documentation URLs'
          },
          hasOpenApiSpec: { type: 'boolean', description: 'Whether OpenAPI spec is available' },
          endpointsNeeded: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific endpoints needed'
          }
        },
        required: ['name', 'purpose', 'suggestedSources', 'hasOpenApiSpec', 'endpointsNeeded']
      }),
      async (input) => this.handleAddRequiredAPI(input as {
        name: string
        purpose: string
        suggestedSources: string[]
        hasOpenApiSpec: boolean
        endpointsNeeded: string[]
      })
    )

    // identify_input_requirements tool
    registry.register(
      this.createToolDefinition('identify_input_requirements', 'Specify what input data/attachments the agent requires', {
        type: 'object',
        properties: {
          requiresAttachments: {
            type: 'boolean',
            description: 'Whether the agent requires file attachments to process'
          },
          attachmentTypes: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['pdf', 'excel', 'csv', 'word', 'image', 'json', 'xml', 'text', 'any']
            },
            description: 'Types of attachments expected (if requiresAttachments is true)'
          },
          inputSource: {
            type: 'string',
            enum: ['email_attachment', 'api_fetch', 'webhook_payload', 'manual_upload', 'scheduled_pull', 'database_query', 'file_system'],
            description: 'Primary source of input data'
          },
          inputFormats: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['structured_data', 'document', 'spreadsheet', 'image', 'text', 'email']
            },
            description: 'Expected input formats'
          },
          inputDescription: {
            type: 'string',
            description: 'Description of expected input data'
          },
          supportsEmailInput: {
            type: 'boolean',
            description: 'Whether input can be provided via email'
          },
          supportsWebhookInput: {
            type: 'boolean',
            description: 'Whether input can be provided via webhook/API'
          },
          supportsManualUpload: {
            type: 'boolean',
            description: 'Whether input can be uploaded manually'
          },
          sampleInputDescription: {
            type: 'string',
            description: 'Sample input description for testing'
          }
        },
        required: ['requiresAttachments', 'inputSource', 'inputDescription', 'supportsEmailInput', 'supportsWebhookInput', 'supportsManualUpload']
      }),
      async (input) => this.handleIdentifyInputRequirements(input as {
        requiresAttachments: boolean
        attachmentTypes?: AttachmentType[]
        inputSource: InputSource
        inputFormats?: InputFormat[]
        inputDescription: string
        supportsEmailInput: boolean
        supportsWebhookInput: boolean
        supportsManualUpload: boolean
        sampleInputDescription?: string
      })
    )

    // finalize_decomposition tool
    registry.register(
      this.createToolDefinition('finalize_decomposition', 'Complete the decomposition with final understanding', {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Brief summary of what the agent does' },
          goals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Primary goals of the agent'
          },
          suggestedName: { type: 'string', description: 'Suggested name for the agent' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Any warnings or concerns'
          }
        },
        required: ['summary', 'goals', 'suggestedName']
      }),
      async (input) => this.handleFinalizeDecomposition(input as {
        summary: string
        goals: string[]
        suggestedName: string
        warnings?: string[]
      })
    )

    return registry
  }

  /**
   * Create a tool definition
   */
  private createToolDefinition(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>
  ): NativeToolDefinition {
    return {
      name,
      description,
      input_schema: inputSchema as unknown as NativeToolDefinition['input_schema']
    }
  }

  /**
   * Handle analyze_idea tool call
   */
  private async handleAnalyzeIdea(input: { idea: string }): Promise<string> {
    // Store the original idea
    if (this.session) {
      // The idea is already in the decomposition from the initial prompt
      this.emitUpdate('status_changed', { status: 'analyzing' })
    }

    return `Idea received and ready for analysis. Now identify the components needed to implement this agent. Start by identifying connectors (external APIs/systems), then processors (data transformations), actions (side effects), and triggers (what starts the agent).`
  }

  /**
   * Handle ask_clarification tool call
   */
  private async handleAskClarification(input: {
    question: string
    context: string
    options?: string[]
    importance: 'required' | 'recommended' | 'optional'
    defaultValue?: string
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const clarificationId = `clarify_${Date.now()}`

    const clarification: PendingClarification = {
      id: clarificationId,
      question: input.question,
      context: input.context,
      options: input.options,
      inputType: input.options ? 'choice' : 'text',
      importance: input.importance,
      defaultValue: input.defaultValue
    }

    this.session.result.pendingClarifications.push(clarification)
    this.session.result.status = 'needs_clarification'
    this.emitUpdate('clarification_needed', clarification)

    // Wait for the answer
    return new Promise<string>((resolve, reject) => {
      this.session!.pendingQuestionResolver = (answer: string) => {
        // Remove from pending and store in result
        this.session!.result.pendingClarifications =
          this.session!.result.pendingClarifications.filter(c => c.id !== clarificationId)

        resolve(`User answered: ${answer}`)
      }
      this.session!.pendingQuestionRejecter = reject
    })
  }

  /**
   * Handle identify_connector tool call
   */
  private async handleIdentifyConnector(input: {
    name: string
    description: string
    type: 'rest_api' | 'graphql' | 'email' | 'database' | 'file_system' | 'custom'
    externalSystem: string
    operations: { name: string; description: string; httpMethod?: string; isMutating: boolean }[]
    authType: string
    needsApiDoc: boolean
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const connectorId = `connector_${this.session.result.components.connectors.length + 1}`

    const connector: IdentifiedConnector = {
      id: connectorId,
      name: input.name,
      description: input.description,
      type: input.type,
      externalSystem: input.externalSystem,
      requiredOperations: input.operations.map(op => ({
        name: op.name,
        description: op.description,
        httpMethod: op.httpMethod as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined,
        isMutating: op.isMutating
      })),
      authRequirements: {
        type: input.authType as 'oauth2' | 'api_key' | 'basic' | 'bearer' | 'none' | 'unknown',
        description: `${input.authType} authentication required`
      },
      needsApiDoc: input.needsApiDoc,
      priority: this.session.result.components.connectors.length + 1
    }

    this.session.result.components.connectors.push(connector)
    this.emitUpdate('component_identified', { type: 'connector', component: connector })

    return `Connector "${input.name}" (ID: ${connectorId}) registered successfully. External system: ${input.externalSystem}, ${input.operations.length} operations identified.`
  }

  /**
   * Handle identify_processor tool call
   */
  private async handleIdentifyProcessor(input: {
    name: string
    description: string
    type: 'filter' | 'transform' | 'aggregate' | 'classify' | 'enrich' | 'validate' | 'custom'
    inputDescription: string
    outputDescription: string
    logicDescription: string
    filterCriteria?: string
    categories?: string[]
    dependsOn?: string[]
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const processorId = `processor_${this.session.result.components.processors.length + 1}`

    const processor: IdentifiedProcessor = {
      id: processorId,
      name: input.name,
      description: input.description,
      type: input.type,
      inputDescription: input.inputDescription,
      outputDescription: input.outputDescription,
      logicDescription: input.logicDescription,
      filterCriteria: input.filterCriteria,
      categories: input.categories,
      dependsOn: input.dependsOn || [],
      priority: this.session.result.components.processors.length + 1
    }

    this.session.result.components.processors.push(processor)
    this.emitUpdate('component_identified', { type: 'processor', component: processor })

    return `Processor "${input.name}" (ID: ${processorId}) registered successfully. Type: ${input.type}.`
  }

  /**
   * Handle identify_action tool call
   */
  private async handleIdentifyAction(input: {
    name: string
    description: string
    type: 'notify' | 'create' | 'update' | 'delete' | 'send' | 'custom'
    usesConnector: string
    operation: string
    requiresApproval: boolean
    approvalReason?: string
    dependsOn?: string[]
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const actionId = `action_${this.session.result.components.actions.length + 1}`

    const action: IdentifiedAction = {
      id: actionId,
      name: input.name,
      description: input.description,
      type: input.type,
      usesConnector: input.usesConnector,
      operation: input.operation,
      suggestedApprovalRequired: input.requiresApproval,
      approvalReason: input.approvalReason,
      dependsOn: input.dependsOn || [],
      priority: this.session.result.components.actions.length + 1
    }

    this.session.result.components.actions.push(action)
    this.emitUpdate('component_identified', { type: 'action', component: action })

    const approvalNote = input.requiresApproval ? ' (requires approval)' : ''
    return `Action "${input.name}" (ID: ${actionId}) registered successfully. Type: ${input.type}, uses connector: ${input.usesConnector}${approvalNote}.`
  }

  /**
   * Handle identify_trigger tool call
   */
  private async handleIdentifyTrigger(input: {
    name: string
    type: 'schedule' | 'webhook' | 'event' | 'manual'
    scheduleDescription?: string
    suggestedCron?: string
    webhookPayload?: string
    eventSource?: string
    eventType?: string
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const triggerId = `trigger_${this.session.result.components.triggers.length + 1}`

    const trigger: IdentifiedTrigger = {
      id: triggerId,
      name: input.name,
      type: input.type,
      scheduleDescription: input.scheduleDescription,
      suggestedCron: input.suggestedCron,
      webhookPayload: input.webhookPayload,
      eventSource: input.eventSource,
      eventType: input.eventType,
      priority: this.session.result.components.triggers.length + 1
    }

    this.session.result.components.triggers.push(trigger)
    this.emitUpdate('component_identified', { type: 'trigger', component: trigger })

    let details = ''
    if (input.type === 'schedule' && input.suggestedCron) {
      details = ` (cron: ${input.suggestedCron})`
    } else if (input.type === 'event' && input.eventSource) {
      details = ` (source: ${input.eventSource})`
    }

    return `Trigger "${input.name}" (ID: ${triggerId}) registered successfully. Type: ${input.type}${details}.`
  }

  /**
   * Handle add_required_api tool call
   */
  private async handleAddRequiredAPI(input: {
    name: string
    purpose: string
    suggestedSources: string[]
    hasOpenApiSpec: boolean
    endpointsNeeded: string[]
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const api: RequiredAPI = {
      name: input.name,
      purpose: input.purpose,
      suggestedSources: input.suggestedSources,
      hasOpenApiSpec: input.hasOpenApiSpec,
      endpointsNeeded: input.endpointsNeeded,
      priority: this.session.result.requiredAPIs.length + 1
    }

    this.session.result.requiredAPIs.push(api)
    this.emitUpdate('api_requirement_found', api)

    const openApiNote = input.hasOpenApiSpec ? ' (OpenAPI spec available)' : ' (may need manual doc parsing)'
    return `Required API "${input.name}" registered. Purpose: ${input.purpose}${openApiNote}. ${input.endpointsNeeded.length} endpoints needed.`
  }

  /**
   * Handle identify_input_requirements tool call
   */
  private async handleIdentifyInputRequirements(input: {
    requiresAttachments: boolean
    attachmentTypes?: AttachmentType[]
    inputSource: InputSource
    inputFormats?: InputFormat[]
    inputDescription: string
    supportsEmailInput: boolean
    supportsWebhookInput: boolean
    supportsManualUpload: boolean
    sampleInputDescription?: string
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    const inputRequirements: InputRequirements = {
      requiresAttachments: input.requiresAttachments,
      attachmentTypes: input.attachmentTypes,
      inputSource: input.inputSource,
      inputFormats: input.inputFormats,
      inputDescription: input.inputDescription,
      supportsEmailInput: input.supportsEmailInput,
      supportsWebhookInput: input.supportsWebhookInput,
      supportsManualUpload: input.supportsManualUpload,
      sampleInputDescription: input.sampleInputDescription
    }

    this.session.result.understanding.inputRequirements = inputRequirements
    this.emitUpdate('understanding_updated', { inputRequirements })

    const attachmentNote = input.requiresAttachments
      ? `Requires attachments: ${input.attachmentTypes?.join(', ') || 'any'}`
      : 'No attachments required'

    const inputChannels = [
      input.supportsEmailInput && 'email',
      input.supportsWebhookInput && 'webhook/API',
      input.supportsManualUpload && 'manual upload'
    ].filter(Boolean).join(', ')

    return `Input requirements identified:
- ${attachmentNote}
- Primary source: ${input.inputSource}
- Input channels: ${inputChannels}
- Description: ${input.inputDescription}`
  }

  /**
   * Handle finalize_decomposition tool call
   */
  private async handleFinalizeDecomposition(input: {
    summary: string
    goals: string[]
    suggestedName: string
    warnings?: string[]
  }): Promise<string> {
    if (!this.session) {
      return 'Error: No active decomposition session'
    }

    // Update understanding (preserve inputRequirements if already set)
    const existingInputRequirements = this.session.result.understanding.inputRequirements
    this.session.result.understanding = {
      summary: input.summary,
      goals: input.goals,
      entities: [], // These could be extracted from components
      externalSystems: this.session.result.components.connectors.map(c => ({
        name: c.externalSystem,
        type: c.type === 'rest_api' ? 'api' : c.type === 'email' ? 'email' : 'unknown' as const,
        purpose: c.description
      })),
      constraints: [],
      suggestedName: input.suggestedName,
      inputRequirements: existingInputRequirements
    }

    // Add warnings
    if (input.warnings) {
      this.session.result.warnings.push(...input.warnings)
    }

    // Build data flow graph
    this.session.result.dataFlow = this.buildDataFlowGraph()

    // Calculate confidence
    this.session.result.confidence = calculateConfidence(this.session.result)

    // Update status
    this.session.result.status = 'complete'
    this.emitUpdate('complete', this.session.result)

    // Summary
    const components = this.session.result.components
    return `Decomposition complete!

**${input.suggestedName}**: ${input.summary}

**Goals:** ${input.goals.join(', ')}

**Components Identified:**
- ${components.connectors.length} connector(s)
- ${components.processors.length} processor(s)
- ${components.actions.length} action(s)
- ${components.triggers.length} trigger(s)

**Required APIs:** ${this.session.result.requiredAPIs.map(a => a.name).join(', ') || 'None'}

**Confidence:** ${Math.round(this.session.result.confidence * 100)}%

The decomposition is ready for review and component configuration.`
  }

  /**
   * Build the data flow graph from identified components
   */
  private buildDataFlowGraph(): DataFlowGraph {
    if (!this.session) {
      return { nodes: [], edges: [] }
    }

    const nodes: DataFlowNode[] = []
    const edges: DataFlowEdge[] = []

    // Add trigger nodes
    for (const trigger of this.session.result.components.triggers) {
      nodes.push({
        id: `node_${trigger.id}`,
        type: 'trigger',
        componentId: trigger.id,
        label: trigger.name
      })
    }

    // Add connector nodes
    for (const connector of this.session.result.components.connectors) {
      nodes.push({
        id: `node_${connector.id}`,
        type: 'connector',
        componentId: connector.id,
        label: connector.name
      })
    }

    // Add processor nodes
    for (const processor of this.session.result.components.processors) {
      nodes.push({
        id: `node_${processor.id}`,
        type: 'processor',
        componentId: processor.id,
        label: processor.name
      })

      // Add edges for dependencies
      for (const depId of processor.dependsOn) {
        edges.push({
          from: `node_${depId}`,
          to: `node_${processor.id}`,
          dataDescription: 'Input data'
        })
      }
    }

    // Add action nodes
    for (const action of this.session.result.components.actions) {
      nodes.push({
        id: `node_${action.id}`,
        type: 'action',
        componentId: action.id,
        label: action.name
      })

      // Add edges for dependencies
      for (const depId of action.dependsOn) {
        edges.push({
          from: `node_${depId}`,
          to: `node_${action.id}`,
          dataDescription: 'Processed data'
        })
      }
    }

    // Connect triggers to first connectors if no explicit dependencies
    if (edges.length === 0 && nodes.length > 1) {
      const triggerNodes = nodes.filter(n => n.type === 'trigger')
      const connectorNodes = nodes.filter(n => n.type === 'connector')
      for (const trigger of triggerNodes) {
        for (const connector of connectorNodes) {
          edges.push({
            from: trigger.id,
            to: connector.id,
            dataDescription: 'Trigger starts data fetch'
          })
        }
      }
    }

    return { nodes, edges }
  }

  /**
   * Emit an update event
   */
  private emitUpdate(updateType: string, data: unknown): void {
    const progressEvent: ProgressEvent = {
      type: 'progress',
      phase: 'analyzing',
      percentage: 0,
      iteration: 0,
      maxIterations: this.config.maxIterations || 30,
      message: `Decomposition update: ${updateType}`,
      timestamp: Date.now(),
      sessionId: this.session?.id || ''
    }
    this.eventEmitter.emit(progressEvent)
  }

  /**
   * Generate a session ID
   */
  private generateSessionId(): string {
    return `decomp_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`
  }
}

/**
 * Create a decomposition meta-agent with default configuration
 */
export function createDecompositionAgent(
  config: Partial<DecompositionConfig> & { model: string }
): DecompositionMetaAgent {
  return new DecompositionMetaAgent({
    maxIterations: 30,
    timeoutMs: 180000,
    streaming: true,
    ...config
  })
}
