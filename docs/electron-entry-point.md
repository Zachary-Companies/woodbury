# Electron Entry Point: Dev vs Built App

## The Problem

When running `npx electron .` in dev mode, the app would start (tool registration output appeared) but the HTTP dashboard server never started, and the Electron window never opened. The process would sit idle or exit silently.

## Root Cause

There are **two separate entry points** for the app:

| Context | Entry file | How it's set |
|---------|-----------|-------------|
| CLI (`woodbury` command) | `dist/index.js` | `package.json` → `"main": "dist/index.js"` |
| Built Electron app (.app/.exe) | `electron/main.js` | `electron-builder.yml` → `extraMetadata.main: electron/main.js` |
| Dev Electron (`npx electron .`) | `dist/index.js` | `package.json` → `"main": "dist/index.js"` |

The key issue: `dist/index.js` (compiled from `src/index.ts`) uses `require.main === module` to decide whether to start the CLI. **In Electron, `require.main !== module`** — Electron has its own module loading that doesn't set `require.main` to the loaded entry module.

This means:
- The `if (require.main === module)` block **never executes** in Electron
- `require('./cli')` is never called
- The dashboard server never starts
- The BrowserWindow is never created

The "Registered tool:" output that appears is a **side effect** of module imports at the top of `index.js` — extension-related modules register tools when they're first `require()`'d, even though no startup code runs.

## Why It Seemed to Work Before

When `npm run build` hasn't been run, the previously-compiled `dist/index.js` may have had different startup logic (perhaps without the `require.main` guard, or with an Electron-aware check already in place). Running `npm run build` compiles `src/index.ts` fresh, overwriting `dist/index.js` and introducing/reintroducing the guard.

## The Fix

In `src/index.ts`, detect the Electron environment and delegate to the proper Electron entry point:

```typescript
const isElectron = !!(process.versions as any).electron;
if (require.main === module || isElectron) {
  if (isElectron) {
    // Dev mode: delegate to the Electron main process file
    require('../electron/main');
  } else {
    // CLI mode: parse args and start REPL
    const args = process.argv.slice(2);
    // ... existing CLI logic ...
  }
}
```

### How the detection works

- `process.versions.electron` exists only when running inside Electron
- This is a reliable, built-in way to detect Electron — no environment variables needed
- The fix delegates to `electron/main.js` which has the proper `app.whenReady()`, `BrowserWindow`, tray setup, and calls `startDashboard()` directly

## Key Files

| File | Role |
|------|------|
| `src/index.ts` → `dist/index.js` | Universal entry point (CLI + dev Electron) |
| `electron/main.js` | Electron-specific startup (BrowserWindow, tray, menu, backend) |
| `electron-builder.yml` | Overrides `main` to `electron/main.js` for built apps |
| `package.json` | Sets `main` to `dist/index.js` for CLI and dev Electron |

## Debugging Tips

If the Electron app appears to start but the dashboard isn't running:

1. **Check `process.argv`**: In Electron it's `['/path/to/Electron', '.']` — only 2 elements
2. **Check `require.main === module`**: Will be `false` in Electron
3. **Check ports**: `curl -s http://localhost:9001/api/bridge/status` — if no response, the server never started
4. **Add debug logging** to the very top of `dist/index.js` to confirm it's being loaded
5. **Check for port conflicts**: Previous zombie processes may hold port 9001. Use `lsof -i :9001` to check, `kill -9` to free

## Related: Port Conflicts

When restarting the Electron app, previous instances may still hold ports. Always kill cleanly:

```bash
pkill -f "Electron"
lsof -ti :9001 | xargs kill -9    # free dashboard port
lsof -ti :8679 | xargs kill -9    # free inference server port
```

The dashboard has fallback logic: if port 9001 is busy, it picks a random port. This can cause confusion when `curl http://localhost:9001` fails but the app is actually running on a different port. Check `~/.woodbury/data/dashboard.json` for the actual URL/port.
