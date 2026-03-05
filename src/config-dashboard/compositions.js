/**
 * Pipelines Dashboard — Client-side JavaScript
 *
 * Visual graph editor for chaining workflows into pipelines.
 * SVG + div-based canvas with pan, zoom, drag-to-position nodes.
 * Loaded alongside app.js in the same SPA.
 */

// ── State ────────────────────────────────────────────────────
var compositions = [];
var selectedComposition = null;
var compData = null; // Active CompositionDocument being edited
var compPath = null; // File path on disk
var workflowCache = []; // Cached GET /api/workflows result
var canvasState = { panX: 0, panY: 0, zoom: 1 };
var dragState = null; // { type: 'node'|'edge'|'pan', ... }
var selectedEdge = null;
var selectedNodes = new Set(); // Set of node IDs (multi-select)
var saveTimer = null; // Debounced save
var compRunPollTimer = null; // Composition run polling
var lastNodeStates = null; // Cached node states from last run (for port value tooltips)

// Undo/Redo
var undoStack = [];
var redoStack = [];
var MAX_UNDO = 50;

// Copy/Paste
var clipboard = null; // { nodes: [...], edges: [...] }

// Snap-to-grid
var snapToGrid = false;
var GRID_SIZE = 20;

// Context menu
var contextMenuEl = null;

// ── Utilities ────────────────────────────────────────────────

function compEscHtml(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function compEscAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function genId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

/** Backward-compatible helper: returns the single selected node ID or null */
function getSelectedNode() {
  return selectedNodes.size === 1 ? Array.from(selectedNodes)[0] : null;
}

/** Convert raw variable name to human-readable form: download_path → Download Path */
function humanizeVarName(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

// ── Port Value Tooltip Utilities ─────────────────────────────

function getPortTooltip() {
  var el = document.querySelector('#comp-port-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'comp-port-tooltip';
    el.className = 'comp-port-tooltip';
    document.body.appendChild(el);
  }
  return el;
}

function formatPortValue(value) {
  if (value === undefined) return null; // No data — don't show tooltip
  if (value === null) return '<span class="comp-port-tooltip-none">null</span>';
  if (typeof value === 'string') {
    if (value.length === 0) return '<span class="comp-port-tooltip-none">(empty string)</span>';
    if (value.length > 500) {
      return '<span class="comp-port-tooltip-value">' + compEscHtml(value.slice(0, 500)) + '</span><span class="comp-port-tooltip-none">\u2026 (' + value.length + ' chars)</span>';
    }
    return '<span class="comp-port-tooltip-value">' + compEscHtml(value) + '</span>';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return '<span class="comp-port-tooltip-value">' + String(value) + '</span>';
  }
  // Object/array — pretty-print JSON
  try {
    var json = JSON.stringify(value, null, 2);
    if (json.length > 500) {
      json = json.slice(0, 500) + '\n\u2026 (truncated)';
    }
    return '<span class="comp-port-tooltip-value">' + compEscHtml(json) + '</span>';
  } catch (e) {
    return '<span class="comp-port-tooltip-none">[unserializable]</span>';
  }
}

function lookupPortValue(nodeId, portName, direction) {
  if (!lastNodeStates) return undefined;
  var ns = lastNodeStates[nodeId];
  if (!ns) return undefined;
  if (direction === 'out') {
    return ns.outputVariables && ns.outputVariables[portName] !== undefined ? ns.outputVariables[portName] : undefined;
  } else {
    return ns.inputVariables && ns.inputVariables[portName] !== undefined ? ns.inputVariables[portName] : undefined;
  }
}

function describeExpectation(exp) {
  if (!exp || !exp.type) return 'Unknown expectation';
  switch (exp.type) {
    case 'file_count':
      return 'At least ' + (exp.minCount || 1) + ' file(s) matching "' + (exp.pattern || '*') + '" in ' + (exp.directory || '...');
    case 'file_exists':
      return 'File exists: ' + (exp.path || '...');
    case 'variable_not_empty':
      return '"' + humanizeVarName(exp.variable || '?') + '" is not empty';
    case 'variable_equals':
      return '"' + humanizeVarName(exp.variable || '?') + '" equals ' + JSON.stringify(exp.value);
    default:
      return exp.description || 'Custom expectation';
  }
}

// ── API ──────────────────────────────────────────────────────

async function fetchCompositions() {
  try {
    var res = await fetch('/api/compositions');
    var data = await res.json();
    compositions = data.compositions || [];
    renderCompSidebar();
  } catch (err) {
    document.querySelector('#comp-list').innerHTML =
      '<div style="padding:1rem;color:#ef4444;font-size:0.8rem;">Failed to load pipelines.</div>';
  }
}

async function fetchCompositionDetail(id) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(id));
  if (!res.ok) throw new Error('Pipeline not found');
  return res.json();
}

async function saveComposition(comp) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(comp.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ composition: comp }),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed');
  return data;
}

async function createComposition(name, description) {
  var res = await fetch('/api/compositions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, description: description }),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Create failed');
  return data;
}

async function deleteComposition(id) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Delete failed');
  return data;
}

async function renameComposition(id, newName) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(id) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Rename failed');
  return data;
}

function startPipelineRename() {
  if (!compData) return;
  var titleEl = document.querySelector('#comp-pipeline-title');
  if (!titleEl || titleEl.querySelector('input')) return;

  var currentName = compData.name;
  titleEl.innerHTML = '<input type="text" id="comp-rename-input" value="' + compEscAttr(currentName) + '" ' +
    'style="font-size:inherit;font-weight:inherit;background:#1e293b;color:#e2e8f0;border:1px solid #7c3aed;' +
    'border-radius:4px;padding:2px 6px;width:200px;outline:none;" autofocus>';

  var input = document.getElementById('comp-rename-input');
  input.focus();
  input.select();

  async function commitRename() {
    var newName = input.value.trim();
    if (!newName || newName === currentName) {
      titleEl.textContent = currentName;
      return;
    }
    try {
      var result = await renameComposition(compData.id, newName);
      compData.name = newName;
      toast('Renamed to "' + newName + '"', 'success');
      await fetchCompositions();
      renderCompSidebar();
      titleEl.textContent = newName;
    } catch (err) {
      toast('Rename failed: ' + err.message, 'error');
      titleEl.textContent = currentName;
    }
  }

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') { titleEl.textContent = currentName; }
  });
  input.addEventListener('blur', commitRename);
}

async function fetchWorkflowsForNodes() {
  try {
    var res = await fetch('/api/workflows');
    var data = await res.json();
    workflowCache = data.workflows || [];
  } catch {
    workflowCache = [];
  }
}

// ── Debounced save ───────────────────────────────────────────

function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async function() {
    if (!compData) return;
    // Save viewport state
    compData.metadata = compData.metadata || {};
    compData.metadata.viewport = {
      panX: canvasState.panX,
      panY: canvasState.panY,
      zoom: canvasState.zoom,
    };
    try {
      await saveComposition(compData);
    } catch (err) {
      if (typeof toast === 'function') toast('Auto-save failed: ' + err.message, 'error');
    }
  }, 500);
}

function immediateSave() {
  if (saveTimer) clearTimeout(saveTimer);
  if (!compData) return;
  compData.metadata = compData.metadata || {};
  compData.metadata.viewport = {
    panX: canvasState.panX,
    panY: canvasState.panY,
    zoom: canvasState.zoom,
  };
  saveComposition(compData).catch(function(err) {
    if (typeof toast === 'function') toast('Save failed: ' + err.message, 'error');
  });
}

// ── Undo / Redo ──────────────────────────────────────────────

function pushUndoSnapshot() {
  if (!compData) return;
  var snapshot = JSON.parse(JSON.stringify(compData));
  undoStack.push(snapshot);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}

function undo() {
  if (undoStack.length === 0 || !compData) return;
  redoStack.push(JSON.parse(JSON.stringify(compData)));
  compData = undoStack.pop();
  selectedNodes.clear();
  selectedEdge = null;
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  updateMinimap();
  updateUndoRedoButtons();
  updateDeleteButton();
  updatePropertiesPanel();
}

function redo() {
  if (redoStack.length === 0 || !compData) return;
  undoStack.push(JSON.parse(JSON.stringify(compData)));
  compData = redoStack.pop();
  selectedNodes.clear();
  selectedEdge = null;
  renderNodes();
  renderEdges();
  wireUpCanvas();
  immediateSave();
  updateMinimap();
  updateUndoRedoButtons();
  updateDeleteButton();
  updatePropertiesPanel();
}

function updateUndoRedoButtons() {
  var undoBtn = document.querySelector('#comp-undo-btn');
  var redoBtn = document.querySelector('#comp-redo-btn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// ── Validation Warnings ──────────────────────────────────────

function computeValidationWarnings() {
  if (!compData) return [];
  var warnings = [];

  compData.nodes.forEach(function(node) {
    // Orphan nodes (no edges at all, only warn if >1 node)
    if (compData.nodes.length > 1) {
      var hasEdge = compData.edges.some(function(e) {
        return e.sourceNodeId === node.id || e.targetNodeId === node.id;
      });
      if (!hasEdge) {
        warnings.push({ nodeId: node.id, type: 'orphan', message: 'Not connected to other workflows' });
      }
    }

    // Missing workflows (skip special nodes)
    if (node.workflowId !== '__approval_gate__' && node.workflowId !== '__script__' && node.workflowId !== '__output__' && node.workflowId !== '__image_viewer__' && node.workflowId !== '__branch__' && node.workflowId !== '__delay__' && node.workflowId !== '__gate__' && node.workflowId !== '__for_each__' && node.workflowId !== '__switch__' && !node.workflowId.startsWith('comp:')) {
      var wf = getWorkflowForNode(node);
      if (!wf) {
        warnings.push({ nodeId: node.id, type: 'missing', message: 'Workflow was deleted or renamed' });
      }
    }

    // Output node with no ports
    if (node.workflowId === '__output__' && node.outputNode && node.outputNode.ports.length === 0) {
      warnings.push({ nodeId: node.id, type: 'empty-output', message: 'Output node has no ports — add ports to collect pipeline results' });
    }
  });

  return warnings;
}

// ── Sidebar ──────────────────────────────────────────────────

function renderCompSidebar() {
  var list = document.querySelector('#comp-list');
  if (!list) return;

  var html = '<div style="padding:0.5rem;">';
  html += '<button class="btn-new-comp" id="btn-new-comp" style="width:100%;padding:0.5rem;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;margin-bottom:0.5rem;">';
  html += '+ New Pipeline</button>';
  html += '<input type="text" class="comp-sidebar-search" id="comp-sidebar-search" placeholder="Search pipelines...">';
  html += '</div>';

  if (compositions.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.8rem;">No pipelines yet. Create one to chain workflows together.</div>';
  } else {
    html += compositions.map(function(c) {
      var active = selectedComposition === c.id ? ' active' : '';
      return '<div class="ext-item' + active + '" data-comp-id="' + compEscAttr(c.id) + '">' +
        '<div class="ext-item-name">' + compEscHtml(c.name) + '</div>' +
        '<div class="ext-item-meta">' + c.nodeCount + ' step' + (c.nodeCount !== 1 ? 's' : '') + ' &middot; ' + c.edgeCount + ' connection' + (c.edgeCount !== 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');
  }

  list.innerHTML = html;

  // Wire up clicks
  var newBtn = document.querySelector('#btn-new-comp');
  if (newBtn) {
    newBtn.addEventListener('click', function() {
      showCreateForm();
    });
  }

  list.querySelectorAll('.ext-item[data-comp-id]').forEach(function(el) {
    el.addEventListener('click', function() {
      selectComposition(el.dataset.compId);
    });
  });

  // Wire up sidebar search
  var searchInput = document.querySelector('#comp-sidebar-search');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase().trim();
      list.querySelectorAll('.ext-item[data-comp-id]').forEach(function(el) {
        var name = (el.querySelector('.ext-item-name') || {}).textContent || '';
        el.style.display = (!q || name.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
    });
  }
}

function showCreateForm() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div class="comp-create-form">' +
      '<h2>New Pipeline</h2>' +
      '<label>Name</label>' +
      '<input type="text" id="comp-name-input" placeholder="e.g. Song Pipeline" style="width:100%;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;margin-bottom:0.75rem;">' +
      '<label>Description (optional)</label>' +
      '<input type="text" id="comp-desc-input" placeholder="What does this pipeline do?" style="width:100%;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;margin-bottom:1rem;">' +
      '<div class="comp-template-section">' +
        '<div class="comp-template-label">Or start from a pattern:</div>' +
        '<div class="comp-template-card" data-tmpl-name="Two-Step Chain" data-tmpl-desc="Run one workflow, pass its output to the next">' +
          '<div class="comp-template-icon">&#x27a1;&#xfe0f;</div>' +
          '<div class="comp-template-info"><strong>Two-Step Chain</strong><br>Run one workflow, pass its output to the next</div>' +
        '</div>' +
        '<div class="comp-template-card" data-tmpl-name="Fan Out" data-tmpl-desc="Send one workflow\'s output to several workflows in parallel">' +
          '<div class="comp-template-icon">&#x1f500;</div>' +
          '<div class="comp-template-info"><strong>Fan Out</strong><br>Send one workflow\'s output to several workflows in parallel</div>' +
        '</div>' +
        '<div class="comp-template-card" data-tmpl-name="Gather &amp; Process" data-tmpl-desc="Run multiple workflows, then combine their results into one">' +
          '<div class="comp-template-icon">&#x1f504;</div>' +
          '<div class="comp-template-info"><strong>Gather &amp; Process</strong><br>Run multiple workflows, then combine their results into one</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:0.5rem;margin-top:1rem;">' +
        '<button id="comp-create-btn" style="padding:0.5rem 1.5rem;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;">Create</button>' +
        '<button id="comp-cancel-btn" style="padding:0.5rem 1rem;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;">Cancel</button>' +
      '</div>' +
    '</div>';

  // Wire up template card clicks to pre-fill the name
  document.querySelectorAll('.comp-template-card').forEach(function(card) {
    card.addEventListener('click', function() {
      document.querySelectorAll('.comp-template-card').forEach(function(c) { c.classList.remove('comp-template-card-active'); });
      card.classList.add('comp-template-card-active');
      var nameInput = document.querySelector('#comp-name-input');
      var descInput = document.querySelector('#comp-desc-input');
      if (nameInput && !nameInput.value.trim()) nameInput.value = card.dataset.tmplName;
      if (descInput && !descInput.value.trim()) descInput.value = card.dataset.tmplDesc;
    });
  });

  document.querySelector('#comp-create-btn').addEventListener('click', async function() {
    var nameInput = document.querySelector('#comp-name-input');
    var descInput = document.querySelector('#comp-desc-input');
    var name = nameInput.value.trim();
    if (!name) { toast('Give your pipeline a name', 'error'); return; }
    try {
      var result = await createComposition(name, descInput.value.trim());
      toast('Pipeline created!', 'success');
      await fetchCompositions();
      selectComposition(result.composition.id);
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });

  document.querySelector('#comp-cancel-btn').addEventListener('click', function() {
    main.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon">&#x1f517;</div>' +
      '<h2>Pipelines</h2>' +
      '<p>Select a pipeline from the sidebar or create a new one.</p>' +
      '</div>';
  });
}

// ── Select & Load Composition ────────────────────────────────

async function selectComposition(id) {
  selectedComposition = id;

  // Update URL hash for deep linking
  if (typeof updateHash === 'function') {
    updateHash('compositions', id);
  }

  // Update sidebar active state
  document.querySelectorAll('#comp-list .ext-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.compId === id);
  });

  var main = document.querySelector('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  try {
    // Fetch composition and workflow data in parallel
    var [compResult] = await Promise.all([
      fetchCompositionDetail(id),
      fetchWorkflowsForNodes(),
    ]);

    compData = compResult.composition;
    compPath = compResult.path;

    // Restore viewport state
    if (compData.metadata && compData.metadata.viewport) {
      canvasState.panX = compData.metadata.viewport.panX || 0;
      canvasState.panY = compData.metadata.viewport.panY || 0;
      canvasState.zoom = compData.metadata.viewport.zoom || 1;
    } else {
      canvasState = { panX: 0, panY: 0, zoom: 1 };
    }

    selectedEdge = null;
    selectedNodes.clear();
    undoStack = [];
    redoStack = [];

    renderGraphEditor();
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x26a0;&#xfe0f;</div>' +
      '<h2>Error</h2><p>' + compEscHtml(err.message) + '</p></div>';
  }
}

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
  html += '<div class="comp-add-dropdown-group-label">Flow Control</div>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-branch" id="comp-add-branch">&#x2194; Branch</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-delay" id="comp-add-delay">&#x23f3; Delay</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-gatenode" id="comp-add-gate-node">&#x26d4; Gate</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-loop" id="comp-add-loop">&#x1f504; ForEach Loop</button>';
  html += '<button class="comp-add-dropdown-item comp-add-dropdown-switch" id="comp-add-switch">&#x2b82; Switch</button>';
  html += '</div>';
  html += '</div>';
  html += '<button class="comp-tb-btn" id="comp-undo-btn" title="Undo (Ctrl+Z)" disabled>&#x21a9;</button>';
  html += '<button class="comp-tb-btn" id="comp-redo-btn" title="Redo (Ctrl+Shift+Z)" disabled>&#x21aa;</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-delete-selected" title="Remove selected" style="display:none;">&#x1f5d1; Remove</button>';
  html += '<button class="comp-tb-btn" id="comp-auto-layout" title="Tidy up layout">&#x2195; Layout</button>';
  html += '<button class="comp-tb-btn" id="comp-snap-toggle" title="Snap to grid">Grid</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-run" id="comp-run-btn" title="Run this pipeline">&#x25b6; Run</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-batch" id="comp-batch-btn" title="Run with different variable sets">&#x1f4e6; Batch</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-schedule" id="comp-schedule-btn" title="Schedule this pipeline">&#x23f0; Schedule</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-cancel" id="comp-cancel-btn" title="Stop running" style="display:none;">&#x25a0; Stop</button>';
  html += '<button class="comp-tb-btn" id="comp-zoom-fit" title="Fit to view">Fit</button>';
  html += '<span class="comp-zoom-label" id="comp-zoom-label">' + Math.round(canvasState.zoom * 100) + '%</span>';
  html += '<button class="comp-tb-btn" id="comp-tools-btn" title="Configure script tools">&#x1f527; Tools</button>';
  html += '<button class="comp-tb-btn" id="comp-export" title="Download pipeline file">Export</button>';
  html += '<button class="comp-tb-btn" id="comp-import" title="Upload pipeline file">Import</button>';
  html += '<button class="comp-tb-btn" id="comp-rename-composition" title="Rename pipeline">Rename</button>';
  html += '<button class="comp-tb-btn" id="comp-duplicate-composition" title="Make a copy">Copy</button>';
  html += '<button class="comp-tb-btn comp-tb-btn-danger" id="comp-delete-composition" title="Delete pipeline">&#x1f5d1;</button>';
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
    var isBranch = node.workflowId === '__branch__';
    var isDelay = node.workflowId === '__delay__';
    var isGateNode = node.workflowId === '__gate__';
    var isForEach = node.workflowId === '__for_each__';
    var isSwitch = node.workflowId === '__switch__';
    var isFlowControl = isBranch || isDelay || isGateNode || isForEach || isSwitch;
    var isSpecial = isGate || isScript || isOutput || isComposition || isImageViewer || isFlowControl;
    var wf = isSpecial ? null : getWorkflowForNode(node);
    var isSelected = selectedNodes.has(node.id);
    var nodeWarnings = warnings.filter(function(w) { return w.nodeId === node.id; });
    var displayName = node.label
      || (isGate ? 'Approval Gate'
        : isScript ? 'Script'
        : isOutput ? 'Pipeline Output'
        : isImageViewer ? 'Image Viewer'
        : isBranch ? 'Branch'
        : isDelay ? 'Delay'
        : isGateNode ? 'Gate'
        : isForEach ? 'ForEach Loop'
        : isSwitch ? 'Switch'
        : isComposition ? 'Pipeline'
        : (wf ? wf.name : node.workflowId));

    var nodeWidthStyle = '';
    if (isImageViewer && node.imageViewer) {
      nodeWidthStyle = 'width:' + (node.imageViewer.width + 40) + 'px;'; // +40 for port columns + padding
    }
    var nodeClass = 'comp-node';
    if (isGate) nodeClass += ' comp-node-gate';
    if (isScript) nodeClass += ' comp-node-script';
    if (isOutput) nodeClass += ' comp-node-output';
    if (isComposition) nodeClass += ' comp-node-composition';
    if (isImageViewer) nodeClass += ' comp-node-image-viewer';
    if (isBranch) nodeClass += ' comp-node-branch';
    if (isDelay) nodeClass += ' comp-node-delay';
    if (isGateNode) nodeClass += ' comp-node-gate-node';
    if (isForEach) nodeClass += ' comp-node-for-each';
    if (isSwitch) nodeClass += ' comp-node-switch';
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
      html += '<span class="comp-node-composition-icon">&#x1f517;</span>';
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
    } else if (isImageViewer) {
      html += '<span class="comp-node-image-viewer-icon">&#x1f5bc;</span>';
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
    } else if (wf) {
      html += '<span class="comp-node-name">' + compEscHtml(displayName) + '</span>';
      if (wf.site) {
        html += '<span class="comp-node-site">' + compEscHtml(wf.site) + '</span>';
      }
    } else {
      html += '<span class="comp-node-name" style="color:#ef4444;">Missing: ' + compEscHtml(node.workflowId) + '</span>';
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
      // ForEach node — 1 input (items), 3 outputs (current_item, results, count)
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
      // current_item output
      var feItemPortId = node.id + ':out:current_item';
      var feItemConn = isPortConnected(node.id, 'current_item', 'output');
      html += '<div class="comp-port comp-port-out' + (feItemConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feItemPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="current_item" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Current item in iteration">Item</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      // results output
      var feResPortId = node.id + ':out:results';
      var feResConn = isPortConnected(node.id, 'results', 'output');
      html += '<div class="comp-port comp-port-out' + (feResConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feResPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="results" data-port-dir="out">';
      html += '<span class="comp-port-label" title="All items (array)">Results</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      // count output
      var feCntPortId = node.id + ':out:count';
      var feCntConn = isPortConnected(node.id, 'count', 'output');
      html += '<div class="comp-port comp-port-out' + (feCntConn ? ' comp-port-connected' : '') + '" data-port-id="' + compEscAttr(feCntPortId) + '" data-node-id="' + compEscAttr(node.id) + '" data-port-name="count" data-port-dir="out">';
      html += '<span class="comp-port-label" title="Number of items">Count</span>';
      html += '<div class="comp-port-dot comp-port-dot-out"></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // Footer
      html += '<div class="comp-node-footer">';
      html += '<span style="color:#22c55e;font-size:0.6rem;">var: ' + compEscHtml(feCfg.itemVariable) + ' | max: ' + feCfg.maxIterations + '</span>';
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

    html += '<path class="comp-edge' + (isSelected ? ' comp-edge-selected' : '') + '" data-edge-id="' + compEscAttr(edge.id) + '" d="" />';
    // Edge label — humanized variable name
    html += '<text class="comp-edge-label" data-edge-id="' + compEscAttr(edge.id) + '" x="0" y="0">' + compEscHtml(humanizeVarName(edge.sourcePort)) + '</text>';
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
      'comp-add-branch': function() { addBranchNode(); },
      'comp-add-delay': function() { addDelayNode(); },
      'comp-add-gate-node': function() { addGateNode(); },
      'comp-add-loop': function() { addForEachNode(); },
      'comp-add-switch': function() { addSwitchNode(); },
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

  // Rename (button + double-click on title)
  var renameCompBtn = document.querySelector('#comp-rename-composition');
  if (renameCompBtn) {
    renameCompBtn.addEventListener('click', function() { startPipelineRename(); });
  }
  var pipelineTitleEl = document.querySelector('#comp-pipeline-title');
  if (pipelineTitleEl) {
    pipelineTitleEl.addEventListener('dblclick', function() { startPipelineRename(); });
  }

  var deleteCompBtn = document.querySelector('#comp-delete-composition');
  if (deleteCompBtn) {
    deleteCompBtn.addEventListener('click', async function() {
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
    });
  }

  // Undo/Redo buttons
  var undoBtn = document.querySelector('#comp-undo-btn');
  if (undoBtn) { undoBtn.addEventListener('click', function() { undo(); }); }
  var redoBtn = document.querySelector('#comp-redo-btn');
  if (redoBtn) { redoBtn.addEventListener('click', function() { redo(); }); }

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
  var runBtn = document.querySelector('#comp-run-btn');
  if (runBtn) { runBtn.addEventListener('click', function() { startCompositionRun(); }); }
  var batchBtn = document.querySelector('#comp-batch-btn');
  if (batchBtn) { batchBtn.addEventListener('click', function() { showBatchConfigModal(); }); }
  var scheduleBtn = document.querySelector('#comp-schedule-btn');
  if (scheduleBtn) { scheduleBtn.addEventListener('click', function() { showScheduleModal(); }); }
  var toolsBtn = document.querySelector('#comp-tools-btn');
  if (toolsBtn) { toolsBtn.addEventListener('click', function() { showToolDocsModal(); }); }
  var cancelBtn = document.querySelector('#comp-cancel-btn');
  if (cancelBtn) { cancelBtn.addEventListener('click', function() { cancelCompositionRun(); }); }

  // Export button
  var exportBtn = document.querySelector('#comp-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', function() {
      if (!compData) return;
      var blob = new Blob([JSON.stringify(compData, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = compData.id + '.composition.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('Downloaded ' + compData.name, 'success');
    });
  }

  // Import button
  var importBtn = document.querySelector('#comp-import');
  if (importBtn) {
    importBtn.addEventListener('click', function() {
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
          // Create as new composition
          var baseName = imported.name || 'Imported';
          var result = await createComposition(baseName + ' (Imported)', imported.description || '');
          // Update with full nodes/edges data
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
    });
  }

  // Duplicate composition button
  var dupBtn = document.querySelector('#comp-duplicate-composition');
  if (dupBtn) {
    dupBtn.addEventListener('click', async function() {
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
    });
  }

  // Properties panel close
  var propsClose = document.querySelector('#comp-props-close');
  if (propsClose) {
    propsClose.addEventListener('click', function() {
      selectedNodes.clear();
      selectedEdge = null;
      updateNodeSelection();
      updateEdgeSelection();
      updateDeleteButton();
      hidePropertiesPanel();
    });
  }
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

  // Calculate center of viewport
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;

  // Add some offset if there are already nodes near center
  var offset = compData.nodes.length * 30;

  var node = {
    id: genId('node'),
    workflowId: workflowId,
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
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

  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;

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
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
    label: compName,
    compositionRef: { compositionId: compositionId },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;

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

  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;

  var node = {
    id: genId('gate'),
    workflowId: '__approval_gate__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
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

function addScriptNode(description, code, inputs, outputs, chatHistory) {
  if (!compData) return;
  pushUndoSnapshot();

  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;

  var node = {
    id: genId('script'),
    workflowId: '__script__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
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
  selectedEdge = null;

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

  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;

  var node = {
    id: genId('output'),
    workflowId: '__output__',
    position: { x: Math.round(cx + 200), y: Math.round(cy) },
    label: 'Pipeline Output',
    outputNode: {
      ports: [],
    },
  };

  compData.nodes.push(node);

  // Select the new node to show properties panel
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;

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

  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;

  var node = {
    id: genId('imgview'),
    workflowId: '__image_viewer__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
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
  selectedEdge = null;

  renderNodes();
  renderEdges();
  wireUpCanvas();
  updateNodeSelection();
  updateDeleteButton();
  updatePropertiesPanel();
  immediateSave();
  fetchCompositions();
}

function addBranchNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;
  var node = {
    id: genId('branch'),
    workflowId: '__branch__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
    label: 'Branch',
    branchNode: { condition: '{{value}} > 0' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addDelayNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;
  var node = {
    id: genId('delay'),
    workflowId: '__delay__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
    label: 'Delay',
    delayNode: { delayMs: 1000 },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addGateNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;
  var node = {
    id: genId('cgate'),
    workflowId: '__gate__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
    label: 'Gate',
    gateNode: { defaultOpen: true, onClosed: 'skip' },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addForEachNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;
  var node = {
    id: genId('foreach'),
    workflowId: '__for_each__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
    label: 'ForEach Loop',
    forEachNode: { itemVariable: 'item', maxIterations: 100 },
  };
  compData.nodes.push(node);
  selectedNodes.clear();
  selectedNodes.add(node.id);
  selectedEdge = null;
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function addSwitchNode() {
  if (!compData) return;
  pushUndoSnapshot();
  var wrap = document.querySelector('#comp-canvas-wrap');
  var wrapRect = wrap.getBoundingClientRect();
  var cx = (wrapRect.width / 2 - canvasState.panX) / canvasState.zoom;
  var cy = (wrapRect.height / 2 - canvasState.panY) / canvasState.zoom;
  var offset = compData.nodes.length * 30;
  var node = {
    id: genId('switch'),
    workflowId: '__switch__',
    position: { x: Math.round(cx + offset), y: Math.round(cy + offset) },
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
  selectedEdge = null;
  renderNodes(); renderEdges(); wireUpCanvas();
  updateNodeSelection(); updateDeleteButton(); updatePropertiesPanel();
  immediateSave(); fetchCompositions();
}

function deleteSelected() {
  if (!compData) return;
  pushUndoSnapshot();

  if (selectedEdge) {
    compData.edges = compData.edges.filter(function(e) { return e.id !== selectedEdge; });
    selectedEdge = null;
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
    btn.style.display = (selectedNodes.size > 0 || selectedEdge) ? '' : 'none';
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
          selectedEdge = null;
          updateNodeSelection();
          updateEdgeSelection();
          updateDeleteButton();
          updatePropertiesPanel();
        } else {
          // Normal click: select only this node (if not already in multi-select)
          if (!selectedNodes.has(nodeId)) {
            selectedNodes.clear();
            selectedNodes.add(nodeId);
            selectedEdge = null;
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
        selectedEdge = null;
      } else {
        selectedNodes.clear();
        selectedNodes.add(bodyNodeId);
        selectedEdge = null;
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
        selectedEdge = null;
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
        selectedEdge = null;
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
          selectedEdge = null;
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
        selectedEdge = null;
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
  selectedEdge = null;
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
    el.classList.toggle('comp-edge-selected', el.dataset.edgeId === selectedEdge);
  });
}

// ── Rubber-band Selection ─────────────────────────────────────

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
  document.querySelectorAll('.comp-port').forEach(function(p) {
    var pNodeId = p.dataset.nodeId;
    var pPortName = p.dataset.portName;
    var pDir = p.dataset.portDir;
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
      else return;
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
  selectedEdge = null;

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
        selectedEdge = null;
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
  selectedEdge = null;

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
    return;
  }

  // ── Script Node Properties ──
  if (node.workflowId === '__script__') {
    renderScriptProperties(body, node, nodeId);
    return;
  }

  // ── Output Node Properties ──
  if (node.workflowId === '__output__') {
    renderOutputProperties(body, node, nodeId);
    return;
  }

  // ── Composition Node Properties ──
  if (node.workflowId.startsWith('comp:')) {
    renderCompositionNodeProperties(body, node, nodeId);
    return;
  }

  // ── Image Viewer Properties ──
  if (node.workflowId === '__image_viewer__') {
    renderImageViewerProperties(body, node, nodeId);
    return;
  }

  // ── Branch Node Properties ──
  if (node.workflowId === '__branch__') {
    renderBranchProperties(body, node, nodeId);
    return;
  }

  // ── Delay Node Properties ──
  if (node.workflowId === '__delay__') {
    renderDelayProperties(body, node, nodeId);
    return;
  }

  // ── Gate Node Properties ──
  if (node.workflowId === '__gate__') {
    renderGateNodeProperties(body, node, nodeId);
    return;
  }

  // ── ForEach Node Properties ──
  if (node.workflowId === '__for_each__') {
    renderForEachProperties(body, node, nodeId);
    return;
  }

  // ── Switch Node Properties ──
  if (node.workflowId === '__switch__') {
    renderSwitchProperties(body, node, nodeId);
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

  body.innerHTML = html;

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
  html += '<div class="comp-props-value" style="font-size:0.68rem;color:#64748b;">Iterates over an array input. Outputs the items, count, and last item.</div>';
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
  html += '<button class="comp-tb-btn" id="comp-props-refresh-interface" style="width:100%;font-size:0.72rem;">&#x1f504; Refresh Ports</button>';
  html += '</div>';

  body.innerHTML = html;

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

// ── Script Node Properties ──────────────────────────────────

function renderScriptProperties(body, node, nodeId) {
  var scriptCfg = node.script || { description: '', code: '', inputs: [], outputs: [], chatHistory: [] };
  var html = '';

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
  if (chatHistory.length === 0) {
    html += '<div style="color:#475569;font-size:0.72rem;padding:0.5rem;">No messages yet. Describe what you want below.</div>';
  }
  html += '</div>';
  html += '<div class="comp-script-chat-input-wrap">';
  html += '<input type="text" class="comp-props-input" id="comp-script-chat-input" placeholder="Refine: e.g. also output a word count...">';
  html += '<button class="comp-tb-btn comp-tb-btn-run" id="comp-script-chat-send" style="padding:0.3rem 0.6rem;font-size:0.72rem;">Send</button>';
  html += '</div>';
  html += '<div id="comp-script-chat-status" style="display:none;margin-top:4px;">';
  html += '<div class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:4px;vertical-align:middle;"></div>';
  html += '<span style="color:#94a3b8;font-size:0.7rem;">Generating...</span>';
  html += '</div>';
  html += '</div>';

  // Code Preview
  html += '<div class="comp-props-section">';
  html += '<div class="comp-props-label">Generated Code</div>';
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

  body.innerHTML = html;

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

  // Wire up chat send
  var chatInput = body.querySelector('#comp-script-chat-input');
  var chatSendBtn = body.querySelector('#comp-script-chat-send');
  var chatStatus = body.querySelector('#comp-script-chat-status');

  function sendScriptChat() {
    var message = chatInput.value.trim();
    if (!message) return;

    chatInput.disabled = true;
    chatSendBtn.disabled = true;
    chatStatus.style.display = '';

    // Build full chat history
    var history = (node.script.chatHistory || []).slice();
    history.push({ role: 'user', content: message });

    fetch('/api/compositions/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: message,
        chatHistory: history.slice(0, -1), // Send prior history, description is current message
        currentCode: node.script.code || undefined,
      }),
    })
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(result) {
        if (!result.ok) throw new Error(result.data.error || 'Generation failed');

        pushUndoSnapshot();

        // Update node's script config
        node.script.code = result.data.code;
        node.script.inputs = result.data.inputs;
        node.script.outputs = result.data.outputs;
        node.script.chatHistory = history.concat([
          { role: 'assistant', content: result.data.assistantMessage },
        ]);

        // Re-render everything — ports may have changed
        renderNodes();
        renderEdges();
        wireUpCanvas();
        updateNodeSelection();
        debouncedSave();

        // Re-render properties panel to show updated chat + code
        renderScriptProperties(body, node, nodeId);
      })
      .catch(function(err) {
        toast('Script generation failed: ' + err.message, 'error');
        chatInput.disabled = false;
        chatSendBtn.disabled = false;
        chatStatus.style.display = 'none';
      });
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

// ── Auto-Layout ──────────────────────────────────────────────

function autoLayoutNodes() {
  if (!compData || compData.nodes.length === 0) return;
  pushUndoSnapshot();

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

        // Hide progress bar and clear overlays after 5s
        setTimeout(function() {
          var wrap = document.querySelector('#comp-progress-wrap');
          if (wrap) wrap.style.display = 'none';
          clearNodeExecutionStates();
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
          clearNodeExecutionStates();
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
