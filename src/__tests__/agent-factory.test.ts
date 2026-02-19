/**
 * Tests for agent-factory.ts improvements:
 * - setOnToken / setOnToolStart / setOnToolEnd callbacks
 * - Provider auto-detection from API keys
 * - Explicit provider override
 * - Streaming config wiring
 */

jest.mock('../loop/index.js', () => ({
  Agent: jest.fn().mockImplementation((config: any) => {
    // Store the config so tests can inspect it
    const instance = {
      config,
      run: jest.fn().mockResolvedValue({
        success: true,
        content: 'Test response',
        toolCalls: [],
        metadata: { executionTime: 100, iterations: 1 }
      }),
      getAvailableTools: jest.fn().mockReturnValue(['file_read', 'bash']),
      progressLogger: { disabled: false },
    };
    return instance;
  }),
  createDefaultToolRegistry: jest.fn().mockReturnValue({
    list: jest.fn().mockReturnValue(['file_read', 'bash']),
    count: jest.fn().mockReturnValue(2),
    generateToolDocumentation: jest.fn().mockReturnValue('# Tools')
  }),
  AgentConfig: {}
}));

jest.mock('../logger', () => ({
  WoodburyLogger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../system-prompt.js', () => ({
  buildSystemPrompt: jest.fn().mockResolvedValue('System prompt for testing')
}));

import { createAgent, AgentHandle } from '../agent-factory';
import { Agent } from '../loop/index.js';
import type { WoodburyConfig } from '../types';

const MockAgent = Agent as jest.MockedClass<typeof Agent>;

describe('createAgent', () => {
  let config: WoodburyConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      model: 'gpt-4',
      apiKeys: { openai: 'test-key' },
      workingDirectory: '/tmp/test',
      verbose: false,
      safe: false,
      stream: true
    };
  });

  it('should create an AgentHandle with all methods', async () => {
    const handle = await createAgent(config);
    expect(handle.run).toBeDefined();
    expect(handle.getTools).toBeDefined();
    expect(handle.stop).toBeDefined();
    expect(handle.setOnToken).toBeDefined();
    expect(handle.setOnToolStart).toBeDefined();
    expect(handle.setOnToolEnd).toBeDefined();
  });

  it('should pass streaming: true when config.stream is true', async () => {
    await createAgent(config);
    const agentConfig = MockAgent.mock.calls[0][0];
    expect(agentConfig.streaming).toBe(true);
  });

  it('should pass streaming: false when config.stream is false', async () => {
    config.stream = false;
    await createAgent(config);
    const agentConfig = MockAgent.mock.calls[0][0];
    expect(agentConfig.streaming).toBe(false);
  });

  describe('setOnToken', () => {
    it('should set the onToken callback on the underlying agent config', async () => {
      const handle = await createAgent(config);
      const callback = jest.fn();
      handle.setOnToken(callback);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.config.onToken).toBe(callback);
      expect(agentInstance.config.streaming).toBe(true);
    });

    it('should disable streaming when callback is undefined', async () => {
      const handle = await createAgent(config);
      handle.setOnToken(jest.fn());
      handle.setOnToken(undefined);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.config.onToken).toBeUndefined();
      expect(agentInstance.config.streaming).toBe(false);
    });
  });

  describe('setOnToolStart', () => {
    it('should set the onToolStart callback', async () => {
      const handle = await createAgent(config);
      const callback = jest.fn();
      handle.setOnToolStart(callback);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.config.onToolStart).toBe(callback);
    });

    it('should clear the callback when set to undefined', async () => {
      const handle = await createAgent(config);
      handle.setOnToolStart(jest.fn());
      handle.setOnToolStart(undefined);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.config.onToolStart).toBeUndefined();
    });
  });

  describe('setOnToolEnd', () => {
    it('should set the onToolEnd callback', async () => {
      const handle = await createAgent(config);
      const callback = jest.fn();
      handle.setOnToolEnd(callback);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.config.onToolEnd).toBe(callback);
    });
  });

  describe('provider selection', () => {
    it('should detect anthropic provider from API keys', async () => {
      config.apiKeys = { anthropic: 'sk-ant-test' };
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('anthropic');
    });

    it('should detect openai provider from API keys', async () => {
      config.apiKeys = { openai: 'sk-test' };
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('openai');
    });

    it('should detect groq provider from API keys', async () => {
      config.apiKeys = { groq: 'gsk-test' };
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('groq');
    });

    it('should prefer explicit provider over auto-detection', async () => {
      config.apiKeys = { openai: 'sk-test', anthropic: 'sk-ant-test' };
      config.provider = 'groq';
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('groq');
    });

    it('should default to anthropic when no API keys available', async () => {
      config.apiKeys = {};
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('anthropic');
    });

    it('should prioritize anthropic over openai when both keys present', async () => {
      config.apiKeys = { openai: 'sk-test', anthropic: 'sk-ant-test' };
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.provider).toBe('anthropic');
    });
  });

  describe('default models', () => {
    it('should use default anthropic model when no model specified', async () => {
      config.model = undefined;
      config.apiKeys = { anthropic: 'key' };
      config.provider = undefined;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.model).toContain('claude');
    });

    it('should use default openai model when openai provider', async () => {
      config.model = undefined;
      config.provider = 'openai';
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.model).toBe('gpt-4');
    });

    it('should use default groq model when groq provider', async () => {
      config.model = undefined;
      config.provider = 'groq';
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.model).toContain('llama');
    });

    it('should use explicit model when specified', async () => {
      config.model = 'gpt-3.5-turbo';
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.model).toBe('gpt-3.5-turbo');
    });
  });

  describe('run method', () => {
    it('should delegate to the underlying agent', async () => {
      const handle = await createAgent(config);
      const result = await handle.run('test input');

      expect(result.success).toBe(true);
      expect(result.content).toBe('Test response');

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.run).toHaveBeenCalledWith('test input', undefined);
    });

    it('should pass abort signal through', async () => {
      const handle = await createAgent(config);
      const controller = new AbortController();
      await handle.run('test input', controller.signal);

      const agentInstance = MockAgent.mock.results[0].value;
      expect(agentInstance.run).toHaveBeenCalledWith('test input', controller.signal);
    });
  });

  describe('getTools', () => {
    it('should return available tool names', async () => {
      const handle = await createAgent(config);
      const tools = handle.getTools();
      expect(tools).toEqual(['file_read', 'bash']);
    });
  });

  describe('safe mode', () => {
    it('should set allowDangerousTools to false when safe=true', async () => {
      config.safe = true;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.allowDangerousTools).toBe(false);
    });

    it('should set allowDangerousTools to true when safe=false', async () => {
      config.safe = false;
      await createAgent(config);
      const agentConfig = MockAgent.mock.calls[0][0];
      expect(agentConfig.allowDangerousTools).toBe(true);
    });
  });
});
