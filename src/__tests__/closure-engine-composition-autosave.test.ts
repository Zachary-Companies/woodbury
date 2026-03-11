import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const invalidateCompositionCache = jest.fn();

jest.mock('../workflow/loader.js', () => ({
  invalidateCompositionCache,
}));

describe('autoSaveComposition', () => {
  let fakeHomeDir: string;

  beforeEach(async () => {
    fakeHomeDir = await mkdtemp(join(tmpdir(), 'woodbury-autosave-'));
    invalidateCompositionCache.mockClear();
    jest.resetModules();
  });

  afterEach(async () => {
    await rm(fakeHomeDir, { recursive: true, force: true });
  });

  it('writes the composition file and invalidates the composition cache', async () => {
    jest.doMock('node:os', () => ({
      homedir: () => fakeHomeDir,
    }));

    const { autoSaveComposition } = await import('../loop/v3/closure-engine.js');

    autoSaveComposition('mcp__intelligence__generate_pipeline', JSON.stringify({
      version: '1.0',
      id: 'Comp Script Development',
      name: 'Script Development Pipeline',
      nodes: [],
      edges: [],
    }));

    const savedPath = join(fakeHomeDir, '.woodbury', 'workflows', 'comp-script-development.composition.json');
    const saved = JSON.parse(await readFile(savedPath, 'utf-8'));

    expect(saved.id).toBe('Comp Script Development');
    expect(saved.name).toBe('Script Development Pipeline');
    expect(invalidateCompositionCache).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate the cache for non-composition output', async () => {
    jest.doMock('node:os', () => ({
      homedir: () => fakeHomeDir,
    }));

    const { autoSaveComposition } = await import('../loop/v3/closure-engine.js');

    autoSaveComposition('mcp__intelligence__generate_pipeline', JSON.stringify({
      ok: true,
      message: 'not a composition',
    }));

    expect(invalidateCompositionCache).not.toHaveBeenCalled();
  });

  it('flags malformed script blobs and port mismatches during validation', async () => {
    const { validateComposition } = await import('../loop/v3/closure-engine.js');

    const issues = validateComposition({
      version: '1.0',
      id: 'bad-comp',
      name: 'Bad Comp',
      nodes: [
        {
          id: 'n1',
          workflowId: '__script__',
          label: 'Broken Script',
          script: {
            code: '```json\n{"code":"async function execute() {}"}\n```',
            inputs: [{ name: 'inputA' }],
            outputs: [{ name: 'outputA' }],
          },
        },
        {
          id: 'n2',
          workflowId: '__script__',
          label: 'Receiver',
          script: {
            code: 'async function execute(inputs) { return { done: true }; }',
            inputs: [{ name: 'expectedInput' }],
            outputs: [{ name: 'done' }],
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceNodeId: 'n1',
          sourcePort: 'missingOutput',
          targetNodeId: 'n2',
          targetPort: 'missingInput',
        },
      ],
    }, new Set<string>());

    expect(issues.some(issue => issue.includes('markdown fences'))).toBe(true);
    expect(issues.some(issue => issue.includes('serialized JSON blob'))).toBe(true);
    expect(issues.some(issue => issue.includes('missing source port'))).toBe(true);
    expect(issues.some(issue => issue.includes('missing target port'))).toBe(true);
  });
});