/**
 * Sandbox
 * Sandboxed execution environment for testing agents safely
 */

import { AgentDefinition } from '../config/schema'
import { LocalExecutor, LocalExecutionOptions } from '../runtime/local-executor'
import { ExecutionResult, ComponentLogger } from '../components/types'
import { MockRegistry, MockResponse } from './mocks'

/**
 * Sandbox configuration
 */
export interface SandboxConfig {
  /** Mock registry for API responses */
  mocks?: MockRegistry

  /** Whether to allow real network requests (default: false) */
  allowRealNetwork?: boolean

  /** Maximum execution time (ms) */
  maxExecutionTime?: number

  /** Maximum memory usage (bytes) - not enforced in JS but logged */
  maxMemory?: number

  /** Working directory (isolated) */
  workingDirectory?: string

  /** Custom logger */
  logger?: ComponentLogger

  /** Callback for each operation (for assertions) */
  onOperation?: (operation: SandboxOperation) => void
}

/**
 * Recorded sandbox operation
 */
export interface SandboxOperation {
  type: 'fetch' | 'process' | 'action'
  componentId: string
  componentName: string
  timestamp: number
  input?: unknown
  output?: unknown
  mocked: boolean
  error?: string
}

/**
 * Sandbox execution result
 */
export interface SandboxResult extends ExecutionResult {
  /** All operations that were executed */
  operations: SandboxOperation[]

  /** All mock responses that were used */
  mocksUsed: string[]

  /** Operations that would have made real network calls */
  blockedNetworkCalls: string[]

  /** Execution metrics */
  metrics: SandboxMetrics
}

export interface SandboxMetrics {
  totalOperations: number
  mockedOperations: number
  executionTimeMs: number
  peakMemoryMb?: number
}

/**
 * Sandboxed execution environment
 */
export class Sandbox {
  private definition: AgentDefinition
  private config: SandboxConfig
  private operations: SandboxOperation[] = []
  private mocksUsed: string[] = []
  private blockedNetworkCalls: string[] = []

  constructor(definition: AgentDefinition, config: SandboxConfig = {}) {
    this.definition = definition
    this.config = {
      allowRealNetwork: false,
      maxExecutionTime: 30000,
      ...config
    }
  }

  /**
   * Run the agent in the sandbox
   */
  async run(): Promise<SandboxResult> {
    const startTime = Date.now()
    this.operations = []
    this.mocksUsed = []
    this.blockedNetworkCalls = []

    const logger = this.config.logger || this.createSandboxLogger()

    // Create executor with sandboxed settings
    const executor = new LocalExecutor(this.definition, {
      workingDirectory: this.config.workingDirectory || '/sandbox',
      dryRun: true, // Always dry-run in sandbox
      logger,
      credentials: this.createMockedCredentials()
    })

    // Override the simulation methods to use our mocks
    this.patchExecutorForSandbox(executor)

    try {
      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Sandbox execution timeout after ${this.config.maxExecutionTime}ms`))
        }, this.config.maxExecutionTime)
      })

      await executor.initialize()

      // Race between execution and timeout
      const baseResult = await Promise.race([
        executor.runOnce(),
        timeoutPromise
      ])

      const endTime = Date.now()

      // Build sandbox result
      const result: SandboxResult = {
        ...baseResult,
        operations: this.operations,
        mocksUsed: this.mocksUsed,
        blockedNetworkCalls: this.blockedNetworkCalls,
        metrics: {
          totalOperations: this.operations.length,
          mockedOperations: this.operations.filter(o => o.mocked).length,
          executionTimeMs: endTime - startTime
        }
      }

      return result
    } catch (error) {
      const endTime = Date.now()

      return {
        success: false,
        startedAt: startTime,
        completedAt: endTime,
        duration: endTime - startTime,
        fetchedData: new Map(),
        processedData: new Map(),
        actionsExecuted: [],
        actionsPending: [],
        errors: [{
          phase: 'action',
          componentId: 'sandbox',
          message: error instanceof Error ? error.message : String(error),
          recoverable: false
        }],
        operations: this.operations,
        mocksUsed: this.mocksUsed,
        blockedNetworkCalls: this.blockedNetworkCalls,
        metrics: {
          totalOperations: this.operations.length,
          mockedOperations: this.operations.filter(o => o.mocked).length,
          executionTimeMs: endTime - startTime
        }
      }
    }
  }

  /**
   * Run a specific component in isolation
   */
  async runComponent(componentId: string, input?: unknown): Promise<SandboxOperation> {
    const startTime = Date.now()

    // Find the component
    let component = this.definition.components.connectors.find(c => c.id === componentId)
    let componentType: 'fetch' | 'process' | 'action' = 'fetch'

    if (!component) {
      component = this.definition.components.processors.find(p => p.id === componentId) as any
      componentType = 'process'
    }

    if (!component) {
      component = this.definition.components.actions.find(a => a.id === componentId) as any
      componentType = 'action'
    }

    if (!component) {
      throw new Error(`Component not found: ${componentId}`)
    }

    // Check for mock
    let output: unknown
    let mocked = false

    if (this.config.mocks) {
      const mockResponse = this.config.mocks.get(componentId)
      if (mockResponse) {
        output = mockResponse.data
        mocked = true
        this.mocksUsed.push(componentId)
      }
    }

    if (!mocked) {
      if (this.config.allowRealNetwork) {
        // Would execute real operation
        output = { simulated: true, input }
      } else {
        this.blockedNetworkCalls.push(componentId)
        output = { blocked: true, reason: 'Network calls not allowed in sandbox' }
      }
    }

    const operation: SandboxOperation = {
      type: componentType,
      componentId,
      componentName: (component as any).name,
      timestamp: startTime,
      input,
      output,
      mocked
    }

    this.operations.push(operation)
    this.config.onOperation?.(operation)

    return operation
  }

  /**
   * Get all recorded operations
   */
  getOperations(): SandboxOperation[] {
    return [...this.operations]
  }

  /**
   * Reset the sandbox state
   */
  reset(): void {
    this.operations = []
    this.mocksUsed = []
    this.blockedNetworkCalls = []
  }

  /**
   * Patch executor to use sandbox mocks
   */
  private patchExecutorForSandbox(executor: LocalExecutor): void {
    // Access private methods through any
    const exec = executor as any

    // Override simulateConnectorFetch
    exec.simulateConnectorFetch = async (connector: any) => {
      return this.runComponent(connector.id, { operation: 'fetch' })
    }

    // Override simulateProcessing
    exec.simulateProcessing = async (processor: any, input: any) => {
      return this.runComponent(processor.id, input)
    }

    // Override simulateAction
    exec.simulateAction = async (action: any, result: any) => {
      const opResult = await this.runComponent(action.id, result)
      return { success: !opResult.error, data: opResult.output }
    }
  }

  /**
   * Create mocked credentials
   */
  private createMockedCredentials(): Record<string, string> {
    const creds: Record<string, string> = {}

    for (const connector of this.definition.components.connectors) {
      switch (connector.auth.type) {
        case 'api_key':
          creds[`${connector.id}_api_key`] = 'mock_api_key_xxx'
          break
        case 'oauth2':
          creds[`${connector.id}_access_token`] = 'mock_access_token_xxx'
          creds[`${connector.id}_refresh_token`] = 'mock_refresh_token_xxx'
          break
        case 'basic':
          creds[`${connector.id}_username`] = 'mock_user'
          creds[`${connector.id}_password`] = 'mock_pass'
          break
      }
    }

    return creds
  }

  /**
   * Create sandbox logger
   */
  private createSandboxLogger(): ComponentLogger {
    const prefix = '[SANDBOX]'
    return {
      debug: (msg: string, data?: unknown) => {
        console.log(`${prefix} [DEBUG] ${msg}`, data || '')
      },
      info: (msg: string, data?: unknown) => {
        console.log(`${prefix} [INFO] ${msg}`, data || '')
      },
      warn: (msg: string, data?: unknown) => {
        console.warn(`${prefix} [WARN] ${msg}`, data || '')
      },
      error: (msg: string, error?: Error) => {
        console.error(`${prefix} [ERROR] ${msg}`, error?.message || '')
      }
    }
  }
}

/**
 * Create a sandbox for an agent
 */
export function createSandbox(
  definition: AgentDefinition,
  config: SandboxConfig = {}
): Sandbox {
  return new Sandbox(definition, config)
}

/**
 * Run agent in sandbox with default mocks
 */
export async function runInSandbox(
  definition: AgentDefinition,
  mocks?: MockRegistry
): Promise<SandboxResult> {
  const sandbox = new Sandbox(definition, { mocks })
  return sandbox.run()
}

/**
 * Test scenario for sandbox
 */
export interface TestScenario {
  name: string
  description?: string
  mocks: Record<string, unknown>
  expectedOperations?: number
  expectedSuccess?: boolean
  assertions?: (result: SandboxResult) => void
}

/**
 * Run multiple test scenarios
 */
export async function runTestScenarios(
  definition: AgentDefinition,
  scenarios: TestScenario[]
): Promise<TestScenarioResults> {
  const results: TestScenarioResult[] = []

  for (const scenario of scenarios) {
    const mocks = new MockRegistry()
    for (const [id, data] of Object.entries(scenario.mocks)) {
      mocks.set(id, { data, status: 200 })
    }

    const sandbox = new Sandbox(definition, { mocks })
    const result = await sandbox.run()

    const passed = checkScenarioAssertions(result, scenario)

    results.push({
      scenario: scenario.name,
      passed,
      result,
      errors: passed ? [] : getScenarioErrors(result, scenario)
    })
  }

  return {
    total: scenarios.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    results
  }
}

function checkScenarioAssertions(result: SandboxResult, scenario: TestScenario): boolean {
  if (scenario.expectedSuccess !== undefined && result.success !== scenario.expectedSuccess) {
    return false
  }

  if (scenario.expectedOperations !== undefined && result.operations.length !== scenario.expectedOperations) {
    return false
  }

  if (scenario.assertions) {
    try {
      scenario.assertions(result)
    } catch {
      return false
    }
  }

  return true
}

function getScenarioErrors(result: SandboxResult, scenario: TestScenario): string[] {
  const errors: string[] = []

  if (scenario.expectedSuccess !== undefined && result.success !== scenario.expectedSuccess) {
    errors.push(`Expected success=${scenario.expectedSuccess}, got ${result.success}`)
  }

  if (scenario.expectedOperations !== undefined && result.operations.length !== scenario.expectedOperations) {
    errors.push(`Expected ${scenario.expectedOperations} operations, got ${result.operations.length}`)
  }

  return errors
}

export interface TestScenarioResults {
  total: number
  passed: number
  failed: number
  results: TestScenarioResult[]
}

export interface TestScenarioResult {
  scenario: string
  passed: boolean
  result: SandboxResult
  errors: string[]
}
