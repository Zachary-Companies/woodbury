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

  var filterBtns =
    '<div style="padding:0.5rem;">' +
    '<button class="wf-new-btn" id="social-new-post-btn" style="margin-bottom:0.5rem;background:linear-gradient(135deg,#7c3aed,#6d28d9);">' +
    '+ New Post</button>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:0.5rem;">' +
    socialFilterBtn('all', 'All') +
    socialFilterBtn('draft', 'Draft') +
    socialFilterBtn('scheduled', 'Scheduled') +
    socialFilterBtn('posted', 'Posted') +
    socialFilterBtn('failed', 'Failed') +
    '</div>' +
    '<div style="display:flex;gap:4px;margin-bottom:0.5rem;">' +
    '<button class="social-view-btn' + (socialView === 'overview' ? ' active' : '') + '" data-social-view="overview">\ud83d\udcca Overview</button>' +
    '<button class="social-view-btn' + (socialView === 'calendar' ? ' active' : '') + '" data-social-view="calendar">\ud83d\udcc5 Calendar</button>' +
    '</div>' +
    '</div>';

  var postItems = socialPosts.map(function (post) {
    var isSelected = socialSelectedPost && socialSelectedPost.id === post.id;
    var preview = (post.content.text || '').slice(0, 60) || '(no text)';
    var platforms = post.platforms.filter(function (p) { return p.enabled; })
      .map(function (p) { return socialPlatformBadge(p.platform, true); }).join('');
    var time = post.scheduledAt ? socialFormatDateTime(post.scheduledAt) : 'Draft';

    return '<div class="ext-item' + (isSelected ? ' active' : '') + '" data-social-post="' + post.id + '">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">' +
      socialStatusDot(post.status) +
      '<span style="font-size:0.8rem;color:#e2e8f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
      socialEsc(preview) + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;">' +
      platforms +
      '<span style="font-size:0.65rem;color:#64748b;margin-left:auto;">' + socialEsc(time) + '</span>' +
      '</div>' +
      '</div>';
  }).join('');

  if (socialPosts.length === 0) {
    postItems = '<div style="padding:1rem;color:#64748b;font-size:0.8rem;text-align:center;">' +
      'No posts' + (socialFilter !== 'all' ? ' with status "' + socialFilter + '"' : '') + '.' +
      '</div>';
  }

  sidebar.innerHTML = filterBtns + postItems;

  // Wire events
  sidebar.querySelector('#social-new-post-btn').addEventListener('click', function () {
    socialView = 'create';
    socialSelectedPost = null;
    socialRenderCreateForm();
    socialRenderSidebar();
  });

  sidebar.querySelectorAll('.social-filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      socialFilter = btn.dataset.socialFilter;
      socialRefresh();
    });
  });

  sidebar.querySelectorAll('.social-view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      socialView = btn.dataset.socialView;
      socialSelectedPost = null;
      if (socialView === 'overview') socialRenderOverview();
      else if (socialView === 'calendar') socialRenderCalendar();
      socialRenderSidebar();
    });
  });

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

  var platforms = post.platforms.map(function (p) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;">' +
      socialPlatformBadge(p.platform) +
      socialStatusDot(p.status) +
      '<span style="font-size:0.75rem;color:#94a3b8;">' + p.status + '</span>' +
      (p.error ? '<span style="font-size:0.7rem;color:#ef4444;">(' + socialEsc(p.error) + ')</span>' : '') +
      (p.postUrl ? '<a href="' + socialEsc(p.postUrl) + '" target="_blank" style="font-size:0.7rem;color:#7c3aed;">View</a>' : '') +
      '</div>';
  }).join('');

  var tags = (post.tags || []).map(function (t) {
    return '<span class="social-tag">' + socialEsc(t) + '</span>';
  }).join(' ');

  var html =
    '<div style="padding:1.5rem;">' +
    // Header
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:1.5rem;">' +
    '<button class="btn-secondary" id="social-back-btn" style="padding:4px 8px;">&larr;</button>' +
    '<h2 style="color:#fff;font-size:1.25rem;flex:1;">Post Detail</h2>' +
    socialStatusDot(post.status) +
    '<span style="color:#94a3b8;font-size:0.85rem;">' + post.status + '</span>' +
    '</div>' +

    // Content
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Content</label>' +
    '<textarea id="social-edit-text" class="wf-run-input" style="width:100%;min-height:100px;resize:vertical;">' +
    socialEsc(post.content.text) + '</textarea>' +
    '</div>' +

    // Platforms
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Platforms</label>' +
    '<div id="social-edit-platforms">' +
    socialPlatformCheckboxes(post) +
    '</div>' +
    '</div>' +

    // Schedule
    '<div style="display:flex;gap:0.75rem;margin-bottom:1rem;">' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Schedule Date</label>' +
    '<input type="date" id="social-edit-date" class="wf-run-input" style="width:100%;" value="' +
    (post.scheduledAt ? new Date(post.scheduledAt).toISOString().split('T')[0] : '') + '" />' +
    '</div>' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Schedule Time</label>' +
    '<input type="time" id="social-edit-time" class="wf-run-input" style="width:100%;" value="' +
    (post.scheduledAt ? new Date(post.scheduledAt).toTimeString().slice(0, 5) : '') + '" />' +
    '</div>' +
    '</div>' +

    // Tags
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Tags (comma-separated)</label>' +
    '<input type="text" id="social-edit-tags" class="wf-run-input" style="width:100%;" value="' +
    socialEsc((post.tags || []).join(', ')) + '" />' +
    '</div>' +

    // Platform statuses
    '<div style="margin-bottom:1rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Platform Status</label>' +
    '<div style="border:1px solid #1e293b;border-radius:8px;padding:8px 12px;">' +
    platforms +
    '</div>' +
    '</div>' +

    // Meta
    '<div style="font-size:0.7rem;color:#64748b;margin-bottom:1rem;">' +
    'Created: ' + socialFormatDateTime(post.createdAt) +
    ' &middot; Updated: ' + socialFormatDateTime(post.updatedAt) +
    ' &middot; ID: ' + post.id.slice(0, 8) +
    '</div>' +

    // Actions
    '<div style="display:flex;gap:0.5rem;">' +
    '<button class="btn-primary" id="social-save-btn">Save Changes</button>' +
    (post.status === 'draft' || post.status === 'failed'
      ? '<button class="btn-primary" id="social-schedule-btn" style="background:#3b82f6;">Schedule</button>'
      : '') +
    '<button class="btn-secondary" id="social-delete-btn" style="color:#ef4444;">Delete</button>' +
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
