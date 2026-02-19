// Mock all external dependencies first
jest.mock('../loop/index.js', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({
      success: true,
      content: 'Test response',
      toolCalls: [],
      metadata: {
        executionTime: 100,
        iterations: 1
      }
    }),
    getAvailableTools: jest.fn().mockReturnValue(['file_read', 'file_write']),
    getConfig: jest.fn().mockReturnValue({ model: 'gpt-4' })
  })),
  createDefaultToolRegistry: jest.fn().mockReturnValue({}),
  AgentConfig: {}
}));

jest.mock('../logger', () => ({
  WoodburyLogger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

import { WoodburyAgent, getAgent, resetAgent } from '../agent';
import { Agent } from '../loop/index.js';
import { WoodburyLogger } from '../logger';
import type { WoodburyConfig } from '../types';

const MockAgent = Agent as jest.MockedClass<typeof Agent>;
const MockLogger = WoodburyLogger as jest.MockedClass<typeof WoodburyLogger>;

describe('WoodburyAgent', () => {
  let config: WoodburyConfig;
  let mockAgent: any;
  let mockLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAgent(); // Reset singleton
    
    config = {
      model: 'gpt-4',
      apiKeys: {
        openai: 'test-key'
      },
      workingDirectory: process.cwd(),
      verbose: false,
      safe: true
    };

    // Setup mock instances
    mockAgent = {
      run: jest.fn().mockResolvedValue({
        success: true,
        content: 'Test response',
        toolCalls: [],
        metadata: {
          executionTime: 100,
          iterations: 1
        }
      }),
      getAvailableTools: jest.fn().mockReturnValue(['file_read', 'file_write']),
      getConfig: jest.fn().mockReturnValue({ model: 'gpt-4' })
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    MockAgent.mockImplementation(() => mockAgent);
    MockLogger.mockImplementation(() => mockLogger);
  });

  it('should create a WoodburyAgent with proper configuration', () => {
    const agent = new WoodburyAgent(config);
    expect(agent).toBeInstanceOf(WoodburyAgent);
  });

  it('should initialize Agent with correct config', () => {
    new WoodburyAgent(config);
    
    expect(MockAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'woodbury-agent',
        provider: 'openai',
        model: 'gpt-4',
        maxIterations: 50,
        timeout: 300000,
        temperature: 0.1,
        workingDirectory: process.cwd()
      }),
      expect.any(Object) // ToolRegistry
    );
  });

  it('should run tasks successfully', async () => {
    const agent = new WoodburyAgent(config);
    const result = await agent.run('test message');

    expect(result).toEqual({
      success: true,
      content: 'Test response',
      toolCalls: [],
      metadata: {
        executionTime: 100,
        iterations: 1
      }
    });
    expect(mockAgent.run).toHaveBeenCalledWith('test message');
  });

  it('should handle errors during task execution', async () => {
    const error = new Error('Task execution failed');
    mockAgent.run.mockRejectedValueOnce(error);
    
    const agent = new WoodburyAgent(config);
    
    await expect(agent.run('test message')).rejects.toThrow('Task execution failed');
    expect(mockLogger.error).toHaveBeenCalledWith('Agent execution failed:', error);
  });

  it('should get available tools', () => {
    const agent = new WoodburyAgent(config);
    const tools = agent.getTools();

    expect(tools).toEqual(['file_read', 'file_write']);
    expect(mockAgent.getAvailableTools).toHaveBeenCalled();
  });

  it('should stop cleanly', async () => {
    const agent = new WoodburyAgent(config);
    await agent.stop();

    expect(mockLogger.info).toHaveBeenCalledWith('Agent stopped');
  });

  it('should select anthropic provider when anthropic key is provided', () => {
    const anthropicConfig = {
      ...config,
      apiKeys: { anthropic: 'test-anthropic-key' }
    };
    
    new WoodburyAgent(anthropicConfig);
    
    expect(MockAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic'
      }),
      expect.any(Object)
    );
  });

  it('should select groq provider when groq key is provided', () => {
    const groqConfig = {
      ...config,
      apiKeys: { groq: 'test-groq-key' }
    };
    
    new WoodburyAgent(groqConfig);
    
    expect(MockAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'groq'
      }),
      expect.any(Object)
    );
  });

  it('should use verbose logging when configured', () => {
    const verboseConfig = { ...config, verbose: true };
    
    new WoodburyAgent(verboseConfig);
    
    expect(MockLogger).toHaveBeenCalledWith(true);
  });

  it('should handle agent initialization errors', () => {
    MockAgent.mockImplementationOnce(() => {
      throw new Error('Initialization failed');
    });
    
    expect(() => new WoodburyAgent(config)).toThrow('Initialization failed');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to initialize agent:',
      expect.any(Error)
    );
  });
});

describe('Agent Singleton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAgent();
  });

  it('should return same instance for getAgent calls', () => {
    const agent1 = getAgent({ apiKeys: { openai: 'test-key' } });
    const agent2 = getAgent();
    
    expect(agent1).toBe(agent2);
  });

  it('should create new instance after reset', () => {
    const agent1 = getAgent({ apiKeys: { openai: 'test-key' } });
    resetAgent();
    const agent2 = getAgent({ apiKeys: { openai: 'test-key' } });
    
    expect(agent1).not.toBe(agent2);
  });
});
