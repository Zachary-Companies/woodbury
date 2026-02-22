/**
 * Debug Log
 *
 * File-based debug logging for Woodbury. Writes timestamped log entries
 * to ~/.woodbury/logs/ so you can review them after a session.
 *
 * Activated by:
 *   - `--debug` CLI flag
 *   - `WOODBURY_DEBUG=1` environment variable
 *
 * Log files:
 *   ~/.woodbury/logs/woodbury-<YYYY-MM-DD>-<HHmmss>.log
 *
 * Usage:
 *   import { debugLog } from './debug-log.js';
 *   debugLog.info('startup', 'Woodbury starting');
 *   debugLog.debug('repl', 'Processing input', { input: 'hello' });
 *   debugLog.error('agent', 'Failed to run', { error: err.message });
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOGS_DIR = join(homedir(), '.woodbury', 'logs');
const MAX_LOG_FILES = 10;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
}

class DebugLog {
  private enabled: boolean = false;
  private logFilePath: string = '';
  private sessionId: string = '';

  /**
   * Initialize the debug logger. Creates the log directory and log file.
   * Call this once at startup after parsing CLI flags.
   */
  init(enabled: boolean = false): void {
    this.enabled = enabled || !!process.env.WOODBURY_DEBUG;

    if (!this.enabled) return;

    // Ensure logs directory exists
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Create log file with timestamp in name
    const now = new Date();
    const datePart = now.toISOString().replace(/T/, '-').replace(/[:.]/g, '').slice(0, 15);
    this.sessionId = datePart;
    this.logFilePath = join(LOGS_DIR, `woodbury-${datePart}.log`);

    // Rotate old logs (keep only the most recent MAX_LOG_FILES)
    this.rotateOldLogs();

    // Write session header
    this.writeRaw([
      '════════════════════════════════════════════════════════════════',
      `  Woodbury Debug Log`,
      `  Session: ${this.sessionId}`,
      `  Started: ${now.toISOString()}`,
      `  PID: ${process.pid}`,
      `  Node: ${process.version}`,
      `  Platform: ${process.platform} ${process.arch}`,
      `  CWD: ${process.cwd()}`,
      '════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'));
  }

  /** Check if debug logging is active */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Get the current log file path (for /log command) */
  get filePath(): string {
    return this.logFilePath;
  }

  /** Get the logs directory */
  get logsDir(): string {
    return LOGS_DIR;
  }

  // ── Log methods ────────────────────────────────────────────

  debug(category: string, message: string, data?: any): void {
    this.write('debug', category, message, data);
  }

  info(category: string, message: string, data?: any): void {
    this.write('info', category, message, data);
  }

  warn(category: string, message: string, data?: any): void {
    this.write('warn', category, message, data);
  }

  error(category: string, message: string, data?: any): void {
    this.write('error', category, message, data);
  }

  /**
   * Log with a timing measurement. Returns a function to call when done.
   * Usage:
   *   const done = debugLog.time('startup', 'Loading extensions');
   *   // ... do work ...
   *   done();  // logs "Loading extensions (took 123ms)"
   */
  time(category: string, message: string): () => void {
    if (!this.enabled) return () => {};
    const start = Date.now();
    this.write('info', category, `${message} ...`);
    return () => {
      const elapsed = Date.now() - start;
      this.write('info', category, `${message} (took ${elapsed}ms)`);
    };
  }

  /**
   * Log a section divider for readability.
   */
  section(title: string): void {
    if (!this.enabled) return;
    this.writeRaw(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}\n`);
  }

  // ── Internal ───────────────────────────────────────────────

  private write(level: LogLevel, category: string, message: string, data?: any): void {
    if (!this.enabled) return;

    const now = new Date();
    const ts = now.toISOString();
    const lvl = level.toUpperCase().padEnd(5);
    const cat = category.padEnd(12);

    let line = `[${ts}] ${lvl} [${cat}] ${message}`;

    if (data !== undefined) {
      try {
        const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        // Indent multiline data
        if (serialized.includes('\n')) {
          line += '\n' + serialized.split('\n').map(l => '    ' + l).join('\n');
        } else {
          line += ` | ${serialized}`;
        }
      } catch {
        line += ` | [unserializable: ${typeof data}]`;
      }
    }

    this.writeRaw(line + '\n');
  }

  private writeRaw(text: string): void {
    if (!this.enabled || !this.logFilePath) return;

    try {
      // Check file size before writing
      if (existsSync(this.logFilePath)) {
        const stats = statSync(this.logFilePath);
        if (stats.size > MAX_LOG_SIZE_BYTES) {
          // Truncate notice and stop writing to this file
          appendFileSync(this.logFilePath, '\n[LOG TRUNCATED — file size limit reached]\n');
          this.enabled = false;
          return;
        }
      }
      appendFileSync(this.logFilePath, text);
    } catch {
      // Silently fail — don't let logging break the app
    }
  }

  private rotateOldLogs(): void {
    try {
      const files = readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('woodbury-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: join(LOGS_DIR, f),
          mtime: statSync(join(LOGS_DIR, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      // Delete old logs beyond the limit
      if (files.length >= MAX_LOG_FILES) {
        const toDelete = files.slice(MAX_LOG_FILES - 1); // keep space for new file
        for (const f of toDelete) {
          try {
            unlinkSync(f.path);
          } catch {
            // ignore deletion failures
          }
        }
      }
    } catch {
      // ignore rotation errors
    }
  }
}

// Singleton — imported everywhere, initialized once at startup
export const debugLog = new DebugLog();
