/**
 * Dashboard Route: Compositions
 * Handles /api/compositions CRUD endpoints (list, create, get, update, delete, duplicate).
 * Does NOT include execution endpoints (/run, /run/status, /run/cancel).
 */
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { readFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  discoverCompositions,
  discoverWorkflows,
  invalidateCompositionCache,
} from '../../workflow/loader.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Local helpers
// ────────────────────────────────────────────────────────────────

/**
 * Infer the external inputs for a composition.
 * An input is any node input port that is NOT connected via an incoming edge,
 * excluding output node ports (those are internal collectors).
 */
export function inferCompositionInputs(
  comp: any,
  wfMap: Record<string, any>,
  compMap: Record<string, any> = {},
  visited: Set<string> = new Set()
): Array<{
  name: string;
  label: string;
  type: string;
  description: string;
  nodeId: string;
  nodeLabel: string;
  workflowId: string;
  workflowName: string;
  portName: string;
  required: boolean;
  default?: unknown;
  generationPrompt?: string;
}> {
  const connectedInputs = new Set<string>();
  for (const edge of comp.edges) {
    connectedInputs.add(`${edge.targetNodeId}:${edge.targetPort}`);
  }

  const result: Array<{
    name: string;
    label: string;
    type: string;
    description: string;
    nodeId: string;
    nodeLabel: string;
    workflowId: string;
    workflowName: string;
    portName: string;
    required: boolean;
    default?: unknown;
    generationPrompt?: string;
  }> = [];

  const parseVariableDefault = (node: any): unknown => {
    const cfg = node?.variableNode;
    if (!cfg) return undefined;
    if (cfg.type === 'boolean') return cfg.initialValue === 'true';
    if (cfg.type === 'number') {
      const parsedNum = Number(cfg.initialValue);
      return Number.isFinite(parsedNum) ? parsedNum : undefined;
    }
    if (cfg.type === 'array') {
      try {
        const parsed = JSON.parse(cfg.initialValue || '[]');
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return cfg.initialValue ?? '';
  };

  for (const node of comp.nodes) {
    // Skip output node — its ports are internal collectors
    if (node.workflowId === '__output__') continue;

    let ports: Array<{
      name: string;
      label?: string;
      type?: string;
      description?: string;
      required?: boolean;
      default?: unknown;
      generationPrompt?: string;
    }> = [];
    const nodeLabel = String(node.label || '').trim();
    const workflowName = node.workflowId === '__script__'
      ? (nodeLabel || 'Script')
      : (wfMap[node.id]?.name || nodeLabel || node.workflowId);

    if (node.workflowId === '__approval_gate__') {
      // Gates have no external inputs
      continue;
    } else if (node.workflowId === '__variable__' && node.variableNode?.exposeAsInput) {
      const inputName = String(node.variableNode.inputName || '').trim();
      if (!inputName) continue;
      result.push({
        name: inputName,
        label: String(node.label || inputName).trim() || inputName,
        type: node.variableNode.type === 'array' ? 'string[]' : node.variableNode.type || 'string',
        description: String(node.variableNode.description || '').trim(),
        nodeId: node.id,
        nodeLabel,
        workflowId: node.workflowId,
        workflowName: workflowName || 'Variable',
        portName: inputName,
        required: node.variableNode.required === true,
        default: parseVariableDefault(node),
        generationPrompt: node.variableNode.generationPrompt,
      });
      continue;
    } else if (node.workflowId === '__junction__' && node.junctionNode) {
      ports = Array.isArray(node.junctionNode.ports) ? node.junctionNode.ports : [];
    } else if (node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__') {
      // Flow control nodes have fixed ports — not external composition inputs
      continue;
    } else if (node.workflowId === '__script__' && node.script) {
      ports = node.script.inputs || [];
    } else if (node.workflowId.startsWith('comp:') && node.compositionRef) {
      const childId = String(node.compositionRef.compositionId || '').trim();
      const childComp = childId ? compMap[childId] : undefined;
      if (!childComp) continue;
      const childVisited = new Set(visited);
      const cycleKey = String(childComp.id || childId || node.id || '').trim();
      if (cycleKey) {
        if (childVisited.has(cycleKey)) continue;
        childVisited.add(cycleKey);
      }
      ports = inferCompositionInputs(childComp, wfMap, compMap, childVisited).map((input) => ({
        name: input.name,
        label: input.label,
        type: input.type,
        description: input.description,
        required: input.required,
        default: input.default,
        generationPrompt: input.generationPrompt,
      }));
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
        const portLabel = String(port.label || port.name || '').trim();
        result.push({
          name: alias || port.name,
          label: alias || portLabel || port.name,
          type: port.type || 'string',
          description: port.description || '',
          nodeId: node.id,
          nodeLabel,
          workflowId: node.workflowId,
          workflowName,
          portName: port.name,
          required: port.required === true,
          default: port.default,
          generationPrompt: port.generationPrompt,
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

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleCompositionsRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { workDir } = ctx;

  // GET /api/compositions — list all compositions
  if (req.method === 'GET' && pathname === '/api/compositions') {
    try {
      const discovered = await discoverCompositions(workDir);
      const compositions = discovered.map(d => ({
        id: d.composition.id,
        name: d.composition.name,
        description: d.composition.description,
        folder: d.composition.folder || '',
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
    return true;
  }

  // POST /api/compositions — create a new composition
  if (req.method === 'POST' && pathname === '/api/compositions') {
    try {
      const body = await readBody(req);
      if (!body) {
        sendJson(res, 400, { error: 'Request body is required' });
        return true;
      }

      const { name, description, folder } = body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'Please give your pipeline a name' });
        return true;
      }

      // Generate ID from name
      const id = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      if (!id) {
        sendJson(res, 400, { error: 'That name can\'t be used — try using letters and numbers' });
        return true;
      }

      // Check for ID collision
      const discovered = await discoverCompositions(workDir);
      if (discovered.some(d => d.composition.id === id)) {
        sendJson(res, 409, { error: 'A pipeline with that name already exists — try a different name' });
        return true;
      }

      const composition = {
        version: '1.0' as const,
        id,
        name: name.trim(),
        description: (description || '').trim() || undefined,
        folder: (folder && typeof folder === 'string') ? folder.trim() : undefined,
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
      await atomicWriteFile(compPath, JSON.stringify(composition, null, 2));
      invalidateCompositionCache();
      debugLog.info('dashboard', `Created composition "${id}"`, { path: compPath });
      sendJson(res, 201, { success: true, composition, path: compPath });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }

      const comp = found.composition;

      // Build wfMap for input inference
      const wfDiscovered = await discoverWorkflows(workDir);
      const wfMap: Record<string, any> = {};
      const compMap: Record<string, any> = {};
      for (const discoveredComp of discovered) {
        if (discoveredComp?.composition?.id) {
          compMap[discoveredComp.composition.id] = discoveredComp.composition;
        }
      }
      for (const node of comp.nodes) {
        if (node.workflowId === '__approval_gate__' || node.workflowId === '__script__' || node.workflowId === '__output__' || node.workflowId === '__image_viewer__' || node.workflowId === '__media__' || node.workflowId === '__branch__' || node.workflowId === '__delay__' || node.workflowId === '__gate__' || node.workflowId === '__for_each__' || node.workflowId === '__switch__' || node.workflowId === '__asset__' || node.workflowId === '__text__' || node.workflowId === '__file_op__' || node.workflowId === '__json_keys__' || node.workflowId === '__junction__' || node.workflowId === '__variable__' || node.workflowId === '__get_variable__') continue;
        if (node.workflowId.startsWith('comp:')) continue;
        const wfFound = wfDiscovered.find((d: any) => d.workflow.id === node.workflowId);
        if (wfFound) {
          wfMap[node.id] = wfFound.workflow;
        }
      }

      const inputs = inferCompositionInputs(comp, wfMap, compMap, new Set([String(comp.id || id)]));
      const outputs = inferCompositionOutputs(comp);

      sendJson(res, 200, { inputs, outputs, compositionId: id, compositionName: comp.name });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }
      sendJson(res, 200, { composition: found.composition, path: found.path, source: found.source });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }

      const body = await readBody(req);
      if (!body || !body.composition) {
        sendJson(res, 400, { error: 'Request body must have a "composition" object' });
        return true;
      }

      const comp = body.composition;
      if (!comp.version || !comp.id || !comp.name || !Array.isArray(comp.nodes) || !Array.isArray(comp.edges)) {
        sendJson(res, 400, { error: 'Composition missing required fields (version, id, name, nodes, edges)' });
        return true;
      }

      // Update metadata
      comp.metadata = comp.metadata || {};
      comp.metadata.updatedAt = new Date().toISOString();

      // Atomic write to prevent torn writes from concurrent saves
      await atomicWriteFile(found.path, JSON.stringify(comp, null, 2));
      // Update registry in-place (no re-scan needed)
      found.composition = comp;
      debugLog.info('dashboard', `Updated composition "${id}"`, { path: found.path });
      sendJson(res, 200, { success: true, composition: comp, path: found.path });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/compositions/:id/rename — rename a composition (display name only)
  const renameCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/rename$/);
  if (req.method === 'POST' && renameCompMatch) {
    const id = decodeURIComponent(renameCompMatch[1]);
    try {
      const body = await readBody(req);
      const newName = body?.name?.trim();
      if (!newName) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }

      const discovered = await discoverCompositions(workDir);
      const found = discovered.find(d => d.composition.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }

      const comp = found.composition as any;
      comp.name = newName;
      comp.metadata = comp.metadata || {};
      comp.metadata.updatedAt = new Date().toISOString();

      await atomicWriteFile(found.path, JSON.stringify(comp, null, 2));
      // Registry already updated (comp is found.composition reference)
      debugLog.info('dashboard', `Renamed composition "${id}" to "${newName}"`, { path: found.path });
      sendJson(res, 200, { success: true, composition: comp });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/compositions/:id/move — move composition to a folder
  const moveCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/move$/);
  if (req.method === 'POST' && moveCompMatch) {
    const id = decodeURIComponent(moveCompMatch[1]);
    try {
      const body = await readBody(req);
      const folder = (body?.folder != null && typeof body.folder === 'string') ? body.folder.trim() : '';

      const discovered = await discoverCompositions(workDir);
      const found = discovered.find(d => d.composition.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }

      const comp = found.composition as any;
      comp.folder = folder || undefined;
      comp.metadata = comp.metadata || {};
      comp.metadata.updatedAt = new Date().toISOString();

      await atomicWriteFile(found.path, JSON.stringify(comp, null, 2));
      // Registry already updated (comp is found.composition reference)
      debugLog.info('dashboard', `Moved composition "${id}" to folder "${folder || '(root)'}"`, { path: found.path });
      sendJson(res, 200, { success: true, composition: comp });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }

      await unlink(found.path);
      invalidateCompositionCache();
      debugLog.info('dashboard', `Deleted composition "${id}"`, { path: found.path });
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
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
      await atomicWriteFile(compPath, JSON.stringify(clone, null, 2));
      invalidateCompositionCache();
      debugLog.info('dashboard', `Duplicated composition "${id}" → "${newId}"`);
      sendJson(res, 201, { success: true, composition: clone, path: compPath });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/compositions/:id/cache/:nodeId — clear idempotency cache for a node
  const clearCacheMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/cache\/([^/]+)$/);
  if (req.method === 'DELETE' && clearCacheMatch) {
    const compId = decodeURIComponent(clearCacheMatch[1]);
    const nodeId = decodeURIComponent(clearCacheMatch[2]);
    try {
      const cacheDir = join(homedir(), '.woodbury', 'cache', 'idempotency', compId);
      const files = await readdir(cacheDir).catch(() => [] as string[]);
      let deleted = 0;
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            const raw = await readFile(join(cacheDir, f), 'utf-8');
            // Remove all cache entries (we can't filter by nodeId from hash alone)
            await unlink(join(cacheDir, f));
            deleted++;
          } catch { /* skip */ }
        }
      }
      debugLog.info('dashboard', `Cleared ${deleted} idempotency cache entries for node "${nodeId}" in comp "${compId}"`);
      sendJson(res, 200, { success: true, deleted });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/compositions/:id/cache — clear all idempotency cache for a composition
  const clearAllCacheMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/cache$/);
  if (req.method === 'DELETE' && clearAllCacheMatch) {
    const compId = decodeURIComponent(clearAllCacheMatch[1]);
    try {
      const cacheDir = join(homedir(), '.woodbury', 'cache', 'idempotency', compId);
      const files = await readdir(cacheDir).catch(() => [] as string[]);
      let deleted = 0;
      for (const f of files) {
        if (f.endsWith('.json')) {
          await unlink(join(cacheDir, f)).catch(() => {});
          deleted++;
        }
      }
      debugLog.info('dashboard', `Cleared all ${deleted} idempotency cache entries for comp "${compId}"`);
      sendJson(res, 200, { success: true, deleted });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
