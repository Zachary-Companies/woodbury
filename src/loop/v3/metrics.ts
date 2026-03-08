/**
 * Metrics Collector — Session and aggregate metrics for the Closure Engine.
 *
 * Collects per-session metrics (goal completion, recovery, cost, etc.) and
 * computes aggregates across sessions. Persists to disk for trend analysis.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClosureEngineResult, ClosureEngineState } from './types.js';

// ── Types ───────────────────────────────────────────────────

export interface SessionMetrics {
  sessionId: string;
  timestamp: string;
  goalCompletionRate: number;
  verifiedCompletionRate: number;
  falseSuccessRate: number;
  recoveryCount: number;
  stepsPerGoal: number;
  costPerGoal: number;
  timeToVerifiedCompletionMs: number;
  humanEscalationRate: number;
  contradictionDetectionRate: number;
  validatorCatchRate: number;
  skillReuseRate: number;
  toolCallCount: number;
  beliefCount: number;
  evidenceCount: number;
}

export interface AggregateMetrics {
  totalSessions: number;
  avgGoalCompletionRate: number;
  avgVerifiedCompletionRate: number;
  avgFalseSuccessRate: number;
  avgRecoveryCount: number;
  avgStepsPerGoal: number;
  avgCostPerGoal: number;
  avgTimeToVerifiedCompletionMs: number;
  avgHumanEscalationRate: number;
  avgContradictionDetectionRate: number;
  avgValidatorCatchRate: number;
  avgSkillReuseRate: number;
  avgToolCallCount: number;
  avgBeliefCount: number;
  avgEvidenceCount: number;
  learningUplift: number;
}

// ── Collector ───────────────────────────────────────────────

const DEFAULT_METRICS_DIR = join(homedir(), '.woodbury', 'data', 'closure-engine', 'metrics');
const DEFAULT_SESSIONS_FILE = join(DEFAULT_METRICS_DIR, 'sessions.json');

export class MetricsCollector {
  private sessions: SessionMetrics[] = [];
  private sessionsFile: string;

  constructor(sessionsFile?: string) {
    this.sessionsFile = sessionsFile || DEFAULT_SESSIONS_FILE;
    this.loadFromDisk();
  }

  /**
   * Collect metrics from a completed engine run.
   */
  collectFromResult(result: ClosureEngineResult, state: ClosureEngineState): SessionMetrics {
    const taskNodes = state.taskGraph?.nodes || [];
    const totalTasks = taskNodes.length;
    const doneTasks = taskNodes.filter(n => n.status === 'done').length;
    const failedTasks = taskNodes.filter(n => n.status === 'failed').length;
    const validatedTasks = taskNodes.filter(n => n.status === 'done' && n.validators.length > 0).length;

    // Tasks that passed validation but later failed (false success indicator)
    const tasksWithResults = taskNodes.filter(n => n.result);
    const falseSuccesses = tasksWithResults.filter(n =>
      n.status === 'failed' && n.result?.success === true
    ).length;

    // Recovery attempts
    const recoveryCount = state.recoveryAttempts.length;

    // Beliefs
    const beliefs = state.beliefs || [];
    const activeBeliefs = beliefs.filter(b => b.status === 'active');
    const invalidatedBeliefs = beliefs.filter(b => b.status === 'invalidated');

    // Evidence
    const evidence = state.evidence || [];

    // Contradictions detected
    const beliefEdges = state.beliefEdges || [];
    const contradictionEdges = beliefEdges.filter(e => e.type === 'contradicts');

    // Skill reuse (memories accessed during session)
    const proceduralMemories = state.memories.filter(m => m.type === 'procedural');
    const reusedMemories = proceduralMemories.filter(m => m.accessCount > 1);

    // Human escalation (ask_user recoveries)
    const askUserRecoveries = state.recoveryAttempts.filter(
      a => a.strategy.type === 'ask_user'
    );

    // Validator catch rate (validators that caught actual failures)
    const totalValidators = taskNodes.reduce((sum, n) => sum + n.validators.length, 0);
    const caughtByValidators = taskNodes.filter(n =>
      n.status === 'failed' && n.result?.error?.includes('Verification failed')
    ).length;

    const metrics: SessionMetrics = {
      sessionId: state.sessionId,
      timestamp: new Date().toISOString(),
      goalCompletionRate: totalTasks > 0 ? doneTasks / totalTasks : 0,
      verifiedCompletionRate: totalTasks > 0 ? validatedTasks / totalTasks : 0,
      falseSuccessRate: tasksWithResults.length > 0 ? falseSuccesses / tasksWithResults.length : 0,
      recoveryCount,
      stepsPerGoal: result.iterations,
      costPerGoal: 0, // TODO: integrate with actual cost tracking
      timeToVerifiedCompletionMs: result.durationMs,
      humanEscalationRate: recoveryCount > 0 ? askUserRecoveries.length / recoveryCount : 0,
      contradictionDetectionRate: beliefs.length > 0
        ? contradictionEdges.length / beliefs.length
        : 0,
      validatorCatchRate: totalValidators > 0
        ? caughtByValidators / totalValidators
        : 0,
      skillReuseRate: proceduralMemories.length > 0
        ? reusedMemories.length / proceduralMemories.length
        : 0,
      toolCallCount: result.totalToolCalls,
      beliefCount: activeBeliefs.length,
      evidenceCount: evidence.length,
    };

    this.sessions.push(metrics);
    this.saveToDisk();

    return metrics;
  }

  /**
   * Compute aggregate metrics across all recorded sessions.
   */
  computeAggregates(): AggregateMetrics {
    const n = this.sessions.length;
    if (n === 0) {
      return this.emptyAggregates();
    }

    const sum = (fn: (m: SessionMetrics) => number) =>
      this.sessions.reduce((acc, s) => acc + fn(s), 0);

    const avg = (fn: (m: SessionMetrics) => number) => sum(fn) / n;

    // Learning uplift: compare first half vs second half completion rates
    let learningUplift = 0;
    if (n >= 4) {
      const mid = Math.floor(n / 2);
      const firstHalf = this.sessions.slice(0, mid);
      const secondHalf = this.sessions.slice(mid);
      const avgFirst = firstHalf.reduce((a, s) => a + s.goalCompletionRate, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, s) => a + s.goalCompletionRate, 0) / secondHalf.length;
      learningUplift = avgSecond - avgFirst;
    }

    return {
      totalSessions: n,
      avgGoalCompletionRate: avg(m => m.goalCompletionRate),
      avgVerifiedCompletionRate: avg(m => m.verifiedCompletionRate),
      avgFalseSuccessRate: avg(m => m.falseSuccessRate),
      avgRecoveryCount: avg(m => m.recoveryCount),
      avgStepsPerGoal: avg(m => m.stepsPerGoal),
      avgCostPerGoal: avg(m => m.costPerGoal),
      avgTimeToVerifiedCompletionMs: avg(m => m.timeToVerifiedCompletionMs),
      avgHumanEscalationRate: avg(m => m.humanEscalationRate),
      avgContradictionDetectionRate: avg(m => m.contradictionDetectionRate),
      avgValidatorCatchRate: avg(m => m.validatorCatchRate),
      avgSkillReuseRate: avg(m => m.skillReuseRate),
      avgToolCallCount: avg(m => m.toolCallCount),
      avgBeliefCount: avg(m => m.beliefCount),
      avgEvidenceCount: avg(m => m.evidenceCount),
      learningUplift,
    };
  }

  /**
   * Get all recorded session metrics.
   */
  getSessions(): SessionMetrics[] {
    return [...this.sessions];
  }

  // ── Persistence ──────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (existsSync(this.sessionsFile)) {
        const raw = readFileSync(this.sessionsFile, 'utf-8');
        this.sessions = JSON.parse(raw);
      }
    } catch {
      this.sessions = [];
    }
  }

  private saveToDisk(): void {
    try {
      const dir = join(this.sessionsFile, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
    } catch {
      // Best effort — don't crash the engine
    }
  }

  private emptyAggregates(): AggregateMetrics {
    return {
      totalSessions: 0,
      avgGoalCompletionRate: 0, avgVerifiedCompletionRate: 0,
      avgFalseSuccessRate: 0, avgRecoveryCount: 0,
      avgStepsPerGoal: 0, avgCostPerGoal: 0,
      avgTimeToVerifiedCompletionMs: 0, avgHumanEscalationRate: 0,
      avgContradictionDetectionRate: 0, avgValidatorCatchRate: 0,
      avgSkillReuseRate: 0, avgToolCallCount: 0,
      avgBeliefCount: 0, avgEvidenceCount: 0,
      learningUplift: 0,
    };
  }
}
