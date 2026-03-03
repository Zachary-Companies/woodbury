/**
 * Remote Relay — Connects local Woodbury to Firebase Realtime Database
 * so remote users can control it from their phones via the web app.
 *
 * Architecture:
 *   Local Woodbury ──outbound──▶ Firebase RTDB ◀──reads── Remote Web App
 *
 * The relay:
 *   1. Generates a unique instanceId + secretKey (stored in ~/.woodbury/remote-relay.json)
 *   2. Connects to RTDB and writes instance metadata
 *   3. Listens for commands, executes them against the local dashboard API
 *   4. Writes responses back to RTDB
 *   5. Periodically syncs state (compositions, runs, schedules, approvals)
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onChildAdded,
  onDisconnect,
  serverTimestamp,
  type Database,
  type Unsubscribe,
} from 'firebase/database';
import { getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { debugLog } from './debug-log.js';

// ── Firebase Config ──────────────────────────────────────────

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'woobury-ai.firebaseapp.com',
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://woobury-ai-default-rtdb.firebaseio.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'woobury-ai',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'woobury-ai.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '824143171411',
  appId: process.env.FIREBASE_APP_ID || '',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-Q73W3SE08T',
};

const WEB_APP_URL = 'https://woobury-ai.web.app';
const HEARTBEAT_INTERVAL = 15_000; // 15 seconds
const STATE_SYNC_INTERVAL = 15_000; // 15 seconds
const COMMAND_POLL_INTERVAL = 10_000; // 10 seconds — fallback poll
const COMMAND_TIMEOUT = 30_000; // 30 seconds per command
const MAX_STALE_COMMAND_AGE = 5 * 60_000; // 5 minutes

// ── Types ────────────────────────────────────────────────────

export interface RelayConfig {
  instanceId: string;
  secretKey: string;
  createdAt: string;
  /** UID of the paired Firebase user (set after /pair) */
  pairedUid?: string;
}

export interface RelayHandle {
  connectionUrl: string;
  instanceId: string;
  stop: () => void;
  /** Pair with a remote user via their 4-digit code */
  pair: (code: string) => Promise<boolean>;
  /** Whether a remote user is already paired */
  isPaired: () => boolean;
}

interface RelayCommand {
  method: string;
  path: string;
  body?: Record<string, unknown> | null;
  createdAt: number;
  status: 'pending' | 'processing' | 'done' | 'error';
}

// ── Allowed API Routes ───────────────────────────────────────

const ALLOWED_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  // Compositions / Pipelines
  { method: 'GET', pattern: /^\/api\/compositions$/ },
  { method: 'POST', pattern: /^\/api\/compositions\/[^/]+\/run$/ },
  { method: 'GET', pattern: /^\/api\/compositions\/run\/status$/ },
  { method: 'POST', pattern: /^\/api\/compositions\/run\/cancel$/ },
  // Batch
  { method: 'POST', pattern: /^\/api\/compositions\/[^/]+\/batch-run$/ },
  { method: 'GET', pattern: /^\/api\/batch\/status$/ },
  { method: 'POST', pattern: /^\/api\/batch\/cancel$/ },
  // Runs
  { method: 'GET', pattern: /^\/api\/runs$/ },
  { method: 'GET', pattern: /^\/api\/runs\/[^/]+$/ },
  // Schedules
  { method: 'GET', pattern: /^\/api\/schedules$/ },
  { method: 'POST', pattern: /^\/api\/schedules$/ },
  { method: 'PUT', pattern: /^\/api\/schedules\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/schedules\/[^/]+$/ },
  // Approvals
  { method: 'GET', pattern: /^\/api\/approvals$/ },
  { method: 'POST', pattern: /^\/api\/approvals\/[^/]+\/approve$/ },
  { method: 'POST', pattern: /^\/api\/approvals\/[^/]+\/reject$/ },
  // Workflows (read-only listing)
  { method: 'GET', pattern: /^\/api\/workflows$/ },
];

function isRouteAllowed(method: string, path: string): boolean {
  return ALLOWED_ROUTES.some(
    (r) => r.method === method.toUpperCase() && r.pattern.test(path)
  );
}

// ── Config Persistence ───────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.woodbury');
const CONFIG_FILE = join(CONFIG_DIR, 'remote-relay.json');

async function loadOrCreateConfig(): Promise<RelayConfig> {
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as RelayConfig;
    if (config.instanceId && config.secretKey) {
      return config;
    }
  } catch {
    // File doesn't exist or is invalid — create new config
  }

  const config: RelayConfig = {
    instanceId: randomUUID(),
    secretKey: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  debugLog.info('relay', 'Generated new relay config', { instanceId: config.instanceId });
  return config;
}

// ── Main Entry Point ─────────────────────────────────────────

export async function startRemoteRelay(
  dashboardPort: number,
  verbose: boolean
): Promise<RelayHandle> {
  const config = await loadOrCreateConfig();
  const { instanceId, secretKey } = config;

  debugLog.info('relay', 'Starting remote relay', { instanceId });

  // Initialize Firebase
  const app: FirebaseApp = initializeApp(firebaseConfig, 'woodbury-relay');
  const db: Database = getDatabase(app);
  const auth: Auth = getAuth(app);

  // Sign in anonymously (local instance doesn't need a real user account)
  await signInAnonymously(auth);
  debugLog.info('relay', 'Firebase auth complete (anonymous)');

  const instanceRef = ref(db, `instances/${instanceId}`);
  const metaRef = ref(db, `instances/${instanceId}/meta`);
  const commandsRef = ref(db, `instances/${instanceId}/commands`);

  // Write instance metadata
  const metaData: Record<string, unknown> = {
    name: hostname(),
    secretKey,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    status: 'online',
    version: '1.0.11',
    dashboardPort,
  };
  if (config.pairedUid) {
    metaData.pairedUid = config.pairedUid;
  }
  await set(metaRef, metaData);

  // If already paired, register under user's account for auto-discovery
  if (config.pairedUid) {
    await set(ref(db, `users/${config.pairedUid}/instances/${instanceId}`), {
      name: hostname(),
      instanceId,
      secretKey,
      connectedAt: new Date().toISOString(),
    });
    debugLog.info('relay', `Registered instance under paired user ${config.pairedUid}`);
  }

  // Set onDisconnect handler — auto-set offline if process crashes
  const statusRef = ref(db, `instances/${instanceId}/meta/status`);
  const lastSeenRef = ref(db, `instances/${instanceId}/meta/lastSeen`);
  await onDisconnect(statusRef).set('offline');
  await onDisconnect(lastSeenRef).set(new Date().toISOString());

  debugLog.info('relay', 'Instance metadata written to RTDB');

  // ── Heartbeat ──────────────────────────────────────────────

  const heartbeatTimer = setInterval(async () => {
    try {
      await update(metaRef, {
        lastSeen: new Date().toISOString(),
        status: 'online',
      });
    } catch (err) {
      debugLog.info('relay', `Heartbeat failed: ${String(err)}`);
    }
  }, HEARTBEAT_INTERVAL);

  // ── Command Listener ───────────────────────────────────────

  const baseUrl = `http://127.0.0.1:${dashboardPort}`;

  // Track commands we're already processing to avoid double-execution
  const processingCommands = new Set<string>();

  async function processCommand(commandId: string, command: RelayCommand): Promise<void> {
    if (processingCommands.has(commandId)) return;
    processingCommands.add(commandId);

    try {
      // Skip stale commands (older than 5 minutes)
      if (command.createdAt && Date.now() - command.createdAt > MAX_STALE_COMMAND_AGE) {
        debugLog.info('relay', `Skipping stale command ${commandId}`);
        await update(ref(db, `instances/${instanceId}/commands/${commandId}`), {
          status: 'error',
        });
        await set(ref(db, `instances/${instanceId}/responses/${commandId}`), {
          statusCode: 408,
          data: { error: 'Command expired (stale)' },
          completedAt: Date.now(),
        });
        return;
      }

      // Validate route
      if (!isRouteAllowed(command.method, command.path)) {
        debugLog.info('relay', `Blocked disallowed route: ${command.method} ${command.path}`);
        await update(ref(db, `instances/${instanceId}/commands/${commandId}`), {
          status: 'error',
        });
        await set(ref(db, `instances/${instanceId}/responses/${commandId}`), {
          statusCode: 403,
          data: { error: 'Route not allowed' },
          completedAt: Date.now(),
        });
        return;
      }

      debugLog.info('relay', `Executing command: ${command.method} ${command.path}`);

      // Mark as processing
      await update(ref(db, `instances/${instanceId}/commands/${commandId}`), {
        status: 'processing',
      });

      // Execute against local dashboard
      const fetchOptions: RequestInit = {
        method: command.method,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(COMMAND_TIMEOUT),
      };

      if (command.body && ['POST', 'PUT', 'PATCH'].includes(command.method.toUpperCase())) {
        fetchOptions.body = JSON.stringify(command.body);
      }

      const response = await fetch(`${baseUrl}${command.path}`, fetchOptions);
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = { raw: await response.text() };
      }

      // Write response
      await set(ref(db, `instances/${instanceId}/responses/${commandId}`), {
        statusCode: response.status,
        data,
        completedAt: Date.now(),
      });

      await update(ref(db, `instances/${instanceId}/commands/${commandId}`), {
        status: 'done',
      });

      debugLog.info('relay', `Command ${commandId} completed (${response.status})`);
    } catch (err) {
      debugLog.info('relay', `Command ${commandId} failed: ${String(err)}`);

      await set(ref(db, `instances/${instanceId}/responses/${commandId}`), {
        statusCode: 500,
        data: { error: String(err) },
        completedAt: Date.now(),
      });

      await update(ref(db, `instances/${instanceId}/commands/${commandId}`), {
        status: 'error',
      });
    } finally {
      processingCommands.delete(commandId);
    }
  }

  // Real-time listener for new commands
  const commandListener: Unsubscribe = onChildAdded(commandsRef, async (snapshot) => {
    const commandId = snapshot.key;
    if (!commandId) return;
    const command = snapshot.val() as RelayCommand;
    if (!command || command.status !== 'pending') return;
    await processCommand(commandId, command);
  });

  // Fallback: poll for pending commands every 10s (catches anything onChildAdded missed)
  const commandPollTimer = setInterval(async () => {
    try {
      const snap = await get(ref(db, `instances/${instanceId}/commands`));
      if (!snap.exists()) return;
      const commands = snap.val() as Record<string, RelayCommand>;
      for (const [cmdId, cmd] of Object.entries(commands)) {
        if (cmd && cmd.status === 'pending') {
          processCommand(cmdId, cmd);
        }
      }
    } catch (err) {
      debugLog.info('relay', `Command poll failed: ${String(err)}`);
    }
  }, COMMAND_POLL_INTERVAL);

  // ── State Sync ─────────────────────────────────────────────

  async function syncState(): Promise<void> {
    try {
      const stateRef = ref(db, `instances/${instanceId}/state`);

      // Fetch current state from dashboard API (parallel)
      const [compositionsRes, schedulesRes, runsRes, approvalsRes] = await Promise.all([
        fetch(`${baseUrl}/api/compositions`).then((r) => r.json()).catch(() => ({ compositions: [] })),
        fetch(`${baseUrl}/api/schedules`).then((r) => r.json()).catch(() => ({ schedules: [] })),
        fetch(`${baseUrl}/api/runs?limit=20`).then((r) => r.json()).catch(() => ({ runs: [] })),
        fetch(`${baseUrl}/api/approvals`).then((r) => r.json()).catch(() => ({ approvals: [] })),
      ]) as [
        { compositions?: unknown[] },
        { schedules?: unknown[] },
        { runs?: unknown[] },
        { approvals?: unknown[] },
      ];

      await set(stateRef, {
        compositions: compositionsRes.compositions || [],
        schedules: schedulesRes.schedules || [],
        recentRuns: runsRes.runs || [],
        pendingApprovals: approvalsRes.approvals || [],
        lastSyncedAt: new Date().toISOString(),
      });

      debugLog.info('relay', 'State synced to RTDB');
    } catch (err) {
      debugLog.info('relay', `State sync failed: ${String(err)}`);
    }
  }

  // Initial sync
  await syncState();

  // Periodic sync
  const stateSyncTimer = setInterval(() => {
    syncState();
  }, STATE_SYNC_INTERVAL);

  // ── Connection URL ─────────────────────────────────────────

  const connectionUrl = `${WEB_APP_URL}/c/${instanceId}-${secretKey}`;

  if (verbose) {
    if (config.pairedUid) {
      console.log(`  🌐 Remote: paired (auto-connect enabled)`);
    } else {
      console.log(`  🌐 Remote: use /pair on your phone to connect`);
    }
  }

  debugLog.info('relay', 'Remote relay started', { connectionUrl, paired: !!config.pairedUid });

  // ── Pairing ────────────────────────────────────────────────

  /**
   * Pair with a remote user via their 4-digit code.
   * The web app writes { uid, code } to /pairing_codes/{code}.
   * We read it, verify, then register this instance under their account.
   */
  async function pair(code: string): Promise<boolean> {
    const codeClean = code.trim();
    if (!/^\d{4}$/.test(codeClean)) {
      debugLog.info('relay', `Invalid pairing code format: ${codeClean}`);
      return false;
    }

    try {
      // Read the pairing code from RTDB
      const codeSnap = await get(ref(db, `pairing_codes/${codeClean}`));
      if (!codeSnap.exists()) {
        debugLog.info('relay', `Pairing code ${codeClean} not found`);
        return false;
      }

      const codeData = codeSnap.val() as { uid: string; createdAt: number };
      if (!codeData.uid) {
        debugLog.info('relay', `Pairing code ${codeClean} has no uid`);
        return false;
      }

      // Check code isn't too old (10 minutes max)
      if (codeData.createdAt && Date.now() - codeData.createdAt > 10 * 60_000) {
        debugLog.info('relay', `Pairing code ${codeClean} expired`);
        return false;
      }

      const uid = codeData.uid;

      // Register this instance under the user's account
      // (the web app will grant itself /access/ on auto-discovery with its own auth)
      await set(ref(db, `users/${uid}/instances/${instanceId}`), {
        name: hostname(),
        instanceId,
        secretKey,
        connectedAt: new Date().toISOString(),
      });

      // Update instance meta with paired uid
      await update(metaRef, { pairedUid: uid });

      // Save pairing to local config
      config.pairedUid = uid;
      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

      // Clean up the pairing code
      await remove(ref(db, `pairing_codes/${codeClean}`));

      // Immediate state sync so the web app has data right away
      syncState().catch(() => {});

      debugLog.info('relay', `Paired with user ${uid} via code ${codeClean}`);
      return true;
    } catch (err) {
      debugLog.info('relay', `Pairing failed: ${String(err)}`);
      return false;
    }
  }

  function isPaired(): boolean {
    return !!config.pairedUid;
  }

  // ── Cleanup ────────────────────────────────────────────────

  function stop(): void {
    debugLog.info('relay', 'Stopping remote relay');

    // Clear timers
    clearInterval(heartbeatTimer);
    clearInterval(stateSyncTimer);
    clearInterval(commandPollTimer);

    // Unsubscribe from commands
    commandListener();

    // Set offline status (best-effort, fire-and-forget)
    update(metaRef, {
      status: 'offline',
      lastSeen: new Date().toISOString(),
    }).catch(() => {});
  }

  return {
    connectionUrl,
    instanceId,
    stop,
    pair,
    isPaired,
  };
}
