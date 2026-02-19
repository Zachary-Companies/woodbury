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
 * The shape every extension module must export.
 */
export interface WoodburyExtension {
  /** Called when the extension is loaded. Register tools, commands, etc. */
  activate(context: ExtensionContext): Promise<void> | void;

  /** Called when the extension is unloaded (optional). Clean up resources. */
  deactivate?(): Promise<void> | void;
}
