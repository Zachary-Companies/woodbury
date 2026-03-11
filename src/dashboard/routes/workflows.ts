/**
 * Dashboard Route: Workflows
 * Handles /api/workflows CRUD endpoints (list, create, get, update, delete).
 *
 * Does NOT include:
 * - /api/workflows/run/* (see workflow-run.ts)
 * - /api/recording/* (see recording.ts)
 * - /api/workflows/:id/run (see workflow-run.ts)
 */
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  discoverWorkflows,
  invalidateWorkflowCache,
  type DiscoveredWorkflow,
} from '../../workflow/loader.js';
import type { WorkflowDocument } from '../../workflow/types.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Local helpers
// ────────────────────────────────────────────────────────────────

/**
 * Before overwriting a workflow file, copy the existing version to a .backups/ sibling directory.
 * Keeps the last 10 backups per workflow, timestamped.
 */
async function backupWorkflowFile(filePath: string): Promise<void> {
  try {
    // Only back up if the file currently exists
    await stat(filePath);
  } catch {
    return; // nothing to back up
  }
  try {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const backupDir = join(dir, '.backups');
    await mkdir(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `${name}.${ts}`);
    const content = await readFile(filePath, 'utf-8');
    await writeFile(backupPath, content, 'utf-8');

    // Prune old backups — keep only the last 10
    const prefix = name + '.';
    const entries = (await readdir(backupDir)).filter(f => f.startsWith(prefix)).sort();
    if (entries.length > 10) {
      const toDelete = entries.slice(0, entries.length - 10);
      for (const old of toDelete) {
        try { await unlink(join(backupDir, old)); } catch { /* best-effort */ }
      }
    }
    debugLog.info('dashboard', `Backed up workflow: ${backupPath}`);
  } catch (err) {
    debugLog.info('dashboard', `Workflow backup failed (non-fatal): ${String(err)}`);
  }
}

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
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleWorkflowRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { workDir } = ctx;

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
        format: d.format || 'json',
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
    return true;
  }

  // POST /api/workflows — create a new workflow from scratch
  if (req.method === 'POST' && pathname === '/api/workflows') {
    try {
      const body = await readBody(req);
      if (!body) {
        sendJson(res, 400, { error: 'Request body is required' });
        return true;
      }

      const { name, description, site, variables, steps } = body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'Workflow name is required' });
        return true;
      }

      // Generate ID from name: "My Workflow" → "my-workflow"
      const id = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      if (!id) {
        sendJson(res, 400, { error: 'Could not generate a valid ID from the workflow name' });
        return true;
      }

      // Check for ID collision
      const discovered = await discoverWorkflows(workDir);
      if (discovered.some(d => d.workflow.id === id)) {
        sendJson(res, 409, { error: `A workflow with ID "${id}" already exists` });
        return true;
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
      invalidateWorkflowCache();
      debugLog.info('dashboard', `Created workflow "${id}"`, { path: filePath });
      sendJson(res, 201, { success: true, workflow, path: filePath });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }

      const body = await readBody(req);
      if (!body || !body.workflow) {
        sendJson(res, 400, { error: 'Request body must have a "workflow" object' });
        return true;
      }

      // Validate required fields
      const wf = body.workflow;
      if (!wf.version || !wf.id || !wf.name || !Array.isArray(wf.steps)) {
        sendJson(res, 400, { error: 'Workflow missing required fields (version, id, name, steps)' });
        return true;
      }

      // Update metadata
      wf.metadata = wf.metadata || {};
      wf.metadata.updatedAt = new Date().toISOString();

      await backupWorkflowFile(found.path);
      await atomicWriteFile(found.path, JSON.stringify(wf, null, 2));
      // Update registry in-place (no re-scan needed)
      found.workflow = wf;
      debugLog.info('dashboard', `Updated workflow "${id}"`, { path: found.path });
      sendJson(res, 200, { success: true, workflow: wf, path: found.path });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
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
        return true;
      }

      await unlink(found.path);
      invalidateWorkflowCache();
      debugLog.info('dashboard', `Deleted workflow "${id}"`, { path: found.path });
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/workflows/:id — get a single workflow document
  // NOTE: This must come AFTER more specific /api/workflows/:id/* routes in the calling chain
  const getWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (req.method === 'GET' && getWfMatch) {
    const id = decodeURIComponent(getWfMatch[1]);
    try {
      const discovered = await discoverWorkflows(workDir);
      const found = discovered.find(d => d.workflow.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Workflow "${id}" not found` });
        return true;
      }
      sendJson(res, 200, { workflow: found.workflow, path: found.path, source: found.source, format: found.format || 'json' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
