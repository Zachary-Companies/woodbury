/**
 * AgentHandle Bridge — Wraps the ClosureEngine to provide an AgentHandle interface.
 *
 * This ensures the dashboard SSE streaming and REPL work unchanged.
 * Maps setOnToken/setOnToolStart/setOnToolEnd to engine callbacks,
 * and converts ClosureEngineResult → AgentResult.
 */

import type { AgentHandle } from '../../agent-factory.js';
import type { AgentResult, ParsedToolCall } from '../../types.js';
import { ClosureEngine } from './closure-engine.js';
import type { ClosureEngineResult, EngineCallbacks } from './types.js';

/**
 * Bridge the ClosureEngine into an AgentHandle.
 */
export function createAgentHandleBridge(engine: ClosureEngine): AgentHandle {
  const callbacks: EngineCallbacks = {};

  return {
    setOnToken(callback: ((token: string) => void) | undefined): void {
      callbacks.onToken = callback;
      // Patch engine callbacks via the mutable reference
      (engine as any).callbacks.onToken = callback;
    },

    setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void {
      callbacks.onToolStart = callback;
      (engine as any).callbacks.onToolStart = callback;
    },

    setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void {
      callbacks.onToolEnd = callback;
      (engine as any).callbacks.onToolEnd = callback;
    },

    setOnPhaseChange(callback: ((from: string, to: string) => void) | undefined): void {
      callbacks.onPhaseChange = callback as EngineCallbacks['onPhaseChange'];
      (engine as any).callbacks.onPhaseChange = callback;
    },

    setOnTaskStart(callback: ((task: any) => void) | undefined): void {
      callbacks.onTaskStart = callback as EngineCallbacks['onTaskStart'];
      (engine as any).callbacks.onTaskStart = callback;
    },

    setOnTaskEnd(callback: ((task: any, result: any) => void) | undefined): void {
      callbacks.onTaskEnd = callback as EngineCallbacks['onTaskEnd'];
      (engine as any).callbacks.onTaskEnd = callback;
    },

    setOnBeliefUpdate(callback: ((belief: any) => void) | undefined): void {
      callbacks.onBeliefUpdate = callback as EngineCallbacks['onBeliefUpdate'];
      (engine as any).callbacks.onBeliefUpdate = callback;
    },

    setOnReflection(callback: ((reflection: any) => void) | undefined): void {
      callbacks.onReflection = callback as EngineCallbacks['onReflection'];
      (engine as any).callbacks.onReflection = callback;
    },

    setOnSkillSelected(callback: ((selection: any) => void) | undefined): void {
      callbacks.onSkillSelected = callback as EngineCallbacks['onSkillSelected'];
      (engine as any).callbacks.onSkillSelected = callback;
    },

    setOnRecovery(callback: ((event: any) => void) | undefined): void {
      callbacks.onRecovery = callback as EngineCallbacks['onRecovery'];
      (engine as any).callbacks.onRecovery = callback;
    },

    async run(input: string, signal?: AbortSignal): Promise<AgentResult> {
      const result = await engine.run(input, signal);
      return convertResult(result);
    },

    getTools(): string[] {
      return engine.getAvailableTools();
    },

    async stop(): Promise<void> {
      // Nothing to clean up for now
    },
  };
}

/**
 * Convert ClosureEngineResult → AgentResult for backward compatibility.
 */
function convertResult(result: ClosureEngineResult): AgentResult {
  const toolCalls: ParsedToolCall[] = result.observations.map(obs => ({
    id: obs.actionId,
    name: obs.toolName,
    parameters: obs.params as Record<string, any>,
  }));

  return {
    success: result.success,
    content: result.content,
    error: result.error,
    toolCalls,
    metadata: {
      executionTime: result.durationMs,
      iterations: result.iterations,
    },
  };
}
