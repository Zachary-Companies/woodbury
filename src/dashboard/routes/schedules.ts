/**
 * Dashboard Route: Schedules
 *
 * Handles /api/schedules endpoints.
 * Provides CRUD operations for composition pipeline schedules (cron-based).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import type { Schedule } from '../../workflow/types.js';
import { debugLog } from '../../debug-log.js';

// ── Constants ────────────────────────────────────────────────
const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const SCHEDULES_FILE = join(RUNS_DIR, 'schedules.json');
let schedulesCache: Schedule[] | null = null;

// ── Local helpers ────────────────────────────────────────────

async function loadSchedules(): Promise<Schedule[]> {
  if (schedulesCache !== null) return schedulesCache;
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const content = await readFile(SCHEDULES_FILE, 'utf-8');
    schedulesCache = JSON.parse(content) as Schedule[];
    return schedulesCache;
  } catch {
    schedulesCache = [];
    return schedulesCache;
  }
}

async function saveSchedules(schedules: Schedule[]): Promise<void> {
  schedulesCache = schedules;
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

function generateScheduleId(): string {
  return 'sched-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

// ── Route handler ────────────────────────────────────────────

export const handleSchedulesRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // GET /api/schedules — list all schedules
  if (req.method === 'GET' && pathname === '/api/schedules') {
    try {
      const schedules = await loadSchedules();
      sendJson(res, 200, { schedules });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/schedules — create a new schedule
  if (req.method === 'POST' && pathname === '/api/schedules') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body) as Partial<Schedule>;

      if (!data.compositionId || !data.cron) {
        sendJson(res, 400, { error: 'compositionId and cron are required' });
        return true;
      }

      // Validate cron format (5 fields)
      const cronParts = data.cron.trim().split(/\s+/);
      if (cronParts.length !== 5) {
        sendJson(res, 400, { error: 'Invalid cron expression — must have 5 fields: minute hour dom month dow' });
        return true;
      }

      // Verify composition exists
      const compDir = join(homedir(), '.woodbury', 'compositions');
      const compFile = join(compDir, data.compositionId + '.json');
      let compName = data.compositionName || 'Unknown';
      try {
        const compContent = await readFile(compFile, 'utf-8');
        const comp = JSON.parse(compContent);
        compName = comp.name || compName;
      } catch {
        sendJson(res, 404, { error: `Composition "${data.compositionId}" not found` });
        return true;
      }

      const schedule: Schedule = {
        id: generateScheduleId(),
        compositionId: data.compositionId,
        compositionName: compName,
        cron: data.cron.trim(),
        enabled: data.enabled !== false,
        variables: data.variables || {},
        description: data.description || '',
        createdAt: new Date().toISOString(),
      };

      const schedules = await loadSchedules();
      schedules.push(schedule);
      await saveSchedules(schedules);

      debugLog.info('scheduler', `Created schedule "${schedule.id}" for "${compName}"`);
      sendJson(res, 201, { schedule });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET/PUT/DELETE /api/schedules/:id
  const scheduleDetailMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleDetailMatch) {
    const scheduleId = decodeURIComponent(scheduleDetailMatch[1]);
    const schedules = await loadSchedules();
    const idx = schedules.findIndex(s => s.id === scheduleId);

    if (req.method === 'GET') {
      if (idx < 0) {
        sendJson(res, 404, { error: `Schedule "${scheduleId}" not found` });
        return true;
      }
      sendJson(res, 200, { schedule: schedules[idx] });
      return true;
    }

    if (req.method === 'PUT') {
      if (idx < 0) {
        sendJson(res, 404, { error: `Schedule "${scheduleId}" not found` });
        return true;
      }
      try {
        const body = await readBody(req);
        const updates = JSON.parse(body) as Partial<Schedule>;

        // Apply allowed updates
        if (updates.cron !== undefined) {
          const cronParts = updates.cron.trim().split(/\s+/);
          if (cronParts.length !== 5) {
            sendJson(res, 400, { error: 'Invalid cron expression — must have 5 fields' });
            return true;
          }
          schedules[idx].cron = updates.cron.trim();
        }
        if (updates.enabled !== undefined) schedules[idx].enabled = updates.enabled;
        if (updates.variables !== undefined) schedules[idx].variables = updates.variables;
        if (updates.description !== undefined) schedules[idx].description = updates.description;

        await saveSchedules(schedules);
        debugLog.info('scheduler', `Updated schedule "${scheduleId}"`);
        sendJson(res, 200, { schedule: schedules[idx] });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }

    if (req.method === 'DELETE') {
      if (idx < 0) {
        sendJson(res, 404, { error: `Schedule "${scheduleId}" not found` });
        return true;
      }
      schedules.splice(idx, 1);
      await saveSchedules(schedules);
      debugLog.info('scheduler', `Deleted schedule "${scheduleId}"`);
      sendJson(res, 200, { success: true });
      return true;
    }
  }

  return false;
};
