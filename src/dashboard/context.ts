/**
 * Dashboard Context Factory
 *
 * Creates the shared DashboardContext object that holds all mutable state
 * for the dashboard server. This replaces the closure-scoped variables
 * that were previously defined inside startDashboard().
 */

import type { Server } from 'node:http';
import type { ExtensionManager } from '../extension-manager.js';
import type { DashboardContext } from './types.js';

/**
 * Create a fresh DashboardContext with all state initialized to defaults.
 */
export function createDashboardContext(opts: {
  verbose: boolean;
  extensionManager?: ExtensionManager;
  workDir: string;
  staticDir: string;
  server: Server;
}): DashboardContext {
  return {
    // Injected dependencies
    verbose: opts.verbose,
    extensionManager: opts.extensionManager,
    workDir: opts.workDir,
    staticDir: opts.staticDir,
    server: opts.server,

    // Workflow execution state
    activeRun: null,
    activeRecorder: null,
    activeSnapshotCapture: null,
    debugSession: null,
    recordingSteps: [],
    recordingStatus: '',
    reRecordInfo: null,

    // Composition execution state
    activeCompRun: null,
    activeBatchRun: null,

    // Training state
    activeTraining: null,
    localWorker: null,
    pythonCheckCache: null,
    resolvedModelsCwd: undefined,
    pythonCmd: null,

    // Inference
    inferenceServer: null,
    inferenceModelPath: null,

    // Chat
    chatAgent: null,
    chatAgents: new Map(),
    chatAgentBusy: false,
    chatAgentBusySessionId: null,
    chatMcpManager: null,

    // Approvals
    pendingApprovals: new Map(),

    // Caches
    registryCache: null,
    registryCacheTime: 0,
  };
}
