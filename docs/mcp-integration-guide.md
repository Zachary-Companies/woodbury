# MCP Intelligence Integration Guide

How Woodbury connects to external AI agents (Claude Code, Codex) via MCP, and how to add a new one.

---

## Architecture Overview

```
~/.woodbury/mcp-servers.json        Config: which servers to spawn
        |
        v
  McpClientManager.connectAll()     Spawns each server as a child process (stdio)
        |
        v
  client.listTools()               Discovers tools from each server
        |
        v
  convertTool()                    Wraps each tool as a Woodbury ToolDefinition + handler
        |                          Naming: mcp__<serverName>__<toolName>
        v
  agent-factory.ts                 Registers MCP tools alongside built-in + extension tools
        |
        v
  system-prompt.ts                 Adds "MCP Intelligence Servers" section listing all tools
        |
        v
  Agent sees all tools uniformly   Can call mcp__claude-code__Agent, mcp__intelligence__explain, etc.
```

---

## Existing Files (DO NOT modify — just reference)

### 1. `~/.woodbury/mcp-servers.json` — Server Config

```json
{
  "servers": [
    {
      "name": "intelligence",
      "command": "node",
      "args": ["/Users/andrewporter/Documents/GitHub/woodbury-intelligence/dist/index.js"],
      "enabled": true
    },
    {
      "name": "claude-code",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/claude-code", "mcp", "serve"],
      "enabled": true
    }
  ]
}
```

**Schema:**
```typescript
interface McpServerConfig {
  name: string;       // Used as tool prefix: mcp__<name>__<toolName>
  command: string;    // Binary to spawn (node, npx, etc.)
  args: string[];     // Command arguments
  env?: Record<string, string>;  // Extra env vars for the process
  enabled?: boolean;  // Default: true. Set false to skip.
}
```

**File:** `src/mcp-config.ts` — `loadMcpConfig()` reads this file, returns `McpServerConfig[]`.

### 2. `src/mcp-client-manager.ts` — Client Lifecycle

```typescript
class McpClientManager {
  // Spawns each server, performs MCP handshake, discovers tools
  async connectAll(configs: McpServerConfig[]): Promise<void>;

  // Returns all discovered tools in Woodbury's format
  getAllTools(): Array<{ definition: ToolDefinition; handler: ToolHandler }>;

  // Connection info for system prompt
  getConnectionSummaries(): McpConnectionSummary[];

  // Cleanup — kills child processes
  async disconnectAll(): Promise<void>;
}
```

**Tool conversion** (`convertTool`):
- **Name:** `mcp__${serverName}__${mcpTool.name}`
- **Description:** `[MCP: ${serverName}] ${mcpTool.description}`
- **Parameters:** MCP JSON Schema passed through directly
- **Handler:** Wraps `client.callTool()`, extracts text content from MCP response

### 3. `src/agent-factory.ts` — Registration

Both `createAgent()` and `createClosureAgent()` accept an optional `mcpClientManager` parameter. After extension tools are registered, MCP tools are registered the same way:

```typescript
if (mcpClientManager) {
  const mcpTools = mcpClientManager.getAllTools();
  for (const { definition, handler } of mcpTools) {
    toolRegistry.register(definition, handler);
  }
}
```

MCP server info is also passed to the system prompt builder so the agent knows what's available.

### 4. `src/system-prompt.ts` — Agent Awareness

The `buildSystemPrompt()` function accepts `mcpServers?: McpServerInfo[]` and generates an "MCP Intelligence Servers" section listing all connected servers and their tools with usage guidance.

### 5. `src/repl.ts` — Initialization

In `ensureAgent()`:
```typescript
const mcpConfigs = loadMcpConfig();
if (mcpConfigs.length > 0) {
  this.mcpClientManager = new McpClientManager();
  await this.mcpClientManager.connectAll(mcpConfigs);
}
// Pass to createAgent/createClosureAgent as 3rd arg
```

On shutdown: `await this.mcpClientManager.disconnectAll()`

---

## How Claude Code's Integration Works (Reference)

Claude Code runs as an MCP server via `npx -y @anthropic-ai/claude-code mcp serve`.

**What it exposes:** 18 tools including Agent, Bash, Read, Edit, Write, Grep, Glob, WebSearch, WebFetch, etc.

**Config entry:**
```json
{
  "name": "claude-code",
  "command": "npx",
  "args": ["-y", "@anthropic-ai/claude-code", "mcp", "serve"],
  "enabled": true
}
```

**How Woodbury uses it:**
- Tools appear as `mcp__claude-code__Agent`, `mcp__claude-code__Bash`, etc.
- The agent can delegate complex sub-tasks to `mcp__claude-code__Agent`
- File operations go through `mcp__claude-code__Read`, `mcp__claude-code__Edit`, etc.
- All tool calls are proxied through the MCP client — Woodbury sends JSON-RPC, Claude Code executes and returns results

**Integration test (verified working):**
```javascript
import { McpClientManager } from './dist/mcp-client-manager.js';

const manager = new McpClientManager();
await manager.connectAll([{
  name: 'claude-code',
  command: 'npx',
  args: ['-y', '@anthropic-ai/claude-code', 'mcp', 'serve'],
}]);

// Result: 18 tools registered, tool calls work (e.g., Read returns file content)
```

---

## What Codex Needs to Implement

Codex CLI supports MCP server mode via `codex mcp-server` (NOT `codex mcp serve`). It exposes `codex()` and `codex-reply()` tools over stdio.

### Step 1: Add Config Entry

Add to `~/.woodbury/mcp-servers.json`:

```json
{
  "name": "codex",
  "command": "npx",
  "args": ["-y", "@openai/codex", "mcp-server"],
  "enabled": true
}
```

**That's it for config.** The McpClientManager will automatically:
1. Spawn the process
2. Perform the MCP initialize handshake
3. Call `tools/list` to discover available tools
4. Convert each tool to `mcp__codex__<toolName>` format
5. Register handlers that proxy `callTool` through the MCP client

### Step 2: Verify Tool Discovery

Run this test to confirm Codex's MCP server works with the client manager:

```javascript
import { McpClientManager } from '/path/to/woodbury/dist/mcp-client-manager.js';

const manager = new McpClientManager();
await manager.connectAll([{
  name: 'codex',
  command: 'npx',
  args: ['-y', '@openai/codex', 'mcp-server'],
}]);

const summaries = manager.getConnectionSummaries();
console.log(summaries);
// Expected: { name: 'codex', toolCount: N, toolNames: ['mcp__codex__codex', 'mcp__codex__codex-reply', ...], connected: true }

await manager.disconnectAll();
```

### Step 3: Update System Prompt Guidance (Optional)

If Codex tools have different semantics than Claude Code tools, update the MCP Intelligence Servers section in `src/system-prompt.ts` (around line 1034) to add Codex-specific guidance:

```typescript
// In the MCP Intelligence Servers section, after the existing guidance:
- \`mcp__codex__*\` tools: Use to delegate coding tasks to OpenAI Codex.
  \`mcp__codex__codex\` starts a new conversation, \`mcp__codex__codex-reply\` continues one.
```

### Step 4: Test End-to-End

After adding the config entry, start Woodbury normally. The REPL's `ensureAgent()` will:
1. Load `mcp-servers.json` (now includes codex)
2. Connect to all 3 servers (intelligence, claude-code, codex)
3. Register all tools (6 + 18 + N from codex)
4. Add all server info to the system prompt

The agent will see Codex tools alongside everything else.

---

## What Already Exists (No Rework Needed)

| Component | Status | Location |
|-----------|--------|----------|
| MCP config loader | Done | `src/mcp-config.ts` |
| MCP client manager | Done | `src/mcp-client-manager.ts` |
| Tool conversion (MCP -> Woodbury) | Done | `McpClientManager.convertTool()` |
| Agent factory wiring | Done | `src/agent-factory.ts` |
| System prompt MCP section | Done | `src/system-prompt.ts` |
| V3 system prompt passthrough | Done | `src/loop/v3/system-prompt-v3.ts` |
| REPL initialization | Done | `src/repl.ts` |
| Dashboard initialization | Done | `src/config-dashboard.ts` |
| Shutdown/cleanup | Done | REPL + dashboard both call `disconnectAll()` |
| `@modelcontextprotocol/sdk` dependency | Done | `package.json` |
| Intelligence MCP server | Done | `woodbury-intelligence/` (6 AI tools) |
| Claude Code MCP integration | Done | Config + verified working |

**Codex only needs:**
1. One JSON entry in `~/.woodbury/mcp-servers.json`
2. (Optional) System prompt guidance for Codex-specific tools
3. Verification that `codex mcp-server` responds to the standard MCP handshake

---

## MCP Protocol Reference (for debugging)

The MCP handshake over stdio:

```
Client -> Server: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"woodbury","version":"1.0.0"}}}
Server -> Client: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{...}}}
Client -> Server: {"jsonrpc":"2.0","method":"notifications/initialized"}
Client -> Server: {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
Server -> Client: {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

Tool calls:
```
Client -> Server: {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"toolName","arguments":{...}}}
Server -> Client: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"result"}]}}
```

The `@modelcontextprotocol/sdk` Client handles all of this. `StdioClientTransport` spawns the child process and pipes stdin/stdout.

---

## Provider Architecture (woodbury-intelligence)

If Codex wants to add itself as a provider in the intelligence server (for AI-powered generation alongside Anthropic/OpenAI):

**File:** `woodbury-intelligence/src/providers/types.ts`
```typescript
interface IntelligenceProvider {
  name: string;
  generate(prompt: string, systemPrompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}
```

**To add a new provider:**
1. Create `woodbury-intelligence/src/providers/codex.ts` implementing `IntelligenceProvider`
2. In `woodbury-intelligence/src/router.ts`, add detection logic:
   ```typescript
   if (process.env.CODEX_API_KEY) {
     const provider = new CodexProvider(process.env.CODEX_API_KEY);
     this.providers.set('codex', provider);
   }
   ```
3. The router's `generate()` method routes to the selected provider

**Existing providers:**
- `AnthropicProvider` — uses `@anthropic-ai/sdk`, model `claude-sonnet-4-20250514`
- `OpenAIProvider` — uses `openai` SDK, model `gpt-4o`

The intelligence server and the Codex MCP server are independent integrations. The intelligence server wraps AI APIs for structured generation (pipelines, workflows). The Codex MCP server exposes Codex's full agentic capabilities (code editing, file ops, etc.).
