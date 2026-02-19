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

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      sendResponse({ id, error: 'No active tab found' });
      return;
    }

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

// ── Lifecycle ────────────────────────────────────────────────

// Start connection on service worker startup
connect();

// Listen for popup or other extension pages requesting status
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
