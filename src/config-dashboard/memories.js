// ── Memory Dashboard ─────────────────────────────────────────

(function () {
  'use strict';

  var memoryItems = [];
  var selectedMemoryId = null;
  var memoryQuery = '';
  var memoryCategory = '';
  var memoryStats = null;

  // Categories from file-memory-store
  var CATEGORIES = [
    'convention', 'discovery', 'decision', 'gotcha',
    'procedure', 'preference', 'endpoint', 'error_pattern', 'general'
  ];

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
    params.set('limit', '200');
    if (memoryQuery) params.set('query', memoryQuery);
    if (memoryCategory) params.set('category', memoryCategory);
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
    var res = await fetch('/api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    return data;
  }

  async function consolidateMemories() {
    var res = await fetch('/api/memories/consolidate', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Consolidation failed');
    return data;
  }

  function categoryIcon(cat) {
    switch (cat) {
      case 'gotcha': return '⚠️';
      case 'error_pattern': return '🔴';
      case 'procedure': return '📋';
      case 'preference': return '👤';
      case 'decision': return '🏗️';
      case 'convention': return '📏';
      case 'discovery': return '🔍';
      case 'endpoint': return '🔗';
      default: return '💡';
    }
  }

  function renderMemorySidebar() {
    var list = document.getElementById('memory-list');
    if (!list) return;

    var html = '';
    html += '<div class="memory-sidebar-toolbar">';
    html += '<input id="memory-search-input" class="memory-search-input" type="search" placeholder="Search memories..." value="' + memoryEscAttr(memoryQuery) + '">';
    html += '<div class="memory-sidebar-row">';
    html += '<select id="memory-category-select" class="memory-select">';
    html += '<option value="">All categories</option>';
    CATEGORIES.forEach(function (category) {
      html += '<option value="' + category + '"' + (memoryCategory === category ? ' selected' : '') + '>' + categoryIcon(category) + ' ' + category + '</option>';
    });
    html += '</select>';
    html += '</div>';
    html += '<div class="memory-sidebar-row">';
    html += '<button id="memory-search-btn" class="memory-action-btn">Search</button>';
    html += '<button id="memory-consolidate-btn" class="memory-action-btn memory-action-secondary">Consolidate</button>';
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
      html += '<div class="memory-item' + active + '" data-memory-id="' + memoryEscAttr(item.id) + '">';
      html += '<div class="memory-item-title">' + categoryIcon(item.category) + ' ' + memoryEscHtml((item.content || '').slice(0, 72)) + '</div>';
      html += '<div class="memory-item-meta">' + memoryEscHtml(item.category) + ' · ' + memoryEscHtml(formatMemoryDate(item.updatedAt || item.createdAt)) + '</div>';
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
        '<p>Browse durable memories stored as JSON files. Memories are auto-created from chat interactions and decay over time based on usage.</p>' +
        '</div>';
      return;
    }

    var selected = memoryItems.find(function (item) { return item.id === selectedMemoryId; });
    if (!selected) {
      selected = memoryItems[0];
      selectedMemoryId = selected ? selected.id : null;
    }
    if (!selected) return;

    // Stats summary
    var statsHtml = '';
    if (memoryStats) {
      statsHtml += '<div class="memory-stats-grid">';
      statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + (memoryStats.total || 0) + '</div><div class="memory-stat-label">Total</div></div>';
      // Show top categories
      var topCats = CATEGORIES.filter(function (c) { return memoryStats[c] > 0; }).slice(0, 3);
      topCats.forEach(function (cat) {
        statsHtml += '<div class="memory-stat-card"><div class="memory-stat-value">' + memoryStats[cat] + '</div><div class="memory-stat-label">' + categoryIcon(cat) + ' ' + cat + '</div></div>';
      });
      statsHtml += '</div>';
    }

    var tagsHtml = (selected.tags || []).map(function (tag) {
      return '<span class="memory-chip">' + memoryEscHtml(tag) + '</span>';
    }).join('');

    var importanceBar = '';
    if (typeof selected.importance === 'number') {
      var pct = Math.round(selected.importance * 100);
      var barColor = selected.importance > 0.7 ? '#10b981' : selected.importance > 0.4 ? '#f59e0b' : '#6b7280';
      importanceBar = '<div style="margin-top:0.5rem;"><div style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div style="flex:1;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">' +
        '<div style="width:' + pct + '%;height:100%;background:' + barColor + ';border-radius:3px;"></div>' +
        '</div><span style="font-size:0.75rem;color:rgba(255,255,255,0.5);">' + pct + '%</span></div></div>';
    }

    main.innerHTML =
      '<div class="ext-header">' +
      '<h2>Memory Browser</h2>' +
      '<div class="ext-header-meta">Memories auto-created from chat interactions. Importance decays over time; frequently recalled memories persist.</div>' +
      '</div>' +
      statsHtml +
      '<div class="memory-detail-card">' +
      '<div class="memory-detail-head">' +
      '<div>' +
      '<div class="memory-detail-title">' + categoryIcon(selected.category) + ' ' + memoryEscHtml(selected.category) + '</div>' +
      '<div class="memory-detail-meta">ID ' + memoryEscHtml(selected.id) +
        ' · source: ' + memoryEscHtml(selected.source || 'chat') +
        (selected.project ? ' · project: ' + memoryEscHtml(selected.project) : '') +
        ' · updated ' + memoryEscHtml(formatMemoryDate(selected.updatedAt || selected.createdAt)) +
      '</div>' +
      '</div>' +
      '<button id="memory-delete-btn" class="memory-delete-btn">Delete</button>' +
      '</div>' +
      '<div class="memory-detail-body">' + memoryEscHtml(selected.content) + '</div>' +
      (tagsHtml ? '<div class="memory-chip-row">' + tagsHtml + '</div>' : '') +
      '<div class="memory-detail-grid">' +
      '<div><strong>Importance</strong>' + importanceBar + '</div>' +
      '<div><strong>Recall Count</strong><div>' + (selected.recallCount || 0) + '</div></div>' +
      '<div><strong>Last Recalled</strong><div>' + memoryEscHtml(selected.lastRecalledAt ? formatMemoryDate(selected.lastRecalledAt) : 'Never') + '</div></div>' +
      '<div><strong>Created</strong><div>' + memoryEscHtml(formatMemoryDate(selected.createdAt)) + '</div></div>' +
      '</div>' +
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

    var categorySelect = document.getElementById('memory-category-select');
    if (categorySelect) {
      categorySelect.addEventListener('change', function () {
        memoryCategory = categorySelect.value;
        refreshMemories();
      });
    }

    var consolidateBtn = document.getElementById('memory-consolidate-btn');
    if (consolidateBtn) {
      consolidateBtn.addEventListener('click', async function () {
        consolidateBtn.disabled = true;
        consolidateBtn.textContent = 'Working...';
        try {
          var result = await consolidateMemories();
          var msg = 'Consolidated: ' + result.consolidated + ' merged, ' + result.decayed + ' decayed, ' + result.pruned + ' pruned';
          toast(msg, 'success');
          await refreshMemories();
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        } finally {
          consolidateBtn.disabled = false;
          consolidateBtn.textContent = 'Consolidate';
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
