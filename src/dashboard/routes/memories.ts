import { exec } from 'node:child_process';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson } from '../utils.js';
import { GENERAL_MEMORY_CATEGORIES, getSQLiteMemoryStore } from '../../sqlite-memory-store.js';

const store = getSQLiteMemoryStore();
const VALID_GENERAL_CATEGORIES = new Set<string>(GENERAL_MEMORY_CATEGORIES);
const VALID_CLOSURE_TYPES = new Set<string>(['episodic', 'semantic', 'procedural', 'failure', 'failure_pattern', 'preference']);

function parseLimit(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 500);
}

function parseOffset(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export const handleMemoryRoutes: RouteHandler = async (req, res, pathname, url, _ctx: DashboardContext) => {
  if (req.method === 'GET' && pathname === '/api/memories/stats') {
    sendJson(res, 200, { stats: store.getMemoryStats() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/memories/reindex') {
    const result = store.reindexAllMemories();
    sendJson(res, 200, { success: true, reindexed: result, stats: store.getMemoryStats() });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/memories') {
    const scope = url.searchParams.get('scope') === 'closure' ? 'closure' : 'general';
    const query = (url.searchParams.get('query') || '').trim();
    const limit = parseLimit(url.searchParams.get('limit'), 50);
    const offset = parseOffset(url.searchParams.get('offset'));

    if (scope === 'general') {
      const category = url.searchParams.get('category');
      if (category && !VALID_GENERAL_CATEGORIES.has(category)) {
        sendJson(res, 400, { error: `Invalid general memory category: ${category}` });
        return true;
      }

      const result = store.browseGeneralMemories({
        query: query || undefined,
        category: (category as any) || undefined,
        site: url.searchParams.get('site') || undefined,
        project: url.searchParams.get('project') || undefined,
        limit,
        offset,
      });
      sendJson(res, 200, {
        scope,
        total: result.total,
        items: result.items,
        stats: store.getMemoryStats(),
      });
      return true;
    }

    const type = url.searchParams.get('type');
    if (type && !VALID_CLOSURE_TYPES.has(type)) {
      sendJson(res, 400, { error: `Invalid closure memory type: ${type}` });
      return true;
    }

    const result = store.browseClosureMemories({
      query: query || undefined,
      type: (type as any) || undefined,
      limit,
      offset,
    });
    sendJson(res, 200, {
      scope,
      total: result.total,
      items: result.items,
      stats: store.getMemoryStats(),
    });
    return true;
  }

  {
    const openMatch = pathname.match(/^\/api\/memories\/([^/]+)\/(open|reveal)$/);
    if (req.method === 'POST' && openMatch) {
      const id = decodeURIComponent(openMatch[1]);
      const action = openMatch[2];
      const scope = url.searchParams.get('scope') === 'closure' ? 'closure' : 'general';
      const paths = store.getMemoryArtifactPaths(scope, id);

      if (!paths?.markdownPath) {
        sendJson(res, 404, { error: 'Memory file not found' });
        return true;
      }

      try {
        if (action === 'reveal') {
          if (process.platform === 'darwin') {
            exec(`open -R "${paths.markdownPath}"`);
          } else if (process.platform === 'win32') {
            exec(`explorer /select,"${paths.markdownPath.replace(/\//g, '\\\\')}"`);
          } else {
            exec(`xdg-open "${paths.directoryPath}"`);
          }
        } else if (process.platform === 'darwin') {
          exec(`open "${paths.markdownPath}"`);
        } else if (process.platform === 'win32') {
          exec(`start "" "${paths.markdownPath.replace(/\//g, '\\\\')}"`);
        } else {
          exec(`xdg-open "${paths.markdownPath}"`);
        }

        sendJson(res, 200, { success: true, scope, id, action, path: paths.markdownPath });
      } catch {
        sendJson(res, 500, { error: `Failed to ${action} memory file` });
      }
      return true;
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/memories/')) {
    const id = decodeURIComponent(pathname.replace('/api/memories/', ''));
    const scope = url.searchParams.get('scope') === 'closure' ? 'closure' : 'general';
    const deleted = scope === 'closure'
      ? store.deleteClosureMemory(id)
      : store.deleteGeneralMemory(id);

    if (!deleted) {
      sendJson(res, 404, { error: 'Memory not found' });
      return true;
    }

    sendJson(res, 200, { success: true, deletedId: id, scope, stats: store.getMemoryStats() });
    return true;
  }

  return false;
};