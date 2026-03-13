import type { NativeToolDefinition } from '../v2/types/tool-types.js';
import type { SkillDefinition, SkillSelection, SkillPolicy } from './types.js';
import type { MemoryStore } from './memory-store.js';
import type { SkillPolicyStore } from './skill-policy-store.js';

interface SkillDescriptor extends SkillDefinition {
  keywords: string[];
  exactTools: string[];
  toolPrefixes?: string[];
  excludedTools?: string[];
  fallbackTools?: string[];
  maxTools?: number;
}

export interface SkillExecutionPlan extends SkillSelection {
  allowedTools: NativeToolDefinition[];
}

interface RankedSkill {
  skill: SkillDescriptor;
  matchedKeywords: string[];
  reason?: string;
}

const DEFAULT_MAX_TOOLS = 18;

const DEFAULT_SKILLS: SkillDescriptor[] = [
  {
    name: 'pipeline_design',
    description: 'Turns pipeline intent into an explicit graph plan, node responsibilities, and interface contract.',
    whenToUse: 'Use before generation when the task is defining a reusable pipeline structure, data flow, or node contract.',
    promptGuidance: 'Translate user intent into a concrete graph plan. Define stages, responsibilities, inputs, outputs, and failure boundaries before generation. When one user-provided value should feed multiple nodes, plan a single __variable__ node with variableNode.exposeAsInput=true and a stable inputName, then fan its value output out to the consumers instead of repeating the same external input on each node. Do not claim a pipeline exists yet.',
    preferredSubagent: 'plan',
    completionContract: 'Return the planned stages, node responsibilities, and interface contract that generation must follow.',
    keywords: ['pipeline design', 'workflow design', 'graph plan', 'node responsibilities', 'interface contract', 'design pipeline', 'design workflow', 'composition plan', 'data flow'],
    exactTools: ['memory_recall', 'goal_contract', 'reflect', 'file_read', 'file_search', 'grep', 'list_directory'],
    fallbackTools: ['web_fetch'],
    maxTools: 10,
    policy: {
      hardBannedTools: ['file_write', 'shell_execute', 'code_execute', 'workflow_execute', 'workflow_play'],
      defaultRecoveryHints: ['If the desired pipeline structure is unclear, refine the graph contract before moving to generation.'],
    },
  },
  {
    name: 'pipeline_generate',
    description: 'Calls the MCP intelligence generator with tight constraints to produce the initial saved composition.',
    whenToUse: 'Use once the pipeline design is clear and you need a real saved pipeline or workflow artifact.',
    promptGuidance: 'Call the intelligence generation tools with the approved design contract and tight constraints. Require a real saved composition result; do not substitute one-off execution. Prefer __variable__ nodes for shared pipeline-form inputs: if the same semantic input is needed by multiple nodes, expose it once with variableNode.exposeAsInput=true, set inputName/description/required/generationPrompt as needed, and connect that variable value downstream.',
    preferredSubagent: 'execute',
    completionContract: 'Return the generated composition artifact, including its saved id or equivalent creation result.',
    keywords: ['generate pipeline', 'generate workflow', 'initial composition', 'saved pipeline', 'saved workflow', 'compose tools'],
    exactTools: ['memory_recall', 'goal_contract', 'reflect'],
    toolPrefixes: ['mcp__intelligence__'],
    excludedTools: ['workflow_execute', 'workflow_play'],
    fallbackTools: ['web_fetch'],
    maxTools: 12,
    policy: {
      hardBannedTools: ['file_write', 'shell_execute', 'code_execute', 'workflow_execute', 'workflow_play'],
      escalationPhrases: ['escalate', 'override', 'bypass the pipeline tools', 'edit the files directly', 'direct file mutation'],
      defaultRecoveryHints: ['If generation fails, retry the intelligence generator with tighter constraints instead of switching to manual file creation.'],
    },
  },
  {
    name: 'pipeline_validate_and_repair',
    description: 'Validates generated compositions, rejects malformed nodes, and drives repair before success is claimed.',
    whenToUse: 'Use after initial generation to parse-check script nodes, verify edges and ports, and repair malformed pipeline artifacts.',
    promptGuidance: 'Inspect the generated composition, parse-check embedded code, verify wiring, and reject malformed code blobs. Normalize repeated external inputs into a single exposed __variable__ node whenever the same user value is repeated across multiple consumers. Prefer regenerating or repairing through intelligence tools over manual file edits unless the user explicitly escalates.',
    preferredSubagent: 'execute',
    completionContract: 'Return the validation findings and either a repaired composition artifact or an explicit blocker.',
    keywords: ['validate pipeline', 'repair pipeline', 'parse-check', 'port mismatch', 'edge mismatch', 'malformed code blob', 'repair composition'],
    exactTools: ['memory_recall', 'reflect', 'file_read', 'file_search', 'grep', 'list_directory', 'code_execute'],
    toolPrefixes: ['mcp__intelligence__'],
    excludedTools: ['workflow_execute', 'workflow_play'],
    fallbackTools: ['goal_contract'],
    maxTools: 14,
    policy: {
      hardBannedTools: ['file_write', 'shell_execute', 'workflow_execute', 'workflow_play'],
      defaultRecoveryHints: ['Do not accept a generated composition until script nodes parse and the graph wiring is internally consistent.'],
    },
  },
  {
    name: 'pipeline_verify',
    description: 'Confirms a saved composition is discoverable and performs the lightest viable executable smoke test.',
    whenToUse: 'Use after validation to confirm the artifact is visible in the dashboard and can be exercised with sample inputs or another concrete execution check.',
    promptGuidance: 'Verify the saved artifact with concrete evidence. Confirm discoverability through composition discovery or dashboard APIs, and run the lightest viable smoke test available. If a live run is not possible, say exactly what was and was not verified.',
    preferredSubagent: 'execute',
    completionContract: 'Return the verification evidence for discoverability and executability, including any remaining gaps.',
    keywords: ['verify pipeline', 'smoke test pipeline', 'sample inputs', 'dashboard visibility', 'discoverable composition', 'verify workflow artifact'],
    exactTools: ['memory_recall', 'reflect', 'file_read', 'file_search', 'grep', 'list_directory', 'code_execute', 'shell_execute', 'web_fetch'],
    fallbackTools: ['goal_contract'],
    maxTools: 14,
    policy: {
      hardBannedTools: ['file_write'],
      escalationPhrases: ['escalate', 'override', 'edit while verifying'],
      defaultRecoveryHints: ['If smoke verification is incomplete, report the missing execution evidence instead of declaring the pipeline done.'],
    },
  },
  {
    name: 'workflow_or_pipeline_build',
    description: 'Legacy fallback for Woodbury pipelines and workflow automations when no explicit lifecycle stage is available.',
    whenToUse: 'Use as a compatibility fallback for generic pipeline requests. Prefer the dedicated pipeline_design, pipeline_generate, pipeline_validate_and_repair, and pipeline_verify skills when the planner provides them.',
    promptGuidance: 'Prefer the dedicated pipeline lifecycle skills. If you land here, keep using intelligence or workflow composition tools rather than ad-hoc file edits, and do not fall back to one-off execution when the user asked for a reusable pipeline.',
    preferredSubagent: 'plan',
    completionContract: 'Return the created or updated workflow/pipeline and explain what each stage does.',
    keywords: ['pipeline', 'workflow', 'automation', 'automate', 'compose', 'composition', 'node', 'orchestrate', 'schedule', 'generate pipeline'],
    exactTools: ['memory_recall', 'goal_contract', 'reflect'],
    toolPrefixes: ['mcp__intelligence__'],
    excludedTools: ['file_write', 'shell_execute', 'code_execute'],
    fallbackTools: ['web_fetch'],
    maxTools: 12,
    policy: {
      hardBannedTools: ['file_write', 'shell_execute', 'code_execute'],
      escalationPhrases: ['escalate', 'override', 'bypass the pipeline tools', 'edit the files directly', 'direct file mutation'],
      defaultRecoveryHints: ['If composition tools fail, keep using workflow/intelligence tools or escalate explicitly before editing files directly.'],
    },
  },
  {
    name: 'browser_automation',
    description: 'Operates browsers, pages, UI elements, and screenshots.',
    whenToUse: 'Use for navigation, clicks, screenshots, DOM inspection, visual checks, or browser-driven automation.',
    promptGuidance: 'Stay grounded in live page state. Inspect before acting and verify visible outcomes after each browser action.',
    preferredSubagent: 'execute',
    completionContract: 'Summarize what was observed or changed in the browser and call out any blockers.',
    keywords: ['browser', 'page', 'click', 'navigate', 'dom', 'screenshot', 'screen', 'website', 'ui element', 'tab'],
    exactTools: ['browser_query', 'browser', 'screenshot', 'vision_analyze', 'mouse', 'keyboard', 'file_dialog'],
    fallbackTools: ['web_fetch'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: ['If the page state is ambiguous, inspect again before taking another browser action.'],
    },
  },
  {
    name: 'web_research',
    description: 'Researches external information across the web and documents.',
    whenToUse: 'Use for web search, crawling, fetching pages, APIs, or extracting data from documents.',
    promptGuidance: 'Gather evidence before concluding. Prefer direct sources and summarize findings rather than dumping raw pages.',
    preferredSubagent: 'explore',
    completionContract: 'Return the key findings and their sources.',
    keywords: ['research', 'search', 'find', 'look up', 'what is', 'who is', 'docs', 'documentation', 'api', 'http', 'url', 'pdf', 'crawl', 'scrape'],
    exactTools: ['web_fetch', 'google_search', 'duckduckgo_search', 'searxng_search', 'api_search', 'web_crawl', 'web_crawl_rendered', 'web_scrape', 'json_extract', 'pdf_read', 'pdf_extract'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: ['Prefer additional evidence gathering over speculative conclusions when sources conflict.'],
    },
  },
  {
    name: 'dashboard_or_ui_change',
    description: 'Edits Woodbury dashboard, frontend, and UI behavior.',
    whenToUse: 'Use for dashboard routes, config-dashboard UI, styling, rendering, interaction flows, or frontend bugs.',
    promptGuidance: 'Preserve the existing visual language unless the task calls for redesign. Validate the UI behavior after code changes.',
    preferredSubagent: 'execute',
    completionContract: 'Describe the UI change and how it was verified.',
    keywords: ['dashboard', 'ui', 'frontend', 'css', 'style', 'render', 'panel', 'sse', 'chat', 'layout', 'html'],
    exactTools: ['file_read', 'file_write', 'list_directory', 'file_search', 'grep', 'shell_execute', 'code_execute', 'git', 'test_run', 'delegate'],
    toolPrefixes: ['mcp__claude-code__', 'mcp__codex__'],
    fallbackTools: ['memory_recall'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: ['After UI edits, verify the rendered behavior instead of assuming the change is correct from code alone.'],
    },
  },
  {
    name: 'script_node_generation',
    description: 'Generates, validates, and repairs JavaScript for Woodbury script nodes using a constrained toolset.',
    whenToUse: 'Use for script-node code generation, prompt-to-code conversion, JSDoc port contracts, execute(inputs, context) implementations, or repairing generated script-node code.',
    promptGuidance: 'Treat the task as constrained script generation, not general repository editing. Use graph context and sample data when provided. Produce valid, deterministic, unit-testable script-node JavaScript with @input/@output annotations and async function execute(inputs, context). Prefer reasoning and in-memory validation tools like code_execute, goal_contract, and reflect. Keep side effects isolated and do not inspect the filesystem, write files, or use shell commands.',
    preferredSubagent: 'execute',
    completionContract: 'Return valid script-node code, its inferred input/output contract, and any validation or repair notes needed to trust the result.',
    keywords: ['script node', 'generate script', 'script generation', 'pipeline script', '@input', '@output', 'execute(inputs, context)', 'jsdoc ports', 'repair generated code'],
    exactTools: ['memory_recall', 'goal_contract', 'reflect', 'code_execute'],
    fallbackTools: ['test_run'],
    maxTools: 6,
    policy: {
      hardBannedTools: ['file_write', 'shell_execute', 'git', 'workflow_execute', 'workflow_play'],
      defaultRecoveryHints: ['If the generated script is malformed, validate the code contract and repair the code instead of editing unrelated files.'],
    },
  },
  {
    name: 'woodbury_builtin_concepts',
    description: 'Explains and traces Woodbury-native concepts like assets, collections, storyboards, built-in pipeline nodes, and their CRUD/runtime contracts.',
    whenToUse: 'Use when the task is about how Woodbury built-ins behave: asset and collection CRUD, storyboard media import/export, built-in node semantics, script-node runtime APIs like progress reporting, composition storage, or dashboard API contracts.',
    promptGuidance: 'Treat Woodbury built-ins as product contracts, not generic code. Trace the relevant route handlers, dashboard UI modules, workflow/composition storage, and runtime node executors before proposing changes. Prefer explaining where data is stored, which APIs own it, and how built-in node config maps to runtime behavior. For asset collection changes, explicitly distinguish dashboard API behavior from the creator-assets runtime extension: dashboard asset updates can replace the full collections array, while runtime asset tools may expose append, remove, or move semantics separately. In the installed creator-assets runtime, duplicate `asset_collection_create` calls are idempotent and return the existing collection as success, `asset_save` returns the created identifier under `result.asset.id`, and `asset_update({ collection })` promotes the target collection to primary and physically relocates the current file: into that collection root when `rootPath` exists, otherwise into a collection-scoped folder inside the library. For collection-root assets, verify how the primary collection affects absolute path resolution before claiming an update is a safe move. For script nodes, treat `context.progress.start/set/increment/complete` as the supported runtime contract for driving node progress bars during long-running loops, and verify how `stepsCompleted`, `stepsTotal`, and `currentStep` are projected into the execution UI before describing behavior.',
    preferredSubagent: 'explore',
    completionContract: 'Return the concrete Woodbury concept behavior, the owning files and APIs, and any contract mismatch or next handoff needed for implementation.',
    keywords: ['woodbury asset', 'asset crud', 'asset collection', 'collections crud', 'collection slug', 'creator-assets', 'assets.json', 'collections.json', 'storyboard asset', 'built-in node', '__asset__', '__text__', '__file_op__', '__json_keys__', 'composition storage', 'dashboard api contract', 'move asset collection', 'move_to_collection', 'replace collections', 'asset save result id', 'asset_collection_create idempotent', 'collection root move', 'collection scoped folder move', 'asset update physical move', 'context.progress', 'script progress', 'progress bar', 'script node progress', 'loop progress'],
    exactTools: ['memory_recall', 'goal_contract', 'reflect', 'file_read', 'file_search', 'grep', 'list_directory', 'code_execute'],
    fallbackTools: ['web_fetch', 'delegate'],
    maxTools: 12,
    policy: {
      hardBannedTools: ['file_write'],
      escalationPhrases: ['escalate', 'override', 'switch to editing'],
      defaultRecoveryHints: ['If the issue involves built-in Woodbury behavior, trace the owning route/UI/runtime contract before changing code.'],
    },
  },
  {
    name: 'code_change',
    description: 'Explores and modifies source code, scripts, and tests.',
    whenToUse: 'Use for implementation, refactoring, debugging, code review follow-up, or repository-local engineering work.',
    promptGuidance: 'Inspect the relevant code first, then make the minimal coherent change and verify it with tests or build steps when available.',
    preferredSubagent: 'execute',
    completionContract: 'Report the code changes, validation run, and any remaining risks.',
    keywords: ['code', 'implement', 'build', 'fix', 'debug', 'refactor', 'function', 'class', 'typescript', 'javascript', 'test', 'bug'],
    exactTools: ['file_read', 'file_write', 'list_directory', 'file_search', 'grep', 'shell_execute', 'code_execute', 'git', 'test_run', 'preflight_check', 'delegate'],
    toolPrefixes: ['mcp__claude-code__', 'mcp__codex__'],
    fallbackTools: ['memory_recall'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: ['If a code change is uncertain, gather more repository context before broad edits.'],
    },
  },
  {
    name: 'test_and_verify',
    description: 'Runs tests, readbacks, and validation steps to confirm earlier work.',
    whenToUse: 'Use after implementation work, for regressions, verification steps, builds, or explicit testing requests.',
    promptGuidance: 'Prefer verification and readback over additional edits. Report concrete evidence from tests, builds, or validators.',
    preferredSubagent: 'execute',
    completionContract: 'Return what was verified, what failed, and whether the task is actually complete.',
    keywords: ['test', 'verify', 'validation', 'build', 'check', 'assert', 'jest', 'vitest', 'compile', 'confirm'],
    exactTools: ['file_read', 'grep', 'test_run', 'shell_execute', 'code_execute', 'git'],
    fallbackTools: ['memory_recall'],
    policy: {
      hardBannedTools: ['file_write'],
      escalationPhrases: ['escalate', 'override', 'edit while verifying'],
      defaultRecoveryHints: ['If verification fails, report the failing evidence before switching back to editing.'],
    },
  },
  {
    name: 'extension_or_mcp_integration',
    description: 'Works on extensions, MCP servers, and tool integration boundaries.',
    whenToUse: 'Use for extension manifests, MCP configuration, tool registration, provider wiring, or integration debugging.',
    promptGuidance: 'Treat integration seams as contracts. Check registration, discovery, and runtime connection flow before changing behavior.',
    preferredSubagent: 'plan',
    completionContract: 'Explain the integration path that was changed and how the contract was verified.',
    keywords: ['extension', 'mcp', 'tool registry', 'provider', 'tooling', 'integration', 'server', 'manifest'],
    exactTools: ['file_read', 'file_write', 'list_directory', 'file_search', 'grep', 'shell_execute', 'code_execute', 'git', 'delegate'],
    toolPrefixes: ['mcp__claude-code__', 'mcp__codex__'],
    fallbackTools: ['memory_recall', 'web_fetch'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: ['Treat tool registration and provider wiring as contracts; verify discovery paths before retrying.'],
    },
  },
  {
    name: 'repo_explore',
    description: 'Explores the repository and gathers codebase context without making changes.',
    whenToUse: 'Use for architecture questions, code reading, dependency tracing, or locating relevant files and symbols.',
    promptGuidance: 'Favor inspection and synthesis. Build a concrete picture of the code before proposing changes.',
    preferredSubagent: 'explore',
    completionContract: 'Return the relevant files, behaviors, and constraints discovered.',
    keywords: ['where', 'which file', 'understand', 'explore', 'trace', 'architecture', 'how does', 'inspect'],
    exactTools: ['file_read', 'list_directory', 'file_search', 'grep', 'git', 'web_fetch', 'memory_recall'],
    fallbackTools: ['delegate'],
    maxTools: 10,
    policy: {
      hardBannedTools: ['file_write'],
      escalationPhrases: ['escalate', 'override', 'switch to editing'],
      defaultRecoveryHints: ['If the repository picture is incomplete, keep exploring rather than editing prematurely.'],
    },
  },
  {
    name: 'general_execution',
    description: 'Handles mixed work when no more specific skill clearly applies.',
    whenToUse: 'Use as a fallback for broad requests that do not strongly map to another skill.',
    promptGuidance: 'Start by clarifying the task through inspection, then narrow the toolset through the immediate evidence you gather.',
    preferredSubagent: 'execute',
    completionContract: 'Summarize what was done and any follow-up needed.',
    keywords: [],
    exactTools: ['file_read', 'file_write', 'list_directory', 'file_search', 'grep', 'shell_execute', 'code_execute', 'web_fetch', 'git'],
    fallbackTools: ['test_run', 'memory_recall', 'delegate'],
    policy: {
      hardBannedTools: [],
      defaultRecoveryHints: [],
    },
  },
];

function normalize(text: string): string {
  return text.toLowerCase();
}

function tokenize(text: string): string[] {
  return Array.from(new Set(
    normalize(text)
      .split(/[^a-z0-9_]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3),
  ));
}

function safeIncludes(text: string, keyword: string): boolean {
  return normalize(text).includes(normalize(keyword));
}

function pushTool(target: NativeToolDefinition[], seen: Set<string>, tool: NativeToolDefinition | undefined): void {
  if (!tool || seen.has(tool.name)) return;
  seen.add(tool.name);
  target.push(tool);
}

export class SkillRegistry {
  constructor(
    private readonly memoryStore?: MemoryStore,
    private readonly policyStore?: SkillPolicyStore,
    private readonly skills: SkillDescriptor[] = DEFAULT_SKILLS,
  ) {}

  getAll(): SkillDefinition[] {
    return this.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      promptGuidance: skill.promptGuidance,
      preferredSubagent: skill.preferredSubagent,
      completionContract: skill.completionContract,
    }));
  }

  getByName(name: string): SkillDefinition | undefined {
    const skill = this.skills.find(candidate => candidate.name === name);
    if (!skill) return undefined;
    return this.createDefinition(skill, []);
  }

  select(
    allTools: NativeToolDefinition[],
    userMessage: string,
    taskDescription = '',
    preferredSkillName?: string,
    previousSelection?: SkillSelection | null,
  ): SkillExecutionPlan {
    const context = `${userMessage}\n${taskDescription}`.trim();
    const tokens = tokenize(context);
    const escalationActive = this.isEscalationRequested(context);

    const winner: RankedSkill = preferredSkillName
      ? this.findPreferredSkill(preferredSkillName, context)
      : this.findRankedSkill(context);

    const learned = this.getLearnedSkillHints(winner.skill.name, context);
    const allowedTools = this.buildAllowedTools(winner.skill, allTools, context, tokens, escalationActive, learned.policyExclusions);
    const policy = winner.skill.policy || { hardBannedTools: [] };
    const reason = preferredSkillName
      ? `Planner assigned ${winner.skill.name}${winner.reason ? `: ${winner.reason}` : ''}`
      : winner.matchedKeywords.length > 0
        ? `Matched ${winner.matchedKeywords.slice(0, 4).join(', ')} against ${winner.skill.name}.`
        : `No strong specialty match found, so ${winner.skill.name} is the fallback skill.`;

    return {
      skill: this.createDefinition(winner.skill, learned.recoveryHints),
      reason,
      matchedKeywords: winner.matchedKeywords,
      allowedToolNames: allowedTools.map(tool => tool.name),
      hardBannedToolNames: policy.hardBannedTools,
      escalationActive,
      recoveryHints: learned.recoveryHints,
      previousSkillName: previousSelection?.skill?.name,
      previousSkillReason: previousSelection?.reason,
      handoffRationale: preferredSkillName && previousSelection?.skill?.name !== winner.skill.name
        ? winner.reason
        : undefined,
      allowedTools,
    };
  }

  suggestAlternateSkills(skillName: string, taskDescription: string): string[] {
    const lower = taskDescription.toLowerCase();
    const suggestions = new Set<string>();

    if (skillName === 'repo_explore') {
      suggestions.add(/test|verify|build|compile|check/.test(lower) ? 'test_and_verify' : 'code_change');
    } else if (skillName === 'woodbury_builtin_concepts') {
      suggestions.add(/fix|implement|update|patch|change/.test(lower) ? 'code_change' : 'repo_explore');
      suggestions.add('test_and_verify');
    } else if (skillName === 'script_node_generation') {
      suggestions.add('test_and_verify');
      suggestions.add('code_change');
    } else if (skillName === 'code_change') {
      suggestions.add(/test|verify|build|compile|check/.test(lower) ? 'test_and_verify' : 'repo_explore');
    } else if (skillName === 'test_and_verify') {
      suggestions.add(/browser|page|screenshot|dom/.test(lower) ? 'browser_automation' : 'repo_explore');
    } else if (skillName === 'pipeline_design') {
      suggestions.add('pipeline_generate');
    } else if (skillName === 'pipeline_generate') {
      suggestions.add('pipeline_validate_and_repair');
    } else if (skillName === 'pipeline_validate_and_repair') {
      suggestions.add('pipeline_verify');
      suggestions.add('pipeline_generate');
    } else if (skillName === 'pipeline_verify') {
      suggestions.add('pipeline_validate_and_repair');
    } else if (skillName === 'workflow_or_pipeline_build') {
      suggestions.add('pipeline_design');
    } else if (skillName === 'browser_automation') {
      suggestions.add('repo_explore');
    } else if (skillName === 'web_research') {
      suggestions.add('repo_explore');
    }

    if (/test|verify|build|compile|check/.test(lower)) suggestions.add('test_and_verify');
    if (/implement|fix|refactor|edit|change|update|write|code/.test(lower)) suggestions.add('code_change');
    if (/explore|inspect|trace|understand|investigate/.test(lower)) suggestions.add('repo_explore');

    suggestions.delete(skillName);
    return [...suggestions];
  }

  isToolHardBanned(skillName: string, toolName: string, context: string): boolean {
    const skill = this.skills.find(candidate => candidate.name === skillName);
    if (!skill?.policy?.hardBannedTools?.includes(toolName)) return false;
    return !this.isEscalationRequested(context, skill.policy);
  }

  private createDefinition(skill: SkillDescriptor, recoveryHints: string[]): SkillDefinition {
    const hintText = recoveryHints.length > 0
      ? ` Learned recovery hints: ${recoveryHints.slice(0, 3).join(' ')}`
      : '';
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      promptGuidance: `${skill.promptGuidance}${hintText}`.trim(),
      preferredSubagent: skill.preferredSubagent,
      completionContract: skill.completionContract,
      policy: skill.policy,
    };
  }

  private findPreferredSkill(name: string, context: string): RankedSkill {
    const skill = this.skills.find(candidate => candidate.name === name) || this.skills.find(candidate => candidate.name === 'general_execution')!;
    const matchedKeywords = skill.keywords.filter(keyword => safeIncludes(context, keyword));
    return { skill, matchedKeywords, reason: skill.name === name ? undefined : `preferred skill ${name} was unavailable, fell back to ${skill.name}` };
  }

  private findRankedSkill(context: string): RankedSkill {
    const ranked = this.skills.map(skill => this.scoreSkill(skill, context));
    ranked.sort((left, right) => right.score - left.score);
    return ranked[0]?.score > 0
      ? ranked[0]
      : { skill: this.skills.find(skill => skill.name === 'general_execution')!, matchedKeywords: [] };
  }

  private scoreSkill(skill: SkillDescriptor, context: string): { skill: SkillDescriptor; score: number; matchedKeywords: string[] } {
    const matchedKeywords = skill.keywords.filter(keyword => safeIncludes(context, keyword));
    let score = matchedKeywords.length * 3;
    const learned = this.getLearnedSkillHints(skill.name, context);
    score += learned.applicabilityBoost;

    if (skill.name === 'workflow_or_pipeline_build' && /pipeline|workflow|automation|compose|orchestrate/.test(normalize(context))) score += 5;
    if (skill.name === 'woodbury_builtin_concepts' && /asset|collection|storyboard|creator-assets|assets\.json|collections\.json|__asset__|built-in node|dashboard api|composition storage|context\.progress|progress bar|script node progress|loop progress/.test(normalize(context))) score += 7;
    if (skill.name === 'script_node_generation' && /script node|generate script|pipeline script|@input|@output|execute\(inputs, context\)|jsdoc/.test(normalize(context))) score += 6;
    if (skill.name === 'browser_automation' && /browser|click|dom|page|screenshot|screen/.test(normalize(context))) score += 5;
    if (skill.name === 'dashboard_or_ui_change' && /dashboard|ui|frontend|css|panel|layout|chat/.test(normalize(context))) score += 5;
    if (skill.name === 'extension_or_mcp_integration' && /\bmcp\b|extension|provider|tool registry|manifest/.test(normalize(context))) score += 5;
    if (skill.name === 'code_change' && /implement|fix|refactor|debug|test|code|typescript|javascript/.test(normalize(context))) score += 4;
    if (skill.name === 'test_and_verify' && /test|verify|validation|build|compile|assert|check/.test(normalize(context))) score += 5;
    if (skill.name === 'repo_explore' && /how does|where is|trace|understand|architecture|inspect/.test(normalize(context))) score += 4;

    return { skill, score, matchedKeywords };
  }

  private buildAllowedTools(
    skill: SkillDescriptor,
    allTools: NativeToolDefinition[],
    context: string,
    tokens: string[],
    escalationActive: boolean,
    learnedPolicyExclusions: string[],
    inheritedHardBans: string[] = [],
  ): NativeToolDefinition[] {
    const toolMap = new Map(allTools.map(tool => [tool.name, tool]));
    const effectiveHardBans = [
      ...inheritedHardBans,
      ...((!escalationActive ? (skill.policy?.hardBannedTools || []) : [])),
    ];
    const excluded = new Set([
      ...(skill.excludedTools || []),
      ...learnedPolicyExclusions,
      ...effectiveHardBans,
    ]);
    const selected: NativeToolDefinition[] = [];
    const seen = new Set<string>();

    for (const name of skill.exactTools) {
      if (excluded.has(name)) continue;
      pushTool(selected, seen, toolMap.get(name));
    }

    if (escalationActive) {
      for (const name of skill.policy?.hardBannedTools || []) {
        pushTool(selected, seen, toolMap.get(name));
      }
    }

    for (const prefix of skill.toolPrefixes || []) {
      const prefixMatches = allTools.filter(tool => tool.name.startsWith(prefix) && !excluded.has(tool.name));
      for (const tool of prefixMatches) {
        pushTool(selected, seen, tool);
      }
    }

    const dynamicMatches = allTools.filter(tool => {
      if (seen.has(tool.name) || excluded.has(tool.name)) return false;
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      return tokens.some(token => haystack.includes(token));
    });

    for (const tool of dynamicMatches) {
      pushTool(selected, seen, tool);
    }

    for (const name of skill.fallbackTools || []) {
      if (excluded.has(name)) continue;
      pushTool(selected, seen, toolMap.get(name));
    }

    const capped = selected.slice(0, skill.maxTools || DEFAULT_MAX_TOOLS);

    if (capped.length > 0) {
      return capped;
    }

    const fallback = this.skills.find(candidate => candidate.name === 'general_execution');
    if (!fallback || fallback.name === skill.name) {
      return [];
    }
    return this.buildAllowedTools(fallback, allTools, context, tokens, escalationActive, learnedPolicyExclusions, effectiveHardBans);
  }

  private getLearnedSkillHints(skillName: string, context: string): {
    applicabilityBoost: number;
    recoveryHints: string[];
    policyExclusions: string[];
  } {
    if (!this.memoryStore) {
      return { applicabilityBoost: 0, recoveryHints: [], policyExclusions: [] };
    }

    const memories = this.memoryStore.getSkillMemories(skillName);
    let applicabilityBoost = 0;
    const recoveryHints = new Set<string>();
    const policyExclusions = new Set<string>();

    for (const memory of memories) {
      const tags = new Set(memory.tags.map(tag => tag.toLowerCase()));
      if (memory.triggerPattern) {
        try {
          if (new RegExp(memory.triggerPattern, 'i').test(context)) {
            applicabilityBoost += Math.max(1, Math.round(memory.confidence * 4));
          }
        } catch {
          // Ignore invalid historic patterns.
        }
      }
      if (tags.has('recovery-hint')) {
        recoveryHints.add(memory.content);
      }
      if (tags.has('hard-ban')) {
        for (const tag of memory.tags) {
          if (tag.startsWith('tool:')) {
            policyExclusions.add(tag.slice('tool:'.length));
          }
        }
      }
    }

    const skill = this.skills.find(candidate => candidate.name === skillName);
    for (const hint of skill?.policy?.defaultRecoveryHints || []) {
      recoveryHints.add(hint);
    }

    if (this.policyStore) {
      const approvedUpdates = this.policyStore.getForSkill(skillName, 'approved');
      for (const update of approvedUpdates) {
        try {
          if (update.applicabilityPattern && new RegExp(update.applicabilityPattern, 'i').test(context)) {
            applicabilityBoost += Math.max(1, Math.round(update.confidence * 5));
          }
        } catch {
          // Ignore malformed patterns.
        }
        if (update.updateType === 'recovery_hint') {
          recoveryHints.add(update.guidance);
        }
      }
    }

    return {
      applicabilityBoost,
      recoveryHints: [...recoveryHints].slice(0, 4),
      policyExclusions: [...policyExclusions],
    };
  }

  private isEscalationRequested(context: string, policy?: SkillPolicy): boolean {
    const phrases = policy?.escalationPhrases || ['escalate', 'override', 'explicitly escalate', 'bypass', 'directly edit'];
    const lower = normalize(context);
    return phrases.some(phrase => lower.includes(phrase.toLowerCase()));
  }
}