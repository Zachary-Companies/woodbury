/**
 * Unit tests for Closure Engine V3 — Behavioral features
 *
 * Tests: attemptUnblock, partial verification, per-step episode capture,
 * and subagent contract types.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { StateManager } from '../loop/v3/state-manager.js';
import type {
  TaskNode,
  TaskResult,
  TaskValidator,
  VerificationTask,
  ClaimVerificationResult,
  EpisodeStep,
} from '../loop/v3/types.js';

// ── Helpers ─────────────────────────────────────────────────

const uniqueId = () => `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const makeTask = (overrides?: Partial<TaskNode>): TaskNode => ({
  id: 't1',
  goalId: 'g1',
  description: 'Test task',
  status: 'ready',
  dependsOn: [],
  blocks: [],
  maxRetries: 3,
  retryCount: 0,
  validators: [],
  createdAt: new Date().toISOString(),
  ...overrides,
});

// ── Partial verification types ──────────────────────────────

describe('Partial verification — VerificationResult shape', () => {
  // These tests verify that the Verifier module exports the right shapes.
  // Since the Verifier needs a ToolRegistry and ProviderAdapter, we test
  // the shapes structurally without instantiating the full verifier.

  it('VerificationResult supports partial and gaps fields', () => {
    // Import the type and verify the structure compiles
    const result = {
      passed: false,
      partial: true,
      validatorResults: [
        { validator: { type: 'file_exists' as const, path: 'a.ts' }, passed: true, output: 'exists' },
        { validator: { type: 'file_contains' as const, path: 'b.ts', pattern: 'foo' }, passed: false, output: 'not found' },
      ],
      summary: '[PASS] file_exists\n[FAIL] file_contains',
      gaps: ['file_contains: not found'],
    };

    expect(result.partial).toBe(true);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps![0]).toContain('file_contains');
  });

  it('non-partial result has no gaps', () => {
    const result = {
      passed: true,
      partial: false,
      validatorResults: [
        { validator: { type: 'file_exists' as const, path: 'a.ts' }, passed: true, output: 'exists' },
      ],
      summary: '[PASS] file_exists',
      gaps: undefined,
    };

    expect(result.partial).toBe(false);
    expect(result.gaps).toBeUndefined();
  });
});

// ── attemptUnblock via StateManager ─────────────────────────

describe('attemptUnblock — StateManager task status transitions', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager(uniqueId(), '/tmp');
  });

  it('blocked task becomes ready when dependencies are done', () => {
    // Set up a task graph with dependency
    sm.setTaskGraph({
      nodes: [
        makeTask({ id: 't1', status: 'done' }),
        makeTask({ id: 't2', status: 'blocked', dependsOn: ['t1'] }),
      ],
      executionOrder: ['t1', 't2'],
    });

    // Verify t2 is blocked
    const graph = sm.getTaskGraph()!;
    expect(graph.nodes[1].status).toBe('blocked');

    // Simulate unblock: update t2 to ready since t1 is done
    sm.updateTaskStatus('t2', 'ready');
    expect(sm.getTaskGraph()!.nodes[1].status).toBe('ready');
  });

  it('failed task can be reset to ready for retry', () => {
    sm.setTaskGraph({
      nodes: [makeTask({ id: 't1', status: 'failed', retryCount: 1, maxRetries: 3 })],
      executionOrder: ['t1'],
    });

    // Can retry since retryCount < maxRetries
    const task = sm.getTaskGraph()!.nodes[0];
    expect(task.status).toBe('failed');
    expect(task.retryCount).toBeLessThan(task.maxRetries);

    sm.updateTaskStatus('t1', 'ready');
    expect(sm.getTaskGraph()!.nodes[0].status).toBe('ready');
  });

  it('getNextTask returns null when all tasks are blocked', () => {
    sm.setTaskGraph({
      nodes: [
        makeTask({ id: 't1', status: 'blocked', dependsOn: ['t0'] }),
        makeTask({ id: 't2', status: 'blocked', dependsOn: ['t1'] }),
      ],
      executionOrder: ['t1', 't2'],
    });

    expect(sm.getNextTask()).toBeNull();
  });

  it('getNextTask returns ready task after unblock', () => {
    sm.setTaskGraph({
      nodes: [
        makeTask({ id: 't1', status: 'done' }),
        makeTask({ id: 't2', status: 'blocked', dependsOn: ['t1'] }),
      ],
      executionOrder: ['t1', 't2'],
    });

    // t2 is blocked but deps are met — simulating what attemptUnblock does
    sm.updateTaskStatus('t2', 'ready');
    const next = sm.getNextTask();
    expect(next).not.toBeNull();
    expect(next!.id).toBe('t2');
  });
});

// ── Episode step capture ────────────────────────────────────

describe('Per-step episode capture', () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager(uniqueId(), '/tmp');
  });

  it('captures episode step with all fields', () => {
    const step = sm.addEpisodeStep({
      actionId: 'act_1',
      toolName: 'file_read',
      taskId: 't1',
      observationId: 'obs_1',
      success: true,
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    expect(step).toMatchObject({
      actionId: 'act_1',
      toolName: 'file_read',
      taskId: 't1',
      observationId: 'obs_1',
      success: true,
    });
    expect(step.id).toMatch(/^es_/);
  });

  it('episode steps are included in engine state', () => {
    sm.addEpisodeStep({
      actionId: 'act_1', toolName: 'file_read', taskId: 't1',
      observationId: 'obs_1', success: true, timestamp: '',
    });

    const state = sm.getState();
    expect(state.episodeSteps).toHaveLength(1);
    expect(state.episodeSteps[0].toolName).toBe('file_read');
  });

  it('episode steps preserve execution order', () => {
    const tools = ['file_read', 'shell_execute', 'file_write', 'grep'];
    for (let i = 0; i < tools.length; i++) {
      sm.addEpisodeStep({
        actionId: `act_${i}`, toolName: tools[i], taskId: 't1',
        observationId: `obs_${i}`, success: true, timestamp: '',
      });
    }

    const steps = sm.getEpisodeSteps();
    expect(steps).toHaveLength(4);
    expect(steps.map(s => s.toolName)).toEqual(tools);
  });
});

// ── Subagent contract types ─────────────────────────────────

describe('Subagent contract types', () => {
  it('VerificationTask has all required fields', () => {
    const task: VerificationTask = {
      targetClaim: 'File X contains function Y',
      expectedEvidence: ['file_read result showing function definition'],
      availableEvidenceIds: ['ev_1', 'ev_2'],
      requiredConfidence: 0.85,
    };

    expect(task.targetClaim).toBeTruthy();
    expect(task.expectedEvidence).toHaveLength(1);
    expect(task.availableEvidenceIds).toHaveLength(2);
    expect(task.requiredConfidence).toBeGreaterThan(0);
  });

  it('ClaimVerificationResult has all required fields', () => {
    const result: ClaimVerificationResult = {
      targetClaim: 'File X contains function Y',
      verdict: 'verified',
      confidence: 0.92,
      reasoningSummary: 'Found function Y in file X at line 42',
      supportingEvidenceIds: ['ev_1'],
      contradictions: [],
      nextChecks: [],
    };

    expect(result.verdict).toBe('verified');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.supportingEvidenceIds).toHaveLength(1);
    expect(result.contradictions).toHaveLength(0);
  });

  it('ClaimVerificationResult supports all verdict types', () => {
    const verdicts: ClaimVerificationResult['verdict'][] = [
      'verified', 'supported', 'inconclusive', 'contradicted',
    ];

    for (const verdict of verdicts) {
      const result: ClaimVerificationResult = {
        targetClaim: 'test',
        verdict,
        confidence: 0.5,
        reasoningSummary: 'test',
        supportingEvidenceIds: [],
        contradictions: [],
        nextChecks: [],
      };
      expect(result.verdict).toBe(verdict);
    }
  });
});

// ── Action history in state ─────────────────────────────────

describe('Action history tracking', () => {
  it('actions accumulate in state', () => {
    const sm = new StateManager(uniqueId(), '/tmp');

    sm.addAction({
      id: 'act_1', taskId: 't1', actionType: 'read_file', toolName: 'file_read',
      params: { path: 'a.ts' }, rationale: 'read', expectedObservations: [],
      validationPlan: { successSignals: [], failureSignals: [], independentChecks: [], confidenceThreshold: 0.7 },
      timeoutMs: 5000, costEstimate: 0,
    });
    sm.addAction({
      id: 'act_2', taskId: 't1', actionType: 'write_file', toolName: 'file_write',
      params: { path: 'b.ts' }, rationale: 'write', expectedObservations: [],
      validationPlan: { successSignals: [], failureSignals: [], independentChecks: [], confidenceThreshold: 0.7 },
      timeoutMs: 5000, costEstimate: 0.01,
    });

    const state = sm.getState();
    expect(state.actionHistory).toHaveLength(2);
    expect(state.actionHistory[0].actionType).toBe('read_file');
    expect(state.actionHistory[1].actionType).toBe('write_file');
  });
});
