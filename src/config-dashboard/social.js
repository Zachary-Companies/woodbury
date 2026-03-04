/**
 * Social Scheduler Dashboard — Client-side JavaScript
 *
 * Full social media post management: create, schedule, edit, calendar view.
 * Loaded alongside app.js in the same SPA.
 */

// ── State ────────────────────────────────────────────────────
var socialPosts = [];
var socialSelectedPost = null;
var socialFilter = 'all'; // all | draft | scheduled | posting | posted | failed
var socialStats = null;
var socialConfig = null;
var socialScripts = null;
var socialView = 'overview'; // overview | detail | create | calendar
var socialCalendarMonth = new Date();

// ── Helpers ──────────────────────────────────────────────────

function socialEsc(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function socialFormatDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function socialFormatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function socialFormatDateTime(iso) {
  if (!iso) return '—';
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
  var icons = {
    instagram: '\ud83d\udcf7',
    twitter: '\ud83d\udc26',
    youtube: '\u25b6\ufe0f',
  };
  var cls = small ? 'social-platform-badge social-platform-badge-sm' : 'social-platform-badge';
  return '<span class="' + cls + '" data-platform="' + platform + '">' + (icons[platform] || '') + ' ' + platform + '</span>';
}

// ── API ──────────────────────────────────────────────────────

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

// ── Init ─────────────────────────────────────────────────────

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
    ]);
    socialPosts = results[0];
    socialStats = results[1];
    socialScripts = results[2];

    socialRenderSidebar();
    if (socialView === 'overview') {
      socialRenderOverview();
    }
  } catch (err) {
    main.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon">\u26a0\ufe0f</div>' +
      '<h2>Failed to load social scheduler</h2>' +
      '<p>' + socialEsc(String(err)) + '</p>' +
      '</div>';
  }
}

// ── Sidebar ──────────────────────────────────────────────────

function socialRenderSidebar() {
  var sidebar = document.querySelector('#social-list');
  if (!sidebar) return;

  // Stats mini-counts
  var counts = socialStats || {};

  var html =
    '<div class="ss-sidebar">' +

    // ── New Post button ──
    '<button class="ss-new-btn" id="social-new-post-btn">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<span>New Post</span>' +
    '</button>' +

    // ── Filter pills ──
    '<div class="ss-filters">' +
    socialFilterPill('all', 'All', counts.total) +
    socialFilterPill('draft', 'Drafts', counts.draft) +
    socialFilterPill('scheduled', 'Scheduled', counts.scheduled) +
    socialFilterPill('posted', 'Posted', counts.posted) +
    socialFilterPill('failed', 'Failed', counts.failed) +
    '</div>' +

    // ── View switcher ──
    '<div class="ss-view-switch">' +
    '<button class="ss-view-btn' + (socialView === 'overview' || socialView === 'detail' || socialView === 'create' ? ' active' : '') + '" data-social-view="overview">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>' +
    'Overview</button>' +
    '<button class="ss-view-btn' + (socialView === 'calendar' ? ' active' : '') + '" data-social-view="calendar">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    'Calendar</button>' +
    '<button class="ss-view-btn' + (socialView === 'settings' ? ' active' : '') + '" id="social-settings-btn">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.9 1.7l-.2 1.2c-.5.2-.9.5-1.3.8l-1.1-.4-1.1 1.9 1 .8c-.1.3-.1.5-.1.8s0 .5.1.8l-1 .8 1.1 1.9 1.1-.4c.4.3.8.6 1.3.8l.2 1.2h2.2l.2-1.2c.5-.2.9-.5 1.3-.8l1.1.4 1.1-1.9-1-.8c.1-.3.1-.5.1-.8s0-.5-.1-.8l1-.8-1.1-1.9-1.1.4c-.4-.3-.8-.6-1.3-.8l-.2-1.2H6.9z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '</button>' +
    '</div>' +

    // ── Divider ──
    '<div class="ss-divider"></div>' +

    // ── Post list header ──
    '<div class="ss-list-header">' +
    '<span>Posts</span>' +
    '<span class="ss-list-count">' + socialPosts.length + '</span>' +
    '</div>';

  // ── Post items ──
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
      var platformIcons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };
      var platStr = platforms.map(function (p) { return platformIcons[p.platform] || ''; }).join(' ');
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
    socialView = 'create';
    socialSelectedPost = null;
    socialRenderCreateForm();
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
      if (socialView === 'overview') socialRenderOverview();
      else if (socialView === 'calendar') socialRenderCalendar();
      socialRenderSidebar();
    });
  });

  var settingsBtn = sidebar.querySelector('#social-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', function () {
      socialView = 'settings';
      socialSelectedPost = null;
      socialRenderSettings();
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

// ── Overview ─────────────────────────────────────────────────

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

// ── Post Detail ──────────────────────────────────────────────

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

  // Content preview (first 100 chars for the hero card)
  var preview = (post.content.text || '').slice(0, 100);
  if ((post.content.text || '').length > 100) preview += '...';

  var html =
    '<div class="sd-container">' +

    // ── Header bar ──
    '<div class="sd-header">' +
    '<button class="sd-back-btn" id="social-back-btn">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div class="sd-header-title">Post Detail</div>' +
    '<div class="sd-status-pill" style="background:' + statusColor + '20;color:' + statusColor + ';border-color:' + statusColor + '40;">' +
    socialStatusDot(post.status) + ' ' + (statusLabels[post.status] || post.status) +
    '</div>' +
    '</div>' +

    // ── Content card ──
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 2H2.7C2.3 2 2 2.3 2 2.7v10.6c0 .4.3.7.7.7h10.6c.4 0 .7-.3.7-.7V2.7c0-.4-.3-.7-.7-.7zM5 5h6M5 8h6M5 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Content</span>' +
    '</div>' +
    '<textarea id="social-edit-text" class="sd-textarea" placeholder="Write your post...">' +
    socialEsc(post.content.text) + '</textarea>' +
    '</div>' +

    // ── Platforms card ──
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '<span>Platforms</span>' +
    '</div>' +
    '<div class="sd-platforms-grid" id="social-edit-platforms">' +
    socialPlatformToggles(post) +
    '</div>' +
    '</div>' +

    // ── Schedule card ──
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Schedule</span>' +
    '</div>' +
    '<div class="sd-schedule-row">' +
    '<div class="sd-field">' +
    '<label class="sd-label">Date</label>' +
    '<input type="date" id="social-edit-date" class="sd-input" value="' +
    (post.scheduledAt ? new Date(post.scheduledAt).toISOString().split('T')[0] : '') + '" />' +
    '</div>' +
    '<div class="sd-field">' +
    '<label class="sd-label">Time</label>' +
    '<input type="time" id="social-edit-time" class="sd-input" value="' +
    (post.scheduledAt ? new Date(post.scheduledAt).toTimeString().slice(0, 5) : '') + '" />' +
    '</div>' +
    '</div>' +
    '</div>' +

    // ── Tags card ──
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 8.7V2.5c0-.6.4-1 1-1h6.2L14.5 7l-6 6.5-7-4.8z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>' +
    '<span>Tags</span>' +
    '</div>' +
    '<input type="text" id="social-edit-tags" class="sd-input" placeholder="marketing, product, launch" value="' +
    socialEsc((post.tags || []).join(', ')) + '" />' +
    '</div>' +

    // ── Platform status card ──
    '<div class="sd-card">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 14A6 6 0 108 2a6 6 0 000 12z" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<span>Delivery Status</span>' +
    '</div>' +
    '<div class="sd-platform-statuses">' +
    platformRows +
    '</div>' +
    '</div>' +

    // ── Meta footer ──
    '<div class="sd-meta">' +
    'Created ' + socialFormatDateTime(post.createdAt) +
    ' &middot; Updated ' + socialFormatDateTime(post.updatedAt) +
    ' &middot; <span style="font-family:monospace;">' + post.id.slice(0, 8) + '</span>' +
    '</div>' +

    // ── Action bar ──
    '<div class="sd-actions">' +
    '<button class="sd-btn sd-btn-primary" id="social-save-btn">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>' +
    'Save Changes</button>' +
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

  // Platform toggle interaction
  main.querySelectorAll('.sd-platform-toggle input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var toggle = cb.closest('.sd-platform-toggle');
      if (cb.checked) {
        toggle.classList.add('sd-platform-toggle-active');
        toggle.querySelector('.sd-platform-check').textContent = '\u2713';
      } else {
        toggle.classList.remove('sd-platform-toggle-active');
        toggle.querySelector('.sd-platform-check').textContent = '';
      }
    });
  });

  main.querySelector('#social-save-btn').addEventListener('click', async function () {
    await socialSavePost();
  });

  var scheduleBtn = main.querySelector('#social-schedule-btn');
  if (scheduleBtn) {
    scheduleBtn.addEventListener('click', async function () {
      // Set schedule to now + 1 minute if no date/time set
      var dateInput = main.querySelector('#social-edit-date');
      var timeInput = main.querySelector('#social-edit-time');
      if (!dateInput.value) {
        var now = new Date();
        now.setMinutes(now.getMinutes() + 5);
        dateInput.value = now.toISOString().split('T')[0];
        timeInput.value = now.toTimeString().slice(0, 5);
      }
      await socialSavePost('scheduled');
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
  var allPlatforms = ['instagram', 'twitter', 'youtube'];
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
  var allPlatforms = ['instagram', 'twitter', 'youtube'];
  var icons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };
  var labels = { instagram: 'Instagram', twitter: 'Twitter', youtube: 'YouTube' };
  var enabled = {};
  (post ? post.platforms : []).forEach(function (p) {
    if (p.enabled) enabled[p.platform] = true;
  });

  return allPlatforms.map(function (p) {
    var checked = enabled[p] ? ' checked' : '';
    var active = enabled[p] ? ' sd-platform-toggle-active' : '';
    return '<label class="sd-platform-toggle' + active + '" data-platform="' + p + '">' +
      '<input type="checkbox" class="social-platform-cb" value="' + p + '"' + checked + ' style="display:none;" />' +
      '<span class="sd-platform-icon">' + icons[p] + '</span>' +
      '<span class="sd-platform-name">' + labels[p] + '</span>' +
      '<span class="sd-platform-check">' + (enabled[p] ? '\u2713' : '') + '</span>' +
      '</label>';
  }).join('');
}

async function socialSavePost(forceStatus) {
  var main = document.querySelector('#main');
  var post = socialSelectedPost;
  if (!post) return;

  var text = main.querySelector('#social-edit-text').value;
  var dateVal = main.querySelector('#social-edit-date').value;
  var timeVal = main.querySelector('#social-edit-time').value;
  var tagsVal = main.querySelector('#social-edit-tags').value;

  var scheduledAt = null;
  if (dateVal) {
    scheduledAt = new Date(dateVal + 'T' + (timeVal || '12:00') + ':00').toISOString();
  }

  var platforms = [];
  main.querySelectorAll('.social-platform-cb').forEach(function (cb) {
    platforms.push({
      platform: cb.value,
      enabled: cb.checked,
      status: 'pending',
      retryCount: 0,
    });
  });

  var data = {
    content: { text: text },
    scheduledAt: scheduledAt,
    platforms: platforms,
    tags: tagsVal.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
  };

  if (forceStatus) {
    data.status = forceStatus;
  }

  try {
    var updated = await socialUpdatePost(post.id, data);
    socialSelectedPost = updated;
    await socialRefresh();
    socialRenderDetail();
    if (typeof toast === 'function') toast('Post saved', 'success');
  } catch (err) {
    if (typeof toast === 'function') toast('Save failed: ' + err, 'error');
  }
}

// ── Create Post ──────────────────────────────────────────────

function socialRenderCreateForm() {
  var main = document.querySelector('#main');

  var html =
    '<div style="padding:1.5rem;">' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:1.5rem;">' +
    '<button class="btn-secondary" id="social-create-back" style="padding:4px 8px;">&larr;</button>' +
    '<h2 style="color:#fff;font-size:1.25rem;">New Post</h2>' +
    '</div>' +

    // Text
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Content</label>' +
    '<textarea id="social-create-text" class="wf-run-input" style="width:100%;min-height:120px;resize:vertical;" placeholder="What do you want to share?"></textarea>' +
    '</div>' +

    // Platforms
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Platforms</label>' +
    '<div id="social-create-platforms">' +
    socialPlatformCheckboxes(null) +
    '</div>' +
    '</div>' +

    // Schedule
    '<div style="display:flex;gap:0.75rem;margin-bottom:1rem;">' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Schedule Date (optional)</label>' +
    '<input type="date" id="social-create-date" class="wf-run-input" style="width:100%;" />' +
    '</div>' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Schedule Time</label>' +
    '<input type="time" id="social-create-time" class="wf-run-input" style="width:100%;" />' +
    '</div>' +
    '</div>' +

    // Tags
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Tags (comma-separated)</label>' +
    '<input type="text" id="social-create-tags" class="wf-run-input" style="width:100%;" placeholder="marketing, product" />' +
    '</div>' +

    // Actions
    '<div style="display:flex;gap:0.5rem;">' +
    '<button class="btn-primary" id="social-create-draft" style="background:#64748b;">Save as Draft</button>' +
    '<button class="btn-primary" id="social-create-schedule" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);">Schedule</button>' +
    '</div>' +
    '</div>';

  main.innerHTML = html;

  main.querySelector('#social-create-back').addEventListener('click', function () {
    socialView = 'overview';
    socialRenderOverview();
    socialRenderSidebar();
  });

  main.querySelector('#social-create-draft').addEventListener('click', function () {
    socialDoCreate(false);
  });

  main.querySelector('#social-create-schedule').addEventListener('click', function () {
    socialDoCreate(true);
  });
}

async function socialDoCreate(schedule) {
  var main = document.querySelector('#main');
  var text = main.querySelector('#social-create-text').value.trim();
  var dateVal = main.querySelector('#social-create-date').value;
  var timeVal = main.querySelector('#social-create-time').value;
  var tagsVal = main.querySelector('#social-create-tags').value;

  if (!text) {
    if (typeof toast === 'function') toast('Post text is required', 'error');
    return;
  }

  var platforms = [];
  main.querySelectorAll('.social-platform-cb').forEach(function (cb) {
    if (cb.checked) platforms.push(cb.value);
  });

  if (platforms.length === 0) {
    if (typeof toast === 'function') toast('Select at least one platform', 'error');
    return;
  }

  var scheduledAt = null;
  if (schedule) {
    if (!dateVal) {
      if (typeof toast === 'function') toast('Set a date to schedule', 'error');
      return;
    }
    scheduledAt = new Date(dateVal + 'T' + (timeVal || '12:00') + ':00').toISOString();
  }

  var tags = tagsVal.split(',').map(function (t) { return t.trim(); }).filter(Boolean);

  try {
    var post = await socialCreatePost({
      text: text,
      platforms: platforms,
      scheduledAt: scheduledAt,
      tags: tags,
    });
    socialSelectedPost = post;
    socialView = 'detail';
    await socialRefresh();
    socialRenderDetail();
    socialRenderSidebar();
    if (typeof toast === 'function') toast('Post created!', 'success');
  } catch (err) {
    if (typeof toast === 'function') toast('Create failed: ' + err, 'error');
  }
}

// ── Calendar ─────────────────────────────────────────────────

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

    html += '<div class="' + cellClass + '">' +
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
}

// ── Settings ────────────────────────────────────────────────

async function socialRenderSettings() {
  var main = document.querySelector('#main');
  main.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto 16px;"></div><h2>Loading settings...</h2></div>';

  try {
    socialConfig = await socialFetchConfig();
  } catch (err) {
    main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\u26a0\ufe0f</div><h2>Failed to load settings</h2><p>' + socialEsc(String(err)) + '</p></div>';
    return;
  }

  var cfg = socialConfig;

  // Common timezones
  var timezones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai',
    'Australia/Sydney', 'Pacific/Auckland',
  ];
  var tzOptions = timezones.map(function (tz) {
    var sel = (cfg.defaultTimezone === tz) ? ' selected' : '';
    return '<option value="' + tz + '"' + sel + '>' + tz.replace(/_/g, ' ') + '</option>';
  }).join('');

  // Default platforms
  var allPlats = ['instagram', 'twitter', 'youtube'];
  var platLabels = { instagram: '\ud83d\udcf7 Instagram', twitter: '\ud83d\udc26 Twitter', youtube: '\u25b6\ufe0f YouTube' };
  var defPlats = cfg.defaultPlatforms || [];

  var html =
    '<div class="sd-container">' +

    // ── Header ──
    '<div class="sd-header">' +
    '<button class="sd-back-btn" id="social-settings-back">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div class="sd-header-title">Settings</div>' +
    '</div>' +

    // ── Grid ──
    '<div class="grid-12">' +

    // ── Timezone ──
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 3.5V8l3 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<span>Default Timezone</span>' +
    '</div>' +
    '<select id="social-cfg-tz" class="sd-input" style="width:100%;">' + tzOptions + '</select>' +
    '</div>' +

    // ── Default Platforms ──
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '<span>Default Platforms</span>' +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
    allPlats.map(function (p) {
      var checked = defPlats.indexOf(p) !== -1 ? ' checked' : '';
      return '<label style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:#1e293b;border:1px solid #334155;border-radius:8px;cursor:pointer;font-size:0.85rem;color:#e2e8f0;">' +
        '<input type="checkbox" class="social-cfg-plat" value="' + p + '"' + checked + '>' +
        platLabels[p] +
        '</label>';
    }).join('') +
    '</div>' +
    '</div>' +

    // ── LLM Settings ──
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5h12M2 8h8M2 11.5h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>AI Text Generation</span>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div class="sd-field">' +
    '<label class="sd-label">Text Provider</label>' +
    '<input type="text" id="social-cfg-text-provider" class="sd-input" value="' + socialEsc((cfg.llm || {}).textProvider || '') + '" placeholder="anthropic" />' +
    '</div>' +
    '<div class="sd-field">' +
    '<label class="sd-label">Text Model</label>' +
    '<input type="text" id="social-cfg-text-model" class="sd-input" value="' + socialEsc((cfg.llm || {}).textModel || '') + '" placeholder="claude-opus-4-5-20251101" />' +
    '</div>' +
    '</div>' +
    '</div>' +

    // ── Posting Behavior ──
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 112 8a6 6 0 0112 0z" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.7V8l2.7 1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Posting Behavior</span>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
    '<div class="sd-field">' +
    '<label class="sd-label">Delay Between Platforms (ms)</label>' +
    '<input type="number" id="social-cfg-delay" class="sd-input" value="' + ((cfg.posting || {}).delayBetweenPlatforms || 5000) + '" />' +
    '</div>' +
    '<div class="sd-field">' +
    '<label class="sd-label">Retry Limit</label>' +
    '<input type="number" id="social-cfg-retry-limit" class="sd-input" value="' + ((cfg.posting || {}).retryLimit || 2) + '" />' +
    '</div>' +
    '<div class="sd-field">' +
    '<label class="sd-label">Retry Delay (ms)</label>' +
    '<input type="number" id="social-cfg-retry-delay" class="sd-input" value="' + ((cfg.posting || {}).retryDelay || 10000) + '" />' +
    '</div>' +
    '</div>' +
    '</div>' +

    '</div>' +

    // ── Save ──
    '<div class="sd-actions">' +
    '<button class="sd-btn sd-btn-primary" id="social-cfg-save">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>' +
    'Save Settings</button>' +
    '</div>' +

    '</div>';

  main.innerHTML = html;

  // Wire back button
  main.querySelector('#social-settings-back').addEventListener('click', function () {
    socialView = 'overview';
    socialRenderOverview();
    socialRenderSidebar();
  });

  // Wire save
  main.querySelector('#social-cfg-save').addEventListener('click', async function () {
    var btn = main.querySelector('#social-cfg-save');
    btn.disabled = true;
    btn.innerHTML = 'Saving...';

    var platforms = [];
    main.querySelectorAll('.social-cfg-plat').forEach(function (cb) {
      if (cb.checked) platforms.push(cb.value);
    });

    var data = {
      defaultTimezone: main.querySelector('#social-cfg-tz').value,
      defaultPlatforms: platforms,
      llm: {
        textProvider: main.querySelector('#social-cfg-text-provider').value.trim(),
        textModel: main.querySelector('#social-cfg-text-model').value.trim(),
      },
      posting: {
        delayBetweenPlatforms: parseInt(main.querySelector('#social-cfg-delay').value, 10) || 5000,
        retryLimit: parseInt(main.querySelector('#social-cfg-retry-limit').value, 10) || 2,
        retryDelay: parseInt(main.querySelector('#social-cfg-retry-delay').value, 10) || 10000,
      },
    };

    try {
      await socialSaveConfig(data);
      if (typeof toast === 'function') toast('Settings saved', 'success');
      btn.disabled = false;
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>' +
        'Save Settings';
    } catch (err) {
      if (typeof toast === 'function') toast('Save failed: ' + err, 'error');
      btn.disabled = false;
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>' +
        'Save Settings';
    }
  });
}
