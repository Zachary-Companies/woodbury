const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── App identity (must be set before menus are built) ────────
app.name = 'Woodbury';

// ── Single instance lock ─────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// ── Custom Protocol ──────────────────────────────────────────
const PROTOCOL = 'woodbury';
if (process.defaultApp) {
  // Dev mode: pass the script path so Electron can relaunch correctly
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ── State ────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let dashboardHandle = null;
let pendingProtocolUrl = null; // Queued URL from cold launch
app.isQuitting = false;

// ── Backend startup ──────────────────────────────────────────
// Require the compiled dashboard and extension manager directly.
// This runs the backend in the same Node.js process as Electron.

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function formatStartupError(err) {
  const message = err && err.message ? String(err.message) : String(err || 'Unknown startup failure');

  if (message.includes('NODE_MODULE_VERSION') || message.includes('ERR_DLOPEN_FAILED')) {
    return [
      'Woodbury could not load one of its bundled native components.',
      '',
      'If you installed the app from a release build, reinstall or update Woodbury and try again.',
      'If you are running from source, run: npm run electron:prepare-native',
      '',
      `Technical detail: ${message}`,
    ].join('\n');
  }

  if (message.includes('node:sqlite') || message.includes('better-sqlite3') || message.includes('SQLite runtime')) {
    return [
      'Woodbury could not start its local memory database.',
      '',
      'Please reinstall or update the app and try again.',
      'If you are running from source, run: npm install && npm run electron:prepare-native',
      '',
      `Technical detail: ${message}`,
    ].join('\n');
  }

  return `The backend server could not start.\n\n${message}`;
}

async function startBackend() {
  const distDir = path.join(__dirname, '..', 'dist');
  console.log('[electron] distDir:', distDir);

  console.log('[electron] Requiring modules...');
  const { startDashboard } = require(path.join(distDir, 'config-dashboard'));
  const { ExtensionManager } = require(path.join(distDir, 'extension-manager'));
  const { ExtensionRegistry, migrateToRegistry, syncBundledExtensions } = require(path.join(distDir, 'extension-loader'));
  console.log('[electron] Modules loaded.');

  const workDir = resolveDashboardWorkDir();
  console.log('[electron] workDir:', workDir);

  // Load extension registry (instant JSON read — no disk scanning)
  console.log('[electron] Loading extension registry...');
  const registry = new ExtensionRegistry();
  await registry.load();

  // One-time migration: if registry is empty, populate from existing extensions on disk
  if (registry.isEmpty) {
    console.log('[electron] Registry empty — running one-time migration...');
    await migrateToRegistry(registry);
  }

  // Sync bundled extensions (fast — only checks 2-3 items)
  await syncBundledExtensions(registry);

  // Create extension manager with registry
  const extensionManager = new ExtensionManager(registry, workDir, false);

  // Start the dashboard HTTP server right away
  console.log('[electron] Starting dashboard on port 9001...');
  const handle = await startDashboard(false, extensionManager, workDir, 9001);
  console.log(`[electron] Dashboard running at ${handle.url}`);

  // Load extensions in the background (pipeline execution and /api/tools await whenReady())
  console.log('[electron] Loading extensions in background...');
  extensionManager.loadAll()
    .then(() => console.log('[electron] Extensions loaded.'))
    .catch((err) => console.error('[electron] Extension loading error:', err.message || err));

  return handle;
}

function resolveDashboardWorkDir() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..');
  }

  const stableWorkspaceDir = path.join(os.homedir(), '.woodbury', 'workspace');
  try {
    fs.mkdirSync(stableWorkspaceDir, { recursive: true });
  } catch {
    // Fall back to the Woodbury data root if the workspace directory cannot be created.
    return path.join(os.homedir(), '.woodbury');
  }
  return stableWorkspaceDir;
}

// ── Window ───────────────────────────────────────────────────

function createWindow(url) {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    } : {}),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // Show after ready-to-show to avoid flash
  });

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    if (isMac) {
      // Inject CSS to account for hidden title bar inset (macOS only)
      mainWindow.webContents.insertCSS(`
        /* Push sidebar header below traffic light buttons */
        .sidebar-header { padding-top: 2.25rem !important; }

        /* Make the top title bar area draggable */
        .sidebar::before {
          content: '';
          display: block;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 52px;
          -webkit-app-region: drag;
          z-index: 10;
          pointer-events: none;
        }

        /* Ensure interactive elements remain clickable */
        .nav-tab, button, input, select, textarea, a, .ext-item, .wf-sidebar-new {
          -webkit-app-region: no-drag;
        }
      `);
    }

    mainWindow.show();
  });

  // macOS convention: close hides to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── API Keys Window ───────────────────────────────────────────

let apiKeysWindow = null;

function openApiKeysWindow() {
  if (apiKeysWindow && !apiKeysWindow.isDestroyed()) {
    apiKeysWindow.focus();
    return;
  }

  const port = dashboardPort || 9001;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>API Keys</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    padding: 24px;
    font-size: 13px;
    -webkit-app-region: no-drag;
  }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 4px; color: #f1f5f9; }
  .subtitle { font-size: 11px; color: #64748b; margin-bottom: 20px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 11px; font-weight: 500; color: #94a3b8; margin-bottom: 5px; letter-spacing: 0.03em; }
  .input-row { display: flex; gap: 6px; align-items: center; }
  input {
    flex: 1;
    padding: 7px 10px;
    background: #1e2433;
    border: 1px solid #2d3748;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: #7c3aed; }
  input::placeholder { color: #475569; font-family: -apple-system, sans-serif; }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge.set { background: rgba(16,185,129,0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }
  .badge.unset { background: rgba(100,116,139,0.15); color: #94a3b8; border: 1px solid rgba(100,116,139,0.2); }
  .actions { display: flex; gap: 8px; margin-top: 22px; justify-content: flex-end; }
  button {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
  }
  .btn-primary { background: #7c3aed; color: #fff; }
  .btn-primary:hover { background: #6d28d9; }
  .btn-primary:disabled { opacity: 0.5; cursor: wait; }
  .btn-cancel { background: #1e2433; color: #94a3b8; border: 1px solid #2d3748; }
  .btn-cancel:hover { color: #e2e8f0; }
  .status { font-size: 11px; margin-top: 10px; min-height: 16px; text-align: right; }
  .status.ok { color: #6ee7b7; }
  .status.err { color: #f87171; }
  .divider { border: none; border-top: 1px solid #1e2433; margin: 18px 0 14px; }
  .hint { font-size: 10px; color: #475569; margin-top: 18px; }
  .hint a { color: #7c3aed; text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h2>API Keys</h2>
<p class="subtitle">Saved to ~/.woodbury/.env · Applied immediately without restart</p>

<div id="fields">Loading...</div>

<div class="actions">
  <button class="btn-cancel" id="btn-cancel">Cancel</button>
  <button class="btn-primary" id="btn-save">Save Keys</button>
</div>
<div class="status" id="status"></div>

<p class="hint">Leave a field blank to keep the existing key. Enter a single space to remove a key.</p>

<script>
const PORT = ${port};
const BASE = 'http://127.0.0.1:' + PORT;

const PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...', link: 'https://console.anthropic.com/settings/keys', group: 'LLM Providers' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-proj-...', link: 'https://platform.openai.com/api-keys', group: 'LLM Providers' },
  { key: 'GROQ_API_KEY', label: 'Groq', placeholder: 'gsk_...', link: 'https://console.groq.com/keys', group: 'LLM Providers' },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini (Nanobanana)', placeholder: 'AIza...', link: 'https://aistudio.google.com/app/apikey', group: 'Media Generation' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs (TTS)', placeholder: 'xi-...', link: 'https://elevenlabs.io/app/settings/api-keys', group: 'Media Generation' },
];

let currentStatus = {};

async function load() {
  try {
    const r = await fetch(BASE + '/api/env-keys');
    const data = await r.json();
    currentStatus = data.keys || {};
  } catch { currentStatus = {}; }

  const container = document.getElementById('fields');
  let lastGroup = '';
  container.innerHTML = PROVIDERS.map(p => {
    const info = currentStatus[p.key] || { set: false, masked: '' };
    const groupHeader = p.group !== lastGroup ? \`<div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin:\${lastGroup ? '14px' : '0'} 0 6px;padding-top:\${lastGroup ? '10px' : '0'};border-top:\${lastGroup ? '1px solid #1e2433' : 'none'}">\${p.group}</div>\` : '';
    lastGroup = p.group;
    return groupHeader + \`<div class="field">
      <label>\${p.label} — <a href="\${p.link}" target="_blank" onclick="require('electron').shell.openExternal('\${p.link}'); return false;" style="color:#7c3aed;text-decoration:none;font-size:10px;">Get key ↗</a></label>
      <div class="input-row">
        <input type="password" id="\${p.key}" placeholder="\${info.set ? info.masked + ' (enter new to change)' : p.placeholder}" autocomplete="off" />
        <span class="badge \${info.set ? 'set' : 'unset'}">\${info.set ? '✓ Set' : 'Not set'}</span>
      </div>
    </div>\`;
  }).join('');
}

document.getElementById('btn-cancel').addEventListener('click', () => window.close());

document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  const statusEl = document.getElementById('status');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  statusEl.textContent = '';
  statusEl.className = 'status';

  const body = {};
  for (const p of PROVIDERS) {
    const val = document.getElementById(p.key).value;
    if (val !== '') body[p.key] = val.trim();
  }

  try {
    const r = await fetch(BASE + '/api/env-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    statusEl.textContent = '✓ Keys saved successfully';
    statusEl.className = 'status ok';
    setTimeout(() => window.close(), 800);
  } catch (e) {
    statusEl.textContent = '✗ ' + e.message;
    statusEl.className = 'status err';
    btn.disabled = false;
    btn.textContent = 'Save Keys';
  }
});

// Close on Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });

load();
</script>
</body>
</html>`;

  apiKeysWindow = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'API Keys',
    parent: mainWindow || undefined,
    modal: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#0f1117',
    titleBarStyle: 'hiddenInset',
    vibrancy: null,
  });

  // Write to a temp file — data: URLs block fetch() to localhost
  const tmpPath = require('path').join(require('os').tmpdir(), 'woodbury-api-keys.html');
  require('fs').writeFileSync(tmpPath, html);
  apiKeysWindow.loadFile(tmpPath);
  apiKeysWindow.setMenuBarVisibility(false);

  apiKeysWindow.on('closed', () => {
    apiKeysWindow = null;
    // Refresh model list since new keys may be available
    cachedModelOptions = null;
    isFetchingModels = false;
    setTimeout(() => fetchAndCacheModels(dashboardPort), 500);
  });
}

// ── Application Menu ─────────────────────────────────────────

function goTab(tab) {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(
      `if (typeof switchTab === 'function') switchTab(${JSON.stringify(tab)});`
    ).catch(() => {});
  }
}

const CHAT_CONFIG_PATH = path.join(os.homedir(), '.woodbury', 'chat-config.json');

// Live model list fetched from dashboard API — null means not yet loaded
let cachedModelOptions = null;
let isFetchingModels = false;
let dashboardPort = null; // set when dashboard starts

const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', groq: 'Groq' };

const STATIC_MODEL_OPTIONS = [
  { label: 'Auto-detect', provider: 'auto', model: '' },
  { type: 'separator' },
  { label: 'Claude Sonnet 4.5 (Anthropic)', provider: 'anthropic', model: 'claude-sonnet-4-5-20250514' },
  { label: 'Claude Sonnet 4 (Anthropic)', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  { label: 'Claude Opus 4 (Anthropic)', provider: 'anthropic', model: 'claude-opus-4-20250514' },
  { label: 'Claude Haiku 3.5 (Anthropic)', provider: 'anthropic', model: 'claude-haiku-3-5-20241022' },
  { type: 'separator' },
  { label: 'GPT-4o (OpenAI)', provider: 'openai', model: 'gpt-4o' },
  { label: 'GPT-4o mini (OpenAI)', provider: 'openai', model: 'gpt-4o-mini' },
  { type: 'separator' },
  { label: 'Llama 3.1 70B (Groq)', provider: 'groq', model: 'llama-3.1-70b-versatile' },
];

function readChatConfig() {
  try {
    return JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeChatConfig(updates) {
  const existing = readChatConfig();
  const next = { ...existing, ...updates };
  if (!updates.provider || updates.provider === 'auto') {
    delete next.provider;
    delete next.model;
  }
  try {
    fs.mkdirSync(path.dirname(CHAT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CHAT_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to write chat config:', e.message);
  }
}

function fetchAndCacheModels(port) {
  if (isFetchingModels || !port) return;
  isFetchingModels = true;
  const http = require('http');
  const req = http.get(`http://127.0.0.1:${port}/api/models/available`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => { data += chunk; });
    resp.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.byProvider) {
          const options = [{ label: 'Auto-detect', provider: 'auto', model: '' }];
          for (const [provider, models] of Object.entries(parsed.byProvider)) {
            if (!models || models.length === 0) continue;
            options.push({ type: 'separator' });
            for (const m of models) {
              options.push({
                label: `${m.name} (${PROVIDER_LABELS[provider] || provider})`,
                provider: m.provider,
                model: m.id,
              });
            }
          }
          cachedModelOptions = options;
          createApplicationMenu(); // Rebuild with live models
        }
      } catch { /* ignore */ }
      isFetchingModels = false;
    });
  });
  req.on('error', () => { isFetchingModels = false; });
  req.setTimeout(10000, () => { req.destroy(); isFetchingModels = false; });
}

function buildModelSubmenu() {
  const config = readChatConfig();
  const currentModel = config.model || '';
  const currentProvider = config.provider || 'auto';
  const options = cachedModelOptions || STATIC_MODEL_OPTIONS;

  const items = options.map((opt) => {
    if (opt.type === 'separator') return { type: 'separator' };
    const isAuto = opt.provider === 'auto';
    const isChecked = isAuto
      ? !config.provider || currentProvider === 'auto'
      : currentModel === opt.model && currentProvider === opt.provider;
    return {
      label: opt.label,
      type: 'checkbox',
      checked: isChecked,
      click: () => {
        if (isAuto) {
          writeChatConfig({ provider: 'auto', model: '' });
        } else {
          writeChatConfig({ provider: opt.provider, model: opt.model });
        }
        createApplicationMenu();
      },
    };
  });

  items.push({ type: 'separator' });
  items.push({
    label: isFetchingModels
      ? 'Loading...'
      : cachedModelOptions
        ? '↻ Refresh Model List'
        : '↻ Load Available Models...',
    enabled: !isFetchingModels,
    click: () => {
      cachedModelOptions = null;
      isFetchingModels = false;
      fetchAndCacheModels(dashboardPort);
      createApplicationMenu();
    },
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'API Keys...',
    click: () => openApiKeysWindow(),
  });

  return items;
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'About Woodbury' },
              { type: 'separator' },
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: () => goTab('marketplace'),
              },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Woodbury' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Woodbury' },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workflow',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.executeJavaScript(
                `document.querySelector('[data-tab="workflows"]')?.click()`
              );
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Quit Woodbury' },
      ],
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // Go menu — tab shortcuts
    {
      label: 'Go',
      submenu: [
        { label: 'Workflows', accelerator: 'CmdOrCtrl+1', click: () => goTab('workflows') },
        { label: 'Pipelines', accelerator: 'CmdOrCtrl+2', click: () => goTab('compositions') },
        { label: 'Runs', accelerator: 'CmdOrCtrl+3', click: () => goTab('runs') },
        { label: 'Training', accelerator: 'CmdOrCtrl+4', click: () => goTab('training') },
        { label: 'Marketplace', accelerator: 'CmdOrCtrl+5', click: () => goTab('marketplace') },
        { label: 'Social', accelerator: 'CmdOrCtrl+6', click: () => goTab('social') },
      ],
    },

    // Model menu
    {
      label: 'Model',
      submenu: buildModelSubmenu(),
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front', label: 'Bring All to Front' }]
          : []),
      ],
    },

    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Woodbury Documentation',
          click: () => {
            shell.openExternal('https://woodbury.dev');
          },
        },
        { type: 'separator' },
        {
          label: 'Open Logs Folder',
          click: () => {
            const logsPath = path.join(
              require('os').homedir(),
              '.woodbury',
              'logs'
            );
            shell.openPath(logsPath);
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── Tray ─────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'icons', 'tray-icon.png');
  let icon;

  try {
    const traySize = process.platform === 'win32' ? 16 : 18;
    icon = nativeImage.createFromPath(iconPath).resize({ width: traySize, height: traySize });
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true); // macOS auto-adjusts for dark/light menu bar
    }
  } catch {
    // If no icon file yet, create a simple placeholder
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);

  const port = dashboardHandle ? dashboardHandle.port : '...';
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: `http://127.0.0.1:${port}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit Woodbury',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Woodbury');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Auto-updater ─────────────────────────────────────────────

function setupAutoUpdater() {
  // Only run in packaged app — electron-updater won't work in dev mode
  if (process.defaultApp) {
    console.log('[updater] Skipping auto-updater in dev mode');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.error('[updater] Failed to load electron-updater:', err.message);
    return;
  }

  // Don't download automatically — ask the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Expose globally so the dashboard HTTP server can trigger updates
  global.woodburyAutoUpdater = autoUpdater;
  // When true, skip the "Download?" dialog and download immediately
  global.woodburyAutoDownloadNext = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version);

    // If triggered from dashboard, skip dialog and download immediately
    if (global.woodburyAutoDownloadNext) {
      global.woodburyAutoDownloadNext = false;
      console.log('[updater] Auto-downloading (triggered from dashboard)');
      autoUpdater.downloadUpdate();
      return;
    }

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Woodbury v${info.version} is available.`,
      detail: 'Would you like to download it now? The app will continue running while it downloads.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        console.log('[updater] User chose to download');
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[updater] Download progress: ${pct}%`);
    // Update the window title with progress
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(pct < 100 ? `Woodbury — Downloading update ${pct}%` : 'Woodbury');
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update downloaded:', info.version);
    // Reset window title
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle('Woodbury');
    }
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Woodbury v${info.version} has been downloaded.`,
      detail: 'Restart now to install the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        console.log('[updater] User chose to restart');
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message || err);
  });

  // Check for updates after a short delay (let the app finish loading)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Check failed:', err.message || err);
    });
  }, 5000);

  // Re-check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Periodic check failed:', err.message || err);
    });
  }, 4 * 60 * 60 * 1000);
}

// ── Protocol URL handler ─────────────────────────────────────

async function handleProtocolUrl(url) {
  try {
    const parsed = new URL(url);
    // woodbury://install/nanobanana?git=https://github.com/...
    if (parsed.hostname === 'install' || parsed.pathname.startsWith('/install')) {
      const name = (parsed.hostname === 'install' ? parsed.pathname : parsed.pathname.replace(/^\/install\/?/, '')).replace(/^\//, '');
      const gitUrl = parsed.searchParams.get('git');

      if (name && gitUrl && dashboardHandle) {
        // Show and focus the window
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }

        // Navigate to marketplace tab and trigger install
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(`
            // Switch to marketplace tab
            if (typeof switchTab === 'function') switchTab('marketplace');
            // Wait for init, then auto-install
            setTimeout(function() {
              if (typeof installExtension === 'function') {
                installExtension(${JSON.stringify(name)}, ${JSON.stringify(gitUrl)}).then(function(result) {
                  if (typeof initMarketplace === 'function') initMarketplace();
                });
              }
            }, 1500);
          `).catch(() => {});
        }

        // Also do the install via API as a fallback
        const http = require('http');
        const postData = JSON.stringify({ name, gitUrl });
        const req = http.request({
          hostname: '127.0.0.1',
          port: dashboardHandle.port,
          path: '/api/marketplace/install',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        });
        req.write(postData);
        req.end();
      }
    }

    // woodbury://workflow/install/{workflowId} — install a shared workflow
    if (parsed.hostname === 'workflow' || parsed.pathname.startsWith('/workflow')) {
      const pathParts = parsed.pathname.replace(/^\//, '').split('/');
      // pathParts = ['install', '{workflowId}'] or ['workflow', 'install', '{workflowId}']
      let action, workflowId;
      if (parsed.hostname === 'workflow') {
        action = pathParts[0];
        workflowId = pathParts[1];
      } else {
        action = pathParts[1];
        workflowId = pathParts[2];
      }

      if (action === 'install' && workflowId && dashboardHandle) {
        // Show and focus the window
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }

        // Download the shared workflow via API
        const http = require('http');
        const postData = JSON.stringify({ workflowId });
        const req = http.request({
          hostname: '127.0.0.1',
          port: dashboardHandle.port,
          path: '/api/marketplace/download',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              if (result.success && mainWindow) {
                mainWindow.webContents.executeJavaScript(`
                  if (typeof switchTab === 'function') switchTab('workflows');
                  setTimeout(function() {
                    if (typeof showNotification === 'function') {
                      showNotification('Workflow installed successfully!', 'success');
                    } else {
                      alert('Workflow installed successfully!');
                    }
                  }, 500);
                `).catch(() => {});
              } else if (mainWindow) {
                const errorMsg = result.error || 'Unknown error';
                mainWindow.webContents.executeJavaScript(`
                  alert('Failed to install workflow: ' + ${JSON.stringify(errorMsg)});
                `).catch(() => {});
              }
            } catch {}
          });
        });
        req.on('error', () => {});
        req.write(postData);
        req.end();
      }
    }
  } catch (err) {
    console.error('[electron] Protocol URL error:', err.message || err);
  }
}

// macOS: handle protocol URLs (may fire before 'ready' on cold launch)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (dashboardHandle) {
    handleProtocolUrl(url);
  } else {
    // Backend not ready yet — queue it for after startup
    pendingProtocolUrl = url;
  }
});

// ── App lifecycle ────────────────────────────────────────────

app.on('ready', async () => {
  console.log('[electron] ready event fired');
  // Set dock icon (needed in dev mode — packaged .app gets it from Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png'));
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  createApplicationMenu();

  try {
    dashboardHandle = await startBackend();
    dashboardPort = dashboardHandle.port;
    createWindow(dashboardHandle.url);
    createTray();
    // Fetch live model list from running dashboard (after a short delay to let it stabilize)
    setTimeout(() => fetchAndCacheModels(dashboardPort), 3000);
    setupAutoUpdater();

    // Process any protocol URL that arrived before the backend was ready
    // macOS: queued from open-url event; Windows: passed via process.argv
    if (!pendingProtocolUrl && process.platform === 'win32') {
      pendingProtocolUrl = process.argv.find(arg => arg.startsWith(PROTOCOL + '://'));
    }
    if (pendingProtocolUrl) {
      console.log('[electron] Processing queued protocol URL:', pendingProtocolUrl);
      handleProtocolUrl(pendingProtocolUrl);
      pendingProtocolUrl = null;
    }
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    dialog.showErrorBox(
      'Woodbury Failed to Start',
      formatStartupError(err)
    );
    app.quit();
  }
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Graceful shutdown — close the dashboard server
app.on('before-quit', () => {
  app.isQuitting = true;
  if (dashboardHandle) {
    try {
      dashboardHandle.close();
    } catch {
      // Already closed or errored — ignore
    }
  }
});

// Second instance attempted — focus existing window (also handles protocol URLs on Windows)
app.on('second-instance', (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // On Windows, the protocol URL is passed as a command line argument
  const protocolUrl = commandLine.find(arg => arg.startsWith(PROTOCOL + '://'));
  if (protocolUrl) {
    handleProtocolUrl(protocolUrl);
  }
});

// Prevent the app from quitting when all windows are closed (macOS convention)
app.on('window-all-closed', () => {
  // On macOS, keep running in tray. On other platforms, quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
