/**
 * Tool Router — Select relevant tools per turn instead of sending all 90+.
 *
 * Anthropic recommends <30 tools for reliable tool_use. This router:
 * 1. Always includes a core set (~10 essential tools)
 * 2. Matches user message keywords to tool categories
 * 3. Caps at ~25 tools per turn
 */

import type { NativeToolDefinition } from '../v2/types/tool-types.js';

// ── Tool Categories ──────────────────────────────────────────

interface ToolCategory {
  /** Keywords that trigger this category (matched against user message, case-insensitive) */
  keywords: string[];
  /** Tool name prefixes or exact names in this category */
  toolNames: string[];
}

/**
 * Core tools — always included in every turn.
 * These are the essential building blocks for most tasks.
 */
const CORE_TOOLS = new Set([
  'file_read',
  'file_write',
  'list_directory',
  'file_search',
  'grep',
  'shell_execute',
  'code_execute',
  'web_fetch',
  'git',
]);

/**
 * Tool categories with keyword triggers.
 * When any keyword matches the user message, all tools in the category are included.
 */
const CATEGORIES: ToolCategory[] = [
  {
    keywords: ['search', 'find', 'look up', 'google', 'duckduckgo', 'research', 'what is', 'who is', 'how to'],
    toolNames: ['google_search', 'duckduckgo_search', 'searxng_search', 'api_search', 'web_crawl', 'web_crawl_rendered'],
  },
  {
    keywords: ['image', 'picture', 'photo', 'generate image', 'draw', 'illustration', 'visual', 'nanobanana', 'gemini'],
    toolNames: ['nanobanana', 'image_utils'],
  },
  {
    keywords: ['test', 'testing', 'jest', 'mocha', 'vitest', 'spec', 'unit test'],
    toolNames: ['test_run'],
  },
  {
    keywords: ['pdf', 'document', 'extract'],
    toolNames: ['pdf_read', 'pdf_extract'],
  },
  {
    keywords: ['database', 'sql', 'query', 'postgres', 'mysql', 'sqlite', 'mongo'],
    toolNames: ['database_query'],
  },
  {
    keywords: ['task', 'plan', 'todo', 'step', 'workflow'],
    toolNames: ['task_create', 'task_update', 'task_list', 'task_get', 'goal_contract', 'reflect'],
  },
  {
    keywords: ['queue', 'batch', 'bulk', 'mass'],
    toolNames: ['queue_init', 'queue_add_items', 'queue_next', 'queue_done', 'queue_status'],
  },
  {
    keywords: ['memory', 'remember', 'recall', 'save knowledge'],
    toolNames: ['memory_save', 'memory_recall'],
  },
  {
    keywords: ['browser', 'click', 'navigate', 'page', 'website', 'dom', 'screenshot', 'vision', 'screen'],
    toolNames: ['browser_query', 'browser', 'screenshot', 'vision_analyze', 'mouse', 'keyboard', 'file_dialog'],
  },
  {
    keywords: ['scrape', 'crawl', 'web scrape', 'extract data'],
    toolNames: ['web_scrape', 'web_crawl', 'web_crawl_rendered', 'json_extract'],
  },
  {
    keywords: ['delegate', 'subagent', 'agent'],
    toolNames: ['delegate'],
  },
  {
    keywords: ['risk', 'dangerous', 'delete', 'remove', 'preflight'],
    toolNames: ['preflight_check'],
  },
  {
    keywords: ['prompt', 'chain', 'optimize', 'llm'],
    toolNames: ['prompt_chain', 'prompt_optimize'],
  },
  {
    keywords: ['workflow', 'automate', 'play', 'run workflow'],
    toolNames: ['workflow_execute', 'workflow_play'],
  },
  {
    keywords: ['web', 'url', 'http', 'fetch', 'api', 'endpoint'],
    toolNames: ['web_fetch', 'web_crawl', 'api_search'],
  },
  {
    keywords: ['calendar', 'schedule', 'post', 'social', 'content', 'instagram', 'twitter', 'facebook', 'linkedin', 'tiktok', 'publish'],
    toolNames: [], // Extension/MCP tools — matched by prefix below
  },
  {
    keywords: [
      'pipeline', 'node', 'generate', 'compose',
      // Non-technical user phrases that imply multi-step automation
      'summarize', 'analyze', 'automate', 'set up', 'monitor',
      'fetch and', 'get me', 'check and', 'daily', 'every day',
      'morning briefing', 'report', 'digest', 'top stories',
      'and then', 'process', 'transform',
    ],
    toolNames: [], // MCP intelligence tools — matched by prefix below
  },
];

/** Maximum tools to send per turn */
const MAX_TOOLS = 25;

/**
 * Select relevant tools for a user message.
 *
 * @param allTools - Full tool registry
 * @param userMessage - The user's current message
 * @returns Subset of tools relevant to this turn
 */
export function selectTools(
  allTools: NativeToolDefinition[],
  userMessage: string,
): NativeToolDefinition[] {
  const messageLower = userMessage.toLowerCase();
  const selectedNames = new Set<string>();

  // 1. Always include core tools
  for (const name of CORE_TOOLS) {
    selectedNames.add(name);
  }

  // 2. Match categories by keywords
  for (const category of CATEGORIES) {
    const matched = category.keywords.some(kw => messageLower.includes(kw));
    if (matched) {
      for (const name of category.toolNames) {
        selectedNames.add(name);
      }
    }
  }

  // 3. Always include MCP tools that match message keywords
  //    MCP tools are prefixed: mcp__<server>__<tool>
  for (const tool of allTools) {
    if (tool.name.startsWith('mcp__')) {
      // Include MCP tools if any part of their name matches message keywords
      const toolParts = tool.name.toLowerCase().split('__');
      const relevant = toolParts.some(part =>
        messageLower.includes(part) ||
        // Also match common MCP server use cases
        (part === 'intelligence' && messageLower.match(/pipeline|generate|compose|create|workflow|explain|diagnose|summarize|analyze|automate|set up|monitor|fetch|report|digest|process|transform|stories|briefing/)) ||
        (part === 'claude-code' && messageLower.match(/code|implement|build|fix|debug|refactor/)) ||
        (part === 'codex' && messageLower.match(/code|implement|build|fix|debug/))
      );
      if (relevant) {
        selectedNames.add(tool.name);
      }
    }
  }

  // 4. Include extension tools matching message keywords
  //    Extension tools often relate to content, social media, images
  for (const tool of allTools) {
    if (!tool.name.startsWith('mcp__') && !CORE_TOOLS.has(tool.name)) {
      // Check if tool name or description matches message
      const nameMatch = messageLower.includes(tool.name.replace(/_/g, ' ')) ||
                        messageLower.includes(tool.name.replace(/_/g, ''));
      if (nameMatch) {
        selectedNames.add(tool.name);
      }
    }
  }

  // 5. Detect composition/pipeline creation — remove competing tools
  //    When intelligence tools are selected for pipeline/workflow creation,
  //    remove file_write/shell_execute/list_directory so the model MUST use
  //    the intelligence tools instead of writing files directly.
  const hasIntelligenceComposition = selectedNames.has('mcp__intelligence__generate_pipeline') ||
    selectedNames.has('mcp__intelligence__generate_workflow') ||
    selectedNames.has('mcp__intelligence__compose_tools');
  const isCompositionRequest = hasIntelligenceComposition && messageLower.match(
    /pipeline|workflow|automate|set up|compose|summarize.*and|fetch.*and|create.*that|build.*that|make.*that/
  );

  // Tools to exclude when routing to intelligence tools
  const COMPOSITION_EXCLUDED = new Set([
    'file_write', 'shell_execute', 'list_directory', 'file_search', 'grep', 'code_execute', 'git',
  ]);

  // 6. Build the final tool list, respecting max limit
  const selected: NativeToolDefinition[] = [];
  const toolMap = new Map(allTools.map(t => [t.name, t]));

  // Add core tools first (guaranteed) — but skip excluded ones for composition requests
  for (const name of CORE_TOOLS) {
    if (isCompositionRequest && COMPOSITION_EXCLUDED.has(name)) continue;
    const tool = toolMap.get(name);
    if (tool) selected.push(tool);
  }

  // Add matched tools up to limit
  for (const name of selectedNames) {
    if (CORE_TOOLS.has(name)) continue; // Already added (or excluded)
    if (isCompositionRequest && COMPOSITION_EXCLUDED.has(name)) continue;
    // For composition requests, exclude coding agent tools — only intelligence tools should be used
    if (isCompositionRequest && (name.startsWith('mcp__claude-code__') || name.startsWith('mcp__codex__'))) continue;
    if (selected.length >= MAX_TOOLS) break;
    const tool = toolMap.get(name);
    if (tool) selected.push(tool);
  }

  // 6. If very few tools matched (just core), add some general-purpose extras
  if (selected.length <= CORE_TOOLS.size + 2) {
    const extras = ['test_run', 'memory_recall', 'web_crawl', 'duckduckgo_search'];
    for (const name of extras) {
      if (selected.length >= MAX_TOOLS) break;
      if (!selectedNames.has(name)) {
        const tool = toolMap.get(name);
        if (tool) selected.push(tool);
      }
    }
  }

  console.log('[DIAG] selectTools: isCompositionRequest=' + !!isCompositionRequest + ', selected=' + selected.length + ' tools: ' + selected.map(t => t.name).join(', '));
  return selected;
}
