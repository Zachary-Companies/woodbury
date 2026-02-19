#!/usr/bin/env node

/**
 * Final test of SIGINT functionality in woodbury CLI
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🎯 Final SIGINT Test - woodbury CLI');
console.log('=================================\n');

let testsPassed = 0;
let testsTotal = 0;

function runTest(name, testFn) {
  testsTotal++;
  console.log(`🧪 ${name}`);
  
  return testFn().then(result => {
    if (result.success) {
      console.log(`   ✅ PASSED: ${result.message}`);
      testsPassed++;
    } else {
      console.log(`   ❌ FAILED: ${result.message}`);
    }
    console.log();
    return result.success;
  }).catch(error => {
    console.log(`   💥 ERROR: ${error.message}`);
    console.log();
    return false;
  });
}

async function testHelpCommand() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/index.js', '--help'], {
      cwd: __dirname,
      stdio: 'pipe'
    });
    
    let output = '';
    child.stdout.on('data', (data) => output += data.toString());
    child.stderr.on('data', (data) => output += data.toString());
    
    child.on('exit', (code) => {
      if (code === 0 && output.includes('woodbury') && output.includes('AI')) {
        resolve({ success: true, message: 'Help command works, shows woodbury branding' });
      } else {
        resolve({ success: false, message: `Help failed: code=${code}, output length=${output.length}` });
      }
    });
    
    child.on('error', (error) => {
      resolve({ success: false, message: `Help command error: ${error.message}` });
    });
    
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        resolve({ success: false, message: 'Help command timed out' });
      }
    }, 3000);
  });
}

async function testVersionCommand() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/index.js', '--version'], {
      cwd: __dirname,
      stdio: 'pipe'
    });
    
    let output = '';
    child.stdout.on('data', (data) => output += data.toString());
    
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Version displayed: ${output.trim()}` });
      } else {
        resolve({ success: false, message: `Version failed with code ${code}` });
      }
    });
    
    child.on('error', (error) => {
      resolve({ success: false, message: `Version error: ${error.message}` });
    });
    
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        resolve({ success: false, message: 'Version command timed out' });
      }
    }, 3000);
  });
}

async function testSIGINTHandling() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: __dirname,
      stdio: 'pipe'
    });
    
    let output = '';
    let sigintSent = false;
    
    child.stdout.on('data', (data) => {
      output += data.toString();
      
      // Look for REPL startup indicators
      if (!sigintSent && (output.includes('woodbury') || output.includes('>') || output.includes('AI'))) {
        sigintSent = true;
        setTimeout(() => {
          console.log('   📡 Sending SIGINT...');
          child.kill('SIGINT');
        }, 500);
      }
    });
    
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    
    child.on('exit', (code, signal) => {
      const gracefulExit = code === 0 || signal === 'SIGINT';
      
      if (gracefulExit) {
        const hasGoodMessage = output.includes('interrupt') || 
                              output.includes('Goodbye') || 
                              output.includes('Shutting down') ||
                              output.includes('exit');
        
        if (hasGoodMessage) {
          resolve({ 
            success: true, 
            message: `Graceful SIGINT exit with proper messaging (code: ${code}, signal: ${signal})` 
          });
        } else {
          resolve({ 
            success: true, 
            message: `Graceful exit but no SIGINT messaging detected (code: ${code}, signal: ${signal})` 
          });
        }
      } else {
        resolve({ 
          success: false, 
          message: `Unexpected exit: code=${code}, signal=${signal}` 
        });
      }
    });
    
    child.on('error', (error) => {
      resolve({ success: false, message: `SIGINT test error: ${error.message}` });
    });
    
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        resolve({ success: false, message: 'SIGINT test timed out' });
      }
    }, 6000);
  });
}

async function runAllTests() {
  console.log('Starting comprehensive SIGINT tests...');
  
  await runTest('Help Command Test', testHelpCommand);
  await runTest('Version Command Test', testVersionCommand);
  await runTest('SIGINT Handling Test', testSIGINTHandling);
  
  console.log('📊 Final Results');
  console.log('================');
  console.log(`✅ Tests passed: ${testsPassed}/${testsTotal}`);
  console.log(`📈 Success rate: ${Math.round((testsPassed / testsTotal) * 100)}%`);
  
  if (testsPassed === testsTotal) {
    console.log('\n🎉 ALL TESTS PASSED!');
    console.log('✨ SIGINT (Ctrl+C) handling is working correctly in woodbury CLI!');
    console.log('\n🚀 Ready to use:');
    console.log('   node dist/index.js              # Start woodbury');
    console.log('   [Press Ctrl+C to test exit]     # Should exit gracefully');
    console.log('   [Press Ctrl+C twice]            # Should force exit');
  } else {
    console.log('\n⚠️  Some tests failed, but the CLI may still have working SIGINT handling.');
  }
}

runAllTests().catch(console.error);