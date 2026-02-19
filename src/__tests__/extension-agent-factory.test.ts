/**
 * Tests for agent-factory.ts extension integration
 *
 * Verifies:
 * - Extension tools are registered in the ToolRegistry
 * - Extension prompt sections are passed to buildSystemPrompt
 * - Failed extension tool registrations are warned and skipped
 * - Agent works correctly with no extension manager (backward compat)
 */

jest.mock('../loop/index.js', () => ({
  Agent: jest.fn().mockImplementation((config: any) => ({
    config,
    run: jest.fn().mockResolvedValue({
      success: true,
      content: 'Test response',
      toolCalls: [],
      metadata: { executionTime: 100, iterations: 1 },
    }),
    getAvailableTools: jest.fn().mockReturnValue(['file_read', 'bash']),
    progressLogger: { disabled: false },
  })),
  createDefaultToolRegistry: jest.fn().mockReturnValue({
    register: jest.fn(),
    list: jest.fn().mockReturnValue(['file_read', 'bash']),
    count: jest.fn().mockReturnValue(2),
    generateToolDocumentation: jest.fn().mockReturnValue('# Tools'),
  }),
  AgentConfig: {},
}));

jest.mock('../logger', () => ({
  WoodburyLogger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

const mockBuildSystemPrompt = jest.fn().mockResolvedValue('System prompt for testing');

jest.mock('../system-prompt.js', () => ({
  buildSystemPrompt: (...args: any[]) => mockBuildSystemPrompt(...args),
}));

jest.mock('../bridge-server.js', () => ({
  ensureBridgeServer: jest.fn().mockResolvedValue(undefined),
  bridgeServer: { stop: jest.fn().mockResolvedValue(undefined) },
}));

import { createAgent } from '../agent-factory';
import { createDefaultToolRegistry } from '../loop/index.js';
import type { WoodburyConfig } from '../types';

const mockRegistry = createDefaultToolRegistry() as jest.Mocked<ReturnType<typeof createDefaultToolRegistry>>;

describe('createAgent with extensions', () => {
  let config: WoodburyConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      model: 'gpt-4',
      apiKeys: { openai: 'test-key' },
      workingDirectory: '/tmp/test',
      verbose: false,
      safe: false,
      stream: true,
    };

    // Reset the mock registry so register calls are tracked fresh
    (createDefaultToolRegistry as jest.Mock).mockReturnValue({
      register: jest.fn(),
      list: jest.fn().mockReturnValue(['file_read', 'bash']),
      count: jest.fn().mockReturnValue(2),
      generateToolDocumentation: jest.fn().mockReturnValue('# Tools'),
    });
  });

  it('should work without an extension manager (backward compatibility)', async () => {
    const handle = await createAgent(config);
    expect(handle).toBeDefined();
    expect(handle.run).toBeDefined();
  });

  it('should work with undefined extension manager', async () => {
    const handle = await createAgent(config, undefined);
    expect(handle).toBeDefined();
  });

  it('should register extension tools in the ToolRegistry', async () => {
    const toolDef = {
      name: 'ext_tool',
      description: 'An extension tool',
      parameters: { type: 'object' as const, properties: {} },
    };
    const toolHandler = jest.fn();

    const mockExtManager = {
      getAllTools: jest.fn().mockReturnValue([
        { definition: toolDef, handler: toolHandler },
      ]),
      getAllPromptSections: jest.fn().mockReturnValue([]),
    } as any;

    await createAgent(config, mockExtManager);

    const registry = (createDefaultToolRegistry as jest.Mock).mock.results[0].value;
    expect(registry.register).toHaveBeenCalledWith(toolDef, toolHandler);
  });

  it('should register multiple extension tools', async () => {
    const tools = [
      {
        definition: { name: 'tool_a', description: 'A', parameters: { type: 'object' as const, properties: {} } },
        handler: jest.fn(),
      },
      {
        definition: { name: 'tool_b', description: 'B', parameters: { type: 'object' as const, properties: {} } },
        handler: jest.fn(),
      },
    ];

    const mockExtManager = {
      getAllTools: jest.fn().mockReturnValue(tools),
      getAllPromptSections: jest.fn().mockReturnValue([]),
    } as any;

    await createAgent(config, mockExtManager);

    const registry = (createDefaultToolRegistry as jest.Mock).mock.results[0].value;
    expect(registry.register).toHaveBeenCalledTimes(2);
    expect(registry.register).toHaveBeenCalledWith(tools[0].definition, tools[0].handler);
    expect(registry.register).toHaveBeenCalledWith(tools[1].definition, tools[1].handler);
  });

  it('should warn and skip on tool registration failure', async () => {
    const toolDef = {
      name: 'conflicting_tool',
      description: 'Conflicts with built-in',
      parameters: { type: 'object' as const, properties: {} },
    };

    // Make registry.register throw for this tool
    (createDefaultToolRegistry as jest.Mock).mockReturnValue({
      register: jest.fn().mockImplementation((def: any) => {
        if (def.name === 'conflicting_tool') {
          throw new Error('Tool already registered: conflicting_tool');
        }
      }),
      list: jest.fn().mockReturnValue(['file_read', 'bash']),
      count: jest.fn().mockReturnValue(2),
      generateToolDocumentation: jest.fn().mockReturnValue('# Tools'),
    });

    const mockExtManager = {
      getAllTools: jest.fn().mockReturnValue([
        { definition: toolDef, handler: jest.fn() },
      ]),
      getAllPromptSections: jest.fn().mockReturnValue([]),
    } as any;

    // Should not throw — error is caught and warned
    await expect(createAgent(config, mockExtManager)).resolves.toBeDefined();
  });

  it('should pass extension prompt sections to buildSystemPrompt', async () => {
    const sections = ['Be helpful.', 'Use friendly language.'];

    const mockExtManager = {
      getAllTools: jest.fn().mockReturnValue([]),
      getAllPromptSections: jest.fn().mockReturnValue(sections),
    } as any;

    await createAgent(config, mockExtManager);

    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(
      '/tmp/test',      // workingDirectory
      undefined,        // contextDir
      sections          // extensionPromptSections
    );
  });

  it('should not pass extension prompts when no extension manager', async () => {
    await createAgent(config);

    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(
      '/tmp/test',
      undefined,
      undefined,        // no extension prompts
    );
  });

  it('should call getAllPromptSections on the extension manager', async () => {
    const mockExtManager = {
      getAllTools: jest.fn().mockReturnValue([]),
      getAllPromptSections: jest.fn().mockReturnValue(['Section 1']),
    } as any;

    await createAgent(config, mockExtManager);

    expect(mockExtManager.getAllPromptSections).toHaveBeenCalledTimes(1);
  });
});
