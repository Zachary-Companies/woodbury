#!/usr/bin/env node

import { WoodburyLogger } from './logger';
import type { WoodburyConfig } from './types';
import { colors, icons, labels } from './colors';

// Re-export main functionality
export { startRepl } from './repl';
export { runOneShot } from './one-shot';
export { orchestrateJobs } from './orchestrate';
export type { WoodburyConfig, AgentResult } from './types';

// Re-export colors and styling utilities
export { colors, icons, labels, format, box } from './colors';
export { ConsoleRenderer } from './renderer';
export { WoodburyLogger, logger } from './logger';

// Re-export extension API types (for extension authors: import { ... } from 'woodbury')
export type {
  WoodburyExtension,
  ExtensionContext,
  ExtensionSlashCommand,
  ExtensionCommandContext,
  WebUIOptions,
  WebUIHandle,
  ExtensionLogger,
} from './extension-api';
export type { ToolDefinition, ToolHandler } from './extension-api';

// Main entry point
// In Electron, require.main !== module, so also check for Electron process type
const isElectron = !!(process.versions as any).electron;
if (require.main === module || isElectron) {
  if (isElectron) {
    // When loaded as Electron's main entry in dev mode (npx electron .),
    // delegate to the proper Electron main process file
    require('../electron/main');
  } else {
  // Check if this is being run directly
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // No arguments, start CLI
    require('./cli');
  } else {
    // Check for special cases
    const command = args[0];
    
    if (command === '--version' || command === '-v') {
      // Show version
      try {
        const packageJson = require('../package.json');
        console.log(`${icons.assistant}  ${colors.primary.bold('woodbury')} ${colors.muted('v' + packageJson.version)}`);
      } catch {
        console.log(`${icons.assistant}  ${colors.primary.bold('woodbury')} ${colors.muted('v1.0.0')}`);
      }
      process.exit(0);
    } else if (command === '--help' || command === '-h') {
      // Show help
      console.log(`
${colors.primary.bold('Woodbury')} ${colors.muted('- Interactive AI Coding Assistant')}

${colors.textBright('Usage:')}
  ${colors.secondary('woodbury')}                    Start interactive session
  ${colors.secondary('woodbury repl')}               Start interactive session
  ${colors.secondary('woodbury run "<prompt>"')}     Execute a single prompt
  ${colors.secondary('woodbury orchestrate <file>')} Orchestrate jobs from file
  
${colors.textBright('Options:')}
  ${colors.secondary('-v, --verbose')}            Enable verbose logging
  ${colors.secondary('-m, --model <model>')}      LLM model to use
  ${colors.secondary('--working-directory <path>')} Set working directory
  ${colors.secondary('--max-iterations <num>')}   Maximum agent iterations
  ${colors.secondary('--timeout <ms>')}           Timeout in milliseconds
  ${colors.secondary('--safe')}                   Enable safe mode
  
${colors.textBright('Environment Variables:')}
  ${colors.muted('OPENAI_API_KEY')}          OpenAI API key
  ${colors.muted('ANTHROPIC_API_KEY')}       Anthropic API key  
  ${colors.muted('GROQ_API_KEY')}            Groq API key
`);
      process.exit(0);
    } else {
      // Delegate to CLI
      require('./cli');
    }
  }
  } // close non-Electron branch
}

// Setup process handlers
process.on('unhandledRejection', (reason, promise) => {
  const logger = new WoodburyLogger(false);
  logger.error('Unhandled promise rejection:', reason as any);
  process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
  const logger = new WoodburyLogger(false);
  logger.error('Uncaught exception:', error);
  process.exit(1);
});
