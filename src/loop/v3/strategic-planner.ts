/**
 * Strategic Planner — Multi-plan generation, ranking, and selection.
 *
 * Generates candidate plans with different strategies (fast_path, evidence_first,
 * low_risk, parallel, human_supervised), scores them using a multi-factor formula,
 * and selects the best plan for execution.
 */

import type {
  ProviderAdapter,
} from '../v2/core/provider-adapter.js';
import {
  createPipelineLifecycleGraph,
  createSingleTaskGraph,
  decomposeGoal,
  isPipelineBuildObjective,
  topologicalSort,
} from './task-graph.js';
import type { Goal, TaskGraph, TaskNode } from './types.js';
import type { StateManager } from './state-manager.js';
import type { MemoryStore } from './memory-store.js';
import { debugLog } from '../../debug-log.js';

// ── Types ───────────────────────────────────────────────────

export type PlanStrategy =
  | 'fast_path'
  | 'evidence_first'
  | 'low_risk'
  | 'parallel'
  | 'human_supervised';

export interface CandidatePlan {
  id: string;
  strategy: PlanStrategy;
  taskGraph: TaskGraph;
  score: number;
  completionProbability: number;
  infoGain: number;
  taskReadiness: number;
  verificationStrength: number;
  risk: number;
  cost: number;
  rationale: string;
}

// ── Planner ─────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class StrategicPlanner {
  constructor(
    private stateManager: StateManager,
    private memoryStore: MemoryStore,
    private adapter: ProviderAdapter,
    private provider: 'openai' | 'anthropic' | 'groq',
    private model: string,
    private systemPrompt: string,
  ) {}

  /**
   * Generate 2-5 candidate plans using different strategies.
   */
  async generatePlans(goal: Goal): Promise<CandidatePlan[]> {
    if (isPipelineBuildObjective(goal.objective)) {
      const lifecycleGraph = createPipelineLifecycleGraph(goal);
      return [
        this.buildCandidate(
          'low_risk',
          lifecycleGraph,
          goal,
          'Dedicated pipeline lifecycle: design, generate, validate/repair, then verify before completion.',
        ),
      ];
    }

    const plans: CandidatePlan[] = [];

    // Strategy 1: Fast path — single task or minimal decomposition
    try {
      const fastGraph = createSingleTaskGraph(goal);
      plans.push(this.buildCandidate('fast_path', fastGraph, goal, 'Direct single-task execution'));
    } catch (err) {
      debugLog.debug('strategic-planner', 'Fast path failed', { error: String(err) });
    }

    // Strategy 2: Evidence-first — decompose with exploration tasks upfront
    try {
      const evidenceGraph = await this.buildEvidenceFirstGraph(goal);
      plans.push(this.buildCandidate('evidence_first', evidenceGraph, goal, 'Gather evidence before acting'));
    } catch (err) {
      debugLog.debug('strategic-planner', 'Evidence-first failed', { error: String(err) });
    }

    // Strategy 3: Low-risk — standard decomposition
    try {
      const decompGraph = await decomposeGoal(
        goal, this.adapter, this.provider, this.model, this.systemPrompt,
      );
      plans.push(this.buildCandidate('low_risk', decompGraph, goal, 'Standard task decomposition'));
    } catch (err) {
      debugLog.debug('strategic-planner', 'Low-risk decomposition failed', { error: String(err) });
    }

    // Strategy 4: Parallel — independent subtasks executing concurrently
    try {
      const parallelGraph = await this.buildParallelGraph(goal);
      if (parallelGraph.nodes.length > 1) {
        plans.push(this.buildCandidate('parallel', parallelGraph, goal, 'Independent subtasks executing concurrently'));
      }
    } catch (err) {
      debugLog.debug('strategic-planner', 'Parallel plan failed', { error: String(err) });
    }

    // Strategy 5: Human-supervised — verification checkpoints on high-risk tasks
    try {
      const supervisedGraph = await this.buildHumanSupervisedGraph(goal);
      plans.push(this.buildCandidate('human_supervised', supervisedGraph, goal, 'Human verification checkpoints on high-risk tasks'));
    } catch (err) {
      debugLog.debug('strategic-planner', 'Human-supervised plan failed', { error: String(err) });
    }

    // If no plans were generated, create a minimal fallback
    if (plans.length === 0) {
      const fallback = createSingleTaskGraph(goal);
      plans.push(this.buildCandidate('fast_path', fallback, goal, 'Fallback: single task'));
    }

    return plans;
  }

  /**
   * Rank plans using multi-factor scoring formula.
   *
   * score = completionProbability*0.35 + infoGain*0.20 + taskReadiness*0.15
   *       + verificationStrength*0.15 - risk*0.10 - cost*0.05
   */
  rankPlans(plans: CandidatePlan[]): CandidatePlan[] {
    for (const plan of plans) {
      plan.score =
        plan.completionProbability * 0.35 +
        plan.infoGain * 0.20 +
        plan.taskReadiness * 0.15 +
        plan.verificationStrength * 0.15 -
        plan.risk * 0.10 -
        plan.cost * 0.05;
    }
    return [...plans].sort((a, b) => b.score - a.score);
  }

  /**
   * Select the best plan from a list.
   */
  selectBest(plans: CandidatePlan[]): CandidatePlan {
    const ranked = this.rankPlans(plans);
    return ranked[0];
  }

  applySkillTransitions(taskGraph: TaskGraph, goal: Goal): TaskGraph {
    return this.annotateSkillTransitions(taskGraph, goal, 'low_risk');
  }

  // ── Plan builders ────────────────────────────────────────

  private buildCandidate(
    strategy: PlanStrategy,
    taskGraph: TaskGraph,
    goal: Goal,
    rationale: string,
  ): CandidatePlan {
    const annotatedGraph = this.annotateSkillTransitions(taskGraph, goal, strategy);
    const taskCount = annotatedGraph.nodes.length;
    const hasValidators = annotatedGraph.nodes.some(n => n.validators.length > 0);
    const relevantMemories = this.memoryStore.query(goal.objective);
    const hasFailureMemories = relevantMemories.some(m => m.type === 'failure');

    return {
      id: generateId('plan'),
      strategy,
      taskGraph: annotatedGraph,
      score: 0, // Will be computed by rankPlans
      completionProbability: this.estimateCompletionProbability(strategy, taskCount, hasFailureMemories),
      infoGain: this.estimateInfoGain(strategy),
      taskReadiness: this.estimateTaskReadiness(taskGraph),
      verificationStrength: hasValidators ? 0.8 : 0.3,
      risk: this.estimateRisk(strategy, taskCount),
      cost: this.estimateCost(taskCount),
      rationale,
    };
  }

  private estimateCompletionProbability(
    strategy: PlanStrategy, taskCount: number, hasFailureHistory: boolean,
  ): number {
    let base = strategy === 'fast_path' ? 0.9 : 0.7;
    if (taskCount > 5) base -= 0.1;
    if (taskCount > 10) base -= 0.1;
    if (hasFailureHistory) base -= 0.15;
    if (strategy === 'evidence_first') base += 0.05;
    return Math.max(0.1, Math.min(1, base));
  }

  private estimateInfoGain(strategy: PlanStrategy): number {
    switch (strategy) {
      case 'evidence_first': return 0.9;
      case 'low_risk': return 0.6;
      case 'fast_path': return 0.3;
      case 'parallel': return 0.7;
      case 'human_supervised': return 0.5;
    }
  }

  private estimateTaskReadiness(graph: TaskGraph): number {
    const readyCount = graph.nodes.filter(n => n.dependsOn.length === 0).length;
    return Math.min(1, readyCount / Math.max(1, graph.nodes.length));
  }

  private estimateRisk(strategy: PlanStrategy, taskCount: number): number {
    let base = 0.2;
    if (strategy === 'fast_path') base = 0.3;
    if (strategy === 'evidence_first') base = 0.15;
    if (strategy === 'low_risk') base = 0.2;
    if (strategy === 'human_supervised') base = 0.1;
    base += taskCount * 0.02;
    return Math.min(1, base);
  }

  private estimateCost(taskCount: number): number {
    return Math.min(1, taskCount * 0.1);
  }

  /**
   * Build an evidence-first task graph.
   * Adds an exploration/evidence gathering task before the main work.
   */
  private async buildEvidenceFirstGraph(goal: Goal): Promise<TaskGraph> {
    const now = new Date().toISOString();
    const exploreId = generateId('task');
    const mainId = generateId('task');

    return {
      nodes: [
        {
          id: exploreId,
          goalId: goal.id,
          description: `Explore and gather evidence for: ${goal.objective}`,
          status: 'ready',
          dependsOn: [],
          blocks: [mainId],
          maxRetries: 2,
          retryCount: 0,
          validators: [],
          createdAt: now,
          preferredSkill: 'repo_explore',
          preferredSkillReason: 'Evidence-first strategy begins with repository exploration.',
        },
        {
          id: mainId,
          goalId: goal.id,
          description: goal.objective,
          status: 'pending',
          dependsOn: [exploreId],
          blocks: [],
          maxRetries: 3,
          retryCount: 0,
          validators: goal.successCriteria
            .filter(c => c.validator)
            .map(c => c.validator!),
          createdAt: now,
          preferredSkill: this.inferPreferredSkill(goal.objective),
          preferredSkillReason: 'Evidence-first strategy hands off from repository exploration to delivery work.',
        },
      ],
      executionOrder: [exploreId, mainId],
    };
  }

  private annotateSkillTransitions(
    taskGraph: TaskGraph,
    goal: Goal,
    strategy: PlanStrategy,
  ): TaskGraph {
    const nodes = taskGraph.nodes.map(node => ({ ...node }));
    const nodeMap = new Map(nodes.map(node => [node.id, node]));

    for (const node of nodes) {
      if (!node.preferredSkill) {
        node.preferredSkill = this.inferPreferredSkill(node.description);
      }
      if (!node.preferredSkillReason) {
        node.preferredSkillReason = `Planner assigned ${node.preferredSkill} during ${strategy} planning.`;
      }
    }

    for (const node of nodes) {
      const dependencySkills = node.dependsOn
        .map(depId => nodeMap.get(depId)?.preferredSkill)
        .filter((skill): skill is string => !!skill);

      if (dependencySkills.includes('repo_explore') && node.preferredSkill !== 'repo_explore') {
        node.preferredSkillReason = `Planner handoff from repo_explore to ${node.preferredSkill} after evidence gathering.`;
      }

      if (dependencySkills.includes('code_change') && node.preferredSkill === 'test_and_verify') {
        node.preferredSkillReason = 'Planner handoff from code_change to test_and_verify after implementation.';
      }

      if (dependencySkills.includes('pipeline_design') && node.preferredSkill === 'pipeline_generate') {
        node.preferredSkillReason = 'Planner handoff from pipeline_design to pipeline_generate after the graph contract is defined.';
      }

      if (dependencySkills.includes('pipeline_generate') && node.preferredSkill === 'pipeline_validate_and_repair') {
        node.preferredSkillReason = 'Planner handoff from pipeline_generate to pipeline_validate_and_repair so the saved composition is structurally sound before completion.';
      }

      if (dependencySkills.includes('pipeline_validate_and_repair') && node.preferredSkill === 'pipeline_verify') {
        node.preferredSkillReason = 'Planner handoff from pipeline_validate_and_repair to pipeline_verify so the validated artifact is discoverable and smoke-tested.';
      }
    }

    if (!nodes.some(node => node.preferredSkill === 'test_and_verify')) {
      const candidate = [...nodes].reverse().find(node =>
        node.preferredSkill === 'code_change' &&
        /build|test|verify|check|validate|compile/.test(node.description.toLowerCase()) &&
        !/implement|fix|edit|write|refactor/.test(node.description.toLowerCase()),
      );
      if (candidate) {
        candidate.preferredSkill = 'test_and_verify';
        candidate.preferredSkillReason = 'Planner routed the final implementation step through test_and_verify to enforce verification before completion.';
      }
    }

    return {
      ...taskGraph,
      nodes,
    };
  }

  private inferPreferredSkill(description: string): string {
    const lower = description.toLowerCase();
    if (/(smoke test|sample input|dashboard visibility|discoverable|saved composition|saved artifact|executable check)/.test(lower) && /(pipeline|workflow|composition)/.test(lower)) return 'pipeline_verify';
    if (/(validate|repair|parse-check|parse check|ports|edges|malformed|regenerate|bad nodes)/.test(lower) && /(pipeline|workflow|composition)/.test(lower)) return 'pipeline_validate_and_repair';
    if (/(generate|initial saved|saved pipeline|saved workflow|compose tools)/.test(lower) && /(pipeline|workflow|composition)/.test(lower)) return 'pipeline_generate';
    if (/(design|graph plan|node responsibilities|interface contract|data flow|inputs|outputs)/.test(lower) && /(pipeline|workflow|composition|automation)/.test(lower)) return 'pipeline_design';
    if (/test|verify|validation|build|compile|assert|check/.test(lower)) return 'test_and_verify';
    if (/explore|inspect|investigate|understand|gather evidence|trace|analyze existing/.test(lower)) return 'repo_explore';
    if (/implement|fix|refactor|edit|change|update|write|code/.test(lower)) return 'code_change';
    if (/browser|click|navigate|screenshot|page|dom/.test(lower)) return 'browser_automation';
    if (/pipeline|workflow|compose|automation|orchestrate/.test(lower)) return 'workflow_or_pipeline_build';
    if (/dashboard|ui|frontend|css|panel|layout|render|chat/.test(lower)) return 'dashboard_or_ui_change';
    if (/extension|mcp|provider|manifest|tool registry|integration/.test(lower)) return 'extension_or_mcp_integration';
    if (/search|research|fetch|crawl|scrape|document/.test(lower)) return 'web_research';
    return 'general_execution';
  }

  /**
   * Build a parallel task graph — independent subtasks that can execute concurrently.
   * Uses LLM decomposition, then ensures at least 2 root nodes exist.
   */
  private async buildParallelGraph(goal: Goal): Promise<TaskGraph> {
    const now = new Date().toISOString();

    // Try LLM decomposition first
    try {
      const baseGraph = await decomposeGoal(
        goal, this.adapter, this.provider, this.model, this.systemPrompt,
      );
      const roots = baseGraph.nodes.filter(n => n.dependsOn.length === 0);
      if (roots.length >= 2) {
        // Already has parallel roots — return as-is
        return baseGraph;
      }
    } catch {
      // Fall through to manual parallel construction
    }

    // Construct 2 independent branches + merge node
    const branchAId = generateId('task');
    const branchBId = generateId('task');
    const mergeId = generateId('task');

    return {
      nodes: [
        {
          id: branchAId,
          goalId: goal.id,
          description: `Parallel branch A: Investigate and prepare for ${goal.objective}`,
          status: 'ready',
          dependsOn: [],
          blocks: [mergeId],
          maxRetries: 2,
          retryCount: 0,
          validators: [],
          createdAt: now,
        },
        {
          id: branchBId,
          goalId: goal.id,
          description: `Parallel branch B: Execute primary action for ${goal.objective}`,
          status: 'ready',
          dependsOn: [],
          blocks: [mergeId],
          maxRetries: 3,
          retryCount: 0,
          validators: goal.successCriteria.filter(c => c.validator).map(c => c.validator!),
          createdAt: now,
        },
        {
          id: mergeId,
          goalId: goal.id,
          description: `Merge and verify results for: ${goal.objective}`,
          status: 'pending',
          dependsOn: [branchAId, branchBId],
          blocks: [],
          maxRetries: 2,
          retryCount: 0,
          validators: [],
          createdAt: now,
        },
      ],
      executionOrder: [branchAId, branchBId, mergeId],
    };
  }

  /**
   * Build a human-supervised task graph — insert review checkpoints after
   * high-risk or unvalidated nodes.
   */
  private async buildHumanSupervisedGraph(goal: Goal): Promise<TaskGraph> {
    const now = new Date().toISOString();

    // Start from LLM decomposition (or fall back to single task)
    let baseGraph: TaskGraph;
    try {
      baseGraph = await decomposeGoal(
        goal, this.adapter, this.provider, this.model, this.systemPrompt,
      );
    } catch {
      baseGraph = createSingleTaskGraph(goal);
    }

    // Insert checkpoint tasks after high-risk or unvalidated nodes
    const augmentedNodes: TaskNode[] = [];
    const checkpointMap = new Map<string, string>(); // originalId → checkpointId

    for (const node of baseGraph.nodes) {
      augmentedNodes.push({ ...node });

      const isHighRisk = node.riskLevel === 'high' || node.riskLevel === 'critical';
      const isUnvalidated = node.validators.length === 0;
      const isFinal = node.blocks.length === 0;

      if (isHighRisk || isUnvalidated || isFinal) {
        const checkpointId = generateId('task');
        checkpointMap.set(node.id, checkpointId);

        augmentedNodes.push({
          id: checkpointId,
          goalId: goal.id,
          description: `[Human Checkpoint] Review output of: ${node.description.slice(0, 100)}`,
          status: 'pending',
          dependsOn: [node.id],
          blocks: [],
          maxRetries: 1,
          retryCount: 0,
          validators: [{
            type: 'llm_judge',
            criterion: `Verify that "${node.description.slice(0, 80)}" was completed correctly`,
          }],
          owner: 'user',
          riskLevel: 'low',
          createdAt: now,
        });
      }
    }

    // Rewire: downstream tasks should depend on checkpoint instead of original
    for (const node of augmentedNodes) {
      node.dependsOn = node.dependsOn.map(depId => checkpointMap.get(depId) || depId);
    }

    // Rebuild blocks from dependsOn
    for (const node of augmentedNodes) {
      node.blocks = [];
    }
    for (const node of augmentedNodes) {
      for (const depId of node.dependsOn) {
        const dep = augmentedNodes.find(n => n.id === depId);
        if (dep && !dep.blocks.includes(node.id)) {
          dep.blocks.push(node.id);
        }
      }
    }

    return {
      nodes: augmentedNodes,
      executionOrder: topologicalSort(augmentedNodes),
    };
  }
}
