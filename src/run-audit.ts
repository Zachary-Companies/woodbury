import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';

// ── Types ────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  timestamp: number;
  runId: string;
  toolName: string;
  paramsSummary: string;
  resultSummary: string;
  executionTimeMs: number;
  status: 'success' | 'error';
  taskId?: number;
}

// ── Helpers ──────────────────────────────────────────────

const MAX_ENTRIES = 500;

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function summarizeParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params).slice(0, 4);
  return entries
    .map(([k, v]) => `${k}=${truncateStr(String(v ?? ''), 80)}`)
    .join(', ');
}

// ── AuditLog class ──────────────────────────────────────

export class AuditLog {
  private entries: AuditEntry[] = [];
  private currentRunId = '';
  private nextId = 1;
  private readonly workingDirectory: string;
  private persistPromise: Promise<void> | null = null;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  private filePath(): string {
    return join(this.workingDirectory, '.woodbury-work', 'audit.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath(), 'utf-8');
      this.entries = JSON.parse(raw) as AuditEntry[];
      if (this.entries.length > 0) {
        this.nextId = Math.max(...this.entries.map(e => e.id)) + 1;
      }
    } catch {
      this.entries = [];
    }
  }

  newRun(): string {
    this.currentRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.currentRunId;
  }

  getRunId(): string {
    return this.currentRunId;
  }

  record(
    toolName: string,
    params: Record<string, unknown>,
    result: string,
    executionTimeMs: number,
    isError: boolean,
    taskId?: number,
  ): void {
    const entry: AuditEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      runId: this.currentRunId,
      toolName,
      paramsSummary: redactSecrets(truncateStr(summarizeParams(params), 300)),
      resultSummary: redactSecrets(truncateStr(result, 500)),
      executionTimeMs,
      status: isError ? 'error' : 'success',
      taskId,
    };

    this.entries.push(entry);

    // Cap at MAX_ENTRIES, keeping most recent
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    // Fire-and-forget persist
    this.persistPromise = this.persist().catch(() => {});
  }

  private async persist(): Promise<void> {
    const dir = join(this.workingDirectory, '.woodbury-work');
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath(), JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  getRunEntries(runId?: string): AuditEntry[] {
    const targetRunId = runId ?? this.currentRunId;
    return this.entries.filter(e => e.runId === targetRunId);
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }

  formatRunSummary(runId?: string): string {
    const targetRunId = runId ?? this.currentRunId;
    const runEntries = this.entries.filter(e => e.runId === targetRunId);

    if (runEntries.length === 0) {
      return `Run ${targetRunId || '(none)'}: no tool calls recorded.`;
    }

    const totalMs = runEntries.reduce((acc, e) => acc + e.executionTimeMs, 0);
    const errorCount = runEntries.filter(e => e.status === 'error').length;

    // Tool breakdown
    const toolCounts = new Map<string, number>();
    for (const e of runEntries) {
      toolCounts.set(e.toolName, (toolCounts.get(e.toolName) ?? 0) + 1);
    }
    const breakdown = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `  ${name}: ${count}`)
      .join('\n');

    const lines = [
      `Run ${targetRunId}: ${runEntries.length} tool call${runEntries.length === 1 ? '' : 's'}, ${(totalMs / 1000).toFixed(1)}s total, ${errorCount} error${errorCount === 1 ? '' : 's'}`,
      ``,
      `Tool breakdown:`,
      breakdown,
    ];

    return lines.join('\n');
  }
}
