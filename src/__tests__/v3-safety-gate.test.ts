/**
 * Unit tests for Closure Engine V3 — SafetyGate
 */
import { describe, it, expect } from '@jest/globals';
import { SafetyGate } from '../loop/v3/safety-gate.js';
import type { ActionSpec, ValidationPlan } from '../loop/v3/types.js';

const defaultValidationPlan: ValidationPlan = {
  successSignals: [],
  failureSignals: [],
  independentChecks: [],
  confidenceThreshold: 0.8,
};

const makeAction = (overrides?: Partial<ActionSpec>): ActionSpec => ({
  id: 'act_1',
  taskId: 't1',
  actionType: 'read_file',
  toolName: 'file_read',
  params: { path: 'test.ts' },
  rationale: 'Need to read the file',
  expectedObservations: ['File contents'],
  validationPlan: defaultValidationPlan,
  timeoutMs: 5000,
  costEstimate: 0,
  ...overrides,
});

// ── Action Classification ────────────────────────────────────

describe('SafetyGate - classifyAction', () => {
  const gate = new SafetyGate();

  it('classifies file_read as read_only', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'file_read' }))).toBe('read_only');
  });

  it('classifies grep as read_only', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'grep' }))).toBe('read_only');
  });

  it('classifies list_directory as read_only', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'list_directory' }))).toBe('read_only');
  });

  it('classifies file_write as low_risk_write', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'file_write' }))).toBe('low_risk_write');
  });

  it('classifies shell_execute as high_risk_write', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'shell_execute' }))).toBe('high_risk_write');
  });

  it('classifies file_delete as irreversible', () => {
    expect(gate.classifyAction(makeAction({ toolName: 'file_delete' }))).toBe('irreversible');
  });

  it('classifies unknown tools by actionType', () => {
    const action = makeAction({ toolName: 'custom_tool', actionType: 'search' });
    expect(gate.classifyAction(action)).toBe('read_only');
  });
});

// ── Approval Checks ──────────────────────────────────────────

describe('SafetyGate - checkApproval', () => {
  it('approves read_only actions by default', () => {
    const gate = new SafetyGate();
    const result = gate.checkApproval(makeAction({ toolName: 'file_read' }));
    expect(result.approved).toBe(true);
    expect(result.actionClass).toBe('read_only');
    expect(result.riskLevel).toBe('low');
  });

  it('approves low_risk_write by default', () => {
    const gate = new SafetyGate();
    const result = gate.checkApproval(makeAction({ toolName: 'file_write' }));
    expect(result.approved).toBe(true);
  });

  it('blocks irreversible actions by default', () => {
    const gate = new SafetyGate();
    const result = gate.checkApproval(makeAction({ toolName: 'file_delete' }));
    expect(result.approved).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.reason).toContain('requires human approval');
  });

  it('blocks when budget is exceeded', () => {
    const gate = new SafetyGate({ maxBudget: 1.0 });
    const action = makeAction({ costEstimate: 2.0 });
    const result = gate.checkApproval(action);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Budget exceeded');
  });

  it('blocks when rate limit is exceeded', () => {
    const gate = new SafetyGate({ maxActionsPerMinute: 2 });
    // Record 2 actions
    gate.recordExecution(makeAction(), 10, true);
    gate.recordExecution(makeAction(), 10, true);
    // Third should be blocked
    const result = gate.checkApproval(makeAction());
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Rate limit');
  });

  it('blocks when target is outside data access boundaries', () => {
    const gate = new SafetyGate({
      dataAccessBoundaries: ['/safe/path/'],
    });
    const action = makeAction({ params: { path: '/forbidden/file.ts' } });
    const result = gate.checkApproval(action);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('outside allowed');
  });

  it('approves actions within data access boundaries', () => {
    const gate = new SafetyGate({
      dataAccessBoundaries: ['/safe/path/'],
      requireApproval: [],
    });
    const action = makeAction({ params: { path: '/safe/path/file.ts' } });
    const result = gate.checkApproval(action);
    expect(result.approved).toBe(true);
  });

  it('supports custom requireApproval policies', () => {
    const gate = new SafetyGate({
      requireApproval: ['high_risk_write', 'irreversible'],
    });
    const result = gate.checkApproval(makeAction({ toolName: 'shell_execute' }));
    expect(result.approved).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
  });
});

// ── Execution Recording ──────────────────────────────────────

describe('SafetyGate - recording', () => {
  it('tracks total cost', () => {
    const gate = new SafetyGate({ maxBudget: 10.0 });
    gate.recordExecution(makeAction({ costEstimate: 1.5 }), 100, true);
    gate.recordExecution(makeAction({ costEstimate: 2.0 }), 200, true);
    expect(gate.getBudgetRemaining()).toBeCloseTo(6.5);
  });

  it('tracks total actions', () => {
    const gate = new SafetyGate();
    gate.recordExecution(makeAction(), 10, true);
    gate.recordExecution(makeAction(), 20, false);
    gate.recordExecution(makeAction(), 30, true);
    expect(gate.getTotalActions()).toBe(3);
  });

  it('budget remaining never goes negative', () => {
    const gate = new SafetyGate({ maxBudget: 1.0 });
    gate.recordExecution(makeAction({ costEstimate: 5.0 }), 100, true);
    expect(gate.getBudgetRemaining()).toBe(0);
  });
});

// ── Risk Level Mapping ───────────────────────────────────────

describe('SafetyGate - risk levels', () => {
  const gate = new SafetyGate();

  it('read_only → low', () => {
    const result = gate.checkApproval(makeAction({ toolName: 'file_read' }));
    expect(result.riskLevel).toBe('low');
  });

  it('low_risk_write → medium', () => {
    const result = gate.checkApproval(makeAction({ toolName: 'file_write' }));
    expect(result.riskLevel).toBe('medium');
  });

  it('high_risk_write → high', () => {
    const result = gate.checkApproval(makeAction({
      toolName: 'shell_execute',
    }));
    expect(result.riskLevel).toBe('high');
  });

  it('irreversible → critical', () => {
    const result = gate.checkApproval(makeAction({ toolName: 'file_delete' }));
    expect(result.riskLevel).toBe('critical');
  });
});
