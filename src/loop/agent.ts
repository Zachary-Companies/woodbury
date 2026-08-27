import { ToolRegistry } from './tool-registry.js';
import { ParsedToolCall, AgentConfig, ToolResult, Logger, ToolContext } from './types.js';
import { runPrompt, runPromptStream, ChatMessage, resolveProviderForModel, StreamCallbacks } from './llm-service.js';
import { ToolParser } from './tool-parser.js';
import { generateSystemPrompt } from './system-prompt.js';
import { ProgressLogger } from './logger.js';
import { discoverProjectContext } from './project-context.js';
import { SessionStore, SessionManager } from './session.js';
import { PermissionPolicy, PermissionMode } from './permissions.js';
import { HookRunner } from './hooks.js';
import {
  shouldCompact,
  compactMessages,
  CompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
  ChatMessageCompat,
} from './compaction.js';
import { BudgetTracker, type BudgetLimits } from './budget-guard.js';

// Context compaction settings (used as defaults, can be overridden via config)
const COMPACTION_THRESHOLD = 100000;
const KEEP_RECENT_MESSAGES = 6;

export interface AgentResult {
  success: boolean;
  content: string;
  error?: string;
  toolCalls: ParsedToolCall[];
  metadata: {
    executionTime: number;
    iterations: number;
    totalTokens?: number;
    sessionId?: string;
  };
}

// Woodbury keeps streaming/tool-event callbacks optional (they're never defaulted
// because a noop would mask "no caller set this" from code that checks presence).
type ResolvedAgentConfig =
  Required<Omit<AgentConfig, 'onToken' | 'onToolStart' | 'onToolEnd' | 'streaming'>> &
  Pick<AgentConfig, 'onToken' | 'onToolStart' | 'onToolEnd' | 'streaming'>;

export class Agent {
  private config: ResolvedAgentConfig;
  private toolRegistry?: ToolRegistry;
  private progressLogger: ProgressLogger;
  private sessionManager?: SessionManager;
  private permissionPolicy?: PermissionPolicy;
  private hookRunner?: HookRunner;
  private sessionId: string;

  constructor(config: AgentConfig, toolRegistry?: ToolRegistry) {
    // Set default values for required properties
    this.config = {
      name: config.name || 'DefaultAgent',
      description: config.description || 'A helpful AI agent',
      systemPrompt: config.systemPrompt || '',
      maxTokens: config.maxTokens || 32768,
      temperature: config.temperature || 0.7,
      tools: config.tools || [],
      workingDirectory: config.workingDirectory || process.cwd(),
      timeout: config.timeout || config.timeoutMs || 300000,
      maxIterations: config.maxIterations || 1000,
      toolTimeout: config.toolTimeout || 30000,
      allowDangerousTools: config.allowDangerousTools || false,
      maxRetries: config.maxRetries || 3,
      enabledTools: config.enabledTools || [],
      provider: config.provider || 'anthropic',
      model: config.model || 'claude-3-5-sonnet-20241022',
      apiKey: config.apiKey || '',
      baseURL: config.baseURL || '',
      logger: config.logger || console,
      timeoutMs: config.timeoutMs || config.timeout || 300000,
      // New config fields with defaults
      sessionDir: config.sessionDir || '',
      resumeSessionId: config.resumeSessionId || '',
      sessionAutoSaveMs: config.sessionAutoSaveMs ?? 5000,
      permissionMode: config.permissionMode || '',
      toolPermissions: config.toolPermissions || {},
      denyTools: config.denyTools || [],
      denyToolPrefixes: config.denyToolPrefixes || [],
      preToolUseHooks: config.preToolUseHooks || [],
      postToolUseHooks: config.postToolUseHooks || [],
      hookTimeoutMs: config.hookTimeoutMs || 10000,
      budgetLimits: config.budgetLimits || {},
      onBudgetWarning: config.onBudgetWarning || (() => {}),
      onBudgetExceeded: config.onBudgetExceeded || (() => {}),
      // --- Woodbury: streaming + tool-event callbacks (stay optional) ---
      onToken: config.onToken,
      onToolStart: config.onToolStart,
      onToolEnd: config.onToolEnd,
      streaming: config.streaming ?? !!config.onToken,
    };

    this.toolRegistry = toolRegistry;
    this.progressLogger = new ProgressLogger();
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Initialize permission policy if configured
    if (this.config.permissionMode) {
      const mode = this.config.permissionMode as PermissionMode;
      this.permissionPolicy = new PermissionPolicy({
        mode,
        toolRequirements: this.config.toolPermissions as Record<string, PermissionMode>,
        denyList: this.config.denyTools,
        denyPrefixes: this.config.denyToolPrefixes,
        logger: this.config.logger,
      });
    }

    // Initialize hook runner if hooks are configured
    if (this.config.preToolUseHooks.length > 0 || this.config.postToolUseHooks.length > 0) {
      this.hookRunner = new HookRunner({
        preToolUse: this.config.preToolUseHooks,
        postToolUse: this.config.postToolUseHooks,
        timeoutMs: this.config.hookTimeoutMs,
      }, this.config.logger);
    }
  }

  /**
   * Check if the response contains a truncated/incomplete tool call
   */
  private hasIncompleteToolCall(content: string): boolean {
    const openTags = (content.match(/<tool_call>/g) || []).length;
    const closeTags = (content.match(/<\/tool_call>/g) || []).length;

    // If we have more open tags than close tags, the response was truncated
    if (openTags > closeTags) {
      return true;
    }

    // Also check if the response ends mid-tag or mid-JSON
    const lastToolCallStart = content.lastIndexOf('<tool_call>');
    if (lastToolCallStart !== -1) {
      const afterLastStart = content.substring(lastToolCallStart);
      const hasCompleteToolCall = /<tool_call>[\s\S]*?<\/tool_call>/.test(afterLastStart);
      if (!hasCompleteToolCall) {
        return true;
      }
    }

    return false;
  }

  private buildSystemPrompt(): string {
    // If custom system prompt provided, use it
    if (this.config.systemPrompt) {
      // Append tool documentation if we have tools
      if (this.toolRegistry && this.toolRegistry.count() > 0) {
        const toolDocs = this.toolRegistry.generateToolDocumentation();
        return `${this.config.systemPrompt}\n\n${generateSystemPrompt(toolDocs)}`;
      }
      return this.config.systemPrompt;
    }

    // Generate default system prompt with tool documentation
    if (this.toolRegistry && this.toolRegistry.count() > 0) {
      const toolDocs = this.toolRegistry.generateToolDocumentation();
      return generateSystemPrompt(toolDocs);
    }

    return 'You are a helpful AI assistant. Answer the user\'s questions directly and helpfully.';
  }

  private async executeTool(
    toolCall: ParsedToolCall,
    signal?: AbortSignal
  ): Promise<{ name: string; result: string; status: 'success' | 'error' }> {
    if (!this.toolRegistry) {
      return {
        name: toolCall.name,
        result: 'No tool registry available',
        status: 'error'
      };
    }

    const tool = this.toolRegistry.get(toolCall.name);
    if (!tool) {
      return {
        name: toolCall.name,
        result: `Tool '${toolCall.name}' not found`,
        status: 'error'
      };
    }

    // Check graduated permissions (if configured)
    if (this.permissionPolicy) {
      const outcome = await this.permissionPolicy.authorize(toolCall.name);
      if (!outcome.allowed) {
        this.sessionManager?.addToolCall({
          id: toolCall.id,
          name: toolCall.name,
          status: 'error',
          executionTimeMs: 0,
        });
        return {
          name: toolCall.name,
          result: 'reason' in outcome ? outcome.reason : 'Permission denied',
          status: 'error'
        };
      }
    } else if (tool.definition.dangerous && !this.config.allowDangerousTools) {
      // Fallback to legacy binary check if no permission policy
      return {
        name: toolCall.name,
        result: `Tool '${toolCall.name}' is marked as dangerous and dangerous tools are not enabled`,
        status: 'error'
      };
    }

    // Check for JSON parse errors from the tool parser. Must run before the
    // handler sees the params — otherwise `_parseError`/`_raw` reach the tool
    // as its arguments and surface as an opaque ERR_INVALID_ARG_TYPE.
    if (toolCall.parameters?._parseError) {
      return {
        name: toolCall.name,
        result: `Invalid parameters for '${toolCall.name}': ${toolCall.parameters._parseError}. Raw input: ${toolCall.parameters._raw || 'N/A'}`,
        status: 'error'
      };
    }

    // Validate parameters against tool schema
    const validation = this.toolRegistry.validateToolCall(toolCall.name, toolCall.parameters);
    if (!validation.valid) {
      return {
        name: toolCall.name,
        result: `Parameter validation failed for '${toolCall.name}': ${validation.error}`,
        status: 'error'
      };
    }

    // Run pre-tool-use hooks
    if (this.hookRunner) {
      const hookResult = await this.hookRunner.runPreToolUse(
        toolCall.name,
        toolCall.parameters,
        this.sessionId
      );
      if (!hookResult.allowed) {
        this.sessionManager?.addToolCall({
          id: toolCall.id,
          name: toolCall.name,
          status: 'error',
          executionTimeMs: 0,
        });
        return {
          name: toolCall.name,
          result: hookResult.reason || `Pre-tool hook denied '${toolCall.name}'`,
          status: 'error'
        };
      }
    }

    const context: ToolContext = {
      workingDirectory: this.config.workingDirectory,
      logger: this.config.logger,
      timeout: this.config.toolTimeout,
      timeoutMs: this.config.toolTimeout,
      toolTimeout: this.config.toolTimeout,
      agent: this,
      signal
    };

    const toolStartTime = Date.now();
    // Woodbury extension: notify outer renderer that a tool is starting
    this.config.onToolStart?.(toolCall.name, toolCall.parameters);

    try {
      // Execute tool with timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool '${toolCall.name}' execution timeout`)), this.config.toolTimeout)
      );

      const toolResult = await Promise.race([
        tool.handler(toolCall.parameters, context),
        timeoutPromise
      ]);

      // Format the result
      let resultString: string;
      if (typeof toolResult === 'string') {
        resultString = toolResult;
      } else if (toolResult && typeof toolResult === 'object') {
        resultString = JSON.stringify(toolResult, null, 2);
      } else {
        resultString = String(toolResult);
      }

      const executionTimeMs = Date.now() - toolStartTime;

      // Record in session
      this.sessionManager?.addToolCall({
        id: toolCall.id,
        name: toolCall.name,
        status: 'success',
        executionTimeMs,
      });

      // Run post-tool-use hooks
      if (this.hookRunner) {
        await this.hookRunner.runPostToolUse(
          toolCall.name,
          toolCall.parameters,
          resultString,
          false,
          this.sessionId
        );
      }

      // Woodbury extension: notify outer renderer of success
      this.config.onToolEnd?.(toolCall.name, true, resultString, executionTimeMs);

      this.config.logger?.debug?.(`✓ ${toolCall.name}`);
      return {
        name: toolCall.name,
        result: resultString,
        status: 'success'
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const executionTimeMs = Date.now() - toolStartTime;

      // Record in session
      this.sessionManager?.addToolCall({
        id: toolCall.id,
        name: toolCall.name,
        status: 'error',
        executionTimeMs,
      });

      // Run post-tool-use hooks (with error)
      if (this.hookRunner) {
        await this.hookRunner.runPostToolUse(
          toolCall.name,
          toolCall.parameters,
          errorMessage,
          true,
          this.sessionId
        );
      }

      // Woodbury extension: notify outer renderer of failure
      this.config.onToolEnd?.(toolCall.name, false, errorMessage, executionTimeMs);

      this.config.logger?.warn?.(`✗ ${toolCall.name}: ${errorMessage}`);
      return {
        name: toolCall.name,
        result: errorMessage,
        status: 'error'
      };
    }
  }

  /**
   * Compact the context using structured summarization.
   * Uses the standalone compaction module for deterministic, zero-LLM-cost compaction.
   */
  private compactContext(messages: ChatMessage[]): ChatMessage[] {
    this.progressLogger.update({ phase: 'compacting' });

    const result = compactMessages(
      messages as ChatMessageCompat[],
      {
        preserveRecentMessages: KEEP_RECENT_MESSAGES,
        maxEstimatedTokens: COMPACTION_THRESHOLD,
        useLlmSummary: false,
      },
      this.config.logger
    );

    return result.messages as ChatMessage[];
  }

  async run(prompt: string, signal?: AbortSignal): Promise<AgentResult> {
    const startTime = Date.now();
    let iterations = 0;
    const budgetTracker = new BudgetTracker();
    const allToolCalls: ParsedToolCall[] = [];
    let totalTokens = 0;

    // Initialize session persistence if configured
    if (this.config.sessionDir) {
      const store = new SessionStore(this.config.sessionDir, this.config.logger);

      if (this.config.resumeSessionId) {
        // Try to resume existing session
        const resumed = await SessionManager.resume(
          this.config.resumeSessionId,
          store,
          this.config.sessionAutoSaveMs
        );
        if (resumed) {
          this.sessionManager = resumed;
          this.sessionId = this.config.resumeSessionId;
          this.config.logger?.info?.(`Resumed session: ${this.sessionId}`);
        } else {
          this.config.logger?.warn?.(`Session '${this.config.resumeSessionId}' not found, starting new`);
          this.sessionManager = new SessionManager(
            this.sessionId, store, { name: this.config.name }, this.config.sessionAutoSaveMs
          );
        }
      } else {
        this.sessionManager = new SessionManager(
          this.sessionId, store, { name: this.config.name }, this.config.sessionAutoSaveMs
        );
      }
    }

    // Discover project context files (AGENT.md, CLAUDE.md, etc.)
    let systemPrompt = this.buildSystemPrompt();
    try {
      const projectCtx = await discoverProjectContext(this.config.workingDirectory);
      if (projectCtx.content) {
        systemPrompt = `## Project Context\n\n${projectCtx.content}\n\n${systemPrompt}`;
      }
    } catch {
      // Project context discovery is best-effort
    }

    // Build the messages array
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];

    // Start progress display
    this.progressLogger.start({
      iteration: 0,
      maxIterations: this.config.maxIterations,
      phase: 'thinking'
    });

    try {
      // Agentic loop
      while (iterations < this.config.maxIterations) {
        // Check for abort signal
        if (signal?.aborted) {
          throw new Error('Agent execution aborted');
        }

        iterations++;

        // Calculate context size for logging
        const contextChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const contextTokensEstimate = Math.round(contextChars / 4); // ~4 chars per token

        // Check if we need to compact context
        if (contextTokensEstimate > COMPACTION_THRESHOLD) {
          this.config.logger?.info?.(`Context size ${contextTokensEstimate.toLocaleString()} tokens exceeds threshold, compacting...`);
          const compactedMessages = this.compactContext(messages);
          messages.length = 0;
          messages.push(...compactedMessages);
        }

        // Call LLM (Woodbury: stream if configured so onToken can fire)
        let response;
        if (this.config.streaming && this.config.onToken) {
          let streamedContent = '';
          response = await runPromptStream(
            messages,
            this.config.model,
            {
              onToken: (token: string) => {
                streamedContent += token;
                this.config.onToken?.(token);
              },
            } satisfies StreamCallbacks,
            {
              provider: this.config.provider,
              apiKey: this.config.apiKey,
              baseURL: this.config.baseURL,
              maxTokens: this.config.maxTokens,
              temperature: this.config.temperature,
            }
          );
          if (!response.content) response.content = streamedContent;
        } else {
          response = await runPrompt(messages, this.config.model, {
            provider: this.config.provider,
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
          });
        }

        if (response.usage) {
          totalTokens += response.usage.totalTokens;
          budgetTracker.addUsage(
            this.config.model,
            response.usage.promptTokens || 0,
            response.usage.completionTokens || 0,
          );
        }

        // Check budget limits
        if (this.config.budgetLimits) {
          const { status, firstWarning } = budgetTracker.check(this.config.budgetLimits);
          const budgetState = budgetTracker.getState();
          if (status === 'exceeded') {
            this.config.logger?.warn?.(`Budget exceeded: $${budgetState.totalCostUsd.toFixed(4)} / ${budgetState.totalTokens} tokens`);
            this.config.onBudgetExceeded?.(budgetState);
            // Return partial result instead of throwing. Tear down the same way
            // every other exit path does — otherwise the session auto-save
            // interval keeps the process alive and the final state is never flushed.
            this.progressLogger.stop();
            await this.sessionManager?.close();
            const lastContent = response.content || '';
            return {
              success: true,
              content: lastContent + '\n\n[BUDGET_EXCEEDED: Agent stopped — budget limit reached]',
              toolCalls: allToolCalls,
              metadata: {
                executionTime: Date.now() - startTime,
                iterations,
                totalTokens,
                sessionId: this.sessionId,
              },
            };
          }
          if (firstWarning) {
            this.config.logger?.warn?.(`Budget warning: $${budgetState.totalCostUsd.toFixed(4)} / ${budgetState.totalTokens} tokens (${Math.round((this.config.budgetLimits.warnAtPercent ?? 0.8) * 100)}% threshold)`);
            this.config.onBudgetWarning?.(budgetState);
          }
        }

        // Update progress display with token stats
        this.progressLogger.nextIteration(iterations, {
          input: response.usage?.promptTokens,
          output: response.usage?.completionTokens,
          total: totalTokens
        });

        const assistantContent = response.content;

        // Add assistant response to messages
        messages.push({ role: 'assistant', content: assistantContent });

        // Track in session
        this.sessionManager?.addMessage({
          role: 'assistant',
          content: assistantContent,
          usage: response.usage ? {
            inputTokens: response.usage.promptTokens,
            outputTokens: response.usage.completionTokens,
          } : undefined,
          timestamp: Date.now(),
        });
        if (response.usage) {
          this.sessionManager?.addUsage({
            inputTokens: response.usage.promptTokens,
            outputTokens: response.usage.completionTokens,
          });
        }

        // Check for incomplete/truncated tool calls first
        if (this.hasIncompleteToolCall(assistantContent)) {
          this.config.logger?.debug?.('Truncated response, continuing...');
          // Ask the LLM to continue from where it left off
          messages.push({ role: 'user', content: 'Your response was truncated. Please continue from where you left off, completing the tool call.' });
          continue;
        }

        // Check for tool calls BEFORE final answer — the model sometimes emits
        // both tool calls and a premature final answer in one response. Execute
        // the tools first; the model will produce a proper final answer after
        // seeing the tool results.
        if (ToolParser.hasToolCalls(assistantContent)) {
          const toolCalls = ToolParser.parseToolCalls(assistantContent);

          if (toolCalls.length === 0) {
            // No valid tool calls parsed - might be malformed, ask to retry
            this.config.logger?.debug?.('Malformed tool call, retrying...');
            messages.push({ role: 'user', content: 'Your tool call was malformed and could not be parsed. Please try again with valid XML format.' });
            continue;
          }

          // Woodbury extension: run multiple tool calls in parallel
          // (upstream runs them sequentially, which is correct but slow).
          // Give each call a unique id first so allToolCalls order is preserved.
          const parsedCalls: ParsedToolCall[] = toolCalls.map(tc => ({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: tc.name,
            parameters: tc.parameters,
          }));
          allToolCalls.push(...parsedCalls);

          let toolResults: string[];
          if (parsedCalls.length > 1) {
            parsedCalls.forEach(pc => this.progressLogger.logTool(pc.name));
            const results = await Promise.all(
              parsedCalls.map(pc => this.executeTool(pc, signal))
            );
            toolResults = results.map(r =>
              ToolParser.formatToolResult(r.name, r.status, r.result)
            );
          } else {
            this.progressLogger.logTool(parsedCalls[0].name);
            const result = await this.executeTool(parsedCalls[0], signal);
            toolResults = [ToolParser.formatToolResult(result.name, result.status, result.result)];
          }

          // Add tool results as user message for next iteration
          let toolResultsMessage = toolResults.join('\n\n');

          // Warn when iterations are running low
          const iterationsRemaining = this.config.maxIterations - iterations;
          if (iterationsRemaining === 2) {
            toolResultsMessage += '\n\n<system_notice>You have 2 iterations remaining. Please start wrapping up your work and prepare to provide a final response.</system_notice>';
          } else if (iterationsRemaining === 1) {
            toolResultsMessage += '\n\n<system_notice>This is your LAST iteration. You must provide your final answer now. Summarize what you accomplished and any remaining work.</system_notice>';
          }

          messages.push({ role: 'user', content: toolResultsMessage });

        } else {
          // No tool calls — check for final answer or treat as implicit final answer
          const finalAnswer = ToolParser.hasFinalAnswer(assistantContent)
            ? ToolParser.extractFinalAnswer(assistantContent)
            : null;
          const executionTime = Date.now() - startTime;

          this.progressLogger.stop();
          await this.sessionManager?.close();
          return {
            success: true,
            content: finalAnswer || assistantContent,
            toolCalls: allToolCalls,
            metadata: {
              executionTime,
              iterations,
              totalTokens,
              sessionId: this.sessionId,
            }
          };
        }
      }

      // Max iterations reached - give LLM one final chance to wrap up
      this.progressLogger.update({ phase: 'thinking' });

      messages.push({
        role: 'user',
        content: '<system_notice>Maximum iterations reached. You cannot make any more tool calls. Please provide a final summary of:\n1. What you accomplished\n2. What remains incomplete (if anything)\n3. Any recommendations for next steps</system_notice>'
      });

      // One final LLM call for wrap-up
      const wrapUpResponse = await runPrompt(messages, this.config.model, {
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature
      });

      if (wrapUpResponse.usage) {
        totalTokens += wrapUpResponse.usage.totalTokens;
      }

      const executionTime = Date.now() - startTime;
      let finalContent = wrapUpResponse.content;

      // Extract final answer if present, otherwise use raw content
      if (ToolParser.hasFinalAnswer(finalContent)) {
        finalContent = ToolParser.extractFinalAnswer(finalContent) || finalContent;
      }

      this.progressLogger.stop();
      await this.sessionManager?.close();
      return {
        success: true,
        content: finalContent,
        toolCalls: allToolCalls,
        metadata: {
          executionTime,
          iterations: iterations + 1, // Include the wrap-up iteration
          totalTokens,
          sessionId: this.sessionId,
        }
      };

    } catch (error) {
      this.progressLogger.stop();
      await this.sessionManager?.close();
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.config.logger?.error?.(`Agent execution failed: ${errorMessage}`);

      return {
        success: false,
        content: '',
        error: errorMessage,
        toolCalls: allToolCalls,
        metadata: {
          executionTime,
          iterations,
          totalTokens,
          sessionId: this.sessionId,
        }
      };
    }
  }

  async execute(prompt: string): Promise<AgentResult> {
    return this.run(prompt);
  }

  async processMessage(task: string, history: any[]): Promise<string> {
    const result = await this.run(`${task}\n\nContext: ${JSON.stringify(history)}`);
    return result.content;
  }

  getAvailableTools(): string[] {
    return this.toolRegistry ? this.toolRegistry.list() : [];
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  getToolRegistry(): ToolRegistry | undefined {
    return this.toolRegistry;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPermissionPolicy(): PermissionPolicy | undefined {
    return this.permissionPolicy;
  }

  getHookRunner(): HookRunner | undefined {
    return this.hookRunner;
  }
}

export default Agent;
