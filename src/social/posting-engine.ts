/**
 * Posting Engine — Scripted browser automation for social media posting.
 *
 * Executes deterministic platform scripts that define a sequence of steps.
 * Bridge-capable steps (click, find, wait) run directly via the Chrome bridge.
 * Non-bridge steps (navigate, file_dialog, keyboard) pause and return a compact
 * instruction for the agent to execute, then resume via social_post_continue.
 *
 * Port of the extension's posting-engine.js to TypeScript.
 */

import { randomUUID } from 'node:crypto';
import type {
  PlatformScript,
  PlatformName,
  ScriptStep,
  BridgeAttempt,
  PostingEngineResult,
  AgentInstruction,
  PostingSessionState,
} from './types.js';
import { getScript } from './scripts/index.js';

export const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Bridge server interface — subset of what we need */
export interface BridgeServer {
  isConnected: boolean;
  send(action: string, params: Record<string, unknown>): Promise<unknown>;
}

export class PostingEngine {
  bridge: BridgeServer;
  script: PlatformScript;
  variables: Record<string, string>;
  stepIndex: number;
  sessionId: string;
  status: 'running' | 'paused' | 'success' | 'failed';
  log: (msg: string) => void;
  private _createdAt: string;

  constructor(
    bridgeServer: BridgeServer,
    script: PlatformScript,
    variables: Record<string, string>,
    options: {
      sessionId?: string;
      stepIndex?: number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.bridge = bridgeServer;
    this.script = script;
    this.variables = variables;
    this.stepIndex = options.stepIndex || 0;
    this.sessionId = options.sessionId || randomUUID();
    this.status = 'running';
    this.log = options.log || (() => {});
    this._createdAt = new Date().toISOString();
  }

  /**
   * Execute steps until we hit a pause point (agent-required step),
   * reach the end (success), or encounter an error (failed).
   */
  async runUntilPause(): Promise<PostingEngineResult> {
    // Check bridge connection
    if (!this.bridge.isConnected) {
      return {
        status: 'failed',
        error: 'Chrome bridge is not connected. Make sure the Woodbury Bridge Chrome extension is installed and connected.',
        step: this.stepIndex,
      };
    }

    while (this.stepIndex < this.script.steps.length) {
      const step = this.script.steps[this.stepIndex];

      // Check conditional — skip step if condition not met
      if (step.conditional && !this._checkCondition(step.conditional)) {
        this.log(
          `Step ${this.stepIndex + 1}/${this.script.steps.length}: SKIP (${step.label || step.type}) — condition "${step.conditional}" not met`,
        );
        this.stepIndex++;
        continue;
      }

      this.log(
        `Step ${this.stepIndex + 1}/${this.script.steps.length}: ${step.type}${step.label ? ' (' + step.label + ')' : ''}`,
      );

      try {
        const result = await this._executeStep(step);

        if (result) {
          // Step returned a result (pause, fail, etc.)
          return result;
        }

        // Step completed, move to next
        this.stepIndex++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Step ${this.stepIndex + 1} error: ${msg}`);
        return {
          status: 'failed',
          error: `Step ${this.stepIndex + 1} failed: ${msg}`,
          step: this.stepIndex,
        };
      }
    }

    // All steps completed
    return { status: 'success' };
  }

  /**
   * Execute a single step. Returns null if the step completed and we should
   * continue, or returns a result object if we need to pause/fail.
   */
  private async _executeStep(step: ScriptStep): Promise<PostingEngineResult | null> {
    switch (step.type) {
      case 'bridge':
        return await this._executeBridgeStep(step);

      case 'wait':
        await this._sleep(step.ms || 1000);
        return null;

      case 'checkpoint':
        return await this._executeCheckpoint(step);

      case 'navigate':
        return this._createPause(
          {
            tool: 'mcp__woodbury-browser__browser',
            params: { action: 'open', url: step.url!, waitMs: step.waitMs || 3000 },
          },
          step.waitAfter,
        );

      case 'file_dialog': {
        const filePath = this._resolveVar(step.pathVar!);
        if (!filePath) {
          return {
            status: 'failed',
            error: `No file path for variable: ${step.pathVar}`,
            step: this.stepIndex,
          };
        }
        return this._createPause(
          {
            tool: 'mcp__woodbury-browser__file_dialog',
            params: { filePath },
          },
          step.waitAfter || 2000,
        );
      }

      case 'keyboard_type': {
        const text = this._resolveVar(step.textVar!);
        if (!text) {
          return {
            status: 'failed',
            error: `No text for variable: ${step.textVar}`,
            step: this.stepIndex,
          };
        }
        return this._createPause(
          {
            tool: 'mcp__woodbury-browser__keyboard',
            params: { action: 'type', text },
          },
          step.waitAfter,
        );
      }

      case 'keyboard_select_all':
        return this._createPause(
          {
            tool: 'mcp__woodbury-browser__keyboard',
            params: { action: 'hotkey', key: 'a', ctrl: true },
          },
          step.waitAfter,
        );

      default:
        return {
          status: 'failed',
          error: `Unknown step type: ${step.type}`,
          step: this.stepIndex,
        };
    }
  }

  /**
   * Execute a bridge step — find elements, click, set values, etc.
   * Supports retry and fallback chains.
   */
  private async _executeBridgeStep(step: ScriptStep): Promise<PostingEngineResult | null> {
    const attempts: BridgeAttempt[] = [
      { action: step.action!, params: step.params },
      ...(step.fallback || []),
    ];
    const maxRetries = step.retry?.count || 0;
    const retryDelay = step.retry?.delayMs || 1000;

    for (const attempt of attempts) {
      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          if (retry > 0) {
            this.log(`  Retry ${retry}/${maxRetries} after ${retryDelay}ms...`);
            await this._sleep(retryDelay);
          }

          const result = await this.bridge.send(attempt.action, attempt.params || {});

          // If the step needs to extract a result and click
          if (step.then === 'click') {
            const selector = this._extractSelector(result);
            if (!selector) {
              if (retry < maxRetries) continue;
              // Try next fallback
              break;
            }
            await this.bridge.send('click_element', { selector });
          }

          // Step succeeded
          return null;
        } catch {
          if (retry < maxRetries) continue;
          // Try next fallback
          break;
        }
      }
    }

    // All attempts exhausted
    return {
      status: 'failed',
      error: `Bridge step failed: ${step.action} ${JSON.stringify(step.params)}. Could not find or interact with the element.`,
      step: this.stepIndex,
    };
  }

  /**
   * Execute a checkpoint — query the bridge and check a pass/fail condition.
   */
  private async _executeCheckpoint(step: ScriptStep): Promise<PostingEngineResult | null> {
    try {
      const result = await this.bridge.send(
        step.bridge!.action,
        step.bridge!.params || {},
      );
      const found = this._resultHasElements(result);

      const shouldFail =
        (step.failIf === 'found' && found) ||
        (step.failIf === 'not_found' && !found);

      if (shouldFail) {
        return {
          status: 'failed',
          error: step.failMessage || `Checkpoint "${step.label || 'unnamed'}" failed`,
          step: this.stepIndex,
        };
      }

      // Checkpoint passed
      return null;
    } catch (err) {
      // If the bridge call itself fails (e.g., element not found throws),
      // treat "not found" as the element not existing
      if (step.failIf === 'found') {
        // Element not found = good (we wanted it NOT to be found)
        return null;
      }
      return {
        status: 'failed',
        error:
          step.failMessage ||
          `Checkpoint bridge call failed: ${err instanceof Error ? err.message : err}`,
        step: this.stepIndex,
      };
    }
  }

  /**
   * Create a pause result that tells the agent to execute one MCP call.
   */
  private _createPause(
    agentInstruction: AgentInstruction,
    waitAfter?: number,
  ): PostingEngineResult {
    this.stepIndex++;
    this.status = 'paused';
    return {
      status: 'paused',
      agentInstruction,
      waitAfter: waitAfter || 0,
      step: this.stepIndex - 1,
    };
  }

  /**
   * Extract a CSS selector from a bridge result.
   */
  private _extractSelector(result: unknown): string | null {
    const r = result as Record<string, unknown>;

    // find_interactive returns { results: [{ selector, ... }] }
    if (r?.results && Array.isArray(r.results) && r.results.length > 0) {
      return (r.results[0] as Record<string, unknown>).selector as string || null;
    }
    // find_element_by_text / find_elements returns array of elements
    if (Array.isArray(result) && result.length > 0) {
      return (result[0] as Record<string, unknown>).selector as string || null;
    }
    // Some actions return a single element
    if (r?.selector) {
      return r.selector as string;
    }
    return null;
  }

  /**
   * Check if a bridge result contains any found elements.
   */
  private _resultHasElements(result: unknown): boolean {
    const r = result as Record<string, unknown>;

    if (r?.results && Array.isArray(r.results)) {
      return r.results.length > 0;
    }
    if (Array.isArray(result)) {
      return result.length > 0;
    }
    if (r && typeof r === 'object' && r.selector) {
      return true;
    }
    return false;
  }

  /**
   * Check if a conditional is satisfied.
   */
  private _checkCondition(condition: string): boolean {
    switch (condition) {
      case 'hasImage':
        return !!this.variables.imagePath;
      default:
        // Unknown condition — treat as true (execute the step)
        return true;
    }
  }

  /**
   * Resolve a variable name to its value.
   */
  private _resolveVar(varName: string): string | null {
    return this.variables[varName] || null;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Serialize engine state for persistence between agent calls.
   */
  toJSON(): PostingSessionState {
    return {
      sessionId: this.sessionId,
      scriptPlatform: this.script.platform,
      stepIndex: this.stepIndex,
      variables: this.variables,
      status: this.status,
      createdAt: this._createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Create an engine from persisted state.
   */
  static fromState(
    state: PostingSessionState,
    bridgeServer: BridgeServer,
    log?: (msg: string) => void,
  ): PostingEngine | null {
    // Check expiry
    const updatedAt = new Date(state.updatedAt || state.createdAt);
    if (Date.now() - updatedAt.getTime() > SESSION_TIMEOUT_MS) {
      return null; // expired
    }

    // Load the script
    const script = getScript(state.scriptPlatform);
    if (!script) return null;

    const engine = new PostingEngine(bridgeServer, script, state.variables, {
      sessionId: state.sessionId,
      stepIndex: state.stepIndex,
      log: log || (() => {}),
    });
    engine._createdAt = state.createdAt;
    return engine;
  }
}
