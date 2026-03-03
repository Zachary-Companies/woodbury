const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');

// ── Single instance lock ─────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// ── State ────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let dashboardHandle = null;
app.isQuitting = false;

// ── Backend startup ──────────────────────────────────────────
// Require the compiled dashboard and extension manager directly.
// This runs the backend in the same Node.js process as Electron.

async function startBackend() {
  const distDir = path.join(__dirname, '..', 'dist');
  const { startDashboard } = require(path.join(distDir, 'config-dashboard'));
  const { ExtensionManager } = require(path.join(distDir, 'extension-manager'));

  // Load extensions (same as cli.ts)
  const extensionManager = new ExtensionManager(process.cwd(), false);
  try {
    await extensionManager.loadAll();
  } catch (err) {
    console.error('[electron] Extension loading error:', err.message || err);
    // Non-fatal — dashboard works without extensions
  }

  // Start the dashboard HTTP server
  const handle = await startDashboard(false, extensionManager, process.cwd(), 9001);
  console.log(`[electron] Dashboard running at ${handle.url}`);
  return handle;
}

// ── Window ───────────────────────────────────────────────────

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // Show after ready-to-show to avoid flash
  });

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    // Inject CSS to account for hidden title bar inset
    mainWindow.webContents.insertCSS(`
      /* Push sidebar header below traffic light buttons */
      .sidebar-header { padding-top: 2.25rem !important; }

      /* Make the top title bar area draggable */
      .sidebar::before {
        content: '';
        display: block;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 52px;
        -webkit-app-region: drag;
        z-index: 10;
        pointer-events: none;
      }

      /* Ensure interactive elements remain clickable */
      .nav-tab, button, input, select, textarea, a, .ext-item, .wf-sidebar-new {
        -webkit-app-region: no-drag;
      }
    `);

    mainWindow.show();
  });

  // macOS convention: close hides to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ─────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'icons', 'tray-icon.png');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    icon.setTemplateImage(true); // macOS auto-adjusts for dark/light menu bar
  } catch {
    // If no icon file yet, create a simple placeholder
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);

  const port = dashboardHandle ? dashboardHandle.port : '...';
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: `http://127.0.0.1:${port}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit Woodbury',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Woodbury');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ────────────────────────────────────────────

app.on('ready', async () => {
  // Set dock icon (needed in dev mode — packaged .app gets it from Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png'));
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  try {
    dashboardHandle = await startBackend();
    createWindow(dashboardHandle.url);
    createTray();
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    dialog.showErrorBox(
      'Woodbury Failed to Start',
      `The backend server could not start.\n\n${err.message || err}`
    );
    app.quit();
  }
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Graceful shutdown — close the dashboard server
app.on('before-quit', () => {
  app.isQuitting = true;
  if (dashboardHandle) {
    try {
      dashboardHandle.close();
    } catch {
      // Already closed or errored — ignore
    }
  }
});

// Second instance attempted — focus existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Prevent the app from quitting when all windows are closed (macOS convention)
app.on('window-all-closed', () => {
  // On macOS, keep running in tray. On other platforms, quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
