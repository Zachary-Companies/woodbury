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


// ── Auto-Layout ──────────────────────────────────────────────

function layoutNodesInternal() {
  if (!compData || compData.nodes.length === 0) return;

  // Step 1: Build adjacency
  var adj = {};
  compData.nodes.forEach(function(n) { adj[n.id] = []; });
  compData.edges.forEach(function(e) {
    if (adj[e.sourceNodeId]) adj[e.sourceNodeId].push(e.targetNodeId);
  });

  // Step 2: Assign layers via longest path from roots (DFS)
  var layers = {};
  var visited = {};

  function assignLayer(nodeId) {
    if (visited[nodeId]) return layers[nodeId];
    visited[nodeId] = true;

    var maxPredLayer = -1;
    compData.edges.forEach(function(e) {
      if (e.targetNodeId === nodeId && adj[e.sourceNodeId]) {
        maxPredLayer = Math.max(maxPredLayer, assignLayer(e.sourceNodeId));
      }
    });

    layers[nodeId] = maxPredLayer + 1;
    return layers[nodeId];
  }

  compData.nodes.forEach(function(n) { assignLayer(n.id); });

  // Step 3: Group nodes by layer
  var layerGroups = {};
  var maxLayer = 0;
  compData.nodes.forEach(function(n) {
    var layer = layers[n.id] || 0;
    if (!layerGroups[layer]) layerGroups[layer] = [];
    layerGroups[layer].push(n);
    maxLayer = Math.max(maxLayer, layer);
  });

  // Step 4: Order within layers by median of predecessor Y positions
  for (var l = 1; l <= maxLayer; l++) {
    var group = layerGroups[l] || [];
    group.forEach(function(node) {
      var predPositions = [];
      compData.edges.forEach(function(e) {
        if (e.targetNodeId === node.id) {
          var predNode = compData.nodes.find(function(n) { return n.id === e.sourceNodeId; });
          if (predNode) predPositions.push(predNode.position.y);
        }
      });
      node._medianPredY = predPositions.length > 0
        ? predPositions.sort(function(a, b) { return a - b; })[Math.floor(predPositions.length / 2)]
        : 0;
    });
    group.sort(function(a, b) { return (a._medianPredY || 0) - (b._medianPredY || 0); });
    layerGroups[l] = group;
  }

  // Step 5: Assign positions
  var layerSpacing = 350;
  var nodeSpacing = 160;
  var startX = 100;
  var startY = 100;

  for (var layer = 0; layer <= maxLayer; layer++) {
    var grp = layerGroups[layer] || [];
    for (var idx = 0; idx < grp.length; idx++) {
      grp[idx].position.x = startX + layer * layerSpacing;
      grp[idx].position.y = startY + idx * nodeSpacing;
      delete grp[idx]._medianPredY;
    }
  }
}

function autoLayoutNodes() {
  if (!compData || compData.nodes.length === 0) return;
  pushUndoSnapshot();
  layoutNodesInternal();
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

function startCompositionRun() {
  if (!compData) return;

  // Client-side cycle detection
  if (compData.nodes.length > 0 && !clientTopoSort()) {
    toast('These workflows form a loop — each step needs to run after the ones connected to it, but a loop makes that impossible', 'error');
    return;
  }

  if (compData.nodes.length === 0) {
    toast('Add at least one workflow to run this pipeline', 'error');
    return;
  }

  fetch('/api/compositions/' + encodeURIComponent(compData.id) + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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
        toast(data.error || 'Failed to start', 'error');
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

      // Update overall progress bar
      var pct = data.nodesTotal > 0 ? Math.round((data.nodesCompleted / data.nodesTotal) * 100) : 0;
      var bar = document.querySelector('#comp-progress-bar');
      var text = document.querySelector('#comp-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = data.nodesCompleted + '/' + data.nodesTotal + ' steps';

      // Update per-node states
      if (data.nodeStates) {
        lastNodeStates = data.nodeStates;
        for (var nodeId in data.nodeStates) {
          var ns = data.nodeStates[nodeId];
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
        if (data.success) {
          toast('Pipeline finished! (' + (data.durationMs / 1000).toFixed(1) + 's)', 'success');
          if (progressBar) progressBar.style.background = '#22c55e';
        } else {
          toast('Pipeline failed: ' + (data.error || 'Something went wrong'), 'error');
          if (progressBar) progressBar.style.background = '#ef4444';
        }

        // Re-render nodes so image viewers pick up runtime file paths
        renderNodes();
        renderEdges();
        wireUpCanvas();
        // Re-apply execution state overlays after re-render
        if (data.nodeStates) {
          for (var doneNodeId in data.nodeStates) {
            var doneNs = data.nodeStates[doneNodeId];
            updateNodeExecutionState(doneNodeId, doneNs.status);
          }
        }

        // Hide progress bar after 5s; clear overlays only on success
        // On failure, keep error banners visible so user can see what went wrong
        setTimeout(function() {
          var wrap = document.querySelector('#comp-progress-wrap');
          if (wrap) wrap.style.display = 'none';
          if (data.success) {
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
    var isScriptNode = compData && compData.nodes && compData.nodes.find(function(n) { return n.id === nodeId && n.workflowId === '__script__'; });
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
    var repairDescription = 'Fix this script node. It failed during execution with the following error:\n\n' +
      nodeError + '\n\nPlease fix the bug in the code. Do NOT change the @input/@output annotations — only fix the implementation.';

    var res = await fetch('/api/compositions/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: repairDescription,
        chatHistory: node.script.chatHistory || [],
        currentCode: node.script.code || '',
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

function injectNodeErrorDisplay(body, nodeId) {
  // Inject error box at the top of the properties panel body for any failed node
  var nodeError = lastNodeStates && lastNodeStates[nodeId] && lastNodeStates[nodeId].error;
  if (nodeError) {
    // Check if this is a script node (to show repair button)
    var theNode = compData && compData.nodes ? compData.nodes.find(function(n) { return n.id === nodeId; }) : null;
    var isScript = theNode && theNode.workflowId === '__script__' && theNode.script;

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
      '</div>' + compEscHtml(nodeError);
    body.insertBefore(errorDiv, body.firstChild);

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
