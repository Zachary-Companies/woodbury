/**
 * Woodbury Debug Side Panel
 *
 * Provides step-through debug UI for workflow playback.
 * Communicates with background.js for state and with the
 * dashboard API directly for step execution.
 */

/* ── State ─────────────────────────────────────────────── */

let debugState = null;   // synced from background.js
let apiBaseUrl = null;    // dashboard HTTP API base URL
let workflowId = null;    // current workflow being debugged
let stepping = false;     // true while a step is executing
let runningAll = false;   // true while Run All is in progress
let lastViewedStepIndex = null; // track which step's coord info is displayed (for editing)
let lastPickData = null;        // element bounds/dpr from last "Pick from Page" (per-step)

const STEP_ICONS = {
  navigate: '\u{1F310}',
  click: '\u{1F5B1}',
  type: '\u2328',
  keyboard: '\u2328',
  wait: '\u23F3',
  scroll: '\u2195',
  assert: '\u2714',
  download: '\u2B07',
  capture_download: '\u{1F4E5}',
  move_file: '\u{1F4C1}',
  conditional: '\u2696',
  loop: '\u{1F501}',
  try_catch: '\u{1F6E1}',
  file_dialog: '\u{1F4C2}',
  inject_style: '\u{1F3A8}',
  keyboard_nav: '\u{1F9ED}',
  click_selector: '\u{1F3AF}',
};

/* ── Lifecycle port — lets background.js track open/close state ── */

chrome.runtime.connect({ name: 'woodbury-sidepanel' });

/* ── Initialization ────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  var initialized = false;

  // Path 1: Try message-based query (fastest when service worker is alive)
  try {
    var response = await chrome.runtime.sendMessage({ type: 'debug_get_state' });
    if (response && response.active) {
      debugState = response;
      apiBaseUrl = response.apiBaseUrl;
      workflowId = response.workflowId;
      renderDebugUI();
      initialized = true;
    }
  } catch (err) {
    console.log('[Woodbury Debug Panel] Message query failed:', err.message);
  }

  // Path 2: Fallback to persistent storage (survives service worker restarts)
  if (!initialized) {
    try {
      var stored = await chrome.storage.local.get('debugModeData');
      if (stored.debugModeData && stored.debugModeData.steps) {
        console.log('[Woodbury Debug Panel] Loaded from storage:', stored.debugModeData.workflowName);
        debugState = { active: true, ...stored.debugModeData };
        apiBaseUrl = stored.debugModeData.apiBaseUrl;
        workflowId = stored.debugModeData.workflowId;
        renderDebugUI();
        initialized = true;
      }
    } catch (err) {
      console.log('[Woodbury Debug Panel] Storage fallback failed:', err.message);
    }
  }

  if (!initialized) {
    renderEmptyState();
  }

  // Check for any element pick that happened while the sidepanel was closed
  try {
    var pickResp = await chrome.runtime.sendMessage({ type: 'get_pending_pick' });
    if (pickResp && pickResp.pendingPick) {
      var pick = pickResp.pendingPick;
      console.log('[Woodbury Debug Panel] Processing pending pick for step', pick.stepIndex);
      // Process it exactly like a live element_picked message
      var pickIdx = pick.stepIndex;
      lastPickData = {
        stepIndex: pickIdx,
        elementBounds: pick.elementBounds,
        dpr: pick.dpr,
      };
      var pctXInput = document.getElementById('dbg-edit-pctX');
      var pctYInput = document.getElementById('dbg-edit-pctY');
      if (pctXInput) pctXInput.value = pick.pctX.toFixed(1);
      if (pctYInput) pctYInput.value = pick.pctY.toFixed(1);
      previewMarkerPosition(pickIdx, pick.pctX, pick.pctY);
      try {
        await updateStepPosition(pickIdx, pick.pctX, pick.pctY);
        await captureElement(pickIdx, pick.pctX, pick.pctY, pick.elementBounds, pick.dpr, pick.screenshot);
      } catch (e) {
        setStatus('Pending pick error: ' + e.message, 'error');
      }
    }
  } catch (err) {
    // No pending pick or background not ready — fine
  }

  // Check for any step result from a toggle-step execution (close→execute→reopen)
  try {
    var stepResp = await chrome.runtime.sendMessage({ type: 'get_pending_step_result' });
    if (stepResp && stepResp.pendingStepResult) {
      var sr = stepResp.pendingStepResult;
      console.log('[Woodbury Debug Panel] Processing pending step result for step', sr.stepIndex);
      if (sr.error) {
        setStatus('Step error: ' + sr.error, 'error');
      } else {
        processStepResult(sr);
      }
    }
  } catch (err) {
    // No pending step result — fine
  }
});

/* ── Live updates from chrome.storage (catches debug start even if messages fail) ── */

chrome.storage.onChanged.addListener(function(changes, area) {
  if (area !== 'local' || !changes.debugModeData) return;
  var newVal = changes.debugModeData.newValue;
  if (newVal && newVal.steps) {
    debugState = { active: true, ...newVal };
    apiBaseUrl = newVal.apiBaseUrl;
    workflowId = newVal.workflowId;
    renderDebugUI();
  } else if (!newVal) {
    debugState = null;
    apiBaseUrl = null;
    workflowId = null;
    stepping = false;
    runningAll = false;
    renderEmptyState();
  }
});

/* ── Messages from background.js ───────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'debug_started') {
    debugState = message.data;
    apiBaseUrl = message.data.apiBaseUrl;
    workflowId = message.data.workflowId;
    renderDebugUI();
  }
  if (message.type === 'debug_step_result') {
    // Update from bridge (when step is triggered externally)
    if (debugState) {
      debugState.currentIndex = message.data.currentIndex;
      debugState.completedIndices = message.data.completedIndices || [];
      debugState.failedIndices = message.data.failedIndices || [];
    }
    updateMarkersUI();
  }
  if (message.type === 'debug_ended') {
    debugState = null;
    apiBaseUrl = null;
    workflowId = null;
    stepping = false;
    runningAll = false;
    renderEmptyState();
  }

  // Element picked from page — update position + capture reference image
  if (message.type === 'element_picked') {
    var pickIdx = message.stepIndex;

    // Store pick data so Save can reuse the exact element bounds
    lastPickData = {
      stepIndex: pickIdx,
      elementBounds: message.elementBounds,
      dpr: message.dpr,
    };

    // Update pctX/pctY inputs if they exist
    var pctXInput = document.getElementById('dbg-edit-pctX');
    var pctYInput = document.getElementById('dbg-edit-pctY');
    if (pctXInput) pctXInput.value = message.pctX.toFixed(1);
    if (pctYInput) pctYInput.value = message.pctY.toFixed(1);

    // Update marker on page immediately
    previewMarkerPosition(pickIdx, message.pctX, message.pctY);

    // Save position + capture element (async, fire and handle)
    (async function() {
      try {
        await updateStepPosition(pickIdx, message.pctX, message.pctY);
        await captureElement(pickIdx, message.pctX, message.pctY, message.elementBounds, message.dpr);
      } catch (e) {
        setStatus('Pick error: ' + e.message, 'error');
      }
    })();

    // Reset pick button
    var pickBtn2 = document.getElementById('dbg-pick-btn');
    if (pickBtn2) { pickBtn2.textContent = '\uD83C\uDFAF Pick from Page'; pickBtn2.disabled = false; }
  }

  // Element pick cancelled (Escape)
  if (message.type === 'element_pick_cancelled') {
    var pickBtnCancel = document.getElementById('dbg-pick-btn');
    if (pickBtnCancel) { pickBtnCancel.textContent = '\uD83C\uDFAF Pick from Page'; pickBtnCancel.disabled = false; }
    setStatus('Pick cancelled', null);
  }
});

/* ── Rendering ─────────────────────────────────────────── */

function escHtml(str) {
  var d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function renderEmptyState() {
  document.getElementById('app').innerHTML =
    '<div class="empty-state">' +
      '<div class="empty-state-icon">&#x1f50d;</div>' +
      '<div class="empty-state-text">' +
        'No debug session active.<br>' +
        'Start a debug session from the<br>Woodbury Dashboard.' +
      '</div>' +
    '</div>';
}

function renderDebugUI() {
  if (!debugState || !debugState.steps) return renderEmptyState();

  var steps = debugState.steps;
  var name = debugState.workflowName || 'Workflow';
  var currentIndex = debugState.currentIndex || 0;
  var completedIndices = debugState.completedIndices || [];
  var failedIndices = debugState.failedIndices || [];

  var html = '';

  // Header
  html += '<div class="dbg-header">';
  html += '<div class="dbg-header-title">&#x1f50d; ' + escHtml(name) + '</div>';
  html += '<div class="dbg-header-count">' + steps.length + ' steps</div>';
  html += '</div>';

  // Controls
  html += '<div class="dbg-controls">';
  html += '<button class="btn-next" id="dbg-btn-next">&#x25b6; Next Step</button>';
  html += '<button class="btn-run-all" id="dbg-btn-run-all">&#x23e9; Run All</button>';
  html += '<button class="btn-exit" id="dbg-btn-exit">&#x23f9; Exit</button>';
  html += '</div>';

  // Step list
  html += '<div class="dbg-step-list" id="dbg-step-list">';
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    var isControlFlow = s.isControlFlow || false;
    var icon = isControlFlow ? (STEP_ICONS[s.type] || '\u2699') :
               (s.type === 'click' && s.clickType === 'hover') ? '\u2197' : (STEP_ICONS[s.type] || '\u25cf');
    var cls = 'dbg-step';
    // Detect nesting depth from label prefix (e.g. "Then → Else → ...")
    var nestDepth = 0;
    var displayLabel = s.label || '';
    if (!isControlFlow && displayLabel.indexOf(' \u2192 ') !== -1) {
      var arrowParts = displayLabel.split(' \u2192 ');
      nestDepth = arrowParts.length - 1;
    }
    if (isControlFlow) {
      cls += ' dbg-step-control-flow';
    }
    if (nestDepth > 0) {
      cls += ' dbg-step-nested';
    }
    if (completedIndices.includes(i)) {
      cls += ' dbg-step-completed';
    } else if (failedIndices.includes(i)) {
      cls += ' dbg-step-failed';
    } else if (i === currentIndex) {
      cls += ' dbg-step-current';
    } else {
      cls += ' dbg-step-pending';
    }
    html += '<div class="' + cls + '" data-idx="' + i + '" style="' + (nestDepth > 0 ? 'padding-left:' + (8 + nestDepth * 16) + 'px;' : '') + '">';
    html += '<span class="dbg-step-num">' + (i + 1) + '</span>';
    html += '<span class="dbg-step-icon">' + icon + '</span>';
    html += '<span class="dbg-step-label">' + escHtml(displayLabel) + '</span>';
    html += '<span class="dbg-step-status">';
    if (completedIndices.includes(i)) {
      html += isControlFlow ? '\u23ed' : '\u2705';
    } else if (failedIndices.includes(i)) {
      html += '\u274c';
    }
    html += '</span>';
    html += '</div>';
  }
  html += '</div>';

  // Coord info
  html += '<div class="dbg-coord" id="dbg-coord">';
  html += '<div style="color:#475569;font-style:italic;">Click a step to edit its position</div>';
  html += '</div>';

  // Status bar
  html += '<div class="dbg-status" id="dbg-status">Ready</div>';

  document.getElementById('app').innerHTML = html;

  // Wire controls
  document.getElementById('dbg-btn-next').addEventListener('click', () => debugNextStep());
  document.getElementById('dbg-btn-run-all').addEventListener('click', () => debugRunAll());
  document.getElementById('dbg-btn-exit').addEventListener('click', () => exitDebugMode());

  // Wire click-to-select on ALL steps (edit position or review results)
  document.querySelectorAll('#dbg-step-list .dbg-step').forEach(function(el) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-idx'));
      if (!debugState) return;

      // Update selection highlight in side panel
      document.querySelectorAll('#dbg-step-list .dbg-step').forEach(function(s) {
        s.classList.remove('dbg-step-selected');
      });
      this.classList.add('dbg-step-selected');

      // Highlight the marker on the page too
      chrome.runtime.sendMessage({
        type: 'select_debug_marker',
        stepIndex: idx,
      }).catch(function() {});

      // Show coord info — use step results if available, otherwise just step data
      if (debugState.stepResults && debugState.stepResults[idx]) {
        var sr = debugState.stepResults[idx];
        updateCoordInfo({
          stepIndex: sr.stepIndex,
          coordinateInfo: sr.coordinateInfo,
          stepResult: { status: sr.status, error: sr.error },
          visualVerification: sr.visualVerification || null,
          stepDetail: sr.stepDetail || null,
        });
      } else {
        // Pending step — show editable position from recorded data
        updateCoordInfo({
          stepIndex: idx,
          coordinateInfo: null,
          stepResult: null,
        });
      }
    });
  });

  // Restore coord info from last executed step (for panel close/reopen)
  if (debugState.stepResults && debugState.stepResults.length > 0) {
    var lastResult = null;
    for (var i = debugState.stepResults.length - 1; i >= 0; i--) {
      if (debugState.stepResults[i]) { lastResult = debugState.stepResults[i]; break; }
    }
    if (lastResult) {
      updateCoordInfo({
        stepIndex: lastResult.stepIndex,
        coordinateInfo: lastResult.coordinateInfo,
        stepResult: { status: lastResult.status, error: lastResult.error },
      });
      // Update status bar to reflect where we are
      var done = completedIndices.length + failedIndices.length;
      setStatus(done + ' of ' + steps.length + ' steps executed', done === steps.length ? 'success' : null);
    }
  }

  // If all steps are done, disable Next Step button
  if (completedIndices.length + failedIndices.length >= steps.length) {
    var nextBtn = document.getElementById('dbg-btn-next');
    if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = '\u2705 Done'; }
    var runAllBtn = document.getElementById('dbg-btn-run-all');
    if (runAllBtn) { runAllBtn.disabled = true; runAllBtn.textContent = '\u2705 Done'; }
  }
}

function updateMarkersUI() {
  if (!debugState || !debugState.steps) return;
  var steps = debugState.steps;
  var currentIndex = debugState.currentIndex || 0;
  var completedIndices = debugState.completedIndices || [];
  var failedIndices = debugState.failedIndices || [];

  var stepEls = document.querySelectorAll('#dbg-step-list .dbg-step');
  stepEls.forEach(function(el) {
    var idx = parseInt(el.getAttribute('data-idx'));
    el.className = 'dbg-step';
    if (completedIndices.includes(idx)) {
      el.className += ' dbg-step-completed';
      var st = el.querySelector('.dbg-step-status');
      if (st) st.textContent = '\u2705';
    } else if (failedIndices.includes(idx)) {
      el.className += ' dbg-step-failed';
      var st = el.querySelector('.dbg-step-status');
      if (st) st.textContent = '\u274c';
    } else if (idx === currentIndex) {
      el.className += ' dbg-step-current';
    } else {
      el.className += ' dbg-step-pending';
    }
  });
}

function updateCoordInfo(data) {
  var coordEl = document.getElementById('dbg-coord');
  if (!coordEl) return;

  var idx = data.stepIndex;
  var ci = data.coordinateInfo;
  var status = data.stepResult ? data.stepResult.status : 'unknown';
  lastViewedStepIndex = idx;

  var step = debugState && debugState.steps[idx] ? debugState.steps[idx] : null;
  var stepType = step ? step.type : null;

  // Restore lastPickData from step's persisted pickedBounds (survives reload/step switch)
  if (step && step.target && step.target.pickedBounds && step.target.pickedBounds.width > 0) {
    lastPickData = { stepIndex: idx, elementBounds: step.target.pickedBounds, dpr: step.target.pickedDpr || 1 };
  } else if (!lastPickData || lastPickData.stepIndex !== idx) {
    lastPickData = null; // Clear if switching to a step with no saved pick
  }

  var html = '';
  html += '<div class="dbg-coord-title">Step ' + (idx + 1) + ' — ' + escHtml(step ? step.label : 'Unknown') + '</div>';

  // Status row (if step has been executed)
  if (data.stepResult && data.stepResult.status) {
    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Status</span><span class="dbg-coord-value" style="color:' + (status === 'success' ? '#10b981' : '#ef4444') + ';">' + status + '</span></div>';
  }

  // Visual verification badge (if available)
  if (data.visualVerification && data.visualVerification.ran) {
    var vv = data.visualVerification;
    if (vv.verified) {
      var vvSim = ((vv.similarity || 0) * 100).toFixed(1);
      html += '<div style="padding:0.3rem 0.5rem;margin:0.3rem 0;border-radius:4px;font-size:0.65rem;background:rgba(16,185,129,0.1);border:1px solid #065f46;color:#6ee7b7;">';
      html += '\u2705 Visual match: ' + vvSim + '%';
      html += '</div>';
    } else {
      var vvSim2 = ((vv.similarity || 0) * 100).toFixed(1);
      html += '<div style="padding:0.3rem 0.5rem;margin:0.3rem 0;border-radius:4px;font-size:0.65rem;background:rgba(239,68,68,0.1);border:1px solid #7f1d1d;color:#fca5a5;">';
      html += '\u274c Visual mismatch: ' + vvSim2 + '%';
      if (vv.searchResult && vv.searchResult.found) {
        html += '<br>\u{1f50d} Found nearby: ' + ((vv.searchResult.similarity || 0) * 100).toFixed(1) + '% (' + vv.searchResult.candidatesChecked + ' checked)';
      }
      html += '</div>';
    }
  }

  // ── Control flow steps: show info only ──
  if (stepType === 'conditional' || stepType === 'loop' || stepType === 'try_catch') {
    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Type</span><span class="dbg-coord-value" style="color:#8b5cf6;">' + stepType.replace('_', '/') + '</span></div>';
    if (step && step.isControlFlow) {
      html += '<div style="color:#64748b;font-style:italic;font-size:0.7rem;margin-top:4px;">Control flow marker — auto-skipped during execution. Sub-steps run individually below.</div>';
    }
    if (data.stepResult && data.stepResult.status) {
      var cfStatusColor = data.stepResult.status === 'skipped' ? '#8b5cf6' : (data.stepResult.status === 'success' ? '#10b981' : '#ef4444');
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Status</span><span class="dbg-coord-value" style="color:' + cfStatusColor + ';">' + data.stepResult.status + '</span></div>';
    }
    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;
    return;
  }

  // ── Inject Style step: show selector, action, and result ──
  if (stepType === 'inject_style') {
    var isAction = step ? (step.action || 'apply') : 'apply';
    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Action</span><span class="dbg-coord-value" style="color:#8b5cf6;">' + isAction + '</span></div>';
    if (step && step.selector) {
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Selector</span><span class="dbg-coord-value" style="font-family:monospace;font-size:0.65rem;">' + escHtml(step.selector) + '</span></div>';
    }
    if (isAction === 'apply' && step && step.styles) {
      var styleKeys = Object.keys(step.styles);
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Styles</span><span class="dbg-coord-value" style="font-size:0.65rem;">' + escHtml(styleKeys.join(', ')) + '</span></div>';
    }

    // Show result from stepDetail
    var sd = data.stepDetail;
    if (sd) {
      if (sd.action === 'apply') {
        var countColor = sd.elementsModified > 0 ? '#10b981' : '#ef4444';
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Elements found</span><span class="dbg-coord-value" style="color:' + countColor + ';">' + sd.elementsModified + '</span></div>';
        if (sd.stylesApplied && sd.stylesApplied.length > 0) {
          html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Applied</span><span class="dbg-coord-value" style="font-size:0.65rem;">' + escHtml(sd.stylesApplied.join(', ')) + '</span></div>';
        }
      } else if (sd.action === 'clear') {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Elements reverted</span><span class="dbg-coord-value" style="color:#10b981;">' + sd.elementsReverted + '</span></div>';
      }
    } else if (!data.stepResult) {
      html += '<div style="color:#475569;font-style:italic;font-size:0.7rem;margin-top:4px;">Not yet executed</div>';
    }

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;
    return;
  }

  // ── Keyboard Nav step: show action sequence and focus info ──
  if (stepType === 'keyboard_nav') {
    // Action labels
    var navLabels = { tab: 'Tab', shift_tab: 'Shift+Tab', arrow_up: '\u2191 Up', arrow_down: '\u2193 Down', arrow_left: '\u2190 Left', arrow_right: '\u2192 Right', enter: 'Enter', space: 'Space', escape: 'Esc' };

    // Show action sequence
    var actions = step.actions || [];
    var seqParts = [];
    for (var ai = 0; ai < actions.length; ai++) {
      var act = actions[ai];
      var actLabel = navLabels[act.key] || act.key;
      if (act.matchText) {
        seqParts.push(actLabel + ' find "' + escHtml(act.matchText.substring(0, 25)) + '"');
      } else {
        seqParts.push(actLabel + (act.count > 1 ? ' \u00d7' + act.count : ''));
      }
    }
    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Sequence</span><span class="dbg-coord-value" style="color:#8b5cf6;font-size:0.65rem;">' + seqParts.join(' \u2192 ') + '</span></div>';

    // Show expected focus
    if (step.expectedFocus) {
      var efParts = [];
      if (step.expectedFocus.text) efParts.push('text: "' + escHtml(step.expectedFocus.text.substring(0, 30)) + '"');
      if (step.expectedFocus.ariaLabel) efParts.push('aria: "' + escHtml(step.expectedFocus.ariaLabel) + '"');
      if (step.expectedFocus.role) efParts.push('role: ' + escHtml(step.expectedFocus.role));
      if (step.expectedFocus.tag) efParts.push('tag: ' + escHtml(step.expectedFocus.tag));
      if (step.expectedFocus.placeholder) efParts.push('placeholder: "' + escHtml(step.expectedFocus.placeholder) + '"');
      if (efParts.length > 0) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Expected</span><span class="dbg-coord-value" style="font-size:0.65rem;">' + efParts.join(', ') + '</span></div>';
      }
    }

    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Auto-fix</span><span class="dbg-coord-value">' + (step.autoFix !== false ? 'On' : 'Off') + '</span></div>';
    html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Max search</span><span class="dbg-coord-value">' + (step.maxSearchDistance || 20) + '</span></div>';

    // Show step detail from execution
    var sd = data.stepDetail;
    if (sd) {
      if (sd.actualFocus) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Actual focus</span><span class="dbg-coord-value" style="font-size:0.65rem;">' + escHtml(sd.actualFocus.tag + (sd.actualFocus.text ? ': "' + sd.actualFocus.text.substring(0, 30) + '"' : '')) + '</span></div>';
      }
      if (sd.matched !== undefined) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Match</span><span class="dbg-coord-value" style="color:' + (sd.matched ? '#10b981' : '#ef4444') + ';">' + (sd.matched ? 'Yes' : 'No') + '</span></div>';
      }
      if (sd.correctedCount !== undefined) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Corrected</span><span class="dbg-coord-value" style="color:#f59e0b;">' + sd.originalCount + ' \u2192 ' + sd.correctedCount + '</span></div>';
      }
      if (sd.searchIterations !== undefined) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Searched</span><span class="dbg-coord-value">' + sd.searchIterations + ' presses</span></div>';
      }
    }

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;
    return;
  }

  // ── Wait step: show editable duration ──
  if (stepType === 'wait') {
    var waitMs = step.waitMs;
    var waitSec = waitMs != null ? (waitMs / 1000).toFixed(1) : '';
    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Wait time</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="number" id="dbg-edit-wait" value="' + waitSec + '" step="0.5" min="0" max="300" class="dbg-coord-input dbg-wait-input" title="Seconds">';
    html += '<span style="margin:0 4px;color:#64748b;font-size:0.65rem;">sec</span>';
    html += '<button id="dbg-save-wait" class="dbg-save-btn" title="Save wait time">Save</button>';
    html += '</span></div>';

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;

    // Wire save button
    var saveWaitBtn = document.getElementById('dbg-save-wait');
    if (saveWaitBtn) {
      saveWaitBtn.addEventListener('click', function() {
        var secs = parseFloat(document.getElementById('dbg-edit-wait').value);
        if (isNaN(secs) || secs < 0) {
          setStatus('Invalid wait time', 'error');
          return;
        }
        updateStepWaitTime(idx, Math.round(secs * 1000));
      });
    }
    return;
  }

  // ── Click/type step: show editable position ──
  if (stepType === 'click' || stepType === 'type') {
    // Click type selector (click steps only)
    if (stepType === 'click') {
      var currentClickType = (step && step.clickType) ? step.clickType : 'single';
      html += '<div class="dbg-coord-row dbg-coord-edit-row">';
      html += '<span class="dbg-coord-label">Action</span>';
      html += '<span class="dbg-coord-value dbg-coord-edit">';
      html += '<select id="dbg-click-type" class="dbg-coord-input" style="width:auto;min-width:100px;">';
      html += '<option value="single"' + (currentClickType === 'single' ? ' selected' : '') + '>Single Click</option>';
      html += '<option value="double"' + (currentClickType === 'double' ? ' selected' : '') + '>Double Click</option>';
      html += '<option value="right"' + (currentClickType === 'right' ? ' selected' : '') + '>Right Click</option>';
      html += '<option value="hover"' + (currentClickType === 'hover' ? ' selected' : '') + '>Hover / Move</option>';
      html += '</select>';
      html += '</span></div>';
    }

    var stepPctX = step ? step.pctX : null;
    var stepPctY = step ? step.pctY : null;
    if (stepPctX == null && ci) stepPctX = ci.pctX;
    if (stepPctY == null && ci) stepPctY = ci.pctY;

    if (ci || stepPctX != null) {
      var pctXVal = stepPctX != null ? parseFloat(stepPctX).toFixed(1) : '';
      var pctYVal = stepPctY != null ? parseFloat(stepPctY).toFixed(1) : '';
      html += '<div class="dbg-coord-row dbg-coord-edit-row">';
      html += '<span class="dbg-coord-label">Position %</span>';
      html += '<span class="dbg-coord-value dbg-coord-edit">';
      html += '<input type="number" id="dbg-edit-pctX" value="' + pctXVal + '" step="0.1" min="0" max="100" class="dbg-coord-input" title="X %">';
      html += '<span style="margin:0 2px;color:#475569;">,</span>';
      html += '<input type="number" id="dbg-edit-pctY" value="' + pctYVal + '" step="0.1" min="0" max="100" class="dbg-coord-input" title="Y %">';
      html += '<button id="dbg-save-pos" class="dbg-save-btn" title="Save position">Save</button>';
      html += '</span></div>';
      html += '<div class="dbg-coord-row"><button id="dbg-pick-btn" class="dbg-pick-btn" title="Click on element in page">\uD83C\uDFAF Pick from Page</button></div>';
    }

    // ── Verify + Retry toggle (click steps only) ──
    if (stepType === 'click') {
      var vc = step.verifyClick || null;
      var vcEnabled = vc && vc.enabled ? true : false;
      var vcMaxAttempts = vc && vc.maxAttempts != null ? vc.maxAttempts : 3;
      var vcVerifyDelay = vc && vc.verifyDelayMs != null ? vc.verifyDelayMs : 400;
      var vcRetryDelay = vc && vc.retryDelayMs != null ? vc.retryDelayMs : 600;
      html += '<div class="dbg-verify-section">';
      html += '<div class="dbg-coord-row dbg-coord-edit-row">';
      html += '<label class="dbg-verify-label"><input type="checkbox" id="dbg-verify-enabled" ' + (vcEnabled ? 'checked' : '') + '> Verify + retry click</label>';
      html += '</div>';
      html += '<div id="dbg-verify-opts" style="' + (vcEnabled ? '' : 'display:none;') + '">';
      html += '<div class="dbg-coord-row dbg-coord-edit-row"><span class="dbg-coord-label">Max attempts</span><span class="dbg-coord-value dbg-coord-edit"><input type="number" id="dbg-verify-max" value="' + vcMaxAttempts + '" min="1" max="10" step="1" class="dbg-coord-input dbg-verify-input"></span></div>';
      html += '<div class="dbg-coord-row dbg-coord-edit-row"><span class="dbg-coord-label">Check delay</span><span class="dbg-coord-value dbg-coord-edit"><input type="number" id="dbg-verify-delay" value="' + vcVerifyDelay + '" min="100" max="5000" step="100" class="dbg-coord-input dbg-verify-input"><span style="margin-left:2px;color:#64748b;font-size:0.6rem;">ms</span></span></div>';
      html += '<div class="dbg-coord-row dbg-coord-edit-row"><span class="dbg-coord-label">Retry delay</span><span class="dbg-coord-value dbg-coord-edit"><input type="number" id="dbg-verify-retry" value="' + vcRetryDelay + '" min="100" max="5000" step="100" class="dbg-coord-input dbg-verify-input"><span style="margin-left:2px;color:#64748b;font-size:0.6rem;">ms</span></span></div>';
      html += '<div class="dbg-coord-row"><button id="dbg-save-verify" class="dbg-save-btn" title="Save verify settings">Save verify</button></div>';
      html += '</div>';
      html += '</div>';
    }

    // ── Capture Element section ──
    var hasRefImage = (step && step.hasReferenceImage) || false;
    html += '<div class="dbg-capture-section">';
    html += '<div class="dbg-capture-row">';
    html += '<button id="dbg-capture-btn" class="dbg-capture-btn' + (hasRefImage ? ' dbg-capture-has-ref' : '') + '">';
    html += hasRefImage ? '\uD83D\uDCF7 Re-capture Element' : '\uD83D\uDCF7 Capture Element';
    html += '</button>';
    html += '<div class="dbg-capture-padding-ctl"><label for="dbg-capture-padding" class="dbg-capture-padding-label">Pad</label><input type="number" id="dbg-capture-padding" value="8" min="0" max="60" step="2" class="dbg-coord-input dbg-capture-padding-input" title="Padding around element (px)"><span class="dbg-capture-padding-unit">px</span></div>';
    html += '</div>';
    html += '<div id="dbg-capture-result"></div>';
    if (hasRefImage) {
      html += '<div id="dbg-capture-existing" class="dbg-capture-info">\u2705 Reference image saved</div>';
    }
    html += '</div>';

    if (ci) {
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Viewport px</span><span class="dbg-coord-value">(' + (ci.viewportX ?? '?') + ', ' + (ci.viewportY ?? '?') + ')</span></div>';
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Screen px</span><span class="dbg-coord-value">(' + (ci.screenX ?? '?') + ', ' + (ci.screenY ?? '?') + ')</span></div>';
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Chrome offset</span><span class="dbg-coord-value">(' + (ci.chromeOffset?.x ?? '?') + ', ' + (ci.chromeOffset?.y ?? '?') + ')</span></div>';
      html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Viewport size</span><span class="dbg-coord-value">' + (ci.viewport?.w ?? '?') + ' \u00d7 ' + (ci.viewport?.h ?? '?') + '</span></div>';
      if (ci.recordedViewport) {
        html += '<div class="dbg-coord-row"><span class="dbg-coord-label">Recorded VP</span><span class="dbg-coord-value">' + ci.recordedViewport.w + ' \u00d7 ' + ci.recordedViewport.h + '</span></div>';
      }
    }

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;

    // Wire save button — save position + auto-capture element
    var saveBtn = document.getElementById('dbg-save-pos');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        var newPctX = parseFloat(document.getElementById('dbg-edit-pctX').value);
        var newPctY = parseFloat(document.getElementById('dbg-edit-pctY').value);
        if (isNaN(newPctX) || isNaN(newPctY)) {
          setStatus('Invalid position values', 'error');
          return;
        }
        // Reuse element bounds from the last pick (if same step) so we don't re-hit-test
        var pickBounds = null;
        var pickDpr = null;
        if (lastPickData && lastPickData.stepIndex === idx) {
          pickBounds = lastPickData.elementBounds;
          pickDpr = lastPickData.dpr;
        }
        (async function() {
          try {
            await updateStepPosition(idx, newPctX, newPctY);
            await captureElement(idx, newPctX, newPctY, pickBounds, pickDpr);
          } catch (e) {
            setStatus('Save error: ' + e.message, 'error');
          }
        })();
      });
    }

    // Wire live preview — move marker on page as inputs change
    var pctXInput = document.getElementById('dbg-edit-pctX');
    var pctYInput = document.getElementById('dbg-edit-pctY');
    function onPositionInput() {
      var x = parseFloat(pctXInput.value);
      var y = parseFloat(pctYInput.value);
      if (!isNaN(x) && !isNaN(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100) {
        previewMarkerPosition(idx, x, y);
      }
    }
    if (pctXInput) pctXInput.addEventListener('input', onPositionInput);
    if (pctYInput) pctYInput.addEventListener('input', onPositionInput);

    // Wire verify click toggle + save (click steps only)
    var verifyCheckbox = document.getElementById('dbg-verify-enabled');
    var verifyOpts = document.getElementById('dbg-verify-opts');
    if (verifyCheckbox && verifyOpts) {
      verifyCheckbox.addEventListener('change', function() {
        verifyOpts.style.display = verifyCheckbox.checked ? '' : 'none';
      });
    }
    var saveVerifyBtn = document.getElementById('dbg-save-verify');
    if (saveVerifyBtn) {
      saveVerifyBtn.addEventListener('click', function() {
        var enabled = document.getElementById('dbg-verify-enabled').checked;
        var maxAttempts = parseInt(document.getElementById('dbg-verify-max').value, 10);
        var verifyDelayMs = parseInt(document.getElementById('dbg-verify-delay').value, 10);
        var retryDelayMs = parseInt(document.getElementById('dbg-verify-retry').value, 10);
        if (isNaN(maxAttempts) || maxAttempts < 1) maxAttempts = 3;
        if (isNaN(verifyDelayMs) || verifyDelayMs < 100) verifyDelayMs = 400;
        if (isNaN(retryDelayMs) || retryDelayMs < 100) retryDelayMs = 600;
        updateStepVerifyClick(idx, enabled, maxAttempts, verifyDelayMs, retryDelayMs);
      });
    }

    // Wire click type selector (click steps only)
    var clickTypeSelect = document.getElementById('dbg-click-type');
    if (clickTypeSelect) {
      // Hide verify section when hover is selected
      var verifySection = document.querySelector('.dbg-verify-section');
      if (verifySection && clickTypeSelect.value === 'hover') {
        verifySection.style.display = 'none';
      }
      clickTypeSelect.addEventListener('change', function() {
        if (verifySection) {
          verifySection.style.display = clickTypeSelect.value === 'hover' ? 'none' : '';
        }
        updateStepClickType(idx, clickTypeSelect.value);
      });
    }

    // Wire capture element button — reuse pick bounds if available
    var captureBtn = document.getElementById('dbg-capture-btn');
    if (captureBtn) {
      captureBtn.addEventListener('click', function() {
        var currentPctX = parseFloat((document.getElementById('dbg-edit-pctX') || {}).value);
        var currentPctY = parseFloat((document.getElementById('dbg-edit-pctY') || {}).value);
        if (isNaN(currentPctX)) currentPctX = (step && step.pctX != null) ? step.pctX : 50;
        if (isNaN(currentPctY)) currentPctY = (step && step.pctY != null) ? step.pctY : 50;
        var pickBounds = null;
        var pickDpr = null;
        if (lastPickData && lastPickData.stepIndex === idx) {
          pickBounds = lastPickData.elementBounds;
          pickDpr = lastPickData.dpr;
        }
        captureElement(idx, currentPctX, currentPctY, pickBounds, pickDpr);
      });
    }

    // Wire pick from page button
    var pickBtn = document.getElementById('dbg-pick-btn');
    if (pickBtn) {
      pickBtn.addEventListener('click', function() {
        pickBtn.textContent = '\uD83C\uDFAF Picking...';
        pickBtn.disabled = true;
        setStatus('Click on the target element in the page...', null);
        chrome.runtime.sendMessage({
          type: 'start_element_pick',
          stepIndex: idx
        });
      });
    }
    return;
  }

  // ── capture_download step: editable properties ──
  if (stepType === 'capture_download') {
    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Pattern</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="text" id="dbg-edit-pattern" value="' + escHtml(step.filenamePattern || '') + '" class="dbg-coord-input" placeholder="e.g., .*\\.mp3$" title="Filename regex pattern">';
    html += '</span></div>';

    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Max files</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="number" id="dbg-edit-maxfiles" value="' + (step.maxFiles || 1) + '" min="1" max="50" class="dbg-coord-input">';
    html += '</span></div>';

    var timeoutSec = step.waitTimeoutMs ? (step.waitTimeoutMs / 1000) : 60;
    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Timeout</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="number" id="dbg-edit-timeout" value="' + timeoutSec + '" step="5" min="5" max="600" class="dbg-coord-input">';
    html += '<span style="margin-left:2px;color:#64748b;font-size:0.6rem;">sec</span>';
    html += '</span></div>';

    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Variable</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="text" id="dbg-edit-outvar" value="' + escHtml(step.outputVariable || 'downloadedFiles') + '" class="dbg-coord-input" title="Output variable name">';
    html += '</span></div>';

    html += '<div class="dbg-coord-row"><button id="dbg-save-capture" class="dbg-save-btn">Save</button></div>';

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;

    var saveCaptureBtn = document.getElementById('dbg-save-capture');
    if (saveCaptureBtn) {
      saveCaptureBtn.addEventListener('click', function() {
        updateStepCaptureDownload(idx, {
          filenamePattern: document.getElementById('dbg-edit-pattern').value || undefined,
          maxFiles: parseInt(document.getElementById('dbg-edit-maxfiles').value, 10) || 1,
          waitTimeoutMs: (parseFloat(document.getElementById('dbg-edit-timeout').value) || 60) * 1000,
          outputVariable: document.getElementById('dbg-edit-outvar').value || 'downloadedFiles',
        });
      });
    }
    return;
  }

  // ── move_file step: editable source/destination ──
  if (stepType === 'move_file') {
    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Source</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="text" id="dbg-edit-source" value="' + escHtml(step.source || '') + '" class="dbg-coord-input" placeholder="{{downloadedFiles}} or path" title="Source path or variable">';
    html += '</span></div>';

    html += '<div class="dbg-coord-row dbg-coord-edit-row">';
    html += '<span class="dbg-coord-label">Destination</span>';
    html += '<span class="dbg-coord-value dbg-coord-edit">';
    html += '<input type="text" id="dbg-edit-dest" value="' + escHtml(step.destination || '') + '" class="dbg-coord-input" placeholder="/path/to/destination/" title="Destination path">';
    html += '</span></div>';

    html += '<div class="dbg-coord-row"><button id="dbg-save-move" class="dbg-save-btn">Save</button></div>';

    if (data.stepResult && data.stepResult.error) {
      html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
    }
    coordEl.innerHTML = html;

    var saveMoveBtn = document.getElementById('dbg-save-move');
    if (saveMoveBtn) {
      saveMoveBtn.addEventListener('click', function() {
        updateStepMoveFile(idx, {
          source: document.getElementById('dbg-edit-source').value,
          destination: document.getElementById('dbg-edit-dest').value,
        });
      });
    }
    return;
  }

  // ── Navigate/other steps: show info only ──
  if (data.stepResult && data.stepResult.error) {
    html += '<div class="dbg-coord-error">' + escHtml(data.stepResult.error) + '</div>';
  }
  if (!data.stepResult) {
    html += '<div style="color:#475569;font-style:italic;font-size:0.7rem;">No editable properties for this step type</div>';
  }
  coordEl.innerHTML = html;
}

function setStatus(text, type) {
  var el = document.getElementById('dbg-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'dbg-status';
  if (type === 'success') el.className += ' dbg-status-success';
  if (type === 'error') el.className += ' dbg-status-error';
}

/* ── Actions ───────────────────────────────────────────── */

var _previewTimer = null;
function previewMarkerPosition(stepIndex, pctX, pctY) {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(function() {
    chrome.runtime.sendMessage({
      type: 'update_debug_marker',
      stepIndex: stepIndex,
      pctX: pctX,
      pctY: pctY,
    }).catch(function() {});
  }, 50);
}

async function updateStepPosition(stepIndex, pctX, pctY) {
  if (!apiBaseUrl || !workflowId) return;

  var saveBtn = document.getElementById('dbg-save-pos');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '...'; }
  setStatus('Saving position...', null);

  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: stepIndex, pctX: pctX, pctY: pctY }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    // Update local step data
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].pctX = pctX;
      debugState.steps[stepIndex].pctY = pctY;
    }

    // Tell background.js to move the marker on the page
    chrome.runtime.sendMessage({
      type: 'update_debug_marker',
      stepIndex: stepIndex,
      pctX: pctX,
      pctY: pctY,
    }).catch(function() {});

    setStatus('Step ' + (stepIndex + 1) + ' position updated', 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

async function updateStepWaitTime(stepIndex, ms) {
  if (!apiBaseUrl || !workflowId) return;

  var saveBtn = document.getElementById('dbg-save-wait');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '...'; }
  setStatus('Saving wait time...', null);

  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: stepIndex, waitMs: ms }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    // Update local step data
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].waitMs = ms;
      // Update the label to reflect new duration
      var secs = (ms / 1000).toFixed(1);
      debugState.steps[stepIndex].label = 'Wait ' + secs + 's';
      // Update the label in the step list UI
      var stepEl = document.querySelector('#dbg-step-list .dbg-step[data-idx="' + stepIndex + '"] .dbg-step-label');
      if (stepEl) stepEl.textContent = 'Wait ' + secs + 's';
      // Update the title in the coord panel
      var titleEl = document.querySelector('#dbg-coord .dbg-coord-title');
      if (titleEl) titleEl.textContent = 'Step ' + (stepIndex + 1) + ' \u2014 Wait ' + secs + 's';
    }

    setStatus('Step ' + (stepIndex + 1) + ' wait time updated', 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

async function updateStepVerifyClick(stepIndex, enabled, maxAttempts, verifyDelayMs, retryDelayMs) {
  if (!apiBaseUrl || !workflowId) return;

  var saveBtn = document.getElementById('dbg-save-verify');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '...'; }
  setStatus('Saving verify settings...', null);

  var verifyClick = enabled ? {
    enabled: true,
    maxAttempts: maxAttempts,
    verifyDelayMs: verifyDelayMs,
    retryDelayMs: retryDelayMs,
  } : null;

  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: stepIndex, verifyClick: verifyClick }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    // Update local step data
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].verifyClick = data.verifyClick || null;
    }

    setStatus('Step ' + (stepIndex + 1) + ' verify settings updated', 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save verify'; }
  }
}

async function updateStepClickType(stepIndex, clickType) {
  if (!apiBaseUrl || !workflowId) return;

  setStatus('Saving click type...', null);

  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: stepIndex, clickType: clickType }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    // Update local step data
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].clickType = clickType;
      // Update step icon in the list
      var stepEl = document.querySelector('#dbg-step-list .dbg-step[data-idx="' + stepIndex + '"]');
      if (stepEl) {
        var iconEl = stepEl.querySelector('.dbg-step-icon');
        if (iconEl) {
          iconEl.textContent = clickType === 'hover' ? '\u2197' : '\uD83D\uDDB1';
        }
      }
    }

    setStatus('Step ' + (stepIndex + 1) + ' action updated to ' + (clickType === 'hover' ? 'Hover / Move' : clickType), 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  }
}

async function captureElement(stepIndex, pctX, pctY, elementBounds, dpr, screenshotDataUrl) {
  if (!apiBaseUrl || !workflowId) return;

  var captureBtn = document.getElementById('dbg-capture-btn');
  var resultDiv = document.getElementById('dbg-capture-result');
  if (captureBtn) { captureBtn.disabled = true; captureBtn.textContent = '\u23f3 Capturing...'; }
  if (resultDiv) resultDiv.innerHTML = '';
  setStatus('Capturing element...', null);

  try {
    var reqBody = { stepIndex: stepIndex, pctX: pctX, pctY: pctY };
    if (elementBounds) reqBody.elementBounds = elementBounds;
    if (dpr) reqBody.dpr = dpr;
    if (screenshotDataUrl) reqBody.screenshotDataUrl = screenshotDataUrl;
    // Read padding from the UI control
    var paddingInput = document.getElementById('dbg-capture-padding');
    if (paddingInput) {
      var padVal = parseInt(paddingInput.value, 10);
      if (!isNaN(padVal) && padVal >= 0) reqBody.padding = padVal;
    }
    var res = await fetch(
      apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/capture-element',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      }
    );
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Capture failed');

    // Update local step data
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].hasReferenceImage = true;
    }

    // Cache picked bounds from response for future re-captures
    if (data.pickedBounds) {
      lastPickData = { stepIndex: stepIndex, elementBounds: data.pickedBounds, dpr: data.pickedDpr || 1 };
    }

    // Show preview
    if (resultDiv) {
      var previewHtml = '<div class="dbg-capture-preview">';
      if (data.elementCrop) {
        previewHtml += '<img src="' + data.elementCrop + '" alt="Captured element">';
      }
      if (data.elementInfo) {
        previewHtml += '<div class="dbg-capture-info">';
        previewHtml += escHtml(data.elementInfo.tag || '');
        if (data.elementInfo.text) {
          previewHtml += ' \u2014 "' + escHtml(data.elementInfo.text.slice(0, 60)) + '"';
        }
        previewHtml += '</div>';
      }
      previewHtml += '<div class="dbg-capture-success">\u2705 Reference saved</div>';
      if (data.expectedBounds) {
        previewHtml += '<div class="dbg-capture-info">';
        previewHtml += Math.round(data.expectedBounds.width) + '\u00d7' + Math.round(data.expectedBounds.height) + 'px';
        if (data.matchedByFallback) {
          previewHtml += ' (nearest element)';
        }
        previewHtml += '</div>';
      }
      previewHtml += '</div>';
      resultDiv.innerHTML = previewHtml;
    }

    // Update button state
    if (captureBtn) {
      captureBtn.textContent = '\uD83D\uDCF7 Re-capture Element';
      captureBtn.className = 'dbg-capture-btn dbg-capture-has-ref';
    }

    // Hide the "existing" hint if present (it's now replaced by the live preview)
    var existingHint = document.getElementById('dbg-capture-existing');
    if (existingHint) existingHint.style.display = 'none';

    setStatus('Element captured for step ' + (stepIndex + 1), 'success');
  } catch (err) {
    if (resultDiv) {
      resultDiv.innerHTML = '<div class="dbg-capture-info" style="color:#ef4444;">\u274c ' + escHtml(err.message) + '</div>';
    }
    setStatus('Capture error: ' + err.message, 'error');
  } finally {
    if (captureBtn) { captureBtn.disabled = false; }
  }
}

async function updateStepCaptureDownload(stepIndex, fields) {
  if (!apiBaseUrl || !workflowId) return;
  setStatus('Saving capture settings...', null);
  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepIndex: stepIndex,
        filenamePattern: fields.filenamePattern,
        maxFiles: fields.maxFiles,
        waitTimeoutMs: fields.waitTimeoutMs,
        outputVariable: fields.outputVariable,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].filenamePattern = fields.filenamePattern;
      debugState.steps[stepIndex].maxFiles = fields.maxFiles;
      debugState.steps[stepIndex].waitTimeoutMs = fields.waitTimeoutMs;
      debugState.steps[stepIndex].outputVariable = fields.outputVariable;
    }
    setStatus('Step ' + (stepIndex + 1) + ' capture settings saved', 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  }
}

async function updateStepMoveFile(stepIndex, fields) {
  if (!apiBaseUrl || !workflowId) return;
  setStatus('Saving move settings...', null);
  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/update-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepIndex: stepIndex,
        source: fields.source,
        destination: fields.destination,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    if (debugState && debugState.steps[stepIndex]) {
      debugState.steps[stepIndex].source = fields.source;
      debugState.steps[stepIndex].destination = fields.destination;
    }
    setStatus('Step ' + (stepIndex + 1) + ' move paths saved', 'success');
  } catch (err) {
    setStatus('Save error: ' + err.message, 'error');
  }
}

async function debugNextStep(skipToggle) {
  if (!debugState || !apiBaseUrl || !workflowId || stepping) return;
  stepping = true;

  var nextBtn = document.getElementById('dbg-btn-next');
  if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = '\u23f3 Running...'; }

  // When called from Run All (skipToggle=true), execute inline without closing panel
  if (skipToggle) {
    setStatus('Executing step...', null);
    return await debugNextStepInline();
  }

  setStatus('Closing panel & executing step...', null);

  // Send the step execution to background.js which orchestrates:
  // close panel → wait → execute step → wait → reopen panel
  // The sidepanel JS context dies when panel closes, so background handles everything.
  // When panel reopens, it picks up the result via get_pending_step_result.
  try {
    await chrome.runtime.sendMessage({
      type: 'debug_step_with_toggle',
      apiBaseUrl: apiBaseUrl,
      workflowId: workflowId,
    });
  } catch (e) {
    // If the message fails, fall back to executing without toggle
    console.log('[Woodbury Debug Panel] Toggle step failed, executing inline:', e.message);
    return await debugNextStepInline();
  }
  // Panel will close now — this JS context will be destroyed.
  // When it reopens, DOMContentLoaded will check for pending step result.
}

// Fallback: execute step without closing/reopening the panel
async function debugNextStepInline() {
  var nextBtn = document.getElementById('dbg-btn-next');

  try {
    var res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Step failed');

    return processStepResult(data);
  } catch (err) {
    setStatus('Step error: ' + err.message, 'error');
    return false;
  } finally {
    stepping = false;
    if (nextBtn && !nextBtn.textContent.includes('Done')) {
      nextBtn.disabled = false;
      nextBtn.textContent = '\u25b6 Next Step';
    }
  }
}

// Shared logic: process a step result (used by both inline and toggle flows)
function processStepResult(data) {
  var idx = data.stepIndex;
  var isSkipped = data.stepResult && data.stepResult.status === 'skipped';

  // Update local state
  if (debugState) {
    if (data.stepResult && (data.stepResult.status === 'success' || data.stepResult.status === 'skipped')) {
      if (!debugState.completedIndices.includes(idx)) {
        debugState.completedIndices.push(idx);
      }
    } else {
      if (!debugState.failedIndices.includes(idx)) {
        debugState.failedIndices.push(idx);
      }
    }
    if (data.hasMore) {
      debugState.currentIndex = data.nextIndex;
    }
    // Store step result for persistence (survives side panel close/reopen)
    if (!debugState.stepResults) debugState.stepResults = [];
    debugState.stepResults[idx] = {
      stepIndex: idx,
      coordinateInfo: data.coordinateInfo || null,
      status: data.stepResult?.status || null,
      error: data.stepResult?.error || null,
      visualVerification: data.visualVerification || null,
      stepDetail: data.stepDetail || null,
    };
  }

  // Update UI
  updateMarkersUI();

  // For skipped control-flow markers, auto-advance to next step
  if (isSkipped && data.hasMore) {
    var nextStepEl = document.querySelector('#dbg-step-list .dbg-step[data-idx="' + data.nextIndex + '"]');
    if (nextStepEl) nextStepEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setStatus('Skipped control flow marker (step ' + (idx + 1) + ')', null);
    return true;
  }

  updateCoordInfo(data);

  var nextBtn = document.getElementById('dbg-btn-next');
  if (data.hasMore) {
    var nextStepEl = document.querySelector('#dbg-step-list .dbg-step[data-idx="' + data.nextIndex + '"]');
    if (nextStepEl) nextStepEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  if (!data.hasMore) {
    if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = '\u2705 Done'; }
    setStatus('Debug complete \u2014 all steps executed', 'success');
    return false;
  }

  setStatus('Step ' + (idx + 1) + ' complete', 'success');
  if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = '\u25b6 Next Step'; }
  stepping = false;
  return true;
}

async function debugRunAll() {
  if (!debugState || runningAll) return;
  runningAll = true;

  var runAllBtn = document.getElementById('dbg-btn-run-all');
  var nextBtn = document.getElementById('dbg-btn-next');
  if (runAllBtn) { runAllBtn.disabled = true; runAllBtn.textContent = '\u23f3 Running...'; }
  if (nextBtn) { nextBtn.disabled = true; }

  var maxSteps = debugState.steps.length;
  for (var i = 0; i < maxSteps; i++) {
    if (!debugState || !runningAll) break;
    var hasMore = await debugNextStep(true);
    if (!hasMore) break;
    // Delay between steps
    await new Promise(function(resolve) { setTimeout(resolve, 500); });
  }

  runningAll = false;
  if (runAllBtn) { runAllBtn.disabled = true; runAllBtn.textContent = '\u2705 Done'; }
}

async function exitDebugMode() {
  if (!apiBaseUrl || !workflowId) return;
  setStatus('Exiting debug mode...', null);

  try {
    await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/exit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.log('[Woodbury Debug Panel] Exit error:', err.message);
  }

  // background.js will send debug_ended which triggers renderEmptyState
  debugState = null;
  apiBaseUrl = null;
  workflowId = null;
  stepping = false;
  runningAll = false;
  renderEmptyState();
}
