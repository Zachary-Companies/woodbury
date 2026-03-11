# Dashboard API Endpoint Reference

Complete reference for all HTTP endpoints served by the Woodbury dashboard (`config-dashboard.ts`).

For the structured chat SSE contract, see [chat-api-and-sse-contract.md](chat-api-and-sse-contract.md).
For composition artifact and validation rules, see [composition-schema-and-validation.md](composition-schema-and-validation.md).

**Base URL:** `http://localhost:<dashboard-port>` (default: configured at startup)

All endpoints return JSON via `sendJson(res, status, data)` unless otherwise noted.
Error responses follow the pattern `{ "error": "description" }`.

---

## 1. App & Bridge

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bridge/status` | Get Chrome extension connection status |
| POST | `/api/bridge/screenshot` | Capture viewport screenshot via Chrome bridge |
| POST | `/api/app/update-install` | Trigger auto-updater to download and install |
| GET | `/api/app/update-check` | Check for app updates against woodbury.bot |
| GET | `/api/file` | Serve a local file by absolute path (for media preview) |
| POST | `/api/browse` | List subdirectories for folder picker UI |
| POST | `/api/browse-files` | List files and directories for file picker UI |
| POST | `/api/click-extension-icon` | Click Woodbury extension icon in Chrome toolbar |

### Request/Response Details

**GET `/api/bridge/status`**
```
Response: { bridgeRunning, extensionConnected, extensionPath }
```

**POST `/api/app/update-install`**
```
Response: { status: "ok", message: "Update check triggered..." }
```

**GET `/api/app/update-check`**
```
Response: { currentVersion, latestVersion, updateAvailable, releaseDate, releaseNotes, downloadUrls, releaseUrl }
```

**GET `/api/file?path=<absolute-path>`**
Streams the file with appropriate Content-Type. Path must be absolute.

**POST `/api/browse`**
```
Body: { path?: string }  (defaults to home directory)
Response: { current, parent, dirs: [{ name, path }] }
```

**POST `/api/browse-files`**
```
Body: { path?: string }
Response: { current, parent, dirs: [{ name, path }], files: [{ name, path, size }] }
```

**POST `/api/bridge/screenshot`**
```
Response: { screenshot: "<base64 data url>", viewport: { width, height } }
```

---

## 2. Extensions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/extensions` | List all installed extensions with env status |
| GET | `/api/extensions/:name/env` | Get env var status for a specific extension |
| PUT | `/api/extensions/:name/env` | Set env vars for an extension (.env file) |
| POST | `/api/extensions/:name/enable` | Enable an extension |
| POST | `/api/extensions/:name/disable` | Disable an extension |

### Request/Response Details

**GET `/api/extensions`**
```
Response: { extensions: [{ name, directory, envVars, enabled, ... }] }
```

**PUT `/api/extensions/:name/env`**
```
Body: { vars: { KEY: "value", ... } }  (empty string = delete var)
Response: { success: true, ...envStatus }
```

**POST `/api/extensions/:name/enable`**
```
Response: { success: true, name, enabled: true }
```

---

## 3. Marketplace

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/marketplace/registry` | Fetch and cache the extension registry from woodbury.bot |
| POST | `/api/marketplace/install` | Install an extension from a git URL |
| POST | `/api/marketplace/uninstall` | Uninstall an extension by name |
| GET | `/api/marketplace/auth-status` | Check marketplace sign-in status |
| POST | `/api/marketplace/auth/signin` | Sign in with Google OAuth (Firebase) |
| POST | `/api/marketplace/auth/signout` | Sign out of marketplace |
| GET | `/api/marketplace/shared-workflows` | Browse shared workflows from the marketplace |
| POST | `/api/marketplace/publish` | Publish a workflow to the marketplace |
| POST | `/api/marketplace/download` | Download and install a shared workflow |
| GET | `/api/marketplace/updates` | Check for updates to installed shared workflows |
| POST | `/api/marketplace/update` | Update an installed shared workflow |

### Request/Response Details

**POST `/api/marketplace/install`**
```
Body: { gitUrl: "https://github.com/Zachary-Companies/...", name?: string }
Response: { success, name, directory, message, activated }
```

**POST `/api/marketplace/uninstall`**
```
Body: { name: "extension-name" }
Response: { success, name, message }
```

**POST `/api/marketplace/auth/signin`**
```
Body: { idToken: "..." }
Response: { success, uid, displayName, email }
```

**GET `/api/marketplace/shared-workflows?category=...&sortBy=...&limit=50`**
```
Response: { workflows: [...] }
```

**POST `/api/marketplace/publish`**
```
Body: { workflowPath, metadata, existingWorkflowId? }
Response: { success, ... }
```

**POST `/api/marketplace/download`**
```
Body: { workflowId, version? }
Response: { success, ... }
```

---

## 4. Workflows

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List all discovered workflows |
| POST | `/api/workflows` | Create a new workflow from scratch |
| GET | `/api/workflows/:id` | Get a single workflow document |
| PUT | `/api/workflows/:id` | Update a workflow (full replacement) |
| DELETE | `/api/workflows/:id` | Delete a workflow file |
| POST | `/api/workflows/:id/rename` | Rename a workflow (display name only) |
| POST | `/api/workflows/:id/rename-variable` | Rename a variable and update all references |
| POST | `/api/workflows/:id/add-download-steps` | Append capture_download + move_file steps |
| POST | `/api/workflows/:id/visual-find` | Find an element visually using inference server |
| POST | `/api/workflows/:id/visual-verify` | Standalone visual verification for a step |
| POST | `/api/workflows/:id/search-bounds` | Save search bounds for a step |

### Request/Response Details

**GET `/api/workflows`**
```
Response: { workflows: [{ id, name, description, site, source, path, format,
  stepCount, variableCount, variables, outputVariables, smartWaitCount, metadata }] }
```

**POST `/api/workflows`**
```
Body: { name, description?, site?, variables?: [], steps?: [] }
Response: { success, workflow, path }
```

**PUT `/api/workflows/:id`**
```
Body: { workflow: { version, id, name, steps, ... } }
Response: { success, workflow, path }
```

**POST `/api/workflows/:id/rename`**
```
Body: { name: "New Name" }
Response: { success, workflow }
```

**POST `/api/workflows/:id/rename-variable`**
```
Body: { oldName, newName }
Response: { success, workflow }
```

**POST `/api/workflows/:id/add-download-steps`**
```
Body: { files: string[], destination: string, useVariable?: boolean }
Response: { success, workflow }
```

**POST `/api/workflows/:id/visual-find`**
```
Body: { referenceImagePath, searchBounds?, expectedBounds?, screenshotPath?, savedElementsPath? }
Response: { found, similarity, position, ... }
```

---

## 5. Recording

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/recording/start` | Start recording a new workflow |
| POST | `/api/recording/stop` | Stop recording and save the workflow |
| POST | `/api/recording/pause` | Pause the active recording |
| POST | `/api/recording/resume` | Resume a paused recording |
| POST | `/api/recording/cancel` | Cancel recording without saving |
| GET | `/api/recording/status` | Poll recording state and captured steps |

### Request/Response Details

**POST `/api/recording/start`**
```
Body: { name, site, captureElementCrops?: true, recordingMode?: "standard"|"accessibility",
  appName?: string, reRecord?: { workflowId, filePath } }
Response: { success, status: "recording" }
```

**POST `/api/recording/stop`**
```
Response: { success, workflow, filePath, stepCount, newDownloads, trainingStatus }
```

**GET `/api/recording/status`**
```
Response: { active, paused, stepCount, steps: [{ index, label, type }], statusMessage }
```

---

## 6. Workflow Execution & Debug

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflows/:id/run` | Execute a workflow |
| GET | `/api/workflows/run/status` | Poll workflow execution progress |
| POST | `/api/workflows/run/cancel` | Abort a running workflow |
| POST | `/api/workflows/:id/debug/start` | Enter debug mode with overlay |
| POST | `/api/workflows/:id/debug/step` | Execute the next step in debug mode |
| POST | `/api/workflows/:id/debug/exit` | Exit debug mode |
| POST | `/api/workflows/:id/debug/update-step` | Update step properties (position, wait time) |
| POST | `/api/workflows/:id/debug/capture-element` | Capture reference image at adjusted position |

### Request/Response Details

**POST `/api/workflows/:id/run`**
```
Body: { variables?: { key: value, ... } }
Response: { success, status: "running", runId, workflowName, stepsTotal }
```

**GET `/api/workflows/run/status`**
```
Response: { active, done, runId, success, workflowId, workflowName,
  stepsTotal, stepsCompleted, currentStep, stepResults, error,
  durationMs, outputVariables, trainingDataKept }
```

**POST `/api/workflows/run/cancel`**
```
Response: { success, message: "Workflow cancelled" }
```

**POST `/api/workflows/:id/debug/start`**
```
Body: { variables?: {} }
Response: { success, workflowId, workflowName, totalSteps, flatSteps, steps }
```

**POST `/api/workflows/:id/debug/step`**
```
Response: { success, stepIndex, stepResult: { label, type, status, error },
  coordinateInfo, visualVerification, hasMore, nextIndex }
```

**POST `/api/workflows/:id/debug/update-step`**
```
Body: { stepIndex, pctX?, pctY?, waitMs?, verifyClick?, clickType?, ... }
Response: { success, ... }
```

---

## 7. Compositions (Pipelines)

For composition artifact rules and validation expectations, see [composition-schema-and-validation.md](composition-schema-and-validation.md).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/compositions` | List all compositions |
| POST | `/api/compositions` | Create a new composition |
| GET | `/api/compositions/:id` | Get a single composition |
| PUT | `/api/compositions/:id` | Update a composition (full replace) |
| DELETE | `/api/compositions/:id` | Delete a composition |
| POST | `/api/compositions/:id/rename` | Rename a composition (display name only) |
| POST | `/api/compositions/:id/move` | Move composition to a folder |
| POST | `/api/compositions/:id/duplicate` | Clone a composition |
| GET | `/api/compositions/:id/interface` | Get the composition's formal interface (inputs/outputs) |
| DELETE | `/api/compositions/:id/cache/:nodeId` | Clear idempotency cache for a node |
| DELETE | `/api/compositions/:id/cache` | Clear all idempotency cache for a composition |

### Request/Response Details

**GET `/api/compositions`**
```
Response: { compositions: [{ id, name, description, folder, source, path,
  nodeCount, edgeCount, metadata }] }
```

**POST `/api/compositions`**
```
Body: { name, description?, folder? }
Response: { success, composition, path }
```

**PUT `/api/compositions/:id`**
```
Body: { composition: { version, id, name, nodes, edges, ... } }
Response: { success, composition, path }
```

**POST `/api/compositions/:id/rename`**
```
Body: { name: "New Name" }
Response: { success, composition }
```

**POST `/api/compositions/:id/move`**
```
Body: { folder: "folder-name" }
Response: { success, composition }
```

**POST `/api/compositions/:id/duplicate`**
```
Response: { success, composition, path }
```

**GET `/api/compositions/:id/interface`**
```
Response: { inputs, outputs, compositionId, compositionName }
```

---

## 8. Composition Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/compositions/:id/run` | Execute a composition (pipeline) |
| GET | `/api/compositions/run/status` | Poll composition execution progress |
| POST | `/api/compositions/run/cancel` | Abort a running composition |

### Request/Response Details

**POST `/api/compositions/:id/run`**
```
Body: { variables?: { key: value, ... } }
Response: { success, status: "running", runId, compositionName, nodesTotal, executionOrder }
```

**GET `/api/compositions/run/status`**
```
Response: { active, done, runId, success, compositionId, compositionName,
  nodesTotal, nodesCompleted, currentNodeId, executionOrder, nodeStates,
  pendingApprovals, error, durationMs, pipelineOutputs }
```

---

## 9. Batch Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/compositions/:id/batch-run` | Run a composition in batch mode |
| GET | `/api/batch/status` | Poll batch execution progress |
| POST | `/api/batch/cancel` | Abort a running batch |

### Request/Response Details

**POST `/api/compositions/:id/batch-run`**
```
Body: { batchConfig: { mode: "zip"|"cross", pools: [{ variableName, values }] },
  variables?: {} }
Response: { success, batchId, totalIterations, compositionName }
```

**GET `/api/batch/status`**
```
Response: { active, done, batchId, compositionId, compositionName,
  totalIterations, completedIterations, failedIterations, currentIteration,
  runIds, error, durationMs }
```

---

## 10. Approvals

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/approvals` | List all pending approval gates |
| POST | `/api/approvals/:id/approve` | Approve a pending gate |
| POST | `/api/approvals/:id/reject` | Reject a pending gate |

### Request/Response Details

**GET `/api/approvals`**
```
Response: { approvals: [{ id, runId, nodeId, ... }] }
```

**POST `/api/approvals/:id/approve`**
```
Response: { success, approved: true }
```

**POST `/api/approvals/:id/reject`**
```
Response: { success, approved: false }
```

---

## 11. Schedules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/schedules` | List all schedules |
| POST | `/api/schedules` | Create a new schedule |
| GET | `/api/schedules/:id` | Get a single schedule |
| PUT | `/api/schedules/:id` | Update a schedule |
| DELETE | `/api/schedules/:id` | Delete a schedule |

### Request/Response Details

**POST `/api/schedules`**
```
Body: { compositionId, cron: "0 9 * * *", enabled?: true, variables?: {},
  description?, compositionName? }
Response: { schedule: { id, compositionId, compositionName, cron, enabled,
  variables, description, createdAt } }
```

**PUT `/api/schedules/:id`**
```
Body: { cron?, enabled?, variables?, description? }
Response: { schedule }
```

---

## 12. Runs (History)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs` | List runs with optional filters |
| DELETE | `/api/runs` | Clear all run history |
| GET | `/api/runs/:id` | Get a single run record |
| DELETE | `/api/runs/:id` | Delete a single run record |

### Request/Response Details

**GET `/api/runs?status=completed&type=workflow&limit=50&offset=0`**
```
Response: { runs: [...], total, limit, offset }
```

**GET `/api/runs/:id`**
```
Response: { run: { id, type, sourceId, name, startedAt, completedAt,
  durationMs, status, error, stepsTotal, stepsCompleted, stepResults, ... } }
```

---

## 13. Training

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/training/data-summary` | Scan training data directory for stats |
| POST | `/api/training/prepare` | Run data preparation from snapshots |
| POST | `/api/training/start` | Start model training (local or remote) |
| GET | `/api/training/status` | Poll training progress (local or remote) |
| POST | `/api/training/cancel` | Stop training (local or remote) |
| GET | `/api/training/models` | List trained models |
| GET | `/api/workflows/:id/training/status` | Poll per-workflow training progress |
| GET | `/api/workflows/:id/training/data` | Training data stats for a workflow |
| GET | `/api/workflows/:id/model/versions` | List all model versions for a workflow |
| POST | `/api/workflows/:id/model/activate` | Set a specific model version as active |
| POST | `/api/workflows/:id/training/retry` | Re-trigger training for a workflow |

### Request/Response Details

**GET `/api/training/data-summary`**
```
Response: { hasMetadata, hasSnapshots, totalCrops, uniqueGroups,
  uniqueSites, interactedGroups, dataDir }
```

**POST `/api/training/prepare`**
```
Body: { source?: "viewport", cropsPerElement?: 10 }
Response: { success, status: "preparing" }
```

**POST `/api/training/start`**
```
Body: { backbone?: "mobilenet_v3_small", epochs?: 50, lr?: 3e-4,
  lossType?: "ntxent", embedDim?: 64, exportOnnx?: true, workerId?: string }
Response: { success, outputDir }
```

**GET `/api/training/status`**
```
Response: { active, done, runId?, success, backbone, phase, currentEpoch,
  totalEpochs, loss, lr, eta_s, metrics, bestAuc, error, outputDir,
  durationMs, trainSamples, valSamples, groups, device, embedDim, lossType, logs }
```

**GET `/api/training/models`**
```
Response: { models: [{ id, dir, hasConfig, hasBestModel, hasFinalModel,
  hasOnnx, hasQuantized, files, createdAt }] }
```

**POST `/api/workflows/:id/model/activate`**
```
Body: { version: "v1" }
Response: { success, activeVersion }
```

**POST `/api/workflows/:id/training/retry`**
```
Body: { backbone?, epochs?, embedDim?, sources?: ["recording","execution","debug"] }
Response: { success, workflowId }
```

---

## 14. Workers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workers` | List remote workers with live health |
| POST | `/api/workers` | Add a remote worker |
| DELETE | `/api/workers/:id` | Remove a remote worker |
| GET | `/api/worker/python-check` | Check Python/woobury-models/GPU availability |
| POST | `/api/worker/start` | Start the local training worker |
| POST | `/api/worker/stop` | Stop the local training worker |
| GET | `/api/worker/status` | Get local worker status + job progress |
| GET | `/api/worker/logs` | Get worker subprocess logs |
| GET | `/api/worker/settings` | Get worker settings |
| PUT | `/api/worker/settings` | Update worker settings |

### Request/Response Details

**GET `/api/workers`**
```
Response: { workers: [{ id, name, host, port, addedAt, online, gpu,
  gpu_memory_gb, cuda_available, busy }] }
```

**POST `/api/workers`**
```
Body: { name, host, port }
Response: { worker: { id, name, host, port, addedAt } }
```

**GET `/api/worker/python-check?refresh=1`**
```
Response: { pythonAvailable, pythonVersion, modelsAvailable, gpuAvailable, ... }
```

**GET `/api/worker/status`**
```
Response: { running, port?, uptime?, startedAt?, health?, online?, job? }
```

**GET `/api/worker/logs?lines=50`**
```
Response: { logs: string[], running }
```

**PUT `/api/worker/settings`**
```
Body: { autoStart?, port?, wooburyModelsPath? }
Response: { success, settings }
```

---

## 15. Inference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/inference/status` | Check inference server status |

### Request/Response Details

**GET `/api/inference/status`**
```
Response: { running, model, port }
```

---

## 16. Social

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/social/posts` | List posts with optional filters |
| POST | `/api/social/posts` | Create a new post |
| GET | `/api/social/posts/:id` | Get a single post |
| PUT | `/api/social/posts/:id` | Update a post |
| DELETE | `/api/social/posts/:id` | Delete a post and its media |
| GET | `/api/social/stats` | Get post status counts |
| GET | `/api/social/today` | Get posts scheduled for today |
| GET | `/api/social/due` | Get posts due for posting now |
| GET | `/api/social/config` | Get scheduler configuration |
| PUT | `/api/social/config` | Update scheduler configuration |
| GET | `/api/social/platforms` | List platform connectors |
| POST | `/api/social/platforms` | Create a new platform connector |
| PUT | `/api/social/platforms/:platform` | Update a platform connector |
| DELETE | `/api/social/platforms/:platform` | Delete a platform connector |
| GET | `/api/social/platforms/:platform/script` | Get platform posting script |
| PUT | `/api/social/platforms/:platform/script` | Save platform posting script |
| GET | `/api/social/scripts` | List platform scripts with metadata |
| POST | `/api/social/generate` | AI text generation (stub, delegates to agent) |

### Request/Response Details

**GET `/api/social/posts?status=...&platform=...&from=...&to=...&tag=...`**
```
Response: [{ id, content, platform, status, scheduledAt, ... }]
```

**POST `/api/social/posts`**
```
Body: { content, platform, scheduledAt, tags, ... }
Response: { id, content, platform, ... }  (201 Created)
```

**POST `/api/social/platforms`**
```
Body: { platform: "instagram", enabled?: true, ... }
Response: connector object  (201 Created)
```

**POST `/api/social/generate`**
```
Body: { prompt, tone?: "professional", platforms?: [] }
Response: { text, note }
```

---

## 17. Chat

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | Send a message to the AI agent (SSE stream) |
| GET | `/api/chat/sessions` | List all saved chat sessions |
| GET | `/api/chat/sessions/:id` | Load a specific chat session |
| PUT | `/api/chat/sessions/:id` | Save/update a chat session |
| DELETE | `/api/chat/sessions/:id` | Delete a chat session |
| GET | `/api/chat/logs` | List available log days with entry counts |
| GET | `/api/chat/logs/:date` | Get all log entries for a specific day (YYYY-MM-DD) |

### Request/Response Details

**POST `/api/chat`**
Returns an SSE (Server-Sent Events) stream, not JSON.

For the full event contract and client expectations, see [chat-api-and-sse-contract.md](chat-api-and-sse-contract.md).
```
Body: { message, history?: [{ role, content }], activeCompositionId?, sessionId? }
Events: session_context, token, tool_start, tool_end, phase, task_start, task_end,
  verification, belief_update, reflection, skill_selection, recovery,
  composition_updated, done, error
```

Notes:

- Chat requests are session-aware. `sessionId` is used to resume the same closure-engine session across turns.
- Older conversation history is compressed into a rolling summary plus recent turns before being sent to the agent.
- `session_context` is emitted first and includes the rolling summary metadata used for the current request.
- `skill_selection` and `recovery` are first-class events intended for the dashboard workspace panel.

**GET `/api/chat/sessions`**
```
Response: { sessions: [{ id, title, messageCount, createdAt, updatedAt }] }
```

Notes:

- Session records are stored under `~/.woodbury/data/chat-sessions/`.

**PUT `/api/chat/sessions/:id`**
```
Body: {
  title?,
  history?,
  activeCompositionId?,
  engineSessionId?,
  taskPanelState?,
  createdAt?
}
Response: { success }
```

Notes:

- The server recomputes and persists `rollingSummary` and `summaryTurnCount` from the submitted history.
- Saved records may also contain `engineSessionId`, `rollingSummary`, `summaryTurnCount`, and `taskPanelState` when reloaded.

**GET `/api/chat/logs`**
```
Response: { days: [{ date: "2024-01-15", entries: 42 }] }
```

**GET `/api/chat/logs/:date`**
```
Response: { date, entries: [{ id, timestamp, message, toolCalls, response, durationMs, ... }] }
```

## 17.1 Skill Policy Review

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skill-policies` | List persisted skill-policy update records |
| PUT | `/api/skill-policies/:id` | Review or edit a persisted skill-policy update |

### Request/Response Details

**GET `/api/skill-policies`**
```
Query: ?reviewStatus=pending|approved|rejected&skillName=<skill>
Response: { updates: [{ id, skillName, guidance, applicabilityPattern, confidence, reviewStatus, ... }] }
```

**PUT `/api/skill-policies/:id`**
```
Body: { reviewStatus?: "pending"|"approved"|"rejected", guidance?: string,
  applicabilityPattern?: string, confidence?: number }
Response: { success: true, update }
```

---

## 18. MCP (Model Context Protocol)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/servers` | List all known MCP servers with status |
| POST | `/api/mcp/servers/:name/enable` | Enable and connect an MCP server |
| POST | `/api/mcp/servers/:name/disable` | Disable and disconnect an MCP server |
| POST | `/api/mcp/servers/:name/reconnect` | Reconnect a disconnected MCP server |
| GET | `/api/mcp/chat-provider` | Get current chat provider/model selection |
| PUT | `/api/mcp/chat-provider` | Set chat provider/model selection |

### Request/Response Details

**GET `/api/mcp/servers`**
```
Response: { servers: [{ name, displayName, description, category, enabled,
  status, toolCount, toolNames, failureReason, availability, setupGuide }] }
```

**POST `/api/mcp/servers/:name/enable`**
```
Response: { success, message }
```

**GET `/api/mcp/chat-provider`**
```
Response: { provider, model, available: [{ id, name, hasKey, defaultModel }] }
```

**PUT `/api/mcp/chat-provider`**
```
Body: { provider?: "anthropic"|"openai"|"groq"|"auto", model?: string }
Response: { success, message }
```

---

## 19. Assets

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/assets` | List all assets with optional filters |
| GET | `/api/assets/:id` | Get a single asset |
| PUT | `/api/assets/:id` | Update asset metadata |
| DELETE | `/api/assets/:id` | Delete an asset and its files |
| GET | `/api/assets/file/:id` | Serve an asset's file content (binary stream) |
| POST | `/api/assets/:id/reveal` | Show asset file in system file manager |
| GET | `/api/assets/collections` | List collections with asset counts |
| POST | `/api/assets/collections` | Create a new collection |
| PUT | `/api/assets/collections/:slug` | Update a collection |
| DELETE | `/api/assets/collections/:slug` | Delete a collection |
| GET | `/api/assets/defaults` | Get all default asset assignments |
| GET | `/api/assets/settings` | Get assets data directory settings |
| PUT | `/api/assets/settings` | Update assets data directory |
| POST | `/api/assets/import` | Import a file as a new asset |

### Request/Response Details

**GET `/api/assets?category=image&collection=my-collection&search=photo&tag=hero`**
```
Response: { assets: [{ id, name, description, file_path, file_path_absolute,
  file_type, file_size, category, tags, collections, ... }], dataDir }
```

**POST `/api/assets/collections`**
```
Body: { name, description?, tags?: [], rootPath? }
Response: { collection: { id, name, slug, description, tags, rootPath, created_at } }
```

**POST `/api/assets/import`**
```
Body: { file_path, name, description?, tags?: [], collection?, metadata?,
  reference_only?: false }
Response: { asset: { id, name, file_path, file_path_absolute, category, ... } }
```

**PUT `/api/assets/:id`**
```
Body: { name?, description?, tags?, collections?, is_default_for?, metadata? }
Response: { asset }
```

**PUT `/api/assets/settings`**
```
Body: { dataDir: "/path/to/assets" }
Response: { success, settings }
```

---

## 20. Storyboards

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/storyboards` | List all storyboards |
| POST | `/api/storyboards` | Create a storyboard from a production package |
| GET | `/api/storyboards/:id` | Get storyboard data |
| PUT | `/api/storyboards/:id` | Update storyboard (scenes, selections) |
| DELETE | `/api/storyboards/:id` | Delete storyboard and generated images |
| GET | `/api/storyboards/:id/image/*` | Serve generated or existing images |
| GET | `/api/storyboards/:id/audio/*` | Serve audio files (with Range support) |
| POST | `/api/storyboards/:id/headshot` | Upload a character headshot (multipart) |
| POST | `/api/storyboards/:id/generate` | Generate image(s) for a scene with AI |
| POST | `/api/storyboards/:id/frame-to-video` | Convert scene images to video via workflow |
| POST | `/api/storyboards/:id/save-to-collection` | Import storyboard media as assets |
| GET | `/api/storyboards/scan-packages` | Scan collection for production package JSONs |

### Request/Response Details

**POST `/api/storyboards`**
```
Body: { productionPackagePath, collectionSlug, name? }
Response: { storyboard }
```

**PUT `/api/storyboards/:id`**
```
Body: { scenes?, audioSelections?, characterReferences?, status?, name? }
Response: { storyboard }
```

**POST `/api/storyboards/:id/generate`**
```
Body: { sceneNumber, count?: 1, promptOverride?, model?: "flash", aspectRatio?: "16:9" }
Response: { generated: [{ id, filePath, generatedAt, refsUsed, model }], scene }
```

**POST `/api/storyboards/:id/frame-to-video`**
```
Body: { sceneNumbers: number[], promptOverride? }
Response: { started, sceneCount }
(Progress available via GET /api/workflows/run/status)
```

**POST `/api/storyboards/:id/save-to-collection`**
```
Body: { collection: "slug", items: [{ type: "image"|"video"|"assembled_video", sceneIndex? }] }
Response: { imported: [...], errors: [...] }
```

**GET `/api/storyboards/scan-packages?collectionSlug=xxx`**
```
Response: { packages: [{ name, path, size, modified, scenesFound }], collectionRoot }
```

---

## 21. Generation (AI)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/autofill` | AI-powered variable value generation for workflows |
| POST | `/api/generate-variable` | AI generation for a single variable using a custom prompt |
| POST | `/api/compositions/generate-script` | AI code generation for pipeline script nodes |
| POST | `/api/compositions/generate-pipeline` | AI pipeline decomposition from a description |

### Request/Response Details

**POST `/api/autofill`**
```
Body: { variables: [{ name, type, description, default?, generationPrompt? }],
  workflowName?, site?, steps? }
Response: { success, values: { variable_name: "generated value", ... } }
```

**POST `/api/generate-variable`**
```
Body: { variableName, generationPrompt, workflowName?, site?, variableType? }
Response: { success, value: "generated raw value" }
```

**POST `/api/compositions/generate-script`**
```
Body: { description?, chatHistory?: [{ role, content }], currentCode?, dataContext? }
Response: { success, code, inputs, outputs, assistantMessage }
```

**POST `/api/compositions/generate-pipeline`**
```
Body: { description }
Response: { success, pipeline: { name, nodes, connections } }
```

---

## 22. Tools

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tools` | List available extension tools with schemas |
| GET | `/api/script-tool-docs` | List all tool docs (auto-generated + custom) |
| PUT | `/api/script-tool-docs` | Bulk save custom docs for all tools |

### Request/Response Details

**GET `/api/tools`**
```
Response: { tools: [{ name, description, parameters, dangerous }] }
```

**GET `/api/script-tool-docs`**
```
Response: { tools: [{ name, description, signature, parameters, dangerous,
  customDescription, examples, notes, returns, enabled }] }
```

**PUT `/api/script-tool-docs`**
```
Body: { tools: [{ toolName, customDescription?, examples?, notes?, returns?, enabled? }] }
Response: { success }
```

---

## 23. Bridge Actions

These endpoints interact directly with the Chrome extension bridge for browser automation.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bridge/screenshot` | Capture viewport screenshot |
| POST | `/api/click-extension-icon` | Click the Woodbury extension icon in Chrome |

_(Also aliased as `/api/simulate-keystroke`)_

See [App & Bridge](#1-app--bridge) for full details.
