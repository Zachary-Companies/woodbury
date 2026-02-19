import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRiskGateTools, loadRiskLog } from '../src/risk-gate.js';

describe('risk-gate', () => {
  let tmpDir: string;
  const context = () => ({ workingDirectory: tmpDir });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-risk-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records a low-risk check', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Delete temp files', risk_level: 'low', justification: 'Cleanup' },
      context(),
    );
    expect(result).toContain('Preflight check #1 recorded');
    expect(result).toContain('LOW');
    expect(result).toContain('Proceed normally');
  });

  it('records a medium-risk check', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Update prod config', risk_level: 'medium', justification: 'Needed for deploy' },
      context(),
    );
    expect(result).toContain('MEDIUM');
    expect(result).toContain('Proceed with care');
  });

  it('records a high-risk check', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Drop staging table', risk_level: 'high', justification: 'Schema migration' },
      context(),
    );
    expect(result).toContain('HIGH');
    expect(result).toContain('CAUTION');
  });

  // ── Approval gate ──

  it('blocks critical-risk actions with approval requirement', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Delete the entire dist directory permanently', risk_level: 'critical', justification: 'Full rebuild' },
      context(),
    );
    expect(result).toContain('CRITICAL');
    expect(result).toContain('REQUIRES USER APPROVAL');
    expect(result).toContain('REQUIRES user approval');
    expect(result).toContain('DO NOT execute');
    expect(result).toContain('<final_answer>');
  });

  it('sets requiresApproval=true for critical level in persisted log', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Delete production DB', risk_level: 'critical', justification: 'Migration' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log).toHaveLength(1);
    expect(log[0].requiresApproval).toBe(true);
    expect(log[0].dryRun).toBe(false);
  });

  it('sets requiresApproval=false for non-critical levels', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Remove old logs', risk_level: 'low', justification: 'Cleanup' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log[0].requiresApproval).toBe(false);
  });

  // ── Dry-run ──

  it('records dry_run mode and adds dry-run message', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Force push to main', risk_level: 'high', justification: 'Test', dry_run: true },
      context(),
    );
    expect(result).toContain('DRY RUN');
    expect(result).toContain('NOT approved for execution');

    const log = await loadRiskLog(tmpDir);
    expect(log[0].dryRun).toBe(true);
  });

  it('accepts dry_run as string "true"', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Test', risk_level: 'low', justification: 'Test', dry_run: 'true' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log[0].dryRun).toBe(true);
  });

  it('defaults dry_run to false when not provided', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Test', risk_level: 'low', justification: 'Test' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log[0].dryRun).toBe(false);
  });

  it('critical + dry_run shows both approval and dry-run messages', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Drop all tables', risk_level: 'critical', justification: 'Test', dry_run: true },
      context(),
    );
    expect(result).toContain('REQUIRES user approval');
    expect(result).toContain('DRY RUN');
  });

  // ── PII redaction ──

  it('redacts secrets in action before persisting', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Using key sk-ant-abcdefghijklmnopqrstuvwxyz123', risk_level: 'low', justification: 'Config update' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log[0].action).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz123');
    expect(log[0].action).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts secrets in justification before persisting', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler(
      { action: 'Update config', risk_level: 'low', justification: 'User user@company.com requested this' },
      context(),
    );
    const log = await loadRiskLog(tmpDir);
    expect(log[0].justification).not.toContain('user@company.com');
    expect(log[0].justification).toContain('[REDACTED_EMAIL]');
  });

  // ── Validation ──

  it('rejects missing action', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: '', risk_level: 'low', justification: 'Test' },
      context(),
    );
    expect(result).toContain('Error');
  });

  it('rejects missing justification', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Test', risk_level: 'low', justification: '' },
      context(),
    );
    expect(result).toContain('Error');
  });

  it('rejects invalid risk level', async () => {
    const { preflightHandler } = createRiskGateTools();
    const result = await preflightHandler(
      { action: 'Test', risk_level: 'extreme', justification: 'Test' },
      context(),
    );
    expect(result).toContain('Error');
    expect(result).toContain('Invalid risk_level');
  });

  // ── ID sequencing ──

  it('increments check IDs', async () => {
    const { preflightHandler } = createRiskGateTools();
    await preflightHandler({ action: 'A', risk_level: 'low', justification: 'A' }, context());
    await preflightHandler({ action: 'B', risk_level: 'low', justification: 'B' }, context());
    const log = await loadRiskLog(tmpDir);
    expect(log).toHaveLength(2);
    expect(log[0].id).toBe(1);
    expect(log[1].id).toBe(2);
  });
});
