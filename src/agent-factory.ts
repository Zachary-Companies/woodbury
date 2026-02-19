import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import { WoodburyLogger } from './logger';
import type { WoodburyConfig } from './types';
import { buildSystemPrompt } from './system-prompt.js';

export interface AgentHandle {
  run(input: string, signal?: AbortSignal): Promise<AgentResult>;
  getTools(): string[];
  stop(): Promise<void>;
  setOnToken(callback: ((token: string) => void) | undefined): void;
  setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void;
  setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void;
}

export { type AgentResult } from './types';

export async function createAgent(config: WoodburyConfig): Promise<AgentHandle> {
  const logger = new WoodburyLogger(config.verbose || false);

  try {
    // Create tool registry
    const toolRegistry = createDefaultToolRegistry();

    // Build the comprehensive system prompt with project context
    const workingDirectory = config.workingDirectory || process.cwd();
    const systemPrompt = await buildSystemPrompt(workingDirectory, config.contextDir);

    // Configure agent
    const provider = getProvider(config);
    const apiKey = config.apiKeys?.[provider] || '';
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

    // Create agent with config and tool registry
    const agent = new Agent(agentConfig, toolRegistry);

    return {
      setOnToken(callback: ((token: string) => void) | undefined): void {
        (agent as any).config.onToken = callback;
        (agent as any).config.streaming = !!callback;
      },

      setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void {
        (agent as any).config.onToolStart = callback;
      },

      setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void {
        (agent as any).config.onToolEnd = callback;
      },

      async run(input: string, signal?: AbortSignal): Promise<AgentResult> {
        try {
          logger.info(`Running agent with input: ${input.slice(0, 100)}...`);
          const startTime = Date.now();

          const result = await agent.run(input, signal);

          const endTime = Date.now();
          logger.info(`Agent completed in ${endTime - startTime}ms`);

          if (result.metadata) {
            logger.info(`Iterations: ${result.metadata.iterations}`);
          }

          return result;
        } catch (error) {
          logger.error('Agent execution failed:', error);
          throw error;
        }
      },
      
      getTools(): string[] {
        return agent.getAvailableTools();
      },
      
      async stop(): Promise<void> {
        // Cleanup if needed
        logger.info('Agent stopped');
      }
    };
  } catch (error) {
    logger.error('Failed to create agent:', error);
    throw error;
  }
}

function getProvider(config: WoodburyConfig): 'openai' | 'anthropic' | 'groq' {
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

function getDefaultModel(provider: 'openai' | 'anthropic' | 'groq'): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-4-5-20251101';
    case 'openai':
      return 'gpt-4';
    case 'groq':
      return 'llama-3.1-70b-versatile';
    default:
      return 'claude-opus-4-5-20251101';
  }
}
