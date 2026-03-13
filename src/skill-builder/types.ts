export type SkillOutputType = 'text' | 'json' | 'markdown';

export type SkillTestSplit = 'seed' | 'holdout' | 'golden' | 'edge' | 'adversarial';

export interface SkillOutputConstraints {
  minWords?: number;
  maxWords?: number;
  requiredKeys?: string[];
}

export interface SkillExample {
  input: Record<string, unknown> | string;
  output: Record<string, unknown> | string;
  note?: string;
}

export type SkillDraftExampleStatus = 'approved' | 'rejected';

export interface SkillDraftRequest {
  description: string;
  goal?: string;
  artifactNamespace?: string;
  constraints?: string[];
  provider?: 'openai' | 'anthropic' | 'groq';
  model?: string;
  exampleCount?: number;
}

export interface SkillDraftExample {
  id: string;
  testCase: SkillTestCase;
  rationale?: string;
  approvalStatus: SkillDraftExampleStatus;
  critique?: string;
}

export interface SkillDraftResult {
  skill: SkillSpec;
  examples: SkillDraftExample[];
  notes?: string[];
}

export interface SkillDraftSession {
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  request: SkillDraftRequest;
  draft: SkillDraftResult;
  approvedForOptimization: boolean;
  approvedAt?: string;
  approvalNote?: string;
}

export interface SkillDraftReviewUpdate {
  draft?: SkillDraftResult;
  approvedForOptimization?: boolean;
  approvalNote?: string;
}

export interface PublishedSkillAudience {
  chat: boolean;
  pipelines: boolean;
}

export interface PublishedSkillSource {
  type: 'draft' | 'run';
  draftSessionId?: string;
  runId?: string;
  version?: number;
}

export interface PublishedSkillRecord {
  publishedSkillId: string;
  name: string;
  description?: string;
  publishedAt: string;
  updatedAt: string;
  unpublishedAt?: string;
  audience: PublishedSkillAudience;
  source: PublishedSkillSource;
  skill: SkillSpec;
  notes?: string[];
}

export interface SkillRejectedExampleRegenerationRequest {
  session: SkillDraftSession;
}

export interface SkillMetricWeights {
  factuality: number;
  taskSuccess: number;
  formatCompliance: number;
  completeness: number;
  latencyScore: number;
  costScore: number;
}

export interface SkillBudgetConfig {
  maxAverageLatencyMs?: number;
  maxTokensPerCase?: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
  hardFailOnBudgetExceeded?: boolean;
}

export interface SkillSpec {
  name: string;
  purpose: string;
  triggerConditions: string[];
  inputs: Record<string, string>;
  instructions: string[];
  constraints?: string[];
  outputFormat: {
    type: SkillOutputType;
    constraints?: SkillOutputConstraints;
  };
  examples?: SkillExample[];
  evaluationRubric?: Partial<SkillMetricWeights>;
  version: number;
  parentVersion?: number;
  revisionNote?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillDeterministicCheck {
  type: 'contains' | 'not_contains' | 'equals' | 'json_valid' | 'json_key_present' | 'json_key_equals';
  value?: string;
  key?: string;
}

export interface SkillTestCase {
  id: string;
  input: Record<string, unknown> | string;
  expectedOutput?: Record<string, unknown> | string;
  split?: SkillTestSplit;
  tags?: string[];
  rubricNotes?: string;
  deterministicChecks?: SkillDeterministicCheck[];
}

export interface SkillExecutionResult {
  output: string;
  durationMs: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface SkillCaseJudgeResult {
  factuality?: number;
  taskSuccess?: number;
  formatCompliance?: number;
  completeness?: number;
  issues?: string[];
  strengths?: string[];
  summary?: string;
}

export interface SkillPairwiseComparison {
  preferred: 'candidate' | 'best' | 'tie';
  rationale: string;
  candidateAdvantages: string[];
  incumbentAdvantages: string[];
}

export interface SkillCaseEvaluation {
  testCaseId: string;
  split: SkillTestSplit;
  output: string;
  durationMs: number;
  scores: SkillMetricWeights;
  totalScore: number;
  passedChecks: number;
  totalChecks: number;
  issues: string[];
  strengths: string[];
}

export interface SkillEvaluationSummary {
  overallScore: number;
  splitScores: Record<SkillTestSplit, number>;
  caseResults: SkillCaseEvaluation[];
  holdoutScore: number;
  averageLatencyMs: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
  totalCases: number;
  budget: {
    exceeded: boolean;
    reasons: string[];
  };
  lowSignalFailures: Array<{
    testCaseId: string;
    split: SkillTestSplit;
    issues: string[];
    totalScore: number;
  }>;
}

export interface SkillFailureAnalysis {
  summary: string;
  recommendations: string[];
  recurringIssues: string[];
}

export interface SkillCandidateResult {
  skill: SkillSpec;
  evaluation: SkillEvaluationSummary;
  failureAnalysis: SkillFailureAnalysis;
  pairwiseComparison?: SkillPairwiseComparison;
  accepted: boolean;
  improvement: number;
}

export interface SkillOptimizationRound {
  round: number;
  baselineVersion: number;
  candidates: SkillCandidateResult[];
  winnerVersion?: number;
  winnerScore?: number;
  acceptedWinner?: boolean;
}

export interface SkillOptimizationRequest {
  goal: string;
  baseSkill?: SkillSpec;
  testCases: SkillTestCase[];
  constraints?: string[];
  maxRounds?: number;
  candidatesPerRound?: number;
  patience?: number;
  minImprovement?: number;
  provider?: 'openai' | 'anthropic' | 'groq';
  model?: string;
  workingDirectory?: string;
  artifactNamespace?: string;
  budgets?: SkillBudgetConfig;
  pairwiseJudging?: boolean;
  draftSessionId?: string;
}

export interface SkillOptimizationIndexEntry {
  runId: string;
  goal: string;
  namespace: string;
  artifactDir: string;
  createdAt: string;
  bestSkillName: string;
  bestVersion: number;
  bestScore: number;
  baselineScore: number;
  holdoutScore: number;
  plateauReason: 'max_rounds' | 'no_improvement';
  totalRounds: number;
}

export interface SkillOptimizationResult {
  runId: string;
  namespace: string;
  createdAt: string;
  artifactDir: string;
  bestSkill: SkillSpec;
  baseline: SkillCandidateResult;
  rounds: SkillOptimizationRound[];
  plateauReason: 'max_rounds' | 'no_improvement';
  totalRounds: number;
  budgets?: SkillBudgetConfig;
}

export interface SkillOptimizerServices {
  generateSkillDraft?(request: SkillDraftRequest): Promise<SkillDraftResult>;
  generateReplacementExamples?(request: SkillRejectedExampleRegenerationRequest): Promise<SkillDraftExample[]>;
  generateInitialSkill?(request: SkillOptimizationRequest): Promise<SkillSpec>;
  generateCandidateSkills?(input: {
    request: SkillOptimizationRequest;
    bestSkill: SkillSpec;
    failureAnalysis: SkillFailureAnalysis;
    round: number;
    count: number;
  }): Promise<SkillSpec[]>;
  runSkillCase?(skill: SkillSpec, testCase: SkillTestCase): Promise<SkillExecutionResult>;
  judgeSkillCase?(input: {
    skill: SkillSpec;
    testCase: SkillTestCase;
    output: string;
  }): Promise<SkillCaseJudgeResult>;
  analyzeFailures?(input: {
    skill: SkillSpec;
    evaluation: SkillEvaluationSummary;
    request: SkillOptimizationRequest;
  }): Promise<SkillFailureAnalysis>;
}