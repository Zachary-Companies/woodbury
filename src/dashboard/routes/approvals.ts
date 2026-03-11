/**
 * Dashboard Route: Approvals
 *
 * Handles /api/approvals endpoints.
 * Provides approval gate listing, approval, and rejection for composition pipeline runs.
 */

import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson } from '../utils.js';
import type { PendingApproval } from '../../workflow/types.js';
import { debugLog } from '../../debug-log.js';

// ── Route handler ────────────────────────────────────────────

export const handleApprovalsRoutes: RouteHandler = async (req, res, pathname, url, ctx) => {
  // GET /api/approvals — list all pending approvals
  if (req.method === 'GET' && pathname === '/api/approvals') {
    const approvals: PendingApproval[] = [];
    for (const [, entry] of ctx.pendingApprovals) {
      approvals.push(entry.approval);
    }
    sendJson(res, 200, { approvals });
    return true;
  }

  // POST /api/approvals/:id/approve — approve a pending gate
  const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const approvalId = decodeURIComponent(approveMatch[1]);
    const entry = ctx.pendingApprovals.get(approvalId);
    if (!entry) {
      sendJson(res, 404, { error: `Approval "${approvalId}" not found or already resolved` });
      return true;
    }
    if (entry.timer) clearTimeout(entry.timer);
    ctx.pendingApprovals.delete(approvalId);
    entry.resolve(true);
    debugLog.info('approval', `Approval "${approvalId}" approved by user`);
    sendJson(res, 200, { success: true, approved: true });
    return true;
  }

  // POST /api/approvals/:id/reject — reject a pending gate
  const rejectMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    const approvalId = decodeURIComponent(rejectMatch[1]);
    const entry = ctx.pendingApprovals.get(approvalId);
    if (!entry) {
      sendJson(res, 404, { error: `Approval "${approvalId}" not found or already resolved` });
      return true;
    }
    if (entry.timer) clearTimeout(entry.timer);
    ctx.pendingApprovals.delete(approvalId);
    entry.resolve(false);
    debugLog.info('approval', `Approval "${approvalId}" rejected by user`);
    sendJson(res, 200, { success: true, approved: false });
    return true;
  }

  return false;
};
