/**
 * Server Executor
 * Runs agents on a server with scheduling and state persistence
 */

import { AgentDefinition } from '../config/schema'
import { LocalExecutor, LocalExecutionOptions } from './local-executor'
import { Scheduler, ScheduleConfig, ScheduledJob } from './scheduler'
import { OversightManager, OversightManagerConfig } from './oversight-manager'
import { ExecutionResult, AgentRuntimeStatus } from '../components/types'

/**
 * Server execution options
 */
export interface ServerExecutionOptions extends LocalExecutionOptions {
  /** Server port for webhooks (default: 3000) */
  port?: number

  /** Enable webhook triggers */
  enableWebhooks?: boolean

  /** State persistence configuration */
  persistence?: PersistenceConfig

  /** Maximum concurrent executions */
  maxConcurrentExecutions?: number

  /** Execution history retention (in days) */
  historyRetentionDays?: number
}

/**
 * State persistence configuration
 */
export interface PersistenceConfig {
  type: 'memory' | 'file' | 'database'
  path?: string // For file persistence
  connectionString?: string // For database persistence
}

/**
 * Execution history entry
 */
export interface ExecutionHistoryEntry {
  id: string
  agentId: string
  startedAt: number
  completedAt: number
  duration: number
  success: boolean
  triggerType: string
  triggerId?: string
  errors: string[]
}

/**
 * Server executor for running agents on a server
 */
export class ServerExecutor {
  private definition: AgentDefinition
  private localExecutor: LocalExecutor
  private scheduler: Scheduler
  private oversightManager: OversightManager
  private options: ServerExecutionOptions

  private running = false
  private executionHistory: ExecutionHistoryEntry[] = []
  private currentExecutions = 0
  private maxConcurrent: number

  constructor(definition: AgentDefinition, options: ServerExecutionOptions = {}) {
    this.definition = definition
    this.options = options
    this.maxConcurrent = options.maxConcurrentExecutions || 5

    // Create oversight manager
    this.oversightManager = new OversightManager({
      level: definition.oversight.level,
      defaultTimeoutMs: 300000,
      onApprovalRequired: async (request) => {
        // In a real implementation, this would send a notification
        console.log(`[APPROVAL REQUIRED] ${request.actionName}`)
      }
    })

    // Create local executor with oversight
    this.localExecutor = new LocalExecutor(definition, {
      ...options,
      oversightManager: this.oversightManager
    })

    // Create scheduler
    this.scheduler = new Scheduler({
      timezone: 'UTC',
      onError: (error, jobId) => {
        console.error(`Scheduler error for job ${jobId}:`, error)
      }
    })
  }

  /**
   * Initialize the server executor
   */
  async initialize(): Promise<void> {
    console.log(`Initializing server executor for ${this.definition.name}...`)

    // Initialize local executor
    await this.localExecutor.initialize()

    // Set up scheduled triggers
    await this.setupScheduledTriggers()

    // Set up webhook triggers if enabled
    if (this.options.enableWebhooks) {
      await this.setupWebhookTriggers()
    }

    console.log('Server executor initialized')
  }

  /**
   * Start the server (activate all triggers)
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('Server executor already running')
      return
    }

    console.log(`Starting server executor for ${this.definition.name}...`)
    this.running = true

    // Start the scheduler
    this.scheduler.start()

    console.log('Server executor started')
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    console.log(`Stopping server executor for ${this.definition.name}...`)
    this.running = false

    // Stop the scheduler
    this.scheduler.stop()

    // Wait for current executions to complete
    while (this.currentExecutions > 0) {
      await this.delay(100)
    }

    console.log('Server executor stopped')
  }

  /**
   * Run the agent once manually
   */
  async runOnce(): Promise<ExecutionResult> {
    return this.executeWithTracking('manual')
  }

  /**
   * Execute with concurrency control and history tracking
   */
  private async executeWithTracking(
    triggerType: string,
    triggerId?: string
  ): Promise<ExecutionResult> {
    // Check concurrency limit
    if (this.currentExecutions >= this.maxConcurrent) {
      throw new Error(`Maximum concurrent executions (${this.maxConcurrent}) reached`)
    }

    this.currentExecutions++
    const executionId = `exec_${Date.now()}`

    try {
      const result = await this.localExecutor.runOnce()

      // Record in history
      const historyEntry: ExecutionHistoryEntry = {
        id: executionId,
        agentId: this.definition.id,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        duration: result.duration,
        success: result.success,
        triggerType,
        triggerId,
        errors: result.errors.map(e => e.message)
      }

      this.executionHistory.unshift(historyEntry)
      this.pruneHistory()

      return result
    } finally {
      this.currentExecutions--
    }
  }

  /**
   * Set up scheduled triggers
   */
  private async setupScheduledTriggers(): Promise<void> {
    for (const trigger of this.definition.components.triggers) {
      if (trigger.type === 'schedule' && trigger.schedule) {
        const config: ScheduleConfig = {
          cron: trigger.schedule.cron,
          timezone: trigger.schedule.timezone,
          runImmediately: trigger.runOnDeploy
        }

        this.scheduler.addJob(trigger.id, config, async () => {
          try {
            await this.executeWithTracking('schedule', trigger.id)
          } catch (error) {
            console.error(`Scheduled execution failed:`, error)
          }
        })

        console.log(`Scheduled trigger ${trigger.id}: ${trigger.schedule.cron}`)
      }
    }
  }

  /**
   * Set up webhook triggers
   */
  private async setupWebhookTriggers(): Promise<void> {
    // In a real implementation, this would create HTTP endpoints
    for (const trigger of this.definition.components.triggers) {
      if (trigger.type === 'webhook' && trigger.webhook) {
        console.log(`Webhook trigger ${trigger.id} would be available at: ${trigger.webhook.path}`)
        // Would register with Express/Fastify/etc.
      }
    }
  }

  /**
   * Handle webhook trigger
   */
  async handleWebhook(
    triggerId: string,
    payload: unknown
  ): Promise<ExecutionResult> {
    const trigger = this.definition.components.triggers.find(
      t => t.id === triggerId && t.type === 'webhook'
    )

    if (!trigger) {
      throw new Error(`Webhook trigger not found: ${triggerId}`)
    }

    // Store payload in state for the execution
    const state = this.localExecutor['context'].state
    state.set('webhook_payload', payload)

    return this.executeWithTracking('webhook', triggerId)
  }

  /**
   * Submit an approval decision
   */
  async submitApproval(
    requestId: string,
    approved: boolean,
    approvedBy?: string
  ): Promise<void> {
    await this.oversightManager.submitDecision(requestId, approved, approvedBy)
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals() {
    return this.oversightManager.getPendingRequests()
  }

  /**
   * Get execution history
   */
  getHistory(limit?: number): ExecutionHistoryEntry[] {
    if (limit) {
      return this.executionHistory.slice(0, limit)
    }
    return [...this.executionHistory]
  }

  /**
   * Get current status
   */
  getStatus(): ServerExecutorStatus {
    return {
      running: this.running,
      agentStatus: this.localExecutor.getStatus(),
      currentExecutions: this.currentExecutions,
      maxConcurrentExecutions: this.maxConcurrent,
      scheduledJobs: this.scheduler.getJobs().map(j => ({
        id: j.id,
        cron: j.config.cron,
        lastRun: j.lastRun,
        nextRun: j.nextRun
      })),
      pendingApprovals: this.oversightManager.getPendingRequests().length,
      totalExecutions: this.executionHistory.length,
      recentExecutions: this.executionHistory.slice(0, 5)
    }
  }

  /**
   * Prune old history entries
   */
  private pruneHistory(): void {
    const retentionMs = (this.options.historyRetentionDays || 30) * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - retentionMs

    this.executionHistory = this.executionHistory.filter(
      entry => entry.completedAt > cutoff
    )

    // Also limit to reasonable size
    if (this.executionHistory.length > 1000) {
      this.executionHistory = this.executionHistory.slice(0, 1000)
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
 * Server executor status
 */
export interface ServerExecutorStatus {
  running: boolean
  agentStatus: AgentRuntimeStatus
  currentExecutions: number
  maxConcurrentExecutions: number
  scheduledJobs: Array<{
    id: string
    cron: string
    lastRun?: number
    nextRun?: number
  }>
  pendingApprovals: number
  totalExecutions: number
  recentExecutions: ExecutionHistoryEntry[]
}

/**
 * Deploy an agent to run on a server
 */
export async function deployAgent(
  definition: AgentDefinition,
  options: ServerExecutionOptions = {}
): Promise<ServerExecutor> {
  const executor = new ServerExecutor(definition, options)
  await executor.initialize()
  await executor.start()
  return executor
}

/**
 * Create a server executor without starting it
 */
export function createServerExecutor(
  definition: AgentDefinition,
  options: ServerExecutionOptions = {}
): ServerExecutor {
  return new ServerExecutor(definition, options)
}
