import { describe, expect, it } from '@jest/globals';
import { __testOnly } from '../dashboard/routes/generation.js';
import { runGeneratedScriptUnitTests } from '../dashboard/script-generation-tests.js';

describe('script generation benchmark fixtures', () => {
  const fixtures = [
    {
      name: 'counts records from data context',
      code: `/**
 * @input records object[] "Records to summarize"
 * @output count number "Record count"
 */
async function execute(inputs, context) {
  const records = Array.isArray(inputs.records) ? inputs.records : [];
  return { count: records.length };
}`,
      inputs: [{ name: 'records', type: 'object[]', description: 'Records to summarize' }],
      outputs: [{ name: 'count', type: 'number', description: 'Record count' }],
      options: { dataContext: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] },
      expectedSource: 'data_context',
    },
    {
      name: 'renders outline title from graph context',
      code: `/**
 * @input outline object "Approved outline"
 * @output script_document object "Final script package"
 */
async function execute(inputs, context) {
  const outline = inputs.outline || {};
  return {
    script_document: {
      title: outline.title || 'Untitled',
      acts: outline.acts || 0,
    },
  };
}`,
      inputs: [{ name: 'outline', type: 'object', description: 'Approved outline' }],
      outputs: [{ name: 'script_document', type: 'object', description: 'Final script package' }],
      options: {
        graphContext: {
          upstream: [
            {
              toPort: 'outline',
              latestValue: { title: 'Forest Rescue', acts: 3 },
            },
          ],
        },
      },
      expectedSource: 'graph_context',
    },
    {
      name: 'fills missing secondary inputs with safe defaults',
      code: `/**
 * @input text string "Source text"
 * @input suffix string "Suffix"
 * @output combined string "Combined text"
 */
async function execute(inputs, context) {
  return { combined: String(inputs.text || '') + String(inputs.suffix || '') };
}`,
      inputs: [
        { name: 'text', type: 'string', description: 'Source text' },
        { name: 'suffix', type: 'string', description: 'Suffix' },
      ],
      outputs: [{ name: 'combined', type: 'string', description: 'Combined text' }],
      options: { dataContext: { text: 'Woodbury' } },
      expectedSource: 'data_context',
    },
  ] as const;

  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const bounded = __testOnly.buildBoundedGenerateExecutionTests(
        fixture.inputs.map((port) => ({ ...port })),
        fixture.outputs.map((port) => ({ ...port })),
        fixture.options,
      );

      expect(bounded.source).toBe(fixture.expectedSource);
      expect(bounded.tests).toHaveLength(1);

      const results = await runGeneratedScriptUnitTests(fixture.code, bounded.tests);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  }
});