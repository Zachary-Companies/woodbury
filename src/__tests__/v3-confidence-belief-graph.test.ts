/**
 * Unit tests for Closure Engine V3 — ConfidenceEngine, BeliefGraph typed edges
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import { BeliefGraph } from '../loop/v3/belief-graph.js';
import { ConfidenceEngine } from '../loop/v3/confidence-engine.js';
import { ToolDescriptorRegistry } from '../loop/v3/tool-descriptor.js';
import type { Observation, Belief } from '../loop/v3/types.js';

// ── BeliefGraph typed edges ──────────────────────────────────

describe('BeliefGraph typed edges', () => {
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

  it('creates evidence records when deriving beliefs', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'test.ts' },
      result: 'file contents here', status: 'success',
      duration: 10, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(obs);
    const evidence = stateManager.getEvidence();
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence[0].type).toBe('tool_result');
    expect(evidence[0].source).toBe('file_read');
  });

  it('links evidence IDs to new beliefs', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_write', params: { path: 'output.ts' },
      result: 'ok', status: 'success',
      duration: 15, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).not.toBeNull();
    expect(belief!.evidenceIds).toBeDefined();
    expect(belief!.evidenceIds!.length).toBeGreaterThanOrEqual(1);
  });

  it('creates supports edge on re-observation of same claim', () => {
    const makeObs = (id: string): Observation => ({
      id, actionId: `act_${id}`, taskId: 't1',
      toolName: 'file_read', params: { path: 'same.ts' },
      result: 'content', status: 'success',
      duration: 10, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    });

    beliefGraph.deriveFromObservation(makeObs('obs_1'));
    beliefGraph.deriveFromObservation(makeObs('obs_2'));

    const edges = stateManager.getBeliefEdgesByType('supports');
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('creates updated_by edges when superseding beliefs', () => {
    // First: read a file
    const obs1: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'target.ts' },
      result: 'v1 contents', status: 'success',
      duration: 10, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(obs1);

    // Then: write the same file (supersedes the read claim)
    const obs2: Observation = {
      id: 'obs_2', actionId: 'act_2', taskId: 't1',
      toolName: 'file_write', params: { path: 'target.ts' },
      result: 'written', status: 'success',
      duration: 15, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    beliefGraph.deriveFromObservation(obs2);

    const edges = stateManager.getBeliefEdgesByType('updated_by');
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('addEdge creates edge in state manager', () => {
    const b1 = stateManager.addBelief({
      claim: 'A', confidence: 0.9,
      source: { type: 'inference', derivedFrom: [] },
      status: 'active',
    });
    const b2 = stateManager.addBelief({
      claim: 'B', confidence: 0.8,
      source: { type: 'inference', derivedFrom: [] },
      status: 'active',
    });

    beliefGraph.addEdge(b1.id, b2.id, 'depends_on', 0.7);
    const edges = stateManager.getBeliefEdges(b1.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe('depends_on');
  });

  it('getSupportingBeliefs returns beliefs with supports edges', () => {
    const b1 = stateManager.addBelief({
      claim: 'Main', confidence: 0.8,
      source: { type: 'inference', derivedFrom: [] },
      status: 'active',
    });
    const b2 = stateManager.addBelief({
      claim: 'Supporting', confidence: 0.9,
      source: { type: 'inference', derivedFrom: [] },
      status: 'active',
    });
    beliefGraph.addEdge(b2.id, b1.id, 'supports', 0.85);

    const supporters = beliefGraph.getSupportingBeliefs(b1.id);
    expect(supporters).toHaveLength(1);
    expect(supporters[0].claim).toBe('Supporting');
  });

  it('getEvidenceChain returns evidence IDs for a belief', () => {
    const obs: Observation = {
      id: 'obs_1', actionId: 'act_1', taskId: 't1',
      toolName: 'file_read', params: { path: 'chain.ts' },
      result: 'data', status: 'success',
      duration: 10, matchedExpectation: true,
      timestamp: new Date().toISOString(),
    };
    const belief = beliefGraph.deriveFromObservation(obs);
    expect(belief).not.toBeNull();
    const chain = beliefGraph.getEvidenceChain(belief!.id);
    expect(chain.length).toBeGreaterThanOrEqual(1);
  });
});

// ── ConfidenceEngine ─────────────────────────────────────────

describe('ConfidenceEngine', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let memoryStore: MemoryStore;
  let confidenceEngine: ConfidenceEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-ce-'));
    sessionId = `test_ce_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    memoryStore = new MemoryStore();
    confidenceEngine = new ConfidenceEngine(stateManager, memoryStore);
  });

  afterEach(async () => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('getTier', () => {
    it('returns auto for >= 0.90', () => {
      expect(confidenceEngine.getTier(0.95)).toBe('auto');
      expect(confidenceEngine.getTier(0.90)).toBe('auto');
    });

    it('returns double_check for >= 0.75', () => {
      expect(confidenceEngine.getTier(0.80)).toBe('double_check');
      expect(confidenceEngine.getTier(0.75)).toBe('double_check');
    });

    it('returns hypothesis for >= 0.50', () => {
      expect(confidenceEngine.getTier(0.60)).toBe('hypothesis');
      expect(confidenceEngine.getTier(0.50)).toBe('hypothesis');
    });

    it('returns unreliable for < 0.50', () => {
      expect(confidenceEngine.getTier(0.49)).toBe('unreliable');
      expect(confidenceEngine.getTier(0.10)).toBe('unreliable');
      expect(confidenceEngine.getTier(0)).toBe('unreliable');
    });
  });

  describe('calculateConfidence', () => {
    it('returns a number between 0 and 1', () => {
      const belief = stateManager.addBelief({
        claim: 'File "test.ts" exists and is readable',
        confidence: 0.85,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'act_1' },
        status: 'active',
      });
      const score = confidenceEngine.calculateConfidence(belief);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('penalizes ambiguous claims', () => {
      const clearBelief = stateManager.addBelief({
        claim: 'File "test.ts" exists',
        confidence: 0.9,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'a1' },
        status: 'active',
      });
      const ambiguousBelief = stateManager.addBelief({
        claim: 'File might possibly exist and perhaps could be readable',
        confidence: 0.9,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'a2' },
        status: 'active',
      });

      const clearScore = confidenceEngine.calculateConfidence(clearBelief);
      const ambiguousScore = confidenceEngine.calculateConfidence(ambiguousBelief);
      expect(clearScore).toBeGreaterThan(ambiguousScore);
    });

    it('increases score with supporting edges', () => {
      const b1 = stateManager.addBelief({
        claim: 'Main claim here',
        confidence: 0.7,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'a1' },
        status: 'active',
      });
      const scoreWithout = confidenceEngine.calculateConfidence(b1);

      // Add supports edges
      stateManager.addBeliefEdge({ fromBeliefId: 'other1', toBeliefId: b1.id, type: 'supports', weight: 0.9 });
      stateManager.addBeliefEdge({ fromBeliefId: 'other2', toBeliefId: b1.id, type: 'supports', weight: 0.8 });

      const scoreWith = confidenceEngine.calculateConfidence(b1);
      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it('decreases score with contradiction edges', () => {
      const b1 = stateManager.addBelief({
        claim: 'Something is true',
        confidence: 0.8,
        source: { type: 'tool_result', toolName: 'shell_execute', actionId: 'a1' },
        status: 'active',
      });
      const scoreWithout = confidenceEngine.calculateConfidence(b1);

      stateManager.addBeliefEdge({ fromBeliefId: b1.id, toBeliefId: 'other', type: 'contradicts', weight: 0.9 });

      const scoreWith = confidenceEngine.calculateConfidence(b1);
      expect(scoreWith).toBeLessThan(scoreWithout);
    });
  });

  describe('computeFactors', () => {
    it('returns all factor fields', () => {
      const belief = stateManager.addBelief({
        claim: 'Test claim',
        confidence: 0.7,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'a1' },
        status: 'active',
      });
      const factors = confidenceEngine.computeFactors(belief);
      expect(factors).toHaveProperty('sourceReliability');
      expect(factors).toHaveProperty('agreementScore');
      expect(factors).toHaveProperty('verificationBonus');
      expect(factors).toHaveProperty('ambiguityPenalty');
      expect(factors).toHaveProperty('contradictionPenalty');
      expect(factors).toHaveProperty('noveltyPenalty');
    });
  });

  describe('recalibrateAll', () => {
    it('updates confidence on all active beliefs', () => {
      stateManager.addBelief({
        claim: 'Belief one',
        confidence: 0.5,
        source: { type: 'tool_result', toolName: 'file_read', actionId: 'a1' },
        status: 'active',
      });
      stateManager.addBelief({
        claim: 'Belief two',
        confidence: 0.5,
        source: { type: 'tool_result', toolName: 'file_write', actionId: 'a2' },
        status: 'active',
      });

      confidenceEngine.recalibrateAll();

      // After recalibration, confidence should be recalculated (may differ from 0.5)
      const beliefs = stateManager.getBeliefs();
      expect(beliefs).toHaveLength(2);
      // Each belief should have been processed (confidence may or may not change)
      for (const b of beliefs) {
        expect(typeof b.confidence).toBe('number');
      }
    });
  });

  describe('with ToolDescriptorRegistry', () => {
    it('uses tool descriptor reliability for source reliability', () => {
      const toolDescs = new ToolDescriptorRegistry();
      toolDescs.register({
        name: 'custom_tool',
        category: 'api',
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        preconditions: [],
        postconditions: [],
        commonFailureModes: [],
        validationMethods: [],
        avgLatencyMs: 100,
        avgReliability: 0.5, // Low reliability tool
        avgCost: 0,
        safeForAutonomousUse: true,
      });

      const ceWithDescs = new ConfidenceEngine(stateManager, memoryStore, toolDescs);
      const belief = stateManager.addBelief({
        claim: 'API returned data',
        confidence: 0.9,
        source: { type: 'tool_result', toolName: 'custom_tool', actionId: 'a1' },
        status: 'active',
      });

      const factors = ceWithDescs.computeFactors(belief);
      // Source reliability should reflect the tool descriptor's low reliability
      expect(factors.sourceReliability).toBe(0.5);
    });
  });
});
