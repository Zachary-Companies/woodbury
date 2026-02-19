import chalk from 'chalk';
import { colors, icons, labels } from './colors';

export class WoodburyLogger {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  info(message: string, ...args: any[]): void {
    if (this.verbose) {
      console.log(`${icons.info}  ${colors.info(message)}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`${icons.warning}  ${colors.warning(message)}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`${icons.error}  ${colors.error(message)}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    if (this.verbose) {
      console.log(`${colors.muted('🔍')}  ${colors.dim(message)}`, ...args);
    }
  }

  success(message: string, ...args: any[]): void {
    console.log(`${icons.success}  ${colors.success(message)}`, ...args);
  }

  // Log a tool execution start
  toolStart(toolName: string): void {
    if (this.verbose) {
      console.log(`${icons.toolRun}  ${colors.toolName(toolName)}`);
    }
  }

  // Log a tool execution result
  toolEnd(toolName: string, success: boolean, duration?: number): void {
    if (this.verbose) {
      const status = success 
        ? colors.toolSuccess('completed')
        : colors.toolError('failed');
      const time = duration ? colors.muted(` (${duration}ms)`) : '';
      console.log(`${icons.toolDone}  ${colors.muted(toolName)} ${status}${time}`);
    }
  }
}

// Export a simple logger for files that need it without verbose support
export const logger = {
  info: (message: string, ...args: any[]) => {
    if (process.env.WOODBURY_DEBUG) {
      console.log(`${icons.info}  ${colors.info(message)}`, ...args);
    }
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`${icons.warning}  ${colors.warning(message)}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    console.error(`${icons.error}  ${colors.error(message)}`, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (process.env.WOODBURY_DEBUG) {
      console.log(`${colors.muted('🔍')}  ${colors.dim(message)}`, ...args);
    }
  },
  success: (message: string, ...args: any[]) => {
    console.log(`${icons.success}  ${colors.success(message)}`, ...args);
  }
};
