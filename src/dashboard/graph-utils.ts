/**
 * Graph Utilities
 *
 * Shared graph algorithms used by composition execution and app mode.
 * Extracted from composition-run.ts so both modules can reuse them.
 */

// ────────────────────────────────────────────────────────────────
//  Topological sort (Kahn's algorithm)
// ────────────────────────────────────────────────────────────────

export function topoSort(
  nodes: Array<{ id: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string[] {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n.id, []); inDeg.set(n.id, 0); }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const invalidEdges = edges.filter((edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId));
  if (invalidEdges.length > 0) {
    const sample = invalidEdges.slice(0, 3)
      .map((edge) => `${edge.sourceNodeId || '?'} -> ${edge.targetNodeId || '?'}`)
      .join(', ');
    throw new Error(`These workflows have invalid connections to missing steps. Check your connections: ${sample}`);
  }
  for (const e of edges) {
    adj.get(e.sourceNodeId)?.push(e.targetNodeId);
    inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) || 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDeg) { if (deg === 0) queue.push(id); }
  const result: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    result.push(nodeId);
    for (const neighbor of (adj.get(nodeId) || [])) {
      const newDeg = (inDeg.get(neighbor) || 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (result.length !== nodes.length) {
    throw new Error('These workflows form a loop and can\'t run in order. Check your connections.');
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
//  Gather inputs for a node via edge connections
// ────────────────────────────────────────────────────────────────

export function gatherInputVariables(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; sourcePort: string; targetNodeId: string; targetPort: string }>,
  nodeOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const edge of edges) {
    if (edge.targetNodeId !== nodeId) continue;
    const upstreamOutputs = nodeOutputs[edge.sourceNodeId];
    if (upstreamOutputs && edge.sourcePort in upstreamOutputs) {
      inputs[edge.targetPort] = upstreamOutputs[edge.sourcePort];
    }
  }
  return inputs;
}

// ────────────────────────────────────────────────────────────────
//  Downstream node discovery (transitive closure via BFS)
// ────────────────────────────────────────────────────────────────

export function getDownstreamNodes(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): Set<string> {
  const downstream = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (e.sourceNodeId === current && !downstream.has(e.targetNodeId)) {
        downstream.add(e.targetNodeId);
        queue.push(e.targetNodeId);
      }
    }
  }
  return downstream;
}

// ────────────────────────────────────────────────────────────────
//  Upstream node discovery (reverse BFS)
// ────────────────────────────────────────────────────────────────

export function getUpstreamNodes(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): Set<string> {
  const upstream = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (e.targetNodeId === current && !upstream.has(e.sourceNodeId)) {
        upstream.add(e.sourceNodeId);
        queue.push(e.sourceNodeId);
      }
    }
  }
  return upstream;
}

// ────────────────────────────────────────────────────────────────
//  Direct dependencies (immediate upstream/downstream)
// ────────────────────────────────────────────────────────────────

export function getDirectUpstream(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string[] {
  return [...new Set(edges.filter(e => e.targetNodeId === nodeId).map(e => e.sourceNodeId))];
}

export function getDirectDownstream(
  nodeId: string,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string[] {
  return [...new Set(edges.filter(e => e.sourceNodeId === nodeId).map(e => e.targetNodeId))];
}
