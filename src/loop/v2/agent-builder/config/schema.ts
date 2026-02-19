/**
 * Agent Definition Schema
 * Core interfaces for defining and configuring agents built by the Agent Builder
 */

import { JSONSchema } from '../../types/tool-types'

/**
 * Complete agent definition - the output of the Agent Builder
 */
export interface AgentDefinition {
  id: string
  name: string
  description: string
  version: string
  createdAt: number
  updatedAt: number

  /** Original idea and clarifications from user */
  idea: IdeaContext

  /** Agent components */
  components: AgentComponents

  /** Oversight and approval configuration */
  oversight: OversightConfig

  /** Execution configuration */
  execution: ExecutionConfig

  /** Generated TypeScript code for the agent */
  generatedCode?: string

  /** Current status in the builder workflow */
  status: AgentStatus

  /** Metadata for tracking and debugging */
  metadata?: Record<string, unknown>
}

/**
 * The original idea and any clarifications gathered
 */
export interface IdeaContext {
  /** Original user input describing the agent */
  original: string

  /** Clarifying questions and answers */
  clarifications: Clarification[]

  /** Parsed understanding from the meta-agent */
  understanding?: IdeaUnderstanding
}

export interface Clarification {
  question: string
  answer: string
  askedAt: number
  answeredAt?: number
}

export interface IdeaUnderstanding {
  /** Brief summary of what the agent does */
  summary: string

  /** Primary goals the agent achieves */
  goals: string[]

  /** Key entities/data the agent works with */
  entities: string[]

  /** External systems the agent interacts with */
  externalSystems: string[]

  /** Suggested name for the agent */
  suggestedName?: string
}

/**
 * All components that make up an agent
 */
export interface AgentComponents {
  /** API and data source integrations */
  connectors: ConnectorConfig[]

  /** Data transformation and processing logic */
  processors: ProcessorConfig[]

  /** Side effects and outputs */
  actions: ActionConfig[]

  /** What triggers the agent to run */
  triggers: TriggerConfig[]
}

/**
 * Connector - Integrates with external APIs or data sources
 */
export interface ConnectorConfig {
  id: string
  name: string
  description: string
  type: ConnectorType

  /** API documentation source */
  apiDoc?: ApiDocReference

  /** Authentication configuration */
  auth: AuthConfig

  /** Specific operations this connector performs */
  operations: OperationConfig[]

  /** Base URL for API calls */
  baseUrl?: string

  /** Custom headers to include */
  headers?: Record<string, string>

  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig
}

export type ConnectorType = 'rest_api' | 'graphql' | 'email' | 'database' | 'file_system' | 'webhook' | 'custom'

export interface ApiDocReference {
  /** URL to fetch documentation from */
  url?: string

  /** Inline documentation content */
  content?: string

  /** Format of the documentation */
  format: 'openapi' | 'swagger' | 'graphql' | 'markdown' | 'html' | 'unknown'

  /** Parsed schema if available */
  parsedSchema?: Record<string, unknown>
}

export interface AuthConfig {
  type: AuthType

  /** Credential reference (stored securely, not inline) */
  credentialId?: string

  /** OAuth specific config */
  oauth?: OAuthConfig

  /** API key config */
  apiKey?: ApiKeyConfig

  /** Basic auth config */
  basic?: BasicAuthConfig
}

export type AuthType = 'none' | 'oauth2' | 'api_key' | 'basic' | 'bearer' | 'custom'

export interface OAuthConfig {
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  clientId?: string
}

export interface ApiKeyConfig {
  header?: string
  queryParam?: string
  prefix?: string
}

export interface BasicAuthConfig {
  usernameField?: string
  passwordField?: string
}

export interface OperationConfig {
  id: string
  name: string
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  inputSchema?: JSONSchema
  outputSchema?: JSONSchema

  /** Whether this operation modifies data */
  isMutating: boolean
}

export interface RateLimitConfig {
  requestsPerMinute?: number
  requestsPerHour?: number
  retryAfterMs?: number
}

/**
 * Processor - Transforms and processes data
 */
export interface ProcessorConfig {
  id: string
  name: string
  description: string
  type: ProcessorType

  /** Schema for input data */
  inputSchema: JSONSchema

  /** Schema for output data */
  outputSchema: JSONSchema

  /** Processing logic description (for code generation) */
  logic: string

  /** For filter type: condition expression */
  filterCondition?: string

  /** For classify type: categories and criteria */
  classificationConfig?: ClassificationConfig

  /** For aggregate type: aggregation settings */
  aggregationConfig?: AggregationConfig
}

export type ProcessorType = 'filter' | 'transform' | 'aggregate' | 'classify' | 'enrich' | 'validate' | 'custom'

export interface ClassificationConfig {
  categories: CategoryConfig[]
  multiLabel: boolean
  unknownCategory?: string
}

export interface CategoryConfig {
  name: string
  description: string
  criteria: string[]
}

export interface AggregationConfig {
  groupBy?: string[]
  operations: AggregationOperation[]
}

export interface AggregationOperation {
  field: string
  operation: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'list' | 'first' | 'last'
  outputField: string
}

/**
 * Action - Performs side effects
 */
export interface ActionConfig {
  id: string
  name: string
  description: string
  type: ActionType

  /** Which connector to use for this action */
  connectorId: string

  /** Which operation on the connector */
  operationId: string

  /** Whether this action requires human approval before execution */
  requiresApproval: boolean

  /** Template for formatting data before action */
  template?: ActionTemplate

  /** Retry configuration */
  retry?: RetryConfig

  /** Conditions that must be met to execute */
  conditions?: ActionCondition[]
}

export type ActionType = 'notify' | 'create' | 'update' | 'delete' | 'send' | 'custom'

export interface ActionTemplate {
  format: 'json' | 'text' | 'html' | 'markdown'
  template: string
  variables: string[]
}

export interface RetryConfig {
  maxAttempts: number
  backoffMs: number
  backoffMultiplier: number
}

export interface ActionCondition {
  field: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists'
  value: unknown
}

/**
 * Trigger - What starts the agent
 */
export interface TriggerConfig {
  id: string
  name: string
  type: TriggerType

  /** Schedule trigger config */
  schedule?: ScheduleConfig

  /** Webhook trigger config */
  webhook?: WebhookConfig

  /** Event trigger config */
  event?: EventConfig

  /** Whether to run immediately on deploy */
  runOnDeploy?: boolean
}

export type TriggerType = 'schedule' | 'webhook' | 'event' | 'manual'

export interface ScheduleConfig {
  /** Cron expression */
  cron: string

  /** Timezone for the schedule */
  timezone: string

  /** Human-readable description */
  description?: string
}

export interface WebhookConfig {
  /** Path for the webhook endpoint */
  path: string

  /** HTTP method to accept */
  method: 'GET' | 'POST' | 'PUT'

  /** Schema for validating incoming data */
  payloadSchema?: JSONSchema

  /** Secret for webhook verification */
  secretHeader?: string
}

export interface EventConfig {
  /** Event source */
  source: string

  /** Event type to listen for */
  eventType: string

  /** Filter conditions */
  filter?: Record<string, unknown>
}

/**
 * Oversight Configuration
 */
export interface OversightConfig {
  /** Overall oversight level */
  level: OversightLevel

  /** Specific checkpoints requiring attention */
  checkpoints: CheckpointConfig[]

  /** Notification preferences */
  notifications: NotificationConfig

  /** Escalation settings */
  escalation?: EscalationConfig
}

export type OversightLevel = 'autonomous' | 'monitored' | 'approval_required' | 'manual'

export interface CheckpointConfig {
  id: string
  name: string

  /** When to trigger this checkpoint */
  trigger: CheckpointTrigger

  /** What action to take */
  action: CheckpointAction

  /** For threshold triggers */
  threshold?: ThresholdConfig

  /** Timeout before auto-action (ms) */
  timeoutMs?: number

  /** Action to take on timeout */
  timeoutAction?: 'approve' | 'reject' | 'notify'
}

export type CheckpointTrigger = 'before_action' | 'after_action' | 'on_error' | 'on_threshold' | 'on_complete'

export type CheckpointAction = 'require_approval' | 'notify' | 'pause' | 'log'

export interface ThresholdConfig {
  metric: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  value: number
}

export interface NotificationConfig {
  onStart: boolean
  onComplete: boolean
  onError: boolean
  onApprovalRequired: boolean
  channels: NotificationChannel[]
}

export interface NotificationChannel {
  type: 'email' | 'slack' | 'webhook' | 'console'
  config: Record<string, string>
}

export interface EscalationConfig {
  /** Time before escalating (ms) */
  afterMs: number

  /** Who to escalate to */
  escalateTo: string[]

  /** Action on escalation */
  action: 'notify' | 'auto_approve' | 'reject'
}

/**
 * Execution Configuration
 */
export interface ExecutionConfig {
  /** Where the agent runs */
  mode: ExecutionMode

  /** Maximum execution time (ms) */
  timeoutMs: number

  /** Maximum iterations per run */
  maxIterations: number

  /** Retry configuration for the whole agent */
  retry?: RetryConfig

  /** State persistence settings */
  state?: StateConfig

  /** Resource limits */
  resources?: ResourceConfig
}

export type ExecutionMode = 'local' | 'server' | 'hybrid'

export interface StateConfig {
  /** Whether to persist state between runs */
  persist: boolean

  /** Where to store state */
  storage: 'memory' | 'file' | 'database'

  /** How long to keep state (ms) */
  ttlMs?: number
}

export interface ResourceConfig {
  /** Maximum memory (MB) */
  maxMemoryMb?: number

  /** Maximum concurrent operations */
  maxConcurrency?: number

  /** Request timeout (ms) */
  requestTimeoutMs?: number
}

/**
 * Agent Status in the builder workflow
 */
export type AgentStatus = 'draft' | 'decomposing' | 'configuring' | 'testing' | 'ready' | 'deployed' | 'error'

/**
 * Create a new empty agent definition
 */
export function createEmptyAgentDefinition(idea: string): AgentDefinition {
  const now = Date.now()
  return {
    id: generateId(),
    name: '',
    description: '',
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
    idea: {
      original: idea,
      clarifications: []
    },
    components: {
      connectors: [],
      processors: [],
      actions: [],
      triggers: []
    },
    oversight: {
      level: 'monitored',
      checkpoints: [],
      notifications: {
        onStart: false,
        onComplete: true,
        onError: true,
        onApprovalRequired: true,
        channels: []
      }
    },
    execution: {
      mode: 'local',
      timeoutMs: 300000,
      maxIterations: 50
    },
    status: 'draft'
  }
}

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`
}
