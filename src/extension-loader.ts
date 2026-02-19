/**
 * Extension Loader
 *
 * Discovers extensions from two sources:
 *   1. Local directories:  ~/.woodbury/extensions/<name>/
 *   2. npm packages:       ~/.woodbury/extensions/node_modules/woodbury-ext-*
 *
 * Each extension must have a package.json with a "woodbury" field.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { WoodburyExtension } from './extension-api.js';

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
 * Discover all extension manifests without loading them.
 * Scans both local directories and npm packages.
 */
export async function discoverExtensions(): Promise<ExtensionManifest[]> {
  const manifests: ExtensionManifest[] = [];

  // 1. Local extensions: ~/.woodbury/extensions/<name>/
  if (existsSync(EXTENSIONS_DIR)) {
    try {
      const entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue;
        const dir = join(EXTENSIONS_DIR, entry.name);
        const manifest = await readManifest(dir, 'local');
        if (manifest) manifests.push(manifest);
      }
    } catch {
      // Extensions directory not readable — skip
    }
  }

  // 2. npm extensions: ~/.woodbury/extensions/node_modules/woodbury-ext-*
  const npmDir = join(EXTENSIONS_DIR, 'node_modules');
  if (existsSync(npmDir)) {
    try {
      const entries = await readdir(npmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        if (entry.name.startsWith('@')) {
          // Scoped packages: @scope/woodbury-ext-*
          const scopeDir = join(npmDir, entry.name);
          try {
            const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
            for (const scopeEntry of scopeEntries) {
              if (scopeEntry.isDirectory() && scopeEntry.name.startsWith(NPM_PREFIX)) {
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
  // Use file:// URL for dynamic import (required for absolute paths in ESM)
  const importPath = `file://${manifest.entryPoint}`;
  const mod = await import(importPath);

  // Support both default export and named activate export
  const extension: WoodburyExtension =
    mod.default?.activate ? mod.default :
    mod.activate ? mod :
    null as any;

  if (!extension || typeof extension.activate !== 'function') {
    throw new Error(
      `Extension "${manifest.name}" does not export an activate() function`
    );
  }

  return { manifest, module: extension };
}
