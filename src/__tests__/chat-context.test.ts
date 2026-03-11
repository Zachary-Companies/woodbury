import {
  buildCompressedPrompt,
  compressChatHistory,
} from '../dashboard/routes/chat';

describe('chat compressed context', () => {
  it('compresses older turns into a rolling summary and keeps recent turns verbatim', () => {
    const history = [
      { role: 'user' as const, content: 'Turn 1 user request about brand assets' },
      { role: 'assistant' as const, content: 'Turn 2 assistant response about brand assets' },
      { role: 'user' as const, content: 'Turn 3 user request about scheduling' },
      { role: 'assistant' as const, content: 'Turn 4 assistant response about scheduling' },
      { role: 'user' as const, content: 'Turn 5 user request about pipeline edits' },
      { role: 'assistant' as const, content: 'Turn 6 assistant response about pipeline edits' },
      { role: 'user' as const, content: 'Turn 7 user asks to continue' },
      { role: 'assistant' as const, content: 'Turn 8 assistant acknowledges continue' },
    ];

    const compressed = compressChatHistory(history);

    expect(compressed.summaryTurnCount).toBe(2);
    expect(compressed.rollingSummary).toContain('1. User: Turn 1 user request about brand assets');
    expect(compressed.rollingSummary).toContain('2. Assistant: Turn 2 assistant response about brand assets');
    expect(compressed.recentTurns).toHaveLength(6);
    expect(compressed.recentTurns[0].content).toContain('Turn 3 user request about scheduling');
    expect(compressed.recentTurns[5].content).toContain('Turn 8 assistant acknowledges continue');
  });

  it('builds a prompt from summary, recent turns, and the latest user message', () => {
    const prompt = buildCompressedPrompt({
      sessionSummary: '1. User: Earlier request\n2. Assistant: Earlier response',
      summaryTurnCount: 2,
      recentTurns: [
        { role: 'user', content: 'Recent request' },
        { role: 'assistant', content: 'Recent response' },
      ],
      message: 'Please continue the pipeline work.',
    });

    expect(prompt).toContain('<conversation_summary turns="2">');
    expect(prompt).toContain('Earlier request');
    expect(prompt).toContain('<recent_turns>');
    expect(prompt).toContain('<turn role="user">\nRecent request\n</turn>');
    expect(prompt).toContain('For pipeline/workflow creation, you MUST use the mcp__intelligence__ tools.');
    expect(prompt.trim().endsWith('Please continue the pipeline work.')).toBe(true);
  });
});
