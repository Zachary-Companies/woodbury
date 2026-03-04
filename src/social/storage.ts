/**
 * Social Scheduler — Storage Client
 *
 * File-based CRUD for social posts stored in ~/.woodbury/social-scheduler/
 * Port of the extension's storage-client.js to TypeScript with fs/promises.
 */

import { readdir, readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  SocialPost,
  PostContent,
  PlatformTarget,
  PlatformName,
  PostStatus,
  StatusCounts,
  SocialConfig,
  PlatformConnector,
  PostingSessionState,
  PostFilters,
} from './types.js';

// ── Paths ────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(homedir(), '.woodbury', 'social-scheduler');

export function getDataDir(): string {
  return process.env.SOCIAL_SCHEDULER_DATA_DIR || DEFAULT_DATA_DIR;
}

export function getPostsDir(): string {
  return join(getDataDir(), 'posts');
}

export function getMediaDir(): string {
  return join(getDataDir(), 'media');
}

function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

function getSessionsDir(): string {
  return join(getDataDir(), 'posting-sessions');
}

function getConnectorsDir(): string {
  return join(getDataDir(), 'connectors');
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Posts CRUD ────────────────────────────────────────────────

/**
 * List all posts, optionally filtered.
 */
export async function listPosts(filters: PostFilters = {}): Promise<SocialPost[]> {
  const postsDir = getPostsDir();
  ensureDir(postsDir);

  const files = (await readdir(postsDir)).filter(f => f.endsWith('.json'));
  let posts: SocialPost[] = [];

  for (const f of files) {
    try {
      const raw = await readFile(join(postsDir, f), 'utf-8');
      posts.push(JSON.parse(raw));
    } catch {
      // Skip unreadable files
    }
  }

  // Apply filters
  if (filters.status) {
    posts = posts.filter(p => p.status === filters.status);
  }
  if (filters.platform) {
    posts = posts.filter(p =>
      p.platforms.some(pt => pt.platform === filters.platform && pt.enabled),
    );
  }
  if (filters.from) {
    const from = new Date(filters.from);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) >= from);
  }
  if (filters.to) {
    const to = new Date(filters.to);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) <= to);
  }
  if (filters.tag) {
    posts = posts.filter(p => p.tags.includes(filters.tag!));
  }

  // Sort by scheduledAt (earliest first), drafts last
  posts.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });

  return posts;
}

/**
 * Get a single post by ID.
 */
export async function getPost(id: string): Promise<SocialPost | null> {
  const filePath = join(getPostsDir(), `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create a new post.
 */
export async function createPost(data: {
  text?: string;
  images?: SocialPost['content']['images'];
  video?: string | null;
  platformOverrides?: PostContent['platformOverrides'];
  scheduledAt?: string | null;
  timezone?: string;
  platforms?: (string | { platform: string })[];
  tags?: string[];
  generation?: SocialPost['generation'];
}): Promise<SocialPost> {
  const postsDir = getPostsDir();
  ensureDir(postsDir);

  const id = randomUUID();
  const now = new Date().toISOString();

  const platforms: PlatformTarget[] = (data.platforms || []).map(p => ({
    platform: (typeof p === 'string' ? p : p.platform) as PlatformName,
    enabled: true,
    status: 'pending' as const,
    retryCount: 0,
  }));

  const post: SocialPost = {
    id,
    createdAt: now,
    updatedAt: now,
    content: {
      text: data.text || '',
      images: data.images || [],
      video: data.video || null,
      platformOverrides: data.platformOverrides || {},
    },
    scheduledAt: data.scheduledAt || null,
    timezone: data.timezone || 'America/New_York',
    platforms,
    status: data.scheduledAt ? 'scheduled' : 'draft',
    tags: data.tags || [],
    generation: data.generation,
  };

  // Create media directory for this post
  const mediaDir = join(getMediaDir(), id);
  ensureDir(mediaDir);

  await writeFile(join(postsDir, `${id}.json`), JSON.stringify(post, null, 2));
  return post;
}

/**
 * Update an existing post.
 */
export async function updatePost(
  id: string,
  data: Partial<SocialPost> & { content?: Partial<PostContent> },
): Promise<SocialPost> {
  const filePath = join(getPostsDir(), `${id}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Post not found: ${id}`);
  }

  const raw = await readFile(filePath, 'utf-8');
  const existing: SocialPost = JSON.parse(raw);

  const updated: SocialPost = {
    ...existing,
    ...data,
    id, // prevent ID changes
    updatedAt: new Date().toISOString(),
    content: data.content
      ? { ...existing.content, ...data.content }
      : existing.content,
  };

  // Auto-update status based on scheduledAt
  if (data.scheduledAt !== undefined && updated.status === 'draft') {
    updated.status = data.scheduledAt ? 'scheduled' : 'draft';
  }

  await writeFile(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * Delete a post and its media.
 */
export async function deletePost(id: string): Promise<void> {
  const postPath = join(getPostsDir(), `${id}.json`);
  const mediaPath = join(getMediaDir(), id);

  if (existsSync(postPath)) {
    await unlink(postPath);
  }
  if (existsSync(mediaPath)) {
    await rm(mediaPath, { recursive: true, force: true });
  }
}

/**
 * Get posts that are due for posting (scheduledAt <= now, status === 'scheduled').
 */
export async function getDuePosts(until?: Date): Promise<SocialPost[]> {
  const cutoff = until || new Date();
  const scheduled = await listPosts({ status: 'scheduled' });
  return scheduled.filter(p =>
    p.scheduledAt && new Date(p.scheduledAt) <= cutoff,
  );
}

/**
 * Get post counts by status.
 */
export async function getStatusCounts(): Promise<StatusCounts> {
  const posts = await listPosts();
  const counts: StatusCounts = {
    draft: 0,
    scheduled: 0,
    posting: 0,
    posted: 0,
    partial: 0,
    failed: 0,
    total: posts.length,
  };
  for (const post of posts) {
    if (post.status in counts) {
      counts[post.status as keyof StatusCounts]++;
    }
  }
  return counts;
}

/**
 * Get today's posts (any status).
 */
export async function getTodayPosts(): Promise<SocialPost[]> {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  return listPosts({ from: startOfDay, to: endOfDay });
}

// ── Config ───────────────────────────────────────────────────

const DEFAULT_CONFIG: SocialConfig = {
  defaultTimezone: 'America/New_York',
  defaultPlatforms: [],
  llm: { textProvider: 'anthropic', textModel: 'claude-opus-4-5-20251101' },
  posting: { delayBetweenPlatforms: 5000, retryLimit: 2, retryDelay: 10000 },
};

/**
 * Read the scheduler config.
 */
export async function getConfig(): Promise<SocialConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = await readFile(configPath, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Update the scheduler config.
 */
export async function updateConfig(data: Partial<SocialConfig>): Promise<SocialConfig> {
  const existing = await getConfig();
  const updated: SocialConfig = {
    ...existing,
    ...data,
    llm: data.llm ? { ...existing.llm, ...data.llm } : existing.llm,
    posting: data.posting ? { ...existing.posting, ...data.posting } : existing.posting,
  };
  ensureDir(getDataDir());
  await writeFile(getConfigPath(), JSON.stringify(updated, null, 2));
  return updated;
}

// ── Connectors ───────────────────────────────────────────────

/**
 * List available platform connectors.
 */
export async function listConnectors(): Promise<PlatformConnector[]> {
  const connectorsDir = getConnectorsDir();
  ensureDir(connectorsDir);

  const files = (await readdir(connectorsDir)).filter(f => f.endsWith('.json'));
  const connectors: PlatformConnector[] = [];

  for (const f of files) {
    try {
      const raw = await readFile(join(connectorsDir, f), 'utf-8');
      connectors.push(JSON.parse(raw));
    } catch {
      // Skip unreadable
    }
  }

  return connectors;
}

// ── Posting Sessions ─────────────────────────────────────────

/**
 * Save a posting session (engine state) to disk.
 */
export async function savePostingSession(sessionId: string, data: PostingSessionState): Promise<void> {
  const dir = getSessionsDir();
  ensureDir(dir);
  await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(data, null, 2));
}

/**
 * Load a posting session from disk. Returns null if missing or expired.
 * @param maxAgeMs Maximum age in ms (default: 10 minutes)
 */
export async function loadPostingSession(
  sessionId: string,
  maxAgeMs = 600000,
): Promise<PostingSessionState | null> {
  const filePath = join(getSessionsDir(), `${sessionId}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: PostingSessionState = JSON.parse(raw);

    // Check expiry
    const updatedAt = new Date(data.updatedAt || data.createdAt);
    if (Date.now() - updatedAt.getTime() > maxAgeMs) {
      // Expired — clean up
      try { await unlink(filePath); } catch { /* non-critical */ }
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Delete a posting session from disk.
 */
export async function deletePostingSession(sessionId: string): Promise<void> {
  const filePath = join(getSessionsDir(), `${sessionId}.json`);
  try {
    if (existsSync(filePath)) await unlink(filePath);
  } catch {
    // Non-critical
  }
}

/**
 * Clean up expired posting sessions.
 */
export async function cleanExpiredSessions(maxAgeMs = 600000): Promise<void> {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return;

  const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const filePath = join(dir, f);
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const updatedAt = new Date(data.updatedAt || data.createdAt);
      if (Date.now() - updatedAt.getTime() > maxAgeMs) {
        await unlink(filePath);
      }
    } catch {
      // Skip unreadable files
    }
  }
}
