/**
 * Tests for toOpenAIChatMessages().
 *
 * AgentV2 records tool use in Anthropic's block format: an assistant message
 * holding `tool_use` blocks, then a *user* message holding `tool_result` blocks.
 * The OpenAI-compatible providers (OpenAI, Ollama) used to receive those blocks
 * flattened by contentToString(), i.e. `JSON.stringify(block)` pasted into
 * prose — no tool_calls, no tool_call_id, no way to continue the loop.
 */

import { toOpenAIChatMessages } from '../loop/v2/core/provider-adapter';

describe('toOpenAIChatMessages', () => {
  it('passes plain string messages through unchanged', () => {
    const out = toOpenAIChatMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ] as any);

    expect(out).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('maps tool_use blocks to native tool_calls', () => {
    const out = toOpenAIChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look that up.' },
          { type: 'tool_use', id: 'call_1', name: 'file_read', input: { path: 'a.ts' } },
        ],
      },
    ] as any);

    expect(out).toHaveLength(1);
    const msg = out[0] as any;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Let me look that up.');
    expect(msg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'file_read', arguments: JSON.stringify({ path: 'a.ts' }) },
      },
    ]);
    // The block must not also be stringified into the prose.
    expect(msg.content).not.toContain('tool_use');
  });

  it('maps tool_result blocks to tool messages keyed by tool_call_id', () => {
    const out = toOpenAIChatMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents here' },
        ],
      },
    ] as any);

    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
    ]);
  });

  it('keeps a full tool round trip linkable end to end', () => {
    const out = toOpenAIChatMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_abc', name: 'file_read', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'export const a = 1;' }],
      },
    ] as any);

    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);

    const assistant = out[2] as any;
    const toolMsg = out[3] as any;
    // The id the assistant announced must be the id the result answers.
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('emits tool messages immediately after the assistant turn, before any text', () => {
    // The API requires tool messages to directly follow the assistant message
    // carrying their tool_calls — stray text must not be interleaved between.
    const out = toOpenAIChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'and also, some extra commentary' },
          { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
        ],
      },
    ] as any);

    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect((out[2] as any).content).toBe('and also, some extra commentary');
  });

  it('splits parallel tool calls into one tool message each', () => {
    const out = toOpenAIChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'a', input: {} },
          { type: 'tool_use', id: 'c2', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'ra' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'rb' },
        ],
      },
    ] as any);

    const assistant = out[0] as any;
    expect(assistant.tool_calls).toHaveLength(2);
    expect(out.slice(1).map((m: any) => [m.role, m.tool_call_id, m.content])).toEqual([
      ['tool', 'c1', 'ra'],
      ['tool', 'c2', 'rb'],
    ]);
  });

  it('serializes non-string tool_result content', () => {
    const out = toOpenAIChatMessages([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: { rows: 3 } as any }],
      },
    ] as any);

    expect((out[0] as any).content).toBe(JSON.stringify({ rows: 3 }));
  });

  it('uses null content for a tool call with no accompanying text', () => {
    const out = toOpenAIChatMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
    ] as any);

    expect((out[0] as any).content).toBeNull();
  });

  it('defaults missing tool input to an empty object', () => {
    const out = toOpenAIChatMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't' }] },
    ] as any);

    expect((out[0] as any).tool_calls[0].function.arguments).toBe('{}');
  });

  it('flattens a text-only block array to a plain string', () => {
    const out = toOpenAIChatMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'just prose' }] },
    ] as any);

    expect(out).toEqual([{ role: 'assistant', content: 'just prose' }]);
  });
});
