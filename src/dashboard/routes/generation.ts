/**
 * Dashboard Route: Generation
 *
 * Handles AI-powered generation endpoints:
 * - POST /api/autofill — AI-powered variable value generation
 * - POST /api/generate-variable — AI generation for a single variable using its custom prompt
 * - POST /api/compositions/generate-script — AI-powered code generation for script nodes
 * - POST /api/compositions/generate-pipeline — AI-powered pipeline decomposition
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { DashboardContext, RouteHandler, ScriptToolDoc } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import type { ToolDefinition } from '../../loop/types.js';
import { debugLog } from '../../debug-log.js';
import { resolveCompositionInterface } from '../composition-interface.js';
import { buildGeneratedPipelineDocumentation } from '../pipeline-documentation.js';
import { formatPublishedSkillsPromptSection } from '../../skill-builder/storage.js';
import { discoverCompositions, loadPipeline, readScriptFileCode, writeScriptFileCode } from '../../workflow/loader.js';
import { scaffoldPipeline, savePipelineManifest } from '../pipeline-sync.js';
import { generateNodeTestFile, runPipelineTests, ensureTestHelpers, generateAllNodeTests } from '../pipeline-test-gen.js';
import {
  runGeneratedScriptUnitTests,
  type ScriptGenerationTestCase,
} from '../script-generation-tests.js';
import {
  validateComposition,
  getAvailableWorkflowIds,
} from '../../loop/v3/closure-engine.js';
import {
  proposeScriptNodeEdgeRepairs,
  type ScriptEdgeRepairCandidate,
} from '../script-edge-repair.js';

/**
 * Read the user's saved temperature from ~/.woodbury/chat-config.json.
 * Returns undefined if not set, so callers fall back to their own defaults.
 */
async function getSavedTemperature(): Promise<number | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.woodbury', 'chat-config.json'), 'utf-8');
    const config = JSON.parse(raw);
    return typeof config.temperature === 'number' ? config.temperature : undefined;
  } catch { return undefined; }
}

interface ScriptGenerationTranscriptEntry {
  stage: 'request' | 'plan' | 'generation' | 'repair' | 'fallback' | 'validation' | 'tests' | 'verification' | 'checks';
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

interface ScriptPrePlan {
  /** The user's request, restated for clarity */
  intent: string;
  /** Proposed input ports with exact names, types, and descriptions */
  inputs: Array<{ name: string; type: string; description: string; source?: string }>;
  /** Proposed output ports with exact names, types, and descriptions */
  outputs: Array<{ name: string; type: string; description: string }>;
  /** Which tools from context.tools or context.llm the code should use */
  tools: string[];
  /** Step-by-step algorithm outline */
  approach: string[];
  /** Edge cases, validation needs, or data handling notes */
  edgeCases: string[];
}

// ── Error Explanation contracts ──────────────────────────────

/** Request body for POST /api/compositions/explain-error */
interface ExplainErrorRequest {
  /** The raw error message from the failed node */
  error: string;
  /** Human-readable label of the node that failed */
  nodeLabel?: string;
  /** The node's workflowId (e.g. '__script__', '__text__') */
  nodeType?: string;
}

/** Response from POST /api/compositions/explain-error */
interface ExplainErrorResponse {
  /** One-sentence plain-English summary of what went wrong */
  summary: string;
  /** One-sentence suggestion for what to try next */
  suggestion: string;
}

// ── Add Node contracts ───────────────────────────────────────

/** Request body for POST /api/compositions/:id/add-node */
interface AddNodeRequest {
  /** Natural-language description of what this step should do */
  description: string;
  /** ID of the node to insert after. If omitted, appends at end. */
  afterNodeId?: string;
}

/** Successful response from POST /api/compositions/:id/add-node */
interface AddNodeResponse {
  success: true;
  /** The full updated composition document */
  composition: import('../../workflow/types.js').CompositionDocument;
  /** ID of the newly created node */
  newNodeId: string;
  /** File path where the composition was saved */
  path: string;
  /** Validation results (present when post-insertion validation was run) */
  validation?: CompositionValidationResult;
}

// ── Composition validation contracts ─────────────────────────

/** Result of validating and optionally repairing a composition */
interface CompositionValidationResult {
  /** Whether the composition passed all checks (possibly after repairs) */
  valid: boolean;
  /** Repairs that were automatically applied */
  repairs: string[];
  /** Issues that could not be auto-fixed */
  remainingIssues: string[];
  /** Per-node smoke test results (only for script nodes) */
  smokeTests: Array<{
    nodeId: string;
    nodeLabel: string;
    passed: boolean;
    error?: string;
  }>;
  /** Number of repair iterations performed */
  iterations: number;
}

// ── Pipeline decomposition types ─────────────────────────────

interface PipelineSubContract {
  /** Unique camelCase name, e.g. "generateCast" */
  name: string;
  /** What this sub-contract produces */
  description: string;
  /** Suggested node type for this sub-contract */
  suggestedNodeType: GeneratedPipelineNodeType;
  /** Input ports with source references */
  inputContract: Array<{
    name: string;
    type: string;
    description: string;
    /** Sub-contract name or "user_input" */
    source: string;
  }>;
  /** Output ports produced by this sub-contract */
  outputContract: Array<{
    name: string;
    type: string;
    description: string;
  }>;
  /** Names of sub-contracts that must run before this one */
  dependsOn: string[];
}

interface PipelineDecompositionPlan {
  pipelineName: string;
  targetOutputSummary: string;
  targetOutputType: string;
  targetOutputFields: Array<{ name: string; type: string; description: string }>;
  subContracts: PipelineSubContract[];
  assemblyStrategy: string;
  complexity: 'simple' | 'moderate' | 'complex';
}

interface ScriptGenerationLifecycle {
  designedPlan: string | ScriptPrePlan;
  validationIssues: string[];
  repaired: boolean;
  verificationSummary: string;
  selectedSkills: string[];
  toolNames: string[];
  transcript: ScriptGenerationTranscriptEntry[];
  metrics: ScriptGenerationMetrics;
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

type GeneratedPipelineNodeType =
  | 'script'
  | 'text'
  | 'file_op'
  | 'output'
  | 'image_viewer'
  | 'media'
  | 'asset'
  | 'branch'
  | 'delay'
  | 'gate'
  | 'for_each'
  | 'switch'
  | 'variable'
  | 'get_variable'
  | 'json_keys'
  | 'tool'
  | 'file_write'
  | 'file_read'
  | 'junction';

const GENERATED_PIPELINE_NODE_TYPE_ALIASES: Record<string, GeneratedPipelineNodeType> = {
  script: 'script',
  text: 'text',
  file_op: 'file_op',
  fileop: 'file_op',
  output: 'output',
  output_node: 'output',
  image_viewer: 'image_viewer',
  imageviewer: 'image_viewer',
  media: 'media',
  media_player: 'media',
  mediaplayer: 'media',
  asset: 'asset',
  branch: 'branch',
  if_else: 'branch',
  delay: 'delay',
  gate: 'gate',
  for_each: 'for_each',
  foreach: 'for_each',
  for_loop: 'for_each',
  forloop: 'for_each',
  loop: 'for_each',
  switch: 'switch',
  variable: 'variable',
  get_variable: 'get_variable',
  getvariable: 'get_variable',
  json_keys: 'json_keys',
  json_extract: 'json_keys',
  jsonextract: 'json_keys',
  tool: 'tool',
  file_write: 'file_write',
  write_file: 'file_write',
  filewrite: 'file_write',
  file_read: 'file_read',
  read_file: 'file_read',
  fileread: 'file_read',
  junction: 'junction',
};

const GENERATED_PIPELINE_NODE_TYPE_TO_WORKFLOW_ID: Record<GeneratedPipelineNodeType, string> = {
  script: '__script__',
  text: '__text__',
  file_op: '__file_op__',
  output: '__output__',
  image_viewer: '__image_viewer__',
  media: '__media__',
  asset: '__asset__',
  branch: '__branch__',
  delay: '__delay__',
  gate: '__gate__',
  for_each: '__for_each__',
  switch: '__switch__',
  variable: '__variable__',
  get_variable: '__get_variable__',
  json_keys: '__json_keys__',
  tool: '__tool__',
  file_write: '__file_write__',
  file_read: '__file_read__',
  junction: '__junction__',
};

const GENERATED_PIPELINE_NODE_TYPE_TO_PREFIX: Record<GeneratedPipelineNodeType, string> = {
  script: 'script',
  text: 'text',
  file_op: 'fileop',
  output: 'output',
  image_viewer: 'imgview',
  media: 'media',
  asset: 'asset',
  branch: 'branch',
  delay: 'delay',
  gate: 'gate',
  for_each: 'foreach',
  switch: 'switch',
  variable: 'var',
  get_variable: 'getvar',
  json_keys: 'jsonkeys',
  tool: 'tool',
  file_write: 'fwrite',
  file_read: 'fread',
  junction: 'junction',
};

const PIPELINE_GENERATION_NODE_TYPE_LIST = Object.keys(GENERATED_PIPELINE_NODE_TYPE_TO_WORKFLOW_ID).join('|');

type ScriptGenerationStage = 'planning' | 'generation' | 'repair' | 'verification' | 'pipeline';

interface ScriptRuntimeFailure {
  message: string;
  nodeId?: string;
  nodeLabel?: string;
  stack?: string;
  inputSummary?: unknown;
}

interface RetrievedScriptExample {
  compositionId: string;
  compositionName: string;
  nodeId: string;
  nodeLabel: string;
  description: string;
  inputs: PipelinePortContract[];
  outputs: PipelinePortContract[];
  codeExcerpt: string;
  score: number;
}

interface ScriptGenerationMetrics {
  generationPath: 'direct' | 'agentic' | 'fallback';
  candidateCount: number;
  retrievedExampleCount: number;
  unitTestCount: number;
  smokeTestCount: number;
  repairAttemptCount: number;
  runtimeEvidenceUsed: boolean;
  executionVerified: boolean;
  sampleExecutionCount: number;
  sampleExecutionUsed: boolean;
  sampleExecutionSource: 'none' | 'data_context' | 'graph_context';
  manualEditCount: number;
}

type ScriptGenerationRolloutPolicy = 'legacy' | 'mixed' | 'agentic' | 'direct';

type ScriptGenerationModeOverride = 'inherit' | 'direct' | 'agentic';

interface ScriptGenerationMetricRecord {
  timestamp: string;
  mode: ScriptGenerationMode;
  policy: ScriptGenerationRolloutPolicy;
  compositionId?: string;
  compositionName?: string;
  currentNodeId?: string;
  currentNodeLabel?: string;
  metrics: ScriptGenerationMetrics;
}

interface ScriptGenerationMetricsAggregate {
  totalRequests: number;
  byMode: Record<ScriptGenerationMode, number>;
  byPath: Record<ScriptGenerationMetrics['generationPath'], number>;
  fallbackRate: number;
  repairRate: number;
  runtimeEvidenceRate: number;
  executionVerifiedRate: number;
  sampleExecutionRate: number;
  averageRetrievedExamples: number;
  averageManualEdits: number;
}

interface ScriptGenerationFeatureFlags {
  useAgenticRepairVerify: boolean;
  useExampleRetrieval: boolean;
  useSemanticGraphContext: boolean;
  useCandidateRanking: boolean;
  useSmokeTests: boolean;
  useGenerateExecution: boolean;
}

interface SelectionRedesignNodeSnapshot {
  nodeId: string;
  workflowId: string;
  label?: string;
  script?: {
    description?: string;
    code?: string;
    inputs?: PipelinePortContract[];
    outputs?: PipelinePortContract[];
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  textNode?: {
    value?: string;
  };
  fileOp?: {
    operation?: string;
  };
  latestInputs?: Record<string, string>;
  latestOutputs?: Record<string, string>;
}

interface SelectionRedesignEdgeSnapshot {
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface SelectionRedesignConnectionUpdate {
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface SelectionRedesignPlanUpdate {
  nodeId: string;
  label?: string;
  description?: string;
  inputs?: PipelinePortContract[];
  outputs?: PipelinePortContract[];
  textValue?: string;
  fileOperation?: 'copy' | 'move' | 'delete' | 'mkdir' | 'list';
}

interface SelectionRedesignPlan {
  summary: string;
  updates: SelectionRedesignPlanUpdate[];
  connections?: SelectionRedesignConnectionUpdate[];
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readScriptGenerationRolloutPolicy(): ScriptGenerationRolloutPolicy {
  const raw = String(process.env.WOODBURY_SCRIPT_GENERATION_POLICY || 'mixed').trim().toLowerCase();
  if (raw === 'legacy' || raw === 'mixed' || raw === 'agentic' || raw === 'direct') {
    return raw;
  }
  return 'mixed';
}

function readScriptGenerationModeOverride(mode: ScriptGenerationMode): ScriptGenerationModeOverride {
  const envMap: Record<ScriptGenerationMode, string> = {
    generate: 'WOODBURY_SCRIPT_GENERATION_MODE_GENERATE',
    edit: 'WOODBURY_SCRIPT_GENERATION_MODE_EDIT',
    repair: 'WOODBURY_SCRIPT_GENERATION_MODE_REPAIR',
    verify: 'WOODBURY_SCRIPT_GENERATION_MODE_VERIFY',
  };
  const raw = String(process.env[envMap[mode]] || 'inherit').trim().toLowerCase();
  if (raw === 'direct' || raw === 'agentic' || raw === 'inherit') return raw;
  return 'inherit';
}

function getScriptGenerationRolloutState(): {
  policy: ScriptGenerationRolloutPolicy;
  modeOverrides: Record<ScriptGenerationMode, ScriptGenerationModeOverride>;
  featureFlags: ScriptGenerationFeatureFlags;
} {
  return {
    policy: readScriptGenerationRolloutPolicy(),
    modeOverrides: {
      generate: readScriptGenerationModeOverride('generate'),
      edit: readScriptGenerationModeOverride('edit'),
      repair: readScriptGenerationModeOverride('repair'),
      verify: readScriptGenerationModeOverride('verify'),
    },
    featureFlags: getScriptGenerationFeatureFlags(),
  };
}

function getScriptGenerationFeatureFlags(): ScriptGenerationFeatureFlags {
  const policy = readScriptGenerationRolloutPolicy();
  const policyDefaults: Record<ScriptGenerationRolloutPolicy, ScriptGenerationFeatureFlags> = {
    legacy: {
      useAgenticRepairVerify: false,
      useExampleRetrieval: false,
      useSemanticGraphContext: false,
      useCandidateRanking: false,
      useSmokeTests: false,
      useGenerateExecution: false,
    },
    mixed: {
      useAgenticRepairVerify: true,
      useExampleRetrieval: true,
      useSemanticGraphContext: true,
      useCandidateRanking: true,
      useSmokeTests: true,
      useGenerateExecution: true,
    },
    agentic: {
      useAgenticRepairVerify: true,
      useExampleRetrieval: true,
      useSemanticGraphContext: true,
      useCandidateRanking: true,
      useSmokeTests: true,
      useGenerateExecution: true,
    },
    direct: {
      useAgenticRepairVerify: false,
      useExampleRetrieval: true,
      useSemanticGraphContext: true,
      useCandidateRanking: true,
      useSmokeTests: true,
      useGenerateExecution: false,
    },
  };
  const defaults = policyDefaults[policy];
  return {
    useAgenticRepairVerify: readBooleanEnv('WOODBURY_SCRIPT_AGENTIC_REPAIR_VERIFY', defaults.useAgenticRepairVerify),
    useExampleRetrieval: readBooleanEnv('WOODBURY_SCRIPT_EXAMPLE_RETRIEVAL', defaults.useExampleRetrieval),
    useSemanticGraphContext: readBooleanEnv('WOODBURY_SCRIPT_SEMANTIC_GRAPH_CONTEXT', defaults.useSemanticGraphContext),
    useCandidateRanking: readBooleanEnv('WOODBURY_SCRIPT_CANDIDATE_RANKING', defaults.useCandidateRanking),
    useSmokeTests: readBooleanEnv('WOODBURY_SCRIPT_SMOKE_TESTS', defaults.useSmokeTests),
    useGenerateExecution: readBooleanEnv('WOODBURY_SCRIPT_GENERATE_EXECUTION', defaults.useGenerateExecution),
  };
}

function shouldUseDirectScriptGeneration(mode: ScriptGenerationMode): boolean {
  const modeOverride = readScriptGenerationModeOverride(mode);
  if (modeOverride === 'direct') return true;
  if (modeOverride === 'agentic') return false;
  const policy = readScriptGenerationRolloutPolicy();
  if (policy === 'legacy' || policy === 'direct') return true;
  if (policy === 'agentic') return false;
  if (mode === 'repair' || mode === 'verify') {
    return !getScriptGenerationFeatureFlags().useAgenticRepairVerify;
  }
  return mode === 'generate' || mode === 'edit';
}

function formatContextValueSample(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}...` : value);
  }
  try {
    const rendered = JSON.stringify(value);
    if (!rendered) return String(value);
    return rendered.length > 180 ? `${rendered.slice(0, 177)}...` : rendered;
  } catch {
    return String(value);
  }
}

function formatPortContractsForPrompt(title: string, rawPorts: unknown): string {
  const ports = normalizePipelinePortContracts(rawPorts);
  if (ports.length === 0) return '';
  return [
    title,
    ...ports.map((port) => `- ${port.name} (${port.type})${port.description ? `: ${port.description}` : ''}`),
  ].join('\n');
}

function formatCompositionInterfaceContext(compositionInterface: unknown): string {
  if (!compositionInterface || typeof compositionInterface !== 'object') return '';
  const data = compositionInterface as Record<string, unknown>;
  const inputs = Array.isArray(data.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  if (inputs.length === 0 && outputs.length === 0) return '';

  const lines = ['Composition interface contract:'];
  if (inputs.length > 0) {
    lines.push('External inputs:');
    for (const input of inputs.slice(0, 12)) {
      if (!input || typeof input !== 'object') continue;
      const entry = input as Record<string, unknown>;
      lines.push(`- ${String(entry.name || 'input')} (${String(entry.type || 'string')})${entry.required ? ' [required]' : ' [optional]'}${entry.description ? `: ${String(entry.description)}` : ''}`);
    }
  }
  if (outputs.length > 0) {
    lines.push('Final outputs:');
    for (const output of outputs.slice(0, 12)) {
      if (!output || typeof output !== 'object') continue;
      const entry = output as Record<string, unknown>;
      lines.push(`- ${String(entry.name || 'output')} (${String(entry.type || 'string')})${entry.description ? `: ${String(entry.description)}` : ''}`);
    }
  }
  return lines.join('\n');
}

function formatCompositionDocumentationContext(documentation: unknown, currentNodeId?: string): string {
  const docs = Array.isArray(documentation)
    ? documentation.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>
    : [];
  if (docs.length === 0) return '';

  const relevantDocs = docs
    .filter((entry) => !currentNodeId || !Array.isArray(entry.nodeIds) || entry.nodeIds.includes(currentNodeId))
    .slice(0, 2);
  const fallbackDocs = relevantDocs.length > 0 ? relevantDocs : docs.slice(0, 2);
  if (fallbackDocs.length === 0) return '';

  return [
    'Relevant pipeline documentation:',
    ...fallbackDocs.map((entry, index) => {
      const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : `Documentation ${index + 1}`;
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      const markdown = typeof entry.markdown === 'string' ? entry.markdown.trim() : '';
      const excerpt = markdown ? markdown.split(/\r?\n/).slice(0, 18).join('\n') : '';
      return [title, summary, excerpt].filter(Boolean).join('\n');
    }),
  ].join('\n\n');
}

function shouldEnableGenerateExecution(mode: ScriptGenerationMode, options?: { dataContext?: unknown; graphContext?: unknown; runtimeFailure?: unknown }): boolean {
  if (mode !== 'generate') return true;
  const flags = getScriptGenerationFeatureFlags();
  if (!flags.useGenerateExecution) return false;
  return Boolean(options?.dataContext || options?.graphContext || options?.runtimeFailure || readBooleanEnv('WOODBURY_SCRIPT_GENERATE_EXECUTION_UNSAFE', false));
}

const SCRIPT_GENERATION_METRICS_DIR = join(homedir(), '.woodbury', 'data', 'script-generation');
const SCRIPT_GENERATION_METRICS_FILE = join(SCRIPT_GENERATION_METRICS_DIR, 'metrics.jsonl');

async function appendScriptGenerationMetricRecord(record: ScriptGenerationMetricRecord): Promise<void> {
  try {
    await mkdir(SCRIPT_GENERATION_METRICS_DIR, { recursive: true });
    await appendFile(SCRIPT_GENERATION_METRICS_FILE, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    debugLog.info('dashboard', 'Failed to persist script generation metrics', { error: String(err) });
  }
}

function summarizeScriptGenerationMetrics(records: ScriptGenerationMetricRecord[]): ScriptGenerationMetricsAggregate {
  const aggregate: ScriptGenerationMetricsAggregate = {
    totalRequests: records.length,
    byMode: { generate: 0, edit: 0, repair: 0, verify: 0 },
    byPath: { direct: 0, agentic: 0, fallback: 0 },
    fallbackRate: 0,
    repairRate: 0,
    runtimeEvidenceRate: 0,
    executionVerifiedRate: 0,
    sampleExecutionRate: 0,
    averageRetrievedExamples: 0,
    averageManualEdits: 0,
  };
  if (records.length === 0) return aggregate;

  let executionVerifiedCount = 0;
  let repairedCount = 0;
  let runtimeEvidenceCount = 0;
  let sampleExecutionCount = 0;
  let retrievedExampleTotal = 0;
  let manualEditTotal = 0;
  for (const record of records) {
    aggregate.byMode[record.mode] += 1;
    aggregate.byPath[record.metrics.generationPath] += 1;
    if (record.metrics.repairAttemptCount > 0) repairedCount += 1;
    if (record.metrics.runtimeEvidenceUsed) runtimeEvidenceCount += 1;
    if (record.metrics.executionVerified) executionVerifiedCount += 1;
    if (record.metrics.sampleExecutionUsed) sampleExecutionCount += 1;
    retrievedExampleTotal += record.metrics.retrievedExampleCount;
    manualEditTotal += record.metrics.manualEditCount || 0;
  }
  aggregate.fallbackRate = aggregate.byPath.fallback / records.length;
  aggregate.repairRate = repairedCount / records.length;
  aggregate.runtimeEvidenceRate = runtimeEvidenceCount / records.length;
  aggregate.executionVerifiedRate = executionVerifiedCount / records.length;
  aggregate.sampleExecutionRate = sampleExecutionCount / records.length;
  aggregate.averageRetrievedExamples = retrievedExampleTotal / records.length;
  aggregate.averageManualEdits = manualEditTotal / records.length;
  return aggregate;
}

async function readScriptGenerationMetricsSummary(limit = 30): Promise<{ recent: ScriptGenerationMetricRecord[]; aggregate: ScriptGenerationMetricsAggregate }> {
  try {
    const raw = await readFile(SCRIPT_GENERATION_METRICS_FILE, 'utf-8');
    const records = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScriptGenerationMetricRecord)
      .filter((record) => record && record.metrics && record.mode)
      .slice(-200);
    return {
      recent: records.slice(-Math.max(1, Math.min(limit, 50))).reverse(),
      aggregate: summarizeScriptGenerationMetrics(records),
    };
  } catch {
    return {
      recent: [],
      aggregate: summarizeScriptGenerationMetrics([]),
    };
  }
}

function formatPrePlanForPrompt(plan: ScriptPrePlan): string {
  const sections: string[] = [
    '## Pre-Generation Plan',
    `Intent: ${plan.intent}`,
    '',
    'Input ports:',
    ...plan.inputs.map(p => `- ${p.name} (${p.type}): ${p.description}${p.source ? ` [from: ${p.source}]` : ''}`),
    '',
    'Output ports:',
    ...plan.outputs.map(p => `- ${p.name} (${p.type}): ${p.description}`),
    '',
    plan.tools.length > 0 ? `Tools to use: ${plan.tools.join(', ')}` : 'Tools: none needed',
    '',
    'Algorithm:',
    ...plan.approach.map((step, i) => `${i + 1}. ${step}`),
  ];
  if (plan.edgeCases.length > 0) {
    sections.push('', 'Edge cases to handle:', ...plan.edgeCases.map(e => `- ${e}`));
  }
  sections.push('', 'Follow this plan exactly. Use the specified port names, types, and algorithm steps.');
  return sections.join('\n');
}

// ── Pipeline decomposition helpers ───────────────────────────

function validateDecompositionPlan(raw: unknown): PipelineDecompositionPlan | null {
  if (!raw || typeof raw !== 'object') return null;

  const plan = raw as Record<string, unknown>;

  // Required top-level fields
  if (typeof plan.pipelineName !== 'string' || !plan.pipelineName.trim()) return null;
  if (typeof plan.targetOutputSummary !== 'string' || !plan.targetOutputSummary.trim()) return null;
  if (!Array.isArray(plan.subContracts) || plan.subContracts.length === 0) return null;

  // Validate each sub-contract
  const contractNames = new Set<string>();
  const subContracts: PipelineSubContract[] = [];

  for (const sc of plan.subContracts) {
    if (!sc || typeof sc !== 'object') return null;
    const s = sc as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name.trim()) return null;
    if (typeof s.description !== 'string' || !s.description.trim()) return null;
    if (!Array.isArray(s.inputContract)) return null;
    if (!Array.isArray(s.outputContract)) return null;
    if (!Array.isArray(s.dependsOn)) return null;

    const nodeType = normalizeGeneratedPipelineNodeType(s.suggestedNodeType) || 'script';

    contractNames.add(s.name.trim());
    subContracts.push({
      name: s.name.trim(),
      description: s.description.trim(),
      suggestedNodeType: nodeType,
      inputContract: (s.inputContract as any[]).map((p: any) => ({
        name: String(p?.name || '').trim(),
        type: String(p?.type || 'string').trim(),
        description: String(p?.description || '').trim(),
        source: String(p?.source || 'user_input').trim(),
      })),
      outputContract: (s.outputContract as any[]).map((p: any) => ({
        name: String(p?.name || '').trim(),
        type: String(p?.type || 'string').trim(),
        description: String(p?.description || '').trim(),
      })),
      dependsOn: (s.dependsOn as any[]).map((d: any) => String(d).trim()),
    });
  }

  // Validate source references — must be another sub-contract name or "user_input"
  for (const sc of subContracts) {
    for (const input of sc.inputContract) {
      if (input.source !== 'user_input' && !contractNames.has(input.source)) {
        return null;
      }
    }
    for (const dep of sc.dependsOn) {
      if (!contractNames.has(dep)) return null;
    }
  }

  // Check for circular dependencies using topological sort
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const sc of subContracts) {
    adj.set(sc.name, []);
    inDeg.set(sc.name, 0);
  }
  for (const sc of subContracts) {
    for (const dep of sc.dependsOn) {
      adj.get(dep)?.push(sc.name);
      inDeg.set(sc.name, (inDeg.get(sc.name) || 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of (adj.get(current) || [])) {
      const newDeg = (inDeg.get(neighbor) || 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (sorted.length !== subContracts.length) return null; // circular dependency

  return {
    pipelineName: String(plan.pipelineName).trim(),
    targetOutputSummary: String(plan.targetOutputSummary).trim(),
    targetOutputType: typeof plan.targetOutputType === 'string' ? plan.targetOutputType.trim() : 'object',
    targetOutputFields: Array.isArray(plan.targetOutputFields)
      ? (plan.targetOutputFields as any[]).map((f: any) => ({
        name: String(f?.name || '').trim(),
        type: String(f?.type || 'string').trim(),
        description: String(f?.description || '').trim(),
      }))
      : [],
    subContracts,
    assemblyStrategy: typeof plan.assemblyStrategy === 'string' ? plan.assemblyStrategy.trim() : '',
    complexity: ['simple', 'moderate', 'complex'].includes(String(plan.complexity))
      ? (plan.complexity as 'simple' | 'moderate' | 'complex')
      : 'moderate',
  };
}

function formatDecompositionPlanForPipelinePrompt(plan: PipelineDecompositionPlan): string {
  const lines: string[] = [
    'CONTRACT-DRIVEN DECOMPOSITION PLAN',
    '===================================',
    `Target output: ${plan.targetOutputSummary}`,
    `Output type: ${plan.targetOutputType}`,
    `Complexity: ${plan.complexity}`,
  ];

  if (plan.targetOutputFields.length > 0) {
    lines.push('', 'Target output structure:');
    for (const f of plan.targetOutputFields) {
      lines.push(`  - ${f.name} (${f.type}): ${f.description}`);
    }
  }

  lines.push('', 'Sub-contracts (each becomes a pipeline node):');

  for (const sc of plan.subContracts) {
    lines.push('');
    lines.push(`[${sc.name}] (${sc.suggestedNodeType})`);
    lines.push(`  Purpose: ${sc.description}`);
    if (sc.dependsOn.length > 0) {
      lines.push(`  Depends on: ${sc.dependsOn.join(', ')}`);
    }
    if (sc.inputContract.length > 0) {
      lines.push('  Inputs:');
      for (const p of sc.inputContract) {
        lines.push(`    - ${p.name} (${p.type}): ${p.description} [from: ${p.source}]`);
      }
    }
    if (sc.outputContract.length > 0) {
      lines.push('  Outputs:');
      for (const p of sc.outputContract) {
        lines.push(`    - ${p.name} (${p.type}): ${p.description}`);
      }
    }
  }

  if (plan.assemblyStrategy) {
    lines.push('', `Assembly: ${plan.assemblyStrategy}`);
  }

  lines.push(
    '',
    'IMPORTANT: Create exactly one pipeline node per sub-contract above.',
    'Use the exact port names, types, and descriptions from each sub-contract.',
    'Connect nodes according to the dependsOn relationships and input source references.',
  );

  return lines.join('\n');
}

async function generatePipelineDecompositionPlan(
  description: string,
  toolDocs: string,
  publishedSkillsSection: string,
): Promise<PipelineDecompositionPlan | null> {
  try {
    const { runPrompt } = await import('../../loop/llm-service.js');
    const providerAndModel = getScriptGenerationProviderAndModel('pipeline');

    const systemContent = `You are a pipeline decomposition planner for a visual automation platform.

Given a task description, identify the TARGET OUTPUT STRUCTURE first, then decompose it into sub-contracts at interface boundaries. Each sub-contract becomes one pipeline node.

CRITICAL RULES:
1. Start from the OUTPUT STRUCTURE, not from procedural steps
2. Each sub-contract owns a specific sub-structure of the output
3. GRANULARITY IS KEY:
   - Simple tasks: 2-4 sub-contracts
   - Moderate tasks: 5-10 sub-contracts
   - Complex tasks (rich interfaces, nested structures): 8-20+ sub-contracts
   - When the user provides TypeScript interfaces/types, create ONE sub-contract per major interface — do NOT combine multiple interfaces into a single contract
4. Decompose at INTERFACE BOUNDARIES — where one data shape ends and another begins
5. If the user provides TypeScript interfaces, EACH interface is a natural boundary:
   - One contract generates ScriptMetadata, another generates CharacterDefinition[], another generates SceneSection[], etc.
   - Use for_each/loop contracts when producing arrays of complex objects (e.g. iterate over characters to generate headshots)
   - A final assembly contract stitches the parts into the top-level interface
6. If the task has no complex output structure, decompose by functional boundaries
7. Side-effect operations (saving files, generating images, creating assets) MUST be separate contracts — never combine generation + file I/O in one contract
8. Every sub-contract must have clearly typed input and output ports
9. Port types must be one of: string, number, boolean, object, string[], number[], object[]
10. Port names must use snake_case
11. Each sub-contract's inputContract.source must reference another sub-contract name or "user_input"
12. dependsOn must list sub-contract names that produce data this contract needs
13. Avoid circular dependencies — the graph must be a DAG
14. Prefer MANY small contracts over FEW large ones — a contract should do ONE thing

${toolDocs ? `Available tools that script nodes can use:\n${toolDocs}\n` : ''}
${publishedSkillsSection ? `${publishedSkillsSection}\n` : ''}
Return ONLY a JSON object (no explanation, no markdown fences) with this exact shape:
{
  "pipelineName": "Human-readable pipeline name",
  "targetOutputSummary": "What the pipeline ultimately produces",
  "targetOutputType": "The TypeScript-like type of the final output (e.g. ScriptDocument, Report, object)",
  "targetOutputFields": [
    { "name": "fieldName", "type": "string|number|object|etc", "description": "what this field is" }
  ],
  "subContracts": [
    {
      "name": "camelCaseContractName",
      "description": "What this sub-contract produces",
      "suggestedNodeType": "${PIPELINE_GENERATION_NODE_TYPE_LIST}",
      "inputContract": [
        { "name": "snake_case_port", "type": "string", "description": "...", "source": "otherContractName or user_input" }
      ],
      "outputContract": [
        { "name": "snake_case_port", "type": "object", "description": "..." }
      ],
      "dependsOn": ["otherContractName"]
    }
  ],
  "assemblyStrategy": "How sub-contract outputs combine into the final result",
  "complexity": "simple|moderate|complex"
}`;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemContent },
      { role: 'user', content: description.trim() },
    ];

    // Try up to 2 attempts — decomposition quality is critical for good pipelines
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await runPrompt(messages, providerAndModel.model, {
          maxTokens: 32768,
          temperature: 0.3,
        });

        let jsonStr = resp.content.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();

        const parsed = JSON.parse(jsonStr);
        const validated = validateDecompositionPlan(parsed);
        if (validated) return validated;

        lastError = new Error('Decomposition plan failed validation (returned null)');
      } catch (err) {
        lastError = err;
      }
      debugLog.info('dashboard', `Pipeline decomposition plan attempt ${attempt + 1} failed, ${attempt < 1 ? 'retrying...' : 'giving up'}`, { error: String(lastError) });
    }
    return null;
  } catch (err) {
    debugLog.info('dashboard', 'Pipeline decomposition plan failed (non-fatal, falling through)', { error: String(err) });
    return null;
  }
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

function trimScriptCodeExcerpt(code: string, maxLines = 18): string {
  const lines = String(code || '').split(/\r?\n/).slice(0, maxLines);
  return lines.join('\n').slice(0, 900).trim();
}

function extractSimilarityTerms(value: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'into', 'from', 'that', 'this', 'then', 'than', 'node', 'script', 'data', 'return', 'using', 'into', 'your']);
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function extractGraphPortHints(graphContext: unknown): string[] {
  if (!graphContext || typeof graphContext !== 'object') return [];
  const context = graphContext as Record<string, unknown>;
  const ports: string[] = [];
  const collect = (items: unknown, key: 'fromPort' | 'toPort') => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) ports.push(value.trim().toLowerCase());
    }
  };
  collect(context.upstream, 'toPort');
  collect(context.downstream, 'fromPort');
  return ports;
}

function scoreRetrievedScriptExample(queryTerms: string[], portHints: string[], example: {
  description: string;
  nodeLabel: string;
  inputs: PipelinePortContract[];
  outputs: PipelinePortContract[];
  code: string;
}): number {
  const haystack = [
    example.description,
    example.nodeLabel,
    example.inputs.map((port) => `${port.name} ${port.type} ${port.description}`).join(' '),
    example.outputs.map((port) => `${port.name} ${port.type} ${port.description}`).join(' '),
    trimScriptCodeExcerpt(example.code, 8),
  ].join(' ').toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 4;
  }
  for (const portHint of portHints) {
    if (haystack.includes(portHint)) score += 6;
  }
  if (example.outputs.length > 0) score += 2;
  if (example.inputs.length > 0) score += 1;
  return score;
}

async function retrieveRelevantScriptExamples(
  workDir: string,
  requestScopeMessage: string,
  graphContext: unknown,
  limit = 3,
): Promise<RetrievedScriptExample[]> {
  try {
    const discovered = await discoverCompositions(workDir);
    const queryTerms = extractSimilarityTerms(requestScopeMessage);
    const portHints = extractGraphPortHints(graphContext);
    const candidates: RetrievedScriptExample[] = [];

    for (const discoveredComp of discovered) {
      const composition = discoveredComp?.composition;
      if (!composition || !Array.isArray(composition.nodes)) continue;
      const compositionId = typeof composition.id === 'string' ? composition.id : '';
      const compositionName = typeof composition.name === 'string' ? composition.name : compositionId || 'Composition';

      for (const node of composition.nodes) {
        if (!node || node.workflowId !== '__script__' || !node.script?.code) continue;
        const inputs = normalizePipelinePortContracts(node.script.inputs);
        const outputs = normalizePipelinePortContracts(node.script.outputs);
        const score = scoreRetrievedScriptExample(queryTerms, portHints, {
          description: String(node.script.description || node.label || ''),
          nodeLabel: String(node.label || 'Script Node'),
          inputs,
          outputs,
          code: String(node.script.code || ''),
        });
        if (score <= 0) continue;
        candidates.push({
          compositionId,
          compositionName,
          nodeId: String(node.id || ''),
          nodeLabel: String(node.label || 'Script Node'),
          description: String(node.script.description || node.label || ''),
          inputs,
          outputs,
          codeExcerpt: trimScriptCodeExcerpt(String(node.script.code || '')),
          score,
        });
      }
    }

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } catch (err) {
    debugLog.info('dashboard', 'Failed to retrieve similar script examples', { error: String(err) });
    return [];
  }
}

function formatRetrievedScriptExamples(examples: RetrievedScriptExample[]): string {
  if (!Array.isArray(examples) || examples.length === 0) return '';
  return [
    'Relevant prior script examples:',
    ...examples.map((example, index) => [
      `${index + 1}. ${example.compositionName} / ${example.nodeLabel}`,
      `Description: ${example.description || 'No description recorded.'}`,
      example.inputs.length > 0 ? `Inputs: ${example.inputs.map((port) => `${port.name} (${port.type})`).join(', ')}` : 'Inputs: none recorded',
      example.outputs.length > 0 ? `Outputs: ${example.outputs.map((port) => `${port.name} (${port.type})`).join(', ')}` : 'Outputs: none recorded',
      'Code excerpt:',
      example.codeExcerpt,
    ].join('\n')),
  ].join('\n\n');
}

function formatRuntimeFailureEvidence(runtimeFailure: ScriptRuntimeFailure | string | undefined): string {
  if (!runtimeFailure) return '';
  if (typeof runtimeFailure === 'string') {
    return `Runtime failure evidence:\n${runtimeFailure.trim()}`;
  }
  const lines = ['Runtime failure evidence:'];
  if (runtimeFailure.nodeLabel || runtimeFailure.nodeId) {
    lines.push(`Node: ${runtimeFailure.nodeLabel || runtimeFailure.nodeId}`);
  }
  lines.push(`Message: ${runtimeFailure.message}`);
  if (runtimeFailure.stack) lines.push(`Stack:\n${runtimeFailure.stack}`);
  if (runtimeFailure.inputSummary !== undefined) {
    lines.push(`Input summary:\n${JSON.stringify(runtimeFailure.inputSummary, null, 2)}`);
  }
  return lines.join('\n');
}

function formatSemanticGraphContext(graphContext: unknown): string {
  if (!graphContext || typeof graphContext !== 'object') {
    return typeof graphContext === 'string' && graphContext.trim() ? `Derived graph contract hints:\n${graphContext.trim()}` : '';
  }
  const context = graphContext as Record<string, unknown>;
  const currentNode = context.currentNode && typeof context.currentNode === 'object'
    ? context.currentNode as Record<string, unknown>
    : null;
  const lines: string[] = ['Derived graph contract hints:'];
  if (currentNode) {
    lines.push(`Current node: ${String(currentNode.label || currentNode.type || 'unknown')}`);
    const currentInputs = formatPortContractsForPrompt('Current node inputs:', currentNode.inputs);
    if (currentInputs) lines.push(currentInputs);
    const currentOutputs = formatPortContractsForPrompt('Current node outputs:', currentNode.outputs);
    if (currentOutputs) lines.push(currentOutputs);
  }
  if (Array.isArray(context.pipelineInputs) && context.pipelineInputs.length > 0) {
    lines.push('Pipeline inputs:');
    for (const input of context.pipelineInputs.slice(0, 12) as Array<Record<string, unknown>>) {
      lines.push(`- ${String(input.name || 'input')} (${String(input.type || 'string')})${input.required ? ' [required]' : ' [optional]'}${input.description ? `: ${String(input.description)}` : ''}`);
    }
  }
  if (Array.isArray(context.pipelineOutputs) && context.pipelineOutputs.length > 0) {
    lines.push('Pipeline outputs:');
    for (const output of context.pipelineOutputs.slice(0, 12) as Array<Record<string, unknown>>) {
      lines.push(`- ${String(output.name || 'output')} (${String(output.type || 'string')})${output.description ? `: ${String(output.description)}` : ''}`);
    }
  }
  if (Array.isArray(context.upstream) && context.upstream.length > 0) {
    lines.push('Upstream handoffs:');
    for (const entry of context.upstream.slice(0, 10) as Array<Record<string, any>>) {
      lines.push(`- ${entry.node?.label || 'unknown'}.${entry.fromPort} -> ${entry.toPort}`);
      if (entry.expectedContract) lines.push(`  Expected contract: ${String(entry.expectedContract)}`);
      if ('latestValue' in entry) lines.push(`  Latest value: ${formatContextValueSample(entry.latestValue)}`);
      if ('sampleValue' in entry) lines.push(`  Sample value: ${formatContextValueSample(entry.sampleValue)}`);
    }
  }
  if (Array.isArray(context.downstream) && context.downstream.length > 0) {
    lines.push('Downstream consumers:');
    for (const entry of context.downstream.slice(0, 10) as Array<Record<string, any>>) {
      lines.push(`- ${entry.fromPort} -> ${entry.node?.label || 'unknown'}.${entry.toPort}`);
      if (entry.expectedContract) lines.push(`  Expected contract: ${String(entry.expectedContract)}`);
    }
  }
  if (context.composition && typeof context.composition === 'object') {
    const composition = context.composition as Record<string, unknown>;
    if (composition.name || composition.description) {
      lines.push(`Composition: ${String(composition.name || 'Untitled composition')}`);
      if (composition.description) lines.push(`Composition purpose: ${String(composition.description)}`);
    }
  }
  const docsText = formatCompositionDocumentationContext(context.generatedPipelineDocs, typeof context.currentNodeId === 'string' ? context.currentNodeId : undefined);
  if (docsText) {
    lines.push(docsText);
  }
  return lines.join('\n');
}

function sampleValueForPortType(type: string): unknown {
  switch (type) {
    case 'number':
      return 3;
    case 'boolean':
      return true;
    case 'object':
      return { sample: true, id: 'example' };
    case 'string[]':
      return ['alpha', 'beta'];
    case 'number[]':
      return [1, 2, 3];
    case 'object[]':
      return [{ id: 'item-1' }, { id: 'item-2' }];
    case 'string':
    default:
      return 'sample value';
  }
}

function buildSupplementalScriptContractTests(
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
): ScriptGenerationTestCase[] {
  if (!Array.isArray(outputs) || outputs.length === 0) return [];
  const expectedOutputTypes = Object.fromEntries(outputs.map((output) => [output.name, output.type]));
  return [
    {
      name: 'declared_contract_smoke',
      inputs: Object.fromEntries(inputs.map((input) => [input.name, sampleValueForPortType(input.type)])),
      requiredOutputKeys: outputs.map((output) => output.name),
      expectedOutputTypes,
    },
  ];
}

function sampleEmptyValueForPortType(type: string): unknown {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return {};
    case 'string[]':
    case 'number[]':
    case 'object[]':
      return [];
    case 'string':
    default:
      return '';
  }
}

function sampleWrongTypeValueForPortType(type: string): unknown {
  switch (type) {
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'object':
      return 'not-an-object';
    case 'string[]':
      return { bad: true };
    case 'number[]':
      return 'not-a-number-array';
    case 'object[]':
      return 'not-an-object-array';
    case 'string':
    default:
      return 999;
  }
}

function scriptUsesProgressSignals(code: string): boolean {
  return /context\.progress\.(start|set|increment|complete)\(/.test(code);
}

function scriptLooksLoopHeavy(code: string): boolean {
  return /\b(for|while)\s*\(|\.map\(|\.forEach\(|for\s+await\s*\(/.test(code);
}

function buildEdgeCaseScriptContractTests(
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
): ScriptGenerationTestCase[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || !Array.isArray(outputs) || outputs.length === 0) return [];

  const tests: ScriptGenerationTestCase[] = [];
  const expectedOutputTypes = Object.fromEntries(outputs.map((output) => [output.name, output.type]));
  tests.push({
    name: 'empty_input_contract',
    inputs: Object.fromEntries(inputs.map((input) => [input.name, sampleEmptyValueForPortType(input.type)])),
    requiredOutputKeys: outputs.map((output) => output.name),
    expectedOutputTypes,
  });
  tests.push({
    name: 'nullish_input_contract',
    inputs: Object.fromEntries(inputs.map((input) => [input.name, null])),
    requiredOutputKeys: outputs.map((output) => output.name),
  });
  tests.push({
    name: 'wrong_type_input_contract',
    inputs: Object.fromEntries(inputs.map((input) => [input.name, sampleWrongTypeValueForPortType(input.type)])),
    requiredOutputKeys: outputs.map((output) => output.name),
  });
  return tests;
}

function buildProgressContractTests(
  code: string,
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
): ScriptGenerationTestCase[] {
  if (!scriptUsesProgressSignals(code) || !scriptLooksLoopHeavy(code) || outputs.length === 0) return [];
  return [{
    name: 'progress_contract',
    inputs: Object.fromEntries(inputs.map((input) => [input.name, sampleValueForPortType(input.type)])),
    requiredOutputKeys: outputs.map((output) => output.name),
    requireProgressCalls: true,
    requireProgressCompletion: true,
  }];
}

function parseLooseContextSample(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{\"]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function coerceSampleInputValue(value: unknown, declaredType: string): unknown {
  if (value === undefined) return sampleValueForPortType(declaredType);
  switch (declaredType) {
    case 'string':
      return typeof value === 'string' ? value : formatContextValueSample(value);
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (Array.isArray(value)) return value.length;
      return 1;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : Boolean(value);
    case 'string[]':
      return Array.isArray(value)
        ? value.map((item) => typeof item === 'string' ? item : formatContextValueSample(item)).slice(0, 5)
        : [typeof value === 'string' ? value : formatContextValueSample(value)];
    case 'number[]':
      if (Array.isArray(value)) {
        const numbers = value
          .map((item) => typeof item === 'number' && Number.isFinite(item) ? item : Number(item))
          .filter((item) => Number.isFinite(item));
        return numbers.length > 0 ? numbers.slice(0, 5) : [1];
      }
      return [typeof value === 'number' && Number.isFinite(value) ? value : 1];
    case 'object[]':
      if (Array.isArray(value)) {
        return value.map((item, index) => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
          ? item
          : { index, value: formatContextValueSample(item) }).slice(0, 5);
      }
      return [Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value : { value: formatContextValueSample(value) }];
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value
        : { value: formatContextValueSample(value) };
    default:
      return value;
  }
}

function mergeScriptGenerationTests(...groups: ScriptGenerationTestCase[][]): ScriptGenerationTestCase[] {
  const merged = new Map<string, ScriptGenerationTestCase>();
  for (const group of groups) {
    for (const testCase of group || []) {
      if (!testCase || typeof testCase.name !== 'string' || !testCase.name.trim()) continue;
      if (!merged.has(testCase.name)) {
        merged.set(testCase.name, testCase);
      }
    }
  }
  return Array.from(merged.values());
}

function buildBoundedGenerateExecutionTests(
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
  options?: { dataContext?: unknown; graphContext?: unknown },
): { tests: ScriptGenerationTestCase[]; source: 'none' | 'data_context' | 'graph_context' } {
  if (!Array.isArray(inputs) || inputs.length === 0 || !Array.isArray(outputs) || outputs.length === 0) {
    return { tests: [], source: 'none' };
  }

  const expectedOutputTypes = Object.fromEntries(outputs.map((output) => [output.name, output.type]));
  const resolvedInputs: Record<string, unknown> = {};
  let source: 'none' | 'data_context' | 'graph_context' = 'none';

  const graphContext = options?.graphContext && typeof options.graphContext === 'object'
    ? options.graphContext as Record<string, unknown>
    : null;
  const upstreamEntries = graphContext && Array.isArray(graphContext.upstream)
    ? graphContext.upstream.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>
    : [];
  for (const input of inputs) {
    const upstreamMatch = upstreamEntries.find((entry) => typeof entry.toPort === 'string' && entry.toPort === input.name && entry.latestValue !== undefined);
    if (upstreamMatch && upstreamMatch.latestValue !== undefined) {
      resolvedInputs[input.name] = coerceSampleInputValue(upstreamMatch.latestValue, input.type);
      source = 'graph_context';
    }
  }

  if (source === 'none' && options?.dataContext !== undefined) {
    const parsedDataContext = parseLooseContextSample(options.dataContext);
    if (Boolean(parsedDataContext) && typeof parsedDataContext === 'object' && !Array.isArray(parsedDataContext)) {
      for (const input of inputs) {
        if (Object.prototype.hasOwnProperty.call(parsedDataContext, input.name)) {
          resolvedInputs[input.name] = coerceSampleInputValue((parsedDataContext as Record<string, unknown>)[input.name], input.type);
          source = 'data_context';
        }
      }
    }
    if (source === 'none') {
      resolvedInputs[inputs[0].name] = coerceSampleInputValue(parsedDataContext, inputs[0].type);
      source = 'data_context';
    }
  }

  if (source === 'none') return { tests: [], source };

  for (const input of inputs) {
    if (!(input.name in resolvedInputs)) {
      resolvedInputs[input.name] = sampleValueForPortType(input.type);
    }
  }

  return {
    source,
    tests: [{
      name: 'bounded_sample_execution',
      inputs: resolvedInputs,
      requiredOutputKeys: outputs.map((output) => output.name),
      expectedOutputTypes,
    }],
  };
}

function scoreScriptGenerationCandidate(
  validation: { ok: boolean; issues: string[] },
  smokeResults: ScriptGenerationTestResultSummary[],
  code: string,
): number {
  let score = validation.ok ? 200 : 0;
  score -= validation.issues.length * 40;
  score += smokeResults.filter((result) => result.passed).length * 20;
  score -= smokeResults.filter((result) => !result.passed).length * 30;
  score += Math.max(0, 20 - Math.floor(code.length / 250));
  return score;
}

interface ScriptGenerationTestResultSummary {
  name: string;
  passed: boolean;
  failures: string[];
}

function buildCandidateStrategyHint(candidateIndex: number): string {
  if (candidateIndex === 1) {
    return 'Favor the simplest implementation that directly satisfies the declared contracts with explicit validation.';
  }
  if (candidateIndex === 2) {
    return 'Favor robust edge-case handling and clear intermediate normalization before returning outputs.';
  }
  return 'Favor a balanced implementation that matches the request closely.';
}

function parseScriptPorts(code: string): { inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }> } {
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  const outputs: Array<{ name: string; type: string; description: string }> = [];
  const regex = /@(input|output)\s+(\w+)\s+(string\[\]|number\[\]|object\[\]|string|number|boolean|object)\s*(?:"([^"]*)")?/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const decl = { name: match[2], type: match[3], description: match[4] || '' };
    (match[1] === 'input' ? inputs : outputs).push(decl);
  }
  return { inputs, outputs };
}

function extractCodeBlock(content: string): string {
  // Try explicit javascript/js fence first
  const jsFenceMatch = content.match(/```(?:javascript|js)\s*\n([\s\S]*?)\n```/);
  if (jsFenceMatch) return jsFenceMatch[1].trim();

  // Handle LLM wrapping response in ```json { "code": "..." } ```
  const jsonFenceMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonFenceMatch) {
    try {
      const parsed = JSON.parse(jsonFenceMatch[1]);
      if (typeof parsed.code === 'string' && parsed.code.includes('function execute')) {
        return parsed.code.trim();
      }
    } catch { /* not valid JSON, fall through */ }
  }

  // Handle bare JSON wrapper (no fences) — { "code": "..." }
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"code"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.code === 'string' && parsed.code.includes('function execute')) {
        return parsed.code.trim();
      }
    } catch { /* not valid JSON, fall through */ }
  }

  // Try any generic code fence
  const genericFenceMatch = content.match(/```\s*\n([\s\S]*?)\n```/);
  if (genericFenceMatch) return genericFenceMatch[1].trim();

  return trimmed;
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

  // ── Anti-pattern detection ──────────────────────────────────
  // Detect JSON.stringify on return values (objects passed between nodes should stay as objects)
  if (/JSON\.stringify\s*\([^)]*\)\s*\)?\s*[;,]?\s*$/.test(code) || /\.map\s*\(\s*\w+\s*=>\s*JSON\.stringify\s*\(/.test(code)) {
    // Check if it's in a return context
    if (/return\s*\{[^}]*JSON\.stringify/.test(code)) {
      issues.push('ANTI-PATTERN: Do not JSON.stringify output values. Outputs are passed as native JS objects between nodes. JSON.stringify converts them to strings which causes "[object Object] is not valid JSON" errors in downstream nodes.');
    }
  }

  // Detect JSON.parse on inputs that are already objects
  if (/JSON\.parse\s*\(\s*inputs\./.test(code) && !/typeof\s+inputs\.\w+\s*===?\s*['"]string['"]/.test(code)) {
    issues.push('ANTI-PATTERN: Do not JSON.parse inputs from other nodes. Inputs arrive as their declared types (objects, arrays, etc.), not as JSON strings. If you must handle both, use: typeof x === "string" ? JSON.parse(x) : x');
  }

  // Detect unguarded iteration
  if (/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+inputs\./.test(code) && !/Array\.isArray\s*\(\s*inputs\./.test(code)) {
    issues.push('ANTI-PATTERN: Unguarded iteration over inputs. Always check Array.isArray(inputs.x) before iterating, because unconnected ports arrive as undefined.');
  }

  // Detect console.log usage
  if (/console\.(log|warn|error)\s*\(/.test(code)) {
    issues.push('Do not use console.log/warn/error. Use context.log() instead.');
  }

  // Detect require/import statements
  if (/\brequire\s*\(|^import\s+/m.test(code)) {
    issues.push('Do not use require() or import statements. The execute() function runs in a sandboxed environment. Use context.tools and context.llm for all external functionality.');
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

/**
 * Critical rules that prevent the most common code generation failures.
 * These are injected into EVERY script generation prompt.
 */
const SCRIPT_ROBUSTNESS_RULES = [
  '',
  '## CRITICAL CODE RULES — violations cause runtime failures for end users:',
  '',
  '1. **NEVER JSON.stringify objects between nodes.** Outputs are passed as native JS objects/arrays, not strings.',
  '   - BAD:  return { cast: characters.map(c => JSON.stringify(c)) }',
  '   - GOOD: return { cast: characters }',
  '   Downstream nodes receive the actual objects. JSON.stringify destroys them.',
  '',
  '2. **NEVER JSON.parse inputs from other nodes.** Inputs arrive as their declared types, not strings.',
  '   - BAD:  const data = JSON.parse(inputs.cast)',
  '   - GOOD: const data = inputs.cast',
  '   If the input might be either a string or object, use: const data = typeof inputs.x === "string" ? JSON.parse(inputs.x) : inputs.x',
  '',
  '3. **ALWAYS guard iterable inputs.** Inputs from unconnected ports arrive as empty arrays/strings/etc.',
  '   - BAD:  for (const item of inputs.items) { ... }',
  '   - GOOD: const items = Array.isArray(inputs.items) ? inputs.items : []; for (const item of items) { ... }',
  '',
  '4. **ALWAYS validate inputs before using them.** Never assume an input is present or the right type.',
  '   - Check arrays: Array.isArray(x) before iterating',
  '   - Check strings: typeof x === "string" && x.length > 0 before parsing',
  '   - Check objects: x && typeof x === "object" before accessing properties',
  '',
  '5. **Port types must match between nodes.** If you output `cast: object[]`, the downstream node must declare `cast: object[]`, not `cast: string[]`.',
  '',
  '6. **NEVER use console.log.** Use context.log() for logging.',
  '',
  '7. **NEVER import modules.** The execute() function runs in a sandboxed AsyncFunction. Use context.tools and context.llm instead.',
  '',
  '8. **ALWAYS return all declared @output ports.** If an output is conditional, return a sensible default (empty array, empty string, etc.).',
  '',
  '9. **ALWAYS wrap the function body in try/catch.** Return fallback values on error so the pipeline continues.',
  '',
  '10. **NEVER produce nested JSON strings.** If your LLM call returns JSON, parse it once. Do not re-stringify it for output. Downstream nodes expect objects, not strings of objects.',
  '',
].join('\n');

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

function getScriptGenerationAllowedTools(mode: ScriptGenerationMode, executionEnabled = false): string[] {
  const flags = getScriptGenerationFeatureFlags();
  if (mode === 'edit' || mode === 'repair' || mode === 'verify' || (mode === 'generate' && flags.useGenerateExecution && executionEnabled)) {
    return SCRIPT_GENERATION_BASE_TOOLS.concat(SCRIPT_GENERATION_EXECUTION_TOOLS);
  }
  return SCRIPT_GENERATION_BASE_TOOLS.slice();
}

function getScriptGenerationModeGuidance(mode: ScriptGenerationMode, executionEnabled = false): string {
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

  if (mode === 'generate' && executionEnabled) {
    return [
      'This is a normal script generation flow.',
      'Limited execution tools are enabled because the request included enough concrete context to validate uncertain assumptions safely.',
      'Use code_execute or test_run only when it materially improves confidence in the generated script contract.',
      'Prefer fast, deterministic checks over exploratory execution.',
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

function getScriptGenerationProviderAndModel(stage: ScriptGenerationStage = 'generation'): { provider: 'openai' | 'anthropic' | 'groq'; model: string } {
  const stageEnvMap: Record<ScriptGenerationStage, string> = {
    planning: 'WOODBURY_SCRIPT_MODEL_PLANNING',
    generation: 'WOODBURY_SCRIPT_MODEL_GENERATION',
    repair: 'WOODBURY_SCRIPT_MODEL_REPAIR',
    verification: 'WOODBURY_SCRIPT_MODEL_VERIFICATION',
    pipeline: 'WOODBURY_SCRIPT_MODEL_PIPELINE',
  };
  const modelOverride = process.env[stageEnvMap[stage]]?.trim();

  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: modelOverride || 'claude-sonnet-4-20250514' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: modelOverride || 'gpt-4o-mini' };
  if (process.env.GROQ_API_KEY) return { provider: 'groq', model: modelOverride || 'llama-3.1-70b-versatile' };
  return { provider: 'anthropic', model: modelOverride || 'claude-sonnet-4-20250514' };
}

// ── Pre-generation planning ──────────────────────────────────

async function generateScriptPrePlan(
  userMessage: string,
  toolDocs: string,
  options?: {
    currentCode?: string;
    mode?: ScriptGenerationMode;
  },
): Promise<ScriptPrePlan | null> {
  const { runPrompt } = await import('../../loop/llm-service.js');
  const providerAndModel = getScriptGenerationProviderAndModel('planning');

  const systemContent = [
    'You are a script planning assistant for a visual pipeline builder.',
    'Given a task description, pipeline graph context, and available tools, produce a structured plan for a script node.',
    'Return ONLY a JSON object (no explanation, no markdown fences) with this exact shape:',
    '{',
    '  "intent": "restatement of what this script should do",',
    '  "inputs": [{ "name": "snake_case", "type": "string|number|boolean|object|string[]|number[]|object[]", "description": "...", "source": "optional: upstream node/port" }],',
    '  "outputs": [{ "name": "snake_case", "type": "...", "description": "..." }],',
    '  "tools": ["context.tools.X or context.llm.generateText etc, or empty array if none needed"],',
    '  "approach": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],',
    '  "edgeCases": ["Handle empty input by ...", "Validate that ..."]',
    '}',
    '',
    'RULES:',
    '- Input port names MUST match the names provided by upstream nodes in the graph context. Do not invent new names if an upstream port already has a name.',
    '- Output port names should use snake_case and be descriptive.',
    '- The approach should be 3-8 concrete steps describing the algorithm, not vague.',
    '- List specific tool names from the available tools section. Use an empty array if no tools are needed.',
    '- Edge cases should cover: empty/missing inputs, type mismatches, and any domain-specific validation.',
    '- Do NOT write any JavaScript code. This is a plan only.',
  ].join('\n');

  const userContent = [
    `Task request:\n${userMessage}`,
    toolDocs ? `\nAvailable tools:\n${toolDocs}` : '',
    options?.currentCode ? `\nExisting code to consider:\n\`\`\`javascript\n${options.currentCode}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  try {
    const response = await runPrompt([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ], providerAndModel.model, {
      maxTokens: 32768,
      temperature: 0.1,
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;
    const parsed = JSON.parse(jsonStr);

    if (
      !parsed ||
      typeof parsed.intent !== 'string' ||
      !Array.isArray(parsed.inputs) ||
      !Array.isArray(parsed.outputs) ||
      !Array.isArray(parsed.approach)
    ) {
      debugLog.info('dashboard', 'Pre-plan returned invalid structure, skipping', { raw: raw.slice(0, 200) });
      return null;
    }

    return {
      intent: parsed.intent,
      inputs: normalizePipelinePortContracts(parsed.inputs).map((port, i) => ({
        ...port,
        source: typeof parsed.inputs[i]?.source === 'string' ? parsed.inputs[i].source : undefined,
      })),
      outputs: normalizePipelinePortContracts(parsed.outputs),
      tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === 'string').slice(0, 10) : [],
      approach: parsed.approach.filter((s: unknown) => typeof s === 'string').slice(0, 10),
      edgeCases: Array.isArray(parsed.edgeCases) ? parsed.edgeCases.filter((s: unknown) => typeof s === 'string').slice(0, 6) : [],
    };
  } catch (err) {
    debugLog.info('dashboard', 'Pre-plan generation failed, falling through', { error: String(err) });
    return null;
  }
}

async function generateScriptUnitTestCases(
  userMessage: string,
  code: string,
  inputs: Array<{ name: string; type: string; description: string }>,
  outputs: Array<{ name: string; type: string; description: string }>,
): Promise<ScriptGenerationTestCase[]> {
  try {
    const { runPrompt } = await import('../../loop/llm-service.js');
    const providerAndModel = getScriptGenerationProviderAndModel('verification');
    const response = await runPrompt([
      {
        role: 'system',
        content: 'You create deterministic unit test cases for Woodbury script-node code. Return ONLY a JSON array. Each item must use this shape: { "name": string, "inputs": object, "llmGenerate"?: string, "llmGenerateJSON"?: object, "expectedOutputSubset"?: object, "requiredOutputKeys"?: string[] }. Prefer 1-3 tests. Avoid filesystem, network, or nondeterministic assertions. Include at least one contract-oriented test that checks declared outputs are present. When safe, include edge-case tests for empty strings, empty arrays, or simple null-adjacent values. Do NOT assert exact large arrays, exact parsed natural-language structures, or exact nested object payloads unless they are trivially derivable from literal inputs. Prefer requiredOutputKeys, type-stable subsets, and small scalar subsets.',
      },
      {
        role: 'user',
        content: `Request:\n${userMessage}\n\nDeclared inputs:\n${JSON.stringify(inputs, null, 2)}\n\nDeclared outputs:\n${JSON.stringify(outputs, null, 2)}\n\nCode:\n\`\`\`javascript\n${code}\n\`\`\``,
      },
    ], providerAndModel.model, { maxTokens: 32768, temperature: 0.1 });

    const raw = response.content.trim();
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const parsed = JSON.parse((match[1] || raw).trim());
    if (!Array.isArray(parsed)) return [];
    return sanitizeScriptGenerationTestCases(parsed, outputs).slice(0, 3);
  } catch (err) {
    debugLog.info('dashboard', 'Script unit test generation returned invalid content, skipping', { error: String(err) });
    return [];
  }
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
  const outputTypeByName = new Map(outputs.map((output) => [output.name, output.type]));
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

    const typedKeys = (requiredOutputKeys.length > 0 ? requiredOutputKeys : declaredOutputNames)
      .filter((key) => outputTypeByName.has(key));
    const expectedOutputTypes = typedKeys.length > 0
      ? Object.fromEntries(typedKeys.map((key) => [key, outputTypeByName.get(key) || 'string']))
      : undefined;

    sanitized.push({
      name,
      inputs,
      llmGenerate: typeof candidate.llmGenerate === 'string' ? candidate.llmGenerate : undefined,
      llmGenerateJSON: candidate.llmGenerateJSON,
      expectedOutputSubset,
      requiredOutputKeys: requiredOutputKeys.length > 0 ? Array.from(new Set(requiredOutputKeys)) : undefined,
      expectedOutputTypes,
    });
  }

  return sanitized;
}

async function runScopedScriptGenerationPass(
  ctx: DashboardContext,
  objective: string,
  options?: { chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; sessionSuffix?: string; mode?: ScriptGenerationMode; executionEnabled?: boolean },
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
  const allowed = new Set(getScriptGenerationAllowedTools(mode, options?.executionEnabled === true));
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
  const systemPrompt = `${basePrompt}\n\n## Script Node Generation\nYou are generating or repairing code for a Woodbury __script__ node. This is not a repository editing task. Use only the scoped tools available for planning, reasoning, validation, and repair. ${getScriptGenerationModeGuidance(mode, options?.executionEnabled === true)} The final answer must be a single JavaScript code block and nothing else.`;
  const providerAndModel = getScriptGenerationProviderAndModel(mode === 'repair' || mode === 'verify' ? 'repair' : 'generation');
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
    prePlan?: ScriptPrePlan;
    requestScopeMessage?: string;
    retrievedExamples?: RetrievedScriptExample[];
    runtimeFailure?: ScriptRuntimeFailure | string;
    semanticGraphContext?: string;
    compositionDocumentation?: unknown;
    strategyHint?: string;
    temperature?: number;
  },
): Promise<string> {
  const { runPrompt } = await import('../../loop/llm-service.js');
  const providerAndModel = getScriptGenerationProviderAndModel(
    options?.mode === 'repair' || options?.mode === 'verify' ? 'repair' : 'generation',
  );
  const historyText = options?.chatHistory && options.chatHistory.length > 0
    ? `Prior script conversation:\n${options.chatHistory.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n')}`
    : '';
  const requestScopeMessage = typeof options?.requestScopeMessage === 'string' && options.requestScopeMessage.trim()
    ? options.requestScopeMessage.trim()
    : userMessage;
  const builtinGuidance = buildWoodburyBuiltinToolingGuidance(requestScopeMessage);
  const codeText = options?.currentCode
    ? `Current code candidate:\n\`\`\`javascript\n${options.currentCode}\n\`\`\``
    : '';
  const issuesText = options?.issues && options.issues.length > 0
    ? `Known problems to fix:\n- ${options.issues.join('\n- ')}`
    : '';
  const retrievedExamplesText = formatRetrievedScriptExamples(options?.retrievedExamples || []);
  const runtimeFailureText = formatRuntimeFailureEvidence(options?.runtimeFailure);
  const modeGuidance = getScriptGenerationModeGuidance(options?.mode || 'generate');
  const editGuidance = getScriptEditGuidance(requestScopeMessage, Boolean(options?.currentCode));
  const planSection = options?.prePlan ? formatPrePlanForPrompt(options.prePlan) : '';
  const documentationSection = formatCompositionDocumentationContext(options?.compositionDocumentation);
  const requestInstruction = options?.currentCode
    ? 'Update the existing Woodbury script node code to satisfy the request. Return the full updated script.'
    : 'Generate a Woodbury script node that satisfies the request. Return the full script.';

  const response = await runPrompt([
    {
      role: 'system',
      content: [
        'You generate JavaScript for a Woodbury pipeline script node.',
        'Return ONLY a single fenced ```javascript code block. Do not include any prose before or after the block. NEVER wrap the response in ```json or return a JSON object with a "code" field — return the raw JavaScript code in a ```javascript fence.',
        'The code must include a JSDoc block with at least one @input and at least one @output annotation.',
        'The code must define async function execute(inputs, context).',
        'The execute function must return an object containing all declared outputs.',
        'Preserve the requested behavior while fixing any structural validation errors.',
        SCRIPT_ROBUSTNESS_RULES,
        builtinGuidance,
        SCRIPT_PROGRESS_GUIDANCE,
        planSection,
        options?.semanticGraphContext,
        documentationSection,
        retrievedExamplesText,
        modeGuidance,
        editGuidance,
        options?.strategyHint ? `Candidate guidance: ${options.strategyHint}` : '',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: [
        requestInstruction,
        `Task request:\n${userMessage}`,
        issuesText,
        runtimeFailureText,
        codeText,
        historyText,
        toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ], providerAndModel.model, { maxTokens: 32768, temperature: options?.temperature ?? (await getSavedTemperature()) ?? 0.1 });

  return response.content.trim();
}

async function runScriptGenerationWithClosureEngine(
  ctx: DashboardContext,
  userMessage: string,
  toolDocs: string,
  chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  mode: ScriptGenerationMode = 'generate',
  currentCode?: unknown,
  requestScopeMessage?: string,
  options?: {
    graphContext?: unknown;
    runtimeFailure?: ScriptRuntimeFailure | string;
    dataContext?: unknown;
    compositionInterface?: unknown;
    compositionDocumentation?: unknown;
    currentNodeId?: string;
    manualEditCount?: number;
  },
): Promise<{ code: string; assistantMessage: string; inputs: Array<{ name: string; type: string; description: string }>; outputs: Array<{ name: string; type: string; description: string }>; lifecycle: ScriptGenerationLifecycle }> {
  const flags = getScriptGenerationFeatureFlags();
  const scopedRequestMessage = typeof requestScopeMessage === 'string' && requestScopeMessage.trim()
    ? requestScopeMessage.trim()
    : userMessage;
  const builtinGuidance = buildWoodburyBuiltinToolingGuidance(scopedRequestMessage);
  const normalizedCurrentCode = typeof currentCode === 'string' && currentCode.trim() ? currentCode : undefined;
  const hasCurrentCode = Boolean(normalizedCurrentCode);
  const editGuidance = getScriptEditGuidance(scopedRequestMessage, hasCurrentCode);
  const semanticGraphText = flags.useSemanticGraphContext ? formatSemanticGraphContext(options?.graphContext) : '';
  const compositionInterfaceText = formatCompositionInterfaceContext(options?.compositionInterface);
  const compositionDocumentationText = formatCompositionDocumentationContext(options?.compositionDocumentation, options?.currentNodeId);
  const retrievedExamples = flags.useExampleRetrieval
    ? await retrieveRelevantScriptExamples(ctx.workDir, scopedRequestMessage, options?.graphContext)
    : [];
  const retrievedExamplesText = formatRetrievedScriptExamples(retrievedExamples);
  const runtimeFailureText = formatRuntimeFailureEvidence(options?.runtimeFailure);
  const directGenerationPath = shouldUseDirectScriptGeneration(mode);
  const directCandidateCount = directGenerationPath && flags.useCandidateRanking && mode === 'generate' ? 3 : 1;
  const executionEnabled = shouldEnableGenerateExecution(mode, {
    dataContext: options?.dataContext,
    graphContext: options?.graphContext,
    runtimeFailure: options?.runtimeFailure,
  });

  // ── Pre-generation planning step ──
  let prePlan: ScriptPrePlan | null = null;
  if (mode === 'generate' || (mode === 'edit' && !normalizedCurrentCode)) {
    prePlan = await generateScriptPrePlan(scopedRequestMessage, toolDocs, {
      currentCode: normalizedCurrentCode,
      mode,
    });
  }

  const generationObjective = [
    'Generate JavaScript for a Woodbury pipeline script node.',
    'Use the dedicated script-node generation skill and validate the result before finishing.',
    'Final answer format: return ONLY a single ```javascript code block. NEVER wrap the response in ```json or return a JSON object with a "code" field.',
    'The code must include a JSDoc block with @input and @output annotations.',
    'The code must define async function execute(inputs, context).',
    'The function must return an object containing all declared outputs.',
    SCRIPT_ROBUSTNESS_RULES,
    builtinGuidance,
    SCRIPT_PROGRESS_GUIDANCE,
    prePlan ? formatPrePlanForPrompt(prePlan) : '',
    semanticGraphText,
    retrievedExamplesText,
    compositionInterfaceText,
    compositionDocumentationText,
    runtimeFailureText,
    getScriptGenerationModeGuidance(mode, executionEnabled),
    editGuidance,
    toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
    `Task request:\n${userMessage}`,
  ].filter(Boolean).join('\n\n');

  let generationPass: { content: string; selectedSkills: string[]; toolNames: string[]; trace: ScriptGenerationTraceEvent[] };
  if (directGenerationPath) {
    const candidates: Array<{
      content: string;
      code: string;
      validation: ReturnType<typeof validateGeneratedScriptCode>;
      smokeResults: ScriptGenerationTestResultSummary[];
      score: number;
      index: number;
    }> = [];
    for (let candidateIndex = 0; candidateIndex < directCandidateCount; candidateIndex += 1) {
      const directResponse = await runStrictScriptGenerationFallback(userMessage, toolDocs, {
        chatHistory,
        currentCode: normalizedCurrentCode,
        mode,
        prePlan: prePlan || undefined,
        requestScopeMessage: scopedRequestMessage,
        retrievedExamples,
        runtimeFailure: options?.runtimeFailure,
        semanticGraphContext: semanticGraphText,
        compositionDocumentation: options?.compositionDocumentation,
        strategyHint: buildCandidateStrategyHint(candidateIndex),
        temperature: 0.1 + (candidateIndex * 0.08),
      });
      const directCode = extractCodeBlock(directResponse);
      const directValidation = validateGeneratedScriptCode(directCode, { userMessage: scopedRequestMessage });
      const smokeTests = flags.useSmokeTests && directValidation.ok
        ? buildSupplementalScriptContractTests(directValidation.ports.inputs, directValidation.ports.outputs)
        : [];
      const smokeResults = smokeTests.length > 0
        ? await runGeneratedScriptUnitTests(directCode, smokeTests)
        : [];
      candidates.push({
        content: directResponse,
        code: directCode,
        validation: directValidation,
        smokeResults,
        score: scoreScriptGenerationCandidate(directValidation, smokeResults, directCode),
        index: candidateIndex,
      });
    }

    const bestCandidate = candidates.sort((left, right) => right.score - left.score)[0];
    generationPass = {
      content: bestCandidate.content,
      selectedSkills: [],
      toolNames: [],
      trace: [{
        type: 'assistant',
        stopReason: 'direct_prompt_candidates',
        text: [
          `Generated ${candidates.length} candidate(s).`,
          ...candidates.map((candidate) => {
            const failingSmoke = candidate.smokeResults.filter((result) => !result.passed);
            return `Candidate ${candidate.index + 1}: score=${candidate.score}; validation=${candidate.validation.ok ? 'ok' : candidate.validation.issues.join(' | ')}; smoke=${failingSmoke.length === 0 ? 'pass' : failingSmoke.map((result) => `${result.name}: ${result.failures.join('; ')}`).join(' | ')}`;
          }),
          `Selected candidate ${bestCandidate.index + 1}.`,
        ].join('\n'),
        toolCalls: [],
      }],
    };
  } else {
    generationPass = await runScopedScriptGenerationPass(ctx, generationObjective, {
      chatHistory,
      sessionSuffix: 'generate',
      mode,
      executionEnabled,
    });
  }
  const transcript: ScriptGenerationTranscriptEntry[] = [
    {
      stage: 'request',
      title: 'Request',
      content: userMessage,
    },
  ];
  if (prePlan) {
    transcript.push({
      stage: 'plan',
      title: 'Pre-generation plan',
      content: formatPrePlanForPrompt(prePlan),
    });
  }
  transcript.push({
    stage: 'generation',
    title: shouldUseDirectScriptGeneration(mode) ? 'Direct generation pass' : 'Initial generation pass',
    content: [
      `Selected skills: ${generationPass.selectedSkills.length > 0 ? generationPass.selectedSkills.join(', ') : 'none recorded'}`,
      `Scoped tools used: ${generationPass.toolNames.length > 0 ? generationPass.toolNames.join(', ') : 'none'}`,
      '',
      formatScriptGenerationTrace(generationPass.trace),
    ].join('\n'),
  });
  let assistantMessage = generationPass.content;
  let code = extractCodeBlock(assistantMessage);
  let validation = validateGeneratedScriptCode(code, { userMessage: scopedRequestMessage });
  let repaired = false;
  let strictFallbackUsed = false;
  let repairAttemptCount = 0;
  const selectedSkills = generationPass.selectedSkills.slice();
  const toolNames = generationPass.toolNames.slice();

  if (!validation.ok) {
    transcript.push({
      stage: 'validation',
      title: 'Validation issues after initial pass',
      content: validation.issues.join('\n'),
    });
    repaired = true;
    repairAttemptCount += 1;
    const repairObjective = [
      'Repair malformed Woodbury script-node JavaScript.',
      'Use the dedicated script-node generation skill and return ONLY a single repaired JavaScript code block.',
      `Original request:\n${userMessage}`,
      `Current code:\n\`\`\`javascript\n${code}\n\`\`\``,
      `Validation issues:\n- ${validation.issues.join('\n- ')}`,
      builtinGuidance,
      semanticGraphText,
      retrievedExamplesText,
      runtimeFailureText,
      compositionInterfaceText,
      compositionDocumentationText,
      editGuidance,
      toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
    ].filter(Boolean).join('\n\n');

    const repairPass = shouldUseDirectScriptGeneration('repair')
      ? {
        content: await runStrictScriptGenerationFallback(userMessage, toolDocs, {
          chatHistory,
          currentCode: code,
          issues: validation.issues,
          mode: 'repair',
          requestScopeMessage: scopedRequestMessage,
          retrievedExamples,
          runtimeFailure: options?.runtimeFailure,
          semanticGraphContext: semanticGraphText,
          compositionDocumentation: options?.compositionDocumentation,
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
        mode: 'repair',
        executionEnabled: true,
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
    validation = validateGeneratedScriptCode(code, { userMessage: scopedRequestMessage });
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
      requestScopeMessage: scopedRequestMessage,
      retrievedExamples,
      runtimeFailure: options?.runtimeFailure,
      semanticGraphContext: semanticGraphText,
    });
    transcript.push({
      stage: 'fallback',
      title: 'Strict format fallback',
      content: assistantMessage.trim(),
    });
    code = extractCodeBlock(assistantMessage);
    validation = validateGeneratedScriptCode(code, { userMessage: scopedRequestMessage });
  }

  if (!validation.ok) {
    throw new Error(`Generated code did not pass validation after repair: ${validation.issues.join(' ')}`);
  }

  let generatedTests: ScriptGenerationTestCase[] = [];
  let supplementalTests: ScriptGenerationTestCase[] = flags.useSmokeTests
    ? mergeScriptGenerationTests(
      buildSupplementalScriptContractTests(validation.ports.inputs, validation.ports.outputs),
      buildEdgeCaseScriptContractTests(validation.ports.inputs, validation.ports.outputs),
      buildProgressContractTests(code, validation.ports.inputs, validation.ports.outputs),
    )
    : [];
  let boundedExecution = mode === 'generate' && executionEnabled
    ? buildBoundedGenerateExecutionTests(validation.ports.inputs, validation.ports.outputs, {
      dataContext: options?.dataContext,
      graphContext: options?.graphContext,
    })
    : { tests: [], source: 'none' as const };
  let testResults: Awaited<ReturnType<typeof runGeneratedScriptUnitTests>> = [];
  try {
    generatedTests = await generateScriptUnitTestCases(scopedRequestMessage, code, validation.ports.inputs, validation.ports.outputs);
  } catch (err) {
    debugLog.info('dashboard', 'Failed to generate script unit tests', { error: String(err) });
  }

  const executionTests = mergeScriptGenerationTests(generatedTests, supplementalTests, boundedExecution.tests);

  if (executionTests.length > 0) {
    if (boundedExecution.tests.length > 0) {
      transcript.push({
        stage: 'verification',
        title: 'Bounded sample execution plan',
        content: `Using ${boundedExecution.source === 'graph_context' ? 'graph-context upstream values' : 'data-context samples'} to run a bounded deterministic execution check before accepting the script.`,
      });
    }
    transcript.push({
      stage: 'tests',
      title: 'Generated and supplemental tests',
      content: executionTests.map(testCase => {
        const inputsText = JSON.stringify(testCase.inputs || {}, null, 2);
        const requiredKeys = Array.isArray(testCase.requiredOutputKeys) && testCase.requiredOutputKeys.length > 0
          ? `required outputs: ${testCase.requiredOutputKeys.join(', ')}`
          : 'required outputs: none';
        return `${testCase.name}\ninputs: ${inputsText}\n${requiredKeys}`;
      }).join('\n\n'),
    });
    testResults = await runGeneratedScriptUnitTests(code, executionTests);
    const failingTests = testResults.filter(result => !result.passed);
    transcript.push({
      stage: 'tests',
      title: failingTests.length > 0 ? 'Unit test failures' : 'Unit test results',
      content: testResults.map(result => `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.failures.length > 0 ? `\n${result.failures.join('\n')}` : ''}`).join('\n\n'),
    });
    if (failingTests.length > 0) {
      repaired = true;
      repairAttemptCount += 1;
      const repairObjective = [
        'Repair Woodbury script-node JavaScript so it passes deterministic unit tests.',
        'Return ONLY a single repaired JavaScript code block.',
        `Original request:\n${userMessage}`,
        `Current code:\n\`\`\`javascript\n${code}\n\`\`\``,
        `Failing unit tests:\n${failingTests.map(result => `- ${result.name}: ${result.failures.join('; ')}`).join('\n')}`,
        builtinGuidance,
        semanticGraphText,
        retrievedExamplesText,
        runtimeFailureText,
        compositionInterfaceText,
        compositionDocumentationText,
        editGuidance,
        toolDocs ? `Runtime tool documentation for generated code:\n${toolDocs}` : '',
      ].filter(Boolean).join('\n\n');
      const repairPass = shouldUseDirectScriptGeneration('repair')
        ? {
          content: await runStrictScriptGenerationFallback(userMessage, toolDocs, {
            chatHistory,
            currentCode: code,
            issues: failingTests.map(result => `${result.name}: ${result.failures.join('; ')}`),
            mode: 'repair',
            requestScopeMessage: scopedRequestMessage,
            retrievedExamples,
            runtimeFailure: options?.runtimeFailure,
            semanticGraphContext: semanticGraphText,
            compositionDocumentation: options?.compositionDocumentation,
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
          mode: 'repair',
          executionEnabled: true,
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
      validation = validateGeneratedScriptCode(code, { userMessage: scopedRequestMessage });
      if (!validation.ok) {
        strictFallbackUsed = true;
        assistantMessage = await runStrictScriptGenerationFallback(userMessage, toolDocs, {
          chatHistory,
          currentCode: code,
          issues: validation.issues.concat(failingTests.map(result => `${result.name}: ${result.failures.join('; ')}`)),
          mode,
          requestScopeMessage: scopedRequestMessage,
          retrievedExamples,
          runtimeFailure: options?.runtimeFailure,
          semanticGraphContext: semanticGraphText,
          compositionDocumentation: options?.compositionDocumentation,
        });
        transcript.push({
          stage: 'fallback',
          title: 'Strict fallback after unit-test repair',
          content: assistantMessage.trim(),
        });
        code = extractCodeBlock(assistantMessage);
        validation = validateGeneratedScriptCode(code, { userMessage: scopedRequestMessage });
      }
      if (!validation.ok) {
        throw new Error(`Generated code failed structural validation after unit-test repair: ${validation.issues.join(' ')}`);
      }
      generatedTests = await generateScriptUnitTestCases(scopedRequestMessage, code, validation.ports.inputs, validation.ports.outputs);
      supplementalTests = flags.useSmokeTests
        ? mergeScriptGenerationTests(
          buildSupplementalScriptContractTests(validation.ports.inputs, validation.ports.outputs),
          buildEdgeCaseScriptContractTests(validation.ports.inputs, validation.ports.outputs),
          buildProgressContractTests(code, validation.ports.inputs, validation.ports.outputs),
        )
        : [];
      boundedExecution = mode === 'generate' && executionEnabled
        ? buildBoundedGenerateExecutionTests(validation.ports.inputs, validation.ports.outputs, {
          dataContext: options?.dataContext,
          graphContext: options?.graphContext,
        })
        : { tests: [], source: 'none' as const };
      const postRepairExecutionTests = mergeScriptGenerationTests(generatedTests, supplementalTests, boundedExecution.tests);
      testResults = postRepairExecutionTests.length > 0 ? await runGeneratedScriptUnitTests(code, postRepairExecutionTests) : [];
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
  const metrics: ScriptGenerationMetrics = {
    generationPath: strictFallbackUsed ? 'fallback' : (directGenerationPath ? 'direct' : 'agentic'),
    candidateCount: directCandidateCount,
    retrievedExampleCount: retrievedExamples.length,
    unitTestCount: generatedTests.length,
    smokeTestCount: supplementalTests.length,
    repairAttemptCount,
    runtimeEvidenceUsed: Boolean(options?.runtimeFailure),
    executionVerified: testResults.length > 0,
    sampleExecutionCount: boundedExecution.tests.length,
    sampleExecutionUsed: boundedExecution.tests.length > 0,
    sampleExecutionSource: boundedExecution.source,
    manualEditCount: Math.max(0, Number(options?.manualEditCount || 0)),
  };
  const verificationSummary = `Selected skills: ${selectedSkills.length > 0 ? selectedSkills.join(', ') : 'none recorded'}. Scoped tools used: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}. Generation path: ${metrics.generationPath}. Retrieved examples: ${metrics.retrievedExampleCount}. Candidate count: ${metrics.candidateCount}. Repair attempts: ${metrics.repairAttemptCount}.${strictFallbackUsed ? ' A strict output-format fallback was used after the closure-engine response failed validation.' : ''} Structural validation passed for JSDoc annotations, execute(inputs, context), return object, and JavaScript parsing.${testResults.length > 0 ? ` Executed ${testResults.length} deterministic test(s) and all passed.` : ' No deterministic tests were executed.'}${metrics.sampleExecutionUsed ? ` Included a bounded sample execution using ${metrics.sampleExecutionSource === 'graph_context' ? 'graph-context values' : 'data-context samples'}.` : ''} These checks cover generated code structure and deterministic sandbox behavior only, not full pipeline runtime execution.`;
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
      designedPlan: prePlan || `Closure engine routed this through ${selectedSkills[0] || 'script generation'} and kept the tool scope constrained for validation-oriented problem solving.${strictFallbackUsed ? ' A strict output-format fallback was used to force valid script-node code when the model answered in the wrong shape.' : ''}`,
      validationIssues: validation.issues,
      repaired,
      verificationSummary,
      selectedSkills,
      toolNames,
      transcript,
      metrics,
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
    inputs: normalizePipelinePortContracts(node?.inputs),
    outputs: normalizePipelinePortContracts(node?.outputs),
  });
  const connectedTargets = new Set(
    connections
      .filter((conn) => Number.isInteger(conn?.to) && typeof conn?.toPort === 'string')
      .map((conn) => `${conn.to}:${conn.toPort}`),
  );
  const connectedSources = new Set(
    connections
      .filter((conn) => Number.isInteger(conn?.from) && typeof conn?.fromPort === 'string')
      .map((conn) => `${conn.from}:${conn.fromPort}`),
  );
  const pipelineInputs = nodes.flatMap((node, index) => {
    return normalizePipelinePortContracts(node?.inputs).filter((port) => {
      return !connectedTargets.has(`${index}:${port.name}`);
    }).map((port) => ({
      nodeIndex: index,
      nodeLabel: node?.label || `Step ${index + 1}`,
      ...port,
    }));
  });
  const pipelineOutputs = nodes.flatMap((node, index) => {
    return normalizePipelinePortContracts(node?.outputs).filter((port) => {
      return !connectedSources.has(`${index}:${port.name}`);
    }).map((port) => ({
      nodeIndex: index,
      nodeLabel: node?.label || `Step ${index + 1}`,
      ...port,
    }));
  });

  return {
    currentNode: summarizeNode(currentNode, nodeIndex),
    upstream: connections
      .filter(conn => conn?.to === nodeIndex && Number.isInteger(conn?.from) && nodes[conn.from])
      .map(conn => ({
        fromPort: conn.fromPort,
        toPort: conn.toPort,
        expectedContract: `${String(conn.fromPort || 'output')} -> ${String(conn.toPort || 'input')}`,
        node: summarizeNode(nodes[conn.from], conn.from),
      })),
    downstream: connections
      .filter(conn => conn?.from === nodeIndex && Number.isInteger(conn?.to) && nodes[conn.to])
      .map(conn => ({
        fromPort: conn.fromPort,
        toPort: conn.toPort,
        expectedContract: `${String(conn.fromPort || 'output')} -> ${String(conn.toPort || 'input')}`,
        node: summarizeNode(nodes[conn.to], conn.to),
      })),
    pipelineInputs,
    pipelineOutputs,
    topology: {
      nodeCount: nodes.length,
      edgeCount: connections.length,
      currentNodeIndex: nodeIndex,
    },
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

function normalizeGeneratedPipelineNodeType(rawType: unknown): GeneratedPipelineNodeType | null {
  if (typeof rawType !== 'string') return null;
  const normalized = rawType
    .trim()
    .replace(/^__|__$/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return GENERATED_PIPELINE_NODE_TYPE_ALIASES[normalized] || null;
}

function normalizeBooleanValue(raw: unknown, fallback = false): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeIntegerValue(raw: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  let value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  if (typeof min === 'number') value = Math.max(min, value);
  if (typeof max === 'number') value = Math.min(max, value);
  return value;
}

function normalizePlainRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

function normalizeMediaSourceMode(raw: unknown): 'file_path' | 'url' | 'asset_id' {
  if (raw === 'url' || raw === 'asset_id') return raw;
  return 'file_path';
}

function normalizeMediaType(raw: unknown): 'auto' | 'image' | 'video' | 'audio' | 'pdf' | 'text' {
  return raw === 'image' || raw === 'video' || raw === 'audio' || raw === 'pdf' || raw === 'text' ? raw : 'auto';
}

function normalizeImageFit(raw: unknown): 'contain' | 'cover' | 'actual' {
  return raw === 'cover' || raw === 'actual' ? raw : 'contain';
}

function normalizeVariableType(raw: unknown): 'string' | 'number' | 'array' | 'boolean' | 'object' {
  return raw === 'number' || raw === 'array' || raw === 'boolean' || raw === 'object' ? raw : 'string';
}

/**
 * Extract option values from a variable node description.
 * Matches patterns like:
 *   "Type of script (feature, short, pilot, etc.)"
 *   "Genre: drama, comedy, sci-fi, horror"
 *   "Style — cinematic / documentary / animated"
 */
function inferOptionsFromDescription(description: string, label: string): string[] {
  if (!description) return [];

  // Pattern 1: parenthesized list — "something (opt1, opt2, opt3, etc.)"
  const parenMatch = description.match(/\(([^)]{4,})\)/);
  if (parenMatch) {
    const items = splitOptionList(parenMatch[1]);
    if (items.length >= 2) return items;
  }

  // Pattern 2: colon/dash/em-dash separated — "Genre: drama, comedy, sci-fi"
  const colonMatch = description.match(/(?::|—|--|=>)\s*(.{4,})$/);
  if (colonMatch) {
    const items = splitOptionList(colonMatch[1]);
    if (items.length >= 2) return items;
  }

  // Pattern 3: "e.g." or "such as" — "e.g. drama, comedy, sci-fi"
  const egMatch = description.match(/(?:e\.g\.?|such as|like|including)\s+(.{4,})/i);
  if (egMatch) {
    const items = splitOptionList(egMatch[1]);
    if (items.length >= 2) return items;
  }

  return [];
}

/** Split a comma / slash / "or" delimited string into trimmed option values, filtering noise words. */
function splitOptionList(raw: string): string[] {
  // Normalize separators: comma, slash, " or "
  const parts = raw.split(/\s*[,\/]\s*|\s+or\s+/i);
  const noiseWords = new Set(['etc', 'etc.', '...', 'more', 'other', 'others', 'and more']);
  return parts
    .map(p => p.trim().replace(/^["']+|["']+$/g, '').replace(/\.{2,}$/, '').trim())
    .filter(p => p.length > 0 && !noiseWords.has(p.toLowerCase()));
}

/**
 * Infer objectFields from an object-type variable's description.
 * Tries to extract field names and types from natural language descriptions like:
 *   "Configuration with tone (dramatic, comedic), target audience, and word count"
 *   "Settings: { format: string, quality: high/medium/low, verbose: boolean }"
 */
function inferObjectFieldsFromDescription(
  description: string,
  label: string,
): Array<{ key: string; label?: string; type?: string; default?: string; options?: string[] }> {
  if (!description) return [];
  const fields: Array<{ key: string; label?: string; type?: string; default?: string; options?: string[] }> = [];

  // Pattern 1: JSON-like descriptions "{ key: type, key2: type }"
  const braceMatch = description.match(/\{([^}]+)\}/);
  if (braceMatch) {
    const pairs = braceMatch[1].split(',');
    for (const pair of pairs) {
      const colonSplit = pair.split(':').map(s => s.trim());
      if (colonSplit.length >= 2 && colonSplit[0]) {
        const key = colonSplit[0].replace(/["']/g, '').trim();
        const typeStr = colonSplit[1].replace(/["']/g, '').trim().toLowerCase();
        const slashOptions = typeStr.split('/').map(s => s.trim()).filter(s => s.length > 0);
        if (slashOptions.length >= 2) {
          fields.push({
            key,
            label: humanizeFieldKey(key),
            type: 'select',
            options: slashOptions,
            default: slashOptions[0],
          });
        } else if (typeStr === 'boolean' || typeStr === 'bool') {
          fields.push({ key, label: humanizeFieldKey(key), type: 'boolean', default: 'false' });
        } else if (typeStr === 'number' || typeStr === 'int' || typeStr === 'integer') {
          fields.push({ key, label: humanizeFieldKey(key), type: 'number', default: '0' });
        } else {
          fields.push({ key, label: humanizeFieldKey(key), type: 'string', default: '' });
        }
      }
    }
    if (fields.length > 0) return fields;
  }

  // Pattern 2: "with X, Y, and Z" or "including X, Y, Z"
  const withMatch = description.match(/(?:with|including|contains|has)\s+(.+)/i);
  if (withMatch) {
    const parts = withMatch[1].split(/\s*,\s*|\s+and\s+/i).map(s => s.trim()).filter(s => s.length > 0 && s.length < 40);
    for (const part of parts) {
      // Check for inline options: "tone (dramatic, comedic)"
      const inlineOptsMatch = part.match(/^(\w[\w\s]*?)\s*\(([^)]+)\)/);
      if (inlineOptsMatch) {
        const key = inlineOptsMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
        const opts = splitOptionList(inlineOptsMatch[2]);
        fields.push({
          key,
          label: humanizeFieldKey(key),
          type: opts.length >= 2 ? 'select' : 'string',
          ...(opts.length >= 2 ? { options: opts, default: opts[0] } : {}),
        });
      } else {
        const key = part.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (key) {
          // Guess type from common words
          const lower = part.toLowerCase();
          const isBoolean = /\b(enabled?|disabled?|verbose|active|visible|show|hide)\b/i.test(lower);
          const isNumber = /\b(count|size|width|height|max|min|limit|amount|total|number|quantity)\b/i.test(lower);
          fields.push({
            key,
            label: humanizeFieldKey(key),
            type: isBoolean ? 'boolean' : isNumber ? 'number' : 'string',
            default: isBoolean ? 'false' : isNumber ? '0' : '',
          });
        }
      }
    }
  }

  return fields;
}

/** Convert a snake_case or camelCase key to a human-readable label */
function humanizeFieldKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function normalizeAssetMode(raw: unknown): 'pick' | 'save' | 'list' | 'remove' | 'generate_path' {
  return raw === 'save' || raw === 'list' || raw === 'remove' || raw === 'generate_path' ? raw : 'pick';
}

function normalizeFileWriteMode(raw: unknown): 'overwrite' | 'append' {
  return raw === 'append' ? 'append' : 'overwrite';
}

function normalizeFileWriteFormat(raw: unknown): 'auto' | 'json' | 'text' {
  return raw === 'json' || raw === 'text' ? raw : 'auto';
}

function normalizeFileReadParseMode(raw: unknown): 'auto' | 'json' | 'text' {
  return raw === 'json' || raw === 'text' ? raw : 'auto';
}

function normalizeSwitchCases(raw: unknown): Array<{ value: string; port: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry, index) => {
      const value = typeof entry.value === 'string' ? entry.value : String(entry.value ?? '');
      const port = typeof entry.port === 'string' && entry.port.trim() ? entry.port.trim() : `on_case_${index + 1}`;
      return { value, port };
    })
    .filter((entry) => entry.port);
}

function buildPipelineGenerationNodeTypeGuidance(toolDocs: string): string {
  const sections = [
    'NODE TYPES:',
    '',
    '"text" — outputs a constant string value',
    '  Output port: "text"',
    '  Config: { "type": "text", "label": "...", "textNode": { "value": "the text content" } }',
    '',
    '"script" — custom code with declared ports only; backend generates the implementation',
    '  Config: { "type": "script", "label": "...", "description": "...", "inputs": [...], "outputs": [...] }',
    '  Port format: { "name": "snake_case_name", "type": "string|number|boolean|object|string[]|number[]|object[]", "description": "..." }',
    '',
    '"file_op" — file system operations',
    '  Operations and ports:',
    '  - copy: inputs [sourcePath, destinationPath], outputs [outputPath, success]',
    '  - move: inputs [sourcePath, destinationPath], outputs [outputPath, success]',
    '  - delete: inputs [filePath], outputs [success]',
    '  - mkdir: inputs [folderPath], outputs [outputPath, success]',
    '  - list: inputs [folderPath], outputs [files, count]',
    '  Config: { "type": "file_op", "label": "...", "fileOp": { "operation": "copy|move|delete|mkdir|list" } }',
    '',
    '"output" — final pipeline outputs',
    '  Input ports are declared in outputNode.ports; connected values become the pipeline outputs.',
    '  Config: { "type": "output", "label": "Pipeline Output", "outputNode": { "ports": [{ "name": "result", "type": "string", "description": "..." }] } }',
    '',
    '"branch" — if/else routing',
    '  Input port: "condition" (optional; if omitted, branchNode.condition is evaluated using {{variable}} placeholders).',
    '  Output routing ports: "on_true", "on_false".',
    '  Config: { "type": "branch", "label": "...", "branchNode": { "condition": "{{count}} > 0" } }',
    '',
    '"delay" — pauses execution and passes inputs through',
    '  Optional input port: "delay_ms". Output ports pass through upstream values.',
    '  Config: { "type": "delay", "label": "...", "delayNode": { "delayMs": 1000 } }',
    '',
    '"gate" — conditional pass-through',
    '  Input ports: "open" (boolean override), "data" (payload to forward).',
    '  Output port: "out" when open.',
    '  Config: { "type": "gate", "label": "...", "gateNode": { "defaultOpen": true, "onClosed": "skip|stop|fail" } }',
    '',
    '"for_each" — iterate over an array; aliases like "forLoop", "for_loop", and "foreach" are accepted but will be normalized',
    '  Input port: "items".',
    '  Loop-body output ports: "current_item", "index", "count".',
    '  Completed output ports: "results", "total_count".',
    '  Config: { "type": "for_each", "label": "...", "forEachNode": { "itemVariable": "item", "maxIterations": 100 } }',
    '',
    '"switch" — multi-way routing',
    '  Input port: "value".',
    '  Output routing ports come from switchNode.cases[*].port plus switchNode.defaultPort.',
    '  Config: { "type": "switch", "label": "...", "switchNode": { "cases": [{ "value": "draft", "port": "on_draft" }], "defaultPort": "on_default" } }',
    '',
    '"variable" — shared state and top-level pipeline form inputs',
    '  Input ports: "set", "push". Output ports: "value", "length".',
    '  Config: { "type": "variable", "label": "...", "variableNode": { "type": "string|number|array|boolean|object", "initialValue": "", "exposeAsInput": true|false, "inputName": "prompt", "description": "...", "required": true|false, "generationPrompt": "...", "inputControl": "text|textarea|select|combobox", "options": ["opt1", "opt2"], "objectFields": [...] } }',
    '  inputControl: "text" = single-line (default), "textarea" = multi-line, "select" = fixed dropdown (user must pick one), "combobox" = dropdown + freeform typing.',
    '  Use "select" for finite known choices (e.g. output format, script kind). Use "combobox" for curated suggestions that still allow creative input (e.g. genre, tone). Omit or use "text" for freeform fields (e.g. title).',
    '  When inputControl is "select" or "combobox", you MUST include a non-empty "options" array. Set "initialValue" to the best default option.',
    '',
    '  IMPORTANT — Object variables for non-technical users:',
    '  When type is "object", ALWAYS include "objectFields" to decompose the object into individual form fields.',
    '  objectFields: [{ "key": "fieldName", "label": "Human Label", "type": "string|number|boolean|select", "default": "...", "options": ["a","b"] }]',
    '  Example: A "metadata" variable with type "object" should be decomposed:',
    '    "objectFields": [',
    '      { "key": "tone", "label": "Tone", "type": "select", "options": ["dramatic", "comedic", "neutral"], "default": "dramatic" },',
    '      { "key": "targetAudience", "label": "Target Audience", "type": "string", "default": "general" },',
    '      { "key": "wordCount", "label": "Max Word Count", "type": "number", "default": "5000" }',
    '    ]',
    '  This renders as individual labeled fields instead of a raw JSON editor. NEVER leave type "object" without objectFields.',
    '',
    '"get_variable" — read a Variable node by id',
    '  Output ports: "value", "length".',
    '  Config: { "type": "get_variable", "label": "...", "getVariableNode": { "targetNodeId": "var_123" } }',
    '',
    '"json_keys" — inspect or extract JSON structure',
    '  Input ports: "json", optional "path".',
    '  Output ports: "keys", "values", "value", "type", "structure".',
    '  Config: { "type": "json_keys", "label": "...", "jsonKeysNode": { "defaultPath": "items.0" } }',
    '',
    '"file_write" — write text or JSON to disk',
    '  Input ports: "filePath", "content".',
    '  Output ports: "filePath", "success", "bytesWritten".',
    '  Config: { "type": "file_write", "label": "...", "fileWriteNode": { "mode": "overwrite|append", "format": "auto|json|text", "prettyPrint": true|false } }',
    '',
    '"file_read" — read text or JSON from disk',
    '  Input port: "filePath".',
    '  Output ports: "content", "isJson", "size", "filePath".',
    '  Config: { "type": "file_read", "label": "...", "fileReadNode": { "parseMode": "auto|json|text" } }',
    '',
    '"junction" — pass-through hub',
    '  Each junctionNode.ports entry appears on both input and output sides.',
    '  Config: { "type": "junction", "label": "...", "junctionNode": { "ports": [{ "name": "payload", "type": "string", "description": "..." }] } }',
    '',
    '"asset" — interact with asset collections',
    '  Modes: "pick", "save", "list", "remove", "generate_path".',
    '  Config: { "type": "asset", "label": "...", "asset": { "mode": "pick|save|list|remove|generate_path", "collectionSlug": "", "assetId": "", "category": "", "tags": "", "defaultName": "", "referenceOnly": true|false, "outputDirectory": "", "namePattern": "", "fileExtension": ".json" } }',
    '',
    '"image_viewer" — display an image result',
    '  Config: { "type": "image_viewer", "label": "...", "imageViewer": { "filePath": "", "width": 300, "height": 300 } }',
    '',
    '"media" — display image/video/audio/pdf/text media',
    '  Config: { "type": "media", "label": "...", "mediaPlayer": { "sourceMode": "file_path|url|asset_id", "filePath": "", "url": "", "assetId": "", "mediaType": "auto|image|video|audio|pdf|text", "width": 320, "height": 240, "title": "", "autoPlay": false, "defaultVolume": 0.8, "loop": false, "playbackRate": 1, "imageFit": "contain|cover|actual" } }',
    '',
    '"tool" — invoke a registered tool directly',
    '  Connect upstream values to tool parameter names and set toolNode.selectedTool to the exact tool name.',
    '  Config: { "type": "tool", "label": "...", "toolNode": { "selectedTool": "tool_name", "paramDefaults": { "arg": "value" } } }',
  ];
  if (toolDocs) sections.push('', toolDocs);
  return sections.join('\n');
}

function materializeGeneratedPipelineNode(
  rawNode: Record<string, unknown>,
  index: number,
  scriptNodeResult?: PipelineScriptNodeGenerationResult,
): { nodeType: GeneratedPipelineNodeType; workflowId: string; prefix: string; node: Record<string, unknown> } | null {
  const nodeType = normalizeGeneratedPipelineNodeType(rawNode.type || rawNode.workflowId) || 'script';
  const workflowId = GENERATED_PIPELINE_NODE_TYPE_TO_WORKFLOW_ID[nodeType];
  const prefix = GENERATED_PIPELINE_NODE_TYPE_TO_PREFIX[nodeType];
  const node: Record<string, unknown> = {
    id: prefix + '-' + Math.random().toString(36).slice(2, 9),
    workflowId,
    position: { x: 0, y: 0 },
    label: typeof rawNode.label === 'string' && rawNode.label.trim() ? rawNode.label.trim() : `Step ${index + 1}`,
  };

  if (workflowId === '__script__') {
    const code = scriptNodeResult?.code || (typeof rawNode.code === 'string' ? rawNode.code : '');
    const ports = scriptNodeResult
      ? { inputs: scriptNodeResult.inputs, outputs: scriptNodeResult.outputs }
      : {
        inputs: normalizePipelinePortContracts(rawNode.inputs),
        outputs: normalizePipelinePortContracts(rawNode.outputs),
      };
    const chatHistory = scriptNodeResult?.assistantMessage
      ? [
        { role: 'user', content: scriptNodeResult.description },
        { role: 'assistant', content: scriptNodeResult.assistantMessage },
      ]
      : [];
    node.script = {
      description: scriptNodeResult?.description || (typeof rawNode.description === 'string' ? rawNode.description : String(rawNode.label || '')),
      code,
      inputs: ports.inputs,
      outputs: ports.outputs,
      chatHistory,
      generationTranscript: scriptNodeResult?.transcript || [],
    };
  } else if (workflowId === '__text__') {
    const textNode = normalizePlainRecord(rawNode.textNode);
    node.textNode = { value: typeof textNode.value === 'string' ? textNode.value : (typeof rawNode.value === 'string' ? rawNode.value : '') };
  } else if (workflowId === '__file_op__') {
    const fileOp = normalizePlainRecord(rawNode.fileOp);
    const operation = fileOp.operation;
    node.fileOp = {
      operation: operation === 'move' || operation === 'delete' || operation === 'mkdir' || operation === 'list' ? operation : 'copy',
    };
  } else if (workflowId === '__output__') {
    const outputNode = normalizePlainRecord(rawNode.outputNode);
    node.outputNode = {
      ports: normalizePipelinePortContracts(outputNode.ports || rawNode.ports),
    };
  } else if (workflowId === '__image_viewer__') {
    const imageViewer = normalizePlainRecord(rawNode.imageViewer);
    node.imageViewer = {
      filePath: typeof imageViewer.filePath === 'string' ? imageViewer.filePath : '',
      width: normalizeIntegerValue(imageViewer.width, 300, 1),
      height: normalizeIntegerValue(imageViewer.height, 300, 1),
    };
  } else if (workflowId === '__media__') {
    const mediaPlayer = normalizePlainRecord(rawNode.mediaPlayer);
    node.mediaPlayer = {
      sourceMode: normalizeMediaSourceMode(mediaPlayer.sourceMode),
      filePath: typeof mediaPlayer.filePath === 'string' ? mediaPlayer.filePath : '',
      url: typeof mediaPlayer.url === 'string' ? mediaPlayer.url : '',
      assetId: typeof mediaPlayer.assetId === 'string' ? mediaPlayer.assetId : '',
      mediaType: normalizeMediaType(mediaPlayer.mediaType),
      width: normalizeIntegerValue(mediaPlayer.width, 320, 1),
      height: normalizeIntegerValue(mediaPlayer.height, 240, 1),
      title: typeof mediaPlayer.title === 'string' ? mediaPlayer.title : '',
      autoPlay: normalizeBooleanValue(mediaPlayer.autoPlay, false),
      defaultVolume: typeof mediaPlayer.defaultVolume === 'number' && Number.isFinite(mediaPlayer.defaultVolume) ? mediaPlayer.defaultVolume : 0.8,
      loop: normalizeBooleanValue(mediaPlayer.loop, false),
      playbackRate: typeof mediaPlayer.playbackRate === 'number' && Number.isFinite(mediaPlayer.playbackRate) ? mediaPlayer.playbackRate : 1,
      imageFit: normalizeImageFit(mediaPlayer.imageFit),
    };
  } else if (workflowId === '__asset__') {
    const asset = normalizePlainRecord(rawNode.asset);
    node.asset = {
      mode: normalizeAssetMode(asset.mode),
      collectionSlug: typeof asset.collectionSlug === 'string' ? asset.collectionSlug : '',
      assetId: typeof asset.assetId === 'string' ? asset.assetId : '',
      category: typeof asset.category === 'string' ? asset.category : '',
      tags: typeof asset.tags === 'string' ? asset.tags : '',
      defaultName: typeof asset.defaultName === 'string' ? asset.defaultName : '',
      referenceOnly: normalizeBooleanValue(asset.referenceOnly, false),
      outputDirectory: typeof asset.outputDirectory === 'string' ? asset.outputDirectory : '',
      namePattern: typeof asset.namePattern === 'string' ? asset.namePattern : '',
      fileExtension: typeof asset.fileExtension === 'string' ? asset.fileExtension : '',
    };
  } else if (workflowId === '__branch__') {
    const branchNode = normalizePlainRecord(rawNode.branchNode);
    node.branchNode = {
      condition: typeof branchNode.condition === 'string' && branchNode.condition.trim() ? branchNode.condition.trim() : '{{value}} > 0',
    };
  } else if (workflowId === '__delay__') {
    const delayNode = normalizePlainRecord(rawNode.delayNode);
    node.delayNode = {
      delayMs: normalizeIntegerValue(delayNode.delayMs, 1000, 0),
    };
  } else if (workflowId === '__gate__') {
    const gateNode = normalizePlainRecord(rawNode.gateNode);
    const onClosed = gateNode.onClosed;
    node.gateNode = {
      defaultOpen: normalizeBooleanValue(gateNode.defaultOpen, true),
      onClosed: onClosed === 'stop' || onClosed === 'fail' ? onClosed : 'skip',
    };
  } else if (workflowId === '__for_each__') {
    const forEachNode = normalizePlainRecord(rawNode.forEachNode);
    node.forEachNode = {
      itemVariable: typeof forEachNode.itemVariable === 'string' && forEachNode.itemVariable.trim() ? forEachNode.itemVariable.trim() : 'item',
      maxIterations: normalizeIntegerValue(forEachNode.maxIterations, 100, 1, 10000),
    };
  } else if (workflowId === '__switch__') {
    const switchNode = normalizePlainRecord(rawNode.switchNode);
    node.switchNode = {
      cases: normalizeSwitchCases(switchNode.cases),
      defaultPort: typeof switchNode.defaultPort === 'string' && switchNode.defaultPort.trim() ? switchNode.defaultPort.trim() : 'on_default',
    };
  } else if (workflowId === '__variable__') {
    const variableNode = normalizePlainRecord(rawNode.variableNode);
    const variableType = normalizeVariableType(variableNode.type);

    let rawControl = typeof variableNode.inputControl === 'string' ? variableNode.inputControl.trim().toLowerCase() : '';
    const validControls = ['text', 'textarea', 'select', 'combobox'];
    let inputControl = validControls.includes(rawControl) ? rawControl : undefined;

    let rawOptions = Array.isArray(variableNode.options) ? variableNode.options : [];
    let options = rawOptions.map((o: unknown) => typeof o === 'string' ? o.trim() : '').filter((o: string) => o.length > 0);

    // Auto-infer inputControl and options from description when the AI didn't set them explicitly.
    // Descriptions like "Type of script (feature, short, pilot, etc.)" contain the valid values.
    if (!inputControl && options.length === 0 && variableType === 'string') {
      const desc = typeof variableNode.description === 'string' ? variableNode.description : '';
      const label = typeof rawNode.label === 'string' ? rawNode.label : '';
      const inferredOptions = inferOptionsFromDescription(desc, label);
      if (inferredOptions.length >= 2) {
        options = inferredOptions;
        // Use combobox (allows freeform) if description says "etc." or "...", otherwise select
        const hasEtc = /\betc\.?\b|\.{2,}|\band more\b|\bother\b/i.test(desc);
        inputControl = hasEtc ? 'combobox' : 'select';
      }
    }

    // Normalize objectFields for object-type variables
    let objectFields: Array<{ key: string; label?: string; type?: string; default?: string; options?: string[] }> = [];
    if (Array.isArray(variableNode.objectFields)) {
      objectFields = variableNode.objectFields
        .filter((f: unknown) => typeof f === 'object' && f !== null && typeof (f as any).key === 'string')
        .map((f: any) => ({
          key: String(f.key).trim(),
          ...(typeof f.label === 'string' && f.label.trim() ? { label: f.label.trim() } : {}),
          ...(typeof f.type === 'string' && f.type.trim() ? { type: f.type.trim() } : {}),
          ...(typeof f.default === 'string' ? { default: f.default } : {}),
          ...(Array.isArray(f.options) && f.options.length > 0
            ? { options: f.options.map((o: unknown) => String(o).trim()).filter((o: string) => o.length > 0) }
            : {}),
        }));
    }

    // Auto-decompose object variables that are missing objectFields
    // by inferring fields from the description
    if (variableType === 'object' && objectFields.length === 0) {
      const desc = typeof variableNode.description === 'string' ? variableNode.description : '';
      const label = typeof rawNode.label === 'string' ? rawNode.label : '';
      objectFields = inferObjectFieldsFromDescription(desc, label);
    }

    node.variableNode = {
      type: variableType,
      initialValue: typeof variableNode.initialValue === 'string'
        ? variableNode.initialValue
        : (variableType === 'boolean' ? 'false' : ''),
      exposeAsInput: normalizeBooleanValue(variableNode.exposeAsInput, false),
      inputName: typeof variableNode.inputName === 'string' ? variableNode.inputName : '',
      description: typeof variableNode.description === 'string' ? variableNode.description : '',
      required: normalizeBooleanValue(variableNode.required, false),
      generationPrompt: typeof variableNode.generationPrompt === 'string' ? variableNode.generationPrompt : '',
      ...(inputControl ? { inputControl } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(objectFields.length > 0 ? { objectFields } : {}),
    };
  } else if (workflowId === '__get_variable__') {
    const getVariableNode = normalizePlainRecord(rawNode.getVariableNode);
    node.getVariableNode = {
      targetNodeId: typeof getVariableNode.targetNodeId === 'string' ? getVariableNode.targetNodeId : '',
    };
  } else if (workflowId === '__json_keys__') {
    const jsonKeysNode = normalizePlainRecord(rawNode.jsonKeysNode);
    node.jsonKeysNode = {
      defaultPath: typeof jsonKeysNode.defaultPath === 'string' ? jsonKeysNode.defaultPath : '',
    };
  } else if (workflowId === '__tool__') {
    const toolNode = normalizePlainRecord(rawNode.toolNode);
    node.toolNode = {
      selectedTool: typeof toolNode.selectedTool === 'string' ? toolNode.selectedTool : '',
      paramDefaults: normalizePlainRecord(toolNode.paramDefaults),
      ...(toolNode.paramSchema && typeof toolNode.paramSchema === 'object' && !Array.isArray(toolNode.paramSchema)
        ? { paramSchema: toolNode.paramSchema }
        : {}),
    };
  } else if (workflowId === '__file_write__') {
    const fileWriteNode = normalizePlainRecord(rawNode.fileWriteNode);
    node.fileWriteNode = {
      mode: normalizeFileWriteMode(fileWriteNode.mode),
      format: normalizeFileWriteFormat(fileWriteNode.format),
      prettyPrint: normalizeBooleanValue(fileWriteNode.prettyPrint, true),
    };
  } else if (workflowId === '__file_read__') {
    const fileReadNode = normalizePlainRecord(rawNode.fileReadNode);
    node.fileReadNode = {
      parseMode: normalizeFileReadParseMode(fileReadNode.parseMode),
    };
  } else if (workflowId === '__junction__') {
    const junctionNode = normalizePlainRecord(rawNode.junctionNode);
    node.junctionNode = {
      ports: normalizePipelinePortContracts(junctionNode.ports || rawNode.ports),
    };
  }

  return { nodeType, workflowId, prefix, node };
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

function getSelectionRedesignNodeKind(workflowId: string | undefined): 'script' | 'text' | 'file_op' | 'unsupported' {
  if (workflowId === '__script__') return 'script';
  if (workflowId === '__text__') return 'text';
  if (workflowId === '__file_op__') return 'file_op';
  return 'unsupported';
}

function normalizeSelectionRedesignNodeSnapshot(raw: unknown): SelectionRedesignNodeSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const node = raw as Record<string, unknown>;
  const nodeId = typeof node.nodeId === 'string' ? node.nodeId.trim() : '';
  const workflowId = typeof node.workflowId === 'string' ? node.workflowId.trim() : '';
  if (!nodeId || !workflowId) return null;

  const script = node.script && typeof node.script === 'object' && !Array.isArray(node.script)
    ? node.script as Record<string, unknown>
    : null;
  const textNode = node.textNode && typeof node.textNode === 'object' && !Array.isArray(node.textNode)
    ? node.textNode as Record<string, unknown>
    : null;
  const fileOp = node.fileOp && typeof node.fileOp === 'object' && !Array.isArray(node.fileOp)
    ? node.fileOp as Record<string, unknown>
    : null;

  return {
    nodeId,
    workflowId,
    label: typeof node.label === 'string' ? node.label.trim() : undefined,
    script: script ? {
      description: typeof script.description === 'string' ? script.description.trim() : undefined,
      code: typeof script.code === 'string' ? script.code : undefined,
      inputs: normalizePipelinePortContracts(script.inputs),
      outputs: normalizePipelinePortContracts(script.outputs),
      chatHistory: Array.isArray(script.chatHistory)
        ? script.chatHistory
          .filter((entry): entry is { role: 'user' | 'assistant'; content: string } => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
            && (entry as any).role && (entry as any).content)
          .map((entry: any) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: String(entry.content) }))
        : undefined,
    } : undefined,
    textNode: textNode ? {
      value: typeof textNode.value === 'string' ? textNode.value : undefined,
    } : undefined,
    fileOp: fileOp ? {
      operation: typeof fileOp.operation === 'string' ? fileOp.operation : undefined,
    } : undefined,
    latestInputs: node.latestInputs && typeof node.latestInputs === 'object' && !Array.isArray(node.latestInputs)
      ? Object.fromEntries(Object.entries(node.latestInputs as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined,
    latestOutputs: node.latestOutputs && typeof node.latestOutputs === 'object' && !Array.isArray(node.latestOutputs)
      ? Object.fromEntries(Object.entries(node.latestOutputs as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined,
  };
}

function normalizeSelectionRedesignEdges(rawEdges: unknown, allowedNodeIds: Set<string>): SelectionRedesignEdgeSnapshot[] {
  if (!Array.isArray(rawEdges)) return [];
  return rawEdges
    .filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === 'object' && !Array.isArray(edge))
    .map((edge) => ({
      sourceNodeId: typeof edge.sourceNodeId === 'string' ? edge.sourceNodeId.trim() : '',
      sourcePort: typeof edge.sourcePort === 'string' ? edge.sourcePort.trim() : '',
      targetNodeId: typeof edge.targetNodeId === 'string' ? edge.targetNodeId.trim() : '',
      targetPort: typeof edge.targetPort === 'string' ? edge.targetPort.trim() : '',
    }))
    .filter((edge) => edge.sourceNodeId && edge.targetNodeId && edge.sourcePort && edge.targetPort
      && (allowedNodeIds.has(edge.sourceNodeId) || allowedNodeIds.has(edge.targetNodeId)));
}

function extractJsonObjectCandidate(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeSelectionRedesignPlanUpdateRecord(rawUpdate: unknown): Record<string, unknown> | null {
  const update = getObjectRecord(rawUpdate);
  if (!update) return null;
  const script = getObjectRecord(update.script);
  const textNode = getObjectRecord(update.textNode);
  const fileOp = getObjectRecord(update.fileOp);

  return {
    nodeId: typeof update.nodeId === 'string' ? update.nodeId : (typeof update.id === 'string' ? update.id : ''),
    label: typeof update.label === 'string' ? update.label : (typeof update.name === 'string' ? update.name : undefined),
    description: typeof update.description === 'string'
      ? update.description
      : (typeof update.intent === 'string'
        ? update.intent
        : (script && typeof script.description === 'string' ? script.description : undefined)),
    inputs: update.inputs || update.inputContract || (script ? script.inputs || script.inputContract : undefined),
    outputs: update.outputs || update.outputContract || (script ? script.outputs || script.outputContract : undefined),
    textValue: typeof update.textValue === 'string'
      ? update.textValue
      : (typeof update.value === 'string'
        ? update.value
        : (textNode && typeof textNode.value === 'string' ? textNode.value : undefined)),
    fileOperation: typeof update.fileOperation === 'string'
      ? update.fileOperation
      : (typeof update.operation === 'string'
        ? update.operation
        : (fileOp && typeof fileOp.operation === 'string' ? fileOp.operation : undefined)),
  };
}

function buildFallbackSelectionRedesignPlan(
  description: string,
  selectedNodes: SelectionRedesignNodeSnapshot[],
  selectedEdges: SelectionRedesignEdgeSnapshot[],
): SelectionRedesignPlan {
  return {
    summary: 'Used a fallback coordinated redesign plan based on the current selected-node contracts.',
    updates: selectedNodes.map((node) => {
      const nodeKind = getSelectionRedesignNodeKind(node.workflowId);
      if (nodeKind === 'script') {
        const baseDescription = node.script?.description || node.label || 'Script node';
        return {
          nodeId: node.nodeId,
          label: node.label,
          description: `${baseDescription}\n\nCoordinated redesign directive: ${description}`.trim(),
          inputs: normalizePipelinePortContracts(node.script?.inputs),
          outputs: normalizePipelinePortContracts(node.script?.outputs),
        } satisfies SelectionRedesignPlanUpdate;
      }
      if (nodeKind === 'text') {
        return {
          nodeId: node.nodeId,
          label: node.label,
          textValue: node.textNode?.value || '',
        } satisfies SelectionRedesignPlanUpdate;
      }
      return {
        nodeId: node.nodeId,
        label: node.label,
        fileOperation: ['copy', 'move', 'delete', 'mkdir', 'list'].includes(String(node.fileOp?.operation || ''))
          ? node.fileOp?.operation as SelectionRedesignPlanUpdate['fileOperation']
          : 'copy',
      } satisfies SelectionRedesignPlanUpdate;
    }),
    connections: selectedEdges.filter((edge) => edge.sourceNodeId !== edge.targetNodeId),
  };
}

function validateSelectionRedesignPlan(
  raw: unknown,
  selectedNodes: SelectionRedesignNodeSnapshot[],
): SelectionRedesignPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const nodeKindById = new Map(selectedNodes.map((node) => [node.nodeId, getSelectionRedesignNodeKind(node.workflowId)]));
  const plan = raw as Record<string, unknown>;
  const rawUpdates = Array.isArray(plan.updates)
    ? plan.updates
    : (Array.isArray(plan.nodes)
      ? plan.nodes
      : (getObjectRecord(plan.redesignPlan) && Array.isArray((plan.redesignPlan as Record<string, unknown>).updates)
        ? (plan.redesignPlan as Record<string, unknown>).updates as unknown[]
        : null));
  if (!rawUpdates) return null;

  const updates: SelectionRedesignPlanUpdate[] = [];
  const seenNodeIds = new Set<string>();

  for (const rawUpdate of rawUpdates) {
    const update = normalizeSelectionRedesignPlanUpdateRecord(rawUpdate);
    if (!update) return null;
    const nodeId = typeof update.nodeId === 'string' ? update.nodeId.trim() : '';
    if (!nodeId || seenNodeIds.has(nodeId)) return null;
    const nodeKind = nodeKindById.get(nodeId);
    if (!nodeKind || nodeKind === 'unsupported') return null;

    const normalizedUpdate: SelectionRedesignPlanUpdate = {
      nodeId,
      label: typeof update.label === 'string' && update.label.trim() ? update.label.trim() : undefined,
    };

    if (nodeKind === 'script') {
      const description = typeof update.description === 'string' ? update.description.trim() : '';
      const inputs = normalizePipelinePortContracts(update.inputs);
      const outputs = normalizePipelinePortContracts(update.outputs);
      if (!description || inputs.length === 0 || outputs.length === 0) {
        return null;
      }
      normalizedUpdate.description = description;
      normalizedUpdate.inputs = inputs;
      normalizedUpdate.outputs = outputs;
    } else if (nodeKind === 'text') {
      if (typeof update.textValue !== 'string') return null;
      normalizedUpdate.textValue = update.textValue;
    } else if (nodeKind === 'file_op') {
      const fileOperation = typeof update.fileOperation === 'string' ? update.fileOperation.trim() : '';
      if (!['copy', 'move', 'delete', 'mkdir', 'list'].includes(fileOperation)) return null;
      normalizedUpdate.fileOperation = fileOperation as SelectionRedesignPlanUpdate['fileOperation'];
    }

    updates.push(normalizedUpdate);
    seenNodeIds.add(nodeId);
  }

  if (updates.length === 0) return null;

  const allowedNodeIds = new Set(selectedNodes.map((node) => node.nodeId));
  const rawConnections = Array.isArray(plan.connections)
    ? plan.connections
    : (Array.isArray(plan.edges) ? plan.edges : []);
  const connections = normalizeSelectionRedesignEdges(rawConnections, allowedNodeIds);

  return {
    summary: typeof plan.summary === 'string' && plan.summary.trim() ? plan.summary.trim() : 'Coordinated redesign applied to selected nodes.',
    updates,
    connections,
  };
}

async function generateSelectionRedesignPlan(
  description: string,
  selectedNodes: SelectionRedesignNodeSnapshot[],
  selectedEdges: SelectionRedesignEdgeSnapshot[],
  graphContext: unknown,
): Promise<SelectionRedesignPlan | null> {
  try {
    const { runPrompt } = await import('../../loop/llm-service.js');
    const providerAndModel = getScriptGenerationProviderAndModel();

    const systemContent = `You redesign a SELECTED SUBGRAPH of pipeline nodes so the nodes work better together.

CRITICAL RULES:
1. You may redesign multiple selected nodes at once, but ONLY the selected nodes.
2. Keep every nodeId unchanged.
3. Preserve node types. Do not convert a text node into a script node, etc.
4. Script node updates must include description, inputs, and outputs only. Do NOT include code.
5. Text node updates must include textValue.
6. File operation updates must include fileOperation.
7. Keep the selected subgraph coherent: upstream outputs and downstream inputs should line up after the redesign.
8. Respect any surrounding graph constraints provided in the context.
9. If the redesign changes how selected nodes connect to each other OR to surrounding nodes, return the FULL desired connection set for every edge that should touch a selected node after the redesign.
10. Boundary connections to surrounding nodes are allowed in the connections array, especially when a selected node must stay connected to an existing output node or downstream collector.
11. Return ONLY a JSON object with this exact shape:
{
  "summary": "Short explanation of the coordinated redesign",
  "updates": [
    {
      "nodeId": "existing-node-id",
      "label": "Optional new label",
      "description": "Script intent",
      "inputs": [{ "name": "snake_case", "type": "string", "description": "..." }],
      "outputs": [{ "name": "snake_case", "type": "string", "description": "..." }]
    },
    {
      "nodeId": "existing-text-node-id",
      "label": "Optional new label",
      "textValue": "Updated text node value"
    },
    {
      "nodeId": "existing-file-node-id",
      "label": "Optional new label",
      "fileOperation": "copy|move|delete|mkdir|list"
    }
  ],
  "connections": [
    {
      "sourceNodeId": "existing-node-id",
      "sourcePort": "output_port_name",
      "targetNodeId": "existing-node-id-or-boundary-node-id",
      "targetPort": "input_port_name"
    }
  ]
}`;

    const userContent = [
      `Redesign request:\n${description.trim()}`,
      `Selected nodes:\n${JSON.stringify(selectedNodes, null, 2)}`,
      `Selected and boundary edges:\n${JSON.stringify(selectedEdges, null, 2)}`,
      graphContext ? `Surrounding graph context:\n${typeof graphContext === 'string' ? graphContext : JSON.stringify(graphContext, null, 2)}` : '',
    ].filter(Boolean).join('\n\n');

    const resp = await runPrompt([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ], providerAndModel.model, { maxTokens: 32768, temperature: 0.3 });

    const jsonStr = extractJsonObjectCandidate(resp.content);
    const validatedPlan = validateSelectionRedesignPlan(JSON.parse(jsonStr), selectedNodes);
    return validatedPlan || buildFallbackSelectionRedesignPlan(description, selectedNodes, selectedEdges);
  } catch (err) {
    debugLog.info('dashboard', 'Selection redesign planning failed, using fallback', { error: String(err) });
    return buildFallbackSelectionRedesignPlan(description, selectedNodes, selectedEdges);
  }
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
    requestedDescription,
    { graphContext },
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
  buildBoundedGenerateExecutionTests,
  buildEdgeCaseScriptContractTests,
  buildProgressContractTests,
  buildGeneratedPipelineDocumentation,
  buildPipelineScriptGenerationDescription,
  buildPipelineScriptGraphContext,
  ensurePipelineScriptNodeCode,
  extractCodeBlock,
  materializeGeneratedPipelineNode,
  normalizeGeneratedPipelineNodeType,
  shouldUseDirectScriptGeneration,
  validateGeneratedScriptCode,
  runStrictScriptGenerationFallback,
  sanitizeScriptGenerationTestCases,
  generateScriptPrePlan,
  formatPrePlanForPrompt,
  generatePipelineDecompositionPlan,
  validateDecompositionPlan,
  formatDecompositionPlanForPipelinePrompt,
  validateSelectionRedesignPlan,
  formatSemanticGraphContext,
  formatCompositionInterfaceContext,
  formatCompositionDocumentationContext,
  readScriptGenerationRolloutPolicy,
  readScriptGenerationModeOverride,
  getScriptGenerationRolloutState,
  summarizeScriptGenerationMetrics,
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

      const savedTemp = await getSavedTemperature();
      const llmResponse = await runPrompt(
        [
          { role: 'user', content: prompt },
        ],
        model,
        { maxTokens: 32768, temperature: savedTemp ?? 0.8 }
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

      const savedTemp = await getSavedTemperature();
      const llmResponse = await runPrompt(
        [{ role: 'user', content: prompt }],
        model,
        { maxTokens: 32768, temperature: savedTemp ?? 0.9 }
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
      const { description, chatHistory, currentCode, dataContext, graphContext, mode, runtimeFailure, compositionSnapshot, currentNodeId } = body || {};
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
      const compositionInterface = compositionSnapshot && typeof compositionSnapshot === 'object'
        ? await resolveCompositionInterface(ctx.workDir, compositionSnapshot)
        : undefined;
      const compositionDocumentation = Array.isArray((compositionSnapshot as any)?.metadata?.generatedPipelineDocs)
        ? (compositionSnapshot as any).metadata.generatedPipelineDocs
        : undefined;
      const compositionRecord = compositionSnapshot && typeof compositionSnapshot === 'object'
        ? compositionSnapshot as Record<string, unknown>
        : null;
      const currentNode = compositionRecord && Array.isArray(compositionRecord.nodes)
        ? compositionRecord.nodes.find((node: any) => node?.id === currentNodeId)
        : null;
      const priorManualEditCount = currentNode && currentNode.script && currentNode.script.generationMetrics && Number.isFinite(currentNode.script.generationMetrics.manualEditCount)
        ? Number(currentNode.script.generationMetrics.manualEditCount)
        : 0;
      const lifecycleResult = await runScriptGenerationWithClosureEngine(
        ctx,
        userMessage,
        toolDocs,
        chatHistory,
        scriptMode,
        currentCode,
        undefined,
        { graphContext, runtimeFailure, dataContext, compositionInterface, compositionDocumentation, currentNodeId, manualEditCount: priorManualEditCount },
      );
      await appendScriptGenerationMetricRecord({
        timestamp: new Date().toISOString(),
        mode: scriptMode,
        policy: readScriptGenerationRolloutPolicy(),
        compositionId: compositionRecord && typeof compositionRecord.id === 'string' ? compositionRecord.id : undefined,
        compositionName: compositionRecord && typeof compositionRecord.name === 'string' ? compositionRecord.name : undefined,
        currentNodeId: typeof currentNodeId === 'string' ? currentNodeId : undefined,
        currentNodeLabel: currentNode && typeof currentNode.label === 'string' ? currentNode.label : undefined,
        metrics: lifecycleResult.lifecycle.metrics,
      });

      debugLog.info('dashboard', 'Script generated', {
        engine: 'closure-engine',
        inputCount: lifecycleResult.inputs.length,
        outputCount: lifecycleResult.outputs.length,
        codeLength: lifecycleResult.code.length,
        repaired: lifecycleResult.lifecycle.repaired,
        generationPath: lifecycleResult.lifecycle.metrics.generationPath,
        candidateCount: lifecycleResult.lifecycle.metrics.candidateCount,
        retrievedExampleCount: lifecycleResult.lifecycle.metrics.retrievedExampleCount,
      });

      // Auto-persist to .ts file for v2 file-backed nodes
      let v2TestResults: any = null;
      if (currentNode?.workflowId === '__script_file__' && (currentNode as any).scriptFile?.file) {
        const compositionId = compositionRecord && typeof compositionRecord.id === 'string' ? compositionRecord.id : undefined;
        if (compositionId) {
          try {
            const discovered = await discoverCompositions(ctx.workDir);
            const compEntry = discovered.find(c => c.composition.id === compositionId);
            if (compEntry?.pipelineDir) {
              const scriptFileName = (currentNode as any).scriptFile.file;
              await writeScriptFileCode(compEntry.pipelineDir, scriptFileName, lifecycleResult.code);
              debugLog.info('generation', 'Auto-persisted v2 script file', { compositionId, file: scriptFileName });

              // Generate and run tests for this node
              try {
                const testFileName = scriptFileName.replace(/\.ts$/, '.test.ts');
                const testCode = generateNodeTestFile(
                  scriptFileName,
                  lifecycleResult.code,
                  lifecycleResult.inputs as any[],
                  lifecycleResult.outputs as any[],
                  { nodeLabel: currentNode.label, description: (currentNode as any).scriptFile.description },
                );
                await writeScriptFileCode(compEntry.pipelineDir, testFileName, testCode);
                await ensureTestHelpers(compEntry.pipelineDir);

                const testResult = await runPipelineTests(compEntry.pipelineDir, {
                  nodeFilter: testFileName,
                  timeout: 30000,
                });
                v2TestResults = testResult;
                debugLog.info('generation', 'V2 node tests completed', {
                  compositionId,
                  file: scriptFileName,
                  passed: testResult.passed,
                  failed: testResult.failed,
                  total: testResult.totalTests,
                });
              } catch (testErr) {
                debugLog.warn('generation', 'Failed to generate/run v2 tests', { error: String(testErr) });
              }
            }
          } catch (err) {
            debugLog.warn('generation', 'Failed to write v2 script file', { error: String(err) });
          }
        }
      }

      sendJson(res, 200, {
        code: lifecycleResult.code,
        inputs: lifecycleResult.inputs,
        outputs: lifecycleResult.outputs,
        assistantMessage: lifecycleResult.assistantMessage,
        lifecycle: lifecycleResult.lifecycle,
        transcript: lifecycleResult.lifecycle.transcript,
        ...(v2TestResults ? { v2TestResults } : {}),
      });
    } catch (err) {
      debugLog.error('dashboard', 'Script generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Script generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/compositions/script-generation-metrics') {
    const limitParam = Number(url.searchParams.get('limit') || '20');
    const { recent, aggregate } = await readScriptGenerationMetricsSummary(Number.isFinite(limitParam) ? limitParam : 20);
    const rolloutState = getScriptGenerationRolloutState();
    sendJson(res, 200, {
      success: true,
      policy: rolloutState.policy,
      modeOverrides: rolloutState.modeOverrides,
      featureFlags: rolloutState.featureFlags,
      recent,
      aggregate,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/compositions/redesign-selection') {
    try {
      const body = await readBody(req);
      const { description, selectedNodes, selectedEdges, graphContext } = body || {};

      if (!description || !String(description).trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }

      const normalizedNodes = Array.isArray(selectedNodes)
        ? selectedNodes
          .map(normalizeSelectionRedesignNodeSnapshot)
          .filter((node): node is SelectionRedesignNodeSnapshot => Boolean(node))
          .filter((node) => getSelectionRedesignNodeKind(node.workflowId) !== 'unsupported')
        : [];

      if (normalizedNodes.length === 0) {
        sendJson(res, 400, { error: 'At least one redesignable node must be selected.' });
        return true;
      }

      const allowedNodeIds = new Set(normalizedNodes.map((node) => node.nodeId));
      const normalizedEdges = normalizeSelectionRedesignEdges(selectedEdges, allowedNodeIds);
      const redesignPlan = await generateSelectionRedesignPlan(
        String(description).trim(),
        normalizedNodes,
        normalizedEdges,
        graphContext,
      );

      if (!redesignPlan) {
        sendJson(res, 422, { error: 'Agent returned an invalid coordinated redesign plan.' });
        return true;
      }

      const toolDocs = await generateScriptToolDocs(ctx);
      const nodeById = new Map(normalizedNodes.map((node) => [node.nodeId, node]));
      const updates = [] as any[];
      const transcript: Array<{ stage: string; title: string; content: string }> = [
        {
          stage: 'request',
          title: 'Redesign request',
          content: String(description).trim(),
        },
        {
          stage: 'plan',
          title: 'Coordinated redesign plan',
          content: JSON.stringify(redesignPlan, null, 2),
        },
      ];

      for (const update of redesignPlan.updates) {
        const originalNode = nodeById.get(update.nodeId);
        if (!originalNode) continue;
        const nodeKind = getSelectionRedesignNodeKind(originalNode.workflowId);

        if (nodeKind === 'script') {
          const currentCode = originalNode.script?.code;
          const currentChatHistory = originalNode.script?.chatHistory;
          const requestDescription = buildPipelineScriptGenerationDescription(update.description || originalNode.script?.description || (originalNode.label || 'Script node'), {
            inputs: update.inputs || originalNode.script?.inputs,
            outputs: update.outputs || originalNode.script?.outputs,
          });
          const coordinatedGraphContext = [
            'Coordinated redesign plan for selected nodes:',
            JSON.stringify(redesignPlan, null, 2),
            graphContext
              ? `Original surrounding graph context:\n${typeof graphContext === 'string' ? graphContext : JSON.stringify(graphContext, null, 2)}`
              : '',
          ].filter(Boolean).join('\n\n');
          const requestMessage = buildScriptRequestMessage(
            requestDescription,
            undefined,
            coordinatedGraphContext,
            currentCode || undefined,
          );
          const lifecycleResult = await runScriptGenerationWithClosureEngine(
            ctx,
            requestMessage,
            toolDocs,
            currentChatHistory,
            currentCode ? 'edit' : 'generate',
            currentCode,
            requestDescription,
            { graphContext: coordinatedGraphContext },
          );

          updates.push({
            nodeId: update.nodeId,
            workflowId: originalNode.workflowId,
            label: update.label || originalNode.label,
            script: {
              description: update.description || originalNode.script?.description || '',
              code: lifecycleResult.code,
              inputs: lifecycleResult.inputs,
              outputs: lifecycleResult.outputs,
              assistantMessage: lifecycleResult.assistantMessage,
              transcript: lifecycleResult.lifecycle.transcript,
            },
          });
          transcript.push({
            stage: 'node',
            title: `Redesigned script node: ${update.label || originalNode.label || update.nodeId}`,
            content: [
              `Node ID: ${update.nodeId}`,
              `Description: ${update.description || originalNode.script?.description || ''}`,
              `Inputs: ${(lifecycleResult.inputs || []).map((port) => `${port.name} (${port.type})`).join(', ') || 'none'}`,
              `Outputs: ${(lifecycleResult.outputs || []).map((port) => `${port.name} (${port.type})`).join(', ') || 'none'}`,
              '',
              lifecycleResult.lifecycle.verificationSummary,
            ].join('\n'),
          });
          continue;
        }

        if (nodeKind === 'text') {
          updates.push({
            nodeId: update.nodeId,
            workflowId: originalNode.workflowId,
            label: update.label || originalNode.label,
            textNode: {
              value: update.textValue ?? originalNode.textNode?.value ?? '',
            },
          });
          transcript.push({
            stage: 'node',
            title: `Updated text node: ${update.label || originalNode.label || update.nodeId}`,
            content: `Node ID: ${update.nodeId}\nValue: ${update.textValue ?? originalNode.textNode?.value ?? ''}`,
          });
          continue;
        }

        if (nodeKind === 'file_op') {
          updates.push({
            nodeId: update.nodeId,
            workflowId: originalNode.workflowId,
            label: update.label || originalNode.label,
            fileOp: {
              operation: update.fileOperation || originalNode.fileOp?.operation || 'copy',
            },
          });
          transcript.push({
            stage: 'node',
            title: `Updated file-op node: ${update.label || originalNode.label || update.nodeId}`,
            content: `Node ID: ${update.nodeId}\nOperation: ${update.fileOperation || originalNode.fileOp?.operation || 'copy'}`,
          });
        }
      }

      transcript.push({
        stage: 'apply',
        title: 'Selection redesign summary',
        content: `${redesignPlan.summary}\n\nUpdated ${updates.length} node${updates.length === 1 ? '' : 's'}.`,
      });

      sendJson(res, 200, {
        summary: redesignPlan.summary,
        updates,
        connections: redesignPlan.connections || [],
        transcript,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Selection redesign failed', { error: String(err) });
      sendJson(res, 500, { error: `Selection redesign failed: ${(err as Error).message}` });
    }
    return true;
  }

  // ── Composition Validation & Repair Engine ─────────────────

  /**
   * Build sample inputs for a script node based on its declared @input ports.
   * Used for smoke-testing generated code without real data.
   */
  function buildSampleInputs(
    node: { script?: { code?: string; inputs?: Array<{ name: string; type?: string }> } },
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    const portDefs = node.script?.inputs;
    if (!Array.isArray(portDefs)) return inputs;

    // Also parse type annotations from code if available
    const code = String(node.script?.code || '');
    const typeMap = new Map<string, string>();
    const typeRegex = /@input\s+\{([^}]+)\}\s+([A-Za-z0-9_]+)/g;
    for (const match of code.matchAll(typeRegex)) {
      typeMap.set(match[2], match[1].trim().toLowerCase());
    }

    for (const port of portDefs) {
      const name = port.name;
      if (!name) continue;
      const type = typeMap.get(name) || (port.type || 'string').toLowerCase();
      switch (type) {
        case 'number':
        case 'int':
        case 'float':
          inputs[name] = 0;
          break;
        case 'boolean':
        case 'bool':
          inputs[name] = false;
          break;
        case 'array':
        case 'string[]':
        case 'number[]':
          inputs[name] = [];
          break;
        case 'object':
          inputs[name] = {};
          break;
        default:
          inputs[name] = 'sample';
          break;
      }
    }
    return inputs;
  }

  /**
   * Validate and optionally repair a composition by:
   *   1. Running structural validation (validateComposition)
   *   2. Proposing and applying edge repairs (proposeScriptNodeEdgeRepairs)
   *   3. Regenerating broken script node code (runScriptGenerationWithClosureEngine)
   *   4. Smoke-testing each script node with sample inputs
   *
   * Runs up to 3 iterations. Non-blocking — returns results alongside the composition.
   * The composition object is mutated in-place when repairs are applied.
   */
  async function validateAndRepairComposition(
    ctx: DashboardContext,
    comp: { nodes: any[]; edges: any[]; [key: string]: unknown },
  ): Promise<CompositionValidationResult> {
    const MAX_ITERATIONS = 3;
    const result: CompositionValidationResult = {
      valid: false,
      repairs: [],
      remainingIssues: [],
      smokeTests: [],
      iterations: 0,
    };

    const knownWorkflowIds = getAvailableWorkflowIds(ctx.workDir);
    let previousIssueCount = Infinity;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      result.iterations = iteration;

      // ── Step 1: Structural validation ──
      const issues = validateComposition(comp, knownWorkflowIds);

      // ── Step 2: Edge repair ──
      let edgeRepairsApplied = 0;
      const scriptNodes = comp.nodes.filter((n: any) => n.workflowId === '__script__');
      for (const scriptNode of scriptNodes) {
        const repairs = proposeScriptNodeEdgeRepairs({
          nodeId: scriptNode.id,
          nodes: comp.nodes,
          edges: comp.edges,
          nodeOutputs: {},
        });
        for (const repair of repairs) {
          const edge = comp.edges.find((e: any) => e.id === repair.edgeId);
          if (edge) {
            const oldValue = edge[repair.field];
            edge[repair.field] = repair.toPort;
            result.repairs.push(
              `Edge "${repair.edgeId}": ${repair.field} "${oldValue}" → "${repair.toPort}" (${repair.reason})`
            );
            edgeRepairsApplied++;
          }
        }
      }

      // ── Step 3: Re-validate after edge repairs ──
      const postRepairIssues = edgeRepairsApplied > 0
        ? validateComposition(comp, knownWorkflowIds)
        : issues;

      // ── Step 4: Code repair for broken script nodes ──
      const codeIssuePatterns = [
        'has empty code',
        'has no execute()',
        'does not define an execute()',
        'has invalid JavaScript',
        'contains markdown fences',
        'contains a serialized JSON blob',
      ];
      const codeIssueNodes = new Set<string>();
      for (const issue of postRepairIssues) {
        for (const pattern of codeIssuePatterns) {
          if (issue.includes(pattern)) {
            // Extract node label/id from the issue string: Script node "X" ...
            const match = issue.match(/Script node "([^"]+)"/);
            if (match) codeIssueNodes.add(match[1]);
          }
        }
      }

      if (codeIssueNodes.size > 0) {
        for (const scriptNode of scriptNodes) {
          const nodeLabel = scriptNode.label || scriptNode.id;
          if (!codeIssueNodes.has(nodeLabel)) continue;

          try {
            const toolDocs = await generateScriptToolDocs(ctx);
            const nodeDescription = scriptNode.script?.description || scriptNode.label || 'Script node';

            // Build graph context from composition format (nodes + edges)
            const incoming = comp.edges.filter((e: any) => e.targetNodeId === scriptNode.id);
            const outgoing = comp.edges.filter((e: any) => e.sourceNodeId === scriptNode.id);
            const nodeById = new Map(comp.nodes.map((n: any) => [n.id, n]));
            const graphCtx: Record<string, unknown> = {
              composition: { name: (comp as any).name, description: (comp as any).description },
              upstream: incoming.map((e: any) => {
                const src = nodeById.get(e.sourceNodeId);
                return {
                  node: { label: src?.label, type: src?.workflowId },
                  fromPort: e.sourcePort,
                  toPort: e.targetPort,
                };
              }),
              downstream: outgoing.map((e: any) => {
                const tgt = nodeById.get(e.targetNodeId);
                return {
                  node: { label: tgt?.label, type: tgt?.workflowId },
                  fromPort: e.sourcePort,
                  toPort: e.targetPort,
                };
              }),
            };

            const compositionInterface = await resolveCompositionInterface(ctx.workDir, comp);
            const userMessage = buildScriptRequestMessage(nodeDescription, undefined, undefined, undefined);

            const regenerated = await runScriptGenerationWithClosureEngine(
              ctx,
              userMessage,
              toolDocs,
              undefined,
              'generate',
              undefined,
              undefined,
              { graphContext: graphCtx, compositionInterface },
            );

            // Replace the node's code and ports
            scriptNode.script = scriptNode.script || {};
            scriptNode.script.code = regenerated.code;
            scriptNode.script.inputs = regenerated.inputs;
            scriptNode.script.outputs = regenerated.outputs;
            result.repairs.push(`Regenerated code for script node "${nodeLabel}"`);
          } catch (err) {
            debugLog.warn('dashboard', `Code repair failed for node "${nodeLabel}"`, { error: String(err) });
          }
        }
      }

      // ── Step 5: Final validation pass ──
      const finalIssues = (codeIssueNodes.size > 0 || edgeRepairsApplied > 0)
        ? validateComposition(comp, knownWorkflowIds)
        : postRepairIssues;

      // ── Step 6: Check for progress ──
      if (finalIssues.length >= previousIssueCount && edgeRepairsApplied === 0) {
        // No progress — stop iterating
        result.remainingIssues = finalIssues;
        break;
      }

      previousIssueCount = finalIssues.length;

      if (finalIssues.length === 0) {
        result.remainingIssues = [];
        break;
      }

      result.remainingIssues = finalIssues;
    }

    // ── Step 7: Smoke test each script node ──
    result.smokeTests = [];
    for (const scriptNode of comp.nodes.filter((n: any) => n.workflowId === '__script__')) {
      if (!scriptNode.script?.code) continue;

      const sampleInputs = buildSampleInputs(scriptNode);
      const testCase: ScriptGenerationTestCase = {
        name: 'smoke-test',
        inputs: sampleInputs,
      };

      try {
        const testResults = await runGeneratedScriptUnitTests(
          scriptNode.script.code,
          [testCase],
        );
        const testResult = testResults[0];
        result.smokeTests.push({
          nodeId: scriptNode.id,
          nodeLabel: scriptNode.label || scriptNode.id,
          passed: testResult?.passed ?? false,
          error: testResult?.error || (testResult?.failures?.length ? testResult.failures.join('; ') : undefined),
        });
      } catch (err) {
        result.smokeTests.push({
          nodeId: scriptNode.id,
          nodeLabel: scriptNode.label || scriptNode.id,
          passed: false,
          error: `Smoke test execution failed: ${(err as Error).message}`,
        });
      }
    }

    result.valid = result.remainingIssues.length === 0
      && result.smokeTests.every(t => t.passed);

    return result;
  }

  if (req.method === 'POST' && pathname === '/api/compositions/generate-pipeline') {
    try {
      const body = await readBody(req);
      const { description, graphContext, selectedPublishedSkillIds, temperature: requestTemperature } = body || {};

      if (!description || !String(description).trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }

      // Use request temperature, then saved preference, then hardcoded default
      const savedTemp = await getSavedTemperature();
      const pipelineTemperature = typeof requestTemperature === 'number'
        ? requestTemperature
        : (savedTemp ?? 0.4);

      const toolDocs = await generateScriptToolDocs(ctx);
      const publishedSkillsSection = await formatPublishedSkillsPromptSection(ctx.workDir, {
        audience: 'pipelines',
        maxSkills: 6,
        selectedSkillIds: Array.isArray(selectedPublishedSkillIds) ? selectedPublishedSkillIds : undefined,
      });

      // Phase 1: Contract-driven decomposition plan
      const decompositionPlan = await generatePipelineDecompositionPlan(
        description.trim(),
        toolDocs,
        publishedSkillsSection || '',
      );
      const decompositionSection = decompositionPlan
        ? formatDecompositionPlanForPipelinePrompt(decompositionPlan)
        : '';

      const pipelineSystemPrompt = `You are a pipeline architect for a visual automation platform. The user describes a task, and you decompose it into multiple small, focused steps — each becoming a node in a pipeline graph.

IMPORTANT RULES:
1. Each script node should do ONE thing and be under 20 lines of code. NEVER create a monolithic node that does multiple things.
2. Use the simplest node type for each step:
   - prefer specialized built-in nodes when they fit cleanly
   - use "script" for custom logic, LLM calls, transformations, or orchestration that cannot be expressed with built-ins
3. Connect nodes via matching port names in the connections array
4. Port names must use snake_case (e.g., "generated_text", "file_path")
5. Use control-flow nodes when the task explicitly needs branching, gating, switching, looping, shared variables, or final output collection.
6. For script nodes, describe the intent and declare ports only. Do NOT write JavaScript code. The backend will generate the code in a separate pass.
7. Use a single "output" node when the pipeline should publish final outputs.
8. Use "variable" nodes for shared user-provided inputs that should feed multiple downstream nodes.

DECOMPOSITION STRATEGY — CRITICAL:
- If the user provides TypeScript interfaces or types, create ONE node per major interface. For example, if the output has fields like metadata, cast, locations, and sections, each should be its own node.
- When producing arrays of complex objects (characters, scenes, shots), use a generator node + for_each node pattern: one node generates the list, a for_each iterates, and inner nodes process each item.
- Side-effect operations (image generation, file saving, asset creation) MUST be separate nodes from the data generation nodes.
- A final "assemble" node should stitch sub-results into the complete output object.
- Prefer 5-15 nodes for moderate tasks, 10-25 for complex tasks. A pipeline with only 1-3 nodes for a complex task is WRONG.
- NEVER put an entire complex generation (e.g. a full script with characters, locations, scenes, and shots) into a single node.

${buildPipelineGenerationNodeTypeGuidance(toolDocs)}

${publishedSkillsSection ? `${publishedSkillsSection}

When one of these published skills clearly matches the requested behavior, incorporate its trigger conditions, input contract, and guidance into the pipeline nodes instead of inventing a new pattern.
` : ''}

${graphContext ? `EXISTING PIPELINE CONTEXT:
${typeof graphContext === 'string' ? graphContext : JSON.stringify(graphContext, null, 2)}

If this context is provided, treat it as existing graph structure that should inform how you extend, reuse, or connect the generated nodes. Avoid duplicating responsibilities that already exist in the selected context unless the user explicitly asks for replacement.
` : ''}

${decompositionSection ? `${decompositionSection}
` : ''}
RESPONSE FORMAT — respond with ONLY a JSON object (no explanation, no markdown fences):

{
  "name": "Human-readable pipeline name",
  "nodes": [
    {
      "type": "${PIPELINE_GENERATION_NODE_TYPE_LIST}",
      "label": "Short Node Label",
      "description": "What this node does (script only)",
      "inputs": [{ "name": "input_name", "type": "string", "description": "What this input means" }],
      "outputs": [{ "name": "output_name", "type": "string", "description": "What this output means" }],
      "textNode": { "value": "..." },
      "fileOp": { "operation": "copy|move|delete|mkdir|list" },
      "outputNode": { "ports": [{ "name": "result", "type": "string", "description": "..." }] },
      "forEachNode": { "itemVariable": "item", "maxIterations": 100 },
      "switchNode": { "cases": [{ "value": "draft", "port": "on_draft" }], "defaultPort": "on_default" },
      "branchNode": { "condition": "{{count}} > 0" },
      "delayNode": { "delayMs": 1000 },
      "gateNode": { "defaultOpen": true, "onClosed": "skip|stop|fail" },
      "variableNode": { "type": "string|number|array|boolean", "initialValue": "", "exposeAsInput": false, "inputName": "", "description": "", "required": false, "generationPrompt": "", "inputControl": "text|textarea|select|combobox", "options": ["opt1", "opt2"] },
      "getVariableNode": { "targetNodeId": "var_123" },
      "jsonKeysNode": { "defaultPath": "items.0" },
      "toolNode": { "selectedTool": "tool_name", "paramDefaults": {} },
      "fileWriteNode": { "mode": "overwrite|append", "format": "auto|json|text", "prettyPrint": true },
      "fileReadNode": { "parseMode": "auto|json|text" },
      "junctionNode": { "ports": [{ "name": "payload", "type": "string", "description": "..." }] },
      "asset": { "mode": "pick|save|list|remove|generate_path" },
      "imageViewer": { "filePath": "", "width": 300, "height": 300 },
      "mediaPlayer": { "sourceMode": "file_path|url|asset_id", "filePath": "", "url": "", "assetId": "", "mediaType": "auto|image|video|audio|pdf|text", "width": 320, "height": 240, "title": "", "autoPlay": false, "defaultVolume": 0.8, "loop": false, "playbackRate": 1, "imageFit": "contain|cover|actual" }
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
- If you need looping, use type "for_each" rather than encoding a loop inside one giant script node unless custom logic is truly necessary
- If you need branching, use "branch", "gate", or "switch" instead of ad hoc boolean scripts when possible
- Make sure every connection references port names that actually exist on the source and target nodes

EXAMPLE — "Generate a poem about a theme and save it to a file":

{
  "name": "Poem Generator & Saver",
  "nodes": [
    {
      "type": "text",
      "label": "Theme",
      "textNode": { "value": "autumn leaves" }
    },
    {
      "type": "script",
      "label": "Generate Poem",
      "description": "Generate a poem from a theme using AI. Use context.llm.generateJSON to create a poem with a title.",
      "inputs": [
        { "name": "theme", "type": "string", "description": "The theme to write about" }
      ],
      "outputs": [
        { "name": "poem", "type": "string", "description": "The generated poem" },
        { "name": "title", "type": "string", "description": "A title for the poem" }
      ]
    },
    {
      "type": "script",
      "label": "Save to File",
      "description": "Write text content to a file on disk using Node.js fs module.",
      "inputs": [
        { "name": "content", "type": "string", "description": "Text to save" },
        { "name": "filename", "type": "string", "description": "File name" }
      ],
      "outputs": [
        { "name": "file_path", "type": "string", "description": "Path where saved" }
      ]
    }
  ],
  "connections": [
    { "from": 0, "fromPort": "text", "to": 1, "toPort": "theme" },
    { "from": 1, "fromPort": "poem", "to": 2, "toPort": "content" },
    { "from": 1, "fromPort": "title", "to": 2, "toPort": "filename" }
  ]
}

CRITICAL: Script nodes must NEVER include a "code" field. Only include "description", "inputs", and "outputs". The code is generated separately in a second pass.

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

      const llmResp = await runPrompt(pipelineMessages, pipelineModel, { maxTokens: 32768, temperature: pipelineTemperature });
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

      // Warn if the decomposition plan expected many nodes but the LLM collapsed them
      if (decompositionPlan && decompositionPlan.subContracts.length >= 4) {
        const scriptCount = pipeline.nodes.filter((n: any) => {
          const t = normalizeGeneratedPipelineNodeType(n?.type || n?.workflowId) || 'script';
          return t === 'script';
        }).length;
        if (scriptCount <= 2) {
          debugLog.info('dashboard', `Pipeline generation collapsed ${decompositionPlan.subContracts.length} sub-contracts into only ${scriptCount} script nodes — pipeline may be too monolithic`);
        }
      }

      const realNodes: any[] = [];
      const idByIndex: string[] = [];
      const scriptNodeResults = new Map<number, PipelineScriptNodeGenerationResult>();
      let outputNodeCount = 0;

      // Generate all script node code in parallel — contracts are already defined
      const scriptNodePromises: Array<{ index: number; promise: Promise<PipelineScriptNodeGenerationResult> }> = [];
      for (let i = 0; i < pipeline.nodes.length; i++) {
        const pNode = pipeline.nodes[i];
        const nodeType = normalizeGeneratedPipelineNodeType(pNode?.type || pNode?.workflowId) || 'script';
        if (nodeType !== 'script') continue;
        scriptNodePromises.push({ index: i, promise: ensurePipelineScriptNodeCode(ctx, pipeline, i, toolDocs) });
      }
      const scriptNodeSettled = await Promise.allSettled(scriptNodePromises.map(p => p.promise));
      for (let j = 0; j < scriptNodePromises.length; j++) {
        const result = scriptNodeSettled[j];
        if (result.status === 'fulfilled') {
          scriptNodeResults.set(scriptNodePromises[j].index, result.value);
        } else {
          debugLog.warn('dashboard', `Script node ${scriptNodePromises[j].index} generation failed`, { error: String(result.reason) });
          // Fall back to sequential retry
          const fallback = await ensurePipelineScriptNodeCode(ctx, pipeline, scriptNodePromises[j].index, toolDocs);
          scriptNodeResults.set(scriptNodePromises[j].index, fallback);
        }
      }

      for (let i = 0; i < pipeline.nodes.length; i++) {
        const pNode = pipeline.nodes[i];
        const materialized = materializeGeneratedPipelineNode(
          pNode,
          i,
          scriptNodeResults.get(i),
        );
        if (!materialized) {
          sendJson(res, 422, { error: `Unsupported generated node type at index ${i}`, raw: pNode });
          return true;
        }
        if (materialized.workflowId === '__output__') outputNodeCount += 1;
        idByIndex.push(String(materialized.node.id));
        realNodes.push(materialized.node);
      }

      if (outputNodeCount > 1) {
        sendJson(res, 422, { error: 'Generated pipeline contains multiple output nodes. Only one output node is supported.' });
        return true;
      }

      // Build edges from connections
      const realEdges: any[] = [];
      if (Array.isArray(pipeline.connections)) {
        for (const conn of pipeline.connections) {
          const srcId = idByIndex[conn.from];
          const tgtId = idByIndex[conn.to];
          if (!srcId || !tgtId) continue;

          // Auto-correct output port names for nodes with fixed port sets
          const srcNode = realNodes.find((n: any) => n.id === srcId);
          let sourcePort = conn.fromPort;
          if (srcNode?.workflowId === '__text__' && sourcePort !== 'text') {
            sourcePort = 'text';
          }
          // Variable nodes only have "value" and "length" output ports
          if (srcNode?.workflowId === '__variable__' && sourcePort !== 'value' && sourcePort !== 'length') {
            sourcePort = 'value';
          }
          // Get Variable nodes also only have "value" and "length" output ports
          if (srcNode?.workflowId === '__get_variable__' && sourcePort !== 'value' && sourcePort !== 'length') {
            sourcePort = 'value';
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

      // ── Post-generation validation & repair ──
      const tempComp = {
        nodes: realNodes,
        edges: realEdges,
        version: '1',
        id: pipeline.name || 'generated-pipeline',
      };
      let validation: CompositionValidationResult | undefined;
      try {
        validation = await validateAndRepairComposition(ctx, tempComp);
        debugLog.info('dashboard', 'Pipeline validation complete', {
          valid: validation.valid,
          repairs: validation.repairs.length,
          remainingIssues: validation.remainingIssues.length,
          smokeTestsPassed: validation.smokeTests.filter(t => t.passed).length,
          smokeTestsFailed: validation.smokeTests.filter(t => !t.passed).length,
          iterations: validation.iterations,
        });
      } catch (err) {
        debugLog.warn('dashboard', 'Pipeline validation failed (non-blocking)', { error: String(err) });
      }

      const documentation = buildGeneratedPipelineDocumentation(
        description.trim(),
        pipeline.name || 'Generated Pipeline',
        realNodes,
        realEdges,
        decompositionPlan,
        await resolveCompositionInterface(ctx.workDir, {
          id: pipeline.name || 'generated-pipeline',
          nodes: realNodes,
          edges: realEdges,
        }),
      );

      // ── v2 file-backed pipeline format ──
      if (body.format === 'v2') {
        const pipelineName = pipeline.name || 'Generated Pipeline';
        let pipelineId = pipelineName
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const pipelineDescription = description.trim();
        const parentDir = join(homedir(), '.woodbury', 'workflows');
        const candidateDir = join(parentDir, pipelineId);

        // ── Conflict detection ───────────────────────────────
        if (existsSync(candidateDir)) {
          let existingScriptFiles: string[] = [];
          try {
            existingScriptFiles = (await readdir(candidateDir)).filter(f =>
              f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts') && !f.startsWith('_')
            );
          } catch { /* empty */ }

          if (existingScriptFiles.length > 0 && !body.conflictResolution) {
            // Return conflict info so the UI can ask the user
            let existingManifest: any = null;
            try {
              existingManifest = JSON.parse(await readFile(join(candidateDir, 'pipeline.json'), 'utf-8'));
            } catch { /* no manifest */ }

            sendJson(res, 409, {
              conflict: true,
              pipelineId,
              pipelineDir: candidateDir,
              existingFiles: existingScriptFiles,
              existingName: existingManifest?.name || pipelineId,
              existingDescription: existingManifest?.description || '',
              existingNodeCount: existingManifest?.nodes?.length || 0,
              message: `A pipeline already exists at "${pipelineId}" with ${existingScriptFiles.length} script file(s). How would you like to proceed?`,
              options: [
                { value: 'overwrite', label: 'Overwrite — replace the existing pipeline entirely' },
                { value: 'new-folder', label: 'New folder — create a new pipeline with a different name' },
                { value: 'edit', label: 'Edit — keep existing files and merge new nodes into the pipeline' },
              ],
            });
            return true;
          }

          if (body.conflictResolution === 'new-folder') {
            const suffix = Date.now().toString(36);
            pipelineId = `${pipelineId}-${suffix}`;
          }
          // 'overwrite' falls through to normal scaffold (which overwrites)
          // 'edit' is handled below after scaffold
        }

        const { pipelineDir } = await scaffoldPipeline(parentDir, pipelineId, pipelineName, pipelineDescription);
        const v2Pipeline = await loadPipeline(pipelineDir);

        // Convert each __script__ node to __script_file__ and write .ts files
        for (const node of realNodes) {
          if (node.workflowId === '__script__' && node.script?.code) {
            const fileName = (node.label || node.id)
              .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.ts';
            await writeScriptFileCode(pipelineDir, fileName, node.script.code);

            v2Pipeline.nodes.push({
              ...node,
              workflowId: '__script_file__',
              scriptFile: {
                file: fileName,
                description: node.script.description || '',
                inputs: node.script.inputs || [],
                outputs: node.script.outputs || [],
              },
            } as any);
          } else {
            v2Pipeline.nodes.push(node as any);
          }
        }

        v2Pipeline.edges = realEdges;
        await savePipelineManifest(pipelineDir, v2Pipeline);

        // Generate test files for all nodes, run them, and repair failures
        let pipelineTestResults: any = null;
        try {
          const testFiles = await generateAllNodeTests(pipelineDir, v2Pipeline.nodes as any[]);
          if (testFiles.length > 0) {
            await ensureTestHelpers(pipelineDir);
            pipelineTestResults = await runPipelineTests(pipelineDir, { timeout: 60000 });
            debugLog.info('generation', 'V2 pipeline tests completed (round 1)', {
              pipelineId,
              testFiles: testFiles.length,
              passed: pipelineTestResults.passed,
              failed: pipelineTestResults.failed,
            });

            // ── Test failure repair loop (up to 2 attempts) ──
            const MAX_REPAIR_ATTEMPTS = 2;
            let repairAttempt = 0;
            while (pipelineTestResults.failed > 0 && repairAttempt < MAX_REPAIR_ATTEMPTS) {
              repairAttempt++;
              debugLog.info('generation', `V2 pipeline test repair attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}`, {
                pipelineId,
                failedTests: pipelineTestResults.failed,
              });

              // Find which nodes have failing tests
              const failingFiles = (pipelineTestResults.testFiles || [])
                .filter((tf: any) => tf.tests?.some((t: any) => t.status === 'fail'))
                .map((tf: any) => ({
                  testFile: tf.file,
                  nodeFile: tf.file.replace('.test.ts', '.ts'),
                  errors: tf.tests.filter((t: any) => t.status === 'fail').map((t: any) => t.error || t.name),
                }));

              let repaired = 0;
              for (const failing of failingFiles) {
                try {
                  // Read the failing node's code and test file
                  const nodeCode = await readFile(join(pipelineDir, failing.nodeFile), 'utf-8');
                  const testCode = await readFile(join(pipelineDir, failing.testFile), 'utf-8');

                  // Find the corresponding node in the manifest
                  const matchNode = (v2Pipeline.nodes as any[]).find(
                    (n: any) => n.scriptFile?.file === failing.nodeFile,
                  );
                  if (!matchNode) continue;

                  // Ask LLM to fix the code based on test errors
                  const repairUserMsg = [
                    'The following TypeScript pipeline node has failing tests. Fix the execute() function so all tests pass.',
                    '',
                    `## File: ${failing.nodeFile}`,
                    '```typescript',
                    nodeCode,
                    '```',
                    '',
                    `## Test file: ${failing.testFile}`,
                    '```typescript',
                    testCode,
                    '```',
                    '',
                    '## Test errors:',
                    ...failing.errors.map((e: string) => `- ${e}`),
                    '',
                    'Return ONLY the corrected TypeScript code for the node file (not the test file).',
                    'Keep the same @input/@output annotations and execute() signature.',
                    'Fix the logic so the tests pass. Do not change the test expectations.',
                  ].join('\n');

                  const repairSystemMsg = 'You are a TypeScript expert. Return only valid TypeScript code, no markdown fences, no explanation.';
                  const { runPrompt: runRepairPrompt } = await import('../../loop/llm-service.js');
                  const repairProviderAndModel = getScriptGenerationProviderAndModel('generation');
                  const repairMessages: Array<{ role: 'system' | 'user'; content: string }> = [
                    { role: 'system', content: repairSystemMsg },
                    { role: 'user', content: repairUserMsg },
                  ];
                  const repairResp = await runRepairPrompt(repairMessages, repairProviderAndModel.model, {
                    maxTokens: 8192,
                    temperature: 0.2,
                  });
                  const repaired_code = repairResp.content;

                  if (repaired_code && repaired_code.trim().length > 50) {
                    // Strip markdown fences if present
                    let cleanCode = repaired_code.trim();
                    if (cleanCode.startsWith('```')) {
                      cleanCode = cleanCode.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
                    }
                    await writeFile(join(pipelineDir, failing.nodeFile), cleanCode, 'utf-8');
                    repaired++;
                    debugLog.info('generation', `Repaired ${failing.nodeFile}`, { attempt: repairAttempt });
                  }
                } catch (repairErr) {
                  debugLog.warn('generation', `Failed to repair ${failing.nodeFile}`, { error: String(repairErr) });
                }
              }

              if (repaired === 0) break; // Nothing to fix, stop trying

              // Re-run tests after repair
              pipelineTestResults = await runPipelineTests(pipelineDir, { timeout: 60000 });
              debugLog.info('generation', `V2 pipeline tests after repair ${repairAttempt}`, {
                pipelineId,
                passed: pipelineTestResults.passed,
                failed: pipelineTestResults.failed,
              });
            }

            pipelineTestResults.repairAttempts = repairAttempt;
          }
        } catch (testErr) {
          debugLog.warn('generation', 'Failed to generate/run v2 pipeline tests', { error: String(testErr) });
        }

        // ── Generate React views for the pipeline ──
        let viewsResult: { viewsGenerated: string[]; buildSuccess: boolean } | null = null;
        try {
          const { generatePipelineViews } = await import('../view-scaffolding.js');
          viewsResult = await generatePipelineViews(
            pipelineDir,
            pipelineName,
            description.trim(),
            realNodes,
          );
          debugLog.info('generation', 'Pipeline views generated', {
            pipelineId,
            views: viewsResult.viewsGenerated,
            buildSuccess: viewsResult.buildSuccess,
          });
        } catch (viewErr) {
          debugLog.warn('generation', 'View generation failed (non-fatal)', { error: String(viewErr) });
        }

        sendJson(res, 200, {
          success: true,
          format: 'v2',
          pipelineDir,
          name: pipelineName,
          nodes: v2Pipeline.nodes,
          edges: v2Pipeline.edges,
          documentation,
          ...(decompositionPlan ? { decompositionPlan } : {}),
          ...(validation ? { validation } : {}),
          ...(pipelineTestResults ? { testResults: pipelineTestResults } : {}),
          ...(viewsResult ? { views: viewsResult } : {}),
        });
      } else {
        sendJson(res, 200, {
          success: true,
          name: pipeline.name || 'Generated Pipeline',
          nodes: realNodes,
          edges: realEdges,
          documentation,
          ...(decompositionPlan ? { decompositionPlan } : {}),
          ...(validation ? { validation } : {}),
        });
      }
    } catch (err) {
      debugLog.error('dashboard', 'Pipeline generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Pipeline generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/compositions/generate-documentation') {
    try {
      const body = await readBody(req);
      const composition = body?.composition;
      const requestDescription = typeof body?.request === 'string'
        ? body.request.trim()
        : (typeof composition?.description === 'string' ? composition.description.trim() : '');

      if (!composition || typeof composition !== 'object') {
        sendJson(res, 400, { error: 'composition is required' });
        return true;
      }
      if (!Array.isArray(composition.nodes) || !Array.isArray(composition.edges)) {
        sendJson(res, 400, { error: 'composition must include nodes and edges arrays' });
        return true;
      }

      const documentation = buildGeneratedPipelineDocumentation(
        requestDescription,
        String(composition.name || 'Pipeline'),
        composition.nodes,
        composition.edges,
        null,
        await resolveCompositionInterface(ctx.workDir, composition),
      );

      sendJson(res, 200, {
        success: true,
        documentation,
      });
    } catch (err) {
      debugLog.error('dashboard', 'Pipeline documentation generation failed', { error: String(err) });
      sendJson(res, 500, { error: `Pipeline documentation generation failed: ${(err as Error).message}` });
    }
    return true;
  }

  // ── Plain-English Error Explanation ───────────────────────

  // In-memory cache for error explanations (keyed by error hash)
  const _errorExplainCache: Map<string, ExplainErrorResponse> = (globalThis as any).__woodburyErrorExplainCache ??
    ((globalThis as any).__woodburyErrorExplainCache = new Map<string, ExplainErrorResponse>());

  if (req.method === 'POST' && pathname === '/api/compositions/explain-error') {
    try {
      const body = await readBody(req);
      const { error: errorMsg, nodeLabel, nodeType } = (body || {}) as ExplainErrorRequest;
      if (!errorMsg) {
        sendJson(res, 400, { error: 'error field is required' });
        return true;
      }

      // Simple hash for caching
      const cacheKey = `${String(nodeType)}:${String(errorMsg).slice(0, 500)}`;
      const cached = _errorExplainCache.get(cacheKey);
      if (cached) {
        sendJson(res, 200, cached);
        return true;
      }

      const { runPrompt } = await import('../../loop/llm-service.js');
      const providerAndModel = getScriptGenerationProviderAndModel('repair');

      const resp = await runPrompt(
        [
          {
            role: 'system' as const,
            content: `You translate technical error messages into plain English for non-technical users. Be brief and helpful.
Return ONLY a JSON object with two keys:
- "summary": one sentence explaining what went wrong in simple language (no technical jargon, no code references)
- "suggestion": one sentence suggesting what to try next
Do NOT include markdown fences or any text outside the JSON.`,
          },
          {
            role: 'user' as const,
            content: `Error in the "${nodeLabel || 'a pipeline step'}" step (${nodeType || 'unknown'}):\n${String(errorMsg).slice(0, 800)}`,
          },
        ],
        providerAndModel.model,
        { maxTokens: 32768, temperature: 0.1 },
      );

      try {
        const cleaned = (resp.content || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned);
        const result: ExplainErrorResponse = {
          summary: String(parsed.summary || '').slice(0, 300),
          suggestion: String(parsed.suggestion || '').slice(0, 300),
        };
        _errorExplainCache.set(cacheKey, result);
        // Keep cache bounded
        if (_errorExplainCache.size > 200) {
          const firstKey = _errorExplainCache.keys().next().value;
          if (firstKey) _errorExplainCache.delete(firstKey);
        }
        sendJson(res, 200, result);
      } catch {
        const fallback: ExplainErrorResponse = { summary: '', suggestion: '' };
        sendJson(res, 200, fallback);
      }
    } catch (err) {
      debugLog.error('dashboard', 'Error explanation failed', { error: String(err) });
      const fallback: ExplainErrorResponse = { summary: '', suggestion: '' };
      sendJson(res, 200, fallback); // graceful fallback
    }
    return true;
  }

  // ── Add a Step ─────────────────────────────────────────────

  const addNodeMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/add-node$/);
  if (req.method === 'POST' && addNodeMatch) {
    const compId = decodeURIComponent(addNodeMatch[1]);
    try {
      const body = await readBody(req);
      const { description, afterNodeId } = (body || {}) as AddNodeRequest;

      if (!description || typeof description !== 'string' || !description.trim()) {
        sendJson(res, 400, { error: 'description is required' });
        return true;
      }

      // Load composition
      const discovered = await discoverCompositions(ctx.workDir);
      const found = discovered.find(d => d.composition.id === compId);
      if (!found) {
        sendJson(res, 404, { error: `Composition "${compId}" not found` });
        return true;
      }

      const comp = JSON.parse(JSON.stringify(found.composition));
      const nodes: any[] = Array.isArray(comp.nodes) ? comp.nodes : [];
      const edges: any[] = Array.isArray(comp.edges) ? comp.edges : [];

      // Build graph context around the insertion point
      const afterNode = afterNodeId ? nodes.find((n: any) => n.id === afterNodeId) : null;
      const afterNodeIndex = afterNode ? nodes.indexOf(afterNode) : nodes.length - 1;

      // Find downstream node (the node the afterNode feeds into)
      const downstreamEdge = afterNodeId
        ? edges.find((e: any) => e.sourceNodeId === afterNodeId && e.sourcePort === '__done__')
        : null;
      const downstreamNode = downstreamEdge
        ? nodes.find((n: any) => n.id === downstreamEdge.targetNodeId)
        : null;

      // Build context about neighboring nodes for the AI
      const neighborContext: string[] = [];
      if (afterNode) {
        neighborContext.push(`Previous step: "${afterNode.label || 'Unnamed'}" (${afterNode.workflowId})`);
        if (afterNode.script?.outputs?.length) {
          neighborContext.push('Available outputs from previous step:');
          for (const out of afterNode.script.outputs) {
            neighborContext.push(`  - ${out.name} (${out.type}): ${out.description || ''}`);
          }
        }
      }
      if (downstreamNode) {
        neighborContext.push(`Next step: "${downstreamNode.label || 'Unnamed'}" (${downstreamNode.workflowId})`);
        if (downstreamNode.script?.inputs?.length) {
          neighborContext.push('Expected inputs for next step:');
          for (const inp of downstreamNode.script.inputs) {
            neighborContext.push(`  - ${inp.name} (${inp.type}): ${inp.description || ''}`);
          }
        }
      }

      // Build the graph context object for the closure engine
      const graphContext: Record<string, unknown> = {
        composition: { name: comp.name, description: comp.description },
        upstream: afterNode ? [{
          node: { label: afterNode.label, type: afterNode.workflowId },
          fromPort: '__done__',
          toPort: '__trigger__',
        }] : [],
        downstream: downstreamNode ? [{
          node: { label: downstreamNode.label, type: downstreamNode.workflowId },
          fromPort: '__done__',
          toPort: '__trigger__',
        }] : [],
      };

      // Add output contracts from the afterNode as upstream data ports
      if (afterNode?.script?.outputs?.length) {
        for (const out of afterNode.script.outputs) {
          (graphContext.upstream as any[]).push({
            node: { label: afterNode.label, type: afterNode.workflowId },
            fromPort: out.name,
            toPort: out.name,
            expectedContract: `${out.type}: ${out.description || ''}`,
          });
        }
      }

      // Generate the script node code
      const toolDocs = await generateScriptToolDocs(ctx);
      const fullDescription = [
        description.trim(),
        '',
        neighborContext.length > 0 ? 'Context:\n' + neighborContext.join('\n') : '',
      ].filter(Boolean).join('\n');

      const userMessage = buildScriptRequestMessage(fullDescription, undefined, undefined, undefined);

      const compositionInterface = await resolveCompositionInterface(ctx.workDir, comp);

      const lifecycleResult = await runScriptGenerationWithClosureEngine(
        ctx,
        userMessage,
        toolDocs,
        undefined, // no chat history
        'generate',
        undefined, // no current code
        undefined, // no request scope message
        { graphContext, compositionInterface },
      );

      // Create the new node
      const nodeId = 'script-' + Math.random().toString(36).slice(2, 9);
      // Determine position: place 350px to the right of the afterNode, or at (100, 100)
      let posX = 100;
      let posY = 100;
      if (afterNode) {
        posX = (afterNode.position?.x || 0) + 350;
        posY = afterNode.position?.y || 0;
      } else if (nodes.length > 0) {
        // Place to the right of the rightmost node
        let maxX = 0;
        for (const n of nodes) {
          if (n.position?.x > maxX) maxX = n.position.x;
        }
        posX = maxX + 350;
        posY = 100;
      }

      const newNode: Record<string, unknown> = {
        id: nodeId,
        workflowId: '__script__',
        position: { x: posX, y: posY },
        label: lifecycleResult.assistantMessage
          ? description.trim().slice(0, 50)
          : description.trim().slice(0, 50),
        script: {
          description: description.trim(),
          code: lifecycleResult.code,
          inputs: lifecycleResult.inputs,
          outputs: lifecycleResult.outputs,
          chatHistory: lifecycleResult.assistantMessage
            ? [
              { role: 'user', content: description.trim() },
              { role: 'assistant', content: lifecycleResult.assistantMessage },
            ]
            : [],
          generationTranscript: lifecycleResult.lifecycle.transcript || [],
        },
      };

      // Add node to composition
      nodes.push(newNode);

      // Edge splicing: connect the new node into the graph
      const newEdges: any[] = [];

      if (afterNodeId && downstreamEdge) {
        // Remove the old direct edge between afterNode and downstream
        const oldEdgeIndex = edges.indexOf(downstreamEdge);
        if (oldEdgeIndex >= 0) edges.splice(oldEdgeIndex, 1);

        // Connect afterNode → new node (flow)
        newEdges.push({
          id: 'edge-' + Math.random().toString(36).slice(2, 9),
          sourceNodeId: afterNodeId,
          sourcePort: '__done__',
          targetNodeId: nodeId,
          targetPort: '__trigger__',
        });

        // Connect new node → downstream (flow)
        newEdges.push({
          id: 'edge-' + Math.random().toString(36).slice(2, 9),
          sourceNodeId: nodeId,
          sourcePort: '__done__',
          targetNodeId: downstreamEdge.targetNodeId,
          targetPort: '__trigger__',
        });

        // Wire data ports: connect afterNode outputs to matching new node inputs
        if (afterNode?.script?.outputs && lifecycleResult.inputs) {
          for (const inp of lifecycleResult.inputs) {
            const matchingOutput = afterNode.script.outputs.find(
              (o: any) => o.name === inp.name || o.name.toLowerCase() === inp.name.toLowerCase()
            );
            if (matchingOutput) {
              newEdges.push({
                id: 'edge-' + Math.random().toString(36).slice(2, 9),
                sourceNodeId: afterNodeId,
                sourcePort: matchingOutput.name,
                targetNodeId: nodeId,
                targetPort: inp.name,
              });
            }
          }
        }

        // Wire data ports: connect new node outputs to matching downstream inputs
        if (downstreamNode?.script?.inputs && lifecycleResult.outputs) {
          for (const out of lifecycleResult.outputs) {
            const matchingInput = downstreamNode.script.inputs.find(
              (i: any) => i.name === out.name || i.name.toLowerCase() === out.name.toLowerCase()
            );
            if (matchingInput) {
              newEdges.push({
                id: 'edge-' + Math.random().toString(36).slice(2, 9),
                sourceNodeId: nodeId,
                sourcePort: out.name,
                targetNodeId: downstreamNode.id,
                targetPort: matchingInput.name,
              });
            }
          }
        }
      } else if (afterNodeId) {
        // No downstream node — just connect afterNode → new node
        newEdges.push({
          id: 'edge-' + Math.random().toString(36).slice(2, 9),
          sourceNodeId: afterNodeId,
          sourcePort: '__done__',
          targetNodeId: nodeId,
          targetPort: '__trigger__',
        });

        // Wire data ports from afterNode
        if (afterNode?.script?.outputs && lifecycleResult.inputs) {
          for (const inp of lifecycleResult.inputs) {
            const matchingOutput = afterNode.script.outputs.find(
              (o: any) => o.name === inp.name || o.name.toLowerCase() === inp.name.toLowerCase()
            );
            if (matchingOutput) {
              newEdges.push({
                id: 'edge-' + Math.random().toString(36).slice(2, 9),
                sourceNodeId: afterNodeId,
                sourcePort: matchingOutput.name,
                targetNodeId: nodeId,
                targetPort: inp.name,
              });
            }
          }
        }
      }

      edges.push(...newEdges);
      comp.nodes = nodes;
      comp.edges = edges;
      comp.metadata = comp.metadata || {};
      comp.metadata.updatedAt = new Date().toISOString();

      // ── Post-insertion validation & repair ──
      let validation: CompositionValidationResult | undefined;
      try {
        validation = await validateAndRepairComposition(ctx, comp);
        debugLog.info('dashboard', `Add-node validation complete for "${compId}"`, {
          valid: validation.valid,
          repairs: validation.repairs.length,
          remainingIssues: validation.remainingIssues.length,
        });
      } catch (err) {
        debugLog.warn('dashboard', 'Add-node validation failed (non-blocking)', { error: String(err) });
      }

      // Save (after any repairs were applied)
      await atomicWriteFile(found.path, JSON.stringify(comp, null, 2));
      found.composition = comp;
      debugLog.info('dashboard', `Added node "${nodeId}" to composition "${compId}"`, {
        afterNodeId,
        description: description.trim().slice(0, 100),
      });

      const response: AddNodeResponse = {
        success: true,
        composition: comp,
        newNodeId: nodeId,
        path: found.path,
        validation,
      };
      sendJson(res, 200, response);
    } catch (err) {
      debugLog.error('dashboard', 'Add node failed', { error: String(err) });
      sendJson(res, 500, { error: `Add node failed: ${(err as Error).message}` });
    }
    return true;
  }

  return false;
};
