/**
 * Unit tests for Closure Engine V3 — StrategicPlanner, Critic
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import { StrategicPlanner } from '../loop/v3/strategic-planner.js';
import { Critic } from '../loop/v3/critic.js';
import type { Goal, Evidence, Belief } from '../loop/v3/types.js';
import { resetSQLiteMemoryStoreCache } from '../sqlite-memory-store.js';

// Mock adapter for LLM calls
const mockAdapter = {
  createCompletion: async ({ messages }: any) => ({
    content: JSON.stringify({
      tasks: [
        { description: 'Step 1: Read file', dependsOn: [] },
        { description: 'Step 2: Modify code', dependsOn: ['step_1'] },
      ],
    }),
    toolCalls: [],
    stopReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
};

const criticMockAdapter = {
  createCompletion: async () => ({
    content: JSON.stringify({
      hiddenAssumptions: ['Assumes file exists'],
      weakEvidence: ['No validation'],
      falseSuccessRisks: [],
      toolMisuses: [],
      missingEdgeCases: ['Error handling'],
      overallRisk: 'medium',
      recommendation: 'proceed',
      suggestedActions: ['Add file existence check'],
    }),
    toolCalls: [],
    stopReason: 'stop',
    usage: { inputTokens: 200, outputTokens: 100 },
  }),
};

const makeGoal = (obj: string): Goal => ({
  id: 'goal_1',
  objective: obj,
  successCriteria: [
    { id: 'sc_1', description: 'It works', met: false },
  ],
  constraints: [],
  forbiddenActions: [],
  priority: 'normal',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// ── StrategicPlanner ─────────────────────────────────────────

describe('StrategicPlanner', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let memoryStore: MemoryStore;
  let planner: StrategicPlanner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-sp-'));
    process.env.WOODBURY_MEMORY_DB_PATH = join(tmpDir, 'memory.db');
    resetSQLiteMemoryStoreCache();
    sessionId = `test_sp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    memoryStore = new MemoryStore();
    planner = new StrategicPlanner(
      stateManager, memoryStore, mockAdapter as any,
      'openai', 'gpt-4', 'You are a helpful assistant.',
    );
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    delete process.env.WOODBURY_MEMORY_DB_PATH;
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates at least one plan', async () => {
    const goal = makeGoal('Write a function');
    const plans = await planner.generatePlans(goal);
    expect(plans.length).toBeGreaterThanOrEqual(1);
  });

  it('each plan has required fields', async () => {
    const goal = makeGoal('Build a module');
    const plans = await planner.generatePlans(goal);
    for (const plan of plans) {
      expect(plan.id).toMatch(/^plan_/);
      expect(plan.strategy).toBeTruthy();
      expect(plan.taskGraph).toBeDefined();
      expect(plan.taskGraph.nodes.length).toBeGreaterThanOrEqual(1);
      expect(typeof plan.completionProbability).toBe('number');
      expect(typeof plan.risk).toBe('number');
      expect(typeof plan.cost).toBe('number');
      expect(plan.rationale).toBeTruthy();
    }
  });

  it('rankPlans scores and sorts plans', async () => {
    const goal = makeGoal('Create a feature');
    const plans = await planner.generatePlans(goal);
    const ranked = planner.rankPlans(plans);
    expect(ranked).toHaveLength(plans.length);
    // First plan should have highest score
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it('selectBest returns the top-ranked plan', async () => {
    const goal = makeGoal('Implement feature');
    const plans = await planner.generatePlans(goal);
    const best = planner.selectBest(plans);
    expect(best).toBeDefined();
    expect(best.score).toBeGreaterThan(0);
  });

  it('scoring formula weights are applied', () => {
    const goal = makeGoal('Test scoring');
    const plans = planner.rankPlans([
      {
        id: 'p1', strategy: 'fast_path',
        taskGraph: { nodes: [], executionOrder: [] },
        score: 0,
        completionProbability: 1.0, infoGain: 0, taskReadiness: 1.0,
        verificationStrength: 0, risk: 0, cost: 0,
        rationale: 'High completion, high readiness',
      },
      {
        id: 'p2', strategy: 'evidence_first',
        taskGraph: { nodes: [], executionOrder: [] },
        score: 0,
        completionProbability: 0, infoGain: 1.0, taskReadiness: 0,
        verificationStrength: 1.0, risk: 0, cost: 0,
        rationale: 'High info gain, high verification',
      },
    ]);

    // p1: 1.0*0.35 + 0*0.20 + 1.0*0.15 + 0*0.15 - 0 - 0 = 0.50
    // p2: 0*0.35 + 1.0*0.20 + 0*0.15 + 1.0*0.15 - 0 - 0 = 0.35
    expect(plans[0].id).toBe('p1');
    expect(plans[0].score).toBeCloseTo(0.50, 2);
    expect(plans[1].score).toBeCloseTo(0.35, 2);
  });

  it('includes evidence_first strategy with exploration task', async () => {
    const goal = makeGoal('Build complex system');
    const plans = await planner.generatePlans(goal);
    const efPlan = plans.find(p => p.strategy === 'evidence_first');
    if (efPlan) {
      // Evidence-first should have an explore task
      const exploreTask = efPlan.taskGraph.nodes.find(n =>
        n.description.includes('Explore') || n.description.includes('evidence')
      );
      expect(exploreTask).toBeDefined();
    }
  });
});

// ── Critic ───────────────────────────────────────────────────

describe('Critic', () => {
  let critic: Critic;

  beforeEach(() => {
    critic = new Critic(criticMockAdapter as any, 'openai', 'gpt-4');
  });

  describe('critiquePlan', () => {
    it('returns critique result from LLM', async () => {
      const plan = {
        id: 'plan_1', strategy: 'fast_path' as const,
        taskGraph: {
          nodes: [{
            id: 't1', goalId: 'g1', description: 'Write code',
            status: 'ready' as const, dependsOn: [], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          }],
          executionOrder: ['t1'],
        },
        score: 0.8,
        completionProbability: 0.9, infoGain: 0.3,
        taskReadiness: 1.0, verificationStrength: 0.5,
        risk: 0.2, cost: 0.1, rationale: 'Fast',
      };
      const goal = makeGoal('Write code');

      const critique = await critic.critiquePlan(plan, goal);
      expect(critique.hiddenAssumptions).toHaveLength(1);
      expect(critique.overallRisk).toBe('medium');
      expect(critique.recommendation).toBe('proceed');
    });

    it('falls back to heuristic on LLM failure', async () => {
      const failCritic = new Critic(
        { createCompletion: async () => { throw new Error('API down'); } } as any,
        'openai', 'gpt-4',
      );

      const plan = {
        id: 'plan_1', strategy: 'fast_path' as const,
        taskGraph: {
          nodes: [{
            id: 't1', goalId: 'g1', description: 'Do stuff',
            status: 'ready' as const, dependsOn: [], blocks: [],
            maxRetries: 3, retryCount: 0, validators: [],
            createdAt: new Date().toISOString(),
          }],
          executionOrder: ['t1'],
        },
        score: 0, completionProbability: 0.8, infoGain: 0.3,
        taskReadiness: 1.0, verificationStrength: 0.5,
        risk: 0.2, cost: 0.1, rationale: 'Quick',
      };
      const goal = makeGoal('Do stuff');
      goal.successCriteria.push({ id: 'sc_2', description: 'Also works', met: false });

      const critique = await failCritic.critiquePlan(plan, goal);
      expect(critique.recommendation).toBeDefined();
      // Heuristic should flag single task with multiple criteria
      expect(critique.hiddenAssumptions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('detectBlindSpots', () => {
    it('detects zero evidence', async () => {
      const goal = makeGoal('Test');
      const blindSpots = await critic.detectBlindSpots(goal, [], []);
      expect(blindSpots).toContain('No evidence collected yet — all beliefs are unverified assumptions');
    });

    it('detects single-source evidence', async () => {
      const goal = makeGoal('Test');
      const evidence: Evidence[] = [
        { id: 'e1', type: 'tool_result', source: 'file_read', contentSummary: 'ok', reliability: 0.9, timestamp: '' },
        { id: 'e2', type: 'tool_result', source: 'file_read', contentSummary: 'ok2', reliability: 0.9, timestamp: '' },
      ];
      const blindSpots = await critic.detectBlindSpots(goal, [], evidence);
      expect(blindSpots.some(s => s.includes('single source'))).toBe(true);
    });

    it('detects low-confidence beliefs', async () => {
      const goal = makeGoal('Test');
      const beliefs: Belief[] = [
        {
          id: 'b1', claim: 'Maybe works', confidence: 0.3,
          source: { type: 'inference', derivedFrom: [] },
          status: 'active', createdAt: '',
        },
      ];
      const blindSpots = await critic.detectBlindSpots(goal, beliefs, []);
      expect(blindSpots.some(s => s.includes('low-confidence'))).toBe(true);
    });

    it('detects unmet success criteria', async () => {
      const goal = makeGoal('Test');
      const blindSpots = await critic.detectBlindSpots(goal, [], [
        { id: 'e1', type: 'tool_result', source: 'a', contentSummary: 'ok', reliability: 0.9, timestamp: '' },
      ]);
      expect(blindSpots.some(s => s.includes('success criteria'))).toBe(true);
    });
  });

  describe('validateSuccess', () => {
    it('returns genuine: true when no concerns', async () => {
      const goal = makeGoal('Test');
      goal.successCriteria = [{ id: 'sc_1', description: 'Works', met: true }];
      const evidence: Evidence[] = [
        { id: 'e1', type: 'tool_result', source: 'test_runner', contentSummary: 'All tests pass', reliability: 0.95, timestamp: '' },
      ];

      const result = await critic.validateSuccess(goal, evidence);
      expect(result.genuine).toBe(true);
      expect(result.concerns).toHaveLength(0);
    });

    it('detects unmet criteria', async () => {
      const goal = makeGoal('Test');
      const result = await critic.validateSuccess(goal, [
        { id: 'e1', type: 'tool_result', source: 'a', contentSummary: 'ok', reliability: 0.9, timestamp: '' },
      ]);
      expect(result.genuine).toBe(false);
      expect(result.concerns.some(c => c.includes('unmet'))).toBe(true);
    });

    it('detects no evidence', async () => {
      const goal = makeGoal('Test');
      goal.successCriteria = [{ id: 'sc_1', description: 'Works', met: true }];
      const result = await critic.validateSuccess(goal, []);
      expect(result.genuine).toBe(false);
      expect(result.concerns.some(c => c.includes('No evidence'))).toBe(true);
    });

    it('detects low reliability evidence', async () => {
      const goal = makeGoal('Test');
      goal.successCriteria = [{ id: 'sc_1', description: 'Works', met: true }];
      const evidence: Evidence[] = [
        { id: 'e1', type: 'tool_result', source: 'a', contentSummary: 'ok', reliability: 0.2, timestamp: '' },
      ];
      const result = await critic.validateSuccess(goal, evidence);
      expect(result.genuine).toBe(false);
      expect(result.concerns.some(c => c.includes('reliability'))).toBe(true);
    });

    it('detects error evidence', async () => {
      const goal = makeGoal('Test');
      goal.successCriteria = [{ id: 'sc_1', description: 'Works', met: true }];
      const evidence: Evidence[] = [
        { id: 'e1', type: 'tool_result', source: 'a', contentSummary: 'Error: ENOENT', reliability: 0.8, timestamp: '' },
      ];
      const result = await critic.validateSuccess(goal, evidence);
      expect(result.concerns.some(c => c.includes('error'))).toBe(true);
    });
  });
});
