/**
 * Social Scheduler Dashboard -- Core
 *
 * Contains:
 *   - State variables (socialPosts, socialFilter, socialView, etc.)
 *   - Helpers (socialEsc, socialFormatDate/Time, socialStatusDot, socialPlatformBadge, socialGetCharLimit, socialInitComposeData)
 *   - API functions (socialFetchPosts, socialFetchStats, socialFetchConfig, socialSaveConfig, etc.)
 *   - Init (initSocial)
 *   - View Router (socialRenderCurrentView)
 *   - Sidebar (socialRenderSidebar, socialFilterBtn, socialFilterPill, socialRefresh)
 *   - Overview (socialRenderOverview, socialStatCard)
 *   - Detail view (socialRenderDetail, socialPlatformCheckboxes, socialPlatformToggles)
 *   - Calendar (socialRenderCalendar)
 *   - Queue (socialRenderQueue)
 *   - Templates placeholder (socialRenderTemplates)
 *   - Hashtags placeholder (socialRenderHashtags)
 *
 * Loaded BEFORE social-compose.js (compose, settings, platform editor depend on core).
 * All functions are globals shared across files via <script> tags.
 */

// -- State --------------------------------------------------------
var socialPosts = [];
var socialSelectedPost = null;
var socialFilter = 'all'; // all | draft | scheduled | posting | posted | failed
var socialStats = null;
var socialConfig = null;
var socialScripts = null;
var socialView = 'overview'; // overview | compose | detail | calendar | queue | templates | hashtags | settings
var socialCalendarMonth = new Date();
var socialTemplates = [];
var socialHashtagGroups = [];
var socialLabels = [];
var socialComposeData = null; // working state for compose view
var socialEditingPostId = null; // non-null when editing existing post
var socialComposeTab = 'all'; // 'all' | 'instagram' | 'twitter' | 'youtube'
var socialAssetPickerOpen = false;
var socialAssetCache = null;
var socialPlatforms = []; // Loaded from GET /api/social/platforms
var socialQueueSearch = '';
var socialQueuePlatformFilter = 'all';

// -- Helpers ------------------------------------------------------

function socialEsc(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function socialFormatDate(iso) {
  if (!iso) return '\u2014';
  var d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function socialFormatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function socialFormatDateTime(iso) {
  if (!iso) return '\u2014';
  return socialFormatDate(iso) + ' ' + socialFormatTime(iso);
}

function socialStatusDot(status) {
  var colors = {
    draft: '#64748b',
    scheduled: '#3b82f6',
    posting: '#f59e0b',
    posted: '#22c55e',
    partial: '#f97316',
    failed: '#ef4444',
  };
  return '<span class="social-status-dot" style="background:' + (colors[status] || '#64748b') + ';" title="' + status + '"></span>';
}

function socialPlatformBadge(platform, small) {
  var connector = socialPlatforms.find(function (c) { return c.platform === platform; });
  var icon = (connector && connector.icon) || { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' }[platform] || '\ud83c\udf10';
  var displayName = (connector && connector.displayName) || platform;
  var cls = small ? 'social-platform-badge social-platform-badge-sm' : 'social-platform-badge';
  return '<span class="' + cls + '" data-platform="' + platform + '">' + icon + ' ' + displayName + '</span>';
}

function socialGetCharLimit(platform) {
  // Check connector first
  var connector = socialPlatforms.find(function (c) { return c.platform === platform; });
  if (connector && connector.maxTextLength) return connector.maxTextLength;
  // Fall back to script metadata
  if (!socialScripts) return 0;
  var script = socialScripts.find(function (s) { return s.platform === platform; });
  if (!script) return 0;
  return script.maxCaptionLength || script.maxTextLength || script.maxDescriptionLength || 0;
}

function socialInitComposeData(post) {
  var allPlatforms = socialPlatforms.map(function (c) { return c.platform; });
  if (allPlatforms.length === 0) allPlatforms = ['instagram', 'twitter', 'youtube']; // fallback
  if (post) {
    var enabledMap = {};
    (post.platforms || []).forEach(function (p) { if (p.enabled) enabledMap[p.platform] = true; });
    var overrides = {};
    if (post.content && post.content.platformOverrides) {
      for (var k in post.content.platformOverrides) {
        overrides[k] = post.content.platformOverrides[k].text || '';
      }
    }
    return {
      text: (post.content && post.content.text) || '',
      platformOverrides: overrides,
      platforms: allPlatforms.map(function (p) { return { platform: p, enabled: !!enabledMap[p] }; }),
      images: (post.content && post.content.images) || [],
      tags: (post.tags || []).slice(),
      scheduledAt: post.scheduledAt || null,
      scheduleMode: post.scheduledAt ? 'schedule' : 'draft',
    };
  }
  // Default for new post
  var defPlats = (socialConfig && socialConfig.defaultPlatforms) || [];
  return {
    text: '',
    platformOverrides: {},
    platforms: allPlatforms.map(function (p) { return { platform: p, enabled: defPlats.indexOf(p) !== -1 }; }),
    images: [],
    tags: [],
    scheduledAt: null,
    scheduleMode: 'draft',
  };
}

// -- API ----------------------------------------------------------

async function socialFetchPosts(filters) {
  var qs = '';
  if (filters) {
    var parts = [];
    for (var k in filters) {
      if (filters[k]) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(filters[k]));
    }
    if (parts.length) qs = '?' + parts.join('&');
  }
  var res = await fetch('/api/social/posts' + qs);
  return res.json();
}

async function socialFetchStats() {
  var res = await fetch('/api/social/stats');
  return res.json();
}

async function socialFetchToday() {
  var res = await fetch('/api/social/today');
  return res.json();
}

async function socialFetchConfig() {
  var res = await fetch('/api/social/config');
  return res.json();
}

async function socialSaveConfig(data) {
  var res = await fetch('/api/social/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function socialFetchScripts() {
  var res = await fetch('/api/social/scripts');
  return res.json();
}

async function socialFetchPlatforms() {
  var res = await fetch('/api/social/platforms');
  if (!res.ok) throw new Error('Failed to fetch platforms');
  return res.json();
}

async function socialCreatePost(data) {
  var res = await fetch('/api/social/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function socialUpdatePost(id, data) {
  var res = await fetch('/api/social/posts/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function socialDeletePost(id) {
  var res = await fetch('/api/social/posts/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
  return res.json();
}

async function socialFetchAssets() {
  var res = await fetch('/api/assets?category=image');
  return res.json();
}

// -- Init ---------------------------------------------------------

async function initSocial() {
  var main = document.querySelector('#main');
  var sidebar = document.querySelector('#social-list');

  // Show loading in main
  main.innerHTML =
    '<div class="empty-state">' +
    '<div class="empty-state-icon">\ud83d\udcc5</div>' +
    '<h2>Loading Social Scheduler...</h2>' +
    '</div>';

  try {
    // Fetch data in parallel
    var results = await Promise.all([
      socialFetchPosts(socialFilter !== 'all' ? { status: socialFilter } : {}),
      socialFetchStats(),
      socialFetchScripts(),
      socialFetchPlatforms(),
    ]);
    socialPosts = results[0];
    socialStats = results[1];
    socialScripts = results[2];
    socialPlatforms = results[3] || [];

    // Also try to load config for default platform settings
    try { socialConfig = await socialFetchConfig(); } catch (e) { /* ignore */ }

    socialRenderSidebar();
    socialRenderCurrentView();
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon">\u26a0\ufe0f</div>' +
      '<h2>Failed to load social scheduler</h2>' +
      '<p>' + socialEsc(String(err)) + '</p>' +
      '</div>';
  }
}

// -- View Router --------------------------------------------------

function socialRenderCurrentView() {
  if (socialView === 'compose')        socialRenderCompose();
  else if (socialView === 'detail')    socialRenderDetail();
  else if (socialView === 'calendar')  socialRenderCalendar();
  else if (socialView === 'queue')     socialRenderQueue();
  else if (socialView === 'templates') socialRenderTemplates();
  else if (socialView === 'hashtags')  socialRenderHashtags();
  else if (socialView === 'settings')  socialRenderSettings();
  else                                 socialRenderOverview();
}

// -- Sidebar ------------------------------------------------------

function socialRenderSidebar() {
  var sidebar = document.querySelector('#social-list');
  if (!sidebar) return;

  // Stats mini-counts
  var counts = socialStats || {};

  var html =
    '<div class="ss-sidebar">' +

    // -- New Post button --
    '<button class="ss-new-btn" id="social-new-post-btn">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<span>New Post</span>' +
    '</button>' +

    // -- Filter pills --
    '<div class="ss-filters">' +
    socialFilterPill('all', 'All', counts.total) +
    socialFilterPill('draft', 'Drafts', counts.draft) +
    socialFilterPill('scheduled', 'Scheduled', counts.scheduled) +
    socialFilterPill('posted', 'Posted', counts.posted) +
    socialFilterPill('failed', 'Failed', counts.failed) +
    '</div>' +

    // -- View switcher --
    '<div class="ss-view-switch">' +
    '<button class="ss-view-btn' + (socialView === 'overview' || socialView === 'detail' || socialView === 'compose' ? ' active' : '') + '" data-social-view="overview">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>' +
    'Overview</button>' +
    '<button class="ss-view-btn' + (socialView === 'calendar' ? ' active' : '') + '" data-social-view="calendar">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    'Calendar</button>' +
    '<button class="ss-view-btn' + (socialView === 'queue' ? ' active' : '') + '" data-social-view="queue">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    'Queue</button>' +
    '<button class="ss-view-btn' + (socialView === 'templates' ? ' active' : '') + '" data-social-view="templates">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 5h6M5 8h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    '</button>' +
    '<button class="ss-view-btn' + (socialView === 'hashtags' ? ' active' : '') + '" data-social-view="hashtags">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 1v14M12 1v14M1 5h14M1 11h14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    '</button>' +
    '<button class="ss-view-btn' + (socialView === 'settings' ? ' active' : '') + '" id="social-settings-btn">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.9 1.7l-.2 1.2c-.5.2-.9.5-1.3.8l-1.1-.4-1.1 1.9 1 .8c-.1.3-.1.5-.1.8s0 .5.1.8l-1 .8 1.1 1.9 1.1-.4c.4.3.8.6 1.3.8l.2 1.2h2.2l.2-1.2c.5-.2.9-.5 1.3-.8l1.1.4 1.1-1.9-1-.8c.1-.3.1-.5.1-.8s0-.5-.1-.8l1-.8-1.1-1.9-1.1.4c-.4-.3-.8-.6-1.3-.8l-.2-1.2H6.9z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '</button>' +
    '</div>' +

    // -- Divider --
    '<div class="ss-divider"></div>' +

    // -- Post list header --
    '<div class="ss-list-header">' +
    '<span>Posts</span>' +
    '<span class="ss-list-count">' + socialPosts.length + '</span>' +
    '</div>';

  // -- Post items --
  if (socialPosts.length === 0) {
    html += '<div class="ss-empty">' +
      '<div class="ss-empty-icon">\ud83d\udcdd</div>' +
      '<div>No posts' + (socialFilter !== 'all' ? ' with "' + socialFilter + '" status' : ' yet') + '</div>' +
      '</div>';
  } else {
    html += '<div class="ss-post-list">';
    socialPosts.forEach(function (post) {
      var isSelected = socialSelectedPost && socialSelectedPost.id === post.id;
      var preview = (post.content.text || '').slice(0, 55) || '(no text)';
      var platforms = post.platforms.filter(function (p) { return p.enabled; });
      var defaultPlatIcons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };
      var platStr = platforms.map(function (p) {
        var conn = socialPlatforms.find(function (c) { return c.platform === p.platform; });
        return (conn && conn.icon) || defaultPlatIcons[p.platform] || '\ud83c\udf10';
      }).join(' ');
      var time = post.scheduledAt ? socialFormatDateTime(post.scheduledAt) : 'Draft';
      var statusColors = {
        draft: '#64748b', scheduled: '#3b82f6', posting: '#f59e0b',
        posted: '#22c55e', partial: '#f97316', failed: '#ef4444',
      };
      var sColor = statusColors[post.status] || '#64748b';

      html += '<div class="ss-post-item' + (isSelected ? ' active' : '') + '" data-social-post="' + post.id + '">' +
        '<div class="ss-post-top">' +
        '<span class="ss-post-dot" style="background:' + sColor + ';"></span>' +
        '<span class="ss-post-preview">' + socialEsc(preview) + '</span>' +
        '</div>' +
        '<div class="ss-post-bottom">' +
        '<span class="ss-post-platforms">' + platStr + '</span>' +
        '<span class="ss-post-time">' + socialEsc(time) + '</span>' +
        '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  sidebar.innerHTML = html;

  // Wire events
  sidebar.querySelector('#social-new-post-btn').addEventListener('click', function () {
    socialEditingPostId = null;
    socialComposeData = socialInitComposeData(null);
    socialComposeTab = 'all';
    socialAssetPickerOpen = false;
    socialView = 'compose';
    socialSelectedPost = null;
    socialRenderCompose();
    socialRenderSidebar();
  });

  sidebar.querySelectorAll('.ss-filter-pill').forEach(function (btn) {
    btn.addEventListener('click', function () {
      socialFilter = btn.dataset.socialFilter;
      socialRefresh();
    });
  });

  sidebar.querySelectorAll('.ss-view-btn[data-social-view]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      socialView = btn.dataset.socialView;
      socialSelectedPost = null;
      socialRenderCurrentView();
      socialRenderSidebar();
    });
  });

  var settingsBtn = sidebar.querySelector('#social-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', function () {
      socialView = 'settings';
      socialSelectedPost = null;
      socialRenderCurrentView();
      socialRenderSidebar();
    });
  }

  sidebar.querySelectorAll('[data-social-post]').forEach(function (item) {
    item.addEventListener('click', function () {
      var id = item.dataset.socialPost;
      socialSelectedPost = socialPosts.find(function (p) { return p.id === id; }) || null;
      socialView = 'detail';
      socialRenderDetail();
      socialRenderSidebar();
    });
  });
}

function socialFilterBtn(value, label) {
  var active = socialFilter === value ? ' active' : '';
  return '<button class="social-filter-btn' + active + '" data-social-filter="' + value + '">' + label + '</button>';
}

function socialFilterPill(value, label, count) {
  var active = socialFilter === value ? ' active' : '';
  var c = (typeof count === 'number') ? count : 0;
  return '<button class="ss-filter-pill' + active + '" data-social-filter="' + value + '">' +
    '<span class="ss-filter-label">' + label + '</span>' +
    '<span class="ss-filter-count">' + c + '</span>' +
    '</button>';
}

async function socialRefresh() {
  try {
    var results = await Promise.all([
      socialFetchPosts(socialFilter !== 'all' ? { status: socialFilter } : {}),
      socialFetchStats(),
    ]);
    socialPosts = results[0];
    socialStats = results[1];
    socialRenderSidebar();
  } catch (err) {
    if (typeof toast === 'function') toast('Failed to refresh: ' + err, 'error');
  }
}

// -- Overview -----------------------------------------------------

function socialRenderOverview() {
  var main = document.querySelector('#main');
  if (!socialStats) {
    main.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    return;
  }

  var stats = socialStats;
  var html =
    '<div style="padding:1.5rem;">' +
    '<h2 style="color:#fff;font-size:1.25rem;margin-bottom:1rem;">\ud83d\udcc5 Social Scheduler</h2>' +

    // Stats cards
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.75rem;margin-bottom:1.5rem;">' +
    socialStatCard('Draft', stats.draft, '#64748b') +
    socialStatCard('Scheduled', stats.scheduled, '#3b82f6') +
    socialStatCard('Posting', stats.posting, '#f59e0b') +
    socialStatCard('Posted', stats.posted, '#22c55e') +
    socialStatCard('Failed', stats.failed, '#ef4444') +
    socialStatCard('Total', stats.total, '#7c3aed') +
    '</div>';

  // Today's posts
  html += '<h3 style="color:#e2e8f0;font-size:1rem;margin-bottom:0.75rem;">Today\'s Posts</h3>';

  var todayPosts = socialPosts.filter(function (p) {
    if (!p.scheduledAt) return false;
    var d = new Date(p.scheduledAt);
    var today = new Date();
    return d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
  });

  if (todayPosts.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.85rem;border:1px solid #1e293b;border-radius:8px;text-align:center;">' +
      'No posts scheduled for today.' +
      '</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:0.5rem;">';
    todayPosts.forEach(function (post) {
      var platforms = post.platforms.filter(function (p) { return p.enabled; })
        .map(function (p) { return socialPlatformBadge(p.platform, true); }).join(' ');
      html += '<div class="social-today-item" data-social-today="' + post.id + '">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        socialStatusDot(post.status) +
        '<span style="color:#e2e8f0;font-size:0.85rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        socialEsc((post.content.text || '').slice(0, 80) || '(no text)') + '</span>' +
        '<span style="color:#94a3b8;font-size:0.75rem;">' + socialFormatTime(post.scheduledAt) + '</span>' +
        '</div>' +
        '<div style="margin-top:4px;">' + platforms + '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  // Recent posts
  html += '<h3 style="color:#e2e8f0;font-size:1rem;margin:1.5rem 0 0.75rem;">Recent Posts</h3>';
  var recent = socialPosts.slice(0, 5);
  if (recent.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.85rem;text-align:center;">No posts yet. Create your first post!</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:0.5rem;">';
    recent.forEach(function (post) {
      var platforms = post.platforms.filter(function (p) { return p.enabled; })
        .map(function (p) { return socialPlatformBadge(p.platform, true); }).join(' ');
      html += '<div class="social-today-item" data-social-today="' + post.id + '">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        socialStatusDot(post.status) +
        '<span style="color:#e2e8f0;font-size:0.85rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        socialEsc((post.content.text || '').slice(0, 80) || '(no text)') + '</span>' +
        '<span style="color:#94a3b8;font-size:0.75rem;">' + socialFormatDateTime(post.scheduledAt) + '</span>' +
        '</div>' +
        '<div style="margin-top:4px;">' + platforms + '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  main.innerHTML = html;

  // Wire today/recent post clicks
  main.querySelectorAll('[data-social-today]').forEach(function (el) {
    el.addEventListener('click', function () {
      var id = el.dataset.socialToday;
      socialSelectedPost = socialPosts.find(function (p) { return p.id === id; }) || null;
      if (socialSelectedPost) {
        socialView = 'detail';
        socialRenderDetail();
        socialRenderSidebar();
      }
    });
  });
}

function socialStatCard(label, value, color) {
  return '<div class="social-stat-card">' +
    '<div style="font-size:1.5rem;font-weight:700;color:' + color + ';">' + (value || 0) + '</div>' +
    '<div style="font-size:0.7rem;color:#94a3b8;">' + label + '</div>' +
    '</div>';
}

// -- Post Detail --------------------------------------------------

function socialRenderDetail() {
  var main = document.querySelector('#main');
  var post = socialSelectedPost;
  if (!post) {
    socialRenderOverview();
    return;
  }

  // Status label mapping
  var statusLabels = {
    draft: 'Draft', scheduled: 'Scheduled', posting: 'Posting',
    posted: 'Posted', partial: 'Partial', failed: 'Failed',
  };
  var statusColors = {
    draft: '#64748b', scheduled: '#3b82f6', posting: '#f59e0b',
    posted: '#22c55e', partial: '#f97316', failed: '#ef4444',
  };
  var statusColor = statusColors[post.status] || '#64748b';

  // Platform status rows
  var platformRows = post.platforms.map(function (p) {
    var pColor = statusColors[p.status] || '#64748b';
    return '<div class="sd-platform-row">' +
      '<div class="sd-platform-row-left">' +
      socialPlatformBadge(p.platform) +
      '</div>' +
      '<div class="sd-platform-row-right">' +
      '<span class="sd-platform-status" style="color:' + pColor + ';">' +
      socialStatusDot(p.status) + ' ' + (statusLabels[p.status] || p.status) +
      '</span>' +
      (p.error ? '<span class="sd-platform-error">' + socialEsc(p.error) + '</span>' : '') +
      (p.postUrl ? '<a href="' + socialEsc(p.postUrl) + '" target="_blank" class="sd-platform-link">View post &rarr;</a>' : '') +
      '</div>' +
      '</div>';
  }).join('');

  // Content text
  var textContent = (post.content && post.content.text) || '';

  // Images
  var imagesHtml = '';
  if (post.content && post.content.images && post.content.images.length > 0) {
    imagesHtml = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">';
    post.content.images.forEach(function (img) {
      var src = typeof img === 'string' ? img : (img.url || img.path || '');
      imagesHtml += '<div style="width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid #1e293b;">' +
        '<img src="' + socialEsc(src) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'" />' +
        '</div>';
    });
    imagesHtml += '</div>';
  }

  // Tags
  var tagsHtml = '';
  if (post.tags && post.tags.length > 0) {
    tagsHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">';
    post.tags.forEach(function (tag) {
      tagsHtml += '<span style="padding:2px 10px;background:#7c3aed22;border:1px solid #7c3aed44;border-radius:12px;font-size:0.75rem;color:#c4b5fd;">' +
        socialEsc(tag) + '</span>';
    });
    tagsHtml += '</div>';
  }

  var html =
    '<div class="sd-container">' +

    // -- Header bar --
    '<div class="sd-header">' +
    '<button class="sd-back-btn" id="social-back-btn">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div class="sd-header-title">Post Detail</div>' +
    '<div class="sd-status-pill" style="background:' + statusColor + '20;color:' + statusColor + ';border-color:' + statusColor + '40;">' +
    socialStatusDot(post.status) + ' ' + (statusLabels[post.status] || post.status) +
    '</div>' +
    '</div>' +

    // -- Content card --
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 2H2.7C2.3 2 2 2.3 2 2.7v10.6c0 .4.3.7.7.7h10.6c.4 0 .7-.3.7-.7V2.7c0-.4-.3-.7-.7-.7zM5 5h6M5 8h6M5 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Content</span>' +
    '</div>' +
    '<div style="padding:4px 0;font-size:0.9rem;line-height:1.5;color:#e2e8f0;white-space:pre-wrap;">' +
    socialEsc(textContent || '(no text)') +
    '</div>' +
    imagesHtml +
    tagsHtml +
    '</div>' +

    // -- Platforms card --
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '<span>Platforms</span>' +
    '</div>' +
    '<div class="sd-platform-statuses">' +
    platformRows +
    '</div>' +
    '</div>' +

    // -- Schedule card --
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Schedule</span>' +
    '</div>' +
    '<div style="font-size:0.9rem;color:#e2e8f0;">' +
    (post.scheduledAt ? socialFormatDateTime(post.scheduledAt) : 'Not scheduled (Draft)') +
    '</div>' +
    '</div>' +

    // -- Meta footer --
    '<div class="sd-meta">' +
    'Created ' + socialFormatDateTime(post.createdAt) +
    ' &middot; Updated ' + socialFormatDateTime(post.updatedAt) +
    ' &middot; <span style="font-family:monospace;">' + post.id.slice(0, 8) + '</span>' +
    '</div>' +

    // -- Action bar --
    '<div class="sd-actions">' +
    '<button class="sd-btn sd-btn-primary" id="social-edit-btn">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    'Edit</button>' +
    (post.status === 'draft' || post.status === 'failed'
      ? '<button class="sd-btn sd-btn-schedule" id="social-schedule-btn">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 112 8a6 6 0 0112 0z" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.7V8l2.7 1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
        'Schedule Now</button>'
      : '') +
    '<button class="sd-btn sd-btn-delete" id="social-delete-btn">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.7 4.7h10.6M6 4.7V3.3c0-.7.6-1.3 1.3-1.3h1.4c.7 0 1.3.6 1.3 1.3v1.4M12 4.7l-.5 8c0 .7-.6 1.3-1.3 1.3H5.8c-.7 0-1.3-.6-1.3-1.3l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    'Delete</button>' +
    '</div>' +

    '</div>';

  main.innerHTML = html;

  // Wire events
  main.querySelector('#social-back-btn').addEventListener('click', function () {
    socialSelectedPost = null;
    socialView = 'overview';
    socialRenderOverview();
    socialRenderSidebar();
  });

  // Edit button -- opens compose view with this post's data
  main.querySelector('#social-edit-btn').addEventListener('click', function () {
    socialEditingPostId = post.id;
    socialComposeData = socialInitComposeData(post);
    socialComposeTab = 'all';
    socialAssetPickerOpen = false;
    socialView = 'compose';
    socialRenderCompose();
    socialRenderSidebar();
  });

  var scheduleBtn = main.querySelector('#social-schedule-btn');
  if (scheduleBtn) {
    scheduleBtn.addEventListener('click', async function () {
      // Schedule for now + 5 minutes
      var now = new Date();
      now.setMinutes(now.getMinutes() + 5);
      try {
        var updated = await socialUpdatePost(post.id, {
          scheduledAt: now.toISOString(),
          status: 'scheduled',
        });
        socialSelectedPost = updated;
        await socialRefresh();
        socialRenderDetail();
        if (typeof toast === 'function') toast('Post scheduled', 'success');
      } catch (err) {
        if (typeof toast === 'function') toast('Schedule failed: ' + err, 'error');
      }
    });
  }

  main.querySelector('#social-delete-btn').addEventListener('click', async function () {
    if (!confirm('Delete this post?')) return;
    try {
      await socialDeletePost(post.id);
      socialSelectedPost = null;
      socialView = 'overview';
      await socialRefresh();
      socialRenderOverview();
      if (typeof toast === 'function') toast('Post deleted', 'success');
    } catch (err) {
      if (typeof toast === 'function') toast('Delete failed: ' + err, 'error');
    }
  });
}

function socialPlatformCheckboxes(post) {
  var allPlatforms = socialPlatforms.map(function (c) { return c.platform; });
  if (allPlatforms.length === 0) allPlatforms = ['instagram', 'twitter', 'youtube']; // fallback
  var enabled = {};
  (post ? post.platforms : []).forEach(function (p) {
    if (p.enabled) enabled[p.platform] = true;
  });

  return allPlatforms.map(function (p) {
    var checked = enabled[p] ? ' checked' : '';
    return '<label style="display:inline-flex;align-items:center;gap:6px;margin-right:12px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;">' +
      '<input type="checkbox" class="social-platform-cb" value="' + p + '"' + checked + ' />' +
      socialPlatformBadge(p, true) +
      '</label>';
  }).join('');
}

function socialPlatformToggles(post) {
  var allPlatforms = socialPlatforms.map(function (c) { return c.platform; });
  if (allPlatforms.length === 0) allPlatforms = ['instagram', 'twitter', 'youtube']; // fallback
  var defaultIcons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };
  var enabled = {};
  (post ? post.platforms : []).forEach(function (p) {
    if (p.enabled) enabled[p.platform] = true;
  });

  return allPlatforms.map(function (p) {
    var connector = socialPlatforms.find(function (c) { return c.platform === p; });
    var icon = (connector && connector.icon) || defaultIcons[p] || '\ud83c\udf10';
    var label = (connector && connector.displayName) || p;
    var checked = enabled[p] ? ' checked' : '';
    var active = enabled[p] ? ' sd-platform-toggle-active' : '';
    return '<label class="sd-platform-toggle' + active + '" data-platform="' + p + '">' +
      '<input type="checkbox" class="social-platform-cb" value="' + p + '"' + checked + ' style="display:none;" />' +
      '<span class="sd-platform-icon">' + icon + '</span>' +
      '<span class="sd-platform-name">' + label + '</span>' +
      '<span class="sd-platform-check">' + (enabled[p] ? '\u2713' : '') + '</span>' +
      '</label>';
  }).join('');
}

// -- Calendar -----------------------------------------------------

function socialRenderCalendar() {
  var main = document.querySelector('#main');
  var month = socialCalendarMonth;
  var year = month.getFullYear();
  var m = month.getMonth();

  var firstDay = new Date(year, m, 1).getDay();
  var daysInMonth = new Date(year, m + 1, 0).getDate();
  var monthName = month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Group posts by day
  var postsByDay = {};
  socialPosts.forEach(function (p) {
    if (!p.scheduledAt) return;
    var d = new Date(p.scheduledAt);
    if (d.getFullYear() !== year || d.getMonth() !== m) return;
    var day = d.getDate();
    if (!postsByDay[day]) postsByDay[day] = [];
    postsByDay[day].push(p);
  });

  var html =
    '<div style="padding:1.5rem;">' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:1.5rem;">' +
    '<button class="btn-secondary" id="social-cal-prev" style="padding:4px 8px;">&larr;</button>' +
    '<h2 style="color:#fff;font-size:1.25rem;flex:1;text-align:center;">' + monthName + '</h2>' +
    '<button class="btn-secondary" id="social-cal-next" style="padding:4px 8px;">&rarr;</button>' +
    '</div>' +
    '<div class="social-calendar">' +
    '<div class="social-cal-header">Sun</div>' +
    '<div class="social-cal-header">Mon</div>' +
    '<div class="social-cal-header">Tue</div>' +
    '<div class="social-cal-header">Wed</div>' +
    '<div class="social-cal-header">Thu</div>' +
    '<div class="social-cal-header">Fri</div>' +
    '<div class="social-cal-header">Sat</div>';

  // Empty cells before first day
  for (var i = 0; i < firstDay; i++) {
    html += '<div class="social-cal-cell social-cal-empty"></div>';
  }

  var today = new Date();
  var todayDay = (today.getFullYear() === year && today.getMonth() === m) ? today.getDate() : -1;

  for (var day = 1; day <= daysInMonth; day++) {
    var isToday = day === todayDay;
    var posts = postsByDay[day] || [];
    var cellClass = 'social-cal-cell' + (isToday ? ' social-cal-today' : '') + (posts.length ? ' social-cal-has-posts' : '');

    html += '<div class="' + cellClass + '" data-social-cal-day="' + day + '">' +
      '<div class="social-cal-day">' + day + '</div>';
    posts.slice(0, 3).forEach(function (p) {
      var preview = (p.content.text || '').slice(0, 20) || '(no text)';
      html += '<div class="social-cal-post" data-social-cal-post="' + p.id + '">' +
        socialStatusDot(p.status) +
        '<span>' + socialEsc(preview) + '</span>' +
        '</div>';
    });
    if (posts.length > 3) {
      html += '<div style="font-size:0.6rem;color:#94a3b8;">+' + (posts.length - 3) + ' more</div>';
    }
    html += '</div>';
  }

  html += '</div></div>';
  main.innerHTML = html;

  // Wire navigation
  main.querySelector('#social-cal-prev').addEventListener('click', function () {
    socialCalendarMonth = new Date(year, m - 1, 1);
    socialRenderCalendar();
  });
  main.querySelector('#social-cal-next').addEventListener('click', function () {
    socialCalendarMonth = new Date(year, m + 1, 1);
    socialRenderCalendar();
  });

  // Wire post clicks
  main.querySelectorAll('[data-social-cal-post]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = el.dataset.socialCalPost;
      socialSelectedPost = socialPosts.find(function (p) { return p.id === id; }) || null;
      if (socialSelectedPost) {
        socialView = 'detail';
        socialRenderDetail();
        socialRenderSidebar();
      }
    });
  });

  // Wire day click to create post for that date
  main.querySelectorAll('[data-social-cal-day]').forEach(function (cell) {
    cell.addEventListener('click', function (e) {
      // Don't trigger if clicking a post inside the cell
      if (e.target.closest('[data-social-cal-post]')) return;
      var dayNum = parseInt(cell.dataset.socialCalDay, 10);
      var dateStr = year + '-' + String(m + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
      socialEditingPostId = null;
      socialComposeData = socialInitComposeData(null);
      socialComposeData.scheduleMode = 'schedule';
      socialComposeData.scheduledAt = new Date(dateStr + 'T12:00:00').toISOString();
      socialComposeTab = 'all';
      socialAssetPickerOpen = false;
      socialView = 'compose';
      socialRenderCompose();
      socialRenderSidebar();
    });
  });
}

// -- Queue --------------------------------------------------------

function socialRenderQueue() {
  var main = document.querySelector('#main');

  // Filter posts
  var filtered = socialPosts.slice();
  if (socialQueuePlatformFilter !== 'all') {
    filtered = filtered.filter(function (post) {
      return post.platforms.some(function (p) { return p.enabled && p.platform === socialQueuePlatformFilter; });
    });
  }
  if (socialQueueSearch) {
    var search = socialQueueSearch.toLowerCase();
    filtered = filtered.filter(function (post) {
      var text = ((post.content && post.content.text) || '').toLowerCase();
      var tags = (post.tags || []).join(' ').toLowerCase();
      return text.indexOf(search) !== -1 || tags.indexOf(search) !== -1;
    });
  }

  var statusLabels = {
    draft: 'Draft', scheduled: 'Scheduled', posting: 'Posting',
    posted: 'Posted', partial: 'Partial', failed: 'Failed',
  };
  var statusColors = {
    draft: '#64748b', scheduled: '#3b82f6', posting: '#f59e0b',
    posted: '#22c55e', partial: '#f97316', failed: '#ef4444',
  };

  var html =
    '<div style="padding:1.5rem;">' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:1.25rem;">' +
    '<h2 style="color:#fff;font-size:1.25rem;flex:1;">Post Queue</h2>' +
    '<span style="color:#64748b;font-size:0.8rem;">' + filtered.length + ' post' + (filtered.length !== 1 ? 's' : '') + '</span>' +
    '</div>' +

    // Toolbar
    '<div style="display:flex;gap:10px;margin-bottom:16px;align-items:center;">' +
    // Search
    '<div style="flex:1;position:relative;">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:0.4;pointer-events:none;">' +
    '<circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    '<input type="text" id="social-queue-search" placeholder="Search posts..." value="' + socialEsc(socialQueueSearch) + '" style="' +
    'width:100%;padding:8px 10px 8px 30px;background:#0a0f1a;border:1px solid #1e293b;border-radius:8px;' +
    'color:#e2e8f0;font-size:0.8rem;outline:none;' +
    '" />' +
    '</div>' +
    // Platform filter
    '<select id="social-queue-platform" style="' +
    'padding:8px 12px;background:#0a0f1a;border:1px solid #1e293b;border-radius:8px;' +
    'color:#e2e8f0;font-size:0.8rem;outline:none;cursor:pointer;' +
    '">' +
    '<option value="all"' + (socialQueuePlatformFilter === 'all' ? ' selected' : '') + '>All Platforms</option>' +
    (socialPlatforms.length > 0
      ? socialPlatforms.map(function (c) {
          return '<option value="' + c.platform + '"' + (socialQueuePlatformFilter === c.platform ? ' selected' : '') + '>' + socialEsc(c.displayName || c.platform) + '</option>';
        }).join('')
      : '<option value="instagram"' + (socialQueuePlatformFilter === 'instagram' ? ' selected' : '') + '>Instagram</option>' +
        '<option value="twitter"' + (socialQueuePlatformFilter === 'twitter' ? ' selected' : '') + '>Twitter</option>' +
        '<option value="youtube"' + (socialQueuePlatformFilter === 'youtube' ? ' selected' : '') + '>YouTube</option>') +
    '</select>' +
    '</div>';

  // Post list
  if (filtered.length === 0) {
    html += '<div style="text-align:center;padding:40px 20px;color:#475569;">' +
      '<div style="font-size:2rem;margin-bottom:8px;">\ud83d\udcad</div>' +
      '<div style="font-size:0.9rem;">No posts match your filters.</div>' +
      '</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:2px;">';

    // Table header
    html += '<div style="display:grid;grid-template-columns:32px 1fr 120px 140px 80px;gap:8px;padding:8px 12px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#475569;font-weight:600;">' +
      '<span></span><span>Content</span><span>Platforms</span><span>Scheduled</span><span>Actions</span>' +
      '</div>';

    filtered.forEach(function (post) {
      var sColor = statusColors[post.status] || '#64748b';
      var preview = ((post.content && post.content.text) || '').slice(0, 60) || '(no text)';
      var enabledPlats = post.platforms.filter(function (p) { return p.enabled; });
      var defaultQueueIcons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };
      var platStr = enabledPlats.map(function (p) {
        var conn = socialPlatforms.find(function (c) { return c.platform === p.platform; });
        return (conn && conn.icon) || defaultQueueIcons[p.platform] || '\ud83c\udf10';
      }).join(' ');
      var schedStr = post.scheduledAt ? socialFormatDateTime(post.scheduledAt) : 'Draft';

      html += '<div class="social-queue-row" data-social-queue-post="' + post.id + '" style="' +
        'display:grid;grid-template-columns:32px 1fr 120px 140px 80px;gap:8px;' +
        'padding:10px 12px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;' +
        'align-items:center;cursor:pointer;transition:all 0.15s;' +
        '">' +
        // Status dot
        '<div>' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + sColor + ';" title="' + (statusLabels[post.status] || post.status) + '"></span>' +
        '</div>' +
        // Content preview
        '<div style="font-size:0.85rem;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        socialEsc(preview) +
        '</div>' +
        // Platforms
        '<div style="font-size:0.85rem;">' + platStr + '</div>' +
        // Schedule time
        '<div style="font-size:0.75rem;color:#94a3b8;">' + socialEsc(schedStr) + '</div>' +
        // Actions
        '<div style="display:flex;gap:4px;">' +
        '<button class="social-queue-edit-btn" data-queue-edit="' + post.id + '" style="' +
        'padding:4px 8px;background:transparent;border:1px solid #334155;border-radius:6px;' +
        'color:#94a3b8;font-size:0.7rem;cursor:pointer;transition:all 0.15s;' +
        '" title="Edit">Edit</button>' +
        '<button class="social-queue-delete-btn" data-queue-delete="' + post.id + '" style="' +
        'padding:4px 8px;background:transparent;border:1px solid #33415540;border-radius:6px;' +
        'color:#64748b;font-size:0.7rem;cursor:pointer;transition:all 0.15s;' +
        '" title="Delete">&times;</button>' +
        '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  main.innerHTML = html;

  // Wire search
  var searchInput = main.querySelector('#social-queue-search');
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      socialQueueSearch = searchInput.value;
      socialRenderQueue();
    });
    // Focus and restore cursor position
    searchInput.focus();
    searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
  }

  // Wire platform filter
  var platSelect = main.querySelector('#social-queue-platform');
  if (platSelect) {
    platSelect.addEventListener('change', function () {
      socialQueuePlatformFilter = platSelect.value;
      socialRenderQueue();
    });
  }

  // Wire row clicks (open detail)
  main.querySelectorAll('[data-social-queue-post]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      // Don't navigate if clicking action buttons
      if (e.target.closest('.social-queue-edit-btn') || e.target.closest('.social-queue-delete-btn')) return;
      var id = row.dataset.socialQueuePost;
      socialSelectedPost = socialPosts.find(function (p) { return p.id === id; }) || null;
      if (socialSelectedPost) {
        socialView = 'detail';
        socialRenderDetail();
        socialRenderSidebar();
      }
    });
  });

  // Wire edit buttons
  main.querySelectorAll('.social-queue-edit-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = btn.dataset.queueEdit;
      var post = socialPosts.find(function (p) { return p.id === id; });
      if (post) {
        socialEditingPostId = post.id;
        socialComposeData = socialInitComposeData(post);
        socialComposeTab = 'all';
        socialAssetPickerOpen = false;
        socialView = 'compose';
        socialRenderCompose();
        socialRenderSidebar();
      }
    });
  });

  // Wire delete buttons
  main.querySelectorAll('.social-queue-delete-btn').forEach(function (btn) {
    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      var id = btn.dataset.queueDelete;
      if (!confirm('Delete this post?')) return;
      try {
        await socialDeletePost(id);
        await socialRefresh();
        socialRenderQueue();
        if (typeof toast === 'function') toast('Post deleted', 'success');
      } catch (err) {
        if (typeof toast === 'function') toast('Delete failed: ' + err, 'error');
      }
    });
  });
}

// -- Templates (placeholder) --------------------------------------

function socialRenderTemplates() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;">' +
    '<div style="width:64px;height:64px;border-radius:16px;background:#7c3aed12;border:1px solid #7c3aed30;display:flex;align-items:center;justify-content:center;margin-bottom:16px;">' +
    '<svg width="28" height="28" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#7c3aed" stroke-width="1.2"/><path d="M5 5h6M5 8h4" stroke="#7c3aed" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '</div>' +
    '<h2 style="color:#e2e8f0;font-size:1.15rem;margin-bottom:6px;">Templates</h2>' +
    '<p style="color:#64748b;font-size:0.85rem;text-align:center;max-width:320px;line-height:1.5;">Coming soon. Save and reuse post templates to speed up your content creation workflow.</p>' +
    '</div>';
}

// -- Hashtags (placeholder) ---------------------------------------

function socialRenderHashtags() {
  var main = document.querySelector('#main');
  main.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;">' +
    '<div style="width:64px;height:64px;border-radius:16px;background:#7c3aed12;border:1px solid #7c3aed30;display:flex;align-items:center;justify-content:center;margin-bottom:16px;">' +
    '<svg width="28" height="28" viewBox="0 0 16 16" fill="none"><path d="M4 1v14M12 1v14M1 5h14M1 11h14" stroke="#7c3aed" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '</div>' +
    '<h2 style="color:#e2e8f0;font-size:1.15rem;margin-bottom:6px;">Hashtag Groups</h2>' +
    '<p style="color:#64748b;font-size:0.85rem;text-align:center;max-width:320px;line-height:1.5;">Coming soon. Save and organize hashtag clusters to quickly add relevant tags to your posts.</p>' +
    '</div>';
}
