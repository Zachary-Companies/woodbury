/**
 * Platform Script Registry
 *
 * Exports all platform scripts and a lookup function.
 */

import type { PlatformScript, PlatformName } from '../types.js';
import instagramScript from './instagram.js';
import twitterScript from './twitter.js';
import youtubeScript from './youtube.js';

const scripts: Record<PlatformName, PlatformScript> = {
  instagram: instagramScript,
  twitter: twitterScript,
  youtube: youtubeScript,
};

/**
 * Get a platform script by name.
 */
export function getScript(platform: PlatformName): PlatformScript | null {
  return scripts[platform] || null;
}

/**
 * Get all registered platform scripts.
 */
export function getAllScripts(): PlatformScript[] {
  return Object.values(scripts);
}

/**
 * Get metadata for all scripts (without step details).
 */
export function getScriptMeta(): Array<{
  platform: PlatformName;
  requiresImage: boolean;
  requiresVideo: boolean;
  maxCaptionLength?: number;
  maxTextLength?: number;
  maxTitleLength?: number;
  maxDescriptionLength?: number;
  stepCount: number;
}> {
  return Object.values(scripts).map(s => ({
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
