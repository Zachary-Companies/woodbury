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

    // Fetch stats
    fetchStats();

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

  window.initHome = initHome;
})();
