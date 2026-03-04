/**
 * Workflow Sanitizer
 *
 * Strips local-only data from a WorkflowDocument before uploading to the marketplace.
 * Keeps percentage coordinates and reference images needed for screen adaptation.
 * Removes local file paths, user agents, training metadata.
 */

import type { WorkflowDocument } from '../workflow/types.js';

/**
 * Create a sanitized copy of a workflow document ready for publishing.
 * Does NOT mutate the original.
 */
export function sanitizeWorkflow(workflow: WorkflowDocument): WorkflowDocument {
  // Deep clone to avoid mutating the original
  const sanitized: WorkflowDocument = JSON.parse(JSON.stringify(workflow));

  // Sanitize metadata
  if (sanitized.metadata) {
    // Remove user agent — it's a fingerprint
    if (sanitized.metadata.environment) {
      delete sanitized.metadata.environment.userAgent;
    }

    // Remove local model path (the model file is uploaded separately)
    delete sanitized.metadata.modelPath;

    // Remove training run details (internal, not useful to consumers)
    delete sanitized.metadata.trainingRun;
    delete sanitized.metadata.trainingStatus;
  }

  // Sanitize steps — remove any local file paths embedded in step data
  if (sanitized.steps) {
    sanitized.steps = (sanitized.steps as unknown as Record<string, unknown>[]).map(sanitizeStep) as unknown as WorkflowDocument['steps'];
  }

  return sanitized;
}

/**
 * Sanitize a single step. Strips local paths from step data while
 * preserving selectors, reference images, and percentage coordinates.
 */
function sanitizeStep(step: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...step };

  // For steps with nested steps (conditional, loop, try-catch), recurse
  if (Array.isArray(cleaned.thenSteps)) {
    cleaned.thenSteps = (cleaned.thenSteps as Record<string, unknown>[]).map(sanitizeStep);
  }
  if (Array.isArray(cleaned.elseSteps)) {
    cleaned.elseSteps = (cleaned.elseSteps as Record<string, unknown>[]).map(sanitizeStep);
  }
  if (Array.isArray(cleaned.loopSteps)) {
    cleaned.loopSteps = (cleaned.loopSteps as Record<string, unknown>[]).map(sanitizeStep);
  }
  if (Array.isArray(cleaned.trySteps)) {
    cleaned.trySteps = (cleaned.trySteps as Record<string, unknown>[]).map(sanitizeStep);
  }
  if (Array.isArray(cleaned.catchSteps)) {
    cleaned.catchSteps = (cleaned.catchSteps as Record<string, unknown>[]).map(sanitizeStep);
  }
  if (Array.isArray(cleaned.steps)) {
    cleaned.steps = (cleaned.steps as Record<string, unknown>[]).map(sanitizeStep);
  }

  // Remove local file paths from download/file-related steps
  if (cleaned.type === 'moveFile') {
    // Keep the glob pattern but strip absolute source/dest paths
    if (typeof cleaned.sourcePath === 'string' && isAbsolutePath(cleaned.sourcePath as string)) {
      cleaned.sourcePath = stripToFilename(cleaned.sourcePath as string);
    }
    if (typeof cleaned.destinationPath === 'string' && isAbsolutePath(cleaned.destinationPath as string)) {
      cleaned.destinationPath = stripToFilename(cleaned.destinationPath as string);
    }
  }

  if (cleaned.type === 'fileDialog') {
    if (typeof cleaned.filePath === 'string' && isAbsolutePath(cleaned.filePath as string)) {
      cleaned.filePath = stripToFilename(cleaned.filePath as string);
    }
  }

  if (cleaned.type === 'desktopLaunchApp') {
    if (typeof cleaned.appPath === 'string' && isAbsolutePath(cleaned.appPath as string)) {
      cleaned.appPath = stripToFilename(cleaned.appPath as string);
    }
  }

  // For sub-workflows, strip the local path but keep the workflow ID
  if (cleaned.type === 'subWorkflow') {
    delete cleaned.workflowPath;
  }

  return cleaned;
}

/** Check if a string looks like an absolute file path */
function isAbsolutePath(str: string): boolean {
  return str.startsWith('/') || /^[a-zA-Z]:\\/.test(str);
}

/** Strip an absolute path to just the filename */
function stripToFilename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Extract step type strings from a workflow (for badges/metadata).
 */
export function extractStepTypes(workflow: WorkflowDocument): string[] {
  const types = new Set<string>();
  function walk(steps: Record<string, unknown>[]) {
    for (const step of steps) {
      if (typeof step.type === 'string') {
        types.add(step.type);
      }
      // Recurse into nested steps
      for (const key of ['thenSteps', 'elseSteps', 'loopSteps', 'trySteps', 'catchSteps', 'steps']) {
        if (Array.isArray(step[key])) {
          walk(step[key] as Record<string, unknown>[]);
        }
      }
    }
  }
  if (workflow.steps) {
    walk(workflow.steps as unknown as Record<string, unknown>[]);
  }
  return Array.from(types);
}

/**
 * Count variables in a workflow.
 */
export function countVariables(workflow: WorkflowDocument): number {
  return workflow.variables?.length || 0;
}

/**
 * Count total steps including nested ones.
 */
export function countSteps(workflow: WorkflowDocument): number {
  let count = 0;
  function walk(steps: Record<string, unknown>[]) {
    for (const step of steps) {
      count++;
      for (const key of ['thenSteps', 'elseSteps', 'loopSteps', 'trySteps', 'catchSteps', 'steps']) {
        if (Array.isArray(step[key])) {
          walk(step[key] as Record<string, unknown>[]);
        }
      }
    }
  }
  if (workflow.steps) {
    walk(workflow.steps as unknown as Record<string, unknown>[]);
  }
  return count;
}
