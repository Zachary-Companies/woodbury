/**
 * compositions-execution.js
 *
 * Pipeline execution, batch runs, scheduling, auto-layout, minimap,
 * approval dialogs, and node state visualisation.
 *
 * Depends on: compositions-core.js, compositions-canvas.js,
 *             compositions-properties.js
 *
 * Contents:
 *   - Auto-layout (layoutNodesInternal, autoLayoutNodes)
 *   - Minimap (updateMinimap, wireUpMinimap)
 *   - Composition run (clientTopoSort, startCompositionRun, startCompRunPolling,
 *     stopCompRunPolling, pollCompRunStatus, cancelCompositionRun)
 *   - Batch execution (showBatchConfigModal, startBatchRun, startBatchPolling,
 *     stopBatchPolling, pollBatchStatus)
 *   - Approval gate dialog (showApprovalDialog, hideApprovalDialog)
 *   - Node execution state (updateNodeExecutionState, clearNodeError,
 *     repairScriptNode, injectNodeErrorDisplay, injectNodeLogsDisplay,
 *     updateNodeRetryBadge, removeNodeRetryBadge, updateNodeStepProgress,
 *     clearNodeExecutionStates, clearNonErrorExecutionStates)
 *   - Scheduling helpers (scheduleData, fetchSchedules, cronToHuman)
 *   - Tool docs modal (showToolDocsModal, renderToolDocsModal)
 *   - Schedule modal (showScheduleModal, renderScheduleList,
 *     wireScheduleListEvents, closeScheduleModal)
 *   - initCompositions (entry point, window.initCompositions)
 */

// ── Cross-Module Contracts ────────────────────────────────────
//    These typedefs define the data shapes passed to chat.js
//    via window.notifyChatOfPipelineFailure(). They must match
//    the FailedNodeInfo / PipelineFailure typedefs in chat.js.

/**
 * A single failed node within a pipeline run.
 * @typedef {Object} FailedNodeInfo
 * @property {string} nodeId      - Composition node ID
 * @property {string} nodeLabel   - Human-readable node label
 * @property {string} error       - Raw error message
 * @property {boolean} isScript   - Whether this is a script node
 * @property {string} nodeType    - The node's workflowId (e.g. '__script__')
 */

/**
 * Failure payload passed to chat.js via window.notifyChatOfPipelineFailure().
 * @typedef {Object} PipelineFailure
 * @property {string} compositionId
 * @property {string} compositionName
 * @property {FailedNodeInfo[]} failedNodes
 * @property {number} timestamp   - Date.now() when the failure occurred
 */

/**
 * JSON returned by POST /api/compositions/explain-error.
 * @typedef {Object} ExplainErrorResponse
 * @property {string} summary    - One-sentence plain-English explanation
 * @property {string} suggestion - One-sentence suggested next step
 */

// ── Auto-Layout ──────────────────────────────────────────────

// ── Layout Algorithms ──────────────────────────────────────────
//
// All layered algorithms use the Sugiyama framework:
//   1. Assign layers (longest-path)
//   2. Order nodes within layers (barycenter heuristic, multi-sweep)
//   3. Position nodes (place at barycenter of neighbors, push apart to avoid overlap)
//
// The multi-sweep barycenter ordering is the key to reducing edge crossings.
// We do alternating forward/backward sweeps, each time placing nodes at the
// weighted average position of their connected neighbors in the adjacent layer.

var currentLayoutAlgorithm = 'layered-lr';

// ── Shared helpers ──

function layoutBuildAdjacency() {
  var adj = {};
  var inAdj = {};
  compData.nodes.forEach(function(n) { adj[n.id] = []; inAdj[n.id] = []; });
  compData.edges.forEach(function(e) {
    if (adj[e.sourceNodeId]) adj[e.sourceNodeId].push(e.targetNodeId);
    if (inAdj[e.targetNodeId]) inAdj[e.targetNodeId].push(e.sourceNodeId);
  });
  return { adj: adj, inAdj: inAdj };
}

function layoutAssignLayers() {
  var graph = layoutBuildAdjacency();
  var layers = {};
  var visited = {};

  function assignLayer(nodeId) {
    if (visited[nodeId]) return layers[nodeId];
    visited[nodeId] = true;
    var maxPredLayer = -1;
    compData.edges.forEach(function(e) {
      if (e.targetNodeId === nodeId && graph.adj[e.sourceNodeId]) {
        maxPredLayer = Math.max(maxPredLayer, assignLayer(e.sourceNodeId));
      }
    });
    layers[nodeId] = maxPredLayer + 1;
    return layers[nodeId];
  }

  compData.nodes.forEach(function(n) { assignLayer(n.id); });

  var layerGroups = {};
  var maxLayer = 0;
  compData.nodes.forEach(function(n) {
    var layer = layers[n.id] || 0;
    if (!layerGroups[layer]) layerGroups[layer] = [];
    layerGroups[layer].push(n);
    maxLayer = Math.max(maxLayer, layer);
  });

  return { layers: layers, layerGroups: layerGroups, maxLayer: maxLayer, graph: graph };
}

/** Count edge crossings between two adjacent layers */
function countCrossings(layerA, layerB, edges) {
  // Build ordered pairs: for each edge from layerA[i] to layerB[j], record (i, j)
  var posA = {};
  var posB = {};
  layerA.forEach(function(n, i) { posA[n.id] = i; });
  layerB.forEach(function(n, i) { posB[n.id] = i; });

  var pairs = [];
  edges.forEach(function(e) {
    if (posA[e.sourceNodeId] !== undefined && posB[e.targetNodeId] !== undefined) {
      pairs.push([posA[e.sourceNodeId], posB[e.targetNodeId]]);
    }
    // Also check reverse (target in A, source in B) for bidirectional counting
    if (posA[e.targetNodeId] !== undefined && posB[e.sourceNodeId] !== undefined) {
      pairs.push([posA[e.targetNodeId], posB[e.sourceNodeId]]);
    }
  });

  // Count inversions: crossing happens when (a1 < a2 but b1 > b2) or vice versa
  var crossings = 0;
  for (var i = 0; i < pairs.length; i++) {
    for (var j = i + 1; j < pairs.length; j++) {
      if ((pairs[i][0] < pairs[j][0] && pairs[i][1] > pairs[j][1]) ||
          (pairs[i][0] > pairs[j][0] && pairs[i][1] < pairs[j][1])) {
        crossings++;
      }
    }
  }
  return crossings;
}

/**
 * Barycenter ordering: multi-sweep crossing reduction.
 * For each layer, compute the barycenter (average position of neighbors in the
 * adjacent fixed layer) and sort by it. Alternating forward/backward sweeps
 * progressively reduce crossings.
 *
 * @param {object} info - from layoutAssignLayers()
 * @param {'x'|'y'} axis - which axis the layers are spread along
 * @param {number} spacing - node spacing within a layer
 */
function barycentricOrdering(info, axis, spacing) {
  var SWEEPS = 24;  // more sweeps = fewer crossings (diminishing returns after ~20)
  var otherAxis = axis === 'x' ? 'y' : 'x';

  // Initial assignment: give each node a position index within its layer
  for (var l = 0; l <= info.maxLayer; l++) {
    var grp = info.layerGroups[l] || [];
    for (var gi = 0; gi < grp.length; gi++) {
      grp[gi]._layerPos = gi;
    }
  }

  for (var sweep = 0; sweep < SWEEPS; sweep++) {
    var forward = sweep % 2 === 0;
    var start = forward ? 1 : info.maxLayer - 1;
    var end = forward ? info.maxLayer + 1 : -1;
    var step = forward ? 1 : -1;

    for (var layer = start; layer !== end; layer += step) {
      var group = info.layerGroups[layer] || [];
      if (group.length === 0) continue;

      // Compute barycenter for each node from the fixed adjacent layer
      group.forEach(function(node) {
        var neighborPositions = [];

        compData.edges.forEach(function(e) {
          var neighborId = null;
          if (e.targetNodeId === node.id) neighborId = e.sourceNodeId;
          else if (e.sourceNodeId === node.id) neighborId = e.targetNodeId;
          if (!neighborId) return;

          // Check if neighbor is in an adjacent layer
          var neighborLayer = info.layers[neighborId];
          if (neighborLayer === undefined) return;
          var adjLayer = forward ? layer - 1 : layer + 1;
          if (neighborLayer !== adjLayer) return;

          var neighborNode = compData.nodes.find(function(n) { return n.id === neighborId; });
          if (neighborNode) neighborPositions.push(neighborNode._layerPos);
        });

        if (neighborPositions.length > 0) {
          // Use barycenter (mean) — more stable than median for crossing reduction
          var sum = 0;
          for (var np = 0; np < neighborPositions.length; np++) sum += neighborPositions[np];
          node._barycenter = sum / neighborPositions.length;
        } else {
          node._barycenter = node._layerPos; // Keep current position
        }
      });

      // Sort by barycenter
      group.sort(function(a, b) { return a._barycenter - b._barycenter; });

      // Update layer positions
      for (var gi2 = 0; gi2 < group.length; gi2++) {
        group[gi2]._layerPos = gi2;
      }
      info.layerGroups[layer] = group;
    }
  }

  // Clean up temp properties
  compData.nodes.forEach(function(n) {
    delete n._layerPos;
    delete n._barycenter;
  });
}

/**
 * After barycenter ordering, position nodes to minimize edge length
 * while keeping minimum spacing. Uses priority placement: nodes with
 * more edges get positioned closer to the barycenter of their neighbors.
 */
function positionNodesInLayer(layerGroup, layerIndex, axis, spacing, info) {
  if (!layerGroup || layerGroup.length === 0) return;
  var otherAxis = axis === 'x' ? 'y' : 'x';

  // Compute ideal position for each node (barycenter of connected neighbors)
  layerGroup.forEach(function(node) {
    var neighborCoords = [];
    compData.edges.forEach(function(e) {
      var neighborId = null;
      if (e.targetNodeId === node.id) neighborId = e.sourceNodeId;
      else if (e.sourceNodeId === node.id) neighborId = e.targetNodeId;
      if (!neighborId) return;

      var neighborNode = compData.nodes.find(function(n) { return n.id === neighborId; });
      if (neighborNode && neighborNode.position[otherAxis] !== undefined) {
        neighborCoords.push(neighborNode.position[otherAxis]);
      }
    });

    if (neighborCoords.length > 0) {
      var sum = 0;
      for (var nc = 0; nc < neighborCoords.length; nc++) sum += neighborCoords[nc];
      node._idealPos = sum / neighborCoords.length;
    } else {
      node._idealPos = null;
    }
  });

  // Place nodes respecting order and minimum spacing
  // Start from the top, pushing down as needed
  var positions = [];
  for (var i = 0; i < layerGroup.length; i++) {
    var ideal = layerGroup[i]._idealPos;
    var minPos = i === 0 ? 100 : positions[i - 1] + spacing;

    if (ideal !== null && ideal >= minPos) {
      positions.push(ideal);
    } else {
      positions.push(minPos);
    }
  }

  // Compact pass: pull nodes up toward their ideal positions
  // (backward sweep to close gaps)
  for (var j = positions.length - 2; j >= 0; j--) {
    var ideal2 = layerGroup[j]._idealPos;
    var maxPos = positions[j + 1] - spacing;
    if (ideal2 !== null && ideal2 <= maxPos && ideal2 >= (j === 0 ? 100 : positions[j - 1] + spacing)) {
      positions[j] = ideal2;
    }
  }

  // Apply positions
  for (var k = 0; k < layerGroup.length; k++) {
    layerGroup[k].position[otherAxis] = Math.round(positions[k]);
    delete layerGroup[k]._idealPos;
  }
}

// ── Layered Left-to-Right (Sugiyama with crossing reduction) ──
function layoutLayeredLR() {
  if (!compData || compData.nodes.length === 0) return;
  var info = layoutAssignLayers();

  var layerSpacing = 350;
  var nodeSpacing = 140;

  // Phase 1: Assign X based on layer
  for (var layer = 0; layer <= info.maxLayer; layer++) {
    var grp = info.layerGroups[layer] || [];
    for (var idx = 0; idx < grp.length; idx++) {
      grp[idx].position.x = 100 + layer * layerSpacing;
      grp[idx].position.y = 100 + idx * nodeSpacing; // initial Y
    }
  }

  // Phase 2: Multi-sweep barycentric ordering (reduces crossings)
  barycentricOrdering(info, 'x', nodeSpacing);

  // Phase 3: Position nodes within layers at ideal Y coordinates
  // Do two passes (forward then backward) for better results
  for (var pass = 0; pass < 2; pass++) {
    for (var l2 = 0; l2 <= info.maxLayer; l2++) {
      var grp2 = info.layerGroups[l2] || [];
      // Assign X (stays fixed)
      for (var g2 = 0; g2 < grp2.length; g2++) {
        grp2[g2].position.x = 100 + l2 * layerSpacing;
      }
      positionNodesInLayer(grp2, l2, 'x', nodeSpacing, info);
    }
  }
}

// ── Layered Top-to-Bottom (Sugiyama with crossing reduction) ──
function layoutLayeredTB() {
  if (!compData || compData.nodes.length === 0) return;
  var info = layoutAssignLayers();

  var layerSpacing = 220;
  var nodeSpacing = 280;

  // Phase 1: Assign Y based on layer, initial X
  for (var layer = 0; layer <= info.maxLayer; layer++) {
    var grp = info.layerGroups[layer] || [];
    for (var idx = 0; idx < grp.length; idx++) {
      grp[idx].position.y = 100 + layer * layerSpacing;
      grp[idx].position.x = 100 + idx * nodeSpacing;
    }
  }

  // Phase 2: Multi-sweep barycentric ordering
  barycentricOrdering(info, 'y', nodeSpacing);

  // Phase 3: Position nodes at ideal X coordinates
  for (var pass = 0; pass < 2; pass++) {
    for (var l2 = 0; l2 <= info.maxLayer; l2++) {
      var grp2 = info.layerGroups[l2] || [];
      for (var g2 = 0; g2 < grp2.length; g2++) {
        grp2[g2].position.y = 100 + l2 * layerSpacing;
      }
      positionNodesInLayer(grp2, l2, 'y', nodeSpacing, info);
    }
  }
}

// ── Compact Grid ──
function layoutCompactGrid() {
  if (!compData || compData.nodes.length === 0) return;
  var cols = Math.ceil(Math.sqrt(compData.nodes.length));
  var nodeSpacingX = 320;
  var nodeSpacingY = 200;

  // Sort nodes by topological order for better visual flow
  var info = layoutAssignLayers();
  var ordered = [];
  for (var layer = 0; layer <= info.maxLayer; layer++) {
    var grp = info.layerGroups[layer] || [];
    for (var gi = 0; gi < grp.length; gi++) ordered.push(grp[gi]);
  }

  for (var i = 0; i < ordered.length; i++) {
    var col = i % cols;
    var row = Math.floor(i / cols);
    ordered[i].position.x = 100 + col * nodeSpacingX;
    ordered[i].position.y = 100 + row * nodeSpacingY;
  }
}

// ── Force-Directed (spring model with directional bias + edge routing) ──
function layoutForceDirected() {
  if (!compData || compData.nodes.length === 0) return;
  var nodes = compData.nodes;
  var edges = compData.edges;

  // Use layered assignment to seed initial positions (better than circular)
  var info = layoutAssignLayers();
  for (var l = 0; l <= info.maxLayer; l++) {
    var grp = info.layerGroups[l] || [];
    for (var gi = 0; gi < grp.length; gi++) {
      grp[gi].position.x = 200 + l * 300 + (Math.random() - 0.5) * 40;
      grp[gi].position.y = 200 + gi * 150 + (Math.random() - 0.5) * 40;
    }
  }

  var nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = n; });

  var repulsion = 120000;
  var attraction = 0.004;
  var damping = 0.85;
  var iterations = 300;
  var dirBias = 0.6; // bias for downstream nodes to be to the right

  // Velocity storage
  var vx = {}, vy = {};
  nodes.forEach(function(n) { vx[n.id] = 0; vy[n.id] = 0; });

  for (var iter = 0; iter < iterations; iter++) {
    var temp = 1.0 - (iter / iterations) * 0.7; // simulated annealing

    // Repulsion between all node pairs
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var dx = nodes[j].position.x - nodes[i].position.x;
        var dy = nodes[j].position.y - nodes[i].position.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var force = repulsion / (dist * dist);
        var fx = (dx / dist) * force * temp;
        var fy = (dy / dist) * force * temp;
        vx[nodes[i].id] -= fx;
        vy[nodes[i].id] -= fy;
        vx[nodes[j].id] += fx;
        vy[nodes[j].id] += fy;
      }
    }

    // Attraction along edges + directional bias
    for (var k = 0; k < edges.length; k++) {
      var src = nodeMap[edges[k].sourceNodeId];
      var tgt = nodeMap[edges[k].targetNodeId];
      if (!src || !tgt) continue;
      var edx = tgt.position.x - src.position.x;
      var edy = tgt.position.y - src.position.y;
      var eDist = Math.sqrt(edx * edx + edy * edy) || 1;
      var eForce = eDist * attraction * temp;
      vx[src.id] += (edx / eDist) * eForce;
      vy[src.id] += (edy / eDist) * eForce;
      vx[tgt.id] -= (edx / eDist) * eForce;
      vy[tgt.id] -= (edy / eDist) * eForce;

      // Directional bias: target should be to the right of source
      if (edx < 100) {
        var push = dirBias * temp * (100 - edx) * 0.01;
        vx[src.id] -= push;
        vx[tgt.id] += push;
      }
    }

    // Edge-edge repulsion: push nodes apart when their edges would overlap
    for (var e1 = 0; e1 < edges.length; e1++) {
      for (var e2 = e1 + 1; e2 < edges.length; e2++) {
        var s1 = nodeMap[edges[e1].sourceNodeId];
        var t1 = nodeMap[edges[e1].targetNodeId];
        var s2 = nodeMap[edges[e2].sourceNodeId];
        var t2 = nodeMap[edges[e2].targetNodeId];
        if (!s1 || !t1 || !s2 || !t2) continue;

        // Check if edges share a node — skip (they'll diverge naturally)
        if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) continue;

        // Check if midpoints are close
        var mid1x = (s1.position.x + t1.position.x) / 2;
        var mid1y = (s1.position.y + t1.position.y) / 2;
        var mid2x = (s2.position.x + t2.position.x) / 2;
        var mid2y = (s2.position.y + t2.position.y) / 2;
        var mdx = mid2x - mid1x;
        var mdy = mid2y - mid1y;
        var midDist = Math.sqrt(mdx * mdx + mdy * mdy) || 1;

        if (midDist < 200) {
          var edgeRepulse = 3000 / (midDist * midDist) * temp;
          // Push the target nodes apart vertically
          var pushY = (mdy / midDist) * edgeRepulse;
          if (Math.abs(pushY) < 0.5) pushY = mdy >= 0 ? edgeRepulse : -edgeRepulse;
          vy[t1.id] -= pushY * 0.5;
          vy[t2.id] += pushY * 0.5;
        }
      }
    }

    // Apply velocities with damping
    nodes.forEach(function(n) {
      vx[n.id] *= damping;
      vy[n.id] *= damping;
      // Clamp max velocity
      var maxV = 50 * temp;
      vx[n.id] = Math.max(-maxV, Math.min(maxV, vx[n.id]));
      vy[n.id] = Math.max(-maxV, Math.min(maxV, vy[n.id]));
      n.position.x += vx[n.id];
      n.position.y += vy[n.id];
    });
  }

  // Normalize positions so top-left starts at (100, 100)
  var minX = Infinity, minY = Infinity;
  nodes.forEach(function(n) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
  });
  nodes.forEach(function(n) {
    n.position.x = Math.round(n.position.x - minX + 100);
    n.position.y = Math.round(n.position.y - minY + 100);
  });
}

// ── Orthogonal (right-angle edges, grid-aligned) ──
function layoutOrthogonal() {
  if (!compData || compData.nodes.length === 0) return;
  var info = layoutAssignLayers();

  // Use wider spacing to leave room for orthogonal edge channels
  var layerSpacing = 400;
  var nodeSpacing = 180;
  var channelGap = 30; // gap between parallel edge channels

  // Phase 1: Use barycentric ordering
  for (var layer = 0; layer <= info.maxLayer; layer++) {
    var grp = info.layerGroups[layer] || [];
    for (var idx = 0; idx < grp.length; idx++) {
      grp[idx].position.x = 100 + layer * layerSpacing;
      grp[idx].position.y = 100 + idx * nodeSpacing;
    }
  }

  barycentricOrdering(info, 'x', nodeSpacing);

  // Phase 2: Position at barycenters
  for (var pass = 0; pass < 3; pass++) {
    for (var l2 = 0; l2 <= info.maxLayer; l2++) {
      var grp2 = info.layerGroups[l2] || [];
      for (var g2 = 0; g2 < grp2.length; g2++) {
        grp2[g2].position.x = 100 + l2 * layerSpacing;
      }
      positionNodesInLayer(grp2, l2, 'x', nodeSpacing, info);
    }
  }

  // Phase 3: Identify edges that span multiple layers (long edges)
  // and add extra vertical spacing to avoid overlaps
  var edgeChannels = {}; // layer -> number of long edges passing through
  compData.edges.forEach(function(e) {
    var srcLayer = info.layers[e.sourceNodeId] || 0;
    var tgtLayer = info.layers[e.targetNodeId] || 0;
    var minL = Math.min(srcLayer, tgtLayer);
    var maxL = Math.max(srcLayer, tgtLayer);
    if (maxL - minL > 1) {
      for (var ml = minL + 1; ml < maxL; ml++) {
        edgeChannels[ml] = (edgeChannels[ml] || 0) + 1;
      }
    }
  });

  // Widen layers that have many pass-through edges
  var xOffset = 100;
  for (var layer3 = 0; layer3 <= info.maxLayer; layer3++) {
    var grp3 = info.layerGroups[layer3] || [];
    for (var g3 = 0; g3 < grp3.length; g3++) {
      grp3[g3].position.x = xOffset;
    }
    var channels = edgeChannels[layer3] || 0;
    xOffset += layerSpacing + channels * channelGap;
  }
}

// ── Radial (concentric circles from roots) ──
function layoutRadial() {
  if (!compData || compData.nodes.length === 0) return;
  var info = layoutAssignLayers();

  var centerX = 600;
  var centerY = 500;
  var ringSpacing = 200;
  var minArcSpacing = 120; // min arc distance between nodes in same ring

  for (var layer = 0; layer <= info.maxLayer; layer++) {
    var grp = info.layerGroups[layer] || [];
    if (grp.length === 0) continue;

    if (layer === 0) {
      // Root nodes at center (or slightly spread if multiple)
      if (grp.length === 1) {
        grp[0].position.x = centerX;
        grp[0].position.y = centerY;
      } else {
        var rootSpread = Math.min(80, 200 / grp.length);
        for (var ri = 0; ri < grp.length; ri++) {
          var rootAngle = (2 * Math.PI * ri) / grp.length - Math.PI / 2;
          grp[ri].position.x = Math.round(centerX + Math.cos(rootAngle) * rootSpread);
          grp[ri].position.y = Math.round(centerY + Math.sin(rootAngle) * rootSpread);
        }
      }
      continue;
    }

    var radius = layer * ringSpacing;
    var circumference = 2 * Math.PI * radius;
    var arcPerNode = Math.max(minArcSpacing, circumference / grp.length);
    var totalArc = arcPerNode * grp.length;
    var arcFraction = Math.min(1, totalArc / circumference);
    var startAngle = -Math.PI / 2 - (arcFraction * Math.PI); // start from top

    // Sort by barycenter angle of parents
    grp.forEach(function(node) {
      var parentAngles = [];
      compData.edges.forEach(function(e) {
        if (e.targetNodeId === node.id) {
          var parent = compData.nodes.find(function(n) { return n.id === e.sourceNodeId; });
          if (parent) {
            parentAngles.push(Math.atan2(parent.position.y - centerY, parent.position.x - centerX));
          }
        }
      });
      if (parentAngles.length > 0) {
        var sum = 0;
        for (var pa = 0; pa < parentAngles.length; pa++) sum += parentAngles[pa];
        node._parentAngle = sum / parentAngles.length;
      } else {
        node._parentAngle = 0;
      }
    });
    grp.sort(function(a, b) { return a._parentAngle - b._parentAngle; });

    var angleStep = (2 * Math.PI * arcFraction) / Math.max(1, grp.length - 1);
    for (var gi = 0; gi < grp.length; gi++) {
      var angle = startAngle + gi * angleStep;
      grp[gi].position.x = Math.round(centerX + Math.cos(angle) * radius);
      grp[gi].position.y = Math.round(centerY + Math.sin(angle) * radius);
      delete grp[gi]._parentAngle;
    }
  }
}

// ── Layout dispatch ──

var layoutAlgorithms = {
  'layered-lr': { fn: layoutLayeredLR, label: 'Left → Right', icon: '→' },
  'layered-tb': { fn: layoutLayeredTB, label: 'Top → Bottom', icon: '↓' },
  'orthogonal': { fn: layoutOrthogonal, label: 'Orthogonal', icon: '⊞' },
  'force': { fn: layoutForceDirected, label: 'Force-Directed', icon: '⚛' },
  'radial': { fn: layoutRadial, label: 'Radial', icon: '◎' },
  'compact': { fn: layoutCompactGrid, label: 'Compact Grid', icon: '▦' },
};

function layoutNodesInternal(algorithm) {
  var algo = algorithm || currentLayoutAlgorithm;
  var entry = layoutAlgorithms[algo];
  if (entry) {
    currentLayoutAlgorithm = algo;
    entry.fn();
  } else {
    layoutLayeredLR();
  }
}

function autoLayoutNodes(algorithm) {
  if (!compData || compData.nodes.length === 0) return;
  pushUndoSnapshot();
  layoutNodesInternal(algorithm);
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  fitToView();
  updateMinimap();
}

// ── Minimap ──────────────────────────────────────────────────

function updateMinimap() {
  var canvas = document.querySelector('#comp-minimap-canvas');
  var viewport = document.querySelector('#comp-minimap-viewport');
  if (!canvas || !viewport || !compData || compData.nodes.length === 0) {
    if (canvas) {
      var ctx2 = canvas.getContext('2d');
      ctx2.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (viewport) viewport.style.display = 'none';
    return;
  }

  viewport.style.display = '';
  var ctx = canvas.getContext('2d');
  var cw = canvas.width;
  var ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Calculate bounding box
  var nodeW = 200, nodeH = 100;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < compData.nodes.length; i++) {
    var n = compData.nodes[i];
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + nodeW);
    maxY = Math.max(maxY, n.position.y + nodeH);
  }

  var padding = 50;
  minX -= padding; minY -= padding;
  maxX += padding; maxY += padding;
  var graphW = maxX - minX;
  var graphH = maxY - minY;
  var scale = Math.min(cw / graphW, ch / graphH);

  // Draw edges
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = 1;
  for (var j = 0; j < compData.edges.length; j++) {
    var edge = compData.edges[j];
    var src = compData.nodes.find(function(nd) { return nd.id === edge.sourceNodeId; });
    var tgt = compData.nodes.find(function(nd) { return nd.id === edge.targetNodeId; });
    if (src && tgt) {
      ctx.beginPath();
      ctx.moveTo((src.position.x + nodeW - minX) * scale, (src.position.y + nodeH / 2 - minY) * scale);
      ctx.lineTo((tgt.position.x - minX) * scale, (tgt.position.y + nodeH / 2 - minY) * scale);
      ctx.stroke();
    }
  }

  // Draw nodes
  for (var k = 0; k < compData.nodes.length; k++) {
    var node = compData.nodes[k];
    var rx = (node.position.x - minX) * scale;
    var ry = (node.position.y - minY) * scale;
    var rw = Math.max(nodeW * scale, 4);
    var rh = Math.max(nodeH * scale, 3);

    ctx.fillStyle = selectedNodes.has(node.id) ? '#7c3aed' : '#334155';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = '#475569';
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // Viewport indicator
  var wrap = document.querySelector('#comp-canvas-wrap');
  if (!wrap) return;
  var wrapRect = wrap.getBoundingClientRect();

  var visLeft = (-canvasState.panX) / canvasState.zoom;
  var visTop = (-canvasState.panY) / canvasState.zoom;
  var visW = wrapRect.width / canvasState.zoom;
  var visH = wrapRect.height / canvasState.zoom;

  var vl = (visLeft - minX) * scale;
  var vt = (visTop - minY) * scale;
  var vw = visW * scale;
  var vh = visH * scale;

  viewport.style.left = Math.max(0, vl) + 'px';
  viewport.style.top = Math.max(0, vt) + 'px';
  viewport.style.width = Math.min(Math.max(vw, 10), cw) + 'px';
  viewport.style.height = Math.min(Math.max(vh, 8), ch) + 'px';

  // Store mapping for click-to-pan
  canvas._minimapScale = scale;
  canvas._minimapMinX = minX;
  canvas._minimapMinY = minY;
}

function wireUpMinimap() {
  var canvas = document.querySelector('#comp-minimap-canvas');
  if (!canvas) return;

  canvas.addEventListener('mousedown', function(e) {
    e.stopPropagation();
    var rect = canvas.getBoundingClientRect();

    function panToMinimapPoint(clientX, clientY) {
      var mx = clientX - rect.left;
      var my = clientY - rect.top;
      var scale = canvas._minimapScale || 1;
      var mmMinX = canvas._minimapMinX || 0;
      var mmMinY = canvas._minimapMinY || 0;

      var graphX = mx / scale + mmMinX;
      var graphY = my / scale + mmMinY;

      var wrap = document.querySelector('#comp-canvas-wrap');
      var wrapRect = wrap.getBoundingClientRect();
      canvasState.panX = -(graphX * canvasState.zoom - wrapRect.width / 2);
      canvasState.panY = -(graphY * canvasState.zoom - wrapRect.height / 2);
      applyCanvasTransform();
      updateEdgePositions();
      updateMinimap();
    }

    panToMinimapPoint(e.clientX, e.clientY);

    function onMove(e2) { panToMinimapPoint(e2.clientX, e2.clientY); }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Composition Run / Progress ───────────────────────────────

function clientTopoSort() {
  if (!compData) return null;
  var adj = {};
  var inDeg = {};
  compData.nodes.forEach(function(n) { adj[n.id] = []; inDeg[n.id] = 0; });
  compData.edges.forEach(function(e) {
    if (adj[e.sourceNodeId]) {
      adj[e.sourceNodeId].push(e.targetNodeId);
      inDeg[e.targetNodeId] = (inDeg[e.targetNodeId] || 0) + 1;
    }
  });
  var queue = [];
  for (var id in inDeg) { if (inDeg[id] === 0) queue.push(id); }
  var result = [];
  while (queue.length > 0) {
    var nid = queue.shift();
    result.push(nid);
    (adj[nid] || []).forEach(function(nbr) {
      inDeg[nbr]--;
      if (inDeg[nbr] === 0) queue.push(nbr);
    });
  }
  if (result.length !== compData.nodes.length) return null; // cycle
  return result;
}

function clientValidateRunGraph() {
  if (!compData) return { order: null, error: null, message: '' };

  var nodeIdSet = {};
  compData.nodes.forEach(function(node) {
    nodeIdSet[node.id] = true;
  });

  var invalidEdges = (compData.edges || []).filter(function(edge) {
    return !nodeIdSet[edge.sourceNodeId] || !nodeIdSet[edge.targetNodeId];
  });
  if (invalidEdges.length > 0) {
    var sample = invalidEdges.slice(0, 3).map(function(edge) {
      return (edge.sourceNodeId || '?') + '.' + (edge.sourcePort || '?') + ' -> ' + (edge.targetNodeId || '?') + '.' + (edge.targetPort || '?');
    }).join(', ');
    return {
      order: null,
      error: 'invalid-connections',
      message: 'Some connections point to missing steps: ' + sample,
    };
  }

  var order = clientTopoSort();
  if (!order) {
    return {
      order: null,
      error: 'cycle',
      message: 'These workflows form a loop — each step needs to run after the ones connected to it, but a loop makes that impossible',
    };
  }

  return { order: order, error: null, message: '' };
}

var compRunFormValues = {};
var compFormPreviewCache = {};
var compFormPreviewInflight = {};

function getCompositionRunValue(compId, key, fallback) {
  if (compRunFormValues[compId] && compRunFormValues[compId][key] !== undefined) {
    return compRunFormValues[compId][key];
  }
  return fallback;
}

function saveCompositionRunValues(compId, values) {
  if (!compId || !values) return;
  compRunFormValues[compId] = Object.assign({}, compRunFormValues[compId] || {}, values);
}

function getCompositionCurrentView() {
  return typeof parseHash === 'function' ? (parseHash().view || null) : null;
}

function findActiveNestedNodeId(nodeStates, executionOrder) {
  var order = executionOrder || Object.keys(nodeStates || {});
  for (var i = 0; i < order.length; i++) {
    var state = nodeStates && nodeStates[order[i]];
    if (state && (state.status === 'running' || state.status === 'retrying')) {
      return order[i];
    }
  }
  return null;
}

function countCompletedNestedNodes(nodeStates) {
  var count = 0;
  Object.keys(nodeStates || {}).forEach(function(nodeId) {
    var status = nodeStates[nodeId] && nodeStates[nodeId].status;
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      count++;
    }
  });
  return count;
}

function projectNestedCompositionRunStatus(runStatus) {
  if (!runStatus || !compData) return null;
  if (runStatus.compositionId === compData.id) return runStatus;
  if (!compositionNavigationStack || compositionNavigationStack.length === 0) return null;
  if (compositionNavigationStack[0].id !== runStatus.compositionId) return null;

  var cursor = {
    compositionId: runStatus.compositionId,
    compositionName: runStatus.compositionName,
    executionOrder: runStatus.executionOrder || [],
    nodeStates: runStatus.nodeStates || {},
    active: runStatus.active,
    done: runStatus.done,
    success: runStatus.success,
    error: runStatus.error,
    runId: runStatus.runId,
    pendingApprovals: runStatus.pendingApprovals || [],
    durationMs: runStatus.durationMs,
    pipelineOutputs: runStatus.pipelineOutputs || {},
  };

  for (var i = 0; i < compositionNavigationStack.length; i++) {
    var entry = compositionNavigationStack[i];
    if (entry.id !== cursor.compositionId) return null;

    var parentNodeState = cursor.nodeStates && cursor.nodeStates[entry.focusNodeId];
    if (!parentNodeState || !parentNodeState.subNodeStates) return null;

    var nextCompositionId = i + 1 < compositionNavigationStack.length
      ? compositionNavigationStack[i + 1].id
      : compData.id;
    var childNodeStates = parentNodeState.subNodeStates || {};
    var childExecutionOrder = parentNodeState.subExecutionOrder || Object.keys(childNodeStates);
    var childCurrentNodeId = findActiveNestedNodeId(childNodeStates, childExecutionOrder);
    var childDone = parentNodeState.status === 'completed' || parentNodeState.status === 'failed' || parentNodeState.status === 'skipped';
    var childSuccess = parentNodeState.status === 'completed';

    cursor = {
      compositionId: nextCompositionId,
      compositionName: nextCompositionId === compData.id ? (compData.name || parentNodeState.workflowName || nextCompositionId) : nextCompositionId,
      executionOrder: childExecutionOrder,
      nodeStates: childNodeStates,
      active: runStatus.active && !childDone,
      done: childDone,
      success: childSuccess,
      error: parentNodeState.error,
      runId: runStatus.runId,
      pendingApprovals: runStatus.pendingApprovals || [],
      durationMs: childDone ? parentNodeState.durationMs : runStatus.durationMs,
      pipelineOutputs: parentNodeState.outputVariables || {},
      nodesTotal: parentNodeState.stepsTotal || childExecutionOrder.length,
      nodesCompleted: parentNodeState.stepsCompleted != null ? parentNodeState.stepsCompleted : countCompletedNestedNodes(childNodeStates),
      currentNodeId: childCurrentNodeId,
    };
  }

  return cursor.compositionId === compData.id ? cursor : null;
}

function applyCompositionRunUiState(globalRunData, viewData) {
  var progressWrap = document.querySelector('#comp-progress-wrap');
  var runButton = document.querySelector('#comp-run-btn');
  var cancelButton = document.querySelector('#comp-cancel-btn');
  var batchButton = document.querySelector('#comp-batch-btn');

  if (!viewData) {
    if (progressWrap) progressWrap.style.display = 'none';
    if (runButton) runButton.style.display = '';
    if (cancelButton) cancelButton.style.display = 'none';
    if (batchButton) batchButton.style.display = '';
    return;
  }

  var isActive = !!(globalRunData && globalRunData.active);
  if (progressWrap && (isActive || viewData.done)) progressWrap.style.display = '';
  if (runButton) runButton.style.display = isActive ? 'none' : '';
  if (cancelButton) cancelButton.style.display = isActive ? '' : 'none';
  if (batchButton) batchButton.style.display = isActive ? 'none' : '';
}

function getCompositionFormShareUrl() {
  if (!compData) return window.location.href;
  var url = new URL(window.location.href);
  url.hash = '#compositions/' + encodeURIComponent(compData.id) + '/form';
  return url.toString();
}

function copyCompositionFormShareLink() {
  if (!compData || !navigator.clipboard) {
    toast('Clipboard access is not available here', 'error');
    return;
  }
  navigator.clipboard.writeText(getCompositionFormShareUrl())
    .then(function() { toast('Form link copied to clipboard', 'success'); })
    .catch(function(err) { toast('Failed to copy link: ' + err.message, 'error'); });
}

function getCompositionDefaultText(input) {
  if (input.type === 'string[]' && Array.isArray(input.default)) {
    return input.default.join('\n');
  }
  if (input.default !== undefined && input.default !== null) {
    return String(input.default);
  }
  return '';
}

function getCompositionInputControl(input) {
  var key = String(input.portName || input.name || '');
  var type = String(input.type || 'string');
  var label = String(input.label || input.name || key);
  var lower = (label || key).toLowerCase();
  var defaultValue = input.default;
  var config = {
    inputType: 'text',
    isTextarea: false,
    isBoolean: false,
    isSelect: false,
    isCombobox: false,
    isObject: false,
    objectFields: [],
    options: [],
    placeholder: defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : 'Enter value...',
  };

  if (type === 'boolean') {
    config.isBoolean = true;
    return config;
  }

  if (type === 'object') {
    config.isObject = true;
    config.objectFields = input.objectFields || [];
    return config;
  }

  // Explicit input control from variable metadata
  var explicitControl = String(input.inputControl || '').toLowerCase();
  var opts = Array.isArray(input.options) ? input.options : [];

  if (explicitControl === 'select' && opts.length > 0) {
    config.isSelect = true;
    config.options = opts;
    return config;
  }
  if (explicitControl === 'combobox' && opts.length > 0) {
    config.isCombobox = true;
    config.options = opts;
    config.placeholder = defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : 'Select or type a value...';
    return config;
  }
  if (explicitControl === 'textarea') {
    config.isTextarea = true;
    return config;
  }

  if (type === 'string[]') {
    config.isTextarea = true;
    config.placeholder = Array.isArray(defaultValue) ? defaultValue.join('\n') : 'One value per line';
    return config;
  }
  if (type === 'number') {
    config.inputType = 'number';
    config.placeholder = defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : '0';
    return config;
  }
  if (lower.includes('text') || lower.includes('caption') || lower.includes('content') || lower.includes('lyrics') || lower.includes('description') || lower.includes('prompt') || lower.includes('message')) {
    config.isTextarea = true;
  } else if (lower.includes('url') || lower.includes('link')) {
    config.inputType = 'url';
    config.placeholder = defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : 'https://...';
  } else if (lower.includes('path') || lower.includes('file') || lower.includes('dir') || lower.includes('folder')) {
    config.placeholder = defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : '/path/to/file';
  }
  return config;
}

function normalizeCompositionRunInputs(inputs) {
  var groups = {};
  (inputs || []).forEach(function(input) {
    var key = String(input.portName || input.name || '').trim();
    if (!key) return;
    if (!groups[key]) {
      groups[key] = {
        key: key,
        label: input.label || input.name || key,
        type: input.type || 'string',
        description: input.description || '',
        required: input.required === true,
        default: input.default,
        generationPrompt: input.generationPrompt,
        inputControl: input.inputControl || '',
        options: Array.isArray(input.options) ? input.options : [],
        objectFields: Array.isArray(input.objectFields) ? input.objectFields : [],
        sources: [],
      };
    }
    if (!groups[key].description && input.description) groups[key].description = input.description;
    if (!groups[key].generationPrompt && input.generationPrompt) groups[key].generationPrompt = input.generationPrompt;
    if (groups[key].default === undefined && input.default !== undefined) groups[key].default = input.default;
    if (input.required === true) groups[key].required = true;
    if (!groups[key].inputControl && input.inputControl) groups[key].inputControl = input.inputControl;
    if (groups[key].options.length === 0 && Array.isArray(input.options) && input.options.length > 0) groups[key].options = input.options;

    var displayLabel = String(input.label || input.name || key).trim();
    if (displayLabel && groups[key].label === key && displayLabel !== key) {
      groups[key].label = displayLabel;
    }

    var sourceLabel = String(input.nodeLabel || input.workflowName || '').trim();
    if (sourceLabel && groups[key].sources.indexOf(sourceLabel) === -1) {
      groups[key].sources.push(sourceLabel);
    }
  });

  return Object.keys(groups).sort().map(function(key) { return groups[key]; });
}

function renderCompositionRunFields(inputs) {
  var html = '<div class="comp-run-input-list">';

  inputs.forEach(function(input) {
    var control = getCompositionInputControl(input);
    var savedVal = getCompositionRunValue(compData.id, input.key, getCompositionDefaultText(input));
    var sources = input.sources.length > 0 ? input.sources.join(', ') : '';
    var fieldClassName = 'comp-run-field' + ((control.isTextarea || control.isSelect || control.isCombobox || control.isObject) ? ' comp-run-field-wide' : '');

    html += '<div class="' + fieldClassName + '">';
    html += '<div class="comp-run-field-header">';
    html += '<label class="comp-run-field-label" for="comp-run-input-' + compEscAttr(input.key) + '">' + compEscHtml(input.label || humanizeVarName(input.key)) + '</label>';
    html += input.required
      ? '<span class="badge badge-missing comp-run-badge">required</span>'
      : '<span class="badge badge-partial comp-run-badge">optional</span>';
    html += '</div>';
    if (input.description) {
      html += '<div class="comp-run-field-help">' + compEscHtml(input.description) + '</div>';
    }
    if (sources) {
      html += '<div class="comp-run-field-source">Used by ' + compEscHtml(sources) + '</div>';
    }

    if (control.isObject && control.objectFields.length > 0) {
      // Parse saved value as object for field defaults
      var savedObj = {};
      try { savedObj = typeof savedVal === 'object' && savedVal ? savedVal : JSON.parse(savedVal || '{}'); } catch(e) { savedObj = {}; }

      html += '<div class="comp-run-subform" data-comp-run-key="' + compEscAttr(input.key) + '" data-comp-run-type="object">';
      for (var ofi = 0; ofi < control.objectFields.length; ofi++) {
        var oField = control.objectFields[ofi];
        var oKey = oField.key || ('field' + ofi);
        var oLabel = oField.label || humanizeVarName(oKey);
        var oDefault = savedObj[oKey] !== undefined ? String(savedObj[oKey]) : (oField.default || '');
        var oType = oField.type || 'string';

        html += '<div class="comp-run-subform-field">';
        html += '<label class="comp-run-subform-label" for="comp-run-obj-' + compEscAttr(input.key) + '-' + compEscAttr(oKey) + '">' + compEscHtml(oLabel) + '</label>';

        if (oType === 'boolean') {
          html += '<select class="comp-props-input comp-run-obj-input" id="comp-run-obj-' + compEscAttr(input.key) + '-' + compEscAttr(oKey) + '" data-obj-parent="' + compEscAttr(input.key) + '" data-obj-field="' + compEscAttr(oKey) + '">';
          html += '<option value="">— default —</option>';
          html += '<option value="true"' + (oDefault === 'true' ? ' selected' : '') + '>True</option>';
          html += '<option value="false"' + (oDefault === 'false' ? ' selected' : '') + '>False</option>';
          html += '</select>';
        } else if (oType === 'number') {
          html += '<input type="number" class="comp-props-input comp-run-obj-input" id="comp-run-obj-' + compEscAttr(input.key) + '-' + compEscAttr(oKey) + '" data-obj-parent="' + compEscAttr(input.key) + '" data-obj-field="' + compEscAttr(oKey) + '" value="' + compEscAttr(oDefault) + '" placeholder="0">';
        } else if (oType === 'select' && Array.isArray(oField.options) && oField.options.length > 0) {
          html += '<select class="comp-props-input comp-run-obj-input" id="comp-run-obj-' + compEscAttr(input.key) + '-' + compEscAttr(oKey) + '" data-obj-parent="' + compEscAttr(input.key) + '" data-obj-field="' + compEscAttr(oKey) + '">';
          html += '<option value="">Choose...</option>';
          for (var soi = 0; soi < oField.options.length; soi++) {
            html += '<option value="' + compEscAttr(oField.options[soi]) + '"' + (oDefault === oField.options[soi] ? ' selected' : '') + '>' + compEscHtml(oField.options[soi]) + '</option>';
          }
          html += '</select>';
        } else {
          html += '<input type="text" class="comp-props-input comp-run-obj-input" id="comp-run-obj-' + compEscAttr(input.key) + '-' + compEscAttr(oKey) + '" data-obj-parent="' + compEscAttr(input.key) + '" data-obj-field="' + compEscAttr(oKey) + '" value="' + compEscAttr(oDefault) + '" placeholder="' + compEscAttr(oField.default || '') + '">';
        }
        html += '</div>';
      }
      html += '</div>';
    } else if (control.isBoolean) {
      var boolVal = savedVal === true || savedVal === 'true' ? 'true' : (savedVal === false || savedVal === 'false' ? 'false' : '');
      html += '<select class="comp-props-input comp-run-input" id="comp-run-input-' + compEscAttr(input.key) + '" data-comp-run-key="' + compEscAttr(input.key) + '">';
      html += '<option value="">Choose...</option>';
      html += '<option value="true"' + (boolVal === 'true' ? ' selected' : '') + '>True</option>';
      html += '<option value="false"' + (boolVal === 'false' ? ' selected' : '') + '>False</option>';
      html += '</select>';
    } else if (control.isSelect) {
      html += '<select class="comp-props-input comp-run-input" id="comp-run-input-' + compEscAttr(input.key) + '" data-comp-run-key="' + compEscAttr(input.key) + '">';
      html += '<option value="">Choose...</option>';
      for (var oi = 0; oi < control.options.length; oi++) {
        var optVal = control.options[oi];
        html += '<option value="' + compEscAttr(optVal) + '"' + (String(savedVal) === optVal ? ' selected' : '') + '>' + compEscHtml(optVal) + '</option>';
      }
      html += '</select>';
    } else if (control.isCombobox) {
      var listId = 'comp-run-list-' + compEscAttr(input.key);
      html += '<input type="text" class="comp-props-input comp-run-input" list="' + listId + '" id="comp-run-input-' + compEscAttr(input.key) + '" data-comp-run-key="' + compEscAttr(input.key) + '" value="' + compEscAttr(savedVal) + '" placeholder="' + compEscAttr(control.placeholder) + '">';
      html += '<datalist id="' + listId + '">';
      for (var ci = 0; ci < control.options.length; ci++) {
        html += '<option value="' + compEscAttr(control.options[ci]) + '">';
      }
      html += '</datalist>';
    } else if (control.isTextarea) {
      html += '<textarea class="comp-props-input comp-run-input comp-run-textarea" id="comp-run-input-' + compEscAttr(input.key) + '" data-comp-run-key="' + compEscAttr(input.key) + '" placeholder="' + compEscAttr(control.placeholder) + '">' + compEscHtml(savedVal) + '</textarea>';
    } else {
      html += '<input class="comp-props-input comp-run-input" type="' + compEscAttr(control.inputType) + '" id="comp-run-input-' + compEscAttr(input.key) + '" data-comp-run-key="' + compEscAttr(input.key) + '" value="' + compEscAttr(savedVal) + '" placeholder="' + compEscAttr(control.placeholder) + '">';
    }

    if (input.generationPrompt) {
      html += '<div class="comp-run-field-actions">';
      html += '<button class="comp-run-ai-btn" data-comp-run-generate="' + compEscAttr(input.key) + '" title="' + compEscAttr(input.generationPrompt) + '">&#x2728; Generate</button>';
      html += '</div>';
    }
    html += '</div>';
  });

  html += '</div>';
  return html;
}

function collectCompositionRunValues(root, inputs) {
  var variables = {};
  var rawValues = {};
  var missing = [];

  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];

    // Handle object sub-form: collect individual fields into an object
    var subform = root.querySelector('.comp-run-subform[data-comp-run-key="' + input.key + '"]');
    if (subform) {
      var objValue = {};
      var hasAnyValue = false;
      var subInputs = subform.querySelectorAll('.comp-run-obj-input');
      for (var si = 0; si < subInputs.length; si++) {
        var fieldKey = subInputs[si].getAttribute('data-obj-field');
        var fieldVal = subInputs[si].value;
        if (fieldKey && fieldVal !== '' && fieldVal !== null && fieldVal !== undefined) {
          // Type coerce based on field type
          var fieldDef = (input.objectFields || []).find(function(f) { return f.key === fieldKey; });
          if (fieldDef && fieldDef.type === 'number') {
            objValue[fieldKey] = Number(fieldVal) || 0;
          } else if (fieldDef && fieldDef.type === 'boolean') {
            objValue[fieldKey] = fieldVal === 'true';
          } else {
            objValue[fieldKey] = fieldVal;
          }
          hasAnyValue = true;
        }
      }
      if (hasAnyValue) {
        variables[input.key] = objValue;
        rawValues[input.key] = JSON.stringify(objValue);
      } else if (input.default !== undefined) {
        variables[input.key] = input.default;
      } else if (input.required) {
        missing.push(input.label || humanizeVarName(input.key));
      }
      continue;
    }

    var el = root.querySelector('[data-comp-run-key="' + input.key + '"]');
    if (!el) continue;
    var rawValue = el.value;
    rawValues[input.key] = rawValue;
    var parsed = parseCompositionRunInput(input, rawValue);
    if (parsed.error) {
      return { error: parsed.error, errorElement: el };
    }
    if (parsed.isEmpty) {
      if (input.default !== undefined) {
        variables[input.key] = input.default;
        continue;
      }
      if (input.required) missing.push(input.label || humanizeVarName(input.key));
      continue;
    }
    variables[input.key] = parsed.value;
  }

  return { variables: variables, rawValues: rawValues, missing: missing };
}

function generateCompositionInputValue(input, root, triggerBtn) {
  if (!input || !input.generationPrompt) return Promise.resolve();
  var field = root.querySelector('[data-comp-run-key="' + input.key + '"]');
  if (!field) return Promise.resolve();

  var originalText = triggerBtn ? triggerBtn.innerHTML : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.innerHTML = '&#x23f3; Generating...';
  }

  return fetch('/api/generate-variable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variableName: input.key,
      generationPrompt: input.generationPrompt,
      workflowName: compData ? compData.name : 'Untitled Pipeline',
      site: 'pipeline',
      variableType: input.type || 'string',
    }),
  })
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      if (!data.success || data.value === undefined || data.value === null) {
        throw new Error(data.error || 'Generation failed');
      }

      if (field.tagName === 'SELECT') {
        field.value = String(data.value).trim().toLowerCase();
      } else if (Array.isArray(data.value)) {
        field.value = data.value.join('\n');
      } else {
        field.value = String(data.value);
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      toast('Generated ' + (input.label || humanizeVarName(input.key)), 'success');
    })
    .catch(function(err) {
      toast('Generation failed: ' + err.message, 'error');
    })
    .finally(function() {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = originalText;
      }
    });
}

function wireCompositionRunInputActions(root, inputs) {
  var inputMap = {};
  inputs.forEach(function(input) { inputMap[input.key] = input; });
  root.querySelectorAll('[data-comp-run-generate]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var input = inputMap[btn.getAttribute('data-comp-run-generate')];
      generateCompositionInputValue(input, root, btn);
    });
  });
}

function isCompositionLikelyUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function isCompositionLikelyFilePath(value) {
  return typeof value === 'string' && /^(\/|~\/|[A-Za-z]:\\)/.test(value.trim());
}

function serializeCompositionResult(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

function tryParseCompositionJsonString(value) {
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return null;
  }
}

function isCompositionScalarValue(value) {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function renderCompositionStructuredScalar(value) {
  if (value === null) return '<span class="comp-form-json-null">null</span>';
  if (value === undefined) return '<span class="comp-form-json-null">undefined</span>';
  if (typeof value === 'number') return '<span class="comp-form-json-number">' + compEscHtml(String(value)) + '</span>';
  if (typeof value === 'boolean') return '<span class="comp-form-json-boolean">' + compEscHtml(String(value)) + '</span>';
  return '<span class="comp-form-json-string">' + compEscHtml(JSON.stringify(String(value))) + '</span>';
}

function getCompositionStructureDepth(value, maxDepth) {
  var limit = typeof maxDepth === 'number' ? maxDepth : 4;

  function walk(input, depth) {
    if (depth >= limit || isCompositionScalarValue(input)) return depth;
    if (Array.isArray(input)) {
      if (input.length === 0) return depth + 1;
      return input.reduce(function(best, item) {
        return Math.max(best, walk(item, depth + 1));
      }, depth + 1);
    }
    var keys = Object.keys(input || {});
    if (keys.length === 0) return depth + 1;
    return keys.reduce(function(best, key) {
      return Math.max(best, walk(input[key], depth + 1));
    }, depth + 1);
  }

  return walk(value, 0);
}

function countCompositionComplexChildren(value) {
  if (!value || typeof value !== 'object') return 0;
  var count = 0;
  Object.keys(value).forEach(function(key) {
    var item = value[key];
    if (item && typeof item === 'object') count++;
  });
  return count;
}

function shouldRenderCompositionDeepInspector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var keys = Object.keys(value);
  if (keys.length < 2) return false;
  return getCompositionStructureDepth(value, 5) >= 3 || countCompositionComplexChildren(value) >= 2 || keys.length >= 5;
}

function renderCompositionStructuredValue(value, runId, pathKey, depth) {
  var nextDepth = depth || 0;
  if (isCompositionScalarValue(value)) {
    return '<div class="comp-form-json-leaf">' + renderCompositionStructuredScalar(value) + '</div>';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<div class="comp-form-json-empty">Empty array</div>';
    }
    var arrayKey = pathKey + ':array';
    var arrayHtml = '<details class="comp-form-json-node" data-comp-details-key="' + compEscAttr(arrayKey) + '"' + getCompositionDetailsOpenAttr(runId, arrayKey, nextDepth < 2) + '>';
    arrayHtml += '<summary><span class="comp-form-json-type">Array</span><span class="comp-form-json-count">' + compEscHtml(String(value.length)) + ' items</span></summary>';
    arrayHtml += '<div class="comp-form-json-children">';
    value.forEach(function(item, index) {
      arrayHtml += '<div class="comp-form-json-row">';
      arrayHtml += '<div class="comp-form-json-key">[' + compEscHtml(String(index)) + ']</div>';
      arrayHtml += '<div class="comp-form-json-value">' + renderCompositionStructuredValue(item, runId, pathKey + '[' + index + ']', nextDepth + 1) + '</div>';
      arrayHtml += '</div>';
    });
    arrayHtml += '</div>';
    arrayHtml += '</details>';
    return arrayHtml;
  }

  var keys = Object.keys(value || {});
  if (keys.length === 0) {
    return '<div class="comp-form-json-empty">Empty object</div>';
  }

  var objectKey = pathKey + ':object';
  var objectHtml = '<details class="comp-form-json-node" data-comp-details-key="' + compEscAttr(objectKey) + '"' + getCompositionDetailsOpenAttr(runId, objectKey, true) + '>';
  objectHtml += '<summary><span class="comp-form-json-type">Object</span><span class="comp-form-json-count">' + compEscHtml(String(keys.length)) + ' fields</span></summary>';
  objectHtml += '<div class="comp-form-json-children">';
  keys.forEach(function(key) {
    objectHtml += '<div class="comp-form-json-row">';
    objectHtml += '<div class="comp-form-json-key">' + compEscHtml(key) + '</div>';
    objectHtml += '<div class="comp-form-json-value">' + renderCompositionStructuredValue(value[key], runId, pathKey + '.' + key, nextDepth + 1) + '</div>';
    objectHtml += '</div>';
  });
  objectHtml += '</div>';
  objectHtml += '</details>';
  return objectHtml;
}

function getCompositionArtifactKind(value) {
  if (!value || typeof value !== 'string') return 'other';
  var lower = value.toLowerCase();
  if (/\.(md|markdown)$/i.test(lower)) return 'markdown';
  if (/\.(txt|log|text)$/i.test(lower)) return 'text';
  if (/\.(json)$/i.test(lower)) return 'json';
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|webm|mkv)$/i.test(lower)) return 'video';
  if (/\.(mp3|wav|ogg|aac|flac|m4a)$/i.test(lower)) return 'audio';
  if (/\.(pdf)$/i.test(lower)) return 'pdf';
  return 'other';
}

function looksLikeMarkdown(text) {
  if (typeof text !== 'string') return false;
  return /^#\s|^##\s|\*\*.+\*\*|^-\s|^\d+\.\s|```/m.test(text);
}

function getCompositionOutputKind(value) {
  if (value === null || value === undefined) return 'scalar';
  if (typeof value === 'string' && looksLikeMarkdown(value)) return 'markdown';
  return 'scalar';
}

function normalizeCompositionDisplayValue(value) {
  var parsed = tryParseCompositionJsonString(value);
  return parsed !== null ? parsed : value;
}

function getCompositionOutputPortDefinition(outputKey) {
  if (!compData || !Array.isArray(compData.nodes)) return null;
  var outputNode = compData.nodes.find(function(node) {
    return node && node.workflowId === '__output__';
  });
  if (!outputNode || !outputNode.outputNode || !Array.isArray(outputNode.outputNode.ports)) return null;
  return outputNode.outputNode.ports.find(function(port) {
    return port && port.name === outputKey;
  }) || null;
}

function getCompositionOutputPresentation(outputKey) {
  var port = getCompositionOutputPortDefinition(outputKey);
  return port && port.presentation ? port.presentation : null;
}

function getCompositionPresentationField(obj, preferredField, candidates) {
  if (!obj || typeof obj !== 'object') return null;
  if (preferredField && obj[preferredField] !== undefined && obj[preferredField] !== null && obj[preferredField] !== '') {
    return preferredField;
  }
  for (var i = 0; i < candidates.length; i++) {
    var key = candidates[i];
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return key;
  }
  return null;
}

function getCompositionPresentationSectionConfig(presentation, sectionKey) {
  if (!presentation || !presentation.sections || !sectionKey) return null;
  var config = presentation.sections[sectionKey];
  return config && typeof config === 'object' ? config : null;
}

function mergeCompositionPresentation(basePresentation, sectionConfig) {
  if (!basePresentation && !sectionConfig) return null;
  var merged = {};
  if (basePresentation) {
    Object.keys(basePresentation).forEach(function(key) {
      if (key === 'sections' || key === 'sectionOrder' || key === 'tabStyle') return;
      merged[key] = basePresentation[key];
    });
  }
  if (sectionConfig) {
    Object.keys(sectionConfig).forEach(function(key) {
      merged[key] = sectionConfig[key];
    });
  }
  return merged;
}

function orderCompositionSectionKeys(keys, presentation) {
  var preferred = Array.isArray(presentation && presentation.sectionOrder) ? presentation.sectionOrder : [];
  if (preferred.length === 0) return keys.slice();

  var remaining = keys.slice();
  var ordered = [];
  preferred.forEach(function(key) {
    var idx = remaining.indexOf(key);
    if (idx >= 0) {
      ordered.push(key);
      remaining.splice(idx, 1);
    }
  });
  return ordered.concat(remaining);
}

function getCompositionSectionLabel(sectionKey, presentation) {
  var sectionConfig = getCompositionPresentationSectionConfig(presentation, sectionKey);
  if (sectionConfig && sectionConfig.label) return String(sectionConfig.label);
  return humanizeVarName(sectionKey);
}

function getCompositionMediaKindFromValue(value, forcedKind) {
  if (!value || typeof value !== 'string') return null;
  if (forcedKind && forcedKind !== 'auto') return forcedKind;
  var kind = getCompositionArtifactKind(value);
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') return kind;
  return null;
}

function getCompositionMediaSrc(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^data:/i.test(value) || /^https?:\/\//i.test(value)) return value;
  return '/api/file?path=' + encodeURIComponent(value);
}

function formatCompositionPreviewValue(value) {
  if (value === null || value === undefined) return 'None';
  if (Array.isArray(value)) return value.length + ' item' + (value.length === 1 ? '' : 's');
  if (typeof value === 'object') {
    var keyCount = Object.keys(value).length;
    return keyCount + ' field' + (keyCount === 1 ? '' : 's');
  }
  var text = String(value);
  return text.length > 220 ? text.slice(0, 217) + '...' : text;
}

function renderCompositionMediaPreview(value, mediaKind, title) {
  var src = getCompositionMediaSrc(value);
  if (!src) return '';
  if (mediaKind === 'image') {
    return '<img class="comp-form-rich-media comp-form-rich-media-image" src="' + compEscAttr(src) + '" alt="' + compEscAttr(title || 'Preview') + '">';
  }
  if (mediaKind === 'video') {
    return '<video class="comp-form-rich-media comp-form-rich-media-video" src="' + compEscAttr(src) + '" controls preload="metadata"></video>';
  }
  if (mediaKind === 'audio') {
    return '<div class="comp-form-rich-audio"><div class="comp-form-rich-audio-icon">Audio</div><audio class="comp-form-rich-media-audio" src="' + compEscAttr(src) + '" controls preload="metadata"></audio></div>';
  }
  if (mediaKind === 'pdf') {
    return '<iframe class="comp-form-rich-media comp-form-rich-media-pdf" src="' + compEscAttr(src) + '"></iframe>';
  }
  return '';
}

function getCompositionFilterText(value, preferredFields) {
  var parts = [];

  function pushText(input) {
    if (input === null || input === undefined) return;
    if (Array.isArray(input)) {
      input.forEach(pushText);
      return;
    }
    if (typeof input === 'object') {
      Object.keys(input).forEach(function(key) {
        pushText(input[key]);
      });
      return;
    }
    parts.push(String(input));
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(preferredFields) && preferredFields.length > 0) {
    preferredFields.forEach(function(field) {
      if (value[field] !== undefined) pushText(value[field]);
    });
  } else {
    pushText(value);
  }

  return parts.join(' ').trim().toLowerCase();
}

function getCompositionArraySearchPlaceholder(presentation, outputPathKey) {
  var fallbackLabel = outputPathKey && outputPathKey.split('.').pop();
  if (presentation && presentation.searchPlaceholder) return String(presentation.searchPlaceholder);
  return 'Filter ' + humanizeVarName(fallbackLabel || 'items');
}

function shouldRenderCompositionArrayFilter(items, presentation) {
  if (!Array.isArray(items)) return false;
  if (items.length >= 6) return true;
  return !!(presentation && Array.isArray(presentation.filterFields) && presentation.filterFields.length > 0);
}

function renderCompositionArrayScalarCard(item, index) {
  var valueType = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
  var displayValue = item === undefined ? 'undefined' : serializeCompositionResult(item);
  var html = '<div class="comp-form-array-card" data-comp-filter-item data-comp-filter-text="' + compEscAttr(getCompositionFilterText(item)) + '">';
  html += '<div class="comp-form-array-card-head">';
  html += '<span class="comp-form-array-card-index">' + compEscHtml(String(index + 1)) + '</span>';
  html += '<span class="comp-form-array-card-type">' + compEscHtml(valueType) + '</span>';
  html += '</div>';
  html += '<div class="comp-form-array-card-body">' + compEscHtml(displayValue) + '</div>';
  html += '</div>';
  return html;
}

function renderCompositionArraySummaryCard(item, index, outputPathKey, runId, presentation) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return renderCompositionObjectPreviewCard(item, presentation, outputPathKey + '[' + index + ']', runId || 'no-run');
  }

  var summary = Array.isArray(item)
    ? String(item.length) + ' items'
    : formatCompositionPreviewValue(item);
  var typeLabel = Array.isArray(item) ? 'array' : (item === null ? 'null' : typeof item);
  var html = '<div class="comp-form-array-card" data-comp-filter-item data-comp-filter-text="' + compEscAttr(getCompositionFilterText(item, presentation && presentation.filterFields)) + '">';
  html += '<div class="comp-form-array-card-head">';
  html += '<span class="comp-form-array-card-index">' + compEscHtml(String(index + 1)) + '</span>';
  html += '<span class="comp-form-array-card-type">' + compEscHtml(typeLabel) + '</span>';
  html += '</div>';
  html += '<div class="comp-form-array-card-body">' + compEscHtml(summary) + '</div>';

  if (Array.isArray(item)) {
    var nestedDetailKey = outputPathKey + '[' + index + ']:nested';
    html += '<details class="comp-form-rich-raw" data-comp-details-key="' + compEscAttr(nestedDetailKey) + '"' + getCompositionDetailsOpenAttr(runId || 'no-run', nestedDetailKey, false) + '>';
    html += '<summary>Expand array</summary>';
    html += '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(item, runId || 'no-run', outputPathKey + '[' + index + ']', 0) + '</div>';
    html += '</details>';
  }

  html += '</div>';
  return html;
}

function renderCompositionArrayPreview(items, presentation, runId, outputPathKey) {
  if (!Array.isArray(items) || items.length === 0) return '';

  var normalizedItems = items.map(function(item) {
    return normalizeCompositionDisplayValue(item);
  });
  var objectItems = normalizedItems.filter(function(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  });
  var scalarItems = normalizedItems.filter(function(item) {
    return isCompositionScalarValue(item);
  });

  function wrapArrayContent(innerHtml) {
    var shouldFilter = shouldRenderCompositionArrayFilter(normalizedItems, presentation);
    if (!shouldFilter) return innerHtml;
    var filterId = outputPathKey + ':filter';
    var wrappedHtml = '<div class="comp-form-array-preview" data-comp-filter-group="' + compEscAttr(filterId) + '">';
    wrappedHtml += '<div class="comp-form-array-toolbar">';
    wrappedHtml += '<input class="comp-form-array-search" type="search" placeholder="' + compEscAttr(getCompositionArraySearchPlaceholder(presentation, outputPathKey)) + '" data-comp-filter-input data-comp-filter-group="' + compEscAttr(filterId) + '">';
    wrappedHtml += '<div class="comp-form-array-count" data-comp-filter-count data-comp-filter-group="' + compEscAttr(filterId) + '">' + compEscHtml(String(normalizedItems.length)) + ' items</div>';
    wrappedHtml += '</div>';
    wrappedHtml += innerHtml;
    wrappedHtml += '<div class="comp-form-results-empty comp-form-array-empty" data-comp-filter-empty data-comp-filter-group="' + compEscAttr(filterId) + '" style="display:none;">No matching items.</div>';
    wrappedHtml += '</div>';
    return wrappedHtml;
  }

  if (objectItems.length === normalizedItems.length) {
    var objectGridHtml = '<div class="comp-form-rich-grid">';
    normalizedItems.forEach(function(item, index) {
      objectGridHtml += renderCompositionObjectPreviewCard(item, presentation, outputPathKey + '[' + index + ']', runId || 'no-run');
    });
    objectGridHtml += '</div>';
    return wrapArrayContent(objectGridHtml);
  }

  if (scalarItems.length === normalizedItems.length) {
    var scalarGridHtml = '<div class="comp-form-array-grid">';
    normalizedItems.forEach(function(item, index) {
      scalarGridHtml += renderCompositionArrayScalarCard(item, index);
    });
    scalarGridHtml += '</div>';
    return wrapArrayContent(scalarGridHtml);
  }

  var mixedGridHtml = '<div class="comp-form-array-grid comp-form-array-grid-mixed">';
  normalizedItems.forEach(function(item, index) {
    mixedGridHtml += renderCompositionArraySummaryCard(item, index, outputPathKey, runId || 'no-run', presentation);
  });
  mixedGridHtml += '</div>';
  return wrapArrayContent(mixedGridHtml);
}

function renderCompositionDeepScalarValue(value) {
  return '<div class="comp-form-deep-value">' + compEscHtml(serializeCompositionResult(value)) + '</div>';
}

function renderCompositionDeepScalarGrid(value) {
  var keys = Object.keys(value || {});
  var html = '<div class="comp-form-deep-kv-grid">';
  keys.forEach(function(key) {
    html += '<div class="comp-form-deep-kv-card">';
    html += '<div class="comp-form-deep-kv-key">' + compEscHtml(humanizeVarName(key)) + '</div>';
    html += '<div class="comp-form-deep-kv-value">' + compEscHtml(formatCompositionPreviewValue(value[key])) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function renderCompositionDeepFieldSummary(value) {
  if (Array.isArray(value)) return value.length + ' item' + (value.length === 1 ? '' : 's');
  if (value && typeof value === 'object') return Object.keys(value).length + ' field' + (Object.keys(value).length === 1 ? '' : 's');
  return typeof value;
}

function renderCompositionDeepSectionBody(value, presentation, runId, pathKey, depth) {
  var nextDepth = depth || 0;
  if (isCompositionScalarValue(value)) {
    return renderCompositionDeepScalarValue(value);
  }

  if (Array.isArray(value)) {
    var arrayHtml = renderCompositionArrayPreview(value, presentation, runId, pathKey);
    if (arrayHtml) return arrayHtml;
    return '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(value, runId || 'no-run', pathKey, nextDepth) + '</div>';
  }

  var keys = Object.keys(value || {});
  if (keys.length === 0) {
    return '<div class="comp-form-results-empty">Empty object</div>';
  }

  var allScalar = keys.every(function(key) {
    return isCompositionScalarValue(value[key]);
  });
  if (allScalar) {
    return renderCompositionDeepScalarGrid(value);
  }

  if (nextDepth >= 1) {
    return '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(value, runId || 'no-run', pathKey, nextDepth) + '</div>';
  }

  var html = '<div class="comp-form-deep-card-grid">';
  keys.forEach(function(key) {
    var item = value[key];
    var sectionPresentation = mergeCompositionPresentation(presentation, getCompositionPresentationSectionConfig(presentation, key));
    html += '<article class="comp-form-deep-card">';
    html += '<div class="comp-form-deep-card-head">';
    html += '<div class="comp-form-deep-card-title">' + compEscHtml(getCompositionSectionLabel(key, presentation)) + '</div>';
    html += '<div class="comp-form-deep-card-meta">' + compEscHtml(renderCompositionDeepFieldSummary(item)) + '</div>';
    html += '</div>';
    html += '<div class="comp-form-deep-card-body">' + renderCompositionDeepSectionBody(item, sectionPresentation, runId || 'no-run', pathKey + '.' + key, nextDepth + 1) + '</div>';
    html += '</article>';
  });
  html += '</div>';
  return html;
}

var compFormTabState = Object.create(null);

function getCompositionTabStateKey(runId, groupKey) {
  return String(runId || 'no-run') + '::tab::' + String(groupKey || 'group');
}

function getCompositionActiveTab(runId, groupKey, sections) {
  var stateKey = getCompositionTabStateKey(runId, groupKey);
  var current = compFormTabState[stateKey];
  if (current && sections.some(function(section) { return section.id === current; })) {
    return current;
  }
  return sections.length > 0 ? sections[0].id : null;
}

function renderCompositionDeepInspector(value, presentation, runId, outputPathKey) {
  if (!shouldRenderCompositionDeepInspector(value)) return '';

  var keys = orderCompositionSectionKeys(Object.keys(value || {}), presentation);
  if (keys.length === 0) return '';
  var useRailTabs = (presentation && presentation.tabStyle === 'rail') || (presentation && presentation.tabStyle !== 'top' && keys.length >= 6);

  var sections = keys.map(function(key) {
    var item = value[key];
    var sectionPresentation = mergeCompositionPresentation(presentation, getCompositionPresentationSectionConfig(presentation, key));
    return {
      id: key,
      label: getCompositionSectionLabel(key, presentation),
      meta: renderCompositionDeepFieldSummary(item),
      content: renderCompositionDeepSectionBody(item, sectionPresentation, runId || 'no-run', outputPathKey + '.' + key, 0),
    };
  });

  var groupKey = outputPathKey + ':tabs';
  var activeId = getCompositionActiveTab(runId || 'no-run', groupKey, sections);
  var html = '<div class="comp-form-deep-inspector' + (useRailTabs ? ' comp-form-deep-inspector-rail' : '') + '" data-comp-tab-root data-comp-tab-group="' + compEscAttr(groupKey) + '">';
  html += '<div class="comp-form-deep-tab-list" role="tablist" aria-label="Structured output sections">';
  sections.forEach(function(section) {
    var isActive = section.id === activeId;
    html += '<button class="comp-form-deep-tab' + (isActive ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '" data-comp-tab-button data-comp-tab-group="' + compEscAttr(groupKey) + '" data-comp-tab-id="' + compEscAttr(section.id) + '">';
    html += '<span class="comp-form-deep-tab-label">' + compEscHtml(section.label) + '</span>';
    html += '<span class="comp-form-deep-tab-meta">' + compEscHtml(section.meta) + '</span>';
    html += '</button>';
  });
  html += '</div>';
  html += '<div class="comp-form-deep-panels">';
  sections.forEach(function(section) {
    var isActive = section.id === activeId;
    html += '<section class="comp-form-deep-panel' + (isActive ? ' active' : '') + '" role="tabpanel" data-comp-tab-panel data-comp-tab-group="' + compEscAttr(groupKey) + '" data-comp-tab-id="' + compEscAttr(section.id) + '">';
    html += '<div class="comp-form-deep-panel-head">';
    html += '<div class="comp-form-deep-panel-title">' + compEscHtml(section.label) + '</div>';
    html += '<div class="comp-form-deep-panel-meta">' + compEscHtml(section.meta) + '</div>';
    html += '</div>';
    html += '<div class="comp-form-deep-panel-body">' + section.content + '</div>';
    html += '</section>';
  });
  html += '</div>';
  html += '</div>';
  return html;
}

function renderCompositionObjectPreviewCard(item, presentation, itemPathKey, runId) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  var titleField = getCompositionPresentationField(item, presentation && presentation.titleField, ['title', 'name', 'scene_reference', 'sceneId', 'label', 'id']);
  var subtitleField = getCompositionPresentationField(item, presentation && presentation.subtitleField, ['id', 'shot_type', 'genre', 'type', 'location_id']);
  var descriptionField = getCompositionPresentationField(item, presentation && presentation.descriptionField, ['description', 'summary', 'prompt', 'visual_details', 'script_content']);
  var mediaField = getCompositionPresentationField(item, presentation && presentation.mediaField, ['imagePath', 'image_path', 'headshot_image', 'thumbnail', 'previewImage', 'videoPath', 'audioPath', 'filePath', 'file_path', 'mediaPath', 'path', 'url']);
  var mediaValue = mediaField ? item[mediaField] : null;
  var mediaKind = getCompositionMediaKindFromValue(mediaValue, presentation && presentation.mediaType);

  var visibleFields = Array.isArray(presentation && presentation.fields) && presentation.fields.length > 0
    ? presentation.fields.slice(0, 6)
    : Object.keys(item).filter(function(key) {
      return key !== titleField && key !== subtitleField && key !== descriptionField && key !== mediaField;
    }).slice(0, 6);

  var html = '<article class="comp-form-rich-card" data-comp-filter-item data-comp-filter-text="' + compEscAttr(getCompositionFilterText(item, presentation && presentation.filterFields)) + '">';
  if (mediaKind && mediaValue) {
    html += '<div class="comp-form-rich-media-wrap">' + renderCompositionMediaPreview(mediaValue, mediaKind, titleField ? item[titleField] : 'Preview') + '</div>';
  }
  html += '<div class="comp-form-rich-card-body">';
  if (titleField || subtitleField) {
    html += '<div class="comp-form-rich-card-header">';
    if (titleField) html += '<div class="comp-form-rich-card-title">' + compEscHtml(formatCompositionPreviewValue(item[titleField])) + '</div>';
    if (subtitleField) html += '<div class="comp-form-rich-card-subtitle">' + compEscHtml(formatCompositionPreviewValue(item[subtitleField])) + '</div>';
    html += '</div>';
  }
  if (descriptionField) {
    html += '<div class="comp-form-rich-card-description">' + compEscHtml(formatCompositionPreviewValue(item[descriptionField])) + '</div>';
  }
  if (visibleFields.length > 0) {
    html += '<div class="comp-form-rich-field-list">';
    visibleFields.forEach(function(field) {
      html += '<div class="comp-form-rich-field">';
      html += '<div class="comp-form-rich-field-key">' + compEscHtml(humanizeVarName(field)) + '</div>';
      html += '<div class="comp-form-rich-field-value">' + compEscHtml(formatCompositionPreviewValue(item[field])) + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  var rawDetailKey = itemPathKey + ':card-raw';
  html += '<details class="comp-form-rich-raw" data-comp-details-key="' + compEscAttr(rawDetailKey) + '"' + getCompositionDetailsOpenAttr(runId, rawDetailKey, false) + '>';
  html += '<summary>Raw item</summary>';
  html += '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(item, runId || 'no-run', itemPathKey + '.raw', 0) + '</div>';
  html += '</details>';
  html += '</article>';
  return html;
}

function renderCompositionRichValue(value, presentation, runId, outputPathKey) {
  var normalized = normalizeCompositionDisplayValue(value);
  if (normalized === null || normalized === undefined) return '';

  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    var deepInspectorHtml = renderCompositionDeepInspector(normalized, presentation, runId, outputPathKey);
    if (deepInspectorHtml) return deepInspectorHtml;
  }

  if (typeof normalized === 'string') {
    var mediaKind = getCompositionMediaKindFromValue(normalized, presentation && presentation.mediaType);
    if (mediaKind) {
      var mediaHtml = '<div class="comp-form-rich-single">';
      mediaHtml += renderCompositionMediaPreview(normalized, mediaKind, presentation && presentation.title ? presentation.title : 'Output preview');
      mediaHtml += '<a class="comp-form-artifact-link" href="' + compEscAttr(getCompositionMediaSrc(normalized)) + '" target="_blank" rel="noreferrer">' + compEscHtml(normalized) + '</a>';
      mediaHtml += '</div>';
      return mediaHtml;
    }
    if (looksLikeMarkdown(normalized)) {
      return typeof marked !== 'undefined'
        ? '<div class="comp-form-markdown-viewer comp-form-rich-document">' + marked.parse(normalized) + '</div>'
        : '<pre class="comp-form-output-value comp-form-rich-document">' + compEscHtml(normalized) + '</pre>';
    }
    if (normalized.length > 240 || normalized.indexOf('\n') >= 0) {
      return '<div class="comp-form-rich-document comp-form-rich-document-text">' + compEscHtml(normalized) + '</div>';
    }
    return '';
  }

  if (Array.isArray(normalized)) {
    return renderCompositionArrayPreview(normalized, presentation, runId, outputPathKey);
  }

  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    return '<div class="comp-form-rich-single-card">' + renderCompositionObjectPreviewCard(normalized, presentation, outputPathKey, runId || 'no-run') + '</div>';
  }

  return '';
}

function renderCompositionStructuredFallback(structuredValue, runId, outputPathKey, label) {
  if (!structuredValue) return '';
  var detailKey = outputPathKey + ':structured';
  var html = '<details class="comp-form-output-raw" data-comp-details-key="' + compEscAttr(detailKey) + '"' + getCompositionDetailsOpenAttr(runId, detailKey, false) + '>';
  html += '<summary>' + compEscHtml(label || 'Structured data') + '</summary>';
  html += '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(structuredValue, runId || 'no-run', outputPathKey, 0) + '</div>';
  html += '</details>';
  return html;
}

var compFormDetailsState = Object.create(null);

function getCompositionDetailsStateKey(runId, detailKey) {
  return String(runId || 'no-run') + '::' + String(detailKey || 'detail');
}

function getCompositionDetailsOpenAttr(runId, detailKey, defaultOpen) {
  var stateKey = getCompositionDetailsStateKey(runId, detailKey);
  if (Object.prototype.hasOwnProperty.call(compFormDetailsState, stateKey)) {
    return compFormDetailsState[stateKey] ? ' open' : '';
  }
  return defaultOpen ? ' open' : '';
}

function captureCompositionDetailsState(root, runId) {
  if (!root) return;
  root.querySelectorAll('details[data-comp-details-key]').forEach(function(detailsEl) {
    var detailKey = detailsEl.getAttribute('data-comp-details-key');
    if (!detailKey) return;
    compFormDetailsState[getCompositionDetailsStateKey(runId, detailKey)] = !!detailsEl.open;
  });
}

function wireCompositionDetailsState(root, runId) {
  if (!root) return;
  root.querySelectorAll('details[data-comp-details-key]').forEach(function(detailsEl) {
    detailsEl.addEventListener('toggle', function() {
      var detailKey = detailsEl.getAttribute('data-comp-details-key');
      if (!detailKey) return;
      compFormDetailsState[getCompositionDetailsStateKey(runId, detailKey)] = !!detailsEl.open;
    });
  });
}

function copyCompositionText(value, label) {
  if (!navigator.clipboard) {
    toast('Clipboard access is not available here', 'error');
    return;
  }
  navigator.clipboard.writeText(String(value || ''))
    .then(function() { toast((label || 'Content') + ' copied to clipboard', 'success'); })
    .catch(function(err) { toast('Failed to copy: ' + err.message, 'error'); });
}

function fetchCompositionPreviewText(filePath) {
  if (compFormPreviewCache[filePath] !== undefined) {
    return Promise.resolve(compFormPreviewCache[filePath]);
  }
  if (compFormPreviewInflight[filePath]) return compFormPreviewInflight[filePath];

  compFormPreviewInflight[filePath] = fetch('/api/file?path=' + encodeURIComponent(filePath))
    .then(function(res) {
      if (!res.ok) throw new Error('Failed to load preview');
      return res.text();
    })
    .then(function(text) {
      compFormPreviewCache[filePath] = text;
      delete compFormPreviewInflight[filePath];
      return text;
    })
    .catch(function(err) {
      delete compFormPreviewInflight[filePath];
      throw err;
    });

  return compFormPreviewInflight[filePath];
}

function hydrateCompositionArtifactPreviews(root) {
  root.querySelectorAll('[data-comp-preview-path]').forEach(function(el) {
    var filePath = el.getAttribute('data-comp-preview-path');
    var kind = el.getAttribute('data-comp-preview-kind');
    if (!filePath || !kind || el.getAttribute('data-comp-preview-loaded') === 'true') return;
    if (kind !== 'markdown' && kind !== 'text' && kind !== 'json') return;

    fetchCompositionPreviewText(filePath)
      .then(function(text) {
        el.setAttribute('data-comp-preview-loaded', 'true');
        if (kind === 'markdown' && typeof marked !== 'undefined') {
          el.innerHTML = marked.parse(text);
        } else if (kind === 'json') {
          try {
            el.textContent = JSON.stringify(JSON.parse(text), null, 2);
          } catch (err) {
            el.textContent = text;
          }
        } else {
          el.textContent = text;
        }
      })
      .catch(function(err) {
        el.setAttribute('data-comp-preview-loaded', 'true');
        el.textContent = 'Preview unavailable: ' + err.message;
      });
  });
}

function wireCompositionResultActions(root) {
  root.querySelectorAll('.comp-form-step-fix-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var nodeId = btn.getAttribute('data-comp-fix-node');
      if (nodeId) fixAndRerunFromStepCard(nodeId, btn);
    });
  });
  root.querySelectorAll('[data-comp-copy-text]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var value = btn.getAttribute('data-comp-copy-text') || '';
      var label = btn.getAttribute('data-comp-copy-label') || 'Content';
      copyCompositionText(value, label);
    });
  });
  root.querySelectorAll('[data-comp-copy-file]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var filePath = btn.getAttribute('data-comp-copy-file');
      var label = btn.getAttribute('data-comp-copy-label') || 'File content';
      if (!filePath) return;
      fetchCompositionPreviewText(filePath)
        .then(function(text) { copyCompositionText(text, label); })
        .catch(function(err) { toast('Failed to copy file content: ' + err.message, 'error'); });
    });
  });
  root.querySelectorAll('[data-comp-tab-button]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var groupKey = btn.getAttribute('data-comp-tab-group');
      var tabId = btn.getAttribute('data-comp-tab-id');
      if (!groupKey || !tabId) return;
      compFormTabState[getCompositionTabStateKey('no-run', groupKey)] = tabId;
      Object.keys(compFormTabState).forEach(function(stateKey) {
        if (stateKey.slice(stateKey.indexOf('::tab::') + 7) === groupKey) {
          compFormTabState[stateKey] = tabId;
        }
      });
      root.querySelectorAll('[data-comp-tab-button]').forEach(function(node) {
        if (node.getAttribute('data-comp-tab-group') !== groupKey) return;
        var active = node.getAttribute('data-comp-tab-id') === tabId;
        node.classList.toggle('active', active);
        node.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      root.querySelectorAll('[data-comp-tab-panel]').forEach(function(node) {
        if (node.getAttribute('data-comp-tab-group') !== groupKey) return;
        node.classList.toggle('active', node.getAttribute('data-comp-tab-id') === tabId);
      });
    });
  });
  root.querySelectorAll('[data-comp-filter-input]').forEach(function(input) {
    input.addEventListener('input', function() {
      var groupKey = input.getAttribute('data-comp-filter-group');
      var query = String(input.value || '').trim().toLowerCase();
      if (!groupKey) return;
      root.querySelectorAll('.comp-form-array-preview[data-comp-filter-group]').forEach(function(container) {
        if (container.getAttribute('data-comp-filter-group') !== groupKey) return;
        var visibleCount = 0;
        container.querySelectorAll('[data-comp-filter-item]').forEach(function(item) {
          var haystack = String(item.getAttribute('data-comp-filter-text') || '').toLowerCase();
          var match = !query || haystack.indexOf(query) >= 0;
          item.style.display = match ? '' : 'none';
          if (match) visibleCount++;
        });
        var countEl = container.querySelector('[data-comp-filter-count]');
        if (countEl) {
          countEl.textContent = visibleCount + ' of ' + container.querySelectorAll('[data-comp-filter-item]').length + ' items';
        }
        var emptyEl = container.querySelector('[data-comp-filter-empty]');
        if (emptyEl) emptyEl.style.display = visibleCount === 0 ? '' : 'none';
      });
    });
  });
}

function collectCompositionArtifactsFromValue(value, sourceLabel, results, seen) {
  if (value === undefined || value === null) return;

  if (typeof value === 'string') {
    var trimmed = value.trim();
    if (!trimmed) return;
    if (isCompositionLikelyUrl(trimmed)) {
      var urlKey = 'url:' + trimmed;
      if (!seen[urlKey]) {
        seen[urlKey] = true;
        results.push({ type: 'link', value: trimmed, source: sourceLabel });
      }
      return;
    }
    if (isCompositionLikelyFilePath(trimmed)) {
      var fileKey = 'file:' + trimmed;
      if (!seen[fileKey]) {
        seen[fileKey] = true;
        results.push({ type: 'file', value: trimmed, source: sourceLabel });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(function(item) {
      collectCompositionArtifactsFromValue(item, sourceLabel, results, seen);
    });
    return;
  }

  if (typeof value === 'object') {
    Object.keys(value).forEach(function(key) {
      collectCompositionArtifactsFromValue(value[key], sourceLabel, results, seen);
    });
  }
}

function collectCompositionArtifacts(data) {
  var results = [];
  var seen = {};

  if (data && data.pipelineOutputs) {
    collectCompositionArtifactsFromValue(data.pipelineOutputs, 'Final outputs', results, seen);
  }

  var nodeStates = (data && data.nodeStates) || {};
  Object.keys(nodeStates).forEach(function(nodeId) {
    var ns = nodeStates[nodeId];
    var sourceLabel = ns.workflowName || nodeId;
    collectCompositionArtifactsFromValue(ns.outputVariables, sourceLabel, results, seen);
  });

  return results;
}

function renderCompositionOutputs(outputs, runId, sectionKeyPrefix) {
  if (!outputs || Object.keys(outputs).length === 0) {
    return '<div class="comp-form-results-empty">No final outputs were produced by the pipeline output node.</div>';
  }

  var html = '<div class="comp-form-output-list">';
  Object.keys(outputs).forEach(function(key) {
    var value = outputs[key];
    var serialized = serializeCompositionResult(value);
    var kind = getCompositionOutputKind(value);
    var portDef = getCompositionOutputPortDefinition(key);
    var presentation = getCompositionOutputPresentation(key);
    var structuredValue = normalizeCompositionDisplayValue(value);
    if (typeof structuredValue === 'string' && structuredValue === value) {
      structuredValue = null;
    }
    var outputPathKey = (sectionKeyPrefix || 'outputs') + '.' + key;
    var richValueHtml = renderCompositionRichValue(value, presentation, runId || 'no-run', outputPathKey);
    html += '<div class="comp-form-output-item">';
    html += '<div class="comp-form-output-head">';
    html += '<div class="comp-form-output-title-wrap">';
    html += '<div class="comp-form-output-name">' + compEscHtml(humanizeVarName(key)) + '</div>';
    if (portDef && portDef.description) {
      html += '<div class="comp-form-output-description">' + compEscHtml(portDef.description) + '</div>';
    }
    html += '</div>';
    html += '<div class="comp-form-output-actions">';
    if (presentation && presentation.view && presentation.view !== 'auto') {
      html += '<span class="comp-form-output-badge">' + compEscHtml(presentation.view) + '</span>';
    }
    html += '<button class="comp-form-copy-btn" data-comp-copy-text="' + compEscAttr(serialized) + '" data-comp-copy-label="' + compEscAttr(humanizeVarName(key)) + '">Copy</button>';
    html += '</div>';
    html += '</div>';
    if (richValueHtml) {
      html += '<div class="comp-form-output-rich">' + richValueHtml + '</div>';
      html += renderCompositionStructuredFallback(structuredValue, runId || 'no-run', outputPathKey, 'Structured data');
    } else if (kind === 'markdown' && typeof value === 'string' && typeof marked !== 'undefined') {
      html += '<div class="comp-form-markdown-viewer">' + marked.parse(value) + '</div>';
    } else if (structuredValue) {
      html += '<div class="comp-form-json-viewer">' + renderCompositionStructuredValue(structuredValue, runId || 'no-run', outputPathKey, 0) + '</div>';
    } else {
      html += '<pre class="comp-form-output-value">' + compEscHtml(serialized) + '</pre>';
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function renderCompositionArtifacts(artifacts) {
  if (!artifacts || artifacts.length === 0) {
    return '<div class="comp-form-results-empty">No generated files or links were detected in the run outputs.</div>';
  }

  var html = '<div class="comp-form-artifact-list">';
  artifacts.forEach(function(artifact) {
    var kind = getCompositionArtifactKind(artifact.value);
    var fileUrl = '/api/file?path=' + encodeURIComponent(artifact.value);
    html += '<div class="comp-form-artifact-item">';
    html += '<div class="comp-form-artifact-head">';
    html += '<div class="comp-form-artifact-meta">' + compEscHtml(artifact.source || 'Output') + '</div>';
    if (kind === 'markdown' || kind === 'text' || kind === 'json') {
      html += '<button class="comp-form-copy-btn" data-comp-copy-text="' + compEscAttr(artifact.value) + '" data-comp-copy-label="File path">Copy Path</button>';
    }
    html += '</div>';
    if (artifact.type === 'link') {
      html += '<a class="comp-form-artifact-link" href="' + compEscAttr(artifact.value) + '" target="_blank" rel="noreferrer">' + compEscHtml(artifact.value) + '</a>';
    } else {
      html += '<a class="comp-form-artifact-link" href="' + fileUrl + '" target="_blank" rel="noreferrer">' + compEscHtml(artifact.value) + '</a>';
      if (kind === 'image') {
        html += '<img class="comp-form-artifact-image" src="' + fileUrl + '" alt="Preview">';
      } else if (kind === 'video') {
        html += '<video class="comp-form-artifact-video" src="' + fileUrl + '" controls preload="metadata"></video>';
      } else if (kind === 'audio') {
        html += '<audio class="comp-form-artifact-audio" src="' + fileUrl + '" controls preload="metadata"></audio>';
      } else if (kind === 'pdf') {
        html += '<iframe class="comp-form-artifact-pdf" src="' + fileUrl + '"></iframe>';
      } else if (kind === 'markdown') {
        html += '<div class="comp-form-artifact-actions"><button class="comp-form-copy-btn" data-comp-copy-file="' + compEscAttr(artifact.value) + '" data-comp-copy-label="Markdown">Copy Markdown</button></div>';
        html += '<div class="comp-form-artifact-preview comp-form-markdown-viewer" data-comp-preview-path="' + compEscAttr(artifact.value) + '" data-comp-preview-kind="markdown">Loading markdown preview...</div>';
      } else if (kind === 'text' || kind === 'json') {
        html += '<div class="comp-form-artifact-actions"><button class="comp-form-copy-btn" data-comp-copy-file="' + compEscAttr(artifact.value) + '" data-comp-copy-label="Text">Copy Text</button></div>';
        html += '<pre class="comp-form-artifact-preview comp-form-text-viewer" data-comp-preview-path="' + compEscAttr(artifact.value) + '" data-comp-preview-kind="' + compEscAttr(kind) + '">Loading text preview...</pre>';
      }
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function getRenderableStepOutputs(outputVariables) {
  var filtered = {};
  if (!outputVariables || typeof outputVariables !== 'object') return filtered;
  Object.keys(outputVariables).forEach(function(key) {
    if (key === '__done__') return;
    if (outputVariables[key] === undefined) return;
    filtered[key] = outputVariables[key];
  });
  return filtered;
}

function collectCompositionArtifactsForOutputs(outputs, sourceLabel) {
  var results = [];
  var seen = {};
  collectCompositionArtifactsFromValue(outputs, sourceLabel, results, seen);
  return results;
}

function renderCompositionStepOutputs(ns, depth, runId, pathKey) {
  var outputs = getRenderableStepOutputs(ns && ns.outputVariables);
  var outputKeys = Object.keys(outputs);
  if (outputKeys.length === 0) return '';

  var artifacts = collectCompositionArtifactsForOutputs(outputs, ns.workflowName || 'Step output');
  var detailKey = pathKey + ':outputs';
  var html = '<details class="comp-form-step-output-block" data-comp-details-key="' + compEscAttr(detailKey) + '"' + getCompositionDetailsOpenAttr(runId, detailKey, (depth || 0) > 0) + '>';
  html += '<summary>Outputs (' + compEscHtml(String(outputKeys.length)) + ')</summary>';
  html += '<div class="comp-form-step-output-inner">';
  html += renderCompositionOutputs(outputs, runId, pathKey + '.outputs');
  if (artifacts.length > 0) {
    html += '<div class="comp-form-step-output-artifacts">';
    html += '<div class="comp-form-results-section-title">Formatted Previews</div>';
    html += renderCompositionArtifacts(artifacts);
    html += '</div>';
  }
  html += '</div>';
  html += '</details>';
  return html;
}

function renderCompositionStepResults(data) {
  var order = (data && data.executionOrder) || [];
  var nodeStates = (data && data.nodeStates) || {};
  var runId = data && data.runId ? data.runId : 'no-run';
  if (order.length === 0) {
    return '<div class="comp-form-results-empty">No step data available yet.</div>';
  }

  function renderStepList(stepOrder, states, depth, parentPath) {
    var html = '<div class="comp-form-step-list' + (depth > 0 ? ' comp-form-step-list-nested' : '') + '">';
    stepOrder.forEach(function(nodeId, index) {
      var ns = states[nodeId] || {};
      var status = ns.status || 'pending';
      var statusClass = status === 'completed' ? 'ok' : status === 'failed' ? 'fail' : status === 'skipped' ? 'skip' : 'run';
      var pathKey = (parentPath ? parentPath + '>' : '') + nodeId;
      html += '<div class="comp-form-step-item comp-form-step-' + compEscAttr(statusClass) + (depth > 0 ? ' comp-form-step-item-nested' : '') + '">';
      html += '<div class="comp-form-step-head">';
      html += '<span class="comp-form-step-index">' + (index + 1) + '</span>';
      html += '<span class="comp-form-step-name">' + compEscHtml(ns.workflowName || nodeId) + '</span>';
      html += '<span class="comp-form-step-status">' + compEscHtml(status) + '</span>';
      html += '</div>';
      if (ns.stepsTotal) {
        html += '<div class="comp-form-step-meta">' + compEscHtml(String(ns.stepsCompleted || 0)) + '/' + compEscHtml(String(ns.stepsTotal)) + ' steps';
        if (ns.durationMs) html += ' • ' + compEscHtml((ns.durationMs / 1000).toFixed(1)) + 's';
        html += '</div>';
      } else if (ns.durationMs) {
        html += '<div class="comp-form-step-meta">' + compEscHtml((ns.durationMs / 1000).toFixed(1)) + 's</div>';
      }
      if (ns.error) {
        html += '<div class="comp-form-step-error">' + compEscHtml(ns.error) + '</div>';
      }
      if (status === 'failed' && ns.error && (ns.workflowId === '__script__' || ns.workflowId === '__script_file__')) {
        html += '<button class="comp-form-step-fix-btn" data-comp-fix-node="' + compEscAttr(nodeId) + '">&#x26A1; Fix &amp; Re-run</button>';
      }
      if (ns.currentStep) {
        html += '<div class="comp-form-step-meta">Current: ' + compEscHtml(ns.currentStep) + '</div>';
      }
      if (ns.expectationResults && ns.expectationResults.length > 0) {
        var failedChecks = ns.expectationResults.filter(function(r) { return r && r.passed === false; });
        if (failedChecks.length > 0) {
          html += '<div class="comp-form-step-error">' + failedChecks.map(function(r) { return compEscHtml(r.detail || r.description || 'Expectation failed'); }).join('<br>') + '</div>';
        }
      }
      if (ns.logs && ns.logs.length > 0) {
        var logsKey = pathKey + ':logs';
        html += '<details class="comp-form-step-logs" data-comp-details-key="' + compEscAttr(logsKey) + '"' + getCompositionDetailsOpenAttr(runId, logsKey, false) + '>';
        html += '<summary>Logs (' + ns.logs.length + ')</summary>';
        html += '<pre class="comp-form-step-log-body">' + compEscHtml(ns.logs.join('\n')) + '</pre>';
        html += '</details>';
      }
      html += renderCompositionStepOutputs(ns, depth, runId, pathKey);
      if (ns.subExecutionOrder && ns.subExecutionOrder.length > 0 && ns.subNodeStates) {
        var childrenKey = pathKey + ':children';
        html += '<details class="comp-form-step-children" data-comp-details-key="' + compEscAttr(childrenKey) + '"' + getCompositionDetailsOpenAttr(runId, childrenKey, status === 'running' || status === 'failed') + '>';
        html += '<summary>Sub-steps (' + compEscHtml(String(ns.stepsCompleted || 0)) + '/' + compEscHtml(String(ns.stepsTotal || ns.subExecutionOrder.length)) + ')</summary>';
        html += renderStepList(ns.subExecutionOrder, ns.subNodeStates, depth + 1, pathKey);
        html += '</details>';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  return renderStepList(order, nodeStates, 0, 'root');
}

function updateCompositionFormResults(data) {
  var wrap = document.querySelector('#comp-form-results');
  if (!wrap) return;

  captureCompositionDetailsState(wrap, data && data.runId ? data.runId : 'no-run');

  var statusTone = data.done ? (data.success ? 'ok' : 'fail') : 'run';
  var statusText = data.done
    ? (data.success ? 'Completed successfully' : 'Finished with errors')
    : 'Running';
  var outputs = data.pipelineOutputs || {};
  var artifacts = collectCompositionArtifacts(data);

  var html = '<div class="comp-form-results-card">';
  html += '<div class="comp-form-results-header">';
  html += '<div>';
  html += '<div class="comp-form-results-kicker">Run Results</div>';
  html += '<div class="comp-form-results-title">' + compEscHtml(statusText) + '</div>';
  html += '</div>';
  html += '<div class="comp-form-results-pill comp-form-results-pill-' + compEscAttr(statusTone) + '">' + compEscHtml(statusText) + '</div>';
  html += '</div>';
  if (data.error) {
    html += '<div class="comp-form-run-error">' + compEscHtml(data.error) + '</div>';
  }
  html += '<div class="comp-form-results-grid">';
  html += '<div class="comp-form-results-section">';
  html += '<div class="comp-form-results-section-title">Final Outputs</div>';
  html += renderCompositionOutputs(outputs, data && data.runId ? data.runId : 'no-run', 'finalOutputs');
  html += '</div>';
  html += '<div class="comp-form-results-section">';
  html += '<div class="comp-form-results-section-title">Generated Files and Links</div>';
  html += renderCompositionArtifacts(artifacts);
  html += '</div>';
  html += '</div>';
  html += '<div class="comp-form-results-section">';
  html += '<div class="comp-form-results-section-title">Per-Step Status</div>';
  html += renderCompositionStepResults(data);
  html += '</div>';
  html += '</div>';

  wrap.innerHTML = html;
  wireCompositionResultActions(wrap);
  wireCompositionDetailsState(wrap, data && data.runId ? data.runId : 'no-run');
  hydrateCompositionArtifactPreviews(wrap);
}

function parseCompositionRunInput(input, rawValue) {
  if (input.type === 'boolean') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      return { isEmpty: true, value: undefined };
    }
    return { isEmpty: false, value: rawValue === 'true' };
  }

  var stringValue = typeof rawValue === 'string' ? rawValue : '';
  var trimmed = stringValue.trim();
  if (trimmed === '') {
    return { isEmpty: true, value: undefined };
  }

  if (input.type === 'number') {
    var parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      return { isEmpty: false, error: 'Enter a valid number for ' + humanizeVarName(input.key) };
    }
    return { isEmpty: false, value: parsed };
  }

  if (input.type === 'string[]') {
    return {
      isEmpty: false,
      value: stringValue.split('\n').map(function(line) { return line.trim(); }).filter(function(line) { return line; }),
    };
  }

  if (input.type === 'object') {
    try {
      var parsed2 = JSON.parse(trimmed);
      if (typeof parsed2 === 'object' && parsed2 !== null) {
        return { isEmpty: false, value: parsed2 };
      }
    } catch(e) { /* not valid JSON, treat as string */ }
    return { isEmpty: false, value: trimmed };
  }

  return { isEmpty: false, value: stringValue };
}

function closeCompositionRunForm() {
  var modal = document.querySelector('#comp-run-modal');
  if (modal) modal.remove();
}

function renderCompositionFormResultsPlaceholder(inputs) {
  var inputCount = Array.isArray(inputs) ? inputs.length : 0;
  var nodes = Array.isArray(compData && compData.nodes) ? compData.nodes : [];
  var stepCount = nodes.length;
  var outputCount = nodes.filter(function(node) {
    return node && node.workflowId === '__output__';
  }).length;

  var html = '<div class="comp-form-results-card comp-form-results-card-empty">';
  html += '<div class="comp-form-results-header">';
  html += '<div>';
  html += '<div class="comp-form-results-kicker">Run Results</div>';
  html += '<div class="comp-form-results-title">Waiting to run</div>';
  html += '</div>';
  html += '<div class="comp-form-results-pill comp-form-results-pill-idle">Ready</div>';
  html += '</div>';
  html += '<div class="comp-form-results-summary">';
  html += '<div class="comp-form-results-stat"><span class="comp-form-results-stat-value">' + compEscHtml(String(inputCount)) + '</span><span class="comp-form-results-stat-label">Inputs</span></div>';
  html += '<div class="comp-form-results-stat"><span class="comp-form-results-stat-value">' + compEscHtml(String(stepCount)) + '</span><span class="comp-form-results-stat-label">Steps</span></div>';
  html += '<div class="comp-form-results-stat"><span class="comp-form-results-stat-value">' + compEscHtml(String(outputCount)) + '</span><span class="comp-form-results-stat-label">Output Nodes</span></div>';
  html += '</div>';
  html += '<div class="comp-form-results-section">';
  html += '<div class="comp-form-results-section-title">What Shows Up Here</div>';
  html += '<div class="comp-form-results-empty">Run output, generated files, and per-step execution status stay in this panel so the form remains usable while the pipeline is active.</div>';
  html += '</div>';
  html += '</div>';
  return html;
}

async function showCompositionRunForm() {
  if (!compData) return;

  delete compositionInterfaceCache[compData.id];
  var iface = await fetchCompositionInterface(compData.id);
  if (iface && iface.error) {
    toast(iface.error || 'Unable to load pipeline inputs', 'error');
    return;
  }

  var inputs = normalizeCompositionRunInputs((iface && iface.inputs) || []);
  if (inputs.length === 0) {
    startCompositionRun({});
    return;
  }

  closeCompositionRunForm();

  var overlay = document.createElement('div');
  overlay.id = 'comp-run-modal';
  overlay.className = 'comp-modal-overlay';

  var html = '<div class="comp-modal comp-run-modal">';
  html += '<div class="comp-modal-header">';
  html += '<span>&#x25b6; Run Pipeline</span>';
  html += '<button class="comp-modal-close" id="comp-run-modal-close">&times;</button>';
  html += '</div>';
  html += '<div class="comp-modal-body">';
  html += '<div class="comp-run-modal-desc">These fields are generated from the pipeline\'s exposed inputs so someone can run it without editing the graph.</div>';
  html += renderCompositionRunFields(inputs);
  html += '<div class="comp-run-modal-actions">';
  html += '<button class="comp-approval-btn comp-approval-btn-approve" id="comp-run-submit">Run Pipeline</button>';
  html += '<button class="comp-approval-btn comp-approval-btn-reject" id="comp-run-cancel">Cancel</button>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  wireCompositionRunInputActions(overlay, inputs);

  function submit() {
    var collected = collectCompositionRunValues(overlay, inputs);
    if (collected.error) {
      toast(collected.error, 'error');
      if (collected.errorElement) collected.errorElement.focus();
      return;
    }
    if (collected.missing.length > 0) {
      toast('Missing required inputs: ' + collected.missing.join(', '), 'error');
      return;
    }

    saveCompositionRunValues(compData.id, collected.rawValues);
    closeCompositionRunForm();
    startCompositionRun(collected.variables);
  }

  var closeBtn = overlay.querySelector('#comp-run-modal-close');
  var cancelBtn = overlay.querySelector('#comp-run-cancel');
  var submitBtn = overlay.querySelector('#comp-run-submit');
  if (closeBtn) closeBtn.addEventListener('click', closeCompositionRunForm);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCompositionRunForm);
  if (submitBtn) submitBtn.addEventListener('click', submit);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeCompositionRunForm();
  });
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeCompositionRunForm();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });

  var firstInput = overlay.querySelector('.comp-run-input');
  if (firstInput) firstInput.focus();
}

async function renderCompositionFormPage() {
  if (!compData) return;

  delete compositionInterfaceCache[compData.id];
  var iface = await fetchCompositionInterface(compData.id);
  if (iface && iface.error) {
    toast(iface.error || 'Unable to load pipeline inputs', 'error');
    renderGraphEditor();
    return;
  }

  var inputs = normalizeCompositionRunInputs((iface && iface.inputs) || []);
  var main = document.querySelector('#main');
  if (!main) return;

  var html = '<div class="comp-form-page">';
  html += '<div class="comp-form-shell">';
  html += '<div class="comp-form-hero">';
  html += '<div class="comp-form-hero-copy">';
  html += '<div class="comp-form-kicker">Pipeline Form</div>';
  html += '<h1 class="comp-form-title">' + compEscHtml(compData.name) + '</h1>';
  html += '<p class="comp-form-subtitle">' + compEscHtml(compData.description || 'Run this pipeline by filling in the fields below.') + '</p>';
  html += '</div>';
  html += '<div class="comp-form-hero-actions">';
  html += '<button class="comp-tb-btn" id="comp-form-share-link">&#x1f517; Copy Form Link</button>';
  html += '<button class="comp-tb-btn" id="comp-form-open-app">&#x1f4f1; Open as App</button>';
  html += '<button class="comp-tb-btn" id="comp-form-open-editor">Open Editor</button>';
  html += '</div>';
  html += '</div>';

  html += '<div class="comp-form-layout">';
  html += '<div class="comp-form-main">';
  html += '<div class="comp-progress-bar-wrap comp-form-progress" id="comp-progress-wrap" style="display:none;">';
  html += '<div class="comp-progress-bar" id="comp-progress-bar" style="width:0%"></div>';
  html += '<span class="comp-progress-text" id="comp-progress-text"></span>';
  html += '</div>';
  html += '<div class="comp-form-card">';
  if (inputs.length === 0) {
    html += '<div class="comp-form-empty">This pipeline has no external inputs. You can run it directly.</div>';
  } else {
    html += '<div class="comp-run-modal-desc">These inputs are generated from the pipeline interface and are safe to share with non-technical users.</div>';
    html += renderCompositionRunFields(inputs);
  }
  html += '<div class="comp-run-modal-actions">';
  html += '<button class="comp-approval-btn comp-approval-btn-approve" id="comp-run-btn">Run Pipeline</button>';
  html += '<button class="comp-approval-btn comp-approval-btn-reject" id="comp-cancel-btn" style="display:none;">Stop</button>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="comp-form-results-wrap">';
  html += '<div id="comp-form-results">' + renderCompositionFormResultsPlaceholder(inputs) + '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  main.innerHTML = html;
  wireCompositionRunInputActions(main, inputs);

  var shareBtn = document.querySelector('#comp-form-share-link');
  if (shareBtn) shareBtn.addEventListener('click', copyCompositionFormShareLink);

  var openAppBtn = document.querySelector('#comp-form-open-app');
  if (openAppBtn) {
    openAppBtn.addEventListener('click', function() {
      if (typeof updateHash === 'function') updateHash('compositions', compData.id, 'app');
      selectComposition(compData.id, 'app');
    });
  }

  var openEditorBtn = document.querySelector('#comp-form-open-editor');
  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', function() {
      if (typeof updateHash === 'function') updateHash('compositions', compData.id);
      selectComposition(compData.id, null);
    });
  }

  var runBtn = document.querySelector('#comp-run-btn');
  if (runBtn) {
    runBtn.addEventListener('click', function() {
      if (inputs.length === 0) {
        startCompositionRun({});
        return;
      }

      var collected = collectCompositionRunValues(main, inputs);
      if (collected.error) {
        toast(collected.error, 'error');
        if (collected.errorElement) collected.errorElement.focus();
        return;
      }
      if (collected.missing.length > 0) {
        toast('Missing required inputs: ' + collected.missing.join(', '), 'error');
        return;
      }

      saveCompositionRunValues(compData.id, collected.rawValues);
      startCompositionRun(collected.variables);
    });
  }

  var cancelBtn = document.querySelector('#comp-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { cancelCompositionRun(); });

  fetch('/api/compositions/run/status')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var viewData = projectNestedCompositionRunStatus(data);
      if (!viewData) return;
      updateCompositionFormResults(viewData);
      if (data && data.active) startCompRunPolling();
      applyCompositionRunUiState(data, viewData);
    })
    .catch(function() { /* ignore initial status fetch errors */ });

  var firstInput = main.querySelector('.comp-run-input');
  if (firstInput) firstInput.focus();
}

function startCompositionRun(variables) {
  if (!compData) return;

  // Client-side graph validation
  if (compData.nodes.length > 0) {
    var graphValidation = clientValidateRunGraph();
    if (graphValidation.error) {
      toast(graphValidation.message, 'error');
      return;
    }
  }

  if (compData.nodes.length === 0) {
    toast('Add at least one workflow to run this pipeline', 'error');
    return;
  }

  var runVariables = variables || {};

  fetch('/api/compositions/' + encodeURIComponent(compData.id) + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables: runVariables }),
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        toast('Pipeline started', 'success');
        var runBtn = document.querySelector('#comp-run-btn');
        var cancelBtn = document.querySelector('#comp-cancel-btn');
        var progWrap = document.querySelector('#comp-progress-wrap');
        if (runBtn) runBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = '';
        if (progWrap) progWrap.style.display = '';
        var bar = document.querySelector('#comp-progress-bar');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#7c3aed'; }
        lastNodeStates = null;
        var ttip = document.querySelector('#comp-port-tooltip');
        if (ttip) ttip.classList.remove('visible');
        startCompRunPolling();
      } else {
        // Show structural issues if pre-flight validation failed
        if (data.issues && Array.isArray(data.issues) && data.issues.length > 0) {
          toast(data.error || 'Failed to start', 'error');
          if (typeof showValidationWarnings === 'function') {
            showValidationWarnings({
              valid: false,
              repairs: [],
              remainingIssues: data.issues,
              smokeTests: [],
              iterations: 0,
            });
          }
        } else {
          toast(data.error || 'Failed to start', 'error');
        }
      }
    })
    .catch(function(err) { toast('Run failed: ' + err.message, 'error'); });
}

function startCompRunPolling() {
  if (compRunPollTimer) clearInterval(compRunPollTimer);
  compRunPollTimer = setInterval(pollCompRunStatus, 800);
}

function stopCompRunPolling() {
  if (compRunPollTimer) { clearInterval(compRunPollTimer); compRunPollTimer = null; }
}

function pollCompRunStatus() {
  fetch('/api/compositions/run/status')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.active && !data.done) {
        stopCompRunPolling();
        return;
      }

      var viewData = projectNestedCompositionRunStatus(data);
      if (!viewData) {
        applyCompositionRunUiState(null, null);
        return;
      }

      applyCompositionRunUiState(data, viewData);

      // Update overall progress bar
      var pct = viewData.nodesTotal > 0 ? Math.round((viewData.nodesCompleted / viewData.nodesTotal) * 100) : 0;
      var bar = document.querySelector('#comp-progress-bar');
      var text = document.querySelector('#comp-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = viewData.nodesCompleted + '/' + viewData.nodesTotal + ' steps';
      updateCompositionFormResults(viewData);

      // Update per-node states
      if (viewData.nodeStates) {
        lastNodeStates = viewData.nodeStates;
        for (var nodeId in viewData.nodeStates) {
          var ns = viewData.nodeStates[nodeId];
          updateNodeExecutionState(nodeId, ns.status);
          if (ns.status === 'running' || ns.status === 'retrying' || ns.status === 'completed') {
            updateNodeStepProgress(nodeId, ns.stepsCompleted, ns.stepsTotal);
          }
          if (ns.status === 'retrying' && ns.retryAttempt && ns.retryMax) {
            updateNodeRetryBadge(nodeId, ns.retryAttempt, ns.retryMax);
          } else {
            removeNodeRetryBadge(nodeId);
          }
          // Update image viewer nodes with runtime file path
          if (ns.workflowId === '__image_viewer__' && ns.status === 'completed') {
            var runtimePath = (ns.outputVariables && ns.outputVariables.file_path) || (ns.inputVariables && ns.inputVariables.file_path);
            if (runtimePath && typeof runtimePath === 'string') {
              var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
              if (nodeEl) {
                var imgWrap = nodeEl.querySelector('.comp-image-viewer-wrap');
                if (imgWrap) {
                  var existingImg = imgWrap.querySelector('.comp-image-viewer-img');
                  var placeholder = imgWrap.querySelector('.comp-image-viewer-placeholder');
                  if (existingImg) {
                    var newSrc = '/api/file?path=' + encodeURIComponent(runtimePath);
                    if (existingImg.getAttribute('src') !== newSrc) {
                      existingImg.setAttribute('src', newSrc);
                      existingImg.style.display = '';
                      if (placeholder) placeholder.style.display = 'none';
                    }
                  } else {
                    // No img element yet — create one
                    var img = document.createElement('img');
                    img.className = 'comp-image-viewer-img';
                    img.src = '/api/file?path=' + encodeURIComponent(runtimePath);
                    img.alt = 'Preview';
                    img.onerror = function() { this.style.display = 'none'; if (placeholder) placeholder.style.display = ''; };
                    if (placeholder) {
                      imgWrap.insertBefore(img, placeholder);
                      placeholder.style.display = 'none';
                    } else {
                      var resizeHandle = imgWrap.querySelector('.comp-image-viewer-resize-handle');
                      imgWrap.insertBefore(img, resizeHandle);
                    }
                  }
                }
              }
            }
          }
          // Update media player nodes with runtime preview
          if (ns.workflowId === '__media__' && ns.status === 'completed') {
            var mpRuntimePath = (ns.outputVariables && ns.outputVariables.file_path) || (ns.inputVariables && ns.inputVariables.file_path);
            if (mpRuntimePath && typeof mpRuntimePath === 'string') {
              var mpNodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
              if (mpNodeEl) {
                var mpWrap = mpNodeEl.querySelector('.comp-media-wrap');
                if (mpWrap) {
                  var mpDetected = detectMediaTypeFromExt(mpRuntimePath, 'auto');
                  var mpNewSrc = '/api/file?path=' + encodeURIComponent(mpRuntimePath);
                  var mpPlaceholder = mpWrap.querySelector('.comp-media-placeholder');
                  var mpResizeHandle = mpWrap.querySelector('.comp-media-resize-handle');

                  if (mpDetected === 'image') {
                    var mpExistingImg = mpWrap.querySelector('.comp-media-preview-img');
                    if (mpExistingImg) {
                      if (mpExistingImg.getAttribute('src') !== mpNewSrc) {
                        mpExistingImg.setAttribute('src', mpNewSrc);
                        mpExistingImg.style.display = '';
                        if (mpPlaceholder) mpPlaceholder.style.display = 'none';
                      }
                    } else {
                      var mpImg = document.createElement('img');
                      mpImg.className = 'comp-media-preview-img';
                      mpImg.src = mpNewSrc;
                      mpImg.alt = 'Preview';
                      mpImg.onerror = function() { this.style.display = 'none'; if (mpPlaceholder) mpPlaceholder.style.display = ''; };
                      if (mpPlaceholder) { mpPlaceholder.style.display = 'none'; }
                      if (mpResizeHandle) mpWrap.insertBefore(mpImg, mpResizeHandle);
                      else mpWrap.insertBefore(mpImg, mpWrap.firstChild);
                    }
                  } else if (mpDetected === 'video') {
                    var mpExistingVid = mpWrap.querySelector('.comp-media-preview-video');
                    if (mpExistingVid) {
                      if (mpExistingVid.getAttribute('src') !== mpNewSrc) {
                        mpExistingVid.setAttribute('src', mpNewSrc);
                        mpExistingVid.style.display = '';
                        if (mpPlaceholder) mpPlaceholder.style.display = 'none';
                      }
                    } else {
                      var mpVid = document.createElement('video');
                      mpVid.className = 'comp-media-preview-video';
                      mpVid.src = mpNewSrc;
                      mpVid.controls = true;
                      mpVid.preload = 'metadata';
                      mpVid.style.cssText = 'width:100%;height:100%;object-fit:contain;';
                      mpVid.onerror = function() { this.style.display = 'none'; if (mpPlaceholder) mpPlaceholder.style.display = ''; };
                      if (mpPlaceholder) { mpPlaceholder.style.display = 'none'; }
                      if (mpResizeHandle) mpWrap.insertBefore(mpVid, mpResizeHandle);
                      else mpWrap.insertBefore(mpVid, mpWrap.firstChild);
                    }
                  } else if (mpDetected === 'audio') {
                    var mpExistingAudio = mpWrap.querySelector('.comp-media-audio-inline');
                    if (!mpExistingAudio) {
                      var mpAudioDiv = document.createElement('div');
                      mpAudioDiv.className = 'comp-media-audio-inline';
                      mpAudioDiv.innerHTML = '<span style="font-size:1.2rem;">\uD83C\uDFB5</span><audio src="' + mpNewSrc + '" controls preload="metadata" style="width:100%;height:28px;"></audio>';
                      if (mpPlaceholder) { mpPlaceholder.style.display = 'none'; }
                      if (mpResizeHandle) mpWrap.insertBefore(mpAudioDiv, mpResizeHandle);
                      else mpWrap.insertBefore(mpAudioDiv, mpWrap.firstChild);
                    }
                  } else {
                    // PDF/text/other — show type icon
                    if (mpPlaceholder) {
                      var typeIcons = { pdf: '\uD83D\uDCC4', text: '\uD83D\uDCDD' };
                      mpPlaceholder.innerHTML = '<span style="font-size:1.5rem;">' + (typeIcons[mpDetected] || '\u25B6') + '</span><br>' + mpDetected.charAt(0).toUpperCase() + mpDetected.slice(1);
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Handle pending approvals
      if (data.pendingApprovals && data.pendingApprovals.length > 0) {
        showApprovalDialog(data.pendingApprovals[0]);
      } else {
        hideApprovalDialog();
      }

      if (data.done) {
        stopCompRunPolling();
        hideApprovalDialog();
        var runBtn = document.querySelector('#comp-run-btn');
        var cancelBtn = document.querySelector('#comp-cancel-btn');
        if (runBtn) runBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = 'none';

        var progressBar = document.querySelector('#comp-progress-bar');
        if (viewData.success) {
          toast('Pipeline finished! (' + (viewData.durationMs / 1000).toFixed(1) + 's)', 'success');
          if (progressBar) progressBar.style.background = '#22c55e';
        } else {
          toast('Pipeline failed: ' + (viewData.error || 'Something went wrong'), 'error');
          if (progressBar) progressBar.style.background = '#ef4444';

          // Notify chat of pipeline failure
          /** @type {FailedNodeInfo[]} */
          var failedNodes = [];
          if (viewData.nodeStates) {
            for (var failNodeId in viewData.nodeStates) {
              var failNs = viewData.nodeStates[failNodeId];
              if (failNs.status === 'failed' && failNs.error) {
                var failNodeData = compData && compData.nodes ? compData.nodes.find(function(n) { return n.id === failNodeId; }) : null;
                failedNodes.push({
                  nodeId: failNodeId,
                  nodeLabel: failNodeData ? (failNodeData.label || failNodeId) : failNodeId,
                  error: failNs.error,
                  isScript: failNodeData ? (failNodeData.workflowId === '__script__' || failNodeData.workflowId === '__script_file__') : false,
                  nodeType: failNodeData ? failNodeData.workflowId : 'unknown',
                });
              }
            }
          }
          if (failedNodes.length > 0 && typeof window.notifyChatOfPipelineFailure === 'function') {
            window.notifyChatOfPipelineFailure({
              compositionId: compData ? compData.id : '',
              compositionName: compData ? (compData.name || compData.id) : '',
              failedNodes: failedNodes,
              timestamp: Date.now(),
            });
          }
        }

        // Re-render nodes so image viewers pick up runtime file paths
        renderNodes();
        renderEdges();
        wireUpCanvas();
        // Re-apply execution state overlays after re-render
        if (viewData.nodeStates) {
          for (var doneNodeId in viewData.nodeStates) {
            var doneNs = viewData.nodeStates[doneNodeId];
            updateNodeExecutionState(doneNodeId, doneNs.status);
          }
        }

        // Hide progress bar after 5s; clear overlays only on success
        // On failure, keep error banners visible so user can see what went wrong
        setTimeout(function() {
          var wrap = document.querySelector('#comp-progress-wrap');
          if (wrap) wrap.style.display = 'none';
          if (viewData.success) {
            clearNodeExecutionStates();
          } else {
            clearNonErrorExecutionStates();
          }
        }, 5000);
      }
    })
    .catch(function() { /* ignore polling errors */ });
}

function cancelCompositionRun() {
  fetch('/api/compositions/run/cancel', { method: 'POST' })
    .then(function(res) { return res.json(); })
    .then(function() { toast('Pipeline stopped', 'success'); })
    .catch(function(err) { toast('Cancel failed: ' + err.message, 'error'); });
}

// ── Batch Execution ────────────────────────────────────────

var batchPollTimer = null;

function showBatchConfigModal() {
  if (!compData) return;

  // Gather all unique input variables from the pipeline's workflow nodes
  var allVars = [];
  var seenVars = {};
  compData.nodes.forEach(function(node) {
    if (node.workflowId === '__approval_gate__') return;
    var wf = getWorkflowForNode(node);
    if (!wf || !wf.variables) return;
    wf.variables.forEach(function(v) {
      if (!seenVars[v.name]) {
        seenVars[v.name] = true;
        allVars.push({ name: v.name, description: v.description || '', type: v.type || 'string' });
      }
    });
  });

  if (allVars.length === 0) {
    toast('No variables found — add workflows with input variables first', 'error');
    return;
  }

  // Remove existing modal
  var existing = document.querySelector('#comp-batch-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'comp-batch-modal';
  overlay.className = 'comp-batch-overlay';

  var html = '<div class="comp-batch-dialog">';
  html += '<div class="comp-batch-header">';
  html += '<span style="font-size:1.1rem;">&#x1f4e6;</span>';
  html += '<span class="comp-batch-title">Batch Run</span>';
  html += '<button class="comp-batch-close" id="comp-batch-close">&times;</button>';
  html += '</div>';
  html += '<div class="comp-batch-desc">Run this pipeline multiple times with different variable values.</div>';

  // Variable pool editor
  html += '<div class="comp-batch-pools" id="comp-batch-pools">';
  html += '<div class="comp-batch-pool-row">';
  html += '<select class="comp-props-input comp-batch-var-select" id="comp-batch-var-select">';
  for (var i = 0; i < allVars.length; i++) {
    html += '<option value="' + compEscAttr(allVars[i].name) + '">' + compEscHtml(humanizeVarName(allVars[i].name)) + '</option>';
  }
  html += '</select>';
  html += '<button class="comp-tb-btn" id="comp-batch-add-pool">+ Add Variable</button>';
  html += '</div>';
  html += '</div>';

  // Pool list (initially empty)
  html += '<div id="comp-batch-pool-list"></div>';

  // Mode select
  html += '<div class="comp-batch-mode-row">';
  html += '<span style="font-size:0.75rem;color:#94a3b8;">Mode:</span>';
  html += '<select class="comp-props-input" id="comp-batch-mode" style="width:auto;">';
  html += '<option value="zip">Zip (parallel iteration)</option>';
  html += '<option value="product">Product (all combinations)</option>';
  html += '</select>';
  html += '</div>';

  // Delay
  html += '<div class="comp-batch-mode-row">';
  html += '<span style="font-size:0.75rem;color:#94a3b8;">Delay between runs:</span>';
  html += '<input type="number" class="comp-props-input" id="comp-batch-delay" value="5" min="1" max="300" style="width:60px;">';
  html += '<span style="font-size:0.7rem;color:#64748b;">seconds</span>';
  html += '</div>';

  // Iteration count preview
  html += '<div class="comp-batch-preview" id="comp-batch-preview">Add variables to see iteration count</div>';

  // Actions
  html += '<div class="comp-batch-actions">';
  html += '<button class="comp-approval-btn comp-approval-btn-approve" id="comp-batch-start" disabled>Start Batch</button>';
  html += '<button class="comp-approval-btn comp-approval-btn-reject" id="comp-batch-cancel-modal">Cancel</button>';
  html += '</div>';

  html += '</div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // State for pools
  var pools = [];

  function updatePreview() {
    var preview = document.querySelector('#comp-batch-preview');
    var startBtn = document.querySelector('#comp-batch-start');
    if (pools.length === 0) {
      if (preview) preview.textContent = 'Add variables to see iteration count';
      if (startBtn) startBtn.disabled = true;
      return;
    }
    var mode = (document.querySelector('#comp-batch-mode') || {}).value || 'zip';
    var count = 0;
    if (mode === 'zip') {
      count = Math.min.apply(null, pools.map(function(p) { return p.values.length; }));
    } else {
      count = pools.reduce(function(acc, p) { return acc * p.values.length; }, 1);
    }
    if (preview) preview.textContent = count + ' iteration' + (count !== 1 ? 's' : '') + ' will run';
    if (startBtn) startBtn.disabled = count === 0;
  }

  function renderPoolList() {
    var list = document.querySelector('#comp-batch-pool-list');
    if (!list) return;
    var html = '';
    pools.forEach(function(pool, idx) {
      html += '<div class="comp-batch-pool-card">';
      html += '<div class="comp-batch-pool-header">';
      html += '<span class="comp-batch-pool-name">' + compEscHtml(humanizeVarName(pool.variableName)) + '</span>';
      html += '<span style="color:#64748b;font-size:0.65rem;">' + pool.values.length + ' value' + (pool.values.length !== 1 ? 's' : '') + '</span>';
      html += '<button class="comp-batch-pool-remove" data-pool-idx="' + idx + '">&times;</button>';
      html += '</div>';
      html += '<textarea class="comp-props-input comp-batch-pool-textarea" data-pool-idx="' + idx + '" placeholder="One value per line...">' + compEscHtml(pool.values.join('\n')) + '</textarea>';
      html += '</div>';
    });
    list.innerHTML = html;

    // Wire up remove buttons
    list.querySelectorAll('.comp-batch-pool-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        pools.splice(parseInt(btn.dataset.poolIdx), 1);
        renderPoolList();
        updatePreview();
      });
    });

    // Wire up textarea changes
    list.querySelectorAll('.comp-batch-pool-textarea').forEach(function(ta) {
      ta.addEventListener('input', function() {
        var idx = parseInt(ta.dataset.poolIdx);
        pools[idx].values = ta.value.split('\n').filter(function(v) { return v.trim() !== ''; });
        updatePreview();
        // Update count badge
        var countSpan = ta.parentElement.querySelector('.comp-batch-pool-header span:nth-child(2)');
        if (countSpan) countSpan.textContent = pools[idx].values.length + ' value' + (pools[idx].values.length !== 1 ? 's' : '');
      });
    });
  }

  // Wire up add pool button
  var addPoolBtn = document.querySelector('#comp-batch-add-pool');
  if (addPoolBtn) {
    addPoolBtn.addEventListener('click', function() {
      var select = document.querySelector('#comp-batch-var-select');
      if (!select) return;
      var varName = select.value;
      if (pools.some(function(p) { return p.variableName === varName; })) {
        toast(humanizeVarName(varName) + ' already added', 'error');
        return;
      }
      pools.push({ variableName: varName, values: [] });
      renderPoolList();
      updatePreview();
    });
  }

  // Wire up mode change
  var modeSelect = document.querySelector('#comp-batch-mode');
  if (modeSelect) modeSelect.addEventListener('change', updatePreview);

  // Wire up close/cancel
  var closeBtn = document.querySelector('#comp-batch-close');
  var cancelModalBtn = document.querySelector('#comp-batch-cancel-modal');
  function closeBatchModal() {
    var modal = document.querySelector('#comp-batch-modal');
    if (modal) modal.remove();
  }
  if (closeBtn) closeBtn.addEventListener('click', closeBatchModal);
  if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeBatchModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeBatchModal();
  });

  // Wire up start button
  var startBtn = document.querySelector('#comp-batch-start');
  if (startBtn) {
    startBtn.addEventListener('click', function() {
      var mode = (document.querySelector('#comp-batch-mode') || {}).value || 'zip';
      var delay = parseInt((document.querySelector('#comp-batch-delay') || {}).value) || 5;
      var batchConfig = {
        pools: pools,
        mode: mode,
        delayBetweenMs: delay * 1000,
      };

      closeBatchModal();
      startBatchRun(batchConfig);
    });
  }
}

function startBatchRun(batchConfig) {
  if (!compData) return;

  fetch('/api/compositions/' + encodeURIComponent(compData.id) + '/batch-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchConfig: batchConfig }),
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.success) {
        toast('Batch start failed: ' + (data.error || 'Unknown'), 'error');
        return;
      }
      toast('Batch started: ' + data.totalIterations + ' iterations', 'success');

      // Show progress
      var progressWrap = document.querySelector('#comp-progress-wrap');
      if (progressWrap) {
        progressWrap.style.display = '';
        var bar = document.querySelector('#comp-progress-bar');
        var text = document.querySelector('#comp-progress-text');
        if (bar) { bar.style.width = '0%'; bar.style.background = ''; }
        if (text) text.textContent = 'Batch: 0/' + data.totalIterations;
      }

      var runBtn = document.querySelector('#comp-run-btn');
      var batchBtn = document.querySelector('#comp-batch-btn');
      var cancelBtn = document.querySelector('#comp-cancel-btn');
      if (runBtn) runBtn.style.display = 'none';
      if (batchBtn) batchBtn.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = '';

      startBatchPolling();
    })
    .catch(function(err) { toast('Batch error: ' + err.message, 'error'); });
}

function startBatchPolling() {
  if (batchPollTimer) clearInterval(batchPollTimer);
  batchPollTimer = setInterval(pollBatchStatus, 1000);
}

function stopBatchPolling() {
  if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
}

function pollBatchStatus() {
  fetch('/api/batch/status')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data.active && !data.done) {
        stopBatchPolling();
        return;
      }

      // Update progress bar for batch
      var completed = data.completedIterations + data.failedIterations;
      var pct = data.totalIterations > 0 ? Math.round((completed / data.totalIterations) * 100) : 0;
      var bar = document.querySelector('#comp-progress-bar');
      var text = document.querySelector('#comp-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = 'Batch: ' + completed + '/' + data.totalIterations + (data.failedIterations > 0 ? ' (' + data.failedIterations + ' failed)' : '');

      // Also poll composition run status for per-node updates
      pollCompRunStatus();

      if (data.done) {
        stopBatchPolling();
        stopCompRunPolling();
        hideApprovalDialog();

        var runBtn = document.querySelector('#comp-run-btn');
        var batchBtn = document.querySelector('#comp-batch-btn');
        var cancelBtn = document.querySelector('#comp-cancel-btn');
        if (runBtn) runBtn.style.display = '';
        if (batchBtn) batchBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = 'none';

        var progressBar = document.querySelector('#comp-progress-bar');
        if (data.failedIterations === 0) {
          toast('Batch complete! ' + data.completedIterations + ' runs (' + (data.durationMs / 1000).toFixed(1) + 's)', 'success');
          if (progressBar) progressBar.style.background = '#22c55e';
        } else {
          toast('Batch finished: ' + data.completedIterations + ' succeeded, ' + data.failedIterations + ' failed', 'error');
          if (progressBar) progressBar.style.background = data.completedIterations > 0 ? '#f59e0b' : '#ef4444';
        }

        setTimeout(function() {
          var wrap = document.querySelector('#comp-progress-wrap');
          if (wrap) wrap.style.display = 'none';
          if (data.failedIterations === 0) {
            clearNodeExecutionStates();
          } else {
            clearNonErrorExecutionStates();
          }
        }, 5000);
      }
    })
    .catch(function() { /* ignore */ });
}

// Also update the cancel handler to handle batches
var origCancelCompositionRun = cancelCompositionRun;
cancelCompositionRun = function() {
  if (batchPollTimer) {
    // Cancel batch instead
    fetch('/api/batch/cancel', { method: 'POST' })
      .then(function(res) { return res.json(); })
      .then(function() {
        toast('Batch cancelled', 'success');
        stopBatchPolling();
      })
      .catch(function(err) { toast('Cancel failed: ' + err.message, 'error'); });
  } else {
    origCancelCompositionRun();
  }
};

// ── Approval Gate Dialog ───────────────────────────────────

var currentApprovalId = null;

function showApprovalDialog(approval) {
  if (currentApprovalId === approval.id) return; // Already showing
  currentApprovalId = approval.id;

  hideApprovalDialog();

  var overlay = document.createElement('div');
  overlay.id = 'comp-approval-overlay';
  overlay.className = 'comp-approval-overlay';

  var html = '<div class="comp-approval-dialog">';
  html += '<div class="comp-approval-header">';
  html += '<span class="comp-approval-icon">&#x1f6d1;</span>';
  html += '<span class="comp-approval-title">Approval Required</span>';
  html += '</div>';
  html += '<div class="comp-approval-pipeline">' + compEscHtml(approval.compositionName) + '</div>';
  html += '<div class="comp-approval-message">' + compEscHtml(approval.message) + '</div>';

  // Preview variables
  if (approval.previewVariables && Object.keys(approval.previewVariables).length > 0) {
    html += '<div class="comp-approval-vars">';
    html += '<div class="comp-approval-vars-header">Variables to review:</div>';
    var entries = Object.entries(approval.previewVariables);
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i][0];
      var val = entries[i][1];
      var displayVal = typeof val === 'string' ? val : JSON.stringify(val);
      if (displayVal && displayVal.length > 300) displayVal = displayVal.slice(0, 300) + '...';
      html += '<div class="comp-approval-var-row">';
      html += '<span class="comp-approval-var-name">' + compEscHtml(humanizeVarName(key)) + '</span>';
      html += '<span class="comp-approval-var-val">' + compEscHtml(displayVal) + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Timeout indicator
  if (approval.timeoutMs && approval.timeoutMs > 0) {
    var mins = Math.round(approval.timeoutMs / 60000);
    html += '<div class="comp-approval-timeout">Auto-rejects in ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '</div>';
  }

  html += '<div class="comp-approval-actions">';
  html += '<button class="comp-approval-btn comp-approval-btn-approve" id="comp-approval-approve">&#x2713; Approve</button>';
  html += '<button class="comp-approval-btn comp-approval-btn-reject" id="comp-approval-reject">&#x2717; Reject</button>';
  html += '</div>';
  html += '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Wire up buttons
  var approveBtn = document.querySelector('#comp-approval-approve');
  var rejectBtn = document.querySelector('#comp-approval-reject');
  if (approveBtn) {
    approveBtn.addEventListener('click', function() {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      fetch('/api/approvals/' + encodeURIComponent(approval.id) + '/approve', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function() {
          toast('Approved — continuing pipeline', 'success');
          hideApprovalDialog();
        })
        .catch(function(err) { toast('Approval failed: ' + err.message, 'error'); });
    });
  }
  if (rejectBtn) {
    rejectBtn.addEventListener('click', function() {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      fetch('/api/approvals/' + encodeURIComponent(approval.id) + '/reject', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function() {
          toast('Rejected', 'success');
          hideApprovalDialog();
        })
        .catch(function(err) { toast('Rejection failed: ' + err.message, 'error'); });
    });
  }
}

function hideApprovalDialog() {
  currentApprovalId = null;
  var overlay = document.querySelector('#comp-approval-overlay');
  if (overlay) overlay.remove();
}

function updateNodeExecutionState(nodeId, status) {
  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (!nodeEl) return;

  nodeEl.classList.remove('comp-node-exec-pending', 'comp-node-exec-running', 'comp-node-exec-retrying', 'comp-node-exec-completed', 'comp-node-exec-failed', 'comp-node-exec-skipped');
  nodeEl.classList.add('comp-node-exec-' + status);

  var indicator = nodeEl.querySelector('.comp-node-exec-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'comp-node-exec-indicator';
    var header = nodeEl.querySelector('.comp-node-header');
    if (header) header.appendChild(indicator);
  }

  if (status === 'running') {
    indicator.innerHTML = '<div class="comp-node-spinner"></div>';
  } else if (status === 'retrying') {
    indicator.innerHTML = '<div class="comp-node-spinner" style="border-top-color:#f59e0b;"></div>';
  } else if (status === 'completed') {
    indicator.innerHTML = '<span style="color:#22c55e;">&#x2713;</span>';
  } else if (status === 'failed') {
    indicator.innerHTML = '<span style="color:#ef4444;">&#x2717;</span>';
  } else if (status === 'skipped') {
    indicator.innerHTML = '<span style="color:#64748b;">&#x2014;</span>';
  } else {
    indicator.innerHTML = '';
  }

  // Show/hide error banner on the node
  var existingBanner = nodeEl.querySelector('.comp-node-error-banner');
  if (status === 'failed' && lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].error) {
    var errorText = lastNodeStates[nodeId].error;
    if (!existingBanner) {
      existingBanner = document.createElement('div');
      existingBanner.className = 'comp-node-error-banner';
      nodeEl.appendChild(existingBanner);
    }
    // Truncate for node display, full error in properties panel
    var shortError = errorText.length > 120 ? errorText.slice(0, 120) + '...' : errorText;
    var isScriptNode = compData && compData.nodes && compData.nodes.find(function(n) { return n.id === nodeId && (n.workflowId === '__script__' || n.workflowId === '__script_file__'); });
    var bannerButtons = '<span class="comp-error-dismiss" title="Clear error">&#x2715;</span>';
    if (isScriptNode) {
      bannerButtons = '<span class="comp-error-repair" title="Repair with AI">&#x26A1;</span>' + bannerButtons;
    }
    existingBanner.innerHTML = bannerButtons + compEscHtml(shortError);
    existingBanner.title = 'Click to view full error in properties panel';
    // Click banner to select the node and show properties
    existingBanner.onclick = function(e) {
      if (e.target.classList.contains('comp-error-dismiss')) {
        // Clear this node's error
        clearNodeError(nodeId);
        e.stopPropagation();
        return;
      }
      if (e.target.classList.contains('comp-error-repair')) {
        // Repair this node
        var repairNode = compData && compData.nodes ? compData.nodes.find(function(n) { return n.id === nodeId; }) : null;
        if (repairNode && repairNode.script) {
          selectedNodes.clear();
          selectedNodes.add(nodeId);
          selectedEdge = null; selectedEdges.clear();
          updatePropertiesPanel();
          repairScriptNode(repairNode, nodeId);
        }
        e.stopPropagation();
        return;
      }
      selectedNodes.clear();
      selectedNodes.add(nodeId);
      selectedEdge = null; selectedEdges.clear();
      updatePropertiesPanel();
    };
  } else if (existingBanner && status !== 'failed') {
    existingBanner.remove();
  }
}

function clearNodeError(nodeId) {
  // Remove error from lastNodeStates
  if (lastNodeStates && lastNodeStates[nodeId]) {
    delete lastNodeStates[nodeId].error;
    lastNodeStates[nodeId].status = 'completed'; // Reset visual state
  }
  // Remove error banner from node element
  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (nodeEl) {
    var banner = nodeEl.querySelector('.comp-node-error-banner');
    if (banner) banner.remove();
    nodeEl.classList.remove('comp-node-exec-failed');
  }
  // Re-render properties panel if this node is selected
  if (selectedNodes.has(nodeId)) {
    updatePropertiesPanel();
  }
}

async function repairScriptNode(node, nodeId) {
  if (!node || !node.script) { toast('Not a script node', 'error'); return; }

  var nodeError = lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].error;
  if (!nodeError) { toast('No error to repair', 'error'); return; }

  // Disable repair button and show spinner
  var repairBtn = document.querySelector('#comp-props-error-repair');
  if (repairBtn) {
    repairBtn.classList.add('disabled');
    repairBtn.textContent = 'Repairing...';
  }

  try {
    var neighborContextIds = [];
    var seenContextIds = {};
    function pushContextNodeId(candidateId) {
      if (!candidateId || candidateId === nodeId || seenContextIds[candidateId]) return;
      seenContextIds[candidateId] = true;
      neighborContextIds.push(candidateId);
    }
    (node.script.contextNodeIds || []).forEach(pushContextNodeId);
    ((compData && compData.edges) || []).forEach(function(edge) {
      if (!edge) return;
      if (edge.targetNodeId === nodeId) pushContextNodeId(edge.sourceNodeId);
      if (edge.sourceNodeId === nodeId) pushContextNodeId(edge.targetNodeId);
    });
    var repairGraphContext = neighborContextIds.length > 0
      ? buildScriptGenerationContext(nodeId, neighborContextIds)
      : '';

    var repairDescription = 'Fix this script node. It failed during execution with the following error:\n\n' +
      nodeError + '\n\nPlease fix the bug in the code. Do NOT change the @input/@output annotations — only fix the implementation.';

    var res = await fetch('/api/compositions/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'repair',
        description: repairDescription,
        chatHistory: node.script.chatHistory || [],
        currentCode: node.script.code || '',
        currentNodeId: nodeId,
        compositionSnapshot: compData,
        graphContext: repairGraphContext || undefined,
        runtimeFailure: {
          nodeId: nodeId,
          nodeLabel: node.label || '',
          message: nodeError,
        },
      }),
    });

    var data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Repair request failed');
    }

    // Apply the fix
    pushUndoSnapshot();
    node.script.code = data.code;
    if (data.inputs) node.script.inputs = data.inputs;
    if (data.outputs) node.script.outputs = data.outputs;
    if (data.lifecycle && data.lifecycle.metrics) node.script.generationMetrics = data.lifecycle.metrics;
    if (Array.isArray(data.transcript)) {
      node.script.generationTranscript = (node.script.generationTranscript || []).concat(data.transcript);
    }

    // Add to chat history
    if (!node.script.chatHistory) node.script.chatHistory = [];
    node.script.chatHistory.push(
      { role: 'user', content: '[Repair] Error: ' + nodeError },
      { role: 'assistant', content: '```javascript\n' + data.code + '\n```' }
    );

    // Clear error state
    clearNodeError(nodeId);

    // Re-render
    renderNodes();
    renderEdges();
    wireUpCanvas();
    if (selectedNodes.has(nodeId)) {
      selectedNodes.clear();
      selectedNodes.add(nodeId);
      updatePropertiesPanel();
    }
    debouncedSave();

    toast('Code repaired — try running again', 'success');
  } catch (err) {
    toast('Repair failed: ' + (err.message || err), 'error');
    // Re-enable button
    if (repairBtn) {
      repairBtn.classList.remove('disabled');
      repairBtn.innerHTML = '&#x26A1; Repair';
    }
  }
}

async function fixAndRerunFromStepCard(nodeId, btn) {
  // Find node in composition data
  var node = compData && compData.nodes
    ? compData.nodes.find(function(n) { return n.id === nodeId; })
    : null;
  if (!node || !node.script) { toast('Not a script node', 'error'); return; }

  // Get error + runtime context from last run state
  var ns = lastNodeStates && lastNodeStates[nodeId];
  var nodeError = ns && ns.error;
  if (!nodeError) { toast('No error to fix', 'error'); return; }

  // Show loading state
  btn.disabled = true;
  btn.textContent = 'Fixing...';

  try {
    // Build neighbor context (same pattern as repairScriptNode)
    var neighborContextIds = [];
    var seenContextIds = {};
    function pushCtx(id) {
      if (!id || id === nodeId || seenContextIds[id]) return;
      seenContextIds[id] = true;
      neighborContextIds.push(id);
    }
    (node.script.contextNodeIds || []).forEach(pushCtx);
    ((compData && compData.edges) || []).forEach(function(edge) {
      if (!edge) return;
      if (edge.targetNodeId === nodeId) pushCtx(edge.sourceNodeId);
      if (edge.sourceNodeId === nodeId) pushCtx(edge.targetNodeId);
    });

    // Build description with full runtime context
    var repairDescription = 'Fix this script node. It failed during execution with the following error:\n\n'
      + nodeError + '\n\nPlease fix the bug in the code. Do NOT change the @input/@output annotations — only fix the implementation.';

    // Include runtime inputs for better diagnosis
    if (ns.inputVariables && Object.keys(ns.inputVariables).length > 0) {
      var inputSnippet = JSON.stringify(ns.inputVariables, null, 2);
      if (inputSnippet.length > 3000) inputSnippet = inputSnippet.slice(0, 3000) + '...';
      repairDescription += '\n\nRuntime inputs at the time of failure:\n' + inputSnippet;
    }

    // Include recent logs for context
    if (ns.logs && ns.logs.length > 0) {
      var recentLogs = ns.logs.slice(-20).join('\n');
      repairDescription += '\n\nRecent logs:\n' + recentLogs;
    }

    // Call repair API
    var res = await fetch('/api/compositions/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'repair',
        description: repairDescription,
        chatHistory: node.script.chatHistory || [],
        currentCode: node.script.code || '',
        currentNodeId: nodeId,
        compositionSnapshot: compData,
        graphContext: neighborContextIds.length > 0
          ? buildScriptGenerationContext(nodeId, neighborContextIds)
          : undefined,
        runtimeFailure: {
          nodeId: nodeId,
          nodeLabel: node.label || '',
          message: nodeError,
        },
      }),
    });

    var data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Repair failed');

    // Apply fix
    pushUndoSnapshot();
    node.script.code = data.code;
    if (data.inputs) node.script.inputs = data.inputs;
    if (data.outputs) node.script.outputs = data.outputs;
    if (data.lifecycle && data.lifecycle.metrics) node.script.generationMetrics = data.lifecycle.metrics;
    if (Array.isArray(data.transcript)) {
      node.script.generationTranscript = (node.script.generationTranscript || []).concat(data.transcript);
    }

    // Add to chat history
    if (!node.script.chatHistory) node.script.chatHistory = [];
    node.script.chatHistory.push(
      { role: 'user', content: '[Repair] Error: ' + nodeError },
      { role: 'assistant', content: '```javascript\n' + data.code + '\n```' }
    );

    // Clear error state and update canvas
    clearNodeError(nodeId);
    renderNodes(); renderEdges(); wireUpCanvas();
    debouncedSave();

    // Re-run pipeline with the same inputs
    btn.textContent = 'Re-running...';
    toast('Code fixed — re-running pipeline', 'success');

    // Short delay to let save complete, then trigger run via the Run button
    setTimeout(function() {
      var runBtn = document.querySelector('#comp-run-btn');
      if (runBtn && runBtn.style.display !== 'none') {
        runBtn.click();
      } else {
        // Fallback: start with empty variables (form values still stored)
        startCompositionRun({});
      }
    }, 600);

  } catch (err) {
    toast('Fix failed: ' + (err.message || err), 'error');
    btn.disabled = false;
    btn.innerHTML = '&#x26A1; Fix &amp; Re-run';
  }
}

function injectNodeErrorDisplay(body, nodeId) {
  // Inject error box at the top of the properties panel body for any failed node
  var nodeError = lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].error;
  if (nodeError) {
    // Check if this is a script node (to show repair button)
    var theNode = compData && compData.nodes ? compData.nodes.find(function(n) { return n.id === nodeId; }) : null;
    var isScript = theNode && (theNode.workflowId === '__script__' && theNode.script) || (theNode && theNode.workflowId === '__script_file__' && theNode.scriptFile);

    var buttonsHtml = '<span style="display:flex;gap:4px;">';
    if (isScript) {
      buttonsHtml += '<span class="comp-props-error-repair" id="comp-props-error-repair">&#x26A1; Repair</span>';
    }
    buttonsHtml += '<span class="comp-props-error-clear" id="comp-props-error-clear">Clear</span>';
    buttonsHtml += '</span>';

    var errorDiv = document.createElement('div');
    errorDiv.className = 'comp-props-error-box';
    errorDiv.id = 'comp-props-error-box';
    errorDiv.innerHTML = '<div class="comp-props-error-header">' +
      '<span class="comp-props-error-title">&#x26A0; Execution Error</span>' +
      buttonsHtml +
      '</div>' +
      '<div class="comp-props-error-explain" id="comp-props-error-explain-' + nodeId + '">' +
        '<span style="color:#64748b;font-size:0.68rem;font-style:italic;">Understanding error...</span>' +
      '</div>' +
      '<div style="color:#94a3b8;font-size:0.68rem;margin-top:4px;">' + compEscHtml(nodeError) + '</div>';
    body.insertBefore(errorDiv, body.firstChild);

    // Fetch plain-English explanation from POST /api/compositions/explain-error
    (function(nId, nErr) {
      /** @type {import('./chat.js').ExplainErrorResponse} — see ExplainErrorResponse typedef */
      fetch('/api/compositions/explain-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: nErr,
          nodeLabel: theNode ? (theNode.label || '') : '',
          nodeType: theNode ? theNode.workflowId : 'unknown',
        }),
      })
      .then(function(r) { return r.json(); })
      .then(/** @param {ExplainErrorResponse} data */ function(data) {
        var el = document.getElementById('comp-props-error-explain-' + nId);
        if (el && data.summary) {
          el.innerHTML = '<div class="comp-props-error-summary">' + compEscHtml(data.summary) + '</div>' +
            (data.suggestion ? '<div class="comp-props-error-suggestion">' + compEscHtml(data.suggestion) + '</div>' : '');
        } else if (el) {
          el.remove();
        }
      })
      .catch(function() {
        var el = document.getElementById('comp-props-error-explain-' + nId);
        if (el) el.remove();
      });
    })(nodeId, nodeError);

    var clearBtn = errorDiv.querySelector('#comp-props-error-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        clearNodeError(nodeId);
      });
    }
    var repairBtn = errorDiv.querySelector('#comp-props-error-repair');
    if (repairBtn && isScript) {
      repairBtn.addEventListener('click', function() {
        repairScriptNode(theNode, nodeId);
      });
    }
  }

  // Always inject logs (even when no error)
  injectNodeLogsDisplay(body, nodeId);
}

function injectNodeLogsDisplay(body, nodeId) {
  var nodeLogs = lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].logs;
  if (!nodeLogs || !nodeLogs.length) return;

  var logsDiv = document.createElement('div');
  logsDiv.className = 'comp-props-section';
  logsDiv.style.cssText = 'margin-top:8px;';
  var logsHtml = '<div class="comp-props-label" style="display:flex;align-items:center;justify-content:space-between;">' +
    '<span>Run Logs (' + nodeLogs.length + ')</span>' +
    '<span class="comp-props-logs-toggle" style="font-size:0.6rem;color:#64748b;cursor:pointer;">Toggle</span>' +
    '</div>';
  logsHtml += '<div class="comp-props-logs-box" style="max-height:200px;overflow:auto;background:#0a0e17;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;font-family:monospace;font-size:0.62rem;color:#94a3b8;white-space:pre-wrap;word-break:break-all;">';
  for (var i = 0; i < nodeLogs.length; i++) {
    logsHtml += compEscHtml(nodeLogs[i]) + '\n';
  }
  logsHtml += '</div>';
  logsDiv.innerHTML = logsHtml;
  body.appendChild(logsDiv);

  var toggleBtn = logsDiv.querySelector('.comp-props-logs-toggle');
  var logsBox = logsDiv.querySelector('.comp-props-logs-box');
  if (toggleBtn && logsBox) {
    toggleBtn.addEventListener('click', function() {
      logsBox.style.display = logsBox.style.display === 'none' ? '' : 'none';
    });
  }
}

function updateNodeRetryBadge(nodeId, attempt, max) {
  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (!nodeEl) return;
  var header = nodeEl.querySelector('.comp-node-header');
  if (!header) return;

  var badge = header.querySelector('.comp-node-retry-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'comp-node-retry-badge';
    header.appendChild(badge);
  }
  badge.textContent = 'Retry ' + attempt + '/' + max;
}

function removeNodeRetryBadge(nodeId) {
  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (!nodeEl) return;
  var badge = nodeEl.querySelector('.comp-node-retry-badge');
  if (badge) badge.remove();
}

function updateNodeStepProgress(nodeId, stepsCompleted, stepsTotal) {
  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (!nodeEl) return;
  var footer = nodeEl.querySelector('.comp-node-footer');
  if (!footer) return;

  var barWrap = footer.querySelector('.comp-node-step-bar-wrap');
  if (!barWrap) {
    footer.insertAdjacentHTML('beforeend',
      '<div class="comp-node-step-bar-wrap"><div class="comp-node-step-bar"></div></div>'
    );
    barWrap = footer.querySelector('.comp-node-step-bar-wrap');
  }
  var bar = barWrap.querySelector('.comp-node-step-bar');
  var pct = stepsTotal > 0 ? Math.round((stepsCompleted / stepsTotal) * 100) : 0;
  if (bar) bar.style.width = pct + '%';

  // Update text in footer
  var span = footer.querySelector('.comp-node-footer-text');
  if (!span) {
    span = document.createElement('span');
    span.className = 'comp-node-footer-text';
    footer.insertBefore(span, footer.firstChild);
  }
  span.textContent = stepsCompleted + '/' + stepsTotal + ' steps';
}

function clearNodeExecutionStates() {
  document.querySelectorAll('.comp-node').forEach(function(el) {
    el.classList.remove('comp-node-exec-pending', 'comp-node-exec-running', 'comp-node-exec-retrying', 'comp-node-exec-completed', 'comp-node-exec-failed', 'comp-node-exec-skipped');
    var indicator = el.querySelector('.comp-node-exec-indicator');
    if (indicator) indicator.remove();
    var barWrap = el.querySelector('.comp-node-step-bar-wrap');
    if (barWrap) barWrap.remove();
    var footerText = el.querySelector('.comp-node-footer-text');
    if (footerText) footerText.remove();
    var retryBadge = el.querySelector('.comp-node-retry-badge');
    if (retryBadge) retryBadge.remove();
    var errorBanner = el.querySelector('.comp-node-error-banner');
    if (errorBanner) errorBanner.remove();
  });
}

function clearNonErrorExecutionStates() {
  // Clear all execution overlays EXCEPT error banners on failed nodes
  document.querySelectorAll('.comp-node').forEach(function(el) {
    var hasFailed = el.classList.contains('comp-node-exec-failed');
    if (!hasFailed) {
      el.classList.remove('comp-node-exec-pending', 'comp-node-exec-running', 'comp-node-exec-retrying', 'comp-node-exec-completed', 'comp-node-exec-skipped');
      var indicator = el.querySelector('.comp-node-exec-indicator');
      if (indicator) indicator.remove();
    }
    // Always remove these transient elements
    var barWrap = el.querySelector('.comp-node-step-bar-wrap');
    if (barWrap) barWrap.remove();
    var footerText = el.querySelector('.comp-node-footer-text');
    if (footerText) footerText.remove();
    var retryBadge = el.querySelector('.comp-node-retry-badge');
    if (retryBadge) retryBadge.remove();
  });
}

// ── Scheduling ───────────────────────────────────────────────

var scheduleData = []; // cached schedules for this composition

async function fetchSchedules() {
  try {
    var res = await fetch('/api/schedules');
    var data = await res.json();
    return data.schedules || [];
  } catch { return []; }
}

function cronToHuman(cron) {
  if (!cron) return '';
  var parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  var min = parts[0], hr = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];

  // Common patterns
  if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every ' + min.slice(2) + ' minutes';
  if (hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour at :' + min.padStart(2, '0');
  if (dom === '*' && mon === '*' && dow === '*') return 'Daily at ' + hr + ':' + min.padStart(2, '0');
  if (dom === '*' && mon === '*' && dow !== '*') {
    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var dowNames = dow.split(',').map(function(d) { return days[parseInt(d)] || d; }).join(', ');
    return dowNames + ' at ' + hr + ':' + min.padStart(2, '0');
  }
  return cron;
}

// ── Tool Docs Modal ──────────────────────────────────────────

function showToolDocsModal() {
  fetch('/api/script-tool-docs')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var tools = data.tools || [];
      renderToolDocsModal(tools);
    })
    .catch(function(err) {
      toast('Failed to load tool docs: ' + err.message, 'error');
    });
}

function renderToolDocsModal(tools) {
  var existing = document.querySelector('#comp-tool-docs-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'comp-tool-docs-modal';
  overlay.className = 'comp-modal-overlay';

  var html = '<div class="comp-modal" style="max-width:700px;">';
  html += '<div class="comp-modal-header">';
  html += '<span>&#x1f527; Script Tool Context</span>';
  html += '<button class="comp-modal-close" id="comp-tool-docs-close">&times;</button>';
  html += '</div>';
  html += '<div class="comp-modal-body" style="max-height:70vh;overflow-y:auto;">';
  html += '<p style="color:#94a3b8;font-size:0.78rem;margin:0 0 1rem 0;">Extension tools available to Script nodes. The code generator uses this documentation to produce correct tool calls. Add examples to improve accuracy.</p>';

  if (tools.length === 0) {
    html += '<div style="color:#64748b;padding:2rem;text-align:center;">No extension tools available.<br>Install extensions that provide tools to see them here.</div>';
  } else {
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      html += '<div class="comp-tool-doc-entry" data-tool-name="' + compEscAttr(t.name) + '">';

      // Header row: checkbox + name
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      html += '<input type="checkbox" class="comp-tool-enabled" ' + (t.enabled ? 'checked' : '') + ' style="accent-color:#818cf8;">';
      html += '<strong style="color:#e2e8f0;font-size:0.85rem;">' + compEscHtml(t.name) + '</strong>';
      if (t.dangerous) html += '<span style="color:#f59e0b;font-size:0.65rem;background:#f59e0b22;padding:1px 6px;border-radius:4px;margin-left:4px;">dangerous</span>';
      html += '</div>';

      // Signature
      html += '<div style="color:#a5b4fc;font-size:0.7rem;margin-bottom:4px;font-family:monospace;word-break:break-all;">' + compEscHtml(t.signature) + '</div>';

      // Auto-generated description
      html += '<div style="color:#64748b;font-size:0.7rem;margin-bottom:8px;">' + compEscHtml(t.description.split('\n')[0]) + '</div>';

      // Custom description
      html += '<div class="comp-props-label" style="font-size:0.68rem;">Custom Description (overrides default in prompt)</div>';
      html += '<textarea class="comp-props-input comp-tool-custom-desc" rows="2" placeholder="Leave empty to use default...">' + compEscHtml(t.customDescription || '') + '</textarea>';

      // Returns
      html += '<div class="comp-props-label" style="font-size:0.68rem;">Returns (describe the return object structure)</div>';
      html += '<input type="text" class="comp-props-input comp-tool-returns" value="' + compEscAttr(t.returns || '') + '" placeholder="{ success: boolean, imagePath?: string, error?: string }">';

      // Examples
      html += '<div class="comp-props-label" style="font-size:0.68rem;">Code Examples (one per line, included in prompt)</div>';
      html += '<textarea class="comp-props-input comp-tool-examples" rows="3" placeholder="const result = await context.tools.' + compEscAttr(t.name) + '({ ... });">' + compEscHtml((t.examples || []).join('\n')) + '</textarea>';

      // Notes
      html += '<div class="comp-props-label" style="font-size:0.68rem;">Notes</div>';
      html += '<input type="text" class="comp-props-input comp-tool-notes" value="' + compEscAttr(t.notes || '') + '" placeholder="Any caveats or usage notes...">';

      html += '</div>';
    }
  }

  html += '</div>';
  html += '<div style="display:flex;justify-content:flex-end;gap:8px;padding:0.75rem 1rem;border-top:1px solid #334155;">';
  html += '<button class="comp-tb-btn" id="comp-tool-docs-cancel">Cancel</button>';
  if (tools.length > 0) {
    html += '<button class="comp-tb-btn comp-tb-btn-run" id="comp-tool-docs-save">Save</button>';
  }
  html += '</div>';
  html += '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Wire close
  document.querySelector('#comp-tool-docs-close').addEventListener('click', function() { overlay.remove(); });
  document.querySelector('#comp-tool-docs-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Wire save
  var saveBtn = document.querySelector('#comp-tool-docs-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      var entries = overlay.querySelectorAll('.comp-tool-doc-entry');
      var toolDocs = [];
      entries.forEach(function(entry) {
        var toolName = entry.getAttribute('data-tool-name');
        var enabled = entry.querySelector('.comp-tool-enabled').checked;
        var customDesc = entry.querySelector('.comp-tool-custom-desc').value.trim();
        var returns = entry.querySelector('.comp-tool-returns').value.trim();
        var examplesRaw = entry.querySelector('.comp-tool-examples').value.trim();
        var examples = examplesRaw ? examplesRaw.split('\n').filter(function(l) { return l.trim(); }) : [];
        var notes = entry.querySelector('.comp-tool-notes').value.trim();

        toolDocs.push({
          toolName: toolName,
          customDescription: customDesc || null,
          returns: returns || null,
          examples: examples,
          notes: notes || null,
          enabled: enabled,
        });
      });

      fetch('/api/script-tool-docs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: toolDocs }),
      })
        .then(function(res) {
          if (!res.ok) throw new Error('Save failed');
          return res.json();
        })
        .then(function() {
          toast('Tool documentation saved', 'success');
          overlay.remove();
        })
        .catch(function(err) {
          toast('Failed to save: ' + err.message, 'error');
        });
    });
  }
}

async function showScheduleModal() {
  if (!compData || !compData.id) { toast('Save the pipeline first', 'error'); return; }

  // Fetch existing schedules for this composition
  var allSchedules = await fetchSchedules();
  scheduleData = allSchedules.filter(function(s) { return s.compositionId === compData.id; });

  var overlay = document.createElement('div');
  overlay.className = 'comp-schedule-overlay';
  overlay.id = 'comp-schedule-overlay';

  var html = '<div class="comp-schedule-dialog">';
  html += '<div class="comp-schedule-header">';
  html += '<div class="comp-schedule-title">&#x23f0; Schedule: ' + compEscHtml(compData.name) + '</div>';
  html += '<button class="comp-schedule-close" id="comp-schedule-close">&times;</button>';
  html += '</div>';
  html += '<div class="comp-schedule-desc">Run this pipeline automatically on a cron schedule.</div>';

  // Existing schedules list
  html += '<div class="comp-schedule-list" id="comp-schedule-list">';
  html += renderScheduleList();
  html += '</div>';

  // Add new schedule form
  html += '<div class="comp-schedule-add-section">';
  html += '<div class="comp-schedule-add-header">Add New Schedule</div>';
  html += '<div class="comp-schedule-form">';

  // Cron presets
  html += '<div class="comp-schedule-form-row">';
  html += '<label>Preset</label>';
  html += '<select id="comp-schedule-preset" class="comp-schedule-select">';
  html += '<option value="">Custom...</option>';
  html += '<option value="*/5 * * * *">Every 5 minutes</option>';
  html += '<option value="*/15 * * * *">Every 15 minutes</option>';
  html += '<option value="*/30 * * * *">Every 30 minutes</option>';
  html += '<option value="0 * * * *">Every hour</option>';
  html += '<option value="0 */2 * * *">Every 2 hours</option>';
  html += '<option value="0 */6 * * *">Every 6 hours</option>';
  html += '<option value="0 9 * * *">Daily at 9:00 AM</option>';
  html += '<option value="0 9 * * 1-5">Weekdays at 9:00 AM</option>';
  html += '<option value="0 0 * * *">Daily at midnight</option>';
  html += '<option value="0 9 * * 1">Weekly on Monday at 9:00 AM</option>';
  html += '</select>';
  html += '</div>';

  // Cron input
  html += '<div class="comp-schedule-form-row">';
  html += '<label>Cron Expression</label>';
  html += '<input type="text" id="comp-schedule-cron" class="comp-schedule-input" placeholder="* * * * *" value="0 9 * * *" />';
  html += '<div class="comp-schedule-cron-hint">Format: minute hour day-of-month month day-of-week</div>';
  html += '</div>';

  // Preview
  html += '<div class="comp-schedule-form-row">';
  html += '<label>Preview</label>';
  html += '<div class="comp-schedule-preview" id="comp-schedule-preview">' + cronToHuman('0 9 * * *') + '</div>';
  html += '</div>';

  // Description
  html += '<div class="comp-schedule-form-row">';
  html += '<label>Description <span style="color:#64748b;">(optional)</span></label>';
  html += '<input type="text" id="comp-schedule-description" class="comp-schedule-input" placeholder="e.g. Morning social media post" />';
  html += '</div>';

  // Variables section
  html += '<div class="comp-schedule-form-row">';
  html += '<label>Variables <span style="color:#64748b;">(optional)</span></label>';
  html += '<textarea id="comp-schedule-vars" class="comp-schedule-textarea" rows="3" placeholder=\'{"key": "value"}\'></textarea>';
  html += '</div>';

  html += '</div>'; // end form

  html += '<div class="comp-schedule-actions">';
  html += '<button class="comp-schedule-btn comp-schedule-btn-add" id="comp-schedule-add-btn">Create Schedule</button>';
  html += '</div>';
  html += '</div>'; // end add section

  html += '</div>'; // end dialog
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Wire events
  document.querySelector('#comp-schedule-close').addEventListener('click', closeScheduleModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeScheduleModal();
  });

  // Preset selector
  var presetSelect = document.querySelector('#comp-schedule-preset');
  var cronInput = document.querySelector('#comp-schedule-cron');
  var previewDiv = document.querySelector('#comp-schedule-preview');

  presetSelect.addEventListener('change', function() {
    if (presetSelect.value) {
      cronInput.value = presetSelect.value;
      previewDiv.textContent = cronToHuman(presetSelect.value);
    }
  });

  cronInput.addEventListener('input', function() {
    previewDiv.textContent = cronToHuman(cronInput.value);
    presetSelect.value = '';
  });

  // Add schedule button
  document.querySelector('#comp-schedule-add-btn').addEventListener('click', async function() {
    var cron = cronInput.value.trim();
    if (!cron) { toast('Enter a cron expression', 'error'); return; }

    var parts = cron.split(/\s+/);
    if (parts.length !== 5) { toast('Cron must have 5 fields: minute hour dom month dow', 'error'); return; }

    var description = (document.querySelector('#comp-schedule-description') || {}).value || '';
    var varsText = (document.querySelector('#comp-schedule-vars') || {}).value || '';
    var variables = {};
    if (varsText.trim()) {
      try {
        variables = JSON.parse(varsText);
      } catch (e) {
        toast('Invalid JSON in variables', 'error');
        return;
      }
    }

    try {
      var res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compositionId: compData.id,
          compositionName: compData.name,
          cron: cron,
          enabled: true,
          description: description,
          variables: variables,
        }),
      });
      var data = await res.json();
      if (!res.ok) { toast(data.error || 'Failed to create schedule', 'error'); return; }
      scheduleData.push(data.schedule);
      document.querySelector('#comp-schedule-list').innerHTML = renderScheduleList();
      wireScheduleListEvents();
      cronInput.value = '0 9 * * *';
      previewDiv.textContent = cronToHuman('0 9 * * *');
      document.querySelector('#comp-schedule-description').value = '';
      document.querySelector('#comp-schedule-vars').value = '';
      toast('Schedule created', 'success');
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  });

  wireScheduleListEvents();
}

function renderScheduleList() {
  if (scheduleData.length === 0) {
    return '<div class="comp-schedule-empty">No schedules configured for this pipeline.</div>';
  }
  var html = '';
  for (var i = 0; i < scheduleData.length; i++) {
    var s = scheduleData[i];
    html += '<div class="comp-schedule-item" data-schedule-id="' + compEscAttr(s.id) + '">';
    html += '<div class="comp-schedule-item-left">';
    html += '<div class="comp-schedule-item-toggle">';
    html += '<input type="checkbox" class="comp-schedule-toggle" data-schedule-idx="' + i + '"' + (s.enabled ? ' checked' : '') + ' />';
    html += '</div>';
    html += '<div class="comp-schedule-item-info">';
    html += '<div class="comp-schedule-item-cron">' + compEscHtml(s.cron) + '</div>';
    html += '<div class="comp-schedule-item-human">' + compEscHtml(cronToHuman(s.cron)) + '</div>';
    if (s.description) {
      html += '<div class="comp-schedule-item-desc">' + compEscHtml(s.description) + '</div>';
    }
    if (s.lastRunAt) {
      html += '<div class="comp-schedule-item-last">Last run: ' + compEscHtml(new Date(s.lastRunAt).toLocaleString()) + '</div>';
    }
    html += '</div>';
    html += '</div>';
    html += '<button class="comp-schedule-item-delete" data-schedule-idx="' + i + '" title="Delete schedule">&#x1f5d1;</button>';
    html += '</div>';
  }
  return html;
}

function wireScheduleListEvents() {
  // Toggle enable/disable
  document.querySelectorAll('.comp-schedule-toggle').forEach(function(cb) {
    cb.addEventListener('change', async function() {
      var idx = parseInt(cb.dataset.scheduleIdx);
      var s = scheduleData[idx];
      if (!s) return;
      try {
        var res = await fetch('/api/schedules/' + encodeURIComponent(s.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: cb.checked }),
        });
        if (res.ok) {
          s.enabled = cb.checked;
          toast(cb.checked ? 'Schedule enabled' : 'Schedule paused', 'success');
        }
      } catch (e) {
        toast('Failed: ' + e.message, 'error');
      }
    });
  });

  // Delete buttons
  document.querySelectorAll('.comp-schedule-item-delete').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var idx = parseInt(btn.dataset.scheduleIdx);
      var s = scheduleData[idx];
      if (!s) return;
      if (!confirm('Delete this schedule?')) return;
      try {
        var res = await fetch('/api/schedules/' + encodeURIComponent(s.id), { method: 'DELETE' });
        if (res.ok) {
          scheduleData.splice(idx, 1);
          document.querySelector('#comp-schedule-list').innerHTML = renderScheduleList();
          wireScheduleListEvents();
          toast('Schedule deleted', 'success');
        }
      } catch (e) {
        toast('Failed: ' + e.message, 'error');
      }
    });
  });
}

function closeScheduleModal() {
  var overlay = document.querySelector('#comp-schedule-overlay');
  if (overlay) overlay.remove();
}

// ── Init ─────────────────────────────────────────────────────

function initCompositions() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div class="empty-state">' +
    '<div class="empty-state-icon">&#x1f517;</div>' +
    '<h2>Pipelines ' + helpIcon('pipelines-what') + '</h2>' +
    '<p>Pipelines chain workflows together, passing data from one to the next.<br>Select a pipeline from the sidebar or create a new one.</p>' +
    '</div>';

  fetchCompositions();
  fetchWorkflowsForNodes();
}

// Make globally available
window.initCompositions = initCompositions;
