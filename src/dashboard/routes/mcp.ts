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

  // GET /api/env-keys — return masked status of known API keys
  if (req.method === 'GET' && pathname === '/api/env-keys') {
    const envPath = join(homedir(), '.woodbury', '.env');
    const KNOWN_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'];
    const result: Record<string, { set: boolean; masked: string }> = {};
    for (const key of KNOWN_KEYS) {
      const val = process.env[key] || '';
      result[key] = {
        set: val.length > 0,
        masked: val.length > 8 ? val.slice(0, 4) + '••••' + val.slice(-4) : val.length > 0 ? '••••••••' : '',
      };
    }
    sendJson(res, 200, { keys: result, envPath });
    return true;
  }

  // PUT /api/env-keys — write API keys to ~/.woodbury/.env and hot-update process.env
  if (req.method === 'PUT' && pathname === '/api/env-keys') {
    try {
      const body = await readBody(req);
      const ALLOWED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'];
      const envPath = join(homedir(), '.woodbury', '.env');
      const dir = join(homedir(), '.woodbury');

      await mkdir(dir, { recursive: true });

      const existingKeys: Record<string, string> = {};
      try {
        const raw = await readFile(envPath, 'utf-8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            existingKeys[k] = v;
          }
        }
      } catch { /* no existing file */ }

      for (const key of ALLOWED) {
        if (body[key] === undefined) continue;
        const val = String(body[key]).trim();
        if (val) {
          existingKeys[key] = val;
          process.env[key] = val;
        } else {
          delete existingKeys[key];
          delete process.env[key];
        }
      }

      const lines = Object.entries(existingKeys).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      await writeFile(envPath, lines.join('\n') + '\n', 'utf-8');

      debugLog.info('dashboard', 'API keys updated');
      sendJson(res, 200, { saved: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/elevenlabs/voices — list all ElevenLabs voices with preview URLs
  if (req.method === 'GET' && pathname === '/api/elevenlabs/voices') {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      sendJson(res, 400, { error: 'ELEVENLABS_API_KEY not set. Configure it in Model → API Keys.' });
      return true;
    }
    try {
      const search = url.searchParams.get('search') || '';
      const category = url.searchParams.get('category') || '';
      const params = new URLSearchParams();
      params.set('page_size', '100');
      params.set('include_total_count', 'true');
      if (search) params.set('search', search);
      if (category) params.set('category', category);

      const apiRes = await fetch(`https://api.elevenlabs.io/v2/voices?${params}`, {
        headers: { 'xi-api-key': apiKey },
      });

      if (!apiRes.ok) {
        // Fall back to v1 if v2 needs higher permissions
        const v1Res = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': apiKey },
        });
        if (!v1Res.ok) {
          const errText = await v1Res.text();
          sendJson(res, v1Res.status, { error: `ElevenLabs API error: ${errText}` });
          return true;
        }
        const v1Data = await v1Res.json() as { voices?: Array<Record<string, unknown>> };
        sendJson(res, 200, { voices: v1Data.voices || [], total: (v1Data.voices || []).length });
        return true;
      }

      const data = await apiRes.json() as { voices?: Array<Record<string, unknown>>; total_count?: number };
      sendJson(res, 200, { voices: data.voices || [], total: data.total_count || (data.voices || []).length });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // PUT /api/elevenlabs/default-voice — set default voice in ~/.woodbury/.env
  if (req.method === 'PUT' && pathname === '/api/elevenlabs/default-voice') {
    try {
      const body = await readBody(req);
      const voiceId = body.voice_id;
      if (!voiceId) { sendJson(res, 400, { error: 'voice_id required' }); return true; }

      const envPath = join(homedir(), '.woodbury', '.env');
      const existingKeys: Record<string, string> = {};
      try {
        const raw = await readFile(envPath, 'utf-8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            existingKeys[k] = v;
          }
        }
      } catch { /* no file */ }

      existingKeys['ELEVENLABS_DEFAULT_VOICE'] = voiceId;
      process.env.ELEVENLABS_DEFAULT_VOICE = voiceId;

      const lines = Object.entries(existingKeys).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      await writeFile(envPath, lines.join('\n') + '\n', 'utf-8');

      sendJson(res, 200, { saved: true, voice_id: voiceId });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // Only handle /api/mcp/* routes from here on
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
      let temperature = 0.7;
      try {
        const raw = await readFile(chatConfigPath, 'utf-8');
        const chatConfig = JSON.parse(raw);
        if (chatConfig.provider) provider = chatConfig.provider;
        if (chatConfig.model) model = chatConfig.model;
        if (typeof chatConfig.temperature === 'number') temperature = chatConfig.temperature;
      } catch { /* no saved config */ }

      // Detect available providers from env
      const available: Array<{ id: string; name: string; hasKey: boolean; defaultModel: string }> = [
        { id: 'anthropic', name: 'Anthropic (Claude)', hasKey: !!process.env.ANTHROPIC_API_KEY, defaultModel: 'claude-sonnet-4-5-20250514' },
        { id: 'openai', name: 'OpenAI (GPT)', hasKey: !!(process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY), defaultModel: 'gpt-4o' },
        { id: 'groq', name: 'Groq (Llama)', hasKey: !!(process.env.GROQ_API_KEY || process.env.GROK_API_KEY), defaultModel: 'llama-3.1-70b-versatile' },
      ];

      sendJson(res, 200, { provider, model, temperature, available });
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

      // Read existing config so partial updates don't erase other fields
      let existingConfig: any = {};
      try {
        const raw = await readFile(chatConfigPath, 'utf-8');
        existingConfig = JSON.parse(raw);
      } catch { /* no existing config */ }

      const newConfig: any = { ...existingConfig };
      if (body.provider !== undefined) {
        if (body.provider && body.provider !== 'auto') {
          newConfig.provider = body.provider;
        } else {
          delete newConfig.provider;
        }
      }
      if (body.model !== undefined) {
        if (body.model) {
          newConfig.model = body.model;
        } else {
          delete newConfig.model;
        }
      }
      if (typeof body.temperature === 'number') {
        newConfig.temperature = Math.max(0, Math.min(2, body.temperature));
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

  // GET /api/models/available — fetch live model lists from all configured providers
  if (req.method === 'GET' && pathname === '/api/models/available') {
    const results: Record<string, { id: string; name: string; provider: string }[]> = {};

    const fetchAnthropicModels = async () => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return [];
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: key });
        const resp = await client.models.list({ limit: 100 });
        return (resp.data || []).map((m: any) => ({
          id: m.id,
          name: m.display_name || m.id,
          provider: 'anthropic',
        }));
      } catch { return []; }
    };

    const fetchOpenAIModels = async () => {
      const key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY;
      if (!key) return [];
      try {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey: key });
        const resp = await client.models.list();
        const chatPrefixes = ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o3', 'o4'];
        const excluded = ['-embedding', '-tts', '-whisper', '-dall-e', '-search', '-realtime'];
        return (resp.data || [])
          .filter((m: any) => {
            if (excluded.some(x => m.id.includes(x))) return false;
            if (m.id.includes(':')) return false; // fine-tuned
            return chatPrefixes.some(p => m.id.startsWith(p));
          })
          .sort((a: any, b: any) => b.created - a.created)
          .map((m: any) => ({ id: m.id, name: m.id, provider: 'openai' }));
      } catch { return []; }
    };

    const fetchGroqModels = async () => {
      const key = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
      if (!key) return [];
      try {
        const { default: Groq } = await import('groq-sdk');
        const client = new Groq({ apiKey: key });
        const resp = await client.models.list();
        const excluded = ['whisper', 'tts', 'guard', 'vision'];
        return (resp.data || [])
          .filter((m: any) => {
            if (!m.active && m.active !== undefined) return false;
            return !excluded.some(x => m.id.toLowerCase().includes(x));
          })
          .sort((a: any, b: any) => a.id.localeCompare(b.id))
          .map((m: any) => ({ id: m.id, name: m.id, provider: 'groq' }));
      } catch { return []; }
    };

    const [anthropic, openai, groq] = await Promise.all([
      fetchAnthropicModels(),
      fetchOpenAIModels(),
      fetchGroqModels(),
    ]);

    results.anthropic = anthropic;
    results.openai = openai;
    results.groq = groq;

    const all = [...anthropic, ...openai, ...groq];
    sendJson(res, 200, { models: all, byProvider: results });
    return true;
  }

  return false;
};
