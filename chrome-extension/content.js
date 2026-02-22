/**
 * Woodbury Bridge — Content Script
 *
 * Runs in the context of each web page. Handles DOM queries, element location,
 * page structure analysis, text extraction, and element interaction.
 *
 * The background service worker sends messages here; this script does the
 * actual DOM work and returns results.
 */

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
  // outerHeight includes Chrome UI (title bar, tabs, address bar, bookmarks bar)
  // innerHeight is just the viewport (page content area)
  // The difference is the Chrome UI height
  const chromeUIHeight = window.outerHeight - window.innerHeight;

  // outerWidth vs innerWidth gives horizontal offset (usually minimal)
  const chromeUIWidth = window.outerWidth - window.innerWidth;

  // screenX/screenY give the window's position on the physical screen
  // screenTop/screenLeft are aliases that work in more browsers
  const windowX = window.screenX || window.screenLeft || 0;
  const windowY = window.screenY || window.screenTop || 0;

  // devicePixelRatio matters for Retina/HiDPI displays
  const dpr = window.devicePixelRatio || 1;

  return {
    // The Chrome UI height in CSS pixels (tabs + address bar + bookmarks bar)
    chromeUIHeight,
    // Horizontal chrome offset (usually 0 or 1)
    chromeUIWidth: Math.round(chromeUIWidth / 2),
    // Chrome window position on screen
    windowX,
    windowY,
    // Total offset from screen top to viewport content
    // This is what you add to viewport-relative coords to get screen-absolute coords
    totalOffsetX: windowX + Math.round(chromeUIWidth / 2),
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

  // Calculate screen-absolute position using Chrome offset
  const chromeUIHeight = window.outerHeight - window.innerHeight;
  const chromeUIWidthHalf = Math.round((window.outerWidth - window.innerWidth) / 2);
  const windowX = window.screenX || window.screenLeft || 0;
  const windowY = window.screenY || window.screenTop || 0;

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
    // Screen-absolute position (accounting for Chrome UI and window position)
    screenX: Math.round(windowX + chromeUIWidthHalf + rect.left + rect.width / 2),
    screenY: Math.round(windowY + chromeUIHeight + rect.top + rect.height / 2),
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
 * Find elements matching a CSS selector.
 */
function findElements({ selector, limit = 20 }) {
  if (!selector) throw new Error('selector is required');

  const elements = Array.from(document.querySelectorAll(selector)).slice(0, limit);
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

// ── Action implementations ───────────────────────────────────

/**
 * Find elements matching a CSS selector.
 */
function findElements({ selector, limit = 20 }) {
  if (!selector) throw new Error('selector is required');

  const elements = Array.from(document.querySelectorAll(selector)).slice(0, limit);
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
function getClickableElements({ limit = 50 }) {
  const selectors = [
    'a[href]',
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[onclick]',
    '[data-action]',
    'summary'
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

// Log that content script is loaded
console.log('[Woodbury Bridge] Content script loaded on', location.href);
