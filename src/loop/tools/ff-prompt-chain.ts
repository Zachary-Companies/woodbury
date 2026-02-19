import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffPromptChainDefinition: ToolDefinition = {
  name: 'prompt_chain',
  description: 'Execute a multi-step prompt chain where each step feeds into the next. Steps run sequentially (or in parallel blocks), accumulating context. Each step can have expectations for auto-validation — if output fails expectations, a repair agent rewrites it (max 2 retries). Useful for complex multi-stage reasoning, analysis pipelines, or content generation workflows.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Array of step definitions. Each step is {promptKey: string, expectations?: string}. Wrap steps in a sub-array for parallel execution.'
      },
      prompts: {
        type: 'object',
        description: 'Map of prompt keys to prompt text strings (e.g. {"step1": "Analyze the following...", "step2": "Based on the analysis..."})'
      },
      input: {
        type: 'string',
        description: 'Initial input/context for the first step'
      },
      preamble: {
        type: 'string',
        description: 'System preamble prepended to each step'
      },
      model: {
        type: 'string',
        description: 'LLM model to use (default: gpt-4o)'
      }
    },
    required: ['steps', 'prompts']
  }
};

export const ffPromptChainHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const steps = params.steps;
  const prompts = params.prompts;

  if (!steps || !Array.isArray(steps)) {
    throw new Error('steps parameter is required and must be an array');
  }
  if (!prompts || typeof prompts !== 'object') {
    throw new Error('prompts parameter is required and must be an object');
  }

  let executeChain: any;
  let runPrompt: any;
  try {
    const chainMod = await import('flow-frame-core/dist/services/chainExecutor.js');
    executeChain = chainMod.executeChain || chainMod.default;
    const promptMod = await import('flow-frame-core/dist/services/runPrompt.js');
    runPrompt = promptMod.runPrompt || promptMod.default;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core chain executor module: ${err.message}`);
  }

  try {
    // Use a direct promptExecutor (no server needed)
    const promptExecutor = async (messages: any[], model: string) => {
      return await runPrompt(messages, model);
    };

    const result = await executeChain({
      chainDef: { steps },
      prompts,
      input: params.input || '',
      preamble: params.preamble || '',
      model: params.model || 'gpt-4o',
      promptExecutor
    });

    const lines: string[] = [];
    lines.push('# Prompt Chain Result');
    lines.push(`\nSteps executed: ${result.history?.length || 0}`);

    // Show history
    if (result.history && result.history.length > 0) {
      lines.push('\n## Step History');
      result.history.forEach((step: any, i: number) => {
        lines.push(`\n### Step ${i + 1}: ${step.promptKey || 'unknown'}`);
        if (step.result) {
          const resultStr = typeof step.result === 'string'
            ? step.result
            : JSON.stringify(step.result, null, 2);
          if (resultStr.length > 3000) {
            lines.push(resultStr.substring(0, 3000) + '\n[Step result truncated...]');
          } else {
            lines.push(resultStr);
          }
        }
        if (step.retries && step.retries > 0) {
          lines.push(`(Retried ${step.retries} time(s) for validation)`);
        }
      });
    }

    // Show final result
    lines.push('\n## Final Result');
    const finalStr = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2);
    lines.push(finalStr);

    let output = lines.join('\n');
    if (output.length > 100000) {
      output = output.substring(0, 100000) + '\n\n[Output truncated at 100k chars...]';
    }
    return output;
  } catch (err: any) {
    throw new Error(`Prompt chain execution failed: ${err.message}`);
  }
};
