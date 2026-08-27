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
    // The agent mutates a single messages array in place across iterations, so
    // jest's recorded mock.calls all alias the same (final) array. Snapshot the
    // last message at call time to see what the model actually received.
    let lastMessagePerCall: string[] = [];

    beforeEach(() => {
      lastMessagePerCall = [];
    });

    /** Queue the fake LLM's responses in order, recording each prompt as it lands. */
    function respondWith(...contents: string[]) {
      for (const content of contents) {
        mockRunPrompt.mockImplementationOnce(async (messages: any[]) => {
          lastMessagePerCall.push(messages[messages.length - 1]?.content ?? '');
          return { content, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        });
      }
    }

    /** The tool-result message the agent fed back on iteration 2. */
    function toolResultSentToModel(): string {
      return lastMessagePerCall[1] ?? '';
    }

    it('reports a JSON parse error back to the model instead of invoking the tool', async () => {
      // Without this guard the parser's {_parseError, _raw} object is handed to
      // the tool as its arguments, and the model sees an opaque crash
      // (ERR_INVALID_ARG_TYPE) instead of something it can correct.
      const handler = jest.fn();
      registry.register(
        { name: 'strict', description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
        handler
      );

      respondWith(
        '<tool_call><name>strict</name><parameters>completely invalid json here!!!</parameters></tool_call>',
        '<final_answer>Handled error</final_answer>'
      );

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      await agent.run('Bad params');

      expect(handler).not.toHaveBeenCalled();
      const sent = toolResultSentToModel();
      expect(sent).toContain('Invalid parameters');
      expect(sent).toContain('error');
    });

    it('rejects missing required parameters before the handler runs', async () => {
      const handler = jest.fn().mockResolvedValue('should not happen');
      registry.register(
        {
          name: 'needs_arg',
          description: 'x',
          parameters: {
            type: 'object',
            properties: { required_field: { type: 'string', description: 'r' } },
            required: ['required_field']
          }
        },
        handler
      );

      respondWith(
        '<tool_call><name>needs_arg</name><parameters>{}</parameters></tool_call>',
        '<final_answer>Handled</final_answer>'
      );

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      await agent.run('Missing required');

      expect(handler).not.toHaveBeenCalled();
      expect(toolResultSentToModel()).toContain('Parameter validation failed');
    });

    it('rejects wrong parameter types before the handler runs', async () => {
      respondWith(
        '<tool_call><name>add</name><parameters>{"a": "not-a-number", "b": 2}</parameters></tool_call>',
        '<final_answer>Type error handled</final_answer>'
      );

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      await agent.run('Wrong types');

      expect(toolResultSentToModel()).toContain('Parameter validation failed');
    });

    it('lets a well-formed call through untouched', async () => {
      respondWith(
        '<tool_call><name>add</name><parameters>{"a": 2, "b": 3}</parameters></tool_call>',
        '<final_answer>5</final_answer>'
      );

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      await agent.run('Add them');

      const sent = toolResultSentToModel();
      expect(sent).not.toContain('validation failed');
      expect(sent).toContain('5');
    });
  });

  describe('tool calls vs final answer ordering', () => {
    it('executes tool calls even when the same response also emits a final answer', async () => {
      // Models sometimes emit both in one turn. Honouring the premature
      // final_answer first drops the tool calls entirely and the agent answers
      // from a guess instead of from the tool result.
      mockRunPrompt
        .mockResolvedValueOnce({
          content:
            '<tool_call><name>echo</name><parameters>{"message": "from the tool"}</parameters></tool_call>\n' +
            '<final_answer>I guessed without looking</final_answer>',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
        })
        .mockResolvedValueOnce({
          content: '<final_answer>Echo: from the tool</final_answer>',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      const result = await agent.run('Do it');

      // The tool ran, and the premature answer was not returned.
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('echo');
      expect(result.content).not.toContain('I guessed without looking');
      expect(mockRunPrompt).toHaveBeenCalledTimes(2);
    });

    it('returns the final answer when there are no tool calls', async () => {
      mockRunPrompt.mockResolvedValueOnce({
        content: '<final_answer>All done</final_answer>',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      const result = await agent.run('Just answer');

      expect(result.content).toBe('All done');
      expect(result.toolCalls).toHaveLength(0);
      expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    });

    it('treats a bare response with no tags as the final answer', async () => {
      mockRunPrompt.mockResolvedValueOnce({
        content: 'Just some prose with no tags at all.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      });

      const agent = new Agent(
        { name: 'test', provider: 'anthropic', model: 'test-model', maxIterations: 5 },
        registry
      );
      const result = await agent.run('Answer plainly');

      expect(result.content).toBe('Just some prose with no tags at all.');
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
