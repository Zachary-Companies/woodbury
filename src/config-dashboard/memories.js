// ── Memory Dashboard ─────────────────────────────────────────

(function () {
  'use strict';

  var memoryItems = [];
  var selectedMemoryId = null;
  var memoryScope = 'general';
  var memoryQuery = '';
  var memoryCategory = '';
  var memoryType = '';
  var memoryStats = null;

  function memoryEscHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function memoryEscAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatMemoryDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function buildMemoryParams() {
    var params = new URLSearchParams();
    params.set('scope', memoryScope);
    params.set('limit', '200');
    if (memoryQuery) params.set('query', memoryQuery);
    if (memoryScope === 'general' && memoryCategory) params.set('category', memoryCategory);
    if (memoryScope === 'closure' && memoryType) params.set('type', memoryType);
    return params;
  }

  async function fetchMemoryStats() {
    var res = await fetch('/api/memories/stats');
    if (!res.ok) throw new Error('Failed to load memory stats');
    var data = await res.json();
    memoryStats = data.stats || null;
  }

  async function fetchMemories() {
    var res = await fetch('/api/memories?' + buildMemoryParams().toString());
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Failed to load memories');
    }
    var data = await res.json();
    memoryItems = data.items || [];
    if (!selectedMemoryId || !memoryItems.some(function (item) { return item.id === selectedMemoryId; })) {
      selectedMemoryId = memoryItems.length ? memoryItems[0].id : null;
    }
    memoryStats = data.stats || memoryStats;
  }

  async function deleteMemory(id) {
    var res = await fetch('/api/memories/' + encodeURIComponent(id) + '?scope=' + encodeURIComponent(memoryScope), {
      method: 'DELETE'
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    return data;
  }

  async function reindexMemories() {
    var res = await fetch('/api/memories/reindex', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reindex failed');
    return data;
  }

  async function openMemoryFile(id, action) {
    var res = await fetch('/api/memories/' + encodeURIComponent(id) + '/' + action + '?scope=' + encodeURIComponent(memoryScope), {
      method: 'POST'
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Failed to ' + action + ' memory file'));
    return data;
  }

  function renderMemorySidebar() {
    var list = document.getElementById('memory-list');
    if (!list) return;

    var html = '';
    html += '<div class="memory-sidebar-toolbar">';
    html += '<input id="memory-search-input" class="memory-search-input" type="search" placeholder="Search memories semantically" value="' + memoryEscAttr(memoryQuery) + '">';
    html += '<div class="memory-sidebar-row">';
    html += '<select id="memory-scope-select" class="memory-select">';
    html += '<option value="general"' + (memoryScope === 'general' ? ' selected' : '') + '>General</option>';
    html += '<option value="closure"' + (memoryScope === 'closure' ? ' selected' : '') + '>Closure</option>';
    html += '</select>';

    if (memoryScope === 'general') {
      html += '<select id="memory-category-select" class="memory-select">';
      html += '<option value="">All categories</option>';
      ['convention','discovery','decision','gotcha','file_location','endpoint','web_procedure','web_task_notes'].forEach(function (category) {
        html += '<option value="' + category + '"' + (memoryCategory === category ? ' selected' : '') + '>' + category + '</option>';
      });
      html += '</select>';
    } else {
      html += '<select id="memory-type-select" class="memory-select">';
      html += '<option value="">All types</option>';
      ['episodic','semantic','procedural','failure','failure_pattern','preference'].forEach(function (type) {
        html += '<option value="' + type + '"' + (memoryType === type ? ' selected' : '') + '>' + type + '</option>';
      });
      html += '</select>';
    }
    html += '</div>';
    html += '<div class="memory-sidebar-row">';
    html += '<button id="memory-search-btn" class="memory-action-btn">Search</button>';
    html += '<button id="memory-reindex-btn" class="memory-action-btn memory-action-secondary">Reindex</button>';
    html += '</div>';
    html += '</div>';

    if (!memoryItems.length) {
      html += '<div class="memory-empty">No memories match this view.</div>';
      list.innerHTML = html;
      wireMemorySidebar();
      return;
    }

    memoryItems.forEach(function (item) {
      var active = item.id === selectedMemoryId ? ' active' : '';
      var label = memoryScope === 'general' ? item.category : item.type;
      var score = typeof item.score === 'number' ? Math.round(item.score * 100) : null;
      html += '<div class="memory-item' + active + '" data-memory-id="' + memoryEscAttr(item.id) + '">';
      html += '<div class="memory-item-title">' + memoryEscHtml((item.title || item.content || '').slice(0, 72)) + '</div>';
      html += '<div class="memory-item-meta">' + memoryEscHtml(label) + ' · ' + memoryEscHtml(formatMemoryDate(item.updatedAt || item.createdAt)) + '</div>';
      if (score !== null && memoryQuery) {
        html += '<div class="memory-item-score">match ' + score + '%</div>';
      }
      html += '</div>';
    });

    list.innerHTML = html;
    wireMemorySidebar();
  }

  function renderMemoryDetail() {
    var main = document.getElementById('main');
    if (!main) return;

    if (!memoryItems.length || !selectedMemoryId) {
      main.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-icon">&#x1f9e0;</div>' +
        '<h2>Memory</h2>' +
        '<p>Browse durable memories, search the semantic index, and delete stale knowledge.</p>' +
        '</div>';
      return;
    }

    var selected = memoryItems.find(function (item) { return item.id === selectedMemoryId; });
    if (!selected) {
      selected = memoryItems[0];
      selectedMemoryId = selected ? selected.id : null;
    }
    if (!selected) return;

    var statsHtml = '';
    if (memoryStats) {
      statsHtml += '<div class="memory-stats-grid">';
      statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + memoryStats.general.total + '</div><div class="memory-stat-label">General</div></div>';
      statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + memoryStats.closure.total + '</div><div class="memory-stat-label">Closure</div></div>';
      statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + memoryEscHtml(memoryStats.indexing.provider) + '</div><div class="memory-stat-label">Indexer</div></div>';
      statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + memoryStats.indexing.dimensions + '</div><div class="memory-stat-label">Dimensions</div></div>';
      statsHtml += '</div>';
    }

    var tagsHtml = (selected.tags || []).map(function (tag) {
      return '<span class="memory-chip">' + memoryEscHtml(tag) + '</span>';
    }).join('');
    var revealLabel = (window.woodburyElectron && window.woodburyElectron.platform === 'win32') ? 'Show in Explorer' : 'Show in Finder';
    var fileActionsHtml = selected.markdownPath
      ? '<div class="memory-detail-actions">' +
          '<button id="memory-open-file-btn" class="memory-action-btn">Open Markdown</button>' +
          '<button id="memory-reveal-file-btn" class="memory-action-btn memory-action-secondary">' + revealLabel + '</button>' +
        '</div>'
      : '';
    var filePathsHtml = selected.markdownPath
      ? '<div class="memory-file-panel">' +
          '<div class="memory-file-row"><strong>Markdown File</strong><div class="memory-file-path">' + memoryEscHtml(selected.markdownPath) + '</div></div>' +
          (selected.metadataPath ? '<div class="memory-file-row"><strong>Metadata File</strong><div class="memory-file-path">' + memoryEscHtml(selected.metadataPath) + '</div></div>' : '') +
          (selected.directoryPath ? '<div class="memory-file-row"><strong>Directory</strong><div class="memory-file-path">' + memoryEscHtml(selected.directoryPath) + '</div></div>' : '') +
        '</div>'
      : '';

    main.innerHTML =
      '<div class="ext-header">' +
      '<h2>Memory Browser</h2>' +
      '<div class="ext-header-meta">Semantic search over memory stored as Markdown and JSON files.</div>' +
      '</div>' +
      statsHtml +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-head">' +
      '<div>' +
      '<div class="memory-detail-title">' + memoryEscHtml(selected.title || selected.category || selected.type || 'Memory') + '</div>' +
      '<div class="memory-detail-meta">ID ' + memoryEscHtml(selected.id) + ' · ' + memoryEscHtml(selected.category || selected.type || '') + ' · updated ' + memoryEscHtml(formatMemoryDate(selected.updatedAt || selected.createdAt)) + '</div>' +
      '</div>' +
      '<button id="memory-delete-btn" class="memory-delete-btn">Delete</button>' +
      '</div>' +
      '<div class="memory-detail-body">' + memoryEscHtml(selected.content) + '</div>' +
      (tagsHtml ? '<div class="memory-chip-row">' + tagsHtml + '</div>' : '') +
      fileActionsHtml +
      filePathsHtml +
      '<div class="memory-detail-grid">' +
      '<div><strong>Source</strong><div>' + memoryEscHtml(selected.source || 'manual') + '</div></div>' +
      '<div><strong>Importance</strong><div>' + (typeof selected.importance === 'number' ? selected.importance.toFixed(2) : (typeof selected.confidence === 'number' ? selected.confidence.toFixed(2) : '')) + '</div></div>' +
      '<div><strong>Recall Count</strong><div>' + memoryEscHtml(String(selected.recallCount || selected.accessCount || 0)) + '</div></div>' +
      '<div><strong>Semantic Match</strong><div>' + (typeof selected.semanticScore === 'number' ? Math.round(selected.semanticScore * 100) + '%' : 'n/a') + '</div></div>' +
      '</div>' +
      ((selected.site || selected.project) ? '<div class="memory-detail-grid">' +
        (selected.site ? '<div><strong>Site</strong><div>' + memoryEscHtml(selected.site) + '</div></div>' : '') +
        (selected.project ? '<div><strong>Project</strong><div>' + memoryEscHtml(selected.project) + '</div></div>' : '') +
      '</div>' : '') +
      '</div>';

    var deleteBtn = document.getElementById('memory-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async function () {
        if (!confirm('Delete this memory?')) return;
        try {
          await deleteMemory(selected.id);
          toast('Memory deleted', 'success');
          await refreshMemories();
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        }
      });
    }

    var openBtn = document.getElementById('memory-open-file-btn');
    if (openBtn) {
      openBtn.addEventListener('click', async function () {
        try {
          await openMemoryFile(selected.id, 'open');
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        }
      });
    }

    var revealBtn = document.getElementById('memory-reveal-file-btn');
    if (revealBtn) {
      revealBtn.addEventListener('click', async function () {
        try {
          await openMemoryFile(selected.id, 'reveal');
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        }
      });
    }
  }

  function wireMemorySidebar() {
    var searchInput = document.getElementById('memory-search-input');
    if (searchInput) {
      searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          memoryQuery = searchInput.value.trim();
          refreshMemories();
        }
      });
    }

    var searchBtn = document.getElementById('memory-search-btn');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        var input = document.getElementById('memory-search-input');
        memoryQuery = input ? input.value.trim() : '';
        refreshMemories();
      });
    }

    var scopeSelect = document.getElementById('memory-scope-select');
    if (scopeSelect) {
      scopeSelect.addEventListener('change', function () {
        memoryScope = scopeSelect.value;
        memoryCategory = '';
        memoryType = '';
        refreshMemories();
      });
    }

    var categorySelect = document.getElementById('memory-category-select');
    if (categorySelect) {
      categorySelect.addEventListener('change', function () {
        memoryCategory = categorySelect.value;
        refreshMemories();
      });
    }

    var typeSelect = document.getElementById('memory-type-select');
    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        memoryType = typeSelect.value;
        refreshMemories();
      });
    }

    var reindexBtn = document.getElementById('memory-reindex-btn');
    if (reindexBtn) {
      reindexBtn.addEventListener('click', async function () {
        reindexBtn.disabled = true;
        try {
          await reindexMemories();
          toast('Memory index rebuilt', 'success');
          await refreshMemories();
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        } finally {
          reindexBtn.disabled = false;
        }
      });
    }

    document.querySelectorAll('.memory-item').forEach(function (itemEl) {
      itemEl.addEventListener('click', function () {
        selectedMemoryId = itemEl.dataset.memoryId;
        renderMemorySidebar();
        renderMemoryDetail();
      });
    });
  }

  async function refreshMemories() {
    try {
      await Promise.all([fetchMemoryStats(), fetchMemories()]);
      renderMemorySidebar();
      renderMemoryDetail();
    } catch (err) {
      var main = document.getElementById('main');
      if (main) {
        main.innerHTML =
          '<div class="empty-state">' +
          '<div class="empty-state-icon">&#x26a0;</div>' +
          '<h2>Memory Error</h2>' +
          '<p>' + memoryEscHtml(err.message) + '</p>' +
          '</div>';
      }
      var list = document.getElementById('memory-list');
      if (list) {
        list.innerHTML = '<div class="memory-empty" style="color:#ef4444;">' + memoryEscHtml(err.message) + '</div>';
      }
    }
  }

  function initMemories() {
    var main = document.getElementById('main');
    if (!main) return;
    main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading memories...</div>';
    refreshMemories();
  }

  window.initMemories = initMemories;
})();
