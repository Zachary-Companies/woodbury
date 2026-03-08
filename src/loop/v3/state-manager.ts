/**
 * State Manager — File-based persistence for Closure Engine state.
 *
 * Stores full engine state at ~/.woodbury/data/closure-engine/sessions/<sessionId>/state.json
 * Also writes compatibility snapshots to .woodbury-work/ for slash command compat.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ClosureEngineState,
  Goal,
  TaskNode,
  TaskGraph,
  Belief,
  Observation,
  MemoryRecord,
  ReflectionRecord,
  RecoveryAttempt,
  EnginePhase,
  TaskResult,
  Evidence,
  BeliefEdge,
  BeliefEdgeType,
  ActionSpec,
  EpisodeStep,
} from './types.js';

const DATA_DIR = join(homedir(), '.woodbury', 'data', 'closure-engine');

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class StateManager {
  private state: ClosureEngineState;
  private stateDir: string;
  private stateFile: string;
  private workingDirectory: string;

  constructor(sessionId: string, workingDirectory: string) {
    this.workingDirectory = workingDirectory;
    this.stateDir = join(DATA_DIR, 'sessions', sessionId);
    this.stateFile = join(this.stateDir, 'state.json');

    // Try to load existing state or create fresh
    if (existsSync(this.stateFile)) {
      try {
        const raw = readFileSync(this.stateFile, 'utf-8');
        this.state = JSON.parse(raw);
      } catch {
        this.state = this.createFreshState(sessionId);
      }
    } else {
      this.state = this.createFreshState(sessionId);
    }
  }

  private createFreshState(sessionId: string): ClosureEngineState {
    const now = new Date().toISOString();
    return {
      sessionId,
      goal: null,
      taskGraph: null,
      beliefs: [],
      observations: [],
      memories: [],
      reflections: [],
      recoveryAttempts: [],
      evidence: [],
      beliefEdges: [],
      actionHistory: [],
      episodeSteps: [],
      iteration: 0,
      phase: 'idle',
      createdAt: now,
      updatedAt: now,
    };
  }

  // ── Getters ─────────────────────────────────────────────

  getState(): ClosureEngineState {
    return this.state;
  }

  getGoal(): Goal | null {
    return this.state.goal;
  }

  getTaskGraph(): TaskGraph | null {
    return this.state.taskGraph;
  }

  getBeliefs(): Belief[] {
    return this.state.beliefs.filter(b => b.status === 'active');
  }

  getObservations(): Observation[] {
    return this.state.observations;
  }

  getPhase(): EnginePhase {
    return this.state.phase;
  }

  getIteration(): number {
    return this.state.iteration;
  }

  // ── Goal ────────────────────────────────────────────────

  setGoal(goal: Goal): void {
    this.state.goal = goal;
    this.persist();
    this.writeGoalCompat(goal);
  }

  updateGoalStatus(status: Goal['status']): void {
    if (this.state.goal) {
      this.state.goal.status = status;
      this.state.goal.updatedAt = new Date().toISOString();
      this.persist();
    }
  }

  // ── Task Graph ──────────────────────────────────────────

  setTaskGraph(graph: TaskGraph): void {
    this.state.taskGraph = graph;
    this.persist();
    this.writePlanCompat(graph);
  }

  updateTaskStatus(taskId: string, status: TaskNode['status'], result?: TaskResult): void {
    if (!this.state.taskGraph) return;
    const node = this.state.taskGraph.nodes.find(n => n.id === taskId);
    if (!node) return;

    node.status = status;
    if (status === 'running') node.startedAt = new Date().toISOString();
    if (status === 'done' || status === 'failed' || status === 'skipped') {
      node.completedAt = new Date().toISOString();
    }
    if (result) node.result = result;

    this.persist();
  }

  getReadyTasks(): TaskNode[] {
    if (!this.state.taskGraph) return [];
    return this.state.taskGraph.nodes.filter(node => {
      if (node.status !== 'ready' && node.status !== 'pending') return false;
      // Check all dependencies are done
      const allDepsDone = node.dependsOn.every(depId => {
        const dep = this.state.taskGraph!.nodes.find(n => n.id === depId);
        return dep && (dep.status === 'done' || dep.status === 'skipped');
      });
      return allDepsDone;
    });
  }

  getNextTask(): TaskNode | null {
    const ready = this.getReadyTasks();
    return ready.length > 0 ? ready[0] : null;
  }

  isTaskGraphComplete(): boolean {
    if (!this.state.taskGraph) return true;
    return this.state.taskGraph.nodes.every(
      n => n.status === 'done' || n.status === 'skipped' || n.status === 'failed'
    );
  }

  // ── Beliefs ─────────────────────────────────────────────

  addBelief(belief: Omit<Belief, 'id' | 'createdAt'>): Belief {
    const full: Belief = {
      ...belief,
      id: generateId('belief'),
      createdAt: new Date().toISOString(),
    };
    this.state.beliefs.push(full);
    this.persist();
    return full;
  }

  invalidateBelief(beliefId: string, reason: string): void {
    const belief = this.state.beliefs.find(b => b.id === beliefId);
    if (belief) {
      belief.status = 'invalidated';
      belief.invalidatedAt = new Date().toISOString();
      belief.invalidatedBy = reason;
      this.persist();
    }
  }

  findBeliefs(keyword: string): Belief[] {
    const lower = keyword.toLowerCase();
    return this.state.beliefs.filter(
      b => b.status === 'active' && b.claim.toLowerCase().includes(lower)
    );
  }

  // ── Observations ────────────────────────────────────────

  addObservation(obs: Omit<Observation, 'id' | 'timestamp'>): Observation {
    const full: Observation = {
      ...obs,
      id: generateId('obs'),
      timestamp: new Date().toISOString(),
    };
    this.state.observations.push(full);
    // Keep observations bounded — keep last 200
    if (this.state.observations.length > 200) {
      this.state.observations = this.state.observations.slice(-200);
    }
    this.persist();
    return full;
  }

  // ── Reflections ─────────────────────────────────────────

  addReflection(reflection: Omit<ReflectionRecord, 'id' | 'timestamp'>): ReflectionRecord {
    const full: ReflectionRecord = {
      ...reflection,
      id: generateId('reflect'),
      timestamp: new Date().toISOString(),
    };
    this.state.reflections.push(full);
    this.persist();
    return full;
  }

  // ── Recovery ────────────────────────────────────────────

  addRecoveryAttempt(attempt: Omit<RecoveryAttempt, 'timestamp'>): RecoveryAttempt {
    const full: RecoveryAttempt = {
      ...attempt,
      timestamp: new Date().toISOString(),
    };
    this.state.recoveryAttempts.push(full);
    this.persist();
    return full;
  }

  getRecoveryAttemptsForTask(taskId: string): RecoveryAttempt[] {
    return this.state.recoveryAttempts.filter(a => a.taskId === taskId);
  }

  // ── Evidence ──────────────────────────────────────────────

  addEvidence(evidence: Omit<Evidence, 'id' | 'timestamp'>): Evidence {
    const full: Evidence = {
      ...evidence,
      id: generateId('ev'),
      timestamp: new Date().toISOString(),
    };
    // Default missing arrays for backward compat
    if (!this.state.evidence) this.state.evidence = [];
    this.state.evidence.push(full);
    this.persist();
    return full;
  }

  getEvidence(): Evidence[] {
    return this.state.evidence || [];
  }

  getEvidenceById(id: string): Evidence | undefined {
    return (this.state.evidence || []).find(e => e.id === id);
  }

  // ── Belief Edges ─────────────────────────────────────────

  addBeliefEdge(edge: Omit<BeliefEdge, 'id' | 'createdAt'>): BeliefEdge {
    const full: BeliefEdge = {
      ...edge,
      id: generateId('edge'),
      createdAt: new Date().toISOString(),
    };
    if (!this.state.beliefEdges) this.state.beliefEdges = [];
    this.state.beliefEdges.push(full);
    this.persist();
    return full;
  }

  getBeliefEdges(beliefId: string): BeliefEdge[] {
    return (this.state.beliefEdges || []).filter(
      e => e.fromBeliefId === beliefId || e.toBeliefId === beliefId
    );
  }

  getBeliefEdgesByType(type: BeliefEdgeType): BeliefEdge[] {
    return (this.state.beliefEdges || []).filter(e => e.type === type);
  }

  // ── Action History ───────────────────────────────────────

  addAction(action: ActionSpec): void {
    if (!this.state.actionHistory) this.state.actionHistory = [];
    this.state.actionHistory.push(action);
    this.persist();
  }

  getActionHistory(): ActionSpec[] {
    return this.state.actionHistory || [];
  }

  // ── Episode Steps ─────────────────────────────────────

  addEpisodeStep(step: Omit<EpisodeStep, 'id'>): EpisodeStep {
    if (!this.state.episodeSteps) this.state.episodeSteps = [];
    const record: EpisodeStep = {
      ...step,
      id: `es_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    };
    this.state.episodeSteps.push(record);
    this.persist();
    return record;
  }

  getEpisodeSteps(): EpisodeStep[] {
    return this.state.episodeSteps || [];
  }

  // ── Phase / Iteration ───────────────────────────────────

  setPhase(phase: EnginePhase): void {
    this.state.phase = phase;
    this.state.updatedAt = new Date().toISOString();
    this.persist();
  }

  incrementIteration(): number {
    this.state.iteration++;
    this.persist();
    return this.state.iteration;
  }

  // ── Persistence ─────────────────────────────────────────

  private persist(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch {
      // Silently fail — don't break the engine
    }
  }

  /** Write .woodbury-work/goal.json for slash command compat */
  private writeGoalCompat(goal: Goal): void {
    try {
      const compatDir = join(this.workingDirectory, '.woodbury-work');
      mkdirSync(compatDir, { recursive: true });
      const compat = {
        objective: goal.objective,
        successCriteria: goal.successCriteria.map(c => c.description),
        constraints: goal.constraints,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      };
      writeFileSync(join(compatDir, 'goal.json'), JSON.stringify(compat, null, 2));
    } catch {
      // ignore
    }
  }

  /** Write .woodbury-work/plan.json for slash command compat */
  private writePlanCompat(graph: TaskGraph): void {
    try {
      const compatDir = join(this.workingDirectory, '.woodbury-work');
      mkdirSync(compatDir, { recursive: true });
      const compat = {
        tasks: graph.nodes.map(n => ({
          id: n.id,
          subject: 'task',
          description: n.description,
          status: n.status === 'done' ? 'completed' : n.status === 'failed' ? 'failed' : n.status === 'running' ? 'in-progress' : 'pending',
          blockedBy: n.dependsOn,
          blocks: n.blocks,
          maxRetries: n.maxRetries,
          validators: n.validators,
        })),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(compatDir, 'plan.json'), JSON.stringify(compat, null, 2));
    } catch {
      // ignore
    }
  }
}
