/**
 * LLM Proxy Routes
 *
 * Global endpoints for managing the LLM proxy service.
 * These are NOT pipeline-specific — they work from the main Settings tab.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { startLlmProxy } from '../server.js';
import { resolveOllamaBaseUrl } from '../../loop/ollama-discovery.js';

/**
 * Probe for Ollama availability — honors OLLAMA_BASE_URL or mDNS discovery.
 * When reachable, returns the baseURL and the list of installed model tags.
 * Short timeout so startup UX isn't held up when Ollama isn't present.
 */
async function probeOllama(): Promise<{ baseURL: string; models: string[] } | null> {
  let baseURL: string | undefined;
  try {
    baseURL = await Promise.race([
      resolveOllamaBaseUrl(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3500)),
    ]);
  } catch {
    return null;
  }
  if (!baseURL) return null;

  const tagsUrl = baseURL.replace(/\/v1\/?$/, '') + '/api/tags';
  try {
    const resp = await fetch(tagsUrl, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return { baseURL, models: [] };
    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
    return { baseURL, models };
  } catch {
    return { baseURL, models: [] };
  }
}

export const handleLlmProxyRoutes: RouteHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _url: URL,
  ctx: DashboardContext,
): Promise<boolean> => {

  // GET /api/llm-proxy/status
  if (pathname === '/api/llm-proxy/status') {
    const proxy = ctx.llmProxy;
    const status: any = {
      running: !!proxy,
      port: proxy?.port || 8642,
      enabled: process.env.LLM_PROXY_ENABLED !== 'false',
      baseURL: process.env.LLM_BASE_URL || null,
    };

    // Get stats from running proxy
    if (proxy) {
      try {
        const resp = await fetch(`http://localhost:${proxy.port}/stats`);
        if (resp.ok) status.stats = await resp.json();
      } catch {}
      try {
        const resp = await fetch(`http://localhost:${proxy.port}/health`);
        if (resp.ok) status.health = await resp.json();
      } catch {}
    }

    // Probe Ollama (env var or mDNS). Keep timeout short so the endpoint stays snappy.
    const ollama = await probeOllama();

    // Detect available backends — API-key-based ones plus Ollama if reachable
    status.availableBackends = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
      ollama: !!ollama,
    };
    if (ollama) {
      status.ollama = { baseURL: ollama.baseURL, models: ollama.models };
    }

    // Read current model selection
    try {
      const configPath = join(homedir(), '.woodbury', 'config', 'chat-config.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8'));
      status.selectedModel = config.pipelineModel || config.model || null;
    } catch {
      status.selectedModel = null;
    }

    sendJson(res, 200, status);
    return true;
  }

  // POST /api/llm-proxy/toggle
  if (req.method === 'POST' && pathname === '/api/llm-proxy/toggle') {
    const body = await readBody(req);
    const enable = body.enabled !== false;
    process.env.LLM_PROXY_ENABLED = enable ? 'true' : 'false';

    if (enable && !ctx.llmProxy) {
      startLlmProxy(ctx);
    } else if (!enable && ctx.llmProxy) {
      try {
        ctx.llmProxy.process.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { try { ctx.llmProxy?.process.kill('SIGKILL'); } catch {} resolve(); }, 3000);
          ctx.llmProxy?.process.once('close', () => { clearTimeout(timeout); resolve(); });
        });
      } catch {}
      ctx.llmProxy = null;
      delete process.env.LLM_BASE_URL;
    }

    sendJson(res, 200, { success: true, running: !!ctx.llmProxy, enabled: enable });
    return true;
  }

  // POST /api/llm-proxy/model
  if (req.method === 'POST' && pathname === '/api/llm-proxy/model') {
    const body = await readBody(req);
    const model = body.model;
    if (!model || typeof model !== 'string') {
      sendJson(res, 400, { error: 'model required' });
      return true;
    }

    try {
      // Derive provider from model id. Order matters: ollama/ wins first
      // so that tags like `ollama/llama3:8b` don't get routed to Groq.
      let provider = 'anthropic';
      if (model.startsWith('ollama/')) provider = 'ollama';
      else if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')) provider = 'openai';
      else if (model.startsWith('claude-')) provider = 'anthropic';
      else if (model.startsWith('llama') || model.startsWith('mixtral')) provider = 'groq';

      // Write to BOTH canonical locations so both UI (/.woodbury/config/chat-config.json
      // via /api/llm-proxy/status) and the chat agent (~/.woodbury/chat-config.json in
      // chat.ts) see the same selection.
      const canonicalPaths = [
        join(homedir(), '.woodbury', 'config', 'chat-config.json'),
        join(homedir(), '.woodbury', 'chat-config.json'),
      ];
      for (const configPath of canonicalPaths) {
        await mkdir(join(configPath, '..'), { recursive: true });
        let config: any = {};
        try { config = JSON.parse(await readFile(configPath, 'utf-8')); } catch {}
        config.provider = provider;
        config.model = model;
        config.pipelineModel = model;
        await writeFile(configPath, JSON.stringify(config, null, 2));
      }
      sendJson(res, 200, { success: true, model, provider });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
};
