/**
 * Dashboard Route: MCP
 *
 * Handles /api/mcp/* endpoints.
 * MCP (Model Context Protocol) server management and chat provider configuration.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { debugLog } from '../../debug-log.js';

export const handleMcpRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // Only handle /api/mcp/* routes
  if (!pathname.startsWith('/api/mcp')) return false;

  // GET /api/mcp/servers — list all known servers with status
  if (req.method === 'GET' && pathname === '/api/mcp/servers') {
    try {
      const { knownServers } = await import('../../mcp-registry.js');
      const { loadAllMcpConfig } = await import('../../mcp-config.js');

      const configs = loadAllMcpConfig();
      const configMap = new Map(configs.map(c => [c.name, c]));

      const servers = await Promise.all(knownServers.map(async (known: any) => {
        const config = configMap.get(known.name);
        const isEnabled = config ? config.enabled !== false : false;

        let status = 'disconnected';
        let toolCount = 0;
        let toolNames: string[] = [];
        let failureReason: string | undefined;

        if (isEnabled && ctx.chatMcpManager) {
          const connStatus = ctx.chatMcpManager.getConnectionStatus(known.name);
          status = connStatus;
          if (connStatus === 'connected') {
            const summaries = ctx.chatMcpManager.getConnectionSummaries();
            const summary = summaries.find((s: any) => s.name === known.name);
            if (summary) {
              toolCount = summary.toolCount;
              toolNames = summary.toolNames;
            }
          } else if (connStatus === 'failed') {
            failureReason = ctx.chatMcpManager.getFailureReason(known.name);
          }
        }

        // Check availability
        let availability;
        try {
          availability = await known.checkAvailable();
        } catch { /* ignore */ }

        return {
          name: known.name,
          displayName: known.displayName,
          description: known.description,
          category: known.category,
          enabled: isEnabled,
          status,
          toolCount,
          toolNames,
          failureReason,
          availability,
          setupGuide: known.setupGuide,
        };
      }));

      sendJson(res, 200, { servers });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/mcp/servers/:name/enable
  const mcpEnableMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/enable$/);
  if (req.method === 'POST' && mcpEnableMatch) {
    const name = decodeURIComponent(mcpEnableMatch[1]);
    try {
      const { getKnownServer } = await import('../../mcp-registry.js');
      const { loadAllMcpConfig, saveMcpConfig } = await import('../../mcp-config.js');

      const known = getKnownServer(name);
      if (!known) {
        sendJson(res, 404, { error: `Unknown server: ${name}` });
        return true;
      }

      // Check availability
      const check = await known.checkAvailable();
      if (!check.available) {
        sendJson(res, 400, {
          error: `Not ready: ${check.missing.join(', ')}`,
          missing: check.missing,
        });
        return true;
      }

      // Update config
      const configs = loadAllMcpConfig();
      const existing = configs.find((c: any) => c.name === name);
      if (existing) {
        existing.enabled = true;
        existing.command = known.command;
        existing.args = known.args;
      } else {
        configs.push({
          name: known.name,
          command: known.command,
          args: known.args,
          enabled: true,
        });
      }
      saveMcpConfig(configs);

      // Connect if manager is available
      if (ctx.chatMcpManager) {
        try {
          await ctx.chatMcpManager.connectOne({
            name: known.name,
            command: known.command,
            args: known.args,
          });
          const summaries = ctx.chatMcpManager.getConnectionSummaries();
          const summary = summaries.find((s: any) => s.name === name);
          sendJson(res, 200, {
            success: true,
            message: `${known.displayName} enabled and connected (${summary?.toolCount || 0} tools)`,
          });
        } catch (connErr: any) {
          sendJson(res, 200, {
            success: true,
            message: `${known.displayName} enabled but connection failed: ${connErr.message}`,
            warning: connErr.message,
          });
        }
      } else {
        sendJson(res, 200, {
          success: true,
          message: `${known.displayName} enabled. It will connect when the agent starts.`,
        });
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/mcp/servers/:name/disable
  const mcpDisableMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/disable$/);
  if (req.method === 'POST' && mcpDisableMatch) {
    const name = decodeURIComponent(mcpDisableMatch[1]);
    try {
      const { loadAllMcpConfig, saveMcpConfig } = await import('../../mcp-config.js');
      const { getKnownServer } = await import('../../mcp-registry.js');

      // Disconnect if connected
      if (ctx.chatMcpManager) {
        await ctx.chatMcpManager.disconnectOne(name);
      }

      // Update config
      const configs = loadAllMcpConfig();
      const existing = configs.find((c: any) => c.name === name);
      if (existing) {
        existing.enabled = false;
        saveMcpConfig(configs);
      }

      const known = getKnownServer(name);
      const displayName = known?.displayName || name;
      sendJson(res, 200, { success: true, message: `${displayName} disabled.` });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/mcp/servers/:name/reconnect
  const mcpReconnectMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/reconnect$/);
  if (req.method === 'POST' && mcpReconnectMatch) {
    const name = decodeURIComponent(mcpReconnectMatch[1]);
    try {
      const { loadAllMcpConfig } = await import('../../mcp-config.js');
      const { getKnownServer } = await import('../../mcp-registry.js');

      if (!ctx.chatMcpManager) {
        sendJson(res, 400, { error: 'Agent not started yet.' });
        return true;
      }

      const configs = loadAllMcpConfig();
      const config = configs.find((c: any) => c.name === name && c.enabled !== false);
      if (!config) {
        const known = getKnownServer(name);
        sendJson(res, 400, {
          error: `${known?.displayName || name} is not enabled. Enable it first.`,
        });
        return true;
      }

      await ctx.chatMcpManager.connectOne(config);
      const summaries = ctx.chatMcpManager.getConnectionSummaries();
      const summary = summaries.find((s: any) => s.name === name);
      sendJson(res, 200, {
        success: true,
        message: `Reconnected (${summary?.toolCount || 0} tools)`,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to reconnect: ${err.message}` });
    }
    return true;
  }

  // ── Chat Provider Config API ───────────────────────────────

  // GET /api/mcp/chat-provider — get current provider/model selection
  if (req.method === 'GET' && pathname === '/api/mcp/chat-provider') {
    try {
      const chatConfigPath = join(homedir(), '.woodbury', 'chat-config.json');
      let provider = 'auto';
      let model = '';
      try {
        const raw = await readFile(chatConfigPath, 'utf-8');
        const chatConfig = JSON.parse(raw);
        if (chatConfig.provider) provider = chatConfig.provider;
        if (chatConfig.model) model = chatConfig.model;
      } catch { /* no saved config */ }

      // Detect available providers from env
      const available: Array<{ id: string; name: string; hasKey: boolean; defaultModel: string }> = [
        { id: 'anthropic', name: 'Anthropic (Claude)', hasKey: !!process.env.ANTHROPIC_API_KEY, defaultModel: 'claude-sonnet-4-5-20250514' },
        { id: 'openai', name: 'OpenAI (GPT)', hasKey: !!(process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY), defaultModel: 'gpt-4o' },
        { id: 'groq', name: 'Groq (Llama)', hasKey: !!(process.env.GROQ_API_KEY || process.env.GROK_API_KEY), defaultModel: 'llama-3.1-70b-versatile' },
      ];

      sendJson(res, 200, { provider, model, available });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // PUT /api/mcp/chat-provider — set provider/model selection
  if (req.method === 'PUT' && pathname === '/api/mcp/chat-provider') {
    try {
      const body = await readBody(req);
      const chatConfigPath = join(homedir(), '.woodbury', 'chat-config.json');
      const dir = join(homedir(), '.woodbury');

      // Ensure dir exists
      try { await mkdir(dir, { recursive: true }); } catch { /* ok */ }

      const newConfig: any = {};
      if (body.provider && body.provider !== 'auto') {
        newConfig.provider = body.provider;
      }
      if (body.model) {
        newConfig.model = body.model;
      }

      await writeFile(chatConfigPath, JSON.stringify(newConfig, null, 2) + '\n', 'utf-8');

      // Force agent recreation on next chat message
      if (ctx.chatAgent) {
        try { await ctx.chatAgent.stop(); } catch { /* ignore */ }
        ctx.chatAgent = null;
      }
      for (const agent of ctx.chatAgents.values()) {
        try { await agent.stop(); } catch { /* ignore */ }
      }
      ctx.chatAgents.clear();

      debugLog.info('dashboard', 'Chat provider updated', newConfig);
      sendJson(res, 200, { success: true, message: 'Provider updated. Next message will use the new setting.' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
