/**
 * Context Compaction Module
 *
 * Intelligent conversation context management that summarizes older messages
 * while preserving critical information. Modeled after claw-code-main's compact.rs
 * with both structured (rule-based) and LLM-assisted compaction modes.
 */

import { Logger } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompactionConfig {
  /** Number of recent messages to preserve verbatim (default: 6) */
  preserveRecentMessages: number;
  /** Token estimate threshold to trigger compaction (default: 100000) */
  maxEstimatedTokens: number;
  /** Whether to use LLM for summarization (default: false = structured only) */
  useLlmSummary: boolean;
}

export interface CompactionResult {
  /** The compacted message array */
  messages: ChatMessageCompat[];
  /** The generated summary text */
  summary: string;
  /** Number of messages that were removed/summarized */
  removedMessageCount: number;
  /** Token estimate before compaction */
  tokensBefore: number;
  /** Token estimate after compaction */
  tokensAfter: number;
}

export interface CompactionSummary {
  /** Total messages summarized */
  messageCount: number;
  /** Counts by role */
  roleCounts: Record<string, number>;
  /** Tool names that were used */
  toolsUsed: string[];
  /** Recent user requests (last 3) */
  recentRequests: string[];
  /** Pending/incomplete work inferred from keywords */
  pendingWork: string[];
  /** Key files referenced in the conversation */
  keyFiles: string[];
  /** Current work description */
  currentWork: string;
  /** Timeline of key events */
  timeline: string[];
  /** Previous compaction summary (if re-compacting) */
  previousSummary?: string;
}

/** Minimal chat message shape for compatibility with agent.ts */
export interface ChatMessageCompat {
  role: string;
  content: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  preserveRecentMessages: 6,
  maxEstimatedTokens: 100000,
  useLlmSummary: false,
};

const PENDING_WORK_KEYWORDS = [
  'todo', 'next', 'pending', 'follow up', 'follow-up', 'remaining',
  'not yet', 'still need', 'haven\'t', 'incomplete', 'left to do',
  'will need to', 'should also', 'don\'t forget',
];

const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'py', 'rs', 'go', 'java',
  'yaml', 'yml', 'toml', 'html', 'css', 'scss', 'sql', 'sh', 'bash',
  'tf', 'hcl', 'xml', 'env', 'lock', 'config',
]);

const MAX_SUMMARY_ITEM_LENGTH = 160;
const MAX_KEY_FILES = 10;
const MAX_RECENT_REQUESTS = 3;
const MAX_TIMELINE_ENTRIES = 30;

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Estimate the token count for a message array.
 * Uses the standard ~4 characters per token approximation.
 */
export function estimateTokens(messages: ChatMessageCompat[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 1, 0);
}

/**
 * Check whether compaction should be triggered.
 */
export function shouldCompact(
  messages: ChatMessageCompat[],
  config: Partial<CompactionConfig> = {}
): boolean {
  const cfg = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  if (messages.length <= cfg.preserveRecentMessages + 1) return false; // +1 for system prompt
  return estimateTokens(messages) > cfg.maxEstimatedTokens;
}

/**
 * Perform structured compaction on a message array.
 *
 * - Preserves the system prompt (first message)
 * - Preserves the last N messages verbatim
 * - Summarizes everything in between into a structured summary
 * - Merges with any previous compaction summary
 */
export function compactMessages(
  messages: ChatMessageCompat[],
  config: Partial<CompactionConfig> = {},
  logger?: Logger
): CompactionResult {
  const cfg = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  const tokensBefore = estimateTokens(messages);

  // Nothing to compact
  if (messages.length <= cfg.preserveRecentMessages + 1) {
    return {
      messages: [...messages],
      summary: '',
      removedMessageCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const systemPrompt = messages[0];
  const recentMessages = messages.slice(-cfg.preserveRecentMessages);
  const middleMessages = messages.slice(1, -cfg.preserveRecentMessages);

  // Extract any existing compaction summary from the messages
  const previousSummary = extractExistingCompactionSummary(middleMessages);

  // Build structured summary of the middle messages
  const summaryData = buildStructuredSummary(middleMessages, previousSummary);
  const summaryText = formatSummary(summaryData);

  // Create the continuation system message
  const continuationMessage: ChatMessageCompat = {
    role: 'user',
    content: formatContinuationMessage(summaryText, cfg.preserveRecentMessages),
  };

  const compactedMessages: ChatMessageCompat[] = [
    systemPrompt,
    continuationMessage,
    ...recentMessages,
  ];

  const tokensAfter = estimateTokens(compactedMessages);

  logger?.info?.(
    `Compaction: ${messages.length} messages → ${compactedMessages.length} ` +
    `(${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens, ` +
    `removed ${middleMessages.length} messages)`
  );

  return {
    messages: compactedMessages,
    summary: summaryText,
    removedMessageCount: middleMessages.length,
    tokensBefore,
    tokensAfter,
  };
}

// ── Summary Extraction ───────────────────────────────────────────────────────

/**
 * Build a structured summary from a set of messages.
 */
export function buildStructuredSummary(
  messages: ChatMessageCompat[],
  previousSummary?: string
): CompactionSummary {
  const roleCounts: Record<string, number> = {};
  const toolsUsed = new Set<string>();
  const recentRequests: string[] = [];
  const pendingWork: string[] = [];
  const keyFiles = new Set<string>();
  let currentWork = '';
  const timeline: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;

    // Count by role
    roleCounts[role] = (roleCounts[role] || 0) + 1;

    // Extract tool names from tool results
    const toolMatches = msg.content.match(/tool_name['":\s]+(\w+)/g);
    if (toolMatches) {
      for (const match of toolMatches) {
        const name = match.replace(/tool_name['":\s]+/, '');
        if (name) toolsUsed.add(name);
      }
    }
    // Also check for XML-style tool results
    const xmlToolMatches = msg.content.match(/<tool_result>\s*<name>(\w+)<\/name>/g);
    if (xmlToolMatches) {
      for (const match of xmlToolMatches) {
        const name = match.match(/<name>(\w+)<\/name>/)?.[1];
        if (name) toolsUsed.add(name);
      }
    }

    // Collect user requests
    if (role === 'user' && !msg.content.startsWith('<tool_result>') && !msg.content.startsWith('<context_summary>')) {
      recentRequests.push(truncate(msg.content, MAX_SUMMARY_ITEM_LENGTH));
    }

    // Infer pending work
    const lowerContent = msg.content.toLowerCase();
    for (const keyword of PENDING_WORK_KEYWORDS) {
      if (lowerContent.includes(keyword)) {
        // Extract the sentence containing the keyword
        const sentences = msg.content.split(/[.!?\n]+/);
        for (const sentence of sentences) {
          if (sentence.toLowerCase().includes(keyword) && sentence.trim().length > 10) {
            pendingWork.push(truncate(sentence.trim(), MAX_SUMMARY_ITEM_LENGTH));
            break;
          }
        }
        break;
      }
    }

    // Extract file paths
    const fileCandidates = extractFilePaths(msg.content);
    for (const file of fileCandidates) {
      if (keyFiles.size < MAX_KEY_FILES) keyFiles.add(file);
    }

    // Track current work (most recent substantive assistant or user message)
    if ((role === 'assistant' || role === 'user') && msg.content.length > 20) {
      if (!msg.content.startsWith('<tool_result>') && !msg.content.startsWith('<context_summary>')) {
        currentWork = truncate(msg.content, MAX_SUMMARY_ITEM_LENGTH);
      }
    }

    // Build timeline entry
    if (timeline.length < MAX_TIMELINE_ENTRIES) {
      const summary = truncate(msg.content, 100);
      timeline.push(`[${role}] ${summary}`);
    }
  }

  return {
    messageCount: messages.length,
    roleCounts,
    toolsUsed: [...toolsUsed],
    recentRequests: recentRequests.slice(-MAX_RECENT_REQUESTS),
    pendingWork: [...new Set(pendingWork)].slice(0, 5),
    keyFiles: [...keyFiles],
    currentWork,
    timeline,
    previousSummary,
  };
}

/**
 * Format a CompactionSummary into a readable text block.
 */
export function formatSummary(summary: CompactionSummary): string {
  const sections: string[] = [];

  // Previous compaction context
  if (summary.previousSummary) {
    sections.push(`<previously_compacted>\n${summary.previousSummary}\n</previously_compacted>`);
  }

  // Scope
  const roleBreakdown = Object.entries(summary.roleCounts)
    .map(([role, count]) => `${count} ${role}`)
    .join(', ');
  sections.push(`<scope>${summary.messageCount} messages summarized (${roleBreakdown})</scope>`);

  // Tools used
  if (summary.toolsUsed.length > 0) {
    sections.push(`<tools_used>${summary.toolsUsed.join(', ')}</tools_used>`);
  }

  // Recent user requests
  if (summary.recentRequests.length > 0) {
    const items = summary.recentRequests.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
    sections.push(`<recent_requests>\n${items}\n</recent_requests>`);
  }

  // Pending work
  if (summary.pendingWork.length > 0) {
    const items = summary.pendingWork.map(p => `  - ${p}`).join('\n');
    sections.push(`<pending_work>\n${items}\n</pending_work>`);
  }

  // Key files
  if (summary.keyFiles.length > 0) {
    sections.push(`<key_files>${summary.keyFiles.join(', ')}</key_files>`);
  }

  // Current work
  if (summary.currentWork) {
    sections.push(`<current_work>${summary.currentWork}</current_work>`);
  }

  // Timeline
  if (summary.timeline.length > 0) {
    const items = summary.timeline.join('\n  ');
    sections.push(`<timeline>\n  ${items}\n</timeline>`);
  }

  return sections.join('\n\n');
}

/**
 * Format the continuation message that replaces compacted messages.
 */
export function formatContinuationMessage(summary: string, preservedCount: number): string {
  return (
    `<context_compaction>\n` +
    `This conversation was compacted to stay within context limits.\n` +
    `The following is a structured summary of the earlier conversation.\n` +
    `The ${preservedCount} most recent messages are preserved verbatim after this summary.\n` +
    `Continue from where we left off without re-asking questions that were already answered.\n\n` +
    `${summary}\n` +
    `</context_compaction>`
  );
}

// ── Re-compaction Merging ────────────────────────────────────────────────────

/**
 * Extract any existing compaction summary from the message array.
 * This handles the case where we're re-compacting an already-compacted conversation.
 */
export function extractExistingCompactionSummary(messages: ChatMessageCompat[]): string | undefined {
  for (const msg of messages) {
    const match = msg.content.match(/<context_compaction>([\s\S]*?)<\/context_compaction>/);
    if (match) {
      // Extract just the summary content, not the preamble
      const inner = match[1];
      // Remove the preamble lines, keep the structured data
      const lines = inner.split('\n');
      const summaryStart = lines.findIndex(l =>
        l.includes('<previously_compacted>') ||
        l.includes('<scope>') ||
        l.includes('<tools_used>')
      );
      if (summaryStart >= 0) {
        return lines.slice(summaryStart).join('\n').trim();
      }
      return inner.trim();
    }
  }
  return undefined;
}

// ── Utility Functions ────────────────────────────────────────────────────────

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
export function truncate(text: string, maxLength: number): string {
  // Collapse whitespace first
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.substring(0, maxLength - 3) + '...';
}

/**
 * Extract file path candidates from text content.
 * Looks for paths with recognized extensions.
 */
export function extractFilePaths(content: string): string[] {
  const paths = new Set<string>();

  // Match paths like src/foo/bar.ts, ./config.json, /absolute/path.py
  const pathPattern = /(?:^|[\s'"(`])([./\\]?(?:[\w@.-]+[/\\])*[\w.-]+\.(\w+))/gm;
  let match;
  while ((match = pathPattern.exec(content)) !== null) {
    const filePath = match[1];
    const ext = match[2];
    if (FILE_EXTENSIONS.has(ext) && filePath.length < 200) {
      paths.add(filePath);
    }
  }

  return [...paths];
}
