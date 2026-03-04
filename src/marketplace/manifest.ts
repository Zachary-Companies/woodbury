/**
 * Marketplace Manifest Manager
 *
 * Manages ~/.woodbury/marketplace.json which tracks installed shared workflows
 * and their versions. Used for update checking and local workflow management.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MarketplaceManifest, InstalledSharedWorkflow } from './types.js';

const MANIFEST_PATH = join(homedir(), '.woodbury', 'marketplace.json');

/** Default empty manifest */
function defaultManifest(): MarketplaceManifest {
  return { version: '1.0', workflows: {} };
}

/** Read the manifest from disk, returning a default if it doesn't exist */
export async function readManifest(): Promise<MarketplaceManifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, 'utf-8');
    const data = JSON.parse(content) as MarketplaceManifest;
    if (!data.workflows) data.workflows = {};
    return data;
  } catch {
    return defaultManifest();
  }
}

/** Write the manifest to disk */
export async function writeManifest(manifest: MarketplaceManifest): Promise<void> {
  const dir = join(homedir(), '.woodbury');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

/** Record that a shared workflow was installed or updated */
export async function trackInstall(info: InstalledSharedWorkflow): Promise<void> {
  const manifest = await readManifest();
  manifest.workflows[info.workflowId] = info;
  await writeManifest(manifest);
}

/** Remove a shared workflow from the manifest */
export async function trackUninstall(workflowId: string): Promise<void> {
  const manifest = await readManifest();
  delete manifest.workflows[workflowId];
  await writeManifest(manifest);
}

/** Get info about a specific installed workflow, or null */
export async function getInstalledWorkflow(
  workflowId: string,
): Promise<InstalledSharedWorkflow | null> {
  const manifest = await readManifest();
  return manifest.workflows[workflowId] || null;
}

/** Get all installed shared workflows */
export async function getAllInstalled(): Promise<InstalledSharedWorkflow[]> {
  const manifest = await readManifest();
  return Object.values(manifest.workflows);
}

/** Get a map of workflowId → installedVersion for update checking */
export async function getInstalledVersionMap(): Promise<Record<string, string>> {
  const manifest = await readManifest();
  const map: Record<string, string> = {};
  for (const [id, info] of Object.entries(manifest.workflows)) {
    map[id] = info.installedVersion;
  }
  return map;
}
