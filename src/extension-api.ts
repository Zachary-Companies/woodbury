/**
 * Woodbury Extension API
 *
 * This module defines the public contract between Woodbury and extensions.
 * Extension authors import these types to build type-safe extensions.
 */

import type { ToolDefinition, ToolHandler } from './loop/types.js';

// Re-export for extension authors
export type { ToolDefinition, ToolHandler } from './loop/types.js';

/**
 * Context passed to an extension's activate() function.
 * This is the extension's interface to Woodbury internals.
 */
export interface ExtensionContext {
  /** Register a tool the agent can call */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void;

  /** Register a slash command for the REPL */
  registerCommand(command: ExtensionSlashCommand): void;

  /** Add text to the agent's system prompt (injected after built-in sections) */
  addSystemPrompt(section: string): void;

  /** Serve a web UI directory on a local HTTP port. Returns the URL. */
  serveWebUI(options: WebUIOptions): Promise<WebUIHandle>;

  /** The current working directory */
  workingDirectory: string;

  /** Log messages (routed through Woodbury's logger) */
  log: ExtensionLogger;

  /** Access to the bridge server for Chrome extension communication */
  bridgeServer: {
    send(action: string, params?: Record<string, any>): Promise<any>;
    readonly isConnected: boolean;
  };

  /**
   * Per-extension environment variables loaded from the extension's .env file.
   * This object is frozen (read-only). Extensions only see their own keys.
   * Declare expected keys in the "woodbury.env" field of package.json.
   */
  readonly env: Readonly<Record<string, string>>;

  /**
   * Register a periodic background task. The handler is called on an interval.
   * Return a string to inject it as an agent message (the agent will process it
   * as if the user typed it). Return null/undefined to skip (nothing to do).
   * Tasks only run while the REPL is active and idle (not during agent execution).
   */
  registerBackgroundTask(handler: BackgroundTaskHandler, options: BackgroundTaskOptions): void;
}

/**
 * A slash command provided by an extension.
 */
export interface ExtensionSlashCommand {
  name: string;
  description: string;
  handler: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
}

/**
 * Context passed to extension slash command handlers.
 */
export interface ExtensionCommandContext {
  workingDirectory: string;
  print: (message: string) => void;
}

/**
 * Options for serving a web UI from an extension.
 */
export interface WebUIOptions {
  /** Directory containing static files (index.html, etc.) */
  staticDir: string;
  /** Port to serve on (0 = auto-assign) */
  port?: number;
  /** Label shown in /extensions list */
  label?: string;
}

/**
 * Handle returned after starting a web UI server.
 */
export interface WebUIHandle {
  /** The URL where the web UI is accessible (e.g. http://127.0.0.1:43210) */
  url: string;
  /** The port the server is running on */
  port: number;
  /** Stop the web server */
  close(): Promise<void>;
}

/**
 * Logger interface available to extensions.
 */
export interface ExtensionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/**
 * Options for registering a background task.
 */
export interface BackgroundTaskOptions {
  /** Interval in milliseconds between invocations (minimum 10000) */
  intervalMs: number;
  /** Human-readable label shown in logs and /tasks command */
  label?: string;
  /** If true, run immediately on start in addition to on interval. Default: false */
  runImmediately?: boolean;
}

/**
 * Handler for a background task. Called periodically.
 * Return a string to inject it as an agent message, or null/undefined to skip.
 */
export type BackgroundTaskHandler =
  () => Promise<string | null | undefined> | string | null | undefined;

/**
 * The shape every extension module must export.
 */
export interface WoodburyExtension {
  /** Called when the extension is loaded. Register tools, commands, etc. */
  activate(context: ExtensionContext): Promise<void> | void;

  /** Called when the extension is unloaded (optional). Clean up resources. */
  deactivate?(): Promise<void> | void;
}
