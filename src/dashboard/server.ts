/**
 * Dashboard Server
 *
 * Creates the HTTP server, wires up all route handlers,
 * and manages lifecycle services (scheduler, inference, bridge, relay).
 *
 * This replaces the monolithic startDashboard() function that was
 * previously in src/config-dashboard.ts.
 */

import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { ExtensionManager } from '../extension-manager.js';
import { debugLog } from '../debug-log.js';
import { ensureBridgeServer } from '../bridge-server.js';
import { startRemoteRelay, type RelayHandle } from '../remote-relay.js';
import {
  startInferenceServer as startNodeInference,
  stopInferenceServer as stopNodeInference,
  type InferenceServer,
} from '../inference/index.js';
import * as socialStorage from '../social/storage.js';

import type { DashboardContext, DashboardHandle } from './types.js';
import { createDashboardContext } from './context.js';
import { handleCors, serveStaticFiles, logApiRequest } from './middleware.js';
import { routeRequest } from './routes/index.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const MODELS_DIR = join(homedir(), '.woodbury', 'data', 'models');
const INFERENCE_PORT = 8679;

// ────────────────────────────────────────────────────────────────
//  Env Loading
// ────────────────────────────────────────────────────────────────

/** Load API keys from ~/.woodbury/.env into process.env */
function loadDotEnv(): void {
  try {
    const { readFileSync, existsSync } = require('node:fs');
    const envPath = join(homedir(), '.woodbury', '.env');
    if (!existsSync(envPath)) return;

    const content = readFileSync(envPath, 'utf-8') as string;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key] && value) {
          process.env[key] = value;
        }
      }
    }
  } catch { /* ignore */ }
}

// ────────────────────────────────────────────────────────────────
//  Scheduler
// ────────────────────────────────────────────────────────────────

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return false;
    return value % step === 0;
  }
  const segments = field.split(',');
  for (const seg of segments) {
    if (seg.includes('-')) {
      const [lo, hi] = seg.split('-').map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      if (parseInt(seg, 10) === value) return true;
    }
  }
  return false;
}

function cronMatchesDate(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  for (let i = 0; i < 5; i++) {
    if (!cronFieldMatches(parts[i], fields[i])) return false;
  }
  return true;
}

const SCHEDULES_DIR = join(homedir(), '.woodbury', 'data');
const SCHEDULES_FILE = join(SCHEDULES_DIR, 'schedules.json');
let _schedulesCache: any[] | null = null;

async function loadSchedules(): Promise<any[]> {
  if (_schedulesCache !== null) return _schedulesCache;
  try {
    await mkdir(SCHEDULES_DIR, { recursive: true });
    const content = await readFile(SCHEDULES_FILE, 'utf-8');
    _schedulesCache = JSON.parse(content);
    return _schedulesCache!;
  } catch {
    _schedulesCache = [];
    return _schedulesCache;
  }
}

async function saveSchedules(schedules: any[]): Promise<void> {
  _schedulesCache = schedules;
  await mkdir(SCHEDULES_DIR, { recursive: true });
  await writeFile(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

async function schedulerTick(ctx: DashboardContext): Promise<void> {
  try {
    const schedules = await loadSchedules();
    const now = new Date();

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      if (!cronMatchesDate(schedule.cron, now)) continue;

      // Prevent double-fire
      if (schedule.lastRunAt) {
        const lastRun = new Date(schedule.lastRunAt);
        if (
          lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getMinutes() === now.getMinutes()
        ) {
          continue;
        }
      }

      // Skip if busy
      if (ctx.activeCompRun || ctx.activeBatchRun) {
        debugLog.info('scheduler', `Skipping schedule "${schedule.id}" — another run is active`);
        continue;
      }

      debugLog.info('scheduler', `Triggering schedule "${schedule.id}"`);

      try {
        const addr = ctx.server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const body = JSON.stringify({ variables: schedule.variables || {} });
        const runRes = await fetch(
          `http://127.0.0.1:${port}/api/compositions/${encodeURIComponent(schedule.compositionId)}/run`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        );
        const runData = await runRes.json() as { success?: boolean; runId?: string; error?: string };

        schedule.lastRunAt = now.toISOString();
        if (runData.runId) schedule.lastRunId = runData.runId;
        await saveSchedules(schedules);
      } catch (err) {
        debugLog.info('scheduler', `Schedule trigger failed: ${String(err)}`);
      }
    }
  } catch (err) {
    debugLog.info('scheduler', `Scheduler tick error: ${String(err)}`);
  }

  // Social scheduler tick
  try {
    const duePosts = await socialStorage.getDuePosts();
    if (duePosts.length > 0) {
      debugLog.info('scheduler', `Found ${duePosts.length} due social post(s)`);
      for (const post of duePosts) {
        try {
          await socialStorage.updatePost(post.id, { status: 'posting' as const });
        } catch (err) {
          debugLog.info('scheduler', `Failed to mark social post: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    debugLog.info('scheduler', `Social scheduler tick error: ${String(err)}`);
  }
}

// ────────────────────────────────────────────────────────────────
//  Inference Server Lifecycle
// ────────────────────────────────────────────────────────────────

async function startInferenceServer(ctx: DashboardContext): Promise<void> {
  if (ctx.inferenceServer) return;

  try {
    mkdirSync(MODELS_DIR, { recursive: true });
    const entries = await readdir(MODELS_DIR);
    let bestModel: string | null = null;
    let bestTime = 0;

    for (const entry of entries) {
      const dir = join(MODELS_DIR, entry);
      const onnxPath = join(dir, 'encoder.onnx');
      try {
        const s = await stat(onnxPath);
        if (s.isFile() && s.mtimeMs > bestTime) {
          bestTime = s.mtimeMs;
          bestModel = onnxPath;
        }
      } catch { /* no onnx */ }
    }

    if (bestModel) {
      ctx.inferenceModelPath = bestModel;
      debugLog.info('inference', `Starting inference with model: ${bestModel}`);
    }

    ctx.inferenceServer = await startNodeInference(INFERENCE_PORT, bestModel ?? undefined);
    debugLog.info('inference', `Inference server running on port ${INFERENCE_PORT}`);
  } catch (err) {
    debugLog.info('inference', `Failed to start inference: ${String(err)}`);
    ctx.inferenceServer = null;
  }
}

function stopInferenceServer(ctx: DashboardContext): void {
  if (ctx.inferenceServer) {
    stopNodeInference(ctx.inferenceServer);
    ctx.inferenceServer = null;
    ctx.inferenceModelPath = null;
  }
}

// ────────────────────────────────────────────────────────────────
//  Main Entry Point
// ────────────────────────────────────────────────────────────────

export async function startDashboard(
  verbose: boolean = false,
  extensionManager?: ExtensionManager,
  workingDirectory?: string,
  preferredPort: number = 9001,
): Promise<DashboardHandle> {
  // Load .env keys
  loadDotEnv();

  const staticDir = join(__dirname, '..', 'config-dashboard');
  const workDir = workingDirectory || process.cwd();

  // Create the HTTP server
  const server: Server = createServer(async (req, res) => {
    // CORS preflight
    if (handleCors(req, res)) return;

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Log API requests
    logApiRequest(req, pathname);

    // Try API routes
    if (await routeRequest(req, res, pathname, url, ctx)) return;

    // Fall through to static file serving
    await serveStaticFiles(req, res, pathname, staticDir);
  });

  // Create the shared context
  const ctx = createDashboardContext({
    verbose,
    extensionManager,
    workDir,
    staticDir,
    server,
  });

  // ── Start lifecycle services ──────────────────────────────

  // Scheduler (runs every 60s)
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  function startScheduler(): void {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => { schedulerTick(ctx); }, 60_000);
    debugLog.info('scheduler', 'Scheduler started (60s interval)');
  }
  function stopScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }
  startScheduler();

  // Inference server (background, non-blocking)
  startInferenceServer(ctx);

  // Bridge server (background, non-blocking)
  ensureBridgeServer().catch(() => {});

  // ── Listen on port ────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (verbose) console.log(`[dashboard] Port ${preferredPort} in use, using random port`);
        server.listen(0, '127.0.0.1', resolve);
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });

  const addr = server.address();
  const assignedPort = typeof addr === 'object' && addr ? addr.port : 0;
  const dashboardUrl = `http://127.0.0.1:${assignedPort}`;

  // Persist dashboard URL for worker auto-discovery
  try {
    const dataDir = join(homedir(), '.woodbury', 'data');
    mkdirSync(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'dashboard.json'),
      JSON.stringify({ url: dashboardUrl, port: assignedPort, pid: process.pid }, null, 2),
    );
  } catch { /* non-critical */ }

  if (verbose) {
    console.log(`[dashboard] Config dashboard at ${dashboardUrl}`);
  }

  // Remote relay (Firebase RTDB)
  let relayHandle: RelayHandle | null = null;
  try {
    relayHandle = await startRemoteRelay(assignedPort, verbose);
    debugLog.info('relay', 'Remote relay started', { connectionUrl: relayHandle.connectionUrl });
  } catch (err) {
    debugLog.info('relay', `Remote relay failed: ${String(err)}`);
  }

  // ── Return handle ─────────────────────────────────────────

  return {
    url: dashboardUrl,
    port: assignedPort,
    connectionUrl: relayHandle?.connectionUrl,
    pair: relayHandle ? (code: string) => relayHandle!.pair(code) : undefined,
    isPaired: relayHandle ? () => relayHandle!.isPaired() : undefined,
    close: async () => {
      relayHandle?.stop();
      stopScheduler();
      stopInferenceServer(ctx);

      if (ctx.chatAgent) {
        await ctx.chatAgent.stop().catch(() => {});
        ctx.chatAgent = null;
      }

      for (const agent of ctx.chatAgents.values()) {
        await agent.stop().catch(() => {});
      }
      ctx.chatAgents.clear();

      if (ctx.chatMcpManager) {
        await ctx.chatMcpManager.disconnectAll().catch(() => {});
        ctx.chatMcpManager = null;
      }

      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
