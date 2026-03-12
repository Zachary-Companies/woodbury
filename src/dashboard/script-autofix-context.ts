interface AutoFixPortLike {
  name: string;
}

interface AutoFixScriptLike {
  code?: string;
}

interface AutoFixNodeLike {
  id: string;
  label?: string;
  workflowId: string;
  script?: AutoFixScriptLike;
  outputNode?: { ports?: AutoFixPortLike[] };
  junctionNode?: { ports?: AutoFixPortLike[] };
  variableNode?: { inputName?: string; exposeAsInput?: boolean };
  getVariableNode?: { targetNodeId?: string };
  compositionRef?: { compositionId?: string };
  toolNode?: { selectedTool?: string };
  asset?: { mode?: string };
}

interface AutoFixEdgeLike {
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface AutoFixWorkflowLike {
  name?: string;
}

function truncateText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, Math.max(0, maxLen - 3)) + '...';
}

export function summarizeAutoFixValue(value: unknown, maxLen = 220): string {
  if (value === undefined) return '(undefined)';
  if (value === null) return 'null';

  if (typeof value === 'string') {
    return truncateText(JSON.stringify(value), maxLen);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    return truncateText(JSON.stringify(value), maxLen);
  } catch {
    return truncateText(String(value), maxLen);
  }
}

function extractScriptPorts(code: string | undefined): { inputs: string[]; outputs: string[] } {
  const source = String(code || '');
  const inputs = [...source.matchAll(/@input\s+\{[^}]+\}\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const outputs = [...source.matchAll(/@output\s+\{[^}]+\}\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  return { inputs, outputs };
}

function describeAutoFixNode(
  node: AutoFixNodeLike | undefined,
  wfMap: Record<string, AutoFixWorkflowLike>,
): string {
  if (!node) return 'unknown node';

  if (node.workflowId === '__script__') {
    const ports = extractScriptPorts(node.script?.code);
    const details: string[] = ['script node'];
    if (ports.inputs.length > 0) details.push(`inputs: ${ports.inputs.join(', ')}`);
    if (ports.outputs.length > 0) details.push(`outputs: ${ports.outputs.join(', ')}`);
    return details.join('; ');
  }

  if (node.workflowId === '__junction__') {
    const portNames = (node.junctionNode?.ports || []).map((port) => port.name).filter(Boolean);
    return portNames.length > 0
      ? `junction node; ports: ${portNames.join(', ')}`
      : 'junction node';
  }

  if (node.workflowId === '__output__') {
    const portNames = (node.outputNode?.ports || []).map((port) => port.name).filter(Boolean);
    return portNames.length > 0
      ? `output collector; ports: ${portNames.join(', ')}`
      : 'output collector';
  }

  if (node.workflowId === '__variable__') {
    const inputName = node.variableNode?.inputName?.trim();
    if (node.variableNode?.exposeAsInput && inputName) {
      return `variable node; exposed input: ${inputName}`;
    }
    return 'variable node';
  }

  if (node.workflowId === '__get_variable__') {
    return node.getVariableNode?.targetNodeId
      ? `get-variable node; target: ${node.getVariableNode.targetNodeId}`
      : 'get-variable node';
  }

  if (node.workflowId === '__tool__') {
    return node.toolNode?.selectedTool
      ? `tool node; tool: ${node.toolNode.selectedTool}`
      : 'tool node';
  }

  if (node.workflowId.startsWith('comp:')) {
    return node.compositionRef?.compositionId
      ? `sub-pipeline node; composition: ${node.compositionRef.compositionId}`
      : 'sub-pipeline node';
  }

  const workflow = wfMap[node.id];
  if (workflow?.name) {
    return `workflow node; workflow: ${workflow.name}`;
  }

  return `node type: ${node.workflowId}`;
}

export function buildScriptAutoFixGraphContext(args: {
  nodeId: string;
  nodes: AutoFixNodeLike[];
  edges: AutoFixEdgeLike[];
  nodeOutputs: Record<string, Record<string, unknown>>;
  wfMap?: Record<string, AutoFixWorkflowLike>;
}): string {
  const { nodeId, nodes, edges, nodeOutputs, wfMap = {} } = args;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const currentNode = nodeById.get(nodeId);
  const incoming = edges.filter((edge) => edge.targetNodeId === nodeId);
  const outgoing = edges.filter((edge) => edge.sourceNodeId === nodeId);
  const lines: string[] = [];

  lines.push('Local graph context:');
  lines.push(`- Current node: ${currentNode?.label || nodeId} (${describeAutoFixNode(currentNode, wfMap)})`);

  if (incoming.length === 0) {
    lines.push('- Upstream connections: none');
  } else {
    lines.push('- Upstream connections:');
    for (const edge of incoming.slice(0, 8)) {
      const sourceNode = nodeById.get(edge.sourceNodeId);
      const sourceOutputs = nodeOutputs[edge.sourceNodeId] || {};
      const sourceValue = Object.prototype.hasOwnProperty.call(sourceOutputs, edge.sourcePort)
        ? summarizeAutoFixValue(sourceOutputs[edge.sourcePort])
        : '(not available yet)';
      lines.push(
        `  - ${sourceNode?.label || edge.sourceNodeId}.${edge.sourcePort} -> ${edge.targetPort}; ${describeAutoFixNode(sourceNode, wfMap)}; value: ${sourceValue}`
      );
    }
  }

  if (outgoing.length === 0) {
    lines.push('- Downstream consumers: none');
  } else {
    lines.push('- Downstream consumers:');
    for (const edge of outgoing.slice(0, 8)) {
      const targetNode = nodeById.get(edge.targetNodeId);
      lines.push(
        `  - ${edge.sourcePort} -> ${targetNode?.label || edge.targetNodeId}.${edge.targetPort}; ${describeAutoFixNode(targetNode, wfMap)}`
      );
    }
  }

  return lines.join('\n');
}