/**
 * Dashboard Utilities
 *
 * Shared helper functions used across all dashboard route handlers.
 * Provides HTTP response helpers, request parsing, file operations,
 * and validation utilities.
 */

import { writeFile, rename } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ────────────────────────────────────────────────────────────────
//  MIME types for static file serving
// ────────────────────────────────────────────────────────────────

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ────────────────────────────────────────────────────────────────
//  HTTP helpers
// ────────────────────────────────────────────────────────────────

/** Standard CORS headers applied to all JSON responses */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Send a JSON response with CORS headers */
export function sendJson(res: ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
  });
  res.end(body);
}

/** Read and parse a request body as JSON */
export async function readBody(req: IncomingMessage): Promise<any> {
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

/** Send a CORS preflight (OPTIONS) response */
export function sendCorsOptions(res: ServerResponse): void {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

// ────────────────────────────────────────────────────────────────
//  Value masking
// ────────────────────────────────────────────────────────────────

/** Mask an API key value: show first 4 and last 4 chars, rest asterisked */
export function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
}

// ────────────────────────────────────────────────────────────────
//  Validation
// ────────────────────────────────────────────────────────────────

/** Validate env var name: alphanumeric + underscore, starts with letter */
export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

// ────────────────────────────────────────────────────────────────
//  File operations
// ────────────────────────────────────────────────────────────────

/** Atomic file write: write to .tmp then rename to prevent torn writes */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}
