import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import type { WoodburyConfig } from './types';
import { WoodburyLogger } from './logger';

export interface SubagentOptions {
  type: 'explore' | 'plan' | 'execute';
  maxIterations?: number;
  timeout?: number;
  temperature?: number;
}

export class Subagent {
  private agent: Agent;
  private logger: WoodburyLogger;
  private options: SubagentOptions;
  
  constructor(config: WoodburyConfig, options: SubagentOptions) {
    this.logger = new WoodburyLogger(config.verbose || false);
    this.options = options;
    
    try {
      // Create tool registry
      const toolRegistry = createDefaultToolRegistry();
      
      // Configure options based on subagent type
      let maxIterations = options.maxIterations || 20;
      let timeout = options.timeout || 180000;
      
      if (options.type === 'execute') {
        maxIterations = 25;
        timeout = 300000;
      }
      
      // Configure agent
      const agentConfig: AgentConfig = {
        name: `subagent-${options.type}`,
        provider: getProvider(config),
        model: config.model || 'gpt-4',
        maxIterations,
        timeout,
        temperature: options.temperature || 0.1,
        workingDirectory: config.workingDirectory || process.cwd()
      };
      
      this.agent = new Agent(agentConfig, toolRegistry);
    } catch (error) {
      this.logger.error('Failed to initialize subagent:', error);
      throw error;
    }
  }
  
  async run(task: string, context: string): Promise<AgentResult> {
    this.logger.info(`Running ${this.options.type} subagent: ${task}`);
    
    try {
      const prompt = this.buildPrompt(task, context);
      const startTime = Date.now();
      
      const result = await this.agent.run(prompt);
      
      const endTime = Date.now();
      this.logger.info(`Subagent completed in ${endTime - startTime}ms`);
      if (result.metadata) {
        this.logger.info(`Iterations: ${result.metadata.iterations}`);
      }
      
      return result;
      
    } catch (error) {
      this.logger.error('Subagent execution failed:', error);
      throw error;
    }
  }
  
  private buildPrompt(task: string, context: string): string {
    const typeDescriptions = {
      explore: 'You are an exploration agent with read-only access. Your job is to understand and analyze code, documentation, or systems.',
      plan: 'You are a planning agent with read-only access. Your job is to create detailed implementation plans based on your analysis.',
      execute: 'You are an execution agent with full tool access. Your job is to implement changes, write code, and modify files.'
    };
    
    return `
${typeDescriptions[this.options.type]}

Context:
${context}

Task:
${task}

Please complete this task using the provided context and available tools.
`;
  }
}

export async function createSubagent(config: WoodburyConfig, options: SubagentOptions): Promise<Subagent> {
  return new Subagent(config, options);
}

function getProvider(config: WoodburyConfig): 'openai' | 'anthropic' | 'groq' {
  if (config.apiKeys?.openai) {
    return 'openai';
  }
  if (config.apiKeys?.anthropic) {
    return 'anthropic';
  }
  if (config.apiKeys?.groq) {
    return 'groq';
  }
  return 'openai';
}
