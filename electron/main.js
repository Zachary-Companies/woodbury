const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');

// ── App identity (must be set before menus are built) ────────
app.name = 'Woodbury';

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

// ── Application Menu ─────────────────────────────────────────

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'About Woodbury' },
              { type: 'separator' },
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                    mainWindow.webContents.executeJavaScript(
                      `document.querySelector('[data-tab="config"]')?.click()`
                    );
                  }
                },
              },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Woodbury' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Woodbury' },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workflow',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.executeJavaScript(
                `document.querySelector('[data-tab="workflows"]')?.click()`
              );
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Quit Woodbury' },
      ],
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front', label: 'Bring All to Front' }]
          : []),
      ],
    },

    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Woodbury Documentation',
          click: () => {
            shell.openExternal('https://woodbury.dev');
          },
        },
        { type: 'separator' },
        {
          label: 'Open Logs Folder',
          click: () => {
            const logsPath = path.join(
              require('os').homedir(),
              '.woodbury',
              'logs'
            );
            shell.openPath(logsPath);
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
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

  createApplicationMenu();

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
