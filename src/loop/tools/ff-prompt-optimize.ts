import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffPromptOptimizeDefinition: ToolDefinition = {
  name: 'prompt_optimize',
  description: 'Iteratively optimize a system prompt for a specific task. Generates candidate prompts, evaluates them against a dataset of input/expected-output pairs, and feeds the best performers back to generate improved candidates. Returns the best prompt found along with its score.',
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      taskDescription: {
        type: 'string',
        description: 'Description of the task the prompt should accomplish'
      },
      dataset: {
        type: 'array',
        description: 'Array of test examples: [{id: string, input: string, expectedOutput: string}]'
      },
      basePrompt: {
        type: 'string',
        description: 'Optional starting system prompt to optimize from'
      },
      maxIterations: {
        type: 'number',
        description: 'Number of optimization iterations (default: 3)',
        default: 3
      },
      promptsPerRound: {
        type: 'number',
        description: 'Number of candidate prompts per round (default: 3)',
        default: 3
      },
      model: {
        type: 'string',
        description: 'LLM model to use for optimization'
      }
    },
    required: ['taskDescription', 'dataset']
  }
};

export const ffPromptOptimizeHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const taskDescription = params.taskDescription as string;
  const dataset = params.dataset as any[];

  if (!taskDescription) {
    throw new Error('taskDescription parameter is required');
  }
  if (!dataset || !Array.isArray(dataset) || dataset.length === 0) {
    throw new Error('dataset parameter is required and must be a non-empty array of {id, input, expectedOutput}');
  }

  let runAutoPromptSearch: any;
  let createTaskConfig: any;
  let addDatasetExamples: any;
  let buildDatasetExample: any;
  try {
    const mod = await import('flow-frame-core/dist/services/autoPromptOptimizer.js');
    runAutoPromptSearch = mod.runAutoPromptSearch;
    createTaskConfig = mod.createTaskConfig;
    addDatasetExamples = mod.addDatasetExamples;
    buildDatasetExample = mod.buildDatasetExample;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core prompt optimizer module: ${err.message}`);
  }

  try {
    // Build task config
    let taskConfig = createTaskConfig({
      taskDescription,
      systemPromptSeed: params.basePrompt || ''
    });

    // Add dataset examples
    const examples = dataset.map((ex: any) => buildDatasetExample({
      id: ex.id || String(Math.random()),
      input: ex.input,
      expectedOutput: ex.expectedOutput
    }));
    taskConfig = addDatasetExamples(taskConfig, examples);

    const result = await runAutoPromptSearch(taskConfig, {
      maxIterations: params.maxIterations || 3,
      promptsPerRound: params.promptsPerRound || 3,
      topPromptsToFeedBack: 2,
      model: params.model || undefined
    });

    const lines: string[] = [];
    lines.push('# Prompt Optimization Result');
    lines.push(`\nTask: ${taskDescription}`);
    lines.push(`Dataset size: ${dataset.length} examples`);

    if (result.bestPrompt) {
      lines.push('\n## Best Prompt');
      lines.push(`Name: ${result.bestPrompt.name || 'unnamed'}`);
      lines.push(`Average Score: ${result.bestPrompt.avgScore || 'N/A'}`);
      lines.push(`\n### Prompt Text\n\`\`\`\n${result.bestPrompt.text}\n\`\`\``);
    }

    if (result.allResults && result.allResults.length > 0) {
      lines.push(`\n## All Candidates (${result.allResults.length})`);
      result.allResults.slice(0, 10).forEach((r: any, i: number) => {
        lines.push(`${i + 1}. ${r.name || 'unnamed'} — score: ${r.avgScore || 'N/A'}`);
      });
      if (result.allResults.length > 10) {
        lines.push(`... and ${result.allResults.length - 10} more`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    throw new Error(`Prompt optimization failed: ${err.message}`);
  }
};
