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
var appBindings = null; // BindingsDocument { version, pipelineId, bindings[] }
var appActiveSection = null;
var appViewMode = 'data'; // 'data' | 'screenplay' | 'voices'
// Voice view moved to pipeline-local: {pipelineDir}/views/voices/
var appConnectionMode = false; // When true, entities become selectable for binding creation
var appConnectionSelections = []; // Array of { entityType, entityId, label, sectionId, data }
var appNodesPanelCollapsed = false; // Collapsible "Node" panel state
var appCustomViews = []; // Pipeline-local custom views: [{ name, label, icon, loaded, detect, stitch, render, wireEvents }]
var appCustomViewsLoaded = false; // Whether we've loaded custom views for this pipeline
var appCustomViewsPipelineId = null; // Which pipeline the custom views were loaded for

// ────────────────────────────────────────────────────────────────
//  Pipeline-local custom view registration API
// ────────────────────────────────────────────────────────────────

// Global API for pipeline-local views to register themselves.
//
// Usage in {pipelineDir}/views/my-view/view.js:
//
//   window.registerPipelineView({
//     name: 'my-view',         // Must match directory name
//     label: 'My View',        // Display name for toggle button
//     icon: '<svg .../>',      // Optional SVG icon HTML
//     detect: function(state) { return true/false; },
//     stitch: function(state) { return stitchedData; },
//     render: function(data, state) { return '<div>...</div>'; },
//     wireEvents: function(root, state) { ... },
//   });
window.registerPipelineView = function(viewDef) {
  if (!viewDef || !viewDef.name) {
    console.error('[pipeline-view] registerPipelineView: missing name');
    return;
  }
  // Find the placeholder entry and fill it in
  var found = false;
  for (var i = 0; i < appCustomViews.length; i++) {
    if (appCustomViews[i].name === viewDef.name) {
      appCustomViews[i].label = viewDef.label || appCustomViews[i].label;
      appCustomViews[i].icon = viewDef.icon || appCustomViews[i].icon || '';
      appCustomViews[i].detect = viewDef.detect || function() { return true; };
      appCustomViews[i].stitch = viewDef.stitch || function(s) { return s; };
      appCustomViews[i].render = viewDef.render || function() { return '<div>Custom view</div>'; };
      appCustomViews[i].wireEvents = viewDef.wireEvents || function() {};
      appCustomViews[i].loaded = true;
      found = true;
      break;
    }
  }
  if (!found) {
    // Direct registration (not pre-discovered)
    appCustomViews.push({
      name: viewDef.name,
      label: viewDef.label || viewDef.name,
      icon: viewDef.icon || '',
      hasCSS: false,
      loaded: true,
      detect: viewDef.detect || function() { return true; },
      stitch: viewDef.stitch || function(s) { return s; },
      render: viewDef.render || function() { return '<div>Custom view</div>'; },
      wireEvents: viewDef.wireEvents || function() {},
    });
  }
  console.log('[pipeline-view] Registered:', viewDef.name);
};

/**
 * Discover and load pipeline-local custom views.
 * Fetches the view manifest, then dynamically loads each view's JS (and CSS).
 */
async function loadPipelineCustomViews(pipelineId) {
  try {
    var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/views');
    if (!res.ok) return;
    var data = await res.json();
    var views = data.views || [];

    if (views.length === 0) return;

    // Create placeholder entries so registerPipelineView can find them
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var existing = appCustomViews.find(function(cv) { return cv.name === v.name; });
      if (!existing) {
        appCustomViews.push({
          name: v.name,
          label: v.label || v.name,
          icon: v.icon || '',
          hasCSS: v.hasCSS,
          description: v.description,
          loaded: false,
          detect: function() { return true; },
          stitch: function(s) { return s; },
          render: function() { return '<div class="app-empty-state">View loading...</div>'; },
          wireEvents: function() {},
        });
      }
    }

    // Load CSS files — scoped to this view's container so they don't leak
    for (var ci = 0; ci < views.length; ci++) {
      if (views[ci].hasCSS) {
        (function(viewName) {
          var cssId = 'pipeline-view-css-' + viewName;
          if (document.getElementById(cssId)) return;
          // Fetch CSS, prepend scoping selector to every rule
          fetch('/api/app/' + encodeURIComponent(pipelineId) + '/view-file/' + encodeURIComponent(viewName) + '/view.css')
            .then(function(r) { return r.text(); })
            .then(function(css) {
              var scope = '.pipeline-view-scope[data-pipeline-view="' + viewName + '"]';
              // Strip CSS comments, then scope each selector block
              var stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
              // Parse rule by rule: find selector { ... } blocks
              var scoped = '';
              var depth = 0;
              var buf = '';
              var inRule = false;
              for (var ci2 = 0; ci2 < stripped.length; ci2++) {
                var ch = stripped[ci2];
                if (ch === '{') {
                  if (depth === 0) {
                    // buf contains the selector — scope it
                    var sels = buf.split(',').map(function(s) {
                      s = s.trim();
                      if (!s || s.startsWith('@')) return s;
                      return scope + ' ' + s;
                    }).join(', ');
                    scoped += sels + ' {';
                    buf = '';
                    inRule = true;
                  } else {
                    scoped += ch;
                  }
                  depth++;
                } else if (ch === '}') {
                  depth--;
                  if (depth <= 0) {
                    scoped += buf + '}';
                    buf = '';
                    inRule = false;
                    depth = 0;
                  } else {
                    scoped += ch;
                  }
                } else if (inRule) {
                  buf += ch;
                } else {
                  buf += ch;
                }
              }
              var style = document.createElement('style');
              style.id = cssId;
              style.textContent = scoped;
              document.head.appendChild(style);
            })
            .catch(function(err) { console.error('[pipeline-view] CSS load error:', viewName, err); });
        })(views[ci].name);
      }
    }

    // Load JS files (these call window.registerPipelineView when they execute)
    var loadPromises = views.map(function(v) {
      return new Promise(function(resolve) {
        var scriptId = 'pipeline-view-js-' + v.name;
        if (document.getElementById(scriptId)) { resolve(); return; }
        var script = document.createElement('script');
        script.id = scriptId;
        script.src = '/api/app/' + encodeURIComponent(pipelineId) + '/view-file/' + encodeURIComponent(v.name) + '/view.js';
        script.onload = resolve;
        script.onerror = function() {
          console.error('[pipeline-view] Failed to load:', v.name);
          resolve();
        };
        document.body.appendChild(script);
      });
    });

    await Promise.all(loadPromises);
  } catch (err) {
    console.error('[pipeline-view] Failed to discover views:', err);
  }
}

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

async function fetchAppBindings(pipelineId) {
  try {
    var res = await fetch('/api/app/' + encodeURIComponent(pipelineId) + '/bindings');
    if (!res.ok) return { version: '1.0', pipelineId: pipelineId, bindings: [] };
    return res.json();
  } catch (e) {
    return { version: '1.0', pipelineId: pipelineId, bindings: [] };
  }
}

async function createAppBinding(pipelineId, binding) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(pipelineId) + '/bindings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(binding),
  });
  if (!res.ok) throw new Error('Failed to create binding');
  return res.json();
}

async function deleteAppBinding(pipelineId, bindingId) {
  var res = await fetch('/api/compositions/' + encodeURIComponent(pipelineId) + '/bindings/' + encodeURIComponent(bindingId), {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete binding');
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
/**
 * Render a single navigation item for the sidebar.
 */
function renderAppNavItem(section, state, staleSet) {
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

  var html = '<button class="app-nav-item' + (isActive ? ' active' : '') + (isStale ? ' stale' : '') + '"';
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
  return html;
}

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

  // Separate Overview from other sections
  var overviewSection = null;
  var nodeSections = [];
  for (var i = 0; i < schema.sections.length; i++) {
    var section = schema.sections[i];
    if (section.type === 'overview') {
      overviewSection = section;
    } else {
      nodeSections.push(section);
    }
  }

  // Render Overview section first (outside the collapsible panel)
  if (overviewSection) {
    html += renderAppNavItem(overviewSection, state, staleSet);
  }

  // Render "Node" collapsible panel containing Settings through Final Assembly
  if (nodeSections.length > 0) {
    html += '<div class="app-nav-panel' + (appNodesPanelCollapsed ? ' collapsed' : '') + '" data-panel="nodes">';
    html += '<button class="app-nav-panel-header" id="app-nodes-panel-toggle">';
    html += '<span class="app-nav-panel-icon">' + (appNodesPanelCollapsed ? '&#x25B6;' : '&#x25BC;') + '</span>';
    html += '<span class="app-nav-panel-title">Node</span>';
    html += '<span class="app-nav-panel-count">' + nodeSections.length + '</span>';
    html += '</button>';
    html += '<div class="app-nav-panel-body"' + (appNodesPanelCollapsed ? ' style="display:none;"' : '') + '>';
    for (var j = 0; j < nodeSections.length; j++) {
      html += renderAppNavItem(nodeSections[j], state, staleSet);
    }
    html += '</div>';
    html += '</div>';
  }

  html += '</nav>';

  // View mode toggle
  // Collect available views: built-in + pipeline-local custom views
  var hasScreenplayData = detectScreenplayData(state);
  var availableCustomViews = appCustomViews.filter(function(cv) {
    try { return cv.loaded && cv.detect(state); } catch(e) { return false; }
  });
  var hasMultipleViews = hasScreenplayData || availableCustomViews.length > 0;

  if (hasMultipleViews) {
    html += '<div class="app-view-toggle">';
    // Data view (always available)
    html += '<button class="app-view-toggle-btn' + (appViewMode === 'data' ? ' active' : '') + '" data-app-view-mode="data">';
    html += '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
    html += ' Data</button>';
    // Screenplay (built-in, shown if data matches)
    if (hasScreenplayData) {
      html += '<button class="app-view-toggle-btn' + (appViewMode === 'screenplay' ? ' active' : '') + '" data-app-view-mode="screenplay">';
      html += '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M5 5h6M5 8h4M5 11h5"/></svg>';
      html += ' Screenplay</button>';
    }
    // Pipeline-local custom views
    for (var cvi = 0; cvi < availableCustomViews.length; cvi++) {
      var cv = availableCustomViews[cvi];
      html += '<button class="app-view-toggle-btn' + (appViewMode === 'custom:' + cv.name ? ' active' : '') + '" data-app-view-mode="custom:' + compEscAttr(cv.name) + '">';
      if (cv.icon) html += cv.icon + ' ';
      html += compEscHtml(cv.label) + '</button>';
    }
    html += '</div>';
  }

  // Connection Mode toggle
  html += '<div class="app-connection-toggle">';
  html += '<button class="app-connection-toggle-btn' + (appConnectionMode ? ' active' : '') + '" id="app-toggle-connection-mode" title="Enter connection mode to link entities together">';
  html += '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.5 5.5l5 5"/></svg>';
  html += ' Connections';
  if (appConnectionMode && appConnectionSelections.length > 0) {
    html += ' <span class="app-connection-count">' + appConnectionSelections.length + '</span>';
  }
  html += '</button>';
  if (appConnectionMode) {
    html += '<button class="app-connection-clear-btn" id="app-connection-clear" title="Clear selection">Clear</button>';
  }
  html += '</div>';

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

  // ── Save / Load controls ──
  html += '<div class="app-save-section">';
  html += '<div class="app-save-row">';
  html += '<button class="app-action-btn app-action-save" id="app-save-state">&#x1F4BE; Save</button>';
  html += '<button class="app-action-btn app-action-load" id="app-load-state">&#x1F4C2; Load</button>';
  html += '</div>';
  html += '<div id="app-save-panel" style="display:none;"></div>';
  html += '</div>';

  html += '<div class="app-git-section" id="app-git-section"></div>';
  html += '</div>';

  // Command bar — sends to the chat agent with pipeline context
  html += '<div class="app-command-bar">';
  html += '<div class="app-command-input-wrap">';
  html += '<textarea class="app-command-input" id="app-command-input" rows="3" placeholder="Ask the AI to change something... (Shift+Enter for new line)"></textarea>';
  html += '<div class="app-command-spinner" id="app-command-spinner" style="display:none;"><span class="app-command-spinner-dot"></span><span class="app-command-spinner-dot"></span><span class="app-command-spinner-dot"></span></div>';
  html += '</div>';
  html += '<div class="app-command-response" id="app-command-response" style="display:none;"></div>';
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
    // Connection mode: add entity data attributes for selection
    var connAttrs = '';
    var connSelected = false;
    if (appConnectionMode && idKey && item[idKey]) {
      var connEntityType = typeKey && item[typeKey] ? String(item[typeKey]).toLowerCase() : key.replace(/s$/, ''); // e.g. "characters" → "character"
      var connEntityId = String(item[idKey]);
      var connLabel = titleKey && item[titleKey] ? String(item[titleKey]) : connEntityId;
      connSelected = appConnectionSelections.some(function(s) { return s.entityId === connEntityId; });
      connAttrs = ' data-conn-entity-type="' + compEscAttr(connEntityType) + '"'
        + ' data-conn-entity-id="' + compEscAttr(connEntityId) + '"'
        + ' data-conn-entity-label="' + compEscAttr(connLabel) + '"';
    }
    html += '<div class="app-panel-card' + (connSelected ? ' app-conn-selected' : '') + '" data-panel-card-index="' + ci + '"' + connAttrs + '>';

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
//  Screenplay NLE — data detection and stitching
// ────────────────────────────────────────────────────────────────

/**
 * Detect whether the pipeline output contains screenplay-shaped data.
 * Looks for sections[], elements[], and previsualizations.shots[] anywhere
 * in the node outputs.
 */
function detectScreenplayData(state) {
  if (!state || !state.nodeData) return false;
  var found = { sections: false, elements: false, previs: false };
  for (var nodeId in state.nodeData) {
    var outputs = state.nodeData[nodeId].outputs;
    if (!outputs) continue;
    _walkForScreenplay(outputs, found, 0);
    if (found.sections && found.elements) return true;
  }
  return false;
}

function _walkForScreenplay(obj, found, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && typeof obj[0] === 'object') {
      var keys = Object.keys(obj[0]);
      if (keys.indexOf('type') !== -1 && keys.indexOf('children') !== -1 && keys.indexOf('order') !== -1) {
        found.sections = true;
      }
      if (keys.indexOf('type') !== -1 && (keys.indexOf('shotText') !== -1 || keys.indexOf('characterName') !== -1 || keys.indexOf('content') !== -1) && keys.indexOf('id') !== -1) {
        var types = {};
        for (var i = 0; i < Math.min(obj.length, 20); i++) { types[obj[i].type] = true; }
        if (types.shot || types.dialogue || types.action) found.elements = true;
      }
      if (keys.indexOf('shotElementId') !== -1 && keys.indexOf('sceneId') !== -1) {
        found.previs = true;
      }
    }
    return;
  }
  for (var k in obj) {
    _walkForScreenplay(obj[k], found, depth + 1);
  }
}

/**
 * Stitch screenplay data from across pipeline nodes into a unified timeline.
 *
 * Returns: {
 *   title, logline, metadata,
 *   characters: { id -> character },
 *   locations: { id -> location },
 *   acts: [{ id, title, scenes: [{ id, title, heading, beats: [{ element, previs?, asset? }] }] }],
 *   orphanElements: []   // elements not assigned to any scene
 * }
 */
function stitchScreenplayTimeline(state) {
  if (!state || !state.nodeData) return null;

  // Collect all relevant data from any node
  var allSections = null, allElements = null, allPrevis = null;
  var allCharacters = null, allLocations = null, allAssets = null;
  var metadata = null;

  for (var nodeId in state.nodeData) {
    var outputs = state.nodeData[nodeId].outputs;
    if (!outputs) continue;
    _extractScreenplayFields(outputs, 0);
  }

  function _extractScreenplayFields(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) return;
    for (var k in obj) {
      var v = obj[k];
      if (!v) continue;

      // scriptPackage wrapper — recurse into it
      if (k === 'scriptPackage' && typeof v === 'object' && v.script) {
        _extractScreenplayFields(v, depth + 1);
        _extractScreenplayFields(v.script, depth + 1);
        if (v.previsualizations) _extractScreenplayFields(v, depth + 1);
        if (v.assets) _extractScreenplayFields(v, depth + 1);
        continue;
      }
      if (k === 'script' && typeof v === 'object' && !Array.isArray(v)) {
        _extractScreenplayFields(v, depth + 1);
        continue;
      }

      if (k === 'sections' && Array.isArray(v) && v.length > 0 && v[0].children !== undefined) {
        if (!allSections || v.length > allSections.length) allSections = v;
      }
      if (k === 'elements' && Array.isArray(v) && v.length > 0 && v[0].type) {
        if (!allElements || v.length > allElements.length) allElements = v;
      }
      if (k === 'shots' && Array.isArray(v) && v.length > 0 && v[0].shotElementId) {
        if (!allPrevis || v.length > allPrevis.length) allPrevis = v;
      }
      if (k === 'previsualizations' && typeof v === 'object' && v.shots) {
        if (!allPrevis || v.shots.length > (allPrevis ? allPrevis.length : 0)) allPrevis = v.shots;
      }
      if (k === 'characters' && Array.isArray(v) && v.length > 0 && v[0].name) {
        if (!allCharacters || v.length > allCharacters.length) allCharacters = v;
      }
      if (k === 'locations' && Array.isArray(v) && v.length > 0 && v[0].name) {
        if (!allLocations || v.length > allLocations.length) allLocations = v;
      }
      if (k === 'assets' && typeof v === 'object' && !Array.isArray(v) && v.assets) {
        allAssets = v.assets;
      }
      if (k === 'assets' && Array.isArray(v) && v.length > 0 && v[0].filePath) {
        if (!allAssets || v.length > allAssets.length) allAssets = v;
      }
      if (k === 'metadata' && typeof v === 'object' && !Array.isArray(v) && v.title) {
        metadata = v;
      }

      // Recurse into objects (not arrays)
      if (typeof v === 'object' && !Array.isArray(v)) {
        _extractScreenplayFields(v, depth + 1);
      }
    }
  }

  if (!allElements || !allSections) return null;

  // Build lookup maps
  var charMap = {};
  if (allCharacters) {
    for (var ci = 0; ci < allCharacters.length; ci++) {
      charMap[allCharacters[ci].id] = allCharacters[ci];
    }
  }
  var locMap = {};
  if (allLocations) {
    for (var li = 0; li < allLocations.length; li++) {
      locMap[allLocations[li].id] = allLocations[li];
    }
  }
  var assetMap = {};
  if (allAssets) {
    for (var ai = 0; ai < allAssets.length; ai++) {
      assetMap[allAssets[ai].id] = allAssets[ai];
    }
  }
  var previsMap = {}; // shotElementId -> previs
  if (allPrevis) {
    for (var pi = 0; pi < allPrevis.length; pi++) {
      previsMap[allPrevis[pi].shotElementId] = allPrevis[pi];
    }
  }

  // Build character ID -> headshot asset map
  var charAssetMap = {}; // characterId -> asset (with filePath)
  var locAssetMap = {};  // locationId -> asset (with filePath)
  if (allAssets) {
    for (var ami = 0; ami < allAssets.length; ami++) {
      var asset = allAssets[ami];
      var meta = asset.metadata || {};
      if (meta.characterId && (asset.type === 'character-headshot' || (asset.name && asset.name.toLowerCase().indexOf('headshot') !== -1))) {
        charAssetMap[meta.characterId] = asset;
      }
      if (meta.locationId && (asset.type === 'landscape' || (asset.name && asset.name.toLowerCase().indexOf('landscape') !== -1))) {
        locAssetMap[meta.locationId] = asset;
      }
    }
  }

  // Flatten sections into an ordered list of scenes
  var flatScenes = [];
  for (var si = 0; si < allSections.length; si++) {
    var section = allSections[si];
    if (section.type === 'act') {
      var children = section.children || [];
      for (var sci = 0; sci < children.length; sci++) {
        flatScenes.push({
          scene: children[sci],
          actTitle: section.title,
          actId: section.id,
        });
      }
    } else if (section.type === 'scene') {
      flatScenes.push({ scene: section, actTitle: null, actId: null });
    }
    // skip blackout, etc.
  }

  // Assign elements to scenes proportionally
  // Each scene has N beats; total beats = sum; elements distributed by beat ratio
  var totalBeats = 0;
  for (var fi = 0; fi < flatScenes.length; fi++) {
    var beats = (flatScenes[fi].scene.beats || []).length || 5;
    flatScenes[fi]._beats = beats;
    totalBeats += beats;
  }

  var elemIdx = 0;
  var acts = [];
  var currentAct = null;

  for (var fsi = 0; fsi < flatScenes.length; fsi++) {
    var fs = flatScenes[fsi];
    var sc = fs.scene;

    // Start new act if needed
    if (fs.actId && (!currentAct || currentAct.id !== fs.actId)) {
      currentAct = { id: fs.actId, title: fs.actTitle, scenes: [] };
      acts.push(currentAct);
    }
    if (!currentAct) {
      currentAct = { id: '__default', title: 'Scenes', scenes: [] };
      acts.push(currentAct);
    }

    // Calculate how many elements belong to this scene
    var ratio = fs._beats / totalBeats;
    var count = Math.round(ratio * allElements.length);
    // Ensure at least 1 and last scene gets remainder
    if (count < 1) count = 1;
    if (fsi === flatScenes.length - 1) count = allElements.length - elemIdx;

    var sceneElements = allElements.slice(elemIdx, elemIdx + count);
    elemIdx += count;

    // Build beats: group elements by shot markers
    // Each "beat" starts with a shot element and includes subsequent action/dialogue
    var sceneBeats = [];
    var currentBeat = null;
    for (var ei = 0; ei < sceneElements.length; ei++) {
      var elem = sceneElements[ei];
      if (elem.type === 'shot' || (!currentBeat && ei === 0)) {
        currentBeat = { elements: [], previs: null, asset: null };
        sceneBeats.push(currentBeat);
        // Look up previs for shot elements
        if (elem.type === 'shot' && previsMap[elem.id]) {
          var pv = previsMap[elem.id];
          currentBeat.previs = pv;
          // Prefer regenerated file path over the original asset
          if (pv._generatedFilePath) {
            currentBeat.asset = { filePath: pv._generatedFilePath };
          } else if (pv.assetId && assetMap[pv.assetId]) {
            currentBeat.asset = assetMap[pv.assetId];
          }
        }
      }
      if (!currentBeat) {
        currentBeat = { elements: [], previs: null, asset: null };
        sceneBeats.push(currentBeat);
      }
      currentBeat.elements.push(elem);
    }

    var heading = sc.sceneHeading
      ? (sc.sceneHeading.location || '') + ' — ' + (sc.sceneHeading.timeOfDay || '')
      : '';

    currentAct.scenes.push({
      id: sc.id,
      title: sc.title,
      heading: heading,
      synopsis: sc.synopsis || '',
      beats: sceneBeats,
    });
  }

  return {
    title: metadata ? metadata.title : '',
    logline: metadata ? metadata.logline : '',
    metadata: metadata,
    characters: charMap,
    locations: locMap,
    characterAssets: charAssetMap,
    locationAssets: locAssetMap,
    bindings: appBindings || { version: '1.0', bindings: [] },
    acts: acts,
    totalElements: allElements.length,
    totalPrevis: allPrevis ? allPrevis.length : 0,
  };
}

// ────────────────────────────────────────────────────────────────
//  Screenplay NLE — rendering
// ────────────────────────────────────────────────────────────────

function renderAppScreenplayView(timeline, state) {
  if (!timeline) {
    return '<div class="app-empty-state"><div class="app-empty-icon">&#x1f3ac;</div>' +
      '<h3>No screenplay data found</h3><p>Run the pipeline to generate screenplay content.</p></div>';
  }

  var html = '<div class="nle-container">';

  // Header
  html += '<div class="nle-header">';
  html += '<h1 class="nle-title">' + compEscHtml(timeline.title || 'Untitled Screenplay') + '</h1>';
  if (timeline.logline) {
    html += '<p class="nle-logline">' + compEscHtml(timeline.logline) + '</p>';
  }
  // Stats
  html += '<div class="nle-stats">';
  html += '<span class="nle-stat">' + timeline.acts.length + ' acts</span>';
  var totalScenes = 0;
  for (var ai = 0; ai < timeline.acts.length; ai++) totalScenes += timeline.acts[ai].scenes.length;
  html += '<span class="nle-stat">' + totalScenes + ' scenes</span>';
  html += '<span class="nle-stat">' + timeline.totalElements + ' elements</span>';
  html += '<span class="nle-stat">' + timeline.totalPrevis + ' previs shots</span>';
  html += '</div>';
  // Toolbar with action buttons
  html += '<div class="nle-toolbar">';
  html += '<button class="nle-toolbar-btn" id="nle-render-all-dialogue" title="Generate audio for all dialogue using assigned character voices">';
  html += '&#x1f50a; Render All Dialogue</button>';
  html += '</div>';
  html += '</div>';

  // Scene navigation strip
  html += '<div class="nle-scene-strip" id="nle-scene-strip">';
  for (var nai = 0; nai < timeline.acts.length; nai++) {
    var act = timeline.acts[nai];
    html += '<div class="nle-strip-act">';
    html += '<span class="nle-strip-act-label">' + compEscHtml(act.title || 'Act ' + (nai + 1)) + '</span>';
    for (var nsi = 0; nsi < act.scenes.length; nsi++) {
      var sc = act.scenes[nsi];
      var previsCount = 0;
      for (var bi = 0; bi < sc.beats.length; bi++) { if (sc.beats[bi].previs) previsCount++; }
      html += '<button class="nle-strip-scene" data-nle-scene="' + compEscAttr(sc.id) + '" title="' + compEscAttr(sc.title) + '">';
      html += '<span class="nle-strip-scene-num">' + compEscHtml(sc.title.replace(/^Scene\s*/i, '').substring(0, 20)) + '</span>';
      if (previsCount > 0) {
        html += '<span class="nle-strip-scene-imgs">' + previsCount + ' &#x1f3ac;</span>';
      }
      html += '</button>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Timeline body — scrollable
  html += '<div class="nle-timeline" id="nle-timeline">';

  for (var tai = 0; tai < timeline.acts.length; tai++) {
    var timelineAct = timeline.acts[tai];
    html += '<div class="nle-act" data-nle-act="' + compEscAttr(timelineAct.id) + '">';
    html += '<div class="nle-act-header">';
    html += '<h2 class="nle-act-title">' + compEscHtml(timelineAct.title || 'Act ' + (tai + 1)) + '</h2>';
    html += '</div>';

    for (var tsi = 0; tsi < timelineAct.scenes.length; tsi++) {
      var scene = timelineAct.scenes[tsi];
      html += renderNLEScene(scene, timeline);
    }

    html += '</div>'; // .nle-act
  }

  html += '</div>'; // .nle-timeline
  html += '</div>'; // .nle-container

  return html;
}

function renderNLEScene(scene, timeline) {
  var html = '<div class="nle-scene" id="nle-scene-' + compEscAttr(scene.id) + '" data-nle-scene="' + compEscAttr(scene.id) + '">';

  // Scene header
  html += '<div class="nle-scene-header">';
  html += '<div class="nle-scene-header-left">';
  html += '<h3 class="nle-scene-title">' + compEscHtml(scene.title) + '</h3>';
  if (scene.heading) {
    html += '<div class="nle-scene-heading">' + compEscHtml(scene.heading) + '</div>';
  }
  html += '</div>';
  if (scene.synopsis) {
    html += '<p class="nle-scene-synopsis">' + compEscHtml(scene.synopsis) + '</p>';
  }
  html += '</div>';

  // Beats
  for (var bi = 0; bi < scene.beats.length; bi++) {
    var beat = scene.beats[bi];
    html += renderNLEBeat(beat, bi, scene, timeline);
  }

  html += '</div>'; // .nle-scene
  return html;
}

function renderNLEBeat(beat, beatIndex, scene, timeline) {
  var hasImage = beat.asset && beat.asset.filePath;
  var shotElement = null;
  var otherElements = [];

  for (var i = 0; i < beat.elements.length; i++) {
    var el = beat.elements[i];
    if (el.type === 'shot' && !shotElement) {
      shotElement = el;
    } else {
      otherElements.push(el);
    }
  }

  // Connection mode: add entity data for the beat's shot element
  var beatConnAttrs = '';
  var beatConnSelected = false;
  if (appConnectionMode && shotElement && shotElement.id) {
    beatConnSelected = appConnectionSelections.some(function(s) { return s.entityId === shotElement.id; });
    beatConnAttrs = ' data-conn-entity-type="shot" data-conn-entity-id="' + compEscAttr(shotElement.id) + '" data-conn-entity-label="' + compEscAttr(shotElement.shotText ? shotElement.shotText.substring(0, 60) : 'Shot ' + (beatIndex + 1)) + '"';
  }
  var html = '<div class="nle-beat' + (hasImage ? ' nle-beat--has-image' : '') + (beatConnSelected ? ' app-conn-selected' : '') + '" data-nle-beat="' + beatIndex + '"' + beatConnAttrs + '>';

  // Left: previs image
  html += '<div class="nle-beat-visual">';
  if (hasImage) {
    var imgSrc = resolveImageSrc(beat.asset.filePath);
    html += '<div class="nle-beat-image app-img-zoomable" data-app-img-src="' + compEscAttr(imgSrc) + '">';
    html += '<img src="' + compEscAttr(imgSrc) + '" loading="lazy" alt="" />';
    html += '</div>';
    // Image controls
    html += '<div class="nle-beat-image-controls">';
    html += '<button class="nle-beat-regen-btn" data-nle-regen-element="' + compEscAttr(shotElement ? shotElement.id : '') + '" data-nle-regen-asset="' + compEscAttr(beat.asset.id || '') + '" title="Regenerate this image">&#x1f504; Regen</button>';
    html += '<button class="nle-beat-prompt-btn" data-nle-prompt-element="' + compEscAttr(shotElement ? shotElement.id : '') + '" title="Edit image prompt">&#x270E; Prompt</button>';
    html += '</div>';
  } else if (shotElement) {
    // No image — show placeholder
    html += '<div class="nle-beat-image-placeholder">';
    html += '<div class="nle-beat-placeholder-icon">&#x1f3ac;</div>';
    html += '<button class="nle-beat-gen-btn" data-nle-gen-element="' + compEscAttr(shotElement.id) + '" title="Generate previs image">Generate Image</button>';
    html += '</div>';
  }
  // Shot metadata (camera info)
  if (shotElement) {
    html += '<div class="nle-beat-shot-meta">';
    if (shotElement.frameSize) {
      html += '<span class="nle-shot-tag">' + compEscHtml(shotElement.frameSize) + '</span>';
    }
    if (shotElement.cameraMovement && shotElement.cameraMovement !== 'STATIC') {
      html += '<span class="nle-shot-tag">' + compEscHtml(shotElement.cameraMovement) + '</span>';
    }
    if (beat.previs && beat.previs.durationSeconds) {
      html += '<span class="nle-shot-tag nle-shot-duration">' + beat.previs.durationSeconds + 's</span>';
    }
    html += '</div>';
  }

  // Reference images strip — shows the actual images that will be fed to
  // the generator when Regen is clicked. Only shows refs that have images.
  // Uses bindings if available (pipeline-specific connections), otherwise
  // falls back to previs.characterIds/locationId.
  var refImages = [];
  var shotElemId = shotElement ? shotElement.id : null;
  var beatCharIds = [];
  var beatLocId = null;

  // Check bindings first
  var hasBindings = timeline.bindings && timeline.bindings.bindings && timeline.bindings.bindings.length > 0;
  if (hasBindings && shotElemId) {
    // Get characters from "depicts" bindings for this shot
    for (var bi = 0; bi < timeline.bindings.bindings.length; bi++) {
      var b = timeline.bindings.bindings[bi];
      if (b.source.entityType === 'shot' && b.source.entityId === shotElemId) {
        if (b.type === 'depicts' && b.target.entityType === 'character') {
          beatCharIds.push(b.target.entityId);
        } else if (b.type === 'set-in' && b.target.entityType === 'location') {
          beatLocId = b.target.entityId;
        }
      }
    }
  }

  // Fall back to previs data if no bindings found
  if (beatCharIds.length === 0) {
    beatCharIds = beat.previs ? (beat.previs.characterIds || []) : [];
  }
  if (!beatLocId) {
    beatLocId = beat.previs ? beat.previs.locationId : null;
  }

  for (var bci = 0; bci < beatCharIds.length; bci++) {
    var charId = beatCharIds[bci];
    var charAsset = timeline.characterAssets[charId];
    if (charAsset && charAsset.filePath) {
      var charData = timeline.characters[charId];
      refImages.push({
        type: 'character',
        id: charId,
        name: charData ? (charData.displayName || charData.name) : charId,
        filePath: charAsset.filePath,
        description: charData ? charData.description : '',
        color: nleCharColor(charData ? (charData.displayName || charData.name) : charId),
      });
    }
  }
  if (beatLocId) {
    var locAsset = timeline.locationAssets[beatLocId];
    if (locAsset && locAsset.filePath) {
      var locData = timeline.locations[beatLocId];
      refImages.push({
        type: 'location',
        id: beatLocId,
        name: locData ? locData.name : beatLocId,
        filePath: locAsset.filePath,
        description: locData ? locData.description : '',
        color: '#7cb8f7',
      });
    }
  }

  if (refImages.length > 0) {
    html += '<div class="nle-beat-refs">';
    html += '<div class="nle-refs-label">Refs (' + refImages.length + ')</div>';
    html += '<div class="nle-refs-strip">';
    for (var ri = 0; ri < refImages.length; ri++) {
      var ref = refImages[ri];
      var refSrc = resolveImageSrc(ref.filePath);
      var refTitle = ref.name + (ref.description ? ': ' + ref.description.substring(0, 100) : '');
      var refConnAttrs = '';
      var refConnSelected = false;
      if (appConnectionMode && ref.id) {
        refConnSelected = appConnectionSelections.some(function(s) { return s.entityId === ref.id; });
        refConnAttrs = ' data-conn-entity-type="' + compEscAttr(ref.type) + '" data-conn-entity-id="' + compEscAttr(ref.id) + '" data-conn-entity-label="' + compEscAttr(ref.name) + '"';
      }
      html += '<div class="nle-ref-tile' + (appConnectionMode ? '' : ' app-img-zoomable') + (refConnSelected ? ' app-conn-selected' : '') + '"' + (appConnectionMode ? '' : ' data-app-img-src="' + compEscAttr(refSrc) + '"') + ' title="' + compEscAttr(refTitle) + '"' + refConnAttrs + '>';
      html += '<img src="' + compEscAttr(refSrc) + '" loading="lazy" alt="" />';
      html += '<span class="nle-ref-tile-label" style="' + (ref.type === 'character' ? 'border-left-color:' + ref.color : '') + '">' + compEscHtml(ref.name) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  html += '</div>'; // .nle-beat-visual

  // Right: screenplay text
  html += '<div class="nle-beat-text">';

  // Shot description (editable)
  if (shotElement && shotElement.shotText) {
    html += '<div class="nle-element nle-element--shot">';
    html += '<span class="nle-element-label">SHOT</span>';
    html += '<span class="nle-element-content nle-editable" data-nle-edit-type="shot" data-nle-edit-field="shotText" data-nle-edit-element-id="' + compEscAttr(shotElement.id) + '" title="Click to edit">' + compEscHtml(shotElement.shotText) + '</span>';
    html += '</div>';
  }

  // Other elements (action, dialogue, transition)
  for (var oi = 0; oi < otherElements.length; oi++) {
    var elem = otherElements[oi];
    html += renderNLEElement(elem, timeline);
  }

  html += '</div>'; // .nle-beat-text

  // Previs detail (expandable prompt area)
  if (beat.previs) {
    html += '<div class="nle-beat-prompt-area" data-nle-prompt-area="' + compEscAttr(shotElement ? shotElement.id : '') + '" style="display:none;">';
    html += '<div class="nle-prompt-section">';
    html += '<label class="nle-prompt-label">Shot Description</label>';
    html += '<textarea class="nle-prompt-textarea" data-nle-field="description" rows="3">' + compEscHtml(beat.previs.description || '') + '</textarea>';
    html += '</div>';
    html += '<div class="nle-prompt-section">';
    html += '<label class="nle-prompt-label">Camera Intent</label>';
    html += '<textarea class="nle-prompt-textarea" data-nle-field="cameraIntent" rows="2">' + compEscHtml(beat.previs.cameraIntent || '') + '</textarea>';
    html += '</div>';
    html += '<div class="nle-prompt-section">';
    html += '<label class="nle-prompt-label">Composition</label>';
    html += '<textarea class="nle-prompt-textarea" data-nle-field="composition" rows="2">' + compEscHtml(beat.previs.composition || '') + '</textarea>';
    html += '</div>';
    html += '<div class="nle-prompt-section">';
    html += '<label class="nle-prompt-label">Lighting</label>';
    html += '<textarea class="nle-prompt-textarea" data-nle-field="lighting" rows="2">' + compEscHtml(beat.previs.lighting || '') + '</textarea>';
    html += '</div>';
    html += '<div class="nle-prompt-actions">';
    html += '<button class="nle-prompt-save" data-nle-save-element="' + compEscAttr(shotElement ? shotElement.id : '') + '">&#x2728; Regenerate with changes</button>';
    html += '<button class="nle-prompt-cancel" data-nle-cancel-element="' + compEscAttr(shotElement ? shotElement.id : '') + '">Cancel</button>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>'; // .nle-beat
  return html;
}

function renderNLEElement(elem, timeline) {
  var html = '';

  if (elem.type === 'dialogue') {
    // Store element data for the edit modal
    var elemData = {
      id: elem.id,
      characterName: elem.characterName || elem.characterId || '',
      characterId: elem.characterId || '',
      modifiers: elem.modifiers || [],
      lines: elem.lines || [elem.content || '']
    };
    var elemDataAttr = ' data-nle-element-data="' + compEscAttr(JSON.stringify(elemData)) + '"';
    html += '<div class="nle-element nle-element--dialogue" data-nle-element-id="' + compEscAttr(elem.id || '') + '"' + elemDataAttr + '>';
    var charName = elem.characterName || elem.characterId || 'UNKNOWN';
    // Character color based on name hash
    var charColor = nleCharColor(charName);
    // Connection mode: make character name selectable
    var charConnAttrs = '';
    var charConnSel = false;
    if (appConnectionMode && elem.characterId) {
      charConnSel = appConnectionSelections.some(function(s) { return s.entityId === elem.characterId; });
      charConnAttrs = ' data-conn-entity-type="character" data-conn-entity-id="' + compEscAttr(elem.characterId) + '" data-conn-entity-label="' + compEscAttr(charName) + '"';
    }
    html += '<div class="nle-dialogue-header" style="border-left-color:' + charColor + '">';
    html += '<span class="nle-dialogue-character nle-editable' + (charConnSel ? ' app-conn-selected' : '') + '" style="color:' + charColor + '"' + charConnAttrs;
    html += ' data-nle-edit-type="dialogue" data-nle-edit-field="characterName" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit character name"';
    html += '>' + compEscHtml(charName) + '</span>';
    if (elem.modifiers && elem.modifiers.length > 0) {
      html += '<span class="nle-dialogue-modifier nle-editable" data-nle-edit-type="dialogue" data-nle-edit-field="modifiers" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit modifiers">(' + compEscHtml(elem.modifiers.join(', ')) + ')</span>';
    } else {
      html += '<span class="nle-dialogue-modifier nle-dialogue-modifier--empty nle-editable" data-nle-edit-type="dialogue" data-nle-edit-field="modifiers" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to add modifiers (V.O., O.S., etc.)"></span>';
    }
    // Edit button to open full dialogue editor
    html += '<button class="nle-dialogue-edit-btn" data-nle-edit-dialogue="' + compEscAttr(elem.id || '') + '" title="Edit dialogue">&#x270E;</button>';
    // TTS button to generate speech for this dialogue
    html += '<button class="nle-dialogue-tts-btn" data-nle-tts-dialogue="' + compEscAttr(elem.id || '') + '" data-nle-tts-character="' + compEscAttr(elem.characterId || elem.characterName || '') + '" title="Generate speech">&#x1f50a;</button>';
    html += '</div>';
    html += '<div class="nle-dialogue-content" style="border-left-color:' + charColor + '">';
    var lines = elem.lines || [elem.content];
    for (var li = 0; li < lines.length; li++) {
      // Each line is editable — for multi-line dialogues, we edit the lines array
      html += '<p class="nle-dialogue-line nle-editable" data-nle-edit-type="dialogue" data-nle-edit-field="lines" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" data-nle-edit-line-index="' + li + '" title="Click to edit dialogue">' + compEscHtml(lines[li]) + '</p>';
    }
    html += '</div>';
    html += '</div>';
  } else if (elem.type === 'action') {
    html += '<div class="nle-element nle-element--action">';
    html += '<span class="nle-element-content nle-editable" data-nle-edit-type="action" data-nle-edit-field="content" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit action">' + compEscHtml(elem.content || '') + '</span>';
    html += '</div>';
  } else if (elem.type === 'transition') {
    html += '<div class="nle-element nle-element--transition">';
    html += '<span class="nle-element-content nle-editable" data-nle-edit-type="transition" data-nle-edit-field="content" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit transition">' + compEscHtml(elem.content || '') + '</span>';
    html += '</div>';
  } else if (elem.type === 'parenthetical') {
    html += '<div class="nle-element nle-element--parenthetical">';
    html += '<span class="nle-element-content nle-editable" data-nle-edit-type="parenthetical" data-nle-edit-field="content" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit parenthetical">(' + compEscHtml(elem.content || '') + ')</span>';
    html += '</div>';
  } else if (elem.type === 'shot') {
    // Secondary shot within a beat
    html += '<div class="nle-element nle-element--shot nle-element--shot-secondary">';
    html += '<span class="nle-element-label">SHOT</span>';
    html += '<span class="nle-element-content nle-editable" data-nle-edit-type="shot" data-nle-edit-field="shotText" data-nle-edit-element-id="' + compEscAttr(elem.id || '') + '" title="Click to edit shot">' + compEscHtml(elem.shotText || elem.content || '') + '</span>';
    html += '</div>';
  }

  return html;
}

/** Generate a consistent color for a character name */

// ────────────────────────────────────────────────────────────────
//  Voices Assignment View
// ────────────────────────────────────────────────────────────────

/**
 * Render the voice assignment view.
 * Shows all characters with their current voice assignments and allows
 * assigning ElevenLabs voices to each character.
 */
// renderAppVoicesView, findVoiceBinding, loadVoicesForAssignment,
// saveVoiceAssignment, previewVoice — all moved to pipeline-local view:
// {pipelineDir}/views/voices/view.js

function nleCharColor(name) {
  var colors = [
    '#7c9ef7', '#f7a07c', '#7cf7b8', '#f77cc4', '#c49ef7',
    '#f7e47c', '#7cd4f7', '#f79e7c', '#a1f77c', '#f77c7c',
    '#7cf7e4', '#d47cf7', '#f7c47c', '#7c7cf7', '#7cf79e',
  ];
  var hash = 0;
  for (var i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

// ────────────────────────────────────────────────────────────────
//  Main page render
// ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
async function renderCompositionAppPage() {
  if (!compData) return;

  var main = document.querySelector('#main');
  if (!main) return;

  // Restore .app-content styles if a previous view (e.g. Editor) overrode them
  var appContent = main.closest('.app-content') || document.querySelector('.app-content');
  if (appContent && appContent.getAttribute('data-ed-override') === 'true') {
    appContent.style.padding = '';
    appContent.style.overflow = '';
    appContent.removeAttribute('data-ed-override');
  }

  // Restore sub-view from hash on initial load (e.g. #compositions/id/app/screenplay)
  if (window._hashAppSubView) {
    var sv = window._hashAppSubView;
    if (sv === 'data' || sv === 'screenplay') {
      appViewMode = sv;
    } else if (sv.startsWith('custom:') || appCustomViews.some(function(cv) { return cv.name === sv; })) {
      appViewMode = sv.startsWith('custom:') ? sv : 'custom:' + sv;
    } else {
      appViewMode = sv;
    }
    if (window._hashAppSubId) {
      appActiveSection = window._hashAppSubId;
    }
    window._hashAppSubView = null;
    window._hashAppSubId = null;
  }

  // Show loading state
  main.innerHTML = '<div class="app-loading"><div class="spinner"></div> Loading app...</div>';

  // Fetch schema, state, and bindings in parallel
  var results = await Promise.all([
    fetchAppSchema(compData.id),
    fetchAppState(compData.id),
    fetchAppBindings(compData.id),
  ]);
  appSchema = results[0];
  appState = results[1];
  appBindings = results[2];

  // Load pipeline-local custom views (once per pipeline, reset on pipeline change)
  if (!appCustomViewsLoaded || appCustomViewsPipelineId !== compData.id) {
    appCustomViews = [];
    appCustomViewsLoaded = true;
    appCustomViewsPipelineId = compData.id;
    // Remove previously injected custom view scripts/styles
    document.querySelectorAll('[id^="pipeline-view-js-"], [id^="pipeline-view-css-"]').forEach(function(el) { el.remove(); });
    try { await loadPipelineCustomViews(compData.id); } catch(e) { console.error('[pipeline-view] load error:', e); }
  }

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
  var html = '<div class="app-shell' + (appConnectionMode ? ' app-shell--connection-mode' : '') + '">';
  html += renderAppSidebar(appSchema, appState);

  // Content area
  html += '<div class="app-content">';
  var _customViewRendered = false;

  // Check for pipeline-local custom view first
  if (appViewMode.startsWith('custom:')) {
    var _customName = appViewMode.slice(7);
    var _customView = appCustomViews.find(function(cv) { return cv.name === _customName && cv.loaded; });
    if (_customView) {
      try {
        var _customData = _customView.stitch(appState);
        // Wrap in a scoped container so view CSS doesn't leak to other pipelines
        html += '<div class="pipeline-view-scope" data-pipeline-view="' + compEscAttr(_customName) + '">';
        html += _customView.render(_customData, appState);
        html += '</div>';
        _customViewRendered = true;
      } catch (e) {
        console.error('[pipeline-view] Render error for ' + _customName + ':', e);
        html += '<div class="app-error">Custom view "' + compEscHtml(_customView.label) + '" failed to render: ' + compEscHtml(e.message || String(e)) + '</div>';
        _customViewRendered = true;
      }
    }
  }

  if (!_customViewRendered) {
    if (appViewMode === 'screenplay' && detectScreenplayData(appState)) {
      var timeline = stitchScreenplayTimeline(appState);
      html += renderAppScreenplayView(timeline, appState);
    } else if (appActiveSection) {
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

  // Connection mode floating selection tray (shown when items are selected)
  if (appConnectionMode) {
    html += renderConnectionTray();
  }

  main.innerHTML = html;
  wireAppActions(main);

  // Wire custom view events if a custom view is active
  if (appViewMode.startsWith('custom:')) {
    var _cvName = appViewMode.slice(7);
    var _cv = appCustomViews.find(function(cv) { return cv.name === _cvName && cv.loaded; });
    if (_cv && _cv.wireEvents) {
      try { _cv.wireEvents(main, appState); } catch(e) {
        console.error('[pipeline-view] wireEvents error for ' + _cvName + ':', e);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Previs image generation
// ────────────────────────────────────────────────────────────────

/**
 * Call the server to generate/regenerate a previs image for a shot element.
 * The server resolves character headshots and location references from the
 * pipeline's asset data and passes them to nanobanana for generation.
 *
 * @param {string} elementId - The shot element ID (e.g. "element_1")
 * @param {Object} promptOverrides - Optional prompt field overrides (description, cameraIntent, composition, lighting)
 * @param {HTMLElement} triggerBtn - The button that triggered this (for loading state)
 * @param {HTMLElement} root - The root DOM element for finding related elements
 */
async function generatePrevisImage(elementId, promptOverrides, triggerBtn, root) {
  if (!compData) return;

  var originalText = triggerBtn.innerHTML;
  triggerBtn.disabled = true;
  triggerBtn.innerHTML = '&#x23F3; Generating...';
  triggerBtn.classList.add('nle-generating');

  try {
    var res = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/generate-previs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elementId: elementId,
        promptOverrides: promptOverrides || {},
        model: 'flash',
        aspectRatio: '16:9',
      }),
    });

    var data = await res.json();

    if (!res.ok || !data.success) {
      toast('Generation failed: ' + (data.error || 'Unknown error'), 'error');
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = originalText;
      triggerBtn.classList.remove('nle-generating');
      return;
    }

    // Show success with reference info
    var refInfo = '';
    if (data.refCount) {
      var parts = [];
      if (data.refCount.characters > 0) parts.push(data.refCount.characters + ' character ref' + (data.refCount.characters > 1 ? 's' : ''));
      if (data.refCount.locations > 0) parts.push('location ref');
      if (parts.length > 0) refInfo = ' (used ' + parts.join(' + ') + ')';
    }
    toast('Generated previs for ' + elementId + refInfo, 'success');

    // Update the image in the DOM without a full re-render
    var beat = root.querySelector('[data-nle-regen-element="' + elementId + '"]');
    if (!beat) beat = root.querySelector('[data-nle-gen-element="' + elementId + '"]');
    if (beat) {
      var beatContainer = beat.closest('.nle-beat');
      if (beatContainer) {
        var visual = beatContainer.querySelector('.nle-beat-visual');
        if (visual && data.filePath) {
          var newSrc = resolveImageSrc(data.filePath);

          // Replace placeholder or existing image
          var existingImg = visual.querySelector('.nle-beat-image img');
          if (existingImg) {
            var cacheBusted = newSrc + '&t=' + Date.now();
            existingImg.src = cacheBusted; // cache bust
            // Update the zoomable wrapper so the modal shows the new image
            var zoomable = existingImg.closest('.app-img-zoomable');
            if (zoomable) zoomable.setAttribute('data-app-img-src', cacheBusted);
          } else {
            // Replace placeholder with real image
            var placeholder = visual.querySelector('.nle-beat-image-placeholder');
            if (placeholder) {
              var imgHtml = '<div class="nle-beat-image app-img-zoomable" data-app-img-src="' + compEscAttr(newSrc) + '">';
              imgHtml += '<img src="' + compEscAttr(newSrc) + '" loading="lazy" alt="" />';
              imgHtml += '</div>';
              imgHtml += '<div class="nle-beat-image-controls">';
              imgHtml += '<button class="nle-beat-regen-btn" data-nle-regen-element="' + compEscAttr(elementId) + '" title="Regenerate this image">&#x1f504; Regen</button>';
              imgHtml += '<button class="nle-beat-prompt-btn" data-nle-prompt-element="' + compEscAttr(elementId) + '" title="Edit image prompt">&#x270E; Prompt</button>';
              imgHtml += '</div>';
              placeholder.outerHTML = imgHtml;

              // Re-wire the new buttons
              var newRegenBtn = visual.querySelector('.nle-beat-regen-btn');
              if (newRegenBtn) {
                newRegenBtn.addEventListener('click', function() {
                  generatePrevisImage(elementId, {}, newRegenBtn, root);
                });
              }
              var newPromptBtn = visual.querySelector('.nle-beat-prompt-btn');
              if (newPromptBtn) {
                newPromptBtn.addEventListener('click', function() {
                  var area = root.querySelector('[data-nle-prompt-area="' + elementId + '"]');
                  if (area) {
                    var isVisible = area.style.display !== 'none';
                    area.style.display = isVisible ? 'none' : 'block';
                    newPromptBtn.classList.toggle('active', !isVisible);
                  }
                });
              }
              // Wire zoom on new image
              var newZoomable = visual.querySelector('.app-img-zoomable');
              if (newZoomable) {
                newZoomable.addEventListener('click', function() {
                  var src = newZoomable.getAttribute('data-app-img-src');
                  if (src) {
                    var modalEl = document.querySelector('#app-detail-modal');
                    var modalBodyEl = document.querySelector('#app-detail-modal-body');
                    if (modalEl && modalBodyEl) {
                      modalBodyEl.innerHTML = '<img class="app-detail-modal-img" src="' + compEscAttr(src) + '" alt="" />';
                      modalEl.className = 'app-detail-modal open app-detail-modal--image';
                      document.body.style.overflow = 'hidden';
                    }
                  }
                });
              }
            }
          }

          // Close the prompt area if it was open
          var promptArea = root.querySelector('[data-nle-prompt-area="' + elementId + '"]');
          if (promptArea) promptArea.style.display = 'none';
        }
      }
    }
  } catch (err) {
    toast('Generation error: ' + (err.message || err), 'error');
  }

  triggerBtn.disabled = false;
  triggerBtn.innerHTML = originalText;
  triggerBtn.classList.remove('nle-generating');
}


// ────────────────────────────────────────────────────────────────
//  Inline element editing
// ────────────────────────────────────────────────────────────────

/**
 * Save an inline edit to a screenplay element (shot description, etc.)
 * Updates the element in the app state and persists to the server.
 */
async function saveInlineEdit(el, root) {
  var editType = el.getAttribute('data-nle-edit-type');
  var editField = el.getAttribute('data-nle-edit-field');
  var elementId = el.getAttribute('data-nle-edit-element-id');
  var originalValue = el.getAttribute('data-nle-original-value');
  var newValue = el.textContent.trim();
  
  // Exit edit mode
  el.setAttribute('contenteditable', 'false');
  el.classList.remove('nle-editing');
  
  // If no change, do nothing
  if (newValue === originalValue) {
    return;
  }
  
  // Show saving indicator
  el.classList.add('nle-saving');
  
  try {
    var res = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/element/' + encodeURIComponent(elementId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: editField,
        value: newValue,
        elementType: editType,
      }),
    });
    
    var data = await res.json();
    
    if (!res.ok) {
      toast('Failed to save: ' + (data.error || 'Unknown error'), 'error');
      // Restore original value
      el.textContent = originalValue;
      return;
    }
    
    toast('Saved', 'success');
    el.classList.add('nle-saved');
    setTimeout(function() { el.classList.remove('nle-saved'); }, 1500);
    
  } catch (err) {
    toast('Save failed: ' + (err.message || err), 'error');
    el.textContent = originalValue;
  } finally {
    el.classList.remove('nle-saving');
  }
}

// ────────────────────────────────────────────────────────────────
//  Event wiring
// ────────────────────────────────────────────────────────────────

function wireAppActions(root) {
  // Sidebar navigation
  root.querySelectorAll('.app-nav-item').forEach(function(btn) {
    btn.addEventListener('click', function() {
      appActiveSection = btn.getAttribute('data-app-section');
      // Deep link: #compositions/{id}/app/data/{sectionId}
      var hashSubView = appViewMode.startsWith('custom:') ? appViewMode.slice(7) : appViewMode;
      if (typeof updateHash === 'function') {
        updateHash('compositions', compData.id, 'app', hashSubView, appActiveSection);
      }
      renderCompositionAppPage();
    });
  });

  // Node panel toggle (collapsible)
  var nodesPanelToggle = root.querySelector('#app-nodes-panel-toggle');
  if (nodesPanelToggle) {
    nodesPanelToggle.addEventListener('click', function() {
      appNodesPanelCollapsed = !appNodesPanelCollapsed;
      renderCompositionAppPage();
    });
  }

  // View mode toggle
  root.querySelectorAll('.app-view-toggle-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var mode = btn.getAttribute('data-app-view-mode');
      if (mode && mode !== appViewMode) {
        appViewMode = mode;
        // Update hash for deep linking (e.g. #compositions/id/app/screenplay)
        var hashSubView = mode.startsWith('custom:') ? mode.slice(7) : mode;
        if (typeof updateHash === 'function') {
          updateHash('compositions', compData.id, 'app', hashSubView);
        }
        renderCompositionAppPage();
      }
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

  // ── Save / Load buttons ──
  wireAppSaveLoad(root);

  // Git status section in sidebar
  var gitSection = root.querySelector('#app-git-section');
  if (gitSection && compData && compData.id) {
    loadAppGitStatus(compData.id, gitSection);
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
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var text = commandInput.value.trim();
        if (!text || !compData) return;
        commandInput.value = '';
        commandInput.style.height = '';
        sendAppCommand(text, compData.id, root);
      }
    });
    // Auto-resize textarea as user types
    commandInput.addEventListener('input', function() {
      commandInput.style.height = '';
      commandInput.style.height = Math.min(commandInput.scrollHeight, 200) + 'px';
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

  // ── NLE-specific wiring ──

  // Scene strip navigation — scroll to scene
  root.querySelectorAll('.nle-strip-scene').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var sceneId = btn.getAttribute('data-nle-scene');
      var target = root.querySelector('#nle-scene-' + sceneId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Highlight briefly
        target.classList.add('nle-scene--highlight');
        setTimeout(function() { target.classList.remove('nle-scene--highlight'); }, 1500);
      }
    });
  });

  // Prompt toggle — show/hide prompt editing area
  root.querySelectorAll('.nle-beat-prompt-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var elemId = btn.getAttribute('data-nle-prompt-element');
      var area = root.querySelector('[data-nle-prompt-area="' + elemId + '"]');
      if (area) {
        var isVisible = area.style.display !== 'none';
        area.style.display = isVisible ? 'none' : 'block';
        btn.classList.toggle('active', !isVisible);
      }
    });
  });

  // Prompt cancel
  root.querySelectorAll('.nle-prompt-cancel').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var elemId = btn.getAttribute('data-nle-cancel-element');
      var area = root.querySelector('[data-nle-prompt-area="' + elemId + '"]');
      if (area) area.style.display = 'none';
      var togBtn = root.querySelector('[data-nle-prompt-element="' + elemId + '"]');
      if (togBtn) togBtn.classList.remove('active');
    });
  });

  // Regenerate image button
  root.querySelectorAll('.nle-beat-regen-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var elemId = btn.getAttribute('data-nle-regen-element');
      if (!elemId) return;
      generatePrevisImage(elemId, {}, btn, root);
    });
  });

  // Generate image (for shots without previs)
  root.querySelectorAll('.nle-beat-gen-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var elemId = btn.getAttribute('data-nle-gen-element');
      if (!elemId) return;
      generatePrevisImage(elemId, {}, btn, root);
    });
  });

  // Save prompt changes + regenerate
  root.querySelectorAll('.nle-prompt-save').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var elemId = btn.getAttribute('data-nle-save-element');
      if (!elemId) return;
      var area = root.querySelector('[data-nle-prompt-area="' + elemId + '"]');
      if (!area) return;
      var fields = {};
      area.querySelectorAll('.nle-prompt-textarea').forEach(function(ta) {
        var field = ta.getAttribute('data-nle-field');
        if (field) fields[field] = ta.value;
      });
      generatePrevisImage(elemId, fields, btn, root);
    });
  });


  // ── Inline editing for screenplay elements (shot descriptions, etc.) ──
  root.querySelectorAll('.nle-editable').forEach(function(el) {
    el.addEventListener('click', function(e) {
      // Don't trigger if already editing
      if (el.getAttribute('contenteditable') === 'true') return;
      
      var editType = el.getAttribute('data-nle-edit-type');
      var editField = el.getAttribute('data-nle-edit-field');
      var elementId = el.getAttribute('data-nle-edit-element-id');
      
      if (!editType || !editField || !elementId) return;
      
      // Store original value
      var originalText = el.textContent;
      el.setAttribute('data-nle-original-value', originalText);
      
      // Make editable
      el.setAttribute('contenteditable', 'true');
      el.classList.add('nle-editing');
      el.focus();
      
      // Select all text
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    
    // Handle blur (save on focus loss)
    el.addEventListener('blur', function() {
      if (el.getAttribute('contenteditable') !== 'true') return;
      saveInlineEdit(el, root);
    });
    
    // Handle keyboard shortcuts
    el.addEventListener('keydown', function(e) {
      if (el.getAttribute('contenteditable') !== 'true') return;
      
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur(); // Trigger save
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Restore original value
        var original = el.getAttribute('data-nle-original-value');
        if (original !== null) {
          el.textContent = original;
        }
        el.setAttribute('contenteditable', 'false');
        el.classList.remove('nle-editing');
      }
    });
  });

  // ── Dialogue Edit Modal ──────────────────────────────────────────────────
  // Wire up dialogue edit buttons to open a full editor modal
  root.querySelectorAll('.nle-dialogue-edit-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var elementId = btn.getAttribute('data-nle-edit-dialogue');
      if (!elementId) return;
      
      // Find the dialogue element and get its data
      var dialogueEl = root.querySelector('[data-nle-element-id="' + elementId + '"]');
      if (!dialogueEl) return;
      
      var dataAttr = dialogueEl.getAttribute('data-nle-element-data');
      var elemData;
      try {
        elemData = JSON.parse(dataAttr);
      } catch (err) {
        toast('Could not load dialogue data', 'error');
        return;
      }
      
      openDialogueEditModal(elemData, root);
    });
  });

  // ── Dialogue TTS Button ──────────────────────────────────────────────────
  // Wire up TTS buttons to generate speech for dialogue using character's voice
  root.querySelectorAll('.nle-dialogue-tts-btn').forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.stopPropagation();
      var elementId = btn.getAttribute('data-nle-tts-dialogue');
      var characterId = btn.getAttribute('data-nle-tts-character');
      if (!elementId) return;
      
      // Find the dialogue element and get its data
      var dialogueEl = root.querySelector('[data-nle-element-id="' + elementId + '"]');
      if (!dialogueEl) return;
      
      var dataAttr = dialogueEl.getAttribute('data-nle-element-data');
      var elemData;
      try {
        elemData = JSON.parse(dataAttr);
      } catch (err) {
        toast('Could not load dialogue data', 'error');
        return;
      }
      
      // Get the dialogue text
      var dialogueText = (elemData.lines || []).join(' ');
      if (!dialogueText.trim()) {
        toast('No dialogue text to speak', 'error');
        return;
      }
      
      // Find the character's voice binding by characterId
      var voiceId = null;
      var voiceName = null;
      if (appBindings && appBindings.bindings && characterId) {
        for (var i = 0; i < appBindings.bindings.length; i++) {
          var b = appBindings.bindings[i];
          if (b.type === 'voice' && b.source && b.source.entityType === 'character' && b.source.entityId === characterId) {
            voiceId = b.target ? b.target.entityId : null;
            voiceName = b.metadata ? b.metadata.voiceName : null;
            break;
          }
        }
      }
      
      if (!voiceId) {
        toast('No voice assigned to ' + (elemData.characterName || 'this character') + '. Go to Voices view to assign one.', 'error');
        return;
      }
      
      // Get character data for voice description (to add emotion)
      var voiceDescription = '';
      if (appState && appState.nodeData) {
        for (var nodeId in appState.nodeData) {
          var outputs = appState.nodeData[nodeId].outputs;
          if (outputs && outputs.characters && Array.isArray(outputs.characters)) {
            var char = outputs.characters.find(function(c) { return c.id === characterId; });
            if (char) {
              // Build voice description from character traits
              var descParts = [];
              if (char.voiceTraits) {
                if (typeof char.voiceTraits === 'string') {
                  descParts.push(char.voiceTraits);
                } else if (char.voiceTraits.description) {
                  descParts.push(char.voiceTraits.description);
                }
              }
              if (char.voice) {
                if (typeof char.voice === 'string') {
                  descParts.push(char.voice);
                } else if (char.voice.description) {
                  descParts.push(char.voice.description);
                }
              }
              // Add modifiers as emotional context
              if (elemData.modifiers && elemData.modifiers.length > 0) {
                descParts.push('(' + elemData.modifiers.join(', ') + ')');
              }
              voiceDescription = descParts.join('. ');
              break;
            }
          }
        }
      }
      
      // Show loading state
      var originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '&#x23F3;';
      btn.classList.add('nle-tts-generating');
      
      try {
        // Build the text with emotional context if available
        var textToSpeak = dialogueText;

        // Call the generate-dialogue-audio endpoint which:
        // 1. Generates TTS audio
        // 2. Saves audio file to project directory
        // 3. Persists as a dialogue-audio asset in app state
        var resp = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/generate-dialogue-audio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            elementId: elementId,
            text: textToSpeak,
            voiceId: voiceId,
            characterName: elemData.characterName || '',
            characterId: characterId || '',
          }),
        });

        if (!resp.ok) {
          var errData = await resp.json().catch(function() { return {}; });
          throw new Error(errData.error || 'Failed to generate audio');
        }

        var result = await resp.json();
        if (!result.success) throw new Error(result.error || 'Failed to generate audio');

        // Play the audio
        var audioUrl = '/api/file?path=' + encodeURIComponent(result.filePath);
        var audio = new Audio(audioUrl);
        audio.play();

        toast('Playing dialogue as ' + (voiceName || elemData.characterName || 'character') + ' (saved to project)', 'success');

      } catch (err) {
        toast('TTS failed: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        btn.classList.remove('nle-tts-generating');
      }
    });
  });

  // ── Render All Dialogue Button ──────────────────────────────────────────
  // Generate audio for all dialogue elements using assigned character voices
  var renderAllBtn = root.querySelector('#nle-render-all-dialogue');
  if (renderAllBtn) {
    renderAllBtn.addEventListener('click', async function() {
      if (!compData || !appState || !appBindings) {
        toast('Pipeline data not loaded', 'error');
        return;
      }

      // Collect all dialogue elements from the timeline
      var allDialogues = [];
      root.querySelectorAll('.nle-element--dialogue').forEach(function(el) {
        var dataAttr = el.getAttribute('data-nle-element-data');
        if (dataAttr) {
          try {
            var elemData = JSON.parse(dataAttr);
            allDialogues.push(elemData);
          } catch (e) { /* skip */ }
        }
      });

      if (allDialogues.length === 0) {
        toast('No dialogue elements found', 'error');
        return;
      }

      // Check which dialogues have voice bindings
      var dialoguesWithVoices = [];
      var dialoguesWithoutVoices = [];
      for (var di = 0; di < allDialogues.length; di++) {
        var d = allDialogues[di];
        var charId = d.characterId || d.characterName;
        var voiceId = null;
        if (appBindings && appBindings.bindings && charId) {
          for (var bi = 0; bi < appBindings.bindings.length; bi++) {
            var b = appBindings.bindings[bi];
            if (b.type === 'voice' && b.source && b.source.entityType === 'character' && b.source.entityId === charId) {
              voiceId = b.target ? b.target.entityId : null;
              break;
            }
          }
        }
        if (voiceId) {
          dialoguesWithVoices.push({ dialogue: d, voiceId: voiceId });
        } else {
          dialoguesWithoutVoices.push(d);
        }
      }

      if (dialoguesWithVoices.length === 0) {
        toast('No characters have voices assigned. Go to Voices view to assign voices first.', 'error');
        return;
      }

      // Confirm with user
      var confirmMsg = 'Generate audio for ' + dialoguesWithVoices.length + ' dialogue' + (dialoguesWithVoices.length === 1 ? '' : 's') + '?';
      if (dialoguesWithoutVoices.length > 0) {
        confirmMsg += '\n\n(' + dialoguesWithoutVoices.length + ' dialogue' + (dialoguesWithoutVoices.length === 1 ? '' : 's') + ' will be skipped - no voice assigned)';
      }
      if (!confirm(confirmMsg)) return;

      // Show progress
      var originalText = renderAllBtn.innerHTML;
      renderAllBtn.disabled = true;
      renderAllBtn.innerHTML = '&#x23F3; Rendering 0/' + dialoguesWithVoices.length + '...';
      renderAllBtn.classList.add('nle-generating');

      var successCount = 0;
      var failCount = 0;

      for (var i = 0; i < dialoguesWithVoices.length; i++) {
        var item = dialoguesWithVoices[i];
        var dialogueText = (item.dialogue.lines || []).join(' ');
        if (!dialogueText.trim()) {
          failCount++;
          continue;
        }

        renderAllBtn.innerHTML = '&#x23F3; Rendering ' + (i + 1) + '/' + dialoguesWithVoices.length + '...';

        try {
          var resp = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/generate-dialogue-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              elementId: item.dialogue.id,
              text: dialogueText,
              voiceId: item.voiceId,
              characterName: item.dialogue.characterName || '',
              characterId: item.dialogue.characterId || '',
            }),
          });

          if (!resp.ok) throw new Error('API error');

          var result = await resp.json();
          if (result.success) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          failCount++;
        }
      }

      // Done
      renderAllBtn.disabled = false;
      renderAllBtn.innerHTML = originalText;
      renderAllBtn.classList.remove('nle-generating');

      var resultMsg = 'Generated ' + successCount + ' audio file' + (successCount === 1 ? '' : 's') + ' (saved to project)';
      if (failCount > 0) {
        resultMsg += ' (' + failCount + ' failed)';
      }
      toast(resultMsg, failCount > 0 ? 'warning' : 'success');
    });
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

  // ── Connection Mode: post-render entity annotation ──
  // Rich cards from compositions-execution.js don't know about connection mode,
  // so we annotate them with entity data attributes after rendering.
  if (appConnectionMode && appState && appSchema && appActiveSection) {
    var connActiveSection = appSchema.sections.find(function(s) { return s.id === appActiveSection; });
    if (connActiveSection && connActiveSection.nodeId && appState.nodeData && appState.nodeData[connActiveSection.nodeId]) {
      var sectionOutputs = appState.nodeData[connActiveSection.nodeId].outputs;
      // Walk outputs to find arrays of objects with id fields and annotate
      // matching rich cards with connection-mode data attributes.
      (function annotateOutputCards(outputs) {
        if (!outputs || typeof outputs !== 'object') return;
        var keys = Object.keys(outputs);
        for (var oi = 0; oi < keys.length; oi++) {
          var oKey = keys[oi];
          var oVal = outputs[oKey];
          if (Array.isArray(oVal) && oVal.length > 0 && oVal[0] && typeof oVal[0] === 'object') {
            // Match cards to items by index within parent grid
            var grids = root.querySelectorAll('.comp-form-rich-grid, .comp-form-array-cards');
            grids.forEach(function(grid) {
              var cards = grid.querySelectorAll(':scope > .comp-form-rich-card');
              if (cards.length !== oVal.length) return; // Skip mismatched grids
              cards.forEach(function(card, idx) {
                var item = oVal[idx];
                if (!item) return;
                var itemId = item.id || item.libraryId || item.assetId || item.slug;
                if (!itemId) return;
                var itemType = (item.type || oKey.replace(/s$/, '')).toLowerCase();
                var itemLabel = item.name || item.title || item.displayName || item.label || itemId;
                card.setAttribute('data-conn-entity-type', itemType);
                card.setAttribute('data-conn-entity-id', String(itemId));
                card.setAttribute('data-conn-entity-label', String(itemLabel));
                card.style.position = 'relative';
                var isSelected = appConnectionSelections.some(function(s) { return s.entityId === String(itemId); });
                if (isSelected) card.classList.add('app-conn-selected');
              });
            });
            return; // Only annotate the first matching array
          }
          if (oVal && typeof oVal === 'object' && !Array.isArray(oVal)) {
            annotateOutputCards(oVal);
          }
        }
      })(sectionOutputs);
    }
  }

  // ── Connection Mode wiring ──

  // Toggle connection mode
  var connToggle = root.querySelector('#app-toggle-connection-mode');
  if (connToggle) {
    connToggle.addEventListener('click', function() {
      appConnectionMode = !appConnectionMode;
      if (!appConnectionMode) {
        appConnectionSelections = [];
      }
      renderCompositionAppPage();
    });
  }

  // Clear connection selection
  var connClear = root.querySelector('#app-connection-clear');
  if (connClear) {
    connClear.addEventListener('click', function() {
      appConnectionSelections = [];
      renderCompositionAppPage();
    });
  }

  // Connection mode: entity selection on click
  if (appConnectionMode) {
    root.querySelectorAll('[data-conn-entity-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        // Don't intercept clicks on buttons/links inside the card
        if (e.target.closest('button, a, .app-panel-card-raw-btn')) return;
        e.preventDefault();
        e.stopPropagation();

        var entityType = el.getAttribute('data-conn-entity-type');
        var entityId = el.getAttribute('data-conn-entity-id');
        var entityLabel = el.getAttribute('data-conn-entity-label') || entityId;

        // Toggle selection
        var existingIdx = appConnectionSelections.findIndex(function(s) { return s.entityId === entityId; });
        if (existingIdx !== -1) {
          appConnectionSelections.splice(existingIdx, 1);
        } else {
          appConnectionSelections.push({
            entityType: entityType,
            entityId: entityId,
            label: entityLabel,
          });
        }
        renderCompositionAppPage();
      });
    });
  }

  // Connection tray actions
  var connDescribeBtn = root.querySelector('#app-conn-describe-btn');
  if (connDescribeBtn) {
    connDescribeBtn.addEventListener('click', function() {
      openConnectionModal();
    });
  }

  // Quick binding buttons in the tray
  root.querySelectorAll('.app-conn-quick-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var bindType = btn.getAttribute('data-conn-quick-type');
      if (!bindType || appConnectionSelections.length < 2) return;

      btn.disabled = true;
      btn.textContent = 'Creating...';
      try {
        await createQuickBindings(bindType);
        toast('Bindings created', 'success');
        // Refresh bindings
        appBindings = await fetchAppBindings(compData.id);
        renderCompositionAppPage();
      } catch (err) {
        toast('Failed: ' + (err.message || err), 'error');
        btn.disabled = false;
      }
    });
  });

  // Remove selection chip
  root.querySelectorAll('.app-conn-chip-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var entityId = btn.getAttribute('data-conn-remove');
      appConnectionSelections = appConnectionSelections.filter(function(s) { return s.entityId !== entityId; });
      renderCompositionAppPage();
    });
  });

  // Connection modal submit
  var connModalSubmit = root.querySelector('#app-conn-modal-submit');
  if (connModalSubmit) {
    connModalSubmit.addEventListener('click', async function() {
      var descInput = root.querySelector('#app-conn-modal-desc');
      var typeSelect = root.querySelector('#app-conn-modal-type');
      if (!descInput || !typeSelect) return;

      var description = descInput.value.trim();
      var bindingType = typeSelect.value;

      if (!bindingType) {
        toast('Select a connection type', 'error');
        return;
      }

      connModalSubmit.disabled = true;
      connModalSubmit.textContent = 'Creating...';

      try {
        await createBindingsFromModal(bindingType, description);
        toast('Connections created!', 'success');
        appBindings = await fetchAppBindings(compData.id);
        appConnectionSelections = [];
        closeConnectionModal();
        renderCompositionAppPage();
      } catch (err) {
        toast('Failed: ' + (err.message || err), 'error');
        connModalSubmit.disabled = false;
        connModalSubmit.textContent = 'Create Connections';
      }
    });
  }

  var connModalCancel = root.querySelector('#app-conn-modal-cancel');
  if (connModalCancel) {
    connModalCancel.addEventListener('click', closeConnectionModal);
  }
  var connModalBackdrop = root.querySelector('#app-conn-modal-backdrop');
  if (connModalBackdrop) {
    connModalBackdrop.addEventListener('click', closeConnectionModal);
  }

  // Auto-Scan button
  var autoScanBtn = root.querySelector('#app-conn-auto-scan');
  if (autoScanBtn) {
    autoScanBtn.addEventListener('click', async function() {
      await runAutoScan();
      // Refresh bindings after scan
      if (compData && compData.id) {
        appBindings = await fetchAppBindings(compData.id);
        renderCompositionAppPage();
      }
    });
  }

  // Rules button
  var manageRulesBtn = root.querySelector('#app-conn-manage-rules');
  if (manageRulesBtn) {
    manageRulesBtn.addEventListener('click', function() {
      openRulesModal();
    });
  }
}


// ────────────────────────────────────────────────────────────────
//  Dialogue Edit Modal
// ────────────────────────────────────────────────────────────────

/**
 * Open a modal to edit all fields of a dialogue element.
 * @param {Object} elemData - The dialogue element data { id, characterName, characterId, modifiers, lines }
 * @param {HTMLElement} root - The root DOM element
 */
function openDialogueEditModal(elemData, root) {
  var modal = document.getElementById('app-detail-modal');
  var modalBody = document.getElementById('app-detail-modal-body');
  if (!modal || !modalBody) return;

  var charColor = nleCharColor(elemData.characterName || 'UNKNOWN');
  
  var html = '<div class="dialogue-edit-modal">';
  html += '<h3 class="dialogue-edit-title" style="border-left: 4px solid ' + charColor + '; padding-left: 12px;">Edit Dialogue</h3>';
  
  // Character name field
  html += '<div class="dialogue-edit-field">';
  html += '<label class="dialogue-edit-label">Character Name</label>';
  html += '<input type="text" class="dialogue-edit-input" id="dialogue-edit-character" value="' + compEscAttr(elemData.characterName || '') + '" placeholder="CHARACTER NAME" style="text-transform: uppercase;" />';
  html += '</div>';
  
  // Modifiers field (V.O., O.S., CONT'D, etc.)
  html += '<div class="dialogue-edit-field">';
  html += '<label class="dialogue-edit-label">Modifiers <span class="dialogue-edit-hint">(V.O., O.S., CONT\'D, etc. — comma separated)</span></label>';
  html += '<input type="text" class="dialogue-edit-input" id="dialogue-edit-modifiers" value="' + compEscAttr((elemData.modifiers || []).join(', ')) + '" placeholder="V.O., CONT\'D" />';
  html += '<div class="dialogue-edit-modifier-chips">';
  var commonMods = ['V.O.', 'O.S.', 'O.C.', 'CONT\'D', 'PRE-LAP', 'FILTERED', 'INTO PHONE'];
  for (var mi = 0; mi < commonMods.length; mi++) {
    html += '<button class="dialogue-edit-mod-chip" data-mod="' + compEscAttr(commonMods[mi]) + '">' + compEscHtml(commonMods[mi]) + '</button>';
  }
  html += '</div>';
  html += '</div>';
  
  // Dialogue lines
  html += '<div class="dialogue-edit-field">';
  html += '<label class="dialogue-edit-label">Dialogue Lines</label>';
  html += '<div class="dialogue-edit-lines" id="dialogue-edit-lines">';
  var lines = elemData.lines || [''];
  for (var li = 0; li < lines.length; li++) {
    html += '<div class="dialogue-edit-line-row" data-line-index="' + li + '">';
    html += '<textarea class="dialogue-edit-textarea" rows="2" placeholder="Enter dialogue...">' + compEscHtml(lines[li]) + '</textarea>';
    if (lines.length > 1) {
      html += '<button class="dialogue-edit-line-remove" data-remove-line="' + li + '" title="Remove line">&times;</button>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<button class="dialogue-edit-add-line" id="dialogue-edit-add-line">+ Add Line</button>';
  html += '</div>';
  
  // Actions
  html += '<div class="dialogue-edit-actions">';
  html += '<button class="dialogue-edit-save" id="dialogue-edit-save" data-element-id="' + compEscAttr(elemData.id) + '">Save Changes</button>';
  html += '<button class="dialogue-edit-cancel" id="dialogue-edit-cancel">Cancel</button>';
  html += '</div>';
  
  html += '</div>';
  
  modalBody.innerHTML = html;
  modal.className = 'app-detail-modal open app-detail-modal--dialogue';
  document.body.style.overflow = 'hidden';
  
  // Wire up modal interactions
  wireDialogueEditModal(elemData, root);
}

/**
 * Wire up the dialogue edit modal interactions.
 */
function wireDialogueEditModal(elemData, root) {
  var modal = document.getElementById('app-detail-modal');
  var modalBody = document.getElementById('app-detail-modal-body');
  if (!modal || !modalBody) return;
  
  // Modifier chip clicks — toggle modifier in the input
  modalBody.querySelectorAll('.dialogue-edit-mod-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      var mod = chip.getAttribute('data-mod');
      var input = modalBody.querySelector('#dialogue-edit-modifiers');
      if (!input || !mod) return;
      
      var current = input.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      var idx = current.indexOf(mod);
      if (idx !== -1) {
        current.splice(idx, 1);
        chip.classList.remove('active');
      } else {
        current.push(mod);
        chip.classList.add('active');
      }
      input.value = current.join(', ');
    });
    
    // Mark active chips based on current modifiers
    var mod = chip.getAttribute('data-mod');
    if ((elemData.modifiers || []).indexOf(mod) !== -1) {
      chip.classList.add('active');
    }
  });
  
  // Add line button
  var addLineBtn = modalBody.querySelector('#dialogue-edit-add-line');
  if (addLineBtn) {
    addLineBtn.addEventListener('click', function() {
      var linesContainer = modalBody.querySelector('#dialogue-edit-lines');
      if (!linesContainer) return;
      
      var lineRows = linesContainer.querySelectorAll('.dialogue-edit-line-row');
      var newIndex = lineRows.length;
      
      var newRow = document.createElement('div');
      newRow.className = 'dialogue-edit-line-row';
      newRow.setAttribute('data-line-index', newIndex);
      newRow.innerHTML = '<textarea class="dialogue-edit-textarea" rows="2" placeholder="Enter dialogue..."></textarea>' +
        '<button class="dialogue-edit-line-remove" data-remove-line="' + newIndex + '" title="Remove line">&times;</button>';
      linesContainer.appendChild(newRow);
      
      // Focus the new textarea
      var newTextarea = newRow.querySelector('textarea');
      if (newTextarea) newTextarea.focus();
      
      // Wire remove button
      var removeBtn = newRow.querySelector('.dialogue-edit-line-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', function() {
          newRow.remove();
          updateRemoveButtons();
        });
      }
      
      updateRemoveButtons();
    });
  }
  
  // Remove line buttons
  modalBody.querySelectorAll('.dialogue-edit-line-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var row = btn.closest('.dialogue-edit-line-row');
      if (row) row.remove();
      updateRemoveButtons();
    });
  });
  
  function updateRemoveButtons() {
    var linesContainer = modalBody.querySelector('#dialogue-edit-lines');
    if (!linesContainer) return;
    var rows = linesContainer.querySelectorAll('.dialogue-edit-line-row');
    rows.forEach(function(row, idx) {
      row.setAttribute('data-line-index', idx);
      var removeBtn = row.querySelector('.dialogue-edit-line-remove');
      if (removeBtn) {
        removeBtn.setAttribute('data-remove-line', idx);
        // Hide remove button if only one line
        removeBtn.style.display = rows.length > 1 ? '' : 'none';
      }
    });
  }
  
  // Cancel button
  var cancelBtn = modalBody.querySelector('#dialogue-edit-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      closeDialogueEditModal();
    });
  }
  
  // Save button
  var saveBtn = modalBody.querySelector('#dialogue-edit-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async function() {
      var elementId = saveBtn.getAttribute('data-element-id');
      if (!elementId) return;
      
      // Collect values
      var charInput = modalBody.querySelector('#dialogue-edit-character');
      var modInput = modalBody.querySelector('#dialogue-edit-modifiers');
      var linesContainer = modalBody.querySelector('#dialogue-edit-lines');
      
      var newCharName = charInput ? charInput.value.trim().toUpperCase() : '';
      var newModifiers = modInput ? modInput.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
      var newLines = [];
      if (linesContainer) {
        linesContainer.querySelectorAll('.dialogue-edit-textarea').forEach(function(ta) {
          var line = ta.value.trim();
          if (line) newLines.push(line);
        });
      }
      if (newLines.length === 0) newLines = [''];
      
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      
      try {
        // Save each field that changed
        var updates = [];
        if (newCharName !== elemData.characterName) {
          updates.push({ field: 'characterName', value: newCharName });
        }
        if (JSON.stringify(newModifiers) !== JSON.stringify(elemData.modifiers || [])) {
          updates.push({ field: 'modifiers', value: newModifiers });
        }
        if (JSON.stringify(newLines) !== JSON.stringify(elemData.lines || [])) {
          updates.push({ field: 'lines', value: newLines });
        }
        
        if (updates.length === 0) {
          toast('No changes to save', 'info');
          closeDialogueEditModal();
          return;
        }
        
        // Save all updates
        for (var ui = 0; ui < updates.length; ui++) {
          var update = updates[ui];
          var res = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/element/' + encodeURIComponent(elementId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              field: update.field,
              value: update.value,
              elementType: 'dialogue',
            }),
          });
          
          if (!res.ok) {
            var errData = await res.json();
            throw new Error(errData.error || 'Failed to save ' + update.field);
          }
        }
        
        toast('Dialogue saved', 'success');
        closeDialogueEditModal();
        
        // Refresh the page to show updated dialogue
        renderCompositionAppPage();
        
      } catch (err) {
        toast('Save failed: ' + (err.message || err), 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    });
  }
}

function closeDialogueEditModal() {
  var modal = document.getElementById('app-detail-modal');
  if (modal) {
    modal.classList.remove('open');
    var modalBody = document.getElementById('app-detail-modal-body');
    if (modalBody) modalBody.innerHTML = '';
    document.body.style.overflow = '';
  }
}

// ────────────────────────────────────────────────────────────────
//  Connection Mode — rendering and logic
// ────────────────────────────────────────────────────────────────

/**
 * Render the floating connection tray that appears at the bottom
 * when connection mode is active and entities are selected.
 */
function renderConnectionTray() {
  var html = '<div class="app-conn-tray' + (appConnectionSelections.length > 0 ? ' app-conn-tray--has-items' : '') + '" id="app-conn-tray">';

  // Toolbar row — always visible in connection mode
  html += '<div class="app-conn-tray-toolbar">';
  html += '<button class="app-conn-toolbar-btn" id="app-conn-auto-scan" title="Automatically detect connections using your rules">';
  html += '&#x26A1; Auto-Scan</button>';
  html += '<button class="app-conn-toolbar-btn" id="app-conn-manage-rules" title="Create and edit rules for automatic connection detection">';
  html += '&#x2699; Rules</button>';
  html += '<span class="app-conn-toolbar-status" id="app-conn-scan-status"></span>';
  html += '</div>';

  if (appConnectionSelections.length === 0) {
    html += '<div class="app-conn-tray-hint">';
    html += '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.5 5.5l5 5"/></svg>';
    html += ' Click on entities to select them, or use Auto-Scan to detect connections automatically.';
    html += '</div>';
  } else {
    // Selected items chips
    html += '<div class="app-conn-tray-selections">';
    html += '<span class="app-conn-tray-label">Selected:</span>';
    for (var i = 0; i < appConnectionSelections.length; i++) {
      var sel = appConnectionSelections[i];
      html += '<span class="app-conn-chip">';
      html += '<span class="app-conn-chip-type">' + compEscHtml(sel.entityType) + '</span>';
      html += '<span class="app-conn-chip-label">' + compEscHtml(sel.label) + '</span>';
      html += '<button class="app-conn-chip-remove" data-conn-remove="' + compEscAttr(sel.entityId) + '">&times;</button>';
      html += '</span>';
    }
    html += '</div>';

    // Actions
    html += '<div class="app-conn-tray-actions">';
    if (appConnectionSelections.length >= 2) {
      // Quick binding buttons for common types
      var types = detectConnectionTypes();
      for (var ti = 0; ti < types.length; ti++) {
        html += '<button class="app-conn-quick-btn" data-conn-quick-type="' + compEscAttr(types[ti].type) + '" title="' + compEscAttr(types[ti].hint) + '">' + compEscHtml(types[ti].label) + '</button>';
      }
      html += '<button class="app-conn-describe-btn" id="app-conn-describe-btn">&#x270E; Describe Connection...</button>';
    } else {
      html += '<span class="app-conn-tray-hint">Select at least 2 entities</span>';
    }
    html += '</div>';
  }

  html += '</div>';

  // Connection modal (hidden by default)
  html += '<div class="app-conn-modal" id="app-conn-modal" style="display:none;">';
  html += '<div class="app-conn-modal-backdrop" id="app-conn-modal-backdrop"></div>';
  html += '<div class="app-conn-modal-container">';
  html += '<h3 class="app-conn-modal-title">Create Connection</h3>';
  html += renderConnectionModalBody();
  html += '</div>';
  html += '</div>';

  // Rules editor modal (hidden by default)
  html += renderRulesModal();

  return html;
}

/**
 * Detect smart quick-action binding types based on the selected entity types.
 */
function detectConnectionTypes() {
  var types = [];
  var entityTypes = {};
  for (var i = 0; i < appConnectionSelections.length; i++) {
    var t = appConnectionSelections[i].entityType;
    if (!entityTypes[t]) entityTypes[t] = [];
    entityTypes[t].push(appConnectionSelections[i]);
  }

  var hasShot = !!entityTypes['shot'];
  var hasCharacter = !!entityTypes['character'];
  var hasLocation = !!entityTypes['location'];

  if (hasShot && hasCharacter) {
    types.push({ type: 'depicts', label: 'Depicts', hint: 'Shot depicts these characters' });
  }
  if (hasShot && hasLocation) {
    types.push({ type: 'set-in', label: 'Set In', hint: 'Shot is set in this location' });
  }
  if (hasCharacter && entityTypes['character'] && entityTypes['character'].length >= 2) {
    types.push({ type: 'related-to', label: 'Related', hint: 'Characters are related' });
  }

  // Generic fallback
  if (types.length === 0) {
    types.push({ type: 'references', label: 'References', hint: 'Generic reference connection' });
  }

  return types;
}

/**
 * Render the body of the connection modal with selected entities
 * and a description field.
 */
function renderConnectionModalBody() {
  var html = '<div class="app-conn-modal-body">';

  // Show selected entities
  html += '<div class="app-conn-modal-entities">';
  for (var i = 0; i < appConnectionSelections.length; i++) {
    var sel = appConnectionSelections[i];
    if (i > 0) {
      html += '<span class="app-conn-modal-arrow">&rarr;</span>';
    }
    html += '<div class="app-conn-modal-entity">';
    html += '<span class="app-conn-modal-entity-type">' + compEscHtml(sel.entityType) + '</span>';
    html += '<span class="app-conn-modal-entity-label">' + compEscHtml(sel.label) + '</span>';
    html += '</div>';
  }
  html += '</div>';

  // Connection type selector
  html += '<div class="app-conn-modal-field">';
  html += '<label class="app-conn-modal-label">Connection Type</label>';
  html += '<select class="app-conn-modal-select" id="app-conn-modal-type">';
  var detectedTypes = detectConnectionTypes();
  for (var ti = 0; ti < detectedTypes.length; ti++) {
    html += '<option value="' + compEscAttr(detectedTypes[ti].type) + '">' + compEscHtml(detectedTypes[ti].label) + ' — ' + compEscHtml(detectedTypes[ti].hint) + '</option>';
  }
  html += '<option value="depicts">Depicts (character in shot)</option>';
  html += '<option value="set-in">Set In (shot in location)</option>';
  html += '<option value="voice">Voice (dialogue by character)</option>';
  html += '<option value="references">References (generic)</option>';
  html += '<option value="custom">Custom...</option>';
  html += '</select>';
  html += '</div>';

  // Description/notes
  html += '<div class="app-conn-modal-field">';
  html += '<label class="app-conn-modal-label">Description (optional)</label>';
  html += '<textarea class="app-conn-modal-textarea" id="app-conn-modal-desc" placeholder="Describe the connection or any notes..." rows="3"></textarea>';
  html += '</div>';

  // Direction hint
  if (appConnectionSelections.length === 2) {
    html += '<div class="app-conn-modal-direction">';
    html += 'Direction: <strong>' + compEscHtml(appConnectionSelections[0].label) + '</strong> &rarr; <strong>' + compEscHtml(appConnectionSelections[1].label) + '</strong>';
    html += ' <button class="app-conn-modal-swap" id="app-conn-modal-swap">&#x21C4; Swap</button>';
    html += '</div>';
  }

  // Actions
  html += '<div class="app-conn-modal-actions">';
  html += '<button class="app-conn-modal-btn app-conn-modal-btn--primary" id="app-conn-modal-submit">Create Connections</button>';
  html += '<button class="app-conn-modal-btn" id="app-conn-modal-cancel">Cancel</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function openConnectionModal() {
  var modal = document.getElementById('app-conn-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Wire swap button
    var swapBtn = modal.querySelector('#app-conn-modal-swap');
    if (swapBtn) {
      swapBtn.addEventListener('click', function() {
        appConnectionSelections.reverse();
        // Re-render modal body
        var container = modal.querySelector('.app-conn-modal-container');
        if (container) {
          container.innerHTML = '<h3 class="app-conn-modal-title">Create Connection</h3>' + renderConnectionModalBody();
          // Re-wire swap button
          var newSwap = container.querySelector('#app-conn-modal-swap');
          if (newSwap) {
            newSwap.addEventListener('click', function() {
              appConnectionSelections.reverse();
              openConnectionModal(); // Re-render
            });
          }
        }
      });
    }
  }
}

function closeConnectionModal() {
  var modal = document.getElementById('app-conn-modal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

/**
 * Create quick bindings between selected entities using a specific type.
 * First selected entity of one type becomes source, others become targets.
 */
async function createQuickBindings(bindingType) {
  if (appConnectionSelections.length < 2 || !compData) return;

  // Determine source and targets based on binding type
  var source, targets;

  if (bindingType === 'depicts' || bindingType === 'set-in') {
    // Source = shots, targets = characters/locations
    var shots = appConnectionSelections.filter(function(s) { return s.entityType === 'shot'; });
    var others = appConnectionSelections.filter(function(s) { return s.entityType !== 'shot'; });
    if (shots.length === 0 || others.length === 0) {
      // Fall back: first is source, rest are targets
      source = [appConnectionSelections[0]];
      targets = appConnectionSelections.slice(1);
    } else {
      source = shots;
      targets = others;
    }
  } else {
    // Generic: first selected is source, rest are targets
    source = [appConnectionSelections[0]];
    targets = appConnectionSelections.slice(1);
  }

  // Create one binding per source-target pair
  for (var si = 0; si < source.length; si++) {
    for (var ti = 0; ti < targets.length; ti++) {
      await createAppBinding(compData.id, {
        type: bindingType,
        source: { entityType: source[si].entityType, entityId: source[si].entityId },
        target: { entityType: targets[ti].entityType, entityId: targets[ti].entityId },
        confidence: 1.0,
        origin: 'manual',
      });
    }
  }
}

/**
 * Create bindings from the modal form.
 */
async function createBindingsFromModal(bindingType, description) {
  if (appConnectionSelections.length < 2 || !compData) return;

  // First entity is source, rest are targets
  var sourceEntity = appConnectionSelections[0];

  for (var i = 1; i < appConnectionSelections.length; i++) {
    var target = appConnectionSelections[i];
    await createAppBinding(compData.id, {
      type: bindingType,
      source: { entityType: sourceEntity.entityType, entityId: sourceEntity.entityId },
      target: { entityType: target.entityType, entityId: target.entityId },
      confidence: 1.0,
      origin: 'manual',
      metadata: description ? { description: description } : undefined,
    });
  }
}

// ── Rules Modal ──────────────────────────────────────────────

/**
 * Cached rules loaded from the server.
 */
var appBindingRules = [];

/**
 * Known entity types discovered from pipeline data — populated by scanning.
 */
var appKnownEntityTypes = ['shot', 'character', 'location', 'scene', 'dialogue'];

/**
 * Known entity fields per type — populated when data is available.
 */
var appKnownEntityFields = {
  shot: ['shotText', 'content', 'description', 'text', 'action'],
  character: ['name', 'displayName', 'aliases'],
  location: ['name', 'description'],
  scene: ['heading', 'sceneHeading', 'title', 'content'],
  dialogue: ['text', 'content', 'characterName'],
};

/**
 * Render the rules editor modal.
 */
function renderRulesModal() {
  var html = '<div class="app-rules-modal" id="app-rules-modal" style="display:none;">';
  html += '<div class="app-rules-modal-backdrop" id="app-rules-modal-backdrop"></div>';
  html += '<div class="app-rules-modal-container">';

  // Header
  html += '<div class="app-rules-modal-header">';
  html += '<h3 class="app-rules-modal-title">Connection Rules</h3>';
  html += '<p class="app-rules-modal-subtitle">Rules automatically detect connections between entities in your pipeline. ';
  html += 'For example, a rule can find character names mentioned in shot descriptions.</p>';
  html += '</div>';

  // Rules list
  html += '<div class="app-rules-list" id="app-rules-list">';
  if (appBindingRules.length === 0) {
    html += '<div class="app-rules-empty">';
    html += '<p>No rules yet. Add a rule to automatically detect connections.</p>';
    html += '</div>';
  } else {
    for (var ri = 0; ri < appBindingRules.length; ri++) {
      var rule = appBindingRules[ri];
      html += renderRuleCard(rule, ri);
    }
  }
  html += '</div>';

  // Add rule button
  html += '<div class="app-rules-add-row">';
  html += '<button class="app-rules-add-btn" id="app-rules-add-btn">+ Add Rule</button>';
  html += '</div>';

  // Preset rules
  html += '<div class="app-rules-presets">';
  html += '<span class="app-rules-presets-label">Quick presets:</span>';
  html += '<button class="app-rules-preset-btn" data-preset="character-in-shot">Character names in shots</button>';
  html += '<button class="app-rules-preset-btn" data-preset="location-in-shot">Location names in shots</button>';
  html += '<button class="app-rules-preset-btn" data-preset="character-in-dialogue">Character in dialogue</button>';
  html += '</div>';

  // Actions
  html += '<div class="app-rules-modal-actions">';
  html += '<button class="app-conn-modal-btn app-conn-modal-btn--primary" id="app-rules-save-btn">Save Rules</button>';
  html += '<button class="app-conn-modal-btn" id="app-rules-cancel-btn">Cancel</button>';
  html += '</div>';

  html += '</div>';
  html += '</div>';
  return html;
}

/**
 * Render a single rule as an editable card.
 */
function renderRuleCard(rule, index) {
  var html = '<div class="app-rule-card" data-rule-index="' + index + '">';

  // Enable toggle + name
  html += '<div class="app-rule-card-header">';
  html += '<label class="app-rule-toggle">';
  html += '<input type="checkbox" class="app-rule-enabled" data-rule-idx="' + index + '"' + (rule.enabled ? ' checked' : '') + '>';
  html += '</label>';
  html += '<input type="text" class="app-rule-name" data-rule-idx="' + index + '" value="' + compEscAttr(rule.name || '') + '" placeholder="Rule name...">';
  html += '<button class="app-rule-delete" data-rule-idx="' + index + '" title="Delete rule">&times;</button>';
  html += '</div>';

  // Visual rule builder: "When [source type]'s [field] contains [target type]'s [field], create [relationship]"
  html += '<div class="app-rule-builder">';

  // Source row
  html += '<div class="app-rule-row">';
  html += '<span class="app-rule-keyword">When</span>';
  html += '<select class="app-rule-select app-rule-source-type" data-rule-idx="' + index + '">';
  for (var et = 0; et < appKnownEntityTypes.length; et++) {
    var st = appKnownEntityTypes[et];
    html += '<option value="' + compEscAttr(st) + '"' + (rule.source && rule.source.entityType === st ? ' selected' : '') + '>' + compEscHtml(st) + '</option>';
  }
  html += '</select>';
  html += '<span class="app-rule-keyword">\'s</span>';
  html += '<select class="app-rule-select app-rule-source-field" data-rule-idx="' + index + '">';
  var srcType = (rule.source && rule.source.entityType) || appKnownEntityTypes[0];
  var srcFields = appKnownEntityFields[srcType] || ['name', 'text', 'content', 'description'];
  for (var sf = 0; sf < srcFields.length; sf++) {
    html += '<option value="' + compEscAttr(srcFields[sf]) + '"' + (rule.source && rule.source.field === srcFields[sf] ? ' selected' : '') + '>' + compEscHtml(srcFields[sf]) + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Match row
  html += '<div class="app-rule-row">';
  html += '<span class="app-rule-keyword">contains</span>';
  html += '<select class="app-rule-select app-rule-target-type" data-rule-idx="' + index + '">';
  for (var tt = 0; tt < appKnownEntityTypes.length; tt++) {
    var tType = appKnownEntityTypes[tt];
    html += '<option value="' + compEscAttr(tType) + '"' + (rule.target && rule.target.entityType === tType ? ' selected' : '') + '>' + compEscHtml(tType) + '</option>';
  }
  html += '</select>';
  html += '<span class="app-rule-keyword">\'s</span>';
  html += '<select class="app-rule-select app-rule-target-field" data-rule-idx="' + index + '">';
  var tgtType = (rule.target && rule.target.entityType) || appKnownEntityTypes[1];
  var tgtFields = appKnownEntityFields[tgtType] || ['name', 'text', 'content', 'description'];
  for (var tf = 0; tf < tgtFields.length; tf++) {
    html += '<option value="' + compEscAttr(tgtFields[tf]) + '"' + (rule.target && rule.target.matchField === tgtFields[tf] ? ' selected' : '') + '>' + compEscHtml(tgtFields[tf]) + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Relationship row
  html += '<div class="app-rule-row">';
  html += '<span class="app-rule-keyword">create</span>';
  html += '<select class="app-rule-select app-rule-relationship" data-rule-idx="' + index + '">';
  var rels = ['depicts', 'set-in', 'voice', 'related-to', 'references'];
  for (var ri2 = 0; ri2 < rels.length; ri2++) {
    html += '<option value="' + compEscAttr(rels[ri2]) + '"' + (rule.relationship === rels[ri2] ? ' selected' : '') + '>' + compEscHtml(rels[ri2]) + '</option>';
  }
  html += '</select>';
  html += '<span class="app-rule-keyword">connection</span>';
  html += '</div>';

  // Match options
  html += '<div class="app-rule-options">';
  html += '<label class="app-rule-option"><input type="checkbox" class="app-rule-whole-word" data-rule-idx="' + index + '"' + ((rule.matchOptions && rule.matchOptions.wholeWord !== false) || !rule.matchOptions ? ' checked' : '') + '> Whole word</label>';
  html += '<label class="app-rule-option"><input type="checkbox" class="app-rule-case-sensitive" data-rule-idx="' + index + '"' + (rule.matchOptions && rule.matchOptions.caseSensitive ? ' checked' : '') + '> Case sensitive</label>';
  html += '</div>';

  html += '</div>'; // .app-rule-builder
  html += '</div>'; // .app-rule-card
  return html;
}

/**
 * Create a default empty rule.
 */
function createDefaultRule() {
  return {
    id: 'rule-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    name: '',
    enabled: true,
    type: 'text-match',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'depicts',
    matchOptions: { caseSensitive: false, wholeWord: true },
  };
}

/**
 * Preset rule configurations for common patterns.
 */
var rulePresets = {
  'character-in-shot': {
    name: 'Character names in shot descriptions',
    type: 'text-match',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'depicts',
    matchOptions: { caseSensitive: false, wholeWord: true },
  },
  'location-in-shot': {
    name: 'Location names in shot descriptions',
    type: 'text-match',
    source: { entityType: 'shot', field: 'shotText' },
    target: { entityType: 'location', matchField: 'name' },
    relationship: 'set-in',
    matchOptions: { caseSensitive: false, wholeWord: true },
  },
  'character-in-dialogue': {
    name: 'Character name in dialogue text',
    type: 'text-match',
    source: { entityType: 'dialogue', field: 'characterName' },
    target: { entityType: 'character', matchField: 'name' },
    relationship: 'voice',
    matchOptions: { caseSensitive: false, wholeWord: true },
  },
};

/**
 * Open the rules modal. Loads rules from the server first.
 */
async function openRulesModal() {
  if (!compData || !compData.id) return;

  // Load existing rules
  try {
    var resp = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/rules');
    if (resp.ok) {
      var rulesDoc = await resp.json();
      appBindingRules = rulesDoc.rules || [];
    }
  } catch (err) {
    console.error('Failed to load rules:', err);
  }

  // Re-render the rules list
  var listEl = document.getElementById('app-rules-list');
  if (listEl) {
    if (appBindingRules.length === 0) {
      listEl.innerHTML = '<div class="app-rules-empty"><p>No rules yet. Add a rule to automatically detect connections.</p></div>';
    } else {
      var html = '';
      for (var ri = 0; ri < appBindingRules.length; ri++) {
        html += renderRuleCard(appBindingRules[ri], ri);
      }
      listEl.innerHTML = html;
    }
  }

  // Show modal
  var modal = document.getElementById('app-rules-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    wireRulesModalEvents();
  }
}

function closeRulesModal() {
  var modal = document.getElementById('app-rules-modal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

/**
 * Wire up all interactive elements in the rules modal.
 */
function wireRulesModalEvents() {
  var modal = document.getElementById('app-rules-modal');
  if (!modal) return;

  // Backdrop click
  var backdrop = modal.querySelector('#app-rules-modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeRulesModal);
  }

  // Cancel
  var cancelBtn = modal.querySelector('#app-rules-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeRulesModal);
  }

  // Add rule
  var addBtn = modal.querySelector('#app-rules-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', function() {
      appBindingRules.push(createDefaultRule());
      refreshRulesList();
    });
  }

  // Presets
  modal.querySelectorAll('.app-rules-preset-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var presetKey = btn.getAttribute('data-preset');
      var preset = rulePresets[presetKey];
      if (preset) {
        // Check if a similar rule already exists
        var exists = appBindingRules.some(function(r) { return r.name === preset.name; });
        if (exists) {
          toast('Rule already exists: ' + preset.name, 'info');
          return;
        }
        var newRule = Object.assign({}, createDefaultRule(), preset);
        appBindingRules.push(newRule);
        refreshRulesList();
      }
    });
  });

  // Save
  var saveBtn = modal.querySelector('#app-rules-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async function() {
      collectRulesFromForm();
      try {
        var resp = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/rules', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: appBindingRules }),
        });
        if (resp.ok) {
          toast('Rules saved', 'success');
          closeRulesModal();
        } else {
          var err = await resp.json();
          toast('Failed to save rules: ' + (err.error || 'unknown'), 'error');
        }
      } catch (err2) {
        toast('Failed to save rules', 'error');
      }
    });
  }

  // Wire delete buttons and field changes
  wireRuleCardEvents(modal);
}

/**
 * Wire events on individual rule cards (delete, field changes).
 */
function wireRuleCardEvents(container) {
  // Delete buttons
  container.querySelectorAll('.app-rule-delete').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.getAttribute('data-rule-idx'), 10);
      if (!isNaN(idx) && idx >= 0 && idx < appBindingRules.length) {
        appBindingRules.splice(idx, 1);
        refreshRulesList();
      }
    });
  });

  // Source type change → update source field options
  container.querySelectorAll('.app-rule-source-type').forEach(function(sel) {
    sel.addEventListener('change', function() {
      var idx = parseInt(sel.getAttribute('data-rule-idx'), 10);
      if (!isNaN(idx) && appBindingRules[idx]) {
        collectRulesFromForm();
        refreshRulesList();
      }
    });
  });

  // Target type change → update target field options
  container.querySelectorAll('.app-rule-target-type').forEach(function(sel) {
    sel.addEventListener('change', function() {
      var idx = parseInt(sel.getAttribute('data-rule-idx'), 10);
      if (!isNaN(idx) && appBindingRules[idx]) {
        collectRulesFromForm();
        refreshRulesList();
      }
    });
  });
}

/**
 * Collect current form values into appBindingRules.
 */
function collectRulesFromForm() {
  var modal = document.getElementById('app-rules-modal');
  if (!modal) return;

  var cards = modal.querySelectorAll('.app-rule-card');
  cards.forEach(function(card, idx) {
    if (idx >= appBindingRules.length) return;
    var rule = appBindingRules[idx];

    var nameInput = card.querySelector('.app-rule-name');
    if (nameInput) rule.name = nameInput.value;

    var enabledCb = card.querySelector('.app-rule-enabled');
    if (enabledCb) rule.enabled = enabledCb.checked;

    var srcType = card.querySelector('.app-rule-source-type');
    if (srcType) rule.source.entityType = srcType.value;

    var srcField = card.querySelector('.app-rule-source-field');
    if (srcField) rule.source.field = srcField.value;

    var tgtType = card.querySelector('.app-rule-target-type');
    if (tgtType) rule.target.entityType = tgtType.value;

    var tgtField = card.querySelector('.app-rule-target-field');
    if (tgtField) rule.target.matchField = tgtField.value;

    var relSelect = card.querySelector('.app-rule-relationship');
    if (relSelect) rule.relationship = relSelect.value;

    var wholeWord = card.querySelector('.app-rule-whole-word');
    if (wholeWord) {
      if (!rule.matchOptions) rule.matchOptions = {};
      rule.matchOptions.wholeWord = wholeWord.checked;
    }

    var caseSensitive = card.querySelector('.app-rule-case-sensitive');
    if (caseSensitive) {
      if (!rule.matchOptions) rule.matchOptions = {};
      rule.matchOptions.caseSensitive = caseSensitive.checked;
    }
  });
}

/**
 * Re-render the rules list inside the modal and re-wire events.
 */
function refreshRulesList() {
  var listEl = document.getElementById('app-rules-list');
  if (!listEl) return;
  if (appBindingRules.length === 0) {
    listEl.innerHTML = '<div class="app-rules-empty"><p>No rules yet. Add a rule to automatically detect connections.</p></div>';
  } else {
    var html = '';
    for (var ri = 0; ri < appBindingRules.length; ri++) {
      html += renderRuleCard(appBindingRules[ri], ri);
    }
    listEl.innerHTML = html;
  }
  wireRuleCardEvents(listEl);
}

// ── Auto-Scan ────────────────────────────────────────────────

/**
 * Run auto-scan: execute the pipeline's binding rules against its data.
 * Shows progress in the status span and toasts the result.
 */
async function runAutoScan() {
  if (!compData || !compData.id) return;

  var statusEl = document.getElementById('app-conn-scan-status');
  var scanBtn = document.getElementById('app-conn-auto-scan');
  if (scanBtn) scanBtn.disabled = true;
  if (statusEl) statusEl.textContent = 'Scanning...';

  try {
    var resp = await fetch('/api/app/' + encodeURIComponent(compData.id) + '/rules/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    var data = await resp.json();

    if (!resp.ok) {
      toast('Scan failed: ' + (data.error || 'unknown'), 'error');
      if (statusEl) statusEl.textContent = 'Failed';
      return;
    }

    if (data.message === 'No rules configured') {
      toast('No rules configured yet — click Rules to set up auto-detection.', 'info');
      if (statusEl) statusEl.textContent = 'No rules';
      return;
    }

    var msg = data.added + ' connection' + (data.added === 1 ? '' : 's') + ' found';
    if (data.replaced > 0) msg += ' (' + data.replaced + ' updated)';
    toast(msg, data.added > 0 ? 'success' : 'info');
    if (statusEl) statusEl.textContent = msg;

  } catch (err) {
    toast('Scan failed: ' + (err.message || err), 'error');
    if (statusEl) statusEl.textContent = 'Error';
  } finally {
    if (scanBtn) scanBtn.disabled = false;
  }
}

// ── Inline Chat Command ──────────────────────────────────────

/**
 * Send a message to the chat agent from the app command bar.
 * Streams the response into a response area below the input.
 */
async function sendAppCommand(message, pipelineId, root) {
  var responseEl = root.querySelector('#app-command-response');
  var inputEl = root.querySelector('#app-command-input');
  var spinnerEl = root.querySelector('#app-command-spinner');
  if (!responseEl) return;

  responseEl.style.display = 'block';
  responseEl.style.opacity = '1';
  responseEl.innerHTML = '<div class="app-command-thinking">Thinking...</div>';
  if (inputEl) inputEl.disabled = true;
  if (spinnerEl) spinnerEl.style.display = 'flex';

  try {
    var resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        history: [],
        activeCompositionId: pipelineId,
      }),
    });

    if (!resp.ok) {
      var errData = await resp.json();
      responseEl.innerHTML = '<div class="app-command-error">Error: ' + compEscHtml(errData.error || 'Request failed') + '</div>';
      return;
    }

    // Read SSE stream
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var accumulatedText = '';
    var toolNames = [];

    responseEl.innerHTML = '';

    function processChunk() {
      return reader.read().then(function(result) {
        if (result.done) return;

        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = '';

        var eventType = null;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              var data = JSON.parse(line.slice(6));
              if (eventType === 'token' && data.token) {
                accumulatedText += data.token;
              } else if (eventType === 'tool_start' && data.tool) {
                toolNames.push(data.tool);
              } else if (eventType === 'done') {
                if (data.fullText) accumulatedText = data.fullText;
              }
            } catch (e) { /* skip parse errors */ }
          }
        }

        // Render accumulated text
        var html = '';
        if (toolNames.length > 0) {
          html += '<div class="app-command-tools">';
          for (var ti = 0; ti < toolNames.length; ti++) {
            html += '<span class="app-command-tool-pill">' + compEscHtml(toolNames[ti]) + '</span>';
          }
          html += '</div>';
        }
        if (accumulatedText) {
          // Simple markdown-to-html (bold, code, newlines)
          var rendered = compEscHtml(accumulatedText)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
          html += '<div class="app-command-text">' + rendered + '</div>';
        } else if (toolNames.length > 0) {
          html += '<div class="app-command-thinking">Working...</div>';
        }
        responseEl.innerHTML = html;
        responseEl.scrollTop = responseEl.scrollHeight;

        return processChunk();
      });
    }

    await processChunk();

    // Final render
    if (!accumulatedText && toolNames.length > 0) {
      responseEl.innerHTML += '<div class="app-command-text">Done. Changes applied.</div>';
    }

  } catch (err) {
    responseEl.innerHTML = '<div class="app-command-error">Error: ' + compEscHtml(err.message || String(err)) + '</div>';
  } finally {
    if (spinnerEl) spinnerEl.style.display = 'none';
    if (inputEl) inputEl.disabled = false;
    if (inputEl) inputEl.focus();

    // Auto-hide after a delay if short response
    setTimeout(function() {
      if (responseEl && responseEl.scrollHeight < 100) {
        responseEl.style.opacity = '0.5';
      }
    }, 10000);
  }
}

// ── Save / Load system ──────────────────────────────────────────────

function wireAppSaveLoad(root) {
  var saveBtn = root.querySelector('#app-save-state');
  var loadBtn = root.querySelector('#app-load-state');
  var panel = root.querySelector('#app-save-panel');
  if (!saveBtn || !loadBtn || !panel || !compData) return;

  saveBtn.addEventListener('click', function() {
    if (panel.style.display !== 'none' && panel.getAttribute('data-mode') === 'save') {
      panel.style.display = 'none';
      return;
    }
    showSavePanel(panel);
  });

  loadBtn.addEventListener('click', function() {
    if (panel.style.display !== 'none' && panel.getAttribute('data-mode') === 'load') {
      panel.style.display = 'none';
      return;
    }
    showLoadPanel(panel);
  });
}

function showSavePanel(panel) {
  panel.setAttribute('data-mode', 'save');
  panel.style.display = 'block';

  var html = '<div class="app-save-form">';
  html += '<input type="text" class="app-save-name-input" id="app-save-name" placeholder="Save name (e.g. \'Final draft\')" />';
  html += '<input type="text" class="app-save-desc-input" id="app-save-desc" placeholder="Description (optional)" />';
  html += '<div class="app-save-form-row">';
  html += '<button class="app-save-confirm-btn" id="app-save-confirm">&#x1F4BE; Save Here</button>';
  html += '<button class="app-save-path-btn" id="app-save-to-path">&#x1F4C1; Save to Folder...</button>';
  html += '</div>';
  html += '<div class="app-save-status" id="app-save-status"></div>';
  html += '</div>';
  panel.innerHTML = html;

  var confirmBtn = panel.querySelector('#app-save-confirm');
  var pathBtn = panel.querySelector('#app-save-to-path');
  var statusEl = panel.querySelector('#app-save-status');

  confirmBtn.addEventListener('click', function() {
    doSave(null, statusEl, confirmBtn, panel);
  });

  pathBtn.addEventListener('click', function() {
    openFolderPicker(function(selectedPath) {
      doSave(selectedPath, statusEl, pathBtn, panel);
    });
  });
}

function doSave(customPath, statusEl, triggerBtn, panel) {
  if (!compData) return;
  var nameInput = panel.querySelector('#app-save-name');
  var descInput = panel.querySelector('#app-save-desc');
  var name = (nameInput && nameInput.value.trim()) || '';
  var desc = (descInput && descInput.value.trim()) || '';

  triggerBtn.disabled = true;
  triggerBtn.textContent = 'Saving...';
  statusEl.textContent = '';
  statusEl.className = 'app-save-status';

  var body = { name: name || undefined, description: desc || undefined };
  if (customPath) body.path = customPath;

  fetch('/api/app/' + encodeURIComponent(compData.id) + '/saves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
  .then(function(res) {
    triggerBtn.disabled = false;
    triggerBtn.textContent = triggerBtn.id === 'app-save-confirm' ? '\u{1F4BE} Save Here' : '\u{1F4C1} Save to Folder...';
    if (!res.ok) {
      statusEl.textContent = '\u2717 ' + (res.data.error || 'Save failed');
      statusEl.className = 'app-save-status app-save-error';
      return;
    }
    statusEl.textContent = '\u2713 Saved' + (res.data.path ? ' to ' + res.data.path : '');
    statusEl.className = 'app-save-status app-save-ok';
    toast('State saved: ' + (res.data.name || 'Untitled'), 'success');
    setTimeout(function() { panel.style.display = 'none'; }, 1500);
  })
  .catch(function(err) {
    triggerBtn.disabled = false;
    triggerBtn.textContent = triggerBtn.id === 'app-save-confirm' ? '\u{1F4BE} Save Here' : '\u{1F4C1} Save to Folder...';
    statusEl.textContent = '\u2717 ' + err.message;
    statusEl.className = 'app-save-status app-save-error';
  });
}

function showLoadPanel(panel) {
  panel.setAttribute('data-mode', 'load');
  panel.style.display = 'block';
  panel.innerHTML = '<div class="app-save-loading">Loading saves...</div>';

  fetch('/api/app/' + encodeURIComponent(compData.id) + '/saves')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var saves = data.saves || [];
    var html = '<div class="app-load-list">';

    // Load from path option
    html += '<button class="app-load-from-path-btn" id="app-load-from-path">&#x1F4C1; Load from Folder...</button>';

    if (saves.length === 0) {
      html += '<div class="app-save-empty">No saves yet. Click Save to create one.</div>';
    } else {
      for (var i = 0; i < saves.length; i++) {
        var s = saves[i];
        var dateStr = s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Unknown date';
        var sizeStr = s.size > 1048576 ? (s.size / 1048576).toFixed(1) + ' MB' : (s.size / 1024).toFixed(0) + ' KB';

        html += '<div class="app-save-item" data-save-id="' + compEscAttr(s.id) + '">';
        html += '<div class="app-save-item-header">';
        html += '<span class="app-save-item-name">' + compEscHtml(s.name || s.id) + '</span>';
        html += '<span class="app-save-item-date">' + compEscHtml(dateStr) + '</span>';
        html += '</div>';
        if (s.description) {
          html += '<div class="app-save-item-desc">' + compEscHtml(s.description) + '</div>';
        }
        html += '<div class="app-save-item-meta">';
        html += '<span>' + s.nodeCount + ' nodes</span>';
        html += '<span>' + sizeStr + '</span>';
        html += '</div>';
        html += '<div class="app-save-item-actions">';
        html += '<button class="app-save-item-load" data-save-id="' + compEscAttr(s.id) + '">Load</button>';
        html += '<button class="app-save-item-delete" data-save-id="' + compEscAttr(s.id) + '">Delete</button>';
        html += '</div>';
        html += '</div>';
      }
    }

    html += '<div class="app-save-status" id="app-load-status"></div>';
    html += '</div>';
    panel.innerHTML = html;

    // Wire load buttons
    panel.querySelectorAll('.app-save-item-load').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var saveId = btn.getAttribute('data-save-id');
        if (!confirm('Load this save? Your current state will be replaced.')) return;
        btn.disabled = true;
        btn.textContent = 'Loading...';
        fetch('/api/app/' + encodeURIComponent(compData.id) + '/saves/' + encodeURIComponent(saveId) + '/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          if (!res.ok) {
            toast('Load failed: ' + (res.data.error || 'Unknown error'), 'error');
            btn.disabled = false;
            btn.textContent = 'Load';
            return;
          }
          toast('State loaded successfully', 'success');
          // Refresh the whole app view
          renderCompositionAppPage();
        })
        .catch(function(err) {
          toast('Load failed: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Load';
        });
      });
    });

    // Wire delete buttons
    panel.querySelectorAll('.app-save-item-delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var saveId = btn.getAttribute('data-save-id');
        if (!confirm('Delete this save? This cannot be undone.')) return;
        btn.disabled = true;
        btn.textContent = 'Deleting...';
        fetch('/api/app/' + encodeURIComponent(compData.id) + '/saves/' + encodeURIComponent(saveId), {
          method: 'DELETE',
        })
        .then(function(r) { return r.json(); })
        .then(function() {
          toast('Save deleted', 'success');
          showLoadPanel(panel); // Refresh list
        })
        .catch(function(err) {
          toast('Delete failed: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Delete';
        });
      });
    });

    // Wire load from path
    var pathBtn = panel.querySelector('#app-load-from-path');
    if (pathBtn) {
      pathBtn.addEventListener('click', function() {
        openFolderPicker(function(selectedPath) {
          if (!confirm('Load state from this path? Your current state will be replaced.')) return;
          pathBtn.disabled = true;
          pathBtn.textContent = 'Loading...';
          fetch('/api/app/' + encodeURIComponent(compData.id) + '/saves/load-from-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: selectedPath }),
          })
          .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
          .then(function(res) {
            if (!res.ok) {
              toast('Load failed: ' + (res.data.error || 'Unknown error'), 'error');
              pathBtn.disabled = false;
              pathBtn.textContent = '\u{1F4C1} Load from Folder...';
              return;
            }
            toast('State loaded from ' + selectedPath, 'success');
            renderCompositionAppPage();
          })
          .catch(function(err) {
            toast('Load failed: ' + err.message, 'error');
            pathBtn.disabled = false;
            pathBtn.textContent = '\u{1F4C1} Load from Folder...';
          });
        });
      });
    }
  })
  .catch(function(err) {
    panel.innerHTML = '<div class="app-save-empty">Failed to load saves: ' + err.message + '</div>';
  });
}

// ── Folder Picker Modal ──────────────────────────────────────────────

function openFolderPicker(onSelect) {
  // Remove any existing picker
  var existing = document.querySelector('.folder-picker-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.className = 'folder-picker-overlay';
  overlay.innerHTML = '<div class="folder-picker-modal">'
    + '<div class="folder-picker-header">'
    + '<h3>Choose Folder</h3>'
    + '<button class="folder-picker-close">&times;</button>'
    + '</div>'
    + '<div class="folder-picker-path" id="fp-current-path"></div>'
    + '<div class="folder-picker-list" id="fp-list">Loading...</div>'
    + '<div class="folder-picker-footer">'
    + '<button class="folder-picker-cancel-btn" id="fp-cancel">Cancel</button>'
    + '<button class="folder-picker-select-btn" id="fp-select">Select This Folder</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(overlay);

  var currentPath = '';
  var listEl = overlay.querySelector('#fp-list');
  var pathEl = overlay.querySelector('#fp-current-path');

  function browseTo(dir) {
    listEl.innerHTML = '<div style="color:#64748b;padding:12px;font-size:0.7rem;">Loading...</div>';
    fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir || undefined }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      currentPath = data.current || dir;
      pathEl.textContent = currentPath;

      var html = '';
      // Parent directory
      if (data.parent && data.parent !== currentPath) {
        html += '<div class="folder-picker-item folder-picker-parent" data-path="' + compEscAttr(data.parent) + '">'
          + '&#x1F4C1; ..'
          + '</div>';
      }
      var dirs = data.dirs || [];
      if (dirs.length === 0 && !data.parent) {
        html += '<div style="color:#475569;padding:8px;font-size:0.65rem;font-style:italic;">No subdirectories</div>';
      }
      for (var i = 0; i < dirs.length; i++) {
        html += '<div class="folder-picker-item" data-path="' + compEscAttr(dirs[i].path) + '">'
          + '&#x1F4C1; ' + compEscHtml(dirs[i].name)
          + '</div>';
      }
      listEl.innerHTML = html;

      // Wire clicks to navigate
      listEl.querySelectorAll('.folder-picker-item').forEach(function(item) {
        item.addEventListener('click', function() {
          browseTo(item.getAttribute('data-path'));
        });
      });
    })
    .catch(function(err) {
      listEl.innerHTML = '<div style="color:#f87171;padding:8px;font-size:0.65rem;">Error: ' + err.message + '</div>';
    });
  }

  // Start at home directory
  browseTo('');

  // Close handlers
  overlay.querySelector('.folder-picker-close').addEventListener('click', function() { overlay.remove(); });
  overlay.querySelector('#fp-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  // Select handler
  overlay.querySelector('#fp-select').addEventListener('click', function() {
    if (currentPath) {
      overlay.remove();
      onSelect(currentPath);
    }
  });
}

// ── Git status section for app sidebar ──────────────────────────────
function loadAppGitStatus(compId, container) {
  fetch('/api/compositions/' + encodeURIComponent(compId) + '/git-status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.isRepo) {
        // Not a git repo — just show the GitHub Desktop button which will init
        container.innerHTML =
          '<button class="app-action-btn app-action-secondary app-action-github" id="app-open-github-desktop">' +
          '&#x1F4BB; Open in GitHub Desktop</button>';
        wireGitHubDesktopBtn(compId, container);
        return;
      }

      var html = '';

      // Status indicator
      var statusColor = data.dirty ? '#f59e0b' : '#10b981';
      var statusIcon = data.dirty ? '●' : '✓';
      var statusText = data.dirty ? 'Uncommitted changes' : 'Clean';
      html += '<div class="app-git-status-line">';
      html += '<span style="color:' + statusColor + ';">' + statusIcon + ' ' + statusText + '</span>';
      html += '<span class="app-git-branch">on ' + compEscHtml(data.branch || 'main') + '</span>';
      html += '</div>';

      // If dirty — show smart commit button
      if (data.dirty) {
        html += '<button class="app-action-btn app-action-commit" id="app-smart-commit">&#x1F4DD; Commit &amp; Push</button>';
      }

      // GitHub Desktop button
      html += '<button class="app-action-btn app-action-secondary app-action-github" id="app-open-github-desktop">&#x1F4BB; Open in GitHub Desktop</button>';

      // Recent commits
      if (data.recentCommits && data.recentCommits.length > 0) {
        html += '<div class="app-git-commits">';
        data.recentCommits.slice(0, 3).forEach(function(c) {
          html += '<div class="app-git-commit-line">' + compEscHtml(c) + '</div>';
        });
        html += '</div>';
      }

      container.innerHTML = html;

      // Wire smart commit
      var commitBtn = container.querySelector('#app-smart-commit');
      if (commitBtn) {
        commitBtn.addEventListener('click', async function() {
          commitBtn.disabled = true;
          commitBtn.innerHTML = '&#x1F916; Generating message...';
          try {
            var res = await fetch('/api/compositions/' + encodeURIComponent(compId) + '/git-smart-commit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            var result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Commit failed');
            if (!result.committed) {
              toast(result.message || 'Nothing to commit', 'info');
              commitBtn.disabled = false;
              commitBtn.innerHTML = '&#x1F4DD; Commit &amp; Push';
              return;
            }
            var msg = result.pushed ? 'Committed & pushed!' : 'Committed!';
            if (result.pushError) msg += ' (push failed: ' + result.pushError + ')';
            toast(msg, result.pushError ? 'warning' : 'success');

            // Show the commit message briefly
            commitBtn.innerHTML = '&#x2705; ' + compEscHtml(result.message.split('\n')[0]);
            commitBtn.style.fontSize = '0.68rem';
            setTimeout(function() {
              loadAppGitStatus(compId, container);
            }, 2500);
          } catch (err) {
            toast('Commit failed: ' + (err.message || err), 'error');
            commitBtn.disabled = false;
            commitBtn.innerHTML = '&#x1F4DD; Commit &amp; Push';
          }
        });
      }

      wireGitHubDesktopBtn(compId, container);
    })
    .catch(function() {
      container.innerHTML =
        '<button class="app-action-btn app-action-secondary app-action-github" id="app-open-github-desktop">' +
        '&#x1F4BB; Open in GitHub Desktop</button>';
      wireGitHubDesktopBtn(compId, container);
    });
}

function wireGitHubDesktopBtn(compId, container) {
  var ghBtn = container.querySelector('#app-open-github-desktop');
  if (ghBtn) {
    ghBtn.addEventListener('click', async function() {
      ghBtn.disabled = true;
      ghBtn.textContent = 'Opening...';
      try {
        var res = await fetch('/api/compositions/' + encodeURIComponent(compId) + '/open-github-desktop', { method: 'POST' });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to open');
        toast('Opened in GitHub Desktop', 'success');
      } catch (err) {
        toast('Could not open: ' + (err.message || err), 'error');
      }
      ghBtn.disabled = false;
      ghBtn.innerHTML = '&#x1F4BB; Open in GitHub Desktop';
    });
  }
}

// Make the render function globally available
if (typeof window !== 'undefined') {
  window.renderCompositionAppPage = renderCompositionAppPage;
}
