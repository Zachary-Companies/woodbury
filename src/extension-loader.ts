/**
 * Extension Loader
 *
 * Discovers extensions from two sources:
 *   1. Local directories:  ~/.woodbury/extensions/<name>/
 *   2. npm packages:       ~/.woodbury/extensions/node_modules/woodbury-ext-*
 *
 * Each extension must have a package.json with a "woodbury" field.
 */

import { readdir, readFile, access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { WoodburyExtension } from './extension-api.js';
import { debugLog } from './debug-log.js';

/** Declaration of an environment variable expected by an extension */
export interface EnvVarDeclaration {
  required: boolean;
  description: string;
  /** Optional type hint for the dashboard UI. 'path' shows a folder picker. */
  type?: 'string' | 'path';
}

/** Metadata parsed from an extension's package.json */
export interface ExtensionManifest {
  /** npm package name (e.g. "woodbury-ext-social") */
  packageName: string;
  /** Short unique name from woodbury field (e.g. "social") */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** What the extension does */
  description: string;
  /** Semantic version */
  version: string;
  /** What the extension provides: "tools", "commands", "prompts", "webui" */
  provides: string[];
  /** Absolute path to the JS entry point */
  entryPoint: string;
  /** Where the extension was found */
  source: 'local' | 'npm';
  /** Absolute path to the extension root directory */
  directory: string;
  /** Declared environment variables from woodbury.env field in package.json */
  envDeclarations: Record<string, EnvVarDeclaration>;
}

/** A loaded extension with its manifest and module */
export interface LoadedExtension {
  manifest: ExtensionManifest;
  module: WoodburyExtension;
}

/** Root directory for all extensions */
export const EXTENSIONS_DIR = join(homedir(), '.woodbury', 'extensions');

/** npm package name prefix for Woodbury extensions */
const NPM_PREFIX = 'woodbury-ext-';

/**
 * Check if an entry is a directory (follows symlinks).
 */
async function isDirectoryEntry(entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }, parentDir: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      const fullPath = join(parentDir, entry.name);
      const stats = await stat(fullPath); // stat follows symlinks
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Discover all extension manifests without loading them.
 * Scans both local directories and npm packages.
 */
export async function discoverExtensions(): Promise<ExtensionManifest[]> {
  const manifests: ExtensionManifest[] = [];
  debugLog.debug('ext-loader', 'Discovering extensions', { dir: EXTENSIONS_DIR });

  // 1. Local extensions: ~/.woodbury/extensions/<name>/
  if (existsSync(EXTENSIONS_DIR)) {
    try {
      const entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true });
      debugLog.debug('ext-loader', `Scanning local extensions dir`, { entries: entries.map(e => e.name) });
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const isDir = await isDirectoryEntry(entry, EXTENSIONS_DIR);
        if (!isDir) continue;
        const dir = join(EXTENSIONS_DIR, entry.name);
        const manifest = await readManifest(dir, 'local');
        if (manifest) {
          debugLog.debug('ext-loader', `Discovered local extension: ${manifest.name}`, {
            displayName: manifest.displayName,
            entryPoint: manifest.entryPoint,
            provides: manifest.provides,
            envVars: Object.keys(manifest.envDeclarations),
          });
          manifests.push(manifest);
        } else {
          debugLog.debug('ext-loader', `Skipped "${entry.name}" — no valid woodbury manifest`);
        }
      }
    } catch (err) {
      debugLog.warn('ext-loader', 'Extensions directory not readable', { error: String(err) });
    }
  } else {
    debugLog.debug('ext-loader', 'Extensions directory does not exist');
  }

  // 2. npm extensions: ~/.woodbury/extensions/node_modules/woodbury-ext-*
  const npmDir = join(EXTENSIONS_DIR, 'node_modules');
  if (existsSync(npmDir)) {
    try {
      const entries = await readdir(npmDir, { withFileTypes: true });
      for (const entry of entries) {
        const isDir = await isDirectoryEntry(entry, npmDir);
        if (!isDir) continue;

        if (entry.name.startsWith('@')) {
          // Scoped packages: @scope/woodbury-ext-*
          const scopeDir = join(npmDir, entry.name);
          try {
            const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
            for (const scopeEntry of scopeEntries) {
              const isScopeDir = await isDirectoryEntry(scopeEntry, scopeDir);
              if (isScopeDir && scopeEntry.name.startsWith(NPM_PREFIX)) {
                const dir = join(scopeDir, scopeEntry.name);
                const manifest = await readManifest(dir, 'npm');
                if (manifest) manifests.push(manifest);
              }
            }
          } catch {
            // Scope directory not readable — skip
          }
        } else if (entry.name.startsWith(NPM_PREFIX)) {
          const dir = join(npmDir, entry.name);
          const manifest = await readManifest(dir, 'npm');
          if (manifest) manifests.push(manifest);
        }
      }
    } catch {
      // node_modules not readable — skip
    }
  }

  debugLog.info('ext-loader', `Discovery complete: ${manifests.length} extension(s) found`, {
    names: manifests.map(m => m.name),
  });
  return manifests;
}

/**
 * Read and validate a manifest from an extension directory.
 * Returns null if the directory isn't a valid extension.
 */
async function readManifest(
  dir: string,
  source: 'local' | 'npm'
): Promise<ExtensionManifest | null> {
  try {
    const pkgPath = join(dir, 'package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const wb = pkg.woodbury;

    // Must have a woodbury field with a name
    if (!wb || !wb.name) return null;

    const mainFile = pkg.main || 'index.js';
    const entryPoint = resolve(dir, mainFile);

    // Verify entry point exists
    await access(entryPoint);

    // Parse env declarations from woodbury.env field
    const envDeclarations: Record<string, EnvVarDeclaration> = {};
    if (wb.env && typeof wb.env === 'object') {
      for (const [key, decl] of Object.entries(wb.env)) {
        if (decl && typeof decl === 'object') {
          const declType = (decl as any).type;
          envDeclarations[key] = {
            required: (decl as any).required === true,
            description: (decl as any).description || '',
            ...(declType === 'path' ? { type: 'path' as const } : {}),
          };
        }
      }
    }

    return {
      packageName: pkg.name || wb.name,
      name: wb.name,
      displayName: wb.displayName || wb.name,
      description: wb.description || pkg.description || '',
      version: wb.version || pkg.version || '0.0.0',
      provides: wb.provides || [],
      entryPoint,
      source,
      directory: dir,
      envDeclarations,
    };
  } catch {
    return null; // Skip malformed extensions silently
  }
}

/**
 * Load a single extension by dynamic import.
 * Validates that the module exports an activate() function.
 */
export async function loadExtension(
  manifest: ExtensionManifest
): Promise<LoadedExtension> {
  // Use absolute path for require (TS compiles dynamic import to require for Node16 module)
  const importPath = manifest.entryPoint;
  debugLog.debug('ext-loader', `Loading extension module: ${manifest.name}`, { importPath });
  const mod = await import(importPath);

  // Support both default export and named activate export
  const extension: WoodburyExtension =
    mod.default?.activate ? mod.default :
    mod.activate ? mod :
    null as any;

  if (!extension || typeof extension.activate !== 'function') {
    debugLog.error('ext-loader', `Extension "${manifest.name}" has no activate() function`, {
      exports: Object.keys(mod),
      hasDefault: !!mod.default,
    });
    throw new Error(
      `Extension "${manifest.name}" does not export an activate() function`
    );
  }

  debugLog.debug('ext-loader', `Extension module loaded: ${manifest.name}`);
  return { manifest, module: extension };
}

/**
 * Parse a .env file content string into a key-value record.
 * Handles comments (#), blank lines, quoted values (single/double),
 * whitespace trimming, and equals signs within values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Serialize a key-value record into .env file content.
 * Inverse of parseEnvFile(). Quotes values containing special characters.
 */
export function writeEnvFile(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .filter(([, v]) => v !== '') // skip empty values (matches parseEnvFile behavior)
      .map(([k, v]) => {
        // Quote values containing spaces, #, =, or quotes
        if (/[\s#="']/.test(v)) {
          const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `${k}="${escaped}"`;
        }
        return `${k}=${v}`;
      })
      .join('\n') + '\n'
  );
}
