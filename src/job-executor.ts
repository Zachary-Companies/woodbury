import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import type { WoodburyConfig } from './types';
import type { JobPlan, JobTask } from './job-planner';
import { WoodburyLogger } from './logger';

export interface JobResult {
  jobId: string;
  status: 'completed' | 'failed' | 'skipped';
  results: TaskResult[];
  totalTimeMs: number;
  error?: string;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'skipped';
  output?: string;
  timeMs: number;
  error?: string;
}

export async function executeJobs(plans: JobPlan[], config: WoodburyConfig): Promise<JobResult[]> {
  const logger = new WoodburyLogger(config.verbose || false);
  const results: JobResult[] = [];
  
  // Create tool registry
  const toolRegistry = createDefaultToolRegistry();
  
  // Configure agent
  const agentConfig: AgentConfig = {
    name: 'job-executor',
    provider: getProvider(config),
    model: config.model || 'gpt-4',
    maxIterations: config.maxIterations || 50,
    timeout: config.timeout || 300000,
    temperature: 0.1,
    workingDirectory: config.workingDirectory || process.cwd()
  };

  const agent = new Agent(agentConfig, toolRegistry);
  
  for (const plan of plans) {
    const startTime = Date.now();
    logger.info(`Executing job: ${plan.title}`);
    
    try {
      const taskResults: TaskResult[] = [];
      
      for (const task of plan.tasks) {
        const taskStartTime = Date.now();
        logger.info(`  Executing task: ${task.description}`);
        
        try {
          const prompt = `
Execute the following task:

Task Type: ${task.type}
Description: ${task.description}

Context: This is part of job "${plan.title}" - ${plan.description}

Provide a detailed response with any code, analysis, or documentation as appropriate.
`;
          
          const result = await agent.run(prompt);
          
          const taskEndTime = Date.now();
          taskResults.push({
            taskId: task.id,
            status: 'completed',
            output: result.content,
            timeMs: taskEndTime - taskStartTime
          });
          
          logger.info(`    Task completed in ${taskEndTime - taskStartTime}ms`);
          if (result.metadata) {
            logger.info(`    Iterations: ${result.metadata.iterations}`);
          }
        } catch (taskError) {
          const taskEndTime = Date.now();
          logger.error(`    Task failed:`, taskError);
          
          taskResults.push({
            taskId: task.id,
            status: 'failed',
            timeMs: taskEndTime - taskStartTime,
            error: taskError instanceof Error ? taskError.message : String(taskError)
          });
        }
      }
      
      const endTime = Date.now();
      results.push({
        jobId: plan.id,
        status: taskResults.every(t => t.status === 'completed') ? 'completed' : 'failed',
        results: taskResults,
        totalTimeMs: endTime - startTime
      });
      
      logger.info(`Job completed in ${endTime - startTime}ms`);
    } catch (jobError) {
      const endTime = Date.now();
      logger.error(`Job failed:`, jobError);
      
      results.push({
        jobId: plan.id,
        status: 'failed',
        results: [],
        totalTimeMs: endTime - startTime,
        error: jobError instanceof Error ? jobError.message : String(jobError)
      });
    }
  }
  
  return results;
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
