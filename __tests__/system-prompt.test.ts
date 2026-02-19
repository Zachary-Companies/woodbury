import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSystemPrompt } from '../src/system-prompt.js';

describe('buildSystemPrompt', () => {
  let tmpDir: string;
  let prompt: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-sysprompt-'));
    prompt = await buildSystemPrompt(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Core sections ──

  it('includes identity', () => {
    expect(prompt).toContain('You are woodbury');
  });

  it('includes environment with working directory', () => {
    expect(prompt).toContain('## Environment');
    expect(prompt).toContain(tmpDir);
  });

  it('includes Behavior section', () => {
    expect(prompt).toContain('## Behavior');
    expect(prompt).toContain('Be concise');
  });

  // ── New sections (Feature 4: PII Policy) ──

  it('includes Secrets & PII Policy section', () => {
    expect(prompt).toContain('## Secrets & PII Policy');
    expect(prompt).toContain('NEVER write secrets');
    expect(prompt).toContain('auto-redacted from disk logs');
    expect(prompt).toContain('environment variable references');
  });

  // ── New sections (Feature 3: Dry-Run) ──

  it('includes Dry-Run Best Practices section', () => {
    expect(prompt).toContain('## Dry-Run Best Practices');
    expect(prompt).toContain('--dry-run');
    expect(prompt).toContain('preflight_check');
    expect(prompt).toContain('dry_run: true');
    expect(prompt).toContain('terraform plan');
  });

  // ── Updated Risk Gate (Features 2+3) ──

  it('includes Risk Gate section', () => {
    expect(prompt).toContain('## Risk Gate');
    expect(prompt).toContain('preflight_check');
  });

  it('documents risk levels and approval behavior', () => {
    expect(prompt).toContain('### Risk Levels & Approval');
    expect(prompt).toContain('low/medium');
    expect(prompt).toContain('high');
    expect(prompt).toContain('critical');
    expect(prompt).toContain('REQUIRES USER APPROVAL');
    expect(prompt).toContain('DO NOT execute until the user confirms');
  });

  it('documents dry-run mode in Risk Gate', () => {
    expect(prompt).toContain('### Dry-Run Mode');
    expect(prompt).toContain('dry_run: true');
    expect(prompt).toContain('without approving execution');
  });

  // ── New section (Feature 1: Tool Call Budgets) ──

  it('includes Tool Call Budgets section', () => {
    expect(prompt).toContain('### Tool Call Budgets');
    expect(prompt).toContain('default: 50');
    expect(prompt).toContain('toolCallBudget');
    expect(prompt).toContain('auto-blocked');
  });

  it('mentions meta tools are exempt from budget', () => {
    expect(prompt).toContain('Meta tools');
    expect(prompt).toContain('do NOT count against the budget');
  });

  // ── Section ordering ──

  it('places Secrets & PII Policy before Risk Gate', () => {
    const secretsIdx = prompt.indexOf('## Secrets & PII Policy');
    const riskIdx = prompt.indexOf('## Risk Gate');
    expect(secretsIdx).toBeGreaterThan(-1);
    expect(riskIdx).toBeGreaterThan(-1);
    expect(secretsIdx).toBeLessThan(riskIdx);
  });

  it('places Behavior before Secrets & PII Policy', () => {
    const behaviorIdx = prompt.indexOf('## Behavior');
    const secretsIdx = prompt.indexOf('## Secrets & PII Policy');
    expect(behaviorIdx).toBeLessThan(secretsIdx);
  });

  it('places Dry-Run Best Practices before Risk Gate', () => {
    const dryRunIdx = prompt.indexOf('## Dry-Run Best Practices');
    const riskIdx = prompt.indexOf('## Risk Gate');
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(dryRunIdx).toBeLessThan(riskIdx);
  });

  it('places Tool Call Budgets inside Task Planning', () => {
    const taskPlanIdx = prompt.indexOf('## Task Planning');
    const budgetIdx = prompt.indexOf('### Tool Call Budgets');
    expect(budgetIdx).toBeGreaterThan(taskPlanIdx);
  });

  // ── Existing sections still present ──

  it('includes Task Planning section', () => {
    expect(prompt).toContain('## Task Planning');
  });

  it('includes Memory section', () => {
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('memory_save');
    expect(prompt).toContain('memory_recall');
  });

  it('includes Reflection section', () => {
    expect(prompt).toContain('## Reflection');
    expect(prompt).toContain('reflect');
  });

  it('includes Error Memory section', () => {
    expect(prompt).toContain('## Error Memory');
  });

  it('includes Work Queue section', () => {
    expect(prompt).toContain('## Work Queue');
  });

  it('includes Delegation section', () => {
    expect(prompt).toContain('## Delegation');
  });

  it('includes Goal Contract section', () => {
    expect(prompt).toContain('## Goal Contract');
  });

  it('includes Testing section', () => {
    expect(prompt).toContain('## Testing');
  });

  it('includes Deliverable Packaging section', () => {
    expect(prompt).toContain('## Deliverable Packaging');
  });

  // ── New feature mentions ──

  it('mentions audit log', () => {
    expect(prompt).toContain('audit');
    expect(prompt).toContain('audit.json');
    expect(prompt).toContain('/audit');
  });

  it('mentions git checkpoints', () => {
    expect(prompt).toContain('checkpoint');
    expect(prompt).toContain('/checkpoints');
  });

  it('mentions plan.json persistence', () => {
    expect(prompt).toContain('plan.json');
    expect(prompt).toContain('persist');
  });

  it('mentions semantic memory', () => {
    expect(prompt).toContain('--semantic-memory');
    expect(prompt).toContain('fuzzy matching');
  });
});
