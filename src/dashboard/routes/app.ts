/**
 * Dashboard Route: App
 *
 * Handles app-level endpoints that don't belong to a specific feature area.
 *
 * Endpoints:
 *   GET  /api/bridge/status      — Chrome extension bridge connection status
 *   POST /api/app/update-install — trigger auto-updater download & install
 *   GET  /api/app/update-check   — check for available app updates
 *   GET  /api/file?path=...      — serve local media files for preview
 *   POST /api/browse             — list directories for folder picker
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, createReadStream } from 'node:fs';
import { bridgeServer } from '../../bridge-server.js';

// ── Computed __dirname equivalent ────────────────────────────
// When compiled, this file lives at dist/dashboard/routes/app.js.
// The original config-dashboard.ts lived at dist/config-dashboard.js,
// so all __dirname-relative paths need 2 extra ".." segments.
// distDir points to the `dist/` directory.
const distDir = join(__dirname, '..', '..');

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleAppRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {

  // GET /api/bridge/status — Chrome extension connection status
  if (req.method === 'GET' && pathname === '/api/bridge/status') {
    // Resolve the bundled chrome-extension path (works in both dev and packaged Electron)
    const candidates = [
      join(distDir, '..', 'chrome-extension'),             // dev: dist/../chrome-extension
      join(distDir, '..', '..', 'chrome-extension'),       // packaged: app.asar/../chrome-extension
    ];
    const extensionPath = candidates.find(p => existsSync(p)) || candidates[0];

    sendJson(res, 200, {
      bridgeRunning: bridgeServer.isStarted,
      extensionConnected: bridgeServer.isConnected,
      extensionPath,
    });
    return true;
  }

  // POST /api/app/update-install — trigger the auto-updater to download & install
  if (req.method === 'POST' && pathname === '/api/app/update-install') {
    const updater = (global as any).woodburyAutoUpdater;
    if (!updater) {
      sendJson(res, 503, { error: 'Auto-updater not available (running in dev mode?)' });
      return true;
    }
    try {
      // Tell the updater to skip the "Download?" dialog and start immediately
      (global as any).woodburyAutoDownloadNext = true;
      await updater.checkForUpdates();
      sendJson(res, 200, { status: 'ok', message: 'Update check triggered — download will start automatically' });
    } catch (err: any) {
      (global as any).woodburyAutoDownloadNext = false;
      sendJson(res, 500, { error: err.message || 'Update check failed' });
    }
    return true;
  }

  // GET /api/app/update-check — check for app updates
  if (req.method === 'GET' && pathname === '/api/app/update-check') {
    function compareVersions(a: string, b: string): number {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
      }
      return 0;
    }

    try {
      // Read current version from package.json
      const pkgPath = join(distDir, '..', 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const currentVersion: string = pkg.version;

      // Fetch latest version from woodbury.bot
      const https = await import('node:https');
      const versionData: any = await new Promise((resolve, reject) => {
        https.get('https://woodbury.bot/version.json', (resp: any) => {
          let body = '';
          resp.on('data', (chunk: string) => { body += chunk; });
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid version.json')); }
          });
        }).on('error', reject);
      });

      const latestVersion: string = versionData.version;
      const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

      sendJson(res, 200, {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseDate: versionData.releaseDate,
        releaseNotes: versionData.releaseNotes,
        downloadUrls: versionData.downloadUrls,
        releaseUrl: versionData.releaseUrl,
      });
    } catch (err: any) {
      // Still return current version even if remote check fails
      let currentVersion = '?.?.?';
      try {
        const pkgPath = join(distDir, '..', 'package.json');
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
        currentVersion = pkg.version;
      } catch {}

      sendJson(res, 200, {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: 'Could not check for updates',
      });
    }
    return true;
  }

  // GET /api/file?path=... — serve local media files for preview
  if (req.method === 'GET' && pathname === '/api/file') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }

    // Must be an absolute path
    if (!filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/i)) {
      sendJson(res, 400, { error: 'Path must be absolute' });
      return true;
    }

    const ext = extname(filePath).toLowerCase();
    const mediaMimeTypes: Record<string, string> = {
      // images
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
      // video
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.webm': 'video/webm', '.mkv': 'video/x-matroska',
      // audio
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
      // documents
      '.pdf': 'application/pdf',
      // text / code
      '.json': 'application/json', '.csv': 'text/csv',
      '.txt': 'text/plain', '.md': 'text/markdown',
      '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
      '.html': 'text/html', '.css': 'text/css', '.sh': 'text/x-sh',
      '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'text/xml',
      '.log': 'text/plain', '.env': 'text/plain',
    };

    const mimeType = mediaMimeTypes[ext];
    if (!mimeType) {
      sendJson(res, 400, { error: `Unsupported file type: ${ext}` });
      return true;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: 'Not a file' });
        return true;
      }

      // Support Range requests for video/audio seeking
      const range = req.headers.range;
      if (range && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileStat.size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
        });
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': fileStat.size,
          'Accept-Ranges': mimeType.startsWith('video/') || mimeType.startsWith('audio/') ? 'bytes' : 'none',
          'Cache-Control': 'no-cache',
        });
        const stream = createReadStream(filePath);
        stream.pipe(res);
        stream.on('error', () => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Failed to read file' });
          }
        });
      }
    } catch {
      sendJson(res, 404, { error: 'File not found' });
    }
    return true;
  }

  // POST /api/browse — list directories for folder picker
  if (req.method === 'POST' && pathname === '/api/browse') {
    try {
      const body = await readBody(req);
      const dir = body?.path || homedir();

      const entries = await readdir(dir, { withFileTypes: true });
      const dirs: Array<{ name: string; path: string }> = [];
      for (const entry of entries) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        try {
          const fullPath = join(dir, entry.name);
          const stats = await stat(fullPath);
          if (stats.isDirectory()) {
            dirs.push({ name: entry.name, path: fullPath });
          }
        } catch {
          // Skip unreadable entries
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, { current: dir, parent: join(dir, '..'), dirs });
    } catch (err) {
      sendJson(res, 400, { error: `Cannot read directory: ${err}` });
    }
    return true;
  }

  return false;
};
