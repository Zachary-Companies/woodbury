import { describe, expect, it } from '@jest/globals';
import { proposeScriptNodeEdgeRepairs } from '../dashboard/script-edge-repair.js';

describe('proposeScriptNodeEdgeRepairs', () => {
  it('proposes unique incoming edge rewires that match the failing script contract', () => {
    const repairs = proposeScriptNodeEdgeRepairs({
      nodeId: 'parser',
      nodes: [
        {
          id: 'source',
          workflowId: '__script__',
          label: 'Screenplay Generator',
          script: {
            outputs: [{ name: 'ScreenPlay' }],
          },
        },
        {
          id: 'parser',
          workflowId: '__script__',
          label: 'Scene Parser',
          script: {
            inputs: [{ name: 'screenplay' }],
            outputs: [{ name: 'scenes' }],
          },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          sourceNodeId: 'source',
          sourcePort: 'screen_play',
          targetNodeId: 'parser',
          targetPort: 'ScreenPlay',
        },
      ],
      nodeOutputs: {
        source: {
          ScreenPlay: 'INT. OFFICE - DAY',
        },
      },
    });

    expect(repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeId: 'edge-1',
        field: 'sourcePort',
        fromPort: 'screen_play',
        toPort: 'ScreenPlay',
      }),
      expect.objectContaining({
        edgeId: 'edge-1',
        field: 'targetPort',
        fromPort: 'ScreenPlay',
        toPort: 'screenplay',
      }),
    ]));
  });

  it('skips ambiguous target rewires', () => {
    const repairs = proposeScriptNodeEdgeRepairs({
      nodeId: 'parser',
      nodes: [
        {
          id: 'source',
          workflowId: '__script__',
          script: {
            outputs: [{ name: 'title' }],
          },
        },
        {
          id: 'parser',
          workflowId: '__script__',
          script: {
            inputs: [{ name: 'idea_name' }, { name: 'ideaName' }],
            outputs: [{ name: 'result' }],
          },
        },
      ],
      edges: [
        {
          id: 'edge-2',
          sourceNodeId: 'source',
          sourcePort: 'title',
          targetNodeId: 'parser',
          targetPort: 'IdeaName',
        },
      ],
      nodeOutputs: {},
    });

    expect(repairs.some((repair) => repair.edgeId === 'edge-2' && repair.field === 'targetPort')).toBe(false);
  });
});