// Popup script — queries background for connection status

const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const dot = document.getElementById('dot');
const infoDiv = document.getElementById('info');
const reconnectBtn = document.getElementById('reconnect');

function updateUI(status) {
  if (status.connected) {
    statusDiv.className = 'status connected';
    dot.className = 'dot green';
    statusText.textContent = 'Connected to Woodbury';
    infoDiv.textContent = `WebSocket: ${status.wsUrl}`;
  } else {
    statusDiv.className = 'status disconnected';
    dot.className = 'dot red';
    statusText.textContent = 'Not connected';
    infoDiv.textContent = 'Start Woodbury CLI to connect, or click Reconnect.';
  }
}

// Check status on popup open
chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (response) updateUI(response);
});

// Reconnect button
reconnectBtn.addEventListener('click', () => {
  statusText.textContent = 'Reconnecting...';
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    // Re-check status after a short delay
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
        if (response) updateUI(response);
      });
    }, 1500);
  });
});
