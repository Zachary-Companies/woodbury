/**
 * compositions-canvas.js
 *
 * SVG graph editor: node/edge rendering, toolbar, add-node functions,
 * pan/zoom, drag-to-connect, rubber-band selection, copy/paste, and
 * context menus.
 *
 * Depends on: compositions-core.js (state variables, utilities, API helpers)
 *
 * Contents:
 *   - renderGraphEditor, applyCanvasTransform
 *   - Node rendering (getWorkflowForNode, renderNodes, isPortConnected)
 *   - Edge rendering (edgePath, getPortPosition, renderEdges, updateEdgePositions)
 *   - Toolbar (wireUpToolbar)
 *   - More dropdown (exportPipeline, importPipeline, duplicatePipeline, deletePipeline,
 *     showMoreDropdown, hideMoreDropdown)
 *   - Add-node dropdown (showAddNodeDropdown)
 *   - Add-node functions (addWorkflowNode, addCompositionNode, addApprovalGateNode,
 *     addScriptNode, addOutputNode, addImageViewerNode, addMediaNode, addBranchNode,
 *     addDelayNode, addGateNode, addForEachNode, addSwitchNode, addAssetNode,
 *     addTextNode, addVariableNode, addGetVariableNode, addFileOpNode, addJsonKeysNode,
 *     addFileReadNode, addJunctionNode, addToolNode, addFileWriteNode, etc.)
 *   - Composition-as-node helpers (compositionInterfaceCache, fetchCompositionInterface,
 *     detectCompositionCycle)
 *   - Script/pipeline generation modals (showAddScriptModal, showDataAwareScriptModal,
 *     showGeneratePipelineModal, addGeneratedPipeline)
 *   - deleteSelected, updateDeleteButton, fitToView
 *   - wireUpCanvas (mouse/keyboard handlers, port value tooltips)
 *   - Selection helpers (selectNodeById, selectEdgeById, updateNodeSelection,
 *     updateEdgeSelection)
 *   - Rubber-band selection (bezierIntersectsRect, edgeIntersectsRect, startSelectionRect)
 *   - Pan (startPan)
 *   - Node drag (startNodeDrag)
 *   - Edge drag (startEdgeDrag)
 *   - Copy/paste (copySelected, pasteClipboard)
 *   - Context menu (showContextMenu, hideContextMenu, renameNode, duplicateNode,
 *     disconnectAllEdges)
 */


// ── Graph Editor ─────────────────────────────────────────────

function renderGraphEditor() {
  var main = document.querySelector('#main');

  var html = '';

  // Toolbar
  html += '<div class="comp-toolbar">';
  html += '<div class="comp-toolbar-left">';
  html += '<h2 id="comp-pipeline-title" title="Double-click to rename" style="margin:0;font-size:1rem;cursor:pointer;">' + compEscHtml(compData.name) + '</h2>' + helpIcon('pipelines-connecting');
  if (compData.description) {
    html += '<span style="color:#64748b;font-size:0.75rem;margin-left:0.5rem;">' + compEscHtml(compData.description) + '</span>';
  }
  html += '</div>';
  html += '<div class="comp-toolbar-right">';
  html += '<button class="comp-tb-btn comp-tb-btn-generate" id="comp-generate-pipeline" title="Generate a multi-step pipeline from a description">&#x2728; Generate</button>';
  html += '<div class="comp-add-dropdown-wrap" id="comp-add-dropdown-wrap">';
  html += '<button class="comp-tb-btn comp-tb-btn-add" id="comp-add-dropdown-toggle" title="Add a node">+ Add Node &#x25be;</button>' + helpIcon('pipelines-nodes');
  html += '<div class="comp-add-dropdown" id="comp-add-dropdown" style="display:none;">';
  html += '<div class="comp-add-dropdown-group-label">Workflows</div>';
  html += '<button class="comp-add-dropdown-item" id="comp-add-node">&#x2795; Add Workflow</button>';
  html += '<div class="comp-add-dropdown-group-label">Special</div>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-gate" id="comp-add-gate">&#x1f6d1; Approval Gate</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-script" id="comp-add-script">&#x192; Script</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-output" id="comp-add-output">&#x1f4e4; Output</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-image" id="comp-add-image-viewer">&#x1f5bc; Image Viewer</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-media" id="comp-add-media">&#x25b6; Media Player</button>';
  html += '<div class="comp-add-dropdown-group-label">Flow Control</div>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-branch" id="comp-add-branch">&#x2194; Branch</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-delay" id="comp-add-delay">&#x23f3; Delay</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-gatenode" id="comp-add-gate-node">&#x26d4; Gate</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-loop" id="comp-add-loop">&#x1f504; ForEach Loop</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-switch" id="comp-add-switch">&#x2b82; Switch</button>';
  html += '<div class="comp-add-dropdown-group-label">Data</div>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-asset" id="comp-add-asset">&#x1f4be; Asset</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-text" id="comp-add-text">&#x1f4dd; Text</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-variable" id="comp-add-variable">&#x1f4e6; Variable</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-get-variable" id="comp-add-get-variable">&#x1f4cb; Get Variable</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-file-op" id="comp-add-file-op">&#x1f4c1; File Op</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-json-keys" id="comp-add-json-keys">&#x1f5dd; JSON Extract</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-tool" id="comp-add-tool">&#x1f527; Tool</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-file-write" id="comp-add-file-write">&#x1f4be; Write File</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-file-read" id="comp-add-file-read">&#x1f4c4; Read File</button>';
  html += '<div class="comp-add-dropdown-group-label">Routing</div>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-junction" id="comp-add-junction">&#x26a1; Junction</button>';
  html += '</div>';
  html += '</div>';
  html += '<button class="comp-tb-btn" id="comp-undo-btn" title="Undo (Ctrl+Z)" disabled>&#x21a9;</button>';
  html += '<button class="comp-tb-btn" id="comp-redo-btn" title="Redo (Ctrl+Shift+Z)" disabled>&#x21aa;</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-delete-selected" title="Remove selected" style="display:none;">&#x1f5d1; Remove</button>';
  html += '<button class="comp-tb-btn" id="comp-auto-layout" title="Tidy up layout">&#x2195; Layout</button>';
  html += '<button class="comp-tb-btn" id="comp-snap-toggle" title="Snap to grid">Grid</button>';
  html += '<button class="comp-tb-btn" id="comp-open-form-btn" title="Open this pipeline as a full-page form inside the app">Form View</button>';
  html += '<button class="comp-tb-btn" id="comp-share-form-btn" title="Copy a link that opens this pipeline as a form">&#x1f517; Share Form</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-run" id="comp-run-btn" title="Run this pipeline">&#x25b6; Run</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-batch" id="comp-batch-btn" title="Run with different variable sets">&#x1f4e6; Batch</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-schedule" id="comp-schedule-btn" title="Schedule this pipeline">&#x23f0; Schedule</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-delete-pipeline-btn" title="Delete this pipeline">&#x1f5d1; Delete</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-cancel" id="comp-cancel-btn" title="Stop running" style="display:none;">&#x25a0; Stop</button>';
  html += '<button class="comp-tb-btn" id="comp-zoom-fit" title="Fit to view">Fit</button>';
  html += '<span class="comp-zoom-label" id="comp-zoom-label">' + Math.round(canvasState.zoom * 100) + '%</span>';
  html += '<button class="comp-tb-btn" id="comp-more-btn" title="More actions">&#x22ef;</button>';
  html += '</div>';
  html += '</div>';

  // Progress bar (hidden until run starts)
  html += '<div class="comp-progress-bar-wrap" id="comp-progress-wrap" style="display:none;">';
  html += '<div class="comp-progress-bar" id="comp-progress-bar" style="width:0%"></div>';
  html += '<span class="comp-progress-text" id="comp-progress-text"></span>';
  html += '</div>';

  // Editor row: canvas + properties panel
  html += '<div class="comp-editor-row">';

  // Canvas
  html += '<div class="comp-canvas-wrap" id="comp-canvas-wrap">';
  html += '<svg class="comp-edges-svg" id="comp-edges-svg"><g class="comp-edges-group" id="comp-edges-group"></g></svg>';
  html += '<div class="comp-nodes-layer" id="comp-nodes-layer"></div>';
  // Selection rectangle (hidden by default)
  html += '<div class="comp-selection-rect" id="comp-selection-rect" style="display:none;"></div>';
  // Minimap
  html += '<div class="comp-minimap" id="comp-minimap">';
  html += '<canvas id="comp-minimap-canvas" width="180" height="120"></canvas>';
  html += '<div class="comp-minimap-viewport" id="comp-minimap-viewport"></div>';
  html += '</div>';
  // Empty canvas guide overlay (Step 4)
  html += '<div class="comp-empty-guide" id="comp-empty-guide" style="display:none;">';
  html += '<div class="comp-empty-guide-icon">&#x1f517;</div>';
  html += '<h3>Start Building Your Pipeline</h3>';
  html += '<p>Click <strong>"+ Add Workflow"</strong> above to add your first step.</p>';
  html += '<p>Then add another and drag from an output to an input to connect them.</p>';
  html += '</div>';
  html += '</div>'; // .comp-canvas-wrap

  // Properties panel (hidden until selection)
  html += '<div class="comp-props-panel" id="comp-props-panel" style="display:none;">';
  html += '<div class="comp-props-header">';
  html += '<span class="comp-props-title">Properties</span>';
  html += '<button class="comp-props-close" id="comp-props-close">&times;</button>';
  html += '</div>';
  html += '<div class="comp-props-body" id="comp-props-body"></div>';
  html += '</div>';

  html += '</div>'; // .comp-editor-row

  main.innerHTML = html;

  // Render nodes and edges
  renderNodes();
  renderEdges();
  applyCanvasTransform();

  // Wire up toolbar
  wireUpToolbar();
  // Wire up canvas interactions
  wireUpCanvas();
  // Wire up minimap
  wireUpMinimap();
  requestAnimationFrame(function() { updateMinimap(); });
}

function applyCanvasTransform() {
  var nodesLayer = document.querySelector('#comp-nodes-layer');
  var edgesGroup = document.querySelector('#comp-edges-group');
  if (nodesLayer) {
    nodesLayer.style.transform = 'translate(' + canvasState.panX + 'px, ' + canvasState.panY + 'px) scale(' + canvasState.zoom + ')';
  }
  if (edgesGroup) {
    edgesGroup.setAttribute('transform', 'translate(' + canvasState.panX + ',' + canvasState.panY + ') scale(' + canvasState.zoom + ')');
  }
  var label = document.querySelector('#comp-zoom-label');
  if (label) label.textContent = Math.round(canvasState.zoom * 100) + '%';
  updateMinimap();
}

// ── Node Rendering ───────────────────────────────────────────

function getWorkflowForNode(node) {
  return workflowCache.find(function(w) { return w.id === node.workflowId; });
}

function renderNodes() {
  var layer = document.querySelector('#comp-nodes-layer');
  if (!layer || !compData) return;

  var warnings = computeValidationWarnings();

  var html = '';
  for (var i = 0; i < compData.nodes.length; i++) {
    var node = compData.nodes[i];
    var isGate = node.workflowId === '__approval_gate__';
    var isScript = node.workflowId === '__script__';
    var isOutput = node.workflowId === '__output__';
    var isComposition = node.workflowId.startsWith('comp:');
    var isImageViewer = node.workflowId === '__image_viewer__';
    var isMedia = node.workflowId === '__media__';
    var isBranch = node.workflowId === '__branch__';
    var isDelay = node.workflowId === '__delay__';
    var isGateNode = node.workflowId === '__gate__';
    var isForEach = node.workflowId === '__for_each__';
    var isSwitch = node.workflowId === '__switch__';
    var isAsset = node.workflowId === '__asset__';
    var isText = node.workflowId === '__text__';
    var isVariable = node.workflowId === '__variable__';
    var isGetVariable = node.workflowId === '__get_variable__';
    var isFileOp = node.workflowId === '__file_op__';
    var isJsonKeys = node.workflowId === '__json_keys__';
    var isTool = node.workflowId === '__tool__';
    var isFileWrite = node.workflowId === '__file_write__';
    var isFileRead = node.workflowId === '__file_read__';
    var isJunction = node.workflowId === '__junction__';
    var isFlowControl = isBranch || isDelay || isGateNode || isForEach || isSwitch;
    var isSpecial = isGate || isScript || isOutput || isComposition || isImageViewer || isMedia || isFlowControl || isAsset || isText || isFileOp || isJsonKeys || isTool || isFileWrite || isFileRead || isJunction || isVariable || isGetVariable;
    var wf = isSpecial ? null : getWorkflowForNode(node);
    var isSelected = selectedNodes.has(node.id);
    var nodeWarnings = warnings.filter(function(w) { return w.nodeId === node.id; });
    var displayName = node.label
      || (isGate ? 'Approval Gate'
        : isScript ? 'Script'
        : isOutput ? 'Pipeline Output'
        : isImageViewer ? 'Image Viewer'
        : isMedia ? 'Media Player'
        : isBranch ? 'Branch'
        : isDelay ? 'Delay'
        : isGateNode ? 'Gate'
        : isForEach ? 'ForEach Loop'
        : isSwitch ? 'Switch'
        : isAsset ? 'Asset'
        : isText ? 'Text'
        : isVariable ? (node.label || 'Variable')
        : isGetVariable ? (node.label || 'Get Variable')
        : isFileOp ? (node.fileOp ? ({ copy: 'Copy File', move: 'Move File', delete: 'Delete File', mkdir: 'Create Folder', list: 'List Files' }[node.fileOp.operation] || 'File Op') : 'File Op')
        : isJsonKeys ? 'JSON Extract'
        : isTool ? (node.toolNode && node.toolNode.selectedTool ? node.toolNode.selectedTool : 'Tool')
        : isFileWrite ? 'Write File'
        : isFileRead ? 'Read File'
        : isJunction ? 'Junction'
        : isComposition ? 'Pipeline'
        : (wf ? wf.name : node.workflowId));

    var nodeWidthStyle = '';
    if (isImageViewer && node.imageViewer) {
      nodeWidthStyle = 'width:' + (node.imageViewer.width + 40) + 'px;'; // +40 for port columns + padding
    }
    if (isMedia && node.mediaPlayer) {
      nodeWidthStyle = 'width:' + (node.mediaPlayer.width + 40) + 'px;';
    }
    var nodeClass = 'comp-node';
    if (isGate) nodeClass += ' comp-node-gate';
    if (isScript) nodeClass += ' comp-node-script';
    if (isOutput) nodeClass += ' comp-node-output';
    if (isComposition) nodeClass += ' comp-node-composition';
    if (isImageViewer) nodeClass += ' comp-node-image-viewer';
    if (isMedia) nodeClass += ' comp-node-media';
    if (isBranch) nodeClass += ' comp-node-branch';
    if (isDelay) nodeClass += ' comp-node-delay';
    if (isGateNode) nodeClass += ' comp-node-gate-node';
    if (isForEach) nodeClass += ' comp-node-for-each';
    if (isSwitch) nodeClass += ' comp-node-switch';
    if (isAsset) nodeClass += ' comp-node-asset';
    if (isText) nodeClass += ' comp-node-text';
    if (isVariable) nodeClass += ' comp-node-variable';
    if (isGetVariable) nodeClass += ' comp-node-get-variable';
    if (isFileOp) nodeClass += ' comp-node-file-op';
    if (isTool) nodeClass += ' comp-node-tool';
    if (isFileWrite) nodeClass += ' comp-node-file-write';
    if (isFileRead) nodeClass += ' comp-node-file-read';
    if (isJunction) nodeClass += ' comp-node-junction';
    if (isSelected) nodeClass += ' comp-node-selected';
    html += '<div class="' + nodeClass + '" data-node-id="' + compEscAttr(node.id) + '" style="left:' + node.position.x + 'px;top:' + node.position.y + 'px;' + nodeWidthStyle + '">';

    // Warning badge
    if (nodeWarnings.length > 0) {
      html += '<div class="comp-node-warning" title="' + compEscAttr(nodeWarnings.map(function(w) { return w.message; }).join('; ')) + '">&#x26a0;</div>';
    }

    // Header
    html += '<div class="comp-node-header">';
    if (isGate) {
      html += '<span class="comp-node-gate-icon">&#x1f6d1;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isScript) {
      html += '<span class="comp-node-script-icon">&#x192;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isOutput) {
      html += '<span class="comp-node-output-icon">&#x1f4e4;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isComposition) {
      html += '<span class="comp-node-composition-icon comp-node-nav-link" title="Open pipeline" style="cursor:pointer;">&#x1f517;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isImageViewer) {
      html += '<span class="comp-node-image-viewer-icon">&#x1f5bc;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isMedia) {
      html += '<span class="comp-node-media-icon">&#x25b6;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isBranch) {
      html += '<span class="comp-node-flow-icon">&#x2194;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isDelay) {
      html += '<span class="comp-node-flow-icon">&#x23f3;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isGateNode) {
      html += '<span class="comp-node-flow-icon">&#x26d4;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isForEach) {
      html += '<span class="comp-node-flow-icon">&#x1f504;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isSwitch) {
      html += '<span class="comp-node-flow-icon">&#x2b82;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isAsset) {
      html += '<span class="comp-node-asset-icon">&#x1f4be;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isText) {
      html += '<span class="comp-node-text-icon">&#x1f4dd;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isVariable) {
      html += '<span class="comp-node-variable-icon">&#x1f4e6;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isGetVariable) {
      html += '<span class="comp-node-get-variable-icon">&#x1f4cb;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isFileOp) {
      html += '<span class="comp-node-file-op-icon">&#x1f4c1;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isTool) {
      html += '<span class="comp-node-tool-icon">&#x1f527;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isFileWrite) {
      html += '<span class="comp-node-file-write-icon">&#x1f4be;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isFileRead) {
      html += '<span class="comp-node-file-read-icon">&#x1f4c4;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isJunction) {
      html += '<span class="comp-node-junction-icon">&#x26a1;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (wf) {
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
      if (wf.site) {
        html += '<span class="comp-node-site">' + compEscHtml(wf.site) + '</span>';
      }
    } else {
      html += '<span class="comp-node-name" style="color:#ef4444;">Missing: ' + compEscHtml(node.workflowId) + '</span>';
    }
    if (node.idempotent) {
      html += '<span class="comp-node-idempotent-badge" title="Cached (idempotent)">&#x1F504;</span>';
    }
    html += '</div>';

    if (isGate) {
      // Gate body — show message preview and a single pass-through port on each side
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      html += '<div class="comp-port comp-port-in" data-port-id="' + compEscAttr(node.id + ':in:__gate_in__') + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="__gate_in__" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label">In</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      html += '<div class="comp-port comp-port-out" data-port-id="' + compEscAttr(node.id + ':out:__gate_out__') + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="__gate_out__" data-port-dir="out">';
      html += '<span class="comp-port-label">Out</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      var gateMsg = (node.approvalGate && node.approvalGate.message) || '';
      html += '<span class="comp-node-gate-msg">' + compEscHtml(gateMsg.length > 40 ? gateMsg.slice(0, 40) + '...' : gateMsg) + '</span>';
      html += '</div>';
    } else if (isScript) {
      // Script node body — ports from script.inputs / script.outputs
      var scriptCfg = node.script || { inputs: [], outputs: [] };
      html += '<div class="comp-node-body">';

      // Inputs (left side)
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var si = 0; si < scriptCfg.inputs.length; si++) {
        var sInp = scriptCfg.inputs[si];
        var sInpPortId = node.id + ':in:' + sInp.name;
        var sInpConnected = isPortConnected(node.id, sInp.name, 'input');
        html += '<div class="comp-port comp-port-in' + (sInpConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(sInpPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(sInp.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(sInp.description || sInp.name) + '">' + compEscHtml(humanizeVarName(sInp.name)) + '</span>';
        html += '</div>';
      }
      html += '</div>';

      // Outputs (right side)
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var so = 0; so < scriptCfg.outputs.length; so++) {
        var sOut = scriptCfg.outputs[so];
        var sOutPortId = node.id + ':out:' + sOut.name;
        var sOutConnected = isPortConnected(node.id, sOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (sOutConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(sOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(sOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(sOut.description || sOut.name) + '">' + compEscHtml(humanizeVarName(sOut.name)) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';

      html += '</div>'; // .comp-node-body

      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-script-badge">Script</span>';
      html += '<span style="color:#64748b;font-size:0.65rem;">' + scriptCfg.inputs.length + ' in / ' + scriptCfg.outputs.length + ' out</span>';
      html += '</div>';
    } else if (isOutput) {
      // Output node body — input ports only (values flowing in become pipeline outputs)
      var outputCfg = node.outputNode || { ports: [] };
      html += '<div class="comp-node-body">';

      // Inputs only (left side) — these are the pipeline's output values
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var oi = 0; oi < outputCfg.ports.length; oi++) {
        var oInp = outputCfg.ports[oi];
        var oInpPortId = node.id + ':in:' + oInp.name;
        var oInpConnected = isPortConnected(node.id, oInp.name, 'input');
        html += '<div class="comp-port comp-port-in' + (oInpConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(oInpPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(oInp.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(oInp.description || oInp.name) + '">' + compEscHtml(humanizeVarName(oInp.name)) + '</span>';
        html += '</div>';
      }
      if (outputCfg.ports.length === 0) {
        html += '<div style="color:#475569;font-size:0.65rem;font-style:italic;padding:4px 8px;">No ports yet</div>';
      }
      html += '</div>';

      // No output ports (right side empty)
      html += '<div class="comp-node-ports comp-node-outputs"></div>';

      html += '</div>'; // .comp-node-body

      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-output-badge">Output</span>';
      html += '<span style="color:#64748b;font-size:0.65rem;">' + outputCfg.ports.length + ' port' + (outputCfg.ports.length !== 1 ? 's' : '') + '</span>';
      html += '</div>';
    } else if (isComposition) {
      // Composition (pipeline-as-node) — ports from cached interface
      var compRefId = node.compositionRef ? node.compositionRef.compositionId : node.workflowId.slice(5);
      var cachedIf = compositionInterfaceCache[compRefId];
      var compInputs = (cachedIf && cachedIf.data && cachedIf.data.inputs) ? cachedIf.data.inputs : [];
      var compOutputs = (cachedIf && cachedIf.data && cachedIf.data.outputs) ? cachedIf.data.outputs : [];

      html += '<div class="comp-node-body">';

      // Inputs (left side) — sub-pipeline's inferred inputs
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var ci = 0; ci < compInputs.length; ci++) {
        var cInp = compInputs[ci];
        var cInpPortId = node.id + ':in:' + cInp.name;
        var cInpConnected = isPortConnected(node.id, cInp.name, 'input');
        html += '<div class="comp-port comp-port-in' + (cInpConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(cInpPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(cInp.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(cInp.description || cInp.name) + '">' + compEscHtml(humanizeVarName(cInp.name)) + '</span>';
        html += '</div>';
      }
      if (!cachedIf) {
        html += '<div style="color:#475569;font-size:0.6rem;font-style:italic;padding:2px 8px;">Loading...</div>';
      }
      html += '</div>';

      // Outputs (right side) — sub-pipeline's output node ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var co = 0; co < compOutputs.length; co++) {
        var cOut = compOutputs[co];
        var cOutPortId = node.id + ':out:' + cOut.name;
        var cOutConnected = isPortConnected(node.id, cOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (cOutConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(cOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(cOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(cOut.description || cOut.name) + '">' + compEscHtml(humanizeVarName(cOut.name)) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';

      html += '</div>'; // .comp-node-body

      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-composition-badge">Pipeline</span>';
      html += '<span style="color:#64748b;font-size:0.65rem;">' + compInputs.length + ' in / ' + compOutputs.length + ' out</span>';
      html += '</div>';

      // Trigger async interface fetch if not cached
      if (!cachedIf) {
        (function(refId) {
          fetchCompositionInterface(refId).then(function() {
            renderNodes();
            renderEdges();
            wireUpCanvas();
          });
        })(compRefId);
      }
    } else if (isImageViewer) {
      // Image viewer node — input port, image preview, output port
      var ivCfg = node.imageViewer || { filePath: '', width: 300, height: 300 };
      var ivFilePath = ivCfg.filePath || '';
      // Use runtime value from last run if available (e.g. from an edge connection)
      if (lastNodeStates && lastNodeStates[node.id]) {
        var _rns = lastNodeStates[node.id];
        var _runtimePath = (_rns.outputVariables && _rns.outputVariables.file_path) || (_rns.inputVariables && _rns.inputVariables.file_path);
        if (_runtimePath && typeof _runtimePath === 'string') ivFilePath = _runtimePath;
      }
      var ivWidth = ivCfg.width || 300;
      var ivHeight = ivCfg.height || 300;

      html += '<div class="comp-image-viewer-body">';

      // Input port (left side)
      html += '<div class="comp-image-viewer-ports-in">';
      var ivInPortId = node.id + ':in:file_path';
      var ivInConnected = isPortConnected(node.id, 'file_path', 'input');
      html += '<div class="comp-port comp-port-in' + (ivInConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(ivInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="file_path" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Image file path">Path</span>';
      html += '</div>';
      html += '</div>';

      // Image preview (center)
      html += '<div class="comp-image-viewer-wrap" style="height:' + ivHeight + 'px;">';
      if (ivFilePath) {
        html += '<img class="comp-image-viewer-img" src="/api/file?path=' + encodeURIComponent(ivFilePath) + '" alt="Preview" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'">';
        html += '<div class="comp-image-viewer-placeholder" style="display:none;">Failed to load image</div>';
      } else {
        html += '<div class="comp-image-viewer-placeholder">No image<br><span style="font-size:0.6rem;">Set file path in properties</span></div>';
      }
      html += '<div class="comp-image-viewer-resize-handle" data-node-id="' + compEscAttr(node.id) + '"></div>';
      html += '</div>';

      // Output port (right side)
      html += '<div class="comp-image-viewer-ports-out">';
      var ivOutPortId = node.id + ':out:file_path';
      var ivOutConnected = isPortConnected(node.id, 'file_path', 'output');
      html += '<div class="comp-port comp-port-out' + (ivOutConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(ivOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="file_path" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Image file path">Path</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';

      html += '</div>'; // .comp-image-viewer-body

      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-image-viewer-badge">Image</span>';
      if (ivFilePath) {
        var ivFileName = ivFilePath.split('/').pop() || ivFilePath;
        html += '<span style="color:#64748b;font-size:0.6rem;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;display:inline-block;vertical-align:middle;">' + compEscHtml(ivFileName) + '</span>';
      }
      html += '</div>';

    } else if (isMedia) {
      // Media player node — input port (Source), preview area, output ports (Path, Type)
      var mpCfg = node.mediaPlayer || { sourceMode: 'file_path', filePath: '', url: '', assetId: '', mediaType: 'auto', width: 320, height: 240 };
      var mpFilePath = '';
      if (mpCfg.sourceMode === 'file_path') mpFilePath = mpCfg.filePath || '';
      else if (mpCfg.sourceMode === 'url') mpFilePath = mpCfg.url || '';
      // Use runtime value if available
      if (lastNodeStates && lastNodeStates[node.id]) {
        var _mpRns = lastNodeStates[node.id];
        var _mpRuntimePath = (_mpRns.outputVariables && _mpRns.outputVariables.file_path) || (_mpRns.inputVariables && _mpRns.inputVariables.file_path);
        if (_mpRuntimePath && typeof _mpRuntimePath === 'string') mpFilePath = _mpRuntimePath;
      }
      var mpDetectedType = detectMediaTypeFromExt(mpFilePath, mpCfg.mediaType);
      var mpWidth = mpCfg.width || 320;
      var mpHeight = mpCfg.height || 240;

      html += '<div class="comp-media-body">';

      // Input port (left side)
      html += '<div class="comp-media-ports-in">';
      var mpInPortId = node.id + ':in:file_path';
      var mpInConnected = isPortConnected(node.id, 'file_path', 'input');
      html += '<div class="comp-port comp-port-in' + (mpInConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(mpInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="file_path" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Media source path/URL">Source</span>';
      html += '</div>';
      html += '</div>';

      // Preview area (center)
      html += '<div class="comp-media-wrap" style="height:' + mpHeight + 'px;">';
      if (mpFilePath) {
        var mpSrc = mpFilePath.startsWith('http') ? mpFilePath : '/api/file?path=' + encodeURIComponent(mpFilePath);
        if (mpDetectedType === 'image') {
          html += '<img class="comp-media-preview-img" src="' + mpSrc + '" alt="Preview" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'">';
          html += '<div class="comp-media-placeholder" style="display:none;">Failed to load</div>';
        } else if (mpDetectedType === 'video') {
          html += '<video class="comp-media-preview-video" src="' + mpSrc + '" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'"></video>';
          html += '<div class="comp-media-placeholder" style="display:none;">Failed to load video</div>';
        } else if (mpDetectedType === 'audio') {
          html += '<div class="comp-media-audio-inline"><span style="font-size:1.2rem;">&#x1f3b5;</span><audio src="' + mpSrc + '" controls preload="metadata" style="width:100%;height:28px;"></audio></div>';
        } else if (mpDetectedType === 'pdf') {
          html += '<iframe class="comp-media-preview-pdf" src="' + mpSrc + '" style="width:100%;height:100%;border:none;background:#fff;"></iframe>';
        } else if (mpDetectedType === 'text') {
          html += '<div class="comp-media-placeholder"><span style="font-size:1.5rem;">&#x1f4dd;</span><br>Text</div>';
        } else {
          html += '<div class="comp-media-placeholder"><span style="font-size:1.5rem;">&#x25b6;</span><br>' + compEscHtml(mpDetectedType) + '</div>';
        }
      } else {
        html += '<div class="comp-media-placeholder">No media<br><span style="font-size:0.6rem;">Configure in properties</span></div>';
      }
      html += '<div class="comp-media-resize-handle" data-node-id="' + compEscAttr(node.id) + '"></div>';
      html += '</div>';

      // Output ports (right side)
      html += '<div class="comp-media-ports-out">';
      var mpOutPathId = node.id + ':out:file_path';
      var mpOutPathConn = isPortConnected(node.id, 'file_path', 'output');
      html += '<div class="comp-port comp-port-out' + (mpOutPathConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(mpOutPathId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="file_path" data-port-dir="out">';
      html += '<span class="comp-port-label" title="File path">Path</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      var mpOutTypeId = node.id + ':out:media_type';
      var mpOutTypeConn = isPortConnected(node.id, 'media_type', 'output');
      html += '<div class="comp-port comp-port-out' + (mpOutTypeConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(mpOutTypeId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="media_type" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Detected media type">Type</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';

      html += '</div>'; // .comp-media-body

      // Footer with type badge
      var mpBadgeColors = { image: '#a855f7', video: '#3b82f6', audio: '#22c55e', pdf: '#ef4444', text: '#f59e0b' };
      var mpBadgeColor = mpBadgeColors[mpDetectedType] || '#64748b';
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-media-badge" style="background:' + mpBadgeColor + '22;color:' + mpBadgeColor + ';">' + compEscHtml(mpDetectedType === 'auto' ? 'Media' : mpDetectedType.charAt(0).toUpperCase() + mpDetectedType.slice(1)) + '</span>';
      if (mpFilePath) {
        var mpFileName = mpFilePath.split('/').pop() || mpFilePath;
        html += '<span style="color:#64748b;font-size:0.6rem;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;display:inline-block;vertical-align:middle;">' + compEscHtml(mpFileName) + '</span>';
      }
      html += '</div>';

    } else if (isBranch) {
      // Branch node — 1 input (condition), 2 outputs (on_true, on_false)
      var brCfg = node.branchNode || { condition: '' };
      html += '<div class="comp-node-body">';
      // Inputs
      html += '<div class="comp-node-ports comp-node-inputs">';
      var brInPortId = node.id + ':in:condition';
      var brInConn = isPortConnected(node.id, 'condition', 'input');
      html += '<div class="comp-port comp-port-in' + (brInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(brInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="condition" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Condition value (truthy/falsy)">Condition</span>';
      html += '</div>';
      html += '</div>';
      // Outputs
      html += '<div class="comp-node-ports comp-node-outputs">';
      var brTruePortId = node.id + ':out:on_true';
      var brTrueConn = isPortConnected(node.id, 'on_true', 'output');
      html += '<div class="comp-port comp-port-out' + (brTrueConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(brTruePortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="on_true" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Executes when condition is truthy" style="color:#22c55e;">True</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#22c55e;"></div>';
      html += '</div>';
      var brFalsePortId = node.id + ':out:on_false';
      var brFalseConn = isPortConnected(node.id, 'on_false', 'output');
      html += '<div class="comp-port comp-port-out' + (brFalseConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(brFalsePortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="on_false" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Executes when condition is falsy" style="color:#ef4444;">False</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#ef4444;"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer — show condition expression
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#f59e0b;font-size:0.6rem;">if</span>';
      html += '<span style="color:#94a3b8;font-size:0.6rem;margin-left:4px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;display:inline-block;vertical-align:middle;">' + compEscHtml(brCfg.condition || '...') + '</span>';
      html += '</div>';

    } else if (isDelay) {
      // Delay node — 1 input (delay_ms), 1 pass-through output (done)
      var dlCfg = node.delayNode || { delayMs: 1000 };
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      var dlInPortId = node.id + ':in:delay_ms';
      var dlInConn = isPortConnected(node.id, 'delay_ms', 'input');
      html += '<div class="comp-port comp-port-in' + (dlInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(dlInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="delay_ms" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Delay override (ms)">Delay Ms</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      var dlOutPortId = node.id + ':out:done';
      var dlOutConn = isPortConnected(node.id, 'done', 'output');
      html += '<div class="comp-port comp-port-out' + (dlOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(dlOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="done" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Fires after delay">Done</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#06b6d4;font-size:0.6rem;">' + dlCfg.delayMs + 'ms</span>';
      html += '</div>';

    } else if (isGateNode) {
      // Gate node — 2 inputs (open, data), 1 output (out)
      var gtCfg = node.gateNode || { defaultOpen: true, onClosed: 'skip' };
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      // open port
      var gtOpenPortId = node.id + ':in:open';
      var gtOpenConn = isPortConnected(node.id, 'open', 'input');
      html += '<div class="comp-port comp-port-in' + (gtOpenConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gtOpenPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="open" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Boolean: open/closed">Open</span>';
      html += '</div>';
      // data port
      var gtDataPortId = node.id + ':in:data';
      var gtDataConn = isPortConnected(node.id, 'data', 'input');
      html += '<div class="comp-port comp-port-in' + (gtDataConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gtDataPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="data" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Data to pass through">Data</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      var gtOutPortId = node.id + ':out:out';
      var gtOutConn = isPortConnected(node.id, 'out', 'output');
      html += '<div class="comp-port comp-port-out' + (gtOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gtOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="out" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Pass-through output">Out</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#14b8a6;font-size:0.6rem;">Default: ' + (gtCfg.defaultOpen ? 'Open' : 'Closed') + ' | On closed: ' + gtCfg.onClosed + '</span>';
      html += '</div>';

    } else if (isForEach) {
      // ForEach node — UE-style: 1 input (items), 2 output groups (Loop Body / Completed)
      var feCfg = node.forEachNode || { itemVariable: 'item', maxIterations: 100 };
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      var feInPortId = node.id + ':in:items';
      var feInConn = isPortConnected(node.id, 'items', 'input');
      html += '<div class="comp-port comp-port-in' + (feInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="items" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Array of items to iterate">Items</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';

      // ── Loop Body group (green) ──
      html += '<div class="comp-port-group-label" style="color:#22c55e;font-size:0.55rem;padding:1px 4px;font-weight:600;">Loop Body</div>';
      // current_item output
      var feItemPortId = node.id + ':out:current_item';
      var feItemConn = isPortConnected(node.id, 'current_item', 'output');
      html += '<div class="comp-port comp-port-out' + (feItemConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feItemPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="current_item" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Current item in iteration">Item</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#22c55e;border-color:#16a34a;"></div>';
      html += '</div>';
      // index output
      var feIdxPortId = node.id + ':out:index';
      var feIdxConn = isPortConnected(node.id, 'index', 'output');
      html += '<div class="comp-port comp-port-out' + (feIdxConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feIdxPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="index" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Current loop index (0-based)">Index</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#22c55e;border-color:#16a34a;"></div>';
      html += '</div>';
      // count output (in loop body for convenience)
      var feCntPortId = node.id + ':out:count';
      var feCntConn = isPortConnected(node.id, 'count', 'output');
      html += '<div class="comp-port comp-port-out' + (feCntConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feCntPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="count" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Total number of items">Count</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#22c55e;border-color:#16a34a;"></div>';
      html += '</div>';

      // ── Divider ──
      html += '<div style="border-top:1px solid rgba(255,255,255,0.1);margin:3px 0;"></div>';

      // ── Completed group (blue) ──
      html += '<div class="comp-port-group-label" style="color:#38bdf8;font-size:0.55rem;padding:1px 4px;font-weight:600;">Completed</div>';
      // results output
      var feResPortId = node.id + ':out:results';
      var feResConn = isPortConnected(node.id, 'results', 'output');
      html += '<div class="comp-port comp-port-out' + (feResConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feResPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="results" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Collected results from all iterations">Results</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#38bdf8;border-color:#0ea5e9;"></div>';
      html += '</div>';
      // total_count output
      var feTcPortId = node.id + ':out:total_count';
      var feTcConn = isPortConnected(node.id, 'total_count', 'output');
      html += '<div class="comp-port comp-port-out' + (feTcConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feTcPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="total_count" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Total iterations completed">Total Count</span>';
      html += '<div class="comp-port-dot comp-port-dot-out" style="background:#38bdf8;border-color:#0ea5e9;"></div>';
      html += '</div>';

      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#22c55e;font-size:0.6rem;">max: ' + feCfg.maxIterations + '</span>';
      html += '</div>';

    } else if (isSwitch) {
      // Switch node — 1 input (value), N+1 outputs (cases + default)
      var swCfg = node.switchNode || { cases: [], defaultPort: 'on_default' };
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      var swInPortId = node.id + ':in:value';
      var swInConn = isPortConnected(node.id, 'value', 'input');
      html += '<div class="comp-port comp-port-in' + (swInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(swInPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="value" data-port-dir="in">';
      html += '<div class="comp-port-dot comp-port-dot-in"></div>';
      html += '<span class="comp-port-label" title="Value to match against cases">Value</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      // Case outputs
      for (var swi = 0; swi < swCfg.cases.length; swi++) {
        var swCase = swCfg.cases[swi];
        var swCasePortId = node.id + ':out:' + swCase.port;
        var swCaseConn = isPortConnected(node.id, swCase.port, 'output');
        html += '<div class="comp-port comp-port-out' + (swCaseConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(swCasePortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(swCase.port) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="When value = &quot;' + compEscAttr(swCase.value) + '&quot;">' + compEscHtml(swCase.value) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      // Default output
      var swDefPortId = node.id + ':out:' + swCfg.defaultPort;
      var swDefConn = isPortConnected(node.id, swCfg.defaultPort, 'output');
      html += '<div class="comp-port comp-port-out' + (swDefConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(swDefPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(swCfg.defaultPort) + '" data-port-dir="out">';
      html += '<span class="comp-port-label" title="When no case matches" style="color:#64748b;font-style:italic;">Default</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#f97316;font-size:0.6rem;">' + swCfg.cases.length + ' cases</span>';
      html += '</div>';

    } else if (isAsset) {
      // Asset node — dynamic ports based on mode
      var assetCfg = node.asset || { mode: 'pick' };
      var assetMode = assetCfg.mode || 'pick';
      html += '<div class="comp-node-body">';

      // Inputs
      html += '<div class="comp-node-ports comp-node-inputs">';
      if (assetMode === 'save') {
        var asSaveInPort1 = node.id + ':in:filePath';
        var asSaveIn1Conn = isPortConnected(node.id, 'filePath', 'input');
        html += '<div class="comp-port comp-port-in' + (asSaveIn1Conn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(asSaveInPort1) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="filePath" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="File path to save as asset">File Path</span>';
        html += '</div>';
        var asSaveInPort2 = node.id + ':in:name';
        var asSaveIn2Conn = isPortConnected(node.id, 'name', 'input');
        html += '<div class="comp-port comp-port-in' + (asSaveIn2Conn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(asSaveInPort2) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="name" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="Asset name (optional)">Name</span>';
        html += '</div>';
      } else if (assetMode === 'remove') {
        var asRemInPort = node.id + ':in:assetId';
        var asRemInConn = isPortConnected(node.id, 'assetId', 'input');
        html += '<div class="comp-port comp-port-in' + (asRemInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(asRemInPort) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="assetId" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="Asset ID to remove">Asset ID</span>';
        html += '</div>';
      } else if (assetMode === 'generate_path') {
        var gpInPort = node.id + ':in:name';
        var gpInConn = isPortConnected(node.id, 'name', 'input');
        html += '<div class="comp-port comp-port-in' + (gpInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gpInPort) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="name" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="Name to use in pattern (optional, replaces {name} token)">Name</span>';
        html += '</div>';
      }
      // pick and list have no inputs (configured in properties)
      html += '</div>';

      // Outputs
      html += '<div class="comp-node-ports comp-node-outputs">';
      if (assetMode === 'pick') {
        var pickOuts = [
          { name: 'filePath', label: 'File Path', title: 'Full path to the asset file' },
          { name: 'fileName', label: 'File Name', title: 'Asset file name' },
          { name: 'assetId', label: 'Asset ID', title: 'Unique asset identifier' },
          { name: 'metadata', label: 'Metadata', title: 'Asset metadata JSON' },
        ];
        for (var po = 0; po < pickOuts.length; po++) {
          var pOut = pickOuts[po];
          var pOutPortId = node.id + ':out:' + pOut.name;
          var pOutConn = isPortConnected(node.id, pOut.name, 'output');
          html += '<div class="comp-port comp-port-out' + (pOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(pOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(pOut.name) + '" data-port-dir="out">';
          html += '<span class="comp-port-label" title="' + compEscAttr(pOut.title) + '">' + compEscHtml(pOut.label) + '</span>';
          html += '<div class="comp-port-dot comp-port-dot-out"></div>';
          html += '</div>';
        }
      } else if (assetMode === 'save') {
        var saveOuts = [
          { name: 'assetId', label: 'Asset ID', title: 'ID of the saved asset' },
          { name: 'success', label: 'Success', title: 'Whether save succeeded' },
        ];
        for (var so = 0; so < saveOuts.length; so++) {
          var sOut = saveOuts[so];
          var sOutPortId = node.id + ':out:' + sOut.name;
          var sOutConn = isPortConnected(node.id, sOut.name, 'output');
          html += '<div class="comp-port comp-port-out' + (sOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(sOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(sOut.name) + '" data-port-dir="out">';
          html += '<span class="comp-port-label" title="' + compEscAttr(sOut.title) + '">' + compEscHtml(sOut.label) + '</span>';
          html += '<div class="comp-port-dot comp-port-dot-out"></div>';
          html += '</div>';
        }
      } else if (assetMode === 'list') {
        var listOuts = [
          { name: 'assets', label: 'Assets', title: 'JSON array of asset summaries' },
          { name: 'count', label: 'Count', title: 'Number of assets' },
        ];
        for (var lo = 0; lo < listOuts.length; lo++) {
          var lOut = listOuts[lo];
          var lOutPortId = node.id + ':out:' + lOut.name;
          var lOutConn = isPortConnected(node.id, lOut.name, 'output');
          html += '<div class="comp-port comp-port-out' + (lOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(lOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(lOut.name) + '" data-port-dir="out">';
          html += '<span class="comp-port-label" title="' + compEscAttr(lOut.title) + '">' + compEscHtml(lOut.label) + '</span>';
          html += '<div class="comp-port-dot comp-port-dot-out"></div>';
          html += '</div>';
        }
      } else if (assetMode === 'remove') {
        var remOutPortId = node.id + ':out:success';
        var remOutConn = isPortConnected(node.id, 'success', 'output');
        html += '<div class="comp-port comp-port-out' + (remOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(remOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="success" data-port-dir="out">';
        html += '<span class="comp-port-label" title="Whether removal succeeded">Success</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      } else if (assetMode === 'generate_path') {
        var gpOuts = [
          { name: 'filePath', label: 'File Path', title: 'Full generated file path' },
          { name: 'fileName', label: 'File Name', title: 'Generated file name with extension' },
          { name: 'directory', label: 'Directory', title: 'Output directory path' },
          { name: 'collection', label: 'Collection', title: 'Collection slug (if set)' },
        ];
        for (var gpo = 0; gpo < gpOuts.length; gpo++) {
          var gpOut = gpOuts[gpo];
          var gpOutPortId = node.id + ':out:' + gpOut.name;
          var gpOutConn = isPortConnected(node.id, gpOut.name, 'output');
          html += '<div class="comp-port comp-port-out' + (gpOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gpOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(gpOut.name) + '" data-port-dir="out">';
          html += '<span class="comp-port-label" title="' + compEscAttr(gpOut.title) + '">' + compEscHtml(gpOut.label) + '</span>';
          html += '<div class="comp-port-dot comp-port-dot-out"></div>';
          html += '</div>';
        }
      }
      html += '</div>';
      html += '</div>'; // .comp-node-body

      // Footer — mode badge + collection name
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-asset-badge">' + compEscHtml(assetMode) + '</span>';
      if (assetCfg.collectionSlug) {
        html += '<span class="comp-node-asset-info">' + compEscHtml(assetCfg.collectionSlug) + '</span>';
      }
      html += '</div>';

    } else if (isVariable) {
      var varCfg = node.variableNode || { type: 'string', initialValue: '', exposeAsInput: false, inputName: '', description: '', required: false, generationPrompt: '' };
      html += '<div class="comp-node-body">';
      // Input ports
      html += '<div class="comp-node-ports comp-node-inputs">';
      var varInputs = [{ name: 'set', label: 'Set' }, { name: 'push', label: 'Push' }];
      for (var vi = 0; vi < varInputs.length; vi++) {
        var vip = varInputs[vi];
        var vipId = node.id + ':in:' + vip.name;
        var vipConn = isPortConnected(node.id, vip.name, 'input');
        html += '<div class="comp-port comp-port-in' + (vipConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(vipId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(vip.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label">' + compEscHtml(vip.label) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      // Output ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      var varOutputs = [{ name: 'value', label: 'Value' }, { name: 'length', label: 'Length' }];
      for (var vo = 0; vo < varOutputs.length; vo++) {
        var vop = varOutputs[vo];
        var vopId = node.id + ':out:' + vop.name;
        var vopConn = isPortConnected(node.id, vop.name, 'output');
        html += '<div class="comp-port comp-port-out' + (vopConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(vopId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(vop.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label">' + compEscHtml(vop.label) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      var varPreview = varCfg.initialValue || '(empty)';
      if (varPreview.length > 20) varPreview = varPreview.substring(0, 20) + '...';
      html += '<span class="comp-node-variable-badge">' + compEscHtml(varCfg.type.toUpperCase()) + '</span>';
      if (varCfg.exposeAsInput && varCfg.inputName) {
        html += ' <span class="comp-node-variable-input-badge">INPUT: ' + compEscHtml(varCfg.inputName) + '</span>';
      }
      html += ' <span style="font-size:0.55rem;color:#64748b;">' + compEscHtml(varPreview) + '</span>';
      html += '</div>';

    } else if (isGetVariable) {
      var gvCfg = node.getVariableNode || { targetNodeId: '' };
      // Find the target Variable node's label
      var gvTargetLabel = '(no target)';
      if (gvCfg.targetNodeId && compData) {
        var gvTarget = compData.nodes.find(function(n) { return n.id === gvCfg.targetNodeId; });
        if (gvTarget) gvTargetLabel = gvTarget.label || 'Variable';
        else gvTargetLabel = '(missing)';
      }
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs"></div>';
      // Output ports: value, length
      html += '<div class="comp-node-ports comp-node-outputs">';
      var gvOutputs = [{ name: 'value', label: 'Value' }, { name: 'length', label: 'Length' }];
      for (var gvi = 0; gvi < gvOutputs.length; gvi++) {
        var gvo = gvOutputs[gvi];
        var gvopId = node.id + ':out:' + gvo.name;
        var gvopConn = isPortConnected(node.id, gvo.name, 'output');
        html += '<div class="comp-port comp-port-out' + (gvopConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(gvopId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(gvo.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label">' + compEscHtml(gvo.label) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer — show target variable name
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-get-variable-badge">&#x2190; ' + compEscHtml(gvTargetLabel) + '</span>';
      html += '</div>';

    } else if (isText) {
      // Text input node — preview + single output port
      var txtCfg = node.textNode || { value: '' };
      var txtPreview = txtCfg.value || '';
      if (txtPreview.length > 60) txtPreview = txtPreview.substring(0, 57) + '...';
      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs"></div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      var txtOutPortId = node.id + ':out:text';
      var txtOutConn = isPortConnected(node.id, 'text', 'output');
      html += '<div class="comp-port comp-port-out' + (txtOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(txtOutPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="text" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Text output">Text</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer — text preview
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-text-preview">' + compEscHtml(txtPreview || '(empty)') + '</span>';
      html += '</div>';

    } else if (isFileOp) {
      // File operation node — dynamic ports based on operation
      var fopCfg = node.fileOp || { operation: 'copy' };
      var fopOp = fopCfg.operation || 'copy';

      // Define ports per operation
      var fopInputs = [];
      var fopOutputs = [];
      if (fopOp === 'copy' || fopOp === 'move') {
        fopInputs = [{ name: 'sourcePath', label: 'Source Path' }, { name: 'destinationPath', label: 'Dest Path' }];
        fopOutputs = [{ name: 'outputPath', label: 'Output Path' }, { name: 'success', label: 'Success' }];
      } else if (fopOp === 'delete') {
        fopInputs = [{ name: 'filePath', label: 'File Path' }];
        fopOutputs = [{ name: 'success', label: 'Success' }];
      } else if (fopOp === 'mkdir') {
        fopInputs = [{ name: 'folderPath', label: 'Folder Path' }];
        fopOutputs = [{ name: 'outputPath', label: 'Output Path' }, { name: 'success', label: 'Success' }];
      } else if (fopOp === 'list') {
        fopInputs = [{ name: 'folderPath', label: 'Folder Path' }];
        fopOutputs = [{ name: 'files', label: 'Files' }, { name: 'count', label: 'Count' }];
      }

      html += '<div class="comp-node-body">';
      // Input ports
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var fi = 0; fi < fopInputs.length; fi++) {
        var fip = fopInputs[fi];
        var fipId = node.id + ':in:' + fip.name;
        var fipConn = isPortConnected(node.id, fip.name, 'input');
        html += '<div class="comp-port comp-port-in' + (fipConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(fipId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(fip.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(fip.label) + '">' + compEscHtml(fip.label) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      // Output ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var fo = 0; fo < fopOutputs.length; fo++) {
        var fop = fopOutputs[fo];
        var fopId = node.id + ':out:' + fop.name;
        var fopConn = isPortConnected(node.id, fop.name, 'output');
        html += '<div class="comp-port comp-port-out' + (fopConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(fopId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(fop.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(fop.label) + '">' + compEscHtml(fop.label) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';

      // Footer — operation badge
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-file-op-badge">' + compEscHtml(fopOp.toUpperCase()) + '</span>';
      html += '</div>';

    } else if (isJsonKeys) {
      // JSON Keys/Extract node — inputs: json, path; outputs: keys, values, value, type, structure
      var jkInputs = [
        { name: 'json', label: 'JSON', title: 'JSON string or object to parse' },
        { name: 'path', label: 'Path', title: 'Dot-notation path (e.g. categories.0.topics)' },
      ];
      var jkOutputs = [
        { name: 'keys', label: 'Keys', title: 'Array of keys at the resolved path' },
        { name: 'values', label: 'Values', title: 'Array of values at the resolved path' },
        { name: 'value', label: 'Value', title: 'The resolved value at the path' },
        { name: 'type', label: 'Type', title: 'Type of the resolved value (string, number, array, object, etc.)' },
        { name: 'structure', label: 'Structure', title: 'Human-readable description of the JSON structure' },
      ];

      html += '<div class="comp-node-body">';
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var jki = 0; jki < jkInputs.length; jki++) {
        var jkip = jkInputs[jki];
        var jkipId = node.id + ':in:' + jkip.name;
        var jkipConn = isPortConnected(node.id, jkip.name, 'input');
        html += '<div class="comp-port comp-port-in' + (jkipConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(jkipId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(jkip.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(jkip.title) + '">' + compEscHtml(jkip.label) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var jko = 0; jko < jkOutputs.length; jko++) {
        var jkop = jkOutputs[jko];
        var jkopId = node.id + ':out:' + jkop.name;
        var jkopConn = isPortConnected(node.id, jkop.name, 'output');
        html += '<div class="comp-port comp-port-out' + (jkopConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(jkopId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(jkop.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(jkop.title) + '">' + compEscHtml(jkop.label) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#a78bfa;font-size:0.6rem;">JSON Extract</span>';
      html += '</div>';

    } else if (isTool) {
      // ── Tool Node ──
      var toolCfg = node.toolNode || { selectedTool: '', paramDefaults: {} };
      var toolDef = getToolDef(toolCfg.selectedTool);
      // Fall back to cached schema if live tool def isn't available yet
      var toolSchema = (toolDef && toolDef.parameters) ? toolDef.parameters : (toolCfg.paramSchema || {});
      var toolProps = toolSchema.properties || {};
      var toolRequired = toolSchema.required || [];
      var toolParamNames = Object.keys(toolProps);

      html += '<div class="comp-node-body">';
      // Input ports — one per tool parameter
      html += '<div class="comp-node-ports comp-node-inputs">';
      if (toolParamNames.length === 0 && !toolCfg.selectedTool) {
        html += '<div class="comp-port comp-port-in" style="opacity:0.4;pointer-events:none;">';
        html += '<div class="comp-port-dot comp-port-dot-in" style="opacity:0.3;"></div>';
        html += '<span class="comp-port-label" style="color:#64748b;font-style:italic;">Select a tool...</span>';
        html += '</div>';
      }
      for (var tpi = 0; tpi < toolParamNames.length; tpi++) {
        var tpName = toolParamNames[tpi];
        var tpDef = toolProps[tpName];
        var tpReq = toolRequired.indexOf(tpName) >= 0;
        var tpPortId = node.id + ':in:' + tpName;
        var tpConn = isPortConnected(node.id, tpName, 'input');
        var tpTitle = (tpDef.description || tpName) + (tpReq ? ' (required)' : ' (optional)');
        html += '<div class="comp-port comp-port-in' + (tpConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(tpPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(tpName) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        var tpType = tpDef.type || 'string';
        html += '<span class="comp-port-label" title="' + compEscAttr(tpTitle) + '">' + compEscHtml(humanizeVarName(tpName)) + (tpReq ? '<span style="color:#f59e0b;margin-left:2px;">*</span>' : '') + ' <span class="comp-tool-port-type">' + compEscHtml(tpType) + '</span></span>';
        html += '</div>';
      }
      html += '</div>';
      // Output ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      var toolOuts = [
        { name: 'result', label: 'Result', type: 'object', title: 'Tool return value (parsed JSON object)' },
        { name: 'success', label: 'Success', type: 'boolean', title: 'Whether the tool succeeded (true/false)' },
      ];
      for (var toi = 0; toi < toolOuts.length; toi++) {
        var toOut = toolOuts[toi];
        var toPortId = node.id + ':out:' + toOut.name;
        var toConn = isPortConnected(node.id, toOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (toConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(toPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(toOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(toOut.title) + '">' + compEscHtml(toOut.label) + ' <span class="comp-tool-port-type">' + toOut.type + '</span></span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-tool-badge">TOOL</span>';
      if (toolCfg.selectedTool) {
        html += ' <span style="color:#94a3b8;font-size:0.58rem;">' + compEscHtml(toolCfg.selectedTool) + '</span>';
      }
      html += '</div>';

    } else if (isFileWrite) {
      // File Write node — inputs: filePath + content, outputs: filePath + success
      var fwCfg = node.fileWriteNode || { mode: 'overwrite', format: 'auto' };
      var fwInputs = [
        { name: 'filePath', label: 'File Path', type: 'string' },
        { name: 'content', label: 'Content', type: 'string | object' },
      ];
      var fwOutputs = [
        { name: 'filePath', label: 'File Path', type: 'string' },
        { name: 'success', label: 'Success', type: 'boolean' },
        { name: 'bytesWritten', label: 'Bytes Written', type: 'number' },
      ];
      html += '<div class="comp-node-body">';
      // Input ports
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var fwi = 0; fwi < fwInputs.length; fwi++) {
        var fwIn = fwInputs[fwi];
        var fwInId = node.id + ':in:' + fwIn.name;
        var fwInConn = isPortConnected(node.id, fwIn.name, 'input');
        html += '<div class="comp-port comp-port-in' + (fwInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(fwInId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(fwIn.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label">' + compEscHtml(fwIn.label) + ' <span class="comp-tool-port-type">' + fwIn.type + '</span></span>';
        html += '</div>';
      }
      html += '</div>';
      // Output ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var fwo = 0; fwo < fwOutputs.length; fwo++) {
        var fwOut = fwOutputs[fwo];
        var fwOutId = node.id + ':out:' + fwOut.name;
        var fwOutConn = isPortConnected(node.id, fwOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (fwOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(fwOutId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(fwOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label">' + compEscHtml(fwOut.label) + ' <span class="comp-tool-port-type">' + fwOut.type + '</span></span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#94a3b8;font-size:0.6rem;">' + compEscHtml(fwCfg.mode || 'overwrite') + ' &middot; ' + compEscHtml(fwCfg.format || 'auto') + '</span>';
      html += '</div>';

    } else if (isFileRead) {
      // File Read node — input: filePath, outputs: content + isJson + size + filePath
      var frCfg = node.fileReadNode || { parseMode: 'auto' };
      var frInputs = [
        { name: 'filePath', label: 'File Path', type: 'string' },
      ];
      var frOutputs = [
        { name: 'content', label: 'Content', type: 'string | object' },
        { name: 'isJson', label: 'Is JSON', type: 'boolean' },
        { name: 'size', label: 'Size (bytes)', type: 'number' },
        { name: 'filePath', label: 'File Path', type: 'string' },
      ];
      html += '<div class="comp-node-body">';
      // Input ports
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var fri = 0; fri < frInputs.length; fri++) {
        var frIn = frInputs[fri];
        var frInId = node.id + ':in:' + frIn.name;
        var frInConn = isPortConnected(node.id, frIn.name, 'input');
        html += '<div class="comp-port comp-port-in' + (frInConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(frInId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(frIn.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label">' + compEscHtml(frIn.label) + ' <span class="comp-tool-port-type">' + frIn.type + '</span></span>';
        html += '</div>';
      }
      html += '</div>';
      // Output ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var fro = 0; fro < frOutputs.length; fro++) {
        var frOut = frOutputs[fro];
        var frOutId = node.id + ':out:' + frOut.name;
        var frOutConn = isPortConnected(node.id, frOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (frOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(frOutId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(frOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label">' + compEscHtml(frOut.label) + ' <span class="comp-tool-port-type">' + frOut.type + '</span></span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-file-read-badge">READ</span>';
      html += ' <span style="color:#94a3b8;font-size:0.6rem;">' + compEscHtml(frCfg.parseMode || 'auto') + '</span>';
      html += '</div>';

    } else if (isJunction) {
      // Junction node — mirrored input/output ports for pass-through
      var juncCfg = node.junctionNode || { ports: [] };
      html += '<div class="comp-node-body">';
      // Input ports (left side)
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var ji = 0; ji < juncCfg.ports.length; ji++) {
        var jInp = juncCfg.ports[ji];
        var jInpId = node.id + ':in:' + jInp.name;
        var jInpConn = isPortConnected(node.id, jInp.name, 'input');
        html += '<div class="comp-port comp-port-in' + (jInpConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(jInpId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(jInp.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label">' + compEscHtml(humanizeVarName(jInp.name)) + '</span>';
        html += '</div>';
      }
      if (juncCfg.ports.length === 0) {
        html += '<div style="color:#475569;font-size:0.65rem;font-style:italic;padding:4px 8px;">No ports</div>';
      }
      html += '</div>';
      // Output ports (right side) — mirror the same ports
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var jo = 0; jo < juncCfg.ports.length; jo++) {
        var jOut = juncCfg.ports[jo];
        var jOutId = node.id + ':out:' + jOut.name;
        var jOutConn = isPortConnected(node.id, jOut.name, 'output');
        html += '<div class="comp-port comp-port-out' + (jOutConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(jOutId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(jOut.name) + '" data-port-dir="out">';
        html += '<span class="comp-port-label">' + compEscHtml(humanizeVarName(jOut.name)) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      if (juncCfg.ports.length === 0) {
        html += '<div style="color:#475569;font-size:0.65rem;font-style:italic;padding:4px 8px;">No ports</div>';
      }
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span class="comp-node-junction-badge">JUNCTION</span>';
      html += ' <span style="color:#64748b;font-size:0.6rem;">' + juncCfg.ports.length + ' port' + (juncCfg.ports.length !== 1 ? 's' : '') + '</span>';
      html += '</div>';

    } else {
      // Regular workflow node body with ports
      html += '<div class="comp-node-body">';

      // Inputs (left side) — "Receives"
      var inputs = wf ? (wf.variables || []) : [];
      html += '<div class="comp-node-ports comp-node-inputs">';
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j];
        var portId = node.id + ':in:' + inp.name;
        var isConnected = isPortConnected(node.id, inp.name, 'input');
        var inpTooltip = inp.description || inp.name;
        html += '<div class="comp-port comp-port-in' + (isConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(portId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(inp.name) + '" data-port-dir="in">';
        html += '<div class="comp-port-dot comp-port-dot-in"></div>';
        html += '<span class="comp-port-label" title="' + compEscAttr(inpTooltip) + '">' + compEscHtml(humanizeVarName(inp.name)) + '</span>';
        html += '</div>';
      }
      html += '</div>';

      // Outputs (right side) — "Produces"
      var outputs = wf ? (wf.outputVariables || []) : [];
      html += '<div class="comp-node-ports comp-node-outputs">';
      for (var k = 0; k < outputs.length; k++) {
        var out = outputs[k];
        var outPortId = node.id + ':out:' + out;
        var isOutConnected = isPortConnected(node.id, out, 'output');
        html += '<div class="comp-port comp-port-out' + (isOutConnected ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(outPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="' + compEscAttr(out) + '" data-port-dir="out">';
        html += '<span class="comp-port-label" title="' + compEscAttr(out) + '">' + compEscHtml(humanizeVarName(out)) + '</span>';
        html += '<div class="comp-port-dot comp-port-dot-out"></div>';
        html += '</div>';
      }
      html += '</div>';

      html += '</div>'; // .comp-node-body

      // Footer
      html += '<div class="comp-node-footer">';
      if (wf) {
        html += compEscHtml(wf.stepCount + ' steps');
      }
      html += '</div>';
    }

    // ── Universal flow-control ports (trigger/done) ──
    var triggerConn = isPortConnected(node.id, '__trigger__', 'input');
    var doneConn = isPortConnected(node.id, '__done__', 'output');
    html += '<div class="comp-node-flow-ports">';
    html += '<div class="comp-port comp-port-in comp-port-flow' + (triggerConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(node.id + ':in:__trigger__') + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="__trigger__" data-port-dir="in">';
    html += '<div class="comp-port-dot comp-port-dot-in comp-port-dot-flow"></div>';
    html += '<span class="comp-port-label comp-port-label-flow">Trigger</span>';
    html += '</div>';
    html += '<div class="comp-port comp-port-out comp-port-flow' + (doneConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(node.id + ':out:__done__') + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="__done__" data-port-dir="out">';
    html += '<span class="comp-port-label comp-port-label-flow">Done</span>';
    html += '<div class="comp-port-dot comp-port-dot-out comp-port-dot-flow"></div>';
    html += '</div>';
    html += '</div>';

    html += '</div>'; // .comp-node
  }

  layer.innerHTML = html;

  // Show/hide empty canvas guide (Step 4)
  var guide = document.querySelector('#comp-empty-guide');
  if (guide) {
    guide.style.display = (compData.nodes.length === 0) ? '' : 'none';
  }

  // Onboarding hint: if exactly 1 workflow with no connections, show pulsing hint on output ports
  var existingHints = document.querySelectorAll('.comp-onboard-hint');
  existingHints.forEach(function(h) { h.remove(); });
  if (compData.nodes.length === 1 && compData.edges.length === 0) {
    var outDots = document.querySelectorAll('.comp-port-dot-out');
    outDots.forEach(function(dot) {
      var hint = document.createElement('div');
      hint.className = 'comp-onboard-hint';
      hint.textContent = 'Drag to connect';
      dot.parentElement.appendChild(hint);
    });
  }

  // Disable output button when one already exists
  var outputBtn = document.querySelector('#comp-add-output');
  if (outputBtn) {
    var hasOutput = compData.nodes.some(function(n) { return n.workflowId === '__output__'; });
    outputBtn.disabled = hasOutput;
    outputBtn.title = hasOutput ? 'Pipeline already has an output node' : 'Add pipeline output node';
  }

  // Wire up image viewer resize handles
  document.querySelectorAll('.comp-image-viewer-resize-handle').forEach(function(handle) {
    handle.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      var resizeNodeId = handle.getAttribute('data-node-id');
      var resizeNode = compData.nodes.find(function(n) { return n.id === resizeNodeId; });
      if (!resizeNode || !resizeNode.imageViewer) return;

      var startX = e.clientX;
      var startY = e.clientY;
      var startW = resizeNode.imageViewer.width;
      var startH = resizeNode.imageViewer.height;
      var aspect = startW / startH;

      var nodeEl = handle.closest('.comp-node');
      var wrapEl = handle.closest('.comp-image-viewer-wrap');

      function onMouseMove(ev) {
        var dx = (ev.clientX - startX) / canvasState.zoom;
        var dy = (ev.clientY - startY) / canvasState.zoom;

        // Maintain aspect ratio — use the larger delta direction
        var newW = Math.max(150, Math.min(800, Math.round(startW + dx)));
        var newH = Math.round(newW / aspect);
        if (newH < 150) { newH = 150; newW = Math.round(newH * aspect); }
        if (newH > 800) { newH = 800; newW = Math.round(newH * aspect); }

        resizeNode.imageViewer.width = newW;
        resizeNode.imageViewer.height = newH;

        // Update inline styles directly for smooth resize
        if (nodeEl) nodeEl.style.width = (newW + 40) + 'px';
        if (wrapEl) wrapEl.style.height = newH + 'px';
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        renderNodes();
        renderEdges();
        wireUpCanvas();
        updatePropertiesPanel();
        immediateSave();
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });

  // ── Media node resize handles ──
  document.querySelectorAll('.comp-media-resize-handle').forEach(function(handle) {
    handle.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      var resizeNodeId = handle.getAttribute('data-node-id');
      var resizeNode = compData.nodes.find(function(n) { return n.id === resizeNodeId; });
      if (!resizeNode || !resizeNode.mediaPlayer) return;

      var startX = e.clientX;
      var startY = e.clientY;
      var startW = resizeNode.mediaPlayer.width;
      var startH = resizeNode.mediaPlayer.height;
      var aspect = startW / startH;
      var nodeEl = handle.closest('.comp-node');
      var wrapEl = handle.closest('.comp-media-wrap');

      function onMouseMove(ev) {
        var dx = (ev.clientX - startX) / canvasState.zoom;
        var newW = Math.max(150, Math.min(1200, Math.round(startW + dx)));
        var newH = Math.round(newW / aspect);
        if (newH < 100) { newH = 100; newW = Math.round(newH * aspect); }
        if (newH > 800) { newH = 800; newW = Math.round(newH * aspect); }
        resizeNode.mediaPlayer.width = newW;
        resizeNode.mediaPlayer.height = newH;
        if (nodeEl) nodeEl.style.width = (newW + 40) + 'px';
        if (wrapEl) wrapEl.style.height = newH + 'px';
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        renderNodes(); renderEdges(); wireUpCanvas();
        updatePropertiesPanel(); immediateSave();
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

function isPortConnected(nodeId, portName, direction) {
  if (!compData) return false;
  return compData.edges.some(function(e) {
    if (direction === 'input') return e.targetNodeId === nodeId && e.targetPort === portName;
    return e.sourceNodeId === nodeId && e.sourcePort === portName;
  });
}

// ── Edge Rendering ───────────────────────────────────────────

function edgePath(sx, sy, tx, ty) {
  var dx = Math.max(Math.abs(tx - sx) * 0.5, 50);
  return 'M' + sx + ',' + sy + ' C' + (sx + dx) + ',' + sy + ' ' + (tx - dx) + ',' + ty + ' ' + tx + ',' + ty;
}

function getPortPosition(nodeId, portName, direction) {
  var portEl = document.querySelector('.comp-port[data-node-id="' + nodeId + '"][data-port-name="' + portName + '"][data-port-dir="' + direction + '"] .comp-port-dot');
  if (!portEl) return null;

  var nodeEl = document.querySelector('.comp-node[data-node-id="' + nodeId + '"]');
  if (!nodeEl) return null;

  var nodeRect = nodeEl.getBoundingClientRect();
  var dotRect = portEl.getBoundingClientRect();
  var layer = document.querySelector('#comp-nodes-layer');
  var layerRect = layer.getBoundingClientRect();

  // Get position relative to the nodes layer (which has transform applied)
  var x = (dotRect.left + dotRect.width / 2 - layerRect.left) / canvasState.zoom;
  var y = (dotRect.top + dotRect.height / 2 - layerRect.top) / canvasState.zoom;

  return { x: x, y: y };
}

function renderEdges() {
  var group = document.querySelector('#comp-edges-group');
  if (!group || !compData) return;

  var html = '';

  for (var i = 0; i < compData.edges.length; i++) {
    var edge = compData.edges[i];
    var isSelected = selectedEdge === edge.id;

    var isFlowEdge = edge.sourcePort === '__done__' || edge.targetPort === '__trigger__';
    html += '<path class="comp-edge' + (isFlowEdge ? ' comp-edge-flow' : '') + (isSelected ? ' comp-edge-selected' : '') + '" data-edge-id="' + compEscAttr(edge.id) + '" d="" />';
    // Edge label — humanized variable name (skip for flow edges)
    if (!isFlowEdge) {
      html += '<text class="comp-edge-label" data-edge-id="' + compEscAttr(edge.id) + '" x="0" y="0">' + compEscHtml(humanizeVarName(edge.sourcePort)) + '</text>';
    }
  }

  // Temp edge for drag
  html += '<path class="comp-edge-temp" id="comp-edge-temp" d="" style="display:none;" />';

  group.innerHTML = html;

  // Compute edge positions after a frame (nodes need to be in DOM)
  requestAnimationFrame(function() { updateEdgePositions(); });
}

function updateEdgePositions() {
  if (!compData) return;

  for (var i = 0; i < compData.edges.length; i++) {
    var edge = compData.edges[i];
    var pathEl = document.querySelector('path.comp-edge[data-edge-id="' + edge.id + '"]');
    if (!pathEl) continue;

    var srcPos = getPortPosition(edge.sourceNodeId, edge.sourcePort, 'out');
    var tgtPos = getPortPosition(edge.targetNodeId, edge.targetPort, 'in');

    if (srcPos && tgtPos) {
      pathEl.setAttribute('d', edgePath(srcPos.x, srcPos.y, tgtPos.x, tgtPos.y));

      // Position edge label at midpoint
      var labelEl = document.querySelector('text.comp-edge-label[data-edge-id="' + edge.id + '"]');
      if (labelEl) {
        var mx = (srcPos.x + tgtPos.x) / 2;
        var my = (srcPos.y + tgtPos.y) / 2 - 8;
        labelEl.setAttribute('x', mx);
        labelEl.setAttribute('y', my);
      }
    }
  }
}

// ── Toolbar ──────────────────────────────────────────────────

function wireUpToolbar() {
  // ── Add Node dropdown ──
  var addDropdownToggle = document.querySelector('#comp-add-dropdown-toggle');
  var addDropdown = document.querySelector('#comp-add-dropdown');
  if (addDropdownToggle && addDropdown) {
    addDropdownToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = addDropdown.style.display !== 'none';
      addDropdown.style.display = isOpen ? 'none' : '';
    });
    // Close on outside click
    document.addEventListener('click', function(e) {
      if (addDropdown.style.display !== 'none' && !addDropdown.contains(e.target) && e.target !== addDropdownToggle) {
        addDropdown.style.display = 'none';
      }
    });
    // Wire each dropdown item — close dropdown after action
    var dropdownActions = {
      'comp-add-node': function() { showAddNodeDropdown(); },
      'comp-add-gate': function() { addApprovalGateNode(); },
      'comp-add-script': function() { showAddScriptModal(); },
      'comp-add-output': function() { addOutputNode(); },
      'comp-add-image-viewer': function() { addImageViewerNode(); },
      'comp-add-media': function() { addMediaNode(); },
      'comp-add-branch': function() { addBranchNode(); },
      'comp-add-delay': function() { addDelayNode(); },
      'comp-add-gate-node': function() { addGateNode(); },
      'comp-add-loop': function() { addForEachNode(); },
      'comp-add-switch': function() { addSwitchNode(); },
      'comp-add-asset': function() { addAssetNode(); },
      'comp-add-text': function() { addTextNode(); },
      'comp-add-variable': function() { addVariableNode(); },
      'comp-add-get-variable': function() { addGetVariableNode(); },
      'comp-add-file-op': function() { addFileOpNode(); },
      'comp-add-json-keys': function() { addJsonKeysNode(); },
      'comp-add-tool': function() { addToolNode(); },
      'comp-add-file-write': function() { addFileWriteNode(); },
      'comp-add-file-read': function() { addFileReadNode(); },
      'comp-add-junction': function() { addJunctionNode(); },
    };
    Object.keys(dropdownActions).forEach(function(id) {
      var btn = document.querySelector('#' + id);
      if (btn) {
        btn.addEventListener('click', function() {
          addDropdown.style.display = 'none';
          dropdownActions[id]();
        });
      }
    });
  }

  var deleteBtn = document.querySelector('#comp-delete-selected');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function() {
      deleteSelected();
    });
  }

  var fitBtn = document.querySelector('#comp-zoom-fit');
  if (fitBtn) {
    fitBtn.addEventListener('click', function() {
      fitToView();
    });
  }

  // Rename via double-click on title
  var pipelineTitleEl = document.querySelector('#comp-pipeline-title');
  if (pipelineTitleEl) {
    pipelineTitleEl.addEventListener('dblclick', function() { startPipelineRename(); });
  }

  // Undo/Redo buttons
  var undoBtn = document.querySelector('#comp-undo-btn');
  if (undoBtn) { undoBtn.addEventListener('click', function() { undo(); }); }
  var redoBtn = document.querySelector('#comp-redo-btn');
  if (redoBtn) { redoBtn.addEventListener('click', function() { redo(); }); }

  // Generate Pipeline button
  var genPipelineBtn = document.querySelector('#comp-generate-pipeline');
  if (genPipelineBtn) { genPipelineBtn.addEventListener('click', function() { showGeneratePipelineModal(); }); }

  // Auto-layout button
  var layoutBtn = document.querySelector('#comp-auto-layout');
  if (layoutBtn) { layoutBtn.addEventListener('click', function() { autoLayoutNodes(); }); }

  // Snap-to-grid toggle
  var snapBtn = document.querySelector('#comp-snap-toggle');
  if (snapBtn) {
    if (snapToGrid) snapBtn.classList.add('comp-tb-btn-active');
    snapBtn.addEventListener('click', function() {
      snapToGrid = !snapToGrid;
      snapBtn.classList.toggle('comp-tb-btn-active', snapToGrid);
    });
  }

  // Run/Cancel buttons
  var openFormBtn = document.querySelector('#comp-open-form-btn');
  if (openFormBtn) {
    openFormBtn.addEventListener('click', function() {
      if (!compData) return;
      if (typeof updateHash === 'function') updateHash('compositions', compData.id, 'form');
      selectComposition(compData.id, 'form');
    });
  }
  var shareFormBtn = document.querySelector('#comp-share-form-btn');
  if (shareFormBtn) { shareFormBtn.addEventListener('click', function() { copyCompositionFormShareLink(); }); }
  var runBtn = document.querySelector('#comp-run-btn');
  if (runBtn) { runBtn.addEventListener('click', function() { showCompositionRunForm(); }); }
  var batchBtn = document.querySelector('#comp-batch-btn');
  if (batchBtn) { batchBtn.addEventListener('click', function() { showBatchConfigModal(); }); }
  var scheduleBtn = document.querySelector('#comp-schedule-btn');
  if (scheduleBtn) { scheduleBtn.addEventListener('click', function() { showScheduleModal(); }); }
  var deletePipelineBtn = document.querySelector('#comp-delete-pipeline-btn');
  if (deletePipelineBtn) { deletePipelineBtn.addEventListener('click', function() { deletePipeline(); }); }
  var cancelBtn = document.querySelector('#comp-cancel-btn');
  if (cancelBtn) { cancelBtn.addEventListener('click', function() { cancelCompositionRun(); }); }

  // "More" dropdown button
  var moreBtn = document.querySelector('#comp-more-btn');
  if (moreBtn) { moreBtn.addEventListener('click', function() { showMoreDropdown(); }); }

  // Properties panel close
  var propsClose = document.querySelector('#comp-props-close');
  if (propsClose) {
    propsClose.addEventListener('click', function() {
      selectedNodes.clear();
      selectedEdge = null; selectedEdges.clear();
      updateNodeSelection();
      updateEdgeSelection();
      updateDeleteButton();
      hidePropertiesPanel();
    });
  }
}

// ── "More" dropdown (Tools, Export, Import, Rename, Copy, Delete) ────────

var moreDropdownEl = null;

function hideMoreDropdown() {
  if (moreDropdownEl) {
    moreDropdownEl.remove();
    moreDropdownEl = null;
  }
  document.removeEventListener('click', onMoreDropdownOutsideClick, true);
}

function onMoreDropdownOutsideClick(e) {
  if (moreDropdownEl && !moreDropdownEl.contains(e.target) && e.target.id !== 'comp-more-btn') {
    hideMoreDropdown();
  }
}

function exportPipeline() {
  if (!compData) return;
  var blob = new Blob([JSON.stringify(compData, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = compData.id + '.composition.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Downloaded ' + compData.name, 'success');
}

function importPipeline() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async function() {
    var file = input.files[0];
    if (!file) return;
    try {
      var text = await file.text();
      var imported = JSON.parse(text);
      if (!imported.version || !imported.nodes || !imported.edges) {
        throw new Error('This doesn\'t look like a valid pipeline file');
      }
      var baseName = imported.name || 'Imported';
      var result = await createComposition(baseName + ' (Imported)', imported.description || '');
      imported.id = result.composition.id;
      imported.name = baseName + ' (Imported)';
      imported.metadata = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await saveComposition(imported);
      toast('Uploaded ' + imported.name, 'success');
      await fetchCompositions();
      selectComposition(imported.id);
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  });
  input.click();
}

async function duplicatePipeline() {
  if (!compData) return;
  try {
    var res = await fetch('/api/compositions/' + encodeURIComponent(compData.id) + '/duplicate', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Duplicate failed');
    toast('Copy created!', 'success');
    await fetchCompositions();
    selectComposition(data.composition.id);
  } catch (err) {
    toast('Duplicate failed: ' + err.message, 'error');
  }
}

async function deletePipeline() {
  if (!compData) return;
  if (!confirm('Delete pipeline "' + compData.name + '"? This cannot be undone.')) return;
  try {
    await deleteComposition(compData.id);
    toast('Pipeline deleted', 'success');
    compData = null;
    selectedComposition = null;
    await fetchCompositions();
    document.querySelector('#main').innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x1f517;</div>' +
      '<h2>Pipelines</h2><p>Select a pipeline or create a new one.</p></div>';
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

function showMoreDropdown() {
  if (moreDropdownEl) { hideMoreDropdown(); return; }

  var btn = document.querySelector('#comp-more-btn');
  if (!btn) return;
  var rect = btn.getBoundingClientRect();

  var items = [
    { label: 'Tools', icon: '&#x1f527;', action: function() { showToolDocsModal(); } },
    { separator: true },
    { label: 'Export', icon: '&#x2913;', action: function() { exportPipeline(); } },
    { label: 'Import', icon: '&#x2912;', action: function() { importPipeline(); } },
    { separator: true },
    { label: 'Rename', icon: '&#x270f;', action: function() { startPipelineRename(); } },
    { label: 'Copy', icon: '&#x2398;', action: function() { duplicatePipeline(); } },
    { label: 'Delete', icon: '&#x1f5d1;', danger: true, action: function() { deletePipeline(); } },
  ];

  var menu = document.createElement('div');
  menu.className = 'comp-more-dropdown';
  menu.style.position = 'fixed';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';

  var html = '';
  items.forEach(function(item, i) {
    if (item.separator) {
      html += '<div class="comp-ctx-separator"></div>';
    } else {
      html += '<div class="comp-ctx-item' + (item.danger ? ' comp-ctx-item-danger' : '') + '" data-idx="' + i + '">';
      html += '<span>' + item.icon + ' ' + compEscHtml(item.label) + '</span>';
      html += '</div>';
    }
  });
  menu.innerHTML = html;
  document.body.appendChild(menu);
  moreDropdownEl = menu;

  // Wire click handlers
  items.forEach(function(item, i) {
    if (item.separator) return;
    var el = menu.querySelector('[data-idx="' + i + '"]');
    if (el) {
      el.addEventListener('click', function() {
        hideMoreDropdown();
        item.action();
      });
    }
  });

  // Close on outside click (delayed so this click doesn't immediately close it)
  setTimeout(function() {
    document.addEventListener('click', onMoreDropdownOutsideClick, true);
  }, 0);
}

async function showAddNodeDropdown() {
  // Remove existing dropdown
  var existing = document.querySelector('.comp-node-dropdown');
  if (existing) { existing.remove(); return; }

  // Always fetch fresh workflows so new ones appear immediately
  await fetchWorkflowsForNodes();

  // Also re-render existing nodes/edges in case workflow data changed (new variables/outputs)
  if (compData) {
    renderNodes();
    renderEdges();
    wireUpCanvas();
  }

  var btn = document.querySelector('#comp-add-node');
  var rect = btn.getBoundingClientRect();

  var dropdown = document.createElement('div');
  dropdown.className = 'comp-node-dropdown';
  dropdown.style.position = 'fixed';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.top = (rect.bottom + 4) + 'px';
  dropdown.style.zIndex = '10000';

  var searchHtml = '<div class="comp-dd-search-wrap">' +
    '<input type="text" class="comp-dd-search" id="comp-dd-search-input" placeholder="Search workflows..." autofocus>' +
    '</div>';

  // Fetch available compositions to show as pipeline-as-node options
  var availableComps = [];
  try {
    var compListResp = await fetch('/api/compositions');
    var compListData = await compListResp.json();
    if (compListData.compositions) {
      availableComps = compListData.compositions.filter(function(c) {
        return !compData || c.id !== compData.id; // Exclude current composition
      });
    }
  } catch (e) { /* ignore */ }

  var itemsHtml = '';

  if (workflowCache.length === 0 && availableComps.length === 0) {
    itemsHtml = '<div class="comp-dd-empty">No workflows available. Create a workflow first.</div>';
  } else {
    // Workflows section
    if (workflowCache.length > 0) {
      itemsHtml += '<div style="color:#64748b;font-size:0.65rem;padding:4px 8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Workflows</div>';
      itemsHtml += workflowCache.map(function(wf) {
        var descHtml = wf.description ? '<span class="comp-dd-desc">' + compEscHtml(wf.description) + '</span>' : '';
        return '<div class="comp-dd-item" data-wf-id="' + compEscAttr(wf.id) + '" data-wf-name="' + compEscAttr(wf.name) + '">' +
          '<span class="comp-dd-name">' + compEscHtml(wf.name) + '</span>' +
          descHtml +
          '<span class="comp-dd-meta">' + wf.variableCount + ' inputs &middot; ' + (wf.outputVariables || []).length + ' outputs</span>' +
        '</div>';
      }).join('');
    }

    // Pipelines section
    if (availableComps.length > 0) {
      itemsHtml += '<div style="color:#06b6d4;font-size:0.65rem;padding:4px 8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-top:1px solid #1e293b;margin-top:4px;">Pipelines</div>';
      itemsHtml += availableComps.map(function(c) {
        return '<div class="comp-dd-item comp-dd-item-pipeline" data-comp-id="' + compEscAttr(c.id) + '" data-wf-name="' + compEscAttr(c.name) + '">' +
          '<span class="comp-dd-name" style="color:#06b6d4;">&#x1f517; ' + compEscHtml(c.name) + '</span>' +
          '<span class="comp-dd-meta">' + (c.nodes ? c.nodes.length : 0) + ' nodes</span>' +
        '</div>';
      }).join('');
    }
  }

  dropdown.innerHTML = searchHtml + itemsHtml;

  document.body.appendChild(dropdown);

  // Wire up search filtering
  var searchInput = dropdown.querySelector('#comp-dd-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase().trim();
      dropdown.querySelectorAll('.comp-dd-item').forEach(function(item) {
        var name = item.dataset.wfName || '';
        item.style.display = (!q || name.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
    });
    requestAnimationFrame(function() { searchInput.focus(); });
  }

  // Click handlers — workflow items
  dropdown.querySelectorAll('.comp-dd-item:not(.comp-dd-item-pipeline)').forEach(function(item) {
    item.addEventListener('click', function() {
      addWorkflowNode(item.dataset.wfId);
      dropdown.remove();
    });
  });

  // Click handlers — pipeline items
  dropdown.querySelectorAll('.comp-dd-item-pipeline').forEach(function(item) {
    item.addEventListener('click', function() {
      addCompositionNode(item.dataset.compId);
      dropdown.remove();
    });
  });

  // Close on click outside
  setTimeout(function() {
    function closeDropdown(e) {
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        document.removeEventListener('click', closeDropdown);
      }
    }
    document.addEventListener('click', closeDropdown);
  }, 10);
}

function addWorkflowNode(workflowId) {
  if (!compData) return;
  pushUndoSnapshot();

  var vc = getViewportCenter();

  var node = {
    id: genId('node'),
    workflowId: workflowId,
    position: { x: vc.x, y: vc.y },
  };

  compData.nodes.push(node);
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  fetchCompositions(); // Update sidebar counts
}

// ── Composition-as-Node (pipeline-as-node) ─────────────────

var compositionInterfaceCache = {};

function reconcileCompositionNodePorts(compositionId, iface) {
  if (!compData || !iface) return false;

  var inputNames = (iface.inputs || []).map(function(input) { return String(input.name || '').trim(); }).filter(Boolean);
  var outputNames = (iface.outputs || []).map(function(output) { return String(output.name || '').trim(); }).filter(Boolean);
  var inputSet = {};
  var outputSet = {};
  var inputLowerMap = {};
  var outputLowerMap = {};

  inputNames.forEach(function(name) {
    inputSet[name] = true;
    var lower = name.toLowerCase();
    if (!inputLowerMap[lower]) inputLowerMap[lower] = [];
    inputLowerMap[lower].push(name);
  });
  outputNames.forEach(function(name) {
    outputSet[name] = true;
    var lower = name.toLowerCase();
    if (!outputLowerMap[lower]) outputLowerMap[lower] = [];
    outputLowerMap[lower].push(name);
  });

  var changed = false;
  compData.nodes.forEach(function(node) {
    if (!node || !node.workflowId || !node.workflowId.startsWith('comp:')) return;
    var refId = (node.compositionRef && node.compositionRef.compositionId) || node.workflowId.slice(5);
    if (refId !== compositionId) return;

    compData.edges.forEach(function(edge) {
      if (edge.targetNodeId === node.id && typeof edge.targetPort === 'string' && !inputSet[edge.targetPort]) {
        var targetMatches = inputLowerMap[edge.targetPort.toLowerCase()] || [];
        if (targetMatches.length === 1) {
          edge.targetPort = targetMatches[0];
          changed = true;
        }
      }
      if (edge.sourceNodeId === node.id && typeof edge.sourcePort === 'string' && !outputSet[edge.sourcePort]) {
        var sourceMatches = outputLowerMap[edge.sourcePort.toLowerCase()] || [];
        if (sourceMatches.length === 1) {
          edge.sourcePort = sourceMatches[0];
          changed = true;
        }
      }
    });
  });

  return changed;
}

async function fetchCompositionInterface(compositionId) {
  // Check cache first (invalidated every 30 seconds)
  var cached = compositionInterfaceCache[compositionId];
  if (cached && (Date.now() - cached.ts < 30000)) {
    return cached.data;
  }
  try {
    var resp = await fetch('/api/compositions/' + encodeURIComponent(compositionId) + '/interface');
    var data = await resp.json();
    compositionInterfaceCache[compositionId] = { data: data, ts: Date.now() };
    if (reconcileCompositionNodePorts(compositionId, data)) {
      renderNodes();
      renderEdges();
      wireUpCanvas();
      debouncedSave();
    }
    return data;
  } catch (e) {
    return { inputs: [], outputs: [] };
  }
}

async function addCompositionNode(compositionId) {
  if (!compData) return;

  // Cycle check: cannot add self
  if (compData.id === compositionId) {
    showToast('Cannot add a pipeline inside itself', 'error');
    return;
  }

  // Cycle detection: check if the target composition (transitively) contains current composition
  if (await detectCompositionCycle(compData.id, compositionId)) {
    showToast('Cannot add — would create a circular pipeline reference', 'error');
    return;
  }

  pushUndoSnapshot();

  var vc = getViewportCenter();

  // Get composition name
  var compName = compositionId;
  try {
    var compResp = await fetch('/api/compositions/' + encodeURIComponent(compositionId));
    var compData2 = await compResp.json();
    if (compData2.composition) compName = compData2.composition.name;
  } catch (e) { /* use ID as fallback */ }

  var node = {
    id: genId('comp'),
    workflowId: 'comp:' + compositionId,
    position: { x: vc.x, y: vc.y },
    label: compName,
    compositionRef: { compositionId: compositionId },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

async function detectCompositionCycle(currentCompId, targetCompId, visited) {
  if (!visited) visited = new Set();
  if (visited.has(targetCompId)) return false;
  visited.add(targetCompId);

  // Cap depth
  if (visited.size > 10) return false;

  try {
    var resp = await fetch('/api/compositions/' + encodeURIComponent(targetCompId));
    var data = await resp.json();
    if (!data.composition) return false;

    var nodes = data.composition.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.workflowId && n.workflowId.startsWith('comp:')) {
        var refId = n.workflowId.slice(5);
        if (refId === currentCompId) return true; // Direct cycle
        if (await detectCompositionCycle(currentCompId, refId, visited)) return true;
      }
    }
  } catch (e) { /* ignore */ }

  return false;
}

function addApprovalGateNode() {
  if (!compData) return;
  pushUndoSnapshot();

  var vc = getViewportCenter();

  var node = {
    id: genId('gate'),
    workflowId: '__approval_gate__',
    position: { x: vc.x, y: vc.y },
    label: 'Approval Gate',
    approvalGate: {
      message: 'Please review the output and approve to continue.',
      previewVariables: [],
      timeoutMs: 0,
      onReject: 'stop',
    },
  };

  compData.nodes.push(node);
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  fetchCompositions();
}

function showAddScriptModal() {
  // Remove any existing overlay
  var existing = document.querySelector('#comp-script-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'comp-script-overlay';
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal comp-script-modal">' +
      '<div class="comp-modal-header">' +
        '<span>&#x192; New Script Node</span>' +
        '<button class="comp-modal-close" id="comp-script-close">&times;</button>' +
      '</div>' +
      '<div class="comp-modal-body">' +
        '<p style="color:#94a3b8;font-size:0.78rem;margin:0 0 0.75rem 0;">Describe what this script should do in plain English. An AI agent will generate the code and define inputs/outputs automatically.</p>' +
        '<textarea id="comp-script-desc" class="comp-props-input comp-gate-textarea" style="min-height:80px;" placeholder="e.g. Generate lo-fi hip hop lyrics based on a theme and mood. Output the lyrics and a song title."></textarea>' +
        '<div style="display:flex;gap:0.5rem;margin-top:1rem;">' +
          '<button class="comp-tb-btn comp-tb-btn-run" id="comp-script-generate" style="flex:1;">Generate Script</button>' +
          '<button class="comp-tb-btn" id="comp-script-cancel" style="flex:0;">Cancel</button>' +
        '</div>' +
        '<div id="comp-script-status" style="margin-top:0.75rem;display:none;">' +
          '<div class="spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:middle;"></div>' +
          '<span style="color:#94a3b8;font-size:0.75rem;">Generating script...</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('#comp-script-close').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('#comp-script-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Generate handler
  overlay.querySelector('#comp-script-generate').addEventListener('click', async function() {
    var desc = overlay.querySelector('#comp-script-desc').value.trim();
    if (!desc) { toast('Please describe what the script should do', 'error'); return; }

    var genBtn = overlay.querySelector('#comp-script-generate');
    var statusEl = overlay.querySelector('#comp-script-status');
    genBtn.disabled = true;
    statusEl.style.display = '';

    try {
      var res = await fetch('/api/compositions/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');

      // Create the script node
      addScriptNode(desc, data.code, data.inputs, data.outputs, [
        { role: 'user', content: desc },
        { role: 'assistant', content: data.assistantMessage },
      ]);

      overlay.remove();
      toast('Script node created!', 'success');
    } catch (err) {
      toast('Failed to generate script: ' + err.message, 'error');
      genBtn.disabled = false;
      statusEl.style.display = 'none';
    }
  });

  // Focus the textarea
  requestAnimationFrame(function() {
    var ta = overlay.querySelector('#comp-script-desc');
    if (ta) ta.focus();
  });
}

function showDataAwareScriptModal(srcNodeId, srcPortName, portValue, dropX, dropY) {
  // Remove any existing overlay
  var existing = document.querySelector('#comp-data-script-overlay');
  if (existing) existing.remove();

  var truncated = truncateForContext(portValue, 2000);
  var hasData = truncated !== null;

  // Build data preview HTML
  var dataPreviewHtml = '';
  if (hasData) {
    var escaped = String(truncated)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    dataPreviewHtml =
      '<div class="comp-data-preview-section">' +
        '<div class="comp-data-preview-label">Data from <strong>' + srcPortName.replace(/_/g, ' ') + '</strong></div>' +
        '<pre class="comp-data-preview-box">' + escaped + '</pre>' +
      '</div>';
  } else {
    dataPreviewHtml =
      '<div class="comp-data-preview-section">' +
        '<div class="comp-data-preview-empty">' +
          '<span style="color:#64748b;">&#x24D8;</span> Run the pipeline first to include data context. ' +
          'You can still generate a script without data.' +
        '</div>' +
      '</div>';
  }

  var overlay = document.createElement('div');
  overlay.id = 'comp-data-script-overlay';
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal comp-script-modal" style="max-width:560px;">' +
      '<div class="comp-modal-header">' +
        '<span>&#x2728; Generate Script from Data</span>' +
        '<button class="comp-modal-close" id="comp-data-script-close">&times;</button>' +
      '</div>' +
      '<div class="comp-modal-body">' +
        dataPreviewHtml +
        '<p style="color:#94a3b8;font-size:0.78rem;margin:0.75rem 0 0.5rem 0;">Describe what you want to do with this data. Mention any additional parameters you need (e.g. a key, index, or filter) — each will become its own input port.</p>' +
        '<textarea id="comp-data-script-desc" class="comp-props-input comp-gate-textarea" style="min-height:80px;" placeholder="e.g. Return data.categories[key] — I need a key input to select which category"></textarea>' +
        '<div style="display:flex;gap:0.5rem;margin-top:1rem;">' +
          '<button class="comp-tb-btn comp-tb-btn-run" id="comp-data-script-generate" style="flex:1;">Generate Script</button>' +
          '<button class="comp-tb-btn" id="comp-data-script-cancel" style="flex:0;">Cancel</button>' +
        '</div>' +
        '<div id="comp-data-script-status" style="margin-top:0.75rem;display:none;">' +
          '<div class="spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:middle;"></div>' +
          '<span style="color:#94a3b8;font-size:0.75rem;">Generating script...</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('#comp-data-script-close').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('#comp-data-script-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Generate handler
  overlay.querySelector('#comp-data-script-generate').addEventListener('click', async function() {
    var desc = overlay.querySelector('#comp-data-script-desc').value.trim();
    if (!desc) { toast('Please describe what the script should do', 'error'); return; }

    var genBtn = overlay.querySelector('#comp-data-script-generate');
    var statusEl = overlay.querySelector('#comp-data-script-status');
    genBtn.disabled = true;
    statusEl.style.display = '';

    try {
      var payload = { description: desc };
      if (hasData) {
        payload.dataContext = truncated;
      }

      var res = await fetch('/api/compositions/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');

      // Create the script node at the drop position
      addScriptNodeAt(desc, data.code, data.inputs, data.outputs, [
        { role: 'user', content: desc },
        { role: 'assistant', content: data.assistantMessage },
      ], dropX, dropY);

      // Auto-connect: find the first input port of the new node and create an edge
      var newNode = compData.nodes[compData.nodes.length - 1];
      if (newNode && newNode.script && newNode.script.inputs && newNode.script.inputs.length > 0) {
        var firstInput = newNode.script.inputs[0].name;
        var edge = {
          id: genId('edge'),
          sourceNodeId: srcNodeId,
          sourcePort: srcPortName,
          targetNodeId: newNode.id,
          targetPort: firstInput,
        };
        compData.edges.push(edge);
        renderEdges();
        immediateSave();
      }

      overlay.remove();
      toast('Script node created and connected!', 'success');
    } catch (err) {
      toast('Failed to generate script: ' + err.message, 'error');
      genBtn.disabled = false;
      statusEl.style.display = 'none';
    }
  });

  // Focus the textarea
  requestAnimationFrame(function() {
    var ta = overlay.querySelector('#comp-data-script-desc');
    if (ta) ta.focus();
  });
}

/** Return the canvas-coordinate center of the visible viewport. */
function getViewportCenter() {
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  // Small random jitter (±40px) so stacked adds don't overlap exactly
  var jx = Math.round((Math.random() - 0.5) * 80);
  var jy = Math.round((Math.random() - 0.5) * 80);
  return { x: Math.round(cx + jx), y: Math.round(cy + jy) };
}

function addScriptNodeAt(description, code, inputs, outputs, chatHistory, posX, posY) {
  if (!compData) return;
  pushUndoSnapshot();

  var node = {
    id: genId('script'),
    workflowId: '__script__',
    position: { x: Math.round(posX), y: Math.round(posY) },
    label: description
      ? description.split(/\s+/).slice(0, 4).map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ')
      : 'Script',
    script: {
      description: description,
      code: code,
      inputs: inputs || [],
      outputs: outputs || [],
      chatHistory: chatHistory || [],
    },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function addScriptNode(description, code, inputs, outputs, chatHistory) {
  if (!compData) return;
  pushUndoSnapshot();

  var vc = getViewportCenter();

  var node = {
    id: genId('script'),
    workflowId: '__script__',
    position: { x: vc.x, y: vc.y },
    label: description
      ? description.split(/\s+/).slice(0, 4).map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ')
      : 'Script',
    script: {
      description: description,
      code: code,
      inputs: inputs || [],
      outputs: outputs || [],
      chatHistory: chatHistory || [],
    },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function showGeneratePipelineModal() {
  var existing = document.querySelector('#comp-pipeline-gen-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'comp-pipeline-gen-overlay';
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal comp-script-modal">' +
      '<div class="comp-modal-header">' +
        '<span>&#x2728; Generate Pipeline</span>' +
        '<button class="comp-modal-close" id="comp-pipeline-gen-close">&times;</button>' +
      '</div>' +
      '<div class="comp-modal-body">' +
        '<p style="color:#94a3b8;font-size:0.78rem;margin:0 0 0.75rem 0;">' +
          'Describe a multi-step task. The AI will decompose it into connected pipeline nodes — each with simple, focused code.' +
        '</p>' +
        '<textarea id="comp-pipeline-gen-desc" class="comp-props-input comp-gate-textarea" style="min-height:100px;" ' +
          'placeholder="e.g. Take a photo from the asset library, generate a cartoon version with nanobanana, then copy the result to ~/Gallery/cartoons"></textarea>' +
        '<div style="display:flex;gap:0.5rem;margin-top:1rem;">' +
          '<button class="comp-tb-btn comp-tb-btn-run" id="comp-pipeline-gen-go" style="flex:1;">Generate Pipeline</button>' +
          '<button class="comp-tb-btn" id="comp-pipeline-gen-cancel" style="flex:0;">Cancel</button>' +
        '</div>' +
        '<div id="comp-pipeline-gen-status" style="margin-top:0.75rem;display:none;">' +
          '<div class="spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:middle;"></div>' +
          '<span style="color:#94a3b8;font-size:0.75rem;">Decomposing into pipeline steps...</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  overlay.querySelector('#comp-pipeline-gen-close').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('#comp-pipeline-gen-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#comp-pipeline-gen-go').addEventListener('click', async function() {
    var desc = overlay.querySelector('#comp-pipeline-gen-desc').value.trim();
    if (!desc) { toast('Please describe the pipeline you want to create', 'error'); return; }

    var genBtn = overlay.querySelector('#comp-pipeline-gen-go');
    var statusEl = overlay.querySelector('#comp-pipeline-gen-status');
    genBtn.disabled = true;
    statusEl.style.display = '';

    try {
      var res = await fetch('/api/compositions/generate-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Pipeline generation failed');

      addGeneratedPipeline(data.nodes, data.edges, data.name);

      overlay.remove();
      toast('Pipeline generated with ' + data.nodes.length + ' nodes!', 'success');
    } catch (err) {
      toast('Failed to generate pipeline: ' + err.message, 'error');
      genBtn.disabled = false;
      statusEl.style.display = 'none';
    }
  });

  requestAnimationFrame(function() {
    var ta = overlay.querySelector('#comp-pipeline-gen-desc');
    if (ta) ta.focus();
  });
}

function addGeneratedPipeline(nodes, edges, pipelineName) {
  if (!compData) return;
  pushUndoSnapshot();

  // Add all nodes
  for (var i = 0; i < nodes.length; i++) {
    compData.nodes.push(nodes[i]);
  }

  // Add all edges
  for (var j = 0; j < edges.length; j++) {
    compData.edges.push(edges[j]);
  }

  // Auto-layout to position the new nodes
  layoutNodesInternal();

  // Select all new nodes
  selectedNodes.clear();
  for (var k = 0; k < nodes.length; k++) {
    selectedNodes.add(nodes[k].id);
  }
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function addOutputNode() {
  if (!compData) return;

  // Enforce single output node per pipeline
  var existing = compData.nodes.find(function(n) { return n.workflowId === '__output__'; });
  if (existing) {
    showToast('This pipeline already has an output node', 'error');
    return;
  }

  pushUndoSnapshot();

  var vc = getViewportCenter();

  var node = {
    id: genId('output'),
    workflowId: '__output__',
    position: { x: vc.x, y: vc.y },
    label: 'Pipeline Output',
    outputNode: {
      ports: [],
    },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function addImageViewerNode() {
  if (!compData) return;
  pushUndoSnapshot();

  var vc = getViewportCenter();

  var node = {
    id: genId('imgview'),
    workflowId: '__image_viewer__',
    position: { x: vc.x, y: vc.y },
    label: 'Image Viewer',
    imageViewer: {
      filePath: '',
      width: 300,
      height: 300,
    },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function addMediaNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('media'),
    workflowId: '__media__',
    position: { x: vc.x, y: vc.y },
    label: 'Media Player',
    mediaPlayer: {
      sourceMode: 'file_path',
      filePath: '',
      url: '',
      assetId: '',
      mediaType: 'auto',
      width: 320,
      height: 240,
      title: '',
      autoPlay: false,
      defaultVolume: 1,
      loop: false,
      playbackRate: 1,
      imageFit: 'contain',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function detectMediaTypeFromExt(filePath, configType) {
  if (configType && configType !== 'auto') return configType;
  if (!filePath || typeof filePath !== 'string') return 'auto';
  var ext = (filePath.split('.').pop() || '').toLowerCase().split('?')[0];
  if (['jpg','jpeg','png','gif','bmp','svg','webp','tiff','ico'].indexOf(ext) !== -1) return 'image';
  if (['mp4','mov','avi','webm','mkv','m4v','ogv'].indexOf(ext) !== -1) return 'video';
  if (['mp3','wav','ogg','aac','flac','m4a','wma'].indexOf(ext) !== -1) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['json','csv','txt','md','js','ts','py','html','css','yaml','yml','xml','log','sh','bat','ini','toml','sql','rb','go','rs','java','c','cpp','h'].indexOf(ext) !== -1) return 'text';
  return 'auto';
}

function addBranchNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('branch'),
    workflowId: '__branch__',
    position: { x: vc.x, y: vc.y },
    label: 'Branch',
    branchNode: { condition: '{{value}} > 0' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addDelayNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('delay'),
    workflowId: '__delay__',
    position: { x: vc.x, y: vc.y },
    label: 'Delay',
    delayNode: { delayMs: 1000 },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addGateNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('cgate'),
    workflowId: '__gate__',
    position: { x: vc.x, y: vc.y },
    label: 'Gate',
    gateNode: { defaultOpen: true, onClosed: 'skip' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addForEachNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('foreach'),
    workflowId: '__for_each__',
    position: { x: vc.x, y: vc.y },
    label: 'ForEach Loop',
    forEachNode: { itemVariable: 'item', maxIterations: 100 },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addSwitchNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('switch'),
    workflowId: '__switch__',
    position: { x: vc.x, y: vc.y },
    label: 'Switch',
    switchNode: {
      cases: [
        { value: 'a', port: 'on_a' },
        { value: 'b', port: 'on_b' },
      ],
      defaultPort: 'on_default',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addAssetNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('asset'),
    workflowId: '__asset__',
    position: { x: vc.x, y: vc.y },
    label: 'Asset',
    asset: {
      mode: 'pick',
      collectionSlug: '',
      assetId: '',
      category: '',
      tags: '',
      defaultName: '',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addTextNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('text'),
    workflowId: '__text__',
    position: { x: vc.x, y: vc.y },
    label: 'Text',
    textNode: {
      value: '',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addVariableNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('var'),
    workflowId: '__variable__',
    position: { x: vc.x, y: vc.y },
    label: 'Variable',
    variableNode: {
      type: 'string',
      initialValue: '',
      exposeAsInput: false,
      inputName: '',
      description: '',
      required: false,
      generationPrompt: '',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addGetVariableNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('getvar'),
    workflowId: '__get_variable__',
    position: { x: vc.x, y: vc.y },
    label: 'Get Variable',
    getVariableNode: {
      targetNodeId: '',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addFileOpNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('fileop'),
    workflowId: '__file_op__',
    position: { x: vc.x, y: vc.y },
    label: 'Copy File',
    fileOp: {
      operation: 'copy',
    },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addJsonKeysNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('jsonkeys'),
    workflowId: '__json_keys__',
    position: { x: vc.x, y: vc.y },
    label: 'JSON Extract',
    jsonKeysNode: { defaultPath: '' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addFileReadNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('fread'),
    workflowId: '__file_read__',
    position: { x: vc.x, y: vc.y },
    label: 'Read File',
    fileReadNode: { parseMode: 'auto' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addJunctionNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('junction'),
    workflowId: '__junction__',
    position: { x: vc.x, y: vc.y },
    label: 'Junction',
    junctionNode: { ports: [] },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function createJunctionFromSelectedEdges() {
  if (!compData || selectedEdges.size === 0) return;
  pushUndoSnapshot();

  // 1. Collect the selected edges
  var edgesToMerge = compData.edges.filter(function(e) {
    return selectedEdges.has(e.id);
  });
  if (edgesToMerge.length === 0) return;

  // 2. Compute junction position (average midpoint of all selected edges)
  var totalX = 0, totalY = 0, count = 0;
  edgesToMerge.forEach(function(edge) {
    var srcNode = compData.nodes.find(function(n) { return n.id === edge.sourceNodeId; });
    var tgtNode = compData.nodes.find(function(n) { return n.id === edge.targetNodeId; });
    if (srcNode && tgtNode) {
      totalX += (srcNode.position.x + tgtNode.position.x) / 2;
      totalY += (srcNode.position.y + tgtNode.position.y) / 2;
      count++;
    }
  });
  var jx = count > 0 ? Math.round(totalX / count) : 400;
  var jy = count > 0 ? Math.round(totalY / count) : 300;

  // 3. Build port list with deduplication
  var portNameCounts = {};
  var ports = [];
  edgesToMerge.forEach(function(edge) {
    var isFlow = edge.sourcePort === '__done__' || edge.targetPort === '__trigger__';
    var baseName = isFlow ? '__flow__' : edge.sourcePort;
    if (!portNameCounts[baseName]) {
      portNameCounts[baseName] = 0;
    }
    portNameCounts[baseName]++;
    var portName = portNameCounts[baseName] > 1
      ? baseName + '_' + portNameCounts[baseName]
      : baseName;
    ports.push({
      name: portName,
      type: 'string',
      description: '',
      _origEdge: edge,
      _isFlow: isFlow,
    });
  });

  // 4. Create junction node
  var junctionNode = {
    id: genId('junction'),
    workflowId: '__junction__',
    position: { x: jx, y: jy },
    label: 'Junction',
    junctionNode: {
      ports: ports.map(function(p) {
        return { name: p.name, type: p.type, description: p.description };
      }),
    },
  };
  compData.nodes.push(junctionNode);

  // 5. Replace each original edge with two edges: source->junction, junction->target
  var newEdges = [];
  ports.forEach(function(p) {
    var orig = p._origEdge;
    // Edge 1: source -> junction input
    newEdges.push({
      id: genId('edge'),
      sourceNodeId: orig.sourceNodeId,
      sourcePort: orig.sourcePort,
      targetNodeId: junctionNode.id,
      targetPort: p.name,
    });
    // Edge 2: junction output -> target
    newEdges.push({
      id: genId('edge'),
      sourceNodeId: junctionNode.id,
      sourcePort: p.name,
      targetNodeId: orig.targetNodeId,
      targetPort: orig.targetPort,
    });
  });

  // 6. Remove original edges, add new ones
  compData.edges = compData.edges.filter(function(e) {
    return !selectedEdges.has(e.id);
  });
  compData.edges = compData.edges.concat(newEdges);

  // 7. Select the new junction node
  selectedEdges.clear();
  selectedEdge = null;
  selectedNodes.clear();
  selectedNodes.add(junctionNode.id);

  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateEdgeSelection();
  updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addToolNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('tool'),
    workflowId: '__tool__',
    position: { x: vc.x, y: vc.y },
    label: 'Tool',
    toolNode: { selectedTool: '', paramDefaults: {} },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addFileWriteNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var vc = getViewportCenter();
  var node = {
    id: genId('fwrite'),
    workflowId: '__file_write__',
    position: { x: vc.x, y: vc.y },
    label: 'Write File',
    fileWriteNode: { mode: 'overwrite', format: 'auto', prettyPrint: true },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null; selectedEdges.clear();
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function deleteSelected() {
  if (!compData) return;
  pushUndoSnapshot();

  if (selectedEdges.size > 0) {
    compData.edges = compData.edges.filter(function(e) { return !selectedEdges.has(e.id); });
    selectedEdges.clear();
    selectedEdge = null;
    renderNodes(); renderEdges(); wireUpCanvas();
    updateDeleteButton(); updatePropertiesPanel();
    immediateSave(); fetchCompositions();
    return;
  }

  if (selectedEdge) {
    compData.edges = compData.edges.filter(function(e) { return e.id !== selectedEdge; });
    selectedEdge = null; selectedEdges.clear();
    renderNodes();
    renderEdges();
    updateDeleteButton();
    updatePropertiesPanel();
    immediateSave();
    fetchCompositions();
    return;
  }

  if (selectedNodes.size > 0) {
    var count = selectedNodes.size;
    if (!confirm('Remove ' + count + ' workflow' + (count !== 1 ? 's' : '') + ' from this pipeline?')) return;
    // Remove edges connected to selected nodes
    compData.edges = compData.edges.filter(function(e) {
      return !selectedNodes.has(e.sourceNodeId) && !selectedNodes.has(e.targetNodeId);
    });
    // Remove nodes
    compData.nodes = compData.nodes.filter(function(n) { return !selectedNodes.has(n.id); });
    selectedNodes.clear();
    renderNodes();
    renderEdges();
    wireUpCanvas();
    updateDeleteButton();
    updatePropertiesPanel();
    immediateSave();
    fetchCompositions();
    return;
  }
}

function updateDeleteButton() {
  var btn = document.querySelector('#comp-delete-selected');
  if (btn) {
    btn.style.display = (selectedNodes.size > 0 || selectedEdge || selectedEdges.size > 0) ? '' : 'none';
  }
}

function fitToView() {
  if (!compData || compData.nodes.length === 0) {
    canvasState = { panX: 0, panY: 0, zoom: 1 };
    applyCanvasTransform();
    return;
  }

  var wrap = document.querySelector('#comp-canvas-wrap');
  if (!wrap) return;
  var wrapRect = wrap.getBoundingClientRect();

  // Find bounding box of all nodes
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < compData.nodes.length; i++) {
    var n = compData.nodes[i];
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + 220); // approximate node width
    maxY = Math.max(maxY, n.position.y + 150); // approximate node height
  }

  var graphW = maxX - minX + 80;
  var graphH = maxY - minY + 80;
  var zoom = Math.min(wrapRect.width / graphW, wrapRect.height / graphH, 1.5);
  zoom = Math.max(0.3, Math.min(zoom, 1.5));

  canvasState.zoom = zoom;
  canvasState.panX = (wrapRect.width - graphW * zoom) / 2 - minX * zoom + 40 * zoom;
  canvasState.panY = (wrapRect.height - graphH * zoom) / 2 - minY * zoom + 40 * zoom;

  applyCanvasTransform();
  requestAnimationFrame(function() { updateEdgePositions(); });
}

// ── Canvas Interactions ──────────────────────────────────────

function wireUpCanvas() {
  var wrap = document.querySelector('#comp-canvas-wrap');
  if (!wrap) return;

  // Remove old listeners by cloning (simple way to reset)
  if (wrap._compWired) return;
  wrap._compWired = true;

  // --- Mouse down ---
  wrap.addEventListener('mousedown', function(e) {
    hideContextMenu();
    var target = e.target;

    // Check if clicking on an output port dot (start edge drawing)
    var portDot = target.closest('.comp-port-dot-out');
    if (portDot) {
      var portEl = portDot.closest('.comp-port');
      if (portEl) {
        e.preventDefault();
        e.stopPropagation();
        startEdgeDrag(portEl, e);
        return;
      }
    }

    // Check if clicking on an input port dot (possible edge connection)
    var inPortDot = target.closest('.comp-port-dot-in');
    if (inPortDot) {
      e.preventDefault();
      return;
    }

    // Check if clicking on pipeline nav link icon → navigate to that pipeline
    if (target.closest('.comp-node-nav-link')) {
      var navNodeEl = target.closest('.comp-node');
      if (navNodeEl) {
        var navNodeId = navNodeEl.dataset.nodeId;
        var navNode = currentComposition && currentComposition.nodes.find(function(n) { return n.id === navNodeId; });
        if (navNode && navNode.workflowId && navNode.workflowId.startsWith('comp:')) {
          var targetCompId = (navNode.compositionRef && navNode.compositionRef.compositionId) || navNode.workflowId.replace('comp:', '');
          e.preventDefault();
          e.stopPropagation();
          selectComposition(targetCompId);
          return;
        }
      }
    }

    // Check if clicking on node header (start node drag)
    var nodeHeader = target.closest('.comp-node-header');
    if (nodeHeader) {
      var nodeEl = nodeHeader.closest('.comp-node');
      if (nodeEl) {
        e.preventDefault();
        var nodeId = nodeEl.dataset.nodeId;
        if (e.shiftKey) {
          // Shift+click: toggle in selection
          if (selectedNodes.has(nodeId)) {
            selectedNodes.delete(nodeId);
          } else {
            selectedNodes.add(nodeId);
          }
          selectedEdge = null; selectedEdges.clear();
          updateNodeSelection();
          updateEdgeSelection();
          updateDeleteButton();
          updatePropertiesPanel();
        } else {
          // Normal click: select only this node (if not already in multi-select)
          if (!selectedNodes.has(nodeId)) {
            selectedNodes.clear();
            selectedNodes.add(nodeId);
            selectedEdge = null; selectedEdges.clear();
            updateNodeSelection();
            updateEdgeSelection();
            updateDeleteButton();
            updatePropertiesPanel();
          }
        }
        startNodeDrag(nodeEl, e);
        return;
      }
    }

    // Check if clicking on node body (just select)
    var nodeBody = target.closest('.comp-node');
    if (nodeBody) {
      e.preventDefault();
      var bodyNodeId = nodeBody.dataset.nodeId;
      if (e.shiftKey) {
        if (selectedNodes.has(bodyNodeId)) {
          selectedNodes.delete(bodyNodeId);
        } else {
          selectedNodes.add(bodyNodeId);
        }
        selectedEdge = null; selectedEdges.clear();
      } else {
        selectedNodes.clear();
        selectedNodes.add(bodyNodeId);
        selectedEdge = null; selectedEdges.clear();
      }
      updateNodeSelection();
      updateEdgeSelection();
      updateDeleteButton();
      updatePropertiesPanel();
      return;
    }

    // Check if clicking on an edge
    var edgePath = target.closest('.comp-edge');
    if (edgePath && edgePath.dataset.edgeId) {
      e.preventDefault();
      selectEdgeById(edgePath.dataset.edgeId);
      return;
    }

    // Background click: start panning or selection rectangle
    if (target === wrap || target.closest('.comp-canvas-wrap') === wrap) {
      if (!e.shiftKey) {
        // Normal click: deselect everything
        selectedNodes.clear();
        selectedEdge = null; selectedEdges.clear();
        updateNodeSelection();
        updateEdgeSelection();
        updateDeleteButton();
        updatePropertiesPanel();
      }

      e.preventDefault();

      if (e.shiftKey) {
        // Shift+background: rubber-band selection
        startSelectionRect(e);
      } else {
        startPan(e);
      }
    }
  });

  // --- Right-click context menu ---
  wrap.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var target = e.target;
    var nodeEl = target.closest('.comp-node');
    var edgeEl = target.closest('.comp-edge');

    if (nodeEl) {
      var nId = nodeEl.dataset.nodeId;
      if (!selectedNodes.has(nId)) {
        selectedNodes.clear();
        selectedNodes.add(nId);
        selectedEdge = null; selectedEdges.clear();
        updateNodeSelection();
        updateEdgeSelection();
        updateDeleteButton();
        updatePropertiesPanel();
      }
      showContextMenu(e.clientX, e.clientY, 'node', nId);
    } else if (edgeEl && edgeEl.dataset.edgeId) {
      selectEdgeById(edgeEl.dataset.edgeId);
      showContextMenu(e.clientX, e.clientY, 'edge', null, edgeEl.dataset.edgeId);
    } else {
      showContextMenu(e.clientX, e.clientY, 'canvas');
    }
  });

  // --- Wheel (zoom) ---
  wrap.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.08 : 0.08;
    var newZoom = Math.max(0.2, Math.min(2.0, canvasState.zoom + delta));

    // Zoom toward mouse position
    var rect = wrap.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;

    var ratio = newZoom / canvasState.zoom;
    canvasState.panX = mx - (mx - canvasState.panX) * ratio;
    canvasState.panY = my - (my - canvasState.panY) * ratio;
    canvasState.zoom = newZoom;

    applyCanvasTransform();
    requestAnimationFrame(function() { updateEdgePositions(); });
  }, { passive: false });

  // --- Keyboard ---
  // Use a named function so we can identify it; only attach once globally
  if (!window._compKeydownAttached) {
    window._compKeydownAttached = true;
    document.addEventListener('keydown', function(e) {
      // Don't interfere with inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Only handle if composition editor is visible
      if (!document.querySelector('#comp-canvas-wrap')) return;

      var ctrlOrMeta = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdge || selectedNodes.size > 0) {
          e.preventDefault();
          deleteSelected();
        }
      }
      // Undo: Ctrl+Z / Cmd+Z
      if (ctrlOrMeta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z
      if (ctrlOrMeta && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      // Select All: Ctrl+A / Cmd+A
      if (ctrlOrMeta && (e.key === 'a' || e.key === 'A') && !e.shiftKey) {
        e.preventDefault();
        if (compData) {
          compData.nodes.forEach(function(n) { selectedNodes.add(n.id); });
          selectedEdge = null; selectedEdges.clear();
          updateNodeSelection();
          updateEdgeSelection();
          updateDeleteButton();
          updatePropertiesPanel();
        }
      }
      // Copy: Ctrl+C / Cmd+C
      if (ctrlOrMeta && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        if (selectedNodes.size > 0) {
          e.preventDefault();
          copySelected();
        }
      }
      // Paste: Ctrl+V / Cmd+V
      if (ctrlOrMeta && (e.key === 'v' || e.key === 'V') && !e.shiftKey) {
        if (clipboard) {
          e.preventDefault();
          pasteClipboard();
        }
      }
      // Escape: deselect all, hide context menu
      if (e.key === 'Escape') {
        hideContextMenu();
        selectedNodes.clear();
        selectedEdge = null; selectedEdges.clear();
        updateNodeSelection();
        updateEdgeSelection();
        updateDeleteButton();
        updatePropertiesPanel();
      }
    });
  }

  // ── Port value tooltips (hover) ─────────────────────────────
  wrap.addEventListener('mouseover', function(e) {
    var portEl = e.target.closest('.comp-port');
    if (!portEl) return;

    var nodeId = portEl.dataset.nodeId;
    var portName = portEl.dataset.portName;
    var direction = portEl.dataset.portDir; // 'in' or 'out'
    if (!nodeId || !portName || !direction) return;

    var value = lookupPortValue(nodeId, portName, direction);
    var formatted = formatPortValue(value);
    if (formatted === null) return; // No data

    var tooltip = getPortTooltip();
    var label = (direction === 'in' ? 'Input' : 'Output') + ': ' + humanizeVarName(portName);
    tooltip.innerHTML = '<div class="comp-port-tooltip-label">' + compEscHtml(label) + '</div>' + formatted;

    // Position near the port
    var rect = portEl.getBoundingClientRect();
    tooltip.style.display = '';
    tooltip.classList.add('visible');

    var tooltipWidth = tooltip.offsetWidth;
    var tooltipHeight = tooltip.offsetHeight;

    var left, top;
    if (direction === 'out') {
      left = rect.right + 8;
      top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
    } else {
      left = rect.left - tooltipWidth - 8;
      top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
    }

    // Clamp to viewport
    if (left < 4) left = rect.right + 8;
    if (left + tooltipWidth > window.innerWidth - 4) left = rect.left - tooltipWidth - 8;
    if (top < 4) top = 4;
    if (top + tooltipHeight > window.innerHeight - 4) top = window.innerHeight - tooltipHeight - 4;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });

  wrap.addEventListener('mouseout', function(e) {
    var portEl = e.target.closest('.comp-port');
    if (!portEl) return;
    // Don't hide if moving to another element within the same port
    var related = e.relatedTarget;
    if (related && portEl.contains(related)) return;
    var tooltip = document.querySelector('#comp-port-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
  });
}

function selectNodeById(nodeId, additive) {
  if (!additive) {
    selectedNodes.clear();
  }
  selectedNodes.add(nodeId);
  selectedEdge = null; selectedEdges.clear();
  updateNodeSelection();
  updateEdgeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
}

function selectEdgeById(edgeId) {
  selectedEdge = edgeId;
  selectedNodes.clear();
  updateNodeSelection();
  updateEdgeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
}

function updateNodeSelection() {
  document.querySelectorAll('.comp-node').forEach(function(el) {
    el.classList.toggle('comp-node-selected', selectedNodes.has(el.dataset.nodeId));
  });
}

function updateEdgeSelection() {
  document.querySelectorAll('.comp-edge').forEach(function(el) {
    var eid = el.dataset.edgeId;
    el.classList.toggle('comp-edge-selected', eid === selectedEdge || selectedEdges.has(eid));
  });
}

// ── Rubber-band Selection ─────────────────────────────────────

/**
 * Test if a cubic bezier curve intersects a rectangle by sampling points along the curve.
 */
function bezierIntersectsRect(sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty, rL, rT, rR, rB) {
  var SAMPLES = 20;
  for (var i = 0; i <= SAMPLES; i++) {
    var t = i / SAMPLES;
    var mt = 1 - t;
    var x = mt*mt*mt*sx + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*tx;
    var y = mt*mt*mt*sy + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*ty;
    if (x >= rL && x <= rR && y >= rT && y <= rB) {
      return true;
    }
  }
  return false;
}

/**
 * Test if an edge's bezier curve intersects a selection rectangle (in canvas space).
 */
function edgeIntersectsRect(edge, selLeft, selTop, selRight, selBottom) {
  var srcPos = getPortPosition(edge.sourceNodeId, edge.sourcePort, 'out');
  var tgtPos = getPortPosition(edge.targetNodeId, edge.targetPort, 'in');
  if (!srcPos || !tgtPos) return false;

  var sx = srcPos.x, sy = srcPos.y, tx = tgtPos.x, ty = tgtPos.y;
  var dx = Math.max(Math.abs(tx - sx) * 0.5, 50);
  var cp1x = sx + dx, cp1y = sy;
  var cp2x = tx - dx, cp2y = ty;

  return bezierIntersectsRect(sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty, selLeft, selTop, selRight, selBottom);
}

function startSelectionRect(e) {
  var wrap = document.querySelector('#comp-canvas-wrap');
  var rectEl = document.querySelector('#comp-selection-rect');
  if (!wrap || !rectEl) return;

  var wrapRect = wrap.getBoundingClientRect();
  var startX = e.clientX - wrapRect.left;
  var startY = e.clientY - wrapRect.top;

  rectEl.style.display = '';
  rectEl.style.left = startX + 'px';
  rectEl.style.top = startY + 'px';
  rectEl.style.width = '0px';
  rectEl.style.height = '0px';

  function onMove(e2) {
    var curX = e2.clientX - wrapRect.left;
    var curY = e2.clientY - wrapRect.top;

    var x = Math.min(startX, curX);
    var y = Math.min(startY, curY);
    var w = Math.abs(curX - startX);
    var h = Math.abs(curY - startY);

    rectEl.style.left = x + 'px';
    rectEl.style.top = y + 'px';
    rectEl.style.width = w + 'px';
    rectEl.style.height = h + 'px';
  }

  function onUp(e2) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    rectEl.style.display = 'none';

    // Calculate selection bounds in canvas space
    var curX = e2.clientX - wrapRect.left;
    var curY = e2.clientY - wrapRect.top;
    var selLeft = (Math.min(startX, curX) - canvasState.panX) / canvasState.zoom;
    var selTop = (Math.min(startY, curY) - canvasState.panY) / canvasState.zoom;
    var selRight = (Math.max(startX, curX) - canvasState.panX) / canvasState.zoom;
    var selBottom = (Math.max(startY, curY) - canvasState.panY) / canvasState.zoom;

    // Select nodes within the rectangle
    if (compData) {
      compData.nodes.forEach(function(node) {
        var nx = node.position.x;
        var ny = node.position.y;
        var nw = 220; // approximate node width
        var nh = 100; // approximate node height
        // Check if node overlaps with selection rect
        if (nx + nw > selLeft && nx < selRight && ny + nh > selTop && ny < selBottom) {
          selectedNodes.add(node.id);
        }
      });
      // Also select edges that intersect with the rectangle
      compData.edges.forEach(function(edge) {
        if (edgeIntersectsRect(edge, selLeft, selTop, selRight, selBottom)) {
          selectedEdges.add(edge.id);
        }
      });
      selectedEdge = null;
      updateNodeSelection();
      updateEdgeSelection();
      updateDeleteButton();
      updatePropertiesPanel();
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Pan ──────────────────────────────────────────────────────

function startPan(e) {
  var startX = e.clientX;
  var startY = e.clientY;
  var startPanX = canvasState.panX;
  var startPanY = canvasState.panY;

  function onMove(e2) {
    canvasState.panX = startPanX + (e2.clientX - startX);
    canvasState.panY = startPanY + (e2.clientY - startY);
    applyCanvasTransform();
    updateEdgePositions();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Node Drag ────────────────────────────────────────────────

function startNodeDrag(nodeEl, e) {
  var nodeId = nodeEl.dataset.nodeId;
  var node = compData.nodes.find(function(n) { return n.id === nodeId; });
  if (!node) return;
  pushUndoSnapshot();

  var startX = e.clientX;
  var startY = e.clientY;

  // Capture initial positions of all selected nodes for bulk drag
  var dragNodes = [];
  if (selectedNodes.has(nodeId)) {
    selectedNodes.forEach(function(id) {
      var n = compData.nodes.find(function(nd) { return nd.id === id; });
      if (n) dragNodes.push({ node: n, startX: n.position.x, startY: n.position.y });
    });
  } else {
    dragNodes.push({ node: node, startX: node.position.x, startY: node.position.y });
  }

  nodeEl.classList.add('comp-node-dragging');

  function onMove(e2) {
    var dx = (e2.clientX - startX) / canvasState.zoom;
    var dy = (e2.clientY - startY) / canvasState.zoom;

    dragNodes.forEach(function(d) {
      var nx = Math.round(d.startX + dx);
      var ny = Math.round(d.startY + dy);
      if (snapToGrid) {
        nx = Math.round(nx / GRID_SIZE) * GRID_SIZE;
        ny = Math.round(ny / GRID_SIZE) * GRID_SIZE;
      }
      d.node.position.x = nx;
      d.node.position.y = ny;
      var el = document.querySelector('.comp-node[data-node-id="' + d.node.id + '"]');
      if (el) {
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
      }
    });
    updateEdgePositions();
  }

  function onUp() {
    nodeEl.classList.remove('comp-node-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    debouncedSave();
    updateMinimap();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Edge Drag (Create Edge) ──────────────────────────────────

function startEdgeDrag(portEl, e) {
  var srcNodeId = portEl.dataset.nodeId;
  var srcPortName = portEl.dataset.portName;

  var tempPath = document.querySelector('#comp-edge-temp');
  if (!tempPath) return;
  tempPath.style.display = '';

  var wrap = document.querySelector('#comp-canvas-wrap');

  // Get source port position
  var srcDot = portEl.querySelector('.comp-port-dot-out');
  var srcPos = getPortPosition(srcNodeId, srcPortName, 'out');
  if (!srcPos) return;

  // Smart port matching (Step 3): highlight compatible/incompatible ports
  var srcIsFlow = srcPortName === '__done__';
  document.querySelectorAll('.comp-port').forEach(function(p) {
    var pNodeId = p.dataset.nodeId;
    var pPortName = p.dataset.portName;
    var pDir = p.dataset.portDir;
    var pIsFlow = pPortName === '__trigger__';
    if (pDir === 'out') {
      // All output ports are incompatible drop targets
      p.classList.add('comp-port-incompatible');
    } else if (pDir === 'in') {
      if (pNodeId === srcNodeId) {
        // Same node — incompatible
        p.classList.add('comp-port-incompatible');
      } else if (isPortConnected(pNodeId, pPortName, 'input')) {
        // Already connected — incompatible
        p.classList.add('comp-port-incompatible');
      } else if (srcIsFlow !== pIsFlow) {
        // Flow-to-flow only, data-to-data only
        p.classList.add('comp-port-incompatible');
      } else {
        // Available input — compatible
        p.classList.add('comp-port-compatible');
      }
    }
  });

  function onMove(e2) {
    var rect = wrap.getBoundingClientRect();
    var mx = (e2.clientX - rect.left - canvasState.panX) / canvasState.zoom;
    var my = (e2.clientY - rect.top - canvasState.panY) / canvasState.zoom;
    tempPath.setAttribute('d', edgePath(srcPos.x, srcPos.y, mx, my));
  }

  function onUp(e2) {
    tempPath.style.display = 'none';
    tempPath.setAttribute('d', '');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    // Remove all compatibility classes
    document.querySelectorAll('.comp-port-compatible, .comp-port-incompatible').forEach(function(p) {
      p.classList.remove('comp-port-compatible', 'comp-port-incompatible');
    });

    // Check if dropped on an input port
    var target = document.elementFromPoint(e2.clientX, e2.clientY);
    if (!target) return;

    var inDot = target.closest('.comp-port-dot-in');
    if (!inDot) {
      var inPort = target.closest('.comp-port-in');
      if (inPort) inDot = inPort;
      else {
        // Dropped on empty space — offer to create a data-aware script node
        var portValue = lookupPortValue(srcNodeId, srcPortName, 'out');
        var wrapRect = wrap.getBoundingClientRect();
        var dropX = (e2.clientX - wrapRect.left - canvasState.panX) / canvasState.zoom;
        var dropY = (e2.clientY - wrapRect.top - canvasState.panY) / canvasState.zoom;
        showDataAwareScriptModal(srcNodeId, srcPortName, portValue, dropX, dropY);
        return;
      }
    }

    var inPortEl = inDot.closest('.comp-port');
    if (!inPortEl) return;

    var tgtNodeId = inPortEl.dataset.nodeId;
    var tgtPortName = inPortEl.dataset.portName;

    // Don't connect to same node
    if (tgtNodeId === srcNodeId) return;

    // Don't duplicate edges
    var exists = compData.edges.some(function(e) {
      return e.sourceNodeId === srcNodeId && e.sourcePort === srcPortName &&
             e.targetNodeId === tgtNodeId && e.targetPort === tgtPortName;
    });
    if (exists) return;

    // Don't allow multiple connections to the same input port
    var inputOccupied = compData.edges.some(function(e) {
      return e.targetNodeId === tgtNodeId && e.targetPort === tgtPortName;
    });
    if (inputOccupied) {
      toast('This input already has a connection — remove it first', 'error');
      return;
    }

    // Create edge
    pushUndoSnapshot();
    var edge = {
      id: genId('edge'),
      sourceNodeId: srcNodeId,
      sourcePort: srcPortName,
      targetNodeId: tgtNodeId,
      targetPort: tgtPortName,
    };

    compData.edges.push(edge);
    renderNodes(); // Re-render to update port connected states
    renderEdges();
    wireUpCanvas();
    immediateSave();
    fetchCompositions();
    toast('Connected!', 'success');
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Copy / Paste ─────────────────────────────────────────────

function copySelected() {
  if (!compData || selectedNodes.size === 0) return;

  var nodes = [];
  var edges = [];

  compData.nodes.forEach(function(n) {
    if (selectedNodes.has(n.id)) {
      nodes.push(JSON.parse(JSON.stringify(n)));
    }
  });

  // Only copy edges where both endpoints are selected
  compData.edges.forEach(function(e) {
    if (selectedNodes.has(e.sourceNodeId) && selectedNodes.has(e.targetNodeId)) {
      edges.push(JSON.parse(JSON.stringify(e)));
    }
  });

  clipboard = { nodes: nodes, edges: edges };
  toast('Copied ' + nodes.length + ' workflow' + (nodes.length !== 1 ? 's' : ''), 'success');
}

function pasteClipboard() {
  if (!clipboard || !compData) return;
  pushUndoSnapshot();

  // Build ID mapping
  var idMap = {};
  clipboard.nodes.forEach(function(n) {
    idMap[n.id] = genId('node');
  });

  // Clone nodes with new IDs and offset positions
  var newNodes = clipboard.nodes.map(function(n) {
    var clone = JSON.parse(JSON.stringify(n));
    clone.id = idMap[n.id];
    clone.position.x += 40;
    clone.position.y += 40;
    return clone;
  });

  // Clone edges with new IDs and remapped endpoints
  var newEdges = clipboard.edges.map(function(e) {
    return {
      id: genId('edge'),
      sourceNodeId: idMap[e.sourceNodeId],
      sourcePort: e.sourcePort,
      targetNodeId: idMap[e.targetNodeId],
      targetPort: e.targetPort,
    };
  });

  compData.nodes = compData.nodes.concat(newNodes);
  compData.edges = compData.edges.concat(newEdges);

  // Select pasted nodes
  selectedNodes.clear();
  newNodes.forEach(function(n) { selectedNodes.add(n.id); });
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
  toast('Pasted ' + newNodes.length + ' workflow' + (newNodes.length !== 1 ? 's' : ''), 'success');
}

// ── Context Menu ─────────────────────────────────────────────

function showContextMenu(x, y, type, nodeId, edgeId) {
  hideContextMenu();

  var menu = document.createElement('div');
  menu.className = 'comp-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  var items = [];

  if (type === 'node') {
    items.push({ label: 'Rename', icon: '&#x270f;', action: function() { renameNode(nodeId); } });
    items.push({ label: 'Duplicate Workflow', icon: '&#x2398;', action: function() { duplicateNode(nodeId); } });
    if (selectedNodes.size > 0) {
      items.push({ label: 'Copy', icon: '&#x2398;', shortcut: '&#x2318;C', action: function() { copySelected(); } });
    }
    items.push({ separator: true });
    items.push({ label: 'Remove All Connections', icon: '&#x26d4;', action: function() { disconnectAllEdges(nodeId); } });
    items.push({ label: 'Remove Workflow', icon: '&#x1f5d1;', danger: true, shortcut: 'Del', action: function() { deleteSelected(); } });
  } else if (type === 'edge') {
    items.push({ label: 'Remove Connection', icon: '&#x1f5d1;', danger: true, shortcut: 'Del', action: function() { deleteSelected(); } });
  } else {
    // Canvas menu
    if (clipboard) {
      items.push({ label: 'Paste', icon: '&#x1f4cb;', shortcut: '&#x2318;V', action: function() { pasteClipboard(); } });
      items.push({ separator: true });
    }
    items.push({ label: 'Add Workflow', icon: '+', action: function() { showAddNodeDropdown(); } });
    items.push({ label: 'Select All', icon: '&#x2610;', shortcut: '&#x2318;A', action: function() {
      if (compData) {
        compData.nodes.forEach(function(n) { selectedNodes.add(n.id); });
        selectedEdge = null; selectedEdges.clear();
        updateNodeSelection();
        updateEdgeSelection();
        updateDeleteButton();
        updatePropertiesPanel();
      }
    }});
    items.push({ label: 'Fit View', icon: '&#x26f6;', action: function() { fitToView(); } });
  }

  var html = '';
  items.forEach(function(item) {
    if (item.separator) {
      html += '<div class="comp-ctx-separator"></div>';
    } else {
      html += '<div class="comp-ctx-item' + (item.danger ? ' comp-ctx-item-danger' : '') + '" data-action="' + item.label + '">';
      html += '<span>' + (item.icon || '') + ' ' + compEscHtml(item.label) + '</span>';
      if (item.shortcut) {
        html += '<span class="comp-ctx-shortcut">' + item.shortcut + '</span>';
      }
      html += '</div>';
    }
  });

  menu.innerHTML = html;
  document.body.appendChild(menu);
  contextMenuEl = menu;

  // Ensure menu stays within viewport
  var menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    menu.style.left = (x - menuRect.width) + 'px';
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = (y - menuRect.height) + 'px';
  }

  // Wire up click handlers
  items.forEach(function(item) {
    if (item.separator) return;
    var el = menu.querySelector('.comp-ctx-item[data-action="' + item.label + '"]');
    if (el) {
      el.addEventListener('click', function() {
        hideContextMenu();
        item.action();
      });
    }
  });

  // Close on click outside
  setTimeout(function() {
    function closeMenu(e) {
      if (!menu.contains(e.target)) {
        hideContextMenu();
        document.removeEventListener('click', closeMenu);
      }
    }
    document.addEventListener('click', closeMenu);
  }, 10);
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function renameNode(nodeId) {
  if (!compData) return;
  var node = compData.nodes.find(function(n) { return n.id === nodeId; });
  if (!node) return;
  var wf = getWorkflowForNode(node);
  var currentName = node.label || (wf ? wf.name : node.workflowId);
  var newName = prompt('Rename this step:', currentName);
  if (newName !== null && newName.trim()) {
    pushUndoSnapshot();
    node.label = newName.trim();
    renderNodes();
    wireUpCanvas();
    immediateSave();
    updatePropertiesPanel();
  }
}

function duplicateNode(nodeId) {
  if (!compData) return;
  var node = compData.nodes.find(function(n) { return n.id === nodeId; });
  if (!node) return;
  pushUndoSnapshot();

  var clone = JSON.parse(JSON.stringify(node));
  clone.id = genId('node');
  clone.position.x += 40;
  clone.position.y += 40;
  if (clone.label) clone.label = clone.label + ' Copy';

  compData.nodes.push(clone);
  selectedNodes.clear();
  selectedNodes.add(clone.id);
  selectedEdge = null; selectedEdges.clear();

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
  toast('Workflow duplicated', 'success');
}

function disconnectAllEdges(nodeId) {
  if (!compData) return;
  var count = compData.edges.filter(function(e) {
    return e.sourceNodeId === nodeId || e.targetNodeId === nodeId;
  }).length;
  if (count === 0) { toast('No connections to remove', 'info'); return; }
  pushUndoSnapshot();
  compData.edges = compData.edges.filter(function(e) {
    return e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId;
  });
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  fetchCompositions();
  toast('Removed ' + count + ' connection' + (count !== 1 ? 's' : ''), 'success');
}
