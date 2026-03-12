/**
 * Dashboard Types
 *
 * Central type definitions for the dashboard server.
 * Defines the DashboardContext (shared mutable state passed to all route handlers),
 * execution state types, and the route handler signature.
 */

import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { ExtensionManager } from '../extension-manager.js';
import type { WorkflowRecorder } from '../workflow/recorder.js';
import type { ExecutionSnapshotCapture } from '../workflow/execution-snapshots.js';
import type { InferenceServer } from '../inference/index.js';

// ────────────────────────────────────────────────────────────────
//  Route handler signature
// ────────────────────────────────────────────────────────────────

/**
 * Route handler function signature.
 * Each route module exports one of these.
 * Returns `true` if the request was handled, `false` to pass to the next handler.
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  ctx: DashboardContext
) => Promise<boolean>;

// ────────────────────────────────────────────────────────────────
//  Execution state types
// ────────────────────────────────────────────────────────────────

/** Workflow execution run state */
export interface ActiveRunState {
  runId?: string;
  workflowId: string;
  workflowName: string;
  abort: AbortController;
  startedAt: number;
  stepsTotal: number;
  stepsCompleted: number;
  currentStep: string;
  stepResults: Array<{
    index: number;
    label: string;
    type: string;
    status: string;
    error?: string;
  }>;
  done: boolean;
  success: boolean;
  error?: string;
  durationMs?: number;
  outputVariables?: Record<string, unknown>;
  trainingDataKept?: boolean;
}

/** Composition/pipeline execution run state */
export interface ActiveCompRunState {
  runId?: string;
  compositionId: string;
  compositionName: string;
  abort: AbortController;
  startedAt: number;
  nodesTotal: number;
  nodesCompleted: number;
  currentNodeId: string | null;
  executionOrder: string[];
  nodeStates: Record<string, CompNodeState>;
  done: boolean;
  success: boolean;
  error?: string;
  durationMs?: number;
  pipelineOutputs?: Record<string, unknown>;
}

/** State of a single composition node during execution */
export interface CompNodeState {
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
  subExecutionOrder?: string[];
  subNodeStates?: Record<string, CompNodeState>;
}

/** Debug mode state (visual step-through) */
export interface DebugSessionState {
  workflowId: string;
  workflowName: string;
  workflow: any;
  flatSteps: any[];
  variables: Record<string, unknown>;
  currentIndex: number;
  completedIndices: number[];
  failedIndices: number[];
  stepResults: any[];
}

/** Batch run state */
export interface ActiveBatchRunState {
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
}

/** Training subprocess state */
export interface ActiveTrainingState {
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
}

/** Local training worker state */
export interface LocalWorkerState {
  process: ChildProcess;
  port: number;
  logs: string[];
  startedAt: number;
}

/** Worker settings (configurable woobury-models path) */
export interface WorkerSettings {
  autoStart: boolean;
  port: number;
  wooburyModelsPath: string | null;
}

/** Python environment check result */
export interface PythonCheckResult {
  pythonAvailable: boolean;
  pythonVersion: string | null;
  pythonCmd: string;
  wooburyModelsInstalled: boolean;
  gpuAvailable: boolean;
  gpuName: string | null;
  checkedAt: number;
}

/** Script tool documentation entry */
export interface ScriptToolDoc {
  toolName: string;
  customDescription?: string;
  examples?: string[];
  notes?: string;
  returns?: string;
  enabled: boolean;
}

// ────────────────────────────────────────────────────────────────
//  Dashboard Context — shared mutable state for all route handlers
// ────────────────────────────────────────────────────────────────

/**
 * DashboardContext holds all shared mutable state that was previously
 * captured as closure variables inside `startDashboard()`.
 *
 * Each route handler receives this context and can read/mutate it.
 * Only one context instance exists per dashboard server.
 */
export interface DashboardContext {
  // ── Injected dependencies ──
  verbose: boolean;
  extensionManager?: ExtensionManager;
  workDir: string;
  staticDir: string;
  server: Server;

  // ── Workflow execution state ──
  activeRun: ActiveRunState | null;
  activeRecorder: WorkflowRecorder | null;
  activeSnapshotCapture: ExecutionSnapshotCapture | null;
  debugSession: DebugSessionState | null;
  recordingSteps: Array<{ index: number; label: string; type: string }>;
  recordingStatus: string;
  reRecordInfo: { workflowId: string; filePath: string } | null;

  // ── Composition execution state ──
  activeCompRun: ActiveCompRunState | null;
  activeBatchRun: ActiveBatchRunState | null;

  // ── Training state ──
  activeTraining: ActiveTrainingState | null;
  localWorker: LocalWorkerState | null;
  pythonCheckCache: PythonCheckResult | null;
  resolvedModelsCwd: string | null | undefined;
  pythonCmd: string | null;

  // ── Inference ──
  inferenceServer: InferenceServer | null;
  inferenceModelPath: string | null;

  // ── Chat ──
  chatAgent: any;
  chatAgents: Map<string, any>;
  chatAgentBusy: boolean;
  chatAgentBusySessionId: string | null;
  chatMcpManager: any;

  // ── Approvals ──
  pendingApprovals: Map<string, any>;

  // ── Caches ──
  registryCache: any;
  registryCacheTime: number;
}

// ────────────────────────────────────────────────────────────────
//  Public handle returned to callers
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
