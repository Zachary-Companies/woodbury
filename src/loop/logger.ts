export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

// ANSI color codes for terminal output
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Colors
  green: '\x1b[38;2;16;185;129m',      // Emerald
  red: '\x1b[38;2;239;68;68m',         // Red
  yellow: '\x1b[38;2;245;158;11m',     // Amber
  blue: '\x1b[38;2;59;130;246m',       // Blue
  gray: '\x1b[38;2;107;114;128m',      // Gray
};

const colorize = (text: string, color: keyof typeof ansi): string => 
  `${ansi[color]}${text}${ansi.reset}`;

const icons = {
  debug: colorize('🔍', 'gray'),
  info: colorize('ℹ', 'blue'),
  warn: colorize('⚠', 'yellow'),
  error: colorize('✗', 'red'),
};

const labels = {
  debug: colorize('DEBUG', 'gray'),
  info: colorize('INFO', 'blue'),
  warn: colorize('WARN', 'yellow'),
  error: colorize('ERROR', 'red'),
};

export class ConsoleLogger implements Logger {
  private verbose: boolean;
  private name?: string;

  constructor(verbose: boolean = false, name?: string) {
    this.verbose = verbose;
    this.name = name;
  }

  private formatPrefix(level: 'debug' | 'info' | 'warn' | 'error'): string {
    const nameStr = this.name ? colorize(`[${this.name}]`, 'gray') + ' ' : '';
    return `${icons[level]}  ${nameStr}`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.verbose || process.env.DEBUG) {
      console.debug(`${this.formatPrefix('debug')}${colorize(message, 'gray')}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    console.info(`${this.formatPrefix('info')}${colorize(message, 'blue')}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`${this.formatPrefix('warn')}${colorize(message, 'yellow')}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`${this.formatPrefix('error')}${colorize(message, 'red')}`, ...args);
  }
}

/**
 * A silent logger that discards all messages.
 * Useful for testing or when logging should be disabled.
 */
export class SilentLogger implements Logger {
  debug(_message: string, ..._args: any[]): void {}
  info(_message: string, ..._args: any[]): void {}
  warn(_message: string, ..._args: any[]): void {}
  error(_message: string, ..._args: any[]): void {}
}

export const createLogger = (name?: string, verbose: boolean = false): Logger => {
  return new ConsoleLogger(verbose, name);
};

export const createSilentLogger = (): Logger => {
  return new SilentLogger();
};

/**
 * ANSI escape sequences for terminal control
 */
const ansiControl = {
  clearLine: '\x1b[2K',
  moveUp: (n: number) => `\x1b[${n}A`,
  moveToStart: '\r',
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
};

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Format a number with K/M suffix for compact display
 */
function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface ProgressState {
  iteration: number;
  maxIterations: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  currentTool?: string;
  phase: 'thinking' | 'tool' | 'complete' | 'compacting';
}

/**
 * A progress logger that updates a fixed number of lines in place,
 * creating a progress-bar style display without scrolling.
 */
export class ProgressLogger {
  private spinnerIndex = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private currentState: ProgressState | null = null;
  private lineCount = 2; // Number of lines we're managing
  private isFirstRender = true;
  private verbose: boolean;
  private recentTools: string[] = [];
  private maxRecentTools = 3;
  private stopped = false; // Guard against rendering after stop
  public disabled: boolean; // When true, all output is suppressed

  constructor(disabled: boolean = false) {
    this.verbose = false;
    this.disabled = disabled;
  }

  private getSpinnerChar(): string {
    return spinnerFrames[this.spinnerIndex % spinnerFrames.length];
  }

  private formatLine1(state: ProgressState): string {
    const spinner = state.phase === 'complete' ? colorize('✓', 'green') : colorize(this.getSpinnerChar(), 'blue');
    const iter = colorize(`[${state.iteration}/${state.maxIterations}]`, 'gray');

    let phaseText = '';
    if (state.phase === 'thinking') {
      phaseText = colorize('Thinking...', 'blue');
    } else if (state.phase === 'tool') {
      phaseText = colorize(`Running ${state.currentTool || 'tool'}`, 'yellow');
    } else if (state.phase === 'compacting') {
      phaseText = colorize('Compacting context...', 'yellow');
    } else {
      phaseText = colorize('Complete', 'green');
    }

    let tokenStr = '';
    if (state.inputTokens !== undefined && state.outputTokens !== undefined) {
      tokenStr = colorize(` | in: ${formatTokens(state.inputTokens)} out: ${formatTokens(state.outputTokens)}`, 'gray');
    }
    if (state.totalTokens !== undefined) {
      tokenStr += colorize(` | total: ${formatTokens(state.totalTokens)}`, 'gray');
    }

    return `${spinner} ${iter} ${phaseText}${tokenStr}`;
  }

  private formatLine2(): string {
    if (this.recentTools.length === 0) {
      return colorize('  └─ Ready', 'gray');
    }
    const toolsStr = this.recentTools.slice(-this.maxRecentTools).join(' → ');
    return colorize(`  └─ ${toolsStr}`, 'gray');
  }

  private render(): void {
    if (this.disabled || !this.currentState || this.stopped) return;

    const line1 = this.formatLine1(this.currentState);
    const line2 = this.formatLine2();

    if (this.isFirstRender) {
      // First render - just print the lines
      process.stdout.write(`${line1}\n${line2}`);
      this.isFirstRender = false;
    } else {
      // Move up, clear, and rewrite both lines
      process.stdout.write(
        `${ansiControl.moveToStart}${ansiControl.clearLine}` +
        `${ansiControl.moveUp(1)}${ansiControl.clearLine}` +
        `${line1}\n${line2}`
      );
    }
  }

  /**
   * Start the progress display
   */
  start(initialState?: Partial<ProgressState>): void {
    if (this.disabled) return;
    this.stopped = false; // Reset stopped flag for reuse
    this.currentState = {
      iteration: 0,
      maxIterations: 10,
      phase: 'thinking',
      ...initialState
    };
    this.isFirstRender = true;
    this.recentTools = [];

    // Hide cursor for cleaner display
    process.stdout.write(ansiControl.hideCursor);

    this.render();

    // Start spinner animation
    this.spinnerInterval = setInterval(() => {
      this.spinnerIndex++;
      this.render();
    }, 80);
  }

  /**
   * Update the progress state
   */
  update(state: Partial<ProgressState>): void {
    if (this.disabled) return;
    if (!this.currentState) {
      this.start(state);
      return;
    }

    this.currentState = { ...this.currentState, ...state };

    if (state.currentTool && !this.recentTools.includes(state.currentTool)) {
      this.recentTools.push(state.currentTool);
      if (this.recentTools.length > this.maxRecentTools * 2) {
        // Keep some history but not too much
        this.recentTools = this.recentTools.slice(-this.maxRecentTools);
      }
    }

    this.render();
  }

  /**
   * Log a tool execution (shown in the tool trail)
   */
  logTool(toolName: string): void {
    this.update({ currentTool: toolName, phase: 'tool' });
  }

  /**
   * Mark iteration complete and move to thinking for next iteration
   */
  nextIteration(iteration: number, tokens?: { input?: number; output?: number; total?: number }): void {
    this.update({
      iteration,
      phase: 'thinking',
      inputTokens: tokens?.input,
      outputTokens: tokens?.output,
      totalTokens: tokens?.total,
      currentTool: undefined
    });
    // Clear recent tools for new iteration
    this.recentTools = [];
  }

  /**
   * Stop the progress display and show final state
   */
  stop(finalMessage?: string): void {
    if (this.disabled) return;
    // Prevent any further rendering
    if (this.stopped) return;
    this.stopped = true;

    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    // Clear the progress display completely
    if (!this.isFirstRender) {
      process.stdout.write(
        `${ansiControl.moveToStart}${ansiControl.clearLine}` +
        `${ansiControl.moveUp(1)}${ansiControl.clearLine}`
      );
    }

    // Show cursor again
    process.stdout.write(ansiControl.showCursor);

    // Reset state
    this.currentState = null;

    if (finalMessage) {
      console.log(finalMessage);
    }
  }

  /**
   * Clear the progress display completely
   */
  clear(): void {
    if (this.disabled) return;
    this.stopped = true;

    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    if (!this.isFirstRender) {
      // Clear both lines
      process.stdout.write(
        `${ansiControl.moveToStart}${ansiControl.clearLine}` +
        `${ansiControl.moveUp(1)}${ansiControl.clearLine}`
      );
    }

    process.stdout.write(ansiControl.showCursor);
    this.currentState = null;
    this.isFirstRender = true;
  }
}
