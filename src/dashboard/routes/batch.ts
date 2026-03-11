/**
 * Dashboard Route: Batch
 *
 * Handles /api/compositions/:id/batch-run, /api/batch/status, and /api/batch/cancel endpoints.
 * Provides batch execution of compositions with variable pools (zip or cartesian product mode).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import type { RunRecord, BatchConfig, VariablePool } from '../../workflow/types.js';
import { debugLog } from '../../debug-log.js';

// ── Constants ────────────────────────────────────────────────
const RUNS_DIR = join(homedir(), '.woodbury', 'data');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 500;
let runsCache: RunRecord[] | null = null;

// ── Local helpers ────────────────────────────────────────────

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

async function updateRunRecord(id: string, updates: Partial<RunRecord>): Promise<void> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.id === id);
  if (idx >= 0) {
    Object.assign(runs[idx], updates);
    await saveRuns(runs);
  }
}

// ── Route handler ────────────────────────────────────────────

export const handleBatchRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // POST /api/compositions/:id/batch-run — run a composition in batch mode
  const batchRunMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/batch-run$/);
  if (req.method === 'POST' && batchRunMatch) {
    const id = decodeURIComponent(batchRunMatch[1]);
    try {
      if (ctx.activeBatchRun && !ctx.activeBatchRun.done) {
        sendJson(res, 409, { error: 'A batch is already running. Wait for it to finish or cancel it.' });
        return true;
      }
      if (ctx.activeCompRun && !ctx.activeCompRun.done) {
        sendJson(res, 409, { error: `Pipeline "${ctx.activeCompRun.compositionName}" is running. Wait for it to finish.` });
        return true;
      }
      if (ctx.activeRun && !ctx.activeRun.done) {
        sendJson(res, 409, { error: `Workflow "${ctx.activeRun.workflowName}" is running. Wait for it to finish.` });
        return true;
      }

      const body = await readBody(req);
      if (!body || !body.batchConfig) {
        sendJson(res, 400, { error: 'batchConfig is required' });
        return true;
      }

      const config: BatchConfig = body.batchConfig;
      if (!config.pools || !Array.isArray(config.pools) || config.pools.length === 0) {
        sendJson(res, 400, { error: 'At least one variable pool is required' });
        return true;
      }

      // Validate pools
      for (const pool of config.pools) {
        if (!pool.variableName || !Array.isArray(pool.values) || pool.values.length === 0) {
          sendJson(res, 400, { error: `Pool for "${pool.variableName}" needs at least one value` });
          return true;
        }
      }

      // Generate iteration variable sets
      const iterations: Record<string, unknown>[] = [];
      const baseVars: Record<string, unknown> = body.variables || {};

      if (config.mode === 'zip') {
        const len = Math.min(...config.pools.map(p => p.values.length));
        for (let i = 0; i < len; i++) {
          const vars: Record<string, unknown> = { ...baseVars };
          for (const pool of config.pools) {
            vars[pool.variableName] = pool.values[i];
          }
          iterations.push(vars);
        }
      } else {
        // Cartesian product
        function cartesian(pools: VariablePool[], idx: number, current: Record<string, unknown>, results: Record<string, unknown>[]) {
          if (idx >= pools.length) {
            results.push({ ...current });
            return;
          }
          for (const val of pools[idx].values) {
            current[pools[idx].variableName] = val;
            cartesian(pools, idx + 1, current, results);
          }
        }
        cartesian(config.pools, 0, { ...baseVars }, iterations);
      }

      if (iterations.length === 0) {
        sendJson(res, 400, { error: 'Batch produces zero iterations' });
        return true;
      }
      if (iterations.length > 100) {
        sendJson(res, 400, { error: `Batch would produce ${iterations.length} iterations (max 100). Reduce the number of values.` });
        return true;
      }

      // Verify the composition exists
      const compDiscovered = await discoverCompositions(ctx.workDir);
      const compFound = compDiscovered.find(d => d.composition.id === id);
      if (!compFound) {
        sendJson(res, 404, { error: `Composition "${id}" not found` });
        return true;
      }

      const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const abort = new AbortController();

      ctx.activeBatchRun = {
        batchId,
        compositionId: id,
        compositionName: compFound.composition.name,
        abort,
        startedAt: Date.now(),
        totalIterations: iterations.length,
        completedIterations: 0,
        failedIterations: 0,
        currentIteration: 0,
        iterationVariables: iterations,
        runIds: [],
        delayBetweenMs: config.delayBetweenMs || 2000,
        done: false,
      };

      sendJson(res, 200, {
        success: true,
        batchId,
        totalIterations: iterations.length,
        compositionName: compFound.composition.name,
      });

      // Execute batch asynchronously
      const batch = ctx.activeBatchRun;
      (async () => {
        try {
          for (let i = 0; i < iterations.length; i++) {
            if (abort.signal.aborted) break;

            batch.currentIteration = i;
            const iterVars = iterations[i];

            debugLog.info('batch', `Batch "${batchId}" iteration ${i + 1}/${iterations.length}`, {
              vars: Object.keys(iterVars),
            });

            // Trigger a composition run via the internal run logic
            // We reuse the existing POST /api/compositions/:id/run endpoint internally
            try {
              const runRes = await fetch(`http://127.0.0.1:${(ctx.server.address() as any)?.port}/api/compositions/${encodeURIComponent(id)}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variables: iterVars }),
              });
              const runData = await runRes.json() as { success?: boolean; runId?: string; error?: string };

              if (runData.runId) {
                batch.runIds.push(runData.runId);

                // Update the run record to include batchId
                await updateRunRecord(runData.runId, { batchId } as any);

                // Wait for the composition run to finish
                while (ctx.activeCompRun && !ctx.activeCompRun.done && !abort.signal.aborted) {
                  await new Promise(r => setTimeout(r, 500));
                }

                if (ctx.activeCompRun?.success) {
                  batch.completedIterations++;
                } else {
                  batch.failedIterations++;
                }
              } else {
                batch.failedIterations++;
                debugLog.warn('batch', `Batch iteration ${i + 1} failed to start: ${runData.error || 'unknown'}`);
              }
            } catch (iterErr) {
              batch.failedIterations++;
              debugLog.error('batch', `Batch iteration ${i + 1} error: ${iterErr}`);
            }

            // Delay between iterations (skip if last or aborted)
            if (i < iterations.length - 1 && !abort.signal.aborted) {
              await new Promise(r => setTimeout(r, batch.delayBetweenMs));
            }
          }
        } catch (err) {
          batch.error = String(err);
          debugLog.error('batch', `Batch "${batchId}" crashed: ${err}`);
        } finally {
          batch.done = true;
          batch.durationMs = Date.now() - batch.startedAt;
          debugLog.info('batch', `Batch "${batchId}" finished`, {
            completed: batch.completedIterations,
            failed: batch.failedIterations,
            total: batch.totalIterations,
            durationMs: batch.durationMs,
          });
        }
      })();

    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // GET /api/batch/status — poll batch execution progress
  if (req.method === 'GET' && pathname === '/api/batch/status') {
    if (!ctx.activeBatchRun) {
      sendJson(res, 200, { active: false });
      return true;
    }
    sendJson(res, 200, {
      active: !ctx.activeBatchRun.done,
      done: ctx.activeBatchRun.done,
      batchId: ctx.activeBatchRun.batchId,
      compositionId: ctx.activeBatchRun.compositionId,
      compositionName: ctx.activeBatchRun.compositionName,
      totalIterations: ctx.activeBatchRun.totalIterations,
      completedIterations: ctx.activeBatchRun.completedIterations,
      failedIterations: ctx.activeBatchRun.failedIterations,
      currentIteration: ctx.activeBatchRun.currentIteration,
      runIds: ctx.activeBatchRun.runIds,
      error: ctx.activeBatchRun.error,
      durationMs: ctx.activeBatchRun.done ? ctx.activeBatchRun.durationMs : Date.now() - ctx.activeBatchRun.startedAt,
    });
    return true;
  }

  // POST /api/batch/cancel — abort a running batch
  if (req.method === 'POST' && pathname === '/api/batch/cancel') {
    if (!ctx.activeBatchRun || ctx.activeBatchRun.done) {
      sendJson(res, 400, { error: 'No batch is currently running' });
      return true;
    }
    ctx.activeBatchRun.abort.abort();
    // Also cancel the current composition run if active
    if (ctx.activeCompRun && !ctx.activeCompRun.done) {
      ctx.activeCompRun.abort.abort();
      for (const nodeId in ctx.activeCompRun.nodeStates) {
        const ns = ctx.activeCompRun.nodeStates[nodeId];
        if (ns.status === 'running' || ns.status === 'retrying') ns.status = 'failed';
        if (ns.status === 'pending') ns.status = 'skipped';
      }
      ctx.activeCompRun.done = true;
      ctx.activeCompRun.success = false;
      ctx.activeCompRun.error = 'Cancelled (batch cancelled)';
      ctx.activeCompRun.durationMs = Date.now() - ctx.activeCompRun.startedAt;
    }
    // Reject any pending approvals
    for (const [approvalId, entry] of ctx.pendingApprovals) {
      if (entry.timer) clearTimeout(entry.timer);
      ctx.pendingApprovals.delete(approvalId);
      entry.resolve(false);
    }
    ctx.activeBatchRun.done = true;
    ctx.activeBatchRun.durationMs = Date.now() - ctx.activeBatchRun.startedAt;
    sendJson(res, 200, { success: true, message: 'Batch cancelled' });
    return true;
  }

  return false;
};
