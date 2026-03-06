/**
 * Woodbury Bridge Server
 *
 * Local WebSocket server (ws://localhost:7865) that acts as a relay between
 * Woodbury tools and the Woodbury Bridge Chrome extension.
 *
 * Architecture:
 *   Woodbury tool (browser_query)
 *     → calls bridgeServer.send(request)
 *     → WS message to Chrome extension background script
 *     → routed to content script in the active tab
 *     → DOM result returned back through the same path
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_PORT = 7865;

// Shared recording log (same file as recorder.ts uses)
const BRIDGE_LOG_DIR = join(homedir(), '.woodbury', 'logs');
const BRIDGE_LOG_PATH = join(BRIDGE_LOG_DIR, 'recording.log');
function bridgeLog(level: string, msg: string, data?: any): void {
  try {
    mkdirSync(BRIDGE_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    let line = `[${ts}] [BRIDGE:${level}] ${msg}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(data); } catch { line += ' [unserializable]'; }
    }
    appendFileSync(BRIDGE_LOG_PATH, line + '\n');
  } catch { /* never break the bridge */ }
}
const REQUEST_TIMEOUT = 30000; // 30 seconds

export interface BridgeRequest {
  id: string;
  action: string;
  params: Record<string, any>;
}

export interface BridgeResponse {
  id: string;
  success?: boolean;
  data?: any;
  error?: string;
}

class BridgeServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  /** The Chrome extension WebSocket client */
  private client: WebSocket | null = null;
  /** Additional subscriber clients (e.g. CLI piggyback) that receive events */
  private subscribers: Set<WebSocket> = new Set();
  /** When we connect as a client to an existing bridge (piggyback mode) */
  private piggybackWs: WebSocket | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: BridgeResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private requestCounter = 0;
  private _port: number = DEFAULT_PORT;
  private _started = false;

  get port(): number {
    return this._port;
  }

  get isConnected(): boolean {
    // Connected if either: we're a server with a client, or we're piggybacking on another server
    return (this.client !== null && this.client.readyState === WebSocket.OPEN) ||
           (this.piggybackWs !== null && this.piggybackWs.readyState === WebSocket.OPEN);
  }

  get isStarted(): boolean {
    return this._started;
  }

  /**
   * Start the WebSocket server. Safe to call multiple times — subsequent
   * calls are no-ops if already running.
   */
  async start(port?: number): Promise<void> {
    if (this._started) return;

    this._port = port || DEFAULT_PORT;

    return new Promise<void>((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this._port });

        this.wss.on('listening', () => {
          this._started = true;
          this.emit('started', this._port);
          resolve();
        });

        this.wss.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            // Port already in use — likely another Woodbury instance.
            // Try to proceed anyway; the extension may connect to the other instance.
            this._started = false;
            reject(new Error(`Port ${this._port} is already in use. Another Woodbury instance may be running.`));
          } else {
            reject(err);
          }
        });

        this.wss.on('connection', (ws: WebSocket) => {
          // We don't know yet if this is the Chrome extension or a subscriber.
          // Wait for the hello message to identify, but temporarily treat as extension.
          let identified = false;
          let isSubscriber = false;

          const identifyTimeout = setTimeout(() => {
            // If no hello received in 5s, assume it's the extension
            if (!identified) {
              identified = true;
              this.setExtensionClient(ws);
            }
          }, 5000);

          ws.on('message', (raw: Buffer) => {
            try {
              const message = JSON.parse(raw.toString());

              // Identify the client from its hello message
              if (!identified && message.type === 'hello') {
                identified = true;
                clearTimeout(identifyTimeout);

                if (message.source === 'woodbury-cli-piggyback') {
                  // This is a subscriber (CLI piggyback), not the Chrome extension
                  isSubscriber = true;
                  this.subscribers.add(ws);
                  bridgeLog('INFO', 'Subscriber (CLI piggyback) connected', { total: this.subscribers.size });
                  return;
                } else {
                  // This is the Chrome extension
                  this.setExtensionClient(ws);
                }
              }

              // Log recording-related messages
              if (message.type === 'recording_event') {
                bridgeLog('EVENT', 'recording_event from extension', {
                  event: message.event,
                  tag: message.element?.tag,
                  text: message.element?.textContent?.slice(0, 40),
                });
              }
              if (message.type === 'page_elements_snapshot') {
                bridgeLog('EVENT', 'page_elements_snapshot from extension', {
                  elements: message.snapshot?.elements?.length,
                  url: message.snapshot?.url?.slice(0, 60),
                });
              }

              this.handleMessage(message);

              // Forward recording events, snapshots, and responses to all subscribers
              if (message.type === 'recording_event' || message.type === 'page_elements_snapshot' || message.id) {
                const json = raw.toString();
                for (const sub of this.subscribers) {
                  if (sub.readyState === WebSocket.OPEN && sub !== ws) {
                    try { sub.send(json); } catch { /* ok */ }
                  }
                }
              }
            } catch (err) {
              // Ignore malformed messages
            }
          });

          ws.on('close', () => {
            clearTimeout(identifyTimeout);
            if (isSubscriber) {
              this.subscribers.delete(ws);
              bridgeLog('INFO', 'Subscriber disconnected', { remaining: this.subscribers.size });
            } else if (this.client === ws) {
              this.client = null;
              bridgeLog('WARN', 'Chrome extension disconnected', { pendingRequests: this.pendingRequests.size });
              this.emit('disconnected');
              // Reject all pending requests
              for (const [id, pending] of this.pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Chrome extension disconnected'));
              }
              this.pendingRequests.clear();
            }
          });

          ws.on('error', () => {
            // Will trigger close
          });
        });
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  private setExtensionClient(ws: WebSocket): void {
    if (this.client && this.client.readyState === WebSocket.OPEN && this.client !== ws) {
      this.client.close();
    }
    this.client = ws;
    bridgeLog('INFO', 'Chrome extension connected');
    this.emit('connected');
  }

  /**
   * Connect as a WebSocket client to an existing bridge server.
   * Used when another Woodbury process (e.g. woodbury-mcp) already owns port 7865.
   * We "piggyback" on their server — sending requests and receiving events through it.
   */
  async connectAsClient(port?: number): Promise<void> {
    const p = port || this._port;
    const url = `ws://localhost:${p}`;

    bridgeLog('INFO', `Connecting as piggyback client to ${url}`);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Piggyback connection to ${url} timed out`));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.piggybackWs = ws;
        this._started = true;

        bridgeLog('INFO', 'Piggyback connection established');

        // Announce ourselves
        ws.send(JSON.stringify({
          type: 'hello',
          source: 'woodbury-cli-piggyback',
          version: '1.0.0',
        }));

        this.emit('connected');
        resolve();
      });

      ws.on('message', (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString());
          this.handleMessage(message);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        bridgeLog('WARN', 'Piggyback connection closed');
        if (this.piggybackWs === ws) {
          this.piggybackWs = null;
          this.emit('disconnected');
          // Reject pending requests
          for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Piggyback connection closed'));
          }
          this.pendingRequests.clear();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        bridgeLog('ERROR', 'Piggyback connection error', { error: String(err) });
        reject(err);
      });
    });
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge server stopping'));
    }
    this.pendingRequests.clear();

    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (this.piggybackWs) {
      this.piggybackWs.close();
      this.piggybackWs = null;
    }

    return new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          this._started = false;
          this.emit('stopped');
          resolve();
        });
      } else {
        this._started = false;
        resolve();
      }
    });
  }

  /**
   * Send a request to the Chrome extension and wait for a response.
   */
  async send(action: string, params: Record<string, any> = {}, timeout?: number): Promise<any> {
    if (action === 'set_recording_mode') {
      bridgeLog('INFO', `send(${action})`, { params, connected: this.isConnected });
    }

    if (!this.isConnected) {
      if (action === 'set_recording_mode') {
        bridgeLog('ERROR', 'send() called but extension not connected');
      }
      throw new Error(
        'Chrome extension is not connected. Make sure:\n' +
        '1. The Woodbury Bridge extension is installed in Chrome\n' +
        '2. Chrome is running\n' +
        '3. The extension popup shows "Connected"'
      );
    }

    const id = `req_${++this.requestCounter}_${Date.now()}`;
    const request: BridgeRequest = { id, action, params };

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const err = new Error(`Request timed out after ${(timeout || REQUEST_TIMEOUT) / 1000}s: ${action}`);
        if (action === 'set_recording_mode') {
          bridgeLog('ERROR', 'set_recording_mode TIMED OUT', { timeout: timeout || REQUEST_TIMEOUT });
        }
        reject(err);
      }, timeout || REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve: resolve as any, reject, timer });

      // Use whichever WebSocket is available: direct client or piggyback
      const ws = (this.client && this.client.readyState === WebSocket.OPEN)
        ? this.client
        : this.piggybackWs;

      try {
        ws!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send request: ${(err as Error).message}`));
      }
    });
  }

  /**
   * Toggle recording mode in the Chrome extension.
   * When enabled, the content script captures click/input/keyboard events
   * and sends them back as 'recording_event' messages.
   */
  async setRecordingMode(enabled: boolean, mode?: 'standard' | 'accessibility'): Promise<any> {
    return this.send('set_recording_mode', { enabled, mode });
  }

  private handleMessage(message: any): void {
    // Hello message from the extension
    if (message.type === 'hello') {
      this.emit('hello', message);
      return;
    }

    // Recording event from the Chrome extension content script
    if (message.type === 'recording_event') {
      this.emit('recording_event', message);
      return;
    }

    // Page elements snapshot for ML training data
    if (message.type === 'page_elements_snapshot') {
      this.emit('page_elements_snapshot', message);
      return;
    }

    // Response to a pending request
    const { id } = message;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(new Error(message.error));
      } else if (message.success === false) {
        pending.reject(new Error(message.error || 'Request failed'));
      } else {
        pending.resolve(message.data || message);
      }
      return;
    }

    // If we're in server mode and this is a request from a subscriber (has id + action),
    // forward it to the Chrome extension. The response will come back through the normal
    // message handler and get forwarded to subscribers in the connection handler above.
    if (id && message.action && this.client && this.client.readyState === WebSocket.OPEN) {
      bridgeLog('INFO', 'Forwarding subscriber request to extension', { id, action: message.action });
      try {
        this.client.send(JSON.stringify(message));
      } catch {
        // Failed to forward
      }
    }
  }
}

// Singleton instance
export const bridgeServer = new BridgeServer();

/**
 * Ensure the bridge server is running. Safe to call multiple times.
 */
export async function ensureBridgeServer(port?: number): Promise<BridgeServer> {
  if (!bridgeServer.isStarted) {
    try {
      await bridgeServer.start(port);
      bridgeLog('INFO', 'Bridge server started as owner (listening)');
    } catch (err: any) {
      // If port is in use, connect as a client to the existing server
      if (err.message?.includes('already in use')) {
        bridgeLog('INFO', 'Port in use, connecting as piggyback client');
        try {
          await bridgeServer.connectAsClient(port || DEFAULT_PORT);
          bridgeLog('INFO', 'Piggyback connection established');
        } catch (clientErr: any) {
          bridgeLog('ERROR', 'Failed to piggyback on existing bridge', { error: String(clientErr) });
          // Swallow — we tried our best
        }
      } else {
        throw err;
      }
    }
  }
  return bridgeServer;
}
