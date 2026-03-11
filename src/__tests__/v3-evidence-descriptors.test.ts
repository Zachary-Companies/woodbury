/**
 * Unit tests for Closure Engine V3 — Evidence, ToolDescriptor, extended types
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { StateManager } from '../loop/v3/state-manager.js';
import { ToolDescriptorRegistry } from '../loop/v3/tool-descriptor.js';
import type {
  Evidence,
  BeliefEdge,
  ActionSpec,
  ValidationPlan,
  Goal,
  TaskNode,
  MemoryRecord,
  Observation,
  ReflectionRecord,
} from '../loop/v3/types.js';

// ── Evidence + StateManager ──────────────────────────────────

describe('Evidence management in StateManager', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-ev-'));
    sessionId = `test_ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates evidence records with auto-generated id and timestamp', () => {
    const ev = stateManager.addEvidence({
      type: 'tool_result',
      source: 'file_read',
      contentSummary: 'Read package.json successfully',
      reliability: 0.9,
    });
    expect(ev.id).toMatch(/^ev_/);
    expect(ev.timestamp).toBeTruthy();
    expect(ev.type).toBe('tool_result');
    expect(ev.source).toBe('file_read');
    expect(ev.reliability).toBe(0.9);
  });

  it('retrieves all evidence', () => {
    stateManager.addEvidence({ type: 'tool_result', source: 'a', contentSummary: 'x', reliability: 0.8 });
    stateManager.addEvidence({ type: 'document', source: 'b', contentSummary: 'y', reliability: 0.7 });
    const all = stateManager.getEvidence();
    expect(all).toHaveLength(2);
  });

  it('retrieves evidence by id', () => {
    const ev = stateManager.addEvidence({ type: 'api_response', source: 'api', contentSummary: 'ok', reliability: 0.95 });
    const found = stateManager.getEvidenceById(ev.id);
    expect(found).toBeDefined();
    expect(found!.source).toBe('api');
  });

  it('returns undefined for non-existent evidence id', () => {
    expect(stateManager.getEvidenceById('ev_nonexistent')).toBeUndefined();
  });

  it('includes evidence in state', () => {
    stateManager.addEvidence({ type: 'memory', source: 'mem', contentSummary: 'past', reliability: 0.6 });
    const state = stateManager.getState();
    expect(state.evidence).toHaveLength(1);
  });
});

// ── Belief Edges + StateManager ──────────────────────────────

describe('Belief edges in StateManager', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-be-'));
    sessionId = `test_be_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates belief edges with auto-generated id', () => {
    const edge = stateManager.addBeliefEdge({
      fromBeliefId: 'b1',
      toBeliefId: 'b2',
      type: 'supports',
      weight: 0.8,
    });
    expect(edge.id).toMatch(/^edge_/);
    expect(edge.createdAt).toBeTruthy();
    expect(edge.type).toBe('supports');
    expect(edge.weight).toBe(0.8);
  });

  it('retrieves edges for a belief id', () => {
    stateManager.addBeliefEdge({ fromBeliefId: 'b1', toBeliefId: 'b2', type: 'supports', weight: 0.9 });
    stateManager.addBeliefEdge({ fromBeliefId: 'b3', toBeliefId: 'b1', type: 'contradicts', weight: 0.7 });
    stateManager.addBeliefEdge({ fromBeliefId: 'b4', toBeliefId: 'b5', type: 'derived_from', weight: 0.6 });

    const b1Edges = stateManager.getBeliefEdges('b1');
    expect(b1Edges).toHaveLength(2);
  });

  it('retrieves edges by type', () => {
    stateManager.addBeliefEdge({ fromBeliefId: 'b1', toBeliefId: 'b2', type: 'supports', weight: 0.9 });
    stateManager.addBeliefEdge({ fromBeliefId: 'b3', toBeliefId: 'b4', type: 'supports', weight: 0.8 });
    stateManager.addBeliefEdge({ fromBeliefId: 'b5', toBeliefId: 'b6', type: 'contradicts', weight: 0.5 });

    const supportsEdges = stateManager.getBeliefEdgesByType('supports');
    expect(supportsEdges).toHaveLength(2);
  });
});

// ── Action History + StateManager ────────────────────────────

describe('Action history in StateManager', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-ah-'));
    sessionId = `test_ah_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves action specs', () => {
    const action: ActionSpec = {
      id: 'act_1',
      taskId: 't1',
      actionType: 'read_file',
      toolName: 'file_read',
      params: { path: 'test.ts' },
      rationale: 'Need to read the file',
      expectedObservations: ['File contents returned'],
      validationPlan: {
        successSignals: ['Non-empty content'],
        failureSignals: ['ENOENT'],
        independentChecks: [],
        confidenceThreshold: 0.8,
      },
      timeoutMs: 5000,
      costEstimate: 0,
    };
    stateManager.addAction(action);
    const history = stateManager.getActionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].toolName).toBe('file_read');
  });
});

// ── ToolDescriptorRegistry ───────────────────────────────────

describe('ToolDescriptorRegistry', () => {
  it('creates an empty registry', () => {
    const registry = new ToolDescriptorRegistry();
    expect(registry.getAll()).toHaveLength(0);
  });

  it('registers and retrieves descriptors manually', () => {
    const registry = new ToolDescriptorRegistry();
    registry.register({
      name: 'custom_tool',
      category: 'api',
      capabilities: ['Fetch data'],
      inputSchema: { type: 'object' },
      outputSchema: {},
      preconditions: ['API key set'],
      postconditions: ['Data returned'],
      commonFailureModes: ['Timeout'],
      validationMethods: ['Check status'],
      avgLatencyMs: 0,
      avgReliability: 1.0,
      avgCost: 0,
      safeForAutonomousUse: true,
    });

    const desc = registry.get('custom_tool');
    expect(desc).toBeDefined();
    expect(desc!.category).toBe('api');
    expect(desc!.capabilities).toContain('Fetch data');
  });

  it('returns undefined for unknown tools', () => {
    const registry = new ToolDescriptorRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('updates running averages on recordExecution', () => {
    const registry = new ToolDescriptorRegistry();
    registry.register({
      name: 'test_tool',
      category: 'file',
      capabilities: [],
      inputSchema: {},
      outputSchema: {},
      preconditions: [],
      postconditions: [],
      commonFailureModes: [],
      validationMethods: [],
      avgLatencyMs: 0,
      avgReliability: 1.0,
      avgCost: 0,
      safeForAutonomousUse: true,
    });

    registry.recordExecution('test_tool', 100, true);
    registry.recordExecution('test_tool', 200, true);
    registry.recordExecution('test_tool', 300, false);

    const desc = registry.get('test_tool')!;
    expect(desc.avgLatencyMs).toBe(200); // (100+200+300)/3
    expect(desc.avgReliability).toBeCloseTo(2 / 3); // 2 out of 3 succeeded
  });

  it('records execution even without a descriptor (no-op for descriptor update)', () => {
    const registry = new ToolDescriptorRegistry();
    // Should not throw
    registry.recordExecution('unknown_tool', 50, true);
    expect(registry.get('unknown_tool')).toBeUndefined();
  });
});

// ── Extended type shape tests ────────────────────────────────

describe('Extended type shapes', () => {
  it('Goal accepts optional fields', () => {
    const goal: Goal = {
      id: 'g1', objective: 'Test', successCriteria: [],
      constraints: [], forbiddenActions: [],
      priority: 'normal', status: 'active',
      createdAt: '', updatedAt: '',
      userRequest: 'original request',
      interpretedObjective: 'interpreted',
      escalationCriteria: ['budget exceeded'],
    };
    expect(goal.userRequest).toBe('original request');
    expect(goal.escalationCriteria).toHaveLength(1);
  });

  it('TaskNode accepts optional fields', () => {
    const node: TaskNode = {
      id: 't1', goalId: 'g1', description: 'Test',
      status: 'ready', dependsOn: [], blocks: [],
      maxRetries: 3, retryCount: 0, validators: [],
      createdAt: '',
      parentId: 't0',
      title: 'Short title',
      owner: 'engine',
      inputRefs: ['ref1'],
      outputRefs: ['ref2'],
      riskLevel: 'low',
      estimatedCost: 0.01,
    };
    expect(node.parentId).toBe('t0');
    expect(node.riskLevel).toBe('low');
  });

  it('MemoryRecord accepts preference type and optional fields', () => {
    const mem: MemoryRecord = {
      id: 'm1', type: 'preference', content: 'User prefers dark mode',
      tags: ['ui'], confidence: 0.9, accessCount: 0,
      createdAt: '', updatedAt: '',
      title: 'Dark mode pref',
      applicabilityConditions: ['UI settings'],
    };
    expect(mem.type).toBe('preference');
    expect(mem.title).toBe('Dark mode pref');
  });

  it('Observation accepts optional fields', () => {
    const obs: Observation = {
      id: 'o1', actionId: 'a1', taskId: 't1',
      toolName: 'file_read', params: {}, result: 'ok',
      status: 'success', duration: 10, matchedExpectation: true,
      timestamp: '',
      summary: 'Read a file',
      structuredData: { lines: 42 },
      matchedExpectationScore: 0.95,
    };
    expect(obs.summary).toBe('Read a file');
    expect(obs.matchedExpectationScore).toBe(0.95);
  });

  it('ReflectionRecord accepts optional fields', () => {
    const ref: ReflectionRecord = {
      id: 'r1', trigger: 'periodic', assessment: 'good',
      lessonsLearned: [], planAdjustments: [],
      newMemories: [], timestamp: '',
      rootCauseFindings: ['Missing dep'],
      confidenceCalibrationNotes: ['Overconfident on API calls'],
      recommendedSkillUpdates: ['Add retry logic'],
      recommendedPolicyUpdates: ['Lower confidence threshold'],
    };
    expect(ref.rootCauseFindings).toHaveLength(1);
    expect(ref.recommendedPolicyUpdates).toHaveLength(1);
  });

  it('ValidationPlan shape compiles', () => {
    const plan: ValidationPlan = {
      successSignals: ['File exists'],
      failureSignals: ['ENOENT'],
      independentChecks: [
        { name: 'readback', method: 'api_readback', description: 'Re-read file' },
      ],
      confidenceThreshold: 0.85,
    };
    expect(plan.independentChecks).toHaveLength(1);
    expect(plan.independentChecks[0].method).toBe('api_readback');
  });
});
