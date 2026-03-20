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

import { readFile, writeFile, mkdir, readdir, access, cp, rm, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import { topoSort, gatherInputVariables, getDownstreamNodes } from '../graph-utils.js';
import { debugLog } from '../../debug-log.js';
import { loadBindings, saveBindings, loadRules, saveRules, applyRules, getTargetIds, type RulesDocument } from '../pipeline-bindings.js';

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
  logo?: string;
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

/**
 * Resolve the external project folder for a pipeline (e.g. ~/Documents/The Last Jump).
 * Falls back to the pipeline's workflow dir, then app-state dir.
 */
async function resolveProjectFolder(pipelineId: string): Promise<string> {
  // Check pipeline.json for metadata.projectFolder
  try {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (entry) {
      const pipelineJson = entry.composition;
      const folder = pipelineJson?.metadata?.projectFolder;
      if (folder && typeof folder === 'string') {
        await mkdir(folder, { recursive: true });
        return folder;
      }
      // Fall back to pipeline directory
      if (entry.pipelineDir) return entry.pipelineDir;
    }
  } catch { /* ignore */ }
  return join(APP_STATE_DIR, pipelineId);
}

function nodeDataPath(pipelineId: string, nodeId: string): string {
  // Sanitize nodeId for filesystem safety
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(projectDir(pipelineId), `${safe}.json`);
}

// ── Project-folder-based storage ─────────────────────────────
// When a pipeline has metadata.projectFolder set, data lives in
// {projectFolder}/project.json instead of per-node files.

/** Map pipeline node IDs to project.json top-level keys */
const NODE_KEY_MAP: Record<string, string | string[]> = {
  'node-4':  'metadata',
  'node-5':  'characters',
  'node-6':  'locations',
  'node-7':  'sections',
  'node-8':  'processedSections',
  'node-9':  'sceneContent',
  'node-10': 'elements',
  'node-11': 'productionMetadata',
  'node-12': 'assets',
  'node-13': 'previsualizations',
  'node-14': 'ruleEnforcement',
  'node-15': '_assembly', // special: reads/writes entire project
  'node-16': '_output',   // special: reads/writes entire project
  'node-17': 'dialogueAudio',
};

function projectFilePath(projectFolder: string): string {
  return join(projectFolder, 'project.json');
}

async function loadProjectFile(projectFolder: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(projectFilePath(projectFolder), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveProjectFile(projectFolder: string, data: Record<string, any>): Promise<void> {
  data.updatedAt = new Date().toISOString();
  if (!data.version) data.version = '1.0';
  await mkdir(projectFolder, { recursive: true });
  await atomicWriteFile(projectFilePath(projectFolder), JSON.stringify(data, null, 2));
}

/**
 * Merge a node's outputs into project.json using the NODE_KEY_MAP.
 * For assembly nodes (node-15/16), merges all top-level keys from scriptPackage.
 */
async function mergeIntoProject(projectFolder: string, nodeId: string, outputs: Record<string, unknown>): Promise<void> {
  const project = (await loadProjectFile(projectFolder)) || { version: '1.0', createdAt: new Date().toISOString() };
  const keyMapping = NODE_KEY_MAP[nodeId];

  if (keyMapping === '_assembly' || keyMapping === '_output') {
    // Assembly/output node — merge all sub-keys
    // Handle scriptPackage wrapper
    const sp = (outputs as any).scriptPackage;
    const source = sp?.script || sp || outputs;
    for (const k of ['metadata', 'characters', 'locations', 'sections', 'elements', 'previsualizations', 'assets', 'productionMetadata']) {
      if (source[k] !== undefined) project[k] = source[k];
    }
    // Also save raw fields
    if ((outputs as any)._fountainSource) project._fountainSource = (outputs as any)._fountainSource;
    if (sp?.previsualizations) project.previsualizations = sp.previsualizations;
    if (sp?.assets) project.assets = sp.assets;
  } else if (keyMapping && typeof keyMapping === 'string') {
    // Single key mapping — merge the output's matching key
    const val = outputs[keyMapping];
    if (val !== undefined) {
      project[keyMapping] = val;
    } else {
      // If outputs doesn't have the expected key, try merging all keys
      for (const k of Object.keys(outputs)) {
        project[k] = outputs[k];
      }
    }
  } else {
    // Unknown node — store raw outputs under nodeId key
    project[`_node_${nodeId}`] = outputs;
  }

  await saveProjectFile(projectFolder, project);
}

/**
 * Convert a project.json into the nodeData format expected by the UI.
 * Creates virtual "node" entries so the existing stitcher/renderers work.
 */
function projectToNodeData(project: Record<string, any>): Record<string, AppNodeData> {
  const now = project.updatedAt || new Date().toISOString();
  const nodeData: Record<string, AppNodeData> = {};

  // Map project keys back to node IDs
  if (project.metadata) {
    nodeData['node-4'] = { outputs: { metadata: project.metadata }, updatedAt: now, manuallyEdited: false };
  }
  if (project.characters) {
    nodeData['node-5'] = { outputs: { characters: project.characters }, updatedAt: now, manuallyEdited: false };
  }
  if (project.locations) {
    nodeData['node-6'] = { outputs: { locations: project.locations }, updatedAt: now, manuallyEdited: false };
  }
  if (project.sections) {
    nodeData['node-7'] = { outputs: { sections: project.sections }, updatedAt: now, manuallyEdited: false };
  }
  if (project.elements) {
    nodeData['node-10'] = { outputs: { elements: project.elements }, updatedAt: now, manuallyEdited: false };
  }
  if (project.assets) {
    nodeData['node-12'] = { outputs: { assetCollection: project.assets }, updatedAt: now, manuallyEdited: false };
  }
  if (project.previsualizations) {
    nodeData['node-13'] = { outputs: { previsualizations: project.previsualizations }, updatedAt: now, manuallyEdited: false };
  }

  // Also create an assembly node with the full scriptPackage
  nodeData['node-15'] = {
    outputs: {
      scriptPackage: {
        script: {
          metadata: project.metadata || {},
          characters: project.characters || [],
          locations: project.locations || [],
          sections: project.sections || [],
          elements: project.elements || [],
        },
        previsualizations: project.previsualizations || { shots: [] },
        assets: project.assets || [],
      },
      _fountainSource: project._fountainSource || '',
    },
    updatedAt: now,
    manuallyEdited: false,
  };

  return nodeData;
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

/** Load full app state — checks project folder first, falls back to node files */
async function loadAppState(pipelineId: string): Promise<AppState | null> {
  const manifest = await loadManifest(pipelineId);

  // Check if pipeline has a project folder with project.json
  let pfolder: string | null = null;
  try {
    const compositions = await discoverCompositions();
    const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
    pfolder = entry?.composition?.metadata?.projectFolder || null;
  } catch { /* ignore */ }

  if (pfolder) {
    const project = await loadProjectFile(pfolder);
    if (project) {
      const nodeData = projectToNodeData(project);
      return {
        pipelineId,
        pipelineName: manifest?.pipelineName || project.metadata?.title || pipelineId,
        sourceRunId: manifest?.sourceRunId || null,
        nodeData,
        staleNodes: manifest?.staleNodes || [],
        lastRunAt: manifest?.lastRunAt || null,
      };
    }
  }

  // Fall back to legacy per-node files
  if (!manifest) return null;

  const nodeData: Record<string, AppNodeData> = {};
  for (const [nodeId, meta] of Object.entries(manifest.nodes)) {
    const outputs = await loadNodeData(pipelineId, nodeId);
    if (outputs) {
      nodeData[nodeId] = { outputs, ...meta };
    }
  }

  // Migration: if we have node data but no project.json and there IS a project folder,
  // consolidate into project.json
  if (pfolder && Object.keys(nodeData).length > 0) {
    debugLog.info('pipeline-app', `Migrating ${Object.keys(nodeData).length} node files to project.json for ${pipelineId}`);
    const project: Record<string, any> = { version: '1.0', pipelineId, createdAt: new Date().toISOString() };
    for (const [nodeId, data] of Object.entries(nodeData)) {
      const key = NODE_KEY_MAP[nodeId];
      if (key === '_assembly' || key === '_output') {
        const sp = (data.outputs as any)?.scriptPackage;
        const source = sp?.script || sp || data.outputs;
        for (const k of ['metadata', 'characters', 'locations', 'sections', 'elements', 'previsualizations', 'assets']) {
          if (source?.[k] !== undefined) project[k] = source[k];
        }
        if ((data.outputs as any)?._fountainSource) project._fountainSource = (data.outputs as any)._fountainSource;
      } else if (key && typeof key === 'string') {
        const val = data.outputs?.[key];
        if (val !== undefined) project[key] = val;
      }
    }
    await saveProjectFile(pfolder, project);
    // Clean up old node files (keep manifest + saves)
    try {
      const dir = projectDir(pipelineId);
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith('node-') || entry.startsWith('var-')) {
          await rm(join(dir, entry));
        }
      }
    } catch { /* best effort */ }
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

    // Check for project folder
    let pfolder: string | null = null;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
      pfolder = entry?.composition?.metadata?.projectFolder || null;
    } catch { /* ignore */ }

    // Write outputs — to project.json if project folder exists, else per-node files
    for (const nodeId of executionOrder) {
      const outputs = nodeOutputs[nodeId];
      if (!outputs || Object.keys(outputs).length === 0) continue;

      if (pfolder) {
        await mergeIntoProject(pfolder, nodeId, outputs);
      } else {
        await saveNodeData(pipelineId, nodeId, outputs);
      }
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
    logo: pipeline.metadata?.logo || undefined,
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

  // ── DELETE /api/app/:id/state ─────────────────────────────
  // Clears all project state (preserves saves/ directory)
  if (req.method === 'DELETE' && subPath === '/state') {
    // Clear project.json if project folder exists
    let pfolder: string | null = null;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
      pfolder = entry?.composition?.metadata?.projectFolder || null;
    } catch { /* ignore */ }

    if (pfolder) {
      try { await rm(projectFilePath(pfolder)); } catch { /* may not exist */ }
    }

    // Also clear legacy app-state node files
    const dir = projectDir(pipelineId);
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry === 'saves' || entry.startsWith('.')) continue;
        const fullPath = join(dir, entry);
        const s = await stat(fullPath);
        if (s.isFile()) {
          await rm(fullPath);
        } else if (s.isDirectory()) {
          await rm(fullPath, { recursive: true });
        }
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    sendJson(res, 200, { success: true });
    return true;
  }

  // ── PUT /api/app/:id/project — write project.json directly ──
  if (req.method === 'PUT' && subPath === '/project') {
    const body = await readBody(req);
    let pfolder: string | null = null;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
      pfolder = entry?.composition?.metadata?.projectFolder || null;
    } catch { /* ignore */ }

    if (!pfolder) {
      sendJson(res, 400, { error: 'No project folder set for this pipeline' });
      return true;
    }

    const projectData = body.project || body;
    projectData.pipelineId = pipelineId;
    await saveProjectFile(pfolder, projectData);

    // Update manifest
    let manifest = await loadManifest(pipelineId);
    if (!manifest) {
      const pipeline = await findPipeline(ctx.workDir, pipelineId);
      manifest = { pipelineId, pipelineName: pipeline?.name || pipelineId, sourceRunId: null, staleNodes: [], lastRunAt: null, nodes: {} };
    }
    manifest.nodes['node-15'] = { updatedAt: new Date().toISOString(), manuallyEdited: true };
    await saveManifest(manifest);

    sendJson(res, 200, { success: true, projectFolder: pfolder });
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

    // Write data — prefer project.json if project folder exists
    const outputs = body.outputs || body;
    let pfolder: string | null = null;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
      pfolder = entry?.composition?.metadata?.projectFolder || null;
    } catch { /* ignore */ }

    if (pfolder) {
      await mergeIntoProject(pfolder, nodeId, outputs);
    } else {
      await saveNodeData(pipelineId, nodeId, outputs);
    }

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

  // ── GET /api/app/:id/saves ──────────────────────────────
  // List all saved snapshots for this pipeline
  if (req.method === 'GET' && subPath === '/saves') {
    const savesDir = join(projectDir(pipelineId), 'saves');
    try {
      await mkdir(savesDir, { recursive: true });
      const entries = await readdir(savesDir);
      const saves: Array<{
        id: string;
        name: string;
        description: string;
        createdAt: string;
        nodeCount: number;
        size: number;
      }> = [];

      for (const entry of entries) {
        try {
          const metaPath = join(savesDir, entry, '_save-meta.json');
          const raw = await readFile(metaPath, 'utf-8');
          const meta = JSON.parse(raw);
          // Calculate approximate size
          const saveFiles = await readdir(join(savesDir, entry));
          let totalSize = 0;
          for (const f of saveFiles) {
            try {
              const s = await stat(join(savesDir, entry, f));
              totalSize += s.size;
            } catch { /* skip */ }
          }
          saves.push({
            id: entry,
            name: meta.name || entry,
            description: meta.description || '',
            createdAt: meta.createdAt || '',
            nodeCount: meta.nodeCount || 0,
            size: totalSize,
          });
        } catch { /* skip invalid entries */ }
      }

      // Sort newest first
      saves.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      sendJson(res, 200, { saves });
    } catch {
      sendJson(res, 200, { saves: [] });
    }
    return true;
  }

  // ── POST /api/app/:id/saves ──────────────────────────────
  // Create a new save (snapshot current state)
  if (req.method === 'POST' && subPath === '/saves') {
    const body = await readBody(req);
    const name: string = body.name || `Save ${new Date().toLocaleString()}`;
    const description: string = body.description || '';
    const customPath: string | undefined = body.path; // optional: save to custom location

    const state = await loadAppState(pipelineId);
    if (!state) {
      sendJson(res, 404, { error: 'No app state to save' });
      return true;
    }

    const saveId = `save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetDir = customPath
      ? resolve(customPath)
      : join(projectDir(pipelineId), 'saves', saveId);

    try {
      await mkdir(targetDir, { recursive: true });

      // Copy all node data files
      const srcDir = projectDir(pipelineId);
      const files = await readdir(srcDir);
      let nodeCount = 0;
      for (const f of files) {
        if (f === 'saves' || f.startsWith('.')) continue; // skip saves dir and hidden files
        const srcPath = join(srcDir, f);
        const s = await stat(srcPath);
        if (s.isFile()) {
          await cp(srcPath, join(targetDir, f));
          if (f.endsWith('.json') && f !== '_manifest.json') nodeCount++;
        }
      }

      // Copy previs directory if it exists
      const previsDir = join(srcDir, 'previs');
      try {
        await access(previsDir);
        await cp(previsDir, join(targetDir, 'previs'), { recursive: true });
      } catch { /* no previs dir */ }

      // Also copy bindings from the pipeline source if present
      const compositions = await discoverCompositions();
      const entry = compositions.find((d: any) => d?.composition?.id === pipelineId);
      if (entry?.pipelineDir) {
        const bindingsPath = join(entry.pipelineDir, 'bindings', 'bindings.json');
        try {
          await access(bindingsPath);
          await mkdir(join(targetDir, 'bindings'), { recursive: true });
          await cp(bindingsPath, join(targetDir, 'bindings', 'bindings.json'));
        } catch { /* no bindings */ }
      }

      // Write save metadata
      const saveMeta = {
        id: saveId,
        name,
        description,
        createdAt: new Date().toISOString(),
        pipelineId,
        pipelineName: state.pipelineName,
        sourceRunId: state.sourceRunId,
        nodeCount,
        savedTo: targetDir,
      };
      await atomicWriteFile(join(targetDir, '_save-meta.json'), JSON.stringify(saveMeta, null, 2));

      debugLog.info('pipeline-app', `Saved snapshot "${name}" for ${pipelineId} → ${targetDir}`);
      sendJson(res, 200, { saved: true, saveId, path: targetDir, ...saveMeta });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to save: ${err.message}` });
    }
    return true;
  }

  // ── POST /api/app/:id/saves/:saveId/load ──────────────────
  // Restore app state from a save
  const loadMatch = subPath.match(/^\/saves\/([^/]+)\/load$/);
  if (req.method === 'POST' && loadMatch) {
    const saveId = decodeURIComponent(loadMatch[1]);
    const body = await readBody(req);

    // Support loading from a custom path OR from the saves directory
    const sourceDir = body.path
      ? resolve(body.path)
      : join(projectDir(pipelineId), 'saves', saveId);

    try {
      // Verify save exists
      const metaPath = join(sourceDir, '_save-meta.json');
      await access(metaPath);

      const destDir = projectDir(pipelineId);

      // Clear current state (but preserve saves directory)
      const existingFiles = await readdir(destDir);
      for (const f of existingFiles) {
        if (f === 'saves' || f.startsWith('.')) continue;
        const fullPath = join(destDir, f);
        const s = await stat(fullPath);
        if (s.isFile()) {
          await rm(fullPath);
        } else if (s.isDirectory() && f === 'previs') {
          await rm(fullPath, { recursive: true });
        }
      }

      // Copy save files into current state
      const saveFiles = await readdir(sourceDir);
      for (const f of saveFiles) {
        if (f === '_save-meta.json') continue; // don't copy meta into active state
        const srcPath = join(sourceDir, f);
        const s = await stat(srcPath);
        if (s.isFile()) {
          await cp(srcPath, join(destDir, f));
        } else if (s.isDirectory() && f === 'previs') {
          await cp(srcPath, join(destDir, f), { recursive: true });
        }
      }

      // Restore bindings to pipeline source if present
      const savedBindings = join(sourceDir, 'bindings', 'bindings.json');
      try {
        await access(savedBindings);
        const compositions = await discoverCompositions();
        const entry = compositions.find((d: any) => d?.composition?.id === pipelineId);
        if (entry?.pipelineDir) {
          const bindingsDest = join(entry.pipelineDir, 'bindings');
          await mkdir(bindingsDest, { recursive: true });
          await cp(savedBindings, join(bindingsDest, 'bindings.json'));
        }
      } catch { /* no bindings in save */ }

      // Load and return the restored state
      const restored = await loadAppState(pipelineId);
      debugLog.info('pipeline-app', `Loaded save "${saveId}" for ${pipelineId} from ${sourceDir}`);
      sendJson(res, 200, { loaded: true, state: restored });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to load save: ${err.message}` });
    }
    return true;
  }

  // ── DELETE /api/app/:id/saves/:saveId ──────────────────────
  const deleteMatch = subPath.match(/^\/saves\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const saveId = decodeURIComponent(deleteMatch[1]);
    const saveDir = join(projectDir(pipelineId), 'saves', saveId);
    try {
      await rm(saveDir, { recursive: true });
      debugLog.info('pipeline-app', `Deleted save "${saveId}" for ${pipelineId}`);
      sendJson(res, 200, { deleted: true });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to delete: ${err.message}` });
    }
    return true;
  }

  // ── POST /api/app/:id/saves/load-from-path ────────────────
  // Load state from an arbitrary path on the filesystem
  if (req.method === 'POST' && subPath === '/saves/load-from-path') {
    const body = await readBody(req);
    const loadPath: string = body.path;
    if (!loadPath) {
      sendJson(res, 400, { error: 'path is required' });
      return true;
    }

    const sourceDir = resolve(loadPath);
    try {
      // Check if it's a valid save (has manifest or save meta)
      let isValid = false;
      try { await access(join(sourceDir, '_manifest.json')); isValid = true; } catch {}
      try { await access(join(sourceDir, '_save-meta.json')); isValid = true; } catch {}
      if (!isValid) {
        sendJson(res, 400, { error: 'Not a valid save directory — no _manifest.json or _save-meta.json found' });
        return true;
      }

      const destDir = projectDir(pipelineId);
      await mkdir(destDir, { recursive: true });

      // Clear current state (preserve saves)
      const existingFiles = await readdir(destDir);
      for (const f of existingFiles) {
        if (f === 'saves' || f.startsWith('.')) continue;
        const fullPath = join(destDir, f);
        const s = await stat(fullPath);
        if (s.isFile()) await rm(fullPath);
        else if (s.isDirectory() && f === 'previs') await rm(fullPath, { recursive: true });
      }

      // Copy files from source
      const sourceFiles = await readdir(sourceDir);
      for (const f of sourceFiles) {
        if (f === '_save-meta.json') continue;
        const srcPath = join(sourceDir, f);
        const s = await stat(srcPath);
        if (s.isFile()) await cp(srcPath, join(destDir, f));
        else if (s.isDirectory() && (f === 'previs' || f === 'bindings')) {
          await cp(srcPath, join(destDir, f), { recursive: true });
        }
      }

      // Restore bindings if present
      const savedBindings = join(sourceDir, 'bindings', 'bindings.json');
      try {
        await access(savedBindings);
        const compositions = await discoverCompositions();
        const entry = compositions.find((d: any) => d?.composition?.id === pipelineId);
        if (entry?.pipelineDir) {
          const bindingsDest = join(entry.pipelineDir, 'bindings');
          await mkdir(bindingsDest, { recursive: true });
          await cp(savedBindings, join(bindingsDest, 'bindings.json'));
        }
      } catch { /* no bindings */ }

      const restored = await loadAppState(pipelineId);
      debugLog.info('pipeline-app', `Loaded state from path: ${sourceDir}`);
      sendJson(res, 200, { loaded: true, path: sourceDir, state: restored });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to load from path: ${err.message}` });
    }
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
  //
  // BEHAVIOR IS DEFINED BY THE PIPELINE: reads actions/generate-image.json
  // from the pipeline's directory. This config controls:
  //   - How character/location references are resolved (bindings, fallback)
  //   - Prompt template and style
  //   - Model and aspect ratio defaults
  //
  // The chat agent can modify that config when the user says things like
  // "only use characters mentioned in the shot description."
  if (req.method === 'POST' && subPath === '/generate-previs') {
    const body = await readBody(req);
    const elementId: string = body.elementId;
    const promptOverrides: Record<string, string> = body.promptOverrides || {};
    // Scene context from client (new scene-grouped model)
    const sceneId: string | undefined = body.sceneId;
    const sceneLocationId: string | undefined = body.sceneLocationId;

    if (!elementId) {
      sendJson(res, 400, { error: 'elementId required' });
      return true;
    }

    // Load pipeline's action config (the pipeline owns this behavior)
    const compositions = await discoverCompositions();
    const pipelineEntry = compositions.find(c => c.composition.id === pipelineId);
    const actionConfig = await loadActionConfig(pipelineEntry?.pipelineDir, 'generate-image');

    const model: 'flash' | 'pro' = body.model || actionConfig.generation?.model || 'flash';
    const aspectRatio: string = body.aspectRatio || actionConfig.generation?.aspectRatio || '16:9';

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

    // ── Resolve references using the pipeline's action config ──
    // The config declares HOW to find the right references for each entity type.
    // This is the key encapsulation: the pipeline defines its own resolution strategy,
    // the server just executes it.
    const referenceImages: string[] = [];
    const refDescriptions: string[] = [];

    const refConfig = actionConfig.referenceResolution || {};

    // -- Characters --
    const charConfig = refConfig.characters || {};
    let characterIds: string[] = [];

    if (charConfig.strategy === 'binding-match' && pipelineEntry?.isV2Pipeline && pipelineEntry.pipelineDir) {
      // Strategy: use bindings to find which characters this shot depicts
      let bindingsDoc = await loadBindings(pipelineEntry.pipelineDir);

      // Check if THIS specific shot has any character bindings
      const existingCharBindings = bindingsDoc.bindings.filter(
        b => b.type === (charConfig.bindingType || 'depicts') &&
             b.source.entityType === (charConfig.sourceEntityType || 'shot') &&
             b.source.entityId === elementId
      );

      // Auto-create bindings from rules if this shot has no bindings yet
      if (charConfig.autoCreateBindings && existingCharBindings.length === 0) {
        const rulesDoc = await loadRules(pipelineEntry.pipelineDir);
        if (rulesDoc.rules.length > 0) {
          debugLog.info('generate-previs', `Auto-creating bindings for shot ${elementId} from pipeline rules...`);
          const autoResult = await autoRunRules(pipelineId, pipelineEntry.pipelineDir, rulesDoc);
          if (autoResult.added > 0) {
            debugLog.info('generate-previs', `Auto-created ${autoResult.added} bindings`);
            bindingsDoc = await loadBindings(pipelineEntry.pipelineDir);
          }
        }
      }

      characterIds = getTargetIds(
        bindingsDoc,
        charConfig.sourceEntityType || 'shot',
        elementId,
        charConfig.bindingType || 'depicts',
      );
      debugLog.info('generate-previs', `Bindings → ${characterIds.length} characters for ${elementId}`, { characterIds });
      debugLog.info('generate-previs', `Character assets available: ${Object.keys(screenplay.characterAssets).join(', ')}`);
    }

    // Strategy 0: from scene-grouped shot data (most authoritative for new model)
    if (characterIds.length === 0 && screenplay.scenes && sceneId) {
      const scene = screenplay.scenes.find((s: any) => s.id === sceneId);
      if (scene) {
        const shot = scene.shots?.find((s: any) => s.id === elementId);
        if (shot?.characterIds?.length) {
          characterIds = shot.characterIds;
          debugLog.info('generate-previs', `Scene shot → ${characterIds.length} characters from scene.shots[].characterIds`);
        }
      }
    }

    // Fallback strategy 1a: from element's characterIds metadata (set by AI during shot generation)
    if (characterIds.length === 0 && element.characterIds && Array.isArray(element.characterIds)) {
      characterIds = element.characterIds;
      debugLog.info('generate-previs', `Fallback 1a → ${characterIds.length} characters from element.characterIds`);
    }

    // Fallback strategy 1b: from previs entry
    if (characterIds.length === 0 && charConfig.fallback !== 'none') {
      characterIds = previs?.characterIds || [];
      debugLog.info('generate-previs', `Fallback 1b → ${characterIds.length} characters from previs.characterIds`);
    }

    // Fallback strategy 2: text-match character names in the shot description
    // Uses word-boundary regex. Sorts candidates longest-name-first to prefer
    // "GOOD FRANK" over "FRANK" and reduce false positives from short names.
    if (characterIds.length === 0) {
      const shotText = (element.content || element.shotText || '').toUpperCase();
      const candidates = Object.values(screenplay.characters)
        .map((c: any) => ({
          id: c.id,
          names: [c.name, c.displayName].filter(Boolean).map((n: string) => n.toUpperCase()),
          maxLen: Math.max(...[c.name, c.displayName].filter(Boolean).map((n: string) => n.length)),
        }))
        .sort((a, b) => b.maxLen - a.maxLen); // longest names first

      for (const c of candidates) {
        for (const name of c.names) {
          if (!name || name.length < 2) continue;
          try {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\b`);
            if (re.test(shotText)) {
              if (!characterIds.includes(c.id)) characterIds.push(c.id);
              break;
            }
          } catch { /* skip invalid regex */ }
        }
      }
      // Cap at 4 references to avoid overloading the image generator
      if (characterIds.length > 4) characterIds = characterIds.slice(0, 4);
      if (characterIds.length > 0) {
        debugLog.info('generate-previs', `Fallback 2 (text-match) → ${characterIds.length} characters: ${characterIds.join(', ')}`);
      }
    }

    for (const charId of characterIds) {
      const charAsset = screenplay.characterAssets[charId];
      debugLog.info('generate-previs', `Looking for asset for character "${charId}": ${charAsset ? 'FOUND' : 'NOT FOUND'}`, {
        charAsset: charAsset ? { id: charAsset.id, filePath: charAsset.filePath } : null,
      });
      if (charAsset?.filePath && fileExists(charAsset.filePath)) {
        referenceImages.push(charAsset.filePath);
        const charData = screenplay.characters[charId];
        const desc = charData?.description || charData?.name || charId;
        refDescriptions.push(
          `Reference image ${referenceImages.length} is ${charData?.displayName || charData?.name || charId}` +
          (desc ? ` (${desc.substring(0, 120)})` : '')
        );
      } else if (charAsset?.filePath) {
        debugLog.info('generate-previs', `Character asset file does not exist: ${charAsset.filePath}`);
      }
    }

    // -- Location --
    const locConfig = refConfig.locations || {};
    let locationId: string | undefined = undefined;

    if (locConfig.strategy === 'binding-match' && pipelineEntry?.isV2Pipeline && pipelineEntry.pipelineDir) {
      const bindingsDoc = await loadBindings(pipelineEntry.pipelineDir);
      const locIds = getTargetIds(
        bindingsDoc,
        locConfig.sourceEntityType || 'shot',
        elementId,
        locConfig.bindingType || 'set-in',
      );
      if (locIds.length > 0) locationId = locIds[0];
    }

    // Location from scene context (sent by client in new model)
    if (!locationId && sceneLocationId) {
      locationId = sceneLocationId;
      debugLog.info('generate-previs', `Location from scene context: ${locationId}`);
    }

    // Location fallback 1: from previs entry
    if (!locationId && locConfig.fallback !== 'none') {
      locationId = previs?.locationId;
    }

    // Location fallback 2: text-match location names in the shot description
    if (!locationId) {
      const shotText = (element.content || element.shotText || '').toUpperCase();
      for (const l of Object.values(screenplay.locations)) {
        const name = (l.name || '').toUpperCase();
        if (name && shotText.includes(name)) {
          locationId = l.id;
          break;
        }
      }
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

    // ── Build prompt using pipeline's config ──
    const shotText = element.shotText || element.content || '';
    const previsDescription = promptOverrides.description || previs?.description || shotText;
    const cameraIntent = promptOverrides.cameraIntent || previs?.cameraIntent || '';
    const composition = promptOverrides.composition || previs?.composition || '';
    const lighting = promptOverrides.lighting || previs?.lighting || '';

    const frameSize = element.frameSize || '';
    const cameraMovement = element.cameraMovement || '';

    const lensMap: Record<string, string> = actionConfig.frameSizeLensMap || {
      'WIDE': 'wide-angle lens (24mm), deep depth of field',
      'EXTREME WIDE': 'ultra wide-angle lens (16mm), expansive depth of field',
      'MEDIUM': 'standard lens (50mm), natural perspective with moderate depth of field',
      'MEDIUM CLOSE-UP': '85mm portrait lens, shallow depth of field (f/2.8)',
      'CLOSE-UP': '85mm portrait lens, very shallow depth of field (f/1.8)',
      'EXTREME CLOSE-UP': 'macro lens (100mm), extremely shallow depth of field (f/1.4)',
    };
    const lensDesc = lensMap[frameSize.toUpperCase()] || '';

    const movementMap: Record<string, string> = actionConfig.cameraMovementMap || {
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

    // Reference instruction from config
    const refInstruction = actionConfig.referenceInstruction
      || 'Using the attached reference images as visual guides for character appearance and location setting. The characters in this frame must match these references exactly — same face, hair, body type, clothing, and features. The environment should be consistent with the location reference.';

    if (referenceImages.length > 0) {
      prompt += refInstruction + '\n' + refDescriptions.join('. ') + '.\n\n';
    }

    prompt += previsDescription;
    if (previsDescription !== shotText && shotText) {
      prompt += ` The camera captures: ${shotText}`;
    }
    prompt += '\n\n';

    if (lensDesc || movementDesc || composition) {
      prompt += 'Shot on a cinema camera';
      if (lensDesc) prompt += ` with a ${lensDesc}`;
      prompt += '. ';
      if (movementDesc) prompt += `Camera technique: ${movementDesc}. `;
      if (composition) prompt += composition + '. ';
      prompt += '\n\n';
    }

    if (lighting) {
      prompt += `Lighting: ${lighting}. `;
    }
    if (cameraIntent && cameraIntent !== composition) {
      prompt += cameraIntent + '. ';
    }
    if (lighting || cameraIntent) prompt += '\n\n';

    // Style from config or default
    const stylePrompt = actionConfig.prompt?.sections?.find((s: any) => s.id === 'style')?.template
      || 'Style: Cinematic previsualization frame, shot on 35mm film with subtle grain. Professional cinematography with rich color grading, deep shadows, and controlled highlights. The image should feel like a single frame from a feature film.';
    prompt += stylePrompt;

    // Import and call nanobanana
    let nanobananaTool: typeof import('../../loop/tools/nanobanana.js').nanobanana;
    try {
      const { nanobanana: nb } = await import('../../loop/tools/nanobanana.js');
      nanobananaTool = nb;
    } catch (err) {
      sendJson(res, 500, { error: 'Image generation not available: ' + String(err) });
      return true;
    }

    // Create output directory in the project folder
    const projFolder = await resolveProjectFolder(pipelineId);
    const previsDir = join(projFolder, 'assets', 'previs');
    await mkdir(previsDir, { recursive: true });
    const outputPath = join(previsDir, `previs_${elementId}_${Date.now().toString(36)}.png`);

    try {
      debugLog.info('generate-previs', `Generating previs for ${elementId} with ${referenceImages.length} reference images`, {
        referenceImages,
      });
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

      // Update or create the previs data in app state and project.json
      await updatePrevisAsset(pipelineId, elementId, filePath, screenplay);

      // Also update project.json directly if using project folder
      if (projFolder) {
        try {
          const projJsonPath = join(projFolder, 'project.json');
          const projRaw = await readFile(projJsonPath, 'utf-8');
          const projData = JSON.parse(projRaw);
          if (!projData.previsualizations) projData.previsualizations = { shots: [] };
          if (!projData.previsualizations.shots) projData.previsualizations.shots = [];
          const existingIdx = projData.previsualizations.shots.findIndex((s: any) => s.shotElementId === elementId);
          const previsEntry = {
            shotElementId: elementId,
            filePath,
            _generatedFilePath: filePath,
            _generatedAt: new Date().toISOString(),
            description: shotText,
          };
          if (existingIdx >= 0) {
            projData.previsualizations.shots[existingIdx] = { ...projData.previsualizations.shots[existingIdx], ...previsEntry };
          } else {
            projData.previsualizations.shots.push(previsEntry);
          }
          // Also update scene-grouped shot data if scenes exist
          if (projData.scenes && Array.isArray(projData.scenes)) {
            for (const scene of projData.scenes) {
              if (!scene.shots) continue;
              const shotIdx = scene.shots.findIndex((s: any) => s.id === elementId);
              if (shotIdx >= 0) {
                scene.shots[shotIdx].previsPath = filePath;
                scene.shots[shotIdx].generatedAt = new Date().toISOString();
                break;
              }
            }
          }

          await writeFile(projJsonPath, JSON.stringify(projData, null, 2));
        } catch (e) {
          debugLog.info('generate-previs', `Failed to update project.json: ${e}`);
        }
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

  // ── POST /api/app/:id/generate-dialogue-audio ──────────────
  // Generate TTS audio for a dialogue element, save to project, persist as asset.
  if (req.method === 'POST' && subPath === '/generate-dialogue-audio') {
    const body = await readBody(req);
    const elementId: string = body.elementId;
    const text: string = body.text;
    const voiceId: string = body.voiceId;
    const characterName: string = body.characterName || '';
    const characterId: string = body.characterId || '';

    if (!elementId || !text || !voiceId) {
      sendJson(res, 400, { error: 'elementId, text, and voiceId are required' });
      return true;
    }

    // Create output directory in the project folder
    const projFolder2 = await resolveProjectFolder(pipelineId);
    const audioDir = join(projFolder2, 'audio');
    await mkdir(audioDir, { recursive: true });
    const outputPath = join(audioDir, `dialogue_${elementId}_${Date.now().toString(36)}.mp3`);

    try {
      // Call TTS tool via extension manager
      await ctx.extensionManager?.whenReady();
      const tools = ctx.extensionManager?.getAllTools() ?? [];
      const ttsTool = tools.find(t => t.definition.name === 'tts_speak');

      if (!ttsTool) {
        sendJson(res, 500, { error: 'TTS tool not available. Check that ElevenLabs extension is loaded.' });
        return true;
      }

      const ttsResult = await ttsTool.handler({
        text,
        voice_id: voiceId,
        output_path: outputPath,
        output_format: 'mp3_44100_128',
      }, { workingDirectory: audioDir } as any);

      const audioData = typeof ttsResult === 'string' ? JSON.parse(ttsResult) : ttsResult;
      if (!audioData.success) {
        sendJson(res, 500, { error: audioData.error || 'TTS generation failed' });
        return true;
      }

      const filePath = audioData.audio_path || outputPath;

      // Build the asset entry
      const assetId = 'ast_da_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const asset = {
        id: assetId,
        type: 'dialogue-audio',
        name: `Dialogue: ${characterName || elementId}`,
        description: text.substring(0, 200),
        filePath,
        metadata: {
          dialogueElementId: elementId,
          characterId,
          characterName,
          voiceId,
          text: text.substring(0, 500),
          generatedAt: new Date().toISOString(),
        },
      };

      // Add to the asset collection in app state (or update existing)
      await addDialogueAudioAsset(pipelineId, asset);

      sendJson(res, 200, {
        success: true,
        elementId,
        filePath,
        assetId,
        characterName,
      });
    } catch (err) {
      debugLog.info('generate-dialogue-audio', `Error: ${err}`);
      sendJson(res, 500, { error: 'TTS failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  // ── POST /api/app/:id/import-audio ──────────────────────────
  // Copy an audio file into the pipeline's audio directory.
  // Accepts { sourcePath: "/absolute/path/to/file.mp3" }
  // Returns { success, filePath } with the new project-local path.
  if (req.method === 'POST' && subPath === '/import-audio') {
    const body = await readBody(req);
    const sourcePath: string = body.sourcePath;
    if (!sourcePath) {
      sendJson(res, 400, { error: 'sourcePath required' });
      return true;
    }

    try {
      // Verify source exists
      await access(sourcePath);

      // Create audio dir inside the project folder
      const projFolder = await resolveProjectFolder(pipelineId);
      const audioDir = join(projFolder, 'audio');
      await mkdir(audioDir, { recursive: true });

      // Build a unique destination filename
      const srcBase = basename(sourcePath);
      const dotIdx = srcBase.lastIndexOf('.');
      const name = dotIdx > 0 ? srcBase.substring(0, dotIdx) : srcBase;
      const ext = dotIdx > 0 ? srcBase.substring(dotIdx) : '';
      const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').substring(0, 80);
      const destName = safeName + '_' + Date.now().toString(36) + ext;
      const destPath = join(audioDir, destName);

      await cp(sourcePath, destPath);

      // Detect audio duration via ffprobe (if available)
      let duration: number | null = null;
      try {
        const { execSync } = await import('node:child_process');
        const probe = execSync(
          `ffprobe -v error -show_entries format=duration -of csv=p=0 "${destPath}"`,
          { timeout: 5000, encoding: 'utf-8' }
        ).trim();
        const parsed = parseFloat(probe);
        if (parsed > 0 && isFinite(parsed)) duration = parsed;
      } catch {
        // ffprobe not available — try size-based estimate for MP3 (128kbps ~ 16KB/s)
        try {
          const fileStat = await stat(destPath);
          const sizeKb = fileStat.size / 1024;
          if (ext.toLowerCase() === '.mp3') duration = sizeKb / 16;
          else if (ext.toLowerCase() === '.wav') duration = sizeKb / 176; // 44.1kHz 16-bit stereo
          else duration = sizeKb / 16; // rough default
        } catch { /* ignore */ }
      }

      sendJson(res, 200, { success: true, filePath: destPath, fileName: srcBase, duration });
    } catch (err) {
      sendJson(res, 500, { error: 'Import failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  // ── POST /api/app/:id/render-video ──────────────────────────
  // Render the NLE timeline to a video file via ffmpeg.
  if (req.method === 'POST' && subPath === '/render-video') {
    const body = await readBody(req);
    const settings = body.settings || {};
    const clips: any[] = body.clips || [];
    const dialogAudioMap: Record<string, string> = body.dialogAudioMap || {};

    const resX: number = settings.resolutionX || 1920;
    const resY: number = settings.resolutionY || 1080;
    const fps: number = settings.fps || 24;
    const format: string = settings.format || 'mp4';
    const quality: string = settings.quality || 'medium';
    const startTime: number = settings.startTime || 0;
    const endTime: number = settings.endTime || 120;
    const totalDuration = endTime - startTime;

    if (totalDuration <= 0) {
      sendJson(res, 400, { error: 'Invalid time range' });
      return true;
    }

    try {
      const projFolder = await resolveProjectFolder(pipelineId);
      const renderDir = join(projFolder, 'renders');
      await mkdir(renderDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4';
      const outputPath = join(renderDir, `render_${timestamp}.${ext}`);

      // CRF mapping
      const crfMap: Record<string, number> = { high: 18, medium: 23, low: 28 };
      const crf = crfMap[quality] || 23;

      // Separate clips by type
      const visualClips = clips
        .filter((c: any) => c.trackId === 'visuals' && c.filePath)
        .sort((a: any, b: any) => a.startTime - b.startTime);

      const audioClips: any[] = [];
      // Dialog audio from dialogAudioMap
      clips.filter((c: any) => c.type === 'dialog' && c.elementId && dialogAudioMap[c.elementId])
        .forEach((c: any) => {
          audioClips.push({
            path: dialogAudioMap[c.elementId],
            startTime: c.startTime - startTime,
            duration: c.duration,
            volume: (c.volume != null ? c.volume : 100) / 100,
            fadeIn: c.fadeIn || 0,
            fadeOut: c.fadeOut || 0,
          });
        });
      // Music/SFX/Ambience clips with file paths
      clips.filter((c: any) => (c.type === 'music' || c.type === 'sfx' || c.type === 'ambience') && c.filePath)
        .forEach((c: any) => {
          audioClips.push({
            path: c.filePath,
            startTime: c.startTime - startTime,
            duration: c.duration,
            volume: (c.volume != null ? c.volume : 100) / 100,
            fadeIn: c.fadeIn || 0,
            fadeOut: c.fadeOut || 0,
          });
        });

      if (visualClips.length === 0) {
        sendJson(res, 400, { error: 'No visual clips with images to render' });
        return true;
      }

      // Build ffmpeg command
      const ffmpegArgs: string[] = [];

      // Add visual inputs (images looped for their duration)
      for (const vc of visualClips) {
        const clipDur = Math.min(vc.startTime + vc.duration, endTime) - Math.max(vc.startTime, startTime);
        if (clipDur <= 0) continue;
        ffmpegArgs.push('-loop', '1', '-t', String(clipDur), '-i', vc.filePath);
      }

      const numVisuals = visualClips.length;

      // Add audio inputs
      for (const ac of audioClips) {
        ffmpegArgs.push('-i', ac.path);
      }

      const numAudio = audioClips.length;

      // Build filter complex
      const filterParts: string[] = [];
      let concatInputs = '';

      for (let i = 0; i < numVisuals; i++) {
        filterParts.push(`[${i}:v]fps=${fps},scale=${resX}:${resY}:force_original_aspect_ratio=decrease,pad=${resX}:${resY}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`);
        concatInputs += `[v${i}]`;
      }

      filterParts.push(`${concatInputs}concat=n=${numVisuals}:v=1:a=0[vout]`);

      // Mix audio
      if (numAudio > 0) {
        let amixInputs = '';
        for (let i = 0; i < numAudio; i++) {
          const audioIdx = numVisuals + i;
          const ac = audioClips[i];
          let volFilter = `volume=${ac.volume}`;
          if (ac.fadeIn > 0) volFilter += `,afade=t=in:d=${ac.fadeIn}`;
          if (ac.fadeOut > 0) volFilter += `,afade=t=out:st=${Math.max(0, ac.duration - ac.fadeOut)}:d=${ac.fadeOut}`;
          // Delay audio to its start position and trim
          const delayMs = Math.max(0, Math.round(ac.startTime * 1000));
          filterParts.push(`[${audioIdx}:a]atrim=0:${ac.duration},${volFilter},adelay=${delayMs}|${delayMs},apad[a${i}]`);
          amixInputs += `[a${i}]`;
        }
        if (numAudio === 1) {
          filterParts.push(`${amixInputs}atrim=0:${totalDuration}[aout]`);
        } else {
          filterParts.push(`${amixInputs}amix=inputs=${numAudio}:duration=longest:dropout_transition=2,atrim=0:${totalDuration}[aout]`);
        }
      } else {
        // Generate silent audio
        filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${totalDuration}[aout]`);
      }

      const filterComplex = filterParts.join(';');

      // Codec settings
      const isWebm = format === 'webm';
      const videoCodec = isWebm ? 'libvpx-vp9' : 'libx264';
      const audioCodec = isWebm ? 'libopus' : 'aac';

      ffmpegArgs.push(
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', videoCodec,
        ...(isWebm ? ['-b:v', '2M'] : ['-preset', 'medium', '-crf', String(crf)]),
        '-c:a', audioCodec,
        '-b:a', '192k',
        '-t', String(totalDuration),
        '-pix_fmt', 'yuv420p',
        ...(isWebm ? [] : ['-movflags', '+faststart']),
        '-y',
        outputPath,
      );

      debugLog.info('render-video', `Starting render: ${numVisuals} visual clips, ${numAudio} audio clips, ${totalDuration}s, ${resX}x${resY} @ ${fps}fps`);

      const ffmpegBin = '/opt/homebrew/bin/ffmpeg';
      const ffproc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      // Store process for potential cancellation
      (ctx as any)._renderProcess = ffproc;

      let stderrLog = '';
      ffproc.stderr?.on('data', (chunk: Buffer) => {
        stderrLog += chunk.toString();
      });

      await new Promise<void>((resolve, reject) => {
        ffproc.on('close', (code: number | null) => {
          (ctx as any)._renderProcess = null;
          if (code === 0) resolve();
          else {
            const lines = stderrLog.trim().split('\n');
            const lastLines = lines.slice(-5).join('\n');
            reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`));
          }
        });
        ffproc.on('error', (err: Error) => {
          (ctx as any)._renderProcess = null;
          reject(err);
        });
      });

      const outputStat = await stat(outputPath);
      const fileSizeMB = (outputStat.size / (1024 * 1024)).toFixed(1);

      debugLog.info('render-video', `Render complete: ${outputPath} (${fileSizeMB}MB)`);

      sendJson(res, 200, {
        success: true,
        videoPath: outputPath,
        duration: totalDuration,
        fileSize: outputStat.size,
        fileSizeMB,
        scenes: numVisuals,
        audioTracks: numAudio,
      });
    } catch (err) {
      debugLog.error('render-video', `Render failed: ${err}`);
      sendJson(res, 500, { error: 'Render failed: ' + (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  // ── POST /api/app/:id/render-cancel ────────────────────────
  if (req.method === 'POST' && subPath === '/render-cancel') {
    const proc = (ctx as any)._renderProcess as ChildProcess | null;
    if (proc) {
      proc.kill('SIGTERM');
      (ctx as any)._renderProcess = null;
    }
    sendJson(res, 200, { success: true });
    return true;
  }

  // ── POST /api/app/:id/open-path ─────────────────────────────
  // Open a file or folder in the system file manager (Finder on macOS).
  if (req.method === 'POST' && subPath === '/open-path') {
    const body = await readBody(req);
    const targetPath: string = body.path;
    if (!targetPath) {
      sendJson(res, 400, { error: 'path required' });
      return true;
    }
    try {
      const { exec } = await import('node:child_process');
      if (process.platform === 'darwin') {
        // -R reveals the file in Finder
        exec(`open -R "${targetPath.replace(/"/g, '\\"')}"`);
      } else if (process.platform === 'win32') {
        exec(`explorer /select,"${targetPath.replace(/"/g, '\\"')}"`);
      } else {
        exec(`xdg-open "${targetPath.replace(/"/g, '\\"')}"`);
      }
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  // ── POST /api/app/:id/generate-logo ─────────────────────────
  // Generate a logo image for the pipeline via nanobanana.
  if (req.method === 'POST' && subPath === '/generate-logo') {
    const body = await readBody(req);
    const prompt: string = body.prompt;
    if (!prompt) {
      sendJson(res, 400, { error: 'prompt required' });
      return true;
    }

    try {
      // Determine output path — prefer project folder, fall back to pipeline dir
      const projFolder = await resolveProjectFolder(pipelineId);
      const logoDir = join(projFolder, 'assets');
      await mkdir(logoDir, { recursive: true });
      const outputPath = join(logoDir, `pipeline-logo.png`);

      // Call nanobanana
      await ctx.extensionManager?.whenReady();
      const tools = ctx.extensionManager?.getAllTools() ?? [];
      const nbTool = tools.find(t => t.definition.name === 'nanobanana');

      let filePath: string;

      if (nbTool) {
        const result = await nbTool.handler({
          action: 'generate',
          prompt,
          outputPath,
          aspectRatio: '1:1',
        }, { workingDirectory: logoDir } as any);
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!parsed.success) throw new Error(parsed.error || 'Generation failed');
        filePath = parsed.imagePath || parsed.filePath || outputPath;
      } else {
        // Try direct import
        const { nanobanana: nb } = await import('../../loop/tools/nanobanana.js');
        const result = JSON.parse(await nb({
          action: 'generate',
          prompt,
          outputPath,
          aspectRatio: '1:1',
        } as any, logoDir));
        if (!result.success) throw new Error(result.error || 'Generation failed');
        filePath = result.imagePath || result.filePath || outputPath;
      }

      sendJson(res, 200, { success: true, filePath });
    } catch (err) {
      debugLog.error('generate-logo', `Error: ${err}`);
      sendJson(res, 500, { error: (err instanceof Error ? err.message : String(err)) });
    }
    return true;
  }

  // ── GET /api/app/:id/rules ───────────────────────────────────
  // Get binding rules for this pipeline
  if (req.method === 'GET' && subPath === '/rules') {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (entry?.isV2Pipeline && entry.pipelineDir) {
      const rulesDoc = await loadRules(entry.pipelineDir);
      sendJson(res, 200, rulesDoc);
    } else {
      sendJson(res, 200, { version: '1.0', pipelineId, rules: [] });
    }
    return true;
  }

  // ── PUT /api/app/:id/rules ───────────────────────────────────
  // Save binding rules for this pipeline
  if (req.method === 'PUT' && subPath === '/rules') {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (!entry?.isV2Pipeline || !entry.pipelineDir) {
      sendJson(res, 400, { error: 'Not a v2 pipeline' });
      return true;
    }
    const body = await readBody(req);
    const rulesDoc: RulesDocument = {
      version: '1.0',
      pipelineId,
      rules: body.rules || [],
    };
    await saveRules(entry.pipelineDir, rulesDoc);
    sendJson(res, 200, rulesDoc);
    return true;
  }

  // ── POST /api/app/:id/rules/run ──────────────────────────────
  // Execute binding rules against current pipeline data.
  // Scans node outputs for entities, applies text-match rules,
  // and creates new bindings. No hardcoded domain logic — everything
  // comes from the pipeline's own rules configuration.
  if (req.method === 'POST' && subPath === '/rules/run') {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (!entry?.isV2Pipeline || !entry.pipelineDir) {
      sendJson(res, 400, { error: 'Not a v2 pipeline' });
      return true;
    }

    const rulesDoc = await loadRules(entry.pipelineDir);
    if (rulesDoc.rules.length === 0) {
      sendJson(res, 200, { added: 0, removed: 0, message: 'No rules configured' });
      return true;
    }

    const result = await autoRunRules(pipelineId, entry.pipelineDir, rulesDoc);

    debugLog.info('rules-run', `Applied ${rulesDoc.rules.length} rules: ${result.added} added, ${result.replaced} replaced`);
    sendJson(res, 200, {
      rulesApplied: rulesDoc.rules.length,
      added: result.added,
      replaced: result.replaced,
      totalBindings: result.totalBindings,
    });
    return true;
  }


  // ── PUT /api/app/:id/element/:elementId ──────────────────────
  // Update a single element's field (e.g., shot description)
  const elementMatch = subPath.match(/^\/element\/([^/]+)$/);
  if (req.method === 'PUT' && elementMatch) {
    const elementId = decodeURIComponent(elementMatch[1]);
    const body = await readBody(req);
    const { field, value, elementType } = body;

    if (!field || value === undefined) {
      sendJson(res, 400, { error: 'field and value required' });
      return true;
    }

    // Find and update the element in app state
    const dir = join(APP_STATE_DIR, pipelineId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      sendJson(res, 404, { error: 'No app state found' });
      return true;
    }

    let updated = false;
    for (const file of files) {
      if (!file.endsWith('.json') || file === '_manifest.json') continue;
      const filePath = join(dir, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (updateElementField(data, elementId, field, value)) {
          await writeFile(filePath, JSON.stringify(data, null, 2));
          updated = true;
          debugLog.info('element-update', `Updated ${elementType} ${elementId}.${field} in ${file}`);
          break;
        }
      } catch { /* skip */ }
    }

    if (!updated) {
      sendJson(res, 404, { error: 'Element not found: ' + elementId });
      return true;
    }

    // Update manifest to mark as manually edited
    const manifest = await loadManifest(pipelineId);
    if (manifest) {
      // Find which node contains this element and mark it edited
      // For now, just update the timestamp
      await saveManifest(manifest);
    }

    sendJson(res, 200, { success: true, elementId, field, value });
    return true;
  }

  // ── GET /api/app/:id/views — discover pipeline-local custom views ──
  if (req.method === 'GET' && subPath === '/views') {
    const compositions = await discoverCompositions();
    const entry = compositions.find((c: any) => c.composition.id === pipelineId);
    if (!entry || !entry.pipelineDir) {
      sendJson(res, 200, { views: [] });
      return true;
    }

    const viewsDir = join(entry.pipelineDir, 'views');
    const views: Array<{ name: string; label: string; icon?: string; hasCSS: boolean; description?: string }> = [];

    try {
      const entries = await readdir(viewsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const viewDir = join(viewsDir, ent.name);

        // Must have a view.js
        const jsPath = join(viewDir, 'view.js');
        try { await access(jsPath); } catch { continue; }

        // Check for optional manifest.json
        let manifest: any = { name: ent.name, label: ent.name };
        try {
          const raw = await readFile(join(viewDir, 'manifest.json'), 'utf-8');
          manifest = { ...manifest, ...JSON.parse(raw) };
        } catch { /* no manifest, use defaults */ }

        // Check for optional view.css
        let hasCSS = false;
        try { await access(join(viewDir, 'view.css')); hasCSS = true; } catch { /* no css */ }

        views.push({
          name: ent.name,
          label: manifest.label || manifest.name || ent.name,
          icon: manifest.icon,
          hasCSS,
          description: manifest.description,
        });
      }
    } catch { /* no views directory */ }

    sendJson(res, 200, { views });
    return true;
  }

  // ── GET /api/app/:id/view-file/:viewName/:fileName — serve pipeline-local view files ──
  const viewFileMatch = subPath.match(/^\/view-file\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && viewFileMatch) {
    const viewName = decodeURIComponent(viewFileMatch[1]);
    const fileName = decodeURIComponent(viewFileMatch[2]);

    // Only allow safe file names (no path traversal)
    if (fileName.includes('..') || fileName.includes('/') || viewName.includes('..') || viewName.includes('/')) {
      sendJson(res, 400, { error: 'Invalid file name' });
      return true;
    }

    // Only serve .js and .css files
    const allowed = ['.js', '.css'];
    const ext = fileName.substring(fileName.lastIndexOf('.'));
    if (!allowed.includes(ext)) {
      sendJson(res, 400, { error: 'Only .js and .css files are allowed' });
      return true;
    }

    const compositions = await discoverCompositions();
    const entry = compositions.find((c: any) => c.composition.id === pipelineId);
    if (!entry || !entry.pipelineDir) {
      sendJson(res, 404, { error: 'Pipeline not found' });
      return true;
    }

    const filePath = join(entry.pipelineDir, 'views', viewName, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const mimeType = ext === '.js' ? 'application/javascript' : 'text/css';
      res.writeHead(200, {
        'Content-Type': mimeType + '; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      sendJson(res, 404, { error: 'View file not found' });
    }
    return true;
  }

  // ── POST /api/app/:id/extract-pdf-text — extract text from uploaded PDF ──
  if (req.method === 'POST' && subPath === '/extract-pdf-text') {
    try {
      // Read raw body as buffer
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);

      // Use pdfjs-dist with spatial awareness to preserve screenplay formatting
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs') as any;
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;

      // Get page width from first page to determine column positions
      const page1 = await doc.getPage(1);
      const viewport = page1.getViewport({ scale: 1 });
      const pageWidth = viewport.width; // typically ~612 for letter
      const pageHeight = viewport.height;

      let fullText = '';

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();

        // Group items by Y position (same line)
        interface TextItem { str: string; x: number; y: number; width: number; fontSize: number; }
        const items: TextItem[] = content.items
          .filter((item: any) => item.str && item.str.trim())
          .map((item: any) => ({
            str: item.str,
            x: item.transform[4],          // horizontal position
            y: Math.round(item.transform[5]), // vertical position (round to group)
            width: item.width,
            fontSize: Math.abs(item.transform[0]),
          }));

        // Sort by Y descending (top to bottom), then X ascending (left to right)
        items.sort((a, b) => b.y - a.y || a.x - b.x);

        // Group into lines by Y proximity
        const lines: TextItem[][] = [];
        let currentLine: TextItem[] = [];
        let lastY = -1;
        for (const item of items) {
          if (lastY >= 0 && Math.abs(item.y - lastY) > 3) {
            if (currentLine.length) lines.push(currentLine);
            currentLine = [];
          }
          currentLine.push(item);
          lastY = item.y;
        }
        if (currentLine.length) lines.push(currentLine);

        // Reconstruct lines preserving indentation
        for (const lineItems of lines) {
          lineItems.sort((a, b) => a.x - b.x);
          const firstX = lineItems[0].x;

          // Build the line text, preserving gaps between items
          let lineText = '';
          for (let j = 0; j < lineItems.length; j++) {
            if (j > 0) {
              const gap = lineItems[j].x - (lineItems[j-1].x + lineItems[j-1].width);
              if (gap > 10) lineText += '  '; // wide gap = intentional spacing
              else if (gap > 2) lineText += ' ';
            }
            lineText += lineItems[j].str;
          }

          // Determine element type from x-position
          // Standard screenplay PDF positions (letter size, 612pt width):
          //   Action/Scene heading: x≈108 (1.5" left margin)
          //   Dialogue: x≈180 (2.5")
          //   Character name: x≈252 (3.5", centered)
          //   Parenthetical: x≈216 (3.0")
          //   Transition: x≈400+ (right-aligned)
          //   Page numbers: x≈507 (right margin)

          const trimmed = lineText.trim();
          if (!trimmed) { fullText += '\n'; continue; }

          // Skip page numbers (single numbers near right margin)
          if (/^\d+\.?$/.test(trimmed) && firstX > pageWidth * 0.7) continue;
          // Skip CONTINUED markers
          if (/^(CONTINUED|MORE|\(CONTINUED\)|\(MORE\))$/i.test(trimmed)) continue;

          // Classify by x-position using adaptive thresholds based on page width
          const actionX = pageWidth * 0.17;    // ~108 on letter
          const dialogueX = pageWidth * 0.27;  // ~165 on letter
          const parenthX = pageWidth * 0.33;   // ~202 on letter
          const characterX = pageWidth * 0.38; // ~232 on letter
          const transitionX = pageWidth * 0.60; // ~367 on letter

          if (firstX >= transitionX) {
            // Transition (right-aligned)
            fullText += '\n' + trimmed + '\n';
          } else if (firstX >= characterX) {
            // Character name (centered)
            fullText += '\n' + trimmed + '\n';
          } else if (firstX >= parenthX) {
            // Parenthetical
            if (!trimmed.startsWith('(')) fullText += '(' + trimmed + ')\n';
            else fullText += trimmed + '\n';
          } else if (firstX >= dialogueX) {
            // Dialogue
            fullText += trimmed + '\n';
          } else {
            // Action or scene heading (left-aligned)
            if (/^(INT|EXT|EST|INT\.?\/?EXT)/i.test(trimmed)) {
              fullText += '\n' + trimmed + '\n';
            } else {
              fullText += '\n' + trimmed + '\n';
            }
          }
        }

        fullText += '\n'; // page break
      }

      // Clean up excessive blank lines
      fullText = fullText.replace(/\n{4,}/g, '\n\n\n');

      sendJson(res, 200, { text: fullText.trim(), pages: doc.numPages });
    } catch (err: any) {
      sendJson(res, 500, { error: 'Failed to parse PDF: ' + (err.message || String(err)) });
    }
    return true;
  }

  // ── POST /api/app/:id/generate-assets — generate headshots and location shots ──
  if (req.method === 'POST' && subPath === '/generate-assets') {
    try {
      const body = await readBody(req);
      const entityType = body.type || 'all'; // 'characters', 'locations', or 'all'

      // Get project folder
      const pfolder = await resolveProjectFolder(pipelineId);
      const project = await loadProjectFile(pfolder);
      if (!project) {
        sendJson(res, 400, { error: 'No project data found' });
        return true;
      }

      // Import nanobanana
      let nanobananaTool: any;
      try {
        const { nanobanana: nb } = await import('../../loop/tools/nanobanana.js');
        nanobananaTool = nb;
      } catch (err) {
        sendJson(res, 500, { error: 'Image generation not available: ' + String(err) });
        return true;
      }

      const results: Array<{ name: string; type: string; path?: string; error?: string }> = [];

      // Generate character headshots
      if (entityType === 'characters' || entityType === 'all') {
        const chars = project.characters || [];
        const charDir = join(pfolder, 'characters');
        await mkdir(charDir, { recursive: true });

        for (const char of chars) {
          try {
            let prompt = `Professional headshot portrait of ${char.name || 'a person'}`;
            if (char.description) prompt += `. ${char.description}`;
            if (char.ageRange) prompt += ` Age: ${char.ageRange}.`;
            if (char.gender) prompt += ` ${char.gender}.`;
            if (char.wardrobeNotes) prompt += ` Wearing: ${char.wardrobeNotes}.`;
            prompt += ' Cinematic lighting, studio portrait, shallow depth of field, 85mm lens. Photorealistic.';

            const safeName = (char.id || char.name || 'char').replace(/[^a-zA-Z0-9_-]/g, '_');
            const outputPath = join(charDir, `${safeName}.png`);

            const result = await nanobananaTool({
              action: 'generate' as const,
              prompt,
              model: 'flash',
              aspectRatio: '3:4',
              outputPath,
            }, charDir);

            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            const imgPath = parsed.path || outputPath;
            results.push({ name: char.name, type: 'character', path: imgPath });
            // Save incrementally so polling clients see new images
            char.imagePath = imgPath;
            await saveProjectFile(pfolder, project);
          } catch (err: any) {
            results.push({ name: char.name, type: 'character', error: err.message || String(err) });
          }
        }
      }

      // Generate location shots
      if (entityType === 'locations' || entityType === 'all') {
        const locs = project.locations || [];
        const locDir = join(pfolder, 'locations');
        await mkdir(locDir, { recursive: true });

        for (const loc of locs) {
          try {
            let prompt = `Cinematic establishing shot of ${loc.name || 'a location'}`;
            if (loc.description) prompt += `. ${loc.description}`;
            if (loc.mood) prompt += ` Mood: ${loc.mood}.`;
            if (loc.atmosphere) prompt += ` ${loc.atmosphere}`;
            prompt += ' Wide-angle lens, dramatic lighting, film grain, professional cinematography. 35mm film look.';

            const safeName = (loc.id || loc.name || 'loc').replace(/[^a-zA-Z0-9_-]/g, '_');
            const outputPath = join(locDir, `${safeName}.png`);

            const result = await nanobananaTool({
              action: 'generate' as const,
              prompt,
              model: 'flash',
              aspectRatio: '16:9',
              outputPath,
            }, locDir);

            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            const imgPath = parsed.path || outputPath;
            results.push({ name: loc.name, type: 'location', path: imgPath });
            // Save incrementally so polling clients see new images
            loc.imagePath = imgPath;
            await saveProjectFile(pfolder, project);
          } catch (err: any) {
            results.push({ name: loc.name, type: 'location', error: err.message || String(err) });
          }
        }
      }

      // Save image paths back into project.json
      for (const r of results) {
        if (!r.path) continue;
        if (r.type === 'character') {
          const char = project.characters?.find((c: any) => c.name === r.name);
          if (char) char.imagePath = r.path;
        } else if (r.type === 'location') {
          const loc = project.locations?.find((l: any) => l.name === r.name);
          if (loc) loc.imagePath = r.path;
        }
      }
      await saveProjectFile(pfolder, project);

      const succeeded = results.filter(r => r.path).length;
      const failed = results.filter(r => r.error).length;
      sendJson(res, 200, { success: true, generated: succeeded, failed, results });
    } catch (err: any) {
      sendJson(res, 500, { error: 'Asset generation failed: ' + (err.message || String(err)) });
    }
    return true;
  }

  return false;
};

// ────────────────────────────────────────────────────────────────
//  Auto-run rules — shared by /rules/run and generate-previs
// ────────────────────────────────────────────────────────────────

/**
 * Run binding rules against a pipeline's app state data.
 * Discovers entities automatically and applies text-match rules.
 * Returns the number of bindings added/replaced.
 */
async function autoRunRules(
  pipelineId: string,
  pipelineDir: string,
  rulesDoc: RulesDocument,
): Promise<{ added: number; replaced: number; totalBindings: number }> {
  // Load all node outputs from app state
  const stateDir = join(APP_STATE_DIR, pipelineId);
  let nodeDataFiles: string[] = [];
  try { nodeDataFiles = await readdir(stateDir); } catch { /* empty */ }

  const sourceEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];
  const targetEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];

  const sourceTypes = new Set(rulesDoc.rules.map(r => r.source.entityType));
  const targetTypes = new Set(rulesDoc.rules.map(r => r.target.entityType));

  // Track seen IDs across all files to prevent duplicates
  const seenSourceIds = new Set<string>();
  const seenTargetIds = new Set<string>();

  for (const f of nodeDataFiles) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const raw = await readFile(join(stateDir, f), 'utf-8');
      const nodeData = JSON.parse(raw);
      // App state files store data at the top level (not under outputs)
      // Try nodeData.outputs first (pipeline run format), fall back to nodeData itself
      const outputs = nodeData.outputs || nodeData;
      scanForEntities(outputs, sourceTypes, sourceEntities, seenSourceIds);
      scanForEntities(outputs, targetTypes, targetEntities, seenTargetIds);
    } catch { /* skip */ }
  }

  debugLog.info('auto-run-rules', `Discovered ${sourceEntities.length} source entities, ${targetEntities.length} target entities`);

  const newBindings = applyRules(rulesDoc.rules, sourceEntities, targetEntities);

  // Deduplicate: first against manual bindings, then within newBindings itself
  const bindingsDoc = await loadBindings(pipelineDir);
  const manualBindings = bindingsDoc.bindings.filter(b => !b.origin.startsWith('auto:'));
  
  // Build a set of all existing keys (manual bindings)
  const existingKeys = new Set(
    manualBindings.map(b => `${b.source.entityId}:${b.target.entityId}:${b.type}`)
  );
  
  // Deduplicate newBindings: skip if already in existingKeys OR already seen in this batch
  const uniqueNew = [];
  for (const b of newBindings) {
    const key = `${b.source.entityId}:${b.target.entityId}:${b.type}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key); // Mark as seen so subsequent duplicates are skipped
      uniqueNew.push(b);
    }
  }

  const oldAutoCount = bindingsDoc.bindings.filter(b => b.origin.startsWith('auto:')).length;
  bindingsDoc.bindings = [...manualBindings, ...uniqueNew];
  bindingsDoc.pipelineId = pipelineId;
  await saveBindings(pipelineDir, bindingsDoc);

  return {
    added: uniqueNew.length,
    replaced: oldAutoCount,
    totalBindings: bindingsDoc.bindings.length,
  };
}

// ────────────────────────────────────────────────────────────────
//  Entity scanner — extract typed entities from node outputs
// ────────────────────────────────────────────────────────────────

/**
 * Recursively scan node outputs for arrays of objects that match
 * the expected entity types. Uses heuristics: array key name,
 * item.type field, or singular form of the key.
 */
function scanForEntities(
  obj: any,
  targetTypes: Set<string>,
  results: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
  seenIds: Set<string>,
) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') {
      // Determine entity type from:
      // 1. item.type field (e.g., { type: "shot", ... })
      // 2. singular of array key (e.g., "characters" → "character")
      // 3. the key itself
      for (const item of val) {
        const itemType: string = (
          item.type ||
          key.replace(/s$/, '') ||
          key
        ).toLowerCase();

        if (!targetTypes.has(itemType)) continue;

        const itemId = item.id || item.libraryId || item.assetId || item.slug;
        if (!itemId || seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        results.push({
          entityType: itemType,
          entityId: itemId,
          data: item,
        });
      }
    }
    // Recurse into nested objects (but not arrays — already handled)
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      scanForEntities(val, targetTypes, results, seenIds);
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Action config loader — reads pipeline-owned behavior configs
// ────────────────────────────────────────────────────────────────

/**
 * Load an action config from the pipeline's actions/ directory.
 * Returns the config or a safe empty default if not found.
 *
 * Action configs live at <pipelineDir>/actions/<actionId>.json.
 * They define pipeline-specific behavior that the server executes.
 * The chat agent can modify these files when the user asks for changes.
 */
async function loadActionConfig(pipelineDir: string | undefined, actionId: string): Promise<Record<string, any>> {
  if (!pipelineDir) return {};
  const configPath = join(pipelineDir, 'actions', `${actionId}.json`);
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

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
  scenes?: any[];                        // scene-grouped data (SceneData[])
}

/**
 * Collect all screenplay-related data from a pipeline's app state.
 * Walks all node outputs looking for characters, locations, elements,
 * previs shots, and assets — then builds lookup maps.
 */
async function collectScreenplayData(pipelineId: string): Promise<ScreenplayData | null> {
  const dir = join(APP_STATE_DIR, pipelineId);

  let allCharacters: any[] = [];
  let allLocations: any[] = [];
  let allElements: any[] = [];
  let allPrevis: any[] = [];
  let allAssets: any[] = [];

  // Try reading from project.json first (project folder mode)
  try {
    const projFolder = await resolveProjectFolder(pipelineId);
    const projJsonPath = join(projFolder, 'project.json');
    const projRaw = await readFile(projJsonPath, 'utf-8');
    const projData = JSON.parse(projRaw);
    if (projData.characters) allCharacters = projData.characters;
    if (projData.locations) allLocations = projData.locations;
    if (projData.elements) allElements = projData.elements;
    if (projData.previsualizations?.shots) allPrevis = projData.previsualizations.shots;
    if (projData.assets) allAssets = projData.assets;
  } catch { /* no project.json, fall through to node state */ }

  // Also scan node state files (may have additional/newer data)
  let files: string[];
  try {
    files = await readdir(dir);
  } catch { files = []; }

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
      // Also check for assetCollection wrapper (common in screenplay pipelines)
      if (k === 'assetCollection' && typeof v === 'object' && !Array.isArray(v) && v.assets) {
        if (Array.isArray(v.assets) && v.assets.length > allAssets.length) allAssets = v.assets;
      }

      if (typeof v === 'object' && !Array.isArray(v)) {
        extractScreenplayFields(v, depth + 1);
      }
    }
  }

  if (allElements.length === 0) return null;

  debugLog.info('collectScreenplayData', `Found ${allAssets.length} assets, ${allCharacters.length} characters, ${allElements.length} elements`);

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
  // Fallback: use character.imagePath directly (project.json mode)
  for (const c of allCharacters) {
    if (c.imagePath && !characterAssets[c.id]) {
      characterAssets[c.id] = { id: c.id, filePath: c.imagePath, type: 'character-headshot' };
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
  // Fallback: use location.imagePath directly (project.json mode)
  for (const l of allLocations) {
    if (l.imagePath && !locationAssets[l.id]) {
      locationAssets[l.id] = { id: l.id, filePath: l.imagePath, type: 'landscape' };
    }
  }

  debugLog.info('collectScreenplayData', `Mapped ${Object.keys(characterAssets).length} character assets: ${Object.keys(characterAssets).join(', ')}`);

  // Load scenes from project.json if available
  let scenes: any[] | undefined;
  try {
    const projFolder = await resolveProjectFolder(pipelineId);
    const projRaw = await readFile(join(projFolder, 'project.json'), 'utf-8');
    const projData = JSON.parse(projRaw);
    if (projData.scenes && Array.isArray(projData.scenes)) {
      scenes = projData.scenes;
    }
  } catch { /* no project.json or no scenes field */ }

  return { characters, locations, elementMap, previsMap, characterAssets, locationAssets, assetMap, scenes };
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

  let updatedShots = false;
  let updatedAsset = false;

  for (const file of files) {
    if (!file.endsWith('.json') || file === '_manifest.json') continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      let changed = false;

      // Update the previs shots entry (_generatedFilePath)
      if (!updatedShots && updatePrevisInObj(data, elementId, newFilePath)) {
        updatedShots = true;
        changed = true;
        debugLog.info('generate-previs', `Updated previs shot in ${file} for ${elementId}`);
      }

      // Update the asset in assetCollection (filePath on the asset itself)
      if (!updatedAsset && updatePrevisAssetFilePath(data, elementId, newFilePath)) {
        updatedAsset = true;
        changed = true;
        debugLog.info('generate-previs', `Updated asset filePath in ${file} for ${elementId}`);
      }

      if (changed) {
        await writeFile(filePath, JSON.stringify(data, null, 2));
      }
    } catch { /* skip */ }

    if (updatedShots && updatedAsset) return;
  }
}

/**
 * Update the filePath on a previs-frame asset in an assetCollection.
 * Matches assets where metadata.shotElementId === elementId.
 */
function updatePrevisAssetFilePath(obj: any, elementId: string, newFilePath: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item?.type === 'previs-frame' && item?.metadata?.shotElementId === elementId) {
        item.filePath = newFilePath;
        return true;
      }
      if (updatePrevisAssetFilePath(item, elementId, newFilePath)) return true;
    }
    return false;
  }
  for (const k of Object.keys(obj)) {
    if (updatePrevisAssetFilePath(obj[k], elementId, newFilePath)) return true;
  }
  return false;
}

/**
 * Recursively walk an object to find and update the previs shot matching elementId.
 * Updates the asset's filePath or creates a new asset entry.
 */

/**
 * Recursively walk an object to find and update an element by ID.
 * Updates the specified field on the element.
 */
function updateElementField(obj: any, elementId: string, field: string, value: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      // Check if this item is the element we're looking for
      if (item?.id === elementId) {
        item[field] = value;
        item._editedAt = new Date().toISOString();
        return true;
      }
      if (updateElementField(item, elementId, field, value)) return true;
    }
    return false;
  }
  // Check if this object is the element
  if (obj.id === elementId) {
    obj[field] = value;
    obj._editedAt = new Date().toISOString();
    return true;
  }
  // Recurse into object properties
  for (const k of Object.keys(obj)) {
    if (updateElementField(obj[k], elementId, field, value)) return true;
  }
  return false;
}

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

/**
 * Add or update a dialogue-audio asset in the app state.
 * Finds the node file containing the assetCollection and adds the asset,
 * replacing any existing asset for the same dialogueElementId.
 */
async function addDialogueAudioAsset(pipelineId: string, asset: any): Promise<void> {
  const dir = join(APP_STATE_DIR, pipelineId);
  let files: string[];
  try { files = await readdir(dir); } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.json') || file === '_manifest.json') continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (insertDialogueAudioInObj(data, asset)) {
        await writeFile(filePath, JSON.stringify(data, null, 2));
        debugLog.info('generate-dialogue-audio', `Added dialogue-audio asset to ${file} for ${asset.metadata?.dialogueElementId}`);
        return;
      }
    } catch { /* skip */ }
  }

  // If no assetCollection found in any node, log a warning
  debugLog.info('generate-dialogue-audio', `No assetCollection found in any node for pipeline ${pipelineId}`);
}

/**
 * Recursively walk an object to find an `assetCollection` with an `assets` array.
 * Remove any existing dialogue-audio for the same dialogueElementId, then append the new asset.
 */
function insertDialogueAudioInObj(obj: any, asset: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (insertDialogueAudioInObj(item, asset)) return true;
    }
    return false;
  }
  // Check if this object has an assets array (assetCollection or similar)
  if (obj.assetCollection && Array.isArray(obj.assetCollection.assets)) {
    const assets: any[] = obj.assetCollection.assets;
    const dialogueElementId = asset.metadata?.dialogueElementId;
    // Remove any existing dialogue-audio for this same element
    if (dialogueElementId) {
      for (let i = assets.length - 1; i >= 0; i--) {
        if (assets[i]?.type === 'dialogue-audio' &&
            assets[i]?.metadata?.dialogueElementId === dialogueElementId) {
          assets.splice(i, 1);
        }
      }
    }
    assets.push(asset);
    return true;
  }
  for (const k of Object.keys(obj)) {
    if (insertDialogueAudioInObj(obj[k], asset)) return true;
  }
  return false;
}
