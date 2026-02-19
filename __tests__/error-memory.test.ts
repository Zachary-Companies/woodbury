import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  looksLikeError,
  recordError,
  loadErrors,
  formatRecentErrors,
} from '../src/error-memory.js';

describe('looksLikeError', () => {
  it('detects "Error:" prefix', () => {
    expect(looksLikeError('Error: file not found')).toBe(true);
  });

  it('detects "failed" keyword', () => {
    expect(looksLikeError('Build failed with 3 errors')).toBe(true);
  });

  it('detects ENOENT', () => {
    expect(looksLikeError('ENOENT: no such file or directory')).toBe(true);
  });

  it('does not flag normal output', () => {
    expect(looksLikeError('File written successfully.')).toBe(false);
  });
});

describe('recordError + loadErrors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-err-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records and loads an error', async () => {
    await recordError(tmpDir, 'shell_execute', { command: 'npm test' }, 'Error: test failed');
    const errors = await loadErrors(tmpDir);
    expect(errors).toHaveLength(1);
    expect(errors[0].toolName).toBe('shell_execute');
    expect(errors[0].errorMessage).toBe('Error: test failed');
    expect(errors[0].id).toBe(1);
  });

  it('increments IDs', async () => {
    await recordError(tmpDir, 'tool1', {}, 'err1');
    await recordError(tmpDir, 'tool2', {}, 'err2');
    const errors = await loadErrors(tmpDir);
    expect(errors[0].id).toBe(1);
    expect(errors[1].id).toBe(2);
  });

  // ── PII redaction ──

  it('redacts secrets from paramsSummary', async () => {
    await recordError(
      tmpDir,
      'shell_execute',
      { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"' },
      'Error: failed',
    );
    const errors = await loadErrors(tmpDir);
    expect(errors[0].paramsSummary).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(errors[0].paramsSummary).toContain('[REDACTED_BEARER_TOKEN]');
  });

  it('redacts secrets from errorMessage', async () => {
    await recordError(
      tmpDir,
      'web_fetch',
      { url: 'https://api.example.com' },
      'Error: Auth failed for user@company.com with TOKEN=abc123def',
    );
    const errors = await loadErrors(tmpDir);
    expect(errors[0].errorMessage).not.toContain('user@company.com');
    expect(errors[0].errorMessage).toContain('[REDACTED_EMAIL]');
    expect(errors[0].errorMessage).toContain('TOKEN=[REDACTED]');
  });

  it('redacts AWS keys from params', async () => {
    await recordError(
      tmpDir,
      'shell_execute',
      { command: 'aws s3 cp --access-key AKIAIOSFODNN7EXAMPLE' },
      'Error: access denied',
    );
    const errors = await loadErrors(tmpDir);
    expect(errors[0].paramsSummary).toContain('[REDACTED_AWS_KEY]');
    expect(errors[0].paramsSummary).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('caps at 50 records', async () => {
    for (let i = 0; i < 55; i++) {
      await recordError(tmpDir, 'tool', {}, `Error ${i}`);
    }
    const errors = await loadErrors(tmpDir);
    expect(errors.length).toBeLessThanOrEqual(50);
    // Newest should be present
    expect(errors[errors.length - 1].errorMessage).toBe('Error 54');
  });

  it('returns empty array for missing file', async () => {
    const errors = await loadErrors(tmpDir);
    expect(errors).toEqual([]);
  });
});

describe('formatRecentErrors', () => {
  it('returns empty string for empty array', () => {
    expect(formatRecentErrors([])).toBe('');
  });

  it('formats errors with timestamps', () => {
    const errors = [
      {
        id: 1,
        timestamp: new Date('2025-01-15').getTime(),
        toolName: 'shell_execute',
        paramsSummary: 'command=npm test',
        errorMessage: 'Tests failed',
      },
    ];
    const result = formatRecentErrors(errors);
    expect(result).toContain('2025-01-15');
    expect(result).toContain('shell_execute');
    expect(result).toContain('Tests failed');
  });

  it('limits to requested count', () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      timestamp: Date.now(),
      toolName: 'tool',
      paramsSummary: '',
      errorMessage: `Error ${i}`,
    }));
    const result = formatRecentErrors(errors, 3);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });
});
