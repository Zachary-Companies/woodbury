/**
 * Dashboard Route: Project Data
 *
 * Single source of truth for project data. All reads come from memory
 * via ProjectStateManager, all writes go through it and flush to disk.
 *
 * Endpoints:
 *   GET    /api/project/:id           — get full project data
 *   PATCH  /api/project/:id           — partial update to any domain slice(s)
 *   DELETE /api/project/:id           — clear project data
 *   POST   /api/project/:id/reload    — force reload from disk
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Helper: ensure project is loaded
// ────────────────────────────────────────────────────────────────

async function ensureLoaded(pipelineId: string, ctx: DashboardContext): Promise<{ projectFolder: string; pipelineName: string } | null> {
  if (!ctx.projectState) return null;

  if (ctx.projectState.isLoaded(pipelineId)) {
    const info = ctx.projectState.getInfo(pipelineId);
    if (info) return { projectFolder: info.projectFolder, pipelineName: info.pipelineName };
  }

  // Load from disk — resolve project folder from composition metadata
  try {
    const compositions = await discoverCompositions();
    const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
    const projectFolder = entry?.composition?.metadata?.projectFolder;
    const pipelineName = entry?.composition?.name || pipelineId;

    if (!projectFolder) return null;

    await ctx.projectState.load(pipelineId, pipelineName, projectFolder);
    return { projectFolder, pipelineName };
  } catch (err) {
    debugLog.error('project-route', `Failed to load project ${pipelineId}: ${err}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleProjectRoutes: RouteHandler = async (req, res, pathname, _url, ctx) => {
  const match = pathname.match(/^\/api\/project\/([^/]+)(\/.*)?$/);
  if (!match) return false;

  const pipelineId = decodeURIComponent(match[1]);
  const subPath = match[2] || '';

  // ── GET /api/project/:id ──────────────────────────────
  if (req.method === 'GET' && subPath === '') {
    const loaded = await ensureLoaded(pipelineId, ctx);
    if (!loaded) {
      sendJson(res, 404, { error: 'Project not found. Ensure a project folder is set for this pipeline.' });
      return true;
    }

    const info = ctx.projectState!.getInfo(pipelineId)!;
    sendJson(res, 200, {
      project: info.data,
      projectFolder: info.projectFolder,
      pipelineName: info.pipelineName,
      lastRunId: info.lastRunId,
      lastRunAt: info.lastRunAt,
    });
    return true;
  }

  // ── PATCH /api/project/:id ────────────────────────────
  if (req.method === 'PATCH' && subPath === '') {
    const loaded = await ensureLoaded(pipelineId, ctx);
    if (!loaded) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }

    const body = await readBody(req);

    // Body can be { characters: [...], metadata: {...}, ... } or { project: { ... } }
    const partial = body.project || body;

    ctx.projectState!.update(pipelineId, partial);

    sendJson(res, 200, { success: true });
    return true;
  }

  // ── DELETE /api/project/:id ───────────────────────────
  if (req.method === 'DELETE' && subPath === '') {
    if (!ctx.projectState?.isLoaded(pipelineId)) {
      await ensureLoaded(pipelineId, ctx);
    }

    if (ctx.projectState?.isLoaded(pipelineId)) {
      await ctx.projectState.clear(pipelineId);
    }

    sendJson(res, 200, { success: true });
    return true;
  }

  // ── POST /api/project/:id/reload ──────────────────────
  if (req.method === 'POST' && subPath === '/reload') {
    if (!ctx.projectState?.isLoaded(pipelineId)) {
      const loaded = await ensureLoaded(pipelineId, ctx);
      if (!loaded) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
    }

    const data = await ctx.projectState!.reload(pipelineId);
    sendJson(res, 200, { project: data });
    return true;
  }

  // ── POST /api/project/:id/flush ───────────────────────
  if (req.method === 'POST' && subPath === '/flush') {
    if (ctx.projectState?.isLoaded(pipelineId)) {
      await ctx.projectState.flush(pipelineId);
    }
    sendJson(res, 200, { success: true });
    return true;
  }

  return false;
};
