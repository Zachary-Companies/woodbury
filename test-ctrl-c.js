#!/usr/bin/env node

/**
 * Manual test script for Ctrl+C functionality
 * Run this script and press Ctrl+C to test signal handling
 */

import { SignalHandler } from './dist/signals.js';

console.log('Testing Ctrl+C functionality...');
console.log('Press Ctrl+C to test graceful shutdown');
console.log('Press Ctrl+C twice quickly to test force exit');
console.log('This process will exit after 30 seconds if no signal is received\n');

// Set up signal handling
const signalHandler = SignalHandler.getInstance();
signalHandler.setupHandlers();

// Keep the process running
setInterval(() => {
  console.log(`Process running... (PID: ${process.pid})`);
}, 5000);

// Auto-exit after 30 seconds for testing
setTimeout(() => {
  console.log('\nTest timeout reached, exiting...');
  process.exit(0);
}, 30000);
