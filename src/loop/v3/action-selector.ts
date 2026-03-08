/**
 * Action Selector — Multi-factor scoring for ready task selection.
 *
 * Replaces simple FIFO task ordering with a scoring function that weighs:
 * information gain, dependency leverage, cost, confidence, and risk.
 */

import type { TaskNode, Belief } from './types.js';
import { debugLog } from '../../debug-log.js';

// ── Types ───────────────────────────────────────────────────

export interface TaskScore {
  taskId: string;
  total: number;
  infoGain: number;
  dependencyLeverage: number;
  costPreference: number;
  confidenceBoost: number;
  riskPreference: number;
}

// ── Scoring weights ─────────────────────────────────────────

const WEIGHTS = {
  infoGain: 0.25,
  dependencyLeverage: 0.30,
  costPreference: 0.15,
  confidenceBoost: 0.15,
  riskPreference: 0.15,
} as const;

// ── Action Selector ─────────────────────────────────────────

export class ActionSelector {
  /**
   * Select the best task from a list of ready tasks.
   * Returns the highest-scoring task, or null if none available.
   */
  selectNext(
    readyTasks: TaskNode[],
    beliefs: Belief[],
    allTasks?: TaskNode[],
  ): TaskNode | null {
    if (readyTasks.length === 0) return null;
    if (readyTasks.length === 1) return readyTasks[0];

    const scores = readyTasks.map(task =>
      this.scoreTask(task, beliefs, allTasks || readyTasks),
    );

    scores.sort((a, b) => b.total - a.total);

    debugLog.debug('action-selector', 'Task ranking', {
      top: scores[0].taskId,
      topScore: scores[0].total.toFixed(3),
      candidates: scores.length,
    });

    const bestId = scores[0].taskId;
    return readyTasks.find(t => t.id === bestId) || readyTasks[0];
  }

  /**
   * Score a single task across all factors.
   */
  scoreTask(
    task: TaskNode,
    beliefs: Belief[],
    allTasks: TaskNode[],
  ): TaskScore {
    const infoGain = this.computeInfoGain(task);
    const dependencyLeverage = this.computeDependencyLeverage(task, allTasks);
    const costPreference = this.computeCostPreference(task);
    const confidenceBoost = this.computeConfidenceBoost(task, beliefs);
    const riskPreference = this.computeRiskPreference(task);

    const total =
      infoGain * WEIGHTS.infoGain +
      dependencyLeverage * WEIGHTS.dependencyLeverage +
      costPreference * WEIGHTS.costPreference +
      confidenceBoost * WEIGHTS.confidenceBoost +
      riskPreference * WEIGHTS.riskPreference;

    return {
      taskId: task.id,
      total,
      infoGain,
      dependencyLeverage,
      costPreference,
      confidenceBoost,
      riskPreference,
    };
  }

  /**
   * Information gain: tasks with more validators produce more verifiable knowledge.
   */
  private computeInfoGain(task: TaskNode): number {
    const validatorCount = task.validators.length;
    if (validatorCount === 0) return 0.3;
    if (validatorCount === 1) return 0.6;
    if (validatorCount === 2) return 0.8;
    return 1.0; // 3+ validators
  }

  /**
   * Dependency leverage: tasks that unblock more downstream tasks are more valuable.
   */
  private computeDependencyLeverage(task: TaskNode, allTasks: TaskNode[]): number {
    const directlyBlocked = allTasks.filter(t =>
      t.dependsOn.includes(task.id) &&
      (t.status === 'pending' || t.status === 'blocked'),
    ).length;

    if (directlyBlocked === 0) return 0.2;
    if (directlyBlocked === 1) return 0.5;
    if (directlyBlocked === 2) return 0.8;
    return 1.0; // 3+ tasks waiting
  }

  /**
   * Cost preference: prefer cheaper tasks (finish more work per dollar).
   */
  private computeCostPreference(task: TaskNode): number {
    const cost = task.estimatedCost ?? 0;
    if (cost <= 0) return 0.8;
    if (cost < 0.01) return 0.7;
    if (cost < 0.10) return 0.5;
    if (cost < 1.00) return 0.3;
    return 0.1;
  }

  /**
   * Confidence boost: prefer tasks in well-understood areas (high-confidence beliefs).
   */
  private computeConfidenceBoost(task: TaskNode, beliefs: Belief[]): number {
    if (beliefs.length === 0) return 0.5;

    const descWords = task.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const related = beliefs.filter(b => {
      const claim = b.claim.toLowerCase();
      return descWords.some(w => claim.includes(w)) && b.status === 'active';
    });

    if (related.length === 0) return 0.5;
    return related.reduce((sum, b) => sum + b.confidence, 0) / related.length;
  }

  /**
   * Risk preference: prefer lower-risk tasks.
   */
  private computeRiskPreference(task: TaskNode): number {
    switch (task.riskLevel) {
      case 'low': return 1.0;
      case 'medium': return 0.7;
      case 'high': return 0.4;
      case 'critical': return 0.1;
      default: return 0.7;
    }
  }
}
