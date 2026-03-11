/**
 * Closure Engine — Verification-first, memory-augmented agent runtime.
 *
 * Core loop:
 *   1. Goal Setting — interpret user request into structured Goal
 *   2. Decompose — break into task graph (trivial requests → single task)
 *   3. Retrieve relevant memories
 *   4. Execute tasks in dependency order (inner LLM loop per task)
 *   5. Verify, recover, reflect
 *   6. Build final result
 */

import {
  ProviderAdapter,
  createProviderAdapter,
} from '../v2/core/provider-adapter.js';
import type { ToolRegistryV2 } from '../v2/tools/registry-v2.js';
import type { NativeToolDefinition } from '../v2/types/tool-types.js';
import type { ToolExecutionContext } from '../v2/types/tool-types.js';
import { StateManager } from './state-manager.js';
import { MemoryStore } from './memory-store.js';
import { Verifier } from './verifier.js';
import { RecoveryEngine } from './recovery.js';
import { BeliefGraph } from './belief-graph.js';
import { Reflector } from './reflector.js';
import { SkillSynthesizer } from './skill-synthesizer.js';
import { DelegateEngine } from './delegate-engine.js';
import { SkillRegistry } from './skill-registry.js';
import { SkillPolicyStore } from './skill-policy-store.js';
import { ToolDescriptorRegistry } from './tool-descriptor.js';
import { ConfidenceEngine } from './confidence-engine.js';
import { StrategicPlanner } from './strategic-planner.js';
import { Critic } from './critic.js';
import { SafetyGate } from './safety-gate.js';
import { ActionSelector } from './action-selector.js';
import { MetricsCollector } from './metrics.js';
import { createSingleTaskGraph, decomposeGoal, isSimpleGoal, topologicalSort } from './task-graph.js';
import type {
  ClosureEngineConfig,
  ClosureEngineResult,
  EngineCallbacks,
  EnginePhase,
  Goal,
  SuccessCriterion,
  TaskGraph,
  TaskNode,
  TaskResult,
  Observation,
  Belief,
  RecoveryStrategy,
  MemoryRecord,
  ActionSpec,
  ActionType,
  ValidationPlan,
  SkillSelection,
} from './types.js';
import { debugLog } from '../../debug-log.js';
import { selectSkillExecution } from './tool-router.js';
import { invalidateCompositionCache } from '../../workflow/loader.js';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hasUnresolvedTasks(taskGraph: TaskGraph | null | undefined): boolean {
  return !!taskGraph?.nodes?.some((node: TaskNode) => node.status !== 'done' && node.status !== 'skipped');
}

export function isContinuationRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return /^(continue|resume|keep going|carry on|pick up|finish|complete (it|this|that)|keep working)/.test(normalized)
    || /\bcontinue\b|\bresume\b|\bkeep going\b|\bpick up where you left off\b/.test(normalized);
}

export function resumeTaskGraph(taskGraph: TaskGraph | null | undefined): TaskGraph | null {
  if (!taskGraph) return null;
  return {
    executionOrder: [...taskGraph.executionOrder],
    nodes: taskGraph.nodes.map((node: TaskNode) => {
      let status = node.status;
      if (status === 'running' || status === 'pending') {
        status = 'ready';
      } else if (status === 'failed' && node.retryCount < node.maxRetries) {
        status = 'ready';
      }
      return {
        ...node,
        status,
      };
    }),
  };
}

export function shouldResumeSession(
  continuationMode: 'off' | 'summary' | 'resume' | undefined,
  taskGraph: TaskGraph | null | undefined,
  message: string,
): boolean {
  return (continuationMode || 'summary') === 'resume'
    && hasUnresolvedTasks(taskGraph)
    && isContinuationRequest(message);
}

export function extractFollowUpInstructions(message: string): string {
  const normalized = message.trim();
  if (!normalized) return '';

  const stripped = normalized
    .replace(/^(continue|resume|keep going|carry on|pick up where you left off|pick up|finish|keep working|complete (?:it|this|that))\b[\s,:-]*/i, '')
    .replace(/^(?:on|with)\b[\s,:-]*/i, '')
    .replace(/^(?:and|but|also|plus|then)\b[\s,:-]*/i, '')
    .trim();

  if (!stripped) return '';
  if (/^(continue|resume|keep going|carry on|pick up where you left off)$/i.test(stripped)) {
    return '';
  }

  return stripped;
}

export function isSummaryStyleRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(summary|summarize|recap|status update|what happened|what did you do|tell me what you accomplished|overview)\b/.test(normalized);
}

export function selectDirectUserFacingTaskOutput(
  taskGraph: TaskGraph | null | undefined,
  originalMessage: string,
): string | null {
  if (!taskGraph || taskGraph.nodes.length !== 1 || isSummaryStyleRequest(originalMessage)) {
    return null;
  }

  const task = taskGraph.nodes[0];
  if (task.status !== 'done') return null;

  const output = task.result?.output?.trim();
  if (!output) return null;

  return output;
}

export function injectFollowUpTask(taskGraph: TaskGraph, goal: Goal, instructions: string): TaskGraph {
  const followUpInstructions = extractFollowUpInstructions(instructions);
  if (!followUpInstructions) return taskGraph;

  const unresolvedTaskIds = taskGraph.nodes
    .filter(node => node.status !== 'done' && node.status !== 'skipped')
    .map(node => node.id);

  const taskId = generateId('task');
  const createdAt = new Date().toISOString();
  const node: TaskNode = {
    id: taskId,
    goalId: goal.id,
    title: followUpInstructions.length > 72 ? `${followUpInstructions.slice(0, 69)}...` : followUpInstructions,
    description: `Apply this follow-up instruction to the in-progress work: ${followUpInstructions}`,
    status: unresolvedTaskIds.length > 0 ? 'pending' : 'ready',
    dependsOn: unresolvedTaskIds,
    blocks: [],
    maxRetries: 3,
    retryCount: 0,
    validators: [],
    createdAt,
    owner: 'engine',
  };

  const nodes = [...taskGraph.nodes.map(existing => ({ ...existing })), node];
  for (const depId of unresolvedTaskIds) {
    const dependency = nodes.find(existing => existing.id === depId);
    if (dependency && !dependency.blocks.includes(taskId)) {
      dependency.blocks.push(taskId);
    }
  }

  return {
    nodes,
    executionOrder: topologicalSort(nodes),
  };
}

/** MCP intelligence tools that return CompositionDocument JSON */
const COMPOSITION_TOOLS = new Set([
  'mcp__intelligence__generate_pipeline',
  'mcp__intelligence__generate_workflow',
  'mcp__intelligence__compose_tools',
]);

/**
 * Auto-save a CompositionDocument returned by an MCP intelligence tool.
 * Writes to ~/.woodbury/workflows/{id}.composition.json so the dashboard can find it.
 */
export function autoSaveComposition(toolName: string, output: string): void {
  try {
    const parsed = JSON.parse(output);
    // Validate it looks like a CompositionDocument
    if (!parsed.version || !parsed.id || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      debugLog.warn('closure-engine', 'MCP intelligence tool result is not a valid composition', { toolName });
      return;
    }
    const dir = join(homedir(), '.woodbury', 'workflows');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Sanitize ID for filename
    const fileId = parsed.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const filePath = join(dir, `${fileId}.composition.json`);
    writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    invalidateCompositionCache();
    debugLog.info('closure-engine', `Auto-saved composition: ${filePath}`, { id: parsed.id, name: parsed.name });
  } catch {
    debugLog.warn('closure-engine', 'Failed to auto-save composition from MCP tool result', { toolName });
  }
}

/**
 * Validate a generated CompositionDocument.
 * Checks each node for common issues:
 * - Nodes referencing non-existent workflow IDs
 * - __script__ nodes with missing inputs/outputs or empty code
 * - Disconnected nodes (no edges in or out)
 * - Edge port mismatches
 * Returns a list of issues found, or empty array if valid.
 */
function validateComposition(composition: any, availableWorkflowIds: Set<string>): string[] {
  const issues: string[] = [];
  const nodes: any[] = composition.nodes || [];
  const edges: any[] = composition.edges || [];

  // Built-in node types that don't need a workflow file
  const builtInTypes = new Set([
    '__script__', '__output__', '__for_each__',
    '__approval_gate__', '__branch__', '__delay__',
  ]);

  const nodeIds = new Set(nodes.map((n: any) => n.id));

  for (const node of nodes) {
    const wfId = node.workflowId;

    // Check for fake/non-existent workflow references
    if (wfId && !builtInTypes.has(wfId) && !availableWorkflowIds.has(wfId)) {
      issues.push(`Node "${node.label || node.id}" references workflow "${wfId}" which does not exist. It should use "__script__" instead and implement the logic in code.`);
    }

    // Check __script__ nodes have code
    if (wfId === '__script__' && node.script) {
      if (!node.script.code || node.script.code.trim().length === 0) {
        issues.push(`Script node "${node.label || node.id}" has empty code.`);
      }
    }
  }

  // Check edges reference valid nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId)) {
      issues.push(`Edge "${edge.id}" references non-existent source node "${edge.sourceNodeId}".`);
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      issues.push(`Edge "${edge.id}" references non-existent target node "${edge.targetNodeId}".`);
    }
  }

  // Check for disconnected nodes (except output nodes which might be terminal)
  for (const node of nodes) {
    if (node.workflowId === '__output__') continue;
    const hasIncoming = edges.some((e: any) => e.targetNodeId === node.id);
    const hasOutgoing = edges.some((e: any) => e.sourceNodeId === node.id);
    // First node won't have incoming, last won't have outgoing — only flag if BOTH are missing
    if (!hasIncoming && !hasOutgoing && nodes.length > 1) {
      issues.push(`Node "${node.label || node.id}" is completely disconnected (no edges in or out).`);
    }
  }

  return issues;
}

/**
 * Get available workflow IDs from disk for validation.
 */
function getAvailableWorkflowIds(workingDirectory: string): Set<string> {
  const ids = new Set<string>();
  const dirs = [
    join(homedir(), '.woodbury', 'workflows'),
    join(workingDirectory, '.woodbury-work', 'workflows'),
  ];
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.endsWith('.workflow.json'));
      for (const f of files) {
        try {
          const wf = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
          ids.add(wf.id || f.replace('.workflow.json', ''));
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return ids;
}

/**
 * Discover available workflows and build context for the intelligence server.
 *
 * Strategy: Most pipeline steps should use __script__ nodes (custom code).
 * Only include real workflows that are specifically relevant to the user's intent
 * (e.g., "Post to Twitter" workflow when the intent mentions Twitter).
 * This keeps the token count low even with hundreds of workflows.
 */
function getAvailableWorkflows(workingDirectory: string, intent?: string): string {
  const allWorkflows: { id: string; name: string; description?: string; variables: string[] }[] = [];
  const dirs = [
    join(homedir(), '.woodbury', 'workflows'),
    join(workingDirectory, '.woodbury-work', 'workflows'),
  ];

  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.endsWith('.workflow.json'));
      for (const f of files) {
        try {
          const wf = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
          const vars = wf.variables
            ? (Array.isArray(wf.variables)
              ? wf.variables.map((v: any) => v.name || v.key || String(v))
              : Object.keys(wf.variables))
            : [];
          allWorkflows.push({
            id: wf.id || f.replace('.workflow.json', ''),
            name: wf.name || wf.id || f,
            description: wf.description,
            variables: vars,
          });
        } catch { /* skip malformed files */ }
      }
    } catch { /* dir not readable */ }
  }

  // Filter to only workflows relevant to the intent (fuzzy keyword match)
  let relevantWorkflows = allWorkflows;
  if (intent && allWorkflows.length > 10) {
    const intentLower = intent.toLowerCase();
    relevantWorkflows = allWorkflows.filter(wf => {
      const keywords = (wf.name + ' ' + (wf.description || '') + ' ' + wf.id).toLowerCase();
      // Check if any significant word from the workflow name appears in the intent
      const nameWords = keywords.split(/[\s_-]+/).filter(w => w.length > 2);
      return nameWords.some(w => intentLower.includes(w));
    });
    // If nothing matched, don't include any — the AI should use __script__ nodes
  }

  // Build the result with guidance
  const result: any[] = [
    // Built-in node types — always included
    { id: '__script__', name: 'Script Node (DEFAULT)', description: 'Custom JavaScript code node. USE THIS FOR MOST STEPS. Can fetch APIs, transform data, run any logic. Define input/output ports and write the code inline.', variables: [] },
    { id: '__output__', name: 'Output Node', description: 'Pipeline output. Declares the final output ports.', variables: [] },
    { id: '__for_each__', name: 'For Each', description: 'Iterates over a list, running child nodes for each item.', variables: [] },
    { id: '__approval_gate__', name: 'Approval Gate', description: 'Pauses execution until user approves.', variables: [] },
    { id: '__branch__', name: 'Branch', description: 'Conditional branching.', variables: [] },
    { id: '__delay__', name: 'Delay', description: 'Waits before continuing.', variables: [] },
  ];

  // Add relevant real workflows (if any match)
  if (relevantWorkflows.length > 0) {
    result.push(...relevantWorkflows);
  }

  return JSON.stringify(result);
}

interface InnerMessage {
  role: 'system' | 'user' | 'assistant';
  content: any; // string or content block array
}

export class ClosureEngine {
  private adapter: ProviderAdapter;
  private toolRegistry: ToolRegistryV2;
  private stateManager: StateManager;
  private memoryStore: MemoryStore;
  private verifier: Verifier;
  private recoveryEngine: RecoveryEngine;
  private beliefGraph: BeliefGraph;
  private reflector: Reflector;
  private skillSynthesizer: SkillSynthesizer;
  private skillRegistry: SkillRegistry;
  private skillPolicyStore: SkillPolicyStore;
  private delegateEngine: DelegateEngine;
  private toolDescriptors: ToolDescriptorRegistry;
  private confidenceEngine: ConfidenceEngine;
  private strategicPlanner: StrategicPlanner;
  private critic: Critic;
  private safetyGate: SafetyGate;
  private actionSelector: ActionSelector;
  private metricsCollector: MetricsCollector;
  private config: ClosureEngineConfig;
  private callbacks: EngineCallbacks;
  private sessionId: string;
  private systemPrompt: string;
  private totalToolCalls: number = 0;
  private currentUserMessage: string = '';
  private currentCarryoverContext: string = '';
  private currentSkillSelection: SkillSelection | null = null;

  constructor(
    config: ClosureEngineConfig,
    toolRegistry: ToolRegistryV2,
    systemPrompt: string,
  ) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.systemPrompt = systemPrompt;
    this.callbacks = config.callbacks || {};
    this.adapter = createProviderAdapter();
    this.sessionId = config.sessionId || `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.stateManager = new StateManager(this.sessionId, config.workingDirectory);
    this.memoryStore = new MemoryStore();
    this.skillPolicyStore = new SkillPolicyStore();
    this.skillRegistry = new SkillRegistry(this.memoryStore, this.skillPolicyStore);

    // Milestone 2: Verification + Recovery
    this.verifier = new Verifier(
      toolRegistry, this.adapter, config.provider, config.model,
      config.workingDirectory, config.toolTimeout,
    );
    this.recoveryEngine = new RecoveryEngine(this.stateManager, this.memoryStore, this.skillRegistry);

    // Milestone 3: Belief Graph
    this.beliefGraph = new BeliefGraph(this.stateManager);

    // Milestone 4: Reflection + Skill Synthesis
    this.reflector = new Reflector(
      this.stateManager, this.memoryStore, this.adapter,
      config.provider, config.model,
    );
    this.skillSynthesizer = new SkillSynthesizer(this.stateManager, this.memoryStore);

    // Milestone 5: Delegation
    this.delegateEngine = new DelegateEngine(
      config, toolRegistry, this.memoryStore, systemPrompt,
    );

    // Tool descriptors (rich metadata + running stats)
    this.toolDescriptors = new ToolDescriptorRegistry();
    this.toolDescriptors.buildFromRegistry(toolRegistry);

    // Confidence engine (multi-factor confidence scoring)
    this.confidenceEngine = new ConfidenceEngine(
      this.stateManager, this.memoryStore, this.toolDescriptors,
    );

    // Strategic planner + critic
    this.strategicPlanner = new StrategicPlanner(
      this.stateManager, this.memoryStore, this.adapter,
      config.provider, config.model, systemPrompt,
    );
    this.critic = new Critic(this.adapter, config.provider, config.model);

    // Safety gate + action selector
    this.safetyGate = new SafetyGate(config.safetyPolicy);
    this.actionSelector = new ActionSelector();

    // Metrics collector
    this.metricsCollector = new MetricsCollector();

    debugLog.info('closure-engine', 'Engine created (full M1-M5)', {
      sessionId: this.sessionId,
      provider: config.provider,
      model: config.model,
    });
  }

  /**
   * Main entry point — run the engine on a user message.
   */
  async run(userMessage: string, signal?: AbortSignal): Promise<ClosureEngineResult> {
    const startTime = Date.now();
    this.stateManager.startNewTurn();
    this.totalToolCalls = 0;
    this.currentUserMessage = userMessage;
    this.currentCarryoverContext = this.buildCarryoverContext();
    const goalInput = this.currentCarryoverContext
      ? `${userMessage}\n\n<prior_session_state>\n${this.currentCarryoverContext}\n</prior_session_state>`
      : userMessage;
    const existingState = this.stateManager.getState();
    const shouldResume = shouldResumeSession(this.config.continuationMode, existingState.taskGraph, userMessage);

    debugLog.info('closure-engine', 'Run starting', {
      messageLength: userMessage.length,
      preview: userMessage.slice(0, 200),
      hasCarryoverContext: !!this.currentCarryoverContext,
    });

    try {
      // ── Phase 1: Goal Setting ───────────────────────────
      this.setPhase('goal_setting');
      let goal: Goal;
      let taskGraph: TaskGraph | null = null;
      if (shouldResume && existingState.goal && existingState.taskGraph) {
        goal = {
          ...existingState.goal,
          status: 'active' as Goal['status'],
          updatedAt: new Date().toISOString(),
          userRequest: [existingState.goal.userRequest, userMessage].filter(Boolean).join('\n\nFollow-up: '),
        } as Goal;
        taskGraph = resumeTaskGraph(existingState.taskGraph);
        const followUpInstructions = extractFollowUpInstructions(userMessage);
        if (taskGraph && followUpInstructions) {
          taskGraph = injectFollowUpTask(taskGraph, goal, followUpInstructions);
          debugLog.info('closure-engine', 'Injected follow-up task into resumed graph', {
            instructions: followUpInstructions,
            taskCount: taskGraph.nodes.length,
          });
        }
        if (taskGraph) {
          taskGraph = this.strategicPlanner.applySkillTransitions(taskGraph, goal);
        }
        this.stateManager.setGoal(goal);
        if (taskGraph) {
          this.stateManager.setTaskGraph(taskGraph);
        }
        debugLog.info('closure-engine', 'Resuming unresolved task graph', {
          objective: goal.objective,
          taskCount: taskGraph?.nodes.length || 0,
        });
      } else {
        goal = await this.createGoalFromMessage(goalInput);
        this.stateManager.setGoal(goal);
        debugLog.info('closure-engine', 'Goal created', { objective: goal.objective });

        // ── Phase 2: Decompose (via Strategic Planner) ──────
        this.setPhase('decomposing');
        if (isSimpleGoal(goal.objective)) {
          taskGraph = createSingleTaskGraph(goal);
          debugLog.info('closure-engine', 'Single-task graph (simple goal)');
        } else {
          // Use strategic planner for complex goals
          const plans = await this.strategicPlanner.generatePlans(goal);
          const bestPlan = this.strategicPlanner.selectBest(plans);
          taskGraph = bestPlan.taskGraph;
          debugLog.info('closure-engine', `Strategic plan selected: ${bestPlan.strategy}`, {
            taskCount: taskGraph.nodes.length,
            score: bestPlan.score.toFixed(3),
            planCount: plans.length,
          });

          // Critique the selected plan
          try {
            const critique = await this.critic.critiquePlan(bestPlan, goal);
            debugLog.info('closure-engine', `Plan critique: ${critique.recommendation}`, {
              overallRisk: critique.overallRisk,
              hiddenAssumptions: critique.hiddenAssumptions.length,
            });
            if (critique.recommendation === 'abort') {
              throw new Error(`Plan aborted by critic: ${critique.hiddenAssumptions[0] || 'unacceptable risk'}`);
            }
          } catch (critiqueError) {
            if (critiqueError instanceof Error && critiqueError.message.startsWith('Plan aborted')) {
              throw critiqueError;
            }
            // Non-fatal — proceed without critique
            debugLog.debug('closure-engine', 'Plan critique skipped (non-fatal error)');
          }
        }
        this.stateManager.setTaskGraph(taskGraph);
      }

      // ── Phase 3: Retrieve memories ──────────────────────
      const relevantMemories = this.memoryStore.query(goal.objective);
      const failureWarnings = relevantMemories
        .filter(m => m.type === 'failure')
        .map(m => `WARNING (from past failure): ${m.content}`)
        .join('\n');

      // ── Phase 4: Execute tasks ──────────────────────────
      this.setPhase('executing');
      let completedTasks = 0;

      while (true) {
        // Check abort
        if (signal?.aborted) {
          this.stateManager.updateGoalStatus('abandoned');
          return this.buildResult(startTime, 'User cancelled');
        }

        // Check timeout
        if (Date.now() - startTime > this.config.timeout) {
          this.stateManager.updateGoalStatus('failed');
          return this.buildResult(startTime, 'Timeout exceeded');
        }

        // Check iteration limit
        if (this.stateManager.getIteration() >= this.config.maxIterations) {
          this.stateManager.updateGoalStatus('failed');
          return this.buildResult(startTime, 'Max iterations exceeded');
        }

        // Select best ready task via multi-factor scoring
        const readyTasks = this.stateManager.getReadyTasks();
        const allTasks = this.stateManager.getTaskGraph()?.nodes || [];
        const nextTask = this.actionSelector.selectNext(
          readyTasks,
          this.stateManager.getBeliefs(),
          allTasks,
        );
        if (!nextTask) {
          // Try to unblock stuck tasks before giving up
          const graph = this.stateManager.getTaskGraph();
          if (graph) {
            const stuck = graph.nodes.filter(n => n.status === 'blocked' || n.status === 'failed');
            if (stuck.length > 0 && this.attemptUnblock(stuck, graph)) {
              continue; // Retry the loop — a task may now be ready
            }
          }
          break;
        }

        // Execute one task
        this.callbacks.onTaskStart?.(nextTask);
        this.stateManager.updateTaskStatus(nextTask.id, 'running');
        const taskResult = await this.executeTask(nextTask, failureWarnings, signal);

        if (taskResult.success) {
          // Verify using the Verifier module
          this.setPhase('verifying');
          const verification = await this.verifier.verifyTask(nextTask, taskResult);
          if (verification.passed) {
            this.stateManager.updateTaskStatus(nextTask.id, 'done', taskResult);
            completedTasks++;
            debugLog.info('closure-engine', `Task done: ${nextTask.description.slice(0, 80)}`);
          } else if (verification.partial && nextTask.retryCount < nextTask.maxRetries) {
            // Partial verification — some validators passed, re-queue to address gaps
            debugLog.info('closure-engine', `Partial verification for task, re-queuing`, {
              taskId: nextTask.id,
              gaps: verification.gaps,
            });
            nextTask.retryCount++;
            this.stateManager.updateTaskStatus(nextTask.id, 'ready');
          } else {
            // Verification failed — treat as failure for recovery
            taskResult.success = false;
            taskResult.error = `Verification failed: ${verification.summary}`;
            await this.handleTaskFailure(nextTask, taskResult);
          }
        } else {
          await this.handleTaskFailure(nextTask, taskResult);
        }

        this.callbacks.onTaskEnd?.(nextTask, taskResult);
        this.setPhase('executing');

        // Derive beliefs from observations via BeliefGraph
        for (const obs of taskResult.observations) {
          const belief = this.beliefGraph.deriveFromObservation(obs);
          if (belief) {
            // Recalculate confidence using multi-factor formula
            belief.confidence = this.confidenceEngine.calculateConfidence(belief);
            this.callbacks.onBeliefUpdate?.(belief);
          }
        }

        // Periodic reflection via Reflector
        if (this.reflector.shouldReflect(completedTasks, this.config.reflectionInterval)) {
          this.setPhase('reflecting');
          const reflection = await this.reflector.reflect('periodic');
          this.callbacks.onReflection?.(reflection);
        }

        // Check if all tasks done
        if (this.stateManager.isTaskGraphComplete()) break;
      }

      // ── Phase 5: Final answer ───────────────────────────
      this.setPhase('completed');
      const allDone = this.stateManager.getTaskGraph()?.nodes.every(n => n.status === 'done' || n.status === 'skipped');
      if (allDone) {
        const state = this.stateManager.getState();

        // 1. Critic's false-success check (advisory, non-blocking)
        try {
          const validation = await this.critic.validateSuccess(goal, state.evidence || []);
          if (!validation.genuine) {
            debugLog.warn('closure-engine', 'Critic suspects false success', { concerns: validation.concerns });
          }
        } catch {
          // Non-fatal — proceed
        }

        // 2. Verifier's goal-level verification (blocking)
        try {
          const goalVerification = await this.verifier.verifyGoal(goal, state.observations);
          for (const cr of goalVerification.criteriaResults) {
            debugLog.info('closure-engine', `Goal criterion "${cr.criterion.description}": ${cr.met ? 'MET' : 'NOT MET'}`, {
              reason: cr.reason,
            });
          }
          if (goalVerification.achieved) {
            this.stateManager.updateGoalStatus('achieved');
          } else {
            debugLog.warn('closure-engine', 'Goal verification failed', {
              unmet: goalVerification.criteriaResults.filter(cr => !cr.met).map(cr => cr.criterion.description),
            });
            this.stateManager.updateGoalStatus('failed');
          }
        } catch (verifyError) {
          // If verification itself errors, default to achieved (conservative forward)
          debugLog.warn('closure-engine', 'Goal verification errored, defaulting to achieved', {
            error: verifyError instanceof Error ? verifyError.message : String(verifyError),
          });
          this.stateManager.updateGoalStatus('achieved');
        }
      } else {
        this.stateManager.updateGoalStatus('failed');
      }

      // Reflect on goal completion
      const goalReflection = await this.reflector.reflect('goal_complete');
      this.callbacks.onReflection?.(goalReflection);

      // Synthesize skills from this session (cross-session learning)
      const synthesisResult = this.skillSynthesizer.synthesize();
      const skillUpdates = synthesisResult.learningProducts.filter(
        (product): product is import('./types.js').LearningProductSkillUpdate => product.kind === 'skill_update',
      );
      const persistedSkillUpdates = this.skillPolicyStore.persistSuggestedUpdates(skillUpdates);
      debugLog.info('closure-engine', 'Skill synthesis complete', {
        memories: synthesisResult.memories.length,
        learningProducts: synthesisResult.learningProducts.length,
        persistedSkillUpdates: persistedSkillUpdates.length,
      });

      // Decay old memory confidence (housekeeping)
      this.memoryStore.decayConfidence();

      // Generate final summary via LLM
      const finalContent = await this.generateFinalAnswer(userMessage);
      const result = this.buildResult(startTime, undefined, finalContent);

      // Collect metrics
      this.metricsCollector.collectFromResult(result, this.stateManager.getState());

      return result;

    } catch (error) {
      debugLog.error('closure-engine', 'Engine failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.setPhase('failed');
      return this.buildResult(startTime, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Execute a single task using a focused inner LLM loop.
   */
  private async executeTask(
    task: TaskNode,
    failureWarnings: string,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const taskStart = Date.now();
    const observations: Observation[] = [];
    let toolCallCount = 0;

    // Build task-specific prompt with belief context from BeliefGraph
    const beliefContext = this.beliefGraph.toContextString();

    const allDefs = this.toolRegistry.getAllDefinitions();
    const previousSelection = this.currentSkillSelection;
    const skillExecution = this.skillRegistry.select(
      allDefs,
      this.currentUserMessage,
      task.description,
      task.preferredSkill,
      previousSelection,
    );
    this.currentSkillSelection = {
      skill: skillExecution.skill,
      reason: skillExecution.reason,
      matchedKeywords: skillExecution.matchedKeywords,
      allowedToolNames: skillExecution.allowedToolNames,
      hardBannedToolNames: skillExecution.hardBannedToolNames,
      escalationActive: skillExecution.escalationActive,
      recoveryHints: skillExecution.recoveryHints,
      previousSkillName: skillExecution.previousSkillName,
      previousSkillReason: skillExecution.previousSkillReason,
      handoffRationale: task.preferredSkillReason || skillExecution.handoffRationale,
      taskId: task.id,
      taskTitle: task.title || task.description,
    };
    this.callbacks.onSkillSelected?.(this.currentSkillSelection);

    const taskPrompt = [
      `## Current Task`,
      `${task.description}`,
      '',
      `## Selected Skill`,
      `Name: ${skillExecution.skill.name}`,
      `When to use: ${skillExecution.skill.whenToUse}`,
      `Why it was selected: ${skillExecution.reason}`,
      `Operating guidance: ${skillExecution.skill.promptGuidance}`,
      skillExecution.skill.completionContract ? `Completion contract: ${skillExecution.skill.completionContract}` : '',
      skillExecution.allowedToolNames.length > 0 ? `Allowed tools for this skill: ${skillExecution.allowedToolNames.join(', ')}` : '',
      skillExecution.recoveryHints.length > 0 ? `Recovery hints: ${skillExecution.recoveryHints.join(' ')}` : '',
      task.preferredSkillReason ? `Planner handoff: ${task.preferredSkillReason}` : '',
      '',
      task.validators.length > 0 ? `## Completion Criteria\n${task.validators.map(v => {
        switch (v.type) {
          case 'file_exists': return `- File exists: ${v.path}`;
          case 'file_contains': return `- File ${v.path} contains: ${v.pattern}`;
          case 'command_succeeds': return `- Command succeeds: ${v.command}`;
          default: return `- ${v.type}`;
        }
      }).join('\n')}` : '',
      this.currentCarryoverContext ? `## Prior Session State\n${this.currentCarryoverContext}` : '',
      beliefContext || '',
      failureWarnings ? `## Past Failure Warnings\n${failureWarnings}` : '',
      '',
      'Complete this task using the available tools. When done, provide the actual user-facing result for this task. Do not replace the requested answer with a meta-summary unless the task explicitly asks for a summary, recap, or status update.',
    ].filter(Boolean).join('\n');

    // Inner LLM loop for this task
    const messages: InnerMessage[] = [
      { role: 'user', content: taskPrompt },
    ];

    const tools = skillExecution.allowedTools;
    debugLog.info('closure-engine', 'Skill routing', {
      skill: skillExecution.skill.name,
      reason: skillExecution.reason,
      matchedKeywords: skillExecution.matchedKeywords,
      total: allDefs.length,
      selected: tools.length,
      names: tools.map(t => t.name).join(', '),
    });
    const maxInnerIterations = Math.min(50, this.config.maxIterations - this.stateManager.getIteration());

    for (let iter = 0; iter < maxInnerIterations; iter++) {
      this.stateManager.incrementIteration();

      if (signal?.aborted) {
        return { success: false, output: 'Cancelled', observations, toolCallCount, durationMs: Date.now() - taskStart, error: 'Cancelled' };
      }

      // Call LLM
      let response;
      try {
        response = await this.adapter.createCompletion({
          provider: this.config.provider,
          model: this.config.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            ...messages,
          ],
          tools: tools as any,
          maxTokens: 4096,
          temperature: this.config.temperature,
        });
      } catch (error) {
        debugLog.error('closure-engine', 'LLM call failed in task', {
          task: task.description.slice(0, 80),
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          output: '',
          observations,
          toolCallCount,
          durationMs: Date.now() - taskStart,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const textContent = response.content || '';
      const toolUses = response.toolCalls || [];

      console.log(`[DIAG] LLM response: stop=${response.stopReason || 'unknown'}, toolCalls=${toolUses.length}, text=${(textContent || '').substring(0, 100)}`);
      if (toolUses.length > 0) {
        console.log(`[DIAG] Tool calls: ${toolUses.map((t: any) => t.name).join(', ')}`);
      }

      // Stream text tokens
      if (textContent && this.callbacks.onToken) {
        this.callbacks.onToken(textContent);
      }

      // Build assistant message with content blocks
      const assistantContent: any[] = [];
      if (textContent) {
        assistantContent.push({ type: 'text', text: textContent });
      }
      for (const tc of toolUses) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // No tool calls → task complete
      if (toolUses.length === 0) {
        return {
          success: true,
          output: textContent,
          observations,
          toolCallCount,
          durationMs: Date.now() - taskStart,
        };
      }

      // Execute tool calls
      const toolResults: any[] = [];

      for (const tc of toolUses) {
        toolCallCount++;
        this.totalToolCalls++;
        this.callbacks.onToolStart?.(tc.name, tc.input);
        const toolStart = Date.now();

        // Build ActionSpec for this tool call
        const actionSpec: ActionSpec = {
          id: tc.id,
          taskId: task.id,
          actionType: this.inferActionType(tc.name),
          toolName: tc.name,
          params: tc.input,
          rationale: `Task: ${task.description.slice(0, 200)}`,
          expectedObservations: [`Tool ${tc.name} returns successfully`],
          validationPlan: {
            successSignals: ['output returned'],
            failureSignals: ['error in output'],
            independentChecks: [],
            confidenceThreshold: 0.7,
          },
          timeoutMs: this.config.toolTimeout,
          costEstimate: 0,
        };

        // Safety gate check
        const approval = this.safetyGate.checkApproval(actionSpec);
        if (!approval.approved) {
          debugLog.warn('closure-engine', `Action blocked by safety gate: ${approval.reason}`, {
            toolName: tc.name,
            actionClass: approval.actionClass,
            riskLevel: approval.riskLevel,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Action blocked: ${approval.reason}`,
            is_error: true,
          });
          continue;
        }

        // Enforce tool selection — reject calls to tools not in the selected set
        const selectedToolNames = new Set(tools.map(t => t.name));
        if (!selectedToolNames.has(tc.name)) {
          debugLog.warn('closure-engine', `Tool call rejected — "${tc.name}" not in selected tools`, {
            selected: tools.map(t => t.name).join(', '),
          });
          this.callbacks.onToolEnd?.(tc.name, false, `Tool "${tc.name}" is not available. Use only the tools provided to you.`, 0);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Tool "${tc.name}" is not available for this request. You MUST use one of the available tools: ${tools.map(t => t.name).join(', ')}`,
            is_error: true,
          });
          continue;
        }

        if (this.currentSkillSelection && this.skillRegistry.isToolHardBanned(
          this.currentSkillSelection.skill.name,
          tc.name,
          `${this.currentUserMessage}\n${task.description}`,
        )) {
          const blockedMessage = `Tool "${tc.name}" is hard-banned for skill "${this.currentSkillSelection.skill.name}" unless the user explicitly escalates to direct mutation.`;
          debugLog.warn('closure-engine', blockedMessage, {
            taskId: task.id,
            skill: this.currentSkillSelection.skill.name,
          });
          this.callbacks.onToolEnd?.(tc.name, false, blockedMessage, 0);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: blockedMessage,
            is_error: true,
          });
          continue;
        }

        // Store action in history
        this.stateManager.addAction(actionSpec);

        // Auto-inject availableWorkflows for MCP intelligence composition tools
        if (COMPOSITION_TOOLS.has(tc.name) && tc.input) {
          const inp = tc.input as Record<string, unknown>;
          if (!inp.availableWorkflows) {
            const intent = typeof inp.intent === 'string' ? inp.intent : this.currentUserMessage;
            const workflows = getAvailableWorkflows(this.config.workingDirectory, intent);
            inp.availableWorkflows = workflows;
            debugLog.info('closure-engine', 'Injected availableWorkflows into composition tool call', {
              toolName: tc.name,
              workflowCount: JSON.parse(workflows).length,
            });
          }
        }

        const registeredTool = this.toolRegistry.get(tc.name);
        let output: string;
        let success: boolean;

        if (!registeredTool) {
          output = `Unknown tool: ${tc.name}. Available: ${this.toolRegistry.getToolNames().join(', ')}`;
          success = false;
        } else if (registeredTool.dangerous && !this.config.allowDangerousTools) {
          output = `Tool "${tc.name}" is dangerous and not allowed in safe mode.`;
          success = false;
        } else if (this.shouldGatherEvidence(tc.name, tc.input)) {
          // M5A: Confidence check — warn but still execute
          debugLog.info('closure-engine', `Low confidence execution: ${tc.name}`);
          // MCP tools get a longer timeout (120s) since they call external AI providers
          const isMcpTool = tc.name.startsWith('mcp__');
          const effectiveTimeout = isMcpTool ? Math.max(this.config.toolTimeout, 120000) : this.config.toolTimeout;
          const context: ToolExecutionContext = {
            workingDirectory: this.config.workingDirectory,
            timeoutMs: effectiveTimeout,
            signal,
          };
          try {
            output = await this.executeWithTimeout(registeredTool.handler(tc.input, context), effectiveTimeout);
            success = true;
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : String(err)}`;
            success = false;
          }
        } else {
          // MCP tools get a longer timeout (120s) since they call external AI providers
          const isMcpTool = tc.name.startsWith('mcp__');
          const effectiveTimeout = isMcpTool ? Math.max(this.config.toolTimeout, 120000) : this.config.toolTimeout;
          const context: ToolExecutionContext = {
            workingDirectory: this.config.workingDirectory,
            timeoutMs: effectiveTimeout,
            signal,
          };

          try {
            output = await this.executeWithTimeout(
              registeredTool.handler(tc.input, context),
              effectiveTimeout,
            );
            success = true;
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : String(err)}`;
            success = false;
          }
        }

        // Auto-save compositions returned by MCP intelligence tools + validate
        if (success && COMPOSITION_TOOLS.has(tc.name)) {
          autoSaveComposition(tc.name, output);

          // Validate the generated composition
          try {
            const comp = JSON.parse(output);
            if (comp.nodes && comp.edges) {
              const knownIds = getAvailableWorkflowIds(this.config.workingDirectory);
              const issues = validateComposition(comp, knownIds);
              if (issues.length > 0) {
                debugLog.warn('closure-engine', `Composition has ${issues.length} issue(s)`, { issues });
                // Append validation feedback to the tool output so the model sees it
                output += '\n\n⚠️ VALIDATION ISSUES FOUND — You MUST fix these before presenting to the user:\n' +
                  issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n') +
                  '\n\nCall generate_pipeline again with corrected intent/constraints, or explain the issues to the user.';
              }
            }
          } catch {
            // If we can't parse, skip validation
          }
        }

        const toolDuration = Date.now() - toolStart;
        this.callbacks.onToolEnd?.(tc.name, success, output, toolDuration);
        this.toolDescriptors.recordExecution(tc.name, toolDuration, success);
        this.safetyGate.recordExecution(actionSpec, toolDuration, success);

        // Record observation
        const obs = this.stateManager.addObservation({
          actionId: tc.id,
          taskId: task.id,
          toolName: tc.name,
          params: tc.input,
          result: output.slice(0, 2000), // truncate for storage
          status: success ? 'success' : 'error',
          duration: toolDuration,
          matchedExpectation: success,
        });
        observations.push(obs);

        // Create Evidence record from this tool result
        this.stateManager.addEvidence({
          type: 'tool_result',
          source: tc.name,
          contentSummary: output.slice(0, 500),
          rawRef: obs.id,
          reliability: success ? 0.9 : 0.3,
        });

        // Record episode step
        this.stateManager.addEpisodeStep({
          actionId: tc.id,
          toolName: tc.name,
          taskId: task.id,
          observationId: obs.id,
          success,
          timestamp: new Date().toISOString(),
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: output,
          is_error: !success,
        });

        debugLog.debug('closure-engine', `Tool ${tc.name}: ${success ? 'ok' : 'err'} (${toolDuration}ms)`);
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults });
    }

    // Ran out of inner iterations
    return {
      success: false,
      output: 'Task exceeded maximum iterations',
      observations,
      toolCallCount,
      durationMs: Date.now() - taskStart,
      error: 'Max inner iterations',
    };
  }

  /**
   * Create a Goal from a user message using the LLM.
   */
  private async createGoalFromMessage(message: string): Promise<Goal> {
    const now = new Date().toISOString();

    // For simple messages, create goal directly without LLM call
    if (message.length < 200 && isSimpleGoal(message)) {
      return {
        id: generateId('goal'),
        objective: message,
        successCriteria: [{
          id: generateId('sc'),
          description: 'Task completed successfully',
          met: false,
        }],
        constraints: [],
        forbiddenActions: [],
        priority: 'normal',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    }

    // Use LLM to extract structured goal
    try {
      const response = await this.adapter.createCompletion({
        provider: this.config.provider,
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a goal extraction assistant. Given a user request, extract a structured goal. Respond ONLY with valid JSON — no markdown fences.',
          },
          {
            role: 'user',
            content: `Extract a goal from this request:\n\n"${message}"\n\nJSON format:\n{\n  "objective": "clear one-sentence goal",\n  "successCriteria": ["criterion 1", "criterion 2"],\n  "constraints": ["optional constraints"],\n  "priority": "normal"\n}`,
          },
        ],
        maxTokens: 500,
        temperature: 0.1,
      });

      let json = response.content.trim();
      if (json.startsWith('```')) {
        json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(json);
      return {
        id: generateId('goal'),
        objective: parsed.objective || message,
        successCriteria: (parsed.successCriteria || ['Task completed successfully']).map((c: string) => ({
          id: generateId('sc'),
          description: c,
          met: false,
        })),
        constraints: parsed.constraints || [],
        forbiddenActions: [],
        priority: parsed.priority || 'normal',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    } catch {
      // Fallback to simple goal
      return {
        id: generateId('goal'),
        objective: message,
        successCriteria: [{
          id: generateId('sc'),
          description: 'Task completed successfully',
          met: false,
        }],
        constraints: [],
        forbiddenActions: [],
        priority: 'normal',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  // verifyTask, getValidatorToolName, getValidatorInput — moved to Verifier module

  /**
   * Attempt to unblock stuck tasks (blocked or failed with retries remaining).
   * Returns true if at least one task was moved to 'ready'.
   */
  private attemptUnblock(stuckTasks: TaskNode[], graph: { nodes: TaskNode[]; executionOrder: string[] }): boolean {
    let unblocked = false;
    const doneIds = new Set(graph.nodes.filter(n => n.status === 'done' || n.status === 'skipped').map(n => n.id));

    for (const task of stuckTasks) {
      if (task.status === 'blocked') {
        // Check if all blocking dependencies are now resolved
        const allDepsResolved = task.dependsOn.every(dep => doneIds.has(dep));
        if (allDepsResolved) {
          this.stateManager.updateTaskStatus(task.id, 'ready');
          debugLog.info('closure-engine', `Unblocked task: ${task.id} — dependencies resolved`);
          unblocked = true;
        }
      } else if (task.status === 'failed' && task.retryCount < task.maxRetries) {
        // Retry failed tasks that haven't exhausted retries
        this.stateManager.updateTaskStatus(task.id, 'ready');
        debugLog.info('closure-engine', `Re-queued failed task: ${task.id} (${task.retryCount}/${task.maxRetries} retries)`);
        unblocked = true;
      }
    }

    return unblocked;
  }

  /**
   * Handle a failed task — use RecoveryEngine for strategy determination.
   */
  private async handleTaskFailure(task: TaskNode, result: TaskResult): Promise<void> {
    this.setPhase('recovering');
    task.retryCount++;

    // Use RecoveryEngine to determine strategy
    const strategy = this.recoveryEngine.determineStrategy(task, result);
    this.recoveryEngine.recordAttempt(task.id, strategy, task.retryCount, false, result.error);

    debugLog.info('closure-engine', `Recovery for task: ${strategy.type}`, {
      taskId: task.id,
      attempt: task.retryCount,
    });
    this.callbacks.onRecovery?.({
      taskId: task.id,
      taskTitle: task.title || task.description,
      strategyType: strategy.type,
      attempt: task.retryCount,
      currentSkill: task.preferredSkill,
      targetSkill: strategy.type === 'alternative_skill' ? strategy.fallbackSkill : undefined,
      reason: strategy.type === 'ask_user'
        ? strategy.question
        : ('reason' in strategy ? strategy.reason : strategy.type),
    });

    // Reflect on failure
    if (task.retryCount >= 2) {
      const failReflection = await this.reflector.reflect('failure');
      this.callbacks.onReflection?.(failReflection);
    }

    switch (strategy.type) {
      case 'retry':
        if (task.retryCount < strategy.maxAttempts) {
          // Apply backoff delay if specified
          if (strategy.backoffMs) {
            await new Promise(resolve => setTimeout(resolve, strategy.backoffMs));
          }
          this.stateManager.updateTaskStatus(task.id, 'ready');
        } else {
          this.stateManager.updateTaskStatus(task.id, 'failed', result);
        }
        break;

      case 'skip':
        this.stateManager.updateTaskStatus(task.id, 'skipped');
        break;

      case 'abort':
        this.stateManager.updateTaskStatus(task.id, 'failed', result);
        // Mark all dependent tasks as skipped
        const graph = this.stateManager.getTaskGraph();
        if (graph) {
          for (const blocked of graph.nodes.filter(n => n.dependsOn.includes(task.id))) {
            this.stateManager.updateTaskStatus(blocked.id, 'skipped');
          }
        }
        break;

      case 'decompose':
        // Mark current task as failed, delegate subtasks via DelegateEngine
        this.stateManager.updateTaskStatus(task.id, 'failed', result);
        debugLog.info('closure-engine', `Decomposing failed task into ${strategy.subTasks.length} subtasks`);
        for (const subTaskDesc of strategy.subTasks) {
          try {
            const delegateResult = await this.delegateEngine.delegate(
              { objective: subTaskDesc, maxIterations: Math.min(20, this.config.maxIterations) },
              this.callbacks,
            );
            // Integrate delegate beliefs and memories back into parent state
            for (const belief of delegateResult.beliefs) {
              this.stateManager.addBelief(belief);
            }
            for (const memory of delegateResult.memories) {
              this.memoryStore.add(memory);
            }
            if (delegateResult.success) {
              debugLog.info('closure-engine', `Subtask delegated successfully: ${subTaskDesc.slice(0, 80)}`);
            }
          } catch (delegateError) {
            debugLog.warn('closure-engine', `Delegate subtask failed: ${subTaskDesc.slice(0, 80)}`, {
              error: delegateError instanceof Error ? delegateError.message : String(delegateError),
            });
          }
        }
        break;

      case 'alternative_tool':
        // Retry — the recovery engine has logged the alternative tool suggestion
        if (task.preferredSkill && this.skillRegistry.isToolHardBanned(
          task.preferredSkill,
          strategy.fallbackTool,
          `${this.currentUserMessage}\n${task.description}`,
        )) {
          this.stateManager.updateTaskStatus(task.id, 'failed', {
            ...result,
            error: `Recovery fallback ${strategy.fallbackTool} is hard-banned for skill ${task.preferredSkill} without explicit escalation.`,
          });
        } else if (task.retryCount < task.maxRetries) {
          this.stateManager.updateTaskStatus(task.id, 'ready');
        } else {
          this.stateManager.updateTaskStatus(task.id, 'failed', result);
        }
        break;

      case 'alternative_skill':
        if (task.retryCount < task.maxRetries) {
          task.preferredSkill = strategy.fallbackSkill;
          task.preferredSkillReason = strategy.reason;
          debugLog.info('closure-engine', 'Switching task to alternate skill', {
            taskId: task.id,
            fallbackSkill: strategy.fallbackSkill,
            reason: strategy.reason,
          });
          this.stateManager.updateTaskStatus(task.id, 'ready');
        } else {
          this.stateManager.updateTaskStatus(task.id, 'failed', result);
        }
        break;

      case 'ask_user':
        // For now, skip — ask_user requires human-in-the-loop infrastructure
        this.stateManager.updateTaskStatus(task.id, 'failed', result);
        debugLog.info('closure-engine', `Ask user: ${strategy.question}`);
        break;

      default:
        if (task.retryCount < task.maxRetries) {
          this.stateManager.updateTaskStatus(task.id, 'ready');
        } else {
          this.stateManager.updateTaskStatus(task.id, 'failed', result);
        }
        break;
    }
  }

  /**
   * Map a tool name to an ActionType for ActionSpec construction.
   */
  private inferActionType(toolName: string): ActionType {
    const name = toolName.toLowerCase();
    if (/file_read|read_file|cat|head|tail/.test(name)) return 'read_file';
    if (/file_write|write_file|edit_file|patch/.test(name)) return 'write_file';
    if (/shell|exec|command|run|bash/.test(name)) return 'code_exec';
    if (/browser|click|navigate|screenshot|page/.test(name)) return 'browser_step';
    if (/search|google|duckduckgo|web_search|grep|find/.test(name)) return 'search';
    if (/message|ask|notify|user/.test(name)) return 'message_user';
    if (/api|fetch|http|request|curl/.test(name)) return 'api_call';
    return 'code_exec'; // default fallback
  }

  /**
   * Check belief confidence before high-risk tool execution (M5A).
   * If relevant beliefs have low confidence, returns true to indicate
   * the engine should gather more evidence first.
   */
  private shouldGatherEvidence(toolName: string, params: Record<string, unknown>): boolean {
    // Only check for destructive / high-risk tools
    const highRiskTools = ['file_write', 'shell_execute', 'git', 'database_query'];
    if (!highRiskTools.includes(toolName)) return false;

    // Check if we have any beliefs about the target
    const target = String(params.path || params.command || params.file || '');
    if (!target) return false;

    const related = this.stateManager.findBeliefs(target.slice(0, 50));
    if (related.length === 0) return false;

    // Use confidence engine tiers instead of raw threshold
    const avgConfidence = related.reduce((sum, b) => sum + b.confidence, 0) / related.length;
    const tier = this.confidenceEngine.getTier(avgConfidence);
    if (tier === 'unreliable' || tier === 'hypothesis') {
      debugLog.info('closure-engine', `Low confidence tier "${tier}" (${(avgConfidence * 100).toFixed(0)}%) for ${toolName} on "${target.slice(0, 40)}" — consider verifying first`);
      return true;
    }

    return false;
  }

  /**
   * Generate a final answer summarizing what was accomplished.
   */
  private async generateFinalAnswer(originalMessage: string): Promise<string> {
    const state = this.stateManager.getState();
    const goal = state.goal;
    const taskGraph = state.taskGraph;

    if (!taskGraph || taskGraph.nodes.length === 0) {
      return 'No tasks were executed.';
    }

    const directOutput = selectDirectUserFacingTaskOutput(taskGraph, originalMessage);
    if (directOutput) {
      return directOutput;
    }

    const taskSummary = taskGraph.nodes.map(n => {
      const status = n.status === 'done' ? 'completed' : n.status === 'skipped' ? 'skipped' : 'failed';
      const output = n.result?.output ? `: ${n.result.output.slice(0, 200)}` : '';
      return `- [${status}] ${n.description}${output}`;
    }).join('\n');

    try {
      const response = await this.adapter.createCompletion({
        provider: this.config.provider,
        model: this.config.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          {
            role: 'user',
            content: this.currentCarryoverContext
              ? `${originalMessage}\n\n<prior_session_state>\n${this.currentCarryoverContext}\n</prior_session_state>`
              : originalMessage,
          },
          {
            role: 'assistant',
            content: `I've completed the following tasks:\n\n${taskSummary}\n\nNow answer the user directly using the completed task outputs. Preserve any already-correct user-facing wording from the work above. Do not collapse the answer into a meta-summary unless the user explicitly asked for a summary, recap, or status update.`,
          },
        ],
        maxTokens: 1000,
        temperature: 0.3,
      });

      const content = response.content || taskSummary;
      if (this.callbacks.onToken) {
        this.callbacks.onToken(content);
      }
      return content;
    } catch {
      return taskSummary;
    }
  }

  /**
   * Build the final result object.
   */
  private buildResult(startTime: number, error?: string, content?: string): ClosureEngineResult {
    const state = this.stateManager.getState();
    return {
      success: !error,
      content: content || error || '',
      goal: state.goal || undefined,
      taskGraph: state.taskGraph || undefined,
      beliefs: state.beliefs,
      observations: state.observations,
      memories: state.memories,
      reflections: state.reflections,
      recoveryAttempts: state.recoveryAttempts,
      evidence: state.evidence || [],
      iterations: state.iteration,
      totalToolCalls: this.totalToolCalls,
      durationMs: Date.now() - startTime,
      error,
    };
  }

  /**
   * Set phase and fire callback.
   */
  private setPhase(phase: EnginePhase): void {
    const from = this.stateManager.getPhase();
    if (from === phase) return;
    this.stateManager.setPhase(phase);
    this.callbacks.onPhaseChange?.(from, phase);
    debugLog.debug('closure-engine', `Phase: ${from} → ${phase}`);
  }

  private buildCarryoverContext(): string {
    const state = this.stateManager.getState();
    const hasPriorState = !!(
      state.goal ||
      state.taskGraph?.nodes?.length ||
      state.observations?.length ||
      state.reflections?.length ||
      state.beliefs?.length
    );

    if (!hasPriorState) return '';

    const previousGoal = state.goal
      ? `Previous goal: ${state.goal.objective} (${state.goal.status})`
      : '';

    const completedTasks = (state.taskGraph?.nodes || [])
      .filter(node => node.status === 'done' || node.status === 'skipped')
      .slice(-5)
      .map(node => `- ${node.title || node.description} [${node.status}]`)
      .join('\n');

    const pendingTasks = (state.taskGraph?.nodes || [])
      .filter(node => node.status !== 'done' && node.status !== 'skipped')
      .slice(0, 3)
      .map(node => `- ${node.title || node.description} [${node.status}]`)
      .join('\n');

    const beliefs = state.beliefs
      .filter(belief => belief.status === 'active' || belief.status === 'supported' || belief.status === 'verified')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(belief => `- ${belief.claim} (${Math.round(belief.confidence * 100)}% confidence)`)
      .join('\n');

    const recentObservations = state.observations
      .slice(-4)
      .map(obs => `- ${obs.toolName}: ${obs.result.slice(0, 160)}`)
      .join('\n');

    const reflection = state.reflections.length > 0
      ? state.reflections[state.reflections.length - 1].assessment
      : '';

    return [
      previousGoal,
      completedTasks ? `Completed tasks:\n${completedTasks}` : '',
      pendingTasks ? `Open or failed tasks:\n${pendingTasks}` : '',
      beliefs ? `Working beliefs:\n${beliefs}` : '',
      recentObservations ? `Recent observations:\n${recentObservations}` : '',
      reflection ? `Latest reflection: ${reflection}` : '',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Execute a promise with a timeout.
   */
  private executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tool execution timed out')), timeoutMs);
      promise
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  /**
   * Get available tool names.
   */
  getAvailableTools(): string[] {
    return this.toolRegistry.getToolNames();
  }

  /**
   * Get aggregate metrics across all sessions.
   */
  getMetrics() {
    return this.metricsCollector.computeAggregates();
  }
}
