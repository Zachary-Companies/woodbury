/**
 * Workflows Dashboard — Editor Module
 *
 * Contains:
 *  - Step editor (renderStepEditor, collectStepEditorValues)
 *  - Condition description (describeCondition)
 *  - Step list rendering (renderStepList)
 *  - Element finder panel (renderFinderPanel, drawFinderCanvas)
 *  - Visual view (renderVisualView)
 *  - Model view (renderModelView, wireModelViewHandlers, loadModelViewWorkers)
 *  - Version history (compareSemVerJS, loadVersionHistory)
 *  - Training data stats (loadTrainingDataStats, tdStat)
 *  - JSON view (renderJsonView)
 *  - Run view (renderRunView)
 *  - Pipeline rendering (renderPipelineList)
 *  - Event wiring (wireUpHandlers)
 *  - Insert step pickers (showInsertPicker, showInsertPickerForGroup)
 *
 * Loaded AFTER workflows-core.js — uses globals defined there.
 */

// ── Step Editor ──────────────────────────────────────────────

function renderStepEditor(step, idx, totalSteps) {
  var html = '';
  // Label row (all step types)
  html += '<div class="wf-se-row">';
  html += '<span class="wf-se-label">Label</span>';
  html += '<input class="wf-se-input wf-se-step-label" type="text" value="' + escAttr(step.label || '') + '" placeholder="Step label">';
  html += '</div>';

  // Type-specific fields
  switch (step.type) {
    case 'navigate':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">URL</span>';
      html += '<input class="wf-se-input wf-se-url" type="text" value="' + escAttr(step.url || '') + '" placeholder="https://example.com">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Wait ms</span>';
      html += '<input class="wf-se-input wf-se-wait-ms" type="number" value="' + escAttr(String(step.waitMs || '')) + '" placeholder="2000" style="max-width:100px;">';
      html += '</div>';
      var navSS = step.selectorSource || {};
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-nav-selector" type="text" value="' + escAttr(navSS.selector || '') + '" placeholder="CSS selector to extract URL from">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Attribute</span>';
      html += '<input class="wf-se-input wf-se-nav-attribute" type="text" value="' + escAttr(navSS.attribute || '') + '" placeholder="href" style="max-width:140px;">';
      html += '<span style="font-size:0.65rem;color:#64748b;margin-left:6px;">When set, extracts URL from element attribute</span>';
      html += '</div>';
      break;

    case 'click':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Text</span>';
      html += '<input class="wf-se-input wf-se-text" type="text" value="' + escAttr((step.target && step.target.textContent) || '') + '" placeholder="Text content">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Click type</span>';
      var ct = step.clickType || 'single';
      html += '<select class="wf-se-input wf-se-click-type" style="max-width:120px;">';
      ['single', 'double', 'right', 'hover'].forEach(function(t) {
        html += '<option value="' + t + '"' + (ct === t ? ' selected' : '') + '>' + t + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay-ms" type="number" value="' + escAttr(String(step.delayAfterMs || '')) + '" placeholder="300" style="max-width:100px;">';
      html += '</div>';
      // Visual element finder
      if (step.target && step.target.referenceImage) {
        html += '<div class="wf-se-row" style="margin-top:0.5rem;">';
        html += '<button class="wf-se-btn wf-se-find-element" style="background:#7c3aed;color:#fff;border-color:#6d28d9;">&#x1f50d; Find Element</button>';
        if (step.target.expectedBounds) {
          html += '<span style="font-size:0.62rem;color:#64748b;margin-left:0.4rem;">Expected: (' + (step.target.expectedBounds.pctX || 0).toFixed(1) + '%, ' + (step.target.expectedBounds.pctY || 0).toFixed(1) + '%)</span>';
        }
        html += '</div>';
        html += '<div class="wf-se-finder-panel" style="display:none;"></div>';
      }
      break;

    case 'type':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Value</span>';
      html += '<textarea class="wf-se-input wf-se-value" placeholder="Text to type (use {{var}})">' + escHtml(step.value || '') + '</textarea>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;">';
      html += '<input type="checkbox" class="wf-se-clear"' + (step.clearFirst ? ' checked' : '') + '> Clear first';
      html += '</label>';
      html += '<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.7rem;color:#94a3b8;cursor:pointer;margin-left:1rem;">';
      html += '<input type="checkbox" class="wf-se-skip-click"' + (step.skipClick ? ' checked' : '') + '> Skip click';
      html += '</label>';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay-ms" type="number" value="' + escAttr(String(step.delayAfterMs != null ? step.delayAfterMs : 1000)) + '" placeholder="1000" style="max-width:100px;">';
      html += '</div>';
      // Visual element finder
      if (step.target && step.target.referenceImage) {
        html += '<div class="wf-se-row" style="margin-top:0.5rem;">';
        html += '<button class="wf-se-btn wf-se-find-element" style="background:#7c3aed;color:#fff;border-color:#6d28d9;">&#x1f50d; Find Element</button>';
        if (step.target.expectedBounds) {
          html += '<span style="font-size:0.62rem;color:#64748b;margin-left:0.4rem;">Expected: (' + (step.target.expectedBounds.pctX || 0).toFixed(1) + '%, ' + (step.target.expectedBounds.pctY || 0).toFixed(1) + '%)</span>';
        }
        html += '</div>';
        html += '<div class="wf-se-finder-panel" style="display:none;"></div>';
      }
      break;

    case 'wait':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-delay" type="number" value="' + escAttr(String((step.condition && step.condition.ms) || '')) + '" placeholder="2000" style="max-width:120px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Or selector</span>';
      html += '<input class="wf-se-input wf-se-wait-selector" type="text" value="' + escAttr((step.condition && step.condition.target && step.condition.target.selector) || '') + '" placeholder="Wait for element selector">';
      html += '</div>';
      break;

    case 'keyboard':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Key</span>';
      html += '<input class="wf-se-input wf-se-key" type="text" value="' + escAttr(step.key || '') + '" placeholder="Enter, Tab, etc." style="max-width:150px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Modifiers</span>';
      html += '<input class="wf-se-input wf-se-mods" type="text" value="' + escAttr((step.modifiers || []).join(', ')) + '" placeholder="cmd, shift, ctrl, alt">';
      html += '</div>';
      break;

    case 'scroll':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Direction</span>';
      var dir = step.direction || 'down';
      html += '<select class="wf-se-input wf-se-direction" style="max-width:120px;">';
      ['up', 'down', 'left', 'right'].forEach(function(d) {
        html += '<option value="' + d + '"' + (dir === d ? ' selected' : '') + '>' + d + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Amount</span>';
      html += '<input class="wf-se-input wf-se-amount" type="number" value="' + escAttr(String(step.amount || 3)) + '" placeholder="3" style="max-width:80px;">';
      html += '</div>';
      break;

    case 'assert':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.target && step.target.selector) || '') + '" placeholder="CSS selector">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Expected</span>';
      html += '<input class="wf-se-input wf-se-expected" type="text" value="' + escAttr(step.expectedText || '') + '" placeholder="Expected text">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Error msg</span>';
      html += '<input class="wf-se-input wf-se-error-msg" type="text" value="' + escAttr(step.errorMessage || '') + '" placeholder="Custom error message">';
      html += '</div>';
      break;

    case 'set_variable':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Variable</span>';
      html += '<input class="wf-se-input wf-se-varname" type="text" value="' + escAttr(step.variable || '') + '" placeholder="Variable name" style="max-width:160px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Value</span>';
      html += '<input class="wf-se-input wf-se-varvalue" type="text" value="' + escAttr((step.source && step.source.type === 'literal' && step.source.value != null) ? String(step.source.value) : (step.value || '')) + '" placeholder="Value or expression">';
      html += '</div>';
      break;

    case 'capture_download':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Pattern</span>';
      html += '<input class="wf-se-input wf-se-filename-pattern" type="text" value="' + escAttr(step.filenamePattern || '') + '" placeholder="Filename regex pattern">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Max files</span>';
      html += '<input class="wf-se-input wf-se-max-files" type="number" value="' + escAttr(String(step.maxFiles || '')) + '" placeholder="1" style="max-width:80px;">';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Timeout ms</span>';
      html += '<input class="wf-se-input wf-se-timeout" type="number" value="' + escAttr(String(step.waitTimeoutMs || '')) + '" placeholder="30000" style="max-width:120px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Output var</span>';
      html += '<input class="wf-se-input wf-se-output-var" type="text" value="' + escAttr(step.outputVariable || '') + '" placeholder="Variable for downloaded paths" style="max-width:200px;">';
      html += '</div>';
      break;

    case 'move_file':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Source</span>';
      html += '<input class="wf-se-input wf-se-source" type="text" value="' + escAttr(step.source || '') + '" placeholder="Source path or {{var}}">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Destination</span>';
      html += '<input class="wf-se-input wf-se-destination" type="text" value="' + escAttr(step.destination || '') + '" placeholder="Destination path or {{var}}">';
      html += '</div>';
      break;

    case 'file_dialog':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">File path</span>';
      html += '<input class="wf-se-input wf-se-filepath" type="text" value="' + escAttr(step.filePath || '') + '" placeholder="Absolute path or {{variable}}">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Trigger</span>';
      html += '<input class="wf-se-input wf-se-selector" type="text" value="' + escAttr((step.trigger && step.trigger.selector) || '') + '" placeholder="CSS selector for upload button (optional)">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Output var</span>';
      html += '<input class="wf-se-input wf-se-output-var" type="text" value="' + escAttr(step.outputVariable || '') + '" placeholder="Variable for file path" style="max-width:200px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay before</span>';
      html += '<input class="wf-se-input wf-se-delay-before" type="number" value="' + escAttr(String(step.delayBeforeMs || '')) + '" placeholder="2000" style="max-width:100px;">';
      html += '<span class="wf-se-label" style="margin-left:1rem;">Delay after</span>';
      html += '<input class="wf-se-input wf-se-delay-after" type="number" value="' + escAttr(String(step.delayAfterMs || '')) + '" placeholder="1000" style="max-width:100px;">';
      html += '</div>';
      break;

    case 'conditional': {
      var condType = (step.condition && typeof step.condition === 'object' && step.condition.type) || 'expression';
      var isFunc = typeof step.condition === 'function';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Condition</span>';
      if (isFunc) {
        html += '<span style="color:#c4b5fd;font-size:0.75rem;">[custom function]</span>';
      } else {
        html += '<select class="wf-se-input wf-se-cond-type" style="max-width:180px;">';
        var condTypes = ['expression', 'element_exists', 'element_visible', 'url_contains', 'url_matches', 'variable_equals'];
        for (var ci = 0; ci < condTypes.length; ci++) {
          html += '<option value="' + condTypes[ci] + '"' + (condType === condTypes[ci] ? ' selected' : '') + '>' + condTypes[ci] + '</option>';
        }
        html += '</select>';
      }
      html += '</div>';
      if (!isFunc && condType === 'expression') {
        html += '<div class="wf-se-row">';
        html += '<span class="wf-se-label">Expression</span>';
        html += '<input class="wf-se-input wf-se-expression" type="text" value="' + escAttr((step.condition && step.condition.expression) || '') + '" placeholder="{{count}} > 0 && {{status}} === \'ready\'">';
        html += '</div>';
      } else if (!isFunc && (condType === 'element_exists' || condType === 'element_visible')) {
        html += '<div class="wf-se-row">';
        html += '<span class="wf-se-label">Selector</span>';
        html += '<input class="wf-se-input wf-se-cond-selector" type="text" value="' + escAttr((step.condition && step.condition.target && step.condition.target.selector) || '') + '" placeholder="CSS selector">';
        html += '</div>';
      } else if (!isFunc && (condType === 'url_contains')) {
        html += '<div class="wf-se-row">';
        html += '<span class="wf-se-label">Substring</span>';
        html += '<input class="wf-se-input wf-se-cond-substring" type="text" value="' + escAttr((step.condition && step.condition.substring) || '') + '" placeholder="URL substring">';
        html += '</div>';
      } else if (!isFunc && condType === 'url_matches') {
        html += '<div class="wf-se-row">';
        html += '<span class="wf-se-label">Pattern</span>';
        html += '<input class="wf-se-input wf-se-cond-pattern" type="text" value="' + escAttr((step.condition && step.condition.pattern) || '') + '" placeholder="URL regex pattern">';
        html += '</div>';
      } else if (!isFunc && condType === 'variable_equals') {
        html += '<div class="wf-se-row">';
        html += '<span class="wf-se-label">Variable</span>';
        html += '<input class="wf-se-input wf-se-cond-variable" type="text" value="' + escAttr((step.condition && step.condition.variable) || '') + '" placeholder="Variable name" style="max-width:140px;">';
        html += '<span class="wf-se-label">Value</span>';
        html += '<input class="wf-se-input wf-se-cond-value" type="text" value="' + escAttr((step.condition && step.condition.value != null) ? String(step.condition.value) : '') + '" placeholder="Expected value">';
        html += '</div>';
      }
      break;
    }

    case 'loop':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Over variable</span>';
      html += '<input class="wf-se-input wf-se-over-var" type="text" value="' + escAttr(step.overVariable || '') + '" placeholder="Array variable name" style="max-width:160px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Item variable</span>';
      html += '<input class="wf-se-input wf-se-item-var" type="text" value="' + escAttr(step.itemVariable || '') + '" placeholder="Current item name" style="max-width:160px;">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Index variable</span>';
      html += '<input class="wf-se-input wf-se-index-var" type="text" value="' + escAttr(step.indexVariable || '') + '" placeholder="(optional)" style="max-width:160px;">';
      html += '</div>';
      break;

    case 'try_catch':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Error variable</span>';
      html += '<input class="wf-se-input wf-se-error-var" type="text" value="' + escAttr(step.errorVariable || '') + '" placeholder="Variable to store error (optional)" style="max-width:200px;">';
      html += '</div>';
      break;

    case 'inject_style':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Action</span>';
      html += '<select class="wf-se-input wf-se-style-action" style="max-width:140px;">';
      html += '<option value="apply"' + ((step.action || 'apply') === 'apply' ? ' selected' : '') + '>Apply</option>';
      html += '<option value="clear"' + (step.action === 'clear' ? ' selected' : '') + '>Clear</option>';
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Selector</span>';
      html += '<input class="wf-se-input wf-se-style-selector" type="text" value="' + escAttr(step.selector || '') + '" placeholder="CSS selector, e.g. .header, #main">';
      html += '</div>';
      html += '<div class="wf-se-row wf-se-style-styles-row"' + (step.action === 'clear' ? ' style="display:none;"' : '') + '>';
      html += '<span class="wf-se-label">Styles (JSON)</span>';
      html += '<textarea class="wf-se-input wf-se-style-json" placeholder=\'{ "position": "absolute", "top": "0" }\' style="min-height:80px;font-family:monospace;font-size:0.75rem;">' + escHtml(JSON.stringify(step.styles || {}, null, 2)) + '</textarea>';
      html += '</div>';
      break;

    case 'keyboard_nav': {
      var navActions = step.actions || [{ key: 'tab', count: 1 }];
      var navKeyOptions = ['tab', 'shift_tab', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right', 'enter', 'space', 'escape'];
      html += '<div class="wf-se-row" style="flex-direction:column;align-items:stretch;">';
      html += '<span class="wf-se-label" style="margin-bottom:0.35rem;">Actions</span>';
      html += '<div class="wf-se-nav-actions-list">';
      for (var ai = 0; ai < navActions.length; ai++) {
        var act = navActions[ai];
        html += '<div class="wf-se-nav-action-row" style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.3rem;">';
        html += '<select class="wf-se-input wf-se-nav-key" style="max-width:130px;">';
        for (var ki = 0; ki < navKeyOptions.length; ki++) {
          html += '<option value="' + navKeyOptions[ki] + '"' + (act.key === navKeyOptions[ki] ? ' selected' : '') + '>' + navKeyOptions[ki] + '</option>';
        }
        html += '</select>';
        html += '<label style="display:flex;align-items:center;gap:0.2rem;font-size:0.7rem;color:#94a3b8;white-space:nowrap;">Count';
        html += '<input class="wf-se-input wf-se-nav-count" type="number" value="' + escAttr(String(act.count || 1)) + '" style="max-width:55px;" min="1">';
        html += '</label>';
        html += '<input class="wf-se-input wf-se-nav-match" type="text" value="' + escAttr(act.matchText || '') + '" placeholder="Search text {{var}}" style="flex:1;min-width:100px;">';
        html += '<button class="wf-se-btn wf-se-nav-remove" style="padding:0.15rem 0.4rem;font-size:0.8rem;" title="Remove action">&times;</button>';
        html += '</div>';
      }
      html += '</div>';
      html += '<button class="wf-se-btn wf-se-nav-add" style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-top:0.25rem;">+ Add Action</button>';
      html += '</div>';
      // Expected focus
      var ef = step.expectedFocus || {};
      html += '<div class="wf-se-row" style="flex-direction:column;align-items:stretch;">';
      html += '<span class="wf-se-label" style="margin-bottom:0.35rem;">Expected Focus</span>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:0.35rem;">';
      html += '<input class="wf-se-input wf-se-nav-ef-text" type="text" value="' + escAttr(ef.text || '') + '" placeholder="Text" style="max-width:140px;">';
      html += '<input class="wf-se-input wf-se-nav-ef-aria" type="text" value="' + escAttr(ef.ariaLabel || '') + '" placeholder="Aria label" style="max-width:140px;">';
      html += '<input class="wf-se-input wf-se-nav-ef-role" type="text" value="' + escAttr(ef.role || '') + '" placeholder="Role" style="max-width:100px;">';
      html += '<input class="wf-se-input wf-se-nav-ef-tag" type="text" value="' + escAttr(ef.tag || '') + '" placeholder="Tag" style="max-width:80px;">';
      html += '<input class="wf-se-input wf-se-nav-ef-selector" type="text" value="' + escAttr(ef.selector || '') + '" placeholder="Selector" style="max-width:160px;">';
      html += '<input class="wf-se-input wf-se-nav-ef-placeholder" type="text" value="' + escAttr(ef.placeholder || '') + '" placeholder="Placeholder" style="max-width:140px;">';
      html += '</div>';
      html += '</div>';
      // Auto-fix + max search distance
      html += '<div class="wf-se-row">';
      html += '<label style="display:flex;align-items:center;gap:0.3rem;font-size:0.75rem;color:#cbd5e1;cursor:pointer;">';
      html += '<input type="checkbox" class="wf-se-nav-autofix"' + (step.autoFix !== false ? ' checked' : '') + '> Auto-fix';
      html += '</label>';
      html += '<label style="display:flex;align-items:center;gap:0.2rem;font-size:0.7rem;color:#94a3b8;margin-left:1rem;white-space:nowrap;">Max search distance';
      html += '<input class="wf-se-input wf-se-nav-max-dist" type="number" value="' + escAttr(String(step.maxSearchDistance || 20)) + '" style="max-width:65px;" min="1">';
      html += '</label>';
      html += '</div>';
      // Delay
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-nav-delay" type="number" value="' + escAttr(String(step.delayAfterMs != null ? step.delayAfterMs : 1000)) + '" placeholder="1000" style="max-width:100px;">';
      html += '</div>';
      break;
    }

    case 'click_selector':
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">CSS Selector</span>';
      html += '<input class="wf-se-input wf-se-cs-selector" type="text" value="' + escAttr(step.selector || '') + '" placeholder="e.g. button.submit, #my-btn, [data-action=save]">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Shadow DOM host</span>';
      html += '<input class="wf-se-input wf-se-cs-shadow" type="text" value="' + escAttr(step.shadowDomSelector || '') + '" placeholder="e.g. my-component >>> inner-host (optional)">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Text content</span>';
      html += '<input class="wf-se-input wf-se-cs-text" type="text" value="' + escAttr(step.textContent || '') + '" placeholder="Text to match (optional)">';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Exact match</span>';
      html += '<label style="display:flex;align-items:center;gap:0.35rem;"><input class="wf-se-cs-exact" type="checkbox"' + (step.exactMatch ? ' checked' : '') + '> Match text exactly</label>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Click type</span>';
      var csClickType = step.clickType || 'single';
      html += '<select class="wf-se-input wf-se-cs-click-type" style="max-width:120px;">';
      ['single', 'double', 'right'].forEach(function(t) {
        html += '<option value="' + t + '"' + (csClickType === t ? ' selected' : '') + '>' + t + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="wf-se-row">';
      html += '<span class="wf-se-label">Delay ms</span>';
      html += '<input class="wf-se-input wf-se-cs-delay" type="number" value="' + escAttr(String(step.delayAfterMs != null ? step.delayAfterMs : 1000)) + '" placeholder="1000" style="max-width:100px;">';
      html += '</div>';
      break;

    default:
      html += '<div class="wf-se-row">';
      html += '<span style="color:#64748b;font-size:0.75rem;font-style:italic;">Advanced step type — use the JSON tab for full editing control</span>';
      html += '</div>';
  }

  // Is this step nested inside a group?
  var isNested = String(idx).indexOf('.') !== -1;

  // Action buttons — row 1: save/cancel/move/insert/delete
  html += '<div class="wf-se-actions">';
  html += '<button class="wf-se-btn wf-se-btn-save wf-se-save">Save</button>';
  html += '<button class="wf-se-btn wf-se-cancel">Cancel</button>';
  html += '<button class="wf-se-btn wf-se-up">&uarr; Up</button>';
  html += '<button class="wf-se-btn wf-se-down">&darr; Down</button>';
  if (isNested) {
    html += '<button class="wf-se-btn wf-se-move-out" style="color:#f59e0b;" title="Move this step out of the group to the parent level">&#x2934; Move Out</button>';
  }
  html += '<button class="wf-se-btn wf-se-insert-below" style="color:#38bdf8;">+ Insert</button>';
  html += '<button class="wf-se-btn wf-se-btn-delete wf-se-delete" style="margin-left:auto;">Delete</button>';
  html += '</div>';

  // Action buttons — row 2: wrap/unwrap
  html += '<div class="wf-se-actions" style="border-top:none;padding-top:0;">';
  if (step.type === 'conditional' || step.type === 'loop' || step.type === 'try_catch') {
    html += '<button class="wf-se-btn wf-se-unwrap" style="color:#f59e0b;" title="Move sub-steps out and remove this wrapper">&#x2B73; Unwrap</button>';
  }
  html += '<button class="wf-se-btn wf-se-wrap" data-wrap-type="conditional" style="color:#a78bfa;" title="Wrap this step in a conditional">&#x2696; Wrap in If</button>';
  html += '<button class="wf-se-btn wf-se-wrap" data-wrap-type="loop" style="color:#a78bfa;" title="Wrap this step in a loop">&#x1f501; Wrap in Loop</button>';
  html += '<button class="wf-se-btn wf-se-wrap" data-wrap-type="try_catch" style="color:#a78bfa;" title="Wrap this step in try/catch">&#x1f6e1; Wrap in Try</button>';
  html += '</div>';

  return html;
}
function collectStepEditorValues(editor, step) {
  // Clone the step to preserve all original properties (id, preconditions, screenshotRef, etc.)
  var updated = JSON.parse(JSON.stringify(step));

  // Label (all step types)
  var labelInput = editor.querySelector('.wf-se-step-label');
  if (labelInput) updated.label = labelInput.value;

  switch (step.type) {
    case 'navigate': {
      var urlInput = editor.querySelector('.wf-se-url');
      var waitInput = editor.querySelector('.wf-se-wait-ms');
      if (urlInput) updated.url = urlInput.value;
      if (waitInput) updated.waitMs = parseInt(waitInput.value) || 0;
      var navSelInput = editor.querySelector('.wf-se-nav-selector');
      var navAttrInput = editor.querySelector('.wf-se-nav-attribute');
      var navSelVal = navSelInput ? navSelInput.value.trim() : '';
      var navAttrVal = navAttrInput ? navAttrInput.value.trim() : '';
      if (navSelVal) {
        updated.selectorSource = { selector: navSelVal, attribute: navAttrVal || 'href' };
      } else {
        delete updated.selectorSource;
      }
      break;
    }
    case 'click': {
      var selInput = editor.querySelector('.wf-se-selector');
      var textInput = editor.querySelector('.wf-se-text');
      var ctSelect = editor.querySelector('.wf-se-click-type');
      var delayInput = editor.querySelector('.wf-se-delay-ms');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (textInput) updated.target.textContent = textInput.value;
      if (ctSelect) {
        if (ctSelect.value === 'single') delete updated.clickType;
        else updated.clickType = ctSelect.value;
      }
      if (delayInput) updated.delayAfterMs = parseInt(delayInput.value) || 0;
      break;
    }
    case 'type': {
      var selInput = editor.querySelector('.wf-se-selector');
      var valInput = editor.querySelector('.wf-se-value');
      var clearInput = editor.querySelector('.wf-se-clear');
      var skipClickInput = editor.querySelector('.wf-se-skip-click');
      var delayInput = editor.querySelector('.wf-se-delay-ms');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (valInput) updated.value = valInput.value;
      if (clearInput) updated.clearFirst = clearInput.checked;
      if (skipClickInput) updated.skipClick = skipClickInput.checked;
      if (delayInput) updated.delayAfterMs = parseInt(delayInput.value) || 0;
      break;
    }
    case 'wait': {
      var delayInput = editor.querySelector('.wf-se-delay');
      var selInput = editor.querySelector('.wf-se-wait-selector');
      if (selInput && selInput.value) {
        updated.condition = { type: 'element_visible', target: { selector: selInput.value } };
      } else if (delayInput) {
        updated.condition = { type: 'delay', ms: parseInt(delayInput.value) || 1000 };
      }
      break;
    }
    case 'keyboard': {
      var keyInput = editor.querySelector('.wf-se-key');
      var modsInput = editor.querySelector('.wf-se-mods');
      if (keyInput) updated.key = keyInput.value;
      if (modsInput) updated.modifiers = modsInput.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      break;
    }
    case 'scroll': {
      var dirSelect = editor.querySelector('.wf-se-direction');
      var amountInput = editor.querySelector('.wf-se-amount');
      if (dirSelect) updated.direction = dirSelect.value;
      if (amountInput) updated.amount = parseInt(amountInput.value) || 3;
      break;
    }
    case 'assert': {
      var selInput = editor.querySelector('.wf-se-selector');
      var expectedInput = editor.querySelector('.wf-se-expected');
      var errorInput = editor.querySelector('.wf-se-error-msg');
      if (!updated.target) updated.target = {};
      if (selInput) updated.target.selector = selInput.value;
      if (expectedInput) updated.expectedText = expectedInput.value;
      if (errorInput) updated.errorMessage = errorInput.value || undefined;
      break;
    }
    case 'set_variable': {
      var nameInput = editor.querySelector('.wf-se-varname');
      var valInput = editor.querySelector('.wf-se-varvalue');
      if (nameInput) updated.variable = nameInput.value;
      if (valInput) updated.value = valInput.value;
      break;
    }
    case 'capture_download': {
      var patternInput = editor.querySelector('.wf-se-filename-pattern');
      var maxInput = editor.querySelector('.wf-se-max-files');
      var timeoutInput = editor.querySelector('.wf-se-timeout');
      var outVarInput = editor.querySelector('.wf-se-output-var');
      if (patternInput) updated.filenamePattern = patternInput.value || undefined;
      if (maxInput) updated.maxFiles = parseInt(maxInput.value) || undefined;
      if (timeoutInput) updated.waitTimeoutMs = parseInt(timeoutInput.value) || undefined;
      if (outVarInput) updated.outputVariable = outVarInput.value || undefined;
      break;
    }
    case 'move_file': {
      var srcInput = editor.querySelector('.wf-se-source');
      var destInput = editor.querySelector('.wf-se-destination');
      if (srcInput) updated.source = srcInput.value;
      if (destInput) updated.destination = destInput.value;
      break;
    }
    case 'file_dialog': {
      var fpInput = editor.querySelector('.wf-se-filepath');
      var selInput = editor.querySelector('.wf-se-selector');
      var outVarInput = editor.querySelector('.wf-se-output-var');
      var delayBeforeInput = editor.querySelector('.wf-se-delay-before');
      var delayAfterInput = editor.querySelector('.wf-se-delay-after');
      if (fpInput) updated.filePath = fpInput.value;
      if (selInput) {
        if (selInput.value) {
          if (!updated.trigger) updated.trigger = {};
          updated.trigger.selector = selInput.value;
        } else {
          delete updated.trigger;
        }
      }
      if (outVarInput) updated.outputVariable = outVarInput.value || undefined;
      if (delayBeforeInput) updated.delayBeforeMs = parseInt(delayBeforeInput.value) || undefined;
      if (delayAfterInput) updated.delayAfterMs = parseInt(delayAfterInput.value) || undefined;
      break;
    }
    case 'conditional': {
      var condTypeSelect = editor.querySelector('.wf-se-cond-type');
      if (condTypeSelect) {
        var ct = condTypeSelect.value;
        if (ct === 'expression') {
          var exprInput = editor.querySelector('.wf-se-expression');
          updated.condition = { type: 'expression', expression: exprInput ? exprInput.value : '' };
        } else if (ct === 'element_exists' || ct === 'element_visible') {
          var selInput = editor.querySelector('.wf-se-cond-selector');
          updated.condition = { type: ct, target: { selector: selInput ? selInput.value : '' } };
        } else if (ct === 'url_contains') {
          var subInput = editor.querySelector('.wf-se-cond-substring');
          updated.condition = { type: 'url_contains', substring: subInput ? subInput.value : '' };
        } else if (ct === 'url_matches') {
          var patInput = editor.querySelector('.wf-se-cond-pattern');
          updated.condition = { type: 'url_matches', pattern: patInput ? patInput.value : '' };
        } else if (ct === 'variable_equals') {
          var varInput = editor.querySelector('.wf-se-cond-variable');
          var valInput = editor.querySelector('.wf-se-cond-value');
          updated.condition = { type: 'variable_equals', variable: varInput ? varInput.value : '', value: valInput ? valInput.value : '' };
        }
      }
      break;
    }
    case 'loop': {
      var overInput = editor.querySelector('.wf-se-over-var');
      var itemInput = editor.querySelector('.wf-se-item-var');
      var indexInput = editor.querySelector('.wf-se-index-var');
      if (overInput) updated.overVariable = overInput.value;
      if (itemInput) updated.itemVariable = itemInput.value;
      if (indexInput) updated.indexVariable = indexInput.value || undefined;
      break;
    }
    case 'try_catch': {
      var errVarInput = editor.querySelector('.wf-se-error-var');
      if (errVarInput) updated.errorVariable = errVarInput.value || undefined;
      break;
    }
    case 'inject_style': {
      var actionSelect = editor.querySelector('.wf-se-style-action');
      var selInput = editor.querySelector('.wf-se-style-selector');
      var jsonInput = editor.querySelector('.wf-se-style-json');
      if (actionSelect) updated.action = actionSelect.value;
      if (selInput) updated.selector = selInput.value;
      if (jsonInput) {
        try {
          updated.styles = JSON.parse(jsonInput.value || '{}');
        } catch (e) {
          updated.styles = {};
        }
      }
      break;
    }
    case 'keyboard_nav': {
      var navActions = [];
      var actionRows = editor.querySelectorAll('.wf-se-nav-action-row');
      for (var ri = 0; ri < actionRows.length; ri++) {
        var row = actionRows[ri];
        var keySelect = row.querySelector('.wf-se-nav-key');
        var countInput = row.querySelector('.wf-se-nav-count');
        var matchInput = row.querySelector('.wf-se-nav-match');
        var actionObj = {
          key: keySelect ? keySelect.value : 'tab',
          count: countInput ? (parseInt(countInput.value) || 1) : 1
        };
        if (matchInput && matchInput.value) actionObj.matchText = matchInput.value;
        navActions.push(actionObj);
      }
      updated.actions = navActions.length > 0 ? navActions : [{ key: 'tab', count: 1 }];
      var efText = editor.querySelector('.wf-se-nav-ef-text');
      var efAria = editor.querySelector('.wf-se-nav-ef-aria');
      var efRole = editor.querySelector('.wf-se-nav-ef-role');
      var efTag = editor.querySelector('.wf-se-nav-ef-tag');
      var efSel = editor.querySelector('.wf-se-nav-ef-selector');
      var efPlaceholder = editor.querySelector('.wf-se-nav-ef-placeholder');
      var ef = {};
      if (efText && efText.value) ef.text = efText.value;
      if (efAria && efAria.value) ef.ariaLabel = efAria.value;
      if (efRole && efRole.value) ef.role = efRole.value;
      if (efTag && efTag.value) ef.tag = efTag.value;
      if (efSel && efSel.value) ef.selector = efSel.value;
      if (efPlaceholder && efPlaceholder.value) ef.placeholder = efPlaceholder.value;
      updated.expectedFocus = ef;
      var autoFixCb = editor.querySelector('.wf-se-nav-autofix');
      var maxDistInput = editor.querySelector('.wf-se-nav-max-dist');
      var delayInput = editor.querySelector('.wf-se-nav-delay');
      updated.autoFix = autoFixCb ? autoFixCb.checked : true;
      updated.maxSearchDistance = maxDistInput ? (parseInt(maxDistInput.value) || 20) : 20;
      updated.delayAfterMs = delayInput ? (parseInt(delayInput.value) || 100) : 100;
      break;
    }
    case 'click_selector': {
      var csSelInput = editor.querySelector('.wf-se-cs-selector');
      var csShadowInput = editor.querySelector('.wf-se-cs-shadow');
      var csTextInput = editor.querySelector('.wf-se-cs-text');
      var csExactInput = editor.querySelector('.wf-se-cs-exact');
      var csTypeSelect = editor.querySelector('.wf-se-cs-click-type');
      var csDelayInput = editor.querySelector('.wf-se-cs-delay');
      if (csSelInput) updated.selector = csSelInput.value;
      if (csShadowInput) updated.shadowDomSelector = csShadowInput.value;
      if (csTextInput) updated.textContent = csTextInput.value;
      if (csExactInput) updated.exactMatch = csExactInput.checked;
      if (csTypeSelect) {
        if (csTypeSelect.value === 'single') delete updated.clickType;
        else updated.clickType = csTypeSelect.value;
      }
      if (csDelayInput) updated.delayAfterMs = parseInt(csDelayInput.value) || 0;
      break;
    }
  }

  return updated;
}

// ── Visual View ──────────────────────────────────────────────

/**
 * Describe a condition object as a short human-readable string.
 */
function describeCondition(cond) {
  if (!cond) return '';
  if (typeof cond === 'function') return '[custom function]';
  switch (cond.type) {
    case 'element_exists': return 'element exists: ' + ((cond.target && cond.target.selector) || '?');
    case 'element_visible': return 'element visible: ' + ((cond.target && cond.target.selector) || '?');
    case 'element_text_matches': return 'text matches: ' + (cond.pattern || '?');
    case 'url_matches': return 'URL matches: ' + (cond.pattern || '?');
    case 'url_contains': return 'URL contains: ' + (cond.substring || '?');
    case 'page_title_contains': return 'title contains: ' + (cond.text || '?');
    case 'variable_equals': return (cond.variable || '?') + ' == ' + JSON.stringify(cond.value);
    case 'expression': return cond.expression || '?';
    default: return cond.type || 'unknown';
  }
}

/**
 * Render a flat or nested list of steps with support for control flow nesting.
 * pathPrefix is a dot-path for nested data binding (e.g. '' for root, 'thenSteps.' for nested).
 */
function renderStepList(steps, pathPrefix) {
  var html = '';
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var dataPath = pathPrefix + i;
    var icon = STEP_ICONS[step.type] || '&#x25cf;';
    var isSmart = step.type === 'wait' && step.condition && step.condition.type !== 'delay';

    var isSelected = selectedStepPaths.has(dataPath);
    html += '<div class="wf-step' + (isSelected ? ' wf-step-selected' : '') + '" data-step-idx="' + dataPath + '">';
    html += '<input type="checkbox" class="wf-step-check" data-step-path="' + dataPath + '"' + (isSelected ? ' checked' : '') + ' />';
    html += '<span class="wf-step-num">' + (i + 1) + '</span>';
    html += '<span class="wf-step-icon">' + icon + '</span>';
    html += '<span class="wf-step-label">' + escHtml(step.label || step.id) + '</span>';
    html += '<span class="wf-step-type">' + escHtml(step.type) + '</span>';
    if (isSmart) {
      html += '<span class="wf-step-smart">smart</span>';
    }
    html += '<span class="wf-step-expand">&#x25BC;</span>';
    html += '</div>';

    // Inline editor panel (collapsed by default)
    html += '<div class="wf-step-editor" data-step-idx="' + dataPath + '" style="display:none;">';
    html += renderStepEditor(step, dataPath, steps.length);
    html += '</div>';

    // Render nested sub-steps for control flow types
    if (step.type === 'conditional') {
      html += '<div class="wf-step-condition-desc">if ' + escHtml(describeCondition(step.condition)) + '</div>';
      html += '<div class="wf-step-group-label">Then</div>';
      html += '<div class="wf-step-group">';
      if (step.thenSteps && step.thenSteps.length > 0) {
        html += renderStepList(step.thenSteps, dataPath + '.thenSteps.');
      }
      html += '<button class="wf-se-btn wf-group-insert" data-group-path="' + dataPath + '.thenSteps" style="color:#38bdf8;margin:0.35rem 0;font-size:0.68rem;">+ Add step</button>';
      html += '</div>';
      html += '<div class="wf-step-group-label else">Else</div>';
      html += '<div class="wf-step-group else">';
      if (step.elseSteps && step.elseSteps.length > 0) {
        html += renderStepList(step.elseSteps, dataPath + '.elseSteps.');
      }
      html += '<button class="wf-se-btn wf-group-insert" data-group-path="' + dataPath + '.elseSteps" style="color:#38bdf8;margin:0.35rem 0;font-size:0.68rem;">+ Add step</button>';
      html += '</div>';
    } else if (step.type === 'loop') {
      html += '<div class="wf-step-condition-desc">for each ' + escHtml(step.itemVariable || 'item') + ' in ' + escHtml(step.overVariable || '?') + '</div>';
      html += '<div class="wf-step-group">';
      if (step.steps && step.steps.length > 0) {
        html += renderStepList(step.steps, dataPath + '.steps.');
      }
      html += '<button class="wf-se-btn wf-group-insert" data-group-path="' + dataPath + '.steps" style="color:#38bdf8;margin:0.35rem 0;font-size:0.68rem;">+ Add step</button>';
      html += '</div>';
    } else if (step.type === 'try_catch') {
      html += '<div class="wf-step-group-label">Try</div>';
      html += '<div class="wf-step-group">';
      if (step.trySteps && step.trySteps.length > 0) {
        html += renderStepList(step.trySteps, dataPath + '.trySteps.');
      }
      html += '<button class="wf-se-btn wf-group-insert" data-group-path="' + dataPath + '.trySteps" style="color:#38bdf8;margin:0.35rem 0;font-size:0.68rem;">+ Add step</button>';
      html += '</div>';
      html += '<div class="wf-step-group-label catch">Catch' + (step.errorVariable ? ' (' + escHtml(step.errorVariable) + ')' : '') + '</div>';
      html += '<div class="wf-step-group catch">';
      if (step.catchSteps && step.catchSteps.length > 0) {
        html += renderStepList(step.catchSteps, dataPath + '.catchSteps.');
      }
      html += '<button class="wf-se-btn wf-group-insert" data-group-path="' + dataPath + '.catchSteps" style="color:#38bdf8;margin:0.35rem 0;font-size:0.68rem;">+ Add step</button>';
      html += '</div>';
    }
  }
  return html;
}

/* ── Element Finder Panel ───────────────────────────────────── */

function renderFinderPanel(panel, step, wfId, stepIdx) {
  var state = panel._finderState || {
    screenshot: null,
    viewport: null,
    results: null,
    searchBounds: (step.target && step.target.searchBounds) || null,
    isDrawing: false,
    drawStart: null,
    referenceImage: null,
    loadedSavedScreenshot: false,
  };
  panel._finderState = state;

  // Auto-load saved screenshot if no live screenshot yet
  if (!state.screenshot && !state.loadedSavedScreenshot && step.target && step.target.screenshotPath) {
    state.loadedSavedScreenshot = true;
    // Load asynchronously and re-render when ready
    (function() {
      var img = new Image();
      img.onload = function() {
        // Convert to data URL
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        state.screenshot = canvas.toDataURL('image/png');
        // Use expectedBounds viewport or fall back to image dimensions
        var eb = step.target.expectedBounds;
        state.viewport = (eb && eb.viewportW && eb.viewportH)
          ? { width: eb.viewportW, height: eb.viewportH }
          : { width: img.naturalWidth, height: img.naturalHeight };
        renderFinderPanel(panel, step, wfId, stepIdx);
      };
      img.src = '/api/file?path=' + encodeURIComponent(step.target.screenshotPath);
    })();
  }

  var refImgSrc = step.target && step.target.referenceImage
    ? '/api/file?path=' + encodeURIComponent(step.target.referenceImage)
    : '';

  var html = '';
  html += '<div class="wf-finder-header">';
  html += '<h4>&#x1f50d; Element Finder</h4>';
  html += '<button class="wf-finder-close" title="Close">&times;</button>';
  html += '</div>';
  html += '<div class="wf-finder-toolbar">';
  html += '<button class="wf-finder-capture-btn">&#x1f4f7; Capture</button>';
  html += '<button class="wf-finder-search-btn" disabled>&#x1f50d; Search</button>';
  html += '<button class="wf-finder-area-btn">&#x2b1c; Search Area</button>';
  if (state.searchBounds) {
    html += '<button class="wf-finder-clear-area-btn" style="color:#f87171;">&#x2716; Clear Area</button>';
  }
  html += '</div>';
  html += '<div class="wf-finder-content">';
  html += '<div class="wf-finder-canvas-wrap">';
  html += '<canvas class="wf-finder-canvas" width="800" height="450"></canvas>';
  if (!state.screenshot) {
    html += '<div class="wf-finder-empty">Click "Capture" to take a screenshot of the current page</div>';
  }
  html += '</div>';
  html += '<div class="wf-finder-sidebar">';
  if (refImgSrc) {
    html += '<div class="wf-finder-ref-wrap">';
    html += '<div class="wf-finder-ref-label">Reference</div>';
    html += '<img class="wf-finder-ref-img" src="' + refImgSrc + '" alt="Reference">';
    html += '</div>';
  }
  html += '<div class="wf-finder-results-section">';
  if (state.results) {
    var best = state.results[0];
    var bestSim = best ? (best.similarity || 0) : 0;
    var simPct = (bestSim * 100).toFixed(1);
    var cls = bestSim >= 0.75 ? 'good' : bestSim >= 0.65 ? 'warn' : 'bad';
    html += '<div class="wf-finder-score">Best match: <span class="wf-finder-score-value ' + cls + '">' + simPct + '%</span></div>';
    html += '<div class="wf-finder-score" style="font-size:0.65rem;">' + (state.candidateCount || 0) + ' candidates checked</div>';
    // Ranked list
    html += '<div class="wf-finder-candidates-title">Top matches</div>';
    html += '<div class="wf-finder-candidates">';
    var top = state.results.slice(0, 8);
    for (var ri = 0; ri < top.length; ri++) {
      var r = top[ri];
      var rSim = ((r.similarity || 0) * 100).toFixed(1);
      var rCls = (r.similarity || 0) >= 0.75 ? 'good' : (r.similarity || 0) >= 0.65 ? 'warn' : 'bad';
      html += '<div class="wf-finder-candidate">';
      html += '<span>' + (ri + 1) + '. <span class="wf-finder-score-value ' + rCls + '">' + rSim + '%</span></span>';
      if (r.bounds) {
        html += '<span style="font-size:0.6rem;color:#475569;">(' + Math.round(r.bounds.left) + ',' + Math.round(r.bounds.top) + ')</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    // Update position button
    if (best && best.bounds && step.target && step.target.expectedBounds && state.viewport) {
      var newPctX = ((best.bounds.left + (best.bounds.width || 0) / 2) / state.viewport.width * 100).toFixed(2);
      var newPctY = ((best.bounds.top + (best.bounds.height || 0) / 2) / state.viewport.height * 100).toFixed(2);
      var curPctX = (step.target.expectedBounds.pctX || 0).toFixed(2);
      var curPctY = (step.target.expectedBounds.pctY || 0).toFixed(2);
      if (newPctX !== curPctX || newPctY !== curPctY) {
        html += '<button class="wf-finder-update-btn" data-new-pct-x="' + newPctX + '" data-new-pct-y="' + newPctY + '">Update Position (' + newPctX + '%, ' + newPctY + '%)</button>';
      }
    }
  } else {
    html += '<div style="color:#475569;font-size:0.7rem;font-style:italic;">Run search to see results</div>';
  }
  html += '</div>'; // results-section
  html += '</div>'; // sidebar
  html += '</div>'; // content

  panel.innerHTML = html;

  // Draw canvas if screenshot available
  if (state.screenshot) {
    var canvas = panel.querySelector('.wf-finder-canvas');
    var emptyMsg = panel.querySelector('.wf-finder-empty');
    if (emptyMsg) emptyMsg.remove();
    drawFinderCanvas(canvas, state, step);
    panel.querySelector('.wf-finder-search-btn').disabled = false;
  }

  // ── Wire panel events ──

  // Close
  panel.querySelector('.wf-finder-close').addEventListener('click', function() {
    panel.style.display = 'none';
  });

  // Capture screenshot
  panel.querySelector('.wf-finder-capture-btn').addEventListener('click', async function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Capturing...';
    try {
      var resp = await fetch('/api/bridge/screenshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      var data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Capture failed');
      state.screenshot = data.screenshot;
      state.viewport = data.viewport;
      state.results = null;
      renderFinderPanel(panel, step, wfId, stepIdx);
    } catch (err) {
      toast('Capture failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '\u{1f4f7} Capture';
    }
  });

  // Run search
  panel.querySelector('.wf-finder-search-btn').addEventListener('click', async function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Searching...';
    try {
      var body = {
        referenceImagePath: step.target.referenceImage,
        expectedBounds: step.target.expectedBounds || null,
      };
      if (state.searchBounds) body.searchBounds = state.searchBounds;
      // Use saved screenshot + elements from capture context (ensures correct page state)
      if (step.target.screenshotPath) body.screenshotPath = step.target.screenshotPath;
      if (step.target.savedElementsPath) body.savedElementsPath = step.target.savedElementsPath;
      var resp = await fetch('/api/workflows/' + encodeURIComponent(wfId) + '/visual-find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Search failed');
      state.screenshot = data.screenshot;
      state.viewport = data.viewport;
      state.referenceImage = data.referenceImage;
      state.results = data.results || [];
      state.candidateCount = data.candidateCount || 0;
      renderFinderPanel(panel, step, wfId, stepIdx);
    } catch (err) {
      toast('Search failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '\u{1f50d} Search';
    }
  });

  // Toggle search area drawing mode
  var areaBtn = panel.querySelector('.wf-finder-area-btn');
  if (areaBtn) {
    areaBtn.addEventListener('click', function() {
      state.isDrawing = !state.isDrawing;
      areaBtn.classList.toggle('active', state.isDrawing);
      var canvas = panel.querySelector('.wf-finder-canvas');
      if (canvas) canvas.classList.toggle('drawing', state.isDrawing);
    });
  }

  // Clear search area
  var clearAreaBtn = panel.querySelector('.wf-finder-clear-area-btn');
  if (clearAreaBtn) {
    clearAreaBtn.addEventListener('click', async function() {
      state.searchBounds = null;
      if (step.target) step.target.searchBounds = undefined;
      try {
        await fetch('/api/workflows/' + encodeURIComponent(wfId) + '/search-bounds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ searchBounds: null, referenceImagePath: step.target.referenceImage }),
        });
      } catch (e) { /* ignore */ }
      renderFinderPanel(panel, step, wfId, stepIdx);
    });
  }

  // Update position button
  var updateBtn = panel.querySelector('.wf-finder-update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', async function() {
      var newPctX = parseFloat(updateBtn.getAttribute('data-new-pct-x'));
      var newPctY = parseFloat(updateBtn.getAttribute('data-new-pct-y'));
      if (isNaN(newPctX) || isNaN(newPctY)) return;
      if (step.target && step.target.expectedBounds) {
        step.target.expectedBounds.pctX = newPctX;
        step.target.expectedBounds.pctY = newPctY;
      }
      updateBtn.disabled = true;
      updateBtn.textContent = 'Saving...';
      try {
        var currentWf = _wfCurrentDetail ? _wfCurrentDetail.wf : null;
        if (!currentWf) throw new Error('No workflow loaded');
        await saveWorkflow(wfId, currentWf);
        toast('Position updated to (' + newPctX.toFixed(1) + '%, ' + newPctY.toFixed(1) + '%)', 'success');
        renderFinderPanel(panel, step, wfId, stepIdx);
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
        updateBtn.disabled = false;
        updateBtn.textContent = 'Update Position';
      }
    });
  }

  // Canvas mouse events for search area drawing
  var canvas = panel.querySelector('.wf-finder-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', function(e) {
      if (!state.isDrawing || !state.viewport) return;
      var rect = canvas.getBoundingClientRect();
      var scaleX = state.viewport.width / canvas.width;
      var scaleY = state.viewport.height / canvas.height;
      var canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
      var canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);
      state.drawStart = {
        pctX: (canvasX * scaleX / state.viewport.width) * 100,
        pctY: (canvasY * scaleY / state.viewport.height) * 100,
      };
    });
    canvas.addEventListener('mousemove', function(e) {
      if (!state.isDrawing || !state.drawStart || !state.viewport) return;
      var rect = canvas.getBoundingClientRect();
      var scaleX = state.viewport.width / canvas.width;
      var scaleY = state.viewport.height / canvas.height;
      var canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
      var canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);
      var endPctX = (canvasX * scaleX / state.viewport.width) * 100;
      var endPctY = (canvasY * scaleY / state.viewport.height) * 100;
      state.searchBounds = {
        pctX: Math.min(state.drawStart.pctX, endPctX),
        pctY: Math.min(state.drawStart.pctY, endPctY),
        pctW: Math.abs(endPctX - state.drawStart.pctX),
        pctH: Math.abs(endPctY - state.drawStart.pctY),
      };
      drawFinderCanvas(canvas, state, step);
    });
    canvas.addEventListener('mouseup', async function(e) {
      if (!state.isDrawing || !state.drawStart) return;
      state.isDrawing = false;
      state.drawStart = null;
      var areaBtn2 = panel.querySelector('.wf-finder-area-btn');
      if (areaBtn2) areaBtn2.classList.remove('active');
      canvas.classList.remove('drawing');
      if (state.searchBounds && state.searchBounds.pctW > 1 && state.searchBounds.pctH > 1) {
        if (step.target) step.target.searchBounds = state.searchBounds;
        try {
          await fetch('/api/workflows/' + encodeURIComponent(wfId) + '/search-bounds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ searchBounds: state.searchBounds, referenceImagePath: step.target.referenceImage }),
          });
          toast('Search area saved', 'success');
        } catch (e) { /* ignore */ }
        renderFinderPanel(panel, step, wfId, stepIdx);
      } else {
        state.searchBounds = null;
      }
    });
  }
}

function drawFinderCanvas(canvas, state, step) {
  if (!canvas || !state.screenshot) return;

  var ctx = canvas.getContext('2d');
  var img = new Image();
  img.onload = function() {
    // Scale canvas to image aspect ratio
    var aspect = img.width / img.height;
    canvas.width = Math.min(img.width, 800);
    canvas.height = Math.round(canvas.width / aspect);

    // Draw screenshot
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    var scaleX = canvas.width / img.width;
    var scaleY = canvas.height / img.height;

    // Viewport-to-image scale (screenshots may be at device pixel ratio)
    var vpToImgX = state.viewport ? img.width / state.viewport.width : 1;
    var vpToImgY = state.viewport ? img.height / state.viewport.height : 1;

    // Draw search bounds overlay
    if (state.searchBounds && state.searchBounds.pctW > 0 && state.viewport) {
      var sbLeft = (state.searchBounds.pctX / 100) * state.viewport.width * vpToImgX * scaleX;
      var sbTop = (state.searchBounds.pctY / 100) * state.viewport.height * vpToImgY * scaleY;
      var sbW = (state.searchBounds.pctW / 100) * state.viewport.width * vpToImgX * scaleX;
      var sbH = (state.searchBounds.pctH / 100) * state.viewport.height * vpToImgY * scaleY;

      // Dim everything outside the search area
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, canvas.width, sbTop);
      ctx.fillRect(0, sbTop, sbLeft, sbH);
      ctx.fillRect(sbLeft + sbW, sbTop, canvas.width - sbLeft - sbW, sbH);
      ctx.fillRect(0, sbTop + sbH, canvas.width, canvas.height - sbTop - sbH);

      // Dashed border
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sbLeft, sbTop, sbW, sbH);
      ctx.setLineDash([]);
    }

    // Draw expected position crosshair
    if (step.target && step.target.expectedBounds && state.viewport) {
      var exX = (step.target.expectedBounds.pctX / 100) * state.viewport.width * vpToImgX * scaleX;
      var exY = (step.target.expectedBounds.pctY / 100) * state.viewport.height * vpToImgY * scaleY;
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(exX - 12, exY); ctx.lineTo(exX + 12, exY);
      ctx.moveTo(exX, exY - 12); ctx.lineTo(exX, exY + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(exX, exY, 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw result bounding boxes
    if (state.results && state.viewport) {
      for (var i = state.results.length - 1; i >= 0; i--) {
        var r = state.results[i];
        if (!r.bounds) continue;
        var bx = r.bounds.left * vpToImgX * scaleX;
        var by = r.bounds.top * vpToImgY * scaleY;
        var bw = (r.bounds.width || 20) * vpToImgX * scaleX;
        var bh = (r.bounds.height || 20) * vpToImgY * scaleY;

        var color = i === 0 ? '#22c55e' : (r.similarity || 0) >= 0.65 ? '#eab308' : '#ef4444';
        ctx.strokeStyle = color;
        ctx.lineWidth = i === 0 ? 3 : 1.5;
        ctx.strokeRect(bx, by, bw, bh);

        // Score label
        ctx.fillStyle = color;
        ctx.font = (i === 0 ? 'bold ' : '') + '10px sans-serif';
        var scoreText = ((r.similarity || 0) * 100).toFixed(0) + '%';
        ctx.fillRect(bx, by - 14, ctx.measureText(scoreText).width + 6, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(scoreText, bx + 3, by - 3);
      }
    }
  };
  img.src = state.screenshot;
}

function renderVisualView(wf, source) {
  var html = '';

  // Info bar
  html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">';
  html += infoChip('Site', wf.site || 'unknown');
  html += infoChip('Steps', String(wf.steps.length));
  html += infoChip('Variables', String((wf.variables || []).length));
  var smartCount = wf.steps.filter(function(s) { return s.type === 'wait' && s.condition && s.condition.type !== 'delay'; }).length;
  if (smartCount > 0) html += infoChip('Smart Waits', String(smartCount), '#10b981');
  html += infoChip('Source', source);
  if (wf.metadata && wf.metadata.recordingMode === 'accessibility') {
    html += infoChip('Mode', 'Accessibility', '#3b82f6');
  }
  if (wf.metadata && wf.metadata.createdAt) {
    var d = new Date(wf.metadata.createdAt);
    html += infoChip('Created', d.toLocaleDateString());
  }
  // Model status chip
  if (wf.metadata && wf.metadata.trainingStatus === 'complete') {
    var _verStr = wf.metadata.modelVersion ? 'v' + wf.metadata.modelVersion + ' ' : '';
    html += infoChip('Model', _verStr + '(AUC ' + ((wf.metadata.trainingRun && wf.metadata.trainingRun.bestAuc) || 0).toFixed(3) + ')', '#10b981');
  } else if (wf.metadata && (wf.metadata.trainingStatus === 'training' || wf.metadata.trainingStatus === 'pending')) {
    html += infoChip('Model', 'Training...', '#c4b5fd');
  } else if (wf.metadata && wf.metadata.trainingStatus === 'failed') {
    html += infoChip('Model', 'Failed', '#ef4444');
  }
  html += '</div>';

  // Variables section
  if (wf.variables && wf.variables.length > 0) {
    html += '<div class="wf-section">';
    html += '<div class="wf-section-header">Variables (' + wf.variables.length + ')' + helpIcon('workflows-variables') + '</div>';
    html += '<div class="wf-section-body">';
    for (var i = 0; i < wf.variables.length; i++) {
      var v = wf.variables[i];
      html += '<div class="wf-var-row">';
      html += '<span class="wf-var-name wf-var-rename" data-var-name="' + escAttr(v.name) + '" title="Click to rename">';
      html += escHtml(v.name);
      html += '<span class="wf-var-rename-icon">&#x270E;</span>';
      html += '</span>';
      html += '<span class="wf-var-desc">' + escHtml(v.description || '') + '</span>';
      html += v.required
        ? '<span class="badge badge-missing" style="font-size:0.6rem;">required</span>'
        : '<span class="badge badge-partial" style="font-size:0.6rem;">optional</span>';
      if (v.default !== undefined && v.default !== null) {
        html += '<span class="wf-var-default" title="' + escAttr(String(v.default)) + '">';
        html += 'default: ' + escHtml(truncate(String(v.default), 30));
        html += '</span>';
      }
      if (v.generationPrompt) {
        html += '<span class="wf-var-prompt-badge" data-var-idx="' + i + '" title="' + escAttr(v.generationPrompt) + '">\u{1F916} AI</span>';
      } else {
        html += '<span class="wf-var-prompt-badge wf-var-prompt-add" data-var-idx="' + i + '" title="Add AI generation prompt">+ \u{1F916}</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  // Steps section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header" style="display:flex;align-items:center;gap:0.5rem;">Steps (' + wf.steps.length + ')' + helpIcon('workflows-steps');
  html += '<button class="wf-collapse-nav-btn" id="wf-btn-collapse-nav" style="margin-left:auto;font-size:0.68rem;padding:0.2rem 0.55rem;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:4px;cursor:pointer;" title="Collapse consecutive keyboard steps into keyboard_nav steps">&#x1f9ed; Collapse Nav</button>';
  html += '<button id="wf-btn-rerecord" style="font-size:0.68rem;padding:0.2rem 0.55rem;background:#1e293b;color:#f87171;border:1px solid #7f1d1d;border-radius:4px;cursor:pointer;" title="Re-record all steps for this workflow">&#x23fa; Re-record</button>';
  html += '<div class="wf-batch-bar" id="wf-batch-bar" style="display:none;">';
  html += '<span class="wf-batch-count" id="wf-batch-count">0 selected</span>';
  html += '<button class="wf-batch-delete" id="wf-batch-delete">&#x1f5d1; Delete Selected</button>';
  html += '<button class="wf-batch-clear" id="wf-batch-clear">Clear</button>';
  html += '</div>';
  html += '</div>';
  html += '<div id="wf-rerecord-controls" style="display:none;margin-bottom:0.75rem;"></div>';
  // Re-record element mode selector (shown during re-recording setup)
  html += '<div id="wf-rerecord-mode-selector" style="display:none;margin-bottom:0.75rem;">';
  html += '<div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;">Element Identification Mode</div>';
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:5px;border:1px solid #334155;cursor:pointer;font-size:0.72rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-rerecord-mode" value="standard" style="accent-color:#7c3aed;margin:0;"> Standard';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:5px;border:1px solid #334155;cursor:pointer;font-size:0.72rem;color:#e2e8f0;user-select:none;">';
  html += '<input type="radio" name="wf-rerecord-mode" value="accessibility" style="accent-color:#7c3aed;margin:0;"> Accessibility';
  html += '</label>';
  html += '</div>';
  html += '</div>';
  html += '<div id="wf-rerecord-feed" style="display:none;margin-bottom:0.75rem;padding:0.75rem;background:#0f172a;border:1px solid #1e293b;border-radius:6px;"></div>';
  html += '<div class="wf-section-body">';
  html += renderStepList(wf.steps, '');
  html += '</div>';
  html += '</div>';

  // Metadata
  if (wf.metadata) {
    html += '<div class="wf-section">';
    html += '<div class="wf-section-header">Metadata</div>';
    html += '<div class="wf-section-body" style="font-size:0.75rem;color:#64748b;">';
    if (wf.metadata.createdAt) html += 'Created: ' + escHtml(wf.metadata.createdAt) + '<br>';
    if (wf.metadata.updatedAt) html += 'Updated: ' + escHtml(wf.metadata.updatedAt) + '<br>';
    if (wf.metadata.recordedBy) html += 'Recorded by: ' + escHtml(wf.metadata.recordedBy) + '<br>';
    if (wf.metadata.recordingMode) html += 'Recording mode: ' + escHtml(wf.metadata.recordingMode) + '<br>';
    html += '</div>';
    html += '</div>';
  }

  return html;
}

// ── Model View ──────────────────────────────────────────────

function renderModelView(wf) {
  var html = '';
  var ts = wf.metadata && wf.metadata.trainingStatus;
  var tr = wf.metadata && wf.metadata.trainingRun;

  // Live training status container (populated by polling)
  html += '<div id="wf-training-status"></div>';

  // Current model status section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Model Status' + helpIcon('workflows-model') + '</div>';
  html += '<div class="wf-section-body">';

  if (ts === 'complete') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x2705;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#6ee7b7;">Model Ready</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">Visual verification enabled for this workflow</div>';
    html += '</div>';
    html += '</div>';

    // Version badge
    if (wf.metadata.modelVersion) {
      html += '<div style="margin-bottom:0.75rem;">';
      html += infoChip('Active Version', 'v' + escHtml(wf.metadata.modelVersion), '#6ee7b7');
      html += '</div>';
    }

    // Quality gate result for last training run
    if (tr && tr.version && tr.promoted === false) {
      html += '<div style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.75rem;font-size:0.75rem;">';
      html += '<span style="color:#c4b5fd;font-weight:600;">Quality Gate:</span> ';
      html += '<span style="color:#fbbf24;">v' + escHtml(tr.version) + ' was trained but not promoted</span> ';
      html += '<span style="color:#94a3b8;">(AUC ' + (tr.bestAuc || 0).toFixed(4) + ' &lt; active version)</span>';
      html += '</div>';
    }

    // Stats
    html += '<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;">';
    if (tr && tr.bestAuc) {
      html += infoChip('Best AUC', tr.bestAuc.toFixed(4), '#10b981');
    }
    if (tr && tr.epochs) {
      html += infoChip('Epochs', String(tr.epochs));
    }
    if (tr && tr.completedAt) {
      var d = new Date(tr.completedAt);
      html += infoChip('Trained', d.toLocaleDateString() + ' ' + d.toLocaleTimeString());
    }
    if (tr && tr.worker) {
      html += infoChip('Worker', tr.worker, '#c4b5fd');
    }
    if (tr && tr.version) {
      html += infoChip('Last Version', 'v' + escHtml(tr.version));
    }
    html += '</div>';

    // Model path
    if (wf.metadata.modelPath) {
      html += '<div style="font-size:0.7rem;color:#475569;font-family:monospace;word-break:break-all;">';
      html += escHtml(wf.metadata.modelPath);
      html += '</div>';
    }

  } else if (ts === 'failed') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x274c;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#fca5a5;">Training Failed</div>';
    if (tr && tr.error) {
      html += '<div style="font-size:0.75rem;color:#ef4444;word-break:break-word;">' + escHtml(tr.error) + '</div>';
    }
    html += '</div>';
    html += '</div>';

  } else if (ts === 'training' || ts === 'pending') {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
    html += '<span style="font-size:1.5rem;" class="wf-training-pulse">&#x1f9e0;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#c4b5fd;">Training in Progress</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">Model training will appear above when status updates</div>';
    html += '</div>';
    html += '</div>';

  } else {
    html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
    html += '<span style="font-size:1.5rem;">&#x1f6ab;</span>';
    html += '<div>';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#94a3b8;">No Model</div>';
    html += '<div style="font-size:0.75rem;color:#64748b;">This workflow has no trained model. Visual verification is not available.</div>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  html += '</div>';

  // Training Data section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Training Data</div>';
  html += '<div class="wf-section-body">';
  html += '<div id="wf-training-data-stats"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  // Training controls section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Training</div>';
  html += '<div class="wf-section-body">';

  html += '<div style="font-size:0.78rem;color:#94a3b8;margin-bottom:1rem;">';
  html += 'Train a visual verification model from the element screenshots captured during this workflow\'s recording. ';
  html += 'If a remote GPU worker is available, training will be dispatched there automatically.';
  html += '</div>';

  // Configuration form (compact)
  html += '<div class="wf-model-config">';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Architecture</label>';
  html += '<select id="wf-model-backbone" class="wf-model-select">';
  html += '<option value="mobilenet_v3_small">MobileNet V3 Small (fastest)</option>';
  html += '<option value="efficientnet_b0" selected>EfficientNet B0 (balanced)</option>';
  html += '<option value="resnet18">ResNet-18 (most robust)</option>';
  html += '</select>';
  html += '</div>';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Epochs</label>';
  html += '<input type="number" id="wf-model-epochs" class="wf-model-input" value="150" min="10" max="500">';
  html += '</div>';

  html += '<div class="wf-model-config-row">';
  html += '<label class="wf-model-config-label">Embedding Dim</label>';
  html += '<select id="wf-model-embed-dim" class="wf-model-select">';
  html += '<option value="64">64</option>';
  html += '<option value="128" selected>128</option>';
  html += '<option value="256">256</option>';
  html += '</select>';
  html += '</div>';

  html += '<div class="wf-model-config-row" style="align-items:flex-start;">';
  html += '<label class="wf-model-config-label" style="padding-top:0.15rem;">Data Sources</label>';
  html += '<div id="wf-source-checkboxes" style="display:flex;flex-direction:column;gap:0.35rem;">';
  html += '<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;color:#e2e8f0;cursor:pointer;">';
  html += '<input type="checkbox" id="wf-source-recording" checked> Recording <span id="wf-source-recording-count" style="color:#64748b;font-size:0.7rem;"></span>';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;color:#e2e8f0;cursor:pointer;">';
  html += '<input type="checkbox" id="wf-source-execution" checked> Execution Runs <span id="wf-source-execution-count" style="color:#64748b;font-size:0.7rem;"></span>';
  html += '</label>';
  html += '<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;color:#e2e8f0;cursor:pointer;">';
  html += '<input type="checkbox" id="wf-source-debug" checked> Debug Captures <span id="wf-source-debug-count" style="color:#64748b;font-size:0.7rem;"></span>';
  html += '</label>';
  html += '</div>';
  html += '</div>';

  html += '</div>'; // end config

  // Action buttons
  html += '<div style="display:flex;gap:0.75rem;margin-top:1rem;flex-wrap:wrap;">';

  if (ts === 'training' || ts === 'pending') {
    html += '<button class="btn-secondary" disabled style="opacity:0.5;font-size:0.8rem;padding:0.5rem 1.25rem;">Training in progress...</button>';
  } else if (ts === 'complete') {
    html += '<button class="btn-secondary" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f504; Retrain Model</button>';
  } else if (ts === 'failed') {
    html += '<button class="btn-save" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f504; Retry Training</button>';
  } else {
    html += '<button class="btn-save" id="wf-btn-retrain" style="font-size:0.8rem;padding:0.5rem 1.25rem;">&#x1f9e0; Train Model</button>';
  }

  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Version History section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Version History</div>';
  html += '<div class="wf-section-body">';
  html += '<div id="wf-version-history"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  // Workers section (compact)
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">Workers</div>';
  html += '<div class="wf-section-body">';
  html += '<div style="font-size:0.78rem;color:#94a3b8;margin-bottom:0.75rem;">';
  html += 'Remote GPU workers for faster training. Workers are auto-detected on the local network.';
  html += '</div>';
  html += '<div id="wf-workers-list"><span style="color:#64748b;font-size:0.75rem;">Loading...</span></div>';
  html += '</div>';
  html += '</div>';

  return html;
}

function wireModelViewHandlers(wf) {
  // Retrain button
  var retrainBtn = document.getElementById('wf-btn-retrain');
  if (retrainBtn) {
    retrainBtn.addEventListener('click', async function() {
      retrainBtn.disabled = true;
      retrainBtn.textContent = 'Starting...';
      try {
        // Read config from the form
        var configBody = {};
        var backboneEl = document.getElementById('wf-model-backbone');
        var epochsEl = document.getElementById('wf-model-epochs');
        var embedDimEl = document.getElementById('wf-model-embed-dim');
        if (backboneEl) configBody.backbone = backboneEl.value;
        if (epochsEl) configBody.epochs = parseInt(epochsEl.value, 10);
        if (embedDimEl) configBody.embedDim = parseInt(embedDimEl.value, 10);

        // Read data source checkboxes
        var sources = [];
        var srcRec = document.getElementById('wf-source-recording');
        var srcExec = document.getElementById('wf-source-execution');
        var srcDebug = document.getElementById('wf-source-debug');
        if (srcRec && srcRec.checked) sources.push('recording');
        if (srcExec && srcExec.checked) sources.push('execution');
        if (srcDebug && srcDebug.checked) sources.push('debug');
        if (sources.length === 0) {
          toast('Select at least one data source', 'error');
          retrainBtn.disabled = false;
          retrainBtn.textContent = retrainBtn.dataset.originalText || 'Train Model';
          return;
        }
        // Only send sources filter if not all 3 are selected (all = no filter)
        if (sources.length < 3) {
          configBody.sources = sources;
        }

        var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/training/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configBody),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to start training');
        toast('Training started', 'success');
        startWorkflowTrainingPoll(wf.id);
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
        retrainBtn.disabled = false;
        retrainBtn.textContent = '\u{1f504} Retry Training';
      }
    });
  }

  // Load workers list, version history, and training data stats
  loadModelViewWorkers();
  loadVersionHistory(wf.id);
  loadTrainingDataStats(wf.id);
}

async function loadModelViewWorkers() {
  var listEl = document.getElementById('wf-workers-list');
  if (!listEl) return;

  try {
    var res = await fetch('/api/workers');
    var data = await res.json();
    var workers = data.workers || [];

    if (workers.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">No workers configured. Training will run locally. Workers are auto-discovered on the local network, or add one from the Training tab.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < workers.length; i++) {
      var w = workers[i];
      var statusColor = w.online ? (w.status === 'busy' ? '#f59e0b' : '#10b981') : '#64748b';
      var statusText = w.online ? (w.status === 'busy' ? 'busy' : 'idle') : 'offline';
      var gpuInfo = w.gpu ? escHtml(w.gpu) : 'CPU';

      html += '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.4rem 0;border-bottom:1px solid #1e293b;font-size:0.75rem;">';
      html += '<span style="color:' + statusColor + ';font-size:0.8rem;">&#x25cf;</span>';
      html += '<div style="flex:1;">';
      html += '<span style="font-weight:600;color:#e2e8f0;">' + escHtml(w.name) + '</span>';
      html += ' <span style="color:#64748b;">' + escHtml(w.host) + ':' + w.port + ' &middot; ' + gpuInfo + '</span>';
      html += '</div>';
      html += '<span style="font-size:0.65rem;color:' + statusColor + ';font-weight:600;text-transform:uppercase;">' + statusText + '</span>';
      html += '</div>';
    }

    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load workers</div>';
  }
}

// ── Version History ──────────────────────────────────────────

function compareSemVerJS(a, b) {
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function loadVersionHistory(workflowId) {
  var container = document.getElementById('wf-version-history');
  if (!container) return;

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/model/versions');
    var data = await res.json();
    var versions = data.versions || [];

    if (versions.length === 0) {
      container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">No model versions yet. Train a model to create the first version.</div>';
      return;
    }

    var activeVersion = data.activeVersion;

    // Sort descending (newest first)
    versions.sort(function(a, b) {
      return compareSemVerJS(b.version, a.version);
    });

    var html = '<table class="wf-version-table">';
    html += '<thead><tr>';
    html += '<th>Version</th>';
    html += '<th>AUC</th>';
    html += '<th>Backbone</th>';
    html += '<th>Epochs</th>';
    html += '<th>Trained</th>';
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < versions.length; i++) {
      var v = versions[i];
      var isActive = v.version === activeVersion;
      var isFailed = v.status === 'failed';
      var rowClass = isActive ? ' wf-version-active' : (isFailed ? ' wf-version-failed' : '');

      html += '<tr class="wf-version-row' + rowClass + '">';

      // Version column
      html += '<td class="wf-version-cell-version">';
      html += 'v' + escHtml(v.version);
      if (isActive) html += ' <span class="wf-version-badge-active">ACTIVE</span>';
      if (isFailed) html += ' <span class="wf-version-badge-failed">FAILED</span>';
      html += '</td>';

      // AUC column
      var aucColor = isFailed ? '#64748b' : (v.bestAuc >= 0.95 ? '#6ee7b7' : (v.bestAuc >= 0.90 ? '#fbbf24' : '#f87171'));
      html += '<td style="color:' + aucColor + ';font-weight:600;">' + (isFailed ? '-' : v.bestAuc.toFixed(4)) + '</td>';

      // Backbone column
      var bbShort = (v.backbone || '').replace('mobilenet_v3_small', 'MNv3').replace('efficientnet_b0', 'EffB0').replace('resnet18', 'RN18');
      html += '<td style="color:#94a3b8;">' + escHtml(bbShort) + '</td>';

      // Epochs column
      html += '<td style="color:#94a3b8;">' + (v.epochs || '-') + '</td>';

      // Trained date column
      var d = new Date(v.trainedAt);
      html += '<td style="color:#64748b;">' + d.toLocaleDateString() + '</td>';

      // Action column
      html += '<td>';
      if (!isActive && !isFailed) {
        html += '<button class="btn-secondary wf-version-activate" data-version="' + escHtml(v.version) + '" style="font-size:0.6rem;padding:0.2rem 0.5rem;">Activate</button>';
      }
      html += '</td>';

      html += '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Wire up activate buttons
    container.querySelectorAll('.wf-version-activate').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var version = btn.getAttribute('data-version');
        btn.disabled = true;
        btn.textContent = 'Activating...';
        try {
          var aRes = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/model/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: version }),
          });
          var aData = await aRes.json();
          if (!aRes.ok) throw new Error(aData.error || 'Activation failed');
          toast('Activated v' + version, 'success');
          selectWorkflow(workflowId);
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Activate';
        }
      });
    });

  } catch (err) {
    container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load version history</div>';
  }
}

// ── Training Data Stats ──────────────────────────────────────

async function loadTrainingDataStats(workflowId) {
  var container = document.getElementById('wf-training-data-stats');
  if (!container) return;

  try {
    var res = await fetch('/api/workflows/' + encodeURIComponent(workflowId) + '/training/data');
    var data = await res.json();
    var snap = data.snapshots;
    var crops = data.crops;
    var last = data.lastTraining;
    var html = '';

    // Snapshots stats
    html += '<div class="wf-td-section">';
    html += '<div class="wf-td-title">Snapshots</div>';
    if (snap.total === 0) {
      html += '<div class="wf-td-empty">No snapshots yet. Record a workflow or run it successfully to collect training data.</div>';
    } else {
      html += '<div class="wf-td-grid">';
      html += tdStat(snap.total, 'Snapshots', '#e2e8f0');
      html += tdStat(snap.fromRecording, 'Recording', '#c4b5fd');
      html += tdStat(snap.fromExecution, 'Runs', '#6ee7b7');
      html += tdStat(snap.fromDebug || 0, 'Debug', '#f59e0b');
      html += tdStat(snap.totalElements, 'Elements', '#94a3b8');
      html += tdStat(snap.uniqueSelectors, 'Unique Selectors', '#94a3b8');
      html += tdStat(snap.interactedSelectors, 'Interacted', '#fbbf24');
      html += '</div>';
    }
    html += '</div>';

    // Crops stats (only if data has been prepared)
    if (crops) {
      html += '<div class="wf-td-section">';
      html += '<div class="wf-td-title">Prepared Crops</div>';
      html += '<div class="wf-td-grid">';
      html += tdStat(crops.total, 'Total Crops', '#e2e8f0');
      html += tdStat(crops.uniqueGroups, 'Groups', '#94a3b8');
      html += tdStat(crops.interacted, 'Positive', '#6ee7b7');
      html += tdStat(crops.nonInteracted, 'Negative', '#94a3b8');
      html += '</div>';
      html += '</div>';
    }

    // Last training run info
    if (last) {
      html += '<div class="wf-td-section">';
      html += '<div class="wf-td-title">Last Training (v' + escHtml(last.version) + ')</div>';
      html += '<div class="wf-td-grid">';
      var bbShort = (last.backbone || '').replace('mobilenet_v3_small', 'MobileNet V3').replace('efficientnet_b0', 'EfficientNet B0').replace('resnet18', 'ResNet-18');
      html += tdStat(bbShort, 'Backbone', '#c4b5fd');
      html += tdStat(last.epochs, 'Epochs', '#94a3b8');
      html += tdStat(last.embedDim, 'Embed Dim', '#94a3b8');
      html += tdStat(last.bestAuc.toFixed(4), 'Best AUC', last.bestAuc >= 0.95 ? '#6ee7b7' : (last.bestAuc >= 0.90 ? '#fbbf24' : '#f87171'));
      html += tdStat(last.cropsPerElement + 'x', 'Crops/Element', '#94a3b8');
      var d = new Date(last.trainedAt);
      html += tdStat(d.toLocaleDateString(), 'Trained', '#64748b');
      html += '</div>';
      html += '</div>';
    }

    container.innerHTML = html;

    // Populate source counts next to checkboxes
    var recCount = document.getElementById('wf-source-recording-count');
    if (recCount && snap) recCount.textContent = '(' + snap.fromRecording + ')';
    var execCount = document.getElementById('wf-source-execution-count');
    if (execCount && snap) execCount.textContent = '(' + snap.fromExecution + ')';
    var debugCount = document.getElementById('wf-source-debug-count');
    if (debugCount && snap) debugCount.textContent = '(' + (snap.fromDebug || 0) + ')';
  } catch (err) {
    container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">Failed to load training data stats</div>';
  }
}

function tdStat(value, label, color) {
  return '<div class="wf-td-stat">' +
    '<div class="wf-td-stat-value" style="color:' + (color || '#e2e8f0') + ';">' + value + '</div>' +
    '<div class="wf-td-stat-label">' + escHtml(label) + '</div>' +
    '</div>';
}

// ── JSON View ────────────────────────────────────────────────

function renderJsonView(wf) {
  var html = '';
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">JSON Editor</div>';
  html += '<div class="wf-section-body">';
  html += '<textarea class="wf-json-editor" id="wf-json-editor">' + escHtml(JSON.stringify(wf, null, 2)) + '</textarea>';
  html += '</div>';
  html += '</div>';
  html += '<div class="save-row">';
  html += '<button class="btn-save" id="wf-btn-save-json">Save JSON</button>';
  html += '<span class="save-status" id="wf-save-status"></span>';
  html += '</div>';
  return html;
}

// ── Run View (Dynamic Variable Inputs + Pipeline) ────────────

function renderRunView(wf) {
  var html = '';

  // Workflow info
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">&#x25b6; Run Workflow: ' + escHtml(wf.name) + helpIcon('workflows-run') + '</div>';
  html += '<div class="wf-section-body">';

  var isDesktopWf = wf.site === 'desktop';
  html += '<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:1rem;">';
  html += escHtml(wf.description || 'No description') + '<br>';
  html += '<span style="color:#64748b;">' + (isDesktopWf ? 'Desktop App' : 'Site: ' + escHtml(wf.site || 'any')) + ' &middot; ' + wf.steps.length + ' steps</span>';
  html += '</div>';

  if (isDesktopWf) {
    html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:0.75rem;margin-bottom:1rem;font-size:0.78rem;color:#94a3b8;">';
    html += '<strong style="color:#7dd3fc;">Desktop workflow</strong> — this will control your mouse and keyboard to automate native applications. Make sure the target app is visible on screen before running.';
    html += '</div>';
  }

  // Variable input form (dynamic per workflow)
  if (wf.variables && wf.variables.length > 0) {
    html += '<div style="margin-bottom:1.25rem;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">';
    html += '<div style="font-size:0.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Variables</div>';
    html += '<button class="btn-secondary" id="wf-btn-autofill" style="font-size:0.7rem;padding:0.3rem 0.75rem;" title="Generate sample values for all empty variables">&#x2728; Auto-fill</button>';
    html += '</div>';

    for (var i = 0; i < wf.variables.length; i++) {
      var v = wf.variables[i];
      html += '<div class="wf-run-var" style="margin-bottom:0.75rem;">';
      html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">';
      html += '<label style="font-family:monospace;font-size:0.8rem;font-weight:600;color:#06b6d4;" for="wf-run-var-' + escAttr(v.name) + '">' + escHtml(v.name) + '</label>';
      html += v.required
        ? '<span class="badge badge-missing" style="font-size:0.55rem;">required</span>'
        : '<span class="badge badge-partial" style="font-size:0.55rem;">optional</span>';
      html += '</div>';

      if (v.description) {
        html += '<div style="font-size:0.7rem;color:#64748b;margin-bottom:0.25rem;">' + escHtml(v.description) + '</div>';
      }

      // Input type based on variable type / name
      var inputType = 'text';
      var isTextarea = false;
      var placeholder = v.default !== undefined ? String(v.default) : 'Enter value...';

      // Heuristics for input type
      var nameLower = v.name.toLowerCase();
      if (nameLower.includes('text') || nameLower.includes('caption') || nameLower.includes('content') || nameLower.includes('lyrics') || nameLower.includes('description')) {
        isTextarea = true;
      } else if (nameLower.includes('path') || nameLower.includes('file') || nameLower.includes('dir')) {
        placeholder = '/path/to/file';
      } else if (nameLower.includes('url') || nameLower.includes('link')) {
        inputType = 'url';
        placeholder = 'https://...';
      } else if (nameLower.includes('count') || nameLower.includes('number') || nameLower.includes('amount')) {
        inputType = 'number';
      }

      var savedVal = getRunVarValue(wf.id, v.name, v.default !== undefined ? String(v.default) : '');

      if (isTextarea) {
        html += '<textarea class="wf-var-input wf-run-input" id="wf-run-var-' + escAttr(v.name) + '" name="' + escAttr(v.name) + '"';
        html += ' placeholder="' + escAttr(placeholder) + '"';
        html += ' style="min-height:80px;resize:vertical;">';
        html += escHtml(savedVal);
        html += '</textarea>';
      } else {
        html += '<input class="wf-var-input wf-run-input" type="' + inputType + '" id="wf-run-var-' + escAttr(v.name) + '" name="' + escAttr(v.name) + '"';
        html += ' value="' + escAttr(savedVal) + '"';
        html += ' placeholder="' + escAttr(placeholder) + '">';
      }

      // Per-variable AI generate button
      if (v.generationPrompt) {
        html += '<button class="wf-var-gen-btn" data-var-name="' + escAttr(v.name) + '" title="' + escAttr(v.generationPrompt) + '">\u{1F916} Generate</button>';
      }

      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div style="font-size:0.8rem;color:#64748b;margin-bottom:1rem;">This workflow has no variables — it runs with no inputs needed.</div>';
  }

  html += '</div>';
  html += '</div>';

  // Pipeline section
  html += '<div class="wf-section">';
  html += '<div class="wf-section-header">&#x1f517; Pipeline (Chain Workflows)</div>';
  html += '<div class="wf-section-body">';
  html += '<div style="font-size:0.75rem;color:#64748b;margin-bottom:0.75rem;">Add more workflows to run in sequence after this one. Variables flow forward between steps.</div>';

  html += '<div id="wf-pipeline-list">';
  // Pipeline step 0 is always the current workflow
  html += '<div class="wf-pipeline-step" style="opacity:0.7;">';
  html += '<span class="wf-pipeline-step-num">1</span>';
  html += '<span class="wf-pipeline-step-name">' + escHtml(wf.name) + '</span>';
  html += '<span class="badge badge-ok" style="font-size:0.55rem;">current</span>';
  html += '</div>';
  html += '</div>';

  // Add to pipeline button
  html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;">';
  html += '<select id="wf-pipeline-add-select" style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:4px;padding:0.4rem 0.6rem;color:#e2e8f0;font-size:0.75rem;">';
  html += '<option value="">Add workflow to pipeline...</option>';
  for (var i = 0; i < workflows.length; i++) {
    var w = workflows[i];
    if (w.id !== wf.id) {
      html += '<option value="' + escAttr(w.id) + '">' + escHtml(w.name) + ' (' + w.stepCount + ' steps)</option>';
    }
  }
  html += '</select>';
  html += '<button class="btn-secondary" id="wf-pipeline-add-btn" style="font-size:0.75rem;padding:0.4rem 0.75rem;">+ Add</button>';
  html += '</div>';

  html += '</div>';
  html += '</div>';

  // Run + Debug buttons
  html += '<div class="save-row" style="gap:0.75rem;">';
  html += '<button class="btn-save wf-run-btn" id="wf-btn-run" style="background:#10b981;">&#x25b6; ' + (isDesktopWf ? 'Run Desktop Workflow' : 'Run Workflow') + '</button>';
  html += '<button class="btn-save wf-debug-btn" id="wf-btn-debug" style="background:#3b82f6;">&#x1f50d; Debug</button>';
  html += '<span class="save-status" id="wf-run-status"></span>';
  html += '</div>';

  // Run output area
  html += '<div id="wf-run-output" style="display:none;margin-top:1rem;"></div>';

  return html;
}

// ── Pipeline Rendering ───────────────────────────────────────

function renderPipelineList(currentWf) {
  var listEl = document.querySelector('#wf-pipeline-list');
  if (!listEl) return;

  var html = '';

  // First step is always current workflow
  html += '<div class="wf-pipeline-step" style="opacity:0.7;">';
  html += '<span class="wf-pipeline-step-num">1</span>';
  html += '<span class="wf-pipeline-step-name">' + escHtml(currentWf.name) + '</span>';
  html += '<span class="badge badge-ok" style="font-size:0.55rem;">current</span>';
  html += '</div>';

  for (var i = 0; i < pipelineWorkflows.length; i++) {
    var pw = pipelineWorkflows[i];
    var wfInfo = workflows.find(function(w) { return w.id === pw.id; });
    html += '<div class="wf-pipeline-step">';
    html += '<span class="wf-pipeline-step-num">' + (i + 2) + '</span>';
    html += '<span class="wf-pipeline-step-name">' + escHtml(wfInfo ? wfInfo.name : pw.id) + '</span>';
    html += '<span style="font-size:0.65rem;color:#64748b;">' + (wfInfo ? wfInfo.stepCount + ' steps' : '') + '</span>';
    html += '<button class="wf-pipeline-remove" data-idx="' + i + '" title="Remove" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;padding:0 0.25rem;">&#x2715;</button>';
    html += '</div>';
  }

  listEl.innerHTML = html;

  // Wire remove buttons
  listEl.querySelectorAll('.wf-pipeline-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.dataset.idx);
      pipelineWorkflows.splice(idx, 1);
      renderPipelineList(currentWf);
    });
  });
}

// ── Event Wiring ─────────────────────────────────────────────

function wireUpHandlers(wf, filePath, source) {
  // Tab clicks are handled by delegated listener in initWorkflowDelegation()

  // Publish
  var publishBtn = document.querySelector('#wf-btn-publish');
  if (publishBtn) {
    publishBtn.addEventListener('click', function() {
      if (typeof openPublishDialog === 'function') {
        openPublishDialog(wf, filePath);
      }
    });
  }

  // Rename (button + double-click on title)
  var renameBtn = document.querySelector('#wf-btn-rename');
  if (renameBtn) {
    renameBtn.addEventListener('click', function() { startInlineRename(wf); });
  }
  var titleEl = document.querySelector('#wf-title');
  if (titleEl) {
    titleEl.addEventListener('dblclick', function() { startInlineRename(wf); });
  }

  // Delete
  var deleteBtn = document.querySelector('#wf-btn-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async function() {
      if (!confirm('Delete workflow "' + wf.name + '"? This cannot be undone.')) return;
      try {
        await deleteWorkflow(wf.id);
        toast('Workflow deleted', 'success');
        selectedWorkflow = null;
        initWorkflows();
      } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
      }
    });
  }

  // JSON save
  var saveJsonBtn = document.querySelector('#wf-btn-save-json');
  if (saveJsonBtn) {
    saveJsonBtn.addEventListener('click', async function() {
      var editor = document.querySelector('#wf-json-editor');
      var statusEl = document.querySelector('#wf-save-status');
      if (!editor) return;

      var parsed;
      try {
        parsed = JSON.parse(editor.value);
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'error');
        return;
      }

      saveJsonBtn.disabled = true;
      statusEl.textContent = 'Saving...';

      try {
        await saveWorkflow(wf.id, parsed);
        toast('Workflow saved', 'success');
        statusEl.textContent = 'Saved!';
        setTimeout(function() { statusEl.textContent = ''; }, 2000);
        await fetchWorkflows();
        selectWorkflow(wf.id);
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
        statusEl.textContent = '';
      } finally {
        saveJsonBtn.disabled = false;
      }
    });
  }

  // Pipeline add
  var pipelineAddBtn = document.querySelector('#wf-pipeline-add-btn');
  if (pipelineAddBtn) {
    pipelineAddBtn.addEventListener('click', function() {
      var select = document.querySelector('#wf-pipeline-add-select');
      if (!select || !select.value) return;
      pipelineWorkflows.push({ id: select.value });
      select.value = '';
      renderPipelineList(wf);
    });
  }

  // Render initial pipeline list
  if (detailView === 'run') {
    renderPipelineList(wf);
  }

  // Model view handlers
  if (detailView === 'model') {
    wireModelViewHandlers(wf);
  }

  // Run button
  var runBtn = document.querySelector('#wf-btn-run');
  if (runBtn) {
    runBtn.addEventListener('click', function() {
      runWorkflow(wf);
    });
  }

  // Debug button
  var debugBtn = document.querySelector('#wf-btn-debug');
  if (debugBtn) {
    debugBtn.addEventListener('click', function() {
      startDebugMode(wf);
    });
  }

  // Auto-fill button
  var autofillBtn = document.querySelector('#wf-btn-autofill');
  if (autofillBtn) {
    autofillBtn.addEventListener('click', function() {
      autoFillVariables(wf);
    });
  }

  // Collapse Nav button
  var collapseNavBtn = document.querySelector('#wf-btn-collapse-nav');
  if (collapseNavBtn) {
    collapseNavBtn.addEventListener('click', async function() {
      var originalCount = wf.steps.length;
      var collapsed = collapseKeyboardSteps(wf.steps);
      var newCount = collapsed.length;
      if (newCount === originalCount) {
        toast('No consecutive keyboard nav steps found to collapse', 'info');
        return;
      }
      wf.steps = collapsed;
      collapseNavBtn.disabled = true;
      collapseNavBtn.textContent = 'Collapsing...';
      try {
        await saveWorkflow(wf.id, wf);
        var diff = originalCount - newCount;
        toast('Collapsed ' + originalCount + ' steps \u2192 ' + newCount + ' steps (' + diff + ' step' + (diff !== 1 ? 's' : '') + ' merged)', 'success');
        renderWorkflowDetail(wf, filePath, source);
      } catch (err) {
        toast('Collapse failed: ' + err.message, 'error');
        collapseNavBtn.disabled = false;
        collapseNavBtn.textContent = '\u{1F9ED} Collapse Nav';
      }
    });
  }

  // Re-record button
  var rerecordBtn = document.querySelector('#wf-btn-rerecord');
  if (rerecordBtn) {
    rerecordBtn.addEventListener('click', function() {
      if (!confirm('Re-record all steps for "' + wf.name + '"? This will replace the existing steps with freshly recorded ones.')) return;
      startReRecording(wf, filePath, source);
    });
  }

  // Variable rename — click variable name to edit inline
  document.querySelectorAll('.wf-var-rename').forEach(function(el) {
    el.addEventListener('click', function() {
      var oldName = el.getAttribute('data-var-name');
      if (!oldName) return;

      // Replace span with inline input
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'wf-var-rename-input';
      input.value = oldName;
      el.replaceWith(input);
      input.focus();
      input.select();

      var submitted = false;
      async function doRename() {
        if (submitted) return;
        submitted = true;
        var newName = input.value.trim();
        if (!newName || newName === oldName) {
          // Cancelled — re-render
          selectWorkflow(selectedWorkflow);
          return;
        }
        try {
          var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id) + '/rename-variable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldName: oldName, newName: newName }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Rename failed');
          toast('Renamed ' + oldName + ' \u2192 ' + newName, 'success');
          await fetchWorkflows();
          selectWorkflow(selectedWorkflow);
        } catch (err) {
          toast('Rename failed: ' + err.message, 'error');
          selectWorkflow(selectedWorkflow);
        }
      }

      input.addEventListener('blur', doRename);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { submitted = true; selectWorkflow(selectedWorkflow); }
      });
    });
  });

  // AI generation prompt badge — click to edit prompt inline (visual view)
  document.querySelectorAll('.wf-var-prompt-badge').forEach(function(badge) {
    badge.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = parseInt(badge.getAttribute('data-var-idx'));
      if (isNaN(idx) || !wf.variables || !wf.variables[idx]) return;
      var v = wf.variables[idx];
      var row = badge.closest('.wf-var-row');
      if (!row) return;

      // Check if editor already open
      if (row.querySelector('.wf-var-prompt-editor-wrap')) return;

      // Create inline editor below the row
      var wrap = document.createElement('div');
      wrap.className = 'wf-var-prompt-editor-wrap';
      wrap.style.cssText = 'margin-top:0.35rem;display:flex;flex-direction:column;gap:0.35rem;width:100%;';

      var textarea = document.createElement('textarea');
      textarea.className = 'wf-var-prompt-editor';
      textarea.value = v.generationPrompt || '';
      textarea.placeholder = 'Describe what to generate for "' + v.name + '"...';

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:0.4rem;justify-content:flex-end;';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'btn-secondary';
      cancelBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;';

      var saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save Prompt';
      saveBtn.className = 'btn-primary';
      saveBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;';

      var removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove Prompt';
      removeBtn.style.cssText = 'font-size:0.68rem;padding:0.25rem 0.6rem;background:none;color:#ef4444;border:1px solid #ef4444;border-radius:4px;cursor:pointer;margin-right:auto;';

      btnRow.appendChild(removeBtn);
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(saveBtn);
      wrap.appendChild(textarea);
      wrap.appendChild(btnRow);
      row.appendChild(wrap);
      textarea.focus();

      cancelBtn.addEventListener('click', function() { wrap.remove(); });

      async function savePrompt(newPrompt) {
        // Update the variable in the workflow and save
        var updatedWf = JSON.parse(JSON.stringify(wf));
        if (newPrompt) {
          updatedWf.variables[idx].generationPrompt = newPrompt;
        } else {
          delete updatedWf.variables[idx].generationPrompt;
        }
        try {
          var res = await fetch('/api/workflows/' + encodeURIComponent(wf.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow: updatedWf }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Save failed');
          toast(newPrompt ? 'AI prompt saved' : 'AI prompt removed', 'success');
          await fetchWorkflows();
          selectWorkflow(selectedWorkflow);
        } catch (err) {
          toast('Save failed: ' + err.message, 'error');
        }
      }

      saveBtn.addEventListener('click', function() { savePrompt(textarea.value.trim()); });
      removeBtn.addEventListener('click', function() { savePrompt(''); });
    });
  });

  // Per-variable AI generate button (run view)
  document.querySelectorAll('.wf-var-gen-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var varName = btn.getAttribute('data-var-name');
      if (!varName) return;
      var v = (wf.variables || []).find(function(x) { return x.name === varName; });
      if (!v || !v.generationPrompt) return;

      var inputEl = document.querySelector('#wf-run-var-' + CSS.escape(varName));
      if (!inputEl) return;

      var origHtml = btn.innerHTML;
      btn.innerHTML = '\u23F3';
      btn.disabled = true;

      fetch('/api/generate-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variableName: v.name,
          generationPrompt: v.generationPrompt,
          workflowName: wf.name,
          site: wf.site,
          variableType: v.type,
        }),
      })
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success && data.value !== undefined) {
          inputEl.value = String(data.value);
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          toast('Generated value for ' + varName, 'success');
        } else {
          throw new Error(data.error || 'Generation failed');
        }
      })
      .catch(function(err) {
        toast('Generate failed: ' + err.message, 'error');
      })
      .finally(function() {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      });
    });
  });

  // ── Step editor expand/collapse + actions ─────────────────
  var container = document.querySelector('#wf-detail-content') || document;

  // ── Batch selection helpers ───────────────────────────────

  function getAllStepPaths() {
    var paths = [];
    container.querySelectorAll('.wf-step[data-step-idx]').forEach(function(row) {
      paths.push(row.getAttribute('data-step-idx'));
    });
    return paths;
  }

  function updateBatchBar() {
    var bar = document.getElementById('wf-batch-bar');
    var count = document.getElementById('wf-batch-count');
    if (!bar) return;
    if (selectedStepPaths.size > 0) {
      bar.style.display = 'flex';
      count.textContent = selectedStepPaths.size + ' selected';
    } else {
      bar.style.display = 'none';
    }
  }

  function toggleStepSelection(path, checked) {
    if (checked) {
      selectedStepPaths.add(path);
    } else {
      selectedStepPaths.delete(path);
    }
    var row = container.querySelector('.wf-step[data-step-idx="' + path + '"]');
    if (row) {
      row.classList.toggle('wf-step-selected', checked);
      var cb = row.querySelector('.wf-step-check');
      if (cb) cb.checked = checked;
    }
    updateBatchBar();
  }

  container.querySelectorAll('.wf-step[data-step-idx]').forEach(function(row) {
    row.addEventListener('click', function(e) {
      // Don't toggle if clicking inside an editor
      if (e.target.closest('.wf-step-editor')) return;

      // Handle checkbox clicks — toggle selection, don't expand/collapse
      if (e.target.classList.contains('wf-step-check')) {
        var path = e.target.getAttribute('data-step-path');
        var checked = e.target.checked;

        // Shift-click range select
        if (e.shiftKey && lastCheckedStepPath !== null) {
          var allPaths = getAllStepPaths();
          var startIdx = allPaths.indexOf(lastCheckedStepPath);
          var endIdx = allPaths.indexOf(path);
          if (startIdx !== -1 && endIdx !== -1) {
            var lo = Math.min(startIdx, endIdx);
            var hi = Math.max(startIdx, endIdx);
            for (var si = lo; si <= hi; si++) {
              toggleStepSelection(allPaths[si], true);
            }
          }
        } else {
          toggleStepSelection(path, checked);
        }
        lastCheckedStepPath = path;
        return; // Don't expand/collapse
      }

      var pathStr = row.getAttribute('data-step-idx');
      var editor = container.querySelector('.wf-step-editor[data-step-idx="' + pathStr + '"]');
      if (!editor) return;
      var isOpen = editor.style.display !== 'none';
      // Collapse all editors
      container.querySelectorAll('.wf-step-editor').forEach(function(ed) { ed.style.display = 'none'; });
      container.querySelectorAll('.wf-step').forEach(function(r) { r.classList.remove('wf-step-expanded'); });
      if (!isOpen) {
        editor.style.display = 'block';
        row.classList.add('wf-step-expanded');
      }
    });
  });

  // ── Batch action handlers ──────────────────────────────────

  var batchDeleteBtn = document.getElementById('wf-batch-delete');
  if (batchDeleteBtn) {
    batchDeleteBtn.addEventListener('click', async function() {
      var count = selectedStepPaths.size;
      if (count === 0) return;
      if (!confirm('Delete ' + count + ' step' + (count > 1 ? 's' : '') + '? This cannot be undone.')) return;

      // Sort paths descending so splicing doesn't shift subsequent indices.
      // Group by parent array to handle nested paths correctly.
      var paths = Array.from(selectedStepPaths);

      // Sort descending: for paths at same nesting level, higher indices first.
      // For different nesting levels, deeper paths first, then shallower.
      paths.sort(function(a, b) {
        var aParts = a.split('.');
        var bParts = b.split('.');
        // Compare by depth first (deeper = process first), then by index descending
        if (aParts.length !== bParts.length) return bParts.length - aParts.length;
        // Same depth — compare rightmost index descending
        var aIdx = parseInt(aParts[aParts.length - 1]);
        var bIdx = parseInt(bParts[bParts.length - 1]);
        return bIdx - aIdx;
      });

      for (var di = 0; di < paths.length; di++) {
        var r = resolveStepPath(wf.steps, paths[di]);
        if (r) {
          r.array.splice(r.index, 1);
        }
      }

      var varsRemoved = removeOrphanedVariables(wf);
      batchDeleteBtn.disabled = true;
      batchDeleteBtn.textContent = 'Deleting...';
      try {
        await saveWorkflow(wf.id, wf);
        var msg = 'Deleted ' + count + ' step' + (count > 1 ? 's' : '');
        if (varsRemoved > 0) msg += ', removed ' + varsRemoved + ' unused variable' + (varsRemoved > 1 ? 's' : '');
        toast(msg, 'success');
        selectedStepPaths.clear();
        lastCheckedStepPath = null;
        renderWorkflowDetail(wf, filePath, source);
      } catch (err) {
        toast('Batch delete failed: ' + err.message, 'error');
        batchDeleteBtn.disabled = false;
        batchDeleteBtn.textContent = '🗑 Delete Selected';
      }
    });
  }

  var batchClearBtn = document.getElementById('wf-batch-clear');
  if (batchClearBtn) {
    batchClearBtn.addEventListener('click', function() {
      selectedStepPaths.clear();
      lastCheckedStepPath = null;
      container.querySelectorAll('.wf-step-selected').forEach(function(r) {
        r.classList.remove('wf-step-selected');
      });
      container.querySelectorAll('.wf-step-check').forEach(function(cb) {
        cb.checked = false;
      });
      updateBatchBar();
    });
  }

  // Wire step editor action buttons
  container.querySelectorAll('.wf-step-editor[data-step-idx]').forEach(function(editor) {
    var pathStr = editor.getAttribute('data-step-idx');
    var resolved = resolveStepPath(wf.steps, pathStr);
    if (!resolved) return;

    // Prevent clicks inside editor from toggling the row
    editor.addEventListener('click', function(e) { e.stopPropagation(); });

    // Save
    var saveBtn = editor.querySelector('.wf-se-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || !r.step) return;
        var updated = collectStepEditorValues(editor, r.step);
        // Preserve sub-step arrays for control flow types
        if (r.step.thenSteps) updated.thenSteps = r.step.thenSteps;
        if (r.step.elseSteps) updated.elseSteps = r.step.elseSteps;
        if (r.step.steps) updated.steps = r.step.steps;
        if (r.step.trySteps) updated.trySteps = r.step.trySteps;
        if (r.step.catchSteps) updated.catchSteps = r.step.catchSteps;
        r.array[r.index] = updated;
        var varsAdded = ensureStepVariablesDeclared(wf, updated);
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          await saveWorkflow(wf.id, wf);
          var msg = 'Step saved';
          if (varsAdded > 0) msg += ' — ' + varsAdded + ' variable' + (varsAdded > 1 ? 's' : '') + ' added';
          toast(msg, 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Save failed: ' + err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      });
    }

    // Cancel
    var cancelBtn = editor.querySelector('.wf-se-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        editor.style.display = 'none';
        var row = container.querySelector('.wf-step[data-step-idx="' + pathStr + '"]');
        if (row) row.classList.remove('wf-step-expanded');
      });
    }

    // Delete
    var deleteBtn = editor.querySelector('.wf-se-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r) return;
        var label = r.step ? (r.step.label || r.step.id || 'this step') : 'this step';
        if (!confirm('Delete step "' + label + '"? This cannot be undone.')) return;
        r.array.splice(r.index, 1);
        var varsRemoved = removeOrphanedVariables(wf);
        deleteBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          var msg = 'Step deleted';
          if (varsRemoved > 0) msg += ', removed ' + varsRemoved + ' unused variable' + (varsRemoved > 1 ? 's' : '');
          toast(msg, 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Delete failed: ' + err.message, 'error');
          deleteBtn.disabled = false;
        }
      });
    }

    // Move Up
    var upBtn = editor.querySelector('.wf-se-up');
    if (upBtn) {
      upBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || r.index <= 0) { toast('Already at top', 'info'); return; }
        var tmp = r.array[r.index];
        r.array[r.index] = r.array[r.index - 1];
        r.array[r.index - 1] = tmp;
        upBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step moved up', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Move failed: ' + err.message, 'error');
          upBtn.disabled = false;
        }
      });
    }

    // Move Down
    var downBtn = editor.querySelector('.wf-se-down');
    if (downBtn) {
      downBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || r.index >= r.array.length - 1) { toast('Already at bottom', 'info'); return; }
        var tmp = r.array[r.index];
        r.array[r.index] = r.array[r.index + 1];
        r.array[r.index + 1] = tmp;
        downBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step moved down', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Move failed: ' + err.message, 'error');
          downBtn.disabled = false;
        }
      });
    }

    // Move Out — move a nested step to the parent level (after the wrapper)
    var moveOutBtn = editor.querySelector('.wf-se-move-out');
    if (moveOutBtn) {
      moveOutBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || !r.step) return;

        // Parse the path to find parent: e.g. "4.thenSteps.0" → parent at "4", prop "thenSteps"
        var parentInfo = getParentFromPath(wf.steps, pathStr);
        if (!parentInfo) { toast('Cannot move out — already at top level', 'info'); return; }

        // Remove from current sub-array
        var stepCopy = JSON.parse(JSON.stringify(r.step));
        r.array.splice(r.index, 1);

        // Insert into parent array right after the wrapper step
        parentInfo.parentArray.splice(parentInfo.parentIndex + 1, 0, stepCopy);

        moveOutBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step moved out', 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Move out failed: ' + err.message, 'error');
          moveOutBtn.disabled = false;
        }
      });
    }

    // Insert Step Below
    var insertBtn = editor.querySelector('.wf-se-insert-below');
    if (insertBtn) {
      insertBtn.addEventListener('click', function() {
        showInsertPicker(editor, wf, pathStr, filePath, source, function(targetArray, insertIdx) {
          // Default: insert after current step in same array
          var r = resolveStepPath(wf.steps, pathStr);
          return { array: r.array, index: r.index + 1 };
        });
      });
    }

    // Wrap in Conditional/Loop/Try-Catch
    editor.querySelectorAll('.wf-se-wrap').forEach(function(wrapBtn) {
      wrapBtn.addEventListener('click', async function() {
        var wrapType = wrapBtn.getAttribute('data-wrap-type');
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || !r.step) return;

        var wrapped = JSON.parse(JSON.stringify(r.step));
        var wrapper;
        if (wrapType === 'conditional') {
          wrapper = {
            id: 'step-' + Date.now() + '-conditional',
            type: 'conditional',
            label: 'Conditional',
            condition: { type: 'expression', expression: '' },
            thenSteps: [wrapped],
            elseSteps: [],
          };
        } else if (wrapType === 'loop') {
          wrapper = {
            id: 'step-' + Date.now() + '-loop',
            type: 'loop',
            label: 'Loop',
            overVariable: '',
            itemVariable: 'item',
            indexVariable: '',
            steps: [wrapped],
          };
        } else if (wrapType === 'try_catch') {
          wrapper = {
            id: 'step-' + Date.now() + '-try_catch',
            type: 'try_catch',
            label: 'Try / Catch',
            trySteps: [wrapped],
            catchSteps: [],
            errorVariable: 'error',
          };
        }
        if (!wrapper) return;

        r.array[r.index] = wrapper;
        wrapBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Step wrapped in ' + wrapType.replace('_', '/'), 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Wrap failed: ' + err.message, 'error');
          r.array[r.index] = wrapped; // revert
          wrapBtn.disabled = false;
        }
      });
    });

    // Unwrap — move sub-steps out and remove wrapper
    var unwrapBtn = editor.querySelector('.wf-se-unwrap');
    if (unwrapBtn) {
      unwrapBtn.addEventListener('click', async function() {
        var r = resolveStepPath(wf.steps, pathStr);
        if (!r || !r.step) return;

        // Gather all sub-steps
        var subSteps = [];
        if (r.step.type === 'conditional') {
          subSteps = (r.step.thenSteps || []).concat(r.step.elseSteps || []);
        } else if (r.step.type === 'loop') {
          subSteps = r.step.steps || [];
        } else if (r.step.type === 'try_catch') {
          subSteps = (r.step.trySteps || []).concat(r.step.catchSteps || []);
        }

        if (subSteps.length === 0) {
          if (!confirm('This wrapper has no sub-steps. Delete it?')) return;
        }

        // Replace the wrapper with its sub-steps
        r.array.splice(r.index, 1, ...subSteps);
        unwrapBtn.disabled = true;
        try {
          await saveWorkflow(wf.id, wf);
          toast('Unwrapped ' + subSteps.length + ' step' + (subSteps.length !== 1 ? 's' : ''), 'success');
          renderWorkflowDetail(wf, filePath, source);
        } catch (err) {
          toast('Unwrap failed: ' + err.message, 'error');
          unwrapBtn.disabled = false;
        }
      });
    }
  });

  // Wire "Find Element" buttons
  container.querySelectorAll('.wf-se-find-element').forEach(function(findBtn) {
    findBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var editor = findBtn.closest('.wf-step-editor');
      if (!editor) return;
      var pathStr = editor.getAttribute('data-step-idx');
      var resolved = resolveStepPath(wf.steps, pathStr);
      if (!resolved || !resolved.step) return;
      var panel = editor.querySelector('.wf-se-finder-panel');
      if (!panel) return;
      if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      renderFinderPanel(panel, resolved.step, wf.id, resolved.index);
    });
  });

  // Wire "+ Add step" buttons inside sub-step groups
  container.querySelectorAll('.wf-group-insert').forEach(function(groupInsertBtn) {
    groupInsertBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var groupPath = groupInsertBtn.getAttribute('data-group-path');
      showInsertPickerForGroup(groupInsertBtn, wf, groupPath, filePath, source);
    });
  });
}

/**
 * Show the step type picker inline. Used by both "Insert Below" and group "+ Add step".
 * getInsertPoint is a function returning { array, index } for where to insert.
 */
function showInsertPicker(anchorEl, wf, pathStr, filePath, source, getInsertPoint) {
  // Toggle inline type picker
  var existing = anchorEl.closest('.wf-step-editor, .wf-step-group')?.querySelector('.wf-se-insert-picker');
  if (existing) { existing.remove(); return; }

  var pickerHtml = '<div class="wf-se-insert-picker" style="margin-top:0.5rem;padding:0.5rem;background:#1e293b;border:1px solid #334155;border-radius:6px;">';
  pickerHtml += '<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.5rem;">Select step type to insert:</div>';
  pickerHtml += '<div style="display:flex;flex-wrap:wrap;gap:0.35rem;">';
  var allTypes = ['navigate', 'click', 'click_selector', 'type', 'wait', 'keyboard', 'keyboard_nav', 'scroll', 'assert', 'set_variable', 'file_dialog', 'capture_download', 'move_file', 'conditional', 'loop', 'try_catch', 'inject_style'];
  for (var ti = 0; ti < allTypes.length; ti++) {
    var t = allTypes[ti];
    var tIcon = STEP_ICONS[t] || '&#x25cf;';
    pickerHtml += '<button class="wf-se-btn wf-se-insert-type" data-insert-type="' + t + '" style="font-size:0.7rem;padding:0.25rem 0.5rem;">' + tIcon + ' ' + t + '</button>';
  }
  pickerHtml += '</div>';
  pickerHtml += '</div>';

  anchorEl.closest('.wf-step-editor, .wf-step-group, .wf-se-actions')?.insertAdjacentHTML('beforeend', pickerHtml);
  // Find the just-inserted picker
  var parentEl = anchorEl.closest('.wf-step-editor, .wf-step-group, .wf-se-actions');
  if (!parentEl) return;
  parentEl.querySelectorAll('.wf-se-insert-type').forEach(function(typeBtn) {
    typeBtn.addEventListener('click', async function() {
      var newType = typeBtn.getAttribute('data-insert-type');
      var newStep = buildDefaultStep(newType);
      newStep.id = 'step-' + Date.now() + '-' + newType;
      newStep.label = newStep.label || buildStepLabel(newStep, 0);

      var ip = getInsertPoint();
      if (!ip) return;
      ip.array.splice(ip.index, 0, newStep);
      typeBtn.disabled = true;
      try {
        await saveWorkflow(wf.id, wf);
        toast('Step inserted', 'success');
        renderWorkflowDetail(wf, filePath, source);
      } catch (err) {
        toast('Insert failed: ' + err.message, 'error');
        ip.array.splice(ip.index, 1);
        typeBtn.disabled = false;
      }
    });
  });
}

/**
 * Show the step type picker for "+ Add step" buttons inside sub-step groups.
 */
function showInsertPickerForGroup(btn, wf, groupPath, filePath, source) {
  // groupPath is like "3.thenSteps" — we need to find the parent step's sub-array
  var parts = groupPath.split('.');
  var propName = parts.pop(); // e.g. "thenSteps"
  var parentPath = parts.join('.');

  var parentResolved = resolveStepPath(wf.steps, parentPath);
  if (!parentResolved || !parentResolved.step) return;
  var subArray = parentResolved.step[propName];
  if (!subArray) {
    parentResolved.step[propName] = [];
    subArray = parentResolved.step[propName];
  }

  showInsertPicker(btn, wf, groupPath, filePath, source, function() {
    return { array: subArray, index: subArray.length };
  });
}
