/**
 * Social Scheduler — Type definitions
 *
 * Core types for the integrated social media posting system.
 */

// ── Post Types ───────────────────────────────────────────────

export type PostStatus = 'draft' | 'scheduled' | 'posting' | 'posted' | 'partial' | 'failed';

/** Built-in platform names (for type hints, not enforced) */
export type BuiltInPlatform = 'instagram' | 'twitter' | 'youtube';
/** Platform name — any string (user can add custom platforms) */
export type PlatformName = string;

export interface PostImage {
  /** Filename within the post's media directory */
  filename: string;
  /** Absolute path to the image file */
  path: string;
  /** MIME type (e.g. image/jpeg) */
  mimeType?: string;
}

export interface PostContent {
  /** Main text content (caption, tweet text, etc.) */
  text: string;
  /** Attached images */
  images: PostImage[];
  /** Attached video path (for YouTube) */
  video: string | null;
  /** Per-platform text overrides (e.g. shorter text for Twitter) */
  platformOverrides: Partial<Record<PlatformName, { text?: string }>>;
}

export interface PlatformTarget {
  /** Platform name */
  platform: PlatformName;
  /** Whether posting to this platform is enabled */
  enabled: boolean;
  /** Posting status for this specific platform */
  status: 'pending' | 'posting' | 'posted' | 'failed';
  /** Number of retry attempts */
  retryCount: number;
  /** Error message if failed */
  error?: string;
  /** URL of the published post */
  postUrl?: string;
}

export interface PostGeneration {
  /** The prompt used to generate content */
  prompt?: string;
  /** The model used for generation */
  model?: string;
  /** Whether image was AI-generated */
  imageGenerated?: boolean;
}

export interface SocialPost {
  /** Unique post ID (UUID) */
  id: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Post content (text, images, video) */
  content: PostContent;
  /** Scheduled posting time (ISO string), null for drafts */
  scheduledAt: string | null;
  /** Timezone for scheduling (e.g. 'America/New_York') */
  timezone: string;
  /** Target platforms */
  platforms: PlatformTarget[];
  /** Overall post status */
  status: PostStatus;
  /** User-defined tags for organization */
  tags: string[];
  /** AI generation metadata */
  generation?: PostGeneration;
}

// ── Status Counts ────────────────────────────────────────────

export interface StatusCounts {
  draft: number;
  scheduled: number;
  posting: number;
  posted: number;
  partial: number;
  failed: number;
  total: number;
}

// ── Config ───────────────────────────────────────────────────

export interface SocialConfig {
  /** Default timezone for new posts */
  defaultTimezone: string;
  /** Default platforms to enable for new posts */
  defaultPlatforms: PlatformName[];
  /** LLM configuration for AI text generation */
  llm: {
    textProvider: string;
    textModel: string;
  };
  /** Posting behavior configuration */
  posting: {
    /** Delay between posting to different platforms (ms) */
    delayBetweenPlatforms: number;
    /** Max retry attempts per platform */
    retryLimit: number;
    /** Delay between retries (ms) */
    retryDelay: number;
  };
}

// ── Connector ────────────────────────────────────────────────

export interface PlatformConnector {
  /** Platform slug (unique identifier) */
  platform: string;
  /** Whether the connector is enabled */
  enabled: boolean;
  /** Display name (e.g. "Instagram", "Twitter / X") */
  displayName?: string;
  /** Emoji or icon identifier */
  icon?: string;
  /** Brand color (hex) */
  color?: string;
  /** Platform base URL */
  baseUrl?: string;
  /** Semantic version */
  version?: string;
  /** Platform capabilities */
  capabilities?: {
    text?: boolean;
    images?: boolean;
    video?: boolean;
    stories?: boolean;
    scheduling?: boolean;
  };
  /** Max text/caption length */
  maxTextLength?: number;
  /** Max number of images */
  maxImages?: number;
  /** Allowed image formats */
  imageFormats?: string[];
  /** Max image size in bytes */
  maxImageSize?: number;
  /** Whether image is required for posting */
  requiresImage?: boolean;
  /** Whether video is required for posting */
  requiresVideo?: boolean;
  /** Linked composition pipeline ID (alternative to browser script) */
  compositionId?: string;
  /** Human-readable notes */
  notes?: string;
  /** Additional connector-specific config */
  config?: Record<string, unknown>;
}

// ── Posting Session ──────────────────────────────────────────

export interface PostingSessionState {
  /** Session ID */
  sessionId: string;
  /** Platform script being executed */
  scriptPlatform: PlatformName;
  /** Current step index */
  stepIndex: number;
  /** Runtime variables (captionText, imagePath, etc.) */
  variables: Record<string, string>;
  /** Session status */
  status: 'running' | 'paused' | 'success' | 'failed';
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

// ── Platform Script ──────────────────────────────────────────

export type ScriptStepType =
  | 'navigate'
  | 'bridge'
  | 'wait'
  | 'checkpoint'
  | 'file_dialog'
  | 'keyboard_type'
  | 'keyboard_select_all';

export interface BridgeAttempt {
  action: string;
  params?: Record<string, unknown>;
}

export interface ScriptStep {
  /** Step type */
  type: ScriptStepType;
  /** Human-readable label */
  label?: string;
  /** Conditional execution (e.g. 'hasImage') */
  conditional?: string;

  // navigate
  /** URL to navigate to */
  url?: string;
  /** Wait time after navigation (ms) */
  waitMs?: number;

  // bridge
  /** Bridge action to execute */
  action?: string;
  /** Parameters for the bridge action */
  params?: Record<string, unknown>;
  /** What to do with the result */
  then?: 'click';
  /** Retry configuration */
  retry?: { count: number; delayMs: number };
  /** Fallback actions to try if primary fails */
  fallback?: BridgeAttempt[];

  // wait
  /** Wait duration in ms */
  ms?: number;

  // checkpoint
  /** Bridge query for the checkpoint */
  bridge?: { action: string; params?: Record<string, unknown> };
  /** When to fail the checkpoint */
  failIf?: 'found' | 'not_found';
  /** Error message on checkpoint failure */
  failMessage?: string;

  // file_dialog / keyboard_type
  /** Variable name for file path */
  pathVar?: string;
  /** Variable name for text content */
  textVar?: string;
  /** Wait time after agent step (ms) */
  waitAfter?: number;
}

export interface PlatformScript {
  /** Platform name */
  platform: PlatformName;
  /** Whether an image is required */
  requiresImage?: boolean;
  /** Whether a video is required */
  requiresVideo?: boolean;
  /** Maximum caption/text length */
  maxCaptionLength?: number;
  /** Maximum text length */
  maxTextLength?: number;
  /** Maximum title length */
  maxTitleLength?: number;
  /** Maximum description length */
  maxDescriptionLength?: number;
  /** Ordered list of posting steps */
  steps: ScriptStep[];
}

// ── Posting Engine Result ────────────────────────────────────

export interface AgentInstruction {
  /** MCP tool name to call */
  tool: string;
  /** Tool parameters */
  params: Record<string, unknown>;
}

export interface PostingEngineResult {
  /** Engine status after execution */
  status: 'running' | 'paused' | 'success' | 'failed';
  /** Instruction for the agent to execute (when paused) */
  agentInstruction?: AgentInstruction;
  /** Delay after agent executes instruction (ms) */
  waitAfter?: number;
  /** Error message (when failed) */
  error?: string;
  /** Step index that caused the result */
  step?: number;
}

// ── Filters ──────────────────────────────────────────────────

export interface PostFilters {
  status?: PostStatus;
  platform?: PlatformName;
  from?: string;
  to?: string;
  tag?: string;
}
