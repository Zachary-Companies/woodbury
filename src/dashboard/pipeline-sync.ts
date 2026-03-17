/**
 * Pipeline Sync — Bidirectional sync between graph manifest and TypeScript files.
 *
 * Graph → Code: Adding/removing import edges updates import statements in .ts files.
 * Code → Graph: Parsing @input/@output annotations and import statements updates the manifest.
 */

import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
import type { PipelineDocument, PipelineNode, PipelineEdge, PortDeclaration, ScriptFileNodeConfig } from '../workflow/types.js';

// ── Port annotation parsing ──────────────────────────────────

/** Parse @input and @output JSDoc annotations from TypeScript source code */
export function parsePortAnnotations(code: string): {
  inputs: PortDeclaration[];
  outputs: PortDeclaration[];
} {
  const inputs: PortDeclaration[] = [];
  const outputs: PortDeclaration[] = [];

  // Match @input name: type - description
  const inputRegex = /@input\s+(\w+)\s*:\s*([\w\[\]]+)(?:\s*-\s*(.*))?/g;
  let match;
  while ((match = inputRegex.exec(code)) !== null) {
    inputs.push({
      name: match[1],
      type: normalizePortType(match[2]),
      description: match[3]?.trim(),
    });
  }

  // Match @output name: type - description
  const outputRegex = /@output\s+(\w+)\s*:\s*([\w\[\]]+)(?:\s*-\s*(.*))?/g;
  while ((match = outputRegex.exec(code)) !== null) {
    outputs.push({
      name: match[1],
      type: normalizePortType(match[2]),
      description: match[3]?.trim(),
    });
  }

  return { inputs, outputs };
}

function normalizePortType(raw: string): PortDeclaration['type'] {
  const lower = raw.toLowerCase().replace(/\s/g, '');
  if (lower === 'string[]' || lower === 'array') return 'string[]';
  if (lower === 'number' || lower === 'int' || lower === 'float') return 'number';
  if (lower === 'boolean' || lower === 'bool') return 'boolean';
  return 'string';
}

// ── Import statement parsing ─────────────────────────────────

/** Parsed import from a pipeline .ts file */
export interface ParsedImport {
  /** Imported symbol names */
  symbols: string[];
  /** Relative file path (without extension) */
  fromModule: string;
  /** The full raw import statement */
  raw: string;
}

/** Parse relative import statements from TypeScript source */
export function parseImports(code: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  // Match: import { foo, bar } from './module-name.js'
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]\.\/([\w\-\.]+)['"]/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const symbols = match[1].split(',').map(s => s.trim()).filter(Boolean);
    const fromModule = match[2].replace(/\.(js|ts)$/, '');
    results.push({ symbols, fromModule, raw: match[0] });
  }
  return results;
}

// ── Import statement generation ──────────────────────────────

/** Generate an import statement for a node's outputs */
export function generateImportStatement(
  targetFileName: string,
  outputPortNames: string[],
): string {
  const moduleName = targetFileName.replace(/\.(js|ts)$/, '');
  const symbols = outputPortNames.join(', ');
  return `import { ${symbols} } from './${moduleName}.js';`;
}

// ── Graph → Code sync ────────────────────────────────────────

/**
 * After an import edge is added in the graph, add the corresponding import
 * statement to the source node's .ts file.
 */
export async function addImportEdgeToCode(
  pipelineDir: string,
  pipeline: PipelineDocument,
  edge: PipelineEdge,
): Promise<void> {
  const sourceNode = pipeline.nodes.find(n => n.id === edge.sourceNodeId);
  const targetNode = pipeline.nodes.find(n => n.id === edge.targetNodeId);
  if (!sourceNode?.scriptFile?.file || !targetNode?.scriptFile?.file) return;

  const sourceFilePath = join(pipelineDir, sourceNode.scriptFile.file);
  if (!existsSync(sourceFilePath)) return;

  let code = await fs.readFile(sourceFilePath, 'utf-8');

  // Check if import already exists (use basename since files in src/ import with ./)
  const targetModule = basename(targetNode.scriptFile.file).replace(/\.(js|ts)$/, '');
  const existingImports = parseImports(code);
  const alreadyImported = existingImports.some(i => i.fromModule === targetModule);
  if (alreadyImported) return;

  // Get the target node's output port names
  const outputNames = (targetNode.scriptFile.outputs || []).map(p => p.name);
  if (outputNames.length === 0) return;

  const importStmt = generateImportStatement(targetNode.scriptFile.file, outputNames);

  // Insert after any existing imports, or at the top
  const lastImportIdx = code.lastIndexOf('\nimport ');
  if (lastImportIdx >= 0) {
    const lineEnd = code.indexOf('\n', lastImportIdx + 1);
    code = code.slice(0, lineEnd + 1) + importStmt + '\n' + code.slice(lineEnd + 1);
  } else {
    code = importStmt + '\n\n' + code;
  }

  await fs.writeFile(sourceFilePath, code, 'utf-8');
}

/**
 * After an import edge is removed in the graph, remove the corresponding
 * import statement from the source node's .ts file.
 */
export async function removeImportEdgeFromCode(
  pipelineDir: string,
  pipeline: PipelineDocument,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<void> {
  const sourceNode = pipeline.nodes.find(n => n.id === sourceNodeId);
  const targetNode = pipeline.nodes.find(n => n.id === targetNodeId);
  if (!sourceNode?.scriptFile?.file || !targetNode?.scriptFile?.file) return;

  const sourceFilePath = join(pipelineDir, sourceNode.scriptFile.file);
  if (!existsSync(sourceFilePath)) return;

  let code = await fs.readFile(sourceFilePath, 'utf-8');
  const targetModule = basename(targetNode.scriptFile.file).replace(/\.(js|ts)$/, '');

  // Remove import lines referencing this module
  const lines = code.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ')) return true;
    return !trimmed.includes(`'./${targetModule}.js'`) && !trimmed.includes(`'./${targetModule}.ts'`) && !trimmed.includes(`'./${targetModule}'`);
  });

  await fs.writeFile(sourceFilePath, filtered.join('\n'), 'utf-8');
}

// ── Code → Graph sync ────────────────────────────────────────

/**
 * Scan a .ts file and update the pipeline manifest to match:
 * - Update port declarations from @input/@output annotations
 * - Detect import edges from import statements
 */
export async function syncFileToManifest(
  pipelineDir: string,
  pipeline: PipelineDocument,
  nodeId: string,
): Promise<{ portsChanged: boolean; edgesChanged: boolean }> {
  const node = pipeline.nodes.find(n => n.id === nodeId);
  if (!node?.scriptFile?.file) return { portsChanged: false, edgesChanged: false };

  const filePath = join(pipelineDir, node.scriptFile.file);
  if (!existsSync(filePath)) return { portsChanged: false, edgesChanged: false };

  const code = await fs.readFile(filePath, 'utf-8');
  let portsChanged = false;
  let edgesChanged = false;

  // Update ports from annotations
  const { inputs, outputs } = parsePortAnnotations(code);
  if (inputs.length > 0 || outputs.length > 0) {
    const inputsMatch = JSON.stringify(node.scriptFile.inputs) === JSON.stringify(inputs);
    const outputsMatch = JSON.stringify(node.scriptFile.outputs) === JSON.stringify(outputs);
    if (!inputsMatch || !outputsMatch) {
      if (inputs.length > 0) node.scriptFile.inputs = inputs;
      if (outputs.length > 0) node.scriptFile.outputs = outputs;
      portsChanged = true;
    }
  }

  // Detect import edges
  const imports = parseImports(code);
  const fileToNodeMap = new Map<string, PipelineNode>();
  for (const n of pipeline.nodes) {
    if (n.scriptFile?.file) {
      // Use basename for matching since imports use ./module (no src/ prefix)
      const moduleName = basename(n.scriptFile.file).replace(/\.(js|ts)$/, '');
      fileToNodeMap.set(moduleName, n);
    }
  }

  for (const imp of imports) {
    const targetNode = fileToNodeMap.get(imp.fromModule);
    if (!targetNode) continue;

    // Check if import edge already exists
    const existsEdge = pipeline.edges.some(
      e => e.sourceNodeId === nodeId && e.targetNodeId === targetNode.id && e.kind === 'import'
    );
    if (!existsEdge) {
      // Add import edge
      pipeline.edges.push({
        id: `edge-import-${nodeId}-${targetNode.id}`,
        sourceNodeId: nodeId,
        sourcePort: 'imports',
        targetNodeId: targetNode.id,
        targetPort: 'exports',
        kind: 'import',
      });
      edgesChanged = true;
    }
  }

  return { portsChanged, edgesChanged };
}

// ── Full pipeline sync ───────────────────────────────────────

/**
 * Sync all .ts files in the pipeline directory to the manifest.
 * Returns true if any changes were made.
 */
export async function syncAllFilesToManifest(
  pipelineDir: string,
  pipeline: PipelineDocument,
): Promise<boolean> {
  let anyChanged = false;

  for (const node of pipeline.nodes) {
    if (!node.scriptFile?.file) continue;
    const { portsChanged, edgesChanged } = await syncFileToManifest(pipelineDir, pipeline, node.id);
    if (portsChanged || edgesChanged) anyChanged = true;
  }

  // Remove nodes whose .ts files no longer exist on disk
  // Supports both new layout (src/foo.ts) and legacy layout (foo.ts)
  try {
    const toRemove: string[] = [];
    for (const node of pipeline.nodes) {
      if (!node.scriptFile?.file) continue;
      const fullPath = join(pipelineDir, node.scriptFile.file);
      if (!existsSync(fullPath)) {
        // Also check legacy root path for files not yet migrated
        const legacyPath = join(pipelineDir, basename(node.scriptFile.file));
        if (!existsSync(legacyPath)) {
          toRemove.push(node.id);
        }
      }
    }
    if (toRemove.length > 0) {
      const removeSet = new Set(toRemove);
      pipeline.nodes = pipeline.nodes.filter(n => !removeSet.has(n.id));
      pipeline.edges = pipeline.edges.filter(e =>
        !removeSet.has(e.sourceNodeId) && !removeSet.has(e.targetNodeId)
      );
      anyChanged = true;
    }
  } catch {
    // Directory not readable
  }

  return anyChanged;
}

// ── Pipeline directory scaffolding ───────────────────────────

/**
 * Create a new v2 pipeline directory with a manifest and optional initial files.
 */
export async function scaffoldPipeline(
  parentDir: string,
  id: string,
  name: string,
  description?: string,
): Promise<{ pipelineDir: string; manifestPath: string }> {
  const pipelineDir = join(parentDir, id);
  await fs.mkdir(pipelineDir, { recursive: true });

  // Create src/ directory for script node files
  const srcDir = join(pipelineDir, 'src');
  await fs.mkdir(srcDir, { recursive: true });

  // Create bindings/ directory for custom data connections
  const bindingsDir = join(pipelineDir, 'bindings');
  await fs.mkdir(bindingsDir, { recursive: true });

  // Write initial empty bindings.json
  const emptyBindings = { version: '1.0', pipelineId: id, bindings: [] };
  await fs.writeFile(join(bindingsDir, 'bindings.json'), JSON.stringify(emptyBindings, null, 2), 'utf-8');

  // Write initial empty views.json
  const emptyViews = { version: '1.0', pipelineId: id, views: [] };
  await fs.writeFile(join(bindingsDir, 'views.json'), JSON.stringify(emptyViews, null, 2), 'utf-8');

  // Write initial empty rules.json
  const emptyRules = { version: '1.0', pipelineId: id, rules: [] };
  await fs.writeFile(join(bindingsDir, 'rules.json'), JSON.stringify(emptyRules, null, 2), 'utf-8');

  // Clean stale .ts files from previous generation (overwrite scenario)
  // Check both src/ and root for backward compat
  for (const dir of [srcDir, pipelineDir]) {
    try {
      const existing = await fs.readdir(dir);
      for (const entry of existing) {
        if (
          entry.endsWith('.ts') &&
          !entry.endsWith('.d.ts') &&
          entry !== 'tsconfig.json' &&
          entry !== 'vitest.config.ts' &&
          !entry.startsWith('_')
        ) {
          await fs.unlink(join(dir, entry));
        }
      }
    } catch {
      // Directory might be new
    }
  }

  const manifest: PipelineDocument = {
    version: '2.0',
    id,
    name,
    description,
    pipelineDir,
    nodes: [],
    edges: [],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  const manifestPath = join(pipelineDir, 'pipeline.json');
  // Don't persist pipelineDir
  const toWrite = { ...manifest };
  delete (toWrite as any).pipelineDir;
  await fs.writeFile(manifestPath, JSON.stringify(toWrite, null, 2), 'utf-8');

  // Write tsconfig.json for editor intellisense
  const tsconfig = {
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
      outDir: '.build',
      declaration: false,
    },
    include: ['src/**/*.ts', 'woodbury.d.ts'],
    exclude: ['.build', 'node_modules'],
  };
  await fs.writeFile(join(pipelineDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');

  // Write woodbury.d.ts — type definitions for the execute() contract
  const typeDefs = `/**
 * Woodbury Pipeline Script Node Types
 * Auto-generated — do not edit manually.
 */

/** Context object passed to every execute() function */
interface ScriptContext {
  /** LLM text/JSON generation */
  llm: {
    /** Generate text from a prompt */
    generate(prompt: string, opts?: { temperature?: number; maxTokens?: number; model?: string }): Promise<string>;
    /** Generate and parse JSON from a prompt */
    generateJSON(prompt: string, schema?: object, opts?: { temperature?: number; maxTokens?: number; model?: string }): Promise<any>;
  };
  /** Progress tracking */
  progress: {
    start(total: number, label?: string): void;
    set(completed: number, total?: number, label?: string): void;
    increment(label?: string): void;
    complete(label?: string): void;
  };
  /** Extension tools (key = tool name, value = async function) */
  tools: Record<string, (params: any) => Promise<any>>;
  /** Append a log message */
  log(message: string): void;
}

/**
 * Every pipeline script node must export an execute function.
 *
 * @example
 * export async function execute(
 *   inputs: { title: string; genre: string[] },
 *   context: ScriptContext,
 * ): Promise<{ result: string }> {
 *   const text = await context.llm.generate(\`Write about \${inputs.title}\`);
 *   return { result: text };
 * }
 */
type ExecuteFunction<TInputs = Record<string, unknown>, TOutputs = Record<string, unknown>> =
  (inputs: TInputs, context: ScriptContext) => Promise<TOutputs>;
`;
  await fs.writeFile(join(pipelineDir, 'woodbury.d.ts'), typeDefs, 'utf-8');

  // Write .gitignore
  const gitignore = `.build/
node_modules/
*.js
*.js.map
!pipeline.json
.DS_Store
.env
`;
  await fs.writeFile(join(pipelineDir, '.gitignore'), gitignore, 'utf-8');

  // Write package.json for npm dependencies
  const packageJson = {
    name: id,
    version: '1.0.0',
    description: description || `Woodbury pipeline: ${name}`,
    private: true,
    type: 'module',
    scripts: {
      build: 'tsc --noEmit',
      lint: 'tsc --noEmit --pretty',
      test: 'vitest run',
    },
    dependencies: {},
    devDependencies: {
      vitest: '^3.0.0',
    },
  };
  await fs.writeFile(join(pipelineDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');

  // Write .env.example (template for pipeline-specific secrets)
  const envExample = `# Pipeline Environment Variables
# Copy this file to .env and fill in your values.
# .env is gitignored — secrets will not be committed.
#
# These variables are available in your execute() functions via process.env
#
# EXAMPLE_API_KEY=your-key-here
`;
  await fs.writeFile(join(pipelineDir, '.env.example'), envExample, 'utf-8');

  // Write README.md
  const readme = generateReadme(name, description || '', id);
  await fs.writeFile(join(pipelineDir, 'README.md'), readme, 'utf-8');

  // Write CLAUDE.md — instructions for LLMs editing this pipeline
  const claudeMd = generateLlmDocs(name, description || '', id);
  await fs.writeFile(join(pipelineDir, 'CLAUDE.md'), claudeMd, 'utf-8');

  // Write TODO.json — structured task list for the agent to track progress
  const todo = generateInitialTodo(name, description || '');
  await fs.writeFile(join(pipelineDir, 'TODO.json'), JSON.stringify(todo, null, 2) + '\n', 'utf-8');

  return { pipelineDir, manifestPath };
}

function generateReadme(name: string, description: string, id: string): string {
  return `# ${name}

${description || 'A Woodbury v2 pipeline.'}

## Overview

This is a [Woodbury](https://woodbury.dev) v2 file-backed pipeline. Each script node is a real TypeScript file that can be edited, tested, and version-controlled independently.

## Structure

\`\`\`
${id}/
├── pipeline.json       # Graph manifest (node positions, edges, metadata)
├── tsconfig.json       # TypeScript config for editor intellisense
├── woodbury.d.ts       # Type definitions for the execute() contract
├── CLAUDE.md           # Instructions for AI assistants editing this pipeline
├── package.json        # npm dependencies (npm install to add packages)
├── .env.example        # Template for pipeline-specific secrets
├── .gitignore          # Excludes build artifacts
├── README.md           # This file
├── src/                # Script node files (one per node)
│   ├── *.ts            # Node execute() implementations
│   ├── _utils.ts       # Shared utilities (prefixed with _ = not a node)
│   └── *.test.ts       # Colocated test files
└── bindings/           # Custom data connections (entity relationships)
    ├── bindings.json   # Entity-to-entity relationships
    ├── views.json      # Custom view configurations
    └── rules.json      # Auto-binding rule definitions
\`\`\`

## Script Node Contract

Every \`.ts\` file in \`src/\` is a pipeline node. Each must export an \`execute\` function:

\`\`\`typescript
/// <reference path="./woodbury.d.ts" />

/**
 * @input name: string - The input name
 * @output greeting: string - The output greeting
 */
export async function execute(
  inputs: { name: string },
  context: ScriptContext,
): Promise<{ greeting: string }> {
  return { greeting: \`Hello, \${inputs.name}!\` };
}
\`\`\`

### Available Context APIs

- \`context.llm.generate(prompt)\` — Generate text with an LLM
- \`context.llm.generateJSON(prompt, schema?)\` — Generate and parse JSON
- \`context.progress.start(total)\` / \`.increment()\` / \`.complete()\` — Progress tracking
- \`context.tools\` — Extension tools (key-value map)
- \`context.log(message)\` — Append to execution log

### Port Annotations

Use JSDoc \`@input\` and \`@output\` annotations to declare ports:

\`\`\`typescript
/**
 * @input title: string - The title
 * @input count: number - How many to generate
 * @output items: string[] - Generated items
 * @output total: number - Total count
 */
\`\`\`

Supported types: \`string\`, \`number\`, \`boolean\`, \`string[]\`

## Running

Open this pipeline in the Woodbury dashboard and click **Run**, or use the API:

\`\`\`bash
curl -X POST http://localhost:4242/api/compositions/${id}/run \\
  -H "Content-Type: application/json" \\
  -d '{"variables": {"key": "value"}}'
\`\`\`

## Editing

- **In Woodbury**: Select a node → Open in Monaco editor
- **In your IDE**: Edit the \`.ts\` files directly, then click Sync in Woodbury
- **With AI**: The Woodbury chat agent can edit files directly when this pipeline is active

## Graph ↔ Code Sync

The graph (visual editor) and code (TypeScript files) stay in sync:

- **Graph → Code**: Adding an import edge creates an \`import\` statement
- **Code → Graph**: Adding \`@input\`/\`@output\` annotations updates graph ports
- **Sync manually**: Click the Sync button in the node properties panel, or POST to \`/api/compositions/${id}/sync\`
`;
}

function generateLlmDocs(name: string, description: string, id: string): string {
  return `# CLAUDE.md — ${name}

Instructions for AI assistants (Claude, Copilot, etc.) editing this Woodbury pipeline.

## What This Is

This is a Woodbury v2 file-backed pipeline called "${name}".
${description ? `\nPurpose: ${description}\n` : ''}
It is a directed graph of TypeScript script nodes that execute sequentially. The graph topology is defined in \`pipeline.json\` and each script node is a separate \`.ts\` file.

## File Structure

- \`pipeline.json\` — **Do not edit manually.** This is the graph manifest managed by Woodbury. It contains node positions, edge connections, and metadata. Changes here are made through the Woodbury API.
- \`woodbury.d.ts\` — Type definitions. Do not edit.
- \`tsconfig.json\` — Editor config. Do not edit.
- \`package.json\` — npm dependency manifest. Add packages here or use \`npm install <package>\`.
- \`.env.example\` — Template for pipeline-specific secrets. Copy to \`.env\` and fill in values.
- \`src/*.ts\` — **These are the files you should edit.** Each one is a pipeline script node.
- \`bindings/\` — Custom data connections between pipeline entities. Contains \`bindings.json\`, \`views.json\`, and \`rules.json\`.

## How Script Nodes Work

Each \`.ts\` file must export an \`async function execute(inputs, context)\`:

\`\`\`typescript
/// <reference path="./woodbury.d.ts" />

/**
 * Description of what this node does.
 *
 * @input inputName: string - Description
 * @output outputName: string - Description
 */
export async function execute(
  inputs: { inputName: string },
  context: ScriptContext,
): Promise<{ outputName: string }> {
  // Your logic here
  return { outputName: result };
}
\`\`\`

### Rules

1. **Always export \`execute\`** — This is the entry point. The function signature must be \`async function execute(inputs, context)\`.
2. **Declare ports with JSDoc** — Use \`@input\` and \`@output\` annotations in the JSDoc block above \`execute\`. These define the node's input/output ports in the graph.
3. **Return all declared outputs** — The return object must include every \`@output\` field.
4. **Use \`context.llm\` for AI calls** — Don't import external AI SDKs. Use the built-in \`context.llm.generate()\` and \`context.llm.generateJSON()\`.
5. **Use \`context.log()\` for logging** — Don't use \`console.log\`. Use \`context.log(message)\` so logs appear in the pipeline run UI.
6. **Use \`context.progress\` for long tasks** — Call \`context.progress.start(total)\`, \`context.progress.increment()\`, and \`context.progress.complete()\`.
7. **Keep the reference directive** — The \`/// <reference path="../woodbury.d.ts" />\` line provides type hints for \`ScriptContext\`.

### Available Context APIs

| API | Description |
|-----|-------------|
| \`context.llm.generate(prompt, opts?)\` | Generate text. Options: temperature, maxTokens, model |
| \`context.llm.generateJSON(prompt, schema?, opts?)\` | Generate and parse JSON |
| \`context.progress.start(total, label?)\` | Initialize progress bar |
| \`context.progress.set(completed, total?, label?)\` | Set progress |
| \`context.progress.increment(label?)\` | Increment by 1 |
| \`context.progress.complete(label?)\` | Mark complete |
| \`context.tools[name](params)\` | Call an extension tool |
| \`context.log(message)\` | Log a message |

### Port Types

| Type | TypeScript | Description |
|------|-----------|-------------|
| \`string\` | \`string\` | Text value |
| \`number\` | \`number\` | Numeric value |
| \`boolean\` | \`boolean\` | True/false |
| \`string[]\` | \`string[]\` | Array of strings |

For complex types (objects, arrays of objects), use \`string\` as the port type and pass JSON. Parse it in your code.

## Data Flow

Nodes receive inputs from upstream connections and pass outputs downstream. The \`pipeline.json\` file defines which output port connects to which input port.

When you see an input parameter in \`execute()\`, it comes from an upstream node's output (or from a pipeline variable if the node has no incoming edge for that port).

## What To Change vs. What Not To

| ✅ Change | ❌ Don't Change |
|-----------|----------------|
| Logic inside \`execute()\` | \`pipeline.json\` (managed by Woodbury) |
| \`@input\`/\`@output\` annotations | \`woodbury.d.ts\` (auto-generated) |
| Add helper functions/types | \`tsconfig.json\` (auto-generated) |
| Import between node files | The \`execute\` function signature pattern |
| Add npm dependencies to package.json | |

## Using npm Packages

You can use npm packages in your script nodes:

1. Add the dependency: edit \`package.json\` or run \`npm install <package>\` in the pipeline directory
2. Import it in your script: \`const cheerio = require('cheerio');\`
3. The package will be available at runtime

Note: Use \`require()\` for npm packages (CommonJS), not \`import\` (the execute function runs in a CommonJS-like context).

## Environment Variables

Pipeline-specific secrets go in \`.env\` (copy from \`.env.example\`). Access them via \`process.env.VARIABLE_NAME\` in your execute functions. The \`.env\` file is gitignored.

## After Editing

After you edit a \`.ts\` file, Woodbury will detect changes and sync the graph:
- New \`@input\`/\`@output\` annotations → new ports appear on the node
- New \`import\` statements from sibling files → new edges in the graph
- Removed ports → connections may need manual cleanup in the graph editor

## Testing

Each node should have a colocated test file (e.g., \`fetch-data.test.ts\` for \`fetch-data.ts\`). Tests use [Vitest](https://vitest.dev/) and a shared \`_test-helpers.ts\` mock context.

### Running Tests

\`\`\`bash
npm test                           # Run all tests
npx vitest run fetch-data.test.ts  # Run tests for one node
\`\`\`

Or use the Woodbury API:
\`\`\`bash
curl -X POST http://localhost:4242/api/compositions/${id}/run-tests
\`\`\`

### Writing Tests

\`\`\`typescript
import { describe, it, expect } from 'vitest';
import { createMockContext } from './_test-helpers.js';
const { execute } = await import('./fetch-data.js');

describe('fetch-data', () => {
  it('returns expected output keys', async () => {
    const { context } = createMockContext({
      llmGenerate: 'mock response',
    });
    const result = await execute({ query: 'test' }, context);
    expect(result).toHaveProperty('data');
  });
});
\`\`\`

The \`createMockContext()\` helper accepts overrides for:
- \`llmGenerate\` — string or function returning mock LLM text responses
- \`llmGenerateJSON\` — value or function returning mock LLM JSON responses
- \`tools\` — object mapping tool names to mock implementations

### Rules for Tests

1. **Always mock \`context.llm\`** — Tests should not make real LLM calls
2. **Test the contract** — Verify all declared \`@output\` keys exist in the result
3. **Test edge cases** — Empty inputs, missing fields, unexpected types
4. **Keep tests fast** — Mock all external dependencies

## Shared Utilities

Not every .ts file needs to be a pipeline node. For shared helper functions:

- **Prefix with underscore**: \`src/_utils.ts\`, \`src/_helpers.ts\`, \`src/_types.ts\` — these are ignored by the auto-detection
- **Use a \`lib/\` directory**: Put shared modules in \`src/lib/\` — they won't be scanned

Import shared utilities in your node files:
\`\`\`typescript
import { formatDate } from './_utils.js';
import { MyInterface } from './lib/types.js';
\`\`\`

## Bindings (Custom Data Connections)

The \`bindings/\` directory stores custom relationships between data entities across pipeline nodes:

- **\`bindings.json\`** — Explicit entity-to-entity relationships (e.g., "shot X depicts characters A, B")
- **\`views.json\`** — Custom view configurations (e.g., NLE screenplay view entity mappings)
- **\`rules.json\`** — Auto-binding rules that populate bindings from node output data

Bindings can be managed through:
- The Woodbury dashboard UI (add/remove connections visually)
- The API (\`/api/compositions/:id/bindings\`)
- Direct file editing (JSON)
- AI assistants (Claude Code can read/write bindings)

### Bindings JSON Structure

\`\`\`json
{
  "version": "1.0",
  "pipelineId": "${id}",
  "bindings": [
    {
      "id": "b1",
      "type": "depicts",
      "source": { "entityType": "shot", "entityId": "shot-ext-park-1" },
      "target": { "entityType": "character", "entityId": "char-emma" },
      "confidence": 1.0,
      "origin": "auto:character-in-shot"
    }
  ]
}
\`\`\`

Binding types: \`depicts\` (character in shot), \`set-in\` (shot in location), \`voice\` (dialogue speaker), or custom types.
`;
}

// ── TODO.json helpers ─────────────────────────────────────────

export interface PipelineTodoItem {
  id: string;
  task: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed';
  node?: string;       // associated node file (e.g. "fetch-data.ts")
  category?: 'design' | 'implement' | 'test' | 'fix' | 'docs' | 'deploy';
  addedAt: string;
  completedAt?: string;
  error?: string;       // error message if failed
  blockedBy?: string[]; // IDs of items that must be done first
}

export interface PipelineTodo {
  pipelineName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  items: PipelineTodoItem[];
}

function generateInitialTodo(name: string, description: string): PipelineTodo {
  const now = new Date().toISOString();
  return {
    pipelineName: name,
    description,
    createdAt: now,
    updatedAt: now,
    items: [
      { id: 'setup', task: 'Scaffold pipeline directory', status: 'done', category: 'design', addedAt: now, completedAt: now },
      { id: 'implement', task: 'Implement all node scripts', status: 'pending', category: 'implement', addedAt: now },
      { id: 'tests', task: 'Write tests for each node', status: 'pending', category: 'test', addedAt: now, blockedBy: ['implement'] },
      { id: 'run-tests', task: 'Run tests and verify they pass', status: 'pending', category: 'test', addedAt: now, blockedBy: ['tests'] },
      { id: 'integration', task: 'Test full pipeline end-to-end', status: 'pending', category: 'test', addedAt: now, blockedBy: ['run-tests'] },
    ],
  };
}

/**
 * Read TODO.json from a pipeline directory. Returns null if not found.
 */
export async function readPipelineTodo(pipelineDir: string): Promise<PipelineTodo | null> {
  try {
    const content = await fs.readFile(join(pipelineDir, 'TODO.json'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write TODO.json to a pipeline directory.
 */
export async function writePipelineTodo(pipelineDir: string, todo: PipelineTodo): Promise<void> {
  todo.updatedAt = new Date().toISOString();
  await fs.writeFile(join(pipelineDir, 'TODO.json'), JSON.stringify(todo, null, 2) + '\n', 'utf-8');
}

/**
 * Add a new script file node to a v2 pipeline.
 * Creates the .ts file with a scaffold and adds the node to the manifest.
 */
export async function addScriptFileNode(
  pipelineDir: string,
  pipeline: PipelineDocument,
  label: string,
  description: string,
  inputs: PortDeclaration[],
  outputs: PortDeclaration[],
  code?: string,
): Promise<PipelineNode> {
  // Generate filename from label
  const fileName = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + '.ts';

  // Generate node ID
  const nodeId = `node-${fileName.replace(/\.ts$/, '')}-${Date.now().toString(36)}`;

  // Write the .ts file to src/
  const srcDir = join(pipelineDir, 'src');
  await fs.mkdir(srcDir, { recursive: true });
  const fileCode = code || generateScaffold(label, description, inputs, outputs);
  await fs.writeFile(join(srcDir, fileName), fileCode, 'utf-8');

  // Store path relative to pipelineDir (includes src/ prefix)
  const relativeFile = `src/${fileName}`;

  // Add node to manifest
  const node: PipelineNode = {
    id: nodeId,
    workflowId: '__script_file__',
    position: { x: 200, y: 100 + pipeline.nodes.length * 150 },
    label,
    scriptFile: {
      file: relativeFile,
      description,
      inputs,
      outputs,
    },
  };

  pipeline.nodes.push(node);
  return node;
}

function generateScaffold(
  label: string,
  description: string,
  inputs: PortDeclaration[],
  outputs: PortDeclaration[],
): string {
  const inputAnnotations = inputs.map(i =>
    ` * @input ${i.name}: ${i.type}${i.description ? ` - ${i.description}` : ''}`
  ).join('\n');
  const outputAnnotations = outputs.map(o =>
    ` * @output ${o.name}: ${o.type}${o.description ? ` - ${o.description}` : ''}`
  ).join('\n');

  const inputType = inputs.length > 0
    ? `{ ${inputs.map(i => `${i.name}: ${tsType(i.type)}`).join('; ')} }`
    : 'Record<string, unknown>';
  const outputType = outputs.length > 0
    ? `{ ${outputs.map(o => `${o.name}: ${tsType(o.type)}`).join('; ')} }`
    : 'Record<string, unknown>';

  return `/**
 * ${label}
 * ${description}
 *
${inputAnnotations}
${outputAnnotations}
 */
export async function execute(
  inputs: ${inputType},
  context: ScriptContext,
): Promise<${outputType}> {
  // TODO: implement
  throw new Error('Not implemented');
}
`;
}

function tsType(portType: string): string {
  switch (portType) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'string[]': return 'string[]';
    default: return 'any';
  }
}

// ── Pipeline migration ────────────────────────────────────────

/**
 * Migrate a v2 pipeline from flat layout (*.ts at root) to src/ layout.
 * Moves script node files into src/ and updates scriptFile.file paths.
 * Also creates bindings/ directory if missing.
 * Returns true if any files were moved.
 */
export async function migratePipelineToSrcLayout(
  pipelineDir: string,
  pipeline: PipelineDocument,
): Promise<boolean> {
  const srcDir = join(pipelineDir, 'src');
  const bindingsDir = join(pipelineDir, 'bindings');
  let anyMoved = false;

  // Check if already migrated (src/ exists and has .ts files)
  let srcHasFiles = false;
  try {
    const srcEntries = await fs.readdir(srcDir);
    srcHasFiles = srcEntries.some(e => e.endsWith('.ts') && !e.endsWith('.d.ts'));
  } catch {
    // src/ doesn't exist yet
  }

  // If no nodes reference src/ paths and src/ has no files, do the migration
  const needsMigration = pipeline.nodes.some(n =>
    n.scriptFile?.file && !n.scriptFile.file.startsWith('src/')
  );

  if (!needsMigration && srcHasFiles) {
    // Already migrated or no script nodes
    // Just ensure bindings/ exists
    await ensureBindingsDir(pipelineDir, pipeline.id);
    return false;
  }

  if (needsMigration) {
    await fs.mkdir(srcDir, { recursive: true });

    for (const node of pipeline.nodes) {
      if (!node.scriptFile?.file) continue;
      if (node.scriptFile.file.startsWith('src/')) continue; // already migrated

      const oldPath = join(pipelineDir, node.scriptFile.file);
      const newPath = join(srcDir, node.scriptFile.file);

      if (existsSync(oldPath)) {
        await fs.rename(oldPath, newPath);
        anyMoved = true;
      }

      // Update the manifest reference
      node.scriptFile.file = `src/${node.scriptFile.file}`;
    }

    // Move test files and helpers too
    try {
      const rootEntries = await fs.readdir(pipelineDir);
      for (const entry of rootEntries) {
        if (
          (entry.endsWith('.test.ts') || entry === '_test-helpers.ts' || entry === '_test-fixtures.ts') &&
          existsSync(join(pipelineDir, entry))
        ) {
          await fs.rename(join(pipelineDir, entry), join(srcDir, entry));
          anyMoved = true;
        }
      }
    } catch {
      // ignore
    }

    // Update tsconfig if it exists
    const tsconfigPath = join(pipelineDir, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      try {
        const tsconfig = JSON.parse(await fs.readFile(tsconfigPath, 'utf-8'));
        if (tsconfig.include && Array.isArray(tsconfig.include)) {
          const hasOldPattern = tsconfig.include.some((p: string) => p === '*.ts');
          if (hasOldPattern) {
            tsconfig.include = tsconfig.include
              .filter((p: string) => p !== '*.ts')
              .concat('src/**/*.ts');
            if (!tsconfig.include.includes('woodbury.d.ts')) {
              tsconfig.include.push('woodbury.d.ts');
            }
            await fs.writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');
          }
        }
      } catch {
        // ignore
      }
    }

    // Update vitest config if it exists
    const vitestPath = join(pipelineDir, 'vitest.config.ts');
    if (existsSync(vitestPath)) {
      try {
        let vitestCode = await fs.readFile(vitestPath, 'utf-8');
        if (vitestCode.includes("'*.test.ts'")) {
          vitestCode = vitestCode.replace("'*.test.ts'", "'src/**/*.test.ts'");
          await fs.writeFile(vitestPath, vitestCode, 'utf-8');
        }
      } catch {
        // ignore
      }
    }

    if (anyMoved) {
      await savePipelineManifest(pipelineDir, pipeline);
    }
  }

  // Ensure bindings/ directory exists
  await ensureBindingsDir(pipelineDir, pipeline.id);

  return anyMoved;
}

/**
 * Check if a pipeline needs migration to the src/ layout.
 */
export function pipelineNeedsMigration(pipeline: PipelineDocument): boolean {
  return pipeline.nodes.some(n =>
    n.scriptFile?.file && !n.scriptFile.file.startsWith('src/')
  );
}

/**
 * Ensure the bindings/ directory and initial files exist.
 */
async function ensureBindingsDir(pipelineDir: string, pipelineId: string): Promise<void> {
  const bindingsDir = join(pipelineDir, 'bindings');
  await fs.mkdir(bindingsDir, { recursive: true });

  const bindingsPath = join(bindingsDir, 'bindings.json');
  if (!existsSync(bindingsPath)) {
    await fs.writeFile(bindingsPath, JSON.stringify({
      version: '1.0', pipelineId, bindings: [],
    }, null, 2), 'utf-8');
  }

  const viewsPath = join(bindingsDir, 'views.json');
  if (!existsSync(viewsPath)) {
    await fs.writeFile(viewsPath, JSON.stringify({
      version: '1.0', pipelineId, views: [],
    }, null, 2), 'utf-8');
  }

  const rulesPath = join(bindingsDir, 'rules.json');
  if (!existsSync(rulesPath)) {
    await fs.writeFile(rulesPath, JSON.stringify({
      version: '1.0', pipelineId, rules: [],
    }, null, 2), 'utf-8');
  }
}

// ── Save manifest ────────────────────────────────────────────

/**
 * Save the pipeline manifest to disk (strips runtime-only fields).
 */
export async function savePipelineManifest(
  pipelineDir: string,
  pipeline: PipelineDocument,
): Promise<void> {
  const manifestPath = join(pipelineDir, 'pipeline.json');
  const toWrite = { ...pipeline };
  delete (toWrite as any).pipelineDir;
  pipeline.metadata = pipeline.metadata || { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  pipeline.metadata.updatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, JSON.stringify(toWrite, null, 2), 'utf-8');
}
