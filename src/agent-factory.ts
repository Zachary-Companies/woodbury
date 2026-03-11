import { Agent, createDefaultToolRegistry, AgentConfig } from './loop/index.js';
import type { AgentResult } from './types';
import { WoodburyLogger } from './logger';
import type { WoodburyConfig } from './types';
import { buildSystemPrompt, type McpServerInfo } from './system-prompt.js';
import { ensureBridgeServer, bridgeServer } from './bridge-server.js';
import type { ExtensionManager } from './extension-manager.js';
import type { McpClientManager } from './mcp-client-manager.js';
import { debugLog } from './debug-log.js';

// V3 Closure Engine imports
import { ClosureEngine } from './loop/v3/closure-engine.js';
import { createAgentHandleBridge } from './loop/v3/agent-handle-bridge.js';
import { buildV3SystemPrompt } from './loop/v3/system-prompt-v3.js';
import { ToolRegistryV2 } from './loop/v2/tools/registry-v2.js';
import { convertAllTools } from './loop/v2/tools/native-converter.js';
import type { ClosureEngineConfig } from './loop/v3/types.js';

export interface AgentHandle {
  run(input: string, signal?: AbortSignal): Promise<AgentResult>;
  getTools(): string[];
  stop(): Promise<void>;
  setOnToken(callback: ((token: string) => void) | undefined): void;
  setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void;
  setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void;
  setOnPhaseChange?(callback: ((from: string, to: string) => void) | undefined): void;
  setOnTaskStart?(callback: ((task: any) => void) | undefined): void;
  setOnTaskEnd?(callback: ((task: any, result: any) => void) | undefined): void;
  setOnBeliefUpdate?(callback: ((belief: any) => void) | undefined): void;
  setOnReflection?(callback: ((reflection: any) => void) | undefined): void;
  setOnSkillSelected?(callback: ((selection: any) => void) | undefined): void;
  setOnRecovery?(callback: ((event: any) => void) | undefined): void;
}

export { type AgentResult } from './types';

export async function createAgent(
  config: WoodburyConfig,
  extensionManager?: ExtensionManager,
  mcpClientManager?: McpClientManager,
): Promise<AgentHandle> {
  const logger = new WoodburyLogger(config.verbose || false);

  try {
    // Create tool registry
    const doneRegistry = debugLog.time('agent', 'Creating tool registry');
    const toolRegistry = createDefaultToolRegistry();
    doneRegistry();

    const defaultToolCount = toolRegistry.getAll?.()?.length || 0;
    debugLog.info('agent', 'Default tools registered', { count: defaultToolCount });

    // Register extension tools
    if (extensionManager) {
      const extTools = extensionManager.getAllTools();
      debugLog.info('agent', `Registering ${extTools.length} extension tool(s)`);
      for (const { definition, handler } of extTools) {
        try {
          toolRegistry.register(definition, handler);
          debugLog.debug('agent', `Registered extension tool: ${definition.name}`);
        } catch (err) {
          debugLog.error('agent', `Extension tool "${definition.name}" registration failed`, { error: String(err) });
          logger.warn(`Extension tool "${definition.name}" registration failed: ${err}`);
        }
      }
    }

    // Register MCP tools
    if (mcpClientManager) {
      const mcpTools = mcpClientManager.getAllTools();
      debugLog.info('agent', `Registering ${mcpTools.length} MCP tool(s)`);
      for (const { definition, handler } of mcpTools) {
        try {
          toolRegistry.register(definition, handler);
          debugLog.debug('agent', `Registered MCP tool: ${definition.name}`);
        } catch (err) {
          debugLog.error('agent', `MCP tool "${definition.name}" registration failed`, { error: String(err) });
        }
      }
    }

    // Start the bridge server for Chrome extension communication (non-blocking)
    debugLog.debug('agent', 'Starting bridge server (non-blocking)');
    ensureBridgeServer().catch((err) => {
      debugLog.warn('agent', 'Bridge server failed to start', { error: String(err) });
    });

    // Build the comprehensive system prompt with project context + extension prompts + MCP info
    const workingDirectory = config.workingDirectory || process.cwd();
    const extensionPrompts = extensionManager?.getAllPromptSections();
    const mcpServers: McpServerInfo[] | undefined = mcpClientManager
      ? mcpClientManager.getConnectionSummaries().map((s) => ({ name: s.name, toolNames: s.toolNames }))
      : undefined;
    const donePrompt = debugLog.time('agent', 'Building system prompt');
    const systemPrompt = await buildSystemPrompt(workingDirectory, config.contextDir, extensionPrompts, mcpServers);
    donePrompt();
    debugLog.info('agent', 'System prompt built', {
      length: systemPrompt.length,
      extensionPromptCount: extensionPrompts?.length || 0,
      mcpServerCount: mcpServers?.length || 0,
    });

    // Configure agent
    const provider = getProvider(config);
    const apiKey = provider === 'claude-code' ? '' : (config.apiKeys?.[provider] || '');
    const agentConfig: AgentConfig = {
      name: 'woodbury-agent',
      provider,
      model: config.model || getDefaultModel(provider),
      apiKey,
      maxIterations: config.maxIterations || 1000,
      timeout: config.timeout || 300000,
      temperature: 0.1,
      workingDirectory,
      allowDangerousTools: !config.safe,
      systemPrompt,
      streaming: config.stream !== false
    };

    debugLog.info('agent', 'Agent config', {
      provider: agentConfig.provider,
      model: agentConfig.model,
      maxIterations: agentConfig.maxIterations,
      timeout: agentConfig.timeout,
      streaming: agentConfig.streaming,
      allowDangerousTools: agentConfig.allowDangerousTools,
      hasApiKey: !!apiKey,
    });

    // Create agent with config and tool registry
    const agent = new Agent(agentConfig, toolRegistry);
    debugLog.info('agent', 'Agent created successfully');

    return {
      setOnToken(callback: ((token: string) => void) | undefined): void {
        (agent as any).config.onToken = callback;
        (agent as any).config.streaming = !!callback;
        // Disable progress logger when streaming — its ANSI cursor movement
        // is incompatible with the REPL's scroll-region terminal layout.
        (agent as any).progressLogger.disabled = !!callback;
      },

      setOnToolStart(callback: ((name: string, params?: any) => void) | undefined): void {
        (agent as any).config.onToolStart = callback;
      },

      setOnToolEnd(callback: ((name: string, success: boolean, result?: string, duration?: number) => void) | undefined): void {
        (agent as any).config.onToolEnd = callback;
      },

      async run(input: string, signal?: AbortSignal): Promise<AgentResult> {
        try {
          const inputPreview = input.slice(0, 200) + (input.length > 200 ? '...' : '');
          debugLog.info('agent.run', 'Agent run starting', { inputLength: input.length, preview: inputPreview });
          logger.info(`Running agent with input: ${input.slice(0, 100)}...`);
          const startTime = Date.now();

          const result = await agent.run(input, signal);

          const endTime = Date.now();
          const elapsed = endTime - startTime;
          debugLog.info('agent.run', 'Agent run completed', {
            elapsed: `${elapsed}ms`,
            success: result.success,
            iterations: result.metadata?.iterations,
            toolCalls: result.toolCalls?.length || 0,
            contentLength: result.content?.length || 0,
          });
          logger.info(`Agent completed in ${elapsed}ms`);

          if (result.metadata) {
            logger.info(`Iterations: ${result.metadata.iterations}`);
          }

          return result;
        } catch (error) {
          debugLog.error('agent.run', 'Agent execution failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          logger.error('Agent execution failed:', error);
          throw error;
        }
      },
      
      getTools(): string[] {
        return agent.getAvailableTools();
      },
      
      async stop(): Promise<void> {
        // Stop the bridge server
        await bridgeServer.stop().catch(() => {});
        logger.info('Agent stopped');
      }
    };
  } catch (error) {
    logger.error('Failed to create agent:', error);
    throw error;
  }
}

/**
 * Create a V3 Closure Engine agent with native tool calling.
 * Uses the same AgentHandle interface for backward compatibility.
 */
export async function createClosureAgent(
  config: WoodburyConfig,
  extensionManager?: ExtensionManager,
  mcpClientManager?: McpClientManager,
): Promise<AgentHandle> {
  const logger = new WoodburyLogger(config.verbose || false);

  try {
    // Create V1 tool registry and get all tools
    const doneRegistry = debugLog.time('agent-v3', 'Creating tool registry');
    const v1Registry = createDefaultToolRegistry();
    doneRegistry();

    // Register extension tools on V1 registry
    if (extensionManager) {
      const extTools = extensionManager.getAllTools();
      debugLog.info('agent-v3', `Registering ${extTools.length} extension tool(s)`);
      for (const { definition, handler } of extTools) {
        try {
          v1Registry.register(definition, handler);
        } catch (err) {
          debugLog.error('agent-v3', `Extension tool "${definition.name}" registration failed`, { error: String(err) });
        }
      }
    }

    // Register MCP tools on V1 registry
    if (mcpClientManager) {
      const mcpTools = mcpClientManager.getAllTools();
      debugLog.info('agent-v3', `Registering ${mcpTools.length} MCP tool(s)`);
      for (const { definition, handler } of mcpTools) {
        try {
          v1Registry.register(definition, handler);
        } catch (err) {
          debugLog.error('agent-v3', `MCP tool "${definition.name}" registration failed`, { error: String(err) });
        }
      }
    }

    // Convert all V1 tools to native V2 format
    const doneConvert = debugLog.time('agent-v3', 'Converting tools to native format');
    const v1Tools = v1Registry.getAll?.() || [];
    const nativeTools = convertAllTools(v1Tools);
    doneConvert();

    // Create V2 tool registry with converted tools
    const v2Registry = new ToolRegistryV2({
      debug: () => {},
      info: () => {},
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
    });
    v2Registry.registerAll(nativeTools);
    debugLog.info('agent-v3', 'Tools registered in V2 registry', { count: nativeTools.length });

    // Start the bridge server (non-blocking)
    ensureBridgeServer().catch((err) => {
      debugLog.warn('agent-v3', 'Bridge server failed to start', { error: String(err) });
    });

    // Build V3 system prompt (strips XML instructions, adds native tool docs)
    const workingDirectory = config.workingDirectory || process.cwd();
    const extensionPrompts = extensionManager?.getAllPromptSections();
    const mcpServers: McpServerInfo[] | undefined = mcpClientManager
      ? mcpClientManager.getConnectionSummaries().map((s) => ({ name: s.name, toolNames: s.toolNames }))
      : undefined;
    const donePrompt = debugLog.time('agent-v3', 'Building V3 system prompt');
    const systemPrompt = await buildV3SystemPrompt(
      workingDirectory,
      config.contextDir,
      extensionPrompts,
      v2Registry.getAllDefinitions(),
      mcpServers,
    );
    donePrompt();
    debugLog.info('agent-v3', 'V3 system prompt built', { length: systemPrompt.length, mcpServerCount: mcpServers?.length || 0 });

    // Configure closure engine
    const provider = getProvider(config);
    if (provider === 'claude-code') {
      throw new Error('Closure Engine does not support claude-code provider. Use anthropic, openai, or groq.');
    }

    const engineConfig: ClosureEngineConfig = {
      provider,
      model: config.model || getDefaultModel(provider),
      sessionId: config.sessionId,
      continuationMode: config.continuationMode,
      maxIterations: config.maxIterations || 1000,
      maxTaskRetries: 3,
      timeout: config.timeout || 300000,
      toolTimeout: 30000,
      temperature: 0.1,
      workingDirectory,
      allowDangerousTools: !config.safe,
      streaming: config.stream !== false,
      reflectionInterval: 5,
      callbacks: {},
    };

    debugLog.info('agent-v3', 'Closure Engine config', {
      provider: engineConfig.provider,
      model: engineConfig.model,
      maxIterations: engineConfig.maxIterations,
      streaming: engineConfig.streaming,
    });

    // Create engine and bridge to AgentHandle
    const engine = new ClosureEngine(engineConfig, v2Registry, systemPrompt);
    const handle = createAgentHandleBridge(engine);
    debugLog.info('agent-v3', 'Closure Engine created successfully');

    // Wrap stop() to also stop bridge server
    const originalStop = handle.stop;
    handle.stop = async () => {
      await originalStop();
      await bridgeServer.stop().catch(() => {});
      logger.info('Closure Engine stopped');
    };

    return handle;
  } catch (error) {
    logger.error('Failed to create Closure Engine:', error);
    throw error;
  }
}

function getProvider(config: WoodburyConfig): 'openai' | 'anthropic' | 'groq' | 'claude-code' {
  // If explicitly specified, use it
  if (config.provider) {
    return config.provider;
  }

  // Auto-detect from available API keys
  if (config.apiKeys?.anthropic) {
    return 'anthropic';
  }
  if (config.apiKeys?.openai) {
    return 'openai';
  }
  if (config.apiKeys?.groq) {
    return 'groq';
  }

  // Default to Anthropic
  return 'anthropic';
}

function getDefaultModel(provider: 'openai' | 'anthropic' | 'groq' | 'claude-code'): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-4-5-20251101';
    case 'openai':
      return 'gpt-4';
    case 'groq':
      return 'llama-3.1-70b-versatile';
    case 'claude-code':
      return 'claude-sonnet-4-5-20250514';
    default:
      return 'claude-opus-4-5-20251101';
  }
}
