#!/usr/bin/env node

// Manual test to verify Ctrl+C functionality in woodbury
// Run this with: node manual-sigint-test.js
// Then try pressing Ctrl+C to see if it exits gracefully

import { startRepl } from './dist/repl.js';
import { TerminalRenderer } from './dist/renderer.js';
import { WoodburyLogger } from './dist/logger.js';

const config = {
  model: 'claude-sonnet-4-20250514',
  verbose: false,
  safe: false,
  workingDirectory: process.cwd(),
  contextDir: undefined,
  maxOutputTokens: undefined,
  maxSubagentDepth: undefined,
  orchestrate: undefined,
  jobsFile: undefined,
  maxTokenBudget: undefined,
  enableSemanticMemory: false,
};

const renderer = new TerminalRenderer(config.verbose);
const logger = new WoodburyLogger(renderer);

console.log('🧪 Testing SIGINT handling...');
console.log('📝 Instructions:');
console.log('   1. Wait for woodbury prompt to appear');
console.log('   2. Press Ctrl+C once - should show "Press Ctrl+C again to exit"');
console.log('   3. Press Ctrl+C again - should exit gracefully');
console.log('   4. If it hangs, the test failed');
console.log('');

startRepl(config, renderer, logger).catch(err => {
  console.error('Error starting REPL:', err);
  process.exit(1);
});
