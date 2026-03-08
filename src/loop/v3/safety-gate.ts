/**
 * Safety Gate — Action classification, approval gating, budget/rate limiting.
 *
 * Classifies actions by risk (read_only, low_risk_write, high_risk_write, irreversible),
 * enforces safety policies (budget, rate limits, approval requirements), and tracks
 * execution history for auditing.
 */

import type { RiskLevel } from '../../risk-gate.js';
import type { ActionSpec, SafetyPolicy, SafetyActionClass } from './types.js';

// ── Types ───────────────────────────────────────────────────

export interface ApprovalGateResult {
  approved: boolean;
  actionClass: SafetyActionClass;
  riskLevel: RiskLevel;
  reason: string;
  requiresHumanApproval: boolean;
  budgetRemaining: number;
}

// ── Tool classification maps ────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'file_read', 'list_directory', 'grep', 'web_fetch', 'web_search',
  'git_status', 'git_log', 'git_diff',
]);

const LOW_RISK_WRITE_TOOLS = new Set([
  'file_write', 'create_directory',
]);

const HIGH_RISK_WRITE_TOOLS = new Set([
  'shell_execute', 'database_query', 'git_commit', 'git_push',
]);

const IRREVERSIBLE_TOOLS = new Set([
  'file_delete', 'git_force_push', 'database_drop', 'rm_rf',
]);

const DEFAULT_POLICY: SafetyPolicy = {
  maxBudget: 10.0, // $10 default budget
  maxActionsPerMinute: 30,
  dataAccessBoundaries: [],
  requireApproval: ['irreversible'],
  auditAll: false,
};

// ── Safety Gate ─────────────────────────────────────────────

interface ExecutionRecord {
  timestamp: number;
  toolName: string;
  durationMs: number;
  success: boolean;
  cost: number;
}

export class SafetyGate {
  private policy: SafetyPolicy;
  private executionLog: ExecutionRecord[] = [];
  private totalCost: number = 0;

  constructor(policy?: Partial<SafetyPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * Classify an action by its safety risk level.
   */
  classifyAction(action: ActionSpec): SafetyActionClass {
    const tool = action.toolName;

    if (READ_ONLY_TOOLS.has(tool)) return 'read_only';
    if (IRREVERSIBLE_TOOLS.has(tool)) return 'irreversible';
    if (HIGH_RISK_WRITE_TOOLS.has(tool)) return 'high_risk_write';
    if (LOW_RISK_WRITE_TOOLS.has(tool)) return 'low_risk_write';

    // Default classification based on action type
    switch (action.actionType) {
      case 'read_file':
      case 'search':
        return 'read_only';
      case 'write_file':
      case 'code_exec':
        return 'low_risk_write';
      case 'api_call':
      case 'browser_step':
        return 'high_risk_write';
      default:
        return 'low_risk_write';
    }
  }

  /**
   * Check if an action is approved under the current safety policy.
   */
  checkApproval(action: ActionSpec): ApprovalGateResult {
    const actionClass = this.classifyAction(action);
    const riskLevel = this.actionClassToRiskLevel(actionClass);

    // Budget check
    const projectedCost = this.totalCost + action.costEstimate;
    if (projectedCost > this.policy.maxBudget) {
      return {
        approved: false,
        actionClass,
        riskLevel,
        reason: `Budget exceeded: $${projectedCost.toFixed(2)} > $${this.policy.maxBudget.toFixed(2)}`,
        requiresHumanApproval: true,
        budgetRemaining: Math.max(0, this.policy.maxBudget - this.totalCost),
      };
    }

    // Rate limit check
    const now = Date.now();
    const recentActions = this.executionLog.filter(r => now - r.timestamp < 60_000);
    if (recentActions.length >= this.policy.maxActionsPerMinute) {
      return {
        approved: false,
        actionClass,
        riskLevel,
        reason: `Rate limit exceeded: ${recentActions.length} actions in last minute (max: ${this.policy.maxActionsPerMinute})`,
        requiresHumanApproval: false,
        budgetRemaining: Math.max(0, this.policy.maxBudget - this.totalCost),
      };
    }

    // Data access boundary check
    if (this.policy.dataAccessBoundaries.length > 0) {
      const target = String(action.params.path || action.params.url || '');
      if (target && !this.isWithinBoundaries(target)) {
        return {
          approved: false,
          actionClass,
          riskLevel,
          reason: `Action target "${target}" is outside allowed data access boundaries`,
          requiresHumanApproval: true,
          budgetRemaining: Math.max(0, this.policy.maxBudget - this.totalCost),
        };
      }
    }

    // Approval requirement check
    const requiresApproval = this.policy.requireApproval.includes(actionClass);
    if (requiresApproval) {
      return {
        approved: false,
        actionClass,
        riskLevel,
        reason: `Action class "${actionClass}" requires human approval`,
        requiresHumanApproval: true,
        budgetRemaining: Math.max(0, this.policy.maxBudget - this.totalCost),
      };
    }

    return {
      approved: true,
      actionClass,
      riskLevel,
      reason: 'Action approved',
      requiresHumanApproval: false,
      budgetRemaining: Math.max(0, this.policy.maxBudget - this.totalCost),
    };
  }

  /**
   * Record an action execution for auditing and rate limiting.
   */
  recordExecution(action: ActionSpec, durationMs: number, success: boolean): void {
    this.executionLog.push({
      timestamp: Date.now(),
      toolName: action.toolName,
      durationMs,
      success,
      cost: action.costEstimate,
    });
    this.totalCost += action.costEstimate;
  }

  /**
   * Get current budget remaining.
   */
  getBudgetRemaining(): number {
    return Math.max(0, this.policy.maxBudget - this.totalCost);
  }

  /**
   * Get total actions executed in the current session.
   */
  getTotalActions(): number {
    return this.executionLog.length;
  }

  // ── Helpers ──────────────────────────────────────────────

  private actionClassToRiskLevel(actionClass: SafetyActionClass): RiskLevel {
    switch (actionClass) {
      case 'read_only': return 'low';
      case 'low_risk_write': return 'medium';
      case 'high_risk_write': return 'high';
      case 'irreversible': return 'critical';
    }
  }

  private isWithinBoundaries(target: string): boolean {
    return this.policy.dataAccessBoundaries.some(boundary =>
      target.startsWith(boundary)
    );
  }
}
