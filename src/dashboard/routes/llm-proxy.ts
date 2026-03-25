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

    // Detect available API keys
    status.availableBackends = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
    };

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

    const configDir = join(homedir(), '.woodbury', 'config');
    try {
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, 'chat-config.json');
      let config: any = {};
      try { config = JSON.parse(await readFile(configPath, 'utf-8')); } catch {}

      let provider = 'anthropic';
      if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')) provider = 'openai';
      else if (model.startsWith('llama') || model.startsWith('mixtral')) provider = 'groq';

      config.provider = provider;
      config.model = model;
      config.pipelineModel = model;
      await writeFile(configPath, JSON.stringify(config, null, 2));
      sendJson(res, 200, { success: true, model, provider });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
};
