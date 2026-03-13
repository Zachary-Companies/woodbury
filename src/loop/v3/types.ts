/**
 * Closure Engine V3 — Core Type Definitions
 *
 * Verification-first, memory-augmented agent runtime with goal decomposition,
 * structured beliefs, typed recovery, and learning.
 */

import type { RiskLevel } from '../../risk-gate.js';

// ── Goal ────────────────────────────────────────────────────

export interface SuccessCriterion {
  id: string;
  description: string;
  validator?: TaskValidator;
  met: boolean;
  /** How this criterion should be verified */
  verificationMethod?: string;
  /** Types of evidence required to satisfy this criterion */
  requiredEvidenceTypes?: string[];
  /** Numeric threshold for satisfaction (0.0–1.0) */
  threshold?: number;
}

export interface Goal {
  id: string;
  objective: string;
  successCriteria: SuccessCriterion[];
  constraints: string[];
  forbiddenActions: string[];
  priority: 'critical' | 'high' | 'medium' | 'normal' | 'low';
  status: 'open' | 'in_progress' | 'active' | 'blocked' | 'completed' | 'achieved' | 'failed' | 'escalated' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  /** Original user request text */
  userRequest?: string;
  /** How the engine interpreted the user request */
  interpretedObjective?: string;
  /** Conditions that should trigger escalation to the user */
  escalationCriteria?: string[];
}

// ── Task Graph ──────────────────────────────────────────────

export type TaskStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'skipped';

// ── Validation Plan ────────────────────────────────────────

export type IndependentCheckMethod =
  | 'api_readback'
  | 'ui_reinspection'
  | 'document_compare'
  | 'secondary_model'
  | 'rule_engine'
  | 'human_review';

export interface IndependentCheck {
  name: string;
  method: IndependentCheckMethod;
  description: string;
}

export interface ValidationPlan {
  successSignals: string[];
  failureSignals: string[];
  independentChecks: IndependentCheck[];
  confidenceThreshold: number;
}

export interface TaskValidator {
  type: 'file_exists' | 'file_contains' | 'command_succeeds' | 'command_output_matches' | 'test_file' | 'llm_judge';
  /** For file_exists / file_contains */
  path?: string;
  /** For file_contains / command_output_matches */
  pattern?: string;
  /** For command_succeeds / command_output_matches */
  command?: string;
  /** For test_file */
  testFile?: string;
  /** For llm_judge */
  criterion?: string;
  /** Structured validation plan for complex checks */
  validationPlan?: ValidationPlan;
}

export interface TaskResult {
  success: boolean;
  output: string;
  observations: Observation[];
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

export interface TaskNode {
  id: string;
  goalId: string;
  description: string;
  status: TaskStatus;
  dependsOn: string[];
  blocks: string[];
  maxRetries: number;
  retryCount: number;
  validators: TaskValidator[];
  result?: TaskResult;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** ID of parent task (for decomposed tasks) */
  parentId?: string;
  /** Short display title */
  title?: string;
  /** Who owns this task */
  owner?: 'engine' | 'delegate' | 'user';
  /** References to inputs this task depends on */
  inputRefs?: string[];
  /** References to outputs this task produces */
  outputRefs?: string[];
  /** Risk level for this task */
  riskLevel?: RiskLevel;
  /** Estimated cost in dollars */
  estimatedCost?: number;
  /** Planner-selected skill that should execute this task */
  preferredSkill?: string;
  /** Why the planner selected this skill */
  preferredSkillReason?: string;
}

export interface TaskGraph {
  nodes: TaskNode[];
  executionOrder: string[];
}

// ── Beliefs ─────────────────────────────────────────────────

export type EvidenceSource =
  | { type: 'tool_result'; toolName: string; actionId: string }
  | { type: 'user_input'; messageId: string }
  | { type: 'inference'; derivedFrom: string[] }
  | { type: 'memory'; memoryId: string };

export interface Belief {
  id: string;
  claim: string;
  confidence: number; // 0.0–1.0
  source: EvidenceSource;
  status: 'active' | 'hypothesis' | 'supported' | 'contradicted' | 'verified' | 'invalidated';
  createdAt: string;
  invalidatedAt?: string;
  invalidatedBy?: string;
  /** IDs of evidence records supporting this belief */
  evidenceIds?: string[];
  /** Structured triple: subject of the belief */
  subject?: string;
  /** Structured triple: predicate/relation */
  predicate?: string;
  /** Structured triple: object of the belief */
  object?: string;
}

// ── Observations ────────────────────────────────────────────

export interface Observation {
  id: string;
  actionId: string;
  taskId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: string;
  status: 'success' | 'error';
  duration: number;
  matchedExpectation: boolean;
  timestamp: string;
  /** Brief human-readable summary */
  summary?: string;
  /** Parsed/structured data from the result */
  structuredData?: Record<string, unknown>;
  /** Continuous score (0.0–1.0) for how well result matched expectations */
  matchedExpectationScore?: number;
}

// ── Memory ──────────────────────────────────────────────────

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'failure' | 'failure_pattern' | 'preference';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  confidence: number;
  triggerPattern?: string;
  avoidPattern?: string;
  accessCount: number;
  lastAccessed?: string;
  createdAt: string;
  updatedAt: string;
  /** Short display title */
  title?: string;
  /** Conditions under which this memory applies */
  applicabilityConditions?: string[];
}

// ── Evidence ────────────────────────────────────────────────

export type EvidenceType =
  | 'tool_result'
  | 'document'
  | 'api_response'
  | 'ui_observation'
  | 'user_input'
  | 'memory';

export interface Evidence {
  id: string;
  type: EvidenceType;
  source: string;
  contentSummary: string;
  rawRef?: string;
  reliability: number; // 0.0–1.0
  timestamp: string;
}

// ── Belief Edges ────────────────────────────────────────────

export type BeliefEdgeType =
  | 'supports'
  | 'contradicts'
  | 'depends_on'
  | 'derived_from'
  | 'requires_verification'
  | 'related_to'
  | 'updated_by';

export interface BeliefEdge {
  id: string;
  fromBeliefId: string;
  toBeliefId: string;
  type: BeliefEdgeType;
  weight: number; // 0.0–1.0
  createdAt: string;
}

// ── Action Spec ─────────────────────────────────────────────

export type ActionType =
  | 'api_call'
  | 'code_exec'
  | 'browser_step'
  | 'search'
  | 'read_file'
  | 'write_file'
  | 'message_user';

export interface ActionSpec {
  id: string;
  taskId: string;
  actionType: ActionType;
  toolName: string;
  params: Record<string, unknown>;
  rationale: string;
  expectedObservations: string[];
  validationPlan: ValidationPlan;
  rollbackPlan?: string;
  timeoutMs: number;
  costEstimate: number;
}

// ── Recovery ────────────────────────────────────────────────

export type RecoveryStrategy =
  | { type: 'retry'; maxAttempts: number; backoffMs?: number }
  | { type: 'alternative_tool'; fallbackTool: string; reason: string }
  | { type: 'alternative_skill'; fallbackSkill: string; reason: string }
  | { type: 'decompose'; subTasks: string[] }
  | { type: 'ask_user'; question: string }
  | { type: 'skip'; reason: string }
  | { type: 'abort'; reason: string };

export interface RecoveryAttempt {
  taskId: string;
  strategy: RecoveryStrategy;
  attempt: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

// ── Reflection ──────────────────────────────────────────────

export interface ReflectionRecord {
  id: string;
  trigger: 'periodic' | 'failure' | 'recovery' | 'user_request' | 'goal_complete';
  assessment: string;
  lessonsLearned: string[];
  planAdjustments: string[];
  newMemories: MemoryRecord[];
  timestamp: string;
  /** Root causes identified during reflection */
  rootCauseFindings?: string[];
  /** Notes on confidence calibration accuracy */
  confidenceCalibrationNotes?: string[];
  /** Skills that should be updated based on this reflection */
  recommendedSkillUpdates?: string[];
  /** Policies that should be updated based on this reflection */
  recommendedPolicyUpdates?: string[];
}

// ── Engine State ────────────────────────────────────────────

export type EnginePhase =
  | 'idle'
  | 'goal_setting'
  | 'decomposing'
  | 'executing'
  | 'verifying'
  | 'recovering'
  | 'reflecting'
  | 'completed'
  | 'failed';

export interface ClosureEngineState {
  sessionId: string;
  goal: Goal | null;
  taskGraph: TaskGraph | null;
  beliefs: Belief[];
  observations: Observation[];
  memories: MemoryRecord[];
  reflections: ReflectionRecord[];
  recoveryAttempts: RecoveryAttempt[];
  evidence: Evidence[];
  beliefEdges: BeliefEdge[];
  actionHistory: ActionSpec[];
  episodeSteps: EpisodeStep[];
  iteration: number;
  phase: EnginePhase;
  createdAt: string;
  updatedAt: string;
}

// ── Engine Result ───────────────────────────────────────────

export interface ClosureEngineResult {
  success: boolean;
  content: string;
  goal?: Goal;
  taskGraph?: TaskGraph;
  beliefs: Belief[];
  observations: Observation[];
  memories: MemoryRecord[];
  reflections: ReflectionRecord[];
  recoveryAttempts: RecoveryAttempt[];
  evidence: Evidence[];
  iterations: number;
  totalToolCalls: number;
  durationMs: number;
  error?: string;
}

// ── Skills ──────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse: string;
  promptGuidance: string;
  preferredSubagent?: 'explore' | 'plan' | 'execute';
  completionContract?: string;
  policy?: SkillPolicy;
}

export interface SkillPolicy {
  hardBannedTools: string[];
  escalationPhrases?: string[];
  defaultRecoveryHints?: string[];
}

export interface SkillSelection {
  skill: SkillDefinition;
  reason: string;
  matchedKeywords: string[];
  allowedToolNames: string[];
  hardBannedToolNames: string[];
  escalationActive: boolean;
  recoveryHints: string[];
  previousSkillName?: string;
  previousSkillReason?: string;
  handoffRationale?: string;
  taskId?: string;
  taskTitle?: string;
}

// ── Engine Callbacks ────────────────────────────────────────

export interface EngineCallbacks {
  onToken?: (token: string) => void;
  onAssistantTurn?: (event: {
    text: string;
    stopReason?: string;
    toolCalls: Array<{ id?: string; name: string; input?: any }>;
  }) => void;
  onToolStart?: (name: string, params?: any) => void;
  onToolEnd?: (name: string, success: boolean, result?: string, duration?: number) => void;
  onPhaseChange?: (from: EnginePhase, to: EnginePhase) => void;
  onTaskStart?: (task: TaskNode) => void;
  onTaskEnd?: (task: TaskNode, result: TaskResult) => void;
  onBeliefUpdate?: (belief: Belief) => void;
  onReflection?: (reflection: ReflectionRecord) => void;
  onSkillSelected?: (selection: SkillSelection) => void;
  onRecovery?: (event: {
    taskId: string;
    taskTitle: string;
    strategyType: RecoveryStrategy['type'];
    attempt: number;
    currentSkill?: string;
    targetSkill?: string;
    reason: string;
  }) => void;
}

// ── Engine Config ───────────────────────────────────────────

// ── Safety Policy ──────────────────────────────────────────

export type SafetyActionClass = 'read_only' | 'low_risk_write' | 'high_risk_write' | 'irreversible';

export interface SafetyPolicy {
  maxBudget: number;
  maxActionsPerMinute: number;
  dataAccessBoundaries: string[];
  requireApproval: SafetyActionClass[];
  auditAll: boolean;
}

// ── Engine Config ──────────────────────────────────────────

export interface ClosureEngineConfig {
  provider: 'openai' | 'anthropic' | 'groq';
  model: string;
  apiKey?: string;
  sessionId?: string;
  continuationMode?: 'off' | 'summary' | 'resume';
  maxIterations: number;
  maxTaskRetries: number;
  timeout: number;
  toolTimeout: number;
  temperature: number;
  workingDirectory: string;
  allowDangerousTools: boolean;
  streaming: boolean;
  reflectionInterval: number; // reflect every N completed tasks
  callbacks: EngineCallbacks;
  /** Safety policy for action gating */
  safetyPolicy?: Partial<SafetyPolicy>;
}

// ── Subagent Contracts ────────────────────────────────────

export interface VerificationTask {
  targetClaim: string;
  expectedEvidence: string[];
  availableEvidenceIds: string[];
  requiredConfidence: number;
}

export interface ClaimVerificationResult {
  targetClaim: string;
  verdict: 'verified' | 'supported' | 'inconclusive' | 'contradicted';
  confidence: number;
  reasoningSummary: string;
  supportingEvidenceIds: string[];
  contradictions: string[];
  nextChecks: string[];
}

// ── Episode Steps ────────────────────────────────────────

export interface EpisodeStep {
  id: string;
  actionId: string;
  toolName: string;
  taskId: string;
  observationId: string;
  success: boolean;
  timestamp: string;
}

// ── Learning Products ──────────────────────────────────────

export type LearningProductKind = 'validator' | 'heuristic' | 'task_template' | 'ranking_update' | 'skill_update';

export interface LearningProductValidator {
  kind: 'validator';
  /** The validator definition to reuse */
  validator: TaskValidator;
  /** When this validator applies (keyword pattern) */
  applicabilityPattern: string;
  /** Confidence that this validator is generally useful */
  confidence: number;
}

export interface LearningProductHeuristic {
  kind: 'heuristic';
  /** Condition that triggers this heuristic */
  condition: string;
  /** Recommended action */
  action: string;
  /** Source error pattern that generated this */
  sourceErrorPattern: string;
  confidence: number;
}

export interface LearningProductTaskTemplate {
  kind: 'task_template';
  /** Template name */
  name: string;
  /** Parameterized task descriptions */
  taskDescriptions: string[];
  /** Index-based dependency structure */
  dependencyMap: number[][];
  /** When to use this template (keyword pattern) */
  applicabilityPattern: string;
  confidence: number;
}

export interface LearningProductRankingUpdate {
  kind: 'ranking_update';
  /** Which scoring weight to adjust */
  factor: 'infoGain' | 'dependencyLeverage' | 'costPreference' | 'confidenceBoost' | 'riskPreference';
  /** Suggested delta (-0.1 to +0.1) */
  delta: number;
  /** Reason for adjustment */
  reason: string;
}

export interface LearningProductSkillUpdate {
  kind: 'skill_update';
  skillName: string;
  updateType: 'applicability' | 'recovery_hint';
  applicabilityPattern: string;
  guidance: string;
  confidence: number;
}

export interface SkillPolicyUpdateRecord {
  id: string;
  skillName: string;
  updateType: 'applicability' | 'recovery_hint' | 'policy';
  applicabilityPattern: string;
  guidance: string;
  confidence: number;
  source: 'synthesized' | 'manual';
  reviewStatus: 'suggested' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

export type LearningProduct =
  | LearningProductValidator
  | LearningProductHeuristic
  | LearningProductTaskTemplate
  | LearningProductRankingUpdate
  | LearningProductSkillUpdate;
