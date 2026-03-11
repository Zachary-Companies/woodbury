/**
 * Dashboard Route: Bridge
 *
 * Handles /api/bridge/screenshot, /api/click-extension-icon, and /api/simulate-keystroke endpoints.
 * Provides bridge screenshot capture and Chrome extension icon clicking/keystroke simulation.
 */

import { exec } from 'node:child_process';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson } from '../utils.js';
import { bridgeServer, ensureBridgeServer } from '../../bridge-server.js';
import { debugLog } from '../../debug-log.js';

// ── Route handler ────────────────────────────────────────────

export const handleBridgeRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // POST /api/click-extension-icon — click the Woodbury extension icon in Chrome's toolbar
  // This provides a real user gesture so chrome.sidePanel.open() works
  if (req.method === 'POST' && (pathname === '/api/click-extension-icon' || pathname === '/api/simulate-keystroke')) {
    try {
      const platform = process.platform;
      let cmd: string;

      if (platform === 'darwin') {
        // Use accessibility API to find and click the Woodbury Bridge button
        cmd = `osascript <<'APPLESCRIPT'
tell application "Google Chrome" to activate
delay 0.3
tell application "System Events"
    tell process "Google Chrome"
        set allElements to entire contents of window 1
        repeat with el in allElements
            try
                if description of el contains "Woodbury" then
                    click el
                    return "clicked"
                end if
            end try
        end repeat
        return "not found"
    end tell
end tell
APPLESCRIPT`;
      } else if (platform === 'win32') {
        // Windows: use UI Automation to find and click the extension button
        cmd = `powershell -NoProfile -Command "$wsh = New-Object -ComObject WScript.Shell; $wsh.AppActivate('Google Chrome'); Start-Sleep -Milliseconds 300; $wsh.SendKeys('%s')"`;
      } else {
        cmd = `xdotool key alt+s`;
      }

      debugLog.info('dashboard', `click-extension-icon: clicking on ${platform}`);
      exec(cmd, { timeout: 10000 }, (err, stdout) => {
        if (err) {
          debugLog.warn('dashboard', `click-extension-icon failed: ${err.message}`);
          sendJson(res, 500, { error: err.message });
        } else {
          const result = (stdout || '').trim();
          debugLog.info('dashboard', `click-extension-icon: ${result}`);
          sendJson(res, 200, { success: true, result });
        }
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/bridge/screenshot — capture viewport screenshot via bridge
  if (req.method === 'POST' && pathname === '/api/bridge/screenshot') {
    try {
      await ensureBridgeServer();
      if (!bridgeServer.isConnected) {
        sendJson(res, 503, { error: 'Chrome extension is not connected.' }); return true;
      }
      const screenshotResult = await bridgeServer.send('capture_viewport', {}) as any;
      const image = screenshotResult?.data?.image || screenshotResult?.image || null;
      if (!image) {
        sendJson(res, 500, { error: 'Failed to capture viewport screenshot' }); return true;
      }
      const pageInfo = await bridgeServer.send('get_page_info', {}) as any;
      const viewport = {
        width: pageInfo?.viewport?.width || pageInfo?.innerWidth || 1920,
        height: pageInfo?.viewport?.height || pageInfo?.innerHeight || 1080,
      };
      sendJson(res, 200, { screenshot: image, viewport });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
