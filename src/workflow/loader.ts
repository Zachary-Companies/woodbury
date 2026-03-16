/**
 * Workflow Loader
 *
 * Loads and validates .workflow.json and .workflow.js files from disk.
 * Discovers workflows from three locations:
 *   1. Extension workflows: ~/.woodbury/extensions/<name>/workflows/
 *   2. Project-local: .woodbury-work/workflows/
 *   3. Global user: ~/.woodbury/workflows/
 */

import { promises as fs } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { WorkflowDocument, CompositionDocument, PipelineDocument, AnyCompositionDocument, PipelineNode, ScriptFileNodeConfig } from './types.js';
import { isPipelineDocument } from './types.js';

const EXTENSIONS_DIR = join(homedir(), '.woodbury', 'extensions');
const GLOBAL_WORKFLOWS_DIR = join(homedir(), '.woodbury', 'workflows');

/** Bundled extensions shipped with Woodbury (same logic as extension-loader.ts) */
const BUNDLED_EXTENSIONS_DIR = existsSync(join(__dirname, 'extensions'))
  ? join(__dirname, 'extensions')
  : join(__dirname, '..', 'extensions');

// ── In-memory registry ───────────────────────────────────────
// Loaded once on first access, then kept in memory permanently.
// Only re-scans when explicitly invalidated by a mutation
// (write, delete, rename, etc.).

interface RegistryEntry<T> {
  data: T;
  key: string; // workingDirectory key
}

let workflowRegistry: RegistryEntry<DiscoveredWorkflow[]> | null = null;
let compositionRegistry: RegistryEntry<DiscoveredComposition[]> | null = null;

function isRegistryValid<T>(reg: RegistryEntry<T> | null, key: string): reg is RegistryEntry<T> {
  if (!reg) return false;
  return reg.key === key;
}

/** Invalidate the workflow registry (call after workflow mutations). */
export function invalidateWorkflowCache(): void {
  workflowRegistry = null;
}

/** Invalidate the composition registry (call after composition mutations). */
export function invalidateCompositionCache(): void {
  compositionRegistry = null;
}

/** Invalidate both registries. */
export function invalidateAllCaches(): void {
  workflowRegistry = null;
  compositionRegistry = null;
}

export interface DiscoveredWorkflow {
  /** Full path to the workflow file */
  path: string;
  /** Workflow document */
  workflow: WorkflowDocument;
  /** Where it was found */
  source: 'extension' | 'project' | 'global';
  /** Extension name (if source is 'extension') */
  extensionName?: string;
  /** File format: json or code (.workflow.js) */
  format: 'json' | 'code';
}

/**
 * Load a single workflow file from disk.
 * Supports both .workflow.json and .workflow.js formats.
 * Validates required fields.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDocument> {
  const absolutePath = resolve(filePath);

  let doc: WorkflowDocument;

  if (absolutePath.endsWith('.workflow.js')) {
    // Code workflow — require() the module
    // Clear the require cache so changes are picked up on reload
    delete require.cache[absolutePath];
    const exported = require(absolutePath);
    doc = exported.default || exported;
  } else {
    // JSON workflow
    const content = await fs.readFile(absolutePath, 'utf-8');
    doc = JSON.parse(content);
  }

  // Validate required fields
  if (!doc.version) {
    throw new Error(`Workflow missing "version" field: ${filePath}`);
  }
  if (!doc.id) {
    throw new Error(`Workflow missing "id" field: ${filePath}`);
  }
  if (!doc.name) {
    throw new Error(`Workflow missing "name" field: ${filePath}`);
  }
  if (!Array.isArray(doc.steps)) {
    throw new Error(`Workflow missing or invalid "steps" array: ${filePath}`);
  }

  return doc;
}

/**
 * Discover all workflow files from the three standard locations.
 */
export async function discoverWorkflows(
  workingDirectory?: string
): Promise<DiscoveredWorkflow[]> {
  const regKey = workingDirectory || '__no_workdir__';

  // Return from in-memory registry if populated
  if (isRegistryValid(workflowRegistry, regKey)) {
    return workflowRegistry.data;
  }

  const results: DiscoveredWorkflow[] = [];

  // 1. Extension workflows
  const extWorkflows = await discoverExtensionWorkflows();
  results.push(...extWorkflows);

  // 2. Project-local workflows
  if (workingDirectory) {
    const projectDir = join(workingDirectory, '.woodbury-work', 'workflows');
    const projectWorkflows = await discoverFromDirectory(projectDir, 'project');
    results.push(...projectWorkflows);
  }

  // 3. Global user workflows
  const globalWorkflows = await discoverFromDirectory(GLOBAL_WORKFLOWS_DIR, 'global');
  results.push(...globalWorkflows);

  // Store in registry — stays until explicitly invalidated
  workflowRegistry = { data: results, key: regKey };

  return results;
}

/**
 * Discover workflows from all extension directories.
 */
async function discoverExtensionWorkflows(): Promise<DiscoveredWorkflow[]> {
  const results: DiscoveredWorkflow[] = [];

  if (!existsSync(EXTENSIONS_DIR)) return results;

  try {
    const entries = await fs.readdir(EXTENSIONS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      if (!entry.isDirectory()) continue;

      const workflowDir = join(EXTENSIONS_DIR, entry.name, 'workflows');
      const workflows = await discoverFromDirectory(workflowDir, 'extension');

      for (const wf of workflows) {
        wf.extensionName = entry.name;
      }

      results.push(...workflows);
    }
  } catch {
    // Extensions dir not readable
  }

  return results;
}

/**
 * Discover all .workflow.json and .workflow.js files in a directory.
 */
async function discoverFromDirectory(
  dir: string,
  source: DiscoveredWorkflow['source']
): Promise<DiscoveredWorkflow[]> {
  const results: DiscoveredWorkflow[] = [];

  if (!existsSync(dir)) return results;

  try {
    const files = await fs.readdir(dir);

    for (const file of files) {
      const isJson = file.endsWith('.workflow.json');
      const isCode = file.endsWith('.workflow.js');
      if (!isJson && !isCode) continue;

      const filePath = join(dir, file);

      try {
        const workflow = await loadWorkflow(filePath);
        results.push({ path: filePath, workflow, source, format: isCode ? 'code' : 'json' });
      } catch {
        // Skip invalid workflow files
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}

/**
 * Find a workflow by ID across all discovery locations.
 */
export async function findWorkflowById(
  id: string,
  workingDirectory?: string
): Promise<DiscoveredWorkflow | null> {
  const all = await discoverWorkflows(workingDirectory);
  return all.find(w => w.workflow.id === id) || null;
}

/**
 * Load all workflow documents from a specific directory.
 * Used by extensions to load their own workflows.
 */
export async function loadWorkflowsFromDir(dir: string): Promise<WorkflowDocument[]> {
  const workflows: WorkflowDocument[] = [];
  const workflowDir = join(dir, 'workflows');

  if (!existsSync(workflowDir)) return workflows;

  try {
    const files = await fs.readdir(workflowDir);

    for (const file of files) {
      if (!file.endsWith('.workflow.json') && !file.endsWith('.workflow.js')) continue;

      try {
        const workflow = await loadWorkflow(join(workflowDir, file));
        workflows.push(workflow);
      } catch {
        // Skip invalid
      }
    }
  } catch {
    // Dir not readable
  }

  return workflows;
}

// ────────────────────────────────────────────────────────────────
//  Composition discovery (same pattern as workflows)
// ────────────────────────────────────────────────────────────────

export interface DiscoveredComposition {
  path: string;
  composition: CompositionDocument;
  source: 'project' | 'global' | 'extension';
  extensionName?: string;
  /** True if this is a v2 file-backed pipeline directory */
  isV2Pipeline?: boolean;
  /** For v2 pipelines, the directory containing the .ts files */
  pipelineDir?: string;
}

/**
 * Load a single composition file from disk.
 */
export async function loadComposition(filePath: string): Promise<CompositionDocument> {
  const absolutePath = resolve(filePath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  const doc: CompositionDocument = JSON.parse(content);

  if (!doc.version) throw new Error(`Composition missing "version": ${filePath}`);
  if (!doc.id) throw new Error(`Composition missing "id": ${filePath}`);
  if (!doc.name) throw new Error(`Composition missing "name": ${filePath}`);
  if (!Array.isArray(doc.nodes)) throw new Error(`Composition missing "nodes": ${filePath}`);
  if (!Array.isArray(doc.edges)) throw new Error(`Composition missing "edges": ${filePath}`);

  return doc;
}

/**
 * Load a v2 file-backed pipeline from a directory containing pipeline.json.
 * Reads each script file node's code from its .ts file on disk.
 */
export async function loadPipeline(dirPath: string): Promise<PipelineDocument> {
  const manifestPath = join(dirPath, 'pipeline.json');
  const content = await fs.readFile(manifestPath, 'utf-8');
  const doc: PipelineDocument = JSON.parse(content);

  if (!doc.version || doc.version !== '2.0') throw new Error(`Pipeline missing version 2.0: ${manifestPath}`);
  if (!doc.id) throw new Error(`Pipeline missing "id": ${manifestPath}`);
  if (!doc.name) throw new Error(`Pipeline missing "name": ${manifestPath}`);
  if (!Array.isArray(doc.nodes)) throw new Error(`Pipeline missing "nodes": ${manifestPath}`);
  if (!Array.isArray(doc.edges)) throw new Error(`Pipeline missing "edges": ${manifestPath}`);

  // Set the pipeline directory path (not persisted, runtime only)
  doc.pipelineDir = resolve(dirPath);

  return doc;
}

/**
 * Read the TypeScript source code for a file-backed script node.
 */
export async function readScriptFileCode(pipelineDir: string, scriptFile: ScriptFileNodeConfig): Promise<string> {
  const filePath = join(pipelineDir, scriptFile.file);
  return await fs.readFile(filePath, 'utf-8');
}

/**
 * Write TypeScript source code for a file-backed script node.
 */
export async function writeScriptFileCode(pipelineDir: string, fileName: string, code: string): Promise<void> {
  const filePath = join(pipelineDir, fileName);
  await fs.writeFile(filePath, code, 'utf-8');
}

/**
 * Discover all .composition.json files from project-local and global locations.
 */
export async function discoverCompositions(
  workingDirectory?: string
): Promise<DiscoveredComposition[]> {
  const regKey = workingDirectory || '__no_workdir__';

  // Return from in-memory registry if populated
  if (isRegistryValid(compositionRegistry, regKey)) {
    return compositionRegistry.data;
  }

  const results: DiscoveredComposition[] = [];

  // 1. Extension compositions (user-installed + bundled)
  results.push(...await discoverExtensionCompositions());

  // 2. Project-local compositions
  if (workingDirectory) {
    const projectDir = join(workingDirectory, '.woodbury-work', 'workflows');
    results.push(...await discoverCompositionsFromDir(projectDir, 'project'));
  }

  // 3. Global user compositions
  results.push(...await discoverCompositionsFromDir(GLOBAL_WORKFLOWS_DIR, 'global'));

  // Store in registry — stays until explicitly invalidated
  compositionRegistry = { data: results, key: regKey };

  return results;
}

/**
 * Discover compositions from extension directories (user-installed + bundled).
 * Scans both the extension root and a `workflows/` subdirectory for .composition.json files.
 */
async function discoverExtensionCompositions(): Promise<DiscoveredComposition[]> {
  const results: DiscoveredComposition[] = [];
  const seen = new Set<string>(); // Deduplicate by composition ID

  for (const extDir of [EXTENSIONS_DIR, BUNDLED_EXTENSIONS_DIR]) {
    if (!existsSync(extDir)) continue;

    try {
      const entries = await fs.readdir(extDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        if (!entry.isDirectory()) continue;

        const extRoot = join(extDir, entry.name);

        // Scan the extension root directory for .composition.json files
        const rootComps = await discoverCompositionsFromDir(extRoot, 'extension');
        for (const comp of rootComps) {
          if (!seen.has(comp.composition.id)) {
            comp.extensionName = entry.name;
            seen.add(comp.composition.id);
            results.push(comp);
          }
        }

        // Also scan a workflows/ subdirectory if it exists
        const wfDir = join(extRoot, 'workflows');
        const wfComps = await discoverCompositionsFromDir(wfDir, 'extension');
        for (const comp of wfComps) {
          if (!seen.has(comp.composition.id)) {
            comp.extensionName = entry.name;
            seen.add(comp.composition.id);
            results.push(comp);
          }
        }
      }
    } catch {
      // Extensions dir not readable
    }
  }

  return results;
}

async function discoverCompositionsFromDir(
  dir: string,
  source: DiscoveredComposition['source']
): Promise<DiscoveredComposition[]> {
  const results: DiscoveredComposition[] = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // Scan for v1 .composition.json files
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.composition.json')) continue;
      try {
        const composition = await loadComposition(join(dir, entry.name));
        results.push({ path: join(dir, entry.name), composition, source });
      } catch {
        // Skip invalid
      }
    }

    // Also scan for v2 pipeline directories (contain pipeline.json)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const pipelineJsonPath = join(dir, entry.name, 'pipeline.json');
      if (!existsSync(pipelineJsonPath)) continue;
      try {
        const pipeline = await loadPipeline(join(dir, entry.name));
        // Wrap as DiscoveredComposition — the composition field accepts the pipeline doc
        // since PipelineDocument shares the same shape
        results.push({
          path: pipelineJsonPath,
          composition: pipeline as unknown as CompositionDocument,
          source,
          isV2Pipeline: true,
          pipelineDir: pipeline.pipelineDir,
        });
      } catch {
        // Skip invalid pipeline directories
      }
    }
  } catch {
    // Dir not readable
  }

  return results;
}
