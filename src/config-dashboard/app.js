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

function toast(message, type) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── API ──────────────────────────────────────────────────────

async function fetchExtensions() {
  try {
    const res = await fetch('/api/extensions');
    const data = await res.json();
    extensions = data.extensions || [];
    renderSidebar();
    // Re-select current extension if still present
    if (selectedExtension) {
      const still = extensions.find(e => e.name === selectedExtension);
      if (still) selectExtension(still.name);
    }
  } catch (err) {
    $('#ext-list').innerHTML =
      '<div style="padding:1rem;color:#ef4444;font-size:0.8rem;">Failed to load extensions.</div>';
  }
}

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

// ── Sidebar ──────────────────────────────────────────────────

function getExtBadge(ext) {
  const total = ext.vars.length;
  if (total === 0) return { cls: 'badge-ok', text: 'No keys' };
  const set = ext.vars.filter(v => v.isSet).length;
  const requiredMissing = ext.vars.filter(v => v.required && !v.isSet).length;
  if (requiredMissing > 0) return { cls: 'badge-missing', text: requiredMissing + ' missing' };
  if (set === total) return { cls: 'badge-ok', text: 'All set' };
  return { cls: 'badge-partial', text: set + '/' + total + ' set' };
}

function renderSidebar() {
  const list = $('#ext-list');
  if (extensions.length === 0) {
    list.innerHTML =
      '<div style="padding:1rem;color:#64748b;font-size:0.8rem;">No extensions installed.</div>';
    return;
  }

  list.innerHTML = extensions.map(ext => {
    const badge = getExtBadge(ext);
    const active = selectedExtension === ext.name ? ' active' : '';
    const hasWebUI = (ext.webUIs || []).length > 0;
    return '<div class="ext-item' + active + '" data-name="' + ext.name + '">' +
      '<div class="ext-item-name">' + escHtml(ext.displayName || ext.name) + '</div>' +
      '<div class="ext-item-meta">v' + escHtml(ext.version) + ' &middot; ' + escHtml(ext.source) + '</div>' +
      '<div class="ext-item-badges">' +
        '<span class="badge ' + badge.cls + '">' + badge.text + '</span>' +
        (hasWebUI ? '<span class="badge badge-webui">&#x1f310; Web UI</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  // Click handlers
  list.querySelectorAll('.ext-item').forEach(el => {
    el.addEventListener('click', () => selectExtension(el.dataset.name));
  });
}

// ── Main Content ─────────────────────────────────────────────

async function selectExtension(name) {
  selectedExtension = name;

  // Update sidebar active state
  document.querySelectorAll('.ext-item').forEach(el => {
    el.classList.toggle('active', el.dataset.name === name);
  });

  const main = $('#main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  try {
    const ext = await fetchExtensionEnv(name);
    renderExtension(ext);
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">&#x26a0;&#xfe0f;</div>' +
      '<h2>Error</h2><p>' + escHtml(err.message) + '</p></div>';
  }
}

function renderExtension(ext) {
  const main = $('#main');
  const vars = ext.vars || [];

  let html = '';

  // Header
  html += '<div class="ext-header">';
  html += '<h2>' + escHtml(ext.displayName || ext.name) + '</h2>';
  html += '<div class="ext-header-meta">';
  html += escHtml(ext.description || '') + '<br>';
  html += '<code style="color:#475569;font-size:0.7rem;">' + escHtml(ext.directory) + '</code>';
  html += '</div></div>';

  // Web UI section (if extension has web UIs)
  const webUIs = ext.webUIs || [];
  if (webUIs.length > 0) {
    html += '<div class="webui-section">';
    html += '<div class="webui-section-header">';
    html += '<span>&#x1f310;</span> Web Dashboard';
    html += '</div>';
    for (const url of webUIs) {
      html += '<div class="webui-link-row">';
      html += '<div class="webui-status"><span class="webui-status-dot"></span> Running</div>';
      html += '<span class="webui-url">' + escHtml(url) + '</span>';
      html += '<button class="btn-launch" data-url="' + escAttr(url) + '">';
      html += '&#x1f680; Open Dashboard';
      html += '</button>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Restart notice
  html += '<div class="restart-notice">';
  html += '<span>&#x1f504;</span> Changes take effect after restarting Woodbury.';
  html += '</div>';

  if (vars.length === 0) {
    html += '<div style="color:#64748b;padding:2rem;text-align:center;">';
    html += 'This extension has no declared environment variables.';
    html += '</div>';
  } else {
    // Var cards
    for (const v of vars) {
      const isPath = v.type === 'path';

      html += '<div class="var-card" data-var="' + escAttr(v.name) + '">';
      html += '<div class="var-header">';
      html += '<span class="var-name">' + escHtml(v.name) + '</span>';
      html += v.required
        ? '<span class="var-badge var-badge-required">required</span>'
        : '<span class="var-badge var-badge-optional">optional</span>';
      html += v.isSet
        ? '<span class="var-badge var-badge-set">set</span>'
        : '<span class="var-badge var-badge-unset">not set</span>';
      html += '</div>';

      if (v.description) {
        html += '<div class="var-description">' + escHtml(v.description) + '</div>';
      }

      html += '<div class="var-input-row">';

      if (isPath) {
        // Path-type: text input (not password) + Browse button
        const currentValue = v.rawValue || '';
        html += '<input class="var-input" type="text" name="' + escAttr(v.name) + '"';
        html += ' value="' + escAttr(currentValue) + '"';
        html += ' placeholder="' + (currentValue ? escAttr(currentValue) : '/path/to/folder') + '"';
        html += ' autocomplete="off">';
        html += '<button class="btn-browse" data-for="' + escAttr(v.name) + '" title="Browse folders">Browse</button>';
      } else {
        // Secret-type: password input + toggle
        html += '<input class="var-input" type="password" name="' + escAttr(v.name) + '"';
        html += ' placeholder="' + (v.maskedValue ? escAttr(v.maskedValue) : 'Enter value...') + '"';
        html += ' autocomplete="off">';
        html += '<button class="btn-toggle" title="Toggle visibility" data-for="' + escAttr(v.name) + '">&#x1f441;</button>';
      }

      if (v.isSet) {
        html += '<button class="btn-clear" title="Remove this value" data-clear="' + escAttr(v.name) + '">&#x2715;</button>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Save button
    html += '<div class="save-row">';
    html += '<button class="btn-save" id="btn-save">Save Changes</button>';
    html += '<span class="save-status" id="save-status"></span>';
    html += '</div>';
  }

  main.innerHTML = html;

  // Wire up launch buttons (web UI links)
  main.querySelectorAll('.btn-launch').forEach(btn => {
    btn.addEventListener('click', () => {
      window.open(btn.dataset.url, '_blank');
    });
  });

  // Wire up toggle buttons (secret-type vars)
  main.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = main.querySelector('input[name="' + btn.dataset.for + '"]');
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });
  });

  // Wire up browse buttons (path-type vars)
  main.querySelectorAll('.btn-browse').forEach(btn => {
    btn.addEventListener('click', () => {
      const inputName = btn.dataset.for;
      const input = main.querySelector('input[name="' + inputName + '"]');
      const startDir = (input && input.value.trim()) || '';
      openFolderPicker(inputName, startDir);
    });
  });

  // Wire up clear buttons
  main.querySelectorAll('.btn-clear').forEach(btn => {
    btn.addEventListener('click', async () => {
      const varName = btn.dataset.clear;
      if (!confirm('Remove ' + varName + '?')) return;
      try {
        const vars = {};
        vars[varName] = '';
        await saveExtensionEnv(ext.name, vars);
        toast(varName + ' removed', 'success');
        await fetchExtensions();
        selectExtension(ext.name);
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
      }
    });
  });

  // Wire up save button
  const saveBtn = $('#btn-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const inputs = main.querySelectorAll('.var-input');
      const vars = {};
      let count = 0;
      inputs.forEach(input => {
        if (input.value.trim()) {
          vars[input.name] = input.value.trim();
          count++;
        }
      });

      if (count === 0) {
        toast('No changes to save', 'error');
        return;
      }

      saveBtn.disabled = true;
      $('#save-status').textContent = 'Saving...';

      try {
        await saveExtensionEnv(ext.name, vars);
        toast(count + ' value(s) saved', 'success');
        // Clear secret inputs only (not path inputs that show their value)
        inputs.forEach(input => {
          if (input.type === 'password') input.value = '';
        });
        await fetchExtensions();
        selectExtension(ext.name);
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
      } finally {
        saveBtn.disabled = false;
        $('#save-status').textContent = '';
      }
    });
  }
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

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#folder-modal').classList.contains('open')) {
      closeFolderPicker();
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

// ── Nav Tabs ─────────────────────────────────────────────────

let currentTab = 'config';

function switchTab(tab) {
  currentTab = tab;

  // Update tab buttons
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Toggle sidebar panels
  document.querySelectorAll('[data-panel]').forEach(panel => {
    panel.style.display = panel.dataset.panel === tab ? '' : 'none';
  });

  // Show appropriate empty state or content
  const main = $('#main');

  if (tab === 'config') {
    selectedExtension = null;
    main.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon">&#x1f511;</div>' +
      '<h2>Extension Config Dashboard</h2>' +
      '<p>Select an extension from the sidebar to manage its API keys.</p>' +
      '</div>';
  } else if (tab === 'workflows') {
    selectedExtension = null;
    // Workflows module handles its own rendering
    if (typeof initWorkflows === 'function') {
      initWorkflows();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
});

// ── Init ─────────────────────────────────────────────────────
fetchExtensions();
