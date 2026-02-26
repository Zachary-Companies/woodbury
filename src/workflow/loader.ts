/**
 * Workflow Loader
 *
 * Loads and validates .workflow.json files from disk.
 * Discovers workflows from three locations:
 *   1. Extension workflows: ~/.woodbury/extensions/<name>/workflows/
 *   2. Project-local: .woodbury-work/workflows/
 *   3. Global user: ~/.woodbury/workflows/
 */

import { promises as fs } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { WorkflowDocument } from './types.js';

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
}

/**
 * Load a single workflow file from disk.
 * Validates required fields.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDocument> {
  const absolutePath = resolve(filePath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  const doc: WorkflowDocument = JSON.parse(content);

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
 * Discover all .workflow.json files in a directory.
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
      if (!file.endsWith('.workflow.json')) continue;

      const filePath = join(dir, file);

      try {
        const workflow = await loadWorkflow(filePath);
        results.push({ path: filePath, workflow, source });
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
      if (!file.endsWith('.workflow.json')) continue;

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
