/**
 * Dashboard Route: Tools
 *
 * Handles /api/tools and /api/script-tool-docs endpoints.
 * Provides tool listing with schemas and custom documentation management.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler, ScriptToolDoc } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import type { ToolDefinition } from '../../loop/types.js';

// ── Constants ────────────────────────────────────────────────
const SCRIPT_TOOL_DOCS_PATH = join(homedir(), '.woodbury', 'data', 'script-tool-docs.json');

// ── Local helpers ────────────────────────────────────────────

async function loadScriptToolDocs(): Promise<ScriptToolDoc[]> {
  try {
    const content = await readFile(SCRIPT_TOOL_DOCS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch { return []; }
}

async function saveScriptToolDocs(docs: ScriptToolDoc[]): Promise<void> {
  await mkdir(join(homedir(), '.woodbury', 'data'), { recursive: true });
  await writeFile(SCRIPT_TOOL_DOCS_PATH, JSON.stringify(docs, null, 2));
}

function formatToolSignature(def: ToolDefinition): string {
  const props = def.parameters?.properties;
  if (!props || typeof props !== 'object') {
    return `context.tools.${def.name}(params)`;
  }
  const required: string[] = def.parameters?.required || [];
  const parts: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const p = prop as any;
    const optional = !required.includes(name) ? '?' : '';
    let type: string = p.type || 'any';
    if (p.enum) {
      if (p.enum.length <= 4) {
        type = p.enum.map((v: string) => `"${v}"`).join('|');
      } else {
        type = p.enum.slice(0, 3).map((v: string) => `"${v}"`).join('|') + '|...';
      }
    }
    parts.push(`${name}${optional}: ${type}`);
  }
  return `context.tools.${def.name}({ ${parts.join(', ')} })`;
}

// ── Route handler ────────────────────────────────────────────

export const handleToolsRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // GET /api/script-tool-docs — list all tool docs (auto-generated + custom overrides)
  if (req.method === 'GET' && pathname === '/api/script-tool-docs') {
    try {
      const tools = ctx.extensionManager?.getAllTools() ?? [];
      const customDocs = await loadScriptToolDocs();
      const customMap = new Map(customDocs.map(d => [d.toolName, d]));

      const result = tools.map(tool => {
        const def = tool.definition;
        const custom = customMap.get(def.name);
        return {
          name: def.name,
          description: def.description,
          signature: formatToolSignature(def),
          parameters: def.parameters?.properties || {},
          dangerous: def.dangerous || false,
          customDescription: custom?.customDescription || null,
          examples: custom?.examples || [],
          notes: custom?.notes || null,
          returns: custom?.returns || null,
          enabled: custom?.enabled ?? true,
        };
      });

      sendJson(res, 200, { tools: result });
    } catch (err) {
      sendJson(res, 500, { error: String((err as Error).message) });
    }
    return true;
  }

  // PUT /api/script-tool-docs — bulk save custom docs for all tools
  if (req.method === 'PUT' && pathname === '/api/script-tool-docs') {
    try {
      const body = await readBody(req);
      const docs: ScriptToolDoc[] = (body.tools || []).map((t: any) => ({
        toolName: t.toolName || t.name,
        customDescription: t.customDescription || undefined,
        examples: t.examples || [],
        notes: t.notes || undefined,
        returns: t.returns || undefined,
        enabled: t.enabled ?? true,
      }));
      await saveScriptToolDocs(docs);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String((err as Error).message) });
    }
    return true;
  }

  // GET /api/tools — list available extension tools with their schemas
  if (req.method === 'GET' && pathname === '/api/tools') {
    // Wait for extensions to load (whenReady has built-in 30s safeguard)
    await ctx.extensionManager?.whenReady();
    const tools = ctx.extensionManager?.getAllTools() ?? [];
    const result = tools.map(t => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
      dangerous: t.definition.dangerous || false,
    }));
    sendJson(res, 200, { tools: result });
    return true;
  }

  return false;
};
