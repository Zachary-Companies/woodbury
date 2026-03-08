/**
 * MCP Client Manager
 *
 * Manages connections to MCP servers, discovers their tools,
 * and converts them to Woodbury's ToolDefinition format so agents
 * can use them transparently alongside built-in tools.
 *
 * Each MCP server is spawned as a child process using stdio transport.
 * Tools are prefixed with mcp__<serverName>__<toolName>.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition, ToolHandler } from './loop/types.js';
import type { McpServerConfig } from './mcp-config.js';
import { debugLog } from './debug-log.js';

interface McpConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
}

export interface McpConnectionSummary {
  name: string;
  toolCount: number;
  toolNames: string[];
  connected: boolean;
}

export class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private registeredTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];
  private failedServers: Map<string, string> = new Map(); // name → error message

  /**
   * Connect to all configured MCP servers.
   * Errors on individual servers are caught — one failing server won't block others.
   */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    if (configs.length === 0) {
      debugLog.debug('mcp-client', 'No MCP servers configured');
      return;
    }

    debugLog.info('mcp-client', `Connecting to ${configs.length} MCP server(s)`);

    for (const config of configs) {
      try {
        await this.connect(config);
        this.failedServers.delete(config.name);
      } catch (err: any) {
        debugLog.error('mcp-client', `Failed to connect to MCP server "${config.name}"`, {
          error: err.message,
          command: config.command,
          args: config.args,
        });
        this.failedServers.set(config.name, err.message);
        console.error(`[mcp] Failed to connect to "${config.name}": ${err.message}`);
      }
    }

    debugLog.info('mcp-client', 'MCP connections complete', {
      connected: this.connections.size,
      failed: this.failedServers.size,
      totalTools: this.registeredTools.length,
    });
  }

  /**
   * Connect to a single MCP server and discover its tools.
   */
  private async connect(config: McpServerConfig): Promise<void> {
    debugLog.info('mcp-client', `Connecting to "${config.name}"`, {
      command: config.command,
      args: config.args,
    });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });

    const client = new Client({
      name: 'woodbury',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const mcpTools = toolsResult.tools || [];

    debugLog.info('mcp-client', `"${config.name}" connected — ${mcpTools.length} tool(s)`, {
      tools: mcpTools.map((t) => t.name),
    });

    const toolNames: string[] = [];

    for (const mcpTool of mcpTools) {
      const { definition, handler } = this.convertTool(config.name, mcpTool, client);
      this.registeredTools.push({ definition, handler });
      toolNames.push(definition.name);
    }

    this.connections.set(config.name, {
      name: config.name,
      client,
      transport,
      toolNames,
    });
  }

  /**
   * Connect a single server by config. Public wrapper around connect().
   * If already connected, disconnects first.
   */
  async connectOne(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      await this.disconnectOne(config.name);
    }
    await this.connect(config);
    this.failedServers.delete(config.name);
  }

  /**
   * Disconnect a single server by name.
   */
  async disconnectOne(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    try {
      debugLog.debug('mcp-client', `Disconnecting from "${name}"`);
      await conn.client.close();
    } catch {
      // Ignore close errors
    }

    // Remove this server's tools from the registered list
    const toolSet = new Set(conn.toolNames);
    this.registeredTools = this.registeredTools.filter((t) => !toolSet.has(t.definition.name));
    this.connections.delete(name);
    debugLog.info('mcp-client', `Disconnected from "${name}"`);
  }

  /**
   * Get the connection status of a specific server.
   */
  getConnectionStatus(name: string): 'connected' | 'disconnected' | 'failed' {
    if (this.connections.has(name)) return 'connected';
    if (this.failedServers.has(name)) return 'failed';
    return 'disconnected';
  }

  /**
   * Get the error message for a failed server.
   */
  getFailureReason(name: string): string | undefined {
    return this.failedServers.get(name);
  }

  /**
   * Get the number of failed servers.
   */
  getFailedCount(): number {
    return this.failedServers.size;
  }

  /**
   * Convert an MCP tool to a Woodbury ToolDefinition + ToolHandler pair.
   */
  private convertTool(
    serverName: string,
    mcpTool: { name: string; description?: string; inputSchema?: any },
    client: Client
  ): { definition: ToolDefinition; handler: ToolHandler } {
    const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;

    const definition: ToolDefinition = {
      name: qualifiedName,
      description: `[MCP: ${serverName}] ${mcpTool.description || mcpTool.name}`,
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    };

    const handler: ToolHandler = async (params: any, context?: any) => {
      try {
        // Use context timeout if available, otherwise 120s for MCP tools
        const timeoutMs = context?.timeoutMs || 120000;
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: params || {},
        }, undefined, { timeout: timeoutMs });

        // Extract text content from MCP response
        const content = result.content as Array<{ type: string; text?: string }>;
        if (!Array.isArray(content)) {
          return String(result.content);
        }

        const textParts = content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!);

        if (textParts.length === 0) {
          return 'Tool completed with no text output.';
        }

        return textParts.join('\n');
      } catch (err: any) {
        debugLog.error('mcp-client', `MCP tool call failed: ${qualifiedName}`, {
          error: err.message,
        });
        return `MCP tool error: ${err.message}`;
      }
    };

    return { definition, handler };
  }

  /**
   * Get all MCP tools in Woodbury's format (same shape as ExtensionManager.getAllTools()).
   */
  getAllTools(): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
    return this.registeredTools;
  }

  /**
   * Disconnect from all MCP servers and clean up child processes.
   */
  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        debugLog.debug('mcp-client', `Disconnecting from "${name}"`);
        await conn.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections.clear();
    this.registeredTools = [];
    debugLog.info('mcp-client', 'All MCP connections closed');
  }

  /**
   * Get connection summaries for display.
   */
  getConnectionSummaries(): McpConnectionSummary[] {
    return Array.from(this.connections.values()).map((conn) => ({
      name: conn.name,
      toolCount: conn.toolNames.length,
      toolNames: conn.toolNames,
      connected: true,
    }));
  }

  /**
   * Check if any MCP servers are connected.
   */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }
}
