import { Agent } from './loop/index.js';
import { WoodburyConfig, LocalAgentConfig } from './types';
import { logger } from './logger';

export interface OneShotOptions {
  prompt: string;
  config: WoodburyConfig;
}

export async function executeOneShot(options: OneShotOptions): Promise<string> {
  const { prompt, config } = options;
  
  try {
    logger.debug('Starting one-shot execution', { prompt: prompt.substring(0, 100) });
    
    // Create agent config with required name property
    const agentConfig: LocalAgentConfig = {
      name: 'woodbury-oneshot',
      provider: config.provider || 'anthropic',
      model: config.model || 'claude-opus-4-6',
      temperature: config.temperature || 0,
      maxTokens: config.maxTokens || 8192,
      systemPrompt: config.systemPrompt
    };
    
    // Create agent with config
    const agent = new Agent(agentConfig as any);
    
    // Execute the prompt
    const result = await agent.run(prompt);
    
    logger.debug('One-shot execution completed');
    return result.content;
    
  } catch (error) {
    logger.error('One-shot execution failed:', error);
    throw error;
  }
}

// Export as runOneShot for compatibility
export async function runOneShot(prompt: string, config: WoodburyConfig): Promise<string> {
  return executeOneShot({ prompt, config });
}

export default executeOneShot;
