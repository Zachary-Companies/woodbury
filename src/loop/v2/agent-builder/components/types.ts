/**
 * Component Types
 * Runtime component interfaces for assembled agents
 */

import { AgentDefinition, ConnectorConfig, ProcessorConfig, ActionConfig, TriggerConfig } from '../config/schema'

/**
 * Runtime connector instance
 */
export interface RuntimeConnector {
  /** Connector ID */
  id: string

  /** Configuration */
  config: ConnectorConfig

  /** Initialize the connector (authenticate, etc.) */
  initialize(): Promise<void>

  /** Execute an operation */
  execute(operationId: string, params: Record<string, unknown>): Promise<unknown>

  /** Check if connected */
  isConnected(): boolean

  /** Disconnect and cleanup */
  disconnect(): Promise<void>
}

/**
 * Runtime processor instance
 */
export interface RuntimeProcessor {
  /** Processor ID */
  id: string

  /** Configuration */
  config: ProcessorConfig

  /** Process data */
  process(input: unknown): Promise<unknown>

  /** Validate input against schema */
  validateInput(input: unknown): ValidationResult

  /** Validate output against schema */
  validateOutput(output: unknown): ValidationResult
}

/**
 * Runtime action instance
 */
export interface RuntimeAction {
  /** Action ID */
  id: string

  /** Configuration */
  config: ActionConfig

  /** Execute the action */
  execute(data: unknown): Promise<ActionResult>

  /** Check if action can be executed */
  canExecute(data: unknown): boolean

  /** Get connector this action uses */
  getConnector(): RuntimeConnector
}

/**
 * Runtime trigger instance
 */
export interface RuntimeTrigger {
  /** Trigger ID */
  id: string

  /** Configuration */
  config: TriggerConfig

  /** Start the trigger */
  start(callback: TriggerCallback): void

  /** Stop the trigger */
  stop(): void

  /** Check if trigger is active */
  isActive(): boolean

  /** Manually invoke the trigger */
  invoke(): void
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

export interface ValidationError {
  path: string
  message: string
  value?: unknown
}

/**
 * Action execution result
 */
export interface ActionResult {
  success: boolean
  data?: unknown
  error?: string
  retried?: number
}

/**
 * Trigger callback
 */
export type TriggerCallback = (context: TriggerContext) => Promise<void>

export interface TriggerContext {
  triggerId: string
  triggerType: TriggerConfig['type']
  triggeredAt: number
  payload?: unknown
}

/**
 * Complete runtime agent
 */
export interface RuntimeAgent {
  /** Agent definition */
  definition: AgentDefinition

  /** All connectors */
  connectors: Map<string, RuntimeConnector>

  /** All processors */
  processors: Map<string, RuntimeProcessor>

  /** All actions */
  actions: Map<string, RuntimeAction>

  /** All triggers */
  triggers: Map<string, RuntimeTrigger>

  /** Initialize all components */
  initialize(): Promise<void>

  /** Start the agent (activate triggers) */
  start(): Promise<void>

  /** Stop the agent */
  stop(): Promise<void>

  /** Run a single execution cycle */
  runOnce(): Promise<ExecutionResult>

  /** Get current status */
  getStatus(): AgentRuntimeStatus
}

/**
 * Agent runtime status
 */
export interface AgentRuntimeStatus {
  state: 'initializing' | 'ready' | 'running' | 'paused' | 'stopped' | 'error'
  startedAt?: number
  lastRunAt?: number
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  pendingApprovals: PendingApproval[]
  errors: RuntimeError[]
}

export interface PendingApproval {
  id: string
  actionId: string
  actionName: string
  data: unknown
  requestedAt: number
  expiresAt?: number
}

export interface RuntimeError {
  component: string
  componentId: string
  message: string
  timestamp: number
  stack?: string
}

/**
 * Execution result from a single run
 */
export interface ExecutionResult {
  success: boolean
  startedAt: number
  completedAt: number
  duration: number

  /** Data fetched from connectors */
  fetchedData: Map<string, unknown>

  /** Processed data from processors */
  processedData: Map<string, unknown>

  /** Actions executed */
  actionsExecuted: ActionExecutionRecord[]

  /** Actions pending approval */
  actionsPending: string[]

  /** Errors encountered */
  errors: ExecutionError[]
}

export interface ActionExecutionRecord {
  actionId: string
  executedAt: number
  result: ActionResult
  approved?: boolean
  approvedBy?: string
}

export interface ExecutionError {
  phase: 'fetch' | 'process' | 'action'
  componentId: string
  message: string
  recoverable: boolean
}

/**
 * Component factory functions
 */
export interface ComponentFactory {
  createConnector(config: ConnectorConfig): RuntimeConnector
  createProcessor(config: ProcessorConfig): RuntimeProcessor
  createAction(config: ActionConfig, connector: RuntimeConnector): RuntimeAction
  createTrigger(config: TriggerConfig): RuntimeTrigger
}

/**
 * Execution context passed to components
 */
export interface ComponentExecutionContext {
  /** Agent ID */
  agentId: string

  /** Current execution ID */
  executionId: string

  /** Working directory */
  workingDirectory: string

  /** Abort signal for cancellation */
  signal?: AbortSignal

  /** Credentials store */
  credentials: CredentialsStore

  /** State store for persisting data between runs */
  state: StateStore

  /** Logger */
  logger: ComponentLogger
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

/**
 * Data flow node for execution ordering
 */
export interface DataFlowNode {
  id: string
  type: 'connector' | 'processor' | 'action'
  component: RuntimeConnector | RuntimeProcessor | RuntimeAction
  inputs: string[]
  outputs: string[]
  executed: boolean
  result?: unknown
}

/**
 * Execution plan based on data flow
 */
export interface ExecutionPlan {
  nodes: DataFlowNode[]
  order: string[]
  cycles: string[][]
}

/**
 * Build execution plan from agent definition
 */
export function buildExecutionPlan(agent: RuntimeAgent): ExecutionPlan {
  const nodes: DataFlowNode[] = []
  const nodeMap = new Map<string, DataFlowNode>()

  // Add connector nodes
  for (const [id, connector] of agent.connectors) {
    const node: DataFlowNode = {
      id,
      type: 'connector',
      component: connector,
      inputs: [],
      outputs: [],
      executed: false
    }
    nodes.push(node)
    nodeMap.set(id, node)
  }

  // Add processor nodes
  for (const [id, processor] of agent.processors) {
    const node: DataFlowNode = {
      id,
      type: 'processor',
      component: processor,
      inputs: [],
      outputs: [],
      executed: false
    }
    nodes.push(node)
    nodeMap.set(id, node)
  }

  // Add action nodes
  for (const [id, action] of agent.actions) {
    const node: DataFlowNode = {
      id,
      type: 'action',
      component: action,
      inputs: [],
      outputs: [],
      executed: false
    }
    nodes.push(node)
    nodeMap.set(id, node)
  }

  // Build dependency graph from processor config
  for (const [id, processor] of agent.processors) {
    const node = nodeMap.get(id)!
    const config = processor.config

    // Find dependencies in processor logic description
    for (const connId of agent.connectors.keys()) {
      if (config.logic?.includes(connId)) {
        node.inputs.push(connId)
        nodeMap.get(connId)!.outputs.push(id)
      }
    }
  }

  // Build dependencies for actions
  for (const [id, action] of agent.actions) {
    const node = nodeMap.get(id)!
    const config = action.config

    // Actions depend on their connector
    if (config.connectorId) {
      node.inputs.push(config.connectorId)
    }
  }

  // Topological sort
  const order: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const cycles: string[][] = []

  function visit(nodeId: string, path: string[] = []): void {
    if (visited.has(nodeId)) return
    if (visiting.has(nodeId)) {
      cycles.push([...path, nodeId])
      return
    }

    visiting.add(nodeId)
    const node = nodeMap.get(nodeId)!

    for (const inputId of node.inputs) {
      visit(inputId, [...path, nodeId])
    }

    visiting.delete(nodeId)
    visited.add(nodeId)
    order.push(nodeId)
  }

  for (const node of nodes) {
    visit(node.id)
  }

  return { nodes, order, cycles }
}

/**
 * Create an empty runtime status
 */
export function createInitialStatus(): AgentRuntimeStatus {
  return {
    state: 'initializing',
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    pendingApprovals: [],
    errors: []
  }
}

/**
 * Create an empty execution result
 */
export function createExecutionResult(startedAt: number): ExecutionResult {
  return {
    success: false,
    startedAt,
    completedAt: 0,
    duration: 0,
    fetchedData: new Map(),
    processedData: new Map(),
    actionsExecuted: [],
    actionsPending: [],
    errors: []
  }
}
