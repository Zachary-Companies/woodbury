import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';

// ── Types ────────────────────────────────────────────────────

export interface ErrorRecord {
  id: number;
  timestamp: number;
  toolName: string;
  paramsSummary: string;
  errorMessage: string;
  taskId?: number;
}

// ── Detection ────────────────────────────────────────────────

const ERROR_PATTERNS = [
  /^Error:/i,
  /⛔/,
  /\bfailed\b/i,
  /\bCannot\b/,
  /ENOENT/,
  /Permission denied/,
];

/**
 * Heuristic: check the first 500 chars of a tool result for error indicators.
 */
export function looksLikeError(result: string): boolean {
  const sample = result.slice(0, 500);
  return ERROR_PATTERNS.some((p) => p.test(sample));
}

// ── Disk I/O ─────────────────────────────────────────────────

const MAX_RECORDS = 50;

function errorsFilePath(workingDirectory: string): string {
  return join(workingDirectory, '.woodbury-work', 'errors.json');
}

export async function loadErrors(workingDirectory: string): Promise<ErrorRecord[]> {
  try {
    const raw = await readFile(errorsFilePath(workingDirectory), 'utf-8');
    return JSON.parse(raw) as ErrorRecord[];
  } catch {
    return [];
  }
}

async function saveErrors(workingDirectory: string, errors: ErrorRecord[]): Promise<void> {
  const dir = join(workingDirectory, '.woodbury-work');
  await mkdir(dir, { recursive: true });
  await writeFile(errorsFilePath(workingDirectory), JSON.stringify(errors, null, 2), 'utf-8');
}

// ── Recording ────────────────────────────────────────────────

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

export async function recordError(
  workingDirectory: string,
  toolName: string,
  params: Record<string, unknown>,
  errorMessage: string,
  taskId?: number,
): Promise<void> {
  const errors = await loadErrors(workingDirectory);

  const paramsSummary = Object.entries(params)
    .map(([k, v]) => `${k}=${truncateStr(String(v ?? ''), 80)}`)
    .join(', ');

  const nextId = errors.length > 0 ? Math.max(...errors.map((e) => e.id)) + 1 : 1;

  errors.push({
    id: nextId,
    timestamp: Date.now(),
    toolName,
    paramsSummary: redactSecrets(truncateStr(paramsSummary, 200)),
    errorMessage: redactSecrets(truncateStr(errorMessage, 1000)),
    taskId,
  });

  // Cap at MAX_RECORDS, keeping most recent
  if (errors.length > MAX_RECORDS) {
    errors.splice(0, errors.length - MAX_RECORDS);
  }

  await saveErrors(workingDirectory, errors);
}

// ── Formatting ───────────────────────────────────────────────

export function formatRecentErrors(errors: ErrorRecord[], count = 5): string {
  const recent = errors.slice(-count);
  if (recent.length === 0) return '';

  return recent
    .map((e) => {
      const ts = new Date(e.timestamp).toISOString().split('T')[0];
      const taskRef = e.taskId != null ? ` (task #${e.taskId})` : '';
      return `[${ts}] ${e.toolName}${taskRef}: ${e.errorMessage}`;
    })
    .join('\n');
}
