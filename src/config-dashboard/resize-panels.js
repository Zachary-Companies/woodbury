/**
 * Resizable Panel Utility
 *
 * Shared drag-to-resize logic for all dashboard split points.
 * Each split calls initResizeHandle() after its DOM is built.
 * Sizes persist in localStorage and restore on next load.
 * Double-click the handle to reset to default size.
 */

/**
 * Initialize a resizable split handle.
 *
 * @param {Object} opts
 * @param {string}            opts.storageKey   - localStorage key for persisting width
 * @param {HTMLElement}       opts.resizer      - The 6px resize handle element
 * @param {HTMLElement}       opts.targetPanel  - The panel whose width is being resized
 * @param {HTMLElement}       opts.container    - The flex parent container
 * @param {number}            opts.defaultWidth - Default width in px (for double-click reset)
 * @param {number}            opts.minWidth     - Minimum width in px
 * @param {number|Function}   opts.maxWidth     - Max px, or function(containerWidth) => px
 * @param {'left'|'right'}    [opts.direction]  - 'left' = drag-right grows left panel (default),
 *                                                'right' = drag-right shrinks right panel
 * @param {string}            [opts.flexProperty] - 'width' to set width+minWidth; default sets flex
 * @param {Function}          [opts.onResize]   - Callback after each resize
 * @param {Function}          [opts.isActive]   - Return false to disable (e.g. panel hidden)
 */
function initResizeHandle(opts) {
  var resizer = opts.resizer;
  var target = opts.targetPanel;
  var container = opts.container;
  var storageKey = opts.storageKey;
  var defaultWidth = opts.defaultWidth;
  var minW = opts.minWidth;
  var maxW = opts.maxWidth;
  var direction = opts.direction || 'left';
  var useWidth = opts.flexProperty === 'width';
  var onResize = opts.onResize || function() {};
  var isActive = opts.isActive || function() { return true; };

  if (!resizer || !target || !container) return;

  var innerBar = resizer.querySelector('.resize-bar-inner');

  // Restore persisted width
  var saved = localStorage.getItem(storageKey);
  if (saved) {
    var parsed = parseInt(saved, 10);
    if (!isNaN(parsed) && parsed >= minW) {
      applyWidth(parsed);
    }
  }

  function getMaxWidth() {
    var cw = container.getBoundingClientRect().width;
    return typeof maxW === 'function' ? maxW(cw) : maxW;
  }

  function applyWidth(w) {
    if (useWidth) {
      target.style.width = w + 'px';
      target.style.minWidth = w + 'px';
    } else {
      target.style.flex = '0 0 ' + w + 'px';
    }
  }

  function getCurrentWidth() {
    return target.getBoundingClientRect().width;
  }

  // Mousedown - start drag
  resizer.addEventListener('mousedown', function(e) {
    if (!isActive()) return;
    e.preventDefault();
    var startX = e.clientX;
    var startWidth = getCurrentWidth();
    if (innerBar) innerBar.style.background = '#7c3aed';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    function onMouseMove(ev) {
      var delta = ev.clientX - startX;
      var newWidth = direction === 'left'
        ? startWidth + delta
        : startWidth - delta;
      var effectiveMax = getMaxWidth();
      newWidth = Math.max(minW, Math.min(effectiveMax, newWidth));
      applyWidth(newWidth);
      onResize();
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (innerBar) innerBar.style.background = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      // Persist
      localStorage.setItem(storageKey, String(Math.round(getCurrentWidth())));
      onResize();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Double-click - reset to default
  resizer.addEventListener('dblclick', function() {
    if (!isActive()) return;
    applyWidth(defaultWidth);
    localStorage.removeItem(storageKey);
    onResize();
  });
}

/**
 * Create a resizer DOM element with consistent structure.
 * @param {string} id - Element ID
 * @returns {HTMLElement}
 */
function createResizerElement(id) {
  var el = document.createElement('div');
  el.id = id;
  el.className = 'resize-handle';
  el.innerHTML = '<div class="resize-bar-inner"></div>';
  return el;
}

/**
 * Restore a persisted panel width from localStorage.
 * Call early (before initResizeHandle) to prevent FOUC on static HTML.
 * @param {string} storageKey
 * @param {HTMLElement} targetEl
 * @param {number} minWidth
 * @param {string} [flexProperty] - 'width' or default (flex)
 */
function restoreResizeWidth(storageKey, targetEl, minWidth, flexProperty) {
  var saved = localStorage.getItem(storageKey);
  if (saved && targetEl) {
    var w = parseInt(saved, 10);
    if (!isNaN(w) && w >= minWidth) {
      if (flexProperty === 'width') {
        targetEl.style.width = w + 'px';
        targetEl.style.minWidth = w + 'px';
      } else {
        targetEl.style.flex = '0 0 ' + w + 'px';
      }
    }
  }
}
