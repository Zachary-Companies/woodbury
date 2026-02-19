import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskTools } from '../src/task-plan.js';
import type { PlanTask } from '../src/task-plan.js';

// Minimal validator that always passes: file_exists on a known file
async function setupTestFile(dir: string): Promise<string> {
  const filePath = join(dir, 'exists.txt');
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, 'hello', 'utf-8');
  return filePath;
}

describe('task-plan: per-step budgets', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-task-'));
    await setupTestFile(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a task with default toolCallBudget of 50', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Test task',
        description: 'A task',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
      },
      context(),
    );
    const state = tools.getPlanState();
    expect(state.tasks[0].toolCallBudget).toBe(50);
    expect(state.tasks[0].toolCallsUsed).toBe(0);
  });

  it('creates a task with custom toolCallBudget', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Small task',
        description: 'Quick fix',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
        toolCallBudget: 5,
      },
      context(),
    );
    const state = tools.getPlanState();
    expect(state.tasks[0].toolCallBudget).toBe(5);
  });

  it('trackToolCall increments counter on in_progress task', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Active task',
        description: 'Working on it',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());

    const result = tools.trackToolCall();
    expect(result.blocked).toBe(false);
    expect(result.taskId).toBe(1);

    const state = tools.getPlanState();
    expect(state.tasks[0].toolCallsUsed).toBe(1);
  });

  it('trackToolCall returns blocked=false when no in_progress task', () => {
    const tools = createTaskTools();
    const result = tools.trackToolCall();
    expect(result.blocked).toBe(false);
    expect(result.taskId).toBeUndefined();
  });

  it('auto-blocks task when budget exhausted', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Tiny budget',
        description: 'Only 3 calls',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
        toolCallBudget: 3,
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());

    // Make 3 tool calls — third one should trigger the block
    tools.trackToolCall(); // 1/3
    tools.trackToolCall(); // 2/3
    const third = tools.trackToolCall(); // 3/3 → blocked

    expect(third.blocked).toBe(true);
    expect(third.taskId).toBe(1);
    expect(third.message).toContain('budget exhausted');
    expect(third.message).toContain('3/3');

    const state = tools.getPlanState();
    expect(state.tasks[0].status).toBe('blocked');
    expect(state.tasks[0].blockedReason).toContain('budget');
  });

  it('task_list shows budget usage', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Budget task',
        description: 'Test',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
        toolCallBudget: 10,
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    tools.trackToolCall();
    tools.trackToolCall();
    tools.trackToolCall();

    const listResult = await tools.listHandler({}, context());
    expect(listResult).toContain('(calls: 3/10)');
  });

  it('task_get shows tool call budget', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Get test',
        description: 'Test',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
        toolCallBudget: 20,
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    tools.trackToolCall();

    const getResult = await tools.getHandler({ taskId: 1 }, context());
    expect(getResult).toContain('Tool calls: 1/20');
  });

  it('does not show budget in list when toolCallsUsed is 0', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Unused budget',
        description: 'Test',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
      },
      context(),
    );
    const listResult = await tools.listHandler({}, context());
    expect(listResult).not.toContain('(calls:');
  });
});

describe('task-plan: onTaskCompleted callback', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-task-cb-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calls onTaskCompleted when validators pass', async () => {
    const filePath = await setupTestFile(tmpDir);
    const onCompleted = vi.fn();
    const tools = createTaskTools(undefined, onCompleted);

    await tools.createHandler(
      {
        subject: 'Complete me',
        description: 'Test callback',
        validators: [{ type: 'file_exists', path: filePath }],
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    await tools.updateHandler({ taskId: 1, status: 'completed' }, context());

    expect(onCompleted).toHaveBeenCalledOnce();
    const [task, report] = onCompleted.mock.calls[0] as [PlanTask, string];
    expect(task.subject).toBe('Complete me');
    expect(task.status).toBe('completed');
    expect(report).toContain('File exists');
  });

  it('does not call onTaskCompleted when validation fails', async () => {
    const onCompleted = vi.fn();
    const tools = createTaskTools(undefined, onCompleted);

    await tools.createHandler(
      {
        subject: 'Will fail',
        description: 'Missing file',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'nonexistent.txt') }],
      },
      context(),
    );
    await tools.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    await tools.updateHandler({ taskId: 1, status: 'completed' }, context());

    expect(onCompleted).not.toHaveBeenCalled();
  });
});

describe('task-plan: basic operations', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-task-basic-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects task creation without validators', async () => {
    const tools = createTaskTools();
    const result = await tools.createHandler(
      { subject: 'No validators', description: 'Test', validators: [] },
      context(),
    );
    expect(result).toContain('Error');
    expect(result).toContain('validator');
  });

  it('rejects task creation without subject', async () => {
    const tools = createTaskTools();
    const result = await tools.createHandler(
      { subject: '', description: 'Test', validators: [{ type: 'file_exists', path: 'a.txt' }] },
      context(),
    );
    expect(result).toContain('Error');
  });

  it('resets plan state', async () => {
    const tools = createTaskTools();
    const filePath = await setupTestFile(tmpDir);
    await tools.createHandler(
      { subject: 'A', description: 'B', validators: [{ type: 'file_exists', path: filePath }] },
      context(),
    );
    expect(tools.getPlanState().tasks).toHaveLength(1);

    tools.resetPlan();
    expect(tools.getPlanState().tasks).toHaveLength(0);
  });

  it('ignores invalid toolCallBudget values', async () => {
    const tools = createTaskTools();
    await tools.createHandler(
      {
        subject: 'Bad budget',
        description: 'Test',
        validators: [{ type: 'file_exists', path: join(tmpDir, 'exists.txt') }],
        toolCallBudget: -5,
      },
      context(),
    );
    const state = tools.getPlanState();
    expect(state.tasks[0].toolCallBudget).toBe(50); // Falls back to default
  });
});
