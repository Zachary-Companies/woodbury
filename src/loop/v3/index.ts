/**
 * Closure Engine V3 — Barrel Exports
 */

// Core engine
export { ClosureEngine } from './closure-engine.js';

// Types
export type {
  Goal,
  SuccessCriterion,
  TaskNode,
  TaskGraph,
  TaskStatus,
  TaskValidator,
  TaskResult,
  Belief,
  EvidenceSource,
  Observation,
  MemoryRecord,
  MemoryType,
  RecoveryStrategy,
  RecoveryAttempt,
  ReflectionRecord,
  EnginePhase,
  ClosureEngineState,
  ClosureEngineResult,
  EngineCallbacks,
  ClosureEngineConfig,
  // Phase 1: Evidence + ValidationPlan + ActionSpec + Belief Edges + Safety
  Evidence,
  EvidenceType,
  IndependentCheck,
  IndependentCheckMethod,
  ValidationPlan,
  BeliefEdge,
  BeliefEdgeType,
  ActionSpec,
  ActionType,
  SafetyActionClass,
  SafetyPolicy,
  // Subagent contracts
  VerificationTask,
  ClaimVerificationResult,
  // Episode steps
  EpisodeStep,
  // Learning products
  LearningProduct,
  LearningProductKind,
  LearningProductValidator,
  LearningProductHeuristic,
  LearningProductTaskTemplate,
  LearningProductRankingUpdate,
} from './types.js';

// State management
export { StateManager } from './state-manager.js';
export { MemoryStore } from './memory-store.js';

// Task graph
export {
  createPipelineLifecycleGraph,
  createSingleTaskGraph,
  decomposeGoal,
  isPipelineBuildObjective,
  isSimpleGoal,
  topologicalSort,
} from './task-graph.js';

// Verification + Recovery (Milestone 2)
export { Verifier } from './verifier.js';
export type { VerificationResult, ValidatorResult } from './verifier.js';
export { RecoveryEngine } from './recovery.js';

// Belief Graph (Milestone 3)
export { BeliefGraph } from './belief-graph.js';

// Reflection + Skill Synthesis (Milestone 4)
export { Reflector } from './reflector.js';
export { SkillSynthesizer } from './skill-synthesizer.js';

// Delegation (Milestone 5)
export { DelegateEngine } from './delegate-engine.js';
export type { DelegationRequest, DelegationResult } from './delegate-engine.js';

// AgentHandle bridge
export { createAgentHandleBridge } from './agent-handle-bridge.js';

// System prompt
export { buildV3SystemPrompt } from './system-prompt-v3.js';

// Tool descriptors
export { ToolDescriptorRegistry } from './tool-descriptor.js';
export type { ToolDescriptor, ToolCategory } from './tool-descriptor.js';

// Confidence engine
export { ConfidenceEngine } from './confidence-engine.js';
export type { ConfidenceFactors, ConfidenceTier } from './confidence-engine.js';

// Strategic planner
export { StrategicPlanner } from './strategic-planner.js';
export type { CandidatePlan, PlanStrategy } from './strategic-planner.js';

// Critic
export { Critic } from './critic.js';
export type { CritiqueResult } from './critic.js';

// Safety gate
export { SafetyGate } from './safety-gate.js';
export type { ApprovalGateResult } from './safety-gate.js';

// Action selector
export { ActionSelector } from './action-selector.js';
export type { TaskScore } from './action-selector.js';

// Metrics
export { MetricsCollector } from './metrics.js';
export type { SessionMetrics, AggregateMetrics } from './metrics.js';
