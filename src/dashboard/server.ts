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
import { decayMemories, consolidateMemories } from '../file-memory-store.js';

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

// Single source of truth for schedules — shared with the API route handlers.
// Both the scheduler tick and the CRUD endpoints use the same in-memory cache.
import { loadSchedules, saveSchedules } from './routes/schedules.js';

export const SCHEDULE_MAX_RETRIES = 3;
export const SCHEDULE_RETRY_DELAY_MS = 5 * 60_000;

/** The bits of a composition run the retry decision depends on. */
export interface ScheduledRunState {
  done?: boolean;
  success?: boolean;
  compositionId?: string;
  /** Undefined for runs that were not started by the scheduler. */
  _scheduledRetries?: number;
  /** Epoch ms when the run was observed finished; 0 while still running. */
  doneAt?: number;
}

/**
 * Should the scheduler retry the last failed scheduled run?
 *
 * Only scheduler-started runs are eligible (`_scheduledRetries` is set when the
 * scheduler fires one). The caller MUST consume the attempt on the failed run
 * before dispatching — if the retry request comes back without a runId the same
 * run object is still active, and an un-incremented counter would keep this
 * returning true on every tick, hammering the endpoint forever.
 */
export function shouldRetryScheduledRun(
  run: ScheduledRunState | null | undefined,
  nowMs: number,
  maxRetries: number = SCHEDULE_MAX_RETRIES,
  retryDelayMs: number = SCHEDULE_RETRY_DELAY_MS,
): boolean {
  if (!run) return false;
  if (!run.done || run.success) return false;
  if (run._scheduledRetries === undefined) return false;
  if (run._scheduledRetries >= maxRetries) return false;
  return nowMs - (run.doneAt || 0) >= retryDelayMs;
}

async function schedulerTick(ctx: DashboardContext): Promise<void> {
  try {
    // Use the in-memory cache as source of truth — saveSchedules() updates both
    // cache and disk. Only re-read from disk on first load (cache is null).
    const schedules = await loadSchedules();
    const now = new Date();

    // Track when a run finishes so we can compute retry delays
    if (ctx.activeCompRun && ctx.activeCompRun.done && !(ctx.activeCompRun as any).doneAt) {
      (ctx.activeCompRun as any).doneAt = now.getTime();
    }

    // Check if the last scheduled run failed — if so, retry it before
    // processing any new cron matches. This handles both explicit failures
    // and silent failures (e.g. API errors, crashes).
    const activeRun = ctx.activeCompRun as any;
    {
      const MAX_RETRIES = SCHEDULE_MAX_RETRIES;

      if (shouldRetryScheduledRun(activeRun, now.getTime())) {
        const retrySchedule = schedules.find(s => s.compositionId === activeRun.compositionId && s.enabled);
        if (retrySchedule) {
          const retryNum = activeRun._scheduledRetries + 1;
          debugLog.info('scheduler', `Retrying failed schedule "${retrySchedule.id}" (attempt ${retryNum}/${MAX_RETRIES})`);
          // Consume the attempt on the FAILED run before firing. If the run
          // request errors or comes back without a runId, activeCompRun is still
          // this same object — leaving the counter at its old value would keep
          // this branch satisfied and re-POST on every 30s tick forever.
          activeRun._scheduledRetries = retryNum;
          activeRun.doneAt = now.getTime();
          try {
            const addr = ctx.server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            const runRes = await fetch(
              `http://127.0.0.1:${port}/api/compositions/${encodeURIComponent(retrySchedule.compositionId)}/run`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variables: retrySchedule.variables || {} }) },
            );
            const runData = await runRes.json() as any;
            if (runData.runId && ctx.activeCompRun) {
              // Carry the retry count onto the new run so it can retry in turn
              (ctx.activeCompRun as any)._scheduledRetries = retryNum;
              (ctx.activeCompRun as any).doneAt = 0;
              retrySchedule.lastRunId = runData.runId;
            } else {
              debugLog.info('scheduler', `Retry for "${retrySchedule.id}" did not start a run: ${JSON.stringify(runData)}`);
              (retrySchedule as any).lastError = runData?.error || 'retry did not start a run';
            }
            retrySchedule.lastRunAt = now.toISOString();
            await saveSchedules(schedules);
          } catch (err) {
            debugLog.info('scheduler', `Retry trigger failed: ${String(err)}`);
            (retrySchedule as any).lastError = String(err);
            await saveSchedules(schedules);
          }
          // Don't process more schedules this tick
          return;
        }
      }
    }

    for (const schedule of schedules) {
      if (!schedule.enabled) {
        continue;
      }

      const cronMatch = cronMatchesDate(schedule.cron, now);
      if (!cronMatch) continue;

      // Prevent double-fire: skip if we already ran in this exact minute
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

      // Skip if a composition or batch run is currently in progress
      if ((ctx.activeCompRun && !ctx.activeCompRun.done) || (ctx.activeBatchRun && !ctx.activeBatchRun.done)) {
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
        // Track retry count on the active run so failed scheduled runs can be retried
        if (ctx.activeCompRun) {
          (ctx.activeCompRun as any)._scheduledRetries = 0;
          (ctx.activeCompRun as any).doneAt = 0;
        }
        await saveSchedules(schedules);

        // Only run one schedule per tick
        break;
      } catch (err) {
        debugLog.info('scheduler', `Schedule trigger failed: ${String(err)}`);
        // Record failure so it shows up in the schedule's status
        schedule.lastRunAt = now.toISOString();
        (schedule as any).lastError = String(err);
        await saveSchedules(schedules);
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
//  LLM Proxy Lifecycle
// ────────────────────────────────────────────────────────────────

const LLM_PROXY_PORT = 8642;

export function startLlmProxy(ctx: DashboardContext): void {
  if (ctx.llmProxy) return;

  // Check if proxy is enabled via env
  const proxyEnabled = process.env.LLM_PROXY_ENABLED !== 'false';
  if (!proxyEnabled) {
    debugLog.info('llm-proxy', 'LLM proxy disabled (LLM_PROXY_ENABLED=false)');
    return;
  }

  // Find the proxy binary — check pipeline tools directories
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const { existsSync } = require('node:fs') as typeof import('node:fs');

  const searchPaths = [
    join(__dirname, '..', '..', 'tools', 'llm-proxy', 'woodbury-llm-proxy'),
    join(__dirname, '..', 'tools', 'llm-proxy', 'woodbury-llm-proxy'),
    join(homedir(), '.woodbury', 'bin', 'woodbury-llm-proxy'),
  ];

  let binaryPath: string | null = null;
  for (const p of searchPaths) {
    if (existsSync(p)) {
      binaryPath = p;
      break;
    }
  }

  if (!binaryPath) {
    debugLog.info('llm-proxy', 'LLM proxy binary not found, skipping. Searched: ' + searchPaths.join(', '));
    return;
  }

  const logs: string[] = [];
  const port = parseInt(process.env.LLM_PROXY_PORT || '') || LLM_PROXY_PORT;

  try {
    const proc = spawn(binaryPath, ['--port', String(port)], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logs.push(line);
        if (logs.length > 200) logs.shift();
        debugLog.info('llm-proxy', line);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logs.push('[stderr] ' + line);
        if (logs.length > 200) logs.shift();
        debugLog.info('llm-proxy', line);
      }
    });

    proc.on('close', (code: number | null) => {
      debugLog.info('llm-proxy', `LLM proxy exited with code ${code}`);
      if (ctx.llmProxy?.process === proc) {
        ctx.llmProxy = null;
      }
    });

    proc.on('error', (err: Error) => {
      debugLog.error('llm-proxy', `LLM proxy error: ${err.message}`);
      if (ctx.llmProxy?.process === proc) {
        ctx.llmProxy = null;
      }
    });

    ctx.llmProxy = { process: proc, port, logs };
    debugLog.info('llm-proxy', `LLM proxy started on port ${port} (binary: ${binaryPath})`);

    // Auto-set LLM_BASE_URL if not already set
    if (!process.env.LLM_BASE_URL) {
      process.env.LLM_BASE_URL = `http://localhost:${port}`;
      debugLog.info('llm-proxy', `Set LLM_BASE_URL=http://localhost:${port}`);
    }
  } catch (err: any) {
    debugLog.error('llm-proxy', `Failed to start LLM proxy: ${err.message}`);
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
    schedulerTimer = setInterval(() => { schedulerTick(ctx); }, 30_000);
    debugLog.info('scheduler', 'Scheduler started (30s interval)');
  }
  function stopScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }
  startScheduler();

  // Memory maintenance (decay + consolidation, runs every 6 hours)
  const MEMORY_MAINTENANCE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  async function runMemoryMaintenance(): Promise<void> {
    try {
      const decay = await decayMemories();
      const consolidation = await consolidateMemories();
      if (decay.decayed > 0 || decay.pruned > 0 || consolidation.consolidated > 0) {
        debugLog.info('memory', `Maintenance: ${decay.decayed} decayed, ${decay.pruned} pruned, ${consolidation.consolidated} consolidated`);
      }
    } catch (err) {
      debugLog.error('memory', `Maintenance failed: ${err}`);
    }
  }
  // Run once on startup (after a short delay to not block boot)
  setTimeout(runMemoryMaintenance, 10_000);
  const memoryTimer = setInterval(runMemoryMaintenance, MEMORY_MAINTENANCE_INTERVAL);

  // Inference server (background, non-blocking)
  startInferenceServer(ctx);

  // LLM Proxy (background, non-blocking)
  startLlmProxy(ctx);

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
      clearInterval(memoryTimer);
      stopInferenceServer(ctx);

      // Stop LLM proxy
      if (ctx.llmProxy) {
        try {
          ctx.llmProxy.process.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { try { ctx.llmProxy?.process.kill('SIGKILL'); } catch {} resolve(); }, 3000);
            ctx.llmProxy?.process.once('close', () => { clearTimeout(timeout); resolve(); });
          });
        } catch {}
        ctx.llmProxy = null;
      }

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

      // Flush all project data to disk before shutdown
      await ctx.projectState.flushAll().catch(() => {});

      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
