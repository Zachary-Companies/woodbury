import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillPolicyStore } from '../loop/v3/skill-policy-store';

describe('SkillPolicyStore', () => {
  it('persists suggested updates to a separate reviewable file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'woodbury-skill-policies-'));
    const filePath = join(tempDir, 'skill-policies.json');
    const store = new SkillPolicyStore(filePath);

    const saved = store.persistSuggestedUpdates([
      {
        kind: 'skill_update',
        skillName: 'workflow_or_pipeline_build',
        updateType: 'recovery_hint',
        applicabilityPattern: 'pipeline|workflow',
        guidance: 'Stay within composition tools unless the user explicitly escalates.',
        confidence: 0.82,
      },
    ]);

    expect(saved).toHaveLength(1);
    expect(saved[0].reviewStatus).toBe('suggested');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw[0].skillName).toBe('workflow_or_pipeline_build');
    expect(raw[0].guidance).toContain('composition tools');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates review status and saves edited guidance', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'woodbury-skill-policies-'));
    const filePath = join(tempDir, 'skill-policies.json');
    const store = new SkillPolicyStore(filePath);

    const saved = store.persistSuggestedUpdates([
      {
        kind: 'skill_update',
        skillName: 'repo_explore',
        updateType: 'applicability',
        applicabilityPattern: 'inspect|trace',
        guidance: 'Use repo_explore for inspection work.',
        confidence: 0.7,
      },
    ]);

    const approved = store.updateReviewStatus(saved[0].id, 'approved');
    expect(approved?.reviewStatus).toBe('approved');

    store.replace({
      ...approved!,
      guidance: 'Use repo_explore for inspection and trace-driven tasks.',
    });

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw[0].reviewStatus).toBe('approved');
    expect(raw[0].guidance).toContain('trace-driven');

    rmSync(tempDir, { recursive: true, force: true });
  });
});