/**
 * Integration tests for the wiring logic in agent-factory.ts.
 *
 * These tests replicate the callback patterns used in createAgent() to verify:
 * 1. Auto memory capture on task completion (onTaskCompleted callback)
 * 2. Auto memory capture on reflection (onReflection callback)
 * 3. Snapshot injection into the reflect tool (getSnapshots provider)
 * 4. Per-step budget enforcement (trackToolCall)
 * 5. Meta tool exemption from budget tracking (isXxxTool guards)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskTools } from '../src/task-plan.js';
import type { PlanState } from '../src/task-plan.js';
import { createReflectTools } from '../src/reflection.js';
import { createMemoryTools, loadMemories } from '../src/memory.js';
import type { MemoryToolsHandle } from '../src/memory.js';
import { SnapshotBuffer, createSnapshot } from '../src/state-snapshot.js';
import { isTaskTool } from '../src/task-plan.js';
import { isQueueTool } from '../src/work-queue.js';
import { isDelegateTool } from '../src/subagent.js';
import { isGoalTool } from '../src/goal-contract.js';
import { isReflectTool } from '../src/reflection.js';
import { isMemoryTool } from '../src/memory.js';
import { isRiskTool } from '../src/risk-gate.js';
import { ToolCache, isMutation } from '../src/tool-cache.js';
import { AuditLog } from '../src/run-audit.js';
import { looksLikeError } from '../src/error-memory.js';

// ── Auto memory on task completion ──────────────────────────

describe('wiring: auto memory on task completion', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-task-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves memory when a task passes validation and completes', async () => {
    const memoryTools = createMemoryTools();
    let memoryToolsRef: MemoryToolsHandle | null = null;

    // Same wiring as agent-factory.ts: onTaskCompleted → saveMemoryDirect
    const taskTools = createTaskTools(
      undefined,
      (task, _report) => {
        if (memoryToolsRef) {
          const content = `Completed: ${task.subject}`;
          memoryToolsRef.saveMemoryDirect(
            tmpDir,
            content,
            'discovery',
            ['auto-capture', 'task-completion'],
          ).catch(() => {});
        }
      },
    );

    // Late-binding (same as agent-factory)
    memoryToolsRef = memoryTools;

    // Create a file so the validator passes
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'test.ts'), 'export const x = 1;');

    await taskTools.createHandler(
      {
        subject: 'Write test module',
        description: 'Create test.ts',
        validators: [{ type: 'file_exists', path: 'src/test.ts' }],
      },
      context(),
    );

    await taskTools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    const result = await taskTools.updateHandler({ taskId: 1, status: 'completed' }, context());

    expect(result).toContain('all validators passed');

    // Wait for fire-and-forget saveMemoryDirect to flush
    await new Promise(r => setTimeout(r, 150));

    const memories = await loadMemories(tmpDir);
    expect(memories.length).toBeGreaterThanOrEqual(1);

    const autoMem = memories.find(m => m.content === 'Completed: Write test module');
    expect(autoMem).toBeDefined();
    expect(autoMem!.category).toBe('discovery');
    expect(autoMem!.tags).toContain('auto-capture');
    expect(autoMem!.tags).toContain('task-completion');
  });

  it('does not save memory when validation fails', async () => {
    const memoryTools = createMemoryTools();
    let memoryToolsRef: MemoryToolsHandle | null = null;

    const taskTools = createTaskTools(
      undefined,
      (task, _report) => {
        if (memoryToolsRef) {
          memoryToolsRef.saveMemoryDirect(
            tmpDir,
            `Completed: ${task.subject}`,
            'discovery',
            ['auto-capture', 'task-completion'],
          ).catch(() => {});
        }
      },
    );

    memoryToolsRef = memoryTools;

    // No file exists, so file_exists validator will fail
    await taskTools.createHandler(
      {
        subject: 'Missing file task',
        description: 'Will fail validation',
        validators: [{ type: 'file_exists', path: 'nonexistent.ts' }],
      },
      context(),
    );

    await taskTools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    const result = await taskTools.updateHandler({ taskId: 1, status: 'completed' }, context());

    expect(result).toContain('validation failed');

    await new Promise(r => setTimeout(r, 150));

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(0);
  });
});

// ── Auto memory on reflection ───────────────────────────────

describe('wiring: auto memory on reflection', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-reflect-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves memory when reflection is recorded', async () => {
    const memoryTools = createMemoryTools();
    let memoryToolsRef: MemoryToolsHandle | null = null;

    const emptyPlanState: PlanState = { tasks: [] };

    // Same wiring as agent-factory.ts: onReflection → saveMemoryDirect
    const reflectTools = createReflectTools(
      () => emptyPlanState,
      undefined,
      (reflection) => {
        if (memoryToolsRef) {
          const content = reflection.assessment.slice(0, 500);
          memoryToolsRef.saveMemoryDirect(
            tmpDir,
            content,
            'discovery',
            ['auto-capture', 'reflection'],
          ).catch(() => {});
        }
      },
    );

    memoryToolsRef = memoryTools;

    await reflectTools.reflectHandler(
      { assessment: 'Tests are passing, implementation looks solid' },
      context(),
    );

    // Wait for fire-and-forget
    await new Promise(r => setTimeout(r, 150));

    const memories = await loadMemories(tmpDir);
    expect(memories.length).toBeGreaterThanOrEqual(1);

    const autoMem = memories.find(m => m.content === 'Tests are passing, implementation looks solid');
    expect(autoMem).toBeDefined();
    expect(autoMem!.tags).toContain('auto-capture');
    expect(autoMem!.tags).toContain('reflection');
  });

  it('truncates long assessments to 500 chars', async () => {
    const memoryTools = createMemoryTools();
    let memoryToolsRef: MemoryToolsHandle | null = null;

    const emptyPlanState: PlanState = { tasks: [] };

    const reflectTools = createReflectTools(
      () => emptyPlanState,
      undefined,
      (reflection) => {
        if (memoryToolsRef) {
          const content = reflection.assessment.slice(0, 500);
          memoryToolsRef.saveMemoryDirect(
            tmpDir,
            content,
            'discovery',
            ['auto-capture', 'reflection'],
          ).catch(() => {});
        }
      },
    );

    memoryToolsRef = memoryTools;

    const longAssessment = 'A'.repeat(1000);
    await reflectTools.reflectHandler(
      { assessment: longAssessment },
      context(),
    );

    await new Promise(r => setTimeout(r, 150));

    const memories = await loadMemories(tmpDir);
    expect(memories).toHaveLength(1);
    expect(memories[0].content.length).toBe(500);
  });
});

// ── Snapshot injection into reflect ─────────────────────────

describe('wiring: snapshot buffer → reflect', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-snap-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reflect output includes Recent Activity from snapshot buffer', async () => {
    const snapshotBuffer = new SnapshotBuffer(tmpDir);

    // Simulate tool calls producing snapshots
    snapshotBuffer.push(createSnapshot('file_write', { path: 'src/index.ts', content: '...' }, 'ok'));
    snapshotBuffer.push(createSnapshot('shell_execute', { command: 'npm test' }, 'All tests passed\nexit code: 0'));
    snapshotBuffer.push(createSnapshot('grep', { pattern: 'TODO', path: 'src/' }, '3 matches'));

    const emptyPlanState: PlanState = { tasks: [] };

    // Same wiring as agent-factory: getSnapshots returns from buffer
    const reflectTools = createReflectTools(
      () => emptyPlanState,
      undefined,
      undefined,
      () => snapshotBuffer.getRecent(),
    );

    const result = await reflectTools.reflectHandler(
      { assessment: 'Checking snapshot injection' },
      context(),
    );

    expect(result).toContain('## Recent Activity');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('npm test');
    expect(result).toContain('TODO');
  });

  it('reflect omits Recent Activity when buffer is empty', async () => {
    const snapshotBuffer = new SnapshotBuffer(tmpDir);

    const emptyPlanState: PlanState = { tasks: [] };

    const reflectTools = createReflectTools(
      () => emptyPlanState,
      undefined,
      undefined,
      () => snapshotBuffer.getRecent(),
    );

    const result = await reflectTools.reflectHandler(
      { assessment: 'Nothing happened yet' },
      context(),
    );

    expect(result).not.toContain('## Recent Activity');
  });
});

// ── Per-step budget enforcement ─────────────────────────────

describe('wiring: per-step tool call budget', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-budget-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns not blocked when no task is in progress', () => {
    const taskTools = createTaskTools();
    const result = taskTools.trackToolCall();
    expect(result.blocked).toBe(false);
    expect(result.taskId).toBeUndefined();
  });

  it('increments toolCallsUsed on each trackToolCall', async () => {
    const taskTools = createTaskTools();

    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'x.ts'), 'export const x = 1;');

    await taskTools.createHandler(
      {
        subject: 'Budget test',
        description: 'Testing budget',
        validators: [{ type: 'file_exists', path: 'src/x.ts' }],
        toolCallBudget: 10,
      },
      context(),
    );
    await taskTools.updateHandler({ taskId: 1, status: 'in_progress' }, context());

    taskTools.trackToolCall();
    taskTools.trackToolCall();
    taskTools.trackToolCall();

    const state = taskTools.getPlanState();
    expect(state.tasks[0].toolCallsUsed).toBe(3);
    expect(state.tasks[0].status).toBe('in_progress');
  });

  it('auto-blocks task when budget is exhausted', async () => {
    const taskTools = createTaskTools();

    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'x.ts'), 'export const x = 1;');

    await taskTools.createHandler(
      {
        subject: 'Tiny budget',
        description: 'Will auto-block',
        validators: [{ type: 'file_exists', path: 'src/x.ts' }],
        toolCallBudget: 3,
      },
      context(),
    );
    await taskTools.updateHandler({ taskId: 1, status: 'in_progress' }, context());

    expect(taskTools.trackToolCall().blocked).toBe(false); // call 1
    expect(taskTools.trackToolCall().blocked).toBe(false); // call 2

    const result = taskTools.trackToolCall(); // call 3 = budget
    expect(result.blocked).toBe(true);
    expect(result.taskId).toBe(1);
    expect(result.message).toContain('budget exhausted');

    const state = taskTools.getPlanState();
    const task = state.tasks[0];
    expect(task.status).toBe('blocked');
    expect(task.toolCallsUsed).toBe(3);
    expect(task.blockedReason).toContain('budget');
  });

  it('shows budget in task_list when toolCallsUsed > 0', async () => {
    const taskTools = createTaskTools();

    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'x.ts'), 'export const x = 1;');

    await taskTools.createHandler(
      {
        subject: 'Listed task',
        description: 'Check list output',
        validators: [{ type: 'file_exists', path: 'src/x.ts' }],
        toolCallBudget: 20,
      },
      context(),
    );
    await taskTools.updateHandler({ taskId: 1, status: 'in_progress' }, context());

    taskTools.trackToolCall();
    taskTools.trackToolCall();

    const list = await taskTools.listHandler({}, context());
    expect(list).toContain('(calls: 2/20)');
  });

  it('shows budget in task_get', async () => {
    const taskTools = createTaskTools();

    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'x.ts'), 'export const x = 1;');

    await taskTools.createHandler(
      {
        subject: 'Get task',
        description: 'Check get output',
        validators: [{ type: 'file_exists', path: 'src/x.ts' }],
        toolCallBudget: 25,
      },
      context(),
    );

    const detail = await taskTools.getHandler({ taskId: 1 }, context());
    expect(detail).toContain('Tool calls: 0/25');
  });
});

// ── Meta tool exemption (isXxxTool guards) ──────────────────

describe('wiring: meta tool exemption from budget', () => {
  it('identifies task tools', () => {
    expect(isTaskTool('task_create')).toBe(true);
    expect(isTaskTool('task_update')).toBe(true);
    expect(isTaskTool('task_list')).toBe(true);
    expect(isTaskTool('task_get')).toBe(true);
    expect(isTaskTool('file_write')).toBe(false);
  });

  it('identifies queue tools', () => {
    expect(isQueueTool('queue_init')).toBe(true);
    expect(isQueueTool('queue_add_items')).toBe(true);
    expect(isQueueTool('queue_next')).toBe(true);
    expect(isQueueTool('queue_done')).toBe(true);
    expect(isQueueTool('queue_status')).toBe(true);
    expect(isQueueTool('shell_execute')).toBe(false);
  });

  it('identifies delegate tool', () => {
    expect(isDelegateTool('delegate')).toBe(true);
    expect(isDelegateTool('file_read')).toBe(false);
  });

  it('identifies goal tool', () => {
    expect(isGoalTool('goal_contract')).toBe(true);
    expect(isGoalTool('grep')).toBe(false);
  });

  it('identifies reflect tool', () => {
    expect(isReflectTool('reflect')).toBe(true);
    expect(isReflectTool('git')).toBe(false);
  });

  it('identifies memory tools', () => {
    expect(isMemoryTool('memory_save')).toBe(true);
    expect(isMemoryTool('memory_recall')).toBe(true);
    expect(isMemoryTool('file_search')).toBe(false);
  });

  it('identifies risk tool', () => {
    expect(isRiskTool('preflight_check')).toBe(true);
    expect(isRiskTool('web_fetch')).toBe(false);
  });

  it('non-meta tools are not matched by any guard', () => {
    const nonMetaTools = [
      'file_read', 'file_write', 'shell_execute', 'git',
      'grep', 'file_search', 'list_directory', 'code_execute',
      'test_runner', 'web_fetch', 'web_crawl', 'google_search',
      'database_query', 'web_crawl_rendered',
    ];

    for (const tool of nonMetaTools) {
      const isMetaTool = isTaskTool(tool) || isQueueTool(tool) || isDelegateTool(tool)
        || isGoalTool(tool) || isReflectTool(tool) || isMemoryTool(tool) || isRiskTool(tool);
      expect(isMetaTool).toBe(false);
    }
  });
});

// ── Snapshot buffer end-to-end ──────────────────────────────

describe('wiring: snapshot buffer lifecycle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-buf-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('createSnapshot produces correct summaries for common tools', () => {
    const fw = createSnapshot('file_write', { path: 'src/a.ts', content: '...' }, 'ok');
    expect(fw.summary).toBe('Wrote file: src/a.ts');
    expect(fw.artifacts).toEqual(['src/a.ts']);

    const fr = createSnapshot('file_read', { path: 'src/b.ts' }, 'content...');
    expect(fr.summary).toBe('Read file: src/b.ts');

    const sh = createSnapshot('shell_execute', { command: 'npm install' }, 'done\nexit code: 0');
    expect(sh.summary).toBe('Shell: npm install');
    expect(sh.exitStatus).toBe(0);

    const gt = createSnapshot('git', { subcommand: 'status' }, 'clean');
    expect(gt.summary).toBe('Git: status');

    const gp = createSnapshot('grep', { pattern: 'TODO', path: 'src/' }, 'matches');
    expect(gp.summary).toContain('TODO');
  });

  it('buffer persists and reloads from disk', async () => {
    const buffer1 = new SnapshotBuffer(tmpDir);
    buffer1.push(createSnapshot('file_write', { path: 'a.ts' }, 'ok'));
    buffer1.push(createSnapshot('shell_execute', { command: 'npm test' }, 'pass'));

    // Wait for persist
    await new Promise(r => setTimeout(r, 200));

    // New buffer loads from disk
    const buffer2 = new SnapshotBuffer(tmpDir);
    await buffer2.load();

    const recent = buffer2.getRecent();
    expect(recent).toHaveLength(2);
    expect(recent[0].summary).toContain('a.ts');
    expect(recent[1].summary).toContain('npm test');
  });

  it('getRecentSnapshots returns data through the buffer', () => {
    // Simulates agent-factory's getRecentSnapshots: () => snapshotBuffer.getRecent()
    const buffer = new SnapshotBuffer(tmpDir);

    buffer.push(createSnapshot('file_write', { path: 'x.ts' }, 'ok'));
    buffer.push(createSnapshot('file_write', { path: 'y.ts' }, 'ok'));
    buffer.push(createSnapshot('file_write', { path: 'z.ts' }, 'ok'));

    const getRecentSnapshots = () => buffer.getRecent();

    const snapshots = getRecentSnapshots();
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2].summary).toContain('z.ts');
  });
});

// ── Cache invalidation on mutation tools ─────────────────

describe('wiring: cache invalidation on mutation tools', () => {
  it('isMutation correctly identifies mutation tools', () => {
    expect(isMutation('file_write')).toBe(true);
    expect(isMutation('shell_execute')).toBe(true);
    expect(isMutation('code_execute')).toBe(true);
    expect(isMutation('git')).toBe(true);
    expect(isMutation('database_query')).toBe(true);
    expect(isMutation('test_runner')).toBe(true);
    expect(isMutation('file_read')).toBe(false);
    expect(isMutation('grep')).toBe(false);
  });

  it('cache invalidation clears relevant entries on file_write', () => {
    const cache = new ToolCache(100);
    cache.set('file_read', { path: 'src/a.ts' }, 'content-a');
    cache.set('file_read', { path: 'src/b.ts' }, 'content-b');

    // Simulate what agent-factory does in onToolCall
    if (isMutation('file_write')) {
      cache.invalidateFor('file_write', { path: 'src/a.ts' });
    }

    expect(cache.get('file_read', { path: 'src/a.ts' })).toBeUndefined();
    expect(cache.get('file_read', { path: 'src/b.ts' })).toBe('content-b');
  });

  it('shell_execute clears entire cache', () => {
    const cache = new ToolCache(100);
    cache.set('file_read', { path: 'a.ts' }, 'a');
    cache.set('grep', { pattern: 'TODO' }, 'results');

    if (isMutation('shell_execute')) {
      cache.invalidateFor('shell_execute', { command: 'npm install' });
    }

    expect(cache.size).toBe(0);
  });
});

// ── Audit recording for tool calls ───────────────────────

describe('wiring: audit recording for tool calls', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-af-audit-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('audit log records tool calls with correct structure', () => {
    const auditLog = new AuditLog(tmpDir);
    auditLog.newRun();

    // Simulate what agent-factory does in onToolCall
    const resultStr = 'file contents here';
    const isError = looksLikeError(resultStr);
    auditLog.record('file_read', { path: 'test.ts' }, resultStr, 42, isError);

    const entries = auditLog.getRunEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('file_read');
    expect(entries[0].executionTimeMs).toBe(42);
    expect(entries[0].status).toBe('success');
  });

  it('audit log records errors correctly', () => {
    const auditLog = new AuditLog(tmpDir);
    auditLog.newRun();

    const resultStr = 'Error: ENOENT file not found';
    const isError = looksLikeError(resultStr);
    auditLog.record('file_read', { path: 'missing.ts' }, resultStr, 5, isError);

    const entries = auditLog.getRunEntries();
    expect(entries[0].status).toBe('error');
  });
});

// ── Budget tracking does not affect non-budgeted runs ────

describe('wiring: budget tracking for non-budgeted runs', () => {
  it('no budget enforcement when maxTokenBudget is undefined', () => {
    // Simulates the agent-factory check:
    // if (config.maxTokenBudget && budgetController && !budgetExceeded) { ... }
    const maxTokenBudget: number | undefined = undefined;
    let budgetExceeded = false;

    if (maxTokenBudget && !budgetExceeded) {
      budgetExceeded = true; // This should NOT execute
    }

    expect(budgetExceeded).toBe(false);
  });

  it('budget enforcement triggers when tokens exceed limit', () => {
    const maxTokenBudget = 1000;
    let budgetExceeded = false;
    const totalTokens = 1500;

    if (maxTokenBudget && !budgetExceeded) {
      if (totalTokens > maxTokenBudget) {
        budgetExceeded = true;
      }
    }

    expect(budgetExceeded).toBe(true);
  });
});
