/**
 * Extension Manager
 *
 * Central coordinator for the extension lifecycle.
 * Owns discovery, activation, deactivation, and aggregation
 * of extension-provided tools, commands, prompts, and web UIs.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { ToolDefinition, ToolHandler } from './loop/types.js';
import type { SlashCommand } from './types.js';
import type {
  ExtensionContext,
  ExtensionSlashCommand,
  WebUIOptions,
  WebUIHandle,
  WoodburyExtension,
} from './extension-api.js';
import {
  discoverExtensions,
  loadExtension,
  parseEnvFile,
  type ExtensionManifest,
} from './extension-loader.js';
import { bridgeServer } from './bridge-server.js';

/** Record of a loaded and activated extension */
export interface ExtensionRecord {
  manifest: ExtensionManifest;
  module: WoodburyExtension;
  tools: Array<{ definition: ToolDefinition; handler: ToolHandler }>;
  commands: SlashCommand[];
  promptSections: string[];
  webServers: WebUIHandle[];
}

/** Summary of an extension for display */
export interface ExtensionSummary {
  name: string;
  displayName: string;
  version: string;
  source: string;
  tools: number;
  commands: number;
  hasPrompt: boolean;
  webUIs: string[];
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export class ExtensionManager {
  private extensions: Map<string, ExtensionRecord> = new Map();
  private workingDirectory: string;
  private verbose: boolean;

  constructor(workingDirectory: string, verbose: boolean = false) {
    this.workingDirectory = workingDirectory;
    this.verbose = verbose;
  }

  /**
   * Discover and activate all extensions.
   * Returns lists of successfully loaded extensions and errors.
   */
  async loadAll(): Promise<{
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
  }> {
    const manifests = await discoverExtensions();
    const loaded: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const manifest of manifests) {
      try {
        await this.activate(manifest);
        loaded.push(manifest.name);
      } catch (err) {
        errors.push({
          name: manifest.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { loaded, errors };
  }

  /**
   * Activate a single extension from its manifest.
   */
  private async activate(manifest: ExtensionManifest): Promise<void> {
    const { module } = await loadExtension(manifest);

    // ── Load per-extension .env file ──────────────────────────
    let extensionEnv: Record<string, string> = {};
    const envFilePath = join(manifest.directory, '.env');
    try {
      const envContent = await readFile(envFilePath, 'utf-8');
      extensionEnv = parseEnvFile(envContent);
    } catch {
      // No .env file — that's fine, extensionEnv stays empty
    }

    // Validate required env vars declared in package.json
    const missing: string[] = [];
    for (const [key, decl] of Object.entries(manifest.envDeclarations)) {
      if (decl.required && !extensionEnv[key]) {
        missing.push(key);
      }
    }
    if (missing.length > 0) {
      const envPath = join(manifest.directory, '.env');
      console.warn(
        `[ext:${manifest.name}] Missing required env var(s): ${missing.join(', ')}. ` +
        `Add them to ${envPath} or run: woodbury ext configure ${manifest.name}`
      );
    }

    // Freeze so extensions cannot mutate their env
    const frozenEnv = Object.freeze({ ...extensionEnv });

    const record: ExtensionRecord = {
      manifest,
      module,
      tools: [],
      commands: [],
      promptSections: [],
      webServers: [],
    };

    // Build the ExtensionContext for this extension
    const context: ExtensionContext = {
      workingDirectory: this.workingDirectory,

      registerTool: (definition: ToolDefinition, handler: ToolHandler) => {
        record.tools.push({ definition, handler });
      },

      registerCommand: (cmd: ExtensionSlashCommand) => {
        record.commands.push({
          name: cmd.name,
          description: `[${manifest.name}] ${cmd.description}`,
          handler: async (args, ctx) => {
            await cmd.handler(args, {
              workingDirectory: ctx.workingDirectory,
              print: ctx.print,
            });
          },
        });
      },

      addSystemPrompt: (section: string) => {
        record.promptSections.push(section);
      },

      serveWebUI: async (options: WebUIOptions): Promise<WebUIHandle> => {
        const handle = await this.startWebServer(options, manifest.name);
        record.webServers.push(handle);
        return handle;
      },

      log: {
        info: (msg: string) => {
          if (this.verbose) console.log(`[ext:${manifest.name}] ${msg}`);
        },
        warn: (msg: string) => console.warn(`[ext:${manifest.name}] ${msg}`),
        error: (msg: string) => console.error(`[ext:${manifest.name}] ${msg}`),
        debug: (msg: string) => {
          if (this.verbose) console.log(`[ext:${manifest.name}] ${msg}`);
        },
      },

      bridgeServer: {
        send: (action: string, params?: Record<string, any>) =>
          bridgeServer.send(action, params || {}),
        get isConnected() {
          return bridgeServer.isConnected;
        },
      },

      env: frozenEnv,
    };

    await module.activate(context);
    this.extensions.set(manifest.name, record);
  }

  /**
   * Deactivate and remove a specific extension.
   */
  async deactivate(name: string): Promise<void> {
    const record = this.extensions.get(name);
    if (!record) return;

    // Close web servers
    for (const server of record.webServers) {
      try {
        await server.close();
      } catch {
        // Ignore close errors
      }
    }

    // Call deactivate if provided
    if (record.module.deactivate) {
      try {
        await record.module.deactivate();
      } catch {
        // Ignore deactivation errors
      }
    }

    this.extensions.delete(name);
  }

  /**
   * Shut down all extensions.
   */
  async deactivateAll(): Promise<void> {
    const names = Array.from(this.extensions.keys());
    for (const name of names) {
      await this.deactivate(name);
    }
  }

  /** Get all tools from all extensions (for ToolRegistry registration) */
  getAllTools(): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
    const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];
    for (const record of this.extensions.values()) {
      tools.push(...record.tools);
    }
    return tools;
  }

  /** Get all slash commands from all extensions */
  getAllCommands(): SlashCommand[] {
    const commands: SlashCommand[] = [];
    for (const record of this.extensions.values()) {
      commands.push(...record.commands);
    }
    return commands;
  }

  /** Get all system prompt additions from all extensions */
  getAllPromptSections(): string[] {
    const sections: string[] = [];
    for (const record of this.extensions.values()) {
      sections.push(...record.promptSections);
    }
    return sections;
  }

  /** Get summary of all loaded extensions (for /extensions command) */
  getExtensionSummaries(): ExtensionSummary[] {
    return Array.from(this.extensions.values()).map((r) => ({
      name: r.manifest.name,
      displayName: r.manifest.displayName,
      version: r.manifest.version,
      source: r.manifest.source,
      tools: r.tools.length,
      commands: r.commands.length,
      hasPrompt: r.promptSections.length > 0,
      webUIs: r.webServers.map((s) => s.url),
    }));
  }

  /** Check if any extensions are loaded */
  hasExtensions(): boolean {
    return this.extensions.size > 0;
  }

  /**
   * Start a static file HTTP server for an extension's web UI.
   * Binds to 127.0.0.1 only for security.
   */
  private async startWebServer(
    options: WebUIOptions,
    extensionName: string
  ): Promise<WebUIHandle> {
    const server: Server = createServer(async (req, res) => {
      // CORS headers for local development
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlPath = req.url === '/' ? '/index.html' : (req.url || '/index.html');
      // Strip query string
      const cleanPath = urlPath.split('?')[0];
      const filePath = join(options.staticDir, cleanPath);

      try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    const port = options.port || 0; // 0 = OS picks a free port
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve)
    );

    const addr = server.address();
    const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
    const url = `http://127.0.0.1:${assignedPort}`;

    if (this.verbose) {
      console.log(`[ext:${extensionName}] Web UI at ${url}`);
    }

    return {
      url,
      port: assignedPort,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
}
