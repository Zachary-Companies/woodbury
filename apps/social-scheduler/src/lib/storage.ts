/**
 * File-based storage layer for social scheduler posts.
 * Reads/writes JSON files from ~/.woodbury/social-scheduler/
 */

import { readdir, readFile, writeFile, unlink, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type {
  Post, PostContent, PostStatus, PlatformTarget,
  CreatePostInput, UpdatePostInput, PostFilters,
  ConnectorManifest, SchedulerConfig, StatusCounts
} from '@/types';

const DATA_DIR = join(homedir(), '.woodbury', 'social-scheduler');
const POSTS_DIR = join(DATA_DIR, 'posts');
const MEDIA_DIR = join(DATA_DIR, 'media');
const CONNECTORS_DIR = join(DATA_DIR, 'connectors');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

// ─── Posts CRUD ──────────────────────────────────────────────────

export async function listPosts(filters?: PostFilters): Promise<Post[]> {
  await ensureDir(POSTS_DIR);

  const files = (await readdir(POSTS_DIR)).filter(f => f.endsWith('.json'));
  let posts: Post[] = [];

  for (const f of files) {
    try {
      const data = await readFile(join(POSTS_DIR, f), 'utf-8');
      posts.push(JSON.parse(data));
    } catch {
      // skip malformed files
    }
  }

  // Apply filters
  if (filters?.status) {
    posts = posts.filter(p => p.status === filters.status);
  }
  if (filters?.platform) {
    posts = posts.filter(p =>
      p.platforms.some(pt => pt.platform === filters.platform && pt.enabled)
    );
  }
  if (filters?.from) {
    const from = new Date(filters.from);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) >= from);
  }
  if (filters?.to) {
    const to = new Date(filters.to);
    posts = posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) <= to);
  }
  if (filters?.tag) {
    posts = posts.filter(p => p.tags.includes(filters.tag!));
  }

  // Sort: scheduled first (earliest), then drafts
  posts.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });

  return posts;
}

export async function getPost(id: string): Promise<Post | null> {
  const filePath = join(POSTS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  await ensureDir(POSTS_DIR);

  const id = randomUUID();
  const now = new Date().toISOString();

  const post: Post = {
    id,
    createdAt: now,
    updatedAt: now,
    content: {
      text: input.text,
      images: input.images || [],
      platformOverrides: input.platformOverrides || {},
    },
    scheduledAt: input.scheduledAt || null,
    timezone: input.timezone || 'America/New_York',
    platforms: input.platforms.map(p => ({
      platform: p,
      enabled: true,
      status: 'pending' as const,
    })),
    status: input.scheduledAt ? 'scheduled' : 'draft',
    tags: input.tags || [],
  };

  // Create media directory
  await ensureDir(join(MEDIA_DIR, id));

  await writeFile(join(POSTS_DIR, `${id}.json`), JSON.stringify(post, null, 2));
  return post;
}

export async function updatePost(id: string, input: UpdatePostInput): Promise<Post> {
  const existing = await getPost(id);
  if (!existing) throw new Error(`Post not found: ${id}`);

  const updated: Post = {
    ...existing,
    ...input,
    id, // prevent overwrite
    updatedAt: new Date().toISOString(),
    content: input.content
      ? { ...existing.content, ...input.content }
      : existing.content,
    platforms: input.platforms || existing.platforms,
    tags: input.tags || existing.tags,
  };

  // Auto-update status
  if (input.scheduledAt !== undefined && existing.status === 'draft') {
    updated.status = input.scheduledAt ? 'scheduled' : 'draft';
  }

  await writeFile(join(POSTS_DIR, `${id}.json`), JSON.stringify(updated, null, 2));
  return updated;
}

export async function deletePost(id: string): Promise<void> {
  const postPath = join(POSTS_DIR, `${id}.json`);
  const mediaPath = join(MEDIA_DIR, id);

  if (existsSync(postPath)) await unlink(postPath);
  if (existsSync(mediaPath)) await rm(mediaPath, { recursive: true, force: true });
}

export async function getDuePosts(): Promise<Post[]> {
  const now = new Date();
  const posts = await listPosts({ status: 'scheduled' });
  return posts.filter(p => p.scheduledAt && new Date(p.scheduledAt) <= now);
}

export async function getStatusCounts(): Promise<StatusCounts> {
  const posts = await listPosts();
  const counts: StatusCounts = { draft: 0, scheduled: 0, posting: 0, posted: 0, partial: 0, failed: 0, total: posts.length };
  for (const post of posts) {
    if (post.status in counts) {
      counts[post.status as keyof Omit<StatusCounts, 'total'>]++;
    }
  }
  return counts;
}

// ─── Connectors ──────────────────────────────────────────────────

export async function listConnectors(): Promise<ConnectorManifest[]> {
  await ensureDir(CONNECTORS_DIR);
  const files = (await readdir(CONNECTORS_DIR)).filter(f => f.endsWith('.json'));
  const connectors: ConnectorManifest[] = [];
  for (const f of files) {
    try {
      const data = await readFile(join(CONNECTORS_DIR, f), 'utf-8');
      connectors.push(JSON.parse(data));
    } catch {
      // skip
    }
  }
  return connectors;
}

export async function getConnector(platform: string): Promise<ConnectorManifest | null> {
  const filePath = join(CONNECTORS_DIR, `${platform}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveConnector(manifest: ConnectorManifest): Promise<void> {
  await ensureDir(CONNECTORS_DIR);
  await writeFile(
    join(CONNECTORS_DIR, `${manifest.platform}.json`),
    JSON.stringify(manifest, null, 2)
  );
}

// ─── Config ──────────────────────────────────────────────────────

export async function getConfig(): Promise<SchedulerConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return {
      defaultTimezone: 'America/New_York',
      defaultPlatforms: [],
      llm: { textProvider: 'anthropic', textModel: 'claude-opus-4-5-20251101' },
      posting: { delayBetweenPlatforms: 5000, retryLimit: 2, retryDelay: 10000 },
    };
  }
  const data = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(data);
}

export async function saveConfig(config: SchedulerConfig): Promise<void> {
  await ensureDir(DATA_DIR);
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Media ───────────────────────────────────────────────────────

export function getMediaPath(postId: string, filename: string): string {
  return join(MEDIA_DIR, postId, filename);
}

export async function ensureMediaDir(postId: string): Promise<string> {
  const dir = join(MEDIA_DIR, postId);
  await ensureDir(dir);
  return dir;
}
