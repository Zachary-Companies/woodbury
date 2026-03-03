const { contextBridge } = require('electron');

// Expose minimal info to the renderer.
// The dashboard is vanilla HTML/JS that talks to localhost APIs,
// so it does not need Node.js access.
contextBridge.exposeInMainWorld('woodburyElectron', {
  platform: process.platform,
  isElectron: true,
});
