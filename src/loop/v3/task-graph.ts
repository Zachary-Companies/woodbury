/**
 * Task Graph Builder — Decomposes goals into a DAG of TaskNodes.
 *
 * Uses LLM to break complex goals into ordered subtasks.
 * Simple requests get a single-task graph (no decomposition overhead).
 */

import type { ProviderAdapter } from '../v2/core/provider-adapter.js';
import type { Goal, TaskNode, TaskGraph, TaskValidator } from './types.js';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a single-task graph for simple requests.
 */
export function createSingleTaskGraph(goal: Goal): TaskGraph {
  const now = new Date().toISOString();
  const taskId = generateId('task');
  const node: TaskNode = {
    id: taskId,
    goalId: goal.id,
    description: goal.objective,
    status: 'ready',
    dependsOn: [],
    blocks: [],
    maxRetries: 3,
    retryCount: 0,
    validators: goal.successCriteria
      .filter(c => c.validator)
      .map(c => c.validator!),
    createdAt: now,
  };

  return {
    nodes: [node],
    executionOrder: [taskId],
  };
}

/**
 * Decompose a goal into a task graph using the LLM.
 */
export async function decomposeGoal(
  goal: Goal,
  adapter: ProviderAdapter,
  provider: 'openai' | 'anthropic' | 'groq',
  model: string,
  systemPrompt: string,
): Promise<TaskGraph> {
  const decompositionPrompt = `You are a task planner. Decompose the following goal into concrete, actionable tasks.

Goal: ${goal.objective}

Success Criteria:
${goal.successCriteria.map((c, i) => `${i + 1}. ${c.description}`).join('\n')}

${goal.constraints.length > 0 ? `Constraints:\n${goal.constraints.map(c => `- ${c}`).join('\n')}` : ''}

Respond with a JSON array of tasks. Each task should have:
- "description": what to do (be specific)
- "dependsOn": array of task indices (0-based) this task depends on
- "validators": array of validators, each with "type" and relevant fields

Validator types:
- { "type": "file_exists", "path": "<path>" }
- { "type": "file_contains", "path": "<path>", "pattern": "<regex>" }
- { "type": "command_succeeds", "command": "<cmd>" }

Keep it to 2-8 tasks. Simple goals should have fewer tasks.

Respond ONLY with valid JSON — no markdown fences, no explanation.`;

  try {
    const response = await adapter.createCompletion({
      provider,
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: decompositionPrompt },
      ],
      maxTokens: 2000,
      temperature: 0.2,
    });

    const parsed = parseDecompositionResponse(response.content, goal.id);
    if (parsed && parsed.nodes.length > 0) {
      return parsed;
    }
  } catch {
    // Fall through to single-task
  }

  // Fallback: single task
  return createSingleTaskGraph(goal);
}

/**
 * Parse the LLM's decomposition response into a TaskGraph.
 */
function parseDecompositionResponse(content: string, goalId: string): TaskGraph | null {
  try {
    // Strip markdown fences if present
    let json = content.trim();
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const tasks: Array<{
      description: string;
      dependsOn?: number[];
      validators?: TaskValidator[];
    }> = JSON.parse(json);

    if (!Array.isArray(tasks) || tasks.length === 0) return null;

    const now = new Date().toISOString();
    const taskIds = tasks.map(() => generateId('task'));

    const nodes: TaskNode[] = tasks.map((t, i) => {
      const deps = (t.dependsOn || [])
        .filter(idx => idx >= 0 && idx < tasks.length && idx !== i)
        .map(idx => taskIds[idx]);

      return {
        id: taskIds[i],
        goalId,
        description: t.description,
        status: deps.length === 0 ? 'ready' as const : 'pending' as const,
        dependsOn: deps,
        blocks: [],
        maxRetries: 3,
        retryCount: 0,
        validators: t.validators || [],
        createdAt: now,
      };
    });

    // Fill in `blocks` (reverse of dependsOn)
    for (const node of nodes) {
      for (const depId of node.dependsOn) {
        const dep = nodes.find(n => n.id === depId);
        if (dep && !dep.blocks.includes(node.id)) {
          dep.blocks.push(node.id);
        }
      }
    }

    // Topological sort for execution order
    const executionOrder = topologicalSort(nodes);

    return { nodes, executionOrder };
  } catch {
    return null;
  }
}

/**
 * Topological sort of task nodes.
 */
export function topologicalSort(nodes: TaskNode[]): string[] {
  const visited = new Set<string>();
  const sorted: string[] = [];
  const visiting = new Set<string>();

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) return; // cycle — skip
    visiting.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      for (const depId of node.dependsOn) {
        visit(depId);
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.push(nodeId);
  }

  for (const node of nodes) {
    visit(node.id);
  }

  return sorted;
}

/**
 * Determine if a goal is simple enough for a single-task graph.
 * Heuristic: short objectives without multi-step language.
 */
export function isSimpleGoal(objective: string): boolean {
  const lower = objective.toLowerCase();
  const multiStepIndicators = [
    'and then', 'after that', 'first,', 'second,', 'finally,',
    'step 1', 'step 2', 'multiple', 'several', 'each of',
    'create a project', 'build an app', 'implement a system',
    'set up', 'configure and', 'migrate',
  ];
  if (objective.length > 300) return false;
  return !multiStepIndicators.some(ind => lower.includes(ind));
}
