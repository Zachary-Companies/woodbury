import type { WoodburyToolDefinition } from '../types';
import { Agent, createDefaultToolRegistry, AgentConfig } from '../loop/index.js';

export interface DelegateParams {
  type: 'explore' | 'plan' | 'execute';
  task: string;
  context: string;
}

export const delegate: WoodburyToolDefinition<DelegateParams> = {
  name: 'delegate',
  description: 'Spawn a child agent with its own context window to perform a focused subtask. The child has NO conversation history — provide everything it needs via the context parameter. Types: "explore" (read-only, for understanding code), "plan" (read-only, for creating implementation plans), "execute" (full tools, for implementing changes).',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['explore', 'plan', 'execute'],
        description: 'Subagent type: "explore", "plan", or "execute"'
      },
      task: {
        type: 'string',
        description: 'What the subagent should accomplish — one clear objective'
      },
      context: {
        type: 'string',
        description: 'Everything the subagent needs: file contents, plan excerpts, constraints, conventions, file paths. The subagent starts BLANK and cannot see conversation history.'
      }
    },
    required: ['type', 'task', 'context']
  },
  async execute(params: DelegateParams) {
    try {
      // Create tool registry
      const toolRegistry = createDefaultToolRegistry();
      
      // Configure subagent
      const agentConfig: AgentConfig = {
        name: `delegate-${params.type}`,
        provider: 'openai',
        model: 'gpt-4',
        maxIterations: 20,
        timeout: 180000, // 3 minutes
        temperature: 0.1
      };
      
      const agent = new Agent(agentConfig, toolRegistry);
      
      // Construct the prompt with context and task
      const prompt = `
Context:
${params.context}

Task:
${params.task}

Please complete this task using the provided context. You are a specialized ${params.type} agent with access to ${params.type === 'execute' ? 'full' : 'read-only'} tools.
`;
      
      const result = await agent.run(prompt);
      
      return {
        success: true,
        data: {
          type: params.type,
          task: params.task,
          result: result.content,
          metadata: result.metadata
        }
      };
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};
