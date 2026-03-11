/**
 * Dashboard Route: Workers
 *
 * Handles /api/workers and /api/worker endpoints.
 * Manages remote training workers (list, add, remove) and
 * local training worker lifecycle (start, stop, status, logs, settings).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';

// ── Constants ────────────────────────────────────────────────
const WORKERS_FILE = join(homedir(), '.woodbury', 'data', 'workers.json');
const WORKER_CONFIG_FILE = join(homedir(), '.woodbury', 'worker-config.json');

// ── Types ────────────────────────────────────────────────────

interface WorkerSettings {
  autoStart: boolean;
  port: number;
  wooburyModelsPath: string | null;
}

const DEFAULT_WORKER_SETTINGS: WorkerSettings = {
  autoStart: false,
  port: 8677,
  wooburyModelsPath: null,
};

interface WorkerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  addedAt: string;
}

// ── Local helpers ────────────────────────────────────────────

async function loadWorkerSettings(): Promise<WorkerSettings> {
  try {
    const content = await readFile(WORKER_CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_WORKER_SETTINGS, ...JSON.parse(content) };
  } catch { return { ...DEFAULT_WORKER_SETTINGS }; }
}

async function saveWorkerSettings(settings: WorkerSettings) {
  await mkdir(join(homedir(), '.woodbury'), { recursive: true });
  await writeFile(WORKER_CONFIG_FILE, JSON.stringify(settings, null, 2));
}

async function loadWorkers(): Promise<WorkerConfig[]> {
  try {
    const content = await readFile(WORKERS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch { return []; }
}

async function saveWorkers(workers: WorkerConfig[]) {
  await mkdir(join(homedir(), '.woodbury', 'data'), { recursive: true });
  await writeFile(WORKERS_FILE, JSON.stringify(workers, null, 2));
}

function probeWorker(host: string, port: number, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: host, port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Resolve the cwd for spawning Python woobury_models commands.
 * Returns null if pip-installed (no cwd needed), otherwise returns the path.
 */
async function resolveModelsCwd(ctx: DashboardContext): Promise<string | null> {
  if (ctx.resolvedModelsCwd !== undefined) return ctx.resolvedModelsCwd;

  const settings = await loadWorkerSettings();

  // 1. Use explicit configured path if set
  if (settings.wooburyModelsPath) {
    ctx.resolvedModelsCwd = settings.wooburyModelsPath;
    return ctx.resolvedModelsCwd;
  }

  // 2. Check if pip-installed (no cwd needed)
  try {
    const { execSync } = require('child_process');
    execSync('python -c "import woobury_models"', { timeout: 5000, stdio: 'pipe' });
    ctx.resolvedModelsCwd = null; // pip-installed, no cwd needed
    return ctx.resolvedModelsCwd;
  } catch {}

  // Also try python3
  try {
    const { execSync } = require('child_process');
    execSync('python3 -c "import woobury_models"', { timeout: 5000, stdio: 'pipe' });
    ctx.resolvedModelsCwd = null;
    return ctx.resolvedModelsCwd;
  } catch {}

  // 3. Fall back to conventional dev path
  const devPath = join(homedir(), 'Documents', 'GitHub', 'woobury-models');
  ctx.resolvedModelsCwd = devPath;
  return ctx.resolvedModelsCwd;
}

/** Resolve the python command name (python vs python3) */
async function resolvePythonCmd(ctx: DashboardContext): Promise<string> {
  if (ctx.pythonCmd) return ctx.pythonCmd;
  try {
    const { execSync } = require('child_process');
    execSync('python --version', { timeout: 5000, stdio: 'pipe' });
    ctx.pythonCmd = 'python';
    return ctx.pythonCmd;
  } catch {}
  try {
    const { execSync } = require('child_process');
    execSync('python3 --version', { timeout: 5000, stdio: 'pipe' });
    ctx.pythonCmd = 'python3';
    return ctx.pythonCmd;
  } catch {}
  ctx.pythonCmd = 'python'; // default, will fail with clear error
  return ctx.pythonCmd;
}

async function checkPythonEnvironment(ctx: DashboardContext, forceRefresh = false) {
  if (ctx.pythonCheckCache && !forceRefresh && (Date.now() - ctx.pythonCheckCache.checkedAt) < 60000) {
    return ctx.pythonCheckCache;
  }

  const { execSync } = require('child_process');
  const result = {
    pythonAvailable: false,
    pythonVersion: null as string | null,
    pythonCmd: 'python',
    wooburyModelsInstalled: false,
    gpuAvailable: false,
    gpuName: null as string | null,
    checkedAt: Date.now(),
  };

  // Check Python
  for (const cmd of ['python', 'python3']) {
    try {
      const ver = execSync(`${cmd} --version`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
      result.pythonAvailable = true;
      result.pythonVersion = ver.replace('Python ', '');
      result.pythonCmd = cmd;
      break;
    } catch {}
  }

  if (!result.pythonAvailable) {
    ctx.pythonCheckCache = result;
    return result;
  }

  // Check woobury-models
  const cwd = await resolveModelsCwd(ctx);
  const spawnOpts: any = { timeout: 10000, stdio: 'pipe' };
  if (cwd) spawnOpts.cwd = cwd;

  try {
    execSync(`${result.pythonCmd} -c "import woobury_models; print('ok')"`, spawnOpts);
    result.wooburyModelsInstalled = true;
  } catch {}

  // Check GPU
  try {
    const gpuCheck = execSync(
      `${result.pythonCmd} -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"`,
      spawnOpts
    ).toString().trim().split('\n');
    result.gpuAvailable = gpuCheck[0] === 'True';
    result.gpuName = gpuCheck[1] || null;
  } catch {
    // Also check for MPS (Apple Silicon)
    try {
      const mpsCheck = execSync(
        `${result.pythonCmd} -c "import torch; print(torch.backends.mps.is_available())"`,
        spawnOpts
      ).toString().trim();
      if (mpsCheck === 'True') {
        result.gpuAvailable = true;
        result.gpuName = 'Apple Silicon (MPS)';
      }
    } catch {}
  }

  ctx.pythonCheckCache = result;
  return result;
}

async function startLocalWorker(ctx: DashboardContext): Promise<{ success: boolean; error?: string }> {
  if (ctx.localWorker) {
    return { success: true }; // Already running
  }

  const env = await checkPythonEnvironment(ctx);
  if (!env.pythonAvailable) {
    return { success: false, error: 'Python is not installed or not in PATH' };
  }
  if (!env.wooburyModelsInstalled) {
    return { success: false, error: 'woobury-models is not installed. Run: pip install git+https://github.com/Zachary-Companies/woobury-models.git' };
  }

  const settings = await loadWorkerSettings();
  const port = settings.port || 8677;
  const pythonCmd = env.pythonCmd;
  const cwd = await resolveModelsCwd(ctx);

  const spawnOpts: any = {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (cwd) spawnOpts.cwd = cwd;

  const proc = spawn(pythonCmd, ['-m', 'woobury_models.worker', '--port', String(port)], spawnOpts);

  const logs: string[] = [];
  const maxLogs = 200;

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (logs.length < maxLogs) logs.push(line);
      else { logs.shift(); logs.push(line); }
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (logs.length < maxLogs) logs.push(`[stderr] ${line}`);
      else { logs.shift(); logs.push(`[stderr] ${line}`); }
    }
  });

  proc.on('close', (code) => {
    if (ctx.localWorker?.process === proc) {
      logs.push(`Worker exited with code ${code}`);
      ctx.localWorker = null;
    }
  });

  proc.on('error', (err) => {
    logs.push(`Worker error: ${err.message}`);
    if (ctx.localWorker?.process === proc) {
      ctx.localWorker = null;
    }
  });

  ctx.localWorker = { process: proc, port, logs, startedAt: Date.now() };

  // Wait a moment for the worker to start, then verify
  await new Promise(r => setTimeout(r, 2000));

  if (!ctx.localWorker) {
    return { success: false, error: 'Worker process exited immediately. Check logs.' };
  }

  // Try to probe health
  try {
    await probeWorker('127.0.0.1', port);
  } catch {
    // Give it one more second
    await new Promise(r => setTimeout(r, 2000));
    try {
      await probeWorker('127.0.0.1', port);
    } catch {
      // Worker might still be starting up — don't fail, just warn
      logs.push('Warning: Worker started but health check not yet responding');
    }
  }

  if (ctx.verbose) console.log(`[dashboard] Local worker started on port ${port}`);
  return { success: true };
}

async function stopLocalWorker(ctx: DashboardContext): Promise<{ success: boolean }> {
  if (!ctx.localWorker) return { success: true };

  const proc = ctx.localWorker.process;
  ctx.localWorker.logs.push('Stopping worker...');

  // Try graceful shutdown first
  proc.kill('SIGTERM');

  // Wait up to 5 seconds for graceful exit
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);

    proc.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  ctx.localWorker = null;
  if (ctx.verbose) console.log('[dashboard] Local worker stopped');
  return { success: true };
}

// ── Route Handler ────────────────────────────────────────────

export const handleWorkersRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {

  // ── Remote Worker Management ─────────────────────────────

  // GET /api/workers — list workers with live health
  if (req.method === 'GET' && pathname === '/api/workers') {
    try {
      const workers = await loadWorkers();
      const results = await Promise.all(workers.map(async (w) => {
        try {
          const health = await probeWorker(w.host, w.port);
          return { ...w, online: true, ...health };
        } catch {
          return { ...w, online: false, gpu: null, gpu_memory_gb: null, cuda_available: false, busy: false };
        }
      }));
      sendJson(res, 200, { workers: results });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/workers — add a worker
  if (req.method === 'POST' && pathname === '/api/workers') {
    try {
      const body = await readBody(req);
      const { name, host, port } = body || {};
      if (!name || !host || !port) {
        sendJson(res, 400, { error: 'name, host, and port are required' });
        return true;
      }
      // Validate connectivity
      try {
        await probeWorker(host, port);
      } catch {
        sendJson(res, 400, { error: `Cannot reach worker at ${host}:${port}` });
        return true;
      }
      const workers = await loadWorkers();
      // Deduplicate: if a worker with the same host:port exists, update it
      const existing = workers.find(w => w.host === host && w.port === port);
      if (existing) {
        existing.name = name;
        await saveWorkers(workers);
        sendJson(res, 200, { worker: existing, exists: true });
        return true;
      }
      const worker: WorkerConfig = {
        id: `w-${Date.now()}`,
        name,
        host,
        port,
        addedAt: new Date().toISOString(),
      };
      workers.push(worker);
      await saveWorkers(workers);
      sendJson(res, 200, { worker });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/workers/:id — remove a worker
  if (req.method === 'DELETE' && pathname.startsWith('/api/workers/')) {
    try {
      const workerId = pathname.split('/api/workers/')[1];
      const workers = await loadWorkers();
      const filtered = workers.filter(w => w.id !== workerId);
      if (filtered.length === workers.length) {
        sendJson(res, 404, { error: 'Worker not found' });
        return true;
      }
      await saveWorkers(filtered);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // ── Local Worker Management ─────────────────────────────

  // GET /api/worker/python-check — check Python/woobury-models/GPU availability
  if (req.method === 'GET' && pathname === '/api/worker/python-check') {
    try {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const result = await checkPythonEnvironment(ctx, forceRefresh);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/worker/start — start local training worker
  if (req.method === 'POST' && pathname === '/api/worker/start') {
    try {
      const result = await startLocalWorker(ctx);
      if (result.success) {
        sendJson(res, 200, { success: true, port: ctx.localWorker?.port });
      } else {
        sendJson(res, 400, { success: false, error: result.error });
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/worker/stop — stop local training worker
  if (req.method === 'POST' && pathname === '/api/worker/stop') {
    try {
      await stopLocalWorker(ctx);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/worker/status — get local worker status + job progress
  if (req.method === 'GET' && pathname === '/api/worker/status') {
    try {
      if (!ctx.localWorker) {
        sendJson(res, 200, { running: false });
        return true;
      }

      const status: any = {
        running: true,
        port: ctx.localWorker.port,
        uptime: Date.now() - ctx.localWorker.startedAt,
        startedAt: ctx.localWorker.startedAt,
      };

      // Probe the worker for health + job status
      try {
        const health = await probeWorker('127.0.0.1', ctx.localWorker.port);
        status.health = health;
        status.online = true;
      } catch {
        status.online = false;
      }

      // If the worker has an active job, get its progress
      if (status.online) {
        try {
          const jobStatus: any = await new Promise((resolve, reject) => {
            const req = httpRequest({
              hostname: '127.0.0.1',
              port: ctx.localWorker!.port,
              path: '/jobs/current',
              method: 'GET',
              timeout: 3000,
            }, (res) => {
              let body = '';
              res.on('data', (chunk: string) => body += chunk);
              res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
          });
          if (jobStatus && jobStatus.phase) {
            status.job = jobStatus;
          }
        } catch {
          // No active job
        }
      }

      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/worker/logs — get worker subprocess logs
  if (req.method === 'GET' && pathname === '/api/worker/logs') {
    try {
      const lines = parseInt(url.searchParams.get('lines') || '50');
      const logs = ctx.localWorker ? ctx.localWorker.logs.slice(-lines) : [];
      sendJson(res, 200, { logs, running: !!ctx.localWorker });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/worker/settings — get worker settings
  if (req.method === 'GET' && pathname === '/api/worker/settings') {
    try {
      const settings = await loadWorkerSettings();
      sendJson(res, 200, settings);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // PUT /api/worker/settings — update worker settings
  if (req.method === 'PUT' && pathname === '/api/worker/settings') {
    try {
      const body = await readBody(req);
      const current = await loadWorkerSettings();
      const updated: WorkerSettings = {
        autoStart: body?.autoStart ?? current.autoStart,
        port: body?.port ?? current.port,
        wooburyModelsPath: body?.wooburyModelsPath !== undefined ? body.wooburyModelsPath : current.wooburyModelsPath,
      };
      await saveWorkerSettings(updated);
      // Reset resolved path cache if path changed
      if (body?.wooburyModelsPath !== undefined) {
        ctx.resolvedModelsCwd = undefined;
      }
      sendJson(res, 200, { success: true, settings: updated });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
