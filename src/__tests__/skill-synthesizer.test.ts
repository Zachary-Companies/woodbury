import { SkillSynthesizer } from '../loop/v3/skill-synthesizer';
import type { ClosureEngineState, MemoryRecord, Observation, TaskGraph, TaskNode } from '../loop/v3/types';

function makeTask(overrides: Partial<TaskNode>): TaskNode {
  return {
    id: overrides.id || 'task',
    goalId: overrides.goalId || 'g1',
    description: overrides.description || 'Task',
    status: overrides.status || 'done',
    dependsOn: overrides.dependsOn || [],
    blocks: overrides.blocks || [],
    maxRetries: overrides.maxRetries || 2,
    retryCount: overrides.retryCount || 0,
    validators: overrides.validators || [],
    createdAt: overrides.createdAt || new Date().toISOString(),
    result: overrides.result,
    preferredSkill: overrides.preferredSkill,
    preferredSkillReason: overrides.preferredSkillReason,
  };
}

describe('skill synthesizer', () => {
  it('produces skill updates for applicability and recovery hints', () => {
    const tasks: TaskNode[] = [
      makeTask({
        id: 't1',
        description: 'Explore and inspect the repository structure',
        preferredSkill: 'repo_explore',
        result: { success: true, output: 'Found the relevant route and files', observations: [], toolCallCount: 1, durationMs: 10 },
      }),
      makeTask({
        id: 't2',
        description: 'Implement the fix in the dashboard chat route',
        preferredSkill: 'code_change',
        retryCount: 1,
        result: { success: true, output: 'Patched the route and rebuilt', observations: [], toolCallCount: 2, durationMs: 10 },
      }),
    ];
    const failedObservation: Observation = {
      id: 'o1',
      actionId: 'a1',
      taskId: 't2',
      toolName: 'test_run',
      params: {},
      result: 'Verification failed: Jest assertion mismatch',
      status: 'error',
      duration: 15,
      matchedExpectation: false,
      timestamp: new Date().toISOString(),
    };
    const state: ClosureEngineState = {
      sessionId: 's1',
      goal: null,
      taskGraph: { nodes: tasks, executionOrder: tasks.map(task => task.id) },
      beliefs: [],
      observations: [failedObservation],
      memories: [],
      reflections: [],
      recoveryAttempts: [],
      evidence: [],
      beliefEdges: [],
      actionHistory: [],
      episodeSteps: [],
      iteration: 0,
      phase: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const addedMemories: MemoryRecord[] = [];
    const synthesizer = new SkillSynthesizer(
      { getState: () => state } as any,
      {
        add(record: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) {
          const memory: MemoryRecord = {
            ...record,
            id: `mem_${addedMemories.length + 1}`,
            accessCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          addedMemories.push(memory);
          return memory;
        },
      } as any,
    );

    const result = synthesizer.synthesize();
    const skillUpdates = result.learningProducts.filter(product => product.kind === 'skill_update');

    expect(skillUpdates.length).toBeGreaterThan(0);
    expect(skillUpdates.some(product => product.kind === 'skill_update' && product.skillName === 'repo_explore' && product.updateType === 'applicability')).toBe(true);
    expect(skillUpdates.some(product => product.kind === 'skill_update' && product.skillName === 'code_change' && product.updateType === 'recovery_hint')).toBe(true);
    expect(addedMemories.some(memory => memory.tags.includes('skill-update') && memory.tags.includes('code_change'))).toBe(true);
    expect(addedMemories.some(memory => memory.tags.includes('recovery-hint'))).toBe(true);
  });
});