// ── Schedules Dashboard ──────────────────────────────────────
// Displays all pipeline schedules with enable/disable, edit, delete, and run-now.

(function () {
  'use strict';

  var schedules = [];
  var selectedScheduleId = null;

  // ── Utilities ─────────────────────────────────────────────

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cronToHuman(cron) {
    if (!cron) return '';
    var parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    var m = parts[0], h = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
    if (m === '*' && h === '*') return 'Every minute';
    if (m.startsWith('*/')) return 'Every ' + m.slice(2) + ' minutes';
    if (h === '*' && !m.startsWith('*/')) return 'Every hour at :' + m.padStart(2, '0');
    if (m !== '*' && h !== '*' && dom === '*' && mon === '*') {
      var time = h + ':' + m.padStart(2, '0');
      if (dow === '*') return 'Daily at ' + time;
      var dayMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '1-5': 'Weekdays', '0,6': 'Weekends' };
      return (dayMap[dow] || 'Day ' + dow) + ' at ' + time;
    }
    return cron;
  }

  function timeAgo(isoStr) {
    if (!isoStr) return 'Never';
    var diff = Date.now() - new Date(isoStr).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // ── API ───────────────────────────────────────────────────

  async function fetchSchedules() {
    var res = await fetch('/api/schedules');
    if (!res.ok) throw new Error('Failed to load schedules');
    var data = await res.json();
    schedules = data.schedules || [];
  }

  async function fetchRunsForComposition(compositionId) {
    var res = await fetch('/api/runs');
    if (!res.ok) return [];
    var data = await res.json();
    var allRuns = data.runs || [];
    return allRuns.filter(function (r) { return r.sourceId === compositionId; }).reverse();
  }

  async function updateSchedule(id, updates) {
    var res = await fetch('/api/schedules/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    return data;
  }

  async function deleteSchedule(id) {
    var res = await fetch('/api/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    return data;
  }

  async function runNow(compositionId, variables) {
    var res = await fetch('/api/compositions/' + encodeURIComponent(compositionId) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: variables || {} }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');
    return data;
  }

  // ── Sidebar ───────────────────────────────────────────────

  function renderSidebar() {
    var container = document.getElementById('schedules-items');
    if (!container) return;

    if (!schedules.length) {
      container.innerHTML = '<div style="padding:1rem;color:#64748b;font-size:0.8rem;">No schedules configured.<br><br>Create one from a pipeline\'s schedule button.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      var active = s.id === selectedScheduleId ? ' active' : '';
      var statusColor = s.enabled ? '#10b981' : '#64748b';
      var statusDot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + statusColor + ';margin-right:6px;flex-shrink:0;"></span>';
      html += '<div class="sched-item' + active + '" data-id="' + escAttr(s.id) + '" style="padding:0.6rem 0.75rem;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);' + (active ? 'background:#1e293b;' : '') + '">';
      html += '<div style="display:flex;align-items:center;gap:4px;">' + statusDot;
      html += '<span style="font-size:0.82rem;color:#e2e8f0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(s.compositionName || s.compositionId) + '</span>';
      html += '</div>';
      html += '<div style="font-size:0.7rem;color:#64748b;margin-top:2px;padding-left:14px;">' + escHtml(cronToHuman(s.cron)) + '</div>';
      if (s.lastRunAt) {
        html += '<div style="font-size:0.65rem;color:#475569;margin-top:1px;padding-left:14px;">Last: ' + escHtml(timeAgo(s.lastRunAt)) + '</div>';
      }
      html += '</div>';
    }
    container.innerHTML = html;

    // Wire clicks
    container.querySelectorAll('.sched-item').forEach(function (el) {
      el.addEventListener('click', function () {
        selectedScheduleId = el.dataset.id;
        renderSidebar();
        renderDetail();
      });
    });
  }

  // ── Detail View ───────────────────────────────────────────

  function renderDetail() {
    var main = document.getElementById('main');
    if (!main) return;

    if (!schedules.length) {
      main.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;">' +
        '<div style="font-size:2.5rem;margin-bottom:1rem;">&#128339;</div>' +
        '<h2 style="color:#e2e8f0;margin:0 0 0.5rem;">Schedules</h2>' +
        '<p style="max-width:400px;text-align:center;">No schedules yet. Open a pipeline and click the schedule button to create one.</p>' +
        '</div>';
      return;
    }

    var s = null;
    for (var i = 0; i < schedules.length; i++) {
      if (schedules[i].id === selectedScheduleId) { s = schedules[i]; break; }
    }
    if (!s) {
      selectedScheduleId = schedules[0].id;
      s = schedules[0];
      renderSidebar();
    }

    var html = '';
    html += '<div style="padding:1.5rem;max-width:700px;">';

    // Header
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;">';
    html += '<h2 style="margin:0;color:#e2e8f0;font-size:1.2rem;">' + escHtml(s.compositionName || s.compositionId) + '</h2>';
    html += '<div style="display:flex;gap:0.5rem;">';
    html += '<button id="sched-run-btn" style="padding:0.4rem 0.8rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;">&#9654; Run Now</button>';
    html += '<button id="sched-delete-btn" style="padding:0.4rem 0.8rem;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;">&#128465; Delete</button>';
    html += '</div>';
    html += '</div>';

    // Enable/Disable toggle
    html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.25rem;padding:0.75rem 1rem;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.08);">';
    html += '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.85rem;color:#e2e8f0;">';
    html += '<input type="checkbox" id="sched-enabled" ' + (s.enabled ? 'checked' : '') + ' style="width:18px;height:18px;accent-color:#10b981;">';
    html += '<span>' + (s.enabled ? 'Enabled' : 'Paused') + '</span>';
    html += '</label>';
    html += '<span style="margin-left:auto;font-size:0.75rem;color:' + (s.enabled ? '#10b981' : '#f59e0b') + ';font-weight:500;">' + (s.enabled ? 'Active' : 'Paused') + '</span>';
    html += '</div>';

    // Form fields
    html += '<div style="display:flex;flex-direction:column;gap:1rem;">';

    // Cron
    html += '<div>';
    html += '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Cron Expression</label>';
    html += '<input id="sched-cron" type="text" value="' + escAttr(s.cron) + '" style="width:100%;padding:0.5rem 0.75rem;background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#e2e8f0;font-family:monospace;font-size:0.85rem;">';
    html += '<div id="sched-cron-preview" style="font-size:0.7rem;color:#60a5fa;margin-top:4px;">' + escHtml(cronToHuman(s.cron)) + '</div>';
    html += '</div>';

    // Description
    html += '<div>';
    html += '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Description</label>';
    html += '<input id="sched-desc" type="text" value="' + escAttr(s.description || '') + '" placeholder="Optional description" style="width:100%;padding:0.5rem 0.75rem;background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#e2e8f0;font-size:0.85rem;">';
    html += '</div>';

    // Variables
    html += '<div>';
    html += '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Variables (JSON)</label>';
    html += '<textarea id="sched-vars" rows="3" placeholder=\'{"key": "value"}\' style="width:100%;padding:0.5rem 0.75rem;background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#e2e8f0;font-family:monospace;font-size:0.8rem;resize:vertical;">' + escHtml(JSON.stringify(s.variables || {}, null, 2)) + '</textarea>';
    html += '</div>';

    // Save button
    html += '<button id="sched-save-btn" style="align-self:flex-start;padding:0.5rem 1.5rem;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:500;">Save Changes</button>';

    html += '</div>'; // end form

    // Info section
    html += '<div style="margin-top:1.5rem;padding:1rem;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">';
    html += '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.5rem;">Info</div>';
    html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:0.25rem 1rem;font-size:0.8rem;">';
    html += '<span style="color:#64748b;">Pipeline ID</span><span style="color:#e2e8f0;font-family:monospace;font-size:0.75rem;">' + escHtml(s.compositionId) + '</span>';
    html += '<span style="color:#64748b;">Schedule ID</span><span style="color:#e2e8f0;font-family:monospace;font-size:0.75rem;">' + escHtml(s.id) + '</span>';
    html += '<span style="color:#64748b;">Created</span><span style="color:#e2e8f0;">' + escHtml(s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Unknown') + '</span>';
    html += '<span style="color:#64748b;">Last Run</span><span style="color:#e2e8f0;">' + escHtml(s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() + ' (' + timeAgo(s.lastRunAt) + ')' : 'Never') + '</span>';
    if (s.lastRunId) {
      html += '<span style="color:#64748b;">Last Run ID</span><span style="color:#e2e8f0;font-family:monospace;font-size:0.75rem;">' + escHtml(s.lastRunId) + '</span>';
    }
    if (s.lastError) {
      html += '<span style="color:#f87171;">Last Error</span><span style="color:#f87171;font-size:0.75rem;">' + escHtml(s.lastError) + '</span>';
    }
    html += '</div>';
    html += '</div>';

    // Run log (live updates when a run is in progress)
    html += '<div id="sched-run-log" style="margin-top:1.5rem;padding:1rem;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);display:none;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">';
    html += '<div style="font-size:0.75rem;color:#94a3b8;">Run Log</div>';
    html += '<span id="sched-run-status-badge" style="font-size:0.7rem;padding:2px 8px;border-radius:4px;"></span>';
    html += '</div>';
    html += '<div id="sched-run-log-entries" style="font-family:monospace;font-size:0.72rem;color:#94a3b8;max-height:300px;overflow-y:auto;"></div>';
    html += '</div>';

    // Stats + Run History (loaded async)
    html += '<div id="sched-stats" style="margin-top:1.5rem;"></div>';
    html += '<div id="sched-history" style="margin-top:1rem;"></div>';

    html += '</div>'; // end padding wrapper
    main.innerHTML = html;

    // Wire events
    wireDetailEvents(s);

    // Load run history async
    loadRunHistory(s);
  }

  function wireDetailEvents(s) {
    // Enable/disable toggle
    var enabledCb = document.getElementById('sched-enabled');
    if (enabledCb) {
      enabledCb.addEventListener('change', async function () {
        try {
          await updateSchedule(s.id, { enabled: enabledCb.checked });
          s.enabled = enabledCb.checked;
          if (typeof toast === 'function') toast(enabledCb.checked ? 'Schedule enabled' : 'Schedule paused', 'success');
          renderSidebar();
          renderDetail();
        } catch (err) {
          if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
        }
      });
    }

    // Cron preview
    var cronInput = document.getElementById('sched-cron');
    var cronPreview = document.getElementById('sched-cron-preview');
    if (cronInput && cronPreview) {
      cronInput.addEventListener('input', function () {
        cronPreview.textContent = cronToHuman(cronInput.value);
      });
    }

    // Save
    var saveBtn = document.getElementById('sched-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var cron = (document.getElementById('sched-cron') || {}).value || '';
        var desc = (document.getElementById('sched-desc') || {}).value || '';
        var varsText = (document.getElementById('sched-vars') || {}).value || '';
        var variables = {};
        if (varsText.trim()) {
          try { variables = JSON.parse(varsText); } catch (e) {
            if (typeof toast === 'function') toast('Invalid JSON in variables', 'error');
            return;
          }
        }
        try {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          await updateSchedule(s.id, { cron: cron, description: desc, variables: variables });
          s.cron = cron;
          s.description = desc;
          s.variables = variables;
          if (typeof toast === 'function') toast('Schedule updated', 'success');
          renderSidebar();
          renderDetail();
        } catch (err) {
          if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      });
    }

    // Delete
    var deleteBtn = document.getElementById('sched-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async function () {
        if (!confirm('Delete this schedule? This cannot be undone.')) return;
        try {
          await deleteSchedule(s.id);
          schedules = schedules.filter(function (x) { return x.id !== s.id; });
          selectedScheduleId = schedules.length ? schedules[0].id : null;
          if (typeof toast === 'function') toast('Schedule deleted', 'success');
          renderSidebar();
          renderDetail();
        } catch (err) {
          if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
        }
      });
    }

    // Run Now
    var runBtn = document.getElementById('sched-run-btn');
    if (runBtn) {
      runBtn.addEventListener('click', async function () {
        console.log('[Schedules] Run Now clicked for', s.compositionId);
        try {
          runBtn.disabled = true;
          runBtn.textContent = 'Starting...';
          var result = await runNow(s.compositionId, s.variables);
          console.log('[Schedules] Run started:', result);
          toast('Pipeline started: ' + (result.runId || ''), 'success');
          runBtn.textContent = '\u2705 Started';
          // Start polling for status
          pollRunStatus(s);
          setTimeout(function () { runBtn.disabled = false; runBtn.innerHTML = '&#9654; Run Now'; }, 3000);
        } catch (err) {
          console.error('[Schedules] Run failed:', err);
          toast('Failed: ' + err.message, 'error');
          runBtn.disabled = false;
          runBtn.innerHTML = '&#9654; Run Now';
        }
      });
    }
  }

  // ── Run History + Stats ────────────────────────────────────

  async function loadRunHistory(schedule) {
    var statsEl = document.getElementById('sched-stats');
    var historyEl = document.getElementById('sched-history');
    if (!statsEl || !historyEl) return;

    try {
      var runs = await fetchRunsForComposition(schedule.compositionId);

      // ── Stats summary ──
      var total = runs.length;
      var completed = runs.filter(function (r) { return r.status === 'completed'; }).length;
      var failed = runs.filter(function (r) { return r.status === 'failed'; }).length;
      var running = runs.filter(function (r) { return r.status === 'running'; }).length;
      var successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

      // Duration stats (only completed runs)
      var durations = runs.filter(function (r) { return r.status === 'completed' && r.durationMs > 0; }).map(function (r) { return r.durationMs; });
      var avgDuration = durations.length > 0 ? Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length) : 0;
      var minDuration = durations.length > 0 ? Math.min.apply(null, durations) : 0;
      var maxDuration = durations.length > 0 ? Math.max.apply(null, durations) : 0;

      // Last 24h / 7d counts
      var now = Date.now();
      var runs24h = runs.filter(function (r) { return r.startedAt && (now - new Date(r.startedAt).getTime()) < 86400000; }).length;
      var runs7d = runs.filter(function (r) { return r.startedAt && (now - new Date(r.startedAt).getTime()) < 604800000; }).length;

      function fmtDuration(ms) {
        if (ms === 0) return '-';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return (ms / 60000).toFixed(1) + 'm';
      }

      var statsHtml = '';
      statsHtml += '<div style="padding:1rem;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">';
      statsHtml += '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.75rem;">Stats</div>';
      statsHtml += '<div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:0.75rem;">';

      // Cards
      statsHtml += '<div style="text-align:center;">';
      statsHtml += '<div style="font-size:1.5rem;font-weight:700;color:#e2e8f0;">' + total + '</div>';
      statsHtml += '<div style="font-size:0.7rem;color:#64748b;">Total Runs</div>';
      statsHtml += '</div>';

      statsHtml += '<div style="text-align:center;">';
      statsHtml += '<div style="font-size:1.5rem;font-weight:700;color:#10b981;">' + successRate + '%</div>';
      statsHtml += '<div style="font-size:0.7rem;color:#64748b;">Success Rate</div>';
      statsHtml += '</div>';

      statsHtml += '<div style="text-align:center;">';
      statsHtml += '<div style="font-size:1.5rem;font-weight:700;color:#60a5fa;">' + fmtDuration(avgDuration) + '</div>';
      statsHtml += '<div style="font-size:0.7rem;color:#64748b;">Avg Duration</div>';
      statsHtml += '</div>';

      statsHtml += '<div style="text-align:center;">';
      statsHtml += '<div style="font-size:1.5rem;font-weight:700;color:#e2e8f0;">' + runs24h + '</div>';
      statsHtml += '<div style="font-size:0.7rem;color:#64748b;">Last 24h</div>';
      statsHtml += '</div>';

      statsHtml += '</div>'; // end grid

      // Secondary stats row
      statsHtml += '<div style="display:flex;gap:1.5rem;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid rgba(255,255,255,0.06);font-size:0.75rem;color:#64748b;">';
      statsHtml += '<span>' + completed + ' completed</span>';
      statsHtml += '<span style="color:#f87171;">' + failed + ' failed</span>';
      if (running > 0) statsHtml += '<span style="color:#60a5fa;">' + running + ' running</span>';
      statsHtml += '<span>Last 7d: ' + runs7d + '</span>';
      statsHtml += '<span>Min: ' + fmtDuration(minDuration) + '</span>';
      statsHtml += '<span>Max: ' + fmtDuration(maxDuration) + '</span>';
      statsHtml += '</div>';

      statsHtml += '</div>';
      statsEl.innerHTML = statsHtml;

      // ── Run history table ──
      var histHtml = '';
      histHtml += '<div style="padding:1rem;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">';
      histHtml += '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.75rem;">Run History</div>';

      if (runs.length === 0) {
        histHtml += '<div style="color:#64748b;font-size:0.8rem;">No runs yet.</div>';
      } else {
        histHtml += '<div style="overflow-x:auto;">';
        histHtml += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
        histHtml += '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1);">';
        histHtml += '<th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:500;">Status</th>';
        histHtml += '<th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:500;">Started</th>';
        histHtml += '<th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:500;">Duration</th>';
        histHtml += '<th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:500;">Nodes</th>';
        histHtml += '<th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:500;">Run ID</th>';
        histHtml += '</tr></thead><tbody>';

        // Show last 50 runs
        var displayRuns = runs.slice(0, 50);
        for (var i = 0; i < displayRuns.length; i++) {
          var r = displayRuns[i];
          var statusIcon = r.status === 'completed' ? '<span style="color:#10b981;">\u2705</span>'
            : r.status === 'failed' ? '<span style="color:#f87171;">\u274C</span>'
            : r.status === 'running' ? '<span style="color:#60a5fa;">\u25B6</span>'
            : '<span style="color:#64748b;">\u23F3</span>';
          var statusText = r.status === 'completed' ? 'Success' : r.status === 'failed' ? 'Failed' : r.status === 'running' ? 'Running' : r.status;
          var statusColor = r.status === 'completed' ? '#10b981' : r.status === 'failed' ? '#f87171' : r.status === 'running' ? '#60a5fa' : '#64748b';
          var startedStr = r.startedAt ? new Date(r.startedAt).toLocaleString() : '-';
          var durationStr = r.durationMs > 0 ? fmtDuration(r.durationMs) : (r.status === 'running' ? '...' : '-');
          var nodesStr = (r.nodesCompleted || 0) + '/' + (r.nodesTotal || 0);

          var rowBg = i % 2 === 0 ? '' : 'background:rgba(255,255,255,0.02);';
          histHtml += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);' + rowBg + '">';
          histHtml += '<td style="padding:6px 8px;white-space:nowrap;">' + statusIcon + ' <span style="color:' + statusColor + ';">' + statusText + '</span></td>';
          histHtml += '<td style="padding:6px 8px;color:#94a3b8;white-space:nowrap;">' + escHtml(startedStr) + '</td>';
          histHtml += '<td style="padding:6px 8px;color:#e2e8f0;text-align:right;font-family:monospace;">' + escHtml(durationStr) + '</td>';
          histHtml += '<td style="padding:6px 8px;color:#94a3b8;text-align:right;">' + escHtml(nodesStr) + '</td>';
          histHtml += '<td style="padding:6px 8px;color:#475569;font-family:monospace;font-size:0.68rem;">' + escHtml(r.id || '') + '</td>';
          histHtml += '</tr>';
        }

        histHtml += '</tbody></table>';
        histHtml += '</div>';

        if (runs.length > 50) {
          histHtml += '<div style="font-size:0.7rem;color:#475569;margin-top:0.5rem;">Showing 50 of ' + runs.length + ' runs</div>';
        }
      }

      histHtml += '</div>';
      historyEl.innerHTML = histHtml;

    } catch (err) {
      console.error('[Schedules] Failed to load run history:', err);
      statsEl.innerHTML = '';
      historyEl.innerHTML = '<div style="color:#f87171;font-size:0.8rem;">Failed to load run history: ' + escHtml(err.message) + '</div>';
    }
  }

  // ── Run Status Polling ─────────────────────────────────────

  var _pollTimer = null;

  function pollRunStatus(schedule) {
    var logContainer = document.getElementById('sched-run-log');
    var logEntries = document.getElementById('sched-run-log-entries');
    var statusBadge = document.getElementById('sched-run-status-badge');
    if (!logContainer || !logEntries) return;

    logContainer.style.display = '';
    logEntries.innerHTML = '<span style="color:#60a5fa;">Starting pipeline...</span>';
    if (statusBadge) {
      statusBadge.textContent = 'RUNNING';
      statusBadge.style.background = '#1e3a5f';
      statusBadge.style.color = '#60a5fa';
    }

    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(async function () {
      try {
        var res = await fetch('/api/compositions/run/status');
        var data = await res.json();

        // Build log entries from node states
        var html = '';
        var order = data.executionOrder || [];
        for (var i = 0; i < order.length; i++) {
          var nodeId = order[i];
          var ns = (data.nodeStates || {})[nodeId];
          if (!ns) continue;

          var statusIcon = ns.status === 'completed' ? '<span style="color:#10b981;">\u2705</span>'
            : ns.status === 'failed' ? '<span style="color:#f87171;">\u274C</span>'
            : ns.status === 'running' ? '<span style="color:#60a5fa;">\u25B6</span>'
            : '<span style="color:#64748b;">\u23F3</span>';

          html += '<div style="margin-bottom:6px;">';
          html += statusIcon + ' <strong style="color:#e2e8f0;">' + escHtml(ns.workflowName || nodeId) + '</strong>';
          if (ns.durationMs) html += ' <span style="color:#475569;">(' + (ns.durationMs / 1000).toFixed(1) + 's)</span>';
          if (ns.status === 'failed' && ns.error) {
            html += '<div style="color:#f87171;margin-left:1.2rem;margin-top:2px;word-break:break-all;">' + escHtml(ns.error.slice(0, 200)) + '</div>';
          }
          // Show step logs
          if (ns.logs && ns.logs.length > 0) {
            for (var li = 0; li < ns.logs.length; li++) {
              html += '<div style="color:#475569;margin-left:1.2rem;font-size:0.68rem;">' + escHtml(ns.logs[li]) + '</div>';
            }
          }
          html += '</div>';
        }

        logEntries.innerHTML = html || '<span style="color:#64748b;">Waiting for nodes...</span>';

        // Update status badge
        if (statusBadge) {
          if (data.done && data.success) {
            statusBadge.textContent = 'SUCCESS';
            statusBadge.style.background = '#064e3b';
            statusBadge.style.color = '#10b981';
          } else if (data.done && !data.success) {
            statusBadge.textContent = 'FAILED';
            statusBadge.style.background = '#450a0a';
            statusBadge.style.color = '#f87171';
          } else {
            statusBadge.textContent = 'RUNNING';
            statusBadge.style.background = '#1e3a5f';
            statusBadge.style.color = '#60a5fa';
          }
        }

        if (data.done) {
          clearInterval(_pollTimer);
          _pollTimer = null;
          // Refresh schedule data to get updated lastRunAt
          await fetchSchedules();
          renderSidebar();
        }
      } catch (err) {
        console.error('[Schedules] Poll error:', err);
      }
    }, 2000);
  }

  // ── Init ──────────────────────────────────────────────────

  async function refreshAll() {
    try {
      await fetchSchedules();
      renderSidebar();
      renderDetail();
    } catch (err) {
      var main = document.getElementById('main');
      if (main) {
        main.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;">' +
          '<div style="font-size:2rem;margin-bottom:1rem;">&#9888;</div>' +
          '<h2 style="color:#e2e8f0;margin:0 0 0.5rem;">Error</h2>' +
          '<p>' + escHtml(err.message) + '</p>' +
          '</div>';
      }
    }
  }

  function initSchedules() {
    var main = document.getElementById('main');
    if (main) {
      main.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;"><div class="spinner" style="margin-right:0.5rem;"></div> Loading schedules...</div>';
    }
    selectedScheduleId = null;
    refreshAll();
  }

  window.initSchedules = initSchedules;
})();
