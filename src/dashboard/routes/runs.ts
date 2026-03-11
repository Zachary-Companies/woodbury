/**
 * Dashboard Route: Runs
 *
 * Handles /api/runs endpoints.
 * Provides run history listing, detail, and deletion.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson } from '../utils.js';
import type { RunRecord } from '../../workflow/types.js';

// ── Constants ────────────────────────────────────────────────
const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 500;
let runsCache: RunRecord[] | null = null;

// ── Local helpers ────────────────────────────────────────────

async function loadRuns(): Promise<RunRecord[]> {
  if (runsCache !== null) return runsCache;
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const content = await readFile(RUNS_FILE, 'utf-8');
    runsCache = JSON.parse(content) as RunRecord[];
  } catch {
    runsCache = [];
  }
  return runsCache;
}

async function saveRuns(runs: RunRecord[]): Promise<void> {
  if (runs.length > MAX_RUNS) {
    runs = runs.slice(runs.length - MAX_RUNS);
  }
  runsCache = runs;
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(RUNS_FILE, JSON.stringify(runs, null, 2));
}

async function deleteRunRecord(id: string): Promise<boolean> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.id === id);
  if (idx < 0) return false;
  runs.splice(idx, 1);
  await saveRuns(runs);
  return true;
}

// ── Route handler ────────────────────────────────────────────

export const handleRunsRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // GET /api/runs — list runs with optional filters
  if (req.method === 'GET' && pathname === '/api/runs') {
    try {
      const runs = await loadRuns();
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const statusFilter = url.searchParams.get('status');
      const typeFilter = url.searchParams.get('type');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      let filtered = [...runs].reverse(); // newest first
      if (statusFilter) filtered = filtered.filter(r => r.status === statusFilter);
      if (typeFilter) filtered = filtered.filter(r => r.type === typeFilter);

      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
      sendJson(res, 200, { runs: page, total, limit, offset });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/runs — clear all run history
  if (req.method === 'DELETE' && pathname === '/api/runs') {
    try {
      await saveRuns([]);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET/DELETE /api/runs/:id — single run detail or delete
  const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runDetailMatch) {
    const runId = decodeURIComponent(runDetailMatch[1]);
    if (req.method === 'GET') {
      try {
        const runs = await loadRuns();
        const found = runs.find(r => r.id === runId);
        if (!found) {
          sendJson(res, 404, { error: `Run "${runId}" not found` });
          return true;
        }
        sendJson(res, 200, { run: found });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    } else if (req.method === 'DELETE') {
      try {
        const deleted = await deleteRunRecord(runId);
        if (!deleted) {
          sendJson(res, 404, { error: `Run "${runId}" not found` });
          return true;
        }
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  return false;
};
