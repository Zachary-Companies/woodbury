/**
 * Agent Builder Module
 * Exports all components of the Agent Builder system
 */

// Config exports
export {
  AgentDefinition,
  IdeaContext,
  Clarification,
  IdeaUnderstanding,
  AgentComponents,
  ConnectorConfig,
  ProcessorConfig,
  ActionConfig,
  TriggerConfig,
  ConnectorType,
  ApiDocReference,
  AuthConfig,
  AuthType,
  OAuthConfig,
  ApiKeyConfig,
  BasicAuthConfig,
  OperationConfig,
  RateLimitConfig,
  ProcessorType,
  ClassificationConfig,
  CategoryConfig,
  AggregationConfig,
  AggregationOperation,
  ActionType,
  ActionTemplate,
  RetryConfig,
  ActionCondition,
  TriggerType,
  ScheduleConfig,
  WebhookConfig,
  EventConfig,
  OversightConfig,
  OversightLevel,
  CheckpointConfig,
  CheckpointTrigger,
  CheckpointAction,
  ThresholdConfig,
  NotificationConfig,
  NotificationChannel,
  EscalationConfig,
  ExecutionConfig,
  ExecutionMode,
  StateConfig,
  ResourceConfig,
  AgentStatus,
  createEmptyAgentDefinition
} from './config/schema'

export {
  OVERSIGHT_LEVEL_DESCRIPTIONS,
  OversightLevelDescription,
  ValidationResult,
  AgentCharacteristics,
  createDefaultOversightConfig,
  validateOversightConfig,
  recommendOversightLevel,
  requiresApproval,
  createCheckpoint,
  addEmailNotification,
  addSlackNotification,
  addWebhookNotification
} from './config/oversight'

// Decomposition exports
export {
  DecompositionResult,
  DecompositionStatus,
  IdeaUnderstanding as DecomposedIdeaUnderstanding,
  EntityDefinition,
  ExternalSystem,
  ExecutionFrequency,
  IdentifiedComponents,
  IdentifiedConnector,
  IdentifiedOperation,
  AuthRequirement,
  IdentifiedProcessor,
  IdentifiedAction,
  IdentifiedTrigger,
  RequiredAPI,
  DataFlowGraph,
  DataFlowNode,
  DataFlowEdge,
  PendingClarification,
  ClarificationAnswer,
  DecompositionUpdate,
  DecompositionUpdateType,
  ValidationIssue,
  // Input requirements types
  InputRequirements,
  AttachmentType,
  InputSource,
  InputFormat,
  createEmptyDecomposition,
  applyClarificationAnswer,
  needsClarification,
  getNextRequiredClarification,
  calculateConfidence,
  validateDecomposition
} from './decomposition/component-types'

export {
  DECOMPOSITION_SYSTEM_PROMPT,
  ANALYZE_IDEA_PROMPT,
  IDENTIFY_COMPONENTS_PROMPT,
  DATA_FLOW_PROMPT,
  CLARIFICATION_PROMPT,
  EXAMPLE_DECOMPOSITION,
  getDecompositionToolDescriptions,
  formatClarificationQuestion,
  getDomainExamples
} from './decomposition/prompts'

export {
  DecompositionMetaAgent,
  DecompositionConfig,
  createDecompositionAgent
} from './decomposition/meta-agent'

// API Discovery exports
export {
  FetchedDoc,
  DocContentType,
  FetchOptions,
  fetchDoc,
  fetchDocs,
  detectContentType,
  clearDocCache,
  isDocCached,
  parseInlineDoc,
  validateDocUrl
} from './api-discovery/doc-fetcher'

export {
  ParsedApiSpec,
  ApiServer,
  SecurityScheme,
  OAuthFlows,
  ApiEndpoint,
  ApiParameter,
  ApiRequestBody,
  ApiResponse,
  ApiSchema,
  ApiSchemaProperty,
  ApiSchemaRef,
  ApiTag,
  parseApiDoc,
  mergeApiSpecs
} from './api-discovery/doc-parser'

export {
  GeneratedTool,
  ToolGenerationOptions,
  generateToolsFromSpec,
  generateToolModule,
  generateToolDefinitionsOnly,
  getToolSummary
} from './api-discovery/tool-generator'

export {
  KnowledgeChunk,
  KnowledgeType,
  ChunkMetadata,
  KnowledgeBaseConfig,
  BuiltKnowledge,
  ApiSummary,
  buildKnowledgeBase,
  exportForRAG,
  searchKnowledge
} from './api-discovery/knowledge-builder'

// Component exports
export {
  RuntimeConnector,
  RuntimeProcessor,
  RuntimeAction,
  RuntimeTrigger,
  ValidationResult as ComponentValidationResult,
  ValidationError,
  ActionResult,
  TriggerCallback,
  TriggerContext,
  RuntimeAgent,
  AgentRuntimeStatus,
  PendingApproval,
  RuntimeError,
  ExecutionResult,
  ActionExecutionRecord,
  ExecutionError,
  ComponentFactory,
  ComponentExecutionContext,
  CredentialsStore,
  StateStore,
  ComponentLogger,
  DataFlowNode as ExecutionDataFlowNode,
  ExecutionPlan,
  buildExecutionPlan,
  createInitialStatus,
  createExecutionResult
} from './components/types'

export {
  GeneratedComponent,
  GenerationOptions,
  generateComponentCode,
  generateConnectorCode,
  generateProcessorCode,
  generateActionCode,
  generateTriggerCode
} from './components/generator'

export {
  AssembledAgent,
  AssemblyOptions,
  assembleAgent,
  exportAgentAsString,
  exportAgentAsFiles
} from './components/assembler'

// Runtime exports
export {
  LocalExecutor,
  LocalExecutionOptions,
  runAgentLocally,
  createDryRunExecutor
} from './runtime/local-executor'

export {
  ServerExecutor,
  ServerExecutionOptions,
  PersistenceConfig,
  ExecutionHistoryEntry,
  ServerExecutorStatus,
  deployAgent,
  createServerExecutor
} from './runtime/server-executor'

export {
  Scheduler,
  ScheduleConfig as SchedulerConfig,
  ScheduledJob,
  SchedulerOptions,
  CRON_EXPRESSIONS,
  createIntervalScheduler,
  parseHumanSchedule,
  formatCronAsHuman
} from './runtime/scheduler'

export {
  OversightManager,
  OversightManagerConfig,
  ApprovalRequest,
  ApprovalDecision,
  NotificationChannel as OversightNotificationChannel,
  ApprovalNotification,
  ConsoleNotificationChannel,
  WebhookNotificationChannel,
  MultiChannelNotifier,
  createOversightManager,
  createOversightManagerWithNotifications,
  formatApprovalRequest
} from './runtime/oversight-manager'

// Testing exports
export {
  Sandbox,
  SandboxConfig,
  SandboxOperation,
  SandboxResult,
  SandboxMetrics,
  TestScenario,
  TestScenarioResults,
  TestScenarioResult,
  createSandbox,
  runInSandbox,
  runTestScenarios
} from './testing/sandbox'

// Repository exports
export {
  RepositoryOptions,
  CreatedRepository,
  createAgentRepository
} from './repository/creator'

export {
  AgentSpec,
  ServiceSpec,
  GeneratedAgent,
  generateAgent,
  generateAgentAsync,
  writeAgentToDisk
} from './repository/agent-generator'

export {
  MockRegistry,
  MockResponse,
  MockMatcher,
  MockRequest,
  MockCallRecord,
  MockResponseBuilder,
  MockData,
  MockUser,
  MockPolicy,
  MockEmail,
  MockPaginatedResponse,
  mockResponse,
  createMockRegistry,
  createDomainMocks
} from './testing/mocks'

export {
  DryRunOptions,
  DryRunLogEntry,
  DryRunResult,
  DryRunSummary,
  DryRunComparison,
  dryRun,
  quickDryRun,
  verboseDryRun,
  compareDryRuns
} from './testing/dry-run'

// Code Generation exports
export {
  ServiceGenerationContext,
  GeneratedServiceCode,
  generateServiceCode,
  generateAllServices
} from './code-generation'

// API Library exports
export {
  ApiLibrarySpec,
  GeneratedApiLibrary,
  ApiLibraryGenerationOptions,
  SecretDefinition,
  TenantConfigUpdates,
  NpmWrapperSpec,
  generateApiLibrary,
  generateApiLibraryFromOpenApi,
  quickGenerateApiLibrary,
  generateNpmWrapperLibrary,
  AuthConfig as ApiLibraryAuthConfig,
  AuthType as ApiLibraryAuthType,
  TypeDef as ApiLibraryTypeDef,
  TypeFieldDef as ApiLibraryTypeFieldDef,
  EndpointDef as ApiLibraryEndpointDef,
  QueryParamDef as ApiLibraryQueryParamDef,
  generatePackageJson as generateApiLibraryPackageJson,
  generateTsConfig as generateApiLibraryTsConfig,
  generateJestConfig as generateApiLibraryJestConfig,
  generateGitignore as generateApiLibraryGitignore,
  generateClientClass as generateApiLibraryClientClass,
  generateTestFile as generateApiLibraryTestFile,
  generateReadme as generateApiLibraryReadme
} from './api-library'

/**
 * Quick start function to create an agent from an idea
 */
export async function buildAgentFromIdea(
  idea: string,
  options: {
    model?: string
    provider?: 'anthropic' | 'openai' | 'groq'
    onProgress?: (progress: number, phase: string) => void
    onQuestion?: (question: PendingClarification) => Promise<string>
  } = {}
): Promise<AgentDefinition> {
  const { createDecompositionAgent } = await import('./decomposition/meta-agent')
  const { createEmptyAgentDefinition } = await import('./config/schema')
  const { SimpleEventEmitter } = await import('../types/events')

  const emitter = new SimpleEventEmitter()

  if (options.onProgress) {
    emitter.on('progress', (event) => {
      const data = (event as { data?: { progress?: number; phase?: string } }).data
      options.onProgress!(data?.progress || 0, data?.phase || '')
    })
  }

  const agent = createDecompositionAgent({
    model: options.model || 'claude-opus-4-20250514',
    provider: options.provider,
    eventEmitter: emitter
  })

  const result = await agent.decompose(idea)

  // Convert decomposition result to agent definition
  const definition = createEmptyAgentDefinition(idea)
  definition.name = result.understanding.suggestedName || 'New Agent'
  definition.description = result.understanding.summary

  // Convert identified components to config
  // (This is simplified - real implementation would be more thorough)

  definition.status = 'draft'

  return definition
}

// Import types for re-export
import { PendingClarification } from './decomposition/component-types'
import { AgentDefinition } from './config/schema'
