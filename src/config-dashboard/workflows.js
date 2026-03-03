/**
 * Workflows Dashboard — Client-side JavaScript
 *
 * Manages workflow recordings: view, edit variables, edit JSON, delete, run.
 * Supports dynamic variable input forms and workflow pipeline chaining.
 * Loaded alongside app.js in the same SPA.
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
      '<span style="color:#94a3b8;">Use <code style="background:#0f172a;padding:2px 6px;border-radius:3px;">/record</code> in the CLI or click <strong>+ New Workflow</strong> above.</span>' +
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
      return '<div class="ext-item' + active + '" data-wf-id="' + escAttr(wf.id) + '">' +
        '<div class="ext-item-name">' + escHtml(wf.name) + '</div>' +
        '<div class="ext-item-meta">' + escHtml(isDesktop ? 'Desktop App' : (wf.site || '')) + ' &middot; ' + wf.stepCount + ' steps</div>' +
        '<div class="ext-item-badges">' +
          '<span class="badge badge-ok">' + escHtml(wf.source) + '</span>' +
          typeBadge +
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

var STEP_TYPES = ['navigate', 'click', 'type', 'wait', 'keyboard', 'scroll', 'assert', 'set_variable', 'file_dialog'];

function renderNewStepsList() {
  var container = document.querySelector('#wf-new-steps-list');
  if (!container) return;

  if (newWorkflowSteps.length === 0) {
    container.innerHTML = '<div style="font-size:0.75rem;color:#475569;">No steps added yet. Steps can also be added later via the JSON editor.</div>';
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
      break;
    case 'wait':
      html += '<input class="wf-var-input wf-ns-delay" type="number" placeholder="Delay (ms)" value="' + escAttr(String((step.condition && step.condition.ms) || '')) + '" style="width:100px;">';
      html += '<input class="wf-var-input wf-ns-selector" type="text" placeholder="Or wait for selector" value="' + escAttr((step.condition && step.condition.target && step.condition.target.selector) || '') + '" style="flex:1;min-width:150px;">';
      break;
    case 'keyboard':
      html += '<input class="wf-var-input wf-ns-key" type="text" placeholder="Key (e.g. Enter, Tab)" value="' + escAttr(step.key || '') + '" style="width:120px;">';
      html += '<input class="wf-var-input wf-ns-mods" type="text" placeholder="Modifiers (cmd,shift)" value="' + escAttr((step.modifiers || []).join(',')) + '" style="width:140px;">';
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
    default:
      html += '<span style="color:#475569;font-size:0.75rem;">Configure in JSON editor after creation</span>';
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
      if (selInput) selInput.addEventListener('input', function() {
        newWorkflowSteps[idx].target = newWorkflowSteps[idx].target || {};
        newWorkflowSteps[idx].target.selector = selInput.value;
      });
      if (valInput) valInput.addEventListener('input', function() { newWorkflowSteps[idx].value = valInput.value; });
      if (clearInput) clearInput.addEventListener('change', function() { newWorkflowSteps[idx].clearFirst = clearInput.checked; });
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
  }
}

function buildDefaultStep(type) {
  switch (type) {
    case 'navigate': return { type: 'navigate', url: '', waitMs: 2000, label: '' };
    case 'click': return { type: 'click', target: { selector: '', textContent: '' }, label: '', delayAfterMs: 300 };
    case 'type': return { type: 'type', target: { selector: '' }, value: '', clearFirst: false, label: '', delayAfterMs: 300 };
    case 'wait': return { type: 'wait', condition: { type: 'delay', ms: 2000 }, label: '' };
    case 'keyboard': return { type: 'keyboard', key: '', modifiers: [], label: '' };
    case 'scroll': return { type: 'scroll', x: 0, y: 0, amount: 3, label: '' };
    case 'assert': return { type: 'assert', target: { selector: '' }, expectedText: '', label: '' };
    case 'set_variable': return { type: 'set_variable', variable: '', value: '', label: '' };
    case 'file_dialog': return { type: 'file_dialog', filePath: '', trigger: { selector: '' }, outputVariable: 'selectedFile', delayBeforeMs: 2000, delayAfterMs: 1000, label: '' };
    case 'capture_download': return { type: 'capture_download', outputVariable: 'downloadedFiles', maxFiles: 1, label: '' };
    case 'move_file': return { type: 'move_file', source: '', destination: '', label: '' };
    default: return { type: type, label: '' };
  }
}

// ── Step Editor (Visual View inline editing) ───────────────

function renderStepEditor(step, idx, totalSteps) {
  var html = '';
  // Label row (all step types)
  html += '<div class="wf-se-row">';
  html += '<span class="wf-se-label">Label</span>';
  html += '<input class="wf-se-input wf-se-step-label" type="text" value="' + escAttr(step.label || '') + '" placeholder="Step label">';
  html += '</div>';

  // Type-specific fields
  switch (step.type) {
    case 'navigate':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">URL</span>';
      html += '<input class="wf-se-input wf-se-url" type="text" value="' + escAttr(step.url || '') + '" placeholder="https://example.com">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Wait ms</span>';
      html += '<input class="wf-se-input wf-se-wait-ms" type="number" value="' + escAttr(String(step.waitMs || '')) + '" placeholder="2000" style="max-width:100px;">';
      html += '</div>';
      break;

    case 'click':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Text</span>';
      html += '<input class="wf-se-input wf-se-text" type="text" value="' + escAttr((step.target && step.target.textContent) || '') + '" placeholder="Text content">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Click type</span>';
      var ct = step.clickType || 'single';
      html += '<select class="wf-se-input wf-se-click-type" style="max-width:120px;">';
      ['single', 'double', 'right', 'hover'].forEach(function(t) {
        html += '<option value="' + t + '"' + (ct === t ? ' selected' : '') + '>' + t + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay-ms" type="number" value="' + escAttr(String(step.delayAfterMs || '')) + '" placeholder="300" style="max-width:100px;">';
      html += '</div>';
      break;

    case 'type':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Value</span>';
      html += '<textarea class="wf-se-input wf-se-value" placeholder="Text to type (use {{var}})">' + escHtml(step.value || '') + '</textarea>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;">';
      html += '<input type="checkbox" class="wf-se-clear"' + (step.clearFirst ? ' checked' : '') + '> Clear first';
      html += '</label>';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay-ms" type="number" value="' + escAttr(String(step.delayAfterMs || '')) + '" placeholder="300" style="max-width:100px;">';
      html += '</div>';
      break;

    case 'wait':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay" type="number" value="' + escAttr(String((step.condition && step.condition.ms) || '')) + '" placeholder="2000" style="max-width:120px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Or selector</span>';
      html += '<input class="wf-se-input wf-se-wait-selector" type="text" value="' + escAttr((step.condition && step.condition.target && step.condition.target.selector) || '') + '" placeholder="Wait for element selector">';
      html += '</div>';
      break;

    case 'keyboard':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Key</span>';
      html += '<input class="wf-se-input wf-se-key" type="text" value="' + escAttr(step.key || '') + '" placeholder="Enter, Tab, etc." style="max-width:150px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Modifiers</span>';
      html += '<input class="wf-se-input wf-se-mods" type="text" value="' + escAttr((step.modifiers || []).join(', ')) + '" placeholder="cmd, shift, ctrl, alt">';
      html += '</div>';
      break;

    case 'scroll':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Direction</span>';
      var dir = step.direction || 'down';
      html += '<select class="wf-se-input wf-se-direction" style="max-width:120px;">';
      ['up', 'down', 'left', 'right'].forEach(function(d) {
        html += '<option value="' + d + '"' + (dir === d ? ' selected' : '') + '>' + d + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Amount</span>';
      html += '<input class="wf-se-input wf-se-amount" type="number" value="' + escAttr(String(step.amount || 3)) + '" placeholder="3" style="max-width:80px;">';
      html += '</div>';
      break;

    case 'assert':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Expected</span>';
      html += '<input class="wf-se-input wf-se-expected" type="text" value="' + escAttr(step.expectedText || '') + '" placeholder="Expected text">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Error msg</span>';
      html += '<input class="wf-se-input wf-se-error-msg" type="text" value="' + escAttr(step.errorMessage || '') + '" placeholder="Custom error message">';
      html += '</div>';
      break;

    case 'set_variable':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Variable</span>';
      html += '<input class="wf-se-input wf-se-varname" type="text" value="' + escAttr(step.variable || '') + '" placeholder="Variable name" style="max-width:160px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Value</span>';
      html += '<input class="wf-se-input wf-se-varvalue" type="text" value="' + escAttr((step.source && step.source.type === 'literal' && step.source.value != null) ? String(step.source.value) : (step.value || '')) + '" placeholder="Value or expression">';
      html += '</div>';
      break;

    case 'capture_download':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Pattern</span>';
      html += '<input class="wf-se-input wf-se-filename-pattern" type="text" value="' + escAttr(step.filenamePattern || '') + '" placeholder="Filename regex pattern">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Max files</span>';
      html += '<input class="wf-se-input wf-se-max-files" type="number" value="' + escAttr(String(step.maxFiles || '')) + '" placeholder="1" style="max-width:80px;">';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Timeout ms</span>';
      html += '<input class="wf-se-input wf-se-timeout" type="number" value="' + escAttr(String(step.waitTimeoutMs || '')) + '" placeholder="30000" style="max-width:120px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Output var</span>';
      html += '<input class="wf-se-input wf-se-output-var" type="text" value="' + escAttr(step.outputVariable || '') + '" placeholder="Variable for downloaded paths" style="max-width:200px;">';
      html += '</div>';
      break;

    case 'move_file':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Source</span>';
      html += '<input class="wf-se-input wf-se-source" type="text" value="' + escAttr(step.source || '') + '" placeholder="Source path or {{var}}">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Destination</span>';
      html += '<input class="wf-se-input wf-se-destination" type="text" value="' + escAttr(step.destination || '') + '" placeholder="Destination path or {{var}}">';
      html += '</div>';
      break;

    case 'file_dialog':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">File path</span>';
      html += '<input class="wf-se-input wf-se-filepath" type="text" value="' + escAttr(step.filePath || '') + '" placeholder="Absolute path or {{variable}}">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Trigger</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.trigger && step.trigger.selector) || '') + '" placeholder="CSS selector for upload button (optional)">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Output var</span>';
      html += '<input class="wf-se-input wf-se-output-var" type="text" value="' + escAttr(step.outputVariable || '') + '" placeholder="Variable for file path" style="max-width:200px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay before</span>';
      html += '<input class="wf-se-input wf-se-delay-before" type="number" value="' + escAttr(String(step.delayBeforeMs || '')) + '" placeholder="2000" style="max-width:100px;">';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Delay after</span>';
      html += '<input class="wf-se-input wf-se-delay-after" type="number" value="' + escAttr(String(step.delayAfterMs || '')) + '" placeholder="1000" style="max-width:100px;">';
      html += '</div>';
      break;

    default:
      // Complex types: sub_workflow, conditional, loop, try_catch
      html += '<div class="wf-se-row">';
      html += '<span style="color:#64748b;font-size:0.75rem;font-style:italic;">Complex step type — edit in JSON editor for full control</span>';
      html += '</div>';
  }

  // Action buttons
  html += '<div class="wf-se-actions">';
  html += '<button class="wf-se-btn wf-se-btn-save wf-se-save">Save</button>';
  html += '<button class="wf-se-btn wf-se-cancel">Cancel</button>';
  html += '<button class="wf-se-btn wf-se-up"' + (idx === 0 ? ' disabled' : '') + '>&uarr; Up</button>';
  html += '<button class="wf-se-btn wf-se-down"' + (idx >= totalSteps - 1 ? ' disabled' : '') + '>&darr; Down</button>';
  html += '<button class="wf-se-btn wf-se-insert-below" style="color:#38bdf8;">+ Insert</button>';
  html += '<button class="wf-se-btn wf-se-btn-delete wf-se-delete" style="margin-left:auto;">Delete</button>';
  html += '</div>';

  return html;
}

function collectStepEditorValues(editor, step) {
  // Clone the step to preserve all original properties (id, preconditions, screenshotRef, etc.)
  var updated = JSON.parse(JSON.stringify(step));

  // Label (all step types)
  var labelInput = editor.querySelector('.wf-se-step-label');
  if (labelInput) updated.label = labelInput.value;

  switch (step.type) {
    case 'navigate': {
      var urlInput = editor.querySelector('.wf-se-url');
      var waitInput = editor.querySelector('.wf-se-wait-ms');
      if (urlInput) updated.url = urlInput.value;
      if (waitInput) updated.waitMs = parseInt(waitInput.value) || 0;
      break;
    }
    case 'click': {
      var selInput = editor.querySelector('.wf-se-selector');
      var textInput = editor.querySelector('.wf-se-text');
      var ctSelect = editor.querySelector('.wf-se-click-type');
      var delayInput = editor.querySelector('.wf-se-delay-ms');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (textInput) updated.target.textContent = textInput.value;
      if (ctSelect) {
        if (ctSelect.value === 'single') delete updated.clickType;
        else updated.clickType = ctSelect.value;
      }
      if (delayInput) updated.delayAfterMs = parseInt(delayInput.value) || 0;
      break;
    }
    case 'type': {
      var selInput = editor.querySelector('.wf-se-selector');
      var valInput = editor.querySelector('.wf-se-value');
      var clearInput = editor.querySelector('.wf-se-clear');
      var delayInput = editor.querySelector('.wf-se-delay-ms');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (valInput) updated.value = valInput.value;
      if (clearInput) updated.clearFirst = clearInput.checked;
      if (delayInput) updated.delayAfterMs = parseInt(delayInput.value) || 0;
      break;
    }
    case 'wait': {
      var delayInput = editor.querySelector('.wf-se-delay');
      var selInput = editor.querySelector('.wf-se-wait-selector');
      if (selInput && selInput.value) {
        updated.condition = { type: 'element_visible', target: { selector: selInput.value } };
      } else if (delayInput) {
        updated.condition = { type: 'delay', ms: parseInt(delayInput.value) || 1000 };
      }
      break;
    }
    case 'keyboard': {
      var keyInput = editor.querySelector('.wf-se-key');
      var modsInput = editor.querySelector('.wf-se-mods');
      if (keyInput) updated.key = keyInput.value;
      if (modsInput) updated.modifiers = modsInput.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      break;
    }
    case 'scroll': {
      var dirSelect = editor.querySelector('.wf-se-direction');
      var amountInput = editor.querySelector('.wf-se-amount');
      if (dirSelect) updated.direction = dirSelect.value;
      if (amountInput) updated.amount = parseInt(amountInput.value) || 3;
      break;
    }
    case 'assert': {
      var selInput = editor.querySelector('.wf-se-selector');
      var expectedInput = editor.querySelector('.wf-se-expected');
      var errorInput = editor.querySelector('.wf-se-error-msg');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (expectedInput) updated.expectedText = expectedInput.value;
      if (errorInput) updated.errorMessage = errorInput.value || undefined;
      break;
    }
    case 'set_variable': {
      var nameInput = editor.querySelector('.wf-se-varname');
      var valInput = editor.querySelector('.wf-se-varvalue');
      if (nameInput) updated.variable = nameInput.value;
      if (valInput) updated.value = valInput.value;
      break;
    }
    case 'capture_download': {
      var patternInput = editor.querySelector('.wf-se-filename-pattern');
      var maxInput = editor.querySelector('.wf-se-max-files');
      var timeoutInput = editor.querySelector('.wf-se-timeout');
      var outVarInput = editor.querySelector('.wf-se-output-var');
      if (patternInput) updated.filenamePattern = patternInput.value || undefined;
      if (maxInput) updated.maxFiles = parseInt(maxInput.value) || undefined;
      if (timeoutInput) updated.waitTimeoutMs = parseInt(timeoutInput.value) || undefined;
      if (outVarInput) updated.outputVariable = outVarInput.value || undefined;
      break;
    }
    case 'move_file': {
      var srcInput = editor.querySelector('.wf-se-source');
      var destInput = editor.querySelector('.wf-se-destination');
      if (srcInput) updated.source = srcInput.value;
      if (destInput) updated.destination = destInput.value;
      break;
    }
    case 'file_dialog': {
      var fpInput = editor.querySelector('.wf-se-filepath');
      var selInput = editor.querySelector('.wf-se-selector');
      var outVarInput = editor.querySelector('.wf-se-output-var');
      var delayBeforeInput = editor.querySelector('.wf-se-delay-before');
      var delayAfterInput = editor.querySelector('.wf-se-delay-after');
      if (fpInput) updated.filePath = fpInput.value;
      if (selInput) {
        if (selInput.value) {
          if (!updated.trigger) updated.trigger = {};
          updated.trigger.selector = selInput.value;
        } else {
          delete updated.trigger;
        }
      }
      if (outVarInput) updated.outputVariable = outVarInput.value || undefined;
      if (delayBeforeInput) updated.delayBeforeMs = parseInt(delayBeforeInput.value) || undefined;
      if (delayAfterInput) updated.delayAfterMs = parseInt(delayAfterInput.value) || undefined;
      break;
    }
  }

  return updated;
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

// ── Recording UI ─────────────────────────────────────────────

var recordingPollTimer = null;

function wireRecordingHandlers() {
  var startBtn = document.querySelector('#wf-btn-record-start');
  if (startBtn) {
    startBtn.addEventListener('click', startRecording);
  }

  // Recording mode toggle: Browser vs Desktop
  var modeRadios = document.querySelectorAll('input[name="wf-record-mode"]');
  modeRadios.forEach(function(radio) {
    radio.addEventListener('change', function() {
      var isDesktop = this.value === 'desktop';
      var siteField = document.querySelector('#wf-new-site');
      var siteContainer = siteField ? siteField.closest('.wf-create-field') : null;
      var hint = document.querySelector('#wf-record-hint');
      var browserOpts = document.querySelector('#wf-record-browser-options');
      var desktopAppField = document.querySelector('#wf-desktop-app-field');

      // Hide/show site input (not needed for desktop)
      if (siteContainer) siteContainer.style.display = isDesktop ? 'none' : '';

      // Show/hide desktop app name input
      if (desktopAppField) desktopAppField.style.display = isDesktop ? '' : 'none';

      // Update hint text
      if (hint) {
        hint.innerHTML = isDesktop
          ? 'Click <strong>Start Recording</strong>, then click anywhere on your screen. Each mouse click will be captured with its screen coordinates. Click <strong>Stop</strong> when done.'
          : 'Click <strong>Start Recording</strong>, then perform the actions in Chrome. Each click, keystroke, and navigation will be captured as a workflow step. Click <strong>Stop</strong> when done.';
      }

      // Hide browser-specific options for desktop mode
      if (browserOpts) browserOpts.style.display = isDesktop ? 'none' : '';
    });
  });
}

async function startRecording() {
  var nameInput = document.querySelector('#wf-new-name');
  var siteInput = document.querySelector('#wf-new-site');

  if (!nameInput) return;

  var name = nameInput.value.trim();

  // Determine recording mode
  var modeRadio = document.querySelector('input[name="wf-record-mode"]:checked');
  var isDesktopMode = modeRadio && modeRadio.value === 'desktop';
  var site = isDesktopMode ? 'desktop' : (siteInput ? siteInput.value.trim() : '');

  // Get desktop app name if in desktop mode
  var desktopAppInput = document.querySelector('#wf-desktop-app-name');
  var appName = isDesktopMode && desktopAppInput ? desktopAppInput.value.trim() : '';

  if (!name) {
    toast('Enter a workflow name first', 'error');
    nameInput.focus();
    return;
  }
  if (!isDesktopMode && !site) {
    toast('Enter the target site (e.g. suno.com)', 'error');
    if (siteInput) siteInput.focus();
    return;
  }

  // Disable inputs during recording
  nameInput.disabled = true;
  if (siteInput) siteInput.disabled = true;
  var descInput = document.querySelector('#wf-new-desc');
  if (descInput) descInput.disabled = true;
  if (desktopAppInput) desktopAppInput.disabled = true;

  // Update controls to show recording state
  var controls = document.querySelector('#wf-record-controls');
  controls.innerHTML =
    '<button class="btn-secondary wf-record-active-btn" id="wf-btn-record-pause" title="Pause">&#x23f8; Pause</button>' +
    '<button class="btn-danger" id="wf-btn-record-stop" style="font-size:0.8rem;padding:0.4rem 1rem;">&#x23f9; Stop &amp; Save</button>' +
    '<button class="btn-secondary" id="wf-btn-record-cancel" style="font-size:0.75rem;padding:0.35rem 0.75rem;">Cancel</button>';

  // Show feed
  var feed = document.querySelector('#wf-record-feed');
  feed.style.display = 'block';
  document.querySelector('#wf-record-status').innerHTML =
    '<span class="wf-rec-indicator">&#x23fa;</span> Starting...';
  document.querySelector('#wf-record-steps').innerHTML = '';

  // Hide manual create button during recording
  var saveRow = document.querySelector('#wf-manual-save-row');
  if (saveRow) saveRow.style.display = 'none';

  // Wire new buttons
  document.querySelector('#wf-btn-record-stop').addEventListener('click', stopRecording);
  document.querySelector('#wf-btn-record-pause').addEventListener('click', togglePauseRecording);
  document.querySelector('#wf-btn-record-cancel').addEventListener('click', cancelRecording);

  try {
    var captureCropsEl = document.querySelector('#wf-capture-crops');
    var captureElementCrops = captureCropsEl ? captureCropsEl.checked : true;

    var res = await fetch('/api/recording/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, site: site, captureElementCrops: captureElementCrops, appName: appName || undefined }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Start failed');

    document.querySelector('#wf-record-status').innerHTML =
      '<span class="wf-rec-indicator wf-rec-active">&#x23fa;</span> Recording — ' +
      (isDesktopMode ? ('click anywhere on screen' + (appName ? ' (' + appName + ')' : '')) : 'interact with Chrome now');

    // Start polling for captured steps
    startRecordingPoll();
  } catch (err) {
    toast('Recording failed: ' + err.message, 'error');
    resetRecordingUI();
  }
}

async function stopRecording() {
  stopRecordingPoll();
  var statusEl = document.querySelector('#wf-record-status');
  if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator">&#x23f9;</span> Saving...';

  try {
    var res = await fetch('/api/recording/stop', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Stop failed');

    toast('Workflow recorded! ' + data.stepCount + ' steps captured.', 'success');
    await fetchWorkflows();
    // Select the newly created workflow
    if (data.workflow && data.workflow.id) {
      selectWorkflow(data.workflow.id);
      // Start polling for model training (auto-triggered on recording stop)
      startWorkflowTrainingPoll(data.workflow.id);
    } else {
      initWorkflows();
    }

    // Check for new downloads detected during recording
    if (data.newDownloads && data.newDownloads.length > 0 && data.workflow && data.workflow.id) {
      showDownloadDetectionModal(data.workflow.id, data.newDownloads);
    }
  } catch (err) {
    toast('Stop failed: ' + err.message, 'error');
    resetRecordingUI();
  }
}

async function togglePauseRecording() {
  var statusRes = await fetch('/api/recording/status');
  var status = await statusRes.json();
  var isPaused = status.paused;

  try {
    var endpoint = isPaused ? '/api/recording/resume' : '/api/recording/pause';
    var res = await fetch(endpoint, { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error);

    var pauseBtn = document.querySelector('#wf-btn-record-pause');
    var statusEl = document.querySelector('#wf-record-status');

    if (isPaused) {
      if (pauseBtn) pauseBtn.innerHTML = '&#x23f8; Pause';
      if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator wf-rec-active">&#x23fa;</span> Recording';
      startRecordingPoll();
    } else {
      if (pauseBtn) pauseBtn.innerHTML = '&#x25b6; Resume';
      if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator wf-rec-paused">&#x23f8;</span> Paused';
      stopRecordingPoll();
    }
  } catch (err) {
    toast('Pause/resume failed: ' + err.message, 'error');
  }
}

async function cancelRecording() {
  stopRecordingPoll();
  try {
    await fetch('/api/recording/cancel', { method: 'POST' });
  } catch {}
  toast('Recording cancelled', 'info');
  resetRecordingUI();
}

function resetRecordingUI() {
  stopRecordingPoll();

  // Re-enable inputs
  var nameInput = document.querySelector('#wf-new-name');
  var siteInput = document.querySelector('#wf-new-site');
  var descInput = document.querySelector('#wf-new-desc');
  if (nameInput) nameInput.disabled = false;
  if (siteInput) siteInput.disabled = false;
  if (descInput) descInput.disabled = false;

  // Reset controls
  var controls = document.querySelector('#wf-record-controls');
  if (controls) {
    controls.innerHTML = '<button class="btn-save wf-record-start-btn" id="wf-btn-record-start">&#x23fa; Start Recording</button>';
    document.querySelector('#wf-btn-record-start').addEventListener('click', startRecording);
  }

  // Hide feed
  var feed = document.querySelector('#wf-record-feed');
  if (feed) feed.style.display = 'none';

  // Show manual create button
  var saveRow = document.querySelector('#wf-manual-save-row');
  if (saveRow) saveRow.style.display = '';
}

var lastStepCount = 0;

function startRecordingPoll() {
  lastStepCount = 0;
  recordingPollTimer = setInterval(pollRecordingStatus, 1000);
}

function stopRecordingPoll() {
  if (recordingPollTimer) {
    clearInterval(recordingPollTimer);
    recordingPollTimer = null;
  }
}

async function pollRecordingStatus() {
  try {
    var res = await fetch('/api/recording/status');
    var data = await res.json();
    if (!data.active) {
      stopRecordingPoll();
      return;
    }

    // Update step feed with new steps
    if (data.steps && data.steps.length > lastStepCount) {
      var stepsEl = document.querySelector('#wf-record-steps');
      if (stepsEl) {
        var newSteps = data.steps.slice(lastStepCount);
        for (var i = 0; i < newSteps.length; i++) {
          var s = newSteps[i];
          var icon = STEP_ICONS[s.type] || '&#x25cf;';
          var stepHtml = '<div class="wf-record-step-item">' +
            '<span class="wf-step-num">' + (s.index + 1) + '</span>' +
            '<span class="wf-step-icon">' + icon + '</span>' +
            '<span class="wf-step-label">' + escHtml(s.label) + '</span>' +
            '<span class="wf-step-type">' + escHtml(s.type) + '</span>' +
            '</div>';
          stepsEl.innerHTML += stepHtml;
        }
        // Auto-scroll to bottom
        stepsEl.scrollTop = stepsEl.scrollHeight;
        lastStepCount = data.steps.length;
      }

      // Update status with step count
      var statusEl = document.querySelector('#wf-record-status');
      if (statusEl && !data.paused) {
        var dur = Math.round(data.durationMs / 1000);
        statusEl.innerHTML =
          '<span class="wf-rec-indicator wf-rec-active">&#x23fa;</span> Recording — ' +
          data.stepCount + ' steps &middot; ' + dur + 's';
      }
    }
  } catch {}
}

function buildStepLabel(step, idx) {
  switch (step.type) {
    case 'navigate': return 'Navigate to ' + (step.url || 'URL');
    case 'click': return 'Click ' + ((step.target && step.target.textContent) || (step.target && step.target.selector) || 'element');
    case 'type': return 'Type "' + truncate(step.value || '', 30) + '"';
    case 'wait': return step.condition && step.condition.type === 'delay' ? 'Wait ' + (step.condition.ms || 0) + 'ms' : 'Wait for element';
    case 'keyboard': return 'Press ' + (step.modifiers && step.modifiers.length ? step.modifiers.join('+') + '+' : '') + (step.key || 'key');
    case 'scroll': return 'Scroll';
    case 'assert': return 'Assert ' + ((step.target && step.target.selector) || 'element');
    case 'set_variable': return 'Set ' + (step.variable || 'variable');
    case 'file_dialog': return 'Select file ' + truncate(step.filePath || '', 40);
    case 'capture_download': return 'Capture download';
    case 'move_file': return 'Move ' + truncate(step.source || 'file', 25);
    default: return 'Step ' + (idx + 1);
  }
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

  // Store context for delegated handlers
  _wfCurrentDetail = { wf: wf, filePath: filePath, source: source };

  const main = document.querySelector('#main');
  let html = '';

  // Header row: title + delete
  html += '<div class="wf-detail-header">';
  html += '<div style="min-width:0;">';
  html += '<h2>' + escHtml(wf.name) + '</h2>';
  html += '<div class="wf-detail-meta">';
  html += escHtml(wf.description || '') + '<br>';
  html += '<code style="color:#475569;font-size:0.7rem;">' + escHtml(filePath) + '</code>';
  html += '</div>';
  html += '</div>';
  html += '<div class="wf-detail-actions">';
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

// ── Visual View ──────────────────────────────────────────────

function renderVisualView(wf, source) {
  var html = '';

  // Info bar
  html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">';
  html += infoChip('Site', wf.site || 'unknown');
  html += infoChip('Steps', String(wf.steps.length));
  html += infoChip('Variables', String((wf.variables || []).length));
  var smartCount = wf.steps.filter(function(s) { return s.type === 'wait' && s.condition && s.condition.type !== 'delay'; }).length;
  if (smartCount > 0) html += infoChip('Smart Waits', String(smartCount), '#10b981');
  html += infoChip('Source', source);
  if (wf.metadata && wf.metadata.createdAt) {
    var d = new Date(wf.metadata.createdAt);
    html += infoChip('Created', d.toLocaleDateString());
  }
  // Model status chip
  if (wf.metadata && wf.metadata.trainingStatus === 'complete') {
    var _verStr = wf.metadata.modelVersion ? 'v' + wf.metadata.modelVersion + ' ' : '';
    html += infoChip('Model', _verStr + '(AUC ' + ((wf.metadata.trainingRun && wf.metadata.trainingRun.bestAuc) || 0).toFixed(3) + ')', '#10b981');
  } else if (wf.metadata && (wf.metadata.trainingStatus === 'training' || wf.metadata.trainingStatus === 'pending')) {
    html += infoChip('Model', 'Training...', '#c4b5fd');
  } else if (wf.metadata && wf.metadata.trainingStatus === 'failed') {
    html += infoChip('Model', 'Failed', '#ef4444');
  }
  html += '</div>';

  // Variables section
  if (wf.variables && wf.variables.length > 0) {
    html += '<div class="wf-section">';
    html += '<div class="wf-section-header">Variables (' + wf.variables.length + ')' + helpIcon('workflows-variables') + '</div>';
    html += '<div class="wf-section-body">';
    for (var i = 0; i < wf.variables.length; i++) {
      var v = wf.variables[i];
      html += '<div class="wf-var-row">';
      html += '<span class="wf-var-name wf-var-rename" data-var-name="' + escAttr(v.name) + '" title="Click to rename">';
      html += escHtml(v.name);
      html += '<span class="wf-var-rename-icon">&#x270E;</span>';
      html += '</span>';
      html += '<span class="wf-var-desc">' + escHtml(v.description || '') + '</span>';
      html += v.required
        ? '<span class="badge badge-missing" style="font-size:0.6rem;">required</span>'
        : '<span class="badge badge-partial" style="font-size:0.6rem;">optional</span>';
      if (v.default !== undefined && v.default !== null) {
        html += '<span class="wf-var-default" title="' + escAttr(String(v.default)) + '">';
        html += 'default: ' + escHtml(truncate(String(v.default), 30));
        html += '</span>';
      }
      if (v.generationPrompt) {
        html += '<span class="wf-var-prompt-badge" data-var-idx="' + i + '" title="' + escAttr(v.generationPrompt) + '">\u{1F916} AI</span>';
      } else {
        html += '<span class="wf-var-prompt-badge wf-var-prompt-add" data-var-idx="' + i + '" title="Add AI generation prompt">+ \u{1F916}</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  // Steps section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Steps (' + wf.steps.length + ')' + helpIcon('workflows-steps') + '</div>';
  html += '<div class="wf-section-body">';
  for (var i = 0; i < wf.steps.length; i++) {
    var step = wf.steps[i];
    var icon = STEP_ICONS[step.type] || '&#x25cf;';
    var isSmart = step.type === 'wait' && step.condition && step.condition.type !== 'delay';

    html += '<div class="wf-step" data-step-idx="' + i + '">';
    html += '<span class="wf-step-num">' + (i + 1) + '</span>';
    html += '<span class="wf-step-icon">' + icon + '</span>';
    html += '<span class="wf-step-label">' + escHtml(step.label || step.id) + '</span>';
    html += '<span class="wf-step-type">' + escHtml(step.type) + '</span>';
    if (isSmart) {
      html += '<span class="wf-step-smart">smart</span>';
    }
    html += '<span class="wf-step-expand">&#x25BC;</span>';
    html += '</div>';
    // Inline editor panel (collapsed by default)
    html += '<div class="wf-step-editor" data-step-idx="' + i + '" style="display:none;">';
    html += renderStepEditor(step, i, wf.steps.length);
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  // Metadata
  if (wf.metadata) {
    html += '<div class="wf-section">';
    html += '<div class="wf-section-header">Metadata</div>';
    html += '<div class="wf-section-body" style="font-size:0.75rem;color:#64748b;">';
    if (wf.metadata.createdAt) html += 'Created: ' + escHtml(wf.metadata.createdAt) + '<br>';
    if (wf.metadata.updatedAt) html += 'Updated: ' + escHtml(wf.metadata.updatedAt) + '<br>';
    if (wf.metadata.recordedBy) html += 'Recorded by: ' + escHtml(wf.metadata.recordedBy) + '<br>';
    html += '</div>';
    html += '</div>';
  }

  return html;
}

// ── Model View ──────────────────────────────────────────────

function renderModelView(wf) {
  var html = '';
  var ts = wf.metadata && wf.metadata.trainingStatus;
  var tr = wf.metadata && wf.metadata.trainingRun;

  // Live training status container (populated by polling)
  html += '<div id="wf-training-status"></div>';

  // Current model status section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Model Status' + helpIcon('workflows-model') + '</div>';
  html += '<div class="wf-section-body">';

  if (ts === 'complete') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x2705;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#6ee7b7;">Model Ready</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">Visual verification enabled for this workflow</div>';
    html += '</div>';
    html += '</div>';

    // Version badge
    if (wf.metadata.modelVersion) {
      html += '<div style="margin-bottom:0.75rem;">';
      html += infoChip('Active Version', 'v' + escHtml(wf.metadata.modelVersion), '#6ee7b7');
      html += '</div>';
    }

    // Quality gate result for last training run
    if (tr && tr.version && tr.promoted === false) {
      html += '<div style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.75rem;font-size:0.75rem;">';
      html += '<span style="color:#c4b5fd;font-weight:600;">Quality Gate:</span> ';
      html += '<span style="color:#fbbf24;">v' + escHtml(tr.version) + ' was trained but not promoted</span> ';
      html += '<span style="color:#94a3b8;">(AUC ' + (tr.bestAuc || 0).toFixed(4) + ' &lt; active version)</span>';
      html += '</div>';
    }

    // Stats
    html += '<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;">';
    if (tr && tr.bestAuc) {
      html += infoChip('Best AUC', tr.bestAuc.toFixed(4), '#10b981');
    }
    if (tr && tr.epochs) {
      html += infoChip('Epochs', String(tr.epochs));
    }
    if (tr && tr.completedAt) {
      var d = new Date(tr.completedAt);
      html += infoChip('Trained', d.toLocaleDateString() + ' ' + d.toLocaleTimeString());
    }
    if (tr && tr.worker) {
      html += infoChip('Worker', tr.worker, '#c4b5fd');
    }
    if (tr && tr.version) {
      html += infoChip('Last Version', 'v' + escHtml(tr.version));
    }
    html += '</div>';

    // Model path
    if (wf.metadata.modelPath) {
      html += '<div style="font-size:0.7rem;color:#475569;font-family:monospace;word-break:break-all;">';
      html += escHtml(wf.metadata.modelPath);
      html += '</div>';
    }

  } else if (ts === 'failed') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x274c;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#fca5a5;">Training Failed</div>';
    if (tr && tr.error) {
      html += '<div style="font-size:0.75rem;color:#ef4444;word-break:break-word;">' + escHtml(tr.error) + '</div>';
    }
    html += '</div>';
    html += '</div>';

  } else if (ts === 'training' || ts === 'pending') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
    html += '<span style="font-size:1.5rem;" class="wf-training-pulse">&#x1f9e0;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#c4b5fd;">Training in Progress</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">Model training will appear above when status updates</div>';
    html += '</div>';
    html += '</div>';

  } else {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x1f6ab;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#94a3b8;">No Model</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">This workflow has no trained model. Visual verification is not available.</div>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  html += '</div>';

  // Training Data section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Training Data</div>';
  html += '<div class="wf-section-body">';
  html += '<div id="wf-training-data-stats"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  // Training controls section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Training</div>';
  html += '<div class="wf-section-body">';

  html += '<div style="font-size:0.78rem;color:#94a3b8;margin-bottom:1rem;">';
  html += 'Train a visual verification model from the element screenshots captured during this workflow\'s recording. ';
  html += 'If a remote GPU worker is available, training will be dispatched there automatically.';
  html += '</div>';

  // Configuration form (compact)
  html += '<div class="wf-model-config">';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Architecture</label>';
  html += '<select id="wf-model-backbone" class="wf-model-select">';
  html += '<option value="mobilenet_v3_small">MobileNet V3 Small (fastest)</option>';
  html += '<option value="efficientnet_b0" selected>EfficientNet B0 (balanced)</option>';
  html += '<option value="resnet18">ResNet-18 (most robust)</option>';
  html += '</select>';
  html += '</div>';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Epochs</label>';
  html += '<input type="number" id="wf-model-epochs" class="wf-model-input" value="150" min="10" max="500">';
  html += '</div>';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Embedding Dim</label>';
  html += '<select id="wf-model-embed-dim" class="wf-model-select">';
  html += '<option value="64">64</option>';
  html += '<option value="128" selected>128</option>';
  html += '<option value="256">256</option>';
  html += '</select>';
  html += '</div>';

  html += '</div>'; // end config

  // Action buttons
  html += '<div style="display:flex;gap:0.75rem;margin-top:1rem;flex-wrap:wrap;">';

  if (ts === 'training' || ts === 'pending') {
    html += '<button class="btn-secondary" disabled style="opacity:0.5;font-size:0.8rem;padding:0.5rem 1.25rem;">Training in progress...</button>';
  } else if (ts === 'complete') {
    html += '<button class="btn-secondary" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f504; Retrain Model</button>';
  } else if (ts === 'failed') {
    html += '<button class="btn-save" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f504; Retry Training</button>';
  } else {
    html += '<button class="btn-save" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f9e0; Train Model</button>';
  }

  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Version History section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Version History</div>';
  html += '<div class="wf-section-body">';
  html += '<div id="wf-version-history"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  // Workers section (compact)
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Workers</div>';
  html += '<div class="wf-section-body">';
  html += '<div style="font-size:0.78rem;color:#94a3b8;margin-bottom:0.75rem;">';
  html += 'Remote GPU workers for faster training. Workers are auto-detected on the local network.';
  html += '</div>';
  html += '<div id="wf-workers-list"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  return html;
}

function wireModelViewHandlers(wf) {
  // Retrain button
  var retrainBtn = document.getElementById('wf-btn-retrain');
  if (retrainBtn) {
    retrainBtn.addEventListener('click', async function() {
      retrainBtn.disabled = true;
      retrainBtn.textContent = 'Starting...';
      try {
        // Read config from the form
        var configBody = {};
        var backboneEl = document.getElementById('wf-model-backbone');
        var epochsEl = document.getElementById('wf-model-epochs');
        var embedDimEl = document.getElementById('wf-model-embed-dim');
        if (backboneEl) configBody.backbone = backboneEl.value;
        if (epochsEl) configBody.epochs = parseInt(epochsEl.value, 10);
        if (embedDimEl) configBody.embedDim = parseInt(embedDimEl.value, 10);

        var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/training/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configBody),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to start training');
        toast('Training started', 'success');
        startWorkflowTrainingPoll(wf.id);
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
        retrainBtn.disabled = false;
        retrainBtn.textContent = '\u{1f504} Retry Training';
      }
    });
  }

  // Load workers list, version history, and training data stats
  loadModelViewWorkers();
  loadVersionHistory(wf.id);
  loadTrainingDataStats(wf.id);
}

async function loadModelViewWorkers() {
  var listEl = document.getElementById('wf-workers-list');
  if (!listEl) return;

  try {
    var res = await fetch('/api/workers');
    var data = await res.json();
    var workers = data.workers || [];

    if (workers.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">No workers configured. Training will run locally. Workers are auto-discovered on the local network, or add one from the Training tab.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < workers.length; i++) {
      var w = workers[i];
      var statusColor = w.online ? (w.status === 'busy' ? '#f59e0b' : '#10b981') : '#64748b';
      var statusText = w.online ? (w.status === 'busy' ? 'busy' : 'idle') : 'offline';
      var gpuInfo = w.gpu ? escHtml(w.gpu) : 'CPU';

      html += '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.4rem 0;border-bottom:1px solid #1e293b;font-size:0.75rem;">';
      html += '<span style="color:' + statusColor + ';font-size:0.8rem;">&#x25cf;</span>';
      html += '<div style="flex:1;">';
      html += '<span style="font-weight:600;color:#e2e8f0;">' + escHtml(w.name) + '</span>';
      html += ' <span style="color:#64748b;">' + escHtml(w.host) + ':' + w.port + ' &middot; ' + gpuInfo + '</span>';
      html += '</div>';
      html += '<span style="font-size:0.65rem;color:' + statusColor + ';font-weight:600;text-transform:uppercase;">' + statusText + '</span>';
      html += '</div>';
    }

    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load workers</div>';
  }
}

// ── Version History ──────────────────────────────────────────

function compareSemVerJS(a, b) {
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function loadVersionHistory(workflowId) {
  var container = document.getElementById('wf-version-history');
  if (!container) return;

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/model/versions');
    var data = await res.json();
    var versions = data.versions || [];

    if (versions.length === 0) {
      container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">No model versions yet. Train a model to create the first version.</div>';
      return;
    }

    var activeVersion = data.activeVersion;

    // Sort descending (newest first)
    versions.sort(function(a, b) {
      return compareSemVerJS(b.version, a.version);
    });

    var html = '<table class="wf-version-table">';
    html += '<thead><tr>';
    html += '<th>Version</th>';
    html += '<th>AUC</th>';
    html += '<th>Backbone</th>';
    html += '<th>Epochs</th>';
    html += '<th>Trained</th>';
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < versions.length; i++) {
      var v = versions[i];
      var isActive = v.version === activeVersion;
      var isFailed = v.status === 'failed';
      var rowClass = isActive ? ' wf-version-active' : (isFailed ? ' wf-version-failed' : '');

      html += '<tr class="wf-version-row' + rowClass + '">';

      // Version column
      html += '<td class="wf-version-cell-version">';
      html += 'v' + escHtml(v.version);
      if (isActive) html += ' <span class="wf-version-badge-active">ACTIVE</span>';
      if (isFailed) html += ' <span class="wf-version-badge-failed">FAILED</span>';
      html += '</td>';

      // AUC column
      var aucColor = isFailed ? '#64748b' : (v.bestAuc >= 0.95 ? '#6ee7b7' : (v.bestAuc >= 0.90 ? '#fbbf24' : '#f87171'));
      html += '<td style="color:' + aucColor + ';font-weight:600;">' + (isFailed ? '-' : v.bestAuc.toFixed(4)) + '</td>';

      // Backbone column
      var bbShort = (v.backbone || '').replace('mobilenet_v3_small', 'MNv3').replace('efficientnet_b0', 'EffB0').replace('resnet18', 'RN18');
      html += '<td style="color:#94a3b8;">' + escHtml(bbShort) + '</td>';

      // Epochs column
      html += '<td style="color:#94a3b8;">' + (v.epochs || '-') + '</td>';

      // Trained date column
      var d = new Date(v.trainedAt);
      html += '<td style="color:#64748b;">' + d.toLocaleDateString() + '</td>';

      // Action column
      html += '<td>';
      if (!isActive && !isFailed) {
        html += '<button class="btn-secondary wf-version-activate" data-version="' + escHtml(v.version) + '" style="font-size:0.6rem;padding:0.2rem 0.5rem;">Activate</button>';
      }
      html += '</td>';

      html += '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Wire up activate buttons
    container.querySelectorAll('.wf-version-activate').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var version = btn.getAttribute('data-version');
        btn.disabled = true;
        btn.textContent = 'Activating...';
        try {
          var aRes = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/model/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: version }),
          });
          var aData = await aRes.json();
          if (!aRes.ok) throw new Error(aData.error || 'Activation failed');
          toast('Activated v' + version, 'success');
          selectWorkflow(workflowId);
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Activate';
        }
      });
    });

  } catch (err) {
    container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load version history</div>';
  }
}

// ── Training Data Stats ──────────────────────────────────────

async function loadTrainingDataStats(workflowId) {
  var container = document.getElementById('wf-training-data-stats');
  if (!container) return;

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/training/data');
    var data = await res.json();
    var snap = data.snapshots;
    var crops = data.crops;
    var last = data.lastTraining;
    var html = '';

    // Snapshots stats
    html += '<div class="wf-td-section">';
    html += '<div class="wf-td-title">Snapshots</div>';
    if (snap.total === 0) {
      html += '<div class="wf-td-empty">No snapshots yet. Record a workflow or run it successfully to collect training data.</div>';
    } else {
      html += '<div class="wf-td-grid">';
      html += tdStat(snap.total, 'Snapshots', '#e2e8f0');
      html += tdStat(snap.fromRecording, 'From Recording', '#c4b5fd');
      html += tdStat(snap.fromExecution, 'From Runs', '#6ee7b7');
      html += tdStat(snap.totalElements, 'Elements', '#94a3b8');
      html += tdStat(snap.uniqueSelectors, 'Unique Selectors', '#94a3b8');
      html += tdStat(snap.interactedSelectors, 'Interacted', '#fbbf24');
      html += '</div>';
    }
    html += '</div>';

    // Crops stats (only if data has been prepared)
    if (crops) {
      html += '<div class="wf-td-section">';
      html += '<div class="wf-td-title">Prepared Crops</div>';
      html += '<div class="wf-td-grid">';
      html += tdStat(crops.total, 'Total Crops', '#e2e8f0');
      html += tdStat(crops.uniqueGroups, 'Groups', '#94a3b8');
      html += tdStat(crops.interacted, 'Positive', '#6ee7b7');
      html += tdStat(crops.nonInteracted, 'Negative', '#94a3b8');
      html += '</div>';
      html += '</div>';
    }

    // Last training run info
    if (last) {
      html += '<div class="wf-td-section">';
      html += '<div class="wf-td-title">Last Training (v' + escHtml(last.version) + ')</div>';
      html += '<div class="wf-td-grid">';
      var bbShort = (last.backbone || '').replace('mobilenet_v3_small', 'MobileNet V3').replace('efficientnet_b0', 'EfficientNet B0').replace('resnet18', 'ResNet-18');
      html += tdStat(bbShort, 'Backbone', '#c4b5fd');
      html += tdStat(last.epochs, 'Epochs', '#94a3b8');
      html += tdStat(last.embedDim, 'Embed Dim', '#94a3b8');
      html += tdStat(last.bestAuc.toFixed(4), 'Best AUC', last.bestAuc >= 0.95 ? '#6ee7b7' : (last.bestAuc >= 0.90 ? '#fbbf24' : '#f87171'));
      html += tdStat(last.cropsPerElement + 'x', 'Crops/Element', '#94a3b8');
      var d = new Date(last.trainedAt);
      html += tdStat(d.toLocaleDateString(), 'Trained', '#64748b');
      html += '</div>';
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load training data stats</div>';
  }
}

function tdStat(value, label, color) {
  return '<div class="wf-td-stat">' +
    '<div class="wf-td-stat-value" style="color:' + (color || '#e2e8f0') + ';">' + value + '</div>' +
    '<div class="wf-td-stat-label">' + escHtml(label) + '</div>' +
    '</div>';
}

// ── JSON View ────────────────────────────────────────────────

function renderJsonView(wf) {
  var html = '';
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">JSON Editor</div>';
  html += '<div class="wf-section-body">';
  html += '<textarea class="wf-json-editor" id="wf-json-editor">' + escHtml(JSON.stringify(wf, null, 2)) + '</textarea>';
  html += '</div>';
  html += '</div>';
  html += '<div class="save-row">';
  html += '<button class="btn-save" id="wf-btn-save-json">Save JSON</button>';
  html += '<span class="save-status" id="wf-save-status"></span>';
  html += '</div>';
  return html;
}

// ── Run View (Dynamic Variable Inputs + Pipeline) ────────────

function renderRunView(wf) {
  var html = '';

  // Workflow info
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">&#x25b6; Run Workflow: ' + escHtml(wf.name) + helpIcon('workflows-run') + '</div>';
  html += '<div class="wf-section-body">';

  var isDesktopWf = wf.site === 'desktop';
  html += '<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:1rem;">';
  html += escHtml(wf.description || 'No description') + '<br>';
  html += '<span style="color:#64748b;">' + (isDesktopWf ? 'Desktop App' : 'Site: ' + escHtml(wf.site || 'any')) + ' &middot; ' + wf.steps.length + ' steps</span>';
  html += '</div>';

  if (isDesktopWf) {
    html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:0.75rem;margin-bottom:1rem;font-size:0.78rem;color:#94a3b8;">';
    html += '<strong style="color:#7dd3fc;">Desktop workflow</strong> — this will control your mouse and keyboard to automate native applications. Make sure the target app is visible on screen before running.';
    html += '</div>';
  }

  // Variable input form (dynamic per workflow)
  if (wf.variables && wf.variables.length > 0) {
    html += '<div style="margin-bottom:1.25rem;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">';
    html += '<div style="font-size:0.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Variables</div>';
    html += '<button class="btn-secondary" id="wf-btn-autofill" style="font-size:0.7rem;padding:0.3rem 0.75rem;" title="Generate sample values for all empty variables">&#x2728; Auto-fill</button>';
    html += '</div>';

    for (var i = 0; i < wf.variables.length; i++) {
      var v = wf.variables[i];
      html += '<div class="wf-run-var" style="margin-bottom:0.75rem;">';
      html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">';
      html += '<label style="font-family:monospace;font-size:0.8rem;font-weight:600;color:#06b6d4;" for="wf-run-var-' + escAttr(v.name) + '">' + escHtml(v.name) + '</label>';
      html += v.required
        ? '<span class="badge badge-missing" style="font-size:0.55rem;">required</span>'
        : '<span class="badge badge-partial" style="font-size:0.55rem;">optional</span>';
      html += '</div>';

      if (v.description) {
        html += '<div style="font-size:0.7rem;color:#64748b;margin-bottom:0.25rem;">' + escHtml(v.description) + '</div>';
      }

      // Input type based on variable type / name
      var inputType = 'text';
      var isTextarea = false;
      var placeholder = v.default !== undefined ? String(v.default) : 'Enter value...';

      // Heuristics for input type
      var nameLower = v.name.toLowerCase();
      if (nameLower.includes('text') || nameLower.includes('caption') || nameLower.includes('content') || nameLower.includes('lyrics') || nameLower.includes('description')) {
        isTextarea = true;
      } else if (nameLower.includes('path') || nameLower.includes('file') || nameLower.includes('dir')) {
        placeholder = '/path/to/file';
      } else if (nameLower.includes('url') || nameLower.includes('link')) {
        inputType = 'url';
        placeholder = 'https://...';
      } else if (nameLower.includes('count') || nameLower.includes('number') || nameLower.includes('amount')) {
        inputType = 'number';
      }

      var savedVal = getRunVarValue(wf.id, v.name, v.default !== undefined ? String(v.default) : '');

      if (isTextarea) {
        html += '<textarea class="wf-var-input wf-run-input" id="wf-run-var-' + escAttr(v.name) + '" name="' + escAttr(v.name) + '"';
        html += ' placeholder="' + escAttr(placeholder) + '"';
        html += ' style="min-height:80px;resize:vertical;">';
        html += escHtml(savedVal);
        html += '</textarea>';
      } else {
        html += '<input class="wf-var-input wf-run-input" type="' + inputType + '" id="wf-run-var-' + escAttr(v.name) + '" name="' + escAttr(v.name) + '"';
        html += ' value="' + escAttr(savedVal) + '"';
        html += ' placeholder="' + escAttr(placeholder) + '">';
      }

      // Per-variable AI generate button
      if (v.generationPrompt) {
        html += '<button class="wf-var-gen-btn" data-var-name="' + escAttr(v.name) + '" title="' + escAttr(v.generationPrompt) + '">\u{1F916} Generate</button>';
      }

      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div style="font-size:0.8rem;color:#64748b;margin-bottom:1rem;">This workflow has no variables — it runs with no inputs needed.</div>';
  }

  html += '</div>';
  html += '</div>';

  // Pipeline section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">&#x1f517; Pipeline (Chain Workflows)</div>';
  html += '<div class="wf-section-body">';
  html += '<div style="font-size:0.75rem;color:#64748b;margin-bottom:0.75rem;">Add more workflows to run in sequence after this one. Variables flow forward between steps.</div>';

  html += '<div id="wf-pipeline-list">';
  // Pipeline step 0 is always the current workflow
  html += '<div class="wf-pipeline-step" style="opacity:0.7;">';
  html += '<span class="wf-pipeline-step-num">1</span>';
  html += '<span class="wf-pipeline-step-name">' + escHtml(wf.name) + '</span>';
  html += '<span class="badge badge-ok" style="font-size:0.55rem;">current</span>';
  html += '</div>';
  html += '</div>';

  // Add to pipeline button
  html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;">';
  html += '<select id="wf-pipeline-add-select" style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:4px;padding:0.4rem 0.6rem;color:#e2e8f0;font-size:0.75rem;">';
  html += '<option value="">Add workflow to pipeline...</option>';
  for (var i = 0; i < workflows.length; i++) {
    var w = workflows[i];
    if (w.id !== wf.id) {
      html += '<option value="' + escAttr(w.id) + '">' + escHtml(w.name) + ' (' + w.stepCount + ' steps)</option>';
    }
  }
  html += '</select>';
  html += '<button class="btn-secondary" id="wf-pipeline-add-btn" style="font-size:0.75rem;padding:0.4rem 0.75rem;">+ Add</button>';
  html += '</div>';

  html += '</div>';
  html += '</div>';

  // Run + Debug buttons
  html += '<div class="save-row" style="gap:0.75rem;">';
  html += '<button class="btn-save wf-run-btn" id="wf-btn-run" style="background:#10b981;">&#x25b6; ' + (isDesktopWf ? 'Run Desktop Workflow' : 'Run Workflow') + '</button>';
  html += '<button class="btn-save wf-debug-btn" id="wf-btn-debug" style="background:#3b82f6;">&#x1f50d; Debug</button>';
  html += '<span class="save-status" id="wf-run-status"></span>';
  html += '</div>';

  // Run output area
  html += '<div id="wf-run-output" style="display:none;margin-top:1rem;"></div>';

  return html;
}

// ── Pipeline Rendering ───────────────────────────────────────

function renderPipelineList(currentWf) {
  var listEl = document.querySelector('#wf-pipeline-list');
  if (!listEl) return;

  var html = '';

  // First step is always current workflow
  html += '<div class="wf-pipeline-step" style="opacity:0.7;">';
  html += '<span class="wf-pipeline-step-num">1</span>';
  html += '<span class="wf-pipeline-step-name">' + escHtml(currentWf.name) + '</span>';
  html += '<span class="badge badge-ok" style="font-size:0.55rem;">current</span>';
  html += '</div>';

  for (var i = 0; i < pipelineWorkflows.length; i++) {
    var pw = pipelineWorkflows[i];
    var wfInfo = workflows.find(function(w) { return w.id === pw.id; });
    html += '<div class="wf-pipeline-step">';
    html += '<span class="wf-pipeline-step-num">' + (i + 2) + '</span>';
    html += '<span class="wf-pipeline-step-name">' + escHtml(wfInfo ? wfInfo.name : pw.id) + '</span>';
    html += '<span style="font-size:0.65rem;color:#64748b;">' + (wfInfo ? wfInfo.stepCount + ' steps' : '') + '</span>';
    html += '<button class="wf-pipeline-remove" data-idx="' + i + '" title="Remove" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;padding:0 0.25rem;">&#x2715;</button>';
    html += '</div>';
  }

  listEl.innerHTML = html;

  // Wire remove buttons
  listEl.querySelectorAll('.wf-pipeline-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.dataset.idx);
      pipelineWorkflows.splice(idx, 1);
      renderPipelineList(currentWf);
    });
  });
}

// ── Event Wiring ─────────────────────────────────────────────

function wireUpHandlers(wf, filePath, source) {
  // Tab clicks are handled by delegated listener in initWorkflowDelegation()

  // Delete
  var deleteBtn = document.querySelector('#wf-btn-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async function() {
      if (!confirm('Delete workflow "' + wf.name + '"? This cannot be undone.')) return;
      try {
        await deleteWorkflow(wf.id);
        toast('Workflow deleted', 'success');
        selectedWorkflow = null;
        initWorkflows();
      } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
      }
    });
  }

  // JSON save
  var saveJsonBtn = document.querySelector('#wf-btn-save-json');
  if (saveJsonBtn) {
    saveJsonBtn.addEventListener('click', async function() {
      var editor = document.querySelector('#wf-json-editor');
      var statusEl = document.querySelector('#wf-save-status');
      if (!editor) return;

      var parsed;
      try {
        parsed = JSON.parse(editor.value);
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'error');
        return;
      }

      saveJsonBtn.disabled = true;
      statusEl.textContent = 'Saving...';

      try {
        await saveWorkflow(wf.id, parsed);
        toast('Workflow saved', 'success');
        statusEl.textContent = 'Saved!';
        setTimeout(function() { statusEl.textContent = ''; }, 2000);
        await fetchWorkflows();
        selectWorkflow(wf.id);
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
        statusEl.textContent = '';
      } finally {
        saveJsonBtn.disabled = false;
      }
    });
  }

  // Pipeline add
  var pipelineAddBtn = document.querySelector('#wf-pipeline-add-btn');
  if (pipelineAddBtn) {
    pipelineAddBtn.addEventListener('click', function() {
      var select = document.querySelector('#wf-pipeline-add-select');
      if (!select || !select.value) return;
      pipelineWorkflows.push({ id: select.value });
      select.value = '';
      renderPipelineList(wf);
    });
  }

  // Render initial pipeline list
  if (detailView === 'run') {
    renderPipelineList(wf);
  }

  // Model view handlers
  if (detailView === 'model') {
    wireModelViewHandlers(wf);
  }

  // Run button
  var runBtn = document.querySelector('#wf-btn-run');
  if (runBtn) {
    runBtn.addEventListener('click', function() {
      runWorkflow(wf);
    });
  }

  // Debug button
  var debugBtn = document.querySelector('#wf-btn-debug');
  if (debugBtn) {
    debugBtn.addEventListener('click', function() {
      startDebugMode(wf);
    });
  }

  // Auto-fill button
  var autofillBtn = document.querySelector('#wf-btn-autofill');
  if (autofillBtn) {
    autofillBtn.addEventListener('click', function() {
      autoFillVariables(wf);
    });
  }

  // Variable rename — click variable name to edit inline
  document.querySelectorAll('.wf-var-rename').forEach(function(el) {
    el.addEventListener('click', function() {
      var oldName = el.getAttribute('data-var-name');
      if (!oldName) return;

      // Replace span with inline input
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'wf-var-rename-input';
      input.value = oldName;
      el.replaceWith(input);
      input.focus();
      input.select();

      var submitted = false;
      async function doRename() {
        if (submitted) return;
        submitted = true;
        var newName = input.value.trim();
        if (!newName || newName === oldName) {
          // Cancelled — re-render
          selectWorkflow(selectedWorkflow);
          return;
        }
        try {
          var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/rename-variable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldName: oldName, newName: newName }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Rename failed');
          toast('Renamed ' + oldName + ' \u2192 ' + newName, 'success');
          await fetchWorkflows();
          selectWorkflow(selectedWorkflow);
        } catch (err) {
          toast('Rename failed: ' + err.message, 'error');
          selectWorkflow(selectedWorkflow);
        }
      }

      input.addEventListener('blur', doRename);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { submitted = true; selectWorkflow(selectedWorkflow); }
      });
    });
  });

  // AI generation prompt badge — click to edit prompt inline (visual view)
  document.querySelectorAll('.wf-var-prompt-badge').forEach(function(badge) {
    badge.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = parseInt(badge.getAttribute('data-var-idx'));
      if (isNaN(idx) || !wf.variables || !wf.variables[idx]) return;
      var v = wf.variables[idx];
      var row = badge.closest('.wf-var-row');
      if (!row) return;

      // Check if editor already open
      if (row.querySelector('.wf-var-prompt-editor-wrap')) return;

      // Create inline editor below the row
      var wrap = document.createElement('div');
      wrap.className = 'wf-var-prompt-editor-wrap';
      wrap.style.cssText = 'margin-top:0.35rem;display:flex;flex-direction:column;gap:0.35rem;width:100%;';

      var textarea = document.createElement('textarea');
      textarea.className = 'wf-var-prompt-editor';
      textarea.value = v.generationPrompt || '';
      textarea.placeholder = 'Describe what to generate for "' + v.name + '"...';

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:0.4rem;justify-content:flex-end;';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'btn-secondary';
      cancelBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;';

      var saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save Prompt';
      saveBtn.className = 'btn-primary';
      saveBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;';

      var removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove Prompt';
      removeBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;background:none;color:#ef4444;border:1px solid #ef4444;border-radius:4px;cursor:pointer;margin-right:auto;';

      btnRow.appendChild(removeBtn);
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(saveBtn);
      wrap.appendChild(textarea);
      wrap.appendChild(btnRow);
      row.appendChild(wrap);
      textarea.focus();

      cancelBtn.addEventListener('click', function() { wrap.remove(); });

      async function savePrompt(newPrompt) {
        // Update the variable in the workflow and save
        var updatedWf = JSON.parse(JSON.stringify(wf));
        if (newPrompt) {
          updatedWf.variables[idx].generationPrompt = newPrompt;
        } else {
          delete updatedWf.variables[idx].generationPrompt;
        }
        try {
          var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow: updatedWf }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Save failed');
          toast(newPrompt ? 'AI prompt saved' : 'AI prompt removed', 'success');
          await fetchWorkflows();
          selectWorkflow(selectedWorkflow);
        } catch (err) {
          toast('Save failed: ' + err.message, 'error');
        }
      }

      saveBtn.addEventListener('click', function() { savePrompt(textarea.value.trim()); });
      removeBtn.addEventListener('click', function() { savePrompt(''); });
    });
  });

  // Per-variable AI generate button (run view)
  document.querySelectorAll('.wf-var-gen-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var varName = btn.getAttribute('data-var-name');
      if (!varName) return;
      var v = (wf.variables || []).find(function(x) { return x.name === varName; });
      if (!v || !v.generationPrompt) return;

      var inputEl = document.querySelector('#wf-run-var-' + CSS.escape(varName));
      if (!inputEl) return;

      var origHtml = btn.innerHTML;
      btn.innerHTML = '\u23F3';
      btn.disabled = true;

      fetch('/api/generate-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variableName: v.name,
          generationPrompt: v.generationPrompt,
          workflowName: wf.name,
          site: wf.site,
          variableType: v.type,
        }),
      })
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success && data.value !== undefined) {
          inputEl.value = String(data.value);
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          toast('Generated value for ' + varName, 'success');
        } else {
          throw new Error(data.error || 'Generation failed');
        }
      })
      .catch(function(err) {
        toast('Generate failed: ' + err.message, 'error');
      })
      .finally(function() {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      });
    });
  });

  // ── Step editor expand/collapse + actions ─────────────────
  var container = document.querySelector('#wf-detail-content') || document;

  container.querySelectorAll('.wf-step[data-step-idx]').forEach(function(row) {
    row.addEventListener('click', function(e) {
      // Don't toggle if clicking inside an editor
      if (e.target.closest('.wf-step-editor')) return;
      var idx = parseInt(row.getAttribute('data-step-idx'));
      var editor = container.querySelector('.wf-step-editor[data-step-idx="' + idx + '"]');
      if (!editor) return;
      var isOpen = editor.style.display !== 'none';
      // Collapse all editors
      container.querySelectorAll('.wf-step-editor').forEach(function(ed) { ed.style.display = 'none'; });
      container.querySelectorAll('.wf-step').forEach(function(r) { r.classList.remove('wf-step-expanded'); });
      if (!isOpen) {
        editor.style.display = 'block';
        row.classList.add('wf-step-expanded');
      }
    });
  });

  // Wire step editor action buttons
  container.querySelectorAll('.wf-step-editor[data-step-idx]').forEach(function(editor) {
    var idx = parseInt(editor.getAttribute('data-step-idx'));

    // Prevent clicks inside editor from toggling the row
    editor.addEventListener('click', function(e) { e.stopPropagation(); });

    // Save
    var saveBtn = editor.querySelector('.wf-se-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function() {
        var step = wf.steps[idx];
        if (!step) return;
        var updated = collectStepEditorValues(editor, step);
        wf.steps[idx] = updated;
        var varsAdded = ensureStepVariablesDeclared(wf, updated);
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          await saveWorkflow(wf.id, wf);
          var msg = 'Step ' + (idx + 1) + ' saved';
          if (varsAdded > 0) msg += ' — ' + varsAdded + ' variable' + (varsAdded > 1 ? 's' : '') + ' added';
          toast(msg, 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Save failed: ' + err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      });
    }

    // Cancel
    var cancelBtn = editor.querySelector('.wf-se-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        editor.style.display = 'none';
        var row = container.querySelector('.wf-step[data-step-idx="' + idx + '"]');
        if (row) row.classList.remove('wf-step-expanded');
      });
    }

    // Delete
    var deleteBtn = editor.querySelector('.wf-se-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async function() {
        var label = wf.steps[idx] ? (wf.steps[idx].label || wf.steps[idx].id || 'Step ' + (idx + 1)) : 'Step ' + (idx + 1);
        if (!confirm('Delete step "' + label + '"? This cannot be undone.')) return;
        wf.steps.splice(idx, 1);
        deleteBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step deleted', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Delete failed: ' + err.message, 'error');
          deleteBtn.disabled = false;
        }
      });
    }

    // Move Up
    var upBtn = editor.querySelector('.wf-se-up');
    if (upBtn && idx > 0) {
      upBtn.addEventListener('click', async function() {
        var tmp = wf.steps[idx];
        wf.steps[idx] = wf.steps[idx - 1];
        wf.steps[idx - 1] = tmp;
        upBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step moved up', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Move failed: ' + err.message, 'error');
          upBtn.disabled = false;
        }
      });
    }

    // Move Down
    var downBtn = editor.querySelector('.wf-se-down');
    if (downBtn && idx < wf.steps.length - 1) {
      downBtn.addEventListener('click', async function() {
        var tmp = wf.steps[idx];
        wf.steps[idx] = wf.steps[idx + 1];
        wf.steps[idx + 1] = tmp;
        downBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step moved down', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Move failed: ' + err.message, 'error');
          downBtn.disabled = false;
        }
      });
    }

    // Insert Step Below
    var insertBtn = editor.querySelector('.wf-se-insert-below');
    if (insertBtn) {
      insertBtn.addEventListener('click', function() {
        // Toggle inline type picker
        var existing = editor.querySelector('.wf-se-insert-picker');
        if (existing) { existing.remove(); return; }

        var pickerHtml = '<div class="wf-se-insert-picker" style="margin-top:0.5rem;padding:0.5rem;background:#1e293b;border:1px solid #334155;border-radius:6px;">';
        pickerHtml += '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.5rem;">Select step type to insert:</div>';
        pickerHtml += '<div style="display:flex;flex-wrap:wrap;gap:0.35rem;">';
        var allTypes = ['navigate', 'click', 'type', 'wait', 'keyboard', 'scroll', 'assert', 'set_variable', 'file_dialog', 'capture_download', 'move_file'];
        for (var ti = 0; ti < allTypes.length; ti++) {
          var t = allTypes[ti];
          var tIcon = STEP_ICONS[t] || '&#x25cf;';
          pickerHtml += '<button class="wf-se-btn wf-se-insert-type" data-insert-type="' + t + '" style="font-size:0.7rem;padding:0.25rem 0.5rem;">' + tIcon + ' ' + t + '</button>';
        }
        pickerHtml += '</div>';
        pickerHtml += '</div>';

        editor.insertAdjacentHTML('beforeend', pickerHtml);

        editor.querySelectorAll('.wf-se-insert-type').forEach(function(typeBtn) {
          typeBtn.addEventListener('click', async function() {
            var newType = typeBtn.getAttribute('data-insert-type');
            var newStep = buildDefaultStep(newType);
            newStep.id = 'step-' + Date.now() + '-' + newType;
            newStep.label = buildStepLabel(newStep, idx + 1);

            wf.steps.splice(idx + 1, 0, newStep);
            insertBtn.disabled = true;
            try {
              await saveWorkflow(wf.id, wf);
              toast('Step inserted', 'success');
              renderWorkflowDetail(wf, filePath, source);
            } catch (err) {
              toast('Insert failed: ' + err.message, 'error');
              wf.steps.splice(idx + 1, 1);
              insertBtn.disabled = false;
            }
          });
        });
      });
    }
  });
}

// ── Debug Mode ──────────────────────────────────────────────

var debugActive = false;
var debugSteps = [];
var debugWf = null;

var STEP_ICONS_DBG = {
  navigate: '&#x1F310;',
  click: '&#x1F5B1;',
  type: '&#x2328;',
  keyboard: '&#x2328;',
  wait: '&#x23F3;',
  scroll: '&#x2195;',
  assert: '&#x2714;',
};

async function startDebugMode(wf) {
  var outputEl = document.querySelector('#wf-run-output');
  var debugBtn = document.querySelector('#wf-btn-debug');
  var runBtn = document.querySelector('#wf-btn-run');
  if (!outputEl) return;

  // Collect variable values
  var variables = {};
  var inputs = document.querySelectorAll('.wf-run-input');
  inputs.forEach(function(input) {
    var val = input.value.trim();
    if (val) { variables[input.name] = val; }
  });

  if (debugBtn) { debugBtn.disabled = true; debugBtn.innerHTML = '&#x23f3; Loading...'; }
  if (runBtn) { runBtn.disabled = true; }

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/debug/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: variables }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Debug start failed');

    debugActive = true;
    debugSteps = data.steps || [];
    debugWf = wf;

    // Show minimal status — full debug UI is in the Chrome extension side panel
    outputEl.style.display = 'block';
    var html = '';
    html += '<div class="wf-debug-container">';
    html += '<div class="wf-debug-header">';
    html += '<span style="font-size:0.85rem;font-weight:700;color:#e2e8f0;">&#x1f50d; Debug Active: ' + escHtml(wf.name) + '</span>';
    html += '</div>';
    html += '<div style="color:#94a3b8;font-size:0.8rem;padding:0.5rem 0;">Click the <strong style="color:#e2e8f0;">Woodbury extension icon</strong> (blue "DBG" badge) in your Chrome toolbar to open the debug panel.<br>Position markers are shown on the page.</div>';
    html += '<button class="btn-secondary" id="wf-dbg-exit" style="font-size:0.75rem;padding:0.4rem 0.75rem;border-color:#ef4444;color:#ef4444;margin-top:0.5rem;">&#x23f9; Exit Debug</button>';
    html += '</div>';
    outputEl.innerHTML = html;

    // Wire exit button
    document.querySelector('#wf-dbg-exit')?.addEventListener('click', function() { exitDebugMode(); });

    if (debugBtn) { debugBtn.innerHTML = '&#x1f50d; Debugging'; }
  } catch (err) {
    toast('Debug failed: ' + err.message, 'error');
    if (debugBtn) { debugBtn.disabled = false; debugBtn.innerHTML = '&#x1f50d; Debug'; }
    if (runBtn) { runBtn.disabled = false; }
  }
}

// debugNextStep() and debugRunAll() now live in the Chrome extension side panel (sidepanel.js)

async function exitDebugMode() {
  if (!debugWf) return;
  try {
    await fetch('/api/workflows/' + encodeURIComponent(debugWf.id) + '/debug/exit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {}

  debugActive = false;
  debugSteps = [];
  debugWf = null;

  // Restore UI
  var outputEl = document.querySelector('#wf-run-output');
  if (outputEl) { outputEl.style.display = 'none'; outputEl.innerHTML = ''; }
  var debugBtn = document.querySelector('#wf-btn-debug');
  if (debugBtn) { debugBtn.disabled = false; debugBtn.innerHTML = '&#x1f50d; Debug'; }
  var runBtn = document.querySelector('#wf-btn-run');
  if (runBtn) { runBtn.disabled = false; }
}

// ── Run Workflow ─────────────────────────────────────────────

var runPollTimer = null;

async function runWorkflow(wf) {
  var runBtn = document.querySelector('#wf-btn-run');
  var statusEl = document.querySelector('#wf-run-status');
  var outputEl = document.querySelector('#wf-run-output');
  if (!runBtn || !statusEl || !outputEl) return;

  // Collect variable values from inputs
  var variables = {};
  var inputs = document.querySelectorAll('.wf-run-input');
  inputs.forEach(function(input) {
    var val = input.value.trim();
    if (val) {
      variables[input.name] = val;
    }
  });

  // Check required variables
  var missing = [];
  if (wf.variables) {
    for (var i = 0; i < wf.variables.length; i++) {
      var v = wf.variables[i];
      if (v.required && !variables[v.name] && (v.default === undefined || v.default === null)) {
        missing.push(v.name);
      }
    }
  }

  if (missing.length > 0) {
    toast('Missing required variables: ' + missing.join(', '), 'error');
    return;
  }

  // Start the workflow via API
  runBtn.disabled = true;
  runBtn.innerHTML = '&#x23f3; Starting...';
  statusEl.textContent = '';
  outputEl.style.display = 'block';
  outputEl.innerHTML =
    '<div class="wf-run-progress">' +
    '<div class="wf-run-progress-header">' +
    '<span class="wf-rec-indicator wf-rec-active">&#x25b6;</span> ' +
    '<span id="wf-run-progress-title">Starting workflow...</span>' +
    '</div>' +
    '<div class="wf-run-progress-bar-container">' +
    '<div class="wf-run-progress-bar" id="wf-run-pbar" style="width:0%"></div>' +
    '</div>' +
    '<div class="wf-run-step-feed" id="wf-run-step-feed"></div>' +
    '</div>';

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: variables }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');

    // Show cancel button
    runBtn.innerHTML = '&#x23f9; Cancel';
    runBtn.disabled = false;
    runBtn.style.background = '#ef4444';
    runBtn.onclick = function() { cancelRunningWorkflow(wf); };

    // Start polling for progress
    startRunPoll(wf);
  } catch (err) {
    toast('Run failed: ' + err.message, 'error');
    resetRunUI(wf);
  }
}

function startRunPoll(wf) {
  var lastStepIdx = -1;
  runPollTimer = setInterval(async function() {
    try {
      var res = await fetch('/api/workflows/run/status');
      var data = await res.json();

      if (!data.active && !data.done) {
        stopRunPoll();
        resetRunUI(wf);
        return;
      }

      // Update progress bar
      var pbar = document.querySelector('#wf-run-pbar');
      if (pbar && data.stepsTotal > 0) {
        var pct = Math.round((data.stepsCompleted / data.stepsTotal) * 100);
        pbar.style.width = pct + '%';
      }

      // Update title
      var titleEl = document.querySelector('#wf-run-progress-title');
      if (titleEl) {
        if (data.done) {
          titleEl.textContent = data.success
            ? 'Workflow complete! (' + formatDuration(data.durationMs) + ')'
            : 'Workflow failed: ' + (data.error || 'Unknown error');
        } else {
          titleEl.textContent = data.currentStep || ('Step ' + (data.stepsCompleted + 1) + '/' + data.stepsTotal);
        }
      }

      // Add new step results to feed
      var feedEl = document.querySelector('#wf-run-step-feed');
      if (feedEl && data.stepResults) {
        for (var i = lastStepIdx + 1; i < data.stepResults.length; i++) {
          var sr = data.stepResults[i];
          var icon = STEP_ICONS[sr.type] || '&#x25cf;';
          var statusIcon = sr.status === 'success' ? '&#x2705;' : '&#x274c;';
          var stepHtml = '<div class="wf-run-step-item ' + (sr.status === 'success' ? 'wf-run-step-ok' : 'wf-run-step-fail') + '">' +
            '<span class="wf-step-num">' + (sr.index + 1) + '</span>' +
            '<span class="wf-step-icon">' + icon + '</span>' +
            '<span class="wf-step-label">' + escHtml(sr.label) + '</span>' +
            '<span class="wf-run-step-status">' + statusIcon + '</span>' +
            (sr.error ? '<span class="wf-run-step-error">' + escHtml(sr.error) + '</span>' : '') +
            '</div>';
          feedEl.innerHTML += stepHtml;
          lastStepIdx = i;
        }
        feedEl.scrollTop = feedEl.scrollHeight;
      }

      // If done, finalize
      if (data.done) {
        stopRunPoll();
        if (pbar) {
          pbar.style.width = '100%';
          pbar.style.background = data.success ? '#10b981' : '#ef4444';
        }
        var indicator = document.querySelector('#wf-run-output .wf-rec-indicator');
        if (indicator) {
          indicator.classList.remove('wf-rec-active');
          indicator.innerHTML = data.success ? '&#x2705;' : '&#x274c;';
        }

        // Show training data status badge
        if (feedEl && data.trainingDataKept !== undefined) {
          var tdBadge = data.trainingDataKept
            ? '<div class="wf-run-training-badge wf-run-training-kept">&#x1f9e0; Run snapshots saved as training data</div>'
            : '<div class="wf-run-training-badge wf-run-training-discarded">&#x1f5d1; Run snapshots discarded</div>';
          feedEl.innerHTML += tdBadge;
          feedEl.scrollTop = feedEl.scrollHeight;
        }

        resetRunUI(wf);
        if (data.success) {
          toast('Workflow "' + data.workflowName + '" completed in ' + formatDuration(data.durationMs), 'success');
        } else {
          toast('Workflow failed: ' + (data.error || 'Unknown error'), 'error');
        }
      }
    } catch {}
  }, 800);
}

function stopRunPoll() {
  if (runPollTimer) {
    clearInterval(runPollTimer);
    runPollTimer = null;
  }
}

async function cancelRunningWorkflow(wf) {
  stopRunPoll();
  try {
    await fetch('/api/workflows/run/cancel', { method: 'POST' });
  } catch {}
  toast('Workflow cancelled', 'info');
  resetRunUI(wf);
}

function resetRunUI(wf) {
  var runBtn = document.querySelector('#wf-btn-run');
  if (runBtn) {
    runBtn.innerHTML = '&#x25b6; Run Workflow';
    runBtn.disabled = false;
    runBtn.style.background = '#10b981';
    runBtn.onclick = function() { runWorkflow(wf); };
  }
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

// ── Auto-fill Variables ─────────────────────────────────────

function autoFillVariables(wf) {
  if (!wf.variables || wf.variables.length === 0) return;

  // Collect variables that need filling
  var toFill = [];
  for (var i = 0; i < wf.variables.length; i++) {
    var v = wf.variables[i];
    var inputEl = document.querySelector('#wf-run-var-' + CSS.escape(v.name));
    if (!inputEl) continue;
    var currentVal = inputEl.value.trim();
    if (currentVal) continue; // skip already-filled
    toFill.push(v);
  }

  if (toFill.length === 0) {
    toast('All variables already have values', 'info');
    return;
  }

  // Show loading state on the autofill button
  var btn = document.querySelector('#wf-btn-autofill');
  var origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.innerHTML = '⏳ Generating...';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  }

  // Call the AI autofill endpoint
  fetch('/api/autofill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variables: toFill.map(function(v) {
        return { name: v.name, type: v.type, description: v.description, default: v.default };
      }),
      workflowName: wf.name,
      site: wf.site,
      steps: (wf.steps || []).map(function(s) {
        return {
          type: s.type,
          value: s.value,
          target: s.target ? {
            textContent: s.target.textContent || s.target.expectedText,
            description: s.target.description
          } : undefined
        };
      })
    })
  })
  .then(function(resp) { return resp.json(); })
  .then(function(data) {
    if (data.success && data.values) {
      var filledCount = 0;
      for (var i = 0; i < toFill.length; i++) {
        var v = toFill[i];
        var val = data.values[v.name];
        if (val !== undefined && val !== null) {
          var inputEl = document.querySelector('#wf-run-var-' + CSS.escape(v.name));
          if (inputEl) {
            inputEl.value = String(val);
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            filledCount++;
          }
        }
      }
      toast('AI generated values for ' + filledCount + ' variable' + (filledCount !== 1 ? 's' : ''), 'success');
    } else {
      // API returned an error — fall back to heuristic autofill
      console.warn('[workflows] AI autofill failed, using heuristics:', data.error);
      autoFillVariablesHeuristic(wf, toFill);
    }
  })
  .catch(function(err) {
    // Network or parse error — fall back to heuristic autofill
    console.warn('[workflows] AI autofill fetch error, using heuristics:', err);
    autoFillVariablesHeuristic(wf, toFill);
  })
  .finally(function() {
    // Restore button
    if (btn) {
      btn.innerHTML = origHtml;
      btn.disabled = false;
      btn.style.opacity = '';
    }
  });
}

function autoFillVariablesHeuristic(wf, toFill) {
  var filled = 0;
  for (var i = 0; i < toFill.length; i++) {
    var v = toFill[i];
    var inputEl = document.querySelector('#wf-run-var-' + CSS.escape(v.name));
    if (!inputEl) continue;
    var generated = generateVariableValue(v, wf);
    if (generated !== null) {
      inputEl.value = generated;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      filled++;
    }
  }
  toast('Filled ' + filled + ' variable' + (filled !== 1 ? 's' : '') + ' with sample values (AI unavailable)', 'info');
}

function generateVariableValue(v, wf) {
  var name = (v.name || '').toLowerCase();
  var desc = (v.description || '').toLowerCase();
  var type = (v.type || 'string').toLowerCase();
  var context = name + ' ' + desc;
  var site = (wf.site || '').toLowerCase();

  // If there's a default, use it
  if (v.default !== undefined && v.default !== null && String(v.default).trim()) {
    return String(v.default);
  }

  // Number types
  if (type === 'number') {
    if (name.includes('count') || name.includes('amount') || name.includes('limit')) return '5';
    if (name.includes('delay') || name.includes('timeout') || name.includes('wait')) return '3000';
    if (name.includes('width')) return '1920';
    if (name.includes('height')) return '1080';
    if (name.includes('port')) return '3000';
    if (name.includes('retry') || name.includes('retries')) return '3';
    if (name.includes('page')) return '1';
    return '1';
  }

  // Boolean types
  if (type === 'boolean') {
    return 'true';
  }

  // URL / link
  if (name.includes('url') || name.includes('link') || name.includes('href')) {
    if (site) return 'https://' + site;
    return 'https://example.com';
  }

  // File / path
  if (name.includes('path') || name.includes('file') || name.includes('dir')) {
    if (name.includes('image') || name.includes('img') || name.includes('photo') || name.includes('picture')) {
      return '/tmp/sample-image.jpg';
    }
    if (name.includes('video') || name.includes('clip')) {
      return '/tmp/sample-video.mp4';
    }
    if (name.includes('audio') || name.includes('song') || name.includes('music') || name.includes('sound')) {
      return '/tmp/sample-audio.mp3';
    }
    if (name.includes('output') || name.includes('download') || name.includes('dest')) {
      return '/tmp/output';
    }
    return '/tmp/sample-file.txt';
  }

  // Song / music related (Suno etc.)
  if (site.includes('suno') || context.includes('song') || context.includes('music')) {
    if (name.includes('title') || name === 'name') return 'Midnight Dreams';
    if (name.includes('lyrics') || name.includes('text') || name.includes('content') || name.includes('caption')) {
      return 'Walking through the city lights,\nChasing stars on summer nights,\nEvery beat a story untold,\nLet the rhythm take hold.';
    }
    if (name.includes('genre') || name.includes('style')) return 'Pop';
    if (name.includes('mood') || name.includes('vibe')) return 'upbeat and energetic';
    if (name.includes('tag')) return 'pop, electronic, upbeat';
    if (name.includes('artist') || name.includes('author')) return 'Demo Artist';
    if (name.includes('instrumental') || name.includes('custom')) return 'false';
  }

  // Social media / Instagram
  if (site.includes('instagram') || site.includes('twitter') || site.includes('tiktok') || site.includes('facebook')) {
    if (name.includes('caption') || name.includes('text') || name.includes('content') || name.includes('post')) {
      return 'Check out this amazing view! The sunset was incredible today. #sunset #nature #photography';
    }
    if (name.includes('hashtag') || name.includes('tag')) return '#photography #nature #sunset';
    if (name.includes('mention') || name.includes('user')) return '@example_user';
    if (name.includes('location') || name.includes('place')) return 'San Francisco, CA';
  }

  // Generic text fields
  if (name.includes('title') || name === 'name') return 'Sample ' + (wf.name || 'Workflow') + ' Title';
  if (name.includes('description') || name.includes('desc') || name.includes('summary')) {
    return 'This is a sample description for testing the ' + (wf.name || 'workflow') + '.';
  }
  if (name.includes('caption') || name.includes('text') || name.includes('content') || name.includes('body') || name.includes('message')) {
    return 'Sample text content for ' + (wf.name || 'workflow') + '. Edit this with your actual content.';
  }
  if (name.includes('lyrics')) {
    return 'Walking through the city lights,\nChasing stars on summer nights,\nEvery beat a story untold,\nLet the rhythm take hold.';
  }
  if (name.includes('email')) return 'user@example.com';
  if (name.includes('username') || name.includes('user_name')) return 'demo_user';
  if (name.includes('password') || name.includes('secret') || name.includes('token') || name.includes('key')) return null; // Never auto-fill sensitive
  if (name.includes('genre') || name.includes('style') || name.includes('category')) return 'General';
  if (name.includes('tag') || name.includes('label') || name.includes('keyword')) return 'sample, test, demo';
  if (name.includes('date') || name.includes('time')) return new Date().toISOString().split('T')[0];
  if (name.includes('color') || name.includes('colour')) return '#7c3aed';
  if (name.includes('format') || name.includes('type')) return 'default';
  if (name.includes('language') || name.includes('lang')) return 'English';

  // Fallback: generate based on type
  if (type === 'string[]') return 'item1, item2, item3';
  if (type === 'string') return 'sample_' + v.name;

  return null;
}

// ── Per-Workflow Training Status Polling ─────────────────────

function startWorkflowTrainingPoll(workflowId) {
  // Don't double-poll
  if (workflowTrainingPolls[workflowId]) return;

  // Poll immediately, then every 3 seconds
  pollWorkflowTrainingOnce(workflowId);
  workflowTrainingPolls[workflowId] = setInterval(function() {
    pollWorkflowTrainingOnce(workflowId);
  }, 3000);
}

function stopWorkflowTrainingPoll(workflowId) {
  if (workflowTrainingPolls[workflowId]) {
    clearInterval(workflowTrainingPolls[workflowId]);
    delete workflowTrainingPolls[workflowId];
  }
}

function stopAllWorkflowTrainingPolls() {
  Object.keys(workflowTrainingPolls).forEach(function(id) {
    clearInterval(workflowTrainingPolls[id]);
  });
  workflowTrainingPolls = {};
}

async function checkAndPollWorkflowTraining(workflowId) {
  // One-shot check if the server has an active training for this workflow
  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/training/status');
    if (!res.ok) return;
    var status = await res.json();
    // If training is active (not complete/error), start polling
    if (status.phase && status.phase !== 'complete' && status.phase !== 'error') {
      startWorkflowTrainingPoll(workflowId);
    } else {
      // Still render the last status (completed/failed card)
      if (selectedWorkflow === workflowId) {
        var container = document.getElementById('wf-training-status');
        if (container) {
          container.innerHTML = renderWorkflowTrainingStatus(status, workflowId);
          wireTrainingRetryBtn(workflowId);
        }
      }
    }
  } catch (err) {
    // No training info available — that's fine
  }
}

async function pollWorkflowTrainingOnce(workflowId) {
  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/training/status');
    if (!res.ok) {
      // 404 = no training found; stop polling
      if (res.status === 404) {
        stopWorkflowTrainingPoll(workflowId);
      }
      return;
    }
    var status = await res.json();

    // Render into the training status div (only if this workflow is still selected)
    if (selectedWorkflow === workflowId) {
      var container = document.getElementById('wf-training-status');
      if (container) {
        container.innerHTML = renderWorkflowTrainingStatus(status, workflowId);
        wireTrainingRetryBtn(workflowId);
      }
    }

    // If training completed or failed, stop polling and refresh sidebar
    if (status.phase === 'complete' || status.phase === 'error') {
      stopWorkflowTrainingPoll(workflowId);
      // Refresh sidebar to update badges
      fetchWorkflows();
      // Re-fetch detail to update info chips (modelPath, AUC, etc.)
      if (selectedWorkflow === workflowId) {
        // Small delay to let the workflow JSON file update
        setTimeout(function() { selectWorkflow(workflowId); }, 1000);
      }
    }
  } catch (err) {
    // Network error — don't stop polling, it might recover
  }
}

function renderWorkflowTrainingStatus(status, workflowId) {
  var html = '';

  if (status.phase === 'complete') {
    // Completed training — show summary card
    html += '<div class="wf-training-card wf-training-complete-card">';
    html += '<div class="wf-training-card-header">';
    html += '<div class="wf-training-card-title">&#x2705; Model Training Complete</div>';
    html += '<span class="wf-training-card-phase" style="background:#065f46;color:#6ee7b7;">complete</span>';
    html += '</div>';
    html += '<div class="training-stats-row">';
    if (status.bestAuc > 0) {
      html += '<span>Best AUC: <strong style="color:#6ee7b7;">' + status.bestAuc.toFixed(4) + '</strong></span>';
    }
    if (status.totalEpochs > 0) {
      html += '<span>Epochs: <strong>' + status.totalEpochs + '</strong></span>';
    }
    if (status.elapsed > 0) {
      html += '<span>Duration: <strong>' + formatTrainingTime(status.elapsed / 1000) + '</strong></span>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  if (status.phase === 'error') {
    // Failed training — show error card with retry
    html += '<div class="wf-training-card wf-training-failed-card">';
    html += '<div class="wf-training-card-header">';
    html += '<div class="wf-training-card-title">&#x274c; Model Training Failed</div>';
    html += '<span class="wf-training-card-phase" style="background:#7f1d1d;color:#fca5a5;">failed</span>';
    html += '</div>';
    if (status.error) {
      html += '<div style="font-size:0.75rem;color:#fca5a5;margin-bottom:0.75rem;word-break:break-word;">' + escHtml(status.error) + '</div>';
    }
    html += '<button class="btn-secondary" id="wf-training-retry" style="font-size:0.72rem;padding:0.35rem 0.75rem;">&#x1f504; Retry Training</button>';
    html += '</div>';
    return html;
  }

  // Active training — show progress
  html += '<div class="wf-training-card">';
  html += '<div class="wf-training-card-header">';
  var trainingTitle = 'Model Training';
  if (status.worker && status.worker.name) {
    trainingTitle += ' <span style="font-weight:400;color:#94a3b8;font-size:0.7rem;">on ' + escHtml(status.worker.name) + '</span>';
  }
  html += '<div class="wf-training-card-title"><span class="wf-training-pulse">&#x25cf;</span> ' + trainingTitle + '</div>';

  var phaseLabel = status.phase || 'initializing';
  var phaseColor = '#4c1d95';
  var phaseText = '#c4b5fd';
  if (phaseLabel === 'preparing') { phaseLabel = 'preparing data'; }
  else if (phaseLabel === 'training') { phaseLabel = 'training'; phaseColor = '#4c1d95'; }
  else if (phaseLabel === 'exporting') { phaseLabel = 'exporting ONNX'; phaseColor = '#065f46'; phaseText = '#6ee7b7'; }

  html += '<span class="wf-training-card-phase" style="background:' + phaseColor + ';color:' + phaseText + ';">' + escHtml(phaseLabel) + '</span>';
  html += '</div>';

  // Progress bar
  var pct = 0;
  var barLabel = '';
  if (status.phase === 'preparing') {
    pct = 5;
    barLabel = 'Preparing training data...';
  } else if (status.phase === 'exporting') {
    pct = 98;
    barLabel = 'Exporting ONNX model...';
  } else if (status.totalEpochs > 0) {
    pct = Math.round((status.currentEpoch / status.totalEpochs) * 100);
    barLabel = 'Epoch ' + status.currentEpoch + ' / ' + status.totalEpochs + ' (' + pct + '%)';
  } else {
    pct = 2;
    barLabel = 'Initializing...';
  }

  html += '<div class="training-progress-bar-outer">';
  html += '<div class="training-progress-bar-fill" style="width:' + pct + '%"></div>';
  html += '<div class="training-progress-bar-text">' + barLabel + '</div>';
  html += '</div>';

  // Stats row
  html += '<div class="training-stats-row">';
  if (status.loss > 0) {
    html += '<span>Loss: <strong>' + status.loss.toFixed(4) + '</strong></span>';
  }
  if (status.bestAuc > 0) {
    html += '<span>Best AUC: <strong>' + status.bestAuc.toFixed(4) + '</strong></span>';
  }
  if (status.elapsed > 0) {
    html += '<span>Elapsed: <strong>' + formatTrainingTime(status.elapsed / 1000) + '</strong></span>';
  }
  html += '</div>';

  // Last few log lines
  if (status.logs && status.logs.length > 0) {
    html += '<div style="margin-top:0.5rem;max-height:80px;overflow-y:auto;font-family:monospace;font-size:0.6rem;color:#64748b;background:#0f172a;border-radius:4px;padding:0.4rem;">';
    for (var i = 0; i < status.logs.length; i++) {
      html += escHtml(status.logs[i]) + '<br>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function wireTrainingRetryBtn(workflowId) {
  var retryBtn = document.getElementById('wf-training-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', async function() {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying...';
      try {
        var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/training/retry', {
          method: 'POST',
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Retry failed');
        toast('Training restarted', 'success');
        startWorkflowTrainingPoll(workflowId);
      } catch (err) {
        toast('Retry failed: ' + err.message, 'error');
        retryBtn.disabled = false;
        retryBtn.textContent = '\u{1f504} Retry Training';
      }
    });
  }
}

function formatTrainingTime(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
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

// ── Download Detection Modal ──────────────────────────────
// Shown after recording stops when new downloads are detected.

function showDownloadDetectionModal(workflowId, downloads) {
  // Remove any existing modal
  var existing = document.getElementById('download-detect-modal');
  if (existing) existing.remove();

  // Determine common parent directory for default destination
  var defaultDest = '';
  if (downloads.length > 0 && downloads[0].filename) {
    var parts = downloads[0].filename.replace(/\\/g, '/').split('/');
    parts.pop(); // remove filename
    defaultDest = parts.join('/') || '/';
    if (defaultDest && !defaultDest.endsWith('/')) defaultDest += '/';
  }

  // Format file size
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Build file list HTML
  var fileListHtml = downloads.map(function(dl, i) {
    var fname = dl.filename ? dl.filename.replace(/\\/g, '/').split('/').pop() : 'Unknown file';
    var size = formatSize(dl.fileSize);
    return '<label class="dl-detect-file-item">' +
      '<input type="checkbox" checked data-dl-index="' + i + '" data-dl-filename="' + escAttr(dl.filename || '') + '">' +
      '<span class="dl-detect-fname">' + escHtml(fname) + '</span>' +
      (size ? '<span class="dl-detect-fsize">' + size + '</span>' : '') +
      '</label>';
  }).join('');

  // Build modal HTML
  var modalHtml =
    '<div class="modal-overlay open" id="download-detect-modal">' +
      '<div class="modal" style="max-width:520px;">' +
        '<div class="modal-header">' +
          '<h3>\u{1F4E5} Downloads Detected</h3>' +
          '<button class="modal-close" id="dl-detect-close">&times;</button>' +
        '</div>' +
        '<div style="padding:0 1.25rem;">' +
          '<p style="color:#94a3b8;margin:0.5rem 0;">' + downloads.length + ' new file' + (downloads.length > 1 ? 's were' : ' was') + ' downloaded during recording. Add capture &amp; move steps?</p>' +
        '</div>' +
        '<div class="dl-detect-file-list">' + fileListHtml + '</div>' +
        '<div style="padding:0.75rem 1.25rem;">' +
          '<label style="display:block;color:#cbd5e1;font-size:0.8rem;margin-bottom:0.35rem;">Destination directory</label>' +
          '<input type="text" id="dl-detect-dest" value="' + escAttr(defaultDest) + '" class="dl-detect-dest-input" placeholder="/path/to/destination/">' +
          '<label class="dl-detect-var-toggle">' +
            '<input type="checkbox" id="dl-detect-use-var" checked>' +
            '<span>Make destination overridable (<code>{{outputDir}}</code> variable)</span>' +
          '</label>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn-modal-cancel" id="dl-detect-skip">Skip</button>' +
          '<button class="btn-modal-select" id="dl-detect-confirm">\u{1F4E5} Add Download Steps</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  var modal = document.getElementById('download-detect-modal');

  function closeModal() {
    if (modal) modal.remove();
  }

  // Close handlers
  document.getElementById('dl-detect-close').addEventListener('click', closeModal);
  document.getElementById('dl-detect-skip').addEventListener('click', closeModal);
  modal.addEventListener('click', function(e) {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', onEsc);
    }
  });

  // Confirm handler
  document.getElementById('dl-detect-confirm').addEventListener('click', async function() {
    var checkboxes = modal.querySelectorAll('input[data-dl-index]:checked');
    var selectedFiles = [];
    checkboxes.forEach(function(cb) {
      var fname = cb.getAttribute('data-dl-filename');
      if (fname) selectedFiles.push(fname);
    });

    if (selectedFiles.length === 0) {
      toast('No files selected', 'error');
      return;
    }

    var destination = document.getElementById('dl-detect-dest').value.trim();
    if (!destination) {
      toast('Please enter a destination directory', 'error');
      return;
    }
    // Ensure trailing slash
    if (!destination.endsWith('/')) destination += '/';

    var useVariable = document.getElementById('dl-detect-use-var').checked;

    try {
      var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/add-download-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: selectedFiles,
          destination: destination,
          useVariable: useVariable,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add steps');

      toast('Added capture + move steps for ' + selectedFiles.length + ' file(s)', 'success');
      await fetchWorkflows();
      selectWorkflow(workflowId);
      closeModal();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });
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
