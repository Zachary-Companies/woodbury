// ── PII / Secrets Redaction ───────────────────────────────────
// Stateless regex-based scrubbing applied before disk persistence.

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const RULES: RedactionRule[] = [
  // AWS access key IDs (AKIA...)
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // AWS secret access keys in env assignments
  { pattern: /aws_secret_access_key\s*=\s*\S+/gi, replacement: 'aws_secret_access_key=[REDACTED_AWS_SECRET]' },

  // Anthropic keys (sk-ant-...)
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },
  // OpenAI keys (sk-...) — checked AFTER Anthropic to avoid false overlap
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_OPENAI_KEY]' },

  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },

  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-)
  { pattern: /\bxox[bpas]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },

  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9_.~+/=-]{20,}\b/g, replacement: 'Bearer [REDACTED_BEARER_TOKEN]' },

  // Connection string passwords: ://user:PASSWORD@host
  { pattern: /:\/\/([^:]+):([^@]{4,})@/g, replacement: '://$1:[REDACTED_PASSWORD]@' },

  // Generic env assignments: API_KEY=, SECRET=, TOKEN=, PASSWORD=
  { pattern: /\b(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY)\s*=\s*\S+/gi, replacement: '$1=[REDACTED]' },

  // Long hex strings (64+ chars) — likely tokens or hashes
  { pattern: /\b[0-9a-fA-F]{64,}\b/g, replacement: '[REDACTED_HEX_TOKEN]' },

  // Email addresses (PII)
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
];

/**
 * Scrub secrets and PII from a string before persisting to disk.
 * Each pattern maps to a labeled replacement so redaction is visible.
 */
export function redactSecrets(input: string): string {
  let result = input;
  for (const rule of RULES) {
    // Reset lastIndex for global regexes reused across calls
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}
