/**
 * Config Dashboard
 *
 * Built-in web dashboard for managing extension API keys.
 * Runs locally on 127.0.0.1 with auto-assigned port.
 *
 * Routes:
 *   GET  /                         -> index.html
 *   GET  /*.html|js|css            -> static files
 *   GET  /api/extensions           -> list all extensions with env status
 *   GET  /api/extensions/:name/env -> env var status for one extension
 *   PUT  /api/extensions/:name/env -> update env vars for one extension
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import {
  discoverExtensions,
  parseEnvFile,
  writeEnvFile,
  type ExtensionManifest,
} from './extension-loader.js';
import type { ExtensionManager } from './extension-manager.js';
import { debugLog } from './debug-log.js';
import {
  discoverWorkflows,
  loadWorkflow,
  type DiscoveredWorkflow,
} from './workflow/loader.js';
import { WorkflowRecorder } from './workflow/recorder.js';
import { bridgeServer, ensureBridgeServer } from './bridge-server.js';
import { appendFileSync, mkdirSync } from 'node:fs';

// Shared recording log
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

// ────────────────────────────────────────────────────────────────
//  Public types
// ────────────────────────────────────────────────────────────────

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Mask an API key value: show first 4 and last 4 chars, rest asterisked */
export function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
}

/** Validate env var name: alphanumeric + underscore, starts with letter */
function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/** Read and parse a request body as JSON */
async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response */
function sendJson(res: ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// ────────────────────────────────────────────────────────────────
//  Extension env status
// ────────────────────────────────────────────────────────────────

/** Build the env status response for a single extension */
async function getExtensionEnvStatus(manifest: ExtensionManifest, extensionManager?: ExtensionManager) {
  // Read current .env
  let currentEnv: Record<string, string> = {};
  try {
    const content = await readFile(join(manifest.directory, '.env'), 'utf-8');
    currentEnv = parseEnvFile(content);
  } catch {
    // No .env file
  }

  // Build status for each declared var
  const vars = Object.entries(manifest.envDeclarations).map(([key, decl]) => ({
    name: key,
    description: decl.description,
    required: decl.required,
    type: decl.type || 'string',
    isSet: !!currentEnv[key],
    maskedValue: currentEnv[key] ? maskValue(currentEnv[key]) : null,
    // For path-type vars, also send the raw value (not secret data)
    ...(decl.type === 'path' && currentEnv[key] ? { rawValue: currentEnv[key] } : {}),
  }));

  // Include any extra vars in .env not declared in manifest
  const declaredKeys = new Set(Object.keys(manifest.envDeclarations));
  const extraVars = Object.entries(currentEnv)
    .filter(([key]) => !declaredKeys.has(key))
    .map(([key, value]) => ({
      name: key,
      description: '',
      required: false,
      isSet: true,
      maskedValue: maskValue(value),
    }));

  // Get web UI URLs from the running extension manager
  let webUIs: string[] = [];
  if (extensionManager) {
    const summaries = extensionManager.getExtensionSummaries();
    const summary = summaries.find(s => s.name === manifest.name);
    if (summary) {
      webUIs = summary.webUIs;
    }
  }

  // Check for external web app status (e.g., social-scheduler writes its own status file)
  try {
    const statusPath = join(manifest.directory, '.webui-status.json');
    const statusContent = await readFile(statusPath, 'utf-8');
    const status = JSON.parse(statusContent);
    if (status.url && !webUIs.includes(status.url)) {
      webUIs.push(status.url);
    }
  } catch {
    // No status file — that's fine
  }

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    source: manifest.source,
    directory: manifest.directory,
    vars: [...vars, ...extraVars],
    webUIs,
  };
}

// ────────────────────────────────────────────────────────────────
//  Dashboard server
// ────────────────────────────────────────────────────────────────

export async function startDashboard(
  verbose: boolean = false,
  extensionManager?: ExtensionManager,
  workingDirectory?: string,
  preferredPort: number = 9001
): Promise<DashboardHandle> {
  // Static files are copied to dist/config-dashboard/ by the postbuild script
  const staticDir = join(__dirname, 'config-dashboard');
  const workDir = workingDirectory || process.cwd();

  // Recording state — shared across requests
  let activeRecorder: WorkflowRecorder | null = null;
  let recordingSteps: Array<{ index: number; label: string; type: string }> = [];
  let recordingStatus: string = '';

  // Workflow execution state — shared across requests
  let activeRun: {
    workflowId: string;
    workflowName: string;
    abort: AbortController;
    startedAt: number;
    stepsTotal: number;
    stepsCompleted: number;
    currentStep: string;
    stepResults: Array<{ index: number; label: string; type: string; status: string; error?: string }>;
    done: boolean;
    success: boolean;
    error?: string;
    durationMs?: number;
    outputVariables?: Record<string, unknown>;
  } | null = null;

  // Debug mode state (visual step-through)
  let debugSession: {
    workflowId: string;
    workflowName: string;
    workflow: any;
    variables: Record<string, unknown>;
    currentIndex: number;
    completedIndices: number[];
    failedIndices: number[];
    stepResults: any[];
  } | null = null;

  const server: Server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Log API requests (skip static file requests for brevity)
    if (pathname.startsWith('/api/')) {
      debugLog.debug('dashboard', `${req.method} ${pathname}`);
    }

    // ── API Routes ───────────────────────────────────────────

    // GET /api/extensions
    if (req.method === 'GET' && pathname === '/api/extensions') {
      try {
        const manifests = await discoverExtensions();
        const extensions = await Promise.all(
          manifests.map((m) => getExtensionEnvStatus(m, extensionManager))
        );
        sendJson(res, 200, { extensions });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/extensions/:name/env
    const getEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'GET' && getEnvMatch) {
      const name = decodeURIComponent(getEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }
        const status = await getExtensionEnvStatus(manifest, extensionManager);
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/extensions/:name/env
    const putEnvMatch = pathname.match(/^\/api\/extensions\/([^/]+)\/env$/);
    if (req.method === 'PUT' && putEnvMatch) {
      const name = decodeURIComponent(putEnvMatch[1]);
      try {
        const manifests = await discoverExtensions();
        const manifest = manifests.find((m) => m.name === name);
        if (!manifest) {
          sendJson(res, 404, { error: `Extension "${name}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || typeof body.vars !== 'object') {
          sendJson(res, 400, {
            error: 'Request body must have a "vars" object',
          });
          return;
        }

        // Validate var names
        for (const key of Object.keys(body.vars)) {
          if (!isValidEnvVarName(key)) {
            sendJson(res, 400, { error: `Invalid env var name: "${key}"` });
            return;
          }
        }

        // Read existing .env to merge (preserve vars not in request)
        let existingEnv: Record<string, string> = {};
        const envFilePath = join(manifest.directory, '.env');
        try {
          const content = await readFile(envFilePath, 'utf-8');
          existingEnv = parseEnvFile(content);
        } catch {
          // No existing .env file
        }

        // Merge: new values override existing; empty string = delete
        const merged = { ...existingEnv };
        for (const [key, value] of Object.entries(
          body.vars as Record<string, string>
        )) {
          if (value === '' || value === null || value === undefined) {
            delete merged[key];
          } else {
            merged[key] = String(value);
          }
        }

        // Write back
        const envContent = writeEnvFile(merged);
        await writeFile(envFilePath, envContent, 'utf-8');
        debugLog.info('dashboard', `Updated env for "${name}"`, {
          keysSet: Object.keys(merged),
          envFile: envFilePath,
        });

        // Return updated status
        const status = await getExtensionEnvStatus(manifest, extensionManager);
        sendJson(res, 200, { success: true, ...status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/browse — list directories for folder picker
    if (req.method === 'POST' && pathname === '/api/browse') {
      try {
        const body = await readBody(req);
        const dir = body?.path || homedir();

        const entries = await readdir(dir, { withFileTypes: true });
        const dirs: Array<{ name: string; path: string }> = [];
        for (const entry of entries) {
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          try {
            const fullPath = join(dir, entry.name);
            const stats = await stat(fullPath);
            if (stats.isDirectory()) {
              dirs.push({ name: entry.name, path: fullPath });
            }
          } catch {
            // Skip unreadable entries
          }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, { current: dir, parent: join(dir, '..'), dirs });
      } catch (err) {
        sendJson(res, 400, { error: `Cannot read directory: ${err}` });
      }
      return;
    }

    // ── Workflow API Routes ─────────────────────────────────

    // GET /api/workflows — list all workflows
    if (req.method === 'GET' && pathname === '/api/workflows') {
      try {
        const discovered = await discoverWorkflows(workDir);
        const workflows = discovered.map(d => ({
          id: d.workflow.id,
          name: d.workflow.name,
          description: d.workflow.description,
          site: d.workflow.site,
          source: d.source,
          extensionName: d.extensionName,
          path: d.path,
          stepCount: d.workflow.steps.length,
          variableCount: d.workflow.variables.length,
          variables: d.workflow.variables.map(v => ({
            name: v.name,
            description: v.description,
            type: v.type,
            required: v.required,
            default: v.default,
          })),
          smartWaitCount: d.workflow.steps.filter(
            (s: any) => s.type === 'wait' && s.condition?.type !== 'delay'
          ).length,
          metadata: d.workflow.metadata,
        }));
        sendJson(res, 200, { workflows });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows — create a new workflow from scratch
    if (req.method === 'POST' && pathname === '/api/workflows') {
      try {
        const body = await readBody(req);
        if (!body) {
          sendJson(res, 400, { error: 'Request body is required' });
          return;
        }

        const { name, description, site, variables, steps } = body;
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendJson(res, 400, { error: 'Workflow name is required' });
          return;
        }

        // Generate ID from name: "My Workflow" → "my-workflow"
        const id = name.trim().toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (!id) {
          sendJson(res, 400, { error: 'Could not generate a valid ID from the workflow name' });
          return;
        }

        // Check for ID collision
        const discovered = await discoverWorkflows(workDir);
        if (discovered.some(d => d.workflow.id === id)) {
          sendJson(res, 409, { error: `A workflow with ID "${id}" already exists` });
          return;
        }

        // Build the workflow document
        const workflow = {
          version: '1.0',
          id,
          name: name.trim(),
          description: (description || '').trim() || `Workflow: ${name.trim()}`,
          site: (site || '').trim() || undefined,
          variables: Array.isArray(variables) ? variables : [],
          steps: Array.isArray(steps) ? steps : [],
          metadata: {
            createdAt: new Date().toISOString(),
            recordedBy: 'dashboard',
          },
        };

        // Save to global workflows directory
        const globalDir = join(homedir(), '.woodbury', 'workflows');
        await mkdir(globalDir, { recursive: true });
        const filePath = join(globalDir, `${id}.workflow.json`);
        await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');
        debugLog.info('dashboard', `Created workflow "${id}"`, { path: filePath });
        sendJson(res, 201, { success: true, workflow, path: filePath });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Recording API Routes ──────────────────────────────────

    // POST /api/recording/start — start recording a new workflow
    if (req.method === 'POST' && pathname === '/api/recording/start') {
      dashRecLog('INFO', '/api/recording/start called');
      try {
        const body = await readBody(req);
        dashRecLog('INFO', 'Request body', { name: body?.name, site: body?.site });
        if (!body || !body.name || !body.site) {
          dashRecLog('ERROR', 'Missing name or site');
          sendJson(res, 400, { error: 'name and site are required' });
          return;
        }
        if (activeRecorder?.isActive) {
          dashRecLog('ERROR', 'Recording already in progress');
          sendJson(res, 409, { error: 'Recording already in progress. Stop or cancel first.' });
          return;
        }

        recordingSteps = [];
        recordingStatus = 'Starting...';

        activeRecorder = new WorkflowRecorder(
          // onStepCaptured — collect steps for the UI to poll
          (step, index) => {
            recordingSteps.push({
              index,
              label: step.label || step.id || `Step ${index + 1}`,
              type: step.type,
            });
          },
          // onStatus — track status messages
          (status) => {
            recordingStatus = status;
          }
        );

        dashRecLog('INFO', 'Calling activeRecorder.start()');
        await activeRecorder.start(body.name, body.site);
        dashRecLog('INFO', 'activeRecorder.start() completed successfully');
        sendJson(res, 200, { success: true, status: 'recording' });
      } catch (err) {
        dashRecLog('ERROR', 'Recording start failed', { error: String(err), stack: (err as Error)?.stack });
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/stop — stop recording and save the workflow
    if (req.method === 'POST' && pathname === '/api/recording/stop') {
      dashRecLog('INFO', '/api/recording/stop called');
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }

        const result = await activeRecorder.stop(workDir);
        activeRecorder = null;
        recordingStatus = '';

        sendJson(res, 200, {
          success: true,
          workflow: result.workflow,
          filePath: result.filePath,
          stepCount: recordingSteps.length,
          newDownloads: result.newDownloads || [],
        });
        recordingSteps = [];
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/pause — pause recording
    if (req.method === 'POST' && pathname === '/api/recording/pause') {
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }
        activeRecorder.pause();
        sendJson(res, 200, { success: true, status: 'paused' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/resume — resume recording
    if (req.method === 'POST' && pathname === '/api/recording/resume') {
      try {
        if (!activeRecorder?.isActive) {
          sendJson(res, 400, { error: 'No recording in progress' });
          return;
        }
        activeRecorder.resume();
        sendJson(res, 200, { success: true, status: 'recording' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/recording/cancel — cancel recording without saving
    if (req.method === 'POST' && pathname === '/api/recording/cancel') {
      try {
        if (activeRecorder?.isActive) {
          activeRecorder.cancel();
        }
        activeRecorder = null;
        recordingSteps = [];
        recordingStatus = '';
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/recording/status — poll recording state and captured steps
    if (req.method === 'GET' && pathname === '/api/recording/status') {
      if (!activeRecorder) {
        // Only log once per "not active" stretch to avoid spamming
        dashRecLog('DEBUG', '/api/recording/status: no activeRecorder');
        sendJson(res, 200, { active: false, paused: false, stepCount: 0, steps: [], status: '' });
        return;
      }
      const status = activeRecorder.getStatus();
      if (!status.active) {
        dashRecLog('WARN', '/api/recording/status: activeRecorder exists but session not active', {
          hasRecorder: true,
          isActive: status.active,
        });
      }
      sendJson(res, 200, {
        ...status,
        steps: recordingSteps,
        statusMessage: recordingStatus,
      });
      return;
    }

    // POST /api/workflows/:id/run — execute a workflow directly
    const runWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
    if (req.method === 'POST' && runWfMatch) {
      const id = decodeURIComponent(runWfMatch[1]);
      try {
        if (activeRun && !activeRun.done) {
          sendJson(res, 409, { error: `Workflow "${activeRun.workflowName}" is already running. Wait for it to finish or cancel it.` });
          return;
        }

        const body = await readBody(req);
        const variables: Record<string, unknown> = body?.variables || {};

        // Discover and find the workflow
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        // Ensure bridge server is running + connected
        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected. Connect the Woodbury Chrome extension before running workflows.' });
          return;
        }

        const wf = found.workflow;
        const abort = new AbortController();

        activeRun = {
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
          activeRun = null;
          return;
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
            const { runPrompt } = await import('./loop/llm-service.js');
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
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
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

        sendJson(res, 200, { success: true, status: 'running', workflowName: wf.name, stepsTotal: wf.steps.length });

        // Execute asynchronously (don't await — we respond immediately)
        const run = activeRun;
        executeWorkflow(bridgeServer, wf, mergedVars, {
          log: (msg: string) => debugLog.info('dashboard-run', msg),
          signal: abort.signal,
          onProgress: (event: { type: string; index: number; total: number; step: any; status?: string; error?: string }) => {
            if (event.type === 'step_start') {
              run.currentStep = event.step?.label || event.step?.id || `Step ${event.index + 1}`;
            } else if (event.type === 'step_complete') {
              run.stepsCompleted = event.index + 1;
              run.stepResults.push({
                index: event.index,
                label: event.step?.label || event.step?.id || `Step ${event.index + 1}`,
                type: event.step?.type || 'unknown',
                status: event.status || 'unknown',
                error: event.error,
              });
            }
          },
        }).then((result: any) => {
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
        }).catch((err: Error) => {
          run.done = true;
          run.success = false;
          run.error = String(err);
          debugLog.error('dashboard-run', `Workflow "${wf.name}" crashed`, { error: String(err) });
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/workflows/run/status — poll workflow execution progress
    if (req.method === 'GET' && pathname === '/api/workflows/run/status') {
      if (!activeRun) {
        sendJson(res, 200, { active: false });
        return;
      }
      sendJson(res, 200, {
        active: !activeRun.done,
        done: activeRun.done,
        success: activeRun.success,
        workflowId: activeRun.workflowId,
        workflowName: activeRun.workflowName,
        stepsTotal: activeRun.stepsTotal,
        stepsCompleted: activeRun.stepsCompleted,
        currentStep: activeRun.currentStep,
        stepResults: activeRun.stepResults,
        error: activeRun.error,
        durationMs: activeRun.done ? activeRun.durationMs : Date.now() - activeRun.startedAt,
        outputVariables: activeRun.outputVariables,
      });
      return;
    }

    // POST /api/workflows/run/cancel — abort a running workflow
    if (req.method === 'POST' && pathname === '/api/workflows/run/cancel') {
      if (!activeRun || activeRun.done) {
        sendJson(res, 400, { error: 'No workflow is currently running' });
        return;
      }
      activeRun.abort.abort();
      activeRun.done = true;
      activeRun.success = false;
      activeRun.error = 'Cancelled by user';
      activeRun.durationMs = Date.now() - activeRun.startedAt;
      sendJson(res, 200, { success: true, message: 'Workflow cancelled' });
      return;
    }

    // ── Workflow Debug Mode ──────────────────────────────────

    // POST /api/workflows/:id/debug/start — enter debug mode with overlay
    const debugStartMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/start$/);
    if (req.method === 'POST' && debugStartMatch) {
      const id = decodeURIComponent(debugStartMatch[1]);
      try {
        const body = await readBody(req);
        const variables: Record<string, unknown> = body?.variables || {};

        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) { sendJson(res, 404, { error: `Workflow "${id}" not found` }); return; }

        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected.' }); return;
        }

        const wf = found.workflow;

        // Merge variable defaults
        const mergedVars: Record<string, unknown> = { ...variables };
        for (const v of (wf.variables || [])) {
          if (mergedVars[v.name] === undefined && v.default !== undefined) {
            mergedVars[v.name] = v.default;
          }
        }

        // Build step overlay data
        const overlaySteps = wf.steps.map((step: any, i: number) => {
          const eb = step.target?.expectedBounds;
          return {
            index: i,
            id: step.id,
            type: step.type,
            label: step.label || step.id || `Step ${i + 1}`,
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
          };
        });

        // Send overlay to Chrome extension
        try {
          const dbgPort = (server.address() as any)?.port || preferredPort;
          await bridgeServer.send('show_debug_overlay', {
            steps: overlaySteps,
            workflowName: wf.name,
            workflowId: id,
            apiBaseUrl: `http://127.0.0.1:${dbgPort}`,
          });
        } catch (overlayErr) {
          debugLog.warn('debug-mode', 'Failed to show overlay', { error: String(overlayErr) });
        }

        // Init debug session
        debugSession = {
          workflowId: id,
          workflowName: wf.name,
          workflow: wf,
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
      return;
    }

    // POST /api/workflows/:id/debug/step — execute next step
    const debugStepMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/step$/);
    if (req.method === 'POST' && debugStepMatch) {
      const id = decodeURIComponent(debugStepMatch[1]);
      try {
        if (!debugSession || debugSession.workflowId !== id) {
          sendJson(res, 400, { error: 'No debug session active for this workflow' }); return;
        }
        if (debugSession.currentIndex >= debugSession.workflow.steps.length) {
          sendJson(res, 400, { error: 'All steps completed' }); return;
        }

        await ensureBridgeServer();
        if (!bridgeServer.isConnected) {
          sendJson(res, 503, { error: 'Chrome extension is not connected.' }); return;
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
          sendJson(res, 500, { error: `Workflow runner import failed: ${importErr?.message}` }); return;
        }

        const stepIdx = debugSession.currentIndex;
        const step = debugSession.workflow.steps[stepIdx];

        // Execute single step
        const result = await executeSingleStep(bridgeServer, step, debugSession.variables, {
          log: (msg: string) => debugLog.info('debug-step', msg),
        });

        // Update session state
        if (result.success) {
          debugSession.completedIndices.push(stepIdx);
        } else {
          debugSession.failedIndices.push(stepIdx);
        }
        debugSession.stepResults.push({
          index: stepIdx,
          label: step.label || step.id,
          type: step.type,
          status: result.success ? 'success' : 'failed',
          error: result.error,
          coordinateInfo: result.coordinateInfo,
        });
        debugSession.currentIndex = stepIdx + 1;

        // Update overlay in Chrome extension
        try {
          await bridgeServer.send('update_debug_step', {
            currentIndex: debugSession.currentIndex,
            completedIndices: debugSession.completedIndices,
            failedIndices: debugSession.failedIndices,
            coordinateInfo: result.coordinateInfo,
            stepIndex: stepIdx,
            stepResult: {
              status: result.success ? 'success' : 'failed',
              error: result.error,
            },
          });
        } catch {}

        const hasMore = debugSession.currentIndex < debugSession.workflow.steps.length;
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
          hasMore,
          nextIndex: hasMore ? debugSession.currentIndex : null,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/debug/exit — exit debug mode
    const debugExitMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/debug\/exit$/);
    if (req.method === 'POST' && debugExitMatch) {
      try {
        await ensureBridgeServer();
        try { await bridgeServer.send('hide_debug_overlay', {}); } catch {}
        debugSession = null;
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
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
          sendJson(res, 400, { error: 'Invalid stepIndex' }); return;
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
          sendJson(res, 400, { error: 'Must provide at least one update field' }); return;
        }

        // Validate position if provided
        if (hasPosition) {
          if (typeof pctX !== 'number' || pctX < 0 || pctX > 100) {
            sendJson(res, 400, { error: 'pctX must be a number between 0 and 100' }); return;
          }
          if (typeof pctY !== 'number' || pctY < 0 || pctY > 100) {
            sendJson(res, 400, { error: 'pctY must be a number between 0 and 100' }); return;
          }
        }

        // Validate waitMs if provided
        if (hasWait) {
          if (typeof waitMs !== 'number' || waitMs < 0) {
            sendJson(res, 400, { error: 'waitMs must be a non-negative number' }); return;
          }
        }

        // Validate verifyClick if provided
        if (hasVerifyClick && verifyClick !== null) {
          if (typeof verifyClick !== 'object') {
            sendJson(res, 400, { error: 'verifyClick must be an object or null' }); return;
          }
          if (typeof verifyClick.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'verifyClick.enabled must be a boolean' }); return;
          }
        }

        // Validate clickType if provided
        if (hasClickType) {
          const validClickTypes = ['single', 'double', 'right', 'hover'];
          if (!validClickTypes.includes(clickType)) {
            sendJson(res, 400, { error: `clickType must be one of: ${validClickTypes.join(', ')}` }); return;
          }
        }

        // Check active debug session
        if (!debugSession || debugSession.workflowId !== id) {
          sendJson(res, 400, { error: 'No debug session active for this workflow' }); return;
        }

        const step = debugSession.workflow.steps[stepIndex];
        if (!step) {
          sendJson(res, 400, { error: `Step ${stepIndex} not found` }); return;
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
          const discovered = await discoverWorkflows(workDir);
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
              await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
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
      return;
    }

    // GET /api/workflows/:id — get a single workflow document
    const getWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'GET' && getWfMatch) {
      const id = decodeURIComponent(getWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }
        sendJson(res, 200, { workflow: found.workflow, path: found.path, source: found.source });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // PUT /api/workflows/:id — update a workflow document (full replacement)
    const putWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'PUT' && putWfMatch) {
      const id = decodeURIComponent(putWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || !body.workflow) {
          sendJson(res, 400, { error: 'Request body must have a "workflow" object' });
          return;
        }

        // Validate required fields
        const wf = body.workflow;
        if (!wf.version || !wf.id || !wf.name || !Array.isArray(wf.steps)) {
          sendJson(res, 400, { error: 'Workflow missing required fields (version, id, name, steps)' });
          return;
        }

        // Update metadata
        wf.metadata = wf.metadata || {};
        wf.metadata.updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Updated workflow "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true, workflow: wf, path: found.path });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/add-download-steps — append capture_download + move_file steps
    const addDlMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/add-download-steps$/);
    if (req.method === 'POST' && addDlMatch) {
      const id = decodeURIComponent(addDlMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        if (!body || !Array.isArray(body.files) || body.files.length === 0 || !body.destination) {
          sendJson(res, 400, { error: 'files (string[]) and destination (string) are required' });
          return;
        }

        const files: string[] = body.files;
        const destination: string = body.destination;
        const useVariable: boolean = body.useVariable !== false; // default true

        // Infer filename pattern from file list
        const inferFilenamePattern = (filenames: string[]): string => {
          const extensions = filenames.map(f => {
            const dot = f.lastIndexOf('.');
            return dot >= 0 ? f.slice(dot).toLowerCase() : '';
          }).filter(Boolean);
          if (extensions.length > 0 && extensions.every(e => e === extensions[0])) {
            // All same extension — e.g. ".*\.mp3$"
            return `.*\\${extensions[0]}$`;
          }
          return '.*'; // mixed extensions
        };

        const wf = found.workflow;
        const existingStepCount = wf.steps.length;

        // Create capture_download step
        const captureStep = {
          id: `capture-downloads-${existingStepCount + 1}`,
          type: 'capture_download' as const,
          label: 'Capture downloaded files',
          filenamePattern: inferFilenamePattern(files),
          maxFiles: files.length,
          lookbackMs: 30000,
          waitTimeoutMs: 120000,
          outputVariable: 'downloadedFiles',
        };

        // Create move_file step
        const moveStep = {
          id: `move-downloads-${existingStepCount + 2}`,
          type: 'move_file' as const,
          label: 'Move downloads to destination',
          source: '{{downloadedFiles}}',
          destination: useVariable ? '{{outputDir}}' : destination,
        };

        wf.steps.push(captureStep as any, moveStep as any);

        // Add outputDir variable if using variable mode
        if (useVariable) {
          if (!wf.variables) wf.variables = [];
          // Don't duplicate if already exists
          const existing = (wf.variables as any[]).find((v: any) => v.name === 'outputDir');
          if (!existing) {
            (wf.variables as any[]).push({
              name: 'outputDir',
              description: 'Output directory for downloaded files',
              type: 'string',
              required: false,
              default: destination,
            });
          }
        }

        // Update metadata
        wf.metadata = wf.metadata || {};
        (wf.metadata as any).updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Added download steps to workflow "${id}"`, {
          files: files.length, destination, useVariable,
        });
        sendJson(res, 200, { success: true, workflow: wf });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/workflows/:id/rename-variable — rename a variable and update all references
    const renameVarMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/rename-variable$/);
    if (req.method === 'POST' && renameVarMatch) {
      const id = decodeURIComponent(renameVarMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        const body = await readBody(req);
        const oldName = body?.oldName?.trim();
        const newName = body?.newName?.trim();

        if (!oldName || !newName) {
          sendJson(res, 400, { error: 'oldName and newName are required' });
          return;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
          sendJson(res, 400, { error: `Invalid variable name "${newName}". Must start with a letter or underscore and contain only letters, digits, and underscores.` });
          return;
        }

        const wf = found.workflow as any;
        const vars: any[] = wf.variables || [];
        const declIdx = vars.findIndex((v: any) => v.name === oldName);
        if (declIdx < 0) {
          sendJson(res, 404, { error: `Variable "${oldName}" not found in workflow` });
          return;
        }
        if (vars.some((v: any) => v.name === newName)) {
          sendJson(res, 409, { error: `Variable "${newName}" already exists` });
          return;
        }

        // ── Rename the variable everywhere ──
        // 1. Update declaration
        vars[declIdx].name = newName;

        // 2. Build regex for {{oldName}} replacement in string values
        const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\{\\{${escRegex(oldName)}\\}\\}`, 'g');
        const replacement = `{{${newName}}}`;

        // Named variable fields that hold a bare variable name (not interpolated)
        const NAMED_VAR_FIELDS = ['outputVariable', 'overVariable', 'itemVariable', 'indexVariable', 'errorVariable', 'variable'];

        // Recursively walk an object/array and replace {{oldName}} in all string values
        function walkAndReplace(obj: any): any {
          if (typeof obj === 'string') {
            return obj.replace(pattern, replacement);
          }
          if (Array.isArray(obj)) {
            return obj.map(item => walkAndReplace(item));
          }
          if (obj && typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
              obj[key] = walkAndReplace(obj[key]);
            }
          }
          return obj;
        }

        // Walk steps recursively (handles nested loop/try-catch steps)
        function walkSteps(steps: any[]): void {
          for (const step of steps) {
            // Replace {{oldName}} in all string fields of the step
            for (const key of Object.keys(step)) {
              // Skip named variable fields — those get exact match below
              if (NAMED_VAR_FIELDS.includes(key)) continue;
              // Skip nested step arrays — those get recursed separately
              if (key === 'steps' || key === 'trySteps' || key === 'catchSteps') continue;
              step[key] = walkAndReplace(step[key]);
            }

            // Named variable fields: exact string match replace
            for (const field of NAMED_VAR_FIELDS) {
              if (step[field] === oldName) step[field] = newName;
            }

            // Assertion/condition variable references
            for (const condArrayKey of ['preconditions', 'postconditions', 'assertions']) {
              if (Array.isArray(step[condArrayKey])) {
                for (const entry of step[condArrayKey]) {
                  const cond = entry?.condition || entry;
                  if (cond?.type === 'variable_equals' && cond.variable === oldName) {
                    cond.variable = newName;
                  }
                }
              }
            }

            // Recurse into nested steps
            if (Array.isArray(step.steps)) walkSteps(step.steps);
            if (Array.isArray(step.trySteps)) walkSteps(step.trySteps);
            if (Array.isArray(step.catchSteps)) walkSteps(step.catchSteps);
          }
        }

        walkSteps(wf.steps || []);

        // Update metadata
        wf.metadata = wf.metadata || {};
        wf.metadata.updatedAt = new Date().toISOString();

        await writeFile(found.path, JSON.stringify(wf, null, 2), 'utf-8');
        debugLog.info('dashboard', `Renamed variable "${oldName}" → "${newName}" in workflow "${id}"`, {
          path: found.path,
        });
        sendJson(res, 200, { success: true, workflow: wf });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // DELETE /api/workflows/:id — delete a workflow file
    const delWfMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'DELETE' && delWfMatch) {
      const id = decodeURIComponent(delWfMatch[1]);
      try {
        const discovered = await discoverWorkflows(workDir);
        const found = discovered.find(d => d.workflow.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Workflow "${id}" not found` });
          return;
        }

        await unlink(found.path);
        debugLog.info('dashboard', `Deleted workflow "${id}"`, { path: found.path });
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/autofill — AI-powered variable value generation
    if (req.method === 'POST' && pathname === '/api/autofill') {
      try {
        const body = await readBody(req);
        const { variables, workflowName, site, steps } = body || {};

        if (!variables || !Array.isArray(variables) || variables.length === 0) {
          sendJson(res, 400, { error: 'Must provide a "variables" array' });
          return;
        }

        // Build a concise context string from the workflow steps
        const stepsContext = (steps || [])
          .slice(0, 20) // limit to first 20 steps for token efficiency
          .map((s: any, i: number) => {
            let desc = `${i + 1}. ${s.type || 'action'}`;
            if (s.target?.textContent) desc += ` "${s.target.textContent}"`;
            if (s.target?.description) desc += ` (${s.target.description})`;
            if (s.value !== undefined) desc += ` → value: "${String(s.value).slice(0, 100)}"`;
            return desc;
          })
          .join('\n');

        // Build the variable descriptions
        const varDescriptions = variables
          .map((v: any) => {
            let line = `- ${v.name} (${v.type || 'string'})`;
            if (v.description) line += `: ${v.description}`;
            if (v.default) line += ` [default: ${v.default}]`;
            if (v.generationPrompt) line += ` [AI prompt: ${v.generationPrompt}]`;
            return line;
          })
          .join('\n');

        const prompt = `You are generating sample values for a browser automation workflow's variables. Generate realistic, creative, and contextually appropriate values.

Workflow: "${workflowName || 'Untitled'}"
Target site: ${site || 'unknown'}

Variables to fill:
${varDescriptions}

Workflow steps:
${stepsContext || '(no steps recorded)'}

Rules:
- Generate values that make sense for this specific workflow and target site
- For lyrics/text content, be creative and original — write a short verse or meaningful text
- For titles/names, be descriptive and catchy
- For genres/styles, pick something specific (not "General")
- For tags/hashtags, use relevant, realistic tags
- For URLs, use the target site domain if relevant
- For numbers, use sensible defaults for the context
- NEVER generate values for variables whose names contain "password", "secret", "token", or "key"
- Return ONLY a JSON object mapping variable names to generated values, no explanation

Example output:
{"song_title": "Neon Highways", "lyrics": "Driving fast through neon lights...\\nChasing dreams into the night", "genre": "Synthwave, Electronic"}`;

        // Try to use runPrompt from the LLM service
        const { runPrompt } = await import('./loop/llm-service.js');

        // Use a fast model — try claude-sonnet first, fall back to gpt-4o-mini
        const model = process.env.ANTHROPIC_API_KEY
          ? 'claude-sonnet-4-20250514'
          : process.env.OPENAI_API_KEY
            ? 'gpt-4o-mini'
            : process.env.GROQ_API_KEY
              ? 'llama-3.1-70b-versatile'
              : 'claude-sonnet-4-20250514'; // default, will error if no key

        const llmResponse = await runPrompt(
          [
            { role: 'user', content: prompt },
          ],
          model,
          { maxTokens: 1024, temperature: 0.8 }
        );

        // Parse the JSON from the response
        const content = llmResponse.content.trim();
        // Extract JSON from potential markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        const jsonStr = (jsonMatch[1] || content).trim();
        const generated = JSON.parse(jsonStr);

        debugLog.info('dashboard', 'AI autofill generated values', {
          model,
          variableCount: variables.length,
          generatedKeys: Object.keys(generated),
        });

        sendJson(res, 200, { success: true, values: generated });
      } catch (err) {
        debugLog.error('dashboard', 'AI autofill failed', { error: String(err) });
        sendJson(res, 500, { error: `AI autofill failed: ${(err as Error).message}` });
      }
      return;
    }

    // POST /api/generate-variable — AI generation for a single variable using its custom prompt
    if (req.method === 'POST' && pathname === '/api/generate-variable') {
      try {
        const body = await readBody(req);
        const { variableName, generationPrompt, workflowName, site, variableType } = body || {};

        if (!variableName || !generationPrompt) {
          sendJson(res, 400, { error: 'variableName and generationPrompt are required' });
          return;
        }

        const prompt = `You are generating a value for a variable in a browser automation workflow.

Variable: "${variableName}" (type: ${variableType || 'string'})
Workflow: "${workflowName || 'Untitled'}" on ${site || 'unknown site'}

Instructions from the user:
${generationPrompt}

Rules:
- Follow the user's instructions precisely
- Be creative and original for text/lyrics/content
- Return ONLY the raw value — no JSON wrapping, no quotes around it, no explanation
- If the type is a number, return just the number
- If the type is boolean, return just "true" or "false"
- For multi-line content (lyrics, paragraphs), use actual newlines`;

        const { runPrompt } = await import('./loop/llm-service.js');

        const model = process.env.ANTHROPIC_API_KEY
          ? 'claude-sonnet-4-20250514'
          : process.env.OPENAI_API_KEY
            ? 'gpt-4o-mini'
            : process.env.GROQ_API_KEY
              ? 'llama-3.1-70b-versatile'
              : 'claude-sonnet-4-20250514';

        const llmResponse = await runPrompt(
          [{ role: 'user', content: prompt }],
          model,
          { maxTokens: 2048, temperature: 0.9 }
        );

        const value = llmResponse.content.trim();

        debugLog.info('dashboard', `AI generated value for variable "${variableName}"`, {
          model,
          promptLength: generationPrompt.length,
          valueLength: value.length,
        });

        sendJson(res, 200, { success: true, value });
      } catch (err) {
        debugLog.error('dashboard', 'AI generate-variable failed', { error: String(err) });
        sendJson(res, 500, { error: `AI generation failed: ${(err as Error).message}` });
      }
      return;
    }

    // ── Static File Serving ─────────────────────────────────
    const filePath =
      pathname === '/' ? '/index.html' : pathname.split('?')[0];
    const fullPath = join(staticDir, filePath);

    try {
      const content = await readFile(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // Try preferred port first, fall back to random if in use
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (verbose) console.log(`[dashboard] Port ${preferredPort} in use, using random port`);
        server.listen(0, '127.0.0.1', resolve);
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });

  const addr = server.address();
  const assignedPort = typeof addr === 'object' && addr ? addr.port : 0;
  const dashboardUrl = `http://127.0.0.1:${assignedPort}`;

  if (verbose) {
    console.log(`[dashboard] Config dashboard at ${dashboardUrl}`);
  }

  return {
    url: dashboardUrl,
    port: assignedPort,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
