import { Agent } from './agent.js';
import { AgentConfig } from './types.js';
import { AgentFactory } from './agent-factory.js';
import { ToolRegistry } from './tool-registry.js';
import { SubagentConfig, SubagentResult } from './types.js';
import { createLogger, Logger } from './logger.js';
import { createRenderer, Renderer } from './renderer.js';

// Import all available tools
import {
  fileReadDefinition, fileReadHandler,
  listDirectoryDefinition, listDirectoryHandler,
  fileSearchDefinition, fileSearchHandler,
  grepDefinition, grepHandler,
  gitDefinition, gitHandler
} from './tools/index.js';

export class Subagent {
  private logger: Logger;
  private renderer: Renderer;
  private config: SubagentConfig;

  constructor(config: SubagentConfig) {
    this.config = config;
    this.logger = createLogger('Subagent');
    this.renderer = createRenderer();
  }

  async execute(): Promise<SubagentResult> {
    try {
      this.logger.info(`Starting ${this.config.type} subagent`, {
        task: this.config.task,
        type: this.config.type
      });

      // Create tool registry based on subagent type
      const toolRegistry = this.createToolRegistry(this.config.type);

      // Create agent configuration
      const agentConfig: AgentConfig = {        name: 'subagent',        provider: this.config.provider || 'openai',
        model: this.config.model || 'gpt-4',
        apiKey: this.config.apiKey,
        systemPrompt: this.getSystemPrompt(),
        maxTokens: 4000,
        temperature: 0.1,
        timeout: this.config.timeout,
        maxRetries: this.config.maxRetries,
        logger: this.logger
      };

      // Create and configure agent
      const agent = AgentFactory.create(agentConfig);
      agent.setToolRegistry(toolRegistry);

      // Build the full prompt with context
      const prompt = this.buildPrompt();

      this.logger.debug('Executing subagent with prompt', { prompt });

      // Execute the agent
      const result = await agent.execute(prompt);

      if (!result.success) {
        throw new Error(`Subagent execution failed: ${result.error}`);
      }

      this.logger.info('Subagent execution completed successfully');

      return {
        success: true,
        result: result.content,
        metadata: {
          type: this.config.type,
          toolCalls: result.toolCalls.length,
          executionTime: result.metadata.executionTime
        }
      };
    } catch (error) {
      this.logger.error('Subagent execution failed', error);
      return {
        success: false,
        result: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private createToolRegistry(type: 'explore' | 'plan' | 'execute'): ToolRegistry {
    const registry = new ToolRegistry();

    // All types get read-only tools
    registry.register(fileReadDefinition, fileReadHandler);
    registry.register(listDirectoryDefinition, listDirectoryHandler);
    registry.register(fileSearchDefinition, fileSearchHandler);
    registry.register(grepDefinition, grepHandler);
    registry.register(gitDefinition, gitHandler);

    // Only execute type gets write tools
    if (type === 'execute') {
      // Import write tools dynamically to avoid loading them for read-only types
      import('./tools/index.js').then(tools => {
        if (tools.fileWriteDefinition && tools.fileWriteHandler) {
          registry.register(tools.fileWriteDefinition, tools.fileWriteHandler);
        }
        if (tools.shellExecuteDefinition && tools.shellExecuteHandler) {
          registry.register(tools.shellExecuteDefinition, tools.shellExecuteHandler);
        }
        if (tools.testRunnerDefinition && tools.testRunnerHandler) {
          registry.register(tools.testRunnerDefinition, tools.testRunnerHandler);
        }
      });
    }

    return registry;
  }

  private getSystemPrompt(): string {
    const basePrompt = `You are a ${this.config.type} subagent with a specific focused task.`;
    
    switch (this.config.type) {
      case 'explore':
        return `${basePrompt}

Your role is to EXPLORE and UNDERSTAND code:
- Read files to understand structure and patterns
- Search for specific implementations or patterns
- Analyze code relationships and dependencies
- Find relevant examples or similar code
- Summarize findings clearly and concisely

You have READ-ONLY access. Focus on understanding and reporting back what you discover.
Be thorough but concise in your analysis.`;
        
      case 'plan':
        return `${basePrompt}

Your role is to CREATE IMPLEMENTATION PLANS:
- Analyze requirements and constraints
- Break down complex tasks into steps
- Identify files that need to be created or modified
- Plan the sequence of implementation
- Consider dependencies and prerequisites
- Create detailed, actionable plans

You have READ-ONLY access. Focus on planning and design, not implementation.
Provide clear, structured plans that others can execute.`;
        
      case 'execute':
        return `${basePrompt}

Your role is to IMPLEMENT specific changes:
- Follow the provided plan or requirements exactly
- Create, modify, or delete files as needed
- Run tests to verify implementations
- Handle errors and edge cases appropriately
- Provide clear feedback on what was accomplished

You have FULL ACCESS to modify the codebase. Be careful and precise in your changes.
Test your implementations to ensure they work correctly.`;
        
      default:
        return basePrompt;
    }
  }

  private buildPrompt(): string {
    let prompt = `Task: ${this.config.task}\n\n`;
    
    if (this.config.context) {
      prompt += `Context:\n${this.config.context}\n\n`;
    }
    
    prompt += `Please complete this task according to your role as a ${this.config.type} subagent. `;
    
    switch (this.config.type) {
      case 'explore':
        prompt += 'Focus on understanding and analyzing the codebase. Provide a clear summary of your findings.';
        break;
      case 'plan':
        prompt += 'Create a detailed implementation plan with clear steps and requirements.';
        break;
      case 'execute':
        prompt += 'Implement the required changes carefully and test them.';
        break;
    }
    
    return prompt;
  }
}

// Factory function for creating subagents
export function createSubagent(config: SubagentConfig): Subagent {
  return new Subagent(config);
}

// Delegate function that matches the tool interface
export async function delegateToSubagent(parameters: {
  type: 'explore' | 'plan' | 'execute';
  task: string;
  context: string;
  provider?: 'openai' | 'anthropic' | 'groq';
  model?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
}): Promise<SubagentResult> {
  const subagent = createSubagent({
    type: parameters.type,
    task: parameters.task,
    context: parameters.context,
    provider: parameters.provider,
    model: parameters.model,
    apiKey: parameters.apiKey,
    timeout: parameters.timeout,
    maxRetries: parameters.maxRetries
  });
  
  return subagent.execute();
}

// Export types for external use
export type { SubagentConfig, SubagentResult };
