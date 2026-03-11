/**
 * Dashboard Route: Assets
 *
 * Handles /api/assets/* and /api/browse-files endpoints.
 * Asset management, collections, file browsing, and import.
 */

import { readFile, writeFile, readdir, stat, unlink, mkdir, copyFile } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { exec } from 'node:child_process';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';

// ────────────────────────────────────────────────────────────────
//  Asset helper functions
// ────────────────────────────────────────────────────────────────

const getAssetsDataDir = async (): Promise<string> => {
  const settingsPath = join(homedir(), '.woodbury', 'data', 'assets-settings.json');
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    if (settings.dataDir) return settings.dataDir;
  } catch { /* no settings file */ }
  return process.env.ASSETS_DATA_DIR || join(homedir(), '.woodbury', 'creator-assets');
};

const readAssetsJson = async (dataDir: string): Promise<any[]> => {
  try {
    const raw = await readFile(join(dataDir, 'assets.json'), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
};

const writeAssetsJson = async (dataDir: string, assets: any[]): Promise<void> => {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'assets.json'), JSON.stringify(assets, null, 2));
};

const readCollectionsJson = async (dataDir: string): Promise<any[]> => {
  try {
    const raw = await readFile(join(dataDir, 'collections.json'), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
};

const writeCollectionsJson = async (dataDir: string, collections: any[]): Promise<void> => {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'collections.json'), JSON.stringify(collections, null, 2));
};

const resolveAssetPath = (asset: any, dataDir: string, collections: any[]): string | null => {
  const filePath = asset.file_path;
  if (!filePath) return null;
  const mode = asset.path_mode || 'relative';
  if (mode === 'absolute' || isAbsolute(filePath)) return filePath;
  if (mode === 'collection_root') {
    const colSlug = asset.collections?.[0];
    if (colSlug) {
      const col = collections.find((c: any) => c.slug === colSlug);
      if (col?.rootPath) return join(col.rootPath, filePath);
    }
  }
  return join(dataDir, filePath);
};

const assetSlugify = (str: string): string =>
  str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const generateAssetId = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'ast_';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

const ASSET_MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const detectAssetCategory = (mimeType: string): string => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return 'document';
};

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleAssetRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // Only handle /api/assets/* and /api/browse-files routes
  if (!pathname.startsWith('/api/assets') && pathname !== '/api/browse-files') return false;

  // GET /api/assets — list all assets
  if (req.method === 'GET' && pathname === '/api/assets') {
    try {
      const dataDir = await getAssetsDataDir();
      let assets = await readAssetsJson(dataDir);

      const category = url.searchParams.get('category');
      const collection = url.searchParams.get('collection');
      const search = url.searchParams.get('search');
      const tag = url.searchParams.get('tag');

      if (category) assets = assets.filter((a: any) => a.category === category);
      if (collection && collection !== '__all__') assets = assets.filter((a: any) => a.collections && a.collections.includes(collection));
      if (tag) assets = assets.filter((a: any) => a.tags && a.tags.includes(tag));
      if (search) {
        const s = search.toLowerCase();
        assets = assets.filter((a: any) =>
          (a.name && a.name.toLowerCase().includes(s)) ||
          (a.description && a.description.toLowerCase().includes(s)) ||
          (a.tags && a.tags.some((t: string) => t.toLowerCase().includes(s)))
        );
      }

      const collections = await readCollectionsJson(dataDir);
      assets = assets.map((a: any) => ({
        ...a,
        file_path_absolute: resolveAssetPath(a, dataDir, collections),
      }));

      sendJson(res, 200, { assets, dataDir });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/assets/collections — list collections with counts
  if (req.method === 'GET' && pathname === '/api/assets/collections') {
    try {
      const dataDir = await getAssetsDataDir();
      const collections = await readCollectionsJson(dataDir);
      const assets = await readAssetsJson(dataDir);

      const result = collections.map((c: any) => ({
        ...c,
        asset_count: assets.filter((a: any) => a.collections && a.collections.includes(c.slug)).length,
      }));

      sendJson(res, 200, { collections: result });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/assets/collections — create collection
  if (req.method === 'POST' && pathname === '/api/assets/collections') {
    try {
      const body = await readBody(req);
      if (!body?.name) { sendJson(res, 400, { error: 'Name is required' }); return true; }

      const dataDir = await getAssetsDataDir();
      const collections = await readCollectionsJson(dataDir);
      const slug = assetSlugify(body.name);

      if (collections.find((c: any) => c.slug === slug)) {
        sendJson(res, 409, { error: 'Collection already exists' }); return true;
      }

      const colId = generateAssetId().replace('ast_', 'col_');
      const collection = {
        id: colId,
        name: body.name,
        slug,
        description: body.description || '',
        tags: body.tags || [],
        rootPath: body.rootPath || null,
        created_at: new Date().toISOString(),
      };

      collections.push(collection);
      await writeCollectionsJson(dataDir, collections);
      sendJson(res, 201, { collection });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/assets/collections/:slug
  {
    const colMatch = pathname.match(/^\/api\/assets\/collections\/([^/]+)$/);
    if (req.method === 'DELETE' && colMatch) {
      try {
        const slug = decodeURIComponent(colMatch[1]);
        const dataDir = await getAssetsDataDir();
        let collections = await readCollectionsJson(dataDir);
        collections = collections.filter((c: any) => c.slug !== slug);
        await writeCollectionsJson(dataDir, collections);

        let assets = await readAssetsJson(dataDir);
        assets = assets.map((a: any) => ({
          ...a,
          collections: a.collections ? a.collections.filter((c: string) => c !== slug) : [],
        }));
        await writeAssetsJson(dataDir, assets);

        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // PUT /api/assets/collections/:slug — update collection
  {
    const colPutMatch = pathname.match(/^\/api\/assets\/collections\/([^/]+)$/);
    if (req.method === 'PUT' && colPutMatch) {
      try {
        const slug = decodeURIComponent(colPutMatch[1]);
        const body = await readBody(req);
        const dataDir = await getAssetsDataDir();
        const collections = await readCollectionsJson(dataDir);
        const idx = collections.findIndex((c: any) => c.slug === slug);
        if (idx === -1) { sendJson(res, 404, { error: 'Collection not found' }); return true; }

        const col = collections[idx];
        if (body.name !== undefined) col.name = body.name;
        if (body.description !== undefined) col.description = body.description;
        if (body.rootPath !== undefined) col.rootPath = body.rootPath || null;
        if (body.tags !== undefined) col.tags = body.tags;

        collections[idx] = col;
        await writeCollectionsJson(dataDir, collections);
        sendJson(res, 200, { collection: col });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // GET /api/assets/defaults — get all defaults
  if (req.method === 'GET' && pathname === '/api/assets/defaults') {
    try {
      const dataDir = await getAssetsDataDir();
      const assets = await readAssetsJson(dataDir);
      const collections = await readCollectionsJson(dataDir);

      const defaults: Record<string, any> = {};
      for (const a of assets) {
        if (a.is_default_for) {
          defaults[a.is_default_for] = {
            id: a.id,
            name: a.name,
            category: a.category,
            file_path_absolute: resolveAssetPath(a, dataDir, collections),
            metadata: a.metadata,
          };
        }
      }

      sendJson(res, 200, { defaults });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/assets/settings
  if (req.method === 'GET' && pathname === '/api/assets/settings') {
    try {
      const settingsPath = join(homedir(), '.woodbury', 'data', 'assets-settings.json');
      let settings: any = {};
      try {
        settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      } catch { /* no settings file */ }

      const dataDir = await getAssetsDataDir();
      sendJson(res, 200, { dataDir, settings });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // PUT /api/assets/settings
  if (req.method === 'PUT' && pathname === '/api/assets/settings') {
    try {
      const body = await readBody(req);
      const settingsPath = join(homedir(), '.woodbury', 'data', 'assets-settings.json');
      await mkdir(join(homedir(), '.woodbury', 'data'), { recursive: true });

      const settings: any = {};
      if (body?.dataDir) {
        await mkdir(body.dataDir, { recursive: true });
        await mkdir(join(body.dataDir, 'files'), { recursive: true });
        settings.dataDir = body.dataDir;
      }

      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
      sendJson(res, 200, { success: true, settings });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/assets/import — import file as new asset
  if (req.method === 'POST' && pathname === '/api/assets/import') {
    try {
      const body = await readBody(req);
      if (!body?.file_path) { sendJson(res, 400, { error: 'file_path is required' }); return true; }
      if (!body?.name) { sendJson(res, 400, { error: 'name is required' }); return true; }

      const srcStat = await stat(body.file_path);
      if (!srcStat.isFile()) { sendJson(res, 400, { error: 'Not a file' }); return true; }

      const dataDir = await getAssetsDataDir();
      const filesDir = join(dataDir, 'files');
      await mkdir(filesDir, { recursive: true });

      const id = generateAssetId();
      const ext = extname(body.file_path);
      const slug = assetSlugify(body.name);
      const mimeType = ASSET_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
      const collections = await readCollectionsJson(dataDir);

      let storedFilePath: string;
      let pathMode = 'relative';

      if (body.reference_only) {
        // Reference in place — don't copy
        storedFilePath = body.file_path;
        pathMode = 'absolute';
        // Check if under a collection rootPath
        if (body.collection) {
          const col = collections.find((c: any) => c.slug === body.collection);
          if (col?.rootPath && body.file_path.startsWith(col.rootPath)) {
            storedFilePath = body.file_path.slice(col.rootPath.length);
            if (storedFilePath.startsWith('/')) storedFilePath = storedFilePath.slice(1);
            pathMode = 'collection_root';
          }
        }
      } else {
        // Copy into library (existing behavior)
        const destFilename = `${id}_${slug}${ext}`;
        const destPath = join(filesDir, destFilename);
        await copyFile(body.file_path, destPath);
        storedFilePath = `files/${destFilename}`;
      }

      const asset: any = {
        id,
        name: body.name,
        description: body.description || '',
        file_path: storedFilePath,
        path_mode: pathMode,
        file_type: mimeType,
        file_size: srcStat.size,
        category: detectAssetCategory(mimeType),
        tags: body.tags || [],
        collections: body.collection ? [body.collection] : [],
        version: 1,
        versions: [{
          version: 1,
          file_path: storedFilePath,
          created_at: new Date().toISOString(),
          notes: 'Initial import',
        }],
        metadata: body.metadata || {},
        is_default_for: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const assets = await readAssetsJson(dataDir);
      assets.push(asset);
      await writeAssetsJson(dataDir, assets);

      sendJson(res, 201, { asset: { ...asset, file_path_absolute: resolveAssetPath(asset, dataDir, collections) } });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/browse-files — list files and directories for file picker
  if (req.method === 'POST' && pathname === '/api/browse-files') {
    try {
      const body = await readBody(req);
      const dir = body?.path || homedir();

      const entries = await readdir(dir, { withFileTypes: true });
      const dirs: Array<{ name: string; path: string }> = [];
      const files: Array<{ name: string; path: string; size: number }> = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        try {
          const fullPath = join(dir, entry.name);
          const stats = await stat(fullPath);
          if (stats.isDirectory()) {
            dirs.push({ name: entry.name, path: fullPath });
          } else if (stats.isFile()) {
            files.push({ name: entry.name, path: fullPath, size: stats.size });
          }
        } catch { /* skip unreadable */ }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));

      sendJson(res, 200, { current: dir, parent: join(dir, '..'), dirs, files });
    } catch (err) {
      sendJson(res, 400, { error: `Cannot read directory: ${err}` });
    }
    return true;
  }

  // GET /api/assets/file/:id — serve asset file
  {
    const fileMatch = pathname.match(/^\/api\/assets\/file\/([^/]+)$/);
    if (req.method === 'GET' && fileMatch) {
      try {
        const assetId = decodeURIComponent(fileMatch[1]);
        const dataDir = await getAssetsDataDir();
        const assets = await readAssetsJson(dataDir);
        const asset = assets.find((a: any) => a.id === assetId);

        if (!asset || !asset.file_path) {
          sendJson(res, 404, { error: 'Asset not found' }); return true;
        }

        const collections = await readCollectionsJson(dataDir);
        const absPath = resolveAssetPath(asset, dataDir, collections);
        if (!absPath) { sendJson(res, 404, { error: 'File path not resolved' }); return true; }
        const fileStat = await stat(absPath);

        if (!fileStat.isFile()) {
          sendJson(res, 404, { error: 'File not found' }); return true;
        }

        const ext = extname(absPath).toLowerCase();
        const mimeType = ASSET_MIME_MAP[ext] || 'application/octet-stream';

        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': fileStat.size,
          'Cache-Control': 'no-cache',
        });
        const stream = createReadStream(absPath);
        stream.pipe(res);
        stream.on('error', () => {
          if (!res.headersSent) sendJson(res, 500, { error: 'Failed to read file' });
        });
      } catch {
        sendJson(res, 404, { error: 'Asset file not found' });
      }
      return true;
    }
  }

  // POST /api/assets/:id/reveal — show asset file in system file manager
  {
    const revealMatch = pathname.match(/^\/api\/assets\/([^/]+)\/reveal$/);
    if (req.method === 'POST' && revealMatch) {
      try {
        const assetId = decodeURIComponent(revealMatch[1]);
        const dataDir = await getAssetsDataDir();
        const assets = await readAssetsJson(dataDir);
        const asset = assets.find((a: any) => a.id === assetId);
        if (!asset || !asset.file_path) {
          sendJson(res, 404, { error: 'Asset not found' }); return true;
        }
        const collections = await readCollectionsJson(dataDir);
        const absPath = resolveAssetPath(asset, dataDir, collections);
        if (!absPath) { sendJson(res, 404, { error: 'File path not resolved' }); return true; }

        const platform = process.platform;
        if (platform === 'darwin') {
          exec(`open -R "${absPath}"`);
        } else if (platform === 'win32') {
          exec(`explorer /select,"${absPath.replace(/\//g, '\\\\')}"`);
        } else {
          // Linux: open the containing directory
          const { dirname } = await import('path');
          exec(`xdg-open "${dirname(absPath)}"`);
        }
        sendJson(res, 200, { success: true });
      } catch {
        sendJson(res, 500, { error: 'Failed to reveal file' });
      }
      return true;
    }
  }

  // GET /api/assets/:id — get single asset
  {
    const assetGetMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === 'GET' && assetGetMatch) {
      try {
        const assetId = decodeURIComponent(assetGetMatch[1]);
        const dataDir = await getAssetsDataDir();
        const assets = await readAssetsJson(dataDir);
        const asset = assets.find((a: any) => a.id === assetId);

        if (!asset) { sendJson(res, 404, { error: 'Asset not found' }); return true; }

        const collections = await readCollectionsJson(dataDir);
        sendJson(res, 200, {
          asset: {
            ...asset,
            file_path_absolute: resolveAssetPath(asset, dataDir, collections),
            versions: (asset.versions || []).map((v: any) => ({
              ...v,
              file_path_absolute: resolveAssetPath({ ...asset, file_path: v.file_path }, dataDir, collections),
            })),
          },
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // PUT /api/assets/:id — update asset metadata
  {
    const assetPutMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === 'PUT' && assetPutMatch) {
      try {
        const assetId = decodeURIComponent(assetPutMatch[1]);
        const body = await readBody(req);
        const dataDir = await getAssetsDataDir();
        const assets = await readAssetsJson(dataDir);
        const idx = assets.findIndex((a: any) => a.id === assetId);

        if (idx === -1) { sendJson(res, 404, { error: 'Asset not found' }); return true; }

        const asset = assets[idx];

        if (body.name !== undefined) asset.name = body.name;
        if (body.description !== undefined) asset.description = body.description;
        if (body.tags !== undefined) asset.tags = body.tags;
        if (body.collections !== undefined) asset.collections = body.collections;
        if (body.is_default_for !== undefined) {
          if (body.is_default_for) {
            for (const a of assets) {
              if (a.is_default_for === body.is_default_for && a.id !== assetId) {
                a.is_default_for = null;
              }
            }
          }
          asset.is_default_for = body.is_default_for || null;
        }
        if (body.metadata !== undefined) {
          asset.metadata = { ...(asset.metadata || {}), ...body.metadata };
        }

        asset.updated_at = new Date().toISOString();
        assets[idx] = asset;
        await writeAssetsJson(dataDir, assets);

        const collections = await readCollectionsJson(dataDir);
        sendJson(res, 200, {
          asset: { ...asset, file_path_absolute: resolveAssetPath(asset, dataDir, collections) },
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // DELETE /api/assets/:id — delete asset
  {
    const assetDelMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === 'DELETE' && assetDelMatch) {
      try {
        const assetId = decodeURIComponent(assetDelMatch[1]);
        const dataDir = await getAssetsDataDir();
        const assets = await readAssetsJson(dataDir);
        const asset = assets.find((a: any) => a.id === assetId);

        if (!asset) { sendJson(res, 404, { error: 'Asset not found' }); return true; }

        // Only delete files for library-owned assets (not external references)
        const isOwned = !asset.path_mode || asset.path_mode === 'relative';
        if (isOwned) {
          if (asset.file_path) {
            try { await unlink(join(dataDir, asset.file_path)); } catch { /* ok */ }
          }
          if (asset.versions) {
            for (const v of asset.versions) {
              if (v.file_path && !v.deleted) {
                try { await unlink(join(dataDir, v.file_path)); } catch { /* ok */ }
              }
            }
          }
        }

        const remaining = assets.filter((a: any) => a.id !== assetId);
        await writeAssetsJson(dataDir, remaining);

        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  return false;
};
