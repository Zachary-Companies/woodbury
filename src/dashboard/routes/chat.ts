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
import type { CompositionDocument } from '../../workflow/types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { recallMemories, saveMemory, formatMemoriesForPrompt } from '../../file-memory-store.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { debugLog } from '../../debug-log.js';
import { discoverCompositions, readScriptFileCode } from '../../workflow/loader.js';
import { readPipelineTodo } from '../pipeline-sync.js';
import { loadBindings, loadRules, loadViews } from '../pipeline-bindings.js';
import { resolveCompositionInterface } from '../composition-interface.js';
import {
  validateComposition,
  getAvailableWorkflowIds,
} from '../../loop/v3/closure-engine.js';

// ────────────────────────────────────────────────────────────────
//  API Contracts
// ────────────────────────────────────────────────────────────────

/** JSON shape returned by GET /api/chat/composition-context/:id */
interface CompositionContextSummary {
  compositionId: string;
  name: string;
  description: string;
  nodeCount: number;
  nodes: Array<{ id: string; label: string; type: string }>;
  lastRunStatus: 'completed' | 'failed' | null;
  lastRunError: { nodeId: string; nodeLabel: string; error: string } | null;
  projectNotes: string;
}

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

/**
 * Auto-save memories from a chat interaction.
 *
 * Analyzes the user message, agent response, and tool calls to extract
 * durable knowledge worth remembering:
 * - Error fixes → error_pattern
 * - Tool sequences that worked → procedure
 * - File edits → discovery
 * - User corrections/preferences → preference
 */
async function autoSaveMemories(
  userMessage: string,
  agentResponse: string,
  toolCalls: ChatToolLog[],
  project?: string,
): Promise<void> {
  const toolNames = toolCalls.map(t => t.name);
  const hasEdits = toolNames.some(t => t === 'Edit' || t === 'Write' || t.includes('edit') || t.includes('write'));
  const hasErrors = toolCalls.some(t => !t.success);
  const msg = userMessage.toLowerCase();

  // Don't save trivial interactions
  if (toolCalls.length === 0) return;
  if (agentResponse.length < 100) return;

  // Pattern: user reported a bug/error and agent fixed it
  if (hasErrors || msg.includes('error') || msg.includes('bug') || msg.includes('fix') || msg.includes('broken') || msg.includes("doesn't work") || msg.includes('not working')) {
    if (hasEdits) {
      // Extract what was fixed
      const editTools = toolCalls.filter(t => t.name === 'Edit' || t.name === 'Write');
      const filesEdited = editTools.map(t => {
        const path = t.params?.file_path as string || '';
        return path.split('/').slice(-2).join('/');
      }).filter(Boolean);

      if (filesEdited.length > 0) {
        const summary = `Fixed issue: "${userMessage.slice(0, 120)}". ` +
          `Files edited: ${filesEdited.join(', ')}. ` +
          `Resolution: ${agentResponse.slice(0, 200)}`;
        await saveMemory(summary, 'error_pattern', {
          tags: filesEdited,
          source: 'chat',
          project,
          importance: 0.7,
        });
      }
    }
  }

  // Pattern: multi-step procedure (3+ tool calls that succeeded)
  if (toolCalls.length >= 3 && !hasErrors) {
    const uniqueTools = [...new Set(toolNames)];
    if (uniqueTools.length >= 2) {
      const summary = `Procedure for "${userMessage.slice(0, 100)}": ` +
        `Used ${uniqueTools.join(' → ')} (${toolCalls.length} steps). ` +
        `Outcome: ${agentResponse.slice(0, 150)}`;
      await saveMemory(summary, 'procedure', {
        tags: uniqueTools,
        source: 'chat',
        project,
        importance: 0.6,
      });
    }
  }

  // Pattern: user explicitly stating a preference
  if (msg.includes('i want') || msg.includes('i prefer') || msg.includes('always') || msg.includes('never') || msg.includes('should be') || msg.includes('make sure')) {
    await saveMemory(
      `User preference: "${userMessage.slice(0, 300)}"`,
      'preference',
      {
        tags: ['user-stated'],
        source: 'chat',
        project,
        importance: 0.8,
      },
    );
  }

  // Pattern: discovery about the codebase (agent read files and explained)
  const readTools = toolCalls.filter(t => t.name === 'Read' || t.name === 'Grep' || t.name === 'Glob');
  if (readTools.length >= 2 && agentResponse.length > 300) {
    const filesRead = readTools.map(t => {
      const path = (t.params?.file_path || t.params?.path || t.params?.pattern || '') as string;
      return path.split('/').slice(-2).join('/');
    }).filter(Boolean);

    if (filesRead.length > 0 && (msg.includes('how') || msg.includes('where') || msg.includes('what') || msg.includes('explain'))) {
      const summary = `Discovery: "${userMessage.slice(0, 100)}". ` +
        `Key files: ${filesRead.slice(0, 5).join(', ')}. ` +
        `Finding: ${agentResponse.slice(0, 200)}`;
      await saveMemory(summary, 'discovery', {
        tags: filesRead.slice(0, 5),
        source: 'chat',
        project,
        importance: 0.5,
      });
    }
  }
}

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

  // Load saved provider/model/temperature preference
  let savedProvider: string | undefined;
  let savedModel: string | undefined;
  let savedTemperature: number | undefined;
  try {
    const chatConfigPath = join(homedir(), '.woodbury', 'chat-config.json');
    const raw = await readFile(chatConfigPath, 'utf-8');
    const chatConfig = JSON.parse(raw);
    if (chatConfig.provider) savedProvider = chatConfig.provider;
    if (chatConfig.model) savedModel = chatConfig.model;
    if (typeof chatConfig.temperature === 'number') savedTemperature = chatConfig.temperature;
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
    temperature: savedTemperature,
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
 * Build a composition context section for the system prompt.
 * Loads the active pipeline's docs, interface, nodes, and last run status.
 */
async function buildCompositionContext(ctx: DashboardContext, compositionId: string): Promise<string> {
  try {
    const discovered = await discoverCompositions(ctx.workDir);
    const entry = discovered.find(d => d.composition.id === compositionId);
    if (!entry) return `\n\nThe user is currently viewing pipeline "${compositionId}" in the graph panel.`;
    const comp = entry.composition;

    const isV2 = entry.isV2Pipeline === true;
    const pipelineDir = entry.pipelineDir || '';

    const sections: string[] = [];
    sections.push(`\n\n## Active Pipeline: "${comp.name}"`);
    if (isV2) sections.push('**Format: v2 file-backed pipeline** — each script node is a real TypeScript file on disk.');
    if (isV2 && pipelineDir) sections.push(`Pipeline directory: ${pipelineDir}`);
    if (comp.description) sections.push(comp.description);

    // Load pipeline's own CLAUDE.md documentation (the pipeline's instruction manual)
    if (isV2 && pipelineDir) {
      try {
        const claudeMd = await readFile(join(pipelineDir, 'CLAUDE.md'), 'utf-8');
        if (claudeMd.trim()) {
          sections.push('\n### Pipeline Documentation (CLAUDE.md)');
          // Include up to 4000 chars — this is the pipeline's own instructions
          sections.push(claudeMd.length > 4000 ? claudeMd.slice(0, 4000) + '\n... (truncated)' : claudeMd);
        }
      } catch { /* no CLAUDE.md, that's fine */ }
    }

    // Pipeline documentation summary
    const docs = comp.metadata?.generatedPipelineDocs;
    if (docs && docs.length > 0) {
      const latestDoc = docs[docs.length - 1];
      const summary = latestDoc.summary || latestDoc.markdown?.slice(0, 500) || '';
      if (summary) sections.push(`\n### What it does\n${summary.slice(0, 500)}`);
    }

    // Interface contracts
    try {
      const iface = await resolveCompositionInterface(ctx.workDir, comp);
      if (iface.inputs.length > 0) {
        sections.push('\n### Inputs');
        for (const inp of iface.inputs.slice(0, 10)) {
          sections.push(`- ${inp.label || inp.name} (${inp.type}): ${inp.description || 'no description'}`);
        }
      }
      if (iface.outputs.length > 0) {
        sections.push('\n### Outputs');
        for (const out of iface.outputs.slice(0, 10)) {
          sections.push(`- ${out.name} (${(out as any).type || 'any'}): ${(out as any).description || ''}`);
        }
      }
    } catch { /* interface resolution is best-effort */ }

    // Node list
    if (comp.nodes.length > 0) {
      sections.push(`\n### Nodes (${comp.nodes.length} steps)`);
      for (let i = 0; i < comp.nodes.length && i < 15; i++) {
        const n = comp.nodes[i] as any;
        const typeLabel = n.workflowId === '__script_file__' ? 'Script File' :
          n.workflowId === '__script__' ? 'Script' :
          n.workflowId === '__text__' ? 'Text' :
          n.workflowId === '__output__' ? 'Output' :
          n.workflowId === '__branch__' ? 'Branch' :
          n.workflowId === '__for_each__' ? 'Loop' :
          n.workflowId.replace(/^__/, '').replace(/__$/, '');
        const desc = n.scriptFile?.description ? ` — ${n.scriptFile.description.slice(0, 80)}` :
          n.script?.description ? ` — ${n.script.description.slice(0, 80)}` : '';
        const fileInfo = n.scriptFile?.file ? ` [${n.scriptFile.file}]` : '';
        sections.push(`${i + 1}. ${n.label || n.id} (${typeLabel})${fileInfo}${desc}`);
      }
    }

    // v2: Include file contents for script file nodes (so the agent can see what to edit)
    if (isV2 && pipelineDir) {
      const scriptFileNodes = comp.nodes.filter((n: any) => n.workflowId === '__script_file__' && n.scriptFile?.file);
      if (scriptFileNodes.length > 0) {
        sections.push('\n### Script File Contents');
        for (const n of scriptFileNodes.slice(0, 10) as any[]) {
          try {
            const code = await readScriptFileCode(pipelineDir, n.scriptFile);
            const truncated = code.length > 1500 ? code.slice(0, 1500) + '\n// ... truncated' : code;
            sections.push(`\n#### ${n.label || n.id} — \`${n.scriptFile.file}\`\n\`\`\`typescript\n${truncated}\n\`\`\``);
          } catch {
            sections.push(`\n#### ${n.label || n.id} — \`${n.scriptFile.file}\` (file not found)`);
          }
        }
      }
    }

    // v2: Include TODO.json so the agent knows what tasks remain
    if (isV2 && pipelineDir) {
      const todo = await readPipelineTodo(pipelineDir);
      if (todo && todo.items.length > 0) {
        sections.push('\n### TODO.json — Task Tracker');
        sections.push('Read and update this file to track your progress. Path: `' + pipelineDir + '/TODO.json`');
        const pending = todo.items.filter(i => i.status === 'pending' || i.status === 'in-progress');
        const failed = todo.items.filter(i => i.status === 'failed');
        const done = todo.items.filter(i => i.status === 'done');
        if (failed.length > 0) {
          sections.push(`\n**Failed (${failed.length}):**`);
          for (const item of failed) {
            sections.push(`- ❌ ${item.task}${item.error ? ` — ${item.error}` : ''}${item.node ? ` (${item.node})` : ''}`);
          }
        }
        if (pending.length > 0) {
          sections.push(`\n**Pending (${pending.length}):**`);
          for (const item of pending) {
            const prefix = item.status === 'in-progress' ? '🔄' : '☐';
            sections.push(`- ${prefix} ${item.task}${item.node ? ` (${item.node})` : ''}${item.blockedBy?.length ? ` [blocked by: ${item.blockedBy.join(', ')}]` : ''}`);
          }
        }
        if (done.length > 0) {
          sections.push(`\n**Done (${done.length}):** ${done.map(i => i.task).join(', ')}`);
        }
        sections.push('\nWhen you start a task, update its status in TODO.json. Add new items as you discover work.');
      }
    }

    // v2: Include action configs — pipeline-owned behavior definitions
    if (isV2 && pipelineDir) {
      try {
        const actionsDir = join(pipelineDir, 'actions');
        let actionFiles: string[] = [];
        try { actionFiles = (await readdir(actionsDir)).filter(f => f.endsWith('.json')); } catch { /* no actions dir */ }

        if (actionFiles.length > 0) {
          sections.push('\n### Action Configs (Pipeline-Owned Behavior)');
          sections.push(`Actions directory: \`${pipelineDir}/actions/\``);
          sections.push('These files control how UI buttons behave. Edit them to change behavior.');
          for (const af of actionFiles) {
            try {
              const raw = await readFile(join(actionsDir, af), 'utf-8');
              const config = JSON.parse(raw);
              sections.push(`\n**${af}** — ${config.label || config.id || af}`);
              if (config.description) sections.push(`  ${config.description}`);
              if (config.referenceResolution) {
                const refs = config.referenceResolution;
                for (const [key, val] of Object.entries(refs)) {
                  const v = val as any;
                  sections.push(`  - ${key}: strategy="${v.strategy}", fallback="${v.fallback || 'default'}"`);
                }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* actions loading is best-effort */ }
    }

    // v2: Include bindings context — custom data connections between entities
    if (isV2 && pipelineDir) {
      try {
        const bindingsDoc = await loadBindings(pipelineDir);
        const rulesDoc = await loadRules(pipelineDir);
        const viewsDoc = await loadViews(pipelineDir);

        sections.push('\n### Bindings (Custom Data Connections)');
        sections.push(`Bindings directory: \`${pipelineDir}/bindings/\``);
        sections.push('Bindings define semantic relationships between entities in pipeline node outputs.');
        sections.push('For example: "shot X depicts characters A, B" or "dialogue Y is spoken by character Z".');

        if (bindingsDoc.bindings.length > 0) {
          sections.push(`\n**Active bindings (${bindingsDoc.bindings.length}):**`);
          // Group by type for readability
          const byType: Record<string, typeof bindingsDoc.bindings> = {};
          for (const b of bindingsDoc.bindings) {
            if (!byType[b.type]) byType[b.type] = [];
            byType[b.type].push(b);
          }
          for (const [type, bindings] of Object.entries(byType)) {
            sections.push(`- **${type}** (${bindings.length}): ${bindings.slice(0, 5).map(b =>
              `${b.source.entityType}:${b.source.entityId} → ${b.target.entityType}:${b.target.entityId}`
            ).join(', ')}${bindings.length > 5 ? ` ... +${bindings.length - 5} more` : ''}`);
          }
        } else {
          sections.push('\n**No bindings defined yet.** The pipeline will fall back to generic entity resolution.');
          sections.push('You should create bindings to define which characters appear in each shot,');
          sections.push('which location each scene is set in, and which character speaks each dialogue line.');
        }

        if (rulesDoc.rules.length > 0) {
          sections.push(`\n**Auto-binding rules (${rulesDoc.rules.length}):**`);
          for (const r of rulesDoc.rules.slice(0, 5)) {
            sections.push(`- ${r.enabled ? '✅' : '❌'} "${r.name}" (${r.type}): ${r.source.entityType}.${r.source.field} → ${r.target.entityType}.${r.target.matchField} [${r.relationship}]`);
          }
        }

        if (viewsDoc.views.length > 0) {
          sections.push(`\n**Custom views (${viewsDoc.views.length}):**`);
          for (const v of viewsDoc.views) {
            sections.push(`- ${v.icon || '📄'} "${v.label}" (${v.type})`);
          }
        }

        sections.push('\n**How to manage bindings:**');
        sections.push('- Edit `bindings/bindings.json` directly with `file_write`');
        sections.push('- Or use the API: `POST /api/compositions/' + compositionId + '/bindings` to create bindings');
        sections.push('- Binding types: `depicts` (character in shot), `set-in` (shot in location), `voice` (dialogue speaker), or custom');
        sections.push('- Each binding has: `{ id, type, source: { entityType, entityId }, target: { entityType, entityId }, confidence, origin }`');
        sections.push('- Auto-binding rules in `bindings/rules.json` can automatically populate bindings by text-matching entity names in descriptions');
        sections.push('- Apply rules: `POST /api/compositions/' + compositionId + '/bindings/apply-rules` with sourceEntities and targetEntities arrays');
        sections.push('- Custom views in `bindings/views.json` define how the app mode renders pipeline data (e.g., screenplay NLE view)');
      } catch {
        // bindings loading is best-effort
      }
    }

    // Last run status
    const run = ctx.activeCompRun;
    if (run && run.compositionId === compositionId) {
      if (run.done) {
        if (run.success) {
          sections.push('\n### Last Run\nStatus: Completed successfully');
        } else {
          sections.push('\n### Last Run\nStatus: Failed');
          if (run.nodeStates) {
            for (const [nid, ns] of Object.entries(run.nodeStates)) {
              const nsAny = ns as any;
              if (nsAny.status === 'failed' && nsAny.error) {
                sections.push(`Failed at "${nsAny.workflowName || nid}": ${String(nsAny.error).slice(0, 200)}`);
              }
            }
          }
        }
      } else {
        sections.push('\n### Current Run\nStatus: Running');
      }
    }

    // Project notes
    if (comp.metadata?.projectNotes) {
      sections.push(`\n### Project Notes\n${comp.metadata.projectNotes.slice(0, 600)}`);
    }

    // Pipeline health check — run lightweight validation
    try {
      const knownIds = getAvailableWorkflowIds(ctx.workDir);
      const issues = validateComposition(comp, knownIds);
      if (issues.length > 0) {
        sections.push('\n### ⚠️ Current Issues');
        for (const issue of issues.slice(0, 10)) {
          sections.push(`- ${issue}`);
        }
        sections.push('You can fix these by regenerating the affected nodes or rewiring edges.');
      }
    } catch { /* validation is best-effort */ }

    sections.push('\n### What you can do');
    sections.push('- Add new steps to this pipeline');
    sections.push('- Fix failing nodes');
    sections.push('- Edit existing nodes by referencing their name');
    sections.push('- Run the pipeline');
    if (isV2 && pipelineDir) {
      sections.push(`- Edit TypeScript files directly in ${pipelineDir}/src/`);
      sections.push('- Use file_read and file_write tools to modify .ts files in the pipeline src/ directory');
      sections.push('- After editing files, sync the graph: POST /api/compositions/:id/sync');
      sections.push('Each __script_file__ node maps to a .ts file in `src/`. Edit the file to change the node behavior.');
      sections.push('');
      sections.push('### Actions (Pipeline-Owned Behavior)');
      sections.push(`Action configs in \`${pipelineDir}/actions/\` control how UI buttons (Regen, Generate, etc.) behave.`);
      sections.push('Each action is a JSON file that the server reads at execution time. Edit them to change behavior.');
      sections.push('');
      sections.push('**`actions/generate-image.json`** — Controls the Regen/Generate Image button:');
      sections.push('- `referenceResolution.characters.strategy` — "binding-match" (use bindings) or "all" (use all characters)');
      sections.push('- `referenceResolution.characters.fallback` — "none" (no fallback) or uses previs.characterIds');
      sections.push('- `referenceResolution.characters.autoCreateBindings` — auto-run binding rules if no bindings exist');
      sections.push('- `referenceResolution.locations` — same pattern for location references');
      sections.push('- `referenceInstruction` — text prepended to the prompt when reference images are included');
      sections.push('- `prompt.sections` — ordered prompt template sections (references, scene, camera, lighting, style)');
      sections.push('- `frameSizeLensMap` / `cameraMovementMap` — maps frame sizes and movements to lens/technique descriptions');
      sections.push('- `generation.model` / `generation.aspectRatio` — defaults for the image generator');
      sections.push('');
      sections.push('When the user says things like "only use characters mentioned in the shot" or "change the style to anime",');
      sections.push('read the action config, modify the relevant fields, and write it back. The server reads it fresh each time.');
      sections.push('');
      sections.push('**How the Regen/Generate button works (full stack):**');
      sections.push('1. Client: `compositions-app.js` has `generatePrevisImage()` which calls `POST /api/app/:id/generate-previs`');
      sections.push('2. Server: `src/dashboard/routes/pipeline-app.ts` handles generate-previs:');
      sections.push('   - Reads `actions/generate-image.json` from the pipeline directory');
      sections.push('   - Resolves references per the config (binding-match strategy uses bindings, auto-runs rules if needed)');
      sections.push('   - Builds the prompt from config templates + shot/element data');
      sections.push('   - Calls nanobanana image generation with the prompt + reference images');
      sections.push('3. Bindings: `src/dashboard/pipeline-bindings.ts` has `applyRules()` / `matchValues()` for text matching');
      sections.push('4. Entity scan: `scanForEntities()` in pipeline-app.ts discovers entities from app state node outputs');
      sections.push('');
      sections.push('**To change how references are resolved:** edit `actions/generate-image.json` (referenceResolution)');
      sections.push('**To change which names match:** edit `bindings/rules.json` (matchField, matchOptions)');
      sections.push('**To change the prompt/style:** edit `actions/generate-image.json` (prompt.sections, referenceInstruction)');
      sections.push('**To change model/aspect ratio:** edit `actions/generate-image.json` (generation)');
      sections.push('**To change the server logic itself:** edit `src/dashboard/routes/pipeline-app.ts` (generate-previs endpoint)');
      sections.push('**To change the UI rendering:** edit `src/config-dashboard/compositions-app.js`');
      sections.push('');
      sections.push('### Bindings & Rules');
      sections.push('- `bindings/bindings.json` — semantic connections between entities (shot→character, shot→location)');
      sections.push('- `bindings/rules.json` — auto-detection rules (e.g., match character names in shot text → create depicts binding)');
      sections.push('- `bindings/views.json` — custom view configurations for app mode rendering');
      sections.push('- The generate-image action uses bindings to resolve which references to include per-shot');
      sections.push('- When the user asks about character/shot/location relationships, check and update bindings or rules');
      sections.push('');
      sections.push('### Testing (REQUIRED for v2 pipelines)');
      sections.push('- Every node file (e.g. `src/fetch-data.ts`) must have a test file (`src/fetch-data.test.ts`)');
      sections.push('- Tests use vitest: `import { describe, it, expect } from "vitest"`');
      sections.push('- Use `createMockContext()` from `./_test-helpers.ts` for mock context');
      sections.push(`- Run tests: \`cd ${pipelineDir} && npx vitest run\``);
      sections.push('- When you write or edit code, ALWAYS write/update the test, then run it to verify');
      sections.push('- If tests fail, fix the code and re-run until green');
    }
    sections.push('When they reference "this pipeline" or ask to modify it, they mean this one.');

    return sections.join('\n');
  } catch (err) {
    debugLog.warn('chat', 'Failed to build composition context', { compositionId, error: String(err) });
    return `\n\nThe user is currently viewing pipeline "${compositionId}" in the graph panel.`;
  }
}

/**
 * Build a JSON summary of a composition's context (for the frontend suggested prompts).
 */
async function getCompositionContextSummary(ctx: DashboardContext, compositionId: string): Promise<CompositionContextSummary | null> {
  const discovered = await discoverCompositions(ctx.workDir);
  const entry = discovered.find(d => d.composition.id === compositionId);
  if (!entry) return null;
  const comp = entry.composition;

  const nodes = comp.nodes.map(n => ({
    id: n.id,
    label: n.label || n.id,
    type: n.workflowId,
  }));

  let lastRunStatus: CompositionContextSummary['lastRunStatus'] = null;
  let lastRunError: CompositionContextSummary['lastRunError'] = null;

  const run = ctx.activeCompRun;
  if (run && run.compositionId === compositionId && run.done) {
    lastRunStatus = run.success ? 'completed' : 'failed';
    if (!run.success && run.nodeStates) {
      for (const [nid, ns] of Object.entries(run.nodeStates)) {
        const nsAny = ns as any;
        if (nsAny.status === 'failed' && nsAny.error) {
          lastRunError = {
            nodeId: nid,
            nodeLabel: nsAny.workflowName || nid,
            error: String(nsAny.error).slice(0, 200),
          };
          break;
        }
      }
    }
  }

  return {
    compositionId: comp.id,
    name: comp.name,
    description: comp.description || '',
    nodeCount: comp.nodes.length,
    nodes,
    lastRunStatus,
    lastRunError,
    projectNotes: comp.metadata?.projectNotes || '',
  };
}

/**
 * Build a chat-oriented system prompt (simplified for non-technical users).
 */
async function buildChatPrompt(ctx: DashboardContext, activeCompositionId?: string): Promise<string> {
  const extensionPrompts = ctx.extensionManager?.getAllPromptSections() || [];
  const extSection = extensionPrompts.length > 0
    ? '\n\n## Extension Instructions\n\n' + extensionPrompts.join('\n\n')
    : '';

  const activeCtx = activeCompositionId
    ? await buildCompositionContext(ctx, activeCompositionId)
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

## Task Tracking with TODO.json (MANDATORY for pipeline work)
Every v2 pipeline has a \`TODO.json\` in its directory. When working on a pipeline:
1. Read TODO.json first to see what needs doing
2. Update item status as you work: "pending" → "in-progress" → "done"
3. Add new items when you discover more work
4. If something fails, set status to "failed" with an error message
5. For code changes: always add "Write tests" and "Run tests" items
6. Do NOT declare success until all items are done
7. Use file_write to update TODO.json after each step
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

  // GET /api/chat/composition-context/:id — JSON summary for frontend suggested prompts
  const compCtxMatch = pathname.match(/^\/api\/chat\/composition-context\/([^/]+)$/);
  if (req.method === 'GET' && compCtxMatch) {
    try {
      const compositionId = decodeURIComponent(compCtxMatch[1]);
      const summary = await getCompositionContextSummary(ctx, compositionId);
      if (!summary) {
        sendJson(res, 404, { error: 'Composition not found' });
      } else {
        sendJson(res, 200, summary);
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
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

      // Build composition context for the active pipeline
      let compositionContext = '';
      if (activeCompositionId) {
        try {
          compositionContext = await buildCompositionContext(ctx, activeCompositionId);
        } catch (err) {
          debugLog.warn('chat', 'Failed to build composition context', { error: String(err) });
        }
      }

      // ── Auto-recall relevant memories ──
      let memoriesContext = '';
      try {
        const relevantMemories = await recallMemories(message, {
          project: activeCompositionId || undefined,
          limit: 6,
        });
        if (relevantMemories.length > 0) {
          memoriesContext = formatMemoriesForPrompt(relevantMemories);
          debugLog.info('chat', `Injected ${relevantMemories.length} relevant memories`);
        }
      } catch (err) {
        debugLog.warn('chat', 'Memory recall failed', { error: String(err) });
      }

      const messageWithContext = [
        compositionContext ? `<pipeline_context>${compositionContext}</pipeline_context>` : '',
        memoriesContext,
        message,
      ].filter(Boolean).join('\n\n');

      const prompt = buildCompressedPrompt({
        sessionSummary: rollingSummary,
        summaryTurnCount,
        recentTurns: compressedHistory.recentTurns,
        message: messageWithContext,
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
            // Handle v2 pipeline results (format: "v2", pipelineId, manifest)
            const compId = parsed?.pipelineId || parsed?.manifest?.id || parsed?.id || parsed?.composition?.id || activeCompositionId;
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

        // ── Auto-save memories from this interaction ──
        if (!runError && !wasAborted && responseContent.length > 50 && toolLogs.length > 0) {
          try {
            await autoSaveMemories(message, responseContent, toolLogs, activeCompositionId || undefined);
          } catch (err) {
            debugLog.warn('chat', 'Auto-save memories failed', { error: String(err) });
          }
        }
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
