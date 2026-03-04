/**
 * Publish Dialog — Client-side JavaScript
 *
 * Modal dialog for publishing workflows to the marketplace.
 * Handles metadata entry, screenshot selection, upload progress.
 */

// ── Marketplace Auth State ──────────────────────────────────
var marketplaceAuthState = { signedIn: false, uid: null, displayName: null, email: null };

async function checkMarketplaceAuth() {
  try {
    var res = await fetch('/api/marketplace/auth-status');
    var data = await res.json();
    marketplaceAuthState = data;
    return data;
  } catch (e) {
    return { signedIn: false };
  }
}

// ── Publish Dialog ──────────────────────────────────────────

var defaultCategories = [
  'Productivity',
  'Social Media',
  'Data Entry',
  'Scraping',
  'E-Commerce',
  'Music',
  'Media',
  'Development',
  'Finance',
  'Other',
];

function openPublishDialog(wf, filePath) {
  // Remove any existing overlay
  var existing = document.querySelector('#publish-overlay');
  if (existing) existing.remove();

  var isUpdate = false; // TODO: detect if already published

  var overlay = document.createElement('div');
  overlay.id = 'publish-overlay';
  overlay.className = 'comp-modal-overlay';

  var categoryOptions = defaultCategories
    .map(function (c) {
      return '<option value="' + c.toLowerCase().replace(/\s+/g, '-') + '">' + c + '</option>';
    })
    .join('');

  overlay.innerHTML =
    '<div class="comp-modal" style="max-width:560px;">' +
    '<div class="comp-modal-header">' +
    '<span>&#x1f680; Publish to Marketplace</span>' +
    '<button class="comp-modal-close" id="publish-close">&times;</button>' +
    '</div>' +
    '<div class="comp-modal-body">' +
    // Auth check
    '<div id="publish-auth-section"></div>' +
    // Form (hidden until authed)
    '<div id="publish-form-section" style="display:none;">' +
    '<div style="margin-bottom:0.75rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Name</label>' +
    '<input type="text" id="publish-name" class="wf-run-input" style="width:100%;" value="' + escHtml(wf.name || '') + '" />' +
    '</div>' +
    '<div style="margin-bottom:0.75rem;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Description</label>' +
    '<textarea id="publish-desc" class="wf-run-input" style="width:100%;min-height:60px;resize:vertical;">' + escHtml(wf.description || '') + '</textarea>' +
    '</div>' +
    '<div style="display:flex;gap:0.75rem;margin-bottom:0.75rem;">' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Category</label>' +
    '<select id="publish-category" class="wf-run-input" style="width:100%;">' + categoryOptions + '</select>' +
    '</div>' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Tags (comma-separated)</label>' +
    '<input type="text" id="publish-tags" class="wf-run-input" style="width:100%;" placeholder="automation, browser" value="' + escHtml((wf.site || '') ? wf.site : '') + '" />' +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:0.75rem;margin-bottom:0.75rem;">' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Version</label>' +
    '<input type="text" id="publish-version" class="wf-run-input" style="width:100%;" value="1.0.0" />' +
    '</div>' +
    '<div style="flex:1;">' +
    '<label style="display:block;font-size:0.75rem;color:#94a3b8;margin-bottom:4px;">Changelog</label>' +
    '<input type="text" id="publish-changelog" class="wf-run-input" style="width:100%;" value="Initial release" />' +
    '</div>' +
    '</div>' +
    // Model checkbox
    (wf.metadata && wf.metadata.modelPath
      ? '<div style="margin-bottom:0.75rem;">' +
        '<label style="display:flex;align-items:center;gap:0.5rem;font-size:0.8rem;color:#e2e8f0;cursor:pointer;">' +
        '<input type="checkbox" id="publish-include-model" checked />' +
        'Include AI visual matching model' +
        '<span style="font-size:0.7rem;color:#94a3b8;">(~5MB)</span>' +
        '</label>' +
        '</div>'
      : '') +
    // Progress
    '<div id="publish-progress" style="display:none;margin-bottom:0.75rem;">' +
    '<div style="height:4px;background:#334155;border-radius:2px;overflow:hidden;">' +
    '<div id="publish-progress-bar" style="height:100%;background:linear-gradient(90deg,#7c3aed,#8b5cf6);width:0%;transition:width 0.3s;"></div>' +
    '</div>' +
    '<div id="publish-progress-text" style="font-size:0.7rem;color:#94a3b8;margin-top:4px;">Preparing...</div>' +
    '</div>' +
    // Buttons
    '<div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;">' +
    '<button class="btn-secondary" id="publish-cancel">Cancel</button>' +
    '<button class="btn-primary" id="publish-submit" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);">Publish</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('#publish-close').addEventListener('click', function () {
    overlay.remove();
  });
  overlay.querySelector('#publish-cancel').addEventListener('click', function () {
    overlay.remove();
  });
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });

  // Check auth and show appropriate section
  checkMarketplaceAuth().then(function (auth) {
    var authSection = overlay.querySelector('#publish-auth-section');
    var formSection = overlay.querySelector('#publish-form-section');

    if (auth.signedIn) {
      authSection.innerHTML =
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;padding:0.5rem 0.75rem;background:#1e293b;border:1px solid #334155;border-radius:8px;">' +
        '<div style="width:24px;height:24px;border-radius:50%;background:#7c3aed;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#fff;">' +
        escHtml((auth.displayName || '?')[0]) +
        '</div>' +
        '<span style="font-size:0.8rem;color:#e2e8f0;">' + escHtml(auth.displayName || auth.email || 'Signed in') + '</span>' +
        '</div>';
      formSection.style.display = '';
    } else {
      authSection.innerHTML =
        '<div style="text-align:center;padding:2rem 1rem;">' +
        '<p style="color:#94a3b8;margin-bottom:1rem;">Sign in with Google to publish workflows to the marketplace.</p>' +
        '<button class="btn-primary" id="publish-signin" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);">Sign in with Google</button>' +
        '</div>';
      formSection.style.display = 'none';

      // Wire up sign-in (placeholder — actual OAuth flow requires Electron window)
      var signinBtn = overlay.querySelector('#publish-signin');
      if (signinBtn) {
        signinBtn.addEventListener('click', function () {
          authSection.innerHTML =
            '<div style="text-align:center;padding:2rem 1rem;color:#94a3b8;">' +
            '<p>Google sign-in is available from the Woodbury desktop app.</p>' +
            '<p style="font-size:0.75rem;margin-top:0.5rem;">Open Woodbury and sign in from the marketplace tab.</p>' +
            '</div>';
        });
      }
    }
  });

  // Publish submit handler
  overlay.querySelector('#publish-submit').addEventListener('click', function () {
    handlePublishSubmit(wf, filePath, overlay);
  });

  // Focus name input
  requestAnimationFrame(function () {
    var nameInput = overlay.querySelector('#publish-name');
    if (nameInput) nameInput.focus();
  });
}

async function handlePublishSubmit(wf, filePath, overlay) {
  var submitBtn = overlay.querySelector('#publish-submit');
  var progressDiv = overlay.querySelector('#publish-progress');
  var progressBar = overlay.querySelector('#publish-progress-bar');
  var progressText = overlay.querySelector('#publish-progress-text');

  // Gather form values
  var name = overlay.querySelector('#publish-name').value.trim();
  var description = overlay.querySelector('#publish-desc').value.trim();
  var category = overlay.querySelector('#publish-category').value;
  var tagsInput = overlay.querySelector('#publish-tags').value;
  var version = overlay.querySelector('#publish-version').value.trim();
  var changelog = overlay.querySelector('#publish-changelog').value.trim();
  var includeModelCb = overlay.querySelector('#publish-include-model');
  var includeModel = includeModelCb ? includeModelCb.checked : false;

  if (!name) {
    if (typeof toast === 'function') toast('Name is required', 'error');
    return;
  }

  // Disable submit, show progress
  submitBtn.disabled = true;
  submitBtn.textContent = 'Publishing...';
  progressDiv.style.display = '';
  progressBar.style.width = '20%';
  progressText.textContent = 'Uploading workflow...';

  var tags = tagsInput
    .split(',')
    .map(function (t) {
      return t.trim();
    })
    .filter(Boolean);

  try {
    progressBar.style.width = '40%';
    progressText.textContent = 'Uploading to marketplace...';

    var res = await fetch('/api/marketplace/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowPath: filePath,
        metadata: {
          name: name,
          description: description,
          category: category,
          tags: tags,
          version: version,
          changelog: changelog,
          includeModel: includeModel,
          screenshotPaths: [],
        },
      }),
    });

    progressBar.style.width = '80%';
    progressText.textContent = 'Finishing...';

    var result = await res.json();

    if (result.success) {
      progressBar.style.width = '100%';
      progressText.textContent = 'Published!';

      setTimeout(function () {
        overlay.remove();
        if (typeof toast === 'function') {
          toast('Workflow published to marketplace!', 'success');
        }
      }, 800);
    } else {
      throw new Error(result.error || 'Publish failed');
    }
  } catch (err) {
    progressDiv.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publish';
    if (typeof toast === 'function') {
      toast('Publish failed: ' + (err.message || err), 'error');
    }
  }
}
