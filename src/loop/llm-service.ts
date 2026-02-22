import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LLMProvider = 'openai' | 'anthropic' | 'groq' | 'claude-code';

// Load API keys from .env files. Checks ~/.woodbury/.env first, falls back to ~/.agentic-loop/.env.
function loadEnvFile(envPath: string): void {
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();

          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }

          // Only set if not already in environment
          if (!process.env[key] && value && value !== 'your-openai-key-here' && value !== 'your-google-api-key') {
            process.env[key] = value;
          }
        }
      }
    }
  } catch (error) {
    // Silently ignore errors loading .env file
  }
}

// Load env on module initialization — ~/.woodbury/.env takes priority
loadEnvFile(path.join(os.homedir(), '.woodbury', '.env'));
loadEnvFile(path.join(os.homedir(), '.agentic-loop', '.env'));

// Bridge standard env var names to flow-frame-core's expected names.
// flow-frame-core uses OPEN_AI_KEY (not OPENAI_API_KEY) and GROK_API_KEY (not GROQ_API_KEY).
if (process.env.OPENAI_API_KEY && !process.env.OPEN_AI_KEY) {
  process.env.OPEN_AI_KEY = process.env.OPENAI_API_KEY;
}
if (process.env.GROQ_API_KEY && !process.env.GROK_API_KEY) {
  process.env.GROK_API_KEY = process.env.GROQ_API_KEY;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface RunPromptOptions {
  messages: ChatMessage[];
  tools?: any[];
  provider?: LLMProvider;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  apiKey?: string;
  baseURL?: string;
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onDone?: (response: LLMResponse) => void;
}

// Client cache to avoid recreating clients
const clientCache = new Map<string, OpenAI | Anthropic | Groq>();

function getOpenAIClient(apiKey?: string, baseURL?: string): OpenAI {
  const key = apiKey || process.env.OPENAI_API_KEY || '';
  const cacheKey = `openai:${key}:${baseURL || ''}`;

  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new OpenAI({
      apiKey: key,
      baseURL: baseURL || undefined
    }));
  }

  return clientCache.get(cacheKey) as OpenAI;
}

function getAnthropicClient(apiKey?: string): Anthropic {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  const cacheKey = `anthropic:${key}`;

  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new Anthropic({
      apiKey: key
    }));
  }

  return clientCache.get(cacheKey) as Anthropic;
}

function getGroqClient(apiKey?: string): Groq {
  const key = apiKey || process.env.GROQ_API_KEY || '';
  const cacheKey = `groq:${key}`;

  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, new Groq({
      apiKey: key
    }));
  }

  return clientCache.get(cacheKey) as Groq;
}

/**
 * Ensure conversation messages start with a user message (Anthropic API requirement).
 * If needed, synthesizes a context-aware placeholder rather than a generic "Hello".
 */
function ensureUserFirst(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) {
    // Empty conversation — synthesize a minimal user message
    return [{ role: 'user', content: '[Starting conversation]' }];
  }
  
  if (messages[0].role === 'user') {
    return messages;
  }
  
  // First message is 'assistant' — prepend a context placeholder
  // This should be rare; it usually means conversation state got corrupted
  return [
    { role: 'user', content: '[Continuing conversation]' },
    ...messages
  ];
}

// ── Streaming variants ─────────────────────────────────────

async function streamOpenAI(
  messages: ChatMessage[], model: string,
  callbacks: StreamCallbacks, options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const client = getOpenAIClient(options?.apiKey, options?.baseURL);
  const stream = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: options?.maxTokens || 4096,
    temperature: options?.temperature ?? 0.7,
    stream: true
  });

  let content = '';
  let usage: LLMResponse['usage'] | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      content += delta;
      callbacks.onToken?.(delta);
    }
    // OpenAI sends usage in the final chunk when stream_options.include_usage is set,
    // but for simplicity we estimate from the non-stream response later
  }

  const response: LLMResponse = { content, usage };
  callbacks.onDone?.(response);
  return response;
}

async function streamAnthropic(
  messages: ChatMessage[], model: string,
  callbacks: StreamCallbacks, options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const client = getAnthropicClient(options?.apiKey);
  const systemMessage = messages.find(m => m.role === 'system');
  let conversationMessages = messages.filter(m => m.role !== 'system');

  // Ensure first message is from user (Anthropic requirement)
  conversationMessages = ensureUserFirst(conversationMessages);

  const stream = client.messages.stream({
    model,
    max_tokens: options?.maxTokens || 4096,
    system: systemMessage?.content || undefined,
    messages: conversationMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))
  });

  let content = '';

  stream.on('text', (text: string) => {
    content += text;
    callbacks.onToken?.(text);
  });

  const finalMessage = await stream.finalMessage();

  const usage = {
    promptTokens: finalMessage.usage.input_tokens,
    completionTokens: finalMessage.usage.output_tokens,
    totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens
  };

  const response: LLMResponse = { content, usage };
  callbacks.onDone?.(response);
  return response;
}

async function streamGroq(
  messages: ChatMessage[], model: string,
  callbacks: StreamCallbacks, options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const client = getGroqClient(options?.apiKey);
  const stream = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: options?.maxTokens || 4096,
    temperature: options?.temperature ?? 0.7,
    stream: true
  });

  let content = '';

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      content += delta;
      callbacks.onToken?.(delta);
    }
  }

  const response: LLMResponse = { content };
  callbacks.onDone?.(response);
  return response;
}

// ── Claude Code CLI variants ───────────────────────────────

/**
 * Resolve the path to the `claude` CLI binary.
 * Checks PATH first, then falls back to the Claude desktop app install location
 * (~/Library/Application Support/Claude/claude-code/<version>/claude on macOS).
 */
let cachedClaudePath: string | null = null;

function resolveClaudeBinary(): string {
  if (cachedClaudePath) return cachedClaudePath;

  // First, check if `claude` is on PATH via which/where
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const result = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
    if (result) {
      cachedClaudePath = result.split('\n')[0];
      return cachedClaudePath;
    }
  } catch {
    // Not on PATH, continue to fallback
  }

  // macOS: ~/Library/Application Support/Claude/claude-code/<version>/claude
  if (process.platform === 'darwin') {
    const claudeCodeDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    try {
      const versions = fs.readdirSync(claudeCodeDir)
        .filter(d => /^\d/.test(d))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions.length > 0) {
        const binary = path.join(claudeCodeDir, versions[0], 'claude');
        if (fs.existsSync(binary)) {
          cachedClaudePath = binary;
          return cachedClaudePath;
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Fallback: just try 'claude' and let the OS resolve it
  cachedClaudePath = 'claude';
  return cachedClaudePath;
}

/**
 * Extract the user's actual prompt from the messages array.
 * Claude Code has its own system prompt and tools, so we skip Woodbury's
 * system prompt and tool definitions — just send the user/assistant conversation.
 */
function messagesToPrompt(messages: ChatMessage[]): string {
  // Skip system messages entirely — Claude Code has its own system prompt
  const conversation = messages.filter(m => m.role !== 'system');

  // If there's only one user message, just return its content directly
  if (conversation.length === 1 && conversation[0].role === 'user') {
    return conversation[0].content;
  }

  // Multi-turn: wrap in role tags to preserve conversation structure
  let prompt = '';
  for (const msg of conversation) {
    prompt += `<${msg.role}>\n${msg.content}\n</${msg.role}>\n\n`;
  }
  return prompt.trim();
}

/**
 * Extract token usage from Claude Code JSON response.
 */
function parseClaudeCodeUsage(parsed: any): LLMResponse['usage'] {
  const usage = parsed.usage;
  if (!usage) return undefined;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const output = usage.output_tokens || 0;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output
  };
}

async function runClaudeCode(
  messages: ChatMessage[], model: string, options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const prompt = messagesToPrompt(messages);
  const claudeBin = resolveClaudeBinary();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Write prompt to a temp file to avoid shell escaping issues with large prompts
  const tmpFile = path.join(os.tmpdir(), `woodbury-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');

  return new Promise((resolve, reject) => {
    const cmd = `cat ${JSON.stringify(tmpFile)} | ${JSON.stringify(claudeBin)} -p --output-format json`;
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      fs.unlinkSync(tmpFile);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      if (code !== 0) {
        return reject(new Error(`claude CLI failed (exit ${code}): ${stderr || stdout}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          content: parsed.result || '',
          usage: parseClaudeCodeUsage(parsed)
        });
      } catch {
        resolve({
          content: stdout.trim(),
          usage: undefined
        });
      }
    });
  });
}

async function streamClaudeCode(
  messages: ChatMessage[], model: string,
  callbacks: StreamCallbacks, options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const prompt = messagesToPrompt(messages);
  const claudeBin = resolveClaudeBinary();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Write prompt to a temp file to avoid shell escaping issues with large prompts
  const tmpFile = path.join(os.tmpdir(), `woodbury-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');

  return new Promise((resolve, reject) => {
    const cmd = `cat ${JSON.stringify(tmpFile)} | ${JSON.stringify(claudeBin)} -p --output-format stream-json`;
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    let content = '';
    let buffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);

          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                content += block.text;
                callbacks.onToken?.(block.text);
              }
            }
          }

          if (event.type === 'content_block_delta' && event.delta?.text) {
            content += event.delta.text;
            callbacks.onToken?.(event.delta.text);
          }

          if (event.type === 'result' && event.result) {
            if (!content) {
              content = event.result;
              callbacks.onToken?.(event.result);
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    child.stderr.on('data', () => {});

    child.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.type === 'result' && event.result && !content) {
            content = event.result;
            callbacks.onToken?.(event.result);
          }
        } catch {}
      }

      if (code !== 0 && !content) {
        reject(new Error(`claude CLI exited with code ${code}`));
        return;
      }

      const response: LLMResponse = { content, usage: undefined };
      callbacks.onDone?.(response);
      resolve(response);
    });
  });
}

// ── Non-streaming variants ─────────────────────────────────

async function runOpenAI(messages: ChatMessage[], model: string, options?: Partial<RunPromptOptions>): Promise<LLMResponse> {
  const client = getOpenAIClient(options?.apiKey, options?.baseURL);

  const response = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    max_tokens: options?.maxTokens || 4096,
    temperature: options?.temperature ?? 0.7
  });

  const choice = response.choices[0];

  return {
    content: choice.message.content || '',
    usage: response.usage ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens
    } : undefined
  };
}

async function runAnthropic(messages: ChatMessage[], model: string, options?: Partial<RunPromptOptions>): Promise<LLMResponse> {
  const client = getAnthropicClient(options?.apiKey);

  // Extract system message and user/assistant messages
  const systemMessage = messages.find(m => m.role === 'system');
  let conversationMessages = messages.filter(m => m.role !== 'system');

  // Ensure first message is from user (Anthropic requirement)
  conversationMessages = ensureUserFirst(conversationMessages);

  const response = await client.messages.create({
    model,
    max_tokens: options?.maxTokens || 4096,
    system: systemMessage?.content || undefined,
    messages: conversationMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))
  });

  // Extract text content
  const textContent = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('');

  return {
    content: textContent,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens
    }
  };
}

async function runGroq(messages: ChatMessage[], model: string, options?: Partial<RunPromptOptions>): Promise<LLMResponse> {
  const client = getGroqClient(options?.apiKey);

  const response = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    max_tokens: options?.maxTokens || 4096,
    temperature: options?.temperature ?? 0.7
  });

  const choice = response.choices[0];

  return {
    content: choice.message.content || '',
    usage: response.usage ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens
    } : undefined
  };
}

/**
 * Determine the provider based on model name
 */
export function resolveProviderForModel(model: string): LLMProvider {
  const modelLower = model.toLowerCase();

  if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
    return 'anthropic';
  }
  if (modelLower.includes('llama') || modelLower.includes('mixtral') || modelLower.includes('gemma')) {
    return 'groq';
  }
  // Default to OpenAI for gpt models and unknown models
  return 'openai';
}

/**
 * Run a prompt against an LLM provider.
 * Compatible with @zachary/llm-service interface.
 *
 * @param messages - Array of chat messages
 * @param model - Model name (e.g., 'gpt-4', 'claude-3-5-sonnet-20241022')
 * @param options - Optional configuration
 * @returns LLM response with content and usage
 */
export async function runPrompt(
  messages: ChatMessage[],
  model: string,
  options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const provider = options?.provider || resolveProviderForModel(model);

  switch (provider) {
    case 'openai':
      return runOpenAI(messages, model, options);
    case 'anthropic':
      return runAnthropic(messages, model, options);
    case 'groq':
      return runGroq(messages, model, options);
    case 'claude-code':
      return runClaudeCode(messages, model, options);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * Run a prompt with streaming support.
 * Tokens are emitted via callbacks.onToken as they arrive.
 */
export async function runPromptStream(
  messages: ChatMessage[],
  model: string,
  callbacks: StreamCallbacks,
  options?: Partial<RunPromptOptions>
): Promise<LLMResponse> {
  const provider = options?.provider || resolveProviderForModel(model);

  switch (provider) {
    case 'openai':
      return streamOpenAI(messages, model, callbacks, options);
    case 'anthropic':
      return streamAnthropic(messages, model, callbacks, options);
    case 'groq':
      return streamGroq(messages, model, callbacks, options);
    case 'claude-code':
      return streamClaudeCode(messages, model, callbacks, options);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
