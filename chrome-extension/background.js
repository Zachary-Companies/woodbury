/**
 * Woodbury Bridge — Background Service Worker
 *
 * Maintains a WebSocket connection to the Woodbury CLI's local server.
 * Routes requests from Woodbury → content script (active tab) → back to Woodbury.
 */

const WS_URL = 'ws://localhost:7865';
const RECONNECT_MIN = 3000;   // initial retry delay (3s)
const RECONNECT_MAX = 30000;  // max retry delay (30s)
const RECONNECT_FACTOR = 1.5; // backoff multiplier

let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN;
let hasLoggedWaiting = false;  // only log "waiting" once to reduce console spam
let recordingModeActive = false;  // track recording state across navigations
let recordingEventBuffer = [];    // buffer events when WS is temporarily disconnected
const MAX_EVENT_BUFFER = 50;      // max buffered events to prevent memory leaks
let debugModeData = null;         // debug session state for side panel + marker persistence
// Shape: { steps, workflowId, workflowName, apiBaseUrl, currentIndex, completedIndices, failedIndices, tabId }

// Restore debug state from persistent storage (survives MV3 service worker restarts)
chrome.storage.local.get('debugModeData', (result) => {
  if (result.debugModeData && !debugModeData) {
    debugModeData = result.debugModeData;
    console.log('[Woodbury DBG] Restored debug state from storage:', debugModeData.workflowName, debugModeData.steps?.length, 'steps');
  }
});

// ── WebSocket connection management ──────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connected or connecting
  }

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      connected = true;
      reconnectDelay = RECONNECT_MIN; // reset backoff on successful connect
      hasLoggedWaiting = false;
      console.log('[Woodbury Bridge] Connected to Woodbury server');
      clearReconnectTimer();
      updateBadge('ON', '#4CAF50');

      // Announce ourselves
      ws.send(JSON.stringify({
        type: 'hello',
        source: 'chrome-extension',
        version: '1.0.0'
      }));

      // Flush any buffered recording events
      if (recordingEventBuffer.length > 0) {
        console.log(`[Woodbury Bridge] Flushing ${recordingEventBuffer.length} buffered recording events`);
        for (const msg of recordingEventBuffer) {
          try { ws.send(msg); } catch {}
        }
        recordingEventBuffer = [];
      }
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleMessage(message);
      } catch (err) {
        console.error('[Woodbury Bridge] Failed to parse message:', err);
        sendResponse({ id: null, error: 'Failed to parse request' });
      }
    };

    ws.onclose = () => {
      const wasConnected = connected;
      connected = false;
      ws = null;
      if (wasConnected) {
        console.log('[Woodbury Bridge] Disconnected from Woodbury server');
      }
      updateBadge('OFF', '#999');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Suppress noisy errors — onclose fires right after and handles reconnect.
      // Only log once so the console isn't flooded while waiting for Woodbury.
      if (!hasLoggedWaiting) {
        hasLoggedWaiting = true;
        console.log('[Woodbury Bridge] Woodbury server not running — will keep trying in the background');
      }
    };
  } catch (err) {
    console.error('[Woodbury Bridge] Failed to create WebSocket:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    connect();
  }, reconnectDelay);
  // Exponential backoff: increase delay for next attempt (capped at max)
  reconnectDelay = Math.min(reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendResponse(response) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ── Message routing ──────────────────────────────────────────

async function handleMessage(message) {
  const { id, action, params } = message;

  if (!id || !action) {
    sendResponse({ id, error: 'Missing id or action' });
    return;
  }

  // Handle recording mode toggle — forwarded to content script
  if (action === 'set_recording_mode') {
    recordingModeActive = !!params?.enabled;
    console.log('[Woodbury REC] set_recording_mode', { enabled: recordingModeActive, id });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('[Woodbury REC] Active tab:', tab?.id, tab?.url?.slice(0, 60));
      if (!tab || !tab.id) {
        console.log('[Woodbury REC] ERROR: No active tab found');
        sendResponse({ id, success: false, error: 'No active tab found' });
        return;
      }
      // Ensure content script is injected before sending recording mode
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        console.log('[Woodbury REC] Content script injected/confirmed');
      } catch (injectErr) {
        console.log('[Woodbury REC] Content script injection note:', injectErr.message);
      }
      const response = await chrome.tabs.sendMessage(tab.id, { action, params });
      console.log('[Woodbury REC] Content script response:', JSON.stringify(response));
      sendResponse({ id, success: true, data: response });

      // After recording mode is enabled, capture a snapshot of all interactive elements
      if (recordingModeActive && tab.id) {
        capturePageSnapshot(tab.id).catch(err => {
          console.log('[Woodbury REC] Page snapshot failed:', err.message);
        });
      }
    } catch (err) {
      console.log('[Woodbury REC] ERROR forwarding to content script:', err.message);
      sendResponse({ id, success: false, error: err.message });
    }
    return;
  }

  // ── Debug mode actions — intercepted by background for side panel orchestration ──

  if (action === 'show_debug_overlay') {
    try {
      // Store debug state FIRST (before tab query) so side panel can access it immediately
      // Even if tab detection fails, the side panel will still show steps
      debugModeData = {
        steps: params.steps || [],
        workflowId: params.workflowId || '',
        workflowName: params.workflowName || '',
        apiBaseUrl: params.apiBaseUrl || '',
        currentIndex: 0,
        completedIndices: [],
        failedIndices: [],
        stepResults: [],   // per-step { stepIndex, coordinateInfo, status, error }
        tabId: null,        // filled in below if tab found
      };
      // Persist to storage (survives service worker restarts)
      chrome.storage.local.set({ debugModeData });
      console.log('[Woodbury DBG] Debug mode started:', debugModeData.workflowName, debugModeData.steps.length, 'steps');

      // Find active tab — try multiple strategies for reliability in MV3 service workers
      let tab = null;
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tab = tabs[0] || null;
      } catch (e) {
        console.log('[Woodbury DBG] lastFocusedWindow query failed:', e.message);
      }
      if (!tab) {
        try {
          const tabs = await chrome.tabs.query({ active: true });
          tab = tabs[0] || null;
        } catch (e) {
          console.log('[Woodbury DBG] all-windows query failed:', e.message);
        }
      }

      if (tab && tab.id) {
        debugModeData.tabId = tab.id;
        console.log('[Woodbury DBG] Active tab found:', tab.id, tab.url?.slice(0, 60));

        // Forward markers to content.js
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch {}
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'show_debug_overlay', params });
        } catch (e) {
          console.log('[Woodbury DBG] Failed to send markers to content.js:', e.message);
        }
      } else {
        console.log('[Woodbury DBG] No active tab found — side panel will work but no page markers');
      }

      // Notify the side panel (if already open) that a debug session started
      try {
        chrome.runtime.sendMessage({
          type: 'debug_started',
          data: debugModeData,
        }).catch(() => {}); // side panel may not be open yet — that's fine
      } catch {}

      // Switch extension icon from popup → side panel opener
      // (chrome.sidePanel.open() requires a user gesture, so we redirect the icon click)
      try {
        await chrome.action.setPopup({ popup: '' }); // disable popup so onClicked fires
        updateBadge('DBG', '#3b82f6');
        console.log('[Woodbury DBG] Extension icon now opens debug side panel — click the Woodbury icon');
      } catch (e) {
        console.log('[Woodbury DBG] Failed to configure action:', e.message);
      }

      sendResponse({ id, success: true, data: { overlayShown: true } });
    } catch (err) {
      console.log('[Woodbury DBG] show_debug_overlay error:', err.message);
      sendResponse({ id, success: false, error: err.message });
    }
    return;
  }

  if (action === 'update_debug_step') {
    // Update local state
    if (debugModeData) {
      debugModeData.currentIndex = params.currentIndex ?? debugModeData.currentIndex;
      debugModeData.completedIndices = params.completedIndices || debugModeData.completedIndices;
      debugModeData.failedIndices = params.failedIndices || debugModeData.failedIndices;
      // Store per-step result for side panel state persistence
      if (params.stepIndex != null) {
        debugModeData.stepResults[params.stepIndex] = {
          stepIndex: params.stepIndex,
          coordinateInfo: params.coordinateInfo || null,
          status: params.stepResult?.status || null,
          error: params.stepResult?.error || null,
        };
      }
    }

    // Persist updated state to storage
    if (debugModeData) {
      chrome.storage.local.set({ debugModeData });
    }

    // Forward marker updates to content.js
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab && tab.id) {
        await chrome.tabs.sendMessage(tab.id, { action: 'update_debug_step', params });
      }
    } catch (e) {
      console.log('[Woodbury DBG] Failed to update content.js markers:', e.message);
    }

    // Forward to side panel
    chrome.runtime.sendMessage({
      type: 'debug_step_result',
      data: {
        currentIndex: params.currentIndex,
        completedIndices: params.completedIndices,
        failedIndices: params.failedIndices,
        coordinateInfo: params.coordinateInfo,
        stepIndex: params.stepIndex,
        stepResult: params.stepResult,
      }
    }).catch(() => {});

    sendResponse({ id, success: true });
    return;
  }

  if (action === 'hide_debug_overlay') {
    console.log('[Woodbury DBG] Debug mode ended');
    debugModeData = null;
    chrome.storage.local.remove('debugModeData');

    // Restore extension icon to popup mode
    try {
      await chrome.action.setPopup({ popup: 'popup.html' });
      updateBadge('', '#4CAF50');
    } catch {}

    // Remove markers from content.js
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        await chrome.tabs.sendMessage(tab.id, { action: 'hide_debug_overlay' });
      }
    } catch {}

    // Notify side panel
    chrome.runtime.sendMessage({ type: 'debug_ended' }).catch(() => {});

    sendResponse({ id, success: true });
    return;
  }

  // Bridge → move a single debug marker to new position
  if (action === 'update_debug_marker') {
    try {
      const tabId = debugModeData?.tabId;
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { action: 'update_debug_marker', params });
      }
      // Also update local step data
      if (debugModeData && params.stepIndex != null) {
        var step = debugModeData.steps[params.stepIndex];
        if (step) {
          step.pctX = params.pctX;
          step.pctY = params.pctY;
        }
      }
    } catch (e) {
      console.log('[Woodbury DBG] Failed to update marker:', e.message);
    }
    sendResponse({ id, success: true });
    return;
  }

  // ── Download actions — no active tab needed ──

  if (action === 'get_downloads') {
    try {
      const limit = params.limit || 10;
      const searchOpts = { orderBy: ['-startTime'], limit: limit * 2 };
      if (params.state) searchOpts.state = params.state;

      const results = await chrome.downloads.search(searchOpts);
      let filtered = results;

      if (params.filenamePattern) {
        try {
          const regex = new RegExp(params.filenamePattern);
          filtered = filtered.filter(item => regex.test(item.filename));
        } catch (regexErr) {
          sendResponse({ id, success: false, error: 'Invalid filenamePattern regex: ' + regexErr.message });
          return;
        }
      }
      if (params.sinceMs) {
        const cutoff = Date.now() - params.sinceMs;
        filtered = filtered.filter(item => new Date(item.startTime).getTime() > cutoff);
      }

      filtered = filtered.slice(0, limit);

      const mapped = filtered.map(item => ({
        id: item.id,
        filename: item.filename,
        state: item.state,
        fileSize: item.fileSize,
        startTime: item.startTime,
        endTime: item.endTime,
      }));

      sendResponse({ id, success: true, data: { downloads: mapped } });
    } catch (err) {
      sendResponse({ id, success: false, error: err.message });
    }
    return;
  }

  if (action === 'wait_downloads_complete') {
    try {
      const timeoutMs = params.timeoutMs || 60000;
      const pollMs = params.pollIntervalMs || 1000;
      const startTime = Date.now();
      let downloadIds = params.downloadIds || [];

      // If no IDs given, find in-progress downloads
      if (downloadIds.length === 0) {
        const inProgress = await chrome.downloads.search({ state: 'in_progress' });
        downloadIds = inProgress.map(d => d.id);
      }

      if (downloadIds.length === 0) {
        sendResponse({ id, success: true, data: { downloads: [], allComplete: true } });
        return;
      }

      // Poll loop
      while (Date.now() - startTime < timeoutMs) {
        let allDone = true;
        const statuses = [];
        for (const dlId of downloadIds) {
          const [item] = await chrome.downloads.search({ id: dlId });
          statuses.push({
            id: dlId,
            filename: item?.filename,
            state: item?.state,
            fileSize: item?.fileSize,
          });
          if (item && item.state === 'in_progress') allDone = false;
        }

        if (allDone) {
          sendResponse({ id, success: true, data: { downloads: statuses, allComplete: true } });
          return;
        }
        await new Promise(r => setTimeout(r, pollMs));
      }

      sendResponse({ id, success: false, error: 'Downloads did not complete within timeout (' + timeoutMs + 'ms)' });
    } catch (err) {
      sendResponse({ id, success: false, error: err.message });
    }
    return;
  }

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      sendResponse({ id, error: 'No active tab found' });
      return;
    }

    // ── Actions handled by background script (not content script) ──

    // Navigate to a URL
    if (action === 'open') {
      const url = params.url;
      if (!url) {
        sendResponse({ id, success: false, error: 'Missing url parameter' });
        return;
      }
      await chrome.tabs.update(tab.id, { url });
      // Wait for the page to finish loading
      await waitForTabLoad(tab.id, params.timeout || 15000);
      // Re-inject content script on new page
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch {}
      // Restore recording mode if it was active before navigation
      if (recordingModeActive) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'set_recording_mode',
            params: { enabled: true },
          });
        } catch {}
      }
      // Restore debug markers if debug mode is active
      if (debugModeData && debugModeData.tabId === tab.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'show_debug_overlay',
            params: { steps: debugModeData.steps, workflowName: debugModeData.workflowName },
          });
          if (debugModeData.completedIndices.length > 0 || debugModeData.failedIndices.length > 0) {
            await chrome.tabs.sendMessage(tab.id, {
              action: 'update_debug_step',
              params: {
                currentIndex: debugModeData.currentIndex,
                completedIndices: debugModeData.completedIndices,
                failedIndices: debugModeData.failedIndices,
              },
            });
          }
          console.log('[Woodbury DBG] Debug markers restored after open navigation');
        } catch {}
      }
      sendResponse({ id, success: true, data: { navigated: true, url } });
      return;
    }

    // Mouse actions via Chrome Debugger API
    if (action === 'mouse') {
      await handleMouseAction(tab.id, id, params);
      return;
    }

    // Keyboard actions via Chrome Debugger API
    if (action === 'keyboard') {
      await handleKeyboardAction(tab.id, id, params);
      return;
    }

    // ── Forward remaining actions to content script ──

    // Inject content script if needed (in case it hasn't loaded yet)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch {
      // Content script may already be injected — that's fine
    }

    // Send the request to the content script and wait for a response
    const response = await chrome.tabs.sendMessage(tab.id, { id, action, params });
    sendResponse({ id, ...response });

  } catch (err) {
    sendResponse({ id, error: err.message || 'Failed to communicate with tab' });
  }
}

// ── Navigation helpers ───────────────────────────────────────

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve anyway — page might be usable even if load is slow
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay for JS frameworks to hydrate
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Debugger-based input (mouse & keyboard) ──────────────────

let attachedTabs = new Set();

async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (err) {
    // May already be attached
    if (!err.message?.includes('Already attached')) {
      throw err;
    }
    attachedTabs.add(tabId);
  }
}

function debuggerSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// Detach debugger when tab navigates or closes
chrome.debugger.onDetach?.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  attachedTabs.delete(tabId);
  // Clean up debug mode if the debugged tab is closed
  if (debugModeData && debugModeData.tabId === tabId) {
    console.log('[Woodbury DBG] Debugged tab closed, clearing debug state');
    debugModeData = null;
    chrome.storage.local.remove('debugModeData');
    chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {});
    updateBadge('', '#4CAF50');
    chrome.runtime.sendMessage({ type: 'debug_ended' }).catch(() => {});
  }
});

async function handleMouseAction(tabId, requestId, params) {
  try {
    await ensureDebuggerAttached(tabId);
    const x = params.x || 0;
    const y = params.y || 0;

    switch (params.action) {
      case 'move':
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y
        });
        break;

      case 'click':
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1
        });
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1
        });
        break;

      case 'double_click':
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1
        });
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1
        });
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 2
        });
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 2
        });
        break;

      case 'right_click':
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'right', clickCount: 1
        });
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'right', clickCount: 1
        });
        break;

      case 'scroll': {
        const scrollX = params.scrollX || 0;
        const scrollY = params.scrollY || 0;
        // Chrome's Input.dispatchMouseEvent scroll uses deltaX/deltaY
        await debuggerSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, deltaX: scrollX, deltaY: scrollY
        });
        break;
      }

      default:
        sendResponse({ id: requestId, success: false, error: `Unknown mouse action: ${params.action}` });
        return;
    }

    sendResponse({ id: requestId, success: true, data: { action: 'mouse', performed: params.action } });
  } catch (err) {
    sendResponse({ id: requestId, success: false, error: err.message });
  }
}

async function handleKeyboardAction(tabId, requestId, params) {
  try {
    await ensureDebuggerAttached(tabId);

    switch (params.action) {
      case 'type': {
        // Type each character individually
        const text = params.text || '';
        for (const char of text) {
          await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}`
          });
          await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp', text: char, key: char, code: `Key${char.toUpperCase()}`
          });
        }
        break;
      }

      case 'press': {
        const key = params.key || '';
        const keyMap = getKeyMapping(key);
        const modifiers = getModifierFlags(params);

        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: keyMap.key,
          code: keyMap.code,
          windowsVirtualKeyCode: keyMap.keyCode,
          nativeVirtualKeyCode: keyMap.keyCode,
          modifiers,
        });
        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: keyMap.key,
          code: keyMap.code,
          windowsVirtualKeyCode: keyMap.keyCode,
          nativeVirtualKeyCode: keyMap.keyCode,
          modifiers,
        });
        break;
      }

      case 'clear': {
        // Select all (Ctrl+A / Cmd+A) then Delete
        const selectMod = 2; // Ctrl
        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, modifiers: selectMod
        });
        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, modifiers: selectMod
        });
        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8
        });
        await debuggerSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8
        });
        break;
      }

      default:
        sendResponse({ id: requestId, success: false, error: `Unknown keyboard action: ${params.action}` });
        return;
    }

    sendResponse({ id: requestId, success: true, data: { action: 'keyboard', performed: params.action } });
  } catch (err) {
    sendResponse({ id: requestId, success: false, error: err.message });
  }
}

function getKeyMapping(key) {
  const mappings = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Home': { key: 'Home', code: 'Home', keyCode: 36 },
    'End': { key: 'End', code: 'End', keyCode: 35 },
    'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  };

  // Check exact match
  if (mappings[key]) return mappings[key];

  // Case-insensitive match
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(mappings)) {
    if (k.toLowerCase() === lower) return v;
  }

  // Single character
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      key: key,
      code: upper >= 'A' && upper <= 'Z' ? `Key${upper}` : `Digit${key}`,
      keyCode: upper.charCodeAt(0),
    };
  }

  // Fallback
  return { key, code: key, keyCode: 0 };
}

function getModifierFlags(params) {
  let flags = 0;
  if (params.alt) flags |= 1;
  if (params.ctrl || params.control) flags |= 2;
  if (params.meta || params.cmd) flags |= 4;
  if (params.shift) flags |= 8;
  // Also check modifiers array
  if (Array.isArray(params.modifiers)) {
    for (const mod of params.modifiers) {
      const m = mod.toLowerCase();
      if (m === 'alt' || m === 'option') flags |= 1;
      if (m === 'ctrl' || m === 'control') flags |= 2;
      if (m === 'meta' || m === 'cmd' || m === 'command') flags |= 4;
      if (m === 'shift') flags |= 8;
    }
  }
  return flags;
}

// ── Lifecycle ────────────────────────────────────────────────

// Start connection on service worker startup
connect();

// When extension icon is clicked and debug mode is active (popup is disabled),
// open the debug side panel. This provides the required user gesture context
// that chrome.sidePanel.open() needs.
chrome.action.onClicked.addListener(async (tab) => {
  if (debugModeData) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log('[Woodbury DBG] Side panel opened via extension icon click');
      // Send current state to the side panel after it loads
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'debug_started', data: debugModeData }).catch(() => {});
      }, 500);
    } catch (e) {
      console.log('[Woodbury DBG] Failed to open side panel:', e.message);
    }
  }
});

// Listen for popup or other extension pages requesting status,
// AND for recording events from the content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponseCallback) => {
  if (message.type === 'getStatus') {
    sendResponseCallback({ connected, wsUrl: WS_URL });
    return true;
  }
  if (message.type === 'reconnect') {
    reconnectDelay = RECONNECT_MIN; // reset backoff on manual reconnect
    hasLoggedWaiting = false;
    connect();
    sendResponseCallback({ ok: true });
    return true;
  }

  // Debug side panel requests state
  if (message.type === 'debug_get_state') {
    if (debugModeData) {
      sendResponseCallback({ active: true, ...debugModeData });
    } else {
      sendResponseCallback({ active: false });
    }
    return true;
  }

  // Side panel requests marker selection highlight
  if (message.type === 'select_debug_marker') {
    if (debugModeData && debugModeData.tabId) {
      chrome.tabs.sendMessage(debugModeData.tabId, {
        action: 'select_debug_marker',
        params: { stepIndex: message.stepIndex }
      }).catch(() => {});
    }
    sendResponseCallback({ ok: true });
    return true;
  }

  // Side panel requests marker position update
  if (message.type === 'update_debug_marker') {
    if (debugModeData) {
      const tabId = debugModeData.tabId;
      // Update local step data
      if (message.stepIndex != null && debugModeData.steps[message.stepIndex]) {
        debugModeData.steps[message.stepIndex].pctX = message.pctX;
        debugModeData.steps[message.stepIndex].pctY = message.pctY;
      }
      // Forward to content.js to move the marker
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: 'update_debug_marker',
          params: { stepIndex: message.stepIndex, pctX: message.pctX, pctY: message.pctY }
        }).catch(() => {});
      }
    }
    sendResponseCallback({ ok: true });
    return true;
  }

  // Forward recording events from content script to Woodbury bridge server
  if (message.type === 'recording_event') {
    console.log('[Woodbury REC] recording_event from content:', message.event, message.element?.tag, (message.element?.textContent || '').slice(0, 30));
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));

      // After click events, schedule a page snapshot (debounced) to capture
      // the new page state with all its interactive elements for ML training.
      if (message.event === 'click') {
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) scheduleSnapshot(tab.id);
          } catch {}
        })();
      }
    } else if (recordingModeActive) {
      // Buffer events when WS is temporarily disconnected during recording
      recordingEventBuffer.push(JSON.stringify(message));
      if (recordingEventBuffer.length > MAX_EVENT_BUFFER) {
        recordingEventBuffer.shift(); // Drop oldest if buffer is full
      }
      console.log(`[Woodbury REC] Buffered recording event (${recordingEventBuffer.length} queued, ws state: ${ws?.readyState})`);
    } else {
      console.log('[Woodbury REC] DROPPED recording event (ws closed, recording not active)');
    }
    // Don't need to wait for response
    return false;
  }
});

// ── Page Snapshot for ML Training ────────────────────────────────────────
// Captures a viewport screenshot + all interactive element metadata, then sends
// to the bridge as a `page_elements_snapshot` message. Called on recording start,
// after clicks (debounced), and after page navigations.
let snapshotTimer = null;
const SNAPSHOT_DEBOUNCE_MS = 1500; // Wait 1.5s after last click before capturing

async function capturePageSnapshot(tabId) {
  if (!recordingModeActive) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    // 1. Capture viewport screenshot
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 2. Ask content script for all interactive elements
    let snapshot;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        action: 'snapshot_interactive_elements',
        params: {},
      });
      snapshot = resp?.data || resp;
    } catch (err) {
      console.log('[Woodbury REC] snapshot: content script query failed:', err.message);
      return;
    }

    if (!snapshot?.elements?.length) return;

    // 3. Send to bridge
    const payload = {
      type: 'page_elements_snapshot',
      viewportImage: dataUrl,
      snapshot: snapshot,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(payload));
    console.log('[Woodbury REC] Page snapshot sent:', snapshot.elements.length, 'elements');
  } catch (err) {
    console.log('[Woodbury REC] Page snapshot error:', err.message);
  }
}

function scheduleSnapshot(tabId) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    capturePageSnapshot(tabId).catch(err => {
      console.log('[Woodbury REC] Scheduled snapshot failed:', err.message);
    });
  }, SNAPSHOT_DEBOUNCE_MS);
}

// Re-apply recording mode when a page finishes loading (user-initiated navigation,
// SPA route changes, or page reloads). This ensures the recording indicator and
// event listeners survive across navigations.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!recordingModeActive) return;
  if (changeInfo.status !== 'complete') return;

  // Only re-apply to the active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id !== tabId) return;

    console.log('[Woodbury REC] Tab updated (complete), re-applying recording mode', { tabId, url: tab?.url?.slice(0, 60) });

    // Re-inject content script and restore recording mode
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (injectErr) {
      console.log('[Woodbury REC] Re-inject note:', injectErr.message);
    }
    // Small delay to let content script initialize
    await new Promise(r => setTimeout(r, 300));
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        action: 'set_recording_mode',
        params: { enabled: true },
      });
      console.log('[Woodbury REC] Recording mode re-applied after navigation:', JSON.stringify(resp));
      // Capture snapshot of the new page after a brief delay for rendering
      setTimeout(() => capturePageSnapshot(tabId).catch(() => {}), 1000);
    } catch (err) {
      console.log('[Woodbury REC] FAILED to restore recording mode after navigation:', err.message);
    }
  } catch (outerErr) {
    console.log('[Woodbury REC] tabs.onUpdated handler error:', outerErr.message);
  }
});

// Re-apply debug markers when a page finishes loading (navigation during debug)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!debugModeData || debugModeData.tabId !== tabId) return;
  if (changeInfo.status !== 'complete') return;

  console.log('[Woodbury DBG] Tab updated (complete), re-injecting debug markers', { tabId, url: tab?.url?.slice(0, 60) });

  try {
    // Re-inject content script
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (injectErr) {
      console.log('[Woodbury DBG] Re-inject note:', injectErr.message);
    }
    // Small delay to let content script initialize
    await new Promise(r => setTimeout(r, 300));
    // Re-send marker overlay
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'show_debug_overlay',
        params: {
          steps: debugModeData.steps,
          workflowName: debugModeData.workflowName,
        },
      });
      // Re-apply current step highlighting if any steps have been executed
      if (debugModeData.completedIndices.length > 0 || debugModeData.failedIndices.length > 0) {
        await chrome.tabs.sendMessage(tabId, {
          action: 'update_debug_step',
          params: {
            currentIndex: debugModeData.currentIndex,
            completedIndices: debugModeData.completedIndices,
            failedIndices: debugModeData.failedIndices,
          },
        });
      }
      console.log('[Woodbury DBG] Debug markers re-applied after navigation');
    } catch (err) {
      console.log('[Woodbury DBG] FAILED to restore markers:', err.message);
    }
  } catch (outerErr) {
    console.log('[Woodbury DBG] tabs.onUpdated handler error:', outerErr.message);
  }
});

// Keep service worker alive via periodic alarm
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // If disconnected, try to reconnect
    if (!connected) {
      connect();
    }
  }
});
