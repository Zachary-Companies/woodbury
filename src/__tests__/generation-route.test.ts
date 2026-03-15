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
    delete process.env.WOODBURY_SCRIPT_GENERATION_POLICY;
    delete process.env.WOODBURY_SCRIPT_GENERATION_MODE_GENERATE;
    delete process.env.WOODBURY_SCRIPT_GENERATION_MODE_EDIT;
    delete process.env.WOODBURY_SCRIPT_GENERATION_MODE_REPAIR;
    delete process.env.WOODBURY_SCRIPT_GENERATION_MODE_VERIFY;
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

  it('drops over-specific JSON-string expectations for large structured string outputs', () => {
    const sanitized = __testOnly.sanitizeScriptGenerationTestCases([
      {
        name: 'empty_script_plan',
        inputs: { scriptPlan: '[]' },
        requiredOutputKeys: ['generatedScenes'],
        expectedOutputSubset: {
          generatedScenes: '[{"sceneNumber":1,"location":"INT. UNKNOWN LOCATION - DAY","description":"Scene generation failed. Please check the script plan format."}]',
        },
      },
    ], [
      { name: 'generatedScenes', type: 'string', description: 'Serialized generated scenes array' },
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].requiredOutputKeys).toEqual(['generatedScenes']);
    expect(sanitized[0].expectedOutputSubset).toBeUndefined();
  });

  it('attaches declared output types to sanitized generated tests', () => {
    const sanitized = __testOnly.sanitizeScriptGenerationTestCases([
      {
        name: 'typed_output_contract',
        inputs: { prompt: 'Generate summary' },
        requiredOutputKeys: ['summary', 'items'],
      },
    ], [
      { name: 'summary', type: 'string', description: 'Summary text' },
      { name: 'items', type: 'object[]', description: 'Structured items' },
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].expectedOutputTypes).toEqual({
      summary: 'string',
      items: 'object[]',
    });
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

  it('does not require collection tools for incidental collection mentions in broader redesign context', () => {
    const validation = __testOnly.validateGeneratedScriptCode(
      `/**
 * @input character_images object[] "Character images"
 * @input script_content string "Script content"
 * @output script_document object "Compiled script document"
 */
async function execute(inputs, context) {
  return {
    script_document: {
      script: inputs.script_content,
      characterImages: Array.isArray(inputs.character_images) ? inputs.character_images.length : 0,
    },
  };
}`,
      {
        userMessage: 'Complete the script document. Other nodes in this redesign should save character images as assets in a collection specifically for the idea.',
      },
    );

    expect(validation.ok).toBe(true);
    expect(validation.issues.join(' ')).not.toContain('Missing required Woodbury asset/collection tool usage');
  });

  it('routes repair and verify generation through the agentic path by default', () => {
    expect(__testOnly.shouldUseDirectScriptGeneration('generate')).toBe(true);
    expect(__testOnly.shouldUseDirectScriptGeneration('edit')).toBe(true);
    expect(__testOnly.shouldUseDirectScriptGeneration('repair')).toBe(false);
    expect(__testOnly.shouldUseDirectScriptGeneration('verify')).toBe(false);
  });

  it('supports global rollout policy overrides for script generation', () => {
    process.env.WOODBURY_SCRIPT_GENERATION_POLICY = 'agentic';
    expect(__testOnly.readScriptGenerationRolloutPolicy()).toBe('agentic');
    expect(__testOnly.shouldUseDirectScriptGeneration('generate')).toBe(false);
    expect(__testOnly.shouldUseDirectScriptGeneration('repair')).toBe(false);

    process.env.WOODBURY_SCRIPT_GENERATION_POLICY = 'direct';
    expect(__testOnly.readScriptGenerationRolloutPolicy()).toBe('direct');
    expect(__testOnly.shouldUseDirectScriptGeneration('generate')).toBe(true);
    expect(__testOnly.shouldUseDirectScriptGeneration('repair')).toBe(true);
  });

  it('supports per-mode rollout overrides on top of the global policy', () => {
    process.env.WOODBURY_SCRIPT_GENERATION_POLICY = 'agentic';
    process.env.WOODBURY_SCRIPT_GENERATION_MODE_GENERATE = 'direct';
    process.env.WOODBURY_SCRIPT_GENERATION_MODE_VERIFY = 'agentic';

    expect(__testOnly.readScriptGenerationModeOverride('generate')).toBe('direct');
    expect(__testOnly.readScriptGenerationModeOverride('verify')).toBe('agentic');
    expect(__testOnly.shouldUseDirectScriptGeneration('generate')).toBe(true);
    expect(__testOnly.shouldUseDirectScriptGeneration('repair')).toBe(false);
    expect(__testOnly.shouldUseDirectScriptGeneration('verify')).toBe(false);

    expect(__testOnly.getScriptGenerationRolloutState()).toMatchObject({
      policy: 'agentic',
      modeOverrides: {
        generate: 'direct',
        edit: 'inherit',
        repair: 'inherit',
        verify: 'agentic',
      },
    });
  });

  it('builds pipeline script graph context with semantic contract hints', () => {
    const context = __testOnly.buildPipelineScriptGraphContext(
      {
        nodes: [
          {
            type: 'text',
            label: 'Idea Input',
            outputs: [{ name: 'text', type: 'string', description: 'Idea text' }],
          },
          {
            type: 'script',
            label: 'Build Outline',
            description: 'Turn the idea into a story outline.',
            inputs: [{ name: 'idea_text', type: 'string', description: 'Idea text' }],
            outputs: [{ name: 'outline', type: 'object', description: 'Story outline' }],
          },
          {
            type: 'script',
            label: 'Render Output',
            inputs: [{ name: 'outline', type: 'object', description: 'Story outline' }],
            outputs: [{ name: 'script_document', type: 'object', description: 'Final script document' }],
          },
        ],
        connections: [
          { from: 0, fromPort: 'text', to: 1, toPort: 'idea_text' },
          { from: 1, fromPort: 'outline', to: 2, toPort: 'outline' },
        ],
      },
      1,
    );

    expect(context.currentNode).toMatchObject({ label: 'Build Outline' });
    expect(context.upstream).toHaveLength(1);
    expect(context.downstream).toHaveLength(1);
    expect(context.pipelineInputs).toEqual([]);
    expect(context.pipelineOutputs).toEqual([
      expect.objectContaining({ name: 'script_document', type: 'object' }),
    ]);
  });

  it('formats semantic graph context with example values and documentation excerpts', () => {
    const formatted = __testOnly.formatSemanticGraphContext({
      currentNodeId: 'script-2',
      currentNode: {
        label: 'Finalize Script',
        inputs: [{ name: 'outline', type: 'object', description: 'Approved outline' }],
        outputs: [{ name: 'script_document', type: 'object', description: 'Final script document' }],
      },
      upstream: [
        {
          fromPort: 'outline',
          toPort: 'outline',
          node: { label: 'Build Outline' },
          expectedContract: 'outline object',
          latestValue: { title: 'Forest Rescue', acts: 3 },
        },
      ],
      downstream: [
        {
          fromPort: 'script_document',
          toPort: 'script_document',
          node: { label: 'Pipeline Output' },
          expectedContract: 'script_document object',
        },
      ],
      composition: {
        name: 'Story Builder',
        description: 'Turns an idea into a polished script document.',
      },
      generatedPipelineDocs: [
        {
          title: 'Story Builder Pipeline',
          summary: 'Outline first, then produce the final script document.',
          markdown: '# Story Builder\n\n## Steps\n1. Build Outline\n2. Finalize Script',
          nodeIds: ['script-2'],
        },
      ],
    });

    expect(formatted).toContain('Current node inputs:');
    expect(formatted).toContain('Latest value: {"title":"Forest Rescue","acts":3}');
    expect(formatted).toContain('Relevant pipeline documentation:');
    expect(formatted).toContain('Story Builder Pipeline');
  });

  it('formats composition interface contracts for prompt reuse', () => {
    const formatted = __testOnly.formatCompositionInterfaceContext({
      inputs: [
        { name: 'idea', type: 'string', description: 'Seed concept', required: true },
      ],
      outputs: [
        { name: 'script_document', type: 'object', description: 'Final screenplay package' },
      ],
    });

    expect(formatted).toContain('Composition interface contract:');
    expect(formatted).toContain('idea (string) [required]');
    expect(formatted).toContain('script_document (object)');
  });

  it('builds bounded sample execution tests from graph context upstream values', () => {
    const bounded = __testOnly.buildBoundedGenerateExecutionTests(
      [{ name: 'outline', type: 'object', description: 'Approved outline' }],
      [{ name: 'script_document', type: 'object', description: 'Final script document' }],
      {
        graphContext: {
          upstream: [
            {
              toPort: 'outline',
              latestValue: { title: 'Forest Rescue', acts: 3 },
            },
          ],
        },
      },
    );

    expect(bounded.source).toBe('graph_context');
    expect(bounded.tests).toHaveLength(1);
    expect(bounded.tests[0].inputs).toEqual({ outline: { title: 'Forest Rescue', acts: 3 } });
  });

  it('builds bounded sample execution tests from data context when upstream values are unavailable', () => {
    const bounded = __testOnly.buildBoundedGenerateExecutionTests(
      [{ name: 'records', type: 'object[]', description: 'Records to transform' }],
      [{ name: 'count', type: 'number', description: 'Record count' }],
      {
        dataContext: [{ id: 'r1' }, { id: 'r2' }],
      },
    );

    expect(bounded.source).toBe('data_context');
    expect(bounded.tests).toHaveLength(1);
    expect(bounded.tests[0].inputs).toEqual({ records: [{ id: 'r1' }, { id: 'r2' }] });
  });

  it('builds deterministic edge-case contract tests for empty, nullish, and wrong-type inputs', () => {
    const tests = __testOnly.buildEdgeCaseScriptContractTests(
      [{ name: 'count', type: 'number', description: 'Number of records' }],
      [{ name: 'summary', type: 'string', description: 'Summary string' }],
    );

    expect(tests.map((testCase) => testCase.name)).toEqual([
      'empty_input_contract',
      'nullish_input_contract',
      'wrong_type_input_contract',
    ]);
    expect(tests[0].inputs).toEqual({ count: 0 });
    expect(tests[1].inputs).toEqual({ count: null });
    expect(tests[2].inputs).toEqual({ count: 'not-a-number' });
  });

  it('builds progress contract tests for loop-heavy scripts that report progress', () => {
    const tests = __testOnly.buildProgressContractTests(
      `/**
 * @input items string[] "Items"
 * @output count number "Count"
 */
async function execute(inputs, context) {
  const items = Array.isArray(inputs.items) ? inputs.items : [];
  context.progress.start(items.length, 'Counting');
  for (const item of items) {
    context.progress.increment(item);
  }
  context.progress.complete('Done');
  return { count: items.length };
}`,
      [{ name: 'items', type: 'string[]', description: 'Items' }],
      [{ name: 'count', type: 'number', description: 'Count' }],
    );

    expect(tests).toHaveLength(1);
    expect(tests[0].requireProgressCalls).toBe(true);
    expect(tests[0].requireProgressCompletion).toBe(true);
  });

  it('summarizes persisted script generation metrics', () => {
    const summary = __testOnly.summarizeScriptGenerationMetrics([
      {
        timestamp: '2026-03-14T00:00:00.000Z',
        mode: 'generate',
        policy: 'mixed',
        metrics: {
          generationPath: 'direct',
          candidateCount: 3,
          retrievedExampleCount: 2,
          unitTestCount: 2,
          smokeTestCount: 1,
          repairAttemptCount: 0,
          runtimeEvidenceUsed: false,
          executionVerified: true,
          sampleExecutionCount: 1,
          sampleExecutionUsed: true,
          sampleExecutionSource: 'graph_context',
          manualEditCount: 0,
        },
      },
      {
        timestamp: '2026-03-14T00:01:00.000Z',
        mode: 'repair',
        policy: 'mixed',
        metrics: {
          generationPath: 'fallback',
          candidateCount: 1,
          retrievedExampleCount: 1,
          unitTestCount: 1,
          smokeTestCount: 1,
          repairAttemptCount: 1,
          runtimeEvidenceUsed: true,
          executionVerified: false,
          sampleExecutionCount: 0,
          sampleExecutionUsed: false,
          sampleExecutionSource: 'none',
          manualEditCount: 2,
        },
      },
    ]);

    expect(summary.totalRequests).toBe(2);
    expect(summary.byMode.generate).toBe(1);
    expect(summary.byMode.repair).toBe(1);
    expect(summary.byPath.direct).toBe(1);
    expect(summary.byPath.fallback).toBe(1);
    expect(summary.fallbackRate).toBe(0.5);
    expect(summary.repairRate).toBe(0.5);
    expect(summary.runtimeEvidenceRate).toBe(0.5);
    expect(summary.executionVerifiedRate).toBe(0.5);
    expect(summary.sampleExecutionRate).toBe(0.5);
    expect(summary.averageRetrievedExamples).toBe(1.5);
    expect(summary.averageManualEdits).toBe(1);
  });

  it('turns planner script intent and ports into a direct generation brief', () => {
    const brief = __testOnly.buildPipelineScriptGenerationDescription(
      'Parse the shot list into structured entries.',
      {
        inputs: [
          { name: 'shot_list_data', type: 'string', description: 'Raw shot list text' },
        ],
        outputs: [
          { name: 'parsed_shot_list', type: 'object[]', description: 'Structured shot list entries' },
        ],
      },
    );

    expect(brief).toContain('Parse the shot list into structured entries.');
    expect(brief).toContain('Required input ports:');
    expect(brief).toContain('shot_list_data (string): Raw shot list text');
    expect(brief).toContain('Required output ports:');
    expect(brief).toContain('parsed_shot_list (object[]): Structured shot list entries');
    expect(brief).toContain('Honor these exact port names');
  });

  it('builds durable generated pipeline documentation from the realized graph', () => {
    const documentation = __testOnly.buildGeneratedPipelineDocumentation(
      'Generate a poem and save it to disk.',
      'Poem Generator',
      [
        {
          id: 'text-1',
          workflowId: '__text__',
          label: 'Theme',
          textNode: { value: 'autumn leaves' },
        },
        {
          id: 'script-1',
          workflowId: '__script__',
          label: 'Generate Poem',
          script: {
            description: 'Generate a poem from the provided theme.',
            inputs: [
              { name: 'theme', type: 'string', description: 'The theme to write about' },
            ],
            outputs: [
              { name: 'poem', type: 'string', description: 'Generated poem text' },
              { name: 'title', type: 'string', description: 'Generated poem title' },
            ],
          },
        },
        {
          id: 'file-1',
          workflowId: '__file_op__',
          label: 'Save File',
          fileOp: { operation: 'copy' },
        },
      ],
      [
        { sourceNodeId: 'text-1', sourcePort: 'text', targetNodeId: 'script-1', targetPort: 'theme' },
        { sourceNodeId: 'script-1', sourcePort: 'poem', targetNodeId: 'file-1', targetPort: 'sourcePath' },
        { sourceNodeId: 'script-1', sourcePort: 'title', targetNodeId: 'file-1', targetPort: 'destinationPath' },
      ],
      {
        pipelineName: 'Poem Generator',
        targetOutputSummary: 'Produces a poem file from a theme.',
        targetOutputType: 'object',
        targetOutputFields: [],
        subContracts: [],
        assemblyStrategy: 'Generate the poem first, then hand its contents to the file step.',
        complexity: 'simple',
      },
      {
        inputs: [],
        outputs: [
          { name: 'outputPath', type: 'string', description: 'Copied file or folder path' },
          { name: 'success', type: 'boolean', description: 'Whether the copy completed' },
        ],
      },
    );

    expect(documentation.title).toBe('Poem Generator');
    expect(documentation.summary).toContain('Produces a poem file from a theme.');
    expect(documentation.markdown).toContain('## Interface Contract');
    expect(documentation.markdown).toContain('## Steps');
    expect(documentation.markdown).toContain('### 2. Generate Poem');
    expect(documentation.markdown).toContain('## Data Flow');
    expect(documentation.markdown).toContain('Generate Poem.poem -> Save File.sourcePath');
    expect(documentation.markdown).toContain('## Final Outputs');
  });

  it('normalizes generated pipeline node type aliases for built-in control flow and IO nodes', () => {
    expect(__testOnly.normalizeGeneratedPipelineNodeType('forLoop')).toBe('for_each');
    expect(__testOnly.normalizeGeneratedPipelineNodeType('for_each')).toBe('for_each');
    expect(__testOnly.normalizeGeneratedPipelineNodeType('__file_write__')).toBe('file_write');
    expect(__testOnly.normalizeGeneratedPipelineNodeType('readFile')).toBe('file_read');
    expect(__testOnly.normalizeGeneratedPipelineNodeType('jsonExtract')).toBe('json_keys');
    expect(__testOnly.normalizeGeneratedPipelineNodeType('output_node')).toBe('output');
  });

  it('materializes generated for-each nodes using the dashboard-native config shape', () => {
    const materialized = __testOnly.materializeGeneratedPipelineNode({
      type: 'forLoop',
      label: 'Iterate Scenes',
      forEachNode: {
        itemVariable: 'scene',
        maxIterations: 25,
      },
    }, 0);

    expect(materialized).not.toBeNull();
    expect(materialized!.workflowId).toBe('__for_each__');
    expect(materialized!.node).toMatchObject({
      workflowId: '__for_each__',
      label: 'Iterate Scenes',
      forEachNode: {
        itemVariable: 'scene',
        maxIterations: 25,
      },
    });
  });

  it('materializes generated output, variable, and file-write nodes without coercing them to script nodes', () => {
    const outputNode = __testOnly.materializeGeneratedPipelineNode({
      type: 'output',
      label: 'Pipeline Output',
      outputNode: {
        ports: [
          { name: 'summary', type: 'string', description: 'Final summary' },
        ],
      },
    }, 0);
    const variableNode = __testOnly.materializeGeneratedPipelineNode({
      type: 'variable',
      label: 'Audience',
      variableNode: {
        type: 'string',
        initialValue: 'creators',
        exposeAsInput: true,
        inputName: 'audience',
        description: 'Target audience',
        required: true,
      },
    }, 1);
    const fileWriteNode = __testOnly.materializeGeneratedPipelineNode({
      type: 'file_write',
      label: 'Save JSON',
      fileWriteNode: {
        mode: 'append',
        format: 'json',
        prettyPrint: false,
      },
    }, 2);

    expect(outputNode!.workflowId).toBe('__output__');
    expect(outputNode!.node).toMatchObject({
      workflowId: '__output__',
      outputNode: {
        ports: [
          { name: 'summary', type: 'string', description: 'Final summary' },
        ],
      },
    });
    expect(variableNode!.workflowId).toBe('__variable__');
    expect(variableNode!.node).toMatchObject({
      workflowId: '__variable__',
      variableNode: {
        type: 'string',
        initialValue: 'creators',
        exposeAsInput: true,
        inputName: 'audience',
        description: 'Target audience',
        required: true,
      },
    });
    expect(fileWriteNode!.workflowId).toBe('__file_write__');
    expect(fileWriteNode!.node).toMatchObject({
      workflowId: '__file_write__',
      fileWriteNode: {
        mode: 'append',
        format: 'json',
        prettyPrint: false,
      },
    });
  });

  it('builds documentation for an existing pipeline without a decomposition plan', () => {
    const documentation = __testOnly.buildGeneratedPipelineDocumentation(
      '',
      'Existing Pipeline',
      [
        {
          id: 'script-1',
          workflowId: '__script__',
          label: 'Transform Data',
          script: {
            description: 'Normalize inbound records.',
            inputs: [
              { name: 'records', type: 'object[]', description: 'Incoming records' },
            ],
            outputs: [
              { name: 'normalized_records', type: 'object[]', description: 'Normalized records' },
            ],
          },
        },
      ],
      [],
      null,
      {
        inputs: [
          { name: 'records', type: 'object[]', description: 'Incoming records', required: true },
        ],
        outputs: [
          { name: 'normalized_records', type: 'object[]', description: 'Normalized records' },
        ],
      },
    );

    expect(documentation.title).toBe('Existing Pipeline');
    expect(documentation.summary).toContain('Generated pipeline with 1 step');
    expect(documentation.markdown).toContain('## Interface Contract');
    expect(documentation.markdown).toContain('records (object[]) [required]');
    expect(documentation.markdown).toContain('## External Inputs');
    expect(documentation.markdown).toContain('Transform Data.records (object[])');
    expect(documentation.markdown).toContain('## Final Outputs');
    expect(documentation.markdown).toContain('Transform Data.normalized_records (object[])');
  });

  it('uses output node ports as the pipeline final outputs', () => {
    const documentation = __testOnly.buildGeneratedPipelineDocumentation(
      'Return the final text through the output node.',
      'Output Node Pipeline',
      [
        {
          id: 'script-1',
          workflowId: '__script__',
          label: 'Generate Text',
          script: {
            description: 'Produce the final text payload.',
            inputs: [],
            outputs: [
              { name: 'final_text', type: 'string', description: 'Final rendered text' },
            ],
          },
        },
        {
          id: 'output-1',
          workflowId: '__output__',
          label: 'Pipeline Output',
          outputNode: {
            ports: [
              { name: 'final_text', type: 'string', description: 'Final rendered text' },
            ],
          },
        },
      ],
      [
        { sourceNodeId: 'script-1', sourcePort: 'final_text', targetNodeId: 'output-1', targetPort: 'final_text' },
      ],
      null,
    );

    expect(documentation.markdown).toContain('## Final Outputs');
    expect(documentation.markdown).toContain('Pipeline Output.final_text (string) - Final rendered text');
    expect(documentation.markdown).not.toContain('No terminal outputs were detected.');
  });

  it('regenerates pipeline script code even when the planner supplied a valid implementation', async () => {
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
        '  await context.log(`Parsed ${lines.length} shot list entries.`);',
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
            type: 'script',
            label: 'Parse Shot List',
            description: 'Parse the shot list into structured entries.',
            inputs: [
              { name: 'shot_list_data', type: 'string', description: 'Raw shot list' },
            ],
            outputs: [
              { name: 'parsed_shot_list', type: 'object[]', description: 'Parsed shot list entries' },
            ],
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

    expect(mockRunPrompt.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.regenerated).toBe(true);
    expect(result.inputs).toHaveLength(1);
    expect(result.outputs).toHaveLength(1);
    expect(result.code).toContain('await context.log');
  });

  it('generates pipeline script code from planner intent and ports without inline code', async () => {
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
            inputs: [
              { name: 'shot_list_data', type: 'string', description: 'Raw shot list' },
            ],
            outputs: [
              { name: 'parsed_shot_list', type: 'object[]', description: 'Structured shot list entries' },
            ],
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
    expect(mockRunPrompt.mock.calls[0][0][1].content).toContain('Required input ports:');
    expect(mockRunPrompt.mock.calls[0][0][1].content).toContain('shot_list_data (string): Raw shot list');
  });

  it('generates a structured pre-plan from a description and graph context', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        intent: 'Parse shot list text into structured entries',
        inputs: [{ name: 'shot_list_data', type: 'string', description: 'Raw shot list text', source: 'Shot List Input.text' }],
        outputs: [{ name: 'parsed_shots', type: 'object[]', description: 'Structured shot entries' }],
        tools: [],
        approach: ['Split input by newlines', 'Parse each line into a structured object', 'Return array of objects'],
        edgeCases: ['Handle empty input gracefully'],
      }),
    });

    const plan = await __testOnly.generateScriptPrePlan(
      'Parse the shot list into structured entries.\n\nRelevant pipeline graph context:\nUpstream node "Shot List Input" provides port "shot_list_data" (string)',
      '',
    );

    expect(plan).not.toBeNull();
    expect(plan!.intent).toContain('Parse');
    expect(plan!.inputs).toHaveLength(1);
    expect(plan!.inputs[0].name).toBe('shot_list_data');
    expect(plan!.inputs[0].source).toBe('Shot List Input.text');
    expect(plan!.outputs).toHaveLength(1);
    expect(plan!.outputs[0].name).toBe('parsed_shots');
    expect(plan!.approach.length).toBeGreaterThan(0);
    expect(plan!.edgeCases.length).toBeGreaterThan(0);
  });

  it('returns null when the plan LLM call returns invalid JSON', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: 'I am not JSON, sorry!',
    });

    const plan = await __testOnly.generateScriptPrePlan(
      'Do something complex.',
      '',
    );

    expect(plan).toBeNull();
  });

  it('returns null when the plan LLM call throws an error', async () => {
    mockRunPrompt.mockRejectedValueOnce(new Error('API timeout'));

    const plan = await __testOnly.generateScriptPrePlan(
      'Do something complex.',
      '',
    );

    expect(plan).toBeNull();
  });

  it('returns null when the plan response is missing required fields', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        intent: 'Do something',
        // missing inputs, outputs, approach
      }),
    });

    const plan = await __testOnly.generateScriptPrePlan(
      'Do something.',
      '',
    );

    expect(plan).toBeNull();
  });

  it('formats a pre-plan into a readable prompt section', () => {
    const formatted = __testOnly.formatPrePlanForPrompt({
      intent: 'Parse text into structured entries',
      inputs: [{ name: 'raw_text', type: 'string', description: 'Input text', source: 'TextNode.text' }],
      outputs: [{ name: 'parsed', type: 'object[]', description: 'Parsed result' }],
      tools: ['context.llm.generateJSON'],
      approach: ['Split text by newlines', 'Map each line to a structured object'],
      edgeCases: ['Handle empty string'],
    });

    expect(formatted).toContain('## Pre-Generation Plan');
    expect(formatted).toContain('Intent: Parse text into structured entries');
    expect(formatted).toContain('raw_text (string): Input text [from: TextNode.text]');
    expect(formatted).toContain('parsed (object[]): Parsed result');
    expect(formatted).toContain('Tools to use: context.llm.generateJSON');
    expect(formatted).toContain('1. Split text by newlines');
    expect(formatted).toContain('2. Map each line to a structured object');
    expect(formatted).toContain('Handle empty string');
    expect(formatted).toContain('Follow this plan exactly');
  });

  it('formats a pre-plan with no tools and no edge cases', () => {
    const formatted = __testOnly.formatPrePlanForPrompt({
      intent: 'Sum numbers',
      inputs: [{ name: 'numbers', type: 'number[]', description: 'Array of numbers' }],
      outputs: [{ name: 'total', type: 'number', description: 'Sum' }],
      tools: [],
      approach: ['Iterate over input array', 'Accumulate sum', 'Return total'],
      edgeCases: [],
    });

    expect(formatted).toContain('Tools: none needed');
    expect(formatted).not.toContain('Edge cases to handle:');
  });

  it('accepts a valid coordinated redesign plan for selected script and text nodes', () => {
    const plan = __testOnly.validateSelectionRedesignPlan({
      summary: 'Tighten the handoff between idea and script parsing.',
      updates: [
        {
          nodeId: 'script-1',
          label: 'Generate Script Structure',
          description: 'Turn the creative idea into a normalized script structure.',
          inputs: [{ name: 'creative_idea', type: 'string', description: 'Source idea text' }],
          outputs: [{ name: 'script_outline', type: 'object', description: 'Normalized script structure' }],
        },
        {
          nodeId: 'text-1',
          label: 'Genre Input',
          textValue: 'neo-noir mystery',
        },
      ],
    }, [
      { nodeId: 'script-1', workflowId: '__script__', label: 'Script A' },
      { nodeId: 'text-1', workflowId: '__text__', label: 'Text A' },
    ]);

    expect(plan).not.toBeNull();
    expect(plan!.updates).toHaveLength(2);
    expect(plan!.updates[0].description).toContain('normalized script structure');
    expect(plan!.updates[1].textValue).toBe('neo-noir mystery');
  });

  it('accepts coordinated redesign plans with extra script fields and common aliases', () => {
    const plan = __testOnly.validateSelectionRedesignPlan({
      summary: 'Lenient redesign',
      nodes: [
        {
          id: 'script-1',
          intent: 'Rewrite script.',
          code: 'async function execute() {}',
          inputContract: [{ name: 'idea', type: 'string', description: 'Idea' }],
          outputContract: [{ name: 'outline', type: 'object', description: 'Outline' }],
        },
      ],
    }, [
      { nodeId: 'script-1', workflowId: '__script__', label: 'Script A' },
    ]);

    expect(plan).not.toBeNull();
    expect(plan!.updates).toHaveLength(1);
    expect(plan!.updates[0].nodeId).toBe('script-1');
    expect(plan!.updates[0].description).toBe('Rewrite script.');
    expect(plan!.updates[0].inputs).toHaveLength(1);
  });

  it('accepts coordinated redesign plans with connection rewires', () => {
    const plan = __testOnly.validateSelectionRedesignPlan({
      summary: 'Reconnect the parsing flow.',
      updates: [
        {
          nodeId: 'script-1',
          description: 'Normalize the raw idea into a prompt object.',
          inputs: [{ name: 'idea', type: 'string', description: 'Idea text' }],
          outputs: [{ name: 'prompt_object', type: 'object', description: 'Prompt payload' }],
        },
        {
          nodeId: 'script-2',
          description: 'Turn the prompt object into scenes.',
          inputs: [{ name: 'prompt_object', type: 'object', description: 'Prompt payload' }],
          outputs: [{ name: 'scenes', type: 'object[]', description: 'Generated scenes' }],
        },
      ],
      connections: [
        {
          sourceNodeId: 'script-1',
          sourcePort: 'prompt_object',
          targetNodeId: 'script-2',
          targetPort: 'prompt_object',
        },
      ],
    }, [
      { nodeId: 'script-1', workflowId: '__script__', label: 'Prompt Builder' },
      { nodeId: 'script-2', workflowId: '__script__', label: 'Scene Builder' },
    ]);

    expect(plan).not.toBeNull();
    expect(plan!.connections).toHaveLength(1);
    expect(plan!.connections![0].sourcePort).toBe('prompt_object');
    expect(plan!.connections![0].targetNodeId).toBe('script-2');
  });

  it('accepts coordinated redesign plans with boundary output-node rewires', () => {
    const plan = __testOnly.validateSelectionRedesignPlan({
      summary: 'Reconnect the redesigned node to the pipeline output.',
      updates: [
        {
          nodeId: 'script-1',
          description: 'Generate the pre-visuals bundle and expose it for final output collection.',
          inputs: [{ name: 'camera_shots', type: 'object[]', description: 'Shot list' }],
          outputs: [{ name: 'pre_visuals', type: 'object[]', description: 'Generated pre-visual assets' }],
        },
      ],
      connections: [
        {
          sourceNodeId: 'script-1',
          sourcePort: 'pre_visuals',
          targetNodeId: 'output-1',
          targetPort: 'pre_visuals',
        },
      ],
    }, [
      { nodeId: 'script-1', workflowId: '__script__', label: 'Pre-Visuals' },
    ]);

    expect(plan).not.toBeNull();
    expect(plan!.connections).toHaveLength(1);
    expect(plan!.connections![0].targetNodeId).toBe('output-1');
    expect(plan!.connections![0].targetPort).toBe('pre_visuals');
  });

  it('injects the pre-plan into the generation system prompt', async () => {
    mockRunPrompt.mockResolvedValue({
      content: [
        '```javascript',
        '/**',
        ' * @input raw_text string "Text to parse"',
        ' * @output shots object[] "Parsed shots"',
        ' */',
        'async function execute(inputs, context) {',
        '  return { shots: [] };',
        '}',
        '```',
      ].join('\n'),
    });

    await __testOnly.runStrictScriptGenerationFallback(
      'Parse shot list text.',
      '',
      {
        prePlan: {
          intent: 'Parse shot list text into structured entries',
          inputs: [{ name: 'raw_text', type: 'string', description: 'Text to parse' }],
          outputs: [{ name: 'shots', type: 'object[]', description: 'Parsed shots' }],
          tools: [],
          approach: ['Split by newlines', 'Map to objects'],
          edgeCases: ['Empty input'],
        },
      },
    );

    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    const systemPrompt = mockRunPrompt.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('Pre-Generation Plan');
    expect(systemPrompt).toContain('raw_text (string): Text to parse');
    expect(systemPrompt).toContain('shots (object[]): Parsed shots');
    expect(systemPrompt).toContain('Follow this plan exactly');
  });

  // ── Pipeline decomposition tests ────────────────────────────

  it('generates a valid pipeline decomposition plan from a description', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        pipelineName: 'Script Document Generator',
        targetOutputSummary: 'A structured screenplay document',
        targetOutputType: 'ScriptDocument',
        targetOutputFields: [
          { name: 'metadata', type: 'object', description: 'Title, logline, genre' },
          { name: 'cast', type: 'object[]', description: 'Character definitions' },
        ],
        subContracts: [
          {
            name: 'generateMetadata',
            description: 'Generate script metadata from user prompt',
            suggestedNodeType: 'script',
            inputContract: [
              { name: 'prompt', type: 'string', description: 'User prompt', source: 'user_input' },
            ],
            outputContract: [
              { name: 'metadata', type: 'object', description: 'Script metadata' },
            ],
            dependsOn: [],
          },
          {
            name: 'generateCast',
            description: 'Generate character definitions',
            suggestedNodeType: 'script',
            inputContract: [
              { name: 'metadata', type: 'object', description: 'Script metadata', source: 'generateMetadata' },
            ],
            outputContract: [
              { name: 'cast', type: 'object[]', description: 'Character definitions' },
            ],
            dependsOn: ['generateMetadata'],
          },
        ],
        assemblyStrategy: 'Combine metadata and cast into ScriptDocument',
        complexity: 'moderate',
      }),
    });

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Build a screenwriting document generator',
      '',
      '',
    );

    expect(plan).not.toBeNull();
    expect(plan!.pipelineName).toBe('Script Document Generator');
    expect(plan!.subContracts).toHaveLength(2);
    expect(plan!.subContracts[0].name).toBe('generateMetadata');
    expect(plan!.subContracts[1].name).toBe('generateCast');
    expect(plan!.subContracts[1].dependsOn).toEqual(['generateMetadata']);
    expect(plan!.complexity).toBe('moderate');
  });

  it('returns null for decomposition plan with invalid JSON', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: 'This is not JSON at all!',
    });

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Build something complex.',
      '',
      '',
    );

    expect(plan).toBeNull();
  });

  it('returns null for decomposition plan with circular dependencies', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        pipelineName: 'Circular Pipeline',
        targetOutputSummary: 'A thing',
        targetOutputType: 'object',
        targetOutputFields: [],
        subContracts: [
          {
            name: 'contractA',
            description: 'Does A',
            suggestedNodeType: 'script',
            inputContract: [{ name: 'b_data', type: 'object', description: 'From B', source: 'contractB' }],
            outputContract: [{ name: 'a_data', type: 'object', description: 'A output' }],
            dependsOn: ['contractB'],
          },
          {
            name: 'contractB',
            description: 'Does B',
            suggestedNodeType: 'script',
            inputContract: [{ name: 'a_data', type: 'object', description: 'From A', source: 'contractA' }],
            outputContract: [{ name: 'b_data', type: 'object', description: 'B output' }],
            dependsOn: ['contractA'],
          },
        ],
        assemblyStrategy: 'None',
        complexity: 'moderate',
      }),
    });

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Something circular.',
      '',
      '',
    );

    expect(plan).toBeNull();
  });

  it('returns null for decomposition plan with invalid source references', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        pipelineName: 'Bad Refs',
        targetOutputSummary: 'A thing',
        targetOutputType: 'object',
        targetOutputFields: [],
        subContracts: [
          {
            name: 'nodeA',
            description: 'Does A',
            suggestedNodeType: 'script',
            inputContract: [{ name: 'data', type: 'string', description: 'From nowhere', source: 'nonExistentContract' }],
            outputContract: [{ name: 'result', type: 'string', description: 'Result' }],
            dependsOn: [],
          },
        ],
        assemblyStrategy: 'None',
        complexity: 'simple',
      }),
    });

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Something with bad refs.',
      '',
      '',
    );

    expect(plan).toBeNull();
  });

  it('formats a decomposition plan into a readable prompt section', () => {
    const formatted = __testOnly.formatDecompositionPlanForPipelinePrompt({
      pipelineName: 'Script Generator',
      targetOutputSummary: 'A structured screenplay document',
      targetOutputType: 'ScriptDocument',
      targetOutputFields: [
        { name: 'metadata', type: 'object', description: 'Title and logline' },
        { name: 'cast', type: 'object[]', description: 'Characters' },
      ],
      subContracts: [
        {
          name: 'generateMetadata',
          description: 'Generate script metadata from prompt',
          suggestedNodeType: 'script',
          inputContract: [{ name: 'prompt', type: 'string', description: 'User prompt', source: 'user_input' }],
          outputContract: [{ name: 'metadata', type: 'object', description: 'Script metadata' }],
          dependsOn: [],
        },
        {
          name: 'generateCast',
          description: 'Generate character definitions',
          suggestedNodeType: 'script',
          inputContract: [{ name: 'metadata', type: 'object', description: 'Script metadata', source: 'generateMetadata' }],
          outputContract: [{ name: 'cast', type: 'object[]', description: 'Character array' }],
          dependsOn: ['generateMetadata'],
        },
      ],
      assemblyStrategy: 'Merge all sub-contract outputs into ScriptDocument',
      complexity: 'moderate',
    });

    expect(formatted).toContain('CONTRACT-DRIVEN DECOMPOSITION PLAN');
    expect(formatted).toContain('Target output: A structured screenplay document');
    expect(formatted).toContain('Output type: ScriptDocument');
    expect(formatted).toContain('Complexity: moderate');
    expect(formatted).toContain('metadata (object): Title and logline');
    expect(formatted).toContain('[generateMetadata] (script)');
    expect(formatted).toContain('[generateCast] (script)');
    expect(formatted).toContain('Depends on: generateMetadata');
    expect(formatted).toContain('prompt (string): User prompt [from: user_input]');
    expect(formatted).toContain('cast (object[]): Character array');
    expect(formatted).toContain('Assembly: Merge all sub-contract outputs into ScriptDocument');
    expect(formatted).toContain('Create exactly one pipeline node per sub-contract');
  });

  it('accepts decomposition plans that recommend built-in loop nodes', () => {
    const valid = __testOnly.validateDecompositionPlan({
      pipelineName: 'Scene Iterator',
      targetOutputSummary: 'Expanded scenes',
      targetOutputType: 'object[]',
      targetOutputFields: [],
      subContracts: [
        {
          name: 'iterateScenes',
          description: 'Loop over scene prompts and process each one',
          suggestedNodeType: 'forLoop',
          inputContract: [
            { name: 'items', type: 'object[]', description: 'Scenes to iterate', source: 'user_input' },
          ],
          outputContract: [
            { name: 'results', type: 'object[]', description: 'Processed scenes' },
          ],
          dependsOn: [],
        },
      ],
      assemblyStrategy: 'Return the loop results directly.',
      complexity: 'simple',
    });

    expect(valid).not.toBeNull();
    expect(valid!.subContracts[0].suggestedNodeType).toBe('for_each');
  });

  it('returns null for decomposition when LLM throws', async () => {
    mockRunPrompt.mockRejectedValueOnce(new Error('Network timeout'));

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Build something complex.',
      '',
      '',
    );

    expect(plan).toBeNull();
  });

  it('validates a simple decomposition plan with 2 sub-contracts', async () => {
    mockRunPrompt.mockResolvedValueOnce({
      content: JSON.stringify({
        pipelineName: 'Simple Parser',
        targetOutputSummary: 'Parsed text output',
        targetOutputType: 'object',
        targetOutputFields: [{ name: 'result', type: 'string', description: 'Parsed result' }],
        subContracts: [
          {
            name: 'readInput',
            description: 'Read and normalize the input text',
            suggestedNodeType: 'script',
            inputContract: [{ name: 'raw_text', type: 'string', description: 'Raw input', source: 'user_input' }],
            outputContract: [{ name: 'normalized_text', type: 'string', description: 'Cleaned text' }],
            dependsOn: [],
          },
          {
            name: 'parseText',
            description: 'Parse the normalized text into structured output',
            suggestedNodeType: 'script',
            inputContract: [{ name: 'normalized_text', type: 'string', description: 'Cleaned text', source: 'readInput' }],
            outputContract: [{ name: 'result', type: 'string', description: 'Parsed result' }],
            dependsOn: ['readInput'],
          },
        ],
        assemblyStrategy: 'Final node produces the result directly',
        complexity: 'simple',
      }),
    });

    const plan = await __testOnly.generatePipelineDecompositionPlan(
      'Parse some text.',
      '',
      '',
    );

    expect(plan).not.toBeNull();
    expect(plan!.complexity).toBe('simple');
    expect(plan!.subContracts).toHaveLength(2);
    expect(plan!.subContracts[0].name).toBe('readInput');
    expect(plan!.subContracts[1].dependsOn).toEqual(['readInput']);
  });

  it('validates decomposition plan directly via validateDecompositionPlan', () => {
    // Valid plan
    const valid = __testOnly.validateDecompositionPlan({
      pipelineName: 'Test',
      targetOutputSummary: 'A test output',
      targetOutputType: 'object',
      targetOutputFields: [],
      subContracts: [
        {
          name: 'step1',
          description: 'First step',
          suggestedNodeType: 'script',
          inputContract: [{ name: 'data', type: 'string', description: 'Input', source: 'user_input' }],
          outputContract: [{ name: 'result', type: 'string', description: 'Result' }],
          dependsOn: [],
        },
      ],
      assemblyStrategy: 'Direct',
      complexity: 'simple',
    });
    expect(valid).not.toBeNull();
    expect(valid!.pipelineName).toBe('Test');

    // Missing pipelineName
    expect(__testOnly.validateDecompositionPlan({
      targetOutputSummary: 'A test',
      subContracts: [{ name: 'a', description: 'A', inputContract: [], outputContract: [], dependsOn: [] }],
    })).toBeNull();

    // Empty subContracts
    expect(__testOnly.validateDecompositionPlan({
      pipelineName: 'Test',
      targetOutputSummary: 'A test',
      subContracts: [],
    })).toBeNull();

    // Null input
    expect(__testOnly.validateDecompositionPlan(null)).toBeNull();
  });
});
