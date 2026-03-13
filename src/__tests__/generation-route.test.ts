jest.mock('../loop/llm-service.js', () => ({
  runPrompt: jest.fn(),
}));

import { describe, expect, it, beforeEach } from '@jest/globals';
import { runPrompt } from '../loop/llm-service.js';
import { __testOnly } from '../dashboard/routes/generation.js';

const mockRunPrompt = runPrompt as jest.Mock;

describe('generation route script fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flags prose-only responses as invalid script-node code', () => {
    const validation = __testOnly.validateGeneratedScriptCode('I fixed the script for you.');

    expect(validation.ok).toBe(false);
    expect(validation.issues.join(' ')).toContain('Missing JSDoc block');
    expect(validation.issues.join(' ')).toContain('Missing required async function execute(inputs, context) signature');
  });

  it('uses strict fallback output to recover a valid Woodbury script', async () => {
    mockRunPrompt.mockResolvedValue({
      content: [
        '```javascript',
        '/**',
        ' * @input shotListData string "Raw shot list"',
        ' * @output parsedShotList object[] "Parsed shot list entries"',
        ' */',
        'async function execute(inputs, context) {',
        '  const lines = String(inputs.shotListData || "")',
        '    .split(/\\r?\\n/)',
        '    .map(line => line.trim())',
        '    .filter(Boolean);',
        '  return {',
        '    parsedShotList: lines.map((text, index) => ({ index: index + 1, text }))',
        '  };',
        '}',
        '```',
      ].join('\n'),
    });

    const assistantMessage = await __testOnly.runStrictScriptGenerationFallback(
      'Update Parse Shot List so it returns the object shape expected by downstream nodes.',
      '',
      {
        currentCode: 'const broken = true;',
        issues: ['Missing required async function execute(inputs, context) signature.'],
      },
    );

    const code = __testOnly.extractCodeBlock(assistantMessage);
    const validation = __testOnly.validateGeneratedScriptCode(code);

    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    expect(validation.ok).toBe(true);
    expect(code).toContain('@input shotListData string');
    expect(code).toContain('@output parsedShotList object[]');
    expect(code).toContain('async function execute(inputs, context)');
  });

  it('drops over-specific generated test expectations for parsed arrays', () => {
    const sanitized = __testOnly.sanitizeScriptGenerationTestCases([
      {
        name: 'numbered_shot_list',
        inputs: { shotListData: '1. Wide shot of a forest clearing' },
        requiredOutputKeys: ['parsedShotList'],
        expectedOutputSubset: {
          parsedShotList: [
            {
              prompt: 'Wide shot of a forest clearing',
              description: 'Wide shot of a forest clearing',
              index: 1,
              type: 'shot',
            },
          ],
        },
      },
    ], [
      { name: 'parsedShotList', type: 'object[]', description: 'Parsed shot list entries' },
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].requiredOutputKeys).toEqual(['parsedShotList']);
    expect(sanitized[0].expectedOutputSubset).toBeUndefined();
  });

  it('adds Woodbury built-in tooling guidance for collection requests', () => {
    const guidance = __testOnly.buildWoodburyBuiltinToolingGuidance(
      'The collection is a Woodbury collection and should be created using the Woodbury collection tools.',
    );

    expect(guidance).toContain('Woodbury-native asset or collection behavior');
    expect(guidance).toContain('context.tools.asset_collection_create');
    expect(guidance).toContain('context.tools.asset_save');
  });

  it('rejects code that ignores required Woodbury collection tools', () => {
    const validation = __testOnly.validateGeneratedScriptCode(
      `/**
 * @input name string "Collection name"
 * @output collection object "Collection"
 */
async function execute(inputs, context) {
  return { collection: { name: inputs.name } };
}`,
      {
        userMessage: 'The collection is a Woodbury collection and should be created using the Woodbury collection tools.',
      },
    );

    expect(validation.ok).toBe(false);
    expect(validation.issues.join(' ')).toContain('Missing required Woodbury asset/collection tool usage');
  });

  it('keeps valid pipeline script code without regenerating it', async () => {
    const result = await __testOnly.ensurePipelineScriptNodeCode(
      { workDir: process.cwd() } as any,
      {
        nodes: [
          {
            type: 'script',
            label: 'Parse Shot List',
            description: 'Parse the shot list into structured entries.',
            code: `/**
 * @input shot_list_data string "Raw shot list"
 * @output parsed_shot_list object[] "Parsed shot list entries"
 */
async function execute(inputs, context) {
  const lines = String(inputs.shot_list_data || '').split(/\\r?\\n/).filter(Boolean);
  return { parsed_shot_list: lines.map((text, index) => ({ index: index + 1, text })) };
}`,
          },
        ],
        connections: [],
      },
      0,
      '',
    );

    expect(mockRunPrompt).not.toHaveBeenCalled();
    expect(result.regenerated).toBe(false);
    expect(result.inputs).toHaveLength(1);
    expect(result.outputs).toHaveLength(1);
  });

  it('regenerates invalid pipeline script code before returning the pipeline node', async () => {
    mockRunPrompt.mockResolvedValue({
      content: [
        '```javascript',
        '/**',
        ' * @input shot_list_data string "Raw shot list"',
        ' * @output parsed_shot_list object[] "Parsed shot list entries"',
        ' */',
        'async function execute(inputs, context) {',
        '  const lines = String(inputs.shot_list_data || "")',
        '    .split(/\\r?\\n/)',
        '    .map(line => line.trim())',
        '    .filter(Boolean);',
        '  return {',
        '    parsed_shot_list: lines.map((text, index) => ({ index: index + 1, text }))',
        '  };',
        '}',
        '```',
      ].join('\n'),
    });

    const result = await __testOnly.ensurePipelineScriptNodeCode(
      { workDir: process.cwd() } as any,
      {
        nodes: [
          {
            type: 'text',
            label: 'Shot List Input',
            textNode: { value: '1. Wide shot of a forest clearing' },
          },
          {
            type: 'script',
            label: 'Parse Shot List',
            description: 'Parse the shot list into structured entries for downstream nodes.',
            code: 'I fixed the script for you.',
          },
        ],
        connections: [
          { from: 0, fromPort: 'text', to: 1, toPort: 'shot_list_data' },
        ],
      },
      1,
      '',
    );

    expect(mockRunPrompt.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.regenerated).toBe(true);
    expect(result.code).toContain('async function execute(inputs, context)');
    expect(result.inputs[0].name).toBe('shot_list_data');
    expect(result.outputs[0].name).toBe('parsed_shot_list');
    expect(result.transcript.length).toBeGreaterThan(0);
  });
});
