import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReflectTools, loadReflections } from '../src/reflection.js';
import type { Reflection } from '../src/reflection.js';
import type { PlanState } from '../src/task-plan.js';
import type { StateSnapshot } from '../src/state-snapshot.js';

const emptyPlanState: PlanState = { tasks: [] };

describe('reflection: onReflection callback', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-reflect-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calls onReflection after saving', async () => {
    const onReflection = vi.fn();
    const tools = createReflectTools(
      () => emptyPlanState,
      undefined,
      onReflection,
    );

    await tools.reflectHandler({ assessment: 'Making good progress' }, context());

    expect(onReflection).toHaveBeenCalledOnce();
    const reflection = onReflection.mock.calls[0][0] as Reflection;
    expect(reflection.assessment).toBe('Making good progress');
    expect(reflection.timestamp).toBeGreaterThan(0);
  });

  it('passes planChanges and assumptionsChanged to callback', async () => {
    const onReflection = vi.fn();
    const tools = createReflectTools(
      () => emptyPlanState,
      undefined,
      onReflection,
    );

    await tools.reflectHandler(
      {
        assessment: 'Need to adjust',
        planChanges: 'Add error handling step',
        assumptionsChanged: 'API requires auth',
      },
      context(),
    );

    const reflection = onReflection.mock.calls[0][0] as Reflection;
    expect(reflection.planChanges).toBe('Add error handling step');
    expect(reflection.assumptionsChanged).toBe('API requires auth');
  });

  it('still saves to disk when onReflection is provided', async () => {
    const tools = createReflectTools(
      () => emptyPlanState,
      undefined,
      vi.fn(),
    );

    await tools.reflectHandler({ assessment: 'Saved to disk' }, context());

    const reflections = await loadReflections(tmpDir);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].assessment).toBe('Saved to disk');
  });

  it('works without onReflection callback', async () => {
    const tools = createReflectTools(() => emptyPlanState);

    const result = await tools.reflectHandler({ assessment: 'No callback' }, context());
    expect(result).toContain('Reflection recorded');
  });
});

describe('reflection: snapshot injection', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-reflect-snap-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes Recent Activity section when snapshots are provided', async () => {
    const snapshots: StateSnapshot[] = [
      { timestamp: new Date('2025-01-15T10:00:00Z').getTime(), toolName: 'file_write', summary: 'Wrote file: src/a.ts' },
      { timestamp: new Date('2025-01-15T10:01:00Z').getTime(), toolName: 'shell_execute', summary: 'Shell: npm test', exitStatus: 0 },
    ];

    const tools = createReflectTools(
      () => emptyPlanState,
      undefined,
      undefined,
      () => snapshots,
    );

    const result = await tools.reflectHandler({ assessment: 'Check snapshots' }, context());
    expect(result).toContain('## Recent Activity');
    expect(result).toContain('Wrote file: src/a.ts');
    expect(result).toContain('Shell: npm test');
    expect(result).toContain('[exit=0]');
  });

  it('omits Recent Activity section when no snapshots', async () => {
    const tools = createReflectTools(
      () => emptyPlanState,
      undefined,
      undefined,
      () => [],
    );

    const result = await tools.reflectHandler({ assessment: 'No snapshots' }, context());
    expect(result).not.toContain('## Recent Activity');
  });

  it('omits Recent Activity section when getSnapshots is not provided', async () => {
    const tools = createReflectTools(() => emptyPlanState);

    const result = await tools.reflectHandler({ assessment: 'No getter' }, context());
    expect(result).not.toContain('## Recent Activity');
  });
});

describe('reflection: task progress context', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-reflect-tasks-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('shows task progress summary', async () => {
    const planState: PlanState = {
      tasks: [
        { id: 1, subject: 'Done', description: '', status: 'completed', blockedBy: [], blocks: [], validators: [], maxRetries: 3, retryCount: 0, failureHistory: [], toolCallBudget: 50, toolCallsUsed: 5 },
        { id: 2, subject: 'Working', description: '', status: 'in_progress', blockedBy: [], blocks: [], validators: [], maxRetries: 3, retryCount: 0, failureHistory: [], toolCallBudget: 50, toolCallsUsed: 2 },
        { id: 3, subject: 'Waiting', description: '', status: 'pending', blockedBy: [], blocks: [], validators: [], maxRetries: 3, retryCount: 0, failureHistory: [], toolCallBudget: 50, toolCallsUsed: 0 },
      ],
    };

    const tools = createReflectTools(() => planState);
    const result = await tools.reflectHandler({ assessment: 'Progress check' }, context());

    expect(result).toContain('Task Progress: 1/3 complete');
    expect(result).toContain('In progress');
    expect(result).toContain('Pending');
  });
});

describe('reflection: validation', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-reflect-val-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('requires assessment', async () => {
    const tools = createReflectTools(() => emptyPlanState);
    const result = await tools.reflectHandler({ assessment: '' }, context());
    expect(result).toContain('Error');
  });
});

describe('reflection: error context', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-reflect-err-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes recent errors when they exist', async () => {
    // Write a mock errors file
    const dir = join(tmpDir, '.woodbury-work');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'errors.json'), JSON.stringify([
      { id: 1, timestamp: Date.now(), toolName: 'shell_execute', paramsSummary: 'cmd=npm test', errorMessage: 'Tests failed' },
    ]), 'utf-8');

    const tools = createReflectTools(() => emptyPlanState);
    const result = await tools.reflectHandler({ assessment: 'Checking errors' }, context());
    expect(result).toContain('Recent Errors');
    expect(result).toContain('Tests failed');
  });
});
