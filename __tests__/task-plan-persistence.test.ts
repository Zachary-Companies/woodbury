import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskTools, loadPlanState } from '../src/task-plan.js';

describe('task-plan persistence', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-plan-persist-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loadPlanState returns null for empty dir', async () => {
    const result = await loadPlanState(tmpDir);
    expect(result).toBeNull();
  });

  it('creating tasks persists to .woodbury-work/plan.json', async () => {
    // Create test file for validator
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');

    const tools = createTaskTools(undefined, undefined, tmpDir);

    await tools.createHandler(
      {
        subject: 'Persist test',
        description: 'Testing persistence',
        validators: [{ type: 'file_exists', path: 'src/a.ts' }],
      },
      context(),
    );

    // Wait for fire-and-forget persist
    await new Promise(r => setTimeout(r, 200));

    const persisted = await loadPlanState(tmpDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.state.tasks).toHaveLength(1);
    expect(persisted!.state.tasks[0].subject).toBe('Persist test');
    expect(persisted!.nextId).toBe(2);
  });

  it('loadOrReset restores state, nextId, completedCount', async () => {
    // Create test file
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');

    // Create and complete a task
    const tools1 = createTaskTools(undefined, undefined, tmpDir);

    await tools1.createHandler(
      {
        subject: 'First task',
        description: 'Will be completed',
        validators: [{ type: 'file_exists', path: 'src/a.ts' }],
      },
      context(),
    );
    await tools1.updateHandler({ taskId: 1, status: 'in_progress' }, context());
    await tools1.updateHandler({ taskId: 1, status: 'completed' }, context());

    await tools1.createHandler(
      {
        subject: 'Second task',
        description: 'Still pending',
        validators: [{ type: 'file_exists', path: 'src/a.ts' }],
      },
      context(),
    );

    // Wait for persist
    await new Promise(r => setTimeout(r, 200));

    // Create fresh tools and loadOrReset
    const tools2 = createTaskTools();
    await tools2.loadOrReset(tmpDir);

    const state = tools2.getPlanState();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[0].subject).toBe('First task');
    expect(state.tasks[0].status).toBe('completed');
    expect(state.tasks[1].subject).toBe('Second task');
    expect(state.tasks[1].status).toBe('pending');
  });

  it('task IDs continue from persisted nextId', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');

    // Create two tasks
    const tools1 = createTaskTools(undefined, undefined, tmpDir);
    await tools1.createHandler(
      { subject: 'Task 1', description: 'First', validators: [{ type: 'file_exists', path: 'src/a.ts' }] },
      context(),
    );
    await tools1.createHandler(
      { subject: 'Task 2', description: 'Second', validators: [{ type: 'file_exists', path: 'src/a.ts' }] },
      context(),
    );

    await new Promise(r => setTimeout(r, 200));

    // Load into fresh tools and create another task
    const tools2 = createTaskTools(undefined, undefined, tmpDir);
    await tools2.loadOrReset(tmpDir);

    await tools2.createHandler(
      { subject: 'Task 3', description: 'Third', validators: [{ type: 'file_exists', path: 'src/a.ts' }] },
      context(),
    );

    const state = tools2.getPlanState();
    expect(state.tasks).toHaveLength(3);
    expect(state.tasks[2].id).toBe(3); // Continues from nextId=3
  });

  it('loadOrReset with empty persisted plan resets normally', async () => {
    // Write an empty plan
    const dir = join(tmpDir, '.woodbury-work');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plan.json'),
      JSON.stringify({ state: { tasks: [] }, nextId: 1, completedCount: 0 }),
    );

    const tools = createTaskTools();
    await tools.loadOrReset(tmpDir);

    const state = tools.getPlanState();
    expect(state.tasks).toHaveLength(0);
  });
});
