interface PipelineDocumentationPortContract {
  name: string;
  type: string;
  description: string;
}

interface PipelineDocumentationDecompositionPlan {
  pipelineName?: string;
  targetOutputSummary?: string;
  targetOutputType?: string;
  targetOutputFields?: Array<{ name: string; type: string; description: string }>;
  subContracts?: unknown[];
  assemblyStrategy?: string;
  complexity?: 'simple' | 'moderate' | 'complex';
}

export interface GeneratedPipelineDocumentation {
  title: string;
  summary: string;
  markdown: string;
  request?: string;
}

interface PipelineDocumentationInterfaceInput {
  name: string;
  label?: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

interface PipelineDocumentationInterfaceOutput {
  name: string;
  type: string;
  description: string;
}

interface PipelineDocumentationInterfaceContract {
  inputs: PipelineDocumentationInterfaceInput[];
  outputs: PipelineDocumentationInterfaceOutput[];
}

function normalizePipelineDocumentationPortContracts(rawPorts: unknown): PipelineDocumentationPortContract[] {
  if (!Array.isArray(rawPorts)) return [];
  return rawPorts
    .filter((port): port is Record<string, unknown> => Boolean(port) && typeof port === 'object' && !Array.isArray(port))
    .map((port) => ({
      name: typeof port.name === 'string' ? port.name.trim() : '',
      type: typeof port.type === 'string' && port.type.trim() ? port.type.trim() : 'string',
      description: typeof port.description === 'string' ? port.description.trim() : '',
    }))
    .filter((port) => port.name.length > 0);
}

function getDocumentationNodeTypeLabel(node: any): string {
  if (!node || typeof node !== 'object') return 'Node';
  switch (node.workflowId) {
    case '__script__': return 'Script';
    case '__text__': return 'Text';
    case '__file_op__': return 'File Operation';
    case '__output__': return 'Output';
    case '__variable__': return 'Variable';
    case '__get_variable__': return 'Get Variable';
    case '__asset__': return 'Asset';
    case '__branch__': return 'Branch';
    case '__delay__': return 'Delay';
    case '__for_each__': return 'For Each';
    case '__switch__': return 'Switch';
    case '__gate__': return 'Gate';
    case '__approval_gate__': return 'Approval Gate';
    default:
      if (typeof node.workflowId === 'string' && node.workflowId.startsWith('comp:')) return 'Pipeline';
      return 'Node';
  }
}

function getDocumentationNodePorts(node: any, direction: 'input' | 'output'): PipelineDocumentationPortContract[] {
  if (!node || typeof node !== 'object') return [];
  if (node.workflowId === '__script__') {
    const ports = direction === 'input' ? node.script?.inputs : node.script?.outputs;
    return normalizePipelineDocumentationPortContracts(ports);
  }
  if (node.workflowId === '__text__') {
    return direction === 'output'
      ? [{ name: 'text', type: 'string', description: 'Constant text value' }]
      : [];
  }
  if (node.workflowId === '__file_op__') {
    const operation = node.fileOp?.operation || 'copy';
    const fileOpPorts: Record<string, { input: PipelineDocumentationPortContract[]; output: PipelineDocumentationPortContract[] }> = {
      copy: {
        input: [
          { name: 'sourcePath', type: 'string', description: 'Source path to copy from' },
          { name: 'destinationPath', type: 'string', description: 'Destination path to copy to' },
        ],
        output: [
          { name: 'outputPath', type: 'string', description: 'Copied file or folder path' },
          { name: 'success', type: 'boolean', description: 'Whether the copy completed' },
        ],
      },
      move: {
        input: [
          { name: 'sourcePath', type: 'string', description: 'Source path to move from' },
          { name: 'destinationPath', type: 'string', description: 'Destination path to move to' },
        ],
        output: [
          { name: 'outputPath', type: 'string', description: 'Moved file or folder path' },
          { name: 'success', type: 'boolean', description: 'Whether the move completed' },
        ],
      },
      delete: {
        input: [
          { name: 'filePath', type: 'string', description: 'Path to remove' },
        ],
        output: [
          { name: 'success', type: 'boolean', description: 'Whether the delete completed' },
        ],
      },
      mkdir: {
        input: [
          { name: 'folderPath', type: 'string', description: 'Folder path to create' },
        ],
        output: [
          { name: 'outputPath', type: 'string', description: 'Created folder path' },
          { name: 'success', type: 'boolean', description: 'Whether the folder was created' },
        ],
      },
      list: {
        input: [
          { name: 'folderPath', type: 'string', description: 'Folder path to enumerate' },
        ],
        output: [
          { name: 'files', type: 'string[]', description: 'Listed file paths' },
          { name: 'count', type: 'number', description: 'Number of listed files' },
        ],
      },
    };
    const portSet = fileOpPorts[operation] || fileOpPorts.copy;
    return direction === 'input' ? portSet.input : portSet.output;
  }
  if (node.workflowId === '__output__') {
    const ports = Array.isArray(node.outputNode?.ports) ? node.outputNode.ports : [];
    return normalizePipelineDocumentationPortContracts(ports);
  }
  if (node.workflowId === '__variable__') {
    return direction === 'output'
      ? [{
          name: node.variableNode?.outputName || 'value',
          type: node.variableNode?.type || 'any',
          description: node.variableNode?.description || 'Shared variable value',
        }]
      : [];
  }
  if (node.workflowId === '__get_variable__') {
    return direction === 'output'
      ? [{ name: 'value', type: 'any', description: 'Resolved variable value' }]
      : [];
  }
  return [];
}

export function buildGeneratedPipelineDocumentation(
  requestDescription: string,
  pipelineName: string,
  nodes: any[],
  edges: any[],
  decompositionPlan?: PipelineDocumentationDecompositionPlan | null,
  interfaceContract?: PipelineDocumentationInterfaceContract | null,
): GeneratedPipelineDocumentation {
  const trimmedRequest = String(requestDescription || '').trim();
  const summary = (
    decompositionPlan?.targetOutputSummary
    || decompositionPlan?.assemblyStrategy
    || trimmedRequest
    || `Generated pipeline with ${nodes.length} step${nodes.length === 1 ? '' : 's'}.`
  ).trim();
  const nodeById = new Map<string, any>();
  for (const node of nodes || []) {
    if (node && typeof node.id === 'string') nodeById.set(node.id, node);
  }

  const incomingPorts = new Set<string>();
  const outgoingPorts = new Set<string>();
  for (const edge of edges || []) {
    if (edge?.targetNodeId && edge?.targetPort) incomingPorts.add(`${edge.targetNodeId}:${edge.targetPort}`);
    if (edge?.sourceNodeId && edge?.sourcePort) outgoingPorts.add(`${edge.sourceNodeId}:${edge.sourcePort}`);
  }

  const externalInputs: string[] = [];
  const finalOutputs: string[] = [];
  const seenExternalInputs = new Set<string>();
  const seenFinalOutputs = new Set<string>();

  for (const node of nodes || []) {
    const label = node?.label || node?.script?.description || node?.id || 'Node';
    for (const port of getDocumentationNodePorts(node, 'input')) {
      const key = `${node.id}:${port.name}`;
      if (incomingPorts.has(key)) continue;
      const line = `${label}.${port.name} (${port.type || 'any'})${port.description ? ` - ${port.description}` : ''}`;
      if (!seenExternalInputs.has(line)) {
        seenExternalInputs.add(line);
        externalInputs.push(line);
      }
    }
    for (const port of getDocumentationNodePorts(node, 'output')) {
      const key = `${node.id}:${port.name}`;
      if (outgoingPorts.has(key)) continue;
      const line = `${label}.${port.name} (${port.type || 'any'})${port.description ? ` - ${port.description}` : ''}`;
      if (!seenFinalOutputs.has(line)) {
        seenFinalOutputs.add(line);
        finalOutputs.push(line);
      }
    }
  }

  const flowLines: string[] = [];
  for (const edge of edges || []) {
    const sourceNode = nodeById.get(edge?.sourceNodeId);
    const targetNode = nodeById.get(edge?.targetNodeId);
    if (!sourceNode || !targetNode) continue;
    flowLines.push(`${sourceNode.label || sourceNode.id}.${edge.sourcePort} -> ${targetNode.label || targetNode.id}.${edge.targetPort}`);
  }

  const markdownSections: string[] = [
    `# ${pipelineName || 'Generated Pipeline'}`,
    '',
    '## Overview',
    summary,
  ];

  if (trimmedRequest) {
    markdownSections.push('', '## Request', trimmedRequest);
  }
  if (decompositionPlan?.assemblyStrategy) {
    markdownSections.push('', '## Assembly Strategy', decompositionPlan.assemblyStrategy);
  }

  const exactInputs = Array.isArray(interfaceContract?.inputs) ? interfaceContract.inputs : [];
  const exactOutputs = Array.isArray(interfaceContract?.outputs) ? interfaceContract.outputs : [];
  if (exactInputs.length > 0 || exactOutputs.length > 0) {
    markdownSections.push('', '## Interface Contract');
    markdownSections.push('Inputs:');
    if (exactInputs.length > 0) {
      exactInputs.forEach((input) => {
        const qualifiers: string[] = [];
        if (input.required) qualifiers.push('required');
        if (input.default !== undefined) qualifiers.push(`default=${JSON.stringify(input.default)}`);
        const qualifierText = qualifiers.length > 0 ? ` [${qualifiers.join(', ')}]` : '';
        markdownSections.push(`- ${input.name} (${input.type || 'string'})${qualifierText}: ${input.description || input.label || 'No description provided.'}`);
      });
    } else {
      markdownSections.push('- None');
    }
    markdownSections.push('', 'Outputs:');
    if (exactOutputs.length > 0) {
      exactOutputs.forEach((output) => {
        markdownSections.push(`- ${output.name} (${output.type || 'string'}): ${output.description || 'No description provided.'}`);
      });
    } else {
      markdownSections.push('- None');
    }
  }

  markdownSections.push('', '## Steps');
  (nodes || []).forEach((node, index) => {
    const typeLabel = getDocumentationNodeTypeLabel(node);
    const description = (node?.script?.description || node?.label || `${typeLabel} step`).trim();
    const inputPorts = getDocumentationNodePorts(node, 'input');
    const outputPorts = getDocumentationNodePorts(node, 'output');
    markdownSections.push(`### ${index + 1}. ${node?.label || `${typeLabel} ${index + 1}`}`);
    markdownSections.push(`Type: ${typeLabel}`);
    markdownSections.push(description);
    if (inputPorts.length > 0) {
      markdownSections.push('', 'Inputs:');
      inputPorts.forEach((port) => {
        markdownSections.push(`- ${port.name} (${port.type || 'any'}): ${port.description || 'No description provided.'}`);
      });
    }
    if (outputPorts.length > 0) {
      markdownSections.push('', 'Outputs:');
      outputPorts.forEach((port) => {
        markdownSections.push(`- ${port.name} (${port.type || 'any'}): ${port.description || 'No description provided.'}`);
      });
    }
    markdownSections.push('');
  });

  if (flowLines.length > 0) {
    markdownSections.push('## Data Flow');
    flowLines.forEach((line) => {
      markdownSections.push(`- ${line}`);
    });
    markdownSections.push('');
  }

  markdownSections.push('## External Inputs');
  if (externalInputs.length > 0) {
    externalInputs.forEach((line) => {
      markdownSections.push(`- ${line}`);
    });
  } else {
    markdownSections.push('- No unconnected external inputs were detected.');
  }
  markdownSections.push('');

  markdownSections.push('## Final Outputs');
  if (finalOutputs.length > 0) {
    finalOutputs.forEach((line) => {
      markdownSections.push(`- ${line}`);
    });
  } else {
    markdownSections.push('- No terminal outputs were detected.');
  }

  return {
    title: pipelineName || 'Generated Pipeline',
    summary,
    markdown: markdownSections.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    request: trimmedRequest || undefined,
  };
}