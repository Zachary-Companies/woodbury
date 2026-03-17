/**
 * Pipeline App Mode
 *
 * Transforms a pipeline's results into an interactive application with
 * sidebar navigation, editable output sections, stale tracking,
 * and a command bar for natural language node invocation.
 *
 * Depends on: compositions-execution.js (rendering functions),
 *             compositions-core.js (compData, selectComposition),
 *             app.js (updateHash, parseHash, toast)
 */

/* global compData, compEscHtml, compEscAttr, humanizeVarName, toast,
          renderCompositionRichValue, renderCompositionOutputs,
          renderCompositionStructuredValue, formatCompositionPreviewValue,
          updateHash, selectComposition, renderCompositionRunFields,
          normalizeCompositionRunInputs, collectCompositionRunValues,
          saveCompositionRunValues, startCompositionRun,
          fetchCompositionInterface, wireCompositionRunInputActions,
          getCompositionRunValue, getCompositionDefaultText */

// ────────────────────────────────────────────────────────────────
//  State
// ────────────────────────────────────────────────────────────────

var appSchema = null;
var appState = null;
var appActiveSection = null;

// ────────────────────────────────────────────────────────────────
//  API helpers
// ────────────────────────────────────────────────────────────────

async function fetchAppSchema(pipelineId) {
  var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/schema');
  if (!res.ok) return null;
  return res.json();
}

async function fetchAppState(pipelineId) {
  var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/state');
  if (!res.ok) return null;
  return res.json();
}

/** Fetch a single node's data (fast — reads one file on the server) */
async function fetchAppNodeData(pipelineId, nodeId) {
  var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/node/' + encodeURIComponent(nodeId));
  if (!res.ok) return null;
  return res.json();
}

async function saveAppNodeState(pipelineId, nodeId, outputs) {
  var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/state/' + encodeURIComponent(nodeId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputs: outputs }),
  });
  if (!res.ok) throw new Error('Failed to save');
  return res.json();
}

async function refreshAppFromRun(pipelineId) {
  var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/refresh-from-run', { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

// ────────────────────────────────────────────────────────────────
//  Icon SVG map
// ────────────────────────────────────────────────────────────────

var appIconMap = {
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.93 4.93l2.12 2.12m9.9 9.9l2.12 2.12M4.93 19.07l2.12-2.12m9.9-9.9l2.12-2.12"/></svg>',
  output: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12h6m-3-3v6"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7l-5 5 5 5m8-10l5 5-5 5"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6h12M6 12h8M6 18h10"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  asset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8 14l2.5-2.5 2 2 2.5-3 1.5 2"/><circle cx="9" cy="9" r="1"/></svg>',
  media: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 10l5 3-5 3z"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6.5" cy="6.5" r="2"/><circle cx="17.5" cy="12" r="2"/><circle cx="6.5" cy="17.5" r="2"/><path d="M8.5 7.4h4.5l2.5 3.1"/><path d="M8.5 16.6h4.5l2.5-3.1"/></svg>',
};

function appIcon(type) {
  return '<span class="app-nav-icon">' + (appIconMap[type] || appIconMap.workflow) + '</span>';
}

// ────────────────────────────────────────────────────────────────
//  Sidebar rendering
// ────────────────────────────────────────────────────────────────

function renderAppSidebar(schema, state) {
  var staleSet = new Set(state.staleNodes || []);
  var html = '<div class="app-sidebar">';

  // Title
  html += '<div class="app-sidebar-header">';
  html += '<h2 class="app-sidebar-title">' + compEscHtml(schema.name) + '</h2>';
  if (schema.description) {
    html += '<p class="app-sidebar-desc">' + compEscHtml(schema.description) + '</p>';
  }
  html += '</div>';

  // Navigation
  html += '<nav class="app-nav" aria-label="App sections">';
  for (var i = 0; i < schema.sections.length; i++) {
    var section = schema.sections[i];
    var isActive = appActiveSection === section.id;
    var isStale = section.nodeId && staleSet.has(section.nodeId);
    var hasData = section.nodeId && state.nodeData && state.nodeData[section.nodeId];
    var itemCount = '';
    if (hasData) {
      var outputs = state.nodeData[section.nodeId].outputs;
      var firstKey = Object.keys(outputs)[0];
      var firstVal = firstKey ? outputs[firstKey] : null;
      if (Array.isArray(firstVal)) {
        itemCount = ' (' + firstVal.length + ')';
      } else if (firstVal && typeof firstVal === 'object') {
        itemCount = ' (' + Object.keys(firstVal).length + ')';
      }
    }

    html += '<button class="app-nav-item' + (isActive ? ' active' : '') + (isStale ? ' stale' : '') + '"';
    html += ' data-app-section="' + compEscAttr(section.id) + '"';
    html += ' title="' + compEscAttr(section.label) + '">';
    html += appIcon(section.icon);
    html += '<span class="app-nav-label">' + compEscHtml(section.label) + compEscHtml(itemCount) + '</span>';
    if (isStale) {
      html += '<span class="app-nav-stale" title="Data has changed upstream — needs refresh">&#x26A0;</span>';
    }
    if (section.type === 'node-output' && hasData && state.nodeData[section.nodeId].manuallyEdited) {
      html += '<span class="app-nav-edited" title="Manually edited">&#x270E;</span>';
    }
    html += '</button>';
  }
  html += '</nav>';

  // Actions bar
  html += '<div class="app-sidebar-actions">';
  var staleCount = (state.staleNodes || []).length;
  if (staleCount > 0) {
    html += '<button class="app-action-btn app-action-refresh" id="app-refresh-stale">';
    html += '&#x1f504; Refresh ' + staleCount + ' stale section' + (staleCount === 1 ? '' : 's');
    html += '</button>';
  }
  html += '<button class="app-action-btn" id="app-run-pipeline">&#x25b6; Run Pipeline</button>';
  html += '<button class="app-action-btn app-action-secondary" id="app-open-editor">Open Editor</button>';
  html += '<button class="app-action-btn app-action-secondary" id="app-open-form">Open Form</button>';
  html += '</div>';

  // Command bar
  html += '<div class="app-command-bar">';
  html += '<input type="text" class="app-command-input" id="app-command-input" placeholder="Type a command..." />';
  html += '</div>';

  html += '</div>';
  return html;
}

// ────────────────────────────────────────────────────────────────
//  Section content rendering
// ────────────────────────────────────────────────────────────────

function renderAppSectionContent(section, state) {
  var html = '<div class="app-content-section" data-app-content="' + compEscAttr(section.id) + '">';

  // Section header
  html += '<div class="app-section-header">';
  html += '<div class="app-section-header-left">';
  html += '<h2 class="app-section-title">' + compEscHtml(section.label) + '</h2>';
  if (section.description) {
    html += '<p class="app-section-subtitle">' + compEscHtml(section.description) + '</p>';
  }
  html += '</div>';
  html += '<div class="app-section-header-right">';
  if (section.canRegenerate) {
    html += '<button class="app-section-btn" data-app-regenerate="' + compEscAttr(section.nodeId || section.id) + '">&#x2728; Regenerate</button>';
  }
  var staleSet = new Set(state.staleNodes || []);
  if (section.nodeId && staleSet.has(section.nodeId)) {
    html += '<div class="app-section-stale-badge">&#x26A0; Stale — upstream data has changed</div>';
  }
  if (section.nodeId && state.nodeData && state.nodeData[section.nodeId] && state.nodeData[section.nodeId].manuallyEdited) {
    html += '<div class="app-section-edited-badge">&#x270E; Manually edited</div>';
  }
  html += '</div>';
  html += '</div>';

  // Section body — render based on type
  if (section.type === 'settings') {
    html += renderAppSettingsSection(section, state);
  } else if (section.type === 'overview') {
    html += renderAppOverviewSection(section, state);
  } else {
    html += renderAppNodeSection(section, state);
  }

  html += '</div>';
  return html;
}

function renderAppSettingsSection(section, state) {
  // The settings section shows the pipeline inputs as an editable form
  // We reuse the existing run form renderer if possible
  var html = '<div class="app-settings-form">';
  html += '<p class="app-settings-hint">These are the pipeline inputs. Change them and click "Run Pipeline" to regenerate all outputs.</p>';

  // Render each variable as a simple form field
  for (var i = 0; i < section.outputPorts.length; i++) {
    var port = section.outputPorts[i];
    html += '<div class="app-settings-field">';
    html += '<label class="app-settings-label">' + compEscHtml(port.name) + '</label>';
    if (port.description) {
      html += '<div class="app-settings-help">' + compEscHtml(port.description) + '</div>';
    }
    // Get current value from state if we have variable data
    var currentVal = '';
    // Variable nodes store their value differently — look for matching nodeData
    html += '<input type="text" class="app-settings-input" data-app-setting="' + compEscAttr(port.name) + '" value="' + compEscAttr(currentVal) + '" placeholder="' + compEscAttr(port.type) + '" />';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderAppOverviewSection(section, state) {
  if (!section.nodeId || !state.nodeData || !state.nodeData[section.nodeId]) {
    return '<div class="app-empty-state">' +
      '<div class="app-empty-icon">&#x1f4cb;</div>' +
      '<h3>No data yet</h3>' +
      '<p>Run the pipeline to generate outputs, then explore and edit them here.</p>' +
      '</div>';
  }
  var outputs = state.nodeData[section.nodeId].outputs;
  return renderAppOutputsEditable(outputs, section, 'overview');
}

function renderAppNodeSection(section, state) {
  if (!section.nodeId || !state.nodeData || !state.nodeData[section.nodeId]) {
    return '<div class="app-empty-state">' +
      '<div class="app-empty-icon">&#x1f4e6;</div>' +
      '<h3>No data for "' + compEscHtml(section.label) + '"</h3>' +
      '<p>This section will be populated after the pipeline runs.</p>' +
      '</div>';
  }

  var outputs = state.nodeData[section.nodeId].outputs;
  return renderAppOutputsEditable(outputs, section, section.id);
}

function renderAppOutputsEditable(outputs, section, sectionKey) {
  if (!outputs || typeof outputs !== 'object') {
    return '<div class="app-empty-state"><p>No output data</p></div>';
  }

  var keys = Object.keys(outputs);
  var html = '';

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = outputs[key];
    var portDef = section.outputPorts.find(function(p) { return p.name === key; });
    var portLabel = portDef ? (portDef.description || key) : key;

    html += '<div class="app-output-block" data-app-output-key="' + compEscAttr(key) + '">';
    html += '<div class="app-output-header">';
    html += '<h3 class="app-output-title">' + compEscHtml(humanizeVarName(key)) + '</h3>';
    html += '<div class="app-output-actions">';
    html += '<button class="app-output-btn app-output-edit-btn" data-app-edit-key="' + compEscAttr(key) + '" data-app-edit-node="' + compEscAttr(section.nodeId || '') + '">&#x270E; Edit</button>';
    html += '<button class="app-output-btn app-output-copy-btn" data-app-copy-key="' + compEscAttr(key) + '">&#x1f4cb; Copy</button>';
    html += '</div>';
    html += '</div>';

    // Render value using existing rich renderer
    html += '<div class="app-output-body" data-app-view-key="' + compEscAttr(key) + '">';
    if (value === null || value === undefined) {
      html += '<div class="app-output-empty">No value</div>';
    } else if (Array.isArray(value)) {
      html += renderAppArrayOutput(value, key, sectionKey, portDef);
    } else if (typeof value === 'object') {
      html += renderAppObjectOutput(value, key, sectionKey, portDef);
    } else if (typeof value === 'string' && isImageUrl(value)) {
      var resolvedImgVal = resolveImageSrc(value);
      html += '<div class="app-output-image app-img-zoomable" data-app-img-src="' + compEscAttr(resolvedImgVal) + '"><img src="' + compEscAttr(resolvedImgVal) + '" alt="" loading="lazy" /></div>';
    } else if (typeof value === 'string' && value.length > 200) {
      html += renderAppTextOutput(value, key);
    } else {
      html += '<div class="app-output-scalar">' + compEscHtml(String(value)) + '</div>';
    }
    html += '</div>';

    // Hidden edit area (shown when Edit is clicked)
    html += '<div class="app-output-editor" data-app-editor-key="' + compEscAttr(key) + '" style="display:none;">';
    html += renderAppFieldEditor(value, key, section.nodeId || '');
    html += '</div>';

    html += '</div>';
  }

  return html;
}

function renderAppArrayOutput(items, key, sectionKey, portDef) {
  if (items.length === 0) {
    return '<div class="app-output-empty">Empty list</div>';
  }

  var presentation = portDef && portDef.presentation ? portDef.presentation : null;

  // Use the existing rich renderer if available
  if (typeof renderCompositionRichValue === 'function') {
    var richHtml = renderCompositionRichValue(items, presentation, 'app-' + sectionKey, 'app.' + sectionKey + '.' + key);
    if (richHtml) {
      return '<div class="app-output-rich">' + richHtml + '</div>';
    }
  }

  // Fallback: simple card list
  var html = '<div class="app-array-list">';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    html += '<div class="app-array-card">';
    html += '<div class="app-array-card-index">' + (i + 1) + '</div>';
    if (item && typeof item === 'object') {
      var cardKeys = Object.keys(item).slice(0, 4);
      for (var j = 0; j < cardKeys.length; j++) {
        html += '<div class="app-array-card-field">';
        html += '<span class="app-array-card-label">' + compEscHtml(humanizeVarName(cardKeys[j])) + '</span>';
        html += '<span class="app-array-card-value">' + compEscHtml(formatCompositionPreviewValue(item[cardKeys[j]])) + '</span>';
        html += '</div>';
      }
    } else {
      html += '<div class="app-array-card-value">' + compEscHtml(String(item)) + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderAppObjectOutput(value, key, sectionKey, portDef) {
  var presentation = portDef && portDef.presentation ? portDef.presentation : null;

  // Detect complex nested objects: objects where at least one child is an
  // array with 3+ items or a nested object with 5+ keys. These get a
  // tabbed sub-panel instead of a flat grid or single rich render.
  var oKeys = Object.keys(value);
  var complexChildren = [];
  var scalarChildren = [];
  for (var ci = 0; ci < oKeys.length; ci++) {
    var ck = oKeys[ci];
    var cv = value[ck];
    if (Array.isArray(cv) && cv.length >= 3) {
      complexChildren.push({ key: ck, value: cv, type: 'array', count: cv.length });
    } else if (cv && typeof cv === 'object' && !Array.isArray(cv) && Object.keys(cv).length >= 5) {
      complexChildren.push({ key: ck, value: cv, type: 'object', count: Object.keys(cv).length });
    } else {
      scalarChildren.push({ key: ck, value: cv });
    }
  }

  // If the object has complex children, render as tabbed panel
  if (complexChildren.length >= 1 && oKeys.length > 1) {
    return renderAppTabbedPanel(value, key, sectionKey, portDef, scalarChildren, complexChildren);
  }

  // Use existing rich renderer
  if (typeof renderCompositionRichValue === 'function') {
    var richHtml = renderCompositionRichValue(value, presentation, 'app-' + sectionKey, 'app.' + sectionKey + '.' + key);
    if (richHtml) {
      return '<div class="app-output-rich">' + richHtml + '</div>';
    }
  }

  // Fallback: key-value grid
  var html = '<div class="app-kv-grid">';
  for (var i = 0; i < oKeys.length; i++) {
    html += '<div class="app-kv-row">';
    html += '<div class="app-kv-key">' + compEscHtml(humanizeVarName(oKeys[i])) + '</div>';
    html += '<div class="app-kv-value">' + compEscHtml(formatCompositionPreviewValue(value[oKeys[i]])) + '</div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

/**
 * Render a complex nested object as a tabbed panel.
 * Scalar/simple fields go into a summary row at the top,
 * each complex child (array or nested object) gets its own tab.
 */
function renderAppTabbedPanel(value, key, sectionKey, portDef, scalarChildren, complexChildren) {
  var panelId = 'app-panel-' + sectionKey + '-' + key;
  var html = '<div class="app-tabbed-panel" data-panel-id="' + compEscAttr(panelId) + '">';

  // Build tabs
  var allTabs = [];
  if (scalarChildren.length > 0) {
    allTabs.push({ id: '_summary', label: 'Summary', count: scalarChildren.length + ' fields', icon: 'summary' });
  }
  for (var t = 0; t < complexChildren.length; t++) {
    var cc = complexChildren[t];
    var countLabel = cc.type === 'array' ? cc.count + ' items' : cc.count + ' fields';
    allTabs.push({ id: cc.key, label: humanizeVarName(cc.key), count: countLabel, icon: cc.type });
  }

  html += '<div class="app-panel-tabs">';
  for (var ti = 0; ti < allTabs.length; ti++) {
    var tab = allTabs[ti];
    var activeClass = ti === 0 ? ' active' : '';
    html += '<button class="app-panel-tab' + activeClass + '" data-panel-tab="' + compEscAttr(tab.id) + '" data-panel-parent="' + compEscAttr(panelId) + '">';
    html += '<span class="app-panel-tab-label">' + compEscHtml(tab.label) + '</span>';
    html += '<span class="app-panel-tab-count">' + compEscHtml(tab.count) + '</span>';
    html += '</button>';
  }
  html += '</div>';

  // Tab content panels
  html += '<div class="app-panel-content">';

  // Summary panel (scalar fields)
  if (scalarChildren.length > 0) {
    html += '<div class="app-panel-pane active" data-panel-pane="_summary" data-panel-parent="' + compEscAttr(panelId) + '">';
    html += '<div class="app-kv-grid">';
    for (var si = 0; si < scalarChildren.length; si++) {
      var sc = scalarChildren[si];
      html += '<div class="app-kv-row">';
      html += '<div class="app-kv-key">' + compEscHtml(humanizeVarName(sc.key)) + '</div>';
      html += '<div class="app-kv-value">';
      if (sc.value === null || sc.value === undefined) {
        html += '<span style="opacity:0.4">—</span>';
      } else if (Array.isArray(sc.value)) {
        html += compEscHtml(sc.value.length + ' items');
      } else if (typeof sc.value === 'object') {
        html += compEscHtml(Object.keys(sc.value).length + ' fields');
      } else if (typeof sc.value === 'string' && sc.value.length > 200) {
        html += compEscHtml(sc.value.substring(0, 180) + '…');
      } else {
        html += compEscHtml(formatCompositionPreviewValue(sc.value));
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  // Complex child panels
  for (var pi = 0; pi < complexChildren.length; pi++) {
    var child = complexChildren[pi];
    var paneActive = (scalarChildren.length === 0 && pi === 0) ? ' active' : '';
    html += '<div class="app-panel-pane' + paneActive + '" data-panel-pane="' + compEscAttr(child.key) + '" data-panel-parent="' + compEscAttr(panelId) + '">';

    if (child.type === 'array') {
      html += renderAppPanelArray(child.value, child.key, sectionKey);
    } else {
      html += renderAppPanelObject(child.value, child.key, sectionKey);
    }

    html += '</div>';
  }

  html += '</div>'; // .app-panel-content
  html += '</div>'; // .app-tabbed-panel
  return html;
}

/** Render an array child inside a tabbed panel as a list of cards. */
function renderAppPanelArray(items, key, sectionKey) {
  if (!items || items.length === 0) {
    return '<div class="app-output-empty">Empty list</div>';
  }

  // Detect item shape for smart rendering
  var sample = items[0];
  var isObjectArray = sample && typeof sample === 'object' && !Array.isArray(sample);

  if (!isObjectArray) {
    // Simple value array — render as tags/chips
    var html = '<div class="app-panel-chip-list">';
    for (var i = 0; i < items.length; i++) {
      html += '<span class="app-panel-chip">' + compEscHtml(formatCompositionPreviewValue(items[i])) + '</span>';
    }
    html += '</div>';
    return html;
  }

  // Object array — find best fields for card layout
  var sampleKeys = Object.keys(sample);
  var titleKey = findBestField(sampleKeys, ['name', 'title', 'label', 'heading', 'displayName', 'slug', 'id']);
  var descKey = findBestField(sampleKeys, ['description', 'desc', 'summary', 'text', 'content', 'body', 'bio', 'notes']);
  var typeKey = findBestField(sampleKeys, ['type', 'category', 'kind', 'role', 'status', 'tag']);
  var imageKey = findBestField(sampleKeys, ['image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'photo', 'avatar', 'src', 'url', 'filePath', 'path']);
  var idKey = findBestField(sampleKeys, ['id', 'libraryId', 'assetId', 'slug']);

  // Filter and search bar for large lists
  var html = '';
  if (items.length > 10) {
    html += '<div class="app-panel-filter-bar">';
    html += '<input type="text" class="app-panel-filter-input" placeholder="Filter ' + humanizeVarName(key) + '…" data-panel-filter="' + compEscAttr(key) + '" />';
    html += '<span class="app-panel-filter-count">' + items.length + ' items</span>';
    html += '</div>';
  }

  html += '<div class="app-panel-card-grid" data-panel-cards="' + compEscAttr(key) + '">';
  for (var ci = 0; ci < items.length; ci++) {
    var item = items[ci];
    html += '<div class="app-panel-card" data-panel-card-index="' + ci + '">';

    // Image if found
    var imgVal = imageKey ? item[imageKey] : null;
    if (imgVal && typeof imgVal === 'string' && isImageUrl(imgVal)) {
      var resolvedImg = resolveImageSrc(imgVal);
      html += '<div class="app-panel-card-image app-img-zoomable" data-app-img-src="' + compEscAttr(resolvedImg) + '"><img src="' + compEscAttr(resolvedImg) + '" loading="lazy" alt="" /></div>';
    }

    html += '<div class="app-panel-card-body">';
    // Title
    var itemTitle = titleKey ? item[titleKey] : (idKey ? item[idKey] : 'Item ' + (ci + 1));
    html += '<div class="app-panel-card-title">' + compEscHtml(String(itemTitle || 'Item ' + (ci + 1))) + '</div>';

    // ID badge
    if (idKey && idKey !== titleKey && item[idKey]) {
      html += '<div class="app-panel-card-id">' + compEscHtml(String(item[idKey])) + '</div>';
    }

    // Description
    if (descKey && item[descKey]) {
      var descText = String(item[descKey]);
      if (descText.length > 140) descText = descText.substring(0, 140) + '…';
      html += '<div class="app-panel-card-desc">' + compEscHtml(descText) + '</div>';
    }

    // Type badge
    if (typeKey && item[typeKey]) {
      html += '<div class="app-panel-card-type">' + compEscHtml(String(item[typeKey])) + '</div>';
    }

    // Additional fields (show remaining keys as small metadata)
    var shownKeys = new Set([titleKey, descKey, typeKey, imageKey, idKey].filter(Boolean));
    var metaKeys = sampleKeys.filter(function(k) { return !shownKeys.has(k); });
    if (metaKeys.length > 0) {
      html += '<div class="app-panel-card-meta">';
      for (var mi = 0; mi < Math.min(metaKeys.length, 4); mi++) {
        var mk = metaKeys[mi];
        var mv = item[mk];
        if (mv === null || mv === undefined) continue;
        var mvStr = (typeof mv === 'object') ? (Array.isArray(mv) ? mv.length + ' items' : Object.keys(mv).length + ' fields') : String(mv);
        if (mvStr.length > 60) mvStr = mvStr.substring(0, 60) + '…';
        html += '<div class="app-panel-card-meta-row">';
        html += '<span class="app-panel-card-meta-key">' + compEscHtml(humanizeVarName(mk)) + '</span>';
        html += '<span class="app-panel-card-meta-val">' + compEscHtml(mvStr) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Raw item button — opens in modal
    html += '<button class="app-panel-card-raw-btn" data-app-raw-index="' + ci + '" data-app-raw-key="' + compEscAttr(key) + '">&#x25B8; Raw Item</button>';

    html += '</div>'; // .app-panel-card-body
    html += '</div>'; // .app-panel-card
  }
  html += '</div>';
  return html;
}

/** Render a nested object child inside a tabbed panel. */
function renderAppPanelObject(value, key, sectionKey) {
  var oKeys = Object.keys(value);

  // Check if any children are also complex
  var nestedComplex = [];
  var simpleFields = [];
  for (var i = 0; i < oKeys.length; i++) {
    var v = value[oKeys[i]];
    if (Array.isArray(v) && v.length >= 3) {
      nestedComplex.push({ key: oKeys[i], value: v, type: 'array', count: v.length });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length >= 5) {
      nestedComplex.push({ key: oKeys[i], value: v, type: 'object', count: Object.keys(v).length });
    } else {
      simpleFields.push({ key: oKeys[i], value: v });
    }
  }

  var html = '';

  // Simple fields as a KV grid
  if (simpleFields.length > 0) {
    html += '<div class="app-kv-grid">';
    for (var si = 0; si < simpleFields.length; si++) {
      var sf = simpleFields[si];
      html += '<div class="app-kv-row">';
      html += '<div class="app-kv-key">' + compEscHtml(humanizeVarName(sf.key)) + '</div>';
      html += '<div class="app-kv-value">' + compEscHtml(formatCompositionPreviewValue(sf.value)) + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Nested complex children as sub-sections
  for (var ni = 0; ni < nestedComplex.length; ni++) {
    var nc = nestedComplex[ni];
    html += '<div class="app-panel-subsection">';
    html += '<h4 class="app-panel-subsection-title">' + compEscHtml(humanizeVarName(nc.key));
    html += ' <span class="app-panel-subsection-count">' + (nc.type === 'array' ? nc.count + ' items' : nc.count + ' fields') + '</span>';
    html += '</h4>';
    if (nc.type === 'array') {
      html += renderAppPanelArray(nc.value, nc.key, sectionKey);
    } else {
      html += renderAppPanelObject(nc.value, nc.key, sectionKey);
    }
    html += '</div>';
  }

  return html;
}

/** Check if a string looks like an image URL or file path. */
function isImageUrl(str) {
  if (!str || typeof str !== 'string') return false;
  if (str.startsWith('data:image')) return true;
  // Common image extensions (works for URLs, file paths, etc.)
  var lower = str.toLowerCase().split('?')[0].split('#')[0];
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif|ico|tiff?)$/.test(lower);
}

/**
 * Convert an image source to a displayable URL.
 * Local file paths get routed through /api/file?path=...
 * HTTP URLs and data URIs pass through unchanged.
 */
function resolveImageSrc(src) {
  if (!src || typeof src !== 'string') return '';
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) {
    return src;
  }
  // Local file paths → serve via dashboard file API
  return '/api/file?path=' + encodeURIComponent(src);
}

/** Find the best matching field name from a list of candidates. */
function findBestField(keys, candidates) {
  // Exact match first
  for (var i = 0; i < candidates.length; i++) {
    if (keys.indexOf(candidates[i]) !== -1) return candidates[i];
  }
  // Case-insensitive match
  var lowerKeys = keys.map(function(k) { return k.toLowerCase(); });
  for (var j = 0; j < candidates.length; j++) {
    var idx = lowerKeys.indexOf(candidates[j].toLowerCase());
    if (idx !== -1) return keys[idx];
  }
  // Substring match (e.g. "thumbnailUrl" matches "thumbnail")
  for (var ci = 0; ci < candidates.length; ci++) {
    for (var ki = 0; ki < keys.length; ki++) {
      if (keys[ki].toLowerCase().indexOf(candidates[ci].toLowerCase()) !== -1) return keys[ki];
    }
  }
  return null;
}

function renderAppTextOutput(text, key) {
  // Check for markdown
  if (typeof marked !== 'undefined' && /^#\s|^##\s|\*\*.+\*\*|^-\s|^\d+\.\s|```/m.test(text)) {
    return '<div class="app-output-markdown">' + marked.parse(text) + '</div>';
  }
  return '<pre class="app-output-text">' + compEscHtml(text) + '</pre>';
}

function renderAppFieldEditor(value, key, nodeId) {
  var html = '';
  if (Array.isArray(value)) {
    html += '<textarea class="app-editor-textarea" data-app-editor-field="' + compEscAttr(key) + '" rows="12">' + compEscHtml(JSON.stringify(value, null, 2)) + '</textarea>';
    html += '<p class="app-editor-hint">Edit the JSON array above. Changes will mark downstream sections as stale.</p>';
  } else if (value && typeof value === 'object') {
    html += '<textarea class="app-editor-textarea" data-app-editor-field="' + compEscAttr(key) + '" rows="12">' + compEscHtml(JSON.stringify(value, null, 2)) + '</textarea>';
    html += '<p class="app-editor-hint">Edit the JSON object above.</p>';
  } else if (typeof value === 'string' && value.length > 100) {
    html += '<textarea class="app-editor-textarea" data-app-editor-field="' + compEscAttr(key) + '" rows="8">' + compEscHtml(value) + '</textarea>';
  } else {
    html += '<input type="text" class="app-editor-input" data-app-editor-field="' + compEscAttr(key) + '" value="' + compEscAttr(String(value || '')) + '" />';
  }
  html += '<div class="app-editor-actions">';
  html += '<button class="app-editor-save" data-app-save-key="' + compEscAttr(key) + '" data-app-save-node="' + compEscAttr(nodeId) + '">Save</button>';
  html += '<button class="app-editor-cancel" data-app-cancel-key="' + compEscAttr(key) + '">Cancel</button>';
  html += '</div>';
  return html;
}

// ────────────────────────────────────────────────────────────────
//  Main page render
// ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
async function renderCompositionAppPage() {
  if (!compData) return;

  var main = document.querySelector('#main');
  if (!main) return;

  // Show loading state
  main.innerHTML = '<div class="app-loading"><div class="spinner"></div> Loading app...</div>';

  // Fetch schema and state in parallel
  var results = await Promise.all([
    fetchAppSchema(compData.id),
    fetchAppState(compData.id),
  ]);
  appSchema = results[0];
  appState = results[1];

  if (!appSchema) {
    main.innerHTML = '<div class="app-error">Failed to load pipeline schema.</div>';
    return;
  }
  if (!appState) {
    appState = {
      pipelineId: compData.id,
      pipelineName: compData.name || 'Untitled',
      sourceRunId: null,
      nodeData: {},
      staleNodes: [],
      lastRunAt: null,
    };
  }

  // Default to first section with data, or overview, or settings
  if (!appActiveSection || !appSchema.sections.find(function(s) { return s.id === appActiveSection; })) {
    // Prefer overview if it has data
    var overviewSection = appSchema.sections.find(function(s) { return s.type === 'overview'; });
    if (overviewSection && appState.nodeData[overviewSection.nodeId]) {
      appActiveSection = overviewSection.id;
    } else {
      // Find first section with data
      var firstWithData = appSchema.sections.find(function(s) {
        return s.nodeId && appState.nodeData[s.nodeId];
      });
      appActiveSection = firstWithData ? firstWithData.id : (appSchema.sections[0] ? appSchema.sections[0].id : null);
    }
  }

  // Render
  var html = '<div class="app-shell">';
  html += renderAppSidebar(appSchema, appState);

  // Content area
  html += '<div class="app-content">';
  if (appActiveSection) {
    var activeSection = appSchema.sections.find(function(s) { return s.id === appActiveSection; });
    if (activeSection) {
      html += renderAppSectionContent(activeSection, appState);
    }
  } else {
    html += '<div class="app-empty-state">';
    html += '<div class="app-empty-icon">&#x1f680;</div>';
    html += '<h3>Welcome to ' + compEscHtml(appSchema.name) + '</h3>';
    html += '<p>Run the pipeline to get started, then explore and edit the results here.</p>';
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  // Detail modal (image or JSON — singleton, appended once)
  html += '<div class="app-detail-modal" id="app-detail-modal">';
  html += '<div class="app-detail-modal-backdrop"></div>';
  html += '<div class="app-detail-modal-container">';
  html += '<button class="app-detail-modal-close" id="app-detail-modal-close">&times;</button>';
  html += '<div class="app-detail-modal-body" id="app-detail-modal-body"></div>';
  html += '</div>';
  html += '</div>';

  main.innerHTML = html;
  wireAppActions(main);
}

// ────────────────────────────────────────────────────────────────
//  Event wiring
// ────────────────────────────────────────────────────────────────

function wireAppActions(root) {
  // Sidebar navigation
  root.querySelectorAll('.app-nav-item').forEach(function(btn) {
    btn.addEventListener('click', function() {
      appActiveSection = btn.getAttribute('data-app-section');
      renderCompositionAppPage();
    });
  });

  // Open Editor button
  var editorBtn = root.querySelector('#app-open-editor');
  if (editorBtn) {
    editorBtn.addEventListener('click', function() {
      if (typeof updateHash === 'function') updateHash('compositions', compData.id);
      selectComposition(compData.id, null);
    });
  }

  // Open Form button
  var formBtn = root.querySelector('#app-open-form');
  if (formBtn) {
    formBtn.addEventListener('click', function() {
      if (typeof updateHash === 'function') updateHash('compositions', compData.id, 'form');
      selectComposition(compData.id, 'form');
    });
  }

  // Run Pipeline button
  var runBtn = root.querySelector('#app-run-pipeline');
  if (runBtn) {
    runBtn.addEventListener('click', function() {
      if (typeof showCompositionRunForm === 'function') {
        showCompositionRunForm();
      }
    });
  }

  // Refresh stale button
  var refreshBtn = root.querySelector('#app-refresh-stale');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function() {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      try {
        var updated = await refreshAppFromRun(compData.id);
        if (updated) {
          appState = updated;
          toast('App state refreshed from latest run', 'success');
          renderCompositionAppPage();
        } else {
          toast('No completed runs found to refresh from', 'error');
        }
      } catch (err) {
        toast('Refresh failed: ' + (err.message || err), 'error');
      }
      refreshBtn.disabled = false;
    });
  }

  // Edit buttons
  root.querySelectorAll('.app-output-edit-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.getAttribute('data-app-edit-key');
      var viewEl = root.querySelector('[data-app-view-key="' + key + '"]');
      var editorEl = root.querySelector('[data-app-editor-key="' + key + '"]');
      if (viewEl) viewEl.style.display = 'none';
      if (editorEl) editorEl.style.display = 'block';
      btn.style.display = 'none';
    });
  });

  // Save buttons
  root.querySelectorAll('.app-editor-save').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var key = btn.getAttribute('data-app-save-key');
      var nodeId = btn.getAttribute('data-app-save-node');
      if (!key || !nodeId) return;

      // Get the edited value
      var field = root.querySelector('[data-app-editor-field="' + key + '"]');
      if (!field) return;

      var rawValue = field.value;
      var parsedValue;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        parsedValue = rawValue;
      }

      // Build updated outputs for this node
      var currentOutputs = (appState.nodeData && appState.nodeData[nodeId])
        ? Object.assign({}, appState.nodeData[nodeId].outputs)
        : {};
      currentOutputs[key] = parsedValue;

      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        var result = await saveAppNodeState(compData.id, nodeId, currentOutputs);
        // Update local state
        if (!appState.nodeData) appState.nodeData = {};
        appState.nodeData[nodeId] = {
          outputs: currentOutputs,
          updatedAt: result.updatedAt || new Date().toISOString(),
          manuallyEdited: true,
        };
        appState.staleNodes = result.staleNodes || [];
        toast('Saved — ' + (result.staleNodes || []).length + ' downstream section(s) marked stale', 'success');
        renderCompositionAppPage();
      } catch (err) {
        toast('Save failed: ' + (err.message || err), 'error');
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  });

  // Cancel buttons
  root.querySelectorAll('.app-editor-cancel').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.getAttribute('data-app-cancel-key');
      var viewEl = root.querySelector('[data-app-view-key="' + key + '"]');
      var editorEl = root.querySelector('[data-app-editor-key="' + key + '"]');
      var editBtn = root.querySelector('[data-app-edit-key="' + key + '"]');
      if (viewEl) viewEl.style.display = '';
      if (editorEl) editorEl.style.display = 'none';
      if (editBtn) editBtn.style.display = '';
    });
  });

  // Copy buttons
  root.querySelectorAll('.app-output-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.getAttribute('data-app-copy-key');
      var activeSection = appSchema.sections.find(function(s) { return s.id === appActiveSection; });
      if (!activeSection || !activeSection.nodeId || !appState.nodeData[activeSection.nodeId]) return;
      var value = appState.nodeData[activeSection.nodeId].outputs[key];
      var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          toast('Copied to clipboard', 'success');
        });
      }
    });
  });

  // Regenerate buttons
  root.querySelectorAll('[data-app-regenerate]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      toast('Regeneration will be available after running the pipeline. Use "Run Pipeline" to regenerate all outputs.', 'info');
    });
  });

  // Command bar
  var commandInput = root.querySelector('#app-command-input');
  if (commandInput) {
    commandInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var text = commandInput.value.trim();
        if (!text) return;
        commandInput.value = '';
        toast('Commands will be available soon. For now, use the edit buttons on each section.', 'info');
      }
    });
  }

  // Tabbed panel tab switching
  root.querySelectorAll('.app-panel-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var panelId = tab.getAttribute('data-panel-parent');
      var targetPane = tab.getAttribute('data-panel-tab');
      var panel = root.querySelector('[data-panel-id="' + panelId + '"]');
      if (!panel) return;

      // Switch active tab
      panel.querySelectorAll('.app-panel-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');

      // Switch active pane
      panel.querySelectorAll('.app-panel-pane').forEach(function(p) {
        if (p.getAttribute('data-panel-parent') === panelId) {
          p.classList.toggle('active', p.getAttribute('data-panel-pane') === targetPane);
        }
      });
    });
  });

  // Panel filter inputs
  root.querySelectorAll('.app-panel-filter-input').forEach(function(input) {
    input.addEventListener('input', function() {
      var filterKey = input.getAttribute('data-panel-filter');
      var grid = root.querySelector('[data-panel-cards="' + filterKey + '"]');
      if (!grid) return;
      var query = input.value.toLowerCase().trim();
      var cards = grid.querySelectorAll('.app-panel-card');
      var shown = 0;
      cards.forEach(function(card) {
        var text = card.textContent.toLowerCase();
        var match = !query || text.indexOf(query) !== -1;
        card.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      // Update count
      var countEl = input.parentElement.querySelector('.app-panel-filter-count');
      if (countEl) {
        countEl.textContent = shown + ' of ' + cards.length + ' items';
      }
    });
  });

  // Detail modal — general-purpose (images, raw JSON, etc.)
  var modal = root.querySelector('#app-detail-modal');
  var modalBody = root.querySelector('#app-detail-modal-body');
  var modalClose = root.querySelector('#app-detail-modal-close');
  var modalBackdrop = root.querySelector('.app-detail-modal-backdrop');

  function openDetailModal(contentHtml, mode) {
    if (!modal || !modalBody) return;
    modalBody.innerHTML = contentHtml;
    modal.className = 'app-detail-modal open' + (mode ? ' app-detail-modal--' + mode : '');
    document.body.style.overflow = 'hidden';
  }

  function closeDetailModal() {
    if (!modal) return;
    modal.classList.remove('open');
    modalBody.innerHTML = '';
    document.body.style.overflow = '';
  }

  if (modalClose) {
    modalClose.addEventListener('click', closeDetailModal);
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeDetailModal);
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeDetailModal();
    }
  });

  // Wire zoomable images (card thumbnails)
  root.querySelectorAll('.app-img-zoomable').forEach(function(el) {
    el.addEventListener('click', function() {
      var src = el.getAttribute('data-app-img-src');
      if (src) {
        openDetailModal('<img class="app-detail-modal-img" src="' + compEscAttr(src) + '" alt="" />', 'image');
      }
    });
  });

  // Inline images in output bodies
  root.querySelectorAll('.app-output-body img, .app-output-rich img, .app-panel-pane img').forEach(function(img) {
    if (img.closest('.app-img-zoomable')) return;
    img.classList.add('app-img-inline-zoomable');
    img.addEventListener('click', function(e) {
      e.stopPropagation();
      openDetailModal('<img class="app-detail-modal-img" src="' + compEscAttr(img.src) + '" alt="" />', 'image');
    });
  });

  // Raw Item buttons — open JSON in modal
  root.querySelectorAll('.app-panel-card-raw-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var cardIndex = parseInt(btn.getAttribute('data-app-raw-index'), 10);
      var cardKey = btn.getAttribute('data-app-raw-key');
      // Find the item data from the current section's state
      var item = findPanelItemData(cardKey, cardIndex);
      if (!item) { toast('Could not load raw data', 'error'); return; }

      var title = item.name || item.title || item.label || item.id || ('Item ' + (cardIndex + 1));
      var jsonStr = JSON.stringify(item, null, 2);
      var html = '<div class="app-detail-modal-header">';
      html += '<h3 class="app-detail-modal-title">' + compEscHtml(String(title)) + '</h3>';
      html += '<button class="app-detail-modal-copy-btn" id="app-modal-copy-json">&#x1f4cb; Copy JSON</button>';
      html += '</div>';
      html += '<pre class="app-detail-modal-json">' + compEscHtml(jsonStr) + '</pre>';
      openDetailModal(html, 'json');

      // Wire copy button inside modal
      var copyBtn = document.getElementById('app-modal-copy-json');
      if (copyBtn) {
        copyBtn.addEventListener('click', function() {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(jsonStr).then(function() {
              copyBtn.textContent = '✓ Copied';
              setTimeout(function() { copyBtn.innerHTML = '&#x1f4cb; Copy JSON'; }, 1500);
            });
          }
        });
      }
    });
  });

  /**
   * Find the raw item data for a card by walking the current section's output state.
   * Searches for arrays matching the cardKey within the active section's node data.
   */
  function findPanelItemData(cardKey, index) {
    if (!appState || !appSchema || !appActiveSection) return null;
    var section = appSchema.sections.find(function(s) { return s.id === appActiveSection; });
    if (!section || !section.nodeId) return null;
    var nodeData = appState.nodeData && appState.nodeData[section.nodeId];
    if (!nodeData || !nodeData.outputs) return null;
    // Recursively search for an array at the given key
    function search(obj) {
      if (!obj || typeof obj !== 'object') return null;
      for (var k in obj) {
        if (k === cardKey && Array.isArray(obj[k]) && obj[k][index] !== undefined) {
          return obj[k][index];
        }
        if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
          var found = search(obj[k]);
          if (found) return found;
        }
      }
      return null;
    }
    return search(nodeData.outputs);
  }

  // Wire up existing composition result actions (copy, tabs, filters)
  if (typeof wireCompositionResultActions === 'function') {
    wireCompositionResultActions(root);
  }

  // Intercept existing <details> "Raw Item" toggles from the rich renderer
  // and open them in the modal instead of expanding inline.
  root.querySelectorAll('.app-output-body details summary, .app-output-rich details summary, .app-panel-pane details summary').forEach(function(summary) {
    var details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS') return;
    var text = summary.textContent.trim().toLowerCase();
    if (text !== 'raw item' && text !== '▸ raw item' && text !== '▾ raw item') return;

    summary.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      // Find card context for title
      var card = details.closest('.app-panel-card, .comp-form-rich-card, .comp-form-array-card, [class*="card"]');
      var titleEl = card ? card.querySelector('[class*="title"], [class*="name"], h3, h4, strong') : null;
      var title = titleEl ? titleEl.textContent.trim() : 'Raw Item';

      // Try to find the data from appState by detecting the card's index
      var jsonStr = '';
      var itemData = findRawItemFromDetails(details);
      if (itemData) {
        jsonStr = JSON.stringify(itemData, null, 2);
      } else {
        // Fallback: temporarily open details to extract pre/code content
        var wasOpen = details.open;
        details.open = true;
        var pre = details.querySelector('pre');
        if (pre) {
          jsonStr = pre.textContent || '';
        } else {
          // Last resort: extract from JSON viewer
          var viewer = details.querySelector('.comp-form-json-viewer');
          if (viewer) jsonStr = viewer.innerText || viewer.textContent || '';
        }
        details.open = wasOpen;
      }

      var html = '<div class="app-detail-modal-header">';
      html += '<h3 class="app-detail-modal-title">' + compEscHtml(title) + '</h3>';
      html += '<button class="app-detail-modal-copy-btn" id="app-modal-copy-json">&#x1f4cb; Copy JSON</button>';
      html += '</div>';
      html += '<pre class="app-detail-modal-json">' + compEscHtml(jsonStr) + '</pre>';
      openDetailModal(html, 'json');

      var copyBtn = document.getElementById('app-modal-copy-json');
      if (copyBtn) {
        copyBtn.addEventListener('click', function() {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(jsonStr).then(function() {
              copyBtn.textContent = '✓ Copied';
              setTimeout(function() { copyBtn.innerHTML = '&#x1f4cb; Copy JSON'; }, 1500);
            });
          }
        });
      }
    });
  });

  /**
   * Try to find the raw item data for a <details> "Raw Item" toggle by
   * locating its position within the card grid and looking up the data
   * from appState.
   */
  function findRawItemFromDetails(detailsEl) {
    if (!appState || !appSchema || !appActiveSection) return null;
    var section = appSchema.sections.find(function(s) { return s.id === appActiveSection; });
    if (!section || !section.nodeId) return null;
    var nodeData = appState.nodeData && appState.nodeData[section.nodeId];
    if (!nodeData || !nodeData.outputs) return null;

    // Find the card's index among its siblings
    var card = detailsEl.closest('.comp-form-rich-card, .comp-form-array-card, [class*="card"]');
    if (!card) return null;
    var parent = card.parentElement;
    if (!parent) return null;
    var siblings = parent.querySelectorAll(':scope > ' + card.tagName + '.' + card.className.split(' ')[0]);
    var idx = -1;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === card) { idx = i; break; }
    }
    if (idx === -1) return null;

    // Find the first array in outputs at that index
    var outputs = nodeData.outputs;
    function findArray(obj) {
      if (!obj || typeof obj !== 'object') return null;
      for (var k in obj) {
        var v = obj[k];
        if (Array.isArray(v) && v.length > idx && v[idx] && typeof v[idx] === 'object') {
          return v[idx];
        }
        if (typeof v === 'object' && !Array.isArray(v)) {
          var found = findArray(v);
          if (found) return found;
        }
      }
      return null;
    }
    return findArray(outputs);
  }
}

// Make the render function globally available
if (typeof window !== 'undefined') {
  window.renderCompositionAppPage = renderCompositionAppPage;
}
