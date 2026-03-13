import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProviderAdapter, type ProviderAdapter } from '../loop/v2/core/provider-adapter.js';
import {
  type SkillDraftExample,
  type SkillDraftRequest,
  type SkillDraftResult,
  type SkillDraftSession,
  type SkillRejectedExampleRegenerationRequest,
  type SkillBudgetConfig,
  type SkillCandidateResult,
  type SkillCaseEvaluation,
  type SkillCaseJudgeResult,
  type SkillDeterministicCheck,
  type SkillEvaluationSummary,
  type SkillExecutionResult,
  type SkillFailureAnalysis,
  type SkillMetricWeights,
  type SkillPairwiseComparison,
  type SkillOptimizationRequest,
  type SkillOptimizationResult,
  type SkillOptimizationRound,
  type SkillOptimizerServices,
  type SkillSpec,
  type SkillTestCase,
  type SkillTestSplit,
} from './types.js';
import { saveSkillOptimizationIndexEntry } from './storage.js';

const DEFAULT_WEIGHTS: SkillMetricWeights = {
  factuality: 0.35,
  taskSuccess: 0.25,
  formatCompliance: 0.15,
  completeness: 0.1,
  latencyScore: 0.1,
  costScore: 0.05,
};

const SPLIT_MULTIPLIERS: Record<SkillTestSplit, number> = {
  seed: 1,
  holdout: 1.2,
  golden: 1.4,
  edge: 1.15,
  adversarial: 1.25,
};

const MODEL_PRICING_USD_PER_1K_TOKENS: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /gpt-4o-mini/i, input: 0.00015, output: 0.0006 },
  { match: /gpt-4o/i, input: 0.0025, output: 0.01 },
  { match: /claude-sonnet|sonnet-4/i, input: 0.003, output: 0.015 },
  { match: /llama-3\.1-70b|groq/i, input: 0.00059, output: 0.00079 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

function normalizeSplit(split?: SkillTestSplit): SkillTestSplit {
  return split || 'seed';
}

function getProviderAndModel(request: SkillOptimizationRequest): { provider: 'openai' | 'anthropic' | 'groq'; model: string } {
  if (request.provider && request.model) {
    return { provider: request.provider, model: request.model };
  }
  if (request.provider) {
    return {
      provider: request.provider,
      model: request.provider === 'openai'
        ? 'gpt-4o-mini'
        : request.provider === 'groq'
          ? 'llama-3.1-70b-versatile'
          : 'claude-sonnet-4-20250514',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: 'gpt-4o-mini' };
  if (process.env.GROQ_API_KEY) return { provider: 'groq', model: 'llama-3.1-70b-versatile' };
  return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
}

function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function stringifyInput(value: Record<string, unknown> | string | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value || {}, null, 2);
}

function getMetricWeights(skill: SkillSpec): SkillMetricWeights {
  return {
    ...DEFAULT_WEIGHTS,
    ...(skill.evaluationRubric || {}),
  };
}

function computeWeightedScore(scores: SkillMetricWeights, weights: SkillMetricWeights): number {
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  return clamp(
    (
      scores.factuality * weights.factuality +
      scores.taskSuccess * weights.taskSuccess +
      scores.formatCompliance * weights.formatCompliance +
      scores.completeness * weights.completeness +
      scores.latencyScore * weights.latencyScore +
      scores.costScore * weights.costScore
    ) / totalWeight,
    0,
    1,
  );
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function safeJsonParse(text: string): { ok: boolean; value?: any } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function normalizeDraftExampleStatus(value: unknown): 'approved' | 'rejected' {
  return value === 'rejected' ? 'rejected' : 'approved';
}

function normalizeDraftExample(raw: any, index: number): SkillDraftExample {
  const rawTestCase = raw?.testCase || raw || {};
  return {
    id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : `draft-example-${index + 1}`,
    testCase: {
      id: typeof rawTestCase.id === 'string' && rawTestCase.id.trim() ? rawTestCase.id.trim() : `draft-case-${index + 1}`,
      input: rawTestCase.input ?? '',
      expectedOutput: rawTestCase.expectedOutput,
      split: normalizeSplit(rawTestCase.split),
      tags: Array.isArray(rawTestCase.tags) ? rawTestCase.tags.filter((value: unknown): value is string => typeof value === 'string') : [],
      rubricNotes: typeof rawTestCase.rubricNotes === 'string' ? rawTestCase.rubricNotes : undefined,
      deterministicChecks: Array.isArray(rawTestCase.deterministicChecks) ? rawTestCase.deterministicChecks : [],
    },
    rationale: typeof raw?.rationale === 'string' ? raw.rationale : undefined,
    approvalStatus: normalizeDraftExampleStatus(raw?.approvalStatus),
    critique: typeof raw?.critique === 'string' ? raw.critique : undefined,
  };
}

function mergeReplacementExamples(
  existing: SkillDraftExample[],
  replacements: SkillDraftExample[],
): SkillDraftExample[] {
  const rejectedIds = new Set(existing.filter(example => example.approvalStatus === 'rejected').map(example => example.id));
  const replacementQueue = [...replacements];
  return existing.map((example, index) => {
    if (!rejectedIds.has(example.id)) {
      return example;
    }
    const replacement = replacementQueue.shift();
    if (!replacement) {
      return {
        ...example,
        approvalStatus: 'approved',
        critique: undefined,
      };
    }
    return normalizeDraftExample({
      ...replacement,
      id: example.id,
      approvalStatus: 'approved',
      critique: undefined,
    }, index);
  });
}

function evaluateCheck(output: string, check: SkillDeterministicCheck): { passed: boolean; issue?: string } {
  const parsed = safeJsonParse(output);
  switch (check.type) {
    case 'contains':
      return output.includes(check.value || '')
        ? { passed: true }
        : { passed: false, issue: `Output missing required text: ${check.value}` };
    case 'not_contains':
      return !output.includes(check.value || '')
        ? { passed: true }
        : { passed: false, issue: `Output contains forbidden text: ${check.value}` };
    case 'equals':
      return output.trim() === String(check.value || '').trim()
        ? { passed: true }
        : { passed: false, issue: `Output did not exactly match expected value.` };
    case 'json_valid':
      return parsed.ok
        ? { passed: true }
        : { passed: false, issue: 'Output is not valid JSON.' };
    case 'json_key_present':
      return parsed.ok && parsed.value && Object.prototype.hasOwnProperty.call(parsed.value, check.key || '')
        ? { passed: true }
        : { passed: false, issue: `Output JSON missing key: ${check.key}` };
    case 'json_key_equals':
      return parsed.ok && parsed.value && String(parsed.value[check.key || '']) === String(check.value || '')
        ? { passed: true }
        : { passed: false, issue: `Output JSON key ${check.key} did not match expected value.` };
    default:
      return { passed: true };
  }
}

function deriveFormatCompliance(skill: SkillSpec, output: string, issues: string[]): number {
  let score = 1;
  const constraints = skill.outputFormat.constraints || {};

  if (skill.outputFormat.type === 'json') {
    const parsed = safeJsonParse(output);
    if (!parsed.ok) {
      issues.push('Output was not valid JSON.');
      return 0;
    }
    for (const requiredKey of constraints.requiredKeys || []) {
      if (!Object.prototype.hasOwnProperty.call(parsed.value, requiredKey)) {
        issues.push(`Output JSON missing required key ${requiredKey}.`);
        score -= 0.3;
      }
    }
  }

  const wordCount = countWords(output);
  if (constraints.minWords && wordCount < constraints.minWords) {
    issues.push(`Output shorter than minimum word count ${constraints.minWords}.`);
    score -= 0.25;
  }
  if (constraints.maxWords && wordCount > constraints.maxWords) {
    issues.push(`Output longer than maximum word count ${constraints.maxWords}.`);
    score -= 0.25;
  }

  return clamp(score, 0, 1);
}

function deriveLatencyScore(durationMs: number): number {
  if (durationMs <= 1500) return 1;
  if (durationMs <= 4000) return 0.75;
  if (durationMs <= 8000) return 0.5;
  return 0.25;
}

function deriveCostScore(totalTokens?: number): number {
  if (!totalTokens || totalTokens <= 0) return 1;
  if (totalTokens <= 1200) return 1;
  if (totalTokens <= 3000) return 0.75;
  if (totalTokens <= 6000) return 0.5;
  return 0.25;
}

function estimateCostUsd(model: string, usage?: SkillExecutionResult['tokenUsage']): number {
  if (!usage) {
    return 0;
  }
  const pricing = MODEL_PRICING_USD_PER_1K_TOKENS.find(entry => entry.match.test(model))
    || { input: 0.001, output: 0.002 };
  const inputTokens = usage.inputTokens ?? Math.round((usage.totalTokens || 0) * 0.7);
  const outputTokens = usage.outputTokens ?? Math.max(0, (usage.totalTokens || 0) - inputTokens);
  return ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1000;
}

function getBudgetStatus(
  metrics: { averageLatencyMs: number; totalTokensUsed: number; estimatedCostUsd: number },
  budgets?: SkillBudgetConfig,
): { exceeded: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!budgets) {
    return { exceeded: false, reasons };
  }
  if (typeof budgets.maxAverageLatencyMs === 'number' && metrics.averageLatencyMs > budgets.maxAverageLatencyMs) {
    reasons.push(`Average latency ${Math.round(metrics.averageLatencyMs)}ms exceeds budget ${budgets.maxAverageLatencyMs}ms.`);
  }
  if (typeof budgets.maxTotalTokens === 'number' && metrics.totalTokensUsed > budgets.maxTotalTokens) {
    reasons.push(`Total tokens ${metrics.totalTokensUsed} exceed budget ${budgets.maxTotalTokens}.`);
  }
  if (typeof budgets.maxEstimatedCostUsd === 'number' && metrics.estimatedCostUsd > budgets.maxEstimatedCostUsd) {
    reasons.push(`Estimated cost $${metrics.estimatedCostUsd.toFixed(4)} exceeds budget $${budgets.maxEstimatedCostUsd.toFixed(4)}.`);
  }
  return { exceeded: reasons.length > 0, reasons };
}

function hasPerCaseTokenBudgetExceeded(perCaseTokens: number[], budgets?: SkillBudgetConfig): boolean {
  if (!budgets || typeof budgets.maxTokensPerCase !== 'number') {
    return false;
  }
  return perCaseTokens.some(totalTokens => totalTokens > budgets.maxTokensPerCase!);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export class SkillOptimizer {
  private readonly adapter: ProviderAdapter;

  constructor(private readonly services: SkillOptimizerServices = {}, adapter?: ProviderAdapter) {
    this.adapter = adapter || createProviderAdapter();
  }

  async optimize(request: SkillOptimizationRequest): Promise<SkillOptimizationResult> {
    if (!request.goal || !request.goal.trim()) {
      throw new Error('goal is required');
    }
    if (!Array.isArray(request.testCases) || request.testCases.length === 0) {
      throw new Error('testCases must be a non-empty array');
    }

    const workingDirectory = request.workingDirectory || process.cwd();
    const namespace = slugify(request.artifactNamespace || request.baseSkill?.name || request.goal);
    const runId = `skill-opt-${Date.now().toString(36)}`;
    const createdAt = new Date().toISOString();
    const artifactDir = join(workingDirectory, '.woodbury-work', 'skill-builder', namespace, runId);
    const versionsDir = join(artifactDir, 'versions');
    await mkdir(versionsDir, { recursive: true });

    let nextVersion = 1;
    const bestInitial = request.baseSkill
      ? this.normalizeSkill(request.baseSkill, nextVersion++, undefined, 'Starting skill')
      : this.normalizeSkill(await this.generateInitialSkill(request), nextVersion++, undefined, 'Initial generated skill');

    const baseline = await this.evaluateCandidate(bestInitial, request, versionsDir, false, 0);

    let best = baseline;
    let patienceCounter = 0;
    const rounds: SkillOptimizationRound[] = [];
    const maxRounds = Math.max(1, request.maxRounds ?? 4);
    const candidatesPerRound = Math.max(1, request.candidatesPerRound ?? 3);
    const patience = Math.max(1, request.patience ?? 2);
    const minImprovement = request.minImprovement ?? 0.005;
    let plateauReason: 'max_rounds' | 'no_improvement' = 'max_rounds';

    for (let round = 1; round <= maxRounds; round++) {
      const candidates = await this.generateCandidateSkills({
        request,
        bestSkill: best.skill,
        failureAnalysis: best.failureAnalysis,
        round,
        count: candidatesPerRound,
      });

      const evaluated = await Promise.all(candidates.map(async (candidate) => {
        const normalized = this.normalizeSkill(candidate, nextVersion++, best.skill.version, `Round ${round} candidate`);
        return this.evaluateCandidate(
          normalized,
          request,
          versionsDir,
          false,
          best.evaluation.overallScore,
          request.pairwiseJudging ? best : undefined,
        );
      }));

      const winner = evaluated.sort((left, right) => right.evaluation.overallScore - left.evaluation.overallScore)[0];
      const accepted = !!winner
        && winner.evaluation.overallScore > (best.evaluation.overallScore + minImprovement)
        && winner.evaluation.holdoutScore >= (best.evaluation.holdoutScore - 0.02)
        && (!winner.evaluation.budget.exceeded || !request.budgets?.hardFailOnBudgetExceeded)
        && (!winner.pairwiseComparison || winner.pairwiseComparison.preferred !== 'best');

      if (winner) {
        winner.accepted = accepted;
        winner.improvement = winner.evaluation.overallScore - best.evaluation.overallScore;
      }

      rounds.push({
        round,
        baselineVersion: best.skill.version,
        candidates: evaluated,
        winnerVersion: winner?.skill.version,
        winnerScore: winner?.evaluation.overallScore,
        acceptedWinner: accepted,
      });

      if (accepted && winner) {
        best = winner;
        patienceCounter = 0;
      } else {
        patienceCounter += 1;
      }

      if (patienceCounter >= patience) {
        plateauReason = 'no_improvement';
        break;
      }
    }

    const result: SkillOptimizationResult = {
      runId,
      namespace,
      createdAt,
      artifactDir,
      bestSkill: best.skill,
      baseline,
      rounds,
      plateauReason,
      totalRounds: rounds.length,
      budgets: request.budgets,
    };

    await writeJson(join(artifactDir, 'request.json'), request);
    await writeJson(join(artifactDir, 'best-skill.json'), best.skill);
    await writeJson(join(artifactDir, 'report.json'), result);
    await saveSkillOptimizationIndexEntry(workingDirectory, {
      runId,
      goal: request.goal,
      namespace,
      artifactDir,
      createdAt,
      bestSkillName: best.skill.name,
      bestVersion: best.skill.version,
      bestScore: best.evaluation.overallScore,
      baselineScore: baseline.evaluation.overallScore,
      holdoutScore: best.evaluation.holdoutScore,
      plateauReason,
      totalRounds: rounds.length,
    });

    return result;
  }

  async evaluate(skill: SkillSpec, testCases: SkillTestCase[], budgets?: SkillBudgetConfig): Promise<SkillEvaluationSummary> {
    return this.evaluateSkill(skill, testCases, budgets);
  }

  async generateDraft(request: SkillDraftRequest): Promise<SkillDraftResult> {
    if (!request.description || !request.description.trim()) {
      throw new Error('description is required');
    }

    if (this.services.generateSkillDraft) {
      const provided = await this.services.generateSkillDraft(request);
      return {
        skill: this.normalizeSkill(provided.skill, 1, undefined, 'Initial generated skill draft'),
        examples: (provided.examples || []).map((example, index) => normalizeDraftExample(example, index)),
        notes: Array.isArray(provided.notes) ? provided.notes : [],
      };
    }

    const { provider, model } = getProviderAndModel({
      goal: request.goal || request.description,
      testCases: [],
      provider: request.provider,
      model: request.model,
    });
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0.2,
      maxTokens: 3200,
      messages: [
        {
          role: 'system',
          content: 'You design structured skill specs and initial benchmark cases. Return valid JSON only with shape {"skill": SkillSpec, "examples": [{"id": string, "testCase": SkillTestCase, "rationale": string}], "notes": string[]}. Make examples concrete, realistic, and easy for a human reviewer to approve or reject. Default splits should mostly be seed with 1 holdout if enough examples are requested.',
        },
        {
          role: 'user',
          content: `Skill description:\n${request.description}\n\nGoal:\n${request.goal || request.description}\n\nConstraints:\n${(request.constraints || []).join('\n') || 'None'}\n\nGenerate ${Math.max(2, request.exampleCount || 4)} proposed examples.`,
        },
      ],
    });

    const parsed = JSON.parse(stripJsonFences(response.content));
    const skill = this.normalizeSkill(parsed.skill, 1, undefined, 'Initial generated skill draft');
    const examples = Array.isArray(parsed.examples)
      ? parsed.examples.map((example: unknown, index: number) => normalizeDraftExample(example, index))
      : [];
    return {
      skill,
      examples,
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((value: unknown): value is string => typeof value === 'string') : [],
    };
  }

  async regenerateRejectedExamples(request: SkillRejectedExampleRegenerationRequest): Promise<SkillDraftResult> {
    const rejectedExamples = request.session.draft.examples.filter(example => example.approvalStatus === 'rejected');
    if (rejectedExamples.length === 0) {
      return request.session.draft;
    }

    if (this.services.generateReplacementExamples) {
      const replacements = await this.services.generateReplacementExamples(request);
      return {
        ...request.session.draft,
        examples: mergeReplacementExamples(request.session.draft.examples, replacements),
      };
    }

    const draftRequest = request.session.request;
    const { provider, model } = getProviderAndModel({
      goal: draftRequest.goal || draftRequest.description,
      testCases: [],
      provider: draftRequest.provider,
      model: draftRequest.model,
    });
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0.2,
      maxTokens: 2200,
      messages: [
        {
          role: 'system',
          content: 'You repair rejected skill benchmark examples. Return valid JSON only with shape {"examples": [{"testCase": SkillTestCase, "rationale": string}]}. Replace only the rejected examples. Use reviewer critiques to improve realism, clarity, and coverage. Do not rewrite approved examples.',
        },
        {
          role: 'user',
          content: `Skill description:\n${draftRequest.description}\n\nCurrent skill:\n${JSON.stringify(request.session.draft.skill, null, 2)}\n\nRejected examples and critiques:\n${JSON.stringify(rejectedExamples, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(stripJsonFences(response.content));
    const replacements = Array.isArray(parsed.examples)
      ? parsed.examples.map((example: unknown, index: number) => normalizeDraftExample(example, index))
      : [];
    return {
      ...request.session.draft,
      examples: mergeReplacementExamples(request.session.draft.examples, replacements),
    };
  }

  private normalizeSkill(skill: SkillSpec, version: number, parentVersion?: number, revisionNote?: string): SkillSpec {
    const now = new Date().toISOString();
    return {
      ...skill,
      triggerConditions: Array.isArray(skill.triggerConditions) ? skill.triggerConditions : [],
      instructions: Array.isArray(skill.instructions) ? skill.instructions : [],
      constraints: Array.isArray(skill.constraints) ? skill.constraints : [],
      examples: Array.isArray(skill.examples) ? skill.examples : [],
      version,
      parentVersion,
      revisionNote: revisionNote || skill.revisionNote,
      createdAt: skill.createdAt || now,
      updatedAt: now,
    };
  }

  private async evaluateCandidate(
    skill: SkillSpec,
    request: SkillOptimizationRequest,
    versionsDir: string,
    accepted: boolean,
    improvement: number,
    incumbent?: SkillCandidateResult,
  ): Promise<SkillCandidateResult> {
    const evaluation = await this.evaluateSkill(skill, request.testCases, request.budgets, request);
    const failureAnalysis = await this.analyzeFailures({ skill, evaluation, request });
    const pairwiseComparison = incumbent
      ? await this.compareCandidateAgainstIncumbent(skill, evaluation, incumbent, request)
      : undefined;
    await writeJson(join(versionsDir, `skill-v${String(skill.version).padStart(3, '0')}.json`), {
      skill,
      evaluation,
      failureAnalysis,
      pairwiseComparison,
      accepted,
      improvement,
    });
    return { skill, evaluation, failureAnalysis, pairwiseComparison, accepted, improvement };
  }

  private async evaluateSkill(
    skill: SkillSpec,
    testCases: SkillTestCase[],
    budgets?: SkillBudgetConfig,
    request?: SkillOptimizationRequest,
  ): Promise<SkillEvaluationSummary> {
    const weights = getMetricWeights(skill);
    const caseResults: SkillCaseEvaluation[] = [];
    const providerModel = getProviderAndModel(request || { goal: skill.purpose, testCases });
    const perCaseTokens: number[] = [];
    let totalTokensUsed = 0;
    let estimatedCostUsd = 0;
    const splitScores: Record<SkillTestSplit, number> = {
      seed: 0,
      holdout: 0,
      golden: 0,
      edge: 0,
      adversarial: 0,
    };
    const splitTotals: Record<SkillTestSplit, number> = {
      seed: 0,
      holdout: 0,
      golden: 0,
      edge: 0,
      adversarial: 0,
    };

    for (const testCase of testCases) {
      const execution = await this.runSkillCase(skill, testCase);
      const split = normalizeSplit(testCase.split);
      const issues: string[] = [];
      const strengths: string[] = [];
      let passedChecks = 0;
      let totalChecks = 0;

      for (const check of testCase.deterministicChecks || []) {
        totalChecks += 1;
        const result = evaluateCheck(execution.output, check);
        if (result.passed) {
          passedChecks += 1;
        } else if (result.issue) {
          issues.push(result.issue);
        }
      }

      const formatCompliance = deriveFormatCompliance(skill, execution.output, issues);
      let taskSuccess = totalChecks > 0 ? passedChecks / totalChecks : 0;
      let factuality = taskSuccess;
      let completeness = taskSuccess > 0 ? taskSuccess : formatCompliance;

      if (!totalChecks && typeof testCase.expectedOutput === 'string') {
        totalChecks = 1;
        if (execution.output.trim() === testCase.expectedOutput.trim()) {
          passedChecks = 1;
          taskSuccess = 1;
          factuality = 1;
          completeness = 1;
          strengths.push('Matched expected output exactly.');
        } else if (execution.output.toLowerCase().includes(testCase.expectedOutput.toLowerCase())) {
          passedChecks = 1;
          taskSuccess = 0.8;
          factuality = 0.8;
          completeness = 0.8;
          strengths.push('Covered the expected answer content.');
        } else {
          taskSuccess = 0.2;
          factuality = 0.2;
          completeness = 0.2;
          issues.push('Output did not match expected answer content.');
        }
      }

      const judged = await this.judgeSkillCase({ skill, testCase, output: execution.output });
      if (typeof judged.taskSuccess === 'number') taskSuccess = clamp((taskSuccess + judged.taskSuccess) / 2, 0, 1);
      if (typeof judged.factuality === 'number') factuality = clamp((factuality + judged.factuality) / 2, 0, 1);
      if (typeof judged.completeness === 'number') completeness = clamp((completeness + judged.completeness) / 2, 0, 1);
      const judgedFormat = typeof judged.formatCompliance === 'number'
        ? clamp((formatCompliance + judged.formatCompliance) / 2, 0, 1)
        : formatCompliance;
      issues.push(...(judged.issues || []));
      strengths.push(...(judged.strengths || []));

      const scores: SkillMetricWeights = {
        factuality,
        taskSuccess,
        formatCompliance: judgedFormat,
        completeness,
        latencyScore: deriveLatencyScore(execution.durationMs),
        costScore: deriveCostScore(execution.tokenUsage?.totalTokens),
      };
      const totalScore = computeWeightedScore(scores, weights);
      caseResults.push({
        testCaseId: testCase.id,
        split,
        output: execution.output,
        durationMs: execution.durationMs,
        scores,
        totalScore,
        passedChecks,
        totalChecks,
        issues,
        strengths,
      });
      const caseTokens = execution.tokenUsage?.totalTokens || 0;
      perCaseTokens.push(caseTokens);
      totalTokensUsed += caseTokens;
      estimatedCostUsd += estimateCostUsd(providerModel.model, execution.tokenUsage);
      splitScores[split] += totalScore * SPLIT_MULTIPLIERS[split];
      splitTotals[split] += SPLIT_MULTIPLIERS[split];
    }

    const normalizedSplitScores = Object.fromEntries(
      Object.entries(splitScores).map(([split, score]) => [split, splitTotals[split as SkillTestSplit] > 0 ? score / splitTotals[split as SkillTestSplit] : 0]),
    ) as Record<SkillTestSplit, number>;

    const totalWeight = caseResults.reduce((sum, result) => sum + SPLIT_MULTIPLIERS[result.split], 0) || 1;
    const overallScore = caseResults.reduce((sum, result) => sum + (result.totalScore * SPLIT_MULTIPLIERS[result.split]), 0) / totalWeight;
    const averageLatencyMs = caseResults.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(1, caseResults.length);
    const budget = getBudgetStatus({ averageLatencyMs, totalTokensUsed, estimatedCostUsd }, budgets);
    if (typeof budgets?.maxTokensPerCase === 'number' && hasPerCaseTokenBudgetExceeded(perCaseTokens, budgets)) {
      budget.exceeded = true;
      budget.reasons.push(`At least one case exceeds maxTokensPerCase ${budgets.maxTokensPerCase}.`);
    }

    return {
      overallScore,
      splitScores: normalizedSplitScores,
      caseResults,
      holdoutScore: normalizedSplitScores.holdout,
      averageLatencyMs,
      totalTokensUsed,
      estimatedCostUsd,
      totalCases: caseResults.length,
      budget,
      lowSignalFailures: caseResults
        .filter(result => result.totalScore < 0.7)
        .map(result => ({
          testCaseId: result.testCaseId,
          split: result.split,
          issues: result.issues,
          totalScore: result.totalScore,
        })),
    };
  }

  private async compareCandidateAgainstIncumbent(
    skill: SkillSpec,
    evaluation: SkillEvaluationSummary,
    incumbent: SkillCandidateResult,
    request: SkillOptimizationRequest,
  ): Promise<SkillPairwiseComparison> {
    const scoreDelta = evaluation.overallScore - incumbent.evaluation.overallScore;
    const holdoutDelta = evaluation.holdoutScore - incumbent.evaluation.holdoutScore;
    const candidateIssues = evaluation.lowSignalFailures.flatMap(entry => entry.issues).slice(0, 4);
    const incumbentIssues = incumbent.evaluation.lowSignalFailures.flatMap(entry => entry.issues).slice(0, 4);

    if (holdoutDelta < -0.01 || (evaluation.budget.exceeded && request.budgets?.hardFailOnBudgetExceeded)) {
      return {
        preferred: 'best',
        rationale: 'Candidate regresses generalization or exceeds a hard budget constraint.',
        candidateAdvantages: candidateIssues,
        incumbentAdvantages: [
          `Holdout score delta ${holdoutDelta.toFixed(3)} favors incumbent.`,
          ...(incumbentIssues.length ? incumbentIssues : ['Incumbent remains safer on evaluation constraints.']),
        ],
      };
    }

    if (scoreDelta > 0.01 && holdoutDelta >= -0.01) {
      return {
        preferred: 'candidate',
        rationale: 'Candidate improves weighted score without materially regressing holdout quality.',
        candidateAdvantages: [
          `Overall score improved by ${scoreDelta.toFixed(3)}.`,
          `Holdout delta ${holdoutDelta.toFixed(3)} remained within tolerance.`,
        ],
        incumbentAdvantages: incumbentIssues,
      };
    }

    return {
      preferred: 'tie',
      rationale: 'Candidate and incumbent are materially similar under current evaluation signals.',
      candidateAdvantages: candidateIssues,
      incumbentAdvantages: incumbentIssues,
    };
  }

  private async generateInitialSkill(request: SkillOptimizationRequest): Promise<SkillSpec> {
    if (this.services.generateInitialSkill) {
      return this.services.generateInitialSkill(request);
    }

    const { provider, model } = getProviderAndModel(request);
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0.2,
      maxTokens: 2200,
      messages: [
        {
          role: 'system',
          content: 'You design structured skill specs. Return valid JSON only for a SkillSpec object with fields: name, purpose, triggerConditions, inputs, instructions, constraints, outputFormat, examples, evaluationRubric. Keep it concrete and testable.',
        },
        {
          role: 'user',
          content: `Goal:\n${request.goal}\n\nConstraints:\n${(request.constraints || []).join('\n') || 'None'}\n\nDataset preview:\n${JSON.stringify(request.testCases.slice(0, 3), null, 2)}`,
        },
      ],
    });

    return JSON.parse(stripJsonFences(response.content));
  }

  private async generateCandidateSkills(input: {
    request: SkillOptimizationRequest;
    bestSkill: SkillSpec;
    failureAnalysis: SkillFailureAnalysis;
    round: number;
    count: number;
  }): Promise<SkillSpec[]> {
    if (this.services.generateCandidateSkills) {
      return this.services.generateCandidateSkills(input);
    }

    const { provider, model } = getProviderAndModel(input.request);
    const seedFailures = input.failureAnalysis.recommendations.join('\n- ');
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0.3,
      maxTokens: 3200,
      messages: [
        {
          role: 'system',
          content: 'You revise structured skill specs. Return valid JSON only: {"candidates": [SkillSpec, ...]}. Make targeted edits, not total rewrites. Improve trigger conditions, instructions, examples, constraints, or output format based on failure analysis.',
        },
        {
          role: 'user',
          content: `Best skill:\n${JSON.stringify(input.bestSkill, null, 2)}\n\nFailure analysis:\n- ${seedFailures || 'No recommendations.'}\n\nRound: ${input.round}\nNeed ${input.count} candidates.`,
        },
      ],
    });

    const parsed = JSON.parse(stripJsonFences(response.content));
    return Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, input.count) : [];
  }

  private async runSkillCase(skill: SkillSpec, testCase: SkillTestCase): Promise<SkillExecutionResult> {
    if (this.services.runSkillCase) {
      return this.services.runSkillCase(skill, testCase);
    }

    const providerModel = getProviderAndModel({ goal: skill.purpose, testCases: [testCase] });
    const start = Date.now();
    const response = await this.adapter.createCompletion({
      provider: providerModel.provider,
      model: providerModel.model,
      temperature: 0.1,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content: [
            `You are executing the skill ${skill.name}.`,
            `Purpose: ${skill.purpose}`,
            `Trigger conditions: ${skill.triggerConditions.join('; ')}`,
            `Inputs: ${JSON.stringify(skill.inputs)}`,
            `Instructions:\n- ${skill.instructions.join('\n- ')}`,
            skill.constraints?.length ? `Constraints:\n- ${skill.constraints.join('\n- ')}` : '',
            `Output format: ${skill.outputFormat.type}${skill.outputFormat.constraints ? ` ${JSON.stringify(skill.outputFormat.constraints)}` : ''}`,
            skill.examples?.length ? `Examples:\n${JSON.stringify(skill.examples.slice(0, 2), null, 2)}` : '',
            'Follow the skill exactly. Do not explain your reasoning unless the skill requires it.',
          ].filter(Boolean).join('\n\n'),
        },
        {
          role: 'user',
          content: `Test case input:\n${stringifyInput(testCase.input)}\n\nRubric notes:\n${testCase.rubricNotes || 'None'}`,
        },
      ],
    });

    return {
      output: response.content.trim(),
      durationMs: Date.now() - start,
      tokenUsage: response.usage,
    };
  }

  private async judgeSkillCase(input: { skill: SkillSpec; testCase: SkillTestCase; output: string }): Promise<SkillCaseJudgeResult> {
    if (this.services.judgeSkillCase) {
      return this.services.judgeSkillCase(input);
    }

    if (!input.testCase.expectedOutput && !input.testCase.rubricNotes) {
      return {};
    }

    const { provider, model } = getProviderAndModel({ goal: input.skill.purpose, testCases: [input.testCase] });
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: 'You are a strict skill evaluator. Return valid JSON only with fields factuality, taskSuccess, formatCompliance, completeness, issues, strengths, summary. Scores must be numbers from 0 to 1.',
        },
        {
          role: 'user',
          content: `Skill:\n${JSON.stringify(input.skill, null, 2)}\n\nTest input:\n${stringifyInput(input.testCase.input)}\n\nExpected output:\n${stringifyInput(input.testCase.expectedOutput)}\n\nRubric notes:\n${input.testCase.rubricNotes || 'None'}\n\nModel output:\n${input.output}`,
        },
      ],
    });
    return JSON.parse(stripJsonFences(response.content));
  }

  private async analyzeFailures(input: {
    skill: SkillSpec;
    evaluation: SkillEvaluationSummary;
    request: SkillOptimizationRequest;
  }): Promise<SkillFailureAnalysis> {
    if (this.services.analyzeFailures) {
      return this.services.analyzeFailures(input);
    }

    const visibleFailures = input.evaluation.caseResults
      .filter(result => result.split !== 'holdout' && result.totalScore < 0.75)
      .slice(0, 8)
      .map(result => ({
        testCaseId: result.testCaseId,
        split: result.split,
        issues: result.issues,
        output: result.output,
        score: result.totalScore,
      }));

    if (visibleFailures.length === 0) {
      return {
        summary: 'No major failures found in non-holdout cases.',
        recommendations: ['Make only small clarity or trigger-tightening edits.'],
        recurringIssues: [],
      };
    }

    const { provider, model } = getProviderAndModel(input.request);
    const response = await this.adapter.createCompletion({
      provider,
      model,
      temperature: 0.1,
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content: 'You analyze skill failures. Return valid JSON only with fields summary, recommendations, recurringIssues. Recommendations must be specific edit intents, not vague advice.',
        },
        {
          role: 'user',
          content: `Skill:\n${JSON.stringify(input.skill, null, 2)}\n\nVisible failures:\n${JSON.stringify(visibleFailures, null, 2)}`,
        },
      ],
    });
    return JSON.parse(stripJsonFences(response.content));
  }
}

export async function optimizeSkill(request: SkillOptimizationRequest, services?: SkillOptimizerServices): Promise<SkillOptimizationResult> {
  const optimizer = new SkillOptimizer(services);
  return optimizer.optimize(request);
}

export async function generateSkillDraft(
  request: SkillDraftRequest,
  services?: SkillOptimizerServices,
): Promise<SkillDraftResult> {
  const optimizer = new SkillOptimizer(services);
  return optimizer.generateDraft(request);
}

export async function regenerateRejectedSkillExamples(
  request: SkillRejectedExampleRegenerationRequest,
  services?: SkillOptimizerServices,
): Promise<SkillDraftResult> {
  const optimizer = new SkillOptimizer(services);
  return optimizer.regenerateRejectedExamples(request);
}

export async function evaluateSkill(
  skill: SkillSpec,
  testCases: SkillTestCase[],
  services?: SkillOptimizerServices,
  budgets?: SkillBudgetConfig,
): Promise<SkillEvaluationSummary> {
  const optimizer = new SkillOptimizer(services);
  return optimizer.evaluate(skill, testCases, budgets);
}