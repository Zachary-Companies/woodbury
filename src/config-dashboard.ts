/**
 * Config Dashboard
 *
 * Built-in web dashboard for managing extension API keys.
 * Runs locally on 127.0.0.1 with auto-assigned port.
 *
 * Routes:
 *   GET  /                         -> index.html
 *   GET  /*.html|js|css            -> static files
 *   GET  /api/extensions           -> list all extensions with env status
 *   GET  /api/extensions/:name/env -> env var status for one extension
 *   PUT  /api/extensions/:name/env -> update env vars for one extension
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import {
  discoverExtensions,
  parseEnvFile,
  writeEnvFile,
  type ExtensionManifest,
} from './extension-loader.js';

// ────────────────────────────────────────────────────────────────
//  Public types
// ────────────────────────────────────────────────────────────────

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Mask an API key value: show first 4 and last 4 chars, rest asterisked */
export function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
}

/** Validate env var name: alphanumeric + underscore, starts with letter */
function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/** Read and parse a request body as JSON */
async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response */
function sendJson(res: ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// ────────────────────────────────────────────────────────────────
//  Extension env status
// ────────────────────────────────────────────────────────────────

/** Build the env status response for a single extension */
async function getExtensionEnvStatus(manifest: ExtensionManifest) {
  // Read current .env
  let currentEnv: Record<string, string> = {};
  try {
    const content = await readFile(join(manifest.directory, '.env'), 'utf-8');
    currentEnv = parseEnvFile(content);
  } catch {
    // No .env file
  }

  // Build status for each declared var
  const vars = Object.entries(manifest.envDeclarations).map(([key, decl]) => ({
    name: key,
    description: decl.description,
    required: decl.required,
    isSet: !!currentEnv[key],
    maskedValue: currentEnv[key] ? maskValue(currentEnv[key]) : null,
  }));

  // Include any extra vars in .env not declared in manifest
  const declaredKeys = new Set(Object.keys(manifest.envDeclarations));
  const extraVars = Object.entries(currentEnv)
    .filter(([key]) => !declaredKeys.has(key))
    .map(([key, value]) => ({
      name: key,
      description: '',
      required: false,
      isSet: true,
      maskedValue: maskValue(value),
    }));

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    source: manifest.source,
    directory: manifest.directory,
    vars: [...vars, ...extraVars],
  };
}

// ────────────────────────────────────────────────────────────────
//  Dashboard server
// ────────────────────────────────────────────────────────────────

export async function startDashboard(
  verbose: boolean = false
): Promise<DashboardHandle> {
  // Static files are copied to dist/config-dashboard/ by the postbuild script
  const staticDir = join(__dirname, 'config-dashboard');

  const server: Server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── API Routes ───────────────────────────────────────────

    // GET /api/extensions
    if (req.method === 'GET' && pathname === '/api/extensions') {
      try {
        const manifests = await discoverExtensions();
        const extensions = await Promise.all(
          manifests.map((m) => getExtensionEnvStatus(m))
        );
        sendJson(res, 200, { extensions });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/extensions/:name/env
    const getEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'GET' && getEnvMatch) {
      const name = decodeURIComponent(getEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }
        const status = await getExtensionEnvStatus(manifest);
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/extensions/:name/env
    const putEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'PUT' && putEnvMatch) {
      const name = decodeURIComponent(putEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || typeof body.vars !== 'object') {
          sendJson(res, 400, {
            error: 'Request body must have a "vars" object',
          });
          return;
        }

        // Validate var names
        for (const key of Object.keys(body.vars)) {
          if (!isValidEnvVarName(key)) {
            sendJson(res, 400, { error: `Invalid env var name: "${key}"` });
            return;
          }
        }

        // Read existing .env to merge (preserve vars not in request)
        let existingEnv: Record<string, string> = {};
        const envFilePath = join(manifest.directory, '.env');
        try {
          const content = await readFile(envFilePath, 'utf-8');
          existingEnv = parseEnvFile(content);
        } catch {
          // No existing .env file
        }

        // Merge: new values override existing; empty string = delete
        const merged = { ...existingEnv };
        for (const [key, value] of Object.entries(
          body.vars as Record<string, string>
        )) {
          if (value === '' || value === null || value === undefined) {
            delete merged[key];
          } else {
            merged[key] = String(value);
          }
        }

        // Write back
        const envContent = writeEnvFile(merged);
        await writeFile(envFilePath, envContent, 'utf-8');

        // Return updated status
        const status = await getExtensionEnvStatus(manifest);
        sendJson(res, 200, { success: true, ...status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Static File Serving ─────────────────────────────────
    const filePath =
      pathname === '/' ? '/index.html' : pathname.split('?')[0];
    const fullPath = join(staticDir, filePath);

    try {
      const content = await readFile(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve)
  );

  const addr = server.address();
  const assignedPort = typeof addr === 'object' && addr ? addr.port : 0;
  const dashboardUrl = `http://127.0.0.1:${assignedPort}`;

  if (verbose) {
    console.log(`[dashboard] Config dashboard at ${dashboardUrl}`);
  }

  return {
    url: dashboardUrl,
    port: assignedPort,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
