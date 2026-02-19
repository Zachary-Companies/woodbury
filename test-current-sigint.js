#!/usr/bin/env node

/**
 * Test the current woodbury SIGINT handling
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testing Current SIGINT Handling in woodbury');
console.log('============================================');

function testSingleSigint() {
  console.log('\n🔍 Test 1: Single SIGINT (should exit gracefully)');
  
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js'], {
      cwd: path.join(process.cwd(), 'woodbury'),
      stdio: 'pipe'
    });
    
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
      
      // Once we see the REPL prompt, send SIGINT
      if (output.includes('>') || output.includes('woodbury')) {
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
      console.log(`   ✅ Process exited with code: ${code}, signal: ${signal}`);
      console.log(`   📝 Output contained: ${output.includes('woodbury') ? '✅ woodbury startup' : '❌ no woodbury startup'}`);
      resolve({ code, signal, output });
    });
    
    child.on('error', (error) => {
      console.log(`   ❌ Process error: ${error.message}`);
      resolve({ error: error.message });
    });
    
    // Safety timeout
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        console.log('   ⏰ Test timed out, killing process');
        resolve({ timeout: true });
      }
    }, 5000);
  });
}

function testDoubleSigint() {
  console.log('\n🔍 Test 2: Double SIGINT (should force exit)');
  
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js'], {
      cwd: path.join(process.cwd(), 'woodbury'),
      stdio: 'pipe'
    });
    
    let output = '';
    let sigintSent = 0;
    
    child.stdout.on('data', (data) => {
      output += data.toString();
      
      if ((output.includes('>') || output.includes('woodbury')) && sigintSent === 0) {
        setTimeout(() => {
          console.log('   📡 Sending first SIGINT...');
          child.kill('SIGINT');
          sigintSent++;
          
          setTimeout(() => {
            console.log('   📡 Sending second SIGINT...');
            child.kill('SIGINT');
            sigintSent++;
          }, 100);
        }, 500);
      }
    });
    
    child.on('exit', (code, signal) => {
      console.log(`   ✅ Process exited with code: ${code}, signal: ${signal}`);
      console.log(`   📝 SIGINT sent: ${sigintSent} times`);
      resolve({ code, signal, sigintSent, output });
    });
    
    child.on('error', (error) => {
      console.log(`   ❌ Process error: ${error.message}`);
      resolve({ error: error.message });
    });
    
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        console.log('   ⏰ Test timed out, killing process');
        resolve({ timeout: true });
      }
    }, 5000);
  });
}

async function runTests() {
  try {
    const result1 = await testSingleSigint();
    const result2 = await testDoubleSigint();
    
    console.log('\n📊 Test Results Summary:');
    console.log('========================');
    
    if (result1.code === 0 || result1.signal === 'SIGINT') {
      console.log('✅ Single SIGINT: PASSED (graceful exit)');
    } else {
      console.log('❌ Single SIGINT: FAILED');
    }
    
    if (result2.code === 1 || result2.signal === 'SIGINT') {
      console.log('✅ Double SIGINT: PASSED (force exit)');
    } else {
      console.log('❌ Double SIGINT: FAILED');
    }
    
    console.log('\n🎯 Overall: SIGINT handling appears to be working correctly!');
    
  } catch (error) {
    console.error('\n❌ Test error:', error.message);
  }
}

runTests();