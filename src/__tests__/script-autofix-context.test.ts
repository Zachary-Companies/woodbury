import { describe, expect, it } from '@jest/globals';
import {
  buildScriptAutoFixGraphContext,
  summarizeAutoFixValue,
} from '../dashboard/script-autofix-context.js';

describe('buildScriptAutoFixGraphContext', () => {
  it('includes upstream runtime values and downstream node contracts for a failing script', () => {
    const context = buildScriptAutoFixGraphContext({
      nodeId: 'parser',
      nodes: [
        {
          id: 'source',
          workflowId: '__script__',
          label: 'Screenplay Generator',
          script: {
            code: `/**\n * @output {string} ScreenPlay - Generated screenplay\n */\nasync function execute(inputs, context) {\n  return { ScreenPlay: 'hi' };\n}`,
          },
        },
        {
          id: 'parser',
          workflowId: '__script__',
          label: 'Scene Parser',
          script: {
            code: `/**\n * @input {string} screenplay - Full screenplay\n * @output {string[]} scenes - Parsed scenes\n */\nasync function execute(inputs, context) {\n  return { scenes: [] };\n}`,
          },
        },
        {
          id: 'formatter',
          workflowId: '__script__',
          label: 'Shot Formatter',
          script: {
            code: `/**\n * @input {string[]} scenes - Parsed scenes\n * @output {string} markdown - Shot list\n */\nasync function execute(inputs, context) {\n  return { markdown: '' };\n}`,
          },
        },
      ],
      edges: [
        {
          sourceNodeId: 'source',
          sourcePort: 'ScreenPlay',
          targetNodeId: 'parser',
          targetPort: 'screenplay',
        },
        {
          sourceNodeId: 'parser',
          sourcePort: 'scenes',
          targetNodeId: 'formatter',
          targetPort: 'scenes',
        },
      ],
      nodeOutputs: {
        source: {
          ScreenPlay: 'INT. OFFICE - DAY\nA founder types furiously while the build runs.',
        },
      },
    });

    expect(context).toContain('Current node: Scene Parser');
    expect(context).toContain('inputs: screenplay');
    expect(context).toContain('outputs: scenes');
    expect(context).toContain('Screenplay Generator.ScreenPlay -> screenplay');
    expect(context).toContain('value: "INT. OFFICE - DAY');
    expect(context).toContain('scenes -> Shot Formatter.scenes');
    expect(context).toContain('inputs: scenes');
  });
});

describe('summarizeAutoFixValue', () => {
  it('truncates long values without throwing', () => {
    const summary = summarizeAutoFixValue('x'.repeat(400), 40);
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.endsWith('...')).toBe(true);
  });
});