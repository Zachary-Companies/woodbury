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
import type { ToolDefinition } from './loop/types.js';
import { debugLog } from './debug-log.js';
import {
  discoverWorkflows,
  discoverCompositions,
  loadWorkflow,
  type DiscoveredWorkflow,
} from './workflow/loader.js';
import type { WorkflowDocument, Expectation, RunRecord, NodeRunResult, PendingApproval, ApprovalGateConfig, BatchConfig, VariablePool, Schedule, ModelVersionEntry, ModelVersionRegistry } from './workflow/types.js';
import { checkExpectations } from './workflow/executor.js';
import { WorkflowRecorder } from './workflow/recorder.js';
import { bridgeServer, ensureBridgeServer } from './bridge-server.js';
import { startRemoteRelay, type RelayHandle } from './remote-relay.js';
import { ExecutionSnapshotCapture } from './workflow/execution-snapshots.js';
import { startInferenceServer as startNodeInference, stopInferenceServer as stopNodeInference, type InferenceServer } from './inference/index.js';
import { appendFileSync, mkdirSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';

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

  // ── Script Tool Context helpers ────────────────────────────────
  interface ScriptToolDoc {
    toolName: string;
    customDescription?: string;
    examples?: string[];
    notes?: string;
    returns?: string;
    enabled: boolean;
  }
  const SCRIPT_TOOL_DOCS_PATH = join(homedir(), '.woodbury', 'data', 'script-tool-docs.json');

  async function loadScriptToolDocs(): Promise<ScriptToolDoc[]> {
    try {
      const content = await readFile(SCRIPT_TOOL_DOCS_PATH, 'utf-8');
      return JSON.parse(content);
    } catch { return []; }
  }

  async function saveScriptToolDocs(docs: ScriptToolDoc[]): Promise<void> {
    await mkdir(join(homedir(), '.woodbury', 'data'), { recursive: true });
    await writeFile(SCRIPT_TOOL_DOCS_PATH, JSON.stringify(docs, null, 2));
  }

  function formatToolSignature(def: ToolDefinition): string {
    const props = def.parameters?.properties;
    if (!props || typeof props !== 'object') {
      return `context.tools.${def.name}(params)`;
    }
    const required: string[] = def.parameters?.required || [];
    const parts: string[] = [];
    for (const [name, prop] of Object.entries(props)) {
      const p = prop as any;
      const optional = !required.includes(name) ? '?' : '';
      let type: string = p.type || 'any';
      if (p.enum) {
        if (p.enum.length <= 4) {
          type = p.enum.map((v: string) => `"${v}"`).join('|');
        } else {
          type = p.enum.slice(0, 3).map((v: string) => `"${v}"`).join('|') + '|...';
        }
      }
      parts.push(`${name}${optional}: ${type}`);
    }
    return `context.tools.${def.name}({ ${parts.join(', ')} })`;
  }

  async function generateScriptToolDocs(): Promise<string> {
    const tools = extensionManager?.getAllTools() ?? [];
    if (tools.length === 0) return '';

    const customDocs = await loadScriptToolDocs();
    const customMap = new Map(customDocs.map(d => [d.toolName, d]));

    let section = '\nAvailable tools (via context.tools):\n';
    for (const tool of tools) {
      const custom = customMap.get(tool.definition.name);
      if (custom && !custom.enabled) continue;

      const sig = formatToolSignature(tool.definition);
      const desc = custom?.customDescription || tool.definition.description.split('\n')[0];
      section += `\n- ${sig} — ${desc}\n`;

      // Include parameter descriptions from JSON Schema
      const props = tool.definition.parameters?.properties;
      const required: string[] = tool.definition.parameters?.required || [];
      if (props && typeof props === 'object') {
        section += `  Parameters:\n`;
        for (const [name, prop] of Object.entries(props)) {
          const p = prop as any;
          const req = required.includes(name) ? 'required' : 'optional';
          const paramDesc = p.description || '';
          section += `    - ${name} (${req}): ${paramDesc}\n`;
        }
      }

      // Include return type documentation
      if (custom?.returns) {
        section += `  Returns: ${custom.returns}\n`;
      }

      if (custom?.examples?.length) {
        for (const ex of custom.examples) {
          section += `  Example: ${ex}\n`;
        }
      }
      if (custom?.notes) {
        section += `  Note: ${custom.notes}\n`;
      }
    }
    return section;
  }

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
    trainingDataKept?: boolean;
  } | null = null;

  // Snapshot capture for execution runs (training data collection)
  let activeSnapshotCapture: ExecutionSnapshotCapture | null = null;

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
      inputVariables?: Record<string, unknown>;
      outputVariables?: Record<string, unknown>;
      durationMs?: number;
      retryAttempt?: number;
      retryMax?: number;
      expectationResults?: Array<{ description: string; passed: boolean; detail: string }>;
      logs?: string[];
    }>;
    done: boolean;
    success: boolean;
    error?: string;
    durationMs?: number;
    pipelineOutputs?: Record<string, unknown>;
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

  // ── Worker auto-discovery via UDP beacon ──
  const BEACON_PORT = 8678;
  let discoverySocket: DgramSocket | null = null;

  function startWorkerDiscovery() {
    try {
      discoverySocket = createSocket({ type: 'udp4', reuseAddr: true });

      discoverySocket.on('message', async (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.service !== 'woodbury-worker') return;
          const { host, port, hostname } = data;
          if (!host || !port) return;

          // Check if already known
          const workers = await loadWorkers();
          if (workers.some(w => w.host === host && w.port === port)) return;

          // Validate connectivity before adding
          try {
            await probeWorker(host, port);
          } catch {
            return; // Can't reach it, skip
          }

          const worker: WorkerConfig = {
            id: `w-${Date.now()}`,
            name: hostname || host,
            host,
            port,
            addedAt: new Date().toISOString(),
          };
          workers.push(worker);
          await saveWorkers(workers);
          if (verbose) console.log(`[dashboard] Auto-discovered worker: ${hostname || host} (${host}:${port})`);
        } catch {
          // Ignore malformed packets
        }
      });

      discoverySocket.on('error', () => {
        // Non-critical — manual add still works
        discoverySocket?.close();
        discoverySocket = null;
      });

      discoverySocket.bind(BEACON_PORT);
      if (verbose) console.log(`[dashboard] Worker discovery listening on UDP port ${BEACON_PORT}`);
    } catch {
      // Non-critical
    }
  }

  startWorkerDiscovery();

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

  // ── Inference Server (visual element verification) ──────────
  // Native Node.js inference using onnxruntime-node + sharp.
  // Replaces the previous Python woobury_models.serve dependency.
  const INFERENCE_PORT = 8679;
  let inferenceServer: InferenceServer | null = null;
  let inferenceModelPath: string | null = null;

  /**
   * Start the Node.js inference server. Models are loaded on demand per-workflow.
   * Optionally pre-loads the latest model from MODELS_DIR as a default.
   */
  async function startInferenceServer(): Promise<void> {
    if (inferenceServer) return; // already running

    try {
      // Scan for a default model (latest encoder.onnx in MODELS_DIR)
      const { readdir, stat } = await import('fs/promises');
      await import('fs').then(f => f.mkdirSync(MODELS_DIR, { recursive: true }));

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
        } catch { /* no onnx in this dir */ }
      }

      if (bestModel) {
        inferenceModelPath = bestModel;
        debugLog.info('inference', `Starting Node.js inference server with default model: ${bestModel}`);
      } else {
        debugLog.info('inference', 'Starting Node.js inference server without default model (models loaded on demand)');
      }

      inferenceServer = await startNodeInference(INFERENCE_PORT, bestModel ?? undefined);
      debugLog.info('inference', `Node.js inference server running on port ${INFERENCE_PORT}`);

    } catch (err) {
      debugLog.info('inference', `Failed to start inference server: ${String(err)}`);
      inferenceServer = null;
    }
  }

  function stopInferenceServer(): void {
    if (inferenceServer) {
      stopNodeInference(inferenceServer);
      inferenceServer = null;
      inferenceModelPath = null;
    }
  }

  // Start inference server in the background (non-blocking)
  startInferenceServer();

  // ── Per-Workflow Auto-Training ──────────────────────────────

  interface WorkflowTrainingConfig {
    backbone: string;
    epochs: number;
    embedDim: number;
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
   * Train a model for a specific workflow recording.
   * Prefers remote workers when available, falls back to local training.
   * Runs in background: prepare data → train → export ONNX → update workflow JSON.
   */
  async function trainForWorkflow(
    workflowId: string,
    site: string,
    workflowFilePath: string,
    trainingConfig?: Partial<WorkflowTrainingConfig>,
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
        await trainForWorkflowLocal(training, snapshotsDir, cropsDir, versionDir);
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
   * Run training locally (prepare data → train model → export ONNX).
   * Extracted to allow trainForWorkflow to choose between local and remote.
   */
  async function trainForWorkflowLocal(
    training: WorkflowTraining,
    snapshotsDir: string,
    cropsDir: string,
    modelDir: string,
  ): Promise<void> {
      // Phase 1: Prepare training data from snapshots
      debugLog.info('workflow-train', `Preparing training data for ${training.workflowId}`);
      training.phase = 'preparing';

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('python', [
          '-m', 'woobury_models.prepare',
          '--snapshots-dir', snapshotsDir,
          '--output-dir', cropsDir,
          '--source', 'viewport',
          '--crops-per-element', '15',
          '--interacted-only',
        ], {
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          cwd: join(homedir(), 'Documents', 'GitHub', 'woobury-models'),
        });

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
        const proc = spawn('python', [
          '-m', 'woobury_models.train',
          '--json-progress',
          '--config', configPath,
          '--data-dir', cropsDir,
          '--output-dir', modelDir,
          '--export-onnx',
        ], {
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          cwd: join(homedir(), 'Documents', 'GitHub', 'woobury-models'),
        });

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

  /**
   * Classify whether an error is likely a code bug (fixable by LLM) vs external/infrastructure.
   * Code bugs: SyntaxError, TypeError, ReferenceError, RangeError, or generic errors without
   * network/API patterns in the message. External errors are not worth auto-fixing.
   */
  function isCodeBug(err: any): boolean {
    if (err instanceof SyntaxError) return true;
    if (err instanceof TypeError) return true;
    if (err instanceof ReferenceError) return true;
    if (err instanceof RangeError) return true;

    const msg = String(err?.message || '').toLowerCase();
    const externalPatterns = [
      'econnrefused', 'econnreset', 'etimedout', 'enotfound',
      'fetch failed', 'network error', 'socket hang up',
      'rate limit', 'too many requests', '429',
      '500', '502', '503', '504',
      'api key', 'unauthorized', '401', '403',
      'timeout', 'aborted', 'enospc', 'eperm', 'eacces',
    ];
    for (const pat of externalPatterns) {
      if (msg.includes(pat)) return false;
    }
    return true;
  }

  /**
   * Find nodes reachable EXCLUSIVELY through a specific output port.
   * Used by Branch/Switch to skip only nodes that are downstream of the inactive port
   * without skipping nodes that are also reachable from active ports (convergent paths).
   */
  function getNodesExclusivelyDownstreamOfPort(
    nodeId: string,
    portName: string,
    edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>
  ): Set<string> {
    // Set A: BFS from nodeId following only edges from portName, then all edges from subsequent nodes
    const fromPort = new Set<string>();
    const qA: string[] = [nodeId];
    while (qA.length > 0) {
      const cur = qA.shift()!;
      for (const e of edges) {
        // At the origin node, only follow edges from the specified port
        if (cur === nodeId && e.sourceNodeId === cur && e.sourcePort !== portName) continue;
        if (e.sourceNodeId === cur && !fromPort.has(e.targetNodeId)) {
          fromPort.add(e.targetNodeId);
          qA.push(e.targetNodeId);
        }
      }
    }

    // Set B: BFS from nodeId following edges from ALL OTHER ports, then all edges from subsequent nodes
    const fromOther = new Set<string>();
    const qB: string[] = [nodeId];
    while (qB.length > 0) {
      const cur = qB.shift()!;
      for (const e of edges) {
        // At the origin node, skip edges from the specified port
        if (cur === nodeId && e.sourceNodeId === cur && e.sourcePort === portName) continue;
        if (e.sourceNodeId === cur && !fromOther.has(e.targetNodeId)) {
          fromOther.add(e.targetNodeId);
          qB.push(e.targetNodeId);
        }
      }
    }

    // A \ B — nodes reachable ONLY through the specified port
    const exclusive = new Set<string>();
    for (const id of fromPort) {
      if (!fromOther.has(id)) exclusive.add(id);
    }
    return exclusive;
  }

  /**
   * Infer the external inputs for a composition.
   * An input is any node input port that is NOT connected via an incoming edge,
   * excluding output node ports (those are internal collectors).
   */
  function inferCompositionInputs(
    comp: any,
    wfMap: Record<string, any>
  ): Array<{ name: string; type: string; description: string; nodeId: string; portName: string }> {
    const connectedInputs = new Set<string>();
    for (const edge of comp.edges) {
      connectedInputs.add(`${edge.targetNodeId}:${edge.targetPort}`);
    }

    const result: Array<{ name: string; type: string; description: string; nodeId: string; portName: string }> = [];

    for (const node of comp.nodes) {
      // Skip output node — its ports are internal collectors
      if (node.workflowId === '__output__') continue;

      let ports: Array<{ name: string; type?: string; description?: string }> = [];

      if (node.workflowId === '__approval_gate__') {
        // Gates have no external inputs
        continue;
      } else if (node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__') {
        // Flow control nodes have fixed ports — not external composition inputs
        continue;
      } else if (node.workflowId === '__script__' && node.script) {
        ports = node.script.inputs || [];
      } else if (node.workflowId.startsWith('comp:') && node.compositionRef) {
        // Sub-pipeline inputs would be resolved recursively — skip for now
        continue;
      } else {
        const wf = wfMap[node.id];
        if (wf && wf.variables) {
          ports = wf.variables.map((v: any) => ({ name: v.name, type: v.type || 'string', description: v.description }));
        }
      }

      for (const port of ports) {
        const key = `${node.id}:${port.name}`;
        if (!connectedInputs.has(key)) {
          const alias = node.portAliases && node.portAliases[port.name];
          result.push({
            name: alias || port.name,
            type: port.type || 'string',
            description: port.description || '',
            nodeId: node.id,
            portName: port.name,
          });
        }
      }
    }

    return result;
  }

  /**
   * Infer the external outputs for a composition.
   * Returns the output node's ports, if one exists.
   */
  function inferCompositionOutputs(
    comp: any
  ): Array<{ name: string; type: string; description: string }> {
    const outputNode = comp.nodes.find((n: any) => n.workflowId === '__output__');
    if (!outputNode || !outputNode.outputNode) return [];
    return outputNode.outputNode.ports.map((p: any) => ({
      name: p.name,
      type: p.type || 'string',
      description: p.description || '',
    }));
  }

  /**
   * Parse @input / @output JSDoc annotations from script node code.
   * Format: @input <name> <type> "<description>"
   */
  function parseScriptPorts(code: string): { inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }> } {
    const inputs: Array<{ name: string; type: string; description: string }> = [];
    const outputs: Array<{ name: string; type: string; description: string }> = [];
    const regex = /@(input|output)\s+(\w+)\s+(string|number|boolean|string\[\])\s*(?:"([^"]*)")?/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      const decl = { name: match[2], type: match[3], description: match[4] || '' };
      (match[1] === 'input' ? inputs : outputs).push(decl);
    }
    return { inputs, outputs };
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

    // GET /api/bridge/status — Chrome extension connection status
    if (req.method === 'GET' && pathname === '/api/bridge/status') {
      // Resolve the bundled chrome-extension path (works in both dev and packaged Electron)
      const candidates = [
        join(__dirname, '..', 'chrome-extension'),             // dev: dist/../chrome-extension
        join(__dirname, '..', '..', 'chrome-extension'),       // packaged: app.asar/../chrome-extension
      ];
      const extensionPath = candidates.find(p => existsSync(p)) || candidates[0];

      sendJson(res, 200, {
        bridgeRunning: bridgeServer.isStarted,
        extensionConnected: bridgeServer.isConnected,
        extensionPath,
      });
      return;
    }

    // GET /api/file?path=... — serve local files (images only) for preview
    if (req.method === 'GET' && pathname === '/api/file') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        sendJson(res, 400, { error: 'Missing "path" query parameter' });
        return;
      }

      // Must be an absolute path
      if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/i)) {
        sendJson(res, 400, { error: 'Path must be absolute' });
        return;
      }

      // Only serve image MIME types for security
      const ext = extname(filePath).toLowerCase();
      const imageMimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.avif': 'image/avif',
      };

      const mimeType = imageMimeTypes[ext];
      if (!mimeType) {
        sendJson(res, 400, { error: `Unsupported image type: ${ext}` });
        return;
      }

      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          sendJson(res, 404, { error: 'Not a file' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': fileStat.size,
          'Cache-Control': 'no-cache',
        });
        const stream = createReadStream(filePath);
        stream.pipe(res);
        stream.on('error', () => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Failed to read file' });
          }
        });
      } catch {
        sendJson(res, 404, { error: 'File not found' });
      }
      return;
    }

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
        const isDesktopMode = body.site === 'desktop';
        const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
        dashRecLog('INFO', `Calling activeRecorder.${isDesktopMode ? 'startDesktopRecording' : 'start'}()`, { captureElementCrops, isDesktopMode, appName });
        if (isDesktopMode) {
          await activeRecorder.startDesktopRecording(body.name, appName || undefined);
        } else {
          await activeRecorder.start(body.name, body.site, { captureElementCrops });
        }
        dashRecLog('INFO', 'Recording start completed successfully');
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
          trainingStatus: 'pending',
        });
        recordingSteps = [];

        // Kick off per-workflow model training in background (non-blocking)
        const wfId = result.workflow.id;
        const wfSite = result.workflow.site;
        trainForWorkflow(wfId, wfSite, result.filePath).catch(err => {
          debugLog.info('workflow-train', `Background training failed for ${wfId}: ${String(err)}`);
        });
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

        const wf = found.workflow;

        // Detect desktop workflow: site === 'desktop' or steps contain desktop_ types
        const isDesktopWorkflow = wf.site === 'desktop' ||
          (wf.steps || []).some((s: any) => typeof s.type === 'string' && s.type.startsWith('desktop_'));

        // Only require Chrome extension for browser workflows
        if (!isDesktopWorkflow) {
          await ensureBridgeServer();
          if (!bridgeServer.isConnected) {
            sendJson(res, 503, { error: 'Chrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.' });
            return;
          }
        }
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

        // Set up execution snapshot capture for training data collection (browser workflows only)
        const snapshotCapture = isDesktopWorkflow ? null : new ExecutionSnapshotCapture(id, wf.site || 'unknown', runId);
        activeSnapshotCapture = snapshotCapture;

        // Execute asynchronously (don't await — we respond immediately)
        const run = activeRun;
        executeWorkflow(bridgeServer, wf, mergedVars, {
          log: (msg: string) => debugLog.info('dashboard-run', msg),
          signal: abort.signal,
          onProgress: (event: { type: string; index: number; total: number; step: any; status?: string; error?: string }) => {
            if (event.type === 'step_start') {
              run.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
              // Capture page snapshot before each step (fire-and-forget)
              const stepType = event.step?.type || '';
              if (snapshotCapture && ['click', 'type', 'navigate', 'select', 'scroll', 'hover'].includes(stepType)) {
                snapshotCapture.captureSnapshot(bridgeServer).catch(() => {});
              }
            } else if (event.type === 'step_complete') {
              run.stepsCompleted = event.index + 1;
              run.stepResults.push({
                index: event.index,
                label: event.step?.label || event.step?.id || `Step ${event.index + 1}`,
                type: event.step?.type || 'unknown',
                status: event.status || 'unknown',
                error: event.error,
              });
              // Track interaction for training data
              if (event.status === 'success' || event.status === 'passed') {
                const selector = event.step?.selector || event.step?.element?.selector || '';
                if (selector && snapshotCapture) {
                  snapshotCapture.trackInteraction(selector, event.step?.type || 'unknown', event.step?.id, event.index);
                }
              }
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

          // Handle training data: keep on success, delete on failure (browser workflows only)
          if (snapshotCapture) {
            if (result.success) {
              await snapshotCapture.saveInteractions();
              debugLog.info('dashboard-run', `Run snapshots saved as training data (${snapshotCapture.count} snapshots)`, { runId });
              run.trainingDataKept = true;
            } else {
              await snapshotCapture.deleteRunSnapshots();
              debugLog.info('dashboard-run', 'Run snapshots discarded (run failed)', { runId });
              run.trainingDataKept = false;
            }
          }
          activeSnapshotCapture = null;

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

          // Clean up run snapshots on crash (browser workflows only)
          if (snapshotCapture) {
            await snapshotCapture.deleteRunSnapshots();
          }
          run.trainingDataKept = false;
          activeSnapshotCapture = null;

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
        trainingDataKept: activeRun.trainingDataKept,
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

      // Clean up run snapshots on cancel
      if (activeSnapshotCapture) {
        activeSnapshotCapture.deleteRunSnapshots().catch(() => {});
        activeSnapshotCapture = null;
      }
      activeRun.trainingDataKept = false;

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

    // GET /api/script-tool-docs — list all tool docs (auto-generated + custom overrides)
    if (req.method === 'GET' && pathname === '/api/script-tool-docs') {
      try {
        const tools = extensionManager?.getAllTools() ?? [];
        const customDocs = await loadScriptToolDocs();
        const customMap = new Map(customDocs.map(d => [d.toolName, d]));

        const result = tools.map(tool => {
          const def = tool.definition;
          const custom = customMap.get(def.name);
          return {
            name: def.name,
            description: def.description,
            signature: formatToolSignature(def),
            parameters: def.parameters?.properties || {},
            dangerous: def.dangerous || false,
            customDescription: custom?.customDescription || null,
            examples: custom?.examples || [],
            notes: custom?.notes || null,
            returns: custom?.returns || null,
            enabled: custom?.enabled ?? true,
          };
        });

        sendJson(res, 200, { tools: result });
      } catch (err) {
        sendJson(res, 500, { error: String((err as Error).message) });
      }
      return;
    }

    // PUT /api/script-tool-docs — bulk save custom docs for all tools
    if (req.method === 'PUT' && pathname === '/api/script-tool-docs') {
      try {
        const body = await readBody(req);
        const docs: ScriptToolDoc[] = (body.tools || []).map((t: any) => ({
          toolName: t.toolName || t.name,
          customDescription: t.customDescription || undefined,
          examples: t.examples || [],
          notes: t.notes || undefined,
          returns: t.returns || undefined,
          enabled: t.enabled ?? true,
        }));
        await saveScriptToolDocs(docs);
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String((err as Error).message) });
      }
      return;
    }

    // POST /api/compositions/generate-script — AI-powered code generation for script nodes
    if (req.method === 'POST' && pathname === '/api/compositions/generate-script') {
      try {
        const body = await readBody(req);
        const { description, chatHistory, currentCode } = body || {};

        if (!description && (!chatHistory || chatHistory.length === 0)) {
          sendJson(res, 400, { error: 'description or chatHistory is required' });
          return;
        }

        const toolDocs = await generateScriptToolDocs();
        const systemPrompt = `You are a code generator for pipeline script nodes. The user describes what they want a node to do, and you generate JavaScript code.

IMPORTANT: You MUST generate code that follows this EXACT format:

1. Start with a JSDoc comment block containing @input and @output annotations
2. Then an async function called execute(inputs, context)
3. The function destructures inputs and uses context.llm.generate() for LLM calls
4. The function returns an object with all declared outputs

Port annotation format (one per line in the JSDoc):
  @input <name> <type> "<description>"
  @output <name> <type> "<description>"
Types: string, number, boolean, string[]

Available context methods:
- context.llm.generate(prompt) — Call an LLM, returns a string
- context.llm.generate(prompt, { temperature, maxTokens }) — With options
- context.llm.generateJSON(prompt) — Call LLM and parse JSON response
- context.log(message) — Log a message
${toolDocs}
Example:
\`\`\`javascript
/**
 * @input theme string "The theme to write about"
 * @output poem string "A generated poem"
 * @output wordCount number "Number of words in the poem"
 */
async function execute(inputs, context) {
  const { theme } = inputs;
  const { llm } = context;

  const poem = await llm.generate(
    \\\`Write a short poem about "\${theme}". Return only the poem.\\\`
  );

  const wordCount = poem.split(/\\s+/).length;

  return { poem, wordCount };
}
\`\`\`

Rules:
- Always include the JSDoc block with @input/@output annotations
- Always use the execute(inputs, context) function signature
- Keep code simple and readable — non-technical users will see it
- Use template literals for LLM prompts
- Return ALL declared outputs
- Include clear prompt instructions when calling llm.generate()
- Respond with ONLY the code block — no explanation before or after`;

        const { runPrompt } = await import('./loop/llm-service.js');

        const model = process.env.ANTHROPIC_API_KEY
          ? 'claude-sonnet-4-20250514'
          : process.env.OPENAI_API_KEY
            ? 'gpt-4o-mini'
            : process.env.GROQ_API_KEY
              ? 'llama-3.1-70b-versatile'
              : 'claude-sonnet-4-20250514';

        // Build messages
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
        ];

        // Add chat history if present
        if (chatHistory && Array.isArray(chatHistory)) {
          for (const msg of chatHistory) {
            messages.push({ role: msg.role, content: msg.content });
          }
        }

        // Add the current request
        let userMessage = description || '';
        if (currentCode) {
          userMessage += `\n\nCurrent code:\n\`\`\`javascript\n${currentCode}\n\`\`\``;
        }
        if (userMessage.trim()) {
          messages.push({ role: 'user', content: userMessage.trim() });
        }

        const llmResponse = await runPrompt(messages, model, { maxTokens: 4096, temperature: 0.7 });
        const assistantMessage = llmResponse.content.trim();

        // Extract code block from response
        let code = assistantMessage;
        const codeBlockMatch = assistantMessage.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) {
          code = codeBlockMatch[1].trim();
        }

        // Parse @input/@output annotations
        const ports = parseScriptPorts(code);

        debugLog.info('dashboard', 'Script generated', {
          model,
          inputCount: ports.inputs.length,
          outputCount: ports.outputs.length,
          codeLength: code.length,
        });

        sendJson(res, 200, {
          success: true,
          code,
          inputs: ports.inputs,
          outputs: ports.outputs,
          assistantMessage,
        });
      } catch (err) {
        debugLog.error('dashboard', 'Script generation failed', { error: String(err) });
        sendJson(res, 500, { error: `Script generation failed: ${(err as Error).message}` });
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

    // GET /api/compositions/:id/interface — get the composition's formal interface (inputs/outputs)
    const compInterfaceMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/interface$/);
    if (req.method === 'GET' && compInterfaceMatch) {
      const id = decodeURIComponent(compInterfaceMatch[1]);
      try {
        const discovered = await discoverCompositions(workDir);
        const found = discovered.find(d => d.composition.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Composition "${id}" not found` });
          return;
        }

        const comp = found.composition;

        // Build wfMap for input inference
        const wfDiscovered = await discoverWorkflows(workDir);
        const wfMap: Record<string, any> = {};
        for (const node of comp.nodes) {
          if (node.workflowId === '__approval_gate__' || node.workflowId === '__script__' || node.workflowId === '__output__' || node.workflowId === '__image_viewer__' || node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__') continue;
          if (node.workflowId.startsWith('comp:')) continue;
          const wfFound = wfDiscovered.find((d: any) => d.workflow.id === node.workflowId);
          if (wfFound) {
            wfMap[node.id] = wfFound.workflow;
          }
        }

        const inputs = inferCompositionInputs(comp, wfMap);
        const outputs = inferCompositionOutputs(comp);

        sendJson(res, 200, { inputs, outputs, compositionId: id, compositionName: comp.name });
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
          if (node.workflowId === '__approval_gate__' || node.workflowId === '__script__' || node.workflowId === '__output__' || node.workflowId === '__image_viewer__' || node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__' || node.workflowId.startsWith('comp:')) continue; // Special nodes don't need workflows
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
          } else if (node.workflowId === '__script__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__script__',
              workflowName: node.label || 'Script',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
              logs: [] as string[],
            };
          } else if (node.workflowId === '__output__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__output__',
              workflowName: node.label || 'Pipeline Output',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__image_viewer__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__image_viewer__',
              workflowName: node.label || 'Image Viewer',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__branch__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__branch__',
              workflowName: node.label || 'Branch',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__delay__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__delay__',
              workflowName: node.label || 'Delay',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__gate__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__gate__',
              workflowName: node.label || 'Gate',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__for_each__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__for_each__',
              workflowName: node.label || 'ForEach Loop',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId === '__switch__') {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: '__switch__',
              workflowName: node.label || 'Switch',
              stepsTotal: 1,
              stepsCompleted: 0,
              currentStep: '',
            };
          } else if (node.workflowId.startsWith('comp:')) {
            nodeStates[node.id] = {
              status: 'pending',
              workflowId: node.workflowId,
              workflowName: node.label || 'Sub-Pipeline',
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
            pipelineOutputs: r.pipelineOutputs,
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
                  ns.inputVariables = upstreamVars;
                  ns.outputVariables = upstreamVars;
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

              // ── Script Node ─────────────────────────────────────
              if (node?.workflowId === '__script__' && node.script) {
                ns.status = 'running';
                ns.currentStep = 'Running script...';
                run.currentNodeId = nodeId;
                const scriptStart = Date.now();

                // Hoist variables needed by both try and catch (auto-fix)
                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                const { runPrompt: scriptRunPrompt } = await import('./loop/llm-service.js');
                const scriptModel = process.env.ANTHROPIC_API_KEY
                  ? 'claude-sonnet-4-20250514'
                  : process.env.OPENAI_API_KEY
                    ? 'gpt-4o-mini'
                    : process.env.GROQ_API_KEY
                      ? 'llama-3.1-70b-versatile'
                      : 'claude-sonnet-4-20250514';

                const scriptLogs: string[] = ns.logs || [];
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

                // Build context.tools dynamically from all extension tools
                const scriptTools: Record<string, (params: any) => Promise<any>> = {};
                const allExtTools = extensionManager?.getAllTools() ?? [];
                for (const extTool of allExtTools) {
                  const toolHandler = extTool.handler;
                  scriptTools[extTool.definition.name] = async (params: any) => {
                    const result = await toolHandler(params, { workingDirectory: workDir } as any);
                    if (typeof result === 'string') {
                      try { return JSON.parse(result); } catch { return result; }
                    }
                    return result;
                  };
                }
                // Fallback: if extensionManager unavailable, try nanobanana directly
                if (Object.keys(scriptTools).length === 0) {
                  try {
                    const { nanobanana: nb } = await import('./loop/tools/nanobanana.js');
                    scriptTools.nanobanana = async (p: any) => JSON.parse(await nb(p as any, workDir));
                  } catch { /* nanobanana not available */ }
                }

                const context = {
                    llm: {
                      generate: async (prompt: string, opts?: { temperature?: number; maxTokens?: number; model?: string }) => {
                        const resp = await scriptRunPrompt(
                          [{ role: 'user', content: prompt }],
                          opts?.model || scriptModel,
                          { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.9 }
                        );
                        return resp.content.trim();
                      },
                      generateJSON: async (prompt: string, _schema?: any, opts?: { temperature?: number; maxTokens?: number; model?: string }) => {
                        const resp = await scriptRunPrompt(
                          [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }],
                          opts?.model || scriptModel,
                          { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.7 }
                        );
                        const text = resp.content.trim();
                        // Extract JSON from possible markdown code block
                        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                        return JSON.parse(jsonMatch ? jsonMatch[1].trim() : text);
                      },
                    },
                    tools: scriptTools,
                    log: (msg: string) => { scriptLogs.push(String(msg)); },
                  };

                try {
                  // Execute the script code
                  // Extract function body from the code — strip the function wrapper if present
                  let fnBody = node.script.code;
                  const fnMatch = fnBody.match(/async\s+function\s+execute\s*\([^)]*\)\s*\{([\s\S]*)\}/);
                  if (fnMatch) {
                    fnBody = fnMatch[1];
                  }
                  const fn = new AsyncFunction('inputs', 'context', 'require', fnBody);
                  const outputs = await fn(mergedInputs, context, require);

                  ns.durationMs = Date.now() - scriptStart;
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  ns.logs = scriptLogs;
                  ns.outputVariables = outputs || {};
                  run.nodesCompleted++;
                  nodeOutputs[nodeId] = outputs || {};

                  debugLog.info('comp-run', `Script node "${nodeId}" completed`, {
                    outputKeys: Object.keys(outputs || {}),
                    durationMs: ns.durationMs,
                  });
                } catch (scriptErr: any) {
                  const originalError = scriptErr?.message || String(scriptErr);

                  // ── Auto-fix attempt for code bugs ──
                  if (node.script && isCodeBug(scriptErr)) {
                    ns.currentStep = 'Script failed — attempting auto-fix...';
                    scriptLogs.push(`[auto-fix] Original error: ${originalError}`);
                    debugLog.info('comp-run', `Script node "${nodeId}" failed with code bug, attempting auto-fix`, { error: originalError });

                    try {
                      // Build fix prompt
                      const fixToolDocs = await generateScriptToolDocs();
                      const fixSystemPrompt = `You are a code debugger for pipeline script nodes. A script failed during execution and you need to fix the bug.

The script format:
1. JSDoc comment with @input and @output annotations
2. async function execute(inputs, context)
3. Available: context.llm.generate(prompt), context.llm.generateJSON(prompt), context.log(message)${fixToolDocs ? '\n' + fixToolDocs : ''}
4. Must return an object with all declared outputs

CRITICAL RULES:
- Do NOT change @input or @output annotations — ports are connected to other nodes
- Do NOT change the function signature
- Fix ONLY the bug described in the error
- Keep the same overall logic and intent
- Respond with ONLY the corrected code block — no explanation before or after`;

                      const inputSummary = Object.entries(mergedInputs)
                        .map(([k, v]) => {
                          const val = typeof v === 'string' ? JSON.stringify(v.slice(0, 200)) : JSON.stringify(v);
                          return `  ${k}: ${val}`;
                        })
                        .join('\n');

                      const fixUserMessage = `The following script node failed with an error.

**Error**: ${scriptErr?.name || 'Error'}: ${originalError}
${scriptErr?.stack ? `**Stack trace**:\n${scriptErr.stack.split('\n').slice(0, 6).join('\n')}` : ''}

**Script code**:
\`\`\`javascript
${node.script.code}
\`\`\`

**Inputs at time of failure**:
${inputSummary || '  (none)'}

${scriptLogs.length > 0 ? `**Logs before failure**:\n${scriptLogs.slice(-10).map((l: string) => `  ${l}`).join('\n')}` : ''}

Fix the bug and return the corrected code. Do not change the @input/@output annotations.`;

                      const fixMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
                        { role: 'system', content: fixSystemPrompt },
                        { role: 'user', content: fixUserMessage },
                      ];

                      // Call LLM for fix (low temperature for conservative changes)
                      const fixResponse = await scriptRunPrompt(fixMessages, scriptModel, { maxTokens: 4096, temperature: 0.3 });
                      let fixedCode = fixResponse.content.trim();

                      // Extract code block if wrapped in markdown
                      const codeBlockMatch = fixedCode.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
                      if (codeBlockMatch) {
                        fixedCode = codeBlockMatch[1].trim();
                      }

                      scriptLogs.push(`[auto-fix] LLM produced fixed code (${fixedCode.length} chars)`);

                      // Re-execute the fixed code
                      ns.currentStep = 'Re-running fixed script...';
                      let fixedFnBody = fixedCode;
                      const fixedFnMatch = fixedFnBody.match(/async\s+function\s+execute\s*\([^)]*\)\s*\{([\s\S]*)\}/);
                      if (fixedFnMatch) {
                        fixedFnBody = fixedFnMatch[1];
                      }
                      const fixedFn = new AsyncFunction('inputs', 'context', 'require', fixedFnBody);
                      const fixedOutputs = await fixedFn(mergedInputs, context, require);

                      // SUCCESS — persist the fix
                      ns.durationMs = Date.now() - scriptStart;
                      ns.status = 'completed';
                      ns.stepsCompleted = 1;
                      ns.logs = scriptLogs;
                      ns.outputVariables = fixedOutputs || {};
                      run.nodesCompleted++;
                      nodeOutputs[nodeId] = fixedOutputs || {};

                      scriptLogs.push('[auto-fix] Fixed script executed successfully');

                      // Update code in memory
                      node.script.code = fixedCode;
                      if (!node.script.chatHistory) node.script.chatHistory = [];
                      node.script.chatHistory.push(
                        { role: 'user', content: `[Auto-fix] The script failed with: ${originalError}` },
                        { role: 'assistant', content: `\`\`\`javascript\n${fixedCode}\n\`\`\`` }
                      );

                      // Persist to disk
                      try {
                        comp.metadata = comp.metadata || { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                        comp.metadata.updatedAt = new Date().toISOString();
                        await writeFile(compFound.path, JSON.stringify(comp, null, 2), 'utf-8');
                      } catch (saveErr) {
                        scriptLogs.push(`[auto-fix] Warning: fix applied in memory but failed to save to disk: ${saveErr}`);
                      }

                      debugLog.info('comp-run', `Script node "${nodeId}" auto-fixed and completed`, {
                        originalError,
                        outputKeys: Object.keys(fixedOutputs || {}),
                        durationMs: ns.durationMs,
                      });
                      continue; // Proceed to next node

                    } catch (fixErr: any) {
                      // Fix attempt also failed — report both errors
                      const fixError = fixErr?.message || String(fixErr);
                      scriptLogs.push(`[auto-fix] Fix attempt also failed: ${fixError}`);
                      debugLog.error('comp-run', `Script node "${nodeId}" auto-fix failed`, { originalError, fixError });

                      ns.durationMs = Date.now() - scriptStart;
                      ns.status = 'failed';
                      ns.error = `Script error: ${originalError}\nAuto-fix attempted but also failed: ${fixError}`;
                      ns.logs = scriptLogs;
                      // Fall through to failure policy below
                    }
                  } else {
                    // External/infrastructure error — no auto-fix
                    ns.durationMs = Date.now() - scriptStart;
                    ns.status = 'failed';
                    ns.error = `Script error: ${originalError}`;
                    ns.logs = scriptLogs;
                    scriptLogs.push(`[auto-fix] Skipped: error appears to be external/infrastructure (${scriptErr?.name || 'Error'})`);
                    debugLog.error('comp-run', `Script node "${nodeId}" failed (external error, no auto-fix)`, { error: originalError });
                  }

                  // Apply failure policy (stop or skip)
                  const scriptPolicy = node.onFailure || { action: 'stop' as const };
                  if (scriptPolicy.action === 'skip') {
                    ns.status = 'skipped';
                    continue;
                  } else {
                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }
                    run.done = true;
                    run.success = false;
                    run.error = ns.error;
                    run.durationMs = Date.now() - run.startedAt;
                    await finalizeCompRunRecord(compRunId, run, executionOrder);
                    return;
                  }
                }
                continue;
              }

              // ── Image Viewer Node (pass-through) ──────────────────
              if (node?.workflowId === '__image_viewer__' && node.imageViewer) {
                ns.status = 'running';
                ns.currentStep = 'Displaying image...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                // Resolve file path from edge input or config
                const filePath = mergedInputs['file_path'] ?? node.imageViewer.filePath;

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = { file_path: filePath };
                nodeOutputs[nodeId] = { file_path: filePath };
                run.nodesCompleted++;

                debugLog.info('comp-run', `Image viewer "${nodeId}" pass-through`, {
                  filePath,
                });
                continue;
              }

              // ── Branch Node (conditional routing) ─────────────────
              if (node?.workflowId === '__branch__' && node.branchNode) {
                ns.status = 'running';
                ns.currentStep = 'Evaluating condition...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                // Resolve condition: use edge input 'condition' if connected, else template from config
                let conditionValue: unknown = edgeInputs['condition'];
                if (conditionValue === undefined) {
                  // Substitute {{var}} placeholders in the condition template
                  let conditionStr = node.branchNode.condition || 'false';
                  conditionStr = conditionStr.replace(/\{\{(\w+)\}\}/g, (_: string, varName: string) => {
                    const val = mergedInputs[varName];
                    if (val === undefined || val === null) return 'null';
                    if (typeof val === 'string') return JSON.stringify(val);
                    return String(val);
                  });
                  try {
                    conditionValue = new Function(`return (${conditionStr});`)();
                  } catch {
                    conditionValue = false;
                  }
                }

                const isTruthy = !!conditionValue;
                const inactivePort = isTruthy ? 'on_false' : 'on_true';

                // Skip nodes exclusively downstream of the inactive port
                const toSkip = getNodesExclusivelyDownstreamOfPort(nodeId, inactivePort, comp.edges);
                for (const skipId of toSkip) {
                  if (run.nodeStates[skipId]) {
                    run.nodeStates[skipId].status = 'skipped';
                  }
                }

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.currentStep = `Took: ${isTruthy ? 'true' : 'false'}`;
                // Pass through all inputs on both ports (downstream skip handles routing)
                ns.outputVariables = { on_true: mergedInputs, on_false: mergedInputs, ...mergedInputs };
                nodeOutputs[nodeId] = { ...mergedInputs };
                run.nodesCompleted++;

                debugLog.info('comp-run', `Branch "${nodeId}" evaluated: ${isTruthy}`, {
                  skipped: [...toSkip],
                });
                continue;
              }

              // ── Delay Node (timed pause) ──────────────────────────
              if (node?.workflowId === '__delay__' && node.delayNode) {
                ns.status = 'running';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                // Read delay from edge input or config
                const delayMs = typeof edgeInputs['delay_ms'] === 'number'
                  ? edgeInputs['delay_ms'] as number
                  : (node.delayNode.delayMs || 1000);

                ns.currentStep = `Waiting ${delayMs}ms...`;

                await new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, delayMs);
                  // Abort support
                  const onAbort = () => { clearTimeout(timer); resolve(); };
                  abort.signal.addEventListener('abort', onAbort, { once: true });
                });

                if (abort.signal.aborted) break;

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.currentStep = 'Done';
                ns.outputVariables = { ...mergedInputs };
                nodeOutputs[nodeId] = { ...mergedInputs };
                run.nodesCompleted++;

                debugLog.info('comp-run', `Delay "${nodeId}" waited ${delayMs}ms`);
                continue;
              }

              // ── Gate Node (conditional pass-through) ──────────────
              if (node?.workflowId === '__gate__' && node.gateNode) {
                ns.status = 'running';
                ns.currentStep = 'Checking gate...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                // Determine if gate is open: edge input 'open' overrides default
                const isOpen = edgeInputs['open'] !== undefined
                  ? !!edgeInputs['open']
                  : node.gateNode.defaultOpen;

                if (isOpen) {
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  ns.currentStep = 'Gate: OPEN';
                  // Wire data input → out output so downstream edges from gate:out carry the data value
                  const outValue = edgeInputs['data'] !== undefined ? edgeInputs['data'] : mergedInputs;
                  ns.outputVariables = { out: outValue, ...mergedInputs };
                  nodeOutputs[nodeId] = { out: outValue, ...mergedInputs };
                  run.nodesCompleted++;

                  debugLog.info('comp-run', `Gate "${nodeId}" is OPEN`, { hasData: edgeInputs['data'] !== undefined });
                } else {
                  const onClosed = node.gateNode.onClosed || 'skip';
                  if (onClosed === 'fail') {
                    // Fail the entire pipeline
                    ns.status = 'failed';
                    ns.stepsCompleted = 1;
                    ns.currentStep = 'Gate: CLOSED (pipeline failed)';
                    ns.error = `Condition not met: ${node.label || 'Gate'}`;

                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }
                    run.done = true;
                    run.success = false;
                    run.error = ns.error;
                    run.durationMs = Date.now() - run.startedAt;
                    await finalizeCompRunRecord(compRunId, run, executionOrder);

                    debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — pipeline FAILED`);
                    return;
                  } else if (onClosed === 'stop') {
                    ns.status = 'completed';
                    ns.stepsCompleted = 1;
                    ns.currentStep = 'Gate: CLOSED (stopping)';
                    run.nodesCompleted++;

                    // Skip all downstream and halt pipeline
                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }
                    run.done = true;
                    run.success = true; // Gate close is not an error
                    run.error = `Gate "${node.label || 'Gate'}" closed — pipeline stopped.`;
                    run.durationMs = Date.now() - run.startedAt;
                    await finalizeCompRunRecord(compRunId, run, executionOrder);

                    debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — stopping pipeline`);
                    return;
                  } else {
                    // 'skip' — skip downstream nodes
                    ns.status = 'completed';
                    ns.stepsCompleted = 1;
                    ns.currentStep = 'Gate: CLOSED (skipping downstream)';
                    run.nodesCompleted++;

                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }

                    debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — skipping ${downstream.size} downstream`);
                  }
                }
                continue;
              }

              // ── ForEach Loop Node ─────────────────────────────────
              if (node?.workflowId === '__for_each__' && node.forEachNode) {
                ns.status = 'running';
                ns.currentStep = 'Processing items...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                let items = edgeInputs['items'];
                if (typeof items === 'string') {
                  try { items = JSON.parse(items); } catch { /* keep as string */ }
                }

                const itemsArray = Array.isArray(items) ? items : [];
                const maxIter = node.forEachNode.maxIterations || 100;
                const limited = itemsArray.slice(0, maxIter);

                ns.currentStep = `Processing ${limited.length} items...`;

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.currentStep = `Done — ${limited.length} items`;
                ns.outputVariables = { results: limited, count: limited.length, current_item: limited[limited.length - 1] };
                nodeOutputs[nodeId] = { results: limited, count: limited.length, current_item: limited[limited.length - 1] };
                run.nodesCompleted++;

                debugLog.info('comp-run', `ForEach "${nodeId}" processed ${limited.length} items`);
                continue;
              }

              // ── Switch Node (multi-way routing) ───────────────────
              if (node?.workflowId === '__switch__' && node.switchNode) {
                ns.status = 'running';
                ns.currentStep = 'Evaluating switch...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                const switchValue = String(edgeInputs['value'] ?? '');
                const cases = node.switchNode.cases || [];
                const defaultPort = node.switchNode.defaultPort || 'on_default';

                // Find matching case
                let matchedPort: string | null = null;
                for (const c of cases) {
                  if (switchValue === c.value) {
                    matchedPort = c.port;
                    break;
                  }
                }

                const activePort = matchedPort || defaultPort;

                // Collect all output port names
                const allPorts = [...cases.map((c: { value: string; port: string }) => c.port), defaultPort];
                const inactivePorts = allPorts.filter((p: string) => p !== activePort);

                // Skip nodes exclusively downstream of each inactive port
                const allSkipped = new Set<string>();
                for (const inactivePort of inactivePorts) {
                  const toSkip = getNodesExclusivelyDownstreamOfPort(nodeId, inactivePort, comp.edges);
                  for (const skipId of toSkip) {
                    allSkipped.add(skipId);
                  }
                }
                for (const skipId of allSkipped) {
                  if (run.nodeStates[skipId]) {
                    run.nodeStates[skipId].status = 'skipped';
                  }
                }

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.currentStep = matchedPort ? `Matched: ${activePort}` : `Default: ${activePort}`;
                ns.outputVariables = { ...mergedInputs };
                nodeOutputs[nodeId] = { ...mergedInputs };
                run.nodesCompleted++;

                debugLog.info('comp-run', `Switch "${nodeId}" → ${activePort}`, {
                  value: switchValue,
                  skipped: [...allSkipped],
                });
                continue;
              }

              // ── Output Node (collector) ────────────────────────────
              if (node?.workflowId === '__output__' && node.outputNode) {
                ns.status = 'running';
                ns.currentStep = 'Collecting outputs...';
                run.currentNodeId = nodeId;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...mergedInputs };

                const pipelineOutputs: Record<string, unknown> = {};
                for (const port of node.outputNode.ports) {
                  pipelineOutputs[port.name] = mergedInputs[port.name];
                }

                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = pipelineOutputs;
                nodeOutputs[nodeId] = pipelineOutputs;
                run.pipelineOutputs = pipelineOutputs;
                run.nodesCompleted++;

                debugLog.info('comp-run', `Output node "${nodeId}" collected`, {
                  outputKeys: Object.keys(pipelineOutputs),
                });
                continue;
              }

              // ── Composition Node (sub-pipeline) ────────────────────
              if (node?.workflowId.startsWith('comp:') && node.compositionRef) {
                ns.status = 'running';
                ns.currentStep = 'Running sub-pipeline...';
                run.currentNodeId = nodeId;
                const subStart = Date.now();

                try {
                  const subCompId = node.compositionRef.compositionId;

                  // Cycle detection at runtime
                  const visited = new Set<string>();
                  visited.add(id); // current composition
                  function checkCycleSync(cid: string): boolean {
                    if (visited.has(cid)) return true;
                    return false;
                  }
                  if (checkCycleSync(subCompId)) {
                    throw new Error(`Circular pipeline reference detected: "${subCompId}" is already running`);
                  }

                  // Load sub-composition
                  const subDiscovered = await discoverCompositions(workDir);
                  const subFound = subDiscovered.find((d: any) => d.composition.id === subCompId);
                  if (!subFound) {
                    throw new Error(`Sub-pipeline "${subCompId}" not found`);
                  }
                  const subComp = subFound.composition;

                  // Gather inputs
                  const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                  const subInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                  ns.inputVariables = { ...subInputs };

                  // Resolve sub-composition's workflows
                  const subWfMap: Record<string, any> = {};
                  for (const subNode of subComp.nodes) {
                    if (subNode.workflowId === '__approval_gate__' || subNode.workflowId === '__script__' || subNode.workflowId === '__output__' || subNode.workflowId === '__image_viewer__' || subNode.workflowId === '__branch__' || subNode.workflowId === '__delay__' || subNode.workflowId === '__gate__' || subNode.workflowId === '__for_each__' || subNode.workflowId === '__switch__' || subNode.workflowId.startsWith('comp:')) continue;
                    const subWfFound = wfDiscovered.find((d: any) => d.workflow.id === subNode.workflowId);
                    if (!subWfFound) {
                      throw new Error(`Sub-pipeline workflow "${subNode.workflowId}" not found`);
                    }
                    subWfMap[subNode.id] = subWfFound.workflow;
                  }

                  // Topological sort for sub-composition
                  const subOrder = topoSort(subComp.nodes, subComp.edges);
                  const subNodeOutputs: Record<string, Record<string, unknown>> = {};
                  let subPipelineOutputs: Record<string, unknown> = {};

                  // Execute sub-composition nodes inline
                  for (const subNodeId of subOrder) {
                    if (abort.signal.aborted) break;
                    const subNode = subComp.nodes.find((n: any) => n.id === subNodeId);
                    if (!subNode) continue;

                    // Output node in sub-pipeline
                    if (subNode.workflowId === '__output__' && subNode.outputNode) {
                      const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                      const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                      for (const port of subNode.outputNode.ports) {
                        subPipelineOutputs[port.name] = subMerged[port.name];
                      }
                      subNodeOutputs[subNodeId] = subPipelineOutputs;
                      continue;
                    }

                    // Approval gate in sub-pipeline — skip (auto-approve)
                    if (subNode.workflowId === '__approval_gate__') {
                      const gateEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                      subNodeOutputs[subNodeId] = { ...subInputs, ...gateEdgeInputs };
                      continue;
                    }

                    // Script node in sub-pipeline
                    if (subNode.workflowId === '__script__' && subNode.script) {
                      const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                      const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };

                      let subFnBody = subNode.script.code;
                      const subFnMatch = subFnBody.match(/async\s+function\s+execute\s*\([^)]*\)\s*\{([\s\S]*)\}/);
                      if (subFnMatch) subFnBody = subFnMatch[1];

                      const { runPrompt: subRunPrompt } = await import('./loop/llm-service.js');
                      const subModel = process.env.ANTHROPIC_API_KEY ? 'claude-sonnet-4-20250514'
                        : process.env.OPENAI_API_KEY ? 'gpt-4o-mini'
                        : 'claude-sonnet-4-20250514';

                      // Build tools for sub-pipeline scripts (same pattern as main script handler)
                      const subScriptTools: Record<string, (params: any) => Promise<any>> = {};
                      const subExtTools = extensionManager?.getAllTools() ?? [];
                      for (const extTool of subExtTools) {
                        const toolHandler = extTool.handler;
                        subScriptTools[extTool.definition.name] = async (params: any) => {
                          const result = await toolHandler(params, { workingDirectory: workDir } as any);
                          if (typeof result === 'string') {
                            try { return JSON.parse(result); } catch { return result; }
                          }
                          return result;
                        };
                      }
                      if (Object.keys(subScriptTools).length === 0) {
                        try {
                          const { nanobanana: nb } = await import('./loop/tools/nanobanana.js');
                          subScriptTools.nanobanana = async (p: any) => JSON.parse(await nb(p as any, workDir));
                        } catch { /* tool not available */ }
                      }

                      const subScriptLogs: string[] = [];
                      const subContext = {
                        llm: {
                          generate: async (prompt: string, opts?: any) => {
                            const resp = await subRunPrompt([{ role: 'user', content: prompt }], opts?.model || subModel, { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.9 });
                            return resp.content.trim();
                          },
                          generateJSON: async (prompt: string, _schema?: any, opts?: any) => {
                            const resp = await subRunPrompt([{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }], opts?.model || subModel, { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.7 });
                            const text = resp.content.trim();
                            const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                            return JSON.parse(jsonMatch ? jsonMatch[1].trim() : text);
                          },
                        },
                        tools: subScriptTools,
                        log: (msg: string) => { subScriptLogs.push(String(msg)); },
                      };

                      const SubAsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                      const subFn = new SubAsyncFunction('inputs', 'context', 'require', subFnBody);
                      const subOutputs = await subFn(subMerged, subContext, require);
                      subNodeOutputs[subNodeId] = subOutputs || {};
                      continue;
                    }

                    // Image viewer in sub-pipeline — pass-through
                    if (subNode.workflowId === '__image_viewer__' && subNode.imageViewer) {
                      const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                      const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                      const imgPath = subMerged['file_path'] ?? subNode.imageViewer.filePath;
                      subNodeOutputs[subNodeId] = { file_path: imgPath };
                      continue;
                    }

                    // Regular workflow node in sub-pipeline
                    const subWf = subWfMap[subNodeId];
                    if (!subWf) continue;

                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMergedVars: Record<string, unknown> = {};
                    for (const v of (subWf.variables || [])) {
                      if (v.default !== undefined) subMergedVars[v.name] = v.default;
                    }
                    Object.assign(subMergedVars, subInputs, subEdgeInputs);
                    if (subNode.inputOverrides) {
                      for (const [k, v] of Object.entries(subNode.inputOverrides)) {
                        subMergedVars[k] = v;
                      }
                    }

                    ns.currentStep = `Sub-pipeline: ${subWf.name}`;

                    const subResult = await executeWorkflow(bridgeServer, subWf, subMergedVars, {
                      log: (msg: string) => debugLog.info('comp-run', `[sub:${subWf.name}] ${msg}`),
                      signal: abort.signal,
                    });
                    subNodeOutputs[subNodeId] = subResult.variables || {};
                  }

                  ns.durationMs = Date.now() - subStart;
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  ns.outputVariables = subPipelineOutputs;
                  run.nodesCompleted++;
                  nodeOutputs[nodeId] = subPipelineOutputs;

                  debugLog.info('comp-run', `Composition node "${nodeId}" completed`, {
                    subCompId: node.compositionRef.compositionId,
                    outputKeys: Object.keys(subPipelineOutputs),
                    durationMs: ns.durationMs,
                  });
                } catch (compErr: any) {
                  ns.durationMs = Date.now() - subStart;
                  ns.status = 'failed';
                  ns.error = `Sub-pipeline error: ${compErr?.message || String(compErr)}`;
                  debugLog.error('comp-run', `Composition node "${nodeId}" failed`, { error: String(compErr) });

                  const compPolicy = node.onFailure || { action: 'stop' as const };
                  if (compPolicy.action === 'skip') {
                    ns.status = 'skipped';
                    continue;
                  } else {
                    const downstream = getDownstreamNodes(nodeId, comp.edges);
                    for (const downId of downstream) {
                      if (run.nodeStates[downId]) {
                        run.nodeStates[downId].status = 'skipped';
                      }
                    }
                    run.done = true;
                    run.success = false;
                    run.error = ns.error;
                    run.durationMs = Date.now() - run.startedAt;
                    await finalizeCompRunRecord(compRunId, run, executionOrder);
                    return;
                  }
                }
                continue;
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

                ns.inputVariables = { ...mergedVars };

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
        pipelineOutputs: activeCompRun.pipelineOutputs,
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
          '--interacted-only',
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
                case 'early_stop':
                  activeTraining.totalEpochs = evt.epoch;
                  activeTraining.logs.push(
                    `Early stopped at epoch ${evt.epoch} (no improvement for ${evt.patience} epochs)`
                  );
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
        // Deduplicate: if a worker with the same host:port exists, update it
        const existing = workers.find(w => w.host === host && w.port === port);
        if (existing) {
          existing.name = name;
          await saveWorkers(workers);
          sendJson(res, 200, { worker: existing, exists: true });
          return;
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

    // GET /api/inference/status — check inference server status
    if (req.method === 'GET' && pathname === '/api/inference/status') {
      sendJson(res, 200, {
        running: inferenceServer !== null,
        model: inferenceModelPath,
        port: INFERENCE_PORT,
      });
      return;
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
      return;
    }

    // GET /api/workflows/:id/training/data — training data stats for a workflow
    const wfTrainingDataMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/training\/data$/);
    if (req.method === 'GET' && wfTrainingDataMatch) {
      const wfId = decodeURIComponent(wfTrainingDataMatch[1]);
      const workflowDataDir = join(homedir(), '.woodbury', 'data', 'workflows', wfId);
      const snapshotsRoot = join(workflowDataDir, 'snapshots');
      const cropsRoot = join(workflowDataDir, 'crops');

      const result: {
        snapshots: { total: number; fromRecording: number; fromExecution: number; totalElements: number; uniqueSelectors: number; interactionFiles: number; interactedSelectors: number; };
        crops: { total: number; uniqueGroups: number; interacted: number; nonInteracted: number; } | null;
        lastTraining: { version: string; backbone: string; epochs: number; embedDim: number; bestAuc: number; trainedAt: string; cropsPerElement: number; } | null;
      } = {
        snapshots: { total: 0, fromRecording: 0, fromExecution: 0, totalElements: 0, uniqueSelectors: 0, interactionFiles: 0, interactedSelectors: 0 },
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
      return;
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
      return;
    }

    // POST /api/workflows/:id/model/activate — set a specific version as active
    const wfActivateMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/model\/activate$/);
    if (req.method === 'POST' && wfActivateMatch) {
      const wfId = decodeURIComponent(wfActivateMatch[1]);
      const body = await readBody(req);
      const targetVersion = body?.version;
      if (!targetVersion) {
        sendJson(res, 400, { error: 'Missing "version" in request body' });
        return;
      }

      const wfModelDir = join(homedir(), '.woodbury', 'data', 'workflows', wfId, 'model');
      const registry = await readVersionRegistry(wfModelDir);
      if (!registry) {
        sendJson(res, 404, { error: 'No version registry found' });
        return;
      }

      const entry = registry.versions.find(v => v.version === targetVersion && v.status === 'complete');
      if (!entry) {
        sendJson(res, 404, { error: `Version ${targetVersion} not found or not complete` });
        return;
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
          await writeFile(found.path, JSON.stringify(wf, null, 2));
        } catch { /* best-effort */ }
      }

      sendJson(res, 200, { success: true, activeVersion: targetVersion });
      return;
    }

    // POST /api/workflows/:id/training/retry — re-trigger training for a workflow
    const wfRetryMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/training\/retry$/);
    if (req.method === 'POST' && wfRetryMatch) {
      const wfId = decodeURIComponent(wfRetryMatch[1]);
      const existing = workflowTrainings.get(wfId);
      if (existing && existing.phase !== 'complete' && existing.phase !== 'error') {
        sendJson(res, 409, { error: 'Training is still in progress' });
        return;
      }

      // Find workflow file
      const wfPath = existing?.workflowFilePath
        || join(workDir, '.woodbury-work', 'workflows', `${wfId}.workflow.json`);

      try {
        const wfContent = await readFile(wfPath, 'utf8');
        const wf = JSON.parse(wfContent);
        const site = wf.site || 'unknown';

        // Read optional training config from request body
        let trainingConfig: Partial<WorkflowTrainingConfig> | undefined;
        try {
          const body = await readBody(req);
          if (body && (body.backbone || body.epochs || body.embedDim)) {
            trainingConfig = {};
            if (body.backbone) trainingConfig.backbone = body.backbone;
            if (body.epochs) trainingConfig.epochs = parseInt(body.epochs, 10);
            if (body.embedDim) trainingConfig.embedDim = parseInt(body.embedDim, 10);
          }
        } catch { /* no body or invalid JSON — use defaults */ }

        workflowTrainings.delete(wfId);
        trainForWorkflow(wfId, site, wfPath, trainingConfig).catch(err => {
          debugLog.info('workflow-train', `Retry training failed for ${wfId}: ${String(err)}`);
        });

        sendJson(res, 200, { success: true, workflowId: wfId });
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

  // Persist dashboard URL so workers can auto-discover it
  try {
    const dataDir = join(homedir(), '.woodbury', 'data');
    mkdirSync(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'dashboard.json'),
      JSON.stringify({ url: dashboardUrl, port: assignedPort, pid: process.pid }, null, 2),
    );
  } catch {
    // Non-critical — workers can still use --register
  }

  if (verbose) {
    console.log(`[dashboard] Config dashboard at ${dashboardUrl}`);
  }

  // Start bridge server early so the extension can connect immediately
  ensureBridgeServer().catch(() => {});

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
      stopInferenceServer();
      discoverySocket?.close();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
