/**
 * Dashboard Route: Training
 *
 * Handles /api/training/* and /api/workflows/:id/training/* endpoints.
 * Manages model training lifecycle: data preparation, local/remote training,
 * status polling, cancellation, model listing, per-workflow auto-training,
 * and model version registry management.
 */

import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createWriteStream } from 'node:fs';
import type { DashboardContext, RouteHandler } from '../types.js';
import type { ModelVersionEntry, ModelVersionRegistry } from '../../workflow/types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { debugLog } from '../../debug-log.js';
import { discoverWorkflows } from '../../workflow/loader.js';

// ── Constants ────────────────────────────────────────────────
const TRAINING_DATA_DIR = join(homedir(), '.woodbury', 'data', 'training-crops');
const MODELS_DIR = join(homedir(), '.woodbury', 'data', 'models');
const WORKER_CONFIG_FILE = join(homedir(), '.woodbury', 'worker-config.json');
const WORKERS_FILE = join(homedir(), '.woodbury', 'data', 'workers.json');

// ── Worker settings type ────────────────────────────────────
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

// ── Worker config type ──────────────────────────────────────
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

async function loadWorkers(): Promise<WorkerConfig[]> {
  try {
    const content = await readFile(WORKERS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch { return []; }
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

// ── Run record helpers (shared with runs.ts but needed for training completion) ──

const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 500;
let runsCache: any[] | null = null;

async function loadRuns(): Promise<any[]> {
  if (runsCache !== null) return runsCache;
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const content = await readFile(RUNS_FILE, 'utf-8');
    runsCache = JSON.parse(content);
  } catch {
    runsCache = [];
  }
  return runsCache!;
}

async function saveRuns(runs: any[]): Promise<void> {
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

async function createRunRecord(record: any): Promise<void> {
  const runs = await loadRuns();
  runs.push(record);
  await saveRuns(runs);
}

// ── Remote training state ────────────────────────────────────

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
    case 'early_stop':
      remoteTraining.totalEpochs = evt.epoch;
      remoteTraining.logs = remoteTraining.logs || [];
      remoteTraining.logs.push(`Early stopped at epoch ${evt.epoch} (no improvement for ${evt.patience} epochs)`);
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

// ── Per-Workflow Auto-Training ──────────────────────────────

interface WorkflowTrainingConfig {
  backbone: string;
  epochs: number;
  embedDim: number;
  sources?: string[];  // ['recording', 'execution', 'debug'] — undefined = all
}

const defaultTrainingConfig: WorkflowTrainingConfig = {
  backbone: 'efficientnet_b0',
  epochs: 150,
  embedDim: 128,
};

// ── SemVer Helpers ──────────────────────────────────────────────

interface SemVer { major: number; minor: number; patch: number; }

function parseSemVer(v: string): SemVer {
  const [major, minor, patch] = v.split('.').map(Number);
  return { major: major || 0, minor: minor || 0, patch: patch || 0 };
}

function semVerToString(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function getNextVersion(
  existingVersions: string[],
  newBackbone: string,
  activeBackbone?: string,
): string {
  if (existingVersions.length === 0) return '1.0.0';
  const sorted = [...existingVersions].sort(compareSemVer);
  const latest = parseSemVer(sorted[sorted.length - 1]);

  if (activeBackbone && newBackbone !== activeBackbone) {
    // Backbone change = major bump
    return semVerToString({ major: latest.major + 1, minor: 0, patch: 0 });
  }
  // Normal retrain = minor bump
  return semVerToString({ major: latest.major, minor: latest.minor + 1, patch: 0 });
}

// ── Version Registry Helpers ──────────────────────────────────

async function readVersionRegistry(modelDir: string): Promise<ModelVersionRegistry | null> {
  const registryPath = join(modelDir, 'versions.json');
  try {
    const content = await readFile(registryPath, 'utf8');
    return JSON.parse(content) as ModelVersionRegistry;
  } catch {
    return null;
  }
}

async function writeVersionRegistry(modelDir: string, registry: ModelVersionRegistry): Promise<void> {
  await mkdir(modelDir, { recursive: true });
  const registryPath = join(modelDir, 'versions.json');
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Migrate an existing unversioned model (flat encoder.onnx) into v1.0.0/ directory.
 * Called on first retrain of a workflow that was trained before versioning existed.
 */
async function migrateUnversionedModel(
  modelDir: string,
  workflowMetadata: any,
): Promise<ModelVersionRegistry | null> {
  const legacyOnnx = join(modelDir, 'encoder.onnx');
  try {
    await stat(legacyOnnx);
  } catch {
    return null; // No existing model to migrate
  }

  // Create v1.0.0 directory and move files
  const v1Dir = join(modelDir, 'v1.0.0');
  await mkdir(v1Dir, { recursive: true });

  const filesToMove = ['encoder.onnx', 'best_model.pt', 'final_model.pt', 'config.yaml', 'encoder_quant.onnx'];
  const { copyFile: cpFile } = await import('node:fs/promises');
  for (const f of filesToMove) {
    const src = join(modelDir, f);
    const dst = join(v1Dir, f);
    try {
      await stat(src);
      await cpFile(src, dst);
      await unlink(src);
    } catch { /* file doesn't exist, skip */ }
  }

  const tr = workflowMetadata?.trainingRun;
  const registry: ModelVersionRegistry = {
    activeVersion: '1.0.0',
    versions: [{
      version: '1.0.0',
      bestAuc: tr?.bestAuc || 0,
      epochs: tr?.epochs || 0,
      backbone: 'efficientnet_b0',
      embedDim: 64,
      trainedAt: tr?.completedAt || new Date().toISOString(),
      durationMs: 0,
      worker: tr?.worker,
      status: 'complete',
      promotedOverActive: true,
      modelPath: join(v1Dir, 'encoder.onnx'),
    }],
  };

  await writeVersionRegistry(modelDir, registry);
  debugLog.info('workflow-train', `Migrated legacy model to v1.0.0`, { modelDir });
  return registry;
}

interface WorkflowTraining {
  workflowId: string;
  workflowFilePath: string;
  phase: 'preparing' | 'training' | 'exporting' | 'complete' | 'error';
  process: ChildProcess | null;
  currentEpoch: number;
  totalEpochs: number;
  loss: number;
  bestAuc: number;
  error?: string;
  startedAt: number;
  logs: string[];
  modelDir: string;
  config: WorkflowTrainingConfig;
  /** Per-version output directory (e.g. model/v1.2.0/) */
  versionDir?: string;
  /** Version being trained */
  nextVersion?: string;
  // Remote worker fields (when dispatching to a worker)
  worker?: WorkerConfig;
  remoteJobId?: string;
  remotePollTimer?: ReturnType<typeof setInterval>;
  remoteEventIndex?: number;
}

const workflowTrainings = new Map<string, WorkflowTraining>();

/**
 * Find the first available idle remote worker.
 * Returns null if no workers are configured or all are busy/unreachable.
 */
async function findIdleWorker(): Promise<WorkerConfig | null> {
  const workers = await loadWorkers();
  for (const w of workers) {
    try {
      const health = await probeWorker(w.host, w.port, 3000);
      if (health.status === 'idle') return w;
    } catch { /* worker unreachable, try next */ }
  }
  return null;
}

/**
 * Dispatch training to a remote worker and wait for completion.
 * Tars the workflow's snapshots, uploads to the worker, polls for progress,
 * and pulls artifacts back to the local model directory.
 */
async function trainForWorkflowRemote(
  training: WorkflowTraining,
  worker: WorkerConfig,
  snapshotsDir: string,
  modelDir: string,
): Promise<void> {
  training.phase = 'preparing';
  training.worker = worker;

  const jobId = `wf-${training.workflowId}-${Date.now()}`;
  training.remoteJobId = jobId;
  training.remoteEventIndex = 0;

  const config = {
    job_id: jobId,
    backbone: training.config.backbone,
    epochs: training.config.epochs,
    lr: 3e-4,
    loss_type: 'ntxent',
    embed_dim: training.config.embedDim,
    export_onnx: true,
    source: 'viewport',
    crops_per_element: 15,
    interacted_only: true,
    patience: 15,
    min_epochs: 10,
    val_every: 5,
    augmentation_p: 0.3,
    max_apply: 3,
  };

  // Phase 1: Tar snapshots and upload to worker
  training.logs.push(`Packaging snapshots from ${snapshotsDir}...`);

  const tarData = await new Promise<Buffer>((resolve, reject) => {
    // Tar the snapshots directory — use the parent dir as -C context
    const parentDir = join(snapshotsDir, '..');
    const tarProc = spawn('tar', ['czf', '-', '-C', parentDir, 'snapshots']);
    const chunks: Buffer[] = [];
    tarProc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    tarProc.stderr.on('data', () => {});
    tarProc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar failed with code ${code}`));
    });
  });

  training.logs.push(`Uploading ${(tarData.length / 1024 / 1024).toFixed(1)} MB to ${worker.name}...`);

  // Build multipart body
  const boundary = '----WooburyBoundary' + Date.now();
  const configJson = JSON.stringify(config);
  const configPart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\nContent-Type: application/json\r\n\r\n${configJson}\r\n`
  );
  const dataPart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="snapshots.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fullBody = Buffer.concat([configPart, dataPart, tarData, ending]);

  // Submit job to worker
  await new Promise<void>((resolve, reject) => {
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
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200) {
            training.logs.push('Job accepted by worker, starting preparation...');
            resolve();
          } else {
            reject(new Error(data.error || `Worker returned ${res.statusCode}`));
          }
        } catch { resolve(); /* assume success if body isn't JSON */ }
      });
    });
    req.on('error', (err) => reject(new Error(`Failed to submit job: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.write(fullBody);
    req.end();
  });

  // Phase 2: Poll worker for training progress until done
  training.phase = 'preparing';

  await new Promise<void>((resolve, reject) => {
    const pollInterval = setInterval(async () => {
      try {
        // Fetch events incrementally
        const eventsData: any = await new Promise((res, rej) => {
          const req = httpRequest({
            hostname: worker.host,
            port: worker.port,
            path: `/jobs/current/events?since=${training.remoteEventIndex || 0}`,
            method: 'GET',
            timeout: 5000,
          }, (resp) => {
            let body = '';
            resp.on('data', (chunk: string) => body += chunk);
            resp.on('end', () => { try { res(JSON.parse(body)); } catch { rej(new Error('bad json')); } });
          });
          req.on('error', rej);
          req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
          req.end();
        });

        // Process training events
        for (const evt of (eventsData.events || [])) {
          switch (evt.event) {
            case 'init':
              training.totalEpochs = evt.epochs;
              break;
            case 'epoch':
              training.currentEpoch = evt.epoch;
              training.loss = evt.loss;
              training.phase = 'training';
              break;
            case 'validation':
              if (evt.best_auc !== undefined) training.bestAuc = evt.best_auc;
              break;
            case 'export':
              training.phase = evt.phase === 'complete' ? 'exporting' : 'exporting';
              break;
            case 'complete':
              training.bestAuc = evt.best_auc || training.bestAuc;
              break;
            case 'early_stop':
              training.totalEpochs = evt.epoch;
              break;
            case 'error':
              training.error = evt.message;
              break;
          }
        }
        training.remoteEventIndex = eventsData.total || training.remoteEventIndex;

        // Fetch full status for phase/done
        const statusData: any = await new Promise((res, rej) => {
          const req = httpRequest({
            hostname: worker.host,
            port: worker.port,
            path: '/jobs/current',
            method: 'GET',
            timeout: 5000,
          }, (resp) => {
            let body = '';
            resp.on('data', (chunk: string) => body += chunk);
            resp.on('end', () => { try { res(JSON.parse(body)); } catch { rej(new Error('bad json')); } });
          });
          req.on('error', rej);
          req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
          req.end();
        });

        if (statusData.phase) training.phase = statusData.phase as any;
        if (statusData.logs) training.logs = statusData.logs;

        if (statusData.done) {
          clearInterval(pollInterval);
          training.remotePollTimer = undefined;

          if (statusData.success && statusData.has_artifacts) {
            // Phase 3: Pull artifacts to workflow model dir
            training.logs.push('Downloading trained model from worker...');
            try {
              await pullWorkflowArtifacts(worker, modelDir);
              training.logs.push(`Model saved to ${modelDir}`);
              resolve();
            } catch (err) {
              reject(new Error(`Failed to pull artifacts: ${err instanceof Error ? err.message : String(err)}`));
            }
          } else {
            reject(new Error(statusData.error || 'Remote training failed'));
          }
        }
      } catch (err) {
        // Worker temporarily unreachable — keep retrying
        training.logs.push(`Warning: Worker poll failed, retrying...`);
      }
    }, 1500);

    training.remotePollTimer = pollInterval;
  });
}

/**
 * Pull trained model artifacts from a remote worker to a local directory.
 */
async function pullWorkflowArtifacts(
  worker: WorkerConfig,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  return new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      hostname: worker.host,
      port: worker.port,
      path: '/jobs/current/artifacts',
      method: 'GET',
      timeout: 60000,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Artifact download failed: ${res.statusCode}`));
        return;
      }
      const tarPath = join(targetDir, 'artifacts.tar.gz');
      const ws = createWriteStream(tarPath);
      res.pipe(ws);
      ws.on('finish', () => {
        const tar = spawn('tar', ['xzf', tarPath, '-C', targetDir]);
        tar.on('close', (code) => {
          unlink(tarPath).catch(() => {});
          if (code === 0) resolve();
          else reject(new Error(`tar extract failed with code ${code}`));
        });
      });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Backup a workflow file before modifying it.
 */
async function backupWorkflowFile(filePath: string): Promise<void> {
  try {
    const { copyFile: cpFile } = await import('node:fs/promises');
    await cpFile(filePath, filePath + '.bak');
  } catch { /* best-effort */ }
}

/**
 * Train a model for a specific workflow recording.
 * Prefers remote workers when available, falls back to local training.
 * Runs in background: prepare data -> train -> export ONNX -> update workflow JSON.
 */
async function trainForWorkflow(
  workflowId: string,
  site: string,
  workflowFilePath: string,
  trainingConfig: Partial<WorkflowTrainingConfig> | undefined,
  ctx: DashboardContext,
): Promise<void> {
  const workflowDataDir = join(homedir(), '.woodbury', 'data', 'workflows', workflowId);
  const snapshotsDir = join(workflowDataDir, 'snapshots');
  const modelDir = join(workflowDataDir, 'model');
  const cropsDir = join(workflowDataDir, 'crops');

  const cfg: WorkflowTrainingConfig = { ...defaultTrainingConfig, ...trainingConfig };

  // Create tracking state
  const training: WorkflowTraining = {
    workflowId,
    workflowFilePath,
    phase: 'preparing',
    process: null,
    currentEpoch: 0,
    totalEpochs: cfg.epochs,
    loss: 0,
    bestAuc: 0,
    startedAt: Date.now(),
    logs: [],
    modelDir,
    config: cfg,
  };
  workflowTrainings.set(workflowId, training);

  // Read or create version registry
  let registry = await readVersionRegistry(modelDir);
  if (!registry) {
    // Check for legacy unversioned model and migrate
    try {
      const wfContent = await readFile(workflowFilePath, 'utf8');
      const wfData = JSON.parse(wfContent);
      registry = await migrateUnversionedModel(modelDir, wfData.metadata);
    } catch { /* no workflow file or parse error — start fresh */ }
  }

  // Determine next version
  const existingVersions = registry ? registry.versions.map(v => v.version) : [];
  const activeEntry = registry?.versions.find(v => v.version === registry!.activeVersion) || null;
  const nextVersion = getNextVersion(existingVersions, cfg.backbone, activeEntry?.backbone);

  // Create versioned output directory
  const versionDir = join(modelDir, `v${nextVersion}`);
  training.versionDir = versionDir;
  training.nextVersion = nextVersion;

  try {
    // Wait briefly for recorder's copySnapshotsToWorkflowDir to finish
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if snapshots exist
    try {
      await stat(snapshotsDir);
    } catch {
      training.phase = 'error';
      training.error = 'No training snapshots found for this workflow';
      debugLog.info('workflow-train', `No snapshots for ${workflowId}`);
      return;
    }

    await mkdir(cropsDir, { recursive: true });
    await mkdir(versionDir, { recursive: true });

    debugLog.info('workflow-train', `Training v${nextVersion} for ${workflowId}`, { versionDir });

    // Try remote worker first — prefer GPU-equipped machines over local CPU training
    const worker = await findIdleWorker();
    if (worker) {
      debugLog.info('workflow-train', `Dispatching training for ${workflowId} to worker ${worker.name} (${worker.host}:${worker.port})`);
      training.logs.push(`Dispatching to worker: ${worker.name} (${worker.host}:${worker.port})`);
      await trainForWorkflowRemote(training, worker, snapshotsDir, versionDir);
    } else {
      // No remote workers available — train locally
      debugLog.info('workflow-train', `No remote workers available, training locally for ${workflowId}`);
      training.logs.push('No remote workers available, training locally');
      await trainForWorkflowLocal(training, snapshotsDir, cropsDir, versionDir, ctx);
    }

    // Phase 3: Validate ONNX exists in version directory
    const onnxPath = join(versionDir, 'encoder.onnx');
    try {
      await stat(onnxPath);
    } catch {
      // Remote artifacts may place encoder.onnx in a subdirectory — check common locations
      const altPaths = [
        join(versionDir, 'output', 'encoder.onnx'),
        join(versionDir, 'checkpoints', 'encoder.onnx'),
      ];
      let found = false;
      for (const alt of altPaths) {
        try {
          await stat(alt);
          const { copyFile: cpFile } = await import('node:fs/promises');
          await cpFile(alt, onnxPath);
          found = true;
          break;
        } catch { /* try next */ }
      }
      if (!found) {
        throw new Error('Training completed but encoder.onnx not found');
      }
    }

    // Phase 4: Quality gate — compare new AUC against active version
    const activeAuc = activeEntry?.bestAuc ?? 0;
    const newAuc = training.bestAuc;
    const promoted = newAuc >= activeAuc; // >= so first train always promotes

    // Update version registry
    const newEntry: ModelVersionEntry = {
      version: nextVersion,
      bestAuc: newAuc,
      epochs: training.totalEpochs,
      backbone: cfg.backbone,
      embedDim: cfg.embedDim,
      trainedAt: new Date().toISOString(),
      durationMs: Date.now() - training.startedAt,
      worker: training.worker?.name,
      status: 'complete',
      promotedOverActive: promoted,
      modelPath: onnxPath,
    };

    if (!registry) {
      registry = { activeVersion: nextVersion, versions: [newEntry] };
    } else {
      registry.versions.push(newEntry);
      if (promoted) {
        registry.activeVersion = nextVersion;
      }
    }
    await writeVersionRegistry(modelDir, registry);

    // Determine which model path to set as active
    const activeVersion = registry.activeVersion;
    const activeModelEntry = registry.versions.find(v => v.version === activeVersion)!;

    training.phase = 'complete';
    debugLog.info('workflow-train', `Training complete for ${workflowId}`, {
      version: nextVersion,
      bestAuc: newAuc,
      promoted,
      activeVersion,
      modelPath: activeModelEntry.modelPath,
      remote: !!training.worker,
    });

    // Update the workflow JSON file
    try {
      const wfContent = await readFile(workflowFilePath, 'utf8');
      const wf = JSON.parse(wfContent);
      wf.metadata.modelPath = activeModelEntry.modelPath;
      wf.metadata.modelVersion = activeVersion;
      wf.metadata.trainingStatus = 'complete';
      wf.metadata.trainingRun = {
        startedAt: new Date(training.startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        bestAuc: newAuc,
        epochs: training.totalEpochs,
        version: nextVersion,
        promoted,
        ...(training.worker ? { worker: training.worker.name } : {}),
      };
      await backupWorkflowFile(workflowFilePath);
      await writeFile(workflowFilePath, JSON.stringify(wf, null, 2));
      debugLog.info('workflow-train', `Updated workflow JSON: ${workflowFilePath}`);
    } catch (err) {
      debugLog.info('workflow-train', `Failed to update workflow JSON: ${String(err)}`);
    }

  } catch (err) {
    training.phase = 'error';
    training.error = err instanceof Error ? err.message : String(err);
    debugLog.info('workflow-train', `Training failed for ${workflowId}: ${training.error}`);

    // Clean up remote poll timer if still running
    if (training.remotePollTimer) {
      clearInterval(training.remotePollTimer);
      training.remotePollTimer = undefined;
    }

    // Record failed version in registry
    if (registry) {
      registry.versions.push({
        version: nextVersion,
        bestAuc: training.bestAuc,
        epochs: training.totalEpochs,
        backbone: cfg.backbone,
        embedDim: cfg.embedDim,
        trainedAt: new Date().toISOString(),
        durationMs: Date.now() - training.startedAt,
        worker: training.worker?.name,
        status: 'failed',
        promotedOverActive: false,
        modelPath: join(versionDir, 'encoder.onnx'),
      });
      await writeVersionRegistry(modelDir, registry).catch(() => {});
    }

    // Update workflow JSON with failure status
    try {
      const wfContent = await readFile(workflowFilePath, 'utf8');
      const wf = JSON.parse(wfContent);
      wf.metadata.trainingStatus = 'failed';
      wf.metadata.trainingRun = {
        startedAt: new Date(training.startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        error: training.error,
        version: nextVersion,
        promoted: false,
        ...(training.worker ? { worker: training.worker.name } : {}),
      };
      await writeFile(workflowFilePath, JSON.stringify(wf, null, 2));
    } catch { /* best-effort */ }
  }
}

/**
 * Run training locally (prepare data -> train model -> export ONNX).
 * Extracted to allow trainForWorkflow to choose between local and remote.
 */
async function trainForWorkflowLocal(
  training: WorkflowTraining,
  snapshotsDir: string,
  cropsDir: string,
  modelDir: string,
  ctx: DashboardContext,
): Promise<void> {
    const modelsCwd = await resolveModelsCwd(ctx);
    const pythonCmd = await resolvePythonCmd(ctx);

    // Phase 1: Prepare training data from snapshots
    debugLog.info('workflow-train', `Preparing training data for ${training.workflowId}`);
    training.phase = 'preparing';

    await new Promise<void>((resolve, reject) => {
      const spawnOpts: any = {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      };
      if (modelsCwd) spawnOpts.cwd = modelsCwd;

      const prepareArgs = [
        '-m', 'woobury_models.prepare',
        '--snapshots-dir', snapshotsDir,
        '--output-dir', cropsDir,
        '--source', 'viewport',
        '--crops-per-element', '15',
        '--interacted-only',
      ];
      // Add source filtering if specified (e.g. --sources recording debug)
      const cfgSources = training.config.sources;
      if (cfgSources && cfgSources.length > 0 && cfgSources.length < 3) {
        prepareArgs.push('--sources', ...cfgSources);
      }
      const proc = spawn(pythonCmd, prepareArgs, spawnOpts);

      training.process = proc;

      proc.stdout?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line && training.logs.length < 200) training.logs.push(line);
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line && training.logs.length < 200) training.logs.push(line);
      });

      proc.on('close', (code) => {
        training.process = null;
        if (code === 0) resolve();
        else reject(new Error(`Prepare failed (exit code ${code})`));
      });
    });

    // Phase 2: Train the model
    debugLog.info('workflow-train', `Starting training for ${training.workflowId}`);
    training.phase = 'training';

    const configContent = [
      'input:',
      '  max_side: 224',
      '  letterbox_to: [224, 224]',
      '  normalize: imagenet_mean_std',
      '',
      'model:',
      `  backbone: ${training.config.backbone}`,
      `  embed_dim: ${training.config.embedDim}`,
      '  pretrained: true',
      '',
      'loss:',
      '  type: ntxent',
      '  ntxent_temperature: 0.05',
      '',
      'batching:',
      '  scheme: pk',
      '  P: 32',
      '  K: 4',
      '',
      'optimizer:',
      '  name: adamw',
      '  lr: 3.0e-4',
      '  weight_decay: 1.0e-4',
      `  epochs: ${training.config.epochs}`,
      '  lr_schedule: cosine',
      '  mixed_precision: true',
      '',
      'early_stopping:',
      '  patience: 15',
      '  min_epochs: 10',
      '',
      'evaluation:',
      '  metrics: [roc_auc, pr_auc, eer, tar_at_fmr]',
      '  fmr_targets: [0.001, 0.0001]',
      '  val_every: 5',
      '',
      'data:',
      '  train_frac: 0.7',
      '  val_frac: 0.15',
      '  site_holdout: false',
      '  pos_fraction: 0.5',
      '  augmentation_p: 0.3',
      '  max_apply: 3',
      '',
    ].join('\n');

    const configPath = join(modelDir, 'config.yaml');
    await writeFile(configPath, configContent);

    await new Promise<void>((resolve, reject) => {
      const trainSpawnOpts: any = {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      };
      if (modelsCwd) trainSpawnOpts.cwd = modelsCwd;

      const proc = spawn(pythonCmd, [
        '-m', 'woobury_models.train',
        '--json-progress',
        '--config', configPath,
        '--data-dir', cropsDir,
        '--output-dir', modelDir,
        '--export-onnx',
      ], trainSpawnOpts);

      training.process = proc;

      let stdoutBuf = '';
      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            switch (evt.event) {
              case 'init':
                training.totalEpochs = evt.epochs;
                break;
              case 'epoch':
                training.currentEpoch = evt.epoch;
                training.loss = evt.loss;
                break;
              case 'validation':
                if (evt.best_auc !== undefined) training.bestAuc = evt.best_auc;
                break;
              case 'export':
                training.phase = evt.phase === 'complete' ? 'complete' : 'exporting';
                break;
              case 'complete':
                training.bestAuc = evt.best_auc || training.bestAuc;
                break;
              case 'early_stop':
                training.totalEpochs = evt.epoch;
                break;
              case 'error':
                training.error = evt.message;
                break;
            }
          } catch {
            if (training.logs.length < 200) training.logs.push(line);
          }
        }
      });

      proc.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line && training.logs.length < 200) training.logs.push(line);
      });

      proc.on('close', (code) => {
        training.process = null;
        if (code === 0) resolve();
        else reject(new Error(`Training failed (exit code ${code})`));
      });
    });
}

// ── Route Handler ────────────────────────────────────────────

export const handleTrainingRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { workDir } = ctx;

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
    return true;
  }

  // POST /api/training/prepare — run data preparation from snapshots
  if (req.method === 'POST' && pathname === '/api/training/prepare') {
    try {
      if (ctx.activeTraining && !ctx.activeTraining.done) {
        sendJson(res, 409, { error: 'Training is already in progress' });
        return true;
      }

      const body = await readBody(req);
      const source = body?.source || 'viewport';
      const cropsPerElement = body?.cropsPerElement || 10;

      ctx.activeTraining = {
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

      const prepModelsCwd = await resolveModelsCwd(ctx);
      const prepPythonCmd = await resolvePythonCmd(ctx);
      const prepSpawnOpts: any = {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      };
      if (prepModelsCwd) prepSpawnOpts.cwd = prepModelsCwd;

      const proc = spawn(prepPythonCmd, [
        '-m', 'woobury_models.prepare',
        '--snapshots-dir', join(TRAINING_DATA_DIR, 'snapshots'),
        '--output-dir', TRAINING_DATA_DIR,
        '--source', source,
        '--crops-per-element', String(cropsPerElement),
        '--interacted-only',
      ], prepSpawnOpts);

      ctx.activeTraining.process = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          if (ctx.activeTraining && ctx.activeTraining.logs.length < 500) {
            ctx.activeTraining.logs.push(line);
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          if (ctx.activeTraining && ctx.activeTraining.logs.length < 500) {
            ctx.activeTraining.logs.push(line);
          }
        }
      });

      proc.on('close', (code) => {
        if (ctx.activeTraining && ctx.activeTraining.phase === 'preparing') {
          ctx.activeTraining.done = true;
          ctx.activeTraining.success = code === 0;
          ctx.activeTraining.phase = code === 0 ? 'complete' : 'error';
          ctx.activeTraining.durationMs = Date.now() - ctx.activeTraining.startedAt;
          if (code !== 0) {
            ctx.activeTraining.error = `Preparation failed with exit code ${code}`;
          }
        }
      });

      sendJson(res, 200, { success: true, status: 'preparing' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/training/start — start model training
  if (req.method === 'POST' && pathname === '/api/training/start') {
    try {
      if ((ctx.activeTraining && !ctx.activeTraining.done) || (remoteTraining && !remoteTraining.done)) {
        sendJson(res, 409, { error: 'Training is already in progress' });
        return true;
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
          return true;
        }
        const workers = await loadWorkers();
        const worker = workers.find(w => w.id === workerId);
        if (!worker) {
          sendJson(res, 404, { error: 'Worker not found' });
          return true;
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
          interacted_only: true,
          patience: 15,
          min_epochs: 10,
          val_every: 5,
          augmentation_p: 0.3,
          max_apply: 3,
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
        return true;
      }

      // ── Local Training ──
      // Create output directory for this run
      const runTs = Date.now();
      const outputDir = join(MODELS_DIR, `run-${runTs}`);
      await mkdir(outputDir, { recursive: true });

      // Write config YAML for this run
      const configContent = [
        'input:',
        '  max_side: 224',
        '  letterbox_to: [224, 224]',
        '  normalize: imagenet_mean_std',
        '',
        'model:',
        `  backbone: ${backbone}`,
        `  embed_dim: ${embedDim}`,
        '  pretrained: true',
        '',
        'loss:',
        `  type: ${lossType}`,
        '  ntxent_temperature: 0.05',
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
        'early_stopping:',
        '  patience: 15',
        '  min_epochs: 10',
        '',
        'evaluation:',
        '  metrics: [roc_auc, pr_auc, eer, tar_at_fmr]',
        '  fmr_targets: [0.001, 0.0001]',
        '  val_every: 5',
        '',
        'data:',
        '  train_frac: 0.7',
        '  val_frac: 0.15',
        '  site_holdout: false',
        '  pos_fraction: 0.5',
        '  augmentation_p: 0.3',
        '  max_apply: 3',
        '',
      ].join('\n');

      const configPath = join(outputDir, 'config.yaml');
      await writeFile(configPath, configContent);

      ctx.activeTraining = {
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

      const trainModelsCwd = await resolveModelsCwd(ctx);
      const trainPythonCmd = await resolvePythonCmd(ctx);
      const trainSpawnOpts: any = {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      };
      if (trainModelsCwd) trainSpawnOpts.cwd = trainModelsCwd;

      const proc = spawn(trainPythonCmd, args, trainSpawnOpts);

      ctx.activeTraining.process = proc;

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
            if (!ctx.activeTraining) continue;

            switch (evt.event) {
              case 'init':
                ctx.activeTraining.trainSamples = evt.train_samples;
                ctx.activeTraining.valSamples = evt.val_samples;
                ctx.activeTraining.groups = evt.groups;
                ctx.activeTraining.device = evt.device;
                ctx.activeTraining.totalEpochs = evt.epochs;
                break;
              case 'epoch':
                ctx.activeTraining.currentEpoch = evt.epoch;
                ctx.activeTraining.loss = evt.loss;
                ctx.activeTraining.lr = evt.lr;
                ctx.activeTraining.eta_s = evt.eta_s || 0;
                break;
              case 'validation':
                ctx.activeTraining.metrics = { ...evt };
                delete (ctx.activeTraining.metrics as any).event;
                delete (ctx.activeTraining.metrics as any).epoch;
                if (evt.best_auc !== undefined) ctx.activeTraining.bestAuc = evt.best_auc;
                break;
              case 'checkpoint':
                // Just log it
                break;
              case 'export':
                ctx.activeTraining.phase = evt.phase === 'complete' ? 'complete' : 'exporting';
                break;
              case 'complete':
                ctx.activeTraining.bestAuc = evt.best_auc || ctx.activeTraining.bestAuc;
                break;
              case 'early_stop':
                ctx.activeTraining.totalEpochs = evt.epoch;
                ctx.activeTraining.logs.push(
                  `Early stopped at epoch ${evt.epoch} (no improvement for ${evt.patience} epochs)`
                );
                break;
              case 'error':
                ctx.activeTraining.error = evt.message;
                break;
            }
          } catch {
            // Not JSON — add to logs
            if (ctx.activeTraining && ctx.activeTraining.logs.length < 500) {
              ctx.activeTraining.logs.push(line);
            }
          }
        }
      });

      // Capture stderr as log lines
      proc.stderr?.on('data', (data: Buffer) => {
        if (!ctx.activeTraining) return;
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          if (ctx.activeTraining.logs.length < 500) {
            ctx.activeTraining.logs.push(line);
          }
        }
      });

      proc.on('close', async (code) => {
        if (!ctx.activeTraining) return;
        ctx.activeTraining.done = true;
        ctx.activeTraining.success = code === 0;
        ctx.activeTraining.durationMs = Date.now() - ctx.activeTraining.startedAt;
        if (code !== 0 && !ctx.activeTraining.error) {
          ctx.activeTraining.error = `Training process exited with code ${code}`;
        }
        if (ctx.activeTraining.phase !== 'error') {
          ctx.activeTraining.phase = code === 0 ? 'complete' : 'error';
        }

        // Save run record
        try {
          const runId = generateRunId();
          ctx.activeTraining.runId = runId;
          await createRunRecord({
            id: runId,
            type: 'training',
            name: `Train ${backbone} (${epochs} epochs)`,
            status: code === 0 ? 'completed' : 'failed',
            startedAt: new Date(ctx.activeTraining.startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: ctx.activeTraining.durationMs,
            stepsCompleted: ctx.activeTraining.currentEpoch,
            stepsTotal: ctx.activeTraining.totalEpochs,
            error: ctx.activeTraining.error,
            metadata: {
              backbone,
              epochs,
              bestAuc: ctx.activeTraining.bestAuc,
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
    return true;
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
      return true;
    }
    if (!ctx.activeTraining) {
      sendJson(res, 200, { active: false });
      return true;
    }
    sendJson(res, 200, {
      active: !ctx.activeTraining.done,
      done: ctx.activeTraining.done,
      runId: ctx.activeTraining.runId,
      success: ctx.activeTraining.success,
      backbone: ctx.activeTraining.backbone,
      phase: ctx.activeTraining.phase,
      currentEpoch: ctx.activeTraining.currentEpoch,
      totalEpochs: ctx.activeTraining.totalEpochs,
      loss: ctx.activeTraining.loss,
      lr: ctx.activeTraining.lr,
      eta_s: ctx.activeTraining.eta_s,
      metrics: ctx.activeTraining.metrics,
      bestAuc: ctx.activeTraining.bestAuc,
      error: ctx.activeTraining.error,
      outputDir: ctx.activeTraining.outputDir,
      durationMs: ctx.activeTraining.done ? ctx.activeTraining.durationMs : Date.now() - ctx.activeTraining.startedAt,
      trainSamples: ctx.activeTraining.trainSamples,
      valSamples: ctx.activeTraining.valSamples,
      groups: ctx.activeTraining.groups,
      device: ctx.activeTraining.device,
      embedDim: ctx.activeTraining.embedDim,
      lossType: ctx.activeTraining.lossType,
      logs: ctx.activeTraining.logs,
    });
    return true;
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
      return true;
    }
    if (!ctx.activeTraining || ctx.activeTraining.done) {
      sendJson(res, 400, { error: 'No training is currently running' });
      return true;
    }
    if (ctx.activeTraining.process) {
      ctx.activeTraining.process.kill('SIGTERM');
    }
    ctx.activeTraining.done = true;
    ctx.activeTraining.success = false;
    ctx.activeTraining.error = 'Cancelled by user';
    ctx.activeTraining.phase = 'error';
    ctx.activeTraining.durationMs = Date.now() - ctx.activeTraining.startedAt;
    sendJson(res, 200, { success: true, message: 'Training cancelled' });
    return true;
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
    return true;
  }

  // GET /api/workflows/:id/training/status — poll per-workflow training progress
  const wfTrainingMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/training\/status$/);
  if (req.method === 'GET' && wfTrainingMatch) {
    const wfId = decodeURIComponent(wfTrainingMatch[1]);
    const training = workflowTrainings.get(wfId);
    if (!training) {
      sendJson(res, 404, { error: 'No training found for this workflow' });
    } else {
      sendJson(res, 200, {
        workflowId: training.workflowId,
        phase: training.phase,
        currentEpoch: training.currentEpoch,
        totalEpochs: training.totalEpochs,
        loss: training.loss,
        bestAuc: training.bestAuc,
        error: training.error,
        startedAt: training.startedAt,
        elapsed: Date.now() - training.startedAt,
        modelDir: training.modelDir,
        logs: training.logs.slice(-20),
        worker: training.worker ? { name: training.worker.name, host: training.worker.host } : null,
        nextVersion: training.nextVersion,
        versionDir: training.versionDir,
      });
    }
    return true;
  }

  // GET /api/workflows/:id/training/data — training data stats for a workflow
  const wfTrainingDataMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/training\/data$/);
  if (req.method === 'GET' && wfTrainingDataMatch) {
    const wfId = decodeURIComponent(wfTrainingDataMatch[1]);
    const workflowDataDir = join(homedir(), '.woodbury', 'data', 'workflows', wfId);
    const snapshotsRoot = join(workflowDataDir, 'snapshots');
    const cropsRoot = join(workflowDataDir, 'crops');

    const result: {
      snapshots: { total: number; fromRecording: number; fromExecution: number; fromDebug: number; totalElements: number; uniqueSelectors: number; interactionFiles: number; interactedSelectors: number; };
      crops: { total: number; uniqueGroups: number; interacted: number; nonInteracted: number; } | null;
      lastTraining: { version: string; backbone: string; epochs: number; embedDim: number; bestAuc: number; trainedAt: string; cropsPerElement: number; } | null;
    } = {
      snapshots: { total: 0, fromRecording: 0, fromExecution: 0, fromDebug: 0, totalElements: 0, uniqueSelectors: 0, interactionFiles: 0, interactedSelectors: 0 },
      crops: null,
      lastTraining: null,
    };

    // Scan snapshot files
    try {
      const siteDirs = await readdir(snapshotsRoot).catch(() => [] as string[]);
      const allSelectors = new Set<string>();
      const allInteractedSelectors = new Set<string>();

      for (const siteDir of siteDirs) {
        const sitePath = join(snapshotsRoot, siteDir);
        try {
          const s = await stat(sitePath);
          if (!s.isDirectory()) continue;
        } catch { continue; }

        const files = await readdir(sitePath).catch(() => [] as string[]);
        for (const file of files) {
          if (file.startsWith('interactions_') && file.endsWith('.json')) {
            result.snapshots.interactionFiles++;
            // Parse interaction file for interacted selectors
            try {
              const content = await readFile(join(sitePath, file), 'utf8');
              const data = JSON.parse(content);
              const selectors: string[] = data.interacted_selectors || [];
              for (const sel of selectors) allInteractedSelectors.add(sel);
            } catch { /* skip */ }
          } else if (file.startsWith('snapshot_') && file.endsWith('.json') && !file.endsWith('_viewport.png') && !file.endsWith('_desktop.png')) {
            result.snapshots.total++;
            if (file.includes('_run-')) {
              result.snapshots.fromExecution++;
            } else if (file.startsWith('snapshot_capture_')) {
              result.snapshots.fromDebug++;
            } else {
              result.snapshots.fromRecording++;
            }
            // Parse snapshot for element count
            try {
              const content = await readFile(join(sitePath, file), 'utf8');
              const data = JSON.parse(content);
              const elements: any[] = data.elements || [];
              result.snapshots.totalElements += elements.length;
              for (const el of elements) {
                if (el.selector) allSelectors.add(el.selector);
              }
            } catch { /* skip */ }
          }
        }
      }
      result.snapshots.uniqueSelectors = allSelectors.size;
      result.snapshots.interactedSelectors = allInteractedSelectors.size;
    } catch { /* snapshots dir doesn't exist */ }

    // Scan crops metadata.jsonl
    try {
      const metaPath = join(cropsRoot, 'metadata.jsonl');
      const content = await readFile(metaPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const groups = new Set<string>();
      let interacted = 0;
      let nonInteracted = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.group_id) groups.add(entry.group_id);
          if (entry.interacted) interacted++;
          else nonInteracted++;
        } catch { /* skip bad lines */ }
      }
      result.crops = {
        total: lines.length,
        uniqueGroups: groups.size,
        interacted,
        nonInteracted,
      };
    } catch { /* no crops yet */ }

    // Last training info from version registry
    try {
      const registry = await readVersionRegistry(join(workflowDataDir, 'model'));
      if (registry && registry.versions.length > 0) {
        // Find the latest complete version (by trainedAt)
        const complete = registry.versions
          .filter(v => v.status === 'complete')
          .sort((a, b) => new Date(b.trainedAt).getTime() - new Date(a.trainedAt).getTime());
        if (complete.length > 0) {
          const latest = complete[0];
          result.lastTraining = {
            version: latest.version,
            backbone: latest.backbone,
            epochs: latest.epochs,
            embedDim: latest.embedDim,
            bestAuc: latest.bestAuc,
            trainedAt: latest.trainedAt,
            cropsPerElement: 10, // hardcoded in trainForWorkflowLocal
          };
        }
      }
    } catch { /* no version registry */ }

    sendJson(res, 200, result);
    return true;
  }

  // GET /api/workflows/:id/model/versions — list all model versions
  const wfVersionsMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/model\/versions$/);
  if (req.method === 'GET' && wfVersionsMatch) {
    const wfId = decodeURIComponent(wfVersionsMatch[1]);
    const wfModelDir = join(homedir(), '.woodbury', 'data', 'workflows', wfId, 'model');
    const registry = await readVersionRegistry(wfModelDir);
    if (!registry) {
      sendJson(res, 200, { activeVersion: null, versions: [] });
    } else {
      sendJson(res, 200, registry);
    }
    return true;
  }

  // POST /api/workflows/:id/model/activate — set a specific version as active
  const wfActivateMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/model\/activate$/);
  if (req.method === 'POST' && wfActivateMatch) {
    const wfId = decodeURIComponent(wfActivateMatch[1]);
    const body = await readBody(req);
    const targetVersion = body?.version;
    if (!targetVersion) {
      sendJson(res, 400, { error: 'Missing "version" in request body' });
      return true;
    }

    const wfModelDir = join(homedir(), '.woodbury', 'data', 'workflows', wfId, 'model');
    const registry = await readVersionRegistry(wfModelDir);
    if (!registry) {
      sendJson(res, 404, { error: 'No version registry found' });
      return true;
    }

    const entry = registry.versions.find(v => v.version === targetVersion && v.status === 'complete');
    if (!entry) {
      sendJson(res, 404, { error: `Version ${targetVersion} not found or not complete` });
      return true;
    }

    registry.activeVersion = targetVersion;
    await writeVersionRegistry(wfModelDir, registry);

    // Update workflow JSON with new active model
    const discovered = await discoverWorkflows(workDir);
    const found = discovered.find(d => d.workflow.id === wfId);
    if (found) {
      try {
        const wfContent = await readFile(found.path, 'utf8');
        const wf = JSON.parse(wfContent);
        wf.metadata.modelPath = entry.modelPath;
        wf.metadata.modelVersion = targetVersion;
        await atomicWriteFile(found.path, JSON.stringify(wf, null, 2));
      } catch { /* best-effort */ }
    }

    sendJson(res, 200, { success: true, activeVersion: targetVersion });
    return true;
  }

  // POST /api/workflows/:id/training/retry — re-trigger training for a workflow
  const wfRetryMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/training\/retry$/);
  if (req.method === 'POST' && wfRetryMatch) {
    const wfId = decodeURIComponent(wfRetryMatch[1]);
    const existing = workflowTrainings.get(wfId);
    if (existing && existing.phase !== 'complete' && existing.phase !== 'error') {
      sendJson(res, 409, { error: 'Training is still in progress' });
      return true;
    }

    // Find workflow file — use stored path or discover it
    let wfPath = existing?.workflowFilePath || '';
    if (!wfPath) {
      const discovered = await discoverWorkflows(workDir);
      const found = discovered.find((d: any) => d.workflow.id === wfId || d.workflow.name === wfId);
      if (found) wfPath = found.path;
    }
    if (!wfPath) {
      sendJson(res, 404, { error: `Workflow not found: ${wfId}` });
      return true;
    }

    try {
      const wfContent = await readFile(wfPath, 'utf8');
      const wf = JSON.parse(wfContent);
      const site = wf.site || 'unknown';

      // Read optional training config from request body
      let trainingConfig: Partial<WorkflowTrainingConfig> | undefined;
      try {
        const body = await readBody(req);
        if (body && (body.backbone || body.epochs || body.embedDim || body.sources)) {
          trainingConfig = {};
          if (body.backbone) trainingConfig.backbone = body.backbone;
          if (body.epochs) trainingConfig.epochs = parseInt(body.epochs, 10);
          if (body.embedDim) trainingConfig.embedDim = parseInt(body.embedDim, 10);
          if (Array.isArray(body.sources) && body.sources.length > 0) {
            trainingConfig.sources = body.sources.filter((s: string) =>
              ['recording', 'execution', 'debug'].includes(s));
          }
        }
      } catch { /* no body or invalid JSON — use defaults */ }

      workflowTrainings.delete(wfId);
      trainForWorkflow(wfId, site, wfPath, trainingConfig, ctx).catch(err => {
        debugLog.info('workflow-train', `Retry training failed for ${wfId}: ${String(err)}`);
      });

      sendJson(res, 200, { success: true, workflowId: wfId });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
