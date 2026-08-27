/**
 * Hook System for External Policy Enforcement
 *
 * Modeled after claw-code-main's hook system:
 * - Pre/post tool-use hooks as shell commands
 * - JSON payload on stdin with tool context
 * - Exit code semantics: 0=allow, 2=deny, other=warn
 * - Stdout captured as feedback/error message
 */

import { Logger } from './types.js';
import { spawn } from 'child_process';
import * as os from 'os';

/**
 * Hook event types
 */
export type HookEvent = 'pre_tool_use' | 'post_tool_use';

/**
 * Hook configuration
 */
export interface HookConfig {
  /** Shell commands to run before a tool executes */
  preToolUse?: string[];

  /** Shell commands to run after a tool executes */
  postToolUse?: string[];

  /** Timeout for each hook command in ms (default: 10000) */
  timeoutMs?: number;
}

/**
 * Payload sent to hooks via stdin
 */
export interface HookPayload {
  hookEvent: HookEvent;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: string;
  toolResultIsError?: boolean;
  sessionId?: string;
  timestamp: number;
}

/**
 * Result from a hook execution
 */
export interface HookResult {
  /** Whether the hook allowed the action */
  allowed: boolean;

  /** Stdout from the hook (feedback or denial reason) */
  message?: string;

  /** Exit code of the hook process */
  exitCode: number;

  /** Which command produced this result */
  command: string;

  /** Execution time in ms */
  executionTimeMs: number;
}

/**
 * Hook runner — executes pre/post tool-use hooks
 */
export class HookRunner {
  private config: HookConfig;
  private logger: Logger;
  private readonly hookTimeout: number;

  constructor(config: HookConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger || console;
    this.hookTimeout = config.timeoutMs || 10000;
  }

  /**
   * Run pre-tool-use hooks. Returns deny reason if any hook denies.
   */
  async runPreToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId?: string
  ): Promise<{ allowed: boolean; reason?: string; feedback?: string }> {
    const commands = this.config.preToolUse || [];
    if (commands.length === 0) {
      return { allowed: true };
    }

    const payload: HookPayload = {
      hookEvent: 'pre_tool_use',
      toolName,
      toolInput,
      sessionId,
      timestamp: Date.now(),
    };

    for (const command of commands) {
      const result = await this.executeHook(command, payload);

      if (!result.allowed) {
        // Exit code 2 = deny
        this.logger.info?.(`Hook denied tool '${toolName}': ${result.message || 'no reason'}`);
        return {
          allowed: false,
          reason: result.message || `Hook '${command}' denied execution of '${toolName}'`,
        };
      }

      if (result.exitCode !== 0) {
        // Non-zero, non-2 = warn but allow
        this.logger.warn?.(`Hook warning for '${toolName}' (exit ${result.exitCode}): ${result.message || ''}`);
      }
    }

    return { allowed: true };
  }

  /**
   * Run post-tool-use hooks (informational — can't deny after execution)
   */
  async runPostToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    isError: boolean,
    sessionId?: string
  ): Promise<void> {
    const commands = this.config.postToolUse || [];
    if (commands.length === 0) return;

    const payload: HookPayload = {
      hookEvent: 'post_tool_use',
      toolName,
      toolInput,
      toolOutput,
      toolResultIsError: isError,
      sessionId,
      timestamp: Date.now(),
    };

    for (const command of commands) {
      try {
        const result = await this.executeHook(command, payload);
        if (result.message) {
          this.logger.debug?.(`Post-hook feedback for '${toolName}': ${result.message}`);
        }
      } catch (error) {
        // Post-hooks are best-effort
        this.logger.warn?.(`Post-hook failed for '${toolName}': ${error}`);
      }
    }
  }

  /**
   * Execute a single hook command
   */
  private executeHook(command: string, payload: HookPayload): Promise<HookResult> {
    const startTime = Date.now();

    return new Promise<HookResult>((resolve) => {
      // Determine shell based on platform
      const isWindows = os.platform() === 'win32';
      const shell = isWindows ? 'cmd' : 'sh';
      const shellArgs = isWindows ? ['/C', command] : ['-lc', command];

      const child = spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOOK_EVENT: payload.hookEvent,
          HOOK_TOOL_NAME: payload.toolName,
          HOOK_TOOL_INPUT: JSON.stringify(payload.toolInput),
          HOOK_TOOL_OUTPUT: payload.toolOutput || '',
          HOOK_TOOL_IS_ERROR: String(payload.toolResultIsError || false),
          HOOK_SESSION_ID: payload.sessionId || '',
        },
        timeout: this.hookTimeout,
      });

      // Send full payload as JSON on stdin. A hook that exits without draining
      // stdin (e.g. `exit 2`) makes this write fail with EPIPE — that surfaces on
      // the stdin stream, not on the ChildProcess, so it needs its own listener
      // or Node raises an uncaught exception and kills the agent.
      child.stdin.on('error', () => { /* EPIPE — hook exited without reading stdin */ });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code, signal) => {
        // A null exit code means the hook was killed by a signal — for us that
        // is almost always spawn()'s own `timeout` firing SIGTERM. A policy hook
        // that never rendered a verdict must fail CLOSED: treating a timeout as
        // "allowed" lets a hung deny hook wave through the tool it was blocking.
        const killed = code === null;
        const exitCode = code ?? (signal ? 2 : 1);
        const message = killed
          ? `Hook timed out after ${this.hookTimeout}ms (killed by ${signal || 'signal'}) — denying`
          : (stdout.trim() || stderr.trim() || undefined);

        resolve({
          allowed: !killed && exitCode !== 2,
          message,
          exitCode,
          command,
          executionTimeMs: Date.now() - startTime,
        });
      });

      child.on('error', (error) => {
        this.logger.warn?.(`Hook process error for '${command}': ${error.message}`);
        resolve({
          allowed: true, // On error, default to allow (fail-open)
          message: `Hook error: ${error.message}`,
          exitCode: -1,
          command,
          executionTimeMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Check if any hooks are configured
   */
  hasHooks(): boolean {
    return (
      (this.config.preToolUse?.length || 0) > 0 ||
      (this.config.postToolUse?.length || 0) > 0
    );
  }

  /**
   * Get hook configuration
   */
  getConfig(): HookConfig {
    return { ...this.config };
  }
}
