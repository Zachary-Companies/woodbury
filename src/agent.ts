import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import { WoodburyLogger } from './logger';
import type { WoodburyConfig } from './types';

export class WoodburyAgent {
  private agent: Agent;
  private logger: WoodburyLogger;

  constructor(config: WoodburyConfig = {}) {
    this.logger = new WoodburyLogger(config.verbose || false);
    
    try {
      // Create tool registry
      const toolRegistry = createDefaultToolRegistry();
      
      // Configure agent
      const agentConfig: AgentConfig = {
        name: 'woodbury-agent',
        provider: this.getProvider(config),
        model: config.model || 'gpt-4',
        maxIterations: config.maxIterations || 50,
        timeout: config.timeout || 300000,
        temperature: 0.1,
        workingDirectory: config.workingDirectory || process.cwd()
      };

      // Initialize the agent
      this.agent = new Agent(agentConfig, toolRegistry);
    } catch (error) {
      this.logger.error('Failed to initialize agent:', error);
      throw error;
    }
  }

  private getProvider(config: WoodburyConfig): 'openai' | 'anthropic' | 'groq' {
    // Check for available API keys and configure provider
    if (config.apiKeys?.openai) {
      return 'openai';
    }
    if (config.apiKeys?.anthropic) {
      return 'anthropic';
    }
    if (config.apiKeys?.groq) {
      return 'groq';
    }
    
    // Default to OpenAI
    return 'openai';
  }

  async run(input: string): Promise<AgentResult> {
    try {
      this.logger.info(`Running agent with input: ${input.slice(0, 100)}...`);
      const result = await this.agent.run(input);
      return result;
    } catch (error) {
      this.logger.error('Agent execution failed:', error);
      throw error;
    }
  }

  getTools(): string[] {
    return this.agent.getAvailableTools();
  }

  async stop(): Promise<void> {
    this.logger.info('Agent stopped');
  }
}

// Export singleton instance
let agentInstance: WoodburyAgent | null = null;

export function getAgent(config?: WoodburyConfig): WoodburyAgent {
  if (!agentInstance) {
    agentInstance = new WoodburyAgent(config);
  }
  return agentInstance;
}

export function resetAgent(): void {
  agentInstance = null;
}
