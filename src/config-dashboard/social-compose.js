/**
 * Social Scheduler Dashboard -- Compose & Settings
 *
 * Contains:
 *   - Compose view (socialRenderCompose)
 *   - Compose sub-components (socialComposePlatformToggles, socialComposeContentTabs,
 *     socialComposeMediaSection, socialComposeScheduleRadio, socialComposePreviewPanels)
 *   - Platform previews (socialPreviewInstagram, socialPreviewTwitter, socialPreviewYouTube)
 *   - Compose event wiring (socialWireComposeEvents)
 *   - Compose text helpers (socialComposeSaveCurrentText, socialComposeSaveCurrentTextFromEl)
 *   - Compose save (socialComposeSave)
 *   - Settings view (socialRenderSettings)
 *   - Script editor helpers (SCRIPT_STEP_TYPES, socialRenderScriptSteps, socialRenderSingleStep,
 *     socialWireStepEvents, socialCollectScriptSteps)
 *   - Platform editor (socialRenderPlatformEditor)
 *
 * Loaded AFTER social-core.js (depends on state variables, helpers, and API functions).
 * All functions are globals shared across files via <script> tags.
 */

// ================================================================
// -- COMPOSE VIEW (PaddyPost-style) ------------------------------
// ================================================================

function socialRenderCompose() {
  var main = document.querySelector('#main');
  var data = socialComposeData;
  if (!data) {
    data = socialInitComposeData(null);
    socialComposeData = data;
  }

  var isEditing = !!socialEditingPostId;
  var headerTitle = isEditing ? 'Edit Post' : 'New Post';

  // Build enabled platforms list
  var enabledPlatforms = data.platforms.filter(function (p) { return p.enabled; }).map(function (p) { return p.platform; });

  // Character limit for current tab
  var currentTabLimit = 0;
  var currentTabText = data.text;
  if (socialComposeTab !== 'all' && enabledPlatforms.indexOf(socialComposeTab) !== -1) {
    currentTabLimit = socialGetCharLimit(socialComposeTab);
    currentTabText = data.platformOverrides[socialComposeTab] || '';
  } else {
    // "All Platforms" -- show smallest limit of enabled platforms
    if (enabledPlatforms.length > 0) {
      var limits = enabledPlatforms.map(function (p) { return socialGetCharLimit(p); }).filter(function (l) { return l > 0; });
      currentTabLimit = limits.length > 0 ? Math.min.apply(null, limits) : 0;
    }
  }
  var charCount = currentTabText.length;
  var charClass = currentTabLimit > 0 && charCount > currentTabLimit ? 'color:#ef4444;' : 'color:#64748b;';

  // Schedule date / time values
  var schedDate = '';
  var schedTime = '';
  if (data.scheduledAt) {
    var sd = new Date(data.scheduledAt);
    schedDate = sd.toISOString().split('T')[0];
    schedTime = sd.toTimeString().slice(0, 5);
  }

  var html =
    '<div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">' +

    // -- Header bar --
    '<div style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid #1e293b;flex-shrink:0;">' +
    '<button class="sd-back-btn" id="social-compose-back">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div style="flex:1;font-size:1.1rem;font-weight:600;color:#fff;">' + headerTitle + '</div>' +
    '<button class="sd-btn" id="social-compose-cancel" style="background:transparent;border:1px solid #334155;color:#94a3b8;">Cancel</button>' +
    '<button class="sd-btn sd-btn-primary" id="social-compose-save">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>' +
    (isEditing ? 'Update' : 'Save') + '</button>' +
    '</div>' +

    // -- Two-column layout --
    '<div style="display:flex;flex:1;overflow:hidden;">' +

    // ==== LEFT COLUMN -- Editor (60%) ====
    '<div style="flex:0 0 60%;display:flex;flex-direction:column;overflow-y:auto;border-right:1px solid #1e293b;padding:20px;">' +

    // -- Platform Selection Row --
    '<div style="margin-bottom:20px;">' +
    '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:8px;font-weight:600;">Platforms</label>' +
    '<div style="display:flex;gap:10px;" id="social-compose-platforms">' +
    socialComposePlatformToggles(data) +
    '</div>' +
    '</div>' +

    // -- Content Tabs --
    '<div style="margin-bottom:4px;">' +
    '<div style="display:flex;gap:0;border-bottom:1px solid #1e293b;" id="social-compose-tabs">' +
    socialComposeContentTabs(data, enabledPlatforms) +
    '</div>' +
    '</div>' +

    // -- Textarea --
    '<div style="position:relative;margin-bottom:16px;">' +
    '<textarea id="social-compose-text" style="' +
    'width:100%;min-height:160px;resize:vertical;' +
    'background:#0a0f1a;border:1px solid #1e293b;border-radius:8px;' +
    'padding:14px;font-size:0.9rem;line-height:1.5;color:#e2e8f0;' +
    'font-family:inherit;outline:none;transition:border-color 0.2s;' +
    '" placeholder="What do you want to share?">' + socialEsc(currentTabText) + '</textarea>' +
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">' +
    '<span style="font-size:0.75rem;' + charClass + '">' +
    charCount + (currentTabLimit > 0 ? ' / ' + currentTabLimit : '') +
    '</span>' +
    '</div>' +
    '</div>' +

    // -- Media Section --
    '<div style="margin-bottom:16px;">' +
    '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:8px;font-weight:600;">Media</label>' +
    socialComposeMediaSection(data) +
    '</div>' +

    // -- Tags Input --
    '<div style="margin-bottom:16px;">' +
    '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:8px;font-weight:600;">Tags</label>' +
    '<div id="social-compose-tags-container" style="' +
    'display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;min-height:38px;' +
    'background:#0a0f1a;border:1px solid #1e293b;border-radius:8px;align-items:center;' +
    'cursor:text;transition:border-color 0.2s;' +
    '">' +
    data.tags.map(function (tag, i) {
      return '<span class="social-compose-tag" data-tag-index="' + i + '" style="' +
        'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;' +
        'background:#7c3aed22;border:1px solid #7c3aed44;border-radius:12px;' +
        'font-size:0.8rem;color:#c4b5fd;white-space:nowrap;' +
        '">' +
        socialEsc(tag) +
        '<span class="social-compose-tag-remove" data-tag-remove="' + i + '" style="cursor:pointer;color:#a78bfa;font-weight:bold;line-height:1;">&times;</span>' +
        '</span>';
    }).join('') +
    '<input type="text" id="social-compose-tag-input" placeholder="' + (data.tags.length === 0 ? 'Type a tag and press Enter...' : '') + '" style="' +
    'flex:1;min-width:80px;background:transparent;border:none;outline:none;' +
    'color:#e2e8f0;font-size:0.8rem;padding:2px 0;' +
    '" />' +
    '</div>' +
    '</div>' +

    // -- Schedule Section --
    '<div style="margin-bottom:20px;">' +
    '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:8px;font-weight:600;">Schedule</label>' +
    '<div style="display:flex;gap:8px;margin-bottom:12px;" id="social-compose-schedule-mode">' +
    socialComposeScheduleRadio('draft', 'Save as Draft', data.scheduleMode) +
    socialComposeScheduleRadio('schedule', 'Schedule', data.scheduleMode) +
    socialComposeScheduleRadio('now', 'Post Now', data.scheduleMode) +
    '</div>' +
    '<div id="social-compose-schedule-fields" style="display:' + (data.scheduleMode === 'schedule' ? 'flex' : 'none') + ';gap:12px;align-items:flex-end;">' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Date</label>' +
    '<input type="date" id="social-compose-sched-date" class="sd-input" value="' + schedDate + '" style="width:100%;" />' +
    '</div>' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Time</label>' +
    '<input type="time" id="social-compose-sched-time" class="sd-input" value="' + schedTime + '" style="width:100%;" />' +
    '</div>' +
    '<div style="font-size:0.75rem;color:#64748b;padding-bottom:8px;">' +
    socialEsc((socialConfig && socialConfig.defaultTimezone) || 'Local') +
    '</div>' +
    '</div>' +
    '</div>' +

    '</div>' + // end left column

    // ==== RIGHT COLUMN -- Preview (40%) ====
    '<div style="flex:0 0 40%;overflow-y:auto;padding:20px;background:#0a0f1a;">' +
    '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:12px;font-weight:600;">Preview</label>' +
    socialComposePreviewPanels(data) +
    '</div>' + // end right column

    '</div>' + // end two-column
    '</div>'; // end container

  main.innerHTML = html;
  socialWireComposeEvents();
}

function socialComposePlatformToggles(data) {
  var defaultColors = {
    instagram: { active: '#e1306c', border: '#f472b6' },
    twitter: { active: '#1d9bf0', border: '#60a5fa' },
    youtube: { active: '#ff0000', border: '#f87171' },
  };
  var defaultIcons = { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' };

  var platforms = socialPlatforms.length > 0
    ? socialPlatforms
    : [
        { platform: 'instagram', displayName: 'Instagram' },
        { platform: 'twitter', displayName: 'Twitter' },
        { platform: 'youtube', displayName: 'YouTube' },
      ];

  return platforms.map(function (connector) {
    var p = connector.platform;
    var platData = data.platforms.find(function (x) { return x.platform === p; });
    var isEnabled = platData && platData.enabled;
    var colors = defaultColors[p] || { active: connector.color || '#7c3aed', border: connector.color || '#a78bfa' };
    var icon = connector.icon || defaultIcons[p] || '\ud83c\udf10';
    var label = connector.displayName || p;
    var activeStyle = isEnabled
      ? 'border-color:' + colors.border + ';background:' + colors.active + '12;'
      : '';
    var checkMark = isEnabled
      ? '<span style="position:absolute;top:4px;right:6px;font-size:0.65rem;color:' + colors.border + ';">\u2713</span>'
      : '';

    return '<label class="sd-platform-toggle' + (isEnabled ? ' sd-platform-toggle-active' : '') + '" data-platform="' + p + '" style="' +
      'position:relative;flex:1;display:flex;flex-direction:column;align-items:center;' +
      'padding:12px 8px;cursor:pointer;' + activeStyle + '">' +
      '<input type="checkbox" class="social-compose-plat-cb" value="' + p + '"' + (isEnabled ? ' checked' : '') + ' style="display:none;" />' +
      '<span style="font-size:1.4rem;margin-bottom:4px;">' + icon + '</span>' +
      '<span style="font-size:0.75rem;color:' + (isEnabled ? '#e2e8f0' : '#64748b') + ';">' + label + '</span>' +
      checkMark +
      '</label>';
  }).join('');
}

function socialComposeContentTabs(data, enabledPlatforms) {
  var tabs = [{ id: 'all', label: 'All Platforms' }];
  enabledPlatforms.forEach(function (p) {
    var connector = socialPlatforms.find(function (c) { return c.platform === p; });
    var label = (connector && connector.displayName) || p.charAt(0).toUpperCase() + p.slice(1);
    tabs.push({ id: p, label: label });
  });

  return tabs.map(function (tab) {
    var isActive = socialComposeTab === tab.id;
    var hasOverride = tab.id !== 'all' && data.platformOverrides[tab.id];
    return '<button class="social-compose-tab-btn" data-compose-tab="' + tab.id + '" style="' +
      'padding:8px 14px;font-size:0.8rem;border:none;background:transparent;cursor:pointer;' +
      'color:' + (isActive ? '#c4b5fd' : '#64748b') + ';' +
      'border-bottom:2px solid ' + (isActive ? '#7c3aed' : 'transparent') + ';' +
      'transition:all 0.15s;font-weight:' + (isActive ? '600' : '400') + ';' +
      'white-space:nowrap;position:relative;' +
      '">' +
      tab.label +
      (hasOverride ? '<span style="position:absolute;top:4px;right:2px;width:5px;height:5px;background:#a78bfa;border-radius:50%;"></span>' : '') +
      '</button>';
  }).join('');
}

function socialComposeMediaSection(data) {
  var html = '';

  // Attached images preview
  if (data.images && data.images.length > 0) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">';
    data.images.forEach(function (img, i) {
      var src = typeof img === 'string' ? img : (img.url || img.path || '');
      var name = typeof img === 'string' ? img.split('/').pop() : (img.name || 'Image');
      html += '<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid #1e293b;background:#0f172a;">' +
        '<img src="' + socialEsc(src) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'" />' +
        '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">' +
        '<span style="font-size:0.6rem;color:#64748b;text-align:center;padding:4px;word-break:break-all;">' + socialEsc(name) + '</span>' +
        '</div>' +
        '<button class="social-compose-remove-img" data-img-index="' + i + '" style="' +
        'position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;' +
        'background:#0f172acc;border:1px solid #33415580;color:#f87171;font-size:0.7rem;' +
        'cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;' +
        '">&times;</button>' +
        '</div>';
    });
    html += '</div>';
  }

  // Attach button
  html += '<button id="social-compose-attach-btn" style="' +
    'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;' +
    'background:#1e293b;border:1px dashed #334155;border-radius:8px;' +
    'color:#94a3b8;font-size:0.8rem;cursor:pointer;transition:all 0.15s;' +
    '">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M14 10v2.7c0 .7-.6 1.3-1.3 1.3H3.3C2.6 14 2 13.4 2 12.7V10M11.3 5.3L8 2 4.7 5.3M8 2v8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    'Attach Media' +
    '</button>';

  // Asset picker (inline, only if open)
  if (socialAssetPickerOpen) {
    html += '<div id="social-compose-asset-picker" style="' +
      'margin-top:10px;padding:12px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;' +
      'max-height:240px;overflow-y:auto;' +
      '">';
    if (socialAssetCache === null) {
      html += '<div style="text-align:center;color:#64748b;font-size:0.8rem;padding:20px;">Loading assets...</div>';
    } else if (socialAssetCache.length === 0) {
      html += '<div style="text-align:center;color:#64748b;font-size:0.8rem;padding:20px;">No images found. Upload images via the Assets page.</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;">';
      socialAssetCache.forEach(function (asset, i) {
        var url = asset.id ? ('/api/assets/file/' + encodeURIComponent(asset.id)) : (asset.url || asset.path || '');
        var name = asset.name || asset.filename || 'image';
        html += '<div class="social-compose-asset-item" data-asset-index="' + i + '" style="' +
          'width:72px;height:72px;border-radius:6px;overflow:hidden;cursor:pointer;' +
          'border:1px solid #1e293b;background:#0a0f1a;transition:border-color 0.15s;' +
          'position:relative;' +
          '">' +
          '<img src="' + socialEsc(url) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'" />' +
          '<div style="position:absolute;bottom:0;left:0;right:0;padding:2px 4px;background:linear-gradient(transparent,#0a0f1acc);font-size:0.55rem;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          socialEsc(name) + '</div>' +
          '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  return html;
}

function socialComposeScheduleRadio(value, label, current) {
  var isActive = current === value;
  return '<button class="social-compose-sched-radio' + (isActive ? ' active' : '') + '" data-sched-mode="' + value + '" style="' +
    'flex:1;padding:10px 14px;border-radius:8px;font-size:0.82rem;cursor:pointer;' +
    'border:1px solid ' + (isActive ? '#7c3aed' : '#334155') + ';' +
    'background:' + (isActive ? 'linear-gradient(135deg, #7c3aed22, #7c3aed10)' : '#1e293b') + ';' +
    'color:' + (isActive ? '#c4b5fd' : '#94a3b8') + ';' +
    'transition:all 0.15s;font-weight:' + (isActive ? '600' : '500') + ';' +
    'text-align:center;letter-spacing:0.01em;' +
    '">' + label + '</button>';
}

// -- Compose Preview Panels ---------------------------------------

function socialComposePreviewPanels(data) {
  var enabledPlatforms = data.platforms.filter(function (p) { return p.enabled; }).map(function (p) { return p.platform; });
  if (enabledPlatforms.length === 0) {
    return '<div style="text-align:center;color:#475569;font-size:0.85rem;padding:40px 20px;">' +
      'Select at least one platform to see a preview.' +
      '</div>';
  }

  var html = '';
  enabledPlatforms.forEach(function (platform) {
    var text = data.platformOverrides[platform] || data.text || '';
    var hasImages = data.images && data.images.length > 0;
    var firstImage = hasImages ? (typeof data.images[0] === 'string' ? data.images[0] : (data.images[0].url || '')) : '';

    if (platform === 'instagram') {
      html += socialPreviewInstagram(text, firstImage, hasImages);
    } else if (platform === 'twitter') {
      html += socialPreviewTwitter(text, firstImage, hasImages);
    } else if (platform === 'youtube') {
      html += socialPreviewYouTube(text, firstImage, hasImages);
    } else {
      // Generic preview card for custom/dynamic platforms
      var connector = socialPlatforms.find(function (c) { return c.platform === platform; });
      var icon = (connector && connector.icon) || '\ud83c\udf10';
      var displayName = (connector && connector.displayName) || platform;
      var color = (connector && connector.color) || '#7c3aed';
      var previewText = socialEsc(text);

      html += '<div style="border:1px solid #1e293b;border-radius:12px;overflow:hidden;margin-bottom:16px;">' +
        '<div style="background:' + color + '22;padding:6px 12px;font-size:0.7rem;font-weight:600;color:' + color + ';">' +
        icon + ' ' + socialEsc(displayName).toUpperCase() + '</div>' +
        '<div style="padding:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + color + '33;display:flex;align-items:center;justify-content:center;font-size:0.9rem;">' + icon + '</div>' +
        '<div style="font-size:0.85rem;font-weight:600;color:#e2e8f0;">Your Brand</div>' +
        '</div>' +
        '<div style="font-size:0.85rem;color:#cbd5e1;line-height:1.5;">' +
        (previewText || '<span style="color:#475569;">Your content will appear here...</span>') +
        '</div>' +
        '</div>' +
        '</div>';
    }
  });
  return html;
}

function socialPreviewInstagram(text, imageUrl, hasImage) {
  var truncated = text.length > 125 ? text.slice(0, 125) + '... more' : text;
  var imageArea = hasImage && imageUrl
    ? '<img src="' + socialEsc(imageUrl) + '" style="width:100%;aspect-ratio:1;object-fit:cover;background:#1e293b;" onerror="this.outerHTML=\'<div style=\\\'width:100%;aspect-ratio:1;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.8rem;\\\'>Image preview</div>\'" />'
    : '<div style="width:100%;aspect-ratio:1;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.8rem;">' +
      (hasImage ? 'Image preview' : 'No image attached') +
      '</div>';

  return '<div style="margin-bottom:16px;background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;">' +
    // Header badge
    '<div style="display:flex;align-items:center;gap:4px;padding:6px 10px;background:#e1306c15;border-bottom:1px solid #1e293b;">' +
    '<span style="font-size:0.65rem;color:#f472b6;font-weight:600;">\ud83d\udcf7 INSTAGRAM</span>' +
    '</div>' +
    // Profile row
    '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">' +
    '<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#e1306c,#f77737);display:flex;align-items:center;justify-content:center;">' +
    '<span style="font-size:0.7rem;color:#fff;font-weight:700;">P</span>' +
    '</div>' +
    '<span style="font-size:0.8rem;font-weight:600;color:#e2e8f0;">Your Brand</span>' +
    '</div>' +
    // Image
    imageArea +
    // Caption
    '<div style="padding:10px 12px;">' +
    '<div style="font-size:0.8rem;line-height:1.45;color:#cbd5e1;">' +
    '<span style="font-weight:600;color:#e2e8f0;">Your Brand</span> ' +
    socialEsc(truncated || 'Your caption will appear here...') +
    '</div>' +
    '</div>' +
    '</div>';
}

function socialPreviewTwitter(text, imageUrl, hasImage) {
  var truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;
  var imageHtml = '';
  if (hasImage && imageUrl) {
    imageHtml = '<img src="' + socialEsc(imageUrl) + '" style="width:100%;border-radius:12px;margin-top:8px;max-height:180px;object-fit:cover;border:1px solid #1e293b;" onerror="this.style.display=\'none\'" />';
  } else if (hasImage) {
    imageHtml = '<div style="width:100%;height:120px;background:#1e293b;border-radius:12px;margin-top:8px;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.75rem;">Image preview</div>';
  }

  return '<div style="margin-bottom:16px;background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;">' +
    // Header badge
    '<div style="display:flex;align-items:center;gap:4px;padding:6px 10px;background:#1d9bf015;border-bottom:1px solid #1e293b;">' +
    '<span style="font-size:0.65rem;color:#60a5fa;font-weight:600;">\ud83d\udc26 TWITTER</span>' +
    '</div>' +
    // Tweet body
    '<div style="padding:12px;">' +
    '<div style="display:flex;gap:10px;">' +
    // Avatar
    '<div style="width:36px;height:36px;border-radius:50%;background:#1d9bf0;flex-shrink:0;display:flex;align-items:center;justify-content:center;">' +
    '<span style="font-size:0.85rem;color:#fff;font-weight:700;">P</span>' +
    '</div>' +
    '<div style="flex:1;min-width:0;">' +
    // Name row
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">' +
    '<span style="font-size:0.85rem;font-weight:700;color:#e2e8f0;">Your Brand</span>' +
    '<span style="font-size:0.75rem;color:#64748b;">@yourbrand</span>' +
    '</div>' +
    // Text
    '<div style="font-size:0.85rem;line-height:1.4;color:#cbd5e1;word-wrap:break-word;">' +
    socialEsc(truncated || 'Your tweet will appear here...') +
    '</div>' +
    imageHtml +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>';
}

function socialPreviewYouTube(text, imageUrl, hasImage) {
  var lines = text.split('\n');
  var title = lines[0] || '';
  var desc = lines.slice(1).join('\n').trim();
  var truncDesc = desc.length > 120 ? desc.slice(0, 120) + '...' : desc;

  var thumbHtml = hasImage && imageUrl
    ? '<img src="' + socialEsc(imageUrl) + '" style="width:100%;aspect-ratio:16/9;object-fit:cover;background:#1e293b;" onerror="this.outerHTML=\'<div style=\\\'width:100%;aspect-ratio:16/9;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.8rem;\\\'>Thumbnail</div>\'" />'
    : '<div style="width:100%;aspect-ratio:16/9;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.8rem;">Thumbnail</div>';

  return '<div style="margin-bottom:16px;background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;">' +
    // Header badge
    '<div style="display:flex;align-items:center;gap:4px;padding:6px 10px;background:#ff000012;border-bottom:1px solid #1e293b;">' +
    '<span style="font-size:0.65rem;color:#f87171;font-weight:600;">\u25b6\ufe0f YOUTUBE</span>' +
    '</div>' +
    // Thumbnail
    thumbHtml +
    // Info
    '<div style="padding:10px 12px;">' +
    '<div style="font-size:0.85rem;font-weight:600;color:#e2e8f0;margin-bottom:4px;line-height:1.3;">' +
    socialEsc(title || 'Video title will appear here...') +
    '</div>' +
    '<div style="font-size:0.75rem;color:#64748b;margin-bottom:4px;">Your Brand &middot; 0 views</div>' +
    '<div style="font-size:0.75rem;color:#94a3b8;line-height:1.35;">' +
    socialEsc(truncDesc || 'Video description...') +
    '</div>' +
    '</div>' +
    '</div>';
}

// -- Wire Compose Events ------------------------------------------

function socialWireComposeEvents() {
  var main = document.querySelector('#main');

  // Back button
  main.querySelector('#social-compose-back').addEventListener('click', function () {
    socialComposeData = null;
    socialEditingPostId = null;
    socialView = 'overview';
    socialRenderOverview();
    socialRenderSidebar();
  });

  // Cancel
  main.querySelector('#social-compose-cancel').addEventListener('click', function () {
    socialComposeData = null;
    socialEditingPostId = null;
    socialView = 'overview';
    socialRenderOverview();
    socialRenderSidebar();
  });

  // Platform toggles
  main.querySelectorAll('.social-compose-plat-cb').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var plat = cb.value;
      var platData = socialComposeData.platforms.find(function (p) { return p.platform === plat; });
      if (platData) platData.enabled = cb.checked;
      // If current tab was for a now-disabled platform, switch to 'all'
      if (!cb.checked && socialComposeTab === plat) {
        socialComposeTab = 'all';
      }
      socialRenderCompose();
    });
  });

  // Content tabs
  main.querySelectorAll('.social-compose-tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // Save current text before switching
      socialComposeSaveCurrentText();
      socialComposeTab = btn.dataset.composeTab;
      socialRenderCompose();
    });
  });

  // Textarea -- live update for preview
  var textarea = main.querySelector('#social-compose-text');
  if (textarea) {
    textarea.addEventListener('input', function () {
      socialComposeSaveCurrentTextFromEl(textarea);
      // Re-render just the preview (right column) and char counter
      var rightCol = main.querySelector('[style*="flex:0 0 40%"]');
      if (rightCol) {
        rightCol.innerHTML =
          '<label style="display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:12px;font-weight:600;">Preview</label>' +
          socialComposePreviewPanels(socialComposeData);
      }
      // Update char counter
      var text = textarea.value;
      var enabledPlatforms = socialComposeData.platforms.filter(function (p) { return p.enabled; }).map(function (p) { return p.platform; });
      var limit = 0;
      if (socialComposeTab !== 'all' && enabledPlatforms.indexOf(socialComposeTab) !== -1) {
        limit = socialGetCharLimit(socialComposeTab);
      } else if (enabledPlatforms.length > 0) {
        var limits = enabledPlatforms.map(function (p) { return socialGetCharLimit(p); }).filter(function (l) { return l > 0; });
        limit = limits.length > 0 ? Math.min.apply(null, limits) : 0;
      }
      var counterEl = textarea.parentElement.querySelector('span');
      if (counterEl) {
        counterEl.style.color = (limit > 0 && text.length > limit) ? '#ef4444' : '#64748b';
        counterEl.textContent = text.length + (limit > 0 ? ' / ' + limit : '');
      }
    });
    // Focus textarea
    textarea.focus();
    // Position cursor at end
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }

  // Tags input
  var tagInput = main.querySelector('#social-compose-tag-input');
  if (tagInput) {
    tagInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && tagInput.value.trim()) {
        e.preventDefault();
        socialComposeData.tags.push(tagInput.value.trim());
        socialRenderCompose();
      } else if (e.key === 'Backspace' && !tagInput.value && socialComposeData.tags.length > 0) {
        socialComposeData.tags.pop();
        socialRenderCompose();
      }
    });
  }
  // Tag container click focuses input
  var tagContainer = main.querySelector('#social-compose-tags-container');
  if (tagContainer) {
    tagContainer.addEventListener('click', function (e) {
      if (e.target === tagContainer) tagInput.focus();
    });
  }
  // Tag remove buttons
  main.querySelectorAll('[data-tag-remove]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var idx = parseInt(btn.dataset.tagRemove, 10);
      socialComposeData.tags.splice(idx, 1);
      socialRenderCompose();
    });
  });

  // Schedule mode radio buttons
  main.querySelectorAll('.social-compose-sched-radio').forEach(function (btn) {
    btn.addEventListener('click', function () {
      socialComposeData.scheduleMode = btn.dataset.schedMode;
      socialRenderCompose();
    });
  });

  // Attach media button
  var attachBtn = main.querySelector('#social-compose-attach-btn');
  if (attachBtn) {
    attachBtn.addEventListener('click', function () {
      socialAssetPickerOpen = !socialAssetPickerOpen;
      if (socialAssetPickerOpen && socialAssetCache === null) {
        // Fetch assets
        socialFetchAssets().then(function (assets) {
          socialAssetCache = Array.isArray(assets) ? assets : (assets.assets || []);
          socialRenderCompose();
        }).catch(function () {
          socialAssetCache = [];
          socialRenderCompose();
        });
      }
      socialRenderCompose();
    });
  }

  // Asset picker items
  main.querySelectorAll('.social-compose-asset-item').forEach(function (item) {
    item.addEventListener('click', function () {
      var idx = parseInt(item.dataset.assetIndex, 10);
      if (socialAssetCache && socialAssetCache[idx]) {
        var asset = socialAssetCache[idx];
        var url = asset.id ? ('/api/assets/file/' + encodeURIComponent(asset.id)) : (asset.url || asset.path || '');
        if (url) {
          socialComposeData.images.push({
            url: url,
            name: asset.name || asset.filename || 'image',
            assetId: asset.id || '',
            absolutePath: asset.file_path_absolute || '',
          });
          socialAssetPickerOpen = false;
          socialRenderCompose();
        }
      }
    });
  });

  // Remove image buttons
  main.querySelectorAll('.social-compose-remove-img').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var idx = parseInt(btn.dataset.imgIndex, 10);
      socialComposeData.images.splice(idx, 1);
      socialRenderCompose();
    });
  });

  // Save / Update button
  main.querySelector('#social-compose-save').addEventListener('click', async function () {
    await socialComposeSave();
  });
}

function socialComposeSaveCurrentText() {
  var textarea = document.querySelector('#social-compose-text');
  if (!textarea || !socialComposeData) return;
  socialComposeSaveCurrentTextFromEl(textarea);
}

function socialComposeSaveCurrentTextFromEl(textarea) {
  if (!socialComposeData) return;
  var val = textarea.value;
  if (socialComposeTab === 'all') {
    socialComposeData.text = val;
  } else {
    socialComposeData.platformOverrides[socialComposeTab] = val;
  }
}

async function socialComposeSave() {
  // Save current text first
  socialComposeSaveCurrentText();
  var data = socialComposeData;
  if (!data) return;

  // Validate
  var enabledPlatforms = data.platforms.filter(function (p) { return p.enabled; });
  if (enabledPlatforms.length === 0) {
    if (typeof toast === 'function') toast('Select at least one platform', 'error');
    return;
  }
  if (!data.text && Object.keys(data.platformOverrides).length === 0) {
    if (typeof toast === 'function') toast('Post text is required', 'error');
    return;
  }

  // Build platform overrides for API
  var platformOverrides = {};
  for (var key in data.platformOverrides) {
    if (data.platformOverrides[key]) {
      platformOverrides[key] = { text: data.platformOverrides[key] };
    }
  }

  // Build scheduledAt
  var scheduledAt = null;
  var status = 'draft';
  if (data.scheduleMode === 'schedule') {
    var dateEl = document.querySelector('#social-compose-sched-date');
    var timeEl = document.querySelector('#social-compose-sched-time');
    if (dateEl && dateEl.value) {
      scheduledAt = new Date(dateEl.value + 'T' + (timeEl ? timeEl.value || '12:00' : '12:00') + ':00').toISOString();
      status = 'scheduled';
    } else {
      if (typeof toast === 'function') toast('Set a date to schedule', 'error');
      return;
    }
  } else if (data.scheduleMode === 'now') {
    scheduledAt = new Date().toISOString();
    status = 'scheduled';
  }

  // Build platforms array
  var platforms = data.platforms.map(function (p) {
    return { platform: p.platform, enabled: p.enabled, status: 'pending', retryCount: 0 };
  });

  var postData = {
    text: data.text,
    content: {
      text: data.text,
      images: data.images.map(function (img) { return typeof img === 'string' ? img : (img.url || img.path || ''); }),
      platformOverrides: platformOverrides,
    },
    platforms: enabledPlatforms.map(function (p) { return p.platform; }),
    scheduledAt: scheduledAt,
    tags: data.tags,
    status: status,
  };

  try {
    var savedPost;
    if (socialEditingPostId) {
      savedPost = await socialUpdatePost(socialEditingPostId, postData);
      if (typeof toast === 'function') toast('Post updated!', 'success');
    } else {
      savedPost = await socialCreatePost(postData);
      if (typeof toast === 'function') toast('Post created!', 'success');
    }
    socialComposeData = null;
    socialEditingPostId = null;
    socialSelectedPost = savedPost;
    socialView = 'detail';
    await socialRefresh();
    socialRenderDetail();
    socialRenderSidebar();
  } catch (err) {
    if (typeof toast === 'function') toast('Save failed: ' + err, 'error');
  }
}

// -- Settings -----------------------------------------------------

async function socialRenderSettings() {
  var main = document.querySelector('#main');
  main.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto 16px;"></div><h2>Loading settings...</h2></div>';

  try {
    socialConfig = await socialFetchConfig();
    socialPlatforms = await socialFetchPlatforms();
  } catch (err) {
    main.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\u26a0\ufe0f</div><h2>Failed to load settings</h2><p>' + socialEsc(String(err)) + '</p></div>';
    return;
  }

  var cfg = socialConfig;

  // Build platform cards
  var platformCardsHtml = '';
  socialPlatforms.forEach(function (connector) {
    var icon = connector.icon || { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' }[connector.platform] || '\ud83c\udf10';
    var color = connector.color || { instagram: '#e1306c', twitter: '#1d9bf0', youtube: '#ff0000' }[connector.platform] || '#7c3aed';
    var displayName = connector.displayName || connector.platform;
    var caps = connector.capabilities || {};
    var capBadges = '';
    if (caps.text) capBadges += '<span style="padding:2px 6px;border-radius:4px;background:#22c55e22;color:#4ade80;font-size:0.65rem;">Text</span>';
    if (caps.images) capBadges += '<span style="padding:2px 6px;border-radius:4px;background:#3b82f622;color:#60a5fa;font-size:0.65rem;">Images</span>';
    if (caps.video) capBadges += '<span style="padding:2px 6px;border-radius:4px;background:#f59e0b22;color:#fbbf24;font-size:0.65rem;">Video</span>';
    var maxText = connector.maxTextLength ? (connector.maxTextLength + ' chars') : '\u2014';
    var method = connector.compositionId ? '\ud83d\udd17 Pipeline' : '\ud83e\udd16 Script';

    platformCardsHtml +=
      '<div class="social-platform-card" style="' +
      'display:flex;align-items:center;gap:14px;padding:14px 16px;' +
      'background:#0f172a;border:1px solid #1e293b;border-radius:10px;' +
      'border-left:3px solid ' + color + ';">' +
      '<div style="font-size:1.6rem;width:40px;text-align:center;">' + icon + '</div>' +
      '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:0.95rem;font-weight:600;color:#e2e8f0;">' + socialEsc(displayName) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">' + capBadges + '</div>' +
      '</div>' +
      '<div style="text-align:right;font-size:0.75rem;color:#64748b;">' +
      '<div>' + maxText + '</div>' +
      '<div style="margin-top:2px;">' + method + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;">' +
      '<button class="social-queue-edit-btn social-plat-edit-btn" data-platform="' + connector.platform + '">Edit</button>' +
      '<button class="social-queue-delete-btn social-plat-delete-btn" data-platform="' + connector.platform + '">\u00d7</button>' +
      '</div>' +
      '</div>';
  });

  // Timezone options
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

  // Default platform checkboxes (now dynamic)
  var defPlats = cfg.defaultPlatforms || [];

  var html =
    '<div class="sd-container">' +

    // Header
    '<div class="sd-header">' +
    '<button class="sd-back-btn" id="social-settings-back">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div class="sd-header-title">Settings</div>' +
    '</div>' +

    // -- Platform Management Section --
    '<div class="sd-card col-12" style="margin-bottom:20px;">' +
    '<div class="sd-card-header" style="display:flex;align-items:center;justify-content:space-between;">' +
    '<div style="display:flex;align-items:center;gap:8px;">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '<span>Platforms</span>' +
    '</div>' +
    '<button class="sd-btn sd-btn-primary" id="social-add-platform-btn" style="padding:4px 12px;font-size:0.75rem;">+ Add Platform</button>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;" id="social-platform-list">' +
    (platformCardsHtml || '<div style="text-align:center;padding:24px;color:#475569;font-size:0.85rem;">No platforms configured. Click "+ Add Platform" to get started.</div>') +
    '</div>' +
    '</div>' +

    // -- Grid of other settings --
    '<div class="grid-12">' +

    // Timezone
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 3.5V8l3 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Default Timezone</span></div>' +
    '<select id="social-cfg-tz" class="sd-input" style="width:100%;">' + tzOptions + '</select>' +
    '</div>' +

    // Default Platforms (now dynamic)
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/></svg><span>Default Platforms</span></div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
    socialPlatforms.map(function (c) {
      var checked = defPlats.indexOf(c.platform) !== -1 ? ' checked' : '';
      var icon = c.icon || { instagram: '\ud83d\udcf7', twitter: '\ud83d\udc26', youtube: '\u25b6\ufe0f' }[c.platform] || '\ud83c\udf10';
      return '<label style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:#1e293b;border:1px solid #334155;border-radius:8px;cursor:pointer;font-size:0.85rem;color:#e2e8f0;">' +
        '<input type="checkbox" class="social-cfg-plat" value="' + c.platform + '"' + checked + '>' +
        icon + ' ' + socialEsc(c.displayName || c.platform) +
        '</label>';
    }).join('') +
    '</div>' +
    '</div>' +

    // LLM
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5h12M2 8h8M2 11.5h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span>AI Text Generation</span></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div class="sd-field"><label class="sd-label">Text Provider</label><input type="text" id="social-cfg-text-provider" class="sd-input" value="' + socialEsc((cfg.llm || {}).textProvider || '') + '" placeholder="anthropic" /></div>' +
    '<div class="sd-field"><label class="sd-label">Text Model</label><input type="text" id="social-cfg-text-model" class="sd-input" value="' + socialEsc((cfg.llm || {}).textModel || '') + '" placeholder="claude-opus-4-5-20251101" /></div>' +
    '</div>' +
    '</div>' +

    // Posting Behavior
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 112 8a6 6 0 0112 0z" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.7V8l2.7 1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span>Posting Behavior</span></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
    '<div class="sd-field"><label class="sd-label">Delay Between Platforms (ms)</label><input type="number" id="social-cfg-delay" class="sd-input" value="' + ((cfg.posting || {}).delayBetweenPlatforms || 5000) + '" /></div>' +
    '<div class="sd-field"><label class="sd-label">Retry Limit</label><input type="number" id="social-cfg-retry-limit" class="sd-input" value="' + ((cfg.posting || {}).retryLimit || 2) + '" /></div>' +
    '<div class="sd-field"><label class="sd-label">Retry Delay (ms)</label><input type="number" id="social-cfg-retry-delay" class="sd-input" value="' + ((cfg.posting || {}).retryDelay || 10000) + '" /></div>' +
    '</div>' +
    '</div>' +

    '</div>' +

    // Save button
    '<div class="sd-actions">' +
    '<button class="sd-btn sd-btn-primary" id="social-cfg-save"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>Save Settings</button>' +
    '</div>' +

    '</div>';

  main.innerHTML = html;

  // Wire back button
  main.querySelector('#social-settings-back').addEventListener('click', function () {
    socialView = 'overview';
    socialRenderCurrentView();
    socialRenderSidebar();
  });

  // Wire add platform button
  main.querySelector('#social-add-platform-btn').addEventListener('click', function () {
    socialRenderPlatformEditor(null);
  });

  // Wire platform edit buttons
  main.querySelectorAll('.social-plat-edit-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var platform = btn.dataset.platform;
      var connector = socialPlatforms.find(function (c) { return c.platform === platform; });
      socialRenderPlatformEditor(connector);
    });
  });

  // Wire platform delete buttons
  main.querySelectorAll('.social-plat-delete-btn').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var platform = btn.dataset.platform;
      var connector = socialPlatforms.find(function (c) { return c.platform === platform; });
      var displayName = (connector && connector.displayName) || platform;
      if (!confirm('Delete platform "' + displayName + '"? This will remove the connector and its posting script.')) return;
      try {
        var res = await fetch('/api/social/platforms/' + encodeURIComponent(platform), { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');
        if (typeof toast === 'function') toast('Platform "' + displayName + '" deleted', 'success');
        socialRenderSettings();
      } catch (err) {
        if (typeof toast === 'function') toast('Delete failed: ' + err, 'error');
      }
    });
  });

  // Wire config save
  main.querySelector('#social-cfg-save').addEventListener('click', async function () {
    var btn = main.querySelector('#social-cfg-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';

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
    } catch (err) {
      if (typeof toast === 'function') toast('Save failed: ' + err, 'error');
    }
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M12.7 1.3H3.3c-1.1 0-2 .9-2 2v9.4c0 1.1.9 2 2 2h9.4c1.1 0 2-.9 2-2V3.3c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.2"/><path d="M11.3 14.7V9.3H4.7v5.4M4.7 1.3v4h5.3" stroke="currentColor" stroke-width="1.2"/></svg>Save Settings';
  });
}

// -- Script Editor Helpers ----------------------------------------

var SCRIPT_STEP_TYPES = [
  { value: 'navigate', label: 'Navigate', icon: '\ud83c\udf10' },
  { value: 'bridge', label: 'Find & Click', icon: '\ud83d\udd0d' },
  { value: 'wait', label: 'Wait', icon: '\u23f3' },
  { value: 'checkpoint', label: 'Checkpoint', icon: '\u2705' },
  { value: 'file_dialog', label: 'File Dialog', icon: '\ud83d\udcc1' },
  { value: 'keyboard_type', label: 'Keyboard Type', icon: '\u2328\ufe0f' },
  { value: 'keyboard_select_all', label: 'Select All', icon: '\ud83d\udccb' },
];

function socialRenderScriptSteps(script) {
  if (!script || !script.steps || script.steps.length === 0) {
    return '<div style="text-align:center;padding:16px;color:#475569;font-size:0.8rem;border:1px dashed #334155;border-radius:8px;">No steps yet. Click "+ Add Step" to start building your script.</div>';
  }
  return script.steps.map(function (step, i) {
    return socialRenderSingleStep(step, i);
  }).join('');
}

function socialRenderSingleStep(step, index) {
  var typeInfo = SCRIPT_STEP_TYPES.find(function (t) { return t.value === step.type; }) || { icon: '\u2753', label: step.type };

  var typeOptions = SCRIPT_STEP_TYPES.map(function (t) {
    return '<option value="' + t.value + '"' + (t.value === step.type ? ' selected' : '') + '>' + t.icon + ' ' + t.label + '</option>';
  }).join('');

  var detailsHtml = '';
  if (step.type === 'navigate') {
    detailsHtml =
      '<div class="sd-field" style="flex:1;"><label class="sd-label">URL</label><input type="text" class="sd-input step-url" value="' + socialEsc(step.url || '') + '" placeholder="https://..." /></div>' +
      '<div class="sd-field" style="width:80px;"><label class="sd-label">Wait (ms)</label><input type="number" class="sd-input step-wait-ms" value="' + (step.waitMs || 3000) + '" /></div>';
  } else if (step.type === 'bridge') {
    detailsHtml =
      '<div class="sd-field" style="flex:1;"><label class="sd-label">Description</label><input type="text" class="sd-input step-description" value="' + socialEsc((step.params && step.params.description) || '') + '" placeholder="Find the upload button" /></div>' +
      '<label style="display:flex;align-items:center;gap:4px;font-size:0.75rem;color:#94a3b8;white-space:nowrap;"><input type="checkbox" class="step-then-click"' + (step.then === 'click' ? ' checked' : '') + '> Then click</label>';
  } else if (step.type === 'wait') {
    detailsHtml =
      '<div class="sd-field" style="width:120px;"><label class="sd-label">Duration (ms)</label><input type="number" class="sd-input step-ms" value="' + (step.ms || 1000) + '" /></div>';
  } else if (step.type === 'checkpoint') {
    detailsHtml =
      '<div class="sd-field" style="flex:1;"><label class="sd-label">Description</label><input type="text" class="sd-input step-check-desc" value="' + socialEsc((step.bridge && step.bridge.params && step.bridge.params.description) || '') + '" placeholder="Check for error message" /></div>' +
      '<div class="sd-field" style="width:120px;"><label class="sd-label">Fail If</label><select class="sd-input step-fail-if"><option value="not_found"' + (step.failIf === 'not_found' ? ' selected' : '') + '>Not found</option><option value="found"' + (step.failIf === 'found' ? ' selected' : '') + '>Found</option></select></div>';
  } else if (step.type === 'file_dialog') {
    detailsHtml =
      '<div class="sd-field" style="width:150px;"><label class="sd-label">Path Variable</label><select class="sd-input step-path-var"><option value="imagePath"' + (step.pathVar === 'imagePath' ? ' selected' : '') + '>imagePath</option><option value="videoPath"' + (step.pathVar === 'videoPath' ? ' selected' : '') + '>videoPath</option></select></div>' +
      '<div class="sd-field" style="width:100px;"><label class="sd-label">Wait After</label><input type="number" class="sd-input step-wait-after" value="' + (step.waitAfter || 3000) + '" /></div>';
  } else if (step.type === 'keyboard_type') {
    detailsHtml =
      '<div class="sd-field" style="width:150px;"><label class="sd-label">Text Variable</label><select class="sd-input step-text-var"><option value="captionText"' + (step.textVar === 'captionText' ? ' selected' : '') + '>captionText</option><option value="tweetText"' + (step.textVar === 'tweetText' ? ' selected' : '') + '>tweetText</option><option value="titleText"' + (step.textVar === 'titleText' ? ' selected' : '') + '>titleText</option><option value="descriptionText"' + (step.textVar === 'descriptionText' ? ' selected' : '') + '>descriptionText</option></select></div>' +
      '<div class="sd-field" style="width:100px;"><label class="sd-label">Wait After</label><input type="number" class="sd-input step-wait-after" value="' + (step.waitAfter || 1000) + '" /></div>';
  }

  var conditionalHtml =
    '<label style="display:flex;align-items:center;gap:4px;font-size:0.7rem;color:#64748b;"><input type="checkbox" class="step-has-conditional"' + (step.conditional ? ' checked' : '') + '> Conditional</label>' +
    (step.conditional ? '<input type="text" class="sd-input step-conditional" value="' + socialEsc(step.conditional) + '" style="width:100px;font-size:0.75rem;" placeholder="hasImage" />' : '');

  return '<div class="social-script-step" data-step-index="' + index + '" style="' +
    'display:flex;align-items:flex-start;gap:8px;padding:10px 12px;' +
    'background:#0f172a;border:1px solid #1e293b;border-radius:8px;">' +
    '<span style="color:#475569;font-size:0.75rem;padding-top:6px;min-width:20px;">' + (index + 1) + '.</span>' +
    '<div style="width:130px;flex-shrink:0;"><select class="sd-input step-type" style="font-size:0.8rem;">' + typeOptions + '</select></div>' +
    '<div class="sd-field" style="flex:0 0 auto;width:140px;"><label class="sd-label">Label</label><input type="text" class="sd-input step-label" value="' + socialEsc(step.label || '') + '" placeholder="Step label" /></div>' +
    '<div style="display:flex;gap:8px;flex:1;align-items:flex-end;">' + detailsHtml + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">' + conditionalHtml + '</div>' +
    '<button class="social-queue-delete-btn step-remove" style="padding:2px 6px;font-size:0.7rem;align-self:center;">\u00d7</button>' +
    '</div>';
}

function socialWireStepEvents(stepEl, index) {
  // Type change -- re-render step
  var typeSelect = stepEl.querySelector('.step-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', function () {
      var newStep = { type: typeSelect.value, label: stepEl.querySelector('.step-label').value };
      var newHtml = socialRenderSingleStep(newStep, index);
      stepEl.outerHTML = newHtml;
      var newEl = document.querySelectorAll('.social-script-step')[index];
      if (newEl) socialWireStepEvents(newEl, index);
    });
  }
  // Remove button
  var removeBtn = stepEl.querySelector('.step-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', function () {
      stepEl.remove();
      // Re-number remaining steps
      document.querySelectorAll('.social-script-step').forEach(function (el, i) {
        el.dataset.stepIndex = i;
        var numSpan = el.querySelector('span');
        if (numSpan) numSpan.textContent = (i + 1) + '.';
      });
    });
  }
}

function socialCollectScriptSteps() {
  var steps = [];
  document.querySelectorAll('.social-script-step').forEach(function (el) {
    var type = el.querySelector('.step-type').value;
    var step = {
      type: type,
      label: el.querySelector('.step-label').value.trim(),
    };

    // Conditional
    var condCb = el.querySelector('.step-has-conditional');
    if (condCb && condCb.checked) {
      var condInput = el.querySelector('.step-conditional');
      if (condInput) step.conditional = condInput.value.trim();
    }

    if (type === 'navigate') {
      step.url = (el.querySelector('.step-url') || {}).value || '';
      step.waitMs = parseInt((el.querySelector('.step-wait-ms') || {}).value, 10) || 3000;
    } else if (type === 'bridge') {
      step.action = 'find_interactive';
      step.params = { description: (el.querySelector('.step-description') || {}).value || '' };
      if (el.querySelector('.step-then-click') && el.querySelector('.step-then-click').checked) {
        step.then = 'click';
      }
    } else if (type === 'wait') {
      step.ms = parseInt((el.querySelector('.step-ms') || {}).value, 10) || 1000;
    } else if (type === 'checkpoint') {
      step.bridge = {
        action: 'find_interactive',
        params: { description: (el.querySelector('.step-check-desc') || {}).value || '' },
      };
      step.failIf = (el.querySelector('.step-fail-if') || {}).value || 'not_found';
    } else if (type === 'file_dialog') {
      step.pathVar = (el.querySelector('.step-path-var') || {}).value || 'imagePath';
      step.waitAfter = parseInt((el.querySelector('.step-wait-after') || {}).value, 10) || 3000;
    } else if (type === 'keyboard_type') {
      step.textVar = (el.querySelector('.step-text-var') || {}).value || 'captionText';
      step.waitAfter = parseInt((el.querySelector('.step-wait-after') || {}).value, 10) || 1000;
    }

    steps.push(step);
  });
  return steps;
}

// -- Platform Editor ----------------------------------------------

async function socialRenderPlatformEditor(connector) {
  var main = document.querySelector('#main');
  var isNew = !connector;
  var c = connector || {
    platform: '',
    displayName: '',
    enabled: true,
    icon: '\ud83c\udf10',
    color: '#7c3aed',
    baseUrl: '',
    capabilities: { text: true, images: false, video: false },
    maxTextLength: 0,
    maxImages: 0,
    requiresImage: false,
    requiresVideo: false,
    compositionId: '',
    notes: '',
  };

  // Fetch compositions for pipeline linking
  var compositions = [];
  try {
    var compRes = await fetch('/api/compositions');
    if (compRes.ok) {
      var compData = await compRes.json();
      compositions = compData.compositions || [];
    }
  } catch (e) { /* ignore */ }

  // Fetch existing script if editing
  var existingScript = null;
  if (!isNew) {
    try {
      var scriptRes = await fetch('/api/social/platforms/' + encodeURIComponent(c.platform) + '/script');
      if (scriptRes.ok) existingScript = await scriptRes.json();
    } catch (e) { /* ignore */ }
  }

  var caps = c.capabilities || {};
  var postingMethod = c.compositionId ? 'pipeline' : 'script';

  var html =
    '<div class="sd-container">' +

    // Header
    '<div class="sd-header">' +
    '<button class="sd-back-btn" id="social-plat-editor-back">' +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</button>' +
    '<div class="sd-header-title">' + (isNew ? 'Add Platform' : 'Edit ' + socialEsc(c.displayName || c.platform)) + '</div>' +
    '</div>' +

    '<div class="grid-12">' +

    // -- Basic Info --
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><span>Basic Info</span></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div class="sd-field"><label class="sd-label">Platform Slug</label><input type="text" id="plat-slug" class="sd-input" value="' + socialEsc(c.platform) + '" placeholder="tiktok"' + (isNew ? '' : ' disabled') + ' /></div>' +
    '<div class="sd-field"><label class="sd-label">Display Name</label><input type="text" id="plat-display" class="sd-input" value="' + socialEsc(c.displayName || '') + '" placeholder="TikTok" /></div>' +
    '<div class="sd-field"><label class="sd-label">Icon (emoji)</label><input type="text" id="plat-icon" class="sd-input" value="' + socialEsc(c.icon || '') + '" placeholder="\ud83c\udfb5" style="font-size:1.2rem;" /></div>' +
    '<div class="sd-field"><label class="sd-label">Brand Color</label><input type="color" id="plat-color" class="sd-input" value="' + (c.color || '#7c3aed') + '" style="height:36px;padding:2px;" /></div>' +
    '<div class="sd-field" style="grid-column:1/-1;"><label class="sd-label">Base URL</label><input type="text" id="plat-url" class="sd-input" value="' + socialEsc(c.baseUrl || '') + '" placeholder="https://www.tiktok.com" /></div>' +
    '</div>' +
    '</div>' +

    // -- Capabilities & Limits --
    '<div class="sd-card col-6">' +
    '<div class="sd-card-header"><span>Capabilities & Limits</span></div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="checkbox" id="plat-cap-text"' + (caps.text ? ' checked' : '') + '> Text</label>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="checkbox" id="plat-cap-images"' + (caps.images ? ' checked' : '') + '> Images</label>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="checkbox" id="plat-cap-video"' + (caps.video ? ' checked' : '') + '> Video</label>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="checkbox" id="plat-req-image"' + (c.requiresImage ? ' checked' : '') + '> Requires Image</label>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="checkbox" id="plat-req-video"' + (c.requiresVideo ? ' checked' : '') + '> Requires Video</label>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
    '<div class="sd-field"><label class="sd-label">Max Text Length</label><input type="number" id="plat-max-text" class="sd-input" value="' + (c.maxTextLength || '') + '" placeholder="2200" /></div>' +
    '<div class="sd-field"><label class="sd-label">Max Images</label><input type="number" id="plat-max-images" class="sd-input" value="' + (c.maxImages || '') + '" placeholder="10" /></div>' +
    '</div>' +
    '</div>' +

    // -- Posting Method --
    '<div class="sd-card col-12">' +
    '<div class="sd-card-header"><span>Posting Method</span></div>' +
    '<div style="display:flex;gap:16px;margin-bottom:16px;">' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="radio" name="plat-method" value="script"' + (postingMethod === 'script' ? ' checked' : '') + '> \ud83e\udd16 Browser Script</label>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#e2e8f0;cursor:pointer;"><input type="radio" name="plat-method" value="pipeline"' + (postingMethod === 'pipeline' ? ' checked' : '') + '> \ud83d\udd17 Connect Pipeline</label>' +
    '</div>' +

    // Pipeline selector (shown when pipeline is selected)
    '<div id="plat-pipeline-section" style="' + (postingMethod === 'pipeline' ? '' : 'display:none;') + '">' +
    '<div class="sd-field"><label class="sd-label">Select Composition Pipeline</label>' +
    '<select id="plat-composition" class="sd-input" style="width:100%;">' +
    '<option value="">\u2014 Select a pipeline \u2014</option>' +
    compositions.map(function (comp) {
      var sel = c.compositionId === comp.id ? ' selected' : '';
      return '<option value="' + socialEsc(comp.id) + '"' + sel + '>' + socialEsc(comp.name || comp.id) + '</option>';
    }).join('') +
    '</select></div>' +
    '</div>' +

    // Script editor (shown when script is selected)
    '<div id="plat-script-section" style="' + (postingMethod === 'script' ? '' : 'display:none;') + '">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
    '<label class="sd-label" style="margin:0;">Script Steps</label>' +
    '<button class="sd-btn" id="plat-add-step" style="padding:3px 10px;font-size:0.75rem;">+ Add Step</button>' +
    '</div>' +
    '<div id="plat-script-steps" style="display:flex;flex-direction:column;gap:6px;">' +
    socialRenderScriptSteps(existingScript) +
    '</div>' +
    '</div>' +
    '</div>' +

    // -- Notes --
    '<div class="sd-card col-12">' +
    '<div class="sd-card-header"><span>Notes</span></div>' +
    '<textarea id="plat-notes" class="sd-input" style="width:100%;min-height:60px;resize:vertical;" placeholder="Platform-specific notes...">' + socialEsc(c.notes || '') + '</textarea>' +
    '</div>' +

    '</div>' +

    // Save/Cancel
    '<div class="sd-actions">' +
    '<button class="sd-btn" id="plat-cancel" style="background:transparent;border:1px solid #334155;color:#94a3b8;">Cancel</button>' +
    '<button class="sd-btn sd-btn-primary" id="plat-save">' + (isNew ? 'Create Platform' : 'Save Changes') + '</button>' +
    '</div>' +
    '</div>';

  main.innerHTML = html;

  // Toggle posting method sections
  main.querySelectorAll('input[name="plat-method"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      document.getElementById('plat-pipeline-section').style.display = radio.value === 'pipeline' ? '' : 'none';
      document.getElementById('plat-script-section').style.display = radio.value === 'script' ? '' : 'none';
    });
  });

  // Wire add step button
  main.querySelector('#plat-add-step').addEventListener('click', function () {
    var container = document.getElementById('plat-script-steps');
    // Remove "no steps" placeholder if present
    var placeholder = container.querySelector('div[style*="text-align:center"]');
    if (placeholder && !container.querySelector('.social-script-step')) {
      container.innerHTML = '';
    }
    var stepIndex = container.querySelectorAll('.social-script-step').length;
    var stepHtml = socialRenderSingleStep({ type: 'navigate', label: '' }, stepIndex);
    container.insertAdjacentHTML('beforeend', stepHtml);
    var newEl = container.lastElementChild;
    if (newEl) socialWireStepEvents(newEl, stepIndex);
  });

  // Wire existing step events
  main.querySelectorAll('.social-script-step').forEach(function (el, i) {
    socialWireStepEvents(el, i);
  });

  // Cancel
  main.querySelector('#plat-cancel').addEventListener('click', function () {
    socialRenderSettings();
  });

  // Back
  main.querySelector('#social-plat-editor-back').addEventListener('click', function () {
    socialRenderSettings();
  });

  // Save
  main.querySelector('#plat-save').addEventListener('click', async function () {
    var btn = main.querySelector('#plat-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var slug = main.querySelector('#plat-slug').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!slug) {
      if (typeof toast === 'function') toast('Platform slug is required', 'error');
      btn.disabled = false;
      btn.textContent = isNew ? 'Create Platform' : 'Save Changes';
      return;
    }

    var method = main.querySelector('input[name="plat-method"]:checked').value;

    var connectorData = {
      platform: slug,
      displayName: main.querySelector('#plat-display').value.trim() || slug,
      enabled: true,
      icon: main.querySelector('#plat-icon').value.trim() || '\ud83c\udf10',
      color: main.querySelector('#plat-color').value,
      baseUrl: main.querySelector('#plat-url').value.trim(),
      capabilities: {
        text: main.querySelector('#plat-cap-text').checked,
        images: main.querySelector('#plat-cap-images').checked,
        video: main.querySelector('#plat-cap-video').checked,
      },
      maxTextLength: parseInt(main.querySelector('#plat-max-text').value, 10) || 0,
      maxImages: parseInt(main.querySelector('#plat-max-images').value, 10) || 0,
      requiresImage: main.querySelector('#plat-req-image').checked,
      requiresVideo: main.querySelector('#plat-req-video').checked,
      compositionId: method === 'pipeline' ? (main.querySelector('#plat-composition').value || '') : '',
      notes: main.querySelector('#plat-notes').value.trim(),
    };

    try {
      // Save connector
      var connRes = await fetch(isNew ? '/api/social/platforms' : '/api/social/platforms/' + encodeURIComponent(slug), {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connectorData),
      });
      if (!connRes.ok) throw new Error('Failed to save connector');

      // Save script if using script method
      if (method === 'script') {
        var steps = socialCollectScriptSteps();
        var scriptData = {
          platform: slug,
          requiresImage: connectorData.requiresImage,
          requiresVideo: connectorData.requiresVideo,
          maxCaptionLength: connectorData.maxTextLength,
          maxTextLength: connectorData.maxTextLength,
          steps: steps,
        };
        var scriptRes = await fetch('/api/social/platforms/' + encodeURIComponent(slug) + '/script', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scriptData),
        });
        if (!scriptRes.ok) throw new Error('Failed to save script');
      }

      if (typeof toast === 'function') toast('Platform "' + connectorData.displayName + '" saved', 'success');
      socialRenderSettings();
    } catch (err) {
      if (typeof toast === 'function') toast('Save failed: ' + err, 'error');
      btn.disabled = false;
      btn.textContent = isNew ? 'Create Platform' : 'Save Changes';
    }
  });
}
