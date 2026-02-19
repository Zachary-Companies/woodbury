import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import type { WoodburyConfig } from './types';
import { WoodburyLogger } from './logger';

export interface JobPlan {
  id: string;
  title: string;
  description: string;
  tasks: JobTask[];
  dependencies?: string[];
}

export interface JobTask {
  id: string;
  description: string;
  type: 'analysis' | 'implementation' | 'testing' | 'documentation';
  estimatedTimeMinutes?: number;
}

export async function planJobs(requirements: string, config: WoodburyConfig): Promise<JobPlan[]> {
  const logger = new WoodburyLogger(config.verbose || false);
  
  try {
    // Create tool registry
    const toolRegistry = createDefaultToolRegistry();
    
    // Configure agent
    const agentConfig: AgentConfig = {
      name: 'job-planner',
      provider: getProvider(config),
      model: config.model || 'gpt-4',
      maxIterations: 10,
      timeout: config.timeout || 60000,
      temperature: 0.1,
      workingDirectory: config.workingDirectory || process.cwd()
    };

    const agent = new Agent(agentConfig, toolRegistry);
    
    const planningPrompt = `
Analyze the following requirements and create a detailed job plan:

${requirements}

Create a JSON response with an array of job plans. Each plan should have:
- id: unique identifier
- title: brief descriptive title
- description: detailed description
- tasks: array of tasks with id, description, type, and estimatedTimeMinutes
- dependencies: array of job IDs this depends on (optional)

Task types: analysis, implementation, testing, documentation
`;

    const result = await agent.run(planningPrompt);
    
    logger.info('Job planning completed');
    if (result.metadata) {
      logger.info(`Planning iterations: ${result.metadata.iterations}`);
    }
    
    // Parse the result to extract job plans
    try {
      const plans = JSON.parse(result.content);
      return Array.isArray(plans) ? plans : [plans];
    } catch (parseError) {
      logger.warn('Failed to parse job plans, returning simple plan');
      return [{
        id: 'job-1',
        title: 'Implementation Task',
        description: requirements,
        tasks: [{
          id: 'task-1',
          description: 'Implement requirements',
          type: 'implementation' as const,
          estimatedTimeMinutes: 60
        }]
      }];
    }
  } catch (error) {
    logger.error('Job planning failed:', error);
    throw error;
  }
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
