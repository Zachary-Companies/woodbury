/**
 * Pipeline Route SDK
 *
 * Defines the interface that pipeline-local route handlers receive.
 * Pipelines ship a `routes/index.js` that exports a setup function.
 * The setup function receives a PipelineRouteSdk and returns an async
 * route handler function.
 *
 * This keeps pipeline-specific server logic (previs generation, TTS, video render)
 * out of Woodbury core while giving pipelines full access to project state,
 * image generation, TTS, file system, and other platform capabilities.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// ────────────────────────────────────────────────────────────────
//  Pipeline Route Handler — the function pipelines export
// ────────────────────────────────────────────────────────────────

/**
 * A pipeline route handler. Receives the HTTP request, response, and the
 * sub-path (everything after `/api/app/:id`). Returns `true` if handled.
 */
export type PipelineRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
) => Promise<boolean>;

/**
 * The setup function exported by a pipeline's routes/index.js.
 * Called once when the pipeline routes are first loaded.
 * Returns a route handler that will be called for every matching request.
 */
export type PipelineRouteSetup = (sdk: PipelineRouteSdk) => PipelineRouteHandler;

// ────────────────────────────────────────────────────────────────
//  Pipeline Route SDK — the context pipelines receive
// ────────────────────────────────────────────────────────────────

export interface PipelineRouteSdk {
  // ── Identity ──
  pipelineId: string;
  pipelineDir: string | null;

  // ── HTTP Helpers ──
  /** Send a JSON response with CORS headers. */
  sendJson: (res: ServerResponse, status: number, data: any) => void;
  /** Read and parse request body as JSON. */
  readBody: (req: IncomingMessage) => Promise<any>;

  // ── Project Data ──
  /** Get the in-memory project data (null if not loaded). */
  getProject: () => any | null;
  /** Ensure project is loaded into memory. Returns the project data. */
  ensureProject: () => Promise<any | null>;
  /** Apply a partial update to the project data. */
  updateProject: (partial: Record<string, any>) => void;
  /** Mark specific domain slices as dirty (triggers debounced flush). */
  markDirty: (slices: string[]) => void;
  /** Immediately flush dirty project data to disk. */
  flushProject: () => Promise<void>;
  /** Get the project folder path. */
  getProjectFolder: () => Promise<string>;
  /** Check if project is loaded in memory. */
  isProjectLoaded: () => boolean;

  // ── Pipeline Config ──
  /** Load an action config from the pipeline's actions/ directory. */
  loadActionConfig: (actionId: string) => Promise<Record<string, any>>;

  // ── Image Generation (nanobanana) ──
  /** Generate an image using the nanobanana tool. */
  generateImage: (params: {
    prompt: string;
    model?: 'flash' | 'pro';
    aspectRatio?: string;
    outputPath: string;
    referenceImages?: string[];
  }) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  // ── Video Generation (nanobanana-video / Veo 3.1) ──
  /** Generate a video using the nanobanana-video tool (Veo 3.1). */
  generateVideo: (params: {
    action: 'text-to-video' | 'image-to-video';
    prompt: string;
    image?: string;
    duration?: number;
    aspectRatio?: '16:9' | '9:16';
    outputPath: string;
  }) => Promise<{ success: boolean; filePath?: string; duration?: number; error?: string }>;

  // ── Extension Tools ──
  /** Find and call an extension tool by name. Returns null if not found. */
  callTool: (toolName: string, params: Record<string, any>, workDir?: string) => Promise<any | null>;
  /** Get all available extension tools. */
  getTools: () => Promise<Array<{ name: string; handler: Function }>>;

  // ── Bindings & Rules ──
  /** Load pipeline bindings document. */
  loadBindings: () => Promise<any>;
  /** Save pipeline bindings document. */
  saveBindings: (doc: any) => Promise<void>;
  /** Load pipeline rules document. */
  loadRules: () => Promise<any>;
  /** Save pipeline rules document. */
  saveRules: (doc: any) => Promise<void>;
  /** Run binding rules against current project data. */
  autoRunRules: () => Promise<{ added: number; replaced: number; totalBindings: number }>;

  // ── File System ──
  /** Read a file (UTF-8). */
  readFile: (path: string) => Promise<string>;
  /** Write a file (UTF-8). */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Create directories recursively. */
  mkdir: (path: string) => Promise<void>;
  /** Check if a file exists. */
  fileExists: (path: string) => boolean;
  /** Copy a file. */
  copyFile: (src: string, dest: string) => Promise<void>;
  /** Get file stats. */
  stat: (path: string) => Promise<{ size: number; mtime: Date }>;

  // ── Process Spawning ──
  /** Spawn a child process. Returns { code, stdout, stderr }. */
  exec: (command: string, options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  /** Spawn a long-running process. Returns the ChildProcess. */
  spawn: (command: string, args: string[], options?: any) => any;

  // ── Logging ──
  /** Log a message. */
  log: (level: 'info' | 'error' | 'warn', tag: string, message: string, meta?: any) => void;

  // ── Compositions Discovery ──
  /** Discover all compositions/pipelines. */
  discoverCompositions: () => Promise<any[]>;

  // ── Utility ──
  /** Get the path module's join function. */
  join: (...segments: string[]) => string;
  /** Get the path module's basename function. */
  basename: (path: string) => string;
  /** Get the path module's dirname function. */
  dirname: (path: string) => string;
}
