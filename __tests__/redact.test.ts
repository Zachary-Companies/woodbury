import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  // ── AWS ──

  it('redacts AWS access key IDs', () => {
    const input = 'key=AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(input)).toBe('key=[REDACTED_AWS_KEY]');
  });

  it('redacts aws_secret_access_key assignments', () => {
    const input = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(redactSecrets(input)).toBe('aws_secret_access_key=[REDACTED_AWS_SECRET]');
  });

  it('redacts aws_secret_access_key case-insensitively', () => {
    const input = 'AWS_SECRET_ACCESS_KEY = someSecret123';
    expect(redactSecrets(input)).toBe('aws_secret_access_key=[REDACTED_AWS_SECRET]');
  });

  // ── Anthropic ──

  it('redacts Anthropic API keys', () => {
    const input = 'key=sk-ant-abc123def456ghi789jkl012mno';
    expect(redactSecrets(input)).toBe('key=[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts Anthropic keys before OpenAI pattern matches', () => {
    // sk-ant- should match Anthropic, not OpenAI
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(key)).toBe('[REDACTED_ANTHROPIC_KEY]');
  });

  // ── OpenAI ──

  it('redacts OpenAI API keys', () => {
    const input = 'OPENAI_KEY=sk-abcdefghijklmnopqrstuv';
    // Both the generic env pattern and the OpenAI key pattern should fire
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('does not redact short sk- prefixed strings', () => {
    const input = 'sk-short';
    expect(redactSecrets(input)).toBe('sk-short');
  });

  // ── GitHub ──

  it('redacts GitHub personal access tokens (ghp_)', () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234';
    expect(redactSecrets(token)).toBe('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts GitHub OAuth tokens (gho_)', () => {
    const token = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234';
    expect(redactSecrets(token)).toBe('[REDACTED_GITHUB_TOKEN]');
  });

  // ── Slack ──

  it('redacts Slack bot tokens', () => {
    const input = 'SLACK=xoxb-123456789012-abcdefghij';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('redacts Slack user tokens', () => {
    const input = 'xoxp-123456789-abcde';
    expect(redactSecrets(input)).toBe('[REDACTED_SLACK_TOKEN]');
  });

  // ── Bearer ──

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
    const result = redactSecrets(input);
    expect(result).toContain('Bearer [REDACTED_BEARER_TOKEN]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  // ── Connection strings ──

  it('redacts passwords in connection strings', () => {
    const input = 'postgres://admin:supersecret123@db.example.com:5432/mydb';
    const result = redactSecrets(input);
    expect(result).toContain('://admin:[REDACTED_PASSWORD]@');
    expect(result).not.toContain('supersecret123');
  });

  it('preserves username in connection strings', () => {
    const input = 'mysql://root:mypassword@localhost/db';
    const result = redactSecrets(input);
    expect(result).toContain('root:');
    expect(result).toContain('[REDACTED_PASSWORD]@');
  });

  // ── Generic env assignments ──

  it('redacts API_KEY= assignments', () => {
    const input = 'API_KEY=abc123def456';
    expect(redactSecrets(input)).toBe('API_KEY=[REDACTED]');
  });

  it('redacts SECRET= assignments', () => {
    const input = 'SECRET=mysupersecret';
    expect(redactSecrets(input)).toBe('SECRET=[REDACTED]');
  });

  it('redacts TOKEN= assignments', () => {
    const input = 'TOKEN=some_token_value';
    expect(redactSecrets(input)).toBe('TOKEN=[REDACTED]');
  });

  it('redacts PASSWORD= assignments', () => {
    const input = 'PASSWORD=hunter2';
    expect(redactSecrets(input)).toBe('PASSWORD=[REDACTED]');
  });

  it('redacts PRIVATE_KEY= assignments', () => {
    const input = 'PRIVATE_KEY=-----BEGIN-RSA-----';
    expect(redactSecrets(input)).toBe('PRIVATE_KEY=[REDACTED]');
  });

  // ── Long hex tokens ──

  it('redacts 64+ character hex strings', () => {
    const hex = 'a'.repeat(64);
    expect(redactSecrets(hex)).toBe('[REDACTED_HEX_TOKEN]');
  });

  it('does not redact short hex strings', () => {
    const hex = 'abcdef1234567890'; // 16 chars
    expect(redactSecrets(hex)).toBe(hex);
  });

  // ── Email addresses ──

  it('redacts email addresses', () => {
    const input = 'Contact user@example.com for details';
    expect(redactSecrets(input)).toBe('Contact [REDACTED_EMAIL] for details');
  });

  it('redacts emails with dots and plus signs', () => {
    const input = 'john.doe+test@company.co.uk';
    expect(redactSecrets(input)).toBe('[REDACTED_EMAIL]');
  });

  // ── Edge cases ──

  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns safe text unchanged', () => {
    const safe = 'This is a normal log message with no secrets.';
    expect(redactSecrets(safe)).toBe(safe);
  });

  it('handles multiple secrets in one string', () => {
    const input = 'key=AKIAIOSFODNN7EXAMPLE user@test.com PASSWORD=secret';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).toContain('PASSWORD=[REDACTED]');
  });

  it('is safe to call multiple times (idempotent-ish)', () => {
    const input = 'key=AKIAIOSFODNN7EXAMPLE';
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it('handles repeated calls without regex state leaking', () => {
    // Global regexes have lastIndex state — verify it resets between calls
    const input = 'key=AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(input)).toBe('key=[REDACTED_AWS_KEY]');
    expect(redactSecrets(input)).toBe('key=[REDACTED_AWS_KEY]');
    expect(redactSecrets(input)).toBe('key=[REDACTED_AWS_KEY]');
  });
});
