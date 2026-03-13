import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { evaluateSkill, generateSkillDraft, optimizeSkill, regenerateRejectedSkillExamples } from '../skill-builder/optimizer.js';
import { diffSkillVersions, formatPublishedSkillsPromptSection, listPublishedSkills, listSkillDraftSessions, listSkillOptimizationRuns, loadLatestSkillDraftSession, loadSkillDraftSession, saveSkillDraftSession } from '../skill-builder/storage.js';
import { handleSkillOptimizerRoutes } from '../dashboard/routes/skill-optimizer.js';
import type { SkillDraftSession, SkillOptimizationRequest, SkillOptimizerServices, SkillSpec, SkillTestCase } from '../skill-builder/types.js';

function makeSkill(instructions: string[], version: number = 1): SkillSpec {
  return {
    name: 'ticket_skill',
    purpose: 'Summarize account status correctly.',
    triggerConditions: ['ticket summary requested'],
    inputs: { ticket: 'string' },
    instructions,
    outputFormat: { type: 'text' },
    examples: [],
    version,
  };
}

function makeRunSkillCase() {
  return async (skill: SkillSpec, testCase: SkillTestCase) => {
    const includeAcme = skill.instructions.some(line => line.includes('ACME'));
    const includeVerified = skill.instructions.some(line => line.includes('verified'));
    const parts: string[] = [];
    if (includeAcme) parts.push('ACME');
    if (includeVerified) parts.push('verified');
    if (parts.length === 0) parts.push('generic');
    return {
      output: `${parts.join(' ')} :: ${testCase.id}`,
      durationMs: 120,
      tokenUsage: { totalTokens: 250 },
    };
  };
}

async function invokeSkillRoute(workDir: string, method: string, pathname: string, body?: unknown) {
  const payload = body == null ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf-8')] : []) as any;
  req.method = method;
  req.url = pathname;

  let statusCode = 0;
  let responseBody = '';
  const res = {
    headersSent: false,
    writeHead: (status: number) => {
      statusCode = status;
      res.headersSent = true;
    },
    end: (chunk?: string) => {
      responseBody = chunk || '';
    },
  } as any;

  const handled = await handleSkillOptimizerRoutes(
    req,
    res,
    pathname,
    new URL(`http://localhost${pathname}`),
    {
      workDir,
      pendingApprovals: new Map(),
    } as any,
  );

  return {
    handled,
    statusCode,
    body: responseBody ? JSON.parse(responseBody) : null,
  };
}

describe('skill optimizer', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'woodbury-skill-optimizer-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('improves a skill, saves artifacts, and stops after plateau', async () => {
    const baseSkill = makeSkill(['Be concise.'], 1);
    const testCases: SkillTestCase[] = [
      {
        id: 'seed-1',
        input: { ticket: 'Account belongs to ACME and is verified.' },
        split: 'seed',
        deterministicChecks: [
          { type: 'contains', value: 'ACME' },
        ],
      },
      {
        id: 'holdout-1',
        input: { ticket: 'Verified customer' },
        split: 'holdout',
        deterministicChecks: [
          { type: 'contains', value: 'verified' },
        ],
      },
    ];

    const services: SkillOptimizerServices = {
      runSkillCase: makeRunSkillCase(),
      generateCandidateSkills: async ({ round }) => {
        if (round === 1) {
          return [
            makeSkill(['Always mention ACME.', 'Always mention verified.']),
            makeSkill(['Only mention ACME.']),
          ];
        }
        return [makeSkill(['Always mention ACME.', 'Always mention verified.'])];
      },
      analyzeFailures: async ({ evaluation }) => ({
        summary: 'Missing required entities.',
        recommendations: evaluation.lowSignalFailures.flatMap(entry => entry.issues),
        recurringIssues: ['Missing required output terms'],
      }),
    };

    const request: SkillOptimizationRequest = {
      goal: 'Summarize the account status without dropping required facts.',
      baseSkill,
      testCases,
      workingDirectory: workDir,
      candidatesPerRound: 2,
      maxRounds: 3,
      patience: 1,
      minImprovement: 0.01,
      artifactNamespace: 'ticket-summary-skill',
    };

    const result = await optimizeSkill(request, services);

    expect(result.bestSkill.instructions).toContain('Always mention ACME.');
    expect(result.bestSkill.instructions).toContain('Always mention verified.');
    expect(result.baseline.evaluation.overallScore).toBeLessThan(result.rounds[0].candidates[0].evaluation.overallScore);
    expect(result.totalRounds).toBe(2);
    expect(result.plateauReason).toBe('no_improvement');

    await expect(stat(join(result.artifactDir, 'best-skill.json'))).resolves.toBeDefined();
    await expect(stat(join(result.artifactDir, 'report.json'))).resolves.toBeDefined();
    await expect(stat(join(result.artifactDir, 'versions', 'skill-v001.json'))).resolves.toBeDefined();
  });

  it('generates a reviewable skill draft from a description', async () => {
    const draft = await generateSkillDraft({
      description: 'Create a skill that summarizes support tickets into a short status update with customer name and verification state.',
      goal: 'Generate a structured support-ticket summarizer skill.',
      exampleCount: 3,
    }, {
      generateSkillDraft: async () => ({
        skill: makeSkill(['Mention the customer name.', 'Mention whether the account is verified.']),
        examples: [
          {
            id: 'draft-1',
            approvalStatus: 'approved',
            testCase: {
              id: 'seed-1',
              input: { ticket: 'ACME account is verified.' },
              expectedOutput: 'ACME verified',
              split: 'seed',
              deterministicChecks: [{ type: 'contains', value: 'ACME' }],
            },
            rationale: 'Covers the common verified-account happy path.',
          },
        ],
        notes: ['Review whether the expected output is concise enough.'],
      }),
    });

    expect(draft.skill.version).toBe(1);
    expect(draft.skill.instructions).toContain('Mention the customer name.');
    expect(draft.examples).toHaveLength(1);
    expect(draft.examples[0].approvalStatus).toBe('approved');
    expect(draft.examples[0].testCase.id).toBe('seed-1');
    expect(draft.notes).toContain('Review whether the expected output is concise enough.');
  });

  it('persists the latest draft session and regenerates only rejected examples', async () => {
    const session: SkillDraftSession = {
      sessionId: 'draft-session-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: {
        description: 'Summarize tickets with verification state.',
        goal: 'Build a ticket summary skill.',
      },
      draft: {
        skill: makeSkill(['Mention whether the account is verified.']),
        examples: [
          {
            id: 'approved-1',
            approvalStatus: 'approved',
            testCase: {
              id: 'seed-1',
              input: { ticket: 'Verified account.' },
              expectedOutput: 'verified',
              split: 'seed',
            },
          },
          {
            id: 'rejected-1',
            approvalStatus: 'rejected',
            critique: 'Make the example realistic and mention ACME.',
            testCase: {
              id: 'seed-2',
              input: { ticket: 'Bad sample' },
              expectedOutput: 'generic',
              split: 'seed',
            },
          },
        ],
      },
      approvedForOptimization: false,
    };

    await saveSkillDraftSession(workDir, session);
    const loaded = await loadLatestSkillDraftSession(workDir);
    expect(loaded?.sessionId).toBe('draft-session-1');

    const regenerated = await regenerateRejectedSkillExamples({ session }, {
      generateReplacementExamples: async () => ([
        {
          id: 'replacement',
          approvalStatus: 'approved',
          rationale: 'Matches the reviewer critique.',
          testCase: {
            id: 'seed-2b',
            input: { ticket: 'ACME account is verified.' },
            expectedOutput: 'ACME verified',
            split: 'seed',
          },
        },
      ]),
    });

    expect(regenerated.examples[0].id).toBe('approved-1');
    expect(regenerated.examples[0].testCase.id).toBe('seed-1');
    expect(regenerated.examples[1].id).toBe('rejected-1');
    expect(regenerated.examples[1].approvalStatus).toBe('approved');
    expect(regenerated.examples[1].testCase.input).toEqual({ ticket: 'ACME account is verified.' });
  });

  it('lists draft sessions newest first for sidebar history', async () => {
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-older',
      createdAt: '2026-03-13T10:00:00.000Z',
      updatedAt: '2026-03-13T10:05:00.000Z',
      request: { description: 'Older draft' },
      draft: { skill: makeSkill(['Older']), examples: [] },
      approvedForOptimization: false,
    });
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-newer',
      createdAt: '2026-03-13T11:00:00.000Z',
      updatedAt: '2026-03-13T11:05:00.000Z',
      request: { description: 'Newer draft' },
      draft: { skill: makeSkill(['Newer']), examples: [] },
      approvedForOptimization: true,
    });

    const sessions = await listSkillDraftSessions(workDir);
    expect(sessions.map(session => session.sessionId)).toEqual(['draft-newer', 'draft-older']);
  });

  it('renames and deletes draft sessions through storage and route helpers', async () => {
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-editable',
      createdAt: '2026-03-13T12:00:00.000Z',
      updatedAt: '2026-03-13T12:00:00.000Z',
      request: { description: 'Editable draft' },
      draft: { skill: makeSkill(['Editable']), examples: [] },
      approvedForOptimization: false,
    });

    const renameResponse = await invokeSkillRoute(workDir, 'PATCH', '/api/skills/drafts/draft-editable', {
      title: 'Renamed Draft Session',
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.body.session.title).toBe('Renamed Draft Session');

    const stored = await loadSkillDraftSession(workDir, 'draft-editable');
    expect(stored?.title).toBe('Renamed Draft Session');

    const deleteResponse = await invokeSkillRoute(workDir, 'DELETE', '/api/skills/drafts/draft-editable');
    expect(deleteResponse.statusCode).toBe(200);
    expect(await loadSkillDraftSession(workDir, 'draft-editable')).toBeNull();
  });

  it('archives drafts and bulk deletes stale unapproved sessions', async () => {
    const staleTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const freshTimestamp = new Date().toISOString();

    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-stale-unapproved',
      createdAt: staleTimestamp,
      updatedAt: staleTimestamp,
      request: { description: 'Old review draft' },
      draft: { skill: makeSkill(['Old draft']), examples: [] },
      approvedForOptimization: false,
    });
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-stale-approved',
      createdAt: staleTimestamp,
      updatedAt: staleTimestamp,
      request: { description: 'Protected approved draft' },
      draft: { skill: makeSkill(['Approved draft']), examples: [] },
      approvedForOptimization: true,
      approvedAt: staleTimestamp,
    });
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-fresh',
      createdAt: freshTimestamp,
      updatedAt: freshTimestamp,
      request: { description: 'Fresh draft' },
      draft: { skill: makeSkill(['Fresh draft']), examples: [] },
      approvedForOptimization: false,
    });

    const archiveResponse = await invokeSkillRoute(workDir, 'PATCH', '/api/skills/drafts/draft-fresh', {
      archived: true,
    });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.body.session.archivedAt).toBeTruthy();

    const cleanupResponse = await invokeSkillRoute(workDir, 'POST', '/api/skills/drafts/cleanup', {
      olderThanDays: 7,
      unapprovedOnly: true,
    });
    expect(cleanupResponse.statusCode).toBe(200);
    expect(cleanupResponse.body.deletedSessionIds).toEqual(['draft-stale-unapproved']);
    expect(await loadSkillDraftSession(workDir, 'draft-stale-unapproved')).toBeNull();
    expect(await loadSkillDraftSession(workDir, 'draft-stale-approved')).not.toBeNull();
    expect((await loadSkillDraftSession(workDir, 'draft-fresh'))?.archivedAt).toBeTruthy();
  });

  it('publishes approved draft skills into the reusable library', async () => {
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-publishable',
      createdAt: '2026-03-13T13:00:00.000Z',
      updatedAt: '2026-03-13T13:00:00.000Z',
      request: { description: 'Reusable support summary skill', goal: 'Summarize support tickets' },
      draft: {
        skill: makeSkill(['Mention ACME', 'Mention verified']),
        examples: [
          {
            id: 'approved-example',
            approvalStatus: 'approved',
            testCase: {
              id: 'seed-1',
              input: { ticket: 'ACME account is verified' },
              expectedOutput: 'ACME verified',
              split: 'seed',
            },
          },
        ],
      },
      approvedForOptimization: true,
      approvedAt: '2026-03-13T13:05:00.000Z',
    });

    const publishResponse = await invokeSkillRoute(workDir, 'POST', '/api/skills/drafts/draft-publishable/publish');
    expect(publishResponse.statusCode).toBe(200);
    expect(publishResponse.body.skill.audience.chat).toBe(true);
    expect(publishResponse.body.skill.audience.pipelines).toBe(true);

    const library = await listPublishedSkills(workDir);
    expect(library).toHaveLength(1);
    expect(library[0].source).toEqual({ type: 'draft', draftSessionId: 'draft-publishable' });
    expect(library[0].skill.examples?.[0].output).toBe('ACME verified');
  });

  it('can unpublish and republish library skills directly', async () => {
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-library-toggle',
      createdAt: '2026-03-13T13:00:00.000Z',
      updatedAt: '2026-03-13T13:00:00.000Z',
      request: { description: 'Library toggle draft', goal: 'Summarize support tickets' },
      draft: {
        skill: makeSkill(['Mention ACME']),
        examples: [
          {
            id: 'approved-example',
            approvalStatus: 'approved',
            testCase: {
              id: 'seed-1',
              input: { ticket: 'ACME account is verified' },
              expectedOutput: 'ACME verified',
              split: 'seed',
            },
          },
        ],
      },
      approvedForOptimization: true,
      approvedAt: '2026-03-13T13:05:00.000Z',
    });

    const publishResponse = await invokeSkillRoute(workDir, 'POST', '/api/skills/drafts/draft-library-toggle/publish');
    const publishedSkillId = publishResponse.body.skill.publishedSkillId;

    const unpublishResponse = await invokeSkillRoute(workDir, 'PATCH', '/api/skills/library/' + publishedSkillId, {
      unpublished: true,
    });
    expect(unpublishResponse.statusCode).toBe(200);
    expect(unpublishResponse.body.skill.unpublishedAt).toBeTruthy();

    const republishResponse = await invokeSkillRoute(workDir, 'PATCH', '/api/skills/library/' + publishedSkillId, {
      unpublished: false,
      pipelines: false,
    });
    expect(republishResponse.statusCode).toBe(200);
    expect(republishResponse.body.skill.unpublishedAt).toBeUndefined();
    expect(republishResponse.body.skill.audience.pipelines).toBe(false);
  });

  it('formats only selected published skills for pipeline prompts', async () => {
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-selected-a',
      createdAt: '2026-03-13T13:00:00.000Z',
      updatedAt: '2026-03-13T13:00:00.000Z',
      request: { description: 'Skill A', goal: 'Summarize support tickets' },
      draft: {
        skill: makeSkill(['Mention ACME']),
        examples: [{ id: 'approved-a', approvalStatus: 'approved', testCase: { id: 'seed-a', input: { ticket: 'A' }, expectedOutput: 'A', split: 'seed' } }],
      },
      approvedForOptimization: true,
      approvedAt: '2026-03-13T13:05:00.000Z',
    });
    await saveSkillDraftSession(workDir, {
      sessionId: 'draft-selected-b',
      createdAt: '2026-03-13T13:10:00.000Z',
      updatedAt: '2026-03-13T13:10:00.000Z',
      request: { description: 'Skill B', goal: 'Classify support tickets' },
      draft: {
        skill: { ...makeSkill(['Mention verified']), name: 'ticket_classifier' },
        examples: [{ id: 'approved-b', approvalStatus: 'approved', testCase: { id: 'seed-b', input: { ticket: 'B' }, expectedOutput: 'B', split: 'seed' } }],
      },
      approvedForOptimization: true,
      approvedAt: '2026-03-13T13:15:00.000Z',
    });

    const publishA = await invokeSkillRoute(workDir, 'POST', '/api/skills/drafts/draft-selected-a/publish');
    const publishB = await invokeSkillRoute(workDir, 'POST', '/api/skills/drafts/draft-selected-b/publish');
    const section = await formatPublishedSkillsPromptSection(workDir, {
      audience: 'pipelines',
      selectedSkillIds: [publishB.body.skill.publishedSkillId],
    });

    expect(section).toContain('ticket_classifier');
    expect(section).not.toContain('ticket_skill');
    expect(section).not.toContain(publishA.body.skill.publishedSkillId);
  });

  it('blocks optimization until the draft session is explicitly approved', async () => {
    const session: SkillDraftSession = {
      sessionId: 'draft-session-2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: {
        description: 'Summarize tickets with verification state.',
        goal: 'Build a ticket summary skill.',
      },
      draft: {
        skill: makeSkill(['Mention whether the account is verified.']),
        examples: [
          {
            id: 'approved-1',
            approvalStatus: 'approved',
            testCase: {
              id: 'seed-1',
              input: { ticket: 'Verified account.' },
              expectedOutput: 'verified',
              split: 'seed',
              deterministicChecks: [{ type: 'contains', value: 'verified' }],
            },
          },
        ],
      },
      approvedForOptimization: false,
    };

    await saveSkillDraftSession(workDir, session);
    const response = await invokeSkillRoute(workDir, 'POST', '/api/skills/optimize', {
      draftSessionId: session.sessionId,
      goal: session.request.goal,
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toContain('explicitly approved');
  });

  it('keeps the current best when a candidate overfits seed cases and hurts holdout', async () => {
    const baseSkill = makeSkill(['Always mention verified.'], 1);
    const testCases: SkillTestCase[] = [
      {
        id: 'seed-1',
        input: { ticket: 'Account belongs to ACME.' },
        split: 'seed',
        deterministicChecks: [{ type: 'contains', value: 'ACME' }],
      },
      {
        id: 'holdout-1',
        input: { ticket: 'Verified account.' },
        split: 'holdout',
        deterministicChecks: [{ type: 'contains', value: 'verified' }],
      },
    ];

    const services: SkillOptimizerServices = {
      runSkillCase: makeRunSkillCase(),
      generateCandidateSkills: async () => [makeSkill(['Always mention ACME.'])],
      analyzeFailures: async () => ({
        summary: 'Candidate drops holdout fact.',
        recommendations: ['Do not remove verified coverage.'],
        recurringIssues: ['holdout regression'],
      }),
    };

    const result = await optimizeSkill({
      goal: 'Preserve holdout quality while improving seed performance.',
      baseSkill,
      testCases,
      workingDirectory: workDir,
      maxRounds: 2,
      patience: 1,
      minImprovement: 0.01,
      pairwiseJudging: true,
    }, services);

    expect(result.bestSkill.instructions).toContain('Always mention verified.');
    expect(result.bestSkill.instructions).not.toContain('Always mention ACME.');
    expect(result.rounds[0].acceptedWinner).toBe(false);
    expect(result.rounds[0].candidates[0].pairwiseComparison?.preferred).toBe('best');
  });

  it('rejects budget-breaking candidates and persists run index and diffs', async () => {
    const baseSkill = makeSkill(['Always mention verified.'], 1);
    const testCases: SkillTestCase[] = [
      {
        id: 'seed-1',
        input: { ticket: 'Account belongs to ACME and is verified.' },
        split: 'seed',
        deterministicChecks: [
          { type: 'contains', value: 'ACME' },
          { type: 'contains', value: 'verified' },
        ],
      },
    ];

    const services: SkillOptimizerServices = {
      runSkillCase: async (skill, testCase) => {
        const premium = skill.instructions.some(line => line.includes('ACME'));
        return {
          output: premium ? `ACME verified :: ${testCase.id}` : `verified :: ${testCase.id}`,
          durationMs: premium ? 2500 : 120,
          tokenUsage: { totalTokens: premium ? 2400 : 250 },
        };
      },
      generateCandidateSkills: async () => [makeSkill(['Always mention ACME.', 'Always mention verified.'])],
      analyzeFailures: async () => ({
        summary: 'Budget regression.',
        recommendations: ['Keep costs low.'],
        recurringIssues: ['budget pressure'],
      }),
    };

    const result = await optimizeSkill({
      goal: 'Improve factual coverage without exceeding budgets.',
      baseSkill,
      testCases,
      workingDirectory: workDir,
      maxRounds: 1,
      patience: 1,
      minImprovement: 0.01,
      artifactNamespace: 'budget-check',
      pairwiseJudging: true,
      budgets: {
        maxTotalTokens: 1000,
        hardFailOnBudgetExceeded: true,
      },
    }, services);

    expect(result.rounds[0].acceptedWinner).toBe(false);
    expect(result.rounds[0].candidates[0].evaluation.budget.exceeded).toBe(true);
    expect(result.bestSkill.instructions).toEqual(baseSkill.instructions);

    const runs = await listSkillOptimizationRuns(workDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(result.runId);
    expect(runs[0].namespace).toBe('budget-check');

    const diff = await diffSkillVersions(workDir, result.runId, 1, 2);
    expect(diff).not.toBeNull();
    expect(diff?.pairwiseComparison?.preferred).toBe('best');
  });

  it('evaluates a skill without the optimization loop', async () => {
    const skill = makeSkill(['Always mention ACME.', 'Always mention verified.']);
    const summary = await evaluateSkill(skill, [
      {
        id: 'golden-1',
        input: { ticket: 'ACME verified customer' },
        split: 'golden',
        deterministicChecks: [
          { type: 'contains', value: 'ACME' },
          { type: 'contains', value: 'verified' },
        ],
      },
    ], {
      runSkillCase: makeRunSkillCase(),
    }, {
      maxTotalTokens: 1000,
    });

    expect(summary.totalCases).toBe(1);
    expect(summary.overallScore).toBeGreaterThan(0.9);
    expect(summary.splitScores.golden).toBeGreaterThan(0.9);
    expect(summary.totalTokensUsed).toBe(250);
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);
    expect(summary.budget.exceeded).toBe(false);
  });
});