/**
 * Platform Script Registry
 *
 * Merges built-in scripts with user-defined scripts from disk.
 * Disk scripts take priority over built-in ones.
 */

import type { PlatformScript, PlatformName } from '../types.js';
import { loadPlatformScript } from '../storage.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import instagramScript from './instagram.js';
import twitterScript from './twitter.js';
import youtubeScript from './youtube.js';

const builtInScripts: Record<string, PlatformScript> = {
  instagram: instagramScript,
  twitter: twitterScript,
  youtube: youtubeScript,
};

/**
 * Get a platform script by name.
 * Checks disk first (user-defined), falls back to built-in.
 */
export async function getScript(platform: string): Promise<PlatformScript | null> {
  // Try disk first
  const diskScript = await loadPlatformScript(platform);
  if (diskScript) return diskScript;
  // Fall back to built-in
  return builtInScripts[platform] || null;
}

/**
 * Get a platform script synchronously (built-in only).
 * Used by legacy code paths that can't be async.
 */
export function getScriptSync(platform: string): PlatformScript | null {
  return builtInScripts[platform] || null;
}

/**
 * Get all registered platform scripts (built-in + disk).
 */
export async function getAllScripts(): Promise<PlatformScript[]> {
  const scripts: Record<string, PlatformScript> = { ...builtInScripts };

  // Load disk scripts
  const connectorsDir = join(process.env.SOCIAL_SCHEDULER_DATA_DIR || join(homedir(), '.woodbury', 'social-scheduler'), 'connectors');
  if (existsSync(connectorsDir)) {
    try {
      const files = (await readdir(connectorsDir)).filter(f => f.endsWith('.script.json'));
      for (const f of files) {
        try {
          const raw = await readFile(join(connectorsDir, f), 'utf-8');
          const script: PlatformScript = JSON.parse(raw);
          if (script.platform) {
            scripts[script.platform] = script;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return Object.values(scripts);
}

/**
 * Get metadata for all scripts (without step details).
 */
export async function getScriptMeta(): Promise<Array<{
  platform: string;
  requiresImage: boolean;
  requiresVideo: boolean;
  maxCaptionLength?: number;
  maxTextLength?: number;
  maxTitleLength?: number;
  maxDescriptionLength?: number;
  stepCount: number;
}>> {
  const all = await getAllScripts();
  return all.map(s => ({
    platform: s.platform,
    requiresImage: s.requiresImage || false,
    requiresVideo: s.requiresVideo || false,
    maxCaptionLength: s.maxCaptionLength,
    maxTextLength: s.maxTextLength,
    maxTitleLength: s.maxTitleLength,
    maxDescriptionLength: s.maxDescriptionLength,
    stepCount: s.steps.length,
  }));
}

/**
 * Get metadata synchronously (built-in only).
 */
export function getScriptMetaSync(): Array<{
  platform: string;
  requiresImage: boolean;
  requiresVideo: boolean;
  maxCaptionLength?: number;
  maxTextLength?: number;
  maxTitleLength?: number;
  maxDescriptionLength?: number;
  stepCount: number;
}> {
  return Object.values(builtInScripts).map(s => ({
    platform: s.platform,
    requiresImage: s.requiresImage || false,
    requiresVideo: s.requiresVideo || false,
    maxCaptionLength: s.maxCaptionLength,
    maxTextLength: s.maxTextLength,
    maxTitleLength: s.maxTitleLength,
    maxDescriptionLength: s.maxDescriptionLength,
    stepCount: s.steps.length,
  }));
}

export { instagramScript, twitterScript, youtubeScript };
