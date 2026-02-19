/**
 * Oversight Manager
 * Handles approval checkpoints and human oversight for agent actions
 */

import { OversightLevel } from '../config/schema'

/**
 * Approval request
 */
export interface ApprovalRequest {
  id: string
  agentId: string
  actionId: string
  actionName: string
  actionType: string
  data: unknown
  requestedAt: number
  timeoutMs?: number
  reason?: string
}

/**
 * Approval decision
 */
export interface ApprovalDecision {
  requestId: string
  approved: boolean
  approvedBy?: string
  approvedAt: number
  notes?: string
}

/**
 * Oversight manager configuration
 */
export interface OversightManagerConfig {
  /** Default oversight level */
  level: OversightLevel

  /** Default timeout for approval requests (ms) */
  defaultTimeoutMs?: number

  /** Callback when approval is required */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<void>

  /** Callback when approval is auto-expired */
  onApprovalExpired?: (request: ApprovalRequest) => void

  /** Callback when decision is made */
  onDecisionMade?: (decision: ApprovalDecision) => void
}

/**
 * Pending approval with resolver
 */
interface PendingApproval {
  request: ApprovalRequest
  resolve: (approved: boolean) => void
  timeoutId?: ReturnType<typeof setTimeout>
}

/**
 * Manages human oversight and approval workflows
 */
export class OversightManager {
  private config: OversightManagerConfig
  private pendingApprovals = new Map<string, PendingApproval>()
  private decisionHistory: ApprovalDecision[] = []

  constructor(config: OversightManagerConfig) {
    this.config = {
      defaultTimeoutMs: 300000, // 5 minutes
      ...config
    }
  }

  /**
   * Request approval for an action
   */
  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    // Check if auto-approve based on level
    if (this.shouldAutoApprove(request)) {
      return true
    }

    // Create promise that resolves when decision is made
    return new Promise<boolean>((resolve) => {
      const pending: PendingApproval = {
        request,
        resolve
      }

      // Set up timeout if configured
      const timeout = request.timeoutMs || this.config.defaultTimeoutMs
      if (timeout) {
        pending.timeoutId = setTimeout(() => {
          this.handleTimeout(request.id)
        }, timeout)
      }

      this.pendingApprovals.set(request.id, pending)

      // Notify about approval requirement
      this.config.onApprovalRequired?.(request)
    })
  }

  /**
   * Submit a decision for a pending approval
   */
  async submitDecision(
    requestId: string,
    approved: boolean,
    approvedBy?: string,
    notes?: string
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) {
      throw new Error(`No pending approval found: ${requestId}`)
    }

    // Clear timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }

    // Record decision
    const decision: ApprovalDecision = {
      requestId,
      approved,
      approvedBy,
      approvedAt: Date.now(),
      notes
    }
    this.decisionHistory.push(decision)

    // Notify about decision
    this.config.onDecisionMade?.(decision)

    // Resolve the promise
    pending.resolve(approved)
    this.pendingApprovals.delete(requestId)
  }

  /**
   * Handle timeout for an approval request
   */
  private handleTimeout(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return

    // Notify about expiration
    this.config.onApprovalExpired?.(pending.request)

    // Default to rejection on timeout
    const decision: ApprovalDecision = {
      requestId,
      approved: false,
      approvedAt: Date.now(),
      notes: 'Auto-rejected due to timeout'
    }
    this.decisionHistory.push(decision)

    pending.resolve(false)
    this.pendingApprovals.delete(requestId)
  }

  /**
   * Check if an action should be auto-approved based on oversight level
   */
  private shouldAutoApprove(request: ApprovalRequest): boolean {
    switch (this.config.level) {
      case 'autonomous':
        return true // Auto-approve everything
      case 'monitored':
        return true // Auto-approve but log
      case 'approval_required':
        // Only auto-approve non-mutating actions
        return !this.isMutatingAction(request.actionType)
      case 'manual':
        return false // Never auto-approve
      default:
        return false
    }
  }

  /**
   * Check if an action type is mutating
   */
  private isMutatingAction(actionType: string): boolean {
    return ['create', 'update', 'delete', 'send'].includes(actionType)
  }

  /**
   * Get all pending approval requests
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map(p => p.request)
  }

  /**
   * Get a specific pending request
   */
  getPendingRequest(id: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(id)?.request
  }

  /**
   * Cancel a pending approval request
   */
  cancelRequest(requestId: string, reason?: string): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }

    const decision: ApprovalDecision = {
      requestId,
      approved: false,
      approvedAt: Date.now(),
      notes: reason || 'Cancelled'
    }
    this.decisionHistory.push(decision)

    pending.resolve(false)
    this.pendingApprovals.delete(requestId)
  }

  /**
   * Get decision history
   */
  getDecisionHistory(limit?: number): ApprovalDecision[] {
    if (limit) {
      return this.decisionHistory.slice(-limit)
    }
    return [...this.decisionHistory]
  }

  /**
   * Clear decision history
   */
  clearHistory(): void {
    this.decisionHistory = []
  }

  /**
   * Update the oversight level
   */
  setLevel(level: OversightLevel): void {
    this.config.level = level
  }

  /**
   * Get current oversight level
   */
  getLevel(): OversightLevel {
    return this.config.level
  }
}

/**
 * Create an oversight manager for a specific level
 */
export function createOversightManager(
  level: OversightLevel,
  options: Partial<OversightManagerConfig> = {}
): OversightManager {
  return new OversightManager({ level, ...options })
}

/**
 * Notification channel interface
 */
export interface NotificationChannel {
  send(notification: ApprovalNotification): Promise<void>
}

/**
 * Approval notification
 */
export interface ApprovalNotification {
  type: 'approval_required' | 'approval_expired' | 'decision_made'
  request: ApprovalRequest
  decision?: ApprovalDecision
}

/**
 * Console notification channel (for development)
 */
export class ConsoleNotificationChannel implements NotificationChannel {
  async send(notification: ApprovalNotification): Promise<void> {
    switch (notification.type) {
      case 'approval_required':
        console.log('\n========================================')
        console.log('APPROVAL REQUIRED')
        console.log('========================================')
        console.log(`Action: ${notification.request.actionName}`)
        console.log(`Type: ${notification.request.actionType}`)
        console.log(`Agent: ${notification.request.agentId}`)
        console.log(`Request ID: ${notification.request.id}`)
        if (notification.request.reason) {
          console.log(`Reason: ${notification.request.reason}`)
        }
        console.log(`Data:`, JSON.stringify(notification.request.data, null, 2))
        console.log('========================================\n')
        break

      case 'approval_expired':
        console.log(`[EXPIRED] Approval request ${notification.request.id} expired`)
        break

      case 'decision_made':
        const decision = notification.decision!
        console.log(
          `[DECISION] ${notification.request.actionName}: ${decision.approved ? 'APPROVED' : 'REJECTED'}` +
          (decision.approvedBy ? ` by ${decision.approvedBy}` : '')
        )
        break
    }
  }
}

/**
 * Webhook notification channel
 */
export class WebhookNotificationChannel implements NotificationChannel {
  private url: string
  private headers: Record<string, string>

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url
    this.headers = headers
  }

  async send(notification: ApprovalNotification): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers
        },
        body: JSON.stringify(notification)
      })
    } catch (error) {
      console.error('Failed to send webhook notification:', error)
    }
  }
}

/**
 * Multi-channel notifier
 */
export class MultiChannelNotifier {
  private channels: NotificationChannel[] = []

  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel)
  }

  removeChannel(channel: NotificationChannel): void {
    const index = this.channels.indexOf(channel)
    if (index !== -1) {
      this.channels.splice(index, 1)
    }
  }

  async notify(notification: ApprovalNotification): Promise<void> {
    await Promise.all(
      this.channels.map(channel => channel.send(notification))
    )
  }
}

/**
 * Create an oversight manager with notification channels
 */
export function createOversightManagerWithNotifications(
  level: OversightLevel,
  channels: NotificationChannel[],
  options: Partial<OversightManagerConfig> = {}
): OversightManager {
  const notifier = new MultiChannelNotifier()
  for (const channel of channels) {
    notifier.addChannel(channel)
  }

  return new OversightManager({
    level,
    ...options,
    onApprovalRequired: async (request) => {
      await notifier.notify({ type: 'approval_required', request })
    },
    onApprovalExpired: (request) => {
      notifier.notify({ type: 'approval_expired', request })
    },
    onDecisionMade: (decision) => {
      // Find the original request if still available
      // This is a simplified version
      notifier.notify({
        type: 'decision_made',
        request: {
          id: decision.requestId,
          agentId: '',
          actionId: '',
          actionName: '',
          actionType: '',
          data: null,
          requestedAt: 0
        },
        decision
      })
    }
  })
}

/**
 * Approval UI helper - formats request for display
 */
export function formatApprovalRequest(request: ApprovalRequest): string {
  const lines = [
    `Request ID: ${request.id}`,
    `Action: ${request.actionName} (${request.actionType})`,
    `Agent: ${request.agentId}`,
    `Requested: ${new Date(request.requestedAt).toLocaleString()}`
  ]

  if (request.timeoutMs) {
    const expiresAt = new Date(request.requestedAt + request.timeoutMs)
    lines.push(`Expires: ${expiresAt.toLocaleString()}`)
  }

  if (request.reason) {
    lines.push(`Reason: ${request.reason}`)
  }

  lines.push('', 'Data:', JSON.stringify(request.data, null, 2))

  return lines.join('\n')
}
