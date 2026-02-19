import * as readline from 'readline';
import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { setupSIGINTHandler } from './signals.js';
import type { WoodburyConfig } from './types.js';
import { createAgent } from './agent-factory.js';

// Configure marked to render markdown in terminal
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,
    width: process.stdout.columns || 80,
    showSectionPrefix: false,
    tab: 2
  }) as any
});

function formatOutput(content: string): string {
  try {
    return marked.parse(content) as string;
  } catch {
    return content;
  }
}

function printDivider(char: string = '─', color: typeof chalk.gray = chalk.gray): void {
  const width = Math.min(process.stdout.columns || 80, 80);
  console.log(color(char.repeat(width)));
}

function printBanner(): void {
  console.log();
  console.log(chalk.cyan.bold('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('  ║') + chalk.white.bold('     🤖 Woodbury Simple REPL             ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('  ╚═══════════════════════════════════════╝'));
  console.log();
  console.log(chalk.gray('  Type ') + chalk.yellow('help') + chalk.gray(' for commands, or ') + chalk.yellow('exit') + chalk.gray(' to quit.'));
  console.log();
  printDivider();
  console.log();
}

function printHelp(): void {
  console.log();
  printDivider();
  console.log(chalk.cyan.bold('📚 Woodbury Simple REPL Commands:'));
  console.log();
  console.log(chalk.white('  help    ') + chalk.gray('- Show this help message'));
  console.log(chalk.white('  clear   ') + chalk.gray('- Clear the screen'));
  console.log(chalk.white('  exit    ') + chalk.gray('- Exit the REPL'));
  console.log(chalk.white('  quit    ') + chalk.gray('- Exit the REPL'));
  console.log();
  console.log(chalk.gray('  Or just type your request and press Enter!'));
  printDivider();
  console.log();
}

export async function startSimpleRepl(config: WoodburyConfig): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan.bold('woodbury> ')
  });

  // Setup signal handling for graceful shutdown
  setupSIGINTHandler(rl);

  printBanner();

  let agent: any = null;
  
  try {
    console.log(chalk.yellow('⏳ Initializing agent...'));
    agent = await createAgent(config);
    console.log(chalk.green('✅ Agent ready!\n'));
  } catch (error) {
    console.log();
    console.log(chalk.red.bold('❌ Failed to initialize agent:'));
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    console.log();
    process.exit(1);
  }

  rl.prompt();

  rl.on('line', async (input) => {
    const trimmedInput = input.trim();
    
    if (!trimmedInput) {
      rl.prompt();
      return;
    }
    
    const lowerInput = trimmedInput.toLowerCase();
    
    if (lowerInput === 'exit' || lowerInput === 'quit') {
      console.log();
      console.log(chalk.cyan('👋 Goodbye! Thanks for using Woodbury.'));
      console.log();
      rl.close();
      process.exit(0);
    }

    if (lowerInput === 'help') {
      printHelp();
      rl.prompt();
      return;
    }

    if (lowerInput === 'clear') {
      console.clear();
      rl.prompt();
      return;
    }

    try {
      // Show user input
      console.log();
      console.log(chalk.blue.bold('👤 You:'));
      console.log(chalk.white(trimmedInput));
      console.log();
      
      const startTime = Date.now();
      
      // Show thinking indicator
      console.log(chalk.yellow('🤔 Thinking...'));
      
      const result = await agent.run(trimmedInput);
      const duration = Date.now() - startTime;
      
      // Clear thinking line and show response
      process.stdout.write('\x1b[1A\x1b[2K'); // Move up and clear line
      
      printDivider();
      console.log(chalk.green.bold('🤖 Woodbury:'));
      console.log();
      
      // Format and display the content with markdown
      const formattedContent = formatOutput(result.content);
      console.log(formattedContent);
      
      // Show metadata if verbose mode
      if (config.verbose && result.metadata) {
        printDivider('·', chalk.dim);
        console.log(chalk.dim(
          `📊 Stats: ${chalk.cyan(duration + 'ms')} • ` +
          `${chalk.cyan(result.metadata.iterations + ' iterations')} • ` +
          `${chalk.cyan((result.toolCalls?.length || 0) + ' tool calls')}`
        ));
      }
      
      printDivider();
      console.log();
      
    } catch (error) {
      // Clear thinking line if still showing
      process.stdout.write('\x1b[1A\x1b[2K');
      
      console.log();
      console.log(chalk.red.bold('❌ Error:'));
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      console.log();
    }
    
    rl.prompt();
  });

  rl.on('close', () => {
    console.log();
    console.log(chalk.cyan('👋 Goodbye! Thanks for using Woodbury.'));
    console.log();
    process.exit(0);
  });
}
