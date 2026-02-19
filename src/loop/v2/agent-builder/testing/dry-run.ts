/**
 * Dry Run
 * Execute agents in dry-run mode that logs what would happen without side effects
 */

import { AgentDefinition } from '../config/schema'
import { LocalExecutor, LocalExecutionOptions } from '../runtime/local-executor'
import { ExecutionResult, ComponentLogger } from '../components/types'

/**
 * Dry run options
 */
export interface DryRunOptions extends Omit<LocalExecutionOptions, 'dryRun'> {
  /** Output format */
  outputFormat?: 'text' | 'json' | 'markdown'

  /** Include timestamps */
  includeTimestamps?: boolean

  /** Verbose mode - include all details */
  verbose?: boolean
}

/**
 * Dry run log entry
 */
export interface DryRunLogEntry {
  timestamp: number
  phase: 'fetch' | 'process' | 'action'
  componentId: string
  componentName: string
  operation: string
  wouldDo: string
  input?: unknown
  expectedOutput?: unknown
}

/**
 * Dry run result
 */
export interface DryRunResult extends ExecutionResult {
  /** All logged operations */
  log: DryRunLogEntry[]

  /** Formatted output */
  formattedOutput: string

  /** Summary statistics */
  summary: DryRunSummary
}

export interface DryRunSummary {
  totalOperations: number
  fetchOperations: number
  processOperations: number
  actionOperations: number
  wouldRequireApproval: number
}

/**
 * Execute agent in dry-run mode
 */
export async function dryRun(
  definition: AgentDefinition,
  options: DryRunOptions = {}
): Promise<DryRunResult> {
  const log: DryRunLogEntry[] = []
  const {
    outputFormat = 'text',
    includeTimestamps = true,
    verbose = false
  } = options

  // Create logger that captures dry-run info
  const dryRunLogger = createDryRunLogger(log, definition, verbose)

  // Create executor in dry-run mode
  const executor = new LocalExecutor(definition, {
    ...options,
    dryRun: true,
    logger: dryRunLogger
  })

  await executor.initialize()
  const baseResult = await executor.runOnce()

  // Build summary
  const summary: DryRunSummary = {
    totalOperations: log.length,
    fetchOperations: log.filter(e => e.phase === 'fetch').length,
    processOperations: log.filter(e => e.phase === 'process').length,
    actionOperations: log.filter(e => e.phase === 'action').length,
    wouldRequireApproval: definition.components.actions.filter(a => a.requiresApproval).length
  }

  // Format output
  const formattedOutput = formatDryRunOutput(definition, log, summary, {
    format: outputFormat,
    includeTimestamps,
    verbose
  })

  return {
    ...baseResult,
    log,
    formattedOutput,
    summary
  }
}

/**
 * Create logger for dry-run mode
 */
function createDryRunLogger(
  log: DryRunLogEntry[],
  definition: AgentDefinition,
  verbose: boolean
): ComponentLogger {
  return {
    debug: (msg: string, data?: unknown) => {
      if (verbose) {
        console.log(`[DRY-RUN DEBUG] ${msg}`, data || '')
      }
    },
    info: (msg: string, data?: unknown) => {
      // Parse log messages to extract dry-run info
      const entry = parseLogMessage(msg, data, definition)
      if (entry) {
        log.push(entry)
      }
      console.log(`[DRY-RUN] ${msg}`, data || '')
    },
    warn: (msg: string, data?: unknown) => {
      console.warn(`[DRY-RUN WARN] ${msg}`, data || '')
    },
    error: (msg: string, error?: Error) => {
      console.error(`[DRY-RUN ERROR] ${msg}`, error?.message || '')
    }
  }
}

/**
 * Parse a log message to extract dry-run entry
 */
function parseLogMessage(
  msg: string,
  data: unknown,
  definition: AgentDefinition
): DryRunLogEntry | null {
  const timestamp = Date.now()

  // Check for connector fetch
  if (msg.includes('Fetching from connector')) {
    const connectorId = msg.match(/connector: (\S+)/)?.[1]
    const connector = definition.components.connectors.find(c => c.id === connectorId)

    if (connector) {
      return {
        timestamp,
        phase: 'fetch',
        componentId: connector.id,
        componentName: connector.name,
        operation: 'fetch',
        wouldDo: `Fetch data from ${connector.name} (${connector.type})`,
        input: data
      }
    }
  }

  // Check for processor
  if (msg.includes('Processing with')) {
    const processorId = msg.match(/with: (\S+)/)?.[1]
    const processor = definition.components.processors.find(p => p.id === processorId)

    if (processor) {
      return {
        timestamp,
        phase: 'process',
        componentId: processor.id,
        componentName: processor.name,
        operation: processor.type,
        wouldDo: `Process data: ${processor.description}`,
        input: data
      }
    }
  }

  // Check for action
  if (msg.includes('Executing action')) {
    const actionId = msg.match(/action: (\S+)/)?.[1]
    const action = definition.components.actions.find(a => a.id === actionId)

    if (action) {
      return {
        timestamp,
        phase: 'action',
        componentId: action.id,
        componentName: action.name,
        operation: action.type,
        wouldDo: `Execute: ${action.description}${action.requiresApproval ? ' (would require approval)' : ''}`,
        input: data
      }
    }
  }

  return null
}

/**
 * Format dry-run output
 */
function formatDryRunOutput(
  definition: AgentDefinition,
  log: DryRunLogEntry[],
  summary: DryRunSummary,
  options: { format: string; includeTimestamps: boolean; verbose: boolean }
): string {
  switch (options.format) {
    case 'json':
      return JSON.stringify({
        agent: {
          id: definition.id,
          name: definition.name,
          description: definition.description
        },
        log,
        summary
      }, null, 2)

    case 'markdown':
      return formatMarkdown(definition, log, summary, options)

    case 'text':
    default:
      return formatText(definition, log, summary, options)
  }
}

/**
 * Format as plain text
 */
function formatText(
  definition: AgentDefinition,
  log: DryRunLogEntry[],
  summary: DryRunSummary,
  options: { includeTimestamps: boolean; verbose: boolean }
): string {
  const lines: string[] = []

  lines.push('═'.repeat(60))
  lines.push(`DRY RUN: ${definition.name}`)
  lines.push('═'.repeat(60))
  lines.push('')

  if (log.length === 0) {
    lines.push('No operations would be executed.')
    lines.push('')
  } else {
    for (const entry of log) {
      const timestamp = options.includeTimestamps
        ? `[${new Date(entry.timestamp).toISOString()}] `
        : ''
      const phase = entry.phase.toUpperCase().padEnd(8)

      lines.push(`${timestamp}${phase} ${entry.componentName}`)
      lines.push(`         ${entry.wouldDo}`)

      if (options.verbose && entry.input) {
        lines.push(`         Input: ${JSON.stringify(entry.input)}`)
      }

      lines.push('')
    }
  }

  lines.push('─'.repeat(60))
  lines.push('SUMMARY')
  lines.push('─'.repeat(60))
  lines.push(`Total operations:      ${summary.totalOperations}`)
  lines.push(`  Fetch operations:    ${summary.fetchOperations}`)
  lines.push(`  Process operations:  ${summary.processOperations}`)
  lines.push(`  Action operations:   ${summary.actionOperations}`)
  lines.push(`Would require approval: ${summary.wouldRequireApproval}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Format as markdown
 */
function formatMarkdown(
  definition: AgentDefinition,
  log: DryRunLogEntry[],
  summary: DryRunSummary,
  options: { includeTimestamps: boolean; verbose: boolean }
): string {
  const lines: string[] = []

  lines.push(`# Dry Run: ${definition.name}`)
  lines.push('')
  lines.push(`> ${definition.description}`)
  lines.push('')

  if (log.length === 0) {
    lines.push('*No operations would be executed.*')
    lines.push('')
  } else {
    lines.push('## Operations')
    lines.push('')

    for (const entry of log) {
      const emoji = entry.phase === 'fetch' ? '📥' :
                    entry.phase === 'process' ? '⚙️' : '🚀'

      lines.push(`### ${emoji} ${entry.componentName}`)
      lines.push('')
      lines.push(`- **Phase:** ${entry.phase}`)
      lines.push(`- **Operation:** ${entry.operation}`)
      lines.push(`- **Would do:** ${entry.wouldDo}`)

      if (options.includeTimestamps) {
        lines.push(`- **Timestamp:** ${new Date(entry.timestamp).toISOString()}`)
      }

      if (options.verbose && entry.input) {
        lines.push('')
        lines.push('**Input:**')
        lines.push('```json')
        lines.push(JSON.stringify(entry.input, null, 2))
        lines.push('```')
      }

      lines.push('')
    }
  }

  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Count |')
  lines.push('|--------|-------|')
  lines.push(`| Total operations | ${summary.totalOperations} |`)
  lines.push(`| Fetch operations | ${summary.fetchOperations} |`)
  lines.push(`| Process operations | ${summary.processOperations} |`)
  lines.push(`| Action operations | ${summary.actionOperations} |`)
  lines.push(`| Would require approval | ${summary.wouldRequireApproval} |`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Quick dry-run helper for CLI
 */
export async function quickDryRun(definition: AgentDefinition): Promise<string> {
  const result = await dryRun(definition, {
    outputFormat: 'text',
    includeTimestamps: false,
    verbose: false
  })
  return result.formattedOutput
}

/**
 * Verbose dry-run for debugging
 */
export async function verboseDryRun(definition: AgentDefinition): Promise<DryRunResult> {
  return dryRun(definition, {
    outputFormat: 'json',
    includeTimestamps: true,
    verbose: true
  })
}

/**
 * Compare two dry-runs
 */
export function compareDryRuns(
  run1: DryRunResult,
  run2: DryRunResult
): DryRunComparison {
  const comparison: DryRunComparison = {
    operationsAdded: [],
    operationsRemoved: [],
    operationsChanged: [],
    summaryDiff: {
      totalOperations: run2.summary.totalOperations - run1.summary.totalOperations,
      fetchOperations: run2.summary.fetchOperations - run1.summary.fetchOperations,
      processOperations: run2.summary.processOperations - run1.summary.processOperations,
      actionOperations: run2.summary.actionOperations - run1.summary.actionOperations,
      wouldRequireApproval: run2.summary.wouldRequireApproval - run1.summary.wouldRequireApproval
    }
  }

  // Find added/removed operations
  const run1Ids = new Set(run1.log.map(e => e.componentId))
  const run2Ids = new Set(run2.log.map(e => e.componentId))

  for (const entry of run2.log) {
    if (!run1Ids.has(entry.componentId)) {
      comparison.operationsAdded.push(entry)
    }
  }

  for (const entry of run1.log) {
    if (!run2Ids.has(entry.componentId)) {
      comparison.operationsRemoved.push(entry)
    }
  }

  return comparison
}

export interface DryRunComparison {
  operationsAdded: DryRunLogEntry[]
  operationsRemoved: DryRunLogEntry[]
  operationsChanged: DryRunLogEntry[]
  summaryDiff: DryRunSummary
}
