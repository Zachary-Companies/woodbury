/**
 * Config Dashboard
 *
 * Built-in web dashboard for managing extension API keys.
 * Runs locally on 127.0.0.1 with auto-assigned port.
 *
 * Routes:
 *   GET  /                         -> index.html
 *   GET  /*.html|js|css            -> static files
 *   GET  /api/extensions           -> list all extensions with env status
 *   GET  /api/extensions/:name/env -> env var status for one extension
 *   PUT  /api/extensions/:name/env -> update env vars for one extension
 */

import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import {
  discoverExtensions,
  parseEnvFile,
  writeEnvFile,
  type ExtensionManifest,
} from './extension-loader.js';
import type { ExtensionManager } from './extension-manager.js';
import { debugLog } from './debug-log.js';
import {
  discoverWorkflows,
  discoverCompositions,
  loadWorkflow,
  type DiscoveredWorkflow,
} from './workflow/loader.js';
import type { WorkflowDocument, Expectation, RunRecord, NodeRunResult, PendingApproval, ApprovalGateConfig, BatchConfig, VariablePool, Schedule } from './workflow/types.js';
import { checkExpectations } from './workflow/executor.js';
import { WorkflowRecorder } from './workflow/recorder.js';
import { bridgeServer, ensureBridgeServer } from './bridge-server.js';
import { startRemoteRelay, type RelayHandle } from './remote-relay.js';
import { appendFileSync, mkdirSync, createReadStream, createWriteStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

// Shared recording log
const _REC_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const _REC_LOG_PATH = join(_REC_LOG_DIR, 'recording.log');
function dashRecLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(_REC_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [DASH:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(_REC_LOG_PATH, line + '\n');
  } catch { /* never break dashboard */ }
}

// ────────────────────────────────────────────────────────────────
//  Output variable inference
// ────────────────────────────────────────────────────────────────

/**
 * Scan workflow steps to find variables produced during execution.
 * Looks for set_variable, capture_download, and other output-producing step types.
 */
function inferOutputVariables(wf: WorkflowDocument): string[] {
  const outputs = new Set<string>();

  function scan(steps: any[]) {
    for (const s of steps) {
      if (s.type === 'capture_download' && s.outputVariable) {
        outputs.add(s.outputVariable);
      }
      if (s.type === 'set_variable' && s.variable) {
        outputs.add(s.variable);
      }
      // Recurse into nested step arrays
      for (const k of ['steps', 'trySteps', 'catchSteps', 'thenSteps', 'elseSteps']) {
        if (Array.isArray((s as any)[k])) scan((s as any)[k]);
      }
    }
  }

  scan(wf.steps || []);
  return Array.from(outputs);
}

// ────────────────────────────────────────────────────────────────
//  Public types
// ────────────────────────────────────────────────────────────────

export interface DashboardHandle {
  url: string;
  port: number;
  connectionUrl?: string;
  /** Pair with a remote user via their 4-digit code */
  pair?: (code: string) => Promise<boolean>;
  /** Whether a remote user is already paired */
  isPaired?: () => boolean;
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Mask an API key value: show first 4 and last 4 chars, rest asterisked */
export function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
}

/** Validate env var name: alphanumeric + underscore, starts with letter */
function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/** Read and parse a request body as JSON */
async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response */
function sendJson(res: ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// ────────────────────────────────────────────────────────────────
//  Extension env status
// ────────────────────────────────────────────────────────────────

/** Build the env status response for a single extension */
async function getExtensionEnvStatus(manifest: ExtensionManifest, extensionManager?: ExtensionManager) {
  // Read current .env
  let currentEnv: Record<string, string> = {};
  try {
    const content = await readFile(join(manifest.directory, '.env'), 'utf-8');
    currentEnv = parseEnvFile(content);
  } catch {
    // No .env file
  }

  // Build status for each declared var
  const vars = Object.entries(manifest.envDeclarations).map(([key, decl]) => ({
    name: key,
    description: decl.description,
    required: decl.required,
    type: decl.type || 'string',
    isSet: !!currentEnv[key],
    maskedValue: currentEnv[key] ? maskValue(currentEnv[key]) : null,
    // For path-type vars, also send the raw value (not secret data)
    ...(decl.type === 'path' && currentEnv[key] ? { rawValue: currentEnv[key] } : {}),
  }));

  // Include any extra vars in .env not declared in manifest
  const declaredKeys = new Set(Object.keys(manifest.envDeclarations));
  const extraVars = Object.entries(currentEnv)
    .filter(([key]) => !declaredKeys.has(key))
    .map(([key, value]) => ({
      name: key,
      description: '',
      required: false,
      isSet: true,
      maskedValue: maskValue(value),
    }));

  // Get web UI URLs from the running extension manager
  let webUIs: string[] = [];
  if (extensionManager) {
    const summaries = extensionManager.getExtensionSummaries();
    const summary = summaries.find(s => s.name === manifest.name);
    if (summary) {
      webUIs = summary.webUIs;
    }
  }

  // Check for external web app status (e.g., social-scheduler writes its own status file)
  try {
    const statusPath = join(manifest.directory, '.webui-status.json');
    const statusContent = await readFile(statusPath, 'utf-8');
    const status = JSON.parse(statusContent);
    if (status.url && !webUIs.includes(status.url)) {
      webUIs.push(status.url);
    }
  } catch {
    // No status file — that's fine
  }

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    source: manifest.source,
    directory: manifest.directory,
    vars: [...vars, ...extraVars],
    webUIs,
  };
}

// ────────────────────────────────────────────────────────────────
//  Dashboard server
// ────────────────────────────────────────────────────────────────

export async function startDashboard(
  verbose: boolean = false,
  extensionManager?: ExtensionManager,
  workingDirectory?: string,
  preferredPort: number = 9001
): Promise<DashboardHandle> {
  // Static files are copied to dist/config-dashboard/ by the postbuild script
  const staticDir = join(__dirname, 'config-dashboard');
  const workDir = workingDirectory || process.cwd();

  // Recording state — shared across requests
  let activeRecorder: WorkflowRecorder | null = null;
  let recordingSteps: Array<{ index: number; label: string; type: string }> = [];
  let recordingStatus: string = '';

  // Workflow execution state — shared across requests
  let activeRun: {
    runId?: string;
    workflowId: string;
    workflowName: string;
    abort: AbortController;
    startedAt: number;
    stepsTotal: number;
    stepsCompleted: number;
    currentStep: string;
    stepResults: Array<{ index: number; label: string; type: string; status: string; error?: string }>;
    done: boolean;
    success: boolean;
    error?: string;
    durationMs?: number;
    outputVariables?: Record<string, unknown>;
  } | null = null;

  // Composition execution state
  let activeCompRun: {
    runId?: string;
    compositionId: string;
    compositionName: string;
    abort: AbortController;
    startedAt: number;
    nodesTotal: number;
    nodesCompleted: number;
    currentNodeId: string | null;
    executionOrder: string[];
    nodeStates: Record<string, {
      status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'skipped';
      workflowId: string;
      workflowName: string;
      stepsTotal: number;
      stepsCompleted: number;
      currentStep: string;
      error?: string;
      outputVariables?: Record<string, unknown>;
      durationMs?: number;
      retryAttempt?: number;
      retryMax?: number;
      expectationResults?: Array<{ description: string; passed: boolean; detail: string }>;
    }>;
    done: boolean;
    success: boolean;
    error?: string;
    durationMs?: number;
  } | null = null;

  // Debug mode state (visual step-through)
  let debugSession: {
    workflowId: string;
    workflowName: string;
    workflow: any;
    variables: Record<string, unknown>;
    currentIndex: number;
    completedIndices: number[];
    failedIndices: number[];
    stepResults: any[];
  } | null = null;

  // Batch run state
  let activeBatchRun: {
    batchId: string;
    compositionId: string;
    compositionName: string;
    abort: AbortController;
    startedAt: number;
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
    currentIteration: number;
    iterationVariables: Record<string, unknown>[];
    runIds: string[];
    delayBetweenMs: number;
    done: boolean;
    error?: string;
    durationMs?: number;
  } | null = null;

  // Training state — subprocess management
  let activeTraining: {
    process: ChildProcess | null;
    runId?: string;
    backbone: string;
    epochs: number;
    currentEpoch: number;
    totalEpochs: number;
    loss: number;
    lr: number;
    eta_s: number;
    phase: 'preparing' | 'training' | 'exporting' | 'complete' | 'error';
    metrics: Record<string, number>;
    bestAuc: number;
    logs: string[];
    done: boolean;
    success: boolean;
    error?: string;
    outputDir: string;
    startedAt: number;
    durationMs?: number;
    trainSamples?: number;
    valSamples?: number;
    groups?: number;
    device?: string;
    embedDim?: number;
    lossType?: string;
  } | null = null;

  const TRAINING_DATA_DIR = join(homedir(), '.woodbury', 'data', 'training-crops');
  const MODELS_DIR = join(homedir(), '.woodbury', 'data', 'models');
  const WORKERS_FILE = join(homedir(), '.woodbury', 'data', 'workers.json');

  // Worker management
  interface WorkerConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    addedAt: string;
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

  // Remote training state (mirrors activeTraining shape + worker info)
  let remoteTraining: {
    worker: WorkerConfig;
    jobId: string;
    pollTimer: ReturnType<typeof setInterval> | null;
    eventIndex: number;
    backbone: string;
    epochs: number;
    currentEpoch: number;
    totalEpochs: number;
    loss: number;
    lr: number;
    eta_s: number;
    phase: string;
    metrics: Record<string, number>;
    bestAuc: number;
    logs: string[];
    done: boolean;
    success: boolean;
    error?: string;
    outputDir: string;
    startedAt: number;
    durationMs?: number;
    trainSamples?: number;
    valSamples?: number;
    groups?: number;
    device?: string;
    embedDim?: number;
    lossType?: string;
  } | null = null;

  function processRemoteEvent(evt: any) {
    if (!remoteTraining) return;
    switch (evt.event) {
      case 'init':
        remoteTraining.trainSamples = evt.train_samples;
        remoteTraining.valSamples = evt.val_samples;
        remoteTraining.groups = evt.groups;
        remoteTraining.device = evt.device;
        remoteTraining.totalEpochs = evt.epochs;
        break;
      case 'epoch':
        remoteTraining.currentEpoch = evt.epoch;
        remoteTraining.loss = evt.loss;
        remoteTraining.lr = evt.lr;
        remoteTraining.eta_s = evt.eta_s || 0;
        break;
      case 'validation':
        remoteTraining.metrics = { ...evt };
        delete (remoteTraining.metrics as any).event;
        delete (remoteTraining.metrics as any).epoch;
        if (evt.best_auc !== undefined) remoteTraining.bestAuc = evt.best_auc;
        break;
      case 'export':
        remoteTraining.phase = evt.phase === 'complete' ? 'complete' : 'exporting';
        break;
      case 'complete':
        remoteTraining.bestAuc = evt.best_auc || remoteTraining.bestAuc;
        break;
      case 'error':
        remoteTraining.error = evt.message;
        break;
    }
  }

  function startRemotePolling() {
    if (!remoteTraining) return;
    remoteTraining.pollTimer = setInterval(async () => {
      if (!remoteTraining) return;
      try {
        const data: any = await new Promise((resolve, reject) => {
          const req = httpRequest({
            hostname: remoteTraining!.worker.host,
            port: remoteTraining!.worker.port,
            path: `/jobs/current/events?since=${remoteTraining!.eventIndex}`,
            method: 'GET',
            timeout: 5000,
          }, (res) => {
            let body = '';
            res.on('data', (chunk: string) => body += chunk);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        // Process new events
        for (const evt of (data.events || [])) {
          processRemoteEvent(evt);
        }
        remoteTraining.eventIndex = data.total || remoteTraining.eventIndex;

        // Also fetch full status for phase/done/logs
        const status: any = await new Promise((resolve, reject) => {
          const req = httpRequest({
            hostname: remoteTraining!.worker.host,
            port: remoteTraining!.worker.port,
            path: '/jobs/current',
            method: 'GET',
            timeout: 5000,
          }, (res) => {
            let body = '';
            res.on('data', (chunk: string) => body += chunk);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });

        remoteTraining.phase = status.phase || remoteTraining.phase;
        remoteTraining.logs = status.logs || remoteTraining.logs;

        if (status.done) {
          remoteTraining.done = true;
          remoteTraining.success = status.success;
          remoteTraining.error = status.error;
          remoteTraining.durationMs = Date.now() - remoteTraining.startedAt;
          if (remoteTraining.pollTimer) clearInterval(remoteTraining.pollTimer);
          remoteTraining.pollTimer = null;

          // Pull artifacts if successful
          if (status.success && status.has_artifacts) {
            try {
              await pullRemoteArtifacts();
            } catch (e) {
              remoteTraining.logs.push(`Warning: Failed to pull artifacts: ${e}`);
            }
          }

          // Save run record
          try {
            const runId = generateRunId();
            await createRunRecord({
              id: runId,
              type: 'training',
              name: `Train ${remoteTraining.backbone} (${remoteTraining.epochs} epochs) [${remoteTraining.worker.name}]`,
              status: status.success ? 'completed' : 'failed',
              startedAt: new Date(remoteTraining.startedAt).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: remoteTraining.durationMs,
              stepsCompleted: remoteTraining.currentEpoch,
              stepsTotal: remoteTraining.totalEpochs,
              error: remoteTraining.error,
              metadata: {
                backbone: remoteTraining.backbone,
                epochs: remoteTraining.epochs,
                bestAuc: remoteTraining.bestAuc,
                outputDir: remoteTraining.outputDir,
                lossType: remoteTraining.lossType,
                embedDim: remoteTraining.embedDim,
                worker: remoteTraining.worker.name,
              },
            } as any);
          } catch {}
        }
      } catch {
        // Worker unreachable — keep trying for a while
        if (remoteTraining) {
          remoteTraining.logs.push('Warning: Worker unreachable, retrying...');
        }
      }
    }, 1500);
  }

  async function pullRemoteArtifacts() {
    if (!remoteTraining) return;
    const runTs = Date.now();
    const localDir = join(MODELS_DIR, `run-${runTs}`);
    await mkdir(localDir, { recursive: true });
    remoteTraining.outputDir = localDir;

    return new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: remoteTraining!.worker.host,
        port: remoteTraining!.worker.port,
        path: '/jobs/current/artifacts',
        method: 'GET',
        timeout: 60000,
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Artifact download failed: ${res.statusCode}`));
          return;
        }
        const tarPath = join(localDir, 'artifacts.tar.gz');
        const ws = createWriteStream(tarPath);
        res.pipe(ws);
        ws.on('finish', () => {
          // Extract tar.gz
          const tar = spawn('tar', ['xzf', tarPath, '-C', localDir]);
          tar.on('close', (code) => {
            // Clean up tar file
            unlink(tarPath).catch(() => {});
            if (code === 0) {
              remoteTraining!.logs.push(`Artifacts saved to ${localDir}`);
              resolve();
            } else {
              reject(new Error(`tar extract failed with code ${code}`));
            }
          });
        });
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  // ── Run History Storage ─────────────────────────────
  const RUNS_DIR = join(homedir(), '.woodbury', 'data');
  const RUNS_FILE = join(RUNS_DIR, 'runs.json');
  const MAX_RUNS = 500;
  let runsCache: RunRecord[] | null = null;

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

  function generateRunId(): string {
    return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }

  async function createRunRecord(record: RunRecord): Promise<void> {
    const runs = await loadRuns();
    runs.push(record);
    await saveRuns(runs);
  }

  async function updateRunRecord(id: string, updates: Partial<RunRecord>): Promise<void> {
    const runs = await loadRuns();
    const idx = runs.findIndex(r => r.id === id);
    if (idx >= 0) {
      Object.assign(runs[idx], updates);
      await saveRuns(runs);
    }
  }

  async function deleteRunRecord(id: string): Promise<boolean> {
    const runs = await loadRuns();
    const idx = runs.findIndex(r => r.id === id);
    if (idx < 0) return false;
    runs.splice(idx, 1);
    await saveRuns(runs);
    return true;
  }

  function extractOutputFiles(variables: Record<string, unknown>): string[] {
    const files: string[] = [];
    for (const val of Object.values(variables)) {
      if (typeof val === 'string' && (val.startsWith('/') || val.startsWith('~'))) {
        files.push(val);
      }
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('~'))) {
            files.push(item);
          }
        }
      }
    }
    return files;
  }

  // ── Schedule Storage + Scheduler ────────────────────
  const SCHEDULES_FILE = join(RUNS_DIR, 'schedules.json');
  let schedulesCache: Schedule[] | null = null;
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;

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

  /**
   * Simple cron matcher — checks if a Date matches a cron expression.
   * Format: "minute hour dom month dow"
   * Supports: numbers, '*', comma-separated values, ranges (1-5), step values (star/N).
   */
  function cronMatchesDate(cron: string, date: Date): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const fields = [
      date.getMinutes(),   // 0-59
      date.getHours(),     // 0-23
      date.getDate(),      // 1-31
      date.getMonth() + 1, // 1-12
      date.getDay(),       // 0-6 (0=Sunday)
    ];

    for (let i = 0; i < 5; i++) {
      if (!cronFieldMatches(parts[i], fields[i])) return false;
    }
    return true;
  }

  function cronFieldMatches(field: string, value: number): boolean {
    if (field === '*') return true;

    // Step values: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step) || step <= 0) return false;
      return value % step === 0;
    }

    // Comma-separated values
    const segments = field.split(',');
    for (const seg of segments) {
      // Range: a-b
      if (seg.includes('-')) {
        const [lo, hi] = seg.split('-').map(Number);
        if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
      } else {
        if (parseInt(seg, 10) === value) return true;
      }
    }
    return false;
  }

  /**
   * Scheduler tick — runs every 60 seconds. For each enabled schedule,
   * check if the cron matches the current minute. If so, trigger a
   * composition run via internal HTTP fetch (reuses existing pipeline logic).
   */
  async function schedulerTick(): Promise<void> {
    try {
      const schedules = await loadSchedules();
      const now = new Date();

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (!cronMatchesDate(schedule.cron, now)) continue;

        // Prevent double-fire: skip if lastRunAt is within the same minute
        if (schedule.lastRunAt) {
          const lastRun = new Date(schedule.lastRunAt);
          if (
            lastRun.getFullYear() === now.getFullYear() &&
            lastRun.getMonth() === now.getMonth() &&
            lastRun.getDate() === now.getDate() &&
            lastRun.getHours() === now.getHours() &&
            lastRun.getMinutes() === now.getMinutes()
          ) {
            continue; // already fired this minute
          }
        }

        // Skip if there's already an active composition or batch run
        if (activeCompRun || activeBatchRun) {
          debugLog.info('scheduler', `Skipping schedule "${schedule.id}" — another run is active`);
          continue;
        }

        debugLog.info('scheduler', `Triggering schedule "${schedule.id}" for composition "${schedule.compositionId}"`);

        try {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          const body = JSON.stringify({ variables: schedule.variables || {} });
          const runRes = await fetch(
            `http://127.0.0.1:${port}/api/compositions/${encodeURIComponent(schedule.compositionId)}/run`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            }
          );
          const runData = await runRes.json() as { success?: boolean; runId?: string; error?: string };

          // Update schedule metadata
          schedule.lastRunAt = now.toISOString();
          if (runData.runId) schedule.lastRunId = runData.runId;
          await saveSchedules(schedules);

          debugLog.info('scheduler', `Schedule "${schedule.id}" triggered — runId: ${runData.runId || 'unknown'}`);
        } catch (err) {
          debugLog.info('scheduler', `Schedule "${schedule.id}" trigger failed: ${String(err)}`);
        }
      }
    } catch (err) {
      debugLog.info('scheduler', `Scheduler tick error: ${String(err)}`);
    }
  }

  function startScheduler(): void {
    if (schedulerTimer) return;
    // Run tick every 60 seconds, starting after a short delay
    schedulerTimer = setInterval(() => { schedulerTick(); }, 60_000);
    debugLog.info('scheduler', 'Scheduler started (60s interval)');
  }

  function stopScheduler(): void {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      debugLog.info('scheduler', 'Scheduler stopped');
    }
  }

  // Start the scheduler immediately
  startScheduler();

  // ── Pending Approvals ───────────────────────────────
  const pendingApprovals = new Map<string, {
    approval: PendingApproval;
    resolve: (approved: boolean) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  function createApprovalRequest(
    nodeId: string,
    runId: string,
    compositionId: string,
    compositionName: string,
    gate: ApprovalGateConfig,
    upstreamVars: Record<string, unknown>,
  ): Promise<boolean> {
    const id = 'approval-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    // Build preview variables from upstream outputs
    let previewVars: Record<string, unknown> | undefined;
    if (gate.previewVariables && gate.previewVariables.length > 0) {
      previewVars = {};
      for (const varName of gate.previewVariables) {
        if (varName in upstreamVars) {
          previewVars[varName] = upstreamVars[varName];
        }
      }
    } else {
      // Default: show all upstream variables
      previewVars = { ...upstreamVars };
    }

    const approval: PendingApproval = {
      id,
      runId,
      nodeId,
      compositionId,
      compositionName,
      message: gate.message,
      previewVariables: previewVars,
      createdAt: new Date().toISOString(),
      timeoutMs: gate.timeoutMs,
    };

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      // Auto-reject on timeout
      if (gate.timeoutMs && gate.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pendingApprovals.has(id)) {
            pendingApprovals.delete(id);
            debugLog.info('approval', `Approval "${id}" auto-rejected (timeout: ${gate.timeoutMs}ms)`);
            resolve(false);
          }
        }, gate.timeoutMs);
      }

      pendingApprovals.set(id, { approval, resolve, timer });
      debugLog.info('approval', `Approval gate created: "${id}" for node "${nodeId}" in "${compositionName}"`);
    });
  }

  // ── Composition execution helpers ──────────────────
  function topoSort(
    nodes: Array<{ id: string }>,
    edges: Array<{ sourceNodeId: string; targetNodeId: string }>
  ): string[] {
    const adj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();
    for (const n of nodes) { adj.set(n.id, []); inDeg.set(n.id, 0); }
    for (const e of edges) {
      adj.get(e.sourceNodeId)?.push(e.targetNodeId);
      inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) || 0) + 1);
    }
    const queue: string[] = [];
    for (const [id, deg] of inDeg) { if (deg === 0) queue.push(id); }
    const result: string[] = [];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);
      for (const neighbor of (adj.get(nodeId) || [])) {
        const newDeg = (inDeg.get(neighbor) || 1) - 1;
        inDeg.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }
    if (result.length !== nodes.length) {
      throw new Error('These workflows form a loop and can\'t run in order. Check your connections.');
    }
    return result;
  }

  function gatherInputVariables(
    nodeId: string,
    edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>,
    nodeOutputs: Record<string, Record<string, unknown>>
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const edge of edges) {
      if (edge.targetNodeId !== nodeId) continue;
      const upstreamOutputs = nodeOutputs[edge.sourceNodeId];
      if (upstreamOutputs && edge.sourcePort in upstreamOutputs) {
        inputs[edge.targetPort] = upstreamOutputs[edge.sourcePort];
      }
    }
    return inputs;
  }

  // Find all downstream node IDs from a given node
  function getDownstreamNodes(
    nodeId: string,
    edges: Array<{ sourceNodeId: string; targetNodeId: string }>
  ): Set<string> {
    const downstream = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of edges) {
        if (e.sourceNodeId === current && !downstream.has(e.targetNodeId)) {
          downstream.add(e.targetNodeId);
          queue.push(e.targetNodeId);
        }
      }
    }
    return downstream;
  }

  const server: Server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Log API requests (skip static file requests for brevity)
    if (pathname.startsWith('/api/')) {
      debugLog.debug('dashboard', `${req.method} ${pathname}`);
    }

    // ── API Routes ───────────────────────────────────────────

    // GET /api/extensions
    if (req.method === 'GET' && pathname === '/api/extensions') {
      try {
        const manifests = await discoverExtensions();
        const extensions = await Promise.all(
          manifests.map((m) => getExtensionEnvStatus(m, extensionManager))
        );
        sendJson(res, 200, { extensions });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/extensions/:name/env
    const getEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'GET' && getEnvMatch) {
      const name = decodeURIComponent(getEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }
        const status = await getExtensionEnvStatus(manifest, extensionManager);
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/extensions/:name/env
    const putEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'PUT' && putEnvMatch) {
      const name = decodeURIComponent(putEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || typeof body.vars !== 'object') {
          sendJson(res, 400, {
            error: 'Request body must have a "vars" object',
          });
          return;
        }

        // Validate var names
        for (const key of Object.keys(body.vars)) {
          if (!isValidEnvVarName(key)) {
            sendJson(res, 400, { error: `Invalid env var name: "${key}"` });
            return;
          }
        }

        // Read existing .env to merge (preserve vars not in request)
        let existingEnv: Record<string, string> = {};
        const envFilePath = join(manifest.directory, '.env');
        try {
          const content = await readFile(envFilePath, 'utf-8');
          existingEnv = parseEnvFile(content);
        } catch {
          // No existing .env file
        }

        // Merge: new values override existing; empty string = delete
        const merged = { ...existingEnv };
        for (const [key, value] of Object.entries(
          body.vars as Record<string, string>
        )) {
          if (value === '' || value === null || value === undefined) {
            delete merged[key];
          } else {
            merged[key] = String(value);
          }
        }

        // Write back
        const envContent = writeEnvFile(merged);
        await writeFile(envFilePath, envContent, 'utf-8');
        debugLog.info('dashboard', `Updated env for "${name}"`, {
          keysSet: Object.keys(merged),
          envFile: envFilePath,
        });

        // Return updated status
        const status = await getExtensionEnvStatus(manifest, extensionManager);
        sendJson(res, 200, { success: true, ...status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/browse — list directories for folder picker
    if (req.method === 'POST' && pathname === '/api/browse') {
      try {
        const body = await readBody(req);
        const dir = body?.path || homedir();

        const entries = await readdir(dir, { withFileTypes: true });
        const dirs: Array<{ name: string; path: string }> = [];
        for (const entry of entries) {
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          try {
            const fullPath = join(dir, entry.name);
            const stats = await stat(fullPath);
            if (stats.isDirectory()) {
              dirs.push({ name: entry.name, path: fullPath });
            }
          } catch {
            // Skip unreadable entries
          }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, { current: dir, parent: join(dir, '..'), dirs });
      } catch (err) {
        sendJson(res, 400, { error: `Cannot read directory: ${err}` });
      }
      return;
    }

    // ── Workflow API Routes ─────────────────────────────────

    // GET /api/workflows — list all workflows
    if (req.method === 'GET' && pathname === '/api/workflows') {
      try {
        const discovered = await discoverWorkflows(workDir);
        const workflows = discovered.map(d => ({
          id: d.workflow.id,
          name: d.workflow.name,
          description: d.workflow.description,
          site: d.workflow.site,
          source: d.source,
          extensionName: d.extensionName,
          path: d.path,
          stepCount: d.workflow.steps.length,
          variableCount: d.workflow.variables.length,
          variables: d.workflow.variables.map(v => ({
            name: v.name,
            description: v.description,
            type: v.type,
            required: v.required,
            default: v.default,
          })),
          outputVariables: inferOutputVariables(d.workflow),
          smartWaitCount: d.workflow.steps.filter(
            (s: any) => s.type === 'wait' && s.condition?.type !== 'delay'
          ).length,
          metadata: d.workflow.metadata,
        }));
        sendJson(res, 200, { workflows });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows — create a new workflow from scratch
    if (req.method === 'POST' && pathname === '/api/workflows') {
      try {
        const body = await readBody(req);
        if (!body) {
          sendJson(res, 400, { error: 'Request body is required' });
          return;
        }

        const { name, description, site, variables, steps } = body;
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendJson(res, 400, { error: 'Workflow name is required' });
          return;
        }

        // Generate ID from name: "My Workflow" → "my-workflow"
        const id = name.trim().toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (!id) {
          sendJson(res, 400, { error: 'Could not generate a valid ID from the workflow name' });
          return;
        }

        // Check for ID collision
        const discovered = await discoverWorkflows(workDir);
        if (discovered.some(d => d.workflow.id === id)) {
          sendJson(res, 409, { error: `A workflow with ID "${id}" already exists` });
          return;
        }

        // Build the workflow document
        const workflow = {
          version: '1.0',
          id,
          name: name.trim(),
          description: (description || '').trim() || `Workflow: ${name.trim()}`,
          site: (site || '').trim() || undefined,
          variables: Array.isArray(variables) ? variables : [],
          steps: Array.isArray(steps) ? steps : [],
          metadata: {
            createdAt: new Date().toISOString(),
            recordedBy: 'dashboard',
          },
        };

        // Save to global workflows directory
        const globalDir = join(homedir(), '.woodbury', 'workflows');
        await mkdir(globalDir, { recursive: true });
        const filePath = join(globalDir, `${id}.workflow.json`);
        await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');
        debugLog.info('dashboard', `Created workflow "${id}"`, { path: filePath });
        sendJson(res, 201, { success: true, workflow, path: filePath });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Recording API Routes ──────────────────────────────────

    // POST /api/recording/start — start recording a new workflow
    if (req.method === 'POST' && pathname === '/api/recording/start') {
      dashRecLog('INFO', '/api/recording/start called');
      try {
        const body = await readBody(req);
        dashRecLog('INFO', 'Request body', { name: body?.name, site: body?.site });
        if (!body || !body.name || !body.site) {
          dashRecLog('ERROR', 'Missing name or site');
          sendJson(res, 400, { error: 'name and site are required' });
          return;
        }
        if (activeRecorder?.isActive) {
          dashRecLog('ERROR', 'Recording already in progress');
          sendJson(res, 409, { error: 'Recording already in progress. Stop or cancel first.' });
          return;
        }

        recordingSteps = [];
        recordingStatus = 'Starting...';

        activeRecorder = new WorkflowRecorder(
          // onStepCaptured — collect steps for the UI to poll
          (step, index) => {
            recordingSteps.push({
              index,
              label: step.label || step.id || `Step ${index + 1}`,
              type: step.type,
            });
          },
          // onStatus — track status messages
          (status) => {
            recordingStatus = status;
          }
        );

        const captureElementCrops = body.captureElementCrops !== false; // default true
        dashRecLog('INFO', 'Calling activeRecorder.start()', { captureElementCrops });
        await activeRecorder.start(body.name, body.site, { captureElementCrops });
        dashRecLog('INFO', 'activeRecorder.start() completed successfully');
        sendJson(res, 200, { success: true, status: 'recording' });
      } catch (err) {
        dashRecLog('ERROR', 'Recording start failed', { error: String(err), stack: (err as Error)?.stack });
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/stop — stop recording and save the workflow
    if (req.method === 'POST' && pathname === '/api/recording/stop') {
      dashRecLog('INFO', '/api/recording/stop called');
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }

        const result = await activeRecorder.stop(workDir);
        activeRecorder = null;
        recordingStatus = '';

        sendJson(res, 200, {
          success: true,
          workflow: result.workflow,
          filePath: result.filePath,
          stepCount: recordingSteps.length,
          newDownloads: result.newDownloads || [],
        });
        recordingSteps = [];
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/pause — pause recording
    if (req.method === 'POST' && pathname === '/api/recording/pause') {
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }
        activeRecorder.pause();
        sendJson(res, 200, { success: true, status: 'paused' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/resume — resume recording
    if (req.method === 'POST' && pathname === '/api/recording/resume') {
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }
        activeRecorder.resume();
        sendJson(res, 200, { success: true, status: 'recording' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/cancel — cancel recording without saving
    if (req.method === 'POST' && pathname === '/api/recording/cancel') {
      try {
        if (activeRecorder?.isActive) {
          activeRecorder.cancel();
        }
        activeRecorder = null;
        recordingSteps = [];
        recordingStatus = '';
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/recording/status — poll recording state and captured steps
    if (req.method === 'GET' && pathname === '/api/recording/status') {
      if (!activeRecorder) {
        // Only log once per "not active" stretch to avoid spamming
        dashRecLog('DEBUG', '/api/recording/status: no activeRecorder');
        sendJson(res, 200, { active: false, paused: false, stepCount: 0, steps: [], status: '' });
        return;
      }
      const status = activeRecorder.getStatus();
      if (!status.active) {
        dashRecLog('WARN', '/api/recording/status: activeRecorder exists but session not active', {
          hasRecorder: true,
          isActive: status.active,
        });
      }
      sendJson(res, 200, {
        ...status,
        steps: recordingSteps,
        statusMessage: recordingStatus,
      });
      return;
    }

    // POST /api/workflows/:id/run — execute a workflow directly
    const runWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
    if (req.method === 'POST' && runWfMatch) {
      const id = decodeURIComponent(runWfMatch[1]);
      try {
        if (activeRun && !activeRun.done) {
          sendJson(res, 409, { error: `Workflow "${activeRun.workflowName}" is already running. Wait for it to finish or cancel it.` });
          return;
        }
        if (activeCompRun && !activeCompRun.done) {
          sendJson(res, 409, { error: `Composition "${activeCompRun.compositionName}" is running. Wait for it to finish or cancel it.` });
          return;
        }

        const body = await readBody(req);
        const variables: Record<string, unknown> = body?.variables || {};

        // Discover and find the workflow
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        // Ensure bridge server is running + connected
        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.' });
          return;
        }

        const wf = found.workflow;
        const abort = new AbortController();

        activeRun = {
          workflowId: id,
          workflowName: wf.name,
          abort,
          startedAt: Date.now(),
          stepsTotal: wf.steps.length,
          stepsCompleted: 0,
          currentStep: '',
          stepResults: [],
          done: false,
          success: false,
        };

        // Load the workflow runner from the social-scheduler extension
        let executeWorkflow: Function;
        try {
          const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const wfRunner = require(wfRunnerPath);
          executeWorkflow = wfRunner.executeWorkflow;
          if (!executeWorkflow) {
            throw new Error(`executeWorkflow not found in module. Keys: ${Object.keys(wfRunner).join(', ')}`);
          }
        } catch (importErr: any) {
          sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message || String(importErr)}` });
          activeRun = null;
          return;
        }

        // Merge defaults for missing variables
        const mergedVars: Record<string, unknown> = { ...variables };
        for (const v of (wf.variables || [])) {
          if (mergedVars[v.name] === undefined && v.default !== undefined) {
            mergedVars[v.name] = v.default;
          }
        }

        // Auto-generate variables with AI prompts that still have no value
        const toGenerate = ((wf.variables || []) as any[]).filter(
          (v: any) => v.generationPrompt && (mergedVars[v.name] === undefined || mergedVars[v.name] === '')
        );
        if (toGenerate.length > 0) {
          debugLog.info('dashboard-run', `Auto-generating ${toGenerate.length} variable(s) with AI prompts`);
          try {
            const { runPrompt } = await import('./loop/llm-service.js');
            const model = process.env.ANTHROPIC_API_KEY
              ? 'claude-sonnet-4-20250514'
              : process.env.OPENAI_API_KEY
                ? 'gpt-4o-mini'
                : process.env.GROQ_API_KEY
                  ? 'llama-3.1-70b-versatile'
                  : 'claude-sonnet-4-20250514';

            for (const v of toGenerate) {
              try {
                const genPrompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${v.name}" (type: ${v.type || 'string'})
Workflow: "${wf.name}" on ${wf.site || 'unknown site'}

Instructions from the user:
${v.generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

                const llmResponse = await runPrompt(
                  [{ role: 'user', content: genPrompt }],
                  model,
                  { maxTokens: 2048, temperature: 0.9 }
                );
                mergedVars[v.name] = llmResponse.content.trim();
                debugLog.info('dashboard-run', `Generated "${v.name}" (${String(mergedVars[v.name]).length} chars)`);
              } catch (genErr) {
                debugLog.warn('dashboard-run', `Failed to generate "${v.name}": ${genErr}`);
                // Non-fatal — variable stays empty or default
              }
            }
          } catch (importErr) {
            debugLog.warn('dashboard-run', `LLM import failed, skipping auto-generation: ${importErr}`);
          }
        }

        // Create run history record
        const runId = generateRunId();
        activeRun!.runId = runId;
        await createRunRecord({
          id: runId,
          type: 'workflow',
          sourceId: id,
          name: wf.name,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'running',
          variables: mergedVars,
          stepsTotal: wf.steps.length,
          stepsCompleted: 0,
        });

        sendJson(res, 200, { success: true, status: 'running', runId, workflowName: wf.name, stepsTotal: wf.steps.length });

        // Execute asynchronously (don't await — we respond immediately)
        const run = activeRun;
        executeWorkflow(bridgeServer, wf, mergedVars, {
          log: (msg: string) => debugLog.info('dashboard-run', msg),
          signal: abort.signal,
          onProgress: (event: { type: string; index: number; total: number; step: any; status?: string; error?: string }) => {
            if (event.type === 'step_start') {
              run.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
            } else if (event.type === 'step_complete') {
              run.stepsCompleted = event.index + 1;
              run.stepResults.push({
                index: event.index,
                label: event.step?.label || event.step?.id || `Step ${event.index + 1}`,
                type: event.step?.type || 'unknown',
                status: event.status || 'unknown',
                error: event.error,
              });
            }
          },
        }).then(async (result: any) => {
          run.done = true;
          run.success = result.success;
          run.durationMs = result.durationMs;
          run.outputVariables = result.variables;
          if (!result.success) {
            run.error = result.error;
          }
          debugLog.info('dashboard-run', `Workflow "${wf.name}" ${result.success ? 'completed' : 'failed'}`, {
            steps: `${result.stepsExecuted}/${result.stepsTotal}`,
            durationMs: result.durationMs,
          });

          // Update run history record
          await updateRunRecord(runId, {
            completedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            status: result.success ? 'completed' : 'failed',
            error: result.error,
            stepsCompleted: result.stepsExecuted,
            stepResults: run.stepResults,
            outputFiles: extractOutputFiles(result.variables || {}),
          });
        }).catch(async (err: Error) => {
          run.done = true;
          run.success = false;
          run.error = String(err);
          debugLog.error('dashboard-run', `Workflow "${wf.name}" crashed`, { error: String(err) });

          await updateRunRecord(runId, {
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - run.startedAt,
            status: 'failed',
            error: String(err),
            stepsCompleted: run.stepsCompleted,
            stepResults: run.stepResults,
          });
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/workflows/run/status — poll workflow execution progress
    if (req.method === 'GET' && pathname === '/api/workflows/run/status') {
      if (!activeRun) {
        sendJson(res, 200, { active: false });
        return;
      }
      sendJson(res, 200, {
        active: !activeRun.done,
        done: activeRun.done,
        runId: activeRun.runId,
        success: activeRun.success,
        workflowId: activeRun.workflowId,
        workflowName: activeRun.workflowName,
        stepsTotal: activeRun.stepsTotal,
        stepsCompleted: activeRun.stepsCompleted,
        currentStep: activeRun.currentStep,
        stepResults: activeRun.stepResults,
        error: activeRun.error,
        durationMs: activeRun.done ? activeRun.durationMs : Date.now() - activeRun.startedAt,
        outputVariables: activeRun.outputVariables,
      });
      return;
    }

    // POST /api/workflows/run/cancel — abort a running workflow
    if (req.method === 'POST' && pathname === '/api/workflows/run/cancel') {
      if (!activeRun || activeRun.done) {
        sendJson(res, 400, { error: 'No workflow is currently running' });
        return;
      }
      activeRun.abort.abort();
      activeRun.done = true;
      activeRun.success = false;
      activeRun.error = 'Cancelled by user';
      activeRun.durationMs = Date.now() - activeRun.startedAt;

      if (activeRun.runId) {
        updateRunRecord(activeRun.runId, {
          completedAt: new Date().toISOString(),
          durationMs: activeRun.durationMs,
          status: 'cancelled',
          error: 'Cancelled by user',
          stepsCompleted: activeRun.stepsCompleted,
          stepResults: activeRun.stepResults,
        }).catch(() => {});
      }

      sendJson(res, 200, { success: true, message: 'Workflow cancelled' });
      return;
    }

    // ── Workflow Debug Mode ──────────────────────────────────

    // POST /api/workflows/:id/debug/start — enter debug mode with overlay
    const debugStartMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/start$/);
    if (req.method === 'POST' && debugStartMatch) {
      const id = decodeURIComponent(debugStartMatch[1]);
      try {
        const body = await readBody(req);
        const variables: Record<string, unknown> = body?.variables || {};

        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) { sendJson(res, 404, { error: `Workflow "${id}" not found` }); return; }

        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected.' }); return;
        }

        const wf = found.workflow;

        // Merge variable defaults
        const mergedVars: Record<string, unknown> = { ...variables };
        for (const v of (wf.variables || [])) {
          if (mergedVars[v.name] === undefined && v.default !== undefined) {
            mergedVars[v.name] = v.default;
          }
        }

        // Build step overlay data
        const overlaySteps = wf.steps.map((step: any, i: number) => {
          const eb = step.target?.expectedBounds;
          return {
            index: i,
            id: step.id,
            type: step.type,
            label: step.label || step.id || `Step ${i + 1}`,
            hasPosition: !!(eb && typeof eb.pctX === 'number' && typeof eb.pctY === 'number'),
            pctX: eb?.pctX ?? null,
            pctY: eb?.pctY ?? null,
            pctW: eb?.pctW ?? null,
            pctH: eb?.pctH ?? null,
            waitMs: step.type === 'wait' && step.condition?.type === 'delay' ? step.condition.ms : null,
            verifyClick: step.type === 'click' ? (step.verifyClick ?? null) : null,
            clickType: step.type === 'click' ? (step.clickType || 'single') : null,
            // capture_download fields
            filenamePattern: step.type === 'capture_download' ? (step.filenamePattern ?? null) : null,
            maxFiles: step.type === 'capture_download' ? (step.maxFiles ?? 1) : null,
            waitTimeoutMs: step.type === 'capture_download' ? (step.waitTimeoutMs ?? 60000) : null,
            outputVariable: step.type === 'capture_download' ? (step.outputVariable ?? 'downloadedFiles') : null,
            // move_file fields
            source: step.type === 'move_file' ? (step.source ?? null) : null,
            destination: step.type === 'move_file' ? (step.destination ?? null) : null,
          };
        });

        // Send overlay to Chrome extension
        try {
          const dbgPort = (server.address() as any)?.port || preferredPort;
          await bridgeServer.send('show_debug_overlay', {
            steps: overlaySteps,
            workflowName: wf.name,
            workflowId: id,
            apiBaseUrl: `http://127.0.0.1:${dbgPort}`,
          });
        } catch (overlayErr) {
          debugLog.warn('debug-mode', 'Failed to show overlay', { error: String(overlayErr) });
        }

        // Init debug session
        debugSession = {
          workflowId: id,
          workflowName: wf.name,
          workflow: wf,
          variables: mergedVars,
          currentIndex: 0,
          completedIndices: [],
          failedIndices: [],
          stepResults: [],
        };

        sendJson(res, 200, { success: true, workflowName: wf.name, steps: overlaySteps });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/debug/step — execute next step
    const debugStepMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/step$/);
    if (req.method === 'POST' && debugStepMatch) {
      const id = decodeURIComponent(debugStepMatch[1]);
      try {
        if (!debugSession || debugSession.workflowId !== id) {
          sendJson(res, 400, { error: 'No debug session active for this workflow' }); return;
        }
        if (debugSession.currentIndex >= debugSession.workflow.steps.length) {
          sendJson(res, 400, { error: 'All steps completed' }); return;
        }

        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected.' }); return;
        }

        // Load executeSingleStep from workflow-runner
        let executeSingleStep: Function;
        try {
          const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
          const wfRunner = require(wfRunnerPath);
          executeSingleStep = wfRunner.executeSingleStep;
          if (!executeSingleStep) {
            throw new Error('executeSingleStep not found in module');
          }
        } catch (importErr: any) {
          sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message}` }); return;
        }

        const stepIdx = debugSession.currentIndex;
        const step = debugSession.workflow.steps[stepIdx];

        // Execute single step
        const result = await executeSingleStep(bridgeServer, step, debugSession.variables, {
          log: (msg: string) => debugLog.info('debug-step', msg),
        });

        // Update session state
        if (result.success) {
          debugSession.completedIndices.push(stepIdx);
        } else {
          debugSession.failedIndices.push(stepIdx);
        }
        debugSession.stepResults.push({
          index: stepIdx,
          label: step.label || step.id,
          type: step.type,
          status: result.success ? 'success' : 'failed',
          error: result.error,
          coordinateInfo: result.coordinateInfo,
        });
        debugSession.currentIndex = stepIdx + 1;

        // Update overlay in Chrome extension
        try {
          await bridgeServer.send('update_debug_step', {
            currentIndex: debugSession.currentIndex,
            completedIndices: debugSession.completedIndices,
            failedIndices: debugSession.failedIndices,
            coordinateInfo: result.coordinateInfo,
            stepIndex: stepIdx,
            stepResult: {
              status: result.success ? 'success' : 'failed',
              error: result.error,
            },
          });
        } catch {}

        const hasMore = debugSession.currentIndex < debugSession.workflow.steps.length;
        sendJson(res, 200, {
          success: true,
          stepIndex: stepIdx,
          stepResult: {
            label: step.label || step.id,
            type: step.type,
            status: result.success ? 'success' : 'failed',
            error: result.error,
          },
          coordinateInfo: result.coordinateInfo,
          hasMore,
          nextIndex: hasMore ? debugSession.currentIndex : null,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/debug/exit — exit debug mode
    const debugExitMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/exit$/);
    if (req.method === 'POST' && debugExitMatch) {
      try {
        await ensureBridgeServer();
        try { await bridgeServer.send('hide_debug_overlay', {}); } catch {}
        debugSession = null;
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/debug/update-step — update step properties (position or wait time)
    const debugUpdateStepMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/update-step$/);
    if (req.method === 'POST' && debugUpdateStepMatch) {
      const id = decodeURIComponent(debugUpdateStepMatch[1]);
      try {
        const body = await readBody(req);
        const stepIndex = body?.stepIndex;
        const pctX = body?.pctX;
        const pctY = body?.pctY;
        const waitMs = body?.waitMs;
        const verifyClick = body?.verifyClick;
        const clickType = body?.clickType;
        // capture_download fields
        const captureFields = {
          filenamePattern: body?.filenamePattern,
          maxFiles: body?.maxFiles,
          waitTimeoutMs: body?.waitTimeoutMs,
          outputVariable: body?.outputVariable,
        };
        // move_file fields
        const moveSource = body?.source;
        const moveDestination = body?.destination;

        // Validate stepIndex
        if (stepIndex == null || typeof stepIndex !== 'number' || stepIndex < 0) {
          sendJson(res, 400, { error: 'Invalid stepIndex' }); return;
        }

        // Must provide at least one update field
        const hasPosition = pctX != null && pctY != null;
        const hasWait = waitMs != null;
        const hasVerifyClick = verifyClick !== undefined;
        const hasClickType = clickType !== undefined;
        const hasCaptureFields = captureFields.filenamePattern !== undefined ||
          captureFields.maxFiles !== undefined || captureFields.waitTimeoutMs !== undefined ||
          captureFields.outputVariable !== undefined;
        const hasMoveFields = moveSource !== undefined || moveDestination !== undefined;
        if (!hasPosition && !hasWait && !hasVerifyClick && !hasClickType && !hasCaptureFields && !hasMoveFields) {
          sendJson(res, 400, { error: 'Must provide at least one update field' }); return;
        }

        // Validate position if provided
        if (hasPosition) {
          if (typeof pctX !== 'number' || pctX < 0 || pctX > 100) {
            sendJson(res, 400, { error: 'pctX must be a number between 0 and 100' }); return;
          }
          if (typeof pctY !== 'number' || pctY < 0 || pctY > 100) {
            sendJson(res, 400, { error: 'pctY must be a number between 0 and 100' }); return;
          }
        }

        // Validate waitMs if provided
        if (hasWait) {
          if (typeof waitMs !== 'number' || waitMs < 0) {
            sendJson(res, 400, { error: 'waitMs must be a non-negative number' }); return;
          }
        }

        // Validate verifyClick if provided
        if (hasVerifyClick && verifyClick !== null) {
          if (typeof verifyClick !== 'object') {
            sendJson(res, 400, { error: 'verifyClick must be an object or null' }); return;
          }
          if (typeof verifyClick.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'verifyClick.enabled must be a boolean' }); return;
          }
        }

        // Validate clickType if provided
        if (hasClickType) {
          const validClickTypes = ['single', 'double', 'right', 'hover'];
          if (!validClickTypes.includes(clickType)) {
            sendJson(res, 400, { error: `clickType must be one of: ${validClickTypes.join(', ')}` }); return;
          }
        }

        // Check active debug session
        if (!debugSession || debugSession.workflowId !== id) {
          sendJson(res, 400, { error: 'No debug session active for this workflow' }); return;
        }

        const step = debugSession.workflow.steps[stepIndex];
        if (!step) {
          sendJson(res, 400, { error: `Step ${stepIndex} not found` }); return;
        }

        // Update in-memory debug session
        if (hasPosition) {
          if (!step.target) step.target = {};
          if (!step.target.expectedBounds) step.target.expectedBounds = {};
          step.target.expectedBounds.pctX = pctX;
          step.target.expectedBounds.pctY = pctY;
          debugLog.info('debug-mode', `Updated step ${stepIndex} position: pctX=${pctX}, pctY=${pctY}`);
        }
        if (hasWait && step.condition) {
          step.condition.ms = waitMs;
          // Also update the label to reflect new duration
          const secs = (waitMs / 1000).toFixed(1);
          step.label = `Wait ${secs}s`;
          debugLog.info('debug-mode', `Updated step ${stepIndex} wait time: ${waitMs}ms`);
        }
        if (hasVerifyClick) {
          if (verifyClick === null) {
            delete (step as any).verifyClick;
          } else {
            (step as any).verifyClick = {
              enabled: verifyClick.enabled,
              ...(verifyClick.maxAttempts != null && { maxAttempts: verifyClick.maxAttempts }),
              ...(verifyClick.verifyDelayMs != null && { verifyDelayMs: verifyClick.verifyDelayMs }),
              ...(verifyClick.retryDelayMs != null && { retryDelayMs: verifyClick.retryDelayMs }),
            };
          }
          debugLog.info('debug-mode', `Updated step ${stepIndex} verifyClick: ${JSON.stringify(verifyClick)}`);
        }
        if (hasClickType) {
          if (clickType === 'single') {
            delete (step as any).clickType; // 'single' is the default
          } else {
            (step as any).clickType = clickType;
          }
          debugLog.info('debug-mode', `Updated step ${stepIndex} clickType: ${clickType}`);
        }
        if (hasCaptureFields && step.type === 'capture_download') {
          if (captureFields.filenamePattern !== undefined) (step as any).filenamePattern = captureFields.filenamePattern || undefined;
          if (captureFields.maxFiles !== undefined) (step as any).maxFiles = captureFields.maxFiles;
          if (captureFields.waitTimeoutMs !== undefined) (step as any).waitTimeoutMs = captureFields.waitTimeoutMs;
          if (captureFields.outputVariable !== undefined) (step as any).outputVariable = captureFields.outputVariable;
          debugLog.info('debug-mode', `Updated step ${stepIndex} capture_download fields`);
        }
        if (hasMoveFields && step.type === 'move_file') {
          if (moveSource !== undefined) (step as any).source = moveSource;
          if (moveDestination !== undefined) (step as any).destination = moveDestination;
          debugLog.info('debug-mode', `Updated step ${stepIndex} move_file fields`);
        }

        // Persist to disk
        try {
          const discovered = await discoverWorkflows(workDir);
          const found = discovered.find(d => d.workflow.id === id);
          if (found) {
            const wf = found.workflow;
            const diskStep = wf.steps[stepIndex] as any;
            if (diskStep) {
              if (hasPosition) {
                if (!diskStep.target) diskStep.target = {};
                if (!diskStep.target.expectedBounds) diskStep.target.expectedBounds = {};
                diskStep.target.expectedBounds.pctX = pctX;
                diskStep.target.expectedBounds.pctY = pctY;
              }
              if (hasWait && diskStep.condition) {
                diskStep.condition.ms = waitMs;
                const secs = (waitMs / 1000).toFixed(1);
                diskStep.label = `Wait ${secs}s`;
              }
              if (hasVerifyClick) {
                if (verifyClick === null) {
                  delete diskStep.verifyClick;
                } else {
                  diskStep.verifyClick = {
                    enabled: verifyClick.enabled,
                    ...(verifyClick.maxAttempts != null && { maxAttempts: verifyClick.maxAttempts }),
                    ...(verifyClick.verifyDelayMs != null && { verifyDelayMs: verifyClick.verifyDelayMs }),
                    ...(verifyClick.retryDelayMs != null && { retryDelayMs: verifyClick.retryDelayMs }),
                  };
                }
              }
              if (hasClickType) {
                if (clickType === 'single') {
                  delete diskStep.clickType;
                } else {
                  diskStep.clickType = clickType;
                }
              }
              if (hasCaptureFields && diskStep.type === 'capture_download') {
                if (captureFields.filenamePattern !== undefined) diskStep.filenamePattern = captureFields.filenamePattern || undefined;
                if (captureFields.maxFiles !== undefined) diskStep.maxFiles = captureFields.maxFiles;
                if (captureFields.waitTimeoutMs !== undefined) diskStep.waitTimeoutMs = captureFields.waitTimeoutMs;
                if (captureFields.outputVariable !== undefined) diskStep.outputVariable = captureFields.outputVariable;
              }
              if (hasMoveFields && diskStep.type === 'move_file') {
                if (moveSource !== undefined) diskStep.source = moveSource;
                if (moveDestination !== undefined) diskStep.destination = moveDestination;
              }
              if (wf.metadata) wf.metadata.updatedAt = new Date().toISOString();
              await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
              debugLog.info('debug-mode', `Saved step ${stepIndex} update to disk: ${found.path}`);
            }
          }
        } catch (diskErr) {
          debugLog.warn('debug-mode', `Failed to save step update to disk: ${diskErr}`);
        }

        // Send marker update to Chrome extension (only for position changes)
        if (hasPosition) {
          try {
            await ensureBridgeServer();
            if (bridgeServer.isConnected) {
              await bridgeServer.send('update_debug_marker', { stepIndex, pctX, pctY });
            }
          } catch {}
        }

        sendJson(res, 200, {
          success: true, stepIndex, pctX, pctY, waitMs,
          verifyClick: (step as any).verifyClick ?? null,
          clickType: (step as any).clickType || 'single',
          filenamePattern: (step as any).filenamePattern,
          maxFiles: (step as any).maxFiles,
          waitTimeoutMs: (step as any).waitTimeoutMs,
          outputVariable: (step as any).outputVariable,
          source: (step as any).source,
          destination: (step as any).destination,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/workflows/:id — get a single workflow document
    const getWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'GET' && getWfMatch) {
      const id = decodeURIComponent(getWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }
        sendJson(res, 200, { workflow: found.workflow, path: found.path, source: found.source });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/workflows/:id — update a workflow document (full replacement)
    const putWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'PUT' && putWfMatch) {
      const id = decodeURIComponent(putWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || !body.workflow) {
          sendJson(res, 400, { error: 'Request body must have a "workflow" object' });
          return;
        }

        // Validate required fields
        const wf = body.workflow;
        if (!wf.version || !wf.id || !wf.name || !Array.isArray(wf.steps)) {
          sendJson(res, 400, { error: 'Workflow missing required fields (version, id, name, steps)' });
          return;
        }

        // Update metadata
        wf.metadata = wf.metadata || {};
        wf.metadata.updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Updated workflow "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true, workflow: wf, path: found.path });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/add-download-steps — append capture_download + move_file steps
    const addDlMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/add-download-steps$/);
    if (req.method === 'POST' && addDlMatch) {
      const id = decodeURIComponent(addDlMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || !Array.isArray(body.files) || body.files.length === 0 || !body.destination) {
          sendJson(res, 400, { error: 'files (string[]) and destination (string) are required' });
          return;
        }

        const files: string[] = body.files;
        const destination: string = body.destination;
        const useVariable: boolean = body.useVariable !== false; // default true

        // Infer filename pattern from file list
        const inferFilenamePattern = (filenames: string[]): string => {
          const extensions = filenames.map(f => {
            const dot = f.lastIndexOf('.');
            return dot >= 0 ? f.slice(dot).toLowerCase() : '';
          }).filter(Boolean);
          if (extensions.length > 0 && extensions.every(e => e === extensions[0])) {
            // All same extension — e.g. ".*\.mp3$"
            return `.*\\${extensions[0]}$`;
          }
          return '.*'; // mixed extensions
        };

        const wf = found.workflow;
        const existingStepCount = wf.steps.length;

        // Create capture_download step
        const captureStep = {
          id: `capture-downloads-${existingStepCount + 1}`,
          type: 'capture_download' as const,
          label: 'Capture downloaded files',
          filenamePattern: inferFilenamePattern(files),
          maxFiles: files.length,
          lookbackMs: 30000,
          waitTimeoutMs: 120000,
          outputVariable: 'downloadedFiles',
        };

        // Create move_file step
        const moveStep = {
          id: `move-downloads-${existingStepCount + 2}`,
          type: 'move_file' as const,
          label: 'Move downloads to destination',
          source: '{{downloadedFiles}}',
          destination: useVariable ? '{{outputDir}}' : destination,
        };

        wf.steps.push(captureStep as any, moveStep as any);

        // Add outputDir variable if using variable mode
        if (useVariable) {
          if (!wf.variables) wf.variables = [];
          // Don't duplicate if already exists
          const existing = (wf.variables as any[]).find((v: any) => v.name === 'outputDir');
          if (!existing) {
            (wf.variables as any[]).push({
              name: 'outputDir',
              description: 'Output directory for downloaded files',
              type: 'string',
              required: false,
              default: destination,
            });
          }
        }

        // Update metadata
        wf.metadata = wf.metadata || {};
        (wf.metadata as any).updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Added download steps to workflow "${id}"`, {
          files: files.length, destination, useVariable,
        });
        sendJson(res, 200, { success: true, workflow: wf });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/rename-variable — rename a variable and update all references
    const renameVarMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/rename-variable$/);
    if (req.method === 'POST' && renameVarMatch) {
      const id = decodeURIComponent(renameVarMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        const oldName = body?.oldName?.trim();
        const newName = body?.newName?.trim();

        if (!oldName || !newName) {
          sendJson(res, 400, { error: 'oldName and newName are required' });
          return;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
          sendJson(res, 400, { error: `Invalid variable name "${newName}". Must start with a letter or underscore and contain only letters, digits, and underscores.` });
          return;
        }

        const wf = found.workflow as any;
        const vars: any[] = wf.variables || [];
        const declIdx = vars.findIndex((v: any) => v.name === oldName);
        if (declIdx < 0) {
          sendJson(res, 404, { error: `Variable "${oldName}" not found in workflow` });
          return;
        }
        if (vars.some((v: any) => v.name === newName)) {
          sendJson(res, 409, { error: `Variable "${newName}" already exists` });
          return;
        }

        // ── Rename the variable everywhere ──
        // 1. Update declaration
        vars[declIdx].name = newName;

        // 2. Build regex for {{oldName}} replacement in string values
        const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\{\\{${escRegex(oldName)}\\}\\}`, 'g');
        const replacement = `{{${newName}}}`;

        // Named variable fields that hold a bare variable name (not interpolated)
        const NAMED_VAR_FIELDS = ['outputVariable', 'overVariable', 'itemVariable', 'indexVariable', 'errorVariable', 'variable'];

        // Recursively walk an object/array and replace {{oldName}} in all string values
        function walkAndReplace(obj: any): any {
          if (typeof obj === 'string') {
            return obj.replace(pattern, replacement);
          }
          if (Array.isArray(obj)) {
            return obj.map(item => walkAndReplace(item));
          }
          if (obj && typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
              obj[key] = walkAndReplace(obj[key]);
            }
          }
          return obj;
        }

        // Walk steps recursively (handles nested loop/try-catch steps)
        function walkSteps(steps: any[]): void {
          for (const step of steps) {
            // Replace {{oldName}} in all string fields of the step
            for (const key of Object.keys(step)) {
              // Skip named variable fields — those get exact match below
              if (NAMED_VAR_FIELDS.includes(key)) continue;
              // Skip nested step arrays — those get recursed separately
              if (key === 'steps' || key === 'trySteps' || key === 'catchSteps') continue;
              step[key] = walkAndReplace(step[key]);
            }

            // Named variable fields: exact string match replace
            for (const field of NAMED_VAR_FIELDS) {
              if (step[field] === oldName) step[field] = newName;
            }

            // Assertion/condition variable references
            for (const condArrayKey of ['preconditions', 'postconditions', 'assertions']) {
              if (Array.isArray(step[condArrayKey])) {
                for (const entry of step[condArrayKey]) {
                  const cond = entry?.condition || entry;
                  if (cond?.type === 'variable_equals' && cond.variable === oldName) {
                    cond.variable = newName;
                  }
                }
              }
            }

            // Recurse into nested steps
            if (Array.isArray(step.steps)) walkSteps(step.steps);
            if (Array.isArray(step.trySteps)) walkSteps(step.trySteps);
            if (Array.isArray(step.catchSteps)) walkSteps(step.catchSteps);
          }
        }

        walkSteps(wf.steps || []);

        // Update metadata
        wf.metadata = wf.metadata || {};
        wf.metadata.updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Renamed variable "${oldName}" → "${newName}" in workflow "${id}"`, {
          path: found.path,
        });
        sendJson(res, 200, { success: true, workflow: wf });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // DELETE /api/workflows/:id — delete a workflow file
    const delWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'DELETE' && delWfMatch) {
      const id = decodeURIComponent(delWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        await unlink(found.path);
        debugLog.info('dashboard', `Deleted workflow "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/autofill — AI-powered variable value generation
    if (req.method === 'POST' && pathname === '/api/autofill') {
      try {
        const body = await readBody(req);
        const { variables, workflowName, site, steps } = body || {};

        if (!variables || !Array.isArray(variables) || variables.length === 0) {
          sendJson(res, 400, { error: 'Must provide a "variables" array' });
          return;
        }

        // Build a concise context string from the workflow steps
        const stepsContext = (steps || [])
          .slice(0, 20) // limit to first 20 steps for token efficiency
          .map((s: any, i: number) => {
            let desc = `${i + 1}. ${s.type || 'action'}`;
            if (s.target?.textContent) desc += ` "${s.target.textContent}"`;
            if (s.target?.description) desc += ` (${s.target.description})`;
            if (s.value !== undefined) desc += ` → value: "${String(s.value).slice(0, 100)}"`;
            return desc;
          })
          .join('\n');

        // Build the variable descriptions
        const varDescriptions = variables
          .map((v: any) => {
            let line = `- ${v.name} (${v.type || 'string'})`;
            if (v.description) line += `: ${v.description}`;
            if (v.default) line += ` [default: ${v.default}]`;
            if (v.generationPrompt) line += ` [AI prompt: ${v.generationPrompt}]`;
            return line;
          })
          .join('\n');

        const prompt = `You are generating sample values for a browser automation workflow's variables. Generate realistic, creative, and contextually appropriate values.

Workflow: "${workflowName || 'Untitled'}"
Target site: ${site || 'unknown'}

Variables to fill:
${varDescriptions}

Workflow steps:
${stepsContext || '(no steps recorded)'}

Rules:
- Generate values that make sense for this specific workflow and target site
- For lyrics/text content, be creative and original — write a short verse or meaningful text
- For titles/names, be descriptive and catchy
- For genres/styles, pick something specific (not "General")
- For tags/hashtags, use relevant, realistic tags
- For URLs, use the target site domain if relevant
- For numbers, use sensible defaults for the context
- NEVER generate values for variables whose names contain "password", "secret", "token", or "key"
- Return ONLY a JSON object mapping variable names to generated values, no explanation

Example output:
{"song_title": "Neon Highways", "lyrics": "Driving fast through neon lights...\\nChasing dreams into the night", "genre": "Synthwave, Electronic"}`;

        // Try to use runPrompt from the LLM service
        const { runPrompt } = await import('./loop/llm-service.js');

        // Use a fast model — try claude-sonnet first, fall back to gpt-4o-mini
        const model = process.env.ANTHROPIC_API_KEY
          ? 'claude-sonnet-4-20250514'
          : process.env.OPENAI_API_KEY
            ? 'gpt-4o-mini'
            : process.env.GROQ_API_KEY
              ? 'llama-3.1-70b-versatile'
              : 'claude-sonnet-4-20250514'; // default, will error if no key

        const llmResponse = await runPrompt(
          [
            { role: 'user', content: prompt },
          ],
          model,
          { maxTokens: 1024, temperature: 0.8 }
        );

        // Parse the JSON from the response
        const content = llmResponse.content.trim();
        // Extract JSON from potential markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        const jsonStr = (jsonMatch[1] || content).trim();
        const generated = JSON.parse(jsonStr);

        debugLog.info('dashboard', 'AI autofill generated values', {
          model,
          variableCount: variables.length,
          generatedKeys: Object.keys(generated),
        });

        sendJson(res, 200, { success: true, values: generated });
      } catch (err) {
        debugLog.error('dashboard', 'AI autofill failed', { error: String(err) });
        sendJson(res, 500, { error: `AI autofill failed: ${(err as Error).message}` });
      }
      return;
    }

    // POST /api/generate-variable — AI generation for a single variable using its custom prompt
    if (req.method === 'POST' && pathname === '/api/generate-variable') {
      try {
        const body = await readBody(req);
        const { variableName, generationPrompt, workflowName, site, variableType } = body || {};

        if (!variableName || !generationPrompt) {
          sendJson(res, 400, { error: 'variableName and generationPrompt are required' });
          return;
        }

        const prompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${variableName}" (type: ${variableType || 'string'})
Workflow: "${workflowName || 'Untitled'}" on ${site || 'unknown site'}

Instructions from the user:
${generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

        const { runPrompt } = await import('./loop/llm-service.js');

        const model = process.env.ANTHROPIC_API_KEY
          ? 'claude-sonnet-4-20250514'
          : process.env.OPENAI_API_KEY
            ? 'gpt-4o-mini'
            : process.env.GROQ_API_KEY
              ? 'llama-3.1-70b-versatile'
              : 'claude-sonnet-4-20250514';

        const llmResponse = await runPrompt(
          [{ role: 'user', content: prompt }],
          model,
          { maxTokens: 2048, temperature: 0.9 }
        );

        const value = llmResponse.content.trim();

        debugLog.info('dashboard', `AI generated value for variable "${variableName}"`, {
          model,
          promptLength: generationPrompt.length,
          valueLength: value.length,
        });

        sendJson(res, 200, { success: true, value });
      } catch (err) {
        debugLog.error('dashboard', 'AI generate-variable failed', { error: String(err) });
        sendJson(res, 500, { error: `AI generation failed: ${(err as Error).message}` });
      }
      return;
    }

    // ── Composition API Routes ──────────────────────────────

    // GET /api/compositions — list all compositions
    if (req.method === 'GET' && pathname === '/api/compositions') {
      try {
        const discovered = await discoverCompositions(workDir);
        const compositions = discovered.map(d => ({
          id: d.composition.id,
          name: d.composition.name,
          description: d.composition.description,
          source: d.source,
          path: d.path,
          nodeCount: d.composition.nodes.length,
          edgeCount: d.composition.edges.length,
          metadata: d.composition.metadata,
        }));
        sendJson(res, 200, { compositions });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/compositions — create a new composition
    if (req.method === 'POST' && pathname === '/api/compositions') {
      try {
        const body = await readBody(req);
        if (!body) {
          sendJson(res, 400, { error: 'Request body is required' });
          return;
        }

        const { name, description } = body;
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendJson(res, 400, { error: 'Please give your pipeline a name' });
          return;
        }

        // Generate ID from name
        const id = name.trim().toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (!id) {
          sendJson(res, 400, { error: 'That name can\'t be used — try using letters and numbers' });
          return;
        }

        // Check for ID collision
        const discovered = await discoverCompositions(workDir);
        if (discovered.some(d => d.composition.id === id)) {
          sendJson(res, 409, { error: 'A pipeline with that name already exists — try a different name' });
          return;
        }

        const composition = {
          version: '1.0' as const,
          id,
          name: name.trim(),
          description: (description || '').trim() || undefined,
          nodes: [] as any[],
          edges: [] as any[],
          metadata: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };

        // Save to global workflows directory (compositions live alongside workflows)
        const globalDir = join(homedir(), '.woodbury', 'workflows');
        await mkdir(globalDir, { recursive: true });
        const compPath = join(globalDir, `${id}.composition.json`);
        await writeFile(compPath, JSON.stringify(composition, null, 2), 'utf-8');
        debugLog.info('dashboard', `Created composition "${id}"`, { path: compPath });
        sendJson(res, 201, { success: true, composition, path: compPath });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/compositions/:id — get a single composition
    const getCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)$/);
    if (req.method === 'GET' && getCompMatch) {
      const id = decodeURIComponent(getCompMatch[1]);
      try {
        const discovered = await discoverCompositions(workDir);
        const found = discovered.find(d => d.composition.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }
        sendJson(res, 200, { composition: found.composition, path: found.path, source: found.source });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/compositions/:id — update a composition (full replace)
    const putCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)$/);
    if (req.method === 'PUT' && putCompMatch) {
      const id = decodeURIComponent(putCompMatch[1]);
      try {
        const discovered = await discoverCompositions(workDir);
        const found = discovered.find(d => d.composition.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || !body.composition) {
          sendJson(res, 400, { error: 'Request body must have a "composition" object' });
          return;
        }

        const comp = body.composition;
        if (!comp.version || !comp.id || !comp.name || !Array.isArray(comp.nodes) || !Array.isArray(comp.edges)) {
          sendJson(res, 400, { error: 'Composition missing required fields (version, id, name, nodes, edges)' });
          return;
        }

        // Update metadata
        comp.metadata = comp.metadata || {};
        comp.metadata.updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(comp, null, 2), 'utf-8');
        debugLog.info('dashboard', `Updated composition "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true, composition: comp, path: found.path });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // DELETE /api/compositions/:id — delete a composition
    const delCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)$/);
    if (req.method === 'DELETE' && delCompMatch) {
      const id = decodeURIComponent(delCompMatch[1]);
      try {
        const discovered = await discoverCompositions(workDir);
        const found = discovered.find(d => d.composition.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }

        await unlink(found.path);
        debugLog.info('dashboard', `Deleted composition "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/compositions/:id/duplicate — clone a composition
    const dupCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/duplicate$/);
    if (req.method === 'POST' && dupCompMatch) {
      const id = decodeURIComponent(dupCompMatch[1]);
      try {
        const discovered = await discoverCompositions(workDir);
        const found = discovered.find(d => d.composition.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }

        const baseName = found.composition.name + ' Copy';
        let newId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        let counter = 1;
        while (discovered.some(d => d.composition.id === newId)) {
          newId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + counter;
          counter++;
        }

        const clone = JSON.parse(JSON.stringify(found.composition));
        clone.id = newId;
        clone.name = counter > 1 ? baseName + ' ' + counter : baseName;
        clone.metadata = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

        const globalDir = join(homedir(), '.woodbury', 'workflows');
        await mkdir(globalDir, { recursive: true });
        const compPath = join(globalDir, `${newId}.composition.json`);
        await writeFile(compPath, JSON.stringify(clone, null, 2), 'utf-8');
        debugLog.info('dashboard', `Duplicated composition "${id}" → "${newId}"`);
        sendJson(res, 201, { success: true, composition: clone, path: compPath });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Composition Execution Routes ─────────────────────────

    // POST /api/compositions/:id/run — execute a composition
    const runCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/run$/);
    if (req.method === 'POST' && runCompMatch) {
      const id = decodeURIComponent(runCompMatch[1]);
      try {
        if (activeCompRun && !activeCompRun.done) {
          sendJson(res, 409, { error: `"${activeCompRun.compositionName}" is already running. Wait for it to finish or stop it first.` });
          return;
        }
        if (activeRun && !activeRun.done) {
          sendJson(res, 409, { error: `Workflow "${activeRun.workflowName}" is running. Wait for it to finish first.` });
          return;
        }

        // Load the composition
        const compDiscovered = await discoverCompositions(workDir);
        const compFound = compDiscovered.find(d => d.composition.id === id);
        if (!compFound) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }
        const comp = compFound.composition;

        if (comp.nodes.length === 0) {
          sendJson(res, 400, { error: 'Add at least one workflow to your pipeline before running it' });
          return;
        }

        // Topological sort
        let executionOrder: string[];
        try {
          executionOrder = topoSort(comp.nodes, comp.edges);
        } catch (cycleErr) {
          sendJson(res, 400, { error: String(cycleErr) });
          return;
        }

        // Resolve all workflows (skip approval gate nodes)
        const wfDiscovered = await discoverWorkflows(workDir);
        const wfMap: Record<string, any> = {};
        for (const node of comp.nodes) {
          if (node.workflowId === '__approval_gate__') continue; // Gate nodes don't need workflows
          const found = wfDiscovered.find(d => d.workflow.id === node.workflowId);
          if (!found) {
            sendJson(res, 400, { error: `The workflow "${node.workflowId}" was deleted or renamed. Remove it from the pipeline and re-add it.` });
            return;
          }
          wfMap[node.id] = found.workflow;
        }

        // Ensure bridge
        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected.' });
          return;
        }

        // Load executeWorkflow
        let executeWorkflow: Function;
        try {
          const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
          const wfRunner = require(wfRunnerPath);
          executeWorkflow = wfRunner.executeWorkflow;
          if (!executeWorkflow) throw new Error('executeWorkflow not found');
        } catch (importErr: any) {
          sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message}` });
          return;
        }

        const body = await readBody(req);
        const initialVariables: Record<string, unknown> = body?.variables || {};

        // Initialize run state
        const abort = new AbortController();
        const nodeStates: Record<string, any> = {};
        for (const node of comp.nodes) {
          if (node.workflowId === '__approval_gate__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__approval_gate__',
              workflowName: node.label || 'Approval Gate',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else {
            const wf = wfMap[node.id];
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: node.workflowId,
              workflowName: wf.name,
              stepsTotal: wf.steps.length,
              stepsCompleted: 0,
              currentStep: '',
            };
          }
        }

        activeCompRun = {
          compositionId: id,
          compositionName: comp.name,
          abort,
          startedAt: Date.now(),
          nodesTotal: comp.nodes.length,
          nodesCompleted: 0,
          currentNodeId: null,
          executionOrder,
          nodeStates,
          done: false,
          success: false,
        };

        // Create run history record
        const compRunId = generateRunId();
        activeCompRun.runId = compRunId;
        await createRunRecord({
          id: compRunId,
          type: 'pipeline',
          sourceId: id,
          name: comp.name,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'running',
          variables: initialVariables,
          nodesTotal: comp.nodes.length,
          nodesCompleted: 0,
          nodeResults: [],
        });

        sendJson(res, 200, { success: true, status: 'running', runId: compRunId, compositionName: comp.name, nodesTotal: comp.nodes.length });

        // Helper: finalize the run history record for a composition run
        async function finalizeCompRunRecord(runId: string, r: typeof activeCompRun, order: string[]): Promise<void> {
          if (!r) return;
          const nodeResults: NodeRunResult[] = order.map(nId => {
            const ns = r.nodeStates[nId];
            return {
              nodeId: nId,
              workflowId: ns.workflowId,
              workflowName: ns.workflowName,
              status: ns.status === 'completed' ? 'completed' as const : ns.status === 'skipped' ? 'skipped' as const : 'failed' as const,
              durationMs: ns.durationMs || 0,
              stepsTotal: ns.stepsTotal,
              stepsCompleted: ns.stepsCompleted,
              error: ns.error,
              outputVariables: ns.outputVariables,
              expectationResults: ns.expectationResults,
              retryAttempts: (ns.retryAttempt && ns.retryAttempt > 1) ? ns.retryAttempt - 1 : undefined,
            };
          });

          const allOutputFiles: string[] = [];
          for (const nr of nodeResults) {
            if (nr.outputVariables) {
              allOutputFiles.push(...extractOutputFiles(nr.outputVariables));
            }
          }

          await updateRunRecord(runId, {
            completedAt: new Date().toISOString(),
            durationMs: r.durationMs,
            status: r.success ? 'completed' : 'failed',
            error: r.error,
            nodesCompleted: r.nodesCompleted,
            nodeResults,
            outputFiles: allOutputFiles.length > 0 ? allOutputFiles : undefined,
          });
        }

        // Execute asynchronously
        const run = activeCompRun;
        const nodeOutputs: Record<string, Record<string, unknown>> = {};

        (async () => {
          try {
            for (const nodeId of executionOrder) {
              if (abort.signal.aborted) break;

              const wf = wfMap[nodeId];
              const node = comp.nodes.find((n: any) => n.id === nodeId);
              const ns = run.nodeStates[nodeId];

              // Skip if already skipped (due to upstream failure)
              if (ns.status === 'skipped') continue;

              // ── Approval Gate Node ──────────────────────────
              if (node?.workflowId === '__approval_gate__' && node.approvalGate) {
                ns.status = 'running';
                ns.currentStep = 'Waiting for approval...';
                run.currentNodeId = nodeId;
                const gateStart = Date.now();

                // Gather all upstream variables for preview
                const upstreamVars: Record<string, unknown> = { ...initialVariables };
                for (const [nid, outputs] of Object.entries(nodeOutputs)) {
                  Object.assign(upstreamVars, outputs);
                }

                debugLog.info('comp-run', `Approval gate "${nodeId}" waiting for user approval`);

                const approved = await createApprovalRequest(
                  nodeId,
                  compRunId,
                  id,
                  comp.name,
                  node.approvalGate,
                  upstreamVars,
                );

                ns.durationMs = Date.now() - gateStart;

                if (approved) {
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  run.nodesCompleted++;
                  // Pass through upstream variables so downstream nodes can use them
                  nodeOutputs[nodeId] = upstreamVars;
                  debugLog.info('comp-run', `Approval gate "${nodeId}" approved`);
                  continue;
                } else {
                  ns.status = 'failed';
                  ns.error = 'Rejected by user';
                  debugLog.info('comp-run', `Approval gate "${nodeId}" rejected`);

                  const onReject = node.approvalGate.onReject || 'stop';
                  if (onReject === 'skip') {
                    ns.status = 'skipped';
                    continue;
                  } else {
                    // 'stop' — skip all downstream and halt
                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }
                    run.done = true;
                    run.success = false;
                    run.error = `Approval gate rejected: ${node.approvalGate.message}`;
                    run.durationMs = Date.now() - run.startedAt;
                    await finalizeCompRunRecord(compRunId, run, executionOrder);
                    return;
                  }
                }
              }

              // Determine failure policy for this node
              const policy = node?.onFailure || { action: 'stop' as const };
              const maxAttempts = (policy.action === 'retry' && policy.retry)
                ? policy.retry.maxAttempts
                : 1;
              const retryDelayMs = (policy.action === 'retry' && policy.retry)
                ? policy.retry.delayMs
                : 1000;
              const backoffMultiplier = (policy.action === 'retry' && policy.retry?.backoffMultiplier)
                ? policy.retry.backoffMultiplier
                : 1;

              run.currentNodeId = nodeId;
              let nodeSuccess = false;

              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (abort.signal.aborted) break;

                ns.status = attempt > 1 ? 'retrying' : 'running';
                ns.retryAttempt = attempt;
                ns.retryMax = maxAttempts;
                ns.stepsCompleted = 0;
                ns.error = undefined;
                ns.expectationResults = undefined;

                // Gather input variables from upstream edges
                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);

                // Merge: edge inputs > initial variables > workflow defaults
                const mergedVars: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                for (const v of (wf.variables || [])) {
                  if (mergedVars[v.name] === undefined && v.default !== undefined) {
                    mergedVars[v.name] = v.default;
                  }
                }

                // Auto-generate variables with AI prompts that still have no value
                const toGenerate = ((wf.variables || []) as any[]).filter(
                  (v: any) => v.generationPrompt && (mergedVars[v.name] === undefined || mergedVars[v.name] === '')
                );
                if (toGenerate.length > 0) {
                  try {
                    const { runPrompt } = await import('./loop/llm-service.js');
                    const model = process.env.ANTHROPIC_API_KEY
                      ? 'claude-sonnet-4-20250514'
                      : process.env.OPENAI_API_KEY
                        ? 'gpt-4o-mini'
                        : process.env.GROQ_API_KEY
                          ? 'llama-3.1-70b-versatile'
                          : 'claude-sonnet-4-20250514';
                    for (const v of toGenerate) {
                      try {
                        const genPrompt = `You are generating a value for a variable in a browser automation workflow.\n\nVariable: "${v.name}" (type: ${v.type || 'string'})\nWorkflow: "${wf.name}" on ${wf.site || 'unknown site'}\n\nInstructions from the user:\n${v.generationPrompt}\n\nRules:\n- Follow the user's instructions precisely\n- Be creative and original for text/lyrics/content\n- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation\n- If the type is a number, return just the number\n- If the type is boolean, return just "true" or "false"\n- For multi-line content (lyrics, paragraphs), use actual newlines`;
                        const llmResponse = await runPrompt(
                          [{ role: 'user', content: genPrompt }],
                          model,
                          { maxTokens: 2048, temperature: 0.9 }
                        );
                        mergedVars[v.name] = llmResponse.content.trim();
                      } catch { /* non-fatal */ }
                    }
                  } catch { /* LLM import failed, skip */ }
                }

                debugLog.info('comp-run', `Executing node "${nodeId}" attempt ${attempt}/${maxAttempts} (workflow: ${wf.name})`, {
                  inputVars: Object.keys(mergedVars),
                });

                try {
                  const result = await executeWorkflow(bridgeServer, wf, mergedVars, {
                    log: (msg: string) => debugLog.info('comp-run', `[${wf.name}] ${msg}`),
                    signal: abort.signal,
                    onProgress: (event: any) => {
                      if (event.type === 'step_start') {
                        ns.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
                      } else if (event.type === 'step_complete') {
                        ns.stepsCompleted = event.index + 1;
                      }
                    },
                  });

                  if (result.success) {
                    // Check expectations — merge workflow-level + node-level
                    const expectations: Expectation[] = [
                      ...((wf.expectations as Expectation[]) || []),
                      ...((node?.expectations as Expectation[]) || []),
                    ];

                    if (expectations.length > 0) {
                      const expResults = await checkExpectations(expectations, result.variables);
                      ns.expectationResults = expResults.map(r => ({
                        description: r.expectation.description || r.detail,
                        passed: r.passed,
                        detail: r.detail,
                      }));

                      const failed = expResults.filter(r => !r.passed);
                      if (failed.length > 0) {
                        const failDescs = failed.map(f => f.detail).join('; ');
                        debugLog.info('comp-run', `Node "${nodeId}" expectations failed (attempt ${attempt}/${maxAttempts})`, { failDescs });

                        if (attempt < maxAttempts) {
                          // Wait before retrying
                          const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                          await new Promise(r => setTimeout(r, delay));
                          continue; // Retry
                        }

                        // Final attempt — expectations still not met, treat as failure
                        ns.status = 'failed';
                        ns.error = `Expectations not met: ${failDescs}`;
                        ns.durationMs = result.durationMs;
                        break;
                      }
                    }

                    // All good — node succeeded
                    ns.status = 'completed';
                    ns.outputVariables = result.variables;
                    ns.durationMs = result.durationMs;
                    ns.stepsCompleted = ns.stepsTotal;
                    nodeOutputs[nodeId] = result.variables;
                    run.nodesCompleted++;
                    nodeSuccess = true;
                    debugLog.info('comp-run', `Node "${nodeId}" completed`, {
                      outputVars: Object.keys(result.variables),
                      durationMs: result.durationMs,
                    });
                    break;
                  } else {
                    // Workflow reported failure
                    if (attempt < maxAttempts) {
                      debugLog.info('comp-run', `Node "${nodeId}" failed (attempt ${attempt}/${maxAttempts}), retrying...`, { error: result.error });
                      const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                      await new Promise(r => setTimeout(r, delay));
                      continue; // Retry
                    }

                    ns.status = 'failed';
                    ns.error = result.error;
                    ns.durationMs = result.durationMs;
                    break;
                  }
                } catch (stepErr: any) {
                  if (attempt < maxAttempts) {
                    debugLog.info('comp-run', `Node "${nodeId}" threw error (attempt ${attempt}/${maxAttempts}), retrying...`, { error: String(stepErr) });
                    const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                    continue; // Retry
                  }

                  ns.status = 'failed';
                  ns.error = String(stepErr);
                  break;
                }
              } // end retry loop

              // Handle node failure based on policy
              if (!nodeSuccess && ns.status === 'failed') {
                if (policy.action === 'skip') {
                  ns.status = 'skipped';
                  debugLog.info('comp-run', `Node "${nodeId}" failed but policy is 'skip', continuing pipeline`);
                  continue; // Don't skip downstream — let them try without this node's outputs
                } else {
                  // 'stop' (default) — skip all downstream and halt
                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) {
                      run.nodeStates[downId].status = 'skipped';
                    }
                  }
                  run.done = true;
                  run.success = false;
                  run.error = `"${wf.name}" failed: ${ns.error}`;
                  run.durationMs = Date.now() - run.startedAt;
                  debugLog.info('comp-run', `Pipeline stopped at node "${nodeId}"`, { error: ns.error });
                  await finalizeCompRunRecord(compRunId, run, executionOrder);
                  return;
                }
              }
            }

            // All nodes completed successfully
            if (!run.done) {
              run.done = true;
              run.success = true;
              run.durationMs = Date.now() - run.startedAt;
              run.currentNodeId = null;
              debugLog.info('comp-run', `Composition "${comp.name}" completed`, {
                nodes: run.nodesCompleted,
                durationMs: run.durationMs,
              });
              await finalizeCompRunRecord(compRunId, run, executionOrder);
            }
          } catch (err) {
            run.done = true;
            run.success = false;
            run.error = String(err);
            run.durationMs = Date.now() - run.startedAt;
            debugLog.error('comp-run', `Composition "${comp.name}" crashed`, { error: String(err) });
            await finalizeCompRunRecord(compRunId, run, executionOrder);
          }
        })();

      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/compositions/run/status — poll composition execution progress
    if (req.method === 'GET' && pathname === '/api/compositions/run/status') {
      if (!activeCompRun) {
        sendJson(res, 200, { active: false });
        return;
      }
      // Include any pending approvals for this run
      const runApprovals: PendingApproval[] = [];
      for (const [, entry] of pendingApprovals) {
        if (activeCompRun.runId && entry.approval.runId === activeCompRun.runId) {
          runApprovals.push(entry.approval);
        }
      }

      sendJson(res, 200, {
        active: !activeCompRun.done,
        done: activeCompRun.done,
        runId: activeCompRun.runId,
        success: activeCompRun.success,
        compositionId: activeCompRun.compositionId,
        compositionName: activeCompRun.compositionName,
        nodesTotal: activeCompRun.nodesTotal,
        nodesCompleted: activeCompRun.nodesCompleted,
        currentNodeId: activeCompRun.currentNodeId,
        executionOrder: activeCompRun.executionOrder,
        nodeStates: activeCompRun.nodeStates,
        pendingApprovals: runApprovals,
        error: activeCompRun.error,
        durationMs: activeCompRun.done ? activeCompRun.durationMs : Date.now() - activeCompRun.startedAt,
      });
      return;
    }

    // POST /api/compositions/run/cancel — abort a running composition
    if (req.method === 'POST' && pathname === '/api/compositions/run/cancel') {
      if (!activeCompRun || activeCompRun.done) {
        sendJson(res, 400, { error: 'Nothing is running right now' });
        return;
      }
      activeCompRun.abort.abort();
      // Reject any pending approvals for this run
      for (const [approvalId, entry] of pendingApprovals) {
        if (activeCompRun.runId && entry.approval.runId === activeCompRun.runId) {
          if (entry.timer) clearTimeout(entry.timer);
          pendingApprovals.delete(approvalId);
          entry.resolve(false);
        }
      }
      // Mark running/retrying node as failed, pending nodes as skipped
      for (const nodeId in activeCompRun.nodeStates) {
        const ns = activeCompRun.nodeStates[nodeId];
        if (ns.status === 'running' || ns.status === 'retrying') ns.status = 'failed';
        if (ns.status === 'pending') ns.status = 'skipped';
      }
      activeCompRun.done = true;
      activeCompRun.success = false;
      activeCompRun.error = 'Cancelled by user';
      activeCompRun.durationMs = Date.now() - activeCompRun.startedAt;

      if (activeCompRun.runId) {
        const nodeResults: NodeRunResult[] = activeCompRun.executionOrder.map(nId => {
          const ns = activeCompRun!.nodeStates[nId];
          return {
            nodeId: nId,
            workflowId: ns.workflowId,
            workflowName: ns.workflowName,
            status: ns.status === 'completed' ? 'completed' as const : ns.status === 'skipped' ? 'skipped' as const : 'failed' as const,
            durationMs: ns.durationMs || 0,
            stepsTotal: ns.stepsTotal,
            stepsCompleted: ns.stepsCompleted,
            error: ns.error,
          };
        });
        updateRunRecord(activeCompRun.runId, {
          completedAt: new Date().toISOString(),
          durationMs: activeCompRun.durationMs,
          status: 'cancelled',
          error: 'Cancelled by user',
          nodesCompleted: activeCompRun.nodesCompleted,
          nodeResults,
        }).catch(() => {});
      }

      sendJson(res, 200, { success: true, message: 'Composition cancelled' });
      return;
    }

    // ── Batch Execution API ──────────────────────────────────

    // POST /api/compositions/:id/batch-run — run a composition in batch mode
    const batchRunMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/batch-run$/);
    if (req.method === 'POST' && batchRunMatch) {
      const id = decodeURIComponent(batchRunMatch[1]);
      try {
        if (activeBatchRun && !activeBatchRun.done) {
          sendJson(res, 409, { error: 'A batch is already running. Wait for it to finish or cancel it.' });
          return;
        }
        if (activeCompRun && !activeCompRun.done) {
          sendJson(res, 409, { error: `Pipeline "${activeCompRun.compositionName}" is running. Wait for it to finish.` });
          return;
        }
        if (activeRun && !activeRun.done) {
          sendJson(res, 409, { error: `Workflow "${activeRun.workflowName}" is running. Wait for it to finish.` });
          return;
        }

        const body = await readBody(req);
        if (!body || !body.batchConfig) {
          sendJson(res, 400, { error: 'batchConfig is required' });
          return;
        }

        const config: BatchConfig = body.batchConfig;
        if (!config.pools || !Array.isArray(config.pools) || config.pools.length === 0) {
          sendJson(res, 400, { error: 'At least one variable pool is required' });
          return;
        }

        // Validate pools
        for (const pool of config.pools) {
          if (!pool.variableName || !Array.isArray(pool.values) || pool.values.length === 0) {
            sendJson(res, 400, { error: `Pool for "${pool.variableName}" needs at least one value` });
            return;
          }
        }

        // Generate iteration variable sets
        const iterations: Record<string, unknown>[] = [];
        const baseVars: Record<string, unknown> = body.variables || {};

        if (config.mode === 'zip') {
          const len = Math.min(...config.pools.map(p => p.values.length));
          for (let i = 0; i < len; i++) {
            const vars: Record<string, unknown> = { ...baseVars };
            for (const pool of config.pools) {
              vars[pool.variableName] = pool.values[i];
            }
            iterations.push(vars);
          }
        } else {
          // Cartesian product
          function cartesian(pools: VariablePool[], idx: number, current: Record<string, unknown>, results: Record<string, unknown>[]) {
            if (idx >= pools.length) {
              results.push({ ...current });
              return;
            }
            for (const val of pools[idx].values) {
              current[pools[idx].variableName] = val;
              cartesian(pools, idx + 1, current, results);
            }
          }
          cartesian(config.pools, 0, { ...baseVars }, iterations);
        }

        if (iterations.length === 0) {
          sendJson(res, 400, { error: 'Batch produces zero iterations' });
          return;
        }
        if (iterations.length > 100) {
          sendJson(res, 400, { error: `Batch would produce ${iterations.length} iterations (max 100). Reduce the number of values.` });
          return;
        }

        // Verify the composition exists
        const compDiscovered = await discoverCompositions(workDir);
        const compFound = compDiscovered.find(d => d.composition.id === id);
        if (!compFound) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }

        const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const abort = new AbortController();

        activeBatchRun = {
          batchId,
          compositionId: id,
          compositionName: compFound.composition.name,
          abort,
          startedAt: Date.now(),
          totalIterations: iterations.length,
          completedIterations: 0,
          failedIterations: 0,
          currentIteration: 0,
          iterationVariables: iterations,
          runIds: [],
          delayBetweenMs: config.delayBetweenMs || 2000,
          done: false,
        };

        sendJson(res, 200, {
          success: true,
          batchId,
          totalIterations: iterations.length,
          compositionName: compFound.composition.name,
        });

        // Execute batch asynchronously
        const batch = activeBatchRun;
        (async () => {
          try {
            for (let i = 0; i < iterations.length; i++) {
              if (abort.signal.aborted) break;

              batch.currentIteration = i;
              const iterVars = iterations[i];

              debugLog.info('batch', `Batch "${batchId}" iteration ${i + 1}/${iterations.length}`, {
                vars: Object.keys(iterVars),
              });

              // Trigger a composition run via the internal run logic
              // We reuse the existing POST /api/compositions/:id/run endpoint internally
              try {
                const runRes = await fetch(`http://127.0.0.1:${(server.address() as any)?.port}/api/compositions/${encodeURIComponent(id)}/run`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ variables: iterVars }),
                });
                const runData = await runRes.json() as { success?: boolean; runId?: string; error?: string };

                if (runData.runId) {
                  batch.runIds.push(runData.runId);

                  // Update the run record to include batchId
                  await updateRunRecord(runData.runId, { batchId });

                  // Wait for the composition run to finish
                  while (activeCompRun && !activeCompRun.done && !abort.signal.aborted) {
                    await new Promise(r => setTimeout(r, 500));
                  }

                  if (activeCompRun?.success) {
                    batch.completedIterations++;
                  } else {
                    batch.failedIterations++;
                  }
                } else {
                  batch.failedIterations++;
                  debugLog.warn('batch', `Batch iteration ${i + 1} failed to start: ${runData.error || 'unknown'}`);
                }
              } catch (iterErr) {
                batch.failedIterations++;
                debugLog.error('batch', `Batch iteration ${i + 1} error: ${iterErr}`);
              }

              // Delay between iterations (skip if last or aborted)
              if (i < iterations.length - 1 && !abort.signal.aborted) {
                await new Promise(r => setTimeout(r, batch.delayBetweenMs));
              }
            }
          } catch (err) {
            batch.error = String(err);
            debugLog.error('batch', `Batch "${batchId}" crashed: ${err}`);
          } finally {
            batch.done = true;
            batch.durationMs = Date.now() - batch.startedAt;
            debugLog.info('batch', `Batch "${batchId}" finished`, {
              completed: batch.completedIterations,
              failed: batch.failedIterations,
              total: batch.totalIterations,
              durationMs: batch.durationMs,
            });
          }
        })();

      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/batch/status — poll batch execution progress
    if (req.method === 'GET' && pathname === '/api/batch/status') {
      if (!activeBatchRun) {
        sendJson(res, 200, { active: false });
        return;
      }
      sendJson(res, 200, {
        active: !activeBatchRun.done,
        done: activeBatchRun.done,
        batchId: activeBatchRun.batchId,
        compositionId: activeBatchRun.compositionId,
        compositionName: activeBatchRun.compositionName,
        totalIterations: activeBatchRun.totalIterations,
        completedIterations: activeBatchRun.completedIterations,
        failedIterations: activeBatchRun.failedIterations,
        currentIteration: activeBatchRun.currentIteration,
        runIds: activeBatchRun.runIds,
        error: activeBatchRun.error,
        durationMs: activeBatchRun.done ? activeBatchRun.durationMs : Date.now() - activeBatchRun.startedAt,
      });
      return;
    }

    // POST /api/batch/cancel — abort a running batch
    if (req.method === 'POST' && pathname === '/api/batch/cancel') {
      if (!activeBatchRun || activeBatchRun.done) {
        sendJson(res, 400, { error: 'No batch is currently running' });
        return;
      }
      activeBatchRun.abort.abort();
      // Also cancel the current composition run if active
      if (activeCompRun && !activeCompRun.done) {
        activeCompRun.abort.abort();
        for (const nodeId in activeCompRun.nodeStates) {
          const ns = activeCompRun.nodeStates[nodeId];
          if (ns.status === 'running' || ns.status === 'retrying') ns.status = 'failed';
          if (ns.status === 'pending') ns.status = 'skipped';
        }
        activeCompRun.done = true;
        activeCompRun.success = false;
        activeCompRun.error = 'Cancelled (batch cancelled)';
        activeCompRun.durationMs = Date.now() - activeCompRun.startedAt;
      }
      // Reject any pending approvals
      for (const [approvalId, entry] of pendingApprovals) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingApprovals.delete(approvalId);
        entry.resolve(false);
      }
      activeBatchRun.done = true;
      activeBatchRun.durationMs = Date.now() - activeBatchRun.startedAt;
      sendJson(res, 200, { success: true, message: 'Batch cancelled' });
      return;
    }

    // ── Approval Gate API ──────────────────────────────────────

    // GET /api/approvals — list all pending approvals
    if (req.method === 'GET' && pathname === '/api/approvals') {
      const approvals: PendingApproval[] = [];
      for (const [, entry] of pendingApprovals) {
        approvals.push(entry.approval);
      }
      sendJson(res, 200, { approvals });
      return;
    }

    // POST /api/approvals/:id/approve — approve a pending gate
    const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (req.method === 'POST' && approveMatch) {
      const approvalId = decodeURIComponent(approveMatch[1]);
      const entry = pendingApprovals.get(approvalId);
      if (!entry) {
        sendJson(res, 404, { error: `Approval "${approvalId}" not found or already resolved` });
        return;
      }
      if (entry.timer) clearTimeout(entry.timer);
      pendingApprovals.delete(approvalId);
      entry.resolve(true);
      debugLog.info('approval', `Approval "${approvalId}" approved by user`);
      sendJson(res, 200, { success: true, approved: true });
      return;
    }

    // POST /api/approvals/:id/reject — reject a pending gate
    const rejectMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (req.method === 'POST' && rejectMatch) {
      const approvalId = decodeURIComponent(rejectMatch[1]);
      const entry = pendingApprovals.get(approvalId);
      if (!entry) {
        sendJson(res, 404, { error: `Approval "${approvalId}" not found or already resolved` });
        return;
      }
      if (entry.timer) clearTimeout(entry.timer);
      pendingApprovals.delete(approvalId);
      entry.resolve(false);
      debugLog.info('approval', `Approval "${approvalId}" rejected by user`);
      sendJson(res, 200, { success: true, approved: false });
      return;
    }

    // ── Schedule API ─────────────────────────────────────────

    // GET /api/schedules — list all schedules
    if (req.method === 'GET' && pathname === '/api/schedules') {
      try {
        const schedules = await loadSchedules();
        sendJson(res, 200, { schedules });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/schedules — create a new schedule
    if (req.method === 'POST' && pathname === '/api/schedules') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body) as Partial<Schedule>;

        if (!data.compositionId || !data.cron) {
          sendJson(res, 400, { error: 'compositionId and cron are required' });
          return;
        }

        // Validate cron format (5 fields)
        const cronParts = data.cron.trim().split(/\s+/);
        if (cronParts.length !== 5) {
          sendJson(res, 400, { error: 'Invalid cron expression — must have 5 fields: minute hour dom month dow' });
          return;
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
          return;
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
      return;
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
          return;
        }
        sendJson(res, 200, { schedule: schedules[idx] });
        return;
      }

      if (req.method === 'PUT') {
        if (idx < 0) {
          sendJson(res, 404, { error: `Schedule "${scheduleId}" not found` });
          return;
        }
        try {
          const body = await readBody(req);
          const updates = JSON.parse(body) as Partial<Schedule>;

          // Apply allowed updates
          if (updates.cron !== undefined) {
            const cronParts = updates.cron.trim().split(/\s+/);
            if (cronParts.length !== 5) {
              sendJson(res, 400, { error: 'Invalid cron expression — must have 5 fields' });
              return;
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
        return;
      }

      if (req.method === 'DELETE') {
        if (idx < 0) {
          sendJson(res, 404, { error: `Schedule "${scheduleId}" not found` });
          return;
        }
        schedules.splice(idx, 1);
        await saveSchedules(schedules);
        debugLog.info('scheduler', `Deleted schedule "${scheduleId}"`);
        sendJson(res, 200, { success: true });
        return;
      }
    }

    // ── Run History API ────────────────────────────────────────

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
      return;
    }

    // DELETE /api/runs — clear all run history
    if (req.method === 'DELETE' && pathname === '/api/runs') {
      try {
        await saveRuns([]);
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
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
            return;
          }
          sendJson(res, 200, { run: found });
        } catch (err) {
          sendJson(res, 500, { error: String(err) });
        }
        return;
      } else if (req.method === 'DELETE') {
        try {
          const deleted = await deleteRunRecord(runId);
          if (!deleted) {
            sendJson(res, 404, { error: `Run "${runId}" not found` });
            return;
          }
          sendJson(res, 200, { success: true });
        } catch (err) {
          sendJson(res, 500, { error: String(err) });
        }
        return;
      }
    }

    // ── Training API Routes ────────────────────────────────

    // GET /api/training/data-summary — scan training data directory
    if (req.method === 'GET' && pathname === '/api/training/data-summary') {
      try {
        const metadataPath = join(TRAINING_DATA_DIR, 'metadata.jsonl');
        const snapshotsDir = join(TRAINING_DATA_DIR, 'snapshots');

        let totalCrops = 0;
        let uniqueGroups = new Set<string>();
        let uniqueSites = new Set<string>();
        let interactedGroups = new Set<string>();
        let hasMetadata = false;
        let hasSnapshots = false;

        try {
          const metaContent = await readFile(metadataPath, 'utf-8');
          hasMetadata = true;
          for (const line of metaContent.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              totalCrops++;
              uniqueGroups.add(entry.group_id || '');
              uniqueSites.add(entry.site_id || '');
              if (entry.interacted) interactedGroups.add(entry.group_id || '');
            } catch {}
          }
        } catch {}

        try {
          await stat(snapshotsDir);
          hasSnapshots = true;
        } catch {}

        sendJson(res, 200, {
          hasMetadata,
          hasSnapshots,
          totalCrops,
          uniqueGroups: uniqueGroups.size,
          uniqueSites: uniqueSites.size,
          interactedGroups: interactedGroups.size,
          dataDir: TRAINING_DATA_DIR,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/training/prepare — run data preparation from snapshots
    if (req.method === 'POST' && pathname === '/api/training/prepare') {
      try {
        if (activeTraining && !activeTraining.done) {
          sendJson(res, 409, { error: 'Training is already in progress' });
          return;
        }

        const body = await readBody(req);
        const source = body?.source || 'viewport';
        const cropsPerElement = body?.cropsPerElement || 10;

        activeTraining = {
          process: null,
          backbone: '',
          epochs: 0,
          currentEpoch: 0,
          totalEpochs: 0,
          loss: 0,
          lr: 0,
          eta_s: 0,
          phase: 'preparing',
          metrics: {},
          bestAuc: 0,
          logs: [],
          done: false,
          success: false,
          outputDir: TRAINING_DATA_DIR,
          startedAt: Date.now(),
        };

        const proc = spawn('python', [
          '-m', 'woobury_models.prepare',
          '--snapshots-dir', join(TRAINING_DATA_DIR, 'snapshots'),
          '--output-dir', TRAINING_DATA_DIR,
          '--source', source,
          '--crops-per-element', String(cropsPerElement),
        ], {
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          cwd: join(homedir(), 'Documents', 'GitHub', 'woobury-models'),
        });

        activeTraining.process = proc;

        proc.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            if (activeTraining && activeTraining.logs.length < 500) {
              activeTraining.logs.push(line);
            }
          }
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            if (activeTraining && activeTraining.logs.length < 500) {
              activeTraining.logs.push(line);
            }
          }
        });

        proc.on('close', (code) => {
          if (activeTraining && activeTraining.phase === 'preparing') {
            activeTraining.done = true;
            activeTraining.success = code === 0;
            activeTraining.phase = code === 0 ? 'complete' : 'error';
            activeTraining.durationMs = Date.now() - activeTraining.startedAt;
            if (code !== 0) {
              activeTraining.error = `Preparation failed with exit code ${code}`;
            }
          }
        });

        sendJson(res, 200, { success: true, status: 'preparing' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/training/start — start model training
    if (req.method === 'POST' && pathname === '/api/training/start') {
      try {
        if ((activeTraining && !activeTraining.done) || (remoteTraining && !remoteTraining.done)) {
          sendJson(res, 409, { error: 'Training is already in progress' });
          return;
        }

        const body = await readBody(req);
        const backbone = body?.backbone || 'mobilenet_v3_small';
        const epochs = body?.epochs || 50;
        const lr = body?.lr || 3e-4;
        const lossType = body?.lossType || 'ntxent';
        const embedDim = body?.embedDim || 64;
        const exportOnnx = body?.exportOnnx !== false;
        const workerId = body?.workerId;

        // ── Remote Worker Dispatch ──
        if (workerId) {
          if (remoteTraining && !remoteTraining.done) {
            sendJson(res, 409, { error: 'Remote training is already in progress' });
            return;
          }
          const workers = await loadWorkers();
          const worker = workers.find(w => w.id === workerId);
          if (!worker) {
            sendJson(res, 404, { error: 'Worker not found' });
            return;
          }

          const jobId = `run-${Date.now()}`;
          const config = {
            job_id: jobId,
            backbone,
            epochs,
            lr,
            loss_type: lossType,
            embed_dim: embedDim,
            export_onnx: exportOnnx,
            source: 'viewport',
            crops_per_element: body?.cropsPerElement || 10,
          };

          // Initialize remote training state
          remoteTraining = {
            worker,
            jobId,
            pollTimer: null,
            eventIndex: 0,
            backbone,
            epochs,
            currentEpoch: 0,
            totalEpochs: epochs,
            loss: 0,
            lr,
            eta_s: 0,
            phase: 'uploading',
            metrics: {},
            bestAuc: 0,
            logs: [`Sending snapshots to ${worker.name} (${worker.host}:${worker.port})...`],
            done: false,
            success: false,
            outputDir: '',
            startedAt: Date.now(),
            embedDim,
            lossType,
          };

          // Tar and send snapshots in background
          const snapshotsDir = join(TRAINING_DATA_DIR, 'snapshots');
          const configJson = JSON.stringify(config);
          const boundary = '----WooburyBoundary' + Date.now();

          // Build multipart body: config + tar.gz data
          const tarProc = spawn('tar', ['czf', '-', '-C', TRAINING_DATA_DIR, 'snapshots']);
          const tarChunks: Buffer[] = [];
          tarProc.stdout.on('data', (chunk: Buffer) => tarChunks.push(chunk));
          tarProc.stderr.on('data', () => {}); // ignore

          tarProc.on('close', (code) => {
            if (code !== 0 || !remoteTraining) {
              if (remoteTraining) {
                remoteTraining.phase = 'error';
                remoteTraining.done = true;
                remoteTraining.error = 'Failed to create tar archive';
              }
              return;
            }

            const tarData = Buffer.concat(tarChunks);
            remoteTraining.logs.push(`Uploading ${(tarData.length / 1024 / 1024).toFixed(1)} MB...`);

            // Build multipart body
            const configPart = Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\nContent-Type: application/json\r\n\r\n${configJson}\r\n`
            );
            const dataPart = Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="snapshots.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`
            );
            const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
            const fullBody = Buffer.concat([configPart, dataPart, tarData, ending]);

            const req = httpRequest({
              hostname: worker.host,
              port: worker.port,
              path: '/jobs',
              method: 'POST',
              timeout: 120000,
              headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': fullBody.length,
              },
            }, (res) => {
              let body = '';
              res.on('data', (chunk: string) => body += chunk);
              res.on('end', () => {
                if (remoteTraining) {
                  remoteTraining.phase = 'preparing';
                  remoteTraining.logs.push('Job accepted by worker, starting preparation...');
                  startRemotePolling();
                }
              });
            });

            req.on('error', (err) => {
              if (remoteTraining) {
                remoteTraining.phase = 'error';
                remoteTraining.done = true;
                remoteTraining.error = `Failed to submit job: ${err.message}`;
              }
            });

            req.write(fullBody);
            req.end();
          });

          sendJson(res, 200, { success: true, outputDir: 'remote', workerId });
          return;
        }

        // ── Local Training ──
        // Create output directory for this run
        const runTs = Date.now();
        const outputDir = join(MODELS_DIR, `run-${runTs}`);
        await mkdir(outputDir, { recursive: true });

        // Write config YAML for this run
        const configContent = [
          'input:',
          '  max_side: 128',
          '  letterbox_to: [128, 128]',
          '  normalize: imagenet_mean_std',
          '',
          'model:',
          `  backbone: ${backbone}`,
          `  embed_dim: ${embedDim}`,
          '  pretrained: true',
          '',
          'loss:',
          `  type: ${lossType}`,
          '  ntxent_temperature: 0.07',
          '  triplet_margin: 0.2',
          '  contrastive_margin: 0.8',
          '',
          'batching:',
          '  scheme: pk',
          '  P: 32',
          '  K: 4',
          '',
          'optimizer:',
          '  name: adamw',
          `  lr: ${lr}`,
          '  weight_decay: 1.0e-4',
          `  epochs: ${epochs}`,
          '  lr_schedule: cosine',
          '  mixed_precision: true',
          '',
          'data:',
          '  train_frac: 0.7',
          '  val_frac: 0.15',
          '  site_holdout: false',
          '  pos_fraction: 0.5',
          '  augmentation_p: 0.3',
          '',
        ].join('\n');

        const configPath = join(outputDir, 'config.yaml');
        await writeFile(configPath, configContent);

        activeTraining = {
          process: null,
          backbone,
          epochs,
          currentEpoch: 0,
          totalEpochs: epochs,
          loss: 0,
          lr,
          eta_s: 0,
          phase: 'training',
          metrics: {},
          bestAuc: 0,
          logs: [],
          done: false,
          success: false,
          outputDir,
          startedAt: Date.now(),
          embedDim,
          lossType,
        };

        const args = [
          '-m', 'woobury_models.train',
          '--json-progress',
          '--config', configPath,
          '--data-dir', TRAINING_DATA_DIR,
          '--output-dir', outputDir,
        ];
        if (exportOnnx) args.push('--export-onnx');

        const proc = spawn('python', args, {
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          cwd: join(homedir(), 'Documents', 'GitHub', 'woobury-models'),
        });

        activeTraining.process = proc;

        // Parse JSON progress from stdout
        let stdoutBuf = '';
        proc.stdout?.on('data', (data: Buffer) => {
          stdoutBuf += data.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';  // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (!activeTraining) continue;

              switch (evt.event) {
                case 'init':
                  activeTraining.trainSamples = evt.train_samples;
                  activeTraining.valSamples = evt.val_samples;
                  activeTraining.groups = evt.groups;
                  activeTraining.device = evt.device;
                  activeTraining.totalEpochs = evt.epochs;
                  break;
                case 'epoch':
                  activeTraining.currentEpoch = evt.epoch;
                  activeTraining.loss = evt.loss;
                  activeTraining.lr = evt.lr;
                  activeTraining.eta_s = evt.eta_s || 0;
                  break;
                case 'validation':
                  activeTraining.metrics = { ...evt };
                  delete (activeTraining.metrics as any).event;
                  delete (activeTraining.metrics as any).epoch;
                  if (evt.best_auc !== undefined) activeTraining.bestAuc = evt.best_auc;
                  break;
                case 'checkpoint':
                  // Just log it
                  break;
                case 'export':
                  activeTraining.phase = evt.phase === 'complete' ? 'complete' : 'exporting';
                  break;
                case 'complete':
                  activeTraining.bestAuc = evt.best_auc || activeTraining.bestAuc;
                  break;
                case 'error':
                  activeTraining.error = evt.message;
                  break;
              }
            } catch {
              // Not JSON — add to logs
              if (activeTraining && activeTraining.logs.length < 500) {
                activeTraining.logs.push(line);
              }
            }
          }
        });

        // Capture stderr as log lines
        proc.stderr?.on('data', (data: Buffer) => {
          if (!activeTraining) return;
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            if (activeTraining.logs.length < 500) {
              activeTraining.logs.push(line);
            }
          }
        });

        proc.on('close', async (code) => {
          if (!activeTraining) return;
          activeTraining.done = true;
          activeTraining.success = code === 0;
          activeTraining.durationMs = Date.now() - activeTraining.startedAt;
          if (code !== 0 && !activeTraining.error) {
            activeTraining.error = `Training process exited with code ${code}`;
          }
          if (activeTraining.phase !== 'error') {
            activeTraining.phase = code === 0 ? 'complete' : 'error';
          }

          // Save run record
          try {
            const runId = generateRunId();
            activeTraining.runId = runId;
            await createRunRecord({
              id: runId,
              type: 'training',
              name: `Train ${backbone} (${epochs} epochs)`,
              status: code === 0 ? 'completed' : 'failed',
              startedAt: new Date(activeTraining.startedAt).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: activeTraining.durationMs,
              stepsCompleted: activeTraining.currentEpoch,
              stepsTotal: activeTraining.totalEpochs,
              error: activeTraining.error,
              metadata: {
                backbone,
                epochs,
                bestAuc: activeTraining.bestAuc,
                outputDir,
                lossType,
                embedDim,
              },
            } as any);
          } catch {}
        });

        sendJson(res, 200, { success: true, outputDir });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/training/status — poll training progress (local or remote)
    if (req.method === 'GET' && pathname === '/api/training/status') {
      // Check remote training first
      if (remoteTraining) {
        sendJson(res, 200, {
          active: !remoteTraining.done,
          done: remoteTraining.done,
          success: remoteTraining.success,
          backbone: remoteTraining.backbone,
          phase: remoteTraining.phase,
          currentEpoch: remoteTraining.currentEpoch,
          totalEpochs: remoteTraining.totalEpochs,
          loss: remoteTraining.loss,
          lr: remoteTraining.lr,
          eta_s: remoteTraining.eta_s,
          metrics: remoteTraining.metrics,
          bestAuc: remoteTraining.bestAuc,
          error: remoteTraining.error,
          outputDir: remoteTraining.outputDir,
          durationMs: remoteTraining.done ? remoteTraining.durationMs : Date.now() - remoteTraining.startedAt,
          trainSamples: remoteTraining.trainSamples,
          valSamples: remoteTraining.valSamples,
          groups: remoteTraining.groups,
          device: remoteTraining.device,
          embedDim: remoteTraining.embedDim,
          lossType: remoteTraining.lossType,
          logs: remoteTraining.logs,
          worker: { id: remoteTraining.worker.id, name: remoteTraining.worker.name, host: remoteTraining.worker.host },
        });
        return;
      }
      if (!activeTraining) {
        sendJson(res, 200, { active: false });
        return;
      }
      sendJson(res, 200, {
        active: !activeTraining.done,
        done: activeTraining.done,
        runId: activeTraining.runId,
        success: activeTraining.success,
        backbone: activeTraining.backbone,
        phase: activeTraining.phase,
        currentEpoch: activeTraining.currentEpoch,
        totalEpochs: activeTraining.totalEpochs,
        loss: activeTraining.loss,
        lr: activeTraining.lr,
        eta_s: activeTraining.eta_s,
        metrics: activeTraining.metrics,
        bestAuc: activeTraining.bestAuc,
        error: activeTraining.error,
        outputDir: activeTraining.outputDir,
        durationMs: activeTraining.done ? activeTraining.durationMs : Date.now() - activeTraining.startedAt,
        trainSamples: activeTraining.trainSamples,
        valSamples: activeTraining.valSamples,
        groups: activeTraining.groups,
        device: activeTraining.device,
        embedDim: activeTraining.embedDim,
        lossType: activeTraining.lossType,
        logs: activeTraining.logs,
      });
      return;
    }

    // POST /api/training/cancel — stop training (local or remote)
    if (req.method === 'POST' && pathname === '/api/training/cancel') {
      // Handle remote cancel
      if (remoteTraining && !remoteTraining.done) {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = httpRequest({
              hostname: remoteTraining!.worker.host,
              port: remoteTraining!.worker.port,
              path: '/jobs/current/cancel',
              method: 'POST',
              timeout: 5000,
            }, () => resolve());
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
          });
        } catch {}
        remoteTraining.done = true;
        remoteTraining.success = false;
        remoteTraining.error = 'Cancelled by user';
        remoteTraining.phase = 'error';
        remoteTraining.durationMs = Date.now() - remoteTraining.startedAt;
        if (remoteTraining.pollTimer) clearInterval(remoteTraining.pollTimer);
        remoteTraining.pollTimer = null;
        sendJson(res, 200, { success: true, message: 'Remote training cancelled' });
        return;
      }
      if (!activeTraining || activeTraining.done) {
        sendJson(res, 400, { error: 'No training is currently running' });
        return;
      }
      if (activeTraining.process) {
        activeTraining.process.kill('SIGTERM');
      }
      activeTraining.done = true;
      activeTraining.success = false;
      activeTraining.error = 'Cancelled by user';
      activeTraining.phase = 'error';
      activeTraining.durationMs = Date.now() - activeTraining.startedAt;
      sendJson(res, 200, { success: true, message: 'Training cancelled' });
      return;
    }

    // ── Worker Management ─────────────────────────────────

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
      return;
    }

    // POST /api/workers — add a worker
    if (req.method === 'POST' && pathname === '/api/workers') {
      try {
        const body = await readBody(req);
        const { name, host, port } = body || {};
        if (!name || !host || !port) {
          sendJson(res, 400, { error: 'name, host, and port are required' });
          return;
        }
        // Validate connectivity
        try {
          await probeWorker(host, port);
        } catch {
          sendJson(res, 400, { error: `Cannot reach worker at ${host}:${port}` });
          return;
        }
        const workers = await loadWorkers();
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
      return;
    }

    // DELETE /api/workers/:id — remove a worker
    if (req.method === 'DELETE' && pathname.startsWith('/api/workers/')) {
      try {
        const workerId = pathname.split('/api/workers/')[1];
        const workers = await loadWorkers();
        const filtered = workers.filter(w => w.id !== workerId);
        if (filtered.length === workers.length) {
          sendJson(res, 404, { error: 'Worker not found' });
          return;
        }
        await saveWorkers(filtered);
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/training/models — list trained models
    if (req.method === 'GET' && pathname === '/api/training/models') {
      try {
        await mkdir(MODELS_DIR, { recursive: true });
        const entries = await readdir(MODELS_DIR);
        const models = [];
        for (const entry of entries) {
          const dir = join(MODELS_DIR, entry);
          try {
            const s = await stat(dir);
            if (!s.isDirectory()) continue;
            // Check for config.yaml and a model file
            const files = await readdir(dir);
            models.push({
              id: entry,
              dir,
              hasConfig: files.includes('config.yaml'),
              hasBestModel: files.includes('best_model.pt'),
              hasFinalModel: files.includes('final_model.pt'),
              hasOnnx: files.includes('encoder.onnx'),
              hasQuantized: files.includes('encoder_quantized.onnx'),
              files,
              createdAt: s.birthtime.toISOString(),
            });
          } catch {}
        }
        sendJson(res, 200, { models });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Static File Serving ─────────────────────────────────
    const filePath =
      pathname === '/' ? '/index.html' : pathname.split('?')[0];
    const fullPath = join(staticDir, filePath);

    try {
      const content = await readFile(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // Try preferred port first, fall back to random if in use
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

  if (verbose) {
    console.log(`[dashboard] Config dashboard at ${dashboardUrl}`);
  }

  // Start remote relay (Firebase RTDB connection)
  let relayHandle: RelayHandle | null = null;
  try {
    relayHandle = await startRemoteRelay(assignedPort, verbose);
    debugLog.info('relay', 'Remote relay started', { connectionUrl: relayHandle.connectionUrl });
  } catch (err) {
    debugLog.info('relay', `Remote relay failed to start: ${String(err)}`);
    if (verbose) console.log(`[dashboard] Remote relay failed: ${err}`);
  }

  return {
    url: dashboardUrl,
    port: assignedPort,
    connectionUrl: relayHandle?.connectionUrl,
    pair: relayHandle ? (code: string) => relayHandle!.pair(code) : undefined,
    isPaired: relayHandle ? () => relayHandle!.isPaired() : undefined,
    close: () => {
      relayHandle?.stop();
      stopScheduler();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
