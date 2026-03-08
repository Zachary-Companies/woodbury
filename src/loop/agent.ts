import { ToolRegistry } from './tool-registry.js';
import { ParsedToolCall, AgentConfig, ToolResult, Logger, ToolContext } from './types.js';
import { runPrompt, runPromptStream, ChatMessage, resolveProviderForModel, StreamCallbacks } from './llm-service.js';
import { ToolParser } from './tool-parser.js';
import { generateSystemPrompt } from './system-prompt.js';
import { ProgressLogger } from './logger.js';

// Context compaction settings
const MAX_CONTEXT_TOKENS = 200000;
const COMPACTION_THRESHOLD = 160000; // Trigger compaction at 80% of max
const KEEP_RECENT_MESSAGES = 10; // Keep last N messages when compacting

export interface AgentResult {
  success: boolean;
  content: string;
  error?: string;
  toolCalls: ParsedToolCall[];
  metadata: {
    executionTime: number;
    iterations: number;
    totalTokens?: number;
  };
}

// AgentConfig with defaults applied — callbacks remain optional
type ResolvedAgentConfig = Required<Omit<AgentConfig, 'onToken' | 'onToolStart' | 'onToolEnd'>> & Pick<AgentConfig, 'onToken' | 'onToolStart' | 'onToolEnd'>;

export class Agent {
  private config: ResolvedAgentConfig;
  private toolRegistry?: ToolRegistry;
  private progressLogger: ProgressLogger;

  constructor(config: AgentConfig, toolRegistry?: ToolRegistry) {
    // Set default values for required properties
    this.config = {
      name: config.name || 'DefaultAgent',
      description: config.description || 'A helpful AI agent',
      systemPrompt: config.systemPrompt || '',
      maxTokens: config.maxTokens || 16384,
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
      onToken: config.onToken,
      onToolStart: config.onToolStart,
      onToolEnd: config.onToolEnd,
      streaming: config.streaming ?? !!config.onToken
    };

    this.toolRegistry = toolRegistry;
    this.progressLogger = new ProgressLogger();
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

    // Check if tool is dangerous and whether we allow dangerous tools
    if (tool.definition.dangerous && !this.config.allowDangerousTools) {
      return {
        name: toolCall.name,
        result: `Tool '${toolCall.name}' is marked as dangerous and dangerous tools are not enabled`,
        status: 'error'
      };
    }

    // Check for JSON parse errors from the tool parser
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

    const context: ToolContext = {
      workingDirectory: this.config.workingDirectory,
      logger: this.config.logger,
      timeout: this.config.toolTimeout,
      timeoutMs: this.config.toolTimeout,
      toolTimeout: this.config.toolTimeout,
      agent: this,
      signal
    };

    const toolStart = Date.now();
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

      const toolDuration = Date.now() - toolStart;
      this.config.logger?.debug?.(`✓ ${toolCall.name}`);
      this.config.onToolEnd?.(toolCall.name, true, resultString, toolDuration);
      return {
        name: toolCall.name,
        result: resultString,
        status: 'success'
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const toolDuration = Date.now() - toolStart;
      this.config.logger?.warn?.(`✗ ${toolCall.name}: ${errorMessage}`);
      this.config.onToolEnd?.(toolCall.name, false, errorMessage, toolDuration);
      return {
        name: toolCall.name,
        result: errorMessage,
        status: 'error'
      };
    }
  }

  /**
   * Compact the context by summarizing older messages
   */
  private async compactContext(messages: ChatMessage[]): Promise<ChatMessage[]> {
    // Keep system prompt (first message) and recent messages
    if (messages.length <= KEEP_RECENT_MESSAGES + 1) {
      return messages; // Nothing to compact
    }

    const systemPrompt = messages[0];
    const recentMessages = messages.slice(-KEEP_RECENT_MESSAGES);
    const messagesToSummarize = messages.slice(1, -KEEP_RECENT_MESSAGES);

    if (messagesToSummarize.length === 0) {
      return messages;
    }

    this.progressLogger.update({ phase: 'compacting' });

    // Pre-truncate tool results in older messages to reduce summarization cost
    const truncatedMessages = messagesToSummarize.map(m => {
      let content = m.content;
      // Truncate large tool_result blocks (keep first 500 chars of each)
      content = content.replace(
        /<tool_result[^>]*>([\s\S]{500,}?)<\/tool_result>/g,
        (match, inner) => match.replace(inner, inner.substring(0, 500) + '\n...(truncated)')
      );
      // Cap each message at 3000 chars for the summary
      if (content.length > 3000) {
        content = content.substring(0, 3000) + '...(truncated)';
      }
      return `[${m.role}]: ${content}`;
    });

    // Build summary prompt
    const summaryPrompt: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a context summarizer. Produce a concise structured summary preserving: 1) files read/modified with paths, 2) commands run and their outcomes, 3) decisions made, 4) current task state and progress. Use bullet points. Maximum 2000 chars.'
      },
      {
        role: 'user',
        content: `Summarize this conversation:\n\n${truncatedMessages.join('\n\n')}`
      }
    ];

    try {
      const summaryResponse = await runPrompt(summaryPrompt, this.config.model, {
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        maxTokens: 4096,
        temperature: 0.3
      });

      // Build compacted message array
      const compactedMessages: ChatMessage[] = [
        systemPrompt,
        {
          role: 'user',
          content: `<context_summary>The following is a summary of our conversation so far:\n\n${summaryResponse.content}\n\n[End of summary - continuing from recent context]</context_summary>`
        },
        ...recentMessages
      ];

      const oldTokens = Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
      const newTokens = Math.round(compactedMessages.reduce((sum, m) => sum + m.content.length, 0) / 4);
      this.config.logger?.info?.(`Context compacted: ${oldTokens.toLocaleString()} → ${newTokens.toLocaleString()} tokens`);

      return compactedMessages;
    } catch (error) {
      this.config.logger?.warn?.(`Context compaction failed: ${error}`);
      return messages; // Return original if compaction fails
    }
  }

  async run(prompt: string, signal?: AbortSignal): Promise<AgentResult> {
    const startTime = Date.now();
    let iterations = 0;
    const allToolCalls: ParsedToolCall[] = [];
    let totalTokens = 0;

    // Build the messages array
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
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
          const compactedMessages = await this.compactContext(messages);
          messages.length = 0;
          messages.push(...compactedMessages);
        }

        // Call LLM (streaming or non-streaming)
        const llmOptions = {
          provider: this.config.provider,
          apiKey: this.config.apiKey,
          baseURL: this.config.baseURL,
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature
        };

        let response;
        if (this.config.streaming && this.config.onToken) {
          // Stop the progress spinner so streamed tokens can write to stdout cleanly
          this.progressLogger.stop();
          let firstToken = true;
          response = await runPromptStream(messages, this.config.model, {
            onToken: (token: string) => {
              if (firstToken) {
                firstToken = false;
              }
              this.config.onToken?.(token);
            }
          }, llmOptions);
          // Restart progress display for next iteration (if tool calls follow)
          this.progressLogger.start({
            iteration: iterations,
            maxIterations: this.config.maxIterations,
            phase: 'thinking'
          });
        } else {
          response = await runPrompt(messages, this.config.model, llmOptions);
        }

        if (response.usage) {
          totalTokens += response.usage.totalTokens;
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

          // Build parsed calls with IDs
          const parsedCalls: ParsedToolCall[] = toolCalls.map(tc => ({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: tc.name,
            parameters: tc.parameters
          }));
          allToolCalls.push(...parsedCalls);

          // Execute tools — run in parallel when multiple calls exist
          let toolResults: string[];

          if (parsedCalls.length > 1) {
            // Parallel execution for multiple tool calls
            parsedCalls.forEach(pc => this.progressLogger.logTool(pc.name));

            const results = await Promise.all(
              parsedCalls.map(pc => this.executeTool(pc, signal))
            );
            toolResults = results.map(r =>
              ToolParser.formatToolResult(r.name, r.status, r.result)
            );
          } else {
            // Single tool — sequential (no overhead)
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
          return {
            success: true,
            content: finalAnswer || assistantContent,
            toolCalls: allToolCalls,
            metadata: {
              executionTime,
              iterations,
              totalTokens
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
      return {
        success: true,
        content: finalContent,
        toolCalls: allToolCalls,
        metadata: {
          executionTime,
          iterations: iterations + 1, // Include the wrap-up iteration
          totalTokens
        }
      };

    } catch (error) {
      this.progressLogger.stop();
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
          totalTokens
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
}

export default Agent;
