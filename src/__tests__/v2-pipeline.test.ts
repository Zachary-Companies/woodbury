import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isPipelineDocument } from '../workflow/types.js';
import type { PipelineDocument, CompositionDocument, PipelineEdge, PipelineEdgeKind, PortDeclaration } from '../workflow/types.js';
import {
  parsePortAnnotations,
  parseImports,
  generateImportStatement,
  scaffoldPipeline,
  addScriptFileNode,
  savePipelineManifest,
  syncAllFilesToManifest,
} from '../dashboard/pipeline-sync.js';
import { loadPipeline, readScriptFileCode, writeScriptFileCode } from '../workflow/loader.js';

let testDir: string;

beforeAll(async () => {
  testDir = await fs.mkdtemp(join(tmpdir(), 'woodbury-v2-test-'));
});

afterAll(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
//  Type system tests
// ────────────────────────────────────────────────────────────────

describe('Type system', () => {
  describe('isPipelineDocument()', () => {
    it('returns true for a document with version 2.0', () => {
      const doc: PipelineDocument = {
        version: '2.0',
        id: 'test-pipeline',
        name: 'Test Pipeline',
        nodes: [],
        edges: [],
      };
      expect(isPipelineDocument(doc)).toBe(true);
    });

    it('returns false for a v1 CompositionDocument', () => {
      const doc: CompositionDocument = {
        version: '1.0',
        id: 'test-composition',
        name: 'Test Composition',
        nodes: [],
        edges: [],
      };
      expect(isPipelineDocument(doc)).toBe(false);
    });

    it('returns true even when optional fields are present', () => {
      const doc: PipelineDocument = {
        version: '2.0',
        id: 'full-pipeline',
        name: 'Full Pipeline',
        description: 'A fully loaded pipeline',
        pipelineDir: '/tmp/test',
        folder: 'my-folder',
        nodes: [],
        edges: [],
        metadata: { createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      };
      expect(isPipelineDocument(doc)).toBe(true);
    });
  });

  describe('PipelineDocument version field', () => {
    it('requires version to be exactly 2.0', () => {
      const doc: PipelineDocument = {
        version: '2.0',
        id: 'p1',
        name: 'P1',
        nodes: [],
        edges: [],
      };
      expect(doc.version).toBe('2.0');
    });
  });

  describe('PipelineEdge kind field', () => {
    it('supports data kind', () => {
      const edge: PipelineEdge = {
        id: 'e1',
        sourceNodeId: 'a',
        sourcePort: 'out',
        targetNodeId: 'b',
        targetPort: 'in',
        kind: 'data',
      };
      expect(edge.kind).toBe('data');
    });

    it('supports import kind', () => {
      const edge: PipelineEdge = {
        id: 'e2',
        sourceNodeId: 'a',
        sourcePort: 'imports',
        targetNodeId: 'b',
        targetPort: 'exports',
        kind: 'import',
      };
      expect(edge.kind).toBe('import');
    });

    it('supports trigger kind', () => {
      const edge: PipelineEdge = {
        id: 'e3',
        sourceNodeId: 'a',
        sourcePort: 'trigger-out',
        targetNodeId: 'b',
        targetPort: 'trigger-in',
        kind: 'trigger',
      };
      expect(edge.kind).toBe('trigger');
    });

    it('allows kind to be undefined for backward compatibility', () => {
      const edge: PipelineEdge = {
        id: 'e4',
        sourceNodeId: 'a',
        sourcePort: 'out',
        targetNodeId: 'b',
        targetPort: 'in',
      };
      expect(edge.kind).toBeUndefined();
    });

    it('covers all three PipelineEdgeKind values', () => {
      const allKinds: PipelineEdgeKind[] = ['data', 'import', 'trigger'];
      expect(allKinds).toHaveLength(3);
      expect(allKinds).toContain('data');
      expect(allKinds).toContain('import');
      expect(allKinds).toContain('trigger');
    });
  });
});

// ────────────────────────────────────────────────────────────────
//  Pipeline sync tests
// ────────────────────────────────────────────────────────────────

describe('Pipeline sync', () => {
  describe('parsePortAnnotations()', () => {
    it('extracts @input annotations with type and description', () => {
      const code = `
/**
 * @input prompt: string - The user prompt
 * @input count: number - How many to generate
 */
export async function execute(inputs: any) {}
`;
      const { inputs, outputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toEqual({ name: 'prompt', type: 'string', description: 'The user prompt' });
      expect(inputs[1]).toEqual({ name: 'count', type: 'number', description: 'How many to generate' });
      expect(outputs).toHaveLength(0);
    });

    it('extracts @output annotations', () => {
      const code = `
/**
 * @output result: string - Generated text
 * @output items: string[] - List of items
 */
export async function execute(inputs: any) {}
`;
      const { inputs, outputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(0);
      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toEqual({ name: 'result', type: 'string', description: 'Generated text' });
      expect(outputs[1]).toEqual({ name: 'items', type: 'string[]', description: 'List of items' });
    });

    it('extracts both @input and @output from the same code', () => {
      const code = `
/**
 * @input query: string - Search query
 * @output matches: string[] - Matching results
 */
export async function execute(inputs: any) {}
`;
      const { inputs, outputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].name).toBe('query');
      expect(outputs).toHaveLength(1);
      expect(outputs[0].name).toBe('matches');
    });

    it('handles annotations without descriptions', () => {
      const code = `
/**
 * @input value: number
 * @output flag: boolean
 */
export async function execute(inputs: any) {}
`;
      const { inputs, outputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toEqual({ name: 'value', type: 'number', description: undefined });
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual({ name: 'flag', type: 'boolean', description: undefined });
    });

    it('returns empty arrays when no annotations are present', () => {
      const code = `export async function execute() { return {}; }`;
      const { inputs, outputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(0);
      expect(outputs).toHaveLength(0);
    });

    it('normalizes bool to boolean and int/float to number', () => {
      const code = `
/**
 * @input active: bool - Is active
 * @input amount: int - Count
 * @input rate: float - Rate value
 */
export async function execute(inputs: any) {}
`;
      const { inputs } = parsePortAnnotations(code);
      expect(inputs).toHaveLength(3);
      expect(inputs[0].type).toBe('boolean');
      expect(inputs[1].type).toBe('number');
      expect(inputs[2].type).toBe('number');
    });

    it('normalizes array type to string[]', () => {
      const code = `
/**
 * @input tags: array - Tag list
 */
export async function execute(inputs: any) {}
`;
      const { inputs } = parsePortAnnotations(code);
      expect(inputs[0].type).toBe('string[]');
    });
  });

  describe('parseImports()', () => {
    it('extracts a single named import from a relative path', () => {
      const code = `import { fetchData } from './fetch-data.js';`;
      const imports = parseImports(code);
      expect(imports).toHaveLength(1);
      expect(imports[0].symbols).toEqual(['fetchData']);
      expect(imports[0].fromModule).toBe('fetch-data');
    });

    it('extracts multiple named imports from a single statement', () => {
      const code = `import { alpha, beta, gamma } from './helpers.ts';`;
      const imports = parseImports(code);
      expect(imports).toHaveLength(1);
      expect(imports[0].symbols).toEqual(['alpha', 'beta', 'gamma']);
      expect(imports[0].fromModule).toBe('helpers');
    });

    it('extracts multiple import statements', () => {
      const code = `
import { foo } from './module-a.js';
import { bar } from './module-b.js';
`;
      const imports = parseImports(code);
      expect(imports).toHaveLength(2);
      expect(imports[0].fromModule).toBe('module-a');
      expect(imports[1].fromModule).toBe('module-b');
    });

    it('ignores non-relative imports', () => {
      const code = `
import { readFile } from 'fs';
import { join } from 'path';
import { localThing } from './local.js';
`;
      const imports = parseImports(code);
      expect(imports).toHaveLength(1);
      expect(imports[0].fromModule).toBe('local');
    });

    it('returns empty array when there are no imports', () => {
      const code = `export async function execute() { return {}; }`;
      const imports = parseImports(code);
      expect(imports).toHaveLength(0);
    });

    it('preserves the raw import statement', () => {
      const code = `import { result } from './compute.js';`;
      const imports = parseImports(code);
      expect(imports[0].raw).toBe(`import { result } from './compute.js'`);
    });
  });

  describe('generateImportStatement()', () => {
    it('creates a correct import statement for a .ts file', () => {
      const result = generateImportStatement('fetch-data.ts', ['fetchResult', 'fetchStatus']);
      expect(result).toBe(`import { fetchResult, fetchStatus } from './fetch-data.js';`);
    });

    it('creates a correct import statement for a .js file', () => {
      const result = generateImportStatement('helpers.js', ['helperFn']);
      expect(result).toBe(`import { helperFn } from './helpers.js';`);
    });

    it('creates a correct import statement for a single output', () => {
      const result = generateImportStatement('process.ts', ['output']);
      expect(result).toBe(`import { output } from './process.js';`);
    });
  });

  describe('scaffoldPipeline()', () => {
    it('creates a pipeline directory and pipeline.json', async () => {
      const parentDir = join(testDir, 'scaffold-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir, manifestPath } = await scaffoldPipeline(
        parentDir,
        'my-pipeline',
        'My Pipeline',
        'A test pipeline',
      );

      expect(pipelineDir).toBe(join(parentDir, 'my-pipeline'));
      expect(manifestPath).toBe(join(parentDir, 'my-pipeline', 'pipeline.json'));

      // Verify directory was created
      const stat = await fs.stat(pipelineDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify pipeline.json content
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      expect(manifest.version).toBe('2.0');
      expect(manifest.id).toBe('my-pipeline');
      expect(manifest.name).toBe('My Pipeline');
      expect(manifest.description).toBe('A test pipeline');
      expect(manifest.nodes).toEqual([]);
      expect(manifest.edges).toEqual([]);
      expect(manifest.metadata).toBeDefined();
      expect(manifest.metadata.createdAt).toBeDefined();
    });

    it('does not persist pipelineDir in the JSON file', async () => {
      const parentDir = join(testDir, 'scaffold-no-dir');
      await fs.mkdir(parentDir, { recursive: true });

      const { manifestPath } = await scaffoldPipeline(parentDir, 'no-dir-test', 'No Dir Test');
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      expect(manifest.pipelineDir).toBeUndefined();
    });
  });

  describe('addScriptFileNode()', () => {
    it('creates a .ts file and adds a node to the pipeline manifest', async () => {
      const parentDir = join(testDir, 'add-node-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'node-pipeline', 'Node Pipeline');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'node-pipeline',
        name: 'Node Pipeline',
        nodes: [],
        edges: [],
      };

      const inputs: PortDeclaration[] = [{ name: 'text', type: 'string', description: 'Input text' }];
      const outputs: PortDeclaration[] = [{ name: 'result', type: 'string', description: 'Output text' }];

      const node = await addScriptFileNode(pipelineDir, pipeline, 'Process Text', 'Processes input text', inputs, outputs);

      // Verify node was added to the pipeline
      expect(pipeline.nodes).toHaveLength(1);
      expect(pipeline.nodes[0]).toBe(node);
      expect(node.workflowId).toBe('__script_file__');
      expect(node.label).toBe('Process Text');
      expect(node.scriptFile).toBeDefined();
      expect(node.scriptFile!.file).toBe('process-text.ts');
      expect(node.scriptFile!.description).toBe('Processes input text');
      expect(node.scriptFile!.inputs).toEqual(inputs);
      expect(node.scriptFile!.outputs).toEqual(outputs);

      // Verify .ts file was created
      const tsContent = await fs.readFile(join(pipelineDir, 'process-text.ts'), 'utf-8');
      expect(tsContent).toContain('export async function execute');
      expect(tsContent).toContain('@input text: string');
      expect(tsContent).toContain('@output result: string');
    });

    it('uses custom code when provided', async () => {
      const parentDir = join(testDir, 'custom-code-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'custom-pipeline', 'Custom Pipeline');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'custom-pipeline',
        name: 'Custom Pipeline',
        nodes: [],
        edges: [],
      };

      const customCode = `export async function execute(inputs: any) { return { value: inputs.x * 2 }; }`;

      await addScriptFileNode(pipelineDir, pipeline, 'Doubler', 'Doubles a value', [], [], customCode);

      const written = await fs.readFile(join(pipelineDir, 'doubler.ts'), 'utf-8');
      expect(written).toBe(customCode);
    });

    it('generates a filename by converting label to kebab-case', async () => {
      const parentDir = join(testDir, 'kebab-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'kebab-pipeline', 'Kebab Pipeline');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'kebab-pipeline',
        name: 'Kebab Pipeline',
        nodes: [],
        edges: [],
      };

      const node = await addScriptFileNode(pipelineDir, pipeline, 'My Great Node', '', [], []);
      expect(node.scriptFile!.file).toBe('my-great-node.ts');
    });
  });

  describe('savePipelineManifest()', () => {
    it('writes pipeline.json without the pipelineDir field', async () => {
      const parentDir = join(testDir, 'save-manifest-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'save-test', 'Save Test');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'save-test',
        name: 'Save Test',
        pipelineDir,
        nodes: [],
        edges: [],
        metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      };

      await savePipelineManifest(pipelineDir, pipeline);

      const raw = await fs.readFile(join(pipelineDir, 'pipeline.json'), 'utf-8');
      const saved = JSON.parse(raw);

      expect(saved.pipelineDir).toBeUndefined();
      expect(saved.version).toBe('2.0');
      expect(saved.id).toBe('save-test');
      expect(saved.name).toBe('Save Test');
    });

    it('updates the updatedAt timestamp', async () => {
      const parentDir = join(testDir, 'save-timestamp-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'ts-test', 'Timestamp Test');

      const oldTimestamp = '2020-01-01T00:00:00.000Z';
      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'ts-test',
        name: 'Timestamp Test',
        nodes: [],
        edges: [],
        metadata: { createdAt: oldTimestamp, updatedAt: oldTimestamp },
      };

      await savePipelineManifest(pipelineDir, pipeline);

      const raw = await fs.readFile(join(pipelineDir, 'pipeline.json'), 'utf-8');
      const saved = JSON.parse(raw);

      expect(saved.metadata.updatedAt).not.toBe(oldTimestamp);
      // updatedAt should be a recent timestamp
      const diff = Date.now() - new Date(saved.metadata.updatedAt).getTime();
      expect(diff).toBeLessThan(5000);
    });

    it('sets metadata on the in-memory pipeline even if absent initially', async () => {
      const parentDir = join(testDir, 'no-metadata-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'no-meta', 'No Metadata');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'no-meta',
        name: 'No Metadata',
        nodes: [],
        edges: [],
      };

      await savePipelineManifest(pipelineDir, pipeline);

      // The in-memory pipeline object gets metadata assigned
      expect(pipeline.metadata).toBeDefined();
      expect(pipeline.metadata!.createdAt).toBeDefined();
      expect(pipeline.metadata!.updatedAt).toBeDefined();
    });

    it('persists metadata when it already exists on the pipeline', async () => {
      const parentDir = join(testDir, 'existing-metadata-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'has-meta', 'Has Metadata');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'has-meta',
        name: 'Has Metadata',
        nodes: [],
        edges: [],
        metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      };

      await savePipelineManifest(pipelineDir, pipeline);

      const raw = await fs.readFile(join(pipelineDir, 'pipeline.json'), 'utf-8');
      const saved = JSON.parse(raw);
      expect(saved.metadata).toBeDefined();
      expect(saved.metadata.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(saved.metadata.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('syncAllFilesToManifest()', () => {
    it('removes nodes whose .ts files no longer exist on disk', async () => {
      const parentDir = join(testDir, 'sync-remove-files-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'sync-pipeline', 'Sync Pipeline');

      // Write one file that exists
      const tsCode = `
/**
 * @input query: string - Search query
 * @output results: string[] - Search results
 */
export async function execute(inputs: { query: string }) {
  return { results: [] };
}
`;
      await fs.writeFile(join(pipelineDir, 'search.ts'), tsCode, 'utf-8');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'sync-pipeline',
        name: 'Sync Pipeline',
        nodes: [
          {
            id: 'node-search',
            workflowId: '__script_file__',
            position: { x: 0, y: 0 },
            label: 'Search',
            scriptFile: { file: 'search.ts', description: '', inputs: [], outputs: [] },
          },
          {
            id: 'node-deleted',
            workflowId: '__script_file__',
            position: { x: 0, y: 0 },
            label: 'Deleted Node',
            scriptFile: { file: 'deleted-file.ts', description: '', inputs: [], outputs: [] },
          },
        ],
        edges: [
          { id: 'e1', sourceNodeId: 'node-search', sourcePort: 'results', targetNodeId: 'node-deleted', targetPort: 'data' },
        ],
      };

      const changed = await syncAllFilesToManifest(pipelineDir, pipeline);

      expect(changed).toBe(true);
      // Node for deleted file should be removed
      expect(pipeline.nodes).toHaveLength(1);
      expect(pipeline.nodes[0].id).toBe('node-search');
      // Edge to deleted node should be removed too
      expect(pipeline.edges).toHaveLength(0);
    });

    it('ignores .ts files without an execute() function', async () => {
      const parentDir = join(testDir, 'sync-no-execute-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'no-exec', 'No Execute');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'no-exec',
        name: 'No Execute',
        nodes: [],
        edges: [],
      };

      // A utility file without execute()
      await fs.writeFile(join(pipelineDir, 'utils.ts'), 'export function helper() {}', 'utf-8');

      const changed = await syncAllFilesToManifest(pipelineDir, pipeline);

      expect(changed).toBe(false);
      expect(pipeline.nodes).toHaveLength(0);
    });

    it('updates port declarations when annotations change in existing node files', async () => {
      const parentDir = join(testDir, 'sync-ports-update-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'ports-update', 'Ports Update');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'ports-update',
        name: 'Ports Update',
        nodes: [{
          id: 'node-transform',
          workflowId: '__script_file__',
          position: { x: 0, y: 0 },
          label: 'Transform',
          scriptFile: {
            file: 'transform.ts',
            description: 'Transform data',
            inputs: [{ name: 'data', type: 'string' }],
            outputs: [{ name: 'result', type: 'string' }],
          },
        }],
        edges: [],
      };

      // Write file with updated annotations (added a new input)
      const tsCode = `
/**
 * @input data: string - Data to transform
 * @input format: string - Output format
 * @output result: string - Transformed data
 * @output status: boolean - Success flag
 */
export async function execute(inputs: any) {
  return { result: '', status: true };
}
`;
      await fs.writeFile(join(pipelineDir, 'transform.ts'), tsCode, 'utf-8');

      const changed = await syncAllFilesToManifest(pipelineDir, pipeline);

      expect(changed).toBe(true);
      expect(pipeline.nodes[0].scriptFile!.inputs).toHaveLength(2);
      expect(pipeline.nodes[0].scriptFile!.inputs[1].name).toBe('format');
      expect(pipeline.nodes[0].scriptFile!.outputs).toHaveLength(2);
      expect(pipeline.nodes[0].scriptFile!.outputs[1].name).toBe('status');
    });

    it('returns false when nothing changed', async () => {
      const parentDir = join(testDir, 'sync-no-change-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'no-change', 'No Change');

      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'no-change',
        name: 'No Change',
        nodes: [],
        edges: [],
      };

      // No extra .ts files, no nodes
      const changed = await syncAllFilesToManifest(pipelineDir, pipeline);
      expect(changed).toBe(false);
    });

    it('detects import edges from import statements in code', async () => {
      const parentDir = join(testDir, 'sync-import-edges-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'import-edges', 'Import Edges');

      // Create two nodes: producer and consumer
      const pipeline: PipelineDocument = {
        version: '2.0',
        id: 'import-edges',
        name: 'Import Edges',
        nodes: [
          {
            id: 'node-producer',
            workflowId: '__script_file__',
            position: { x: 0, y: 0 },
            label: 'Producer',
            scriptFile: {
              file: 'producer.ts',
              description: 'Produces data',
              inputs: [],
              outputs: [{ name: 'data', type: 'string' }],
            },
          },
          {
            id: 'node-consumer',
            workflowId: '__script_file__',
            position: { x: 300, y: 0 },
            label: 'Consumer',
            scriptFile: {
              file: 'consumer.ts',
              description: 'Consumes data',
              inputs: [{ name: 'data', type: 'string' }],
              outputs: [],
            },
          },
        ],
        edges: [],
      };

      // Producer file
      await fs.writeFile(join(pipelineDir, 'producer.ts'), `
/**
 * @output data: string - Produced data
 */
export async function execute() {
  return { data: 'hello' };
}
`, 'utf-8');

      // Consumer file that imports from producer
      await fs.writeFile(join(pipelineDir, 'consumer.ts'), `
import { data } from './producer.js';
/**
 * @input data: string - Input data
 */
export async function execute(inputs: any) {
  console.log(data);
}
`, 'utf-8');

      const changed = await syncAllFilesToManifest(pipelineDir, pipeline);

      expect(changed).toBe(true);
      // Should have detected an import edge from consumer -> producer
      const importEdges = pipeline.edges.filter(e => e.kind === 'import');
      expect(importEdges).toHaveLength(1);
      expect(importEdges[0].sourceNodeId).toBe('node-consumer');
      expect(importEdges[0].targetNodeId).toBe('node-producer');
    });
  });
});

// ────────────────────────────────────────────────────────────────
//  Loader tests
// ────────────────────────────────────────────────────────────────

describe('Loader', () => {
  describe('loadPipeline()', () => {
    it('reads pipeline.json and sets pipelineDir', async () => {
      const parentDir = join(testDir, 'load-pipeline-test');
      await fs.mkdir(parentDir, { recursive: true });

      const { pipelineDir } = await scaffoldPipeline(parentDir, 'load-me', 'Load Me');

      const doc = await loadPipeline(pipelineDir);

      expect(doc.version).toBe('2.0');
      expect(doc.id).toBe('load-me');
      expect(doc.name).toBe('Load Me');
      expect(doc.pipelineDir).toBe(pipelineDir);
      expect(doc.nodes).toEqual([]);
      expect(doc.edges).toEqual([]);
    });

    it('throws when pipeline.json has wrong version', async () => {
      const dir = join(testDir, 'wrong-version');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'pipeline.json'), JSON.stringify({
        version: '1.0',
        id: 'bad',
        name: 'Bad',
        nodes: [],
        edges: [],
      }), 'utf-8');

      await expect(loadPipeline(dir)).rejects.toThrow('version 2.0');
    });

    it('throws when pipeline.json is missing required fields', async () => {
      const dir = join(testDir, 'missing-fields');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'pipeline.json'), JSON.stringify({
        version: '2.0',
        id: 'missing',
      }), 'utf-8');

      await expect(loadPipeline(dir)).rejects.toThrow('name');
    });

    it('throws when pipeline.json does not exist', async () => {
      const dir = join(testDir, 'nonexistent-pipeline');
      await fs.mkdir(dir, { recursive: true });

      await expect(loadPipeline(dir)).rejects.toThrow();
    });

    it('loads a pipeline with nodes and edges', async () => {
      const dir = join(testDir, 'full-pipeline-load');
      await fs.mkdir(dir, { recursive: true });

      const manifest = {
        version: '2.0',
        id: 'full-load',
        name: 'Full Load',
        nodes: [
          {
            id: 'n1',
            workflowId: '__script_file__',
            position: { x: 0, y: 0 },
            label: 'Node One',
            scriptFile: {
              file: 'node-one.ts',
              description: 'First node',
              inputs: [],
              outputs: [{ name: 'out', type: 'string' }],
            },
          },
        ],
        edges: [
          {
            id: 'e1',
            sourceNodeId: 'n1',
            sourcePort: 'out',
            targetNodeId: 'n2',
            targetPort: 'in',
            kind: 'data',
          },
        ],
      };

      await fs.writeFile(join(dir, 'pipeline.json'), JSON.stringify(manifest), 'utf-8');

      const doc = await loadPipeline(dir);
      expect(doc.nodes).toHaveLength(1);
      expect(doc.nodes[0].label).toBe('Node One');
      expect(doc.edges).toHaveLength(1);
      expect(doc.edges[0].kind).toBe('data');
    });
  });

  describe('readScriptFileCode()', () => {
    it('reads the content of a .ts file for a script node', async () => {
      const dir = join(testDir, 'read-code-test');
      await fs.mkdir(dir, { recursive: true });

      const code = `export async function execute(inputs: any) { return { result: 42 }; }`;
      await fs.writeFile(join(dir, 'compute.ts'), code, 'utf-8');

      const scriptFile = { file: 'compute.ts', description: '', inputs: [], outputs: [] };
      const content = await readScriptFileCode(dir, scriptFile);
      expect(content).toBe(code);
    });

    it('throws when the script file does not exist', async () => {
      const dir = join(testDir, 'read-code-missing');
      await fs.mkdir(dir, { recursive: true });

      const scriptFile = { file: 'nonexistent.ts', description: '', inputs: [], outputs: [] };
      await expect(readScriptFileCode(dir, scriptFile)).rejects.toThrow();
    });
  });

  describe('writeScriptFileCode()', () => {
    it('writes code to a .ts file in the pipeline directory', async () => {
      const dir = join(testDir, 'write-code-test');
      await fs.mkdir(dir, { recursive: true });

      const code = `export async function execute() { return { value: 'hello' }; }`;
      await writeScriptFileCode(dir, 'greet.ts', code);

      const content = await fs.readFile(join(dir, 'greet.ts'), 'utf-8');
      expect(content).toBe(code);
    });

    it('overwrites an existing file', async () => {
      const dir = join(testDir, 'write-overwrite-test');
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(join(dir, 'overwrite.ts'), 'old content', 'utf-8');

      const newCode = `export async function execute() { return {}; }`;
      await writeScriptFileCode(dir, 'overwrite.ts', newCode);

      const content = await fs.readFile(join(dir, 'overwrite.ts'), 'utf-8');
      expect(content).toBe(newCode);
    });
  });
});

// ────────────────────────────────────────────────────────────────
//  Execution tests (indirect via file read + eval)
// ────────────────────────────────────────────────────────────────

describe('Execution', () => {
  describe('script file execute function', () => {
    it('can read a __script_file__ node .ts file and evaluate its execute function', async () => {
      const dir = join(testDir, 'exec-test');
      await fs.mkdir(dir, { recursive: true });

      // Write a simple script file that has an execute function
      const code = `
/**
 * @input value: number
 * @output doubled: number
 */
exports.execute = async function execute(inputs, context) {
  return { doubled: inputs.value * 2 };
};
`;
      await fs.writeFile(join(dir, 'double.ts'), code, 'utf-8');

      // Read the code (as the execution engine would)
      const scriptFile = { file: 'double.ts', description: '', inputs: [], outputs: [] };
      const fileCode = await readScriptFileCode(dir, scriptFile);

      // Evaluate the function (simulating what executeScriptCode does internally)
      const mod: any = {};
      const fn = new Function('exports', 'require', fileCode);
      fn(mod, require);
      const result = await mod.execute({ value: 21 }, {});

      expect(result).toEqual({ doubled: 42 });
    });

    it('can execute an async function that uses context', async () => {
      const dir = join(testDir, 'exec-context-test');
      await fs.mkdir(dir, { recursive: true });

      const code = `
exports.execute = async function execute(inputs, context) {
  const prefix = context.prefix || '';
  return { greeting: prefix + 'Hello, ' + inputs.name };
};
`;
      await fs.writeFile(join(dir, 'greet.ts'), code, 'utf-8');

      const scriptFile = { file: 'greet.ts', description: '', inputs: [], outputs: [] };
      const fileCode = await readScriptFileCode(dir, scriptFile);

      const mod: any = {};
      const fn = new Function('exports', 'require', fileCode);
      fn(mod, require);
      const result = await mod.execute({ name: 'World' }, { prefix: '>> ' });

      expect(result).toEqual({ greeting: '>> Hello, World' });
    });

    it('handles errors thrown by execute function', async () => {
      const dir = join(testDir, 'exec-error-test');
      await fs.mkdir(dir, { recursive: true });

      const code = `
exports.execute = async function execute(inputs, context) {
  throw new Error('Something went wrong');
};
`;
      await fs.writeFile(join(dir, 'fail.ts'), code, 'utf-8');

      const scriptFile = { file: 'fail.ts', description: '', inputs: [], outputs: [] };
      const fileCode = await readScriptFileCode(dir, scriptFile);

      const mod: any = {};
      const fn = new Function('exports', 'require', fileCode);
      fn(mod, require);

      await expect(mod.execute({}, {})).rejects.toThrow('Something went wrong');
    });

    it('can execute TypeScript code after transpilation (type annotations stripped)', async () => {
      const ts = require('typescript');
      const dir = join(testDir, 'exec-ts-transpile-test');
      await fs.mkdir(dir, { recursive: true });

      // Write real TypeScript with type annotations, interfaces, generics
      const tsCode = `
interface CastMember {
  name: string;
  role: string;
}

interface Inputs {
  title: string;
  characters: string[];
}

interface Outputs {
  cast: CastMember[];
  count: number;
}

export async function execute(
  inputs: Inputs,
  context: ScriptContext,
): Promise<Outputs> {
  const cast: CastMember[] = inputs.characters.map((name: string) => ({
    name,
    role: 'actor',
  }));
  return { cast, count: cast.length };
}
`;
      await fs.writeFile(join(dir, 'cast-builder.ts'), tsCode, 'utf-8');

      // Transpile TS → JS (what executeScriptFile does)
      const result = ts.transpileModule(tsCode, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          removeComments: false,
          esModuleInterop: true,
        },
      });
      let jsCode = result.outputText;

      // Strip export keywords (what executeScriptFile does)
      jsCode = jsCode.replace(/^export\s+/gm, '');

      // Verify it's valid JavaScript (no type annotations left)
      expect(jsCode).not.toContain(': Inputs');
      expect(jsCode).not.toContain(': Outputs');
      expect(jsCode).not.toContain('interface CastMember');
      expect(jsCode).toContain('async function execute');

      // Execute via AsyncFunction (what executeScriptCode does)
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const runner = new AsyncFunction(
        'inputs', 'context', 'require',
        `${jsCode}\nif (typeof execute !== 'function') throw new Error('no execute');\nreturn await execute(inputs, context);`,
      );

      const output = await runner(
        { title: 'Test Film', characters: ['Alice', 'Bob', 'Charlie'] },
        {},
        require,
      );

      expect(output.cast).toHaveLength(3);
      expect(output.cast[0]).toEqual({ name: 'Alice', role: 'actor' });
      expect(output.count).toBe(3);
    });
  });
});
