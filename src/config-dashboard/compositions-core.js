/**
 * compositions-core.js
 *
 * Core state, utilities, API helpers, sidebar, and folder management
 * for the pipeline/compositions editor.
 *
 * MUST be loaded first — other compositions-*.js files depend on the
 * global variables and helper functions defined here.
 *
 * Contents:
 *   - State variables (compositions, selectedComposition, compData, canvasState, etc.)
 *   - Utility functions (compEscHtml, compEscAttr, genId, getSelectedNode, humanizeVarName,
 *     getPortTooltip, formatPortValue, lookupPortValue, truncateForContext, describeExpectation)
 *   - API helpers (fetchCompositions, fetchAvailableTools, getToolDef, fetchCompositionDetail,
 *     saveComposition, createComposition, deleteComposition, renameComposition,
 *     startPipelineRename, fetchWorkflowsForNodes)
 *   - Debounced save (debouncedSave, immediateSave)
 *   - Undo / redo (pushUndoSnapshot, undo, redo, updateUndoRedoButtons)
 *   - Validation (computeValidationWarnings)
 *   - Sidebar rendering (renderTreeItem, getUniqueFolders, renderCompSidebar)
 *   - Folder management (showFolderContextMenu, dismissCompContextMenu,
 *     showCompContextMenu, showNewFolderModal, showMoveToFolderModal, showCreateForm)
 *   - selectComposition
 */

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
var selectedEdges = new Set(); // Set of edge IDs (multi-edge selection for junction merge)
var selectedNodes = new Set(); // Set of node IDs (multi-select)
var saveTimer = null; // Debounced save
var compRunPollTimer = null; // Composition run polling
var lastNodeStates = null; // Cached node states from last run (for port value tooltips)

// Undo/Redo
var undoStack = [];
var redoStack = [];
var MAX_UNDO = 50;

// Folder collapse state
var collapsedFolders = {};

// Tools cache for Tool nodes
var toolsCache = [];

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

function truncateForContext(value, maxChars) {
  maxChars = maxChars || 2000;
  if (value === undefined || value === null) return null;

  // Primitives
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value;
    return value.substring(0, Math.floor(maxChars * 0.75)) + '\n... (truncated, total ' + value.length + ' chars)';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // Depth-limited serializer for objects/arrays
  function serialize(val, depth) {
    if (depth > 3) return typeof val === 'object' && val !== null ? (Array.isArray(val) ? '[...]' : '{...}') : JSON.stringify(val);
    if (val === null || val === undefined) return String(val);
    if (typeof val !== 'object') return JSON.stringify(val);

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      var items = [];
      var showCount = Math.min(val.length, 3);
      for (var i = 0; i < showCount; i++) {
        items.push(serialize(val[i], depth + 1));
      }
      var result = '[\n' + items.map(function(it) { return '  ' + it; }).join(',\n');
      if (val.length > 3) {
        result += ',\n  "... and ' + (val.length - 3) + ' more items"';
      }
      result += '\n]';
      return result;
    }

    // Object
    var keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    var parts = [];
    var showKeys = Math.min(keys.length, 10);
    for (var k = 0; k < showKeys; k++) {
      parts.push('  ' + JSON.stringify(keys[k]) + ': ' + serialize(val[keys[k]], depth + 1));
    }
    var out = '{\n' + parts.join(',\n');
    if (keys.length > 10) {
      out += ',\n  "... and ' + (keys.length - 10) + ' more keys"';
    }
    out += '\n}';
    return out;
  }

  var result = serialize(value, 0);
  if (result.length > maxChars) {
    return result.substring(0, Math.floor(maxChars * 0.75)) + '\n... (truncated, total ' + result.length + ' chars)';
  }
  return result;
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
    // Clean up empty folder placeholders that now have compositions
    if (window._emptyFolders) {
      window._emptyFolders = window._emptyFolders.filter(function(f) {
        return !compositions.some(function(c) { return c.folder === f; });
      });
    }
    renderCompSidebar();
  } catch (err) {
    document.querySelector('#comp-list').innerHTML =
      '<div style="padding:1rem;color:#ef4444;font-size:0.8rem;">Failed to load pipelines.</div>';
  }
}

function fetchAvailableTools(callback) {
  fetch('/api/tools')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      toolsCache = data.tools || [];
      if (callback) callback(toolsCache);
    })
    .catch(function() { toolsCache = []; });
}

function getToolDef(toolName) {
  for (var i = 0; i < toolsCache.length; i++) {
    if (toolsCache[i].name === toolName) return toolsCache[i];
  }
  return null;
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

function clearCompositionInterfaceCache() {
  if (typeof compositionInterfaceCache === 'undefined') return;
  compositionInterfaceCache = {};
}

async function createComposition(name, description, folder) {
  var body = { name: name, description: description };
  if (folder) body.folder = folder;
  var res = await fetch('/api/compositions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
      clearCompositionInterfaceCache();
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
  clearCompositionInterfaceCache();
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
  selectedEdge = null; selectedEdges.clear();
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
  selectedEdge = null; selectedEdges.clear();
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
    if (node.workflowId !== '__approval_gate__' && node.workflowId !== '__script__' && node.workflowId !== '__output__' && node.workflowId !== '__image_viewer__' && node.workflowId !== '__media__' && node.workflowId !== '__branch__' && node.workflowId !== '__delay__' && node.workflowId !== '__gate__' && node.workflowId !== '__for_each__' && node.workflowId !== '__switch__' && node.workflowId !== '__asset__' && node.workflowId !== '__text__' && node.workflowId !== '__file_op__' && node.workflowId !== '__json_keys__' && node.workflowId !== '__tool__' && node.workflowId !== '__file_write__' && node.workflowId !== '__file_read__' && node.workflowId !== '__junction__' && node.workflowId !== '__variable__' && node.workflowId !== '__get_variable__' && !node.workflowId.startsWith('comp:')) {
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

function renderTreeItem(c, indent) {
  var active = selectedComposition === c.id ? ' active' : '';
  var pad = indent || 0;
  return '<div class="tree-item' + active + '" data-comp-id="' + compEscAttr(c.id) + '" draggable="true" style="padding-left:' + (8 + pad * 16) + 'px;">' +
    '<svg class="tree-icon" width="16" height="16" viewBox="0 0 16 16"><path d="M4 3h8a1 1 0 011 1v1H3V4a1 1 0 011-1zm-1 3h10v6a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" fill="#94a3b8" opacity="0.5"/></svg>' +
    '<span class="tree-item-name">' + compEscHtml(c.name) + '</span>' +
  '</div>';
}

function getUniqueFolders() {
  var folders = [];
  for (var i = 0; i < compositions.length; i++) {
    var f = compositions[i].folder || '';
    if (f && folders.indexOf(f) === -1) folders.push(f);
  }
  // Include empty folders created via "New Folder" button
  if (window._emptyFolders) {
    for (var j = 0; j < window._emptyFolders.length; j++) {
      if (folders.indexOf(window._emptyFolders[j]) === -1) folders.push(window._emptyFolders[j]);
    }
  }
  folders.sort();
  return folders;
}

function renderCompSidebar() {
  var list = document.querySelector('#comp-list');
  if (!list) return;

  var html = '';
  // Toolbar row with New Folder, New Pipeline, Refresh buttons
  html += '<div class="comp-sidebar-toolbar">';
  html += '<span class="comp-sidebar-toolbar-title">PIPELINES</span>';
  html += '<div class="comp-sidebar-toolbar-actions">';
  // New Pipeline
  html += '<button class="comp-toolbar-btn" id="btn-new-comp" title="New Pipeline"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
  // New Folder
  html += '<button class="comp-toolbar-btn" id="btn-new-folder" title="New Folder"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 2h4l1 1.5H14a.5.5 0 01.5.5v9a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V2z" fill="none" stroke="currentColor" stroke-width="1" opacity="0.9"/><path d="M8 6.5v5M5.5 9h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>';
  // Refresh
  html += '<button class="comp-toolbar-btn" id="btn-refresh-comps" title="Refresh"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 01-9.78 3.4M2.5 8a5.5 5.5 0 019.78-3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  html += '</div></div>';
  html += '<div style="padding:0 0.5rem 0.5rem;">';
  html += '<input type="text" class="comp-sidebar-search" id="comp-sidebar-search" placeholder="Search pipelines...">';
  html += '</div>';

  if (compositions.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.8rem;">No pipelines yet. Create one to chain workflows together.</div>';
  } else {
    var folders = getUniqueFolders();
    var unfiled = compositions.filter(function(c) { return !c.folder; });

    // Render folders as tree nodes
    for (var fi = 0; fi < folders.length; fi++) {
      var folder = folders[fi];
      var folderComps = compositions.filter(function(c) { return c.folder === folder; });
      var isCollapsed = !!collapsedFolders[folder];
      html += '<div class="tree-folder" data-folder="' + compEscAttr(folder) + '">';
      html += '<div class="tree-folder-row" data-folder="' + compEscAttr(folder) + '">';
      html += '<svg class="tree-chevron' + (isCollapsed ? ' collapsed' : '') + '" width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      html += '<svg class="tree-icon" width="16" height="16" viewBox="0 0 16 16">';
      if (isCollapsed) {
        html += '<path d="M1.5 2h4l1 1.5H14a.5.5 0 01.5.5v9a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V2z" fill="#c4a35a" opacity="0.85"/>';
      } else {
        html += '<path d="M1.5 2h4l1 1.5H14a.5.5 0 01.5.5V5H1.5V2z" fill="#c4a35a" opacity="0.85"/><path d="M1.5 5h13v8a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V5z" fill="#c4a35a" opacity="0.6"/>';
      }
      html += '</svg>';
      html += '<span class="tree-folder-name">' + compEscHtml(folder) + '</span>';
      html += '</div>';
      html += '<div class="tree-folder-children"' + (isCollapsed ? ' style="display:none;"' : '') + '>';
      for (var ci = 0; ci < folderComps.length; ci++) {
        html += renderTreeItem(folderComps[ci], 1);
      }
      html += '</div></div>';
    }

    // Render unfiled compositions at root level
    for (var ui = 0; ui < unfiled.length; ui++) {
      html += renderTreeItem(unfiled[ui], 0);
    }

    // Root drop zone — drop here to remove from folder
    html += '<div class="tree-root-drop" id="tree-root-drop" style="min-height:24px;"></div>';
  }

  list.innerHTML = html;

  // Wire up toolbar clicks
  var newBtn = document.querySelector('#btn-new-comp');
  if (newBtn) {
    newBtn.addEventListener('click', function() {
      showCreateForm();
    });
  }
  var newFolderBtn = document.querySelector('#btn-new-folder');
  if (newFolderBtn) {
    newFolderBtn.addEventListener('click', function() {
      showNewFolderModal();
    });
  }
  var refreshBtn = document.querySelector('#btn-refresh-comps');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      fetchCompositions();
    });
  }

  list.querySelectorAll('.tree-item[data-comp-id]').forEach(function(el) {
    el.addEventListener('click', function() {
      selectComposition(el.dataset.compId);
    });
    el.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      showCompContextMenu(e.clientX, e.clientY, el.dataset.compId);
    });
  });

  // Wire up folder row clicks (expand/collapse)
  list.querySelectorAll('.tree-folder-row').forEach(function(row) {
    row.addEventListener('click', function() {
      var folder = row.dataset.folder;
      collapsedFolders[folder] = !collapsedFolders[folder];
      // Re-render to update folder icon (open vs closed)
      renderCompSidebar();
    });
    row.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      showFolderContextMenu(e.clientX, e.clientY, row.dataset.folder);
    });
  });

  // Wire up sidebar search
  var searchInput = document.querySelector('#comp-sidebar-search');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase().trim();
      list.querySelectorAll('.tree-item[data-comp-id]').forEach(function(el) {
        var name = (el.querySelector('.tree-item-name') || {}).textContent || '';
        el.style.display = (!q || name.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      });
      list.querySelectorAll('.tree-folder').forEach(function(grp) {
        var children = grp.querySelector('.tree-folder-children');
        var chevron = grp.querySelector('.tree-chevron');
        var folder = grp.dataset.folder;
        if (q) {
          children.style.display = '';
          if (chevron) chevron.classList.remove('collapsed');
          var anyVisible = false;
          children.querySelectorAll('.tree-item').forEach(function(item) {
            if (item.style.display !== 'none') anyVisible = true;
          });
          grp.style.display = anyVisible ? '' : 'none';
        } else {
          grp.style.display = '';
          if (collapsedFolders[folder]) {
            children.style.display = 'none';
            if (chevron) chevron.classList.add('collapsed');
          }
        }
      });
    });
  }

  // ── Drag & Drop ──────────────────────────────────────────
  // Drag start on tree items
  list.querySelectorAll('.tree-item[data-comp-id]').forEach(function(el) {
    el.addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', el.dataset.compId);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('tree-item-dragging');
      // Expand collapsed folders after a short delay while dragging
      window._dragCompId = el.dataset.compId;
    });
    el.addEventListener('dragend', function() {
      el.classList.remove('tree-item-dragging');
      window._dragCompId = null;
      // Clear all drag-over highlights
      list.querySelectorAll('.tree-drag-over').forEach(function(d) {
        d.classList.remove('tree-drag-over');
      });
    });
  });

  // Drop targets: folder rows
  list.querySelectorAll('.tree-folder-row').forEach(function(row) {
    row.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('tree-drag-over');
      // Auto-expand collapsed folder on hover
      var folder = row.dataset.folder;
      if (collapsedFolders[folder]) {
        if (!row._expandTimer) {
          row._expandTimer = setTimeout(function() {
            collapsedFolders[folder] = false;
            renderCompSidebar();
          }, 600);
        }
      }
    });
    row.addEventListener('dragleave', function(e) {
      // Only remove highlight if actually leaving the row (not entering a child)
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove('tree-drag-over');
        if (row._expandTimer) { clearTimeout(row._expandTimer); row._expandTimer = null; }
      }
    });
    row.addEventListener('drop', function(e) {
      e.preventDefault();
      row.classList.remove('tree-drag-over');
      if (row._expandTimer) { clearTimeout(row._expandTimer); row._expandTimer = null; }
      var compId = e.dataTransfer.getData('text/plain');
      var targetFolder = row.dataset.folder;
      if (!compId || !targetFolder) return;
      // Don't move if already in this folder
      var comp = compositions.find(function(c) { return c.id === compId; });
      if (comp && comp.folder === targetFolder) return;
      // Move via API
      fetch('/api/compositions/' + encodeURIComponent(compId) + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: targetFolder }),
      }).then(function() {
        return fetchCompositions();
      });
    });
  });

  // Drop on folder children area (also counts as dropping into that folder)
  list.querySelectorAll('.tree-folder').forEach(function(folderEl) {
    var childrenDiv = folderEl.querySelector('.tree-folder-children');
    if (!childrenDiv) return;
    childrenDiv.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folderEl.querySelector('.tree-folder-row').classList.add('tree-drag-over');
    });
    childrenDiv.addEventListener('dragleave', function(e) {
      if (!childrenDiv.contains(e.relatedTarget)) {
        folderEl.querySelector('.tree-folder-row').classList.remove('tree-drag-over');
      }
    });
    childrenDiv.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      folderEl.querySelector('.tree-folder-row').classList.remove('tree-drag-over');
      var compId = e.dataTransfer.getData('text/plain');
      var targetFolder = folderEl.dataset.folder;
      if (!compId || !targetFolder) return;
      var comp = compositions.find(function(c) { return c.id === compId; });
      if (comp && comp.folder === targetFolder) return;
      fetch('/api/compositions/' + encodeURIComponent(compId) + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: targetFolder }),
      }).then(function() {
        return fetchCompositions();
      });
    });
  });

  // Root drop zone — drop here to remove from any folder
  var rootDrop = list.querySelector('#tree-root-drop');
  if (rootDrop) {
    rootDrop.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      rootDrop.classList.add('tree-drag-over');
    });
    rootDrop.addEventListener('dragleave', function(e) {
      if (!rootDrop.contains(e.relatedTarget)) {
        rootDrop.classList.remove('tree-drag-over');
      }
    });
    rootDrop.addEventListener('drop', function(e) {
      e.preventDefault();
      rootDrop.classList.remove('tree-drag-over');
      var compId = e.dataTransfer.getData('text/plain');
      if (!compId) return;
      var comp = compositions.find(function(c) { return c.id === compId; });
      if (comp && !comp.folder) return; // already unfiled
      fetch('/api/compositions/' + encodeURIComponent(compId) + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: '' }),
      }).then(function() {
        return fetchCompositions();
      });
    });
  }
}

function showFolderContextMenu(x, y, folderName) {
  dismissCompContextMenu();
  var menu = document.createElement('div');
  menu.className = 'comp-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  menu.innerHTML =
    '<div class="comp-context-item" data-action="rename-folder">Rename Folder</div>' +
    '<div class="comp-context-item comp-context-danger" data-action="delete-folder">Delete Folder</div>';

  document.body.appendChild(menu);

  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  menu.addEventListener('click', function(e) {
    var action = e.target.dataset.action;
    dismissCompContextMenu();
    if (action === 'rename-folder') {
      var newName = prompt('Rename folder:', folderName);
      if (newName && newName.trim() && newName.trim() !== folderName) {
        // Move all compositions in this folder to the new name
        var folderComps = compositions.filter(function(c) { return c.folder === folderName; });
        var promises = folderComps.map(function(c) {
          return fetch('/api/compositions/' + encodeURIComponent(c.id) + '/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: newName.trim() }),
          });
        });
        Promise.all(promises).then(function() {
          // Transfer collapsed state
          collapsedFolders[newName.trim()] = collapsedFolders[folderName];
          delete collapsedFolders[folderName];
          return fetchCompositions();
        }).catch(function(err) {
          toast('Rename failed: ' + err.message, 'error');
        });
      }
    } else if (action === 'delete-folder') {
      var folderComps = compositions.filter(function(c) { return c.folder === folderName; });
      if (confirm('Remove folder "' + folderName + '"? The ' + folderComps.length + ' pipeline(s) inside will become unfiled.')) {
        var promises = folderComps.map(function(c) {
          return fetch('/api/compositions/' + encodeURIComponent(c.id) + '/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: '' }),
          });
        });
        Promise.all(promises).then(function() {
          delete collapsedFolders[folderName];
          return fetchCompositions();
        }).catch(function(err) {
          toast('Delete folder failed: ' + err.message, 'error');
        });
      }
    }
  });

  setTimeout(function() {
    document.addEventListener('click', dismissCompContextMenu, { once: true });
  }, 0);
}

// ── Context Menu & Folder Management ─────────────────────────

function dismissCompContextMenu() {
  var existing = document.querySelector('.comp-context-menu');
  if (existing) existing.remove();
}

function showCompContextMenu(x, y, compId) {
  dismissCompContextMenu();
  var menu = document.createElement('div');
  menu.className = 'comp-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  var comp = compositions.find(function(c) { return c.id === compId; });
  var compName = comp ? comp.name : compId;

  menu.innerHTML =
    '<div class="comp-context-item" data-action="move">Move to Folder...</div>' +
    '<div class="comp-context-item" data-action="rename">Rename</div>' +
    '<div class="comp-context-item" data-action="duplicate">Duplicate</div>' +
    '<div class="comp-context-item comp-context-danger" data-action="delete">Delete</div>';

  document.body.appendChild(menu);

  // Keep menu in viewport
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  menu.addEventListener('click', function(e) {
    var action = e.target.dataset.action;
    dismissCompContextMenu();
    if (action === 'move') {
      showMoveToFolderModal(compId);
    } else if (action === 'rename') {
      var newName = prompt('Rename pipeline:', compName);
      if (newName && newName.trim() && newName.trim() !== compName) {
        renameComposition(compId, newName.trim()).then(function() {
          return fetchCompositions();
        }).catch(function(err) {
          toast('Rename failed: ' + err.message, 'error');
        });
      }
    } else if (action === 'duplicate') {
      fetch('/api/compositions/' + encodeURIComponent(compId) + '/duplicate', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function() { return fetchCompositions(); })
        .catch(function(err) { toast('Duplicate failed: ' + err.message, 'error'); });
    } else if (action === 'delete') {
      if (confirm('Delete "' + compName + '"? This cannot be undone.')) {
        deleteComposition(compId).then(function() {
          if (selectedComposition === compId) {
            selectedComposition = null;
            compData = null;
            document.querySelector('#main').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;">Select a pipeline or create a new one</div>';
          }
          return fetchCompositions();
        }).catch(function(err) {
          toast('Delete failed: ' + err.message, 'error');
        });
      }
    }
  });

  // Dismiss on click outside
  setTimeout(function() {
    document.addEventListener('click', dismissCompContextMenu, { once: true });
  }, 0);
}

function showNewFolderModal() {
  var overlay = document.createElement('div');
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal" style="width:340px;">' +
      '<h3 style="margin:0 0 16px;font-size:16px;color:#e2e8f0;">New Folder</h3>' +
      '<div style="margin-bottom:16px;">' +
        '<label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;">Folder Name</label>' +
        '<input type="text" id="new-folder-name-input" placeholder="e.g. Content Pipelines" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:13px;outline:none;box-sizing:border-box;">' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button id="new-folder-cancel" style="padding:8px 16px;border-radius:6px;background:transparent;border:1px solid #334155;color:#94a3b8;cursor:pointer;font-size:13px;">Cancel</button>' +
        '<button id="new-folder-create" style="padding:8px 16px;border-radius:6px;background:#7c3aed;border:none;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">Create</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  var input = overlay.querySelector('#new-folder-name-input');
  input.focus();

  function doCreate() {
    var name = input.value.trim();
    if (!name) { input.style.borderColor = '#ef4444'; return; }
    // Check for duplicate
    var existing = getUniqueFolders();
    if (existing.indexOf(name) !== -1) {
      input.style.borderColor = '#ef4444';
      input.value = '';
      input.placeholder = 'Folder already exists';
      return;
    }
    if (!window._emptyFolders) window._emptyFolders = [];
    window._emptyFolders.push(name);
    collapsedFolders[name] = false;
    document.body.removeChild(overlay);
    renderCompSidebar();
  }

  overlay.querySelector('#new-folder-create').addEventListener('click', doCreate);
  overlay.querySelector('#new-folder-cancel').addEventListener('click', function() {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') document.body.removeChild(overlay);
  });
  input.addEventListener('input', function() {
    input.style.borderColor = '#334155';
  });
}

function showMoveToFolderModal(compId) {
  var comp = compositions.find(function(c) { return c.id === compId; });
  if (!comp) return;

  var folders = getUniqueFolders();
  var overlay = document.createElement('div');
  overlay.className = 'comp-modal-overlay';
  overlay.innerHTML =
    '<div class="comp-modal" style="width:320px;">' +
      '<h3 style="margin:0 0 16px;font-size:16px;color:#e2e8f0;">Move to Folder</h3>' +
      '<div style="font-size:12px;color:#94a3b8;margin-bottom:12px;">Moving: <strong style="color:#e2e8f0;">' + compEscHtml(comp.name) + '</strong></div>' +
      '<div id="folder-options" style="max-height:200px;overflow:auto;margin-bottom:12px;">' +
        '<div class="folder-option' + (!comp.folder ? ' selected' : '') + '" data-folder="" style="padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;color:#94a3b8;">No Folder (Unfiled)</div>' +
        folders.map(function(f) {
          return '<div class="folder-option' + (comp.folder === f ? ' selected' : '') + '" data-folder="' + compEscAttr(f) + '" style="padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;color:#e2e8f0;">' + compEscHtml(f) + '</div>';
        }).join('') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
        '<input type="text" id="new-folder-input" placeholder="New folder name..." style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:13px;outline:none;">' +
        '<button id="new-folder-btn" style="padding:6px 12px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:12px;white-space:nowrap;">+ Create</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button id="folder-cancel-btn" style="padding:8px 16px;border-radius:6px;background:transparent;border:1px solid #334155;color:#94a3b8;cursor:pointer;font-size:13px;">Cancel</button>' +
        '<button id="folder-move-btn" style="padding:8px 16px;border-radius:6px;background:#7c3aed;border:none;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">Move</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  var chosenFolder = comp.folder || '';

  // Wire folder option clicks
  overlay.querySelectorAll('.folder-option').forEach(function(opt) {
    opt.addEventListener('click', function() {
      overlay.querySelectorAll('.folder-option').forEach(function(o) { o.classList.remove('selected'); });
      opt.classList.add('selected');
      chosenFolder = opt.dataset.folder;
    });
  });

  // Create new folder
  var newFolderBtn = overlay.querySelector('#new-folder-btn');
  var newFolderInput = overlay.querySelector('#new-folder-input');
  newFolderBtn.addEventListener('click', function() {
    var name = newFolderInput.value.trim();
    if (!name) return;
    // Add as new option and select it
    var optionsDiv = overlay.querySelector('#folder-options');
    var newOpt = document.createElement('div');
    newOpt.className = 'folder-option selected';
    newOpt.dataset.folder = name;
    newOpt.style.cssText = 'padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;color:#e2e8f0;';
    newOpt.textContent = name;
    overlay.querySelectorAll('.folder-option').forEach(function(o) { o.classList.remove('selected'); });
    optionsDiv.appendChild(newOpt);
    chosenFolder = name;
    newFolderInput.value = '';
    newOpt.addEventListener('click', function() {
      overlay.querySelectorAll('.folder-option').forEach(function(o) { o.classList.remove('selected'); });
      newOpt.classList.add('selected');
      chosenFolder = name;
    });
  });

  // Enter key creates folder
  newFolderInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') newFolderBtn.click();
  });

  // Cancel
  overlay.querySelector('#folder-cancel-btn').addEventListener('click', function() {
    overlay.remove();
  });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  // Move
  overlay.querySelector('#folder-move-btn').addEventListener('click', function() {
    fetch('/api/compositions/' + encodeURIComponent(compId) + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: chosenFolder }),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);
        overlay.remove();
        toast('Moved to ' + (chosenFolder || 'Unfiled'), 'success');
        return fetchCompositions();
      })
      .catch(function(err) {
        toast('Move failed: ' + err.message, 'error');
      });
  });
}

function showCreateForm() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div class="comp-create-form">' +
      '<h2>New Pipeline</h2>' +
      '<label>Name</label>' +
      '<input type="text" id="comp-name-input" placeholder="e.g. Song Pipeline" style="width:100%;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;margin-bottom:0.75rem;">' +
      '<label>Description (optional)</label>' +
      '<input type="text" id="comp-desc-input" placeholder="What does this pipeline do?" style="width:100%;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;margin-bottom:0.75rem;">' +
      '<label>Folder (optional)</label>' +
      '<div style="display:flex;gap:8px;margin-bottom:1rem;">' +
        '<select id="comp-folder-input" style="flex:1;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;font-size:13px;">' +
          '<option value="">No Folder</option>' +
          getUniqueFolders().map(function(f) { return '<option value="' + compEscAttr(f) + '">' + compEscHtml(f) + '</option>'; }).join('') +
        '</select>' +
        '<input type="text" id="comp-folder-new" placeholder="or type new..." style="flex:1;padding:0.5rem;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;font-size:13px;">' +
      '</div>' +
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
    var folderSelect = document.querySelector('#comp-folder-input');
    var folderNewInput = document.querySelector('#comp-folder-new');
    var name = nameInput.value.trim();
    if (!name) { toast('Give your pipeline a name', 'error'); return; }
    var folder = (folderNewInput.value.trim()) || (folderSelect ? folderSelect.value : '');
    try {
      var result = await createComposition(name, descInput.value.trim(), folder);
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

async function selectComposition(id, viewOverride) {
  selectedComposition = id;
  clearCompositionInterfaceCache();
  var compView = viewOverride || (typeof parseHash === 'function' ? parseHash().view : null);
  document.body.classList.toggle('composition-form-mode', compView === 'form');

  // Update URL hash for deep linking
  if (typeof updateHash === 'function') {
    updateHash('compositions', id, compView);
  }

  // Update sidebar active state
  document.querySelectorAll('#comp-list .tree-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.compId === id);
  });

  var main = document.querySelector('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  try {
    // Fetch composition, workflow, and tools data in parallel
    var [compResult] = await Promise.all([
      fetchCompositionDetail(id),
      fetchWorkflowsForNodes(),
      new Promise(function(resolve) { fetchAvailableTools(resolve); }),
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

    selectedEdge = null; selectedEdges.clear();
    selectedNodes.clear();
    undoStack = [];
    redoStack = [];

    if (compView === 'form' && typeof renderCompositionFormPage === 'function') {
      renderCompositionFormPage();
    } else {
      renderGraphEditor();
    }
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x26a0;&#xfe0f;</div>' +
      '<h2>Error</h2><p>' + compEscHtml(err.message) + '</p></div>';
  }
}
