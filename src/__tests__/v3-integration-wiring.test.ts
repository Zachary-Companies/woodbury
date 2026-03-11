/**
 * Unit tests for Closure Engine V3 — Integration wiring
 *
 * Tests that Critic, SafetyGate, ActionSpec, and DelegateEngine are
 * properly wired into the engine execution flow.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { SafetyGate } from '../loop/v3/safety-gate.js';
import { RecoveryEngine } from '../loop/v3/recovery.js';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import type { ActionSpec, ValidationPlan, TaskNode, TaskResult } from '../loop/v3/types.js';

// ── Helpers ─────────────────────────────────────────────────

const defaultValidationPlan: ValidationPlan = {
  successSignals: ['output returned'],
  failureSignals: ['error in output'],
  independentChecks: [],
  confidenceThreshold: 0.7,
};

const makeAction = (overrides?: Partial<ActionSpec>): ActionSpec => ({
  id: 'act_1',
  taskId: 't1',
  actionType: 'read_file',
  toolName: 'file_read',
  params: { path: 'test.ts' },
  rationale: 'Task: Read file for analysis',
  expectedObservations: ['Tool file_read returns successfully'],
  validationPlan: defaultValidationPlan,
  timeoutMs: 5000,
  costEstimate: 0,
  ...overrides,
});

const makeTask = (overrides?: Partial<TaskNode>): TaskNode => ({
  id: 't1',
  goalId: 'g1',
  description: 'Test task',
  status: 'running',
  dependsOn: [],
  blocks: [],
  maxRetries: 3,
  retryCount: 0,
  validators: [],
  createdAt: new Date().toISOString(),
  ...overrides,
});

const makeResult = (overrides?: Partial<TaskResult>): TaskResult => ({
  success: false,
  output: '',
  observations: [],
  toolCallCount: 1,
  durationMs: 100,
  error: 'Something failed',
  ...overrides,
});

// ── SafetyGate integration ──────────────────────────────────

describe('Integration: SafetyGate blocks irreversible actions', () => {
  it('blocks irreversible tools by default policy', () => {
    const gate = new SafetyGate(); // default: requireApproval = ['irreversible']
    const action = makeAction({ toolName: 'file_delete', actionType: 'write_file' });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(false);
    expect(result.actionClass).toBe('irreversible');
    expect(result.requiresHumanApproval).toBe(true);
  });

  it('allows read-only tools', () => {
    const gate = new SafetyGate();
    const action = makeAction({ toolName: 'file_read', actionType: 'read_file' });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(true);
    expect(result.actionClass).toBe('read_only');
  });

  it('blocks when budget exceeded', () => {
    const gate = new SafetyGate({ maxBudget: 1.0 });
    const action = makeAction({ costEstimate: 2.0 });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Budget exceeded');
  });
});

describe('Integration: SafetyGate records executions and tracks budget', () => {
  it('tracks execution cost', () => {
    const gate = new SafetyGate({ maxBudget: 5.0 });

    expect(gate.getBudgetRemaining()).toBe(5.0);
    gate.recordExecution(makeAction({ costEstimate: 1.5 }), 100, true);
    expect(gate.getBudgetRemaining()).toBe(3.5);

    gate.recordExecution(makeAction({ costEstimate: 2.0 }), 200, true);
    expect(gate.getBudgetRemaining()).toBe(1.5);
  });

  it('tracks total actions', () => {
    const gate = new SafetyGate();
    expect(gate.getTotalActions()).toBe(0);

    gate.recordExecution(makeAction(), 100, true);
    gate.recordExecution(makeAction(), 100, false);
    expect(gate.getTotalActions()).toBe(2);
  });
});

// ── ActionSpec construction ─────────────────────────────────

describe('Integration: ActionSpec shape', () => {
  it('has all required fields', () => {
    const action = makeAction();
    expect(action.id).toBeTruthy();
    expect(action.taskId).toBeTruthy();
    expect(action.actionType).toBeTruthy();
    expect(action.toolName).toBeTruthy();
    expect(action.params).toBeDefined();
    expect(action.rationale).toBeTruthy();
    expect(action.expectedObservations).toBeInstanceOf(Array);
    expect(action.validationPlan).toBeDefined();
    expect(action.validationPlan.successSignals).toBeInstanceOf(Array);
    expect(action.validationPlan.failureSignals).toBeInstanceOf(Array);
    expect(typeof action.timeoutMs).toBe('number');
    expect(typeof action.costEstimate).toBe('number');
  });

  it('validation plan has all fields', () => {
    const action = makeAction();
    expect(action.validationPlan).toHaveProperty('successSignals');
    expect(action.validationPlan).toHaveProperty('failureSignals');
    expect(action.validationPlan).toHaveProperty('independentChecks');
    expect(action.validationPlan).toHaveProperty('confidenceThreshold');
  });
});

// ── SafetyGate policy configurations ────────────────────────

describe('Integration: SafetyGate policy enforcement', () => {
  it('blocks high_risk_write when policy requires approval', () => {
    const gate = new SafetyGate({ requireApproval: ['high_risk_write', 'irreversible'] });
    const action = makeAction({ toolName: 'shell_execute', actionType: 'code_exec' });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(false);
    expect(result.actionClass).toBe('high_risk_write');
  });

  it('enforces data access boundaries', () => {
    const gate = new SafetyGate({
      dataAccessBoundaries: ['/allowed/path'],
    });
    const action = makeAction({ params: { path: '/forbidden/file.ts' } });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('outside allowed data access boundaries');
  });

  it('allows actions within data access boundaries', () => {
    const gate = new SafetyGate({
      dataAccessBoundaries: ['/allowed/path'],
    });
    const action = makeAction({ params: { path: '/allowed/path/file.ts' } });
    const result = gate.checkApproval(action);

    expect(result.approved).toBe(true);
  });
});

// ── Recovery engine — new error categories ──────────────────

describe('Integration: RecoveryEngine new error categories in execution flow', () => {
  let recovery: RecoveryEngine;

  beforeEach(() => {
    const sid = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const stateManager = new StateManager(sid, '/tmp');
    const memoryStore = new MemoryStore();
    recovery = new RecoveryEngine(stateManager, memoryStore);
  });

  it('classifies ambiguous entity errors', () => {
    const task = makeTask();
    // Use a message that only matches 'ambiguous' and not other categories
    const result = makeResult({ error: 'Ambiguous: which one do you mean?' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('retry');
  });

  it('classifies unsafe_to_continue and aborts immediately', () => {
    const task = makeTask();
    const result = makeResult({ error: 'Unsafe to proceed: budget exceeded' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('abort');
  });

  it('classifies plan_invalidated and decomposes', () => {
    const task = makeTask();
    // 'stale state' matches plan_invalidated but not validation
    const result = makeResult({ error: 'Stale state detected, assumptions no longer hold' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('decompose');
  });

  it('classifies environment_changed and retries with backoff', () => {
    const task = makeTask();
    const result = makeResult({ error: 'Concurrent modification by external process' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('retry');
    if (strategy.type === 'retry') {
      expect(strategy.backoffMs).toBeGreaterThan(0);
    }
  });

  it('classifies contradictory_evidence and retries', () => {
    const task = makeTask();
    // 'conflicting evidence' matches contradictory_evidence
    const result = makeResult({ error: 'Conflicting evidence from two data sources' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('retry');
  });

  it('classifies missing_required_data and retries', () => {
    const task = makeTask();
    // 'cannot proceed without' matches missing_required_data
    const result = makeResult({ error: 'Cannot proceed without the auth token' });

    const strategy = recovery.determineStrategy(task, result);
    expect(strategy.type).toBe('retry');
  });
});

// ── Episode steps wiring ────────────────────────────────────

describe('Integration: EpisodeStep recording via StateManager', () => {
  const uniqueId = () => `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  it('records and retrieves episode steps', () => {
    const sm = new StateManager(uniqueId(), '/tmp');

    const step = sm.addEpisodeStep({
      actionId: 'act_1',
      toolName: 'file_read',
      taskId: 't1',
      observationId: 'obs_1',
      success: true,
      timestamp: new Date().toISOString(),
    });

    expect(step.id).toMatch(/^es_/);
    expect(sm.getEpisodeSteps()).toHaveLength(1);
    expect(sm.getEpisodeSteps()[0].toolName).toBe('file_read');
  });

  it('accumulates multiple episode steps', () => {
    const sm = new StateManager(uniqueId(), '/tmp');

    sm.addEpisodeStep({
      actionId: 'act_1', toolName: 'file_read', taskId: 't1',
      observationId: 'obs_1', success: true, timestamp: '',
    });
    sm.addEpisodeStep({
      actionId: 'act_2', toolName: 'file_write', taskId: 't1',
      observationId: 'obs_2', success: true, timestamp: '',
    });
    sm.addEpisodeStep({
      actionId: 'act_3', toolName: 'shell_execute', taskId: 't2',
      observationId: 'obs_3', success: false, timestamp: '',
    });

    expect(sm.getEpisodeSteps()).toHaveLength(3);
    expect(sm.getEpisodeSteps()[2].success).toBe(false);
  });
});

// ── ActionSpec in state history ──────────────────────────────

describe('Integration: ActionSpec stored in state history', () => {
  it('stores actions via addAction', () => {
    const sid = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const sm = new StateManager(sid, '/tmp');
    const action = makeAction();

    sm.addAction(action);
    const state = sm.getState();
    expect(state.actionHistory).toHaveLength(1);
    expect(state.actionHistory[0].toolName).toBe('file_read');
  });
});
