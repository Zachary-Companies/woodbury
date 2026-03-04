/**
 * Marketplace — Client-side JavaScript
 *
 * Browse, install, and uninstall extensions from the Woodbury registry.
 * Loaded alongside app.js in the same SPA.
 */

// ── State ────────────────────────────────────────────────────
let marketplaceRegistry = null;
let marketplaceInstalled = [];
let marketplaceCategory = 'all';
let marketplaceSearch = '';
let marketplaceLoading = false;

// ── API ──────────────────────────────────────────────────────

async function fetchMarketplaceRegistry() {
  const res = await fetch('/api/marketplace/registry');
  if (!res.ok) throw new Error('Failed to load registry');
  return res.json();
}

async function fetchInstalledExtensions() {
  const res = await fetch('/api/extensions');
  if (!res.ok) throw new Error('Failed to load installed extensions');
  const data = await res.json();
  return Array.isArray(data) ? data : (data.extensions || []);
}

async function installExtension(name, gitUrl) {
  const res = await fetch('/api/marketplace/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, gitUrl }),
  });
  return res.json();
}

async function uninstallExtension(name) {
  const res = await fetch('/api/marketplace/uninstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

// ── Icons ────────────────────────────────────────────────────

const marketplaceIcons = {
  image: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"/></svg>',
  audio: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"/></svg>',
  share: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"/></svg>',
  video: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9.75a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25H4.5A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/></svg>',
  calendar: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>',
  music: '<svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z"/></svg>',
};

const provideIcons = {
  tools: '&#x1f527;',
  commands: '&#x2318;',
  prompts: '&#x1f4ac;',
  webui: '&#x1f310;',
};

// ── Init ─────────────────────────────────────────────────────

async function initMarketplace() {
  renderMarketplaceSidebar();
  renderMarketplaceMain('loading');

  try {
    const [registry, installed] = await Promise.all([
      fetchMarketplaceRegistry(),
      fetchInstalledExtensions(),
    ]);
    marketplaceRegistry = registry;
    marketplaceInstalled = installed;
    renderMarketplaceSidebar();
    renderMarketplaceMain();
  } catch (err) {
    renderMarketplaceMain('error', err.message);
  }
}

// ── Sidebar ──────────────────────────────────────────────────

function renderMarketplaceSidebar() {
  var list = document.getElementById('marketplace-list');
  if (!list) return;

  if (!marketplaceRegistry) {
    list.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
    return;
  }

  var html = '';

  // Search box
  html += '<div style="padding:8px 12px;">';
  html += '<input type="text" id="mp-search" placeholder="Search extensions..." value="' + escapeHtml(marketplaceSearch) + '" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
  html += '</div>';

  // Category filters
  html += '<div style="padding:4px 12px 8px;">';
  var cats = marketplaceRegistry.categories || [];
  for (var i = 0; i < cats.length; i++) {
    var cat = cats[i];
    var active = marketplaceCategory === cat.id;
    html += '<button class="mp-cat-btn' + (active ? ' active' : '') + '" data-cat="' + cat.id + '" style="display:block;width:100%;text-align:left;padding:6px 10px;margin:2px 0;border-radius:6px;border:none;cursor:pointer;font-size:13px;' +
      (active ? 'background:rgba(139,92,246,0.2);color:#c4b5fd;' : 'background:transparent;color:#94a3b8;') +
      '">' + escapeHtml(cat.label) + '</button>';
  }
  html += '</div>';

  // Extension count
  var filtered = getFilteredExtensions();
  html += '<div style="padding:4px 12px;color:#64748b;font-size:12px;">' + filtered.length + ' extension' + (filtered.length !== 1 ? 's' : '') + '</div>';

  // Extension list
  for (var j = 0; j < filtered.length; j++) {
    var ext = filtered[j];
    var isInstalled = isExtensionInstalled(ext.name);
    html += '<div class="sidebar-item' + (isInstalled ? ' installed' : '') + '" data-mp-name="' + ext.name + '" style="padding:8px 12px;cursor:pointer;border-left:3px solid transparent;">';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<span style="color:#a78bfa;flex-shrink:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center;">' + (marketplaceIcons[ext.icon] || marketplaceIcons.image) + '</span>';
    html += '<div style="min-width:0;">';
    html += '<div style="font-size:13px;font-weight:500;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(ext.displayName) + '</div>';
    html += '<div style="font-size:11px;color:#64748b;">' + (isInstalled ? '&#x2714; Installed' : 'v' + ext.version) + '</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
  }

  list.innerHTML = html;

  // Bind events
  var searchInput = document.getElementById('mp-search');
  if (searchInput) {
    searchInput.addEventListener('input', function(e) {
      marketplaceSearch = e.target.value;
      renderMarketplaceSidebar();
      renderMarketplaceMain();
    });
  }

  list.querySelectorAll('.mp-cat-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      marketplaceCategory = btn.dataset.cat;
      renderMarketplaceSidebar();
      renderMarketplaceMain();
    });
  });

  list.querySelectorAll('[data-mp-name]').forEach(function(item) {
    item.addEventListener('click', function() {
      var ext = findExtension(item.dataset.mpName);
      if (ext) renderMarketplaceDetail(ext);
    });
  });
}

// ── Main Panel ───────────────────────────────────────────────

function renderMarketplaceMain(state, message) {
  var main = document.getElementById('main');
  if (!main) return;

  if (state === 'loading') {
    main.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto 16px;"></div><h2>Loading Marketplace</h2><p>Fetching extension registry...</p></div>';
    return;
  }

  if (state === 'error') {
    main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x26a0;</div><h2>Failed to Load</h2><p>' + escapeHtml(message || 'Unknown error') + '</p><button class="btn-primary" onclick="initMarketplace()" style="margin-top:12px;">Retry</button></div>';
    return;
  }

  if (!marketplaceRegistry) return;

  var filtered = getFilteredExtensions();

  if (filtered.length === 0) {
    main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1f50d;</div><h2>No Extensions Found</h2><p>No extensions match your search.</p></div>';
    return;
  }

  var html = '<div style="padding:24px;">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
  html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">Extension Marketplace</h2>';
  html += '<span style="color:#64748b;font-size:13px;">' + filtered.length + ' available</span>';
  html += '</div>';

  // Grid
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">';

  for (var i = 0; i < filtered.length; i++) {
    var ext = filtered[i];
    var installed = isExtensionInstalled(ext.name);

    html += '<div class="mp-card" data-mp-card="' + ext.name + '" style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;cursor:pointer;transition:border-color 0.15s;">';

    // Header
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">';
    html += '<div style="width:40px;height:40px;border-radius:10px;background:rgba(139,92,246,0.15);display:flex;align-items:center;justify-content:center;color:#a78bfa;flex-shrink:0;">' + (marketplaceIcons[ext.icon] || marketplaceIcons.image) + '</div>';
    html += '<div style="min-width:0;">';
    html += '<div style="font-size:15px;font-weight:600;color:#e2e8f0;">' + escapeHtml(ext.displayName) + '</div>';
    html += '<div style="font-size:12px;color:#64748b;">v' + ext.version + ' &middot; ' + escapeHtml(ext.author) + '</div>';
    html += '</div>';
    if (installed) {
      html += '<span style="margin-left:auto;background:rgba(34,197,94,0.15);color:#4ade80;font-size:11px;padding:2px 8px;border-radius:99px;">Installed</span>';
    }
    html += '</div>';

    // Description
    html += '<p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0 0 12px;">' + escapeHtml(ext.description) + '</p>';

    // Provides badges
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px;">';
    for (var p = 0; p < ext.provides.length; p++) {
      html += '<span style="font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.2);color:#c4b5fd;">' + escapeHtml(ext.provides[p]) + '</span>';
    }
    html += '</div>';

    // Action button
    if (installed) {
      html += '<button class="mp-remove-btn btn-secondary" data-mp-remove="' + ext.name + '" style="width:100%;padding:8px;border-radius:8px;font-size:13px;">Remove</button>';
    } else {
      html += '<button class="mp-install-btn btn-primary" data-mp-install="' + ext.name + '" data-mp-git="' + escapeHtml(ext.gitUrl) + '" style="width:100%;padding:8px;border-radius:8px;font-size:13px;">Install</button>';
    }

    html += '</div>';
  }

  html += '</div>';
  html += '</div>';

  main.innerHTML = html;

  // Bind card clicks
  main.querySelectorAll('.mp-card').forEach(function(card) {
    card.addEventListener('click', function(e) {
      // Don't navigate if clicking a button
      if (e.target.closest('button')) return;
      var ext = findExtension(card.dataset.mpCard);
      if (ext) renderMarketplaceDetail(ext);
    });
  });

  // Bind install buttons
  main.querySelectorAll('.mp-install-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleInstall(btn);
    });
  });

  // Bind remove buttons
  main.querySelectorAll('.mp-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleUninstall(btn);
    });
  });
}

// ── Detail View ──────────────────────────────────────────────

function renderMarketplaceDetail(ext) {
  var main = document.getElementById('main');
  if (!main) return;

  var installed = isExtensionInstalled(ext.name);

  var html = '<div style="padding:24px;max-width:720px;">';

  // Back button
  html += '<button onclick="renderMarketplaceMain()" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">';
  html += '<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>';
  html += 'Back to marketplace</button>';

  // Header
  html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">';
  html += '<div style="width:56px;height:56px;border-radius:14px;background:rgba(139,92,246,0.15);display:flex;align-items:center;justify-content:center;color:#a78bfa;flex-shrink:0;">' + (marketplaceIcons[ext.icon] || marketplaceIcons.image) + '</div>';
  html += '<div>';
  html += '<h2 style="margin:0 0 4px;font-size:22px;font-weight:600;color:#e2e8f0;">' + escapeHtml(ext.displayName) + '</h2>';
  html += '<div style="color:#64748b;font-size:13px;">v' + ext.version + ' &middot; By ' + escapeHtml(ext.author) + '</div>';
  html += '</div>';
  if (installed) {
    html += '<span style="margin-left:auto;background:rgba(34,197,94,0.15);color:#4ade80;font-size:12px;padding:4px 12px;border-radius:99px;">Installed</span>';
  }
  html += '</div>';

  // Description
  html += '<div style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;margin-bottom:16px;">';
  html += '<h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#e2e8f0;">About</h3>';
  html += '<p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0;">' + escapeHtml(ext.description) + '</p>';
  html += '</div>';

  // Details grid
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">';

  // Provides
  html += '<div style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;">';
  html += '<h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#e2e8f0;">Provides</h3>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
  for (var p = 0; p < ext.provides.length; p++) {
    html += '<span style="font-size:12px;padding:4px 10px;border-radius:99px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.2);color:#c4b5fd;">' + escapeHtml(ext.provides[p]) + '</span>';
  }
  html += '</div>';
  html += '</div>';

  // Platforms
  html += '<div style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;">';
  html += '<h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#e2e8f0;">Platforms</h3>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
  var platLabels = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  for (var pl = 0; pl < ext.platforms.length; pl++) {
    html += '<span style="font-size:12px;padding:4px 10px;border-radius:99px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;">' + (platLabels[ext.platforms[pl]] || ext.platforms[pl]) + '</span>';
  }
  html += '</div>';
  html += '</div>';

  html += '</div>';

  // Tags
  if (ext.tags && ext.tags.length) {
    html += '<div style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;margin-bottom:16px;">';
    html += '<h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:#e2e8f0;">Tags</h3>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    for (var t = 0; t < ext.tags.length; t++) {
      html += '<span style="font-size:12px;padding:4px 10px;border-radius:99px;background:rgba(255,255,255,0.05);color:#94a3b8;">' + escapeHtml(ext.tags[t]) + '</span>';
    }
    html += '</div>';
    html += '</div>';
  }

  // Actions
  html += '<div style="display:flex;gap:12px;margin-top:24px;">';
  if (installed) {
    html += '<button class="mp-remove-btn btn-secondary" data-mp-remove="' + ext.name + '" style="padding:10px 24px;border-radius:8px;font-size:14px;">Remove Extension</button>';
  } else {
    html += '<button class="mp-install-btn btn-primary" data-mp-install="' + ext.name + '" data-mp-git="' + escapeHtml(ext.gitUrl) + '" style="padding:10px 24px;border-radius:8px;font-size:14px;">Install Extension</button>';
  }
  if (ext.repoUrl) {
    html += '<a href="' + escapeHtml(ext.repoUrl) + '" target="_blank" style="padding:10px 24px;border-radius:8px;font-size:14px;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;text-decoration:none;display:flex;align-items:center;gap:6px;">View Source</a>';
  }
  html += '</div>';

  // Manual install
  html += '<div style="margin-top:16px;padding:16px;border-radius:8px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.05);">';
  html += '<div style="font-size:12px;color:#64748b;margin-bottom:6px;">Manual install via terminal:</div>';
  html += '<code style="font-size:13px;color:#c4b5fd;word-break:break-all;">woodbury ext install-git ' + escapeHtml(ext.gitUrl) + '</code>';
  html += '</div>';

  html += '</div>';

  main.innerHTML = html;

  // Bind buttons
  main.querySelectorAll('.mp-install-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { handleInstall(btn); });
  });
  main.querySelectorAll('.mp-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { handleUninstall(btn); });
  });
}

// ── Install / Uninstall Handlers ─────────────────────────────

async function handleInstall(btn) {
  var name = btn.dataset.mpInstall;
  var gitUrl = btn.dataset.mpGit;
  if (!name || !gitUrl) return;

  btn.disabled = true;
  var origText = btn.textContent;
  btn.textContent = 'Installing...';
  btn.style.opacity = '0.7';

  try {
    var result = await installExtension(name, gitUrl);
    if (result.success) {
      btn.textContent = 'Installed!';
      btn.style.background = 'rgba(34,197,94,0.2)';
      btn.style.color = '#4ade80';
      btn.style.borderColor = 'rgba(34,197,94,0.3)';
      // Refresh installed list
      marketplaceInstalled = await fetchInstalledExtensions();
      // Re-render after brief delay
      setTimeout(function() {
        renderMarketplaceSidebar();
        renderMarketplaceMain();
      }, 1500);
    } else {
      btn.textContent = result.error || 'Install failed';
      btn.style.background = 'rgba(239,68,68,0.2)';
      btn.style.color = '#f87171';
      setTimeout(function() {
        btn.textContent = origText;
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
        btn.style.opacity = '';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Error: ' + err.message;
    btn.style.color = '#f87171';
    setTimeout(function() {
      btn.textContent = origText;
      btn.style.background = '';
      btn.style.color = '';
      btn.style.opacity = '';
      btn.disabled = false;
    }, 3000);
  }
}

async function handleUninstall(btn) {
  var name = btn.dataset.mpRemove;
  if (!name) return;

  if (!confirm('Remove "' + name + '"? This will delete the extension files.')) return;

  btn.disabled = true;
  btn.textContent = 'Removing...';
  btn.style.opacity = '0.7';

  try {
    var result = await uninstallExtension(name);
    if (result.success) {
      btn.textContent = 'Removed!';
      // Refresh installed list
      marketplaceInstalled = await fetchInstalledExtensions();
      // Re-render after brief delay
      setTimeout(function() {
        renderMarketplaceSidebar();
        renderMarketplaceMain();
      }, 1000);
    } else {
      btn.textContent = result.error || 'Remove failed';
      setTimeout(function() {
        btn.textContent = 'Remove';
        btn.style.opacity = '';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(function() {
      btn.textContent = 'Remove';
      btn.style.opacity = '';
      btn.disabled = false;
    }, 3000);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function getFilteredExtensions() {
  if (!marketplaceRegistry || !marketplaceRegistry.extensions) return [];

  return marketplaceRegistry.extensions.filter(function(ext) {
    if (marketplaceCategory !== 'all' && ext.category !== marketplaceCategory) return false;
    if (marketplaceSearch) {
      var q = marketplaceSearch.toLowerCase();
      return (
        ext.displayName.toLowerCase().indexOf(q) !== -1 ||
        ext.description.toLowerCase().indexOf(q) !== -1 ||
        (ext.tags && ext.tags.some(function(t) { return t.toLowerCase().indexOf(q) !== -1; }))
      );
    }
    return true;
  });
}

function isExtensionInstalled(name) {
  return marketplaceInstalled.some(function(inst) {
    return inst.name === name || inst.name === 'woodbury-ext-' + name;
  });
}

function findExtension(name) {
  if (!marketplaceRegistry) return null;
  return marketplaceRegistry.extensions.find(function(e) { return e.name === name; }) || null;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
