import {
  extractFollowUpInstructions,
  hasUnresolvedTasks,
  injectFollowUpTask,
  isContinuationRequest,
  isSummaryStyleRequest,
  resumeTaskGraph,
  selectDirectUserFacingTaskOutput,
  shouldResumeSession,
} from '../loop/v3/closure-engine';
import type { Goal, TaskGraph, TaskNode } from '../loop/v3/types';

function makeTaskGraph(): TaskGraph {
  return {
    executionOrder: ['t1', 't2', 't3', 't4', 't5'],
    nodes: [
      {
        id: 't1',
        goalId: 'g1',
        description: 'Completed task',
        status: 'done',
        dependsOn: [],
        blocks: [],
        maxRetries: 2,
        retryCount: 0,
        validators: [],
        createdAt: new Date().toISOString(),
      },
      {
        id: 't2',
        goalId: 'g1',
        description: 'Running task',
        status: 'running',
        dependsOn: [],
        blocks: [],
        maxRetries: 2,
        retryCount: 0,
        validators: [],
        createdAt: new Date().toISOString(),
      },
      {
        id: 't3',
        goalId: 'g1',
        description: 'Pending task',
        status: 'pending',
        dependsOn: [],
        blocks: [],
        maxRetries: 2,
        retryCount: 0,
        validators: [],
        createdAt: new Date().toISOString(),
      },
      {
        id: 't4',
        goalId: 'g1',
        description: 'Retryable failed task',
        status: 'failed',
        dependsOn: [],
        blocks: [],
        maxRetries: 3,
        retryCount: 1,
        validators: [],
        createdAt: new Date().toISOString(),
      },
      {
        id: 't5',
        goalId: 'g1',
        description: 'Exhausted failed task',
        status: 'failed',
        dependsOn: [],
        blocks: [],
        maxRetries: 1,
        retryCount: 1,
        validators: [],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function makeGoal(): Goal {
  return {
    id: 'g1',
    objective: 'Build and update a social pipeline',
    successCriteria: [],
    constraints: [],
    forbiddenActions: [],
    priority: 'normal',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('closure engine continuation helpers', () => {
  it('detects unresolved work in a persisted task graph', () => {
    expect(hasUnresolvedTasks(makeTaskGraph())).toBe(true);
    expect(hasUnresolvedTasks({ executionOrder: ['t1'], nodes: [
      {
        id: 't1',
        goalId: 'g1',
        description: 'Only task',
        status: 'done',
        dependsOn: [],
        blocks: [],
        maxRetries: 1,
        retryCount: 0,
        validators: [],
        createdAt: new Date().toISOString(),
      },
    ] })).toBe(false);
  });

  it('recognizes continuation intent phrases', () => {
    expect(isContinuationRequest('continue')).toBe(true);
    expect(isContinuationRequest('resume the work')).toBe(true);
    expect(isContinuationRequest('keep going on that pipeline')).toBe(true);
    expect(isContinuationRequest('create a brand new workflow')).toBe(false);
  });

  it('extracts substantive follow-up instructions from continuation messages', () => {
    expect(extractFollowUpInstructions('continue')).toBe('');
    expect(extractFollowUpInstructions('continue, but add retry policy')).toBe('add retry policy');
    expect(extractFollowUpInstructions('resume with swapping Twitter for LinkedIn')).toBe('swapping Twitter for LinkedIn');
  });

  it('detects requests that explicitly want a summary-style answer', () => {
    expect(isSummaryStyleRequest('summarize what happened')).toBe(true);
    expect(isSummaryStyleRequest('give me a recap of the work')).toBe(true);
    expect(isSummaryStyleRequest('hi')).toBe(false);
  });

  it('only resumes when mode, message, and unresolved tasks all align', () => {
    const graph = makeTaskGraph();
    expect(shouldResumeSession('resume', graph, 'continue')).toBe(true);
    expect(shouldResumeSession('summary', graph, 'continue')).toBe(false);
    expect(shouldResumeSession('resume', graph, 'create something new')).toBe(false);
    expect(shouldResumeSession('resume', null, 'continue')).toBe(false);
  });

  it('reopens retryable unresolved tasks while preserving completed work', () => {
    const resumed = resumeTaskGraph(makeTaskGraph());
    expect(resumed).not.toBeNull();
    expect(resumed!.nodes.find((node: TaskNode) => node.id === 't1')!.status).toBe('done');
    expect(resumed!.nodes.find((node: TaskNode) => node.id === 't2')!.status).toBe('ready');
    expect(resumed!.nodes.find((node: TaskNode) => node.id === 't3')!.status).toBe('ready');
    expect(resumed!.nodes.find((node: TaskNode) => node.id === 't4')!.status).toBe('ready');
    expect(resumed!.nodes.find((node: TaskNode) => node.id === 't5')!.status).toBe('failed');
  });

  it('injects a follow-up task that depends on unresolved resumed work', () => {
    const resumed = resumeTaskGraph(makeTaskGraph());
    const injected = injectFollowUpTask(resumed!, makeGoal(), 'continue, but add retry policy and swap Twitter for LinkedIn');

    expect(injected.nodes).toHaveLength(resumed!.nodes.length + 1);
    const followUp = injected.nodes[injected.nodes.length - 1];
    expect(followUp.description).toContain('add retry policy and swap Twitter for LinkedIn');
    expect(followUp.dependsOn).toEqual(expect.arrayContaining(['t2', 't3', 't4', 't5']));
    expect(followUp.status).toBe('pending');
  });

  it('prefers direct user-facing output for a single completed task when no summary was requested', () => {
    const graph: TaskGraph = {
      executionOrder: ['t1'],
      nodes: [{
        id: 't1',
        goalId: 'g1',
        description: 'Respond to a greeting from the user',
        status: 'done',
        dependsOn: [],
        blocks: [],
        maxRetries: 1,
        retryCount: 0,
        validators: [],
        createdAt: new Date().toISOString(),
        result: {
          success: true,
          output: 'Hello! How can I help you today?',
          observations: [],
          toolCallCount: 0,
          durationMs: 10,
        },
      }],
    };

    expect(selectDirectUserFacingTaskOutput(graph, 'hi')).toBe('Hello! How can I help you today?');
    expect(selectDirectUserFacingTaskOutput(graph, 'summarize what happened')).toBeNull();
  });
});
