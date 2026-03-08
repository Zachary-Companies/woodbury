// ── Assets Tab ──────────────────────────────────────────────────
// Visual asset manager for browsing, organizing, and editing assets.
// Reads from the same data files as the creator-assets extension.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var assetsData = [];
  var collectionsData = [];
  var defaultsData = {};
  var assetsDataDir = '';
  var assetsCategory = '';
  var assetsCollection = '';
  var assetsSearch = '';
  var selectedAssetId = null;
  var assetsView = 'grid'; // 'grid', 'detail', 'settings', 'import'
  var assetsInitialized = false;

  // ── Init ───────────────────────────────────────────────────

  async function initAssets() {
    var main = document.getElementById('main');
    if (!main) return;

    if (assetsInitialized && assetsView === 'grid' && main.querySelector('.assets-grid-container')) return;

    main.innerHTML = '';
    main.style.display = '';
    main.style.flexDirection = '';

    await loadAssetsData();
    renderAssetsSidebar();
    renderAssetsMain();

    assetsInitialized = true;
  }

  // ── Data Loading ───────────────────────────────────────────

  async function loadAssetsData() {
    try {
      var results = await Promise.all([
        fetch('/api/assets').then(function (r) { return r.json(); }),
        fetch('/api/assets/collections').then(function (r) { return r.json(); }),
        fetch('/api/assets/defaults').then(function (r) { return r.json(); }),
        fetch('/api/assets/settings').then(function (r) { return r.json(); }),
      ]);
      assetsData = results[0].assets || [];
      assetsDataDir = results[0].dataDir || '';
      collectionsData = results[1].collections || [];
      defaultsData = results[2].defaults || {};
    } catch (err) {
      console.error('Failed to load assets:', err);
    }
  }

  // ── Sidebar ────────────────────────────────────────────────

  function renderAssetsSidebar() {
    var list = document.getElementById('assets-list');
    if (!list) return;

    var html = '';

    // Search
    html += '<div style="padding:8px;">';
    html += '<input type="text" id="assets-search" placeholder="Search assets..." value="' + escAttr(assetsSearch) + '" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    // Categories
    html += '<div style="padding:4px 8px 8px;">';
    html += '<div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Category</div>';
    var cats = [
      { id: '', label: 'All' },
      { id: 'image', label: 'Images' },
      { id: 'video', label: 'Video' },
      { id: 'audio', label: 'Audio' },
      { id: 'text', label: 'Text' },
      { id: 'document', label: 'Documents' },
    ];
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    for (var i = 0; i < cats.length; i++) {
      var active = assetsCategory === cats[i].id;
      html += '<button class="assets-cat-btn' + (active ? ' active' : '') + '" data-cat="' + cats[i].id + '" style="padding:3px 8px;border-radius:4px;font-size:0.7rem;border:1px solid ' + (active ? '#7c3aed' : 'rgba(255,255,255,0.1)') + ';background:' + (active ? 'rgba(124,58,237,0.2)' : 'transparent') + ';color:' + (active ? '#a78bfa' : '#94a3b8') + ';cursor:pointer;">' + cats[i].label + '</button>';
    }
    html += '</div></div>';

    // Collections
    html += '<div style="padding:4px 8px;border-top:1px solid #334155;margin-top:4px;">';
    html += '<div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;font-weight:600;margin:8px 0 4px;">Collections</div>';

    var allActive = !assetsCollection;
    html += '<div class="assets-col-item' + (allActive ? ' active' : '') + '" data-col="" style="padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;color:' + (allActive ? '#a78bfa' : '#e2e8f0') + ';background:' + (allActive ? 'rgba(124,58,237,0.15)' : 'transparent') + ';">All Assets <span style="color:#64748b;">(' + assetsData.length + ')</span></div>';

    for (var j = 0; j < collectionsData.length; j++) {
      var col = collectionsData[j];
      var colActive = assetsCollection === col.slug;
      var rootIcon = col.rootPath ? ' <span title="Root: ' + escAttr(col.rootPath) + '" style="color:#22c55e;font-size:9px;">&#x1f4c1;</span>' : '';
      html += '<div class="assets-col-item' + (colActive ? ' active' : '') + '" data-col="' + escAttr(col.slug) + '" style="padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;color:' + (colActive ? '#a78bfa' : '#e2e8f0') + ';background:' + (colActive ? 'rgba(124,58,237,0.15)' : 'transparent') + ';display:flex;align-items:center;justify-content:space-between;">'
        + '<span>' + escHtml(col.name) + rootIcon + ' <span style="color:#64748b;">(' + (col.asset_count || 0) + ')</span></span>'
        + '<span class="assets-col-gear" data-col-slug="' + escAttr(col.slug) + '" style="opacity:0;font-size:11px;color:#64748b;transition:opacity 0.15s;" title="Collection settings">&#9881;</span>'
        + '</div>';
    }

    html += '<div class="assets-new-col" style="padding:4px 8px;cursor:pointer;font-size:0.75rem;color:#7c3aed;margin-top:4px;">+ New Collection</div>';
    html += '</div>';

    // Defaults
    var defaultKeys = Object.keys(defaultsData);
    if (defaultKeys.length > 0) {
      html += '<div style="padding:4px 8px;border-top:1px solid #334155;margin-top:4px;">';
      html += '<div style="font-size:0.7rem;color:#64748b;text-transform:uppercase;font-weight:600;margin:8px 0 4px;">Defaults</div>';
      for (var k = 0; k < defaultKeys.length; k++) {
        var role = defaultKeys[k];
        var def = defaultsData[role];
        html += '<div style="padding:2px 8px;font-size:0.75rem;color:#94a3b8;"><span style="color:#64748b;">' + escHtml(role) + ':</span> ' + escHtml(def.name) + '</div>';
      }
      html += '</div>';
    }

    // Actions
    html += '<div style="padding:8px;border-top:1px solid #334155;margin-top:auto;">';
    html += '<button class="assets-action-btn" id="assets-import-btn" style="width:100%;padding:8px;border-radius:6px;font-size:0.8rem;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;margin-bottom:4px;">Import Asset</button>';
    html += '<button class="assets-action-btn" id="assets-settings-btn" style="width:100%;padding:8px;border-radius:6px;font-size:0.8rem;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;">Settings</button>';
    html += '</div>';

    list.innerHTML = html;

    // Wire events
    var searchInput = document.getElementById('assets-search');
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        assetsSearch = e.target.value;
        renderAssetsMain();
      });
    }

    list.querySelectorAll('.assets-cat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        assetsCategory = btn.dataset.cat;
        assetsView = 'grid';
        renderAssetsSidebar();
        renderAssetsMain();
      });
    });

    list.querySelectorAll('.assets-col-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.closest('.assets-col-gear')) return; // handled below
        assetsCollection = item.dataset.col;
        assetsView = 'grid';
        renderAssetsSidebar();
        renderAssetsMain();
      });
      // Show gear on hover
      item.addEventListener('mouseenter', function () {
        var gear = item.querySelector('.assets-col-gear');
        if (gear) gear.style.opacity = '1';
      });
      item.addEventListener('mouseleave', function () {
        var gear = item.querySelector('.assets-col-gear');
        if (gear) gear.style.opacity = '0';
      });
    });

    list.querySelectorAll('.assets-col-gear').forEach(function (gear) {
      gear.addEventListener('click', function (e) {
        e.stopPropagation();
        showCollectionSettings(gear.dataset.colSlug);
      });
    });

    var newColBtn = list.querySelector('.assets-new-col');
    if (newColBtn) {
      newColBtn.addEventListener('click', showNewCollectionDialog);
    }

    var importBtn = document.getElementById('assets-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        assetsView = 'import';
        renderAssetsMain();
      });
    }

    var settingsBtn = document.getElementById('assets-settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', function () {
        assetsView = 'settings';
        renderAssetsMain();
      });
    }
  }

  // ── Filtering ──────────────────────────────────────────────

  function getFilteredAssets() {
    var filtered = assetsData.slice();

    if (assetsCategory) {
      filtered = filtered.filter(function (a) { return a.category === assetsCategory; });
    }
    if (assetsCollection) {
      filtered = filtered.filter(function (a) { return a.collections && a.collections.indexOf(assetsCollection) !== -1; });
    }
    if (assetsSearch) {
      var s = assetsSearch.toLowerCase();
      filtered = filtered.filter(function (a) {
        return (a.name && a.name.toLowerCase().indexOf(s) !== -1) ||
          (a.description && a.description.toLowerCase().indexOf(s) !== -1) ||
          (a.tags && a.tags.some(function (t) { return t.toLowerCase().indexOf(s) !== -1; }));
      });
    }

    return filtered;
  }

  // ── Main Area Router ───────────────────────────────────────

  function renderAssetsMain() {
    if (assetsView === 'detail') {
      renderAssetDetail();
    } else if (assetsView === 'settings') {
      renderAssetsSettings();
    } else if (assetsView === 'import') {
      renderAssetsImport();
    } else if (assetsView === 'new-collection') {
      renderNewCollectionView();
    } else if (assetsView === 'collection-settings') {
      renderCollectionSettings();
    } else {
      renderAssetsGrid();
    }
  }

  // ── Grid View ──────────────────────────────────────────────

  function renderAssetsGrid() {
    var main = document.getElementById('main');
    if (!main) return;

    var filtered = getFilteredAssets();

    var html = '<div class="assets-grid-container" style="padding:24px;">';

    // Header
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">Assets <span style="color:#64748b;font-weight:400;">(' + filtered.length + ')</span></h2>';
    html += '</div>';

    // Drop zone overlay (hidden until drag)
    html += '<div id="assets-drop-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(124,58,237,0.15);z-index:100;pointer-events:none;">';
    html += '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;">';
    html += '<div style="font-size:3rem;margin-bottom:12px;">&#x1f4e5;</div>';
    html += '<div style="font-size:18px;font-weight:600;color:#a78bfa;">Drop files to import</div>';
    html += '<div style="font-size:13px;color:#94a3b8;margin-top:4px;">Files will be copied to your asset library</div>';
    html += '</div></div>';

    if (filtered.length === 0) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state-icon">&#x1f4e6;</div>';
      html += '<h2>No assets found</h2>';
      html += '<p>' + (assetsData.length === 0 ? 'Drag files here or click Import to get started.' : 'No assets match your current filters.') + '</p>';
      html += '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;">';

      for (var i = 0; i < filtered.length; i++) {
        html += renderAssetCard(filtered[i]);
      }

      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire card clicks
    main.querySelectorAll('.asset-card').forEach(function (card) {
      card.addEventListener('click', function () {
        selectedAssetId = card.dataset.assetId;
        assetsView = 'detail';
        renderAssetsMain();
      });
    });

    // Load text previews for grid thumbnails
    var textAssets = filtered.filter(function (a) { return a.category === 'text'; });
    textAssets.forEach(function (asset) {
      var thumbEl = document.getElementById('asset-thumb-' + asset.id);
      if (!thumbEl) return;
      fetchAssetTextPreview(asset.id, function (err, text) {
        if (err || !text) {
          thumbEl.innerHTML = '<div style="font-size:2.5rem;color:#475569;display:flex;align-items:center;justify-content:center;height:100%;">' + getCategoryIcon(asset.category) + '</div>';
          return;
        }
        var ext = getFileExtension(asset);
        var preview = text;
        if (ext === 'json') {
          try {
            var obj = JSON.parse(text);
            preview = JSON.stringify(obj, null, 2);
          } catch (e) { /* use raw */ }
        }
        preview = preview.split('\n').slice(0, 15).join('\n');
        thumbEl.innerHTML = '<div style="white-space:pre;overflow:hidden;height:100%;color:#64748b;">' + escHtml(preview) + '</div>';
      });
    });

    // Wire drag-and-drop
    setupDropZone(main);
  }

  // ── Drag & Drop ────────────────────────────────────────────

  var dragCounter = 0;

  function setupDropZone(main) {
    main.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragCounter++;
      var overlay = document.getElementById('assets-drop-overlay');
      if (overlay) overlay.style.display = '';
    });

    main.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        var overlay = document.getElementById('assets-drop-overlay');
        if (overlay) overlay.style.display = 'none';
      }
    });

    main.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    main.addEventListener('drop', function (e) {
      e.preventDefault();
      dragCounter = 0;
      var overlay = document.getElementById('assets-drop-overlay');
      if (overlay) overlay.style.display = 'none';

      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      handleDroppedFiles(files);
    });
  }

  async function handleDroppedFiles(files) {
    var imported = 0;
    var errors = [];

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      // Electron exposes the full path on the File object
      var filePath = file.path;
      if (!filePath) {
        errors.push(file.name + ': no file path (not running in Electron?)');
        continue;
      }

      // Derive name from filename (strip extension, replace dashes/underscores with spaces)
      var name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

      try {
        var res = await fetch('/api/assets/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_path: filePath,
            name: name,
          }),
        });

        if (!res.ok) {
          var err = await res.json();
          errors.push(file.name + ': ' + (err.error || 'failed'));
        } else {
          imported++;
        }
      } catch (err) {
        errors.push(file.name + ': ' + err.message);
      }
    }

    // Refresh
    await loadAssetsData();
    renderAssetsSidebar();
    renderAssetsMain();

    if (imported > 0) {
      toast(imported + ' asset' + (imported > 1 ? 's' : '') + ' imported', 'success');
    }
    if (errors.length > 0) {
      toast('Failed: ' + errors.join(', '), 'error');
    }
  }

  function renderAssetCard(asset) {
    var html = '<div class="asset-card" data-asset-id="' + escAttr(asset.id) + '" style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color 0.15s,transform 0.15s;">';

    // Thumbnail
    html += '<div style="height:140px;background:#0f172a;display:flex;align-items:center;justify-content:center;overflow:hidden;">';
    if (asset.category === 'image') {
      html += '<img src="/api/assets/file/' + encodeURIComponent(asset.id) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\';this.parentElement.innerHTML=\'&#x1f5bc;\';" />';
    } else if (asset.category === 'text') {
      html += '<div id="asset-thumb-' + escAttr(asset.id) + '" class="asset-text-thumb" style="width:100%;height:100%;padding:8px;overflow:hidden;font-family:\'SF Mono\',\'Fira Code\',monospace;font-size:9px;line-height:1.3;color:#94a3b8;white-space:pre;background:#0f172a;">';
      html += '<span style="color:#475569;">...</span>';
      html += '</div>';
    } else {
      html += '<div style="font-size:2.5rem;color:#475569;">' + getCategoryIcon(asset.category) + '</div>';
    }
    html += '</div>';

    // Info
    html += '<div style="padding:12px;">';
    html += '<div style="font-size:14px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(asset.name) + '</div>';
    html += '<div style="font-size:12px;color:#64748b;margin-top:2px;">' + escHtml(asset.file_type || asset.category) + '</div>';

    // Tags
    if (asset.tags && asset.tags.length > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;">';
      var maxTags = Math.min(asset.tags.length, 3);
      for (var t = 0; t < maxTags; t++) {
        html += '<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);color:#c4b5fd;">' + escHtml(asset.tags[t]) + '</span>';
      }
      if (asset.tags.length > 3) {
        html += '<span style="font-size:10px;color:#64748b;">+' + (asset.tags.length - 3) + '</span>';
      }
      html += '</div>';
    }

    // Default badge
    if (asset.is_default_for) {
      html += '<div style="margin-top:6px;"><span style="font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(34,197,94,0.15);color:#4ade80;">default: ' + escHtml(asset.is_default_for) + '</span></div>';
    }

    html += '</div></div>';
    return html;
  }

  function getCategoryIcon(category) {
    switch (category) {
      case 'image': return '&#x1f5bc;';
      case 'video': return '&#x1f3ac;';
      case 'audio': return '&#x1f3b5;';
      case 'text': return '&#x1f4c4;';
      case 'document': return '&#x1f4c3;';
      default: return '&#x1f4c1;';
    }
  }

  // ── Content Preview Helpers ───────────────────────────────

  function getFileExtension(asset) {
    var ft = asset.file_type || '';
    if (ft === 'application/json') return 'json';
    if (ft === 'text/plain') return 'txt';
    if (ft === 'text/markdown') return 'md';
    if (ft === 'text/csv') return 'csv';
    if (ft === 'application/pdf') return 'pdf';
    if (ft.indexOf('image/svg') !== -1) return 'svg';
    // Fallback: try to extract from name
    var name = asset.name || '';
    var dot = name.lastIndexOf('.');
    if (dot > 0) return name.slice(dot + 1).toLowerCase();
    return '';
  }

  function fetchAssetText(assetId, callback) {
    fetch('/api/assets/file/' + encodeURIComponent(assetId))
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load file');
        return res.text();
      })
      .then(function (text) {
        callback(null, text);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  function fetchAssetTextPreview(assetId, callback) {
    fetch('/api/assets/file/' + encodeURIComponent(assetId), {
      headers: { 'Range': 'bytes=0-2047' }
    })
      .then(function (res) {
        return res.text();
      })
      .then(function (text) {
        callback(null, text);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  function syntaxHighlightJSON(jsonString) {
    try {
      var obj = JSON.parse(jsonString);
      jsonString = JSON.stringify(obj, null, 2);
    } catch (e) {
      return '<span style="color:#e2e8f0;">' + escHtml(jsonString) + '</span>';
    }

    var result = '';
    var lastIndex = 0;
    var regex = /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
    var match;

    while ((match = regex.exec(jsonString)) !== null) {
      if (match.index > lastIndex) {
        result += escHtml(jsonString.slice(lastIndex, match.index));
      }
      var token = match[0];
      var color = '#a78bfa'; // number - purple
      if (/^"/.test(token)) {
        if (/:$/.test(token)) {
          color = '#7dd3fc'; // key - light blue
        } else {
          color = '#86efac'; // string - green
        }
      } else if (/true|false/.test(token)) {
        color = '#fbbf24'; // boolean - amber
      } else if (/null/.test(token)) {
        color = '#f87171'; // null - red
      }
      result += '<span style="color:' + color + ';">' + escHtml(token) + '</span>';
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < jsonString.length) {
      result += escHtml(jsonString.slice(lastIndex));
    }
    return result;
  }

  function renderMarkdownSimple(mdString) {
    if (typeof marked !== 'undefined') {
      try {
        var html = marked.parse(mdString);
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
        html = html.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
        html = html.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
        return html;
      } catch (e) {
        return '<pre style="color:#e2e8f0;white-space:pre-wrap;">' + escHtml(mdString) + '</pre>';
      }
    }
    return '<pre style="color:#e2e8f0;white-space:pre-wrap;">' + escHtml(mdString) + '</pre>';
  }

  function parseCSVToTable(csvString) {
    var lines = csvString.split('\n');
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cells = [];
      var current = '';
      var inQuotes = false;
      for (var j = 0; j < line.length; j++) {
        var ch = line[j];
        if (ch === '"') {
          if (inQuotes && j + 1 < line.length && line[j + 1] === '"') {
            current += '"';
            j++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          cells.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      cells.push(current.trim());
      rows.push(cells);
    }

    if (rows.length === 0) return '<div style="color:#64748b;">Empty CSV</div>';

    var html = '<table class="csv-table">';
    html += '<thead><tr>';
    for (var h = 0; h < rows[0].length; h++) {
      html += '<th>' + escHtml(rows[0][h]) + '</th>';
    }
    html += '</tr></thead>';
    html += '<tbody>';
    var maxRows = Math.min(rows.length, 201);
    for (var r = 1; r < maxRows; r++) {
      html += '<tr>';
      for (var c = 0; c < rows[r].length; c++) {
        html += '<td>' + escHtml(rows[r][c]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (rows.length > 201) {
      html += '<div style="color:#64748b;font-size:12px;margin-top:8px;">Showing first 200 of ' + (rows.length - 1) + ' rows</div>';
    }
    return html;
  }

  function populateContentPreview(previewEl, ext, text) {
    if (ext === 'json') {
      previewEl.innerHTML = '<pre style="margin:0;font-family:\'SF Mono\',\'Fira Code\',monospace;font-size:13px;line-height:1.5;white-space:pre;color:#e2e8f0;">' + syntaxHighlightJSON(text) + '</pre>';
    } else if (ext === 'md') {
      previewEl.innerHTML = '<div class="md-preview">' + renderMarkdownSimple(text) + '</div>';
      previewEl.querySelectorAll('a').forEach(function (a) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      });
    } else if (ext === 'csv') {
      previewEl.innerHTML = parseCSVToTable(text);
    } else {
      previewEl.innerHTML = '<pre style="margin:0;font-family:\'SF Mono\',\'Fira Code\',monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#e2e8f0;">' + escHtml(text) + '</pre>';
    }
  }

  // ── Detail View ────────────────────────────────────────────

  function renderAssetDetail() {
    var main = document.getElementById('main');
    if (!main) return;

    var asset = assetsData.find(function (a) { return a.id === selectedAssetId; });
    if (!asset) {
      assetsView = 'grid';
      renderAssetsGrid();
      return;
    }

    var html = '<div style="padding:24px;">';

    // Back button
    html += '<button id="assets-back-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">';
    html += '&larr; Back to assets</button>';

    // Split layout
    html += '<div id="asset-detail-split" style="display:flex;align-items:stretch;">';

    // Left: Preview
    html += '<div id="asset-detail-preview" style="flex:0 0 480px;min-width:200px;max-width:80%;padding-right:16px;">';
    if (asset.category === 'image') {
      html += '<img src="/api/assets/file/' + encodeURIComponent(asset.id) + '" style="width:100%;border-radius:8px;border:1px solid rgba(255,255,255,0.06);" />';
    } else if (asset.category === 'video') {
      html += '<video controls style="width:100%;border-radius:8px;"><source src="/api/assets/file/' + encodeURIComponent(asset.id) + '" type="' + escAttr(asset.file_type || 'video/mp4') + '"></video>';
    } else if (asset.category === 'audio') {
      html += '<div style="padding:40px;text-align:center;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">';
      html += '<div style="font-size:3rem;margin-bottom:16px;">&#x1f3b5;</div>';
      html += '<audio controls style="width:100%;"><source src="/api/assets/file/' + encodeURIComponent(asset.id) + '" type="' + escAttr(asset.file_type || 'audio/mpeg') + '"></audio>';
      html += '</div>';
    } else {
      var ext = getFileExtension(asset);
      if (ext === 'pdf') {
        html += '<iframe src="/api/assets/file/' + encodeURIComponent(asset.id) + '" style="width:100%;height:500px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#fff;" frameborder="0"></iframe>';
      } else if (ext === 'json' || ext === 'txt' || ext === 'md' || ext === 'csv') {
        var sizeLimit = 5 * 1024 * 1024;
        if (asset.file_size && asset.file_size > sizeLimit) {
          html += '<div id="asset-content-preview" style="background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);padding:40px;text-align:center;">';
          html += '<div style="font-size:2rem;margin-bottom:8px;">' + getCategoryIcon(asset.category) + '</div>';
          html += '<div style="color:#64748b;font-size:13px;">File is ' + formatFileSize(asset.file_size) + ' (too large for inline preview)</div>';
          html += '<button id="asset-load-preview-btn" style="margin-top:12px;padding:8px 16px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:13px;">Load Preview Anyway</button>';
          html += '</div>';
        } else {
          html += '<div id="asset-content-preview" style="background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);max-height:500px;overflow:auto;padding:16px;">';
          html += '<div style="text-align:center;color:#64748b;padding:20px;">Loading preview...</div>';
          html += '</div>';
        }
      } else {
        html += '<div style="padding:60px;text-align:center;background:#0f172a;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">';
        html += '<div style="font-size:4rem;margin-bottom:8px;">' + getCategoryIcon(asset.category) + '</div>';
        html += '<div style="color:#64748b;font-size:13px;">' + escHtml(asset.file_type || 'Unknown type') + '</div>';
        html += '</div>';
      }
    }
    html += '</div>';

    // Resize handle
    html += '<div id="asset-detail-resizer" class="asset-resizer" style="flex:0 0 6px;cursor:col-resize;background:transparent;position:relative;margin:0 8px;">';
    html += '<div style="position:absolute;top:0;bottom:0;left:2px;width:2px;background:#334155;border-radius:1px;transition:background 0.15s;"></div>';
    html += '</div>';

    // Right: Details
    html += '<div style="flex:1;min-width:200px;overflow:auto;">';

    // Name
    html += '<div>';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Name</label>';
    html += '<input type="text" id="asset-name" value="' + escAttr(asset.name) + '" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:14px;outline:none;">';
    html += '</div>';

    // Description
    html += '<div style="margin-top:12px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Description</label>';
    html += '<textarea id="asset-description" rows="3" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;resize:vertical;">' + escHtml(asset.description || '') + '</textarea>';
    html += '</div>';

    // Info row
    html += '<div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;">';
    html += '<div style="font-size:12px;color:#64748b;">Category: <span style="color:#94a3b8;">' + escHtml(asset.category) + '</span></div>';
    html += '<div style="font-size:12px;color:#64748b;">Type: <span style="color:#94a3b8;">' + escHtml(asset.file_type || '-') + '</span></div>';
    html += '<div style="font-size:12px;color:#64748b;">Size: <span style="color:#94a3b8;">' + formatFileSize(asset.file_size) + '</span></div>';
    html += '<div style="font-size:12px;color:#64748b;">Version: <span style="color:#94a3b8;">' + (asset.version || 1) + '</span></div>';
    var pathMode = asset.path_mode || 'relative';
    var pathLabel = pathMode === 'absolute' ? 'Absolute' : pathMode === 'collection_root' ? 'Collection Root' : 'Library Copy';
    var pathColor = pathMode === 'relative' ? '#94a3b8' : '#22c55e';
    html += '<div style="font-size:12px;color:#64748b;">Storage: <span style="color:' + pathColor + ';">' + pathLabel + '</span></div>';
    html += '</div>';

    // Tags
    html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #334155;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:8px;">Tags</label>';
    html += '<div id="asset-tags-container" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">';
    if (asset.tags) {
      for (var t = 0; t < asset.tags.length; t++) {
        html += '<span class="asset-tag" data-tag="' + escAttr(asset.tags[t]) + '" style="font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);color:#c4b5fd;cursor:pointer;" title="Click to remove">' + escHtml(asset.tags[t]) + ' &times;</span>';
      }
    }
    html += '<input type="text" id="asset-add-tag" placeholder="Add tag..." style="padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#fff;font-size:12px;outline:none;width:80px;">';
    html += '</div></div>';

    // Collections
    html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #334155;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:8px;">Collections</label>';
    html += '<div id="asset-collections-container" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">';
    if (asset.collections) {
      for (var c = 0; c < asset.collections.length; c++) {
        var colName = getCollectionName(asset.collections[c]);
        html += '<span class="asset-collection-tag" data-col="' + escAttr(asset.collections[c]) + '" style="font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);color:#93c5fd;cursor:pointer;" title="Click to remove">' + escHtml(colName) + ' &times;</span>';
      }
    }
    html += '<select id="asset-add-collection" style="padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:#1e293b;color:#94a3b8;font-size:12px;outline:none;">';
    html += '<option value="">+ Add to collection</option>';
    for (var ci = 0; ci < collectionsData.length; ci++) {
      if (!asset.collections || asset.collections.indexOf(collectionsData[ci].slug) === -1) {
        html += '<option value="' + escAttr(collectionsData[ci].slug) + '">' + escHtml(collectionsData[ci].name) + '</option>';
      }
    }
    html += '</select>';
    html += '</div></div>';

    // Default for
    html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #334155;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Default For Role</label>';
    html += '<input type="text" id="asset-default-for" value="' + escAttr(asset.is_default_for || '') + '" placeholder="e.g. character, style, brand, voice..." style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    // Metadata
    html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #334155;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:8px;">Custom Metadata</label>';
    html += '<div id="asset-metadata-container">';
    var meta = asset.metadata || {};
    var metaKeys = Object.keys(meta);
    for (var m = 0; m < metaKeys.length; m++) {
      var mk = metaKeys[m];
      var mv = typeof meta[mk] === 'object' ? JSON.stringify(meta[mk]) : String(meta[mk]);
      html += '<div class="asset-meta-row" style="display:flex;gap:8px;margin-bottom:6px;align-items:center;">';
      html += '<input type="text" class="meta-key" value="' + escAttr(mk) + '" style="flex:0 0 140px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#94a3b8;font-size:12px;outline:none;">';
      html += '<input type="text" class="meta-value" value="' + escAttr(mv) + '" style="flex:1;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:12px;outline:none;">';
      html += '<button class="meta-remove" data-key="' + escAttr(mk) + '" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:2px 4px;">&times;</button>';
      html += '</div>';
    }
    html += '</div>';
    html += '<button id="asset-add-meta" style="margin-top:4px;background:none;border:none;color:#7c3aed;cursor:pointer;font-size:12px;">+ Add field</button>';
    html += '</div>';

    // Version History
    if (asset.versions && asset.versions.length > 0) {
      html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #334155;">';
      html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:8px;">Version History</label>';
      for (var v = asset.versions.length - 1; v >= 0; v--) {
        var ver = asset.versions[v];
        if (ver.deleted) continue;
        var isCurrent = ver.version === asset.version;
        html += '<div style="padding:4px 0;font-size:12px;color:' + (isCurrent ? '#e2e8f0' : '#64748b') + ';">';
        html += 'v' + ver.version + (isCurrent ? ' (current)' : '') + ' &mdash; ' + formatDate(ver.created_at);
        if (ver.notes) html += ' &mdash; ' + escHtml(ver.notes);
        html += '</div>';
      }
      html += '</div>';
    }

    // Actions
    html += '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #334155;display:flex;gap:12px;">';
    html += '<button id="asset-save-btn" style="padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;background:#7c3aed;color:#fff;border:none;cursor:pointer;">Save Changes</button>';
    var revealLabel = (window.woodburyElectron && window.woodburyElectron.platform === 'win32') ? 'Show in Explorer' : 'Show in Finder';
    html += '<button id="asset-reveal-btn" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,0.3);cursor:pointer;">&#x1f4c2; ' + revealLabel + '</button>';
    html += '<button id="asset-delete-btn" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#ef4444;border:1px solid rgba(239,68,68,0.3);cursor:pointer;">Delete Asset</button>';
    html += '</div>';

    html += '</div>'; // Right column
    html += '</div>'; // Split layout
    html += '</div>'; // Padding container

    main.innerHTML = html;

    // Fetch text content for preview
    (function () {
      var ext = getFileExtension(asset);
      var previewEl = document.getElementById('asset-content-preview');
      if (!previewEl) return;

      var loadBtn = document.getElementById('asset-load-preview-btn');
      if (loadBtn) {
        loadBtn.addEventListener('click', function () {
          previewEl.style.maxHeight = '500px';
          previewEl.style.overflow = 'auto';
          previewEl.style.padding = '16px';
          previewEl.style.textAlign = '';
          previewEl.innerHTML = '<div style="text-align:center;color:#64748b;padding:20px;">Loading preview...</div>';
          fetchAssetText(asset.id, function (err, text) {
            if (err || !text) {
              previewEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;">Failed to load preview</div>';
              return;
            }
            populateContentPreview(previewEl, ext, text);
          });
        });
        return;
      }

      fetchAssetText(asset.id, function (err, text) {
        if (err || !text) {
          previewEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;">Failed to load preview</div>';
          return;
        }
        populateContentPreview(previewEl, ext, text);
      });
    })();

    // Wire resize handle
    (function () {
      var resizer = document.getElementById('asset-detail-resizer');
      var previewCol = document.getElementById('asset-detail-preview');
      var splitContainer = document.getElementById('asset-detail-split');
      if (!resizer || !previewCol || !splitContainer) return;

      var startX, startWidth;
      var innerBar = resizer.querySelector('div');

      resizer.addEventListener('mousedown', function (e) {
        e.preventDefault();
        startX = e.clientX;
        startWidth = previewCol.getBoundingClientRect().width;
        if (innerBar) innerBar.style.background = '#7c3aed';

        function onMouseMove(e) {
          var newWidth = startWidth + (e.clientX - startX);
          var containerWidth = splitContainer.getBoundingClientRect().width;
          var minW = 200;
          var maxW = containerWidth * 0.8;
          newWidth = Math.max(minW, Math.min(maxW, newWidth));
          previewCol.style.flex = '0 0 ' + newWidth + 'px';
        }
        function onMouseUp() {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          if (innerBar) innerBar.style.background = '#334155';
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    })();

    // Wire events
    document.getElementById('assets-back-btn').addEventListener('click', function () {
      assetsView = 'grid';
      selectedAssetId = null;
      renderAssetsMain();
    });

    // Tag removal
    main.querySelectorAll('.asset-tag').forEach(function (tag) {
      tag.addEventListener('click', function () { tag.remove(); });
    });

    // Add tag
    document.getElementById('asset-add-tag').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var val = e.target.value.trim();
        if (val) {
          var span = document.createElement('span');
          span.className = 'asset-tag';
          span.dataset.tag = val;
          span.style.cssText = 'font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);color:#c4b5fd;cursor:pointer;';
          span.title = 'Click to remove';
          span.innerHTML = escHtml(val) + ' &times;';
          span.addEventListener('click', function () { span.remove(); });
          e.target.parentElement.insertBefore(span, e.target);
          e.target.value = '';
        }
      }
    });

    // Collection removal
    main.querySelectorAll('.asset-collection-tag').forEach(function (tag) {
      tag.addEventListener('click', function () { tag.remove(); });
    });

    // Add collection
    document.getElementById('asset-add-collection').addEventListener('change', function (e) {
      var val = e.target.value;
      if (val) {
        var colName = getCollectionName(val);
        var span = document.createElement('span');
        span.className = 'asset-collection-tag';
        span.dataset.col = val;
        span.style.cssText = 'font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);color:#93c5fd;cursor:pointer;';
        span.title = 'Click to remove';
        span.innerHTML = escHtml(colName) + ' &times;';
        span.addEventListener('click', function () { span.remove(); });
        var container = document.getElementById('asset-collections-container');
        container.insertBefore(span, e.target);
        var opt = e.target.querySelector('option[value="' + val + '"]');
        if (opt) opt.remove();
        e.target.value = '';
      }
    });

    // Add metadata field
    document.getElementById('asset-add-meta').addEventListener('click', function () {
      var container = document.getElementById('asset-metadata-container');
      var row = document.createElement('div');
      row.className = 'asset-meta-row';
      row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;';
      row.innerHTML =
        '<input type="text" class="meta-key" placeholder="key" style="flex:0 0 140px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#94a3b8;font-size:12px;outline:none;">' +
        '<input type="text" class="meta-value" placeholder="value" style="flex:1;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:12px;outline:none;">' +
        '<button class="meta-remove" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:2px 4px;">&times;</button>';
      row.querySelector('.meta-remove').addEventListener('click', function () { row.remove(); });
      container.appendChild(row);
    });

    // Meta remove buttons
    main.querySelectorAll('.meta-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.closest('.asset-meta-row').remove();
      });
    });

    // Save
    document.getElementById('asset-save-btn').addEventListener('click', saveAssetDetail);

    // Reveal in Finder / Explorer
    document.getElementById('asset-reveal-btn').addEventListener('click', function () {
      fetch('/api/assets/' + encodeURIComponent(asset.id) + '/reveal', { method: 'POST' });
    });

    // Delete
    document.getElementById('asset-delete-btn').addEventListener('click', function () {
      if (confirm('Delete this asset? This cannot be undone.')) {
        deleteAsset(asset.id);
      }
    });
  }

  // ── Save / Delete ──────────────────────────────────────────

  async function saveAssetDetail() {
    var name = document.getElementById('asset-name').value.trim();
    var description = document.getElementById('asset-description').value.trim();
    var defaultFor = document.getElementById('asset-default-for').value.trim();

    var tags = [];
    document.querySelectorAll('.asset-tag').forEach(function (el) {
      if (el.dataset.tag) tags.push(el.dataset.tag);
    });

    var collections = [];
    document.querySelectorAll('.asset-collection-tag').forEach(function (el) {
      if (el.dataset.col) collections.push(el.dataset.col);
    });

    var metadata = {};
    document.querySelectorAll('.asset-meta-row').forEach(function (row) {
      var key = row.querySelector('.meta-key').value.trim();
      var value = row.querySelector('.meta-value').value;
      if (key) {
        try { metadata[key] = JSON.parse(value); } catch (e) { metadata[key] = value; }
      }
    });

    try {
      var res = await fetch('/api/assets/' + encodeURIComponent(selectedAssetId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          description: description,
          tags: tags,
          collections: collections,
          is_default_for: defaultFor || null,
          metadata: metadata,
        }),
      });

      if (!res.ok) throw new Error('Failed to save');

      await loadAssetsData();
      renderAssetsSidebar();
      renderAssetDetail();
      toast('Asset saved', 'success');
    } catch (err) {
      toast('Failed to save: ' + err.message, 'error');
    }
  }

  async function deleteAsset(id) {
    try {
      var res = await fetch('/api/assets/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');

      await loadAssetsData();
      assetsView = 'grid';
      selectedAssetId = null;
      renderAssetsSidebar();
      renderAssetsMain();
      toast('Asset deleted', 'success');
    } catch (err) {
      toast('Failed to delete: ' + err.message, 'error');
    }
  }

  // ── Settings View ──────────────────────────────────────────

  function renderAssetsSettings() {
    var main = document.getElementById('main');
    if (!main) return;

    var html = '<div style="padding:24px;max-width:600px;">';

    html += '<button id="assets-settings-back" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">&larr; Back to assets</button>';

    html += '<h2 style="margin:0 0 24px;font-size:20px;font-weight:600;color:#e2e8f0;">Asset Storage Settings</h2>';

    html += '<div>';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Data Directory</label>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<input type="text" id="assets-data-dir" name="assets-data-dir" value="' + escAttr(assetsDataDir) + '" style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '<button id="assets-browse-dir" style="padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;white-space:nowrap;">Browse</button>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#64748b;margin-top:4px;">Where asset files and metadata (assets.json, collections.json) are stored.</div>';
    html += '</div>';

    html += '<button id="assets-save-settings" style="margin-top:20px;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;background:#7c3aed;color:#fff;border:none;cursor:pointer;">Save Settings</button>';

    html += '</div>';
    main.innerHTML = html;

    document.getElementById('assets-settings-back').addEventListener('click', function () {
      assetsView = 'grid';
      renderAssetsMain();
    });

    document.getElementById('assets-browse-dir').addEventListener('click', function () {
      openFolderPicker('assets-data-dir', assetsDataDir);
    });

    document.getElementById('assets-save-settings').addEventListener('click', async function () {
      var dir = document.getElementById('assets-data-dir').value.trim();
      if (!dir) return;

      try {
        var res = await fetch('/api/assets/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataDir: dir }),
        });
        if (!res.ok) throw new Error('Failed to save');

        await loadAssetsData();
        renderAssetsSidebar();
        toast('Settings saved', 'success');
      } catch (err) {
        toast('Failed to save settings: ' + err.message, 'error');
      }
    });
  }

  // ── Import View ────────────────────────────────────────────

  function renderAssetsImport() {
    var main = document.getElementById('main');
    if (!main) return;

    var html = '<div style="padding:24px;max-width:600px;">';

    html += '<button id="assets-import-back" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">&larr; Back to assets</button>';

    html += '<h2 style="margin:0 0 24px;font-size:20px;font-weight:600;color:#e2e8f0;">Import Asset</h2>';

    // File path
    html += '<div>';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">File Path</label>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<input type="text" id="import-file-path" placeholder="/path/to/file" style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '<button id="import-browse-file" style="padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;white-space:nowrap;">Browse</button>';
    html += '</div></div>';

    // Name
    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Name</label>';
    html += '<input type="text" id="import-name" placeholder="My Asset" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    // Description
    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Description <span style="color:#475569;font-weight:400;">(optional)</span></label>';
    html += '<textarea id="import-description" rows="2" placeholder="What is this asset?" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;resize:vertical;"></textarea>';
    html += '</div>';

    // Tags
    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Tags <span style="color:#475569;font-weight:400;">(comma-separated, optional)</span></label>';
    html += '<input type="text" id="import-tags" placeholder="logo, brand, header" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    // Collection
    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Collection <span style="color:#475569;font-weight:400;">(optional)</span></label>';
    html += '<select id="import-collection" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:#1e293b;color:#fff;font-size:13px;outline:none;">';
    html += '<option value="">None</option>';
    for (var i = 0; i < collectionsData.length; i++) {
      html += '<option value="' + escAttr(collectionsData[i].slug) + '">' + escHtml(collectionsData[i].name) + '</option>';
    }
    html += '</select>';
    html += '</div>';

    // Reference only checkbox
    html += '<div style="margin-top:16px;">';
    html += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#e2e8f0;cursor:pointer;">';
    html += '<input type="checkbox" id="import-reference-only" style="accent-color:#7c3aed;">';
    html += 'Reference only (don\'t copy file into library)';
    html += '</label>';
    html += '<div style="font-size:11px;color:#64748b;margin-top:4px;margin-left:24px;">The file stays in its original location. If it moves or is deleted, the asset link breaks.</div>';
    html += '</div>';

    // Actions
    html += '<div style="display:flex;gap:12px;margin-top:24px;">';
    html += '<button id="import-submit" style="padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;background:#7c3aed;color:#fff;border:none;cursor:pointer;">Import</button>';
    html += '<button id="import-cancel" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);cursor:pointer;">Cancel</button>';
    html += '</div>';

    html += '</div>';
    main.innerHTML = html;

    // Wire events
    document.getElementById('assets-import-back').addEventListener('click', function () {
      assetsView = 'grid';
      renderAssetsMain();
    });

    document.getElementById('import-cancel').addEventListener('click', function () {
      assetsView = 'grid';
      renderAssetsMain();
    });

    document.getElementById('import-browse-file').addEventListener('click', function () {
      showFileBrowser();
    });

    document.getElementById('import-submit').addEventListener('click', doImport);
  }

  async function doImport() {
    var filePath = document.getElementById('import-file-path').value.trim();
    var name = document.getElementById('import-name').value.trim();
    var description = document.getElementById('import-description').value.trim();
    var tagsStr = document.getElementById('import-tags').value.trim();
    var collection = document.getElementById('import-collection').value;

    if (!filePath) { toast('File path is required', 'error'); return; }
    if (!name) { toast('Name is required', 'error'); return; }

    var tags = tagsStr ? tagsStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
    var refOnlyEl = document.getElementById('import-reference-only');
    var referenceOnly = refOnlyEl && refOnlyEl.checked;

    var btn = document.getElementById('import-submit');
    btn.disabled = true;
    btn.textContent = 'Importing...';

    try {
      var importBody = {
        file_path: filePath,
        name: name,
        description: description,
        tags: tags,
        collection: collection || undefined,
      };
      if (referenceOnly) importBody.reference_only = true;

      var res = await fetch('/api/assets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(importBody),
      });

      if (!res.ok) {
        var err = await res.json();
        throw new Error(err.error || 'Import failed');
      }

      await loadAssetsData();
      assetsView = 'grid';
      renderAssetsSidebar();
      renderAssetsMain();
      toast('Asset imported', 'success');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      toast('Import failed: ' + err.message, 'error');
    }
  }

  // ── File Browser (for import) ──────────────────────────────

  function showFileBrowser() {
    var modal = document.getElementById('folder-modal');
    if (!modal) return;
    modal.classList.add('open');
    navigateFileBrowser('');
  }

  async function navigateFileBrowser(dirPath) {
    var dirsEl = document.getElementById('modal-dirs');
    var pathEl = document.getElementById('modal-path');
    dirsEl.innerHTML = '<div class="dir-empty">Loading...</div>';

    try {
      var res = await fetch('/api/browse-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath || undefined }),
      });
      var data = await res.json();
      pathEl.textContent = data.current;

      // Update parent button
      var parentBtn = document.getElementById('btn-parent');
      parentBtn.onclick = function () {
        if (data.parent && data.parent !== data.current) {
          navigateFileBrowser(data.parent);
        }
      };

      var html = '';

      // Directories
      for (var i = 0; i < data.dirs.length; i++) {
        html += '<div class="dir-item" data-path="' + escAttr(data.dirs[i].path) + '">';
        html += '<span class="dir-icon">&#x1f4c1;</span> ';
        html += escHtml(data.dirs[i].name);
        html += '</div>';
      }

      // Files
      if (data.files) {
        for (var f = 0; f < data.files.length; f++) {
          html += '<div class="dir-item file-item" data-filepath="' + escAttr(data.files[f].path) + '" style="color:#a78bfa;">';
          html += '<span class="dir-icon">&#x1f4c4;</span> ';
          html += escHtml(data.files[f].name);
          html += '<span style="margin-left:auto;font-size:11px;color:#64748b;">' + formatFileSize(data.files[f].size) + '</span>';
          html += '</div>';
        }
      }

      if (!html) {
        html = '<div class="dir-empty">Empty directory</div>';
      }

      dirsEl.innerHTML = html;

      // Directory click → navigate into
      dirsEl.querySelectorAll('.dir-item[data-path]').forEach(function (el) {
        el.addEventListener('click', function () {
          navigateFileBrowser(el.dataset.path);
        });
      });

      // File click → select and close
      dirsEl.querySelectorAll('.file-item[data-filepath]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          document.getElementById('import-file-path').value = el.dataset.filepath;
          // Auto-fill name from filename if empty
          var nameInput = document.getElementById('import-name');
          if (nameInput && !nameInput.value) {
            var fname = el.dataset.filepath.split('/').pop();
            if (fname.indexOf('\\') !== -1) fname = fname.split('\\').pop();
            nameInput.value = fname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
          }
          closeFolderPicker();
        });
      });

      // Override select button text
      var selectBtn = document.getElementById('modal-select');
      selectBtn.onclick = function () {
        closeFolderPicker();
      };

    } catch (err) {
      dirsEl.innerHTML = '<div class="dir-empty" style="color:#ef4444;">Cannot read directory</div>';
    }
  }

  // ── New Collection Dialog ──────────────────────────────────

  function showNewCollectionDialog() {
    assetsView = 'new-collection';
    renderAssetsMain();
  }

  function renderNewCollectionView() {
    var main = document.getElementById('main');
    if (!main) return;

    var html = '<div style="padding:24px;max-width:600px;">';
    html += '<button id="assets-newcol-back" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">&larr; Back to assets</button>';
    html += '<h2 style="margin:0 0 24px;font-size:20px;font-weight:600;color:#e2e8f0;">New Collection</h2>';

    html += '<div>';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Name</label>';
    html += '<input type="text" id="newcol-name" placeholder="e.g. Brand Kit, Character Art" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Description <span style="color:#475569;font-weight:400;">(optional)</span></label>';
    html += '<input type="text" id="newcol-description" placeholder="What is this collection for?" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Root Path <span style="color:#475569;font-weight:400;">(optional)</span></label>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<input type="text" id="newcol-rootpath" placeholder="/path/to/assets/folder" style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '<button id="newcol-browse" style="padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;white-space:nowrap;">Browse</button>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-top:4px;">Assets can reference files relative to this directory instead of being copied into the library.</div>';
    html += '</div>';

    html += '<div style="display:flex;gap:12px;margin-top:24px;">';
    html += '<button id="newcol-submit" style="padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;background:#7c3aed;color:#fff;border:none;cursor:pointer;">Create Collection</button>';
    html += '<button id="newcol-cancel" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);cursor:pointer;">Cancel</button>';
    html += '</div>';

    html += '</div>';
    main.innerHTML = html;

    document.getElementById('assets-newcol-back').addEventListener('click', function () {
      assetsView = 'grid'; renderAssetsMain();
    });
    document.getElementById('newcol-cancel').addEventListener('click', function () {
      assetsView = 'grid'; renderAssetsMain();
    });
    document.getElementById('newcol-browse').addEventListener('click', function () {
      showDirBrowser('newcol-rootpath');
    });
    document.getElementById('newcol-submit').addEventListener('click', function () {
      var name = document.getElementById('newcol-name').value.trim();
      if (!name) { toast('Name is required', 'error'); return; }
      var description = document.getElementById('newcol-description').value.trim();
      var rootPath = document.getElementById('newcol-rootpath').value.trim();

      var btn = document.getElementById('newcol-submit');
      btn.disabled = true; btn.textContent = 'Creating...';

      var colBody = { name: name };
      if (description) colBody.description = description;
      if (rootPath) colBody.rootPath = rootPath;

      fetch('/api/assets/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(colBody),
      })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error); });
        return res.json();
      })
      .then(function () {
        return loadAssetsData();
      })
      .then(function () {
        assetsView = 'grid';
        renderAssetsSidebar();
        renderAssetsMain();
        toast('Collection created', 'success');
      })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Create Collection';
        toast('Failed: ' + err.message, 'error');
      });
    });
  }

  function showCollectionSettings(slug) {
    assetsView = 'collection-settings';
    assetsCollectionSettingsSlug = slug;
    renderAssetsMain();
  }

  var assetsCollectionSettingsSlug = '';

  function renderCollectionSettings() {
    var main = document.getElementById('main');
    if (!main) return;

    var col = collectionsData.find(function (c) { return c.slug === assetsCollectionSettingsSlug; });
    if (!col) { assetsView = 'grid'; renderAssetsMain(); return; }

    var html = '<div style="padding:24px;max-width:600px;">';
    html += '<button id="assets-colset-back" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:20px;display:flex;align-items:center;gap:4px;">&larr; Back to assets</button>';
    html += '<h2 style="margin:0 0 24px;font-size:20px;font-weight:600;color:#e2e8f0;">Collection: ' + escHtml(col.name) + '</h2>';

    html += '<div>';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Name</label>';
    html += '<input type="text" id="colset-name" value="' + escAttr(col.name) + '" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Description</label>';
    html += '<input type="text" id="colset-description" value="' + escAttr(col.description || '') + '" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '</div>';

    html += '<div style="margin-top:16px;">';
    html += '<label style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;display:block;margin-bottom:4px;">Root Path</label>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<input type="text" id="colset-rootpath" value="' + escAttr(col.rootPath || '') + '" placeholder="/path/to/assets/folder" style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.2);color:#fff;font-size:13px;outline:none;">';
    html += '<button id="colset-browse" style="padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;white-space:nowrap;">Browse</button>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-top:4px;">Assets in this collection can reference files relative to this directory.</div>';
    html += '</div>';

    html += '<div style="margin-top:16px;padding:8px 12px;background:rgba(0,0,0,0.2);border-radius:6px;border:1px solid rgba(255,255,255,0.06);">';
    html += '<div style="font-size:12px;color:#64748b;">Slug: <span style="color:#94a3b8;font-family:monospace;">' + escHtml(col.slug) + '</span></div>';
    html += '<div style="font-size:12px;color:#64748b;margin-top:2px;">Assets: <span style="color:#94a3b8;">' + (col.asset_count || 0) + '</span></div>';
    html += '</div>';

    html += '<div style="display:flex;gap:12px;margin-top:24px;">';
    html += '<button id="colset-save" style="padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;background:#7c3aed;color:#fff;border:none;cursor:pointer;">Save Changes</button>';
    html += '<button id="colset-cancel" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);cursor:pointer;">Cancel</button>';
    html += '<button id="colset-delete" style="padding:10px 24px;border-radius:8px;font-size:14px;background:transparent;color:#ef4444;border:1px solid rgba(239,68,68,0.3);cursor:pointer;margin-left:auto;">Delete</button>';
    html += '</div>';

    html += '</div>';
    main.innerHTML = html;

    document.getElementById('assets-colset-back').addEventListener('click', function () {
      assetsView = 'grid'; renderAssetsMain();
    });
    document.getElementById('colset-cancel').addEventListener('click', function () {
      assetsView = 'grid'; renderAssetsMain();
    });
    document.getElementById('colset-browse').addEventListener('click', function () {
      showDirBrowser('colset-rootpath');
    });
    document.getElementById('colset-save').addEventListener('click', function () {
      var btn = document.getElementById('colset-save');
      btn.disabled = true; btn.textContent = 'Saving...';

      var body = {
        name: document.getElementById('colset-name').value.trim(),
        description: document.getElementById('colset-description').value.trim(),
        rootPath: document.getElementById('colset-rootpath').value.trim() || '',
      };

      fetch('/api/assets/collections/' + encodeURIComponent(col.slug), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error); });
        return res.json();
      })
      .then(function () { return loadAssetsData(); })
      .then(function () {
        assetsView = 'grid';
        renderAssetsSidebar();
        renderAssetsMain();
        toast('Collection updated', 'success');
      })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Save Changes';
        toast('Failed: ' + err.message, 'error');
      });
    });
    document.getElementById('colset-delete').addEventListener('click', function () {
      if (!confirm('Delete collection "' + col.name + '"? Assets will not be deleted, just removed from this collection.')) return;
      fetch('/api/assets/collections/' + encodeURIComponent(col.slug), { method: 'DELETE' })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error); });
        return res.json();
      })
      .then(function () { return loadAssetsData(); })
      .then(function () {
        assetsCollection = '';
        assetsView = 'grid';
        renderAssetsSidebar();
        renderAssetsMain();
        toast('Collection deleted', 'success');
      })
      .catch(function (err) { toast('Failed: ' + err.message, 'error'); });
    });
  }

  function showDirBrowser(inputId) {
    // Use the existing folder picker modal from app.js
    var inp = document.getElementById(inputId);
    if (!inp) return;
    // openFolderPicker expects input[name=...], so set a temp name
    inp.setAttribute('name', inputId);
    if (typeof openFolderPicker === 'function') {
      openFolderPicker(inputId, inp.value || '');
    } else {
      inp.focus();
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function getCollectionName(slug) {
    for (var i = 0; i < collectionsData.length; i++) {
      if (collectionsData[i].slug === slug) return collectionsData[i].name;
    }
    return slug;
  }

  function formatFileSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDate(isoString) {
    if (!isoString) return '-';
    try {
      return new Date(isoString).toLocaleDateString();
    } catch (e) { return isoString; }
  }

  // ── Export ─────────────────────────────────────────────────
  window.initAssets = initAssets;
})();
