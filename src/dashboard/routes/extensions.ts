/**
 * Dashboard Route: Extensions
 *
 * Handles /api/extensions endpoints.
 *
 * Endpoints:
 *   GET  /api/extensions              — list all extensions with env status
 *   GET  /api/extensions/:name/env    — get env var status for one extension
 *   PUT  /api/extensions/:name/env    — update env vars for one extension
 *   POST /api/extensions/:name/enable — enable extension
 *   POST /api/extensions/:name/disable — disable extension
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, maskValue, isValidEnvVarName } from '../utils.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  discoverExtensions,
  parseEnvFile,
  writeEnvFile,
  ExtensionRegistry,
  type ExtensionManifest,
} from '../../extension-loader.js';
import type { ExtensionManager } from '../../extension-manager.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Local helper: discover manifests (registry-first, filesystem fallback)
// ────────────────────────────────────────────────────────────────

/**
 * Get all extension manifests.
 * Uses the registry when an ExtensionManager is available (production path),
 * falls back to filesystem scan when no manager is passed (e.g., tests).
 */
async function getManifests(extensionManager?: ExtensionManager): Promise<ExtensionManifest[]> {
  // Prefer registry when available (production path)
  const entries = extensionManager?.registryInstance?.getAll();
  if (entries && entries.length > 0) {
    return entries.map(e => ExtensionRegistry.toManifest(e));
  }
  // Fallback to filesystem scan (used in tests & when no manager is passed)
  return discoverExtensions();
}

async function findManifest(name: string, extensionManager?: ExtensionManager): Promise<ExtensionManifest | undefined> {
  const manifests = await getManifests(extensionManager);
  return manifests.find(m => m.name === name);
}

// ────────────────────────────────────────────────────────────────
//  Local helper: getExtensionEnvStatus
// ────────────────────────────────────────────────────────────────

async function getExtensionEnvStatus(manifest: ExtensionManifest, extensionManager?: ExtensionManager) {
  // Read current .env
  let currentEnv: Record<string, string> = {};
  try {
    const content = await readFile(join(manifest.directory, '.env'), 'utf-8');
    currentEnv = parseEnvFile(content);
  } catch {
    // No .env file
  }

  // Build status for each declared var
  const vars = Object.entries(manifest.envDeclarations).map(([key, decl]) => ({
    name: key,
    description: decl.description,
    required: decl.required,
    type: decl.type || 'string',
    isSet: !!currentEnv[key],
    maskedValue: currentEnv[key] ? maskValue(currentEnv[key]) : null,
    // For path-type vars, also send the raw value (not secret data)
    ...(decl.type === 'path' && currentEnv[key] ? { rawValue: currentEnv[key] } : {}),
  }));

  // Include any extra vars in .env not declared in manifest
  const declaredKeys = new Set(Object.keys(manifest.envDeclarations));
  const extraVars = Object.entries(currentEnv)
    .filter(([key]) => !declaredKeys.has(key))
    .map(([key, value]) => ({
      name: key,
      description: '',
      required: false,
      isSet: true,
      maskedValue: maskValue(value),
    }));

  // Get web UI URLs from the running extension manager
  let webUIs: string[] = [];
  if (extensionManager) {
    const summaries = extensionManager.getExtensionSummaries();
    const summary = summaries.find(s => s.name === manifest.name);
    if (summary) {
      webUIs = summary.webUIs;
    }
  }

  // Check for external web app status (e.g., social-scheduler writes its own status file)
  try {
    const statusPath = join(manifest.directory, '.webui-status.json');
    const statusContent = await readFile(statusPath, 'utf-8');
    const status = JSON.parse(statusContent);
    if (status.url && !webUIs.includes(status.url)) {
      webUIs.push(status.url);
    }
  } catch {
    // No status file — that's fine
  }

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    source: manifest.source,
    directory: manifest.directory,
    vars: [...vars, ...extraVars],
    webUIs,
  };
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleExtensionRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { extensionManager } = ctx;

  // GET /api/extensions
  if (req.method === 'GET' && pathname === '/api/extensions') {
    try {
      const manifests = await getManifests(extensionManager);
      const extensions = await Promise.all(
        manifests.map(async (m) => {
          const status = await getExtensionEnvStatus(m, extensionManager);
          // Include enabled status from registry if available
          const entry = extensionManager?.registryInstance?.get(m.name);
          return { ...status, enabled: entry?.enabled ?? true };
        })
      );
      sendJson(res, 200, { extensions });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/extensions/:name/env
  const getEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
  if (req.method === 'GET' && getEnvMatch) {
    const name = decodeURIComponent(getEnvMatch[1]);
    try {
      const manifest = await findManifest(name, extensionManager);
      if (!manifest) {
        sendJson(res, 404, { error: `Extension "${name}" not found` });
        return true;
      }
      const status = await getExtensionEnvStatus(manifest, extensionManager);
      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // PUT /api/extensions/:name/env
  const putEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
  if (req.method === 'PUT' && putEnvMatch) {
    const name = decodeURIComponent(putEnvMatch[1]);
    try {
      const manifest = await findManifest(name, extensionManager);
      if (!manifest) {
        sendJson(res, 404, { error: `Extension "${name}" not found` });
        return true;
      }

      const body = await readBody(req);
      if (!body || typeof body.vars !== 'object') {
        sendJson(res, 400, {
          error: 'Request body must have a "vars" object',
        });
        return true;
      }

      // Validate var names
      for (const key of Object.keys(body.vars)) {
        if (!isValidEnvVarName(key)) {
          sendJson(res, 400, { error: `Invalid env var name: "${key}"` });
          return true;
        }
      }

      // Read existing .env to merge (preserve vars not in request)
      let existingEnv: Record<string, string> = {};
      const envFilePath = join(manifest.directory, '.env');
      try {
        const content = await readFile(envFilePath, 'utf-8');
        existingEnv = parseEnvFile(content);
      } catch {
        // No existing .env file
      }

      // Merge: new values override existing; empty string = delete
      const merged = { ...existingEnv };
      for (const [key, value] of Object.entries(
        body.vars as Record<string, string>
      )) {
        if (value === '' || value === null || value === undefined) {
          delete merged[key];
        } else {
          merged[key] = String(value);
        }
      }

      // Write back
      const envContent = writeEnvFile(merged);
      await writeFile(envFilePath, envContent, 'utf-8');
      debugLog.info('dashboard', `Updated env for "${name}"`, {
        keysSet: Object.keys(merged),
        envFile: envFilePath,
      });

      // Return updated status
      const status = await getExtensionEnvStatus(manifest, extensionManager);
      sendJson(res, 200, { success: true, ...status });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/extensions/:name/enable or /api/extensions/:name/disable
  const toggleMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/(enable|disable)$/);
  if (req.method === 'POST' && toggleMatch) {
    const toggleName = decodeURIComponent(toggleMatch[1]);
    const action = toggleMatch[2] as 'enable' | 'disable';
    if (!extensionManager) {
      sendJson(res, 503, { error: 'Extension manager not available' });
      return true;
    }
    try {
      const success = action === 'enable'
        ? await extensionManager.enable(toggleName)
        : await extensionManager.disable(toggleName);
      if (success) {
        sendJson(res, 200, { success: true, name: toggleName, enabled: action === 'enable' });
      } else {
        sendJson(res, 404, { error: `Extension "${toggleName}" not found` });
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
