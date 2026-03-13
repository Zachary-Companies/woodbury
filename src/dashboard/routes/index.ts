/**
 * Dashboard Router
 *
 * Chains all route handlers together. The first handler that returns
 * `true` wins; if none match, the request falls through to static
 * file serving in the middleware layer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardContext, RouteHandler } from '../types.js';

// ── Import all route handlers ──────────────────────────────

import { handleAppRoutes } from './app.js';
import { handleBridgeRoutes } from './bridge.js';
import { handleExtensionRoutes } from './extensions.js';
import { handleMarketplaceRoutes } from './marketplace.js';
import { handleWorkflowRoutes } from './workflows.js';
import { handleRecordingRoutes } from './recording.js';
import { handleWorkflowRunRoutes } from './workflow-run.js';
import { handleCompositionsRoutes } from './compositions.js';
import { handleCompositionRunRoutes } from './composition-run.js';
import { handleBatchRoutes } from './batch.js';
import { handleApprovalsRoutes } from './approvals.js';
import { handleSchedulesRoutes } from './schedules.js';
import { handleRunsRoutes } from './runs.js';
import { handleTrainingRoutes } from './training.js';
import { handleWorkersRoutes } from './workers.js';
import { handleInferenceRoutes } from './inference.js';
import { handleSocialRoutes } from './social.js';
import { handleChatRoutes } from './chat.js';
import { handleMcpRoutes } from './mcp.js';
import { handleAssetRoutes } from './assets.js';
import { handleStoryboardRoutes } from './storyboard.js';
import { handleGenerationRoutes } from './generation.js';
import { handleToolsRoutes } from './tools.js';
import { handleSkillPolicyRoutes } from './skill-policies.js';
import { handleMemoryRoutes } from './memories.js';

// ── Handler chain (order matters for overlapping prefixes) ──

const handlers: RouteHandler[] = [
  // App & bridge (misc top-level routes)
  handleAppRoutes,
  handleBridgeRoutes,

  // Extension management
  handleExtensionRoutes,
  handleMarketplaceRoutes,

  // Workflow CRUD, recording, execution
  handleWorkflowRoutes,
  handleRecordingRoutes,
  handleWorkflowRunRoutes,

  // AI generation (must come before composition CRUD to catch /api/compositions/generate-*)
  handleGenerationRoutes,

  // Composition CRUD, execution, batch
  handleCompositionsRoutes,
  handleCompositionRunRoutes,
  handleBatchRoutes,

  // Approvals, schedules, run history
  handleApprovalsRoutes,
  handleSchedulesRoutes,
  handleRunsRoutes,

  // Training & inference
  handleTrainingRoutes,
  handleWorkersRoutes,
  handleInferenceRoutes,

  // Social scheduler
  handleSocialRoutes,

  // Chat
  handleChatRoutes,

  // MCP servers
  handleMcpRoutes,

  // Assets
  handleAssetRoutes,

  // Memories
  handleMemoryRoutes,

  // Storyboards
  handleStoryboardRoutes,

  // Extension tools
  handleToolsRoutes,

  // Skill policy review
  handleSkillPolicyRoutes,
];

/**
 * Route a request through all API handlers.
 * Returns true if any handler matched, false if none did.
 */
export async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  ctx: DashboardContext,
): Promise<boolean> {
  for (const handler of handlers) {
    try {
      if (await handler(req, res, pathname, url, ctx)) {
        return true;
      }
    } catch (err) {
      // Catch unhandled errors in route handlers
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `Internal server error: ${String(err)}` }));
      }
      return true;
    }
  }
  return false;
}
