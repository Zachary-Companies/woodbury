/**
 * Dashboard Route: Workflow Run
 *
 * Handles workflow execution, status polling, cancellation, and debug mode endpoints.
 *
 * Endpoints:
 *   POST /api/workflows/:id/run                  — execute a workflow
 *   GET  /api/workflows/run/status                — poll execution progress
 *   POST /api/workflows/run/cancel                — abort running workflow
 *   POST /api/workflows/:id/debug/start           — enter debug mode
 *   POST /api/workflows/:id/debug/step            — execute next step
 *   POST /api/workflows/:id/debug/exit            — exit debug mode
 *   POST /api/workflows/:id/debug/update-step     — update step properties
 *   POST /api/workflows/:id/debug/capture-element — identify & capture reference image
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody, atomicWriteFile } from '../utils.js';
import { discoverWorkflows } from '../../workflow/loader.js';
import type { RunRecord } from '../../workflow/types.js';
import { ExecutionSnapshotCapture } from '../../workflow/execution-snapshots.js';
import { VisualVerifier } from '../../workflow/visual-verifier.js';
import { bridgeServer, ensureBridgeServer } from '../../bridge-server.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────

const INFERENCE_PORT = 8679;

// ────────────────────────────────────────────────────────────────
//  Run history storage (local to this module)
// ────────────────────────────────────────────────────────────────

const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 500;
let runsCache: RunRecord[] | null = null;

async function loadRuns(): Promise<RunRecord[]> {
  if (runsCache !== null) return runsCache;
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const content = await readFile(RUNS_FILE, 'utf-8');
    runsCache = JSON.parse(content) as RunRecord[];
  } catch {
    runsCache = [];
  }
  return runsCache;
}

async function saveRuns(runs: RunRecord[]): Promise<void> {
  if (runs.length > MAX_RUNS) {
    runs = runs.slice(runs.length - MAX_RUNS);
  }
  runsCache = runs;
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(RUNS_FILE, JSON.stringify(runs, null, 2));
}

function generateRunId(): string {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

async function createRunRecord(record: RunRecord): Promise<void> {
  const runs = await loadRuns();
  runs.push(record);
  await saveRuns(runs);
}

async function updateRunRecord(id: string, updates: Partial<RunRecord>): Promise<void> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.id === id);
  if (idx >= 0) {
    Object.assign(runs[idx], updates);
    await saveRuns(runs);
  }
}

function extractOutputFiles(variables: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const val of Object.values(variables)) {
    if (typeof val === 'string' && (val.startsWith('/') || val.startsWith('~'))) {
      files.push(val);
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('~'))) {
          files.push(item);
        }
      }
    }
  }
  return files;
}

// ────────────────────────────────────────────────────────────────
//  Debug helpers
// ────────────────────────────────────────────────────────────────

/**
 * Flatten nested workflow steps (conditional/loop/try_catch) into a flat list.
 * Each step gets a `_debugLabel` prefix showing its nesting context.
 */
function flattenSteps(steps: any[], prefix = ''): any[] {
  const flat: any[] = [];
  for (const step of steps) {
    if (step.type === 'conditional') {
      flat.push({
        ...step,
        _debugLabel: prefix + (step.label || 'Conditional'),
        _isControlFlow: true,
        _controlFlowType: 'conditional',
      });
      if (step.thenSteps && step.thenSteps.length > 0) {
        flat.push(...flattenSteps(step.thenSteps, prefix + 'Then \u2192 '));
      }
      if (step.elseSteps && step.elseSteps.length > 0) {
        flat.push(...flattenSteps(step.elseSteps, prefix + 'Else \u2192 '));
      }
    } else if (step.type === 'loop') {
      flat.push({
        ...step,
        _debugLabel: prefix + (step.label || 'Loop'),
        _isControlFlow: true,
        _controlFlowType: 'loop',
      });
      if (step.steps && step.steps.length > 0) {
        flat.push(...flattenSteps(step.steps, prefix + 'Loop \u2192 '));
      }
    } else if (step.type === 'try_catch') {
      flat.push({
        ...step,
        _debugLabel: prefix + (step.label || 'Try/Catch'),
        _isControlFlow: true,
        _controlFlowType: 'try_catch',
      });
      if (step.trySteps && step.trySteps.length > 0) {
        flat.push(...flattenSteps(step.trySteps, prefix + 'Try \u2192 '));
      }
      if (step.catchSteps && step.catchSteps.length > 0) {
        flat.push(...flattenSteps(step.catchSteps, prefix + 'Catch \u2192 '));
      }
    } else {
      flat.push({
        ...step,
        _debugLabel: prefix + (step.label || step.id || step.type),
      });
    }
  }
  return flat;
}

/**
 * Recursively find a step by its ID in a nested step tree.
 */
function findStepById(steps: any[], targetId: string): any | null {
  for (const s of steps) {
    if (s.id === targetId) return s;
    for (const key of ['thenSteps', 'elseSteps', 'steps', 'trySteps', 'catchSteps']) {
      if (s[key]) {
        const f = findStepById(s[key], targetId);
        if (f) return f;
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleWorkflowRunRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {

  // POST /api/workflows/:id/run — execute a workflow directly
  const runWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (req.method === 'POST' && runWfMatch) {
    const id = decodeURIComponent(runWfMatch[1]);
    try {
      if (ctx.activeRun && !ctx.activeRun.done) {
        sendJson(res, 409, { error: `Workflow "${ctx.activeRun.workflowName}" is already running. Wait for it to finish or cancel it.` });
        return true;
      }
      if (ctx.activeCompRun && !ctx.activeCompRun.done) {
        sendJson(res, 409, { error: `Composition "${ctx.activeCompRun.compositionName}" is running. Wait for it to finish or cancel it.` });
        return true;
      }

      const body = await readBody(req);
      const variables: Record<string, unknown> = body?.variables || {};

      // Discover and find the workflow
      const discovered = await discoverWorkflows(ctx.workDir);
      const found = discovered.find(d => d.workflow.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Workflow "${id}" not found` });
        return true;
      }

      const wf = found.workflow;

      // Detect desktop workflow: site === 'desktop' or steps contain desktop_ types
      const isDesktopWorkflow = wf.site === 'desktop' ||
        (wf.steps || []).some((s: any) => typeof s.type === 'string' && s.type.startsWith('desktop_'));

      // Only require Chrome extension for browser workflows
      if (!isDesktopWorkflow) {
        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.' });
          return true;
        }
      }
      const abort = new AbortController();

      ctx.activeRun = {
        workflowId: id,
        workflowName: wf.name,
        abort,
        startedAt: Date.now(),
        stepsTotal: wf.steps.length,
        stepsCompleted: 0,
        currentStep: '',
        stepResults: [],
        done: false,
        success: false,
      };

      // Load the workflow runner from the social-scheduler extension
      let executeWorkflow: Function;
      try {
        const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const wfRunner = require(wfRunnerPath);
        executeWorkflow = wfRunner.executeWorkflow;
        if (!executeWorkflow) {
          throw new Error(`executeWorkflow not found in module. Keys: ${Object.keys(wfRunner).join(', ')}`);
        }
      } catch (importErr: any) {
        sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message || String(importErr)}` });
        ctx.activeRun = null;
        return true;
      }

      // Merge defaults for missing variables
      const mergedVars: Record<string, unknown> = { ...variables };
      for (const v of (wf.variables || [])) {
        if (mergedVars[v.name] === undefined && v.default !== undefined) {
          mergedVars[v.name] = v.default;
        }
      }

      // Auto-generate variables with AI prompts that still have no value
      const toGenerate = ((wf.variables || []) as any[]).filter(
        (v: any) => v.generationPrompt && (mergedVars[v.name] === undefined || mergedVars[v.name] === '')
      );
      if (toGenerate.length > 0) {
        debugLog.info('dashboard-run', `Auto-generating ${toGenerate.length} variable(s) with AI prompts`);
        try {
          const { runPrompt } = await import('../../loop/llm-service.js');
          const model = process.env.ANTHROPIC_API_KEY
            ? 'claude-sonnet-4-20250514'
            : process.env.OPENAI_API_KEY
              ? 'gpt-4o-mini'
              : process.env.GROQ_API_KEY
                ? 'llama-3.1-70b-versatile'
                : 'claude-sonnet-4-20250514';

          for (const v of toGenerate) {
            try {
              const genPrompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${v.name}" (type: ${v.type || 'string'})
Workflow: "${wf.name}" on ${wf.site || 'unknown site'}

Instructions from the user:
${v.generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value \u2014 no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

              const llmResponse = await runPrompt(
                [{ role: 'user', content: genPrompt }],
                model,
                { maxTokens: 2048, temperature: 0.9 }
              );
              mergedVars[v.name] = llmResponse.content.trim();
              debugLog.info('dashboard-run', `Generated "${v.name}" (${String(mergedVars[v.name]).length} chars)`);
            } catch (genErr) {
              debugLog.warn('dashboard-run', `Failed to generate "${v.name}": ${genErr}`);
              // Non-fatal — variable stays empty or default
            }
          }
        } catch (importErr) {
          debugLog.warn('dashboard-run', `LLM import failed, skipping auto-generation: ${importErr}`);
        }
      }

      // Create run history record
      const runId = generateRunId();
      ctx.activeRun!.runId = runId;
      await createRunRecord({
        id: runId,
        type: 'workflow',
        sourceId: id,
        name: wf.name,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'running',
        variables: mergedVars,
        stepsTotal: wf.steps.length,
        stepsCompleted: 0,
      } as RunRecord);

      sendJson(res, 200, { success: true, status: 'running', runId, workflowName: wf.name, stepsTotal: wf.steps.length });

      // Set up execution snapshot capture for training data collection (browser workflows only)
      const snapshotCapture = isDesktopWorkflow ? null : new ExecutionSnapshotCapture(id, wf.site || 'unknown', runId);
      ctx.activeSnapshotCapture = snapshotCapture;

      // Execute asynchronously (don't await — we respond immediately)
      const run = ctx.activeRun;
      executeWorkflow(bridgeServer, wf, mergedVars, {
        log: (msg: string) => debugLog.info('dashboard-run', msg),
        signal: abort.signal,
        onProgress: (event: { type: string; index: number; total: number; step: any; status?: string; error?: string }) => {
          if (event.type === 'step_start') {
            run.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
            // Capture page snapshot before each step (fire-and-forget)
            const stepType = event.step?.type || '';
            if (snapshotCapture && ['click', 'type', 'navigate', 'select', 'scroll', 'hover'].includes(stepType)) {
              snapshotCapture.captureSnapshot(bridgeServer).catch(() => {});
            }
          } else if (event.type === 'step_complete') {
            run.stepsCompleted = event.index + 1;
            run.stepResults.push({
              index: event.index,
              label: event.step?.label || event.step?.id || `Step ${event.index + 1}`,
              type: event.step?.type || 'unknown',
              status: event.status || 'unknown',
              error: event.error,
            });
            // Track interaction for training data
            if (event.status === 'success' || event.status === 'passed') {
              const selector = event.step?.selector || event.step?.element?.selector || '';
              if (selector && snapshotCapture) {
                snapshotCapture.trackInteraction(selector, event.step?.type || 'unknown', event.step?.id, event.index);
              }
            }
          }
        },
      }).then(async (result: any) => {
        run.done = true;
        run.success = result.success;
        run.durationMs = result.durationMs;
        run.outputVariables = result.variables;
        if (!result.success) {
          run.error = result.error;
        }
        debugLog.info('dashboard-run', `Workflow "${wf.name}" ${result.success ? 'completed' : 'failed'}`, {
          steps: `${result.stepsExecuted}/${result.stepsTotal}`,
          durationMs: result.durationMs,
        });

        // Handle training data: keep on success, delete on failure (browser workflows only)
        if (snapshotCapture) {
          if (result.success) {
            await snapshotCapture.saveInteractions();
            debugLog.info('dashboard-run', `Run snapshots saved as training data (${snapshotCapture.count} snapshots)`, { runId });
            run.trainingDataKept = true;
          } else {
            await snapshotCapture.deleteRunSnapshots();
            debugLog.info('dashboard-run', 'Run snapshots discarded (run failed)', { runId });
            run.trainingDataKept = false;
          }
        }
        ctx.activeSnapshotCapture = null;

        // Update run history record
        await updateRunRecord(runId, {
          completedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          status: result.success ? 'completed' : 'failed',
          error: result.error,
          stepsCompleted: result.stepsExecuted,
          stepResults: run.stepResults,
          outputFiles: extractOutputFiles(result.variables || {}),
        } as Partial<RunRecord>);
      }).catch(async (err: Error) => {
        run.done = true;
        run.success = false;
        run.error = String(err);
        debugLog.error('dashboard-run', `Workflow "${wf.name}" crashed`, { error: String(err) });

        // Clean up run snapshots on crash (browser workflows only)
        if (snapshotCapture) {
          await snapshotCapture.deleteRunSnapshots();
        }
        run.trainingDataKept = false;
        ctx.activeSnapshotCapture = null;

        await updateRunRecord(runId, {
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - run.startedAt,
          status: 'failed',
          error: String(err),
          stepsCompleted: run.stepsCompleted,
          stepResults: run.stepResults,
        } as Partial<RunRecord>);
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/workflows/run/status — poll workflow execution progress
  if (req.method === 'GET' && pathname === '/api/workflows/run/status') {
    if (!ctx.activeRun) {
      sendJson(res, 200, { active: false });
      return true;
    }
    sendJson(res, 200, {
      active: !ctx.activeRun.done,
      done: ctx.activeRun.done,
      runId: ctx.activeRun.runId,
      success: ctx.activeRun.success,
      workflowId: ctx.activeRun.workflowId,
      workflowName: ctx.activeRun.workflowName,
      stepsTotal: ctx.activeRun.stepsTotal,
      stepsCompleted: ctx.activeRun.stepsCompleted,
      currentStep: ctx.activeRun.currentStep,
      stepResults: ctx.activeRun.stepResults,
      error: ctx.activeRun.error,
      durationMs: ctx.activeRun.done ? ctx.activeRun.durationMs : Date.now() - ctx.activeRun.startedAt,
      outputVariables: ctx.activeRun.outputVariables,
      trainingDataKept: ctx.activeRun.trainingDataKept,
    });
    return true;
  }

  // POST /api/workflows/run/cancel — abort a running workflow
  if (req.method === 'POST' && pathname === '/api/workflows/run/cancel') {
    if (!ctx.activeRun || ctx.activeRun.done) {
      sendJson(res, 400, { error: 'No workflow is currently running' });
      return true;
    }
    ctx.activeRun.abort.abort();
    ctx.activeRun.done = true;
    ctx.activeRun.success = false;
    ctx.activeRun.error = 'Cancelled by user';
    ctx.activeRun.durationMs = Date.now() - ctx.activeRun.startedAt;

    // Clean up run snapshots on cancel
    if (ctx.activeSnapshotCapture) {
      ctx.activeSnapshotCapture.deleteRunSnapshots().catch(() => {});
      ctx.activeSnapshotCapture = null;
    }
    ctx.activeRun.trainingDataKept = false;

    if (ctx.activeRun.runId) {
      updateRunRecord(ctx.activeRun.runId, {
        completedAt: new Date().toISOString(),
        durationMs: ctx.activeRun.durationMs,
        status: 'cancelled',
        error: 'Cancelled by user',
        stepsCompleted: ctx.activeRun.stepsCompleted,
        stepResults: ctx.activeRun.stepResults,
      } as Partial<RunRecord>).catch(() => {});
    }

    sendJson(res, 200, { success: true, message: 'Workflow cancelled' });
    return true;
  }

  // ── Workflow Debug Mode ──────────────────────────────────

  // POST /api/workflows/:id/debug/start — enter debug mode with overlay
  const debugStartMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/start$/);
  if (req.method === 'POST' && debugStartMatch) {
    const id = decodeURIComponent(debugStartMatch[1]);
    try {
      const body = await readBody(req);
      const variables: Record<string, unknown> = body?.variables || {};

      const discovered = await discoverWorkflows(ctx.workDir);
      const found = discovered.find(d => d.workflow.id === id);
      if (!found) {
        sendJson(res, 404, { error: `Workflow "${id}" not found` });
        return true;
      }

      await ensureBridgeServer();
      if (!bridgeServer.isConnected) {
        sendJson(res, 503, { error: 'Chrome extension is not connected.' });
        return true;
      }

      const wf = found.workflow;

      // Merge variable defaults
      const mergedVars: Record<string, unknown> = { ...variables };
      for (const v of (wf.variables || [])) {
        if (mergedVars[v.name] === undefined && v.default !== undefined) {
          mergedVars[v.name] = v.default;
        }
      }

      // Flatten nested steps for debug mode — each sub-step is individually steppable
      const flatSteps = flattenSteps(wf.steps);

      // Build step overlay data from flattened list
      const overlaySteps = flatSteps.map((step: any, i: number) => {
        const eb = step.target?.expectedBounds;
        return {
          index: i,
          id: step.id,
          type: step.type,
          label: step._debugLabel || step.label || step.id || `Step ${i + 1}`,
          isControlFlow: step._isControlFlow || false,
          hasPosition: !!(eb && typeof eb.pctX === 'number' && typeof eb.pctY === 'number'),
          pctX: eb?.pctX ?? null,
          pctY: eb?.pctY ?? null,
          pctW: eb?.pctW ?? null,
          pctH: eb?.pctH ?? null,
          waitMs: step.type === 'wait' && step.condition?.type === 'delay' ? step.condition.ms : null,
          verifyClick: step.type === 'click' ? (step.verifyClick ?? null) : null,
          clickType: step.type === 'click' ? (step.clickType || 'single') : null,
          // capture_download fields
          filenamePattern: step.type === 'capture_download' ? (step.filenamePattern ?? null) : null,
          maxFiles: step.type === 'capture_download' ? (step.maxFiles ?? 1) : null,
          waitTimeoutMs: step.type === 'capture_download' ? (step.waitTimeoutMs ?? 60000) : null,
          outputVariable: step.type === 'capture_download' ? (step.outputVariable ?? 'downloadedFiles') : null,
          // move_file fields
          source: step.type === 'move_file' ? (step.source ?? null) : null,
          destination: step.type === 'move_file' ? (step.destination ?? null) : null,
          // reference image info (for capture element UI)
          hasReferenceImage: !!(step.target?.referenceImage && existsSync(step.target.referenceImage)),
        };
      });

      // Send overlay to Chrome extension
      try {
        const dbgPort = (ctx.server.address() as any)?.port || 9001;
        await bridgeServer.send('show_debug_overlay', {
          steps: overlaySteps,
          workflowName: wf.name,
          workflowId: id,
          apiBaseUrl: `http://127.0.0.1:${dbgPort}`,
        });
      } catch (overlayErr) {
        debugLog.warn('debug-mode', 'Failed to show overlay', { error: String(overlayErr) });
      }

      // Init debug session with flattened steps
      ctx.debugSession = {
        workflowId: id,
        workflowName: wf.name,
        workflow: wf,
        flatSteps,
        variables: mergedVars,
        currentIndex: 0,
        completedIndices: [],
        failedIndices: [],
        stepResults: [],
      };

      sendJson(res, 200, { success: true, workflowName: wf.name, steps: overlaySteps });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/workflows/:id/debug/step — execute next step
  const debugStepMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/step$/);
  if (req.method === 'POST' && debugStepMatch) {
    const id = decodeURIComponent(debugStepMatch[1]);
    try {
      if (!ctx.debugSession || ctx.debugSession.workflowId !== id) {
        sendJson(res, 400, { error: 'No debug session active for this workflow' });
        return true;
      }
      if (ctx.debugSession.currentIndex >= ctx.debugSession.flatSteps.length) {
        sendJson(res, 400, { error: 'All steps completed' });
        return true;
      }

      await ensureBridgeServer();
      if (!bridgeServer.isConnected) {
        sendJson(res, 503, { error: 'Chrome extension is not connected.' });
        return true;
      }

      // Load executeSingleStep from workflow-runner
      let executeSingleStep: Function;
      try {
        const wfRunnerPath = join(homedir(), '.woodbury', 'extensions', 'social-scheduler', 'lib', 'workflow-runner.js');
        const wfRunner = require(wfRunnerPath);
        executeSingleStep = wfRunner.executeSingleStep;
        if (!executeSingleStep) {
          throw new Error('executeSingleStep not found in module');
        }
      } catch (importErr: any) {
        sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message}` });
        return true;
      }

      const stepIdx = ctx.debugSession.currentIndex;
      const step = ctx.debugSession.flatSteps[stepIdx];

      // Skip control-flow marker steps (conditional/loop/try_catch wrappers)
      if (step._isControlFlow) {
        ctx.debugSession.completedIndices.push(stepIdx);
        ctx.debugSession.stepResults.push({
          index: stepIdx,
          label: step._debugLabel || step.label || step.id,
          type: step.type,
          status: 'skipped',
        });
        ctx.debugSession.currentIndex = stepIdx + 1;
        const hasMore = ctx.debugSession.currentIndex < ctx.debugSession.flatSteps.length;
        sendJson(res, 200, {
          success: true,
          stepIndex: stepIdx,
          stepResult: {
            label: step._debugLabel || step.label || step.id,
            type: step.type,
            status: 'skipped',
          },
          hasMore,
          nextIndex: hasMore ? ctx.debugSession.currentIndex : null,
        });
        return true;
      }

      // Visual pre-verification for click/type steps
      let visualVerification: any = null;
      if ((step.type === 'click' || step.type === 'type') &&
          step.target?.referenceImage && step.target?.expectedBounds &&
          existsSync(step.target.referenceImage)) {
        try {
          const verifier = new VisualVerifier(
            `http://127.0.0.1:${INFERENCE_PORT}`,
            ctx.debugSession.workflow?.metadata?.modelPath || undefined,
          );
          if (await verifier.isAvailable()) {
            const pi = await bridgeServer.send('get_page_info', {}) as any;
            const vpW = pi?.viewport?.width || step.target.expectedBounds.viewportW || 1920;
            const vpH = pi?.viewport?.height || step.target.expectedBounds.viewportH || 1080;
            const eb = step.target.expectedBounds;
            const pos = {
              left: Math.round(((eb.pctX ?? 0) / 100) * vpW - ((eb.pctW || 2) / 200) * vpW),
              top: Math.round(((eb.pctY ?? 0) / 100) * vpH - ((eb.pctH || 2) / 200) * vpH),
              width: Math.round(((eb.pctW || 2) / 100) * vpW),
              height: Math.round(((eb.pctH || 2) / 100) * vpH),
            };
            const vr = await verifier.verifyElement(bridgeServer as any, pos, step.target.referenceImage);
            visualVerification = { ran: true, verified: vr?.verified ?? null, similarity: vr?.similarity ?? null };
            if (vr && !vr.verified) {
              const expPct = (eb.pctX != null) ? { x: eb.pctX, y: eb.pctY! } : undefined;
              const sr = await verifier.searchNearby(bridgeServer as any, pos, step.target.referenceImage, undefined, vr.screenshotDataUrl, expPct);
              if (sr) {
                visualVerification.searchResult = { found: sr.found, similarity: sr.similarity, position: sr.position, candidatesChecked: sr.candidatesChecked };
              }
            }
          }
        } catch (vErr) {
          debugLog.warn('debug-mode', `Visual pre-verify failed: ${vErr}`);
          visualVerification = { ran: false, error: String(vErr) };
        }
      }

      // Execute single step
      const result = await executeSingleStep(bridgeServer, step, ctx.debugSession.variables, {
        log: (msg: string) => debugLog.info('debug-step', msg),
      });

      // Update session state
      if (result.success) {
        ctx.debugSession.completedIndices.push(stepIdx);
      } else {
        ctx.debugSession.failedIndices.push(stepIdx);
      }
      ctx.debugSession.stepResults.push({
        index: stepIdx,
        label: step.label || step.id,
        type: step.type,
        status: result.success ? 'success' : 'failed',
        error: result.error,
        coordinateInfo: result.coordinateInfo,
      });
      ctx.debugSession.currentIndex = stepIdx + 1;

      // Update overlay in Chrome extension
      try {
        await bridgeServer.send('update_debug_step', {
          currentIndex: ctx.debugSession.currentIndex,
          completedIndices: ctx.debugSession.completedIndices,
          failedIndices: ctx.debugSession.failedIndices,
          coordinateInfo: result.coordinateInfo,
          stepIndex: stepIdx,
          stepResult: {
            status: result.success ? 'success' : 'failed',
            error: result.error,
          },
          stepDetail: result.stepDetail || null,
        });
      } catch {}

      const hasMore = ctx.debugSession.currentIndex < ctx.debugSession.flatSteps.length;
      sendJson(res, 200, {
        success: true,
        stepIndex: stepIdx,
        stepResult: {
          label: step.label || step.id,
          type: step.type,
          status: result.success ? 'success' : 'failed',
          error: result.error,
        },
        coordinateInfo: result.coordinateInfo,
        stepDetail: result.stepDetail || null,
        visualVerification,
        hasMore,
        nextIndex: hasMore ? ctx.debugSession.currentIndex : null,
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/workflows/:id/debug/exit — exit debug mode
  const debugExitMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/exit$/);
  if (req.method === 'POST' && debugExitMatch) {
    try {
      await ensureBridgeServer();
      try { await bridgeServer.send('hide_debug_overlay', {}); } catch {}
      ctx.debugSession = null;
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/workflows/:id/debug/update-step — update step properties (position or wait time)
  const debugUpdateStepMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/update-step$/);
  if (req.method === 'POST' && debugUpdateStepMatch) {
    const id = decodeURIComponent(debugUpdateStepMatch[1]);
    try {
      const body = await readBody(req);
      const stepIndex = body?.stepIndex;
      const pctX = body?.pctX;
      const pctY = body?.pctY;
      const waitMs = body?.waitMs;
      const verifyClick = body?.verifyClick;
      const clickType = body?.clickType;
      // capture_download fields
      const captureFields = {
        filenamePattern: body?.filenamePattern,
        maxFiles: body?.maxFiles,
        waitTimeoutMs: body?.waitTimeoutMs,
        outputVariable: body?.outputVariable,
      };
      // move_file fields
      const moveSource = body?.source;
      const moveDestination = body?.destination;

      // Validate stepIndex
      if (stepIndex == null || typeof stepIndex !== 'number' || stepIndex < 0) {
        sendJson(res, 400, { error: 'Invalid stepIndex' });
        return true;
      }

      // Must provide at least one update field
      const hasPosition = pctX != null && pctY != null;
      const hasWait = waitMs != null;
      const hasVerifyClick = verifyClick !== undefined;
      const hasClickType = clickType !== undefined;
      const hasCaptureFields = captureFields.filenamePattern !== undefined ||
        captureFields.maxFiles !== undefined || captureFields.waitTimeoutMs !== undefined ||
        captureFields.outputVariable !== undefined;
      const hasMoveFields = moveSource !== undefined || moveDestination !== undefined;
      if (!hasPosition && !hasWait && !hasVerifyClick && !hasClickType && !hasCaptureFields && !hasMoveFields) {
        sendJson(res, 400, { error: 'Must provide at least one update field' });
        return true;
      }

      // Validate position if provided
      if (hasPosition) {
        if (typeof pctX !== 'number' || pctX < 0 || pctX > 100) {
          sendJson(res, 400, { error: 'pctX must be a number between 0 and 100' });
          return true;
        }
        if (typeof pctY !== 'number' || pctY < 0 || pctY > 100) {
          sendJson(res, 400, { error: 'pctY must be a number between 0 and 100' });
          return true;
        }
      }

      // Validate waitMs if provided
      if (hasWait) {
        if (typeof waitMs !== 'number' || waitMs < 0) {
          sendJson(res, 400, { error: 'waitMs must be a non-negative number' });
          return true;
        }
      }

      // Validate verifyClick if provided
      if (hasVerifyClick && verifyClick !== null) {
        if (typeof verifyClick !== 'object') {
          sendJson(res, 400, { error: 'verifyClick must be an object or null' });
          return true;
        }
        if (typeof verifyClick.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'verifyClick.enabled must be a boolean' });
          return true;
        }
      }

      // Validate clickType if provided
      if (hasClickType) {
        const validClickTypes = ['single', 'double', 'right', 'hover'];
        if (!validClickTypes.includes(clickType)) {
          sendJson(res, 400, { error: `clickType must be one of: ${validClickTypes.join(', ')}` });
          return true;
        }
      }

      // Check active debug session
      if (!ctx.debugSession || ctx.debugSession.workflowId !== id) {
        sendJson(res, 400, { error: 'No debug session active for this workflow' });
        return true;
      }

      const step = ctx.debugSession.workflow.steps[stepIndex];
      if (!step) {
        sendJson(res, 400, { error: `Step ${stepIndex} not found` });
        return true;
      }

      // Update in-memory debug session
      if (hasPosition) {
        if (!step.target) step.target = {};
        if (!step.target.expectedBounds) step.target.expectedBounds = {};
        step.target.expectedBounds.pctX = pctX;
        step.target.expectedBounds.pctY = pctY;
        debugLog.info('debug-mode', `Updated step ${stepIndex} position: pctX=${pctX}, pctY=${pctY}`);
      }
      if (hasWait && step.condition) {
        step.condition.ms = waitMs;
        // Also update the label to reflect new duration
        const secs = (waitMs / 1000).toFixed(1);
        step.label = `Wait ${secs}s`;
        debugLog.info('debug-mode', `Updated step ${stepIndex} wait time: ${waitMs}ms`);
      }
      if (hasVerifyClick) {
        if (verifyClick === null) {
          delete (step as any).verifyClick;
        } else {
          (step as any).verifyClick = {
            enabled: verifyClick.enabled,
            ...(verifyClick.maxAttempts != null && { maxAttempts: verifyClick.maxAttempts }),
            ...(verifyClick.verifyDelayMs != null && { verifyDelayMs: verifyClick.verifyDelayMs }),
            ...(verifyClick.retryDelayMs != null && { retryDelayMs: verifyClick.retryDelayMs }),
          };
        }
        debugLog.info('debug-mode', `Updated step ${stepIndex} verifyClick: ${JSON.stringify(verifyClick)}`);
      }
      if (hasClickType) {
        if (clickType === 'single') {
          delete (step as any).clickType; // 'single' is the default
        } else {
          (step as any).clickType = clickType;
        }
        debugLog.info('debug-mode', `Updated step ${stepIndex} clickType: ${clickType}`);
      }
      if (hasCaptureFields && step.type === 'capture_download') {
        if (captureFields.filenamePattern !== undefined) (step as any).filenamePattern = captureFields.filenamePattern || undefined;
        if (captureFields.maxFiles !== undefined) (step as any).maxFiles = captureFields.maxFiles;
        if (captureFields.waitTimeoutMs !== undefined) (step as any).waitTimeoutMs = captureFields.waitTimeoutMs;
        if (captureFields.outputVariable !== undefined) (step as any).outputVariable = captureFields.outputVariable;
        debugLog.info('debug-mode', `Updated step ${stepIndex} capture_download fields`);
      }
      if (hasMoveFields && step.type === 'move_file') {
        if (moveSource !== undefined) (step as any).source = moveSource;
        if (moveDestination !== undefined) (step as any).destination = moveDestination;
        debugLog.info('debug-mode', `Updated step ${stepIndex} move_file fields`);
      }

      // Persist to disk
      try {
        const discovered = await discoverWorkflows(ctx.workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (found) {
          const wf = found.workflow;
          const diskStep = wf.steps[stepIndex] as any;
          if (diskStep) {
            if (hasPosition) {
              if (!diskStep.target) diskStep.target = {};
              if (!diskStep.target.expectedBounds) diskStep.target.expectedBounds = {};
              diskStep.target.expectedBounds.pctX = pctX;
              diskStep.target.expectedBounds.pctY = pctY;
            }
            if (hasWait && diskStep.condition) {
              diskStep.condition.ms = waitMs;
              const secs = (waitMs / 1000).toFixed(1);
              diskStep.label = `Wait ${secs}s`;
            }
            if (hasVerifyClick) {
              if (verifyClick === null) {
                delete diskStep.verifyClick;
              } else {
                diskStep.verifyClick = {
                  enabled: verifyClick.enabled,
                  ...(verifyClick.maxAttempts != null && { maxAttempts: verifyClick.maxAttempts }),
                  ...(verifyClick.verifyDelayMs != null && { verifyDelayMs: verifyClick.verifyDelayMs }),
                  ...(verifyClick.retryDelayMs != null && { retryDelayMs: verifyClick.retryDelayMs }),
                };
              }
            }
            if (hasClickType) {
              if (clickType === 'single') {
                delete diskStep.clickType;
              } else {
                diskStep.clickType = clickType;
              }
            }
            if (hasCaptureFields && diskStep.type === 'capture_download') {
              if (captureFields.filenamePattern !== undefined) diskStep.filenamePattern = captureFields.filenamePattern || undefined;
              if (captureFields.maxFiles !== undefined) diskStep.maxFiles = captureFields.maxFiles;
              if (captureFields.waitTimeoutMs !== undefined) diskStep.waitTimeoutMs = captureFields.waitTimeoutMs;
              if (captureFields.outputVariable !== undefined) diskStep.outputVariable = captureFields.outputVariable;
            }
            if (hasMoveFields && diskStep.type === 'move_file') {
              if (moveSource !== undefined) diskStep.source = moveSource;
              if (moveDestination !== undefined) diskStep.destination = moveDestination;
            }
            if (wf.metadata) wf.metadata.updatedAt = new Date().toISOString();
            await atomicWriteFile(found.path, JSON.stringify(wf, null, 2));
            debugLog.info('debug-mode', `Saved step ${stepIndex} update to disk: ${found.path}`);
          }
        }
      } catch (diskErr) {
        debugLog.warn('debug-mode', `Failed to save step update to disk: ${diskErr}`);
      }

      // Send marker update to Chrome extension (only for position changes)
      if (hasPosition) {
        try {
          await ensureBridgeServer();
          if (bridgeServer.isConnected) {
            await bridgeServer.send('update_debug_marker', { stepIndex, pctX, pctY });
          }
        } catch {}
      }

      sendJson(res, 200, {
        success: true, stepIndex, pctX, pctY, waitMs,
        verifyClick: (step as any).verifyClick ?? null,
        clickType: (step as any).clickType || 'single',
        filenamePattern: (step as any).filenamePattern,
        maxFiles: (step as any).maxFiles,
        waitTimeoutMs: (step as any).waitTimeoutMs,
        outputVariable: (step as any).outputVariable,
        source: (step as any).source,
        destination: (step as any).destination,
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/workflows/:id/debug/capture-element — identify & capture reference image at adjusted position
  const captureElementMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/capture-element$/);
  if (req.method === 'POST' && captureElementMatch) {
    const id = decodeURIComponent(captureElementMatch[1]);
    try {
      const body = await readBody(req);
      const { stepIndex, pctX, pctY } = body;

      // Validate inputs
      if (stepIndex == null || typeof stepIndex !== 'number' || stepIndex < 0) {
        sendJson(res, 400, { error: 'Invalid stepIndex' });
        return true;
      }
      if (typeof pctX !== 'number' || pctX < 0 || pctX > 100 ||
          typeof pctY !== 'number' || pctY < 0 || pctY > 100) {
        sendJson(res, 400, { error: 'pctX and pctY must be numbers 0-100' });
        return true;
      }

      // Validate debug session
      if (!ctx.debugSession || ctx.debugSession.workflowId !== id) {
        sendJson(res, 400, { error: 'No debug session active for this workflow' });
        return true;
      }
      const flatStep = ctx.debugSession.flatSteps[stepIndex] as any;
      if (!flatStep) {
        sendJson(res, 400, { error: `Step ${stepIndex} not found in flat steps` });
        return true;
      }
      if (flatStep.type !== 'click' && flatStep.type !== 'type') {
        sendJson(res, 400, { error: 'Capture element only supported for click/type steps' });
        return true;
      }

      // Find actual step in nested workflow by ID
      const step = findStepById(ctx.debugSession.workflow.steps, flatStep.id) || flatStep;

      // Ensure bridge is connected
      await ensureBridgeServer();
      if (!bridgeServer.isConnected) {
        sendJson(res, 503, { error: 'Chrome extension is not connected.' });
        return true;
      }

      // Get viewport dimensions
      const pageInfo = await bridgeServer.send('get_page_info', {}) as any;
      const vpW = pageInfo?.viewport?.width || pageInfo?.innerWidth || 1920;
      const vpH = pageInfo?.viewport?.height || pageInfo?.innerHeight || 1080;

      // Convert pctX/pctY to pixel coordinates
      const pixelX = (pctX / 100) * vpW;
      const pixelY = (pctY / 100) * vpH;

      // Hit-test: find the element at the target point
      // matchedBounds = DPR-scaled pixel coords for screenshot cropping (captureVisibleTab returns DPR-scaled image)
      // cssBounds = CSS pixel coords for expectedBounds storage
      let matchedElement: any = null;
      let matchedBounds: { left: number; top: number; width: number; height: number } | null = null;
      let cssBounds: { left: number; top: number; width: number; height: number } | null = null;
      let containingElements: any[] = [];
      const dpr: number = body.dpr || 1;

      // If caller provided exact element bounds (from page pick, already DPR-scaled for crop)
      const providedBounds = body.elementBounds;
      if (providedBounds && providedBounds.width > 0 && providedBounds.height > 0) {
        matchedBounds = {
          left: Math.round(providedBounds.left),
          top: Math.round(providedBounds.top),
          width: Math.round(providedBounds.width),
          height: Math.round(providedBounds.height),
        };
        // CSS bounds = DPR-scaled bounds / dpr
        cssBounds = {
          left: Math.round(providedBounds.left / dpr),
          top: Math.round(providedBounds.top / dpr),
          width: Math.round(providedBounds.width / dpr),
          height: Math.round(providedBounds.height / dpr),
        };
      } else {
        // Get all clickable elements and hit-test
        const elementsResult = await bridgeServer.send('get_clickable_elements', {}) as any;
        const elements: any[] = Array.isArray(elementsResult) ? elementsResult :
                                Array.isArray(elementsResult?.elements) ? elementsResult.elements : [];

        containingElements = elements.filter((el: any) => {
          const b = el.position || el.bounds;
          if (!b || !b.width || !b.height) return false;
          return pixelX >= b.left && pixelX <= b.left + b.width &&
                 pixelY >= b.top && pixelY <= b.top + b.height;
        });

        if (containingElements.length > 0) {
          // Pick the smallest containing element (most specific)
          containingElements.sort((a: any, b: any) => {
            const aB = a.position || a.bounds;
            const bB = b.position || b.bounds;
            return (aB.width * aB.height) - (bB.width * bB.height);
          });
          matchedElement = containingElements[0];
          const b = matchedElement.position || matchedElement.bounds;
          matchedBounds = { left: b.left, top: b.top, width: b.width, height: b.height };
        } else {
          // Fallback: find closest element by center-to-point distance
          let minDist = Infinity;
          for (const el of elements) {
            const b = el.position || el.bounds;
            if (!b || !b.width || !b.height) continue;
            const cx = b.left + b.width / 2;
            const cy = b.top + b.height / 2;
            const dist = Math.sqrt((cx - pixelX) ** 2 + (cy - pixelY) ** 2);
            if (dist < minDist) {
              minDist = dist;
              matchedElement = el;
              matchedBounds = { left: b.left, top: b.top, width: b.width, height: b.height };
            }
          }
        }
      }

      // Final fallback: 60x60px default crop centered on the point
      const DEFAULT_CROP_SIZE = 60;
      if (!matchedBounds) {
        matchedBounds = {
          left: Math.max(0, Math.round(pixelX - DEFAULT_CROP_SIZE / 2)),
          top: Math.max(0, Math.round(pixelY - DEFAULT_CROP_SIZE / 2)),
          width: DEFAULT_CROP_SIZE,
          height: DEFAULT_CROP_SIZE,
        };
      }

      // Add padding around the element crop (in the same coordinate space as matchedBounds)
      const paddingPx: number = body.padding != null ? Number(body.padding) : 8;
      const padScale = providedBounds ? dpr : 1; // scale padding to match bounds coordinate space
      const pad = Math.round(paddingPx * padScale);
      if (pad > 0) {
        matchedBounds.left -= pad;
        matchedBounds.top -= pad;
        matchedBounds.width += pad * 2;
        matchedBounds.height += pad * 2;
      }

      // Clamp bounds to viewport and enforce minimum size
      // When DPR-scaled (from picker), clamp against DPR-scaled viewport
      const clampW = providedBounds ? vpW * dpr : vpW;
      const clampH = providedBounds ? vpH * dpr : vpH;
      matchedBounds.left = Math.max(0, Math.round(matchedBounds.left));
      matchedBounds.top = Math.max(0, Math.round(matchedBounds.top));
      matchedBounds.width = Math.min(Math.round(matchedBounds.width), clampW - matchedBounds.left);
      matchedBounds.height = Math.min(Math.round(matchedBounds.height), clampH - matchedBounds.top);
      if (matchedBounds.width < 4) matchedBounds.width = 4;
      if (matchedBounds.height < 4) matchedBounds.height = 4;

      // Capture cropped screenshot — hide debug overlay markers so they don't appear in the reference image
      // Use returnFull to get both crop + full screenshot in a single captureVisibleTab call
      // (avoids Chrome's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota)
      let cropImage: string | null = null;
      let fullScreenImage: string | null = null;

      const screenshotDataUrl: string | undefined = body.screenshotDataUrl;

      if (screenshotDataUrl) {
        // Pre-captured screenshot (from pick with sidepanel closed — correct element positions)
        fullScreenImage = screenshotDataUrl;
        const ssB64 = screenshotDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const ssBuf = Buffer.from(ssB64, 'base64');

        try {
          const ssMeta = await sharp(ssBuf).metadata();
          const ssW = ssMeta.width || vpW;
          const ssH = ssMeta.height || vpH;

          // matchedBounds are DPR-scaled when providedBounds, CSS pixels otherwise
          // Screenshot from captureVisibleTab is always DPR-scaled
          const cropLeft = Math.max(0, Math.round(matchedBounds.left));
          const cropTop = Math.max(0, Math.round(matchedBounds.top));
          const cropW = Math.min(ssW - cropLeft, Math.round(matchedBounds.width));
          const cropH = Math.min(ssH - cropTop, Math.round(matchedBounds.height));

          if (cropW > 1 && cropH > 1) {
            const cropBuf = await sharp(ssBuf)
              .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
              .png()
              .toBuffer();
            cropImage = `data:image/png;base64,${cropBuf.toString('base64')}`;
          } else {
            cropImage = fullScreenImage;
          }
        } catch (sharpErr) {
          debugLog.warn('debug-mode', `Failed to crop from pre-captured screenshot: ${sharpErr}`);
          cropImage = fullScreenImage;
        }
      } else {
        const cropResult = await bridgeServer.send('capture_viewport', {
          crop: { ...matchedBounds, dprScaled: !!providedBounds },
          hideOverlay: true,
          returnFull: true,
        }) as any;
        cropImage = cropResult?.data?.image || cropResult?.image || null;
        fullScreenImage = cropResult?.data?.fullImage || cropResult?.fullImage || null;
      }

      if (!cropImage) {
        sendJson(res, 500, { error: 'Failed to capture element crop' });
        return true;
      }

      // Save crop to disk: ~/.woodbury/data/workflows/{name}/refs/{stepId}.png
      const workflowName = ctx.debugSession.workflowName;
      const stepId = step.id || flatStep.id;
      const refsDir = join(homedir(), '.woodbury', 'data', 'workflows', workflowName, 'refs');
      mkdirSync(refsDir, { recursive: true });
      const cropPath = join(refsDir, `${stepId}.png`);

      const base64Data = cropImage.replace(/^data:image\/[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await writeFile(cropPath, buffer);

      // Save full screenshot alongside the crop
      let screenshotPath: string | null = null;
      if (fullScreenImage) {
        screenshotPath = join(refsDir, `${stepId}_screenshot.png`);
        const ssBase64 = fullScreenImage.replace(/^data:image\/[^;]+;base64,/, '');
        await writeFile(screenshotPath, Buffer.from(ssBase64, 'base64'));
      }

      // Save all clickable elements at this moment so Element Finder can search
      // against the saved screenshot context (even if the live page has changed)
      let savedElementsPath: string | null = null;
      try {
        const allElementsResult = await bridgeServer.send('get_clickable_elements', {}) as any;
        const allElements: any[] = Array.isArray(allElementsResult) ? allElementsResult :
                                    Array.isArray(allElementsResult?.elements) ? allElementsResult.elements : [];
        if (allElements.length > 0) {
          savedElementsPath = join(refsDir, `${stepId}_elements.json`);
          await writeFile(savedElementsPath, JSON.stringify({
            viewport: { width: vpW, height: vpH },
            elements: allElements.map((el: any) => ({
              position: el.position || el.bounds,
              tag: el.tag || el.tagName,
              text: (el.text || el.textContent || '').slice(0, 100),
              selector: el.selector,
              role: el.role,
            })),
          }, null, 2));
        }
      } catch (elErr) {
        debugLog.warn('debug-mode', `Failed to save clickable elements: ${elErr}`);
      }

      // Build expectedBounds using CSS pixel values (not DPR-scaled)
      const ebBounds = cssBounds || matchedBounds;
      const expectedBounds = {
        left: ebBounds.left,
        top: ebBounds.top,
        width: ebBounds.width,
        height: ebBounds.height,
        tolerance: 80,
        pctX,
        pctY,
        pctW: (ebBounds.width / vpW) * 100,
        pctH: (ebBounds.height / vpH) * 100,
        viewportW: vpW,
        viewportH: vpH,
      };

      // Update step in-memory
      if (!step.target) step.target = {};
      step.target.referenceImage = cropPath;
      step.target.expectedBounds = expectedBounds;
      if (screenshotPath) step.target.screenshotPath = screenshotPath;
      if (savedElementsPath) step.target.savedElementsPath = savedElementsPath;
      // Persist picked element bounds so re-capture uses the same element
      if (providedBounds) {
        step.target.pickedBounds = { left: providedBounds.left, top: providedBounds.top, width: providedBounds.width, height: providedBounds.height };
        step.target.pickedDpr = dpr;
      }

      // Persist to disk (same pattern as debug/update-step)
      try {
        const discovered = await discoverWorkflows(ctx.workDir);
        const found = discovered.find((d: any) => d.workflow.id === id);
        if (found) {
          const wf = found.workflow;
          const diskStep = findStepById(wf.steps, stepId);
          if (diskStep) {
            if (!diskStep.target) diskStep.target = {};
            diskStep.target.referenceImage = cropPath;
            diskStep.target.expectedBounds = expectedBounds;
            if (screenshotPath) diskStep.target.screenshotPath = screenshotPath;
            if (savedElementsPath) diskStep.target.savedElementsPath = savedElementsPath;
            if (providedBounds) {
              diskStep.target.pickedBounds = { left: providedBounds.left, top: providedBounds.top, width: providedBounds.width, height: providedBounds.height };
              diskStep.target.pickedDpr = dpr;
            }
            if (wf.metadata) wf.metadata.updatedAt = new Date().toISOString();
            await atomicWriteFile(found.path, JSON.stringify(wf, null, 2));
            debugLog.info('debug-mode', `Saved capture-element for step ${stepId}: ${cropPath}`);
          }
        }
      } catch (diskErr) {
        debugLog.warn('debug-mode', `Failed to persist capture-element to disk: ${diskErr}`);
      }

      // Build element info for display
      const elementInfo = matchedElement ? {
        tag: matchedElement.tag || matchedElement.tagName || matchedElement.role || 'unknown',
        text: (matchedElement.text || matchedElement.textContent || '').slice(0, 100),
        role: matchedElement.role || null,
        selector: matchedElement.selector || null,
      } : null;

      // ── Save as training data snapshot ──
      // Create a snapshot entry in the training-crops/snapshots directory so
      // prepare.py automatically picks it up for model training.
      try {
        const pageUrl: string = pageInfo?.url || pageInfo?.pageUrl || '';
        let siteId = 'unknown';
        try { siteId = new URL(pageUrl).hostname || 'unknown'; } catch {}

        const ts = Date.now();
        const snapshotDir = join(homedir(), '.woodbury', 'data', 'training-crops', 'snapshots', siteId);
        mkdirSync(snapshotDir, { recursive: true });

        // Build the element entry using CSS pixel bounds (not DPR-scaled)
        const elBounds = cssBounds || {
          left: Math.round((pctX / 100) * vpW),
          top: Math.round((pctY / 100) * vpH),
          width: 60, height: 60,
        };
        const elSelector = matchedElement?.selector || elementInfo?.selector || `step_${stepId}`;
        const elTag = matchedElement?.tag || matchedElement?.tagName || elementInfo?.tag || 'unknown';
        const elText = (matchedElement?.text || matchedElement?.textContent || elementInfo?.text || '').slice(0, 200);
        const elAriaLabel = matchedElement?.ariaLabel || matchedElement?.aria_label || '';
        const elRole = matchedElement?.role || elementInfo?.role || '';

        const snapshotName = `snapshot_capture_${ts}`;

        // Save the full screenshot as the viewport image for this snapshot
        const viewportImgName = `${snapshotName}_viewport.png`;
        if (fullScreenImage) {
          const ssData = fullScreenImage.replace(/^data:image\/[^;]+;base64,/, '');
          await writeFile(join(snapshotDir, viewportImgName), Buffer.from(ssData, 'base64'));
        }

        // Snapshot JSON — single-element snapshot of the captured element
        const snapshotJson = {
          site_id: siteId,
          page_url: pageUrl,
          page_title: pageInfo?.title || '',
          viewport_width: vpW,
          viewport_height: vpH,
          timestamp: ts / 1000,
          viewport_image: viewportImgName,
          source: 'capture-element',
          workflow_id: id,
          workflow_name: workflowName,
          step_id: stepId,
          step_index: stepIndex,
          elements: [{
            selector: elSelector,
            tag: elTag,
            text: elText,
            aria_label: elAriaLabel,
            role: elRole,
            type: flatStep.type || 'click',
            bounds: {
              left: elBounds.left,
              top: elBounds.top,
              width: elBounds.width,
              height: elBounds.height,
            },
          }],
        };
        await writeFile(join(snapshotDir, `${snapshotName}.json`), JSON.stringify(snapshotJson, null, 2));

        // Interactions JSON — mark this element as interacted (with step index for step-based grouping)
        const interactionsJson = {
          site_id: siteId,
          recording_name: workflowName,
          timestamp: ts / 1000,
          total_steps: ctx.debugSession.flatSteps.length,
          source: 'capture-element',
          interacted_selectors: [elSelector],
          interacted_elements: {
            [elSelector]: [{
              action: flatStep.type || 'click',
              stepIndex,
              text: elText,
              tag: elTag,
            }],
          },
        };
        await writeFile(join(snapshotDir, `interactions_${ts}.json`), JSON.stringify(interactionsJson, null, 2));

        debugLog.info('debug-mode', `Saved training snapshot for step ${stepId} in ${snapshotDir}`);
      } catch (trainErr) {
        debugLog.warn('debug-mode', `Failed to save training snapshot: ${trainErr}`);
      }

      sendJson(res, 200, {
        success: true,
        elementCrop: cropImage,
        elementInfo,
        referenceImagePath: cropPath,
        screenshotPath: screenshotPath || null,
        expectedBounds,
        viewport: { width: vpW, height: vpH },
        matchedByFallback: containingElements.length === 0,
        pickedBounds: providedBounds ? { left: providedBounds.left, top: providedBounds.top, width: providedBounds.width, height: providedBounds.height } : null,
        pickedDpr: providedBounds ? dpr : null,
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};
