import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';

export const ffWorkflowExecuteDefinition: ToolDefinition = {
  name: 'workflow_execute',
  description: 'Execute a visual node-graph workflow (DAG). Supports 25+ node types including: data nodes (input/set/get/property), AI/prompt nodes, control flow (switch/if/forEach/forLoop), network (fetch/gmail/poller), code execution (execJS), and composition (subgraph/workflow references). Nodes are topologically sorted and executed in order.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        description: 'Array of node objects: [{id: string, type: string, data: object}]. Node types include: inputNode, setNode, getNode, propertyNode, promptNode, switchNode, ifNode, forEachNode, fetchNode, execJSNode, workflowNode, graphNode, and more.'
      },
      edges: {
        type: 'array',
        description: 'Array of edge objects: [{source: string, sourceHandle: string, target: string, targetHandle: string}]'
      },
      initialContext: {
        type: 'object',
        description: 'Pre-populated node values as {nodeId: value}'
      },
      workflows: {
        type: 'object',
        description: 'Named workflow configs for subgraph references'
      },
      model: {
        type: 'string',
        description: 'Default LLM model for prompt nodes'
      }
    },
    required: ['nodes', 'edges']
  }
};

export const ffWorkflowExecuteHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const nodes = params.nodes;
  const edges = params.edges;

  if (!nodes || !Array.isArray(nodes)) {
    throw new Error('nodes parameter is required and must be an array');
  }
  if (!edges || !Array.isArray(edges)) {
    throw new Error('edges parameter is required and must be an array');
  }

  let executeFlow: any;
  try {
    const mod = await import('flow-frame-core/dist/services/executor.js');
    executeFlow = mod.executeFlow || mod.default;
  } catch (err: any) {
    throw new Error(`Failed to load flow-frame-core executor module: ${err.message}`);
  }

  try {
    const modelContext: any = {};
    if (params.model) {
      modelContext.defaultModel = params.model;
    }

    const executionLog: string[] = [];
    const callback = (nodeId: string, progress: any) => {
      executionLog.push(`[${nodeId}] ${JSON.stringify(progress)}`);
    };

    const result = await executeFlow(
      nodes,
      edges,
      params.workflows || {},
      modelContext,
      params.initialContext || {},
      callback,
      {}
    );

    const lines: string[] = [];
    lines.push('# Workflow Execution Result');
    lines.push(`\nNodes: ${nodes.length}`);
    lines.push(`Edges: ${edges.length}`);

    if (executionLog.length > 0) {
      lines.push('\n## Execution Log');
      const logLines = executionLog.slice(-20); // Last 20 log entries
      if (executionLog.length > 20) {
        lines.push(`[... ${executionLog.length - 20} earlier entries omitted]`);
      }
      logLines.forEach(log => lines.push(`  ${log}`));
    }

    lines.push('\n## Result');
    const resultStr = JSON.stringify(result, null, 2);
    if (resultStr.length > 50000) {
      lines.push(resultStr.substring(0, 50000) + '\n[Result truncated at 50k chars...]');
    } else {
      lines.push(resultStr);
    }

    let output = lines.join('\n');
    if (output.length > 100000) {
      output = output.substring(0, 100000) + '\n\n[Output truncated at 100k chars...]';
    }
    return output;
  } catch (err: any) {
    throw new Error(`Workflow execution failed: ${err.message}`);
  }
};
