const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');

// ── App identity (must be set before menus are built) ────────
app.name = 'Woodbury';

// ── Single instance lock ─────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// ── Custom Protocol ──────────────────────────────────────────
const PROTOCOL = 'woodbury';
if (process.defaultApp) {
  // Dev mode: pass the script path so Electron can relaunch correctly
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ── State ────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let dashboardHandle = null;
let pendingProtocolUrl = null; // Queued URL from cold launch
app.isQuitting = false;

// ── Backend startup ──────────────────────────────────────────
// Require the compiled dashboard and extension manager directly.
// This runs the backend in the same Node.js process as Electron.

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function startBackend() {
  const distDir = path.join(__dirname, '..', 'dist');
  console.log('[electron] distDir:', distDir);

  console.log('[electron] Requiring config-dashboard...');
  const { startDashboard } = require(path.join(distDir, 'config-dashboard'));
  console.log('[electron] Requiring extension-manager...');
  const { ExtensionManager } = require(path.join(distDir, 'extension-manager'));
  console.log('[electron] Modules loaded.');

  // Use home directory as a stable working directory for the Electron app.
  // process.cwd() is unpredictable for installed apps (depends on how the app is launched),
  // which causes workflow/composition discovery to fail when looking in project-local dirs.
  const workDir = os.homedir();

  // Create extension manager but start dashboard immediately (don't wait for extensions)
  const extensionManager = new ExtensionManager(workDir, false);

  // Start the dashboard HTTP server right away
  console.log('[electron] Starting dashboard on port 9001...');
  const handle = await startDashboard(false, extensionManager, workDir, 9001);
  console.log(`[electron] Dashboard running at ${handle.url}`);

  // Load extensions in the background with a timeout
  console.log('[electron] Loading extensions in background...');
  withTimeout(extensionManager.loadAll(), 15000, 'Extension loading')
    .then(() => console.log('[electron] Extensions loaded.'))
    .catch((err) => console.error('[electron] Extension loading error:', err.message || err));

  return handle;
}

// ── Window ───────────────────────────────────────────────────

function createWindow(url) {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    } : {}),
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
    if (isMac) {
      // Inject CSS to account for hidden title bar inset (macOS only)
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
    }

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

function goTab(tab) {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(
      `if (typeof switchTab === 'function') switchTab(${JSON.stringify(tab)});`
    ).catch(() => {});
  }
}

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
                click: () => goTab('marketplace'),
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

    // Go menu — tab shortcuts
    {
      label: 'Go',
      submenu: [
        { label: 'Workflows', accelerator: 'CmdOrCtrl+1', click: () => goTab('workflows') },
        { label: 'Pipelines', accelerator: 'CmdOrCtrl+2', click: () => goTab('compositions') },
        { label: 'Runs', accelerator: 'CmdOrCtrl+3', click: () => goTab('runs') },
        { label: 'Training', accelerator: 'CmdOrCtrl+4', click: () => goTab('training') },
        { label: 'Marketplace', accelerator: 'CmdOrCtrl+5', click: () => goTab('marketplace') },
        { label: 'Social', accelerator: 'CmdOrCtrl+6', click: () => goTab('social') },
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
    const traySize = process.platform === 'win32' ? 16 : 18;
    icon = nativeImage.createFromPath(iconPath).resize({ width: traySize, height: traySize });
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true); // macOS auto-adjusts for dark/light menu bar
    }
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

// ── Auto-updater ─────────────────────────────────────────────

function setupAutoUpdater() {
  // Only run in packaged app — electron-updater won't work in dev mode
  if (process.defaultApp) {
    console.log('[updater] Skipping auto-updater in dev mode');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.error('[updater] Failed to load electron-updater:', err.message);
    return;
  }

  // Don't download automatically — ask the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Expose globally so the dashboard HTTP server can trigger updates
  global.woodburyAutoUpdater = autoUpdater;
  // When true, skip the "Download?" dialog and download immediately
  global.woodburyAutoDownloadNext = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update available:', info.version);

    // If triggered from dashboard, skip dialog and download immediately
    if (global.woodburyAutoDownloadNext) {
      global.woodburyAutoDownloadNext = false;
      console.log('[updater] Auto-downloading (triggered from dashboard)');
      autoUpdater.downloadUpdate();
      return;
    }

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Woodbury v${info.version} is available.`,
      detail: 'Would you like to download it now? The app will continue running while it downloads.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        console.log('[updater] User chose to download');
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[updater] Download progress: ${pct}%`);
    // Update the window title with progress
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(pct < 100 ? `Woodbury — Downloading update ${pct}%` : 'Woodbury');
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update downloaded:', info.version);
    // Reset window title
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle('Woodbury');
    }
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Woodbury v${info.version} has been downloaded.`,
      detail: 'Restart now to install the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        console.log('[updater] User chose to restart');
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message || err);
  });

  // Check for updates after a short delay (let the app finish loading)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Check failed:', err.message || err);
    });
  }, 5000);

  // Re-check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Periodic check failed:', err.message || err);
    });
  }, 4 * 60 * 60 * 1000);
}

// ── Protocol URL handler ─────────────────────────────────────

async function handleProtocolUrl(url) {
  try {
    const parsed = new URL(url);
    // woodbury://install/nanobanana?git=https://github.com/...
    if (parsed.hostname === 'install' || parsed.pathname.startsWith('/install')) {
      const name = (parsed.hostname === 'install' ? parsed.pathname : parsed.pathname.replace(/^\/install\/?/, '')).replace(/^\//, '');
      const gitUrl = parsed.searchParams.get('git');

      if (name && gitUrl && dashboardHandle) {
        // Show and focus the window
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }

        // Navigate to marketplace tab and trigger install
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(`
            // Switch to marketplace tab
            if (typeof switchTab === 'function') switchTab('marketplace');
            // Wait for init, then auto-install
            setTimeout(function() {
              if (typeof installExtension === 'function') {
                installExtension(${JSON.stringify(name)}, ${JSON.stringify(gitUrl)}).then(function(result) {
                  if (typeof initMarketplace === 'function') initMarketplace();
                });
              }
            }, 1500);
          `).catch(() => {});
        }

        // Also do the install via API as a fallback
        const http = require('http');
        const postData = JSON.stringify({ name, gitUrl });
        const req = http.request({
          hostname: '127.0.0.1',
          port: dashboardHandle.port,
          path: '/api/marketplace/install',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        });
        req.write(postData);
        req.end();
      }
    }

    // woodbury://workflow/install/{workflowId} — install a shared workflow
    if (parsed.hostname === 'workflow' || parsed.pathname.startsWith('/workflow')) {
      const pathParts = parsed.pathname.replace(/^\//, '').split('/');
      // pathParts = ['install', '{workflowId}'] or ['workflow', 'install', '{workflowId}']
      let action, workflowId;
      if (parsed.hostname === 'workflow') {
        action = pathParts[0];
        workflowId = pathParts[1];
      } else {
        action = pathParts[1];
        workflowId = pathParts[2];
      }

      if (action === 'install' && workflowId && dashboardHandle) {
        // Show and focus the window
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }

        // Download the shared workflow via API
        const http = require('http');
        const postData = JSON.stringify({ workflowId });
        const req = http.request({
          hostname: '127.0.0.1',
          port: dashboardHandle.port,
          path: '/api/marketplace/download',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              if (result.success && mainWindow) {
                mainWindow.webContents.executeJavaScript(`
                  if (typeof switchTab === 'function') switchTab('workflows');
                  setTimeout(function() {
                    if (typeof showNotification === 'function') {
                      showNotification('Workflow installed successfully!', 'success');
                    } else {
                      alert('Workflow installed successfully!');
                    }
                  }, 500);
                `).catch(() => {});
              } else if (mainWindow) {
                const errorMsg = result.error || 'Unknown error';
                mainWindow.webContents.executeJavaScript(`
                  alert('Failed to install workflow: ' + ${JSON.stringify(errorMsg)});
                `).catch(() => {});
              }
            } catch {}
          });
        });
        req.on('error', () => {});
        req.write(postData);
        req.end();
      }
    }
  } catch (err) {
    console.error('[electron] Protocol URL error:', err.message || err);
  }
}

// macOS: handle protocol URLs (may fire before 'ready' on cold launch)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (dashboardHandle) {
    handleProtocolUrl(url);
  } else {
    // Backend not ready yet — queue it for after startup
    pendingProtocolUrl = url;
  }
});

// ── App lifecycle ────────────────────────────────────────────

app.on('ready', async () => {
  console.log('[electron] ready event fired');
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
    setupAutoUpdater();

    // Process any protocol URL that arrived before the backend was ready
    // macOS: queued from open-url event; Windows: passed via process.argv
    if (!pendingProtocolUrl && process.platform === 'win32') {
      pendingProtocolUrl = process.argv.find(arg => arg.startsWith(PROTOCOL + '://'));
    }
    if (pendingProtocolUrl) {
      console.log('[electron] Processing queued protocol URL:', pendingProtocolUrl);
      handleProtocolUrl(pendingProtocolUrl);
      pendingProtocolUrl = null;
    }
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

// Second instance attempted — focus existing window (also handles protocol URLs on Windows)
app.on('second-instance', (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // On Windows, the protocol URL is passed as a command line argument
  const protocolUrl = commandLine.find(arg => arg.startsWith(PROTOCOL + '://'));
  if (protocolUrl) {
    handleProtocolUrl(protocolUrl);
  }
});

// Prevent the app from quitting when all windows are closed (macOS convention)
app.on('window-all-closed', () => {
  // On macOS, keep running in tray. On other platforms, quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
