/**
 * MCP Server Configuration
 *
 * Loads MCP server definitions from ~/.woodbury/mcp-servers.json.
 * Each server is spawned as a child process using stdio transport.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { debugLog } from './debug-log.js';

export interface McpServerConfig {
  /** Display name — used in tool prefix: mcp__<name>__<tool> */
  name: string;
  /** Command to spawn (e.g. "node", "claude") */
  command: string;
  /** Command arguments (e.g. ["mcp", "serve"]) */
  args: string[];
  /** Extra environment variables to pass to the process */
  env?: Record<string, string>;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
}

interface McpConfigFile {
  servers: McpServerConfig[];
}

const CONFIG_PATH = path.join(os.homedir(), '.woodbury', 'mcp-servers.json');

/**
 * Load all MCP server configurations from ~/.woodbury/mcp-servers.json.
 * Returns ALL servers including disabled ones.
 */
export function loadAllMcpConfig(): McpServerConfig[] {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      debugLog.debug('mcp-config', 'No mcp-servers.json found (this is fine)');
      return [];
    }

    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed: McpConfigFile = JSON.parse(content);

    if (!Array.isArray(parsed.servers)) {
      debugLog.warn('mcp-config', 'mcp-servers.json missing "servers" array');
      return [];
    }

    return parsed.servers.filter((s) => s.name && s.command);
  } catch (err) {
    debugLog.warn('mcp-config', `Failed to load mcp-servers.json: ${err}`);
    return [];
  }
}

/**
 * Load enabled MCP server configurations from ~/.woodbury/mcp-servers.json.
 * Returns only servers where enabled !== false.
 */
export function loadMcpConfig(): McpServerConfig[] {
  const all = loadAllMcpConfig();
  const servers = all.filter((s) => {
    if (s.enabled === false) {
      debugLog.debug('mcp-config', `Skipping disabled MCP server: ${s.name}`);
      return false;
    }
    return true;
  });

  debugLog.info('mcp-config', `Loaded ${servers.length} MCP server config(s)`, {
    servers: servers.map((s) => s.name),
  });

  return servers;
}

/**
 * Save MCP server configurations to ~/.woodbury/mcp-servers.json.
 */
export function saveMcpConfig(configs: McpServerConfig[]): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify({ servers: configs }, null, 2) + '\n';
    fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
    debugLog.info('mcp-config', `Saved ${configs.length} MCP server config(s)`);
  } catch (err) {
    debugLog.error('mcp-config', `Failed to save mcp-servers.json: ${err}`);
    throw err;
  }
}
