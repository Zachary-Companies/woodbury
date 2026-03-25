/**
 * LLM Settings — Main panel for managing the LLM proxy, model selection, and usage stats.
 * Renders in the main content area when the Settings tab is selected.
 */

// Inject styles once
(function() {
  if (document.getElementById('llm-settings-css')) return;
  const s = document.createElement('style');
  s.id = 'llm-settings-css';
  s.textContent = `
    .llm-settings-page { padding: 32px 40px; max-width: 960px; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .llm-settings-header { margin-bottom: 28px; }
    .llm-settings-header h1 { font-size: 24px; font-weight: 700; margin: 0 0 4px; color: #f1f5f9; }
    .llm-settings-subtitle { font-size: 13px; color: #94a3b8; }
    .llm-settings-grid { display: flex; flex-direction: column; gap: 20px; }
    .llm-card { background: rgba(30,41,59,0.6); border: 1px solid #334155; border-radius: 12px; padding: 20px 24px; }
    .llm-card-wide { grid-column: 1 / -1; }
    .llm-card h3 { font-size: 15px; font-weight: 600; margin: 0 0 6px; color: #f1f5f9; }
    .llm-card-desc { font-size: 12px; color: #94a3b8; margin: 0 0 16px; line-height: 1.5; }
    .llm-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }

    .llm-status-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; padding: 3px 10px; border-radius: 20px; background: rgba(15,23,42,0.6); border: 1px solid #475569; color: #94a3b8; }
    .llm-status-badge--running { border-color: #22c55e; color: #4ade80; }
    .llm-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .llm-status-badge--running .llm-status-dot { animation: llm-pulse 2s infinite; }
    @keyframes llm-pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

    .llm-toggle-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .llm-toggle-row label { font-size: 13px; font-weight: 500; }
    .llm-toggle { position: relative; width: 42px; height: 22px; border-radius: 11px; background: #475569; border: none; cursor: pointer; transition: background 0.2s; }
    .llm-toggle--on { background: #22c55e; }
    .llm-toggle-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.2s; pointer-events: none; }
    .llm-toggle--on .llm-toggle-knob { transform: translateX(20px); }
    .llm-toggle:disabled { opacity: 0.4; cursor: not-allowed; }

    .llm-info-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; font-size: 12px; border-top: 1px solid rgba(71,85,105,0.2); margin-top: 6px; }
    .llm-info-label { color: #94a3b8; }
    .llm-info-value { color: #cbd5e1; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }

    .llm-backends { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 10px; }
    .llm-backend-loading { color: #64748b; font-size: 12px; padding: 8px; }
    .llm-backend-item { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: rgba(15,23,42,0.4); border: 1px solid #334155; border-radius: 8px; }
    .llm-backend-item--active { border-color: rgba(34,197,94,0.3); }
    .llm-backend-icon { font-size: 15px; }
    .llm-backend-name { font-size: 13px; font-weight: 600; flex: 1; }
    .llm-backend-key { font-size: 10px; color: #94a3b8; }

    .llm-model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
    .llm-model-btn { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; background: rgba(15,23,42,0.4); border: 1px solid #334155; border-radius: 8px; cursor: pointer; color: #e2e8f0; text-align: left; transition: all 0.15s; }
    .llm-model-btn:hover { border-color: #8b5cf6; background: rgba(139,92,246,0.08); }
    .llm-model-btn--selected { border-color: #8b5cf6; background: rgba(139,92,246,0.12); box-shadow: 0 0 0 1px rgba(139,92,246,0.3); }
    .llm-model-btn--disabled { opacity: 0.35; cursor: not-allowed; }
    .llm-model-btn--disabled:hover { border-color: #334155; background: rgba(15,23,42,0.4); }
    .llm-model-name { font-size: 13px; font-weight: 600; }
    .llm-model-provider { font-size: 11px; color: #94a3b8; }
    .llm-model-check { position: absolute; top: 8px; right: 10px; color: #a78bfa; font-size: 16px; font-weight: 700; }

    .llm-stats-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 12px 0 16px; }
    .llm-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 12px 8px; background: rgba(15,23,42,0.4); border: 1px solid #334155; border-radius: 8px; }
    .llm-stat-val { font-size: 18px; font-weight: 700; color: #f1f5f9; }
    .llm-stat-lbl { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }

    .llm-stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .llm-stats-table th { text-align: left; padding: 6px 10px; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #334155; }
    .llm-stats-table td { padding: 6px 10px; border-bottom: 1px solid rgba(51,65,85,0.2); }
    .llm-stats-table code { font-family: 'SF Mono', monospace; font-size: 11px; }
  `;
  document.head.appendChild(s);
})();

// eslint-disable-next-line no-unused-vars
function initLlmSettings() {
  const main = document.getElementById('main');
  if (!main) return;

  main.innerHTML = `
    <div class="llm-settings-page">
      <div class="llm-settings-header">
        <h1>LLM Settings</h1>
        <span class="llm-settings-subtitle">Manage AI model routing, proxy, and usage tracking</span>
      </div>

      <div class="llm-settings-grid">
        <!-- Proxy Status -->
        <div class="llm-card" id="llm-proxy-card">
          <div class="llm-card-header">
            <h3>LLM Proxy</h3>
            <div class="llm-status-badge" id="llm-proxy-status">
              <span class="llm-status-dot"></span>
              <span id="llm-proxy-status-text">Checking...</span>
            </div>
          </div>
          <p class="llm-card-desc">Routes pipeline LLM calls through a local proxy for logging, cost tracking, and multi-model routing.</p>
          <div class="llm-toggle-row">
            <label>Enable Proxy</label>
            <button class="llm-toggle" id="llm-proxy-toggle" disabled>
              <span class="llm-toggle-knob"></span>
            </button>
          </div>
          <div class="llm-info-row" id="llm-proxy-url-row" style="display:none">
            <span class="llm-info-label">Proxy URL</span>
            <code class="llm-info-value" id="llm-proxy-url"></code>
          </div>
          <div class="llm-info-row" id="llm-proxy-version-row" style="display:none">
            <span class="llm-info-label">Version</span>
            <span class="llm-info-value" id="llm-proxy-version"></span>
          </div>
        </div>

        <!-- Available Backends -->
        <div class="llm-card">
          <h3>Available Backends</h3>
          <div class="llm-backends" id="llm-backends">
            <div class="llm-backend-loading">Detecting...</div>
          </div>
        </div>

        <!-- Model Selection -->
        <div class="llm-card llm-card-wide">
          <h3>Pipeline Model</h3>
          <p class="llm-card-desc">Select the model used for pipeline script generation and enrichment.</p>
          <div class="llm-model-grid" id="llm-model-grid"></div>
        </div>

        <!-- Usage Stats -->
        <div class="llm-card llm-card-wide" id="llm-stats-card" style="display:none">
          <h3>Usage Statistics</h3>
          <div class="llm-stats-summary" id="llm-stats-summary"></div>
          <table class="llm-stats-table" id="llm-stats-table">
            <thead><tr><th>Model</th><th>Requests</th><th>Input Tokens</th><th>Output Tokens</th><th>Est. Cost</th></tr></thead>
            <tbody id="llm-stats-body"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Initial fetch
  fetchProxyStatus();
  // Poll every 15s
  const pollTimer = setInterval(fetchProxyStatus, 15000);

  // Cleanup on tab switch
  const observer = new MutationObserver(() => {
    if (!document.querySelector('.llm-settings-page')) {
      clearInterval(pollTimer);
      observer.disconnect();
    }
  });
  observer.observe(main, { childList: true });
}

const MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'Anthropic', backend: 'anthropic' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'Anthropic', backend: 'anthropic' },
  { id: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5', provider: 'Anthropic', backend: 'anthropic' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', backend: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI', backend: 'openai' },
  { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B', provider: 'Groq', backend: 'groq' },
];

let _selectedModel = 'claude-sonnet-4-20250514';
let _proxyEnabled = false;

async function fetchProxyStatus() {
  try {
    const resp = await fetch('/api/llm-proxy/status');
    if (!resp.ok) {
      renderStatusOffline();
      return;
    }
    const data = await resp.json();
    if (data.selectedModel) _selectedModel = data.selectedModel;
    renderStatus(data);
  } catch {
    renderStatusOffline();
  }
}

function renderStatus(data) {
  _proxyEnabled = data.enabled;

  // Status badge
  const badge = document.getElementById('llm-proxy-status');
  const statusText = document.getElementById('llm-proxy-status-text');
  if (badge && statusText) {
    badge.className = 'llm-status-badge ' + (data.running ? 'llm-status-badge--running' : '');
    statusText.textContent = data.running ? `Running on port ${data.port}` : 'Stopped';
  }

  // Toggle
  const toggle = document.getElementById('llm-proxy-toggle');
  if (toggle) {
    toggle.disabled = false;
    toggle.className = 'llm-toggle' + (data.enabled ? ' llm-toggle--on' : '');
    toggle.onclick = () => toggleProxy();
  }

  // URL
  if (data.baseURL) {
    const row = document.getElementById('llm-proxy-url-row');
    const val = document.getElementById('llm-proxy-url');
    if (row) row.style.display = '';
    if (val) val.textContent = data.baseURL;
  }

  // Version
  if (data.health?.version) {
    const row = document.getElementById('llm-proxy-version-row');
    const val = document.getElementById('llm-proxy-version');
    if (row) row.style.display = '';
    if (val) val.textContent = 'v' + data.health.version;
  }

  // Backends
  renderBackends(data.availableBackends || {});

  // Models
  renderModels(data.availableBackends || {});

  // Stats
  if (data.stats && data.stats.totalRequests > 0) {
    renderStats(data.stats);
  }
}

function renderStatusOffline() {
  const badge = document.getElementById('llm-proxy-status');
  const statusText = document.getElementById('llm-proxy-status-text');
  if (badge) badge.className = 'llm-status-badge';
  if (statusText) statusText.textContent = 'Not available';

  const toggle = document.getElementById('llm-proxy-toggle');
  if (toggle) toggle.disabled = true;
}

function renderBackends(backends) {
  const el = document.getElementById('llm-backends');
  if (!el) return;
  el.innerHTML = Object.entries(backends).map(([name, hasKey]) => `
    <div class="llm-backend-item ${hasKey ? 'llm-backend-item--active' : ''}">
      <span class="llm-backend-icon">${hasKey ? '✅' : '❌'}</span>
      <span class="llm-backend-name">${name.charAt(0).toUpperCase() + name.slice(1)}</span>
      <span class="llm-backend-key">${hasKey ? 'API key set' : 'No API key'}</span>
    </div>
  `).join('');
}

function renderModels(backends) {
  const el = document.getElementById('llm-model-grid');
  if (!el) return;
  el.innerHTML = MODELS.map(m => {
    const available = backends[m.backend] !== false;
    const selected = _selectedModel === m.id;
    return `
      <button class="llm-model-btn ${selected ? 'llm-model-btn--selected' : ''} ${!available ? 'llm-model-btn--disabled' : ''}"
              data-model="${m.id}" ${!available ? 'disabled' : ''}>
        <span class="llm-model-name">${m.label}</span>
        <span class="llm-model-provider">${m.provider}</span>
        ${selected ? '<span class="llm-model-check">✓</span>' : ''}
      </button>
    `;
  }).join('');

  el.querySelectorAll('.llm-model-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => selectModel(btn.dataset.model));
  });
}

function renderStats(stats) {
  const card = document.getElementById('llm-stats-card');
  if (card) card.style.display = '';

  const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
  const cost = n => '$' + n.toFixed(4);

  const summary = document.getElementById('llm-stats-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="llm-stat"><span class="llm-stat-val">${stats.totalRequests}</span><span class="llm-stat-lbl">Requests</span></div>
      <div class="llm-stat"><span class="llm-stat-val">${fmt(stats.totalInputTokens + stats.totalOutputTokens)}</span><span class="llm-stat-lbl">Tokens</span></div>
      <div class="llm-stat"><span class="llm-stat-val">${cost(stats.totalCostUSD)}</span><span class="llm-stat-lbl">Est. Cost</span></div>
      <div class="llm-stat"><span class="llm-stat-val">${Math.round(stats.avgLatencyMs)}ms</span><span class="llm-stat-lbl">Avg Latency</span></div>
    `;
  }

  const tbody = document.getElementById('llm-stats-body');
  if (tbody) {
    tbody.innerHTML = Object.entries(stats.byModel || {}).map(([model, ms]) => `
      <tr>
        <td><code>${model}</code></td>
        <td>${ms.requests}</td>
        <td>${fmt(ms.inputTokens)}</td>
        <td>${fmt(ms.outputTokens)}</td>
        <td>${cost(ms.costUSD)}</td>
      </tr>
    `).join('');
  }
}

async function toggleProxy() {
  const newState = !_proxyEnabled;
  try {
    const resp = await fetch('/api/llm-proxy/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newState }),
    });
    if (resp.ok) {
      _proxyEnabled = newState;
      setTimeout(fetchProxyStatus, 1500);
    }
  } catch {}
}

async function selectModel(model) {
  _selectedModel = model;
  try {
    await fetch('/api/llm-proxy/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  } catch {}
  // Re-render models to update selection
  const backends = {};
  document.querySelectorAll('.llm-backend-item').forEach(el => {
    const name = el.querySelector('.llm-backend-name')?.textContent?.toLowerCase();
    if (name) backends[name] = el.classList.contains('llm-backend-item--active');
  });
  renderModels(backends);
}
