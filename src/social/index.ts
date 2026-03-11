/**
 * Social Scheduler Module — Barrel Export
 *
 * Re-exports all public API for the integrated social scheduling system.
 */

// Types
export type {
  PostStatus,
  BuiltInPlatform,
  PlatformName,
  PostImage,
  PostContent,
  PlatformTarget,
  PostGeneration,
  SocialPost,
  StatusCounts,
  SocialConfig,
  PlatformConnector,
  PostingSessionState,
  ScriptStepType,
  BridgeAttempt,
  ScriptStep,
  PlatformScript,
  AgentInstruction,
  PostingEngineResult,
  PostFilters,
} from './types.js';

// Storage
export {
  getDataDir,
  getPostsDir,
  getMediaDir,
  ensureDir,
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  getDuePosts,
  getStatusCounts,
  getTodayPosts,
  getConfig,
  updateConfig,
  listConnectors,
  getConnector,
  saveConnector,
  deleteConnector,
  savePlatformScript,
  loadPlatformScript,
  savePostingSession,
  loadPostingSession,
  deletePostingSession,
  cleanExpiredSessions,
} from './storage.js';

// Scripts
export {
  getScript,
  getScriptSync,
  getAllScripts,
  getScriptMeta,
  getScriptMetaSync,
  instagramScript,
  twitterScript,
  youtubeScript,
} from './scripts/index.js';

// Posting Engine
export { PostingEngine, SESSION_TIMEOUT_MS, getPostingMethod } from './posting-engine.js';
export type { BridgeServer, PostingMethod } from './posting-engine.js';
