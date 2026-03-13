import type { DashboardContext, RouteHandler } from '../types.js';
import { readBody, sendJson } from '../utils.js';
import { randomUUID } from 'node:crypto';
import { evaluateSkill, generateSkillDraft, optimizeSkill, regenerateRejectedSkillExamples } from '../../skill-builder/optimizer.js';
import {
  cleanupSkillDraftSessions,
  deleteSkillDraftSession,
  diffSkillVersions,
  listPublishedSkills,
  loadLatestSkillDraftSession,
  loadPublishedSkill,
  loadSkillDraftSession,
  listSkillDraftSessions,
  listSkillOptimizationRuns,
  listSkillRunArtifacts,
  loadSkillOptimizationReport,
  loadSkillVersionArtifact,
  savePublishedSkill,
  saveSkillDraftSession,
} from '../../skill-builder/storage.js';
import type { PublishedSkillRecord, SkillDraftSession, SkillDraftResult, SkillOptimizationRequest } from '../../skill-builder/types.js';

function deriveSkillFromDraft(draft: SkillDraftResult) {
  const skill = JSON.parse(JSON.stringify(draft.skill));
  skill.examples = draft.examples
    .filter(example => example.approvalStatus !== 'rejected' && example.testCase.expectedOutput != null)
    .slice(0, 6)
    .map(example => ({
      input: example.testCase.input,
      output: example.testCase.expectedOutput,
      note: example.critique || example.rationale,
    }));
  return skill;
}

function deriveTestCasesFromDraft(draft: SkillDraftResult) {
  return draft.examples
    .filter(example => example.approvalStatus !== 'rejected')
    .map(example => {
      const testCase = JSON.parse(JSON.stringify(example.testCase));
      if (example.critique) {
        testCase.rubricNotes = (testCase.rubricNotes ? `${testCase.rubricNotes}\n` : '') + `Reviewer critique: ${example.critique}`;
      }
      return testCase;
    });
}

function deriveRejectedCritiqueConstraints(draft: SkillDraftResult): string[] {
  return draft.examples
    .filter(example => example.approvalStatus === 'rejected' && example.critique)
    .map(example => `Avoid rejected draft example ${example.id}: ${example.critique}`);
}

function defaultAudience(body: any) {
  return {
    chat: body?.chat !== false,
    pipelines: body?.pipelines !== false,
  };
}

function buildPublishedSkillRecord(input: {
  existing?: PublishedSkillRecord | null;
  body: any;
  skill: any;
  source: PublishedSkillRecord['source'];
  notes?: string[];
}): PublishedSkillRecord {
  const now = new Date().toISOString();
  return {
    publishedSkillId: input.existing?.publishedSkillId || `published-skill-${randomUUID()}`,
    name: typeof input.body?.name === 'string' && input.body.name.trim()
      ? input.body.name.trim()
      : input.existing?.name || input.skill.name,
    description: typeof input.body?.description === 'string'
      ? input.body.description.trim() || undefined
      : input.existing?.description || input.skill.purpose,
    publishedAt: input.existing?.publishedAt || now,
    updatedAt: now,
    audience: defaultAudience(input.body),
    source: input.source,
    skill: input.skill,
    notes: input.notes,
  };
}

export const handleSkillOptimizerRoutes: RouteHandler = async (req, res, pathname, _url, ctx: DashboardContext) => {
  if (req.method === 'GET' && pathname === '/api/skills/library') {
    try {
      const skills = await listPublishedSkills(ctx.workDir);
      sendJson(res, 200, { skills });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const libraryMatch = pathname.match(/^\/api\/skills\/library\/([^/]+)$/);
  if (req.method === 'PATCH' && libraryMatch) {
    try {
      const publishedSkillId = decodeURIComponent(libraryMatch[1]);
      const existing = await loadPublishedSkill(ctx.workDir, publishedSkillId);
      if (!existing) {
        sendJson(res, 404, { error: 'Published skill not found' });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const updated: PublishedSkillRecord = {
        ...existing,
        name: typeof body?.name === 'string' ? body.name.trim() || existing.name : existing.name,
        description: typeof body?.description === 'string' ? body.description.trim() || undefined : existing.description,
        audience: {
          chat: typeof body?.chat === 'boolean' ? body.chat : existing.audience.chat,
          pipelines: typeof body?.pipelines === 'boolean' ? body.pipelines : existing.audience.pipelines,
        },
        unpublishedAt: typeof body?.unpublished === 'boolean'
          ? (body.unpublished ? new Date().toISOString() : undefined)
          : existing.unpublishedAt,
        updatedAt: new Date().toISOString(),
      };
      await savePublishedSkill(ctx.workDir, updated);
      sendJson(res, 200, { skill: updated });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/skills/drafts') {
    try {
      const sessions = await listSkillDraftSessions(ctx.workDir);
      sendJson(res, 200, { sessions });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/skills/drafts/latest') {
    try {
      const session = await loadLatestSkillDraftSession(ctx.workDir);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/skills/drafts/cleanup') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const result = await cleanupSkillDraftSessions(ctx.workDir, {
        olderThanDays: typeof body?.olderThanDays === 'number' ? body.olderThanDays : undefined,
        unapprovedOnly: typeof body?.unapprovedOnly === 'boolean' ? body.unapprovedOnly : true,
      });
      sendJson(res, 200, {
        deletedSessionIds: result.deletedSessionIds,
        deletedCount: result.deletedSessionIds.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const publishDraftMatch = pathname.match(/^\/api\/skills\/drafts\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishDraftMatch) {
    try {
      const sessionId = decodeURIComponent(publishDraftMatch[1]);
      const existing = await loadSkillDraftSession(ctx.workDir, sessionId);
      if (!existing) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      if (!existing.approvedForOptimization) {
        sendJson(res, 400, { error: 'Draft session must be approved before it can be published for reuse' });
        return true;
      }
      if (!deriveTestCasesFromDraft(existing.draft).length) {
        sendJson(res, 400, { error: 'Draft session must include at least one approved example before publishing' });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const existingPublished = (await listPublishedSkills(ctx.workDir)).find(skill => skill.source.type === 'draft' && skill.source.draftSessionId === sessionId);
      const publishedSkill = buildPublishedSkillRecord({
        existing: existingPublished,
        body,
        skill: deriveSkillFromDraft(existing.draft),
        source: { type: 'draft', draftSessionId: sessionId },
        notes: [`Published from draft session ${sessionId}`],
      });
      await savePublishedSkill(ctx.workDir, publishedSkill);
      sendJson(res, 200, { skill: publishedSkill });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const draftMatch = pathname.match(/^\/api\/skills\/drafts\/([^/]+)$/);
  if (req.method === 'GET' && draftMatch) {
    try {
      const session = await loadSkillDraftSession(ctx.workDir, decodeURIComponent(draftMatch[1]));
      if (!session) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'PATCH' && draftMatch) {
    try {
      const existing = await loadSkillDraftSession(ctx.workDir, decodeURIComponent(draftMatch[1]));
      if (!existing) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      const body = await readBody(req);
      const approvedForOptimization = typeof body?.approvedForOptimization === 'boolean'
        ? body.approvedForOptimization
        : existing.approvedForOptimization;
      const archivedAt = typeof body?.archived === 'boolean'
        ? (body.archived ? new Date().toISOString() : undefined)
        : existing.archivedAt;
      const session: SkillDraftSession = {
        ...existing,
        title: typeof body?.title === 'string' ? body.title.trim() || undefined : existing.title,
        draft: body?.draft || existing.draft,
        approvedForOptimization,
        approvalNote: typeof body?.approvalNote === 'string' ? body.approvalNote : existing.approvalNote,
        approvedAt: typeof body?.approvedForOptimization === 'boolean'
          ? (approvedForOptimization ? new Date().toISOString() : undefined)
          : existing.approvedAt,
        archivedAt,
        updatedAt: new Date().toISOString(),
      };
      await saveSkillDraftSession(ctx.workDir, session);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'DELETE' && draftMatch) {
    try {
      const deleted = await deleteSkillDraftSession(ctx.workDir, decodeURIComponent(draftMatch[1]));
      if (!deleted) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/skills/draft') {
    try {
      const body = await readBody(req);
      if (!body?.description || !String(body.description).trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }
      const draft = await generateSkillDraft({
        ...body,
        goal: body.goal || body.description,
      });
      const now = new Date().toISOString();
      const session: SkillDraftSession = {
        sessionId: `skill-draft-${randomUUID()}`,
        title: typeof body?.title === 'string' ? body.title.trim() || undefined : undefined,
        createdAt: now,
        updatedAt: now,
        request: {
          ...body,
          goal: body.goal || body.description,
        },
        draft,
        approvedForOptimization: false,
      };
      await saveSkillDraftSession(ctx.workDir, session);
      sendJson(res, 200, { draft, session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const regenerateMatch = pathname.match(/^\/api\/skills\/drafts\/([^/]+)\/regenerate-rejected$/);
  if (req.method === 'POST' && regenerateMatch) {
    try {
      const existing = await loadSkillDraftSession(ctx.workDir, decodeURIComponent(regenerateMatch[1]));
      if (!existing) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      const nextDraft = await regenerateRejectedSkillExamples({ session: existing });
      const session: SkillDraftSession = {
        ...existing,
        draft: nextDraft,
        approvedForOptimization: false,
        approvedAt: undefined,
        updatedAt: new Date().toISOString(),
      };
      await saveSkillDraftSession(ctx.workDir, session);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const approveDraftMatch = pathname.match(/^\/api\/skills\/drafts\/([^/]+)\/(approve|unapprove)$/);
  if (req.method === 'POST' && approveDraftMatch) {
    try {
      const existing = await loadSkillDraftSession(ctx.workDir, decodeURIComponent(approveDraftMatch[1]));
      if (!existing) {
        sendJson(res, 404, { error: 'Draft session not found' });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const approved = approveDraftMatch[2] === 'approve';
      const session: SkillDraftSession = {
        ...existing,
        approvedForOptimization: approved,
        approvedAt: approved ? new Date().toISOString() : undefined,
        approvalNote: typeof body?.approvalNote === 'string' ? body.approvalNote : existing.approvalNote,
        updatedAt: new Date().toISOString(),
      };
      await saveSkillDraftSession(ctx.workDir, session);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/skills/runs') {
    try {
      const runs = await listSkillOptimizationRuns(ctx.workDir);
      sendJson(res, 200, { runs });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const publishRunMatch = pathname.match(/^\/api\/skills\/runs\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishRunMatch) {
    try {
      const runId = decodeURIComponent(publishRunMatch[1]);
      const report = await loadSkillOptimizationReport(ctx.workDir, runId);
      if (!report) {
        sendJson(res, 404, { error: 'Run not found' });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const existingPublished = (await listPublishedSkills(ctx.workDir)).find(skill => skill.source.type === 'run' && skill.source.runId === runId && skill.source.version === report.bestSkill.version);
      const publishedSkill = buildPublishedSkillRecord({
        existing: existingPublished,
        body,
        skill: report.bestSkill,
        source: { type: 'run', runId, version: report.bestSkill.version },
        notes: [`Published from optimization run ${runId}`, `Best skill version ${report.bestSkill.version}`],
      });
      await savePublishedSkill(ctx.workDir, publishedSkill);
      sendJson(res, 200, { skill: publishedSkill });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const runMatch = pathname.match(/^\/api\/skills\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runMatch) {
    try {
      const report = await loadSkillOptimizationReport(ctx.workDir, decodeURIComponent(runMatch[1]));
      if (!report) {
        sendJson(res, 404, { error: 'Run not found' });
        return true;
      }
      sendJson(res, 200, { run: report });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const artifactsMatch = pathname.match(/^\/api\/skills\/runs\/([^/]+)\/artifacts$/);
  if (req.method === 'GET' && artifactsMatch) {
    try {
      const artifacts = await listSkillRunArtifacts(ctx.workDir, decodeURIComponent(artifactsMatch[1]));
      sendJson(res, 200, { artifacts });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const versionMatch = pathname.match(/^\/api\/skills\/runs\/([^/]+)\/versions\/(\d+)$/);
  if (req.method === 'GET' && versionMatch) {
    try {
      const artifact = await loadSkillVersionArtifact(
        ctx.workDir,
        decodeURIComponent(versionMatch[1]),
        Number(versionMatch[2]),
      );
      if (!artifact) {
        sendJson(res, 404, { error: 'Version artifact not found' });
        return true;
      }
      sendJson(res, 200, { artifact });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  const diffMatch = pathname.match(/^\/api\/skills\/runs\/([^/]+)\/diff$/);
  if (req.method === 'GET' && diffMatch) {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const left = Number(url.searchParams.get('left'));
      const right = Number(url.searchParams.get('right'));
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        sendJson(res, 400, { error: 'left and right version query params are required' });
        return true;
      }
      const diff = await diffSkillVersions(ctx.workDir, decodeURIComponent(diffMatch[1]), left, right);
      if (!diff) {
        sendJson(res, 404, { error: 'Diff not found' });
        return true;
      }
      sendJson(res, 200, { diff });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/skills/optimize') {
    try {
      const body = await readBody(req);
      let request: SkillOptimizationRequest = {
        ...body,
        workingDirectory: body.workingDirectory || ctx.workDir,
      };

      if (body?.draftSessionId) {
        const session = await loadSkillDraftSession(ctx.workDir, String(body.draftSessionId));
        if (!session) {
          sendJson(res, 404, { error: 'Draft session not found' });
          return true;
        }
        if (!session.approvedForOptimization) {
          sendJson(res, 400, { error: 'Draft session must be explicitly approved before optimization begins' });
          return true;
        }
        const draftCases = deriveTestCasesFromDraft(session.draft);
        if (!draftCases.length) {
          sendJson(res, 400, { error: 'Approved draft must include at least one non-rejected example' });
          return true;
        }
        request = {
          ...request,
          goal: body.goal || session.request.goal || session.request.description,
          artifactNamespace: body.artifactNamespace || session.request.artifactNamespace,
          constraints: [
            ...((session.request.constraints || []).filter(Boolean)),
            ...deriveRejectedCritiqueConstraints(session.draft),
            ...((body.constraints || []).filter(Boolean)),
          ],
          baseSkill: body.baseSkill || deriveSkillFromDraft(session.draft),
          testCases: draftCases,
        };
      }

      const result = await optimizeSkill(request);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/skills/evaluate') {
    try {
      const body = await readBody(req);
      if (!body?.skill || !Array.isArray(body?.testCases)) {
        sendJson(res, 400, { error: 'skill and testCases are required' });
        return true;
      }
      const evaluation = await evaluateSkill(body.skill, body.testCases, undefined, body.budgets);
      sendJson(res, 200, evaluation);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};