/**
 * Unit tests for Closure Engine V3 — AgentHandleBridge, System Prompt, Barrel Exports
 */
import { describe, it, expect } from '@jest/globals';
import { createAgentHandleBridge } from '../loop/v3/agent-handle-bridge.js';
import { buildV3SystemPrompt } from '../loop/v3/system-prompt-v3.js';

// ── AgentHandleBridge ────────────────────────────────────────

describe('createAgentHandleBridge', () => {
  it('returns an object with setOnToken, setOnToolStart, setOnToolEnd, run, getTools, stop', () => {
    // Create a minimal mock engine
    const mockEngine = {
      callbacks: {} as any,
      run: async (input: string) => ({
        success: true,
        content: `Response to: ${input}`,
        beliefs: [],
        observations: [
          {
            id: 'obs_1',
            actionId: 'act_1',
            taskId: 't1',
            toolName: 'file_read',
            params: { path: 'test.ts' },
            result: 'content',
            status: 'success' as const,
            duration: 10,
            matchedExpectation: true,
            timestamp: new Date().toISOString(),
          },
        ],
        memories: [],
        reflections: [],
        recoveryAttempts: [],
        iterations: 1,
        totalToolCalls: 1,
        durationMs: 100,
      }),
      getAvailableTools: () => ['file_read', 'file_write', 'shell_execute'],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    expect(handle.setOnToken).toBeInstanceOf(Function);
    expect(handle.setOnToolStart).toBeInstanceOf(Function);
    expect(handle.setOnToolEnd).toBeInstanceOf(Function);
    expect(handle.run).toBeInstanceOf(Function);
    expect(handle.getTools).toBeInstanceOf(Function);
    expect(handle.stop).toBeInstanceOf(Function);
  });

  it('getTools returns engine available tools', () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({} as any),
      getAvailableTools: () => ['tool_a', 'tool_b'],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    expect(handle.getTools()).toEqual(['tool_a', 'tool_b']);
  });

  it('run converts ClosureEngineResult to AgentResult', async () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({
        success: true,
        content: 'Done!',
        beliefs: [],
        observations: [
          {
            id: 'obs_1',
            actionId: 'act_1',
            taskId: 't1',
            toolName: 'file_write',
            params: { path: 'output.ts', content: 'export {}' },
            result: 'ok',
            status: 'success' as const,
            duration: 20,
            matchedExpectation: true,
            timestamp: new Date().toISOString(),
          },
        ],
        memories: [],
        reflections: [],
        recoveryAttempts: [],
        iterations: 3,
        totalToolCalls: 5,
        durationMs: 2500,
      }),
      getAvailableTools: () => [],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    const result = await handle.run('Write code');

    expect(result.success).toBe(true);
    expect(result.content).toBe('Done!');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('file_write');
    expect(result.toolCalls[0].parameters).toEqual({ path: 'output.ts', content: 'export {}' });
    expect(result.metadata?.executionTime).toBe(2500);
    expect(result.metadata?.iterations).toBe(3);
  });

  it('setOnToken patches engine callbacks', () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({} as any),
      getAvailableTools: () => [],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    const tokenFn = (token: string) => {};
    handle.setOnToken(tokenFn);
    expect(mockEngine.callbacks.onToken).toBe(tokenFn);
  });

  it('setOnToolStart patches engine callbacks', () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({} as any),
      getAvailableTools: () => [],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    const toolStartFn = (name: string) => {};
    handle.setOnToolStart(toolStartFn);
    expect(mockEngine.callbacks.onToolStart).toBe(toolStartFn);
  });

  it('setOnToolEnd patches engine callbacks', () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({} as any),
      getAvailableTools: () => [],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    const toolEndFn = (name: string, success: boolean) => {};
    handle.setOnToolEnd(toolEndFn);
    expect(mockEngine.callbacks.onToolEnd).toBe(toolEndFn);
  });

  it('stop resolves without error', async () => {
    const mockEngine = {
      callbacks: {} as any,
      run: async () => ({} as any),
      getAvailableTools: () => [],
    };

    const handle = createAgentHandleBridge(mockEngine as any);
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});

// ── System Prompt V3 ─────────────────────────────────────────

describe('buildV3SystemPrompt', () => {
  // buildV3SystemPrompt(workingDirectory, contextDir?, extensionPromptSections?, tools?)
  // Returns Promise<string>

  it('generates a system prompt string', async () => {
    const prompt = await buildV3SystemPrompt('/tmp/test');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('does not duplicate tool docs in prompt text (tools go via API parameter)', async () => {
    const tools = [
      {
        name: 'file_read',
        description: 'Read a file from disk',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string' as const, description: 'file path' },
          },
        },
      },
    ];
    const prompt = await buildV3SystemPrompt('/home/user/my-project', undefined, undefined, tools);
    // Tool names should NOT appear in the prompt text — they're passed natively
    expect(prompt).not.toContain('## Available Tools');
  });

  it('includes V3-specific guidance', async () => {
    const prompt = await buildV3SystemPrompt('/tmp');
    expect(prompt).toContain('Tool Calling');
    expect(prompt).toContain('MUST use tools');
    expect(prompt).toContain('verify');
  });

  it('does not contain XML tool_call format instructions', async () => {
    const prompt = await buildV3SystemPrompt('/tmp');
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).not.toContain('</tool_call>');
    expect(prompt).not.toContain('<final_answer>');
  });
});

// ── Barrel Exports ───────────────────────────────────────────

describe('V3 barrel exports (index.ts)', () => {
  it('exports all core modules', async () => {
    const v3 = await import('../loop/v3/index.js');

    // Core engine
    expect(v3.ClosureEngine).toBeDefined();

    // State management
    expect(v3.StateManager).toBeDefined();
    expect(v3.MemoryStore).toBeDefined();

    // Task graph
    expect(v3.createSingleTaskGraph).toBeDefined();
    expect(v3.decomposeGoal).toBeDefined();
    expect(v3.isSimpleGoal).toBeDefined();

    // Milestone 2
    expect(v3.Verifier).toBeDefined();
    expect(v3.RecoveryEngine).toBeDefined();

    // Milestone 3
    expect(v3.BeliefGraph).toBeDefined();

    // Milestone 4
    expect(v3.Reflector).toBeDefined();
    expect(v3.SkillSynthesizer).toBeDefined();

    // Milestone 5
    expect(v3.DelegateEngine).toBeDefined();

    // Bridge
    expect(v3.createAgentHandleBridge).toBeDefined();

    // System prompt
    expect(v3.buildV3SystemPrompt).toBeDefined();
  });
});
