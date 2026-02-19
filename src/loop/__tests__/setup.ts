// Jest setup file
import 'jest';

// Global test configuration
jest.setTimeout(30000);

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  debug: jest.fn(),
  log: jest.fn()
};

// Setup global test utilities
global.testUtils = {
  createTempDir: () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tempDir = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }
};

// Declare global types
declare global {
  var testUtils: {
    createTempDir(): string;
  };
}
