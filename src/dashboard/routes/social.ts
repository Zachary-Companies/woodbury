/**
 * Dashboard Route: Social
 *
 * Handles /api/social/* endpoints.
 * Social media post scheduling, platform connectors, and content generation.
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import * as socialStorage from '../../social/storage.js';
import { getScriptMeta, getScript } from '../../social/scripts/index.js';

export const handleSocialRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // Only handle /api/social/* routes
  if (!pathname.startsWith('/api/social')) return false;

  // GET /api/social/posts — list posts with optional filters
  if (req.method === 'GET' && pathname === '/api/social/posts') {
    try {
      const filters: Record<string, string> = {};
      if (url.searchParams.get('status')) filters.status = url.searchParams.get('status')!;
      if (url.searchParams.get('platform')) filters.platform = url.searchParams.get('platform')!;
      if (url.searchParams.get('from')) filters.from = url.searchParams.get('from')!;
      if (url.searchParams.get('to')) filters.to = url.searchParams.get('to')!;
      if (url.searchParams.get('tag')) filters.tag = url.searchParams.get('tag')!;
      const posts = await socialStorage.listPosts(filters);
      sendJson(res, 200, posts);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to list posts: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/social/posts — create a new post
  if (req.method === 'POST' && pathname === '/api/social/posts') {
    try {
      const body = await readBody(req);
      const post = await socialStorage.createPost(body || {});
      sendJson(res, 201, post);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to create post: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/posts/:id — get single post
  const socialPostMatch = pathname.match(/^\/api\/social\/posts\/([^/]+)$/);
  if (req.method === 'GET' && socialPostMatch) {
    try {
      const post = await socialStorage.getPost(socialPostMatch[1]);
      if (!post) {
        sendJson(res, 404, { error: 'Post not found' });
      } else {
        sendJson(res, 200, post);
      }
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get post: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // PUT /api/social/posts/:id — update post
  if (req.method === 'PUT' && socialPostMatch) {
    try {
      const body = await readBody(req);
      const updated = await socialStorage.updatePost(socialPostMatch[1], body || {});
      sendJson(res, 200, updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg.includes('not found') ? 404 : 500, { error: msg });
    }
    return true;
  }

  // DELETE /api/social/posts/:id — delete post + media
  if (req.method === 'DELETE' && socialPostMatch) {
    try {
      await socialStorage.deletePost(socialPostMatch[1]);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to delete post: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/stats — status counts
  if (req.method === 'GET' && pathname === '/api/social/stats') {
    try {
      const counts = await socialStorage.getStatusCounts();
      sendJson(res, 200, counts);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get stats: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/today — posts scheduled for today
  if (req.method === 'GET' && pathname === '/api/social/today') {
    try {
      const posts = await socialStorage.getTodayPosts();
      sendJson(res, 200, posts);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get today's posts: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/due — posts due for posting now
  if (req.method === 'GET' && pathname === '/api/social/due') {
    try {
      const posts = await socialStorage.getDuePosts();
      sendJson(res, 200, posts);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get due posts: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/config — get scheduler config
  if (req.method === 'GET' && pathname === '/api/social/config') {
    try {
      const config = await socialStorage.getConfig();
      sendJson(res, 200, config);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get config: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // PUT /api/social/config — update scheduler config
  if (req.method === 'PUT' && pathname === '/api/social/config') {
    try {
      const body = await readBody(req);
      const config = await socialStorage.updateConfig(body || {});
      sendJson(res, 200, config);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to update config: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/social/platforms — list platform connectors
  if (req.method === 'GET' && pathname === '/api/social/platforms') {
    try {
      const connectors = await socialStorage.listConnectors();
      sendJson(res, 200, connectors);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to list platforms: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/social/platforms — create a new platform connector
  if (req.method === 'POST' && pathname === '/api/social/platforms') {
    try {
      const connector = await readBody(req);
      if (!connector.platform) {
        sendJson(res, 400, { error: 'Platform slug is required' });
        return true;
      }
      // Sanitize slug
      connector.platform = connector.platform.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (connector.enabled === undefined) connector.enabled = true;
      await socialStorage.saveConnector(connector);
      sendJson(res, 201, connector);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to create platform: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // PUT/DELETE /api/social/platforms/:platform — update or delete a connector
  const platformSlugMatch = pathname.match(/^\/api\/social\/platforms\/([^/]+)$/);
  if (platformSlugMatch && !pathname.includes('/script')) {
    const platform = decodeURIComponent(platformSlugMatch[1]);

    if (req.method === 'PUT') {
      try {
        const updates = await readBody(req);
        // Load existing or create new
        const existing = await socialStorage.getConnector(platform);
        const merged = { ...existing, ...updates, platform };
        if (merged.enabled === undefined) merged.enabled = true;
        await socialStorage.saveConnector(merged);
        sendJson(res, 200, merged);
      } catch (err) {
        sendJson(res, 500, { error: `Failed to update platform: ${err instanceof Error ? err.message : err}` });
      }
      return true;
    }

    if (req.method === 'DELETE') {
      try {
        await socialStorage.deleteConnector(platform);
        sendJson(res, 200, { deleted: platform });
      } catch (err) {
        sendJson(res, 500, { error: `Failed to delete platform: ${err instanceof Error ? err.message : err}` });
      }
      return true;
    }
  }

  // GET/PUT /api/social/platforms/:platform/script — get or save platform posting script
  const platformScriptMatch = pathname.match(/^\/api\/social\/platforms\/([^/]+)\/script$/);
  if (platformScriptMatch) {
    const platform = decodeURIComponent(platformScriptMatch[1]);

    if (req.method === 'GET') {
      try {
        const script = await getScript(platform);
        if (!script) {
          sendJson(res, 404, { error: `No script found for platform: ${platform}` });
          return true;
        }
        sendJson(res, 200, script);
      } catch (err) {
        sendJson(res, 500, { error: `Failed to get script: ${err instanceof Error ? err.message : err}` });
      }
      return true;
    }

    if (req.method === 'PUT') {
      try {
        const script = await readBody(req);
        script.platform = platform;
        await socialStorage.savePlatformScript(platform, script);
        sendJson(res, 200, script);
      } catch (err) {
        sendJson(res, 500, { error: `Failed to save script: ${err instanceof Error ? err.message : err}` });
      }
      return true;
    }
  }

  // GET /api/social/scripts — list platform scripts + metadata
  if (req.method === 'GET' && pathname === '/api/social/scripts') {
    try {
      const meta = await getScriptMeta();
      sendJson(res, 200, meta);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to get scripts: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/social/generate — AI text generation (stub)
  if (req.method === 'POST' && pathname === '/api/social/generate') {
    try {
      const body = await readBody(req);
      const prompt = body?.prompt || '';
      const tone = body?.tone || 'professional';
      const platforms = body?.platforms || [];
      // For now, return a stub response — actual LLM integration is via the agent
      sendJson(res, 200, {
        text: `[Generated text for: "${prompt}" — tone: ${tone}, platforms: ${platforms.join(', ')}]`,
        note: 'AI text generation is handled by the agent. Use the /social-generate slash command.',
      });
    } catch (err) {
      sendJson(res, 500, { error: `Generation failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  return false;
};
