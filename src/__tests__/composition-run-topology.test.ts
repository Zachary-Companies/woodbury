import { __testOnly } from '../dashboard/routes/composition-run.js';

describe('composition run topology validation', () => {
  it('reports dangling edges as invalid connections', () => {
    expect(() => __testOnly.topoSort(
      [
        { id: 'node-1' },
        { id: 'node-2' },
      ],
      [
        { sourceNodeId: 'node-1', targetNodeId: 'output' },
      ],
    )).toThrow('These workflows have invalid connections to missing steps.');
  });

  it('still reports actual cycles as loops', () => {
    expect(() => __testOnly.topoSort(
      [
        { id: 'node-1' },
        { id: 'node-2' },
      ],
      [
        { sourceNodeId: 'node-1', targetNodeId: 'node-2' },
        { sourceNodeId: 'node-2', targetNodeId: 'node-1' },
      ],
    )).toThrow('These workflows form a loop and can\'t run in order. Check your connections.');
  });
});