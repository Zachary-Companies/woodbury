/**
 * Workflow Recorder
 *
 * Captures live browser interactions from the Chrome extension and
 * converts them into a WorkflowDocument (.workflow.json).
 *
 * Usage:
 *   const recorder = new WorkflowRecorder((step, i) => console.log(step));
 *   await recorder.start('create-song', 'suno.com');
 *   // ... user interacts with Chrome ...
 *   const { workflow, filePath } = await recorder.stop(workingDir);
 */

import { promises as fs, appendFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { focusAndMaximizeChrome } from '../browser-utils.js';
import { homedir } from 'os';
import { bridgeServer, ensureBridgeServer } from '../bridge-server.js';
import { execSync, spawn, fork, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import type {
  WorkflowDocument,
  WorkflowStep,
  VariableDeclaration,
  ElementTarget,
  WaitCondition,
  NavigateStep,
  ClickStep,
  TypeStep,
  WaitStep,
  KeyboardStep,
  KeyboardNavStep,
  KeyboardNavAction,
  RecordingEvent,
  DesktopLaunchAppStep,
  DesktopClickStep,
  DesktopTypeStep,
  DesktopKeyboardStep,
  FileDialogStep,
} from './types.js';

// ── Recording debug log ─────────────────────────────────────
// Writes to ~/.woodbury/logs/recording.log so we can diagnose failures.

const RECORDING_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const RECORDING_LOG_PATH = join(RECORDING_LOG_DIR, 'recording.log');

function recLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(RECORDING_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] ${msg}`;
    if (data !== undefined) {
      try {
        line += ' ' + JSON.stringify(data);
      } catch {
        line += ' [unserializable]';
      }
    }
    appendFileSync(RECORDING_LOG_PATH, line + '\n');
  } catch {
    // Never let logging break recording
  }
}

// ── Types ────────────────────────────────────────────────────

interface PendingInput {
  target: ElementTarget;
  selector: string;       // For fast comparison
  lastValue: string;
  firstTimestamp: number;
}

/** Tracks consecutive keyboard navigation events for collapsing into a single keyboard_nav step */
interface PendingKeyboardNav {
  /** Accumulated actions so far (different key = new action entry) */
  actions: Array<{
    key: string;
    count: number;
    lastFocusedElement?: RecordingEvent['focusedElement'];
  }>;
  firstTimestamp: number;
}

/** Info about a detected CSS spinner / loading animation */
interface SpinnerInfo {
  /** CSS selector for the spinner element */
  selector: string;
  /** How the spinner was detected (e.g., 'animation:spin', 'class:loader', 'aria-busy') */
  detectionMethod: string;
  /** Text content near the spinner (for labeling) */
  nearbyText?: string;
  /** Element tag name */
  tag: string;
  /** aria-label if present */
  ariaLabel?: string;
  /** CSS classes on the element */
  classes?: string;
}

/** Snapshot of visible page state at a point in time */
interface PageSnapshot {
  /** Visible button/link text labels on the page */
  clickableLabels: string[];
  /** Short text snippets that may be status indicators */
  statusTexts: string[];
  /** Total length of visible page text (for gross change detection) */
  textLength: number;
  /** Page URL at snapshot time */
  url: string;
  /** Timestamp when snapshot was taken */
  timestamp: number;
  /** Detected CSS spinners/loading animations on the page */
  spinners: SpinnerInfo[];
}

/** Tracks state during a long gap between user events */
interface GapTracker {
  /** Page state when the gap started */
  beforeSnapshot: PageSnapshot;
  /** Polling timer for detecting changes */
  pollTimer: ReturnType<typeof setInterval> | null;
  /** The most recent snapshot (updated by polling) */
  latestSnapshot: PageSnapshot | null;
  /** When the gap started */
  startTime: number;
}

interface RecordingSession {
  workflowName: string;
  site: string;
  steps: WorkflowStep[];
  startTime: number;
  paused: boolean;
  lastUrl: string;
  lastEventTime: number;
  stepCounter: number;
  pendingInput: PendingInput | null;
  pendingKeyboardNav: PendingKeyboardNav | null;
  eventListener: ((msg: any) => void) | null;
  /** Handler for page element snapshot events (ML training data) */
  snapshotListener: ((msg: any) => void) | null;
  /** Handler for bridge reconnection events */
  reconnectHandler: (() => void) | null;
  /** Active gap tracker for smart wait detection */
  gapTracker: GapTracker | null;
  /** Timer that fires when a gap exceeds the threshold */
  gapDetectionTimer: ReturnType<typeof setTimeout> | null;
  /** Download IDs snapshot taken at recording start (for diff at stop) */
  downloadSnapshotIds: Set<number>;
  /** When true, capture element screenshots for ML training data */
  captureElementCrops: boolean;
  /** Counter for naming snapshot files */
  snapshotCounter: number;
  /** Map of element selectors → interaction details (for ML training data) */
  interactedSelectors: Map<string, { action: string; stepIndex: number; text?: string; ariaLabel?: string; tag?: string; childSelector?: string }[]>;
  /** Whether this is a desktop (native app) recording vs browser recording */
  desktopMode: boolean;
  /** Reference to uIOhook instance (only set during desktop recording) */
  desktopHook: any | null;
  /** Timestamp of last Enter/Space keydown — used to suppress synthetic click events */
  lastActionKeyTime: number;
  /** Recording mode: 'standard' (CSS selectors) or 'accessibility' (roles/labels/SVG) */
  recordingMode: 'standard' | 'accessibility';
}

export interface RecorderStatus {
  active: boolean;
  paused: boolean;
  stepCount: number;
  durationMs: number;
  site: string;
}

export interface RecorderResult {
  workflow: WorkflowDocument;
  filePath: string;
  /** Downloads that appeared during recording (not present at start) */
  newDownloads?: Array<{ id: number; filename: string; fileSize: number }>;
}

type StepCallback = (step: WorkflowStep, index: number) => void;
type StatusCallback = (message: string) => void;

// ── Constants ────────────────────────────────────────────────

/** Time gap (ms) between events that triggers an automatic wait step */
const GAP_THRESHOLD_MS = 3000;
/** Time gap (ms) that triggers smart wait detection (page snapshot polling) */
const SMART_WAIT_THRESHOLD_MS = 5000;
/** Maximum auto-wait duration in ms for dumb delays */
const MAX_GAP_WAIT_MS = 10000;
/** How often to poll the page during a smart wait gap (ms) */
const GAP_POLL_INTERVAL_MS = 3000;
/** Tolerance for fuzzy bounds validation (pixels) */
const BOUNDS_TOLERANCE = 80;
/** Delay added after navigate steps */
const NAVIGATE_WAIT_MS = 2000;
/** How long to wait for the Chrome extension to connect */
const CONNECTION_TIMEOUT_MS = 30000;
/** Polling interval when waiting for connection */
const CONNECTION_POLL_MS = 500;
/** Min text length for a status indicator to be tracked */
const MIN_STATUS_TEXT_LENGTH = 3;
/** Max text length for a status indicator (skip long paragraphs) */
const MAX_STATUS_TEXT_LENGTH = 60;

// ── WorkflowRecorder ─────────────────────────────────────────

export class WorkflowRecorder {
  private session: RecordingSession | null = null;
  private onStepCaptured: StepCallback | null;
  private onStatus: StatusCallback | null;

  constructor(onStepCaptured?: StepCallback, onStatus?: StatusCallback) {
    this.onStepCaptured = onStepCaptured || null;
    this.onStatus = onStatus || null;
  }

  // ── Public API ───────────────────────────────────────────

  get isActive(): boolean {
    return this.session !== null;
  }

  async start(name: string, site: string, options?: { captureElementCrops?: boolean; recordingMode?: 'standard' | 'accessibility' }): Promise<void> {
    // Truncate log file at start of each recording for clean diagnosis
    try {
      mkdirSync(RECORDING_LOG_DIR, { recursive: true });
      writeFileSync(RECORDING_LOG_PATH, '');
    } catch { /* ok */ }
    recLog('INFO', '=== Recording start BEGIN ===', { name, site });

    if (this.session) {
      recLog('ERROR', 'Recording already in progress');
      throw new Error('Recording already in progress. Use /record stop first.');
    }

    // 1. Ensure bridge server is running
    recLog('INFO', 'Step 1: Ensuring bridge server is running');
    await ensureBridgeServer();
    recLog('INFO', 'Bridge server running', { port: bridgeServer.port, connected: bridgeServer.isConnected });

    // 2. If Chrome extension not connected, open Chrome and wait
    if (!bridgeServer.isConnected) {
      recLog('INFO', 'Step 2: Extension not connected, opening Chrome');
      this.status('Opening Chrome...');
      await this.openChromeWithUrl(`https://${site}`);

      this.status('Waiting for Woodbury Bridge extension to connect...');
      recLog('INFO', 'Waiting for extension connection (30s timeout)...');
      const connected = await this.waitForConnection();
      recLog('INFO', 'Connection wait result', { connected });
      if (!connected) {
        recLog('ERROR', 'Extension did not connect within timeout');
        throw new Error(
          'Chrome extension did not connect within 30 seconds.\n' +
          'Make sure the Woodbury Bridge extension is installed:\n' +
          '  1. Open chrome://extensions\n' +
          '  2. Enable Developer Mode\n' +
          '  3. Click "Load unpacked" and select the chrome-extension/ folder'
        );
      }
    } else {
      recLog('INFO', 'Step 2: Extension already connected');
    }

    // 3. Get current page info
    recLog('INFO', 'Step 3: Getting current page info');
    let currentUrl = '';
    try {
      const info = await bridgeServer.send('get_page_info') as Record<string, unknown>;
      currentUrl = (info?.url as string) || '';
      recLog('INFO', 'Got page info', { url: currentUrl });
    } catch (err) {
      recLog('WARN', 'get_page_info failed', { error: String(err) });
      // Ignore — we'll capture the URL from events
    }

    // 4. If Chrome is connected but not on the target site, open it
    const targetUrl = `https://${site}`;
    if (!currentUrl || !currentUrl.includes(site)) {
      recLog('INFO', 'Step 4: Navigating to target site', { targetUrl, currentUrl });
      this.status(`Navigating to ${targetUrl}...`);
      await this.openChromeWithUrl(targetUrl);
      await this.delay(3000);
      // Re-fetch current URL after navigation
      try {
        const info = await bridgeServer.send('get_page_info') as Record<string, unknown>;
        currentUrl = (info?.url as string) || targetUrl;
        recLog('INFO', 'Post-navigation page info', { url: currentUrl });
      } catch (err) {
        recLog('WARN', 'Post-navigation get_page_info failed', { error: String(err) });
        currentUrl = targetUrl;
      }
    } else {
      recLog('INFO', 'Step 4: Already on target site', { currentUrl });
    }

    // 5. Start recording in the Chrome extension (retry a few times since
    //    the content script might not be ready yet after navigation)
    recLog('INFO', 'Step 5: Enabling recording mode in Chrome extension');
    this.status('Starting recording...');
    await this.enableRecordingWithRetry(3);
    recLog('INFO', 'Recording mode enabled successfully');

    // 5b. Snapshot current downloads for diff at stop
    let downloadSnapshotIds = new Set<number>();
    try {
      recLog('INFO', 'Step 5b: Snapshotting current downloads');
      const dlResult = await bridgeServer.send('get_downloads', { limit: 200, state: 'complete' }) as any;
      const downloads: any[] = dlResult?.downloads || [];
      for (const dl of downloads) {
        if (typeof dl.id === 'number') downloadSnapshotIds.add(dl.id);
      }
      recLog('INFO', `Download snapshot: ${downloadSnapshotIds.size} existing downloads`);
    } catch (err) {
      recLog('WARN', 'Download snapshot failed (downloads permission may not be available)', { error: String(err) });
      // Non-fatal — just won't detect downloads at stop
    }

    // 6. Create session
    recLog('INFO', 'Step 6: Creating recording session');
    this.session = {
      workflowName: name,
      site,
      steps: [],
      startTime: Date.now(),
      paused: false,
      lastUrl: currentUrl || targetUrl,
      lastEventTime: Date.now(),
      stepCounter: 0,
      pendingInput: null,
      pendingKeyboardNav: null,
      eventListener: null,
      snapshotListener: null,
      reconnectHandler: null,
      gapTracker: null,
      gapDetectionTimer: null,
      downloadSnapshotIds,
      captureElementCrops: options?.captureElementCrops ?? (process.env.WOODBURY_CAPTURE_CROPS !== '0'),
      snapshotCounter: 0,
      interactedSelectors: new Map(),
      desktopMode: false,
      desktopHook: null,
      lastActionKeyTime: 0,
      recordingMode: options?.recordingMode || 'standard',
    };

    // 7. Add initial navigate step
    const navStep = this.createNavigateStep(targetUrl);
    this.addStep(navStep);

    // 8. Listen for recording events
    recLog('INFO', 'Step 8: Attaching recording event listener');
    const handler = (msg: any) => {
      try {
        recLog('EVENT', 'recording_event received', {
          event: msg?.event,
          element: msg?.element?.tag,
          text: msg?.element?.textContent?.slice(0, 50),
          url: msg?.page?.url,
        });
        this.handleRecordingEvent(msg);
      } catch (err) {
        // Never let an event handler error kill the recording session
        recLog('ERROR', 'Event handler threw', { error: String(err), stack: (err as Error)?.stack });
        this.status(`⚠ Event processing error: ${err}`);
      }
    };
    this.session.eventListener = handler;
    bridgeServer.on('recording_event', handler);

    // 8b. Listen for page element snapshots (ML training data)
    if (this.session.captureElementCrops) {
      const snapshotHandler = (msg: any) => {
        this.handlePageSnapshot(msg).catch((err) => {
          recLog('WARN', 'snapshot-capture: handler error', { error: String(err) });
        });
      };
      this.session.snapshotListener = snapshotHandler;
      bridgeServer.on('page_elements_snapshot', snapshotHandler);
      recLog('INFO', 'Element snapshot capture enabled (page_elements_snapshot)');
    }

    // 9. Listen for bridge reconnection — re-enable recording mode
    //    if the WebSocket drops and reconnects during a recording session.
    const reconnectHandler = async () => {
      if (!this.session) return;
      recLog('INFO', 'Bridge reconnected during recording — re-enabling');
      this.status('🔄 Bridge reconnected — re-enabling recording...');
      await this.delay(1000); // Give content script time to load
      try {
        await this.enableRecordingWithRetry(3);
        recLog('INFO', 'Recording re-enabled after reconnection');
        this.status('✅ Recording re-enabled after reconnection');
      } catch (err) {
        recLog('ERROR', 'Failed to re-enable recording after reconnect', { error: String(err) });
        this.status('⚠ Could not re-enable recording after reconnect');
      }
    };
    this.session.reconnectHandler = reconnectHandler;
    bridgeServer.on('connected', reconnectHandler);

    recLog('INFO', '=== Recording start COMPLETE ===', { steps: this.session.steps.length });
  }

  async stop(workingDirectory: string): Promise<RecorderResult> {
    recLog('INFO', '=== Recording stop BEGIN ===', {
      hasSession: !!this.session,
      stepCount: this.session?.steps?.length,
    });

    if (!this.session) {
      recLog('ERROR', 'stop() called but no session');
      throw new Error('No recording in progress.');
    }

    // Flush any pending input/nav and cancel gap tracking
    this.flushPendingInput();
    this.flushPendingKeyboardNav();
    this.cancelGapTracking();

    // Desktop mode: kill the hook child process
    if (this.session.desktopMode && this.session.desktopHook) {
      const hookChild = this.session.desktopHook as ChildProcess;
      hookChild.removeAllListeners();
      try {
        hookChild.kill('SIGKILL');
        recLog('INFO', 'Desktop hook process killed');
      } catch (err) {
        recLog('WARN', 'Failed to kill desktop hook process (non-fatal)', { error: String(err) });
      }
      this.session.desktopHook = null;
    }

    // Browser mode: stop recording in Chrome extension
    if (!this.session.desktopMode) {
      try {
        await bridgeServer.setRecordingMode(false);
        recLog('INFO', 'Recording mode disabled in Chrome');
      } catch (err) {
        recLog('WARN', 'Failed to disable recording mode', { error: String(err) });
        // Extension might have disconnected — that's ok
      }
    }

    // Remove event listeners (browser mode only)
    if (this.session.eventListener) {
      bridgeServer.removeListener('recording_event', this.session.eventListener);
    }
    if (this.session.snapshotListener) {
      bridgeServer.removeListener('page_elements_snapshot', this.session.snapshotListener);
    }
    if (this.session.reconnectHandler) {
      bridgeServer.removeListener('connected', this.session.reconnectHandler);
    }

    // Write interacted selectors to metadata
    if (this.session.captureElementCrops && this.session.interactedSelectors.size > 0) {
      try {
        await this.saveInteractedSelectors();
      } catch (err) {
        recLog('WARN', 'Failed to save interacted selectors', { error: String(err) });
      }
    }

    // Post-process: collapse typo correction sequences
    this.status('Cleaning up recording...');
    this.session.steps = this.collapseTypoSequences(this.session.steps);

    // Post-process: strip synthetic clicks that follow keyboard_nav Enter/Space
    this.session.steps = this.stripSyntheticClicks(this.session.steps);

    // Post-process: upgrade remaining dumb delays to smart waits where possible
    this.session.steps = this.upgradeDumbDelays(this.session.steps);

    // Post-process: detect variables and parameterize
    const { steps, variables } = this.detectVariables(this.session.steps);
    this.session.steps = steps;

    // Detect new downloads by diffing against snapshot (browser mode only)
    let newDownloads: Array<{ id: number; filename: string; fileSize: number }> = [];
    if (!this.session.desktopMode) {
      try {
        recLog('INFO', 'Checking for new downloads since recording started');
        const dlResult = await bridgeServer.send('get_downloads', { limit: 200, state: 'complete' }) as any;
        const downloads: any[] = dlResult?.downloads || [];
        for (const dl of downloads) {
          if (typeof dl.id === 'number' && !this.session.downloadSnapshotIds.has(dl.id)) {
            newDownloads.push({
              id: dl.id,
              filename: dl.filename || '',
              fileSize: dl.fileSize || 0,
            });
          }
        }
        if (newDownloads.length > 0) {
          recLog('INFO', `Detected ${newDownloads.length} new download(s)`, {
            files: newDownloads.map(d => d.filename),
          });
          this.status(`Detected ${newDownloads.length} new download(s) during recording`);
        } else {
          recLog('INFO', 'No new downloads detected');
        }
      } catch (err) {
        recLog('WARN', 'Download diff failed', { error: String(err) });
        // Non-fatal — just won't report downloads
      }
    }

    // Build workflow document
    const workflow = this.buildWorkflowDocument(variables);

    if (variables.length > 0) {
      this.status(`Detected ${variables.length} variable(s): ${variables.map(v => v.name).join(', ')}`);
    }

    // Save to file
    const dir = join(workingDirectory, '.woodbury-work', 'workflows');
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${this.session.workflowName}.workflow.json`);
    await fs.writeFile(filePath, JSON.stringify(workflow, null, 2));

    // Copy training snapshots to workflow directory (fire-and-forget)
    const sessionStartTime = this.session.startTime;
    const sessionSite = this.session.site;
    const workflowId = this.session.workflowName;
    this.copySnapshotsToWorkflowDir(workflowId, sessionSite, sessionStartTime);

    // Clear session
    this.session = null;

    const result: RecorderResult = { workflow, filePath };
    if (newDownloads.length > 0) {
      result.newDownloads = newDownloads;
    }
    return result;
  }

  pause(): void {
    if (!this.session) throw new Error('No recording in progress.');
    this.session.paused = true;
  }

  resume(): void {
    if (!this.session) throw new Error('No recording in progress.');
    this.session.paused = false;
    this.session.lastEventTime = Date.now();
  }

  async cancel(): Promise<void> {
    if (!this.session) throw new Error('No recording in progress.');

    this.cancelGapTracking();

    // Desktop mode: kill the hook child process
    if (this.session.desktopMode && this.session.desktopHook) {
      const hookChild = this.session.desktopHook as ChildProcess;
      hookChild.removeAllListeners();
      try { hookChild.kill('SIGKILL'); } catch { /* ok */ }
      this.session.desktopHook = null;
    }

    // Browser mode: stop recording in Chrome extension
    if (!this.session.desktopMode) {
      try {
        await bridgeServer.setRecordingMode(false);
      } catch {
        // Extension might have disconnected
      }
    }

    if (this.session.eventListener) {
      bridgeServer.removeListener('recording_event', this.session.eventListener);
    }
    if (this.session.snapshotListener) {
      bridgeServer.removeListener('page_elements_snapshot', this.session.snapshotListener);
    }
    if (this.session.reconnectHandler) {
      bridgeServer.removeListener('connected', this.session.reconnectHandler);
    }

    this.session = null;
  }

  getStatus(): RecorderStatus {
    if (!this.session) {
      return { active: false, paused: false, stepCount: 0, durationMs: 0, site: '' };
    }
    return {
      active: true,
      paused: this.session.paused,
      stepCount: this.session.steps.length,
      durationMs: Date.now() - this.session.startTime,
      site: this.session.site,
    };
  }

  // ── Event handling ───────────────────────────────────────

  private handleRecordingEvent(msg: any): void {
    if (!this.session || this.session.paused) return;

    const event = msg as RecordingEvent;
    if (!event.event || !event.element) return;

    const now = event.timestamp || Date.now();

    // Detect URL change → insert navigate step
    if (event.page?.url && event.page.url !== this.session.lastUrl) {
      this.flushPendingInput();
      this.flushPendingKeyboardNav();
      this.cancelGapTracking();
      const navStep = this.createNavigateStep(event.page.url);
      this.addStep(navStep);
      // Add a wait after navigation
      const waitStep = this.createWaitStep(NAVIGATE_WAIT_MS);
      this.addStep(waitStep);
      this.session.lastUrl = event.page.url;
    }

    // Detect time gap → insert smart or dumb wait step
    const gap = now - this.session.lastEventTime;
    if (gap > GAP_THRESHOLD_MS) {
      // If we have a gap tracker with snapshots, try to create a smart wait
      const smartWait = this.resolveGapAsSmartWait(event);
      if (smartWait) {
        this.addStep(smartWait);
      } else {
        // Fallback to dumb delay
        const waitMs = Math.min(gap, MAX_GAP_WAIT_MS);
        const waitStep = this.createWaitStep(waitMs);
        this.addStep(waitStep);
      }
    }

    // Cancel any active gap tracking now that an event arrived
    this.cancelGapTracking();

    this.session.lastEventTime = now;

    // Route by event type
    switch (event.event) {
      case 'click':
        this.handleClick(event);
        break;
      case 'file_dialog':
        this.handleFileDialog(event);
        break;
      case 'input':
      case 'change':
        this.handleInput(event);
        break;
      case 'keydown':
        this.handleKeydown(event);
        break;
    }

    // Start gap detection timer — if no event arrives within the
    // threshold, we'll take a page snapshot to enable smart waits
    this.startGapDetection();
  }

  // ── Smart wait / gap tracking ──────────────────────────────

  /**
   * Start a timer that fires after SMART_WAIT_THRESHOLD_MS of inactivity.
   * When it fires, we take a page snapshot so we can later detect what
   * changed during the gap (e.g., a song finished generating, a spinner
   * disappeared, a download button appeared).
   */
  private startGapDetection(): void {
    if (!this.session) return;

    // Clear any existing timer
    if (this.session.gapDetectionTimer) {
      clearTimeout(this.session.gapDetectionTimer);
      this.session.gapDetectionTimer = null;
    }

    this.session.gapDetectionTimer = setTimeout(() => {
      this.beginGapTracking();
    }, SMART_WAIT_THRESHOLD_MS);
  }

  /**
   * Called when a gap exceeds the smart wait threshold.
   * Takes a "before" snapshot and starts polling the page for changes.
   */
  private async beginGapTracking(): Promise<void> {
    if (!this.session || this.session.paused) return;

    try {
      const snapshot = await this.takePageSnapshot();
      if (!snapshot) return;

      this.session.gapTracker = {
        beforeSnapshot: snapshot,
        pollTimer: null,
        latestSnapshot: null,
        startTime: Date.now(),
      };

      if (snapshot.spinners.length > 0) {
        this.status(
          `⏳ Waiting... (detected ${snapshot.spinners.length} loading indicator(s) — monitoring for completion)`
        );
      } else {
        this.status('⏳ Waiting... (monitoring page for changes)');
      }

      // Start polling the page to detect when a change happens
      this.session.gapTracker.pollTimer = setInterval(async () => {
        await this.pollPageDuringGap();
      }, GAP_POLL_INTERVAL_MS);
    } catch {
      // Non-fatal — we'll just fall back to dumb delay
    }
  }

  /**
   * Poll the page during a gap to update the latest snapshot.
   * This lets us see the page state right before the user acts,
   * giving us the best "after" data to diff.
   */
  private async pollPageDuringGap(): Promise<void> {
    if (!this.session?.gapTracker) return;

    try {
      const snapshot = await this.takePageSnapshot();
      if (snapshot) {
        this.session.gapTracker.latestSnapshot = snapshot;
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Cancel active gap tracking (clear timers).
   */
  private cancelGapTracking(): void {
    if (!this.session) return;

    if (this.session.gapDetectionTimer) {
      clearTimeout(this.session.gapDetectionTimer);
      this.session.gapDetectionTimer = null;
    }

    if (this.session.gapTracker?.pollTimer) {
      clearInterval(this.session.gapTracker.pollTimer);
    }
    this.session.gapTracker = null;
  }

  /**
   * Take a snapshot of the current page state via the bridge.
   * Captures clickable element labels, short text snippets that
   * may be status indicators, and overall text volume.
   */
  private async takePageSnapshot(): Promise<PageSnapshot | null> {
    if (!bridgeServer.isConnected) return null;

    try {
      // Get clickable elements (buttons, links) — their labels tell us what actions are available
      const clickablesRaw = await bridgeServer.send('get_clickable_elements', {}, 5000) as any[];
      const clickableLabels: string[] = [];
      if (Array.isArray(clickablesRaw)) {
        for (const el of clickablesRaw) {
          const label = (el.text || el.textContent || el.ariaLabel || '').trim();
          if (label && label.length >= MIN_STATUS_TEXT_LENGTH && label.length <= MAX_STATUS_TEXT_LENGTH) {
            clickableLabels.push(label);
          }
        }
      }

      // Get page text for status indicators and volume
      let pageText = '';
      let statusTexts: string[] = [];
      try {
        const textResult = await bridgeServer.send('get_page_text', {}, 5000);
        pageText = typeof textResult === 'string' ? textResult : (textResult?.text || '');

        // Extract short lines that look like status indicators
        // (e.g., "Generating...", "Processing", "Loading", "50%", "Ready")
        statusTexts = this.extractStatusIndicators(pageText);
      } catch {
        // get_page_text might fail on some pages
      }

      // Get current URL
      let url = '';
      try {
        const info = await bridgeServer.send('get_page_info', {}, 5000) as Record<string, unknown>;
        url = (info?.url as string) || '';
      } catch {
        // ok
      }

      // Detect CSS spinners / loading animations
      let spinners: SpinnerInfo[] = [];
      try {
        const spinnerResult = await bridgeServer.send('detect_spinners', {}, 5000) as any;
        if (spinnerResult?.spinners && Array.isArray(spinnerResult.spinners)) {
          spinners = spinnerResult.spinners.map((s: any) => ({
            selector: s.selector || '',
            detectionMethod: s.detectionMethod || '',
            nearbyText: s.text ? String(s.text).slice(0, 60) : undefined,
            tag: s.tag || '',
            ariaLabel: s.ariaLabel || undefined,
            classes: s.classes || undefined,
          }));
        }
      } catch {
        // Non-fatal — spinner detection is best-effort
      }

      return {
        clickableLabels,
        statusTexts,
        textLength: pageText.length,
        url,
        timestamp: Date.now(),
        spinners,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract text snippets that look like status indicators from page text.
   * These are short phrases that might indicate loading/processing states.
   */
  private extractStatusIndicators(pageText: string): string[] {
    const indicators: string[] = [];
    const lines = pageText.split('\n');

    // Common loading/status patterns
    const statusPatterns = [
      /\b(loading|generating|processing|creating|rendering|compiling|building|uploading|downloading)\b/i,
      /\b(please wait|in progress|working|preparing|initializing)\b/i,
      /\b(ready|complete|done|finished|success|failed|error)\b/i,
      /\d+\s*%/,  // percentage indicators
      /\.{2,}$/,  // trailing ellipsis
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < MIN_STATUS_TEXT_LENGTH || trimmed.length > MAX_STATUS_TEXT_LENGTH) continue;

      for (const pattern of statusPatterns) {
        if (pattern.test(trimmed)) {
          indicators.push(trimmed);
          break;
        }
      }
    }

    return indicators;
  }

  /**
   * When a recording event arrives after a long gap, try to create a smart
   * wait condition based on what changed on the page during the gap.
   *
   * Returns a WaitStep with an intelligent condition, or null to fall back
   * to a dumb delay.
   */
  private resolveGapAsSmartWait(event: RecordingEvent): WaitStep | null {
    if (!this.session?.gapTracker) return null;

    const tracker = this.session.gapTracker;
    const before = tracker.beforeSnapshot;
    const after = tracker.latestSnapshot;

    // Need both snapshots to diff
    if (!after) return null;

    // Only attempt smart detection for gaps > 5s (meaningful waits)
    const gapMs = Date.now() - tracker.startTime;
    if (gapMs < SMART_WAIT_THRESHOLD_MS) return null;

    // Strategy 0: Spinners disappeared — a CSS loading animation was visible
    // at gap start but gone at gap end. This is the strongest signal for
    // "wait until loading is done" and takes priority over all other strategies.
    if (before.spinners && before.spinners.length > 0) {
      // Find spinners that were present before but are gone now
      const disappearedSpinners = before.spinners.filter(
        bs => !after.spinners.some(as => as.selector === bs.selector)
      );

      if (disappearedSpinners.length > 0) {
        // Pick the most specific spinner (prefer one with nearby text, then longest selector)
        const bestSpinner = disappearedSpinners.reduce((best, current) => {
          if (current.nearbyText && !best.nearbyText) return current;
          if (current.selector.length > best.selector.length) return current;
          return best;
        }, disappearedSpinners[0]);

        const spinnerTarget: ElementTarget = {
          selector: bestSpinner.selector,
        };
        if (bestSpinner.ariaLabel) {
          spinnerTarget.ariaLabel = bestSpinner.ariaLabel;
        }
        if (bestSpinner.classes) {
          // Add a class-based fallback selector for stability
          const classParts = bestSpinner.classes.trim().split(/\s+/).slice(0, 3);
          const classSelector = bestSpinner.tag + '.' + classParts.join('.');
          spinnerTarget.fallbackSelectors = [classSelector];
        }

        const label = bestSpinner.nearbyText
          ? `Wait for "${this.truncate(bestSpinner.nearbyText, 25)}" spinner to disappear`
          : `Wait for loading spinner to disappear`;

        const waitStep = this.createSmartWaitStep(
          { type: 'element_hidden', target: spinnerTarget },
          gapMs,
          label
        );
        this.status(
          `🧠 Smart wait: detected spinner (${bestSpinner.detectionMethod}) ` +
          `disappeared during ${Math.round(gapMs / 1000)}s gap`
        );
        return waitStep;
      }

      // Spinners still present at gap end — user continued despite spinner.
      // Still create the wait so playback can wait properly.
      if (after.spinners.length > 0) {
        const spinner = before.spinners[0];
        const spinnerTarget: ElementTarget = {
          selector: spinner.selector,
        };
        if (spinner.ariaLabel) {
          spinnerTarget.ariaLabel = spinner.ariaLabel;
        }
        if (spinner.classes) {
          const classParts = spinner.classes.trim().split(/\s+/).slice(0, 3);
          const classSelector = spinner.tag + '.' + classParts.join('.');
          spinnerTarget.fallbackSelectors = [classSelector];
        }

        const waitStep = this.createSmartWaitStep(
          { type: 'element_hidden', target: spinnerTarget },
          gapMs,
          `Wait for loading to complete (spinner still active when user continued)`
        );
        this.status(
          `🧠 Smart wait: spinner detected but still present — creating wait step anyway`
        );
        return waitStep;
      }
    }

    // Strategy 1: New clickable elements appeared (e.g., download button, play button)
    const newClickables = after.clickableLabels.filter(
      label => !before.clickableLabels.includes(label)
    );

    // The user's next action is a click — check if they clicked one of the new elements
    if (event.event === 'click' && event.element.textContent) {
      const clickedText = event.element.textContent.trim();
      const matchingNew = newClickables.find(label =>
        label.includes(clickedText) || clickedText.includes(label)
      );

      if (matchingNew) {
        // The user waited for this element to appear, then clicked it
        const waitStep = this.createSmartWaitStep(
          {
            type: 'element_visible',
            target: this.buildElementTarget(event),
          },
          gapMs,
          `Wait for "${this.truncate(clickedText, 30)}" to appear`
        );
        this.status(`🧠 Smart wait: detected user waited for "${this.truncate(clickedText, 25)}" to appear`);
        return waitStep;
      }
    }

    // Strategy 2: Status text disappeared (e.g., "Generating..." went away)
    const disappearedStatus = before.statusTexts.filter(
      text => !after.statusTexts.includes(text)
    );

    if (disappearedStatus.length > 0) {
      // Pick the most specific status indicator that disappeared
      const bestIndicator = disappearedStatus.reduce((best, current) =>
        current.length > best.length ? current : best
      , disappearedStatus[0]);

      const waitStep = this.createSmartWaitStep(
        { type: 'text_disappears', text: bestIndicator },
        gapMs,
        `Wait for "${this.truncate(bestIndicator, 30)}" to disappear`
      );
      this.status(`🧠 Smart wait: detected "${this.truncate(bestIndicator, 25)}" disappeared during gap`);
      return waitStep;
    }

    // Strategy 3: New status text appeared (e.g., "Ready", "Complete")
    const appearedStatus = after.statusTexts.filter(
      text => !before.statusTexts.includes(text)
    );

    // Look for positive completion indicators
    const completionPattern = /\b(ready|complete|done|finished|success)\b/i;
    const completionText = appearedStatus.find(text => completionPattern.test(text));

    if (completionText) {
      const waitStep = this.createSmartWaitStep(
        { type: 'text_appears', text: completionText },
        gapMs,
        `Wait for "${this.truncate(completionText, 30)}" to appear`
      );
      this.status(`🧠 Smart wait: detected "${this.truncate(completionText, 25)}" appeared during gap`);
      return waitStep;
    }

    // Strategy 4: Significant new clickable elements appeared (even if user didn't click them)
    // This catches cases like multiple new buttons appearing when content loads
    if (newClickables.length >= 2) {
      // Pick the most distinctive new element
      const distinctive = newClickables.reduce((best, current) =>
        current.length > best.length ? current : best
      , newClickables[0]);

      const waitStep = this.createSmartWaitStep(
        {
          type: 'text_appears',
          text: distinctive,
        },
        gapMs,
        `Wait for "${this.truncate(distinctive, 30)}" to appear on page`
      );
      this.status(`🧠 Smart wait: detected ${newClickables.length} new elements appeared during gap`);
      return waitStep;
    }

    // Strategy 5: Page text volume changed significantly (content loaded)
    const textGrowth = after.textLength - before.textLength;
    if (textGrowth > 200) {
      // Content was added — but we don't have a specific element to wait for.
      // Fall back to network_idle which is a reasonable proxy for "content finished loading"
      const waitStep = this.createSmartWaitStep(
        { type: 'network_idle', timeoutMs: Math.min(gapMs + 5000, 60000) },
        gapMs,
        `Wait for page content to finish loading`
      );
      this.status(`🧠 Smart wait: detected significant page content change (${textGrowth} chars added)`);
      return waitStep;
    }

    // No smart detection possible — return null to fall back to dumb delay
    return null;
  }

  /**
   * Create a WaitStep with a smart condition plus a generous timeout.
   * The timeout is based on how long the gap actually was (with padding),
   * so the workflow won't time out on slower runs.
   */
  private createSmartWaitStep(
    condition: WaitCondition,
    observedGapMs: number,
    label: string
  ): WaitStep {
    // element_hidden waits (spinner disappearance) get a more generous max timeout
    // because loading operations like song generation can take several minutes
    const maxTimeout = condition.type === 'element_hidden' ? 300000 : 120000;
    return {
      id: this.nextStepId('wait', ''),
      label,
      type: 'wait',
      condition,
      // Set timeout to 2x the observed gap (with min 15s/30s, max 120s/300s)
      // so the workflow has generous time for slower environments
      timeoutMs: Math.max(
        condition.type === 'element_hidden' ? 30000 : 15000,
        Math.min(observedGapMs * 2, maxTimeout)
      ),
    };
  }

  private handleClick(event: RecordingEvent): void {
    this.flushPendingInput();

    // Suppress synthetic clicks triggered by Enter/Space keypress on focused elements.
    // When the user presses Enter on a button, the browser fires both a keydown AND a
    // click event. We already captured the keydown as a keyboard_nav action, so skip
    // the redundant click if it arrives within 500ms of the Enter/Space keydown.
    const timeSinceActionKey = Date.now() - (this.session?.lastActionKeyTime || 0);
    if (timeSinceActionKey < 500) {
      recLog('INFO', 'Suppressing synthetic click (arrived ' + timeSinceActionKey + 'ms after Enter/Space keydown)');
      this.flushPendingKeyboardNav();
      return;
    }

    this.flushPendingKeyboardNav();

    const isA11yMode = this.session?.recordingMode === 'accessibility';
    const step: ClickStep = {
      id: this.nextStepId('click', event.element.tag),
      label: `Click ${this.describeElement(event)}`,
      type: 'click',
      target: isA11yMode ? this.buildAccessibilityTarget(event) : this.buildElementTarget(event),
      delayAfterMs: 1000,
    };

    this.addStep(step);

    // Capture reference crop for visual verification (fire-and-forget)
    this.captureReferenceCrop(step, event.element.bounds);

    // Track interacted element selectors for ML training data
    if (this.session?.captureElementCrops && event.element.selector) {
      const selector = event.element.selector;
      const interaction = {
        action: 'click',
        stepIndex: this.session.steps.length - 1,
        text: event.element.textContent?.slice(0, 200),
        ariaLabel: event.element.ariaLabel,
        tag: event.element.tag,
      };
      const existing = this.session.interactedSelectors.get(selector);
      if (existing) {
        existing.push(interaction);
      } else {
        this.session.interactedSelectors.set(selector, [interaction]);
      }

      // Also track the interactive ancestor selector (button/a/input that contains the click target)
      // This matches how snapshotInteractiveElements captures elements — by the interactive parent,
      // not the child span/svg/path that actually received the click.
      const ancestorSel = (event.element as any).interactiveAncestorSelector;
      if (ancestorSel && ancestorSel !== selector) {
        const ancestorExisting = this.session.interactedSelectors.get(ancestorSel);
        if (ancestorExisting) {
          ancestorExisting.push({ ...interaction, childSelector: selector });
        } else {
          this.session.interactedSelectors.set(ancestorSel, [{ ...interaction, childSelector: selector }]);
        }
      }
    }
  }

  /**
   * Handle a click on a file input — creates a FileDialogStep instead of a ClickStep.
   * The trigger stores the element target so the executor can click it to open
   * the OS file dialog, then navigate to the specified filePath.
   */
  private handleFileDialog(event: RecordingEvent): void {
    this.flushPendingInput();
    this.flushPendingKeyboardNav();

    const isA11yMode = this.session?.recordingMode === 'accessibility';
    const trigger = isA11yMode ? this.buildAccessibilityTarget(event) : this.buildElementTarget(event);

    const step: FileDialogStep = {
      id: this.nextStepId('file-dialog', event.element.tag),
      label: `File dialog: select file`,
      type: 'file_dialog',
      filePath: '{{filePath}}',
      trigger,
      delayBeforeMs: 2000,
      delayAfterMs: 1000,
    };

    this.addStep(step);
    recLog('INFO', 'Created file_dialog step for file input click', { selector: event.element.selector });
  }

  // ── Snapshot copy for per-workflow training ──────────────

  /**
   * Copy training snapshots captured during this recording session to the
   * workflow's own directory. This makes training data self-contained per workflow.
   * Runs in background — never blocks the recording stop flow.
   */
  private copySnapshotsToWorkflowDir(workflowId: string, site: string, sessionStartTime: number): void {
    (async () => {
      try {
        const siteDir = site.replace(/[^a-zA-Z0-9.-]/g, '_');
        const srcDir = join(homedir(), '.woodbury', 'data', 'training-crops', 'snapshots', siteDir);
        const dstDir = join(homedir(), '.woodbury', 'data', 'workflows', workflowId, 'snapshots');

        // Check if source directory exists
        try {
          await fs.access(srcDir);
        } catch {
          recLog('INFO', 'copySnapshots: no snapshots directory found, skipping', { srcDir });
          return;
        }

        await fs.mkdir(dstDir, { recursive: true });

        // List all files in the snapshots source directory
        const files = await fs.readdir(srcDir);
        let copied = 0;

        for (const file of files) {
          const srcPath = join(srcDir, file);
          const stat = await fs.stat(srcPath);

          // Only copy files created during this recording session
          if (stat.mtimeMs >= sessionStartTime) {
            const dstPath = join(dstDir, file);
            await fs.copyFile(srcPath, dstPath);
            copied++;
          }
        }

        recLog('INFO', 'copySnapshots: copied training snapshots to workflow dir', {
          workflowId,
          copied,
          total: files.length,
          dstDir,
        });
      } catch (err) {
        recLog('WARN', 'copySnapshots: failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // ── Reference crop capture for visual verification ──────

  /**
   * Capture a reference crop of the element at the given bounds.
   * Fires in the background — never blocks the recording flow.
   * Saves the crop to ~/.woodbury/data/workflows/{workflowName}/refs/{stepId}.png
   * and sets step.target.referenceImage to the saved path.
   */
  private captureReferenceCrop(step: ClickStep | TypeStep, bounds: RecordingEvent['element']['bounds']): void {
    if (!this.session) return;
    if (!bounds || bounds.width < 4 || bounds.height < 4) return;
    if (bounds.left < 0 || bounds.top < 0) return;

    const workflowName = this.session.workflowName;
    const stepId = step.id;

    // Fire and forget — capture in background
    (async () => {
      try {
        // Capture viewport and crop the element region using the extension's OffscreenCanvas
        const result = await bridgeServer.send('capture_viewport', {
          crop: {
            left: Math.round(bounds.left),
            top: Math.round(bounds.top),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          },
        }) as Record<string, unknown>;

        const data = result?.data as Record<string, unknown> | undefined;
        const image = (data?.image || result?.image) as string | undefined;
        if (!image) {
          recLog('WARN', 'captureReferenceCrop: no image returned', { stepId });
          return;
        }

        // Save the cropped image
        const refsDir = join(homedir(), '.woodbury', 'data', 'workflows', workflowName, 'refs');
        mkdirSync(refsDir, { recursive: true });
        const cropPath = join(refsDir, `${stepId}.png`);

        // Decode base64 data URL and save as PNG
        const base64Data = image.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(cropPath, buffer);

        // Set the reference image path on the step's target
        step.target.referenceImage = cropPath;

        recLog('INFO', 'captureReferenceCrop: saved', {
          stepId,
          path: cropPath,
          size: buffer.length,
          bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
        });
      } catch (err) {
        recLog('WARN', 'captureReferenceCrop: failed (non-fatal)', {
          stepId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // ── Page Snapshot Capture (ML Training Data) ────────────────
  //
  // Instead of per-click captures, we take full-page viewport screenshots
  // and store metadata for ALL visible interactive elements. The raw
  // screenshots + element bounds are saved; cropping happens later during
  // training data preparation. This is more efficient and guarantees
  // pre-interaction state for all elements.

  /**
   * Handle a page_elements_snapshot from the Chrome extension.
   * Saves a full desktop screenshot, the viewport PNG, and element metadata JSON.
   *
   * The desktop screenshot captures the entire screen (for future desktop app support).
   * The viewport image from Chrome + element bounds are used for browser-based cropping.
   */
  private async handlePageSnapshot(msg: any): Promise<void> {
    if (!this.session?.captureElementCrops) return;

    try {
      const { viewportImage, snapshot, timestamp } = msg;
      if (!viewportImage || !snapshot?.elements?.length) {
        recLog('WARN', 'snapshot-capture: missing viewportImage or elements');
        return;
      }

      const siteId = this.session.site || 'unknown';
      const snapshotIdx = this.session.snapshotCounter++;
      const cropRoot = join(homedir(), '.woodbury', 'data', 'training-crops');
      const snapshotsDir = join(cropRoot, 'snapshots', siteId.replace(/[^a-zA-Z0-9.-]/g, '_'));
      mkdirSync(snapshotsDir, { recursive: true });

      const ts = timestamp || Date.now();
      const baseName = `snapshot_${String(snapshotIdx).padStart(4, '0')}_${ts}`;

      // 1. Save viewport PNG (from Chrome captureVisibleTab)
      const base64Data = viewportImage.replace(/^data:image\/png;base64,/, '');
      const viewportPath = join(snapshotsDir, `${baseName}_viewport.png`);
      writeFileSync(viewportPath, Buffer.from(base64Data, 'base64'));

      // 2. Capture and save full desktop screenshot
      let desktopFile: string | null = null;
      try {
        const mod = await import('flow-frame-core/dist/inference/capturescreenshot.js');
        const desktopDataUrl: string = await mod.captureScreenshotBase64(undefined);
        const desktopBase64 = desktopDataUrl.replace(/^data:image\/png;base64,/, '');
        const desktopPath = join(snapshotsDir, `${baseName}_desktop.png`);
        writeFileSync(desktopPath, Buffer.from(desktopBase64, 'base64'));
        desktopFile = `${baseName}_desktop.png`;
      } catch (err) {
        recLog('WARN', 'snapshot-capture: desktop screenshot failed (continuing with viewport only)', { error: String(err) });
      }

      // 3. Save element metadata JSON
      const metaPath = join(snapshotsDir, `${baseName}.json`);
      const metadata = {
        site_id: siteId,
        page_url: snapshot.url,
        page_title: snapshot.title,
        viewport_width: snapshot.viewportWidth,
        viewport_height: snapshot.viewportHeight,
        timestamp: ts / 1000,
        viewport_image: `${baseName}_viewport.png`,
        desktop_image: desktopFile,
        elements: snapshot.elements.map((el: any) => ({
          selector: el.selector || '',
          tag: el.tag || '',
          text: (el.text || '').slice(0, 200),
          aria_label: el.ariaLabel || '',
          role: el.role || '',
          type: el.type || '',
          bounds: el.bounds,
        })),
      };
      writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

      recLog('INFO', `snapshot-capture: saved snapshot #${snapshotIdx}`, {
        elements: snapshot.elements.length,
        url: snapshot.url?.slice(0, 60),
        desktop: !!desktopFile,
      });

    } catch (err) {
      recLog('WARN', 'snapshot-capture: failed', { error: String(err) });
    }
  }

  /**
   * Save a summary of which elements were interacted with during the recording.
   * This is written at recording stop time so the training pipeline knows
   * which elements are "positives" (interacted) vs "negatives" (not interacted).
   */
  private async saveInteractedSelectors(): Promise<void> {
    if (!this.session) return;

    const siteId = this.session.site || 'unknown';
    const cropRoot = join(homedir(), '.woodbury', 'data', 'training-crops');
    const snapshotsDir = join(cropRoot, 'snapshots', siteId.replace(/[^a-zA-Z0-9.-]/g, '_'));
    mkdirSync(snapshotsDir, { recursive: true });

    const summaryPath = join(snapshotsDir, `interactions_${Date.now()}.json`);

    // Convert Map to a structured object: selector → list of interactions with step details
    const interactedElements: Record<string, any> = {};
    for (const [selector, interactions] of this.session.interactedSelectors) {
      interactedElements[selector] = interactions;
    }

    const summary = {
      site_id: siteId,
      recording_name: this.session.workflowName,
      timestamp: Date.now() / 1000,
      total_steps: this.session.steps.length,
      // Flat list for backward compatibility with prepare.py
      interacted_selectors: [...this.session.interactedSelectors.keys()],
      // Rich interaction details: selector → [{action, stepIndex, text, ariaLabel, tag}]
      interacted_elements: interactedElements,
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    recLog('INFO', 'snapshot-capture: saved interaction summary', {
      interacted: this.session.interactedSelectors.size,
      path: summaryPath,
    });
  }

  private handleInput(event: RecordingEvent): void {
    const selector = event.element.selector;
    const value = event.element.value || '';

    // Track interacted element selectors for ML training data
    if (this.session?.captureElementCrops && selector) {
      const interaction = {
        action: 'input',
        stepIndex: this.session.steps.length,
        text: event.element.textContent?.slice(0, 200),
        ariaLabel: event.element.ariaLabel,
        tag: event.element.tag,
      };
      const existing = this.session.interactedSelectors.get(selector);
      if (existing) {
        existing.push(interaction);
      } else {
        this.session.interactedSelectors.set(selector, [interaction]);
      }
    }

    // Coalesce: same element → update pending value
    if (this.session!.pendingInput && this.session!.pendingInput.selector === selector) {
      this.session!.pendingInput.lastValue = value;
      return;
    }

    // Different element → flush previous, start new buffer
    this.flushPendingInput();
    this.flushPendingKeyboardNav();

    const isA11yMode = this.session?.recordingMode === 'accessibility';
    this.session!.pendingInput = {
      target: isA11yMode ? this.buildAccessibilityTarget(event) : this.buildElementTarget(event),
      selector,
      lastValue: value,
      firstTimestamp: event.timestamp || Date.now(),
    };
  }

  private handleKeydown(event: RecordingEvent): void {
    if (!event.keyboard) return;

    this.flushPendingInput();

    const key = event.keyboard.key;
    const mods = (event.keyboard.modifiers || []).map(m => m.toLowerCase());
    const hasShift = mods.includes('shift');
    const hasCtrl = mods.includes('ctrl');
    const hasAlt = mods.includes('alt');
    const hasCmd = mods.includes('cmd') || mods.includes('meta');

    // Map navigation/action keys to keyboard_nav action names
    const navActionMap: Record<string, string> = {
      'Tab': hasShift ? 'shift_tab' : 'tab',
      'ArrowUp': 'arrow_up',
      'ArrowDown': 'arrow_down',
      'ArrowLeft': 'arrow_left',
      'ArrowRight': 'arrow_right',
      'Enter': 'enter',
      'Space': 'space',
      'Escape': 'escape',
    };

    const navAction = navActionMap[key];

    // Only collapse into keyboard_nav if no Ctrl/Alt/Cmd modifiers
    // (Shift is OK since Shift+Tab is a recognized nav action)
    if (navAction && !hasCtrl && !hasAlt && !hasCmd) {
      // Track Enter/Space timestamps so handleClick() can suppress synthetic clicks
      if (key === 'Enter' || key === 'Space' || key === ' ') {
        this.session!.lastActionKeyTime = Date.now();
      }

      // This is a navigation/action key — accumulate into pending keyboard_nav
      const pending = this.session!.pendingKeyboardNav;

      if (pending) {
        const lastAction = pending.actions[pending.actions.length - 1];
        if (lastAction && lastAction.key === navAction) {
          // Same key as last action: increment count, update focus
          lastAction.count++;
          lastAction.lastFocusedElement = event.focusedElement;
        } else {
          // Different key: add a new action entry
          pending.actions.push({
            key: navAction,
            count: 1,
            lastFocusedElement: event.focusedElement,
          });
        }
      } else {
        // First nav key: start new pending
        this.session!.pendingKeyboardNav = {
          actions: [{
            key: navAction,
            count: 1,
            lastFocusedElement: event.focusedElement,
          }],
          firstTimestamp: event.timestamp || Date.now(),
        };
      }
      return;
    }

    // Non-navigation keyboard event — flush any pending nav, then emit keyboard step
    this.flushPendingKeyboardNav();

    const modifiers = mods
      .filter(m => ['ctrl', 'shift', 'alt', 'cmd'].includes(m)) as ('ctrl' | 'shift' | 'alt' | 'cmd')[];

    const step: KeyboardStep = {
      id: this.nextStepId('keyboard', key.toLowerCase()),
      label: `Press ${this.describeKeyCombo(key, modifiers)}`,
      type: 'keyboard',
      key: event.keyboard.key,
      modifiers: modifiers.length > 0 ? modifiers : undefined,
    };

    this.addStep(step);
  }

  // ── Input coalescing ─────────────────────────────────────

  private flushPendingKeyboardNav(): void {
    if (!this.session?.pendingKeyboardNav) return;

    const pending = this.session.pendingKeyboardNav;

    // Build action labels for the sequence
    const actionLabels: Record<string, string> = {
      tab: 'Tab', shift_tab: 'Shift+Tab',
      arrow_up: '\u2191', arrow_down: '\u2193',
      arrow_left: '\u2190', arrow_right: '\u2192',
      enter: 'Enter', space: 'Space', escape: 'Esc',
    };

    const parts = pending.actions.map(a => {
      const label = actionLabels[a.key] || a.key;
      return a.count > 1 ? `${label} \u00d7${a.count}` : label;
    });

    // Build expectedFocus from the last action's focused element
    const lastAction = pending.actions[pending.actions.length - 1];
    let expectedFocus: KeyboardNavStep['expectedFocus'] = undefined;
    if (lastAction?.lastFocusedElement && lastAction.lastFocusedElement.focused !== false) {
      const fe = lastAction.lastFocusedElement;
      const ef: Record<string, string> = {};
      if (fe.text) ef.text = fe.text.substring(0, 100);
      if (fe.ariaLabel) ef.ariaLabel = fe.ariaLabel;
      if (fe.role) ef.role = fe.role;
      if (fe.tag) ef.tag = fe.tag;
      if (fe.selector) ef.selector = fe.selector;
      if (fe.placeholder) ef.placeholder = fe.placeholder;
      if (Object.keys(ef).length > 0) expectedFocus = ef;
    }

    // Append focus target to label
    const focusText = expectedFocus?.text?.substring(0, 25)
      || expectedFocus?.ariaLabel?.substring(0, 25)
      || '';
    const label = focusText
      ? `${parts.join(' \u2192 ')} \u2192 "${focusText}"`
      : parts.join(' \u2192 ');

    const actions: KeyboardNavAction[] = pending.actions.map(a => ({
      key: a.key as KeyboardNavAction['key'],
      count: a.count,
    }));

    const step: KeyboardNavStep = {
      id: this.nextStepId('keyboard_nav', pending.actions[0]?.key || 'nav'),
      label,
      type: 'keyboard_nav',
      actions,
      expectedFocus,
      autoFix: true,
    };

    this.session.pendingKeyboardNav = null;
    this.addStep(step);
  }

  private flushPendingInput(): void {
    if (!this.session?.pendingInput) return;

    const pending = this.session.pendingInput;
    const step: TypeStep = {
      id: this.nextStepId('type', pending.target.selector.split(/[.#\[\s]/)[0] || 'input'),
      label: `Type "${this.truncate(pending.lastValue, 30)}"`,
      type: 'type',
      target: pending.target,
      value: pending.lastValue,
      clearFirst: true,
    };

    this.session.pendingInput = null;
    this.addStep(step);

    // Capture reference crop for visual verification (fire-and-forget)
    if (step.target.expectedBounds) {
      this.captureReferenceCrop(step, step.target.expectedBounds);
    }
  }

  // ── Step creation helpers ────────────────────────────────

  private createNavigateStep(url: string): NavigateStep {
    return {
      id: this.nextStepId('navigate', ''),
      label: `Navigate to ${url}`,
      type: 'navigate',
      url,
      waitMs: NAVIGATE_WAIT_MS,
    };
  }

  private createWaitStep(ms: number): WaitStep {
    const seconds = (ms / 1000).toFixed(1);
    return {
      id: this.nextStepId('wait', ''),
      label: `Wait ${seconds}s`,
      type: 'wait',
      condition: { type: 'delay', ms },
    };
  }

  private buildElementTarget(event: RecordingEvent): ElementTarget {
    const el = event.element;
    const target: ElementTarget = {
      selector: el.selector,
    };

    if (el.fallbackSelectors && el.fallbackSelectors.length > 0) {
      target.fallbackSelectors = el.fallbackSelectors;
    }
    if (el.ariaLabel) {
      target.ariaLabel = el.ariaLabel;
    }
    if (el.textContent) {
      target.textContent = el.textContent.slice(0, 50);
    }
    if (el.bounds) {
      target.expectedBounds = {
        left: el.bounds.left,
        top: el.bounds.top,
        width: el.bounds.width,
        height: el.bounds.height,
        tolerance: BOUNDS_TOLERANCE,
        // Viewport-relative percentages (resolution-independent)
        pctX: (el.bounds as any).pctX,
        pctY: (el.bounds as any).pctY,
        pctW: (el.bounds as any).pctW,
        pctH: (el.bounds as any).pctH,
        viewportW: (el.bounds as any).viewportW,
        viewportH: (el.bounds as any).viewportH,
      };
    }

    // Additional attributes for smarter element resolution during playback
    if (el.placeholder) {
      target.placeholder = el.placeholder;
    }
    if (el.title) {
      target.title = el.title;
    }
    if (el.alt) {
      target.alt = el.alt;
    }
    if (el.name) {
      target.name = el.name;
    }
    if (el.dataTestId) {
      target.dataTestId = el.dataTestId;
    }

    // Store contextual information for disambiguating similar elements
    // (e.g., when there are 2 "Create" buttons on the same page)
    if (el.context) {
      const ctx = el.context;
      // Only store context if there's useful disambiguation info
      const hasUsefulContext = ctx.ancestors?.length
        || ctx.landmark
        || ctx.nearestHeading
        || ctx.nthWithSameText;
      if (hasUsefulContext) {
        target.context = {
          ancestors: ctx.ancestors,
          landmark: ctx.landmark,
          nearestHeading: ctx.nearestHeading,
          siblings: ctx.siblings,
          label: ctx.label,
          nthWithSameText: ctx.nthWithSameText,
          totalWithSameText: ctx.totalWithSameText,
        };
      }
    }

    return target;
  }

  /**
   * Build an accessibility-first element target from a recording event.
   * Uses role + accessible name as primary identifiers, with CSS selector as fallback.
   */
  private buildAccessibilityTarget(event: RecordingEvent): ElementTarget {
    const el = event.element as any;

    // Build base target with CSS selector as fallback
    const target = this.buildElementTarget(event);

    // Add accessibility-specific fields
    if (el.computedRole) {
      target.role = el.computedRole;
    }
    if (el.shadowPath && el.shadowPath.length > 0) {
      target.shadowPath = el.shadowPath;
    }
    if (el.svgFingerprint) {
      target.svgFingerprint = el.svgFingerprint;
    }

    // Build compact accessibility query: role:button[name:Submit]
    const role = el.computedRole || el.role || '';
    const name = el.accessibleName || el.ariaLabel || '';
    if (role && name) {
      target.accessibilityQuery = `role:${role}[name:${name}]`;
    } else if (role) {
      target.accessibilityQuery = `role:${role}`;
    } else if (name) {
      target.accessibilityQuery = `[name:${name}]`;
    }

    return target;
  }

  private nextStepId(type: string, suffix: string): string {
    if (!this.session) return 'step-0';
    this.session.stepCounter++;
    const parts = [`step-${this.session.stepCounter}`, type];
    if (suffix) parts.push(suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20));
    return parts.join('-');
  }

  private addStep(step: WorkflowStep): void {
    if (!this.session) return;
    this.session.steps.push(step);
    if (this.onStepCaptured) {
      this.onStepCaptured(step, this.session.steps.length);
    }
  }

  // ── Workflow document construction ───────────────────────

  private buildWorkflowDocument(variables: VariableDeclaration[]): WorkflowDocument {
    const session = this.session!;
    const name = session.workflowName
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    return {
      version: '1.0',
      id: session.workflowName,
      name,
      description: `Recorded workflow for ${session.site}`,
      site: session.site,
      variables,
      steps: session.steps,
      metadata: {
        createdAt: new Date(session.startTime).toISOString(),
        updatedAt: new Date().toISOString(),
        recordedBy: 'recorder',
        recordingMode: session.recordingMode,
      },
    };
  }

  // ── Post-processing: typo collapsing ─────────────────────

  /**
   * Collapse sequences of type → backspace → type on the same element
   * into a single type step with the final value. This cleans up
   * typo corrections that happen during recording.
   */

  /**
   * Remove click steps that are synthetic duplicates of Enter/Space in a preceding keyboard_nav.
   * When Enter is pressed on a button, the browser fires both keydown AND click.
   * The recorder captures both, so we strip the redundant click here.
   */
  private stripSyntheticClicks(steps: WorkflowStep[]): WorkflowStep[] {
    const result: WorkflowStep[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === 'click' && i > 0) {
        const prev = steps[i - 1];
        if (prev.type === 'keyboard_nav') {
          const navStep = prev as KeyboardNavStep;
          const lastAction = navStep.actions[navStep.actions.length - 1];
          if (lastAction && (lastAction.key === 'enter' || lastAction.key === 'space')) {
            recLog('INFO', `stripSyntheticClicks: removing click step "${step.label}" after keyboard_nav ending with ${lastAction.key}`);
            continue; // skip this click
          }
        }
      }
      result.push(step);
    }
    if (result.length < steps.length) {
      recLog('INFO', `stripSyntheticClicks: removed ${steps.length - result.length} synthetic click(s)`);
    }
    return result;
  }

  private collapseTypoSequences(steps: WorkflowStep[]): WorkflowStep[] {
    const result: WorkflowStep[] = [];
    let i = 0;

    while (i < steps.length) {
      const step = steps[i];

      // Look for a type step followed by backspace(s) and more type steps on the same element
      if (step.type === 'type') {
        let lastTypeStep = step;
        let j = i + 1;

        // Walk forward through backspace/type sequences on the same selector
        while (j < steps.length) {
          const next = steps[j];

          // Backspace on same element — skip it, keep going
          if (next.type === 'keyboard' && next.key === 'Backspace') {
            j++;
            continue;
          }

          // Another type on the same element — this is the corrected value
          if (next.type === 'type' && next.target.selector === lastTypeStep.target.selector) {
            lastTypeStep = next;
            j++;
            continue;
          }

          // Something else — stop collapsing
          break;
        }

        // If we collapsed anything, use only the last type step
        if (j > i + 1) {
          // Renumber the step ID to maintain clean ordering
          const collapsed: TypeStep = {
            ...lastTypeStep,
            id: step.id,  // Keep the original step's ID for ordering
            label: `Type "${this.truncate(lastTypeStep.value, 30)}"`,
          };
          result.push(collapsed);
          i = j;
        } else {
          result.push(step);
          i++;
        }
      } else {
        result.push(step);
        i++;
      }
    }

    return result;
  }

  // ── Post-processing: upgrade dumb delays ─────────────────

  /**
   * Look for dumb delay waits followed by clicks and upgrade them to
   * smart element_visible waits. This catches cases where the real-time
   * gap tracking didn't have enough data, but the pattern is clear from
   * the step sequence:
   *
   *   wait(delay: 10s) → click(button "Download")
   *   becomes: wait(element_visible: button "Download")
   *
   * Only upgrades delays > 5s (shorter delays are probably just UI settling).
   */
  private upgradeDumbDelays(steps: WorkflowStep[]): WorkflowStep[] {
    const result: WorkflowStep[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Look for delay waits ≥ 5s followed by a click step
      if (
        step.type === 'wait' &&
        step.condition.type === 'delay' &&
        step.condition.ms >= SMART_WAIT_THRESHOLD_MS &&
        i + 1 < steps.length &&
        steps[i + 1].type === 'click'
      ) {
        const nextClick = steps[i + 1] as ClickStep;
        const hasIdentifier = nextClick.target.textContent ||
                              nextClick.target.ariaLabel ||
                              nextClick.target.description;

        if (hasIdentifier) {
          // Upgrade: wait for the clicked element to become visible
          const upgradedWait: WaitStep = {
            ...step,
            label: `Wait for "${this.truncate(
              nextClick.target.textContent ||
              nextClick.target.ariaLabel ||
              nextClick.target.description || 'element',
              30
            )}" to appear`,
            condition: {
              type: 'element_visible',
              target: nextClick.target,
            },
            // Generous timeout: 2x the observed delay, min 15s, max 120s
            timeoutMs: Math.max(15000, Math.min(step.condition.ms * 2, 120000)),
          };
          result.push(upgradedWait);
          continue;
        }
      }

      result.push(step);
    }

    return result;
  }

  // ── Post-processing: variable detection ──────────────────

  /**
   * Scan type steps and determine which values are likely user-provided
   * parameters that should become variables. Returns the modified steps
   * (with {{varName}} placeholders) and the variable declarations.
   *
   * Heuristics:
   * 1. Type steps into form fields (textarea, input) are likely variables
   * 2. Skip values that look like UI navigation (single chars, Tab, Enter)
   * 3. Infer variable names from element context (selector keywords,
   *    aria-label, nearby click labels, position in form sequence)
   * 4. Values typed into the same element type get unique names
   */
  private detectVariables(steps: WorkflowStep[]): {
    steps: WorkflowStep[];
    variables: VariableDeclaration[];
  } {
    const variables: VariableDeclaration[] = [];
    const usedNames = new Set<string>();
    const newSteps: WorkflowStep[] = [];

    // First pass: find click→type pairs to understand form field context
    // A click followed by a type on the same/nearby element is a form fill
    const fieldContext = new Map<number, string>(); // stepIndex → contextHint

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type !== 'type') continue;

      // Look for a preceding click on the same element (form field focus)
      const prevClick = this.findPrecedingClick(steps, i);
      if (prevClick) {
        const hint = this.extractFieldHint(prevClick, step);
        if (hint) fieldContext.set(i, hint);
      }
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      if (step.type !== 'type') {
        newSteps.push(step);
        continue;
      }

      const value = step.value;

      // Skip very short values (likely not meaningful input)
      if (value.length <= 1) {
        newSteps.push(step);
        continue;
      }

      // Skip values that look like they're just keyboard noise
      if (/^[\s\t\n]+$/.test(value)) {
        newSteps.push(step);
        continue;
      }

      // This is a variable candidate — infer a name
      let varName = this.inferVariableName(step, fieldContext.get(i), i);
      varName = this.uniquifyName(varName, usedNames);
      usedNames.add(varName);

      // Create the variable declaration
      variables.push({
        name: varName,
        description: this.inferVariableDescription(step, fieldContext.get(i)),
        type: 'string',
        required: true,
        default: value,
      });

      // Replace the value with a variable reference
      const parameterized: TypeStep = {
        ...step,
        value: `{{${varName}}}`,
        label: `Type {{${varName}}}`,
      };
      newSteps.push(parameterized);
      continue;
    }

    return { steps: newSteps, variables };
  }

  /**
   * Find the click step that directly precedes a type step and targets
   * the same or similar element (user clicked a field then typed in it).
   */
  private findPrecedingClick(steps: WorkflowStep[], typeIndex: number): ClickStep | null {
    // Walk backwards, skipping waits and keyboard steps (Tab, etc.)
    for (let i = typeIndex - 1; i >= 0 && i >= typeIndex - 3; i--) {
      const s = steps[i];
      if (s.type === 'click') return s;
      if (s.type === 'wait' || s.type === 'keyboard') continue;
      break; // Something else — stop looking
    }
    return null;
  }

  /**
   * Extract a field name hint from the click target and type step context.
   * Looks at aria-label, text content, selector keywords, input type.
   */
  private extractFieldHint(click: ClickStep, typeStep: TypeStep): string | null {
    const target = typeStep.target;

    // aria-label is the best hint
    if (target.ariaLabel) return target.ariaLabel;

    // Look for common form field patterns in selector, aria-label, textContent
    const selectorLower = target.selector.toLowerCase();

    const fieldPatterns: [RegExp, string][] = [
      [/\blyrics?\b/i, 'lyrics'],
      [/\bstyle\b/i, 'style'],
      [/\btitle\b/i, 'title'],
      [/\bname\b/i, 'name'],
      [/\bemail\b/i, 'email'],
      [/\bpassword\b/i, 'password'],
      [/\bsearch\b/i, 'search'],
      [/\bdescription\b/i, 'description'],
      [/\bmessage\b/i, 'message'],
      [/\bcomment\b/i, 'comment'],
      [/\bsubject\b/i, 'subject'],
      [/\burl\b/i, 'url'],
      [/\bphone\b/i, 'phone'],
      [/\baddress\b/i, 'address'],
      [/\bcity\b/i, 'city'],
      [/\bzip\b/i, 'zip'],
      [/\bcountry\b/i, 'country'],
      [/\bprompt\b/i, 'prompt'],
      [/\btag\b/i, 'tags'],
      [/\bcaption\b/i, 'caption'],
    ];

    // Check selector, ariaLabel, textContent
    for (const [pattern, name] of fieldPatterns) {
      if (pattern.test(selectorLower)) return name;
      if (target.ariaLabel && pattern.test(target.ariaLabel)) return name;
      if (target.textContent && pattern.test(target.textContent)) return name;
    }

    // Check the preceding click's text content for hints
    if (click.target.textContent) {
      for (const [pattern, name] of fieldPatterns) {
        if (pattern.test(click.target.textContent)) return name;
      }
    }

    // Check the typed value itself for field-descriptive patterns
    // (handled later in inferVariableName via inferFromValue)
    return null;
  }

  /**
   * Infer a variable name from a type step's context.
   * Uses field hints, element type, position, and the value itself.
   */
  private inferVariableName(step: TypeStep, fieldHint: string | undefined, stepIndex: number): string {
    // Use field hint if available
    if (fieldHint) {
      return this.sanitizeVarName(fieldHint);
    }

    // Analyze the typed value itself for clues about what the field is for.
    // Users often type descriptive placeholder-like text during recording.
    const valueHint = this.inferFromValue(step.value);
    if (valueHint) {
      return this.sanitizeVarName(valueHint);
    }

    // Infer from element type
    const selector = step.target.selector.toLowerCase();

    if (selector.includes('textarea')) {
      // Textareas are often for longer content
      const value = step.value.toLowerCase();
      if (value.length > 50) return 'content';
      if (/\n/.test(value)) return 'text';
      return 'text_input';
    }

    if (selector.includes('input')) {
      // Try to infer from input type attribute in selector
      const typeMatch = selector.match(/type=["']?(\w+)/);
      if (typeMatch) {
        const inputType = typeMatch[1];
        if (inputType === 'email') return 'email';
        if (inputType === 'password') return 'password';
        if (inputType === 'search') return 'search_query';
        if (inputType === 'tel') return 'phone';
        if (inputType === 'url') return 'url';
        if (inputType === 'number') return 'number';
      }
      return 'input_value';
    }

    // Fallback: generic name based on position
    return 'value';
  }

  /**
   * Analyze the typed value to infer what field it represents.
   * Looks for:
   * - Placeholder-like text (e.g., "enter lyrics", "your name here")
   * - Descriptive patterns (e.g., "optional song title", "type message")
   * - Domain-specific keywords (lyrics, style, title, description, etc.)
   */
  private inferFromValue(value: string): string | null {
    const lower = value.toLowerCase().trim();

    // Patterns where the value itself describes the field:
    // "enter X", "type X", "your X", "add X", "X here", "optional X"
    const descriptivePatterns: [RegExp, number][] = [
      [/^(?:enter|type|write|input|add|put)\s+(?:your\s+)?(.+?)(?:\s+here)?$/i, 1],
      [/^(?:your\s+)?(.+?)\s+here$/i, 1],
      [/^optional\s+(.+?)\.?$/i, 1],
      [/^(?:my|the|a|an)\s+(.+?)$/i, 1],
    ];

    for (const [pattern, group] of descriptivePatterns) {
      const match = lower.match(pattern);
      if (match && match[group]) {
        const extracted = match[group].trim();
        // Validate it's a reasonable field name (2-30 chars, mostly letters)
        if (extracted.length >= 2 && extracted.length <= 30 && /^[a-z\s]+$/.test(extracted)) {
          return extracted;
        }
      }
    }

    // Check if the value contains obvious field-type keywords
    const valueKeywords: [RegExp, string][] = [
      [/\blyrics?\b/i, 'lyrics'],
      [/\bstyle\b/i, 'style'],
      [/\btitle\b/i, 'title'],
      [/\bname\b/i, 'name'],
      [/\bemail\b/i, 'email'],
      [/\bpassword\b/i, 'password'],
      [/\bdescription\b/i, 'description'],
      [/\bmessage\b/i, 'message'],
      [/\bprompt\b/i, 'prompt'],
      [/\bcaption\b/i, 'caption'],
      [/\bcomment\b/i, 'comment'],
      [/\baddress\b/i, 'address'],
      [/\bsearch\b/i, 'search'],
      [/\btag\b/i, 'tags'],
      [/\bnotes?\b/i, 'notes'],
      [/\bbio\b/i, 'bio'],
      [/\bsummary\b/i, 'summary'],
      [/\bquery\b/i, 'query'],
    ];

    for (const [pattern, name] of valueKeywords) {
      if (pattern.test(lower)) return name;
    }

    return null;
  }

  /**
   * Generate a human-readable description for a variable.
   */
  private inferVariableDescription(step: TypeStep, fieldHint: string | undefined): string {
    const isTextarea = step.target.selector.includes('textarea');
    const fieldType = isTextarea ? 'text area' : 'input field';

    if (fieldHint) {
      return `${fieldHint.charAt(0).toUpperCase() + fieldHint.slice(1)} to enter in the ${fieldType}`;
    }

    // Try to generate description from the default value
    const value = step.value;
    const valueHint = this.inferFromValue(value);
    if (valueHint) {
      return `${valueHint.charAt(0).toUpperCase() + valueHint.slice(1)} to enter in the ${fieldType}`;
    }

    return `Value to enter in the ${fieldType}`;
  }

  /**
   * Sanitize a string to be a valid variable name.
   * Lowercase, replace spaces/hyphens with underscores, remove special chars.
   */
  private sanitizeVarName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30)
      || 'value';
  }

  /**
   * Make a variable name unique by appending _2, _3, etc. if already used.
   */
  private uniquifyName(name: string, usedNames: Set<string>): string {
    if (!usedNames.has(name)) return name;
    let i = 2;
    while (usedNames.has(`${name}_${i}`)) i++;
    return `${name}_${i}`;
  }

  // ── Utilities ────────────────────────────────────────────

  private describeElement(event: RecordingEvent): string {
    const el = event.element;
    if (el.ariaLabel) return `${el.tag}[aria-label="${el.ariaLabel}"]`;
    if (el.textContent) return `${el.tag} "${this.truncate(el.textContent, 20)}"`;
    return el.selector.slice(0, 40);
  }

  private describeKeyCombo(key: string, modifiers: string[]): string {
    if (modifiers.length === 0) return key;
    return [...modifiers, key].join('+');
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + '...';
  }

  // ── Chrome / connection helpers ──────────────────────────

  /**
   * Enable recording mode in the Chrome extension with retry.
   * The content script might not be ready immediately after page navigation,
   * so we retry a few times with increasing delays.
   */
  private async enableRecordingWithRetry(maxAttempts: number): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      recLog('INFO', `enableRecordingWithRetry attempt ${attempt}/${maxAttempts}`, {
        bridgeConnected: bridgeServer.isConnected,
      });
      try {
        const mode = this.session?.recordingMode || 'standard';
        const result = await bridgeServer.setRecordingMode(true, mode);
        recLog('INFO', 'setRecordingMode(true) succeeded', { result, mode });
        return; // Success
      } catch (err) {
        lastError = err as Error;
        recLog('WARN', `setRecordingMode(true) failed attempt ${attempt}`, { error: String(err) });
        if (attempt < maxAttempts) {
          const delayMs = attempt * 2000; // 2s, 4s, 6s...
          this.status(`Recording mode failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
          await this.delay(delayMs);
        }
      }
    }

    recLog('ERROR', `enableRecordingWithRetry exhausted all ${maxAttempts} attempts`, { lastError: String(lastError) });
    // All retries failed — throw to let caller handle it
    throw new Error(`Could not enable recording mode after ${maxAttempts} attempts: ${lastError?.message}`);
  }

  /**
   * Open Chrome to a URL. Tries flow-frame-core first, then falls back
   * to the macOS `open` command.
   */
  private async openChromeWithUrl(url: string): Promise<void> {
    let opened = false;

    // Try flow-frame-core BrowserController
    try {
      const mod = await import('flow-frame-core/dist/controllers/browserController.js');
      const BrowserController = mod.BrowserController;
      await BrowserController.openChrome({ url });
      await this.delay(2000);
      try { focusAndMaximizeChrome(); } catch { /* ok */ }
      opened = true;
    } catch {
      // Not available — fall through
    }

    // Fallback: macOS open command
    if (!opened) {
      try {
        const { execSync } = await import('child_process');
        execSync(`open -a "Google Chrome" "${url}"`, { timeout: 5000 });
        await this.delay(2000);
        opened = true;
      } catch {
        // Not available — fall through
      }
    }

    // Fallback: generic xdg-open (Linux)
    if (!opened) {
      try {
        const { execSync } = await import('child_process');
        execSync(`xdg-open "${url}"`, { timeout: 5000 });
        await this.delay(2000);
        opened = true;
      } catch {
        // Not available
      }
    }

    if (!opened) {
      this.status(`Could not open Chrome automatically. Please open ${url} in Chrome manually.`);
    }
  }

  /**
   * Wait for the Chrome extension to connect to the bridge server.
   * Provides periodic status messages so the user knows it's working.
   * Returns true if connected, false if timeout.
   */
  private waitForConnection(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (bridgeServer.isConnected) {
        resolve(true);
        return;
      }

      let resolved = false;
      let elapsed = 0;

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        clearInterval(statusInterval);
        bridgeServer.removeListener('connected', onConnected);
      };

      const finish = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (result) {
          // Small delay to let the hello handshake complete
          setTimeout(() => resolve(true), 500);
        } else {
          resolve(false);
        }
      };

      // Timeout after CONNECTION_TIMEOUT_MS
      const timeout = setTimeout(() => finish(false), CONNECTION_TIMEOUT_MS);

      // Listen for the 'connected' event
      const onConnected = () => finish(true);
      bridgeServer.once('connected', onConnected);

      // Poll isConnected in case the event was missed
      const poll = setInterval(() => {
        if (bridgeServer.isConnected) {
          finish(true);
        }
      }, CONNECTION_POLL_MS);

      // Periodic status updates so the user knows we haven't frozen
      const statusInterval = setInterval(() => {
        elapsed += 5000;
        const remaining = Math.round((CONNECTION_TIMEOUT_MS - elapsed) / 1000);
        if (remaining > 0 && !resolved) {
          this.status(`Still waiting for extension... (${remaining}s remaining)`);
        }
      }, 5000);
    });
  }

  private status(message: string): void {
    if (this.onStatus) {
      this.onStatus(message);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Desktop (native app) recording ─────────────────────────

  /**
   * Start recording global mouse clicks for native desktop app automation.
   * Uses uiohook-napi for cross-platform global input hooks.
   *
   * Unlike browser recording (which captures DOM events via Chrome extension),
   * desktop recording captures raw screen coordinates and replays them with
   * robotjs — no element selectors, just x/y positions.
   */
  async startDesktopRecording(name: string, appName?: string): Promise<void> {
    // Truncate log file at start of each recording
    try {
      mkdirSync(RECORDING_LOG_DIR, { recursive: true });
      writeFileSync(RECORDING_LOG_PATH, '');
    } catch { /* ok */ }
    recLog('INFO', '=== Desktop recording start BEGIN ===', { name, appName });

    if (this.session) {
      recLog('ERROR', 'Recording already in progress');
      throw new Error('Recording already in progress. Use /record stop first.');
    }

    // Launch the target application if specified
    if (appName) {
      recLog('INFO', `Launching application: ${appName}`);
      try {
        await launchApp(appName);
        recLog('INFO', `Application launched: ${appName}`);
      } catch (err: any) {
        recLog('ERROR', `Failed to launch app "${appName}"`, { error: String(err) });
        throw new Error(`Could not launch "${appName}": ${err.message}`);
      }
    }

    // Use the compiled native Swift event monitor (macOS) or uiohook-napi (other platforms).
    // The Swift binary uses NSEvent.addGlobalMonitorForEvents which handles macOS
    // accessibility permissions properly, outputs JSON lines to stdout, and can be
    // killed cleanly with SIGTERM/SIGKILL.
    const hookBinaryPath = join(__dirname, '..', '..', 'tools', 'desktop-hook');
    const isSwiftHookAvailable = process.platform === 'darwin' && existsSync(hookBinaryPath);

    let hookChild: ReturnType<typeof spawn>;

    if (isSwiftHookAvailable) {
      recLog('INFO', 'Using native Swift desktop-hook binary', { path: hookBinaryPath });
      hookChild = spawn(hookBinaryPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Fallback: uiohook-napi in a child process (cross-platform)
      let uiohookEntryPath: string;
      try {
        uiohookEntryPath = require.resolve('uiohook-napi');
      } catch (err: any) {
        throw new Error(
          `Desktop recording requires either the desktop-hook binary (macOS) or uiohook-napi.\n` +
          `Error: ${err.message}`
        );
      }
      const scriptPath = join(tmpdir(), `woodbury-desktop-hook-${Date.now()}.js`);
      writeFileSync(scriptPath, `
        'use strict';
        const { uIOhook } = require(${JSON.stringify(uiohookEntryPath)});
        uIOhook.on('mousedown', (e) => {
          const line = JSON.stringify({ type: 'click', x: e.x, y: e.y, button: e.button, clicks: e.clicks || 1, action: 'click', time: e.time });
          process.stdout.write(line + '\\n');
        });
        uIOhook.start();
        process.stdout.write(JSON.stringify({ type: 'started' }) + '\\n');
      `);
      hookChild = spawn(process.execPath, [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Clean up temp script after a short delay
      setTimeout(() => { try { unlinkSync(scriptPath); } catch { /* ok */ } }, 2000);
    }

    // Parse JSON lines from the hook process stdout
    let stdoutBuffer = '';
    const pendingMessages: any[] = [];
    let onMessage: ((msg: any) => void) | null = null;

    hookChild.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || ''; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (onMessage) {
            onMessage(msg);
          } else {
            pendingMessages.push(msg);
          }
        } catch {
          recLog('WARN', 'Failed to parse hook output line', { line });
        }
      }
    });

    hookChild.stderr!.on('data', (chunk: Buffer) => {
      recLog('WARN', '[hook-stderr]', { output: chunk.toString().trim() });
    });

    // Wait for the hook to confirm it started
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        hookChild.kill('SIGKILL');
        const hint = process.platform === 'darwin'
          ? 'On macOS, ensure Accessibility permissions are granted in System Settings → Privacy & Security → Accessibility for the desktop-hook binary.'
          : 'On Windows, try running the app as Administrator.';
        reject(new Error(`Desktop hook timed out starting (5s). ${hint}`));
      }, 5000);

      // Check pending messages first (might have arrived before we set up listener)
      for (const msg of pendingMessages) {
        if (msg.type === 'started') {
          clearTimeout(timeout);
          resolve();
          return;
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          hookChild.kill('SIGKILL');
          reject(new Error(`Desktop hook failed: ${msg.message}`));
          return;
        }
      }

      onMessage = (msg: any) => {
        if (msg.type === 'started') {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          hookChild.kill('SIGKILL');
          reject(new Error(`Desktop hook failed: ${msg.message}`));
        }
      };

      hookChild.once('error', (err) => {
        clearTimeout(timeout);
        hookChild.kill('SIGKILL');
        reject(err);
      });

      hookChild.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          reject(new Error(`Desktop hook process exited with code ${code}`));
        }
      });
    });

    recLog('INFO', 'Desktop hook child process started successfully', { pid: hookChild.pid });

    // Initialize session in desktop mode
    this.session = {
      workflowName: name,
      site: 'desktop',
      steps: [],
      startTime: Date.now(),
      paused: false,
      lastUrl: '',
      lastEventTime: Date.now(),
      stepCounter: 0,
      pendingInput: null,
      pendingKeyboardNav: null,
      eventListener: null,
      snapshotListener: null,
      reconnectHandler: null,
      gapTracker: null,
      gapDetectionTimer: null,
      downloadSnapshotIds: new Set(),
      captureElementCrops: false,
      snapshotCounter: 0,
      interactedSelectors: new Map(),
      desktopMode: true,
      desktopHook: hookChild,
      lastActionKeyTime: 0,
      recordingMode: 'standard',
    };

    // Insert a launch app step as the first step so the workflow opens the app on replay
    if (appName) {
      const launchStep: DesktopLaunchAppStep = {
        id: this.nextStepId('desktop-launch', appName),
        label: `Launch ${appName}`,
        type: 'desktop_launch_app',
        appName,
        delayAfterMs: 2000,
      };
      this.addStep(launchStep);
      recLog('INFO', 'Inserted desktop_launch_app step', { appName });
    }

    // Forward events from the hook process to the recording handler
    // (messages arrive via the stdout JSON line parser set up above)
    onMessage = (msg: any) => {
      if (msg.type === 'click') {
        this.handleDesktopClick(msg);
      } else if (msg.type === 'keypress') {
        this.handleDesktopKeypress(msg);
      } else if (msg.type === 'keydown') {
        this.handleDesktopKeydown(msg);
      }
    };

    hookChild.on('error', (err) => {
      recLog('ERROR', 'Desktop hook process error', { error: String(err) });
    });

    hookChild.on('exit', (code, signal) => {
      recLog('INFO', `Desktop hook process exited`, { code, signal });
    });

    const appMsg = appName ? ` (${appName})` : '';
    recLog('INFO', `Desktop recording started${appMsg} — global click hook active`);
    this.status(`Desktop recording started${appMsg} — click anywhere on screen to record actions.`);
  }

  /**
   * Handle a global mouse click event from uiohook-napi.
   * Builds a DesktopClickStep and adds it to the recording.
   */
  private handleDesktopClick(e: any): void {
    if (!this.session || this.session.paused || !this.session.desktopMode) return;

    const now = e.time || Date.now();

    // Detect time gap → insert wait step
    const gap = now - this.session.lastEventTime;
    if (gap > GAP_THRESHOLD_MS) {
      const waitMs = Math.min(gap, MAX_GAP_WAIT_MS);
      const waitStep = this.createWaitStep(waitMs);
      this.addStep(waitStep);
    }
    this.session.lastEventTime = now;

    // Determine click action from event data
    // e.button: 1 = left, 2 = right, 3 = middle (libuiohook convention)
    // e.clicks: number of consecutive clicks (1 = single, 2 = double)
    const action: 'click' | 'double_click' | 'right_click' =
      e.clicks >= 2 ? 'double_click'
      : e.button === 2 ? 'right_click'
      : 'click';

    // Get frontmost application name (platform-specific)
    const app = getFrontmostApp();

    const step: DesktopClickStep = {
      id: this.nextStepId('desktop-click', app || 'desktop'),
      label: `Desktop ${action} at (${e.x}, ${e.y})${app ? ` in ${app}` : ''}`,
      type: 'desktop_click',
      x: e.x,
      y: e.y,
      action,
      app: app || undefined,
      description: app || 'Desktop click',
      delayAfterMs: 1000,
    };

    this.addStep(step);
    recLog('INFO', 'Desktop click captured', { x: e.x, y: e.y, action, app, button: e.button, clicks: e.clicks });

    // Capture desktop screenshot (fire-and-forget, for reference)
    this.captureDesktopScreenshot(step.id).catch(() => { /* ignore */ });
  }

  /**
   * Handle a keypress event (regular character typing) from the desktop hook.
   * Accumulates consecutive keypress events into a single DesktopTypeStep.
   */
  private handleDesktopKeypress(e: any): void {
    if (!this.session || this.session.paused || !this.session.desktopMode) return;

    const now = e.time || Date.now();
    const char = e.chars || e.key || '';
    if (!char) return;

    // Check if we can merge into the last step (if it's a recent desktop_type)
    const lastStep = this.session.steps[this.session.steps.length - 1];
    if (lastStep && lastStep.type === 'desktop_type' && (now - this.session.lastEventTime) < 2000) {
      // Append to existing type step
      (lastStep as DesktopTypeStep).value += char;
      lastStep.label = `Type: "${(lastStep as DesktopTypeStep).value}"`;
      this.session.lastEventTime = now;
      recLog('INFO', 'Desktop keypress appended', { char, total: (lastStep as DesktopTypeStep).value });
      return;
    }

    // Detect time gap → insert wait step
    const gap = now - this.session.lastEventTime;
    if (gap > GAP_THRESHOLD_MS) {
      const waitMs = Math.min(gap, MAX_GAP_WAIT_MS);
      this.addStep(this.createWaitStep(waitMs));
    }
    this.session.lastEventTime = now;

    const step: DesktopTypeStep = {
      id: this.nextStepId('desktop-type', 'keyboard'),
      label: `Type: "${char}"`,
      type: 'desktop_type',
      value: char,
      delayAfterMs: 100,
    };

    this.addStep(step);
    recLog('INFO', 'Desktop keypress captured', { char });
  }

  /**
   * Handle a keydown event (special key or keyboard shortcut) from the desktop hook.
   * Creates a DesktopKeyboardStep for shortcuts (Cmd+S, Ctrl+Z, etc.) and special keys.
   */
  private handleDesktopKeydown(e: any): void {
    if (!this.session || this.session.paused || !this.session.desktopMode) return;

    const now = e.time || Date.now();
    const key = e.key || 'unknown';
    const modifiers: ('ctrl' | 'shift' | 'alt' | 'cmd')[] = e.modifiers || [];

    // Detect time gap → insert wait step
    const gap = now - this.session.lastEventTime;
    if (gap > GAP_THRESHOLD_MS) {
      const waitMs = Math.min(gap, MAX_GAP_WAIT_MS);
      this.addStep(this.createWaitStep(waitMs));
    }
    this.session.lastEventTime = now;

    const modStr = modifiers.length > 0 ? modifiers.join('+') + '+' : '';
    const step: DesktopKeyboardStep = {
      id: this.nextStepId('desktop-key', key),
      label: `Key: ${modStr}${key}`,
      type: 'desktop_keyboard',
      key,
      modifiers: modifiers.length > 0 ? modifiers : undefined,
      delayAfterMs: 1000,
    };

    this.addStep(step);
    recLog('INFO', 'Desktop keydown captured', { key, modifiers });
  }

  /**
   * Capture a full desktop screenshot and save it for reference.
   * Used during desktop recording to provide visual context for each click.
   */
  private async captureDesktopScreenshot(stepId: string): Promise<void> {
    try {
      const mod = await import('flow-frame-core/dist/inference/capturescreenshot.js');
      const dataUrl: string = await mod.captureScreenshotBase64(undefined);
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');

      const refsDir = join(homedir(), '.woodbury', 'data', 'workflows', this.session?.workflowName || 'unknown', 'refs');
      mkdirSync(refsDir, { recursive: true });

      const filename = `${stepId}.png`;
      writeFileSync(join(refsDir, filename), Buffer.from(base64, 'base64'));

      // Update the step's screenshotRef if it's the latest step
      if (this.session) {
        const lastStep = this.session.steps[this.session.steps.length - 1];
        if (lastStep && lastStep.id === stepId && lastStep.type === 'desktop_click') {
          (lastStep as DesktopClickStep).screenshotRef = join(refsDir, filename);
        }
      }
    } catch (err) {
      recLog('WARN', 'captureDesktopScreenshot failed (non-fatal)', { stepId, error: String(err) });
    }
  }
}

// ── Utilities (module-level) ──────────────────────────────────

/**
 * Get the name of the frontmost application.
 * Platform-specific: macOS uses osascript, Windows uses PowerShell, Linux uses xdotool.
 * Returns 'unknown' on failure.
 */
function getFrontmostApp(): string {
  try {
    if (process.platform === 'darwin') {
      return execSync(
        "osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'",
        { timeout: 2000, encoding: 'utf-8' }
      ).trim();
    } else if (process.platform === 'win32') {
      return execSync(
        'powershell -NoProfile -c "(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object -Property CPU -Descending | Select-Object -First 1).ProcessName"',
        { timeout: 2000, encoding: 'utf-8' }
      ).trim();
    } else {
      return execSync(
        'xdotool getactivewindow getwindowname 2>/dev/null || echo unknown',
        { timeout: 2000, encoding: 'utf-8' }
      ).trim();
    }
  } catch {
    return 'unknown';
  }
}

/**
 * Launch an application by name and wait for it to come to the foreground.
 * Platform-specific: macOS uses `open -a`, Windows uses `start`, Linux uses xdg-open/launch by name.
 */
async function launchApp(appName: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: use `open -a` to launch and bring to front
    // First try to activate it if already running, then open if not
    try {
      execSync(
        `osascript -e 'tell application "${appName.replace(/"/g, '\\"')}" to activate'`,
        { timeout: 5000, encoding: 'utf-8' }
      );
    } catch {
      // If activate failed, try open -a (works for apps not yet running)
      execSync(
        `open -a "${appName.replace(/"/g, '\\"')}"`,
        { timeout: 5000, encoding: 'utf-8' }
      );
    }
  } else if (platform === 'win32') {
    // Windows: try Start-Process to launch the app
    try {
      execSync(
        `powershell -NoProfile -c "Start-Process '${appName.replace(/'/g, "''")}';"`,
        { timeout: 5000, encoding: 'utf-8' }
      );
    } catch {
      // Fallback: try start command
      spawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore' });
    }
  } else {
    // Linux: try launching by command name
    try {
      spawn(appName.toLowerCase(), [], { detached: true, stdio: 'ignore' });
    } catch {
      // Fallback: try xdg-open (for .desktop entries)
      spawn('xdg-open', [appName], { detached: true, stdio: 'ignore' });
    }
  }

  // Give the app time to launch and come to foreground
  await new Promise(resolve => setTimeout(resolve, 1500));
}
