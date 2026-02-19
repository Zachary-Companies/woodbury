import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SnapshotBuffer,
  createSnapshot,
  formatRecentSnapshots,
  type StateSnapshot,
} from '../src/state-snapshot.js';

describe('createSnapshot', () => {
  it('creates file_write snapshot with artifacts', () => {
    const snap = createSnapshot('file_write', { path: 'src/foo.ts' }, '');
    expect(snap.toolName).toBe('file_write');
    expect(snap.summary).toBe('Wrote file: src/foo.ts');
    expect(snap.artifacts).toEqual(['src/foo.ts']);
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('creates file_read snapshot', () => {
    const snap = createSnapshot('file_read', { file_path: 'README.md' }, '');
    expect(snap.summary).toBe('Read file: README.md');
    expect(snap.artifacts).toEqual(['README.md']);
  });

  it('creates shell_execute snapshot with exit status', () => {
    const snap = createSnapshot('shell_execute', { command: 'npm test' }, 'exit code: 0');
    expect(snap.summary).toBe('Shell: npm test');
    expect(snap.exitStatus).toBe(0);
  });

  it('creates shell_execute snapshot without exit status', () => {
    const snap = createSnapshot('shell_execute', { command: 'echo hello' }, 'hello');
    expect(snap.summary).toBe('Shell: echo hello');
    expect(snap.exitStatus).toBeUndefined();
  });

  it('truncates long shell commands', () => {
    const longCmd = 'x'.repeat(200);
    const snap = createSnapshot('shell_execute', { command: longCmd }, '');
    expect(snap.summary.length).toBeLessThan(200);
    expect(snap.summary).toContain('...');
  });

  it('creates git snapshot', () => {
    const snap = createSnapshot('git', { subcommand: 'status' }, '');
    expect(snap.summary).toBe('Git: status');
  });

  it('creates grep snapshot', () => {
    const snap = createSnapshot('grep', { pattern: 'TODO', path: 'src/' }, '');
    expect(snap.summary).toBe('Grep: "TODO" in src/');
  });

  it('creates file_search snapshot', () => {
    const snap = createSnapshot('file_search', { pattern: '*.ts', directory: 'src/' }, '');
    expect(snap.summary).toBe('Search: "*.ts" in src/');
  });

  it('creates list_directory snapshot', () => {
    const snap = createSnapshot('list_directory', { path: '/home' }, '');
    expect(snap.summary).toBe('Listed: /home');
  });

  it('creates code_execute snapshot', () => {
    const snap = createSnapshot('code_execute', { language: 'python' }, '');
    expect(snap.summary).toBe('Executed python code');
  });

  it('creates test_runner snapshot with artifacts', () => {
    const snap = createSnapshot('test_runner', { path: 'test/foo.test.ts' }, '');
    expect(snap.summary).toBe('Ran tests: test/foo.test.ts');
    expect(snap.artifacts).toEqual(['test/foo.test.ts']);
  });

  it('creates web_fetch snapshot', () => {
    const snap = createSnapshot('web_fetch', { url: 'https://example.com' }, '');
    expect(snap.summary).toBe('Fetched: https://example.com');
  });

  it('creates web_crawl snapshot', () => {
    const snap = createSnapshot('web_crawl', { url: 'https://docs.example.com' }, '');
    expect(snap.summary).toBe('Crawled: https://docs.example.com');
  });

  it('creates web_crawl_rendered snapshot', () => {
    const snap = createSnapshot('web_crawl_rendered', { url: 'https://spa.example.com' }, '');
    expect(snap.summary).toBe('Crawled: https://spa.example.com');
  });

  it('creates google_search snapshot', () => {
    const snap = createSnapshot('google_search', { query: 'vitest setup' }, '');
    expect(snap.summary).toBe('Searched: "vitest setup"');
  });

  it('creates database_query snapshot', () => {
    const snap = createSnapshot('database_query', { query: 'SELECT * FROM users' }, '');
    expect(snap.summary).toBe('DB query: SELECT * FROM users');
  });

  it('creates generic fallback for unknown tools', () => {
    const snap = createSnapshot('custom_tool', { foo: 'bar', baz: 42 }, '');
    expect(snap.summary).toBe('custom_tool(foo=bar, baz=42)');
  });

  it('handles missing params gracefully', () => {
    const snap = createSnapshot('file_write', {}, '');
    expect(snap.summary).toBe('Wrote file: ?');
  });
});

describe('formatRecentSnapshots', () => {
  it('returns empty string for empty array', () => {
    expect(formatRecentSnapshots([])).toBe('');
  });

  it('formats snapshots with timestamps', () => {
    const snapshots: StateSnapshot[] = [
      { timestamp: new Date('2025-01-15T10:30:00Z').getTime(), toolName: 'file_read', summary: 'Read file: foo.ts' },
    ];
    const result = formatRecentSnapshots(snapshots);
    expect(result).toContain('[10:30:00]');
    expect(result).toContain('Read file: foo.ts');
  });

  it('includes exit status when present', () => {
    const snapshots: StateSnapshot[] = [
      { timestamp: Date.now(), toolName: 'shell_execute', summary: 'Shell: npm test', exitStatus: 1 },
    ];
    const result = formatRecentSnapshots(snapshots);
    expect(result).toContain('[exit=1]');
  });

  it('includes artifacts when present', () => {
    const snapshots: StateSnapshot[] = [
      { timestamp: Date.now(), toolName: 'file_write', summary: 'Wrote file: src/a.ts', artifacts: ['src/a.ts'] },
    ];
    const result = formatRecentSnapshots(snapshots);
    expect(result).toContain('→ src/a.ts');
  });

  it('limits to requested count', () => {
    const snapshots: StateSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() + i,
      toolName: 'file_read',
      summary: `Read file: file${i}.ts`,
    }));
    const result = formatRecentSnapshots(snapshots, 3);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    // Should be the LAST 3
    expect(result).toContain('file7.ts');
    expect(result).toContain('file8.ts');
    expect(result).toContain('file9.ts');
    expect(result).not.toContain('file0.ts');
  });
});

describe('SnapshotBuffer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'woodbury-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('starts with empty buffer', () => {
    const buf = new SnapshotBuffer(tmpDir);
    expect(buf.getRecent()).toEqual([]);
  });

  it('stores pushed snapshots', () => {
    const buf = new SnapshotBuffer(tmpDir);
    const snap: StateSnapshot = { timestamp: Date.now(), toolName: 'file_read', summary: 'test' };
    buf.push(snap);
    expect(buf.getRecent()).toHaveLength(1);
    expect(buf.getRecent()[0].summary).toBe('test');
  });

  it('limits buffer to 30 entries', () => {
    const buf = new SnapshotBuffer(tmpDir);
    for (let i = 0; i < 40; i++) {
      buf.push({ timestamp: Date.now(), toolName: 'file_read', summary: `snap${i}` });
    }
    const recent = buf.getRecent();
    expect(recent).toHaveLength(30);
    // Should keep the last 30 (10–39)
    expect(recent[0].summary).toBe('snap10');
    expect(recent[29].summary).toBe('snap39');
  });

  it('getRecent with count returns limited results', () => {
    const buf = new SnapshotBuffer(tmpDir);
    for (let i = 0; i < 10; i++) {
      buf.push({ timestamp: Date.now(), toolName: 'file_read', summary: `snap${i}` });
    }
    const recent = buf.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].summary).toBe('snap7');
  });

  it('persists to disk and can be loaded', async () => {
    const buf1 = new SnapshotBuffer(tmpDir);
    buf1.push({ timestamp: 1000, toolName: 'file_read', summary: 'persisted' });

    // Wait for fire-and-forget persist
    await new Promise(r => setTimeout(r, 200));

    // Verify file exists
    const filePath = join(tmpDir, '.woodbury-work', 'snapshots.json');
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toHaveLength(1);
    expect(data[0].summary).toBe('persisted');

    // Load into new buffer
    const buf2 = new SnapshotBuffer(tmpDir);
    await buf2.load();
    expect(buf2.getRecent()).toHaveLength(1);
    expect(buf2.getRecent()[0].summary).toBe('persisted');
  });

  it('load handles missing file gracefully', async () => {
    const buf = new SnapshotBuffer(tmpDir);
    await buf.load(); // Should not throw
    expect(buf.getRecent()).toEqual([]);
  });
});
