#!/usr/bin/env node

/**
 * Simple entry point for Woodbury that focuses on core functionality
 * without complex orchestration features.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { startRepl } from './repl';
import { runOneShot } from './one-shot';
import type { WoodburyConfig } from './types';
import { SignalHandler } from './signals';

const program = new Command();

// Get package.json for version info
let packageJson: any;
try {
  packageJson = require('../package.json');
} catch {
  packageJson = { version: '1.0.0' };
}

program
  .name('woodbury')
  .description('AI coding assistant')
  .version(packageJson.version)
  .option('-v, --verbose', 'enable verbose logging', false)
  .option('-m, --model <model>', 'LLM model to use', 'gpt-4');

// Setup signal handling
const signalHandler = SignalHandler.getInstance();
signalHandler.setupHandlers();

// Interactive mode
program
  .command('repl')
  .description('Start interactive session')
  .action(async () => {
    const opts = program.opts();
    const config: WoodburyConfig = {
      verbose: opts.verbose,
      model: opts.model,
      workingDirectory: process.cwd(),
      apiKeys: {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        groq: process.env.GROQ_API_KEY
      }
    };
    
    try {
      await startRepl(config);
    } catch (error) {
      console.error(chalk.red('Failed to start REPL:'), error);
      process.exit(1);
    }
  });

// One-shot mode
program
  .command('run <prompt>')
  .description('Execute a single prompt')
  .action(async (prompt: string) => {
    const opts = program.opts();
    const config: WoodburyConfig = {
      verbose: opts.verbose,
      model: opts.model,
      workingDirectory: process.cwd(),
      apiKeys: {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        groq: process.env.GROQ_API_KEY
      }
    };
    
    try {
      await runOneShot(prompt, config);
    } catch (error) {
      console.error(chalk.red('Execution failed:'), error);
      process.exit(1);
    }
  });

// Default to REPL if no command provided
if (process.argv.length === 2) {
  program.parse([...process.argv, 'repl']);
} else {
  program.parse();
}
