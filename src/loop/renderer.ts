export interface RenderOptions {
  showSpinner?: boolean;
  color?: 'green' | 'yellow' | 'red' | 'blue' | 'cyan' | 'magenta' | 'gray';
}

export interface Renderer {
  render(message: string, options?: RenderOptions): void;
  success(message: string): void;
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
  debug?(message: string): void;
  toolStart?(toolName: string, params?: any): void;
  toolEnd?(toolName: string, success: boolean, result?: string): void;
  thinking?(message?: string): void;
  clearThinking?(): void;
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
  cyan: '\x1b[38;2;6;182;212m',        // Cyan
  magenta: '\x1b[38;2;168;85;247m',    // Purple
  gray: '\x1b[38;2;107;114;128m',      // Gray
  pink: '\x1b[38;2;244;114;182m',      // Pink
  white: '\x1b[37m',
};

const colorize = (text: string, color: keyof typeof ansi): string => 
  `${ansi[color]}${text}${ansi.reset}`;

const icons = {
  success: colorize('✓', 'green'),
  error: colorize('✗', 'red'),
  warning: colorize('⚠', 'yellow'),
  info: colorize('ℹ', 'blue'),
  debug: colorize('🔍', 'gray'),
  tool: colorize('⚡', 'pink'),
  toolDone: colorize('◼', 'green'),
  thinking: colorize('◌', 'gray'),
};

export class ConsoleRenderer implements Renderer {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  render(message: string, options: RenderOptions = {}): void {
    if (options.color) {
      console.log(colorize(message, options.color));
    } else {
      console.log(message);
    }
  }

  success(message: string): void {
    console.log(`${icons.success}  ${colorize(message, 'green')}`);
  }

  error(message: string): void {
    console.error(`${icons.error}  ${colorize(message, 'red')}`);
  }

  warning(message: string): void {
    console.warn(`${icons.warning}  ${colorize(message, 'yellow')}`);
  }

  info(message: string): void {
    console.info(`${icons.info}  ${colorize(message, 'blue')}`);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(`${icons.debug}  ${colorize(message, 'gray')}`);
    }
  }

  toolStart(toolName: string, params?: any): void {
    if (this.verbose) {
      const paramStr = params ? colorize(` ${JSON.stringify(params)}`, 'gray') : '';
      console.log(`${icons.tool}  ${colorize(toolName, 'pink')}${paramStr}`);
    }
  }

  toolEnd(toolName: string, success: boolean, result?: string): void {
    if (this.verbose) {
      const status = success 
        ? colorize('completed', 'green')
        : colorize('failed', 'red');
      console.log(`${icons.toolDone}  ${colorize(toolName, 'gray')} ${status}`);
    }
  }

  thinking(message: string = 'Thinking...'): void {
    console.log(`${icons.thinking}  ${colorize(message, 'gray')}`);
  }

  clearThinking(): void {
    // Move cursor up one line and clear it
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

export const createRenderer = (verbose: boolean = false): ConsoleRenderer => {
  return new ConsoleRenderer(verbose);
};
