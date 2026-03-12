import { describe, expect, it } from '@jest/globals';
import { inferCompositionInputs } from '../dashboard/routes/compositions.js';

describe('inferCompositionInputs', () => {
  it('includes unconnected junction ports alongside script inputs', () => {
    const inputs = inferCompositionInputs({
      nodes: [
        {
          id: 'concept',
          workflowId: '__script__',
          label: 'Concept Analysis',
          script: {
            inputs: [
              { name: 'CreativeIdea', type: 'string', description: 'The creative premise', required: true },
            ],
          },
        },
        {
          id: 'junction',
          workflowId: '__junction__',
          label: 'Junction',
          junctionNode: {
            ports: [
              { name: 'FormatType', type: 'string', description: 'Movie, commercial, or TV format' },
            ],
          },
        },
      ],
      edges: [],
    }, {});

    expect(inputs.map(input => input.name)).toEqual(expect.arrayContaining(['CreativeIdea', 'FormatType']));
    expect(inputs.find(input => input.name === 'CreativeIdea')?.required).toBe(true);
    expect(inputs.find(input => input.name === 'FormatType')?.workflowId).toBe('__junction__');
  });

  it('omits junction ports that are already wired from upstream nodes', () => {
    const inputs = inferCompositionInputs({
      nodes: [
        {
          id: 'source',
          workflowId: '__script__',
          label: 'Source',
          script: {
            inputs: [],
            outputs: [{ name: 'FormatType', type: 'string' }],
          },
        },
        {
          id: 'junction',
          workflowId: '__junction__',
          label: 'Junction',
          junctionNode: {
            ports: [
              { name: 'FormatType', type: 'string', description: 'Movie, commercial, or TV format' },
            ],
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceNodeId: 'source',
          sourcePort: 'FormatType',
          targetNodeId: 'junction',
          targetPort: 'FormatType',
        },
      ],
    }, {});

    expect(inputs.some(input => input.name === 'FormatType')).toBe(false);
  });

  it('bubbles child composition inputs up to the top-level pipeline interface', () => {
    const childComp = {
      id: 'creative-script-development-system',
      nodes: [
        {
          id: 'concept',
          workflowId: '__script__',
          label: 'Concept Analysis',
          script: {
            inputs: [
              { name: 'CreativeIdea', label: 'Creative Idea', type: 'string', description: 'The creative premise', required: true },
            ],
          },
        },
        {
          id: 'junction',
          workflowId: '__junction__',
          label: 'Junction',
          junctionNode: {
            ports: [
              { name: 'FormatType', type: 'string', description: 'Movie, commercial, or TV format' },
            ],
          },
        },
      ],
      edges: [],
    };

    const topLevelInputs = inferCompositionInputs({
      id: 'script-to-shot',
      nodes: [
        {
          id: 'child-node',
          workflowId: 'comp:creative-script-development-system',
          label: 'Creative Script Development System',
          compositionRef: {
            compositionId: 'creative-script-development-system',
          },
        },
      ],
      edges: [],
    }, {}, {
      'creative-script-development-system': childComp,
    }, new Set(['script-to-shot']));

    expect(topLevelInputs.map(input => input.name)).toEqual(expect.arrayContaining(['CreativeIdea', 'FormatType']));
    expect(topLevelInputs.find(input => input.name === 'CreativeIdea')?.workflowId).toBe('comp:creative-script-development-system');
    expect(topLevelInputs.find(input => input.name === 'FormatType')?.nodeLabel).toBe('Creative Script Development System');
  });

  it('omits bubbled child inputs that are already wired at the parent composition level', () => {
    const childComp = {
      id: 'creative-script-development-system',
      nodes: [
        {
          id: 'concept',
          workflowId: '__script__',
          label: 'Concept Analysis',
          script: {
            inputs: [
              { name: 'CreativeIdea', type: 'string', required: true },
            ],
          },
        },
      ],
      edges: [],
    };

    const topLevelInputs = inferCompositionInputs({
      id: 'script-to-shot',
      nodes: [
        {
          id: 'source',
          workflowId: '__script__',
          label: 'Source',
          script: {
            inputs: [],
            outputs: [{ name: 'CreativeIdea', type: 'string' }],
          },
        },
        {
          id: 'child-node',
          workflowId: 'comp:creative-script-development-system',
          label: 'Creative Script Development System',
          compositionRef: {
            compositionId: 'creative-script-development-system',
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceNodeId: 'source',
          sourcePort: 'CreativeIdea',
          targetNodeId: 'child-node',
          targetPort: 'CreativeIdea',
        },
      ],
    }, {}, {
      'creative-script-development-system': childComp,
    }, new Set(['script-to-shot']));

    expect(topLevelInputs.some(input => input.name === 'CreativeIdea')).toBe(false);
  });
});