/**
 * AgentV2 - New agent implementation with native tool calling
 */

import {
  AgentV2Config,
  AgentV2RunResult,
  MessageV2,
  MessageContentV2,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  NativeToolCall,
  ToolExecutionResult,
  ToolExecutionContext,
  AgentEventEmitter,
  SimpleEventEmitter,
  AgentPhase,
} from '../types';
import {
  ProviderAdapter,
  createProviderAdapter,
  detectProvider
} from './provider-adapter';
import { ToolRegistryV2 } from '../tools/registry-v2';
import { createAskUserTool } from '../tools/ask-user';
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../../utils/retry';
import { executeWithTimeout } from '../../utils/timeout';
import { discoverProjectContext } from '../../project-context.js';
import { SessionStore, SessionManager } from '../../session.js';
import { PermissionPolicy, PermissionMode } from '../../permissions.js';
import { HookRunner } from '../../hooks.js';

/**
 * Logger interface
 */
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * ReAct (Reason-Act-Observe) prompt injected when tools are registered
 */
const REACT_PROMPT = `
You follow a Reason-Act-Observe loop to accomplish tasks:

1. REASON: Think about what you know, what you still need, and what to do next. State your reasoning clearly before taking action.
2. ACT: Call a tool to gather information or take action.
3. OBSERVE: Review the tool result. Update your understanding of the situation.
4. REPEAT or RESPOND: If you have enough information, compose your final response. If not, reason about what's missing and act again.

Rules:
- Always reason before acting. Never call a tool without first explaining why you need it.
- After observing tool results, reason about what you learned before deciding the next step.
- When you have gathered sufficient information, compose your final response directly — do not call additional tools unnecessarily.
- CRITICAL: Your final response must contain ONLY the deliverable content. Do NOT include any reasoning, "REASON:", "ACT:", "OBSERVE:" prefixes, or meta-commentary in your final response. The reasoning phase ends when you stop calling tools.
`.trim();

/**
 * AgentV2 - Uses native tool calling with ReAct pattern
 */
export class AgentV2 {
  private readonly config: Required<Omit<AgentV2Config, 'rag' | 'eventEmitter' | 'retryConfig'>> & Pick<AgentV2Config, 'rag' | 'eventEmitter' | 'retryConfig'>;
  private readonly toolRegistry: ToolRegistryV2;
  private readonly logger: Logger;
  private readonly adapter: ProviderAdapter;
  private readonly eventEmitter: AgentEventEmitter;
  private sessionId: string;
  private currentPhase: AgentPhase = 'initializing';
  private questionsAsked = 0;
  private sessionManager?: SessionManager;
  private permissionPolicy?: PermissionPolicy;
  private hookRunner?: HookRunner;

  constructor(
    config: AgentV2Config,
    toolRegistry: ToolRegistryV2,
    logger: Logger
  ) {
    const provider = config.provider || detectProvider(config.model);

    this.config = {
      maxIterations: 50,
      timeoutMs: 300000,
      toolTimeoutMs: 30000,
      workingDirectory: process.cwd(),
      allowDangerousTools: false,
      streaming: true,
      humanInTheLoop: false,
      maxTokens: 8192,
      temperature: 0.1,
      provider,
      // New defaults
      sessionDir: '',
      resumeSessionId: '',
      sessionAutoSaveMs: 5000,
      permissionMode: '',
      toolPermissions: {},
      denyTools: [],
      denyToolPrefixes: [],
      preToolUseHooks: [],
      postToolUseHooks: [],
      hookTimeoutMs: 10000,
      ...config,
    };

    this.toolRegistry = toolRegistry;
    this.logger = logger;
    this.adapter = createProviderAdapter();
    this.eventEmitter = config.eventEmitter || new SimpleEventEmitter();
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Register ask_user tool if human-in-the-loop is enabled
    if (this.config.humanInTheLoop) {
      const askUserTool = createAskUserTool(this.eventEmitter, this.sessionId);
      this.toolRegistry.register(
        askUserTool.definition,
        askUserTool.handler,
        { dangerous: false }
      );
    }

    // Initialize permission policy if configured
    if (this.config.permissionMode) {
      this.permissionPolicy = new PermissionPolicy({
        mode: this.config.permissionMode as PermissionMode,
        toolRequirements: this.config.toolPermissions as Record<string, PermissionMode>,
        denyList: this.config.denyTools as string[],
        denyPrefixes: this.config.denyToolPrefixes as string[],
        logger,
      });
    }

    // Initialize hook runner if hooks are configured
    const preHooks = (this.config.preToolUseHooks as string[]) || [];
    const postHooks = (this.config.postToolUseHooks as string[]) || [];
    if (preHooks.length > 0 || postHooks.length > 0) {
      this.hookRunner = new HookRunner({
        preToolUse: preHooks,
        postToolUse: postHooks,
        timeoutMs: this.config.hookTimeoutMs as number,
      }, logger);
    }
  }

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the event emitter
   */
  getEventEmitter(): AgentEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Run the agent with the given user message
   */
  async run(userMessage: string, abortSignal?: AbortSignal): Promise<AgentV2RunResult> {
    const startTime = Date.now();
    let totalTokens = 0;
    let totalToolCalls = 0;

    // Initialize session persistence if configured
    if (this.config.sessionDir) {
      const store = new SessionStore(this.config.sessionDir as string, this.logger);
      const resumeId = this.config.resumeSessionId as string;

      if (resumeId) {
        const resumed = await SessionManager.resume(resumeId, store, this.config.sessionAutoSaveMs as number);
        if (resumed) {
          this.sessionManager = resumed;
          this.sessionId = resumeId;
          this.logger.info(`Resumed session: ${this.sessionId}`);
        } else {
          this.logger.warn(`Session '${resumeId}' not found, starting new`);
          this.sessionManager = new SessionManager(
            this.sessionId, store, { model: this.config.model }, this.config.sessionAutoSaveMs as number
          );
        }
      } else {
        this.sessionManager = new SessionManager(
          this.sessionId, store, { model: this.config.model }, this.config.sessionAutoSaveMs as number
        );
      }
    }

    // Initialize messages
    const messages: MessageV2[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: userMessage }],
      },
    ];

    this.setPhase('analyzing');
    this.logger.info('Starting agent V2 run', {
      model: this.config.model,
      provider: this.config.provider,
      maxIterations: this.config.maxIterations,
    });

    // Discover project context files (AGENT.md, CLAUDE.md, etc.)
    let projectContextPrefix = '';
    try {
      const projectCtx = await discoverProjectContext(this.config.workingDirectory);
      if (projectCtx.content) {
        projectContextPrefix = `## Project Context\n\n${projectCtx.content}\n\n`;
      }
    } catch {
      // Project context discovery is best-effort
    }

    try {
      for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
        // Check timeout
        const elapsed = Date.now() - startTime;
        if (elapsed > this.config.timeoutMs) {
          this.logger.warn('Agent run timed out', { elapsed, iteration });
          this.setPhase('error');
          return this.createResult('timeout', startTime, totalTokens, totalToolCalls, iteration - 1);
        }

        // Check abort signal
        if (abortSignal?.aborted) {
          this.setPhase('error');
          return this.createResult('cancelled', startTime, totalTokens, totalToolCalls, iteration - 1);
        }

        this.emitProgress(iteration, 'Processing...');
        this.logger.debug(`Starting iteration ${iteration}`);

        // Get tool definitions
        const tools = this.toolRegistry.getAllDefinitions();

        // Build system prompt with project context and ReAct instructions
        let systemPrompt = projectContextPrefix + (this.config.systemPrompt || '');
        if (tools.length > 0 && !systemPrompt.includes('Reason-Act-Observe')) {
          systemPrompt = systemPrompt + '\n\n' + REACT_PROMPT;
        }

        // Call LLM with retry
        const retryConfig = this.config.retryConfig ?? DEFAULT_RETRY_CONFIG;
        const response = await retryWithBackoff(
          () => this.adapter.createCompletion({
            provider: (this.config.provider || 'openai') as any,
            model: this.config.model,
            messages: [
                { role: 'system' as const, content: systemPrompt },
                ...messages.map(m => ({
                    role: m.role as any,
                    content: m.content as any
                }))
            ],
            tools: tools as any,
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
          }),
          retryConfig,
          (error, attempt, delayMs) => {
            this.logger.warn(`LLM call failed, retrying (attempt ${attempt}/${retryConfig.maxRetries})`, {
              error: error.message,
              delayMs,
            });
          }
        );

        if (response.usage) {
            totalTokens += response.usage.inputTokens + response.usage.outputTokens;
        }

        const textContent = typeof response.content === 'string' ? response.content : '';
        const toolUses = response.toolCalls || [];
        
        const messageContent: MessageContentV2[] = [];
        if (textContent) {
            messageContent.push({ type: 'text', text: textContent });
        }
        for (const tc of toolUses) {
            messageContent.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.input
            });
        }

        // Log response
        this.logger.debug('LLM response', {
          textLength: textContent.length,
          toolCalls: toolUses.length,
          stopReason: response.stopReason,
        });

        // Add assistant message
        messages.push({
          role: 'assistant',
          content: messageContent,
        });

        // If no tool calls, we're done
        if (toolUses.length === 0) {
          this.logger.info('Agent completed', { iteration, textLength: textContent.length });
          this.setPhase('completed');
          await this.sessionManager?.close();

          this.eventEmitter.emit({
            type: 'result',
            timestamp: Date.now(),
            sessionId: this.sessionId,
            status: 'success',
            finalAnswer: textContent,
            iterations: iteration,
            totalTimeMs: Date.now() - startTime,
            tokenEstimate: totalTokens,
          });

          return {
            status: 'success',
            finalAnswer: textContent,
            iterations: iteration,
            totalTimeMs: Date.now() - startTime,
            tokenEstimate: totalTokens,
            toolCalls: totalToolCalls,
            questionsAsked: this.questionsAsked,
          };
        }

        // Execute tool calls in parallel
        this.setPhase('generating');
        const toolUseContents = toolUses.map(tool => ({ type: 'tool_use' as const, ...tool }));
        const toolResults = await this.executeToolCalls(toolUseContents, abortSignal);
        totalToolCalls += toolUses.length;

        // Emit iteration event with reasoning (text content before tool calls)
        this.eventEmitter.emit({
          type: 'iteration',
          timestamp: Date.now(),
          sessionId: this.sessionId,
          iteration,
          response: textContent,
          reasoning: textContent || undefined,
          toolCalls: toolUses.map(t => ({ id: t.id, name: t.name, input: t.input })),
          toolResults,
          elapsedMs: Date.now() - startTime,
        });

        // Add tool results as user message
        messages.push({
          role: 'user',
          content: toolResults.map(r => ({
            type: 'tool_result' as const,
            tool_use_id: r.toolCall.id,
            content: r.output,
            is_error: r.status === 'error',
          })),
        });
      }

      // Max iterations reached
      this.logger.warn('Agent reached max iterations', {
        maxIterations: this.config.maxIterations,
      });
      this.setPhase('error');
      await this.sessionManager?.close();

      return this.createResult('max_iterations', startTime, totalTokens, totalToolCalls, this.config.maxIterations);
    } catch (error) {
      this.logger.error('Agent run failed with error', { error });
      this.setPhase('error');
      await this.sessionManager?.close();

      this.eventEmitter.emit({
        type: 'error',
        timestamp: Date.now(),
        sessionId: this.sessionId,
        error: (error as Error).message,
        recoverable: false,
      });

      return {
        status: 'error',
        iterations: 0,
        totalTimeMs: Date.now() - startTime,
        tokenEstimate: totalTokens,
        toolCalls: totalToolCalls,
        questionsAsked: this.questionsAsked,
        error: error as Error,
      };
    }
  }

  /**
   * Execute tool calls in parallel (order preserved)
   */
  private async executeToolCalls(
    toolUses: ToolUseContent[],
    abortSignal?: AbortSignal
  ): Promise<ToolExecutionResult[]> {
    const executeOne = async (toolUse: ToolUseContent): Promise<ToolExecutionResult> => {
      const startTime = Date.now();
      const toolCall: NativeToolCall = {
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      };

      this.logger.debug(`Executing tool: ${toolUse.name}`, { input: toolUse.input });

      // Emit tool call event
      this.eventEmitter.emit({
        type: 'tool_call',
        timestamp: Date.now(),
        sessionId: this.sessionId,
        toolCall,
      });

      const registeredTool = this.toolRegistry.get(toolUse.name);

      if (!registeredTool) {
        const result: ToolExecutionResult = {
          toolCall,
          status: 'error',
          output: `Unknown tool: ${toolUse.name}. Available tools: ${this.toolRegistry.getToolNames().join(', ')}`,
          executionTimeMs: Date.now() - startTime,
        };
        this.emitToolResult(result);
        return result;
      }

      // Graduated permission check (if configured)
      if (this.permissionPolicy) {
        const outcome = await this.permissionPolicy.authorize(toolUse.name);
        if (!outcome.allowed) {
          const result: ToolExecutionResult = {
            toolCall,
            status: 'error',
            output: 'reason' in outcome ? outcome.reason : 'Permission denied',
            executionTimeMs: Date.now() - startTime,
          };
          this.emitToolResult(result);
          this.sessionManager?.addToolCall({
            id: toolUse.id, name: toolUse.name, status: 'error', executionTimeMs: 0,
          });
          return result;
        }
      } else if (registeredTool.dangerous && !this.config.allowDangerousTools) {
        // Fallback to legacy binary check
        const result: ToolExecutionResult = {
          toolCall,
          status: 'error',
          output: `Tool "${toolUse.name}" is dangerous and not allowed. Set allowDangerousTools: true to enable.`,
          executionTimeMs: Date.now() - startTime,
        };
        this.emitToolResult(result);
        return result;
      }

      // Run pre-tool-use hooks
      if (this.hookRunner) {
        const hookResult = await this.hookRunner.runPreToolUse(
          toolUse.name, toolUse.input as Record<string, unknown>, this.sessionId
        );
        if (!hookResult.allowed) {
          const result: ToolExecutionResult = {
            toolCall,
            status: 'error',
            output: hookResult.reason || `Pre-tool hook denied '${toolUse.name}'`,
            executionTimeMs: Date.now() - startTime,
          };
          this.emitToolResult(result);
          return result;
        }
      }

      // Track if this is an ask_user call
      if (toolUse.name === 'ask_user') {
        this.questionsAsked++;
        this.setPhase('waiting_for_input');
      }

      const context: ToolExecutionContext = {
        workingDirectory: this.config.workingDirectory,
        timeoutMs: this.config.toolTimeoutMs,
        signal: abortSignal,
      };

      try {
        const output = await executeWithTimeout(
          registeredTool.handler(toolUse.input, context),
          this.config.toolTimeoutMs,
        );

        const result: ToolExecutionResult = {
          toolCall,
          status: 'success',
          output: output as string,
          executionTimeMs: Date.now() - startTime,
        };

        this.emitToolResult(result);

        // Record in session
        this.sessionManager?.addToolCall({
          id: toolUse.id, name: toolUse.name, status: 'success',
          executionTimeMs: result.executionTimeMs,
        });

        // Run post-tool-use hooks
        if (this.hookRunner) {
          await this.hookRunner.runPostToolUse(
            toolUse.name, toolUse.input as Record<string, unknown>,
            output as string, false, this.sessionId
          );
        }

        // Restore phase after ask_user
        if (toolUse.name === 'ask_user') {
          this.setPhase('generating');
        }

        return result;
      } catch (error) {
        const result: ToolExecutionResult = {
          toolCall,
          status: 'error',
          output: `Error: ${(error as Error).message}`,
          executionTimeMs: Date.now() - startTime,
        };

        this.emitToolResult(result);

        // Record in session
        this.sessionManager?.addToolCall({
          id: toolUse.id, name: toolUse.name, status: 'error',
          executionTimeMs: result.executionTimeMs,
        });

        // Run post-tool-use hooks (with error)
        if (this.hookRunner) {
          await this.hookRunner.runPostToolUse(
            toolUse.name, toolUse.input as Record<string, unknown>,
            (error as Error).message, true, this.sessionId
          );
        }

        return result;
      }
    };

    return Promise.all(toolUses.map(executeOne));
  }

  /**
   * Set and emit phase change
   */
  private setPhase(phase: AgentPhase): void {
    if (phase !== this.currentPhase) {
      const from = this.currentPhase;
      this.currentPhase = phase;

      this.eventEmitter.emit({
        type: 'phase',
        timestamp: Date.now(),
        sessionId: this.sessionId,
        from,
        to: phase,
      });
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(iteration: number, message?: string): void {
    const percentage = Math.min(
      Math.round((iteration / this.config.maxIterations) * 100),
      99
    );

    this.eventEmitter.emit({
      type: 'progress',
      timestamp: Date.now(),
      sessionId: this.sessionId,
      phase: this.currentPhase,
      percentage,
      iteration,
      maxIterations: this.config.maxIterations,
      message,
    });
  }

  /**
   * Emit tool result event
   */
  private emitToolResult(result: ToolExecutionResult): void {
    this.eventEmitter.emit({
      type: 'tool_result',
      timestamp: Date.now(),
      sessionId: this.sessionId,
      result,
    });
  }

  /**
   * Create result object
   */
  private createResult(
    status: AgentV2RunResult['status'],
    startTime: number,
    totalTokens: number,
    totalToolCalls: number,
    iterations: number,
    error?: Error
  ): AgentV2RunResult {
    return {
      status,
      iterations,
      totalTimeMs: Date.now() - startTime,
      tokenEstimate: totalTokens,
      toolCalls: totalToolCalls,
      questionsAsked: this.questionsAsked,
      error,
    };
  }
}
