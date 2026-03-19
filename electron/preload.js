const { contextBridge, webUtils, ipcRenderer } = require('electron');

// Expose minimal info to the renderer.
// The dashboard is vanilla HTML/JS that talks to localhost APIs,
// so it does not need Node.js access.
contextBridge.exposeInMainWorld('woodburyElectron', {
  platform: process.platform,
  isElectron: true,
  // Get the native file path from a dropped File object (Electron 28+)
  getFilePath: (file) => {
    try {
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    } catch {}
    return file.path || null;
  },
  // Open native OS folder picker dialog
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
});
