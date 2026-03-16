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
  loadPipeline,
  readScriptFileCode,
  writeScriptFileCode,
} from '../../workflow/loader.js';
import { scaffoldPipeline, addScriptFileNode, savePipelineManifest, syncAllFilesToManifest, readPipelineTodo, writePipelineTodo } from '../pipeline-sync.js';
import type { PipelineTodo } from '../pipeline-sync.js';
import { generateNodeTestFile, generateAllNodeTests, runPipelineTests, ensureTestHelpers } from '../pipeline-test-gen.js';
import { debugLog } from '../../debug-log.js';
import { inferCompositionInputs, inferCompositionOutputs, resolveCompositionInterface } from '../composition-interface.js';
import type { CompositionDocument } from '../../workflow/types.js';

// ────────────────────────────────────────────────────────────────
//  Local helpers
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleCompositionsRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { workDir } = ctx;

  // GET /api/compositions — list all compositions
  if (req.method === 'GET' && pathname === '/api/compositions') {
    try {
      // Support ?refresh=1 to invalidate cache and re-scan disk
      if (url.searchParams.get('refresh') === '1') {
        invalidateCompositionCache();
      }
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

      const { inputs, outputs } = await resolveCompositionInterface(workDir, comp);

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

      // Auto-sync v2 pipeline files on load
      if (found.isV2Pipeline && found.pipelineDir) {
        try {
          const pipeline = await loadPipeline(found.pipelineDir);
          const changed = await syncAllFilesToManifest(found.pipelineDir, pipeline);
          if (changed) {
            await savePipelineManifest(found.pipelineDir, pipeline);
            // Update the in-memory registry entry
            found.composition = pipeline as unknown as CompositionDocument;
          }
        } catch {
          // Sync is best-effort
        }
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

  // PUT /api/compositions/:id/notes — set project notes on a composition
  const notesCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/notes$/);
  if (req.method === 'PUT' && notesCompMatch) {
    const id = decodeURIComponent(notesCompMatch[1]);
    try {
      const body = await readBody(req);
      const notes = typeof body?.notes === 'string' ? body.notes : '';

      const discovered = await discoverCompositions(workDir);
      const found = discovered.find(d => d.composition.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }

      const comp = found.composition as any;
      comp.metadata = comp.metadata || {};
      comp.metadata.projectNotes = notes;
      comp.metadata.updatedAt = new Date().toISOString();

      await atomicWriteFile(found.path, JSON.stringify(comp, null, 2));
      debugLog.info('dashboard', `Updated project notes for composition "${id}"`, { path: found.path });
      sendJson(res, 200, { success: true });
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

  // ── v2 Pipeline CRUD ──────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/compositions/v2') {
      const body = await readBody(req);
      const { name, description } = body;
      if (!name) { sendJson(res, 400, { error: 'name is required' }); return true; }
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const parentDir = join(homedir(), '.woodbury', 'workflows');
      try {
        await mkdir(parentDir, { recursive: true });
        const { pipelineDir, manifestPath } = await scaffoldPipeline(parentDir, id, name, description);
        invalidateCompositionCache();
        sendJson(res, 201, { id, pipelineDir, manifestPath });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/script-file$/)) {
      const compId = pathname.split('/')[3];
      const body = await readBody(req);
      const { label, description, inputs, outputs, code } = body;
      if (!label) { sendJson(res, 400, { error: 'label is required' }); return true; }

      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const pipeline = await loadPipeline(pipelineDir);
        const node = await addScriptFileNode(
          pipelineDir, pipeline, label, description || '',
          inputs || [], outputs || [], code,
        );
        await savePipelineManifest(pipelineDir, pipeline);
        invalidateCompositionCache();
        sendJson(res, 201, { node });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/compositions\/[^/]+\/script-file\/[^/]+$/)) {
      const parts = pathname.split('/');
      const compId = parts[3];
      const nodeId = decodeURIComponent(parts[5]);
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const pipeline = await loadPipeline(pipelineDir);
        const node = pipeline.nodes.find((n: any) => n.id === nodeId);
        if (!node || !(node as any).scriptFile) {
          sendJson(res, 404, { error: 'Script file node not found' });
          return true;
        }
        const code = await readScriptFileCode(pipelineDir, (node as any).scriptFile);
        sendJson(res, 200, { nodeId, file: (node as any).scriptFile.file, code });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/compositions\/[^/]+\/script-file\/[^/]+$/)) {
      const parts = pathname.split('/');
      const compId = parts[3];
      const nodeId = decodeURIComponent(parts[5]);
      const body = await readBody(req);
      const { code } = body;
      if (typeof code !== 'string') { sendJson(res, 400, { error: 'code is required' }); return true; }

      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const pipeline = await loadPipeline(pipelineDir);
        const node = pipeline.nodes.find((n: any) => n.id === nodeId);
        if (!node || !(node as any).scriptFile) {
          sendJson(res, 404, { error: 'Script file node not found' });
          return true;
        }
        await writeScriptFileCode(pipelineDir, (node as any).scriptFile.file, code);
        sendJson(res, 200, { updated: true, file: (node as any).scriptFile.file });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/sync$/)) {
      const compId = pathname.split('/')[3];
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const pipeline = await loadPipeline(pipelineDir);
        const changed = await syncAllFilesToManifest(pipelineDir, pipeline);
        if (changed) {
          await savePipelineManifest(pipelineDir, pipeline);
          invalidateCompositionCache();
        }
        sendJson(res, 200, { synced: true, changed });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/migrate-to-v2$/)) {
      const compId = pathname.split('/')[3];
      try {
        // Find the v1 composition
        const compositions = await discoverCompositions(ctx.workDir);
        const found = compositions.find(c => c.composition.id === compId);
        if (!found) { sendJson(res, 404, { error: 'Composition not found' }); return true; }
        if (found.isV2Pipeline) { sendJson(res, 400, { error: 'Already a v2 pipeline' }); return true; }

        const comp = found.composition;
        const parentDir = join(homedir(), '.woodbury', 'workflows');
        const { pipelineDir } = await scaffoldPipeline(parentDir, comp.id + '-v2', comp.name, comp.description);

        // Load the pipeline manifest we just created
        const pipeline = await loadPipeline(pipelineDir);
        pipeline.metadata = comp.metadata;

        // Copy over all nodes, converting __script__ to __script_file__
        for (const node of comp.nodes) {
          if (node.workflowId === '__script__' && node.script?.code) {
            const fileName = (node.label || node.id)
              .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.ts';
            await writeScriptFileCode(pipelineDir, fileName, node.script.code);

            pipeline.nodes.push({
              ...node,
              workflowId: '__script_file__',
              scriptFile: {
                file: fileName,
                description: node.script.description || '',
                inputs: node.script.inputs || [],
                outputs: node.script.outputs || [],
                chatHistory: node.script.chatHistory,
                generationTranscript: node.script.generationTranscript,
                generationMetrics: node.script.generationMetrics,
              },
            } as any);
          } else {
            pipeline.nodes.push(node as any);
          }
        }

        // Copy edges (preserve as-is, they reference same node IDs)
        pipeline.edges = comp.edges.map(e => ({ ...e }));

        await savePipelineManifest(pipelineDir, pipeline);
        invalidateCompositionCache();
        sendJson(res, 201, { id: pipeline.id, pipelineDir, migratedNodes: comp.nodes.filter(n => n.workflowId === '__script__').length });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Initialize git repo ──────────────────────────────
    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/git-init$/)) {
      const compId = pathname.split('/')[3];
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const pipeline = await loadPipeline(pipelineDir);
        const { execSync } = await import('node:child_process');

        // Check if already a git repo
        try {
          execSync('git rev-parse --is-inside-work-tree', { cwd: pipelineDir, stdio: 'pipe' });
          sendJson(res, 200, { initialized: false, message: 'Already a git repository' });
          return true;
        } catch {
          // Not a git repo — proceed
        }

        execSync('git init', { cwd: pipelineDir, stdio: 'pipe' });
        execSync('git add -A', { cwd: pipelineDir, stdio: 'pipe' });
        execSync('git commit -m "Initial pipeline scaffold"', { cwd: pipelineDir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Woodbury', GIT_AUTHOR_EMAIL: 'pipeline@woodbury.dev', GIT_COMMITTER_NAME: 'Woodbury', GIT_COMMITTER_EMAIL: 'pipeline@woodbury.dev' } });

        sendJson(res, 200, { initialized: true, pipelineDir });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Get git status ──────────────────────────────────
    if (req.method === 'GET' && pathname.match(/^\/api\/compositions\/[^/]+\/git-status$/)) {
      const compId = pathname.split('/')[3];
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const { execSync } = await import('node:child_process');
        const isRepo = (() => { try { execSync('git rev-parse --is-inside-work-tree', { cwd: pipelineDir, stdio: 'pipe' }); return true; } catch { return false; } })();
        if (!isRepo) {
          sendJson(res, 200, { isRepo: false });
          return true;
        }
        const status = execSync('git status --porcelain', { cwd: pipelineDir, encoding: 'utf-8' }).trim();
        const log = execSync('git log --oneline -5', { cwd: pipelineDir, encoding: 'utf-8' }).trim();
        const branch = execSync('git branch --show-current', { cwd: pipelineDir, encoding: 'utf-8' }).trim();
        const remotes = execSync('git remote -v', { cwd: pipelineDir, encoding: 'utf-8' }).trim();
        sendJson(res, 200, {
          isRepo: true,
          branch,
          dirty: status.length > 0,
          status: status || '(clean)',
          recentCommits: log.split('\n').filter(Boolean),
          remotes: remotes || '(none)',
        });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Git commit ──────────────────────────────────────
    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/git-commit$/)) {
      const compId = pathname.split('/')[3];
      const body = await readBody(req);
      const message = body.message || 'Update pipeline';
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const { execSync } = await import('node:child_process');
        execSync('git add -A', { cwd: pipelineDir, stdio: 'pipe' });
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd: pipelineDir,
          stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_NAME: 'Woodbury', GIT_AUTHOR_EMAIL: 'pipeline@woodbury.dev', GIT_COMMITTER_NAME: 'Woodbury', GIT_COMMITTER_EMAIL: 'pipeline@woodbury.dev' },
        });
        sendJson(res, 200, { committed: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Add git remote ──────────────────────────────────
    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/git-remote$/)) {
      const compId = pathname.split('/')[3];
      const body = await readBody(req);
      const { url, remoteName } = body;
      if (!url) { sendJson(res, 400, { error: 'url is required' }); return true; }
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const { execSync } = await import('node:child_process');
        const name = remoteName || 'origin';
        try {
          execSync(`git remote remove ${name}`, { cwd: pipelineDir, stdio: 'pipe' });
        } catch { /* remote may not exist */ }
        execSync(`git remote add ${name} ${url}`, { cwd: pipelineDir, stdio: 'pipe' });
        sendJson(res, 200, { added: true, remote: name, url });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Git push ────────────────────────────────────────
    if (req.method === 'POST' && pathname.match(/^\/api\/compositions\/[^/]+\/git-push$/)) {
      const compId = pathname.split('/')[3];
      const body = await readBody(req);
      const remote = body.remote || 'origin';
      const branch = body.branch || 'main';
      const pipelineDir = join(homedir(), '.woodbury', 'workflows', compId);
      try {
        const { execSync } = await import('node:child_process');
        execSync(`git push -u ${remote} ${branch}`, { cwd: pipelineDir, stdio: 'pipe', timeout: 30000 });
        sendJson(res, 200, { pushed: true, remote, branch });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // ── v2: Clone pipeline from git repo ────────────────────
    if (req.method === 'POST' && pathname === '/api/compositions/v2/clone') {
      const body = await readBody(req);
      const { url, name: customName } = body;
      if (!url) { sendJson(res, 400, { error: 'url is required' }); return true; }

      try {
        const { execSync } = await import('node:child_process');
        const parentDir = join(homedir(), '.woodbury', 'workflows');
        await mkdir(parentDir, { recursive: true });

        // Derive directory name from URL
        const repoName = customName || url.replace(/\.git$/, '').split('/').pop() || 'cloned-pipeline';
        const targetDir = join(parentDir, repoName);

        // Check if directory already exists
        const { existsSync } = await import('node:fs');
        if (existsSync(targetDir)) {
          sendJson(res, 409, { error: `Directory already exists: ${repoName}. Choose a different name.` });
          return true;
        }

        // Clone the repo
        execSync(`git clone "${url}" "${targetDir}"`, { stdio: 'pipe', timeout: 60000 });

        // Verify it's a valid v2 pipeline
        const pipelineJsonPath = join(targetDir, 'pipeline.json');
        if (!existsSync(pipelineJsonPath)) {
          // Not a v2 pipeline — clean up
          const { rm } = await import('node:fs/promises');
          await rm(targetDir, { recursive: true, force: true });
          sendJson(res, 400, { error: 'Cloned repository does not contain a pipeline.json — not a valid v2 pipeline' });
          return true;
        }

        // Load and validate
        const pipeline = await loadPipeline(targetDir);

        // Install npm dependencies if package.json exists
        const pkgJsonPath = join(targetDir, 'package.json');
        if (existsSync(pkgJsonPath)) {
          try {
            execSync('npm install --production', { cwd: targetDir, stdio: 'pipe', timeout: 120000 });
          } catch {
            debugLog.warn('compositions', 'npm install failed for cloned pipeline', { dir: targetDir });
          }
        }

        invalidateCompositionCache();
        sendJson(res, 201, {
          id: pipeline.id,
          name: pipeline.name,
          pipelineDir: targetDir,
          nodeCount: pipeline.nodes.length,
          edgeCount: pipeline.edges.length,
        });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

  // ── V2 pipeline test endpoints ──────────────────────────────

  // POST /api/compositions/:id/run-tests — run vitest in the pipeline directory
  const runTestsMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/run-tests$/);
  if (req.method === 'POST' && runTestsMatch) {
    const id = decodeURIComponent(runTestsMatch[1]);
    try {
      const discovered = await discoverCompositions(workDir);
      const found = discovered.find(d => d.composition.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }
      if (!found.isV2Pipeline || !found.pipelineDir) {
        sendJson(res, 400, { error: 'Test execution is only supported for v2 file-backed pipelines' });
        return true;
      }

      const body = await readBody(req);
      const nodeFilter = typeof body?.node === 'string' ? body.node : undefined;

      await ensureTestHelpers(found.pipelineDir);
      const result = await runPipelineTests(found.pipelineDir, {
        nodeFilter,
        timeout: 60000,
      });

      sendJson(res, 200, { ...result, success: result.success });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/compositions/:id/generate-tests — generate .test.ts files for all nodes
  const genTestsMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/generate-tests$/);
  if (req.method === 'POST' && genTestsMatch) {
    const id = decodeURIComponent(genTestsMatch[1]);
    try {
      const discovered = await discoverCompositions(workDir);
      const found = discovered.find(d => d.composition.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }
      if (!found.isV2Pipeline || !found.pipelineDir) {
        sendJson(res, 400, { error: 'Test generation is only supported for v2 file-backed pipelines' });
        return true;
      }

      const pipeline = await loadPipeline(found.pipelineDir);
      const testFiles = await generateAllNodeTests(found.pipelineDir, pipeline.nodes as any[]);
      await ensureTestHelpers(found.pipelineDir);

      const body = await readBody(req);
      const runAfter = body?.run !== false; // default: run tests after generating

      let testResults = null;
      if (runAfter && testFiles.length > 0) {
        testResults = await runPipelineTests(found.pipelineDir, { timeout: 60000 });
      }

      sendJson(res, 200, {
        success: true,
        testFilesCreated: testFiles,
        ...(testResults ? { testResults } : {}),
      });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // ── TODO.json endpoints ──────────────────────────────────────

  // GET /api/compositions/:id/todo — read TODO.json
  if (req.method === 'GET' && pathname.match(/^\/api\/compositions\/[^/]+\/todo$/)) {
    const compId = pathname.split('/')[3];
    try {
      const discovered = await discoverCompositions(ctx.workDir);
      const found = discovered.find(d => d.composition.id === compId && d.isV2Pipeline && d.pipelineDir);
      if (!found?.pipelineDir) { sendJson(res, 404, { error: 'v2 pipeline not found' }); return true; }
      const todo = await readPipelineTodo(found.pipelineDir);
      sendJson(res, 200, { todo: todo || { pipelineName: found.composition.name, items: [] } });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // PUT /api/compositions/:id/todo — update TODO.json
  if (req.method === 'PUT' && pathname.match(/^\/api\/compositions\/[^/]+\/todo$/)) {
    const compId = pathname.split('/')[3];
    try {
      const body = await readBody(req);
      const discovered = await discoverCompositions(ctx.workDir);
      const found = discovered.find(d => d.composition.id === compId && d.isV2Pipeline && d.pipelineDir);
      if (!found?.pipelineDir) { sendJson(res, 404, { error: 'v2 pipeline not found' }); return true; }
      const todo: PipelineTodo = body.todo;
      if (!todo || !Array.isArray(todo.items)) { sendJson(res, 400, { error: 'Invalid todo format' }); return true; }
      await writePipelineTodo(found.pipelineDir, todo);
      sendJson(res, 200, { success: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
};
