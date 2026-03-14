/**
 * Dashboard Route: Generation
 *
 * Handles AI-powered generation endpoints:
 * - POST /api/autofill — AI-powered variable value generation
 * - POST /api/generate-variable — AI generation for a single variable using its custom prompt
 * - POST /api/compositions/generate-script — AI-powered code generation for script nodes
 * - POST /api/compositions/generate-pipeline — AI-powered pipeline decomposition
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler, ScriptToolDoc } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import type { ToolDefinition } from '../../loop/types.js';
import { debugLog } from '../../debug-log.js';
import { formatPublishedSkillsPromptSection } from '../../skill-builder/storage.js';
import {
  runGeneratedScriptUnitTests,
  type ScriptGenerationTestCase,
} from '../script-generation-tests.js';

interface ScriptGenerationTranscriptEntry {
  stage: 'request' | 'generation' | 'repair' | 'fallback' | 'validation' | 'tests' | 'verification' | 'checks';
  title: string;
  content: string;
}

interface ScriptGenerationTraceEvent {
  type: 'assistant' | 'tool_start' | 'tool_end';
  stopReason?: string;
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; input?: unknown }>;
  toolName?: string;
  params?: unknown;
  success?: boolean;
  result?: string;
  durationMs?: number;
}

interface ScriptGenerationLifecycle {
  designedPlan: string;
  validationIssues: string[];
  repaired: boolean;
  verificationSummary: string;
  selectedSkills: string[];
  toolNames: string[];
  transcript: ScriptGenerationTranscriptEntry[];
}

interface PipelineScriptNodeGenerationResult {
  description: string;
  code: string;
  inputs: Array<{ name: string; type: string; description: string }>;
  outputs: Array<{ name: string; type: string; description: string }>;
  assistantMessage?: string;
  transcript: ScriptGenerationTranscriptEntry[];
  regenerated: boolean;
}

interface PipelinePortContract {
  name: string;
  type: string;
  description: string;
}

function shouldUseDirectScriptGeneration(mode: ScriptGenerationMode): boolean {
  return mode === 'generate' || mode === 'edit' || mode === 'repair' || mode === 'verify';
}

// ── Constants ────────────────────────────────────────────────
const SCRIPT_TOOL_DOCS_PATH = join(homedir(), '.woodbury', 'data', 'script-tool-docs.json');

// ── Local helpers ────────────────────────────────────────────

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

    // Include parameter descriptions from JSON Schema
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

    // Include return type documentation
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

function parseScriptPorts(code: string): { inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }> } {
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  const outputs: Array<{ name: string; type: string; description: string }> = [];
  const regex = /@(input|output)\s+(\w+)\s+(string|number|boolean|object|string\[\]|number\[\]|object\[\])\s*(?:"([^"]*)")?/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const decl = { name: match[2], type: match[3], description: match[4] || '' };
    (match[1] === 'input' ? inputs : outputs).push(decl);
  }
  return { inputs, outputs };
}

function extractCodeBlock(content: string): string {
  const codeBlockMatch = content.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
  return codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();
}

function requiresWoodburyCollectionToolUsage(userMessage: string): boolean {
  const lower = String(userMessage || '').toLowerCase();
  return /(woodbury collection|collection tools|creator assets|asset_collection|asset library)/.test(lower);
}

function validateGeneratedScriptCode(
  code: string,
  options?: { userMessage?: string },
): { ok: boolean; issues: string[]; ports: { inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }> } } {
  const issues: string[] = [];
  const ports = parseScriptPorts(code);

  if (!/\/\*\*[\s\S]*?\*\//.test(code)) {
    issues.push('Missing JSDoc block with @input/@output annotations.');
  }
  if (!/@input\s+/m.test(code)) {
    issues.push('Missing at least one @input annotation.');
  }
  if (!/@output\s+/m.test(code)) {
    issues.push('Missing at least one @output annotation.');
  }
  if (!/async\s+function\s+execute\s*\(\s*inputs\s*,\s*context\s*\)/.test(code)) {
    issues.push('Missing required async function execute(inputs, context) signature.');
  }
  if (!/return\s*\{[\s\S]*\}/.test(code)) {
    issues.push('Missing object return statement for declared outputs.');
  }

  try {
    // Parse only; this does not execute the generated code.
    // Wrapping in parentheses avoids top-level declaration parsing edge cases.
    // eslint-disable-next-line no-new, no-new-func
    new Function(`${code}\nreturn typeof execute === 'function';`);
  } catch (err) {
    issues.push(`JavaScript syntax error: ${(err as Error).message}`);
  }

  if (requiresWoodburyCollectionToolUsage(options?.userMessage || '')) {
    const usesWoodburyCollectionTool = /asset_collection_create|asset_collection_list|asset_collection_get|asset_save/.test(code);
    if (!usesWoodburyCollectionTool) {
      issues.push('Missing required Woodbury asset/collection tool usage. Use context.tools.asset_collection_create, context.tools.asset_collection_list/get, or context.tools.asset_save when the request explicitly asks for Woodbury collection tools.');
    }
  }

  return { ok: issues.length === 0, issues, ports };
}

function buildScriptRequestMessage(
  description: unknown,
  dataContext: unknown,
  graphContext: unknown,
  currentCode: unknown,
): string {
  let userMessage = typeof description === 'string' ? description : '';
  if (dataContext) {
    userMessage += `\n\nThe input data for this script looks like this (sample from a previous pipeline run):\n\`\`\`json\n${typeof dataContext === 'string' ? dataContext : JSON.stringify(dataContext, null, 2)}\n\`\`\`\nUse this to understand the exact data structure and write code that handles it correctly. Make sure the first @input annotation matches the type of this data (it will be auto-connected to the source port). IMPORTANT: If the user's description references any other dynamic values (like keys, indices, filters, thresholds, etc.), create ADDITIONAL @input ports for each one. Every variable parameter should be its own input port so it can be wired from other nodes in the pipeline.`;
  }
  if (graphContext) {
    userMessage += `\n\nRelevant pipeline graph context:\n${typeof graphContext === 'string' ? graphContext : JSON.stringify(graphContext, null, 2)}\nUse this to understand what upstream or related nodes already provide, what values are available, and how this script should fit into the surrounding pipeline.`;
  }
  if (currentCode) {
    userMessage += `\n\nCurrent code:\n\`\`\`javascript\n${typeof currentCode === 'string' ? currentCode : JSON.stringify(currentCode, null, 2)}\n\`\`\``;
  }
  return userMessage.trim();
}

function buildWoodburyBuiltinToolingGuidance(userMessage: string): string {
  const lower = String(userMessage || '').toLowerCase();
  if (!/(asset|collection|storyboard|woodbury collection|woodbury asset|save assets|asset library)/.test(lower)) {
    return '';
  }

  return [
    'This request involves Woodbury-native asset or collection behavior.',
    'Prefer Woodbury runtime collection and asset functions over ad-hoc object creation, local JSON persistence, or invented helper APIs.',
    'Use the real Creator Assets tool names exposed through context.tools when available.',
    'For collection creation or lookup, prefer context.tools.asset_collection_create, context.tools.asset_collection_list, or context.tools.asset_collection_get.',
    'For saving files into the library, use context.tools.asset_save and pass the Woodbury collection slug or name via the collection field.',
    'Do not simulate Woodbury collections by returning plain arrays or detached objects when the user explicitly asked to use Woodbury collection tools.',
  ].join(' ');
}

const SCRIPT_PROGRESS_GUIDANCE = [
  'When generating script-node code with long-running loops, use context.progress.start(total, label), context.progress.set(completed, total, label), context.progress.increment(label), and context.progress.complete(label) so the node UI can show a progress bar while the script runs.',
].join(' ');

type ScriptGenerationMode = 'generate' | 'edit' | 'repair' | 'verify';

const SCRIPT_GENERATION_BASE_TOOLS = [
  'memory_recall',
  'goal_contract',
  'reflect',
];

const SCRIPT_GENERATION_EXECUTION_TOOLS = [
  'code_execute',
  'test_run',
];

function getScriptGenerationAllowedTools(mode: ScriptGenerationMode): string[] {
  if (mode === 'edit' || mode === 'repair' || mode === 'verify') {
    return SCRIPT_GENERATION_BASE_TOOLS.concat(SCRIPT_GENERATION_EXECUTION_TOOLS);
  }
  return SCRIPT_GENERATION_BASE_TOOLS.slice();
}

function getScriptGenerationModeGuidance(mode: ScriptGenerationMode): string {
  if (mode === 'edit') {
    return [
      'This is an explicit code edit flow for an existing script.',
      'You must update the provided code to satisfy the request, then verify the updated result.',
      'Execution evidence can be useful after editing.',
      'If necessary, you may use code_execute or test_run to validate the updated script before returning the final JavaScript code block.',
      'Do not use execution tools unless they materially improve confidence in the edit.',
    ].join(' ');
  }

  if (mode === 'repair' || mode === 'verify') {
    return [
      'This is an explicit repair or verification flow.',
      'Execution evidence can be useful here.',
      'If necessary, you may use code_execute or test_run to validate a repair before returning the final JavaScript code block.',
      'Do not use execution tools unless they materially improve confidence in the repair or verification.',
    ].join(' ');
  }

  return [
    'This is a normal script generation flow.',
    'Execution tools are unavailable in this mode.',
    'Do not call code_execute or test_run.',
    'Rely on reasoning, structural validation, and the scoped non-execution tools only.',
  ].join(' ');
}

function getScriptEditGuidance(userMessage: string, hasCurrentCode: boolean): string {
  const lower = String(userMessage || '').toLowerCase();
  const guidance: string[] = [];

  if (hasCurrentCode) {
    guidance.push(
      'Current code is provided. Treat this as an edit request.',
      'Modify the existing script to satisfy the new requirement and return the full updated script.',
      'Do not describe changes, summarize intent, or return pseudocode. Return the actual rewritten JavaScript.',
      'Preserve existing structure, annotations, inputs, outputs, and behavior unless the request explicitly changes them.',
    );
  }

  if (/(scene by scene|each scene|one scene at a time|one-by-one|one by one|sequential)/.test(lower)) {
    guidance.push(
      'If the request says to process scenes one-by-one, implement explicit per-scene iteration.',
      'Do not generate the full scenes array with a single LLM call when the request asks for scene-by-scene generation.',
      'Instead, parse or derive the list of planned scenes first, then generate each scene individually inside a loop and accumulate the results.',
    );
  }

  return guidance.join(' ');
}

function getScriptGenerationProviderAndModel(): { provider: 'openai' | 'anthropic' | 'groq'; model: string } {
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: 'gpt-4o-mini' };
  if (process.env.GROQ_API_KEY) return { provider: 'groq', model: 'llama-3.1-70b-versatile' };
  return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
}

async function generateScriptUnitTestCases(
  userMessage: string,
  code: string,
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
): Promise<ScriptGenerationTestCase[]> {
  const { runPrompt } = await import('../../loop/llm-service.js');
  const providerAndModel = getScriptGenerationProviderAndModel();
  const response = await runPrompt([
    {
      role: 'system',
      content: 'You create deterministic unit test cases for Woodbury script-node code. Return ONLY a JSON array. Each item must use this shape: { "name": string, "inputs": object, "llmGenerate"?: string, "llmGenerateJSON"?: object, "expectedOutputSubset"?: object, "requiredOutputKeys"?: string[] }. Prefer 1-3 tests. Avoid filesystem, network, or nondeterministic assertions. Only include assertions you can predict with confidence. Do NOT assert exact large arrays, exact parsed natural-language structures, or exact nested object payloads unless they are trivially derivable from literal inputs. Prefer requiredOutputKeys and small scalar subsets.',
    },
    {
      role: 'user',
      content: `Request:\n${userMessage}\n\nDeclared inputs:\n${JSON.stringify(inputs, null, 2)}\n\nDeclared outputs:\n${JSON.stringify(outputs, null, 2)}\n\nCode:\n\`\`\`javascript\n${code}\n\`\`\``,
    },
  ], providerAndModel.model, { maxTokens: 1200, temperature: 0.1 });

  const raw = response.content.trim();
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  const parsed = JSON.parse((match[1] || raw).trim());
  if (!Array.isArray(parsed)) return [];
  return sanitizeScriptGenerationTestCases(parsed, outputs).slice(0, 3);
}

function isSafeExpectedSubsetValue(value: unknown, depth = 0): boolean {
  if (value == null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return false;
  if (typeof value !== 'object') return false;
  if (depth >= 2) return false;
  return Object.values(value as Record<string, unknown>).every(child => isSafeExpectedSubsetValue(child, depth + 1));
}

function isOverSpecificStringExpectation(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 120 || /\r|\n/.test(trimmed) || /^[\[{]/.test(trimmed);
}

function sanitizeExpectedOutputSubset(
  rawSubset: unknown,
  outputs: Array<{ name: string; type: string; description: string }>,
): Record<string, unknown> | undefined {
  if (!isSafeExpectedSubsetValue(rawSubset) || !rawSubset || typeof rawSubset !== 'object' || Array.isArray(rawSubset)) {
    return undefined;
  }

  const outputTypeByName = new Map(outputs.map((output) => [output.name, output.type]));
  const sanitizedEntries = Object.entries(rawSubset as Record<string, unknown>)
    .filter(([key]) => outputTypeByName.has(key))
    .filter(([, value]) => value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    .filter(([key, value]) => {
      if (typeof value !== 'string') return true;
      const outputType = outputTypeByName.get(key) || 'string';
      if (outputType !== 'string') return false;
      return !isOverSpecificStringExpectation(value);
    });

  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

function sanitizeScriptGenerationTestCases(
  rawCases: unknown[],
  outputs: Array<{ name: string; type: string; description: string }>,
): ScriptGenerationTestCase[] {
  const declaredOutputNames = outputs.map(output => output.name).filter(Boolean);
  const sanitized: ScriptGenerationTestCase[] = [];

  for (const rawCase of rawCases) {
    if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) continue;
    const candidate = rawCase as Record<string, unknown>;
    const name = typeof candidate.name === 'string' && candidate.name.trim()
      ? candidate.name.trim()
      : `generated_test_${sanitized.length + 1}`;
    const inputs = candidate.inputs && typeof candidate.inputs === 'object' && !Array.isArray(candidate.inputs)
      ? candidate.inputs as Record<string, unknown>
      : {};
    const requiredOutputKeys = Array.isArray(candidate.requiredOutputKeys)
      ? candidate.requiredOutputKeys.filter((key): key is string => typeof key === 'string' && declaredOutputNames.includes(key))
      : [];
    const expectedOutputSubset = sanitizeExpectedOutputSubset(candidate.expectedOutputSubset, outputs);

    if (requiredOutputKeys.length === 0 && declaredOutputNames.length > 0 && !expectedOutputSubset) {
      requiredOutputKeys.push(...declaredOutputNames);
    }

    sanitized.push({
      name,
      inputs,
      llmGenerate: typeof candidate.llmGenerate === 'string' ? candidate.llmGenerate : undefined,
      llmGenerateJSON: candidate.llmGenerateJSON,
      expectedOutputSubset,
      requiredOutputKeys: requiredOutputKeys.length > 0 ? Array.from(new Set(requiredOutputKeys)) : undefined,
    });
  }

  return sanitized;
}

async function runScopedScriptGenerationPass(
  ctx: DashboardContext,
  objective: string,
  options?: { chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; sessionSuffix?: string; mode?: ScriptGenerationMode },
): Promise<{ content: string; selectedSkills: string[]; toolNames: string[]; trace: ScriptGenerationTraceEvent[] }> {
  const [{ createDefaultToolRegistry }, { convertAllTools }, { ToolRegistryV2 }, { buildV3SystemPrompt }, { ClosureEngine }] = await Promise.all([
    import('../../loop/index.js'),
    import('../../loop/v2/tools/native-converter.js'),
    import('../../loop/v2/tools/registry-v2.js'),
    import('../../loop/v3/system-prompt-v3.js'),
    import('../../loop/v3/closure-engine.js'),
  ]);

  const baseRegistry = createDefaultToolRegistry();
  const nativeTools = convertAllTools(baseRegistry.getAll?.() || []);
  const mode = options?.mode || 'generate';
  const allowed = new Set(getScriptGenerationAllowedTools(mode));
  const scopedRegistry = new ToolRegistryV2({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  for (const tool of nativeTools) {
    if (allowed.has(tool.definition.name)) {
      scopedRegistry.register(tool.definition, tool.handler, { dangerous: tool.dangerous });
    }
  }

  const basePrompt = await buildV3SystemPrompt(
    ctx.workDir,
    undefined,
    ctx.extensionManager?.getAllPromptSections(),
    scopedRegistry.getAllDefinitions(),
  );
  const systemPrompt = `${basePrompt}\n\n## Script Node Generation\nYou are generating or repairing code for a Woodbury __script__ node. This is not a repository editing task. Use only the scoped tools available for planning, reasoning, validation, and repair. ${getScriptGenerationModeGuidance(mode)} The final answer must be a single JavaScript code block and nothing else.`;
  const providerAndModel = getScriptGenerationProviderAndModel();
  const selectedSkills: string[] = [];
  const toolNames: string[] = [];
  const trace: ScriptGenerationTraceEvent[] = [];
  const engine = new ClosureEngine({
    provider: providerAndModel.provider,
    model: providerAndModel.model,
    sessionId: `dashboard-script-generation-${Date.now()}-${options?.sessionSuffix || 'run'}`,
    continuationMode: 'off',
    maxIterations: 18,
    maxTaskRetries: 2,
    timeout: 120000,
    toolTimeout: 15000,
    temperature: 0.1,
    workingDirectory: ctx.workDir,
    allowDangerousTools: mode === 'edit' || mode === 'repair' || mode === 'verify',
    streaming: false,
    reflectionInterval: 4,
    callbacks: {
      onAssistantTurn(event) {
        trace.push({
          type: 'assistant',
          stopReason: event.stopReason,
          text: event.text,
          toolCalls: event.toolCalls,
        });
      },
      onSkillSelected(selection) {
        if (selection?.skill?.name && selectedSkills.indexOf(selection.skill.name) === -1) {
          selectedSkills.push(selection.skill.name);
        }
      },
      onToolStart(name) {
        if (name && toolNames.indexOf(name) === -1) {
          toolNames.push(name);
        }
        trace.push({
          type: 'tool_start',
          toolName: name,
        });
      },
      onToolEnd(name, success, result, duration) {
        trace.push({
          type: 'tool_end',
          toolName: name,
          success,
          result,
          durationMs: duration,
        });
      },
    },
  }, scopedRegistry, systemPrompt);

  const historyText = options?.chatHistory && options.chatHistory.length > 0
    ? `\n\nPrior script conversation:\n${options.chatHistory.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n')}`
    : '';

  const result = await engine.run(`${objective}${historyText}`);
  if (!result.success) {
    throw new Error(result.error || result.content || 'Scoped script generation failed');
  }

  return { content: result.content.trim(), selectedSkills, toolNames, trace };
}

function formatScriptGenerationTrace(trace: ScriptGenerationTraceEvent[]): string {
  if (!Array.isArray(trace) || trace.length === 0) {
    return 'No detailed trace was recorded for this pass.';
  }

  return trace.map((event, index) => {
    if (event.type === 'assistant') {
      const lines = [
        `[${index + 1}] Assistant response`,
        `stop=${event.stopReason || 'unknown'}`,
      ];
      if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) {
        lines.push(`toolCalls=${event.toolCalls.map(call => call.name).join(', ')}`);
      } else {
        lines.push('toolCalls=none');
      }
      if (event.text) {
        lines.push('text:');
        lines.push(event.text);
      }
      return lines.join('\n');
    }
    if (event.type === 'tool_start') {
      return `[${index + 1}] Tool start\nname=${event.toolName || 'unknown'}`;
    }
    return [
      `[${index + 1}] Tool result`,
      `name=${event.toolName || 'unknown'}`,
      `success=${event.success ? 'true' : 'false'}`,
      `durationMs=${typeof event.durationMs === 'number' ? event.durationMs : 0}`,
      'result:',
      event.result || '',
    ].join('\n');
  }).join('\n\n');
}

async function runStrictScriptGenerationFallback(
  userMessage: string,
  toolDocs: string,
  options?: {
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    currentCode?: string;
    issues?: string[];
    mode?: ScriptGenerationMode;
  },
): Promise<string> {
  const { runPrompt } = await import('../../loop/llm-service.js');
  const providerAndModel = getScriptGenerationProviderAndModel();
  const historyText = options?.chatHistory && options.chatHistory.length > 0
    ? `Prior script conversation:\n${options.chatHistory.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n')}`
    : '';
  const builtinGuidance = buildWoodburyBuiltinToolingGuidance(userMessage);
  const codeText = options?.currentCode
    ? `Current code candidate:\n\`\`\`javascript\n${options.currentCode}\n\`\`\``
    : '';
  const issuesText = options?.issues && options.issues.length > 0
    ? `Known problems to fix:\n- ${options.issues.join('\n- ')}`
    : '';
  const modeGuidance = getScriptGenerationModeGuidance(options?.mode || 'generate');
  const editGuidance = getScriptEditGuidance(userMessage, Boolean(options?.currentCode));
  const requestInstruction = options?.currentCode
    ? 'Update the existing Woodbury script node code to satisfy the request. Return the full updated script.'
    : 'Generate a Woodbury script node that satisfies the request. Return the full script.';

  const response = await runPrompt([
    {
      role: 'system',
      content: [
        'You generate JavaScript for a Woodbury pipeline script node.',
        'Return ONLY a single fenced ```javascript code block. Do not include any prose before or after the block.',
        'The code must include a JSDoc block with at least one @input and at least one @output annotation.',
        'The code must define async function execute(inputs, context).',
        'The execute function must return an object containing all declared outputs.',
        'Preserve the requested behavior while fixing any structural validation errors.',
        builtinGuidance,
        SCRIPT_PROGRESS_GUIDANCE,
        modeGuidance,
        editGuidance,
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        requestInstruction,
        `Task request:\n${userMessage}`,
        issuesText,
        codeText,
        historyText,
        toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ], providerAndModel.model, { maxTokens: 2600, temperature: 0.1 });

  return response.content.trim();
}

async function runScriptGenerationWithClosureEngine(
  ctx: DashboardContext,
  userMessage: string,
  toolDocs: string,
  chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  mode: ScriptGenerationMode = 'generate',
  currentCode?: unknown,
): Promise<{ code: string; assistantMessage: string; inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }>; lifecycle: ScriptGenerationLifecycle }> {
  const builtinGuidance = buildWoodburyBuiltinToolingGuidance(userMessage);
  const normalizedCurrentCode = typeof currentCode === 'string' && currentCode.trim() ? currentCode : undefined;
  const hasCurrentCode = Boolean(normalizedCurrentCode);
  const editGuidance = getScriptEditGuidance(userMessage, hasCurrentCode);
  const generationObjective = [
    'Generate JavaScript for a Woodbury pipeline script node.',
    'Use the dedicated script-node generation skill and validate the result before finishing.',
    'Final answer format: return ONLY a single JavaScript code block.',
    'The code must include a JSDoc block with @input and @output annotations.',
    'The code must define async function execute(inputs, context).',
    'The function must return an object containing all declared outputs.',
    builtinGuidance,
    SCRIPT_PROGRESS_GUIDANCE,
    getScriptGenerationModeGuidance(mode),
    editGuidance,
    toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
    `Task request:\n${userMessage}`,
  ].filter(Boolean).join('\n\n');

  let generationPass: { content: string; selectedSkills: string[]; toolNames: string[]; trace: ScriptGenerationTraceEvent[] };
  if (shouldUseDirectScriptGeneration(mode)) {
    const directResponse = await runStrictScriptGenerationFallback(userMessage, toolDocs, {
      chatHistory,
      currentCode: normalizedCurrentCode,
      mode,
    });
    generationPass = {
      content: directResponse,
      selectedSkills: [],
      toolNames: [],
      trace: [{
        type: 'assistant',
        stopReason: 'direct_prompt',
        text: directResponse,
        toolCalls: [],
      }],
    };
  } else {
    generationPass = await runScopedScriptGenerationPass(ctx, generationObjective, {
      chatHistory,
      sessionSuffix: 'generate',
      mode,
    });
  }
  const transcript: ScriptGenerationTranscriptEntry[] = [
    {
      stage: 'request',
      title: 'Request',
      content: userMessage,
    },
    {
      stage: 'generation',
      title: shouldUseDirectScriptGeneration(mode) ? 'Direct generation pass' : 'Initial generation pass',
      content: [
        `Selected skills: ${generationPass.selectedSkills.length > 0 ? generationPass.selectedSkills.join(', ') : 'none recorded'}`,
        `Scoped tools used: ${generationPass.toolNames.length > 0 ? generationPass.toolNames.join(', ') : 'none'}`,
        '',
        formatScriptGenerationTrace(generationPass.trace),
      ].join('\n'),
    },
  ];
  let assistantMessage = generationPass.content;
  let code = extractCodeBlock(assistantMessage);
  let validation = validateGeneratedScriptCode(code, { userMessage });
  let repaired = false;
  let strictFallbackUsed = false;
  const selectedSkills = generationPass.selectedSkills.slice();
  const toolNames = generationPass.toolNames.slice();

  if (!validation.ok) {
    transcript.push({
      stage: 'validation',
      title: 'Validation issues after initial pass',
      content: validation.issues.join('\n'),
    });
    repaired = true;
    const repairObjective = [
      'Repair malformed Woodbury script-node JavaScript.',
      'Use the dedicated script-node generation skill and return ONLY a single repaired JavaScript code block.',
      `Original request:\n${userMessage}`,
      `Current code:\n\`\`\`javascript\n${code}\n\`\`\``,
      `Validation issues:\n- ${validation.issues.join('\n- ')}`,
      builtinGuidance,
      editGuidance,
      toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
    ].filter(Boolean).join('\n\n');

    const repairPass = shouldUseDirectScriptGeneration(mode)
      ? {
        content: await runStrictScriptGenerationFallback(userMessage, toolDocs, {
          chatHistory,
          currentCode: code,
          issues: validation.issues,
          mode,
        }),
        selectedSkills: [],
        toolNames: [],
        trace: [{
          type: 'assistant' as const,
          stopReason: 'direct_prompt',
          text: 'Repair generated through direct prompt fallback.',
          toolCalls: [],
        }],
      }
      : await runScopedScriptGenerationPass(ctx, repairObjective, {
        chatHistory,
        sessionSuffix: 'repair',
        mode,
      });
    transcript.push({
      stage: 'repair',
      title: 'Repair pass',
      content: [
        `Selected skills: ${repairPass.selectedSkills.length > 0 ? repairPass.selectedSkills.join(', ') : 'none recorded'}`,
        `Scoped tools used: ${repairPass.toolNames.length > 0 ? repairPass.toolNames.join(', ') : 'none'}`,
        '',
        formatScriptGenerationTrace(repairPass.trace),
      ].join('\n'),
    });
    assistantMessage = repairPass.content;
    code = extractCodeBlock(assistantMessage);
    validation = validateGeneratedScriptCode(code, { userMessage });
    for (const skill of repairPass.selectedSkills) {
      if (selectedSkills.indexOf(skill) === -1) selectedSkills.push(skill);
    }
    for (const toolName of repairPass.toolNames) {
      if (toolNames.indexOf(toolName) === -1) toolNames.push(toolName);
    }
  }

  if (!validation.ok) {
    strictFallbackUsed = true;
    assistantMessage = await runStrictScriptGenerationFallback(userMessage, toolDocs, {
      chatHistory,
      currentCode: code,
      issues: validation.issues,
      mode,
    });
    transcript.push({
      stage: 'fallback',
      title: 'Strict format fallback',
      content: assistantMessage.trim(),
    });
    code = extractCodeBlock(assistantMessage);
    validation = validateGeneratedScriptCode(code, { userMessage });
  }

  if (!validation.ok) {
    throw new Error(`Generated code did not pass validation after repair: ${validation.issues.join(' ')}`);
  }

  let generatedTests: ScriptGenerationTestCase[] = [];
  let testResults: Awaited<ReturnType<typeof runGeneratedScriptUnitTests>> = [];
  try {
    generatedTests = await generateScriptUnitTestCases(userMessage, code, validation.ports.inputs, validation.ports.outputs);
  } catch (err) {
    debugLog.info('dashboard', 'Failed to generate script unit tests', { error: String(err) });
  }

  if (generatedTests.length > 0) {
    transcript.push({
      stage: 'tests',
      title: 'Generated unit tests',
      content: generatedTests.map(testCase => {
        const inputsText = JSON.stringify(testCase.inputs || {}, null, 2);
        const requiredKeys = Array.isArray(testCase.requiredOutputKeys) && testCase.requiredOutputKeys.length > 0
          ? `required outputs: ${testCase.requiredOutputKeys.join(', ')}`
          : 'required outputs: none';
        return `${testCase.name}\ninputs: ${inputsText}\n${requiredKeys}`;
      }).join('\n\n'),
    });
    testResults = await runGeneratedScriptUnitTests(code, generatedTests);
    const failingTests = testResults.filter(result => !result.passed);
    transcript.push({
      stage: 'tests',
      title: failingTests.length > 0 ? 'Unit test failures' : 'Unit test results',
      content: testResults.map(result => `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.failures.length > 0 ? `\n${result.failures.join('\n')}` : ''}`).join('\n\n'),
    });
    if (failingTests.length > 0) {
      repaired = true;
      const repairObjective = [
        'Repair Woodbury script-node JavaScript so it passes deterministic unit tests.',
        'Return ONLY a single repaired JavaScript code block.',
        `Original request:\n${userMessage}`,
        `Current code:\n\`\`\`javascript\n${code}\n\`\`\``,
        `Failing unit tests:\n${failingTests.map(result => `- ${result.name}: ${result.failures.join('; ')}`).join('\n')}`,
        builtinGuidance,
        editGuidance,
        toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
      ].filter(Boolean).join('\n\n');
      const repairPass = shouldUseDirectScriptGeneration(mode)
        ? {
          content: await runStrictScriptGenerationFallback(userMessage, toolDocs, {
            chatHistory,
            currentCode: code,
            issues: failingTests.map(result => `${result.name}: ${result.failures.join('; ')}`),
            mode,
          }),
          selectedSkills: [],
          toolNames: [],
          trace: [{
            type: 'assistant' as const,
            stopReason: 'direct_prompt',
            text: 'Unit-test repair generated through direct prompt fallback.',
            toolCalls: [],
          }],
        }
        : await runScopedScriptGenerationPass(ctx, repairObjective, {
          chatHistory,
          sessionSuffix: 'unit-test-repair',
          mode,
        });
      transcript.push({
        stage: 'repair',
        title: 'Unit-test repair pass',
        content: [
          `Selected skills: ${repairPass.selectedSkills.length > 0 ? repairPass.selectedSkills.join(', ') : 'none recorded'}`,
          `Scoped tools used: ${repairPass.toolNames.length > 0 ? repairPass.toolNames.join(', ') : 'none'}`,
          '',
          formatScriptGenerationTrace(repairPass.trace),
        ].join('\n'),
      });
      assistantMessage = repairPass.content;
      code = extractCodeBlock(assistantMessage);
      validation = validateGeneratedScriptCode(code, { userMessage });
      if (!validation.ok) {
        strictFallbackUsed = true;
        assistantMessage = await runStrictScriptGenerationFallback(userMessage, toolDocs, {
          chatHistory,
          currentCode: code,
          issues: validation.issues.concat(failingTests.map(result => `${result.name}: ${result.failures.join('; ')}`)),
          mode,
        });
        transcript.push({
          stage: 'fallback',
          title: 'Strict fallback after unit-test repair',
          content: assistantMessage.trim(),
        });
        code = extractCodeBlock(assistantMessage);
        validation = validateGeneratedScriptCode(code, { userMessage });
      }
      if (!validation.ok) {
        throw new Error(`Generated code failed structural validation after unit-test repair: ${validation.issues.join(' ')}`);
      }
      generatedTests = await generateScriptUnitTestCases(userMessage, code, validation.ports.inputs, validation.ports.outputs);
      testResults = generatedTests.length > 0 ? await runGeneratedScriptUnitTests(code, generatedTests) : [];
      const remainingFailures = testResults.filter(result => !result.passed);
      transcript.push({
        stage: 'tests',
        title: remainingFailures.length > 0 ? 'Post-repair unit test failures' : 'Post-repair unit test results',
        content: testResults.map(result => `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.failures.length > 0 ? `\n${result.failures.join('\n')}` : ''}`).join('\n\n'),
      });
      if (remainingFailures.length > 0) {
        throw new Error(`Generated code failed unit tests after repair: ${remainingFailures.map(result => `${result.name}: ${result.failures.join('; ')}`).join(' | ')}`);
      }
      for (const skill of repairPass.selectedSkills) {
        if (selectedSkills.indexOf(skill) === -1) selectedSkills.push(skill);
      }
      for (const toolName of repairPass.toolNames) {
        if (toolNames.indexOf(toolName) === -1) toolNames.push(toolName);
      }
    }
  }
  const verificationSummary = `Selected skills: ${selectedSkills.length > 0 ? selectedSkills.join(', ') : 'none recorded'}. Scoped tools used: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}.${strictFallbackUsed ? ' A strict output-format fallback was used after the closure-engine response failed validation.' : ''} Structural validation passed for JSDoc annotations, execute(inputs, context), return object, and JavaScript parsing.${generatedTests.length > 0 ? ` Executed ${testResults.length} deterministic unit test(s) and all passed.` : ' No deterministic unit tests were generated.'} These checks cover generated code structure and deterministic sandbox behavior only, not full pipeline runtime execution.`;
  transcript.push({
    stage: 'checks',
    title: 'Generation checks passed',
    content: verificationSummary,
  });
  return {
    code,
    assistantMessage,
    inputs: validation.ports.inputs,
    outputs: validation.ports.outputs,
    lifecycle: {
      designedPlan: `Closure engine routed this through ${selectedSkills[0] || 'script generation'} and kept the tool scope constrained for validation-oriented problem solving.${strictFallbackUsed ? ' A strict output-format fallback was used to force valid script-node code when the model answered in the wrong shape.' : ''}`,
      validationIssues: validation.issues,
      repaired,
      verificationSummary,
      selectedSkills,
      toolNames,
      transcript,
    },
  };
}

function buildPipelineScriptGraphContext(
  pipeline: { nodes?: any[]; connections?: any[] },
  nodeIndex: number,
): Record<string, unknown> {
  const nodes = Array.isArray(pipeline.nodes) ? pipeline.nodes : [];
  const connections = Array.isArray(pipeline.connections) ? pipeline.connections : [];
  const currentNode = nodes[nodeIndex] || {};
  const summarizeNode = (node: any, index: number) => ({
    index,
    type: node?.type || 'script',
    label: node?.label || `Step ${index + 1}`,
    description: node?.description || '',
  });

  return {
    currentNode: summarizeNode(currentNode, nodeIndex),
    upstream: connections
      .filter(conn => conn?.to === nodeIndex && Number.isInteger(conn?.from) && nodes[conn.from])
      .map(conn => ({
        fromPort: conn.fromPort,
        toPort: conn.toPort,
        node: summarizeNode(nodes[conn.from], conn.from),
      })),
    downstream: connections
      .filter(conn => conn?.from === nodeIndex && Number.isInteger(conn?.to) && nodes[conn.to])
      .map(conn => ({
        fromPort: conn.fromPort,
        toPort: conn.toPort,
        node: summarizeNode(nodes[conn.to], conn.to),
      })),
    plannedNodes: nodes.map((node, index) => summarizeNode(node, index)),
  };
}

function normalizePipelinePortContracts(rawPorts: unknown): PipelinePortContract[] {
  if (!Array.isArray(rawPorts)) return [];

  return rawPorts
    .filter((port): port is Record<string, unknown> => Boolean(port) && typeof port === 'object')
    .map((port) => {
      const name = typeof port.name === 'string' ? port.name.trim() : '';
      const type = typeof port.type === 'string' ? port.type.trim() : 'string';
      const description = typeof port.description === 'string' ? port.description.trim() : '';
      if (!name) return null;
      return { name, type: type || 'string', description };
    })
    .filter((port): port is PipelinePortContract => Boolean(port));
}

function buildPipelineScriptGenerationDescription(
  description: string,
  node: { inputs?: unknown; outputs?: unknown },
): string {
  const inputContracts = normalizePipelinePortContracts(node.inputs);
  const outputContracts = normalizePipelinePortContracts(node.outputs);
  const sections = [description.trim()];

  if (inputContracts.length > 0) {
    sections.push([
      'Required input ports:',
      ...inputContracts.map((port) => `- ${port.name} (${port.type}): ${port.description || 'No description provided.'}`),
    ].join('\n'));
  }

  if (outputContracts.length > 0) {
    sections.push([
      'Required output ports:',
      ...outputContracts.map((port) => `- ${port.name} (${port.type}): ${port.description || 'No description provided.'}`),
    ].join('\n'));
  }

  sections.push('Honor these exact port names unless there is a clear validation error in the declared contract.');
  return sections.filter(Boolean).join('\n\n');
}

async function ensurePipelineScriptNodeCode(
  ctx: DashboardContext,
  pipeline: { nodes?: any[]; connections?: any[] },
  nodeIndex: number,
  toolDocs: string,
): Promise<PipelineScriptNodeGenerationResult> {
  const pipelineNodes = Array.isArray(pipeline.nodes) ? pipeline.nodes : [];
  const node = pipelineNodes[nodeIndex] || {};
  const description = typeof node.description === 'string' && node.description.trim()
    ? node.description.trim()
    : (typeof node.label === 'string' && node.label.trim() ? node.label.trim() : `Step ${nodeIndex + 1}`);
  const currentCode = typeof node.code === 'string' && node.code.trim() ? node.code.trim() : '';
  const graphContext = buildPipelineScriptGraphContext(pipeline, nodeIndex);
  const requestedDescription = buildPipelineScriptGenerationDescription(description, node);
  const requestMessage = buildScriptRequestMessage(requestedDescription, undefined, graphContext, currentCode || undefined);
  const lifecycleResult = await runScriptGenerationWithClosureEngine(
    ctx,
    requestMessage,
    toolDocs,
    undefined,
    currentCode ? 'edit' : 'generate',
    currentCode || undefined,
  );

  return {
    description,
    code: lifecycleResult.code,
    inputs: lifecycleResult.inputs,
    outputs: lifecycleResult.outputs,
    assistantMessage: lifecycleResult.assistantMessage,
    transcript: lifecycleResult.lifecycle.transcript,
    regenerated: true,
  };
}

export const __testOnly = {
  buildWoodburyBuiltinToolingGuidance,
  buildPipelineScriptGenerationDescription,
  buildPipelineScriptGraphContext,
  ensurePipelineScriptNodeCode,
  extractCodeBlock,
  shouldUseDirectScriptGeneration,
  validateGeneratedScriptCode,
  runStrictScriptGenerationFallback,
  sanitizeScriptGenerationTestCases,
};

// ── Route handler ────────────────────────────────────────────

export const handleGenerationRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // POST /api/autofill — AI-powered variable value generation
  if (req.method === 'POST' && pathname === '/api/autofill') {
    try {
      const body = await readBody(req);
      const { variables, workflowName, site, steps } = body || {};

      if (!variables || !Array.isArray(variables) || variables.length === 0) {
        sendJson(res, 400, { error: 'Must provide a "variables" array' });
        return true;
      }

      // Build a concise context string from the workflow steps
      const stepsContext = (steps || [])
        .slice(0, 20) // limit to first 20 steps for token efficiency
        .map((s: any, i: number) => {
          let desc = `${i + 1}. ${s.type || 'action'}`;
          if (s.target?.textContent) desc += ` "${s.target.textContent}"`;
          if (s.target?.description) desc += ` (${s.target.description})`;
          if (s.value !== undefined) desc += ` → value: "${String(s.value).slice(0, 100)}"`;
          return desc;
        })
        .join('\n');

      // Build the variable descriptions
      const varDescriptions = variables
        .map((v: any) => {
          let line = `- ${v.name} (${v.type || 'string'})`;
          if (v.description) line += `: ${v.description}`;
          if (v.default) line += ` [default: ${v.default}]`;
          if (v.generationPrompt) line += ` [AI prompt: ${v.generationPrompt}]`;
          return line;
        })
        .join('\n');

      const prompt = `You are generating sample values for a browser automation workflow's variables. Generate realistic, creative, and contextually appropriate values.

Workflow: "${workflowName || 'Untitled'}"
Target site: ${site || 'unknown'}

Variables to fill:
${varDescriptions}

Workflow steps:
${stepsContext || '(no steps recorded)'}

Rules:
- Generate values that make sense for this specific workflow and target site
- For lyrics/text content, be creative and original — write a short verse or meaningful text
- For titles/names, be descriptive and catchy
- For genres/styles, pick something specific (not "General")
- For tags/hashtags, use relevant, realistic tags
- For URLs, use the target site domain if relevant
- For numbers, use sensible defaults for the context
- NEVER generate values for variables whose names contain "password", "secret", "token", or "key"
- Return ONLY a JSON object mapping variable names to generated values, no explanation

Example output:
{"song_title": "Neon Highways", "lyrics": "Driving fast through neon lights...\\nChasing dreams into the night", "genre": "Synthwave, Electronic"}`;

      // Try to use runPrompt from the LLM service
      const { runPrompt } = await import('../../loop/llm-service.js');

      // Use a fast model — try claude-sonnet first, fall back to gpt-4o-mini
      const model = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514'; // default, will error if no key

      const llmResponse = await runPrompt(
        [
          { role: 'user', content: prompt },
        ],
        model,
        { maxTokens: 1024, temperature: 0.8 }
      );

      // Parse the JSON from the response
      const content = llmResponse.content.trim();
      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      const jsonStr = (jsonMatch[1] || content).trim();
      const generated = JSON.parse(jsonStr);

      debugLog.info('dashboard', 'AI autofill generated values', {
        model,
        variableCount: variables.length,
        generatedKeys: Object.keys(generated),
      });

      sendJson(res, 200, { success: true, values: generated });
    } catch (err) {
      debugLog.error('dashboard', 'AI autofill failed', { error: String(err) });
      sendJson(res, 500, { error: `AI autofill failed: ${(err as Error).message}` });
    }
    return true;
  }

  // POST /api/generate-variable — AI generation for a single variable using its custom prompt
  if (req.method === 'POST' && pathname === '/api/generate-variable') {
    try {
      const body = await readBody(req);
      const { variableName, generationPrompt, workflowName, site, variableType } = body || {};

      if (!variableName || !generationPrompt) {
        sendJson(res, 400, { error: 'variableName and generationPrompt are required' });
        return true;
      }

      const prompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${variableName}" (type: ${variableType || 'string'})
Workflow: "${workflowName || 'Untitled'}" on ${site || 'unknown site'}

Instructions from the user:
${generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

      const model = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514';

      const { runPrompt } = await import('../../loop/llm-service.js');

      const llmResponse = await runPrompt(
        [{ role: 'user', content: prompt }],
        model,
        { maxTokens: 2048, temperature: 0.9 }
      );

      const value = llmResponse.content.trim();

      debugLog.info('dashboard', `AI generated value for variable "${variableName}"`, {
        model,
        promptLength: generationPrompt.length,
        valueLength: value.length,
      });

      sendJson(res, 200, { success: true, value });
    } catch (err) {
      debugLog.error('dashboard', 'AI generate-variable failed', { error: String(err) });
      sendJson(res, 500, { error: `AI generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  // POST /api/compositions/generate-script — AI-powered code generation for script nodes
  if (req.method === 'POST' && pathname === '/api/compositions/generate-script') {
    try {
      const body = await readBody(req);
      const { description, chatHistory, currentCode, dataContext, graphContext, mode } = body || {};
      const hasCurrentCode = typeof currentCode === 'string' && currentCode.trim().length > 0;
      const scriptMode: ScriptGenerationMode = mode === 'edit' || mode === 'repair' || mode === 'verify'
        ? mode
        : (hasCurrentCode ? 'edit' : 'generate');

      if (!description && (!chatHistory || chatHistory.length === 0)) {
        sendJson(res, 400, { error: 'description or chatHistory is required' });
        return true;
      }

      const toolDocs = await generateScriptToolDocs(ctx);
      const userMessage = buildScriptRequestMessage(description, dataContext, graphContext, currentCode);
      const lifecycleResult = await runScriptGenerationWithClosureEngine(
        ctx,
        userMessage,
        toolDocs,
        chatHistory,
        scriptMode,
        currentCode,
      );

      debugLog.info('dashboard', 'Script generated', {
        engine: 'closure-engine',
        inputCount: lifecycleResult.inputs.length,
        outputCount: lifecycleResult.outputs.length,
        codeLength: lifecycleResult.code.length,
        repaired: lifecycleResult.lifecycle.repaired,
      });

      sendJson(res, 200, {
        code: lifecycleResult.code,
        inputs: lifecycleResult.inputs,
        outputs: lifecycleResult.outputs,
        assistantMessage: lifecycleResult.assistantMessage,
        lifecycle: lifecycleResult.lifecycle,
        transcript: lifecycleResult.lifecycle.transcript,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Script generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Script generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/compositions/generate-pipeline') {
    try {
      const body = await readBody(req);
      const { description, graphContext, selectedPublishedSkillIds } = body || {};

      if (!description || !String(description).trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }

      const toolDocs = await generateScriptToolDocs(ctx);
      const publishedSkillsSection = await formatPublishedSkillsPromptSection(ctx.workDir, {
        audience: 'pipelines',
        maxSkills: 6,
        selectedSkillIds: Array.isArray(selectedPublishedSkillIds) ? selectedPublishedSkillIds : undefined,
      });
      const pipelineSystemPrompt = `You are a pipeline architect for a visual automation platform. The user describes a task, and you decompose it into multiple small, focused steps — each becoming a node in a pipeline graph.

IMPORTANT RULES:
1. Each script node should do ONE thing and be under 20 lines of code
2. Use the simplest node type for each step:
   - "text" for constant values (prompts, paths, configuration strings)
   - "file_op" for file operations (copy, move, delete, mkdir, list)
  - "script" for custom logic, LLM calls, data transformation, or tool usage
3. Connect nodes via matching port names in the connections array
4. Port names must use snake_case (e.g., "generated_text", "file_path")
5. Keep the pipeline linear or fan-out — avoid unnecessary complexity
6. For script nodes, describe the intent and declare ports only. Do NOT write JavaScript code. The backend will generate the code in a separate pass.

NODE TYPES:

"text" — outputs a constant string value
  Output port: "text" (always)
  Config: { "type": "text", "label": "...", "textNode": { "value": "the text content" } }

"file_op" — file system operations
  Operations and their ports:
  - "copy": inputs [sourcePath, destinationPath], outputs [outputPath, success]
  - "move": inputs [sourcePath, destinationPath], outputs [outputPath, success]
  - "delete": inputs [filePath], outputs [success]
  - "mkdir": inputs [folderPath], outputs [outputPath, success]
  - "list": inputs [folderPath], outputs [files, count]
  Config: { "type": "file_op", "label": "...", "fileOp": { "operation": "copy" } }

"script" — custom code with @input/@output ports
  Provide a short intent/description and explicit input/output port declarations only.
  Port format: { "name": "snake_case_name", "type": "string|number|boolean|object|string[]|number[]|object[]", "description": "..." }
  The backend will later turn this into executable code.
${toolDocs}

${publishedSkillsSection ? `${publishedSkillsSection}

When one of these published skills clearly matches the requested behavior, incorporate its trigger conditions, input contract, and guidance into the pipeline nodes instead of inventing a new pattern.
` : ''}

${graphContext ? `EXISTING PIPELINE CONTEXT:
${typeof graphContext === 'string' ? graphContext : JSON.stringify(graphContext, null, 2)}

If this context is provided, treat it as existing graph structure that should inform how you extend, reuse, or connect the generated nodes. Avoid duplicating responsibilities that already exist in the selected context unless the user explicitly asks for replacement.
` : ''}

RESPONSE FORMAT — respond with ONLY a JSON object (no explanation, no markdown fences):

{
  "name": "Human-readable pipeline name",
  "nodes": [
    {
      "type": "text|script|file_op",
      "label": "Short Node Label",
      "description": "What this node does (script only)",
      "inputs": [{ "name": "input_name", "type": "string", "description": "What this input means" }],
      "outputs": [{ "name": "output_name", "type": "string", "description": "What this output means" }],
      "textNode": { "value": "..." },
      "fileOp": { "operation": "copy|move|delete|mkdir|list" }
    }
  ],
  "connections": [
    { "from": 0, "fromPort": "output_name", "to": 1, "toPort": "input_name" }
  ]
}

- "from" and "to" are zero-based indices into the nodes array
- Only include fields relevant to each node type
- Script nodes MUST include "description", "inputs", and "outputs"
- Script nodes MUST NOT include "code"
- Make sure every connection references port names that actually exist on the source and target nodes

EXAMPLE — "Generate a poem about a theme and save it to a file":

{
  "name": "Poem Generator & Saver",
  "nodes": [
    {
      "type": "text",
      "label": "Theme",
      "textNode": { "value": "autumn leaves" }
      "inputs": [
        { "name": "theme", "type": "string", "description": "The theme to write about" }
      ],
      "outputs": [
        { "name": "poem", "type": "string", "description": "The generated poem" },
        { "name": "title", "type": "string", "description": "A title for the poem" }
      ]
    {
      "type": "script",
      "label": "Generate Poem",
      "description": "Generate a poem from a theme using AI",
      "code": "/**\\n * @input theme string \\"The theme to write about\\"\\n * @output poem string \\"The generated poem\\"\\n * @output title string \\"A title for the poem\\"\\n */\\nasync function execute(inputs, context) {\\n  const { theme } = inputs;\\n  const result = await context.llm.generateJSON(\\n    \`Write a poem about \\"\${theme}\\". Return JSON: { \\"title\\": \\"...\\\", \\"poem\\": \\"...\\" }\`\\n  );\\n  return { poem: result.poem, title: result.title };\\n}"
      "inputs": [
        { "name": "content", "type": "string", "description": "Text to save" },
        { "name": "filename", "type": "string", "description": "File name" }
      ],
      "outputs": [
        { "name": "file_path", "type": "string", "description": "Path where saved" }
      ]
    {
      "type": "script",
      "label": "Save to File",
      "description": "Write text content to a file",
      "code": "/**\\n * @input content string \\"Text to save\\"\\n * @input filename string \\"File name\\"\\n * @output file_path string \\"Path where saved\\"\\n */\\nasync function execute(inputs, context) {\\n  const fs = require('fs');\\n  const path = require('path');\\n  const { content, filename } = inputs;\\n  const dir = path.join(require('os').homedir(), 'Documents', 'outputs');\\n  fs.mkdirSync(dir, { recursive: true });\\n  const fp = path.join(dir, filename + '.txt');\\n  fs.writeFileSync(fp, content, 'utf-8');\\n  return { file_path: fp };\\n}"
    }
  ],
  "connections": [
    { "from": 0, "fromPort": "text", "to": 1, "toPort": "theme" },
    { "from": 1, "fromPort": "poem", "to": 2, "toPort": "content" },
    { "from": 1, "fromPort": "title", "to": 2, "toPort": "filename" }
  ]
}

Remember: respond with ONLY the JSON object.`;

      const { runPrompt } = await import('../../loop/llm-service.js');

      const pipelineModel = process.env.ANTHROPIC_API_KEY
        ? 'claude-sonnet-4-20250514'
        : process.env.OPENAI_API_KEY
          ? 'gpt-4o-mini'
          : process.env.GROQ_API_KEY
            ? 'llama-3.1-70b-versatile'
            : 'claude-sonnet-4-20250514';

      const pipelineMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: pipelineSystemPrompt },
        { role: 'user', content: description.trim() },
      ];

      const llmResp = await runPrompt(pipelineMessages, pipelineModel, { maxTokens: 8192, temperature: 0.7 });
      const rawResponse = llmResp.content.trim();

      // Extract JSON — may be wrapped in ```json ... ```
      let jsonStr = rawResponse;
      const jsonFenceMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonFenceMatch) {
        jsonStr = jsonFenceMatch[1].trim();
      }

      let pipeline: any;
      try {
        pipeline = JSON.parse(jsonStr);
      } catch {
        sendJson(res, 422, { error: 'LLM returned invalid JSON', raw: rawResponse });
        return true;
      }

      if (!Array.isArray(pipeline.nodes) || pipeline.nodes.length === 0) {
        sendJson(res, 422, { error: 'Pipeline must have at least one node', raw: rawResponse });
        return true;
      }

      // Map type strings to workflowId and ID prefixes
      const typeToWorkflowId: Record<string, string> = {
        script: '__script__', text: '__text__', file_op: '__file_op__',
        image_viewer: '__image_viewer__', media: '__media__', asset: '__asset__',
      };
      const typeToPrefix: Record<string, string> = {
        script: 'script', text: 'text', file_op: 'fileop',
        image_viewer: 'node', asset: 'asset',
      };

      const realNodes: any[] = [];
      const idByIndex: string[] = [];
      const scriptNodeResults = new Map<number, PipelineScriptNodeGenerationResult>();

      for (let i = 0; i < pipeline.nodes.length; i++) {
        const pNode = pipeline.nodes[i];
        const nodeType = pNode?.type || 'script';
        if (nodeType !== 'script') continue;

        const scriptNodeResult = await ensurePipelineScriptNodeCode(ctx, pipeline, i, toolDocs);
        scriptNodeResults.set(i, scriptNodeResult);
      }

      for (let i = 0; i < pipeline.nodes.length; i++) {
        const pNode = pipeline.nodes[i];
        const nodeType = pNode.type || 'script';
        const workflowId = typeToWorkflowId[nodeType] || '__script__';
        const prefix = typeToPrefix[nodeType] || 'script';
        const id = prefix + '-' + Math.random().toString(36).slice(2, 9);
        idByIndex.push(id);

        const node: any = {
          id,
          workflowId,
          position: { x: 0, y: 0 },
          label: pNode.label || `Step ${i + 1}`,
        };

        if (workflowId === '__script__') {
          const scriptNodeResult = scriptNodeResults.get(i);
          const code = scriptNodeResult?.code || pNode.code || '';
          const ports = scriptNodeResult
            ? { inputs: scriptNodeResult.inputs, outputs: scriptNodeResult.outputs }
            : { inputs: normalizePipelinePortContracts(pNode.inputs), outputs: normalizePipelinePortContracts(pNode.outputs) };
          const chatHistory = scriptNodeResult && scriptNodeResult.assistantMessage
            ? [
              { role: 'user', content: scriptNodeResult.description },
              { role: 'assistant', content: scriptNodeResult.assistantMessage },
            ]
            : [];
          node.script = {
            description: scriptNodeResult?.description || pNode.description || pNode.label || '',
            code,
            inputs: ports.inputs.length > 0 ? ports.inputs : (pNode.inputs || []),
            outputs: ports.outputs.length > 0 ? ports.outputs : (pNode.outputs || []),
            chatHistory,
            generationTranscript: scriptNodeResult?.transcript || [],
          };
        } else if (workflowId === '__text__') {
          node.textNode = { value: pNode.textNode?.value || pNode.value || '' };
        } else if (workflowId === '__file_op__') {
          node.fileOp = { operation: pNode.fileOp?.operation || 'copy' };
        } else if (workflowId === '__image_viewer__') {
          node.imageViewer = pNode.imageViewer || { filePath: '', width: 300, height: 300 };
        } else if (workflowId === '__media__') {
          node.mediaPlayer = pNode.mediaPlayer || { sourceMode: 'file_path', filePath: '', url: '', assetId: '', mediaType: 'auto', width: 320, height: 240, title: '', autoPlay: false, defaultVolume: 0.8, loop: false, playbackRate: 1.0, imageFit: 'contain' };
        } else if (workflowId === '__asset__') {
          node.asset = pNode.asset || { mode: 'pick' };
        }

        realNodes.push(node);
      }

      // Build edges from connections
      const realEdges: any[] = [];
      if (Array.isArray(pipeline.connections)) {
        for (const conn of pipeline.connections) {
          const srcId = idByIndex[conn.from];
          const tgtId = idByIndex[conn.to];
          if (!srcId || !tgtId) continue;

          // Auto-correct text node output port
          const srcNode = realNodes.find((n: any) => n.id === srcId);
          let sourcePort = conn.fromPort;
          if (srcNode?.workflowId === '__text__' && sourcePort !== 'text') {
            sourcePort = 'text';
          }

          realEdges.push({
            id: 'edge-' + Math.random().toString(36).slice(2, 9),
            sourceNodeId: srcId,
            sourcePort,
            targetNodeId: tgtId,
            targetPort: conn.toPort,
          });
        }
      }

      debugLog.info('dashboard', 'Pipeline generated', {
        model: pipelineModel,
        nodeCount: realNodes.length,
        edgeCount: realEdges.length,
        regeneratedScriptNodeCount: Array.from(scriptNodeResults.values()).filter(result => result.regenerated).length,
        description: description.slice(0, 100),
      });

      sendJson(res, 200, {
        success: true,
        name: pipeline.name || 'Generated Pipeline',
        nodes: realNodes,
        edges: realEdges,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Pipeline generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Pipeline generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  return false;
};
