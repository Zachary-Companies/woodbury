/**
 * Dashboard Route: Marketplace
 *
 * Handles /api/marketplace endpoints.
 *
 * Endpoints:
 *   GET  /api/marketplace/registry          — get marketplace registry (cached)
 *   POST /api/marketplace/install           — install extension from git URL
 *   POST /api/marketplace/uninstall         — uninstall extension
 *   GET  /api/marketplace/auth-status       — check marketplace sign-in
 *   POST /api/marketplace/auth/signin       — Google OAuth for marketplace
 *   POST /api/marketplace/auth/signout      — sign out of marketplace
 *   GET  /api/marketplace/shared-workflows  — browse shared workflows
 *   POST /api/marketplace/publish           — upload workflow + model to cloud
 *   POST /api/marketplace/download          — download + install a shared workflow
 *   GET  /api/marketplace/updates           — check for updates to installed shared workflows
 *   POST /api/marketplace/update            — update an installed shared workflow
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  readManifest,
  EXTENSIONS_DIR,
} from '../../extension-loader.js';
import { loadWorkflow } from '../../workflow/loader.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleMarketplaceRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { extensionManager } = ctx;

  // GET /api/marketplace/registry — fetch and cache the extension registry
  if (req.method === 'GET' && pathname === '/api/marketplace/registry') {
    try {
      // Cache registry for 1 hour
      const now = Date.now();
      if (ctx.registryCache && now - ctx.registryCacheTime < 3600000) {
        sendJson(res, 200, ctx.registryCache);
        return true;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch('https://woodbury.bot/registry.json', {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      ctx.registryCache = data;
      ctx.registryCacheTime = now;
      sendJson(res, 200, data);
    } catch (err) {
      // Serve stale cache if available
      if (ctx.registryCache) {
        sendJson(res, 200, ctx.registryCache);
      } else {
        sendJson(res, 502, {
          error: `Failed to fetch registry: ${err instanceof Error ? err.message : err}`,
        });
      }
    }
    return true;
  }

  // POST /api/marketplace/install — install an extension from git
  if (req.method === 'POST' && pathname === '/api/marketplace/install') {
    try {
      const body = await readBody(req);
      const { gitUrl, name } = body || {};

      if (!gitUrl || typeof gitUrl !== 'string') {
        sendJson(res, 400, { error: 'gitUrl is required' });
        return true;
      }

      // Security: only allow Zachary-Companies org repos
      if (!gitUrl.startsWith('https://github.com/Zachary-Companies/')) {
        sendJson(res, 400, { error: 'Only extensions from Zachary-Companies are supported' });
        return true;
      }

      const repoName = gitUrl
        .replace(/\.git$/, '')
        .replace(/\/$/, '')
        .split('/')
        .pop() || '';
      if (!repoName) {
        sendJson(res, 400, { error: 'Could not determine repo name from URL' });
        return true;
      }

      const cloneDir = join(EXTENSIONS_DIR, repoName);

      // Check if already installed
      if (existsSync(cloneDir)) {
        sendJson(res, 409, { error: 'Extension already installed', directory: cloneDir });
        return true;
      }

      // Ensure extensions directory exists
      await mkdir(EXTENSIONS_DIR, { recursive: true });

      // Try git clone first, fall back to zip download
      const { execSync } = require('child_process') as typeof import('child_process');
      let installed = false;

      try {
        execSync(`git clone "${gitUrl}" "${cloneDir}"`, { timeout: 30000, stdio: 'pipe' });
        installed = true;
      } catch {
        // git not available — try zip download
        debugLog.info('marketplace', 'git clone failed, trying zip download');
        try {
          const zipUrl = gitUrl
            .replace(/\.git$/, '')
            .replace(/\/$/, '') + '/archive/refs/heads/main.zip';
          const zipResp = await fetch(zipUrl);
          if (!zipResp.ok) throw new Error(`HTTP ${zipResp.status}`);

          // Write zip to temp file
          const tmpZip = join(EXTENSIONS_DIR, `_tmp_${repoName}.zip`);
          const buffer = Buffer.from(await zipResp.arrayBuffer());
          await writeFile(tmpZip, buffer);

          // Extract
          await mkdir(cloneDir, { recursive: true });
          execSync(`unzip -o "${tmpZip}" -d "${EXTENSIONS_DIR}"`, { timeout: 15000, stdio: 'pipe' });

          // Zip extracts to <repoName>-main/, rename to <repoName>/
          const extractedDir = join(EXTENSIONS_DIR, `${repoName}-main`);
          if (existsSync(extractedDir)) {
            const { renameSync, rmSync } = require('fs');
            if (existsSync(cloneDir)) rmSync(cloneDir, { recursive: true });
            renameSync(extractedDir, cloneDir);
          }

          // Clean up zip
          try { await unlink(tmpZip); } catch { /* ignore */ }
          installed = true;
        } catch (zipErr) {
          sendJson(res, 500, {
            error: `Installation failed. git and zip download both failed: ${zipErr instanceof Error ? zipErr.message : zipErr}`,
          });
          return true;
        }
      }

      if (!installed) {
        sendJson(res, 500, { error: 'Installation failed' });
        return true;
      }

      // Read package.json for validation
      let extName = name || repoName;
      try {
        const pkgRaw = await readFile(join(cloneDir, 'package.json'), 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        if (pkg.woodbury?.name) extName = pkg.woodbury.name;

        // Install npm deps if any
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          try { execSync('npm install', { cwd: cloneDir, timeout: 60000, stdio: 'pipe' }); } catch { /* non-fatal */ }
        }
        // Build if build script exists
        if (pkg.scripts?.build) {
          try { execSync('npm run build', { cwd: cloneDir, timeout: 60000, stdio: 'pipe' }); } catch { /* non-fatal */ }
        }
      } catch {
        // No package.json or invalid — still allow install
      }

      debugLog.info('marketplace', `Installed extension "${extName}" to ${cloneDir}`);

      // Hot-install: read manifest, register in registry, and activate immediately
      let activated = false;
      if (extensionManager) {
        try {
          const manifest = await readManifest(cloneDir, 'local');
          if (manifest) {
            await extensionManager.hotInstall(manifest);
            activated = true;
            debugLog.info('marketplace', `Hot-installed and activated "${extName}"`);
          }
        } catch (hotErr) {
          debugLog.warn('marketplace', `Hot-install activation failed for "${extName}": ${hotErr}`);
        }
      }

      sendJson(res, 200, {
        success: true,
        name: extName,
        directory: cloneDir,
        message: activated ? 'Extension installed and activated.' : 'Extension installed.',
        activated,
      });
    } catch (err) {
      sendJson(res, 500, { error: `Install failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/marketplace/uninstall — remove an extension
  if (req.method === 'POST' && pathname === '/api/marketplace/uninstall') {
    try {
      const body = await readBody(req);
      const { name } = body || {};

      if (!name || typeof name !== 'string') {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }

      // Sanitize name to prevent path traversal
      if (name.includes('/') || name.includes('..') || name.includes('\\')) {
        sendJson(res, 400, { error: 'Invalid extension name' });
        return true;
      }

      // Find the extension in registry
      const entry = extensionManager?.registryInstance?.get(name);
      if (!entry) {
        sendJson(res, 404, { error: `Extension "${name}" not found` });
        return true;
      }

      // Deactivate if currently loaded
      if (extensionManager) {
        try { await extensionManager.deactivate(name); } catch { /* ignore */ }
      }

      // Remove from registry
      extensionManager?.registryInstance?.remove(name);
      await extensionManager?.registryInstance?.save();

      // Remove the directory
      const { rm } = await import('fs/promises');
      await rm(entry.directory, { recursive: true, force: true });

      debugLog.info('marketplace', `Uninstalled extension "${name}" from ${entry.directory}`);
      sendJson(res, 200, { success: true, name, message: 'Extension removed.' });
    } catch (err) {
      sendJson(res, 500, { error: `Uninstall failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/marketplace/auth-status — check marketplace sign-in
  if (req.method === 'GET' && pathname === '/api/marketplace/auth-status') {
    try {
      const { getCurrentUser } = await import('../../marketplace/firebase-client.js');
      const user = getCurrentUser();
      if (user) {
        sendJson(res, 200, {
          signedIn: true,
          uid: user.uid,
          displayName: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
        });
      } else {
        sendJson(res, 200, { signedIn: false });
      }
    } catch {
      sendJson(res, 200, { signedIn: false });
    }
    return true;
  }

  // POST /api/marketplace/auth/signin — Google OAuth for marketplace
  if (req.method === 'POST' && pathname === '/api/marketplace/auth/signin') {
    try {
      const body = await readBody(req);
      if (!body?.idToken) {
        sendJson(res, 400, { error: 'Missing idToken' });
        return true;
      }
      const { signInWithGoogleToken } = await import('../../marketplace/firebase-client.js');
      const user = await signInWithGoogleToken(body.idToken);
      sendJson(res, 200, {
        success: true,
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
      });
    } catch (err) {
      sendJson(res, 500, { error: `Sign-in failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/marketplace/auth/signout — Sign out of marketplace
  if (req.method === 'POST' && pathname === '/api/marketplace/auth/signout') {
    try {
      const { signOut } = await import('../../marketplace/firebase-client.js');
      await signOut();
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: `Sign-out failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/marketplace/shared-workflows — browse shared workflows
  if (req.method === 'GET' && pathname === '/api/marketplace/shared-workflows') {
    try {
      const { browseWorkflows } = await import('../../marketplace/firebase-client.js');
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const category = url.searchParams.get('category') || undefined;
      const sortBy = (url.searchParams.get('sortBy') as 'downloadCount' | 'publishedAt' | 'rating') || undefined;
      const maxResults = parseInt(url.searchParams.get('limit') || '50', 10);
      const workflows = await browseWorkflows({ category, sortBy, maxResults });
      sendJson(res, 200, { workflows });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to browse workflows: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/marketplace/publish — upload workflow + model to cloud
  if (req.method === 'POST' && pathname === '/api/marketplace/publish') {
    try {
      const body = await readBody(req);
      if (!body?.workflowPath || !body?.metadata) {
        sendJson(res, 400, { error: 'Missing workflowPath or metadata' });
        return true;
      }
      const { publishWorkflow } = await import('../../marketplace/firebase-client.js');
      const workflow = await loadWorkflow(body.workflowPath);
      const result = await publishWorkflow(workflow, body.metadata, body.existingWorkflowId);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { error: `Publish failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/marketplace/download — download + install a shared workflow
  if (req.method === 'POST' && pathname === '/api/marketplace/download') {
    try {
      const body = await readBody(req);
      if (!body?.workflowId) {
        sendJson(res, 400, { error: 'Missing workflowId' });
        return true;
      }
      const { downloadSharedWorkflow } = await import('../../marketplace/firebase-client.js');
      const result = await downloadSharedWorkflow(body.workflowId, body.version);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { error: `Download failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // GET /api/marketplace/updates — check for updates to installed shared workflows
  if (req.method === 'GET' && pathname === '/api/marketplace/updates') {
    try {
      const { checkForUpdates: checkWorkflowUpdates } = await import('../../marketplace/firebase-client.js');
      const updates = await checkWorkflowUpdates();
      sendJson(res, 200, { updates });
    } catch (err) {
      sendJson(res, 500, { error: `Update check failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  // POST /api/marketplace/update — update an installed shared workflow
  if (req.method === 'POST' && pathname === '/api/marketplace/update') {
    try {
      const body = await readBody(req);
      if (!body?.workflowId) {
        sendJson(res, 400, { error: 'Missing workflowId' });
        return true;
      }
      const { downloadSharedWorkflow } = await import('../../marketplace/firebase-client.js');
      const result = await downloadSharedWorkflow(body.workflowId, body.version);
      sendJson(res, result.success ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { error: `Update failed: ${err instanceof Error ? err.message : err}` });
    }
    return true;
  }

  return false;
};
