/**
 * workflow_play Tool
 *
 * Agent-callable tool that loads and executes a recorded browser workflow.
 * Workflows are .workflow.json files containing structured step sequences
 * with CSS selectors, variable substitution, and composition.
 */

import { resolve, dirname } from 'path';
import type { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { bridgeServer } from '../../bridge-server.js';
import { loadWorkflow, discoverWorkflows } from '../../workflow/loader.js';
import { WorkflowExecutor } from '../../workflow/executor.js';
import type { ExecutionProgressEvent, StepResult } from '../../workflow/types.js';

export const workflowPlayDefinition: ToolDefinition = {
  name: 'workflow_play',
  description: 'Execute a recorded browser workflow. Loads a .workflow.json file and runs each step sequentially — navigating pages, clicking elements, typing text, waiting for conditions, etc. Variables are substituted at runtime. Steps include precondition checks (URL, element existence) and retries on failure. Returns a step-by-step execution report.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      workflowPath: {
        type: 'string',
        description: 'Path to the .workflow.json file (absolute or relative to working directory). Can also be a workflow ID to search for in extensions, project, and global workflow directories.',
      },
      variables: {
        type: 'object',
        description: 'Runtime variable values to substitute into the workflow. Keys must match the variable names declared in the workflow.',
      },
      stopOnFailure: {
        type: 'boolean',
        description: 'Whether to stop on first step failure (default: true). Set to false to continue executing remaining steps.',
      },
      list: {
        type: 'boolean',
        description: 'Set to true to list all available workflows instead of executing one. When true, workflowPath is ignored.',
      },
    },
    required: [],
  },
};

export const workflowPlayHandler: ToolHandler = async (
  params: any,
  context?: ToolContext
): Promise<string> => {
  // List mode
  if (params.list) {
    return await listWorkflows(context?.workingDirectory);
  }

  // Execute mode
  if (!params.workflowPath) {
    throw new Error('workflowPath is required when not using list mode. Use list=true to see available workflows.');
  }

  const workingDirectory = context?.workingDirectory || process.cwd();

  // Try to load by path first, then by ID
  let workflow;
  let workflowDir: string;

  try {
    const absolutePath = resolve(workingDirectory, params.workflowPath);
    workflow = await loadWorkflow(absolutePath);
    workflowDir = dirname(absolutePath);
  } catch {
    // Try to find by ID
    const { findWorkflowById } = await import('../../workflow/loader.js');
    const found = await findWorkflowById(params.workflowPath, workingDirectory);
    if (found) {
      workflow = found.workflow;
      workflowDir = dirname(found.path);
    } else {
      throw new Error(
        `Workflow not found: "${params.workflowPath}". ` +
        `Use workflow_play with list=true to see available workflows.`
      );
    }
  }

  // Check bridge server connection
  if (!bridgeServer.isConnected) {
    throw new Error(
      'Chrome extension is not connected. Browser workflows require the Woodbury Bridge ' +
      'Chrome extension to be installed and connected.'
    );
  }

  // Build progress log
  const progressLog: string[] = [];

  const onProgress = (event: ExecutionProgressEvent) => {
    switch (event.type) {
      case 'step_start':
        progressLog.push(`[${event.index + 1}/${event.total}] Starting: ${event.stepLabel}`);
        break;
      case 'step_complete':
        progressLog.push(`  -> ${event.result.status}${event.result.error ? ': ' + event.result.error : ''} (${event.result.durationMs}ms)`);
        break;
      case 'step_retry':
        progressLog.push(`  -> Retry ${event.attempt}/${event.maxAttempts}: ${event.error}`);
        break;
      case 'precondition_check':
        if (!event.passed) {
          progressLog.push(`  -> Precondition FAILED: ${JSON.stringify(event.condition)}`);
        }
        break;
      case 'postcondition_check':
        if (!event.passed) {
          progressLog.push(`  -> Postcondition FAILED: ${JSON.stringify(event.condition)}`);
        }
        break;
    }
  };

  // Execute
  const executor = new WorkflowExecutor(bridgeServer, {
    variables: params.variables || {},
    signal: context?.signal,
    onProgress,
    stopOnFailure: params.stopOnFailure ?? true,
  });
  executor.setWorkflowDir(workflowDir);

  const result = await executor.execute(workflow);

  // Format output
  const lines: string[] = [];
  lines.push(`# Workflow Execution: ${workflow.name}`);
  lines.push(`**Status:** ${result.success ? 'SUCCESS' : 'FAILED'}`);
  lines.push(`**Steps:** ${result.stepsExecuted}/${result.stepsTotal} executed`);
  lines.push(`**Duration:** ${result.durationMs}ms`);

  if (result.error) {
    lines.push(`\n**Error:** ${result.error}`);
  }

  lines.push('\n## Execution Log');
  for (const line of progressLog) {
    lines.push(line);
  }

  lines.push('\n## Step Results');
  for (const sr of result.stepResults) {
    const icon = sr.status === 'success' ? '✓' : sr.status === 'failed' ? '✗' : '○';
    lines.push(`${icon} **${sr.stepLabel}** — ${sr.status} (${sr.durationMs}ms)${sr.error ? ' — ' + sr.error : ''}`);
  }

  if (Object.keys(result.variables).length > 0) {
    lines.push('\n## Final Variables');
    for (const [key, value] of Object.entries(result.variables)) {
      const display = typeof value === 'string' && value.length > 100
        ? value.slice(0, 100) + '...'
        : JSON.stringify(value);
      lines.push(`- **${key}:** ${display}`);
    }
  }

  return lines.join('\n');
};

async function listWorkflows(workingDirectory?: string): Promise<string> {
  const all = await discoverWorkflows(workingDirectory);

  if (all.length === 0) {
    return 'No workflows found.\n\n' +
      'Workflows are discovered from:\n' +
      '- Extension dirs: ~/.woodbury/extensions/<name>/workflows/\n' +
      '- Project: .woodbury-work/workflows/\n' +
      '- Global: ~/.woodbury/workflows/\n\n' +
      'Create a .workflow.json file in one of these locations.';
  }

  const lines: string[] = [];
  lines.push(`# Available Workflows (${all.length})\n`);

  for (const dw of all) {
    const wf = dw.workflow;
    const src = dw.source === 'extension'
      ? `extension:${dw.extensionName}`
      : dw.source;

    lines.push(`## ${wf.name} (id: ${wf.id})`);
    lines.push(`- **Site:** ${wf.site}`);
    lines.push(`- **Source:** ${src}`);
    lines.push(`- **Path:** ${dw.path}`);
    lines.push(`- **Description:** ${wf.description}`);

    if (wf.variables.length > 0) {
      lines.push('- **Variables:**');
      for (const v of wf.variables) {
        const req = v.required ? '(required)' : `(optional, default: ${JSON.stringify(v.default)})`;
        lines.push(`  - \`${v.name}\` — ${v.description} ${req}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
