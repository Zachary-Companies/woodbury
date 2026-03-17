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

import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import { topoSort, gatherInputVariables, getDownstreamNodes } from '../graph-utils.js';
import { debugLog } from '../../debug-log.js';
import { loadBindings, getTargetIds } from '../pipeline-bindings.js';

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

  // ── GET /api/app/:id/bindings ────────────────────────────────
  // Get bindings for the pipeline's app view
  if (req.method === 'GET' && subPath === '/bindings') {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (entry?.isV2Pipeline && entry.pipelineDir) {
      const bindingsDoc = await loadBindings(entry.pipelineDir);
      sendJson(res, 200, bindingsDoc);
    } else {
      sendJson(res, 200, { version: '1.0', pipelineId, bindings: [] });
    }
    return true;
  }

  // ── POST /api/app/:id/generate-previs ──────────────────────
  // Generate or regenerate a previs image for a shot element.
  // Resolves character headshots and location references from the
  // pipeline's asset data and passes them as reference images to
  // the nanobanana image generator.
  if (req.method === 'POST' && subPath === '/generate-previs') {
    const body = await readBody(req);
    const elementId: string = body.elementId;
    const promptOverrides: Record<string, string> = body.promptOverrides || {};
    const model: 'flash' | 'pro' = body.model || 'flash';
    const aspectRatio: string = body.aspectRatio || '16:9';

    if (!elementId) {
      sendJson(res, 400, { error: 'elementId required' });
      return true;
    }

    // Collect all screenplay data from app state
    const screenplay = await collectScreenplayData(pipelineId);
    if (!screenplay) {
      sendJson(res, 404, { error: 'No screenplay data found in app state' });
      return true;
    }

    // Find the previs entry for this element
    const previs = screenplay.previsMap[elementId];
    const element = screenplay.elementMap[elementId];
    if (!element) {
      sendJson(res, 404, { error: 'Element not found: ' + elementId });
      return true;
    }

    // Gather reference images — character headshots + location landscape
    const referenceImages: string[] = [];
    const refDescriptions: string[] = [];

    // Try to resolve character bindings first (pipeline-specific connections)
    // Falls back to previs.characterIds if no bindings exist
    let characterIds: string[] = [];

    // Check for pipeline bindings
    const compositions = await discoverCompositions();
    const pipelineEntry = compositions.find(c => c.composition.id === pipelineId);
    if (pipelineEntry?.isV2Pipeline && pipelineEntry.pipelineDir) {
      const bindingsDoc = await loadBindings(pipelineEntry.pipelineDir);
      if (bindingsDoc.bindings.length > 0) {
        // Use bindings: "which characters does this shot depict?"
        characterIds = getTargetIds(bindingsDoc, 'shot', elementId, 'depicts');
        debugLog.info('generate-previs', `Using ${characterIds.length} characters from bindings for ${elementId}`);
      }
    }

    // Fall back to previs.characterIds if no bindings found
    if (characterIds.length === 0) {
      characterIds = previs?.characterIds || [];
    }

    for (const charId of characterIds) {
      const charAsset = screenplay.characterAssets[charId];
      if (charAsset?.filePath && fileExists(charAsset.filePath)) {
        referenceImages.push(charAsset.filePath);
        const charData = screenplay.characters[charId];
        const desc = charData?.description || charData?.name || charId;
        refDescriptions.push(
          `Reference image ${referenceImages.length} is ${charData?.displayName || charData?.name || charId}` +
          (desc ? ` (${desc.substring(0, 120)})` : '')
        );
      }
    }

    // Location — check bindings first, fall back to previs.locationId
    let locationId = previs?.locationId;
    if (!locationId && pipelineEntry?.isV2Pipeline && pipelineEntry.pipelineDir) {
      const bindingsDoc = await loadBindings(pipelineEntry.pipelineDir);
      const locIds = getTargetIds(bindingsDoc, 'shot', elementId, 'set-in');
      if (locIds.length > 0) locationId = locIds[0];
    }
    if (locationId) {
      const locAsset = screenplay.locationAssets[locationId];
      if (locAsset?.filePath && fileExists(locAsset.filePath)) {
        referenceImages.push(locAsset.filePath);
        const locData = screenplay.locations[locationId];
        refDescriptions.push(
          `Reference image ${referenceImages.length} is the location "${locData?.name || locationId}"` +
          (locData?.description ? ` (${locData.description.substring(0, 120)})` : '')
        );
      }
    }

    // Build the generation prompt following the Nano Banana prompting guide:
    //   Formula: [Reference images] + [Relationship instruction] + [New scenario]
    //   With: [Subject] + [Action] + [Location/context] + [Composition] + [Style]
    //   Best practices: narrative descriptions (not keyword lists), positive framing,
    //   specific camera/lens/lighting, color grading, materiality emphasis.
    const shotText = element.shotText || element.content || '';
    const previsDescription = promptOverrides.description || previs?.description || shotText;
    const cameraIntent = promptOverrides.cameraIntent || previs?.cameraIntent || '';
    const composition = promptOverrides.composition || previs?.composition || '';
    const lighting = promptOverrides.lighting || previs?.lighting || '';

    // Derive camera/lens details from shot metadata
    const frameSize = element.frameSize || '';
    const cameraMovement = element.cameraMovement || '';
    const duration = previs?.durationSeconds || 0;

    // Map frame sizes to lens descriptions for the prompt
    const lensMap: Record<string, string> = {
      'WIDE': 'wide-angle lens (24mm), deep depth of field',
      'EXTREME WIDE': 'ultra wide-angle lens (16mm), expansive depth of field',
      'MEDIUM': 'standard lens (50mm), natural perspective with moderate depth of field',
      'MEDIUM CLOSE-UP': '85mm portrait lens, shallow depth of field (f/2.8)',
      'CLOSE-UP': '85mm portrait lens, very shallow depth of field (f/1.8)',
      'EXTREME CLOSE-UP': 'macro lens (100mm), extremely shallow depth of field (f/1.4)',
    };
    const lensDesc = lensMap[frameSize.toUpperCase()] || '';

    // Map camera movements to cinematic technique descriptions
    const movementMap: Record<string, string> = {
      'STATIC': 'locked-off camera on a tripod, perfectly still frame',
      'PAN': 'smooth horizontal pan following the action',
      'TILT': 'gentle vertical tilt revealing the scene',
      'DOLLY': 'dolly tracking shot moving through the space',
      'SLOW PUSH IN': 'subtle dolly push-in, gradually tightening the frame',
      'PUSH IN': 'dolly push-in toward the subject',
      'PULL BACK': 'slow dolly pull-back revealing the wider scene',
      'TRACKING': 'tracking shot moving alongside the subject',
      'CRANE': 'crane shot with elevated, sweeping perspective',
      'HANDHELD': 'handheld camera with slight organic movement',
      'STEADICAM': 'smooth Steadicam floating through the scene',
    };
    const movementDesc = movementMap[cameraMovement.toUpperCase()] || '';

    let prompt = '';

    // [Reference images] + [Relationship instruction]
    if (referenceImages.length > 0) {
      prompt += 'Using the attached reference images as visual guides for character appearance and location setting: ';
      prompt += refDescriptions.join('. ') + '. ';
      prompt += 'The characters in this frame must match these references exactly — same face, hair, body type, clothing, and features. ';
      prompt += 'The environment should be consistent with the location reference.\n\n';
    }

    // [Subject] + [Action] — narrative scene description
    prompt += previsDescription;
    if (previsDescription !== shotText && shotText) {
      prompt += ` The camera captures: ${shotText}`;
    }
    prompt += '\n\n';

    // [Composition] — camera, lens, and framing
    if (lensDesc || movementDesc || composition) {
      prompt += 'Shot on a cinema camera';
      if (lensDesc) prompt += ` with a ${lensDesc}`;
      prompt += '. ';
      if (movementDesc) prompt += `Camera technique: ${movementDesc}. `;
      if (composition) prompt += composition + '. ';
      prompt += '\n\n';
    }

    // [Lighting]
    if (lighting) {
      prompt += `Lighting: ${lighting}. `;
    }
    if (cameraIntent && cameraIntent !== composition) {
      prompt += cameraIntent + '. ';
    }
    if (lighting || cameraIntent) prompt += '\n\n';

    // [Style] — cinematic film stock and color grading
    prompt += 'Style: Cinematic previsualization frame, shot on 35mm film with subtle grain. ';
    prompt += 'Professional cinematography with rich color grading, deep shadows, and controlled highlights. ';
    prompt += 'The image should feel like a single frame from a feature film.';

    // Import and call nanobanana
    let nanobananaTool: typeof import('../../loop/tools/nanobanana.js').nanobanana;
    try {
      const { nanobanana: nb } = await import('../../loop/tools/nanobanana.js');
      nanobananaTool = nb;
    } catch (err) {
      sendJson(res, 500, { error: 'Image generation not available: ' + String(err) });
      return true;
    }

    // Create output directory
    const previsDir = join(APP_STATE_DIR, pipelineId, 'previs');
    await mkdir(previsDir, { recursive: true });
    const outputPath = join(previsDir, `previs_${elementId}_${Date.now().toString(36)}.png`);

    try {
      debugLog.info('generate-previs', `Generating previs for ${elementId} with ${referenceImages.length} reference images`);
      const result = await nanobananaTool({
        action: 'generate' as const,
        prompt,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
        model,
        aspectRatio: aspectRatio as any,
        outputPath,
      }, previsDir);

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;

      if (!parsed.success && parsed.error) {
        sendJson(res, 500, { error: parsed.error });
        return true;
      }

      const filePath = parsed.filePath || outputPath;

      // Update the previs data in app state if we have a previs entry
      if (previs) {
        await updatePrevisAsset(pipelineId, elementId, filePath, screenplay);
      }

      sendJson(res, 200, {
        success: true,
        elementId,
        filePath,
        refsUsed: referenceImages.map((r: string) => basename(r)),
        refCount: { characters: characterIds.length, locations: locationId ? 1 : 0 },
        prompt: prompt.substring(0, 500),
        model,
      });
    } catch (err) {
      debugLog.info('generate-previs', `Error: ${err}`);
      sendJson(res, 500, { error: 'Generation failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  return false;
};

// ────────────────────────────────────────────────────────────────
//  Screenplay data helpers — resolve references for previs gen
// ────────────────────────────────────────────────────────────────

interface ScreenplayData {
  characters: Record<string, any>;
  locations: Record<string, any>;
  elementMap: Record<string, any>;
  previsMap: Record<string, any>;
  characterAssets: Record<string, any>;  // characterId -> asset with filePath
  locationAssets: Record<string, any>;   // locationId -> asset with filePath
  assetMap: Record<string, any>;         // assetId -> asset
}

/**
 * Collect all screenplay-related data from a pipeline's app state.
 * Walks all node outputs looking for characters, locations, elements,
 * previs shots, and assets — then builds lookup maps.
 */
async function collectScreenplayData(pipelineId: string): Promise<ScreenplayData | null> {
  const dir = join(APP_STATE_DIR, pipelineId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch { return null; }

  let allCharacters: any[] = [];
  let allLocations: any[] = [];
  let allElements: any[] = [];
  let allPrevis: any[] = [];
  let allAssets: any[] = [];

  for (const file of files) {
    if (!file.endsWith('.json') || file === '_manifest.json') continue;
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      const data = JSON.parse(raw);
      extractScreenplayFields(data, 0);
    } catch { /* skip */ }
  }

  function extractScreenplayFields(obj: any, depth: number): void {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) return;

    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (!v) continue;

      if (k === 'scriptPackage' && typeof v === 'object' && v.script) {
        extractScreenplayFields(v, depth + 1);
        extractScreenplayFields(v.script, depth + 1);
        continue;
      }
      if (k === 'script' && typeof v === 'object' && !Array.isArray(v)) {
        extractScreenplayFields(v, depth + 1);
        continue;
      }
      if (k === 'characters' && Array.isArray(v) && v.length > 0 && v[0]?.name) {
        if (v.length > allCharacters.length) allCharacters = v;
      }
      if (k === 'locations' && Array.isArray(v) && v.length > 0 && v[0]?.name) {
        if (v.length > allLocations.length) allLocations = v;
      }
      if (k === 'elements' && Array.isArray(v) && v.length > 0 && v[0]?.type && v[0]?.id) {
        if (v.length > allElements.length) allElements = v;
      }
      if (k === 'shots' && Array.isArray(v) && v.length > 0 && v[0]?.shotElementId) {
        if (v.length > allPrevis.length) allPrevis = v;
      }
      if (k === 'previsualizations' && typeof v === 'object' && v.shots) {
        if (v.shots.length > allPrevis.length) allPrevis = v.shots;
      }
      if (k === 'assets' && Array.isArray(v) && v.length > 0 && v[0]?.filePath) {
        if (v.length > allAssets.length) allAssets = v;
      }
      if (k === 'assets' && typeof v === 'object' && !Array.isArray(v) && v.assets) {
        if (Array.isArray(v.assets) && v.assets.length > allAssets.length) allAssets = v.assets;
      }

      if (typeof v === 'object' && !Array.isArray(v)) {
        extractScreenplayFields(v, depth + 1);
      }
    }
  }

  if (allElements.length === 0) return null;

  // Build lookup maps
  const characters: Record<string, any> = {};
  for (const c of allCharacters) characters[c.id] = c;

  const locations: Record<string, any> = {};
  for (const l of allLocations) locations[l.id] = l;

  const elementMap: Record<string, any> = {};
  for (const e of allElements) elementMap[e.id] = e;

  const previsMap: Record<string, any> = {};
  for (const p of allPrevis) previsMap[p.shotElementId] = p;

  const assetMap: Record<string, any> = {};
  for (const a of allAssets) assetMap[a.id] = a;

  // Map character IDs to their headshot assets
  const characterAssets: Record<string, any> = {};
  for (const asset of allAssets) {
    const meta = asset.metadata || {};
    if (meta.characterId && (asset.type === 'character-headshot' || asset.name?.toLowerCase().includes('headshot'))) {
      characterAssets[meta.characterId] = asset;
    }
  }

  // Map location IDs to their landscape assets
  const locationAssets: Record<string, any> = {};
  for (const asset of allAssets) {
    const meta = asset.metadata || {};
    if (meta.locationId && (asset.type === 'landscape' || asset.name?.toLowerCase().includes('landscape'))) {
      locationAssets[meta.locationId] = asset;
    }
  }

  return { characters, locations, elementMap, previsMap, characterAssets, locationAssets, assetMap };
}

/** Check if a file path exists synchronously */
function fileExists(filePath: string): boolean {
  try { return existsSync(filePath); } catch { return false; }
}

/**
 * Update the previs asset filePath in the stored app state after regeneration.
 * Finds the previs entry matching this element and updates its assetId's filePath,
 * or adds a new asset entry.
 */
async function updatePrevisAsset(
  pipelineId: string,
  elementId: string,
  newFilePath: string,
  screenplay: ScreenplayData
): Promise<void> {
  // Find which node file contains the previsualizations
  const dir = join(APP_STATE_DIR, pipelineId);
  let files: string[];
  try { files = await readdir(dir); } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.json') || file === '_manifest.json') continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (updatePrevisInObj(data, elementId, newFilePath)) {
        await writeFile(filePath, JSON.stringify(data, null, 2));
        debugLog.info('generate-previs', `Updated previs asset in ${file} for ${elementId}`);
        return;
      }
    } catch { /* skip */ }
  }
}

/**
 * Recursively walk an object to find and update the previs shot matching elementId.
 * Updates the asset's filePath or creates a new asset entry.
 */
function updatePrevisInObj(obj: any, elementId: string, newFilePath: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item?.shotElementId === elementId) {
        // Found the previs entry — update or create its asset reference
        item._generatedFilePath = newFilePath;
        item._generatedAt = new Date().toISOString();
        return true;
      }
      if (updatePrevisInObj(item, elementId, newFilePath)) return true;
    }
    return false;
  }
  for (const k of Object.keys(obj)) {
    if (updatePrevisInObj(obj[k], elementId, newFilePath)) return true;
  }
  return false;
}
