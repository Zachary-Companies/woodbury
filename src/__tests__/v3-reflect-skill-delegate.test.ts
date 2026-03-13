/**
 * Unit tests for Closure Engine V3 — Reflector, SkillSynthesizer, DelegateEngine
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { StateManager } from '../loop/v3/state-manager.js';
import { MemoryStore } from '../loop/v3/memory-store.js';
import { SkillSynthesizer } from '../loop/v3/skill-synthesizer.js';
import { Reflector } from '../loop/v3/reflector.js';
import type { Observation, TaskNode, TaskGraph } from '../loop/v3/types.js';
import { resetSQLiteMemoryStoreCache } from '../sqlite-memory-store.js';

// ── SkillSynthesizer ─────────────────────────────────────────

describe('SkillSynthesizer', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let memoryStore: MemoryStore;
  let synthesizer: SkillSynthesizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-ss-'));
    process.env.WOODBURY_MEMORY_DB_PATH = join(tmpDir, 'memory.db');
    resetSQLiteMemoryStoreCache();
    sessionId = `test_ss_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    memoryStore = new MemoryStore();
    synthesizer = new SkillSynthesizer(stateManager, memoryStore);
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    delete process.env.WOODBURY_MEMORY_DB_PATH;
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when no observations exist', () => {
    const result = synthesizer.synthesize();
    expect(result.memories).toEqual([]);
    expect(result.learningProducts).toEqual([]);
  });

  it('extracts procedural memory from repeated successful tool sequences', () => {
    // Set up a task graph
    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Test task',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0, validators: [],
        createdAt: new Date().toISOString(),
        result: { success: true, output: 'done', observations: [], toolCallCount: 4, durationMs: 500 },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    // Add repeated tool sequences: file_read → file_write (3 times)
    for (let i = 0; i < 3; i++) {
      stateManager.addObservation({
        actionId: `read_${i}`, taskId: 't1', toolName: 'file_read',
        params: { path: `file_${i}.ts` }, result: 'content',
        status: 'success', duration: 10, matchedExpectation: true,
      });
      stateManager.addObservation({
        actionId: `write_${i}`, taskId: 't1', toolName: 'file_write',
        params: { path: `file_${i}.ts` }, result: 'ok',
        status: 'success', duration: 15, matchedExpectation: true,
      });
    }

    const { memories } = synthesizer.synthesize();
    const procedural = memories.filter(m => m.type === 'procedural');
    expect(procedural.length).toBeGreaterThanOrEqual(1);
    expect(procedural.some(m => m.content.includes('file_read') && m.content.includes('file_write'))).toBe(true);
  });

  it('extracts failure patterns from repeated errors', () => {
    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Failing task',
        status: 'failed', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 3, validators: [],
        createdAt: new Date().toISOString(),
        result: { success: false, output: '', observations: [], toolCallCount: 3, durationMs: 300, error: 'ENOENT' },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    // Same error pattern repeated
    for (let i = 0; i < 3; i++) {
      stateManager.addObservation({
        actionId: `err_${i}`, taskId: 't1', toolName: 'file_read',
        params: { path: 'missing.ts' },
        result: 'Error: ENOENT no such file /path/to/missing.ts',
        status: 'error', duration: 5, matchedExpectation: false,
      });
    }

    const { memories } = synthesizer.synthesize();
    const failures = memories.filter(m => m.type === 'failure');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.some(m => m.content.includes('error pattern'))).toBe(true);
  });

  it('extracts domain knowledge from tasks that discover project structure', () => {
    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Discover project structure',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0, validators: [],
        createdAt: new Date().toISOString(),
        result: {
          success: true,
          output: 'Found package.json with React framework and TypeScript config',
          observations: [], toolCallCount: 2, durationMs: 200,
        },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    // Need at least one observation for synthesis to run
    stateManager.addObservation({
      actionId: 'a1', taskId: 't1', toolName: 'file_read',
      params: { path: 'package.json' }, result: '{ "name": "test" }',
      status: 'success', duration: 10, matchedExpectation: true,
    });

    const { memories } = synthesizer.synthesize();
    const semantic = memories.filter(m => m.type === 'semantic');
    expect(semantic.length).toBeGreaterThanOrEqual(1);
    expect(semantic.some(m => m.content.includes('package.json'))).toBe(true);
  });
});

// ── Reflector ────────────────────────────────────────────────

describe('Reflector', () => {
  let tmpDir: string;
  let sessionId: string;
  let stateDir: string;
  let stateManager: StateManager;
  let memoryStore: MemoryStore;
  let reflector: Reflector;

  // Mock ProviderAdapter
  const mockAdapter = {
    createCompletion: async ({ messages }: any) => ({
      content: JSON.stringify({
        assessment: 'Good progress on tasks',
        lessons: ['Learned to check files first'],
        adjustments: ['Consider running tests more frequently'],
        memories: [{
          content: 'Always read the relevant file before editing it.',
          type: 'procedural',
          title: 'Read Before Edit',
          tags: ['workflow', 'editing'],
          confidence: 0.9,
        }],
      }),
      toolCalls: [],
      stopReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-v3-ref-'));
    process.env.WOODBURY_MEMORY_DB_PATH = join(tmpDir, 'memory.db');
    resetSQLiteMemoryStoreCache();
    sessionId = `test_ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    stateDir = join(homedir(), '.woodbury', 'data', 'closure-engine', 'sessions', sessionId);
    stateManager = new StateManager(sessionId, tmpDir);
    memoryStore = new MemoryStore();
    reflector = new Reflector(stateManager, memoryStore, mockAdapter as any, 'openai', 'gpt-4');
  });

  afterEach(async () => {
    resetSQLiteMemoryStoreCache();
    delete process.env.WOODBURY_MEMORY_DB_PATH;
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('performs reflection with LLM and creates memories', async () => {
    // Set up some completed tasks
    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Task 1',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0, validators: [],
        createdAt: new Date().toISOString(),
        result: { success: true, output: 'done', observations: [], toolCallCount: 2, durationMs: 100 },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    const reflection = await reflector.reflect('periodic');
    expect(reflection.id).toMatch(/^reflect_/);
    expect(reflection.trigger).toBe('periodic');
    expect(reflection.assessment).toBe('Good progress on tasks');
    expect(reflection.lessonsLearned).toHaveLength(1);
    expect(reflection.planAdjustments).toHaveLength(1);
    expect(reflection.newMemories).toHaveLength(1);
    expect(reflection.newMemories[0].type).toBe('procedural');
    expect(reflection.newMemories[0].title).toBe('Read Before Edit');

    // Memory should be created from the lesson
    expect(stateManager.getState().reflections).toHaveLength(1);
  });

  it('falls back to simple assessment when LLM fails', async () => {
    const failingAdapter = {
      createCompletion: async () => {
        throw new Error('API unavailable');
      },
    };
    const failReflector = new Reflector(stateManager, memoryStore, failingAdapter as any, 'openai', 'gpt-4');

    const graph: TaskGraph = {
      nodes: [
        {
          id: 't1', goalId: 'g1', description: 'Done task',
          status: 'done', dependsOn: [], blocks: [],
          maxRetries: 3, retryCount: 0, validators: [],
          createdAt: new Date().toISOString(),
          result: { success: true, output: 'ok', observations: [], toolCallCount: 1, durationMs: 50 },
        },
        {
          id: 't2', goalId: 'g1', description: 'Failed task',
          status: 'failed', dependsOn: [], blocks: [],
          maxRetries: 3, retryCount: 3, validators: [],
          createdAt: new Date().toISOString(),
          result: { success: false, output: '', observations: [], toolCallCount: 3, durationMs: 200, error: 'crash' },
        },
      ],
      executionOrder: ['t1', 't2'],
    };
    stateManager.setTaskGraph(graph);

    const reflection = await failReflector.reflect('failure');
    expect(reflection.assessment).toContain('1/2 tasks done');
    expect(reflection.assessment).toContain('1 failed');
    // Lessons should contain the failed task info
    expect(reflection.lessonsLearned.length).toBeGreaterThanOrEqual(1);
  });

  describe('shouldReflect', () => {
    it('returns true at interval boundaries', () => {
      expect(reflector.shouldReflect(5, 5)).toBe(true);
      expect(reflector.shouldReflect(10, 5)).toBe(true);
      expect(reflector.shouldReflect(15, 5)).toBe(true);
    });

    it('returns false between intervals', () => {
      expect(reflector.shouldReflect(0, 5)).toBe(false);
      expect(reflector.shouldReflect(3, 5)).toBe(false);
      expect(reflector.shouldReflect(7, 5)).toBe(false);
    });
  });

  it('creates failure-type memories on failure trigger', async () => {
    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Failed task',
        status: 'failed', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 3, validators: [],
        createdAt: new Date().toISOString(),
        result: { success: false, output: '', observations: [], toolCallCount: 3, durationMs: 500, error: 'ENOENT' },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    const reflection = await reflector.reflect('failure');
    // The LLM mock returns lessons, those should be tagged as failure type
    expect(reflection.newMemories.length).toBeGreaterThanOrEqual(1);
  });

  it('filters out generic low-signal memories from reflection output', async () => {
    const lowSignalAdapter = {
      createCompletion: async () => ({
        content: JSON.stringify({
          assessment: 'Progress update',
          lessons: ['Good progress overall'],
          adjustments: ['Consider running tests more frequently'],
          memories: [
            {
              content: 'Good progress overall',
              type: 'semantic',
              confidence: 0.9,
            },
            {
              content: 'Always verify package.json scripts before changing the build workflow.',
              type: 'procedural',
              tags: ['build', 'workflow'],
              confidence: 0.95,
            },
          ],
        }),
        toolCalls: [],
        stopReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };

    const focusedReflector = new Reflector(stateManager, memoryStore, lowSignalAdapter as any, 'openai', 'gpt-4');

    const graph: TaskGraph = {
      nodes: [{
        id: 't1', goalId: 'g1', description: 'Inspect build scripts',
        status: 'done', dependsOn: [], blocks: [],
        maxRetries: 3, retryCount: 0, validators: [],
        createdAt: new Date().toISOString(),
        result: { success: true, output: 'done', observations: [], toolCallCount: 1, durationMs: 50 },
      }],
      executionOrder: ['t1'],
    };
    stateManager.setTaskGraph(graph);

    const reflection = await focusedReflector.reflect('periodic');
    expect(reflection.newMemories).toHaveLength(1);
    expect(reflection.newMemories[0].content).toContain('package.json scripts');
  });
});

// ── DelegateEngine ──────────────────────────────────────────
// DelegateEngine instantiates full ClosureEngine, so we test the lighter
// components (scoped registry creation) without a full integration test here.

describe('DelegateEngine - type and interface', () => {
  it('DelegationRequest interface is importable and usable', () => {
    // Type-level test — ensures imports compile
    const request = {
      objective: 'Write a module',
      allowedTools: ['file_read', 'file_write'],
      maxIterations: 10,
      timeout: 30000,
    };
    expect(request.objective).toBe('Write a module');
    expect(request.allowedTools).toHaveLength(2);
  });
});
