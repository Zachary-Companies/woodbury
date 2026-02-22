// ─── Post Types ──────────────────────────────────────────────────

export interface Post {
  id: string;
  createdAt: string;
  updatedAt: string;
  content: PostContent;
  scheduledAt: string | null;
  timezone: string;
  platforms: PlatformTarget[];
  status: PostStatus;
  tags: string[];
  generation?: GenerationMetadata;
}

export interface PostContent {
  text: string;
  images: ImageAttachment[];
  platformOverrides: Record<string, PlatformOverride>;
}

export interface PlatformOverride {
  text?: string;
  hashtags?: string[];
}

export interface ImageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  prompt?: string;
  width?: number;
  height?: number;
}

export interface PlatformTarget {
  platform: string;
  enabled: boolean;
  status: PlatformPostingStatus;
  postedAt?: string;
  postUrl?: string;
  error?: string;
}

export type PostStatus = 'draft' | 'scheduled' | 'posting' | 'posted' | 'partial' | 'failed';
export type PlatformPostingStatus = 'pending' | 'posting' | 'posted' | 'failed' | 'skipped';

export interface GenerationMetadata {
  model: string;
  prompt: string;
  generatedAt: string;
}

// ─── Create/Update Input Types ───────────────────────────────────

export interface CreatePostInput {
  text: string;
  platforms: string[];
  scheduledAt?: string;
  timezone?: string;
  tags?: string[];
  images?: ImageAttachment[];
  platformOverrides?: Record<string, PlatformOverride>;
}

export interface UpdatePostInput {
  content?: Partial<PostContent>;
  scheduledAt?: string | null;
  timezone?: string;
  platforms?: PlatformTarget[];
  status?: PostStatus;
  tags?: string[];
}

// ─── Connector Types ─────────────────────────────────────────────

export interface ConnectorManifest {
  platform: string;
  displayName: string;
  version: string;
  baseUrl: string;
  capabilities: {
    text: boolean;
    images: boolean;
    video: boolean;
    scheduling: boolean;
    stories: boolean;
  };
  maxTextLength: number;
  maxImages: number;
  imageFormats: string[];
  maxImageSize: number;
  requiresImage?: boolean;
  notes?: string;
}

// ─── Config Types ────────────────────────────────────────────────

export interface SchedulerConfig {
  defaultTimezone: string;
  defaultPlatforms: string[];
  llm: {
    textProvider: 'anthropic' | 'openai' | 'groq';
    textModel: string;
    imageProvider?: string;
    imageModel?: string;
  };
  posting: {
    delayBetweenPlatforms: number;
    retryLimit: number;
    retryDelay: number;
  };
}

// ─── API Types ───────────────────────────────────────────────────

export interface PostFilters {
  status?: PostStatus;
  platform?: string;
  from?: string;
  to?: string;
  tag?: string;
}

export interface GenerateTextRequest {
  prompt: string;
  platforms?: string[];
  tone?: 'professional' | 'casual' | 'humorous' | 'inspirational';
  length?: 'short' | 'medium' | 'long';
  includeHashtags?: boolean;
}

export interface GenerateImageRequest {
  prompt: string;
  postId: string;
  aspectRatio?: string;
}

export interface StatusCounts {
  draft: number;
  scheduled: number;
  posting: number;
  posted: number;
  partial: number;
  failed: number;
  total: number;
}
