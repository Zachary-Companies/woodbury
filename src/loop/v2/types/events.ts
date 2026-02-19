/**
 * Event types for V2 agent - SSE streaming and human-in-the-loop
 */

import { NativeToolCall, ToolExecutionResult } from './tool-types';

/**
 * All event types emitted by the agent
 */
export type AgentEvent =
  | LogEvent
  | ProgressEvent
  | PhaseEvent
  | IterationEvent
  | ToolCallEvent
  | ToolResultEvent
  | QuestionEvent
  | StreamChunkEvent
  | ResultEvent
  | ErrorEvent;

export interface BaseEvent {
  timestamp: number;
  sessionId: string;
}

/**
 * Log entry event
 */
export interface LogEvent extends BaseEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Progress update event
 */
export interface ProgressEvent extends BaseEvent {
  type: 'progress';
  phase: AgentPhase;
  percentage: number;
  iteration: number;
  maxIterations: number;
  message?: string;
}

/**
 * Phase transition event
 */
export interface PhaseEvent extends BaseEvent {
  type: 'phase';
  from: AgentPhase | null;
  to: AgentPhase;
}

/**
 * Agent phases
 */
export type AgentPhase =
  | 'initializing'
  | 'analyzing'
  | 'generating'
  | 'testing'
  | 'refining'
  | 'waiting_for_input'
  | 'completed'
  | 'error';

/**
 * Iteration completion event
 */
export interface IterationEvent extends BaseEvent {
  type: 'iteration';
  iteration: number;
  response: string;
  toolCalls: NativeToolCall[];
  toolResults: ToolExecutionResult[];
  elapsedMs: number;
}

/**
 * Tool call started event
 */
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  toolCall: NativeToolCall;
}

/**
 * Tool result event
 */
export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  result: ToolExecutionResult;
}

/**
 * Human-in-the-loop question event
 */
export interface QuestionEvent extends BaseEvent {
  type: 'question';
  questionId: string;
  question: string;
  options?: string[];
  context?: string;
  inputType: 'text' | 'choice' | 'confirm';
}

/**
 * Streaming response chunk
 */
export interface StreamChunkEvent extends BaseEvent {
  type: 'stream_chunk';
  content: string;
  isToolUse: boolean;
  toolName?: string;
}

/**
 * Final result event
 */
export interface ResultEvent extends BaseEvent {
  type: 'result';
  status: 'success' | 'error' | 'max_iterations' | 'timeout' | 'cancelled';
  finalAnswer?: string;
  iterations: number;
  totalTimeMs: number;
  tokenEstimate: number;
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseEvent {
  type: 'error';
  error: string;
  code?: string;
  recoverable: boolean;
}

/**
 * Event emitter interface for the agent
 */
export interface AgentEventEmitter {
  emit<T extends AgentEvent>(event: T): void;
  on<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void;
  once<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void;
  off<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): void;
}

/**
 * Simple event emitter implementation
 */
export class SimpleEventEmitter implements AgentEventEmitter {
  private handlers = new Map<string, Set<(event: AgentEvent) => void>>();

  emit<T extends AgentEvent>(event: T): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${event.type}:`, error);
        }
      }
    }

    // Also emit to wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in wildcard event handler:', error);
        }
      }
    }
  }

  on<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as (event: AgentEvent) => void);
    return () => this.off(type, handler);
  }

  once<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): () => void {
    const wrapper = (event: Extract<AgentEvent, { type: T }>) => {
      this.off(type, wrapper);
      handler(event);
    };
    return this.on(type, wrapper);
  }

  off<T extends AgentEvent['type']>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void
  ): void {
    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      typeHandlers.delete(handler as (event: AgentEvent) => void);
    }
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}

/**
 * Question response for human-in-the-loop
 */
export interface QuestionResponse {
  questionId: string;
  answer: string;
}
