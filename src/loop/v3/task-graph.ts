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
 * Identify goals that should use the dedicated pipeline lifecycle.
 */
export function isPipelineBuildObjective(objective: string): boolean {
  const lower = objective.toLowerCase();
  const pipelineNouns = /(pipeline|workflow|composition|automation|automate|orchestrate|orchestration)/;
  const lifecycleVerbs = /(create|build|make|set up|setup|design|generate|update|modify|fix|repair)/;
  return pipelineNouns.test(lower) && lifecycleVerbs.test(lower);
}

/**
 * Create a four-stage lifecycle graph for reusable pipeline generation.
 */
export function createPipelineLifecycleGraph(goal: Goal): TaskGraph {
  const now = new Date().toISOString();
  const designId = generateId('task');
  const generateIdValue = generateId('task');
  const validateId = generateId('task');
  const verifyId = generateId('task');

  return {
    nodes: [
      {
        id: designId,
        goalId: goal.id,
        title: 'Design pipeline',
        description: `Design the pipeline graph for: ${goal.objective}. Define node responsibilities, data flow, inputs, outputs, and the interface contract before generating anything. Consolidate any shared user-provided values into a single exposed variable/input contract instead of repeating the same external input on multiple nodes.`,
        status: 'ready',
        dependsOn: [],
        blocks: [generateIdValue],
        maxRetries: 2,
        retryCount: 0,
        validators: [],
        createdAt: now,
        preferredSkill: 'pipeline_design',
        preferredSkillReason: 'Reusable pipelines must start with an explicit graph and interface contract.',
        outputRefs: ['pipeline_design'],
      },
      {
        id: generateIdValue,
        goalId: goal.id,
        title: 'Generate pipeline',
        description: `Generate the initial saved pipeline or workflow composition for: ${goal.objective}. Use the approved design, keep the constraints tight, centralize shared pipeline inputs through exposed variable nodes, and return a real saved composition artifact.`,
        status: 'pending',
        dependsOn: [designId],
        blocks: [validateId],
        maxRetries: 3,
        retryCount: 0,
        validators: [],
        createdAt: now,
        preferredSkill: 'pipeline_generate',
        preferredSkillReason: 'Generation should happen only after the design contract is defined.',
        inputRefs: ['pipeline_design'],
        outputRefs: ['generated_composition'],
      },
      {
        id: validateId,
        goalId: goal.id,
        title: 'Validate and repair pipeline',
        description: `Validate and repair the generated composition for: ${goal.objective}. Parse-check script nodes, verify ports and edges, reject malformed code blobs, collapse repeated external inputs into exposed variable nodes where appropriate, and regenerate or repair bad nodes before claiming success.`,
        status: 'pending',
        dependsOn: [generateIdValue],
        blocks: [verifyId],
        maxRetries: 3,
        retryCount: 0,
        validators: [],
        createdAt: now,
        preferredSkill: 'pipeline_validate_and_repair',
        preferredSkillReason: 'Generated compositions need structural validation before they can be trusted.',
        inputRefs: ['pipeline_design', 'generated_composition'],
        outputRefs: ['validated_composition'],
      },
      {
        id: verifyId,
        goalId: goal.id,
        title: 'Verify pipeline',
        description: `Verify the saved composition for: ${goal.objective}. Confirm it is discoverable in the dashboard and perform the lightest viable smoke test with sample inputs or another executable check before completion.`,
        status: 'pending',
        dependsOn: [validateId],
        blocks: [],
        maxRetries: 2,
        retryCount: 0,
        validators: goal.successCriteria
          .filter(c => c.validator)
          .map(c => c.validator!),
        createdAt: now,
        preferredSkill: 'pipeline_verify',
        preferredSkillReason: 'A reusable pipeline is only done once it is visible and executable.',
        inputRefs: ['validated_composition'],
      },
    ],
    executionOrder: [designId, generateIdValue, validateId, verifyId],
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
  if (isPipelineBuildObjective(goal.objective)) {
    return createPipelineLifecycleGraph(goal);
  }
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
  if (isPipelineBuildObjective(objective)) return false;
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
