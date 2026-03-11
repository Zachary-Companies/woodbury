/**
 * Unit tests for Closure Engine V3 — StateManager, MemoryStore, BeliefGraph
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import { BeliefGraph } from '../loop/v3/belief-graph.js';
import type { Goal, TaskNode, TaskGraph, Observation, EvidenceSource } from '../loop/v3/types.js';

// ── StateManager ─────────────────────────────────────────────

describe('StateManager', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-sm-'));
    sessionId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
  });

  afterEach(async () => {
    // Clean up state dir
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates fresh state on new session', () => {
    const sm = new StateManager(sessionId, tmpDir);
    const state = sm.getState();
    expect(state.sessionId).toBe(sessionId);
    expect(state.goal).toBeNull();
    expect(state.taskGraph).toBeNull();
    expect(state.beliefs).toEqual([]);
    expect(state.observations).toEqual([]);
    expect(state.phase).toBe('idle');
    expect(state.iteration).toBe(0);
  });

  it('persists and reloads state', () => {
    const sm1 = new StateManager(sessionId, tmpDir);
    sm1.setPhase('executing');
    sm1.incrementIteration();
    sm1.incrementIteration();

    // Create a new instance with same session ID
    const sm2 = new StateManager(sessionId, tmpDir);
    expect(sm2.getPhase()).toBe('executing');
    expect(sm2.getIteration()).toBe(2);
  });

  describe('goals', () => {
    it('sets and gets a goal', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const goal: Goal = {
        id: 'goal_1',
        objective: 'Write tests',
        successCriteria: [{ id: 'sc_1', description: 'Tests pass', met: false }],
        constraints: [],
        forbiddenActions: [],
        priority: 'normal',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sm.setGoal(goal);
      expect(sm.getGoal()).toEqual(goal);
    });

    it('updates goal status', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const goal: Goal = {
        id: 'goal_1',
        objective: 'Test',
        successCriteria: [],
        constraints: [],
        forbiddenActions: [],
        priority: 'normal',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sm.setGoal(goal);
      sm.updateGoalStatus('achieved');
      expect(sm.getGoal()!.status).toBe('achieved');
    });

    it('writes goal compat file', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const goal: Goal = {
        id: 'goal_1',
        objective: 'Compat test',
        successCriteria: [{ id: 'sc_1', description: 'It works', met: false }],
        constraints: ['no breaking changes'],
        forbiddenActions: [],
        priority: 'normal',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sm.setGoal(goal);
      expect(existsSync(join(tmpDir, '.woodbury-work', 'goal.json'))).toBe(true);
    });
  });

  describe('task graph', () => {
    it('sets task graph and finds ready tasks', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const graph: TaskGraph = {
        nodes: [
          {
            id: 't1', goalId: 'g1', description: 'Step 1',
            status: 'ready', dependsOn: [], blocks: ['t2'],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: 't2', goalId: 'g1', description: 'Step 2',
            status: 'pending', dependsOn: ['t1'], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
        ],
        executionOrder: ['t1', 't2'],
      };
      sm.setTaskGraph(graph);

      const ready = sm.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('t1');
    });

    it('returns next ready task after dependency completes', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const graph: TaskGraph = {
        nodes: [
          {
            id: 't1', goalId: 'g1', description: 'Step 1',
            status: 'ready', dependsOn: [], blocks: ['t2'],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: 't2', goalId: 'g1', description: 'Step 2',
            status: 'pending', dependsOn: ['t1'], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
        ],
        executionOrder: ['t1', 't2'],
      };
      sm.setTaskGraph(graph);
      sm.updateTaskStatus('t1', 'done', { success: true, output: 'ok', observations: [], toolCallCount: 1, durationMs: 100 });

      const next = sm.getNextTask();
      expect(next).not.toBeNull();
      expect(next!.id).toBe('t2');
    });

    it('reports task graph complete when all tasks done/skipped', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const graph: TaskGraph = {
        nodes: [
          {
            id: 't1', goalId: 'g1', description: 'Step 1',
            status: 'done', dependsOn: [], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: 't2', goalId: 'g1', description: 'Step 2',
            status: 'skipped', dependsOn: [], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          },
        ],
        executionOrder: ['t1', 't2'],
      };
      sm.setTaskGraph(graph);
      expect(sm.isTaskGraphComplete()).toBe(true);
    });

    it('writes plan compat file', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const graph: TaskGraph = {
        nodes: [{
          id: 't1', goalId: 'g1', description: 'Step 1',
          status: 'ready', dependsOn: [], blocks: [],
          maxRetries: 3, retryCount: 0, validators: [],
          createdAt: new Date().toISOString(),
        }],
        executionOrder: ['t1'],
      };
      sm.setTaskGraph(graph);
      expect(existsSync(join(tmpDir, '.woodbury-work', 'plan.json'))).toBe(true);
    });
  });

  describe('beliefs', () => {
    it('adds and retrieves active beliefs', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const source: EvidenceSource = { type: 'tool_result', toolName: 'file_read', actionId: 'a1' };
      const belief = sm.addBelief({ claim: 'File exists', confidence: 0.9, source, status: 'active' });
      expect(belief.id).toMatch(/^belief_/);
      expect(sm.getBeliefs()).toHaveLength(1);
      expect(sm.getBeliefs()[0].claim).toBe('File exists');
    });

    it('invalidates beliefs', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const source: EvidenceSource = { type: 'tool_result', toolName: 'file_read', actionId: 'a1' };
      const belief = sm.addBelief({ claim: 'File exists', confidence: 0.9, source, status: 'active' });
      sm.invalidateBelief(belief.id, 'file was deleted');
      expect(sm.getBeliefs()).toHaveLength(0); // getBeliefs filters active only
    });

    it('finds beliefs by keyword', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const source: EvidenceSource = { type: 'tool_result', toolName: 'file_read', actionId: 'a1' };
      sm.addBelief({ claim: 'File "src/index.ts" exists', confidence: 0.9, source, status: 'active' });
      sm.addBelief({ claim: 'Tests are passing', confidence: 0.85, source, status: 'active' });

      const found = sm.findBeliefs('index.ts');
      expect(found).toHaveLength(1);
      expect(found[0].claim).toContain('index.ts');
    });
  });

  describe('observations', () => {
    it('adds observations with auto-generated ID and timestamp', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const obs = sm.addObservation({
        actionId: 'act_1',
        taskId: 't1',
        toolName: 'file_read',
        params: { path: 'src/index.ts' },
        result: 'file content',
        status: 'success',
        duration: 42,
        matchedExpectation: true,
      });
      expect(obs.id).toMatch(/^obs_/);
      expect(obs.timestamp).toBeTruthy();
      expect(sm.getObservations()).toHaveLength(1);
    });

    it('keeps observations bounded to 200', () => {
      const sm = new StateManager(sessionId, tmpDir);
      for (let i = 0; i < 210; i++) {
        sm.addObservation({
          actionId: `act_${i}`,
          taskId: 't1',
          toolName: 'file_read',
          params: {},
          result: `result ${i}`,
          status: 'success',
          duration: 10,
          matchedExpectation: true,
        });
      }
      expect(sm.getObservations().length).toBeLessThanOrEqual(200);
    });
  });

  describe('phase and iteration', () => {
    it('tracks phase changes', () => {
      const sm = new StateManager(sessionId, tmpDir);
      sm.setPhase('goal_setting');
      expect(sm.getPhase()).toBe('goal_setting');
      sm.setPhase('executing');
      expect(sm.getPhase()).toBe('executing');
    });

    it('increments iteration', () => {
      const sm = new StateManager(sessionId, tmpDir);
      expect(sm.getIteration()).toBe(0);
      sm.incrementIteration();
      expect(sm.getIteration()).toBe(1);
      sm.incrementIteration();
      expect(sm.getIteration()).toBe(2);
    });
  });

  describe('reflections', () => {
    it('adds a reflection record', () => {
      const sm = new StateManager(sessionId, tmpDir);
      const reflection = sm.addReflection({
        trigger: 'periodic',
        assessment: 'Good progress',
        lessonsLearned: ['Lesson 1'],
        planAdjustments: [],
        newMemories: [],
      });
      expect(reflection.id).toMatch(/^reflect_/);
      expect(reflection.timestamp).toBeTruthy();
      expect(sm.getState().reflections).toHaveLength(1);
    });
  });

  describe('recovery', () => {
    it('adds and retrieves recovery attempts', () => {
      const sm = new StateManager(sessionId, tmpDir);
      sm.addRecoveryAttempt({
        taskId: 't1',
        strategy: { type: 'retry', maxAttempts: 3 },
        attempt: 1,
        success: false,
        error: 'ENOENT',
      });
      sm.addRecoveryAttempt({
        taskId: 't1',
        strategy: { type: 'retry', maxAttempts: 3 },
        attempt: 2,
        success: true,
      });
      const attempts = sm.getRecoveryAttemptsForTask('t1');
      expect(attempts).toHaveLength(2);
      expect(attempts[0].success).toBe(false);
      expect(attempts[1].success).toBe(true);
    });
  });
});

// ── BeliefGraph ──────────────────────────────────────────────

describe('BeliefGraph', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let beliefGraph: BeliefGraph;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-bg-'));
    sessionId = `test_bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    beliefGraph = new BeliefGraph(stateManager);
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('derives belief from successful file_read observation', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/index.ts' },
      result: 'export const x = 1;',
      status: 'success', duration: 25, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).not.toBeNull();
    expect(belief!.claim).toBe('File "src/index.ts" exists and is readable');
    expect(belief!.confidence).toBe(0.95);
  });

  it('derives belief from successful file_write observation', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_write', params: { path: 'src/new.ts' },
      result: 'ok',
      status: 'success', duration: 15, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).not.toBeNull();
    expect(belief!.claim).toContain('src/new.ts');
    expect(belief!.claim).toContain('written/updated');
  });

  it('derives belief from successful test_runner with all passing', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'test_runner', params: {},
      result: 'Tests: 10 passed, 0 failed',
      status: 'success', duration: 5000, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).not.toBeNull();
    expect(belief!.claim).toBe('All tests are passing');
  });

  it('returns null for failed observations', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'missing.ts' },
      result: 'Error: ENOENT',
      status: 'error', duration: 5, matchedExpectation: false,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).toBeNull();
  });

  it('invalidates contradicting beliefs on failed observation', () => {
    // First, create a belief that file exists
    const successObs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/temp.ts' },
      result: 'content',
      status: 'success', duration: 10, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(successObs);
    expect(stateManager.getBeliefs()).toHaveLength(1);

    // Then, a failed file_read should invalidate the belief
    const failObs: Observation = {
      id: 'obs_2', actionId: 'act_2', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/temp.ts' },
      result: 'Error: ENOENT file not found',
      status: 'error', duration: 5, matchedExpectation: false,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(failObs);
    expect(stateManager.getBeliefs()).toHaveLength(0);
  });

  it('invalidates test passing belief when tests fail', () => {
    // Create "tests passing" belief
    const passObs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'test_runner', params: {},
      result: 'All tests passed, 0 fail',
      status: 'success', duration: 3000, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(passObs);
    expect(stateManager.getBeliefs()).toHaveLength(1);

    // Tests now fail
    const failObs: Observation = {
      id: 'obs_2', actionId: 'act_2', taskId: 't1',
      toolName: 'test_runner', params: {},
      result: '3 tests failed',
      status: 'error', duration: 4000, matchedExpectation: false,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(failObs);
    expect(stateManager.getBeliefs()).toHaveLength(0);
  });

  it('deduplicates identical beliefs', () => {
    const obs1: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/index.ts' },
      result: 'content', status: 'success', duration: 10,
      matchedExpectation: true, timestamp: new Date().toISOString(),
    };
    const obs2: Observation = {
      id: 'obs_2', actionId: 'act_2', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/index.ts' },
      result: 'content', status: 'success', duration: 8,
      matchedExpectation: true, timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(obs1);
    beliefGraph.deriveFromObservation(obs2);
    expect(stateManager.getBeliefs()).toHaveLength(1);
  });

  it('generates context string from beliefs', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'src/index.ts' },
      result: 'content', status: 'success', duration: 10,
      matchedExpectation: true, timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(obs);
    const ctx = beliefGraph.toContextString();
    expect(ctx).toContain('## Current Beliefs');
    expect(ctx).toContain('[95%]');
    expect(ctx).toContain('src/index.ts');
  });

  it('returns empty string when no beliefs exist', () => {
    expect(beliefGraph.toContextString()).toBe('');
  });

  it('returns null for tools without derivation rules', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'unknown_tool', params: {},
      result: 'ok', status: 'success', duration: 5,
      matchedExpectation: true, timestamp: new Date().toISOString(),
    };
    expect(beliefGraph.deriveFromObservation(obs)).toBeNull();
  });

  it('gets high confidence beliefs above threshold', () => {
    const source: EvidenceSource = { type: 'tool_result', toolName: 'file_read', actionId: 'a1' };
    stateManager.addBelief({ claim: 'High conf', confidence: 0.95, source, status: 'active' });
    stateManager.addBelief({ claim: 'Low conf', confidence: 0.5, source, status: 'active' });

    const highConf = beliefGraph.getHighConfidenceBeliefs(0.7);
    expect(highConf).toHaveLength(1);
    expect(highConf[0].claim).toBe('High conf');
  });
});
