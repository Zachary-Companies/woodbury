/**
 * Run History Dashboard — Client-side JavaScript
 *
 * Lists past workflow/pipeline runs with filtering and detail views.
 */

// ── State ────────────────────────────────────────────────────
var runs = [];
var selectedRunId = null;
var runsFilter = { status: null, type: null };

// ── Utilities ────────────────────────────────────────────────

function runsEscHtml(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function runsEscAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return ms + 'ms';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + 'm ' + s + 's';
}

function formatTimestamp(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var now = new Date();
  var diffMs = now - d;
  if (diffMs < 60000) return 'Just now';
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
  if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function runStatusIcon(status) {
  switch (status) {
    case 'completed': return '<span style="color:#10b981;">&#x2713;</span>';
    case 'failed': return '<span style="color:#ef4444;">&#x2717;</span>';
    case 'cancelled': return '<span style="color:#f59e0b;">&#x25CB;</span>';
    case 'running': return '<span style="color:#3b82f6;">&#x25CF;</span>';
    default: return '&#x2014;';
  }
}

// ── API ──────────────────────────────────────────────────────

async function fetchRuns() {
  try {
    var params = new URLSearchParams();
    params.set('limit', '200');
    if (runsFilter.status) params.set('status', runsFilter.status);
    if (runsFilter.type) params.set('type', runsFilter.type);

    var res = await fetch('/api/runs?' + params.toString());
    var data = await res.json();
    runs = data.runs || [];
    renderRunsSidebar();
  } catch (err) {
    document.querySelector('#runs-list').innerHTML =
      '<div style="padding:1rem;color:#ef4444;font-size:0.8rem;">Failed to load runs.</div>';
  }
}

async function fetchRunDetail(id) {
  var res = await fetch('/api/runs/' + encodeURIComponent(id));
  if (!res.ok) throw new Error('Run not found');
  return res.json();
}

async function deleteRun(id) {
  var res = await fetch('/api/runs/' + encodeURIComponent(id), { method: 'DELETE' });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Delete failed');
  return data;
}

async function clearAllRuns() {
  var res = await fetch('/api/runs', { method: 'DELETE' });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Clear failed');
  return data;
}

// ── Init ─────────────────────────────────────────────────────

function initRuns() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div class="empty-state">' +
    '<div class="empty-state-icon">&#x1f4cb;</div>' +
    '<h2>Run History ' + helpIcon('runs-what') + '</h2>' +
    '<p>Every workflow and pipeline execution is recorded here.<br>Select a run from the sidebar to view its details.</p>' +
    '</div>';

  selectedRunId = null;
  fetchRuns();
}

// ── Sidebar Rendering ────────────────────────────────────────

function renderRunsSidebar() {
  var list = document.querySelector('#runs-list');

  // Filter bars
  var html = '<div class="runs-filter-bar" style="align-items:center;">';
  html += helpIcon('runs-statuses');
  html += '<button class="runs-filter-btn' + (!runsFilter.status ? ' active' : '') + '" data-filter-status="">All</button>';
  html += '<button class="runs-filter-btn' + (runsFilter.status === 'completed' ? ' active' : '') + '" data-filter-status="completed">Passed</button>';
  html += '<button class="runs-filter-btn' + (runsFilter.status === 'failed' ? ' active' : '') + '" data-filter-status="failed">Failed</button>';
  html += '<button class="runs-filter-btn' + (runsFilter.status === 'cancelled' ? ' active' : '') + '" data-filter-status="cancelled">Cancelled</button>';
  html += '</div>';

  html += '<div class="runs-filter-bar">';
  html += '<button class="runs-filter-btn' + (!runsFilter.type ? ' active' : '') + '" data-filter-type="">All Types</button>';
  html += '<button class="runs-filter-btn' + (runsFilter.type === 'workflow' ? ' active' : '') + '" data-filter-type="workflow">Workflows</button>';
  html += '<button class="runs-filter-btn' + (runsFilter.type === 'pipeline' ? ' active' : '') + '" data-filter-type="pipeline">Pipelines</button>';
  html += '<span style="flex:1;"></span>';
  if (runs.length > 0) {
    html += '<button class="runs-clear-btn" id="runs-clear-all">Clear All</button>';
  }
  html += '</div>';

  if (runs.length === 0) {
    html += '<div style="padding:1.5rem;color:#64748b;font-size:0.8rem;text-align:center;">No runs found.</div>';
    list.innerHTML = html;
    wireRunsFilterEvents(list);
    return;
  }

  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var active = selectedRunId === r.id ? ' active' : '';
    var typeLabel = r.type === 'pipeline' ? 'Pipeline' : 'Workflow';
    html += '<div class="run-item' + active + '" data-run-id="' + runsEscAttr(r.id) + '">';
    html += '<div class="run-item-icon">' + runStatusIcon(r.status) + '</div>';
    html += '<div class="run-item-info">';
    html += '<div class="run-item-name">' + runsEscHtml(r.name) + '</div>';
    html += '<div class="run-item-meta">' + typeLabel + ' &middot; ' + formatTimestamp(r.startedAt) + ' &middot; ' + formatDuration(r.durationMs) + '</div>';
    html += '</div>';
    html += '<span class="run-item-badge run-badge-' + r.status + '">' + r.status + '</span>';
    html += '</div>';
  }

  list.innerHTML = html;
  wireRunsFilterEvents(list);

  list.querySelectorAll('.run-item').forEach(function(el) {
    el.addEventListener('click', function() {
      selectRun(el.dataset.runId);
    });
  });
}

function wireRunsFilterEvents(list) {
  list.querySelectorAll('[data-filter-status]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      runsFilter.status = btn.dataset.filterStatus || null;
      fetchRuns();
    });
  });
  list.querySelectorAll('[data-filter-type]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      runsFilter.type = btn.dataset.filterType || null;
      fetchRuns();
    });
  });
  var clearBtn = list.querySelector('#runs-clear-all');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      if (!confirm('Delete all run history? This cannot be undone.')) return;
      clearAllRuns().then(function() {
        toast('Run history cleared', 'success');
        selectedRunId = null;
        fetchRuns();
        var main = document.querySelector('#main');
        main.innerHTML =
          '<div class="empty-state">' +
          '<div class="empty-state-icon">&#x1f4cb;</div>' +
          '<h2>Run History</h2>' +
          '<p>No runs recorded yet.</p>' +
          '</div>';
      }).catch(function(err) { toast('Failed: ' + err.message, 'error'); });
    });
  }
}

// ── Detail View ──────────────────────────────────────────────

async function selectRun(id) {
  selectedRunId = id;

  document.querySelectorAll('.run-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.runId === id);
  });

  var main = document.querySelector('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  try {
    var data = await fetchRunDetail(id);
    renderRunDetail(data.run);
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div>' +
      '<h2>Error</h2><p>' + runsEscHtml(err.message) + '</p></div>';
  }
}

function renderRunDetail(run) {
  var main = document.querySelector('#main');
  var html = '';

  // Header
  html += '<div class="run-detail-header">';
  html += '<h2>' + runStatusIcon(run.status) + ' ' + runsEscHtml(run.name) + '</h2>';
  html += '<div class="run-detail-meta">';
  html += '<span>' + (run.type === 'pipeline' ? 'Pipeline' : 'Workflow') + '</span>';
  html += '<span>' + runsEscHtml(run.startedAt ? new Date(run.startedAt).toLocaleString() : '') + '</span>';
  html += '<span>Duration: ' + formatDuration(run.durationMs) + '</span>';
  html += '<span class="run-item-badge run-badge-' + run.status + '" style="font-size:0.7rem;">' + run.status.toUpperCase() + '</span>';
  html += '</div>';
  html += '</div>';

  // Error message
  if (run.error) {
    html += '<div style="background:#ef444422;border:1px solid #ef444444;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.8rem;color:#fca5a5;">';
    html += runsEscHtml(run.error);
    html += '</div>';
  }

  // Pipeline node results
  if (run.type === 'pipeline' && run.nodeResults && run.nodeResults.length > 0) {
    html += '<div class="run-detail-section">';
    html += '<div class="run-detail-section-header">Pipeline Nodes (' + (run.nodesCompleted || 0) + '/' + (run.nodesTotal || 0) + ' completed)</div>';
    html += '<div class="run-detail-section-body">';
    for (var i = 0; i < run.nodeResults.length; i++) {
      var nr = run.nodeResults[i];
      html += '<div class="run-node-row">';
      html += '<div class="run-node-icon">' + runStatusIcon(nr.status) + '</div>';
      html += '<div class="run-node-name">' + runsEscHtml(nr.workflowName);
      if (nr.retryAttempts) {
        html += ' <span style="font-size:0.65rem;color:#f59e0b;">(' + nr.retryAttempts + ' retries)</span>';
      }
      html += '</div>';
      html += '<div class="run-node-duration">' + formatDuration(nr.durationMs) + '</div>';
      html += '<span class="run-node-status run-badge-' + nr.status + '">' + nr.status + '</span>';
      html += '</div>';

      if (nr.error) {
        html += '<div style="padding:0.25rem 0 0.5rem 2rem;font-size:0.75rem;color:#fca5a5;">' + runsEscHtml(nr.error) + '</div>';
      }

      if (nr.expectationResults && nr.expectationResults.length > 0) {
        for (var j = 0; j < nr.expectationResults.length; j++) {
          var exp = nr.expectationResults[j];
          html += '<div class="run-exp-row" style="padding-left:2rem;">';
          html += '<div class="run-exp-icon">' + (exp.passed ? '<span style="color:#10b981;">&#x2713;</span>' : '<span style="color:#ef4444;">&#x2717;</span>') + '</div>';
          html += '<div class="run-exp-text">' + runsEscHtml(exp.detail || exp.description) + '</div>';
          html += '</div>';
        }
      }
    }
    html += '</div></div>';
  }

  // Workflow step results
  if (run.type === 'workflow' && run.stepResults && run.stepResults.length > 0) {
    html += '<div class="run-detail-section">';
    html += '<div class="run-detail-section-header">Steps (' + (run.stepsCompleted || 0) + '/' + (run.stepsTotal || 0) + ' completed)</div>';
    html += '<div class="run-detail-section-body">';
    for (var k = 0; k < run.stepResults.length; k++) {
      var sr = run.stepResults[k];
      var stepIcon = sr.status === 'success' || sr.status === 'completed'
        ? '<span style="color:#10b981;">&#x2713;</span>'
        : sr.status === 'failed'
        ? '<span style="color:#ef4444;">&#x2717;</span>'
        : '<span style="color:#64748b;">&#x2014;</span>';
      html += '<div class="run-node-row">';
      html += '<div style="color:#64748b;font-family:monospace;font-size:0.7rem;width:1.5rem;text-align:right;">' + (sr.index + 1) + '</div>';
      html += '<div class="run-node-icon">' + stepIcon + '</div>';
      html += '<div class="run-node-name">' + runsEscHtml(sr.label) + '</div>';
      html += '</div>';
      if (sr.error) {
        html += '<div style="padding:0.15rem 0 0.3rem 3rem;font-size:0.7rem;color:#fca5a5;">' + runsEscHtml(sr.error) + '</div>';
      }
    }
    html += '</div></div>';
  }

  // Output files
  if (run.outputFiles && run.outputFiles.length > 0) {
    html += '<div class="run-detail-section">';
    html += '<div class="run-detail-section-header">Output Files (' + run.outputFiles.length + ')</div>';
    html += '<div class="run-detail-section-body">';
    for (var f = 0; f < run.outputFiles.length; f++) {
      html += '<div class="run-file-item">' + runsEscHtml(run.outputFiles[f]) + '</div>';
    }
    html += '</div></div>';
  }

  // Input variables
  if (run.variables && Object.keys(run.variables).length > 0) {
    var vars = Object.entries(run.variables);
    html += '<div class="run-detail-section">';
    html += '<div class="run-detail-section-header">Input Variables (' + vars.length + ')</div>';
    html += '<div class="run-detail-section-body">';
    for (var v = 0; v < vars.length; v++) {
      var val = vars[v][1];
      var displayVal = typeof val === 'string' ? val : JSON.stringify(val);
      if (displayVal && displayVal.length > 200) displayVal = displayVal.slice(0, 200) + '...';
      html += '<div style="display:flex;gap:0.5rem;padding:0.3rem 0;font-size:0.78rem;">';
      html += '<span style="color:#06b6d4;font-family:monospace;font-weight:600;min-width:120px;">' + runsEscHtml(vars[v][0]) + '</span>';
      html += '<span style="color:#94a3b8;flex:1;word-break:break-all;">' + runsEscHtml(displayVal) + '</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  // Delete button
  html += '<button class="run-delete-btn" id="run-delete-btn">Delete This Run</button>';

  main.innerHTML = html;

  var delBtn = document.querySelector('#run-delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', function() {
      if (!confirm('Delete this run record?')) return;
      deleteRun(run.id).then(function() {
        toast('Run deleted', 'success');
        selectedRunId = null;
        fetchRuns();
        main.innerHTML =
          '<div class="empty-state">' +
          '<div class="empty-state-icon">&#x1f4cb;</div>' +
          '<h2>Run History</h2>' +
          '<p>Select a run from the sidebar to view its details.</p>' +
          '</div>';
      }).catch(function(err) { toast('Failed: ' + err.message, 'error'); });
    });
  }
}

// Make globally available
window.initRuns = initRuns;
