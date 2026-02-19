/**
 * Component Generator
 * Generates code for agent components from configurations
 */

import {
  AgentDefinition,
  ConnectorConfig,
  ProcessorConfig,
  ActionConfig,
  TriggerConfig
} from '../config/schema'

/**
 * Generated component code
 */
export interface GeneratedComponent {
  /** Component type */
  type: 'connector' | 'processor' | 'action' | 'trigger'

  /** Component ID */
  id: string

  /** Generated class name */
  className: string

  /** Generated TypeScript code */
  code: string

  /** Required imports */
  imports: string[]

  /** Dependencies on other components */
  dependencies: string[]
}

/**
 * Code generation options
 */
export interface GenerationOptions {
  /** Include inline comments */
  includeComments?: boolean

  /** Generate strict TypeScript */
  strictTypes?: boolean

  /** Target ES version */
  target?: 'es2020' | 'es2022' | 'esnext'

  /** Include error handling */
  includeErrorHandling?: boolean
}

/**
 * Generate code for all components in an agent definition
 */
export function generateComponentCode(
  definition: AgentDefinition,
  options: GenerationOptions = {}
): GeneratedComponent[] {
  const components: GeneratedComponent[] = []

  // Generate connectors
  for (const connector of definition.components.connectors) {
    components.push(generateConnectorCode(connector, options))
  }

  // Generate processors
  for (const processor of definition.components.processors) {
    components.push(generateProcessorCode(processor, options))
  }

  // Generate actions
  for (const action of definition.components.actions) {
    components.push(generateActionCode(action, definition, options))
  }

  // Generate triggers
  for (const trigger of definition.components.triggers) {
    components.push(generateTriggerCode(trigger, options))
  }

  return components
}

/**
 * Generate connector code
 */
export function generateConnectorCode(
  config: ConnectorConfig,
  options: GenerationOptions = {}
): GeneratedComponent {
  const { includeComments = true, includeErrorHandling = true } = options

  const className = toPascalCase(config.name) + 'Connector'
  const imports = [
    "import { RuntimeConnector, ComponentExecutionContext } from '../runtime-types'"
  ]

  let code = ''

  if (includeComments) {
    code += `/**
 * ${config.name} Connector
 * ${config.description}
 * Type: ${config.type}
 */\n`
  }

  // Add imports
  code += `import { RuntimeConnector, ComponentExecutionContext } from '../runtime-types'

`

  // Add config as const
  const configWithBaseUrl = { ...config, baseUrl: config.baseUrl || '' }
  code += `const connectorConfig = ${JSON.stringify(configWithBaseUrl, null, 2)}

`

  code += `export class ${className} implements RuntimeConnector {
  id = '${config.id}'
  config = connectorConfig

  private connected = false
  private context?: ComponentExecutionContext
`

  // Add auth-specific properties
  if (config.auth.type === 'oauth2') {
    code += `  private accessToken?: string
  private refreshToken?: string
  private tokenExpiresAt?: number
`
  } else if (config.auth.type === 'api_key') {
    code += `  private apiKey?: string
`
  }

  code += `
  async initialize(): Promise<void> {
`

  // Auth initialization
  switch (config.auth.type) {
    case 'api_key':
      code += `    // Load API key from credentials or environment
    this.apiKey = this.context?.credentials.get('${config.id}_api_key')
      || process.env.${toScreamingSnakeCase(config.id)}_API_KEY
      || process.env.${toScreamingSnakeCase(config.name)}_API_KEY
    if (!this.apiKey) {
      throw new Error('API key not configured for ${config.name}. Set ${toScreamingSnakeCase(config.id)}_API_KEY or ${toScreamingSnakeCase(config.name)}_API_KEY environment variable.')
    }
`
      break
    case 'oauth2':
      code += `    // Load OAuth tokens from credentials
    this.accessToken = this.context?.credentials.get('${config.id}_access_token')
    this.refreshToken = this.context?.credentials.get('${config.id}_refresh_token')
    if (!this.accessToken && !this.refreshToken) {
      throw new Error('OAuth not configured for ${config.name}')
    }
`
      break
    case 'basic':
      code += `    // Load basic auth credentials
    const username = this.context?.credentials.get('${config.id}_username')
    const password = this.context?.credentials.get('${config.id}_password')
    if (!username || !password) {
      throw new Error('Basic auth not configured for ${config.name}')
    }
`
      break
  }

  code += `    this.connected = true
    this.context?.logger.info('${config.name} connector initialized')
  }

  async execute(operationId: string, params: Record<string, unknown>): Promise<unknown> {
`

  if (includeErrorHandling) {
    code += `    if (!this.connected) {
      throw new Error('Connector not initialized')
    }

    try {
`
  }

  code += `      switch (operationId) {
`

  // Generate case for each operation
  for (const op of config.operations) {
    code += `        case '${op.id}':
          return await this.${toCamelCase(op.name)}(params)
`
  }

  code += `        default:
          throw new Error(\`Unknown operation: \${operationId}\`)
      }
`

  if (includeErrorHandling) {
    code += `    } catch (error) {
      this.context?.logger.error(\`Operation \${operationId} failed\`, error as Error)
      throw error
    }
`
  }

  code += `  }

  isConnected(): boolean {
    return this.connected
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.context?.logger.info('${config.name} connector disconnected')
  }

  setContext(context: ComponentExecutionContext): void {
    this.context = context
  }
`

  // Generate method for each operation
  for (const op of config.operations) {
    code += `
  private async ${toCamelCase(op.name)}(params: Record<string, unknown>): Promise<unknown> {
    const url = \`\${this.config.baseUrl || ''}${op.path}\`
`

    if (config.auth.type === 'api_key') {
      code += `    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      '${config.auth.apiKey?.header || 'X-API-Key'}': this.apiKey!
    }
`
    } else if (config.auth.type === 'bearer' || config.auth.type === 'oauth2') {
      code += `    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${this.accessToken}\`
    }
`
    } else {
      code += `    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
`
    }

    code += `
    const response = await fetch(url, {
      method: '${op.method}',
      headers,${op.isMutating ? `
      body: JSON.stringify(params),` : ''}
      signal: this.context?.signal
    })

    if (!response.ok) {
      throw new Error(\`${op.name} failed: HTTP \${response.status}\`)
    }

    return await response.json()
  }
`
  }

  code += `}
`

  return {
    type: 'connector',
    id: config.id,
    className,
    code,
    imports,
    dependencies: []
  }
}

/**
 * Generate processor code
 */
export function generateProcessorCode(
  config: ProcessorConfig,
  options: GenerationOptions = {}
): GeneratedComponent {
  const { includeComments = true } = options

  const className = toPascalCase(config.name) + 'Processor'
  const imports = [
    "import { RuntimeProcessor, ValidationResult, ComponentExecutionContext } from '../runtime-types'"
  ]

  let code = ''

  if (includeComments) {
    code += `/**
 * ${config.name} Processor
 * ${config.description}
 * Type: ${config.type}
 */\n`
  }

  // Add imports
  code += `import { RuntimeProcessor, ComponentExecutionContext, ValidationResult } from '../runtime-types'

`

  // Add config as const
  code += `const processorConfig = ${JSON.stringify(config, null, 2)}

`

  code += `export class ${className} implements RuntimeProcessor {
  id = '${config.id}'
  config = processorConfig

  private context?: ComponentExecutionContext

  async process(input: unknown): Promise<unknown> {
`

  // Generate processing logic based on type
  switch (config.type) {
    case 'filter':
      code += generateFilterLogic(config)
      break
    case 'transform':
      code += generateTransformLogic(config)
      break
    case 'aggregate':
      code += generateAggregateLogic(config)
      break
    case 'classify':
      code += generateClassifyLogic(config)
      break
    case 'enrich':
      code += generateEnrichLogic(config)
      break
    case 'validate':
      code += generateValidateLogic(config)
      break
    default:
      code += `    // Custom processing logic
    // TODO: Implement based on: ${config.logic}
    return input
`
  }

  code += `  }

  validateInput(input: unknown): ValidationResult {
    const errors: string[] = []
    // TODO: Validate against input schema
    // Schema: ${JSON.stringify(config.inputSchema)}
    return { valid: errors.length === 0, errors }
  }

  validateOutput(output: unknown): ValidationResult {
    const errors: string[] = []
    // TODO: Validate against output schema
    // Schema: ${JSON.stringify(config.outputSchema)}
    return { valid: errors.length === 0, errors }
  }

  setContext(context: ComponentExecutionContext): void {
    this.context = context
  }
}
`

  return {
    type: 'processor',
    id: config.id,
    className,
    code,
    imports,
    dependencies: []
  }
}

/**
 * Generate filter processing logic
 */
function generateFilterLogic(config: ProcessorConfig): string {
  let code = `    // Filter logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]
`

  if (config.filterCondition) {
    code += `
    const filtered = items.filter((item: unknown) => {
      // Filter condition: ${config.filterCondition}
      // TODO: Implement filter condition
      return true
    })

    this.context?.logger.info(\`Filtered \${items.length} items to \${filtered.length}\`)
    return filtered
`
  } else {
    code += `
    // TODO: Implement filter based on: ${config.logic}
    return items
`
  }

  return code
}

/**
 * Generate transform processing logic
 */
function generateTransformLogic(config: ProcessorConfig): string {
  return `    // Transform logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]

    const transformed = items.map((item: unknown) => {
      // TODO: Implement transformation
      return item
    })

    this.context?.logger.info(\`Transformed \${items.length} items\`)
    return Array.isArray(input) ? transformed : transformed[0]
`
}

/**
 * Generate aggregate processing logic
 */
function generateAggregateLogic(config: ProcessorConfig): string {
  let code = `    // Aggregate logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]
`

  if (config.aggregationConfig) {
    const groupBy = config.aggregationConfig.groupBy || []
    code += `
    // Group by: ${groupBy.join(', ') || 'none'}
    const groups = new Map<string, unknown[]>()

    for (const item of items) {
      const key = ${groupBy.length > 0 ?
        `[${groupBy.map(f => `(item as Record<string, unknown>)['${f}']`).join(', ')}].join('|')` :
        "'all'"
      }
      const group = groups.get(key) || []
      group.push(item)
      groups.set(key, group)
    }

    const aggregated = []
    for (const [key, group] of groups) {
      aggregated.push({
        key,
        count: group.length,
        items: group
      })
    }

    this.context?.logger.info(\`Aggregated \${items.length} items into \${aggregated.length} groups\`)
    return aggregated
`
  } else {
    code += `
    // TODO: Implement aggregation
    return { count: items.length, items }
`
  }

  return code
}

/**
 * Generate classify processing logic
 */
function generateClassifyLogic(config: ProcessorConfig): string {
  let code = `    // Classify logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]
`

  if (config.classificationConfig) {
    const categories = config.classificationConfig.categories
    code += `
    const categories = ${JSON.stringify(categories.map(c => c.name))}
    const unknown = '${config.classificationConfig.unknownCategory || 'unknown'}'

    const classified = items.map((item: unknown) => {
      // TODO: Implement classification logic
      // Categories: ${categories.map(c => c.name).join(', ')}
      const category = unknown

      return {
        item,
        category,
        confidence: 0
      }
    })

    this.context?.logger.info(\`Classified \${items.length} items\`)
    return classified
`
  } else {
    code += `
    // TODO: Implement classification
    return items.map(item => ({ item, category: 'unknown' }))
`
  }

  return code
}

/**
 * Generate enrich processing logic
 */
function generateEnrichLogic(config: ProcessorConfig): string {
  return `    // Enrich logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]

    const enriched = await Promise.all(items.map(async (item: unknown) => {
      // TODO: Implement enrichment (e.g., fetch additional data)
      return {
        ...(item as object),
        enrichedAt: Date.now()
      }
    }))

    this.context?.logger.info(\`Enriched \${items.length} items\`)
    return Array.isArray(input) ? enriched : enriched[0]
`
}

/**
 * Generate validate processing logic
 */
function generateValidateLogic(config: ProcessorConfig): string {
  return `    // Validate logic: ${config.logic}
    const items = Array.isArray(input) ? input : [input]

    const validated = items.map((item: unknown) => {
      const errors: string[] = []

      // TODO: Implement validation rules

      return {
        item,
        valid: errors.length === 0,
        errors
      }
    })

    const validCount = validated.filter(v => v.valid).length
    this.context?.logger.info(\`Validated \${items.length} items, \${validCount} valid\`)

    return validated
`
}

/**
 * Generate action code
 */
export function generateActionCode(
  config: ActionConfig,
  definition: AgentDefinition,
  options: GenerationOptions = {}
): GeneratedComponent {
  const { includeComments = true } = options

  const className = toPascalCase(config.name) + 'Action'
  const imports = [
    "import { RuntimeAction, RuntimeConnector, ActionResult, ComponentExecutionContext } from '../runtime-types'"
  ]

  // Find the connector this action uses
  const connector = definition.components.connectors.find(c => c.id === config.connectorId)
  const connectorClass = connector ? toPascalCase(connector.name) + 'Connector' : 'RuntimeConnector'

  let code = ''

  if (includeComments) {
    code += `/**
 * ${config.name} Action
 * ${config.description}
 * Type: ${config.type}
 * Requires approval: ${config.requiresApproval}
 */\n`
  }

  // Add imports
  code += `import { RuntimeAction, RuntimeConnector, ComponentExecutionContext, ActionResult } from '../runtime-types'

`

  // Add config as const
  code += `const actionConfig = ${JSON.stringify(config, null, 2)}

`

  code += `export class ${className} implements RuntimeAction {
  id = '${config.id}'
  config = actionConfig

  private connector: RuntimeConnector
  private context?: ComponentExecutionContext

  constructor(connector: RuntimeConnector) {
    this.connector = connector
  }

  async execute(data: unknown): Promise<ActionResult> {
    try {
      // Check conditions
      if (!this.canExecute(data)) {
        return {
          success: false,
          error: 'Action conditions not met'
        }
      }
`

  if (config.requiresApproval) {
    code += `
      // This action requires approval
      // Approval should be handled by the oversight manager
      this.context?.logger.info('Action ${config.name} requires approval before execution')
`
  }

  // Generate template application if present
  if (config.template) {
    code += `
      // Apply template
      const formattedData = this.applyTemplate(data)
`
  }

  // Execute via connector
  code += `
      // Execute via connector
      const result = await this.connector.execute(
        '${config.operationId}',
        ${config.template ? 'formattedData as Record<string, unknown>' : 'data as Record<string, unknown>'}
      )

      this.context?.logger.info('Action ${config.name} executed successfully')

      return {
        success: true,
        data: result
      }
    } catch (error) {
      this.context?.logger.error('Action ${config.name} failed', error as Error)
`

  // Add retry logic if configured
  if (config.retry) {
    code += `
      // TODO: Implement retry logic
      // Max attempts: ${config.retry.maxAttempts}
      // Backoff: ${config.retry.backoffMs}ms
`
  }

  code += `
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  canExecute(data: unknown): boolean {
`

  if (config.conditions && config.conditions.length > 0) {
    code += `    const record = data as Record<string, unknown>

    // Check conditions
${config.conditions.map(c => {
      switch (c.operator) {
        case 'eq':
          return `    if (record['${c.field}'] !== ${JSON.stringify(c.value)}) return false`
        case 'neq':
          return `    if (record['${c.field}'] === ${JSON.stringify(c.value)}) return false`
        case 'exists':
          return `    if (record['${c.field}'] === undefined) return false`
        default:
          return `    // TODO: Implement ${c.operator} check for ${c.field}`
      }
    }).join('\n')}

`
  }

  code += `    return true
  }

  getConnector(): RuntimeConnector {
    return this.connector
  }
`

  if (config.template) {
    code += `
  private applyTemplate(data: unknown): unknown {
    const template = ${JSON.stringify(config.template.template)}
    const variables = ${JSON.stringify(config.template.variables)}
    const record = data as Record<string, unknown>

    // Simple template variable replacement
    let result = template
    for (const variable of variables) {
      const value = record[variable]
      result = result.replace(new RegExp(\`\\$\\{\${variable}\\}\`, 'g'), String(value ?? ''))
    }

    if (${JSON.stringify(config.template.format)} === 'json') {
      return JSON.parse(result)
    }

    return result
  }
`
  }

  code += `
  setContext(context: ComponentExecutionContext): void {
    this.context = context
  }
}
`

  return {
    type: 'action',
    id: config.id,
    className,
    code,
    imports,
    dependencies: [config.connectorId]
  }
}

/**
 * Generate trigger code
 */
export function generateTriggerCode(
  config: TriggerConfig,
  options: GenerationOptions = {}
): GeneratedComponent {
  const { includeComments = true } = options

  const className = toPascalCase(config.name) + 'Trigger'
  const imports = [
    "import { RuntimeTrigger, TriggerCallback, TriggerContext, ComponentExecutionContext } from '../runtime-types'"
  ]

  let code = ''

  if (includeComments) {
    code += `/**
 * ${config.name} Trigger
 * Type: ${config.type}
 */\n`
  }

  // Add imports
  code += `import { RuntimeTrigger, TriggerCallback, TriggerContext, ComponentExecutionContext } from '../runtime-types'

`

  // Add config as const
  code += `const triggerConfig = ${JSON.stringify(config, null, 2)}

`

  code += `export class ${className} implements RuntimeTrigger {
  id = '${config.id}'
  config = triggerConfig

  private active = false
  private callback?: TriggerCallback
  private context?: ComponentExecutionContext
`

  // Type-specific properties
  if (config.type === 'schedule') {
    code += `  private intervalId?: NodeJS.Timeout
`
  }

  code += `
  start(callback: TriggerCallback): void {
    this.callback = callback
    this.active = true
`

  switch (config.type) {
    case 'schedule':
      code += generateScheduleTriggerStart(config)
      break
    case 'webhook':
      code += generateWebhookTriggerStart(config)
      break
    case 'event':
      code += generateEventTriggerStart(config)
      break
    case 'manual':
      code += `    // Manual trigger - use invoke() to trigger
    this.context?.logger.info('Manual trigger ${config.name} started')
`
      break
  }

  code += `  }

  stop(): void {
    this.active = false
`

  if (config.type === 'schedule') {
    code += `    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
`
  }

  code += `    this.context?.logger.info('Trigger ${config.name} stopped')
  }

  isActive(): boolean {
    return this.active
  }

  invoke(): void {
    if (!this.callback) {
      this.context?.logger.warn('Trigger ${config.name} invoked but no callback set')
      return
    }

    const context: TriggerContext = {
      triggerId: this.id,
      triggerType: '${config.type}',
      triggeredAt: Date.now()
    }

    this.callback(context).catch(error => {
      this.context?.logger.error('Trigger callback failed', error as Error)
    })
  }

  setContext(context: ComponentExecutionContext): void {
    this.context = context
  }
}
`

  return {
    type: 'trigger',
    id: config.id,
    className,
    code,
    imports,
    dependencies: []
  }
}

/**
 * Generate schedule trigger start logic
 */
function generateScheduleTriggerStart(config: TriggerConfig): string {
  if (!config.schedule) {
    return `    // No schedule configured
`
  }

  // For simplicity, convert common cron patterns to intervals
  // In production, use a proper cron library
  return `
    // Schedule: ${config.schedule.cron}
    // Timezone: ${config.schedule.timezone}
    // ${config.schedule.description || ''}

    // Simple interval-based implementation
    // TODO: Use proper cron library for production
    const intervalMs = this.parseCronToInterval('${config.schedule.cron}')

    this.intervalId = setInterval(() => {
      this.invoke()
    }, intervalMs)

    // Run on deploy if configured
    ${config.runOnDeploy ? 'setTimeout(() => this.invoke(), 1000)' : ''}

    this.context?.logger.info('Schedule trigger ${config.name} started')
`
}

/**
 * Generate webhook trigger start logic
 */
function generateWebhookTriggerStart(config: TriggerConfig): string {
  if (!config.webhook) {
    return `    // No webhook configured
`
  }

  return `
    // Webhook path: ${config.webhook.path}
    // Method: ${config.webhook.method}
    // Note: Webhook endpoint must be registered with the server

    this.context?.logger.info('Webhook trigger ${config.name} registered at ${config.webhook.path}')
`
}

/**
 * Generate event trigger start logic
 */
function generateEventTriggerStart(config: TriggerConfig): string {
  if (!config.event) {
    return `    // No event configured
`
  }

  return `
    // Event source: ${config.event.source}
    // Event type: ${config.event.eventType}
    // Note: Event listener must be registered with the event system

    this.context?.logger.info('Event trigger ${config.name} listening for ${config.event.eventType}')
`
}

/**
 * Convert string to PascalCase
 */
function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')
}

/**
 * Convert string to camelCase
 */
function toCamelCase(str: string): string {
  const pascal = toPascalCase(str)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Convert string to SCREAMING_SNAKE_CASE
 */
function toScreamingSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toUpperCase()
}
