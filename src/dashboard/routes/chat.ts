/**
 * Dashboard Route: Chat
 *
 * Handles /api/chat endpoints.
 *
 * Endpoints:
 *   GET    /api/chat/sessions      — list chat sessions
 *   GET    /api/chat/sessions/:id  — get session
 *   PUT    /api/chat/sessions/:id  — update session
 *   DELETE /api/chat/sessions/:id  — delete session
 *   GET    /api/chat/logs          — get chat log days
 *   GET    /api/chat/logs/:date    — get chat log entries for a day
 *   POST   /api/chat               — send message (SSE streaming)
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const CHAT_SESSIONS_DIR = join(homedir(), '.woodbury', 'data', 'chat-sessions');
const CHAT_LOGS_DIR = join(homedir(), '.woodbury', 'data', 'chat-logs');
const MAX_CHAT_LOG_DAYS = 30; // keep 30 days of logs
const CHAT_RECENT_TURNS = 6;
const CHAT_SUMMARY_MAX_CHARS = 2400;
const CHAT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
//  Chat log types
// ────────────────────────────────────────────────────────────────

interface ChatToolLog {
  name: string;
  params: any;
  result: string;       // first 500 chars
  success: boolean;
  durationMs: number;
  startedAt: string;
}

interface ChatLogEntry {
  id: string;
  sessionId?: string;
  timestamp: string;
  message: string;       // user message (first 2000 chars)
  historyLength: number;
  activeCompositionId?: string;
  toolCalls: ChatToolLog[];
  response: string;      // first 2000 chars
  durationMs: number;
  iterations?: number;
  error?: string;
  aborted?: boolean;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSessionRecord {
  id: string;
  title: string;
  history: ChatTurn[];
  activeCompositionId?: string | null;
  engineSessionId?: string;
  rollingSummary?: string;
  summaryTurnCount?: number;
  taskPanelState?: any;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────
//  Local helpers
// ────────────────────────────────────────────────────────────────

async function appendChatLog(entry: ChatLogEntry): Promise<void> {
  try {
    await mkdir(CHAT_LOGS_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = join(CHAT_LOGS_DIR, `${dateStr}.jsonl`);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(logFile, JSON.stringify(entry) + '\n');

    // Also emit to debugLog for correlation
    debugLog.info('chat', `Chat request completed`, {
      id: entry.id,
      message: entry.message.slice(0, 100),
      toolCount: entry.toolCalls.length,
      durationMs: entry.durationMs,
      error: entry.error,
    });

    // Rotate old log files (async, non-blocking)
    rotateChatLogs().catch(() => {});
  } catch {
    // Never let logging break the app
  }
}

async function rotateChatLogs(): Promise<void> {
  try {
    const files = await readdir(CHAT_LOGS_DIR);
    const logFiles = files
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first
    if (logFiles.length > MAX_CHAT_LOG_DAYS) {
      for (const f of logFiles.slice(MAX_CHAT_LOG_DAYS)) {
        await unlink(join(CHAT_LOGS_DIR, f)).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

function sanitizeChatSessionId(sessionId?: string): string {
  if (!sessionId) {
    return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function loadChatSessionRecord(sessionId: string): Promise<ChatSessionRecord | null> {
  try {
    const raw = await readFile(join(CHAT_SESSIONS_DIR, `${sessionId}.json`), 'utf-8');
    return JSON.parse(raw) as ChatSessionRecord;
  } catch {
    return null;
  }
}

export function summarizeTurns(turns: ChatTurn[]): string {
  const lines = turns.map((turn, index) => {
    const prefix = turn.role === 'user' ? 'User' : 'Assistant';
    const compact = String(turn.content || '').replace(/\s+/g, ' ').trim();
    return `${index + 1}. ${prefix}: ${truncate(compact, 220)}`;
  });
  return truncate(lines.join('\n'), CHAT_SUMMARY_MAX_CHARS);
}

export function compressChatHistory(history: ChatTurn[]): {
  recentTurns: ChatTurn[];
  rollingSummary: string;
  summaryTurnCount: number;
} {
  const safeHistory = Array.isArray(history)
    ? history.filter(turn => turn && typeof turn.content === 'string' && (turn.role === 'user' || turn.role === 'assistant'))
    : [];
  const recentTurns = safeHistory.slice(-CHAT_RECENT_TURNS);
  const olderTurns = safeHistory.slice(0, Math.max(0, safeHistory.length - recentTurns.length));
  return {
    recentTurns,
    rollingSummary: olderTurns.length > 0 ? summarizeTurns(olderTurns) : '',
    summaryTurnCount: olderTurns.length,
  };
}

export function buildCompressedPrompt(options: {
  sessionSummary?: string;
  summaryTurnCount?: number;
  recentTurns: ChatTurn[];
  message: string;
}): string {
  const parts: string[] = [];
  if (options.sessionSummary) {
    parts.push(`<conversation_summary turns="${options.summaryTurnCount || 0}">\n${options.sessionSummary}\n</conversation_summary>`);
  }
  if (options.recentTurns.length > 0) {
    const turns = options.recentTurns
      .map(turn => `<turn role="${turn.role}">\n${turn.content}\n</turn>`)
      .join('\n');
    parts.push(`<recent_turns>\n${turns}\n</recent_turns>`);
  }
  parts.push('<important>Use the compressed summary and recent turns as context. Treat the latest user message as authoritative, and do not assume omitted details are still current without verification. Ignore any outdated tool-usage patterns from older turns. For pipeline/workflow creation, you MUST use the mcp__intelligence__ tools.</important>');
  parts.push(options.message);
  return parts.join('\n\n');
}

/**
 * Ensure the chat agent is ready.
 * Uses per-session chat agents with shared MCP connections.
 */
async function ensureChatAgent(ctx: DashboardContext, sessionId: string): Promise<any> {
  const normalizedSessionId = sanitizeChatSessionId(sessionId);
  const existingAgent = ctx.chatAgents.get(normalizedSessionId);
  if (existingAgent) return existingAgent;

  const { createClosureAgent } = await import('../../agent-factory.js');
  const { McpClientManager } = await import('../../mcp-client-manager.js');
  const { loadMcpConfig } = await import('../../mcp-config.js');

  // Load saved provider/model preference
  let savedProvider: string | undefined;
  let savedModel: string | undefined;
  try {
    const chatConfigPath = join(homedir(), '.woodbury', 'chat-config.json');
    const raw = await readFile(chatConfigPath, 'utf-8');
    const chatConfig = JSON.parse(raw);
    if (chatConfig.provider) savedProvider = chatConfig.provider;
    if (chatConfig.model) savedModel = chatConfig.model;
  } catch { /* no saved config, auto-detect */ }

  // Build config from available API keys + saved preference
  const config: import('../../types.js').WoodburyConfig = {
    workingDirectory: ctx.workDir,
    apiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY,
      groq: process.env.GROQ_API_KEY || process.env.GROK_API_KEY,
    },
    provider: savedProvider as any,
    model: savedModel,
    stream: true,
    verbose: ctx.verbose,
    timeout: CHAT_AGENT_TIMEOUT_MS,
    sessionId: normalizedSessionId,
    continuationMode: 'resume',
  };

  // Connect to MCP servers (if configured). Reuse the shared manager across chat sessions.
  const mcpConfigs = loadMcpConfig();
  if (mcpConfigs.length > 0 && !ctx.chatMcpManager) {
    ctx.chatMcpManager = new McpClientManager();
    await ctx.chatMcpManager.connectAll(mcpConfigs);
  }

  const agent = await createClosureAgent(config, ctx.extensionManager, ctx.chatMcpManager || undefined);
  ctx.chatAgents.set(normalizedSessionId, agent);
  ctx.chatAgent = agent;
  debugLog.info('dashboard', 'Chat agent created', {
    provider: savedProvider || 'auto',
    sessionId: normalizedSessionId,
  });

  return agent;
}

/**
 * Build a chat-oriented system prompt (simplified for non-technical users).
 */
function buildChatPrompt(ctx: DashboardContext, activeCompositionId?: string): string {
  const extensionPrompts = ctx.extensionManager?.getAllPromptSections() || [];
  const extSection = extensionPrompts.length > 0
    ? '\n\n## Extension Instructions\n\n' + extensionPrompts.join('\n\n')
    : '';

  const activeCtx = activeCompositionId
    ? `\n\nThe user is currently viewing pipeline "${activeCompositionId}" in the graph panel. When they reference "this pipeline" or ask to modify it, they mean this one.`
    : '';

  return `You are Woodbury, a friendly AI assistant that helps content creators automate their work.

## What You Can Do
- Create and manage content (images, videos, voiceovers, hashtags)
- Save and organize assets (characters, logos, brand elements, any files)
- Build automated pipelines that run on a schedule
- Queue content for review before posting

## How To Behave
- Talk in plain, simple language — no technical jargon
- When the user references something ambiguous ("my character", "that video"), look it up first. If multiple matches exist, ask which one they mean.
- When building pipelines, explain each step in simple terms as you go
- After creating content, offer to save it as a reusable asset
- Show what you're doing — narrate your actions briefly

## Clarification
- If the user's request is ambiguous, ASK before assuming
- If multiple assets match a reference, list them and ask which one
- If a pipeline step could go multiple ways, explain the options simply
- Never silently pick a default when the user might have a preference

## Conversation History
When the user's message contains a <conversation_history> block, treat it as prior conversation context. Continue the conversation naturally.${activeCtx}${extSection}`;
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleChatRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {

  // GET /api/chat/sessions — list all saved sessions
  if (req.method === 'GET' && pathname === '/api/chat/sessions') {
    try {
      await mkdir(CHAT_SESSIONS_DIR, { recursive: true });
      const files = await readdir(CHAT_SESSIONS_DIR);
      const sessions: any[] = [];
      for (const f of files.filter(f => f.endsWith('.json')).sort().reverse()) {
        try {
          const raw = await readFile(join(CHAT_SESSIONS_DIR, f), 'utf-8');
          const session = JSON.parse(raw);
          sessions.push({
            id: session.id,
            title: session.title || 'Untitled',
            messageCount: (session.history || []).length,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });
        } catch { /* skip corrupted */ }
      }
      sendJson(res, 200, { sessions });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/chat/sessions/:id — load a specific session
  if (req.method === 'GET' && pathname.startsWith('/api/chat/sessions/')) {
    const sessionId = pathname.replace('/api/chat/sessions/', '');
    try {
      const raw = await readFile(join(CHAT_SESSIONS_DIR, `${sessionId}.json`), 'utf-8');
      sendJson(res, 200, JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendJson(res, 404, { error: 'Session not found' });
      } else {
        sendJson(res, 500, { error: String(err) });
      }
    }
    return true;
  }

  // PUT /api/chat/sessions/:id — save/update a session
  if (req.method === 'PUT' && pathname.startsWith('/api/chat/sessions/')) {
    const sessionId = pathname.replace('/api/chat/sessions/', '');
    try {
      await mkdir(CHAT_SESSIONS_DIR, { recursive: true });
      const body = await readBody(req);
      const compressed = compressChatHistory(body.history || []);
      const session = {
        id: sessionId,
        title: body.title || 'Untitled',
        history: body.history || [],
        activeCompositionId: body.activeCompositionId || null,
        engineSessionId: body.engineSessionId || sessionId,
        rollingSummary: compressed.rollingSummary,
        summaryTurnCount: compressed.summaryTurnCount,
        taskPanelState: body.taskPanelState || null,
        createdAt: body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(join(CHAT_SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(session, null, 2) + '\n', 'utf-8');
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // DELETE /api/chat/sessions/:id — delete a session
  if (req.method === 'DELETE' && pathname.startsWith('/api/chat/sessions/')) {
    const sessionId = pathname.replace('/api/chat/sessions/', '');
    try {
      await unlink(join(CHAT_SESSIONS_DIR, `${sessionId}.json`));
      const cachedAgent = ctx.chatAgents.get(sanitizeChatSessionId(sessionId));
      if (cachedAgent) {
        await cachedAgent.stop().catch(() => {});
        ctx.chatAgents.delete(sanitizeChatSessionId(sessionId));
        if (ctx.chatAgent === cachedAgent) {
          ctx.chatAgent = null;
        }
      }
      sendJson(res, 200, { success: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendJson(res, 200, { success: true }); // already gone
      } else {
        sendJson(res, 500, { error: String(err) });
      }
    }
    return true;
  }

  // GET /api/chat/logs — list available log days with entry counts
  if (req.method === 'GET' && pathname === '/api/chat/logs') {
    try {
      await mkdir(CHAT_LOGS_DIR, { recursive: true });
      const files = await readdir(CHAT_LOGS_DIR);
      const days = [];
      for (const f of files.filter(f => f.endsWith('.jsonl')).sort().reverse()) {
        const content = await readFile(join(CHAT_LOGS_DIR, f), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        days.push({
          date: f.replace('.jsonl', ''),
          entries: lines.length,
        });
      }
      sendJson(res, 200, { days });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/chat/logs/:date — get all entries for a specific day
  if (req.method === 'GET' && pathname.startsWith('/api/chat/logs/')) {
    const date = pathname.replace('/api/chat/logs/', '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD' });
      return true;
    }
    try {
      const logFile = join(CHAT_LOGS_DIR, `${date}.jsonl`);
      const content = await readFile(logFile, 'utf-8');
      const entries = content.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      sendJson(res, 200, { date, entries });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendJson(res, 200, { date, entries: [] });
      } else {
        sendJson(res, 500, { error: String(err) });
      }
    }
    return true;
  }

  // ── Chat Agent SSE Endpoint ──────────────────────────────
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (ctx.chatAgentBusy) {
      sendJson(res, 409, { error: 'A chat request is already in progress' });
      return true;
    }

    try {
      const body = await readBody(req);
      const {
        message,
        history,
        activeCompositionId: initialCompositionId,
        sessionId: requestedSessionId,
      } = body || {};
      let activeCompositionId = initialCompositionId;
      const sessionId = sanitizeChatSessionId(requestedSessionId);
      const existingSession = await loadChatSessionRecord(sessionId);
      const sourceHistory = existingSession?.history || (Array.isArray(history) ? history : []);
      const compressedHistory = compressChatHistory(sourceHistory);
      const rollingSummary = existingSession?.rollingSummary || compressedHistory.rollingSummary;
      const summaryTurnCount = existingSession?.summaryTurnCount || compressedHistory.summaryTurnCount;
      if (!activeCompositionId && existingSession?.activeCompositionId) {
        activeCompositionId = existingSession.activeCompositionId;
      }

      if (!message) {
        sendJson(res, 400, { error: 'message is required' });
        return true;
      }

      ctx.chatAgentBusy = true;
      ctx.chatAgentBusySessionId = sessionId;
      const requestStartTime = Date.now();
      const requestId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const toolLogs: ChatToolLog[] = [];
      let responseContent = '';

      debugLog.info('chat', `Request started`, {
        id: requestId,
        sessionId,
        messagePreview: message.slice(0, 100),
        historyLength: sourceHistory.length,
        activeCompositionId,
        summaryTurnCount,
      });

      // Ensure the chat agent is ready
      const agent = await ensureChatAgent(ctx, sessionId);
      ctx.chatAgent = agent;

      const prompt = buildCompressedPrompt({
        sessionSummary: rollingSummary,
        summaryTurnCount,
        recentTurns: compressedHistory.recentTurns,
        message,
      });

      // Set up SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const writeEvent = (type: string, data: any) => {
        try {
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch { /* connection may be closed */ }
      };

      writeEvent('session_context', {
        summary: rollingSummary,
        summaryTurnCount,
        recentTurnCount: compressedHistory.recentTurns.length,
      });

      // Track in-flight tool calls for timing
      const toolStartTimes = new Map<string, { startTime: number; startedAt: string; params: any }>();
      const summarizeTask = (task: any) => ({
        id: task?.id,
        title: task?.title || task?.description,
        description: task?.description,
        status: task?.status,
        retryCount: task?.retryCount,
        maxRetries: task?.maxRetries,
        riskLevel: task?.riskLevel,
      });

      // Wire up streaming callbacks
      agent.setOnToken((token: string) => {
        writeEvent('token', { token });
        responseContent += token;
      });
      agent.setOnToolStart((name: string, params: any) => {
        writeEvent('tool_start', { name, params });
        toolStartTimes.set(name, {
          startTime: Date.now(),
          startedAt: new Date().toISOString(),
          params,
        });
        debugLog.info('chat', `Tool started: ${name}`, {
          requestId,
          params: typeof params === 'string' ? params.slice(0, 500) : params,
        });
        // Emit composition_updated for pipeline tools
        if (name === 'pipeline_create' || name === 'pipeline_update') {
          // Will emit composition_updated on tool_end when we have the result
        }
      });
      agent.setOnToolEnd((name: string, success: boolean, result: any, duration: number) => {
        const startInfo = toolStartTimes.get(name);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        writeEvent('tool_end', {
          name,
          success,
          duration,
          params: startInfo?.params,
          result: resultStr.length > 2000 ? resultStr.slice(0, 2000) + '\u2026' : resultStr,
        });

        // Capture tool log entry
        toolLogs.push({
          name,
          params: startInfo?.params,
          result: truncate(resultStr, 500),
          success,
          durationMs: duration || (startInfo ? Date.now() - startInfo.startTime : 0),
          startedAt: startInfo?.startedAt || new Date().toISOString(),
        });
        toolStartTimes.delete(name);

        debugLog.info('chat', `Tool ended: ${name}`, {
          requestId,
          success,
          durationMs: duration,
          resultPreview: resultStr.slice(0, 200),
        });

        // If a pipeline/composition was created, notify the graph panel
        const isCompositionTool = name === 'pipeline_create' || name === 'pipeline_update' ||
          name === 'mcp__intelligence__generate_pipeline' ||
          name === 'mcp__intelligence__generate_workflow' ||
          name === 'mcp__intelligence__compose_tools';
        if (success && isCompositionTool) {
          try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            const compId = parsed?.id || parsed?.composition?.id || activeCompositionId;
            if (compId) {
              activeCompositionId = compId;
              writeEvent('composition_updated', { compositionId: compId });
            }
          } catch { /* ignore parse errors */ }
        }
      });
      agent.setOnPhaseChange?.((from: string, to: string) => {
        writeEvent('phase', { from, to });
      });
      agent.setOnTaskStart?.((task: any) => {
        writeEvent('task_start', summarizeTask(task));
      });
      agent.setOnTaskEnd?.((task: any, result: any) => {
        writeEvent('task_end', {
          task: summarizeTask(task),
          result: {
            success: !!result?.success,
            error: result?.error,
            durationMs: result?.durationMs,
            toolCallCount: result?.toolCallCount,
            output: truncate(String(result?.output || ''), 500),
          },
        });
        writeEvent('verification', {
          task: summarizeTask(task),
          status: result?.success ? 'passed' : 'failed',
          detail: result?.error || truncate(String(result?.output || ''), 200),
        });
      });
      agent.setOnBeliefUpdate?.((belief: any) => {
        writeEvent('belief_update', {
          id: belief?.id,
          claim: belief?.claim,
          confidence: belief?.confidence,
          status: belief?.status,
        });
      });
      agent.setOnReflection?.((reflection: any) => {
        writeEvent('reflection', {
          trigger: reflection?.trigger,
          summary: reflection?.summary || reflection?.assessment,
          confidence: reflection?.confidence,
        });
      });
      agent.setOnSkillSelected?.((selection: any) => {
        writeEvent('skill_selection', {
          name: selection?.skill?.name,
          description: selection?.skill?.description,
          whenToUse: selection?.skill?.whenToUse,
          promptGuidance: selection?.skill?.promptGuidance,
          reason: selection?.reason,
          matchedKeywords: selection?.matchedKeywords || [],
          allowedTools: selection?.allowedToolNames || [],
          previousSkillName: selection?.previousSkillName,
          previousSkillReason: selection?.previousSkillReason,
          handoffRationale: selection?.handoffRationale,
          taskId: selection?.taskId,
          taskTitle: selection?.taskTitle,
        });
      });
      agent.setOnRecovery?.((event: any) => {
        writeEvent('recovery', {
          taskId: event?.taskId,
          taskTitle: event?.taskTitle,
          strategyType: event?.strategyType,
          attempt: event?.attempt,
          currentSkill: event?.currentSkill,
          targetSkill: event?.targetSkill,
          reason: event?.reason,
        });
      });

      // Set up abort on client disconnect
      const abort = new AbortController();
      req.on('close', () => abort.abort());

      let wasAborted = false;
      let runError: string | undefined;
      let iterations: number | undefined;

      try {
        const result = await agent.run(prompt, abort.signal);
        responseContent = result.content || responseContent;
        iterations = result.metadata?.iterations;
        writeEvent('done', {
          content: result.content,
          toolCalls: result.toolCalls?.map((tc: any) => ({ name: tc.name, parameters: tc.parameters })),
          metadata: result.metadata,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          wasAborted = true;
        } else {
          runError = (err as Error).message;
          writeEvent('error', { error: (err as Error).message });
        }
      } finally {
        // Clear callbacks
        agent.setOnToken(undefined);
        agent.setOnToolStart(undefined);
        agent.setOnToolEnd(undefined);
        agent.setOnPhaseChange?.(undefined);
        agent.setOnTaskStart?.(undefined);
        agent.setOnTaskEnd?.(undefined);
        agent.setOnBeliefUpdate?.(undefined);
        agent.setOnReflection?.(undefined);
        agent.setOnSkillSelected?.(undefined);
        agent.setOnRecovery?.(undefined);
        ctx.chatAgentBusy = false;
        ctx.chatAgentBusySessionId = null;
        try { res.end(); } catch { /* already closed */ }

        // Write structured chat log
        const totalDuration = Date.now() - requestStartTime;
        appendChatLog({
          id: requestId,
          sessionId,
          timestamp: new Date().toISOString(),
          message: truncate(message, 2000),
          historyLength: sourceHistory.length,
          activeCompositionId,
          toolCalls: toolLogs,
          response: truncate(responseContent, 2000),
          durationMs: totalDuration,
          iterations,
          error: runError,
          aborted: wasAborted || undefined,
        });

        debugLog.info('chat', `Request completed`, {
          id: requestId,
          durationMs: totalDuration,
          toolCount: toolLogs.length,
          responseLength: responseContent.length,
          iterations,
          aborted: wasAborted,
          error: runError,
        });
      }
    } catch (err) {
      ctx.chatAgentBusy = false;
      ctx.chatAgentBusySessionId = null;
      debugLog.error('chat', 'Chat endpoint error', { error: String(err) });
      // If headers haven't been sent yet, send JSON error
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Chat failed: ${(err as Error).message}` });
      } else {
        try { res.end(); } catch { /* already closed */ }
      }
    }
    return true;
  }

  return false;
};
