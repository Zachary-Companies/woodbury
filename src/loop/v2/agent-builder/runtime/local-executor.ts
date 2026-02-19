/**
 * Local Executor
 * Runs agents locally on the user's machine
 */

import { AgentDefinition } from '../config/schema'
import { assembleAgent, AssembledAgent } from '../components/assembler'
import {
  RuntimeAgent,
  ExecutionResult,
  AgentRuntimeStatus,
  ComponentExecutionContext,
  CredentialsStore,
  StateStore,
  ComponentLogger,
  createInitialStatus,
  createExecutionResult
} from '../components/types'
import { OversightManager, ApprovalRequest } from './oversight-manager'

/**
 * Local execution options
 */
export interface LocalExecutionOptions {
  /** Working directory for file operations */
  workingDirectory?: string

  /** Credentials for connectors */
  credentials?: Record<string, string>

  /** Initial state */
  initialState?: Record<string, unknown>

  /** Custom logger */
  logger?: ComponentLogger

  /** Enable dry-run mode (no actual API calls) */
  dryRun?: boolean

  /** Abort signal for cancellation */
  signal?: AbortSignal

  /** Oversight manager for approvals */
  oversightManager?: OversightManager
}

/**
 * Local executor for running agents on the user's machine
 */
export class LocalExecutor {
  private definition: AgentDefinition
  private assembled?: AssembledAgent
  private status: AgentRuntimeStatus
  private context: ComponentExecutionContext
  private oversightManager?: OversightManager
  private dryRun: boolean

  private executionCount = 0
  private lastExecution?: ExecutionResult

  constructor(definition: AgentDefinition, options: LocalExecutionOptions = {}) {
    this.definition = definition
    this.dryRun = options.dryRun || false
    this.status = createInitialStatus()
    this.oversightManager = options.oversightManager

    // Create context
    this.context = {
      agentId: definition.id,
      executionId: '',
      workingDirectory: options.workingDirectory || process.cwd(),
      credentials: this.createCredentialsStore(options.credentials || {}),
      state: this.createStateStore(options.initialState || {}),
      logger: options.logger || this.createDefaultLogger(),
      signal: options.signal
    }
  }

  /**
   * Initialize the executor (assemble and prepare the agent)
   */
  async initialize(): Promise<void> {
    this.context.logger.info('Initializing local executor...')
    this.status.state = 'initializing'

    try {
      // Assemble the agent
      this.assembled = assembleAgent(this.definition, {
        includeComments: true,
        includeErrorHandling: true
      })

      this.context.logger.info('Agent assembled successfully')

      // In a real implementation, we would dynamically load and instantiate
      // the generated code. For now, we'll simulate the initialization.

      this.status.state = 'ready'
      this.context.logger.info('Local executor ready')
    } catch (error) {
      this.status.state = 'error'
      this.status.errors.push({
        component: 'executor',
        componentId: 'local',
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      })
      throw error
    }
  }

  /**
   * Run the agent once
   */
  async runOnce(): Promise<ExecutionResult> {
    const startedAt = Date.now()
    const executionId = `local_${Date.now()}_${++this.executionCount}`
    this.context.executionId = executionId

    this.context.logger.info(`Starting execution ${executionId}`)
    this.status.state = 'running'
    this.status.lastRunAt = startedAt

    const result = createExecutionResult(startedAt)

    try {
      // Phase 1: Fetch data from connectors
      await this.executeConnectors(result)

      // Phase 2: Process data through processors
      await this.executeProcessors(result)

      // Phase 3: Execute actions (with oversight)
      await this.executeActions(result)

      result.success = result.errors.length === 0

      if (result.success) {
        this.status.successfulRuns++
      } else {
        this.status.failedRuns++
      }
    } catch (error) {
      result.success = false
      result.errors.push({
        phase: 'action',
        componentId: 'executor',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false
      })
      this.status.failedRuns++
    }

    result.completedAt = Date.now()
    result.duration = result.completedAt - result.startedAt
    this.status.totalRuns++
    this.status.state = 'ready'
    this.lastExecution = result

    this.context.logger.info(
      `Execution ${executionId} completed in ${result.duration}ms (success: ${result.success})`
    )

    return result
  }

  /**
   * Execute all connectors
   */
  private async executeConnectors(result: ExecutionResult): Promise<void> {
    for (const connector of this.definition.components.connectors) {
      try {
        this.context.logger.info(`Fetching from connector: ${connector.id}`)

        if (this.dryRun) {
          this.context.logger.info(`[DRY RUN] Would fetch from ${connector.name}`)
          result.fetchedData.set(connector.id, { dryRun: true, connector: connector.name })
          continue
        }

        // In a real implementation, we would call the actual connector
        // For now, simulate data fetch
        const data = await this.simulateConnectorFetch(connector)
        result.fetchedData.set(connector.id, data)
      } catch (error) {
        result.errors.push({
          phase: 'fetch',
          componentId: connector.id,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        })
      }
    }
  }

  /**
   * Execute all processors
   */
  private async executeProcessors(result: ExecutionResult): Promise<void> {
    for (const processor of this.definition.components.processors) {
      try {
        this.context.logger.info(`Processing with: ${processor.id}`)

        if (this.dryRun) {
          this.context.logger.info(`[DRY RUN] Would process with ${processor.name}`)
          result.processedData.set(processor.id, { dryRun: true, processor: processor.name })
          continue
        }

        // Get input data from connectors or previous processors
        const inputData = this.getProcessorInput(processor, result)

        // In a real implementation, we would call the actual processor
        // For now, simulate processing
        const processedData = await this.simulateProcessing(processor, inputData)
        result.processedData.set(processor.id, processedData)
      } catch (error) {
        result.errors.push({
          phase: 'process',
          componentId: processor.id,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true
        })
      }
    }
  }

  /**
   * Execute all actions
   */
  private async executeActions(result: ExecutionResult): Promise<void> {
    for (const action of this.definition.components.actions) {
      try {
        this.context.logger.info(`Executing action: ${action.id}`)

        // Check if approval is required
        if (action.requiresApproval && this.oversightManager) {
          const approved = await this.requestApproval(action, result)
          if (!approved) {
            result.actionsPending.push(action.id)
            this.context.logger.info(`Action ${action.id} pending approval`)
            continue
          }
        }

        if (this.dryRun) {
          this.context.logger.info(`[DRY RUN] Would execute ${action.name}`)
          result.actionsExecuted.push({
            actionId: action.id,
            executedAt: Date.now(),
            result: { success: true, data: { dryRun: true } }
          })
          continue
        }

        // In a real implementation, we would call the actual action
        // For now, simulate action execution
        const actionResult = await this.simulateAction(action, result)
        result.actionsExecuted.push({
          actionId: action.id,
          executedAt: Date.now(),
          result: actionResult,
          approved: action.requiresApproval
        })
      } catch (error) {
        result.errors.push({
          phase: 'action',
          componentId: action.id,
          message: error instanceof Error ? error.message : String(error),
          recoverable: false
        })
      }
    }
  }

  /**
   * Request approval for an action
   */
  private async requestApproval(
    action: typeof this.definition.components.actions[0],
    result: ExecutionResult
  ): Promise<boolean> {
    if (!this.oversightManager) {
      return true // No oversight, auto-approve
    }

    const request: ApprovalRequest = {
      id: `approval_${action.id}_${Date.now()}`,
      agentId: this.definition.id,
      actionId: action.id,
      actionName: action.name,
      actionType: action.type,
      data: result.processedData.get(action.connectorId),
      requestedAt: Date.now(),
      timeoutMs: this.definition.oversight.checkpoints.find(
        c => c.trigger === 'before_action'
      )?.timeoutMs
    }

    this.status.pendingApprovals.push({
      id: request.id,
      actionId: action.id,
      actionName: action.name,
      data: request.data,
      requestedAt: request.requestedAt,
      expiresAt: request.timeoutMs ? request.requestedAt + request.timeoutMs : undefined
    })

    const approved = await this.oversightManager.requestApproval(request)

    // Remove from pending
    this.status.pendingApprovals = this.status.pendingApprovals.filter(
      p => p.id !== request.id
    )

    return approved
  }

  /**
   * Simulate connector fetch (placeholder for real implementation)
   */
  private async simulateConnectorFetch(
    connector: typeof this.definition.components.connectors[0]
  ): Promise<unknown> {
    // Simulate API delay
    await this.delay(100)

    return {
      source: connector.name,
      fetchedAt: Date.now(),
      data: []
    }
  }

  /**
   * Get input data for a processor
   */
  private getProcessorInput(
    processor: typeof this.definition.components.processors[0],
    result: ExecutionResult
  ): unknown {
    // Simple logic: get data from all connectors
    // In real implementation, this would follow the data flow graph
    const inputs: unknown[] = []
    for (const [_id, data] of result.fetchedData) {
      inputs.push(data)
    }
    return inputs.length === 1 ? inputs[0] : inputs
  }

  /**
   * Simulate processing (placeholder for real implementation)
   */
  private async simulateProcessing(
    processor: typeof this.definition.components.processors[0],
    input: unknown
  ): Promise<unknown> {
    await this.delay(50)

    return {
      processor: processor.name,
      type: processor.type,
      processedAt: Date.now(),
      input,
      output: input // Pass-through for simulation
    }
  }

  /**
   * Simulate action (placeholder for real implementation)
   */
  private async simulateAction(
    action: typeof this.definition.components.actions[0],
    result: ExecutionResult
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    await this.delay(75)

    return {
      success: true,
      data: {
        action: action.name,
        executedAt: Date.now()
      }
    }
  }

  /**
   * Get current status
   */
  getStatus(): AgentRuntimeStatus {
    return { ...this.status }
  }

  /**
   * Get last execution result
   */
  getLastExecution(): ExecutionResult | undefined {
    return this.lastExecution
  }

  /**
   * Get the assembled agent code
   */
  getAssembledCode(): string | undefined {
    return this.assembled?.mainModule
  }

  /**
   * Create a credentials store
   */
  private createCredentialsStore(initial: Record<string, string>): CredentialsStore {
    const store = new Map(Object.entries(initial))

    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: string) => { store.set(key, value) },
      has: (key: string) => store.has(key)
    }
  }

  /**
   * Create a state store
   */
  private createStateStore(initial: Record<string, unknown>): StateStore {
    const store = new Map(Object.entries(initial))

    return {
      get: <T>(key: string) => store.get(key) as T | undefined,
      set: <T>(key: string, value: T) => { store.set(key, value) },
      delete: (key: string) => store.delete(key),
      clear: () => store.clear()
    }
  }

  /**
   * Create default logger
   */
  private createDefaultLogger(): ComponentLogger {
    const prefix = `[${this.definition.name}]`

    return {
      debug: (msg: string, data?: unknown) => {
        if (process.env.DEBUG) {
          console.log(`${prefix} [DEBUG]`, msg, data || '')
        }
      },
      info: (msg: string, data?: unknown) => {
        console.log(`${prefix} [INFO]`, msg, data || '')
      },
      warn: (msg: string, data?: unknown) => {
        console.warn(`${prefix} [WARN]`, msg, data || '')
      },
      error: (msg: string, error?: Error) => {
        console.error(`${prefix} [ERROR]`, msg, error?.message || '')
        if (error?.stack && process.env.DEBUG) {
          console.error(error.stack)
        }
      }
    }
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

/**
 * Create and run an agent locally
 */
export async function runAgentLocally(
  definition: AgentDefinition,
  options: LocalExecutionOptions = {}
): Promise<ExecutionResult> {
  const executor = new LocalExecutor(definition, options)
  await executor.initialize()
  return executor.runOnce()
}

/**
 * Create a local executor with dry-run mode
 */
export function createDryRunExecutor(
  definition: AgentDefinition,
  options: Omit<LocalExecutionOptions, 'dryRun'> = {}
): LocalExecutor {
  return new LocalExecutor(definition, { ...options, dryRun: true })
}
