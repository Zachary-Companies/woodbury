/**
 * Graduated Permission Model with Escalation
 *
 * Modeled after claw-code-main's 5-tier permission system:
 * - Hierarchical permission modes (ReadOnly → WorkspaceWrite → FullAccess)
 * - Per-tool permission requirements
 * - Escalation prompting (ask user to upgrade permission level)
 * - Permission audit trail via decisions log
 */

import { Logger } from './types.js';
import { PermissionDecision } from './session.js';

/**
 * Permission modes, ordered from least to most permissive.
 * Matches claw-code-main's PermissionMode enum.
 */
export enum PermissionMode {
  /** Read-only file access — no writes, no shell */
  ReadOnly = 'read_only',

  /** Read + write files in workspace — no shell execution */
  WorkspaceWrite = 'workspace_write',

  /** Full access including shell execution, git push, etc. */
  FullAccess = 'full_access',

  /** Prompt the user for every action beyond read-only */
  Prompt = 'prompt',
}

/**
 * Numeric rank for comparing permission levels
 */
const MODE_RANK: Record<PermissionMode, number> = {
  [PermissionMode.ReadOnly]: 0,
  [PermissionMode.WorkspaceWrite]: 1,
  [PermissionMode.FullAccess]: 2,
  [PermissionMode.Prompt]: -1, // special: always prompts
};

/**
 * Default per-tool permission requirements
 */
const DEFAULT_TOOL_REQUIREMENTS: Record<string, PermissionMode> = {
  // Read-only tools
  file_read: PermissionMode.ReadOnly,
  list_directory: PermissionMode.ReadOnly,
  file_search: PermissionMode.ReadOnly,
  grep: PermissionMode.ReadOnly,
  web_fetch: PermissionMode.ReadOnly,
  web_crawl: PermissionMode.ReadOnly,
  web_crawl_rendered: PermissionMode.ReadOnly,
  google_search: PermissionMode.ReadOnly,
  duckduckgo_search: PermissionMode.ReadOnly,
  searxng_search: PermissionMode.ReadOnly,
  api_search: PermissionMode.ReadOnly,
  pdf_read: PermissionMode.ReadOnly,
  memory_recall: PermissionMode.ReadOnly,
  reflect: PermissionMode.ReadOnly,
  goal_contract: PermissionMode.ReadOnly,
  preflight_check: PermissionMode.ReadOnly,
  task_get: PermissionMode.ReadOnly,
  task_list: PermissionMode.ReadOnly,
  queue_status: PermissionMode.ReadOnly,

  // Write tools
  file_write: PermissionMode.WorkspaceWrite,
  file_edit: PermissionMode.WorkspaceWrite,
  memory_save: PermissionMode.WorkspaceWrite,
  task_create: PermissionMode.WorkspaceWrite,
  task_update: PermissionMode.WorkspaceWrite,
  queue_init: PermissionMode.WorkspaceWrite,
  queue_next: PermissionMode.WorkspaceWrite,
  queue_done: PermissionMode.WorkspaceWrite,
  queue_add_items: PermissionMode.WorkspaceWrite,

  // Dangerous / full-access tools
  shell_execute: PermissionMode.FullAccess,
  code_execute: PermissionMode.FullAccess,
  git: PermissionMode.FullAccess,
  test_runner: PermissionMode.FullAccess,
  test_run: PermissionMode.FullAccess,
  database_query: PermissionMode.FullAccess,
  delegate: PermissionMode.FullAccess,
};

/**
 * Result of a permission check
 */
export type PermissionOutcome =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Callback for prompting the user to escalate permissions
 */
export type PermissionPrompter = (
  toolName: string,
  requiredLevel: PermissionMode,
  currentLevel: PermissionMode
) => Promise<{ allow: boolean; reason?: string }>;

/**
 * Permission policy — checks tool access against the active mode
 */
export class PermissionPolicy {
  private activeMode: PermissionMode;
  private toolRequirements: Map<string, PermissionMode>;
  private denyList: Set<string>;
  private denyPrefixes: string[];
  private prompter?: PermissionPrompter;
  private logger: Logger;
  private decisions: PermissionDecision[] = [];

  constructor(options: {
    mode: PermissionMode;
    toolRequirements?: Record<string, PermissionMode>;
    denyList?: string[];
    denyPrefixes?: string[];
    prompter?: PermissionPrompter;
    logger?: Logger;
  }) {
    this.activeMode = options.mode;
    this.denyList = new Set(options.denyList || []);
    this.denyPrefixes = options.denyPrefixes || [];
    this.prompter = options.prompter;
    this.logger = options.logger || console;

    // Merge default requirements with overrides
    this.toolRequirements = new Map<string, PermissionMode>();
    for (const [tool, mode] of Object.entries(DEFAULT_TOOL_REQUIREMENTS)) {
      this.toolRequirements.set(tool, mode);
    }
    if (options.toolRequirements) {
      for (const [tool, mode] of Object.entries(options.toolRequirements)) {
        this.toolRequirements.set(tool, mode);
      }
    }
  }

  /**
   * Check if a tool is allowed under the current policy
   */
  async authorize(toolName: string): Promise<PermissionOutcome> {
    // 1. Check deny-list
    if (this.denyList.has(toolName)) {
      this.recordDecision(toolName, 'full_access', 'deny', 'Tool is on deny list');
      return { allowed: false, reason: `Tool '${toolName}' is on the deny list` };
    }

    // 2. Check deny-prefixes
    for (const prefix of this.denyPrefixes) {
      if (toolName.startsWith(prefix)) {
        this.recordDecision(toolName, 'full_access', 'deny', `Blocked by prefix: ${prefix}`);
        return { allowed: false, reason: `Tool '${toolName}' blocked by deny prefix '${prefix}'` };
      }
    }

    // 3. Look up required permission for this tool
    const required = this.toolRequirements.get(toolName) || PermissionMode.FullAccess;
    const requiredRank = MODE_RANK[required];
    const activeRank = MODE_RANK[this.activeMode];

    // 4. Prompt mode — read-only tools pass silently, everything else asks.
    //    Prompt's MODE_RANK is -1, so it can never satisfy the rank check below;
    //    both of its outcomes have to be decided here or read-only tools would
    //    fall through to the deny at step 7.
    if (this.activeMode === PermissionMode.Prompt) {
      if (required === PermissionMode.ReadOnly) {
        this.recordDecision(toolName, required, 'allow');
        return { allowed: true };
      }
      return this.tryEscalate(toolName, required);
    }

    // 5. If active mode is sufficient, allow
    if (activeRank >= requiredRank) {
      this.recordDecision(toolName, required, 'allow');
      return { allowed: true };
    }

    // 6. Try escalation if a prompter is available
    if (this.prompter) {
      return this.tryEscalate(toolName, required);
    }

    // 7. Deny
    this.recordDecision(toolName, required, 'deny',
      `Requires ${required}, active mode is ${this.activeMode}`);
    return {
      allowed: false,
      reason: `Tool '${toolName}' requires '${required}' permission, but current mode is '${this.activeMode}'`,
    };
  }

  /**
   * Attempt escalation via the prompter
   */
  private async tryEscalate(
    toolName: string,
    required: PermissionMode
  ): Promise<PermissionOutcome> {
    if (!this.prompter) {
      this.recordDecision(toolName, required, 'deny', 'No prompter available for escalation');
      return {
        allowed: false,
        reason: `Tool '${toolName}' requires '${required}' but no prompter is configured for escalation`,
      };
    }

    try {
      const decision = await this.prompter(toolName, required, this.activeMode);
      if (decision.allow) {
        this.recordDecision(toolName, required, 'escalate', decision.reason || 'User approved escalation');
        this.logger.info?.(`Permission escalated for '${toolName}': ${this.activeMode} → ${required}`);
        return { allowed: true };
      } else {
        this.recordDecision(toolName, required, 'deny', decision.reason || 'User denied escalation');
        return {
          allowed: false,
          reason: decision.reason || `User denied permission escalation for '${toolName}'`,
        };
      }
    } catch (error) {
      this.recordDecision(toolName, required, 'deny', `Escalation error: ${error}`);
      return {
        allowed: false,
        reason: `Permission escalation failed for '${toolName}': ${error}`,
      };
    }
  }

  /**
   * Record a permission decision for audit trail
   */
  private recordDecision(
    toolName: string,
    required: PermissionMode | string,
    decision: 'allow' | 'deny' | 'escalate',
    reason?: string
  ): void {
    this.decisions.push({
      toolName,
      requiredLevel: String(required),
      activeLevel: this.activeMode,
      decision,
      reason,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all permission decisions (audit trail)
   */
  getDecisions(): PermissionDecision[] {
    return [...this.decisions];
  }

  /**
   * Get the active permission mode
   */
  getActiveMode(): PermissionMode {
    return this.activeMode;
  }

  /**
   * Change the active permission mode
   */
  setActiveMode(mode: PermissionMode): void {
    this.logger.info?.(`Permission mode changed: ${this.activeMode} → ${mode}`);
    this.activeMode = mode;
  }

  /**
   * Set the required permission for a specific tool
   */
  setToolRequirement(toolName: string, mode: PermissionMode): void {
    this.toolRequirements.set(toolName, mode);
  }

  /**
   * Get the required permission for a tool
   */
  getToolRequirement(toolName: string): PermissionMode {
    return this.toolRequirements.get(toolName) || PermissionMode.FullAccess;
  }

  /**
   * Add a tool to the deny list
   */
  deny(toolName: string): void {
    this.denyList.add(toolName);
  }

  /**
   * Remove a tool from the deny list
   */
  undeny(toolName: string): void {
    this.denyList.delete(toolName);
  }
}
