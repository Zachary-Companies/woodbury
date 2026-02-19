#!/usr/bin/env node

// Simple test script to verify SIGINT handling
console.log('Starting SIGINT test...');
console.log('PID:', process.pid);
console.log('Press Ctrl+C to test signal handling');

let sigintCount = 0;

process.on('SIGINT', () => {
  sigintCount++;
  console.log(`\nSIGINT received (${sigintCount})`);
  
  if (sigintCount === 1) {
    console.log('Press Ctrl+C again to exit.');
  } else {
    console.log('Exiting...');
    process.exit(0);
  }
});

// Keep the process alive
setInterval(() => {
  process.stdout.write('.');
}, 1000);
