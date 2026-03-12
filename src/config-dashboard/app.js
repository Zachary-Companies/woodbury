/**
 * Config Dashboard — Client-side JavaScript
 *
 * Vanilla JS SPA for managing extension environment variables.
 * No build step required.
 */

// ── State ────────────────────────────────────────────────────
let extensions = [];
let selectedExtension = null;

// Folder picker state
let folderPickerTarget = null; // input element name to fill
let folderPickerCurrentDir = '';

// ── DOM Helpers ──────────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }

function helpIcon(topicId) {
  return '<button class="help-icon" data-help="' + topicId + '" title="Learn more">?</button>';
}

function toast(message, type) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── API ──────────────────────────────────────────────────────

async function fetchExtensionEnv(name) {
  const res = await fetch('/api/extensions/' + encodeURIComponent(name) + '/env');
  if (!res.ok) throw new Error('Extension not found');
  return res.json();
}

async function saveExtensionEnv(name, vars) {
  const res = await fetch('/api/extensions/' + encodeURIComponent(name) + '/env', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vars }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed');
  return data;
}

async function browseDirs(dirPath) {
  const res = await fetch('/api/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath || undefined }),
  });
  if (!res.ok) throw new Error('Failed to browse');
  return res.json();
}

// ── Folder Picker ─────────────────────────────────────────────

async function openFolderPicker(inputName, startDir) {
  folderPickerTarget = inputName;
  const modal = $('#folder-modal');
  modal.classList.add('open');

  await navigateToDir(startDir || '');
}

function closeFolderPicker() {
  const modal = $('#folder-modal');
  modal.classList.remove('open');
  folderPickerTarget = null;
}

async function navigateToDir(dirPath) {
  const dirsEl = $('#modal-dirs');
  dirsEl.innerHTML = '<div class="dir-empty">Loading...</div>';

  try {
    const data = await browseDirs(dirPath);
    folderPickerCurrentDir = data.current;
    $('#modal-path').textContent = data.current;

    if (data.dirs.length === 0) {
      dirsEl.innerHTML = '<div class="dir-empty">No subdirectories</div>';
    } else {
      dirsEl.innerHTML = data.dirs.map(d =>
        '<div class="dir-item" data-path="' + escAttr(d.path) + '">' +
        '<span class="dir-icon">&#x1f4c1;</span>' +
        escHtml(d.name) +
        '</div>'
      ).join('');

      // Click to navigate into subdirectory
      dirsEl.querySelectorAll('.dir-item').forEach(el => {
        el.addEventListener('click', () => navigateToDir(el.dataset.path));
      });
    }
  } catch (err) {
    dirsEl.innerHTML = '<div class="dir-empty" style="color:#ef4444;">Cannot read directory</div>';
  }
}

// Folder picker event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Close modal
  $('#modal-close').addEventListener('click', closeFolderPicker);
  $('#modal-cancel').addEventListener('click', closeFolderPicker);

  // Go up to parent
  $('#btn-parent').addEventListener('click', async () => {
    const data = await browseDirs(folderPickerCurrentDir);
    if (data.parent && data.parent !== data.current) {
      await navigateToDir(data.parent);
    }
  });

  // Select current folder
  $('#modal-select').addEventListener('click', () => {
    if (folderPickerTarget && folderPickerCurrentDir) {
      const input = document.querySelector('input[name="' + folderPickerTarget + '"]');
      if (input) {
        input.value = folderPickerCurrentDir;
      }
      closeFolderPicker();
    }
  });

  // Close on overlay click
  $('#folder-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeFolderPicker();
  });

  // Keyboard shortcuts
  var tabShortcuts = {
    '1': 'workflows',
    '2': 'compositions',
    '3': 'runs',
    '4': 'training',
    '5': 'marketplace',
    '6': 'social',
    '7': 'mcp',
  };

  document.addEventListener('keydown', (e) => {
    // Close modals on Escape
    if (e.key === 'Escape' && $('#folder-modal').classList.contains('open')) {
      closeFolderPicker();
    }
    if (e.key === 'Escape' && $('#help-modal').classList.contains('open')) {
      closeHelp();
    }

    // Tab switching: Ctrl+1..6 (Win/Linux) or Cmd+1..6 (Mac)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && tabShortcuts[e.key]) {
      e.preventDefault();
      switchTab(tabShortcuts[e.key]);
    }
  });

  // ── Help modal handlers ──────────────────────────────
  $('#help-modal-close').addEventListener('click', closeHelp);
  $('#help-modal-ok').addEventListener('click', closeHelp);
  $('#help-modal').addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeHelp();
  });

  // Delegated click handler for all help icons
  document.addEventListener('click', function(e) {
    var helpBtn = e.target.closest('.help-icon');
    if (helpBtn && helpBtn.dataset.help) {
      e.stopPropagation();
      showHelp(helpBtn.dataset.help);
    }
  });
});

// ── Utilities ────────────────────────────────────────────────

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Help System ──────────────────────────────────────────────

var HELP_CONTENT = {

  // ── Workflows Tab ──────────────────────────────────────────
  'workflows-what': {
    title: 'What is a workflow?',
    body: '<div class="help-content">' +
      '<p>A workflow is a saved set of actions that Woodbury can repeat for you automatically. ' +
      'For example: "open a website, click a button, type some text, and download a file."</p>' +
      '<p>You record your actions once, and then Woodbury can replay them any time you want &mdash; ' +
      'saving you from doing the same repetitive task over and over.</p>' +
      '</div>'
  },

  'workflows-recording': {
    title: 'How recording works',
    body: '<div class="help-content">' +
      '<p>When you click <strong>Start Recording</strong>, Woodbury watches what you do and saves each action as a "step."</p>' +
      '<p>Every click, keystroke, page visit, and scroll is captured. When you\'re done, click <strong>Stop &amp; Save</strong>. ' +
      'Woodbury saves all the steps so it can replay them later.</p>' +
      '<p>You can review and edit the steps afterward if anything needs adjusting.</p>' +
      '<div class="help-tip">Try to work at a normal pace &mdash; Woodbury records timing too, so it knows how long to wait between actions.</div>' +
      '</div>'
  },

  'workflows-browser-vs-desktop': {
    title: 'Browser vs Desktop mode',
    body: '<div class="help-content">' +
      '<p><strong>Browser</strong> mode records actions inside Chrome &mdash; clicking links, filling out forms, navigating websites.</p>' +
      '<p><strong>Desktop</strong> mode records actions in any application on your computer &mdash; like Photoshop, Blender, Finder, or Spotify.</p>' +
      '<ul>' +
      '<li>Use <strong>Browser</strong> for web-based tasks (websites, web apps)</li>' +
      '<li>Use <strong>Desktop</strong> for anything outside the browser</li>' +
      '</ul>' +
      '<div class="help-tip">In Desktop mode, you can also enter an app name so Woodbury launches it automatically when replaying.</div>' +
      '</div>'
  },

  'workflows-variables': {
    title: 'What are variables?',
    body: '<div class="help-content">' +
      '<p>Variables are placeholders for values that can change each time you run the workflow.</p>' +
      '<p>For example, if your workflow posts to social media, you might have a variable called ' +
      '<code>caption</code> that you fill in fresh every time.</p>' +
      '<p>In the workflow steps, variables look like this: <code>{{caption}}</code>. ' +
      'When you run the workflow, Woodbury will ask you to fill in the actual values.</p>' +
      '<div class="help-tip">Mark a variable as "required" if the workflow can\'t run without it.</div>' +
      '</div>'
  },

  'workflows-steps': {
    title: 'What are steps?',
    body: '<div class="help-content">' +
      '<p>Steps are the individual actions in your workflow, listed in the order they\'ll happen.</p>' +
      '<p>Each step is one thing Woodbury will do:</p>' +
      '<ul>' +
      '<li><strong>Navigate</strong> &mdash; open a web page</li>' +
      '<li><strong>Click</strong> &mdash; click a button or link</li>' +
      '<li><strong>Type</strong> &mdash; enter text into a field</li>' +
      '<li><strong>Wait</strong> &mdash; pause for a moment</li>' +
      '<li><strong>Scroll</strong> &mdash; scroll the page</li>' +
      '<li><strong>Keyboard</strong> &mdash; press a key or shortcut</li>' +
      '</ul>' +
      '<p>When you run the workflow, steps are replayed from top to bottom.</p>' +
      '</div>'
  },

  'workflows-run': {
    title: 'Running a workflow',
    body: '<div class="help-content">' +
      '<p>Fill in any required variables, then click <strong>Run</strong>. ' +
      'Woodbury will open Chrome (or your desktop app) and replay all the steps automatically.</p>' +
      '<p>You can watch it happen in real time. If something goes wrong, the run will stop and show you what happened.</p>' +
      '<p>Every run is saved in the <strong>Runs</strong> tab so you can review the results later.</p>' +
      '<div class="help-tip">Make sure the target website or app is accessible before running. ' +
      'For browser workflows, the Chrome extension must be connected.</div>' +
      '</div>'
  },

  'workflows-model': {
    title: 'What is a model?',
    body: '<div class="help-content">' +
      '<p>A model is a small AI that learns to recognize the buttons and elements on a specific website. ' +
      'This helps Woodbury find the right things to click, even if the website looks slightly different ' +
      '(like after a redesign, in dark mode, or on a different screen size).</p>' +
      '<p>Training a model is <strong>optional</strong> but makes your workflows more reliable. ' +
      'It uses the screenshots captured during recording.</p>' +
      '<div class="help-tip">You can train a model from the Training tab after recording a few workflows on the same website.</div>' +
      '</div>'
  },

  // ── Pipelines Tab ──────────────────────────────────────────
  'pipelines-what': {
    title: 'What is a pipeline?',
    body: '<div class="help-content">' +
      '<p>A pipeline chains multiple workflows together into a visual flowchart. ' +
      'For example: first run a workflow that downloads a report, then run another that emails it to your team.</p>' +
      '<p>The output of one workflow can automatically feed into the next. ' +
      'Think of it like building blocks &mdash; each block does one job, and you connect them together.</p>' +
      '</div>'
  },

  'pipelines-nodes': {
    title: 'Node types',
    body: '<div class="help-content">' +
      '<p>Nodes are the building blocks of a pipeline. Each one does a different job:</p>' +
      '<ul>' +
      '<li><strong>Workflow</strong> &mdash; runs one of your saved workflows</li>' +
      '<li><strong>Gate</strong> &mdash; pauses and asks for your approval before continuing</li>' +
      '<li><strong>Script</strong> &mdash; runs custom code (for advanced users)</li>' +
      '<li><strong>Branch</strong> &mdash; chooses a path based on a condition</li>' +
      '<li><strong>Delay</strong> &mdash; waits a set amount of time</li>' +
      '<li><strong>Loop</strong> &mdash; repeats for each item in a list</li>' +
      '<li><strong>Switch</strong> &mdash; picks from multiple paths based on a value</li>' +
      '</ul>' +
      '<div class="help-tip">Click "+ Add Node" then drag nodes onto the canvas. Connect them by dragging between the small circles (ports) on each node.</div>' +
      '</div>'
  },

  'pipelines-connecting': {
    title: 'Connecting nodes',
    body: '<div class="help-content">' +
      '<p>To connect two nodes, click and drag from a <strong>port</strong> (the small circle) on one node to a port on another.</p>' +
      '<p>Data flows along these connections &mdash; output values from one workflow automatically become available as inputs to the next.</p>' +
      '<ul>' +
      '<li>Ports on the <strong>left side</strong> are inputs</li>' +
      '<li>Ports on the <strong>right side</strong> are outputs</li>' +
      '</ul>' +
      '<div class="help-tip">Click a connection line to select it, then press Delete to remove it.</div>' +
      '</div>'
  },

  // ── Runs Tab ───────────────────────────────────────────────
  'runs-what': {
    title: 'What are runs?',
    body: '<div class="help-content">' +
      '<p>Every time you run a workflow or pipeline, Woodbury saves a record of what happened.</p>' +
      '<p>This includes whether it succeeded or failed, how long it took, which steps were completed, ' +
      'and any errors that occurred.</p>' +
      '<p>You can review past runs here to understand what went wrong or confirm everything worked.</p>' +
      '</div>'
  },

  'runs-statuses': {
    title: 'Run status meanings',
    body: '<div class="help-content">' +
      '<ul>' +
      '<li><strong style="color:#10b981;">&#x2713; Completed</strong> &mdash; everything finished successfully</li>' +
      '<li><strong style="color:#ef4444;">&#x2717; Failed</strong> &mdash; something went wrong. Click the run to see the error details</li>' +
      '<li><strong style="color:#f59e0b;">&#x25CB; Cancelled</strong> &mdash; the run was stopped before it finished</li>' +
      '<li><strong style="color:#3b82f6;">&#x25CF; Running</strong> &mdash; currently in progress</li>' +
      '</ul>' +
      '</div>'
  },

  // ── Training Tab ───────────────────────────────────────────
  'training-what': {
    title: 'What is model training?',
    body: '<div class="help-content">' +
      '<p>Training teaches Woodbury to recognize the buttons, links, and other elements on a specific website.</p>' +
      '<p>It uses the screenshots captured when you record workflows. After training, Woodbury can find elements ' +
      'even when the website changes slightly &mdash; like a theme switch, a redesign, or a different screen size.</p>' +
      '<p>Training is <strong>optional</strong> and takes a few minutes to a few hours depending on how much data you have.</p>' +
      '</div>'
  },

  'training-data': {
    title: 'Training data',
    body: '<div class="help-content">' +
      '<p>Training data is the collection of screenshots taken during workflow recording.</p>' +
      '<ul>' +
      '<li><strong>Crops</strong> are individual pictures of buttons, links, and other elements cut from full-page screenshots</li>' +
      '<li><strong>Groups</strong> are sets of crops that all show the same element</li>' +
      '</ul>' +
      '<p>More data generally means better results. Click <strong>Prepare Data</strong> to process your raw screenshots into training-ready crops.</p>' +
      '<div class="help-tip">Higher "Crops per element" generates more variations of each element, which improves accuracy.</div>' +
      '</div>'
  },

  'training-config': {
    title: 'Training settings explained',
    body: '<div class="help-content">' +
      '<ul>' +
      '<li><strong>Architecture</strong> &mdash; The model size. MobileNet is smallest and fastest. ' +
      'EfficientNet is a good middle ground. ResNet is the largest but most accurate. ' +
      'For most cases, MobileNet works great.</li>' +
      '<li><strong>Epochs</strong> &mdash; How many rounds of learning the model goes through. ' +
      'More rounds = better results, but takes longer. 50&ndash;100 is typical.</li>' +
      '<li><strong>Learning Rate</strong> &mdash; How quickly the model adjusts itself. ' +
      'The default (0.0003) works well for most cases.</li>' +
      '<li><strong>Model Precision</strong> &mdash; How detailed the model\'s recognition is. ' +
      'Standard (64) works well for most cases. Higher values are more precise but slower.</li>' +
      '<li><strong>Auto-export for browser</strong> &mdash; Keep this set to "Yes" so the trained model is ready to use right away.</li>' +
      '</ul>' +
      '</div>'
  },

  'training-workers': {
    title: 'Workers (remote training)',
    body: '<div class="help-content">' +
      '<p>Workers are other computers on your network that can run training for you.</p>' +
      '<p>This is useful if you have a machine with a powerful graphics card (GPU), which makes training ' +
      'much faster. Add a worker by entering its network address.</p>' +
      '<p>If no workers are available, training runs on this computer instead.</p>' +
      '</div>'
  },

  'training-train-on': {
    title: 'Where to train',
    body: '<div class="help-content">' +
      '<p>Choose where training runs:</p>' +
      '<ul>' +
      '<li><strong>Local</strong> &mdash; uses this computer</li>' +
      '<li><strong>A remote worker</strong> &mdash; uses another machine\'s hardware (select one from the list)</li>' +
      '</ul>' +
      '<p>Remote workers with GPUs are typically much faster than training locally.</p>' +
      '</div>'
  }
};

function showHelp(topicId) {
  var topic = HELP_CONTENT[topicId];
  if (!topic) return;
  $('#help-modal-title').textContent = topic.title;
  $('#help-modal-body').innerHTML = topic.body;
  $('#help-modal').classList.add('open');
}

function closeHelp() {
  $('#help-modal').classList.remove('open');
}

// ── Nav Tabs ─────────────────────────────────────────────────

let currentTab = 'home';

function switchTab(tab, opts) {
  opts = opts || {};
  currentTab = tab;
  document.body.classList.toggle('composition-form-mode', tab === 'compositions' && opts.view === 'form' && !!opts.workflowId);

  // Update tab buttons
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Toggle sidebar panels
  document.querySelectorAll('[data-panel]').forEach(panel => {
    panel.style.display = panel.dataset.panel === tab ? '' : 'none';
  });

  // Update hash (unless suppressed by hash handler to avoid loops)
  if (!opts._fromHash) {
    updateHash(tab);
  }

  // Show appropriate empty state or content
  const main = $('#main');

  if (tab === 'home') {
    selectedExtension = null;
    if (typeof initHome === 'function') {
      initHome();
    }
  } else if (tab === 'workflows') {
    selectedExtension = null;
    // Workflows module handles its own rendering
    if (typeof initWorkflows === 'function') {
      initWorkflows();
    }
  } else if (tab === 'compositions') {
    selectedExtension = null;
    // Compositions module handles its own rendering
    if (typeof initCompositions === 'function') {
      initCompositions();
    }
  } else if (tab === 'runs') {
    selectedExtension = null;
    if (typeof initRuns === 'function') {
      initRuns();
    }
  } else if (tab === 'training') {
    selectedExtension = null;
    if (typeof initTraining === 'function') {
      initTraining();
    }
  } else if (tab === 'marketplace') {
    selectedExtension = null;
    if (typeof initMarketplace === 'function') {
      initMarketplace();
    }
  } else if (tab === 'social') {
    selectedExtension = null;
    if (typeof initSocial === 'function') {
      initSocial();
    }
  } else if (tab === 'chat') {
    selectedExtension = null;
    if (typeof initChat === 'function') {
      initChat();
    }
  } else if (tab === 'assets') {
    selectedExtension = null;
    if (typeof initAssets === 'function') {
      initAssets();
    }
  } else if (tab === 'storyboard') {
    selectedExtension = null;
    if (typeof initStoryboard === 'function') {
      initStoryboard();
    }
  } else if (tab === 'mcp') {
    selectedExtension = null;
    if (typeof initMcp === 'function') {
      initMcp();
    }
  }
}

// ── Deeplinking ──────────────────────────────────────────────
// Hash format: #tab/workflowId/detailView
// Examples: #workflows, #workflows/abc123, #workflows/abc123/model

function updateHash(tab, workflowId, view) {
  var parts = [tab || currentTab];
  if (workflowId) {
    parts.push(workflowId);
    if (view && view !== 'visual') parts.push(view);
  }
  var newHash = '#' + parts.join('/');
  if (window.location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

function parseHash() {
  var hash = window.location.hash.replace(/^#/, '');
  if (!hash) return { tab: 'home' };
  var parts = hash.split('/');
  return {
    tab: parts[0] || 'home',
    workflowId: parts[1] || null,
    view: parts[2] || null,
  };
}

function handleHash() {
  var state = parseHash();
  var validTabs = ['home', 'chat', 'workflows', 'compositions', 'runs', 'training', 'marketplace', 'social', 'assets', 'storyboard', 'mcp'];
  var tab = validTabs.indexOf(state.tab) !== -1 ? state.tab : 'home';

  // Only switch tab if it changed
  if (tab !== currentTab) {
    switchTab(tab, { _fromHash: true });
  }

  // If workflows tab with a workflow ID, select it
  if (tab === 'workflows' && state.workflowId) {
    // Set detailView before selectWorkflow so it renders the right tab
    if (state.view && typeof detailView !== 'undefined') {
      detailView = state.view;
    }
    if (typeof selectWorkflow === 'function' && selectedWorkflow !== state.workflowId) {
      selectWorkflow(state.workflowId);
    }
  }

  // If compositions tab with a composition ID, select it
  if (tab === 'compositions' && state.workflowId) {
    if (typeof selectComposition === 'function' && (selectedComposition !== state.workflowId || state.view === 'form' || document.body.classList.contains('composition-form-mode'))) {
      selectComposition(state.workflowId, state.view || null);
    }
  }
}

window.addEventListener('hashchange', handleHash);

// ── Update Check ─────────────────────────────────────────────
async function checkForUpdates() {
  try {
    var res = await fetch('/api/app/update-check');
    var data = await res.json();

    // Show current version in sidebar
    var versionEl = document.getElementById('sidebar-version');
    if (versionEl && data.currentVersion && data.currentVersion !== '?.?.?') {
      versionEl.textContent = 'v' + data.currentVersion;
    }

    // Show update banner if available
    if (data.updateAvailable) {
      var banner = document.getElementById('update-banner');
      if (banner) {
        banner.style.display = '';
        banner.className = 'update-banner';
        banner.innerHTML =
          '<strong>Update available:</strong> v' + data.latestVersion +
          (data.releaseNotes ? ' &mdash; ' + data.releaseNotes : '') +
          '<br><button onclick="installUpdate(this)" class="update-btn">Install update &rarr;</button>';
      }
    }
  } catch (e) {
    // Silently fail — update check is non-critical
  }
}

async function installUpdate(btn) {
  btn.disabled = true;
  btn.textContent = 'Installing...';
  try {
    var res = await fetch('/api/app/update-install', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) {
      btn.textContent = 'Failed — try again';
      btn.disabled = false;
      return;
    }
    btn.textContent = 'Downloading — check title bar for progress...';
  } catch (e) {
    btn.textContent = 'Failed — try again';
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Restore state from hash on initial load
  var state = parseHash();
  var validTabs = ['home', 'chat', 'workflows', 'compositions', 'runs', 'training', 'marketplace', 'social', 'assets', 'storyboard', 'mcp'];
  var initialTab = validTabs.indexOf(state.tab) !== -1 ? state.tab : 'home';

  // Set detailView early so workflow render picks it up
  if (state.view && typeof detailView !== 'undefined') {
    detailView = state.view;
  }

  switchTab(initialTab, { _fromHash: true, view: state.view || null, workflowId: state.workflowId || null });

  // After switchTab inits workflows and fetches the list, select the workflow
  if (initialTab === 'workflows' && state.workflowId) {
    // Wait for fetchWorkflows to complete before selecting
    var checkReady = setInterval(function() {
      if (typeof workflows !== 'undefined' && workflows.length > 0) {
        clearInterval(checkReady);
        selectWorkflow(state.workflowId);
      }
    }, 100);
    // Safety timeout — stop waiting after 5s
    setTimeout(function() { clearInterval(checkReady); }, 5000);
  }

  // After switchTab inits compositions and fetches the list, select the composition
  if (initialTab === 'compositions' && state.workflowId) {
    var checkCompReady = setInterval(function() {
      if (typeof compositions !== 'undefined' && compositions.length > 0) {
        clearInterval(checkCompReady);
        selectComposition(state.workflowId, state.view || null);
      }
    }, 100);
    setTimeout(function() { clearInterval(checkCompReady); }, 5000);
  }

  // Check for app updates
  checkForUpdates();
});

// ── Bridge Status Polling ────────────────────────────────────

var _bridgeConnected = false;
var _bridgeDismissed = false;
var _bridgeExtensionPath = '';
var _bridgeFirstConnect = true;

async function checkBridgeStatus() {
  try {
    var res = await fetch('/api/bridge/status');
    var data = await res.json();
    var wasConnected = _bridgeConnected;
    _bridgeConnected = data.extensionConnected;
    _bridgeExtensionPath = data.extensionPath || '';

    // Update sidebar dot
    var dot = document.getElementById('bridge-dot');
    var text = document.getElementById('bridge-text');
    if (dot && text) {
      if (_bridgeConnected) {
        dot.className = 'status-dot connected';
        text.textContent = 'Extension connected';
      } else {
        dot.className = 'status-dot disconnected';
        text.textContent = 'Extension not connected';
      }
    }

    // Update banner
    var banner = document.getElementById('setup-banner');
    var disconnectedEl = document.getElementById('banner-disconnected');
    var connectedEl = document.getElementById('banner-connected');
    if (banner && disconnectedEl && connectedEl) {
      if (_bridgeConnected) {
        disconnectedEl.style.display = 'none';
        connectedEl.style.display = '';
        banner.classList.add('connected-state');
        banner.classList.remove('hidden');
        // Auto-hide connected banner after 5s
        setTimeout(function() {
          banner.classList.add('hidden');
        }, 5000);
        // Show toast on first connection
        if (!wasConnected && !_bridgeFirstConnect) {
          toast('Chrome extension connected', 'success');
        }
      } else if (!_bridgeDismissed) {
        disconnectedEl.style.display = '';
        connectedEl.style.display = 'none';
        banner.classList.remove('connected-state');
        banner.classList.remove('hidden');
      }
    }

    // Fill in extension path
    var pathEl = document.getElementById('copy-ext-path');
    if (pathEl && _bridgeExtensionPath) {
      pathEl.textContent = _bridgeExtensionPath;
    }

    _bridgeFirstConnect = false;
  } catch (e) {
    // Silently ignore — dashboard server may not be ready yet
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Dismiss button
  var dismissBtn = document.getElementById('banner-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function() {
      _bridgeDismissed = true;
      var banner = document.getElementById('setup-banner');
      if (banner) banner.classList.add('hidden');
    });
  }

  // Toggle manual install steps
  var manualBtn = document.getElementById('btn-manual-install');
  if (manualBtn) {
    manualBtn.addEventListener('click', function() {
      var steps = document.getElementById('manual-steps');
      if (steps) steps.classList.toggle('visible');
    });
  }

  // Copy-to-clipboard for code elements in manual steps
  var copyPath = document.getElementById('copy-ext-path');
  if (copyPath) {
    copyPath.addEventListener('click', function() {
      if (navigator.clipboard && copyPath.textContent) {
        navigator.clipboard.writeText(copyPath.textContent).then(function() {
          toast('Path copied to clipboard', 'success');
        });
      }
    });
  }
  var copyUrl = document.getElementById('copy-ext-url');
  if (copyUrl) {
    copyUrl.addEventListener('click', function() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText('chrome://extensions').then(function() {
          toast('Copied to clipboard', 'success');
        });
      }
    });
  }

  // Start polling
  checkBridgeStatus();
  setInterval(checkBridgeStatus, 3000);
});

// ── Init ─────────────────────────────────────────────────────
