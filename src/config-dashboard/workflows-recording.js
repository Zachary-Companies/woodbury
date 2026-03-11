/**
 * Workflows Dashboard — Recording & Runtime Module
 *
 * Contains:
 *  - Recording UI (wireRecordingHandlers, startRecording, stopRecording,
 *    togglePauseRecording, cancelRecording, resetRecordingUI)
 *  - Recording poll (startRecordingPoll, stopRecordingPoll, pollRecordingStatus)
 *  - Re-record (startReRecording, stopReRecording, togglePauseReRecording,
 *    cancelReRecording, resetReRecordUI, startReRecordPoll, stopReRecordPoll,
 *    pollReRecordStatus)
 *  - Debug mode (startDebugMode, exitDebugMode)
 *  - Run workflow (runWorkflow, startRunPoll, stopRunPoll,
 *    cancelRunningWorkflow, resetRunUI)
 *  - Auto-fill variables (autoFillVariables, autoFillVariablesHeuristic,
 *    generateVariableValue)
 *  - Per-workflow training polls (startWorkflowTrainingPoll,
 *    stopWorkflowTrainingPoll, stopAllWorkflowTrainingPolls,
 *    checkAndPollWorkflowTraining, pollWorkflowTrainingOnce,
 *    renderWorkflowTrainingStatus, wireTrainingRetryBtn, formatTrainingTime)
 *  - Download detection modal (showDownloadDetectionModal)
 *
 * Loaded AFTER workflows-core.js and workflows-editor.js — uses globals
 * defined there.
 */

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

    // Get element identification mode
    var elementModeRadio = document.querySelector('input[name="wf-element-mode"]:checked');
    var recordingMode = (elementModeRadio && elementModeRadio.value === 'accessibility') ? 'accessibility' : 'standard';

    var res = await fetch('/api/recording/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, site: site, captureElementCrops: captureElementCrops, appName: appName || undefined, recordingMode: recordingMode }),
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

// ── Re-record existing workflow ──────────────────────────────

var _reRecordContext = null; // { wf, filePath, source }
var reRecordPollTimer = null;
var reRecordLastStepCount = 0;

async function startReRecording(wf, filePath, source) {
  _reRecordContext = { wf: wf, filePath: filePath, source: source };

  var isDesktopWf = wf.site === 'desktop';

  // Show recording controls
  var controls = document.querySelector('#wf-rerecord-controls');
  if (controls) {
    controls.style.display = 'flex';
    controls.style.gap = '0.5rem';
    controls.style.alignItems = 'center';
    controls.innerHTML =
      '<button class="btn-secondary wf-record-active-btn" id="wf-btn-rerecord-pause" title="Pause">&#x23f8; Pause</button>' +
      '<button class="btn-danger" id="wf-btn-rerecord-stop" style="font-size:0.8rem;padding:0.4rem 1rem;">&#x23f9; Stop &amp; Save</button>' +
      '<button class="btn-secondary" id="wf-btn-rerecord-cancel" style="font-size:0.75rem;padding:0.35rem 0.75rem;">Cancel</button>';
  }

  // Show feed
  var feed = document.querySelector('#wf-rerecord-feed');
  if (feed) {
    feed.style.display = 'block';
    feed.innerHTML =
      '<div id="wf-rerecord-status"><span class="wf-rec-indicator">&#x23fa;</span> Starting re-record...</div>' +
      '<div id="wf-rerecord-steps" style="margin-top:0.5rem;font-size:0.72rem;color:#64748b;max-height:200px;overflow-y:auto;"></div>';
  }

  // Hide the re-record button
  var rerecordBtn = document.querySelector('#wf-btn-rerecord');
  if (rerecordBtn) rerecordBtn.style.display = 'none';

  // Show recording mode selector and pre-select the workflow's current mode
  var modeSelectorDiv = document.querySelector('#wf-rerecord-mode-selector');
  if (modeSelectorDiv) {
    modeSelectorDiv.style.display = 'block';
    var currentMode = (wf.metadata && wf.metadata.recordingMode) || 'standard';
    var radioToCheck = document.querySelector('input[name="wf-rerecord-mode"][value="' + currentMode + '"]');
    if (radioToCheck) radioToCheck.checked = true;
  }

  // Wire buttons
  document.querySelector('#wf-btn-rerecord-stop').addEventListener('click', stopReRecording);
  document.querySelector('#wf-btn-rerecord-pause').addEventListener('click', togglePauseReRecording);
  document.querySelector('#wf-btn-rerecord-cancel').addEventListener('click', cancelReRecording);

  try {
    // Get the selected recording mode for re-record
    var reRecordModeRadio = document.querySelector('input[name="wf-rerecord-mode"]:checked');
    var reRecordMode = (reRecordModeRadio && reRecordModeRadio.value === 'accessibility') ? 'accessibility' : 'standard';

    var res = await fetch('/api/recording/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: wf.name,
        site: wf.site,
        captureElementCrops: true,
        reRecord: { workflowId: wf.id, filePath: filePath },
        recordingMode: reRecordMode,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Start failed');

    var statusEl = document.querySelector('#wf-rerecord-status');
    if (statusEl) {
      statusEl.innerHTML =
        '<span class="wf-rec-indicator wf-rec-active">&#x23fa;</span> Recording — ' +
        (isDesktopWf ? 'click anywhere on screen' : 'interact with Chrome now');
    }

    startReRecordPoll();
  } catch (err) {
    toast('Re-record failed: ' + err.message, 'error');
    resetReRecordUI();
  }
}

async function stopReRecording() {
  stopReRecordPoll();
  var statusEl = document.querySelector('#wf-rerecord-status');
  if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator">&#x23f9;</span> Saving...';

  try {
    var res = await fetch('/api/recording/stop', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Stop failed');

    toast('Steps re-recorded! ' + data.stepCount + ' steps captured.', 'success');
    resetReRecordUI();

    // Re-load and re-render the workflow
    await fetchWorkflows();
    if (_reRecordContext && _reRecordContext.wf) {
      selectWorkflow(_reRecordContext.wf.id);
    }
    _reRecordContext = null;
  } catch (err) {
    toast('Stop failed: ' + err.message, 'error');
    resetReRecordUI();
  }
}

async function togglePauseReRecording() {
  var statusRes = await fetch('/api/recording/status');
  var status = await statusRes.json();
  var isPaused = status.paused;

  try {
    var endpoint = isPaused ? '/api/recording/resume' : '/api/recording/pause';
    var res = await fetch(endpoint, { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error);

    var pauseBtn = document.querySelector('#wf-btn-rerecord-pause');
    var statusEl = document.querySelector('#wf-rerecord-status');

    if (isPaused) {
      if (pauseBtn) pauseBtn.innerHTML = '&#x23f8; Pause';
      if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator wf-rec-active">&#x23fa;</span> Recording';
      startReRecordPoll();
    } else {
      if (pauseBtn) pauseBtn.innerHTML = '&#x25b6; Resume';
      if (statusEl) statusEl.innerHTML = '<span class="wf-rec-indicator wf-rec-paused">&#x23f8;</span> Paused';
      stopReRecordPoll();
    }
  } catch (err) {
    toast('Pause/resume failed: ' + err.message, 'error');
  }
}

async function cancelReRecording() {
  stopReRecordPoll();
  try {
    await fetch('/api/recording/cancel', { method: 'POST' });
  } catch {}
  toast('Re-record cancelled', 'info');
  resetReRecordUI();
  // Re-render the original workflow
  if (_reRecordContext) {
    renderWorkflowDetail(_reRecordContext.wf, _reRecordContext.filePath, _reRecordContext.source);
    _reRecordContext = null;
  }
}

function resetReRecordUI() {
  stopReRecordPoll();

  var controls = document.querySelector('#wf-rerecord-controls');
  if (controls) { controls.style.display = 'none'; controls.innerHTML = ''; }

  var feed = document.querySelector('#wf-rerecord-feed');
  if (feed) { feed.style.display = 'none'; feed.innerHTML = ''; }

  var modeSelector = document.querySelector('#wf-rerecord-mode-selector');
  if (modeSelector) modeSelector.style.display = 'none';

  var rerecordBtn = document.querySelector('#wf-btn-rerecord');
  if (rerecordBtn) rerecordBtn.style.display = '';
}

function startReRecordPoll() {
  reRecordLastStepCount = 0;
  reRecordPollTimer = setInterval(pollReRecordStatus, 1000);
}

function stopReRecordPoll() {
  if (reRecordPollTimer) {
    clearInterval(reRecordPollTimer);
    reRecordPollTimer = null;
  }
}

async function pollReRecordStatus() {
  try {
    var res = await fetch('/api/recording/status');
    var data = await res.json();
    if (!data.active) {
      stopReRecordPoll();
      return;
    }

    // Update step count in feed
    var stepsEl = document.querySelector('#wf-rerecord-steps');
    if (stepsEl && data.steps && data.steps.length > reRecordLastStepCount) {
      for (var i = reRecordLastStepCount; i < data.steps.length; i++) {
        var s = data.steps[i];
        var icon = STEP_ICONS[s.type] || '&#x25cf;';
        stepsEl.innerHTML += '<div style="padding:0.15rem 0;border-bottom:1px solid #1e293b;">' +
          '<span style="opacity:0.5;">' + (s.index + 1) + '.</span> ' +
          icon + ' ' + escHtml(s.label) + '</div>';
      }
      reRecordLastStepCount = data.steps.length;
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }
  } catch {}
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

// formatDuration() is defined in workflows-core.js

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
  else if (phaseLabel === 'exporting') { phaseLabel = 'finishing up'; phaseColor = '#065f46'; phaseText = '#6ee7b7'; }

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
    barLabel = 'Packaging model for browser...';
  } else if (status.totalEpochs > 0) {
    pct = Math.round((status.currentEpoch / status.totalEpochs) * 100);
    barLabel = 'Round ' + status.currentEpoch + ' of ' + status.totalEpochs + ' (' + pct + '%)';
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
