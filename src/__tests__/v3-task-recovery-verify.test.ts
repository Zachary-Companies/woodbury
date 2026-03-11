/**
 * Unit tests for Closure Engine V3 — TaskGraph, RecoveryEngine, Verifier
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createSingleTaskGraph, isSimpleGoal } from '../loop/v3/task-graph.js';
import { RecoveryEngine } from '../loop/v3/recovery.js';
import { SkillRegistry } from '../loop/v3/skill-registry.js';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import type { Goal, TaskNode, TaskResult, Observation } from '../loop/v3/types.js';

// ── createSingleTaskGraph ────────────────────────────────────

describe('createSingleTaskGraph', () => {
  it('creates a single-node graph from a goal', () => {
    const goal: Goal = {
      id: 'goal_1',
      objective: 'Write a function',
      successCriteria: [
        { id: 'sc_1', description: 'File exists', validator: { type: 'file_exists', path: 'src/fn.ts' }, met: false },
      ],
      constraints: [],
      forbiddenActions: [],
      priority: 'normal',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const graph = createSingleTaskGraph(goal);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.executionOrder).toHaveLength(1);
    expect(graph.nodes[0].status).toBe('ready');
    expect(graph.nodes[0].description).toBe('Write a function');
    expect(graph.nodes[0].validators).toHaveLength(1);
    expect(graph.nodes[0].validators[0].type).toBe('file_exists');
    expect(graph.nodes[0].dependsOn).toEqual([]);
    expect(graph.nodes[0].blocks).toEqual([]);
    expect(graph.nodes[0].goalId).toBe('goal_1');
  });

  it('excludes criteria without validators from task validators', () => {
    const goal: Goal = {
      id: 'goal_2',
      objective: 'Test',
      successCriteria: [
        { id: 'sc_1', description: 'It works well', met: false }, // no validator
        { id: 'sc_2', description: 'File exists', validator: { type: 'file_exists', path: 'x.ts' }, met: false },
      ],
      constraints: [],
      forbiddenActions: [],
      priority: 'normal',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const graph = createSingleTaskGraph(goal);
    expect(graph.nodes[0].validators).toHaveLength(1);
  });
});

// ── isSimpleGoal ────────────────────────────────────────────

describe('isSimpleGoal', () => {
  it('returns true for short, simple objectives', () => {
    expect(isSimpleGoal('Fix a typo in README')).toBe(true);
    expect(isSimpleGoal('Write a hello world function')).toBe(true);
    expect(isSimpleGoal('List all files in src')).toBe(true);
  });

  it('returns false for multi-step objectives', () => {
    expect(isSimpleGoal('First, create a module, and then write tests')).toBe(false);
    expect(isSimpleGoal('Build an app with authentication')).toBe(false);
    expect(isSimpleGoal('Set up CI/CD pipeline and configure linting')).toBe(false);
    expect(isSimpleGoal('Create a project with multiple components')).toBe(false);
  });

  it('returns false for very long objectives', () => {
    const longObj = 'A'.repeat(301);
    expect(isSimpleGoal(longObj)).toBe(false);
  });

  it('detects step indicators', () => {
    expect(isSimpleGoal('Step 1: do this. Step 2: do that')).toBe(false);
    expect(isSimpleGoal('Do this, second, do that')).toBe(false);
    expect(isSimpleGoal('Do this, finally, clean up')).toBe(false);
  });

  it('detects complex project indicators', () => {
    expect(isSimpleGoal('Migrate the database schema')).toBe(false);
    expect(isSimpleGoal('Implement a system for user tracking')).toBe(false);
  });
});

// ── RecoveryEngine ──────────────────────────────────────────

describe('RecoveryEngine', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let memoryStore: MemoryStore;
  let recoveryEngine: RecoveryEngine;

  const makeTask = (overrides?: Partial<TaskNode>): TaskNode => ({
    id: 'task_1',
    goalId: 'goal_1',
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
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-re-'));
    sessionId = `test_re_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    memoryStore = new MemoryStore();
    recoveryEngine = new RecoveryEngine(stateManager, memoryStore, new SkillRegistry());
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('error classification', () => {
    it('classifies transient errors → retry with backoff', () => {
      const task = makeTask();
      const result = makeResult({ error: 'timeout: request timed out after 30s' });
      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('retry');
      if (strategy.type === 'retry') {
        expect(strategy.backoffMs).toBeGreaterThan(0);
      }
    });

    it('classifies rate limit errors as transient', () => {
      const task = makeTask();
      const result = makeResult({ error: '429 Too Many Requests' });
      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('retry');
    });

    it('classifies permission errors → skip', () => {
      const task = makeTask();
      const result = makeResult({ error: 'Error: EACCES permission denied' });
      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('skip');
    });

    it('classifies not found errors → retry then skip', () => {
      const task = makeTask();
      const result = makeResult({ error: 'Error: ENOENT no such file or directory' });
      // First attempt: retry
      const strategy1 = recoveryEngine.determineStrategy(task, result);
      expect(strategy1.type).toBe('retry');

      // Record a recovery attempt
      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: strategy1, attempt: 1, success: false,
      });

      // Second attempt: skip
      const strategy2 = recoveryEngine.determineStrategy(task, result);
      expect(strategy2.type).toBe('skip');
    });

    it('classifies validation errors → retry then skip', () => {
      const task = makeTask();
      const result = makeResult({ error: 'Invalid input: schema validation failed' });
      const strategy1 = recoveryEngine.determineStrategy(task, result);
      expect(strategy1.type).toBe('retry');

      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: strategy1, attempt: 1, success: false,
      });

      const strategy2 = recoveryEngine.determineStrategy(task, result);
      expect(strategy2.type).toBe('skip');
    });

    it('classifies verification errors → retry', () => {
      const task = makeTask();
      const result = makeResult({ error: 'verification failed: file does not contain expected pattern' });
      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('retry');
    });

    it('classifies too_complex → decompose then abort', () => {
      const task = makeTask();
      const result = makeResult({ error: 'exceeded maximum iterations' });
      const strategy1 = recoveryEngine.determineStrategy(task, result);
      expect(strategy1.type).toBe('decompose');

      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: strategy1, attempt: 1, success: false,
      });

      const strategy2 = recoveryEngine.determineStrategy(task, result);
      expect(strategy2.type).toBe('abort');
    });

    it('classifies tool errors → alternative tool', () => {
      const task = makeTask();
      const failedObs: Observation = {
        id: 'obs_1', actionId: 'act_1', taskId: 'task_1',
        toolName: 'file_read', params: { path: 'test.ts' },
        result: 'tool error: tool failed unexpectedly',
        status: 'error', duration: 100, matchedExpectation: false,
        timestamp: new Date().toISOString(),
      };
      const result = makeResult({
        error: 'tool error: file_read failed',
        observations: [failedObs],
      });
      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('alternative_tool');
      if (strategy.type === 'alternative_tool') {
        expect(strategy.fallbackTool).toBe('shell_execute');
      }
    });

    it('chooses an alternate skill after repeated failures under the same skill', () => {
      const task = makeTask({ preferredSkill: 'code_change', description: 'Implement the fix and verify the result' });
      const result = makeResult({ error: 'verification failed: tests still failing' });

      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: { type: 'retry', maxAttempts: 3 }, attempt: 1, success: false,
      });

      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('alternative_skill');
      if (strategy.type === 'alternative_skill') {
        expect(strategy.fallbackSkill).toBe('test_and_verify');
      }
    });
  });

  describe('max retries', () => {
    it('aborts when max retries exceeded', () => {
      const task = makeTask({ maxRetries: 2 });
      const result = makeResult({ error: 'timeout' });

      // Add 2 recovery attempts
      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: { type: 'retry', maxAttempts: 2 }, attempt: 1, success: false,
      });
      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: { type: 'retry', maxAttempts: 2 }, attempt: 2, success: false,
      });

      const strategy = recoveryEngine.determineStrategy(task, result);
      expect(strategy.type).toBe('abort');
    });
  });

  describe('recordAttempt', () => {
    it('creates procedural memory on successful recovery', () => {
      const attempt = recoveryEngine.recordAttempt(
        'task_1', { type: 'retry', maxAttempts: 3 }, 1, true,
      );
      expect(attempt.success).toBe(true);
      const proceduralMemories = memoryStore.getByType('procedural');
      expect(proceduralMemories.length).toBeGreaterThanOrEqual(1);
      expect(proceduralMemories.some(m => m.content.includes('Recovery succeeded'))).toBe(true);
    });

    it('creates failure memory after exhausting retries', () => {
      recoveryEngine.recordAttempt(
        'task_1', { type: 'retry', maxAttempts: 3 }, 3, false, 'persistent error',
      );
      const failureMemories = memoryStore.getByType('failure');
      expect(failureMemories.length).toBeGreaterThanOrEqual(1);
      expect(failureMemories.some(m => m.content.includes('Recovery failed'))).toBe(true);
    });
  });

  describe('backoff calculation', () => {
    it('increases backoff exponentially', () => {
      const task = makeTask();
      const result = makeResult({ error: 'ECONNRESET' });

      const strategy0 = recoveryEngine.determineStrategy(task, result);
      expect(strategy0.type).toBe('retry');
      const backoff0 = (strategy0 as any).backoffMs;

      // Add one attempt
      stateManager.addRecoveryAttempt({
        taskId: task.id, strategy: strategy0, attempt: 1, success: false,
      });

      const strategy1 = recoveryEngine.determineStrategy(task, result);
      const backoff1 = (strategy1 as any).backoffMs;

      expect(backoff1).toBeGreaterThan(backoff0);
    });

    it('caps backoff at 30 seconds', () => {
      const task = makeTask({ maxRetries: 20 });
      const result = makeResult({ error: 'network error' });

      // Add many attempts
      for (let i = 0; i < 19; i++) {
        stateManager.addRecoveryAttempt({
          taskId: task.id, strategy: { type: 'retry', maxAttempts: 20 }, attempt: i + 1, success: false,
        });
      }

      const strategy = recoveryEngine.determineStrategy(task, result);
      if (strategy.type === 'retry') {
        expect(strategy.backoffMs).toBeLessThanOrEqual(30000);
      }
    });
  });
});
