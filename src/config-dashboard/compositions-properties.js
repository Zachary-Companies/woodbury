/**
 * compositions-properties.js
 *
 * Properties panel and per-node-type property editors for the
 * pipeline/compositions editor.
 *
 * Depends on: compositions-core.js, compositions-canvas.js
 *
 * Contents:
 *   - updatePropertiesPanel, hidePropertiesPanel
 *   - renderNodeProperties (workflow node properties: input overrides, expectations,
 *     failure policy)
 *   - renderImageViewerProperties
 *   - renderMediaPlayerProperties (buildVideoPlayer, buildAudioPlayer, buildImageViewer,
 *     buildPdfViewer, buildTextViewer, formatTime)
 *   - renderBranchProperties, renderDelayProperties, renderGateNodeProperties,
 *     renderForEachProperties
 *   - renderVariableProperties, renderGetVariableProperties
 *   - renderTextProperties, renderJsonKeysProperties, renderFileOpProperties,
 *     renderFileWriteProperties, renderJunctionProperties, renderFileReadProperties
 *   - renderToolProperties (searchable tool picker dropdown)
 *   - renderAssetProperties (collection/asset pickers, generate-path mode)
 *   - renderSwitchProperties
 *   - renderCompositionNodeProperties (sub-pipeline)
 *   - renderOutputProperties (pipeline output ports)
 *   - renderGateProperties (approval gate configuration)
 *   - renderIdempotencySection, wireIdempotencyToggle
 *   - renderScriptProperties (AI agent chat, code preview, port aliases)
 *   - renderEdgeProperties
 */


// ── Properties Panel ─────────────────────────────────────────

function updatePropertiesPanel() {
  var panel = document.querySelector('#comp-props-panel');
  var body = document.querySelector('#comp-props-body');
  if (!panel || !body) return;

  if (selectedNodes.size === 1) {
    var nodeId = Array.from(selectedNodes)[0];
    panel.style.display = '';
    renderNodeProperties(nodeId);
  } else if (selectedNodes.size > 1) {
    panel.style.display = '';
    body.innerHTML =
      '<div class="comp-props-section">' +
      '<div class="comp-props-label">Selection</div>' +
      '<div class="comp-props-value">' + selectedNodes.size + ' workflows selected</div>' +
      '</div>' +
      '<div class="comp-props-section">' +
      '<button class="comp-tb-btn" id="comp-props-copy" style="width:100%;margin-bottom:0.3rem;">Copy</button>' +
      '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-props-delete" style="width:100%;">Remove All</button>' +
      '</div>';
    var copyBtn = body.querySelector('#comp-props-copy');
    if (copyBtn) copyBtn.addEventListener('click', function() { copySelected(); });
    var delBtn = body.querySelector('#comp-props-delete');
    if (delBtn) delBtn.addEventListener('click', function() { deleteSelected(); });
  } else if (selectedEdges.size > 0 && selectedNodes.size === 0) {
    panel.style.display = '';
    body.innerHTML =
      '<div class="comp-props-section">' +
      '<div class="comp-props-label">Edge Selection</div>' +
      '<div class="comp-props-value">' + selectedEdges.size + ' connection' + (selectedEdges.size !== 1 ? 's' : '') + ' selected</div>' +
      '</div>' +
      '<div class="comp-props-section">' +
      '<button class="comp-tb-btn" id="comp-create-junction" style="width:100%;background:#7c3aed22;color:#a78bfa;border-color:#7c3aed44;margin-bottom:0.4rem;">&#x26a1; Create Junction</button>' +
      '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-props-del-edges" style="width:100%;">Remove Selected</button>' +
      '</div>';
    var junctionBtn = body.querySelector('#comp-create-junction');
    if (junctionBtn) junctionBtn.addEventListener('click', function() { createJunctionFromSelectedEdges(); });
    var delEdgesBtn = body.querySelector('#comp-props-del-edges');
    if (delEdgesBtn) delEdgesBtn.addEventListener('click', function() { deleteSelected(); });
  } else if (selectedEdge) {
    panel.style.display = '';
    renderEdgeProperties(selectedEdge);
  } else {
    hidePropertiesPanel();
  }

  // After showing/hiding panel, update edge positions (canvas resize)
  setTimeout(function() { updateEdgePositions(); updateMinimap(); }, 0);
}

function hidePropertiesPanel() {
  var panel = document.querySelector('#comp-props-panel');
  if (panel) panel.style.display = 'none';
  setTimeout(function() { updateEdgePositions(); updateMinimap(); }, 0);
}

function renderNodeProperties(nodeId) {
  var body = document.querySelector('#comp-props-body');
  if (!body || !compData) return;

  var node = compData.nodes.find(function(n) { return n.id === nodeId; });
  if (!node) return;

  // ── Approval Gate Properties ──
  if (node.workflowId === '__approval_gate__') {
    renderGateProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Script Node Properties ──
  if (node.workflowId === '__script__') {
    renderScriptProperties(body, node, nodeId);
    // Error display is built into renderScriptProperties
    return;
  }

  // ── Output Node Properties ──
  if (node.workflowId === '__output__') {
    renderOutputProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Composition Node Properties ──
  if (node.workflowId.startsWith('comp:')) {
    renderCompositionNodeProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Image Viewer Properties ──
  if (node.workflowId === '__image_viewer__') {
    renderImageViewerProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Media Player Properties ──
  if (node.workflowId === '__media__') {
    renderMediaPlayerProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Branch Node Properties ──
  if (node.workflowId === '__branch__') {
    renderBranchProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Delay Node Properties ──
  if (node.workflowId === '__delay__') {
    renderDelayProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Gate Node Properties ──
  if (node.workflowId === '__gate__') {
    renderGateNodeProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── ForEach Node Properties ──
  if (node.workflowId === '__for_each__') {
    renderForEachProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Variable Node Properties ──
  if (node.workflowId === '__variable__') {
    renderVariableProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Get Variable Node Properties ──
  if (node.workflowId === '__get_variable__') {
    renderGetVariableProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Text Node Properties ──
  if (node.workflowId === '__text__') {
    renderTextProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── File Op Node Properties ──
  if (node.workflowId === '__file_op__') {
    renderFileOpProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── JSON Extract Node Properties ──
  if (node.workflowId === '__json_keys__') {
    renderJsonKeysProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Tool Node Properties ──
  if (node.workflowId === '__tool__') {
    renderToolProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── File Write Node Properties ──
  if (node.workflowId === '__file_write__') {
    renderFileWriteProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── File Read Node Properties ──
  if (node.workflowId === '__file_read__') {
    renderFileReadProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Junction Node Properties ──
  if (node.workflowId === '__junction__') {
    renderJunctionProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Asset Node Properties ──
  if (node.workflowId === '__asset__') {
    renderAssetProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  // ── Switch Node Properties ──
  if (node.workflowId === '__switch__') {
    renderSwitchProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
    return;
  }

  var wf = getWorkflowForNode(node);

  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="' + compEscAttr(wf ? wf.name : node.workflowId) + '">';
  html += '</div>';

  // Uses Workflow
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Uses Workflow</div>';
  html += '<div class="comp-props-value">' + compEscHtml(wf ? wf.name : 'Not found') + '</div>';
  if (wf && wf.site) {
    html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">' + compEscHtml(wf.site) + '</div>';
  }
  html += '</div>';

  // Receives (input variables)
  var inputs = wf ? (wf.variables || []) : [];
  if (inputs.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Receives (' + inputs.length + ')</div>';
    inputs.forEach(function(inp) {
      var connEdge = compData.edges.find(function(e) {
        return e.targetNodeId === nodeId && e.targetPort === inp.name;
      });
      html += '<div class="comp-props-var-row">';
      html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(inp.name)) + '</span>';
      if (inp.description) {
        html += '<div class="comp-props-var-desc">' + compEscHtml(inp.description) + '</div>';
      }
      if (connEdge) {
        var srcNode = compData.nodes.find(function(n) { return n.id === connEdge.sourceNodeId; });
        var srcWf = srcNode ? getWorkflowForNode(srcNode) : null;
        var srcName = srcNode ? (srcNode.label || (srcWf ? srcWf.name : srcNode.workflowId)) : '?';
        html += '<span class="comp-props-var-source">From ' + compEscHtml(srcName) + ' &rarr; ' + compEscHtml(humanizeVarName(connEdge.sourcePort)) + '</span>';
      } else {
        var overrideVal = (node.inputOverrides && node.inputOverrides[inp.name] !== undefined) ? String(node.inputOverrides[inp.name]) : '';
        html += '<input type="text" class="comp-props-input comp-props-var-override" data-var-name="' + compEscAttr(inp.name) + '" value="' + compEscAttr(overrideVal) + '" placeholder="default">';
      }
      var inpAlias = (node.portAliases && node.portAliases[inp.name]) || '';
      html += '<input type="text" class="comp-props-input comp-props-alias-input" data-port-name="' + compEscAttr(inp.name) + '" data-port-dir="in" value="' + compEscAttr(inpAlias) + '" placeholder="External name..." title="Alias for sub-pipeline usage">';
      html += '</div>';
    });
    html += '</div>';
  }

  // Produces (output variables)
  var outputs = wf ? (wf.outputVariables || []) : [];
  if (outputs.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Produces (' + outputs.length + ')</div>';
    outputs.forEach(function(out) {
      var downstreamCount = compData.edges.filter(function(e) {
        return e.sourceNodeId === nodeId && e.sourcePort === out;
      }).length;
      html += '<div class="comp-props-var-row">';
      html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(out)) + '</span>';
      html += '<span class="comp-props-var-source">&rarr; ' + downstreamCount + ' workflow' + (downstreamCount !== 1 ? 's' : '') + '</span>';
      var outAlias = (node.portAliases && node.portAliases[out]) || '';
      html += '<input type="text" class="comp-props-input comp-props-alias-input" data-port-name="' + compEscAttr(out) + '" data-port-dir="out" value="' + compEscAttr(outAlias) + '" placeholder="External name..." title="Alias for sub-pipeline usage">';
      html += '</div>';
    });
    html += '</div>';
  }

  // Expectations section — merged from workflow + node
  var wfExpectations = (wf && wf.expectations) ? wf.expectations : [];
  var nodeExpectations = node.expectations || [];
  if (wfExpectations.length > 0 || nodeExpectations.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Expectations (' + (wfExpectations.length + nodeExpectations.length) + ')</div>';
    wfExpectations.forEach(function(exp) {
      html += '<div class="comp-props-exp-row">';
      html += '<span class="comp-exp-badge comp-exp-badge-workflow">workflow</span>';
      html += '<span class="comp-props-exp-desc">' + compEscHtml(describeExpectation(exp)) + '</span>';
      html += '</div>';
    });
    nodeExpectations.forEach(function(exp, idx) {
      html += '<div class="comp-props-exp-row">';
      html += '<span class="comp-exp-badge comp-exp-badge-node">node</span>';
      html += '<span class="comp-props-exp-desc">' + compEscHtml(describeExpectation(exp)) + '</span>';
      html += '<button class="comp-props-exp-remove" data-exp-idx="' + idx + '" title="Remove">&times;</button>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Add expectation button + inline form
  html += '<div class="comp-props-section">';
  html += '<button class="comp-props-add-exp-btn" id="comp-props-add-exp-btn">+ Add Expectation</button>';
  html += '<div class="comp-props-exp-form" id="comp-props-exp-form" style="display:none;">';
  html += '<select class="comp-props-input" id="comp-exp-type-sel">';
  html += '<option value="file_count">File Count</option>';
  html += '<option value="file_exists">File Exists</option>';
  html += '<option value="variable_not_empty">Variable Not Empty</option>';
  html += '<option value="variable_equals">Variable Equals</option>';
  html += '</select>';
  html += '<div id="comp-exp-fields"></div>';
  html += '<div style="display:flex;gap:6px;margin-top:6px;">';
  html += '<button class="comp-tb-btn" id="comp-exp-add-confirm" style="flex:1;">Add</button>';
  html += '<button class="comp-tb-btn" id="comp-exp-add-cancel" style="flex:1;">Cancel</button>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // On Failure policy
  var currentPolicy = (node.onFailure && node.onFailure.action) || 'stop';
  var currentRetryMax = (node.onFailure && node.onFailure.retry && node.onFailure.retry.maxAttempts) || 3;
  var currentRetryDelay = (node.onFailure && node.onFailure.retry && node.onFailure.retry.delayMs) || 5000;
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">On Failure</div>';
  html += '<select class="comp-props-input" id="comp-props-failure-policy">';
  html += '<option value="stop"' + (currentPolicy === 'stop' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (currentPolicy === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '<option value="retry"' + (currentPolicy === 'retry' ? ' selected' : '') + '>Retry</option>';
  html += '</select>';
  html += '<div id="comp-props-retry-config" style="' + (currentPolicy === 'retry' ? '' : 'display:none;') + 'margin-top:8px;">';
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;white-space:nowrap;">Max attempts</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-retry-max" value="' + currentRetryMax + '" min="1" max="10" style="width:60px;">';
  html += '</div>';
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;white-space:nowrap;">Delay (sec)</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-retry-delay" value="' + Math.round(currentRetryDelay / 1000) + '" min="1" max="300" style="width:60px;">';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  body.innerHTML = html;

  // Wire up label editing
  var labelInput = body.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      pushUndoSnapshot();
      node.label = labelInput.value.trim() || undefined;
      renderNodes();
      wireUpCanvas();
      debouncedSave();
    });
  }

  // Wire up input override editing
  body.querySelectorAll('.comp-props-var-override').forEach(function(input) {
    input.addEventListener('change', function() {
      pushUndoSnapshot();
      if (!node.inputOverrides) node.inputOverrides = {};
      var val = input.value.trim();
      if (val) {
        node.inputOverrides[input.dataset.varName] = val;
      } else {
        delete node.inputOverrides[input.dataset.varName];
      }
      debouncedSave();
    });
  });

  // Wire up port alias editing
  body.querySelectorAll('.comp-props-alias-input').forEach(function(input) {
    input.addEventListener('change', function() {
      var portName = input.getAttribute('data-port-name');
      if (!portName) return;
      if (!node.portAliases) node.portAliases = {};
      var val = input.value.trim();
      if (val) {
        node.portAliases[portName] = val;
      } else {
        delete node.portAliases[portName];
        if (Object.keys(node.portAliases).length === 0) delete node.portAliases;
      }
      debouncedSave();
    });
  });

  // Wire up expectation removal buttons
  body.querySelectorAll('.comp-props-exp-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.dataset.expIdx);
      if (!node.expectations) return;
      pushUndoSnapshot();
      node.expectations.splice(idx, 1);
      if (node.expectations.length === 0) delete node.expectations;
      debouncedSave();
      renderNodeProperties(nodeId);
    });
  });

  // Wire up add expectation form
  var addExpBtn = body.querySelector('#comp-props-add-exp-btn');
  var expForm = body.querySelector('#comp-props-exp-form');
  var expTypeSel = body.querySelector('#comp-exp-type-sel');
  var expFieldsDiv = body.querySelector('#comp-exp-fields');

  function renderExpFields() {
    var t = expTypeSel.value;
    var fhtml = '';
    if (t === 'file_count') {
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-dir" placeholder="Directory (e.g. {{download_path}})" style="margin-top:6px;">';
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-pattern" placeholder="Pattern (e.g. *.mp3)" style="margin-top:4px;">';
      fhtml += '<input type="number" class="comp-props-input" id="comp-exp-f-min" placeholder="Min count" min="1" value="1" style="margin-top:4px;">';
    } else if (t === 'file_exists') {
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-path" placeholder="File path (e.g. {{output_file}})" style="margin-top:6px;">';
      fhtml += '<input type="number" class="comp-props-input" id="comp-exp-f-size" placeholder="Min size bytes (optional)" min="0" style="margin-top:4px;">';
    } else if (t === 'variable_not_empty') {
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-var" placeholder="Variable name" style="margin-top:6px;">';
    } else if (t === 'variable_equals') {
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-var" placeholder="Variable name" style="margin-top:6px;">';
      fhtml += '<input type="text" class="comp-props-input" id="comp-exp-f-val" placeholder="Expected value" style="margin-top:4px;">';
    }
    expFieldsDiv.innerHTML = fhtml;
  }

  if (addExpBtn) {
    addExpBtn.addEventListener('click', function() {
      expForm.style.display = 'block';
      addExpBtn.style.display = 'none';
      renderExpFields();
    });
  }

  if (expTypeSel) {
    expTypeSel.addEventListener('change', renderExpFields);
  }

  var expCancelBtn = body.querySelector('#comp-exp-add-cancel');
  if (expCancelBtn) {
    expCancelBtn.addEventListener('click', function() {
      expForm.style.display = 'none';
      addExpBtn.style.display = '';
    });
  }

  var expConfirmBtn = body.querySelector('#comp-exp-add-confirm');
  if (expConfirmBtn) {
    expConfirmBtn.addEventListener('click', function() {
      var t = expTypeSel.value;
      var newExp = null;
      if (t === 'file_count') {
        var dir = (body.querySelector('#comp-exp-f-dir') || {}).value || '';
        var pat = (body.querySelector('#comp-exp-f-pattern') || {}).value || '*';
        var min = parseInt((body.querySelector('#comp-exp-f-min') || {}).value) || 1;
        if (!dir) return;
        newExp = { type: 'file_count', directory: dir, pattern: pat, minCount: min };
      } else if (t === 'file_exists') {
        var path = (body.querySelector('#comp-exp-f-path') || {}).value || '';
        var size = parseInt((body.querySelector('#comp-exp-f-size') || {}).value) || 0;
        if (!path) return;
        newExp = { type: 'file_exists', path: path };
        if (size > 0) newExp.minSizeBytes = size;
      } else if (t === 'variable_not_empty') {
        var vname = (body.querySelector('#comp-exp-f-var') || {}).value || '';
        if (!vname) return;
        newExp = { type: 'variable_not_empty', variable: vname };
      } else if (t === 'variable_equals') {
        var vname2 = (body.querySelector('#comp-exp-f-var') || {}).value || '';
        var vval = (body.querySelector('#comp-exp-f-val') || {}).value || '';
        if (!vname2) return;
        newExp = { type: 'variable_equals', variable: vname2, value: vval };
      }
      if (!newExp) return;
      pushUndoSnapshot();
      if (!node.expectations) node.expectations = [];
      node.expectations.push(newExp);
      debouncedSave();
      renderNodeProperties(nodeId);
    });
  }

  // Wire up failure policy dropdown
  var policySelect = body.querySelector('#comp-props-failure-policy');
  var retryConfigDiv = body.querySelector('#comp-props-retry-config');
  if (policySelect) {
    policySelect.addEventListener('change', function() {
      pushUndoSnapshot();
      var action = policySelect.value;
      if (action === 'stop') {
        delete node.onFailure;
      } else if (action === 'skip') {
        node.onFailure = { action: 'skip' };
      } else if (action === 'retry') {
        var maxA = parseInt((body.querySelector('#comp-props-retry-max') || {}).value) || 3;
        var delayS = parseInt((body.querySelector('#comp-props-retry-delay') || {}).value) || 5;
        node.onFailure = { action: 'retry', retry: { maxAttempts: maxA, delayMs: delayS * 1000 } };
      }
      retryConfigDiv.style.display = action === 'retry' ? '' : 'none';
      debouncedSave();
    });
  }

  // Wire up retry config inputs
  var retryMaxInput = body.querySelector('#comp-props-retry-max');
  var retryDelayInput = body.querySelector('#comp-props-retry-delay');
  function updateRetryConfig() {
    if (!node.onFailure || node.onFailure.action !== 'retry') return;
    pushUndoSnapshot();
    var maxA = parseInt((retryMaxInput || {}).value) || 3;
    var delayS = parseInt((retryDelayInput || {}).value) || 5;
    node.onFailure.retry = { maxAttempts: maxA, delayMs: delayS * 1000 };
    debouncedSave();
  }
  if (retryMaxInput) retryMaxInput.addEventListener('change', updateRetryConfig);
  if (retryDelayInput) retryDelayInput.addEventListener('change', updateRetryConfig);

  injectNodeErrorDisplay(body, nodeId);
}

function renderImageViewerProperties(body, node, nodeId) {
  if (!node.imageViewer) node.imageViewer = { filePath: '', width: 300, height: 300 };
  var ivCfg = node.imageViewer;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-iv-label" value="' + compEscAttr(node.label || '') + '" placeholder="Image Viewer">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#a855f7;">&#x1f5bc; Image Viewer</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Displays an image from a file path. Supports {{variable}} syntax.</div>';
  html += '</div>';

  // File Path
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">File Path</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-iv-filepath" value="' + compEscAttr(ivCfg.filePath || '') + '" placeholder="/path/to/image.png or {{variable}}">';

  // Connection info
  var connEdge = compData ? compData.edges.find(function(e) {
    return e.targetNodeId === nodeId && e.targetPort === 'file_path';
  }) : null;
  if (connEdge) {
    var srcNode = compData.nodes.find(function(n) { return n.id === connEdge.sourceNodeId; });
    var srcName = srcNode ? (srcNode.label || srcNode.workflowId) : '?';
    html += '<div style="font-size:0.65rem;color:#64748b;margin-top:2px;">&#x2190; Connected from ' + compEscHtml(srcName) + '.' + compEscHtml(connEdge.sourcePort) + '</div>';
  }
  html += '</div>';

  // Size
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Size</div>';
  html += '<div class="comp-image-viewer-size-row">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">W</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-iv-width" value="' + ivCfg.width + '" min="150" max="800" style="width:70px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">H</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-iv-height" value="' + ivCfg.height + '" min="150" max="800" style="width:70px;">';
  html += '</div>';
  html += '<button class="comp-tb-btn" id="comp-props-iv-reset-size" style="width:100%;margin-top:6px;font-size:0.7rem;">Reset to 300 &times; 300</button>';
  html += '</div>';

  // Preview
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Preview</div>';
  if (ivCfg.filePath) {
    html += '<img class="comp-image-viewer-preview" src="/api/file?path=' + encodeURIComponent(ivCfg.filePath) + '" alt="Preview" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'\'">';
    html += '<div class="comp-image-viewer-placeholder" style="display:none;text-align:center;padding:1rem;color:#475569;font-size:0.72rem;">Failed to load image</div>';
  } else {
    html += '<div style="text-align:center;padding:1rem;color:#475569;font-size:0.72rem;font-style:italic;">Enter a file path above to preview</div>';
  }
  html += '</div>';

  // On Failure
  var currentPolicy = (node.onFailure && node.onFailure.action) || 'stop';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">On Failure</div>';
  html += '<select class="comp-props-input" id="comp-props-iv-failure">';
  html += '<option value="stop"' + (currentPolicy === 'stop' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (currentPolicy === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '</select>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire handlers

  // Display name
  var labelInput = document.querySelector('#comp-props-iv-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = this.value.trim() || undefined;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      immediateSave();
    });
  }

  // File path
  var pathInput = document.querySelector('#comp-props-iv-filepath');
  if (pathInput) {
    var _ivPathTimer = null;
    pathInput.addEventListener('input', function() {
      var val = this.value.trim();
      ivCfg.filePath = val;
      // Debounced re-render so the image loads as user types/pastes
      if (_ivPathTimer) clearTimeout(_ivPathTimer);
      _ivPathTimer = setTimeout(function() {
        renderNodes();
        renderEdges();
        wireUpCanvas();
        renderImageViewerProperties(body, node, nodeId);
        immediateSave();
      }, 400);
    });
    pathInput.addEventListener('change', function() {
      // Immediate update on blur/Enter
      if (_ivPathTimer) clearTimeout(_ivPathTimer);
      ivCfg.filePath = this.value.trim();
      renderNodes();
      renderEdges();
      wireUpCanvas();
      renderImageViewerProperties(body, node, nodeId);
      immediateSave();
    });
  }

  // Width
  var widthInput = document.querySelector('#comp-props-iv-width');
  if (widthInput) {
    widthInput.addEventListener('change', function() {
      var w = parseInt(this.value) || 300;
      w = Math.max(150, Math.min(800, w));
      ivCfg.width = w;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      immediateSave();
    });
  }

  // Height
  var heightInput = document.querySelector('#comp-props-iv-height');
  if (heightInput) {
    heightInput.addEventListener('change', function() {
      var h = parseInt(this.value) || 300;
      h = Math.max(150, Math.min(800, h));
      ivCfg.height = h;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      immediateSave();
    });
  }

  // Reset size
  var resetBtn = document.querySelector('#comp-props-iv-reset-size');
  if (resetBtn) {
    resetBtn.addEventListener('click', function() {
      ivCfg.width = 300;
      ivCfg.height = 300;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      renderImageViewerProperties(body, node, nodeId);
      immediateSave();
    });
  }

  // Failure policy
  var policySelect = document.querySelector('#comp-props-iv-failure');
  if (policySelect) {
    policySelect.addEventListener('change', function() {
      node.onFailure = node.onFailure || {};
      node.onFailure.action = this.value;
      debouncedSave();
    });
  }
}

// ── Media Player Properties ────────────────────────────────────

function renderMediaPlayerProperties(body, node, nodeId) {
  if (!node.mediaPlayer) node.mediaPlayer = { sourceMode: 'file_path', filePath: '', url: '', assetId: '', mediaType: 'auto', width: 320, height: 240, title: '', autoPlay: false, defaultVolume: 1, loop: false, playbackRate: 1, imageFit: 'contain' };
  var cfg = node.mediaPlayer;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-mp-label" value="' + compEscAttr(node.label || '') + '" placeholder="Media Player">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#3b82f6;">&#x25b6; Media Player</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Plays video, audio, images, PDFs, and text files. Supports {{variable}} syntax.</div>';
  html += '</div>';

  // Source Mode
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Source Mode</div>';
  html += '<select class="comp-props-input" id="comp-props-mp-source-mode">';
  html += '<option value="file_path"' + (cfg.sourceMode === 'file_path' ? ' selected' : '') + '>File Path</option>';
  html += '<option value="url"' + (cfg.sourceMode === 'url' ? ' selected' : '') + '>URL</option>';
  html += '<option value="asset_id"' + (cfg.sourceMode === 'asset_id' ? ' selected' : '') + '>Asset ID</option>';
  html += '</select>';
  html += '</div>';

  // Source input (conditional)
  html += '<div class="comp-props-section">';
  if (cfg.sourceMode === 'file_path') {
    html += '<div class="comp-props-label">File Path</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-mp-source" value="' + compEscAttr(cfg.filePath || '') + '" placeholder="/path/to/media.mp4 or {{variable}}">';
  } else if (cfg.sourceMode === 'url') {
    html += '<div class="comp-props-label">URL</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-mp-source" value="' + compEscAttr(cfg.url || '') + '" placeholder="https://example.com/video.mp4 or {{variable}}">';
  } else {
    html += '<div class="comp-props-label">Asset ID</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-mp-source" value="' + compEscAttr(cfg.assetId || '') + '" placeholder="asset-id or {{variable}}">';
  }
  // Connection info
  var connEdge = compData ? compData.edges.find(function(e) {
    return e.targetNodeId === nodeId && e.targetPort === 'file_path';
  }) : null;
  if (connEdge) {
    var srcNode = compData.nodes.find(function(n) { return n.id === connEdge.sourceNodeId; });
    var srcName = srcNode ? (srcNode.label || srcNode.workflowId) : '?';
    html += '<div style="font-size:0.65rem;color:#64748b;margin-top:2px;">&#x2190; Connected from ' + compEscHtml(srcName) + '.' + compEscHtml(connEdge.sourcePort) + '</div>';
  }
  html += '</div>';

  // Media Type
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Media Type</div>';
  html += '<select class="comp-props-input" id="comp-props-mp-media-type">';
  var mtypes = ['auto','image','video','audio','pdf','text'];
  for (var mi = 0; mi < mtypes.length; mi++) {
    html += '<option value="' + mtypes[mi] + '"' + (cfg.mediaType === mtypes[mi] ? ' selected' : '') + '>' + mtypes[mi].charAt(0).toUpperCase() + mtypes[mi].slice(1) + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Size
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Size</div>';
  html += '<div class="comp-image-viewer-size-row">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">W</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-mp-width" value="' + (cfg.width || 320) + '" min="150" max="1200" style="width:70px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">H</span>';
  html += '<input type="number" class="comp-props-input" id="comp-props-mp-height" value="' + (cfg.height || 240) + '" min="100" max="800" style="width:70px;">';
  html += '</div>';
  html += '<button class="comp-tb-btn" id="comp-props-mp-reset-size" style="width:100%;margin-top:6px;font-size:0.7rem;">Reset to 320 &times; 240</button>';
  html += '</div>';

  // Playback options
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Playback</div>';
  html += '<label style="display:flex;align-items:center;gap:6px;font-size:0.72rem;color:#cbd5e1;margin-bottom:4px;cursor:pointer;">';
  html += '<input type="checkbox" id="comp-props-mp-autoplay"' + (cfg.autoPlay ? ' checked' : '') + '> Auto-play';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:6px;font-size:0.72rem;color:#cbd5e1;margin-bottom:4px;cursor:pointer;">';
  html += '<input type="checkbox" id="comp-props-mp-loop"' + (cfg.loop ? ' checked' : '') + '> Loop';
  html += '</label>';
  html += '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">Volume</span>';
  html += '<input type="range" id="comp-props-mp-volume" min="0" max="1" step="0.05" value="' + (cfg.defaultVolume != null ? cfg.defaultVolume : 1) + '" style="flex:1;accent-color:#3b82f6;">';
  html += '<span id="comp-props-mp-volume-val" style="font-size:0.65rem;color:#64748b;min-width:28px;">' + Math.round((cfg.defaultVolume != null ? cfg.defaultVolume : 1) * 100) + '%</span>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">Speed</span>';
  html += '<select class="comp-props-input" id="comp-props-mp-speed" style="flex:1;">';
  var speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  for (var si = 0; si < speeds.length; si++) {
    html += '<option value="' + speeds[si] + '"' + (cfg.playbackRate === speeds[si] ? ' selected' : '') + '>' + speeds[si] + 'x</option>';
  }
  html += '</select>';
  html += '</div>';
  html += '</div>';

  // Image Fit (only relevant for images)
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Image Fit</div>';
  html += '<select class="comp-props-input" id="comp-props-mp-image-fit">';
  html += '<option value="contain"' + (cfg.imageFit === 'contain' ? ' selected' : '') + '>Contain</option>';
  html += '<option value="cover"' + (cfg.imageFit === 'cover' ? ' selected' : '') + '>Cover</option>';
  html += '<option value="actual"' + (cfg.imageFit === 'actual' ? ' selected' : '') + '>Actual Size</option>';
  html += '</select>';
  html += '</div>';

  // On Failure
  var currentPolicy = (node.onFailure && node.onFailure.action) || 'stop';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">On Failure</div>';
  html += '<select class="comp-props-input" id="comp-props-mp-failure">';
  html += '<option value="stop"' + (currentPolicy === 'stop' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (currentPolicy === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '</select>';
  html += '</div>';

  html += renderIdempotencySection(node);

  // Preview container
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Preview</div>';
  html += '<div id="comp-props-mp-preview" class="comp-mp-preview-container"></div>';
  html += '</div>';

  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Build preview
  var previewContainer = document.querySelector('#comp-props-mp-preview');
  if (previewContainer) {
    var resolvedSrc = '';
    if (cfg.sourceMode === 'file_path' && cfg.filePath) resolvedSrc = '/api/file?path=' + encodeURIComponent(cfg.filePath);
    else if (cfg.sourceMode === 'url' && cfg.url) resolvedSrc = cfg.url;
    var detectedType = detectMediaTypeFromExt(cfg.filePath || cfg.url || '', cfg.mediaType);

    if (resolvedSrc && detectedType === 'video') {
      buildVideoPlayer(previewContainer, resolvedSrc, cfg);
    } else if (resolvedSrc && detectedType === 'audio') {
      buildAudioPlayer(previewContainer, resolvedSrc, cfg);
    } else if (resolvedSrc && detectedType === 'image') {
      buildImageViewer(previewContainer, resolvedSrc, cfg);
    } else if (resolvedSrc && detectedType === 'pdf') {
      buildPdfViewer(previewContainer, resolvedSrc);
    } else if (resolvedSrc && detectedType === 'text') {
      buildTextViewer(previewContainer, resolvedSrc);
    } else if (!resolvedSrc) {
      previewContainer.innerHTML = '<div style="text-align:center;padding:1rem;color:#475569;font-size:0.72rem;font-style:italic;">Configure a source to preview</div>';
    } else {
      previewContainer.innerHTML = '<div style="text-align:center;padding:1rem;color:#475569;font-size:0.72rem;font-style:italic;">Unknown media type</div>';
    }
  }

  // Wire handlers
  var labelInput = document.querySelector('#comp-props-mp-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = this.value.trim() || undefined;
      renderNodes(); renderEdges(); wireUpCanvas(); immediateSave();
    });
  }

  var srcModeSelect = document.querySelector('#comp-props-mp-source-mode');
  if (srcModeSelect) {
    srcModeSelect.addEventListener('change', function() {
      cfg.sourceMode = this.value;
      debouncedSave();
      renderMediaPlayerProperties(body, node, nodeId);
    });
  }

  var sourceInput = document.querySelector('#comp-props-mp-source');
  if (sourceInput) {
    var _mpPathTimer = null;
    sourceInput.addEventListener('input', function() {
      var val = this.value.trim();
      if (cfg.sourceMode === 'file_path') cfg.filePath = val;
      else if (cfg.sourceMode === 'url') cfg.url = val;
      else cfg.assetId = val;
      if (_mpPathTimer) clearTimeout(_mpPathTimer);
      _mpPathTimer = setTimeout(function() {
        renderNodes(); renderEdges(); wireUpCanvas();
        renderMediaPlayerProperties(body, node, nodeId);
        immediateSave();
      }, 500);
    });
  }

  var mtypeSelect = document.querySelector('#comp-props-mp-media-type');
  if (mtypeSelect) {
    mtypeSelect.addEventListener('change', function() {
      cfg.mediaType = this.value;
      renderNodes(); renderEdges(); wireUpCanvas();
      renderMediaPlayerProperties(body, node, nodeId);
      immediateSave();
    });
  }

  var widthInput = document.querySelector('#comp-props-mp-width');
  if (widthInput) {
    widthInput.addEventListener('change', function() {
      cfg.width = Math.max(150, Math.min(1200, parseInt(this.value) || 320));
      renderNodes(); renderEdges(); wireUpCanvas(); immediateSave();
    });
  }
  var heightInput = document.querySelector('#comp-props-mp-height');
  if (heightInput) {
    heightInput.addEventListener('change', function() {
      cfg.height = Math.max(100, Math.min(800, parseInt(this.value) || 240));
      renderNodes(); renderEdges(); wireUpCanvas(); immediateSave();
    });
  }
  var resetSizeBtn = document.querySelector('#comp-props-mp-reset-size');
  if (resetSizeBtn) {
    resetSizeBtn.addEventListener('click', function() {
      cfg.width = 320; cfg.height = 240;
      renderNodes(); renderEdges(); wireUpCanvas();
      renderMediaPlayerProperties(body, node, nodeId); immediateSave();
    });
  }

  var autoplayCheck = document.querySelector('#comp-props-mp-autoplay');
  if (autoplayCheck) autoplayCheck.addEventListener('change', function() { cfg.autoPlay = this.checked; debouncedSave(); });

  var loopCheck = document.querySelector('#comp-props-mp-loop');
  if (loopCheck) loopCheck.addEventListener('change', function() { cfg.loop = this.checked; debouncedSave(); });

  var volumeRange = document.querySelector('#comp-props-mp-volume');
  var volumeVal = document.querySelector('#comp-props-mp-volume-val');
  if (volumeRange) {
    volumeRange.addEventListener('input', function() {
      cfg.defaultVolume = parseFloat(this.value);
      if (volumeVal) volumeVal.textContent = Math.round(cfg.defaultVolume * 100) + '%';
      debouncedSave();
    });
  }

  var speedSelect = document.querySelector('#comp-props-mp-speed');
  if (speedSelect) speedSelect.addEventListener('change', function() { cfg.playbackRate = parseFloat(this.value); debouncedSave(); });

  var fitSelect = document.querySelector('#comp-props-mp-image-fit');
  if (fitSelect) fitSelect.addEventListener('change', function() { cfg.imageFit = this.value; debouncedSave(); });

  var failureSelect = document.querySelector('#comp-props-mp-failure');
  if (failureSelect) {
    failureSelect.addEventListener('change', function() {
      node.onFailure = node.onFailure || {};
      node.onFailure.action = this.value;
      debouncedSave();
    });
  }
}

// ── Enterprise Media Player Builders ────────────────────────────

function buildVideoPlayer(container, src, cfg) {
  var wrap = document.createElement('div');
  wrap.className = 'comp-mp-video-wrap';

  var video = document.createElement('video');
  video.src = src;
  video.preload = 'metadata';
  video.style.width = '100%';
  video.style.maxHeight = '300px';
  video.style.borderRadius = '4px';
  video.style.background = '#000';
  if (cfg.autoPlay) video.autoplay = true;
  if (cfg.loop) video.loop = true;
  video.volume = cfg.defaultVolume != null ? cfg.defaultVolume : 1;
  video.playbackRate = cfg.playbackRate || 1;
  wrap.appendChild(video);

  // Control bar
  var controls = document.createElement('div');
  controls.className = 'comp-mp-controls';

  // Play/Pause
  var playBtn = document.createElement('button');
  playBtn.className = 'comp-mp-btn';
  playBtn.textContent = '\u25B6';
  playBtn.title = 'Play/Pause';
  playBtn.onclick = function() {
    if (video.paused) { video.play(); playBtn.textContent = '\u23F8'; }
    else { video.pause(); playBtn.textContent = '\u25B6'; }
  };
  video.addEventListener('play', function() { playBtn.textContent = '\u23F8'; });
  video.addEventListener('pause', function() { playBtn.textContent = '\u25B6'; });
  controls.appendChild(playBtn);

  // Time display
  var timeDisplay = document.createElement('span');
  timeDisplay.className = 'comp-mp-time';
  timeDisplay.textContent = '0:00 / 0:00';
  controls.appendChild(timeDisplay);

  // Seek bar
  var seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.className = 'comp-mp-seek';
  seekBar.min = '0';
  seekBar.max = '1000';
  seekBar.value = '0';
  seekBar.addEventListener('input', function() {
    if (video.duration) video.currentTime = (seekBar.value / 1000) * video.duration;
  });
  controls.appendChild(seekBar);

  video.addEventListener('timeupdate', function() {
    if (video.duration) {
      seekBar.value = Math.round((video.currentTime / video.duration) * 1000);
      timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
    }
  });
  video.addEventListener('loadedmetadata', function() {
    timeDisplay.textContent = '0:00 / ' + formatTime(video.duration);
  });

  // Mute toggle
  var muteBtn = document.createElement('button');
  muteBtn.className = 'comp-mp-btn';
  muteBtn.textContent = '\uD83D\uDD0A';
  muteBtn.title = 'Mute/Unmute';
  muteBtn.onclick = function() {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
  };
  controls.appendChild(muteBtn);

  // Volume slider
  var volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.className = 'comp-mp-volume';
  volSlider.min = '0';
  volSlider.max = '1';
  volSlider.step = '0.05';
  volSlider.value = String(video.volume);
  volSlider.addEventListener('input', function() { video.volume = parseFloat(volSlider.value); });
  controls.appendChild(volSlider);

  // Speed selector
  var speedSel = document.createElement('select');
  speedSel.className = 'comp-mp-speed';
  var speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  for (var i = 0; i < speeds.length; i++) {
    var opt = document.createElement('option');
    opt.value = String(speeds[i]);
    opt.textContent = speeds[i] + 'x';
    if (speeds[i] === (cfg.playbackRate || 1)) opt.selected = true;
    speedSel.appendChild(opt);
  }
  speedSel.addEventListener('change', function() { video.playbackRate = parseFloat(speedSel.value); });
  controls.appendChild(speedSel);

  // Picture-in-Picture
  if (document.pictureInPictureEnabled) {
    var pipBtn = document.createElement('button');
    pipBtn.className = 'comp-mp-btn';
    pipBtn.textContent = '\uD83D\uDDBC';
    pipBtn.title = 'Picture-in-Picture';
    pipBtn.onclick = function() {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else video.requestPictureInPicture();
    };
    controls.appendChild(pipBtn);
  }

  // Fullscreen
  var fsBtn = document.createElement('button');
  fsBtn.className = 'comp-mp-btn';
  fsBtn.textContent = '\u26F6';
  fsBtn.title = 'Fullscreen';
  fsBtn.onclick = function() {
    if (video.requestFullscreen) video.requestFullscreen();
    else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
  };
  controls.appendChild(fsBtn);

  wrap.appendChild(controls);
  container.appendChild(wrap);
}

function buildAudioPlayer(container, src, cfg) {
  var wrap = document.createElement('div');
  wrap.className = 'comp-mp-audio-wrap';

  var audio = document.createElement('audio');
  audio.src = src;
  audio.preload = 'metadata';
  if (cfg.autoPlay) audio.autoplay = true;
  if (cfg.loop) audio.loop = true;
  audio.volume = cfg.defaultVolume != null ? cfg.defaultVolume : 1;
  audio.playbackRate = cfg.playbackRate || 1;
  wrap.appendChild(audio);

  // Progress visualization bar
  var progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'width:100%;height:40px;background:#0a0a0f;border-radius:4px;border:1px solid #1e293b;position:relative;overflow:hidden;cursor:pointer;';
  var progressBar = document.createElement('div');
  progressBar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#22c55e44,#22c55e88);transition:width 0.1s;';
  progressWrap.appendChild(progressBar);
  var waveLabel = document.createElement('div');
  waveLabel.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#22c55e;font-size:0.7rem;pointer-events:none;';
  waveLabel.textContent = '\uD83C\uDFB5 Audio';
  progressWrap.appendChild(waveLabel);
  progressWrap.addEventListener('click', function(e) {
    if (audio.duration) {
      var rect = progressWrap.getBoundingClientRect();
      var pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    }
  });
  wrap.appendChild(progressWrap);

  audio.addEventListener('timeupdate', function() {
    if (audio.duration) progressBar.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
  });

  // Controls
  var controls = document.createElement('div');
  controls.className = 'comp-mp-controls';

  var playBtn = document.createElement('button');
  playBtn.className = 'comp-mp-btn';
  playBtn.textContent = '\u25B6';
  playBtn.onclick = function() {
    if (audio.paused) { audio.play(); playBtn.textContent = '\u23F8'; }
    else { audio.pause(); playBtn.textContent = '\u25B6'; }
  };
  audio.addEventListener('play', function() { playBtn.textContent = '\u23F8'; });
  audio.addEventListener('pause', function() { playBtn.textContent = '\u25B6'; });
  controls.appendChild(playBtn);

  var timeDisplay = document.createElement('span');
  timeDisplay.className = 'comp-mp-time';
  timeDisplay.textContent = '0:00 / 0:00';
  audio.addEventListener('timeupdate', function() {
    if (audio.duration) timeDisplay.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
  });
  audio.addEventListener('loadedmetadata', function() {
    timeDisplay.textContent = '0:00 / ' + formatTime(audio.duration);
  });
  controls.appendChild(timeDisplay);

  // Seek bar
  var seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.className = 'comp-mp-seek';
  seekBar.min = '0'; seekBar.max = '1000'; seekBar.value = '0';
  seekBar.addEventListener('input', function() {
    if (audio.duration) audio.currentTime = (seekBar.value / 1000) * audio.duration;
  });
  audio.addEventListener('timeupdate', function() {
    if (audio.duration) seekBar.value = Math.round((audio.currentTime / audio.duration) * 1000);
  });
  controls.appendChild(seekBar);

  // Volume
  var volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.className = 'comp-mp-volume';
  volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05';
  volSlider.value = String(audio.volume);
  volSlider.addEventListener('input', function() { audio.volume = parseFloat(volSlider.value); });
  controls.appendChild(volSlider);

  // Speed
  var speedSel = document.createElement('select');
  speedSel.className = 'comp-mp-speed';
  var speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  for (var i = 0; i < speeds.length; i++) {
    var opt = document.createElement('option');
    opt.value = String(speeds[i]); opt.textContent = speeds[i] + 'x';
    if (speeds[i] === (cfg.playbackRate || 1)) opt.selected = true;
    speedSel.appendChild(opt);
  }
  speedSel.addEventListener('change', function() { audio.playbackRate = parseFloat(speedSel.value); });
  controls.appendChild(speedSel);

  wrap.appendChild(controls);
  container.appendChild(wrap);
}

function buildImageViewer(container, src, cfg) {
  var wrap = document.createElement('div');
  wrap.className = 'comp-mp-image-wrap';
  wrap.style.cssText = 'position:relative;overflow:hidden;border-radius:4px;border:1px solid #1e293b;background:#0a0a0f;max-height:400px;';

  var imgContainer = document.createElement('div');
  imgContainer.style.cssText = 'overflow:hidden;cursor:grab;max-height:360px;display:flex;align-items:center;justify-content:center;';

  var img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:100%;max-height:360px;object-fit:' + (cfg.imageFit === 'cover' ? 'cover' : 'contain') + ';transition:transform 0.15s;';
  if (cfg.imageFit === 'actual') img.style.cssText = 'transition:transform 0.15s;cursor:grab;';
  img.onerror = function() { imgContainer.innerHTML = '<div style="text-align:center;padding:1rem;color:#ef4444;font-size:0.72rem;">Failed to load image</div>'; };
  imgContainer.appendChild(img);
  wrap.appendChild(imgContainer);

  var zoom = 1;
  var rotation = 0;
  var panX = 0, panY = 0;
  var isPanning = false, startX = 0, startY = 0;

  function updateTransform() {
    img.style.transform = 'scale(' + zoom + ') rotate(' + rotation + 'deg) translate(' + panX + 'px,' + panY + 'px)';
  }

  // Mouse wheel zoom
  imgContainer.addEventListener('wheel', function(e) {
    e.preventDefault();
    zoom += e.deltaY < 0 ? 0.1 : -0.1;
    zoom = Math.max(0.1, Math.min(10, zoom));
    updateTransform();
  });

  // Pan with drag
  imgContainer.addEventListener('mousedown', function(e) {
    isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY;
    imgContainer.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', function(e) {
    if (!isPanning) return;
    panX = e.clientX - startX; panY = e.clientY - startY;
    updateTransform();
  });
  document.addEventListener('mouseup', function() {
    isPanning = false; imgContainer.style.cursor = 'grab';
  });

  // Controls
  var controls = document.createElement('div');
  controls.className = 'comp-mp-controls';

  var zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'comp-mp-btn'; zoomInBtn.textContent = '+'; zoomInBtn.title = 'Zoom In';
  zoomInBtn.onclick = function() { zoom = Math.min(10, zoom + 0.25); updateTransform(); };
  controls.appendChild(zoomInBtn);

  var zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'comp-mp-btn'; zoomOutBtn.textContent = '\u2212'; zoomOutBtn.title = 'Zoom Out';
  zoomOutBtn.onclick = function() { zoom = Math.max(0.1, zoom - 0.25); updateTransform(); };
  controls.appendChild(zoomOutBtn);

  var fitBtn = document.createElement('button');
  fitBtn.className = 'comp-mp-btn'; fitBtn.textContent = '\u2922'; fitBtn.title = 'Fit to View';
  fitBtn.onclick = function() { zoom = 1; panX = 0; panY = 0; updateTransform(); };
  controls.appendChild(fitBtn);

  // Fit mode selector
  var fitSel = document.createElement('select');
  fitSel.className = 'comp-mp-speed';
  var fitModes = [['contain','Contain'],['cover','Cover'],['actual','Actual']];
  for (var i = 0; i < fitModes.length; i++) {
    var opt = document.createElement('option');
    opt.value = fitModes[i][0]; opt.textContent = fitModes[i][1];
    if (fitModes[i][0] === (cfg.imageFit || 'contain')) opt.selected = true;
    fitSel.appendChild(opt);
  }
  fitSel.addEventListener('change', function() {
    var mode = fitSel.value;
    if (mode === 'actual') img.style.objectFit = '';
    else img.style.objectFit = mode;
  });
  controls.appendChild(fitSel);

  // Rotate
  var rotateBtn = document.createElement('button');
  rotateBtn.className = 'comp-mp-btn'; rotateBtn.textContent = '\u21BB'; rotateBtn.title = 'Rotate 90\u00B0';
  rotateBtn.onclick = function() { rotation = (rotation + 90) % 360; updateTransform(); };
  controls.appendChild(rotateBtn);

  // Fullscreen
  var fsBtn = document.createElement('button');
  fsBtn.className = 'comp-mp-btn'; fsBtn.textContent = '\u26F6'; fsBtn.title = 'Fullscreen';
  fsBtn.onclick = function() {
    if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
  };
  controls.appendChild(fsBtn);

  wrap.appendChild(controls);
  container.appendChild(wrap);
}

function buildPdfViewer(container, src) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;border-radius:4px;overflow:hidden;border:1px solid #1e293b;';

  var iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.style.cssText = 'width:100%;height:350px;border:none;background:#fff;';
  wrap.appendChild(iframe);

  var controls = document.createElement('div');
  controls.className = 'comp-mp-controls';
  var fsBtn = document.createElement('button');
  fsBtn.className = 'comp-mp-btn'; fsBtn.textContent = '\u26F6'; fsBtn.title = 'Fullscreen';
  fsBtn.onclick = function() {
    if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
  };
  controls.appendChild(fsBtn);
  wrap.appendChild(controls);
  container.appendChild(wrap);
}

function buildTextViewer(container, src) {
  var wrap = document.createElement('div');
  wrap.className = 'comp-mp-text-wrap';
  wrap.style.cssText = 'border-radius:4px;border:1px solid #1e293b;background:#0a0a0f;overflow:auto;max-height:350px;position:relative;';

  var content = document.createElement('div');
  content.style.cssText = 'display:flex;font-family:monospace;font-size:0.72rem;line-height:1.5;';

  var lineNums = document.createElement('div');
  lineNums.className = 'comp-mp-line-num';
  lineNums.style.cssText = 'min-width:36px;padding:8px 6px 8px 8px;color:#475569;text-align:right;user-select:none;border-right:1px solid #1e293b;';

  var codeBlock = document.createElement('pre');
  codeBlock.style.cssText = 'flex:1;margin:0;padding:8px;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;overflow-x:auto;';

  content.appendChild(lineNums);
  content.appendChild(codeBlock);
  wrap.appendChild(content);
  container.appendChild(wrap);

  // Fetch content
  fetch(src)
    .then(function(r) { return r.text(); })
    .then(function(text) {
      codeBlock.textContent = text;
      var lines = text.split('\n');
      var nums = '';
      for (var i = 1; i <= lines.length; i++) nums += i + '\n';
      lineNums.textContent = nums;
    })
    .catch(function() {
      codeBlock.textContent = 'Failed to load file';
      codeBlock.style.color = '#ef4444';
    });

  // Controls
  var controls = document.createElement('div');
  controls.className = 'comp-mp-controls';
  controls.style.marginTop = '0';

  var wrapToggle = document.createElement('button');
  wrapToggle.className = 'comp-mp-btn';
  wrapToggle.textContent = 'Wrap';
  wrapToggle.title = 'Toggle Word Wrap';
  var wrapped = true;
  wrapToggle.onclick = function() {
    wrapped = !wrapped;
    codeBlock.style.whiteSpace = wrapped ? 'pre-wrap' : 'pre';
    wrapToggle.style.color = wrapped ? '#3b82f6' : '#94a3b8';
  };
  controls.appendChild(wrapToggle);

  wrap.appendChild(controls);
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ── Flow Control Property Renderers ────────────────────────────

function renderBranchProperties(body, node, nodeId) {
  if (!node.branchNode) node.branchNode = { condition: '{{value}} > 0' };
  var cfg = node.branchNode;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-branch-label" value="' + compEscAttr(node.label || '') + '" placeholder="Branch">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#f59e0b;">&#x2194; Branch (If/Else)</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Routes execution based on a condition. Use {{variable}} to reference upstream values.</div>';
  html += '</div>';

  // Condition
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Condition Expression</div>';
  html += '<textarea class="comp-props-input" id="comp-props-branch-condition" rows="3" style="font-family:monospace;font-size:0.75rem;" placeholder="{{count}} > 0">' + compEscHtml(cfg.condition || '') + '</textarea>';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:0.2rem;">Use <code style="color:#c4b5fd;">{{variable}}</code> syntax. Evaluated as truthy/falsy. Also accepts direct input via the <code>condition</code> port.</div>';
  html += '</div>';

  // Ports info
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  html += '<div style="font-size:0.7rem;color:#94a3b8;"><span style="color:#22c55e;">True</span> — executes when condition is truthy<br><span style="color:#ef4444;">False</span> — executes when condition is falsy</div>';
  html += '</div>';

  body.innerHTML = html;

  // Wire events
  var labelInput = document.querySelector('#comp-props-branch-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = this.value || '';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var condInput = document.querySelector('#comp-props-branch-condition');
  if (condInput) {
    condInput.addEventListener('input', function() {
      cfg.condition = this.value;
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }
}

function renderDelayProperties(body, node, nodeId) {
  if (!node.delayNode) node.delayNode = { delayMs: 1000 };
  var cfg = node.delayNode;
  var html = '';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-delay-label" value="' + compEscAttr(node.label || '') + '" placeholder="Delay">';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#06b6d4;">&#x23f3; Delay</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Pauses execution for a duration, then passes all inputs through.</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Delay (ms)</div>';
  html += '<input type="number" class="comp-props-input" id="comp-props-delay-ms" value="' + (cfg.delayMs || 1000) + '" min="0" step="100">';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:0.2rem;">Can be overridden via the <code>delay_ms</code> input port.</div>';
  html += '</div>';

  body.innerHTML = html;

  var labelInput = document.querySelector('#comp-props-delay-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = this.value || '';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var msInput = document.querySelector('#comp-props-delay-ms');
  if (msInput) {
    msInput.addEventListener('change', function() {
      cfg.delayMs = Math.max(0, parseInt(this.value) || 1000);
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }
}

function renderGateNodeProperties(body, node, nodeId) {
  if (!node.gateNode) node.gateNode = { defaultOpen: true, onClosed: 'skip' };
  var cfg = node.gateNode;
  var html = '';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-gatenode-label" value="' + compEscAttr(node.label || '') + '" placeholder="Gate">';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#14b8a6;">&#x26d4; Gate (Conditional Pass-Through)</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">If open, passes data through. If closed, skips downstream or stops pipeline.</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Default Open</div>';
  html += '<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;color:#e2e8f0;">';
  html += '<input type="checkbox" id="comp-props-gatenode-open"' + (cfg.defaultOpen ? ' checked' : '') + '>';
  html += 'Gate is open by default</label>';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:0.2rem;">Can be overridden via the <code>open</code> input port (truthy = open).</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">When Closed</div>';
  html += '<select class="comp-props-input" id="comp-props-gatenode-onclosed">';
  html += '<option value="skip"' + (cfg.onClosed === 'skip' ? ' selected' : '') + '>Skip downstream nodes</option>';
  html += '<option value="stop"' + (cfg.onClosed === 'stop' ? ' selected' : '') + '>Stop entire pipeline</option>';
  html += '<option value="fail"' + (cfg.onClosed === 'fail' ? ' selected' : '') + '>Fail pipeline (mark as error)</option>';
  html += '</select>';
  html += '</div>';

  body.innerHTML = html;

  var labelInput = document.querySelector('#comp-props-gatenode-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = this.value || '';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var openCheck = document.querySelector('#comp-props-gatenode-open');
  if (openCheck) {
    openCheck.addEventListener('change', function() {
      cfg.defaultOpen = this.checked;
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var closedSelect = document.querySelector('#comp-props-gatenode-onclosed');
  if (closedSelect) {
    closedSelect.addEventListener('change', function() {
      cfg.onClosed = this.value;
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }
}

function renderForEachProperties(body, node, nodeId) {
  if (!node.forEachNode) node.forEachNode = { itemVariable: 'item', maxIterations: 100 };
  var cfg = node.forEachNode;
  var html = '';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-foreach-label" value="' + compEscAttr(node.label || '') + '" placeholder="ForEach Loop">';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#22c55e;">&#x1f504; ForEach Loop</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#94a3b8;line-height:1.5;">';
  html += 'Iterates over an array. Nodes connected to <b style="color:#22c55e;">Loop Body</b> ports ';
  html += '(Item, Index, Count) execute <b>once per element</b>. Nodes connected to ';
  html += '<b style="color:#38bdf8;">Completed</b> ports (Results, Total Count) execute after all iterations.';
  html += '</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Item Variable Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-foreach-var" value="' + compEscAttr(cfg.itemVariable || 'item') + '" placeholder="item">';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Max Iterations</div>';
  html += '<input type="number" class="comp-props-input" id="comp-props-foreach-max" value="' + (cfg.maxIterations || 100) + '" min="1" max="10000">';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:0.2rem;">Safety cap to prevent infinite loops.</div>';
  html += '</div>';

  body.innerHTML = html;

  var labelInput = document.querySelector('#comp-props-foreach-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = this.value || '';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var varInput = document.querySelector('#comp-props-foreach-var');
  if (varInput) {
    varInput.addEventListener('input', function() {
      cfg.itemVariable = this.value || 'item';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  var maxInput = document.querySelector('#comp-props-foreach-max');
  if (maxInput) {
    maxInput.addEventListener('change', function() {
      cfg.maxIterations = Math.max(1, Math.min(10000, parseInt(this.value) || 100));
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }
}

// ── Variable Node Properties ──────────────────────────────────

function renderVariableProperties(body, node, nodeId) {
  if (!node.variableNode) node.variableNode = { type: 'string', initialValue: '', exposeAsInput: false, inputName: '', description: '', required: false, generationPrompt: '' };
  var cfg = node.variableNode;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="Variable">';
  html += '</div>';

  // Type selector
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Type</div>';
  html += '<select id="comp-props-var-type" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
  var varTypes = ['string', 'number', 'array', 'boolean'];
  var varTypeLabels = { string: 'String', number: 'Number', array: 'Array', boolean: 'Boolean' };
  for (var i = 0; i < varTypes.length; i++) {
    html += '<option value="' + varTypes[i] + '"' + (cfg.type === varTypes[i] ? ' selected' : '') + '>' + varTypeLabels[varTypes[i]] + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Expose as pipeline input
  html += '<div class="comp-props-section">';
  html += '<label style="display:flex;align-items:center;gap:0.5rem;font-size:12px;color:#cbd5e1;cursor:pointer;">';
  html += '<input type="checkbox" id="comp-props-var-expose"' + (cfg.exposeAsInput ? ' checked' : '') + '>';
  html += '<span>Expose as pipeline input</span>';
  html += '</label>';
  html += '<div style="font-size:0.65rem;color:#64748b;margin-top:4px;line-height:1.35;">Declare this variable once in the generated run form, then wire its value to any number of downstream nodes.</div>';
  html += '</div>';

  if (cfg.exposeAsInput) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Input Name</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-var-input-name" value="' + compEscAttr(cfg.inputName || '') + '" placeholder="formatType">';
    html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;">Stable key used by the pipeline form and run payload.</div>';
    html += '</div>';

    html += '<div class="comp-props-section">';
    html += '<label style="display:flex;align-items:center;gap:0.5rem;font-size:12px;color:#cbd5e1;cursor:pointer;">';
    html += '<input type="checkbox" id="comp-props-var-required"' + (cfg.required ? ' checked' : '') + '>';
    html += '<span>Required in pipeline form</span>';
    html += '</label>';
    html += '</div>';

    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Input Description</div>';
    html += '<textarea id="comp-props-var-description" style="width:100%;min-height:60px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;resize:vertical;">' + compEscHtml(cfg.description || '') + '</textarea>';
    html += '</div>';

    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">AI Generation Prompt</div>';
    html += '<textarea id="comp-props-var-gen-prompt" style="width:100%;min-height:70px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;resize:vertical;" placeholder="Describe how AI should generate this field for the run form...">' + compEscHtml(cfg.generationPrompt || '') + '</textarea>';
    html += '</div>';
  }

  // Initial/default value
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">' + (cfg.exposeAsInput ? 'Default Value' : 'Initial Value') + '</div>';
  if (cfg.type === 'array') {
    html += '<textarea id="comp-props-var-init" style="width:100%;min-height:80px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;font-family:monospace;outline:none;resize:vertical;">' + compEscHtml(cfg.initialValue) + '</textarea>';
    html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;">JSON array, e.g. [] or ["a","b"]</div>';
  } else if (cfg.type === 'boolean') {
    html += '<select id="comp-props-var-init" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
    html += '<option value="false"' + (cfg.initialValue !== 'true' ? ' selected' : '') + '>false</option>';
    html += '<option value="true"' + (cfg.initialValue === 'true' ? ' selected' : '') + '>true</option>';
    html += '</select>';
  } else {
    html += '<input type="text" class="comp-props-input" id="comp-props-var-init" value="' + compEscAttr(cfg.initialValue) + '" placeholder="' + (cfg.type === 'number' ? '0' : '') + '">';
  }
  html += '</div>';

  // Port documentation
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Input Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">set \u2014 Completely replace the variable value</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">push \u2014 Append item to array (auto-creates array if needed)</div>';
  html += '</div>';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">value \u2014 Current value of the variable</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">length \u2014 Length of array or string</div>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire display name
  var labelInput = document.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = labelInput.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }

  // Wire type selector
  var typeSelect = document.querySelector('#comp-props-var-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', function() {
      cfg.type = typeSelect.value;
      // Reset initial value to sensible default when type changes
      var defaults = { string: '', number: '0', array: '[]', boolean: 'false' };
      cfg.initialValue = defaults[cfg.type] || '';
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
      renderVariableProperties(body, node, nodeId);
    });
  }

  var exposeInput = document.querySelector('#comp-props-var-expose');
  if (exposeInput) {
    exposeInput.addEventListener('change', function() {
      cfg.exposeAsInput = !!exposeInput.checked;
      if (cfg.exposeAsInput && !String(cfg.inputName || '').trim()) {
        cfg.inputName = String(node.label || 'value')
          .trim()
          .replace(/[^a-zA-Z0-9]+(.)/g, function(_m, chr) { return String(chr || '').toUpperCase(); })
          .replace(/^[^a-zA-Z_]+/, '')
          .replace(/[^a-zA-Z0-9_]/g, '') || 'inputValue';
      }
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
      renderVariableProperties(body, node, nodeId);
    });
  }

  var inputNameInput = document.querySelector('#comp-props-var-input-name');
  if (inputNameInput) {
    inputNameInput.addEventListener('input', function() {
      cfg.inputName = inputNameInput.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }

  var requiredInput = document.querySelector('#comp-props-var-required');
  if (requiredInput) {
    requiredInput.addEventListener('change', function() {
      cfg.required = !!requiredInput.checked;
      immediateSave();
    });
  }

  var descriptionInput = document.querySelector('#comp-props-var-description');
  if (descriptionInput) {
    descriptionInput.addEventListener('input', function() {
      cfg.description = descriptionInput.value;
      immediateSave();
    });
  }

  var genPromptInput = document.querySelector('#comp-props-var-gen-prompt');
  if (genPromptInput) {
    genPromptInput.addEventListener('input', function() {
      cfg.generationPrompt = genPromptInput.value;
      immediateSave();
    });
  }

  // Wire initial value
  var initInput = document.querySelector('#comp-props-var-init');
  if (initInput) {
    initInput.addEventListener('input', function() {
      cfg.initialValue = initInput.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
    if (initInput.tagName === 'SELECT') {
      initInput.addEventListener('change', function() {
        cfg.initialValue = initInput.value;
        immediateSave();
      });
    }
  }
}

// ── Get Variable Node Properties ──────────────────────────────

function renderGetVariableProperties(body, node, nodeId) {
  if (!node.getVariableNode) node.getVariableNode = { targetNodeId: '' };
  var cfg = node.getVariableNode;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="Get Variable">';
  html += '</div>';

  // Target Variable — dropdown of all Variable nodes in this composition
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Target Variable</div>';
  html += '<select class="comp-props-input" id="comp-props-getvar-target" style="width:100%;">';
  html += '<option value="">— Select a Variable —</option>';
  if (compData) {
    var varNodes = compData.nodes.filter(function(n) { return n.workflowId === '__variable__'; });
    for (var vni = 0; vni < varNodes.length; vni++) {
      var vn = varNodes[vni];
      var vnSelected = cfg.targetNodeId === vn.id ? ' selected' : '';
      var vnLabel = vn.label || 'Variable';
      var vnType = vn.variableNode ? ' (' + vn.variableNode.type + ')' : '';
      html += '<option value="' + compEscAttr(vn.id) + '"' + vnSelected + '>' + compEscHtml(vnLabel + vnType) + '</option>';
    }
  }
  html += '</select>';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;">Reads the current value of the selected Variable node (no wire needed)</div>';
  html += '</div>';

  // Output ports documentation
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;"><b>value</b> \u2014 Current value of the target variable</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;"><b>length</b> \u2014 Length (array items or string chars)</div>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire display name
  var labelInput = document.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = labelInput.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }

  // Wire target selector
  var targetSelect = document.querySelector('#comp-props-getvar-target');
  if (targetSelect) {
    targetSelect.addEventListener('change', function() {
      cfg.targetNodeId = targetSelect.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }
}

function renderTextProperties(body, node, nodeId) {
  if (!node.textNode) node.textNode = { value: '' };
  var html = '';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Text Content</div>';
  html += '<textarea id="comp-props-text-value" style="width:100%;min-height:120px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;font-family:inherit;outline:none;resize:vertical;">' + compEscHtml(node.textNode.value) + '</textarea>';
  html += '</div>';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Port</div>';
  html += '<div style="font-size:12px;color:#64748b;">text — The text content above is output as a string to connected nodes.</div>';
  html += '</div>';
  body.innerHTML = html;

  var textarea = document.querySelector('#comp-props-text-value');
  if (textarea) {
    textarea.addEventListener('input', function() {
      node.textNode.value = textarea.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }
}

function renderJsonKeysProperties(body, node, nodeId) {
  if (!node.jsonKeysNode) node.jsonKeysNode = { defaultPath: '' };
  var cfg = node.jsonKeysNode;

  var html = '';
  // Label
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input class="comp-props-input" id="comp-props-json-keys-label" value="' + compEscAttr(node.label || 'JSON Extract') + '">';
  html += '</div>';

  // Default path
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Default Path</div>';
  html += '<input class="comp-props-input" id="comp-props-json-keys-path" value="' + compEscAttr(cfg.defaultPath || '') + '" placeholder="e.g. categories.0.topics">';
  html += '<div style="font-size:0.65rem;color:#64748b;margin-top:4px;">Dot-notation path to navigate the JSON. Overridden if the <b>path</b> input port is connected.</div>';
  html += '</div>';

  // Description
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#a78bfa;">How it works</div>';
  html += '<div style="font-size:0.68rem;color:#94a3b8;line-height:1.5;">';
  html += 'Parses JSON input and extracts structural info:<br>';
  html += '<b style="color:#e2e8f0;">Keys</b> — array of keys at the resolved path<br>';
  html += '<b style="color:#e2e8f0;">Values</b> — array of values at the resolved path<br>';
  html += '<b style="color:#e2e8f0;">Value</b> — the resolved value (object/array/primitive)<br>';
  html += '<b style="color:#e2e8f0;">Type</b> — "object", "array", "string", "number", etc.<br>';
  html += '<b style="color:#e2e8f0;">Structure</b> — human-readable description of the shape';
  html += '</div>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire events
  var labelInput = document.querySelector('#comp-props-json-keys-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = labelInput.value || 'JSON Extract';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }
  var pathInput = document.querySelector('#comp-props-json-keys-path');
  if (pathInput) {
    pathInput.addEventListener('change', function() {
      cfg.defaultPath = pathInput.value.trim();
      debouncedSave();
    });
  }
}

function renderFileOpProperties(body, node, nodeId) {
  if (!node.fileOp) node.fileOp = { operation: 'copy' };
  var cfg = node.fileOp;
  var opLabels = { copy: 'Copy File', move: 'Move File', delete: 'Delete File', mkdir: 'Create Folder', list: 'List Files' };

  var html = '';

  // Operation selector
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Operation</div>';
  html += '<select id="comp-props-fileop-operation" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
  var ops = ['copy', 'move', 'delete', 'mkdir', 'list'];
  for (var i = 0; i < ops.length; i++) {
    html += '<option value="' + ops[i] + '"' + (cfg.operation === ops[i] ? ' selected' : '') + '>' + opLabels[ops[i]] + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Port info
  var portDescs = {
    copy: { inputs: ['sourcePath — Path of the file to copy', 'destinationPath — Where to copy the file'], outputs: ['outputPath — Path of the copied file', 'success — Whether the operation succeeded'] },
    move: { inputs: ['sourcePath — Path of the file to move', 'destinationPath — Where to move the file'], outputs: ['outputPath — New path of the moved file', 'success — Whether the operation succeeded'] },
    delete: { inputs: ['filePath — Path of the file to delete'], outputs: ['success — Whether the deletion succeeded'] },
    mkdir: { inputs: ['folderPath — Path of the folder to create'], outputs: ['outputPath — Path of the created folder', 'success — Whether the operation succeeded'] },
    list: { inputs: ['folderPath — Path of the folder to list'], outputs: ['files — JSON array of file names', 'count — Number of files found'] },
  };
  var pd = portDescs[cfg.operation] || portDescs.copy;

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Input Ports</div>';
  for (var pi = 0; pi < pd.inputs.length; pi++) {
    html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">' + compEscHtml(pd.inputs[pi]) + '</div>';
  }
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  for (var po = 0; po < pd.outputs.length; po++) {
    html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">' + compEscHtml(pd.outputs[po]) + '</div>';
  }
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire up operation selector
  var opSelect = document.querySelector('#comp-props-fileop-operation');
  if (opSelect) {
    opSelect.addEventListener('change', function() {
      var newOp = opSelect.value;
      if (newOp !== cfg.operation) {
        // Clear edges connected to this node (ports change with operation)
        if (compData && compData.edges) {
          compData.edges = compData.edges.filter(function(e) {
            return e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId;
          });
        }
        cfg.operation = newOp;
        // Update node label to match operation
        node.label = opLabels[newOp] || 'File Op';
        immediateSave();
        renderNodes(); renderEdges(); wireUpCanvas();
        updatePropertiesPanel();
      }
    });
  }
}

function renderFileWriteProperties(body, node, nodeId) {
  if (!node.fileWriteNode) node.fileWriteNode = { mode: 'overwrite', format: 'auto', prettyPrint: true };
  var cfg = node.fileWriteNode;

  var html = '';

  // Mode selector
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Write Mode</div>';
  html += '<select id="comp-props-fw-mode" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
  html += '<option value="overwrite"' + (cfg.mode === 'overwrite' ? ' selected' : '') + '>Overwrite (replace file)</option>';
  html += '<option value="append"' + (cfg.mode === 'append' ? ' selected' : '') + '>Append (add to end)</option>';
  html += '</select>';
  html += '</div>';

  // Format selector
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Content Format</div>';
  html += '<select id="comp-props-fw-format" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
  html += '<option value="auto"' + (cfg.format === 'auto' ? ' selected' : '') + '>Auto (detect JSON objects)</option>';
  html += '<option value="json"' + (cfg.format === 'json' ? ' selected' : '') + '>JSON (always stringify)</option>';
  html += '<option value="text"' + (cfg.format === 'text' ? ' selected' : '') + '>Text (write raw string)</option>';
  html += '</select>';
  html += '</div>';

  // Pretty print toggle
  html += '<div class="comp-props-section">';
  html += '<label style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;">';
  html += '<input type="checkbox" id="comp-props-fw-pretty"' + (cfg.prettyPrint !== false ? ' checked' : '') + ' style="accent-color:#7c3aed;">';
  html += 'Pretty-print JSON (2-space indent)</label>';
  html += '</div>';

  // Port info
  html += '<div class="comp-props-section" style="margin-top:12px;">';
  html += '<div class="comp-props-label">Input Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">filePath — Destination file path (creates directories if needed)</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">content — String or object to write (objects are JSON-stringified)</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">filePath — The path that was written to</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">success — Whether the write succeeded</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">bytesWritten — Number of bytes written</div>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire event handlers
  var modeSelect = document.querySelector('#comp-props-fw-mode');
  if (modeSelect) {
    modeSelect.addEventListener('change', function() {
      cfg.mode = modeSelect.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }
  var formatSelect = document.querySelector('#comp-props-fw-format');
  if (formatSelect) {
    formatSelect.addEventListener('change', function() {
      cfg.format = formatSelect.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }
  var prettyCheck = document.querySelector('#comp-props-fw-pretty');
  if (prettyCheck) {
    prettyCheck.addEventListener('change', function() {
      cfg.prettyPrint = prettyCheck.checked;
      immediateSave();
    });
  }
}

function renderJunctionProperties(body, node, nodeId) {
  if (!node.junctionNode) node.junctionNode = { ports: [] };
  var cfg = node.junctionNode;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-junction-label" value="' + compEscAttr(node.label || '') + '" placeholder="Junction">';
  html += '</div>';

  // Description
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#a78bfa;">&#x26a1; Junction Node</div>';
  html += '<div style="font-size:0.72rem;color:#64748b;">Pass-through hub. Each port appears on both input and output sides. Values flow directly through.</div>';
  html += '</div>';

  // Ports list
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Pass-through Ports (' + cfg.ports.length + ')</div>';

  for (var i = 0; i < cfg.ports.length; i++) {
    var port = cfg.ports[i];
    var inEdge = compData ? compData.edges.find(function(e) { return e.targetNodeId === nodeId && e.targetPort === port.name; }) : null;
    var outEdge = compData ? compData.edges.find(function(e) { return e.sourceNodeId === nodeId && e.sourcePort === port.name; }) : null;

    html += '<div class="comp-junction-port-row">';
    html += '<input type="text" class="comp-props-input comp-junction-port-name" data-port-index="' + i + '" value="' + compEscAttr(port.name) + '" placeholder="port_name" style="flex:1;font-size:0.72rem;">';
    html += '<button class="comp-output-port-remove comp-junction-port-remove" data-port-index="' + i + '" title="Remove port">&times;</button>';
    html += '</div>';

    if (inEdge) {
      var srcNode = compData.nodes.find(function(n) { return n.id === inEdge.sourceNodeId; });
      var srcName = srcNode ? (srcNode.label || srcNode.workflowId) : inEdge.sourceNodeId;
      html += '<div style="font-size:0.6rem;color:#64748b;padding-left:4px;">&#x2190; ' + compEscHtml(srcName) + '.' + compEscHtml(inEdge.sourcePort) + '</div>';
    }
    if (outEdge) {
      var tgtNode = compData.nodes.find(function(n) { return n.id === outEdge.targetNodeId; });
      var tgtName = tgtNode ? (tgtNode.label || tgtNode.workflowId) : outEdge.targetNodeId;
      html += '<div style="font-size:0.6rem;color:#64748b;padding-left:4px;margin-bottom:4px;">&#x2192; ' + compEscHtml(tgtName) + '.' + compEscHtml(outEdge.targetPort) + '</div>';
    }
    if (!inEdge && !outEdge) {
      html += '<div style="font-size:0.6rem;color:#475569;font-style:italic;padding-left:4px;margin-bottom:4px;">unconnected</div>';
    }
  }

  html += '<button class="comp-output-add-port" id="comp-junction-add-port">+ Add Port</button>';
  html += '</div>';

  body.innerHTML = html;

  // Wire handlers
  var labelInput = document.querySelector('#comp-props-junction-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = this.value.trim() || undefined;
      renderNodes(); renderEdges(); wireUpCanvas(); immediateSave();
    });
  }

  // Port name changes
  body.querySelectorAll('.comp-junction-port-name').forEach(function(inp) {
    inp.addEventListener('change', function() {
      var idx = parseInt(this.getAttribute('data-port-index'));
      var oldName = cfg.ports[idx].name;
      var newName = this.value.trim().replace(/[^a-zA-Z0-9_]/g, '_') || ('port_' + idx);
      cfg.ports[idx].name = newName;
      if (compData && oldName !== newName) {
        compData.edges.forEach(function(e) {
          if (e.targetNodeId === nodeId && e.targetPort === oldName) e.targetPort = newName;
          if (e.sourceNodeId === nodeId && e.sourcePort === oldName) e.sourcePort = newName;
        });
      }
      renderNodes(); renderEdges(); wireUpCanvas();
      renderJunctionProperties(body, node, nodeId);
      immediateSave();
    });
  });

  // Remove port
  body.querySelectorAll('.comp-junction-port-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-port-index'));
      var removedName = cfg.ports[idx].name;
      cfg.ports.splice(idx, 1);
      if (compData) {
        compData.edges = compData.edges.filter(function(e) {
          return !(e.targetNodeId === nodeId && e.targetPort === removedName) &&
                 !(e.sourceNodeId === nodeId && e.sourcePort === removedName);
        });
      }
      renderNodes(); renderEdges(); wireUpCanvas();
      renderJunctionProperties(body, node, nodeId);
      immediateSave();
    });
  });

  // Add port
  var addPortBtn = document.querySelector('#comp-junction-add-port');
  if (addPortBtn) {
    addPortBtn.addEventListener('click', function() {
      var portNum = cfg.ports.length + 1;
      cfg.ports.push({ name: 'port_' + portNum, type: 'string', description: '' });
      renderNodes(); renderEdges(); wireUpCanvas();
      renderJunctionProperties(body, node, nodeId);
      immediateSave();
    });
  }
}

function renderFileReadProperties(body, node, nodeId) {
  if (!node.fileReadNode) node.fileReadNode = { parseMode: 'auto' };
  var cfg = node.fileReadNode;

  var html = '';

  // Parse mode selector
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Parse Mode</div>';
  html += '<select id="comp-props-fr-parse" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:13px;">';
  html += '<option value="auto"' + (cfg.parseMode === 'auto' ? ' selected' : '') + '>Auto (try JSON, fall back to string)</option>';
  html += '<option value="json"' + (cfg.parseMode === 'json' ? ' selected' : '') + '>JSON (always parse as JSON)</option>';
  html += '<option value="text"' + (cfg.parseMode === 'text' ? ' selected' : '') + '>Text (always return raw string)</option>';
  html += '</select>';
  html += '</div>';

  // Port info
  html += '<div class="comp-props-section" style="margin-top:12px;">';
  html += '<div class="comp-props-label">Input Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">filePath — Path to the file to read</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">content — Parsed JSON object or raw string</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">isJson — Whether the content was parsed as JSON</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">size — File size in bytes</div>';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:2px;">filePath — The path that was read</div>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire event handler
  var parseSelect = document.querySelector('#comp-props-fr-parse');
  if (parseSelect) {
    parseSelect.addEventListener('change', function() {
      cfg.parseMode = parseSelect.value;
      immediateSave();
      renderNodes(); renderEdges(); wireUpCanvas();
    });
  }
}

function renderToolProperties(body, node, nodeId) {
  var cfg = node.toolNode || (node.toolNode = { selectedTool: '', paramDefaults: {} });

  function rebuildToolUI() {
    renderToolProperties(body, node, nodeId);
    injectNodeErrorDisplay(body, nodeId);
  }

  var html = '';

  // Label
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-tool-label" value="' + compEscAttr(node.label || '') + '" placeholder="Tool">';
  html += '</div>';

  // Tool selector (custom searchable dropdown)
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Tool</div>';
  html += '<div class="comp-tool-picker" id="comp-tool-picker">';
  html += '<div class="comp-tool-picker-selected" id="comp-tool-picker-btn">';
  html += '<span class="comp-tool-picker-text">' + (cfg.selectedTool ? compEscHtml(cfg.selectedTool) : '<span style="color:#64748b;">— Select a tool —</span>') + '</span>';
  html += '<span class="comp-tool-picker-arrow">&#x25BE;</span>';
  html += '</div>';
  html += '<div class="comp-tool-picker-dropdown" id="comp-tool-picker-dropdown" style="display:none;">';
  html += '<input type="text" class="comp-tool-picker-search" id="comp-tool-picker-search" placeholder="Search tools...">';
  html += '<div class="comp-tool-picker-list" id="comp-tool-picker-list">';
  html += '<div class="comp-tool-picker-item" data-tool-value="">— None —</div>';
  for (var ti = 0; ti < toolsCache.length; ti++) {
    var t = toolsCache[ti];
    var tDesc = t.description ? t.description.split('\n')[0] : '';
    if (tDesc.length > 60) tDesc = tDesc.substring(0, 57) + '...';
    html += '<div class="comp-tool-picker-item' + (cfg.selectedTool === t.name ? ' active' : '') + '" data-tool-value="' + compEscAttr(t.name) + '">';
    html += '<div class="comp-tool-picker-item-name">' + compEscHtml(t.name) + '</div>';
    if (tDesc) html += '<div class="comp-tool-picker-item-desc">' + compEscHtml(tDesc) + '</div>';
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Tool description
  var toolDef = getToolDef(cfg.selectedTool);
  if (toolDef && toolDef.description) {
    var descLine = toolDef.description.split('\n')[0];
    if (descLine.length > 120) descLine = descLine.substring(0, 117) + '...';
    html += '<div class="comp-props-section">';
    html += '<div style="font-size:0.65rem;color:#64748b;padding:0 0.25rem;">' + compEscHtml(descLine) + '</div>';
    html += '</div>';
  }

  // Parameter defaults — use live def or cached schema
  var toolParamsSource = (toolDef && toolDef.parameters) ? toolDef.parameters : (cfg.paramSchema || {});
  if (toolParamsSource.properties) {
    var props = toolParamsSource.properties;
    var required = toolParamsSource.required || [];
    var paramNames = Object.keys(props);

    if (paramNames.length > 0) {
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Parameter Defaults</div>';
      html += '<div style="font-size:0.6rem;color:#475569;margin-bottom:0.4rem;">Values used when input port is not connected</div>';

      for (var pi = 0; pi < paramNames.length; pi++) {
        var pName = paramNames[pi];
        var pDef = props[pName];
        var pReq = required.indexOf(pName) >= 0;
        var pVal = cfg.paramDefaults && cfg.paramDefaults[pName] !== undefined ? cfg.paramDefaults[pName] : (pDef.default !== undefined ? pDef.default : '');
        var pType = pDef.type || 'string';
        var pDesc = pDef.description || '';

        html += '<div class="comp-tool-param">';
        html += '<div class="comp-tool-param-header">';
        html += '<span class="comp-tool-param-name">' + compEscHtml(pName) + '</span>';
        html += '<span class="comp-tool-param-type">' + compEscHtml(pType) + '</span>';
        if (pReq) html += '<span class="comp-tool-param-req">required</span>';
        html += '</div>';
        if (pDesc) {
          var shortDesc = pDesc.length > 80 ? pDesc.substring(0, 77) + '...' : pDesc;
          html += '<div class="comp-tool-param-desc">' + compEscHtml(shortDesc) + '</div>';
        }

        // Input control based on type
        if (pDef.enum && pDef.enum.length > 0) {
          // Enum → dropdown
          html += '<select class="comp-props-input comp-tool-param-input" data-param="' + compEscAttr(pName) + '">';
          html += '<option value="">—</option>';
          for (var ei = 0; ei < pDef.enum.length; ei++) {
            var ev = pDef.enum[ei];
            html += '<option value="' + compEscAttr(String(ev)) + '"' + (String(pVal) === String(ev) ? ' selected' : '') + '>' + compEscHtml(String(ev)) + '</option>';
          }
          html += '</select>';
        } else if (pType === 'boolean') {
          // Boolean → checkbox
          html += '<label style="display:flex;align-items:center;gap:6px;font-size:0.68rem;color:#e2e8f0;cursor:pointer;">';
          html += '<input type="checkbox" class="comp-tool-param-input" data-param="' + compEscAttr(pName) + '" data-type="boolean"' + (pVal ? ' checked' : '') + ' style="accent-color:#f59e0b;">';
          html += 'Enabled</label>';
        } else if (pType === 'number') {
          html += '<input type="number" class="comp-props-input comp-tool-param-input" data-param="' + compEscAttr(pName) + '" data-type="number" value="' + compEscAttr(String(pVal)) + '" placeholder="' + compEscAttr(pType) + '">';
        } else {
          // String, array, object → text input
          var displayVal = typeof pVal === 'object' ? JSON.stringify(pVal) : String(pVal || '');
          html += '<input type="text" class="comp-props-input comp-tool-param-input" data-param="' + compEscAttr(pName) + '" data-type="' + compEscAttr(pType) + '" value="' + compEscAttr(displayVal) + '" placeholder="' + compEscAttr(pType) + '">';
        }
        html += '</div>';
      }
      html += '</div>';
    }
  }

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire events — label
  var labelInput = document.querySelector('#comp-props-tool-label');
  if (labelInput) {
    labelInput.addEventListener('input', function() {
      node.label = this.value || '';
      renderNodes(); renderEdges(); wireUpCanvas();
      debouncedSave();
    });
  }

  // Wire events — custom tool picker
  var toolPickerBtn = document.querySelector('#comp-tool-picker-btn');
  var toolPickerDropdown = document.querySelector('#comp-tool-picker-dropdown');
  var toolPickerSearch = document.querySelector('#comp-tool-picker-search');
  var toolPickerList = document.querySelector('#comp-tool-picker-list');

  if (toolPickerBtn && toolPickerDropdown) {
    // Always re-query DOM to avoid stale references (panel may have been rebuilt)
    function getPickerList() { return document.querySelector('#comp-tool-picker-list'); }
    function getPickerDropdown() { return document.querySelector('#comp-tool-picker-dropdown'); }
    function getPickerSearch() { return document.querySelector('#comp-tool-picker-search'); }

    // Rebuild the dropdown list from current toolsCache
    function rebuildToolPickerList() {
      var list = getPickerList();
      if (!list) return;
      var listHtml = '<div class="comp-tool-picker-item" data-tool-value="">— None —</div>';
      for (var ri = 0; ri < toolsCache.length; ri++) {
        var rt = toolsCache[ri];
        var rtDesc = rt.description ? rt.description.split('\n')[0] : '';
        if (rtDesc.length > 60) rtDesc = rtDesc.substring(0, 57) + '...';
        listHtml += '<div class="comp-tool-picker-item' + (cfg.selectedTool === rt.name ? ' active' : '') + '" data-tool-value="' + compEscAttr(rt.name) + '">';
        listHtml += '<div class="comp-tool-picker-item-name">' + compEscHtml(rt.name) + '</div>';
        if (rtDesc) listHtml += '<div class="comp-tool-picker-item-desc">' + compEscHtml(rtDesc) + '</div>';
        listHtml += '</div>';
      }
      list.innerHTML = listHtml;
      applyToolPickerFilter();
    }

    function applyToolPickerFilter() {
      var list = getPickerList();
      var search = getPickerSearch();
      if (!list) return;
      var q = search ? search.value.toLowerCase() : '';
      var items = list.querySelectorAll('.comp-tool-picker-item');
      for (var i = 0; i < items.length; i++) {
        var val = items[i].dataset.toolValue || '';
        var text = items[i].textContent.toLowerCase();
        items[i].style.display = (!q || val === '' || text.indexOf(q) >= 0) ? '' : 'none';
      }
    }

    // Toggle dropdown — fetch tools, then show
    toolPickerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var dd = getPickerDropdown();
      if (!dd) return;
      var isOpen = dd.style.display !== 'none';
      if (isOpen) {
        dd.style.display = 'none';
        return;
      }
      // Fetch tools first, then show the dropdown once we have them
      fetch('/api/tools')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          toolsCache = data.tools || [];
          console.log('[tool-picker] fetched ' + toolsCache.length + ' tools');
          rebuildToolPickerList();
          var dd2 = getPickerDropdown();
          var search2 = getPickerSearch();
          var list2 = getPickerList();
          console.log('[tool-picker] dd2=' + !!dd2 + ' search2=' + !!search2 + ' list2=' + !!list2 + ' list2.children=' + (list2 ? list2.children.length : 'N/A'));
          if (dd2) dd2.style.display = '';
          if (search2) {
            search2.value = '';
            applyToolPickerFilter();
            setTimeout(function() { search2.focus(); }, 50);
          }
        })
        .catch(function(err) {
          console.error('[tool-picker] fetch error:', err);
          rebuildToolPickerList();
          var dd2 = getPickerDropdown();
          if (dd2) dd2.style.display = '';
        });
    });

    // Search filter
    if (toolPickerSearch) {
      toolPickerSearch.addEventListener('input', function() {
        applyToolPickerFilter();
      });
      // Prevent dropdown close on search input click
      toolPickerSearch.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    // Item selection
    if (toolPickerList) {
      toolPickerList.addEventListener('click', function(e) {
        var item = e.target.closest('.comp-tool-picker-item');
        if (!item) return;
        e.stopPropagation();
        var newVal = item.dataset.toolValue || '';
        pushUndoSnapshot();
        cfg.selectedTool = newVal;
        cfg.paramDefaults = {};
        // Cache the tool's parameter schema so ports render without live tools cache
        var newToolDef = getToolDef(newVal);
        cfg.paramSchema = newToolDef && newToolDef.parameters ? newToolDef.parameters : null;
        // Clear edges when tool changes (ports change)
        if (compData && compData.edges) {
          compData.edges = compData.edges.filter(function(e) {
            return e.sourceNodeId !== node.id && e.targetNodeId !== node.id;
          });
        }
        renderNodes(); renderEdges(); wireUpCanvas();
        rebuildToolUI();
        immediateSave();
      });
    }

    // Close on outside click
    document.addEventListener('click', function closeToolPicker(e) {
      if (!document.querySelector('#comp-tool-picker')) {
        document.removeEventListener('click', closeToolPicker);
        return;
      }
      if (!e.target.closest('#comp-tool-picker')) {
        var dd = getPickerDropdown();
        if (dd) dd.style.display = 'none';
      }
    });
  }

  // Wire events — param defaults
  body.querySelectorAll('.comp-tool-param-input').forEach(function(input) {
    var paramName = input.dataset.param;
    var paramType = input.dataset.type;

    function updateParam() {
      if (!cfg.paramDefaults) cfg.paramDefaults = {};
      if (input.type === 'checkbox') {
        cfg.paramDefaults[paramName] = input.checked;
      } else if (paramType === 'number') {
        cfg.paramDefaults[paramName] = input.value ? Number(input.value) : undefined;
      } else if (paramType === 'array' || paramType === 'object') {
        try {
          cfg.paramDefaults[paramName] = input.value ? JSON.parse(input.value) : undefined;
        } catch (_e) {
          cfg.paramDefaults[paramName] = input.value;
        }
      } else {
        cfg.paramDefaults[paramName] = input.value || undefined;
      }
      // Clean undefined entries
      if (cfg.paramDefaults[paramName] === undefined || cfg.paramDefaults[paramName] === '') {
        delete cfg.paramDefaults[paramName];
      }
      debouncedSave();
    }

    if (input.tagName === 'SELECT') {
      input.addEventListener('change', updateParam);
    } else if (input.type === 'checkbox') {
      input.addEventListener('change', updateParam);
    } else {
      input.addEventListener('input', updateParam);
    }
  });

  // Fetch tools if cache is empty — update picker list in-place (don't destroy DOM)
  if (toolsCache.length === 0) {
    fetchAvailableTools(function() {
      // Update the picker button text if a tool is selected
      var pickerText = document.querySelector('#comp-tool-picker-btn .comp-tool-picker-text');
      if (pickerText && cfg.selectedTool) {
        pickerText.textContent = cfg.selectedTool;
      }
      // Rebuild the picker list items in-place
      var list = document.querySelector('#comp-tool-picker-list');
      if (list) {
        var listHtml = '<div class="comp-tool-picker-item" data-tool-value="">— None —</div>';
        for (var fi = 0; fi < toolsCache.length; fi++) {
          var ft = toolsCache[fi];
          var ftDesc = ft.description ? ft.description.split('\n')[0] : '';
          if (ftDesc.length > 60) ftDesc = ftDesc.substring(0, 57) + '...';
          listHtml += '<div class="comp-tool-picker-item' + (cfg.selectedTool === ft.name ? ' active' : '') + '" data-tool-value="' + compEscAttr(ft.name) + '">';
          listHtml += '<div class="comp-tool-picker-item-name">' + compEscHtml(ft.name) + '</div>';
          if (ftDesc) listHtml += '<div class="comp-tool-picker-item-desc">' + compEscHtml(ftDesc) + '</div>';
          listHtml += '</div>';
        }
        list.innerHTML = listHtml;
      }
    });
  }
}

function renderAssetProperties(body, node, nodeId) {
  if (!node.asset) node.asset = { mode: 'pick', collectionSlug: '', assetId: '', category: '', tags: '', defaultName: '' };
  var cfg = node.asset;

  // Cache for fetched data
  var collectionsCache = [];
  var assetsCache = [];

  function rebuildAssetUI() {
    var mode = cfg.mode || 'pick';
    var html = '';

    // Display Name
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Display Name</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-asset-label" value="' + compEscAttr(node.label || '') + '" placeholder="Asset">';
    html += '</div>';

    // Node type info
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label" style="color:#f59e0b;">&#x1f4be; Asset Node</div>';
    html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Interact with asset collections. Choose a mode to pick, save, list, or remove assets.</div>';
    html += '</div>';

    // Mode selector
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Mode</div>';
    html += '<select class="comp-props-input" id="comp-props-asset-mode">';
    html += '<option value="pick"' + (mode === 'pick' ? ' selected' : '') + '>Pick — Select an asset</option>';
    html += '<option value="save"' + (mode === 'save' ? ' selected' : '') + '>Save — Store a file as asset</option>';
    html += '<option value="list"' + (mode === 'list' ? ' selected' : '') + '>List — List collection assets</option>';
    html += '<option value="remove"' + (mode === 'remove' ? ' selected' : '') + '>Remove — Delete an asset</option>';
    html += '<option value="generate_path"' + (mode === 'generate_path' ? ' selected' : '') + '>Generate Path — Create a file path</option>';
    html += '</select>';
    html += '</div>';

    // Collection picker (all modes except remove)
    if (mode !== 'remove') {
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Collection</div>';
      html += '<select class="comp-props-input" id="comp-props-asset-collection">';
      html += '<option value="">Loading collections...</option>';
      html += '</select>';
      html += '</div>';
    }

    // Asset picker (pick mode only)
    if (mode === 'pick') {
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Asset</div>';
      html += '<select class="comp-props-input" id="comp-props-asset-picker">';
      html += '<option value="">Select a collection first</option>';
      html += '</select>';
      html += '</div>';
    }

    // Category filter (pick/list modes)
    if (mode === 'pick' || mode === 'list') {
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Category Filter (optional)</div>';
      html += '<input type="text" class="comp-props-input" id="comp-props-asset-category" value="' + compEscAttr(cfg.category || '') + '" placeholder="e.g. characters, backgrounds">';
      html += '</div>';
    }

    // Tags (save mode)
    if (mode === 'save') {
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Tags (comma-separated)</div>';
      html += '<input type="text" class="comp-props-input" id="comp-props-asset-tags" value="' + compEscAttr(cfg.tags || '') + '" placeholder="e.g. character, hero, generated">';
      html += '</div>';

      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Default Name</div>';
      html += '<input type="text" class="comp-props-input" id="comp-props-asset-default-name" value="' + compEscAttr(cfg.defaultName || '') + '" placeholder="Auto-generated if empty">';
      html += '</div>';

      html += '<div class="comp-props-section">';
      html += '<label style="display:flex;align-items:center;gap:6px;font-size:0.72rem;color:#e2e8f0;cursor:pointer;">';
      html += '<input type="checkbox" id="comp-props-asset-ref-only"' + (cfg.referenceOnly ? ' checked' : '') + ' style="accent-color:#f59e0b;">';
      html += 'Reference only (don\'t copy file)';
      html += '</label>';
      html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;margin-left:20px;">File stays at its original location</div>';
      html += '</div>';
    }

    // Generate Path mode properties
    if (mode === 'generate_path') {
      // Determine effective directory: collection rootPath if available, else manual
      var gpCollectionRoot = '';
      if (cfg.collectionSlug && cfg.collectionSlug !== '__all__' && collectionsCache) {
        for (var ci = 0; ci < collectionsCache.length; ci++) {
          if ((collectionsCache[ci].slug || collectionsCache[ci].id) === cfg.collectionSlug && collectionsCache[ci].rootPath) {
            gpCollectionRoot = collectionsCache[ci].rootPath;
            break;
          }
        }
      }

      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Directory</div>';
      if (gpCollectionRoot) {
        html += '<input type="text" class="comp-props-input" id="comp-props-asset-gp-dir" value="' + compEscAttr(gpCollectionRoot) + '" disabled style="opacity:0.6;cursor:not-allowed;">';
        html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;">Using collection root path</div>';
      } else {
        html += '<input type="text" class="comp-props-input" id="comp-props-asset-gp-dir" value="' + compEscAttr(cfg.outputDirectory || '~/.woodbury/data/output') + '" placeholder="~/.woodbury/data/output">';
      }
      html += '</div>';

      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Name Pattern</div>';
      html += '<input type="text" class="comp-props-input" id="comp-props-asset-gp-pattern" value="' + compEscAttr(cfg.namePattern || 'output_{datetime}') + '" placeholder="output_{datetime}">';
      html += '<div style="font-size:0.6rem;color:#64748b;margin-top:3px;">Tokens: <code style="color:#a5f3fc;">{name}</code> <code style="color:#a5f3fc;">{date}</code> <code style="color:#a5f3fc;">{time}</code> <code style="color:#a5f3fc;">{datetime}</code> <code style="color:#a5f3fc;">{timestamp}</code> <code style="color:#a5f3fc;">{uuid}</code></div>';
      html += '</div>';

      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">File Extension</div>';
      html += '<input type="text" class="comp-props-input" id="comp-props-asset-gp-ext" value="' + compEscAttr(cfg.fileExtension || '.json') + '" placeholder=".json">';
      html += '</div>';

      // Preview
      var previewPattern = cfg.namePattern || 'output_{datetime}';
      var previewExt = cfg.fileExtension || '.json';
      var previewDir = gpCollectionRoot || cfg.outputDirectory || '~/.woodbury/data/output';
      var now = new Date();
      var previewResolved = previewPattern
        .replace(/\{name\}/g, 'my_file')
        .replace(/\{datetime\}/g, now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + '_' + String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0') + '-' + String(now.getSeconds()).padStart(2,'0'))
        .replace(/\{date\}/g, now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0'))
        .replace(/\{time\}/g, String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0') + '-' + String(now.getSeconds()).padStart(2,'0'))
        .replace(/\{timestamp\}/g, String(Math.floor(now.getTime()/1000)))
        .replace(/\{uuid\}/g, 'a1b2c3d4');
      html += '<div class="comp-props-section">';
      html += '<div class="comp-props-label">Preview</div>';
      html += '<div id="comp-props-asset-gp-preview" style="font-size:0.7rem;color:#a5f3fc;font-family:monospace;background:#0f172a;padding:6px 8px;border-radius:4px;word-break:break-all;">' + compEscHtml(previewDir + '/' + previewResolved + previewExt) + '</div>';
      html += '</div>';
    }

    html += renderIdempotencySection(node);
    body.innerHTML = html;
    wireIdempotencyToggle(node, nodeId);

    // Wire events
    var labelInput = document.querySelector('#comp-props-asset-label');
    if (labelInput) {
      labelInput.addEventListener('input', function() {
        node.label = this.value || '';
        renderNodes(); renderEdges(); wireUpCanvas();
        debouncedSave();
      });
    }

    var modeSelect = document.querySelector('#comp-props-asset-mode');
    if (modeSelect) {
      modeSelect.addEventListener('change', function() {
        pushUndoSnapshot();
        cfg.mode = this.value;
        // Clear edges that reference ports from the old mode
        if (compData && compData.edges) {
          compData.edges = compData.edges.filter(function(e) {
            return e.sourceNodeId !== node.id && e.targetNodeId !== node.id;
          });
        }
        renderNodes(); renderEdges(); wireUpCanvas();
        rebuildAssetUI();
        immediateSave();
      });
    }

    var categoryInput = document.querySelector('#comp-props-asset-category');
    if (categoryInput) {
      categoryInput.addEventListener('input', function() {
        cfg.category = this.value;
        debouncedSave();
      });
    }

    var tagsInput = document.querySelector('#comp-props-asset-tags');
    if (tagsInput) {
      tagsInput.addEventListener('input', function() {
        cfg.tags = this.value;
        debouncedSave();
      });
    }

    var defaultNameInput = document.querySelector('#comp-props-asset-default-name');
    if (defaultNameInput) {
      defaultNameInput.addEventListener('input', function() {
        cfg.defaultName = this.value;
        debouncedSave();
      });
    }

    var refOnlyInput = document.querySelector('#comp-props-asset-ref-only');
    if (refOnlyInput) {
      refOnlyInput.addEventListener('change', function() {
        cfg.referenceOnly = this.checked;
        debouncedSave();
      });
    }

    // Generate Path mode inputs
    function updateGpPreview() {
      var previewEl = document.querySelector('#comp-props-asset-gp-preview');
      if (!previewEl) return;
      var pat = cfg.namePattern || 'output_{datetime}';
      var ext = cfg.fileExtension || '.json';
      var dir = cfg.outputDirectory || '~/.woodbury/data/output';
      // Check for collection rootPath override
      if (cfg.collectionSlug && cfg.collectionSlug !== '__all__' && collectionsCache) {
        for (var ci = 0; ci < collectionsCache.length; ci++) {
          if ((collectionsCache[ci].slug || collectionsCache[ci].id) === cfg.collectionSlug && collectionsCache[ci].rootPath) {
            dir = collectionsCache[ci].rootPath;
            break;
          }
        }
      }
      var now = new Date();
      var resolved = pat
        .replace(/\{name\}/g, 'my_file')
        .replace(/\{datetime\}/g, now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + '_' + String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0') + '-' + String(now.getSeconds()).padStart(2,'0'))
        .replace(/\{date\}/g, now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0'))
        .replace(/\{time\}/g, String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0') + '-' + String(now.getSeconds()).padStart(2,'0'))
        .replace(/\{timestamp\}/g, String(Math.floor(now.getTime()/1000)))
        .replace(/\{uuid\}/g, 'a1b2c3d4');
      previewEl.textContent = dir + '/' + resolved + ext;
    }
    var gpDirInput = document.querySelector('#comp-props-asset-gp-dir');
    if (gpDirInput) {
      gpDirInput.addEventListener('input', function() {
        cfg.outputDirectory = this.value;
        debouncedSave();
        updateGpPreview();
      });
    }
    var gpPatternInput = document.querySelector('#comp-props-asset-gp-pattern');
    if (gpPatternInput) {
      gpPatternInput.addEventListener('input', function() {
        cfg.namePattern = this.value;
        debouncedSave();
        updateGpPreview();
      });
    }
    var gpExtInput = document.querySelector('#comp-props-asset-gp-ext');
    if (gpExtInput) {
      gpExtInput.addEventListener('input', function() {
        cfg.fileExtension = this.value;
        debouncedSave();
        updateGpPreview();
      });
    }

    // Fetch collections
    fetchCollections();
  }

  function fetchCollections() {
    fetch('/api/assets/collections')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        collectionsCache = data.collections || data || [];
        var select = document.querySelector('#comp-props-asset-collection');
        if (!select) return;
        var html = '<option value="">— Select Collection —</option>';
        html += '<option value="__all__"' + (cfg.collectionSlug === '__all__' ? ' selected' : '') + '>All Assets</option>';
        for (var i = 0; i < collectionsCache.length; i++) {
          var col = collectionsCache[i];
          var slug = col.slug || col.id || col.name;
          var name = col.name || slug;
          html += '<option value="' + compEscAttr(slug) + '"' + (cfg.collectionSlug === slug ? ' selected' : '') + '>' + compEscHtml(name) + '</option>';
        }
        select.innerHTML = html;
        select.addEventListener('change', function() {
          cfg.collectionSlug = this.value;
          renderNodes(); renderEdges(); wireUpCanvas();
          debouncedSave();
          // If pick mode, load assets for this collection
          if (cfg.mode === 'pick' && this.value) {
            fetchAssets(this.value);
          }
          // If generate_path mode, rebuild to update preview with collection rootPath
          if (cfg.mode === 'generate_path') {
            rebuildAssetUI();
          }
        });
        // If collection already selected and in pick mode, load assets
        if (cfg.mode === 'pick' && cfg.collectionSlug) {
          fetchAssets(cfg.collectionSlug);
        }
      })
      .catch(function(err) {
        var select = document.querySelector('#comp-props-asset-collection');
        if (select) select.innerHTML = '<option value="">Failed to load collections</option>';
      });
  }

  function fetchAssets(collectionSlug) {
    var assetUrl = '/api/assets';
    if (collectionSlug && collectionSlug !== '__all__') {
      assetUrl += '?collection=' + encodeURIComponent(collectionSlug);
    }
    fetch(assetUrl)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        assetsCache = data.assets || data || [];
        var select = document.querySelector('#comp-props-asset-picker');
        if (!select) return;
        var html = '<option value="">— Select Asset —</option>';
        for (var i = 0; i < assetsCache.length; i++) {
          var asset = assetsCache[i];
          var id = asset.id || asset.assetId;
          var name = asset.name || asset.fileName || id;
          html += '<option value="' + compEscAttr(id) + '"' + (cfg.assetId === id ? ' selected' : '') + '>' + compEscHtml(name) + '</option>';
        }
        select.innerHTML = html;
        select.addEventListener('change', function() {
          cfg.assetId = this.value;
          debouncedSave();
        });
      })
      .catch(function(err) {
        var select = document.querySelector('#comp-props-asset-picker');
        if (select) select.innerHTML = '<option value="">Failed to load assets</option>';
      });
  }

  rebuildAssetUI();
}

function renderSwitchProperties(body, node, nodeId) {
  if (!node.switchNode) node.switchNode = { cases: [{ value: 'a', port: 'on_a' }], defaultPort: 'on_default' };
  var cfg = node.switchNode;

  function rebuildSwitchUI() {
    var html = '';

    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Display Name</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-switch-label" value="' + compEscAttr(node.label || '') + '" placeholder="Switch">';
    html += '</div>';

    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label" style="color:#f97316;">&#x2b82; Switch (Multi-Way)</div>';
    html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Routes execution based on matching a value against named cases.</div>';
    html += '</div>';

    // Cases
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Cases</div>';
    for (var ci = 0; ci < cfg.cases.length; ci++) {
      var c = cfg.cases[ci];
      html += '<div style="display:flex;gap:0.3rem;align-items:center;margin-bottom:0.3rem;" data-case-idx="' + ci + '">';
      html += '<input type="text" class="comp-props-input comp-props-switch-case-value" style="flex:1;font-size:0.72rem;" value="' + compEscAttr(c.value) + '" placeholder="value" data-idx="' + ci + '">';
      html += '<input type="text" class="comp-props-input comp-props-switch-case-port" style="flex:1;font-size:0.72rem;" value="' + compEscAttr(c.port) + '" placeholder="port name" data-idx="' + ci + '">';
      html += '<button class="comp-props-btn comp-props-switch-remove-case" data-idx="' + ci + '" style="padding:0.15rem 0.4rem;font-size:0.7rem;" title="Remove case">&#x2715;</button>';
      html += '</div>';
    }
    html += '<button class="comp-props-btn" id="comp-props-switch-add-case" style="font-size:0.7rem;margin-top:0.2rem;">+ Add Case</button>';
    html += '</div>';

    // Default port
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Default Port</div>';
    html += '<input type="text" class="comp-props-input" id="comp-props-switch-default" value="' + compEscAttr(cfg.defaultPort || 'on_default') + '" placeholder="on_default">';
    html += '</div>';

    body.innerHTML = html;

    // Wire events
    var labelInput = document.querySelector('#comp-props-switch-label');
    if (labelInput) {
      labelInput.addEventListener('input', function() {
        node.label = this.value || '';
        renderNodes(); renderEdges(); wireUpCanvas();
        debouncedSave();
      });
    }

    // Case value inputs
    document.querySelectorAll('.comp-props-switch-case-value').forEach(function(inp) {
      inp.addEventListener('input', function() {
        var idx = parseInt(this.dataset.idx);
        if (cfg.cases[idx]) {
          cfg.cases[idx].value = this.value;
          debouncedSave();
        }
      });
    });

    // Case port inputs
    document.querySelectorAll('.comp-props-switch-case-port').forEach(function(inp) {
      inp.addEventListener('input', function() {
        var idx = parseInt(this.dataset.idx);
        if (cfg.cases[idx]) {
          cfg.cases[idx].port = this.value;
          renderNodes(); renderEdges(); wireUpCanvas();
          debouncedSave();
        }
      });
    });

    // Remove case buttons
    document.querySelectorAll('.comp-props-switch-remove-case').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(this.dataset.idx);
        cfg.cases.splice(idx, 1);
        renderNodes(); renderEdges(); wireUpCanvas();
        rebuildSwitchUI();
        immediateSave();
      });
    });

    // Add case
    var addCaseBtn = document.querySelector('#comp-props-switch-add-case');
    if (addCaseBtn) {
      addCaseBtn.addEventListener('click', function() {
        var nextLetter = String.fromCharCode(97 + cfg.cases.length); // a, b, c, ...
        cfg.cases.push({ value: nextLetter, port: 'on_' + nextLetter });
        renderNodes(); renderEdges(); wireUpCanvas();
        rebuildSwitchUI();
        immediateSave();
      });
    }

    // Default port
    var defInput = document.querySelector('#comp-props-switch-default');
    if (defInput) {
      defInput.addEventListener('input', function() {
        cfg.defaultPort = this.value || 'on_default';
        renderNodes(); renderEdges(); wireUpCanvas();
        debouncedSave();
      });
    }
  }

  rebuildSwitchUI();
}

function renderCompositionNodeProperties(body, node, nodeId) {
  var compRefId = node.compositionRef ? node.compositionRef.compositionId : node.workflowId.slice(5);
  var cachedIf = compositionInterfaceCache[compRefId];
  var iface = (cachedIf && cachedIf.data) ? cachedIf.data : { inputs: [], outputs: [] };
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="Pipeline">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#06b6d4;">&#x1f517; Sub-Pipeline</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">References pipeline: ' + compEscHtml(iface.compositionName || compRefId) + '</div>';
  html += '</div>';

  // Inputs
  if (iface.inputs.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Inputs (' + iface.inputs.length + ')</div>';
    for (var ii = 0; ii < iface.inputs.length; ii++) {
      var inp = iface.inputs[ii];
      var connEdge = compData ? compData.edges.find(function(e) {
        return e.targetNodeId === nodeId && e.targetPort === inp.name;
      }) : null;
      html += '<div class="comp-props-var-row">';
      html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(inp.name)) + '</span>';
      if (inp.description) {
        html += '<div class="comp-props-var-desc">' + compEscHtml(inp.description) + '</div>';
      }
      if (connEdge) {
        var srcNode = compData.nodes.find(function(n) { return n.id === connEdge.sourceNodeId; });
        var srcName = srcNode ? (srcNode.label || srcNode.workflowId) : '?';
        html += '<span class="comp-props-var-source">From ' + compEscHtml(srcName) + ' &rarr; ' + compEscHtml(humanizeVarName(connEdge.sourcePort)) + '</span>';
      } else {
        html += '<span class="comp-props-var-source" style="color:#475569;font-style:italic;">unconnected</span>';
      }
      html += '</div>';
    }
    html += '</div>';
  }

  // Outputs
  if (iface.outputs.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Outputs (' + iface.outputs.length + ')</div>';
    for (var oi = 0; oi < iface.outputs.length; oi++) {
      var out = iface.outputs[oi];
      var downCount = compData ? compData.edges.filter(function(e) {
        return e.sourceNodeId === nodeId && e.sourcePort === out.name;
      }).length : 0;
      html += '<div class="comp-props-var-row">';
      html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(out.name)) + '</span>';
      html += '<span class="comp-props-var-source">&rarr; ' + downCount + ' node' + (downCount !== 1 ? 's' : '') + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  // On Failure policy
  var currentPolicy = (node.onFailure && node.onFailure.action) || 'stop';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">On Failure</div>';
  html += '<select class="comp-props-input" id="comp-props-failure-policy">';
  html += '<option value="stop"' + (currentPolicy === 'stop' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (currentPolicy === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '</select>';
  html += '</div>';

  // Refresh interface button
  html += '<div class="comp-props-section">';
  html += '<button class="comp-tb-btn" id="comp-props-open-subpipeline" style="width:100%;font-size:0.72rem;margin-bottom:0.4rem;">&#x1f517; Open Pipeline</button>';
  html += '<button class="comp-tb-btn" id="comp-props-refresh-interface" style="width:100%;font-size:0.72rem;">&#x1f504; Refresh Ports</button>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire handlers
  var labelInput = body.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = labelInput.value.trim() || undefined;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      immediateSave();
    });
  }

  var policySelect = body.querySelector('#comp-props-failure-policy');
  if (policySelect) {
    policySelect.addEventListener('change', function() {
      node.onFailure = node.onFailure || {};
      node.onFailure.action = policySelect.value;
      debouncedSave();
    });
  }

  var openBtn = body.querySelector('#comp-props-open-subpipeline');
  if (openBtn) {
    openBtn.addEventListener('click', function() {
      openNestedComposition(compRefId, nodeId);
    });
  }

  var refreshBtn = body.querySelector('#comp-props-refresh-interface');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      // Invalidate cache and re-fetch
      delete compositionInterfaceCache[compRefId];
      fetchCompositionInterface(compRefId).then(function() {
        renderNodes();
        renderEdges();
        wireUpCanvas();
        renderCompositionNodeProperties(body, node, nodeId);
        showToast('Ports refreshed', 'success');
      });
    });
  }

  // If not cached yet, fetch now
  if (!cachedIf) {
    fetchCompositionInterface(compRefId).then(function() {
      renderCompositionNodeProperties(body, node, nodeId);
    });
  }
}

function renderOutputProperties(body, node, nodeId) {
  if (!node.outputNode) node.outputNode = { ports: [] };
  var outputCfg = node.outputNode;
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-output-label" value="' + compEscAttr(node.label || '') + '" placeholder="Pipeline Output">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label" style="color:#22c55e;">&#x1f4e4; Output Node</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Values connected to these ports become the pipeline\'s outputs when used as a sub-pipeline.</div>';
  html += '</div>';

  // Ports list
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Output Ports (' + outputCfg.ports.length + ')</div>';

  for (var i = 0; i < outputCfg.ports.length; i++) {
    var port = outputCfg.ports[i];
    var connEdge = compData ? compData.edges.find(function(e) {
      return e.targetNodeId === nodeId && e.targetPort === port.name;
    }) : null;

    html += '<div class="comp-output-port-row" data-port-index="' + i + '">';
    html += '<input type="text" class="comp-props-input comp-output-port-name" data-port-index="' + i + '" value="' + compEscAttr(port.name) + '" placeholder="port_name" style="flex:1;font-size:0.72rem;">';
    html += '<select class="comp-props-input comp-output-port-type" data-port-index="' + i + '" style="width:80px;font-size:0.68rem;">';
    var portTypes = ['string', 'number', 'boolean', 'string[]'];
    for (var t = 0; t < portTypes.length; t++) {
      html += '<option value="' + portTypes[t] + '"' + (port.type === portTypes[t] ? ' selected' : '') + '>' + portTypes[t] + '</option>';
    }
    html += '</select>';
    html += '<button class="comp-output-port-remove" data-port-index="' + i + '" title="Remove port">&times;</button>';
    html += '</div>';

    // Connection info
    if (connEdge) {
      var srcNode = compData ? compData.nodes.find(function(n) { return n.id === connEdge.sourceNodeId; }) : null;
      var srcName = srcNode ? (srcNode.label || srcNode.workflowId) : connEdge.sourceNodeId;
      html += '<div style="font-size:0.6rem;color:#64748b;padding-left:4px;margin-bottom:4px;">&#x2190; ' + compEscHtml(srcName) + '.' + compEscHtml(connEdge.sourcePort) + '</div>';
    } else {
      html += '<div style="font-size:0.6rem;color:#475569;font-style:italic;padding-left:4px;margin-bottom:4px;">unconnected</div>';
    }
  }

  html += '<div style="display:flex;gap:6px;margin-top:6px;">';
  html += '<button class="comp-output-add-port" id="comp-output-add-port">+ Add Port</button>';
  html += '<button class="comp-output-suggest-btn" id="comp-output-suggest-names" title="Suggest names based on connected nodes">&#x2728; Suggest Names</button>';
  html += '</div>';
  html += '</div>';

  body.innerHTML = html;

  // Wire handlers

  // Display name
  var labelInput = document.querySelector('#comp-props-output-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      node.label = this.value.trim() || undefined;
      renderNodes();
      renderEdges();
      wireUpCanvas();
      immediateSave();
    });
  }

  // Port name changes
  body.querySelectorAll('.comp-output-port-name').forEach(function(inp) {
    inp.addEventListener('change', function() {
      var idx = parseInt(this.getAttribute('data-port-index'));
      var oldName = outputCfg.ports[idx].name;
      var newName = this.value.trim().replace(/[^a-zA-Z0-9_]/g, '_') || ('port_' + idx);
      outputCfg.ports[idx].name = newName;
      // Update any edges targeting the old port name
      if (compData && oldName !== newName) {
        compData.edges.forEach(function(e) {
          if (e.targetNodeId === nodeId && e.targetPort === oldName) {
            e.targetPort = newName;
          }
        });
      }
      renderNodes();
      renderEdges();
      wireUpCanvas();
      renderOutputProperties(body, node, nodeId);
      immediateSave();
    });
  });

  // Port type changes
  body.querySelectorAll('.comp-output-port-type').forEach(function(sel) {
    sel.addEventListener('change', function() {
      var idx = parseInt(this.getAttribute('data-port-index'));
      outputCfg.ports[idx].type = this.value;
      immediateSave();
    });
  });

  // Remove port
  body.querySelectorAll('.comp-output-port-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-port-index'));
      var removedName = outputCfg.ports[idx].name;
      outputCfg.ports.splice(idx, 1);
      // Remove edges targeting this port
      if (compData) {
        compData.edges = compData.edges.filter(function(e) {
          return !(e.targetNodeId === nodeId && e.targetPort === removedName);
        });
      }
      renderNodes();
      renderEdges();
      wireUpCanvas();
      renderOutputProperties(body, node, nodeId);
      immediateSave();
    });
  });

  // Add port
  var addPortBtn = document.querySelector('#comp-output-add-port');
  if (addPortBtn) {
    addPortBtn.addEventListener('click', function() {
      var portNum = outputCfg.ports.length + 1;
      outputCfg.ports.push({ name: 'output_' + portNum, type: 'string', description: '' });
      renderNodes();
      renderEdges();
      wireUpCanvas();
      renderOutputProperties(body, node, nodeId);
      immediateSave();
    });
  }

  // Suggest names
  var suggestBtn = document.querySelector('#comp-output-suggest-names');
  if (suggestBtn) {
    suggestBtn.addEventListener('click', function() {
      // Gather upstream context: connected source ports
      var context = [];
      if (compData) {
        outputCfg.ports.forEach(function(port) {
          var edge = compData.edges.find(function(e) {
            return e.targetNodeId === nodeId && e.targetPort === port.name;
          });
          if (edge) {
            var srcNode = compData.nodes.find(function(n) { return n.id === edge.sourceNodeId; });
            context.push({
              currentName: port.name,
              sourceNode: srcNode ? (srcNode.label || srcNode.workflowId) : edge.sourceNodeId,
              sourcePort: edge.sourcePort,
            });
          } else {
            context.push({ currentName: port.name, sourceNode: null, sourcePort: null });
          }
        });
      }

      suggestBtn.disabled = true;
      suggestBtn.textContent = '...';

      fetch('/api/generate-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: 'Pipeline output port names. Connected sources: ' + JSON.stringify(context),
          count: outputCfg.ports.length || 1,
        }),
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.names && Array.isArray(data.names)) {
            for (var si = 0; si < Math.min(data.names.length, outputCfg.ports.length); si++) {
              var oldN = outputCfg.ports[si].name;
              var newN = data.names[si].replace(/[^a-zA-Z0-9_]/g, '_');
              if (newN && oldN !== newN) {
                if (compData) {
                  compData.edges.forEach(function(e) {
                    if (e.targetNodeId === nodeId && e.targetPort === oldN) {
                      e.targetPort = newN;
                    }
                  });
                }
                outputCfg.ports[si].name = newN;
              }
            }
            renderNodes();
            renderEdges();
            wireUpCanvas();
            renderOutputProperties(body, node, nodeId);
            immediateSave();
            showToast('Port names updated', 'success');
          }
        })
        .catch(function() {
          showToast('Failed to suggest names', 'error');
        })
        .finally(function() {
          suggestBtn.disabled = false;
          suggestBtn.innerHTML = '&#x2728; Suggest Names';
        });
    });
  }
}

function renderGateProperties(body, node, nodeId) {
  var gate = node.approvalGate || { message: '', previewVariables: [], timeoutMs: 0, onReject: 'stop' };
  var html = '';

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="Approval Gate">';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Type</div>';
  html += '<div class="comp-props-value" style="color:#f59e0b;">&#x1f6d1; Approval Gate</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Pauses the pipeline and waits for manual approval before continuing.</div>';
  html += '</div>';

  // Message
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Approval Message</div>';
  html += '<textarea class="comp-props-input comp-gate-textarea" id="comp-gate-message" placeholder="What should the reviewer check?">' + compEscHtml(gate.message || '') + '</textarea>';
  html += '</div>';

  // Timeout
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Timeout</div>';
  var timeoutMin = gate.timeoutMs ? Math.round(gate.timeoutMs / 60000) : 0;
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<input type="number" class="comp-props-input" id="comp-gate-timeout" value="' + timeoutMin + '" min="0" max="1440" style="width:80px;">';
  html += '<span style="font-size:0.7rem;color:#94a3b8;">minutes (0 = no timeout)</span>';
  html += '</div>';
  html += '</div>';

  // On Reject
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">If Rejected</div>';
  html += '<select class="comp-props-input" id="comp-gate-on-reject">';
  html += '<option value="stop"' + (gate.onReject !== 'skip' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (gate.onReject === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '</select>';
  html += '</div>';

  body.innerHTML = html;

  // Wire up label editing
  var labelInput = body.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      pushUndoSnapshot();
      node.label = labelInput.value.trim() || undefined;
      renderNodes();
      wireUpCanvas();
      debouncedSave();
    });
  }

  // Wire up gate config
  var msgInput = body.querySelector('#comp-gate-message');
  if (msgInput) {
    msgInput.addEventListener('change', function() {
      pushUndoSnapshot();
      if (!node.approvalGate) node.approvalGate = {};
      node.approvalGate.message = msgInput.value.trim();
      renderNodes();
      wireUpCanvas();
      debouncedSave();
    });
  }

  var timeoutInput = body.querySelector('#comp-gate-timeout');
  if (timeoutInput) {
    timeoutInput.addEventListener('change', function() {
      pushUndoSnapshot();
      if (!node.approvalGate) node.approvalGate = {};
      node.approvalGate.timeoutMs = (parseInt(timeoutInput.value) || 0) * 60000;
      debouncedSave();
    });
  }

  var rejectSelect = body.querySelector('#comp-gate-on-reject');
  if (rejectSelect) {
    rejectSelect.addEventListener('change', function() {
      pushUndoSnapshot();
      if (!node.approvalGate) node.approvalGate = {};
      node.approvalGate.onReject = rejectSelect.value;
      debouncedSave();
    });
  }
}

// ── Idempotency Toggle (shared across node properties) ──────

function renderIdempotencySection(node) {
  var html = '';
  html += '<div class="comp-props-section" style="border-top:1px solid #334155;margin-top:8px;padding-top:8px;">';
  html += '<label style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;">';
  html += '<input type="checkbox" id="comp-props-idempotent"' + (node.idempotent ? ' checked' : '') + ' style="accent-color:#10b981;">';
  html += '&#x1F504; Cache results (idempotent)</label>';
  html += '<div style="font-size:0.6rem;color:#64748b;margin-top:2px;margin-left:20px;">';
  html += 'Skip re-execution when inputs are unchanged</div>';
  if (node.idempotent) {
    html += '<button class="comp-props-btn" id="comp-props-clear-cache" style="font-size:0.65rem;padding:2px 8px;margin-left:20px;margin-top:4px;">&#x1F5D1; Clear Cache</button>';
  }
  html += '</div>';
  return html;
}

function wireIdempotencyToggle(node, nodeId) {
  var chk = document.querySelector('#comp-props-idempotent');
  if (chk) {
    chk.addEventListener('change', function() {
      node.idempotent = this.checked;
      immediateSave();
      renderNodes();
      updatePropertiesPanel();
    });
  }
  var clearBtn = document.querySelector('#comp-props-clear-cache');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      var compId = compData && compData.id;
      if (!compId) return;
      fetch('/api/compositions/' + encodeURIComponent(compId) + '/cache/' + encodeURIComponent(nodeId), { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            clearBtn.textContent = '\u2713 Cleared';
            setTimeout(function() { clearBtn.textContent = '\uD83D\uDDD1 Clear Cache'; }, 1500);
          }
        })
        .catch(function() {});
    });
  }
}

// ── Script Node Properties ──────────────────────────────────

function parseWoodburyScriptPorts(code) {
  var inputs = [];
  var outputs = [];
  var regex = /@(input|output)\s+(\w+)\s+(string|number|boolean|object|string\[\]|number\[\]|object\[\])\s*(?:"([^"]*)")?/g;
  var match;
  while ((match = regex.exec(String(code || ''))) !== null) {
    var decl = {
      name: match[2],
      type: match[3],
      description: match[4] || '',
    };
    if (match[1] === 'input') inputs.push(decl);
    else outputs.push(decl);
  }
  return { inputs: inputs, outputs: outputs };
}

function validateWoodburyScriptCode(code) {
  var source = String(code || '');
  var issues = [];
  if (!/\/\*\*[\s\S]*?\*\//.test(source)) {
    issues.push('Add a JSDoc block with @input and @output annotations.');
  }
  if (!/@input\s+/m.test(source)) {
    issues.push('Add at least one @input annotation.');
  }
  if (!/@output\s+/m.test(source)) {
    issues.push('Add at least one @output annotation.');
  }
  if (!/async\s+function\s+execute\s*\(\s*inputs\s*,\s*context\s*\)/.test(source)) {
    issues.push('Use the required async function execute(inputs, context) signature.');
  }
  if (!/return\s*\{[\s\S]*\}/.test(source)) {
    issues.push('Return an object containing the declared outputs.');
  }
  try {
    new Function(source + '\nreturn typeof execute === "function";');
  } catch (err) {
    issues.push('Fix the JavaScript syntax error: ' + err.message);
  }
  return {
    ok: issues.length === 0,
    issues: issues,
    ports: parseWoodburyScriptPorts(source),
  };
}

var compScriptGenerationUiState = Object.create(null);

function getCompScriptGenerationState(nodeId) {
  return nodeId ? compScriptGenerationUiState[nodeId] || null : null;
}

function setCompScriptGenerationState(nodeId, state) {
  if (!nodeId) return;
  compScriptGenerationUiState[nodeId] = state;
}

function clearCompScriptGenerationState(nodeId) {
  if (!nodeId) return;
  delete compScriptGenerationUiState[nodeId];
}

function renderScriptGenerationTranscript(scriptCfg) {
  var transcript = scriptCfg && Array.isArray(scriptCfg.generationTranscript) ? scriptCfg.generationTranscript : [];
  var html = '';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Generation Transcript</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;margin-bottom:0.45rem;">Stored generation, repair, validation, and code-check passes for this script node.</div>';
  if (transcript.length === 0) {
    html += '<div style="color:#475569;font-size:0.72rem;">No transcript recorded yet.</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:0.5rem;max-height:320px;overflow:auto;">';
    for (var ti = 0; ti < transcript.length; ti++) {
      var entry = transcript[ti] || {};
      html += '<details style="border:1px solid rgba(129,140,248,0.16);border-radius:10px;background:rgba(15,23,42,0.5);padding:0.15rem 0.2rem;"' + (ti === transcript.length - 1 ? ' open' : '') + '>';
      html += '<summary style="cursor:pointer;list-style:none;color:#dbe4ff;font-size:0.72rem;font-weight:600;padding:0.45rem 0.55rem;">' + compEscHtml(entry.title || ('Step ' + (ti + 1))) + '</summary>';
      html += '<div style="padding:0 0.55rem 0.55rem 0.55rem;">';
      if (entry.stage) {
        html += '<div style="color:#818cf8;font-size:0.64rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.35rem;">' + compEscHtml(entry.stage) + '</div>';
      }
      html += '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:0.69rem;line-height:1.45;color:#cbd5e1;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">' + compEscHtml(entry.content || '') + '</pre>';
      html += '</div>';
      html += '</details>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderScriptProperties(body, node, nodeId) {
  var scriptCfg = node.script || { description: '', code: '', inputs: [], outputs: [], chatHistory: [], contextNodeIds: [] };
  var pendingGeneration = getCompScriptGenerationState(nodeId);
  var html = '';

  // Error display (if node has a failed state)
  var nodeError = lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].error;
  if (nodeError) {
    html += '<div class="comp-props-error-box" id="comp-props-error-box">';
    html += '<div class="comp-props-error-header">';
    html += '<span class="comp-props-error-title">&#x26A0; Execution Error</span>';
    html += '<span style="display:flex;gap:4px;">';
    html += '<span class="comp-props-error-repair" id="comp-props-error-repair">&#x26A1; Repair</span>';
    html += '<span class="comp-props-error-clear" id="comp-props-error-clear">Clear</span>';
    html += '</span>';
    html += '</div>';
    html += compEscHtml(nodeError);
    html += '</div>';
  }

  // Display Name
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Display Name</div>';
  html += '<input type="text" class="comp-props-input" id="comp-props-node-label" value="' + compEscAttr(node.label || '') + '" placeholder="Script">';
  html += '<button class="comp-script-name-btn" id="comp-script-name-btn" title="Generate a name with AI">&#x2728; Suggest name</button>';
  html += '</div>';

  // Type indicator
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Type</div>';
  html += '<div class="comp-props-value" style="color:#818cf8;">&#x192; Script Node</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">AI-generated code that transforms data in the pipeline.</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Generation Context</div>';
  var availableContextNodes = (compData && compData.nodes ? compData.nodes : []).filter(function(candidate) {
    return candidate.id !== nodeId;
  });
  if (availableContextNodes.length === 0) {
    html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">No other nodes available yet.</div>';
  } else {
    html += '<div class="comp-props-value" style="font-size:0.64rem;color:#64748b;margin-bottom:0.45rem;">Select the nodes the generator should consider while writing or refining this script.</div>';
    html += '<div style="display:flex;flex-direction:column;gap:0.45rem;max-height:180px;overflow:auto;padding:0.15rem 0;">';
    for (var ctxIndex = 0; ctxIndex < availableContextNodes.length; ctxIndex++) {
      var ctxNode = availableContextNodes[ctxIndex];
      var checked = (scriptCfg.contextNodeIds || []).indexOf(ctxNode.id) !== -1;
      html += '<label style="display:flex;align-items:flex-start;gap:8px;padding:0.45rem 0.55rem;border-radius:8px;background:rgba(15,23,42,0.45);border:1px solid rgba(255,255,255,0.06);cursor:pointer;">';
      html += '<input type="checkbox" class="comp-script-context-checkbox" data-node-id="' + compEscAttr(ctxNode.id) + '"' + (checked ? ' checked' : '') + ' style="margin-top:2px;accent-color:#818cf8;">';
      html += '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">';
      html += '<span style="color:#e2e8f0;font-size:0.72rem;">' + compEscHtml(getCompositionNodeDisplayName(ctxNode)) + '</span>';
      html += '<span style="color:#64748b;font-size:0.64rem;line-height:1.35;">' + compEscHtml(describeScriptGenerationNode(ctxNode)) + '</span>';
      html += '</span>';
      html += '</label>';
    }
    html += '</div>';
    html += '<div class="comp-props-value" style="font-size:0.64rem;color:#64748b;margin-top:0.35rem;">This uses the same explicit context selection model as the new-script generation modal.</div>';
  }
  html += '</div>';

  // Agent Chat
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Agent Chat</div>';
  html += '<div class="comp-script-chat" id="comp-script-chat">';
  var chatHistory = scriptCfg.chatHistory || [];
  for (var ci = 0; ci < chatHistory.length; ci++) {
    var msg = chatHistory[ci];
    var msgClass = msg.role === 'user' ? 'comp-script-chat-user' : 'comp-script-chat-assistant';
    html += '<div class="comp-script-chat-msg ' + msgClass + '">';
    html += '<div class="comp-script-chat-role">' + (msg.role === 'user' ? 'You' : 'Agent') + '</div>';
    html += '<div class="comp-script-chat-text">' + compEscHtml(msg.content) + '</div>';
    html += '</div>';
  }
  if (pendingGeneration && pendingGeneration.message) {
    html += '<div class="comp-script-chat-msg comp-script-chat-user">';
    html += '<div class="comp-script-chat-role">You</div>';
    html += '<div class="comp-script-chat-text">' + compEscHtml(pendingGeneration.message) + '</div>';
    html += '</div>';
  }
  if (chatHistory.length === 0 && !pendingGeneration) {
    html += '<div style="color:#475569;font-size:0.72rem;padding:0.5rem;">No messages yet. Describe what you want below.</div>';
  }
  html += '</div>';
  html += '<div class="comp-script-chat-input-wrap">';
  html += '<input type="text" class="comp-props-input" id="comp-script-chat-input" placeholder="Refine: e.g. also output a word count..."' + (pendingGeneration ? ' disabled' : '') + '>';
  html += '<button class="comp-tb-btn comp-tb-btn-run" id="comp-script-chat-send" style="padding:0.3rem 0.6rem;font-size:0.72rem;"' + (pendingGeneration ? ' disabled' : '') + '>Send</button>';
  html += '</div>';
  html += '<div id="comp-script-chat-status" style="display:' + (pendingGeneration ? '' : 'none') + ';margin-top:4px;">';
  html += '<div class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:4px;vertical-align:middle;"></div>';
  html += '<span style="color:#94a3b8;font-size:0.7rem;">' + compEscHtml((pendingGeneration && pendingGeneration.statusText) || 'Generating...') + '</span>';
  html += '</div>';
  html += '</div>';

  html += renderScriptGenerationTranscript(scriptCfg);

  // Code Preview
  html += '<div class="comp-props-section">';
  html += '<div class="comp-script-code-header">';
  html += '<div class="comp-props-label">Generated Code</div>';
  html += '<button class="comp-script-open-editor-btn" id="comp-script-open-editor">Open in Monaco</button>';
  html += '</div>';
  html += '<div class="comp-props-value comp-script-code-meta">Woodbury-aware editor with execute signature, @input/@output snippets, and context.tools hints.</div>';
  if (scriptCfg.code) {
    html += '<pre class="comp-script-code-preview" id="comp-script-code-preview">' + compEscHtml(scriptCfg.code) + '</pre>';
  } else {
    html += '<div style="color:#475569;font-size:0.72rem;">No code generated yet.</div>';
  }
  html += '</div>';

  // Ports Summary
  if (scriptCfg.inputs.length > 0 || scriptCfg.outputs.length > 0) {
    html += '<div class="comp-props-section">';
    html += '<div class="comp-props-label">Ports</div>';
    if (scriptCfg.inputs.length > 0) {
      html += '<div style="margin-bottom:6px;">';
      html += '<div style="color:#64748b;font-size:0.68rem;margin-bottom:2px;">Inputs</div>';
      for (var pi = 0; pi < scriptCfg.inputs.length; pi++) {
        var pIn = scriptCfg.inputs[pi];
        html += '<div class="comp-props-var-row">';
        html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(pIn.name)) + '</span>';
        html += '<span style="color:#64748b;font-size:0.65rem;margin-left:4px;">' + compEscHtml(pIn.type) + '</span>';
        if (pIn.description) {
          html += '<div class="comp-props-var-desc">' + compEscHtml(pIn.description) + '</div>';
        }
        var sInAlias = (node.portAliases && node.portAliases[pIn.name]) || '';
        html += '<input type="text" class="comp-props-input comp-props-alias-input" data-port-name="' + compEscAttr(pIn.name) + '" data-port-dir="in" value="' + compEscAttr(sInAlias) + '" placeholder="External name..." title="Alias for sub-pipeline usage">';
        html += '</div>';
      }
      html += '</div>';
    }
    if (scriptCfg.outputs.length > 0) {
      html += '<div>';
      html += '<div style="color:#64748b;font-size:0.68rem;margin-bottom:2px;">Outputs</div>';
      for (var po = 0; po < scriptCfg.outputs.length; po++) {
        var pOut = scriptCfg.outputs[po];
        html += '<div class="comp-props-var-row">';
        html += '<span class="comp-props-var-name">' + compEscHtml(humanizeVarName(pOut.name)) + '</span>';
        html += '<span style="color:#64748b;font-size:0.65rem;margin-left:4px;">' + compEscHtml(pOut.type) + '</span>';
        if (pOut.description) {
          html += '<div class="comp-props-var-desc">' + compEscHtml(pOut.description) + '</div>';
        }
        var sOutAlias = (node.portAliases && node.portAliases[pOut.name]) || '';
        html += '<input type="text" class="comp-props-input comp-props-alias-input" data-port-name="' + compEscAttr(pOut.name) + '" data-port-dir="out" value="' + compEscAttr(sOutAlias) + '" placeholder="External name..." title="Alias for sub-pipeline usage">';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }

  // On Failure policy
  var currentPolicy = (node.onFailure && node.onFailure.action) || 'stop';
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">On Failure</div>';
  html += '<select class="comp-props-input" id="comp-props-failure-policy">';
  html += '<option value="stop"' + (currentPolicy === 'stop' ? ' selected' : '') + '>Stop pipeline</option>';
  html += '<option value="skip"' + (currentPolicy === 'skip' ? ' selected' : '') + '>Skip and continue</option>';
  html += '</select>';
  html += '</div>';

  html += renderIdempotencySection(node);
  body.innerHTML = html;
  wireIdempotencyToggle(node, nodeId);

  // Wire up error clear button
  var errorClearBtn = body.querySelector('#comp-props-error-clear');
  if (errorClearBtn) {
    errorClearBtn.addEventListener('click', function() {
      clearNodeError(nodeId);
    });
  }

  // Wire up error repair button
  var errorRepairBtn = body.querySelector('#comp-props-error-repair');
  if (errorRepairBtn) {
    errorRepairBtn.addEventListener('click', function() {
      repairScriptNode(node, nodeId);
    });
  }

  // Scroll chat to bottom
  var chatEl = body.querySelector('#comp-script-chat');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

  // Wire up label editing
  var labelInput = body.querySelector('#comp-props-node-label');
  if (labelInput) {
    labelInput.addEventListener('change', function() {
      pushUndoSnapshot();
      node.label = labelInput.value.trim() || undefined;
      renderNodes();
      wireUpCanvas();
      debouncedSave();
    });
  }

  // Wire up suggest name button
  var nameBtn = body.querySelector('#comp-script-name-btn');
  if (nameBtn) {
    nameBtn.addEventListener('click', async function() {
      var desc = (node.script && node.script.description) || '';
      var code = (node.script && node.script.code) || '';
      if (!desc && !code) { toast('No description or code to generate a name from', 'error'); return; }

      nameBtn.disabled = true;
      nameBtn.textContent = '...';

      try {
        var res = await fetch('/api/generate-variable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variableName: 'node_name',
            variableType: 'string',
            workflowName: 'Pipeline',
            generationPrompt: 'Generate a short, descriptive name (2-4 words) for a pipeline script node that does the following: ' + desc + '. Return ONLY the name, nothing else.',
          }),
        });
        var data = await res.json();
        var suggestedName = (data.value || '').replace(/["']/g, '').trim();
        if (suggestedName && suggestedName.length > 1 && suggestedName.length < 40) {
          pushUndoSnapshot();
          node.label = suggestedName;
          labelInput.value = suggestedName;
          renderNodes();
          wireUpCanvas();
          debouncedSave();
        } else {
          toast('Could not generate a good name', 'error');
        }
      } catch (err) {
        toast('Name generation failed: ' + err.message, 'error');
      }

      nameBtn.disabled = false;
      nameBtn.textContent = '\u2728 Suggest name';
    });
  }

  // Wire up failure policy
  var policySelect = body.querySelector('#comp-props-failure-policy');
  if (policySelect) {
    policySelect.addEventListener('change', function() {
      pushUndoSnapshot();
      node.onFailure = node.onFailure || {};
      node.onFailure.action = policySelect.value;
      debouncedSave();
    });
  }

  var openEditorBtn = body.querySelector('#comp-script-open-editor');
  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', async function() {
      if (!window.WoodburyMonaco || typeof window.WoodburyMonaco.openScriptEditor !== 'function') {
        toast('Monaco editor is not available yet.', 'error');
        return;
      }

      var nextCode = await window.WoodburyMonaco.openScriptEditor({
        title: (node.label || 'Script Node') + ' Code',
        description: (node.script && node.script.description) || '',
        code: (node.script && node.script.code) || '',
        beforeSave: function(candidateCode) {
          var verdict = validateWoodburyScriptCode(candidateCode);
          return verdict.ok ? true : verdict.issues[0];
        },
      });

      if (typeof nextCode !== 'string') return;

      var validation = validateWoodburyScriptCode(nextCode);
      if (!validation.ok) {
        toast(validation.issues[0], 'error');
        return;
      }

      pushUndoSnapshot();
      node.script = node.script || {};
      node.script.code = nextCode;
      node.script.inputs = validation.ports.inputs;
      node.script.outputs = validation.ports.outputs;

      renderNodes();
      renderEdges();
      wireUpCanvas();
      updateNodeSelection();
      debouncedSave();
      renderScriptProperties(body, node, nodeId);
      toast('Script code updated', 'success');
    });
  }

  // Wire up port alias editing (script node)
  body.querySelectorAll('.comp-props-alias-input').forEach(function(input) {
    input.addEventListener('change', function() {
      var portName = input.getAttribute('data-port-name');
      if (!portName) return;
      if (!node.portAliases) node.portAliases = {};
      var val = input.value.trim();
      if (val) {
        node.portAliases[portName] = val;
      } else {
        delete node.portAliases[portName];
        if (Object.keys(node.portAliases).length === 0) delete node.portAliases;
      }
      debouncedSave();
    });
  });

  body.querySelectorAll('.comp-script-context-checkbox').forEach(function(input) {
    input.addEventListener('change', function() {
      node.script = node.script || {};
      node.script.contextNodeIds = [];
      body.querySelectorAll('.comp-script-context-checkbox:checked').forEach(function(checkedInput) {
        var selectedNodeId = checkedInput.getAttribute('data-node-id');
        if (selectedNodeId) node.script.contextNodeIds.push(selectedNodeId);
      });
      debouncedSave();
    });
  });

  // Wire up chat send
  var chatInput = body.querySelector('#comp-script-chat-input');
  var chatSendBtn = body.querySelector('#comp-script-chat-send');
  var chatStatus = body.querySelector('#comp-script-chat-status');

  function isScriptNodeSelected() {
    return selectedNodes.size === 1 && Array.from(selectedNodes)[0] === nodeId;
  }

  function runScriptChatRequest(message) {
    var generationState = getCompScriptGenerationState(nodeId);
    if (!generationState || generationState.requestStarted || generationState.message !== message) return;

    generationState.requestStarted = true;

    // Build full chat history
    var history = (node.script.chatHistory || []).slice();
    history.push({ role: 'user', content: message });

    fetch('/api/compositions/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: node.script.code ? 'edit' : 'generate',
        description: message,
        chatHistory: history.slice(0, -1),
        currentCode: node.script.code || undefined,
        graphContext: buildScriptGenerationContext(nodeId, node.script.contextNodeIds || []),
      }),
    })
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(result) {
        if (!result.ok) throw new Error(result.data.error || 'Generation failed');

        pushUndoSnapshot();
        clearCompScriptGenerationState(nodeId);

        node.script.code = result.data.code;
        node.script.inputs = result.data.inputs;
        node.script.outputs = result.data.outputs;
        node.script.chatHistory = history.concat([
          { role: 'assistant', content: result.data.assistantMessage },
        ]);
        if (Array.isArray(result.data.transcript)) {
          node.script.generationTranscript = (node.script.generationTranscript || []).concat(result.data.transcript);
        }

        renderNodes();
        renderEdges();
        wireUpCanvas();
        updateNodeSelection();
        debouncedSave();

        if (isScriptNodeSelected()) {
          renderScriptProperties(body, node, nodeId);
        }
      })
      .catch(function(err) {
        clearCompScriptGenerationState(nodeId);
        toast('Script generation failed: ' + err.message, 'error');
        if (isScriptNodeSelected()) {
          renderScriptProperties(body, node, nodeId);
        } else if (chatInput && chatSendBtn && chatStatus) {
          chatInput.disabled = false;
          chatSendBtn.disabled = false;
          chatStatus.style.display = 'none';
        }
      });
  }

  function sendScriptChat() {
    if (getCompScriptGenerationState(nodeId)) return;
    var message = chatInput.value.trim();
    if (!message) return;

    setCompScriptGenerationState(nodeId, {
      message: message,
      statusText: 'Generating...',
      requestStarted: false,
    });

    renderScriptProperties(body, node, nodeId);
  }

  if (pendingGeneration && pendingGeneration.message && !pendingGeneration.requestStarted) {
    runScriptChatRequest(pendingGeneration.message);
  }

  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', sendScriptChat);
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendScriptChat();
      }
    });
  }
}

function renderEdgeProperties(edgeId) {
  var body = document.querySelector('#comp-props-body');
  if (!body || !compData) return;

  var edge = compData.edges.find(function(e) { return e.id === edgeId; });
  if (!edge) return;

  var srcNode = compData.nodes.find(function(n) { return n.id === edge.sourceNodeId; });
  var tgtNode = compData.nodes.find(function(n) { return n.id === edge.targetNodeId; });
  var srcWf = srcNode ? getWorkflowForNode(srcNode) : null;
  var tgtWf = tgtNode ? getWorkflowForNode(tgtNode) : null;
  var srcName = srcNode ? (srcNode.label || (srcWf ? srcWf.name : srcNode.workflowId)) : '?';
  var tgtName = tgtNode ? (tgtNode.label || (tgtWf ? tgtWf.name : tgtNode.workflowId)) : '?';

  var html = '';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Connection</div>';
  html += '<div class="comp-props-value">' + compEscHtml(humanizeVarName(edge.sourcePort)) + ' &rarr; ' + compEscHtml(humanizeVarName(edge.targetPort)) + '</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">From</div>';
  html += '<div class="comp-props-value">' + compEscHtml(srcName) + '</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#a78bfa;">' + compEscHtml(humanizeVarName(edge.sourcePort)) + '</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">To</div>';
  html += '<div class="comp-props-value">' + compEscHtml(tgtName) + '</div>';
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#06b6d4;">' + compEscHtml(humanizeVarName(edge.targetPort)) + '</div>';
  html += '</div>';

  html += '<div class="comp-props-section">';
  html += '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-props-del-edge" style="width:100%;">Remove Connection</button>';
  html += '</div>';

  body.innerHTML = html;

  var delBtn = body.querySelector('#comp-props-del-edge');
  if (delBtn) {
    delBtn.addEventListener('click', function() {
      deleteSelected();
    });
  }
}
