/**
 * Training Dashboard — Client-side JavaScript
 *
 * Manages model training: data summary, preparation, configuration,
 * live progress tracking with loss chart, and model listing.
 * Loaded alongside app.js in the same SPA.
 */

// ── State ────────────────────────────────────────────────────
let trainingPollInterval = null;
let trainingLossHistory = [];
let trainingModels = [];

// ── API ──────────────────────────────────────────────────────

async function fetchTrainingDataSummary() {
  const res = await fetch('/api/training/data-summary');
  if (!res.ok) throw new Error('Failed to load data summary');
  return res.json();
}

async function fetchTrainingStatus() {
  const res = await fetch('/api/training/status');
  if (!res.ok) throw new Error('Failed to poll status');
  return res.json();
}

async function fetchTrainingModels() {
  const res = await fetch('/api/training/models');
  if (!res.ok) throw new Error('Failed to load models');
  return res.json();
}

async function startTrainingPrepare(source, cropsPerElement) {
  const res = await fetch('/api/training/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source || 'viewport', cropsPerElement: cropsPerElement || 10 }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Prepare failed');
  }
  return res.json();
}

async function startTrainingRun(config) {
  const res = await fetch('/api/training/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Start failed');
  }
  return res.json();
}

async function cancelTraining() {
  const res = await fetch('/api/training/cancel', { method: 'POST' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Cancel failed');
  }
  return res.json();
}

// Worker API
async function fetchWorkers() {
  const res = await fetch('/api/workers');
  if (!res.ok) throw new Error('Failed to load workers');
  return res.json();
}

async function addWorker(name, host, port) {
  const res = await fetch('/api/workers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, host, port }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to add worker');
  }
  return res.json();
}

async function removeWorker(id) {
  const res = await fetch('/api/workers/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove worker');
  return res.json();
}

// ── Init ─────────────────────────────────────────────────────

function initTraining() {
  const main = document.querySelector('#main');
  main.innerHTML =
    '<div class="empty-state">' +
    '<div class="empty-state-icon">&#x1f9e0;</div>' +
    '<h2>Model Training ' + helpIcon('training-what') + '</h2>' +
    '<p>Train visual recognition models on captured UI element data.</p>' +
    '</div>';

  loadTrainingSidebar();
  loadTrainingMain();
}

// ── Sidebar ──────────────────────────────────────────────────

async function loadTrainingSidebar() {
  const list = document.querySelector('#training-list');
  list.innerHTML = '<div style="padding:0.75rem;color:#64748b;font-size:0.75rem;">Loading models...</div>';

  try {
    const data = await fetchTrainingModels();
    trainingModels = data.models || [];

    let html = '<div class="training-sidebar-item active" data-action="new">' +
      '<div class="training-sidebar-name">+ New Training Run</div>' +
      '<div class="training-sidebar-meta">Configure and start training</div>' +
      '</div>';

    for (const m of trainingModels.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const hasModel = m.hasBestModel || m.hasFinalModel;
      const date = new Date(m.createdAt).toLocaleDateString();
      html += '<div class="training-sidebar-item" data-model-id="' + escAttr(m.id) + '">' +
        '<div class="training-sidebar-name">' + escHtml(m.id) + '</div>' +
        '<div class="training-sidebar-meta">' + date + '</div>' +
        '<div>' +
          (hasModel ? '<span class="training-sidebar-badge badge-auc">Model</span> ' : '') +
          (m.hasOnnx ? '<span class="training-sidebar-badge badge-auc">Exported</span> ' : '') +
        '</div>' +
      '</div>';
    }

    list.innerHTML = html;

    // Click handlers
    list.querySelectorAll('.training-sidebar-item').forEach(el => {
      el.addEventListener('click', () => {
        list.querySelectorAll('.training-sidebar-item').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        if (el.dataset.action === 'new') {
          loadTrainingMain();
        } else if (el.dataset.modelId) {
          showModelDetail(el.dataset.modelId);
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div style="padding:0.75rem;color:#ef4444;font-size:0.75rem;">Failed to load models.</div>';
  }
}

// ── Model Detail ─────────────────────────────────────────────

function showModelDetail(modelId) {
  const model = trainingModels.find(m => m.id === modelId);
  if (!model) return;

  const main = document.querySelector('#main');
  let html = '<div class="ext-header"><h2>Model: ' + escHtml(model.id) + '</h2></div>';

  html += '<div class="training-section"><h3>Files</h3>';
  html += '<div style="font-size:0.8rem; color:#94a3b8;">';
  for (const f of model.files) {
    const icon = f.endsWith('.pt') ? '&#x1f9e0;' :
                 f.endsWith('.onnx') ? '&#x26a1;' :
                 f.endsWith('.yaml') ? '&#x2699;' : '&#x1f4c4;';
    html += '<div style="padding:0.2rem 0;">' + icon + ' ' + escHtml(f) + '</div>';
  }
  html += '</div>';
  html += '<div style="margin-top:0.5rem;font-size:0.7rem;color:#475569;">' + escHtml(model.dir) + '</div>';
  html += '</div>';

  main.innerHTML = html;
}

// ── Main Training View ───────────────────────────────────────

async function loadTrainingMain() {
  const main = document.querySelector('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  // Check if there's an active training first
  try {
    const status = await fetchTrainingStatus();
    if (status.active) {
      renderTrainingProgress(status);
      startPolling();
      return;
    }
  } catch {}

  // Load data summary + render config form
  try {
    const summary = await fetchTrainingDataSummary();
    renderTrainingConfig(summary);
  } catch (err) {
    main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div>' +
      '<h2>Error</h2><p>' + escHtml(err.message) + '</p></div>';
  }
}

function renderTrainingConfig(summary) {
  const main = document.querySelector('#main');
  let html = '<div class="ext-header"><h2>Model Training' + helpIcon('training-what') + '</h2></div>';

  // Data Summary
  html += '<div class="training-section"><h3>Training Data' + helpIcon('training-data') + '</h3>';
  if (summary.hasMetadata && summary.totalCrops > 0) {
    html += '<div class="training-stats">';
    html += statCard(summary.totalCrops, 'Crops');
    html += statCard(summary.uniqueGroups, 'Groups');
    html += statCard(summary.uniqueSites, 'Sites');
    html += statCard(summary.interactedGroups, 'Interacted');
    html += '</div>';
  } else if (summary.hasSnapshots) {
    html += '<div style="color:#94a3b8;font-size:0.85rem;margin-bottom:0.75rem;">' +
      'Snapshots found but no crops prepared yet. Click "Prepare Data" to process snapshots into training crops.</div>';
  } else {
    html += '<div style="color:#94a3b8;font-size:0.85rem;">' +
      'No training data found. Record workflows with the Woodbury extension to capture UI element data.</div>';
  }

  if (summary.hasSnapshots) {
    html += '<div class="training-actions" style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">';
    html += '<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;color:#94a3b8;">' +
      'Crops per element <input type="number" id="crops-per-element" value="10" min="1" max="50" ' +
      'style="width:60px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#e2e8f0;padding:4px 6px;font-size:0.85rem;" />' +
      '</label>';
    html += '<button class="btn-train btn-train-prepare" id="btn-prepare">Prepare Data</button>';
    html += '</div>';
  }
  html += '</div>';

  // Config Form
  html += '<div class="training-section"><h3>Configuration' + helpIcon('training-config') + '</h3>';
  html += '<div class="training-form">';

  html += '<label>Architecture' +
    '<select id="train-backbone">' +
    '<option value="mobilenet_v3_small" selected>MobileNet V3 Small (1.0M params, fastest)</option>' +
    '<option value="efficientnet_b0">EfficientNet B0 (4.1M params, balanced)</option>' +
    '<option value="resnet18">ResNet-18 (11.2M params, most robust)</option>' +
    '</select></label>';

  html += '<label>Training Rounds' +
    '<input type="number" id="train-epochs" value="50" min="5" max="500">' +
    '</label>';

  html += '<label>Learning Rate' +
    '<input type="number" id="train-lr" value="0.0003" step="0.0001" min="0.00001" max="0.01">' +
    '</label>';

  html += '<label>Training Method' +
    '<select id="train-loss">' +
    '<option value="ntxent" selected>Standard (recommended)</option>' +
    '<option value="arcface">ArcFace (higher accuracy, slower)</option>' +
    '<option value="triplet">Triplet (simple comparisons)</option>' +
    '<option value="contrastive">Contrastive (pair-based)</option>' +
    '</select></label>';

  html += '<label>Model Precision' +
    '<select id="train-embed-dim">' +
    '<option value="64" selected>Standard (64)</option>' +
    '<option value="128">High (128)</option>' +
    '<option value="256">Maximum (256)</option>' +
    '</select></label>';

  html += '<label>Auto-export for browser' +
    '<select id="train-export-onnx">' +
    '<option value="true" selected>Yes (ready to use after training)</option>' +
    '<option value="false">No (training only)</option>' +
    '</select></label>';

  html += '</div>';

  // Workers section
  html += '<div class="training-section"><h3>Workers' + helpIcon('training-workers') + '</h3>';
  html += '<div id="workers-list" style="margin-bottom:0.75rem;"><div style="color:#64748b;font-size:0.8rem;">Loading workers...</div></div>';
  html += '<div id="worker-add-form" style="display:none;margin-bottom:0.75rem;">';
  html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">';
  html += '<input type="text" id="worker-name" placeholder="Name" style="flex:1;min-width:80px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#e2e8f0;padding:4px 8px;font-size:0.85rem;" />';
  html += '<input type="text" id="worker-host" placeholder="IP / hostname" style="flex:1;min-width:120px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#e2e8f0;padding:4px 8px;font-size:0.85rem;" />';
  html += '<input type="number" id="worker-port" placeholder="8677" value="8677" style="width:70px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#e2e8f0;padding:4px 8px;font-size:0.85rem;" />';
  html += '<button class="btn-train" id="btn-worker-save" style="padding:4px 12px;font-size:0.8rem;">Add</button>';
  html += '<button class="btn-train" id="btn-worker-cancel-add" style="padding:4px 12px;font-size:0.8rem;background:#334155;">Cancel</button>';
  html += '</div></div>';
  html += '<button class="btn-train" id="btn-add-worker" style="padding:4px 12px;font-size:0.8rem;background:#334155;">+ Add Worker</button>';
  html += '</div>';

  // Train on selector
  html += '<div class="training-section"><h3>Train On' + helpIcon('training-train-on') + '</h3>';
  html += '<div id="train-target" class="training-form">';
  html += '<label style="display:flex;align-items:center;gap:0.5rem;">' +
    '<input type="radio" name="train-target" value="local" checked /> ' +
    '<span>Local (this machine)</span></label>';
  html += '</div></div>';

  // Start button
  html += '<div class="training-actions">';
  const canTrain = summary.hasMetadata && summary.totalCrops > 0;
  html += '<button class="btn-train btn-train-start" id="btn-start-training"' +
    (canTrain ? '' : ' disabled title="Prepare training data first"') +
    '>Start Training</button>';
  html += '</div>';
  html += '</div>';

  main.innerHTML = html;
  loadWorkersSection();

  // Wire up prepare button
  const prepareBtn = document.querySelector('#btn-prepare');
  if (prepareBtn) {
    prepareBtn.addEventListener('click', async () => {
      prepareBtn.disabled = true;
      prepareBtn.textContent = 'Preparing...';
      try {
        const cropsPerEl = parseInt(document.querySelector('#crops-per-element')?.value) || 10;
        await startTrainingPrepare('viewport', cropsPerEl);
        // Poll until done
        const pollPrep = setInterval(async () => {
          try {
            const s = await fetchTrainingStatus();
            if (s.done || !s.active) {
              clearInterval(pollPrep);
              if (typeof toast === 'function') {
                toast(s.success ? 'Data prepared successfully' : 'Preparation failed', s.success ? 'success' : 'error');
              }
              loadTrainingMain();
            }
          } catch {
            clearInterval(pollPrep);
            loadTrainingMain();
          }
        }, 1000);
      } catch (err) {
        if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
        prepareBtn.disabled = false;
        prepareBtn.textContent = 'Prepare Data';
      }
    });
  }

  // Wire up start button
  const startBtn = document.querySelector('#btn-start-training');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
      try {
        const targetRadio = document.querySelector('input[name="train-target"]:checked');
        const targetValue = targetRadio ? targetRadio.value : 'local';
        const config = {
          backbone: document.querySelector('#train-backbone').value,
          epochs: parseInt(document.querySelector('#train-epochs').value) || 50,
          lr: parseFloat(document.querySelector('#train-lr').value) || 3e-4,
          lossType: document.querySelector('#train-loss').value,
          embedDim: parseInt(document.querySelector('#train-embed-dim').value) || 64,
          exportOnnx: document.querySelector('#train-export-onnx').value === 'true',
          workerId: targetValue !== 'local' ? targetValue : undefined,
        };
        await startTrainingRun(config);
        trainingLossHistory = [];
        startPolling();
      } catch (err) {
        if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
        startBtn.disabled = false;
        startBtn.textContent = 'Start Training';
      }
    });
  }
}

// ── Workers ─────────────────────────────────────────────────

async function loadWorkersSection() {
  const listEl = document.querySelector('#workers-list');
  const trainTarget = document.querySelector('#train-target');
  if (!listEl) return;

  try {
    const data = await fetchWorkers();
    const workers = data.workers || [];

    if (workers.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b;font-size:0.8rem;">No workers configured. Add a remote machine to train on its GPU.</div>';
    } else {
      let html = '';
      for (const w of workers) {
        const statusBadge = w.online
          ? (w.status === 'busy'
            ? '<span class="worker-badge worker-busy">Busy</span>'
            : '<span class="worker-badge worker-online">Online</span>')
          : '<span class="worker-badge worker-offline">Offline</span>';
        const gpuInfo = w.gpu ? escHtml(w.gpu) : 'CPU';
        html += '<div class="worker-card">';
        html += '<div class="worker-card-header">';
        html += '<strong>' + escHtml(w.name) + '</strong> ' + statusBadge;
        html += '<button class="worker-remove-btn" data-worker-id="' + escAttr(w.id) + '" title="Remove">&times;</button>';
        html += '</div>';
        html += '<div class="worker-card-detail">' + escHtml(w.host) + ':' + w.port + ' &middot; ' + gpuInfo + '</div>';
        html += '</div>';

        // Add to train-target radio list
        if (trainTarget && w.online && w.status !== 'busy') {
          const radioHtml = '<label style="display:flex;align-items:center;gap:0.5rem;">' +
            '<input type="radio" name="train-target" value="' + escAttr(w.id) + '" /> ' +
            '<span>' + escHtml(w.name) + ' (' + gpuInfo + ')</span></label>';
          trainTarget.insertAdjacentHTML('beforeend', radioHtml);
        }
      }
      listEl.innerHTML = html;

      // Wire remove buttons
      listEl.querySelectorAll('.worker-remove-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const wId = btn.dataset.workerId;
          try {
            await removeWorker(wId);
            if (typeof toast === 'function') toast('Worker removed', 'success');
            loadTrainingMain(); // Refresh
          } catch (err) {
            if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
          }
        });
      });
    }
  } catch (err) {
    listEl.innerHTML = '<div style="color:#ef4444;font-size:0.8rem;">Failed to load workers.</div>';
  }

  // Wire add worker button
  const addBtn = document.querySelector('#btn-add-worker');
  const addForm = document.querySelector('#worker-add-form');
  if (addBtn && addForm) {
    addBtn.addEventListener('click', () => {
      addForm.style.display = 'block';
      addBtn.style.display = 'none';
    });
  }

  const cancelAddBtn = document.querySelector('#btn-worker-cancel-add');
  if (cancelAddBtn && addForm && addBtn) {
    cancelAddBtn.addEventListener('click', () => {
      addForm.style.display = 'none';
      addBtn.style.display = '';
    });
  }

  const saveBtn = document.querySelector('#btn-worker-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const name = document.querySelector('#worker-name').value.trim();
      const host = document.querySelector('#worker-host').value.trim();
      const port = parseInt(document.querySelector('#worker-port').value) || 8677;
      if (!name || !host) {
        if (typeof toast === 'function') toast('Name and host are required', 'error');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Connecting...';
      try {
        await addWorker(name, host, port);
        if (typeof toast === 'function') toast('Worker added', 'success');
        loadTrainingMain(); // Refresh
      } catch (err) {
        if (typeof toast === 'function') toast(err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add';
      }
    });
  }
}

function statCard(value, label) {
  return '<div class="training-stat">' +
    '<div class="training-stat-value">' + value + '</div>' +
    '<div class="training-stat-label">' + label + '</div>' +
    '</div>';
}

// ── Progress View ────────────────────────────────────────────

function renderTrainingProgress(status) {
  const main = document.querySelector('#main');
  const pct = status.totalEpochs > 0 ? Math.round((status.currentEpoch / status.totalEpochs) * 100) : 0;

  let html = '<div class="ext-header"><h2>Training in Progress</h2>';
  if (status.backbone) {
    html += '<div class="ext-header-meta">' + escHtml(status.backbone) + ' &middot; ' +
      escHtml(status.lossType || 'ntxent') + ' &middot; ' +
      (status.embedDim || 128) + 'd';
    if (status.worker) {
      html += ' &middot; <span class="worker-badge worker-online" style="font-size:0.7rem;">' +
        escHtml(status.worker.name) + ' (' + escHtml(status.worker.host) + ')</span>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Progress bar
  html += '<div class="training-section">';
  html += '<div class="training-progress">';

  let barClass = 'training-progress-bar-fill';
  if (status.done && status.success) barClass += ' done-success';
  else if (status.done && !status.success) barClass += ' done-fail';

  html += '<div class="training-progress-bar-outer">';
  html += '<div class="' + barClass + '" style="width:' + pct + '%"></div>';
  html += '<div class="training-progress-bar-text">';
  if (status.phase === 'preparing') {
    html += 'Preparing data...';
  } else if (status.done) {
    html += status.success ? 'Complete' : 'Failed';
  } else {
    html += 'Epoch ' + status.currentEpoch + ' / ' + status.totalEpochs + ' (' + pct + '%)';
  }
  html += '</div></div>';

  // Stats row
  html += '<div class="training-stats-row">';
  if (status.phase !== 'preparing') {
    html += '<span>Loss: <strong>' + (status.loss || 0).toFixed(4) + '</strong></span>';
    html += '<span>LR: <strong>' + (status.lr || 0).toFixed(6) + '</strong></span>';
    if (status.eta_s > 0) {
      html += '<span>ETA: <strong>' + formatTime(status.eta_s) + '</strong></span>';
    }
    if (status.bestAuc > 0) {
      html += '<span>Best AUC: <strong>' + status.bestAuc.toFixed(4) + '</strong></span>';
    }
  }
  if (status.durationMs) {
    html += '<span>Duration: <strong>' + formatTime(status.durationMs / 1000) + '</strong></span>';
  }
  html += '</div>';
  html += '</div>';

  // Data info
  if (status.trainSamples) {
    html += '<div class="training-stats" style="margin-top:0.75rem;">';
    html += statCard(status.trainSamples, 'Train Samples');
    html += statCard(status.valSamples || 0, 'Val Samples');
    html += statCard(status.groups || 0, 'Groups');
    html += statCard(status.device || 'cpu', 'Device');
    html += '</div>';
  }
  html += '</div>';

  // Loss chart
  if (trainingLossHistory.length > 1) {
    html += '<div class="training-section"><h3>Loss</h3>';
    html += '<div class="training-chart">' + renderLossChart(trainingLossHistory) + '</div>';
    html += '</div>';
  }

  // Validation metrics
  if (status.metrics && Object.keys(status.metrics).length > 0) {
    html += '<div class="training-section"><h3>Validation Metrics</h3>';
    html += '<table class="training-metrics-table"><thead><tr>';
    html += '<th>Metric</th><th>Value</th>';
    html += '</tr></thead><tbody>';
    const metricLabels = {
      'roc_auc': 'ROC AUC',
      'pr_auc': 'PR AUC',
      'eer': 'EER',
      'eer_threshold': 'EER Threshold',
      'tar@fmr=0.001': 'TAR@FMR=1e-3',
      'tar@fmr=0.0001': 'TAR@FMR=1e-4',
      'best_auc': 'Best AUC',
      'saved_best': 'Saved Best',
    };
    for (const [k, v] of Object.entries(status.metrics)) {
      if (k === 'saved_best' && v === false) continue;
      const label = metricLabels[k] || k;
      const val = typeof v === 'number' ? v.toFixed(4) : String(v);
      html += '<tr><td>' + escHtml(label) + '</td><td>' + escHtml(val) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  // Error
  if (status.error) {
    html += '<div class="training-section" style="border-color:#ef4444;">';
    html += '<h3 style="color:#ef4444;">Error</h3>';
    html += '<div style="font-size:0.85rem;color:#f87171;">' + escHtml(status.error) + '</div>';
    html += '</div>';
  }

  // Log output
  if (status.logs && status.logs.length > 0) {
    html += '<div class="training-section"><h3>Logs</h3>';
    html += '<div class="training-log" id="training-log">';
    html += escHtml(status.logs.join('\n'));
    html += '</div></div>';
  }

  // Actions
  html += '<div class="training-actions">';
  if (!status.done) {
    html += '<button class="btn-train btn-train-cancel" id="btn-cancel-training">Cancel</button>';
  } else {
    html += '<button class="btn-train btn-train-start" id="btn-new-training">New Training Run</button>';
  }
  html += '</div>';

  main.innerHTML = html;

  // Auto-scroll log
  const logEl = document.querySelector('#training-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;

  // Wire cancel button
  const cancelBtn = document.querySelector('#btn-cancel-training');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await cancelTraining();
        if (typeof toast === 'function') toast('Training cancelled', 'success');
      } catch (err) {
        if (typeof toast === 'function') toast('Failed: ' + err.message, 'error');
      }
    });
  }

  // Wire new training button
  const newBtn = document.querySelector('#btn-new-training');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      stopPolling();
      trainingLossHistory = [];
      loadTrainingMain();
      loadTrainingSidebar();
    });
  }
}

// ── Loss Chart (SVG) ─────────────────────────────────────────

function renderLossChart(data) {
  if (data.length < 2) return '';

  const w = 500;
  const h = 100;
  const pad = { top: 5, right: 10, bottom: 5, left: 40 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const minY = Math.min(...data);
  const maxY = Math.max(...data);
  const rangeY = maxY - minY || 1;

  const points = data.map((v, i) => {
    const x = pad.left + (i / (data.length - 1)) * plotW;
    const y = pad.top + (1 - (v - minY) / rangeY) * plotH;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  // Fill area under curve
  const firstX = pad.left;
  const lastX = pad.left + plotW;
  const bottomY = pad.top + plotH;
  const areaPoints = pad.left.toFixed(1) + ',' + bottomY + ' ' + points + ' ' + lastX.toFixed(1) + ',' + bottomY;

  let svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">';

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * plotH;
    const val = maxY - (i / 4) * rangeY;
    svg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (w - pad.right) + '" y2="' + y.toFixed(1) + '" stroke="#334155" stroke-width="0.5"/>';
    svg += '<text x="' + (pad.left - 4) + '" y="' + (y + 3).toFixed(1) + '" fill="#64748b" font-size="8" text-anchor="end">' + val.toFixed(2) + '</text>';
  }

  // Area fill
  svg += '<polygon points="' + areaPoints + '" fill="#7c3aed" opacity="0.15"/>';

  // Line
  svg += '<polyline points="' + points + '" fill="none" stroke="#7c3aed" stroke-width="1.5"/>';

  // Current value dot
  if (data.length > 0) {
    const lastVal = data[data.length - 1];
    const lx = pad.left + ((data.length - 1) / (data.length - 1)) * plotW;
    const ly = pad.top + (1 - (lastVal - minY) / rangeY) * plotH;
    svg += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3" fill="#7c3aed"/>';
  }

  svg += '</svg>';
  return svg;
}

// ── Polling ──────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollOnce(); // immediate first poll
  trainingPollInterval = setInterval(pollOnce, 800);
}

function stopPolling() {
  if (trainingPollInterval) {
    clearInterval(trainingPollInterval);
    trainingPollInterval = null;
  }
}

async function pollOnce() {
  try {
    const status = await fetchTrainingStatus();

    // Track loss history
    if (status.currentEpoch > trainingLossHistory.length && status.loss > 0) {
      trainingLossHistory.push(status.loss);
    }

    renderTrainingProgress(status);

    if (status.done) {
      stopPolling();
      loadTrainingSidebar();
    }
  } catch {
    // Silently ignore poll errors
  }
}

// ── Utilities ────────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}
