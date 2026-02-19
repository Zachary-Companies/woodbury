import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog } from '../src/run-audit.js';

describe('AuditLog', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-audit-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records entries with correct fields', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    log.record('file_read', { path: 'a.ts' }, 'content', 42, false);

    const entries = log.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('file_read');
    expect(entries[0].executionTimeMs).toBe(42);
    expect(entries[0].status).toBe('success');
    expect(entries[0].paramsSummary).toContain('path=a.ts');
  });

  it('records error status', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    log.record('shell_execute', { command: 'fail' }, 'Error: command failed', 100, true);

    const entries = log.getAll();
    expect(entries[0].status).toBe('error');
  });

  it('redactSecrets applied to paramsSummary and resultSummary', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    log.record(
      'shell_execute',
      { command: 'export API_KEY=sk-ant-abcdefghijklmnopqrstuvwx' },
      'set API_KEY=sk-ant-abcdefghijklmnopqrstuvwx done',
      10,
      false,
    );

    const entries = log.getAll();
    expect(entries[0].paramsSummary).toContain('[REDACTED');
    expect(entries[0].resultSummary).toContain('[REDACTED');
  });

  it('caps at 500 entries', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();

    for (let i = 0; i < 510; i++) {
      log.record('file_read', { path: `f${i}.ts` }, `content-${i}`, 1, false);
    }

    expect(log.getAll().length).toBe(500);
  });

  it('newRun generates new runId', () => {
    const log = new AuditLog(tmpDir);
    const run1 = log.newRun();
    const run2 = log.newRun();
    expect(run1).not.toBe(run2);
    expect(run1.length).toBeGreaterThan(0);
  });

  it('getRunEntries filters by runId', () => {
    const log = new AuditLog(tmpDir);
    const run1 = log.newRun();
    log.record('file_read', { path: 'a.ts' }, 'content-a', 10, false);
    log.record('grep', { pattern: 'TODO' }, 'matches', 20, false);

    const run2 = log.newRun();
    log.record('file_write', { path: 'b.ts' }, 'ok', 30, false);

    expect(log.getRunEntries(run1)).toHaveLength(2);
    expect(log.getRunEntries(run2)).toHaveLength(1);
  });

  it('formatRunSummary includes correct tool breakdown', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    log.record('file_read', { path: 'a.ts' }, 'content', 10, false);
    log.record('file_read', { path: 'b.ts' }, 'content', 20, false);
    log.record('grep', { pattern: 'x' }, 'found', 5, false);
    log.record('shell_execute', { command: 'npm test' }, 'Error: fail', 100, true);

    const summary = log.formatRunSummary();
    expect(summary).toContain('4 tool calls');
    expect(summary).toContain('1 error');
    expect(summary).toContain('file_read: 2');
    expect(summary).toContain('grep: 1');
    expect(summary).toContain('shell_execute: 1');
  });

  it('disk persistence: write + reload', async () => {
    const log1 = new AuditLog(tmpDir);
    await log1.load();
    log1.newRun();
    log1.record('file_read', { path: 'test.ts' }, 'ok', 42, false);

    // Wait for fire-and-forget persist
    await new Promise(r => setTimeout(r, 200));

    // Reload from disk
    const log2 = new AuditLog(tmpDir);
    await log2.load();

    const entries = log2.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('file_read');
    expect(entries[0].executionTimeMs).toBe(42);
  });

  it('formatRunSummary handles empty run', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    const summary = log.formatRunSummary();
    expect(summary).toContain('no tool calls recorded');
  });

  it('records taskId when provided', () => {
    const log = new AuditLog(tmpDir);
    log.newRun();
    log.record('file_read', { path: 'a.ts' }, 'ok', 10, false, 42);

    const entries = log.getAll();
    expect(entries[0].taskId).toBe(42);
  });
});
