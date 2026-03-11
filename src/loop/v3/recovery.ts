/**
 * Recovery Engine — Typed error recovery for the Closure Engine.
 *
 * Classifies errors by pattern and determines the appropriate
 * recovery strategy: retry, alternative tool, decompose, ask user, skip, or abort.
 */

import type {
  TaskNode,
  TaskResult,
  RecoveryStrategy,
  RecoveryAttempt,
  Observation,
  MemoryRecord,
} from './types.js';
import type { StateManager } from './state-manager.js';
import type { MemoryStore } from './memory-store.js';
import type { SkillRegistry } from './skill-registry.js';
import { debugLog } from '../../debug-log.js';

/** Error category determined by pattern matching. */
type ErrorCategory =
  | 'transient'                    // timeout, rate limit, network
  | 'tool_error'                   // unknown tool, tool crash
  | 'permission'                   // EACCES, permission denied
  | 'not_found'                    // ENOENT, file not found, 404
  | 'validation'                   // bad input, schema mismatch
  | 'verification'                 // verification failed after execution
  | 'too_complex'                  // max iterations hit
  | 'ambiguous_entity_resolution'  // multiple candidate matches
  | 'missing_required_data'        // required input unavailable
  | 'contradictory_evidence'       // conflicting evidence found
  | 'plan_invalidated'             // plan assumptions no longer hold
  | 'environment_changed'          // external state changed unexpectedly
  | 'unsafe_to_continue'           // safety policy violation
  | 'unknown';

/** Alternative tool mappings — fallback tools for common operations. */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  'file_read': ['shell_execute'],     // fallback: cat via shell
  'shell_execute': ['code_execute'],  // fallback: execute code instead
  'web_fetch': ['web_crawl'],         // fallback: crawl instead
  'google_search': ['duckduckgo_search', 'searxng_search'],
  'duckduckgo_search': ['google_search', 'searxng_search'],
};

export class RecoveryEngine {
  constructor(
    private stateManager: StateManager,
    private memoryStore: MemoryStore,
    private skillRegistry?: SkillRegistry,
  ) {}

  /**
   * Determine the best recovery strategy for a failed task.
   */
  determineStrategy(task: TaskNode, result: TaskResult): RecoveryStrategy {
    const category = this.classifyError(result);
    const attempts = this.stateManager.getRecoveryAttemptsForTask(task.id);
    const attemptCount = attempts.length;

    debugLog.debug('recovery', `Error category: ${category}`, {
      taskId: task.id,
      attempts: attemptCount,
      maxRetries: task.maxRetries,
      error: result.error?.slice(0, 200),
    });

    // Absolute limit — no more retries regardless
    if (attemptCount >= task.maxRetries) {
      return { type: 'abort', reason: `Max retries (${task.maxRetries}) exceeded after ${attemptCount} attempts` };
    }

    // Check if there's a known failure memory for this pattern
    const failureMemories = this.memoryStore.query(result.error || task.description, 5)
      .filter(m => m.type === 'failure' && m.avoidPattern);
    if (failureMemories.length > 0) {
      debugLog.info('recovery', 'Found matching failure memory', {
        memory: failureMemories[0].content.slice(0, 100),
      });
    }

    const alternateSkill = this.selectAlternateSkill(task, category, attemptCount);
    if (alternateSkill) {
      return alternateSkill;
    }

    switch (category) {
      case 'transient':
        return this.handleTransient(attemptCount, task.maxRetries);

      case 'tool_error':
        return this.handleToolError(result, attemptCount, task);

      case 'permission':
        return { type: 'skip', reason: `Permission denied — cannot proceed: ${result.error}` };

      case 'not_found':
        // Try once more (file might be created by earlier task), then skip
        if (attemptCount < 1) {
          return { type: 'retry', maxAttempts: task.maxRetries };
        }
        return { type: 'skip', reason: `Resource not found after retry: ${result.error}` };

      case 'validation':
        // Retry once — LLM might provide corrected input
        if (attemptCount < 1) {
          return { type: 'retry', maxAttempts: task.maxRetries };
        }
        return { type: 'skip', reason: `Validation error persists: ${result.error}` };

      case 'verification':
        // Retry — verification might pass with a different approach
        return { type: 'retry', maxAttempts: task.maxRetries };

      case 'too_complex':
        // Task is too complex for a single pass — try decomposition
        if (attemptCount < 1) {
          return {
            type: 'decompose',
            subTasks: [
              `Break down: ${task.description} (part 1 — understand the problem)`,
              `Break down: ${task.description} (part 2 — implement the solution)`,
            ],
          };
        }
        return { type: 'abort', reason: 'Task too complex after decomposition attempt' };

      case 'ambiguous_entity_resolution':
        // Do not proceed with writes — gather disambiguating evidence
        if (attemptCount < 2) {
          return { type: 'retry', maxAttempts: task.maxRetries, backoffMs: 500 };
        }
        return { type: 'ask_user', question: `Multiple candidates found for: ${task.description}. Which one should I use?` };

      case 'missing_required_data':
        // Try to find the data via different means
        if (attemptCount < 1) {
          return { type: 'retry', maxAttempts: task.maxRetries };
        }
        return { type: 'ask_user', question: `Required data missing for: ${task.description}. Can you provide it?` };

      case 'contradictory_evidence':
        // Gather more evidence to resolve contradiction
        if (attemptCount < 2) {
          return { type: 'retry', maxAttempts: task.maxRetries, backoffMs: 500 };
        }
        return { type: 'ask_user', question: `Contradictory evidence found for: ${task.description}. Which source should I trust?` };

      case 'plan_invalidated':
        // Plan assumptions no longer hold — decompose into new approach
        return {
          type: 'decompose',
          subTasks: [
            `Re-assess: ${task.description} (verify current state)`,
            `Re-attempt: ${task.description} (with updated assumptions)`,
          ],
        };

      case 'environment_changed':
        // External state changed — retry after short delay
        if (attemptCount < 2) {
          return { type: 'retry', maxAttempts: task.maxRetries, backoffMs: 2000 };
        }
        return { type: 'abort', reason: `Environment changed unexpectedly: ${result.error}` };

      case 'unsafe_to_continue':
        // Safety violation — do not retry, escalate
        return { type: 'abort', reason: `Unsafe to continue: ${result.error}` };

      default:
        // Unknown error — retry with backoff
        return this.handleTransient(attemptCount, task.maxRetries);
    }
  }

  /**
   * Record a recovery attempt and its outcome.
   */
  recordAttempt(
    taskId: string,
    strategy: RecoveryStrategy,
    attempt: number,
    success: boolean,
    error?: string,
  ): RecoveryAttempt {
    const record = this.stateManager.addRecoveryAttempt({
      taskId,
      strategy,
      attempt,
      success,
      error,
    });

    // If recovery succeeded, record as procedural memory
    if (success) {
      this.memoryStore.add({
        type: 'procedural',
        content: `Recovery succeeded for "${strategy.type}" strategy on task ${taskId}`,
        tags: ['recovery', strategy.type],
        confidence: 0.7,
      });
    }

    // If all retries exhausted, record as failure memory
    if (!success && attempt >= 3) {
      this.memoryStore.add({
        type: 'failure',
        content: `Recovery failed after ${attempt} attempts (${strategy.type}): ${error || 'unknown'}`,
        tags: ['recovery-failure', taskId],
        confidence: 0.85,
        avoidPattern: error?.slice(0, 100),
      });
    }

    return record;
  }

  /**
   * Classify an error by examining the error message and observations.
   */
  private classifyError(result: TaskResult): ErrorCategory {
    const error = (result.error || '').toLowerCase();
    const lastObs = result.observations[result.observations.length - 1];
    const lastOutput = lastObs?.result?.toLowerCase() || '';
    const combined = error + ' ' + lastOutput;

    // Transient
    if (/timeout|timed out|rate.?limit|too many requests|econnreset|econnrefused|network|socket hang up|503|502|429/.test(combined)) {
      return 'transient';
    }

    // Permission
    if (/eacces|permission denied|forbidden|401|403|unauthorized/.test(combined)) {
      return 'permission';
    }

    // Not found
    if (/enoent|not found|no such file|404|does not exist|cannot find/.test(combined)) {
      return 'not_found';
    }

    // Validation
    if (/invalid|validation|schema|type error|unexpected token|syntax error|parse error/.test(combined)) {
      return 'validation';
    }

    // Verification
    if (/verification failed/.test(combined)) {
      return 'verification';
    }

    // Too complex
    if (/max.*iteration|exceeded maximum|too many iterations/.test(combined)) {
      return 'too_complex';
    }

    // Tool error
    if (/unknown tool|tool.*not.*available|tool.*failed|tool.*error/.test(combined)) {
      return 'tool_error';
    }

    // Ambiguous entity resolution
    if (/ambiguous|multiple.*match|multiple.*candidates|could not disambiguate|which one/.test(combined)) {
      return 'ambiguous_entity_resolution';
    }

    // Missing required data
    if (/missing.*required|required.*field|required.*data|mandatory.*missing|cannot proceed without/.test(combined)) {
      return 'missing_required_data';
    }

    // Contradictory evidence
    if (/contradict|conflicting.*evidence|inconsistent.*data|mismatch.*between/.test(combined)) {
      return 'contradictory_evidence';
    }

    // Plan invalidated
    if (/plan.*invalid|assumption.*wrong|precondition.*failed|stale.*state/.test(combined)) {
      return 'plan_invalidated';
    }

    // Environment changed
    if (/environment.*changed|state.*changed|externally.*modified|concurrent.*modification/.test(combined)) {
      return 'environment_changed';
    }

    // Unsafe to continue
    if (/unsafe|safety.*violation|policy.*violation|budget.*exceeded|rate.*limit.*exceeded/.test(combined)) {
      return 'unsafe_to_continue';
    }

    return 'unknown';
  }

  /**
   * Handle transient errors with exponential backoff.
   */
  private handleTransient(attemptCount: number, maxRetries: number): RecoveryStrategy {
    const backoffMs = Math.min(1000 * Math.pow(2, attemptCount), 30000); // max 30s
    return { type: 'retry', maxAttempts: maxRetries, backoffMs };
  }

  /**
   * Handle tool errors — try alternative tools if available.
   */
  private handleToolError(result: TaskResult, attemptCount: number, task: TaskNode): RecoveryStrategy {
    // Find the failed tool
    const failedObs = result.observations.find(o => o.status === 'error');
    if (failedObs) {
      const alternatives = TOOL_ALTERNATIVES[failedObs.toolName];
      if (alternatives && alternatives.length > 0) {
        const altIndex = Math.min(attemptCount, alternatives.length - 1);
        return {
          type: 'alternative_tool',
          fallbackTool: alternatives[altIndex],
          reason: `${failedObs.toolName} failed, trying ${alternatives[altIndex]}`,
        };
      }
    }

    // No alternatives — just retry
    return { type: 'retry', maxAttempts: task.maxRetries };
  }

  private selectAlternateSkill(
    task: TaskNode,
    category: ErrorCategory,
    attemptCount: number,
  ): RecoveryStrategy | null {
    if (!task.preferredSkill || !this.skillRegistry || attemptCount < 1) {
      return null;
    }
    if (!['tool_error', 'validation', 'verification', 'plan_invalidated', 'unknown', 'not_found'].includes(category)) {
      return null;
    }

    const alternatives = this.skillRegistry.suggestAlternateSkills(task.preferredSkill, task.description);
    if (alternatives.length === 0) {
      return null;
    }

    return {
      type: 'alternative_skill',
      fallbackSkill: alternatives[0],
      reason: `${task.preferredSkill} has failed repeatedly for this task; retry with ${alternatives[0]}.`,
    };
  }
}
