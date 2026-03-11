/**
 * Extension Loader
 *
 * Discovers extensions from two sources:
 *   1. Local directories:  ~/.woodbury/extensions/<name>/
 *   2. npm packages:       ~/.woodbury/extensions/node_modules/woodbury-ext-*
 *
 * Each extension must have a package.json with a "woodbury" field.
 */

import { readdir, readFile, access, stat, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
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
  source: 'local' | 'npm' | 'bundled';
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

/** Root directory for user-installed extensions */
export const EXTENSIONS_DIR = join(homedir(), '.woodbury', 'extensions');

/** Bundled extensions shipped with Woodbury */
// In dev: dist/../extensions (repo root). In packaged: dist/extensions.
const BUNDLED_EXTENSIONS_DIR = existsSync(join(__dirname, 'extensions'))
  ? join(__dirname, 'extensions')
  : join(__dirname, '..', 'extensions');

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

  // 0. Bundled extensions: <repo>/extensions/<name>/
  //    These ship with Woodbury and are always available.
  //    User-installed extensions with the same name will override them.
  const bundledNames = new Set<string>();
  if (existsSync(BUNDLED_EXTENSIONS_DIR)) {
    try {
      const entries = await readdir(BUNDLED_EXTENSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        const isDir = await isDirectoryEntry(entry, BUNDLED_EXTENSIONS_DIR);
        if (!isDir) continue;
        const dir = join(BUNDLED_EXTENSIONS_DIR, entry.name);
        const manifest = await readManifest(dir, 'bundled');
        if (manifest) {
          debugLog.debug('ext-loader', `Discovered bundled extension: ${manifest.name}`, {
            displayName: manifest.displayName,
          });
          bundledNames.add(manifest.name);
          manifests.push(manifest);
        }
      }
    } catch (err) {
      debugLog.warn('ext-loader', 'Bundled extensions directory not readable', { error: String(err) });
    }
  }

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
          // If a bundled extension has the same name, the local one overrides it
          if (bundledNames.has(manifest.name)) {
            const idx = manifests.findIndex(m => m.name === manifest.name && m.source === 'bundled');
            if (idx !== -1) {
              debugLog.info('ext-loader', `Local extension "${manifest.name}" overrides bundled version`);
              manifests.splice(idx, 1);
            }
          }
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
export async function readManifest(
  dir: string,
  source: 'local' | 'npm' | 'bundled'
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

// ────────────────────────────────────────────────────────────────
//  Extension Registry
// ────────────────────────────────────────────────────────────────

/** A single entry in the extension registry */
export interface ExtensionRegistryEntry {
  /** Short unique name (e.g. "nanobanana") */
  name: string;
  /** npm package name */
  packageName: string;
  /** Human-readable display name */
  displayName: string;
  /** What the extension does */
  description: string;
  /** Semantic version */
  version: string;
  /** What it provides: "tools", "commands", "prompts", "webui" */
  provides: string[];
  /** Absolute path to the JS entry point */
  entryPoint: string;
  /** Where it came from */
  source: 'local' | 'npm' | 'bundled';
  /** Absolute path to extension directory */
  directory: string;
  /** Declared env vars from package.json */
  envDeclarations: Record<string, EnvVarDeclaration>;
  /** Whether the extension is enabled */
  enabled: boolean;
  /** ISO timestamp of when it was registered */
  registeredAt: string;
}

/** On-disk registry file format */
export interface ExtensionRegistryFile {
  /** Schema version for forward compat */
  version: 1;
  /** Map from extension name to entry */
  extensions: Record<string, ExtensionRegistryEntry>;
}

/** Path to the registry file */
export const REGISTRY_PATH = join(EXTENSIONS_DIR, 'registry.json');

/**
 * Extension Registry — single source of truth for installed extensions.
 * Reads/writes ~/.woodbury/extensions/registry.json.
 * Provides instant metadata lookup without filesystem scanning.
 */
export class ExtensionRegistry {
  private data: ExtensionRegistryFile = { version: 1, extensions: {} };
  private _loaded = false;

  /** Load registry from disk. If missing, starts empty. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(REGISTRY_PATH, 'utf-8');
      this.data = JSON.parse(raw);
      this._loaded = true;
      debugLog.debug('registry', `Loaded registry with ${Object.keys(this.data.extensions).length} extension(s)`);
    } catch {
      this.data = { version: 1, extensions: {} };
      this._loaded = true;
      debugLog.debug('registry', 'No registry file found, starting fresh');
    }
  }

  /** Persist registry to disk. */
  async save(): Promise<void> {
    await mkdir(join(REGISTRY_PATH, '..'), { recursive: true });
    await fsWriteFile(REGISTRY_PATH, JSON.stringify(this.data, null, 2));
    debugLog.debug('registry', 'Registry saved');
  }

  /** Check if registry has no entries. */
  get isEmpty(): boolean {
    return Object.keys(this.data.extensions).length === 0;
  }

  /** Get all registered extensions. */
  getAll(): ExtensionRegistryEntry[] {
    return Object.values(this.data.extensions);
  }

  /** Get only enabled extensions. */
  getEnabled(): ExtensionRegistryEntry[] {
    return Object.values(this.data.extensions).filter(e => e.enabled);
  }

  /** Get a single extension by name. */
  get(name: string): ExtensionRegistryEntry | undefined {
    return this.data.extensions[name];
  }

  /** Register an extension from a full entry. */
  register(entry: ExtensionRegistryEntry): void {
    this.data.extensions[entry.name] = entry;
  }

  /** Register from an ExtensionManifest (used during migration and install). */
  registerFromManifest(manifest: ExtensionManifest, enabled: boolean = true): ExtensionRegistryEntry {
    const entry: ExtensionRegistryEntry = {
      name: manifest.name,
      packageName: manifest.packageName,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      provides: manifest.provides,
      entryPoint: manifest.entryPoint,
      source: manifest.source,
      directory: manifest.directory,
      envDeclarations: manifest.envDeclarations,
      enabled,
      registeredAt: new Date().toISOString(),
    };
    this.data.extensions[manifest.name] = entry;
    return entry;
  }

  /** Remove an extension by name. Returns true if it existed. */
  remove(name: string): boolean {
    if (this.data.extensions[name]) {
      delete this.data.extensions[name];
      return true;
    }
    return false;
  }

  /** Toggle enabled state. Returns true if the extension exists. */
  setEnabled(name: string, enabled: boolean): boolean {
    const entry = this.data.extensions[name];
    if (!entry) return false;
    entry.enabled = enabled;
    return true;
  }

  /** Update an entry's manifest fields (e.g., after version bump). */
  updateFromManifest(name: string, manifest: ExtensionManifest): void {
    const entry = this.data.extensions[name];
    if (!entry) return;
    entry.packageName = manifest.packageName;
    entry.displayName = manifest.displayName;
    entry.description = manifest.description;
    entry.version = manifest.version;
    entry.provides = manifest.provides;
    entry.entryPoint = manifest.entryPoint;
    entry.directory = manifest.directory;
    entry.envDeclarations = manifest.envDeclarations;
  }

  /** Convert a registry entry back to an ExtensionManifest (backward compat). */
  static toManifest(entry: ExtensionRegistryEntry): ExtensionManifest {
    return {
      packageName: entry.packageName,
      name: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      version: entry.version,
      provides: entry.provides,
      entryPoint: entry.entryPoint,
      source: entry.source,
      directory: entry.directory,
      envDeclarations: entry.envDeclarations,
    };
  }
}

/**
 * One-time migration: scan disk with discoverExtensions(), populate registry, save.
 * Called on first startup after upgrade when registry.json doesn't exist.
 */
export async function migrateToRegistry(registry: ExtensionRegistry): Promise<void> {
  debugLog.info('registry', 'Performing one-time migration from disk scanning to registry');
  const manifests = await discoverExtensions();
  for (const manifest of manifests) {
    registry.registerFromManifest(manifest, true);
  }
  await registry.save();
  debugLog.info('registry', `Migration complete: ${manifests.length} extension(s) registered`);
}

/**
 * Sync bundled extensions with the registry.
 * Adds new bundled extensions, updates versions if changed.
 * Does not touch user-installed overrides (source !== 'bundled').
 */
export async function syncBundledExtensions(registry: ExtensionRegistry): Promise<void> {
  if (!existsSync(BUNDLED_EXTENSIONS_DIR)) return;

  try {
    const entries = await readdir(BUNDLED_EXTENSIONS_DIR, { withFileTypes: true });
    let changed = false;

    for (const entry of entries) {
      const isDir = await isDirectoryEntry(entry, BUNDLED_EXTENSIONS_DIR);
      if (!isDir) continue;
      const dir = join(BUNDLED_EXTENSIONS_DIR, entry.name);
      const manifest = await readManifest(dir, 'bundled');
      if (!manifest) continue;

      const existing = registry.get(manifest.name);
      if (!existing) {
        // New bundled extension — register it
        registry.registerFromManifest(manifest, true);
        changed = true;
        debugLog.info('registry', `Registered new bundled extension: ${manifest.name}`);
      } else if (existing.source === 'bundled' && existing.version !== manifest.version) {
        // Updated bundled extension — update registry
        registry.updateFromManifest(manifest.name, manifest);
        changed = true;
        debugLog.info('registry', `Updated bundled extension: ${manifest.name} (${existing.version} → ${manifest.version})`);
      }
      // If user has a local override (source !== 'bundled'), don't touch it
    }

    if (changed) {
      await registry.save();
    }
  } catch (err) {
    debugLog.warn('registry', 'Failed to sync bundled extensions', { error: String(err) });
  }
}
