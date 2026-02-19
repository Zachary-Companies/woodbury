/**
 * Simple logger for woodbury CLI when dependencies are missing
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export class SimpleLogger implements Logger {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  debug(msg: string, _data?: Record<string, unknown>): void {
    if (this.verbose) {
      console.log(`[DEBUG] ${msg}`);
    }
  }

  info(msg: string, _data?: Record<string, unknown>): void {
    if (this.verbose) {
      console.log(`[INFO] ${msg}`);
    }
  }

  warn(msg: string, _data?: Record<string, unknown>): void {
    console.warn(`[WARN] ${msg}`);
  }

  error(msg: string, _data?: Record<string, unknown>): void {
    console.error(`[ERROR] ${msg}`);
  }
}

// Export a default logger instance
export const logger = new SimpleLogger(false);