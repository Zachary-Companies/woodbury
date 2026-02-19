import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────

export interface StateSnapshot {
  timestamp: number;
  toolName: string;
  summary: string;
  artifacts?: string[];
  exitStatus?: number;
}

// ── Ring buffer + disk persistence ───────────────────────────

const MAX_SNAPSHOTS = 30;

function snapshotsPath(workingDirectory: string): string {
  return join(workingDirectory, '.woodbury-work', 'snapshots.json');
}

export class SnapshotBuffer {
  private buffer: StateSnapshot[] = [];
  private readonly workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  push(snapshot: StateSnapshot): void {
    this.buffer.push(snapshot);
    if (this.buffer.length > MAX_SNAPSHOTS) {
      this.buffer = this.buffer.slice(-MAX_SNAPSHOTS);
    }
    // Fire-and-forget persist
    this.persist().catch(() => {});
  }

  getRecent(count = MAX_SNAPSHOTS): StateSnapshot[] {
    return this.buffer.slice(-count);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(snapshotsPath(this.workingDirectory), 'utf-8');
      const parsed = JSON.parse(raw) as StateSnapshot[];
      if (Array.isArray(parsed)) {
        this.buffer = parsed.slice(-MAX_SNAPSHOTS);
      }
    } catch {
      // No file yet — start empty
    }
  }

  private async persist(): Promise<void> {
    const dir = join(this.workingDirectory, '.woodbury-work');
    await mkdir(dir, { recursive: true });
    await writeFile(
      snapshotsPath(this.workingDirectory),
      JSON.stringify(this.buffer, null, 2),
      'utf-8',
    );
  }
}

// ── Snapshot factory ─────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function extractExitStatus(result: string): number | undefined {
  const match = result.match(/exit\s*(?:code|status)\s*[:=]?\s*(\d+)/i);
  if (match) return parseInt(match[1], 10);
  // Also check for tool result patterns like "Exit code: 0"
  const match2 = result.match(/^(\d+)$/m);
  if (match2 && result.length < 20) return parseInt(match2[1], 10);
  return undefined;
}

export function createSnapshot(
  toolName: string,
  params: Record<string, unknown>,
  result: string,
): StateSnapshot {
  const timestamp = Date.now();

  switch (toolName) {
    case 'file_write': {
      const path = String(params.path ?? params.file_path ?? '?');
      return { timestamp, toolName, summary: `Wrote file: ${path}`, artifacts: [path] };
    }
    case 'file_read': {
      const path = String(params.path ?? params.file_path ?? '?');
      return { timestamp, toolName, summary: `Read file: ${path}`, artifacts: [path] };
    }
    case 'shell_execute': {
      const cmd = truncate(String(params.command ?? '?'), 80);
      const exitStatus = extractExitStatus(result);
      return { timestamp, toolName, summary: `Shell: ${cmd}`, exitStatus };
    }
    case 'git': {
      const sub = String(params.subcommand ?? params.command ?? '?');
      return { timestamp, toolName, summary: `Git: ${sub}` };
    }
    case 'grep': {
      const pattern = String(params.pattern ?? '?');
      const path = String(params.path ?? params.directory ?? '.');
      return { timestamp, toolName, summary: `Grep: "${pattern}" in ${path}` };
    }
    case 'file_search': {
      const pattern = String(params.pattern ?? params.query ?? '?');
      const path = String(params.directory ?? params.path ?? '.');
      return { timestamp, toolName, summary: `Search: "${pattern}" in ${path}` };
    }
    case 'list_directory': {
      const path = String(params.path ?? params.directory ?? '.');
      return { timestamp, toolName, summary: `Listed: ${path}` };
    }
    case 'code_execute': {
      const lang = String(params.language ?? 'code');
      return { timestamp, toolName, summary: `Executed ${lang} code` };
    }
    case 'test_runner': {
      const path = String(params.path ?? params.test_path ?? '?');
      return { timestamp, toolName, summary: `Ran tests: ${path}`, artifacts: [path] };
    }
    case 'web_fetch': {
      const url = truncate(String(params.url ?? '?'), 60);
      return { timestamp, toolName, summary: `Fetched: ${url}` };
    }
    case 'web_crawl':
    case 'web_crawl_rendered': {
      const url = truncate(String(params.url ?? '?'), 60);
      return { timestamp, toolName, summary: `Crawled: ${url}` };
    }
    case 'google_search': {
      const query = truncate(String(params.query ?? '?'), 60);
      return { timestamp, toolName, summary: `Searched: "${query}"` };
    }
    case 'database_query': {
      const query = truncate(String(params.query ?? params.sql ?? '?'), 60);
      return { timestamp, toolName, summary: `DB query: ${query}` };
    }
    default: {
      // Generic fallback
      const paramStr = Object.entries(params)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${truncate(String(v ?? ''), 30)}`)
        .join(', ');
      return { timestamp, toolName, summary: `${toolName}(${paramStr})` };
    }
  }
}

// ── Formatter ────────────────────────────────────────────────

export function formatRecentSnapshots(snapshots: StateSnapshot[], count = 15): string {
  const recent = snapshots.slice(-count);
  if (recent.length === 0) return '';

  return recent
    .map((s) => {
      const ts = new Date(s.timestamp).toISOString().slice(11, 19); // HH:MM:SS
      const exit = s.exitStatus != null ? ` [exit=${s.exitStatus}]` : '';
      const arts = s.artifacts?.length ? ` → ${s.artifacts.join(', ')}` : '';
      return `[${ts}] ${s.summary}${exit}${arts}`;
    })
    .join('\n');
}
