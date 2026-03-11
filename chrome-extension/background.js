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
let recordingModeType = 'standard'; // 'standard' or 'accessibility' — persists across navigations
let recordingEventBuffer = [];    // buffer events when WS is temporarily disconnected
const MAX_EVENT_BUFFER = 50;      // max buffered events to prevent memory leaks
let debugModeData = null;         // debug session state for side panel + marker persistence
// Shape: { steps, workflowId, workflowName, apiBaseUrl, currentIndex, completedIndices, failedIndices, tabId }
let sidePanelOpen = false;        // track sidepanel open state via port connection
let pendingPick = null;           // stores element_picked data when sidepanel was closed during pick
let pendingStepResult = null;     // stores debug step result from close→execute→reopen flow

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
    if (params?.mode) {
      recordingModeType = params.mode; // 'standard' or 'accessibility'
    }
    console.log('[Woodbury REC] set_recording_mode', { enabled: recordingModeActive, mode: recordingModeType, id });
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
          stepDetail: params.stepDetail || null,
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
        stepDetail: params.stepDetail || null,
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

    // Capture viewport screenshot (works outside recording mode)
    // Optional: pass params.crop = {left, top, width, height} to crop a region
    if (action === 'capture_viewport') {
      try {
        // If hideOverlay requested, hide debug markers before capturing
        if (params.hideOverlay && tab?.id) {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'toggle_debug_overlay', params: { visible: false } });
            await new Promise(r => setTimeout(r, 50)); // brief wait for DOM update
          } catch {}
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

        // Re-show overlay after capture
        if (params.hideOverlay && tab?.id) {
          try {
            chrome.tabs.sendMessage(tab.id, { action: 'toggle_debug_overlay', params: { visible: true } });
          } catch {}
        }

        if (params.crop && params.crop.width > 0 && params.crop.height > 0) {
          // Crop using OffscreenCanvas (available in MV3 service workers)
          let { left, top, width, height } = params.crop;
          const response = await fetch(dataUrl);
          const blob = await response.blob();

          // Detect DPR: compare captured image size to expected viewport size
          // captureVisibleTab returns image at device pixel ratio
          const fullBitmap = await createImageBitmap(blob);
          const imgW = fullBitmap.width;
          const imgH = fullBitmap.height;
          fullBitmap.close();

          // If crop coords appear to be in CSS pixels (not DPR-scaled), scale them up
          // Heuristic: if the image is significantly larger than crop bounds suggest,
          // the caller is using CSS pixel coordinates
          if (params.crop.dprScaled) {
            // Already DPR-scaled by the caller (e.g., element picker) — use as-is
          } else {
            // Assume CSS pixel coordinates — scale by detected DPR
            const dpr = tab ? (await chrome.tabs.getZoom(tab.id)) || 1 : 1;
            // getZoom returns zoom level, not DPR. Use image/viewport ratio instead.
            // We estimate DPR from actual capture size vs expected viewport
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabWidth = activeTab?.width || imgW;
            const estimatedDpr = Math.round(imgW / tabWidth) || 1;
            if (estimatedDpr > 1) {
              left = Math.round(left * estimatedDpr);
              top = Math.round(top * estimatedDpr);
              width = Math.round(width * estimatedDpr);
              height = Math.round(height * estimatedDpr);
            }
          }

          // Clamp to image bounds
          left = Math.max(0, Math.min(left, imgW - 1));
          top = Math.max(0, Math.min(top, imgH - 1));
          width = Math.min(width, imgW - left);
          height = Math.min(height, imgH - top);
          if (width < 1) width = 1;
          if (height < 1) height = 1;

          const bitmap = await createImageBitmap(blob, left, top, width, height);
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
          const ab = await croppedBlob.arrayBuffer();
          const bytes = new Uint8Array(ab);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          }
          const croppedDataUrl = 'data:image/png;base64,' + btoa(binary);
          // If caller wants the full (uncropped) image too, include it
          if (params.returnFull) {
            sendResponse({ id, success: true, data: { image: croppedDataUrl, fullImage: dataUrl } });
          } else {
            sendResponse({ id, success: true, data: { image: croppedDataUrl } });
          }
        } else {
          sendResponse({ id, success: true, data: { image: dataUrl } });
        }
      } catch (err) {
        sendResponse({ id, success: false, error: err.message });
      }
      return;
    }

    // Request page snapshot for execution training data (works outside recording mode)
    // Combines capture_viewport + snapshot_interactive_elements, returns data directly
    if (action === 'request_page_snapshot') {
      try {
        // 1. Capture viewport screenshot
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

        // 2. Ask content script for all interactive elements
        let snapshot;
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, {
            action: 'snapshot_interactive_elements',
            params: {},
          });
          snapshot = resp?.data || resp;
        } catch (err) {
          sendResponse({ id, success: false, error: 'Content script query failed: ' + err.message });
          return;
        }

        if (!snapshot?.elements?.length) {
          sendResponse({ id, success: true, data: { viewportImage: dataUrl, snapshot: { elements: [], url: snapshot?.url, title: snapshot?.title, viewportWidth: snapshot?.viewportWidth, viewportHeight: snapshot?.viewportHeight } } });
          return;
        }

        sendResponse({
          id,
          success: true,
          data: {
            viewportImage: dataUrl,
            snapshot: snapshot,
          },
        });
      } catch (err) {
        sendResponse({ id, success: false, error: err.message });
      }
      return;
    }

    // Get/set zoom level
    if (action === 'get_zoom') {
      const zoom = await chrome.tabs.getZoom(tab.id);
      sendResponse({ id, success: true, data: { zoom } });
      return;
    }

    if (action === 'set_zoom') {
      const level = params.zoom ?? 1.0;
      await chrome.tabs.setZoom(tab.id, level);
      sendResponse({ id, success: true, data: { zoom: level } });
      return;
    }

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
            params: { enabled: true, mode: recordingModeType },
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

    // Mouse and keyboard input is now handled via native OS input (robotjs) in the executor.
    // These stubs exist for backward compatibility.
    if (action === 'mouse' || action === 'keyboard') {
      sendResponse({ id, success: true, data: { action, performed: params.action, native: true } });
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

// Clean up debug mode if the debugged tab is closed
chrome.tabs.onRemoved?.addListener((tabId) => {
  if (debugModeData && debugModeData.tabId === tabId) {
    console.log('[Woodbury DBG] Debugged tab closed, clearing debug state');
    debugModeData = null;
    chrome.storage.local.remove('debugModeData');
    chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {});
    updateBadge('', '#4CAF50');
    chrome.runtime.sendMessage({ type: 'debug_ended' }).catch(() => {});
  }
});

// ── Lifecycle ────────────────────────────────────────────────

// Start connection on service worker startup
connect();

// When extension icon is clicked (popup is disabled), toggle the side panel.
// Works for both debug mode and WCAG audit mode.
// This provides the required user gesture context that chrome.sidePanel.open() needs.
chrome.action.onClicked.addListener(async (tab) => {
  if (sidePanelOpen) {
    // Toggle: close the panel
    try {
      await chrome.sidePanel.setOptions({ enabled: false });
      await chrome.sidePanel.setOptions({ enabled: true });
      console.log('[Woodbury] Side panel closed via icon click');
    } catch (e) {
      console.log('[Woodbury] Failed to close side panel:', e.message);
    }
  } else {
    // Toggle: open the panel
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log('[Woodbury] Side panel opened via extension icon click');
      if (debugModeData) {
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'debug_started', data: debugModeData }).catch(() => {});
        }, 500);
      }
    } catch (e) {
      console.log('[Woodbury] Failed to open side panel:', e.message);
    }
  }
});

// Track sidepanel open/close state via port connection.
// The sidepanel connects a port when it loads; when it closes (X button or toggle),
// the port disconnects.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'woodbury-sidepanel') {
    sidePanelOpen = true;
    console.log('[Woodbury DBG] Side panel connected');
    port.onDisconnect.addListener(() => {
      sidePanelOpen = false;
      console.log('[Woodbury DBG] Side panel disconnected');
    });
  }
});

// Keyboard shortcut: Alt+S toggles the debug side panel
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-sidepanel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (sidePanelOpen) {
      // Close the panel by disabling and immediately re-enabling
      try {
        await chrome.sidePanel.setOptions({ enabled: false });
        await chrome.sidePanel.setOptions({ enabled: true });
        console.log('[Woodbury DBG] Side panel closed via shortcut');
      } catch (e) {
        console.log('[Woodbury DBG] Failed to close side panel:', e.message);
      }
    } else {
      // Open the panel (commands provide the required user gesture)
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        console.log('[Woodbury DBG] Side panel opened via shortcut');
        if (debugModeData) {
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'debug_started', data: debugModeData }).catch(() => {});
          }, 500);
        }
      } catch (e) {
        console.log('[Woodbury DBG] Failed to open side panel:', e.message);
      }
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

  // Side panel asks to close itself (for step execution)
  if (message.type === 'close_sidepanel') {
    (async () => {
      try {
        await chrome.sidePanel.setOptions({ enabled: false });
        await chrome.sidePanel.setOptions({ enabled: true });
        console.log('[Woodbury DBG] Side panel closed by request');
        sendResponseCallback({ ok: true });
      } catch (e) {
        console.log('[Woodbury DBG] Failed to close side panel:', e.message);
        sendResponseCallback({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Side panel asks to reopen itself (after step execution)
  if (message.type === 'open_sidepanel') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.sidePanel.open({ windowId: tab.windowId });
          console.log('[Woodbury DBG] Side panel reopened by request');
          if (debugModeData) {
            setTimeout(() => {
              chrome.runtime.sendMessage({ type: 'debug_started', data: debugModeData }).catch(() => {});
            }, 500);
          }
        }
        sendResponseCallback({ ok: true });
      } catch (e) {
        console.log('[Woodbury DBG] Failed to open side panel:', e.message);
        sendResponseCallback({ ok: false, error: e.message });
      }
    })();
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

  // Side panel requests element pick mode on the page
  if (message.type === 'start_element_pick') {
    if (debugModeData && debugModeData.tabId) {
      chrome.tabs.sendMessage(debugModeData.tabId, {
        action: 'start_element_pick',
        params: { stepIndex: message.stepIndex }
      }).catch(() => {});
    }
    sendResponseCallback({ ok: true });
    return true;
  }

  // Content script reports a picked element — forward to sidepanel
  if (message.type === 'element_picked' || message.type === 'element_pick_cancelled') {
    if (sidePanelOpen) {
      // Sidepanel is open — forward directly
      chrome.runtime.sendMessage(message).catch(() => {});
      sendResponseCallback({ ok: true });
    } else if (message.type === 'element_picked') {
      // Sidepanel is closed — capture screenshot NOW (elements in correct positions)
      // and store pick data + screenshot for when the sidepanel reopens
      (async () => {
        let screenshot = null;
        try {
          const tabId = debugModeData?.tabId;
          if (tabId) {
            const tab = await chrome.tabs.get(tabId);
            screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
            console.log('[Woodbury DBG] Captured screenshot at pick time (sidepanel closed)');
          }
        } catch (e) {
          console.log('[Woodbury DBG] Failed to capture at pick time:', e.message);
        }
        pendingPick = { ...message, screenshot };
        console.log('[Woodbury DBG] Stored pending pick for step', message.stepIndex, screenshot ? '(with screenshot)' : '(no screenshot)');
        sendResponseCallback({ ok: true });
      })();
    } else {
      sendResponseCallback({ ok: true });
    }
    return true; // keep message channel open for async response
  }

  // Sidepanel requests any pending pick data (stored while it was closed)
  if (message.type === 'get_pending_pick') {
    sendResponseCallback({ pendingPick: pendingPick });
    pendingPick = null; // clear after delivering
    return true;
  }

  // Sidepanel requests any pending step result (from close→execute→reopen flow)
  if (message.type === 'get_pending_step_result') {
    sendResponseCallback({ pendingStepResult: pendingStepResult });
    pendingStepResult = null;
    return true;
  }

  // Sidepanel requests: close panel → execute debug step → reopen panel
  // This orchestrates the full flow from the background (survives panel close/reopen)
  if (message.type === 'debug_step_with_toggle') {
    const { apiBaseUrl, workflowId } = message;
    (async () => {
      sendResponseCallback({ ok: true }); // ack immediately

      // 1. Close the side panel
      try {
        await chrome.sidePanel.setOptions({ enabled: false });
        await chrome.sidePanel.setOptions({ enabled: true });
        console.log('[Woodbury DBG] Panel closed for step execution');
      } catch (e) {
        console.log('[Woodbury DBG] Failed to close panel for step:', e.message);
      }

      // 2. Wait for viewport to settle
      await new Promise(r => setTimeout(r, 400));

      // 3. Execute the debug step via the dashboard API
      let stepResult = null;
      try {
        const res = await fetch(apiBaseUrl + '/api/workflows/' + encodeURIComponent(workflowId) + '/debug/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        stepResult = await res.json();
        if (!res.ok) {
          stepResult = { error: stepResult.error || 'Step failed' };
        }
      } catch (err) {
        stepResult = { error: err.message || 'Step request failed' };
      }

      // 4. Store the result for the reopened panel to pick up
      pendingStepResult = stepResult;

      // 5. Wait for the action to visually complete
      await new Promise(r => setTimeout(r, 600));

      // 6. Reopen the side panel by clicking the extension icon
      //    (chrome.sidePanel.open() requires a user gesture, so we click
      //     the actual toolbar icon via OS accessibility APIs)
      try {
        await fetch(apiBaseUrl + '/api/click-extension-icon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        console.log('[Woodbury DBG] Clicked extension icon to reopen panel');
      } catch (e) {
        console.log('[Woodbury DBG] Failed to click extension icon:', e.message);
      }
    })();
    return true; // keep message channel open for async
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
        params: { enabled: true, mode: recordingModeType },
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
