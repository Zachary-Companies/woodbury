import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import { WoodburyLogger } from './logger';
import type { WoodburyConfig } from './types';
import { buildSystemPrompt } from './system-prompt.js';
import { ensureBridgeServer, bridgeServer } from './bridge-server.js';
import type { ExtensionManager } from './extension-manager.js';
import { debugLog } from './debug-log.js';

export interface AgentHandle {
  run(input: string, signal?: AbortSignal): Promise<AgentResult>;
  getTools(): string[];
  stop(): Promise<void>;
  setOnToken(callback: ((token: string) => void) | undefined): void;
  setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void;
  setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void;
}

export { type AgentResult } from './types';

export async function createAgent(
  config: WoodburyConfig,
  extensionManager?: ExtensionManager
): Promise<AgentHandle> {
  const logger = new WoodburyLogger(config.verbose || false);

  try {
    // Create tool registry
    const doneRegistry = debugLog.time('agent', 'Creating tool registry');
    const toolRegistry = createDefaultToolRegistry();
    doneRegistry();

    const defaultToolCount = toolRegistry.getAll?.()?.length || 0;
    debugLog.info('agent', 'Default tools registered', { count: defaultToolCount });

    // Register extension tools
    if (extensionManager) {
      const extTools = extensionManager.getAllTools();
      debugLog.info('agent', `Registering ${extTools.length} extension tool(s)`);
      for (const { definition, handler } of extTools) {
        try {
          toolRegistry.register(definition, handler);
          debugLog.debug('agent', `Registered extension tool: ${definition.name}`);
        } catch (err) {
          debugLog.error('agent', `Extension tool "${definition.name}" registration failed`, { error: String(err) });
          logger.warn(`Extension tool "${definition.name}" registration failed: ${err}`);
        }
      }
    }

    // Start the bridge server for Chrome extension communication (non-blocking)
    debugLog.debug('agent', 'Starting bridge server (non-blocking)');
    ensureBridgeServer().catch((err) => {
      debugLog.warn('agent', 'Bridge server failed to start', { error: String(err) });
    });

    // Build the comprehensive system prompt with project context + extension prompts
    const workingDirectory = config.workingDirectory || process.cwd();
    const extensionPrompts = extensionManager?.getAllPromptSections();
    const donePrompt = debugLog.time('agent', 'Building system prompt');
    const systemPrompt = await buildSystemPrompt(workingDirectory, config.contextDir, extensionPrompts);
    donePrompt();
    debugLog.info('agent', 'System prompt built', {
      length: systemPrompt.length,
      extensionPromptCount: extensionPrompts?.length || 0,
    });

    // Configure agent
    const provider = getProvider(config);
    const apiKey = provider === 'claude-code' ? '' : (config.apiKeys?.[provider] || '');
    const agentConfig: AgentConfig = {
      name: 'woodbury-agent',
      provider,
      model: config.model || getDefaultModel(provider),
      apiKey,
      maxIterations: config.maxIterations || 1000,
      timeout: config.timeout || 300000,
      temperature: 0.1,
      workingDirectory,
      allowDangerousTools: !config.safe,
      systemPrompt,
      streaming: config.stream !== false
    };

    debugLog.info('agent', 'Agent config', {
      provider: agentConfig.provider,
      model: agentConfig.model,
      maxIterations: agentConfig.maxIterations,
      timeout: agentConfig.timeout,
      streaming: agentConfig.streaming,
      allowDangerousTools: agentConfig.allowDangerousTools,
      hasApiKey: !!apiKey,
    });

    // Create agent with config and tool registry
    const agent = new Agent(agentConfig, toolRegistry);
    debugLog.info('agent', 'Agent created successfully');

    return {
      setOnToken(callback: ((token: string) => void) | undefined): void {
        (agent as any).config.onToken = callback;
        (agent as any).config.streaming = !!callback;
        // Disable progress logger when streaming — its ANSI cursor movement
        // is incompatible with the REPL's scroll-region terminal layout.
        (agent as any).progressLogger.disabled = !!callback;
      },

      setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void {
        (agent as any).config.onToolStart = callback;
      },

      setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void {
        (agent as any).config.onToolEnd = callback;
      },

      async run(input: string, signal?: AbortSignal): Promise<AgentResult> {
        try {
          const inputPreview = input.slice(0, 200) + (input.length > 200 ? '...' : '');
          debugLog.info('agent.run', 'Agent run starting', { inputLength: input.length, preview: inputPreview });
          logger.info(`Running agent with input: ${input.slice(0, 100)}...`);
          const startTime = Date.now();

          const result = await agent.run(input, signal);

          const endTime = Date.now();
          const elapsed = endTime - startTime;
          debugLog.info('agent.run', 'Agent run completed', {
            elapsed: `${elapsed}ms`,
            success: result.success,
            iterations: result.metadata?.iterations,
            toolCalls: result.toolCalls?.length || 0,
            contentLength: result.content?.length || 0,
          });
          logger.info(`Agent completed in ${elapsed}ms`);

          if (result.metadata) {
            logger.info(`Iterations: ${result.metadata.iterations}`);
          }

          return result;
        } catch (error) {
          debugLog.error('agent.run', 'Agent execution failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          logger.error('Agent execution failed:', error);
          throw error;
        }
      },
      
      getTools(): string[] {
        return agent.getAvailableTools();
      },
      
      async stop(): Promise<void> {
        // Stop the bridge server
        await bridgeServer.stop().catch(() => {});
        logger.info('Agent stopped');
      }
    };
  } catch (error) {
    logger.error('Failed to create agent:', error);
    throw error;
  }
}

function getProvider(config: WoodburyConfig): 'openai' | 'anthropic' | 'groq' | 'claude-code' {
  // If explicitly specified, use it
  if (config.provider) {
    return config.provider;
  }

  // Auto-detect from available API keys
  if (config.apiKeys?.anthropic) {
    return 'anthropic';
  }
  if (config.apiKeys?.openai) {
    return 'openai';
  }
  if (config.apiKeys?.groq) {
    return 'groq';
  }

  // Default to Anthropic
  return 'anthropic';
}

function getDefaultModel(provider: 'openai' | 'anthropic' | 'groq' | 'claude-code'): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-4-5-20251101';
    case 'openai':
      return 'gpt-4';
    case 'groq':
      return 'llama-3.1-70b-versatile';
    case 'claude-code':
      return 'claude-sonnet-4-5-20250514';
    default:
      return 'claude-opus-4-5-20251101';
  }
}
