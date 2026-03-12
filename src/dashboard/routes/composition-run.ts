/**
 * Dashboard Route: Composition Run
 *
 * Handles composition/pipeline execution endpoints:
 *   POST /api/compositions/:id/run    — execute a composition
 *   GET  /api/compositions/run/status — poll execution progress
 *   POST /api/compositions/run/cancel — abort running composition
 *
 * Contains the full composition execution engine including topological sorting,
 * node execution, retry logic, conditional branching, approval gates,
 * variable passing, and idempotency caching.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import {
  discoverWorkflows,
  discoverCompositions,
} from '../../workflow/loader.js';
import type {
  WorkflowDocument,
  Expectation,
  RunRecord,
  NodeRunResult,
  PendingApproval,
  ApprovalGateConfig,
} from '../../workflow/types.js';
import { checkExpectations } from '../../workflow/executor.js';
import { bridgeServer, ensureBridgeServer } from '../../bridge-server.js';
import { debugLog } from '../../debug-log.js';
import type { ToolDefinition } from '../../loop/types.js';
import {
  buildScriptAutoFixGraphContext,
  summarizeAutoFixValue,
} from '../script-autofix-context.js';
import { proposeScriptNodeEdgeRepairs } from '../script-edge-repair.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 500;
const SCRIPT_TOOL_DOCS_PATH = join(homedir(), '.woodbury', 'data', 'script-tool-docs.json');

let runsCache: RunRecord[] | null = null;

// ────────────────────────────────────────────────────────────────
//  Run record helpers
// ────────────────────────────────────────────────────────────────

async function loadRuns(): Promise<RunRecord[]> {
  if (runsCache !== null) return runsCache;
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const content = await readFile(RUNS_FILE, 'utf-8');
    runsCache = JSON.parse(content) as RunRecord[];
  } catch {
    runsCache = [];
  }
  return runsCache;
}

async function saveRuns(runs: RunRecord[]): Promise<void> {
  if (runs.length > MAX_RUNS) {
    runs = runs.slice(runs.length - MAX_RUNS);
  }
  runsCache = runs;
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(RUNS_FILE, JSON.stringify(runs, null, 2));
}

function generateRunId(): string {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

async function createRunRecord(record: RunRecord): Promise<void> {
  const runs = await loadRuns();
  runs.push(record);
  await saveRuns(runs);
}

async function updateRunRecord(id: string, updates: Partial<RunRecord>): Promise<void> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.id === id);
  if (idx >= 0) {
    Object.assign(runs[idx], updates);
    await saveRuns(runs);
  }
}

function extractOutputFiles(variables: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const val of Object.values(variables)) {
    if (typeof val === 'string' && (val.startsWith('/') || val.startsWith('~'))) {
      files.push(val);
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('~'))) {
          files.push(item);
        }
      }
    }
  }
  return files;
}

// ────────────────────────────────────────────────────────────────
//  Idempotency cache helpers
// ────────────────────────────────────────────────────────────────

function idempotencyStableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(idempotencyStableStringify).join(',') + ']';
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + sorted.map(k =>
    JSON.stringify(k) + ':' + idempotencyStableStringify((obj as Record<string, unknown>)[k])
  ).join(',') + '}';
}

function computeIdempotencyHash(
  compId: string, nodeId: string, node: any,
  inputs: Record<string, unknown>
): string {
  const { createHash } = require('crypto');
  const nodeConfig = node.script || node.toolNode || node.fileReadNode ||
    node.fileWriteNode || node.fileOp || node.asset || node.jsonKeysNode || {};
  const payload = idempotencyStableStringify({
    c: compId, n: nodeId, w: node.workflowId,
    i: inputs, cfg: nodeConfig
  });
  return createHash('sha256').update(payload).digest('hex');
}

async function loadIdempotencyCache(
  compId: string, hash: string
): Promise<Record<string, unknown> | null> {
  const dir = join(homedir(), '.woodbury', 'cache', 'idempotency', compId);
  try {
    const raw = await readFile(join(dir, hash + '.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.output ?? null;
  } catch { return null; }
}

async function saveIdempotencyCache(
  compId: string, hash: string,
  output: Record<string, unknown>
): Promise<void> {
  const dir = join(homedir(), '.woodbury', 'cache', 'idempotency', compId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, hash + '.json'),
    JSON.stringify({ hash, output, cachedAt: new Date().toISOString() }),
    'utf-8'
  );
}

// ────────────────────────────────────────────────────────────────
//  Composition execution helpers
// ────────────────────────────────────────────────────────────────

function topoSort(
  nodes: Array<{ id: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>
): string[] {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n.id, []); inDeg.set(n.id, 0); }
  for (const e of edges) {
    adj.get(e.sourceNodeId)?.push(e.targetNodeId);
    inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) || 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDeg) { if (deg === 0) queue.push(id); }
  const result: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    result.push(nodeId);
    for (const neighbor of (adj.get(nodeId) || [])) {
      const newDeg = (inDeg.get(neighbor) || 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (result.length !== nodes.length) {
    throw new Error('These workflows form a loop and can\'t run in order. Check your connections.');
  }
  return result;
}

function gatherInputVariables(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>,
  nodeOutputs: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const edge of edges) {
    if (edge.targetNodeId !== nodeId) continue;
    const upstreamOutputs = nodeOutputs[edge.sourceNodeId];
    if (upstreamOutputs && edge.sourcePort in upstreamOutputs) {
      inputs[edge.targetPort] = upstreamOutputs[edge.sourcePort];
    }
  }
  return inputs;
}

function getInputValueByPortName(
  inputs: Record<string, unknown>,
  portName: string,
): unknown {
  if (portName in inputs) return inputs[portName];

  const normalizedPort = String(portName || '').trim().toLowerCase();
  if (!normalizedPort) return undefined;

  const matches = Object.keys(inputs).filter((key) => String(key).trim().toLowerCase() === normalizedPort);
  if (matches.length === 1) {
    return inputs[matches[0]];
  }
  return undefined;
}

function getDownstreamNodes(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>
): Set<string> {
  const downstream = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (e.sourceNodeId === current && !downstream.has(e.targetNodeId)) {
        downstream.add(e.targetNodeId);
        queue.push(e.targetNodeId);
      }
    }
  }
  return downstream;
}

/**
 * Classify whether an error is likely a code bug (fixable by LLM) vs external/infrastructure.
 */
function isCodeBug(err: any): boolean {
  if (err instanceof SyntaxError) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof ReferenceError) return true;
  if (err instanceof RangeError) return true;

  const msg = String(err?.message || '').toLowerCase();
  const externalPatterns = [
    'econnrefused', 'econnreset', 'etimedout', 'enotfound',
    'fetch failed', 'network error', 'socket hang up',
    'rate limit', 'too many requests', '429',
    '500', '502', '503', '504',
    'api key', 'unauthorized', '401', '403',
    'timeout', 'aborted', 'enospc', 'eperm', 'eacces',
  ];
  for (const pat of externalPatterns) {
    if (msg.includes(pat)) return false;
  }
  return true;
}

/**
 * Find nodes reachable EXCLUSIVELY through a specific output port.
 * Used by Branch/Switch to skip only nodes that are downstream of the inactive port
 * without skipping nodes that are also reachable from active ports (convergent paths).
 */
function getNodesExclusivelyDownstreamOfPort(
  nodeId: string,
  portName: string,
  edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>
): Set<string> {
  // Set A: BFS from nodeId following only edges from portName, then all edges from subsequent nodes
  const fromPort = new Set<string>();
  const qA: string[] = [nodeId];
  while (qA.length > 0) {
    const cur = qA.shift()!;
    for (const e of edges) {
      if (cur === nodeId && e.sourceNodeId === cur && e.sourcePort !== portName) continue;
      if (e.sourceNodeId === cur && !fromPort.has(e.targetNodeId)) {
        fromPort.add(e.targetNodeId);
        qA.push(e.targetNodeId);
      }
    }
  }

  // Set B: BFS from nodeId following edges from ALL OTHER ports, then all edges from subsequent nodes
  const fromOther = new Set<string>();
  const qB: string[] = [nodeId];
  while (qB.length > 0) {
    const cur = qB.shift()!;
    for (const e of edges) {
      if (cur === nodeId && e.sourceNodeId === cur && e.sourcePort === portName) continue;
      if (e.sourceNodeId === cur && !fromOther.has(e.targetNodeId)) {
        fromOther.add(e.targetNodeId);
        qB.push(e.targetNodeId);
      }
    }
  }

  // A \ B — nodes reachable ONLY through the specified port
  const exclusive = new Set<string>();
  for (const id of fromPort) {
    if (!fromOther.has(id)) exclusive.add(id);
  }
  return exclusive;
}

// ────────────────────────────────────────────────────────────────
//  Script tool documentation helpers
// ────────────────────────────────────────────────────────────────

interface ScriptToolDoc {
  toolName: string;
  customDescription?: string;
  examples?: string[];
  notes?: string;
  returns?: string;
  enabled: boolean;
}

async function loadScriptToolDocs(): Promise<ScriptToolDoc[]> {
  try {
    const content = await readFile(SCRIPT_TOOL_DOCS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch { return []; }
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

async function generateScriptToolDocs(ctx: DashboardContext): Promise<string> {
  const tools = ctx.extensionManager?.getAllTools() ?? [];
  if (tools.length === 0) return '';

  const customDocs = await loadScriptToolDocs();
  const customMap = new Map(customDocs.map(d => [d.toolName, d]));

  let section = '\nAvailable tools (via context.tools):\n';
  for (const tool of tools) {
    const custom = customMap.get(tool.definition.name);
    if (custom && !custom.enabled) continue;

    const sig = formatToolSignature(tool.definition);
    const desc = custom?.customDescription || tool.definition.description.split('\n')[0];
    section += `\n- ${sig} — ${desc}\n`;

    const props = tool.definition.parameters?.properties;
    const required: string[] = tool.definition.parameters?.required || [];
    if (props && typeof props === 'object') {
      section += `  Parameters:\n`;
      for (const [name, prop] of Object.entries(props)) {
        const p = prop as any;
        const req = required.includes(name) ? 'required' : 'optional';
        const paramDesc = p.description || '';
        section += `    - ${name} (${req}): ${paramDesc}\n`;
      }
    }

    if (custom?.returns) {
      section += `  Returns: ${custom.returns}\n`;
    }

    if (custom?.examples?.length) {
      for (const ex of custom.examples) {
        section += `  Example: ${ex}\n`;
      }
    }
    if (custom?.notes) {
      section += `  Note: ${custom.notes}\n`;
    }
  }
  return section;
}

// ────────────────────────────────────────────────────────────────
//  Approval request helper
// ────────────────────────────────────────────────────────────────

function createApprovalRequest(
  ctx: DashboardContext,
  nodeId: string,
  runId: string,
  compositionId: string,
  compositionName: string,
  gate: ApprovalGateConfig,
  upstreamVars: Record<string, unknown>,
): Promise<boolean> {
  const id = 'approval-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  let previewVars: Record<string, unknown> | undefined;
  if (gate.previewVariables && gate.previewVariables.length > 0) {
    previewVars = {};
    for (const varName of gate.previewVariables) {
      if (varName in upstreamVars) {
        previewVars[varName] = upstreamVars[varName];
      }
    }
  } else {
    previewVars = { ...upstreamVars };
  }

  const approval: PendingApproval = {
    id,
    runId,
    nodeId,
    compositionId,
    compositionName,
    message: gate.message,
    previewVariables: previewVars,
    createdAt: new Date().toISOString(),
    timeoutMs: gate.timeoutMs,
  };

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (gate.timeoutMs && gate.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (ctx.pendingApprovals.has(id)) {
          ctx.pendingApprovals.delete(id);
          debugLog.info('approval', `Approval "${id}" auto-rejected (timeout: ${gate.timeoutMs}ms)`);
          resolve(false);
        }
      }, gate.timeoutMs);
    }

    ctx.pendingApprovals.set(id, { approval, resolve, timer });
    debugLog.info('approval', `Approval gate created: "${id}" for node "${nodeId}" in "${compositionName}"`);
  });
}

// ────────────────────────────────────────────────────────────────
//  Script context builder (shared by main, ForEach body, nested, sub-pipeline)
// ────────────────────────────────────────────────────────────────

async function buildScriptContext(ctx: DashboardContext) {
  const { runPrompt: scriptRunPrompt } = await import('../../loop/llm-service.js');
  const scriptModel = process.env.ANTHROPIC_API_KEY
    ? 'claude-sonnet-4-20250514'
    : process.env.OPENAI_API_KEY
      ? 'gpt-4o-mini'
      : process.env.GROQ_API_KEY
        ? 'llama-3.1-70b-versatile'
        : 'claude-sonnet-4-20250514';

  const scriptTools: Record<string, (params: any) => Promise<any>> = {};
  const allExtTools = ctx.extensionManager?.getAllTools() ?? [];
  for (const extTool of allExtTools) {
    const toolHandler = extTool.handler;
    scriptTools[extTool.definition.name] = async (params: any) => {
      const result = await toolHandler(params, { workingDirectory: ctx.workDir } as any);
      if (typeof result === 'string') {
        try { return JSON.parse(result); } catch { return result; }
      }
      return result;
    };
  }
  if (!scriptTools.nanobanana) {
    try {
      const { nanobanana: nb } = await import('../../loop/tools/nanobanana.js');
      scriptTools.nanobanana = async (p: any) => JSON.parse(await nb(p as any, ctx.workDir));
    } catch { /* nanobanana not available */ }
  }

  return { scriptRunPrompt, scriptModel, scriptTools };
}

function makeScriptExecutionContext(
  scriptRunPrompt: Function,
  scriptModel: string,
  scriptTools: Record<string, (params: any) => Promise<any>>,
  scriptLogs: string[],
) {
  return {
    llm: {
      generate: async (prompt: string, opts?: { temperature?: number; maxTokens?: number; model?: string }) => {
        const resp = await scriptRunPrompt(
          [{ role: 'user', content: prompt }],
          opts?.model || scriptModel,
          { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.9 }
        );
        return resp.content.trim();
      },
      generateJSON: async (prompt: string, _schema?: any, opts?: { temperature?: number; maxTokens?: number; model?: string }) => {
        const resp = await scriptRunPrompt(
          [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }],
          opts?.model || scriptModel,
          { maxTokens: opts?.maxTokens || 4096, temperature: opts?.temperature ?? 0.7 }
        );
        const text = resp.content.trim();
        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        return JSON.parse(jsonMatch ? jsonMatch[1].trim() : text);
      },
    },
    tools: scriptTools,
    log: (msg: string) => { scriptLogs.push(String(msg)); },
  };
}

function extractScriptFnBody(code: string): string {
  let fnBody = code;
  const fnMatch = fnBody.match(/async\s+function\s+execute\s*\([^)]*\)\s*\{([\s\S]*)\}/);
  if (fnMatch) {
    fnBody = fnMatch[1];
  }
  return fnBody;
}

function normalizeScriptCode(code: string): string {
  const trimmed = String(code || '').trim();
  const fenceMatch = trimmed.match(/^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

async function executeScriptCode(
  code: string,
  inputs: Record<string, unknown>,
  context: any,
): Promise<Record<string, unknown>> {
  const normalizedCode = normalizeScriptCode(code);
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor as new (...args: string[]) => (...runtimeArgs: any[]) => Promise<any>;

  if (/(?:async\s+function\s+execute|function\s+execute)\s*\(/.test(normalizedCode)) {
    const runner = new AsyncFunction(
      'inputs',
      'context',
      'require',
      `${normalizedCode}\nif (typeof execute !== 'function') { throw new Error('Script does not define execute()'); }\nreturn await execute(inputs, context);`,
    );
    return (await runner(inputs, context, require)) || {};
  }

  const fnBody = extractScriptFnBody(normalizedCode);
  const fn = new AsyncFunction('inputs', 'context', 'require', fnBody);
  return (await fn(inputs, context, require)) || {};
}

class ScriptNodeExecutionError extends Error {
  logs: string[];
  originalError: string;
  attemptedAutoFix: boolean;
  externalError: boolean;

  constructor(message: string, details: {
    logs: string[];
    originalError: string;
    attemptedAutoFix: boolean;
    externalError: boolean;
  }) {
    super(message);
    this.name = 'ScriptNodeExecutionError';
    this.logs = details.logs;
    this.originalError = details.originalError;
    this.attemptedAutoFix = details.attemptedAutoFix;
    this.externalError = details.externalError;
  }
}

function parseJsonModelResponse(content: string): any {
  const trimmed = String(content || '').trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  return JSON.parse(candidate);
}

function formatRuntimeValueMap(values: Record<string, unknown>, maxEntries = 20): string {
  const entries = Object.entries(values).slice(0, maxEntries);
  if (entries.length === 0) return '  (none)';
  return entries
    .map(([key, value]) => `  ${key}: ${summarizeAutoFixValue(value, 260)}`)
    .join('\n');
}

async function persistCompositionDocument(
  composition: any,
  compositionPath: string | undefined,
  scriptLogs: string[],
): Promise<void> {
  if (!compositionPath) return;

  try {
    composition.metadata = composition.metadata || { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    composition.metadata.updatedAt = new Date().toISOString();
    await writeFile(compositionPath, JSON.stringify(composition, null, 2), 'utf-8');
  } catch (saveErr) {
    scriptLogs.push(`[auto-fix] Warning: changes applied in memory but failed to save to disk: ${saveErr}`);
  }
}

async function persistFixedScriptCode(
  composition: any,
  compositionPath: string | undefined,
  node: any,
  fixedCode: string,
  originalError: string,
  scriptLogs: string[],
): Promise<void> {
  node.script.code = fixedCode;
  if (!node.script.chatHistory) node.script.chatHistory = [];
  node.script.chatHistory.push(
    { role: 'user', content: `[Auto-fix] The script failed with: ${originalError}` },
    { role: 'assistant', content: `\`\`\`javascript\n${fixedCode}\n\`\`\`` },
  );

  if (!compositionPath) return;

  await persistCompositionDocument(composition, compositionPath, scriptLogs);
}

async function runScriptNodeWithAutoFix(options: {
  ctx: DashboardContext;
  node: any;
  nodeId: string;
  mergedInputs: Record<string, unknown>;
  composition: any;
  compositionPath?: string;
  nodes: any[];
  edges: Array<{ id: string; sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>;
  nodeOutputs: Record<string, Record<string, unknown>>;
  wfMap: Record<string, any>;
  locationLabel: string;
  updateCurrentStep?: (step: string) => void;
  recomputeInputs?: () => Record<string, unknown>;
}): Promise<{
  outputs: Record<string, unknown>;
  logs: string[];
  autoFixed?: boolean;
  originalError?: string;
  repairedInputs?: Record<string, unknown>;
  graphRepaired?: boolean;
}> {
  const {
    ctx,
    node,
    nodeId,
    mergedInputs,
    composition,
    compositionPath,
    nodes,
    edges,
    nodeOutputs,
    wfMap,
    locationLabel,
    updateCurrentStep,
    recomputeInputs,
  } = options;

  const { scriptRunPrompt, scriptModel, scriptTools } = await buildScriptContext(ctx);
  const scriptLogs: string[] = [];
  const context = makeScriptExecutionContext(scriptRunPrompt, scriptModel, scriptTools, scriptLogs);
  let runtimeInputs = recomputeInputs ? recomputeInputs() : mergedInputs;

  try {
    const outputs = await executeScriptCode(node.script.code, runtimeInputs, context);
    return { outputs: outputs || {}, logs: scriptLogs, repairedInputs: runtimeInputs };
  } catch (scriptErr: any) {
    const originalError = scriptErr?.message || String(scriptErr);

    if (!isCodeBug(scriptErr)) {
      scriptLogs.push(`[auto-fix] Skipped: error appears to be external/infrastructure (${scriptErr?.name || 'Error'})`);
      throw new ScriptNodeExecutionError(`Script error: ${originalError}`, {
        logs: scriptLogs,
        originalError,
        attemptedAutoFix: false,
        externalError: true,
      });
    }

    scriptLogs.push(`[auto-fix] Original error: ${originalError}`);
    updateCurrentStep?.('Script failed - analyzing graph context...');
    debugLog.info('comp-run', `Script node "${nodeId}" failed with code bug, starting graph-aware auto-fix`, {
      locationLabel,
      error: originalError,
    });

    try {
      const fixToolDocs = await generateScriptToolDocs(ctx);
      let graphContext = buildScriptAutoFixGraphContext({ nodeId, nodes, edges, nodeOutputs, wfMap });
      let inputSummary = formatRuntimeValueMap(runtimeInputs);
      const recentLogs = scriptLogs.slice(-10).map((entry) => `  ${entry}`).join('\n');

      let analysisSummary = 'Unavailable';
      let analysisResult: any = null;
      try {
        const analysisSystemPrompt = `You are analyzing a failing pipeline script node inside a graph execution engine.

Use the runtime inputs, neighboring node contracts, and local graph context to identify the most likely root cause.
Return JSON only with these keys:
- likelyRootCause
- wiringMismatchLikely
- evidence
- suspectInputs
- suspectContractMismatch
- fixStrategy

Keep the analysis concise and grounded in the provided data.`;

        const analysisUserMessage = `A pipeline script failed.

Location: ${locationLabel}
Error: ${scriptErr?.name || 'Error'}: ${originalError}
${scriptErr?.stack ? `Stack trace:\n${scriptErr.stack.split('\n').slice(0, 6).join('\n')}` : ''}

Runtime inputs:
${inputSummary}

${graphContext}

Script code:
\`\`\`javascript
${node.script.code}
\`\`\`

${recentLogs ? `Logs before failure:\n${recentLogs}\n` : ''}
Return JSON only.`;

        const analysisResponse = await scriptRunPrompt(
          [
            { role: 'system', content: analysisSystemPrompt },
            { role: 'user', content: analysisUserMessage },
          ],
          scriptModel,
          { maxTokens: 1400, temperature: 0.2 },
        );
        analysisResult = parseJsonModelResponse(analysisResponse.content);
        analysisSummary = JSON.stringify(analysisResult, null, 2);
        scriptLogs.push(`[auto-fix] Analysis summary: ${analysisSummary.replace(/\s+/g, ' ').slice(0, 220)}`);
      } catch (analysisErr: any) {
        scriptLogs.push(`[auto-fix] Analysis step failed, continuing without structured summary: ${analysisErr?.message || String(analysisErr)}`);
      }

      const repairCandidates = proposeScriptNodeEdgeRepairs({ nodeId, nodes, edges, nodeOutputs });
      const analysisSuggestsWiringMismatch = !!(
        analysisResult?.wiringMismatchLikely
        || analysisResult?.suspectContractMismatch
        || /mismatch|wire|port|connection/i.test(String(analysisResult?.likelyRootCause || ''))
        || /mismatch|wire|port|connection/i.test(String(analysisResult?.fixStrategy || ''))
      );
      const repairsAffectInputs = repairCandidates.some((candidate) => candidate.field === 'targetPort' || candidate.field === 'sourcePort');

      if (repairCandidates.length > 0 && (analysisSuggestsWiringMismatch || repairsAffectInputs)) {
        updateCurrentStep?.('Script failed - repairing graph edges...');
        let changed = false;
        for (const candidate of repairCandidates) {
          const edge = edges.find((item) => item.id === candidate.edgeId);
          if (!edge) continue;
          const currentValue = candidate.field === 'sourcePort' ? edge.sourcePort : edge.targetPort;
          if (currentValue !== candidate.fromPort) continue;
          if (candidate.field === 'sourcePort') edge.sourcePort = candidate.toPort;
          else edge.targetPort = candidate.toPort;
          changed = true;
          scriptLogs.push(`[auto-fix] Rewired edge ${candidate.edgeId}: ${candidate.field} ${candidate.fromPort} -> ${candidate.toPort} (${candidate.reason})`);
        }

        if (changed) {
          await persistCompositionDocument(composition, compositionPath, scriptLogs);
          runtimeInputs = recomputeInputs ? recomputeInputs() : runtimeInputs;
          inputSummary = formatRuntimeValueMap(runtimeInputs);
          graphContext = buildScriptAutoFixGraphContext({ nodeId, nodes, edges, nodeOutputs, wfMap });

          try {
            const repairedOutputs = await executeScriptCode(node.script.code, runtimeInputs, context);
            scriptLogs.push('[auto-fix] Graph edge repair resolved the script failure without changing code');
            return {
              outputs: repairedOutputs || {},
              logs: scriptLogs,
              originalError,
              repairedInputs: runtimeInputs,
              graphRepaired: true,
            };
          } catch (repairRetryErr: any) {
            scriptLogs.push(`[auto-fix] Graph edge repair applied but script still failed: ${repairRetryErr?.message || String(repairRetryErr)}`);
          }
        }
      }

      updateCurrentStep?.('Script failed - generating targeted fix...');

      const fixSystemPrompt = `You are a code debugger for pipeline script nodes. A script failed during execution and you need to fix the bug.

The script format:
1. JSDoc comment with @input and @output annotations
2. async function execute(inputs, context)
3. Available: context.llm.generate(prompt), context.llm.generateJSON(prompt), context.log(message)${fixToolDocs ? '\n' + fixToolDocs : ''}
4. Must return an object with all declared outputs

CRITICAL RULES:
- Do NOT change @input or @output annotations - ports are connected to other nodes
- Do NOT change the function signature
- Fix only the failing script node
- Keep the same overall logic and intent unless the runtime evidence proves the contract handling is wrong
- You may add defensive validation or normalize access to a clearly corresponding runtime key when the graph context shows a unique mismatch
- Respond with ONLY the corrected code block - no explanation before or after`;

      const fixUserMessage = `The following script node failed with an error.

Location: ${locationLabel}
Error: ${scriptErr?.name || 'Error'}: ${originalError}
${scriptErr?.stack ? `Stack trace:\n${scriptErr.stack.split('\n').slice(0, 6).join('\n')}` : ''}

Runtime inputs at time of failure:
${inputSummary}

${graphContext}

Structured analysis:
\`\`\`json
${analysisSummary}
\`\`\`

Script code:
\`\`\`javascript
${node.script.code}
\`\`\`

${recentLogs ? `Logs before failure:\n${recentLogs}\n` : ''}
Fix the bug and return the corrected code. Do not change the @input/@output annotations.`;

      const fixResponse = await scriptRunPrompt(
        [
          { role: 'system', content: fixSystemPrompt },
          { role: 'user', content: fixUserMessage },
        ],
        scriptModel,
        { maxTokens: 4096, temperature: 0.3 },
      );

      const fixedCode = normalizeScriptCode(fixResponse.content);
      if (!fixedCode) throw new Error('Auto-fix returned empty code');
      scriptLogs.push(`[auto-fix] LLM produced fixed code (${fixedCode.length} chars)`);

      updateCurrentStep?.('Re-running fixed script...');
      const fixedOutputs = await executeScriptCode(fixedCode, runtimeInputs, context);
      scriptLogs.push('[auto-fix] Fixed script executed successfully');

      await persistFixedScriptCode(composition, compositionPath, node, fixedCode, originalError, scriptLogs);

      return {
        outputs: fixedOutputs || {},
        logs: scriptLogs,
        autoFixed: true,
        originalError,
        repairedInputs: runtimeInputs,
      };
    } catch (fixErr: any) {
      const fixError = fixErr?.message || String(fixErr);
      scriptLogs.push(`[auto-fix] Fix attempt also failed: ${fixError}`);
      throw new ScriptNodeExecutionError(
        `Script error: ${originalError}\nAuto-fix attempted but also failed: ${fixError}`,
        {
          logs: scriptLogs,
          originalError,
          attemptedAutoFix: true,
          externalError: false,
        },
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Asset node execution helper
// ────────────────────────────────────────────────────────────────

async function executeAssetNode(
  ctx: DashboardContext,
  node: any,
  edgeInputs: Record<string, unknown>,
  mergedInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetMode = node.asset.mode || 'pick';

  const assetTools: Record<string, (params: any) => Promise<any>> = {};
  const allTools = ctx.extensionManager?.getAllTools() ?? [];
  for (const t of allTools) {
    if (t.definition.name.startsWith('asset_')) {
      assetTools[t.definition.name] = async (params: any) => {
        const result = await t.handler(params, { workingDirectory: ctx.workDir } as any);
        if (typeof result === 'string') {
          try { return JSON.parse(result); } catch { return result; }
        }
        return result;
      };
    }
  }

  if (assetMode === 'pick') {
    const assetId = node.asset.assetId;
    if (!assetId) throw new Error('No asset selected. Configure the asset in the properties panel.');
    const result = await assetTools.asset_get({ id: assetId });
    if (!result?.success) throw new Error(result?.error || 'Failed to get asset');
    const asset = result.asset;
    return {
      filePath: asset.file_path_absolute || asset.file_path || asset.filePath || '',
      fileName: asset.file_name || asset.fileName || asset.name || '',
      assetId: asset.id || assetId,
      metadata: JSON.stringify(asset.metadata || {}),
      __done__: true,
    };
  } else if (assetMode === 'save') {
    const filePath = String(edgeInputs['filePath'] || mergedInputs['filePath'] || '');
    const name = String(edgeInputs['name'] || mergedInputs['name'] || node.asset.defaultName || `asset-${Date.now()}`);
    if (!filePath) throw new Error('No filePath input connected. Connect a file path to save.');
    const saveParams: any = { file_path: filePath, name: name };
    if (node.asset.collectionSlug) saveParams.collection = node.asset.collectionSlug;
    if (node.asset.tags) saveParams.tags = node.asset.tags;
    if (node.asset.referenceOnly) saveParams.reference_only = true;
    const result = await assetTools.asset_save(saveParams);
    if (!result?.success) throw new Error(result?.error || 'Failed to save asset');
    return { assetId: result.id || result.asset?.id || '', success: true, __done__: true };
  } else if (assetMode === 'list') {
    const listParams: any = {};
    if (node.asset.collectionSlug) listParams.collection = node.asset.collectionSlug;
    if (node.asset.category) listParams.category = node.asset.category;
    const result = await assetTools.asset_list(listParams);
    const assets = result?.assets || [];
    return { assets: JSON.stringify(assets), count: assets.length, __done__: true };
  } else if (assetMode === 'remove') {
    const removeId = String(edgeInputs['assetId'] || mergedInputs['assetId'] || '');
    if (!removeId) throw new Error('No assetId input connected. Connect an asset ID to remove.');
    const result = await assetTools.asset_delete({ id: removeId });
    return { success: result?.success ?? false, __done__: true };
  } else if (assetMode === 'generate_path') {
    return await generateAssetPath(node, edgeInputs, mergedInputs);
  }
  return { __done__: true };
}

async function generateAssetPath(
  node: any,
  edgeInputs: Record<string, unknown>,
  mergedInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const datetimeStr = `${dateStr}_${timeStr}`;
  const timestampStr = String(Math.floor(now.getTime() / 1000));
  const uuidStr = `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
  const nameInput = String(edgeInputs['name'] || mergedInputs['name'] || 'output');

  const pattern = node.asset.namePattern || 'output_{datetime}';
  const ext = node.asset.fileExtension || '.json';
  const collectionSlug = node.asset.collectionSlug || '';

  let outputDir = node.asset.outputDirectory || '~/.woodbury/data/output';
  if (collectionSlug && collectionSlug !== '__all__') {
    try {
      const { readFile: rf } = await import('fs/promises');
      const { join: pj } = await import('path');
      const { homedir: hd } = await import('os');
      let assetsDataDir: string;
      try {
        const settingsRaw = await rf(pj(hd(), '.woodbury', 'data', 'assets-settings.json'), 'utf-8');
        const settings = JSON.parse(settingsRaw);
        assetsDataDir = settings.dataDir || pj(hd(), '.woodbury', 'creator-assets');
      } catch {
        assetsDataDir = pj(hd(), '.woodbury', 'creator-assets');
      }
      const colRaw = await rf(pj(assetsDataDir, 'collections.json'), 'utf-8');
      const collections = JSON.parse(colRaw);
      if (Array.isArray(collections)) {
        const col = collections.find((c: any) => c.slug === collectionSlug);
        if (col?.rootPath) outputDir = col.rootPath;
      }
    } catch (_e) { /* Fall back to configured outputDirectory */ }
  }

  if (outputDir.startsWith('~')) {
    outputDir = (process.env.HOME || '/tmp') + outputDir.slice(1);
  }

  const resolvedName = pattern
    .replace(/\{name\}/g, nameInput)
    .replace(/\{datetime\}/g, datetimeStr)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{time\}/g, timeStr)
    .replace(/\{timestamp\}/g, timestampStr)
    .replace(/\{uuid\}/g, uuidStr);

  const fileName = resolvedName + ext;
  const { join: pathJoin } = await import('path');
  const filePath = pathJoin(outputDir, fileName);

  return { filePath, fileName, directory: outputDir, collection: collectionSlug, __done__: true };
}

// ────────────────────────────────────────────────────────────────
//  File operation helpers
// ────────────────────────────────────────────────────────────────

async function executeFileOp(
  operation: string,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fsP = await import('node:fs/promises');
  const fsSync = await import('node:fs');
  const pathMod = await import('node:path');
  let result: Record<string, unknown> = {};

  if (operation === 'copy') {
    const src = String(inputs.sourcePath || '');
    const dest = String(inputs.destinationPath || '');
    if (!src) throw new Error('sourcePath is required');
    if (!dest) throw new Error('destinationPath is required');
    const destDir = pathMod.dirname(dest);
    if (!fsSync.existsSync(destDir)) fsSync.mkdirSync(destDir, { recursive: true });
    await fsP.copyFile(src, dest);
    result = { outputPath: dest, success: true };
  } else if (operation === 'move') {
    const src = String(inputs.sourcePath || '');
    const dest = String(inputs.destinationPath || '');
    if (!src) throw new Error('sourcePath is required');
    if (!dest) throw new Error('destinationPath is required');
    const destDir = pathMod.dirname(dest);
    if (!fsSync.existsSync(destDir)) fsSync.mkdirSync(destDir, { recursive: true });
    try {
      await fsP.rename(src, dest);
    } catch (renameErr: any) {
      if (renameErr.code === 'EXDEV') {
        await fsP.copyFile(src, dest);
        await fsP.unlink(src);
      } else { throw renameErr; }
    }
    result = { outputPath: dest, success: true };
  } else if (operation === 'delete') {
    const fp = String(inputs.filePath || '');
    if (!fp) throw new Error('filePath is required');
    await fsP.unlink(fp);
    result = { success: true };
  } else if (operation === 'mkdir') {
    const fp = String(inputs.folderPath || '');
    if (!fp) throw new Error('folderPath is required');
    await fsP.mkdir(fp, { recursive: true });
    result = { outputPath: fp, success: true };
  } else if (operation === 'list') {
    const fp = String(inputs.folderPath || '');
    if (!fp) throw new Error('folderPath is required');
    const entries = await fsP.readdir(fp);
    result = { files: JSON.stringify(entries), count: entries.length };
  }

  return result;
}

async function executeFileWrite(
  node: any,
  edgeInputs: Record<string, unknown>,
  mergedInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = String(edgeInputs['filePath'] || mergedInputs['filePath'] || '');
  if (!filePath) throw new Error('No filePath input connected. Connect a file path to the filePath port.');
  let content = edgeInputs['content'] ?? mergedInputs['content'] ?? '';

  const format = node.fileWriteNode.format || 'auto';
  const mode = node.fileWriteNode.mode || 'overwrite';
  const prettyPrint = node.fileWriteNode.prettyPrint !== false;

  let writeData: string;
  if (format === 'json') {
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch { /* keep */ } }
    writeData = prettyPrint ? JSON.stringify(content, null, 2) : JSON.stringify(content);
  } else if (format === 'text') {
    writeData = String(content);
  } else {
    if (typeof content === 'object' && content !== null) {
      writeData = prettyPrint ? JSON.stringify(content, null, 2) : JSON.stringify(content);
    } else if (typeof content === 'string') {
      try { const p = JSON.parse(content); writeData = prettyPrint ? JSON.stringify(p, null, 2) : JSON.stringify(p); } catch { writeData = content; }
    } else {
      writeData = String(content);
    }
  }

  const { writeFile: wf, appendFile: af, mkdir: mk } = await import('fs/promises');
  const { dirname: dn } = await import('path');
  await mk(dn(filePath), { recursive: true });
  if (mode === 'append') { await af(filePath, writeData, 'utf-8'); } else { await wf(filePath, writeData, 'utf-8'); }

  const bytesWritten = Buffer.byteLength(writeData, 'utf-8');
  return { filePath, success: true, bytesWritten, __done__: true };
}

async function executeFileRead(
  node: any,
  edgeInputs: Record<string, unknown>,
  mergedInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = String(edgeInputs['filePath'] || mergedInputs['filePath'] || '');
  if (!filePath) throw new Error('No filePath input connected. Connect a file path to the filePath port.');

  const { readFile: rf, stat: st } = await import('fs/promises');
  const fileStats = await st(filePath);
  const rawContent = await rf(filePath, 'utf-8');
  const parseMode = node.fileReadNode?.parseMode || 'auto';

  let content: any = rawContent;
  let isJson = false;

  if (parseMode === 'json') {
    content = JSON.parse(rawContent);
    isJson = true;
  } else if (parseMode === 'auto') {
    try { content = JSON.parse(rawContent); isJson = true; } catch { /* keep string */ }
  }

  return { content, isJson, size: fileStats.size, filePath, __done__: true };
}

function executeJsonKeys(
  edgeInputs: Record<string, unknown>,
  node: any,
): Record<string, unknown> {
  let jsonInput: unknown = edgeInputs['json'];
  const pathInput = String(edgeInputs['path'] || (node as any).jsonKeysNode?.defaultPath || '');

  if (typeof jsonInput === 'string') {
    try { jsonInput = JSON.parse(jsonInput); } catch { /* leave as string */ }
  }

  let target: any = jsonInput;
  if (pathInput && target != null && typeof target === 'object') {
    const segments = pathInput.split('.');
    for (const seg of segments) {
      if (target == null) break;
      if (Array.isArray(target)) {
        const idx = parseInt(seg, 10);
        target = isNaN(idx) ? undefined : target[idx];
      } else if (typeof target === 'object') {
        target = target[seg];
      } else {
        target = undefined;
      }
    }
  }

  const jkKeys = (target != null && typeof target === 'object') ? Object.keys(target) : [];
  const jkValues = (target != null && typeof target === 'object') ? Object.values(target) : [];
  const jkType = target === null ? 'null'
    : Array.isArray(target) ? 'array'
    : typeof target;

  function describeStructure(obj: any, depth = 0): string {
    if (depth > 3) return '...';
    if (obj === null) return 'null';
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return `[${obj.length} items: ${describeStructure(obj[0], depth + 1)}]`;
    }
    if (typeof obj === 'object') {
      const entries = Object.entries(obj).slice(0, 10);
      return '{ ' + entries.map(([k, v]) =>
        `${k}: ${describeStructure(v, depth + 1)}`
      ).join(', ') + (Object.keys(obj).length > 10 ? ', ...' : '') + ' }';
    }
    return typeof obj;
  }
  const jkStructure = describeStructure(target);

  return {
    keys: JSON.stringify(jkKeys),
    values: JSON.stringify(jkValues),
    value: typeof target === 'object' ? JSON.stringify(target) : target,
    type: jkType,
    structure: jkStructure,
  };
}

// ────────────────────────────────────────────────────────────────
//  Tool node execution helper
// ────────────────────────────────────────────────────────────────

async function executeToolNode(
  ctx: DashboardContext,
  node: any,
  edgeInputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toolName = node.toolNode.selectedTool;
  if (!toolName) throw new Error('No tool selected. Open the node properties and choose a tool.');
  const allTools = ctx.extensionManager?.getAllTools() ?? [];
  const tool = allTools.find(t => t.definition.name === toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not found. The extension may not be loaded.`);

  const params: Record<string, unknown> = { ...(node.toolNode.paramDefaults || {}), ...edgeInputs };
  delete params.__trigger__;

  console.log(`[tool-node] Invoking "${toolName}" with params:`, JSON.stringify(params, null, 2));

  const rawResult = await tool.handler(params, { workingDirectory: ctx.workDir } as any);
  let result: any;
  if (typeof rawResult === 'string') {
    try { result = JSON.parse(rawResult); } catch { result = rawResult; }
  } else {
    result = rawResult;
  }

  return { result, success: true, __done__: true };
}

// ────────────────────────────────────────────────────────────────
//  Variable node helpers
// ────────────────────────────────────────────────────────────────

function executeVariableNode(
  node: any,
  edgeInputs: Record<string, unknown>,
  initialVariables: Record<string, unknown>,
  existingOutputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cfg = node.variableNode;

  let currentValue: unknown = existingOutputs?.value;
  const exposedInputName = typeof cfg?.inputName === 'string' ? cfg.inputName.trim() : '';
  if (
    currentValue === undefined
    && cfg?.exposeAsInput
    && exposedInputName
    && Object.prototype.hasOwnProperty.call(initialVariables, exposedInputName)
  ) {
    currentValue = initialVariables[exposedInputName];
  }
  if (currentValue === undefined) {
    try { currentValue = JSON.parse(cfg.initialValue); }
    catch { currentValue = cfg.initialValue; }
  }

  if ('set' in edgeInputs) {
    currentValue = edgeInputs['set'];
  }
  if ('push' in edgeInputs) {
    if (!Array.isArray(currentValue)) currentValue = currentValue !== undefined && currentValue !== '' ? [currentValue] : [];
    (currentValue as unknown[]).push(edgeInputs['push']);
  }

  const length = Array.isArray(currentValue) ? currentValue.length
    : typeof currentValue === 'string' ? currentValue.length : 0;

  return { value: currentValue, length, __done__: true };
}

function executeGetVariableNode(
  node: any,
  nodeOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const targetId = node.getVariableNode.targetNodeId;
  const targetOutput = targetId ? nodeOutputs[targetId] : undefined;
  const value = targetOutput?.value;
  const getVarLength = Array.isArray(value) ? value.length
    : typeof value === 'string' ? value.length : 0;

  return { value, length: getVarLength, __done__: true };
}

// ────────────────────────────────────────────────────────────────
//  Special node IDs that don't need workflow resolution
// ────────────────────────────────────────────────────────────────

const SPECIAL_NODE_IDS = new Set([
  '__approval_gate__', '__script__', '__output__', '__image_viewer__',
  '__media__', '__branch__', '__delay__', '__gate__', '__for_each__',
  '__switch__', '__asset__', '__text__', '__file_op__', '__json_keys__',
  '__tool__', '__file_write__', '__file_read__', '__junction__',
  '__variable__', '__get_variable__',
]);

function isSpecialNode(workflowId: string): boolean {
  return SPECIAL_NODE_IDS.has(workflowId) || workflowId.startsWith('comp:');
}

// ────────────────────────────────────────────────────────────────
//  Initialize node states for all nodes in a composition
// ────────────────────────────────────────────────────────────────

function initNodeStates(
  nodes: any[],
  wfMap: Record<string, any>,
): Record<string, any> {
  const nodeStates: Record<string, any> = {};
  for (const node of nodes) {
    if (node.workflowId === '__approval_gate__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__approval_gate__', workflowName: node.label || 'Approval Gate', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__script__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__script__', workflowName: node.label || 'Script', stepsTotal: 1, stepsCompleted: 0, currentStep: '', logs: [] as string[] };
    } else if (node.workflowId === '__output__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__output__', workflowName: node.label || 'Pipeline Output', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__image_viewer__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__image_viewer__', workflowName: node.label || 'Image Viewer', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__media__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__media__', workflowName: node.label || 'Media Player', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__branch__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__branch__', workflowName: node.label || 'Branch', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__delay__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__delay__', workflowName: node.label || 'Delay', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__gate__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__gate__', workflowName: node.label || 'Gate', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__for_each__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__for_each__', workflowName: node.label || 'ForEach Loop', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__switch__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__switch__', workflowName: node.label || 'Switch', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__asset__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__asset__', workflowName: node.label || 'Asset', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__text__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__text__', workflowName: node.label || 'Text', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__variable__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__variable__', workflowName: node.label || 'Variable', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__get_variable__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__get_variable__', workflowName: node.label || 'Get Variable', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__file_op__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__file_op__', workflowName: node.label || 'File Op', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__json_keys__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__json_keys__', workflowName: node.label || 'JSON Extract', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__tool__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__tool__', workflowName: node.label || (node.toolNode?.selectedTool || 'Tool'), stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__file_write__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__file_write__', workflowName: node.label || 'Write File', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__file_read__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__file_read__', workflowName: node.label || 'Read File', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId === '__junction__') {
      nodeStates[node.id] = { status: 'pending', workflowId: '__junction__', workflowName: node.label || 'Junction', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else if (node.workflowId.startsWith('comp:')) {
      nodeStates[node.id] = { status: 'pending', workflowId: node.workflowId, workflowName: node.label || 'Sub-Pipeline', stepsTotal: 1, stepsCompleted: 0, currentStep: '' };
    } else {
      const wf = wfMap[node.id];
      nodeStates[node.id] = { status: 'pending', workflowId: node.workflowId, workflowName: wf.name, stepsTotal: wf.steps.length, stepsCompleted: 0, currentStep: '' };
    }
  }
  return nodeStates;
}

// ────────────────────────────────────────────────────────────────
//  ForEach body node dispatcher
// ────────────────────────────────────────────────────────────────

async function executeForEachBodyNode(
  ctx: DashboardContext,
  bodyNode: any,
  bodyNs: any,
  bodyEdgeInputs: Record<string, unknown>,
  bodyMergedInputs: Record<string, unknown>,
  initialVariables: Record<string, unknown>,
  nodeOutputs: Record<string, Record<string, unknown>>,
  comp: any,
  wfMap: Record<string, any>,
  abort: AbortController,
  run: any,
  forEachBodyNodes: Set<string>,
  compId: string,
  iterIndex: number,
  compPath?: string,
): Promise<void> {
  const bodyNodeId = bodyNode.id;

  if (bodyNode.workflowId === '__script__' && bodyNode.script) {
    bodyNs.inputVariables = { ...bodyMergedInputs };
    const scriptResult = await runScriptNodeWithAutoFix({
      ctx,
      node: bodyNode,
      nodeId: bodyNodeId,
      mergedInputs: bodyMergedInputs,
      composition: comp,
      compositionPath: compPath,
      nodes: comp.nodes,
      edges: comp.edges,
      nodeOutputs,
      wfMap,
      locationLabel: `${bodyNode.label || bodyNodeId} (ForEach iteration ${iterIndex + 1})`,
      updateCurrentStep: (step) => {
        bodyNs.currentStep = `${step} (iter ${iterIndex + 1})`;
      },
      recomputeInputs: () => ({
        ...initialVariables,
        ...gatherInputVariables(bodyNodeId, comp.edges, nodeOutputs),
      }),
    });

    const scriptOutputs: Record<string, unknown> = scriptResult.outputs || {};
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.logs = scriptResult.logs;
    bodyNs.inputVariables = { ...(scriptResult.repairedInputs || bodyMergedInputs) };
    bodyNs.outputVariables = scriptOutputs;
    nodeOutputs[bodyNodeId] = scriptOutputs;

  } else if (bodyNode.workflowId === '__text__') {
    const textValue = bodyNode.textNode?.value ?? '';
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = { text: textValue };
    nodeOutputs[bodyNodeId] = { text: textValue };

  } else if (bodyNode.workflowId === '__variable__' && bodyNode.variableNode) {
    const bodyVarInputs = gatherInputVariables(bodyNodeId, comp.edges, nodeOutputs);
    bodyNs.inputVariables = { ...bodyVarInputs };
    const outputs = executeVariableNode(bodyNode, bodyVarInputs, initialVariables, nodeOutputs[bodyNodeId]);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = outputs;

  } else if (bodyNode.workflowId === '__get_variable__' && bodyNode.getVariableNode) {
    const outputs = executeGetVariableNode(bodyNode, nodeOutputs);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = outputs;

  } else if (bodyNode.workflowId === '__json_keys__') {
    const outputs = executeJsonKeys(bodyEdgeInputs, bodyNode);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = { ...outputs };

  } else if (bodyNode.workflowId === '__branch__' && bodyNode.branchNode) {
    let condVal: unknown = bodyEdgeInputs['condition'];
    if (condVal === undefined) {
      let condStr = bodyNode.branchNode.condition || 'false';
      condStr = condStr.replace(/\{\{(\w+)\}\}/g, (_: string, varName: string) => {
        const val = bodyMergedInputs[varName];
        if (val === undefined || val === null) return 'null';
        if (typeof val === 'string') return JSON.stringify(val);
        return String(val);
      });
      try { condVal = new Function(`return (${condStr});`)(); } catch { condVal = false; }
    }
    const branchTruthy = !!condVal;
    const inactivePort = branchTruthy ? 'on_false' : 'on_true';
    const toSkip = getNodesExclusivelyDownstreamOfPort(bodyNodeId, inactivePort, comp.edges);
    for (const skipId of toSkip) {
      if (run.nodeStates[skipId]) run.nodeStates[skipId].status = 'skipped';
    }
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = { on_true: bodyMergedInputs, on_false: bodyMergedInputs, ...bodyMergedInputs };
    nodeOutputs[bodyNodeId] = { ...bodyMergedInputs };

  } else if (bodyNode.workflowId === '__delay__' && bodyNode.delayNode) {
    const delayMs = typeof bodyEdgeInputs['delay_ms'] === 'number'
      ? bodyEdgeInputs['delay_ms'] as number
      : (bodyNode.delayNode.delayMs || 1000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = { ...bodyMergedInputs };
    nodeOutputs[bodyNodeId] = { ...bodyMergedInputs };

  } else if (bodyNode.workflowId === '__for_each__' && bodyNode.forEachNode) {
    // Nested ForEach — recursive execution
    await executeNestedForEach(ctx, bodyNode, bodyNs, bodyEdgeInputs, initialVariables, nodeOutputs, comp, wfMap, abort, run, forEachBodyNodes, compId, compPath);

  } else if (bodyNode.workflowId === '__tool__' && bodyNode.toolNode) {
    const outputs = await executeToolNode(ctx, bodyNode, bodyEdgeInputs);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = outputs;
    console.log(`[tool-node] ForEach body: "${bodyNode.toolNode.selectedTool}" completed`);

  } else if (bodyNode.workflowId === '__asset__' && bodyNode.asset) {
    const outputs = await executeAssetNode(ctx, bodyNode, bodyEdgeInputs, bodyMergedInputs);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = { ...outputs };

  } else if (bodyNode.workflowId === '__file_write__' && bodyNode.fileWriteNode) {
    bodyNs.currentStep = `Writing file (iter ${iterIndex + 1})...`;
    const outputs = await executeFileWrite(bodyNode, bodyEdgeInputs, bodyMergedInputs);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = { ...outputs };

  } else if (bodyNode.workflowId === '__file_read__') {
    bodyNs.currentStep = `Reading file (iter ${iterIndex + 1})...`;
    const outputs = await executeFileRead(bodyNode, bodyEdgeInputs, bodyMergedInputs);
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = outputs;
    nodeOutputs[bodyNodeId] = { ...outputs };

  } else if (bodyNode.workflowId === '__file_op__' && bodyNode.fileOp) {
    const fopOp = bodyNode.fileOp.operation || 'copy';
    bodyNs.currentStep = `File ${fopOp} (iter ${iterIndex + 1})...`;
    const fopResult = await executeFileOp(fopOp, bodyMergedInputs);
    fopResult['__done__'] = true;
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = fopResult;
    nodeOutputs[bodyNodeId] = fopResult;

  } else if (bodyNode.workflowId === '__junction__' && bodyNode.junctionNode) {
    const bodyJuncInputs = gatherInputVariables(bodyNodeId, comp.edges, nodeOutputs);
    const juncOut: Record<string, unknown> = {};
    for (const port of bodyNode.junctionNode.ports) {
      const portValue = getInputValueByPortName(bodyJuncInputs, port.name);
      if (portValue !== undefined) juncOut[port.name] = portValue;
    }
    juncOut['__done__'] = true;
    bodyNs.status = 'completed';
    bodyNs.stepsCompleted = 1;
    bodyNs.outputVariables = juncOut;
    nodeOutputs[bodyNodeId] = juncOut;

  } else {
    // Regular workflow node in loop body
    const bodyWf = wfMap[bodyNodeId];
    if (bodyWf) {
      const bodyWfVars: Record<string, unknown> = { ...bodyMergedInputs };
      for (const v of (bodyWf.variables || [])) {
        if (bodyWfVars[v.name] === undefined && v.default !== undefined) {
          bodyWfVars[v.name] = v.default;
        }
      }
      bodyNs.currentStep = `Running (iter ${iterIndex + 1})...`;
      const executeWorkflow = getExecuteWorkflow();
      const result = await executeWorkflow(bridgeServer, bodyWf, bodyWfVars, {
        log: (msg: string) => {
          debugLog.info('comp-run', `[foreach-body] ${bodyNodeId}: ${msg}`);
          if (!bodyNs.logs) bodyNs.logs = [];
          if (bodyNs.logs.length < 200) bodyNs.logs.push(msg);
        },
        signal: abort.signal,
        onProgress: (event: any) => {
          if (event.type === 'step_start') bodyNs.currentStep = event.step?.label || `Step ${event.index + 1}`;
          else if (event.type === 'step_complete') bodyNs.stepsCompleted = event.index + 1;
        },
      });
      if (result.success) {
        bodyNs.status = 'completed';
        bodyNs.stepsCompleted = 1;
        bodyNs.outputVariables = result.variables;
        nodeOutputs[bodyNodeId] = result.variables;
      } else {
        bodyNs.status = 'failed';
        bodyNs.error = result.error || 'Workflow failed';
        nodeOutputs[bodyNodeId] = {};
      }
    } else {
      // Unknown node type — passthrough
      bodyNs.status = 'completed';
      bodyNs.stepsCompleted = 1;
      bodyNs.outputVariables = { ...bodyMergedInputs };
      nodeOutputs[bodyNodeId] = { ...bodyMergedInputs };
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Nested ForEach execution
// ────────────────────────────────────────────────────────────────

async function executeNestedForEach(
  ctx: DashboardContext,
  bodyNode: any,
  bodyNs: any,
  bodyEdgeInputs: Record<string, unknown>,
  initialVariables: Record<string, unknown>,
  nodeOutputs: Record<string, Record<string, unknown>>,
  comp: any,
  wfMap: Record<string, any>,
  abort: AbortController,
  run: any,
  forEachBodyNodes: Set<string>,
  compId: string,
  compPath?: string,
): Promise<void> {
  const bodyNodeId = bodyNode.id;

  let innerItems = bodyEdgeInputs['items'];
  if (typeof innerItems === 'string') {
    try { innerItems = JSON.parse(innerItems); } catch {}
  }
  const innerArray = Array.isArray(innerItems) ? innerItems : [];
  const innerMax = bodyNode.forEachNode.maxIterations || 100;
  const innerLimited = innerArray.slice(0, innerMax);

  // Find inner loop body nodes
  const innerBodyIds = getNodesExclusivelyDownstreamOfPort(bodyNodeId, 'current_item', comp.edges);
  const innerFromIdx = getNodesExclusivelyDownstreamOfPort(bodyNodeId, 'index', comp.edges);
  for (const iid of innerFromIdx) innerBodyIds.add(iid);
  for (const ibid of innerBodyIds) forEachBodyNodes.add(ibid);

  const innerBodyObjs = comp.nodes.filter((n: any) => innerBodyIds.has(n.id));
  const innerBodyEdges = comp.edges.filter((e: any) =>
    (innerBodyIds.has(e.sourceNodeId) || e.sourceNodeId === bodyNodeId) &&
    innerBodyIds.has(e.targetNodeId)
  );
  let innerOrder: string[];
  try { innerOrder = topoSort(innerBodyObjs, innerBodyEdges); } catch { innerOrder = [...innerBodyIds]; }

  // Find inner terminal nodes
  const innerHasSucc = new Set<string>();
  for (const e of comp.edges) {
    if (innerBodyIds.has(e.sourceNodeId) && innerBodyIds.has(e.targetNodeId)) innerHasSucc.add(e.sourceNodeId);
  }
  const innerTerminals = [...innerBodyIds].filter(id => !innerHasSucc.has(id));

  const innerResults: unknown[] = [];
  bodyNs.stepsTotal = innerLimited.length;

  for (let ii = 0; ii < innerLimited.length; ii++) {
    if (abort.signal.aborted) break;
    bodyNs.currentStep = `Inner ${ii + 1}/${innerLimited.length}`;
    bodyNs.stepsCompleted = ii;

    nodeOutputs[bodyNodeId] = { current_item: innerLimited[ii], index: ii, count: innerLimited.length };

    // Execute inner body nodes
    for (const innerNodeId of innerOrder) {
      if (abort.signal.aborted) break;
      const innerNode = comp.nodes.find((n: any) => n.id === innerNodeId);
      if (!innerNode) continue;
      const innerNs = run.nodeStates[innerNodeId];
      innerNs.status = 'running';
      innerNs.error = undefined;

      const innerEdgeIn = gatherInputVariables(innerNodeId, comp.edges, nodeOutputs);
      const innerMerged: Record<string, unknown> = { ...initialVariables, ...innerEdgeIn };
      innerNs.inputVariables = { ...innerMerged };

      // Idempotency cache check (nested ForEach)
      let innerIdempotencyHash = '';
      const innerIsIdempotent = !!(innerNode?.idempotent);
      if (innerIsIdempotent) {
        innerIdempotencyHash = computeIdempotencyHash(compId, innerNodeId, innerNode, innerEdgeIn);
        const innerCached = await loadIdempotencyCache(compId, innerIdempotencyHash);
        if (innerCached) {
          innerNs.status = 'completed';
          innerNs.currentStep = 'Cached';
          innerNs.outputVariables = innerCached;
          nodeOutputs[innerNodeId] = innerCached;
          debugLog.info('comp-run', `Inner ForEach node "${innerNodeId}" idempotency cache hit`);
          continue;
        }
      }

      try {
        // Dispatch inner node using the same body node dispatcher
        await executeForEachBodyNode(
          ctx, innerNode, innerNs, innerEdgeIn, innerMerged,
          initialVariables, nodeOutputs, comp, wfMap, abort, run,
          forEachBodyNodes, compId, ii, compPath,
        );
      } catch (err: any) {
        // For inner workflow nodes, try direct execution
        const innerWf = wfMap[innerNodeId];
        if (innerWf) {
          const innerVars: Record<string, unknown> = { ...innerMerged };
          for (const v of (innerWf.variables || [])) {
            if (innerVars[v.name] === undefined && v.default !== undefined) innerVars[v.name] = v.default;
          }
          try {
            const executeWorkflow = getExecuteWorkflow();
            const result = await executeWorkflow(bridgeServer, innerWf, innerVars, {
              log: (msg: string) => {
                debugLog.info('comp-run', `[inner-foreach] ${innerNodeId}: ${msg}`);
                if (!innerNs.logs) innerNs.logs = [];
                if (innerNs.logs.length < 200) innerNs.logs.push(msg);
              },
              signal: abort.signal,
              onProgress: () => {},
            });
            if (result.success) {
              innerNs.status = 'completed';
              innerNs.stepsCompleted = 1;
              innerNs.outputVariables = result.variables;
              nodeOutputs[innerNodeId] = result.variables;
            } else {
              innerNs.status = 'failed';
              innerNs.error = result.error || 'Workflow failed';
            }
          } catch (wfErr: any) {
            innerNs.status = 'failed';
            innerNs.error = wfErr?.message || String(wfErr);
          }
        } else {
          innerNs.status = 'failed';
          innerNs.error = err?.message || String(err);
        }
      }

      // Idempotency cache save (nested ForEach)
      if (innerIsIdempotent && innerNs.status === 'completed') await saveIdempotencyCache(compId, innerIdempotencyHash, nodeOutputs[innerNodeId]);
    }

    // Collect inner terminal outputs
    if (innerTerminals.length > 0) {
      const iterOut: Record<string, unknown> = {};
      for (const tn of innerTerminals) {
        if (nodeOutputs[tn]) Object.assign(iterOut, nodeOutputs[tn]);
      }
      innerResults.push(Object.keys(iterOut).length === 1 ? Object.values(iterOut)[0] : iterOut);
    } else {
      innerResults.push(innerLimited[ii]);
    }
  }

  bodyNs.status = 'completed';
  bodyNs.stepsCompleted = innerLimited.length;
  bodyNs.currentStep = `Done — ${innerLimited.length} iterations`;
  nodeOutputs[bodyNodeId] = {
    results: innerResults,
    total_count: innerResults.length,
    current_item: innerLimited[innerLimited.length - 1],
    index: innerLimited.length - 1,
    count: innerLimited.length,
  };
  bodyNs.outputVariables = { ...nodeOutputs[bodyNodeId] };
}

// ────────────────────────────────────────────────────────────────
//  Lazy workflow runner loader
// ────────────────────────────────────────────────────────────────

let _executeWorkflow: Function | null = null;

function getExecuteWorkflow(): Function {
  if (_executeWorkflow) return _executeWorkflow;
  const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
  const wfRunner = require(wfRunnerPath);
  _executeWorkflow = wfRunner.executeWorkflow;
  if (!_executeWorkflow) throw new Error('executeWorkflow not found');
  return _executeWorkflow;
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleCompositionRunRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // POST /api/compositions/:id/run — execute a composition
  const runCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/run$/);
  if (req.method === 'POST' && runCompMatch) {
    const id = decodeURIComponent(runCompMatch[1]);
    try {
      if (ctx.activeCompRun && !ctx.activeCompRun.done) {
        sendJson(res, 409, { error: `"${ctx.activeCompRun.compositionName}" is already running. Wait for it to finish or stop it first.` });
        return true;
      }
      if (ctx.activeRun && !ctx.activeRun.done) {
        sendJson(res, 409, { error: `Workflow "${ctx.activeRun.workflowName}" is running. Wait for it to finish first.` });
        return true;
      }

      // Load the composition
      const compDiscovered = await discoverCompositions(ctx.workDir);
      const compFound = compDiscovered.find(d => d.composition.id === id);
      if (!compFound) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }
      const comp = compFound.composition;

      if (comp.nodes.length === 0) {
        sendJson(res, 400, { error: 'Add at least one workflow to your pipeline before running it' });
        return true;
      }

      // Ensure all extensions (and their tools) are fully loaded before running
      await ctx.extensionManager?.whenReady();

      // Topological sort
      let executionOrder: string[];
      try {
        executionOrder = topoSort(comp.nodes, comp.edges);
      } catch (cycleErr) {
        sendJson(res, 400, { error: String(cycleErr) });
        return true;
      }

      // Resolve all workflows (skip special nodes)
      const wfDiscovered = await discoverWorkflows(ctx.workDir);
      const wfMap: Record<string, any> = {};
      for (const node of comp.nodes) {
        if (isSpecialNode(node.workflowId)) continue;
        const found = wfDiscovered.find(d => d.workflow.id === node.workflowId);
        if (!found) {
          sendJson(res, 400, { error: `The workflow "${node.workflowId}" was deleted or renamed. Remove it from the pipeline and re-add it.` });
          return true;
        }
        wfMap[node.id] = found.workflow;
      }

      // Ensure bridge
      await ensureBridgeServer();
      if (!bridgeServer.isConnected) {
        sendJson(res, 503, { error: 'Chrome extension is not connected.' });
        return true;
      }

      // Load executeWorkflow
      let executeWorkflow: Function;
      try {
        executeWorkflow = getExecuteWorkflow();
      } catch (importErr: any) {
        sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message}` });
        return true;
      }

      const body = await readBody(req);
      const initialVariables: Record<string, unknown> = body?.variables || {};

      // Initialize run state
      const abort = new AbortController();
      const nodeStates = initNodeStates(comp.nodes, wfMap);

      ctx.activeCompRun = {
        compositionId: id,
        compositionName: comp.name,
        abort,
        startedAt: Date.now(),
        nodesTotal: comp.nodes.length,
        nodesCompleted: 0,
        currentNodeId: null,
        executionOrder,
        nodeStates,
        done: false,
        success: false,
      };

      // Create run history record
      const compRunId = generateRunId();
      ctx.activeCompRun.runId = compRunId;
      await createRunRecord({
        id: compRunId,
        type: 'pipeline',
        sourceId: id,
        name: comp.name,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'running',
        variables: initialVariables,
        nodesTotal: comp.nodes.length,
        nodesCompleted: 0,
        nodeResults: [],
      });

      sendJson(res, 200, { success: true, status: 'running', runId: compRunId, compositionName: comp.name, nodesTotal: comp.nodes.length });

      // Helper: finalize the run history record for a composition run
      async function finalizeCompRunRecord(runId: string, r: typeof ctx.activeCompRun, order: string[]): Promise<void> {
        if (!r) return;
        const nodeResults: NodeRunResult[] = order.map(nId => {
          const ns = r.nodeStates[nId];
          return {
            nodeId: nId,
            workflowId: ns.workflowId,
            workflowName: ns.workflowName,
            status: ns.status === 'completed' ? 'completed' as const : ns.status === 'skipped' ? 'skipped' as const : 'failed' as const,
            durationMs: ns.durationMs || 0,
            stepsTotal: ns.stepsTotal,
            stepsCompleted: ns.stepsCompleted,
            error: ns.error,
            outputVariables: ns.outputVariables,
            expectationResults: ns.expectationResults,
            retryAttempts: (ns.retryAttempt && ns.retryAttempt > 1) ? ns.retryAttempt - 1 : undefined,
          };
        });

        const allOutputFiles: string[] = [];
        for (const nr of nodeResults) {
          if (nr.outputVariables) {
            allOutputFiles.push(...extractOutputFiles(nr.outputVariables));
          }
        }

        await updateRunRecord(runId, {
          completedAt: new Date().toISOString(),
          durationMs: r.durationMs,
          status: r.success ? 'completed' : 'failed',
          error: r.error,
          nodesCompleted: r.nodesCompleted,
          nodeResults,
          outputFiles: allOutputFiles.length > 0 ? allOutputFiles : undefined,
          pipelineOutputs: r.pipelineOutputs,
        });
      }

      // Execute asynchronously
      const run = ctx.activeCompRun;
      const nodeOutputs: Record<string, Record<string, unknown>> = {};

      (async () => {
        try {
          let pipelineHadFailure = false;
          let pipelineFirstError = '';
          const forEachBodyNodes = new Set<string>();

          for (const nodeId of executionOrder) {
            if (abort.signal.aborted) break;

            // Skip nodes already executed as part of a ForEach loop body
            if (forEachBodyNodes.has(nodeId)) continue;

            const wf = wfMap[nodeId];
            const node = comp.nodes.find((n: any) => n.id === nodeId);
            const ns = run.nodeStates[nodeId];

            // Skip if already skipped (due to upstream failure)
            if (ns.status === 'skipped') continue;

            // ── Idempotency cache check ──────────────────────
            let idempotencyHash = '';
            const isIdempotent = !!(node?.idempotent);
            if (isIdempotent) {
              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              idempotencyHash = computeIdempotencyHash(id, nodeId, node, edgeInputs);
              const cached = await loadIdempotencyCache(id, idempotencyHash);
              if (cached) {
                ns.status = 'completed';
                ns.currentStep = 'Cached';
                ns.outputVariables = cached;
                nodeOutputs[nodeId] = cached;
                run.nodesCompleted++;
                debugLog.info('comp-run', `Node "${nodeId}" idempotency cache hit`);
                continue;
              }
            }

            // ── Approval Gate Node ──────────────────────────
            if (node?.workflowId === '__approval_gate__' && node.approvalGate) {
              ns.status = 'running';
              ns.currentStep = 'Waiting for approval...';
              run.currentNodeId = nodeId;
              const gateStart = Date.now();

              const upstreamVars: Record<string, unknown> = { ...initialVariables };
              for (const [nid, outputs] of Object.entries(nodeOutputs)) {
                Object.assign(upstreamVars, outputs);
              }

              debugLog.info('comp-run', `Approval gate "${nodeId}" waiting for user approval`);

              const approved = await createApprovalRequest(
                ctx, nodeId, compRunId, id, comp.name, node.approvalGate, upstreamVars,
              );

              ns.durationMs = Date.now() - gateStart;

              if (approved) {
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.inputVariables = upstreamVars;
                ns.outputVariables = upstreamVars;
                run.nodesCompleted++;
                nodeOutputs[nodeId] = upstreamVars;
                debugLog.info('comp-run', `Approval gate "${nodeId}" approved`);
                continue;
              } else {
                ns.status = 'failed';
                ns.error = 'Rejected by user';
                debugLog.info('comp-run', `Approval gate "${nodeId}" rejected`);

                const onReject = node.approvalGate.onReject || 'stop';
                if (onReject === 'skip') {
                  ns.status = 'skipped';
                  continue;
                } else {
                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  run.done = true;
                  run.success = false;
                  run.error = `Approval gate rejected: ${node.approvalGate.message}`;
                  run.durationMs = Date.now() - run.startedAt;
                  await finalizeCompRunRecord(compRunId, run, executionOrder);
                  return;
                }
              }
            }

            // ── Script Node ─────────────────────────────────────
            if (node?.workflowId === '__script__' && node.script) {
              ns.status = 'running';
              ns.currentStep = 'Running script...';
              run.currentNodeId = nodeId;
              const scriptStart = Date.now();

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              try {
                const result = await runScriptNodeWithAutoFix({
                  ctx,
                  node,
                  nodeId,
                  mergedInputs,
                  composition: comp,
                  compositionPath: compFound.path,
                  nodes: comp.nodes,
                  edges: comp.edges,
                  nodeOutputs,
                  wfMap,
                  locationLabel: `${comp.name} / ${node.label || nodeId}`,
                  updateCurrentStep: (step) => {
                    ns.currentStep = step;
                  },
                  recomputeInputs: () => ({
                    ...initialVariables,
                    ...gatherInputVariables(nodeId, comp.edges, nodeOutputs),
                  }),
                });

                ns.durationMs = Date.now() - scriptStart;
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.logs = result.logs;
                ns.inputVariables = { ...(result.repairedInputs || mergedInputs) };
                ns.outputVariables = result.outputs || {};
                run.nodesCompleted++;
                nodeOutputs[nodeId] = result.outputs || {};

                debugLog.info('comp-run', `Script node "${nodeId}" completed`, {
                  outputKeys: Object.keys(result.outputs || {}),
                  durationMs: ns.durationMs,
                  autoFixed: !!result.autoFixed,
                });
              } catch (scriptErr: any) {
                ns.durationMs = Date.now() - scriptStart;
                ns.status = 'failed';
                ns.error = scriptErr?.message || String(scriptErr);
                ns.logs = Array.isArray(scriptErr?.logs) ? scriptErr.logs : [];
                debugLog.error('comp-run', `Script node "${nodeId}" failed`, {
                  error: ns.error,
                  originalError: scriptErr?.originalError,
                  attemptedAutoFix: !!scriptErr?.attemptedAutoFix,
                });

                // Apply failure policy (stop or skip)
                const scriptPolicy = node.onFailure || { action: 'stop' as const };
                if (scriptPolicy.action === 'skip') {
                  ns.status = 'skipped';
                  continue;
                } else {
                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  run.done = true;
                  run.success = false;
                  run.error = ns.error;
                  run.durationMs = Date.now() - run.startedAt;
                  await finalizeCompRunRecord(compRunId, run, executionOrder);
                  return;
                }
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Image Viewer Node (pass-through) ──────────────────
            if (node?.workflowId === '__image_viewer__' && node.imageViewer) {
              ns.status = 'running';
              ns.currentStep = 'Displaying image...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const filePath = mergedInputs['file_path'] ?? node.imageViewer.filePath;

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = { file_path: filePath };
              nodeOutputs[nodeId] = { file_path: filePath };
              run.nodesCompleted++;

              debugLog.info('comp-run', `Image viewer "${nodeId}" pass-through`, { filePath });
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Media Player Node (pass-through with type detection) ───
            if (node?.workflowId === '__media__' && node.mediaPlayer) {
              ns.status = 'running';
              ns.currentStep = 'Resolving media...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const mpCfg = node.mediaPlayer;
              let resolvedPath: unknown;

              if (mpCfg.sourceMode === 'url') {
                resolvedPath = mergedInputs['url'] ?? mpCfg.url;
              } else if (mpCfg.sourceMode === 'asset_id') {
                resolvedPath = mergedInputs['asset_id'] ?? mpCfg.assetId;
              } else {
                resolvedPath = mergedInputs['file_path'] ?? mpCfg.filePath;
              }

              const pathStr = String(resolvedPath || '');
              const mpExt = pathStr.split('.').pop()?.toLowerCase() || '';
              let detectedType = mpCfg.mediaType || 'auto';
              if (detectedType === 'auto') {
                const imgExts = ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'];
                const vidExts = ['mp4','mov','avi','webm','mkv'];
                const audExts = ['mp3','wav','ogg','aac','flac','m4a'];
                if (imgExts.includes(mpExt)) detectedType = 'image';
                else if (vidExts.includes(mpExt)) detectedType = 'video';
                else if (audExts.includes(mpExt)) detectedType = 'audio';
                else if (mpExt === 'pdf') detectedType = 'pdf';
                else detectedType = 'text';
              }

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = { file_path: resolvedPath, media_type: detectedType };
              nodeOutputs[nodeId] = { file_path: resolvedPath, media_type: detectedType };
              run.nodesCompleted++;

              debugLog.info('comp-run', `Media player "${nodeId}" pass-through`, { resolvedPath, detectedType });
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Branch Node (conditional routing) ─────────────────
            if (node?.workflowId === '__branch__' && node.branchNode) {
              ns.status = 'running';
              ns.currentStep = 'Evaluating condition...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              let conditionValue: unknown = edgeInputs['condition'];
              if (conditionValue === undefined) {
                let conditionStr = node.branchNode.condition || 'false';
                conditionStr = conditionStr.replace(/\{\{(\w+)\}\}/g, (_: string, varName: string) => {
                  const val = mergedInputs[varName];
                  if (val === undefined || val === null) return 'null';
                  if (typeof val === 'string') return JSON.stringify(val);
                  return String(val);
                });
                try { conditionValue = new Function(`return (${conditionStr});`)(); }
                catch { conditionValue = false; }
              }

              const isTruthy = !!conditionValue;
              const inactivePort = isTruthy ? 'on_false' : 'on_true';

              const toSkip = getNodesExclusivelyDownstreamOfPort(nodeId, inactivePort, comp.edges);
              for (const skipId of toSkip) {
                if (run.nodeStates[skipId]) run.nodeStates[skipId].status = 'skipped';
              }

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.currentStep = `Took: ${isTruthy ? 'true' : 'false'}`;
              ns.outputVariables = { on_true: mergedInputs, on_false: mergedInputs, ...mergedInputs };
              nodeOutputs[nodeId] = { ...mergedInputs };
              run.nodesCompleted++;

              debugLog.info('comp-run', `Branch "${nodeId}" evaluated: ${isTruthy}`, { skipped: [...toSkip] });
              continue;
            }

            // ── Delay Node (timed pause) ──────────────────────────
            if (node?.workflowId === '__delay__' && node.delayNode) {
              ns.status = 'running';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const delayMs = typeof edgeInputs['delay_ms'] === 'number'
                ? edgeInputs['delay_ms'] as number
                : (node.delayNode.delayMs || 1000);

              ns.currentStep = `Waiting ${delayMs}ms...`;

              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delayMs);
                const onAbort = () => { clearTimeout(timer); resolve(); };
                abort.signal.addEventListener('abort', onAbort, { once: true });
              });

              if (abort.signal.aborted) break;

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.currentStep = 'Done';
              ns.outputVariables = { ...mergedInputs };
              nodeOutputs[nodeId] = { ...mergedInputs };
              run.nodesCompleted++;

              debugLog.info('comp-run', `Delay "${nodeId}" waited ${delayMs}ms`);
              continue;
            }

            // ── Gate Node (conditional pass-through) ──────────────
            if (node?.workflowId === '__gate__' && node.gateNode) {
              ns.status = 'running';
              ns.currentStep = 'Checking gate...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const isOpen = edgeInputs['open'] !== undefined
                ? !!edgeInputs['open']
                : node.gateNode.defaultOpen;

              if (isOpen) {
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.currentStep = 'Gate: OPEN';
                const outValue = edgeInputs['data'] !== undefined ? edgeInputs['data'] : mergedInputs;
                ns.outputVariables = { out: outValue, ...mergedInputs };
                nodeOutputs[nodeId] = { out: outValue, ...mergedInputs };
                run.nodesCompleted++;
                debugLog.info('comp-run', `Gate "${nodeId}" is OPEN`, { hasData: edgeInputs['data'] !== undefined });
              } else {
                const onClosed = node.gateNode.onClosed || 'skip';
                if (onClosed === 'fail') {
                  ns.status = 'failed';
                  ns.stepsCompleted = 1;
                  ns.currentStep = 'Gate: CLOSED (pipeline failed)';
                  ns.error = `Condition not met: ${node.label || 'Gate'}`;

                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  run.done = true;
                  run.success = false;
                  run.error = ns.error;
                  run.durationMs = Date.now() - run.startedAt;
                  await finalizeCompRunRecord(compRunId, run, executionOrder);
                  debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — pipeline FAILED`);
                  return;
                } else if (onClosed === 'stop') {
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  ns.currentStep = 'Gate: CLOSED (stopping)';
                  run.nodesCompleted++;

                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  run.done = true;
                  run.success = true;
                  run.error = `Gate "${node.label || 'Gate'}" closed — pipeline stopped.`;
                  run.durationMs = Date.now() - run.startedAt;
                  await finalizeCompRunRecord(compRunId, run, executionOrder);
                  debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — stopping pipeline`);
                  return;
                } else {
                  ns.status = 'completed';
                  ns.stepsCompleted = 1;
                  ns.currentStep = 'Gate: CLOSED (skipping downstream)';
                  run.nodesCompleted++;

                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  debugLog.info('comp-run', `Gate "${nodeId}" CLOSED — skipping ${downstream.size} downstream`);
                }
              }
              continue;
            }

            // ── ForEach Loop Node ──
            if (node?.workflowId === '__for_each__' && node.forEachNode) {
              ns.status = 'running';
              ns.currentStep = 'Processing items...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              let items = edgeInputs['items'];
              if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch { /* keep as string */ }
              }

              const itemsArray = Array.isArray(items) ? items : [];
              const maxIter = node.forEachNode.maxIterations || 100;
              const limited = itemsArray.slice(0, maxIter);

              const loopBodyFromItem = getNodesExclusivelyDownstreamOfPort(nodeId, 'current_item', comp.edges);
              const loopBodyFromIndex = getNodesExclusivelyDownstreamOfPort(nodeId, 'index', comp.edges);
              const loopBodyFromCount = getNodesExclusivelyDownstreamOfPort(nodeId, 'count', comp.edges);
              const loopBodyNodeIds = new Set<string>();
              for (const lbId of loopBodyFromItem) loopBodyNodeIds.add(lbId);
              for (const lbId of loopBodyFromIndex) loopBodyNodeIds.add(lbId);
              for (const lbId of loopBodyFromCount) loopBodyNodeIds.add(lbId);

              for (const bodyId of loopBodyNodeIds) forEachBodyNodes.add(bodyId);

              const loopBodyNodeObjs = comp.nodes.filter((n: any) => loopBodyNodeIds.has(n.id));
              const loopBodyEdges = comp.edges.filter((e: any) =>
                (loopBodyNodeIds.has(e.sourceNodeId) || e.sourceNodeId === nodeId) &&
                loopBodyNodeIds.has(e.targetNodeId)
              );
              let loopBodyOrder: string[];
              try { loopBodyOrder = topoSort(loopBodyNodeObjs, loopBodyEdges); }
              catch { loopBodyOrder = [...loopBodyNodeIds]; }

              const hasBodySuccessor = new Set<string>();
              for (const e of comp.edges) {
                if (loopBodyNodeIds.has(e.sourceNodeId) && loopBodyNodeIds.has(e.targetNodeId)) hasBodySuccessor.add(e.sourceNodeId);
              }
              const terminalBodyNodes = [...loopBodyNodeIds].filter(tbId => !hasBodySuccessor.has(tbId));

              debugLog.info('comp-run', `ForEach "${nodeId}": ${limited.length} items, ${loopBodyNodeIds.size} body nodes, ${terminalBodyNodes.length} terminal nodes`);

              const collectedResults: unknown[] = [];
              ns.stepsTotal = limited.length;

              for (let i = 0; i < limited.length; i++) {
                if (abort.signal.aborted) break;

                ns.currentStep = `Iteration ${i + 1}/${limited.length}`;
                ns.stepsCompleted = i;

                nodeOutputs[nodeId] = {
                  current_item: limited[i],
                  index: i,
                  count: limited.length,
                };

                for (const bodyNodeId of loopBodyOrder) {
                  if (abort.signal.aborted) break;

                  const bodyNode = comp.nodes.find((n: any) => n.id === bodyNodeId);
                  if (!bodyNode) continue;
                  const bodyNs = run.nodeStates[bodyNodeId];

                  bodyNs.status = 'running';
                  bodyNs.currentStep = `Iteration ${i + 1}`;
                  bodyNs.error = undefined;
                  bodyNs.stepsCompleted = 0;

                  const bodyEdgeInputs = gatherInputVariables(bodyNodeId, comp.edges, nodeOutputs);
                  const bodyMergedInputs: Record<string, unknown> = { ...initialVariables, ...bodyEdgeInputs };
                  bodyNs.inputVariables = { ...bodyMergedInputs };

                  // Idempotency cache check (ForEach body)
                  let bodyIdempotencyHash = '';
                  const bodyIsIdempotent = !!(bodyNode?.idempotent);
                  if (bodyIsIdempotent) {
                    bodyIdempotencyHash = computeIdempotencyHash(id, bodyNodeId, bodyNode, bodyEdgeInputs);
                    const bodyCached = await loadIdempotencyCache(id, bodyIdempotencyHash);
                    if (bodyCached) {
                      bodyNs.status = 'completed';
                      bodyNs.currentStep = 'Cached';
                      bodyNs.outputVariables = bodyCached;
                      nodeOutputs[bodyNodeId] = bodyCached;
                      debugLog.info('comp-run', `ForEach body node "${bodyNodeId}" idempotency cache hit (iter ${i})`);
                      continue;
                    }
                  }

                  try {
                    await executeForEachBodyNode(
                      ctx, bodyNode, bodyNs, bodyEdgeInputs, bodyMergedInputs,
                      initialVariables, nodeOutputs, comp, wfMap, abort, run,
                      forEachBodyNodes, id, i, compFound.path,
                    );

                    if (bodyIsIdempotent && (bodyNs.status as string) === 'completed') await saveIdempotencyCache(id, bodyIdempotencyHash, nodeOutputs[bodyNodeId]);
                  } catch (err: any) {
                    bodyNs.status = 'failed';
                    bodyNs.error = err?.message || String(err);
                    nodeOutputs[bodyNodeId] = {};
                    debugLog.error('comp-run', `ForEach body node "${bodyNodeId}" failed at iteration ${i}`, { error: err?.message });
                  }
                }

                if (terminalBodyNodes.length > 0) {
                  const iterResult: Record<string, unknown> = {};
                  for (const tn of terminalBodyNodes) {
                    if (nodeOutputs[tn]) Object.assign(iterResult, nodeOutputs[tn]);
                  }
                  collectedResults.push(
                    Object.keys(iterResult).length === 1 ? Object.values(iterResult)[0] : iterResult
                  );
                } else {
                  collectedResults.push(limited[i]);
                }
              }

              nodeOutputs[nodeId] = {
                results: collectedResults,
                total_count: collectedResults.length,
                current_item: limited.length > 0 ? limited[limited.length - 1] : undefined,
                index: limited.length > 0 ? limited.length - 1 : 0,
                count: limited.length,
              };
              ns.status = 'completed';
              ns.stepsCompleted = limited.length;
              ns.currentStep = `Done — ${limited.length} iterations`;
              ns.outputVariables = { ...nodeOutputs[nodeId] };
              run.nodesCompleted++;

              debugLog.info('comp-run', `ForEach "${nodeId}" completed ${limited.length} iterations, collected ${collectedResults.length} results`);
              continue;
            }

            // ── Switch Node (multi-way routing) ───────────────────
            if (node?.workflowId === '__switch__' && node.switchNode) {
              ns.status = 'running';
              ns.currentStep = 'Evaluating switch...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const switchValue = String(edgeInputs['value'] ?? '');
              const cases = node.switchNode.cases || [];
              const defaultPort = node.switchNode.defaultPort || 'on_default';

              let matchedPort: string | null = null;
              for (const c of cases) {
                if (switchValue === c.value) { matchedPort = c.port; break; }
              }

              const activePort = matchedPort || defaultPort;
              const allPorts = [...cases.map((c: { value: string; port: string }) => c.port), defaultPort];
              const inactivePorts = allPorts.filter((p: string) => p !== activePort);

              const allSkipped = new Set<string>();
              for (const inactivePort of inactivePorts) {
                const toSkip = getNodesExclusivelyDownstreamOfPort(nodeId, inactivePort, comp.edges);
                for (const skipId of toSkip) allSkipped.add(skipId);
              }
              for (const skipId of allSkipped) {
                if (run.nodeStates[skipId]) run.nodeStates[skipId].status = 'skipped';
              }

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.currentStep = matchedPort ? `Matched: ${activePort}` : `Default: ${activePort}`;
              ns.outputVariables = { ...mergedInputs };
              nodeOutputs[nodeId] = { ...mergedInputs };
              run.nodesCompleted++;

              debugLog.info('comp-run', `Switch "${nodeId}" → ${activePort}`, { value: switchValue, skipped: [...allSkipped] });
              continue;
            }

            // ── Text Node ─────────────────────────────────────────
            if (node?.workflowId === '__text__') {
              ns.status = 'running';
              ns.currentStep = 'Outputting text...';
              run.currentNodeId = nodeId;
              const textValue = node.textNode?.value ?? '';
              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = { text: textValue };
              nodeOutputs[nodeId] = { text: textValue };
              run.nodesCompleted++;
              debugLog.info('comp-run', `Text "${nodeId}" outputting ${textValue.length} chars`);
              continue;
            }

            // ── Variable Node ──────────────────────────────────────
            if (node?.workflowId === '__variable__' && node.variableNode) {
              ns.status = 'running';
              ns.currentStep = 'Variable...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              ns.inputVariables = {
                ...(node.variableNode.exposeAsInput && node.variableNode.inputName && Object.prototype.hasOwnProperty.call(initialVariables, node.variableNode.inputName)
                  ? { [node.variableNode.inputName]: initialVariables[node.variableNode.inputName] }
                  : {}),
                ...edgeInputs,
              };

              const outputs = executeVariableNode(node, edgeInputs, initialVariables, nodeOutputs[nodeId]);
              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = outputs;
              nodeOutputs[nodeId] = outputs;
              run.nodesCompleted++;
              debugLog.info('comp-run', `Variable "${nodeId}" value=${JSON.stringify(outputs.value)}`);
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Get Variable Node ──────────────────────────────────
            if (node?.workflowId === '__get_variable__' && node.getVariableNode) {
              ns.status = 'running';
              ns.currentStep = 'Reading variable...';
              run.currentNodeId = nodeId;

              const outputs = executeGetVariableNode(node, nodeOutputs);
              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = outputs;
              nodeOutputs[nodeId] = outputs;
              run.nodesCompleted++;
              debugLog.info('comp-run', `GetVariable "${nodeId}" → target="${node.getVariableNode.targetNodeId}" value=${JSON.stringify(outputs.value)}`);
              continue;
            }

            // ── File Op Node ──────────────────────────────────────
            if (node?.workflowId === '__file_op__' && node.fileOp) {
              ns.status = 'running';
              const fopOperation = node.fileOp.operation || 'copy';
              ns.currentStep = `File ${fopOperation}...`;
              run.currentNodeId = nodeId;

              try {
                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const fopResult = await executeFileOp(fopOperation, edgeInputs);
                fopResult['__done__'] = true;
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = fopResult;
                nodeOutputs[nodeId] = fopResult;
                run.nodesCompleted++;
                debugLog.info('comp-run', `FileOp "${nodeId}" ${fopOperation} completed`, fopResult);
              } catch (fopErr: any) {
                ns.status = 'failed';
                ns.error = fopErr.message || String(fopErr);
                run.done = true;
                run.success = false;
                run.error = `File operation "${node.label || nodeId}" failed: ${ns.error}`;
                debugLog.error('comp-run', `FileOp "${nodeId}" failed`, { error: fopErr.message });
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── JSON Keys/Extract Node ────────────────────────────
            if (node?.workflowId === '__json_keys__') {
              ns.status = 'running';
              ns.currentStep = 'Extracting JSON structure...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              ns.inputVariables = { ...edgeInputs };

              const jkOutputs = executeJsonKeys(edgeInputs, node);

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.currentStep = `${JSON.parse(jkOutputs.keys as string).length} keys, type: ${jkOutputs.type}`;
              ns.outputVariables = jkOutputs;
              nodeOutputs[nodeId] = { ...jkOutputs };
              run.nodesCompleted++;
              debugLog.info('comp-run', `JsonKeys "${nodeId}" extracted keys, type: ${jkOutputs.type}`);
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Asset Node ────────────────────────────────────────
            if (node?.workflowId === '__asset__' && node.asset) {
              ns.status = 'running';
              const assetMode = node.asset.mode || 'pick';
              ns.currentStep = `Asset ${assetMode}...`;
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              try {
                const outputs = await executeAssetNode(ctx, node, edgeInputs, mergedInputs);
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = outputs;
                nodeOutputs[nodeId] = { ...outputs };
                run.nodesCompleted++;
                debugLog.info('comp-run', `Asset "${nodeId}" mode=${assetMode} completed`, { outputs: ns.outputVariables });
              } catch (assetErr: any) {
                ns.status = 'failed';
                ns.error = assetErr?.message || String(assetErr);
                run.done = true;
                run.success = false;
                run.error = `Asset node "${node.label || nodeId}" failed: ${ns.error}`;
                debugLog.error('comp-run', `Asset node "${nodeId}" failed`, { error: ns.error });
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Tool Node (direct tool invocation) ──────────────────
            console.log(`[tool-node-check] nodeId="${nodeId}" wfId="${node?.workflowId}" hasTool=${!!node?.toolNode} toolName="${node?.toolNode?.selectedTool || 'none'}"`);
            if (node?.workflowId === '__tool__' && node.toolNode) {
              console.log(`[tool-node] ENTERING tool execution for node "${nodeId}", tool="${node.toolNode.selectedTool}"`);
              ns.status = 'running';
              const toolName = node.toolNode.selectedTool;
              ns.currentStep = `Running tool: ${toolName}...`;
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              try {
                const outputs = await executeToolNode(ctx, node, edgeInputs);
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = outputs;
                nodeOutputs[nodeId] = { ...outputs };
                run.nodesCompleted++;
                debugLog.info('comp-run', `Tool "${nodeId}" tool=${toolName} completed`, { outputs: ns.outputVariables });
              } catch (toolErr: any) {
                ns.status = 'failed';
                ns.error = toolErr?.message || String(toolErr);
                run.done = true;
                run.success = false;
                run.error = `Tool node "${node.label || nodeId}" failed: ${ns.error}`;
                console.error(`[tool-node] "${toolName}" FAILED:`, toolErr?.message, toolErr?.stack);
                debugLog.error('comp-run', `Tool node "${nodeId}" failed`, { error: ns.error, stack: toolErr?.stack });
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── File Write Node ─────────────────────────────────────
            if (node?.workflowId === '__file_write__' && node.fileWriteNode) {
              ns.status = 'running';
              ns.currentStep = 'Writing file...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              try {
                const outputs = await executeFileWrite(node, edgeInputs, mergedInputs);
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = outputs;
                nodeOutputs[nodeId] = { ...outputs };
                run.nodesCompleted++;
                debugLog.info('comp-run', `File Write "${nodeId}" completed`, { outputs });
              } catch (fwErr: any) {
                ns.status = 'failed';
                ns.error = fwErr?.message || String(fwErr);
                run.done = true;
                run.success = false;
                run.error = `File Write node "${node.label || nodeId}" failed: ${ns.error}`;
                debugLog.error('comp-run', `File Write node "${nodeId}" failed`, { error: ns.error });
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Junction Node (pass-through hub) ──────────────────
            if (node?.workflowId === '__junction__' && node.junctionNode) {
              ns.status = 'running';
              ns.currentStep = 'Passing through...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const junctionOutputs: Record<string, unknown> = {};
              for (const port of node.junctionNode.ports) {
                const portValue = getInputValueByPortName(mergedInputs, port.name);
                if (portValue !== undefined) junctionOutputs[port.name] = portValue;
              }
              junctionOutputs['__done__'] = true;

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.currentStep = 'Done';
              ns.outputVariables = junctionOutputs;
              nodeOutputs[nodeId] = junctionOutputs;
              run.nodesCompleted++;

              debugLog.info('comp-run', `Junction "${nodeId}" pass-through`, { ports: Object.keys(junctionOutputs) });
              continue;
            }

            // ── File Read Node ──────────────────────────────────────
            if (node?.workflowId === '__file_read__') {
              ns.status = 'running';
              ns.currentStep = 'Reading file...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              try {
                const outputs = await executeFileRead(node, edgeInputs, mergedInputs);
                ns.status = 'completed';
                ns.stepsCompleted = 1;
                ns.outputVariables = outputs;
                nodeOutputs[nodeId] = { ...outputs };
                run.nodesCompleted++;
                debugLog.info('comp-run', `File Read "${nodeId}" completed`, { outputs });
              } catch (frErr: any) {
                ns.status = 'failed';
                ns.error = frErr?.message || String(frErr);
                run.done = true;
                run.success = false;
                run.error = `File Read node "${node.label || nodeId}" failed: ${ns.error}`;
                debugLog.error('comp-run', `File Read node "${nodeId}" failed`, { error: ns.error });
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Output Node (collector) ────────────────────────────
            if (node?.workflowId === '__output__' && node.outputNode) {
              ns.status = 'running';
              ns.currentStep = 'Collecting outputs...';
              run.currentNodeId = nodeId;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              ns.inputVariables = { ...mergedInputs };

              const pipelineOutputs: Record<string, unknown> = {};
              for (const port of node.outputNode.ports) {
                pipelineOutputs[port.name] = mergedInputs[port.name];
              }

              ns.status = 'completed';
              ns.stepsCompleted = 1;
              ns.outputVariables = pipelineOutputs;
              nodeOutputs[nodeId] = pipelineOutputs;
              run.pipelineOutputs = pipelineOutputs;
              run.nodesCompleted++;

              debugLog.info('comp-run', `Output node "${nodeId}" collected`, { outputKeys: Object.keys(pipelineOutputs) });
              continue;
            }

            // ── Composition Node (sub-pipeline) ────────────────────
            if (node?.workflowId.startsWith('comp:') && node.compositionRef) {
              ns.status = 'running';
              ns.currentStep = 'Running sub-pipeline...';
              run.currentNodeId = nodeId;
              const subStart = Date.now();

              try {
                const subCompId = node.compositionRef.compositionId;

                const visited = new Set<string>();
                visited.add(id);
                if (visited.has(subCompId)) {
                  throw new Error(`Circular pipeline reference detected: "${subCompId}" is already running`);
                }

                const subDiscovered = await discoverCompositions(ctx.workDir);
                const subFound = subDiscovered.find((d: any) => d.composition.id === subCompId);
                if (!subFound) throw new Error(`Sub-pipeline "${subCompId}" not found`);
                const subComp = subFound.composition;

                const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
                const subInputs: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
                ns.inputVariables = { ...subInputs };

                const subWfMap: Record<string, any> = {};
                for (const subNode of subComp.nodes) {
                  if (isSpecialNode(subNode.workflowId)) continue;
                  const subWfFound = wfDiscovered.find((d: any) => d.workflow.id === subNode.workflowId);
                  if (!subWfFound) throw new Error(`Sub-pipeline workflow "${subNode.workflowId}" not found`);
                  subWfMap[subNode.id] = subWfFound.workflow;
                }

                const subOrder = topoSort(subComp.nodes, subComp.edges);
                const subNodeOutputs: Record<string, Record<string, unknown>> = {};
                let subPipelineOutputs: Record<string, unknown> = {};
                const subNodeStates = initNodeStates(subComp.nodes, subWfMap);
                ns.subExecutionOrder = subOrder;
                ns.subNodeStates = subNodeStates;
                ns.stepsTotal = subOrder.length;
                ns.stepsCompleted = 0;

                for (const subNodeId of subOrder) {
                  if (abort.signal.aborted) break;
                  const subNode = subComp.nodes.find((n: any) => n.id === subNodeId);
                  if (!subNode) continue;
                  const subNs = subNodeStates[subNodeId] || (subNodeStates[subNodeId] = {
                    status: 'pending',
                    workflowId: subNode.workflowId,
                    workflowName: subNode.label || subNodeId,
                    stepsTotal: 1,
                    stepsCompleted: 0,
                    currentStep: '',
                  });
                  subNs.status = 'running';
                  subNs.currentStep = 'Running';
                  ns.currentStep = `Sub-pipeline: ${subNs.workflowName}`;

                  if (subNode.workflowId === '__output__' && subNode.outputNode) {
                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                    for (const port of subNode.outputNode.ports) {
                      subPipelineOutputs[port.name] = subMerged[port.name];
                    }
                    subNodeOutputs[subNodeId] = subPipelineOutputs;
                    subNs.status = 'completed';
                    subNs.stepsCompleted = subNs.stepsTotal || 1;
                    subNs.currentStep = 'Done';
                    subNs.outputVariables = subPipelineOutputs;
                    ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                    continue;
                  }

                  if (subNode.workflowId === '__approval_gate__') {
                    const gateEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    subNodeOutputs[subNodeId] = { ...subInputs, ...gateEdgeInputs };
                    subNs.status = 'completed';
                    subNs.stepsCompleted = subNs.stepsTotal || 1;
                    subNs.currentStep = 'Done';
                    subNs.outputVariables = subNodeOutputs[subNodeId];
                    ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                    continue;
                  }

                  if (subNode.workflowId === '__junction__' && subNode.junctionNode) {
                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                    const junctionOutputs: Record<string, unknown> = {};
                    for (const port of subNode.junctionNode.ports || []) {
                      if (port && typeof port.name === 'string') {
                        const portValue = getInputValueByPortName(subMerged, port.name);
                        if (portValue !== undefined) {
                          junctionOutputs[port.name] = portValue;
                        }
                      }
                    }
                    junctionOutputs.__done__ = true;
                    subNodeOutputs[subNodeId] = junctionOutputs;
                    subNs.inputVariables = { ...subMerged };
                    subNs.status = 'completed';
                    subNs.stepsCompleted = subNs.stepsTotal || 1;
                    subNs.currentStep = 'Done';
                    subNs.outputVariables = junctionOutputs;
                    ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                    continue;
                  }

                  if (subNode.workflowId === '__script__' && subNode.script) {
                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                    subNs.inputVariables = { ...subMerged };

                    try {
                      const subResult = await runScriptNodeWithAutoFix({
                        ctx,
                        node: subNode,
                        nodeId: subNodeId,
                        mergedInputs: subMerged,
                        composition: subComp,
                        compositionPath: subFound.path,
                        nodes: subComp.nodes,
                        edges: subComp.edges,
                        nodeOutputs: subNodeOutputs,
                        wfMap: subWfMap,
                        locationLabel: `${comp.name} / ${node.label || nodeId} / ${subComp.name} / ${subNode.label || subNodeId}`,
                        updateCurrentStep: (step) => {
                          subNs.currentStep = step;
                          ns.currentStep = `Sub-pipeline: ${subNs.workflowName} - ${step}`;
                        },
                        recomputeInputs: () => ({
                          ...subInputs,
                          ...gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs),
                        }),
                      });

                      subNodeOutputs[subNodeId] = subResult.outputs || {};
                      subNs.logs = subResult.logs;
                      subNs.inputVariables = { ...(subResult.repairedInputs || subMerged) };
                      subNs.status = 'completed';
                      subNs.stepsCompleted = subNs.stepsTotal || 1;
                      subNs.currentStep = 'Done';
                      subNs.outputVariables = subNodeOutputs[subNodeId];
                      ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                      continue;
                    } catch (subScriptErr: any) {
                      subNs.logs = Array.isArray(subScriptErr?.logs) ? subScriptErr.logs : [];
                      subNs.status = 'failed';
                      subNs.error = subScriptErr?.message || String(subScriptErr);
                      subNs.currentStep = 'Failed';
                      throw new Error(`Script node "${subNs.workflowName}" failed: ${subNs.error}`);
                    }
                  }

                  if (subNode.workflowId === '__image_viewer__' && subNode.imageViewer) {
                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                    const imgPath = subMerged['file_path'] ?? subNode.imageViewer.filePath;
                    subNodeOutputs[subNodeId] = { file_path: imgPath };
                    subNs.status = 'completed';
                    subNs.stepsCompleted = subNs.stepsTotal || 1;
                    subNs.currentStep = 'Done';
                    subNs.outputVariables = subNodeOutputs[subNodeId];
                    ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                    continue;
                  }

                  if (subNode.workflowId === '__media__' && subNode.mediaPlayer) {
                    const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                    const subMerged: Record<string, unknown> = { ...subInputs, ...subEdgeInputs };
                    const mediaPath = subMerged['file_path'] ?? subNode.mediaPlayer.filePath;
                    const ext = typeof mediaPath === 'string' ? (mediaPath.split('.').pop() || '').toLowerCase() : '';
                    let mType = subNode.mediaPlayer.mediaType || 'auto';
                    if (mType === 'auto') {
                      if (['mp4','mov','avi','webm','mkv'].includes(ext)) mType = 'video';
                      else if (['mp3','wav','ogg','aac','flac','m4a'].includes(ext)) mType = 'audio';
                      else if (['jpg','jpeg','png','gif','bmp','svg','webp','tiff','ico'].includes(ext)) mType = 'image';
                      else if (ext === 'pdf') mType = 'pdf';
                      else mType = 'text';
                    }
                    subNodeOutputs[subNodeId] = { file_path: mediaPath, media_type: mType };
                    subNs.status = 'completed';
                    subNs.stepsCompleted = subNs.stepsTotal || 1;
                    subNs.currentStep = 'Done';
                    subNs.outputVariables = subNodeOutputs[subNodeId];
                    ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                    continue;
                  }

                  const subWf = subWfMap[subNodeId];
                  if (!subWf) continue;

                  const subEdgeInputs = gatherInputVariables(subNodeId, subComp.edges, subNodeOutputs);
                  const subMergedVars: Record<string, unknown> = {};
                  for (const v of (subWf.variables || [])) {
                    if (v.default !== undefined) subMergedVars[v.name] = v.default;
                  }
                  Object.assign(subMergedVars, subInputs, subEdgeInputs);
                  if (subNode.inputOverrides) {
                    for (const [k, v] of Object.entries(subNode.inputOverrides)) {
                      subMergedVars[k] = v;
                    }
                  }

                  ns.currentStep = `Sub-pipeline: ${subWf.name}`;
                  subNs.currentStep = subWf.name;

                  const subResult = await executeWorkflow(bridgeServer, subWf, subMergedVars, {
                    log: (msg: string) => {
                      debugLog.info('comp-run', `[sub:${subWf.name}] ${msg}`);
                      if (!ns.logs) ns.logs = [];
                      if (ns.logs.length < 200) ns.logs.push(msg);
                      if (!subNs.logs) subNs.logs = [];
                      if (subNs.logs.length < 200) subNs.logs.push(msg);
                    },
                    signal: abort.signal,
                  });
                  subNodeOutputs[subNodeId] = subResult.variables || {};
                  subNs.status = 'completed';
                  subNs.stepsCompleted = subNs.stepsTotal || 1;
                  subNs.currentStep = 'Done';
                  subNs.outputVariables = subNodeOutputs[subNodeId];
                  ns.stepsCompleted = Math.min(subOrder.length, (ns.stepsCompleted || 0) + 1);
                }

                ns.durationMs = Date.now() - subStart;
                ns.status = 'completed';
                ns.stepsCompleted = subOrder.length;
                ns.currentStep = 'Done';
                ns.outputVariables = subPipelineOutputs;
                run.nodesCompleted++;
                nodeOutputs[nodeId] = subPipelineOutputs;

                debugLog.info('comp-run', `Composition node "${nodeId}" completed`, {
                  subCompId: node.compositionRef.compositionId,
                  outputKeys: Object.keys(subPipelineOutputs),
                  durationMs: ns.durationMs,
                });
              } catch (compErr: any) {
                ns.durationMs = Date.now() - subStart;
                ns.status = 'failed';
                ns.error = `Sub-pipeline error: ${compErr?.message || String(compErr)}`;
                debugLog.error('comp-run', `Composition node "${nodeId}" failed`, { error: String(compErr) });

                const compPolicy = node.onFailure || { action: 'stop' as const };
                if (compPolicy.action === 'skip') {
                  ns.status = 'skipped';
                  continue;
                } else {
                  const downstream = getDownstreamNodes(nodeId, comp.edges);
                  for (const downId of downstream) {
                    if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                  }
                  pipelineHadFailure = true;
                  pipelineFirstError = pipelineFirstError || ns.error || 'Unknown error';
                  debugLog.info('comp-run', `Node "${nodeId}" failed, skipping ${downstream.size} downstream nodes, continuing pipeline`);
                  continue;
                }
              }
              if (isIdempotent && ns.status === 'completed') await saveIdempotencyCache(id, idempotencyHash, nodeOutputs[nodeId]);
              continue;
            }

            // ── Regular workflow node (with retry logic) ──────────
            const policy = node?.onFailure || { action: 'stop' as const };
            const maxAttempts = (policy.action === 'retry' && policy.retry)
              ? policy.retry.maxAttempts
              : 1;
            const retryDelayMs = (policy.action === 'retry' && policy.retry)
              ? policy.retry.delayMs
              : 1000;
            const backoffMultiplier = (policy.action === 'retry' && policy.retry?.backoffMultiplier)
              ? policy.retry.backoffMultiplier
              : 1;

            run.currentNodeId = nodeId;
            let nodeSuccess = false;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              if (abort.signal.aborted) break;

              ns.status = attempt > 1 ? 'retrying' : 'running';
              ns.retryAttempt = attempt;
              ns.retryMax = maxAttempts;
              ns.stepsCompleted = 0;
              ns.error = undefined;
              ns.expectationResults = undefined;

              const edgeInputs = gatherInputVariables(nodeId, comp.edges, nodeOutputs);
              const mergedVars: Record<string, unknown> = { ...initialVariables, ...edgeInputs };
              for (const v of (wf.variables || [])) {
                if (mergedVars[v.name] === undefined && v.default !== undefined) {
                  mergedVars[v.name] = v.default;
                }
              }

              // Auto-generate variables with AI prompts
              const toGenerate = ((wf.variables || []) as any[]).filter(
                (v: any) => v.generationPrompt && (mergedVars[v.name] === undefined || mergedVars[v.name] === '')
              );
              if (toGenerate.length > 0) {
                try {
                  const { runPrompt } = await import('../../loop/llm-service.js');
                  const model = process.env.ANTHROPIC_API_KEY
                    ? 'claude-sonnet-4-20250514'
                    : process.env.OPENAI_API_KEY
                      ? 'gpt-4o-mini'
                      : process.env.GROQ_API_KEY
                        ? 'llama-3.1-70b-versatile'
                        : 'claude-sonnet-4-20250514';
                  for (const v of toGenerate) {
                    try {
                      const genPrompt = `You are generating a value for a variable in a browser automation workflow.\n\nVariable: "${v.name}" (type: ${v.type || 'string'})\nWorkflow: "${wf.name}" on ${wf.site || 'unknown site'}\n\nInstructions from the user:\n${v.generationPrompt}\n\nRules:\n- Follow the user's instructions precisely\n- Be creative and original for text/lyrics/content\n- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation\n- If the type is a number, return just the number\n- If the type is boolean, return just "true" or "false"\n- For multi-line content (lyrics, paragraphs), use actual newlines`;
                      const llmResponse = await runPrompt(
                        [{ role: 'user', content: genPrompt }],
                        model,
                        { maxTokens: 2048, temperature: 0.9 }
                      );
                      mergedVars[v.name] = llmResponse.content.trim();
                    } catch { /* non-fatal */ }
                  }
                } catch { /* LLM import failed, skip */ }
              }

              ns.inputVariables = { ...mergedVars };

              debugLog.info('comp-run', `Executing node "${nodeId}" attempt ${attempt}/${maxAttempts} (workflow: ${wf.name})`, {
                inputVars: Object.keys(mergedVars),
              });

              try {
                const result = await executeWorkflow(bridgeServer, wf, mergedVars, {
                  log: (msg: string) => {
                    debugLog.info('comp-run', `[${wf.name}] ${msg}`);
                    if (!ns.logs) ns.logs = [];
                    if (ns.logs.length < 200) ns.logs.push(msg);
                  },
                  signal: abort.signal,
                  onProgress: (event: any) => {
                    if (event.type === 'step_start') {
                      ns.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
                    } else if (event.type === 'step_complete') {
                      ns.stepsCompleted = event.index + 1;
                    }
                  },
                });

                if (result.success) {
                  const expectations: Expectation[] = [
                    ...((wf.expectations as Expectation[]) || []),
                    ...((node?.expectations as Expectation[]) || []),
                  ];

                  if (expectations.length > 0) {
                    const expResults = await checkExpectations(expectations, result.variables);
                    ns.expectationResults = expResults.map(r => ({
                      description: r.expectation.description || r.detail,
                      passed: r.passed,
                      detail: r.detail,
                    }));

                    const failed = expResults.filter(r => !r.passed);
                    if (failed.length > 0) {
                      const failDescs = failed.map(f => f.detail).join('; ');
                      debugLog.info('comp-run', `Node "${nodeId}" expectations failed (attempt ${attempt}/${maxAttempts})`, { failDescs });

                      if (attempt < maxAttempts) {
                        const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                      }

                      ns.status = 'failed';
                      ns.error = `Expectations not met: ${failDescs}`;
                      ns.durationMs = result.durationMs;
                      break;
                    }
                  }

                  ns.status = 'completed';
                  ns.outputVariables = result.variables;
                  ns.durationMs = result.durationMs;
                  ns.stepsCompleted = ns.stepsTotal;
                  nodeOutputs[nodeId] = result.variables;
                  run.nodesCompleted++;
                  nodeSuccess = true;
                  debugLog.info('comp-run', `Node "${nodeId}" completed`, {
                    outputVars: Object.keys(result.variables),
                    durationMs: result.durationMs,
                  });
                  break;
                } else {
                  if (attempt < maxAttempts) {
                    debugLog.info('comp-run', `Node "${nodeId}" failed (attempt ${attempt}/${maxAttempts}), retrying...`, { error: result.error });
                    const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                  }

                  ns.status = 'failed';
                  ns.error = result.error;
                  ns.durationMs = result.durationMs;
                  break;
                }
              } catch (stepErr: any) {
                if (attempt < maxAttempts) {
                  debugLog.info('comp-run', `Node "${nodeId}" threw error (attempt ${attempt}/${maxAttempts}), retrying...`, { error: String(stepErr) });
                  const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
                  await new Promise(r => setTimeout(r, delay));
                  continue;
                }

                ns.status = 'failed';
                ns.error = String(stepErr);
                break;
              }
            } // end retry loop

            // Handle node failure based on policy
            if (!nodeSuccess && ns.status === 'failed') {
              if (policy.action === 'skip') {
                ns.status = 'skipped';
                debugLog.info('comp-run', `Node "${nodeId}" failed but policy is 'skip', continuing pipeline`);
                continue;
              } else {
                const downstream = getDownstreamNodes(nodeId, comp.edges);
                for (const downId of downstream) {
                  if (run.nodeStates[downId]) run.nodeStates[downId].status = 'skipped';
                }
                pipelineHadFailure = true;
                pipelineFirstError = pipelineFirstError || `"${wf.name}" failed: ${ns.error}`;
                debugLog.info('comp-run', `Node "${nodeId}" failed, skipping ${downstream.size} downstream nodes, continuing pipeline`, { error: ns.error });
                continue;
              }
            }
          }

          // All reachable nodes have been processed
          if (!run.done) {
            run.done = true;
            run.success = !pipelineHadFailure;
            run.durationMs = Date.now() - run.startedAt;
            run.currentNodeId = null;
            if (pipelineHadFailure) {
              run.error = pipelineFirstError;
              debugLog.info('comp-run', `Composition "${comp.name}" finished with failures`, {
                nodes: run.nodesCompleted,
                durationMs: run.durationMs,
                error: pipelineFirstError,
              });
            } else {
              debugLog.info('comp-run', `Composition "${comp.name}" completed successfully`, {
                nodes: run.nodesCompleted,
                durationMs: run.durationMs,
              });
            }
            await finalizeCompRunRecord(compRunId, run, executionOrder);
          }
        } catch (err) {
          run.done = true;
          run.success = false;
          run.error = String(err);
          run.durationMs = Date.now() - run.startedAt;
          debugLog.error('comp-run', `Composition "${comp.name}" crashed`, { error: String(err) });
          await finalizeCompRunRecord(compRunId, run, executionOrder);
        }
      })();

    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/compositions/run/status — poll composition execution progress
  if (req.method === 'GET' && pathname === '/api/compositions/run/status') {
    if (!ctx.activeCompRun) {
      sendJson(res, 200, { active: false });
      return true;
    }
    // Include any pending approvals for this run
    const runApprovals: PendingApproval[] = [];
    for (const [, entry] of ctx.pendingApprovals) {
      if (ctx.activeCompRun.runId && entry.approval.runId === ctx.activeCompRun.runId) {
        runApprovals.push(entry.approval);
      }
    }

    sendJson(res, 200, {
      active: !ctx.activeCompRun.done,
      done: ctx.activeCompRun.done,
      runId: ctx.activeCompRun.runId,
      success: ctx.activeCompRun.success,
      compositionId: ctx.activeCompRun.compositionId,
      compositionName: ctx.activeCompRun.compositionName,
      nodesTotal: ctx.activeCompRun.nodesTotal,
      nodesCompleted: ctx.activeCompRun.nodesCompleted,
      currentNodeId: ctx.activeCompRun.currentNodeId,
      executionOrder: ctx.activeCompRun.executionOrder,
      nodeStates: ctx.activeCompRun.nodeStates,
      pendingApprovals: runApprovals,
      error: ctx.activeCompRun.error,
      durationMs: ctx.activeCompRun.done ? ctx.activeCompRun.durationMs : Date.now() - ctx.activeCompRun.startedAt,
      pipelineOutputs: ctx.activeCompRun.pipelineOutputs,
    });
    return true;
  }

  // POST /api/compositions/run/cancel — abort a running composition
  if (req.method === 'POST' && pathname === '/api/compositions/run/cancel') {
    if (!ctx.activeCompRun || ctx.activeCompRun.done) {
      sendJson(res, 400, { error: 'Nothing is running right now' });
      return true;
    }
    ctx.activeCompRun.abort.abort();
    // Reject any pending approvals for this run
    for (const [approvalId, entry] of ctx.pendingApprovals) {
      if (ctx.activeCompRun.runId && entry.approval.runId === ctx.activeCompRun.runId) {
        if (entry.timer) clearTimeout(entry.timer);
        ctx.pendingApprovals.delete(approvalId);
        entry.resolve(false);
      }
    }
    // Mark running/retrying node as failed, pending nodes as skipped
    for (const nodeId in ctx.activeCompRun.nodeStates) {
      const ns = ctx.activeCompRun.nodeStates[nodeId];
      if (ns.status === 'running' || ns.status === 'retrying') ns.status = 'failed';
      if (ns.status === 'pending') ns.status = 'skipped';
    }
    ctx.activeCompRun.done = true;
    ctx.activeCompRun.success = false;
    ctx.activeCompRun.error = 'Cancelled by user';
    ctx.activeCompRun.durationMs = Date.now() - ctx.activeCompRun.startedAt;

    if (ctx.activeCompRun.runId) {
      const nodeResults: NodeRunResult[] = ctx.activeCompRun.executionOrder.map(nId => {
        const ns = ctx.activeCompRun!.nodeStates[nId];
        return {
          nodeId: nId,
          workflowId: ns.workflowId,
          workflowName: ns.workflowName,
          status: ns.status === 'completed' ? 'completed' as const : ns.status === 'skipped' ? 'skipped' as const : 'failed' as const,
          durationMs: ns.durationMs || 0,
          stepsTotal: ns.stepsTotal,
          stepsCompleted: ns.stepsCompleted,
          error: ns.error,
        };
      });
      updateRunRecord(ctx.activeCompRun.runId, {
        completedAt: new Date().toISOString(),
        durationMs: ctx.activeCompRun.durationMs,
        status: 'cancelled',
        error: 'Cancelled by user',
        nodesCompleted: ctx.activeCompRun.nodesCompleted,
        nodeResults,
      }).catch(() => {});
    }

    sendJson(res, 200, { success: true, message: 'Composition cancelled' });
    return true;
  }

  return false;
};
