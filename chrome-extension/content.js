/**
 * Woodbury Bridge — Content Script
 *
 * Runs in the context of each web page. Handles DOM queries, element location,
 * page structure analysis, text extraction, and element interaction.
 *
 * The background service worker sends messages here; this script does the
 * actual DOM work and returns results.
 */

// Guard against duplicate injection — when content script is re-injected via
// executeScript (e.g. after navigation), we want to preserve recording state
// and avoid orphaned event listeners. We use a window-level flag to detect this.
if (window.__woodburyContentScriptLoaded) {
  // Already loaded. Don't re-register listeners. But do NOT block — the script
  // just stops defining new things because all the functions below use
  // `function` declarations which get hoisted but are harmless to re-declare.
  console.log('[Woodbury Bridge] Content script already loaded, skipping re-init');
}

if (!window.__woodburyContentScriptLoaded) {
  window.__woodburyContentScriptLoaded = true;

// ── Injected style tracking ──────────────────────────────────
// Maps selector → array of { el, originalStyle } for clean revert
const _woodburyInjectedStyles = new Map();

// ── Message listener ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, params } = message;

  // All handlers are async, so we use this pattern
  handleAction(action, params || {})
    .then(result => sendResponse({ success: true, data: result }))
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // Keep the message channel open for async response
});

// ── Action dispatcher ────────────────────────────────────────

async function handleAction(action, params) {
  switch (action) {
    case 'ping':
      return {
        pong: true,
        url: location.href,
        title: document.title,
        chromeOffset: getChromeOffset()
      };

    case 'find_elements':
      return findElements(params);

    case 'find_element_by_text':
      return findElementByText(params);

    case 'find_elements_with_text':
      return findElementsWithText(params);

    case 'find_interactive':
      return findInteractive(params);

    case 'get_element_bounds':
      return getElementBounds(params);

    case 'get_page_structure':
      return getPageStructure(params);

    case 'get_page_text':
      return getPageText(params);

    case 'get_form_fields':
      return getFormFields(params);

    case 'click_element':
      return clickElement(params);

    case 'set_value':
      return setValue(params);

    case 'get_element_info':
      return getElementInfo(params);

    case 'scroll_to_element':
      return scrollToElement(params);

    case 'get_clickable_elements':
      return getClickableElements(params);

    case 'get_page_info':
      return getPageInfo();

    case 'highlight_element':
      return highlightElement(params);

    case 'wait_for_element':
      return waitForElement(params);

    case 'detect_spinners':
      return detectSpinners(params);

    case 'set_recording_mode':
      console.log('[Woodbury REC:content] set_recording_mode', params, 'current recordingActive:', recordingActive);
      if (params?.mode) {
        recordingModeType = params.mode; // 'standard' or 'accessibility'
      }
      if (params?.enabled) {
        startRecording();
      } else {
        stopRecording();
      }
      console.log('[Woodbury REC:content] recordingActive after:', recordingActive, 'mode:', recordingModeType);
      return { recording: recordingActive, mode: recordingModeType };

    // ── Element Snapshot (ML training data) ──────────────────
    case 'snapshot_interactive_elements':
      return snapshotInteractiveElements();

    // ── Workflow Debug Overlay ───────────────────────────────
    case 'show_debug_overlay':
      return showDebugOverlay(params);

    case 'update_debug_step':
      return updateDebugStep(params);

    case 'hide_debug_overlay':
      return hideDebugOverlay();

    case 'update_debug_marker':
      return updateDebugMarker(params);

    case 'select_debug_marker':
      return selectDebugMarker(params);

    case 'get_element_at_point':
      return getElementAtPoint(params);

    case 'start_element_pick':
      return startElementPick(params);

    case 'stop_element_pick':
      return stopElementPick();

    case 'toggle_debug_overlay':
      return toggleDebugOverlay(params);

    case 'inject_style':
      return injectStyle(params);

    case 'clear_injected_styles':
      return clearInjectedStyles(params);

    case 'get_focused_element':
      return getFocusedElement();

    case 'inject_calibration_marker':
      return injectCalibrationMarker(params);

    case 'remove_calibration_marker':
      return removeCalibrationMarker();

    case 'start_mouse_tracking': {
      // Continuously track mouse viewport position
      if (window.__woodburyMouseTracker) {
        document.removeEventListener('mousemove', window.__woodburyMouseTracker);
      }
      window.__woodburyMousePos = null;
      window.__woodburyMouseTracker = (e) => {
        window.__woodburyMousePos = { clientX: e.clientX, clientY: e.clientY };
      };
      document.addEventListener('mousemove', window.__woodburyMouseTracker);
      return { ok: true };
    }

    case 'stop_mouse_tracking': {
      if (window.__woodburyMouseTracker) {
        document.removeEventListener('mousemove', window.__woodburyMouseTracker);
        window.__woodburyMouseTracker = null;
      }
      return { ok: true };
    }

    case 'get_mouse_viewport_pos':
      return { pos: window.__woodburyMousePos };

    case 'show_click_target':
      return showClickTarget(params);

    case 'hide_click_target':
      return hideClickTarget();

    // ── Accessibility-mode bridge actions ─────────────────────
    case 'find_by_accessibility':
      return findByAccessibility(params);

    case 'find_by_svg_fingerprint':
      return findBySvgFingerprint(params);

    // ── WCAG Audit ────────────────────────────────────────────
    case 'audit_wcag_components':
      return auditWcagComponents(params);

    case 'scroll_and_highlight':
      return scrollAndHighlight(params);

    case 'start_wcag_inspect':
      return startWcagInspect(params);

    case 'stop_wcag_inspect':
      return stopWcagInspect();

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Calculate the Chrome browser UI offset (tabs + address bar height).
 * This is the difference between the outer window and the inner viewport.
 * Used to convert viewport-relative coordinates to screen-absolute coordinates.
 */
function getChromeOffset() {
  const windowX = window.screenX || window.screenLeft || 0;
  const windowY = window.screenY || window.screenTop || 0;
  const chromeUIHeight = window.outerHeight - window.innerHeight;
  const chromeUIWidth = window.outerWidth - window.innerWidth;
  const dpr = window.devicePixelRatio || 1;

  return {
    chromeUIHeight,
    chromeUIWidth,
    windowX,
    windowY,
    totalOffsetX: windowX,
    totalOffsetY: windowY + chromeUIHeight,
    // Display info
    devicePixelRatio: dpr,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight
  };
}

function getBoundingInfo(el) {
  const rect = el.getBoundingClientRect();

  // Get accurate screen offset using getChromeOffset (uses SVG getScreenCTM)
  const offset = getChromeOffset();

  return {
    // Viewport-relative center point
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    // Viewport-relative edges
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    // Absolute position (accounting for scroll)
    absX: Math.round(rect.left + window.scrollX + rect.width / 2),
    absY: Math.round(rect.top + window.scrollY + rect.height / 2),
    // Screen-absolute position using measured offset
    screenX: Math.round(offset.totalOffsetX + rect.left + rect.width / 2),
    screenY: Math.round(offset.totalOffsetY + rect.top + rect.height / 2),
    visible: rect.width > 0 && rect.height > 0 &&
             rect.top < window.innerHeight && rect.bottom > 0 &&
             rect.left < window.innerWidth && rect.right > 0
  };
}

function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const classes = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).join('.')
    : '';
  const text = (el.textContent || '').trim().substring(0, 80);
  const type = el.getAttribute('type') || '';
  const name = el.getAttribute('name') || '';
  const role = el.getAttribute('role') || '';
  const ariaLabel = el.getAttribute('aria-label') || '';
  const placeholder = el.getAttribute('placeholder') || '';
  const href = el.getAttribute('href') || '';
  const title = el.getAttribute('title') || '';
  const value = el.value !== undefined ? String(el.value).substring(0, 50) : '';

  return {
    tag,
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.trim() : undefined,
    text: text || undefined,
    type: type || undefined,
    name: name || undefined,
    role: role || undefined,
    ariaLabel: ariaLabel || undefined,
    placeholder: placeholder || undefined,
    href: href || undefined,
    title: title || undefined,
    value: value || undefined,
    selector: buildUniqueSelector(el)
  };
}

/**
 * Get contextual information about where an element lives on the page.
 * This helps the agent decide if a "Create" button is the right one — by
 * knowing it's in the "Projects" section, under an "h2 > Projects" heading,
 * inside a nav bar, etc.
 */
function getElementContext(el) {
  const context = {};

  // 1. Parent chain summary (up to 4 ancestors)
  const ancestors = [];
  let parent = el.parentElement;
  let depth = 0;
  while (parent && parent !== document.body && depth < 4) {
    const tag = parent.tagName.toLowerCase();
    const id = parent.id ? `#${parent.id}` : '';
    const role = parent.getAttribute('role') ? `[role=${parent.getAttribute('role')}]` : '';
    const ariaLabel = parent.getAttribute('aria-label');
    const label = ariaLabel ? ` "${ariaLabel}"` : '';
    ancestors.push(`${tag}${id}${role}${label}`);
    parent = parent.parentElement;
    depth++;
  }
  if (ancestors.length > 0) context.ancestors = ancestors;

  // 2. Nearest section/landmark — walk up to find the closest landmark element
  const landmarkTags = ['header', 'nav', 'main', 'footer', 'aside', 'section', 'article', 'form', 'dialog'];
  const landmarkRoles = ['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'region', 'dialog', 'toolbar', 'menu', 'tabpanel'];
  let landmark = el.parentElement;
  while (landmark && landmark !== document.body) {
    const tag = landmark.tagName.toLowerCase();
    const role = landmark.getAttribute('role');
    if (landmarkTags.includes(tag) || (role && landmarkRoles.includes(role))) {
      const id = landmark.id ? `#${landmark.id}` : '';
      const ariaLabel = landmark.getAttribute('aria-label') || '';
      context.landmark = {
        tag,
        id: landmark.id || undefined,
        role: role || undefined,
        ariaLabel: ariaLabel || undefined,
        label: `<${tag}${id}>${ariaLabel ? ' "' + ariaLabel + '"' : ''}`
      };
      break;
    }
    landmark = landmark.parentElement;
  }

  // 3. Nearest heading — search backwards through siblings then up the tree
  const heading = findNearestHeading(el);
  if (heading) {
    context.nearestHeading = {
      level: heading.tagName.toLowerCase(),
      text: heading.textContent.trim().substring(0, 80)
    };
  }

  // 4. Sibling elements — what's next to this element?
  const siblings = [];
  if (el.parentElement) {
    const children = Array.from(el.parentElement.children);
    const myIndex = children.indexOf(el);
    // Get up to 2 siblings before and 2 after
    for (let i = Math.max(0, myIndex - 2); i < Math.min(children.length, myIndex + 3); i++) {
      if (i === myIndex) continue;
      const sib = children[i];
      const tag = sib.tagName.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) continue;
      const sibText = (sib.textContent || '').trim().substring(0, 40);
      if (sibText) {
        siblings.push({
          tag,
          text: sibText,
          position: i < myIndex ? 'before' : 'after'
        });
      }
    }
  }
  if (siblings.length > 0) context.siblings = siblings;

  // 5. Associated label (for form elements)
  if (['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) {
    const labelEl = el.labels?.[0] || (el.id && document.querySelector(`label[for="${el.id}"]`));
    if (labelEl) {
      context.label = labelEl.textContent.trim().substring(0, 60);
    }
  }

  return context;
}

/**
 * Find the nearest heading element by searching backward through siblings
 * and up the DOM tree.
 */
function findNearestHeading(el) {
  const headingTags = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

  // Search previous siblings
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (headingTags.includes(sibling.tagName)) return sibling;
    // Check inside the sibling
    const nested = sibling.querySelector('h1, h2, h3, h4, h5, h6');
    if (nested) return nested;
    sibling = sibling.previousElementSibling;
  }

  // Walk up and check parent's previous siblings
  let ancestor = el.parentElement;
  let depth = 0;
  while (ancestor && ancestor !== document.body && depth < 5) {
    if (headingTags.includes(ancestor.tagName)) return ancestor;

    sibling = ancestor.previousElementSibling;
    while (sibling) {
      if (headingTags.includes(sibling.tagName)) return sibling;
      const nested = sibling.querySelector('h1, h2, h3, h4, h5, h6');
      if (nested) return nested;
      sibling = sibling.previousElementSibling;
    }

    ancestor = ancestor.parentElement;
    depth++;
  }

  return null;
}

function buildUniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;

  // Try aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    const sel = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // Try data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const sel = `[data-testid="${CSS.escape(testId)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // Build path from parent
  const parts = [];
  let current = el;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    current = parent;
  }

  return parts.join(' > ');
}

// ── Action implementations ───────────────────────────────────

/**
 * Resolve the query root — either document or a shadow root.
 * If shadowRootSelector is provided, finds the host element and returns its .shadowRoot.
 * Supports chained shadow DOMs with " >>> " separator, e.g. "outer-host >>> inner-host".
 */
function resolveQueryRoot(shadowRootSelector) {
  if (!shadowRootSelector) return document;

  const parts = shadowRootSelector.split('>>>').map(s => s.trim()).filter(Boolean);
  let root = document;

  for (const part of parts) {
    const host = root.querySelector(part);
    if (!host) throw new Error('Shadow host not found: ' + part);
    if (!host.shadowRoot) throw new Error('Element has no shadowRoot: ' + part);
    root = host.shadowRoot;
  }

  return root;
}

/**
 * Find elements matching a CSS selector.
 * If shadowRootSelector is provided, queries inside that element's shadow DOM.
 */
function findElements({ selector, shadowRootSelector, limit = 20 }) {
  if (!selector) throw new Error('selector is required');

  const root = resolveQueryRoot(shadowRootSelector);
  const elements = Array.from(root.querySelectorAll(selector)).slice(0, limit);
  return elements.map(el => ({
    ...describeElement(el),
    bounds: getBoundingInfo(el),
    context: getElementContext(el)
  }));
}

/**
 * Find elements by their text content (case-insensitive partial match).
 */
function findElementByText({ text, tag, exact = false, limit = 10 }) {
  if (!text) throw new Error('text is required');

  const searchText = text.toLowerCase();
  const candidates = tag
    ? Array.from(document.querySelectorAll(tag))
    : Array.from(document.querySelectorAll('*'));

  const results = [];
  for (const el of candidates) {
    if (results.length >= limit) break;

    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Only check direct text content (not deep nested)
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent)
      .join('')
      .trim();

    const elText = (directText || el.textContent || '').toLowerCase();

    const match = exact
      ? elText === searchText
      : elText.includes(searchText);

    if (match) {
      results.push({
        ...describeElement(el),
        bounds: getBoundingInfo(el),
        matchedText: (directText || el.textContent || '').trim().substring(0, 100),
        context: getElementContext(el)
      });
    }
  }

  return results;
}

/**
 * Find elements matching a CSS selector that also contain specific text.
 * Checks textContent, placeholder, title, and alt attributes.
 */
function findElementsWithText({ selector, shadowRootSelector, text, exact = false, limit = 20 }) {
  if (!selector) throw new Error('selector is required');
  if (!text) throw new Error('text is required');

  const root = resolveQueryRoot(shadowRootSelector);
  const searchText = exact ? text : text.toLowerCase();
  const candidates = Array.from(root.querySelectorAll(selector));
  const results = [];

  for (const el of candidates) {
    if (results.length >= limit) break;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Check text content
    const elText = (el.textContent || '').trim();
    const textMatched = exact ? elText === searchText : elText.toLowerCase().includes(searchText);

    // Check placeholder, title, alt attributes
    const placeholder = el.getAttribute('placeholder') || '';
    const title = el.getAttribute('title') || '';
    const alt = el.getAttribute('alt') || '';
    const attrMatched = exact
      ? (placeholder === searchText || title === searchText || alt === searchText)
      : (placeholder.toLowerCase().includes(searchText) || title.toLowerCase().includes(searchText) || alt.toLowerCase().includes(searchText));

    if (textMatched || attrMatched) {
      results.push({
        ...describeElement(el),
        bounds: getBoundingInfo(el),
        matchedText: elText.substring(0, 100),
        context: getElementContext(el)
      });
    }
  }

  return results;
}

/**
 * Smart interactive element finder — the agent describes WHAT it wants
 * (e.g. "Create button", "search input", "login link") and this function
 * finds candidates, scores them, and returns them with rich context so
 * the agent can make a judgement call about which one is correct.
 *
 * Supports natural descriptions like:
 *   "Create button"      → finds buttons/links containing "Create"
 *   "email input"        → finds inputs with email-related attributes
 *   "navigation menu"    → finds nav elements
 *   "submit form"        → finds submit buttons
 */
function findInteractive({ description, limit = 10 }) {
  if (!description) throw new Error('description is required');

  const desc = description.toLowerCase().trim();

  // Parse the description into search terms and intent
  const intent = parseIntent(desc);

  // Gather ALL interactive elements on the page
  const interactiveSelectors = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]',
    '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="combobox"]', '[role="searchbox"]',
    '[role="textbox"]', '[role="option"]',
    '[onclick]', '[data-action]', 'summary', 'details',
    '[tabindex]:not([tabindex="-1"])'
  ];

  const seen = new Set();
  const candidates = [];

  for (const selector of interactiveSelectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);

      // Skip invisible elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const bounds = getBoundingInfo(el);
      if (bounds.width === 0 || bounds.height === 0) continue;

      const score = scoreElement(el, intent, bounds);
      if (score > 0) {
        candidates.push({
          el,
          score,
          bounds
        });
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Return top results with full context
  const results = candidates.slice(0, limit).map((c, index) => {
    const desc = describeElement(c.el);
    const ctx = getElementContext(c.el);
    return {
      rank: index + 1,
      confidence: c.score >= 100 ? 'high' : c.score >= 50 ? 'medium' : 'low',
      score: c.score,
      ...desc,
      bounds: c.bounds,
      context: ctx
    };
  });

  return {
    query: description,
    resultCount: results.length,
    totalCandidates: candidates.length,
    results
  };
}

/**
 * Parse a natural description into structured search intent.
 */
function parseIntent(desc) {
  const intent = {
    searchTerms: [],
    elementType: null, // 'button', 'link', 'input', etc.
    inputType: null,   // 'email', 'password', 'search', etc.
    action: null       // 'submit', 'close', 'open', etc.
  };

  // Extract element type hints
  const typePatterns = {
    button: /\b(button|btn)\b/,
    link: /\b(link|anchor)\b/,
    input: /\b(input|field|textbox|text box)\b/,
    checkbox: /\b(checkbox|check box|toggle)\b/,
    select: /\b(select|dropdown|drop-down|menu)\b/,
    search: /\b(search)\b/,
    nav: /\b(nav|navigation|menu|sidebar)\b/,
    tab: /\b(tab)\b/,
    modal: /\b(modal|dialog|popup|overlay)\b/
  };

  for (const [type, pattern] of Object.entries(typePatterns)) {
    if (pattern.test(desc)) {
      intent.elementType = type;
      break;
    }
  }

  // Extract input type hints
  const inputTypePatterns = {
    email: /\b(email|e-mail)\b/,
    password: /\b(password|passwd)\b/,
    search: /\b(search)\b/,
    phone: /\b(phone|tel|telephone)\b/,
    url: /\b(url|website)\b/,
    number: /\b(number|amount|quantity)\b/,
    date: /\b(date|calendar)\b/
  };

  for (const [type, pattern] of Object.entries(inputTypePatterns)) {
    if (pattern.test(desc)) {
      intent.inputType = type;
      break;
    }
  }

  // Extract action verbs
  const actionPatterns = {
    submit: /\b(submit|send|save|confirm|apply|ok)\b/,
    cancel: /\b(cancel|close|dismiss|back)\b/,
    create: /\b(create|new|add|plus)\b/,
    delete: /\b(delete|remove|trash|discard)\b/,
    edit: /\b(edit|modify|change|update)\b/,
    open: /\b(open|expand|show|view|details)\b/,
    login: /\b(login|log in|sign in|signin)\b/,
    logout: /\b(logout|log out|sign out|signout)\b/,
    signup: /\b(signup|sign up|register|join)\b/
  };

  for (const [action, pattern] of Object.entries(actionPatterns)) {
    if (pattern.test(desc)) {
      intent.action = action;
      break;
    }
  }

  // Everything else becomes search terms
  // Remove common filler words
  const fillers = /\b(the|a|an|in|on|at|for|to|of|with|that|this|is|it)\b/g;
  const cleaned = desc.replace(fillers, '').replace(/\s+/g, ' ').trim();
  intent.searchTerms = cleaned.split(' ').filter(w => w.length > 1);

  return intent;
}

/**
 * Score an element against the parsed intent.
 * Higher score = better match.
 */
function scoreElement(el, intent, bounds) {
  let score = 0;
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || '').trim().toLowerCase();
  const directText = getDirectText(el).toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const title = (el.getAttribute('title') || '').toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const classes = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const href = (el.getAttribute('href') || '').toLowerCase();

  // Combine all searchable text
  const allText = [text, ariaLabel, title, placeholder, name, id, classes].join(' ');

  // Score based on search term matches
  for (const term of intent.searchTerms) {
    // Direct text match (most valuable — this is what the user reads)
    if (directText.includes(term)) score += 40;
    // Aria-label match (equally valuable — screen reader text)
    else if (ariaLabel.includes(term)) score += 35;
    // Title/placeholder match
    else if (title.includes(term) || placeholder.includes(term)) score += 25;
    // Attribute match (id, name, class)
    else if (id.includes(term) || name.includes(term)) score += 15;
    else if (classes.includes(term)) score += 8;
    // Deep text match (child text content — less reliable, might be coincidental)
    else if (text.includes(term)) score += 5;
  }

  // Score based on element type match
  if (intent.elementType) {
    switch (intent.elementType) {
      case 'button':
        if (tag === 'button' || role === 'button' || type === 'submit' || type === 'button') score += 30;
        break;
      case 'link':
        if (tag === 'a' || role === 'link') score += 30;
        break;
      case 'input':
        if (['input', 'textarea'].includes(tag) || role === 'textbox') score += 30;
        break;
      case 'checkbox':
        if (type === 'checkbox' || role === 'checkbox' || role === 'switch') score += 30;
        break;
      case 'select':
        if (tag === 'select' || role === 'combobox' || role === 'listbox') score += 30;
        break;
      case 'search':
        if (type === 'search' || role === 'searchbox' || name.includes('search') || ariaLabel.includes('search')) score += 30;
        break;
      case 'tab':
        if (role === 'tab') score += 30;
        break;
    }
  }

  // Score based on input type match
  if (intent.inputType) {
    if (type === intent.inputType) score += 25;
    if (name.includes(intent.inputType) || id.includes(intent.inputType)) score += 15;
    if (placeholder.includes(intent.inputType) || ariaLabel.includes(intent.inputType)) score += 15;
  }

  // Score based on action match — check if the element's text/purpose aligns
  if (intent.action) {
    const actionText = intent.action;
    if (directText.includes(actionText) || ariaLabel.includes(actionText)) score += 20;
    if (href.includes(actionText) || name.includes(actionText) || id.includes(actionText)) score += 10;
  }

  // Bonus: visible elements score higher than off-screen
  if (bounds.visible) score += 5;

  // Bonus: elements with clear accessible names score higher
  if (ariaLabel || el.getAttribute('aria-labelledby')) score += 3;

  // Penalty: very long text content likely means we matched a container, not the target
  if (text.length > 200 && tag !== 'a') score -= 20;

  // Penalty: tiny elements are probably not the target
  if (bounds.width < 10 || bounds.height < 10) score -= 10;

  return Math.max(0, score);
}

/**
 * Get direct text content (text nodes only, not nested children's text).
 */
function getDirectText(el) {
  return Array.from(el.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent)
    .join('')
    .trim();
}

/**
 * Query document.activeElement and return metadata about the focused element.
 * Used by keyboard_nav steps to verify focus landed on the expected element.
 */
function getFocusedElement() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    return { focused: false, tag: 'body' };
  }

  const rect = el.getBoundingClientRect();
  const selectors = buildSelectorSet(el);
  const directText = getDirectText(el);
  const innerText = (el.innerText || el.textContent || '').trim();
  const text = (directText || innerText).substring(0, 200) || undefined;

  return {
    focused: true,
    tag: el.tagName.toLowerCase(),
    text,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    role: el.getAttribute('role') || undefined,
    selector: selectors[0] || '',
    fallbackSelectors: selectors.slice(1),
    placeholder: el.getAttribute('placeholder') || undefined,
    id: el.id || undefined,
    name: el.getAttribute('name') || undefined,
    value: el.value !== undefined ? String(el.value).substring(0, 500) : undefined,
    inputType: el.getAttribute('type') || undefined,
    dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
    bounds: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

// ── Action implementations ───────────────────────────────────

/**
 * Resolve the query root — either document or a shadow root.
 * If shadowRootSelector is provided, finds the host element and returns its .shadowRoot.
 * Supports chained shadow DOMs with " >>> " separator, e.g. "outer-host >>> inner-host".
 */
function resolveQueryRoot(shadowRootSelector) {
  if (!shadowRootSelector) return document;

  const parts = shadowRootSelector.split('>>>').map(s => s.trim()).filter(Boolean);
  let root = document;

  for (const part of parts) {
    const host = root.querySelector(part);
    if (!host) throw new Error('Shadow host not found: ' + part);
    if (!host.shadowRoot) throw new Error('Element has no shadowRoot: ' + part);
    root = host.shadowRoot;
  }

  return root;
}

/**
 * Find elements matching a CSS selector.
 * If shadowRootSelector is provided, queries inside that element's shadow DOM.
 */
function findElements({ selector, shadowRootSelector, limit = 20 }) {
  if (!selector) throw new Error('selector is required');

  const root = resolveQueryRoot(shadowRootSelector);
  const elements = Array.from(root.querySelectorAll(selector)).slice(0, limit);
  return elements.map(el => ({
    ...describeElement(el),
    bounds: getBoundingInfo(el),
    context: getElementContext(el)
  }));
}

/**
 * Find elements by their text content (case-insensitive partial match).
 */
function findElementByText({ text, tag, exact = false, limit = 10 }) {
  if (!text) throw new Error('text is required');

  const searchText = text.toLowerCase();
  const candidates = tag
    ? Array.from(document.querySelectorAll(tag))
    : Array.from(document.querySelectorAll('*'));

  const results = [];
  for (const el of candidates) {
    if (results.length >= limit) break;

    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Only check direct text content (not deep nested)
    const directText = getDirectText(el);
    const elText = (directText || el.textContent || '').toLowerCase();

    const match = exact
      ? elText === searchText
      : elText.includes(searchText);

    if (match) {
      results.push({
        ...describeElement(el),
        bounds: getBoundingInfo(el),
        matchedText: (directText || el.textContent || '').trim().substring(0, 100),
        context: getElementContext(el)
      });
    }
  }

  return results;
}

/**
 * Get bounds of an element by CSS selector.
 */
function getElementBounds({ selector }) {
  if (!selector) throw new Error('selector is required');

  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  return {
    ...describeElement(el),
    bounds: getBoundingInfo(el)
  };
}

/**
 * Get a structural overview of the page — headings, nav, main content areas.
 */
function getPageStructure({ maxDepth = 3 }) {
  function walk(el, depth) {
    if (depth > maxDepth) return null;

    const tag = el.tagName.toLowerCase();
    const isInteresting = [
      'header', 'nav', 'main', 'footer', 'aside', 'section', 'article',
      'form', 'dialog', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'button', 'a', 'input', 'select', 'textarea'
    ].includes(tag) || el.getAttribute('role');

    if (!isInteresting && depth > 1) return null;

    const node = {
      tag,
      id: el.id || undefined,
      role: el.getAttribute('role') || undefined,
      text: (el.textContent || '').trim().substring(0, 60) || undefined,
      bounds: getBoundingInfo(el)
    };

    if (depth < maxDepth) {
      const children = [];
      for (const child of el.children) {
        const childNode = walk(child, depth + 1);
        if (childNode) children.push(childNode);
      }
      if (children.length > 0) node.children = children;
    }

    return node;
  }

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight
    },
    structure: walk(document.body, 0)
  };
}

/**
 * Extract visible text content from the page.
 */
function getPageText({ selector, maxLength = 10000 }) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error(`Element not found: ${selector}`);

  // Walk the tree and collect visible text
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let text = '';
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (t) {
      text += t + '\n';
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\n[truncated]';
        break;
      }
    }
  }

  return { text, url: location.href, title: document.title };
}

/**
 * Find all form fields on the page.
 */
function getFormFields({ formSelector }) {
  const forms = formSelector
    ? [document.querySelector(formSelector)]
    : Array.from(document.querySelectorAll('form'));

  const results = [];
  const inputs = formSelector
    ? (document.querySelector(formSelector)?.querySelectorAll('input, select, textarea') || [])
    : document.querySelectorAll('input, select, textarea');

  for (const el of Array.from(inputs)) {
    const bounds = getBoundingInfo(el);
    if (!bounds.visible) continue;

    const info = {
      ...describeElement(el),
      bounds,
      context: getElementContext(el),
      disabled: el.disabled || false,
      required: el.required || false,
      currentValue: el.value || ''
    };

    // For select elements, include options
    if (el.tagName.toLowerCase() === 'select') {
      info.options = Array.from(el.options).map(opt => ({
        value: opt.value,
        text: opt.text,
        selected: opt.selected
      }));
    }

    results.push(info);
  }

  return results;
}

/**
 * Click an element by selector or coordinates.
 */
function clickElement({ selector, x, y }) {
  let el;

  if (selector) {
    el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
  } else if (x !== undefined && y !== undefined) {
    el = document.elementFromPoint(x, y);
    if (!el) throw new Error(`No element at coordinates (${x}, ${y})`);
  } else {
    throw new Error('Either selector or x,y coordinates are required');
  }

  // Scroll into view if needed
  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Simulate a full click sequence
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  // Also call .click() for anchors and buttons that use native handling
  if (typeof el.click === 'function') {
    el.click();
  }

  return {
    clicked: true,
    element: describeElement(el),
    bounds: getBoundingInfo(el)
  };
}

/**
 * Set the value of an input element.
 */
function setValue({ selector, value }) {
  if (!selector) throw new Error('selector is required');
  if (value === undefined) throw new Error('value is required');

  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  // Focus the element
  el.focus();

  // Set value using native input setter (works with React, Vue, etc.)
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  const setter = el.tagName.toLowerCase() === 'textarea'
    ? nativeTextareaValueSetter
    : nativeInputValueSetter;

  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }

  // Fire events that frameworks listen for
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return {
    set: true,
    element: describeElement(el),
    newValue: el.value
  };
}

/**
 * Get detailed info about a specific element.
 */
function getElementInfo({ selector }) {
  if (!selector) throw new Error('selector is required');

  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const style = window.getComputedStyle(el);

  return {
    ...describeElement(el),
    bounds: getBoundingInfo(el),
    context: getElementContext(el),
    computedStyle: {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      position: style.position,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      cursor: style.cursor
    },
    attributes: Array.from(el.attributes).reduce((acc, attr) => {
      acc[attr.name] = attr.value;
      return acc;
    }, {}),
    // Resolved DOM properties — these give absolute URLs unlike raw attributes
    resolvedProperties: {
      href: el.href || undefined,
      src: el.src || undefined,
      action: el.action || undefined,
    },
    childCount: el.children.length,
    innerHTML: el.innerHTML.substring(0, 500)
  };
}

/**
 * Scroll to bring an element into view.
 */
function scrollToElement({ selector, block = 'center' }) {
  if (!selector) throw new Error('selector is required');

  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  el.scrollIntoView({ behavior: 'smooth', block });

  // Return new bounds after a short delay
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        scrolledTo: true,
        element: describeElement(el),
        bounds: getBoundingInfo(el)
      });
    }, 300);
  });
}

/**
 * Get all clickable/interactive elements on the visible page.
 */
function getClickableElements({ limit = 150 }) {
  const selectors = [
    // Standard interactive HTML elements
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    'details',
    'label[for]',
    // ARIA roles for custom components
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="listbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="checkbox"]',
    '[role="radio"]',
    // Custom interactivity markers
    '[onclick]',
    '[data-action]',
    '[data-testid]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
    '[aria-haspopup]',
    '[draggable="true"]',
  ];

  const seen = new Set();
  const results = [];

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (results.length >= limit) break;
      if (seen.has(el)) continue;
      seen.add(el);

      const bounds = getBoundingInfo(el);
      if (!bounds.visible) continue;

      results.push({
        ...describeElement(el),
        bounds,
        context: getElementContext(el)
      });
    }
  }

  // Sort by position (top to bottom, left to right)
  results.sort((a, b) => {
    const dy = a.bounds.top - b.bounds.top;
    return Math.abs(dy) > 20 ? dy : a.bounds.left - b.bounds.left;
  });

  return results;
}

/**
 * Get basic page info.
 */
function getPageInfo() {
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight
    },
    forms: document.querySelectorAll('form').length,
    links: document.querySelectorAll('a[href]').length,
    buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
    inputs: document.querySelectorAll('input, select, textarea').length,
    images: document.querySelectorAll('img').length,
    headings: Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 10)
      .map(h => ({ level: h.tagName, text: h.textContent.trim().substring(0, 80) })),
    chromeOffset: getChromeOffset()
  };
}

/**
 * Temporarily highlight an element with an overlay.
 */
function highlightElement({ selector, duration = 2000, color = 'rgba(255, 0, 0, 0.3)' }) {
  if (!selector) throw new Error('selector is required');

  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const bounds = el.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    left: ${bounds.left}px;
    top: ${bounds.top}px;
    width: ${bounds.width}px;
    height: ${bounds.height}px;
    background: ${color};
    border: 2px solid red;
    z-index: 999999;
    pointer-events: none;
    transition: opacity 0.3s;
  `;
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
  }, duration);

  return {
    highlighted: true,
    element: describeElement(el),
    bounds: getBoundingInfo(el)
  };
}

/**
 * Wait for an element to appear in the DOM (up to timeout).
 */
function waitForElement({ selector, timeout = 10000, interval = 200 }) {
  if (!selector) throw new Error('selector is required');

  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      const el = document.querySelector(selector);
      if (el) {
        resolve({
          found: true,
          waitedMs: Date.now() - start,
          element: describeElement(el),
          bounds: getBoundingInfo(el)
        });
        return;
      }

      if (Date.now() - start > timeout) {
        reject(new Error(`Element not found after ${timeout}ms: ${selector}`));
        return;
      }

      setTimeout(check, interval);
    }

    check();
  });
}

// ── Spinner / Loading Animation Detection ──────────────────────
//
// Scans visible DOM elements for CSS animations, spinner classes,
// aria attributes, and animated SVGs that indicate loading state.
//

function detectSpinners({ limit = 20 } = {}) {
  const spinners = [];
  const seen = new Set();

  // Pattern for known spinner animation names
  const spinnerAnimPattern = /spin|rotate|pulse|loading|bounce|progress|indeterminate|ripple|ring|dash|shimmer|skeleton/i;
  // Pattern for known non-spinner animations (filter out)
  const nonSpinnerAnimPattern = /blink|cursor|caret|fade-?in|slide|appear|tooltip|dropdown|collapse|expand|modal/i;
  // Pattern for spinner class names
  const spinnerClassPattern = /\b(spinner|loader|loading|progress|spin|rotating|pulsing|circular|skeleton|shimmer)\b/i;

  const allElements = document.querySelectorAll('*');

  for (const el of allElements) {
    if (spinners.length >= limit) break;
    if (seen.has(el)) continue;

    const style = window.getComputedStyle(el);

    // Skip invisible elements
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Skip off-screen elements
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;

    let isSpinner = false;
    let detectionMethod = '';

    // Strategy 1: CSS animation-name matches known spinner patterns
    const animName = style.animationName || '';
    if (animName && animName !== 'none') {
      if (spinnerAnimPattern.test(animName)) {
        isSpinner = true;
        detectionMethod = 'animation:' + animName;
      }
    }

    // Strategy 2: Infinite animation (even if name doesn't match spinner pattern)
    if (!isSpinner && animName && animName !== 'none') {
      const iterCount = style.animationIterationCount || '';
      if (iterCount === 'infinite') {
        // Has infinite animation — likely a loading indicator
        // But filter out known non-spinner animations
        if (!nonSpinnerAnimPattern.test(animName)) {
          isSpinner = true;
          detectionMethod = 'infinite-animation:' + animName;
        }
      }
    }

    // Strategy 3: Class name matches spinner patterns + has active animation
    if (!isSpinner) {
      const className = (typeof el.className === 'string') ? el.className : '';
      if (spinnerClassPattern.test(className)) {
        // Only count as spinner if it has an active animation or meaningful transition
        const hasAnimation = animName && animName !== 'none';
        const hasTransform = style.transform && style.transform !== 'none';
        if (hasAnimation || hasTransform) {
          isSpinner = true;
          const match = className.match(spinnerClassPattern);
          detectionMethod = 'class:' + (match ? match[0] : 'unknown');
        }
      }
    }

    // Strategy 4: aria-busy="true" or role="progressbar"
    if (!isSpinner) {
      if (el.getAttribute('aria-busy') === 'true') {
        isSpinner = true;
        detectionMethod = 'aria-busy';
      } else if (el.getAttribute('role') === 'progressbar') {
        isSpinner = true;
        detectionMethod = 'role:progressbar';
      }
    }

    // Strategy 5: SVG with <animate> or <animateTransform> children
    if (!isSpinner) {
      const svgRoot = el.tagName.toLowerCase() === 'svg' ? el : null;
      if (svgRoot && !seen.has(svgRoot)) {
        const hasAnimate = svgRoot.querySelector('animate, animateTransform, animateMotion');
        if (hasAnimate) {
          isSpinner = true;
          detectionMethod = 'svg-animate';
          seen.add(svgRoot);
        }
      }
    }

    if (isSpinner && !seen.has(el)) {
      seen.add(el);
      const desc = describeElement(el);
      spinners.push({
        tag: desc.tag,
        id: desc.id,
        classes: desc.classes,
        text: desc.text,
        ariaLabel: desc.ariaLabel,
        role: desc.role,
        selector: desc.selector,
        bounds: getBoundingInfo(el),
        detectionMethod: detectionMethod,
      });
    }
  }

  return {
    spinners: spinners,
    count: spinners.length,
    timestamp: Date.now(),
  };
}

// ── Accessibility-First Recording Helpers ─────────────────────
//
// These functions support the accessibility recording mode, which identifies
// elements by their semantic accessibility properties (roles, labels, text)
// and SVG visual fingerprints, rather than CSS selectors.
//

/**
 * Compute the accessible name of an element using a simplified WAI-ARIA algorithm.
 * Priority: aria-labelledby → aria-label → <label> → alt/title/placeholder → text content
 */
function computeAccessibleName(el) {
  // 1. aria-labelledby: concatenate text of referenced elements
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const texts = [];
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref) texts.push((ref.textContent || '').trim());
    }
    const result = texts.join(' ').trim();
    if (result) return result;
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 3. Associated <label> (for="id" or wrapping <label>)
  if (el.id) {
    const labelFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (labelFor) {
      const text = (labelFor.textContent || '').trim();
      if (text) return text;
    }
  }
  // Check wrapping <label>
  const wrappingLabel = el.closest('label');
  if (wrappingLabel) {
    // Get label text without the input's own value
    const clone = wrappingLabel.cloneNode(true);
    const inputs = clone.querySelectorAll('input, textarea, select');
    for (const inp of inputs) inp.remove();
    const text = (clone.textContent || '').trim();
    if (text) return text;
  }

  // 4. alt, title, placeholder
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // 5. Direct text content (for buttons, links, etc.)
  const tag = el.tagName.toLowerCase();
  const textTags = new Set(['button', 'a', 'label', 'summary', 'option', 'th', 'td', 'li', 'span', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  if (textTags.has(tag) || el.getAttribute('role')) {
    const text = getDirectText(el).trim();
    if (text) return text.substring(0, 200);
  }

  return '';
}

/**
 * Get the implicit ARIA role for an HTML element based on its tag and attributes.
 */
function getImplicitRole(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();

  // Explicit role always wins
  const explicitRole = el.getAttribute('role');
  if (explicitRole) return explicitRole;

  // Tag → role mapping
  const inputRoles = {
    'text': 'textbox', 'email': 'textbox', 'tel': 'textbox', 'url': 'textbox', 'search': 'searchbox',
    'number': 'spinbutton', 'range': 'slider',
    'checkbox': 'checkbox', 'radio': 'radio',
    'submit': 'button', 'reset': 'button', 'button': 'button', 'image': 'button',
  };

  const tagRoleMap = {
    'button': 'button',
    'textarea': 'textbox',
    'option': 'option',
    'img': 'img',
    'nav': 'navigation',
    'main': 'main',
    'header': 'banner',
    'footer': 'contentinfo',
    'aside': 'complementary',
    'form': 'form',
    'article': 'article',
    'ul': 'list', 'ol': 'list',
    'li': 'listitem',
    'table': 'table',
    'tr': 'row',
    'td': 'cell',
    'th': 'columnheader',
    'dialog': 'dialog',
    'details': 'group',
    'summary': 'button',
    'progress': 'progressbar',
    'meter': 'meter',
    'output': 'status',
    'menu': 'menu',
    'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
    'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
  };

  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'input') return inputRoles[type] || 'textbox';
  if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (tag === 'section') return (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? 'region' : null;

  return tagRoleMap[tag] || null;
}

/**
 * Pierce shadow DOM boundaries using event.composedPath() during recording.
 * Returns the innermost target element and an array of shadow host descriptors.
 */
function pierceAndResolveShadowDOM(event) {
  const path = event.composedPath ? event.composedPath() : [];
  const shadowPath = [];
  let innermostTarget = event.target;

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    // Check if this is a ShadowRoot
    if (node instanceof ShadowRoot) {
      const host = node.host;
      if (host) {
        const hostSelectors = buildSelectorSet(host);
        shadowPath.push({
          tag: host.tagName.toLowerCase(),
          id: host.id || undefined,
          ariaLabel: host.getAttribute('aria-label') || undefined,
          role: host.getAttribute('role') || getImplicitRole(host) || undefined,
          selector: hostSelectors[0] || undefined,
        });
      }
    }
    // The first Element in the path is the innermost target
    if (i === 0 && node instanceof Element) {
      innermostTarget = node;
    }
  }

  // Reverse so outermost host is first
  shadowPath.reverse();

  return { target: innermostTarget, shadowPath: shadowPath.length > 0 ? shadowPath : undefined };
}

/**
 * Fingerprint an SVG element for visual matching across layouts.
 * Uses a perceptual average hash: rasterize to 32×32, grayscale, compare to mean.
 */
function fingerprintSVG(svgElement) {
  try {
    const rect = svgElement.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return Promise.resolve(null);

    // Clone the SVG to avoid modifying the original
    const clone = svgElement.cloneNode(true);
    // Ensure the clone has explicit dimensions for rasterization
    clone.setAttribute('width', '32');
    clone.setAttribute('height', '32');
    // Remove any transform that might affect rendering
    clone.removeAttribute('transform');

    const svgString = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);

          const imageData = ctx.getImageData(0, 0, 32, 32);
          const pixels = imageData.data;

          // Convert to grayscale and compute mean
          const gray = new Float32Array(32 * 32);
          let sum = 0;
          for (let i = 0; i < 32 * 32; i++) {
            const r = pixels[i * 4];
            const g = pixels[i * 4 + 1];
            const b = pixels[i * 4 + 2];
            gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            sum += gray[i];
          }
          const mean = sum / (32 * 32);

          // Build binary hash: 1 if pixel >= mean, else 0
          // Pack into hex string (256 bits = 64 hex chars)
          let hashBits = '';
          for (let i = 0; i < 32 * 32; i++) {
            hashBits += gray[i] >= mean ? '1' : '0';
          }
          // Convert binary string to hex
          let hash = '';
          for (let i = 0; i < hashBits.length; i += 4) {
            hash += parseInt(hashBits.substring(i, i + 4), 2).toString(16);
          }

          URL.revokeObjectURL(url);

          // Get label from SVG
          const svgLabel = svgElement.getAttribute('aria-label')
            || (svgElement.querySelector('title') ? svgElement.querySelector('title').textContent : null)
            || undefined;

          resolve({
            hash,
            dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
            label: svgLabel,
            inline: true,
          });
        } catch (err) {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  } catch (err) {
    return Promise.resolve(null);
  }
}

/**
 * Capture accessibility-enriched element metadata for a recording event.
 * This is the accessibility-mode alternative to captureElementMeta().
 */
async function captureAccessibilityMeta(el, event) {
  // 1. Pierce shadow DOM to get innermost target + shadow path
  const { target: actualTarget, shadowPath } = pierceAndResolveShadowDOM(event);
  const effectiveEl = actualTarget || el;

  // 2. Find nearest interactive ancestor (reuse same logic as captureElementMeta)
  const interactiveTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'label', 'summary']);
  const interactiveRoles = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'slider', 'combobox', 'option']);
  let interactiveAncestor = null;
  let current = effectiveEl;
  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const role = current.getAttribute('role') || '';
    if (interactiveTags.has(tag) || interactiveRoles.has(role)) {
      interactiveAncestor = current;
      break;
    }
    current = current.parentElement;
  }
  // Use interactive ancestor if found, otherwise the effective element
  const resolvedEl = interactiveAncestor || effectiveEl;

  // 3. Compute accessible name and role
  const accessibleName = computeAccessibleName(resolvedEl);
  const computedRole = getImplicitRole(resolvedEl);

  // 4. Fingerprint SVG if element is/contains an SVG
  let svgFingerprint = null;
  const svgEl = resolvedEl.tagName.toLowerCase() === 'svg'
    ? resolvedEl
    : resolvedEl.querySelector('svg');
  if (svgEl) {
    svgFingerprint = await fingerprintSVG(svgEl);
  }

  // 5. Get standard metadata as fallback (CSS selectors, bounds, etc.)
  const standardMeta = captureElementMeta(resolvedEl);

  // 6. Merge accessibility data into the standard metadata
  return {
    ...standardMeta,
    shadowPath: shadowPath || undefined,
    svgFingerprint: svgFingerprint || undefined,
    accessibleName: accessibleName || undefined,
    computedRole: computedRole || undefined,
  };
}

/**
 * Compute Hamming distance between two hex hash strings.
 * Returns the number of differing bits.
 */
function hammingDistanceHex(hash1, hash2) {
  if (hash1.length !== hash2.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    // Count bits in xor
    let bits = xor;
    while (bits) {
      dist += bits & 1;
      bits >>= 1;
    }
  }
  return dist;
}

/**
 * Find elements by accessibility query: role + accessible name.
 * Optionally pierce shadow DOMs using a stored shadow path.
 * Bridge action: find_by_accessibility
 */
async function findByAccessibility({ role, name, shadowPath, limit = 10 }) {
  let roots = [document];

  // If shadowPath provided, pierce into each shadow DOM
  if (shadowPath && shadowPath.length > 0) {
    for (const hostDesc of shadowPath) {
      const newRoots = [];
      for (const root of roots) {
        // Try to find the shadow host by ariaLabel → id → selector
        let host = null;
        if (hostDesc.ariaLabel) {
          host = root.querySelector('[aria-label="' + CSS.escape(hostDesc.ariaLabel) + '"]');
        }
        if (!host && hostDesc.id) {
          host = root.querySelector('#' + CSS.escape(hostDesc.id));
        }
        if (!host && hostDesc.selector) {
          try { host = root.querySelector(hostDesc.selector); } catch {}
        }
        if (!host && hostDesc.tag) {
          // Last resort: match by tag name
          const candidates = root.querySelectorAll(hostDesc.tag);
          if (candidates.length === 1) host = candidates[0];
        }
        if (host && host.shadowRoot) {
          newRoots.push(host.shadowRoot);
        }
      }
      if (newRoots.length > 0) {
        roots = newRoots;
      }
      // If we couldn't pierce, keep searching in current roots
    }
  }

  const results = [];
  const searchName = (name || '').toLowerCase();

  for (const root of roots) {
    // Build a selector for the role if provided
    let candidates;
    if (role) {
      // Search for both explicit role and tag-implied elements
      const explicitSel = '[role="' + role + '"]';
      const implicitTags = [];
      // Map roles back to tags
      const roleToTag = {
        'button': ['button', 'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'summary'],
        'link': ['a[href]'],
        'textbox': ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="tel"]', 'input[type="url"]', 'textarea'],
        'checkbox': ['input[type="checkbox"]'],
        'radio': ['input[type="radio"]'],
        'combobox': ['select:not([multiple])'],
        'listbox': ['select[multiple]'],
        'searchbox': ['input[type="search"]'],
        'slider': ['input[type="range"]'],
        'img': ['img'],
        'heading': ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        'navigation': ['nav'],
      };
      const tags = roleToTag[role] || [];
      const combinedSel = [explicitSel, ...tags].join(', ');
      try {
        candidates = root.querySelectorAll(combinedSel);
      } catch {
        candidates = root.querySelectorAll(explicitSel);
      }
    } else {
      candidates = root.querySelectorAll('*');
    }

    for (const el of candidates) {
      if (results.length >= limit) break;

      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      // Check accessible name match (case-insensitive partial)
      if (searchName) {
        const elName = computeAccessibleName(el).toLowerCase();
        if (!elName.includes(searchName)) continue;
      }

      const rect = el.getBoundingClientRect();
      results.push({
        ...describeElement(el),
        bounds: getBoundingInfo(el),
        accessibleName: computeAccessibleName(el),
        computedRole: getImplicitRole(el),
      });
    }
  }

  return { elements: results };
}

/**
 * Find elements by SVG fingerprint hash (Hamming distance comparison).
 * Returns the interactive parent of matching SVGs.
 * Bridge action: find_by_svg_fingerprint
 */
async function findBySvgFingerprint({ hash, dimensions, limit = 5 }) {
  if (!hash) throw new Error('hash is required');

  const svgs = document.querySelectorAll('svg');
  const results = [];
  const maxBits = hash.length * 4; // Each hex char = 4 bits
  const threshold = Math.floor(maxBits * 0.2); // 80% similarity = max 20% different bits

  for (const svg of svgs) {
    if (results.length >= limit) break;

    const style = window.getComputedStyle(svg);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const fp = await fingerprintSVG(svg);
    if (!fp || !fp.hash) continue;

    const dist = hammingDistanceHex(hash, fp.hash);
    if (dist <= threshold) {
      // Find interactive parent of the SVG
      let interactiveParent = svg;
      let cur = svg.parentElement;
      const interactiveTags = new Set(['button', 'a', 'input', 'label', 'summary']);
      const interactiveRoles = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);
      while (cur && cur !== document.body) {
        const tag = cur.tagName.toLowerCase();
        const role = cur.getAttribute('role') || '';
        if (interactiveTags.has(tag) || interactiveRoles.has(role)) {
          interactiveParent = cur;
          break;
        }
        cur = cur.parentElement;
      }

      results.push({
        ...describeElement(interactiveParent),
        bounds: getBoundingInfo(interactiveParent),
        svgMatch: {
          distance: dist,
          similarity: Math.round((1 - dist / maxBits) * 100),
          fingerprint: fp,
        },
      });
    }
  }

  return { elements: results };
}

// ── WCAG Component Audit ────────────────────────────────────────
//
// Scans the page DOM and returns all WCAG-relevant components
// grouped by category, with accessible names and issue detection.
//

function auditWcagComponents(params) {
  const MAX_PER_CATEGORY = 500;
  const MAX_TOTAL = 2000;

  // Category definitions: name, icon, CSS selectors, expected roles
  const categoryDefs = [
    {
      name: 'Landmarks',
      icon: '\u{1F3D7}',
      selectors: 'nav, main, header, footer, aside, section[aria-label], section[aria-labelledby], form[aria-label], form[aria-labelledby], [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], [role="complementary"], [role="region"], [role="search"]',
      roles: new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'search', 'form']),
    },
    {
      name: 'Headings',
      icon: '\u{1F524}',
      selectors: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      roles: new Set(['heading']),
    },
    {
      name: 'Forms',
      icon: '\u{1F4DD}',
      selectors: 'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]), textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="spinbutton"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"]',
      roles: new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch']),
    },
    {
      name: 'Buttons',
      icon: '\u{1F518}',
      selectors: 'button, [role="button"], input[type="submit"], input[type="reset"], input[type="button"], input[type="image"], summary',
      roles: new Set(['button']),
    },
    {
      name: 'Links',
      icon: '\u{1F517}',
      selectors: 'a[href], [role="link"]',
      roles: new Set(['link']),
    },
    {
      name: 'Images',
      icon: '\u{1F5BC}',
      selectors: 'img, [role="img"], svg[aria-label], svg[role="img"]',
      roles: new Set(['img']),
    },
    {
      name: 'Tables',
      icon: '\u{1F4CA}',
      selectors: 'table, [role="table"], [role="grid"]',
      roles: new Set(['table', 'grid']),
    },
    {
      name: 'Other',
      icon: '\u2699',
      selectors: '[role="tab"], [role="menuitem"], [role="option"], [role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [role="progressbar"], [role="tablist"], [role="menu"], [role="menubar"], [role="tree"], [role="treeitem"], dialog, [contenteditable="true"]',
      roles: new Set(['tab', 'menuitem', 'option', 'dialog', 'alertdialog', 'alert', 'status', 'progressbar', 'tablist', 'menu', 'menubar', 'tree', 'treeitem']),
    },
  ];

  const seen = new Set();
  let totalCount = 0;
  let issueCount = 0;
  let lastHeadingLevel = 0;
  const categorySummary = {};

  // Page-level issues
  const pageIssues = [];
  if (!document.documentElement.lang) {
    pageIssues.push('Missing lang attribute on <html>');
  }

  const categories = [];

  for (const catDef of categoryDefs) {
    if (totalCount >= MAX_TOTAL) break;

    const items = [];
    let els;
    try {
      els = document.querySelectorAll(catDef.selectors);
    } catch (e) {
      continue;
    }

    for (const el of els) {
      if (seen.has(el)) continue;
      if (items.length >= MAX_PER_CATEGORY) break;
      if (totalCount >= MAX_TOTAL) break;

      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      // Skip tiny elements
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) continue;

      seen.add(el);

      const tag = el.tagName.toLowerCase();
      const role = getImplicitRole(el) || '';
      const accessibleName = computeAccessibleName(el);

      // Heading level
      let level = null;
      if (catDef.name === 'Headings') {
        const match = tag.match(/^h([1-6])$/);
        if (match) {
          level = parseInt(match[1], 10);
        } else if (el.getAttribute('aria-level')) {
          level = parseInt(el.getAttribute('aria-level'), 10);
        }
      }

      // Build selector
      let selector = '';
      try {
        const selectorSet = buildSelectorSet(el);
        selector = selectorSet[0] || buildUniqueSelector(el) || tag;
      } catch {
        selector = tag;
      }

      // Detect issues
      const issues = detectA11yIssues(el, tag, role, accessibleName, catDef.name, level, lastHeadingLevel);

      if (catDef.name === 'Headings' && level) {
        lastHeadingLevel = level;
      }

      if (issues.length > 0) issueCount++;
      totalCount++;

      items.push({
        tag,
        role: role || undefined,
        accessibleName: accessibleName || '',
        selector,
        level,
        issues,
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
        },
        attributes: {
          id: el.id || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          alt: el.getAttribute('alt') !== null ? el.getAttribute('alt') : undefined,
          href: el.getAttribute('href') ? el.getAttribute('href').substring(0, 100) : undefined,
          type: el.getAttribute('type') || undefined,
        },
      });
    }

    categorySummary[catDef.name] = items.length;
    categories.push({
      name: catDef.name,
      icon: catDef.icon,
      items,
    });
  }

  return {
    url: location.href,
    title: document.title,
    timestamp: Date.now(),
    pageIssues,
    summary: {
      total: totalCount,
      withIssues: issueCount,
      categories: categorySummary,
    },
    categories,
  };
}

/**
 * Detect WCAG accessibility issues for a given element.
 */
function detectA11yIssues(el, tag, role, accessibleName, categoryName, level, lastHeadingLevel) {
  const issues = [];

  // Missing accessible name on interactive elements & landmarks
  const needsName = new Set(['button', 'link', 'navigation', 'main', 'complementary', 'region', 'search', 'form', 'banner', 'contentinfo']);
  if (needsName.has(role) && !accessibleName) {
    issues.push('Missing accessible name');
  }

  // Missing alt on images
  if (tag === 'img' && !el.hasAttribute('alt')) {
    issues.push('Missing alt text');
  }

  // Missing form label
  const formRoles = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch']);
  if (formRoles.has(role) && !accessibleName) {
    issues.push('Missing form label');
  }

  // Empty heading
  if (categoryName === 'Headings' && !accessibleName) {
    issues.push('Empty heading');
  }

  // Skipped heading level
  if (categoryName === 'Headings' && level && lastHeadingLevel > 0) {
    if (level > lastHeadingLevel + 1) {
      issues.push('Skipped heading level (h' + lastHeadingLevel + ' \u2192 h' + level + ')');
    }
  }

  // Positive tabindex
  if (el.tabIndex > 0) {
    issues.push('Positive tabindex (' + el.tabIndex + ')');
  }

  return issues;
}

/**
 * Scroll to an element and highlight it.
 */
async function scrollAndHighlight({ selector, duration = 2000, color = 'rgba(59, 130, 246, 0.3)' }) {
  if (!selector) throw new Error('selector is required');
  const el = document.querySelector(selector);
  if (!el) throw new Error('Element not found: ' + selector);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Wait for scroll to settle
  await new Promise(r => setTimeout(r, 350));
  return highlightElement({ selector, duration, color });
}

// ── WCAG Inspect Mode ──────────────────────────────────────────
//
// Interactive hover inspection overlay that shows WCAG info for
// elements under the cursor — role, accessible name, unique
// identifiers, and any a11y issues.

let _wcagInspectOverlay = null;

// Combined selector for all WCAG-relevant elements
const WCAG_INSPECT_SELECTOR = [
  // Landmarks
  'nav', 'main', 'header', 'footer', 'aside',
  'section[aria-label]', 'section[aria-labelledby]',
  'form[aria-label]', 'form[aria-labelledby]',
  '[role="banner"]', '[role="navigation"]', '[role="main"]',
  '[role="contentinfo"]', '[role="complementary"]', '[role="region"]', '[role="search"]',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]',
  // Forms
  'input:not([type="hidden"])', 'textarea', 'select',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
  '[role="listbox"]', '[role="spinbutton"]', '[role="slider"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  // Buttons
  'button', '[role="button"]', 'summary',
  // Links
  'a[href]', '[role="link"]',
  // Images
  'img', '[role="img"]', 'svg[aria-label]', 'svg[role="img"]',
  // Tables
  'table', '[role="table"]', '[role="grid"]',
  // Other interactive/semantic
  '[role="tab"]', '[role="menuitem"]', '[role="option"]',
  '[role="dialog"]', '[role="alertdialog"]', '[role="alert"]',
  '[role="status"]', '[role="progressbar"]', '[role="tablist"]',
  '[role="menu"]', '[role="menubar"]', '[role="tree"]', '[role="treeitem"]',
  'dialog', '[contenteditable="true"]',
].join(', ');

/**
 * Walk up from el to find the nearest WCAG-relevant ancestor (or el itself).
 * Returns the element, or null if nothing relevant found.
 */
function findNearestWcagElement(el) {
  let current = el;
  while (current && current !== document.documentElement && current !== document.body) {
    try {
      if (current.matches && current.matches(WCAG_INSPECT_SELECTOR)) {
        return current;
      }
    } catch (e) { /* matches can throw on pseudo selectors */ }
    current = current.parentElement;
  }
  return null;
}

/**
 * Determine the best unique identifier for an element.
 * Returns { type, value } or null.
 */
function getBestIdentifier(el) {
  if (el.id) return { type: 'id', value: '#' + el.id, unique: true };

  const testId = el.getAttribute('data-testid');
  if (testId) return { type: 'data-testid', value: testId, unique: true };

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    const sel = tag + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
    const isUnique = document.querySelectorAll(sel).length === 1;
    return { type: 'aria-label', value: ariaLabel, unique: isUnique };
  }

  const name = el.getAttribute('name');
  if (name) {
    const sel = '[name="' + CSS.escape(name) + '"]';
    const isUnique = document.querySelectorAll(sel).length === 1;
    return { type: 'name', value: name, unique: isUnique };
  }

  // Text content — buttons, links, headings, etc. with readable text
  // Uses findElementByText() to verify whether the text uniquely locates this element
  const tag = el.tagName.toLowerCase();
  const textTags = new Set(['button', 'a', 'summary', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const role = el.getAttribute('role');
  if (textTags.has(tag) || role === 'button' || role === 'link' || role === 'heading') {
    const text = getDirectText(el).trim();
    if (text && text.length > 0 && text.length <= 80) {
      let isUnique = false;
      try {
        const matches = findElementByText({ text, tag, exact: true, limit: 2 });
        isUnique = matches.length === 1;
      } catch (e) { /* findElementByText failed, treat as non-unique */ }
      return { type: 'text', value: text, unique: isUnique };
    }
  }

  // Accessible name from label (for form fields)
  // Also check if the label text can uniquely find this element via findElementByText
  const accName = computeAccessibleName(el);
  if (accName && accName.length > 0 && accName.length <= 80) {
    let isUnique = false;
    try {
      // Check if searching by this text among same-tag elements finds exactly one
      const matches = findElementByText({ text: accName, tag, exact: true, limit: 2 });
      isUnique = matches.length === 1;
    } catch (e) { /* treat as non-unique */ }
    return { type: 'label', value: accName, unique: isUnique };
  }

  const title = el.getAttribute('title');
  if (title) {
    let isUnique = false;
    try {
      const matches = findElementsWithText({ selector: tag, text: title, exact: true, limit: 2 });
      isUnique = matches.length === 1;
    } catch (e) { /* treat as non-unique */ }
    return { type: 'title', value: title, unique: isUnique };
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) {
    let isUnique = false;
    try {
      const matches = findElementsWithText({ selector: tag, text: placeholder, exact: true, limit: 2 });
      isUnique = matches.length === 1;
    } catch (e) { /* treat as non-unique */ }
    return { type: 'placeholder', value: placeholder, unique: isUnique };
  }

  const alt = el.getAttribute('alt');
  if (alt) {
    let isUnique = false;
    try {
      const matches = findElementsWithText({ selector: tag, text: alt, exact: true, limit: 2 });
      isUnique = matches.length === 1;
    } catch (e) { /* treat as non-unique */ }
    return { type: 'alt', value: alt, unique: isUnique };
  }

  return null;
}

/**
 * Get all resolver strategies that could locate this element.
 * Mirrors the ElementResolver fallback chain in resolver.ts:
 *   1. placeholder  (CSS selector [placeholder="..."])
 *   2. selector     (buildUniqueSelector or id-based)
 *   3. aria-label   (CSS selector [aria-label="..."])
 *   4. textContent  (findElementByText)
 *   5. name         (CSS selector [name="..."])
 *   6. data-testid  (CSS selector [data-testid="..."])
 *
 * Returns an array of { method, value, unique, matchCount } objects.
 */
function getResolverStrategies(el) {
  var tag = el.tagName.toLowerCase();
  var strategies = [];

  // 1. id — always unique
  if (el.id) {
    strategies.push({ method: 'id', value: '#' + el.id, unique: true, matchCount: 1 });
  }

  // 2. data-testid — typically unique
  var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) {
    var cnt = document.querySelectorAll('[data-testid="' + CSS.escape(testId) + '"],[data-test-id="' + CSS.escape(testId) + '"]').length;
    strategies.push({ method: 'data-testid', value: testId, unique: cnt === 1, matchCount: cnt });
  }

  // 3. placeholder — stable for form fields
  var placeholder = el.getAttribute('placeholder');
  if (placeholder) {
    var cnt = document.querySelectorAll('[placeholder="' + CSS.escape(placeholder) + '"]').length;
    strategies.push({ method: 'placeholder', value: placeholder, unique: cnt === 1, matchCount: cnt });
  }

  // 4. CSS selector from buildUniqueSelector
  var selector = buildUniqueSelector(el);
  var selectorCount = 0;
  try { selectorCount = document.querySelectorAll(selector).length; } catch (e) { selectorCount = 0; }
  strategies.push({ method: 'selector', value: selector, unique: selectorCount === 1, matchCount: selectorCount });

  // 5. aria-label
  var ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    var sel = '[aria-label="' + CSS.escape(ariaLabel) + '"]';
    var cnt = document.querySelectorAll(sel).length;
    strategies.push({ method: 'aria-label', value: ariaLabel, unique: cnt === 1, matchCount: cnt });
  }

  // 6. Text content via findElementByText
  var text = getDirectText(el).trim();
  if (!text) text = (el.textContent || '').trim();
  if (text && text.length > 0 && text.length <= 80) {
    try {
      var matches = findElementByText({ text: text, tag: tag, exact: true, limit: 5 });
      strategies.push({ method: 'text', value: text, unique: matches.length === 1, matchCount: matches.length });
    } catch (e) {
      strategies.push({ method: 'text', value: text, unique: false, matchCount: -1 });
    }
  }

  // 7. name attribute — stable for form fields
  var name = el.getAttribute('name');
  if (name) {
    var sel = '[name="' + CSS.escape(name) + '"]';
    var cnt = document.querySelectorAll(sel).length;
    strategies.push({ method: 'name', value: name, unique: cnt === 1, matchCount: cnt });
  }

  // 8. Accessible name (label association)
  var accName = computeAccessibleName(el);
  if (accName && accName.length > 0 && accName.length <= 80) {
    // Check if accessible name differs from text (avoid duplicate)
    if (accName !== text) {
      try {
        var matches = findElementByText({ text: accName, tag: tag, exact: true, limit: 5 });
        strategies.push({ method: 'label', value: accName, unique: matches.length === 1, matchCount: matches.length });
      } catch (e) {
        strategies.push({ method: 'label', value: accName, unique: false, matchCount: -1 });
      }
    }
  }

  // 9. title attribute
  var title = el.getAttribute('title');
  if (title) {
    try {
      var matches = findElementsWithText({ selector: tag, text: title, exact: true, limit: 5 });
      strategies.push({ method: 'title', value: title, unique: matches.length === 1, matchCount: matches.length });
    } catch (e) {
      strategies.push({ method: 'title', value: title, unique: false, matchCount: -1 });
    }
  }

  return strategies;
}

/**
 * Determine the WCAG category for an element.
 */
function getWcagCategory(el) {
  const tag = el.tagName.toLowerCase();
  const role = getImplicitRole(el) || '';

  if (['nav', 'main', 'aside'].includes(tag) ||
      (tag === 'header' || tag === 'footer') ||
      ['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'search'].includes(role)) {
    return 'Landmark';
  }
  if (/^h[1-6]$/.test(tag) || role === 'heading') return 'Heading';
  if (['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch'].includes(role)) return 'Form';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'Form';
  if (role === 'button' || tag === 'button' || tag === 'summary') return 'Button';
  if (role === 'link' || (tag === 'a' && el.hasAttribute('href'))) return 'Link';
  if (role === 'img' || tag === 'img') return 'Image';
  if (['table', 'grid'].includes(role) || tag === 'table') return 'Table';
  return 'Interactive';
}

function startWcagInspect(params) {
  // Remove any existing inspect overlay
  stopWcagInspect();

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'woodbury-wcag-inspect-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;pointer-events:auto;background:transparent;';

  // Highlight box
  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:fixed;pointer-events:none;border-radius:3px;display:none;transition:left 0.05s,top 0.05s,width 0.05s,height 0.05s;';
  overlay.appendChild(highlight);

  // Info tooltip panel (multi-line)
  const tooltip = document.createElement('div');
  tooltip.style.cssText = [
    'position:fixed', 'pointer-events:none',
    'background:#0f172a', 'color:#e2e8f0',
    'font-size:11px', 'font-family:system-ui,-apple-system,sans-serif',
    'padding:8px 12px', 'border-radius:6px',
    'border:1px solid #334155',
    'display:none', 'z-index:2147483647',
    'max-width:420px', 'line-height:1.5',
    'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
  ].join(';');
  overlay.appendChild(tooltip);

  // Bottom hint bar
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);pointer-events:none;background:#0f172aee;color:#94a3b8;font-size:13px;font-family:system-ui,sans-serif;padding:6px 16px;border-radius:8px;border:1px solid #334155;white-space:nowrap;';
  hint.textContent = '\u2705 WCAG Inspect Mode \u00b7 Esc to exit';
  overlay.appendChild(hint);

  let lastWcagEl = null;

  overlay.addEventListener('mousemove', function(e) {
    // Hide overlay to find real element underneath
    overlay.style.display = 'none';
    const rawEl = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.display = '';

    if (!rawEl || rawEl === document.documentElement || rawEl === document.body) {
      highlight.style.display = 'none';
      tooltip.style.display = 'none';
      lastWcagEl = null;
      return;
    }

    // Find nearest WCAG-relevant element
    const wcagEl = findNearestWcagElement(rawEl);
    const targetEl = wcagEl || rawEl;

    // Skip re-rendering if same element
    if (targetEl === lastWcagEl) {
      // Still reposition tooltip near cursor
      positionTooltip(tooltip, targetEl, e.clientX, e.clientY);
      return;
    }
    lastWcagEl = targetEl;

    const rect = targetEl.getBoundingClientRect();
    const isWcag = !!wcagEl;

    // Update highlight box
    highlight.style.display = '';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    if (isWcag) {
      highlight.style.border = '2px solid #3b82f6';
      highlight.style.background = 'rgba(59,130,246,0.08)';
    } else {
      highlight.style.border = '2px dashed #64748b';
      highlight.style.background = 'rgba(100,116,139,0.05)';
    }

    // Build tooltip content
    const tag = targetEl.tagName.toLowerCase();
    const role = getImplicitRole(targetEl) || '';
    const accName = computeAccessibleName(targetEl);
    const strategies = getResolverStrategies(targetEl);

    let html = '';

    // Row 1: Tag + Role + Category
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
    html += '<span style="background:#1e293b;color:#94a3b8;padding:1px 6px;border-radius:3px;font-family:monospace;font-size:10px;">&lt;' + escapeHtml(tag) + '&gt;</span>';
    if (role) {
      html += '<span style="background:#1e3a5f;color:#60a5fa;padding:1px 6px;border-radius:3px;font-size:10px;">role=' + escapeHtml(role) + '</span>';
    }
    if (isWcag) {
      const cat = getWcagCategory(targetEl);
      html += '<span style="background:#064e3b;color:#6ee7b7;padding:1px 6px;border-radius:3px;font-size:10px;">' + escapeHtml(cat) + '</span>';
    } else {
      html += '<span style="background:#44403c;color:#a8a29e;padding:1px 6px;border-radius:3px;font-size:10px;">Non-WCAG</span>';
    }
    html += '</div>';

    // Row 2: Accessible Name
    if (accName) {
      html += '<div style="color:#e2e8f0;margin-bottom:3px;">\u{1F3F7}\uFE0F <strong>Name:</strong> "' + escapeHtml(accName.substring(0, 80)) + (accName.length > 80 ? '\u2026' : '') + '"</div>';
    } else if (isWcag) {
      html += '<div style="color:#fca5a5;margin-bottom:3px;">\u26a0\uFE0F <strong>No accessible name</strong></div>';
    }

    // Row 3: Resolver strategies — how workflow steps can find this element
    if (strategies.length > 0) {
      html += '<div style="margin-top:2px;margin-bottom:2px;">';
      html += '<div style="color:#94a3b8;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Findable via</div>';
      var uniqueStrategies = strategies.filter(function(s) { return s.unique; });
      var nonUniqueStrategies = strategies.filter(function(s) { return !s.unique; });

      // Show unique strategies first (green)
      for (var si = 0; si < uniqueStrategies.length; si++) {
        var s = uniqueStrategies[si];
        var displayVal = s.value.length > 50 ? s.value.substring(0, 50) + '\u2026' : s.value;
        html += '<div style="color:#6ee7b7;margin-bottom:1px;font-size:10px;">';
        html += '\u2705 <strong>' + escapeHtml(s.method) + ':</strong> ';
        html += '<span style="font-family:monospace;font-size:10px;">' + escapeHtml(displayVal) + '</span>';
        html += '</div>';
      }

      // Show non-unique strategies (yellow)
      for (var si = 0; si < nonUniqueStrategies.length; si++) {
        var s = nonUniqueStrategies[si];
        var displayVal = s.value.length > 50 ? s.value.substring(0, 50) + '\u2026' : s.value;
        var countLabel = s.matchCount > 0 ? ' (' + s.matchCount + ' matches)' : ' (not unique)';
        html += '<div style="color:#fbbf24;margin-bottom:1px;font-size:10px;">';
        html += '\u26a0\uFE0F <strong>' + escapeHtml(s.method) + ':</strong> ';
        html += '<span style="font-family:monospace;font-size:10px;">' + escapeHtml(displayVal) + '</span>';
        html += '<span style="font-size:9px;color:#a8a29e;">' + escapeHtml(countLabel) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    } else if (isWcag) {
      html += '<div style="color:#fca5a5;margin-bottom:3px;">\u274c <strong>No identifier</strong> — element cannot be located by selector, text, or attributes</div>';
    }

    // Row 4: Issues (only for WCAG elements)
    if (isWcag) {
      const issues = detectA11yIssues(targetEl, tag, role, accName, getWcagCategory(targetEl), null, null);
      if (issues.length > 0) {
        html += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;">';
        for (let i = 0; i < issues.length; i++) {
          html += '<span style="background:#7f1d1d;color:#fca5a5;padding:1px 6px;border-radius:3px;font-size:10px;">' + escapeHtml(issues[i]) + '</span>';
        }
        html += '</div>';
      }
    }

    tooltip.innerHTML = html;
    tooltip.style.display = '';
    positionTooltip(tooltip, targetEl, e.clientX, e.clientY);
  });

  // Click: pin element info and send to sidepanel
  overlay.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();

    if (!lastWcagEl) return;

    var el = lastWcagEl;
    var tag = el.tagName.toLowerCase();
    var role = getImplicitRole(el) || '';
    var accName = computeAccessibleName(el);
    var isWcag = !!findNearestWcagElement(el);
    var category = isWcag ? getWcagCategory(el) : null;
    var strategies = getResolverStrategies(el);
    var issues = isWcag ? detectA11yIssues(el, tag, role, accName, category, null, null) : [];

    // Gather extra attributes that might be useful
    var attrs = {};
    if (el.id) attrs.id = el.id;
    if (el.className && typeof el.className === 'string') attrs.class = el.className;
    if (el.getAttribute('name')) attrs.name = el.getAttribute('name');
    if (el.getAttribute('type')) attrs.type = el.getAttribute('type');
    if (el.getAttribute('href')) attrs.href = el.getAttribute('href');
    if (el.getAttribute('src')) attrs.src = el.getAttribute('src');
    if (el.getAttribute('alt')) attrs.alt = el.getAttribute('alt');
    if (el.getAttribute('title')) attrs.title = el.getAttribute('title');
    if (el.getAttribute('placeholder')) attrs.placeholder = el.getAttribute('placeholder');
    if (el.getAttribute('aria-label')) attrs['aria-label'] = el.getAttribute('aria-label');
    if (el.getAttribute('data-testid')) attrs['data-testid'] = el.getAttribute('data-testid');

    chrome.runtime.sendMessage({
      type: 'wcag_inspect_clicked',
      data: {
        tag: tag,
        role: role,
        accName: accName,
        isWcag: isWcag,
        category: category,
        strategies: strategies,
        issues: issues,
        attrs: attrs,
        outerHtml: el.outerHTML.substring(0, 300)
      }
    });
  });

  // Escape key to exit
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopWcagInspect();
      chrome.runtime.sendMessage({ type: 'wcag_inspect_stopped' });
      document.removeEventListener('keydown', onKeyDown, true);
    }
  }
  document.addEventListener('keydown', onKeyDown, true);
  overlay._keyHandler = onKeyDown;

  document.body.appendChild(overlay);
  _wcagInspectOverlay = overlay;

  return { inspecting: true };
}

/**
 * Position tooltip near the element, preferring above the highlight,
 * falling back below, and keeping within viewport bounds.
 */
function positionTooltip(tooltip, el, mouseX, mouseY) {
  const rect = el.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  const pad = 8;

  // Try above the element
  let top = rect.top - tipRect.height - pad;
  let left = Math.max(pad, Math.min(rect.left, window.innerWidth - tipRect.width - pad));

  // If above doesn't fit, put below
  if (top < pad) {
    top = rect.bottom + pad;
  }

  // If still doesn't fit (element fills viewport), follow mouse
  if (top + tipRect.height > window.innerHeight - pad) {
    top = mouseY - tipRect.height - 16;
    if (top < pad) top = mouseY + 16;
  }

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stopWcagInspect() {
  if (_wcagInspectOverlay) {
    if (_wcagInspectOverlay._keyHandler) {
      document.removeEventListener('keydown', _wcagInspectOverlay._keyHandler, true);
    }
    _wcagInspectOverlay.remove();
    _wcagInspectOverlay = null;
  }
  return { inspecting: false };
}

// ── Recording Mode ─────────────────────────────────────────────
//
// When recording mode is active, DOM events (click, input, keydown,
// navigation) are captured with element metadata and sent back to
// the Woodbury bridge server as recording_event messages.
//

let recordingActive = false;
let recordingModeType = 'standard'; // 'standard' or 'accessibility'

/**
 * Build multiple selectors for an element (primary + fallbacks).
 */
function buildSelectorSet(el) {
  const selectors = [];

  // 1. ID-based (most stable)
  if (el.id) {
    selectors.push(`#${CSS.escape(el.id)}`);
  }

  // 2. data-testid (commonly stable in test-instrumented apps)
  const testId = el.getAttribute('data-testid');
  if (testId) {
    selectors.push(`[data-testid="${CSS.escape(testId)}"]`);
  }

  // 3. Unique aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    const sel = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    try {
      if (document.querySelectorAll(sel).length === 1) {
        selectors.push(sel);
      }
    } catch { /* invalid selector */ }
  }

  // 4. Tag + classes (medium stability)
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(c => c.length > 0);
    if (classes.length > 0 && classes.length <= 4) {
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
      try {
        if (document.querySelectorAll(sel).length <= 3) {
          selectors.push(sel);
        }
      } catch { /* invalid selector */ }
    }
  }

  // 5. nth-of-type path (least stable, last resort)
  const pathSel = buildUniqueSelector(el);
  if (pathSel && !selectors.includes(pathSel)) {
    selectors.push(pathSel);
  }

  return selectors;
}

/**
 * Capture element metadata for a recording event.
 */
function captureElementMeta(el) {
  const selectors = buildSelectorSet(el);
  const rect = el.getBoundingClientRect();

  // Find the nearest interactive ancestor (button, a, input, etc.) for ML matching.
  // When users click a <span> inside a <button>, the snapshot captures the <button>,
  // so we need the ancestor's selector to match snapshot elements to interactions.
  const interactiveTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'label', 'summary']);
  const interactiveRoles = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'slider', 'combobox', 'option']);
  let interactiveAncestor = null;
  let current = el;
  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const role = current.getAttribute('role') || '';
    if (interactiveTags.has(tag) || interactiveRoles.has(role)) {
      interactiveAncestor = current;
      break;
    }
    current = current.parentElement;
  }
  let interactiveAncestorSelector = undefined;
  if (interactiveAncestor && interactiveAncestor !== el) {
    try {
      const ancestorSels = buildSelectorSet(interactiveAncestor);
      interactiveAncestorSelector = ancestorSels[0] || buildUniqueSelector(interactiveAncestor);
    } catch {}
  }

  // Viewport dimensions for percentage-based positioning
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // Capture contextual information for disambiguating similar elements
  const context = getElementContext(el);

  // Count how many siblings have the same visible text (helps identify nth-of-type)
  const myText = getDirectText(el).trim().toLowerCase();
  let nthWithSameText = 0;
  let totalWithSameText = 0;
  if (myText) {
    const tag = el.tagName.toLowerCase();
    try {
      const sameTagEls = document.querySelectorAll(tag);
      for (const sib of sameTagEls) {
        const sibText = getDirectText(sib).trim().toLowerCase();
        if (sibText === myText) {
          const style = window.getComputedStyle(sib);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            totalWithSameText++;
            if (sib === el) {
              nthWithSameText = totalWithSameText;
            }
          }
        }
      }
    } catch {}
  }

  return {
    selector: selectors[0] || '',
    fallbackSelectors: selectors.slice(1),
    ariaLabel: el.getAttribute('aria-label') || undefined,
    textContent: getDirectText(el).substring(0, 200) || undefined,
    description: undefined, // Can be filled in later by the recorder
    bounds: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      // Viewport-relative percentages (resolution-independent)
      pctX: Math.round((centerX / vw) * 10000) / 100,   // center X as % of viewport width
      pctY: Math.round((centerY / vh) * 10000) / 100,    // center Y as % of viewport height
      pctW: Math.round((rect.width / vw) * 10000) / 100, // width as % of viewport width
      pctH: Math.round((rect.height / vh) * 10000) / 100,// height as % of viewport height
      viewportW: vw,
      viewportH: vh,
    },
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || undefined,
    inputType: el.getAttribute('type') || undefined,
    value: el.value !== undefined ? String(el.value).substring(0, 500) : undefined,
    // Additional attributes for smarter element resolution during playback
    placeholder: el.getAttribute('placeholder') || undefined,
    title: el.getAttribute('title') || undefined,
    alt: el.getAttribute('alt') || undefined,
    name: el.getAttribute('name') || undefined,
    dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
    // Contextual information for disambiguating similar elements (e.g., 2 "Create" buttons)
    context: {
      ancestors: context.ancestors || undefined,
      landmark: context.landmark || undefined,
      nearestHeading: context.nearestHeading || undefined,
      siblings: context.siblings || undefined,
      label: context.label || undefined,
      nthWithSameText: totalWithSameText > 1 ? nthWithSameText : undefined,
      totalWithSameText: totalWithSameText > 1 ? totalWithSameText : undefined,
    },
    // Selector of nearest interactive ancestor (button, a, input, etc.)
    // for matching click targets to snapshot elements when the click landed on a child
    interactiveAncestorSelector,
  };
}

/**
 * Snapshot all visible interactive elements on the page.
 * Returns metadata for every button, link, input, etc. that is visible in the viewport.
 * Used by the ML crop capture system to capture all elements at once.
 */
function snapshotInteractiveElements() {
  const selectors = [
    'button', '[role="button"]', '[role="tab"]', '[role="menuitem"]',
    'a[href]', 'input', 'textarea', 'select',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="slider"]', '[role="combobox"]', '[role="listbox"]',
    '[contenteditable="true"]',
    'summary', 'details > summary',
    'label', '[role="link"]', '[role="option"]',
    'img[alt]', 'svg[role]', '[tabindex]',
  ];

  const seen = new Set();
  const elements = [];

  for (const sel of selectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        // Skip elements with aria-hidden="true"
        if (el.getAttribute('aria-hidden') === 'true') continue;

        const rect = el.getBoundingClientRect();
        // Skip tiny or off-viewport elements
        if (rect.width < 8 || rect.height < 8) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (rect.right < 0 || rect.left > window.innerWidth) continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().slice(0, 100);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const role = el.getAttribute('role') || '';

        // Build a unique selector for this element (use same strategy as recording clicks)
        let elSelector = '';
        try {
          const selectorSet = buildSelectorSet(el);
          elSelector = selectorSet[0] || buildUniqueSelector(el) || tag;
        } catch {
          elSelector = tag;
        }

        elements.push({
          selector: elSelector,
          tag,
          text,
          ariaLabel,
          role,
          type: el.type || '',
          bounds: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    } catch {
      // Skip invalid selectors
    }
  }

  console.log('[Woodbury CROP] snapshotInteractiveElements:', elements.length, 'elements found');
  return {
    url: location.href,
    title: document.title,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    elements,
  };
}

/**
 * Send a recording event to the background script for relay to Woodbury.
 */
function sendRecordingEvent(eventType, element, extra = {}) {
  console.log('[Woodbury REC:content] sendRecordingEvent', eventType, element?.tagName, (element?.textContent || '').slice(0, 30), 'mode:', recordingModeType);

  const page = { url: location.href, title: document.title };
  const timestamp = Date.now();

  // In accessibility mode, use async metadata capture (for SVG fingerprinting etc.)
  if (recordingModeType === 'accessibility' && extra._originalEvent) {
    const originalEvent = extra._originalEvent;
    delete extra._originalEvent;
    captureAccessibilityMeta(element, originalEvent).then(meta => {
      const event = {
        type: 'recording_event',
        event: eventType,
        element: meta,
        page,
        timestamp,
        ...extra,
      };
      chrome.runtime.sendMessage(event);
    }).catch(err => {
      console.warn('[Woodbury REC:content] captureAccessibilityMeta failed, falling back to standard', err);
      const event = {
        type: 'recording_event',
        event: eventType,
        element: captureElementMeta(element),
        page,
        timestamp,
        ...extra,
      };
      chrome.runtime.sendMessage(event);
    });
  } else {
    const event = {
      type: 'recording_event',
      event: eventType,
      element: captureElementMeta(element),
      page,
      timestamp,
      ...extra,
    };
    chrome.runtime.sendMessage(event);
  }
}

// Recording event handlers

function onRecordClick(e) {
  if (!recordingActive) return;
  // Skip clicks on the Woodbury recording overlay itself
  if (e.target.closest('[data-woodbury-recording]')) return;

  // Gather similar visible elements for hard-negative mining (ML training)
  const el = e.target;
  const tag = el.tagName.toLowerCase();
  const similarSelectors = {
    button: 'button, [role="button"]',
    a: 'a[href]',
    input: 'input',
    textarea: 'textarea',
    select: 'select',
    img: 'img',
  };
  const searchSel = similarSelectors[tag] || '';
  let similarElements = [];
  if (searchSel) {
    try {
      const candidates = document.querySelectorAll(searchSel);
      for (const candidate of candidates) {
        if (candidate === el) continue;
        if (similarElements.length >= 5) break;
        const rect = candidate.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (rect.right < 0 || rect.left > window.innerWidth) continue;
        similarElements.push({
          selector: buildUniqueSelector(candidate),
          tag: candidate.tagName.toLowerCase(),
          textContent: (candidate.textContent || '').trim().slice(0, 100),
          ariaLabel: candidate.getAttribute('aria-label') || '',
          bounds: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    } catch (err) {
      // Ignore selector errors
    }
  }

  // Detect file input clicks — send as file_dialog event so the recorder
  // creates a FileDialogStep instead of a plain ClickStep
  const isFileInput = (el.tagName === 'INPUT' && el.type === 'file') ||
    (el.closest && el.closest('input[type="file"]'));
  if (isFileInput) {
    const fileInput = el.tagName === 'INPUT' ? el : el.closest('input[type="file"]');
    // Let the native file dialog open — don't block it during recording
    sendRecordingEvent('file_dialog', fileInput || el, { similarElements, _originalEvent: e });
    return;
  }

  sendRecordingEvent('click', el, { similarElements, _originalEvent: e });
}

function onRecordInput(e) {
  if (!recordingActive) return;
  sendRecordingEvent('input', e.target, { _originalEvent: e });
}

function onRecordKeydown(e) {
  if (!recordingActive) return;
  // Only capture special keys (Enter, Escape, Tab, etc.) not regular typing
  const specialKeys = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '];
  if (!specialKeys.includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;

  // Navigation keys that move focus — capture focused element AFTER focus moves
  const navKeys = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const isNavKey = navKeys.includes(e.key);

  const keyboardData = {
    keyboard: {
      key: e.key === ' ' ? 'Space' : e.key,
      modifiers: [
        e.ctrlKey && 'ctrl',
        e.shiftKey && 'shift',
        e.altKey && 'alt',
        e.metaKey && 'cmd',
      ].filter(Boolean),
    },
  };

  if (isNavKey) {
    // Use requestAnimationFrame to capture focus AFTER the browser processes
    // the Tab/Arrow key and moves focus to the next element.
    const target = e.target;
    requestAnimationFrame(() => {
      const focused = getFocusedElement();
      sendRecordingEvent('keydown', target, {
        ...keyboardData,
        focusedElement: focused.focused ? focused : undefined,
        _originalEvent: e,
      });
    });
  } else {
    sendRecordingEvent('keydown', e.target, { ...keyboardData, _originalEvent: e });
  }
}

function startRecording() {
  if (recordingActive) return;
  recordingActive = true;

  document.addEventListener('click', onRecordClick, true);
  document.addEventListener('input', onRecordInput, true);
  document.addEventListener('keydown', onRecordKeydown, true);

  // Show recording indicator
  showRecordingIndicator();
  console.log('[Woodbury Bridge] Recording mode ACTIVE');
}

function stopRecording() {
  if (!recordingActive) return;
  recordingActive = false;

  document.removeEventListener('click', onRecordClick, true);
  document.removeEventListener('input', onRecordInput, true);
  document.removeEventListener('keydown', onRecordKeydown, true);

  // Remove recording indicator
  hideRecordingIndicator();
  console.log('[Woodbury Bridge] Recording mode STOPPED');
}

function showRecordingIndicator() {
  if (document.getElementById('woodbury-recording-host')) return;

  // Use Shadow DOM so the indicator is completely isolated from the page's
  // CSS and Content Security Policy — no inline style issues, no z-index wars.
  const host = document.createElement('div');
  host.id = 'woodbury-recording-host';
  host.setAttribute('data-woodbury-recording', 'true');
  // Minimal host styles to position the shadow container
  host.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      @keyframes rec-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .rec-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        background: #dc2626;
        color: white;
        padding: 4px 12px;
        border-radius: 12px;
        font: bold 12px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        pointer-events: none;
      }
      .rec-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: white;
        animation: rec-pulse 1s infinite;
      }
    </style>
    <div class="rec-badge">
      <span class="rec-dot"></span> REC
    </div>
  `;

  document.body.appendChild(host);
}

function hideRecordingIndicator() {
  document.getElementById('woodbury-recording-host')?.remove();
}

// NOTE: set_recording_mode is handled in the main handleAction() dispatcher
// above to avoid race conditions with multiple chrome.runtime.onMessage listeners.

// ── Workflow Debug Overlay ─────────────────────────────────────
// Visual step-through mode: shows numbered markers at each interaction
// position, a step list panel, and coordinate diagnostics.

let _debugShadow = null; // reference to the shadow root for updates

const STEP_TYPE_COLORS = {
  click: '#3b82f6',
  type: '#10b981',
  navigate: '#6b7280',
  keyboard: '#8b5cf6',
  scroll: '#f59e0b',
  wait: '#64748b',
  assert: '#06b6d4',
  conditional: '#a855f7',
  loop: '#ec4899',
  try_catch: '#f97316',
  file_dialog: '#0ea5e9',
};
const STEP_TYPE_ICONS = {
  navigate: '\u{1F310}',
  click: '\u{1F5B1}',
  type: '\u{2328}',
  keyboard: '\u{2328}',
  wait: '\u{23F3}',
  scroll: '\u{2195}',
  assert: '\u{2714}',
  conditional: '\u{2696}',
  loop: '\u{1F501}',
  try_catch: '\u{1F6E1}',
  file_dialog: '\u{1F4C2}',
};

function showDebugOverlay(params) {
  // Remove existing overlay first
  hideDebugOverlay();

  const steps = params.steps || [];

  const host = document.createElement('div');
  host.id = 'woodbury-debug-host';
  host.setAttribute('data-woodbury-debug', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'closed' });
  _debugShadow = shadow;

  // Build marker HTML — position markers only (step list + controls live in the side panel)
  let markersHtml = '';
  for (const s of steps) {
    if (!s.hasPosition) continue;
    const isHover = s.type === 'click' && s.clickType === 'hover';
    const color = isHover ? '#a78bfa' : (STEP_TYPE_COLORS[s.type] || '#6b7280');
    const hoverClass = isHover ? ' dbg-marker-hover' : '';
    markersHtml += `
      <div class="dbg-marker dbg-marker-pending${hoverClass}" data-idx="${s.index}"
           style="left:${s.pctX}%;top:${s.pctY}%;border-color:${color};">
        <span class="dbg-marker-num" style="background:${color};">${s.index + 1}</span>
        <span class="dbg-marker-tip">${s.index + 1}. ${escText(s.label)}</span>
      </div>`;
  }

  shadow.innerHTML = `
    <style>
      :host { all: initial; }

      /* ── Markers only — step list + coord info live in Chrome side panel ── */
      .dbg-markers { position:absolute; inset:0; pointer-events:none; }
      .dbg-marker {
        position: absolute;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 1;
      }
      .dbg-marker-num {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        color: white;
        font: bold 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        border: 2px solid rgba(255,255,255,0.5);
      }
      .dbg-marker-tip {
        display: none;
        position: absolute;
        top: 28px;
        left: 50%;
        transform: translateX(-50%);
        background: #0f172a;
        color: #e2e8f0;
        padding: 4px 8px;
        border-radius: 4px;
        font: 11px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        pointer-events: none;
        z-index: 10;
      }
      .dbg-marker:hover .dbg-marker-tip { display: block; }

      .dbg-marker-completed .dbg-marker-num { opacity: 0.4; }
      .dbg-marker-completed::after {
        content: '\u{2714}';
        position: absolute;
        top: -4px;
        right: -6px;
        font-size: 12px;
        color: #10b981;
      }
      .dbg-marker-failed .dbg-marker-num { opacity: 0.5; }
      .dbg-marker-failed::after {
        content: '\u{2718}';
        position: absolute;
        top: -4px;
        right: -6px;
        font-size: 12px;
        color: #ef4444;
      }
      @keyframes dbg-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
        50% { box-shadow: 0 0 0 8px rgba(59,130,246,0); }
      }
      .dbg-marker-current .dbg-marker-num {
        width: 30px;
        height: 30px;
        font-size: 13px;
        animation: dbg-pulse 1.5s infinite;
      }
      @keyframes dbg-selected-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(96,165,250,0.6); }
        50% { box-shadow: 0 0 0 10px rgba(96,165,250,0); }
      }
      .dbg-marker-selected .dbg-marker-num {
        width: 32px;
        height: 32px;
        font-size: 14px;
        border: 3px solid #60a5fa;
        animation: dbg-selected-pulse 1.2s infinite;
      }
      .dbg-marker-selected .dbg-marker-tip { display: block; }

      /* Hover/move markers: dashed border to distinguish from click markers */
      .dbg-marker-hover { border-style: dashed; }
      .dbg-marker-hover .dbg-marker-num { border: 1px dashed rgba(255,255,255,0.5); }
    </style>

    <div class="dbg-markers">${markersHtml}</div>
  `;

  document.body.appendChild(host);
  return { overlayShown: true, markersRendered: steps.filter(s => s.hasPosition).length };
}

function updateDebugStep(params) {
  if (!_debugShadow) return { updated: false };

  const { currentIndex, completedIndices = [], failedIndices = [] } = params;

  // Update markers only — step list + coord info live in the Chrome side panel
  const markers = _debugShadow.querySelectorAll('.dbg-marker');
  markers.forEach(m => {
    const idx = parseInt(m.dataset.idx);
    m.className = 'dbg-marker';
    if (completedIndices.includes(idx)) {
      m.className += ' dbg-marker-completed';
    } else if (failedIndices.includes(idx)) {
      m.className += ' dbg-marker-failed';
    } else if (idx === currentIndex) {
      m.className += ' dbg-marker-current';
    } else {
      m.className += ' dbg-marker-pending';
    }
  });

  return { updated: true };
}

function updateDebugMarker(params) {
  if (!_debugShadow) return { updated: false };
  const { stepIndex, pctX, pctY } = params;
  if (stepIndex == null || pctX == null || pctY == null) return { updated: false };

  const marker = _debugShadow.querySelector('.dbg-marker[data-idx="' + stepIndex + '"]');
  if (marker) {
    marker.style.left = pctX + '%';
    marker.style.top = pctY + '%';
    return { updated: true, stepIndex, pctX, pctY };
  }
  return { updated: false, reason: 'marker not found' };
}

function selectDebugMarker(params) {
  if (!_debugShadow) return { selected: false };
  const { stepIndex } = params;

  // Remove selected class from all markers
  _debugShadow.querySelectorAll('.dbg-marker').forEach(m => {
    m.classList.remove('dbg-marker-selected');
  });

  // Add selected class to the target marker
  if (stepIndex != null) {
    const marker = _debugShadow.querySelector('.dbg-marker[data-idx="' + stepIndex + '"]');
    if (marker) {
      marker.classList.add('dbg-marker-selected');
      return { selected: true, stepIndex };
    }
  }
  return { selected: false };
}

/**
 * Query what element is at viewport coordinates (x, y).
 * Returns a fingerprint for change detection (e.g. to verify a popup appeared after clicking).
 * Does NOT click — pure DOM query.
 */
function getElementAtPoint({ x, y }) {
  if (x === undefined || y === undefined) throw new Error('x and y are required');
  const el = document.elementFromPoint(x, y);
  if (!el) return { found: false, fingerprint: null };

  const tag = el.tagName.toLowerCase();
  const id = el.id || '';
  const classes = Array.from(el.classList).slice(0, 5).join(' ');
  const role = el.getAttribute('role') || '';
  const text = (el.textContent || '').trim().slice(0, 40);
  const fingerprint = `${tag}#${id}.${classes}[role=${role}]"${text}"`;

  return { found: true, tag, id, classes, role, text, fingerprint };
}

function toggleDebugOverlay(params) {
  const host = document.getElementById('woodbury-debug-host');
  if (host) {
    host.style.display = params?.visible === false ? 'none' : '';
  }
  return { visible: params?.visible !== false };
}

function hideDebugOverlay() {
  _debugShadow = null;
  document.getElementById('woodbury-debug-host')?.remove();
  return { overlayRemoved: true };
}

// ── Element Picker for Debug Mode ──

let _pickOverlay = null;

function startElementPick(params) {
  // Remove any existing pick overlay
  stopElementPick();

  const stepIndex = params?.stepIndex ?? null;

  // Create pick overlay container
  const overlay = document.createElement('div');
  overlay.id = 'woodbury-pick-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;pointer-events:auto;background:transparent;';

  // Highlight box that follows the hovered element
  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:fixed;border:2px dashed #3b82f6;pointer-events:none;background:rgba(59,130,246,0.08);border-radius:3px;display:none;transition:left 0.05s,top 0.05s,width 0.05s,height 0.05s;';
  overlay.appendChild(highlight);

  // Element info tooltip near highlight
  const infoTip = document.createElement('div');
  infoTip.style.cssText = 'position:fixed;pointer-events:none;background:#0f172a;color:#e2e8f0;font-size:11px;font-family:system-ui,sans-serif;padding:3px 8px;border-radius:4px;border:1px solid #334155;white-space:nowrap;display:none;z-index:2147483647;';
  overlay.appendChild(infoTip);

  // Hint label at the bottom
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);pointer-events:none;background:#0f172aee;color:#94a3b8;font-size:13px;font-family:system-ui,sans-serif;padding:6px 16px;border-radius:8px;border:1px solid #334155;white-space:nowrap;';
  hint.textContent = 'Click element to select \u00b7 Esc to cancel';
  overlay.appendChild(hint);

  let lastEl = null;

  overlay.addEventListener('mousemove', function(e) {
    // Temporarily hide overlay to find the real element underneath
    overlay.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.display = '';

    if (!el || el === document.documentElement || el === document.body) {
      highlight.style.display = 'none';
      infoTip.style.display = 'none';
      lastEl = null;
      return;
    }

    lastEl = el;
    const rect = el.getBoundingClientRect();
    highlight.style.display = '';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    // Show element info tooltip
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 40);
    infoTip.textContent = tag + (text ? ' \u2014 "' + text + '"' : '');
    infoTip.style.display = '';
    // Position tooltip above the highlight box
    const tipTop = rect.top - 28;
    infoTip.style.left = Math.max(4, rect.left) + 'px';
    infoTip.style.top = (tipTop > 4 ? tipTop : rect.bottom + 4) + 'px';
  });

  overlay.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();

    // Find the real element under the click
    overlay.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.display = '';

    let pctX = (e.clientX / window.innerWidth) * 100;
    let pctY = (e.clientY / window.innerHeight) * 100;
    let elementBounds = null;
    let elementInfo = null;

    if (el && el !== document.documentElement && el !== document.body) {
      const rect = el.getBoundingClientRect();

      // Center position on the element's bounding box, not the raw click point
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      pctX = (centerX / window.innerWidth) * 100;
      pctY = (centerY / window.innerHeight) * 100;

      // Scale bounds by devicePixelRatio so the crop aligns with the captured screenshot
      const dpr = window.devicePixelRatio || 1;
      elementBounds = {
        left: Math.round(rect.left * dpr),
        top: Math.round(rect.top * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      };
      elementInfo = {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 100),
      };
    }

    // Send picked element back
    chrome.runtime.sendMessage({
      type: 'element_picked',
      stepIndex: stepIndex,
      pctX: pctX,
      pctY: pctY,
      elementBounds: elementBounds,
      elementInfo: elementInfo,
      dpr: window.devicePixelRatio || 1,
    });

    // Clean up
    stopElementPick();
  });

  // Escape key to cancel
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'element_pick_cancelled', stepIndex: stepIndex });
      stopElementPick();
      document.removeEventListener('keydown', onKeyDown, true);
    }
  }
  document.addEventListener('keydown', onKeyDown, true);
  overlay._keyHandler = onKeyDown;

  document.body.appendChild(overlay);
  _pickOverlay = overlay;

  return { picking: true };
}

function stopElementPick() {
  if (_pickOverlay) {
    if (_pickOverlay._keyHandler) {
      document.removeEventListener('keydown', _pickOverlay._keyHandler, true);
    }
    _pickOverlay.remove();
    _pickOverlay = null;
  }
  // Also remove by ID in case of stale references
  document.getElementById('woodbury-pick-overlay')?.remove();
  return { picking: false };
}

function escText(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inject / Clear Styles ────────────────────────────────────

/**
 * Apply CSS styles to all elements matching a selector.
 * Stores original inline styles for later revert via clearInjectedStyles().
 */
function injectStyle({ selector, styles }) {
  if (!selector) throw new Error('selector is required');
  if (!styles || typeof styles !== 'object' || Object.keys(styles).length === 0) {
    throw new Error('styles must be a non-empty object, e.g. { position: "absolute" }');
  }

  const elements = Array.from(document.querySelectorAll(selector));
  if (elements.length === 0) {
    throw new Error('No elements match selector: ' + selector);
  }

  // Track originals for revert
  const tracked = [];
  for (const el of elements) {
    tracked.push({ el, originalStyle: el.style.cssText || '' });

    // Apply each style property
    for (const [prop, value] of Object.entries(styles)) {
      el.style.setProperty(
        // Convert camelCase to kebab-case: backgroundColor → background-color
        prop.replace(/([A-Z])/g, '-$1').toLowerCase(),
        value,
        'important'
      );
    }

    el.setAttribute('data-woodbury-styled', selector);
  }

  // Store (append to existing if same selector used multiple times)
  const existing = _woodburyInjectedStyles.get(selector) || [];
  _woodburyInjectedStyles.set(selector, existing.concat(tracked));

  return { applied: true, elementsModified: elements.length, selector };
}

/**
 * Revert previously injected styles.
 * If selector is given, only revert elements for that selector.
 * If no selector, revert ALL injected styles.
 */
function clearInjectedStyles({ selector } = {}) {
  let reverted = 0;

  if (selector) {
    const tracked = _woodburyInjectedStyles.get(selector);
    if (tracked) {
      for (const { el, originalStyle } of tracked) {
        el.style.cssText = originalStyle;
        el.removeAttribute('data-woodbury-styled');
        reverted++;
      }
      _woodburyInjectedStyles.delete(selector);
    }
  } else {
    // Clear ALL
    for (const [sel, tracked] of _woodburyInjectedStyles.entries()) {
      for (const { el, originalStyle } of tracked) {
        el.style.cssText = originalStyle;
        el.removeAttribute('data-woodbury-styled');
        reverted++;
      }
    }
    _woodburyInjectedStyles.clear();
  }

  return { cleared: true, elementsReverted: reverted, selector: selector || 'all' };
}

// ── Click Target Overlay ────────────────────────────────────
// Semi-transparent overlay that moves to where the mouse is about to click,
// showing the CSS selector so you can visually verify targets.

const CLICK_TARGET_ID = '__woodbury_click_target__';

/**
 * Show (or move) the click-target overlay to highlight an element's bounds.
 *
 * @param {object} params
 * @param {number} params.left    - viewport left px
 * @param {number} params.top     - viewport top px
 * @param {number} params.width   - element width px
 * @param {number} params.height  - element height px
 * @param {string} params.label   - text to display (CSS selector, etc.)
 * @param {number} [params.durationMs] - auto-hide after this many ms (0 = manual hide)
 */
function showClickTarget({ left, top, width, height, label = '', durationMs = 0 }) {
  let overlay = document.getElementById(CLICK_TARGET_ID);

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = CLICK_TARGET_ID;
    document.documentElement.appendChild(overlay);
  }

  overlay.style.cssText = [
    'position: fixed',
    'z-index: 2147483646',
    'pointer-events: none',
    'box-sizing: border-box',
    'border: 2px solid rgba(0, 120, 255, 0.8)',
    'background: rgba(0, 120, 255, 0.12)',
    'border-radius: 4px',
    'transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease',
    'display: flex',
    'align-items: flex-start',
    'justify-content: flex-start',
    'overflow: visible',
    'left: ' + left + 'px',
    'top: ' + top + 'px',
    'width: ' + width + 'px',
    'height: ' + height + 'px',
  ].join('; ');

  // Label badge — positioned above the overlay box
  overlay.innerHTML = label
    ? '<div style="' + [
        'position: absolute',
        'bottom: 100%',
        'left: 0',
        'margin-bottom: 4px',
        'background: rgba(0, 0, 0, 0.8)',
        'color: #4fc3f7',
        'font-family: monospace',
        'font-size: 11px',
        'padding: 3px 8px',
        'border-radius: 3px',
        'white-space: nowrap',
        'max-width: 500px',
        'overflow: hidden',
        'text-overflow: ellipsis',
        'pointer-events: none',
        'line-height: 1.3',
      ].join('; ') + '">' + label.replace(/</g, '&lt;') + '</div>'
    : '';

  if (durationMs > 0) {
    if (overlay._hideTimer) clearTimeout(overlay._hideTimer);
    overlay._hideTimer = setTimeout(() => hideClickTarget(), durationMs);
  }

  return { shown: true };
}

/**
 * Remove the click-target overlay.
 */
function hideClickTarget() {
  const overlay = document.getElementById(CLICK_TARGET_ID);
  if (overlay) {
    if (overlay._hideTimer) clearTimeout(overlay._hideTimer);
    overlay.remove();
    return { hidden: true };
  }
  return { hidden: false };
}

// ── Calibration Marker ──────────────────────────────────────
// Injects a brightly colored marker at viewport (0,0) so that
// the workflow runner can scan screen pixels with robotjs to
// find the exact viewport-to-screen offset on any machine.

const CALIBRATION_MARKER_ID = '__woodbury_calibration_marker__';

/**
 * Inject a calibration marker — a small colored block at viewport (0,0).
 * Color defaults to #FF00FF (magenta) but can be overridden.
 * The marker is a 6×6 block so it's easy to find via pixel scanning.
 */
function injectCalibrationMarker({ color = '#FF00FF', size = 6 } = {}) {
  // Remove existing marker if present
  const existing = document.getElementById(CALIBRATION_MARKER_ID);
  if (existing) existing.remove();

  const marker = document.createElement('div');
  marker.id = CALIBRATION_MARKER_ID;
  marker.style.cssText = [
    'position: fixed !important',
    'top: 0px !important',
    'left: 0px !important',
    `width: ${size}px !important`,
    `height: ${size}px !important`,
    `background-color: ${color} !important`,
    'z-index: 2147483647 !important',
    'pointer-events: none !important',
    'opacity: 1 !important',
    'border: none !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'box-shadow: none !important',
    'border-radius: 0 !important',
    'mix-blend-mode: normal !important',
    'transform: none !important',
  ].join('; ');
  document.documentElement.appendChild(marker);

  return {
    injected: true,
    color,
    size,
    viewport: { x: 0, y: 0 },
  };
}

/**
 * Remove the calibration marker from the page.
 */
function removeCalibrationMarker() {
  const marker = document.getElementById(CALIBRATION_MARKER_ID);
  if (marker) {
    marker.remove();
    return { removed: true };
  }
  return { removed: false, reason: 'marker not found' };
}

// Log that content script is loaded
console.log('[Woodbury Bridge] Content script loaded on', location.href);

} // end of if (!window.__woodburyContentScriptLoaded)
