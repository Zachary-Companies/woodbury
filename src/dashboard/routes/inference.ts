/**
 * Dashboard Route: Inference
 *
 * Handles /api/inference endpoints.
 * Provides inference server status checking.
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson } from '../utils.js';

// ── Constants ────────────────────────────────────────────────
const INFERENCE_PORT = 8679;

// ── Route handler ────────────────────────────────────────────

export const handleInferenceRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {

  // GET /api/inference/status — check inference server status
  if (req.method === 'GET' && pathname === '/api/inference/status') {
    sendJson(res, 200, {
      running: ctx.inferenceServer !== null,
      model: ctx.inferenceModelPath,
      port: INFERENCE_PORT,
    });
    return true;
  }

  return false;
};
