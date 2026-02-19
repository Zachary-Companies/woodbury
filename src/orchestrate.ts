import { Agent } from './loop/index.js';
import { WoodburyConfig, LocalAgentConfig, Job, JobResult, OrchestrationResult } from './types';
import { logger } from './logger';

export interface OrchestrationOptions {
  jobs: Job[];
  config: WoodburyConfig;
  concurrency?: number;
}

export class JobOrchestrator {
  private config: WoodburyConfig;
  private concurrency: number;

  constructor(config: WoodburyConfig, concurrency: number = 1) {
    this.config = config;
    this.concurrency = concurrency;
  }

  async executeJobs(jobs: Job[]): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const results: JobResult[] = [];
    
    logger.info(`Starting orchestration of ${jobs.length} jobs with concurrency ${this.concurrency}`);

    // Process jobs in batches based on concurrency
    for (let i = 0; i < jobs.length; i += this.concurrency) {
      const batch = jobs.slice(i, i + this.concurrency);
      const batchPromises = batch.map(job => this.executeJob(job));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const totalTime = Date.now() - startTime;
    const completed = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    logger.info(`Orchestration completed: ${completed.length} succeeded, ${failed.length} failed, ${totalTime}ms total`);

    return {
      completed,
      failed,
      totalTime
    };
  }

  private async executeJob(job: Job): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      logger.debug(`Starting job ${job.id}`);
      
      // Create agent config with required name property
      const agentConfig: LocalAgentConfig = {
        name: `woodbury-job-${job.id}`,
        provider: this.config.provider || 'anthropic',
        model: this.config.model || 'claude-opus-4-6',
        temperature: this.config.temperature || 0,
        maxTokens: this.config.maxTokens || 8192,
        systemPrompt: this.config.systemPrompt
      };

      const agent = new Agent(agentConfig as any);
      const result = await agent.run(job.prompt);
      const duration = Date.now() - startTime;
      
      logger.debug(`Job ${job.id} completed successfully in ${duration}ms`);
      
      return {
        id: job.id,
        success: true,
        result: result.content,
        executionTime: duration
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.error(`Job ${job.id} failed after ${duration}ms:`, error);
      
      return {
        id: job.id,
        success: false,
        error: errorMessage,
        executionTime: duration
      };
    }
  }
}

export async function orchestrateJobs(options: OrchestrationOptions): Promise<OrchestrationResult> {
  const orchestrator = new JobOrchestrator(options.config, options.concurrency);
  return orchestrator.executeJobs(options.jobs);
}

export default orchestrateJobs;
