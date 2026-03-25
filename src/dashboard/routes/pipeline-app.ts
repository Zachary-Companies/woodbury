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
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import { topoSort, gatherInputVariables, getDownstreamNodes } from '../graph-utils.js';
import { debugLog } from '../../debug-log.js';
import { loadBindings, saveBindings, loadRules, saveRules, applyRules, getTargetIds, type RulesDocument } from '../pipeline-bindings.js';
import { loadPipelineRoutes } from '../pipeline-route-factory.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const APP_STATE_DIR = join(homedir(), '.woodbury', 'data', 'app-state');

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
  appConfig?: Record<string, any>;
  sections: AppSection[];
  edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>;
  executionOrder: string[];
}

// ────────────────────────────────────────────────────────────────
//  Project folder resolution
// ────────────────────────────────────────────────────────────────

/**
 * Resolve the external project folder for a pipeline (e.g. ~/Documents/The Last Jump).
 * Falls back to the pipeline's workflow dir.
 */
async function resolveProjectFolder(pipelineId: string): Promise<string> {
  try {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (entry) {
      const folder = entry.composition?.metadata?.projectFolder;
      if (folder && typeof folder === 'string') {
        await mkdir(folder, { recursive: true });
        return folder;
      }
      if (entry.pipelineDir) return entry.pipelineDir;
    }
  } catch { /* ignore */ }
  return join(APP_STATE_DIR, pipelineId);
}

// ── Node-to-project key mapping ──────────────────────────────

/** Read node-key map from pipeline appConfig, or return empty map */
function getNodeKeyMap(pipeline: any): Record<string, string | string[]> {
  return pipeline?.appConfig?.nodeKeyMap || {};
}

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
 * Convert a project.json into the nodeData format expected by the UI.
 * Uses the pipeline's appConfig.nodeKeyMap to map project keys → node IDs.
 * If no nodeKeyMap is provided, returns empty nodeData.
 */
function projectToNodeData(project: Record<string, any>, nodeKeyMap: Record<string, string | string[]>): Record<string, AppNodeData> {
  const now = project.updatedAt || new Date().toISOString();
  const nodeData: Record<string, AppNodeData> = {};

  // Build reverse map: projectKey → nodeId
  const reverseMap: Record<string, string> = {};
  for (const [nodeId, key] of Object.entries(nodeKeyMap)) {
    if (typeof key === 'string') reverseMap[key] = nodeId;
  }

  // Map project keys to node outputs using the pipeline's nodeKeyMap
  for (const [projKey, nodeId] of Object.entries(reverseMap)) {
    if (projKey.startsWith('_')) continue; // skip special keys like _assembly, _output
    if (project[projKey] !== undefined) {
      nodeData[nodeId] = { outputs: { [projKey]: project[projKey] }, updatedAt: now, manuallyEdited: false };
    }
  }

  // Scene-grouped data (if present in project but not in nodeKeyMap, skip)
  if (project.scenes && !reverseMap['scenes']) {
    // Find a node that maps to ruleEnforcement or similar
    const rulesNodeId = reverseMap['ruleEnforcement'];
    if (rulesNodeId) {
      nodeData[rulesNodeId] = { outputs: { scenes: project.scenes }, updatedAt: now, manuallyEdited: false };
    }
  }

  // Assembly node — build a scriptPackage if the pipeline declares _assembly
  const assemblyNodeId = reverseMap['_assembly'];
  if (assemblyNodeId) {
    nodeData[assemblyNodeId] = {
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
          scenes: project.scenes || [],
        },
        _fountainSource: project._fountainSource || '',
      },
      updatedAt: now,
      manuallyEdited: false,
    };
  }

  return nodeData;
}

async function findPipeline(workDir: string, pipelineId: string): Promise<any | null> {
  const discovered = await discoverCompositions(workDir);
  const entry = discovered.find((d: any) => d?.composition?.id === pipelineId);
  return entry?.composition || null;
}

// ────────────────────────────────────────────────────────────────
//  Auto-save from pipeline runs (called by composition-run.ts)
// ────────────────────────────────────────────────────────────────

/**
 * Persist node outputs from a completed pipeline run.
 * Routes through ProjectStateManager when the project is loaded,
 * falls back to legacy file-based storage otherwise.
 *
 * @param ctx - DashboardContext (optional; when provided, uses ProjectStateManager)
 */
export async function persistAppStateFromRun(
  pipelineId: string,
  pipelineName: string,
  runId: string,
  nodeOutputs: Record<string, Record<string, unknown>>,
  executionOrder: string[],
  ctx?: DashboardContext,
): Promise<void> {
  try {
    if (!ctx?.projectState) {
      debugLog.info('app-state', `No ProjectStateManager available — skipping auto-save for "${pipelineName}"`);
      return;
    }

    // Ensure project is loaded
    if (!ctx.projectState.isLoaded(pipelineId)) {
      try {
        const compositions = await discoverCompositions();
        const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
        const pfolder = entry?.composition?.metadata?.projectFolder;
        if (pfolder) {
          await ctx.projectState.load(pipelineId, pipelineName, pfolder);
        }
      } catch { /* ignore */ }
    }

    if (ctx.projectState.isLoaded(pipelineId)) {
      ctx.projectState.applyRunOutputs(pipelineId, runId, nodeOutputs, executionOrder);
      await ctx.projectState.flush(pipelineId);
      debugLog.info('app-state', `Auto-saved via ProjectStateManager for "${pipelineName}"`, { pipelineId, runId });
    } else {
      debugLog.info('app-state', `No project folder configured — skipping auto-save for "${pipelineName}"`);
    }
  } catch (err) {
    debugLog.error('app-state', `Failed to auto-save app state for "${pipelineName}"`, { error: String(err) });
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
    appConfig: pipeline.appConfig || undefined,
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

/** Resolve project folder from ProjectStateManager or composition metadata. */
async function resolveProjectFolderFromCtx(pipelineId: string, ctx: DashboardContext): Promise<string> {
  const pfolder = ctx.projectState?.getProjectFolder(pipelineId);
  if (pfolder) return pfolder;
  return resolveProjectFolder(pipelineId);
}

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
  // Reads from ProjectStateManager, returns in nodeData format for backward compat
  if (req.method === 'GET' && subPath === '/state') {
    let project = ctx.projectState.get(pipelineId);
    if (!project) {
      // Try to load into ProjectStateManager
      try {
        const compositions = await discoverCompositions();
        const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
        const pfolder = entry?.composition?.metadata?.projectFolder;
        if (pfolder) {
          project = await ctx.projectState.load(pipelineId, entry?.composition?.name || pipelineId, pfolder);
        }
      } catch { /* ignore */ }
    }

    if (project) {
      const pipeline = await findPipeline(ctx.workDir, pipelineId);
      const keyMap = getNodeKeyMap(pipeline);
      const nodeData = projectToNodeData(project as any, keyMap);
      const info = ctx.projectState.getInfo(pipelineId);
      sendJson(res, 200, {
        pipelineId,
        pipelineName: info?.pipelineName || pipelineId,
        sourceRunId: info?.lastRunId || null,
        nodeData,
        staleNodes: [],
        lastRunAt: info?.lastRunAt || null,
      });
    } else {
      // No project folder configured — return empty state
      const pipeline = await findPipeline(ctx.workDir, pipelineId);
      sendJson(res, 200, {
        pipelineId,
        pipelineName: pipeline?.name || pipelineId,
        sourceRunId: null,
        nodeData: {},
        staleNodes: [],
        lastRunAt: null,
      });
    }
    return true;
  }

  // ── DELETE /api/app/:id/state ─────────────────────────────
  // Clears all project state through ProjectStateManager
  if (req.method === 'DELETE' && subPath === '/state') {
    if (ctx.projectState.isLoaded(pipelineId)) {
      await ctx.projectState.clear(pipelineId);
    }
    sendJson(res, 200, { success: true });
    return true;
  }

  // ── PUT /api/app/:id/project — write project data ──
  if (req.method === 'PUT' && subPath === '/project') {
    const body = await readBody(req);
    const projectData = body.project || body;
    projectData.pipelineId = pipelineId;

    // Write through ProjectStateManager
    if (ctx.projectState?.isLoaded(pipelineId)) {
      ctx.projectState.update(pipelineId, projectData);
      await ctx.projectState.flush(pipelineId);
      const pfolder = ctx.projectState.getProjectFolder(pipelineId);
      sendJson(res, 200, { success: true, projectFolder: pfolder });
      return true;
    }

    // Try loading first
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

    await ctx.projectState.load(pipelineId, pipelineId, pfolder);
    ctx.projectState.update(pipelineId, projectData);
    await ctx.projectState.flush(pipelineId);

    sendJson(res, 200, { success: true, projectFolder: pfolder });
    return true;
  }

  // ── PUT /api/app/:id/state/:nodeId ───────────────────────
  // Saves a single node's data — routes through ProjectStateManager
  const stateMatch = subPath.match(/^\/state\/([^/]+)$/);
  if (req.method === 'PUT' && stateMatch) {
    const nodeId = decodeURIComponent(stateMatch[1]);
    const body = await readBody(req);
    const now = new Date().toISOString();
    const outputs = body.outputs || body;

    // Ensure project is loaded
    if (!ctx.projectState.isLoaded(pipelineId)) {
      try {
        const compositions = await discoverCompositions();
        const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
        const pfolder = entry?.composition?.metadata?.projectFolder;
        if (pfolder) {
          await ctx.projectState.load(pipelineId, entry?.composition?.name || pipelineId, pfolder);
        }
      } catch { /* ignore */ }
    }

    if (ctx.projectState.isLoaded(pipelineId)) {
      // Map node outputs to project data fields
      const partial: Record<string, any> = {};
      const sp = outputs.scriptPackage;
      if (sp) {
        const script = sp.script || sp;
        if (script.metadata) partial.metadata = script.metadata;
        if (script.characters) partial.characters = script.characters;
        if (script.locations) partial.locations = script.locations;
        if (script.sections) partial.sections = script.sections;
        if (script.elements) partial.elements = script.elements;
        if (sp.previsualizations) partial.previsualizations = sp.previsualizations;
        if (sp.assets) partial.assets = sp.assets;
        if (outputs._fountainSource) partial._fountainSource = outputs._fountainSource;
      } else {
        // Map using pipeline's nodeKeyMap for individual nodes
        const pipeline = await findPipeline(ctx.workDir, pipelineId);
        const nodeKeyMap = getNodeKeyMap(pipeline);
        const keyMapping = nodeKeyMap[nodeId];
        if (keyMapping && typeof keyMapping === 'string' && keyMapping !== '_assembly' && keyMapping !== '_output') {
          const val = outputs[keyMapping];
          if (val !== undefined) partial[keyMapping] = val;
          else Object.assign(partial, outputs);
        } else {
          Object.assign(partial, outputs);
        }
      }

      ctx.projectState.update(pipelineId, partial);
      sendJson(res, 200, { success: true, staleNodes: [], updatedAt: now });
    } else {
      sendJson(res, 400, { error: 'No project folder set for this pipeline' });
    }
    return true;
  }

  // ── POST /api/app/:id/refresh-from-run ───────────────────
  // Reload project data from disk (data may have been updated by a run)
  if (req.method === 'POST' && subPath === '/refresh-from-run') {
    if (ctx.projectState.isLoaded(pipelineId)) {
      const project = await ctx.projectState.reload(pipelineId);
      sendJson(res, 200, { refreshed: true, project });
    } else {
      sendJson(res, 404, { error: 'Project not loaded' });
    }
    return true;
  }

  // ── POST /api/app/:id/mark-stale ─────────────────────────
  // No-op in new architecture (kept for backward compat)
  if (req.method === 'POST' && subPath === '/mark-stale') {
    sendJson(res, 200, { staleNodes: [] });
    return true;
  }

  // ── GET /api/app/:id/saves ──────────────────────────────
  // List all saved snapshots for this pipeline
  if (req.method === 'GET' && subPath === '/saves') {
    const projFolder = await resolveProjectFolderFromCtx(pipelineId, ctx);
    const savesDir = join(projFolder, 'saves');
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
  // Create a new save (snapshot current state from project folder)
  if (req.method === 'POST' && subPath === '/saves') {
    const body = await readBody(req);
    const name: string = body.name || `Save ${new Date().toLocaleString()}`;
    const description: string = body.description || '';
    const customPath: string | undefined = body.path; // optional: save to custom location

    // Flush in-memory state to disk before saving
    if (ctx.projectState.isLoaded(pipelineId)) {
      await ctx.projectState.flush(pipelineId);
    }

    const projFolder = await resolveProjectFolderFromCtx(pipelineId, ctx);
    const info = ctx.projectState.getInfo(pipelineId);
    const pipelineName = info?.pipelineName || pipelineId;

    const saveId = `save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetDir = customPath
      ? resolve(customPath)
      : join(projFolder, 'saves', saveId);

    try {
      await mkdir(targetDir, { recursive: true });

      // Copy all project files from the project folder
      const files = await readdir(projFolder);
      let fileCount = 0;
      for (const f of files) {
        if (f === 'saves' || f.startsWith('.')) continue;
        const srcPath = join(projFolder, f);
        const s = await stat(srcPath);
        if (s.isFile()) {
          await cp(srcPath, join(targetDir, f));
          fileCount++;
        } else if (s.isDirectory()) {
          // Copy subdirectories (characters, locations, structure, previs, audio, etc.)
          await cp(srcPath, join(targetDir, f), { recursive: true });
          fileCount++;
        }
      }

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
        pipelineName,
        sourceRunId: info?.lastRunId || null,
        fileCount,
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
  // Restore app state from a save into the project folder
  const loadMatch = subPath.match(/^\/saves\/([^/]+)\/load$/);
  if (req.method === 'POST' && loadMatch) {
    const saveId = decodeURIComponent(loadMatch[1]);
    const body = await readBody(req);

    const projFolder = await resolveProjectFolderFromCtx(pipelineId, ctx);

    // Support loading from a custom path OR from the saves directory
    const sourceDir = body.path
      ? resolve(body.path)
      : join(projFolder, 'saves', saveId);

    try {
      // Verify save exists
      const metaPath = join(sourceDir, '_save-meta.json');
      await access(metaPath);

      // Clear current project folder contents (but preserve saves directory)
      const existingFiles = await readdir(projFolder);
      for (const f of existingFiles) {
        if (f === 'saves' || f.startsWith('.')) continue;
        const fullPath = join(projFolder, f);
        const s = await stat(fullPath);
        if (s.isFile()) {
          await rm(fullPath);
        } else if (s.isDirectory()) {
          await rm(fullPath, { recursive: true });
        }
      }

      // Copy save files into project folder
      const saveFiles = await readdir(sourceDir);
      for (const f of saveFiles) {
        if (f === '_save-meta.json') continue;
        const srcPath = join(sourceDir, f);
        const s = await stat(srcPath);
        if (s.isFile()) {
          await cp(srcPath, join(projFolder, f));
        } else if (s.isDirectory()) {
          await cp(srcPath, join(projFolder, f), { recursive: true });
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

      // Reload from disk into ProjectStateManager
      const reloaded = await ctx.projectState.reload(pipelineId);
      debugLog.info('pipeline-app', `Loaded save "${saveId}" for ${pipelineId} from ${sourceDir}`);
      sendJson(res, 200, { loaded: true, project: reloaded });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to load save: ${err.message}` });
    }
    return true;
  }

  // ── DELETE /api/app/:id/saves/:saveId ──────────────────────
  const deleteMatch = subPath.match(/^\/saves\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const saveId = decodeURIComponent(deleteMatch[1]);
    const projFolder3 = await resolveProjectFolderFromCtx(pipelineId, ctx);
    const saveDir = join(projFolder3, 'saves', saveId);
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
  // Load state from an arbitrary path into the project folder
  if (req.method === 'POST' && subPath === '/saves/load-from-path') {
    const body = await readBody(req);
    const loadPath: string = body.path;
    if (!loadPath) {
      sendJson(res, 400, { error: 'path is required' });
      return true;
    }

    const sourceDir = resolve(loadPath);
    try {
      // Check if it's a valid save (has project.json or save meta)
      let isValid = false;
      try { await access(join(sourceDir, 'project.json')); isValid = true; } catch {}
      try { await access(join(sourceDir, '_save-meta.json')); isValid = true; } catch {}
      if (!isValid) {
        sendJson(res, 400, { error: 'Not a valid save directory — no project.json or _save-meta.json found' });
        return true;
      }

      const projFolder = await resolveProjectFolderFromCtx(pipelineId, ctx);
      await mkdir(projFolder, { recursive: true });

      // Clear current project folder (preserve saves)
      const existingFiles = await readdir(projFolder);
      for (const f of existingFiles) {
        if (f === 'saves' || f.startsWith('.')) continue;
        const fullPath = join(projFolder, f);
        const s = await stat(fullPath);
        if (s.isFile()) await rm(fullPath);
        else if (s.isDirectory()) await rm(fullPath, { recursive: true });
      }

      // Copy files from source
      const sourceFiles = await readdir(sourceDir);
      for (const f of sourceFiles) {
        if (f === '_save-meta.json') continue;
        const srcPath = join(sourceDir, f);
        const s = await stat(srcPath);
        if (s.isFile()) await cp(srcPath, join(projFolder, f));
        else if (s.isDirectory()) {
          await cp(srcPath, join(projFolder, f), { recursive: true });
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

      // Reload from disk into ProjectStateManager
      const reloaded = await ctx.projectState.reload(pipelineId);
      debugLog.info('pipeline-app', `Loaded state from path: ${sourceDir}`);
      sendJson(res, 200, { loaded: true, path: sourceDir, project: reloaded });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to load from path: ${err.message}` });
    }
    return true;
  }

  // ── GET /api/app/:id/node/:nodeId ────────────────────────
  // Load a single node's output data from ProjectStateManager
  const nodeMatch = subPath.match(/^\/node\/([^/]+)$/);
  if (req.method === 'GET' && nodeMatch) {
    const nodeId = decodeURIComponent(nodeMatch[1]);
    const project = ctx.projectState.get(pipelineId);
    if (!project) {
      sendJson(res, 404, { error: 'No data for this node' });
      return true;
    }
    // Map nodeId to project data using pipeline's nodeKeyMap
    const pipeline = await findPipeline(ctx.workDir, pipelineId);
    const nodeKeyMap = getNodeKeyMap(pipeline);
    const keyMapping = nodeKeyMap[nodeId];
    let outputs: Record<string, unknown> = {};
    if (keyMapping === '_assembly' || keyMapping === '_output') {
      outputs = projectToNodeData(project as any, nodeKeyMap)[nodeId]?.outputs || {};
    } else if (keyMapping && typeof keyMapping === 'string') {
      outputs = { [keyMapping]: (project as any)[keyMapping] };
    }
    sendJson(res, 200, {
      nodeId,
      outputs,
      updatedAt: project.updatedAt || null,
      manuallyEdited: false,
      isStale: false,
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

  // ── PUT /api/app/:id/bindings ─────────────────────────────────
  // Save bindings for the pipeline
  if (req.method === 'PUT' && subPath === '/bindings') {
    const body = await readBody(req);
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    if (entry?.isV2Pipeline && entry.pipelineDir) {
      const doc: any = {
        version: '1.0',
        pipelineId,
        bindings: body.bindings || [],
      };
      await saveBindings(entry.pipelineDir, doc);
      sendJson(res, 200, doc);
    } else {
      sendJson(res, 404, { error: 'Pipeline not found or not v2' });
    }
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

    const result = await autoRunRules(pipelineId, entry.pipelineDir, rulesDoc, ctx);

    debugLog.info('rules-run', `Applied ${rulesDoc.rules.length} rules: ${result.added} added, ${result.replaced} replaced`);
    sendJson(res, 200, {
      rulesApplied: rulesDoc.rules.length,
      added: result.added,
      replaced: result.replaced,
      totalBindings: result.totalBindings,
    });
    return true;
  }

  // ── GET /api/app/:id/views — discover pipeline-local custom views ──
  if (req.method === 'GET' && subPath === '/views') {
    const compositions = await discoverCompositions();
    const entry = compositions.find((c: any) => c.composition.id === pipelineId);
    if (!entry) {
      sendJson(res, 200, { views: [] });
      return true;
    }

    // Resolve the directory containing views — v2 pipelines use pipelineDir,
    // v1 compositions use the directory containing the .composition.json file
    const baseDir = entry.pipelineDir || (entry.path ? dirname(entry.path) : null);
    if (!baseDir) {
      sendJson(res, 200, { views: [] });
      return true;
    }

    const viewsDir = join(baseDir, 'views');
    const views: Array<{ name: string; label: string; icon?: string; hasCSS: boolean; description?: string; type: string; bundle: string; order?: number }> = [];

    try {
      const entries = await readdir(viewsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const viewDir = join(viewsDir, ent.name);

        // Must have a view.js or view.bundle.js
        const jsPath = join(viewDir, 'view.js');
        const bundlePath = join(viewDir, 'view.bundle.js');
        let hasJs = false;
        let hasBundle = false;
        try { await access(jsPath); hasJs = true; } catch {}
        try { await access(bundlePath); hasBundle = true; } catch {}
        if (!hasJs && !hasBundle) continue;

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
          type: manifest.type || 'vanilla',
          bundle: manifest.bundle || 'view.js',
          order: manifest.order,
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
    const viewBaseDir = entry?.pipelineDir || (entry?.path ? dirname(entry.path) : null);
    if (!entry || !viewBaseDir) {
      sendJson(res, 404, { error: 'Pipeline not found' });
      return true;
    }

    const filePath = join(viewBaseDir, 'views', viewName, fileName);
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

  // ── LLM Proxy Management ──────────────────────────────────
  if (subPath === '/llm-proxy/status') {
    const proxy = ctx.llmProxy;
    const status: any = {
      running: !!proxy,
      port: proxy?.port || 8642,
      enabled: process.env.LLM_PROXY_ENABLED !== 'false',
      baseURL: process.env.LLM_BASE_URL || null,
    };
    // Try to get stats from running proxy
    if (proxy) {
      try {
        const resp = await fetch(`http://localhost:${proxy.port}/stats`);
        if (resp.ok) status.stats = await resp.json();
      } catch {}
      try {
        const resp = await fetch(`http://localhost:${proxy.port}/health`);
        if (resp.ok) status.health = await resp.json();
      } catch {}
    }
    // Detect available API keys
    status.availableBackends = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
    };
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === 'POST' && subPath === '/llm-proxy/toggle') {
    const body = await readBody(req);
    const enable = body.enabled !== false;
    process.env.LLM_PROXY_ENABLED = enable ? 'true' : 'false';

    if (enable && !ctx.llmProxy) {
      // Import and start proxy
      const { startLlmProxy } = await import('../server.js');
      if (typeof (startLlmProxy as any) === 'function') {
        (startLlmProxy as any)(ctx);
      }
    } else if (!enable && ctx.llmProxy) {
      try {
        ctx.llmProxy.process.kill('SIGTERM');
        ctx.llmProxy = null;
        delete process.env.LLM_BASE_URL;
      } catch {}
    }

    sendJson(res, 200, { success: true, running: !!ctx.llmProxy, enabled: enable });
    return true;
  }

  if (req.method === 'POST' && subPath === '/llm-proxy/model') {
    const body = await readBody(req);
    const model = body.model;
    if (!model || typeof model !== 'string') {
      sendJson(res, 400, { error: 'model required' });
      return true;
    }
    // Persist model selection to chat config (same file as Model menu)
    const configDir = join(homedir(), '.woodbury', 'config');
    try {
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, 'chat-config.json');
      let config: any = {};
      try { config = JSON.parse(await readFile(configPath, 'utf-8')); } catch {}
      // Determine provider from model name
      let provider = 'anthropic';
      if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')) provider = 'openai';
      else if (model.startsWith('llama') || model.startsWith('mixtral')) provider = 'groq';
      config.provider = provider;
      config.model = model;
      config.pipelineModel = model; // extra field for pipeline-specific selection
      await writeFile(configPath, JSON.stringify(config, null, 2));
      sendJson(res, 200, { success: true, model, provider });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // ── Dynamic pipeline routes ──────────────────────────────────
  // If none of the core routes matched, try loading pipeline-specific routes.
  // Pipelines ship a routes/index.js that handles their custom endpoints
  // (e.g., generate-previs, render-dialogue, render-video, etc.)
  try {
    const compositions = await discoverCompositions();
    const entry = compositions.find(c => c.composition.id === pipelineId);
    const baseDir = entry?.pipelineDir || (entry?.path ? dirname(entry.path) : null);
    if (baseDir) {
      const pipelineHandler = await loadPipelineRoutes(pipelineId, baseDir, ctx);
      if (pipelineHandler) {
        const handled = await pipelineHandler(req, res, subPath);
        if (handled) return true;
      }
    }
  } catch (err) {
    debugLog.error('pipeline-app', `Error loading pipeline routes for ${pipelineId}`, { error: String(err) });
  }

  return false;
};

// ────────────────────────────────────────────────────────────────
//  Auto-run rules — shared by /rules/run and pipeline routes
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
  ctx?: DashboardContext,
): Promise<{ added: number; replaced: number; totalBindings: number }> {
  const sourceEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];
  const targetEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];

  const sourceTypes = new Set(rulesDoc.rules.map(r => r.source.entityType));
  const targetTypes = new Set(rulesDoc.rules.map(r => r.target.entityType));

  const seenSourceIds = new Set<string>();
  const seenTargetIds = new Set<string>();

  // Read from ProjectStateManager
  const project = ctx?.projectState?.get(pipelineId);
  if (project) {
    const outputs = { characters: project.characters, locations: project.locations, elements: project.elements, scenes: project.scenes, previsualizations: project.previsualizations, assets: project.assets };
    scanForEntities(outputs, sourceTypes, sourceEntities, seenSourceIds);
    scanForEntities(outputs, targetTypes, targetEntities, seenTargetIds);
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
 * the expected entity types.
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
