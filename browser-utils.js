"use strict";
/**
 * Browser utility helpers.
 *
 * Provides a single function that brings Google Chrome to the foreground
 * and maximises its front window so it fills the screen.
 *
 * Supports macOS (AppleScript) and Windows (PowerShell + Win32 API).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.focusAndMaximizeChrome = focusAndMaximizeChrome;
const child_process_1 = require("child_process");
const os_1 = require("os");
/**
 * Activate Chrome and maximise the frontmost window.
 *
 * - macOS: AppleScript via `osascript`
 * - Windows: PowerShell with Win32 `ShowWindow(SW_MAXIMIZE)`
 */
function focusAndMaximizeChrome() {
    const os = (0, os_1.platform)();
    if (os === 'darwin') {
        // Two-step AppleScript:
        //  1. `activate` brings Chrome to the front.
        //  2. Via System Events set position to top-left and size to an
        //     absurdly large value — macOS clamps to the actual screen bounds,
        //     effectively maximising the window.
        const script = [
            'tell application "Google Chrome" to activate',
            'delay 0.2',
            'tell application "System Events" to tell process "Google Chrome" to set position of window 1 to {0, 25}',
            'tell application "System Events" to tell process "Google Chrome" to set size of window 1 to {10000, 10000}',
        ]
            .map((line) => `-e '${line}'`)
            .join(' ');
        (0, child_process_1.exec)(`osascript ${script}`, (err) => {
            if (err) {
                console.error('[browser-utils] focusAndMaximizeChrome failed:', err.message);
            }
        });
    }
    else if (os === 'win32') {
        // PowerShell: find Chrome's main window, bring to front, and maximise.
        // SW_SHOWMAXIMIZED = 3
        const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($chrome) {
  [Win32]::ShowWindow($chrome.MainWindowHandle, 3)
  [Win32]::SetForegroundWindow($chrome.MainWindowHandle)
}
`.trim();
        (0, child_process_1.exec)(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
            if (err) {
                console.error('[browser-utils] focusAndMaximizeChrome failed:', err.message);
            }
        });
    }
    // Linux: no-op for now
}
//# sourceMappingURL=browser-utils.js.map