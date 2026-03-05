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
import type { WorkflowDocument, CompositionDocument } from './types.js';

const EXTENSIONS_DIR = join(homedir(), '.woodbury', 'extensions');
const GLOBAL_WORKFLOWS_DIR = join(homedir(), '.woodbury', 'workflows');

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
  source: 'project' | 'global';
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
 * Discover all .composition.json files from project-local and global locations.
 */
export async function discoverCompositions(
  workingDirectory?: string
): Promise<DiscoveredComposition[]> {
  const results: DiscoveredComposition[] = [];

  // 1. Project-local compositions
  if (workingDirectory) {
    const projectDir = join(workingDirectory, '.woodbury-work', 'workflows');
    results.push(...await discoverCompositionsFromDir(projectDir, 'project'));
  }

  // 2. Global user compositions
  results.push(...await discoverCompositionsFromDir(GLOBAL_WORKFLOWS_DIR, 'global'));

  return results;
}

async function discoverCompositionsFromDir(
  dir: string,
  source: DiscoveredComposition['source']
): Promise<DiscoveredComposition[]> {
  const results: DiscoveredComposition[] = [];
  if (!existsSync(dir)) return results;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.composition.json')) continue;
      try {
        const composition = await loadComposition(join(dir, file));
        results.push({ path: join(dir, file), composition, source });
      } catch {
        // Skip invalid
      }
    }
  } catch {
    // Dir not readable
  }

  return results;
}
