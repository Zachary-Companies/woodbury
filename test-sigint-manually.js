#!/usr/bin/env node

/**
 * Manual test script for SIGINT (Ctrl+C) handling in woodbury
 * 
 * Instructions:
 * 1. Run this script: node test-sigint-manually.js
 * 2. Press Ctrl+C once - should show graceful exit message
 * 3. Run again and press Ctrl+C twice quickly - should force exit
 */

const { setupSIGINTHandler } = require('./dist/sigint-handler.js');
const readline = require('readline');

console.log('🧪 Manual SIGINT Test for woodbury');
console.log('================================');
console.log('💡 Test scenarios:');
console.log('   1. Press Ctrl+C once - should exit gracefully');
console.log('   2. Press Ctrl+C twice quickly - should force exit');
console.log('   3. Type some text and press Enter, then Ctrl+C');
console.log();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'test> '
});

// Setup the SIGINT handler
setupSIGINTHandler(rl);

console.log('✅ SIGINT handler set up. Starting interactive test...');
console.log('⌨️  Type anything and press Enter, or press Ctrl+C to test exit behavior.');
console.log();

rl.on('line', (input) => {
  if (input.trim()) {
    console.log(`📝 You typed: "${input}"`);
  }
  rl.prompt();
});

rl.on('close', () => {
  console.log('📋 Readline interface closed.');
});

rl.prompt();