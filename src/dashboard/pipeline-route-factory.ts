/**
 * Pipeline Route Factory
 *
 * Creates PipelineRouteSdk instances from DashboardContext.
 * Also handles dynamic loading and caching of pipeline route handlers.
 */

import { readFile, writeFile, mkdir, cp, stat, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext } from './types.js';
import type { PipelineRouteSdk, PipelineRouteHandler, PipelineRouteSetup } from './pipeline-route-sdk.js';
import { sendJson, readBody } from './utils.js';
import { debugLog } from '../debug-log.js';
import { discoverCompositions } from '../workflow/loader.js';
import {
  loadBindings as _loadBindings,
  saveBindings as _saveBindings,
  loadRules as _loadRules,
  saveRules as _saveRules,
  applyRules,
  getTargetIds,
  type RulesDocument,
} from './pipeline-bindings.js';

const APP_STATE_DIR = join(homedir(), '.woodbury', 'data', 'app-state');

// Cache loaded route handlers: pipelineDir -> handler
const routeHandlerCache = new Map<string, PipelineRouteHandler>();

// ────────────────────────────────────────────────────────────────
//  SDK Factory
// ────────────────────────────────────────────────────────────────

/**
 * Create a PipelineRouteSdk for a given pipeline + context.
 */
export function createPipelineRouteSdk(
  pipelineId: string,
  pipelineDir: string | null,
  ctx: DashboardContext,
): PipelineRouteSdk {

  async function resolveProjectFolder(): Promise<string> {
    const pfolder = ctx.projectState?.getProjectFolder(pipelineId);
    if (pfolder) return pfolder;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find(c => c.composition.id === pipelineId);
      if (entry) {
        const folder = entry.composition?.metadata?.projectFolder;
        if (folder && typeof folder === 'string') {
          await mkdir(folder, { recursive: true });
          return folder;
        }
        if (entry.pipelineDir) return entry.pipelineDir;
      }
    } catch { /* ignore */ }
    return join(APP_STATE_DIR, pipelineId);
  }

  async function ensureProject(): Promise<any | null> {
    let project = ctx.projectState.get(pipelineId);
    if (project) return project;
    try {
      const compositions = await discoverCompositions();
      const entry = compositions.find((c: any) => c.composition?.id === pipelineId);
      const pfolder = entry?.composition?.metadata?.projectFolder;
      if (pfolder) {
        return await ctx.projectState.load(pipelineId, entry?.composition?.name || pipelineId, pfolder);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function loadActionConfig(actionId: string): Promise<Record<string, any>> {
    if (!pipelineDir) return {};
    const configPath = join(pipelineDir, 'actions', `${actionId}.json`);
    try {
      const raw = await readFile(configPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // Auto-run rules (shared logic moved from pipeline-app.ts)
  async function autoRunRules(): Promise<{ added: number; replaced: number; totalBindings: number }> {
    if (!pipelineDir) return { added: 0, replaced: 0, totalBindings: 0 };

    const rulesDoc = await _loadRules(pipelineDir);
    if (rulesDoc.rules.length === 0) return { added: 0, replaced: 0, totalBindings: 0 };

    const sourceTypes = new Set(rulesDoc.rules.map((r: any) => r.source.entityType));
    const targetTypes = new Set(rulesDoc.rules.map((r: any) => r.target.entityType));

    const sourceEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];
    const targetEntities: Array<{ entityType: string; entityId: string; data: Record<string, any> }> = [];
    const seenSourceIds = new Set<string>();
    const seenTargetIds = new Set<string>();

    const project = ctx.projectState?.get(pipelineId);
    if (project) {
      const outputs = {
        characters: project.characters,
        locations: project.locations,
        elements: project.elements,
        scenes: project.scenes,
        previsualizations: project.previsualizations,
        assets: project.assets,
      };
      scanForEntities(outputs, sourceTypes, sourceEntities, seenSourceIds);
      scanForEntities(outputs, targetTypes, targetEntities, seenTargetIds);
    }

    const newBindings = applyRules(rulesDoc.rules, sourceEntities, targetEntities);

    const bindingsDoc = await _loadBindings(pipelineDir);
    const manualBindings = bindingsDoc.bindings.filter((b: any) => !b.origin.startsWith('auto:'));
    const existingKeys = new Set(
      manualBindings.map((b: any) => `${b.source.entityId}:${b.target.entityId}:${b.type}`)
    );

    const uniqueNew = [];
    for (const b of newBindings) {
      const key = `${b.source.entityId}:${b.target.entityId}:${b.type}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        uniqueNew.push(b);
      }
    }

    const oldAutoCount = bindingsDoc.bindings.filter((b: any) => b.origin.startsWith('auto:')).length;
    bindingsDoc.bindings = [...manualBindings, ...uniqueNew];
    bindingsDoc.pipelineId = pipelineId;
    await _saveBindings(pipelineDir, bindingsDoc);

    return {
      added: uniqueNew.length,
      replaced: oldAutoCount,
      totalBindings: bindingsDoc.bindings.length,
    };
  }

  const sdk: PipelineRouteSdk = {
    pipelineId,
    pipelineDir,

    // HTTP helpers
    sendJson,
    readBody,

    // Project data
    getProject: () => ctx.projectState.get(pipelineId),
    ensureProject,
    updateProject: (partial) => ctx.projectState.update(pipelineId, partial),
    markDirty: (slices) => ctx.projectState.markDirty(pipelineId, slices as any),
    flushProject: () => ctx.projectState.flush(pipelineId),
    getProjectFolder: resolveProjectFolder,
    isProjectLoaded: () => ctx.projectState.isLoaded(pipelineId),

    // Pipeline config
    loadActionConfig,

    // Image generation
    generateImage: async (params) => {
      try {
        const { nanobanana: nb } = await import('../loop/tools/nanobanana.js');
        const result = await nb({
          action: 'generate' as const,
          prompt: params.prompt,
          model: params.model || 'flash',
          aspectRatio: (params.aspectRatio || '16:9') as any,
          outputPath: params.outputPath,
          referenceImages: params.referenceImages,
        }, dirname(params.outputPath));
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        return {
          success: parsed.success !== false,
          filePath: parsed.filePath || parsed.imagePath || params.outputPath,
          error: parsed.error,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Extension tools
    callTool: async (toolName, params, workDir) => {
      await ctx.extensionManager?.whenReady();
      const tools = ctx.extensionManager?.getAllTools() ?? [];
      const tool = tools.find(t => t.definition.name === toolName);
      if (!tool) return null;
      const result = await tool.handler(params, { workingDirectory: workDir || process.cwd() } as any);
      return typeof result === 'string' ? JSON.parse(result) : result;
    },
    getTools: async () => {
      await ctx.extensionManager?.whenReady();
      const tools = ctx.extensionManager?.getAllTools() ?? [];
      return tools.map(t => ({ name: t.definition.name, handler: t.handler }));
    },

    // Bindings & rules
    loadBindings: async () => pipelineDir ? _loadBindings(pipelineDir) : { version: '1.0', pipelineId, bindings: [] },
    saveBindings: async (doc) => { if (pipelineDir) await _saveBindings(pipelineDir, doc); },
    loadRules: async () => pipelineDir ? _loadRules(pipelineDir) : { version: '1.0', pipelineId, rules: [] },
    saveRules: async (doc) => { if (pipelineDir) await _saveRules(pipelineDir, doc); },
    autoRunRules,

    // File system
    readFile: async (path) => readFile(path, 'utf-8'),
    writeFile: async (path, content) => { await writeFile(path, content, 'utf-8'); },
    mkdir: async (path) => { await mkdir(path, { recursive: true }); },
    fileExists: (path) => { try { return existsSync(path); } catch { return false; } },
    copyFile: async (src, dest) => { await cp(src, dest); },
    stat: async (path) => {
      const s = await stat(path);
      return { size: s.size, mtime: s.mtime };
    },

    // Process spawning
    exec: async (command, options) => {
      const result = execSync(command, {
        timeout: options?.timeout || 10000,
        cwd: options?.cwd,
        encoding: 'utf-8',
      });
      return { stdout: result, stderr: '' };
    },
    spawn: (command, args, options) => spawn(command, args, options),

    // Logging
    log: (level, tag, message, meta) => {
      if (level === 'error') debugLog.error(tag, message, meta);
      else debugLog.info(tag, message, meta);
    },

    // Composition discovery
    discoverCompositions: () => discoverCompositions(),

    // Utility
    join,
    basename,
    dirname,
  };

  return sdk;
}

// ────────────────────────────────────────────────────────────────
//  Dynamic route loading
// ────────────────────────────────────────────────────────────────

/**
 * Load and cache a pipeline's route handler.
 * Looks for `routes/index.js` in the pipeline directory.
 * Returns null if no routes file exists.
 */
export async function loadPipelineRoutes(
  pipelineId: string,
  pipelineDir: string,
  ctx: DashboardContext,
): Promise<PipelineRouteHandler | null> {
  // Check cache
  const cached = routeHandlerCache.get(pipelineDir);
  if (cached) return cached;

  // Look for routes/index.js
  const routesPath = join(pipelineDir, 'routes', 'index.js');
  if (!existsSync(routesPath)) return null;

  try {
    // Dynamic import the pipeline's route module
    const routeModule = await import(`file://${routesPath}`);
    const setup: PipelineRouteSetup = routeModule.default || routeModule.setupRoutes;

    if (typeof setup !== 'function') {
      debugLog.error('pipeline-routes', `Pipeline routes at ${routesPath} does not export a setup function`);
      return null;
    }

    // Create SDK and set up the handler
    const sdk = createPipelineRouteSdk(pipelineId, pipelineDir, ctx);
    const handler = setup(sdk);

    // Cache it
    routeHandlerCache.set(pipelineDir, handler);
    debugLog.info('pipeline-routes', `Loaded pipeline routes from ${routesPath}`);

    return handler;
  } catch (err) {
    debugLog.error('pipeline-routes', `Failed to load pipeline routes from ${routesPath}`, { error: String(err) });
    return null;
  }
}

/**
 * Clear the route handler cache (e.g., when a pipeline is updated).
 */
export function clearPipelineRouteCache(pipelineDir?: string) {
  if (pipelineDir) {
    routeHandlerCache.delete(pipelineDir);
  } else {
    routeHandlerCache.clear();
  }
}

// ────────────────────────────────────────────────────────────────
//  Entity scanner — extract typed entities from node outputs
// ────────────────────────────────────────────────────────────────

function scanForEntities(
  obj: any,
  targetTypes: Set<string>,
  results: Array<{ entityType: string; entityId: string; data: Record<string, any> }>,
  seenIds: Set<string>,
) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') {
      for (const item of val) {
        const itemType: string = (
          item.type || key.replace(/s$/, '') || key
        ).toLowerCase();
        if (!targetTypes.has(itemType)) continue;
        const itemId = item.id || item.libraryId || item.assetId || item.slug;
        if (!itemId || seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        results.push({ entityType: itemType, entityId: itemId, data: item });
      }
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      scanForEntities(val, targetTypes, results, seenIds);
    }
  }
}
