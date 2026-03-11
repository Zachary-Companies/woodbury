/**
 * Unit tests for Closure Engine V3 — ActionSelector
 */
import { describe, it, expect } from '@jest/globals';
import { ActionSelector } from '../loop/v3/action-selector.js';
import type { TaskNode, Belief } from '../loop/v3/types.js';

// ── Helpers ─────────────────────────────────────────────────

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

const makeBelief = (overrides?: Partial<Belief>): Belief => ({
  id: 'b1',
  claim: 'some claim',
  source: { type: 'inference' as const, derivedFrom: [] },
  confidence: 0.8,
  evidenceIds: [],
  status: 'active',
  createdAt: new Date().toISOString(),
  ...overrides,
});

// ── Tests ───────────────────────────────────────────────────

describe('ActionSelector', () => {
  const selector = new ActionSelector();

  it('returns null for empty task list', () => {
    expect(selector.selectNext([], [])).toBeNull();
  });

  it('returns the only task when one task', () => {
    const task = makeTask({ id: 't1' });
    expect(selector.selectNext([task], [])).toBe(task);
  });

  it('prefers task that unblocks more downstream tasks', () => {
    const blocker = makeTask({ id: 'blocker', blocks: ['d1', 'd2', 'd3'] });
    const leaf = makeTask({ id: 'leaf', blocks: [] });
    const downstream = [
      makeTask({ id: 'd1', status: 'pending', dependsOn: ['blocker'] }),
      makeTask({ id: 'd2', status: 'pending', dependsOn: ['blocker'] }),
      makeTask({ id: 'd3', status: 'pending', dependsOn: ['blocker'] }),
    ];

    const result = selector.selectNext([blocker, leaf], [], [blocker, leaf, ...downstream]);
    expect(result!.id).toBe('blocker');
  });

  it('prefers task with more validators (higher info gain)', () => {
    const validatedTask = makeTask({
      id: 'validated',
      validators: [
        { type: 'file_exists', path: 'a.ts' },
        { type: 'file_contains', path: 'a.ts', pattern: 'export' },
        { type: 'command_succeeds', command: 'tsc' },
      ],
    });
    const bareTask = makeTask({ id: 'bare', validators: [] });

    const result = selector.selectNext([bareTask, validatedTask], []);
    expect(result!.id).toBe('validated');
  });

  it('prefers lower risk tasks', () => {
    const lowRisk = makeTask({ id: 'low', riskLevel: 'low' });
    const highRisk = makeTask({ id: 'high', riskLevel: 'critical' });

    // Both have same validators, blocks, etc — risk is the differentiator
    const result = selector.selectNext([highRisk, lowRisk], []);
    expect(result!.id).toBe('low');
  });

  it('prefers cheaper tasks', () => {
    const cheap = makeTask({ id: 'cheap', estimatedCost: 0.001 });
    const expensive = makeTask({ id: 'expensive', estimatedCost: 5.0 });

    const result = selector.selectNext([expensive, cheap], []);
    expect(result!.id).toBe('cheap');
  });

  it('confidence boost uses belief matching', () => {
    const dbTask = makeTask({ id: 'db', description: 'Migrate the database schema' });
    const unknownTask = makeTask({ id: 'unknown', description: 'Perform xyzzy operation' });

    const beliefs: Belief[] = [
      makeBelief({ claim: 'Database is running PostgreSQL', confidence: 0.95 }),
      makeBelief({ claim: 'Database schema has users table', confidence: 0.90 }),
    ];

    const dbScore = selector.scoreTask(dbTask, beliefs, []);
    const unknownScore = selector.scoreTask(unknownTask, beliefs, []);

    expect(dbScore.confidenceBoost).toBeGreaterThan(unknownScore.confidenceBoost);
  });

  it('scoreTask returns all factor components', () => {
    const task = makeTask({
      validators: [{ type: 'file_exists', path: 'a.ts' }],
      riskLevel: 'medium',
      estimatedCost: 0.05,
    });
    const score = selector.scoreTask(task, [], [task]);

    expect(score).toHaveProperty('taskId');
    expect(score).toHaveProperty('total');
    expect(score).toHaveProperty('infoGain');
    expect(score).toHaveProperty('dependencyLeverage');
    expect(score).toHaveProperty('costPreference');
    expect(score).toHaveProperty('confidenceBoost');
    expect(score).toHaveProperty('riskPreference');
    expect(typeof score.total).toBe('number');
    expect(score.total).toBeGreaterThan(0);
  });

  it('total score is weighted combination of factors', () => {
    const task = makeTask({ validators: [] });
    const score = selector.scoreTask(task, [], [task]);

    const expected =
      score.infoGain * 0.25 +
      score.dependencyLeverage * 0.30 +
      score.costPreference * 0.15 +
      score.confidenceBoost * 0.15 +
      score.riskPreference * 0.15;

    expect(score.total).toBeCloseTo(expected, 5);
  });
});
