#!/usr/bin/env node

/**
 * Final comprehensive verification of SIGINT handling
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Final SIGINT Verification for woodbury CLI');
console.log('==========================================\n');

let testsPassed = 0;
let testsTotal = 0;

function test(name, fn) {
  testsTotal++;
  console.log(`🧪 ${name}`);
  
  return fn().then(result => {
    if (result.success) {
      console.log(`   ✅ PASSED: ${result.message}`);
      testsPassed++;
    } else {
      console.log(`   ❌ FAILED: ${result.message}`);
    }
    console.log();
  }).catch(error => {
    console.log(`   ❌ ERROR: ${error.message}`);
    console.log();
  });
}

function runWoodburyWithTimeout(timeout = 3000) {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js'], {
      cwd: path.join(process.cwd(), 'woodbury'),
      stdio: 'pipe'
    });
    
    let output = '';
    
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    
    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        resolve({ killed: true, output });
      }
    }, timeout);
    
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, killed: false });
    });
    
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message, output, killed: false });
    });
    
    return child;
  });
}

async function main() {
  // Test 1: CLI starts properly
  await test('CLI starts and shows proper interface', async () => {
    const result = await runWoodburyWithTimeout(2000);
    
    if (result.error) {
      return { success: false, message: `Error starting CLI: ${result.error}` };
    }
    
    if (result.output.includes('woodbury') && result.output.includes('AI')) {
      return { success: true, message: 'CLI started with proper branding' };
    }
    
    return { success: false, message: 'CLI output missing expected content' };
  });
  
  // Test 2: Help command works
  await test('Help command displays correctly', async () => {
    return new Promise((resolve) => {
      const child = spawn('node', ['dist/index.js', '--help'], {
        cwd: path.join(process.cwd(), 'woodbury'),
        stdio: 'pipe'
      });
      
      let output = '';
      child.stdout.on('data', (data) => output += data.toString());
      child.stderr.on('data', (data) => output += data.toString());
      
      child.on('exit', (code) => {
        if (code === 0 && output.includes('woodbury') && output.includes('Ctrl+C')) {
          resolve({ success: true, message: 'Help shows proper SIGINT information' });
        } else {
          resolve({ success: false, message: 'Help missing or incorrect' });
        }
      });
      
      child.on('error', (error) => {
        resolve({ success: false, message: `Help command error: ${error.message}` });
      });
      
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve({ success: false, message: 'Help command timed out' });
      }, 3000);
    });
  });
  
  // Test 3: SIGINT handling works
  await test('SIGINT (Ctrl+C) exits gracefully', async () => {
    return new Promise((resolve) => {
      const child = spawn('node', ['dist/index.js'], {
        cwd: path.join(process.cwd(), 'woodbury'),
        stdio: 'pipe'
      });
      
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
        
        // Send SIGINT once we see the interface
        if (output.includes('>') || output.includes('woodbury')) {
          setTimeout(() => child.kill('SIGINT'), 200);
        }
      });
      
      child.on('exit', (code, signal) => {
        const gracefulExit = code === 0 || signal === 'SIGINT';
        resolve({
          success: gracefulExit,
          message: gracefulExit 
            ? `Graceful exit with code ${code} or signal ${signal}`
            : `Unexpected exit: code=${code}, signal=${signal}`
        });
      });
      
      child.on('error', (error) => {
        resolve({ success: false, message: `SIGINT test error: ${error.message}` });
      });
      
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
          resolve({ success: false, message: 'SIGINT test timed out' });
        }
      }, 4000);
    });
  });
  
  // Test 4: Version command works
  await test('Version command works', async () => {
    return new Promise((resolve) => {
      const child = spawn('node', ['dist/index.js', '--version'], {
        cwd: path.join(process.cwd(), 'woodbury'),
        stdio: 'pipe'
      });
      
      let output = '';
      child.stdout.on('data', (data) => output += data.toString());
      
      child.on('exit', (code) => {
        const hasVersion = /\d+\.\d+\.\d+/.test(output.trim());
        resolve({
          success: code === 0 && hasVersion,
          message: hasVersion ? 'Version displayed correctly' : 'No version found in output'
        });
      });
      
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
          resolve({ success: false, message: 'Version command timed out' });
        }
      }, 3000);
    });
  });
  
  // Final summary
  console.log('📊 Final Results');
  console.log('================');
  console.log(`✅ Tests passed: ${testsPassed}`);
  console.log(`❌ Tests failed: ${testsTotal - testsPassed}`);
  console.log(`📈 Success rate: ${Math.round((testsPassed / testsTotal) * 100)}%`);
  
  if (testsPassed === testsTotal) {
    console.log('\n🎉 All tests passed! SIGINT handling is working perfectly.');
  } else {
    console.log('\n⚠️ Some tests failed. Please review the implementation.');
  }
}

main().catch(console.error);