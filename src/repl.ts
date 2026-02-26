import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { WoodburyConfig, SlashCommand, SlashCommandContext } from './types';
import { logger } from './logger';
import { createAgent, AgentHandle } from './agent-factory';
import { colors, icons, labels, format, box, markdownTheme } from './colors';
import { slashCommands } from './slash-commands.js';
import { FileConversationManager } from './conversation.js';
import { compactContext } from './context-compactor.js';
import type { ExtensionManager } from './extension-manager.js';
import type { DashboardHandle } from './config-dashboard.js';
import { GO_HOSTNAME, type GoLinksHandle } from './go-links.js';
import { debugLog } from './debug-log.js';
import { ensureBridgeServer } from './bridge-server.js';

// Configure marked to render markdown in terminal with theme-aware colors
marked.setOptions({
  renderer: new TerminalRenderer({
    ...markdownTheme,
    // Layout
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 100),
    showSectionPrefix: false,
    tab: 2
  }) as any
});

// Strip ANSI escape codes to get visible character count
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * TerminalLayout manages a fixed-bottom input prompt with a scrolling
 * output region above it, using VT100 DECSTBM scroll regions.
 */
class TerminalLayout {
  private rows: number = 0;
  private cols: number = 0;
  private active: boolean = false;
  private currentInput: string = '';
  private cursorPos: number = 0;
  private promptPrefix: string = '';
  private promptPrefixLen: number = 0;
  // Buffer for streaming text that hasn't been flushed with a newline yet
  private streamBuffer: string = '';
  // Column position tracking for the streaming line at the bottom of scroll region
  private streamCol: number = 0;

  setup(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.active = true;

    this.promptPrefix = colors.primary.bold('❯ ');
    this.promptPrefixLen = stripAnsi(this.promptPrefix).length;

    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');

    // Set scroll region: rows 1 to (rows-2), leaving last row for prompt
    const scrollBottom = this.rows - 1;
    process.stdout.write(`\x1b[1;${scrollBottom}r`);

    // Move cursor to prompt row and draw it
    this.redrawPrompt();
  }

  teardown(): void {
    if (!this.active) return;
    this.active = false;

    // Reset scroll region
    process.stdout.write('\x1b[r');
    // Show cursor
    process.stdout.write('\x1b[?25h');
    // Move to bottom
    process.stdout.write(`\x1b[${this.rows};1H`);
    process.stdout.write('\n');
  }

  /**
   * Write a complete line of text into the scroll region.
   * The text appears above the fixed prompt.
   */
  writeLine(text: string): void {
    if (!this.active) {
      process.stdout.write(text + '\n');
      return;
    }

    // Hide cursor to prevent flicker
    process.stdout.write('\x1b[?25l');

    // If we have buffered stream content, flush it first
    if (this.streamBuffer.length > 0) {
      this.flushStreamLine();
    }

    const scrollBottom = this.rows - 1;

    // Split text by newlines and write each line
    const lines = text.split('\n');
    for (const line of lines) {
      // Move to bottom of scroll region, then newline to scroll up
      process.stdout.write(`\x1b[${scrollBottom};1H`);
      process.stdout.write('\n');
      // Clear the new line and write content
      process.stdout.write('\x1b[2K');
      process.stdout.write(line);
    }

    // Redraw prompt
    this.redrawPrompt();
    // Show cursor
    process.stdout.write('\x1b[?25h');
  }

  /**
   * Write raw streaming text into the scroll region.
   * Buffers characters until a newline, then scrolls up.
   * Used for token-by-token streaming of agent responses.
   */
  writeRaw(text: string): void {
    if (!this.active) {
      process.stdout.write(text);
      return;
    }

    process.stdout.write('\x1b[?25l');

    const scrollBottom = this.rows - 1;

    for (const char of text) {
      if (char === '\n') {
        // Flush the current stream buffer as a complete line
        this.flushStreamLine();
      } else {
        // Accumulate in buffer and display live at the bottom of scroll region
        this.streamBuffer += char;
        this.streamCol++;

        // Update the display: write the buffer at the bottom of scroll region
        process.stdout.write(`\x1b[${scrollBottom};1H`);
        process.stdout.write('\x1b[2K');
        process.stdout.write(this.streamBuffer);
      }
    }

    this.redrawPrompt();
    process.stdout.write('\x1b[?25h');
  }

  /**
   * Flush the current stream buffer as a completed line.
   * The buffer content is already visible at the bottom of the scroll region
   * (written char-by-char in writeRaw). We just need to scroll it up and
   * clear the buffer so the next line starts fresh.
   */
  private flushStreamLine(): void {
    const scrollBottom = this.rows - 1;

    // Move to bottom of scroll region and scroll up.
    // The \n scrolls the existing content (already displayed) up into the
    // scroll history. Do NOT re-write the buffer — it's already visible.
    process.stdout.write(`\x1b[${scrollBottom};1H`);
    process.stdout.write('\n');
    // Clear the new empty line at the bottom (ready for next content)
    process.stdout.write('\x1b[2K');

    this.streamBuffer = '';
    this.streamCol = 0;
  }

  /**
   * Redraw the prompt row at the bottom of the terminal.
   * Handles long input by showing a sliding window around the cursor.
   */
  redrawPrompt(): void {
    if (!this.active) return;

    const maxInputWidth = this.cols - this.promptPrefixLen;
    let displayInput = this.currentInput;
    let displayCursorPos = this.cursorPos;

    if (displayInput.length > maxInputWidth) {
      // Show a window of text around the cursor position
      let start = this.cursorPos - Math.floor(maxInputWidth / 2);
      if (start < 0) start = 0;
      if (start + maxInputWidth > displayInput.length) {
        start = Math.max(0, displayInput.length - maxInputWidth);
      }
      displayInput = displayInput.slice(start, start + maxInputWidth);
      displayCursorPos = this.cursorPos - start;
    }

    // Move to prompt row (last row)
    process.stdout.write(`\x1b[${this.rows};1H`);
    // Clear the line
    process.stdout.write('\x1b[2K');
    // Draw prompt + visible portion of input
    process.stdout.write(this.promptPrefix + displayInput);
    // Position cursor
    const cursorCol = this.promptPrefixLen + displayCursorPos + 1;
    process.stdout.write(`\x1b[${this.rows};${cursorCol}H`);
  }

  /**
   * Update the current input text and cursor position, then redraw prompt.
   */
  updateInput(input: string, cursorPos: number): void {
    this.currentInput = input;
    this.cursorPos = cursorPos;
    this.redrawPrompt();
  }

  /**
   * Handle terminal resize by recalculating scroll region.
   */
  onResize(): void {
    if (!this.active) return;

    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    // Reset scroll region
    const scrollBottom = this.rows - 1;
    process.stdout.write(`\x1b[1;${scrollBottom}r`);

    // Redraw prompt at new position
    this.redrawPrompt();
  }

  isActive(): boolean {
    return this.active;
  }

  getRows(): number {
    return this.rows;
  }

  getCols(): number {
    return this.cols;
  }
}

export interface ReplOptions {
  config: WoodburyConfig;
  prompt?: string;
  extensionManager?: ExtensionManager;
  dashboardHandle?: DashboardHandle;
  goLinksHandle?: GoLinksHandle;
}

export class Repl {
  private layout: TerminalLayout;
  private agent: AgentHandle | null = null;
  private running: boolean = false;
  private config: WoodburyConfig;
  private conversationManager: FileConversationManager;
  private abortController: AbortController | null = null;

  // Raw stdin input state
  private currentInput: string = '';
  private cursorPos: number = 0;
  private inputResolve: ((value: string) => void) | null = null;
  private stdinListener: ((data: Buffer) => void) | null = null;

  // Paste detection
  private pasteBuffer: string = '';
  private pasteTimeout: NodeJS.Timeout | null = null;
  private isInPasteMode: boolean = false;
  private readonly PASTE_THRESHOLD_MS = 50;
  private readonly PASTE_SETTLE_MS = 100;
  private lastCharTime: number = 0;

  // Command history
  private history: string[] = [];
  private historyIndex: number = -1;
  private savedInput: string = '';

  // Ctrl+C tracking
  private lastCtrlCTime: number = 0;

  // Flag for non-TTY fallback
  private isTTY: boolean;

  // Extension system
  private extensionManager?: ExtensionManager;
  private allSlashCommands: SlashCommand[];

  // Background task message queue
  private pendingBackgroundMessages: Array<{ message: string; extensionName: string }> = [];
  private backgroundWakeResolve: (() => void) | null = null;
  private agentRunning: boolean = false;

  constructor(private options: ReplOptions) {
    this.config = options.config;
    this.conversationManager = new FileConversationManager(
      options.config.workingDirectory || process.cwd()
    );
    this.layout = new TerminalLayout();
    this.isTTY = !!process.stdin.isTTY;
    this.extensionManager = options.extensionManager;

    // Merge built-in slash commands with extension-provided ones
    this.allSlashCommands = [
      ...slashCommands,
      ...(this.extensionManager?.getAllCommands() || []),
    ];
  }

  private print(text: string): void {
    this.layout.writeLine(text);
  }

  private printRaw(text: string): void {
    this.layout.writeRaw(text);
  }

  private async ensureAgent(): Promise<AgentHandle> {
    if (!this.agent) {
      debugLog.info('repl', 'Initializing agent (first use)');
      this.print(`${icons.running}  ${colors.muted('Initializing agent...')}`);
      const doneAgent = debugLog.time('repl', 'Agent initialization');
      this.agent = await createAgent(this.config, this.extensionManager);
      doneAgent();
      this.print(`${icons.complete}  ${colors.success('Agent ready')}`);
      this.print('');
    }
    return this.agent;
  }

  private formatOutput(content: string): string {
    try {
      return marked.parse(content) as string;
    } catch {
      return content;
    }
  }

  private printDivider(style: 'heavy' | 'light' | 'dots' = 'light'): void {
    const width = Math.min(this.layout.getCols() || 80, 60);
    const chars = {
      heavy: '━',
      light: '─',
      dots: '·'
    };
    this.print(colors.dim(chars[style].repeat(width)));
  }

  private async handleSlashCommand(input: string): Promise<boolean> {
    if (!input.startsWith('/')) return false;

    const parts = input.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const cmd = this.allSlashCommands.find(c => c.name === cmdName);
    if (!cmd) {
      debugLog.warn('repl', `Unknown slash command: /${cmdName}`);
      this.print(`${icons.error}  ${colors.error(`Unknown command: /${cmdName}`)}`);
      this.print(colors.muted('  Type /help to see available commands'));
      return true;
    }

    debugLog.info('repl', `Executing slash command: /${cmdName}`, { args });

    const ctx: SlashCommandContext = {
      config: this.config,
      workingDirectory: this.config.workingDirectory || process.cwd(),
      agent: this.agent ? {
        getTools: () => this.agent!.getTools(),
        stop: () => this.agent!.stop()
      } : undefined,
      print: (msg: string) => this.print(msg),
      extensionManager: this.extensionManager
    };

    try {
      await cmd.handler(args, ctx);
    } catch (error) {
      this.print(`${icons.error}  ${colors.error(`Command failed: ${error}`)}`);
    }

    return true;
  }

  private buildConversationContext(userMessage: string): string {
    const allTurns = this.conversationManager.getTurns();
    if (allTurns.length === 0) {
      return userMessage;
    }

    const turns = compactContext(allTurns, 400000, 30);

    let historyXml = '<conversation_history>\n';
    for (const turn of turns) {
      historyXml += `<turn role="${turn.role}">\n${turn.content}\n</turn>\n`;
    }
    historyXml += '</conversation_history>\n\n';

    return historyXml + userMessage;
  }

  /**
   * Wait for a line of input from the user using raw stdin.
   */
  private waitForInput(): Promise<string> {
    return new Promise((resolve) => {
      this.inputResolve = resolve;
      this.currentInput = '';
      this.cursorPos = 0;
      this.historyIndex = -1;
      this.savedInput = '';
      this.layout.updateInput('', 0);
    });
  }

  /**
   * Wait for a background task to produce a message.
   * Resolves when backgroundWakeResolve is called.
   */
  private waitForBackgroundWake(): Promise<void> {
    return new Promise((resolve) => {
      this.backgroundWakeResolve = resolve;
    });
  }

  /**
   * Called by the extension manager when a background task produces a message.
   */
  private onBackgroundMessage(message: string, extensionName: string): void {
    this.pendingBackgroundMessages.push({ message, extensionName });
    // Wake the main loop if it's waiting
    if (this.backgroundWakeResolve) {
      const resolve = this.backgroundWakeResolve;
      this.backgroundWakeResolve = null;
      resolve();
    }
  }

  /**
   * Handle a raw keypress from stdin.
   */
  private handleKeypress(data: Buffer): void {
    // If we're waiting for paste confirmation, handle that separately
    if (this.isInPasteMode) {
      this.handlePasteConfirmKey(data);
      return;
    }

    const now = Date.now();

    // Ctrl+C
    if (data.length === 1 && data[0] === 0x03) {
      if (this.abortController) {
        // Abort running agent
        this.print('');
        this.print(`${icons.warning}  ${colors.warning('Aborting...')}`);
        this.abortController.abort();
        this.abortController = null;
      } else {
        // Double Ctrl+C to exit — 2 second window
        if (now - this.lastCtrlCTime < 2000) {
          this.stop();
          return;
        }
        this.lastCtrlCTime = now;
        this.print('');
        this.print(colors.muted('  Press Ctrl+C again to exit'));
        // Clear input
        this.currentInput = '';
        this.cursorPos = 0;
        this.layout.updateInput('', 0);
      }
      return;
    }

    // Ctrl+D — exit
    if (data.length === 1 && data[0] === 0x04) {
      this.stop();
      return;
    }

    // Enter — submit input
    if (data.length === 1 && (data[0] === 0x0d || data[0] === 0x0a)) {
      if (this.pasteTimeout) {
        // We have buffered paste data — flush it
        clearTimeout(this.pasteTimeout);
        this.pasteTimeout = null;
        this.finalizePasteDetection();
        return;
      }
      const input = this.currentInput;
      if (input.trim()) {
        this.history.push(input);
      }
      this.currentInput = '';
      this.cursorPos = 0;
      this.layout.updateInput('', 0);
      if (this.inputResolve) {
        const resolve = this.inputResolve;
        this.inputResolve = null;
        resolve(input);
      }
      return;
    }

    // Backspace
    if (data.length === 1 && data[0] === 0x7f) {
      if (this.cursorPos > 0) {
        this.currentInput = this.currentInput.slice(0, this.cursorPos - 1) + this.currentInput.slice(this.cursorPos);
        this.cursorPos--;
        this.layout.updateInput(this.currentInput, this.cursorPos);
      }
      return;
    }

    // Escape sequences
    if (data[0] === 0x1b) {
      const seq = data.toString();

      // Arrow keys
      if (seq === '\x1b[D') {
        // Left arrow
        if (this.cursorPos > 0) {
          this.cursorPos--;
          this.layout.updateInput(this.currentInput, this.cursorPos);
        }
        return;
      }
      if (seq === '\x1b[C') {
        // Right arrow
        if (this.cursorPos < this.currentInput.length) {
          this.cursorPos++;
          this.layout.updateInput(this.currentInput, this.cursorPos);
        }
        return;
      }
      if (seq === '\x1b[A') {
        // Up arrow — history
        if (this.history.length > 0) {
          if (this.historyIndex === -1) {
            this.savedInput = this.currentInput;
            this.historyIndex = this.history.length - 1;
          } else if (this.historyIndex > 0) {
            this.historyIndex--;
          }
          this.currentInput = this.history[this.historyIndex];
          this.cursorPos = this.currentInput.length;
          this.layout.updateInput(this.currentInput, this.cursorPos);
        }
        return;
      }
      if (seq === '\x1b[B') {
        // Down arrow — history
        if (this.historyIndex !== -1) {
          if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.currentInput = this.history[this.historyIndex];
          } else {
            this.historyIndex = -1;
            this.currentInput = this.savedInput;
          }
          this.cursorPos = this.currentInput.length;
          this.layout.updateInput(this.currentInput, this.cursorPos);
        }
        return;
      }
      if (seq === '\x1b[H' || seq === '\x1b[1~') {
        // Home
        this.cursorPos = 0;
        this.layout.updateInput(this.currentInput, this.cursorPos);
        return;
      }
      if (seq === '\x1b[F' || seq === '\x1b[4~') {
        // End
        this.cursorPos = this.currentInput.length;
        this.layout.updateInput(this.currentInput, this.cursorPos);
        return;
      }
      if (seq === '\x1b[3~') {
        // Delete key
        if (this.cursorPos < this.currentInput.length) {
          this.currentInput = this.currentInput.slice(0, this.cursorPos) + this.currentInput.slice(this.cursorPos + 1);
          this.layout.updateInput(this.currentInput, this.cursorPos);
        }
        return;
      }

      // Escape alone — ignore
      if (data.length === 1) return;

      // Unknown escape sequence — ignore
      return;
    }

    // Printable characters — handle paste detection
    const str = data.toString('utf8');
    const timeSinceLastChar = now - this.lastCharTime;
    this.lastCharTime = now;

    // Check for pasted content (contains newlines or arrives very fast)
    if (str.includes('\n') || str.includes('\r')) {
      // Multi-line paste detected
      this.pasteBuffer += str;
      if (this.pasteTimeout) clearTimeout(this.pasteTimeout);
      this.pasteTimeout = setTimeout(() => {
        this.pasteTimeout = null;
        this.finalizePasteDetection();
      }, this.PASTE_SETTLE_MS);
      return;
    }

    if (this.pasteTimeout) {
      // We're accumulating paste data
      this.pasteBuffer += str;
      clearTimeout(this.pasteTimeout);
      this.pasteTimeout = setTimeout(() => {
        this.pasteTimeout = null;
        this.finalizePasteDetection();
      }, this.PASTE_SETTLE_MS);
      return;
    }

    // Normal typing — insert at cursor
    this.currentInput = this.currentInput.slice(0, this.cursorPos) + str + this.currentInput.slice(this.cursorPos);
    this.cursorPos += str.length;
    this.layout.updateInput(this.currentInput, this.cursorPos);
  }

  /**
   * Finalize paste detection — decide if the buffered input is a paste or normal typing.
   */
  private finalizePasteDetection(): void {
    const content = this.pasteBuffer;
    this.pasteBuffer = '';

    // Check if it contains newlines (actual multi-line paste)
    if (content.includes('\n') || content.includes('\r')) {
      const lines = content.split(/\r?\n/).filter(l => l.length > 0 || content.includes('\n'));
      if (lines.length > 1) {
        this.showPastedContent(lines);
        return;
      }
    }

    // Single line — just insert it normally
    this.currentInput = this.currentInput.slice(0, this.cursorPos) + content + this.currentInput.slice(this.cursorPos);
    this.cursorPos += content.length;
    this.layout.updateInput(this.currentInput, this.cursorPos);
  }

  /**
   * Show pasted content preview and wait for confirmation.
   */
  private showPastedContent(lines: string[]): void {
    this.isInPasteMode = true;

    const lineCount = lines.length;
    this.print(colors.dim('─'.repeat(40)));
    this.print(colors.muted(`  📋 Pasted ${lineCount} line${lineCount > 1 ? 's' : ''}:`));
    this.print(colors.dim('─'.repeat(40)));

    const maxPreviewLines = 10;
    const showLines = lines.slice(0, maxPreviewLines);
    showLines.forEach((line, i) => {
      const lineNum = colors.dim(`${(i + 1).toString().padStart(3)} │`);
      const truncatedLine = line.length > 60 ? line.slice(0, 57) + '...' : line;
      this.print(`${lineNum} ${colors.text(truncatedLine)}`);
    });

    if (lineCount > maxPreviewLines) {
      this.print(colors.dim(`    │ ... and ${lineCount - maxPreviewLines} more lines`));
    }

    this.print(colors.dim('─'.repeat(40)));
    this.print(colors.muted('  Press ') + colors.secondary('Enter') + colors.muted(' to submit, ') + colors.secondary('Esc') + colors.muted(' to cancel'));

    // Store the lines for submission
    this.currentInput = lines.join('\n');
    this.cursorPos = this.currentInput.length;
  }

  /**
   * Handle keypress during paste confirmation mode.
   */
  private handlePasteConfirmKey(data: Buffer): void {
    // Enter — submit paste
    if (data.length === 1 && (data[0] === 0x0d || data[0] === 0x0a)) {
      this.isInPasteMode = false;
      const input = this.currentInput;
      this.currentInput = '';
      this.cursorPos = 0;
      this.layout.updateInput('', 0);
      if (this.inputResolve) {
        const resolve = this.inputResolve;
        this.inputResolve = null;
        resolve(input);
      }
      return;
    }

    // Escape or Ctrl+C — cancel paste
    if ((data.length === 1 && data[0] === 0x1b) || (data.length === 1 && data[0] === 0x03)) {
      this.isInPasteMode = false;
      this.print(colors.warning('  Paste cancelled'));
      this.currentInput = '';
      this.cursorPos = 0;
      this.layout.updateInput('', 0);
      return;
    }
  }

  private async processInput(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!trimmed) return;

    if (trimmed === 'exit' || trimmed === 'quit') {
      this.stop();
      return;
    }

    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      await this.handleSlashCommand(trimmed);
      return;
    }

    if (trimmed === 'help') {
      this.printHelp();
      return;
    }

    if (trimmed === 'clear') {
      this.conversationManager.clear();
      // Re-setup layout (clears screen)
      this.layout.teardown();
      this.layout.setup();
      this.printBanner();
      return;
    }

    try {
      debugLog.info('repl', 'Processing user input', { length: trimmed.length, preview: trimmed.slice(0, 100) });
      logger.debug('Processing REPL input', { input: trimmed });

      this.print('');
      this.print(`${icons.user}  ${labels.you}`);
      this.printDivider('light');
      // Print each line of user input
      for (const line of trimmed.split('\n')) {
        this.print(colors.text(line));
      }
      this.print('');

      const agent = await this.ensureAgent();
      const startTime = Date.now();

      this.abortController = new AbortController();

      const messageWithHistory = this.buildConversationContext(trimmed);

      // Enable streaming: only show content inside <final_answer> tags.
      // Intermediate iterations (reasoning, tool calls) are suppressed to avoid
      // duplicate/repeated output when the agent does multiple iterations.
      let headerPrinted = false;
      let isStreaming = false;
      let tagBuffer = '';
      let insideTag = false;
      let insideFinalAnswer = false;
      let insideToolCall = false;

      agent.setOnToken((token: string) => {
        for (const char of token) {
          if (char === '<') {
            insideTag = true;
            tagBuffer = '<';
            continue;
          }
          if (insideTag) {
            tagBuffer += char;
            if (char === '>') {
              insideTag = false;

              // Detect opening/closing of known XML blocks
              if (/^<final_answer>$/i.test(tagBuffer)) {
                insideFinalAnswer = true;
                tagBuffer = '';
                continue;
              }
              if (/^<\/final_answer>$/i.test(tagBuffer)) {
                insideFinalAnswer = false;
                tagBuffer = '';
                continue;
              }
              if (/^<tool_call>$/i.test(tagBuffer)) {
                insideToolCall = true;
                tagBuffer = '';
                continue;
              }
              if (/^<\/tool_call>$/i.test(tagBuffer)) {
                insideToolCall = false;
                tagBuffer = '';
                continue;
              }
              // Other known XML tags (name, parameters, tool_result) — suppress
              if (/^<\/?(name|parameters|tool_result)[^>]*>$/.test(tagBuffer)) {
                tagBuffer = '';
                continue;
              }

              // Unknown tag — if we're inside final_answer, flush it as content
              if (insideFinalAnswer && !insideToolCall) {
                if (!headerPrinted) {
                  this.print(`${icons.assistant}  ${labels.woodbury}`);
                  this.printDivider('light');
                  this.print('');
                  headerPrinted = true;
                  isStreaming = true;
                }
                this.printRaw(tagBuffer);
              }
              tagBuffer = '';
            }
            continue;
          }

          // Regular content — only stream if inside <final_answer>
          if (insideFinalAnswer && !insideToolCall) {
            if (!headerPrinted) {
              this.print(`${icons.assistant}  ${labels.woodbury}`);
              this.printDivider('light');
              this.print('');
              headerPrinted = true;
              isStreaming = true;
            }
            this.printRaw(char);
          }
        }
      });

      const result = await agent.run(messageWithHistory, this.abortController.signal);

      // Clear the onToken callback
      agent.setOnToken(undefined);
      this.abortController = null;

      const duration = Date.now() - startTime;

      // If we streamed content, finish the line
      if (isStreaming) {
        this.print('');
        this.print('');
      }

      // If we didn't stream (e.g. no streaming support), render normally
      if (!headerPrinted) {
        this.print(`${icons.assistant}  ${labels.woodbury}`);
        this.printDivider('light');
        this.print('');
        const formattedContent = this.formatOutput(result.content);
        for (const line of formattedContent.split('\n')) {
          this.print(line);
        }
      }

      this.conversationManager.addTurn({
        id: `user-${Date.now()}`,
        timestamp: new Date(),
        role: 'user',
        content: trimmed
      });
      this.conversationManager.addTurn({
        id: `assistant-${Date.now()}`,
        timestamp: new Date(),
        role: 'assistant',
        content: result.content
      });

      debugLog.info('repl', 'Response complete', {
        duration: `${duration}ms`,
        iterations: result.metadata?.iterations,
        toolCalls: result.toolCalls?.length || 0,
        streamed: isStreaming,
        contentLength: result.content?.length || 0,
      });

      if (this.config.verbose && result.metadata) {
        this.print('');
        this.printDivider('dots');
        const stats = [
          format.duration(duration),
          format.count(result.metadata.iterations, 'iteration'),
          format.count(result.toolCalls?.length || 0, 'tool call')
        ].join(colors.dim(' • '));
        this.print(`${colors.muted('📊')}  ${stats}`);
      }

      this.print('');
      this.printDivider('heavy');
      this.print('');

    } catch (error) {
      this.abortController = null;

      if (error instanceof Error && error.name === 'AbortError') {
        debugLog.info('repl', 'Request aborted by user (Ctrl+C)');
        this.print('');
        this.print(`${icons.warning}  ${colors.warning('Request aborted')}`);
        this.print('');
      } else {
        debugLog.error('repl', 'REPL execution error', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        logger.error('REPL execution error:', error);
        this.print('');
        this.print(`${icons.error}  ${labels.error}`);
        this.printDivider('light');
        this.print(colors.error(error instanceof Error ? error.message : String(error)));
        this.print('');
      }
    }
  }

  private printHelp(): void {
    this.print('');
    this.printDivider('heavy');
    this.print('');
    this.print(`${colors.primary.bold('📚  Woodbury Commands')}`);
    this.print('');

    const builtinCommands = [
      ['help', 'Show this help message'],
      ['clear', 'Clear screen and conversation'],
      ['exit/quit', 'Exit the REPL']
    ];

    this.print(colors.secondary.bold('  Built-in:'));
    builtinCommands.forEach(([cmd, desc]) => {
      this.print(`    ${colors.secondary(cmd.padEnd(12))} ${colors.muted(desc)}`);
    });

    this.print('');
    this.print(colors.secondary.bold('  Slash Commands:'));
    slashCommands.forEach(cmd => {
      this.print(`    ${colors.secondary(('/' + cmd.name).padEnd(12))} ${colors.muted(cmd.description)}`);
    });

    this.print('');
    this.print(colors.secondary.bold('  Multi-line Input:'));
    this.print(colors.muted('    Paste multi-line text to see a preview,'));
    this.print(colors.muted('    then press Enter to submit or Esc to cancel.'));
    this.print('');
    this.print(colors.secondary.bold('  Keyboard:'));
    this.print(colors.muted('    Ctrl+C (x2)   Exit'));
    this.print(colors.muted('    Ctrl+C         Abort running agent'));
    this.print(colors.muted('    Up/Down        Command history'));
    this.print('');
    this.printDivider('heavy');
    this.print('');
  }

  private printBanner(): void {
    this.print('');
    this.print(colors.primary.bold('  ┌─────────────────────────────────────────┐'));
    this.print(colors.primary.bold('  │') + colors.textBright.bold('        🤖  Woodbury AI Assistant        ') + colors.primary.bold('│'));
    this.print(colors.primary.bold('  └─────────────────────────────────────────┘'));
    this.print('');
    this.print(colors.muted('  Type ') + colors.secondary('/help') + colors.muted(' for commands, or ') + colors.secondary('exit') + colors.muted(' to quit.'));
    if (this.config.dashboardUrl) {
      const goUrl = this.config.goLinksUrl ? `${colors.secondary(`${GO_HOSTNAME}/config`)} ${colors.muted('→')} ` : '';
      this.print(colors.muted('  Config: ') + goUrl + colors.secondary(this.config.dashboardUrl));
    }
    this.print('');
    this.printDivider('heavy');
    this.print('');
  }

  async start(): Promise<void> {
    // Start bridge server early so Chrome extension can connect immediately
    // (don't wait for first agent creation)
    ensureBridgeServer().catch((err) => {
      debugLog.warn('repl', 'Bridge server failed to start at REPL init', { error: String(err) });
    });

    await this.conversationManager.load();
    const turns = this.conversationManager.getTurns();
    debugLog.info('repl', 'Conversation history loaded', { turns: turns.length });

    this.running = true;
    debugLog.info('repl', 'REPL started', { isTTY: this.isTTY, slashCommands: this.allSlashCommands.map(c => c.name) });
    logger.info('Starting Woodbury REPL. Type "exit" or "quit" to stop.');

    if (this.isTTY) {
      // TTY mode: use TerminalLayout with raw stdin
      this.layout.setup();
      this.printBanner();

      // Put stdin in raw mode — do NOT set encoding so we get Buffer objects
      process.stdin.setRawMode(true);
      process.stdin.resume();

      this.stdinListener = (data: Buffer) => {
        this.handleKeypress(data);
      };
      process.stdin.on('data', this.stdinListener as any);

      // Handle resize
      process.stdout.on('resize', () => this.layout.onResize());

      // Wire background task messages
      if (this.extensionManager) {
        this.extensionManager.setOnBackgroundMessage(
          (msg, ext) => this.onBackgroundMessage(msg, ext)
        );
        this.extensionManager.startBackgroundTasks();
        debugLog.info('repl', 'Background tasks started');
      }

      // Main input loop with background task support
      while (this.running) {
        // Drain any pending background messages first
        while (this.pendingBackgroundMessages.length > 0 && this.running) {
          const { message, extensionName } = this.pendingBackgroundMessages.shift()!;
          debugLog.info('repl', `Processing background message from ${extensionName}`, {
            preview: message.slice(0, 100),
          });
          this.print('');
          this.print(`${icons.running}  ${colors.muted(`[${extensionName}] Background task`)}`);
          this.agentRunning = true;
          await this.processInput(message);
          this.agentRunning = false;
        }

        if (!this.running) break;

        // Wait for either user input or a background wake signal
        const inputPromise = this.waitForInput();
        const bgWakePromise = this.waitForBackgroundWake();

        const winner = await Promise.race([
          inputPromise.then(input => ({ type: 'input' as const, input })),
          bgWakePromise.then(() => ({ type: 'background' as const, input: '' })),
        ]);

        if (!this.running) break;

        if (winner.type === 'input') {
          // Cancel the background wake since user input won
          this.backgroundWakeResolve = null;
          this.agentRunning = true;
          await this.processInput(winner.input);
          this.agentRunning = false;
        } else {
          // Background wake won — cancel the pending input wait so the user's
          // input state is preserved. The inputResolve stays set; when the
          // background message finishes processing, the loop will call
          // waitForInput() which resets it. But the user's typed characters
          // in currentInput are lost on reset. To avoid this, we DON'T call
          // waitForInput() again — instead we reuse the existing promise.
          // However, Promise.race already consumed the shape. The simplest
          // approach: clear inputResolve so handleKeypress Enter does nothing
          // for the stale promise, then loop back. The user's partial input
          // is visually preserved (currentInput stays) and the next
          // waitForInput() call will reset it properly.
          this.inputResolve = null;
        }
      }
    } else {
      // Non-TTY fallback: read from stdin line by line
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '❯ '
      });

      this.printBanner();
      rl.prompt();

      return new Promise((resolve) => {
        rl.on('line', async (input: string) => {
          await this.processInput(input);
          if (this.running) rl.prompt();
        });
        rl.on('close', () => {
          this.running = false;
          resolve();
        });
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    debugLog.section('SHUTDOWN');
    debugLog.info('repl', 'REPL stopping');

    this.running = false;

    // Stop background tasks
    if (this.extensionManager) {
      this.extensionManager.stopBackgroundTasks();
    }
    // Wake the background wait so the main loop can exit
    if (this.backgroundWakeResolve) {
      const resolve = this.backgroundWakeResolve;
      this.backgroundWakeResolve = null;
      resolve();
    }
    this.pendingBackgroundMessages = [];

    await this.conversationManager.save();
    debugLog.info('repl', 'Conversation saved');

    // Close config dashboard
    if (this.options.dashboardHandle) {
      await this.options.dashboardHandle.close();
    }

    // Close go-links proxy
    if (this.options.goLinksHandle) {
      await this.options.goLinksHandle.close();
    }

    // Deactivate all extensions (close web servers, etc.)
    if (this.extensionManager) {
      debugLog.info('repl', 'Deactivating extensions');
      await this.extensionManager.deactivateAll();
    }

    // Teardown layout before printing goodbye
    this.layout.teardown();

    // Clean up stdin
    if (this.stdinListener) {
      process.stdin.removeListener('data', this.stdinListener as any);
      this.stdinListener = null;
    }
    if (this.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    debugLog.info('repl', 'REPL stopped — goodbye');
    logger.info('Stopping Woodbury REPL');
    console.log();
    console.log(`${icons.success}  ${colors.primary('Goodbye! Thanks for using Woodbury.')}`);
    console.log();

    // Resolve any pending input
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }

    process.exit(0);
  }

  isRunning(): boolean {
    return this.running;
  }
}

export async function startRepl(
  config: WoodburyConfig,
  extensionManager?: ExtensionManager,
  dashboardHandle?: DashboardHandle,
  goLinksHandle?: GoLinksHandle
): Promise<void> {
  const repl = new Repl({ config, extensionManager, dashboardHandle, goLinksHandle });
  return repl.start();
}

export default Repl;
