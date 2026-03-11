/**
 * Workflows Dashboard — Core Module
 *
 * Contains:
 *  - Global state variables (workflows, selectedWorkflow, detailView, etc.)
 *  - Per-workflow variable value persistence (runVarValues)
 *  - Step icon map (STEP_ICONS)
 *  - Variable auto-detection (extractStepVariables, collectAllReferencedVariables,
 *    removeOrphanedVariables, ensureStepVariablesDeclared)
 *  - API helpers (fetchWorkflows, fetchWorkflowDetail, saveWorkflow, deleteWorkflow,
 *    renameWorkflow, startInlineRename)
 *  - Initialization (initWorkflows)
 *  - Sidebar rendering (renderWorkflowSidebar)
 *  - Event delegation setup (initWorkflowDelegation)
 *  - New workflow form (showNewWorkflowForm, wireNewWorkflowHandlers,
 *    renderNewVarsList, renderNewStepsList, renderStepFields,
 *    wireStepFieldHandlers, buildDefaultStep)
 *  - Step path resolution (resolveStepPath, getParentFromPath)
 *  - Create workflow (createNewWorkflow)
 *  - Step label builder (buildStepLabel)
 *  - Collapse keyboard steps (collapseKeyboardSteps)
 *  - Detail view routing (selectWorkflow, renderWorkflowDetail)
 *  - Utility functions (infoChip, truncate, formatDuration, escHtml/escAttr fallbacks)
 *
 * Loaded FIRST via <script> — all symbols are globals shared with
 * workflows-editor.js and workflows-recording.js.
 */

// ── State ────────────────────────────────────────────────────
let workflows = [];
let selectedWorkflow = null;
let detailView = 'visual'; // 'visual' | 'json' | 'run'
let pipelineWorkflows = []; // for chaining
let workflowTrainingPolls = {}; // workflowId -> intervalId

// Per-workflow variable values typed by the user (survives tab switches)
// { workflowId: { varName: value, ... } }
var runVarValues = {};

// Batch step selection state
var selectedStepPaths = new Set();
var lastCheckedStepPath = null; // for shift-click range select

function saveRunVarValues(wfId) {
  if (!wfId) return;
  var vals = {};
  document.querySelectorAll('.wf-run-input').forEach(function(el) {
    var name = el.getAttribute('name');
    if (name) vals[name] = el.value;
  });
  if (Object.keys(vals).length > 0) {
    runVarValues[wfId] = vals;
  }
}

function getRunVarValue(wfId, varName, fallback) {
  if (runVarValues[wfId] && runVarValues[wfId][varName] !== undefined) {
    return runVarValues[wfId][varName];
  }
  return fallback;
}

// ── Step icons ───────────────────────────────────────────────
const STEP_ICONS = {
  navigate: '&#x1f310;',
  click: '&#x1f5b1;',
  type: '&#x2328;',
  wait: '&#x23f3;',
  keyboard: '&#x2328;',
  assert: '&#x2705;',
  download: '&#x1f4e5;',
  move_file: '&#x1f4c2;',
  scroll: '&#x2195;',
  sub_workflow: '&#x1f504;',
  conditional: '&#x2696;',
  loop: '&#x1f501;',
  try_catch: '&#x1f6e1;',
  set_variable: '&#x1f4dd;',
  file_dialog: '&#x1f4c1;',
  capture_download: '&#x1f4e5;',
  inject_style: '&#x1f3a8;',
  keyboard_nav: '&#x1f9ed;',
  click_selector: '&#x1f3af;',
};

// ── Variable auto-detection ─────────────────────────────────

/**
 * Scan all string fields in a step for {{varName}} references.
 * Returns an array of variable names found.
 */
function extractStepVariables(step) {
  var names = [];
  var pattern = /\{\{([^}]+)\}\}/g;
  var json = JSON.stringify(step);
  var match;
  while ((match = pattern.exec(json)) !== null) {
    var name = match[1].trim().split('.')[0].split('[')[0]; // base name only
    if (names.indexOf(name) === -1) names.push(name);
  }
  return names;
}

/**
 * Collect ALL variable names referenced across every step (recursively).
 * Checks both {{varName}} template patterns and outputVariable fields.
 */
function collectAllReferencedVariables(steps) {
  var names = [];
  var pattern = /\{\{([^}]+)\}\}/g;

  function walkSteps(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var step = arr[i];
      // Extract {{var}} references from entire step JSON
      var json = JSON.stringify(step);
      var match;
      while ((match = pattern.exec(json)) !== null) {
        var name = match[1].trim().split('.')[0].split('[')[0];
        if (names.indexOf(name) === -1) names.push(name);
      }
      // Also check outputVariable (capture_download, file_dialog, etc.)
      if (step.outputVariable && names.indexOf(step.outputVariable) === -1) {
        names.push(step.outputVariable);
      }
      // Recurse into nested sub-steps
      if (step.thenSteps) walkSteps(step.thenSteps);
      if (step.elseSteps) walkSteps(step.elseSteps);
      if (step.steps) walkSteps(step.steps);
      if (step.trySteps) walkSteps(step.trySteps);
      if (step.catchSteps) walkSteps(step.catchSteps);
    }
  }

  walkSteps(steps);
  return names;
}

/**
 * Remove variables from wf.variables that are no longer referenced
 * by any step. Returns the number of variables removed.
 */
function removeOrphanedVariables(wf) {
  if (!wf.variables || wf.variables.length === 0) return 0;
  var referenced = collectAllReferencedVariables(wf.steps || []);
  var before = wf.variables.length;
  wf.variables = wf.variables.filter(function(v) {
    return referenced.indexOf(v.name) !== -1;
  });
  return before - wf.variables.length;
}

/**
 * Ensure all {{variables}} used in steps exist in wf.variables.
 * Auto-adds missing ones as required string variables.
 * Returns the number of variables added.
 */
function ensureStepVariablesDeclared(wf, step) {
  if (!wf.variables) wf.variables = [];
  var existing = wf.variables.map(function(v) { return v.name; });
  var referenced = extractStepVariables(step);
  var added = 0;
  for (var i = 0; i < referenced.length; i++) {
    if (existing.indexOf(referenced[i]) === -1) {
      wf.variables.push({
        name: referenced[i],
        description: '',
        type: 'string',
        required: true,
      });
      existing.push(referenced[i]);
      added++;
    }
  }
  return added;
}

// ── API ──────────────────────────────────────────────────────

async function fetchWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    const data = await res.json();
    workflows = data.workflows || [];
    renderWorkflowSidebar();
  } catch (err) {
    document.querySelector('#wf-list').innerHTML =
      '<div style="padding:1rem;color:#ef4444;font-size:0.8rem;">Failed to load workflows.</div>';
  }
}

async function fetchWorkflowDetail(id) {
  const res = await fetch('/api/workflows/' + encodeURIComponent(id));
  if (!res.ok) throw new Error('Workflow not found');
  return res.json();
}

async function saveWorkflow(id, workflow) {
  const res = await fetch('/api/workflows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed');
  return data;
}

async function deleteWorkflow(id) {
  const res = await fetch('/api/workflows/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Delete failed');
  return data;
}

async function renameWorkflow(id, newName) {
  const res = await fetch('/api/workflows/' + encodeURIComponent(id) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Rename failed');
  return data;
}

function startInlineRename(wf) {
  var titleEl = document.getElementById('wf-title');
  if (!titleEl || titleEl.querySelector('input')) return;

  var currentName = wf.name;
  titleEl.innerHTML = '<input type="text" id="wf-rename-input" value="' + escAttr(currentName) + '" ' +
    'style="font-size:inherit;font-weight:inherit;background:#1e293b;color:#e2e8f0;border:1px solid #7c3aed;' +
    'border-radius:4px;padding:2px 6px;width:100%;outline:none;" autofocus>';

  var input = document.getElementById('wf-rename-input');
  input.focus();
  input.select();

  async function commitRename() {
    var newName = input.value.trim();
    if (!newName || newName === currentName) {
      // Revert
      titleEl.textContent = currentName;
      return;
    }
    try {
      await renameWorkflow(wf.id, newName);
      wf.name = newName;
      toast('Renamed to "' + newName + '"', 'success');
      // Refresh sidebar and detail
      await fetchWorkflows();
      renderWorkflowSidebar();
      if (_wfCurrentDetail) {
        _wfCurrentDetail.wf.name = newName;
        renderWorkflowDetail(_wfCurrentDetail.wf, _wfCurrentDetail.filePath, _wfCurrentDetail.source);
      }
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

// ── Init (called from app.js when switching to workflows tab) ─

function initWorkflows() {
  const main = document.querySelector('#main');
  main.innerHTML =
    '<div class="empty-state">' +
    '<div class="empty-state-icon">&#x1f3ac;</div>' +
    '<h2>Workflow Manager ' + helpIcon('workflows-what') + '</h2>' +
    '<p>Select a workflow from the sidebar, or create a new one.</p>' +
    '</div>';

  stopAllWorkflowTrainingPolls();
  selectedWorkflow = null;
  initWorkflowDelegation();
  fetchWorkflows();
}

// ── Sidebar ──────────────────────────────────────────────────

function renderWorkflowSidebar() {
  const list = document.querySelector('#wf-list');
  var html = '';

  // New Workflow button (always visible)
  html += '<div class="wf-sidebar-new" id="wf-btn-new">' +
    '<span style="font-size:1rem;">+</span> New Workflow' +
    '</div>';

  if (workflows.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.8rem;">' +
      'No workflows yet.<br><br>' +
      '<span style="color:#94a3b8;">Click <strong>+ New Workflow</strong> above to get started.</span>' +
      '</div>';
  } else {
    html += workflows.map(function(wf) {
      var active = selectedWorkflow === wf.id ? ' active' : '';
      var smartCount = wf.smartWaitCount || 0;
      var trainingBadge = '';
      var ts = wf.metadata && wf.metadata.trainingStatus;
      if (ts === 'complete') {
        trainingBadge = '<span class="badge" style="background:#065f46;color:#6ee7b7;">model ready</span>';
      } else if (ts === 'training' || ts === 'pending') {
        trainingBadge = '<span class="badge" style="background:#4c1d95;color:#c4b5fd;"><span class="wf-training-pulse">&#x25cf;</span> training</span>';
      } else if (ts === 'failed') {
        trainingBadge = '<span class="badge" style="background:#7f1d1d;color:#fca5a5;">training failed</span>';
      }
      var isDesktop = wf.site === 'desktop';
      var typeBadge = isDesktop
        ? '<span class="badge" style="background:#1e3a5f;color:#7dd3fc;">desktop</span>'
        : '';
      var a11yBadge = (wf.metadata && wf.metadata.recordingMode === 'accessibility')
        ? '<span class="badge" style="background:#1e3a5f;color:#93c5fd;">a11y</span>'
        : '';
      return '<div class="ext-item' + active + '" data-wf-id="' + escAttr(wf.id) + '">' +
        '<div class="ext-item-name">' + escHtml(wf.name) + '</div>' +
        '<div class="ext-item-meta">' + escHtml(isDesktop ? 'Desktop App' : (wf.site || '')) + ' &middot; ' + wf.stepCount + ' steps</div>' +
        '<div class="ext-item-badges">' +
          '<span class="badge badge-ok">' + escHtml(wf.source) + '</span>' +
          typeBadge +
          a11yBadge +
          (wf.format === 'code' ? '<span class="badge" style="background:#4c1d95;color:#c4b5fd;">JS</span>' : '') +
          (wf.variableCount > 0 ? '<span class="badge badge-partial">' + wf.variableCount + ' vars</span>' : '') +
          (smartCount > 0 ? '<span class="badge badge-webui">' + smartCount + ' smart</span>' : '') +
          trainingBadge +
        '</div>' +
      '</div>';
    }).join('');
  }

  list.innerHTML = html;

  // Event delegation is set up once in initWorkflowDelegation()
  // No per-render addEventListener calls needed for sidebar items
}

// ── Event Delegation (set up once) ──────────────────────────
// Delegated handlers on stable parent elements avoid timing issues
// where clicks fire before per-element addEventListener runs.
var _wfDelegationInit = false;
var _wfCurrentDetail = null; // { wf, filePath, source } for delegated handlers

function initWorkflowDelegation() {
  if (_wfDelegationInit) return;
  _wfDelegationInit = true;

  // Sidebar: delegated click handler
  var list = document.querySelector('#wf-list');
  if (list) {
    list.addEventListener('click', function(e) {
      // Workflow item click
      var item = e.target.closest('.ext-item[data-wf-id]');
      if (item) {
        selectWorkflow(item.dataset.wfId);
        return;
      }
      // New workflow button
      var newBtn = e.target.closest('#wf-btn-new');
      if (newBtn) {
        selectedWorkflow = null;
        list.querySelectorAll('.ext-item').forEach(function(el) { el.classList.remove('active'); });
        showNewWorkflowForm();
        return;
      }
    });
  }

  // Main content: delegated click handler for detail view
  var main = document.querySelector('#main');
  if (main) {
    main.addEventListener('click', function(e) {
      // Tab bar clicks
      var tab = e.target.closest('.wf-tab[data-view]');
      if (tab && _wfCurrentDetail) {
        detailView = tab.dataset.view;
        if (typeof updateHash === 'function') {
          updateHash('workflows', selectedWorkflow, detailView);
        }
        renderWorkflowDetail(_wfCurrentDetail.wf, _wfCurrentDetail.filePath, _wfCurrentDetail.source);
        return;
      }
    });
  }
}

// ── New Workflow Form ──────────────────────────────────────────

function showNewWorkflowForm() {
  var main = document.querySelector('#main');
  var html = '';

  html += '<div class="wf-detail-header">';
  html += '<div><h2>Create New Workflow</h2>';
  html += '<div class="wf-detail-meta">Record browser actions or build steps manually.</div>';
  html += '</div>';
  html += '</div>';

  // Basic info section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Workflow Info</div>';
  html += '<div class="wf-section-body">';

  html += '<div class="wf-create-field">';
  html += '<label class="wf-create-label" for="wf-new-name">Name <span style="color:#ef4444;">*</span></label>';
  html += '<input class="wf-var-input" type="text" id="wf-new-name" placeholder="e.g. Create Song, Post to Instagram" autofocus>';
  html += '<div class="wf-create-hint">A human-readable name for this workflow</div>';
  html += '</div>';

  html += '<div class="wf-create-field">';
  html += '<label class="wf-create-label" for="wf-new-desc">Description</label>';
  html += '<input class="wf-var-input" type="text" id="wf-new-desc" placeholder="What does this workflow do?">';
  html += '</div>';

  html += '<div class="wf-create-field">';
  html += '<label class="wf-create-label" for="wf-new-site">Target Site <span style="color:#ef4444;">*</span></label>';
  html += '<input class="wf-var-input" type="text" id="wf-new-site" placeholder="e.g. suno.com, instagram.com">';
  html += '<div class="wf-create-hint">The website this workflow automates</div>';
  html += '</div>';

  html += '</div>';
  html += '</div>';

  // Record section — prominent, before manual steps
  html += '<div class="wf-section wf-record-section">';
  html += '<div class="wf-section-header" id="wf-record-section-header">&#x23fa; Record Workflow' + helpIcon('workflows-recording') + '</div>';
  html += '<div class="wf-section-body">';

  // Recording mode selector
  html += '<div style="display:flex;gap:8px;margin-bottom:0.75rem;align-items:center;">';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;border:1px solid #334155;cursor:pointer;font-size:0.78rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-record-mode" value="browser" checked style="accent-color:#7c3aed;margin:0;"> Browser';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;border:1px solid #334155;cursor:pointer;font-size:0.78rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-record-mode" value="desktop" style="accent-color:#7c3aed;margin:0;"> Desktop (any app)';
  html += '</label>';
  html += helpIcon('workflows-browser-vs-desktop');
  html += '</div>';

  // Desktop app name input (hidden by default, shown when Desktop mode is selected)
  html += '<div id="wf-desktop-app-field" style="display:none;margin-bottom:0.75rem;">';
  html += '<label class="wf-create-label" for="wf-desktop-app-name" style="font-size:0.78rem;color:#94a3b8;margin-bottom:4px;display:block;">Application Name</label>';
  html += '<input class="wf-var-input" type="text" id="wf-desktop-app-name" placeholder="e.g. Finder, Spotify, Notepad" style="font-size:0.82rem;">';
  html += '<div class="wf-create-hint" style="margin-top:4px;">The app will be launched and brought to focus when recording starts</div>';
  html += '</div>';

  // Element identification mode selector (Standard / Accessibility)
  html += '<div id="wf-element-mode-group" style="margin-bottom:0.75rem;">';
  html += '<div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">Element Identification</div>';
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;border:1px solid #334155;cursor:pointer;font-size:0.78rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-element-mode" value="standard" checked style="accent-color:#7c3aed;margin:0;"> Standard';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;border:1px solid #334155;cursor:pointer;font-size:0.78rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-element-mode" value="accessibility" style="accent-color:#7c3aed;margin:0;"> Accessibility';
  html += '</label>';
  html += '</div>';
  html += '<div class="wf-create-hint" style="margin-top:4px;font-size:0.7rem;">Standard uses CSS selectors. Accessibility uses ARIA roles, labels, and SVG fingerprints for layout-independent element matching.</div>';
  html += '</div>';

  html += '<div class="wf-create-hint" id="wf-record-hint" style="margin-bottom:0.75rem;">Click <strong>Start Recording</strong>, then perform the actions in Chrome. Each click, keystroke, and navigation will be captured as a workflow step. Click <strong>Stop</strong> when done.</div>';

  // Record options (browser mode only)
  html += '<div id="wf-record-browser-options">';
  html += '<label style="display:flex;align-items:center;gap:6px;margin-bottom:0.75rem;font-size:0.78rem;color:#94a3b8;cursor:pointer;user-select:none;">';
  html += '<input type="checkbox" id="wf-capture-crops" checked style="accent-color:#7c3aed;margin:0;">';
  html += 'Capture element screenshots for visual matching';
  html += '</label>';
  html += '</div>';

  // Record controls
  html += '<div class="wf-record-controls" id="wf-record-controls">';
  html += '<button class="btn-save wf-record-start-btn" id="wf-btn-record-start">&#x23fa; Start Recording</button>';
  html += '</div>';

  // Live step feed (hidden until recording starts)
  html += '<div id="wf-record-feed" style="display:none;">';
  html += '<div class="wf-record-status" id="wf-record-status"></div>';
  html += '<div class="wf-record-steps" id="wf-record-steps"></div>';
  html += '</div>';

  html += '</div>';
  html += '</div>';

  // Manual steps section (collapsed by default)
  html += '<details class="wf-section wf-manual-section">';
  html += '<summary class="wf-section-header" style="cursor:pointer;user-select:none;">&#x270f; Manual Steps <span style="font-weight:400;color:#475569;font-size:0.7rem;">(advanced)</span></summary>';
  html += '<div class="wf-section-body">';

  // Variables
  html += '<div style="margin-bottom:1.25rem;">';
  html += '<div class="wf-create-label" style="margin-bottom:0.5rem;">Variables</div>';
  html += '<div class="wf-create-hint" style="margin-bottom:0.5rem;">Reference in steps as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;">{{variableName}}</code></div>';
  html += '<div id="wf-new-vars-list"></div>';
  html += '<button class="btn-secondary" id="wf-new-add-var" style="font-size:0.75rem;padding:0.35rem 0.75rem;margin-top:0.5rem;">+ Add Variable</button>';
  html += '</div>';

  // Steps
  html += '<div class="wf-create-label" style="margin-bottom:0.5rem;">Steps</div>';
  html += '<div id="wf-new-steps-list"></div>';
  html += '<button class="btn-secondary" id="wf-new-add-step" style="font-size:0.75rem;padding:0.35rem 0.75rem;margin-top:0.5rem;">+ Add Step</button>';

  html += '</div>';
  html += '</details>';

  // Create button (for manual mode — recording auto-saves)
  html += '<div class="save-row" style="gap:1rem;" id="wf-manual-save-row">';
  html += '<button class="btn-save" id="wf-btn-create" style="background:#10b981;">Create Workflow</button>';
  html += '<span class="save-status" id="wf-create-status"></span>';
  html += '</div>';

  main.innerHTML = html;
  wireNewWorkflowHandlers();
  wireRecordingHandlers();
}

// ── New Workflow: Variable rows ──────────────────────────────

var newWorkflowVars = [];
var newWorkflowSteps = [];

function wireNewWorkflowHandlers() {
  newWorkflowVars = [];
  newWorkflowSteps = [];

  // Add variable button
  var addVarBtn = document.querySelector('#wf-new-add-var');
  if (addVarBtn) {
    addVarBtn.addEventListener('click', function() {
      newWorkflowVars.push({ name: '', description: '', type: 'string', required: false, default: '' });
      renderNewVarsList();
    });
  }

  // Add step button
  var addStepBtn = document.querySelector('#wf-new-add-step');
  if (addStepBtn) {
    addStepBtn.addEventListener('click', function() {
      newWorkflowSteps.push({ type: 'navigate', url: '', label: '' });
      renderNewStepsList();
    });
  }

  // Create button
  var createBtn = document.querySelector('#wf-btn-create');
  if (createBtn) {
    createBtn.addEventListener('click', createNewWorkflow);
  }
}

function renderNewVarsList() {
  var container = document.querySelector('#wf-new-vars-list');
  if (!container) return;

  if (newWorkflowVars.length === 0) {
    container.innerHTML = '<div style="font-size:0.75rem;color:#475569;">No variables added yet.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < newWorkflowVars.length; i++) {
    var v = newWorkflowVars[i];
    html += '<div class="wf-create-var-row" data-idx="' + i + '">';

    html += '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">';
    html += '<input class="wf-var-input wf-nv-name" type="text" placeholder="Variable name" value="' + escAttr(v.name) + '" style="flex:1;min-width:120px;">';
    html += '<input class="wf-var-input wf-nv-desc" type="text" placeholder="Description" value="' + escAttr(v.description) + '" style="flex:2;min-width:150px;">';

    html += '<select class="wf-var-input wf-nv-type" style="width:auto;min-width:80px;">';
    var types = ['string', 'number', 'boolean', 'string[]'];
    for (var t = 0; t < types.length; t++) {
      html += '<option value="' + types[t] + '"' + (v.type === types[t] ? ' selected' : '') + '>' + types[t] + '</option>';
    }
    html += '</select>';

    html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;white-space:nowrap;">';
    html += '<input type="checkbox" class="wf-nv-required"' + (v.required ? ' checked' : '') + '> Required';
    html += '</label>';

    html += '<input class="wf-var-input wf-nv-default" type="text" placeholder="Default value" value="' + escAttr(v.default || '') + '" style="flex:1;min-width:100px;">';

    html += '<button class="wf-nv-remove" data-idx="' + i + '" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:1rem;padding:0 0.25rem;" title="Remove">&#x2715;</button>';
    html += '</div>';

    // AI generation prompt toggle + textarea
    html += '<div style="display:flex;gap:0.5rem;align-items:flex-start;flex-wrap:wrap;margin-top:0.35rem;">';
    html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#a78bfa;cursor:pointer;white-space:nowrap;">';
    html += '<input type="checkbox" class="wf-nv-gen-enabled"' + (v.generationPrompt ? ' checked' : '') + ' style="accent-color:#7c3aed;"> \u{1F916} AI Prompt';
    html += '</label>';
    if (v.generationPrompt !== undefined && v.generationPrompt !== null) {
      html += '<textarea class="wf-var-input wf-nv-gen-prompt" placeholder="Describe what to generate..." style="flex:1;min-width:200px;min-height:50px;resize:vertical;">' + escHtml(v.generationPrompt || '') + '</textarea>';
    }
    html += '</div>';

    html += '</div>';
  }
  container.innerHTML = html;

  // Wire change handlers
  container.querySelectorAll('.wf-create-var-row').forEach(function(row) {
    var idx = parseInt(row.dataset.idx);
    var nameInput = row.querySelector('.wf-nv-name');
    var descInput = row.querySelector('.wf-nv-desc');
    var typeSelect = row.querySelector('.wf-nv-type');
    var reqInput = row.querySelector('.wf-nv-required');
    var defInput = row.querySelector('.wf-nv-default');
    var removeBtn = row.querySelector('.wf-nv-remove');

    if (nameInput) nameInput.addEventListener('input', function() { newWorkflowVars[idx].name = nameInput.value; });
    if (descInput) descInput.addEventListener('input', function() { newWorkflowVars[idx].description = descInput.value; });
    if (typeSelect) typeSelect.addEventListener('change', function() { newWorkflowVars[idx].type = typeSelect.value; });
    if (reqInput) reqInput.addEventListener('change', function() { newWorkflowVars[idx].required = reqInput.checked; });
    if (defInput) defInput.addEventListener('input', function() { newWorkflowVars[idx].default = defInput.value; });

    // AI generation prompt toggle
    var genCheck = row.querySelector('.wf-nv-gen-enabled');
    var genPrompt = row.querySelector('.wf-nv-gen-prompt');
    if (genCheck) genCheck.addEventListener('change', function() {
      if (genCheck.checked) {
        newWorkflowVars[idx].generationPrompt = newWorkflowVars[idx].generationPrompt || '';
      } else {
        delete newWorkflowVars[idx].generationPrompt;
      }
      renderNewVarsList();
    });
    if (genPrompt) genPrompt.addEventListener('input', function() {
      newWorkflowVars[idx].generationPrompt = genPrompt.value;
    });

    if (removeBtn) removeBtn.addEventListener('click', function() {
      newWorkflowVars.splice(idx, 1);
      renderNewVarsList();
    });
  });
}

// ── New Workflow: Step rows ──────────────────────────────────

var STEP_TYPES = ['navigate', 'click', 'click_selector', 'type', 'wait', 'keyboard', 'keyboard_nav', 'scroll', 'assert', 'set_variable', 'file_dialog', 'inject_style'];

function renderNewStepsList() {
  var container = document.querySelector('#wf-new-steps-list');
  if (!container) return;

  if (newWorkflowSteps.length === 0) {
    container.innerHTML = '<div style="font-size:0.75rem;color:#475569;">No steps added yet. You can add steps here or record them from the browser.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < newWorkflowSteps.length; i++) {
    var step = newWorkflowSteps[i];
    var icon = STEP_ICONS[step.type] || '&#x25cf;';

    html += '<div class="wf-create-step-row" data-idx="' + i + '">';
    html += '<span class="wf-step-num" style="min-width:1.5rem;">' + (i + 1) + '</span>';

    // Step type selector
    html += '<select class="wf-var-input wf-ns-type" style="width:auto;min-width:100px;">';
    for (var t = 0; t < STEP_TYPES.length; t++) {
      html += '<option value="' + STEP_TYPES[t] + '"' + (step.type === STEP_TYPES[t] ? ' selected' : '') + '>' + (STEP_ICONS[STEP_TYPES[t]] || '') + ' ' + STEP_TYPES[t] + '</option>';
    }
    html += '</select>';

    // Dynamic fields based on step type
    html += '<div class="wf-ns-fields" style="display:flex;gap:0.5rem;flex:1;flex-wrap:wrap;">';
    html += renderStepFields(step, i);
    html += '</div>';

    html += '<button class="wf-ns-remove" data-idx="' + i + '" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:1rem;padding:0 0.25rem;" title="Remove">&#x2715;</button>';
    html += '</div>';
  }
  container.innerHTML = html;

  // Wire change handlers
  container.querySelectorAll('.wf-create-step-row').forEach(function(row) {
    var idx = parseInt(row.dataset.idx);
    var typeSelect = row.querySelector('.wf-ns-type');
    var removeBtn = row.querySelector('.wf-ns-remove');

    if (typeSelect) {
      typeSelect.addEventListener('change', function() {
        newWorkflowSteps[idx] = buildDefaultStep(typeSelect.value);
        renderNewStepsList();
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', function() {
        newWorkflowSteps.splice(idx, 1);
        renderNewStepsList();
      });
    }

    // Wire field-specific inputs
    wireStepFieldHandlers(row, idx);
  });
}

function renderStepFields(step, idx) {
  var html = '';
  switch (step.type) {
    case 'navigate':
      html += '<input class="wf-var-input wf-ns-url" type="url" placeholder="https://example.com" value="' + escAttr(step.url || '') + '" style="flex:1;min-width:200px;">';
      html += '<input class="wf-var-input wf-ns-wait" type="number" placeholder="Wait ms" value="' + escAttr(String(step.waitMs || '')) + '" style="width:80px;" title="Wait after navigation (ms)">';
      break;
    case 'click':
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="CSS selector" value="' + escAttr((step.target && step.target.selector) || '') + '" style="flex:1;min-width:150px;">';
      html += '<input class="wf-var-input wf-ns-text" type="text" placeholder="Text content" value="' + escAttr((step.target && step.target.textContent) || '') + '" style="flex:1;min-width:100px;">';
      html += '<input class="wf-var-input wf-ns-label" type="text" placeholder="Label" value="' + escAttr(step.label || '') + '" style="width:120px;">';
      break;
    case 'type':
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="CSS selector" value="' + escAttr((step.target && step.target.selector) || '') + '" style="flex:1;min-width:150px;">';
      html += '<input class="wf-var-input wf-ns-value" type="text" placeholder="Text to type (use {{var}})" value="' + escAttr(step.value || '') + '" style="flex:1;min-width:150px;">';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;white-space:nowrap;">';
      html += '<input type="checkbox" class="wf-ns-clear"' + (step.clearFirst ? ' checked' : '') + '> Clear first';
      html += '</label>';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;white-space:nowrap;">';
      html += '<input type="checkbox" class="wf-ns-skip-click"' + (step.skipClick ? ' checked' : '') + '> Skip click';
      html += '</label>';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;white-space:nowrap;">';
      html += 'Delay';
      html += '<input class="wf-var-input wf-ns-delay-ms" type="number" value="' + escAttr(String(step.delayAfterMs != null ? step.delayAfterMs : 1000)) + '" placeholder="1000" style="width:65px;">';
      html += '<span style="font-size:0.6rem;">ms</span>';
      html += '</label>';
      break;
    case 'wait':
      html += '<input class="wf-var-input wf-ns-delay" type="number" placeholder="Delay (ms)" value="' + escAttr(String((step.condition && step.condition.ms) || '')) + '" style="width:100px;">';
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="Or wait for selector" value="' + escAttr((step.condition && step.condition.target && step.condition.target.selector) || '') + '" style="flex:1;min-width:150px;">';
      break;
    case 'keyboard':
      html += '<input class="wf-var-input wf-ns-key" type="text" placeholder="Key (e.g. Enter, Tab)" value="' + escAttr(step.key || '') + '" style="width:120px;">';
      html += '<input class="wf-var-input wf-ns-mods" type="text" placeholder="Modifiers (cmd,shift)" value="' + escAttr((step.modifiers || []).join(',')) + '" style="width:140px;">';
      break;
    case 'keyboard_nav':
      html += '<select class="wf-var-input wf-ns-nav-key" style="width:120px;">';
      var qiNavKeys = ['tab', 'shift_tab', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right', 'enter', 'space', 'escape'];
      var qiCurKey = (step.actions && step.actions[0] && step.actions[0].key) || 'tab';
      for (var qk = 0; qk < qiNavKeys.length; qk++) {
        html += '<option value="' + qiNavKeys[qk] + '"' + (qiCurKey === qiNavKeys[qk] ? ' selected' : '') + '>' + qiNavKeys[qk] + '</option>';
      }
      html += '</select>';
      html += '<input class="wf-var-input wf-ns-nav-count" type="number" placeholder="Count" value="' + escAttr(String((step.actions && step.actions[0] && step.actions[0].count) || 1)) + '" style="width:65px;" min="1">';
      break;
    case 'scroll':
      html += '<input class="wf-var-input wf-ns-x" type="number" placeholder="X" value="' + escAttr(String(step.x || '')) + '" style="width:60px;">';
      html += '<input class="wf-var-input wf-ns-y" type="number" placeholder="Y" value="' + escAttr(String(step.y || '')) + '" style="width:60px;">';
      html += '<input class="wf-var-input wf-ns-amount" type="number" placeholder="Amount" value="' + escAttr(String(step.amount || 3)) + '" style="width:70px;">';
      break;
    case 'assert':
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="CSS selector to assert" value="' + escAttr((step.target && step.target.selector) || '') + '" style="flex:1;min-width:150px;">';
      html += '<input class="wf-var-input wf-ns-text" type="text" placeholder="Expected text" value="' + escAttr(step.expectedText || '') + '" style="flex:1;min-width:100px;">';
      break;
    case 'set_variable':
      html += '<input class="wf-var-input wf-ns-varname" type="text" placeholder="Variable name" value="' + escAttr(step.variable || '') + '" style="width:130px;">';
      html += '<input class="wf-var-input wf-ns-value" type="text" placeholder="Value or expression" value="' + escAttr(step.value || '') + '" style="flex:1;min-width:150px;">';
      break;
    case 'file_dialog':
      html += '<input class="wf-var-input wf-ns-filepath" type="text" placeholder="Absolute file path or {{var}}" value="' + escAttr(step.filePath || '') + '" style="flex:1;min-width:200px;">';
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="Trigger selector (optional)" value="' + escAttr((step.trigger && step.trigger.selector) || '') + '" style="flex:1;min-width:120px;">';
      html += '<input class="wf-var-input wf-ns-outvar" type="text" placeholder="Output variable" value="' + escAttr(step.outputVariable || 'selectedFile') + '" style="width:130px;">';
      break;
    case 'inject_style':
      html += '<select class="wf-var-input wf-ns-style-action" style="width:90px;">';
      html += '<option value="apply"' + ((step.action || 'apply') === 'apply' ? ' selected' : '') + '>Apply</option>';
      html += '<option value="clear"' + (step.action === 'clear' ? ' selected' : '') + '>Clear</option>';
      html += '</select>';
      html += '<input class="wf-var-input wf-ns-style-selector" type="text" placeholder="CSS selector" value="' + escAttr(step.selector || '') + '" style="flex:1;min-width:150px;">';
      html += '<input class="wf-var-input wf-ns-style-json" type="text" placeholder=\'{"position":"absolute"}\' value="' + escAttr(JSON.stringify(step.styles || {})) + '" style="flex:1;min-width:150px;">';
      break;
    case 'click_selector':
      html += '<input class="wf-var-input wf-ns-cs-selector" type="text" placeholder="CSS selector" value="' + escAttr(step.selector || '') + '" style="flex:1;min-width:200px;">';
      html += '<input class="wf-var-input wf-ns-cs-shadow" type="text" placeholder="Shadow DOM host (optional)" value="' + escAttr(step.shadowDomSelector || '') + '" style="flex:1;min-width:140px;">';
      html += '<input class="wf-var-input wf-ns-cs-text" type="text" placeholder="Text to match (optional)" value="' + escAttr(step.textContent || '') + '" style="flex:1;min-width:120px;">';
      html += '<select class="wf-var-input wf-ns-cs-click-type" style="width:90px;">';
      ['single', 'double', 'right'].forEach(function(ct) {
        html += '<option value="' + ct + '"' + ((step.clickType || 'single') === ct ? ' selected' : '') + '>' + ct + '</option>';
      });
      html += '</select>';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;white-space:nowrap;">';
      html += 'Delay';
      html += '<input class="wf-var-input wf-ns-cs-delay" type="number" value="' + escAttr(String(step.delayAfterMs != null ? step.delayAfterMs : 1000)) + '" placeholder="1000" style="width:65px;">';
      html += '<span style="font-size:0.6rem;">ms</span>';
      html += '</label>';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;white-space:nowrap;">';
      html += '<input class="wf-ns-cs-exact" type="checkbox"' + (step.exactMatch ? ' checked' : '') + '> Exact';
      html += '</label>';
      break;
    default:
      html += '<span style="color:#475569;font-size:0.75rem;">This step type can be configured after creation</span>';
  }
  return html;
}

function wireStepFieldHandlers(row, idx) {
  var step = newWorkflowSteps[idx];
  if (!step) return;

  switch (step.type) {
    case 'navigate': {
      var urlInput = row.querySelector('.wf-ns-url');
      var waitInput = row.querySelector('.wf-ns-wait');
      if (urlInput) urlInput.addEventListener('input', function() { newWorkflowSteps[idx].url = urlInput.value; });
      if (waitInput) waitInput.addEventListener('input', function() { newWorkflowSteps[idx].waitMs = parseInt(waitInput.value) || 0; });
      break;
    }
    case 'click': {
      var selInput = row.querySelector('.wf-ns-selector');
      var textInput = row.querySelector('.wf-ns-text');
      var lblInput = row.querySelector('.wf-ns-label');
      if (selInput) selInput.addEventListener('input', function() {
        newWorkflowSteps[idx].target = newWorkflowSteps[idx].target || {};
        newWorkflowSteps[idx].target.selector = selInput.value;
      });
      if (textInput) textInput.addEventListener('input', function() {
        newWorkflowSteps[idx].target = newWorkflowSteps[idx].target || {};
        newWorkflowSteps[idx].target.textContent = textInput.value;
      });
      if (lblInput) lblInput.addEventListener('input', function() { newWorkflowSteps[idx].label = lblInput.value; });
      break;
    }
    case 'type': {
      var selInput = row.querySelector('.wf-ns-selector');
      var valInput = row.querySelector('.wf-ns-value');
      var clearInput = row.querySelector('.wf-ns-clear');
      var skipClickInput = row.querySelector('.wf-ns-skip-click');
      if (selInput) selInput.addEventListener('input', function() {
        newWorkflowSteps[idx].target = newWorkflowSteps[idx].target || {};
        newWorkflowSteps[idx].target.selector = selInput.value;
      });
      var delayMsInput = row.querySelector('.wf-ns-delay-ms');
      if (valInput) valInput.addEventListener('input', function() { newWorkflowSteps[idx].value = valInput.value; });
      if (clearInput) clearInput.addEventListener('change', function() { newWorkflowSteps[idx].clearFirst = clearInput.checked; });
      if (skipClickInput) skipClickInput.addEventListener('change', function() { newWorkflowSteps[idx].skipClick = skipClickInput.checked; });
      if (delayMsInput) delayMsInput.addEventListener('input', function() { newWorkflowSteps[idx].delayAfterMs = parseInt(delayMsInput.value) || 0; });
      break;
    }
    case 'wait': {
      var delayInput = row.querySelector('.wf-ns-delay');
      var selInput = row.querySelector('.wf-ns-selector');
      if (delayInput) delayInput.addEventListener('input', function() {
        newWorkflowSteps[idx].condition = { type: 'delay', ms: parseInt(delayInput.value) || 1000 };
      });
      if (selInput) selInput.addEventListener('input', function() {
        if (selInput.value) {
          newWorkflowSteps[idx].condition = { type: 'element_visible', target: { selector: selInput.value } };
        }
      });
      break;
    }
    case 'keyboard': {
      var keyInput = row.querySelector('.wf-ns-key');
      var modsInput = row.querySelector('.wf-ns-mods');
      if (keyInput) keyInput.addEventListener('input', function() { newWorkflowSteps[idx].key = keyInput.value; });
      if (modsInput) modsInput.addEventListener('input', function() {
        newWorkflowSteps[idx].modifiers = modsInput.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      });
      break;
    }
    case 'set_variable': {
      var nameInput = row.querySelector('.wf-ns-varname');
      var valInput = row.querySelector('.wf-ns-value');
      if (nameInput) nameInput.addEventListener('input', function() { newWorkflowSteps[idx].variable = nameInput.value; });
      if (valInput) valInput.addEventListener('input', function() { newWorkflowSteps[idx].value = valInput.value; });
      break;
    }
    case 'file_dialog': {
      var fpInput = row.querySelector('.wf-ns-filepath');
      var selInput = row.querySelector('.wf-ns-selector');
      var outVarInput = row.querySelector('.wf-ns-outvar');
      if (fpInput) fpInput.addEventListener('input', function() { newWorkflowSteps[idx].filePath = fpInput.value; });
      if (selInput) selInput.addEventListener('input', function() {
        newWorkflowSteps[idx].trigger = newWorkflowSteps[idx].trigger || {};
        newWorkflowSteps[idx].trigger.selector = selInput.value;
      });
      if (outVarInput) outVarInput.addEventListener('input', function() { newWorkflowSteps[idx].outputVariable = outVarInput.value; });
      break;
    }
    case 'inject_style': {
      var actionInput = row.querySelector('.wf-ns-style-action');
      var selInput = row.querySelector('.wf-ns-style-selector');
      var jsonInput = row.querySelector('.wf-ns-style-json');
      if (actionInput) actionInput.addEventListener('change', function() { newWorkflowSteps[idx].action = actionInput.value; });
      if (selInput) selInput.addEventListener('input', function() { newWorkflowSteps[idx].selector = selInput.value; });
      if (jsonInput) jsonInput.addEventListener('input', function() {
        try { newWorkflowSteps[idx].styles = JSON.parse(jsonInput.value); } catch(e) { /* ignore invalid JSON while typing */ }
      });
      break;
    }
    case 'click_selector': {
      var csSel = row.querySelector('.wf-ns-cs-selector');
      var csShadow = row.querySelector('.wf-ns-cs-shadow');
      var csType = row.querySelector('.wf-ns-cs-click-type');
      var csDelay = row.querySelector('.wf-ns-cs-delay');
      var csText = row.querySelector('.wf-ns-cs-text');
      var csExact = row.querySelector('.wf-ns-cs-exact');
      if (csSel) csSel.addEventListener('input', function() { newWorkflowSteps[idx].selector = csSel.value; });
      if (csShadow) csShadow.addEventListener('input', function() { newWorkflowSteps[idx].shadowDomSelector = csShadow.value; });
      if (csText) csText.addEventListener('input', function() { newWorkflowSteps[idx].textContent = csText.value; });
      if (csExact) csExact.addEventListener('change', function() { newWorkflowSteps[idx].exactMatch = csExact.checked; });
      if (csType) csType.addEventListener('change', function() { newWorkflowSteps[idx].clickType = csType.value; });
      if (csDelay) csDelay.addEventListener('input', function() { newWorkflowSteps[idx].delayAfterMs = parseInt(csDelay.value) || 0; });
      break;
    }
  }
}

function buildDefaultStep(type) {
  switch (type) {
    case 'navigate': return { type: 'navigate', url: '', waitMs: 2000, label: '' };
    case 'click': return { type: 'click', target: { selector: '', textContent: '' }, label: '', delayAfterMs: 1000 };
    case 'type': return { type: 'type', target: { selector: '' }, value: '', clearFirst: false, skipClick: false, label: '', delayAfterMs: 1000 };
    case 'wait': return { type: 'wait', condition: { type: 'delay', ms: 2000 }, label: '' };
    case 'keyboard': return { type: 'keyboard', key: '', modifiers: [], label: '' };
    case 'keyboard_nav': return { type: 'keyboard_nav', actions: [{ key: 'tab', count: 1 }], expectedFocus: {}, autoFix: true, maxSearchDistance: 20, delayAfterMs: 1000, label: '' };
    case 'scroll': return { type: 'scroll', x: 0, y: 0, amount: 3, label: '' };
    case 'assert': return { type: 'assert', target: { selector: '' }, expectedText: '', label: '' };
    case 'set_variable': return { type: 'set_variable', variable: '', value: '', label: '' };
    case 'file_dialog': return { type: 'file_dialog', filePath: '', trigger: { selector: '' }, outputVariable: 'selectedFile', delayBeforeMs: 2000, delayAfterMs: 1000, label: '' };
    case 'capture_download': return { type: 'capture_download', outputVariable: 'downloadedFiles', maxFiles: 1, label: '' };
    case 'move_file': return { type: 'move_file', source: '', destination: '', label: '' };
    case 'conditional': return { type: 'conditional', condition: { type: 'expression', expression: '' }, thenSteps: [], elseSteps: [], label: 'Conditional' };
    case 'loop': return { type: 'loop', overVariable: '', itemVariable: 'item', indexVariable: '', steps: [], label: 'Loop' };
    case 'try_catch': return { type: 'try_catch', trySteps: [], catchSteps: [], errorVariable: 'error', label: 'Try / Catch' };
    case 'inject_style': return { type: 'inject_style', selector: '', styles: {}, action: 'apply', label: '' };
    case 'click_selector': return { type: 'click_selector', selector: '', shadowDomSelector: '', textContent: '', exactMatch: false, clickType: 'single', delayAfterMs: 1000, label: '' };
    default: return { type: type, label: '' };
  }
}

/**
 * Resolve a dot-path like "3", "3.thenSteps.1", "2.steps.0" into
 * { array: <parent steps array>, index: <number>, step: <step object> }
 * relative to the workflow's steps array.
 */
function resolveStepPath(wfSteps, path) {
  var parts = String(path).split('.');
  // Simple top-level index (e.g. "3")
  if (parts.length === 1) {
    var idx = parseInt(parts[0]);
    return { array: wfSteps, index: idx, step: wfSteps[idx] };
  }
  // Nested path (e.g. "3.thenSteps.1")
  var currentArray = wfSteps;
  var currentStep = null;
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi];
    if (pi % 2 === 0) {
      // Even parts are numeric indices
      var numIdx = parseInt(part);
      currentStep = currentArray[numIdx];
      // Last part — this is the target
      if (pi === parts.length - 1) {
        return { array: currentArray, index: numIdx, step: currentStep };
      }
    } else {
      // Odd parts are property names (thenSteps, elseSteps, steps, trySteps, catchSteps)
      if (!currentStep || !currentStep[part]) return null;
      currentArray = currentStep[part];
    }
  }
  return null;
}

/**
 * Given a nested step path like "4.thenSteps.0", find the parent wrapper step
 * and its position in the grandparent array.
 * Returns { parentArray, parentIndex, parentStep, subProp } or null if top-level.
 *
 * Example: path "4.thenSteps.0"
 *  -> parentArray = wf.steps, parentIndex = 4, parentStep = wf.steps[4], subProp = "thenSteps"
 *
 * Example: path "2.thenSteps.1.steps.0"
 *  -> parentArray = wf.steps[2].thenSteps, parentIndex = 1, parentStep = wf.steps[2].thenSteps[1], subProp = "steps"
 */
function getParentFromPath(wfSteps, path) {
  var parts = String(path).split('.');
  // Top-level steps have no parent group
  if (parts.length <= 1) return null;

  // Remove the last two parts (subProp + index) to get the parent path
  // e.g. "4.thenSteps.0" -> parentPath = "4", subProp = "thenSteps"
  var childIdx = parseInt(parts[parts.length - 1]);
  var subProp = parts[parts.length - 2];
  var parentParts = parts.slice(0, parts.length - 2);

  if (parentParts.length === 0) return null;

  var parentPath = parentParts.join('.');
  var parentResolved = resolveStepPath(wfSteps, parentPath);
  if (!parentResolved) return null;

  return {
    parentArray: parentResolved.array,
    parentIndex: parentResolved.index,
    parentStep: parentResolved.step,
    subProp: subProp,
  };
}

// ── Create Workflow API call ────────────────────────────────

async function createNewWorkflow() {
  var nameInput = document.querySelector('#wf-new-name');
  var descInput = document.querySelector('#wf-new-desc');
  var siteInput = document.querySelector('#wf-new-site');
  var statusEl = document.querySelector('#wf-create-status');
  var createBtn = document.querySelector('#wf-btn-create');

  if (!nameInput || !createBtn) return;

  var name = nameInput.value.trim();
  if (!name) {
    toast('Workflow name is required', 'error');
    nameInput.focus();
    return;
  }

  // Build variables (filter out empty names)
  var variables = newWorkflowVars.filter(function(v) { return v.name.trim(); }).map(function(v) {
    var result = {
      name: v.name.trim(),
      description: v.description.trim(),
      type: v.type || 'string',
      required: !!v.required,
    };
    if (v.default && v.default.trim()) {
      result.default = v.default.trim();
    }
    return result;
  });

  // Build steps (generate IDs and labels)
  var steps = newWorkflowSteps.map(function(s, i) {
    var step = Object.assign({}, s);
    step.id = 'step-' + (i + 1) + '-' + step.type;
    if (!step.label) {
      step.label = buildStepLabel(step, i);
    }
    return step;
  });

  createBtn.disabled = true;
  statusEl.textContent = 'Creating...';

  try {
    var res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        description: descInput ? descInput.value.trim() : '',
        site: siteInput ? siteInput.value.trim() : '',
        variables: variables,
        steps: steps,
      }),
    });

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Create failed');

    toast('Workflow "' + name + '" created!', 'success');
    await fetchWorkflows();
    selectWorkflow(data.workflow.id);
  } catch (err) {
    toast('Create failed: ' + err.message, 'error');
    statusEl.textContent = '';
  } finally {
    createBtn.disabled = false;
  }
}

// ── Step Label Builder ───────────────────────────────────────

function buildStepLabel(step, idx) {
  switch (step.type) {
    case 'navigate':
      if (step.selectorSource && step.selectorSource.selector) {
        var selShort = step.selectorSource.selector.length > 30 ? step.selectorSource.selector.slice(0, 30) + '...' : step.selectorSource.selector;
        return 'Navigate to [' + selShort + '].' + (step.selectorSource.attribute || 'href');
      }
      return 'Navigate to ' + (step.url || 'URL');
    case 'click': return 'Click ' + ((step.target && step.target.textContent) || (step.target && step.target.selector) || 'element');
    case 'type': return 'Type "' + truncate(step.value || '', 30) + '"';
    case 'wait': return step.condition && step.condition.type === 'delay' ? 'Wait ' + (step.condition.ms || 0) + 'ms' : 'Wait for element';
    case 'keyboard': return 'Press ' + (step.modifiers && step.modifiers.length ? step.modifiers.join('+') + '+' : '') + (step.key || 'key');
    case 'keyboard_nav': {
      var navLabelMap = { tab: 'Tab', shift_tab: 'Shift+Tab', arrow_up: '\u2191', arrow_down: '\u2193', arrow_left: '\u2190', arrow_right: '\u2192', enter: 'Enter', space: 'Space', escape: 'Esc' };
      var acts = step.actions || [];
      if (acts.length === 0) return 'Keyboard Nav';
      var parts = [];
      for (var li = 0; li < acts.length; li++) {
        var a = acts[li];
        var lbl = navLabelMap[a.key] || a.key;
        if (a.count > 1) lbl += ' \u00d7' + a.count;
        if (a.matchText) lbl += ' find \u201c' + truncate(a.matchText, 20) + '\u201d';
        parts.push(lbl);
      }
      var ef = step.expectedFocus;
      if (ef && (ef.text || ef.ariaLabel || ef.selector)) {
        parts.push('\u201c' + truncate(ef.text || ef.ariaLabel || ef.selector, 20) + '\u201d');
      }
      return parts.join(' \u2192 ');
    }
    case 'scroll': return 'Scroll';
    case 'assert': return 'Assert ' + ((step.target && step.target.selector) || 'element');
    case 'set_variable': return 'Set ' + (step.variable || 'variable');
    case 'file_dialog': return 'Select file ' + truncate(step.filePath || '', 40);
    case 'capture_download': return 'Capture download';
    case 'move_file': return 'Move ' + truncate(step.source || 'file', 25);
    case 'conditional': return 'Conditional';
    case 'loop': return 'Loop over ' + (step.overVariable || 'items');
    case 'try_catch': return 'Try / Catch';
    case 'inject_style': return step.action === 'clear' ? 'Clear styles: ' + truncate(step.selector || 'all', 30) : 'Inject style: ' + truncate(step.selector || '', 30);
    case 'click_selector': return 'Click ' + (step.selector || 'element') + (step.shadowDomSelector ? ' [shadow: ' + truncate(step.shadowDomSelector, 20) + ']' : '') + (step.textContent ? ' "' + truncate(step.textContent, 20) + '"' : '');
    default: return 'Step ' + (idx + 1);
  }
}

// ── Collapse Keyboard Steps ──────────────────────────────────

/**
 * Collapse consecutive keyboard steps with navigation/action keys into
 * optimized keyboard_nav steps.
 *
 * A keyboard step qualifies if its key is one of:
 *   Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Escape, Space
 * and it has no Ctrl, Alt, or Cmd/Meta modifiers (Shift is allowed only for Tab).
 *
 * Returns a new array of steps with qualifying runs merged into keyboard_nav steps.
 */
function collapseKeyboardSteps(steps) {
  var KEY_MAP = {
    'Tab':        'tab',
    'ArrowUp':    'arrow_up',
    'ArrowDown':  'arrow_down',
    'ArrowLeft':  'arrow_left',
    'ArrowRight': 'arrow_right',
    'Enter':      'enter',
    'Escape':     'escape',
    'Space':      'space',
    ' ':          'space',
  };

  var NAV_LABEL_MAP = {
    tab: 'Tab', shift_tab: 'Shift+Tab',
    arrow_up: '\u2191', arrow_down: '\u2193',
    arrow_left: '\u2190', arrow_right: '\u2192',
    enter: 'Enter', space: 'Space', escape: 'Esc',
  };

  /**
   * Check if a keyboard step qualifies for collapsing.
   * Returns the mapped action key string, or null if it doesn't qualify.
   */
  function getNavAction(step) {
    if (!step || step.type !== 'keyboard') return null;
    var key = step.key;
    if (!key || !KEY_MAP[key]) return null;

    var mods = step.modifiers || [];
    // Disallow Ctrl, Alt, Cmd/Meta
    for (var m = 0; m < mods.length; m++) {
      var mod = mods[m].toLowerCase();
      if (mod === 'ctrl' || mod === 'control' || mod === 'alt' ||
          mod === 'cmd' || mod === 'meta' || mod === 'command') {
        return null;
      }
    }

    // Shift is only allowed with Tab
    var hasShift = false;
    for (var s = 0; s < mods.length; s++) {
      if (mods[s].toLowerCase() === 'shift') { hasShift = true; break; }
    }
    if (hasShift && key !== 'Tab') return null;

    if (hasShift && key === 'Tab') return 'shift_tab';
    return KEY_MAP[key];
  }

  /**
   * Build a label from an actions array.
   */
  function buildNavLabel(actions) {
    var parts = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var lbl = NAV_LABEL_MAP[a.key] || a.key;
      if (a.count > 1) lbl += ' \u00d7' + a.count;
      parts.push(lbl);
    }
    return parts.join(' \u2192 ');
  }

  var result = [];
  var stepCounter = 1;
  var pendingActions = null; // array of { key, count }

  function flushPending() {
    if (!pendingActions || pendingActions.length === 0) return;
    var label = buildNavLabel(pendingActions);
    result.push({
      type: 'keyboard_nav',
      id: 'keyboard_nav_' + stepCounter++,
      actions: pendingActions,
      autoFix: true,
      label: label,
    });
    pendingActions = null;
  }

  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var action = getNavAction(step);

    if (action) {
      if (pendingActions) {
        // Check if same action as last entry — increment count
        var last = pendingActions[pendingActions.length - 1];
        if (last.key === action) {
          last.count++;
        } else {
          pendingActions.push({ key: action, count: 1 });
        }
      } else {
        // Start a new pending group
        pendingActions = [{ key: action, count: 1 }];
      }
    } else {
      // Non-matching step — flush any pending group, then emit this step
      flushPending();
      result.push(step);
    }
  }

  // Flush any trailing pending group
  flushPending();

  return result;
}

// ── Detail View ──────────────────────────────────────────────

async function selectWorkflow(id) {
  selectedWorkflow = id;

  // Update hash
  if (typeof updateHash === 'function') {
    updateHash('workflows', id, detailView);
  }

  // Update sidebar
  document.querySelectorAll('#wf-list .ext-item').forEach(el => {
    el.classList.toggle('active', el.dataset.wfId === id);
  });

  const main = document.querySelector('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  try {
    const data = await fetchWorkflowDetail(id);
    renderWorkflowDetail(data.workflow, data.path, data.source);

    // If workflow has active training, start polling
    var ts = data.workflow.metadata && data.workflow.metadata.trainingStatus;
    if (ts === 'pending' || ts === 'training') {
      startWorkflowTrainingPoll(id);
    } else {
      // Check server-side for in-progress training (may not be in workflow JSON yet)
      checkAndPollWorkflowTraining(id);
    }
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div>' +
      '<h2>Error</h2><p>' + escHtml(err.message) + '</p></div>';
  }
}

function renderWorkflowDetail(wf, filePath, source) {
  // Save any in-progress variable values before re-rendering
  saveRunVarValues(wf.id);

  // Clear batch selection on re-render
  selectedStepPaths.clear();
  lastCheckedStepPath = null;

  // Store context for delegated handlers
  _wfCurrentDetail = { wf: wf, filePath: filePath, source: source };

  const main = document.querySelector('#main');
  let html = '';

  // Header row: title + delete
  html += '<div class="wf-detail-header">';
  html += '<div style="min-width:0;">';
  var isCodeWorkflow = filePath && filePath.endsWith('.workflow.js');
  html += '<h2 id="wf-title" title="Double-click to rename" style="cursor:pointer;">' + escHtml(wf.name);
  if (isCodeWorkflow) {
    html += ' <span style="font-size:0.6rem;padding:2px 6px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border-radius:4px;vertical-align:middle;font-weight:500;">JS</span>';
  }
  html += '</h2>';
  html += '<div class="wf-detail-meta">';
  html += escHtml(wf.description || '') + '<br>';
  html += '<code style="color:#475569;font-size:0.7rem;">' + escHtml(filePath) + '</code>';
  html += '</div>';
  html += '</div>';
  html += '<div class="wf-detail-actions">';
  html += '<button class="btn-primary" id="wf-btn-publish">Publish</button>';
  html += '<button class="btn-secondary" id="wf-btn-rename" style="font-size:0.75rem;">Rename</button>';
  html += '<button class="btn-danger" id="wf-btn-delete">Delete</button>';
  html += '</div>';
  html += '</div>';

  // Tab bar
  html += '<div class="wf-tab-bar">';
  var views = [
    { key: 'visual', label: 'Visual' },
    { key: 'model', label: 'Model' },
    { key: 'run', label: 'Run' },
    { key: 'json', label: 'JSON' },
  ];
  for (var vi = 0; vi < views.length; vi++) {
    var v = views[vi];
    html += '<button class="wf-tab' + (detailView === v.key ? ' wf-tab-active' : '') + '" data-view="' + v.key + '">';
    html += v.label;
    html += '</button>';
  }
  html += '</div>';

  if (detailView === 'json') {
    html += renderJsonView(wf);
  } else if (detailView === 'run') {
    html += renderRunView(wf);
  } else if (detailView === 'model') {
    html += renderModelView(wf);
  } else {
    html += renderVisualView(wf, source);
  }

  main.innerHTML = html;
  wireUpHandlers(wf, filePath, source);
}

// ── Helpers ──────────────────────────────────────────────────

function infoChip(label, value, color) {
  var c = color || '#7c3aed';
  return '<div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:0.4rem 0.75rem;font-size:0.7rem;">' +
    '<span style="color:#64748b;">' + escHtml(label) + '</span> ' +
    '<span style="color:' + c + ';font-weight:600;">' + escHtml(value) + '</span>' +
    '</div>';
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

function formatDuration(ms) {
  if (!ms) return '0s';
  if (ms < 1000) return ms + 'ms';
  var secs = Math.round(ms / 1000);
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  var remainSecs = secs % 60;
  return mins + 'm ' + remainSecs + 's';
}

// These are defined in app.js — but define fallbacks in case load order varies
if (typeof escHtml === 'undefined') {
  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

if (typeof escAttr === 'undefined') {
  function escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
