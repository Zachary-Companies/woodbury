import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { createLogger, Logger } from '../../logger.js';
import { debugLog } from '../../../debug-log.js';
import {
  resolveOllamaBaseUrl,
  isOllamaModel,
  getOllamaModelName,
} from '../../ollama-discovery.js';

export type AdapterProvider = 'openai' | 'anthropic' | 'groq' | 'ollama';

const logger = createLogger();

interface BaseMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

interface ProviderResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

// Helper function to convert content to string
function contentToString(content: string | any[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // Handle array content (e.g., from Anthropic messages with multiple blocks)
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) return item.text;
      return JSON.stringify(item);
    }).join(' ');
  }
  return String(content);
}

/**
 * Convert the agent's Anthropic-shaped message blocks into OpenAI chat messages.
 *
 * AgentV2 records tool use as content blocks: an assistant message holding
 * `tool_use` blocks, then a *user* message holding `tool_result` blocks. Passing
 * those through contentToString() flattens each block to `JSON.stringify(block)`,
 * so an OpenAI-compatible provider never sees a real tool call — it sees a JSON
 * blob in prose, loses the tool_call_id linkage, and cannot continue the loop.
 * This maps them onto the native shape instead.
 */
export function toOpenAIChatMessages(
  messages: BaseMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : null;

    if (blocks) {
      const toolUses = blocks.filter((b: any) => b && b.type === 'tool_use');
      const toolResults = blocks.filter((b: any) => b && b.type === 'tool_result');
      const text = blocks
        .filter((b: any) => !b || (b.type !== 'tool_use' && b.type !== 'tool_result'))
        .map((b: any) => (typeof b === 'string' ? b : b && 'text' in b ? b.text : ''))
        .filter(Boolean)
        .join(' ');

      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((b: any) => ({
            id: b.id,
            type: 'function' as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })),
        } as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }

      if (toolResults.length > 0) {
        // Each tool_result becomes its own `tool` message keyed by tool_call_id.
        // These must come FIRST: the API requires the tool messages to directly
        // follow the assistant message carrying their tool_calls, so any stray
        // text in this turn is emitted after them, not between.
        for (const b of toolResults as any[]) {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
          });
        }
        if (text) out.push({ role: 'user', content: text });
        continue;
      }
    }

    out.push({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: contentToString(msg.content),
    } as OpenAI.Chat.ChatCompletionMessageParam);
  }

  return out;
}

export class ProviderAdapter {
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private groqClient?: Groq;
  private ollamaClient?: OpenAI;       // Ollama uses the OpenAI SDK with its own baseURL
  private logger: Logger;

  constructor() {
    this.logger = createLogger();
  }

  async createCompletion(options: {
      provider: AdapterProvider;
      model: string;
      messages: BaseMessage[];
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
  }): Promise<ProviderResponse> {
      return this.sendMessage(
          options.provider,
          options.model,
          options.messages,
          {
              maxTokens: options.maxTokens,
              temperature: options.temperature,
              tools: options.tools
          }
      );
  }

  private getOpenAIClient(): OpenAI {
    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this.openaiClient;
  }

  private getAnthropicClient(): Anthropic {
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    }
    return this.anthropicClient;
  }

  private getGroqClient(): Groq {
    if (!this.groqClient) {
      this.groqClient = new Groq({
        apiKey: process.env.GROQ_API_KEY
      });
    }
    return this.groqClient;
  }

  /**
   * Get (and cache) an OpenAI SDK instance pointed at the discovered Ollama
   * endpoint. Ollama's /v1 API is OpenAI-compatible so the same SDK works.
   */
  private async getOllamaClient(): Promise<OpenAI> {
    if (this.ollamaClient) return this.ollamaClient;
    const baseURL = await resolveOllamaBaseUrl();
    if (!baseURL) {
      throw new Error('No Ollama server found. Set OLLAMA_BASE_URL or run an Ollama server reachable via mDNS.');
    }
    const normalized = /\/v1\/?$/.test(baseURL) ? baseURL : `${baseURL.replace(/\/$/, '')}/v1`;
    this.ollamaClient = new OpenAI({
      apiKey: 'ollama',                // Ollama ignores the key but the SDK requires a non-empty string
      baseURL: normalized,
    });
    return this.ollamaClient;
  }

  async sendMessage(
    provider: AdapterProvider,
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      stream?: boolean;
    } = {}
  ): Promise<ProviderResponse> {
    switch (provider) {
      case 'openai':
        return this.sendOpenAIMessage(model, messages, options);
      case 'anthropic':
        return this.sendAnthropicMessage(model, messages, options);
      case 'groq':
        return this.sendGroqMessage(model, messages, options);
      case 'ollama':
        return this.sendOllamaMessage(model, messages, options);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  // Ollama is OpenAI-compatible — same call shape, different client + strip the `ollama/` prefix.
  private async sendOllamaMessage(
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      stream?: boolean;
    }
  ): Promise<ProviderResponse> {
    const client = await this.getOllamaClient();
    const resolvedModel = isOllamaModel(model) ? getOllamaModelName(model) : model;

    const ollamaMessages = toOpenAIChatMessages(messages);

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: resolvedModel,
      messages: ollamaMessages,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature ?? 0.1,
    };

    // Ollama supports OpenAI-style function calling on most recent builds; pass tools through
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
    }

    const response = await client.chat.completions.create(requestParams);
    const choice = response.choices[0];
    const message = choice.message;

    const toolCalls: ToolCall[] = [];
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if ((tc as any).type === 'function') {
          const fn = (tc as any).function;
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(fn.arguments || '{}'); } catch { /* malformed — leave empty */ }
          toolCalls.push({ id: tc.id, name: fn.name, input });
        }
      }
    }

    return {
      content: message.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: choice.finish_reason || 'stop',
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  private async sendOpenAIMessage(
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      stream?: boolean;
    }
  ): Promise<ProviderResponse> {
    const client = this.getOpenAIClient();

    const openaiMessages = toOpenAIChatMessages(messages);

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: openaiMessages,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.1
    };

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }));
    }

    const response = await client.chat.completions.create(requestParams);
    const choice = response.choices[0];

    let toolCalls: ToolCall[] = [];
    if (choice.message.tool_calls) {
      toolCalls = choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments)
      }));
    }

    return {
      content: choice.message.content || '',
      toolCalls,
      stopReason: choice.finish_reason || undefined,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }

  private async sendAnthropicMessage(
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      stream?: boolean;
    }
  ): Promise<ProviderResponse> {
    const client = this.getAnthropicClient();

    // Separate system message from conversation messages
    let systemMessage = '';
    const conversationMessages: Array<{ role: 'user' | 'assistant'; content: any }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
        systemMessage += (systemMessage ? '\n\n' : '') + contentToString(message.content);
      } else {
        // Pass content arrays through directly (needed for tool_use/tool_result blocks)
        // Only convert to string if content is a plain string
        const content = Array.isArray(message.content)
          ? message.content
          : contentToString(message.content);
        conversationMessages.push({
          role: message.role as 'user' | 'assistant',
          content
        });
      }
    }

    const requestParams: Anthropic.MessageCreateParams = {
      model,
      messages: conversationMessages,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.1,
      system: systemMessage || undefined
    };

    // Pass tools to Anthropic API — NativeToolDefinition matches the SDK format
    if (options.tools && options.tools.length > 0) {
      (requestParams as any).tools = options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema
      }));
      debugLog.info('provider-adapter', 'Anthropic request prepared', {
        model,
        toolCount: options.tools.length,
        systemPromptLength: systemMessage.length,
        messageCount: conversationMessages.length,
      });
    }

    // Use streaming to avoid "Streaming is required for operations that may
    // take longer than 10 minutes" errors with large maxTokens values.
    const stream = client.messages.stream(requestParams);
    const response = await stream.finalMessage();

    debugLog.info('provider-adapter', 'Anthropic response received', {
      stopReason: response.stop_reason,
      contentBlockCount: Array.isArray(response.content) ? response.content.length : 1,
      contentTypes: Array.isArray(response.content)
        ? response.content.map((b: any) => b.type).join(', ')
        : 'string',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    let content = '';
    const toolCalls: ToolCall[] = [];

    // Handle different content block types
    if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>
          });
        }
      }
    } else if (typeof response.content === 'string') {
      content = response.content;
    }

    return {
      content,
      toolCalls,
      stopReason: response.stop_reason || undefined,
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      } : undefined
    };
  }

  private async sendGroqMessage(
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      stream?: boolean;
    }
  ): Promise<ProviderResponse> {
    const client = this.getGroqClient();

    const groqMessages = messages.map(msg => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: contentToString(msg.content)
    }));

    const requestParams = {
      model,
      messages: groqMessages,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.1
    };

    // Note: Groq may have limited tool support depending on the model
    if (options.tools && options.tools.length > 0) {
      this.logger.warn('Tool calling support for Groq may be limited');
    }

    const response = await client.chat.completions.create(requestParams);
    const choice = response.choices[0];

    return {
      content: choice.message.content || '',
      toolCalls: [], // Tool calling not implemented for Groq yet
      stopReason: choice.finish_reason || undefined,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }

  async streamMessage(
    provider: AdapterProvider,
    model: string,
    messages: BaseMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
    } = {},
    onChunk: (chunk: string) => void
  ): Promise<ProviderResponse> {
    // For now, fall back to non-streaming
    // Streaming implementation would be more complex and provider-specific
    this.logger.warn('Streaming not yet implemented, falling back to regular message');
    return this.sendMessage(provider, model, messages, { ...options, stream: false });
  }
}

export const providerAdapter = new ProviderAdapter();
export const createProviderAdapter = () => new ProviderAdapter();
export function detectProvider(model?: string): AdapterProvider {
  if (!model) return 'openai';
  if (model.startsWith('ollama/')) return 'ollama';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('llama') || model.startsWith('mixtral')) return 'groq';
  return 'openai';
}
