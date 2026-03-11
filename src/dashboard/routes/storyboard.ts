/**
 * Dashboard Route: Storyboard
 *
 * Handles /api/storyboards endpoints.
 *
 * Endpoints:
 *   GET    /api/storyboards                    — list all storyboards
 *   GET    /api/storyboards/scan-packages      — find production package JSONs in a collection
 *   POST   /api/storyboards                    — create storyboard from production package
 *   GET    /api/storyboards/:id                — get storyboard data
 *   PUT    /api/storyboards/:id                — save selections
 *   DELETE /api/storyboards/:id                — delete storyboard + generated images
 *   GET    /api/storyboards/:id/image/*        — serve generated or existing images
 *   GET    /api/storyboards/:id/audio/*        — serve audio files
 *   POST   /api/storyboards/:id/headshot       — upload a character headshot image
 *   POST   /api/storyboards/:id/generate       — generate image(s) for a scene
 *   POST   /api/storyboards/:id/frame-to-video — convert scene images to video
 *   POST   /api/storyboards/:id/save-to-collection — import storyboard media as assets
 *   POST   /api/storyboards/:id/export         — export curated asset_map for video assembly
 *   POST   /api/storyboards/:id/assemble       — run ffmpeg to create video
 *   GET    /api/storyboards/:id/video          — serve assembled video file
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join, extname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { debugLog } from '../../debug-log.js';
import { discoverWorkflows } from '../../workflow/loader.js';
import { bridgeServer, ensureBridgeServer } from '../../bridge-server.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const STORYBOARD_DIR = join(homedir(), '.woodbury', 'data', 'storyboards');

// ────────────────────────────────────────────────────────────────
//  Asset helper functions (duplicated from assets.ts — needed
//  for scan-packages, save-to-collection, etc.)
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
//  Storyboard CRUD helpers
// ────────────────────────────────────────────────────────────────

const ensureStoryboardDir = async () => {
  await mkdir(STORYBOARD_DIR, { recursive: true });
};

const listStoryboards = async (): Promise<any[]> => {
  await ensureStoryboardDir();
  const entries = await readdir(STORYBOARD_DIR);
  const results: any[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(STORYBOARD_DIR, e), 'utf-8');
      const sb = JSON.parse(raw);
      results.push(sb);
    } catch { /* skip bad files */ }
  }
  return results.sort((a: any, b: any) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
};

const loadStoryboard = async (id: string): Promise<any | null> => {
  try {
    const raw = await readFile(join(STORYBOARD_DIR, `${id}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
};

const saveStoryboard = async (sb: any): Promise<void> => {
  await ensureStoryboardDir();
  sb.updatedAt = new Date().toISOString();
  await writeFile(join(STORYBOARD_DIR, `${sb.id}.json`), JSON.stringify(sb, null, 2));
};

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleStoryboardRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // Only handle /api/storyboards routes
  if (!pathname.startsWith('/api/storyboards')) return false;

  // GET /api/storyboards — list all storyboards
  if (req.method === 'GET' && pathname === '/api/storyboards') {
    try {
      const storyboards = await listStoryboards();
      sendJson(res, 200, { storyboards });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/storyboards/scan-packages?collectionSlug=xxx — find production package JSONs in a collection
  if (req.method === 'GET' && pathname === '/api/storyboards/scan-packages') {
    try {
      const collectionSlug = url.searchParams.get('collectionSlug');
      if (!collectionSlug) { sendJson(res, 400, { error: 'collectionSlug is required' }); return true; }

      const dataDir = await getAssetsDataDir();
      const collections = await readCollectionsJson(dataDir);
      const collection = collections.find((c: any) => c.slug === collectionSlug);
      if (!collection || !collection.rootPath) {
        sendJson(res, 404, { error: 'Collection not found or has no root path' });
        return true;
      }

      // Recursively scan for JSON files that look like production packages
      const packages: { name: string; path: string; size: number; modified: string; scenesFound: number }[] = [];
      const scanForPackages = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 3) return; // don't go too deep
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await scanForPackages(fullPath, depth + 1);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
              try {
                const fileStat = await stat(fullPath);
                // Skip very large or very small files
                if (fileStat.size < 50 || fileStat.size > 10_000_000) continue;
                const raw = await readFile(fullPath, 'utf-8');
                const parsed = JSON.parse(raw);
                // Check if it has scene-related content (the key indicator of a production package)
                const scenes = parsed.scenes
                  || parsed.scene_breakdown?.scenes
                  || parsed.scene_breakdown?.scene_breakdown?.scenes;
                const nameLower = entry.name.toLowerCase();
                const nameHit = nameLower.includes('production') || nameLower.includes('prod_package')
                  || nameLower.includes('scene') || nameLower.includes('storyboard')
                  || nameLower.includes('script') || nameLower.includes('package');
                // Include if it has scenes OR if the filename looks right
                if (scenes || nameHit) {
                  packages.push({
                    name: entry.name + (scenes ? ' (' + (Array.isArray(scenes) ? scenes.length : '?') + ' scenes)' : ''),
                    path: fullPath,
                    size: fileStat.size,
                    modified: fileStat.mtime.toISOString(),
                    scenesFound: Array.isArray(scenes) ? scenes.length : 0,
                  });
                }
              } catch { /* not valid JSON, skip */ }
            }
          }
        } catch { /* inaccessible dir */ }
      };

      await scanForPackages(collection.rootPath);

      // Also scan JSON assets from the asset library that belong to this collection
      try {
        const assets = await readAssetsJson(dataDir);
        const collectionAssets = assets.filter((a: any) =>
          a.collections?.includes(collectionSlug) &&
          (a.file_type === 'application/json' || (a.file_path && a.file_path.endsWith('.json')))
        );
        const seenPaths = new Set(packages.map(p => p.path));
        for (const asset of collectionAssets) {
          const absPath = resolveAssetPath(asset, dataDir, collections);
          if (!absPath || seenPaths.has(absPath)) continue;
          try {
            const fileStat = await stat(absPath);
            if (fileStat.size < 50 || fileStat.size > 10_000_000) continue;
            const raw = await readFile(absPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const scenes = parsed.scenes
              || parsed.scene_breakdown?.scenes
              || parsed.scene_breakdown?.scene_breakdown?.scenes;
            packages.push({
              name: (asset.name || basename(absPath)) + (scenes ? ' (' + (Array.isArray(scenes) ? scenes.length : '?') + ' scenes)' : ''),
              path: absPath,
              size: fileStat.size,
              modified: asset.updated_at || asset.created_at || fileStat.mtime.toISOString(),
              scenesFound: Array.isArray(scenes) ? scenes.length : 0,
            });
            seenPaths.add(absPath);
          } catch { /* skip */ }
        }
      } catch { /* ok */ }

      // Also scan the Woodbury output directory for pipeline outputs
      const outputDir = join(homedir(), '.woodbury', 'data', 'output');
      try { await scanForPackages(outputDir, 0); } catch { /* ok */ }

      // Sort: files with scenes first (desc by count), then by modification date (newest first)
      packages.sort((a, b) => {
        if (a.scenesFound !== b.scenesFound) return b.scenesFound - a.scenesFound;
        return b.modified.localeCompare(a.modified);
      });

      sendJson(res, 200, { packages, collectionRoot: collection.rootPath });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/storyboards — create from production package path + collection slug
  if (req.method === 'POST' && pathname === '/api/storyboards') {
    try {
      const body = await readBody(req);
      const { productionPackagePath, collectionSlug, name } = body;
      if (!productionPackagePath || !collectionSlug) {
        sendJson(res, 400, { error: 'productionPackagePath and collectionSlug are required' });
        return true;
      }

      // Parse production package
      let pkg: any;
      try {
        const raw = await readFile(productionPackagePath, 'utf-8');
        pkg = JSON.parse(raw);
      } catch (err) {
        sendJson(res, 400, { error: 'Failed to parse production package: ' + String(err) });
        return true;
      }

      // Extract scenes from production package (handle variable nesting)
      let scenes: any[] = [];
      if (pkg.scene_breakdown?.scenes) {
        scenes = pkg.scene_breakdown.scenes;
      } else if (pkg.scenes) {
        scenes = pkg.scenes;
      } else if (pkg.scene_breakdown?.scene_breakdown?.scenes) {
        scenes = pkg.scene_breakdown.scene_breakdown.scenes;
      }

      // Find collection root path
      const dataDir = await getAssetsDataDir();
      const collections = await readCollectionsJson(dataDir);
      const collection = collections.find((c: any) => c.slug === collectionSlug);
      const collectionRoot = collection?.rootPath || '';

      // Scan collection directory for existing images and audio
      let existingImages: string[] = [];
      let existingAudio: string[] = [];
      if (collectionRoot) {
        try {
          const scanDir = async (dir: string, exts: string[]): Promise<string[]> => {
            const results: string[] = [];
            try {
              const entries = await readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                  results.push(...await scanDir(fullPath, exts));
                } else if (exts.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                  results.push(fullPath);
                }
              }
            } catch { /* skip inaccessible dirs */ }
            return results;
          };
          existingImages = await scanDir(collectionRoot, ['.png', '.jpg', '.jpeg', '.webp']);
          existingAudio = await scanDir(collectionRoot, ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a']);
        } catch { /* ok */ }
      }

      // Build storyboard scenes from production package
      const sbId = 'sb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const sbScenes = scenes.map((scene: any, idx: number) => {
        const sceneNum = scene.scene_number || scene.sceneNumber || (idx + 1);
        const title = scene.title || scene.scene_title || `Scene ${sceneNum}`;
        const imagePrompt = scene.image_prompt || scene.imagePrompt || scene.description || '';
        const timestamp = scene.timestamp || scene.timing || '';
        const characters = scene.characters_present || scene.characters || scene.charactersPresent || [];

        // Try to match existing images to this scene by name pattern
        const sceneImages = existingImages.filter(img => {
          const imgName = basename(img).toLowerCase();
          return imgName.includes(`scene_${sceneNum}`) || imgName.includes(`scene${sceneNum}`) ||
                 imgName.includes(`s${sceneNum}_`) || imgName.includes(`s${String(sceneNum).padStart(2, '0')}`);
        });

        const imageOptions = sceneImages.map((filePath, i) => ({
          id: `opt_${sceneNum}_${i}`,
          filePath,
          generatedAt: new Date().toISOString(),
          refsUsed: [],
        }));

        return {
          sceneNumber: sceneNum,
          title,
          timestamp,
          imagePrompt,
          imageOptions,
          selectedImageIndex: imageOptions.length > 0 ? 0 : -1,
          charactersPresent: characters,
        };
      });

      // Build audio selections from discovered audio files
      const audioSelections = existingAudio.map((filePath) => ({
        path: filePath,
        name: basename(filePath).replace(/\.[^.]+$/, ''),
        selected: true,
        role: 'music',
        volume: 0.3,
      }));

      // Extract characters from scenes
      const allCharacters = new Set<string>();
      sbScenes.forEach((s: any) => {
        if (s.charactersPresent) {
          s.charactersPresent.forEach((c: string) => allCharacters.add(c));
        }
      });

      // Parse character descriptions from production package
      const pkgCharacters: any[] = pkg.characters?.characters || pkg.characters || [];
      const charDescMap = new Map<string, any>();
      if (Array.isArray(pkgCharacters)) {
        for (const ch of pkgCharacters) {
          if (ch.name) charDescMap.set(ch.name, ch);
        }
      }

      // Look for character headshot images in collection
      const characterReferences = Array.from(allCharacters)
        .filter(name => charDescMap.has(name)) // Only include actual named characters, not "background commuters"
        .map(charName => {
          const headshot = existingImages.find(img => {
            const imgName = basename(img).toLowerCase().replace(/\.[^.]+$/, '');
            return imgName === charName.toLowerCase() || imgName.includes(charName.toLowerCase());
          });
          const charDef = charDescMap.get(charName);
          // Build a compact visual description for prompt augmentation
          const pa = charDef?.physical_appearance || {};
          const wardrobe = charDef?.wardrobe || {};
          const descParts: string[] = [];
          if (charDef?.age) descParts.push(`age ${charDef.age}`);
          if (charDef?.gender_presentation) descParts.push(charDef.gender_presentation);
          if (pa.hair_color && pa.hair_style) descParts.push(`${pa.hair_color} ${pa.hair_style} hair`);
          else if (pa.hair_color) descParts.push(`${pa.hair_color} hair`);
          if (pa.eye_color) descParts.push(`${pa.eye_color} eyes`);
          if (pa.distinctive_traits) descParts.push(pa.distinctive_traits);
          if (wardrobe.primary_outfit) descParts.push(`wearing ${wardrobe.primary_outfit}`);
          return {
            name: charName,
            role: charDef?.role || '',
            description: descParts.join(', '),
            headShotPath: headshot || '',
            autoApply: true,
          };
        });

      const storyboard = {
        version: '1.0',
        id: sbId,
        name: name || pkg.title || pkg.name || 'Untitled Storyboard',
        productionPackagePath,
        collectionSlug,
        collectionRoot,
        scenes: sbScenes,
        audioSelections,
        characterReferences,
        status: 'curating',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Create storyboard images directory
      await mkdir(join(STORYBOARD_DIR, sbId), { recursive: true });
      await saveStoryboard(storyboard);

      sendJson(res, 201, { storyboard });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/storyboards/:id — get storyboard data
  {
    const sbGetMatch = pathname.match(/^\/api\/storyboards\/([^/]+)$/);
    if (req.method === 'GET' && sbGetMatch) {
      try {
        const sbId = decodeURIComponent(sbGetMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }
        sendJson(res, 200, { storyboard: sb });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // PUT /api/storyboards/:id — save selections
  {
    const sbPutMatch = pathname.match(/^\/api\/storyboards\/([^/]+)$/);
    if (req.method === 'PUT' && sbPutMatch) {
      try {
        const sbId = decodeURIComponent(sbPutMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        const body = await readBody(req);
        // Merge updatable fields — for scenes, merge per-scene to avoid overwriting
        // imageOptions that were added by the generate endpoint
        if (body.scenes && Array.isArray(body.scenes)) {
          for (const inScene of body.scenes) {
            const existingIdx = sb.scenes.findIndex((s: any) => s.sceneNumber === inScene.sceneNumber);
            if (existingIdx >= 0) {
              // Merge: keep imageOptions from disk if incoming scene has fewer
              const diskScene = sb.scenes[existingIdx];
              const diskOpts = diskScene.imageOptions || [];
              const inOpts = inScene.imageOptions || [];
              // Use whichever has more options (disk wins if client is stale)
              if (inOpts.length < diskOpts.length) {
                inScene.imageOptions = diskOpts;
              }
              sb.scenes[existingIdx] = { ...diskScene, ...inScene };
            }
          }
        }
        if (body.audioSelections) sb.audioSelections = body.audioSelections;
        if (body.characterReferences) sb.characterReferences = body.characterReferences;
        if (body.status) sb.status = body.status;
        if (body.name) sb.name = body.name;

        await saveStoryboard(sb);
        sendJson(res, 200, { storyboard: sb });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // DELETE /api/storyboards/:id — delete storyboard + generated images
  {
    const sbDelMatch = pathname.match(/^\/api\/storyboards\/([^/]+)$/);
    if (req.method === 'DELETE' && sbDelMatch) {
      try {
        const sbId = decodeURIComponent(sbDelMatch[1]);
        // Remove storyboard JSON
        try { await unlink(join(STORYBOARD_DIR, `${sbId}.json`)); } catch { /* ok */ }
        // Remove generated images directory
        const sbImgDir = join(STORYBOARD_DIR, sbId);
        try {
          const rmDir = async (dir: string) => {
            try {
              const entries = await readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                  await rmDir(fullPath);
                } else {
                  await unlink(fullPath);
                }
              }
              // rmdir the now-empty dir
              const { rmdir } = await import('node:fs/promises');
              await rmdir(dir);
            } catch { /* ok */ }
          };
          await rmDir(sbImgDir);
        } catch { /* ok */ }

        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // GET /api/storyboards/:id/image/* — serve generated or existing images
  {
    const sbImgMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/image(\/.*)?$/);
    if (req.method === 'GET' && sbImgMatch) {
      try {
        const sbId = decodeURIComponent(sbImgMatch[1]);
        // Support both URL path and ?path= query parameter for file path
        const pathFromUrl = sbImgMatch[2] ? decodeURIComponent(sbImgMatch[2].slice(1)) : '';
        const pathFromQuery = url.searchParams.get('path') || '';
        const imgPath = pathFromQuery || pathFromUrl;

        // If imgPath is an absolute path, serve it directly (for existing collection images)
        let absPath: string;
        if (isAbsolute(imgPath)) {
          absPath = imgPath;
        } else {
          // Relative to storyboard's image directory
          absPath = join(STORYBOARD_DIR, sbId, imgPath);
        }

        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) { sendJson(res, 404, { error: 'Image not found' }); return true; }

        const ext = extname(absPath).toLowerCase();
        const mimeType = ASSET_MIME_MAP[ext] || 'application/octet-stream';

        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': fileStat.size,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        const stream = createReadStream(absPath);
        stream.pipe(res);
        stream.on('error', () => {
          if (!res.headersSent) sendJson(res, 500, { error: 'Failed to read image' });
        });
      } catch {
        sendJson(res, 404, { error: 'Image file not found' });
      }
      return true;
    }
  }

  // GET /api/storyboards/:id/audio/* — serve audio files
  {
    const sbAudioMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/audio(\/.*)?$/);
    if (req.method === 'GET' && sbAudioMatch) {
      try {
        const pathFromUrl = sbAudioMatch[2] ? decodeURIComponent(sbAudioMatch[2].slice(1)) : '';
        const pathFromQuery = url.searchParams.get('path') || '';
        const audioPath = pathFromQuery || pathFromUrl;
        let absPath: string;
        if (isAbsolute(audioPath)) {
          absPath = audioPath;
        } else {
          absPath = join(STORYBOARD_DIR, decodeURIComponent(sbAudioMatch[1]), audioPath);
        }

        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) { sendJson(res, 404, { error: 'Audio not found' }); return true; }

        const ext = extname(absPath).toLowerCase();
        const mimeType = ASSET_MIME_MAP[ext] || 'application/octet-stream';

        // Support Range requests for audio seeking
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileStat.size - 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': mimeType,
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(absPath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': fileStat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(absPath).pipe(res);
        }
      } catch {
        sendJson(res, 404, { error: 'Audio file not found' });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/headshot — upload a character headshot image
  {
    const sbHeadshotMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/headshot$/);
    if (req.method === 'POST' && sbHeadshotMatch) {
      try {
        const sbId = decodeURIComponent(sbHeadshotMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        // Parse multipart form data manually (simple boundary parsing)
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) { sendJson(res, 400, { error: 'Expected multipart form data' }); return true; }

        const boundary = boundaryMatch[1];
        const chunks: Buffer[] = [];
        for await (const chunk of req) { chunks.push(chunk as Buffer); }
        const body = Buffer.concat(chunks);

        // Find the file part
        let fileData: Buffer | null = null;
        let fileName = 'headshot.png';
        let charIndex = -1;

        // Split by boundary
        const bodyStr = body.toString('latin1');
        const parts = bodyStr.split('--' + boundary);

        for (const part of parts) {
          if (part.includes('name="characterIndex"')) {
            const valMatch = part.match(/\r\n\r\n(.+?)(\r\n|$)/);
            if (valMatch) charIndex = parseInt(valMatch[1].trim(), 10);
          }
          if (part.includes('name="headshot"')) {
            const fnMatch = part.match(/filename="([^"]+)"/);
            if (fnMatch) fileName = fnMatch[1];
            // Find the start of file data (after double CRLF)
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd >= 0) {
              const fileStr = part.slice(headerEnd + 4);
              // Remove trailing CRLF before next boundary
              const trimmed = fileStr.replace(/\r\n$/, '');
              fileData = Buffer.from(trimmed, 'latin1');
            }
          }
        }

        if (fileData === null || charIndex < 0 || charIndex >= (sb.characterReferences || []).length) {
          sendJson(res, 400, { error: 'Missing headshot file or invalid characterIndex' });
          return true;
        }

        // Save headshot to storyboard directory
        const headshotsDir = join(STORYBOARD_DIR, sbId, 'headshots');
        await mkdir(headshotsDir, { recursive: true });
        const ext = extname(fileName) || '.png';
        const charName = sb.characterReferences[charIndex].name.replace(/[^a-zA-Z0-9]/g, '_');
        const savePath = join(headshotsDir, `${charName}${ext}`);
        await writeFile(savePath, fileData);

        // Update character reference
        sb.characterReferences[charIndex].headShotPath = savePath;
        await saveStoryboard(sb);

        debugLog.info('storyboard', `Headshot saved for ${sb.characterReferences[charIndex].name}: ${savePath}`);
        sendJson(res, 200, { filePath: savePath, characterName: sb.characterReferences[charIndex].name });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/generate — generate image(s) for a scene with character references
  {
    const sbGenMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/generate$/);
    if (req.method === 'POST' && sbGenMatch) {
      try {
        const sbId = decodeURIComponent(sbGenMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        const body = await readBody(req);
        const { sceneNumber, count = 1, promptOverride, model = 'flash', aspectRatio = '16:9' } = body;
        if (!sceneNumber) { sendJson(res, 400, { error: 'sceneNumber is required' }); return true; }

        const sceneIdx = sb.scenes.findIndex((s: any) => s.sceneNumber === sceneNumber);
        if (sceneIdx === -1) { sendJson(res, 404, { error: 'Scene not found' }); return true; }

        const scene = sb.scenes[sceneIdx];
        const basePrompt = promptOverride || scene.imagePrompt;
        if (!basePrompt) { sendJson(res, 400, { error: 'No image prompt available' }); return true; }

        // Gather character reference images and descriptions for this scene
        const referenceImages: string[] = [];
        const charDescriptions: string[] = [];
        if (scene.charactersPresent && sb.characterReferences) {
          for (const charName of scene.charactersPresent) {
            const charRef = sb.characterReferences.find((cr: any) => cr.name === charName && cr.autoApply);
            if (charRef) {
              if (charRef.headShotPath) {
                referenceImages.push(charRef.headShotPath);
                charDescriptions.push(`Reference image ${referenceImages.length} is ${charRef.name}${charRef.description ? ' (' + charRef.description + ')' : ''}`);
              }
            }
          }
        }

        // Augment prompt with character reference instructions
        let prompt = basePrompt;
        if (referenceImages.length > 0) {
          const refInstructions = 'IMPORTANT: Use the provided reference images to maintain exact character appearance consistency. '
            + charDescriptions.join('. ') + '. '
            + 'The characters in this scene MUST match the reference images exactly \u2014 same face, hair, clothing, and features.\n\n';
          prompt = refInstructions + prompt;
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

        // Create scene output directory
        const sceneDir = join(STORYBOARD_DIR, sbId, `scene_${sceneNumber}`);
        await mkdir(sceneDir, { recursive: true });

        const generated: any[] = [];
        for (let i = 0; i < Math.min(count, 5); i++) {
          try {
            const optId = `opt_${sceneNumber}_${Date.now().toString(36)}_${i}`;
            const outputPath = join(sceneDir, `${optId}.png`);

            const result = await nanobananaTool({
              action: 'generate' as const,
              prompt,
              referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
              model,
              aspectRatio,
              outputPath,
            }, sceneDir);

            const parsed = typeof result === 'string' ? JSON.parse(result) : result;

            const option = {
              id: optId,
              filePath: parsed.filePath || outputPath,
              generatedAt: new Date().toISOString(),
              refsUsed: referenceImages.map((r: string) => basename(r)),
              model,
            };
            generated.push(option);

            // Add to storyboard scene
            scene.imageOptions.push(option);
            // Auto-select first generated if none selected
            if (scene.selectedImageIndex === -1) {
              scene.selectedImageIndex = scene.imageOptions.length - 1;
            }
          } catch (genErr) {
            debugLog.error('storyboard', `Failed to generate image for scene ${sceneNumber}: ${genErr}`);
          }
        }

        await saveStoryboard(sb);
        sendJson(res, 200, { generated, scene: sb.scenes[sceneIdx] });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/frame-to-video — convert scene images to video via Midjourney
  {
    const sbF2VMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/frame-to-video$/);
    if (req.method === 'POST' && sbF2VMatch) {
      try {
        const sbId = decodeURIComponent(sbF2VMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        const body = await readBody(req);
        const sceneNumbers: number[] = body?.sceneNumbers || [];
        const promptOverride: string | undefined = body?.promptOverride;

        if (!sceneNumbers.length) {
          sendJson(res, 400, { error: 'sceneNumbers array is required' });
          return true;
        }

        // Validate scenes exist and have selected images
        const scenesToConvert: Array<{ scene: any; sceneIdx: number }> = [];
        for (const sn of sceneNumbers) {
          const idx = sb.scenes.findIndex((s: any) => (s.sceneNumber || 0) === sn);
          if (idx === -1) {
            sendJson(res, 400, { error: `Scene ${sn} not found` });
            return true;
          }
          const sc = sb.scenes[idx];
          const selIdx = sc.selectedImageIndex;
          if (selIdx === null || selIdx === undefined || selIdx === -1 || !(sc.imageOptions || [])[selIdx]) {
            sendJson(res, 400, { error: `Scene ${sn} has no selected image` });
            return true;
          }
          scenesToConvert.push({ scene: sc, sceneIdx: idx });
        }

        // Ensure Chrome extension is connected
        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.' });
          return true;
        }

        // Check nothing else is running
        if (ctx.activeRun && !ctx.activeRun.done) {
          sendJson(res, 409, { error: `Workflow "${ctx.activeRun.workflowName}" is already running.` });
          return true;
        }
        if (ctx.activeCompRun && !ctx.activeCompRun.done) {
          sendJson(res, 409, { error: `Composition "${ctx.activeCompRun.compositionName}" is running.` });
          return true;
        }

        // Find the "Midjourney Frame to Video" workflow
        const discovered = await discoverWorkflows(ctx.workDir);
        const found = discovered.find((d: any) => d.workflow.id === 'Midjourney frame to video' || d.workflow.name === 'Midjourney Frame To Video');
        if (!found) {
          sendJson(res, 404, { error: 'Workflow "Midjourney Frame To Video" not found. Make sure it exists in your workflows directory.' });
          return true;
        }
        const wf = found.workflow;

        // Load workflow runner
        let executeWf: Function;
        try {
          const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
          const wfRunner = require(wfRunnerPath);
          executeWf = wfRunner.executeWorkflow;
          if (!executeWf) throw new Error('executeWorkflow not found');
        } catch (importErr: any) {
          sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message || String(importErr)}` });
          return true;
        }

        const abort = new AbortController();
        const totalScenes = scenesToConvert.length;

        ctx.activeRun = {
          workflowId: 'frame-to-video',
          workflowName: `Frame to Video (${totalScenes} scene${totalScenes > 1 ? 's' : ''})`,
          abort,
          startedAt: Date.now(),
          stepsTotal: totalScenes * wf.steps.length,
          stepsCompleted: 0,
          currentStep: `Scene 1 of ${totalScenes}`,
          stepResults: [],
          done: false,
          success: false,
        };

        sendJson(res, 200, { started: true, sceneCount: totalScenes });

        // Run sequentially in background
        (async () => {
          const run = ctx.activeRun;
          if (!run) return;
          const results: Array<{ sceneNumber: number; videoPath?: string; error?: string }> = [];

          for (let si = 0; si < scenesToConvert.length; si++) {
            if (abort.signal.aborted) break;
            const { scene, sceneIdx } = scenesToConvert[si];
            const selImg = scene.imageOptions[scene.selectedImageIndex];
            const filepath = selImg.filePath;
            const prompt = promptOverride || scene.imagePrompt || '';

            run.currentStep = `Scene ${si + 1} of ${totalScenes}: ${scene.title || 'Scene ' + scene.sceneNumber}`;

            try {
              const result = await executeWf(bridgeServer, wf, { filepath, prompt }, {
                log: (msg: string) => {
                  debugLog.info('frame-to-video', `[Scene ${scene.sceneNumber}] ${msg}`);
                },
                signal: abort.signal,
                onProgress: (event: any) => {
                  if (event.type === 'step_start') {
                    run.currentStep = `Scene ${si + 1}/${totalScenes}: ${event.step?.label || 'Step ' + (event.index + 1)}`;
                  } else if (event.type === 'step_complete') {
                    run.stepsCompleted = si * wf.steps.length + event.index + 1;
                  }
                },
              });

              if (result.success) {
                // Extract video path from downloadedFiles
                const downloaded = result.variables?.downloadedFiles;
                let videoPath = '';
                if (Array.isArray(downloaded) && downloaded.length > 0) {
                  videoPath = typeof downloaded[0] === 'string' ? downloaded[0] : (downloaded[0]?.path || downloaded[0]?.filePath || '');
                } else if (typeof downloaded === 'string') {
                  videoPath = downloaded;
                }

                if (videoPath) {
                  // Update scene with video path
                  sb.scenes[sceneIdx].videoPath = videoPath;
                  sb.scenes[sceneIdx].videoGeneratedAt = new Date().toISOString();
                  await saveStoryboard(sb);
                  results.push({ sceneNumber: scene.sceneNumber, videoPath });
                } else {
                  results.push({ sceneNumber: scene.sceneNumber, error: 'No video file captured' });
                }
              } else {
                results.push({ sceneNumber: scene.sceneNumber, error: result.error || 'Workflow failed' });
              }
            } catch (err: any) {
              results.push({ sceneNumber: scene.sceneNumber, error: err?.message || String(err) });
            }
          }

          run.done = true;
          run.success = results.every(r => !r.error);
          run.durationMs = Date.now() - run.startedAt;
          run.stepsCompleted = run.stepsTotal;
          (run as any).outputVariables = { results };
        })();

      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/save-to-collection — import storyboard media as assets into a collection
  {
    const sbSaveColMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/save-to-collection$/);
    if (req.method === 'POST' && sbSaveColMatch) {
      try {
        const sbId = decodeURIComponent(sbSaveColMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        const body = await readBody(req);
        const collectionSlug: string = body?.collection;
        if (!collectionSlug) { sendJson(res, 400, { error: 'collection slug is required' }); return true; }

        // items: array of { type: 'image'|'video'|'assembled_video', sceneIndex?: number }
        const items: Array<{ type: string; sceneIndex?: number }> = body?.items || [];
        if (items.length === 0) { sendJson(res, 400, { error: 'items array is required' }); return true; }

        const dataDir = await getAssetsDataDir();
        const filesDir = join(dataDir, 'files');
        await mkdir(filesDir, { recursive: true });
        const assets = await readAssetsJson(dataDir);
        const collections = await readCollectionsJson(dataDir);
        const col = collections.find((c: any) => c.slug === collectionSlug);
        if (!col) { sendJson(res, 404, { error: 'Collection not found: ' + collectionSlug }); return true; }

        const imported: any[] = [];
        const errors: any[] = [];

        for (const item of items) {
          try {
            let filePath = '';
            let assetName = '';
            let category = 'image';

            if (item.type === 'image' && item.sceneIndex !== undefined) {
              const scene = sb.scenes[item.sceneIndex];
              if (!scene) { errors.push({ ...item, error: 'Scene not found' }); continue; }
              const opt = (scene.imageOptions || [])[scene.selectedImageIndex];
              if (!opt?.filePath) { errors.push({ ...item, error: 'No selected image' }); continue; }
              filePath = opt.filePath;
              assetName = `${sb.name} - Scene ${scene.sceneNumber || item.sceneIndex + 1} Image`;
              category = 'image';
            } else if (item.type === 'video' && item.sceneIndex !== undefined) {
              const scene = sb.scenes[item.sceneIndex];
              if (!scene?.videoPath) { errors.push({ ...item, error: 'No video for scene' }); continue; }
              filePath = scene.videoPath;
              assetName = `${sb.name} - Scene ${scene.sceneNumber || item.sceneIndex + 1} Video`;
              category = 'video';
            } else if (item.type === 'assembled_video') {
              if (!sb.lastVideoPath) { errors.push({ ...item, error: 'No assembled video' }); continue; }
              filePath = sb.lastVideoPath;
              assetName = `${sb.name} - Assembled Video`;
              category = 'video';
            } else {
              errors.push({ ...item, error: 'Unknown item type' });
              continue;
            }

            // Check file exists
            try { await stat(filePath); } catch { errors.push({ ...item, error: 'File not found: ' + filePath }); continue; }

            // Check if already imported (same file_path in same collection)
            const existing = assets.find((a: any) => {
              const absPath = resolveAssetPath(a, dataDir, collections);
              return absPath === filePath && a.collections.includes(collectionSlug);
            });
            if (existing) { imported.push({ ...item, assetId: existing.id, alreadyExists: true }); continue; }

            const id = generateAssetId();
            const ext = extname(filePath);
            const slug = assetSlugify(assetName);
            const mimeType = ASSET_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
            const fileStats = await stat(filePath);

            const asset: any = {
              id,
              name: assetName,
              description: `From storyboard "${sb.name}"`,
              file_path: filePath,
              path_mode: 'absolute',
              file_type: mimeType,
              file_size: fileStats.size,
              category: detectAssetCategory(mimeType) || category,
              tags: ['storyboard', sb.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
              collections: [collectionSlug],
              version: 1,
              versions: [{ version: 1, file_path: filePath, created_at: new Date().toISOString(), notes: 'Imported from storyboard' }],
              metadata: { storyboardId: sb.id, storyboardName: sb.name, itemType: item.type, sceneIndex: item.sceneIndex },
              is_default_for: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            assets.push(asset);
            imported.push({ ...item, assetId: id });
          } catch (err: any) {
            errors.push({ ...item, error: err?.message || String(err) });
          }
        }

        await writeAssetsJson(dataDir, assets);

        // Also store the output collection on the storyboard
        sb.outputCollectionSlug = collectionSlug;
        await saveStoryboard(sb);

        sendJson(res, 200, { imported, errors, collectionSlug });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/export — export curated asset_map for video assembly
  {
    const sbExportMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/export$/);
    if (req.method === 'POST' && sbExportMatch) {
      try {
        const sbId = decodeURIComponent(sbExportMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        // Validate: all scenes must have a selected image
        const missingScenes = sb.scenes.filter((s: any) => s.selectedImageIndex === -1 || !s.imageOptions[s.selectedImageIndex]);
        if (missingScenes.length > 0) {
          sendJson(res, 400, {
            error: 'Not all scenes have a selected image',
            missingScenes: missingScenes.map((s: any) => s.sceneNumber),
          });
          return true;
        }

        // Validate: at least one audio track selected
        const selectedAudio = (sb.audioSelections || []).filter((a: any) => a.selected);
        if (selectedAudio.length === 0) {
          sendJson(res, 400, { error: 'At least one audio track must be selected' });
          return true;
        }

        // Build asset_map matching the video assembly pipeline's expected format
        const assetMap: any = {
          scenes: sb.scenes.map((scene: any) => {
            const selectedOption = scene.imageOptions[scene.selectedImageIndex];
            const useVideo = scene.videoPath && scene.useVideo !== false;
            return {
              scene_number: scene.sceneNumber,
              title: scene.title,
              timestamp: scene.timestamp,
              image_path: selectedOption.filePath,
              image_prompt: scene.imagePrompt,
              video_path: scene.videoPath || null,
              media_path: useVideo ? scene.videoPath : selectedOption.filePath,
              media_type: useVideo ? 'video' : 'image',
            };
          }),
          audio: selectedAudio.map((a: any) => ({
            path: a.path,
            name: a.name,
            role: a.role || 'music',
            volume: a.volume !== undefined ? a.volume : 0.3,
          })),
          metadata: {
            storyboardId: sb.id,
            storyboardName: sb.name,
            exportedAt: new Date().toISOString(),
            collectionSlug: sb.collectionSlug,
          },
        };

        // Save asset map to storyboard directory
        const exportPath = join(STORYBOARD_DIR, sbId, 'asset_map.json');
        await writeFile(exportPath, JSON.stringify(assetMap, null, 2));

        sb.status = 'exported';
        await saveStoryboard(sb);

        sendJson(res, 200, { assetMap, exportPath });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  // POST /api/storyboards/:id/assemble — run ffmpeg to create video from curated assets
  {
    const sbAssembleMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/assemble$/);
    if (req.method === 'POST' && sbAssembleMatch) {
      try {
        const sbId = decodeURIComponent(sbAssembleMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb) { sendJson(res, 404, { error: 'Storyboard not found' }); return true; }

        // Validate scenes
        const missingScenes = sb.scenes.filter((s: any) => s.selectedImageIndex === -1 || !s.imageOptions?.[s.selectedImageIndex]);
        if (missingScenes.length > 0) {
          sendJson(res, 400, { error: `${missingScenes.length} scene(s) missing selected images` });
          return true;
        }

        const selectedAudio = (sb.audioSelections || []).filter((a: any) => a.selected !== false);
        if (selectedAudio.length === 0) {
          sendJson(res, 400, { error: 'At least one audio track must be selected' });
          return true;
        }

        // Parse scene timestamps like "0-4s" -> { start: 0, end: 4, duration: 4 }
        // Determine media source per scene: video (if useVideo + videoPath) or image
        const parsedScenes = sb.scenes.map((scene: any) => {
          const selectedOpt = scene.imageOptions[scene.selectedImageIndex];
          let start = 0, end = 5; // default 5s per scene
          const tsMatch = (scene.timestamp || '').match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
          if (tsMatch) {
            start = parseFloat(tsMatch[1]);
            end = parseFloat(tsMatch[2]);
          }
          const useVideo = scene.videoPath && scene.useVideo !== false;
          return {
            sceneNumber: scene.sceneNumber,
            title: scene.title,
            mediaPath: useVideo ? scene.videoPath : selectedOpt.filePath,
            isVideo: !!useVideo,
            start,
            end,
            duration: end - start,
          };
        });

        const totalDuration = parsedScenes.reduce((sum: number, s: any) => sum + s.duration, 0);
        const outputDir = join(STORYBOARD_DIR, sbId);
        const outputPath = join(outputDir, `${sb.name || 'storyboard'}_video.mp4`);
        await mkdir(outputDir, { recursive: true });

        // Build ffmpeg filter complex:
        // 1. Each scene uses either a looped image or a video clip
        // 2. Audio tracks are mixed together with their volumes
        // 3. Everything is concatenated

        const ffmpegArgs: string[] = [];

        // Add media inputs (one per scene -- image looped or video)
        for (const scene of parsedScenes) {
          if (scene.isVideo) {
            // Video input: trim to scene duration
            ffmpegArgs.push('-t', String(scene.duration), '-i', scene.mediaPath);
          } else {
            // Image input: loop for duration
            ffmpegArgs.push('-loop', '1', '-t', String(scene.duration), '-i', scene.mediaPath);
          }
        }

        // Add audio inputs
        for (const audio of selectedAudio) {
          ffmpegArgs.push('-i', audio.path);
        }

        const numScenes = parsedScenes.length;
        const numAudio = selectedAudio.length;

        // Build filter complex
        let filterParts: string[] = [];
        let concatInputs = '';

        // Scale each scene to 1920x1080 and set framerate
        for (let i = 0; i < numScenes; i++) {
          if (parsedScenes[i].isVideo) {
            // Video: scale + fps, trim handled by input args
            filterParts.push(`[${i}:v]fps=24,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`);
          } else {
            // Image: same as before
            filterParts.push(`[${i}:v]fps=24,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`);
          }
          concatInputs += `[v${i}]`;
        }

        // Concat all video segments
        filterParts.push(`${concatInputs}concat=n=${numScenes}:v=1:a=0[vout]`);

        // Mix audio tracks with volume controls, trim to video duration
        if (numAudio === 1) {
          const vol = selectedAudio[0].volume !== undefined ? selectedAudio[0].volume : 0.3;
          filterParts.push(`[${numScenes}:a]volume=${vol},atrim=0:${totalDuration},apad[aout]`);
        } else {
          let amixInputs = '';
          for (let i = 0; i < numAudio; i++) {
            const audioIdx = numScenes + i;
            const vol = selectedAudio[i].volume !== undefined ? selectedAudio[i].volume : 0.3;
            filterParts.push(`[${audioIdx}:a]volume=${vol},atrim=0:${totalDuration},apad[a${i}]`);
            amixInputs += `[a${i}]`;
          }
          filterParts.push(`${amixInputs}amix=inputs=${numAudio}:duration=longest:dropout_transition=2[aout]`);
        }

        const filterComplex = filterParts.join(';');

        ffmpegArgs.push(
          '-filter_complex', filterComplex,
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-t', String(totalDuration),
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-y',
          outputPath,
        );

        const videoSceneCount = parsedScenes.filter((s: any) => s.isVideo).length;
        debugLog.info('storyboard', `Assembling video: ${numScenes} scenes (${videoSceneCount} video, ${numScenes - videoSceneCount} image), ${numAudio} audio tracks, ${totalDuration}s total`);

        // Run ffmpeg
        const ffmpegBin = '/opt/homebrew/bin/ffmpeg';
        const ffproc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        let stderrLog = '';
        ffproc.stderr?.on('data', (chunk: Buffer) => {
          stderrLog += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
          ffproc.on('close', (code: number | null) => {
            if (code === 0) {
              resolve();
            } else {
              // Extract last few lines of stderr for error message
              const lines = stderrLog.trim().split('\n');
              const lastLines = lines.slice(-5).join('\n');
              reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`));
            }
          });
          ffproc.on('error', (err: Error) => reject(err));
        });

        // Get file size
        const outputStat = await stat(outputPath);
        const fileSizeMB = (outputStat.size / (1024 * 1024)).toFixed(1);

        // Update storyboard status
        sb.status = 'assembled';
        sb.lastVideoPath = outputPath;
        await saveStoryboard(sb);

        debugLog.info('storyboard', `Video assembled: ${outputPath} (${fileSizeMB}MB)`);

        sendJson(res, 200, {
          videoPath: outputPath,
          duration: totalDuration,
          fileSize: outputStat.size,
          fileSizeMB,
          scenes: numScenes,
          audioTracks: numAudio,
        });
      } catch (err) {
        debugLog.error('storyboard', `Video assembly failed: ${err}`);
        sendJson(res, 500, { error: `Assembly failed: ${(err as Error).message}` });
      }
      return true;
    }
  }

  // GET /api/storyboards/:id/video — serve assembled video file
  {
    const sbVideoMatch = pathname.match(/^\/api\/storyboards\/([^/]+)\/video$/);
    if (req.method === 'GET' && sbVideoMatch) {
      try {
        const sbId = decodeURIComponent(sbVideoMatch[1]);
        const sb = await loadStoryboard(sbId);
        if (!sb || !sb.lastVideoPath) { sendJson(res, 404, { error: 'No video found' }); return true; }

        const videoPath = sb.lastVideoPath;
        const videoStat = await stat(videoPath);
        const fileSize = videoStat.size;

        // Support range requests for video seeking
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;
          const stream = createReadStream(videoPath, { start, end });
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*',
          });
          stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(videoPath).pipe(res);
        }
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return true;
    }
  }

  return false;
};
