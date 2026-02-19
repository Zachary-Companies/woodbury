import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import type { Renderer, RunStats, TerminalRenderer as ITerminalRenderer } from './types';
import { colors, icons, labels, format } from './colors';

export type { Renderer, RunStats, TerminalRenderer } from './types';

// Configure marked for terminal output with custom theme
marked.setOptions({
  renderer: new TerminalRenderer({
    // Code blocks
    code: chalk.hex('#A5D6FF'),
    codespan: chalk.hex('#A5D6FF').bgHex('#1F2937'),
    // Headings
    heading: chalk.hex('#C4B5FD').bold,
    // Links
    href: chalk.hex('#60A5FA').underline,
    // Lists
    listitem: chalk.white,
    // Tables
    tableOptions: {
      chars: {
        top: '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
        bottom: '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
        left: '│', 'left-mid': '├', mid: '─', 'mid-mid': '┼',
        right: '│', 'right-mid': '┤', middle: '│'
      }
    },
    // Emphasis
    strong: chalk.bold,
    em: chalk.italic,
    // Block quotes
    blockquote: chalk.hex('#9CA3AF').italic,
    // Horizontal rule
    hr: chalk.hex('#4B5563'),
    // Other
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 100),
    showSectionPrefix: false,
    tab: 2,
  })
});

export class ConsoleRenderer implements ITerminalRenderer {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  renderMessage(content: string, type: 'user' | 'assistant' | 'system' = 'assistant'): void {
    const { icon, label, contentColor } = this.getMessageStyle(type);
    
    console.log();
    console.log(`${icon}  ${label}`);
    console.log(colors.dim('─'.repeat(40)));
    
    if (type === 'assistant') {
      // Render markdown for assistant messages
      const rendered = marked(content);
      console.log(rendered);
    } else {
      console.log(contentColor(content));
    }
  }
  
  renderError(error: string | Error): void {
    const message = error instanceof Error ? error.message : error;
    console.log();
    console.log(`${icons.error}  ${labels.error}`);
    console.log(colors.dim('─'.repeat(40)));
    console.log(colors.error(message));
    console.log();
  }
  
  renderStats(stats: RunStats): void {
    if (!this.verbose) return;
    
    const parts: string[] = [];
    
    if (stats.totalTimeMs) {
      parts.push(format.duration(stats.totalTimeMs));
    }
    
    if (stats.iterations) {
      parts.push(format.count(stats.iterations, 'iteration'));
    }
    
    if (stats.tokenUsage) {
      parts.push(format.count(stats.tokenUsage.totalTokens, 'token'));
    }
    
    if (parts.length > 0) {
      console.log();
      console.log(`${colors.muted('📊')}  ${colors.muted('Stats:')} ${parts.join(colors.dim(' • '))}`);
    }
  }
  
  renderToolCall(toolName: string, params: any): void {
    if (!this.verbose) return;
    
    console.log();
    console.log(`${icons.tool}  ${colors.toolName.bold(toolName)}`);
    
    if (params && Object.keys(params).length > 0) {
      const paramStr = this.formatParams(params);
      console.log(colors.dim('   ') + paramStr);
    }
  }
  
  renderToolResult(result: any): void {
    if (!this.verbose) return;
    
    if (result.success) {
      console.log(`   ${icons.success} ${colors.toolSuccess('completed')}`);
      if (result.data && this.verbose) {
        const preview = this.truncate(JSON.stringify(result.data), 200);
        console.log(colors.dim(`   ${preview}`));
      }
    } else {
      console.log(`   ${icons.error} ${colors.toolError('failed')}`);
      if (result.error) {
        console.log(colors.toolError(`   ${result.error}`));
      }
    }
  }

  renderThinking(): void {
    console.log();
    console.log(`${icons.thinking}  ${colors.muted('Thinking...')}`);
  }

  clearThinking(): void {
    // Move cursor up and clear line
    process.stdout.write('\x1b[1A\x1b[2K');
  }

  renderDivider(style: 'heavy' | 'light' | 'dots' = 'light'): void {
    const width = Math.min(process.stdout.columns || 80, 60);
    const chars = {
      heavy: '━',
      light: '─',
      dots: '·'
    };
    console.log(colors.dim(chars[style].repeat(width)));
  }
  
  private getMessageStyle(type: 'user' | 'assistant' | 'system') {
    switch (type) {
      case 'user':
        return {
          icon: icons.user,
          label: labels.you,
          contentColor: colors.text
        };
      case 'assistant':
        return {
          icon: icons.assistant,
          label: labels.woodbury,
          contentColor: colors.text
        };
      case 'system':
        return {
          icon: icons.system,
          label: labels.system,
          contentColor: colors.textMuted
        };
      default:
        return {
          icon: '',
          label: '',
          contentColor: colors.text
        };
    }
  }

  private formatParams(params: any): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return '';
    
    if (entries.length <= 3) {
      // Inline format for few params
      return entries
        .map(([k, v]) => `${colors.muted(k)}${colors.dim(':')} ${colors.secondary(this.truncate(String(v), 30))}`)
        .join(colors.dim(' · '));
    }
    
    // Multi-line for many params
    return '\n' + entries
      .map(([k, v]) => `     ${colors.muted(k)}${colors.dim(':')} ${colors.secondary(this.truncate(String(v), 50))}`)
      .join('\n');
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + colors.dim('...');
  }

  // Logger interface methods
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
}
