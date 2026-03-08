/**
 * Delegate Engine — Child ClosureEngine instances for subtask delegation.
 *
 * Creates scoped child engines that inherit parent beliefs and failure memories
 * but have their own task graph. Results are integrated back into the parent.
 */

import { ClosureEngine } from './closure-engine.js';
import type { ToolRegistryV2 } from '../v2/tools/registry-v2.js';
import type { MemoryStore } from './memory-store.js';
import type {
  ClosureEngineConfig,
  ClosureEngineResult,
  EngineCallbacks,
  Belief,
  MemoryRecord,
} from './types.js';
import { debugLog } from '../../debug-log.js';

export interface DelegationRequest {
  /** Description of the subtask to delegate */
  objective: string;
  /** Constrain which tools the delegate can use (empty = all tools) */
  allowedTools?: string[];
  /** Max iterations for the delegate (lower than parent) */
  maxIterations?: number;
  /** Timeout in ms for the delegate */
  timeout?: number;
}

export interface DelegationResult {
  success: boolean;
  content: string;
  observations: ClosureEngineResult['observations'];
  beliefs: Belief[];
  memories: MemoryRecord[];
  durationMs: number;
  error?: string;
}

export class DelegateEngine {
  private parentConfig: ClosureEngineConfig;
  private toolRegistry: ToolRegistryV2;
  private memoryStore: MemoryStore;
  private systemPrompt: string;

  constructor(
    parentConfig: ClosureEngineConfig,
    toolRegistry: ToolRegistryV2,
    memoryStore: MemoryStore,
    systemPrompt: string,
  ) {
    this.parentConfig = parentConfig;
    this.toolRegistry = toolRegistry;
    this.memoryStore = memoryStore;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Delegate a subtask to a child engine.
   */
  async delegate(
    request: DelegationRequest,
    parentCallbacks: EngineCallbacks,
    signal?: AbortSignal,
  ): Promise<DelegationResult> {
    debugLog.info('delegate', `Delegating: ${request.objective.slice(0, 100)}`);

    // Create scoped tool registry if tools are restricted
    let registry = this.toolRegistry;
    if (request.allowedTools && request.allowedTools.length > 0) {
      registry = this.createScopedRegistry(request.allowedTools);
    }

    // Child config — more constrained than parent
    const childConfig: ClosureEngineConfig = {
      ...this.parentConfig,
      maxIterations: request.maxIterations || Math.min(50, this.parentConfig.maxIterations),
      timeout: request.timeout || Math.min(60000, this.parentConfig.timeout),
      reflectionInterval: 10, // less frequent reflection for delegates
      callbacks: {
        // Forward token/tool callbacks to parent
        onToken: parentCallbacks.onToken,
        onToolStart: parentCallbacks.onToolStart,
        onToolEnd: parentCallbacks.onToolEnd,
      },
    };

    const engine = new ClosureEngine(childConfig, registry, this.systemPrompt);
    const startTime = Date.now();

    try {
      const result = await engine.run(request.objective, signal);

      debugLog.info('delegate', `Delegation complete`, {
        success: result.success,
        iterations: result.iterations,
        toolCalls: result.totalToolCalls,
        durationMs: result.durationMs,
      });

      return {
        success: result.success,
        content: result.content,
        observations: result.observations,
        beliefs: result.beliefs,
        memories: result.memories,
        durationMs: result.durationMs,
        error: result.error,
      };
    } catch (error) {
      debugLog.error('delegate', 'Delegation failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        content: '',
        observations: [],
        beliefs: [],
        memories: [],
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a scoped tool registry with only the allowed tools.
   */
  private createScopedRegistry(allowedTools: string[]): ToolRegistryV2 {
    const ScopedRegistry = this.toolRegistry.constructor as typeof ToolRegistryV2;
    const scoped = new ScopedRegistry({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    const allowedSet = new Set(allowedTools);
    for (const tool of this.toolRegistry.getAll()) {
      if (allowedSet.has(tool.definition.name)) {
        scoped.register(tool.definition, tool.handler, { dangerous: tool.dangerous });
      }
    }

    return scoped;
  }
}
