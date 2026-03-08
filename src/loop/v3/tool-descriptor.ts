/**
 * ToolDescriptor — Rich tool metadata with running execution statistics.
 *
 * Provides category classification, capability documentation, failure mode tracking,
 * and running averages for latency/reliability/cost per tool.
 */

import type { ToolRegistryV2 } from '../v2/tools/registry-v2.js';

// ── Types ───────────────────────────────────────────────────

export type ToolCategory = 'api' | 'browser' | 'code' | 'search' | 'file' | 'database';

export interface ToolDescriptor {
  name: string;
  category: ToolCategory;
  capabilities: string[];
  inputSchema: object;
  outputSchema: object;
  preconditions: string[];
  postconditions: string[];
  commonFailureModes: string[];
  validationMethods: string[];
  avgLatencyMs: number;
  avgReliability: number;
  avgCost: number;
  safeForAutonomousUse: boolean;
}

// ── Category map ────────────────────────────────────────────

const CATEGORY_MAP: Record<string, ToolCategory> = {
  file_read: 'file',
  file_write: 'file',
  list_directory: 'file',
  create_directory: 'file',
  move_file: 'file',
  shell_execute: 'code',
  test_runner: 'code',
  git: 'code',
  grep: 'search',
  web_fetch: 'api',
  web_search: 'search',
  browser_navigate: 'browser',
  browser_screenshot: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  database_query: 'database',
};

const DEFAULT_FAILURE_MODES: Record<ToolCategory, string[]> = {
  file: ['ENOENT (file not found)', 'EACCES (permission denied)', 'ENOSPC (no space left)'],
  code: ['Non-zero exit code', 'Timeout', 'Syntax error', 'Missing dependency'],
  search: ['No results found', 'Pattern syntax error', 'Timeout'],
  api: ['Network timeout', '4xx client error', '5xx server error', 'Rate limit (429)'],
  browser: ['Element not found', 'Navigation timeout', 'Page crash'],
  database: ['Connection refused', 'Query syntax error', 'Constraint violation'],
};

const DEFAULT_VALIDATION_METHODS: Record<ToolCategory, string[]> = {
  file: ['Check file exists', 'Verify file contents'],
  code: ['Check exit code', 'Parse output', 'Run tests'],
  search: ['Verify results non-empty', 'Check relevance'],
  api: ['Check HTTP status', 'Validate response schema'],
  browser: ['Take screenshot', 'Check DOM state'],
  database: ['Verify row count', 'Check constraints'],
};

// ── Registry ────────────────────────────────────────────────

interface RunningStats {
  totalExecutions: number;
  totalDurationMs: number;
  successCount: number;
}

export class ToolDescriptorRegistry {
  private descriptors: Map<string, ToolDescriptor> = new Map();
  private stats: Map<string, RunningStats> = new Map();

  /**
   * Auto-populate descriptors from a ToolRegistryV2.
   */
  buildFromRegistry(registry: ToolRegistryV2): void {
    const toolNames = registry.getToolNames();
    for (const name of toolNames) {
      const tool = registry.get(name);
      if (!tool) continue;

      const category = CATEGORY_MAP[name] || 'code';
      const def = registry.getAllDefinitions().find(d => d.name === name);

      this.descriptors.set(name, {
        name,
        category,
        capabilities: [tool.definition?.description || `Execute ${name}`],
        inputSchema: def?.input_schema || {},
        outputSchema: {},
        preconditions: [],
        postconditions: [],
        commonFailureModes: DEFAULT_FAILURE_MODES[category] || [],
        validationMethods: DEFAULT_VALIDATION_METHODS[category] || [],
        avgLatencyMs: 0,
        avgReliability: 1.0,
        avgCost: 0,
        safeForAutonomousUse: !tool.dangerous,
      });
    }
  }

  /**
   * Get a descriptor by tool name.
   */
  get(name: string): ToolDescriptor | undefined {
    return this.descriptors.get(name);
  }

  /**
   * Get all descriptors.
   */
  getAll(): ToolDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  /**
   * Record an execution to update running averages.
   */
  recordExecution(name: string, durationMs: number, success: boolean): void {
    // Update running stats
    let s = this.stats.get(name);
    if (!s) {
      s = { totalExecutions: 0, totalDurationMs: 0, successCount: 0 };
      this.stats.set(name, s);
    }
    s.totalExecutions++;
    s.totalDurationMs += durationMs;
    if (success) s.successCount++;

    // Update descriptor averages
    const desc = this.descriptors.get(name);
    if (desc) {
      desc.avgLatencyMs = s.totalDurationMs / s.totalExecutions;
      desc.avgReliability = s.successCount / s.totalExecutions;
    }
  }

  /**
   * Register a descriptor manually (for tools not in the registry).
   */
  register(descriptor: ToolDescriptor): void {
    this.descriptors.set(descriptor.name, descriptor);
  }
}
