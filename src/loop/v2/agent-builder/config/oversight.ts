/**
 * Oversight Level Definitions
 * Defines the different levels of human oversight for agents
 */

import {
  OversightConfig,
  OversightLevel,
  CheckpointConfig,
  NotificationConfig
} from './schema'

/**
 * Descriptions of each oversight level
 */
export const OVERSIGHT_LEVEL_DESCRIPTIONS: Record<OversightLevel, OversightLevelDescription> = {
  autonomous: {
    level: 'autonomous',
    name: 'Autonomous',
    description: 'Agent runs completely independently with minimal oversight',
    details: [
      'No approval required for any actions',
      'Only notified on errors',
      'Full automation - no human intervention needed',
      'Best for: Low-risk, well-tested agents'
    ],
    riskLevel: 'low',
    humanInvolvementRequired: false
  },

  monitored: {
    level: 'monitored',
    name: 'Monitored',
    description: 'Agent runs automatically but with visibility into all actions',
    details: [
      'No approval required, but all actions are logged',
      'Notifications on start, completion, and errors',
      'Human can review logs and intervene if needed',
      'Best for: Medium-risk agents, training new agents'
    ],
    riskLevel: 'medium',
    humanInvolvementRequired: false
  },

  approval_required: {
    level: 'approval_required',
    name: 'Approval Required',
    description: 'Agent pauses before critical actions for human approval',
    details: [
      'Approval required before mutating actions',
      'Agent pauses and waits for human decision',
      'Timeout can auto-approve or reject',
      'Best for: High-value actions, new integrations'
    ],
    riskLevel: 'low-medium',
    humanInvolvementRequired: true
  },

  manual: {
    level: 'manual',
    name: 'Manual',
    description: 'Human must approve every step of the agent execution',
    details: [
      'Approval required for every action',
      'Full human control over agent behavior',
      'Slowest but most controlled execution',
      'Best for: Testing, debugging, high-risk operations'
    ],
    riskLevel: 'minimal',
    humanInvolvementRequired: true
  }
}

export interface OversightLevelDescription {
  level: OversightLevel
  name: string
  description: string
  details: string[]
  riskLevel: 'minimal' | 'low' | 'low-medium' | 'medium' | 'high'
  humanInvolvementRequired: boolean
}

/**
 * Create default oversight config for a given level
 */
export function createDefaultOversightConfig(level: OversightLevel): OversightConfig {
  switch (level) {
    case 'autonomous':
      return {
        level: 'autonomous',
        checkpoints: [],
        notifications: {
          onStart: false,
          onComplete: false,
          onError: true,
          onApprovalRequired: false,
          channels: []
        }
      }

    case 'monitored':
      return {
        level: 'monitored',
        checkpoints: [
          {
            id: 'log_all_actions',
            name: 'Log All Actions',
            trigger: 'before_action',
            action: 'log'
          }
        ],
        notifications: {
          onStart: true,
          onComplete: true,
          onError: true,
          onApprovalRequired: false,
          channels: []
        }
      }

    case 'approval_required':
      return {
        level: 'approval_required',
        checkpoints: [
          {
            id: 'approve_mutations',
            name: 'Approve Mutations',
            trigger: 'before_action',
            action: 'require_approval',
            timeoutMs: 300000, // 5 minutes
            timeoutAction: 'notify'
          },
          {
            id: 'notify_errors',
            name: 'Notify on Errors',
            trigger: 'on_error',
            action: 'notify'
          }
        ],
        notifications: {
          onStart: true,
          onComplete: true,
          onError: true,
          onApprovalRequired: true,
          channels: []
        }
      }

    case 'manual':
      return {
        level: 'manual',
        checkpoints: [
          {
            id: 'approve_all',
            name: 'Approve All Actions',
            trigger: 'before_action',
            action: 'require_approval',
            timeoutMs: 600000, // 10 minutes
            timeoutAction: 'reject'
          }
        ],
        notifications: {
          onStart: true,
          onComplete: true,
          onError: true,
          onApprovalRequired: true,
          channels: []
        }
      }
  }
}

/**
 * Validate an oversight configuration
 */
export function validateOversightConfig(config: OversightConfig): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check that level is valid
  if (!OVERSIGHT_LEVEL_DESCRIPTIONS[config.level]) {
    errors.push(`Invalid oversight level: ${config.level}`)
  }

  // Check checkpoints
  for (const checkpoint of config.checkpoints) {
    if (!checkpoint.id) {
      errors.push('Checkpoint missing id')
    }
    if (!checkpoint.trigger) {
      errors.push(`Checkpoint ${checkpoint.id} missing trigger`)
    }
    if (!checkpoint.action) {
      errors.push(`Checkpoint ${checkpoint.id} missing action`)
    }

    // Warn about timeouts without timeout action
    if (checkpoint.timeoutMs && !checkpoint.timeoutAction) {
      warnings.push(`Checkpoint ${checkpoint.id} has timeout but no timeout action`)
    }
  }

  // Warn about autonomous with checkpoints
  if (config.level === 'autonomous' && config.checkpoints.length > 0) {
    warnings.push('Autonomous level with checkpoints may not be truly autonomous')
  }

  // Warn about manual without approval checkpoints
  if (config.level === 'manual') {
    const hasApproval = config.checkpoints.some(c => c.action === 'require_approval')
    if (!hasApproval) {
      warnings.push('Manual level should have approval checkpoints')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Get recommended oversight level based on agent characteristics
 */
export function recommendOversightLevel(characteristics: AgentCharacteristics): OversightLevel {
  // High risk factors push toward manual
  if (characteristics.hasFinancialActions) return 'manual'
  if (characteristics.hasDeleteActions && characteristics.isNewAgent) return 'manual'

  // Medium risk factors push toward approval_required
  if (characteristics.hasExternalApiCalls && characteristics.isNewAgent) return 'approval_required'
  if (characteristics.hasSendActions) return 'approval_required'
  if (characteristics.hasDeleteActions) return 'approval_required'

  // Low risk factors allow monitored
  if (characteristics.isNewAgent) return 'monitored'
  if (characteristics.hasExternalApiCalls) return 'monitored'

  // Very low risk allows autonomous
  if (characteristics.isReadOnly) return 'autonomous'
  if (characteristics.isWellTested) return 'autonomous'

  // Default to monitored
  return 'monitored'
}

export interface AgentCharacteristics {
  isNewAgent: boolean
  isWellTested: boolean
  isReadOnly: boolean
  hasExternalApiCalls: boolean
  hasSendActions: boolean
  hasDeleteActions: boolean
  hasFinancialActions: boolean
}

/**
 * Check if an action requires approval based on oversight config
 */
export function requiresApproval(
  config: OversightConfig,
  actionType: string,
  isMutating: boolean
): boolean {
  // Manual always requires approval
  if (config.level === 'manual') return true

  // Autonomous never requires approval (except for explicit checkpoints)
  if (config.level === 'autonomous') {
    // Check if there's an explicit checkpoint for this action
    return config.checkpoints.some(
      c => c.trigger === 'before_action' && c.action === 'require_approval'
    )
  }

  // Approval required level requires approval for mutations
  if (config.level === 'approval_required' && isMutating) return true

  // Check explicit checkpoints
  return config.checkpoints.some(
    c => c.trigger === 'before_action' && c.action === 'require_approval'
  )
}

/**
 * Create a checkpoint configuration
 */
export function createCheckpoint(
  id: string,
  name: string,
  trigger: CheckpointConfig['trigger'],
  action: CheckpointConfig['action'],
  options?: Partial<CheckpointConfig>
): CheckpointConfig {
  return {
    id,
    name,
    trigger,
    action,
    ...options
  }
}

/**
 * Add common notification channel configurations
 */
export function addEmailNotification(
  config: OversightConfig,
  email: string
): OversightConfig {
  return {
    ...config,
    notifications: {
      ...config.notifications,
      channels: [
        ...config.notifications.channels,
        {
          type: 'email',
          config: { to: email }
        }
      ]
    }
  }
}

export function addSlackNotification(
  config: OversightConfig,
  webhookUrl: string,
  channel?: string
): OversightConfig {
  return {
    ...config,
    notifications: {
      ...config.notifications,
      channels: [
        ...config.notifications.channels,
        {
          type: 'slack',
          config: {
            webhookUrl,
            ...(channel && { channel })
          }
        }
      ]
    }
  }
}

export function addWebhookNotification(
  config: OversightConfig,
  url: string,
  headers?: Record<string, string>
): OversightConfig {
  return {
    ...config,
    notifications: {
      ...config.notifications,
      channels: [
        ...config.notifications.channels,
        {
          type: 'webhook',
          config: {
            url,
            ...(headers && { headers: JSON.stringify(headers) })
          }
        }
      ]
    }
  }
}
