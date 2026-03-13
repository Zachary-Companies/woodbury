import { optimizeSkill } from '../../skill-builder/optimizer.js';
import type { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const definition: ToolDefinition = {
  name: 'skill_optimize',
  description: 'Build and optimize a structured skill spec in a generate-test-evaluate-rewrite loop until scores plateau. Saves versioned artifacts under .woodbury-work/skill-builder/.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'What the skill should do.',
      },
      baseSkill: {
        type: 'object',
        description: 'Optional starting skill spec to optimize instead of generating from scratch.',
      },
      testCases: {
        type: 'array',
        description: 'Benchmark cases with inputs, expected outputs, splits, and deterministic checks.',
      },
      constraints: {
        type: 'array',
        description: 'Optional hard constraints for the skill builder.',
        items: { type: 'string' },
      },
      maxRounds: {
        type: 'number',
        description: 'Maximum optimization rounds before forcing stop. Default 4.',
      },
      candidatesPerRound: {
        type: 'number',
        description: 'How many candidate revisions to evaluate each round. Default 3.',
      },
      patience: {
        type: 'number',
        description: 'Number of consecutive non-improving rounds to tolerate before stopping. Default 2.',
      },
      minImprovement: {
        type: 'number',
        description: 'Minimum score delta required to accept a new best skill. Default 0.005.',
      },
      provider: {
        type: 'string',
        enum: ['openai', 'anthropic', 'groq'],
        description: 'Optional LLM provider override.',
      },
      model: {
        type: 'string',
        description: 'Optional model override.',
      },
      artifactNamespace: {
        type: 'string',
        description: 'Optional folder slug override for saved artifacts.',
      },
    },
    required: ['goal', 'testCases'],
  },
};

export const handler: ToolHandler = async (params: any, context?: ToolContext) => {
  const result = await optimizeSkill({
    ...params,
    workingDirectory: params.workingDirectory || context?.workingDirectory,
  });

  return JSON.stringify({
    success: true,
    runId: result.runId,
    artifactDir: result.artifactDir,
    plateauReason: result.plateauReason,
    totalRounds: result.totalRounds,
    bestSkill: result.bestSkill,
    baselineScore: result.baseline.evaluation.overallScore,
    bestScore: result.rounds.length > 0
      ? Math.max(result.baseline.evaluation.overallScore, ...result.rounds.flatMap(round => round.candidates.map(candidate => candidate.evaluation.overallScore)))
      : result.baseline.evaluation.overallScore,
  });
};