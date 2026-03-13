import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SkillDraftSession,
  SkillCandidateResult,
  SkillOptimizationIndexEntry,
  SkillOptimizationResult,
  PublishedSkillRecord,
} from './types.js';

function baseDir(workingDirectory: string): string {
  return join(workingDirectory, '.woodbury-work', 'skill-builder');
}

function indexPath(workingDirectory: string): string {
  return join(baseDir(workingDirectory), 'index.json');
}

function draftsDir(workingDirectory: string): string {
  return join(baseDir(workingDirectory), 'drafts');
}

function draftIndexPath(workingDirectory: string): string {
  return join(draftsDir(workingDirectory), 'index.json');
}

function draftSessionPath(workingDirectory: string, sessionId: string): string {
  return join(draftsDir(workingDirectory), `${sessionId}.json`);
}

function publishedSkillsDir(workingDirectory: string): string {
  return join(baseDir(workingDirectory), 'published');
}

function publishedSkillsIndexPath(workingDirectory: string): string {
  return join(publishedSkillsDir(workingDirectory), 'index.json');
}

function publishedSkillPath(workingDirectory: string, publishedSkillId: string): string {
  return join(publishedSkillsDir(workingDirectory), `${publishedSkillId}.json`);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export async function listSkillOptimizationRuns(workingDirectory: string): Promise<SkillOptimizationIndexEntry[]> {
  const entries = await readJson<SkillOptimizationIndexEntry[]>(indexPath(workingDirectory), []);
  return entries.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export async function saveSkillOptimizationIndexEntry(workingDirectory: string, entry: SkillOptimizationIndexEntry): Promise<void> {
  await mkdir(baseDir(workingDirectory), { recursive: true });
  const existing = await readJson<SkillOptimizationIndexEntry[]>(indexPath(workingDirectory), []);
  const next = existing.filter(candidate => candidate.runId !== entry.runId);
  next.push(entry);
  next.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  await writeJson(indexPath(workingDirectory), next);
}

export async function listSkillDraftSessions(workingDirectory: string): Promise<SkillDraftSession[]> {
  const entries = await readJson<string[]>(draftIndexPath(workingDirectory), []);
  const sessions = await Promise.all(entries.map(sessionId => readJson<SkillDraftSession | null>(draftSessionPath(workingDirectory, sessionId), null)));
  return sessions
    .filter((session): session is SkillDraftSession => !!session)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export async function loadSkillDraftSession(workingDirectory: string, sessionId: string): Promise<SkillDraftSession | null> {
  return readJson<SkillDraftSession | null>(draftSessionPath(workingDirectory, sessionId), null);
}

export async function loadLatestSkillDraftSession(workingDirectory: string): Promise<SkillDraftSession | null> {
  const sessions = await listSkillDraftSessions(workingDirectory);
  return sessions[0] || null;
}

export async function saveSkillDraftSession(workingDirectory: string, session: SkillDraftSession): Promise<void> {
  await mkdir(draftsDir(workingDirectory), { recursive: true });
  await writeJson(draftSessionPath(workingDirectory, session.sessionId), session);
  const existing = await readJson<string[]>(draftIndexPath(workingDirectory), []);
  const next = [session.sessionId].concat(existing.filter(candidate => candidate !== session.sessionId));
  await writeJson(draftIndexPath(workingDirectory), next);
}

export async function deleteSkillDraftSession(workingDirectory: string, sessionId: string): Promise<boolean> {
  const existing = await readJson<string[]>(draftIndexPath(workingDirectory), []);
  if (!existing.includes(sessionId)) {
    return false;
  }
  await rm(draftSessionPath(workingDirectory, sessionId), { force: true });
  await writeJson(draftIndexPath(workingDirectory), existing.filter(candidate => candidate !== sessionId));
  return true;
}

export async function cleanupSkillDraftSessions(
  workingDirectory: string,
  options: { olderThanDays?: number; unapprovedOnly?: boolean } = {},
): Promise<{ deletedSessionIds: string[] }> {
  const olderThanDays = Number.isFinite(options.olderThanDays) ? Math.max(0, Number(options.olderThanDays)) : 7;
  const unapprovedOnly = options.unapprovedOnly !== false;
  const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const sessions = await listSkillDraftSessions(workingDirectory);
  const deletedSessionIds: string[] = [];

  for (const session of sessions) {
    const updatedTime = new Date(session.updatedAt || session.createdAt).getTime();
    if (Number.isNaN(updatedTime) || updatedTime >= cutoffTime) {
      continue;
    }
    if (unapprovedOnly && session.approvedForOptimization) {
      continue;
    }
    const deleted = await deleteSkillDraftSession(workingDirectory, session.sessionId);
    if (deleted) {
      deletedSessionIds.push(session.sessionId);
    }
  }

  return { deletedSessionIds };
}

export async function listPublishedSkills(workingDirectory: string): Promise<PublishedSkillRecord[]> {
  const entries = await readJson<string[]>(publishedSkillsIndexPath(workingDirectory), []);
  const skills = await Promise.all(entries.map(skillId => readJson<PublishedSkillRecord | null>(publishedSkillPath(workingDirectory, skillId), null)));
  return skills
    .filter((skill): skill is PublishedSkillRecord => !!skill)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export async function loadPublishedSkill(workingDirectory: string, publishedSkillId: string): Promise<PublishedSkillRecord | null> {
  return readJson<PublishedSkillRecord | null>(publishedSkillPath(workingDirectory, publishedSkillId), null);
}

export async function savePublishedSkill(workingDirectory: string, skill: PublishedSkillRecord): Promise<void> {
  await mkdir(publishedSkillsDir(workingDirectory), { recursive: true });
  await writeJson(publishedSkillPath(workingDirectory, skill.publishedSkillId), skill);
  const existing = await readJson<string[]>(publishedSkillsIndexPath(workingDirectory), []);
  const next = [skill.publishedSkillId].concat(existing.filter(candidate => candidate !== skill.publishedSkillId));
  await writeJson(publishedSkillsIndexPath(workingDirectory), next);
}

function matchesAudience(skill: PublishedSkillRecord, audience: 'chat' | 'pipelines' | 'all'): boolean {
  if (skill.unpublishedAt) {
    return false;
  }
  if (audience === 'all') {
    return skill.audience.chat || skill.audience.pipelines;
  }
  return audience === 'chat' ? skill.audience.chat : skill.audience.pipelines;
}

export async function formatPublishedSkillsPromptSection(
  workingDirectory: string,
  options: { audience?: 'chat' | 'pipelines' | 'all'; maxSkills?: number; selectedSkillIds?: string[] } = {},
): Promise<string> {
  const audience = options.audience || 'all';
  const maxSkills = Number.isFinite(options.maxSkills) ? Math.max(1, Number(options.maxSkills)) : 6;
  const selectedSkillIds = Array.isArray(options.selectedSkillIds) && options.selectedSkillIds.length
    ? new Set(options.selectedSkillIds)
    : null;
  const skills = (await listPublishedSkills(workingDirectory))
    .filter(skill => !selectedSkillIds || selectedSkillIds.has(skill.publishedSkillId))
    .filter(skill => matchesAudience(skill, audience))
    .slice(0, maxSkills);

  if (!skills.length) {
    return '';
  }

  const blocks = skills.map(skill => {
    const triggerText = (skill.skill.triggerConditions || []).slice(0, 3).join('; ') || 'No trigger conditions specified';
    const instructionText = (skill.skill.instructions || []).slice(0, 4).join(' | ') || 'No instructions specified';
    const inputKeys = Object.keys(skill.skill.inputs || {});
    return [
      `- ${skill.name}`,
      `  Purpose: ${skill.description || skill.skill.purpose || 'No description provided'}`,
      `  Use when: ${triggerText}`,
      `  Inputs: ${inputKeys.length ? inputKeys.join(', ') : 'none specified'}`,
      `  Guidance: ${instructionText}`,
    ].join('\n');
  });

  return `## Published Skills Library\nUse these reusable published skills when relevant instead of reinventing the behavior from scratch. Apply them directly in chat responses and when designing or generating pipelines.\n\n${blocks.join('\n\n')}`;
}

export async function loadSkillOptimizationReport(workingDirectory: string, runId: string): Promise<SkillOptimizationResult | null> {
  const entries = await listSkillOptimizationRuns(workingDirectory);
  const entry = entries.find(candidate => candidate.runId === runId);
  if (!entry) {
    return null;
  }
  return readJson<SkillOptimizationResult | null>(join(entry.artifactDir, 'report.json'), null);
}

export async function loadSkillVersionArtifact(workingDirectory: string, runId: string, version: number): Promise<SkillCandidateResult | null> {
  const report = await loadSkillOptimizationReport(workingDirectory, runId);
  if (!report) {
    return null;
  }
  return readJson<SkillCandidateResult | null>(
    join(report.artifactDir, 'versions', `skill-v${String(version).padStart(3, '0')}.json`),
    null,
  );
}

function arrayDiff(left: string[] = [], right: string[] = []): { added: string[]; removed: string[] } {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    added: right.filter(value => !leftSet.has(value)),
    removed: left.filter(value => !rightSet.has(value)),
  };
}

export async function diffSkillVersions(workingDirectory: string, runId: string, leftVersion: number, rightVersion: number): Promise<any | null> {
  const left = await loadSkillVersionArtifact(workingDirectory, runId, leftVersion);
  const right = await loadSkillVersionArtifact(workingDirectory, runId, rightVersion);
  if (!left || !right) {
    return null;
  }

  return {
    leftVersion,
    rightVersion,
    scoreDelta: right.evaluation.overallScore - left.evaluation.overallScore,
    holdoutDelta: right.evaluation.holdoutScore - left.evaluation.holdoutScore,
    budgetDelta: {
      averageLatencyMs: right.evaluation.averageLatencyMs - left.evaluation.averageLatencyMs,
      totalTokensUsed: right.evaluation.totalTokensUsed - left.evaluation.totalTokensUsed,
      estimatedCostUsd: right.evaluation.estimatedCostUsd - left.evaluation.estimatedCostUsd,
    },
    triggerConditions: arrayDiff(left.skill.triggerConditions, right.skill.triggerConditions),
    instructions: arrayDiff(left.skill.instructions, right.skill.instructions),
    constraints: arrayDiff(left.skill.constraints || [], right.skill.constraints || []),
    recurringIssues: arrayDiff(left.failureAnalysis.recurringIssues, right.failureAnalysis.recurringIssues),
    recommendations: arrayDiff(left.failureAnalysis.recommendations, right.failureAnalysis.recommendations),
    pairwiseComparison: right.pairwiseComparison || null,
  };
}

export async function listSkillRunArtifacts(workingDirectory: string, runId: string): Promise<string[]> {
  const report = await loadSkillOptimizationReport(workingDirectory, runId);
  if (!report) {
    return [];
  }

  try {
    const items = await readdir(report.artifactDir);
    return items.sort();
  } catch {
    return [];
  }
}