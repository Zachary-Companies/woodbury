interface EdgeRepairPortLike {
  name: string;
}

interface EdgeRepairScriptLike {
  code?: string;
  inputs?: EdgeRepairPortLike[];
  outputs?: EdgeRepairPortLike[];
}

interface EdgeRepairNodeLike {
  id: string;
  workflowId: string;
  label?: string;
  script?: EdgeRepairScriptLike;
  junctionNode?: { ports?: EdgeRepairPortLike[] };
  outputNode?: { ports?: EdgeRepairPortLike[] };
  variableNode?: { inputName?: string; exposeAsInput?: boolean };
  compositionRef?: { compositionId?: string };
}

interface EdgeRepairLike {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export interface ScriptEdgeRepairCandidate {
  edgeId: string;
  field: 'sourcePort' | 'targetPort';
  fromPort: string;
  toPort: string;
  reason: string;
}

function normalizePortName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function extractPortsFromCode(code: string | undefined, kind: 'input' | 'output'): string[] {
  const source = String(code || '');
  const regex = kind === 'input'
    ? /@input\s+\{[^}]+\}\s+([A-Za-z0-9_]+)/g
    : /@output\s+\{[^}]+\}\s+([A-Za-z0-9_]+)/g;
  return [...source.matchAll(regex)].map((match) => match[1]);
}

function uniqueNormalizedMatch(candidates: string[], rawValue: string): string | undefined {
  const normalized = normalizePortName(rawValue);
  if (!normalized) return undefined;
  const matches = candidates.filter((candidate) => normalizePortName(candidate) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function getNodeKnownPorts(
  node: EdgeRepairNodeLike | undefined,
  direction: 'input' | 'output',
  nodeOutputs: Record<string, Record<string, unknown>>,
): string[] {
  if (!node) return [];

  if (node.workflowId === '__script__') {
    const declared = direction === 'input' ? node.script?.inputs : node.script?.outputs;
    if (Array.isArray(declared) && declared.length > 0) {
      return declared.map((port) => String(port?.name || '')).filter(Boolean);
    }
    return extractPortsFromCode(node.script?.code, direction);
  }

  if (node.workflowId === '__junction__') {
    return (node.junctionNode?.ports || []).map((port) => String(port?.name || '')).filter(Boolean);
  }

  if (node.workflowId === '__output__' && direction === 'input') {
    return (node.outputNode?.ports || []).map((port) => String(port?.name || '')).filter(Boolean);
  }

  if (node.workflowId === '__variable__') {
    if (direction === 'output') return ['value', 'length', '__done__'];
    return ['set', 'push'];
  }

  if (node.workflowId === '__get_variable__') {
    return direction === 'output' ? ['value', 'length', '__done__'] : [];
  }

  if (node.workflowId === '__file_read__') {
    return direction === 'input'
      ? ['filePath']
      : ['content', 'isJson', 'size', 'filePath', '__done__'];
  }

  if (node.workflowId === '__file_write__') {
    return direction === 'input'
      ? ['filePath', 'content']
      : ['filePath', 'success', 'bytesWritten', '__done__'];
  }

  if (node.workflowId.startsWith('comp:')) {
    return [];
  }

  const runtimeOutputs = nodeOutputs[node.id];
  if (direction === 'output' && runtimeOutputs) {
    return Object.keys(runtimeOutputs);
  }

  return [];
}

export function proposeScriptNodeEdgeRepairs(args: {
  nodeId: string;
  nodes: EdgeRepairNodeLike[];
  edges: EdgeRepairLike[];
  nodeOutputs: Record<string, Record<string, unknown>>;
}): ScriptEdgeRepairCandidate[] {
  const { nodeId, nodes, edges, nodeOutputs } = args;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const currentNode = nodeById.get(nodeId);
  if (!currentNode || currentNode.workflowId !== '__script__') return [];

  const currentInputs = getNodeKnownPorts(currentNode, 'input', nodeOutputs);
  const currentOutputs = getNodeKnownPorts(currentNode, 'output', nodeOutputs);
  const currentInputSet = new Set(currentInputs);
  const currentOutputSet = new Set(currentOutputs);
  const repairs: ScriptEdgeRepairCandidate[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    if (edge.targetNodeId === nodeId) {
      if (currentInputs.length > 0 && !currentInputSet.has(edge.targetPort)) {
        const targetCandidate = uniqueNormalizedMatch(currentInputs, edge.targetPort)
          || uniqueNormalizedMatch(currentInputs, edge.sourcePort);
        if (targetCandidate && targetCandidate !== edge.targetPort) {
          const key = `${edge.id}:targetPort:${targetCandidate}`;
          if (!seen.has(key)) {
            repairs.push({
              edgeId: edge.id,
              field: 'targetPort',
              fromPort: edge.targetPort,
              toPort: targetCandidate,
              reason: `Incoming edge targets undeclared input "${edge.targetPort}"; script declares "${targetCandidate}"`,
            });
            seen.add(key);
          }
        }
      }

      const sourceNode = nodeById.get(edge.sourceNodeId);
      const sourceOutputs = getNodeKnownPorts(sourceNode, 'output', nodeOutputs);
      const sourceOutputSet = new Set(sourceOutputs);
      if (sourceOutputs.length > 0 && !sourceOutputSet.has(edge.sourcePort)) {
        const sourceCandidate = uniqueNormalizedMatch(sourceOutputs, edge.sourcePort)
          || uniqueNormalizedMatch(sourceOutputs, edge.targetPort);
        if (sourceCandidate && sourceCandidate !== edge.sourcePort) {
          const key = `${edge.id}:sourcePort:${sourceCandidate}`;
          if (!seen.has(key)) {
            repairs.push({
              edgeId: edge.id,
              field: 'sourcePort',
              fromPort: edge.sourcePort,
              toPort: sourceCandidate,
              reason: `Incoming edge reads undeclared source port "${edge.sourcePort}"; upstream node exposes "${sourceCandidate}"`,
            });
            seen.add(key);
          }
        }
      }
    }

    if (edge.sourceNodeId === nodeId) {
      if (currentOutputs.length > 0 && !currentOutputSet.has(edge.sourcePort)) {
        const sourceCandidate = uniqueNormalizedMatch(currentOutputs, edge.sourcePort)
          || uniqueNormalizedMatch(currentOutputs, edge.targetPort);
        if (sourceCandidate && sourceCandidate !== edge.sourcePort) {
          const key = `${edge.id}:sourcePort:${sourceCandidate}`;
          if (!seen.has(key)) {
            repairs.push({
              edgeId: edge.id,
              field: 'sourcePort',
              fromPort: edge.sourcePort,
              toPort: sourceCandidate,
              reason: `Outgoing edge uses undeclared output "${edge.sourcePort}"; script declares "${sourceCandidate}"`,
            });
            seen.add(key);
          }
        }
      }

      const targetNode = nodeById.get(edge.targetNodeId);
      const targetInputs = getNodeKnownPorts(targetNode, 'input', nodeOutputs);
      const targetInputSet = new Set(targetInputs);
      if (targetInputs.length > 0 && !targetInputSet.has(edge.targetPort)) {
        const targetCandidate = uniqueNormalizedMatch(targetInputs, edge.targetPort)
          || uniqueNormalizedMatch(targetInputs, edge.sourcePort);
        if (targetCandidate && targetCandidate !== edge.targetPort) {
          const key = `${edge.id}:targetPort:${targetCandidate}`;
          if (!seen.has(key)) {
            repairs.push({
              edgeId: edge.id,
              field: 'targetPort',
              fromPort: edge.targetPort,
              toPort: targetCandidate,
              reason: `Downstream edge targets undeclared input "${edge.targetPort}"; downstream node declares "${targetCandidate}"`,
            });
            seen.add(key);
          }
        }
      }
    }
  }

  return repairs;
}