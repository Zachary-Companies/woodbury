// ── Home Tab ──────────────────────────────────────────────────
// Feature showcase and introduction page for new users.

(function () {
  'use strict';

  var homeInitialized = false;

  function initHome() {
    var main = document.getElementById('main');
    if (!main) return;

    // Preserve state if re-entering
    if (homeInitialized && main.querySelector('.home-container')) return;

    main.innerHTML = '';
    main.style.display = '';
    main.style.flexDirection = '';

    var container = document.createElement('div');
    container.className = 'home-container';

    container.innerHTML =
      // Hero
      '<div class="home-hero">' +
        '<div class="home-hero-title"><span>Woodbury</span></div>' +
        '<div class="home-hero-tagline">' +
          'Your AI-powered content creation studio. Create images, videos, voiceovers, ' +
          'and social posts — then automate it all with pipelines that run on your schedule.' +
        '</div>' +
        '<button class="home-hero-cta" id="home-cta-chat">Start a conversation</button>' +
      '</div>' +

      // Stats
      '<div class="home-stats" id="home-stats">' +
        '<div class="home-stat">' +
          '<div class="home-stat-value" id="home-stat-extensions">-</div>' +
          '<div class="home-stat-label">Extensions</div>' +
        '</div>' +
        '<div class="home-stat">' +
          '<div class="home-stat-value" id="home-stat-workflows">-</div>' +
          '<div class="home-stat-label">Workflows</div>' +
        '</div>' +
        '<div class="home-stat">' +
          '<div class="home-stat-value" id="home-stat-pipelines">-</div>' +
          '<div class="home-stat-label">Pipelines</div>' +
        '</div>' +
      '</div>' +

      // Install pipeline from link
      '<div class="home-install-bar">' +
        '<div class="home-install-icon">' +
          '<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">' +
            '<path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />' +
          '</svg>' +
        '</div>' +
        '<input type="text" id="home-install-input" class="home-install-input" ' +
          'placeholder="Paste a woodbury:// install link or GitHub URL" spellcheck="false" />' +
        '<button id="home-install-btn" class="home-install-btn">Install</button>' +
      '</div>' +
      '<div id="home-install-status" class="home-install-status"></div>' +

      // Section: Pipeline Apps (populated dynamically)
      '<div id="home-pipeline-apps"></div>' +

      // Section: What you can do
      '<div class="home-section-title">What you can do</div>' +
      '<div class="home-grid">' +

        '<div class="home-card" data-tab="chat">' +
          '<div class="home-card-icon">&#x1f4ac;</div>' +
          '<div class="home-card-title">Chat with AI</div>' +
          '<div class="home-card-desc">' +
            'Talk naturally to create content, manage assets, and build automations. ' +
            'Just describe what you want.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="workflows">' +
          '<div class="home-card-icon">&#x25b6;&#xfe0f;</div>' +
          '<div class="home-card-title">Workflows</div>' +
          '<div class="home-card-desc">' +
            'Record browser actions and replay them automatically. ' +
            'Click, type, navigate — Woodbury remembers how.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="compositions">' +
          '<div class="home-card-icon">&#x1f517;</div>' +
          '<div class="home-card-title">Pipelines</div>' +
          '<div class="home-card-desc">' +
            'Chain workflows and AI scripts into automated content pipelines. ' +
            'Schedule them to run daily, weekly, or on demand.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="marketplace">' +
          '<div class="home-card-icon">&#x1f9e9;</div>' +
          '<div class="home-card-title">Marketplace</div>' +
          '<div class="home-card-desc">' +
            'Install extensions for image generation, video clipping, voice cloning, ' +
            'hashtags, content calendars, and more.' +
          '</div>' +
        '</div>' +

      '</div>' +

      // Section: Get started
      '<div class="home-section-title">Get started</div>' +
      '<div class="home-grid">' +

        '<div class="home-card" data-tab="chat">' +
          '<div class="home-card-icon">&#x1f3a8;</div>' +
          '<div class="home-card-title">Create Content</div>' +
          '<div class="home-card-desc">' +
            'Ask the AI to generate images, write scripts, create videos, or produce voiceovers for your brand.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="assets">' +
          '<div class="home-card-icon">&#x1f4c1;</div>' +
          '<div class="home-card-title">Organize Assets</div>' +
          '<div class="home-card-desc">' +
            'Save characters, logos, brand elements, and templates. Reuse them consistently across all your content.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="chat">' +
          '<div class="home-card-icon">&#x1f4c5;</div>' +
          '<div class="home-card-title">Automate Posting</div>' +
          '<div class="home-card-desc">' +
            'Tell the AI to build a pipeline that creates and queues content on a schedule. Review before it goes live.' +
          '</div>' +
        '</div>' +

        '<div class="home-card" data-tab="marketplace">' +
          '<div class="home-card-icon">&#x1f50c;</div>' +
          '<div class="home-card-title">Extensions</div>' +
          '<div class="home-card-desc">' +
            'Browse the marketplace to install tools for your specific needs — images, video, voice, social, and more.' +
          '</div>' +
        '</div>' +

      '</div>';

    main.appendChild(container);

    // Wire up card clicks
    container.querySelectorAll('.home-card[data-tab]').forEach(function (card) {
      card.addEventListener('click', function () {
        switchTab(card.dataset.tab);
      });
    });

    // Wire up hero CTA
    var ctaBtn = document.getElementById('home-cta-chat');
    if (ctaBtn) {
      ctaBtn.addEventListener('click', function () {
        switchTab('chat');
      });
    }

    // Wire up install bar
    var installInput = document.getElementById('home-install-input');
    var installBtn = document.getElementById('home-install-btn');
    var installStatus = document.getElementById('home-install-status');

    function handleInstall() {
      var raw = (installInput.value || '').trim();
      if (!raw) return;

      var gitUrl = '';
      var name = '';

      // Parse woodbury:// protocol links
      if (raw.indexOf('woodbury://') === 0) {
        try {
          var parsed = new URL(raw);
          gitUrl = parsed.searchParams.get('git') || '';
          var parts = parsed.pathname.replace(/^\//, '').split('/');
          name = parts[parts.length - 1] || '';
        } catch (e) { /* fall through */ }
      }

      // Parse GitHub URLs directly
      if (!gitUrl && raw.indexOf('https://github.com/') === 0) {
        gitUrl = raw.replace(/\.git$/, '').replace(/\/$/, '');
        name = gitUrl.split('/').pop() || '';
      }

      if (!gitUrl) {
        installStatus.textContent = 'Paste a woodbury:// link or a GitHub URL';
        installStatus.className = 'home-install-status home-install-error';
        return;
      }

      // Disable controls and show progress
      installBtn.disabled = true;
      installBtn.textContent = 'Installing\u2026';
      installStatus.textContent = 'Downloading pipeline\u2026';
      installStatus.className = 'home-install-status home-install-progress';

      fetch('/api/compositions/v2/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitUrl: gitUrl, name: name }),
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (result) {
          if (result.status >= 200 && result.status < 300 && result.data.id) {
            var msg = '\u2714 Pipeline "' + (result.data.name || name) + '" installed!';
            if (result.data.warning) {
              msg += ' \u26a0 ' + result.data.warning;
              installStatus.className = 'home-install-status home-install-warning';
            } else {
              installStatus.className = 'home-install-status home-install-success';
            }
            installStatus.textContent = msg;
            installInput.value = '';
            // Refresh stats and apps
            fetchStats();
            fetchPipelineApps();
          } else {
            installStatus.textContent = result.data.error || 'Installation failed';
            installStatus.className = 'home-install-status home-install-error';
          }
          installBtn.disabled = false;
          installBtn.textContent = 'Install';
        })
        .catch(function (err) {
          installStatus.textContent = 'Network error: ' + (err.message || err);
          installStatus.className = 'home-install-status home-install-error';
          installBtn.disabled = false;
          installBtn.textContent = 'Install';
        });
    }

    if (installBtn) {
      installBtn.addEventListener('click', handleInstall);
    }
    if (installInput) {
      installInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') handleInstall();
      });
    }

    // Fetch stats and pipeline apps
    fetchStats();
    fetchPipelineApps();

    homeInitialized = true;
  }

  function fetchStats() {
    // Extensions
    fetch('/api/extensions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var el = document.getElementById('home-stat-extensions');
        if (el && data.extensions) {
          el.textContent = data.extensions.length;
        }
      })
      .catch(function () {});

    // Workflows
    fetch('/api/workflows')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var el = document.getElementById('home-stat-workflows');
        if (el && data.workflows) {
          el.textContent = data.workflows.length;
        }
      })
      .catch(function () {});

    // Pipelines
    fetch('/api/compositions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var el = document.getElementById('home-stat-pipelines');
        if (el && data.compositions) {
          el.textContent = data.compositions.length;
        }
      })
      .catch(function () {});
  }

  function fetchPipelineApps() {
    fetch('/api/compositions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var container = document.getElementById('home-pipeline-apps');
        if (!container || !data.compositions) return;

        var appPipelines = data.compositions.filter(function (c) {
          return c.hasViews;
        });

        if (appPipelines.length === 0) return;

        var html = '<div class="home-section-title">Your Apps</div>';
        html += '<div class="home-apps-grid">';

        appPipelines.forEach(function (p) {
          var logoSrc = '';
          if (p.metadata && p.metadata.logo) {
            logoSrc = p.metadata.logo.indexOf('data:') === 0 || p.metadata.logo.indexOf('http') === 0
              ? p.metadata.logo
              : '/api/file?path=' + encodeURIComponent(p.metadata.logo);
          }

          html += '<div class="home-app-card" data-comp-id="' + (p.id || '').replace(/"/g, '&quot;') + '">';
          if (logoSrc) {
            html += '<img class="home-app-logo" src="' + logoSrc.replace(/"/g, '&quot;') + '" alt="" />';
          } else {
            html += '<div class="home-app-logo-placeholder">&#x1f3ac;</div>';
          }
          html += '<div class="home-app-info">';
          html += '<div class="home-app-name">' + (p.name || 'Untitled').replace(/</g, '&lt;') + '</div>';
          if (p.description) {
            html += '<div class="home-app-desc">' + p.description.substring(0, 80).replace(/</g, '&lt;') + '</div>';
          }
          html += '</div>';
          html += '<div class="home-app-arrow">&#x203A;</div>';
          html += '</div>';
        });

        html += '</div>';
        container.innerHTML = html;

        // Wire clicks
        container.querySelectorAll('.home-app-card').forEach(function (card) {
          card.addEventListener('click', function () {
            var compId = card.getAttribute('data-comp-id');
            if (compId && typeof switchTab === 'function') {
              switchTab('compositions');
              setTimeout(function () {
                if (typeof selectComposition === 'function') selectComposition(compId, 'app');
              }, 100);
            }
          });
        });
      })
      .catch(function () {});
  }

  window.initHome = initHome;
})();
