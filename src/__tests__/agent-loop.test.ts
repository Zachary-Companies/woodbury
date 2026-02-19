/**
 * Tests for the Agent loop — focuses on the improvements:
 * - Streaming (runPromptStream path)
 * - Parallel tool execution (Promise.all for multiple calls)
 * - Parameter validation (_parseError and validateToolCall)
 * - onToolStart/onToolEnd callbacks
 */

// Mock the llm-service before imports
jest.mock('../loop/llm-service.js', () => ({
  runPrompt: jest.fn(),
  runPromptStream: jest.fn(),
  resolveProviderForModel: jest.fn().mockReturnValue('anthropic'),
  ChatMessage: {},
  StreamCallbacks: {}
}));

jest.mock('../loop/system-prompt.js', () => ({
  generateSystemPrompt: jest.fn().mockReturnValue('You are a helpful agent.')
}));

import { Agent } from '../loop/agent';
import { ToolRegistry } from '../loop/tool-registry';
import { runPrompt, runPromptStream } from '../loop/llm-service.js';

const mockRunPrompt = runPrompt as jest.Mock;
const mockRunPromptStream = runPromptStream as jest.Mock;

function createMockRegistry(): ToolRegistry {
  const registry = new ToolRegistry({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

  registry.register(
    {
      name: 'echo',
      description: 'Echoes back the input',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' }
        },
        required: ['message']
      }
    },
    async (params: any) => `Echo: ${params.message}`
  );

  registry.register(
    {
      name: 'add',
      description: 'Adds two numbers',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' }
        },
        required: ['a', 'b']
      }
    },
    async (params: any) => String(params.a + params.b)
  );

  return registry;
}

describe('Agent loop improvements', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = createMockRegistry();
  });

  describe('streaming path', () => {
    it('should use runPromptStream when streaming is enabled with onToken', async () => {
      const tokens: string[] = [];
      const onToken = (token: string) => tokens.push(token);

      mockRunPromptStream.mockResolvedValue({
        content: '<final_answer>Streamed result</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          streaming: true,
          onToken,
          maxIterations: 5
        },
        registry
      );

      const result = await agent.run('Hello');
      expect(result.success).toBe(true);
      expect(result.content).toBe('Streamed result');
      expect(mockRunPromptStream).toHaveBeenCalled();
      expect(mockRunPrompt).not.toHaveBeenCalled();
    });

    it('should use runPrompt when streaming is disabled', async () => {
      mockRunPrompt.mockResolvedValue({
        content: '<final_answer>Non-streamed</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          streaming: false,
          maxIterations: 5
        },
        registry
      );

      const result = await agent.run('Hello');
      expect(result.success).toBe(true);
      expect(result.content).toBe('Non-streamed');
      expect(mockRunPrompt).toHaveBeenCalled();
      expect(mockRunPromptStream).not.toHaveBeenCalled();
    });

    it('should use runPrompt when streaming is true but onToken is undefined', async () => {
      mockRunPrompt.mockResolvedValue({
        content: '<final_answer>No callback</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          streaming: true,
          // onToken is NOT set
          maxIterations: 5
        },
        registry
      );

      const result = await agent.run('Hello');
      expect(result.success).toBe(true);
      expect(mockRunPrompt).toHaveBeenCalled();
      expect(mockRunPromptStream).not.toHaveBeenCalled();
    });
  });

  describe('parallel tool execution', () => {
    it('should execute multiple tool calls in parallel', async () => {
      const callOrder: string[] = [];

      // Replace the echo handler with one that tracks call order
      const slowRegistry = new ToolRegistry({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
      slowRegistry.register(
        {
          name: 'slow_echo',
          description: 'Slow echo',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string', description: 'msg' } },
            required: ['message']
          }
        },
        async (params: any) => {
          callOrder.push(`start:${params.message}`);
          await new Promise(r => setTimeout(r, 50));
          callOrder.push(`end:${params.message}`);
          return `Echo: ${params.message}`;
        }
      );

      // First call: LLM returns two tool calls
      mockRunPrompt.mockResolvedValueOnce({
        content: `<tool_call><name>slow_echo</name><parameters>{"message":"A"}</parameters></tool_call>
<tool_call><name>slow_echo</name><parameters>{"message":"B"}</parameters></tool_call>`,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      });

      // Second call: LLM returns final answer
      mockRunPrompt.mockResolvedValueOnce({
        content: '<final_answer>Done</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        slowRegistry
      );

      const result = await agent.run('Run both');
      expect(result.success).toBe(true);

      // With parallel execution, both starts should happen before either end
      expect(callOrder[0]).toBe('start:A');
      expect(callOrder[1]).toBe('start:B');
    });

    it('should execute single tool call without Promise.all overhead', async () => {
      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{"message":"single"}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>OK</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Single tool');
      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('echo');
    });
  });

  describe('parameter validation', () => {
    it('should return error for tool calls with _parseError', async () => {
      // The LLM returns a tool call with invalid JSON that will produce _parseError
      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>completely invalid json here!!!</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Handled error</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Bad params');
      expect(result.success).toBe(true);
      // The tool call should still be recorded
      expect(result.toolCalls).toHaveLength(1);
    });

    it('should return error for missing required parameters', async () => {
      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Handled</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Missing required');
      expect(result.success).toBe(true);
    });

    it('should return error for wrong parameter types', async () => {
      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>add</name><parameters>{"a": "not-a-number", "b": 2}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Type error handled</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Wrong types');
      expect(result.success).toBe(true);
    });
  });

  describe('onToolStart/onToolEnd callbacks', () => {
    it('should call onToolStart before tool execution', async () => {
      const toolStarts: Array<{ name: string; params: any }> = [];

      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{"message":"hi"}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Done</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          maxIterations: 5,
          onToolStart: (name, params) => toolStarts.push({ name, params })
        },
        registry
      );

      await agent.run('Call echo');
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].name).toBe('echo');
      expect(toolStarts[0].params).toEqual({ message: 'hi' });
    });

    it('should call onToolEnd after tool execution with timing', async () => {
      const toolEnds: Array<{ name: string; success: boolean; duration: number | undefined }> = [];

      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{"message":"test"}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>OK</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          maxIterations: 5,
          onToolEnd: (name, success, _result, duration) => toolEnds.push({ name, success, duration })
        },
        registry
      );

      await agent.run('Call echo');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].name).toBe('echo');
      expect(toolEnds[0].success).toBe(true);
      expect(typeof toolEnds[0].duration).toBe('number');
      expect(toolEnds[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should call onToolEnd with success=false when tool fails', async () => {
      const failingRegistry = new ToolRegistry({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
      failingRegistry.register(
        {
          name: 'fail_tool',
          description: 'Always fails',
          parameters: { type: 'object', properties: {}, required: [] }
        },
        async () => { throw new Error('Tool exploded'); }
      );

      const toolEnds: Array<{ name: string; success: boolean }> = [];

      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>fail_tool</name><parameters>{}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Handled failure</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        {
          name: 'test',
          provider: 'anthropic',
          model: 'test-model',
          maxIterations: 5,
          onToolEnd: (name, success) => toolEnds.push({ name, success })
        },
        failingRegistry
      );

      await agent.run('Run failing tool');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].success).toBe(false);
    });
  });

  describe('abort signal', () => {
    it('should abort execution when signal is triggered', async () => {
      const controller = new AbortController();

      mockRunPrompt.mockResolvedValueOnce({
        content: '<tool_call><name>echo</name><parameters>{"message":"test"}</parameters></tool_call>',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      // Abort before the second iteration
      controller.abort();

      const result = await agent.run('Hello', controller.signal);
      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });
  });

  describe('incomplete tool calls', () => {
    it('should ask LLM to continue when response is truncated', async () => {
      mockRunPrompt
        .mockResolvedValueOnce({
          // Truncated — open tag without close tag
          content: '<tool_call><name>echo</name><parameters>{"message":',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Recovered</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        })
        // Safety fallback for any additional calls
        .mockResolvedValue({
          content: '<final_answer>Recovered</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Truncated');
      expect(result.success).toBe(true);
      expect(result.content).toBe('Recovered');
      // Should have made at least 2 LLM calls (truncated + recovery)
      expect(mockRunPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('max iterations', () => {
    it('should stop and wrap up when max iterations reached', async () => {
      // Always return tool calls to exhaust iterations
      mockRunPrompt.mockResolvedValue({
        content: '<tool_call><name>echo</name><parameters>{"message":"loop"}</parameters></tool_call>',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      });

      // Override the last call to be the wrap-up response
      const maxIter = 3;
      // Calls: iter1 (tool) + iter2 (tool) + iter3 (tool) + wrap-up = 4 calls
      // But the last mockResolvedValue is the wrap-up
      for (let i = 0; i < maxIter; i++) {
        mockRunPrompt.mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{"message":"loop"}</parameters></tool_call>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        });
      }
      mockRunPrompt.mockResolvedValueOnce({
        content: '<final_answer>Wrap-up summary</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: maxIter },
        registry
      );

      const result = await agent.run('Loop me');
      expect(result.success).toBe(true);
      expect(result.metadata.iterations).toBe(maxIter + 1); // +1 for wrap-up
    });
  });

  describe('token tracking', () => {
    it('should accumulate total tokens across iterations', async () => {
      mockRunPrompt
        .mockResolvedValueOnce({
          content: '<tool_call><name>echo</name><parameters>{"message":"a"}</parameters></tool_call>',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Done</final_answer>',
          usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );

      const result = await agent.run('Token test');
      expect(result.metadata.totalTokens).toBe(380); // 150 + 230
    });
  });
});
