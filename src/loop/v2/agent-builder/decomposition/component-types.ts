/**
 * Component Types for Decomposition
 * Defines the intermediate types used during idea decomposition
 */

import { JSONSchema } from '../../types/tool-types'

/**
 * Result of analyzing and decomposing an idea
 */
export interface DecompositionResult {
  /** Unique ID for this decomposition session */
  sessionId: string

  /** Understanding of the user's idea */
  understanding: IdeaUnderstanding

  /** Identified components needed */
  components: IdentifiedComponents

  /** Required API integrations */
  requiredAPIs: RequiredAPI[]

  /** Data flow between components */
  dataFlow: DataFlowGraph

  /** Questions that need user clarification */
  pendingClarifications: PendingClarification[]

  /** Confidence score for the decomposition (0-1) */
  confidence: number

  /** Any warnings or concerns */
  warnings: string[]

  /** Status of the decomposition */
  status: DecompositionStatus
}

export type DecompositionStatus =
  | 'analyzing'
  | 'needs_clarification'
  | 'identifying_components'
  | 'complete'
  | 'error'

/**
 * Parsed understanding of the user's idea
 */
export interface IdeaUnderstanding {
  /** Brief summary of what the agent should do */
  summary: string

  /** Primary goals the agent should achieve */
  goals: string[]

  /** Key entities/objects the agent works with */
  entities: EntityDefinition[]

  /** External systems mentioned or implied */
  externalSystems: ExternalSystem[]

  /** Constraints or requirements mentioned */
  constraints: string[]

  /** Inferred frequency of execution */
  suggestedFrequency?: ExecutionFrequency

  /** Suggested name for the agent */
  suggestedName: string

  /** Input requirements - what data the agent needs to operate */
  inputRequirements?: InputRequirements
}

export interface EntityDefinition {
  name: string
  description: string
  properties: string[]
  source?: string
}

export interface ExternalSystem {
  name: string
  type: 'api' | 'email' | 'database' | 'file' | 'unknown'
  purpose: string
  knownApiDocs?: string
}

export type ExecutionFrequency =
  | 'realtime'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'on_demand'
  | 'event_driven'

/**
 * Input requirements for the agent
 * Describes what kind of input data the agent needs to operate
 */
export interface InputRequirements {
  /** Whether the agent requires file attachments to process */
  requiresAttachments: boolean

  /** Types of attachments expected (if requiresAttachments is true) */
  attachmentTypes?: AttachmentType[]

  /** Primary source of input data */
  inputSource: InputSource

  /** Expected input formats */
  inputFormats?: InputFormat[]

  /** Description of expected input */
  inputDescription: string

  /** Whether input can be provided via email */
  supportsEmailInput: boolean

  /** Whether input can be provided via webhook/API */
  supportsWebhookInput: boolean

  /** Whether input can be uploaded manually */
  supportsManualUpload: boolean

  /** Sample input description for testing */
  sampleInputDescription?: string
}

export type AttachmentType =
  | 'pdf'
  | 'excel'
  | 'csv'
  | 'word'
  | 'image'
  | 'json'
  | 'xml'
  | 'text'
  | 'any'

export type InputSource =
  | 'email_attachment'
  | 'api_fetch'
  | 'webhook_payload'
  | 'manual_upload'
  | 'scheduled_pull'
  | 'database_query'
  | 'file_system'

export type InputFormat =
  | 'structured_data'    // JSON, XML, CSV
  | 'document'           // PDF, Word, etc.
  | 'spreadsheet'        // Excel, CSV
  | 'image'              // PNG, JPG, etc.
  | 'text'               // Plain text
  | 'email'              // Email message with optional attachments

/**
 * Identified components from the decomposition
 */
export interface IdentifiedComponents {
  connectors: IdentifiedConnector[]
  processors: IdentifiedProcessor[]
  actions: IdentifiedAction[]
  triggers: IdentifiedTrigger[]
}

/**
 * An identified connector (API/data source integration)
 */
export interface IdentifiedConnector {
  /** Suggested ID for this connector */
  id: string

  /** Human-readable name */
  name: string

  /** What this connector does */
  description: string

  /** Type of connector */
  type: 'rest_api' | 'graphql' | 'email' | 'database' | 'file_system' | 'custom'

  /** External system this connects to */
  externalSystem: string

  /** Operations this connector needs to support */
  requiredOperations: IdentifiedOperation[]

  /** Authentication requirements */
  authRequirements: AuthRequirement

  /** Whether API documentation is needed */
  needsApiDoc: boolean

  /** Priority (higher = more important) */
  priority: number
}

export interface IdentifiedOperation {
  name: string
  description: string
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  isMutating: boolean
  inputDescription?: string
  outputDescription?: string
}

export interface AuthRequirement {
  type: 'oauth2' | 'api_key' | 'basic' | 'bearer' | 'none' | 'unknown'
  description: string
  scopes?: string[]
}

/**
 * An identified processor (data transformation)
 */
export interface IdentifiedProcessor {
  id: string
  name: string
  description: string
  type: 'filter' | 'transform' | 'aggregate' | 'classify' | 'enrich' | 'validate' | 'custom'

  /** What data this processor receives */
  inputDescription: string

  /** What data this processor outputs */
  outputDescription: string

  /** Processing logic in natural language */
  logicDescription: string

  /** For filters: the filter criteria */
  filterCriteria?: string

  /** For classifiers: the categories */
  categories?: string[]

  /** Connectors/processors this depends on */
  dependsOn: string[]

  priority: number
}

/**
 * An identified action (side effect)
 */
export interface IdentifiedAction {
  id: string
  name: string
  description: string
  type: 'notify' | 'create' | 'update' | 'delete' | 'send' | 'custom'

  /** Which connector this action uses */
  usesConnector: string

  /** Which operation on the connector */
  operation: string

  /** Whether this should require approval */
  suggestedApprovalRequired: boolean

  /** Reason for approval requirement */
  approvalReason?: string

  /** Connectors/processors this depends on */
  dependsOn: string[]

  priority: number
}

/**
 * An identified trigger
 */
export interface IdentifiedTrigger {
  id: string
  name: string
  type: 'schedule' | 'webhook' | 'event' | 'manual'

  /** For schedule: natural language description */
  scheduleDescription?: string

  /** For schedule: suggested cron expression */
  suggestedCron?: string

  /** For webhook: expected payload description */
  webhookPayload?: string

  /** For event: event source and type */
  eventSource?: string
  eventType?: string

  priority: number
}

/**
 * Required API for the agent
 */
export interface RequiredAPI {
  /** Name of the API/service */
  name: string

  /** Purpose in this agent */
  purpose: string

  /** Suggested documentation sources */
  suggestedSources: string[]

  /** Whether official OpenAPI/Swagger is available */
  hasOpenApiSpec: boolean

  /** Specific endpoints needed */
  endpointsNeeded: string[]

  /** Priority (higher = more important) */
  priority: number
}

/**
 * Data flow between components
 */
export interface DataFlowGraph {
  nodes: DataFlowNode[]
  edges: DataFlowEdge[]
}

export interface DataFlowNode {
  id: string
  type: 'trigger' | 'connector' | 'processor' | 'action'
  componentId: string
  label: string
}

export interface DataFlowEdge {
  from: string
  to: string
  dataDescription: string
}

/**
 * A clarification question for the user
 */
export interface PendingClarification {
  id: string
  question: string
  context: string
  options?: string[]
  inputType: 'text' | 'choice' | 'confirm'
  importance: 'required' | 'recommended' | 'optional'
  relatedComponent?: string
  defaultValue?: string
}

/**
 * User's answer to a clarification
 */
export interface ClarificationAnswer {
  questionId: string
  answer: string
  answeredAt: number
}

/**
 * Incremental update during decomposition
 */
export interface DecompositionUpdate {
  type: DecompositionUpdateType
  data: unknown
  timestamp: number
}

export type DecompositionUpdateType =
  | 'understanding_updated'
  | 'component_identified'
  | 'api_requirement_found'
  | 'clarification_needed'
  | 'data_flow_updated'
  | 'confidence_updated'
  | 'warning_added'
  | 'status_changed'
  | 'complete'

/**
 * Create an empty decomposition result
 */
export function createEmptyDecomposition(sessionId: string): DecompositionResult {
  return {
    sessionId,
    understanding: {
      summary: '',
      goals: [],
      entities: [],
      externalSystems: [],
      constraints: [],
      suggestedName: '',
      inputRequirements: undefined
    },
    components: {
      connectors: [],
      processors: [],
      actions: [],
      triggers: []
    },
    requiredAPIs: [],
    dataFlow: {
      nodes: [],
      edges: []
    },
    pendingClarifications: [],
    confidence: 0,
    warnings: [],
    status: 'analyzing'
  }
}

/**
 * Merge a clarification answer into the decomposition
 */
export function applyClarificationAnswer(
  result: DecompositionResult,
  answer: ClarificationAnswer
): DecompositionResult {
  return {
    ...result,
    pendingClarifications: result.pendingClarifications.filter(
      c => c.id !== answer.questionId
    )
  }
}

/**
 * Check if decomposition needs more clarification
 */
export function needsClarification(result: DecompositionResult): boolean {
  return result.pendingClarifications.some(c => c.importance === 'required')
}

/**
 * Get the next required clarification
 */
export function getNextRequiredClarification(
  result: DecompositionResult
): PendingClarification | undefined {
  return result.pendingClarifications.find(c => c.importance === 'required')
}

/**
 * Calculate overall confidence based on completeness
 */
export function calculateConfidence(result: DecompositionResult): number {
  let score = 0
  let maxScore = 0

  // Understanding completeness (30%)
  maxScore += 30
  if (result.understanding.summary) score += 10
  if (result.understanding.goals.length > 0) score += 10
  if (result.understanding.suggestedName) score += 10

  // Components identified (30%)
  maxScore += 30
  if (result.components.connectors.length > 0) score += 10
  if (result.components.processors.length > 0) score += 10
  if (result.components.triggers.length > 0) score += 10

  // API requirements (20%)
  maxScore += 20
  if (result.requiredAPIs.length > 0) score += 10
  if (result.requiredAPIs.every(a => a.suggestedSources.length > 0)) score += 10

  // No pending required clarifications (20%)
  maxScore += 20
  const requiredClarifications = result.pendingClarifications.filter(
    c => c.importance === 'required'
  )
  if (requiredClarifications.length === 0) score += 20

  return score / maxScore
}

/**
 * Validate a decomposition result
 */
export function validateDecomposition(result: DecompositionResult): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // Must have a summary
  if (!result.understanding.summary) {
    issues.push({
      severity: 'error',
      message: 'Missing summary of agent purpose',
      component: 'understanding'
    })
  }

  // Must have at least one goal
  if (result.understanding.goals.length === 0) {
    issues.push({
      severity: 'error',
      message: 'No goals identified for the agent',
      component: 'understanding'
    })
  }

  // Must have at least one trigger
  if (result.components.triggers.length === 0) {
    issues.push({
      severity: 'error',
      message: 'No trigger defined - agent needs a way to start',
      component: 'triggers'
    })
  }

  // Actions should have connectors
  for (const action of result.components.actions) {
    if (!result.components.connectors.find(c => c.id === action.usesConnector)) {
      issues.push({
        severity: 'warning',
        message: `Action "${action.name}" references unknown connector "${action.usesConnector}"`,
        component: 'actions'
      })
    }
  }

  // Check for orphaned processors
  for (const processor of result.components.processors) {
    const isUsed = result.components.actions.some(a => a.dependsOn.includes(processor.id)) ||
                   result.components.processors.some(p => p.dependsOn.includes(processor.id))
    if (!isUsed && result.components.processors.indexOf(processor) !== result.components.processors.length - 1) {
      issues.push({
        severity: 'warning',
        message: `Processor "${processor.name}" is not used by any action or processor`,
        component: 'processors'
      })
    }
  }

  return issues
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  message: string
  component: string
}
