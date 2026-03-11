/**
 * Dashboard Route: Recording
 * Handles /api/recording/* endpoints for workflow recording (start, stop, pause, resume, cancel, status).
 */
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import { WorkflowRecorder } from '../../workflow/recorder.js';
import { bridgeServer, ensureBridgeServer } from '../../bridge-server.js';
import {
  invalidateWorkflowCache,
} from '../../workflow/loader.js';
import { debugLog } from '../../debug-log.js';

// ────────────────────────────────────────────────────────────────
//  Local helpers
// ────────────────────────────────────────────────────────────────

const _REC_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const _REC_LOG_PATH = join(_REC_LOG_DIR, 'recording.log');

function dashRecLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(_REC_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [DASH:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(_REC_LOG_PATH, line + '\n');
  } catch { /* never break dashboard */ }
}

/**
 * Before overwriting a workflow file, copy the existing version to a .backups/ sibling directory.
 * Keeps the last 10 backups per workflow, timestamped.
 */
async function backupWorkflowFile(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    return;
  }
  try {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const backupDir = join(dir, '.backups');
    await mkdir(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `${name}.${ts}`);
    const content = await readFile(filePath, 'utf-8');
    await writeFile(backupPath, content, 'utf-8');

    const prefix = name + '.';
    const entries = (await readdir(backupDir)).filter(f => f.startsWith(prefix)).sort();
    if (entries.length > 10) {
      const toDelete = entries.slice(0, entries.length - 10);
      for (const old of toDelete) {
        try { await unlink(join(backupDir, old)); } catch { /* best-effort */ }
      }
    }
    debugLog.info('dashboard', `Backed up workflow: ${backupPath}`);
  } catch (err) {
    debugLog.info('dashboard', `Workflow backup failed (non-fatal): ${String(err)}`);
  }
}

// ────────────────────────────────────────────────────────────────
//  Optional callback for post-recording training
// ────────────────────────────────────────────────────────────────

/**
 * External hook for post-recording training. Set this to wire up
 * background model training after a recording is stopped.
 * Signature: (workflowId: string, site: string, filePath: string) => Promise<void>
 */
export let onRecordingStopped: ((workflowId: string, site: string, filePath: string) => Promise<void>) | null = null;

// ────────────────────────────────────────────────────────────────
//  Route handler
// ────────────────────────────────────────────────────────────────

export const handleRecordingRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  const { workDir } = ctx;

  // POST /api/recording/start — start recording a new workflow
  if (req.method === 'POST' && pathname === '/api/recording/start') {
    dashRecLog('INFO', '/api/recording/start called');
    try {
      const body = await readBody(req);
      dashRecLog('INFO', 'Request body', { name: body?.name, site: body?.site });
      if (!body || !body.name || !body.site) {
        dashRecLog('ERROR', 'Missing name or site');
        sendJson(res, 400, { error: 'name and site are required' });
        return true;
      }
      if (ctx.activeRecorder?.isActive) {
        dashRecLog('ERROR', 'Recording already in progress');
        sendJson(res, 409, { error: 'Recording already in progress. Stop or cancel first.' });
        return true;
      }

      ctx.recordingSteps = [];
      ctx.recordingStatus = 'Starting...';

      // Store re-record context if provided
      if (body.reRecord && body.reRecord.workflowId && body.reRecord.filePath) {
        ctx.reRecordInfo = { workflowId: body.reRecord.workflowId, filePath: body.reRecord.filePath };
        dashRecLog('INFO', 'Re-record mode', { workflowId: ctx.reRecordInfo.workflowId, filePath: ctx.reRecordInfo.filePath });
      } else {
        ctx.reRecordInfo = null;
      }

      ctx.activeRecorder = new WorkflowRecorder(
        // onStepCaptured — collect steps for the UI to poll
        (step, index) => {
          ctx.recordingSteps.push({
            index,
            label: step.label || step.id || `Step ${index + 1}`,
            type: step.type,
          });
        },
        // onStatus — track status messages
        (status) => {
          ctx.recordingStatus = status;
        }
      );

      const captureElementCrops = body.captureElementCrops !== false; // default true
      const isDesktopMode = body.site === 'desktop';
      const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
      const recordingMode = body.recordingMode === 'accessibility' ? 'accessibility' as const : 'standard' as const;
      dashRecLog('INFO', `Calling activeRecorder.${isDesktopMode ? 'startDesktopRecording' : 'start'}()`, { captureElementCrops, isDesktopMode, appName, recordingMode });
      if (isDesktopMode) {
        await ctx.activeRecorder.startDesktopRecording(body.name, appName || undefined);
      } else {
        await ctx.activeRecorder.start(body.name, body.site, { captureElementCrops, recordingMode });
      }
      dashRecLog('INFO', 'Recording start completed successfully');
      sendJson(res, 200, { success: true, status: 'recording' });
    } catch (err) {
      dashRecLog('ERROR', 'Recording start failed', { error: String(err), stack: (err as Error)?.stack });
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/recording/stop — stop recording and save the workflow
  if (req.method === 'POST' && pathname === '/api/recording/stop') {
    dashRecLog('INFO', '/api/recording/stop called', { isReRecord: !!ctx.reRecordInfo });
    try {
      if (!ctx.activeRecorder?.isActive) {
        sendJson(res, 400, { error: 'No recording in progress' });
        return true;
      }

      const result = await ctx.activeRecorder.stop(workDir);
      ctx.activeRecorder = null;
      ctx.recordingStatus = '';

      let finalWorkflow = result.workflow;
      let finalFilePath = result.filePath;

      // Re-record mode: merge new steps into the existing workflow
      if (ctx.reRecordInfo) {
        try {
          dashRecLog('INFO', 'Re-record merge: reading existing workflow', { filePath: ctx.reRecordInfo.filePath });
          const existingContent = await readFile(ctx.reRecordInfo.filePath, 'utf-8');
          const existingWorkflow = JSON.parse(existingContent);

          // Replace steps with newly recorded ones
          existingWorkflow.steps = result.workflow.steps;

          // Merge any newly detected variables (add new ones, keep existing)
          if (result.workflow.variables && result.workflow.variables.length > 0) {
            const existingVarNames = new Set((existingWorkflow.variables || []).map((v: any) => v.name));
            const newVars = result.workflow.variables.filter((v: any) => !existingVarNames.has(v.name));
            if (newVars.length > 0) {
              existingWorkflow.variables = [...(existingWorkflow.variables || []), ...newVars];
              dashRecLog('INFO', `Re-record: added ${newVars.length} new variable(s)`, { names: newVars.map((v: any) => v.name) });
            }
          }

          // Update metadata
          if (!existingWorkflow.metadata) existingWorkflow.metadata = {};
          existingWorkflow.metadata.updatedAt = new Date().toISOString();
          existingWorkflow.metadata.reRecordedAt = new Date().toISOString();
          // Update recording mode from the new recording (user may have switched modes)
          if (result.workflow.metadata?.recordingMode) {
            existingWorkflow.metadata.recordingMode = result.workflow.metadata.recordingMode;
          }

          // Save back to original file
          await backupWorkflowFile(ctx.reRecordInfo.filePath);
          await writeFile(ctx.reRecordInfo.filePath, JSON.stringify(existingWorkflow, null, 2));
          dashRecLog('INFO', 'Re-record merge: saved to original file', { filePath: ctx.reRecordInfo.filePath });

          // Clean up the temp file created by recorder (if different from original).
          // Use case-insensitive comparison — macOS has a case-insensitive filesystem,
          // so "Post To Instagram" and "Post to instagram" resolve to the same file.
          if (result.filePath.toLowerCase() !== ctx.reRecordInfo.filePath.toLowerCase()) {
            try { await unlink(result.filePath); } catch { /* ok if doesn't exist */ }
          }

          finalWorkflow = existingWorkflow;
          finalFilePath = ctx.reRecordInfo.filePath;
        } catch (mergeErr) {
          dashRecLog('ERROR', 'Re-record merge failed, using freshly recorded workflow', { error: String(mergeErr) });
          // Fall through — use the newly recorded file as-is
        }
        ctx.reRecordInfo = null;
      }

      // Invalidate cached workflow list so the new workflow appears immediately
      invalidateWorkflowCache();

      sendJson(res, 200, {
        success: true,
        workflow: finalWorkflow,
        filePath: finalFilePath,
        stepCount: ctx.recordingSteps.length,
        newDownloads: result.newDownloads || [],
        trainingStatus: 'pending',
      });
      ctx.recordingSteps = [];

      // Kick off per-workflow model training in background (non-blocking)
      if (onRecordingStopped) {
        const wfId = finalWorkflow.id;
        const wfSite = finalWorkflow.site;
        onRecordingStopped(wfId, wfSite, finalFilePath).catch(err => {
          debugLog.info('workflow-train', `Background training failed for ${wfId}: ${String(err)}`);
        });
      }
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/recording/pause — pause recording
  if (req.method === 'POST' && pathname === '/api/recording/pause') {
    try {
      if (!ctx.activeRecorder?.isActive) {
        sendJson(res, 400, { error: 'No recording in progress' });
        return true;
      }
      ctx.activeRecorder.pause();
      sendJson(res, 200, { success: true, status: 'paused' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/recording/resume — resume recording
  if (req.method === 'POST' && pathname === '/api/recording/resume') {
    try {
      if (!ctx.activeRecorder?.isActive) {
        sendJson(res, 400, { error: 'No recording in progress' });
        return true;
      }
      ctx.activeRecorder.resume();
      sendJson(res, 200, { success: true, status: 'recording' });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/recording/cancel — cancel recording without saving
  if (req.method === 'POST' && pathname === '/api/recording/cancel') {
    try {
      if (ctx.activeRecorder?.isActive) {
        ctx.activeRecorder.cancel();
      }
      ctx.activeRecorder = null;
      ctx.recordingSteps = [];
      ctx.recordingStatus = '';
      ctx.reRecordInfo = null;
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/recording/status — poll recording state and captured steps
  if (req.method === 'GET' && pathname === '/api/recording/status') {
    if (!ctx.activeRecorder) {
      // Only log once per "not active" stretch to avoid spamming
      dashRecLog('DEBUG', '/api/recording/status: no activeRecorder');
      sendJson(res, 200, { active: false, paused: false, stepCount: 0, steps: [], status: '' });
      return true;
    }
    const status = ctx.activeRecorder.getStatus();
    if (!status.active) {
      dashRecLog('WARN', '/api/recording/status: activeRecorder exists but session not active', {
        hasRecorder: true,
        isActive: status.active,
      });
    }
    sendJson(res, 200, {
      ...status,
      steps: ctx.recordingSteps,
      statusMessage: ctx.recordingStatus,
    });
    return true;
  }

  return false;
};
