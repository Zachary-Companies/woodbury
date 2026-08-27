/**
 * workflow_build Tool
 *
 * Agent-callable tool that lets Claude construct .workflow.json files
 * from live browser interactions. Talks to the Woodbury dashboard API
 * to create, update, and test workflows.
 *
 * Lifecycle:
 *   1. create     — POST /api/workflows → get workflow ID
 *   2. inspect    — query bridge for element ARIA/selector data
 *   3. add_steps  — PUT /api/workflows/:id → append steps
 *   4. finalize   — PUT /api/workflows/:id → final save
 *   5. test       — POST /api/workflows/:id/run → auto-test
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ToolDefinition, ToolHandler, ToolContext } from '../types.js';
import type { WorkflowStep, WorkflowDocument, VariableDeclaration } from '../../workflow/types.js';

// ── Dashboard API client ────────────────────────────────────

async function getDashboardUrl(): Promise<string> {
  try {
    const dashPath = join(homedir(), '.woodbury', 'data', 'dashboard.json');
    const raw = await readFile(dashPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.url) return data.url;
    if (data.port) return `http://127.0.0.1:${data.port}`;
  } catch { /* fall through */ }
  return 'http://127.0.0.1:9001';
}

async function dashFetch(path: string, opts?: RequestInit): Promise<any> {
  const base = await getDashboardUrl();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === 'object' ? body.error || JSON.stringify(body) : body;
    throw new Error(`Dashboard API ${res.status}: ${msg}`);
  }
  return body;
}

// ── In-session state ────────────────────────────────────────

let activeWorkflowId: string | null = null;
let pendingSteps: WorkflowStep[] = [];
let workflowDoc: Partial<WorkflowDocument> | null = null;

// ── Tool definition ─────────────────────────────────────────

export const workflowBuildDefinition: ToolDefinition = {
  name: 'workflow_build',
  description: `Create, build, and test reusable browser workflows via the Woodbury dashboard API. Workflows run at zero token cost.

Actions:
- "create": Start a new workflow (name, site, description, variables)
- "inspect_element": Get ARIA label, role, selector, and bounds for an element — returns a ready-to-use ElementTarget
- "add_steps": Append steps to the in-progress workflow
- "test_step": Test a single step via debug mode — runs steps up to stepIndex and returns the result
- "update_step": Replace a step at a given index (for fixing targeting after test_step fails)
- "finalize": Validate and save the complete workflow
- "test": Run the full workflow to verify it works end-to-end, returns step-by-step results

Typical flow:
1. create → 2. (inspect_element → add_steps → test_step → verify/fix) × N → 3. finalize → 4. test

Targeting priority: accessibilityQuery > ariaLabel+role > textContent > CSS selector.
Always include expectedBounds (percentage) for disambiguation.
Use {{variables}} for user-specific values.`,
  dangerous: false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'inspect_element', 'add_steps', 'test_step', 'update_step', 'finalize', 'test'],
        description: 'The workflow build action to perform.',
      },
      // create params
      name: {
        type: 'string',
        description: 'Workflow name (for action: "create").',
      },
      description: {
        type: 'string',
        description: 'What this workflow does (for action: "create").',
      },
      site: {
        type: 'string',
        description: 'Target site domain, e.g. "github.com" (for action: "create").',
      },
      variables: {
        type: 'array',
        description: 'Variable declarations for the workflow (for action: "create"). Each: { name, description, type, required?, default? }',
        items: { type: 'object' },
      },
      // inspect_element params
      selector: {
        type: 'string',
        description: 'CSS selector to inspect (for action: "inspect_element").',
      },
      query: {
        type: 'string',
        description: 'Natural language description to find the element (for action: "inspect_element"). Alternative to selector.',
      },
      // add_steps params
      steps: {
        type: 'array',
        description: 'Workflow steps to append (for action: "add_steps"). Each step needs at minimum: id, label, type, and type-specific fields.',
        items: { type: 'object' },
      },
      // test_step / update_step params
      stepIndex: {
        type: 'number',
        description: 'Step index to test or update (for action: "test_step" or "update_step"). Defaults to the last added step.',
      },
      updatedStep: {
        type: 'object',
        description: 'Replacement step object (for action: "update_step"). Must include id, label, type, and type-specific fields.',
      },
      // test params
      testVariables: {
        type: 'object',
        description: 'Variable values to use for the test run (for action: "test" or "test_step").',
      },
    },
    required: ['action'],
  },
};

// ── Tool handler ────────────────────────────────────────────

export const workflowBuildHandler: ToolHandler = async (
  params: any,
  context?: ToolContext
): Promise<string> => {
  const action = params.action as string;

  switch (action) {
    case 'create':
      return handleCreate(params);
    case 'inspect_element':
      return handleInspectElement(params);
    case 'add_steps':
      return handleAddSteps(params);
    case 'test_step':
      return handleTestStep(params);
    case 'update_step':
      return handleUpdateStep(params);
    case 'finalize':
      return handleFinalize();
    case 'test':
      return handleTest(params);
    default:
      throw new Error(`Unknown action: ${action}. Use: create, inspect_element, add_steps, test_step, update_step, finalize, test`);
  }
};

// ── Action handlers ─────────────────────────────────────────

async function handleCreate(params: any): Promise<string> {
  if (!params.name) throw new Error('name is required for create action');

  const body: any = {
    name: params.name,
    description: params.description || '',
    site: params.site || '',
    steps: [],
  };
  if (params.variables) {
    body.variables = params.variables;
  }

  const result = await dashFetch('/api/workflows', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  activeWorkflowId = result.workflow?.id || null;
  pendingSteps = [];
  workflowDoc = result.workflow || null;

  return JSON.stringify({
    success: true,
    workflowId: activeWorkflowId,
    path: result.path,
    message: `Workflow "${params.name}" created. Use inspect_element to discover ARIA targeting, then add_steps to record actions.`,
  }, null, 2);
}

async function handleInspectElement(params: any): Promise<string> {
  // Call the dashboard bridge to inspect the element
  const base = await getDashboardUrl();

  let elementInfo: any;

  if (params.selector) {
    // Use bridge find_elements + get_element_info
    const findResult = await dashFetch('/api/bridge/query', {
      method: 'POST',
      body: JSON.stringify({ action: 'find_elements', selector: params.selector, limit: 1 }),
    });

    elementInfo = await dashFetch('/api/bridge/query', {
      method: 'POST',
      body: JSON.stringify({ action: 'get_element_info', selector: params.selector }),
    });
  } else if (params.query) {
    // Use find_interactive (natural language)
    elementInfo = await dashFetch('/api/bridge/query', {
      method: 'POST',
      body: JSON.stringify({ action: 'find_interactive', description: params.query, limit: 1 }),
    });
  } else {
    throw new Error('Either selector or query is required for inspect_element');
  }

  // Extract and format as an ElementTarget
  const target = formatAsElementTarget(elementInfo);

  return JSON.stringify({
    success: true,
    elementTarget: target,
    raw: elementInfo,
    message: 'Use this elementTarget object as the "target" field in click/type/scroll steps.',
  }, null, 2);
}

async function handleAddSteps(params: any): Promise<string> {
  if (!activeWorkflowId) {
    throw new Error('No active workflow. Call workflow_build with action:"create" first.');
  }
  if (!params.steps || !Array.isArray(params.steps) || params.steps.length === 0) {
    throw new Error('steps array is required and must be non-empty.');
  }

  // Assign IDs to steps that don't have them
  for (const step of params.steps) {
    if (!step.id) {
      step.id = `step-${pendingSteps.length + params.steps.indexOf(step) + 1}`;
    }
    if (!step.label) {
      step.label = `${step.type} step`;
    }
  }

  pendingSteps.push(...params.steps);

  // Update the workflow via API
  const current = await dashFetch(`/api/workflows/${activeWorkflowId}`);
  const doc = current.workflow;
  doc.steps = pendingSteps;
  doc.metadata.updatedAt = new Date().toISOString();

  await dashFetch(`/api/workflows/${activeWorkflowId}`, {
    method: 'PUT',
    body: JSON.stringify({ workflow: doc }),
  });

  return JSON.stringify({
    success: true,
    totalSteps: pendingSteps.length,
    addedSteps: params.steps.length,
    message: `Added ${params.steps.length} step(s). Total: ${pendingSteps.length}. Continue with inspect_element + add_steps, or finalize when done.`,
  }, null, 2);
}

async function handleTestStep(params: any): Promise<string> {
  if (!activeWorkflowId) {
    throw new Error('No active workflow. Call workflow_build with action:"create" first.');
  }
  if (pendingSteps.length === 0) {
    throw new Error('No steps to test. Use add_steps first.');
  }

  const targetIndex = params.stepIndex ?? pendingSteps.length - 1;
  if (targetIndex < 0 || targetIndex >= pendingSteps.length) {
    throw new Error(`stepIndex ${targetIndex} out of range (0-${pendingSteps.length - 1})`);
  }

  try {
    // Start debug mode
    await dashFetch(`/api/workflows/${activeWorkflowId}/debug/start`, {
      method: 'POST',
      body: JSON.stringify({ variables: params.testVariables || {} }),
    });

    // Step through until we reach the target step
    let lastResult: any = null;
    for (let i = 0; i <= targetIndex; i++) {
      await new Promise(r => setTimeout(r, 500)); // brief pause between steps
      lastResult = await dashFetch(`/api/workflows/${activeWorkflowId}/debug/step`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      // If a step before our target failed, report it
      if (i < targetIndex && lastResult?.stepResult?.status === 'failed') {
        await exitDebugMode();
        return JSON.stringify({
          success: false,
          failedAtIndex: i,
          failedStep: pendingSteps[i]?.label || `step ${i}`,
          error: lastResult.stepResult?.error || 'Step failed',
          message: `Step ${i} ("${pendingSteps[i]?.label}") failed before reaching target step ${targetIndex}. Fix earlier steps first.`,
        }, null, 2);
      }
    }

    // Exit debug mode
    await exitDebugMode();

    // Extract the result for the target step
    const stepResult = lastResult?.stepResult || lastResult;
    const passed = stepResult?.status === 'success' || stepResult?.success === true;

    return JSON.stringify({
      success: true,
      passed,
      stepIndex: targetIndex,
      stepLabel: pendingSteps[targetIndex]?.label || `step ${targetIndex}`,
      stepResult: {
        status: passed ? 'success' : 'failed',
        error: stepResult?.error || undefined,
        coordinateInfo: stepResult?.coordinateInfo || lastResult?.coordinateInfo || undefined,
      },
      message: passed
        ? `Step ${targetIndex} ("${pendingSteps[targetIndex]?.label}") passed. Take a screenshot to verify the browser state, then continue.`
        : `Step ${targetIndex} ("${pendingSteps[targetIndex]?.label}") failed: ${stepResult?.error || 'unknown error'}. Use update_step to fix targeting, then test_step again.`,
    }, null, 2);
  } catch (err: any) {
    // Ensure debug mode is exited on error
    await exitDebugMode();
    return JSON.stringify({
      success: false,
      error: err.message || String(err),
      message: 'test_step failed. Check that the dashboard is running and the Chrome extension is connected.',
    }, null, 2);
  }
}

async function exitDebugMode(): Promise<void> {
  if (!activeWorkflowId) return;
  try {
    await dashFetch(`/api/workflows/${activeWorkflowId}/debug/exit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch { /* best effort */ }
}

async function handleUpdateStep(params: any): Promise<string> {
  if (!activeWorkflowId) {
    throw new Error('No active workflow. Call workflow_build with action:"create" first.');
  }
  if (!params.updatedStep) {
    throw new Error('updatedStep is required for update_step action.');
  }

  const targetIndex = params.stepIndex ?? pendingSteps.length - 1;
  if (targetIndex < 0 || targetIndex >= pendingSteps.length) {
    throw new Error(`stepIndex ${targetIndex} out of range (0-${pendingSteps.length - 1})`);
  }

  const oldLabel = pendingSteps[targetIndex]?.label || `step ${targetIndex}`;
  pendingSteps[targetIndex] = params.updatedStep;

  // Persist to API
  const current = await dashFetch(`/api/workflows/${activeWorkflowId}`);
  const doc = current.workflow;
  doc.steps = pendingSteps;
  doc.metadata.updatedAt = new Date().toISOString();

  await dashFetch(`/api/workflows/${activeWorkflowId}`, {
    method: 'PUT',
    body: JSON.stringify({ workflow: doc }),
  });

  return JSON.stringify({
    success: true,
    stepIndex: targetIndex,
    oldLabel,
    newLabel: params.updatedStep.label || oldLabel,
    message: `Step ${targetIndex} updated. Use test_step to verify the fix.`,
  }, null, 2);
}

async function handleFinalize(): Promise<string> {
  if (!activeWorkflowId) {
    throw new Error('No active workflow. Call workflow_build with action:"create" first.');
  }

  // Fetch the current state to validate
  const current = await dashFetch(`/api/workflows/${activeWorkflowId}`);
  const doc = current.workflow as WorkflowDocument;

  // Validate
  const errors: string[] = [];

  if (!doc.steps || doc.steps.length === 0) {
    errors.push('Workflow has no steps. Use add_steps to add at least one step.');
  }

  // Check for duplicate step IDs
  const ids = new Set<string>();
  for (const step of doc.steps || []) {
    if (ids.has(step.id)) {
      errors.push(`Duplicate step ID: "${step.id}"`);
    }
    ids.add(step.id);
  }

  // Check variable references
  const declaredVars = new Set((doc.variables || []).map(v => v.name));
  const varRefPattern = /\{\{(\w+)\}\}/g;
  const stepJson = JSON.stringify(doc.steps);
  let match;
  while ((match = varRefPattern.exec(stepJson)) !== null) {
    if (!declaredVars.has(match[1])) {
      errors.push(`Variable "{{${match[1]}}}" is used but not declared in workflow variables.`);
    }
  }

  if (errors.length > 0) {
    return JSON.stringify({
      success: false,
      errors,
      message: 'Validation failed. Fix the issues and try finalize again.',
    }, null, 2);
  }

  // Mark as finalized
  doc.metadata.updatedAt = new Date().toISOString();
  await dashFetch(`/api/workflows/${activeWorkflowId}`, {
    method: 'PUT',
    body: JSON.stringify({ workflow: doc }),
  });

  return JSON.stringify({
    success: true,
    workflowId: activeWorkflowId,
    stepCount: doc.steps.length,
    variableCount: doc.variables?.length || 0,
    path: current.path,
    message: `Workflow finalized with ${doc.steps.length} steps. Use action:"test" to auto-test it.`,
  }, null, 2);
}

async function handleTest(params: any): Promise<string> {
  if (!activeWorkflowId) {
    throw new Error('No active workflow. Call workflow_build with action:"create" first.');
  }

  // Trigger a test run
  const runResult = await dashFetch(`/api/workflows/${activeWorkflowId}/run`, {
    method: 'POST',
    body: JSON.stringify({ variables: params.testVariables || {} }),
  });

  if (!runResult.success) {
    return JSON.stringify({
      success: false,
      error: runResult.error || 'Failed to start test run',
    }, null, 2);
  }

  // Poll for completion
  const maxWaitMs = 120000; // 2 minute timeout
  const pollIntervalMs = 2000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const status = await dashFetch('/api/workflows/run/status');

    if (!status.active || status.done) {
      // Run completed
      const passed = status.success === true;
      const stepResults = (status.stepResults || []).map((sr: any) => ({
        step: sr.label || sr.type,
        status: sr.status,
        error: sr.error || undefined,
      }));

      // Reset session state on success
      if (passed) {
        const savedId = activeWorkflowId;
        activeWorkflowId = null;
        pendingSteps = [];
        workflowDoc = null;

        return JSON.stringify({
          success: true,
          passed: true,
          workflowId: savedId,
          stepsCompleted: status.stepsCompleted,
          stepsTotal: status.stepsTotal,
          durationMs: status.durationMs,
          stepResults,
          message: `Test passed! Workflow "${savedId}" is ready. It can now be run at zero token cost via workflow_play or the Woodbury dashboard.`,
        }, null, 2);
      }

      return JSON.stringify({
        success: true,
        passed: false,
        workflowId: activeWorkflowId,
        stepsCompleted: status.stepsCompleted,
        stepsTotal: status.stepsTotal,
        error: status.error,
        stepResults,
        message: 'Test failed. Review the step results to identify and fix targeting issues, then test again.',
      }, null, 2);
    }
  }

  return JSON.stringify({
    success: false,
    error: 'Test run timed out after 2 minutes. The workflow may still be running — check the dashboard.',
  }, null, 2);
}

// ── Helpers ─────────────────────────────────────────────────

function formatAsElementTarget(info: any): Record<string, any> {
  if (!info || typeof info !== 'object') return {};

  const target: Record<string, any> = {};

  // ARIA-based (preferred)
  if (info.ariaLabel || info['aria-label']) {
    target.ariaLabel = info.ariaLabel || info['aria-label'];
  }
  if (info.role) {
    target.role = info.role;
  }
  // Build accessibilityQuery if we have role
  if (target.role) {
    const name = target.ariaLabel || info.accessibleName || info.name;
    if (name) {
      target.accessibilityQuery = `role:${target.role}[name:${name}]`;
    }
  }

  // Text-based
  if (info.textContent || info.text || info.innerText) {
    target.textContent = info.textContent || info.text || info.innerText;
  }
  if (info.placeholder) target.placeholder = info.placeholder;
  if (info.title) target.title = info.title;
  if (info.alt) target.alt = info.alt;

  // CSS selector
  if (info.selector) target.selector = info.selector;
  if (info.dataTestId || info['data-testid']) {
    target.dataTestId = info.dataTestId || info['data-testid'];
  }

  // Position / bounds
  const pos = info.position || info.bounds;
  if (pos && info.viewport) {
    const vpW = info.viewport.width || 1920;
    const vpH = info.viewport.height || 1080;
    target.expectedBounds = {
      left: pos.left,
      top: pos.top,
      width: pos.width,
      height: pos.height,
      pctX: ((pos.left + pos.width / 2) / vpW) * 100,
      pctY: ((pos.top + pos.height / 2) / vpH) * 100,
      pctW: (pos.width / vpW) * 100,
      pctH: (pos.height / vpH) * 100,
      viewportW: vpW,
      viewportH: vpH,
      tolerance: 50,
    };
  }

  return target;
}
