/**
 * Go-Links: Local URL Shortcut Proxy
 *
 * A lightweight HTTP redirect server that maps memorable short paths
 * (like go.w/config, go.w/social) to local service URLs. Similar to
 * corporate go-links but for local development services.
 *
 * Routes are persisted to ~/.woodbury/go-links.json.
 * Default port: 9000 (with EADDRINUSE fallback to random port).
 *
 * After one-time setup (woodbury go setup), users can just type
 * "go.w/config" in their browser — no port, no http://.
 *
 * Setup does two things:
 * 1. Adds "127.0.0.1 go.w" to /etc/hosts
 * 2. Uses macOS pf to forward port 80 → 9000 (so no port needed in URL)
 */

import { createServer, Server } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────

export interface GoLinksHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────

const WOODBURY_DIR = join(homedir(), '.woodbury');
const ROUTES_FILE = join(WOODBURY_DIR, 'go-links.json');
const DEFAULT_PORT = 9000;
export const GO_HOSTNAME = 'go.w';
const PF_ANCHOR_NAME = 'com.woodbury.golinks';
const PF_ANCHOR_FILE = join(WOODBURY_DIR, 'pf-golinks.conf');

// ── In-memory route map ────────────────────────────────────────────

let routes: Record<string, string> = {};

// ── Route persistence ──────────────────────────────────────────────

async function loadRoutes(): Promise<Record<string, string>> {
  try {
    const data = await readFile(ROUTES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveRoutes(): Promise<void> {
  await mkdir(WOODBURY_DIR, { recursive: true });
  await writeFile(ROUTES_FILE, JSON.stringify(routes, null, 2) + '\n');
}

// ── Public API ─────────────────────────────────────────────────────

export async function addRoute(name: string, targetUrl: string): Promise<void> {
  routes[name] = targetUrl;
  await saveRoutes();
}

export async function removeRoute(name: string): Promise<boolean> {
  if (!(name in routes)) return false;
  delete routes[name];
  await saveRoutes();
  return true;
}

export function getRoutes(): Record<string, string> {
  return { ...routes };
}

// ── HTML listing page ──────────────────────────────────────────────

function renderIndexPage(): string {
  const routeEntries = Object.entries(routes);
  const rows = routeEntries.length > 0
    ? routeEntries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, target]) =>
          `        <tr>
          <td><a href="/${name}" style="color:#7c3aed;text-decoration:none;font-weight:600;">${GO_HOSTNAME}/${name}</a></td>
          <td style="color:#94a3b8;">${target}</td>
        </tr>`
        )
        .join('\n')
    : '        <tr><td colspan="2" style="color:#64748b;text-align:center;padding:2rem;">No routes configured yet</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Woodbury Go-Links</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 2rem; }
    table { width: 100%; max-width: 600px; border-collapse: collapse; }
    th { text-align: left; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.5rem 1rem; border-bottom: 1px solid #1e293b; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #1e293b; font-size: 0.9rem; }
    tr:hover { background: #1e293b; }
    a:hover { text-decoration: underline !important; }
  </style>
</head>
<body>
  <h1>🔗 Woodbury Go-Links</h1>
  <p class="subtitle">Local URL shortcuts for your development services</p>
  <table>
    <thead>
      <tr>
        <th>Route</th>
        <th>Target</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}

// ── Server ─────────────────────────────────────────────────────────

export async function startGoLinks(verbose: boolean = false): Promise<GoLinksHandle> {
  routes = await loadRoutes();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderIndexPage());
      return;
    }

    const parts = pathname.slice(1).split('/');
    const name = parts[0];
    const rest = parts.length > 1 ? '/' + parts.slice(1).join('/') : '';

    const target = routes[name];
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><title>404</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:sans-serif;padding:2rem;}
a{color:#7c3aed;}</style></head>
<body><h2>Route not found: ${GO_HOSTNAME}/${name}</h2>
<p style="color:#94a3b8;margin-top:1rem;">Available routes: <a href="/">view all</a></p></body></html>`);
      return;
    }

    const redirectUrl = target + rest + url.search;
    if (verbose) {
      console.log(`[go-links] ${GO_HOSTNAME}/${name}${rest} → ${redirectUrl}`);
    }
    res.writeHead(302, { Location: redirectUrl });
    res.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (verbose) console.log(`[go-links] Port ${DEFAULT_PORT} in use, using random port`);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      } else {
        reject(err);
      }
    });
    server.listen(DEFAULT_PORT, '127.0.0.1', () => {
      server.removeAllListeners('error');
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT);
    });
  });

  const goLinksUrl = `http://127.0.0.1:${port}`;
  if (verbose) console.log(`[go-links] Go-links proxy at ${goLinksUrl}`);

  return {
    url: goLinksUrl,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Setup checks ───────────────────────────────────────────────────

export async function isHostsConfigured(): Promise<boolean> {
  try {
    const hosts = await readFile('/etc/hosts', 'utf-8');
    return hosts.includes(GO_HOSTNAME);
  } catch {
    return false;
  }
}

function isPfConfigured(): boolean {
  if (platform() !== 'darwin') return false;
  try {
    const pfConf = execSync('cat /etc/pf.conf', { encoding: 'utf-8' });
    return pfConf.includes(PF_ANCHOR_NAME);
  } catch {
    return false;
  }
}

// ── Setup ──────────────────────────────────────────────────────────

/**
 * One-time setup for go-links. After running, users type "go.w/config".
 *
 * 1. Adds "127.0.0.1 go.w" to /etc/hosts
 * 2. On macOS: sets up pf port forwarding 80 → 9000 (so no port in URL)
 *
 * Requires sudo (one password prompt).
 */
export async function setupHosts(): Promise<{ success: boolean; message: string }> {
  const steps: string[] = [];
  const isMac = platform() === 'darwin';

  const hostsOk = await isHostsConfigured();
  const pfOk = isMac ? isPfConfigured() : true;

  if (hostsOk) steps.push(`✓ /etc/hosts already has "${GO_HOSTNAME}"`);
  if (isMac && pfOk) steps.push('✓ Port forwarding already configured');

  if (hostsOk && pfOk) {
    return {
      success: true,
      message: steps.join('\n') + `\n\nAll set! Type ${GO_HOSTNAME}/config in your browser.`,
    };
  }

  try {
    await mkdir(WOODBURY_DIR, { recursive: true });

    // Write the pf anchor file (no sudo needed, it's in ~/.woodbury)
    if (isMac && !pfOk) {
      const pfRule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${DEFAULT_PORT}\n`;
      await writeFile(PF_ANCHOR_FILE, pfRule);
    }

    // Build setup script — all sudo commands in one script, one password prompt
    const scriptLines = ['#!/bin/sh', 'set -e'];

    if (!hostsOk) {
      scriptLines.push(`echo "127.0.0.1 ${GO_HOSTNAME}" >> /etc/hosts`);
      steps.push(`✓ Added "127.0.0.1 ${GO_HOSTNAME}" to /etc/hosts`);
    }

    if (isMac && !pfOk) {
      // Insert rdr-anchor AFTER the existing rdr-anchor "com.apple/*" line
      // This is the correct position — pf processes rdr rules in order
      scriptLines.push(
        `sed -i '' '/rdr-anchor "com.apple\\/\\*"/a\\`,
        `rdr-anchor "${PF_ANCHOR_NAME}"`,
        `' /etc/pf.conf`,
        // Load our anchor rules
        `pfctl -a "${PF_ANCHOR_NAME}" -f "${PF_ANCHOR_FILE}" 2>/dev/null`,
        // Reload the full pf config so it picks up the new anchor reference
        `pfctl -f /etc/pf.conf 2>/dev/null`,
        // Enable pf
        `pfctl -e 2>/dev/null || true`,
      );
      steps.push('✓ Port forwarding: 80 → 9000 (via pf)');
    }

    if (scriptLines.length > 2) {
      const scriptFile = join(WOODBURY_DIR, 'go-setup.sh');
      await writeFile(scriptFile, scriptLines.join('\n') + '\n');
      execSync(`sudo sh "${scriptFile}"`, { stdio: 'inherit' });
      await writeFile(scriptFile, '');
    }

    return {
      success: true,
      message: steps.join('\n') + `\n\nDone! Type ${GO_HOSTNAME}/config in your browser.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Setup failed: ${err}\n\nCompleted:\n${steps.join('\n') || '(none)'}`,
    };
  }
}

/**
 * Remove go-links setup.
 */
export async function teardownSetup(): Promise<{ success: boolean; message: string }> {
  const steps: string[] = [];
  const isMac = platform() === 'darwin';

  try {
    const scriptLines = ['#!/bin/sh'];
    const hostsOk = await isHostsConfigured();
    const pfOk = isMac ? isPfConfigured() : false;

    if (hostsOk) {
      scriptLines.push(`sed -i '' '/${GO_HOSTNAME}/d' /etc/hosts`);
      steps.push(`✓ Removed "${GO_HOSTNAME}" from /etc/hosts`);
    }

    if (pfOk) {
      scriptLines.push(
        `pfctl -a "${PF_ANCHOR_NAME}" -F all 2>/dev/null || true`,
        `sed -i '' '/${PF_ANCHOR_NAME}/d' /etc/pf.conf`,
        `pfctl -f /etc/pf.conf 2>/dev/null || true`,
      );
      steps.push('✓ Removed port forwarding');
    }

    if (scriptLines.length > 1) {
      await mkdir(WOODBURY_DIR, { recursive: true });
      const scriptFile = join(WOODBURY_DIR, 'go-teardown.sh');
      await writeFile(scriptFile, scriptLines.join('\n') + '\n');
      execSync(`sudo sh "${scriptFile}"`, { stdio: 'inherit' });
      await writeFile(scriptFile, '');
    }

    // Clean up local files
    if (existsSync(PF_ANCHOR_FILE)) {
      await writeFile(PF_ANCHOR_FILE, '');
    }

    return {
      success: true,
      message: steps.length > 0
        ? steps.join('\n') + '\n\nGo-links setup removed.'
        : 'Nothing to remove.',
    };
  } catch (err) {
    return { success: false, message: `Teardown failed: ${err}` };
  }
}
