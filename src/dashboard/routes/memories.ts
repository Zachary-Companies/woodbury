import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import {
  listMemories,
  recallMemories,
  deleteMemory,
  getMemoryStats,
  decayMemories,
  consolidateMemories,
  saveMemory,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type Memory,
} from '../../file-memory-store.js';

const VALID_CATEGORIES = new Set<string>(MEMORY_CATEGORIES);

function parseLimit(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function parseOffset(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export const handleMemoryRoutes: RouteHandler = async (req, res, pathname, url, _ctx: DashboardContext) => {
  // ── Stats ────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/memories/stats') {
    const stats = await getMemoryStats();
    sendJson(res, 200, { stats });
    return true;
  }

  // ── Decay + Consolidation (manual trigger) ───────────────
  if (req.method === 'POST' && pathname === '/api/memories/consolidate') {
    const [decayResult, consolidateResult] = await Promise.all([
      decayMemories(),
      consolidateMemories(),
    ]);
    const stats = await getMemoryStats();
    sendJson(res, 200, {
      success: true,
      decayed: decayResult.decayed,
      pruned: decayResult.pruned,
      consolidated: consolidateResult.consolidated,
      stats,
    });
    return true;
  }

  // ── Create memory (manual) ───────────────────────────────
  if (req.method === 'POST' && pathname === '/api/memories') {
    const body = JSON.parse(await readBody(req));
    if (!body.content || !body.category) {
      sendJson(res, 400, { error: 'content and category are required' });
      return true;
    }
    if (!VALID_CATEGORIES.has(body.category)) {
      sendJson(res, 400, { error: `Invalid category: ${body.category}` });
      return true;
    }
    const mem = await saveMemory(body.content, body.category as MemoryCategory, {
      tags: body.tags,
      source: body.source || 'dashboard',
      project: body.project,
      importance: body.importance,
    });
    sendJson(res, 201, { memory: mem });
    return true;
  }

  // ── List / Search ────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/memories') {
    const query = (url.searchParams.get('query') || '').trim();
    const category = url.searchParams.get('category');
    const project = url.searchParams.get('project') || undefined;
    const limit = parseLimit(url.searchParams.get('limit'), 50);
    const offset = parseOffset(url.searchParams.get('offset'));

    if (category && !VALID_CATEGORIES.has(category)) {
      sendJson(res, 400, { error: `Invalid category: ${category}` });
      return true;
    }

    let items: Memory[];
    let total: number;

    if (query) {
      // Semantic-ish search via recallMemories
      items = await recallMemories(query, {
        category: (category as MemoryCategory) || undefined,
        project,
        limit,
      });
      total = items.length;
    } else {
      // Browse mode
      const result = await listMemories({
        category: (category as MemoryCategory) || undefined,
        project,
        limit,
        offset,
      });
      items = result.memories;
      total = result.total;
    }

    const stats = await getMemoryStats();
    sendJson(res, 200, { total, items, stats });
    return true;
  }

  // ── Delete ───────────────────────────────────────────────
  if (req.method === 'DELETE' && pathname.startsWith('/api/memories/')) {
    const id = decodeURIComponent(pathname.replace('/api/memories/', ''));
    const deleted = await deleteMemory(id);
    if (!deleted) {
      sendJson(res, 404, { error: 'Memory not found' });
      return true;
    }
    const stats = await getMemoryStats();
    sendJson(res, 200, { success: true, deletedId: id, stats });
    return true;
  }

  return false;
};
