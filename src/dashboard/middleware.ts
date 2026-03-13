/**
 * Dashboard Middleware
 *
 * Handles CORS preflight requests and static file serving.
 * These run before any route handlers in the request chain.
 */

import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIME_TYPES, sendCorsOptions } from './utils.js';
import { debugLog } from '../debug-log.js';

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Returns true if handled, false to pass to next handler.
 */
export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    sendCorsOptions(res);
    return true;
  }
  return false;
}

/**
 * Serve static files from the config-dashboard directory.
 * This should be the LAST handler in the chain (fallback).
 */
export async function serveStaticFiles(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  staticDir: string,
): Promise<boolean> {
  const filePath = pathname === '/' ? '/index.html' : pathname.split('?')[0];
  let fullPath = join(staticDir, filePath);

  if (filePath.startsWith('/vendor/monaco/')) {
    const monacoRoot = resolve(staticDir, '..', '..', 'node_modules', 'monaco-editor', 'min');
    const relativePath = filePath.slice('/vendor/monaco/'.length);
    const candidatePath = resolve(monacoRoot, relativePath);
    if (candidatePath === monacoRoot || candidatePath.startsWith(monacoRoot + sep)) {
      fullPath = candidatePath;
    }
  }

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
    return true;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true; // We handled it (with a 404)
  }
}

/**
 * Log API requests for debugging.
 */
export function logApiRequest(req: IncomingMessage, pathname: string): void {
  if (pathname.startsWith('/api/')) {
    debugLog.debug('dashboard', `${req.method} ${pathname}`);
  }
}
