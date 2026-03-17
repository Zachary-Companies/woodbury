/**
 * Dashboard Route: Pipeline App Mode
 *
 * Transforms a pipeline into an interactive application with editable outputs,
 * navigation sections derived from the pipeline graph, and selective re-execution.
 *
 * Endpoints:
 *   GET  /api/app/:id/schema    — derive navigation structure from pipeline
 *   GET  /api/app/:id/state     — load persisted app state
 *   PUT  /api/app/:id/state/:nodeId — save manual edits, mark downstream stale
 *   POST /api/app/:id/invoke/:nodeId — re-execute a single node
 *   POST /api/app/:id/refresh-stale  — re-run only stale downstream nodes
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import { topoSort, gatherInputVariables, getDownstreamNodes } from '../graph-utils.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const APP_STATE_DIR = join(homedir(), '.woodbury', 'data', 'app-state');
const RUNS_FILE = join(homedir(), '.woodbury', 'data', 'runs.json');

// Node types that should NOT appear as visible sections in the app
const HIDDEN_NODE_TYPES = new Set([
  '__branch__', '__delay__', '__gate__', '__junction__', '__switch__',
  '__for_each__', '__approval_gate__', '__get_variable__',
]);

// Node types that are settings (grouped into Settings section)
const SETTINGS_NODE_TYPES = new Set(['__variable__']);

// ────────────────────────────────────────────────────────────────
//  App State Types
// ────────────────────────────────────────────────────────────────

interface AppNodeData {
  outputs: Record<string, unknown>;
  updatedAt: string;
  manuallyEdited: boolean;
}

interface AppState {
  pipelineId: string;
  pipelineName: string;
  sourceRunId: string | null;
  nodeData: Record<string, AppNodeData>;
  staleNodes: string[];
  lastRunAt: string | null;
}

// ────────────────────────────────────────────────────────────────
//  Schema types
// ────────────────────────────────────────────────────────────────

interface AppSectionPort {
  name: string;
  type: string;
  description: string;
  presentation?: Record<string, unknown>;
}

interface AppSection {
  id: string;
  type: 'overview' | 'settings' | 'node-output';
  nodeId?: string;
  label: string;
  icon: string;
  description?: string;
  outputPorts: AppSectionPort[];
  canRegenerate: boolean;
  downstreamNodeIds: string[];
  upstreamNodeIds: string[];
}

interface AppSchema {
  pipelineId: string;
  name: string;
  description: string;
  sections: AppSection[];
  edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>;
  executionOrder: string[];
}

// ────────────────────────────────────────────────────────────────
//  Directory-based project storage
//
//  Each pipeline's app state is a directory:
//    ~/.woodbury/data/app-state/{pipeline-id}/
//      _manifest.json           — metadata, stale nodes, timestamps
//      {nodeId}.json            — per-node output data
//
//  This makes individual node reads/writes fast and avoids loading
//  the entire project into memory for a single edit.
// ────────────────────────────────────────────────────────────────

interface AppManifest {
  pipelineId: string;
  pipelineName: string;
  sourceRunId: string | null;
  staleNodes: string[];
  lastRunAt: string | null;
  /** Per-node metadata (timestamps, edited flag) — NOT the data itself */
  nodes: Record<string, { updatedAt: string; manuallyEdited: boolean }>;
}

function projectDir(pipelineId: string): string {
  return join(APP_STATE_DIR, pipelineId);
}

function manifestPath(pipelineId: string): string {
  return join(projectDir(pipelineId), '_manifest.json');
}

function nodeDataPath(pipelineId: string, nodeId: string): string {
  // Sanitize nodeId for filesystem safety
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(projectDir(pipelineId), `${safe}.json`);
}

async function loadManifest(pipelineId: string): Promise<AppManifest | null> {
  try {
    const raw = await readFile(manifestPath(pipelineId), 'utf-8');
    return JSON.parse(raw) as AppManifest;
  } catch {
    return null;
  }
}

async function saveManifest(manifest: AppManifest): Promise<void> {
  await mkdir(projectDir(manifest.pipelineId), { recursive: true });
  await atomicWriteFile(manifestPath(manifest.pipelineId), JSON.stringify(manifest, null, 2));
}

async function loadNodeData(pipelineId: string, nodeId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(nodeDataPath(pipelineId, nodeId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveNodeData(pipelineId: string, nodeId: string, outputs: Record<string, unknown>): Promise<void> {
  await mkdir(projectDir(pipelineId), { recursive: true });
  await atomicWriteFile(nodeDataPath(pipelineId, nodeId), JSON.stringify(outputs, null, 2));
}

/** Load full app state by reading manifest + all node files */
async function loadAppState(pipelineId: string): Promise<AppState | null> {
  const manifest = await loadManifest(pipelineId);
  if (!manifest) return null;

  const nodeData: Record<string, AppNodeData> = {};
  for (const [nodeId, meta] of Object.entries(manifest.nodes)) {
    const outputs = await loadNodeData(pipelineId, nodeId);
    if (outputs) {
      nodeData[nodeId] = { outputs, ...meta };
    }
  }

  return {
    pipelineId: manifest.pipelineId,
    pipelineName: manifest.pipelineName,
    sourceRunId: manifest.sourceRunId,
    nodeData,
    staleNodes: manifest.staleNodes,
    lastRunAt: manifest.lastRunAt,
  };
}

/** Save full app state: manifest + per-node files */
async function saveAppState(state: AppState): Promise<void> {
  const manifest: AppManifest = {
    pipelineId: state.pipelineId,
    pipelineName: state.pipelineName,
    sourceRunId: state.sourceRunId,
    staleNodes: state.staleNodes,
    lastRunAt: state.lastRunAt,
    nodes: {},
  };

  for (const [nodeId, data] of Object.entries(state.nodeData)) {
    manifest.nodes[nodeId] = {
      updatedAt: data.updatedAt,
      manuallyEdited: data.manuallyEdited,
    };
    await saveNodeData(state.pipelineId, nodeId, data.outputs);
  }

  await saveManifest(manifest);
}

async function findPipeline(workDir: string, pipelineId: string): Promise<any | null> {
  const discovered = await discoverCompositions(workDir);
  const entry = discovered.find((d: any) => d?.composition?.id === pipelineId);
  return entry?.composition || null;
}

/** Seed app state from the latest completed run for this pipeline */
async function seedFromLatestRun(pipelineId: string, pipelineName: string): Promise<AppState | null> {
  try {
    const raw = await readFile(RUNS_FILE, 'utf-8');
    const runs = JSON.parse(raw) as any[];
    const matching = runs.filter(
      (r: any) => r.type === 'pipeline' && r.sourceId === pipelineId && r.status === 'completed',
    );
    if (matching.length === 0) return null;
    const latest = matching[matching.length - 1];

    const nodeData: Record<string, AppNodeData> = {};
    const now = new Date().toISOString();
    if (Array.isArray(latest.nodeResults)) {
      for (const nr of latest.nodeResults) {
        if (nr.outputVariables && Object.keys(nr.outputVariables).length > 0) {
          nodeData[nr.nodeId] = {
            outputs: nr.outputVariables,
            updatedAt: now,
            manuallyEdited: false,
          };
        }
      }
    }

    return {
      pipelineId,
      pipelineName,
      sourceRunId: latest.id || null,
      nodeData,
      staleNodes: [],
      lastRunAt: latest.startedAt || now,
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
//  Auto-save from pipeline runs (called by composition-run.ts)
// ────────────────────────────────────────────────────────────────

/**
 * Persist node outputs from a completed pipeline run as app state.
 * Called automatically after every pipeline run finishes.
 * Preserves manually-edited nodes — only overwrites nodes that were
 * actually re-executed in this run.
 */
export async function persistAppStateFromRun(
  pipelineId: string,
  pipelineName: string,
  runId: string,
  nodeOutputs: Record<string, Record<string, unknown>>,
  executionOrder: string[],
): Promise<void> {
  try {
    const now = new Date().toISOString();

    // Load existing manifest to preserve manual edits
    let manifest = await loadManifest(pipelineId);
    if (!manifest) {
      manifest = {
        pipelineId,
        pipelineName,
        sourceRunId: runId,
        staleNodes: [],
        lastRunAt: now,
        nodes: {},
      };
    } else {
      manifest.sourceRunId = runId;
      manifest.lastRunAt = now;
      manifest.pipelineName = pipelineName;
      // Clear stale for any nodes that were re-executed
      manifest.staleNodes = manifest.staleNodes.filter(
        (sId) => !executionOrder.includes(sId),
      );
    }

    // Write per-node files for nodes that produced output
    for (const nodeId of executionOrder) {
      const outputs = nodeOutputs[nodeId];
      if (!outputs || Object.keys(outputs).length === 0) continue;

      // Don't overwrite manually-edited nodes unless they were re-executed
      const existing = manifest.nodes[nodeId];
      if (existing?.manuallyEdited) {
        // Node was manually edited but re-executed — update with fresh data
        // (this happens during "refresh stale" flows)
      }

      await saveNodeData(pipelineId, nodeId, outputs);
      manifest.nodes[nodeId] = {
        updatedAt: now,
        manuallyEdited: false,
      };
    }

    await saveManifest(manifest);
    debugLog.info('app-state', `Auto-saved app state for "${pipelineName}"`, {
      pipelineId,
      runId,
      nodeCount: Object.keys(manifest.nodes).length,
    });
  } catch (err) {
    debugLog.error('app-state', `Failed to auto-save app state for "${pipelineName}"`, {
      error: String(err),
    });
  }
}

function getNodeOutputPorts(node: any): AppSectionPort[] {
  // Script nodes (inline)
  if (node.workflowId === '__script__' && node.script?.outputs) {
    return node.script.outputs.map((p: any) => ({
      name: p.name,
      type: p.type || 'string',
      description: p.description || '',
      presentation: p.presentation,
    }));
  }
  // Script file nodes (v2)
  if (node.workflowId === '__script_file__' && node.scriptFile?.outputs) {
    return node.scriptFile.outputs.map((p: any) => ({
      name: p.name,
      type: p.type || 'string',
      description: p.description || '',
      presentation: p.presentation,
    }));
  }
  // Output node
  if (node.workflowId === '__output__' && node.outputNode?.ports) {
    return node.outputNode.ports.map((p: any) => ({
      name: p.name,
      type: p.type || 'string',
      description: p.description || '',
      presentation: p.presentation,
    }));
  }
  // Text node
  if (node.workflowId === '__text__') {
    return [{ name: 'text', type: 'string', description: 'Text content' }];
  }
  // File read
  if (node.workflowId === '__file_read__') {
    return [
      { name: 'content', type: 'string', description: 'File contents' },
      { name: 'filePath', type: 'string', description: 'File path' },
    ];
  }
  // File write
  if (node.workflowId === '__file_write__') {
    return [
      { name: 'filePath', type: 'string', description: 'Written file path' },
      { name: 'success', type: 'boolean', description: 'Write success' },
    ];
  }
  // Tool node
  if (node.workflowId === '__tool__') {
    return [{ name: 'result', type: 'object', description: 'Tool result' }];
  }
  return [];
}

function getNodeIcon(workflowId: string): string {
  switch (workflowId) {
    case '__output__': return 'output';
    case '__variable__': return 'settings';
    case '__script__':
    case '__script_file__': return 'code';
    case '__text__': return 'text';
    case '__file_read__':
    case '__file_write__':
    case '__file_op__': return 'file';
    case '__tool__': return 'tool';
    case '__asset__': return 'asset';
    case '__media__':
    case '__image_viewer__': return 'media';
    default: return 'workflow';
  }
}

function humanizeNodeLabel(node: any): string {
  if (node.label) return node.label;
  if (node.workflowId === '__output__') return 'Overview';
  if (node.workflowId === '__variable__') return node.variableNode?.inputName || 'Variable';
  return node.workflowId.replace(/^__/, '').replace(/__$/, '').replace(/_/g, ' ');
}

// ────────────────────────────────────────────────────────────────
//  Schema derivation
// ────────────────────────────────────────────────────────────────

function deriveAppSchema(pipeline: any): AppSchema {
  const nodes: any[] = pipeline.nodes || [];
  const edges: any[] = pipeline.edges || [];

  // Topo-sort for execution order
  let executionOrder: string[];
  try {
    executionOrder = topoSort(nodes, edges);
  } catch {
    executionOrder = nodes.map((n: any) => n.id);
  }

  const sections: AppSection[] = [];

  // 1. Settings section (all exposed variable nodes grouped together)
  const settingsFields: any[] = [];
  for (const node of nodes) {
    if (node.workflowId === '__variable__' && node.variableNode?.exposeAsInput) {
      settingsFields.push({
        nodeId: node.id,
        name: node.variableNode.inputName || node.id,
        type: node.variableNode.type || 'string',
        label: node.label || node.variableNode.inputName || 'Variable',
        description: node.variableNode.description || '',
        required: node.variableNode.required === true,
        default: node.variableNode.initialValue,
        objectFields: node.variableNode.objectFields,
        options: node.variableNode.options,
        inputControl: node.variableNode.inputControl,
      });
    }
  }
  if (settingsFields.length > 0) {
    sections.push({
      id: '_settings',
      type: 'settings',
      label: 'Settings',
      icon: 'settings',
      description: 'Pipeline input configuration',
      outputPorts: settingsFields.map((f: any) => ({
        name: f.name,
        type: f.type,
        description: f.description,
      })),
      canRegenerate: false,
      downstreamNodeIds: [],
      upstreamNodeIds: [],
    });
  }

  // 2. Output node becomes "Overview" section (always first content section)
  const outputNode = nodes.find((n: any) => n.workflowId === '__output__');
  if (outputNode) {
    sections.push({
      id: '_overview',
      type: 'overview',
      nodeId: outputNode.id,
      label: 'Overview',
      icon: 'output',
      description: 'Final pipeline outputs',
      outputPorts: getNodeOutputPorts(outputNode),
      canRegenerate: true,
      downstreamNodeIds: [],
      upstreamNodeIds: [...getDownstreamNodes(outputNode.id, edges.map((e: any) => ({
        sourceNodeId: e.targetNodeId,
        targetNodeId: e.sourceNodeId,
      })))], // reverse edges to get upstream
    });
  }

  // 3. Processing nodes become content sections
  for (const nodeId of executionOrder) {
    const node = nodes.find((n: any) => n.id === nodeId);
    if (!node) continue;

    // Skip hidden, variable, and output nodes (already handled above)
    if (HIDDEN_NODE_TYPES.has(node.workflowId)) continue;
    if (SETTINGS_NODE_TYPES.has(node.workflowId)) continue;
    if (node.workflowId === '__output__') continue;

    const outputPorts = getNodeOutputPorts(node);
    // Skip nodes with no outputs (they're internal plumbing)
    if (outputPorts.length === 0 && node.workflowId !== '__text__') continue;

    const downstream = getDownstreamNodes(nodeId, edges);

    sections.push({
      id: nodeId,
      type: 'node-output',
      nodeId,
      label: humanizeNodeLabel(node),
      icon: getNodeIcon(node.workflowId),
      description: node.script?.description || node.scriptFile?.description || '',
      outputPorts,
      canRegenerate: node.workflowId === '__script__' || node.workflowId === '__script_file__' || !node.workflowId.startsWith('__'),
      downstreamNodeIds: [...downstream],
      upstreamNodeIds: edges.filter((e: any) => e.targetNodeId === nodeId).map((e: any) => e.sourceNodeId),
    });
  }

  return {
    pipelineId: pipeline.id,
    name: pipeline.name || 'Untitled Pipeline',
    description: pipeline.description || '',
    sections,
    edges: edges.map((e: any) => ({
      sourceNodeId: e.sourceNodeId,
      sourcePort: e.sourcePort || '',
      targetNodeId: e.targetNodeId,
      targetPort: e.targetPort || '',
    })),
    executionOrder,
  };
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handlePipelineAppRoutes: RouteHandler = async (req, res, pathname, _url, ctx) => {
  // Match /api/app/:id/* patterns
  const appMatch = pathname.match(/^\/api\/app\/([^/]+)(\/.*)?$/);
  if (!appMatch) return false;

  const pipelineId = decodeURIComponent(appMatch[1]);
  const subPath = appMatch[2] || '';

  // ── GET /api/app/:id/schema ──────────────────────────────
  if (req.method === 'GET' && subPath === '/schema') {
    const pipeline = await findPipeline(ctx.workDir, pipelineId);
    if (!pipeline) {
      sendJson(res, 404, { error: 'Pipeline not found' });
      return true;
    }
    const schema = deriveAppSchema(pipeline);
    sendJson(res, 200, schema);
    return true;
  }

  // ── GET /api/app/:id/state ───────────────────────────────
  if (req.method === 'GET' && subPath === '/state') {
    let state = await loadAppState(pipelineId);
    if (!state) {
      // Try to seed from latest run
      const pipeline = await findPipeline(ctx.workDir, pipelineId);
      const name = pipeline?.name || pipelineId;
      state = await seedFromLatestRun(pipelineId, name);
      if (state) {
        await saveAppState(state);
      } else {
        // Return empty state
        state = {
          pipelineId,
          pipelineName: name,
          sourceRunId: null,
          nodeData: {},
          staleNodes: [],
          lastRunAt: null,
        };
      }
    }
    sendJson(res, 200, state);
    return true;
  }

  // ── PUT /api/app/:id/state/:nodeId ───────────────────────
  // Saves a single node's data (fast — only writes one file + manifest)
  const stateMatch = subPath.match(/^\/state\/([^/]+)$/);
  if (req.method === 'PUT' && stateMatch) {
    const nodeId = decodeURIComponent(stateMatch[1]);
    const body = await readBody(req);
    const now = new Date().toISOString();

    // Load or create manifest (lightweight — no node data loaded)
    let manifest = await loadManifest(pipelineId);
    if (!manifest) {
      const pipeline = await findPipeline(ctx.workDir, pipelineId);
      manifest = {
        pipelineId,
        pipelineName: pipeline?.name || pipelineId,
        sourceRunId: null,
        staleNodes: [],
        lastRunAt: null,
        nodes: {},
      };
    }

    // Write just this node's data file
    const outputs = body.outputs || body;
    await saveNodeData(pipelineId, nodeId, outputs);

    // Update manifest metadata for this node
    manifest.nodes[nodeId] = {
      updatedAt: now,
      manuallyEdited: true,
    };

    // Mark downstream nodes as stale
    const pipeline = await findPipeline(ctx.workDir, pipelineId);
    if (pipeline) {
      const downstream = getDownstreamNodes(nodeId, pipeline.edges || []);
      const staleSet = new Set(manifest.staleNodes);
      for (const dsId of downstream) {
        staleSet.add(dsId);
      }
      manifest.staleNodes = [...staleSet];
    }

    await saveManifest(manifest);
    sendJson(res, 200, {
      success: true,
      staleNodes: manifest.staleNodes,
      updatedAt: now,
    });
    return true;
  }

  // ── POST /api/app/:id/refresh-from-run ───────────────────
  // Refresh app state from the latest completed run
  if (req.method === 'POST' && subPath === '/refresh-from-run') {
    const pipeline = await findPipeline(ctx.workDir, pipelineId);
    const name = pipeline?.name || pipelineId;
    const state = await seedFromLatestRun(pipelineId, name);
    if (state) {
      await saveAppState(state);
      sendJson(res, 200, state);
    } else {
      sendJson(res, 404, { error: 'No completed runs found for this pipeline' });
    }
    return true;
  }

  // ── POST /api/app/:id/mark-stale ─────────────────────────
  if (req.method === 'POST' && subPath === '/mark-stale') {
    const body = await readBody(req);
    const nodeIds: string[] = Array.isArray(body.nodeIds) ? body.nodeIds : [];

    let manifest = await loadManifest(pipelineId);
    if (!manifest) {
      sendJson(res, 404, { error: 'No app state found' });
      return true;
    }

    const staleSet = new Set(manifest.staleNodes);
    for (const id of nodeIds) staleSet.add(id);
    manifest.staleNodes = [...staleSet];
    await saveManifest(manifest);
    sendJson(res, 200, { staleNodes: manifest.staleNodes });
    return true;
  }

  // ── GET /api/app/:id/node/:nodeId ────────────────────────
  // Load a single node's output data (fast — reads one file)
  const nodeMatch = subPath.match(/^\/node\/([^/]+)$/);
  if (req.method === 'GET' && nodeMatch) {
    const nodeId = decodeURIComponent(nodeMatch[1]);
    const manifest = await loadManifest(pipelineId);
    const meta = manifest?.nodes[nodeId];
    const outputs = await loadNodeData(pipelineId, nodeId);
    if (!outputs) {
      sendJson(res, 404, { error: 'No data for this node' });
      return true;
    }
    sendJson(res, 200, {
      nodeId,
      outputs,
      updatedAt: meta?.updatedAt || null,
      manuallyEdited: meta?.manuallyEdited || false,
      isStale: manifest?.staleNodes.includes(nodeId) || false,
    });
    return true;
  }

  return false;
};
