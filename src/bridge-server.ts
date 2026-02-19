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

const DEFAULT_PORT = 7865;
const REQUEST_TIMEOUT = 15000; // 15 seconds

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
  private client: WebSocket | null = null;
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
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
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
          // We only accept one client (the Chrome extension).
          // If a second client connects, drop the old one.
          if (this.client && this.client.readyState === WebSocket.OPEN) {
            this.client.close();
          }

          this.client = ws;
          this.emit('connected');

          ws.on('message', (raw: Buffer) => {
            try {
              const message = JSON.parse(raw.toString());
              this.handleMessage(message);
            } catch (err) {
              // Ignore malformed messages
            }
          });

          ws.on('close', () => {
            if (this.client === ws) {
              this.client = null;
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
    if (!this.isConnected) {
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
        reject(new Error(`Request timed out after ${(timeout || REQUEST_TIMEOUT) / 1000}s: ${action}`));
      }, timeout || REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve: resolve as any, reject, timer });

      try {
        this.client!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to send request: ${(err as Error).message}`));
      }
    });
  }

  private handleMessage(message: any): void {
    // Hello message from the extension
    if (message.type === 'hello') {
      this.emit('hello', message);
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
    } catch (err: any) {
      // If port is in use, we can still try to use the existing server
      if (err.message?.includes('already in use')) {
        // Silently continue — another Woodbury instance has the server
      } else {
        throw err;
      }
    }
  }
  return bridgeServer;
}
