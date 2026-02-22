/**
 * browser_query — Precise DOM interaction via the Woodbury Bridge Chrome extension.
 *
 * This tool communicates with a Chrome extension over WebSocket to query
 * the real browser DOM. Unlike vision-based approaches, this returns exact
 * pixel coordinates, CSS selectors, and element metadata — no guessing.
 *
 * The Chrome extension must be installed and connected for this tool to work.
 */

import { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import { ensureBridgeServer, bridgeServer } from '../../bridge-server.js';

export const browserQueryDefinition: ToolDefinition = {
  name: 'browser_query',
  description: `Query the real Chrome browser DOM via the Woodbury Bridge extension. Returns EXACT pixel coordinates, CSS selectors, and element details — much more precise than vision-based approaches.

Actions:
- "ping" — Check if the extension is connected and get current page URL/title.
- "find_interactive" — **BEST for finding elements.** Describe what you want in natural language (e.g. "Create project button", "email input field", "login link"). Returns ranked candidates with confidence scores and page context (which section it's in, nearest heading, sibling elements) so you can pick the right one.
- "find_elements" — Find elements by CSS selector. Returns bounds, text, attributes, and page context.
- "find_element_by_text" — Find elements containing specific text (case-insensitive). Returns exact coordinates and context.
- "get_clickable_elements" — List ALL clickable elements on the visible page (buttons, links, etc.) with their exact coordinates and context.
- "get_form_fields" — List all form inputs with their types, values, labels, and coordinates.
- "get_page_info" — Quick overview: URL, title, viewport size, counts of links/buttons/inputs/forms.
- "get_page_structure" — Structural overview of the page (headings, nav, main content areas).
- "get_page_text" — Extract visible text content from the page or a specific element.
- "click_element" — Click an element by CSS selector (triggers native click events).
- "set_value" — Set the value of an input/textarea (works with React, Vue, etc.).
- "scroll_to_element" — Scroll an element into the visible viewport.
- "get_element_info" — Get detailed info about a specific element (styles, attributes, bounds, context).
- "highlight_element" — Briefly highlight an element with a colored overlay (visual debugging).
- "wait_for_element" — Wait for an element to appear in the DOM (up to timeout).

IMPORTANT: This tool requires the Woodbury Bridge Chrome extension to be installed and connected.
Use "ping" first to verify the connection.

Each result includes PAGE CONTEXT — the section, nearest heading, and sibling elements — so you can make judgement calls about which element is the right one when multiple matches exist.`,
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action to perform. Use "find_interactive" as your primary way to find elements — it understands natural descriptions like "Create button" or "email input". One of: ping, find_interactive, find_elements, find_element_by_text, get_clickable_elements, get_form_fields, get_page_info, get_page_structure, get_page_text, click_element, set_value, scroll_to_element, get_element_info, highlight_element, wait_for_element',
        enum: [
          'ping',
          'find_interactive',
          'find_elements',
          'find_element_by_text',
          'get_clickable_elements',
          'get_form_fields',
          'get_page_info',
          'get_page_structure',
          'get_page_text',
          'click_element',
          'set_value',
          'scroll_to_element',
          'get_element_info',
          'highlight_element',
          'wait_for_element'
        ]
      },
      selector: {
        type: 'string',
        description: 'CSS selector to target elements. Used by: find_elements, get_element_bounds, click_element, set_value, scroll_to_element, get_element_info, highlight_element, wait_for_element, get_page_text (optional).'
      },
      description: {
        type: 'string',
        description: 'Natural language description of the element you want to find. Used by: find_interactive. Examples: "Create project button", "search input", "Sign In link", "email field in the registration form". Be specific about what kind of element and where it is.'
      },
      text: {
        type: 'string',
        description: 'Text to search for (case-insensitive partial match). Used by: find_element_by_text.'
      },
      tag: {
        type: 'string',
        description: 'Optional HTML tag to filter by when searching by text. Example: "button", "a", "h1".'
      },
      exact: {
        type: 'boolean',
        description: 'If true, match text exactly instead of partial match. Default: false.'
      },
      value: {
        type: 'string',
        description: 'Value to set on an input element. Used by: set_value.'
      },
      x: {
        type: 'number',
        description: 'X coordinate for click_element (alternative to selector).'
      },
      y: {
        type: 'number',
        description: 'Y coordinate for click_element (alternative to selector).'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return. Default varies by action (10-50).'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds for wait_for_element. Default: 10000.'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for get_page_structure. Default: 3.'
      }
    },
    required: ['action']
  }
};

export const browserQueryHandler: ToolHandler = async (params: any, context?: ToolContext) => {
  const action = params.action as string;
  if (!action) {
    throw new Error('action parameter is required');
  }

  // Ensure bridge server is running
  await ensureBridgeServer();

  // Check connection
  if (!bridgeServer.isConnected && action !== 'ping') {
    return formatError(
      'Chrome extension is not connected.\n\n' +
      'To use browser_query, you need:\n' +
      '1. Install the Woodbury Bridge Chrome extension (load unpacked from chrome-extension/ folder)\n' +
      '2. Have Chrome open with the extension active\n' +
      '3. The extension will auto-connect to Woodbury\'s WebSocket server on port 7865\n\n' +
      'Use browser_query(action="ping") to check connection status.\n' +
      'Meanwhile, you can still use vision_analyze + mouse + keyboard for browser interaction.'
    );
  }

  // Build params to send (strip the action field)
  const requestParams: Record<string, any> = {};
  for (const [key, val] of Object.entries(params)) {
    if (key !== 'action' && val !== undefined && val !== null) {
      requestParams[key] = val;
    }
  }

  try {
    const result = await bridgeServer.send(action, requestParams);
    return formatResult(action, result);
  } catch (err: any) {
    return formatError(`browser_query "${action}" failed: ${err.message}`);
  }
};

// ── Formatting helpers ───────────────────────────────────────

function formatResult(action: string, data: any): string {
  const lines: string[] = [];

  switch (action) {
    case 'ping':
      lines.push('# Browser Connection: OK');
      lines.push('');
      if (data.url) lines.push(`- **URL:** ${data.url}`);
      if (data.title) lines.push(`- **Title:** ${data.title}`);
      if (data.chromeOffset) {
        lines.push('');
        lines.push('### Chrome Offset (for mouse positioning)');
        lines.push(`- **Chrome UI Height:** ${data.chromeOffset.chromeUIHeight}px (use as chromeOffsetY)`);
        lines.push(`- **Chrome UI Width:** ${data.chromeOffset.chromeUIWidth}px (use as chromeOffsetX)`);
        lines.push(`- **Window Position:** (${data.chromeOffset.windowX}, ${data.chromeOffset.windowY})`);
        lines.push(`- **Total Offset to Content:** x=${data.chromeOffset.totalOffsetX}, y=${data.chromeOffset.totalOffsetY}`);
        lines.push(`- **Device Pixel Ratio:** ${data.chromeOffset.devicePixelRatio}`);
      }
      break;

    case 'get_page_info':
      lines.push('# Page Info');
      lines.push('');
      lines.push(`- **URL:** ${data.url}`);
      lines.push(`- **Title:** ${data.title}`);
      lines.push(`- **Viewport:** ${data.viewport?.width}x${data.viewport?.height}`);
      lines.push(`- **Page size:** ${data.viewport?.pageWidth}x${data.viewport?.pageHeight}`);
      lines.push(`- **Scroll:** x=${data.viewport?.scrollX}, y=${data.viewport?.scrollY}`);
      lines.push(`- **Links:** ${data.links}`);
      lines.push(`- **Buttons:** ${data.buttons}`);
      lines.push(`- **Inputs:** ${data.inputs}`);
      lines.push(`- **Forms:** ${data.forms}`);
      lines.push(`- **Images:** ${data.images}`);
      if (data.headings?.length) {
        lines.push('');
        lines.push('### Headings');
        for (const h of data.headings) {
          lines.push(`- ${h.level}: ${h.text}`);
        }
      }
      if (data.chromeOffset) {
        lines.push('');
        lines.push('### Chrome Offset (for mouse positioning)');
        lines.push(`- **Chrome UI Height:** ${data.chromeOffset.chromeUIHeight}px (use as chromeOffsetY)`);
        lines.push(`- **Chrome UI Width:** ${data.chromeOffset.chromeUIWidth}px (use as chromeOffsetX)`);
        lines.push(`- **Screen:** ${data.chromeOffset.screenWidth}x${data.chromeOffset.screenHeight} @ ${data.chromeOffset.devicePixelRatio}x`);
      }
      break;

    case 'find_interactive':
      lines.push(`# Search: "${data.query || ''}"`);
      lines.push(`Found ${data.resultCount || 0} candidates (${data.totalCandidates || 0} total scored)`);
      lines.push('');
      if (data.results?.length) {
        for (const el of data.results) {
          lines.push(formatRankedElement(el));
        }
        lines.push('');
        lines.push('**How to choose:** Look at the context (section, heading, siblings) to pick the right element. The rank #1 result has the highest score but may not be what you want if there are multiple similar elements in different sections.');
      } else {
        lines.push('No matching interactive elements found. Try a different description or use get_clickable_elements to see all options.');
      }
      break;

    case 'find_elements':
    case 'find_element_by_text':
    case 'get_clickable_elements':
      lines.push(`# Found ${Array.isArray(data) ? data.length : 0} elements`);
      lines.push('');
      if (Array.isArray(data)) {
        for (const el of data) {
          lines.push(formatElement(el));
        }
      }
      break;

    case 'get_form_fields':
      lines.push(`# Form Fields (${Array.isArray(data) ? data.length : 0})`);
      lines.push('');
      if (Array.isArray(data)) {
        for (const field of data) {
          lines.push(formatFormField(field));
        }
      }
      break;

    case 'click_element':
      lines.push('# Click Result');
      lines.push('');
      lines.push(`- **Clicked:** ${data.clicked ? 'Yes' : 'No'}`);
      if (data.element) {
        lines.push(`- **Element:** ${elementSummary(data.element)}`);
      }
      if (data.bounds) {
        lines.push(`- **Position:** (${data.bounds.x}, ${data.bounds.y})`);
      }
      break;

    case 'set_value':
      lines.push('# Set Value Result');
      lines.push('');
      lines.push(`- **Set:** ${data.set ? 'Yes' : 'No'}`);
      lines.push(`- **New value:** "${data.newValue}"`);
      if (data.element) {
        lines.push(`- **Element:** ${elementSummary(data.element)}`);
      }
      break;

    case 'get_page_text':
      lines.push('# Page Text');
      lines.push('');
      if (data.url) lines.push(`**URL:** ${data.url}`);
      if (data.title) lines.push(`**Title:** ${data.title}`);
      lines.push('');
      if (data.text) {
        const text = data.text.length > 5000
          ? data.text.substring(0, 5000) + '\n[truncated at 5000 chars]'
          : data.text;
        lines.push(text);
      }
      break;

    case 'get_page_structure':
      lines.push('# Page Structure');
      lines.push('');
      if (data.url) lines.push(`**URL:** ${data.url}`);
      if (data.title) lines.push(`**Title:** ${data.title}`);
      if (data.viewport) {
        lines.push(`**Viewport:** ${data.viewport.width}x${data.viewport.height}`);
      }
      lines.push('');
      if (data.structure) {
        lines.push(formatStructure(data.structure, 0));
      }
      break;

    case 'get_element_info':
      lines.push('# Element Info');
      lines.push('');
      lines.push(formatDetailedElement(data));
      break;

    case 'scroll_to_element':
      lines.push('# Scroll Result');
      lines.push('');
      lines.push(`- **Scrolled:** ${data.scrolledTo ? 'Yes' : 'No'}`);
      if (data.element) {
        lines.push(`- **Element:** ${elementSummary(data.element)}`);
      }
      if (data.bounds) {
        lines.push(`- **New position:** (${data.bounds.x}, ${data.bounds.y})`);
      }
      break;

    case 'highlight_element':
      lines.push('# Highlight Result');
      lines.push('');
      lines.push(`- **Highlighted:** ${data.highlighted ? 'Yes' : 'No'}`);
      if (data.element) {
        lines.push(`- **Element:** ${elementSummary(data.element)}`);
      }
      break;

    case 'wait_for_element':
      lines.push('# Wait Result');
      lines.push('');
      lines.push(`- **Found:** ${data.found ? 'Yes' : 'No'}`);
      lines.push(`- **Waited:** ${data.waitedMs}ms`);
      if (data.element) {
        lines.push(`- **Element:** ${elementSummary(data.element)}`);
      }
      if (data.bounds) {
        lines.push(`- **Position:** (${data.bounds.x}, ${data.bounds.y})`);
      }
      break;

    default:
      lines.push(`# Result: ${action}`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(data, null, 2));
      lines.push('```');
  }

  return lines.join('\n');
}

function formatRankedElement(el: any): string {
  const parts: string[] = [];
  const confidence = el.confidence || 'unknown';
  const rank = el.rank || '?';
  const tag = el.tag || '?';
  const text = el.text ? `"${el.text}"` : '';
  const id = el.id ? `#${el.id}` : '';
  const role = el.role ? `[role=${el.role}]` : '';
  const ariaLabel = el.ariaLabel ? `[aria-label="${el.ariaLabel}"]` : '';

  const confEmoji = confidence === 'high' ? 'HIGH' : confidence === 'medium' ? 'MED' : 'LOW';
  let label = `\`<${tag}${id}${role}>\``;
  if (text) label += ` ${text}`;
  if (ariaLabel) label += ` ${ariaLabel}`;

  parts.push(`### #${rank} [${confEmoji}] ${label}`);

  if (el.bounds) {
    parts.push(`- **Position:** left=${el.bounds.left}, top=${el.bounds.top}, width=${el.bounds.width}, height=${el.bounds.height}`);
    if (el.bounds.screenX !== undefined && el.bounds.screenY !== undefined) {
      parts.push(`- **Screen coords:** (${el.bounds.screenX}, ${el.bounds.screenY})`);
    }
    if (!el.bounds.visible) parts.push(`- **Visible:** No (off-screen)`);
  }

  if (el.selector) {
    parts.push(`- **Selector:** \`${el.selector}\``);
  }

  if (el.href) parts.push(`- **href:** ${el.href}`);

  // Context — this is what helps the agent decide
  if (el.context) {
    const ctx = el.context;
    const contextParts: string[] = [];
    if (ctx.nearestHeading) {
      contextParts.push(`under "${ctx.nearestHeading.text}" (${ctx.nearestHeading.level})`);
    }
    if (ctx.landmark) {
      contextParts.push(`in ${ctx.landmark.label}`);
    }
    if (ctx.label) {
      contextParts.push(`labeled "${ctx.label}"`);
    }
    if (contextParts.length > 0) {
      parts.push(`- **Context:** ${contextParts.join(', ')}`);
    }
    if (ctx.siblings?.length) {
      const sibTexts = ctx.siblings.map((s: any) => `${s.position === 'before' ? '<' : '>'} "${s.text}"`);
      parts.push(`- **Nearby:** ${sibTexts.join(' | ')}`);
    }
    if (ctx.ancestors?.length) {
      parts.push(`- **Inside:** ${ctx.ancestors.slice(0, 2).join(' → ')}`);
    }
  }

  parts.push('');
  return parts.join('\n');
}

function formatElement(el: any): string {
  const parts: string[] = [];
  const tag = el.tag || '?';
  const text = el.text ? `"${el.text}"` : '';
  const id = el.id ? `#${el.id}` : '';
  const role = el.role ? `[role=${el.role}]` : '';
  const ariaLabel = el.ariaLabel ? `[aria-label="${el.ariaLabel}"]` : '';

  let label = `\`<${tag}${id}${role}>\``;
  if (text) label += ` ${text}`;
  if (ariaLabel) label += ` ${ariaLabel}`;

  parts.push(`- ${label}`);

  if (el.bounds) {
    parts.push(`  - **Position:** left=${el.bounds.left}, top=${el.bounds.top}, width=${el.bounds.width}, height=${el.bounds.height}`);
    if (el.bounds.screenX !== undefined && el.bounds.screenY !== undefined) {
      parts.push(`  - **Screen coords:** (${el.bounds.screenX}, ${el.bounds.screenY})`);
    }
    if (!el.bounds.visible) parts.push(`  - **Visible:** No (off-screen)`);
  }

  if (el.selector) {
    parts.push(`  - **Selector:** \`${el.selector}\``);
  }

  if (el.href) parts.push(`  - **href:** ${el.href}`);
  if (el.matchedText) parts.push(`  - **Matched text:** "${el.matchedText}"`);

  // Context clues for disambiguation
  if (el.context) {
    const ctx = el.context;
    const contextParts: string[] = [];
    if (ctx.nearestHeading) contextParts.push(`under "${ctx.nearestHeading.text}"`);
    if (ctx.landmark) contextParts.push(`in ${ctx.landmark.label}`);
    if (ctx.label) contextParts.push(`labeled "${ctx.label}"`);
    if (contextParts.length > 0) {
      parts.push(`  - **Context:** ${contextParts.join(', ')}`);
    }
  }

  return parts.join('\n');
}

function formatFormField(field: any): string {
  const parts: string[] = [];
  const tag = field.tag || '?';
  const type = field.type ? ` type="${field.type}"` : '';
  const name = field.name ? ` name="${field.name}"` : '';
  const placeholder = field.placeholder ? ` placeholder="${field.placeholder}"` : '';

  parts.push(`- \`<${tag}${type}${name}>\`${placeholder}`);

  if (field.bounds) {
    parts.push(`  - **Position:** left=${field.bounds.left}, top=${field.bounds.top}, width=${field.bounds.width}, height=${field.bounds.height}`);
    if (field.bounds.screenX !== undefined && field.bounds.screenY !== undefined) {
      parts.push(`  - **Screen coords:** (${field.bounds.screenX}, ${field.bounds.screenY})`);
    }
  }
  if (field.selector) {
    parts.push(`  - **Selector:** \`${field.selector}\``);
  }
  if (field.currentValue) {
    parts.push(`  - **Current value:** "${field.currentValue}"`);
  }
  if (field.required) parts.push(`  - **Required:** Yes`);
  if (field.disabled) parts.push(`  - **Disabled:** Yes`);
  if (field.options) {
    parts.push(`  - **Options:** ${field.options.map((o: any) => o.text).join(', ')}`);
  }

  return parts.join('\n');
}

function formatStructure(node: any, depth: number): string {
  if (!node) return '';
  const indent = '  '.repeat(depth);
  const parts: string[] = [];

  const tag = node.tag || '?';
  const id = node.id ? `#${node.id}` : '';
  const role = node.role ? `[${node.role}]` : '';
  const text = node.text ? ` — "${node.text.substring(0, 50)}"` : '';

  parts.push(`${indent}- \`<${tag}${id}${role}>\`${text}`);

  if (node.children) {
    for (const child of node.children) {
      parts.push(formatStructure(child, depth + 1));
    }
  }

  return parts.join('\n');
}

function formatDetailedElement(data: any): string {
  const parts: string[] = [];
  parts.push(`- **Tag:** ${data.tag}`);
  if (data.id) parts.push(`- **ID:** ${data.id}`);
  if (data.classes) parts.push(`- **Classes:** ${data.classes}`);
  if (data.text) parts.push(`- **Text:** "${data.text}"`);
  if (data.role) parts.push(`- **Role:** ${data.role}`);
  if (data.ariaLabel) parts.push(`- **Aria-label:** ${data.ariaLabel}`);
  if (data.selector) parts.push(`- **Selector:** \`${data.selector}\``);
  if (data.bounds) {
    parts.push(`- **Position:** (${data.bounds.x}, ${data.bounds.y})`);
    parts.push(`- **Size:** ${data.bounds.width}x${data.bounds.height}`);
    parts.push(`- **Visible:** ${data.bounds.visible ? 'Yes' : 'No'}`);
  }
  if (data.computedStyle) {
    parts.push(`- **Display:** ${data.computedStyle.display}`);
    parts.push(`- **Cursor:** ${data.computedStyle.cursor}`);
  }
  if (data.childCount !== undefined) {
    parts.push(`- **Children:** ${data.childCount}`);
  }
  return parts.join('\n');
}

function elementSummary(el: any): string {
  const tag = el.tag || '?';
  const id = el.id ? `#${el.id}` : '';
  const text = el.text ? ` "${el.text}"` : '';
  return `<${tag}${id}>${text}`;
}

function formatError(message: string): string {
  return `# Browser Query Error\n\n${message}`;
}
