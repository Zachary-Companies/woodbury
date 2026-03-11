// ── Storyboard Tab ─────────────────────────────────────────────
// Scene-by-scene asset curation for video production.
// Browse scenes, select images, manage audio, generate with character refs.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var storyboardsData = [];
  var selectedStoryboardId = null;
  var currentStoryboard = null;
  var storyboardView = 'list'; // 'list', 'scenes', 'scene-detail', 'audio'
  var selectedSceneIndex = null;
  var storyboardInitialized = false;

  // ── Init ───────────────────────────────────────────────────

  async function initStoryboard() {
    var main = document.getElementById('main');
    if (!main) return;

    if (storyboardInitialized && storyboardView === 'list' && main.querySelector('.sb-list-container')) return;

    main.innerHTML = '';
    main.style.display = '';
    main.style.flexDirection = '';

    await loadStoryboardsList();
    renderStoryboardSidebar();
    renderStoryboardMain();

    storyboardInitialized = true;
  }

  // ── Data Loading ───────────────────────────────────────────

  async function loadStoryboardsList() {
    try {
      var r = await fetch('/api/storyboards');
      var data = await r.json();
      storyboardsData = data.storyboards || [];
    } catch (err) {
      console.error('Failed to load storyboards:', err);
      storyboardsData = [];
    }
  }

  async function loadStoryboard(id) {
    try {
      var r = await fetch('/api/storyboards/' + encodeURIComponent(id));
      var data = await r.json();
      currentStoryboard = data.storyboard || data;
      return currentStoryboard;
    } catch (err) {
      console.error('Failed to load storyboard:', err);
      return null;
    }
  }

  async function saveStoryboard() {
    if (!currentStoryboard || !currentStoryboard.id) return;
    try {
      await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentStoryboard),
      });
    } catch (err) {
      console.error('Failed to save storyboard:', err);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function escHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escAttr(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDate(isoString) {
    if (!isoString) return '-';
    try { return new Date(isoString).toLocaleDateString(); } catch (e) { return isoString; }
  }

  function statusColor(status) {
    if (status === 'approved') return '#22c55e';
    if (status === 'rendered') return '#3b82f6';
    if (status === 'curating') return '#f59e0b';
    return '#64748b';
  }

  function statusLabel(status) {
    if (status === 'approved') return 'Approved';
    if (status === 'rendered') return 'Rendered';
    if (status === 'curating') return 'Curating';
    return 'Draft';
  }

  // ── Collection Helpers ─────────────────────────────────────

  var cachedCollections = null;
  var cachedCollectionsAt = 0;

  async function fetchCollections() {
    // Cache for 30 seconds
    if (cachedCollections && Date.now() - cachedCollectionsAt < 30000) return cachedCollections;
    try {
      var r = await fetch('/api/assets/collections');
      var d = await r.json();
      cachedCollections = d.collections || [];
      cachedCollectionsAt = Date.now();
      return cachedCollections;
    } catch (err) {
      console.error('Failed to fetch collections:', err);
      return cachedCollections || [];
    }
  }

  async function saveItemsToCollection(collectionSlug, items) {
    if (!currentStoryboard) return null;
    try {
      var r = await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/save-to-collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: collectionSlug, items: items }),
      });
      return await r.json();
    } catch (err) {
      console.error('Failed to save to collection:', err);
      return null;
    }
  }

  function renderCollectionDropdown(id, selectedSlug) {
    var html = '<select id="' + id + '" style="padding:4px 10px;border-radius:6px;background:rgba(30,41,59,0.8);border:1px solid rgba(255,255,255,0.1);color:#cbd5e1;font-size:12px;cursor:pointer;min-width:140px;">';
    html += '<option value="">Select collection...</option>';
    if (cachedCollections) {
      for (var i = 0; i < cachedCollections.length; i++) {
        var col = cachedCollections[i];
        html += '<option value="' + escAttr(col.slug) + '"' + (selectedSlug === col.slug ? ' selected' : '') + '>' + escHtml(col.name) + '</option>';
      }
    }
    html += '</select>';
    return html;
  }

  async function showSaveToCollectionDialog(items, label) {
    var cols = await fetchCollections();
    if (!cols || cols.length === 0) {
      alert('No collections found. Create a collection in the Assets tab first.');
      return;
    }

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    var dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;max-width:400px;width:90%;';

    var html = '<div style="font-size:16px;font-weight:600;color:#e2e8f0;margin-bottom:16px;">Save to Collection</div>';
    html += '<div style="font-size:13px;color:#94a3b8;margin-bottom:16px;">' + escHtml(label) + '</div>';
    html += '<div style="margin-bottom:16px;">';
    html += '<label style="font-size:12px;color:#64748b;display:block;margin-bottom:6px;">Collection</label>';
    html += renderCollectionDropdown('sb-save-col-select', currentStoryboard && currentStoryboard.outputCollectionSlug || '');
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;">';
    html += '<button id="sb-save-col-cancel" style="padding:8px 16px;border-radius:8px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:13px;">Cancel</button>';
    html += '<button id="sb-save-col-confirm" style="padding:8px 16px;border-radius:8px;background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.4);color:#a78bfa;cursor:pointer;font-size:13px;font-weight:500;">Save</button>';
    html += '</div>';

    dialog.innerHTML = html;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.getElementById('sb-save-col-cancel').addEventListener('click', function () { overlay.remove(); });

    document.getElementById('sb-save-col-confirm').addEventListener('click', async function () {
      var select = document.getElementById('sb-save-col-select');
      var slug = select.value;
      if (!slug) { alert('Please select a collection.'); return; }

      var btn = document.getElementById('sb-save-col-confirm');
      btn.textContent = 'Saving...';
      btn.disabled = true;

      var result = await saveItemsToCollection(slug, items);
      if (result && result.imported) {
        var count = result.imported.length;
        var existing = result.imported.filter(function (i) { return i.alreadyExists; }).length;
        var msg = count + ' item(s) saved to collection';
        if (existing > 0) msg += ' (' + existing + ' already existed)';
        if (result.errors && result.errors.length > 0) msg += '\n' + result.errors.length + ' error(s)';
        alert(msg);
        overlay.remove();
        // Refresh storyboard to get updated outputCollectionSlug
        await loadStoryboard(currentStoryboard.id);
      } else {
        alert('Failed to save to collection');
        btn.textContent = 'Save';
        btn.disabled = false;
      }
    });
  }

  // ── Sidebar ────────────────────────────────────────────────

  function renderStoryboardSidebar() {
    var list = document.getElementById('storyboard-list');
    if (!list) return;

    var html = '';

    // Header + New button
    html += '<div style="padding:0.75rem;display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="font-weight:600;color:#e2e8f0;font-size:0.82rem;">Storyboards</span>';
    html += '<button class="btn-sm" id="sb-new-btn" style="padding:3px 10px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:0.72rem;">+ New</button>';
    html += '</div>';

    // Storyboard list
    if (storyboardsData.length === 0) {
      html += '<div style="padding:1rem;color:#64748b;font-size:0.78rem;line-height:1.6;">';
      html += 'No storyboards yet. Click <strong>+ New</strong> to create one from a production package.';
      html += '</div>';
    } else {
      html += '<div style="padding:0 0.5rem;">';
      for (var i = 0; i < storyboardsData.length; i++) {
        var sb = storyboardsData[i];
        var isActive = selectedStoryboardId === sb.id;
        html += '<div class="sb-sidebar-item' + (isActive ? ' active' : '') + '" data-sb-id="' + escAttr(sb.id) + '" style="padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;border:1px solid ' + (isActive ? 'rgba(124,58,237,0.3)' : 'transparent') + ';background:' + (isActive ? 'rgba(124,58,237,0.1)' : 'transparent') + ';transition:all 0.15s;">';
        html += '<div style="font-size:13px;font-weight:500;color:' + (isActive ? '#e2e8f0' : '#94a3b8') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(sb.name) + '</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-top:3px;">';
        html += '<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:' + statusColor(sb.status) + '22;color:' + statusColor(sb.status) + ';border:1px solid ' + statusColor(sb.status) + '44;">' + statusLabel(sb.status) + '</span>';
        html += '<span style="font-size:10px;color:#64748b;">' + ((sb.scenes || []).length) + ' scenes</span>';
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    list.innerHTML = html;

    // Wire events
    var newBtn = document.getElementById('sb-new-btn');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        showNewStoryboardDialog();
      });
    }

    list.querySelectorAll('.sb-sidebar-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var id = item.dataset.sbId;
        selectedStoryboardId = id;
        storyboardView = 'scenes';
        selectedSceneIndex = null;
        loadStoryboard(id).then(function () {
          renderStoryboardSidebar();
          renderStoryboardMain();
        });
      });
    });
  }

  // ── Main Router ────────────────────────────────────────────

  function renderStoryboardMain() {
    if (storyboardView === 'scenes' && currentStoryboard) {
      renderScenesGrid();
    } else if (storyboardView === 'scene-detail' && currentStoryboard && selectedSceneIndex !== null) {
      renderSceneDetail();
    } else if (storyboardView === 'characters' && currentStoryboard) {
      renderCharactersPanel();
    } else if (storyboardView === 'audio' && currentStoryboard) {
      renderAudioPanel();
    } else if (storyboardView === 'video' && currentStoryboard && currentStoryboard.lastVideoPath) {
      renderVideoResult({ videoPath: currentStoryboard.lastVideoPath });
    } else {
      renderStoryboardList();
    }
  }

  // ── List View (no storyboard selected) ─────────────────────

  function renderStoryboardList() {
    var main = document.getElementById('main');
    if (!main) return;

    var html = '<div class="sb-list-container" style="padding:24px;">';

    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">Storyboards</h2>';
    html += '</div>';

    if (storyboardsData.length === 0) {
      html += '<div class="empty-state" style="text-align:center;padding:60px 20px;">';
      html += '<div style="font-size:3rem;margin-bottom:12px;">&#x1F3AC;</div>';
      html += '<h2 style="color:#e2e8f0;font-size:18px;margin:0 0 8px;">No Storyboards Yet</h2>';
      html += '<p style="color:#64748b;font-size:14px;max-width:400px;margin:0 auto 20px;">Create a storyboard from a production package to curate scenes, select images, and manage audio before assembling your video.</p>';
      html += '<button id="sb-create-btn" style="padding:10px 24px;border-radius:8px;background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.4);color:#a78bfa;cursor:pointer;font-size:14px;font-weight:500;">+ Create Storyboard</button>';
      html += '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">';
      for (var i = 0; i < storyboardsData.length; i++) {
        html += renderStoryboardCard(storyboardsData[i]);
      }
      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire events
    var createBtn = document.getElementById('sb-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        showNewStoryboardDialog();
      });
    }

    main.querySelectorAll('.sb-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var id = card.dataset.sbId;
        selectedStoryboardId = id;
        storyboardView = 'scenes';
        loadStoryboard(id).then(function () {
          renderStoryboardSidebar();
          renderStoryboardMain();
        });
      });
    });
  }

  function renderStoryboardCard(sb) {
    var html = '<div class="sb-card" data-sb-id="' + escAttr(sb.id) + '" style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;cursor:pointer;transition:border-color 0.15s,transform 0.15s;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
    html += '<div style="font-size:15px;font-weight:600;color:#e2e8f0;">' + escHtml(sb.name) + '</div>';
    html += '<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:' + statusColor(sb.status) + '22;color:' + statusColor(sb.status) + ';border:1px solid ' + statusColor(sb.status) + '44;">' + statusLabel(sb.status) + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#64748b;">' + ((sb.scenes || []).length) + ' scenes &middot; ' + ((sb.audioSelections || []).length) + ' audio tracks</div>';
    html += '<div style="font-size:11px;color:#475569;margin-top:6px;">Created ' + formatDate(sb.createdAt) + '</div>';
    html += '</div>';
    return html;
  }

  // ── Scenes Grid View ───────────────────────────────────────

  function renderScenesGrid() {
    var main = document.getElementById('main');
    if (!main || !currentStoryboard) return;

    var scenes = currentStoryboard.scenes || [];
    var html = '<div style="padding:24px;">';

    // Toolbar
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;gap:12px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">' + escHtml(currentStoryboard.name) + '</h2>';
    html += '<span style="font-size:12px;padding:2px 8px;border-radius:99px;background:' + statusColor(currentStoryboard.status) + '22;color:' + statusColor(currentStoryboard.status) + ';">' + statusLabel(currentStoryboard.status) + '</span>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;">';
    // Sub-nav tabs
    html += '<button class="sb-subnav active" data-view="scenes" style="padding:6px 14px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:12px;">Scenes</button>';
    var hasChars = (currentStoryboard.characterReferences || []).length > 0;
    if (hasChars) {
      html += '<button class="sb-subnav" data-view="characters" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Characters</button>';
    }
    html += '<button class="sb-subnav" data-view="audio" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Audio</button>';
    if (currentStoryboard.lastVideoPath) {
      html += '<button class="sb-subnav" data-view="video" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Video</button>';
    }
    html += '<button id="sb-assemble-btn" style="padding:6px 14px;border-radius:6px;background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.3);color:#4ade80;cursor:pointer;font-size:12px;font-weight:500;">Assemble Video</button>';
    // Generate All Missing button
    var missingCount = scenes.filter(function (s) { return !s.imageOptions || s.imageOptions.length === 0; }).length;
    if (missingCount > 0) {
      html += '<button id="sb-generate-all-btn" style="padding:6px 14px;border-radius:6px;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.25);color:#a78bfa;cursor:pointer;font-size:12px;font-weight:500;">&#x1F3A8; Generate All Missing (' + missingCount + ')</button>';
    }
    // Convert to Video button — count scenes with selected images but no video
    var convertableCount = scenes.filter(function (s) {
      var hasImage = s.selectedImageIndex >= 0 && (s.imageOptions || [])[s.selectedImageIndex];
      return hasImage && !s.videoPath;
    }).length;
    if (convertableCount > 0) {
      html += '<button id="sb-convert-all-btn" style="padding:6px 14px;border-radius:6px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;cursor:pointer;font-size:12px;font-weight:500;">&#x1F3AC; Convert to Video (' + convertableCount + ')</button>';
    }
    // Save to Collection button
    html += '<button id="sb-save-collection-btn" style="padding:6px 14px;border-radius:6px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.25);color:#60a5fa;cursor:pointer;font-size:12px;font-weight:500;">&#x1F4C1; Save to Collection</button>';
    html += '</div>';
    html += '</div>';

    // Characters reference row
    var chars = currentStoryboard.characterReferences || [];
    if (chars.length > 0) {
      html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:rgba(30,41,59,0.4);border-radius:10px;border:1px solid rgba(255,255,255,0.06);">';
      html += '<span style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600;">Characters</span>';
      for (var ci = 0; ci < chars.length; ci++) {
        var ch = chars[ci];
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        if (ch.headShotPath) {
          html += '<img src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/charimage/' + encodeURIComponent(ch.name) + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid ' + (ch.autoApply ? '#7c3aed' : 'rgba(255,255,255,0.1)') + ';" onerror="this.style.display=\'none\'" />';
        } else {
          html += '<div style="width:32px;height:32px;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid rgba(255,255,255,0.1);">&#x1F464;</div>';
        }
        html += '<span style="font-size:12px;color:#cbd5e1;">' + escHtml(ch.name) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Scene cards grid
    if (scenes.length === 0) {
      html += '<div style="text-align:center;padding:40px;color:#64748b;">No scenes found in this storyboard.</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">';
      for (var i = 0; i < scenes.length; i++) {
        html += renderSceneCard(scenes[i], i);
      }
      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire events
    main.querySelectorAll('.sb-scene-card').forEach(function (card) {
      card.addEventListener('click', function () {
        selectedSceneIndex = parseInt(card.dataset.sceneIdx, 10);
        storyboardView = 'scene-detail';
        renderStoryboardMain();
      });
    });

    main.querySelectorAll('.sb-subnav').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.dataset.view;
        if (view === 'audio') { storyboardView = 'audio'; }
        else if (view === 'video') { storyboardView = 'video'; }
        else if (view === 'characters') { storyboardView = 'characters'; }
        else { storyboardView = 'scenes'; }
        renderStoryboardMain();
      });
    });

    var genAllBtn = document.getElementById('sb-generate-all-btn');
    if (genAllBtn) {
      genAllBtn.addEventListener('click', function () {
        generateAllMissing();
      });
    }

    var assembleBtn = document.getElementById('sb-assemble-btn');
    if (assembleBtn) {
      assembleBtn.addEventListener('click', function () {
        exportAndAssemble();
      });
    }

    var convertAllBtn = document.getElementById('sb-convert-all-btn');
    if (convertAllBtn) {
      convertAllBtn.addEventListener('click', function () {
        convertAllToVideo();
      });
    }

    var saveColBtn = document.getElementById('sb-save-collection-btn');
    if (saveColBtn) {
      saveColBtn.addEventListener('click', async function () {
        await fetchCollections();
        var scenes = currentStoryboard.scenes || [];
        var items = [];
        for (var si = 0; si < scenes.length; si++) {
          var sc = scenes[si];
          var hasImg = sc.selectedImageIndex >= 0 && (sc.imageOptions || [])[sc.selectedImageIndex];
          if (hasImg) items.push({ type: 'image', sceneIndex: si });
          if (sc.videoPath) items.push({ type: 'video', sceneIndex: si });
        }
        if (currentStoryboard.lastVideoPath) items.push({ type: 'assembled_video' });
        if (items.length === 0) { alert('No images or videos to save.'); return; }
        showSaveToCollectionDialog(items, items.length + ' item(s): scene images, videos, and assembled video');
      });
    }
  }

  function renderSceneCard(scene, idx) {
    var hasImage = scene.imageOptions && scene.imageOptions.length > 0 && scene.selectedImageIndex !== null && scene.selectedImageIndex !== undefined;
    var selectedImg = hasImage ? scene.imageOptions[scene.selectedImageIndex] : null;
    var optionCount = (scene.imageOptions || []).length;

    var html = '<div class="sb-scene-card" data-scene-idx="' + idx + '" style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color 0.15s,transform 0.15s;">';

    // Thumbnail
    html += '<div style="height:160px;background:#0f172a;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">';
    if (selectedImg && selectedImg.filePath) {
      html += '<img src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/image/' + encodeURIComponent(selectedImg.id || '') + '?path=' + encodeURIComponent(selectedImg.filePath) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\';this.parentElement.innerHTML=\'&#x1F3A8;\'" />';
    } else {
      html += '<div style="font-size:2.5rem;color:#475569;">&#x1F3A8;</div>';
    }
    // Option count badge
    if (optionCount > 0) {
      html += '<div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);color:#e2e8f0;font-size:10px;padding:2px 6px;border-radius:4px;">' + optionCount + ' option' + (optionCount !== 1 ? 's' : '') + '</div>';
    }
    // Scene number badge
    html += '<div style="position:absolute;top:8px;left:8px;background:rgba(124,58,237,0.8);color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">' + (scene.sceneNumber || (idx + 1)) + '</div>';
    // Video badge — shows selection state
    if (scene.videoPath) {
      var isUsingVideo = scene.useVideo !== false;
      html += '<div style="position:absolute;bottom:8px;right:8px;background:' + (isUsingVideo ? 'rgba(245,158,11,0.85)' : 'rgba(100,116,139,0.7)') + ';color:#fff;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;">';
      html += isUsingVideo ? '&#x1F3AC; Video' : '&#x1F5BC; Image';
      html += '</div>';
    }
    html += '</div>';

    // Info
    html += '<div style="padding:10px 12px;">';
    html += '<div style="font-size:13px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(scene.title || 'Scene ' + (scene.sceneNumber || idx + 1)) + '</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-top:2px;">' + escHtml(scene.timestamp || '') + '</div>';

    // Characters
    var chars = scene.charactersPresent || [];
    if (chars.length > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;">';
      for (var c = 0; c < chars.length; c++) {
        html += '<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);color:#c4b5fd;">' + escHtml(chars[c]) + '</span>';
      }
      html += '</div>';
    }

    // Selection status
    if (!hasImage) {
      html += '<div style="font-size:10px;color:#f59e0b;margin-top:6px;">&#x26A0; No image selected</div>';
    }

    html += '</div></div>';
    return html;
  }

  // ── Scene Detail View ──────────────────────────────────────

  function renderSceneDetail() {
    var main = document.getElementById('main');
    if (!main || !currentStoryboard || selectedSceneIndex === null) return;

    var scene = currentStoryboard.scenes[selectedSceneIndex];
    if (!scene) {
      storyboardView = 'scenes';
      renderScenesGrid();
      return;
    }

    var options = scene.imageOptions || [];
    var html = '<div style="padding:24px;">';

    // Back button
    html += '<button id="sb-back-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px;">';
    html += '&larr; Back to scenes</button>';

    // Scene header
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<div>';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">Scene ' + (scene.sceneNumber || selectedSceneIndex + 1) + ': ' + escHtml(scene.title) + '</h2>';
    html += '<div style="font-size:13px;color:#64748b;margin-top:4px;">' + escHtml(scene.timestamp || '') + '</div>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button id="sb-generate-btn" style="padding:8px 16px;border-radius:8px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:13px;">Generate Images</button>';
    // Frame to Video button — only when scene has a selected image
    var hasSelectedImage = scene.selectedImageIndex >= 0 && (scene.imageOptions || [])[scene.selectedImageIndex];
    if (hasSelectedImage) {
      html += '<button id="sb-frame-to-video-btn" style="padding:8px 16px;border-radius:8px;background:rgba(245,158,11,0.2);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;cursor:pointer;font-size:13px;">';
      html += scene.videoPath ? '&#x1F3AC; Re-generate Video' : '&#x1F3AC; Frame to Video';
      html += '</button>';
      html += '<button id="sb-scene-save-col-btn" style="padding:8px 16px;border-radius:8px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.25);color:#60a5fa;cursor:pointer;font-size:13px;">&#x1F4C1; Save to Collection</button>';
    }
    html += '</div>';
    html += '</div>';

    // Characters present — show with headshot thumbnails and reference status
    var chars = scene.charactersPresent || [];
    var charRefs = currentStoryboard.characterReferences || [];
    if (chars.length > 0) {
      html += '<div style="margin-bottom:16px;padding:12px 16px;background:rgba(30,41,59,0.4);border-radius:10px;border:1px solid rgba(255,255,255,0.06);">';
      html += '<div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Characters in this scene</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
      for (var ci = 0; ci < chars.length; ci++) {
        var charName = chars[ci];
        var charRef = charRefs.find(function (cr) { return cr.name === charName; });
        var hasRef = charRef && charRef.headShotPath;
        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;background:rgba(124,58,237,' + (hasRef ? '0.15' : '0.05') + ');border:1px solid rgba(124,58,237,' + (hasRef ? '0.3' : '0.1') + ');">';
        if (hasRef) {
          html += '<img src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/image/headshot?path=' + encodeURIComponent(charRef.headShotPath) + '" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid rgba(124,58,237,0.4);" onerror="this.style.display=\'none\'" />';
        } else {
          html += '<div style="width:28px;height:28px;border-radius:50%;background:rgba(124,58,237,0.1);display:flex;align-items:center;justify-content:center;font-size:12px;color:#64748b;">?</div>';
        }
        html += '<div>';
        html += '<div style="font-size:12px;font-weight:500;color:#c4b5fd;">' + escHtml(charName) + '</div>';
        if (charRef && charRef.description) {
          html += '<div style="font-size:10px;color:#64748b;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(charRef.description) + '</div>';
        }
        html += '</div>';
        if (hasRef && charRef.autoApply) {
          html += '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(34,197,94,0.15);color:#4ade80;">ref ✓</span>';
        } else if (!hasRef) {
          html += '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,0.15);color:#fbbf24;">no ref</span>';
        }
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Image prompt (collapsible)
    html += '<details style="margin-bottom:20px;background:rgba(30,41,59,0.4);border-radius:8px;border:1px solid rgba(255,255,255,0.06);padding:12px;">';
    html += '<summary style="cursor:pointer;font-size:12px;color:#94a3b8;font-weight:500;">Image Prompt</summary>';
    html += '<div style="margin-top:8px;font-size:12px;color:#cbd5e1;line-height:1.6;white-space:pre-wrap;max-height:200px;overflow-y:auto;">' + escHtml(scene.imagePrompt || 'No prompt available') + '</div>';
    html += '</details>';

    // Image options grid
    html += '<div style="margin-bottom:12px;font-size:13px;font-weight:500;color:#e2e8f0;">Image Options (' + options.length + ')</div>';

    if (options.length === 0) {
      html += '<div style="text-align:center;padding:40px;background:rgba(30,41,59,0.3);border-radius:12px;border:2px dashed rgba(255,255,255,0.1);">';
      html += '<div style="font-size:2rem;margin-bottom:8px;">&#x1F3A8;</div>';
      html += '<div style="color:#64748b;font-size:13px;">No images generated yet. Click "Generate Images" to create options.</div>';
      html += '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">';
      for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var isSelected = scene.selectedImageIndex === i;
        html += '<div class="sb-image-option" data-opt-idx="' + i + '" style="background:rgba(30,41,59,0.6);border:2px solid ' + (isSelected ? '#7c3aed' : 'rgba(255,255,255,0.06)') + ';border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color 0.15s;position:relative;">';
        html += '<div style="height:200px;background:#0f172a;overflow:hidden;">';
        html += '<img src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/image/' + encodeURIComponent(opt.id || '') + '?path=' + encodeURIComponent(opt.filePath || '') + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'" />';
        html += '</div>';
        if (isSelected) {
          html += '<div style="position:absolute;top:8px;right:8px;background:#7c3aed;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600;">Selected</div>';
        }
        html += '<div style="padding:8px;font-size:10px;color:#64748b;">' + formatDate(opt.generatedAt) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Video preview (if video has been generated)
    if (scene.videoPath) {
      var useVideo = scene.useVideo !== false; // default true when video exists
      html += '<div style="margin-top:20px;">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">';
      html += '<span style="font-size:13px;font-weight:500;color:#e2e8f0;">Generated Video</span>';
      html += '<span style="font-size:10px;color:#4ade80;background:rgba(34,197,94,0.15);padding:2px 8px;border-radius:4px;">Ready</span>';
      if (scene.videoGeneratedAt) {
        html += '<span style="font-size:10px;color:#64748b;">' + formatDate(scene.videoGeneratedAt) + '</span>';
      }
      html += '<span style="flex:1;"></span>';
      // Use in Assembly toggle
      html += '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:' + (useVideo ? '#fbbf24' : '#64748b') + ';">';
      html += '<input type="checkbox" id="sb-use-video-toggle" ' + (useVideo ? 'checked' : '') + ' style="accent-color:#f59e0b;cursor:pointer;width:16px;height:16px;" />';
      html += 'Use in assembly';
      html += '</label>';
      html += '</div>';
      html += '<div style="background:#0f172a;border-radius:10px;overflow:hidden;border:2px solid ' + (useVideo ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.06)') + ';position:relative;">';
      html += '<video controls style="width:100%;max-height:400px;display:block;" src="/api/file?path=' + encodeURIComponent(scene.videoPath) + '"></video>';
      if (useVideo) {
        html += '<div style="position:absolute;top:8px;left:8px;background:rgba(245,158,11,0.85);color:#fff;font-size:10px;font-weight:600;padding:3px 10px;border-radius:4px;">&#x1F3AC; Using in assembly</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire events
    var backBtn = document.getElementById('sb-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        storyboardView = 'scenes';
        selectedSceneIndex = null;
        renderStoryboardMain();
      });
    }

    var generateBtn = document.getElementById('sb-generate-btn');
    if (generateBtn) {
      generateBtn.addEventListener('click', function () {
        generateSceneImage(selectedSceneIndex);
      });
    }

    var f2vBtn = document.getElementById('sb-frame-to-video-btn');
    if (f2vBtn) {
      f2vBtn.addEventListener('click', function () {
        convertSceneToVideo(selectedSceneIndex);
      });
    }

    var sceneColBtn = document.getElementById('sb-scene-save-col-btn');
    if (sceneColBtn) {
      sceneColBtn.addEventListener('click', async function () {
        await fetchCollections();
        var items = [];
        var sc = currentStoryboard.scenes[selectedSceneIndex];
        if (sc.selectedImageIndex >= 0 && (sc.imageOptions || [])[sc.selectedImageIndex]) {
          items.push({ type: 'image', sceneIndex: selectedSceneIndex });
        }
        if (sc.videoPath) items.push({ type: 'video', sceneIndex: selectedSceneIndex });
        if (items.length === 0) { alert('No media to save.'); return; }
        showSaveToCollectionDialog(items, 'Scene ' + (sc.sceneNumber || selectedSceneIndex + 1) + ': ' + items.length + ' item(s)');
      });
    }

    var useVideoToggle = document.getElementById('sb-use-video-toggle');
    if (useVideoToggle) {
      useVideoToggle.addEventListener('change', function () {
        scene.useVideo = useVideoToggle.checked;
        saveStoryboard().then(function () {
          renderSceneDetail();
        });
      });
    }

    main.querySelectorAll('.sb-image-option').forEach(function (card) {
      card.addEventListener('click', function () {
        var idx = parseInt(card.dataset.optIdx, 10);
        scene.selectedImageIndex = idx;
        saveStoryboard().then(function () {
          renderSceneDetail();
        });
      });
    });
  }

  // ── Characters Panel ──────────────────────────────────────

  function renderCharactersPanel() {
    var main = document.getElementById('main');
    if (!main || !currentStoryboard) return;

    var chars = currentStoryboard.characterReferences || [];
    var html = '<div style="padding:24px;">';

    // Toolbar
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;gap:12px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">' + escHtml(currentStoryboard.name) + '</h2>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button class="sb-subnav" data-view="scenes" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Scenes</button>';
    html += '<button class="sb-subnav active" data-view="characters" style="padding:6px 14px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:12px;">Characters</button>';
    html += '<button class="sb-subnav" data-view="audio" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Audio</button>';
    if (currentStoryboard.lastVideoPath) {
      html += '<button class="sb-subnav" data-view="video" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Video</button>';
    }
    html += '<button id="sb-assemble-btn" style="padding:6px 14px;border-radius:6px;background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.3);color:#4ade80;cursor:pointer;font-size:12px;font-weight:500;">Assemble Video</button>';
    html += '</div>';
    html += '</div>';

    html += '<div style="font-size:13px;color:#94a3b8;margin-bottom:20px;">Assign headshot reference images to each character. These will be sent to the image generator to maintain visual consistency across scenes.</div>';

    if (chars.length === 0) {
      html += '<div style="text-align:center;padding:40px;color:#64748b;">';
      html += '<div style="font-size:2rem;margin-bottom:8px;">&#x1F464;</div>';
      html += '<div>No named characters found in the production package.</div>';
      html += '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">';
      for (var i = 0; i < chars.length; i++) {
        var ch = chars[i];
        var hasHeadshot = ch.headShotPath && ch.headShotPath.length > 0;
        var scenesWithChar = (currentStoryboard.scenes || []).filter(function (s) {
          return (s.charactersPresent || []).indexOf(ch.name) >= 0;
        }).length;

        html += '<div class="sb-char-card" style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;">';

        // Header with name and role
        html += '<div style="padding:16px 16px 12px;">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;">';
        html += '<div>';
        html += '<div style="font-size:16px;font-weight:600;color:#e2e8f0;">' + escHtml(ch.name) + '</div>';
        if (ch.role) {
          html += '<div style="font-size:11px;color:#64748b;margin-top:2px;">' + escHtml(ch.role) + '</div>';
        }
        html += '</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="font-size:10px;color:#64748b;">' + scenesWithChar + ' scene' + (scenesWithChar !== 1 ? 's' : '') + '</span>';
        // Auto-apply toggle
        html += '<label style="display:flex;align-items:center;gap:4px;cursor:pointer;">';
        html += '<input type="checkbox" class="sb-char-auto" data-char-idx="' + i + '" ' + (ch.autoApply !== false ? 'checked' : '') + ' style="cursor:pointer;">';
        html += '<span style="font-size:10px;color:#94a3b8;">Auto</span>';
        html += '</label>';
        html += '</div>';
        html += '</div>';

        // Description
        if (ch.description) {
          html += '<div style="font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.5;">' + escHtml(ch.description) + '</div>';
        }
        html += '</div>';

        // Headshot area
        html += '<div style="padding:0 16px 16px;">';
        if (hasHeadshot) {
          html += '<div style="position:relative;border-radius:8px;overflow:hidden;border:2px solid rgba(124,58,237,0.3);background:#0f172a;">';
          html += '<img src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/image/headshot?path=' + encodeURIComponent(ch.headShotPath) + '" style="width:100%;max-height:200px;object-fit:cover;display:block;" onerror="this.style.display=\'none\'" />';
          html += '<div style="position:absolute;bottom:0;left:0;right:0;padding:6px 10px;background:linear-gradient(transparent,rgba(0,0,0,0.8));font-size:10px;color:#94a3b8;word-break:break-all;">' + escHtml(ch.headShotPath.split('/').pop()) + '</div>';
          html += '</div>';
          html += '<div style="display:flex;gap:6px;margin-top:8px;">';
          html += '<button class="sb-char-change" data-char-idx="' + i + '" style="flex:1;padding:6px;border-radius:6px;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.25);color:#a78bfa;cursor:pointer;font-size:11px;">Change</button>';
          html += '<button class="sb-char-remove" data-char-idx="' + i + '" style="padding:6px 10px;border-radius:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:11px;">Remove</button>';
          html += '</div>';
        } else {
          html += '<div style="border:2px dashed rgba(255,255,255,0.1);border-radius:8px;padding:20px;text-align:center;cursor:pointer;" class="sb-char-assign" data-char-idx="' + i + '">';
          html += '<div style="font-size:1.5rem;margin-bottom:6px;">&#x1F4F7;</div>';
          html += '<div style="font-size:12px;color:#64748b;">Click to assign headshot</div>';
          html += '<div style="font-size:10px;color:#475569;margin-top:4px;">Image will be used as reference during generation</div>';
          html += '</div>';
        }
        html += '</div>';

        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire sub-nav
    main.querySelectorAll('.sb-subnav').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.dataset.view;
        if (view === 'scenes') { storyboardView = 'scenes'; }
        else if (view === 'audio') { storyboardView = 'audio'; }
        else if (view === 'video') { storyboardView = 'video'; }
        else if (view === 'characters') { storyboardView = 'characters'; }
        renderStoryboardMain();
      });
    });

    var assembleBtn = document.getElementById('sb-assemble-btn');
    if (assembleBtn) {
      assembleBtn.addEventListener('click', function () { exportAndAssemble(); });
    }

    // Auto-apply toggles
    main.querySelectorAll('.sb-char-auto').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(cb.dataset.charIdx, 10);
        chars[idx].autoApply = cb.checked;
        saveStoryboard();
      });
    });

    // Assign headshot (click dashed area or "Change" button)
    function assignHeadshot(charIdx) {
      // Create a file input to pick an image
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async function () {
        if (!input.files || !input.files[0]) return;
        var file = input.files[0];
        var formData = new FormData();
        formData.append('headshot', file);
        formData.append('characterIndex', String(charIdx));
        try {
          var r = await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/headshot', {
            method: 'POST',
            body: formData,
          });
          var data = await r.json();
          if (data.error) {
            alert('Failed to upload headshot: ' + data.error);
          } else {
            chars[charIdx].headShotPath = data.filePath;
            await saveStoryboard();
            renderCharactersPanel();
          }
        } catch (err) {
          alert('Error uploading headshot: ' + err.message);
        }
        input.remove();
      });
      input.click();
    }

    main.querySelectorAll('.sb-char-assign').forEach(function (el) {
      el.addEventListener('click', function () {
        assignHeadshot(parseInt(el.dataset.charIdx, 10));
      });
    });

    main.querySelectorAll('.sb-char-change').forEach(function (btn) {
      btn.addEventListener('click', function () {
        assignHeadshot(parseInt(btn.dataset.charIdx, 10));
      });
    });

    main.querySelectorAll('.sb-char-remove').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var idx = parseInt(btn.dataset.charIdx, 10);
        chars[idx].headShotPath = '';
        await saveStoryboard();
        renderCharactersPanel();
      });
    });
  }

  // ── Audio Panel ────────────────────────────────────────────

  function renderAudioPanel() {
    var main = document.getElementById('main');
    if (!main || !currentStoryboard) return;

    var audioSelections = currentStoryboard.audioSelections || [];
    var html = '<div style="padding:24px;">';

    // Toolbar (same as scenes grid)
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;gap:12px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">' + escHtml(currentStoryboard.name) + '</h2>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button class="sb-subnav" data-view="scenes" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Scenes</button>';
    if ((currentStoryboard.characterReferences || []).length > 0) {
      html += '<button class="sb-subnav" data-view="characters" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Characters</button>';
    }
    html += '<button class="sb-subnav active" data-view="audio" style="padding:6px 14px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:12px;">Audio</button>';
    if (currentStoryboard.lastVideoPath) {
      html += '<button class="sb-subnav" data-view="video" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Video</button>';
    }
    html += '<button id="sb-assemble-btn" style="padding:6px 14px;border-radius:6px;background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.3);color:#4ade80;cursor:pointer;font-size:12px;font-weight:500;">Assemble Video</button>';
    html += '</div>';
    html += '</div>';

    html += '<div style="font-size:13px;color:#94a3b8;margin-bottom:16px;">Select which audio tracks to include in your video. Deselected tracks will be excluded.</div>';

    if (audioSelections.length === 0) {
      html += '<div style="text-align:center;padding:40px;color:#64748b;">';
      html += '<div style="font-size:2rem;margin-bottom:8px;">&#x1F3B5;</div>';
      html += '<div>No audio tracks found in this collection.</div>';
      html += '</div>';
    } else {
      for (var i = 0; i < audioSelections.length; i++) {
        var track = audioSelections[i];
        var isSelected = track.selected !== false;
        html += '<div class="sb-audio-track" data-track-idx="' + i + '" style="background:rgba(30,41,59,' + (isSelected ? '0.6' : '0.2') + ');border:1px solid ' + (isSelected ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)') + ';border-radius:10px;padding:16px;margin-bottom:8px;opacity:' + (isSelected ? '1' : '0.5') + ';transition:all 0.15s;">';

        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">';
        // Checkbox
        html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">';
        html += '<input type="checkbox" class="sb-track-check" data-track-idx="' + i + '" ' + (isSelected ? 'checked' : '') + ' style="cursor:pointer;">';
        html += '<span style="font-size:14px;font-weight:500;color:' + (isSelected ? '#e2e8f0' : '#64748b') + ';">' + escHtml(track.name) + '</span>';
        html += '</label>';

        // Role dropdown
        html += '<select class="sb-track-role" data-track-idx="' + i + '" style="padding:3px 8px;border-radius:4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-size:11px;">';
        var roles = ['music', 'sfx', 'ambient'];
        for (var ri = 0; ri < roles.length; ri++) {
          html += '<option value="' + roles[ri] + '"' + (track.role === roles[ri] ? ' selected' : '') + '>' + roles[ri].charAt(0).toUpperCase() + roles[ri].slice(1) + '</option>';
        }
        html += '</select>';

        // Volume slider
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="font-size:10px;color:#64748b;">Vol:</span>';
        html += '<input type="range" class="sb-track-vol" data-track-idx="' + i + '" min="0" max="100" value="' + Math.round((track.volume || 0.3) * 100) + '" style="width:80px;">';
        html += '<span class="sb-vol-label" style="font-size:10px;color:#64748b;min-width:28px;">' + Math.round((track.volume || 0.3) * 100) + '%</span>';
        html += '</div>';

        html += '</div>';

        // Audio player
        if (track.path) {
          html += '<audio controls style="width:100%;height:32px;"><source src="/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/audio?path=' + encodeURIComponent(track.path) + '" type="audio/mpeg"></audio>';
        }

        html += '</div>';
      }
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire events
    main.querySelectorAll('.sb-subnav').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.dataset.view;
        if (v === 'audio') { storyboardView = 'audio'; }
        else if (v === 'video') { storyboardView = 'video'; }
        else if (v === 'characters') { storyboardView = 'characters'; }
        else { storyboardView = 'scenes'; }
        renderStoryboardMain();
      });
    });

    main.querySelectorAll('.sb-track-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(cb.dataset.trackIdx, 10);
        audioSelections[idx].selected = cb.checked;
        saveStoryboard().then(function () { renderAudioPanel(); });
      });
    });

    main.querySelectorAll('.sb-track-role').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var idx = parseInt(sel.dataset.trackIdx, 10);
        audioSelections[idx].role = sel.value;
        saveStoryboard();
      });
    });

    main.querySelectorAll('.sb-track-vol').forEach(function (slider) {
      slider.addEventListener('input', function () {
        var idx = parseInt(slider.dataset.trackIdx, 10);
        var vol = parseInt(slider.value, 10) / 100;
        audioSelections[idx].volume = vol;
        var label = slider.parentElement.querySelector('.sb-vol-label');
        if (label) label.textContent = Math.round(vol * 100) + '%';
      });
      slider.addEventListener('change', function () {
        saveStoryboard();
      });
    });

    var assembleBtn = document.getElementById('sb-assemble-btn');
    if (assembleBtn) {
      assembleBtn.addEventListener('click', function () {
        exportAndAssemble();
      });
    }
  }

  // ── Typeahead Component ─────────────────────────────────────

  function createTypeahead(container, options) {
    // options: { placeholder, items (array of {label, sublabel, value, data}), onSelect(item), onInput(query) }
    var state = { items: options.items || [], filteredItems: [], selectedIdx: -1, open: false, value: '' };

    var inputStyle = 'width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#e2e8f0;font-size:13px;box-sizing:border-box;';
    var dropdownStyle = 'position:absolute;left:0;right:0;top:100%;margin-top:2px;background:#1e293b;border:1px solid rgba(124,58,237,0.3);border-radius:8px;max-height:200px;overflow-y:auto;z-index:10;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    var itemStyle = 'padding:8px 12px;cursor:pointer;transition:background 0.1s;';
    var itemHoverBg = 'rgba(124,58,237,0.15)';

    container.style.position = 'relative';
    container.innerHTML = '<input type="text" placeholder="' + escAttr(options.placeholder || '') + '" style="' + inputStyle + '" autocomplete="off">'
      + '<div class="ta-dropdown" style="' + dropdownStyle + '"></div>';

    var input = container.querySelector('input');
    var dropdown = container.querySelector('.ta-dropdown');

    function renderDropdown() {
      if (state.filteredItems.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      var html = '';
      for (var i = 0; i < state.filteredItems.length; i++) {
        var item = state.filteredItems[i];
        var isHighlighted = i === state.selectedIdx;
        html += '<div class="ta-item" data-idx="' + i + '" style="' + itemStyle + 'background:' + (isHighlighted ? itemHoverBg : 'transparent') + ';">';
        html += '<div style="font-size:13px;color:#e2e8f0;font-weight:500;">' + escHtml(item.label) + '</div>';
        if (item.sublabel) {
          html += '<div style="font-size:11px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(item.sublabel) + '</div>';
        }
        html += '</div>';
      }
      dropdown.innerHTML = html;
      dropdown.style.display = '';

      // Wire click events on items
      dropdown.querySelectorAll('.ta-item').forEach(function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault(); // prevent blur
          var idx = parseInt(el.dataset.idx, 10);
          selectItem(idx);
        });
        el.addEventListener('mouseenter', function () {
          state.selectedIdx = parseInt(el.dataset.idx, 10);
          highlightItem();
        });
      });
    }

    function highlightItem() {
      dropdown.querySelectorAll('.ta-item').forEach(function (el, i) {
        el.style.background = i === state.selectedIdx ? itemHoverBg : 'transparent';
      });
    }

    function selectItem(idx) {
      var item = state.filteredItems[idx];
      if (!item) return;
      state.value = item.value;
      input.value = item.label;
      input.style.borderColor = 'rgba(124,58,237,0.4)';
      dropdown.style.display = 'none';
      state.open = false;
      if (options.onSelect) options.onSelect(item);
    }

    function filter(query) {
      query = (query || '').toLowerCase();
      if (!query) {
        state.filteredItems = state.items.slice(0, 20);
      } else {
        state.filteredItems = state.items.filter(function (item) {
          return item.label.toLowerCase().indexOf(query) !== -1
            || (item.sublabel && item.sublabel.toLowerCase().indexOf(query) !== -1)
            || (item.value && String(item.value).toLowerCase().indexOf(query) !== -1);
        }).slice(0, 20);
      }
      state.selectedIdx = -1;
    }

    input.addEventListener('focus', function () {
      filter(input.value);
      state.open = true;
      renderDropdown();
    });

    input.addEventListener('input', function () {
      state.value = '';
      input.style.borderColor = 'rgba(255,255,255,0.1)';
      filter(input.value);
      state.open = true;
      renderDropdown();
      if (options.onInput) options.onInput(input.value);
    });

    input.addEventListener('blur', function () {
      // Delay to allow click on dropdown item
      setTimeout(function () {
        dropdown.style.display = 'none';
        state.open = false;
      }, 150);
    });

    input.addEventListener('keydown', function (e) {
      if (!state.open || state.filteredItems.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.selectedIdx = Math.min(state.selectedIdx + 1, state.filteredItems.length - 1);
        highlightItem();
        // Scroll into view
        var highlighted = dropdown.querySelectorAll('.ta-item')[state.selectedIdx];
        if (highlighted) highlighted.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.selectedIdx = Math.max(state.selectedIdx - 1, 0);
        highlightItem();
        var highlighted2 = dropdown.querySelectorAll('.ta-item')[state.selectedIdx];
        if (highlighted2) highlighted2.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (state.selectedIdx >= 0) {
          selectItem(state.selectedIdx);
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        state.open = false;
      }
    });

    return {
      getValue: function () { return state.value; },
      getInputValue: function () { return input.value; },
      setItems: function (items) {
        state.items = items;
        filter(input.value);
        if (state.open) renderDropdown();
      },
      clear: function () {
        state.value = '';
        input.value = '';
        input.style.borderColor = 'rgba(255,255,255,0.1)';
      },
      getInput: function () { return input; },
    };
  }

  // ── New Storyboard Dialog ──────────────────────────────────

  async function showNewStoryboardDialog() {
    // Fetch collections for typeahead
    var collections = [];
    try {
      var r = await fetch('/api/assets/collections');
      var data = await r.json();
      collections = data.collections || [];
    } catch (err) {
      console.error('Failed to fetch collections:', err);
    }

    // Modal overlay
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:#1e293b;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:480px;max-width:90vw;';

    modal.innerHTML = '<h3 style="margin:0 0 16px;color:#e2e8f0;font-size:16px;">New Storyboard</h3>'
      + '<div style="margin-bottom:14px;">'
      + '<label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">Name</label>'
      + '<input id="sb-new-name" type="text" placeholder="My Storyboard" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#e2e8f0;font-size:13px;box-sizing:border-box;">'
      + '</div>'
      + '<div style="margin-bottom:14px;">'
      + '<label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">Collection</label>'
      + '<div id="sb-new-collection-ta"></div>'
      + '</div>'
      + '<div style="margin-bottom:18px;">'
      + '<label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">Production Package</label>'
      + '<div id="sb-new-pkg-ta"></div>'
      + '<div id="sb-pkg-hint" style="font-size:11px;color:#475569;margin-top:4px;">Select a collection first to scan for production packages.</div>'
      + '</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      + '<button id="sb-new-cancel" style="padding:8px 16px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:13px;">Cancel</button>'
      + '<button id="sb-new-create" style="padding:8px 16px;border-radius:6px;background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.4);color:#a78bfa;cursor:pointer;font-size:13px;font-weight:500;">Create</button>'
      + '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ── Collection typeahead ──
    var collectionItems = collections.map(function (c) {
      return {
        label: c.name,
        sublabel: c.slug + (c.rootPath ? '  ·  ' + c.rootPath : ''),
        value: c.slug,
        data: c,
      };
    });

    var selectedCollection = null;
    var collectionTa = createTypeahead(document.getElementById('sb-new-collection-ta'), {
      placeholder: 'Start typing to search collections...',
      items: collectionItems,
      onSelect: function (item) {
        selectedCollection = item.data;
        // Auto-fill name if empty
        var nameInput = document.getElementById('sb-new-name');
        if (nameInput && !nameInput.value.trim()) {
          nameInput.value = item.data.name + ' Storyboard';
        }
        // Scan for production packages in this collection
        loadProductionPackages(item.data);
      },
    });

    // ── Production package typeahead ──
    var pkgTa = createTypeahead(document.getElementById('sb-new-pkg-ta'), {
      placeholder: 'Select a collection first...',
      items: [],
    });
    // Disable pkg input until collection is selected
    pkgTa.getInput().disabled = true;
    pkgTa.getInput().style.opacity = '0.5';

    async function loadProductionPackages(collection) {
      var hint = document.getElementById('sb-pkg-hint');
      if (hint) hint.textContent = 'Scanning for production packages...';

      pkgTa.clear();
      pkgTa.getInput().disabled = false;
      pkgTa.getInput().style.opacity = '1';
      pkgTa.getInput().placeholder = 'Searching...';

      try {
        var r = await fetch('/api/storyboards/scan-packages?collectionSlug=' + encodeURIComponent(collection.slug));
        var data = await r.json();
        var packages = data.packages || [];

        var pkgItems = packages.map(function (pkg) {
          return {
            label: pkg.name,
            sublabel: pkg.path,
            value: pkg.path,
            data: pkg,
          };
        });

        pkgTa.setItems(pkgItems);
        pkgTa.getInput().placeholder = packages.length > 0
          ? 'Type to search ' + packages.length + ' package(s)...'
          : 'No packages found — type a path manually';

        if (hint) {
          hint.textContent = packages.length > 0
            ? packages.length + ' production package(s) found in ' + (collection.rootPath || collection.slug)
            : 'No production packages found. You can type a path manually.';
          hint.style.color = packages.length > 0 ? '#22c55e' : '#f59e0b';
        }

        // Auto-select if only one
        if (pkgItems.length === 1) {
          pkgTa.getInput().value = pkgItems[0].label;
          // Trigger internal selection
          pkgTa.setItems(pkgItems);
        }
      } catch (err) {
        console.error('Failed to scan packages:', err);
        pkgTa.getInput().placeholder = 'Error scanning — type a path manually';
        if (hint) {
          hint.textContent = 'Could not scan collection directory. Type a path manually.';
          hint.style.color = '#ef4444';
        }
      }
    }

    // ── Modal events ──
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    document.getElementById('sb-new-cancel').addEventListener('click', function () {
      overlay.remove();
    });

    document.getElementById('sb-new-create').addEventListener('click', async function () {
      var name = document.getElementById('sb-new-name').value.trim() || 'Untitled Storyboard';
      var slug = collectionTa.getValue() || collectionTa.getInputValue().trim();
      var pkgPath = pkgTa.getValue() || pkgTa.getInputValue().trim();

      if (!slug) { alert('Please select a collection.'); return; }
      if (!pkgPath) { alert('Please select or enter a production package path.'); return; }

      var createBtn = document.getElementById('sb-new-create');
      if (createBtn) { createBtn.disabled = true; createBtn.textContent = 'Creating...'; }

      try {
        var r = await fetch('/api/storyboards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, collectionSlug: slug, productionPackagePath: pkgPath }),
        });
        var data = await r.json();
        if (data.storyboard && data.storyboard.id) {
          overlay.remove();
          selectedStoryboardId = data.storyboard.id;
          storyboardView = 'scenes';
          await loadStoryboardsList();
          await loadStoryboard(data.storyboard.id);
          renderStoryboardSidebar();
          renderStoryboardMain();
        } else {
          alert('Failed to create storyboard: ' + (data.error || 'Unknown error'));
          if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create'; }
        }
      } catch (err) {
        alert('Error creating storyboard: ' + err.message);
        if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create'; }
      }
    });

    // Focus the name input
    setTimeout(function () {
      var nameInput = document.getElementById('sb-new-name');
      if (nameInput) nameInput.focus();
    }, 100);
  }

  // ── Image Generation ───────────────────────────────────────

  async function generateSceneImage(sceneIdx) {
    if (!currentStoryboard || sceneIdx === null) return;
    var scene = currentStoryboard.scenes[sceneIdx];
    if (!scene) return;

    var btn = document.getElementById('sb-generate-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating...';
    }

    try {
      var r = await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber: scene.sceneNumber || sceneIdx + 1 }),
      });
      var data = await r.json();
      if (data.error) {
        alert('Generation failed: ' + data.error);
        if (btn) { btn.disabled = false; btn.textContent = 'Generate Images'; }
      } else {
        // Reload storyboard to get updated image options
        await loadStoryboard(currentStoryboard.id);
        renderSceneDetail();
      }
    } catch (err) {
      alert('Error generating image: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Images'; }
    }
  }

  // ── Frame to Video (single scene) ───────────────────────

  async function convertSceneToVideo(sceneIdx) {
    if (!currentStoryboard || sceneIdx === null) return;
    var scene = currentStoryboard.scenes[sceneIdx];
    if (!scene) return;

    var selIdx = scene.selectedImageIndex;
    if (selIdx === null || selIdx === undefined || selIdx === -1 || !(scene.imageOptions || [])[selIdx]) {
      alert('Please select an image for this scene first.');
      return;
    }

    var btn = document.getElementById('sb-frame-to-video-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting...';
    }

    // Show progress overlay
    var overlay = document.createElement('div');
    overlay.id = 'sb-f2v-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(245,158,11,0.3);border-radius:16px;padding:32px 40px;text-align:center;min-width:420px;max-width:520px;">'
      + '<div style="font-size:2.5rem;margin-bottom:12px;">&#x1F3AC;</div>'
      + '<div style="font-size:18px;font-weight:600;color:#e2e8f0;margin-bottom:6px;">Converting to Video</div>'
      + '<div style="font-size:12px;color:#64748b;margin-bottom:16px;">Scene ' + (scene.sceneNumber || sceneIdx + 1) + ': ' + escHtml(scene.title || '') + '</div>'
      + '<div id="sb-f2v-status" style="font-size:13px;color:#fbbf24;margin-bottom:16px;">Starting Midjourney workflow...</div>'
      + '<div style="background:rgba(0,0,0,0.3);border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px;">'
      + '<div id="sb-f2v-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#f59e0b,#fbbf24);border-radius:99px;transition:width 0.3s;"></div>'
      + '</div>'
      + '<div id="sb-f2v-step" style="font-size:11px;color:#64748b;">Preparing...</div>'
      + '<button id="sb-f2v-cancel" style="margin-top:16px;padding:6px 18px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:11px;">Cancel</button>'
      + '</div>';
    document.body.appendChild(overlay);

    var cancelBtn = document.getElementById('sb-f2v-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        try { await fetch('/api/workflows/run/cancel', { method: 'POST' }); } catch (e) { /* ok */ }
      });
    }

    try {
      var r = await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/frame-to-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumbers: [scene.sceneNumber || sceneIdx + 1] }),
      });
      var data = await r.json();

      if (data.error) {
        overlay.remove();
        alert('Frame to Video failed: ' + data.error);
        if (btn) { btn.disabled = false; btn.textContent = 'Frame to Video'; }
        return;
      }

      // Poll workflow run status
      var maxPolls = 400; // ~10 minutes
      var pollInterval = 1500;
      for (var p = 0; p < maxPolls; p++) {
        await new Promise(function (resolve) { setTimeout(resolve, pollInterval); });

        var statusR = await fetch('/api/workflows/run/status');
        var status = await statusR.json();

        var statusEl = document.getElementById('sb-f2v-status');
        var barEl = document.getElementById('sb-f2v-bar');
        var stepEl = document.getElementById('sb-f2v-step');

        if (status.active !== false && status.stepsTotal > 0) {
          var pct = Math.round((status.stepsCompleted / status.stepsTotal) * 100);
          if (barEl) barEl.style.width = pct + '%';
          if (stepEl) stepEl.textContent = status.currentStep || ('Step ' + status.stepsCompleted + '/' + status.stepsTotal);
          if (statusEl) statusEl.textContent = 'Running Midjourney workflow...';
        }

        if (status.done) {
          overlay.remove();

          if (status.success) {
            await loadStoryboard(currentStoryboard.id);
            renderSceneDetail();
          } else {
            alert('Frame to Video failed: ' + (status.error || 'Unknown error'));
            if (btn) { btn.disabled = false; btn.textContent = 'Frame to Video'; }
          }
          return;
        }
      }

      // Timed out
      overlay.remove();
      alert('Frame to Video timed out. The workflow may still be running.');
      if (btn) { btn.disabled = false; btn.textContent = 'Frame to Video'; }

    } catch (err) {
      overlay.remove();
      alert('Error: ' + (err.message || err));
      if (btn) { btn.disabled = false; btn.textContent = 'Frame to Video'; }
    }
  }

  // ── Convert All to Video (batch) ─────────────────────────

  async function convertAllToVideo() {
    if (!currentStoryboard) return;
    var scenes = currentStoryboard.scenes || [];

    // Collect scenes that have selected images but no video yet
    var toConvert = scenes.filter(function (s) {
      var hasImage = s.selectedImageIndex >= 0 && (s.imageOptions || [])[s.selectedImageIndex];
      return hasImage && !s.videoPath;
    });

    if (toConvert.length === 0) {
      alert('All scenes already have videos, or no scenes have selected images.');
      return;
    }

    var sceneNumbers = toConvert.map(function (s) { return s.sceneNumber; });

    var btn = document.getElementById('sb-convert-all-btn');
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
    }

    // Show progress overlay
    var overlay = document.createElement('div');
    overlay.id = 'sb-f2v-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(245,158,11,0.3);border-radius:16px;padding:32px 40px;text-align:center;min-width:420px;max-width:520px;">'
      + '<div style="font-size:2.5rem;margin-bottom:12px;">&#x1F3AC;</div>'
      + '<div style="font-size:18px;font-weight:600;color:#e2e8f0;margin-bottom:6px;">Converting Scenes to Video</div>'
      + '<div style="font-size:12px;color:#64748b;margin-bottom:16px;">' + toConvert.length + ' scene' + (toConvert.length > 1 ? 's' : '') + ' to process</div>'
      + '<div id="sb-f2v-status" style="font-size:13px;color:#fbbf24;margin-bottom:16px;">Starting...</div>'
      + '<div style="background:rgba(0,0,0,0.3);border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px;">'
      + '<div id="sb-f2v-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#f59e0b,#fbbf24);border-radius:99px;transition:width 0.3s;"></div>'
      + '</div>'
      + '<div id="sb-f2v-step" style="font-size:11px;color:#64748b;">Preparing...</div>'
      + '<button id="sb-f2v-cancel" style="margin-top:16px;padding:6px 18px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:11px;">Cancel</button>'
      + '</div>';
    document.body.appendChild(overlay);

    var cancelBtn = document.getElementById('sb-f2v-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        try { await fetch('/api/workflows/run/cancel', { method: 'POST' }); } catch (e) { /* ok */ }
      });
    }

    try {
      var r = await fetch('/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/frame-to-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumbers: sceneNumbers }),
      });
      var data = await r.json();

      if (data.error) {
        overlay.remove();
        alert('Convert to Video failed: ' + data.error);
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        return;
      }

      // Poll workflow run status
      var maxPolls = 1200; // ~30 minutes for batch
      var pollInterval = 1500;
      for (var p = 0; p < maxPolls; p++) {
        await new Promise(function (resolve) { setTimeout(resolve, pollInterval); });

        var statusR = await fetch('/api/workflows/run/status');
        var status = await statusR.json();

        var statusEl = document.getElementById('sb-f2v-status');
        var barEl = document.getElementById('sb-f2v-bar');
        var stepEl = document.getElementById('sb-f2v-step');

        if (status.active !== false && status.stepsTotal > 0) {
          var pct = Math.round((status.stepsCompleted / status.stepsTotal) * 100);
          if (barEl) barEl.style.width = pct + '%';
          if (stepEl) stepEl.textContent = status.currentStep || ('Step ' + status.stepsCompleted + '/' + status.stepsTotal);
          if (statusEl) statusEl.textContent = 'Running Midjourney workflow...';
        }

        if (status.done) {
          overlay.remove();

          if (status.success) {
            await loadStoryboard(currentStoryboard.id);
            renderScenesGrid();
          } else {
            alert('Convert to Video finished with errors: ' + (status.error || 'Some scenes may have failed.'));
            await loadStoryboard(currentStoryboard.id);
            renderScenesGrid();
          }
          return;
        }
      }

      // Timed out
      overlay.remove();
      alert('Convert to Video timed out. The workflow may still be running.');
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }

    } catch (err) {
      overlay.remove();
      alert('Error: ' + (err.message || err));
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
  }

  // ── Generate All Missing (via Pipeline) ─────────────────

  async function generateAllMissing() {
    if (!currentStoryboard) return;
    var scenes = currentStoryboard.scenes || [];
    var missing = scenes.filter(function (s) { return !s.imageOptions || s.imageOptions.length === 0; });
    if (missing.length === 0) return;

    var btn = document.getElementById('sb-generate-all-btn');
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
    }

    // Show pipeline progress overlay
    var progressEl = document.createElement('div');
    progressEl.id = 'sb-gen-progress';
    progressEl.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999;display:flex;align-items:center;justify-content:center;';
    progressEl.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(124,58,237,0.3);border-radius:12px;padding:28px 36px;text-align:center;min-width:380px;">'
      + '<div style="font-size:16px;font-weight:600;color:#e2e8f0;margin-bottom:6px;">Generating Images via Pipeline</div>'
      + '<div style="font-size:11px;color:#64748b;margin-bottom:16px;">scene-image-generator</div>'
      + '<div id="sb-gen-status" style="font-size:13px;color:#94a3b8;margin-bottom:16px;">Starting composition...</div>'
      + '<div style="background:rgba(0,0,0,0.3);border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px;">'
      + '<div id="sb-gen-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:99px;transition:width 0.3s;"></div>'
      + '</div>'
      + '<div id="sb-gen-count" style="font-size:11px;color:#64748b;">0 / ' + missing.length + ' scenes</div>'
      + '<div id="sb-gen-nodes" style="font-size:10px;color:#475569;margin-top:8px;"></div>'
      + '<button id="sb-gen-cancel" style="margin-top:16px;padding:6px 18px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:11px;">Cancel</button>'
      + '</div>';
    document.body.appendChild(progressEl);

    var cancelBtn = document.getElementById('sb-gen-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        try { await fetch('/api/compositions/run/cancel', { method: 'POST' }); } catch (e) { /* ok */ }
      });
    }

    // Trigger the scene-image-generator composition
    try {
      var r = await fetch('/api/compositions/scene-image-generator/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: { sb_id: currentStoryboard.id } }),
      });
      var data = await r.json();
      if (data.error) {
        alert('Failed to start pipeline: ' + data.error);
        var prog = document.getElementById('sb-gen-progress');
        if (prog) prog.remove();
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        return;
      }

      // Poll status
      await pollCompositionStatus('sb-gen-status', 'sb-gen-bar', 'sb-gen-count', 'sb-gen-nodes', missing.length);

    } catch (err) {
      alert('Error starting pipeline: ' + err.message);
    }

    // Cleanup overlay
    var prog = document.getElementById('sb-gen-progress');
    if (prog) prog.remove();

    // Reload storyboard and re-render
    await loadStoryboard(currentStoryboard.id);
    renderScenesGrid();
  }

  // ── Poll Composition Status ──────────────────────────────

  async function pollCompositionStatus(statusElId, barElId, countElId, nodesElId, expectedItems) {
    var pollInterval = 1500;
    var maxPolls = 300; // 7.5 minutes max
    var polls = 0;

    while (polls < maxPolls) {
      await new Promise(function (resolve) { setTimeout(resolve, pollInterval); });
      polls++;

      try {
        var r = await fetch('/api/compositions/run/status');
        var status = await r.json();

        var statusEl = document.getElementById(statusElId);
        var barEl = document.getElementById(barElId);
        var countEl = document.getElementById(countElId);
        var nodesEl = document.getElementById(nodesElId);

        if (!status.active && !status.done) {
          // No run active (shouldn't happen, but handle gracefully)
          if (statusEl) statusEl.textContent = 'No active pipeline run';
          break;
        }

        // Update progress from node states
        var nodesCompleted = status.nodesCompleted || 0;
        var nodesTotal = status.nodesTotal || 1;
        var pct = Math.round((nodesCompleted / nodesTotal) * 100);

        // If a ForEach is running, try to extract iteration progress
        var forEachProgress = '';
        if (status.nodeStates) {
          for (var nid in status.nodeStates) {
            var ns = status.nodeStates[nid];
            if (ns.workflowId === '__for_each__' && ns.status === 'running') {
              forEachProgress = ns.currentStep || '';
            }
          }
        }

        // Show current node
        var currentNode = '';
        if (status.currentNodeId && status.nodeStates && status.nodeStates[status.currentNodeId]) {
          currentNode = status.nodeStates[status.currentNodeId].workflowName || '';
        }

        if (statusEl) {
          if (forEachProgress) {
            statusEl.textContent = forEachProgress;
          } else if (currentNode) {
            statusEl.textContent = currentNode;
          } else {
            statusEl.textContent = 'Processing...';
          }
        }

        if (barEl) barEl.style.width = Math.min(pct, 95) + '%';
        if (countEl) countEl.textContent = nodesCompleted + ' / ' + nodesTotal + ' nodes';

        // Show per-node status
        if (nodesEl && status.nodeStates) {
          var nodeLines = [];
          var order = status.executionOrder || [];
          for (var oi = 0; oi < order.length; oi++) {
            var ns2 = status.nodeStates[order[oi]];
            if (!ns2) continue;
            var icon = ns2.status === 'completed' ? '&#x2705;' : ns2.status === 'running' ? '&#x23F3;' : ns2.status === 'failed' ? '&#x274C;' : '&#x23F8;&#xFE0F;';
            nodeLines.push(icon + ' ' + escHtml(ns2.workflowName || order[oi]));
          }
          nodesEl.innerHTML = nodeLines.join(' &middot; ');
        }

        if (status.done) {
          if (barEl) barEl.style.width = '100%';
          if (status.success) {
            if (statusEl) statusEl.textContent = 'Pipeline completed successfully!';
          } else {
            if (statusEl) statusEl.textContent = 'Pipeline failed: ' + (status.error || 'Unknown error');
            if (statusEl) statusEl.style.color = '#f87171';
          }
          // Brief pause so user can see final status
          await new Promise(function (resolve) { setTimeout(resolve, 1200); });
          break;
        }
      } catch (err) {
        console.error('Poll error:', err);
      }
    }
  }

  // ── Export & Assemble (via Pipeline) ─────────────────────

  async function exportAndAssemble() {
    if (!currentStoryboard) return;

    // Validate
    var scenes = currentStoryboard.scenes || [];
    var missingImages = scenes.filter(function (s) {
      return s.selectedImageIndex === null || s.selectedImageIndex === undefined || s.selectedImageIndex === -1 || !(s.imageOptions || [])[s.selectedImageIndex];
    });
    if (missingImages.length > 0) {
      alert('Please select an image for all scenes. ' + missingImages.length + ' scene(s) are missing images.');
      return;
    }

    var selectedAudio = (currentStoryboard.audioSelections || []).filter(function (a) { return a.selected !== false; });
    if (selectedAudio.length === 0) {
      alert('Please select at least one audio track.');
      return;
    }

    // Show composition picker dialog
    showAssemblyPicker(scenes.length, selectedAudio.length);
  }

  function showAssemblyPicker(numScenes, numAudio) {
    var overlay = document.createElement('div');
    overlay.id = 'sb-assemble-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(124,58,237,0.3);border-radius:16px;padding:32px 40px;text-align:center;min-width:420px;max-width:520px;">'
      + '<div style="font-size:2.5rem;margin-bottom:12px;">&#x1F3AC;</div>'
      + '<div style="font-size:18px;font-weight:600;color:#e2e8f0;margin-bottom:6px;">Assemble Video</div>'
      + '<div style="font-size:12px;color:#64748b;margin-bottom:20px;">'
      + numScenes + ' scenes &middot; ' + numAudio + ' audio track' + (numAudio !== 1 ? 's' : '')
      + '</div>'
      + '<div style="font-size:12px;color:#94a3b8;margin-bottom:12px;text-align:left;">Choose assembly pipeline:</div>'
      + '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">'
      + '<button id="sb-pick-ffmpeg" style="padding:14px 16px;border-radius:10px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);color:#e2e8f0;cursor:pointer;text-align:left;transition:border-color 0.15s;">'
      + '<div style="font-size:13px;font-weight:600;color:#4ade80;">FFmpeg Assembly</div>'
      + '<div style="font-size:11px;color:#64748b;margin-top:4px;">Fast concat of scene images + audio. Simple slideshow output.</div>'
      + '</button>'
      + '<button id="sb-pick-blender" style="padding:14px 16px;border-radius:10px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.25);color:#e2e8f0;cursor:pointer;text-align:left;transition:border-color 0.15s;">'
      + '<div style="font-size:13px;font-weight:600;color:#a78bfa;">Blender Automat Assembly</div>'
      + '<div style="font-size:11px;color:#64748b;margin-top:4px;">Full pipeline: LLM asset mapping, timeline building, Blender render.</div>'
      + '</button>'
      + '</div>'
      + '<button id="sb-pick-cancel" style="padding:6px 18px;border-radius:6px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Cancel</button>'
      + '</div>';
    document.body.appendChild(overlay);

    document.getElementById('sb-pick-cancel').addEventListener('click', function () { overlay.remove(); });
    document.getElementById('sb-pick-ffmpeg').addEventListener('click', function () {
      overlay.remove();
      runAssemblyPipeline('ffmpeg-video-assembly');
    });
    document.getElementById('sb-pick-blender').addEventListener('click', function () {
      overlay.remove();
      runAssemblyPipeline('video-assembly');
    });
  }

  async function runAssemblyPipeline(compositionId) {
    var scenes = currentStoryboard.scenes || [];
    var selectedAudio = (currentStoryboard.audioSelections || []).filter(function (a) { return a.selected !== false; });
    var isBlender = compositionId === 'video-assembly';

    // Show pipeline progress overlay
    var overlay = document.createElement('div');
    overlay.id = 'sb-assemble-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(124,58,237,0.3);border-radius:16px;padding:32px 40px;text-align:center;min-width:420px;max-width:520px;">'
      + '<div style="font-size:2.5rem;margin-bottom:12px;">&#x1F3AC;</div>'
      + '<div style="font-size:18px;font-weight:600;color:#e2e8f0;margin-bottom:6px;">Assembling Video</div>'
      + '<div style="font-size:11px;color:#64748b;margin-bottom:16px;">' + (isBlender ? 'Blender Automat Pipeline' : 'FFmpeg Assembly Pipeline') + '</div>'
      + '<div id="sb-asm-status" style="font-size:13px;color:#94a3b8;margin-bottom:16px;">Starting pipeline...</div>'
      + '<div style="background:rgba(0,0,0,0.3);border-radius:99px;height:8px;overflow:hidden;margin-bottom:12px;">'
      + '<div id="sb-asm-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:99px;transition:width 0.3s;"></div>'
      + '</div>'
      + '<div id="sb-asm-count" style="font-size:11px;color:#64748b;">' + scenes.length + ' scenes &middot; ' + selectedAudio.length + ' audio</div>'
      + '<div id="sb-asm-nodes" style="font-size:10px;color:#475569;margin-top:8px;"></div>'
      + '<button id="sb-asm-cancel" style="margin-top:16px;padding:6px 18px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:11px;">Cancel</button>'
      + '</div>';
    document.body.appendChild(overlay);

    var cancelBtn = document.getElementById('sb-asm-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        try { await fetch('/api/compositions/run/cancel', { method: 'POST' }); } catch (e) { /* ok */ }
      });
    }

    // Build variables based on composition type
    var variables = {};
    if (isBlender) {
      // Blender Automat expects asset_directory, collection_slug, and a production package
      variables.asset_directory = currentStoryboard.collectionRoot || '';
      variables.collection_slug = currentStoryboard.collectionSlug || '';
    } else {
      variables.sb_id = currentStoryboard.id;
    }

    try {
      var r = await fetch('/api/compositions/' + encodeURIComponent(compositionId) + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: variables }),
      });
      var data = await r.json();

      if (data.error) {
        showAssemblyError(overlay, data.error);
        return;
      }

      // Poll status
      await pollCompositionStatus('sb-asm-status', 'sb-asm-bar', 'sb-asm-count', 'sb-asm-nodes', scenes.length);

      // Check final status for video result
      var finalStatus = await fetch('/api/compositions/run/status').then(function (r) { return r.json(); });

      overlay.remove();

      if (finalStatus.success) {
        // Reload storyboard to get updated lastVideoPath
        await loadStoryboard(currentStoryboard.id);

        // Extract video info from pipeline outputs
        var outputs = finalStatus.pipelineOutputs || {};
        var videoResult = {
          videoPath: outputs.video_path || currentStoryboard.lastVideoPath || '',
          duration: outputs.duration || outputs.total_duration || 0,
          scenes: outputs.scenes || outputs.num_scenes || scenes.length,
          audioTracks: outputs.audio_tracks || outputs.num_audio || selectedAudio.length,
          fileSizeMB: outputs.file_size_mb || '?',
        };

        storyboardView = 'video';
        renderVideoResult(videoResult);
      } else {
        showAssemblyError(null, finalStatus.error || 'Pipeline failed');
      }

    } catch (err) {
      showAssemblyError(overlay, err.message || String(err));
    }
  }

  function showAssemblyError(overlay, errorMsg) {
    var errOverlay = overlay || document.getElementById('sb-assemble-overlay');
    if (!errOverlay) {
      errOverlay = document.createElement('div');
      errOverlay.id = 'sb-assemble-overlay';
      errOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:999;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(errOverlay);
    }
    errOverlay.innerHTML = '<div style="background:#1e293b;border:1px solid rgba(239,68,68,0.3);border-radius:16px;padding:32px 40px;text-align:center;min-width:380px;max-width:500px;">'
      + '<div style="font-size:2.5rem;margin-bottom:12px;">&#x274C;</div>'
      + '<div style="font-size:18px;font-weight:600;color:#f87171;margin-bottom:12px;">Assembly Failed</div>'
      + '<div style="font-size:12px;color:#94a3b8;margin-bottom:20px;max-height:150px;overflow-y:auto;text-align:left;background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;font-family:monospace;white-space:pre-wrap;">' + escHtml(errorMsg) + '</div>'
      + '<button id="sb-assemble-dismiss" style="padding:8px 24px;border-radius:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.1);color:#e2e8f0;cursor:pointer;font-size:13px;">Close</button>'
      + '</div>';
    document.getElementById('sb-assemble-dismiss').addEventListener('click', function () { errOverlay.remove(); });
  }

  // ── Video Result View ──────────────────────────────────────

  function renderVideoResult(result) {
    var main = document.getElementById('main');
    if (!main || !currentStoryboard) return;

    var videoUrl = '/api/storyboards/' + encodeURIComponent(currentStoryboard.id) + '/video';

    var html = '<div style="padding:24px;">';

    // Toolbar
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">';
    html += '<div style="display:flex;align-items:center;gap:12px;">';
    html += '<h2 style="margin:0;font-size:20px;font-weight:600;color:#e2e8f0;">' + escHtml(currentStoryboard.name) + '</h2>';
    html += '<span style="font-size:11px;padding:3px 10px;border-radius:99px;background:rgba(34,197,94,0.15);color:#4ade80;font-weight:500;">Assembled</span>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;">';
    html += '<button class="sb-subnav" data-view="scenes" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Scenes</button>';
    html += '<button class="sb-subnav" data-view="audio" style="padding:6px 14px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:12px;">Audio</button>';
    html += '<button class="sb-subnav active" data-view="video" style="padding:6px 14px;border-radius:6px;background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.3);color:#4ade80;cursor:pointer;font-size:12px;">Video</button>';
    html += '<button id="sb-assemble-btn" style="padding:6px 14px;border-radius:6px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;cursor:pointer;font-size:12px;font-weight:500;">Re-assemble</button>';
    html += '<button id="sb-video-save-col-btn" style="padding:6px 14px;border-radius:6px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.25);color:#60a5fa;cursor:pointer;font-size:12px;font-weight:500;">&#x1F4C1; Save to Collection</button>';
    html += '</div>';
    html += '</div>';

    // Video player
    html += '<div style="background:#0f172a;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);margin-bottom:20px;">';
    html += '<video id="sb-video-player" controls style="width:100%;max-height:500px;display:block;" preload="auto">';
    html += '<source src="' + videoUrl + '" type="video/mp4">';
    html += '</video>';
    html += '</div>';

    // Stats
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;">';
    var stats = [
      { label: 'Duration', value: (result.duration || 0) + 's' },
      { label: 'Scenes', value: String(result.scenes || 0) },
      { label: 'Audio Tracks', value: String(result.audioTracks || 0) },
      { label: 'File Size', value: (result.fileSizeMB || '?') + ' MB' },
    ];
    for (var si = 0; si < stats.length; si++) {
      html += '<div style="background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 20px;min-width:120px;">';
      html += '<div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600;margin-bottom:4px;">' + stats[si].label + '</div>';
      html += '<div style="font-size:20px;font-weight:600;color:#e2e8f0;">' + stats[si].value + '</div>';
      html += '</div>';
    }
    html += '</div>';

    // Collection badge (if saved to collection)
    if (currentStoryboard.outputCollectionSlug) {
      html += '<div style="margin-top:16px;display:flex;align-items:center;gap:8px;">';
      html += '<span style="font-size:12px;color:#64748b;">Collection:</span>';
      html += '<span style="font-size:12px;padding:3px 10px;border-radius:6px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.25);color:#60a5fa;">&#x1F4C1; ' + escHtml(currentStoryboard.outputCollectionSlug) + '</span>';
      html += '</div>';
    }

    // File path
    if (result.videoPath) {
      html += '<div style="margin-top:16px;padding:12px 16px;background:rgba(30,41,59,0.4);border-radius:8px;border:1px solid rgba(255,255,255,0.06);font-size:12px;color:#64748b;font-family:monospace;word-break:break-all;">' + escHtml(result.videoPath) + '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Wire sub-nav
    main.querySelectorAll('.sb-subnav').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.dataset.view;
        if (view === 'scenes') { storyboardView = 'scenes'; renderStoryboardMain(); }
        else if (view === 'audio') { storyboardView = 'audio'; renderStoryboardMain(); }
        else if (view === 'video') { /* already here */ }
      });
    });

    var assembleBtn = document.getElementById('sb-assemble-btn');
    if (assembleBtn) {
      assembleBtn.addEventListener('click', function () { exportAndAssemble(); });
    }

    var videoColBtn = document.getElementById('sb-video-save-col-btn');
    if (videoColBtn) {
      videoColBtn.addEventListener('click', async function () {
        await fetchCollections();
        var items = [{ type: 'assembled_video' }];
        showSaveToCollectionDialog(items, 'Save assembled video to collection');
      });
    }
  }

  // ── Export to global ───────────────────────────────────────

  window.initStoryboard = initStoryboard;
})();
