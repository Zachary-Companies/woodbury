/**
 * Session Persistence & Crash Recovery
 *
 * Modeled after claw-code-main's session system:
 * - Sessions are recoverable state (messages, usage, permissions, config)
 * - JSON-based persistence for crash recovery
 * - Transcript store with append/compact/replay/flush
 */

import { ParsedToolCall, Logger } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Token usage tracking per turn
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Cumulative usage across the session
 */
export interface SessionUsage {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

/**
 * A single message in the session transcript
 */
export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | SessionContentBlock[];
  usage?: TokenUsage;
  timestamp: number;
}

/**
 * Content block types (matches V2 native format)
 */
export type SessionContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Permission decisions recorded during the session
 */
export interface PermissionDecision {
  toolName: string;
  requiredLevel: string;
  activeLevel: string;
  decision: 'allow' | 'deny' | 'escalate';
  reason?: string;
  timestamp: number;
}

/**
 * Serializable session state
 */
export interface StoredSession {
  version: number;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  config: Record<string, unknown>;
  messages: SessionMessage[];
  usage: SessionUsage;
  permissionDecisions: PermissionDecision[];
  toolCalls: Array<{
    id: string;
    name: string;
    status: 'success' | 'error';
    executionTimeMs: number;
    timestamp: number;
  }>;
  metadata: Record<string, unknown>;
}

/**
 * Session store — persists and recovers agent sessions
 */
export class SessionStore {
  private sessionDir: string;
  private logger: Logger;

  constructor(sessionDir: string, logger?: Logger) {
    this.sessionDir = sessionDir;
    this.logger = logger || console;
  }

  /**
   * Ensure the session directory exists
   */
  private ensureDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Get the file path for a session
   */
  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }

  /**
   * Save a session to disk
   */
  async save(session: StoredSession): Promise<void> {
    this.ensureDir();
    const filePath = this.sessionPath(session.sessionId);
    session.updatedAt = Date.now();

    try {
      // Write to temp file first, then rename (atomic on most filesystems)
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      this.logger.debug?.(`Session saved: ${session.sessionId}`);
    } catch (error) {
      this.logger.error?.(`Failed to save session ${session.sessionId}: ${error}`);
      throw error;
    }
  }

  /**
   * Load a session from disk
   */
  async load(sessionId: string): Promise<StoredSession | null> {
    const filePath = this.sessionPath(sessionId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(raw) as StoredSession;
      this.logger.debug?.(`Session loaded: ${sessionId}`);
      return session;
    } catch (error) {
      this.logger.warn?.(`Failed to load session ${sessionId}: ${error}`);
      return null;
    }
  }

  /**
   * List all saved session IDs (most recent first)
   */
  async list(): Promise<string[]> {
    this.ensureDir();

    try {
      const files = fs.readdirSync(this.sessionDir)
        .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));

      // Sort by modification time descending
      const withStats = files.map(f => ({
        name: f.replace('.json', ''),
        mtime: fs.statSync(path.join(this.sessionDir, f)).mtimeMs,
      }));
      withStats.sort((a, b) => b.mtime - a.mtime);

      return withStats.map(f => f.name);
    } catch {
      return [];
    }
  }

  /**
   * Delete a session
   */
  async delete(sessionId: string): Promise<boolean> {
    const filePath = this.sessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.logger.debug?.(`Session deleted: ${sessionId}`);
      return true;
    }
    return false;
  }

  /**
   * Create a fresh session object
   */
  static createSession(sessionId: string, config?: Record<string, unknown>): StoredSession {
    const now = Date.now();
    return {
      version: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      config: config || {},
      messages: [],
      usage: {
        turns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
      },
      permissionDecisions: [],
      toolCalls: [],
      metadata: {},
    };
  }
}

/**
 * Session manager — tracks live session state and persists periodically
 */
export class SessionManager {
  private session: StoredSession;
  private store: SessionStore;
  private dirty = false;
  private autoSaveInterval?: ReturnType<typeof setInterval>;

  constructor(
    sessionId: string,
    store: SessionStore,
    config?: Record<string, unknown>,
    autoSaveMs: number = 5000
  ) {
    this.session = SessionStore.createSession(sessionId, config);
    this.store = store;

    // Auto-save every N ms if dirty
    if (autoSaveMs > 0) {
      this.autoSaveInterval = setInterval(async () => {
        if (this.dirty) {
          await this.flush();
        }
      }, autoSaveMs);
      // Belt-and-braces: a missed close() should not pin the event loop open and
      // stop a CLI one-shot from exiting. close() still clears it and flushes.
      this.autoSaveInterval.unref?.();
    }
  }

  /**
   * Resume from a previously saved session
   */
  static async resume(
    sessionId: string,
    store: SessionStore,
    autoSaveMs?: number
  ): Promise<SessionManager | null> {
    const saved = await store.load(sessionId);
    if (!saved) return null;

    const mgr = new SessionManager(sessionId, store, saved.config, autoSaveMs);
    mgr.session = saved;
    return mgr;
  }

  /**
   * Append a message to the session
   */
  addMessage(message: SessionMessage): void {
    this.session.messages.push(message);
    this.dirty = true;
  }

  /**
   * Record token usage for a turn
   */
  addUsage(usage: TokenUsage): void {
    this.session.usage.turns++;
    this.session.usage.totalInputTokens += usage.inputTokens;
    this.session.usage.totalOutputTokens += usage.outputTokens;
    this.session.usage.totalCacheCreationTokens += usage.cacheCreationTokens || 0;
    this.session.usage.totalCacheReadTokens += usage.cacheReadTokens || 0;
    this.dirty = true;
  }

  /**
   * Record a permission decision
   */
  addPermissionDecision(decision: PermissionDecision): void {
    this.session.permissionDecisions.push(decision);
    this.dirty = true;
  }

  /**
   * Record a tool call result
   */
  addToolCall(call: {
    id: string;
    name: string;
    status: 'success' | 'error';
    executionTimeMs: number;
  }): void {
    this.session.toolCalls.push({
      ...call,
      timestamp: Date.now(),
    });
    this.dirty = true;
  }

  /**
   * Get the current session state
   */
  getSession(): StoredSession {
    return this.session;
  }

  /**
   * Get all messages (for reconstructing conversation)
   */
  getMessages(): SessionMessage[] {
    return this.session.messages;
  }

  /**
   * Get cumulative usage
   */
  getUsage(): SessionUsage {
    return this.session.usage;
  }

  /**
   * Set metadata
   */
  setMetadata(key: string, value: unknown): void {
    this.session.metadata[key] = value;
    this.dirty = true;
  }

  /**
   * Flush session to disk
   */
  async flush(): Promise<void> {
    if (this.dirty) {
      await this.store.save(this.session);
      this.dirty = false;
    }
  }

  /**
   * Stop auto-save and flush final state
   */
  async close(): Promise<void> {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = undefined;
    }
    await this.flush();
  }
}
