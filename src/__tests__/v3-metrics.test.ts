/**
 * Unit tests for Closure Engine V3 — MetricsCollector
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsCollector } from '../loop/v3/metrics.js';
import type { ClosureEngineResult, ClosureEngineState } from '../loop/v3/types.js';

// ── Helpers ─────────────────────────────────────────────────

const makeState = (overrides?: Partial<ClosureEngineState>): ClosureEngineState => ({
  sessionId: 'test_session',
  goal: {
    id: 'g1', objective: 'Test', successCriteria: [],
    constraints: [], forbiddenActions: [],
    priority: 'normal', status: 'achieved',
    createdAt: '', updatedAt: '',
  },
  taskGraph: {
    nodes: [
      {
        id: 't1', goalId: 'g1', description: 'Task 1',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0,
        validators: [{ type: 'file_exists', path: 'test.ts' }],
        createdAt: '',
        result: { success: true, output: 'done', observations: [], toolCallCount: 2, durationMs: 100 },
      },
      {
        id: 't2', goalId: 'g1', description: 'Task 2',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0, validators: [],
        createdAt: '',
        result: { success: true, output: 'done', observations: [], toolCallCount: 1, durationMs: 50 },
      },
    ],
    executionOrder: ['t1', 't2'],
  },
  beliefs: [
    { id: 'b1', claim: 'File exists', confidence: 0.9, source: { type: 'inference', derivedFrom: [] }, status: 'active', createdAt: '' },
  ],
  observations: [],
  memories: [],
  reflections: [],
  recoveryAttempts: [],
  evidence: [
    { id: 'e1', type: 'tool_result', source: 'file_read', contentSummary: 'ok', reliability: 0.9, timestamp: '' },
  ],
  beliefEdges: [],
  actionHistory: [],
  episodeSteps: [],
  iteration: 5,
  phase: 'completed',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const makeResult = (overrides?: Partial<ClosureEngineResult>): ClosureEngineResult => ({
  success: true,
  content: 'Done',
  beliefs: [],
  observations: [],
  memories: [],
  reflections: [],
  recoveryAttempts: [],
  evidence: [],
  iterations: 5,
  totalToolCalls: 3,
  durationMs: 1500,
  ...overrides,
});

// ── Tests ───────────────────────────────────────────────────

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-mc-'));
    // Use a temp file path so we don't load stale data from disk
    collector = new MetricsCollector(join(tmpDir, 'sessions.json'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('collectFromResult', () => {
    it('produces session metrics with all fields', () => {
      const metrics = collector.collectFromResult(makeResult(), makeState());
      expect(metrics.sessionId).toBe('test_session');
      expect(metrics.timestamp).toBeTruthy();
      expect(typeof metrics.goalCompletionRate).toBe('number');
      expect(typeof metrics.verifiedCompletionRate).toBe('number');
      expect(typeof metrics.falseSuccessRate).toBe('number');
      expect(typeof metrics.recoveryCount).toBe('number');
      expect(typeof metrics.stepsPerGoal).toBe('number');
      expect(typeof metrics.toolCallCount).toBe('number');
      expect(typeof metrics.beliefCount).toBe('number');
      expect(typeof metrics.evidenceCount).toBe('number');
    });

    it('calculates goal completion rate correctly', () => {
      const metrics = collector.collectFromResult(makeResult(), makeState());
      // 2 done out of 2 tasks
      expect(metrics.goalCompletionRate).toBe(1.0);
    });

    it('calculates verified completion rate', () => {
      const metrics = collector.collectFromResult(makeResult(), makeState());
      // 1 task has validators (t1), 1 doesn't (t2), both done → 1/2 = 0.5
      expect(metrics.verifiedCompletionRate).toBe(0.5);
    });

    it('calculates partial completion correctly', () => {
      const state = makeState();
      state.taskGraph!.nodes[1].status = 'failed';
      state.taskGraph!.nodes[1].result = {
        success: false, output: '', observations: [],
        toolCallCount: 1, durationMs: 50, error: 'Failed',
      };
      const metrics = collector.collectFromResult(makeResult(), state);
      expect(metrics.goalCompletionRate).toBe(0.5);
    });

    it('tracks recovery count', () => {
      const state = makeState({
        recoveryAttempts: [
          { taskId: 't1', strategy: { type: 'retry', maxAttempts: 3 }, attempt: 1, success: false, timestamp: '' },
          { taskId: 't1', strategy: { type: 'retry', maxAttempts: 3 }, attempt: 2, success: true, timestamp: '' },
        ],
      });
      const metrics = collector.collectFromResult(makeResult(), state);
      expect(metrics.recoveryCount).toBe(2);
    });

    it('counts beliefs and evidence', () => {
      const metrics = collector.collectFromResult(makeResult(), makeState());
      expect(metrics.beliefCount).toBe(1);
      expect(metrics.evidenceCount).toBe(1);
    });

    it('tracks tool call count from result', () => {
      const metrics = collector.collectFromResult(makeResult({ totalToolCalls: 10 }), makeState());
      expect(metrics.toolCallCount).toBe(10);
    });

    it('detects contradiction edges', () => {
      const state = makeState({
        beliefEdges: [
          { id: 'e1', fromBeliefId: 'b1', toBeliefId: 'b2', type: 'contradicts', weight: 0.9, createdAt: '' },
        ],
      });
      const metrics = collector.collectFromResult(makeResult(), state);
      expect(metrics.contradictionDetectionRate).toBeGreaterThan(0);
    });
  });

  describe('computeAggregates', () => {
    it('returns zeros for empty sessions', () => {
      const agg = collector.computeAggregates();
      expect(agg.totalSessions).toBe(0);
      expect(agg.avgGoalCompletionRate).toBe(0);
      expect(agg.learningUplift).toBe(0);
    });

    it('computes averages across sessions', () => {
      collector.collectFromResult(makeResult({ totalToolCalls: 4 }), makeState());
      collector.collectFromResult(makeResult({ totalToolCalls: 6 }), makeState());

      const agg = collector.computeAggregates();
      expect(agg.totalSessions).toBe(2);
      expect(agg.avgToolCallCount).toBe(5); // (4+6)/2
      expect(agg.avgGoalCompletionRate).toBe(1.0); // both fully complete
    });

    it('computes learning uplift with enough sessions', () => {
      // First 2 sessions: 50% completion
      const halfState = makeState();
      halfState.taskGraph!.nodes[1].status = 'failed';

      collector.collectFromResult(makeResult(), halfState);
      collector.collectFromResult(makeResult(), halfState);

      // Last 2 sessions: 100% completion
      collector.collectFromResult(makeResult(), makeState());
      collector.collectFromResult(makeResult(), makeState());

      const agg = collector.computeAggregates();
      expect(agg.totalSessions).toBe(4);
      // First half avg: 0.5, second half avg: 1.0, uplift: 0.5
      expect(agg.learningUplift).toBeCloseTo(0.5);
    });

    it('returns all aggregate fields', () => {
      collector.collectFromResult(makeResult(), makeState());
      const agg = collector.computeAggregates();

      expect(agg).toHaveProperty('totalSessions');
      expect(agg).toHaveProperty('avgGoalCompletionRate');
      expect(agg).toHaveProperty('avgVerifiedCompletionRate');
      expect(agg).toHaveProperty('avgFalseSuccessRate');
      expect(agg).toHaveProperty('avgRecoveryCount');
      expect(agg).toHaveProperty('avgStepsPerGoal');
      expect(agg).toHaveProperty('avgCostPerGoal');
      expect(agg).toHaveProperty('avgTimeToVerifiedCompletionMs');
      expect(agg).toHaveProperty('avgHumanEscalationRate');
      expect(agg).toHaveProperty('avgContradictionDetectionRate');
      expect(agg).toHaveProperty('avgValidatorCatchRate');
      expect(agg).toHaveProperty('avgSkillReuseRate');
      expect(agg).toHaveProperty('avgToolCallCount');
      expect(agg).toHaveProperty('avgBeliefCount');
      expect(agg).toHaveProperty('avgEvidenceCount');
      expect(agg).toHaveProperty('learningUplift');
    });
  });

  describe('getSessions', () => {
    it('returns all recorded sessions', () => {
      collector.collectFromResult(makeResult(), makeState());
      collector.collectFromResult(makeResult(), makeState());
      expect(collector.getSessions()).toHaveLength(2);
    });

    it('returns a copy (not mutable reference)', () => {
      collector.collectFromResult(makeResult(), makeState());
      const sessions = collector.getSessions();
      sessions.pop();
      expect(collector.getSessions()).toHaveLength(1);
    });
  });
});
